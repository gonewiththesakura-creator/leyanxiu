import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { miniIdentitySchema } from '../payments/virtual/mini-identity.js';
import { createVirtualWechat, createMessageCodec } from '../payments/virtual/wechat.js';
import { createMiniProductionService, miniProductionConfig } from '../payments/virtual/mini-production-service.js';
import { draftProducts, purchaseRulesVersion } from '../payments/virtual/products.js';

const appId = 'wx1234567890abcdef';
const sessionKey = Buffer.alloc(16, 11).toString('base64');
const ownerId = 'usr_00000000-0000-4000-8000-000000000001';
const otherId = 'usr_00000000-0000-4000-8000-000000000002';
const auth = session => ({ Authorization: `Bearer ${session.token}` });
const buy = (session, id) => ({ method: 'POST', headers: { ...auth(session), 'Idempotency-Key': id },
  body: JSON.stringify({ productId: 'photo10', amountFen: 1, env: 1, userId: otherId,
    platform: 'android', agreed: true, rulesVersion: purchaseRulesVersion }) });

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-mini-production-local-'));
  const source = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'ledger.sqlite'), migrate: true });
  t.after(async () => { await source.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await source.transaction(async q => {
    for (const sql of miniIdentitySchema('sqlite')) await q(sql);
    for (const [userId, openid] of [[ownerId, 'fixture-owner'], [otherId, 'fixture-other']]) {
      await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [userId, appId, openid]);
    }
  });
  // Explicit MySQL-shaped test port over real isolated SQLite transactions.
  // This validates HTTP/identity/ledger integration, NOT MySQL row locks or a
  // production database. Real MySQL acceptance remains a separate step.
  const database = { backend: 'mysql', transaction: callback => source.transaction(q =>
    callback((sql, args) => q(sql.replace(/ FOR UPDATE/g, ''), args))) };
  const ledger = createVirtualLedger({ database, encryptionKey: 'b'.repeat(64) });
  await ledger.bindEnvironment(appId, 0);
  const calls = [], alerts = [], adminChecks = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(url); calls.push(target.pathname);
    assert.equal(target.hostname, 'api.weixin.qq.com'); assert.equal(init.redirect, 'error');
    if (target.pathname === '/sns/jscode2session') {
      assert.equal(target.searchParams.get('appid'), appId);
      return Response.json({ openid: target.searchParams.get('js_code') === 'other' ? 'fixture-other' : 'fixture-owner', session_key: sessionKey });
    }
    if (target.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'fixture-token', expires_in: 7200 });
    if (target.pathname === '/xpay/query_order') {
      const request = JSON.parse(init.body); assert.equal(request.env, 0);
      const order = await ledger.order(request.order_id);
      return Response.json({ errcode: 0, order: paidRemote(order) });
    }
    throw new Error('NO_REAL_PROVIDER_OR_CHANNEL_WRITE_ALLOWED');
  };
  const adapter = createVirtualWechat({ appId, env: 0, appSecret: 'fixture-secret', appKey: 'fixture-production-key', offerId: 'fixture-offer', fetchImpl });
  const codec = createMessageCodec({ appId, token: 'fixture-callback-token', aesKey: Buffer.alloc(32, 4).toString('base64').slice(0, -1) });
  const requireAdmin = (c, policy) => {
    adminChecks.push(policy);
    if (c.req.header('x-fixture-owner') !== 'verified' || (policy.csrf && c.req.header('x-fixture-csrf') !== 'verified')) {
      return { response: c.json({ code: 'FIXTURE_ADMIN_DENIED' }, 403) };
    }
    return { session: { username: 'fixture-owner-reviewer' } };
  };
  const serviceOptions = { ledger, adapter, codec, appSecret: 'fixture-secret', products: [draftProducts[0]],
    testUserIds: [ownerId], fetchImpl, alert: (event, value) => alerts.push({ event, ...value }), ...options };
  const service = createMiniProductionService(serviceOptions);
  const login = async (code = 'owner', app = service.app) => {
    const response = await app.request('/api/auth/wechat', { method: 'POST', body: JSON.stringify({ code, appId: 'forged-app', userId: otherId, openid: 'forged-openid' }) });
    assert.equal(response.status, 200); return (await response.json()).data;
  };
  const seedPaid = async session => {
    const order = await ledger.createOrder({ userId: session.user.id, appId, env: 0, product: draftProducts[0],
      idempotencyKey: 'fixture-prior-paid', platform: 'android', rulesVersion: purchaseRulesVersion });
    await ledger.settle(order.id, paidRemote(order)); return ledger.order(order.id);
  };
  return { ...service, database, source, ledger, adapter, calls, alerts, adminChecks, requireAdmin, serviceOptions, login, seedPaid };
}
function paidRemote(order) {
  return { order_id: order.id, env_type: 1, order_fee: 990, paid_fee: 990, left_fee: 990,
    status: 2, order_type: 0, wx_order_id: 'fixture-wx-' + order.id, paid_time: Math.floor(Date.now() / 1000) };
}

test('env0 configuration defaults closed; live needs explicit configuration and never accepts a sandbox or App channel', () => {
  const env = { RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENV: '0', XPAY_ENABLED: 'true', XPAY_DB_BACKEND: 'mysql' };
  assert.deepEqual(miniProductionConfig(env), { mode: 'closed', testUserIds: [], purchaseProfile: 'android-only-v1' });
  assert.equal(miniProductionConfig({ ...env, XPAY_MODE: 'live', XPAY_RECONCILE_ENABLED: 'true' }).mode, 'live');
  for (const bad of [{ XPAY_ENV: '1' }, { XPAY_MODE: 'sandbox' }, { XPAY_MODE: 'typo' }, { AUTH_MODE: 'app' },
    { RELEASE_CHANNEL: 'android-app' }, { XPAY_ENABLED: 'false' }, { XPAY_DB_BACKEND: 'sqlite' },
    { XPAY_MODE: 'live' }, { XPAY_TEST_USER_IDS: '*' }, { XPAY_MODE: 'merchant_test', XPAY_RECONCILE_ENABLED: 'true' }]) {
    assert.throws(() => miniProductionConfig({ ...env, ...bad }), /XPAY_PRODUCTION_/);
  }
  const configured = miniProductionConfig({ ...env, XPAY_MODE: 'merchant_test', XPAY_RECONCILE_ENABLED: 'true', XPAY_TEST_USER_IDS: ownerId });
  assert.deepEqual(configured.testUserIds, [ownerId]); assert.ok(Object.isFrozen(configured.testUserIds));
});

test('closed env0 retains stable identity, paid rights and cross-instance logout without creating an order', async t => {
  const f = await fixture(t); const first = await f.login(); const paid = await f.seedPaid(first);
  assert.equal(first.user.id, ownerId); assert.equal(JSON.stringify(first).includes('openid'), false);
  const secondService = createMiniProductionService(f.serviceOptions); const second = await f.login('again', secondService.app);
  assert.equal(second.user.id, first.user.id);
  const recovery = await secondService.app.request('/api/account/restore-purchases', { method: 'POST', headers: auth(second) });
  assert.equal((await recovery.json()).data.entitlements.available.photo, 10);
  assert.equal((await f.app.request('/api/mini/payments/orders/' + paid.id, { headers: auth(first) })).status, 200);
  assert.equal((await f.app.request('/api/mini/payments/orders', buy(first, 'must-stay-closed'))).status, 503);
  assert.equal((await f.ledger.orders()).length, 1);
  assert.equal((await (await f.app.request('/health')).json()).salesEnabled, false);
  const other = await f.login('other');
  assert.equal((await f.app.request('/api/mini/payments/orders/' + paid.id, { headers: auth(other) })).status, 404);
  assert.equal((await secondService.app.request('/api/auth/logout', { method: 'POST', headers: auth(first) })).status, 200);
  assert.equal(await f.identity.authenticateBearer(auth(first).Authorization), null);
  assert.equal((await f.app.request('/api/account/entitlements', { headers: auth(first) })).status, 401);
  assert.ok(f.calls.every(value => value === '/sns/jscode2session'));
});

test('env1, another AppID and missing binding are refused before login, SQL identity writes or channel work', async t => {
  const f = await fixture(t);
  assert.throws(() => createMiniProductionService({ ...f.serviceOptions, adapter: { ...f.adapter, env: 1 } }), /SCOPE_REQUIRED/);
  assert.throws(() => createMiniProductionService({ ...f.serviceOptions, ledger: { ...f.ledger, database: f.source } }), /SCOPE_REQUIRED/);
  for (const change of [{ env: 1, appId }, { env: 0, appId: 'wx0000000000000000' }, null]) {
    await f.database.transaction(async q => { await q('DELETE FROM vp_environment');
      if (change) await q('INSERT INTO vp_environment(id,app_id,env) VALUES (1,?,?)', [change.appId, change.env]); });
    const response = await f.app.request('/api/auth/wechat', { method: 'POST', body: '{"code":"owner"}' });
    assert.equal(response.status, 503); assert.equal((await response.json()).code, 'XPAY_PRODUCTION_LEDGER_MISMATCH');
    assert.equal((await f.readiness()).operationsReady, false);
    assert.deepEqual(await f.payments.reconcile(), { skipped: true });
    assert.deepEqual(f.calls, []);
  }
  assert.deepEqual(await f.database.transaction(q => q('SELECT id FROM vp_auth_sessions')), []);
  await f.ledger.bindEnvironment(appId, 0); f.adapter.env = 1;
  assert.equal((await f.app.request('/health')).status, 503);
  assert.equal((await f.readiness()).ready, false);
});

test('missing, failed, false or incomplete readiness never opens sales; current readiness is checked for each purchase', async t => {
  const f = await fixture(t); const owner = await f.login(); let state;
  const service = createMiniProductionService({ ...f.serviceOptions, mode: 'live', requireAdmin: f.requireAdmin,
    readiness: async () => { if (state instanceof Error) throw state; return state; } });
  for (const value of [undefined, null, {}, { ready: true }, { ready: 1, operationsReady: true },
    { ready: false, operationsReady: true }, { ready: true, operationsReady: true },
    { ready: true, operationsReady: true, purchaseProfile: 'all-platforms' }, new Error('private-readiness-material')]) {
    state = value;
    assert.equal((await service.app.request('/api/mini/payments/orders', buy(owner, 'readiness-refuse'))).status, 503);
    assert.equal((await (await service.app.request('/api/mini/payments/products')).json()).data.available, false);
  }
  assert.deepEqual(await f.ledger.orders(), []);
  state = { ready: true, operationsReady: true, purchaseProfile: 'android-only-v1', mode: 'sandbox', testUserIds: [] };
  const created = await service.app.request('/api/mini/payments/orders', buy(owner, 'ready-create-once'));
  assert.equal(created.status, 200); const data = (await created.json()).data;
  assert.equal(data.order.amountFen, 990); assert.equal(JSON.parse(data.payment.signData).env, 0);
  const stored = await f.ledger.order(data.order.id); assert.equal(stored.env, 0); assert.equal(stored.userId, ownerId);
  state = { ready: false, operationsReady: true };
  assert.equal((await service.app.request('/api/mini/payments/orders', buy(owner, 'closed-again-new-key'))).status, 503);
  assert.equal((await f.ledger.orders()).length, 1);
  const existing = await service.app.request('/api/mini/payments/orders/' + data.order.id, { headers: auth(owner) });
  assert.equal((await existing.json()).data.status, 'paid');
  assert.equal((await f.ledger.entitlements(ownerId)).available.photo, 10);
  assert.equal(JSON.stringify(f.alerts).includes('private-readiness-material'), false);
});

test('merchant test only admits configured stable users; live does not accidentally inherit the test allowlist', async t => {
  const f = await fixture(t); const owner = await f.login(); const other = await f.login('other');
  const options = { ...f.serviceOptions, requireAdmin: f.requireAdmin,
    readiness: async () => ({ ready: true, operationsReady: true, purchaseProfile: 'android-only-v1' }) };
  const service = createMiniProductionService({ ...options, mode: 'merchant_test' });
  for (const headers of [{}, auth(other)]) {
    const catalog = (await (await service.app.request('/api/mini/payments/products', { headers })).json()).data;
    assert.equal(catalog.available, false); assert.deepEqual(catalog.products, []);
  }
  assert.equal((await service.app.request('/api/mini/payments/orders', buy(other, 'other-not-allowlisted'))).status, 403);
  assert.equal((await service.app.request('/api/mini/payments/orders', buy(owner, 'allowlisted-owner'))).status, 200);
  const live = createMiniProductionService({ ...options, mode: 'live' });
  assert.equal((await live.app.request('/api/mini/payments/orders', buy(other, 'live-other-user'))).status, 200);
  const missingAdmin = createMiniProductionService({ ...options, mode: 'live', requireAdmin: undefined });
  assert.equal((await missingAdmin.readiness()).ready, false);
  const forcedClosed = createMiniProductionService({ ...options, mode: 'closed' });
  assert.equal((await forcedClosed.readiness()).ready, false);
});

test('formal refunds cannot use sandbox self-confirm or a customer token as administrator; approved work is only queued', async t => {
  const f = await fixture(t); const owner = await f.login(); const other = await f.login('other'); const paid = await f.seedPaid(owner);
  const request = await f.app.request(`/api/mini/payments/orders/${paid.id}/refund`, { method: 'POST', headers: auth(owner), body: '{}' });
  assert.equal(request.status, 200); const refund = (await request.json()).data;
  assert.equal(refund.status, 'requested');
  assert.equal((await f.app.request(`/api/mini/payments/sandbox/refunds/${refund.id}/confirm`, {
    method: 'POST', headers: auth(owner), body: '{"confirm":true}' })).status, 404);
  assert.equal((await f.app.request(`/api/mini/payments/orders/${paid.id}/refund`, {
    method: 'POST', headers: auth(other), body: '{}' })).status, 404);
  const review = `/api/admin/mini-payments/refunds/${refund.id}/review`;
  assert.equal((await f.app.request(review, { method: 'POST', headers: auth(owner), body: '{"approve":true}' })).status, 403);
  const service = createMiniProductionService({ ...f.serviceOptions, requireAdmin: f.requireAdmin });
  assert.equal((await service.app.request(review, { method: 'POST', headers: auth(owner), body: '{"approve":true}' })).status, 403);
  assert.equal((await service.app.request(review, { method: 'POST', headers: { 'x-fixture-owner': 'verified' }, body: '{"approve":true}' })).status, 403);
  assert.equal((await f.ledger.refund(refund.id)).status, 'requested');
  const approved = await service.app.request(review, { method: 'POST',
    headers: { 'x-fixture-owner': 'verified', 'x-fixture-csrf': 'verified' }, body: '{"approve":true}' });
  assert.equal(approved.status, 200); const current = await f.ledger.refund(refund.id);
  assert.equal(current.status, 'processing'); assert.equal(current.reviewer, 'fixture-owner-reviewer');
  assert.ok(f.adminChecks.every(value => value.csrf === true && value.roles.join() === 'owner'));
  assert.equal((await f.database.transaction(q => q("SELECT id FROM vp_outbox WHERE kind='refund'"))).length, 1);
  assert.equal((await f.ledger.entitlements(ownerId)).available.photo, 0);
  assert.ok(f.calls.every(value => value === '/sns/jscode2session')); // Approval is not an actual refund call.
});

test('shared env0 transport rejects oversized bodies and customer identity claims before channel work', async t => {
  const f = await fixture(t);
  for (const body of ['null', '{bad', '{"openid":"fixture-owner","userId":"forged"}']) {
    assert.equal((await f.app.request('/api/auth/wechat', { method: 'POST', body })).status, 400);
  }
  assert.equal((await f.app.request('/api/auth/wechat', { method: 'POST', headers: { 'Content-Length': '1' },
    body: JSON.stringify({ code: 'owner', padding: 'x'.repeat(128 * 1024) }) })).status, 413);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(await f.database.transaction(q => q('SELECT id FROM vp_auth_sessions')), []);
});

test('outer photo routes use the same durable identity without payment hydration or caller supplied identity', async t => {
  const f = await fixture(t); const owner = await f.login(); const other = await f.login('other');
  const outer = new Hono();
  outer.get('/api/photo-identity-fixture', async c => {
    const result = await f.authenticated(c); if (result.response) return result.response;
    return c.json({ userId: result.auth.userId, authMethod: result.auth.authMethod });
  });
  outer.route('/', f.app);
  assert.equal((await outer.request('/api/photo-identity-fixture', { headers: { 'x-user-id': ownerId, 'x-wx-openid': 'fixture-owner' } })).status, 401);
  const check = await outer.request('/api/photo-identity-fixture', { headers: { ...auth(other), 'x-user-id': ownerId } });
  assert.deepEqual(await check.json(), { userId: otherId, authMethod: 'wechat' });
  assert.equal((await outer.request('/api/auth/logout', { method: 'POST', headers: auth(owner) })).status, 200);
  assert.equal((await outer.request('/api/photo-identity-fixture', { headers: auth(owner) })).status, 401);
  assert.ok(f.calls.every(value => value === '/sns/jscode2session'));
});

test('fixed Android production scope refuses unsupported declarations before order/signature while keeping owned recovery and refunds', async t => {
  const f = await fixture(t); const owner = await f.login(); let signatures = 0;
  const sign = f.adapter.paymentArgs; f.adapter.paymentArgs = (...args) => { signatures++; return sign(...args); };
  const service = createMiniProductionService({ ...f.serviceOptions, mode: 'live', requireAdmin: f.requireAdmin,
    readiness: async () => ({ ready: true, operationsReady: true, purchaseProfile: 'android-only-v1' }) });
  for (const purchaseProfile of ['all-platforms', 'ios', '', null, ['android-only-v1']]) {
    assert.throws(() => createMiniProductionService({ ...f.serviceOptions, purchaseProfile }), /SCOPE_REQUIRED/);
  }
  const catalog = (await (await service.app.request('/api/mini/payments/products', { headers: auth(owner) })).json()).data;
  assert.equal(catalog.purchaseProfile, 'android-only-v1'); assert.deepEqual(catalog.supportedPlatforms, ['android']);
  assert.equal(catalog.appleIap, undefined); assert.equal(catalog.available, true);
  for (const platform of ['ios', 'windows', 'ohos', 'devtools', '', undefined, null, ['android'], { toString: 'android' }]) {
    const request = buy(owner, 'unsupported-must-not-exist');
    request.body = JSON.stringify({ ...JSON.parse(request.body), platform, purchaseProfile: 'all-platforms', supportedPlatforms: ['ios'] });
    const response = await service.app.request('/api/mini/payments/orders', request);
    assert.equal(response.status, 403); assert.equal((await response.json()).code, 'XPAY_PURCHASE_PLATFORM_UNSUPPORTED');
  }
  assert.equal(signatures, 0); assert.deepEqual(await f.ledger.orders(), []);
  const created = await service.app.request('/api/mini/payments/orders', buy(owner, 'android-only-once'));
  assert.equal(created.status, 200); const order = (await created.json()).data.order;
  assert.equal(signatures, 1);
  const recovered = await service.app.request('/api/mini/payments/orders/' + order.id,
    { headers: { ...auth(owner), 'x-platform': 'ios' } });
  assert.equal((await recovered.json()).data.status, 'paid');
  assert.equal((await (await service.app.request('/api/mini/payments/entitlements', { headers: auth(owner) })).json()).data.available.photo, 10);
  const refund = await service.app.request(`/api/mini/payments/orders/${order.id}/refund`, {
    method: 'POST', headers: auth(owner), body: JSON.stringify({ platform: 'ios', reason: 'test recovery' }) });
  assert.equal(refund.status, 200); assert.equal((await refund.json()).data.status, 'requested');
  assert.equal((await service.app.request('/api/mini/payments/refunds', { headers: auth(owner) })).status, 200);
  assert.equal(signatures, 1);
  // Existing authoritative Apple payments still settle/recover; disabling new
  // sales does not erase their rights or invent a merchant-initiated refund.
  const prior = await f.ledger.createOrder({ userId: ownerId, appId, env: 0, product: draftProducts[0],
    idempotencyKey: 'prior-apple-order', platform: 'ios', rulesVersion: purchaseRulesVersion });
  await f.ledger.settle(prior.id, { ...paidRemote(prior), order_type: 7 });
  const priorResponse = await service.app.request('/api/mini/payments/orders/' + prior.id, { headers: auth(owner) });
  assert.equal((await priorResponse.json()).data.platform, 'ios');
  const appleRefund = await service.app.request(`/api/mini/payments/orders/${prior.id}/refund`, { method: 'POST', headers: auth(owner), body: '{}' });
  assert.equal((await appleRefund.json()).code, 'XPAY_REFUND_VIA_APPLE');
  assert.equal((await f.ledger.entitlements(ownerId)).available.photo, 10);
});
