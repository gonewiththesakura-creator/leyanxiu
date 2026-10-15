import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { draftProducts, purchaseRulesVersion } from '../payments/virtual/products.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createMiniIdentity, miniIdentitySchema } from '../payments/virtual/mini-identity.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-mini-integration-'));
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: path.join(root, 'absent.env'), START_SERVER: 'false', NODE_ENV: 'test', DEPLOY_ENV: 'test',
  DATA_DIR: root, BILLING_BACKEND: 'legacy', COMPLIANCE_BACKEND: 'sqlite', COMPLIANCE_SQLITE_FILE: path.join(root, 'compliance.sqlite'),
  COMPLIANCE_STORE_FILE: path.join(root, 'compliance.json'), ADMIN_STORE_FILE: path.join(root, 'admin.json'),
  ADMIN_WORKFLOW_STORE_FILE: path.join(root, 'workflow.json'), TASKS_FILE: path.join(root, 'tasks.json'), TASKS_BACKEND: 'file',
  PRIVATE_OBJECT_DIR: path.join(root, 'objects'), OBJECT_INDEX_FILE: path.join(root, 'objects/index.json'),
  METRICS_FILE: path.join(root, 'metrics.json'), AUTH_MODE: 'wechat', RELEASE_CHANNEL: 'wechat-mini-program',
  AUTH_SESSION_SECRET: 'test-only-session-secret-32-characters', CLOSED_TEST_MODE: 'false', XPAY_ENABLED: 'true',
  XPAY_MODE: 'sandbox', XPAY_ENV: '1', XPAY_DB_BACKEND: 'sqlite', XPAY_SQLITE_FILE: path.join(root, 'virtual.sqlite'),
  XPAY_SESSION_ENCRYPTION_KEY: '9'.repeat(64), WECHAT_APP_ID: 'wx-sandbox-test', WECHAT_APP_SECRET: 'test-only-secret',
  XPAY_OFFER_ID: 'test-offer', XPAY_SANDBOX_APP_KEY: 'test-only-app-key', XPAY_MESSAGE_TOKEN: 'test-only-token',
  XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 9).toString('base64').slice(0, -1), XPAY_PRODUCTS_JSON: JSON.stringify(draftProducts),
  XPAY_PURPOSE_RULES_JSON: JSON.stringify({ 'photo-fusion': { kind: 'photo', reviewed: true }, 'video-fusion': { kind: 'video', reviewed: true, templateIds: ['test-short-video'] } }),
});
const migrated = await openVirtualDatabase({ backend: 'sqlite', filename: process.env.XPAY_SQLITE_FILE, migrate: true });
for (const sql of miniIdentitySchema('sqlite')) await migrated.transaction(q => q(sql));
const seededLedger = createVirtualLedger({ database: migrated, encryptionKey: process.env.XPAY_SESSION_ENCRYPTION_KEY });
await seededLedger.bindEnvironment(process.env.WECHAT_APP_ID, 1);
const sandboxIdentity = createMiniIdentity({ database: migrated, appId: process.env.WECHAT_APP_ID,
  bindSession: input => seededLedger.bindSession(input) });
const sandboxLogin = await sandboxIdentity.createLogin({ openid: 'same-wechat-user', sessionKey: Buffer.alloc(16, 8).toString('base64') });
process.env.XPAY_TEST_USER_IDS = sandboxLogin.user.id;
await migrated.close();
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  const target = new URL(url);
  if (target.pathname === '/sns/jscode2session') {
    const code = target.searchParams.get('js_code');
    const openid = ['other-user', 'deleted-user', 'conflict-user', 'legacy-user', 'registration-failure'].includes(code) ? code : 'same-wechat-user';
    return Response.json({ openid, session_key: Buffer.alloc(16, 8).toString('base64') });
  }
  if (target.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'test-access-token', expires_in: 7200 });
  if (target.pathname === '/xpay/query_order') {
    const body = JSON.parse(options.body);
    return Response.json({ errcode: 0, order: { order_id: body.order_id, env_type: 2, order_fee: 990, paid_fee: 990, left_fee: 990,
      status: 2, order_type: 0, wx_order_id: `wx-${body.order_id}`, paid_time: Math.floor(Date.now() / 1000) } });
  }
  throw new Error('NO_EXTERNAL_REQUEST_ALLOWED_IN_TEST');
};
const { app } = await import('../index.js');
const { virtualRuntime } = await import('../payments/virtual/runtime.js');
const { store } = await import('../compliance-store.js');
const { createSessionForUser } = await import('../auth.js');
test.after(async () => { globalThis.fetch = originalFetch; await (await virtualRuntime()).ledger.database.close(); });
let loginAddress = 0;
function loginRequest(code) {
  // Each fixture models a distinct socket peer; production proxy trust and
  // the actual per-peer login limiter remain unchanged.
  return app.request('/api/auth/wechat', { method: 'POST', body: JSON.stringify({ code }) },
    { incoming: { socket: { remoteAddress: `127.0.0.${++loginAddress}` } } });
}
async function login(code) {
  const response = await loginRequest(code);
  assert.equal(response.status, 200); const body = await response.json();
  assert.equal(body.data.session_key, undefined); return body.data;
}
test('mounted service login, purchase, authoritative grant and cross-device recovery share one identity', async () => {
  assert.equal((await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${sandboxLogin.token}` } })).status, 401);
  const phoneA = await login('phone-a');
  assert.equal(phoneA.user.id, sandboxLogin.user.id);
  assert.match(phoneA.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(store.snapshot().sessions.length, 0);
  assert.equal(store.entitlements(phoneA.user.id).trialRemaining, 0);
  assert.equal((await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${sandboxLogin.token}` } })).status, 200);
  const headerA = { Authorization: `Bearer ${phoneA.token}`, 'Idempotency-Key': 'integration-payment-key' };
  const purchase = await app.request('/api/mini/payments/orders', { method: 'POST', headers: headerA, body: JSON.stringify({ productId: 'photo10', platform: 'android', amountFen: 1, agreed: true, rulesVersion: purchaseRulesVersion }) });
  assert.equal(purchase.status, 200); const created = (await purchase.json()).data;
  const before = await (await app.request('/api/account/entitlements', { headers: headerA })).json();
  assert.equal(before.data.available.photo, 0);
  const confirmation = await app.request(`/api/mini/payments/orders/${created.order.id}`, { headers: headerA });
  assert.equal(confirmation.status, 200); assert.equal((await confirmation.json()).data.status, 'paid');
  const phoneB = await login('phone-b'); assert.equal(phoneB.user.id, phoneA.user.id);
  const headerB = { Authorization: `Bearer ${phoneB.token}` };
  const restored = await (await app.request('/api/account/entitlements', { headers: headerB })).json();
  assert.equal(restored.data.available.photo, 10); assert.equal(restored.data.source, 'wechat_virtual');
  const orders = await (await app.request('/api/mini/payments/orders', { headers: headerB })).json();
  assert.equal(orders.data[0].id, created.order.id); assert.equal(orders.data[0].openid, undefined);
  assert.equal((await app.request('/api/mini/payments/orders', { method: 'POST', headers: headerA, body: JSON.stringify({ productId: 'photo10', platform: 'android', agreed: true, rulesVersion: purchaseRulesVersion }) })).status, 401);
  const restoreRoute = await (await app.request('/api/account/restore-purchases', { method: 'POST', headers: headerB })).json();
  assert.equal(restoreRoute.data.entitlements.available.photo, 10);
  assert.equal((await app.request('/api/auth/session', { method: 'POST' })).status, 403);
});

test('one mini bearer owns consent, image uploads and works; another account and legacy tokens cannot cross', async () => {
  const owner = await login('owner-device');
  const other = await login('other-user');
  const ownerHeaders = { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' };
  const otherHeaders = { Authorization: `Bearer ${other.token}` };
  const me = await (await app.request('/api/auth/me', { headers: ownerHeaders })).json();
  assert.equal(me.data.user.id, owner.user.id);
  for (const consentType of ['basic', 'face_processing']) {
    const response = await app.request('/api/consents', { method: 'POST', headers: ownerHeaders,
      body: JSON.stringify({ consentType, action: 'granted', subjectAuthorization: 'self' }) });
    assert.equal(response.status, 200);
  }
  assert.equal((await (await app.request('/api/consents', { headers: ownerHeaders })).json()).data.entries.length, 2);
  assert.equal((await (await app.request('/api/consents', { headers: otherHeaders })).json()).data.entries.length, 0);
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jK1QAAAAASUVORK5CYII=';
  const upload = await app.request('/api/upload', { method: 'POST', headers: ownerHeaders,
    body: JSON.stringify({ image: `data:image/png;base64,${image}` }) });
  assert.equal(upload.status, 200);
  const uploaded = (await upload.json()).data;
  // A validated owned object exercises the existing media route without any
  // supplier request or paid generation. Fixtures remain in the isolated root.
  const { objectStore } = await import('../storage.js');
  assert.equal(objectStore.get(uploaded.assetId).ownerId, owner.user.id);
  assert.equal((await app.request(`/api/assets/${uploaded.assetId}/url`, { headers: otherHeaders })).status, 403);
  const object = await objectStore.putBuffer(Buffer.from(image, 'base64'), {
    ownerId: owner.user.id, contentType: 'image/png', ext: '.png', purpose: 'output/test', retainSeconds: 3600 });
  assert.equal((await app.request(`/api/assets/${object.id}/url`, { headers: ownerHeaders })).status, 200);
  assert.equal((await app.request(`/api/assets/${object.id}/url`, { headers: otherHeaders })).status, 403);
  const ownerWorks = await (await app.request('/api/works', { headers: ownerHeaders })).json();
  assert.equal(ownerWorks.data.some(work => work.assetId === object.id), true);
  assert.deepEqual((await (await app.request('/api/works', { headers: otherHeaders })).json()).data, []);
  const legacy = createSessionForUser(owner.user.id, { channel: 'wechat', authMethod: 'wechat' });
  assert.equal((await app.request('/api/auth/me', { headers: { Authorization: `Bearer ${legacy.token}` } })).status, 401);
  assert.equal((await app.request('/api/consents', { headers: { Authorization: `Bearer ${legacy.token}` } })).status, 401);
  assert.equal((await app.request('/api/auth/logout', { method: 'POST', headers: ownerHeaders })).status, 200);
  assert.equal((await app.request('/api/auth/me', { headers: ownerHeaders })).status, 401);
  assert.equal((await app.request('/api/auth/me', { headers: otherHeaders })).status, 200);
});

test('fixed mini user registration refuses conflicting, legacy and deleted identities without issuing tokens', async () => {
  const appId = process.env.WECHAT_APP_ID;
  const conflict = store.createOrGetUser({ subject: `wechat:${appId}:conflict-user`, channel: 'wechat', authMethod: 'wechat' });
  const legacy = store.createOrGetUser({ subject: 'wechat:legacy-user', channel: 'wechat', authMethod: 'wechat' });
  const runtime = await virtualRuntime();
  for (const [code, expected] of [['conflict-user', 'XPAY_IDENTITY_CONFLICT'], ['legacy-user', 'XPAY_LEGACY_IDENTITY_REVIEW_REQUIRED']]) {
    const response = await loginRequest(code);
    assert.equal(response.status, 409); assert.equal((await response.json()).code, expected);
    assert.equal((await runtime.ledger.database.transaction(q => q('SELECT s.id FROM vp_auth_sessions s JOIN vp_accounts a ON a.user_id=s.user_id WHERE a.openid=?', [code]))).length, 0);
  }
  assert.equal(store.findUserBySubject(`wechat:${appId}:conflict-user`).id, conflict.id);
  assert.equal(store.findUserBySubject('wechat:legacy-user').id, legacy.id);
  assert.throws(() => store.ensureMiniUser({ userId: conflict.id, appId, openid: 'wrong-openid' }), /XPAY_IDENTITY_CONFLICT/);
  const deleted = await login('deleted-user');
  const before = (await runtime.ledger.database.transaction(q => q('SELECT id FROM vp_auth_sessions WHERE user_id=?', [deleted.user.id]))).length;
  const authorization = { Authorization: `Bearer ${deleted.token}` };
  const erased = await app.request('/api/account', { method: 'DELETE', headers: authorization });
  assert.equal(erased.status, 200);
  assert.equal((await app.request('/api/auth/me', { headers: authorization })).status, 401);
  const relogin = await loginRequest('deleted-user');
  assert.equal(relogin.status, 409); assert.equal((await relogin.json()).code, 'XPAY_ACCOUNT_UNAVAILABLE');
  const rows = await runtime.ledger.database.transaction(q => q('SELECT revoked_at FROM vp_auth_sessions WHERE user_id=?', [deleted.user.id]));
  assert.equal(rows.length, before); assert.equal(rows.every(row => row.revoked_at !== null), true);
  assert.equal((await runtime.ledger.database.transaction(q => q('SELECT user_id FROM vp_accounts WHERE openid=?', ['deleted-user'])))[0].user_id, deleted.user.id);
});

test('full service user-registration failure returns no token, then safely reuses the mapped ID', async () => {
  const original = store.ensureMiniUser;
  store.ensureMiniUser = () => { throw new Error('COMPLIANCE_PERSISTENCE_UNAVAILABLE'); };
  try {
    const response = await loginRequest('registration-failure');
    assert.equal(response.status, 503); assert.equal((await response.json()).data, undefined);
  } finally { store.ensureMiniUser = original; }
  const runtime = await virtualRuntime();
  const mapped = (await runtime.ledger.database.transaction(q => q('SELECT user_id FROM vp_accounts WHERE openid=?', ['registration-failure'])))[0].user_id;
  assert.equal((await runtime.ledger.database.transaction(q => q('SELECT id FROM vp_auth_sessions WHERE user_id=?', [mapped]))).length, 0);
  assert.equal((await runtime.ledger.database.transaction(q => q('SELECT id FROM vp_sessions WHERE user_id=?', [mapped]))).length, 0);
  const recovered = await login('registration-failure');
  assert.equal(recovered.user.id, mapped);
  assert.equal(store.getUser(mapped).id, mapped);
  assert.equal(store.entitlements(mapped).trialRemaining, 0);
});
