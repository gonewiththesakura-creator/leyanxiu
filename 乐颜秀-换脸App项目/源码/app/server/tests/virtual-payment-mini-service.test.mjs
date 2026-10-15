import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createMiniIdentity, miniIdentitySchema } from '../payments/virtual/mini-identity.js';
import { createVirtualWechat, createMessageCodec } from '../payments/virtual/wechat.js';
import { createMiniSandboxService, miniSandboxConfig } from '../payments/virtual/mini-sandbox-service.js';
import { draftProducts, purchaseRulesVersion } from '../payments/virtual/products.js';

const appId = 'wx-mini-service-test';
const key = Buffer.alloc(16, 7).toString('base64');
async function fixture(t, { purchaseEnabled = true, now, loginResponse, testUserIds } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-mini-service-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'ledger.sqlite'), migrate: true });
  for (const sql of miniIdentitySchema('sqlite')) await database.transaction(q => q(sql));
  const ledger = createVirtualLedger({ database, encryptionKey: '7'.repeat(64) });
  await ledger.bindEnvironment(appId, 1);
  const identity = createMiniIdentity({ database, appId, bindSession: input => ledger.bindSession(input) });
  const ownerId = 'usr_00000000-0000-4000-8000-000000000001';
  const otherId = 'usr_00000000-0000-4000-8000-000000000002';
  if (!loginResponse) {
    await database.transaction(async q => {
      for (const [userId, openid] of [[ownerId, 'openid-owner'], [otherId, 'openid-other']]) {
        await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [userId, appId, openid]);
      }
    });
  }
  const calls = [];
  const alerts = [];
  const fetchImpl = async (url, options) => {
    const target = new URL(url); calls.push(target.pathname);
    assert.equal(options.redirect, 'error');
    if (target.pathname === '/sns/jscode2session') {
      assert.equal(target.hostname, 'api.weixin.qq.com');
      assert.equal(target.searchParams.get('appid'), appId);
      if (loginResponse) return loginResponse();
      if (target.searchParams.get('js_code') === 'rejected') return Response.json({ errcode: 40029, errmsg: 'private upstream detail' });
      return Response.json({ openid: target.searchParams.get('js_code') === 'other' ? 'openid-other' : 'openid-owner', session_key: key });
    }
    if (target.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'test-only-token', expires_in: 7200 });
    if (target.pathname === '/xpay/query_order') {
      const body = JSON.parse(options.body);
      const order = await ledger.order(body.order_id);
      return Response.json({ errcode: 0, order: { order_id: order.id, env_type: 2, order_fee: 990, paid_fee: 990, left_fee: 990,
        status: 2, order_type: 0, wx_order_id: 'wx-' + order.id, paid_time: Math.floor(Date.now() / 1000) } });
    }
    throw new Error('NO_EXTERNAL_REQUEST_ALLOWED');
  };
  const adapter = createVirtualWechat({ appId, appSecret: 'test-only-secret', offerId: 'test-offer', appKey: 'test-only-key', env: 1, fetchImpl });
  const codec = createMessageCodec({ appId, token: 'test-only-token', aesKey: Buffer.alloc(32, 8).toString('base64').slice(0, -1) });
  const serviceOptions = { ledger, identity, adapter, codec, appSecret: 'test-only-secret', fetchImpl,
    alert: (event, detail) => alerts.push({ event, ...detail }),
    purchaseEnabled, now, products: [draftProducts[0]], testUserIds: testUserIds ?? [ownerId] };
  const { app } = createMiniSandboxService(serviceOptions);
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const login = async code => {
    const response = await app.request('/api/auth/wechat', { method: 'POST', body: JSON.stringify({ code, openid: 'forged-owner', userId: 'forged-id' }) });
    assert.equal(response.status, 200); return (await response.json()).data;
  };
  return { app, ledger, identity, calls, login, codec, alerts, serviceOptions, ownerId, otherId };
}

test('independent service preserves purchase identity after another-device login and revokes across instances', async t => {
  const f = await fixture(t);
  const first = await f.login('first');
  assert.equal(first.session_key, undefined); assert.equal(JSON.stringify(first).includes('openid'), false);
  const headers = { Authorization: 'Bearer ' + first.token, 'Idempotency-Key': 'mini-service-purchase-1' };
  const response = await f.app.request('/api/mini/payments/orders', { method: 'POST', headers,
    body: JSON.stringify({ productId: 'photo10', amountFen: 1, platform: 'android', agreed: true, rulesVersion: purchaseRulesVersion }) });
  assert.equal(response.status, 200); const created = (await response.json()).data;
  assert.equal(created.order.amountFen, 990);
  const paid = await f.app.request('/api/mini/payments/orders/' + created.order.id, { headers });
  assert.equal((await paid.json()).data.status, 'paid');
  const second = await f.login('second'); assert.equal(second.user.id, first.user.id);
  const recovered = await f.app.request('/api/account/restore-purchases', { method: 'POST', headers: { Authorization: 'Bearer ' + second.token } });
  assert.equal((await recovered.json()).data.entitlements.available.photo, 10);
  const stranger = await f.login('other');
  assert.equal((await f.app.request('/api/mini/payments/orders/' + created.order.id, { headers: { Authorization: 'Bearer ' + stranger.token } })).status, 404);
  assert.equal((await f.app.request('/api/auth/logout', { method: 'POST', headers })).status, 200);
  assert.equal(await f.identity.authenticateBearer(headers.Authorization), null);
  assert.equal((await f.app.request('/api/mini/payments/orders', { headers })).status, 401);
});

test('closed purchases retain authenticated recovery but cannot create an order', async t => {
  const f = await fixture(t, { purchaseEnabled: false }); const login = await f.login('first');
  const headers = { Authorization: 'Bearer ' + login.token, 'Idempotency-Key': 'closed-order-key' };
  const catalog = await f.app.request('/api/mini/payments/products');
  assert.equal((await catalog.json()).data.available, false);
  assert.equal((await f.app.request('/api/mini/payments/orders', { method: 'POST', headers, body: '{}' })).status, 503);
  assert.equal((await f.app.request('/api/mini/payments/orders', { headers })).status, 200);
  assert.deepEqual(await f.ledger.orders(), []);
});

test('client identity fields cannot login without an official code exchange and upstream details remain private', async t => {
  const f = await fixture(t);
  for (const body of ['{bad', JSON.stringify({ openid: 'openid-owner', session_key: key }), 'null']) {
    const response = await f.app.request('/api/auth/wechat', { method: 'POST', body });
    assert.equal(response.status, 400);
  }
  assert.deepEqual(f.calls, []);
  const rejected = await f.app.request('/api/auth/wechat', { method: 'POST', body: JSON.stringify({ code: 'rejected' }) });
  assert.equal(rejected.status, 401); assert.equal((await rejected.text()).includes('private upstream detail'), false);
  const oversize = await f.app.request('/api/auth/wechat', { method: 'POST', body: JSON.stringify({ code: 'x', padding: 'x'.repeat(128 * 1024) }) });
  assert.equal(oversize.status, 413);
  assert.deepEqual(await f.ledger.database.transaction(q => q('SELECT id FROM vp_auth_sessions')), []);
});

test('upstream login failures distinguish known causes without exposing credentials or creating sessions', async t => {
  const secret = 'private-url-secret-login-code-session-key';
  const wrapped = code => new TypeError(`fetch failed https://api.weixin.qq.com/?secret=${secret}`, {
    cause: Object.assign(new Error(secret), { code, url: secret, session_key: secret }),
  });
  const cases = [
    { error: wrapped('DEPTH_ZERO_SELF_SIGNED_CERT'), detail: { reason: 'tls_certificate', transportCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' } },
    { error: wrapped('ERR_TLS_CERT_ALTNAME_INVALID'), detail: { reason: 'tls_certificate', transportCode: 'ERR_TLS_CERT_ALTNAME_INVALID' } },
    { error: wrapped('UND_ERR_CONNECT_TIMEOUT'), detail: { reason: 'timeout', transportCode: 'UND_ERR_CONNECT_TIMEOUT' } },
    { error: Object.assign(new Error(secret), { name: 'TimeoutError' }), detail: { reason: 'timeout' } },
    { error: wrapped('ENOTFOUND'), detail: { reason: 'dns', transportCode: 'ENOTFOUND' } },
    { error: wrapped('ECONNRESET'), detail: { reason: 'connection', transportCode: 'ECONNRESET' } },
    { error: wrapped(secret), detail: { reason: 'transport' } },
    { response: new Response(secret, { status: 502, statusText: secret, headers: { Location: secret } }), detail: { reason: 'http', status: 502 } },
  ];
  for (const example of cases) {
    const f = await fixture(t, { loginResponse: () => { if (example.error) throw example.error; return example.response; } });
    const response = await f.app.request('/api/auth/wechat', { method: 'POST', body: JSON.stringify({ code: secret }) });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.code, 'XPAY_LOGIN_UNCONFIRMED');
    assert.deepEqual(f.alerts, [
      { event: 'virtual_payment.login_upstream_unconfirmed', ...example.detail },
      { event: 'virtual_payment.sandbox_error', code: 'XPAY_LOGIN_UNCONFIRMED' },
    ]);
    assert.equal(JSON.stringify({ body, alerts: f.alerts }).includes(secret), false);
    assert.deepEqual(await f.ledger.database.transaction(q => q('SELECT id FROM vp_auth_sessions')), []);
    assert.deepEqual(await f.ledger.database.transaction(q => q('SELECT user_id FROM vp_accounts')), []);
    assert.equal(f.calls.length, 1); // Never retry a possibly consumed one-time login code.
  }
});

test('forged gateway headers cannot make the independent cloud path grant or refund rights', async t => {
  const f = await fixture(t);
  for (const Event of ['xpay_goods_deliver_notify', 'xpay_refund_notify', 'xpay_subscribe_ios_refund_query_notify']) {
    const response = await f.app.request('/api/mini/payments/notify/cloud', { method: 'POST',
      headers: { 'x-wx-source': 'forged-message', 'x-wx-appid': appId }, body: JSON.stringify({ Event, action: 'CheckContainerPath' }) });
    assert.equal(response.status, 503);
  }
  assert.deepEqual(await f.ledger.orders(), []); assert.equal(f.calls.length, 0);
  assert.equal((await f.app.request('/api/admin/mini-payments/reconcile', { method: 'POST' })).status, 403);
});

test('entry configuration refuses env0, legacy channel, disabled API and SQLite deployment', () => {
  const config = { RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENV: '1', XPAY_MODE: 'closed', XPAY_ENABLED: 'true', XPAY_DB_BACKEND: 'mysql' };
  assert.equal(miniSandboxConfig(config).purchaseEnabled, false);
  assert.throws(() => miniSandboxConfig({ ...config, XPAY_MODE: 'sandbox' }), /ALLOWLIST_REQUIRED/);
  const sandbox = { ...config, XPAY_MODE: 'sandbox', XPAY_TEST_USER_IDS: 'usr_00000000-0000-4000-8000-000000000001', XPAY_RECONCILE_ENABLED: 'true' };
  assert.equal(miniSandboxConfig(sandbox).purchaseEnabled, true);
  assert.throws(() => miniSandboxConfig({ ...sandbox, XPAY_RECONCILE_ENABLED: 'false' }), /RECONCILIATION_REQUIRED/);
  assert.throws(() => miniSandboxConfig({ ...sandbox, XPAY_TEST_USER_IDS: '*' }), /ALLOWLIST_INVALID/);
  for (const bad of [{ XPAY_ENV: '0' }, { XPAY_MODE: 'merchant_test' }, { XPAY_MODE: 'live' },
    { AUTH_MODE: 'anonymous' }, { RELEASE_CHANNEL: 'android-app' }, { XPAY_ENABLED: 'false' }, { XPAY_DB_BACKEND: 'sqlite' }]) {
    assert.throws(() => miniSandboxConfig({ ...config, ...bad }), /XPAY_SANDBOX_/);
  }
});

test('health reports env1 cash risk in both closed and enabled modes without claiming zero cash movement', async t => {
  for (const purchaseEnabled of [false, true]) {
    const f = await fixture(t, { purchaseEnabled });
    const response = await f.app.request('/health');
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.env, 1); assert.equal(health.productionPaymentsEnabled, false);
    assert.equal(health.sandboxMayCharge, true); assert.equal(health.realMoneyAllowed, undefined);
    assert.equal(health.mode, purchaseEnabled ? 'sandbox' : 'closed');
    assert.equal(health.generationAvailable, false); assert.equal(health.ledgerOnlySandbox, true);
    assert.deepEqual(f.calls, []);
    assert.throws(() => createMiniSandboxService({ ...f.serviceOptions,
      adapter: { env: 0, appId } }), /XPAY_SANDBOX_SCOPE_REQUIRED/);
  }
});

test('sandbox catalog and order creation require a server allowlist, not a forged client identity', async t => {
  const f = await fixture(t); const owner = await f.login('first'); const other = await f.login('other');
  for (const session of [null, other]) {
    const headers = session ? { Authorization: 'Bearer ' + session.token } : {};
    const catalog = (await (await f.app.request('/api/mini/payments/products', { headers })).json()).data;
    assert.equal(catalog.available, false); assert.deepEqual(catalog.products, []);
    assert.equal(catalog.ledgerOnlySandbox, true); assert.equal(JSON.stringify(catalog).includes(f.ownerId), false);
  }
  const allowed = (await (await f.app.request('/api/mini/payments/products', { headers: { Authorization: 'Bearer ' + owner.token } })).json()).data;
  assert.equal(allowed.available, true); assert.equal(allowed.products.length, 1);
  const denied = await f.app.request('/api/mini/payments/orders', { method: 'POST',
    headers: { Authorization: 'Bearer ' + other.token, 'Idempotency-Key': 'forged-allowlist-test' },
    body: JSON.stringify({ userId: f.ownerId, testUserIds: [f.otherId], productId: 'photo10', agreed: true, platform: 'android', rulesVersion: purchaseRulesVersion }) });
  assert.equal(denied.status, 403); assert.deepEqual(await f.ledger.orders(), []);
  const closed = createMiniSandboxService({ ...f.serviceOptions, testUserIds: [] });
  assert.equal((await closed.readiness()).ready, false);
});

test('sandbox self-refund confirms only owned env1 refunds once and continues after sales close', async t => {
  const f = await fixture(t, { testUserIds: ['usr_00000000-0000-4000-8000-000000000001', 'usr_00000000-0000-4000-8000-000000000002'] });
  const owner = await f.login('first'); const other = await f.login('other');
  const headers = { Authorization: 'Bearer ' + owner.token, 'Idempotency-Key': 'sandbox-refund-one' };
  const created = await f.app.request('/api/mini/payments/orders', { method: 'POST', headers,
    body: JSON.stringify({ productId: 'photo10', platform: 'android', agreed: true, rulesVersion: purchaseRulesVersion }) });
  const order = (await created.json()).data.order;
  await f.app.request('/api/mini/payments/orders/' + order.id, { headers });
  const requested = await f.app.request('/api/mini/payments/orders/' + order.id + '/refund', { method: 'POST', headers, body: '{}' });
  const refund = (await requested.json()).data;
  const url = '/api/mini/payments/sandbox/refunds/' + refund.id + '/confirm';
  const closed = createMiniSandboxService({ ...f.serviceOptions, purchaseEnabled: false }).app;
  assert.equal((await closed.request(url, { method: 'POST', body: '{"confirm":true}' })).status, 401);
  assert.equal((await closed.request(url, { method: 'POST', headers: { Authorization: 'Bearer ' + other.token }, body: '{"confirm":true}' })).status, 404);
  for (const body of ['{}', '{"confirm":true,"amountFen":1}', '{"confirm":true,"userId":"forged"}']) {
    assert.equal((await closed.request(url, { method: 'POST', headers, body })).status, 400);
  }
  const results = await Promise.all(Array.from({ length: 8 }, () => closed.request(url, { method: 'POST', headers, body: '{"confirm":true}' })));
  for (const result of results) { assert.equal(result.status, 200); assert.equal((await result.json()).data.status, 'processing'); }
  assert.equal((await f.ledger.refund(refund.id)).reviewer, 'sandbox-self:' + f.ownerId);
  const outbox = await f.ledger.database.transaction(q => q('SELECT id FROM vp_outbox WHERE kind = ?', ['refund']));
  assert.equal(outbox.length, 1);
  assert.equal(f.calls.some(path => path.includes('refund')), false);
  const removed = createMiniSandboxService({ ...f.serviceOptions, purchaseEnabled: false, testUserIds: [] }).app;
  assert.equal((await removed.request(url, { method: 'POST', headers, body: '{"confirm":true}' })).status, 403);
  assert.equal((await removed.request('/api/mini/payments/orders/' + order.id, { headers })).status, 200);
});

test('sequential login abuse cannot exhaust provider calls using forged source addresses', async t => {
  let at = Date.now();
  const f = await fixture(t, { now: () => at });
  for (let i = 0; i < 20; i++) {
    const response = await f.app.request('/api/auth/wechat', { method: 'POST',
      headers: { 'x-forwarded-for': 'forged-' + i }, body: JSON.stringify({ code: 'rejected' }) });
    assert.equal(response.status, 401);
  }
  const refused = await f.app.request('/api/auth/wechat', { method: 'POST', body: JSON.stringify({ code: 'rejected' }) });
  assert.equal(refused.status, 429); assert.equal(refused.headers.get('Retry-After'), '60');
  assert.equal(f.calls.length, 20);
  at += 60000;
  assert.equal((await f.app.request('/api/auth/wechat', { method: 'POST', body: JSON.stringify({ code: 'rejected' }) })).status, 401);
  assert.equal(f.calls.length, 21);
});

test('oversized authenticated order requests cannot reach the ledger even with a false length header', async t => {
  const f = await fixture(t); const login = await f.login('first');
  const response = await f.app.request('/api/mini/payments/orders', { method: 'POST',
    headers: { Authorization: 'Bearer ' + login.token, 'Content-Length': '1', 'Idempotency-Key': 'body-limit-order' },
    body: JSON.stringify({ productId: 'photo10', platform: 'android', agreed: true, rulesVersion: purchaseRulesVersion, padding: 'x'.repeat(128 * 1024) }) });
  assert.equal(response.status, 413); assert.deepEqual(await f.ledger.orders(), []);
  assert.deepEqual(f.calls, ['/sns/jscode2session']);
});
