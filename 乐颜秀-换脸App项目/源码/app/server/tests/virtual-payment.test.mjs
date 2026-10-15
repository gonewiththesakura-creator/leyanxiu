import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createMessageCodec, createVirtualWechat, paySignature, userSignature } from '../payments/virtual/wechat.js';
import { draftProducts, purchaseRulesVersion } from '../payments/virtual/products.js';
import { registerVirtualPaymentRoutes } from '../payments/virtual/routes.js';
import { withVirtualBilling, miniCreationCatalog, providerUsageCount } from '../payments/virtual/integration.js';
import { reconcileVirtualPage } from '../payments/virtual/reconciliation.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const appId = 'wx-test-virtual';
const sessionKey = Buffer.alloc(16, 7).toString('base64');
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-virtual-'));
  const filename = path.join(directory, 'billing.sqlite');
  const database = await openVirtualDatabase({ backend: 'sqlite', filename, migrate: true });
  let now = Date.now();
  const ledger = createVirtualLedger({ database, encryptionKey: '7'.repeat(64), now: () => now });
  await ledger.bindEnvironment(appId, 0);
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await ledger.bindSession({ userId: 'buyer', sessionId: 'session', appId, openid: 'openid-buyer', sessionKey });
  await ledger.bindSession({ userId: 'other', sessionId: 'other-session', appId, openid: 'openid-other', sessionKey });
  const order = async (product = draftProducts[0], idem = crypto.randomUUID(), platform = 'android') => ledger.createOrder({ userId: 'buyer', product, idempotencyKey: idem, appId, env: 0, platform });
  const remote = order => ({ order_id: order.id, env_type: 1, order_fee: order.amountFen, paid_fee: order.amountFen,
    status: 2, order_type: order.platform === 'ios' ? 7 : 0, wx_order_id: `wx-${order.id}`, paid_time: Math.floor(now / 1000), refund_fee: 0, left_fee: order.amountFen });
  const paid = async product => { const o = await order(product); return ledger.settle(o.id, remote(o)); };
  return { ledger, database, filename, order, remote, paid, now: () => now, advance: value => { now += value; } };
}
test('virtual signatures match official deterministic vectors exactly', () => {
  const body = '{"openid": "xxx", "user_ip": "127.0.0.1", "env": 0}';
  assert.equal(paySignature('12345', '/xpay/query_user_balance', body), 'c37809f27c6d7fd1837ad2500a04512b66b34fd793a39a385fade56dca89a4b5');
  assert.equal(userSignature('9hAb/NEYUlkaMBEsmFgzig==', body), '089d9e8dc5d308977360c4b79ec600a93d736802802a807d634192328032f6c7');
});
test('encrypted notifications authenticate ciphertext, app ID and timestamp', () => {
  const now = Date.now(); const codec = createMessageCodec({ appId, token: 'test-token', aesKey: Buffer.alloc(32, 2).toString('base64').slice(0, -1), now: () => now });
  const message = { Event: 'xpay_goods_deliver_notify', OpenId: 'test' }; const encoded = codec.encode(message);
  const query = { timestamp: String(encoded.TimeStamp), nonce: encoded.Nonce, msg_signature: encoded.MsgSignature, encrypt_type: 'aes' };
  assert.deepEqual(codec.decode(encoded, query), message);
  assert.throws(() => codec.decode({ ...encoded, Encrypt: encoded.Encrypt.slice(1) }, query), /SIGNATURE/);
  assert.throws(() => codec.decode(encoded, { ...query, timestamp: '1700000000' }), /EXPIRED/);
  assert.throws(() => codec.decode(encoded, { ...query, encrypt_type: 'raw' }), /SIGNATURE/);
  const other = createMessageCodec({ appId: 'wrong', token: 'test-token', aesKey: Buffer.alloc(32, 2).toString('base64').slice(0, -1), now: () => now });
  assert.throws(() => other.decode(encoded, query), /APPID/);
});
test('HTTP adapter signs the exact bytes sent and does not retry ambiguous mutations', async () => {
  const calls = [];
  const adapter = createVirtualWechat({ appId, appSecret: 'test-only', offerId: 'offer', appKey: 'key', env: 0, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('stable_token')) return Response.json({ access_token: 'test-token', expires_in: 7200 });
    throw new Error('network timeout');
  } });
  await assert.rejects(adapter.refund({ openid: 'buyer', id: 'order', amountFen: 990, refundedFen: 0 }, { id: 'refund', amountFen: 990 }), /UNCONFIRMED/);
  assert.equal(calls.length, 2);
  const request = calls[1]; const url = new URL(request.url);
  assert.equal(url.searchParams.get('pay_sig'), paySignature('key', url.pathname, request.options.body));
  assert.equal(request.options.redirect, 'error');
});

test('refund wire request uses official string enums and signs the complete sandbox payload', async () => {
  let refundCalls = 0;
  const adapter = createVirtualWechat({ appId, appSecret: 'test-only', offerId: 'offer', appKey: 'test-key', env: 1,
    fetchImpl: async (url, options) => {
      const target = new URL(url);
      if (target.pathname === '/cgi-bin/stable_token') return Response.json({ access_token: 'test-token', expires_in: 7200 });
      assert.equal(target.origin, 'https://api.weixin.qq.com');
      assert.equal(target.pathname, '/xpay/refund_order');
      assert.deepEqual(JSON.parse(options.body), { openid: 'test-buyer', order_id: 'test-order', refund_order_id: 'test-refund',
        left_fee: 990, refund_fee: 891, biz_meta: 'test-refund', refund_reason: '2', req_from: '2', env: 1 });
      assert.equal(target.searchParams.get('pay_sig'), paySignature('test-key', target.pathname, options.body));
      refundCalls++;
      return Response.json({ errcode: 0 });
    } });
  await adapter.refund({ id: 'test-order', openid: 'test-buyer', amountFen: 990, refundedFen: 0 }, { id: 'test-refund', amountFen: 891, requestSource: 'user' });
  assert.equal(refundCalls, 1);
});
test('idempotent order snapshot, cross-user ownership and key rotation', async t => {
  const f = await setup(t); const first = await f.order(draftProducts[0], 'same-key-123');
  assert.equal((await f.order(draftProducts[0], 'same-key-123')).id, first.id);
  await assert.rejects(f.order(draftProducts[1], 'same-key-123'), /CONFLICT/);
  assert.equal(await f.ledger.order(first.id, 'other'), null);
  assert.equal(await f.ledger.sessionKey('buyer', 'session'), sessionKey);
  await f.ledger.bindSession({ userId: 'buyer', sessionId: 'new-phone', appId, openid: 'openid-buyer', sessionKey });
  await assert.rejects(f.ledger.sessionKey('buyer', 'session'), /REFRESH/);
  assert.equal(await f.ledger.sessionKey('buyer', 'new-phone'), sessionKey);
  const raw = await f.database.transaction(q => q('SELECT sealed FROM vp_sessions'));
  assert.ok(raw.every(row => !row.sealed.includes(sessionKey)));
  await assert.rejects(f.ledger.bindSession({ userId: 'buyer', sessionId: 'bad', appId, openid: 'attacker', sessionKey }), /CONFLICT/);
});
test('payment mismatch rolls back; simultaneous duplicate settlements grant once', async t => {
  const f = await setup(t); const o = await f.order();
  await assert.rejects(f.ledger.settle(o.id, { ...f.remote(o), paid_fee: 1 }), /MISMATCH/);
  await assert.rejects(f.ledger.settle(o.id, { ...f.remote(o), env_type: 2 }), /MISMATCH/);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  await Promise.all(Array.from({ length: 12 }, () => f.ledger.settle(o.id, f.remote(o))));
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  const second = await f.order();
  await assert.rejects(f.ledger.settle(second.id, { ...f.remote(second), wx_order_id: f.remote(o).wx_order_id }));
  assert.equal((await f.ledger.order(second.id)).status, 'pending');
});
test('concurrent generation cannot overspend and video cannot spend photo rights', async t => {
  const f = await setup(t); await f.paid();
  assert.equal((await f.ledger.reserve('buyer', hash('video'), 'video-fusion', 'video')).ok, false);
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => f.ledger.reserve('buyer', hash(String(i)), 'photo-fusion', 'photo')));
  assert.equal(results.filter(r => r.ok).length, 10);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  assert.equal((await f.ledger.reserve('buyer', hash('0'), 'photo-fusion', 'photo')).duplicate, true);
  await f.ledger.finish('buyer', hash('0'), 'unknown');
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  await f.ledger.finish('buyer', hash('0'), 'failed');
  await f.ledger.finish('buyer', hash('0'), 'failed');
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 1);
});
test('membership renewal queues its period and reserves earliest-expiring bucket', async t => {
  const f = await setup(t); await f.paid(); const first = await f.paid(draftProducts[2]); const next = await f.paid(draftProducts[2]);
  assert.equal(next.startsAt, first.expiresAt);
  const initial = await f.ledger.entitlements('buyer');
  assert.deepEqual(initial.available, { photo: 50, video: 10 });
  await f.ledger.reserve('buyer', hash('early'), 'photo-fusion', 'photo');
  assert.equal((await f.ledger.entitlements('buyer')).buckets.find(b => b.order_id === first.id && b.kind === 'photo').remaining, 39);
  f.advance(30 * 86400000);
  assert.deepEqual((await f.ledger.entitlements('buyer')).available, { photo: 50, video: 10 });
  await f.ledger.finish('buyer', hash('early'), 'failed');
  const compensated = await f.ledger.entitlements('buyer');
  assert.equal(compensated.available.photo, 51);
  assert.equal(compensated.buckets.find(b => b.id.startsWith('comp:')).expires_at, f.now() + 7 * 86400000);
});
test('partial unused-value refund holds only its source and duplicate success is harmless', async t => {
  const f = await setup(t); const first = await f.paid(); f.advance(1000); await f.paid();
  await f.ledger.reserve('buyer', hash('use'), 'photo-fusion', 'photo');
  await assert.rejects(f.ledger.requestRefund(first.id, 'buyer'), /PENDING/);
  await f.ledger.finish('buyer', hash('use'), 'success');
  const refund = await f.ledger.requestRefund(first.id, 'buyer', 'unused');
  assert.equal((await f.ledger.refund(refund.id)).requestSource, 'user');
  assert.equal(refund.amountFen, 891); assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  await f.ledger.reviewRefund(refund.id, 'finance', true);
  const message = { MchOrderId: first.id, OpenId: first.openid, WxOrderId: first.providerId,
    WxRefundId: 'wx-refund', MchRefundId: refund.id, RefundFee: 891, RetCode: 0 };
  await assert.rejects(f.ledger.applyRefund({ ...message, RefundFee: 990 }), /MISMATCH/);
  await f.ledger.applyRefund(message); await f.ledger.applyRefund(message);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  assert.equal((await f.ledger.order(first.id)).refundedFen, 891);
});
test('rejected refund restores only held rights; Apple forced refund cannot regenerate credits', async t => {
  const f = await setup(t); const first = await f.paid();
  const refund = await f.ledger.requestRefund(first.id, 'buyer'); await f.ledger.reviewRefund(refund.id, 'finance', false);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  await f.ledger.reserve('buyer', hash('pending-work'), 'photo-fusion', 'photo');
  await f.ledger.applyRefund({ MchOrderId: first.id, OpenId: first.openid, WxOrderId: first.providerId, WxRefundId: 'forced', MchRefundId: 'channel-initiated', RefundFee: 990, RetCode: 0 });
  await f.ledger.finish('buyer', hash('pending-work'), 'failed');
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  const ios = await f.order(draftProducts[0], 'ios-order-key', 'ios'); await f.ledger.settle(ios.id, f.remote(ios));
  await assert.rejects(f.ledger.requestRefund(ios.id, 'buyer'), /APPLE/);
});

test('late merchant review cannot reopen a channel-refunded order or enqueue another refund', async t => {
  const f = await setup(t);
  for (const approve of [false, true]) {
    const order = await f.paid();
    const refund = await f.ledger.requestRefund(order.id, 'buyer');
    await f.ledger.applyRefund({ MchOrderId: order.id, OpenId: order.openid, WxOrderId: order.providerId,
      WxRefundId: `external-${order.id}`, MchRefundId: `channel-${order.id}`, RefundFee: order.amountFen, RetCode: 0 });
    await assert.rejects(f.ledger.reviewRefund(refund.id, 'finance', approve), /REFUND_TRANSITION/);
    const updated = await f.ledger.order(order.id);
    assert.equal(updated.status, 'refunded');
    assert.equal(updated.refundedFen, order.amountFen);
    assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
    assert.equal((await f.ledger.outbox()).some(job => job.id === `refund:${refund.id}`), false);
  }
});
test('committed grants survive a separate database connection; no secret in public order', async t => {
  const f = await setup(t); const o = await f.paid();
  const other = await openVirtualDatabase({ backend: 'sqlite', filename: f.filename });
  try {
    const restored = createVirtualLedger({ database: other, encryptionKey: '7'.repeat(64) });
    assert.equal((await restored.entitlements('buyer')).available.photo, 10);
    assert.equal((await restored.order(o.id)).status, 'paid');
  } finally { await other.close(); }
});
test('billing integration routes by durable identity; uncertain failures stay held', async t => {
  const f = await setup(t); await f.paid();
  const legacy = { reserveCreation: () => ({ ok: true, legacy: true }), countGenerationReservationsSince: () => 0 };
  const billing = withVirtualBilling(legacy, { enabled: () => true, runtime: async () => ({ ledger: f.ledger }), policy: () => ({ 'photo-fusion': { kind: 'photo', reviewed: true } }) });
  assert.equal((await billing.reserveCreation('unknown', hash('old'), 'photo-fusion')).legacy, true);
  assert.equal((await billing.reserveCreation('buyer', hash('unknown'), 'expensive-effect')).ok, false);
  await billing.reserveCreation('buyer', hash('known'), 'photo-fusion');
  await billing.refundCreation('buyer', hash('known'), 'generation_failed');
  assert.equal((await billing.entitlements('buyer')).available.photo, 9);
  await billing.refundCreation('buyer', hash('known'), 'provider_failed');
  assert.equal((await billing.entitlements('buyer')).available.photo, 10);
  await billing.reserveCreation('buyer', hash('consent-flush-failed'), 'photo-fusion');
  await billing.refundCreation('buyer', hash('consent-flush-failed'), 'consent_persistence_failed');
  await billing.refundCreation('buyer', hash('consent-flush-failed'), 'consent_persistence_failed');
  assert.equal((await billing.entitlements('buyer')).available.photo, 10);
});

test('provider budget counts virtual reservations and other calls without counting legacy generation twice', async t => {
  const f = await setup(t); await f.paid();
  await f.ledger.reserve('buyer', hash('budget-held'), 'photo-effect:reviewed', 'photo');
  const compliance = {
    countProviderUsageSince: (_since, userId) => userId === 'other' ? 0 : 5,
    countGenerationReservationsSince: (_since, userId) => userId === 'other' ? 0 : 3,
  };
  const billing = withVirtualBilling(compliance, { enabled: () => true, runtime: async () => ({ ledger: f.ledger }) });
  const since = new Date(f.now() - 1000).toISOString();
  assert.equal(await providerUsageCount({ compliance, billing, since }), 6);
  assert.equal(await providerUsageCount({ compliance, billing, since, userId: 'buyer' }), 6);
  assert.equal(await providerUsageCount({ compliance, billing, since, userId: 'other' }), 0);
  assert.equal(await providerUsageCount({ compliance, billing: compliance, since }), 5);
  await assert.rejects(providerUsageCount({ compliance, billing: { countGenerationReservationsSince: () => NaN }, since }), /UNCONFIRMED/);
  await assert.rejects(providerUsageCount({ compliance, billing: { countGenerationReservationsSince: () => { throw new Error('DB_UNAVAILABLE'); } }, since }), /DB_UNAVAILABLE/);
});

test('mini creation catalog exposes only published effects explicitly covered by reviewed photo rights', () => {
  const options = {
    catalog: { settings: { generationEnabled: true }, photoEffects: [
      { id: 'included', enabled: true }, { id: 'other', enabled: true }, { id: 'unreviewed', enabled: true },
      { id: 'wrong-kind', enabled: true }, { id: 'disabled', enabled: false }, { id: 123, enabled: true },
    ] }, enabled: true, capabilityReady: true, disclosureReady: true,
    purposeRules: { 'photo-effect:included': { kind: 'photo', reviewed: true },
      'photo-effect:wrong-kind': { kind: 'video', reviewed: true },
      'photo-effect:unreviewed': { kind: 'photo', reviewed: false },
      'photo-effect:disabled': { kind: 'photo', reviewed: true }, 'photo-effect:123': { kind: 'photo', reviewed: true },
      'photo-fusion': { kind: 'photo', reviewed: true } },
  };
  assert.deepEqual(miniCreationCatalog(options), { available: true, photoEffectIds: ['included'] });
  for (const gate of ['enabled', 'capabilityReady', 'disclosureReady']) {
    assert.equal(miniCreationCatalog({ ...options, [gate]: false }).available, false);
  }
  assert.equal(miniCreationCatalog({ ...options, catalog: { ...options.catalog, settings: { generationEnabled: false } } }).available, false);
  assert.deepEqual(miniCreationCatalog({ ...options, purposeRules: null }), { available: false, photoEffectIds: [] });
});
test('routes ignore client amounts, enforce owner access and fulfill through server query', async t => {
  const f = await setup(t); const app = new Hono(); let ready = false;
  const adapter = createVirtualWechat({ appId, appSecret: 'test', offerId: 'offer', appKey: 'key', env: 0 });
  const gateway = { ...adapter, query: async order => ({ order: f.remote(order) }), deliver: async () => ({}) };
  const codec = createMessageCodec({ appId, token: 'token', aesKey: Buffer.alloc(32, 3).toString('base64').slice(0, -1) });
  registerVirtualPaymentRoutes(app, { ledger: f.ledger, adapter: () => gateway, codec: () => codec, products: () => draftProducts,
    authenticated: c => c.req.header('x-user') ? { auth: { userId: c.req.header('x-user'), sessionId: 'session', authMethod: 'wechat' } } : { response: c.json({}, 401) },
    requireAdmin: c => ({ response: c.json({}, 403) }), readiness: async () => ({ ready, operationsReady: true, mode: 'merchant_test', testUserIds: ['buyer'] }) });
  const buy = () => app.request('/api/mini/payments/orders', { method: 'POST', headers: { 'x-user': 'buyer', 'idempotency-key': 'http-buy-key' }, body: JSON.stringify({ productId: 'photo10', amountFen: 1, platform: 'android', agreed: true, rulesVersion: purchaseRulesVersion }) });
  assert.equal((await buy()).status, 503); ready = true;
  const response = await buy(); assert.equal(response.status, 200); const data = (await response.json()).data;
  assert.equal(data.order.amountFen, 990); assert.equal(data.order.openid, undefined);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  assert.equal((await app.request(`/api/mini/payments/orders/${data.order.id}`, { headers: { 'x-user': 'other' } })).status, 404);
  assert.equal((await app.request(`/api/mini/payments/orders/${data.order.id}`, { headers: { 'x-user': 'buyer' } })).status, 200);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  const notification = codec.encode({ MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: 'openid-buyer', OutTradeNo: data.order.id, Env: 0,
    GoodsInfo: { ProductId: 'photo10', Quantity: 1, OrigPrice: 990, ActualPrice: 990, Attach: data.order.id } });
  const query = new URLSearchParams({ timestamp: String(notification.TimeStamp), nonce: notification.Nonce, msg_signature: notification.MsgSignature, encrypt_type: 'aes' });
  assert.equal((await app.request(`/api/mini/payments/notify?${query}`, { method: 'POST', body: JSON.stringify(notification) })).status, 200);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
});

test('sandbox and merchant-test catalogs and purchases are restricted to authenticated allowlisted users', async t => {
  const f = await setup(t); const app = new Hono();
  let mode = 'sandbox'; let allowlist = ['buyer'];
  let sessionReads = 0; let orderWrites = 0;
  const ledger = { ...f.ledger,
    sessionKey: async (...args) => { sessionReads++; return f.ledger.sessionKey(...args); },
    createOrder: async (...args) => { orderWrites++; return f.ledger.createOrder(...args); } };
  const adapter = createVirtualWechat({ appId, appSecret: 'test', offerId: 'offer', appKey: 'key', env: 0 });
  registerVirtualPaymentRoutes(app, { ledger, adapter: () => adapter, codec: () => null, products: () => draftProducts,
    authenticated: c => c.req.header('x-user') ? { auth: { userId: c.req.header('x-user'), sessionId: 'session', authMethod: c.req.header('x-method') || 'wechat' } } : { response: c.json({}, 401) },
    requireAdmin: c => ({ response: c.json({}, 403) }), readiness: async () => ({ ready: mode !== 'closed', operationsReady: true, mode, testUserIds: allowlist, ledgerOnlySandbox: mode === 'sandbox' }) });
  const catalog = async headers => (await (await app.request('/api/mini/payments/products', { headers })).json()).data;
  const buy = headers => app.request('/api/mini/payments/orders', { method: 'POST', headers: { ...headers, 'idempotency-key': 'allowlist-buy-key' },
    body: JSON.stringify({ productId: 'photo10', platform: 'android', agreed: true, rulesVersion: purchaseRulesVersion, userId: 'buyer', testUserIds: ['other'] }) });
  for (mode of ['sandbox', 'merchant_test']) {
    for (const headers of [undefined, { 'x-user': 'other' }, { 'x-user': 'buyer', 'x-method': 'anonymous' }]) {
      const hidden = await catalog(headers);
      assert.equal(hidden.available, false); assert.deepEqual(hidden.products, []);
    }
    assert.equal((await buy({ 'x-user': 'other' })).status, 403);
    assert.equal((await buy({ 'x-user': 'buyer', 'x-method': 'anonymous' })).status, 401);
    const visible = await catalog({ 'x-user': 'buyer' });
    assert.equal(visible.available, true); assert.equal(visible.products.length, draftProducts.length);
    assert.equal(visible.ledgerOnlySandbox, mode === 'sandbox'); assert.equal(visible.testUserIds, undefined);
    allowlist = undefined;
    assert.equal((await catalog({ 'x-user': 'buyer' })).available, false);
    assert.equal((await buy({ 'x-user': 'buyer' })).status, 403);
    allowlist = ['buyer'];
  }
  assert.equal(sessionReads, 0); assert.equal(orderWrites, 0);
  mode = 'merchant_test';
  assert.equal((await buy({ 'x-user': 'buyer' })).status, 200);
  assert.equal(sessionReads, 1); assert.equal(orderWrites, 1);
  mode = 'closed'; assert.equal((await catalog()).available, false);
  assert.equal((await catalog()).products.length, draftProducts.length);
  mode = 'live'; assert.equal((await catalog()).available, true);
  assert.equal((await catalog()).products.length, draftProducts.length);
});

test('database cannot mix sandbox and live rights or another app identity', async t => {
  const f = await setup(t);
  await assert.rejects(f.ledger.bindEnvironment(appId, 1), /ENV_MISMATCH/);
  await assert.rejects(f.ledger.bindEnvironment('another-app', 0), /ENV_MISMATCH/);
  await assert.rejects(f.ledger.createOrder({ userId: 'buyer', product: draftProducts[0], idempotencyKey: 'sandbox-order', appId, env: 1, platform: 'android' }), /ENV_MISMATCH/);
  assert.equal((await f.ledger.orders('buyer')).length, 0);
});
test('refund arriving before delivery records money returned without granting rights', async t => {
  const f = await setup(t); const order = await f.order();
  const message = { MchOrderId: order.id, OpenId: order.openid, WxOrderId: `wx-${order.id}`, WxRefundId: 'early-refund', MchRefundId: 'external-refund', RefundFee: 990, RetCode: 0 };
  await assert.rejects(f.ledger.applyRefund(message), /MISMATCH/);
  await f.ledger.applyRefund(message, { ...f.remote(order), status: 5, left_fee: 0 });
  await f.ledger.applyRefund(message);
  assert.equal((await f.ledger.order(order.id)).status, 'refunded');
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  await assert.rejects(f.ledger.settle(order.id, f.remote(order)), /TRANSITION/);
});
test('durable outbox leases prevent two workers from submitting the same refund concurrently', async t => {
  const f = await setup(t); const order = await f.paid();
  const refund = await f.ledger.requestRefund(order.id, 'buyer'); await f.ledger.reviewRefund(refund.id, 'finance', true);
  const claims = await Promise.all(Array.from({ length: 10 }, () => f.ledger.claimOutbox(`refund:${refund.id}`)));
  assert.equal(claims.filter(Boolean).length, 1); assert.equal(claims.find(Boolean).attempts, 0);
  f.advance(61000); assert.equal((await f.ledger.claimOutbox(`refund:${refund.id}`)).attempts, 1);
});
test('owner review requires CSRF and records the reviewer; reconciliation keeps ambiguous refunds frozen', async t => {
  const f = await setup(t); const order = await f.paid(); const refund = await f.ledger.requestRefund(order.id, 'buyer');
  const app = new Hono(); let refundCalls = 0;
  const service = registerVirtualPaymentRoutes(app, { ledger: f.ledger, adapter: () => ({ query: async o => ({ order: f.remote(o) }), deliver: async () => ({}),
    refund: async () => { refundCalls++; throw new Error('lost response'); }, queryRefund: async () => ({ order: { status: 1 } }) }),
    codec: () => null, authenticated: c => ({ response: c.json({}, 401) }), products: () => draftProducts,
    requireAdmin: (c, options) => c.req.header('x-admin') === 'owner' && (!options.csrf || c.req.header('x-csrf-token') === 'test-csrf') ? { session: { username: 'finance' } } : { response: c.json({}, 403) },
    readiness: async () => ({ ready: false, operationsReady: true, mode: 'closed' }) });
  const url = `/api/admin/mini-payments/refunds/${refund.id}/review`;
  assert.equal((await app.request(url, { method: 'POST', headers: { 'x-admin': 'owner' }, body: '{"approve":true}' })).status, 403);
  assert.equal((await app.request(url, { method: 'POST', headers: { 'x-admin': 'owner', 'x-csrf-token': 'test-csrf' }, body: '{"approve":true}' })).status, 200);
  await service.reconcile(); assert.equal(refundCalls, 1);
  f.advance(61000); await service.reconcile(); assert.equal(refundCalls, 1);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  assert.equal((await f.ledger.refund(refund.id)).reviewer, 'finance');
});
test('reconciliation records discrepancies and unknown fees without changing entitlements', async t => {
  const f = await setup(t); await f.paid();
  const before = await f.ledger.entitlements('buyer');
  const mismatch = await reconcileVirtualPage({ ledger: f.ledger, reviewer: 'finance', adapter: { query: async order => ({ order: { ...f.remote(order), left_fee: 800 } }) } });
  assert.equal(mismatch.differences, 1); assert.equal(mismatch.bankSettlementVerified, false);
  assert.equal(mismatch.rows[0].platformFeeFen, null);
  const matched = await reconcileVirtualPage({ ledger: f.ledger, reviewer: 'finance', adapter: { query: async order => ({ order: { ...f.remote(order), sett_state: 2, platform_fee_fen: 10, cps_fee_fen: 0 } }) } });
  assert.equal(matched.matched, 1); assert.equal(matched.rows[0].platformFeeFen, 10);
  assert.deepEqual(await f.ledger.entitlements('buyer'), before);
  assert.equal((await f.ledger.reconciliationReports()).length, 2);
});
test('reconciliation does not call merchant-debited refund status 5 a completed local refund', async t => {
  const f = await setup(t); const order = await f.paid();
  await f.ledger.applyRefund({ MchOrderId: order.id, OpenId: order.openid, WxOrderId: order.providerId,
    WxRefundId: 'refund-status-8', MchRefundId: 'external-refund', RefundFee: order.amountFen, RetCode: 0 },
  { ...f.remote(order), status: 8, left_fee: 0 });
  const status5 = await reconcileVirtualPage({ ledger: f.ledger, reviewer: 'finance',
    adapter: { query: async current => ({ order: { ...f.remote(current), status: 5, left_fee: 0 } }) } });
  assert.equal(status5.matched, 0); assert.equal(status5.differences, 1);
  const status8 = await reconcileVirtualPage({ ledger: f.ledger, reviewer: 'finance',
    adapter: { query: async current => ({ order: { ...f.remote(current), status: 8, left_fee: 0 } }) } });
  assert.equal(status8.matched, 1); assert.equal(status8.differences, 0);
  assert.equal((await f.ledger.order(order.id)).refundedFen, order.amountFen);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
});
test('partial refund reconciliation preserves paid-payment balances without accepting merchant-only debit', async t => {
  const f = await setup(t); const order = await f.paid(); const ref = hash('partially-used-before-refund');
  await f.ledger.reserve('buyer', ref, 'photo-fusion', 'photo'); await f.ledger.finish('buyer', ref, 'success');
  const refund = await f.ledger.requestRefund(order.id, 'buyer');
  await f.ledger.reviewRefund(refund.id, 'finance', true);
  await f.ledger.applyRefund({ MchOrderId: order.id, OpenId: order.openid, WxOrderId: order.providerId,
    WxRefundId: 'partial-refund-receipt', MchRefundId: refund.id, RefundFee: refund.amountFen, RetCode: 0 },
  undefined, { requireApproved: true });
  assert.equal(refund.amountFen, 891);
  const before = await f.ledger.entitlements('buyer');
  for (const [status, left, result] of [[5, 99, 'mismatch'], [8, 99, 'matched'], [2, 99, 'matched'],
    [3, 99, 'matched'], [4, 99, 'matched'], [4, 0, 'mismatch'], [8, 0, 'mismatch']]) {
    const report = await reconcileVirtualPage({ ledger: f.ledger, reviewer: 'finance',
      adapter: { query: async current => ({ order: { ...f.remote(current), status, left_fee: left } }) } });
    assert.equal(report.rows[0].result, result, `status=${status}, left=${left}`);
    assert.equal(report.bankSettlementVerified, false);
  }
  assert.equal((await f.ledger.refund(refund.id)).status, 'succeeded');
  assert.equal((await f.ledger.order(order.id)).refundedFen, 891);
  assert.deepEqual(await f.ledger.entitlements('buyer'), before);
});
test('manual resolution requires supplier evidence and audits reviewer with the credit return', async t => {
  const f = await setup(t); await f.paid(); const ref = hash('manual-task');
  await f.ledger.reserve('buyer', ref, 'photo-fusion', 'photo'); await f.ledger.finish('buyer', ref, 'unknown');
  assert.throws(() => f.ledger.finish('buyer', ref, 'failed', { reviewer: 'owner', evidence: '' }), /EVIDENCE/);
  await f.ledger.finish('buyer', ref, 'failed', { reviewer: 'owner', evidence: 'supplier-task-123: confirmed failed' });
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  const entry = (await f.ledger.auditLog()).find(x => x.action === 'creation.failed');
  assert.equal(JSON.parse(entry.detail).reviewer, 'owner');
});
