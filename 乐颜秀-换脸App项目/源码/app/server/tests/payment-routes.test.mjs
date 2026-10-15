import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { Hono } from 'hono';
import { registerPaymentRoutes } from '../payments/routes.js';
import { createWechatPay, toWechatOrderId, fromWechatOrderId } from '../payments/wechat.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-payment-routes-'));
process.env.COMPLIANCE_BACKEND = 'sqlite';
process.env.COMPLIANCE_SQLITE_FILE = path.join(dir, 'ledger.db');
process.env.DEPLOY_ENV = 'test';
const { store, resetStoreForTests, flushComplianceStore } = await import('../compliance-store.js');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifier = createWechatPay({ appId: 'wxapp', mchId: '1900000001', merchantSerial: 'ABC', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), apiV3Key: '12345678901234567890123456789012', platformKeys: { ABC: keys.publicKey.export({ type: 'spki', format: 'pem' }) }, notifyUrl: 'https://example.com/notify' });
const product = { id: 'pack', name: '制作套餐', amountFen: 990, credits: 5 };

function setup({ ready = true, operationsReady = true, gateway = {} } = {}) {
  resetStoreForTests();
  const user = store.createOrGetUser({ subject: 'buyer' });
  const stranger = store.createOrGetUser({ subject: 'stranger' });
  const adapter = { ...verifier, createAppOrder: async () => ({ prepayid: 'prepay' }), verifyNotification: text => JSON.parse(text), ...gateway };
  const app = new Hono();
  registerPaymentRoutes(app, {
    store, adapter: () => adapter, readiness: () => ({ ready }), operationsReadiness: () => ({ ready: operationsReady }), products: () => [product], flush: flushComplianceStore, orderIdFromTrade: fromWechatOrderId,
    authenticated: c => c.req.header('x-user') ? { auth: { userId: c.req.header('x-user') } } : { response: c.json({ code: 'UNAUTHORIZED' }, 401) },
    requireAdmin: c => c.req.header('x-admin') === 'owner' ? { session: { username: 'owner', role: 'owner' } } : { response: c.json({ code: 'FORBIDDEN' }, 403) },
  });
  const request = (route, { method = 'GET', body, userId = user.id, admin = false } = {}) => app.request(route, { method, headers: { 'content-type': 'application/json', ...(userId ? { 'x-user': userId } : {}), ...(admin ? { 'x-admin': 'owner' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const order = (owner = user.id, key = 'test-key-123') => store.createOrder({ userId: owner, productId: product.id, amountFen: product.amountFen, credits: product.credits, channel: 'android', idempotencyKey: key }).order;
  const transaction = order => ({ appid: 'wxapp', mchid: '1900000001', out_trade_no: toWechatOrderId(order.id), transaction_id: `trade-${order.id}`, trade_type: 'APP', trade_state: 'SUCCESS', amount: { total: order.amountFen, currency: 'CNY' } });
  return { app, user, stranger, request, order, transaction, adapter };
}

test('closed payment and unsupported client cannot create chargeable orders', async () => {
  const env = setup({ ready: false });
  assert.equal((await env.request('/api/products')).status, 200);
  assert.equal((await (await env.request('/api/products')).json()).data.available, false);
  assert.equal((await env.request('/api/orders', { method: 'POST', body: { channel: 'android', productId: 'pack', idempotencyKey: 'request-123' } })).status, 503);
  assert.equal(store.listOrders().length, 0);
  const open = setup();
  assert.equal((await open.request('/api/orders', { method: 'POST', body: { channel: 'ios', productId: 'pack', idempotencyKey: 'request-123' } })).status, 400);
  assert.equal(store.listOrders().length, 0);
});

test('order creation ignores client prices and retries do not create a second order', async () => {
  const env = setup();
  const body = { channel: 'android', productId: 'pack', idempotencyKey: 'request-123', amountFen: 1, credits: 9999 };
  const first = await (await env.request('/api/orders', { method: 'POST', body })).json();
  const retry = await (await env.request('/api/orders', { method: 'POST', body })).json();
  assert.equal(first.data.order.amountFen, 990);
  assert.equal(first.data.order.credits, 5);
  assert.equal(retry.data.order.id, first.data.order.id);
  assert.equal(store.listOrders().length, 1);
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
});

test('another user cannot query or refund an owned order', async () => {
  const env = setup(); const order = env.order();
  assert.equal((await env.request(`/api/orders/${order.id}`, { userId: env.stranger.id })).status, 404);
  assert.equal((await env.request(`/api/orders/${order.id}/refund`, { method: 'POST', userId: env.stranger.id, body: { reason: 'refund' } })).status, 409);
  assert.equal((await env.request('/api/orders', { userId: null })).status, 401);
  assert.equal(store.listRefunds().length, 0);
});

test('gateway amount mismatch cannot grant credits through query or notification', async () => {
  const env = setup(); const order = env.order();
  const bad = { ...env.transaction(order), amount: { total: 1, currency: 'CNY' } };
  env.adapter.queryOrder = async () => bad;
  assert.equal((await env.request(`/api/orders/${order.id}`)).status, 502);
  assert.equal((await env.request('/api/payments/wechat/notify', { method: 'POST', userId: null, body: { eventType: 'TRANSACTION.SUCCESS', resource: bad } })).status, 400);
  assert.equal(store.getOrder(order.id).status, 'pending');
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
});

test('query response must refer to the requested owned order rather than expose another order', async () => {
  const env = setup(); const owned = env.order(); const other = env.order(env.stranger.id, 'stranger-key');
  env.adapter.queryOrder = async () => env.transaction(other);
  const response = await env.request(`/api/orders/${owned.id}`);
  assert.equal(response.status, 502);
  assert.equal(store.getOrder(other.id).status, 'pending');
  assert.equal(store.entitlements(env.stranger.id).purchasedRemaining, 0);
});

test('query then repeated provider notifications grant the purchased quota exactly once', async () => {
  const env = setup(); const order = env.order(); const trade = env.transaction(order);
  env.adapter.queryOrder = async () => trade;
  assert.equal((await env.request(`/api/orders/${order.id}`)).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await env.request('/api/payments/wechat/notify', { method: 'POST', userId: null, body: { id: `evt-${i}`, eventType: 'TRANSACTION.SUCCESS', resource: trade } })).status, 204);
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 5);
  assert.equal(store.getOrder(order.id).providerTradeId, trade.transaction_id);
});

test('refund approval processing holds quota until authenticated success, duplicates do not revoke twice', async () => {
  const env = setup(); const order = env.order(); const trade = env.transaction(order);
  env.adapter.queryOrder = async () => trade;
  await env.request(`/api/orders/${order.id}`);
  const requested = await (await env.request(`/api/orders/${order.id}/refund`, { method: 'POST', body: { reason: '无需使用' } })).json();
  const refund = requested.data.refund;
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
  env.adapter.refund = async () => ({ out_trade_no: toWechatOrderId(order.id), out_refund_no: refund.id, refund_id: 'wx-refund-1', transaction_id: trade.transaction_id, status: 'PROCESSING', amount: { total: 990, refund: 990, currency: 'CNY' } });
  assert.equal((await env.request(`/api/admin/billing/refunds/${refund.id}/approve`, { method: 'POST' })).status, 403);
  assert.equal((await env.request(`/api/admin/billing/refunds/${refund.id}/approve`, { method: 'POST', admin: true })).status, 200);
  assert.equal(store.getOrder(order.id).status, 'paid');
  assert.equal(store.getRefund(refund.id).status, 'processing');
  const notification = { eventType: 'REFUND.SUCCESS', resource: { ...(await env.adapter.refund()), mchid: '1900000001', refund_status: 'SUCCESS' } };
  for (let i = 0; i < 2; i++) assert.equal((await env.request('/api/payments/wechat/refund-notify', { method: 'POST', userId: null, body: notification })).status, 204);
  assert.equal(store.getOrder(order.id).status, 'refunded');
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
});

test('refund timeout preserves held quota and does not report a successful refund', async () => {
  const env = setup(); const order = env.order(); env.adapter.queryOrder = async () => env.transaction(order);
  await env.request(`/api/orders/${order.id}`);
  const { data } = await (await env.request(`/api/orders/${order.id}/refund`, { method: 'POST', body: { reason: '退款' } })).json();
  env.adapter.refund = async () => { throw new Error('timeout'); };
  assert.equal((await env.request(`/api/admin/billing/refunds/${data.refund.id}/approve`, { method: 'POST', admin: true })).status, 502);
  assert.equal(store.getRefund(data.refund.id).status, 'processing');
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
  assert.equal(store.getOrder(order.id).status, 'paid');
});

test('operator reject returns held credits once and customer refund list is owner-scoped', async () => {
  const env = setup(); const order = env.order(); env.adapter.queryOrder = async () => env.transaction(order);
  await env.request(`/api/orders/${order.id}`);
  const { data } = await (await env.request(`/api/orders/${order.id}/refund`, { method: 'POST', body: { reason: '退款' } })).json();
  assert.equal((await (await env.request('/api/refunds', { userId: env.stranger.id })).json()).data.length, 0);
  for (let i = 0; i < 2; i++) assert.equal((await env.request(`/api/admin/billing/refunds/${data.refund.id}/reject`, { method: 'POST', admin: true, body: { reason: '与用户协商继续使用' } })).status, 200);
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 5);
});

test('refund status sync recovers missed callback and rejects mismatched original amount', async () => {
  const env = setup(); const order = env.order(); const trade = env.transaction(order); env.adapter.queryOrder = async () => trade;
  await env.request(`/api/orders/${order.id}`);
  const { data } = await (await env.request(`/api/orders/${order.id}/refund`, { method: 'POST', body: { reason: '退款' } })).json();
  env.adapter.refund = async () => { throw new Error('timeout'); };
  await env.request(`/api/admin/billing/refunds/${data.refund.id}/approve`, { method: 'POST', admin: true });
  const remote = { out_trade_no: toWechatOrderId(order.id), out_refund_no: data.refund.id, refund_id: 'wxrefund', transaction_id: trade.transaction_id, status: 'SUCCESS', amount: { total: 1, refund: 1, currency: 'CNY' } };
  env.adapter.queryRefund = async () => remote;
  assert.equal((await env.request(`/api/admin/billing/refunds/${data.refund.id}/sync`, { method: 'POST', admin: true })).status, 502);
  assert.equal(store.getOrder(order.id).status, 'paid');
  remote.amount = { total: 990, refund: 990, currency: 'CNY' };
  assert.equal((await env.request(`/api/admin/billing/refunds/${data.refund.id}/sync`, { method: 'POST', admin: true })).status, 200);
  assert.equal(store.getOrder(order.id).status, 'refunded');
});

test('long customer refund reason cannot strand refund through provider UTF8 byte limit', async () => {
  const env = setup(); const order = env.order(); const trade = env.transaction(order); env.adapter.queryOrder = async () => trade;
  await env.request(`/api/orders/${order.id}`);
  const response = await env.request(`/api/orders/${order.id}/refund`, { method: 'POST', body: { reason: '用户申请退款原因'.repeat(12) } });
  // Either reject overlength input before a hold, or retain full reason and send a bounded gateway summary.
  if (response.status === 400) { assert.equal(store.entitlements(env.user.id).purchasedRemaining, 5); return; }
  const { data } = await response.json();
  env.adapter.refund = async ({ reason }) => {
    assert.ok(Buffer.byteLength(reason) <= 80);
    return { out_trade_no: toWechatOrderId(order.id), out_refund_no: data.refund.id, refund_id: 'wxrefund', transaction_id: trade.transaction_id, status: 'PROCESSING', amount: { total: 990, refund: 990, currency: 'CNY' } };
  };
  assert.equal((await env.request(`/api/admin/billing/refunds/${data.refund.id}/approve`, { method: 'POST', admin: true })).status, 200);
});

test('closing order requires ownership and confirmed gateway close, timeout keeps pending', async () => {
  const env = setup(); const order = env.order();
  env.adapter.closeOrder = async () => { throw new Error('timeout'); };
  assert.equal((await env.request(`/api/orders/${order.id}/close`, { method: 'POST', userId: env.stranger.id })).status, 404);
  assert.equal((await env.request(`/api/orders/${order.id}/close`, { method: 'POST' })).status, 502);
  assert.equal(store.getOrder(order.id).status, 'pending');
  env.adapter.closeOrder = async () => ({});
  assert.equal((await env.request(`/api/orders/${order.id}/close`, { method: 'POST' })).status, 200);
  assert.equal(store.getOrder(order.id).status, 'closed');
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
});

test('product updates require owner and reject invalid monetary amounts without overwriting valid catalog', async () => {
  const env = setup();
  assert.equal((await env.request('/api/admin/billing/products', { method: 'PUT', body: { products: [product] } })).status, 403);
  assert.equal(store.paymentProducts(), null);
  assert.equal((await env.request('/api/admin/billing/products', { method: 'PUT', admin: true, body: { products: [product] } })).status, 200);
  assert.deepEqual(store.paymentProducts(), [product]);
  assert.equal((await env.request('/api/admin/billing/products', { method: 'PUT', admin: true, body: { products: [{ ...product, amountFen: 0.01 }] } })).status, 400);
  assert.deepEqual(store.paymentProducts(), [product]);
});

test('new sales closed still allows old paid notifications and owner reconciliation exactly once', async () => {
  const env = setup({ ready: false }); const queried = env.order(); const notified = env.order(env.user.id, 'other-old-order');
  env.adapter.queryOrder = async id => env.transaction(store.getOrder(id));
  assert.equal((await env.request('/api/payments/wechat/notify', { method: 'POST', userId: null, body: { eventType: 'TRANSACTION.SUCCESS', resource: env.transaction(notified) } })).status, 204);
  assert.equal((await env.request('/api/admin/billing/reconcile', { method: 'POST' })).status, 403);
  const summary = await (await env.request('/api/admin/billing/reconcile', { method: 'POST', admin: true })).json();
  assert.equal(summary.data.settled, 1);
  assert.equal(store.getOrder(queried.id).status, 'paid');
  await env.request('/api/admin/billing/reconcile', { method: 'POST', admin: true });
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 10);
});

test('merchant_test accepts only explicitly allowlisted account and denies an empty list', async () => {
  const oldMode = process.env.PAYMENT_MODE; const oldIds = process.env.PAYMENT_TEST_USER_IDS;
  try {
    const env = setup(); process.env.PAYMENT_MODE = 'merchant_test'; process.env.PAYMENT_TEST_USER_IDS = ` ${env.user.id} `;
    const body = { channel: 'android', productId: 'pack', idempotencyKey: 'merchant-test-order' };
    assert.equal((await env.request('/api/orders', { method: 'POST', userId: env.stranger.id, body })).status, 403);
    assert.equal((await env.request('/api/orders', { method: 'POST', body })).status, 200);
    process.env.PAYMENT_TEST_USER_IDS = '';
    assert.equal((await env.request('/api/orders', { method: 'POST', body })).status, 403);
    assert.equal(store.listOrders().length, 1);
  } finally {
    if (oldMode === undefined) delete process.env.PAYMENT_MODE; else process.env.PAYMENT_MODE = oldMode;
    if (oldIds === undefined) delete process.env.PAYMENT_TEST_USER_IDS; else process.env.PAYMENT_TEST_USER_IDS = oldIds;
  }
});

test('prepay timeout returns persisted order for recovery without fake payment parameters', async () => {
  const env = setup({ gateway: { createAppOrder: async () => { throw new Error('timeout'); } } });
  const response = await env.request('/api/orders', { method: 'POST', body: { channel: 'android', productId: 'pack', idempotencyKey: 'timeout-prepay-key' } });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.code, 0);
  assert.equal(payload.data.order.status, 'pending');
  assert.ok(!payload.data.payment);
  assert.equal(store.getOrder(payload.data.order.id, env.user.id).amountFen, 990);
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
});

test('disabling new sales does not prevent refund approval of previously paid order', async () => {
  const env = setup({ ready: false }); const order = env.order(); const trade = env.transaction(order);
  env.adapter.queryOrder = async () => trade;
  await env.request(`/api/orders/${order.id}`);
  const { data } = await (await env.request(`/api/orders/${order.id}/refund`, { method: 'POST', body: { reason: '退款' } })).json();
  env.adapter.refund = async () => ({ out_trade_no: toWechatOrderId(order.id), out_refund_no: data.refund.id, refund_id: 'wxrefund', transaction_id: trade.transaction_id, status: 'PROCESSING', amount: { total: 990, refund: 990, currency: 'CNY' } });
  assert.equal((await env.request(`/api/admin/billing/refunds/${data.refund.id}/approve`, { method: 'POST', admin: true })).status, 200);
  assert.equal(store.getRefund(data.refund.id).status, 'processing');
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
});

test('failed operational durability gate cannot be bypassed by order query or manual reconciliation', async () => {
  const env = setup({ ready: false, operationsReady: false }); const order = env.order();
  env.adapter.queryOrder = async () => env.transaction(order);
  assert.equal((await env.request('/api/payments/wechat/notify', { method: 'POST', userId: null, body: { eventType: 'TRANSACTION.SUCCESS', resource: env.transaction(order) } })).status, 503);
  await env.request(`/api/orders/${order.id}`);
  await env.request('/api/admin/billing/reconcile', { method: 'POST', admin: true });
  assert.equal(store.getOrder(order.id).status, 'pending');
  assert.equal(store.entitlements(env.user.id).purchasedRemaining, 0);
});
