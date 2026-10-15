import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { BILLING_SCHEMA } from '../payments/database.js';
import { createBillingLedger } from '../payments/ledger.js';
import { registerPaymentRoutes } from '../payments/routes.js';
import { createWechatPay, fromWechatOrderId, toWechatOrderId } from '../payments/wechat.js';

const DAY = 86400000;
const pg = new PGlite();
await pg.exec(BILLING_SCHEMA);
const db = { query: (sql, args) => pg.query(sql, args), transaction: (userId, operation) => pg.transaction(async q => {
  await q.query('INSERT INTO billing_accounts(id) VALUES($1) ON CONFLICT DO NOTHING', [userId]);
  await q.query('SELECT id FROM billing_accounts WHERE id=$1 FOR UPDATE', [userId]);
  return operation(q);
}) };
let currentTime = Date.parse('2026-10-09T00:00:00Z');
const ledger = createBillingLedger(db, { now: () => currentTime });
let sequence = 0;
const monthly = { id: 'monthly-30', name: '30 天套餐', type: 'monthly', durationDays: 30, credits: 10, amountFen: 3000 };
const credits = { id: 'credits-no-expiry', name: '不过期次数包', type: 'credits', credits: 10, amountFen: 990 };
const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = async () => { externalCalls++; throw new Error('NETWORK_FORBIDDEN_IN_BILLING_FIXTURE'); };
test.after(async () => {
  globalThis.fetch = originalFetch;
  await pg.close();
  assert.equal(externalCalls, 0);
});

async function paid(userId, productSnapshot = monthly) {
  const key = `plan-order-${sequence++}`;
  const { order } = await ledger.createOrder({ userId, channel: 'android', idempotencyKey: key, productSnapshot });
  const result = await ledger.applyPaymentEvent({ orderId: order.id, eventId: key, status: 'paid', providerTradeId: `trade-${key}` });
  assert.equal(result.error, undefined);
  return result.order;
}
async function refunded(order) {
  const quote = await ledger.quoteRefund(order.id, order.userId);
  assert.ok(quote.amountFen > 0);
  const result = await ledger.requestRefund(order.id, order.userId, 'isolated fixture', quote.amountFen);
  assert.equal(result.error, undefined);
  await ledger.approveRefund(result.refund.id, 'fixture-owner');
  const event = { refundId: result.refund.id, providerRefundId: `refund-${sequence++}`, providerTradeId: order.providerTradeId, status: 'SUCCESS' };
  assert.equal((await ledger.applyRefundResult(event)).error, undefined);
  assert.equal((await ledger.applyRefundResult(event)).duplicate, true);
  return result.refund;
}

test('a partially refunded consumed monthly plan no longer delays a new purchase or stays active', async () => {
  const user = 'monthly-used-refund';
  const original = await paid(user);
  assert.equal((await ledger.reserveCreation(user, 'consumed-monthly', 'photo')).ok, true);
  await ledger.confirmCreation(user, 'consumed-monthly');
  currentTime += DAY;
  await refunded(original);
  assert.equal((await ledger.getOrder(original.id)).status, 'partially_refunded');
  const renewed = await paid(user);
  assert.equal(renewed.startsAt, new Date(currentTime).toISOString(), 'terminated period must not postpone a new purchase');
  const entitlement = await ledger.entitlements(user);
  assert.equal(entitlement.grants.find(grant => grant.orderId === original.id).active, false);
  assert.equal(entitlement.totalRemaining, 10);
  assert.equal((await ledger.reconcileEntitlements()).ok, true);
});

test('time-prorated monthly refund deactivates the period and preserves an already purchased future period', async () => {
  const user = 'monthly-queued-refund';
  const original = await paid(user);
  const queued = await paid(user);
  currentTime += 15 * DAY;
  const refund = await refunded(original);
  assert.equal(refund.amountFen, 1500);
  const entitlement = await ledger.entitlements(user);
  assert.equal(entitlement.grants.find(grant => grant.orderId === original.id).active, false);
  assert.equal(entitlement.grants.find(grant => grant.orderId === queued.id).startsAt, queued.startsAt);
  const next = await paid(user);
  assert.equal(next.startsAt, queued.expiresAt, 'previously promised future periods must not move');
  assert.equal((await ledger.entitlements(user)).totalRemaining, 0);
  currentTime = Date.parse(queued.startsAt);
  assert.equal((await ledger.entitlements(user)).totalRemaining, 10);
});

test('uncertain or rejected refund retains the monthly schedule; exhausted quota still retains the paid period', async () => {
  const user = 'monthly-refund-uncertain';
  const original = await paid(user);
  const { refund } = await ledger.requestRefund(original.id, user, 'fixture');
  await ledger.approveRefund(refund.id, 'fixture-owner');
  await ledger.applyRefundResult({ refundId: refund.id, providerTradeId: original.providerTradeId, providerRefundId: 'uncertain-monthly', status: 'ABNORMAL' });
  const next = await paid(user);
  assert.equal(next.startsAt, original.expiresAt);
  assert.equal((await ledger.entitlements(user)).totalRemaining, 0);
  const exhaustedUser = 'monthly-exhausted';
  const exhausted = await paid(exhaustedUser, { ...monthly, credits: 1 });
  await ledger.reserveCreation(exhaustedUser, 'exhausted-task', 'photo');
  await ledger.confirmCreation(exhaustedUser, 'exhausted-task');
  assert.equal((await paid(exhaustedUser)).startsAt, exhausted.expiresAt);
  const rejectedUser = 'monthly-refund-rejected';
  const rejected = await paid(rejectedUser);
  const asked = await ledger.requestRefund(rejected.id, rejectedUser, 'fixture');
  await ledger.rejectRefund(asked.refund.id, 'fixture-owner', 'withdrawn');
  assert.equal((await paid(rejectedUser)).startsAt, rejected.expiresAt);
});

test('fixed credits have no expiry and remain independent of monthly refunds and account changes', async () => {
  const user = 'permanent-credits-owner';
  const noExpiry = await paid(user, credits);
  const month = await paid(user);
  await refunded(month);
  currentTime += 3650 * DAY;
  assert.equal(noExpiry.expiresAt, null);
  assert.equal((await ledger.entitlements(user)).totalRemaining, 10);
  assert.equal((await ledger.entitlements('another-account')).totalRemaining, 0);
  assert.equal(await ledger.getOrder(noExpiry.id, 'another-account'), null);
  assert.equal((await ledger.reserveCreation(user, 'permanent-consume', 'photo')).ok, true);
  await ledger.confirmCreation(user, 'permanent-consume');
  assert.equal((await ledger.quoteRefund(noExpiry.id, user)).amountFen, 891);
});

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const validator = createWechatPay({ appId: 'wxfixture', mchId: '1900000001', merchantSerial: 'FIXTURE',
  privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), apiV3Key: '12345678901234567890123456789012',
  platformKeys: { FIXTURE: keys.publicKey.export({ type: 'spki', format: 'pem' }) }, notifyUrl: 'https://example.invalid/notify' });
function routeFixture(userId, store = ledger) {
  const app = new Hono();
  const pendingQueries = [];
  const prepayments = [];
  let product = { ...credits };
  const remote = new Map();
  const gateway = { ...validator, verifyNotification: raw => JSON.parse(raw),
    createAppOrder: async input => { prepayments.push(input); return { prepayid: 'fixture-prepay' }; },
    closeOrder: async () => { throw new Error('fixture close response lost'); },
    queryRefund: async () => { throw new Error('fixture refund remains uncertain'); },
    queryOrder: async id => { pendingQueries.push(id); const value = remote.get(id); if (value instanceof Error) throw value; return value; } };
  const jobs = registerPaymentRoutes(app, { store, authenticated: c => ({ auth: { userId: c.req.header('x-fixture-user') || userId } }),
    requireAdmin: () => ({ session: { username: 'fixture-owner' } }), adapter: () => gateway,
    readiness: async () => ({ ready: true }), operationsReadiness: async () => ({ ready: true }),
    products: async () => [product], flush: async () => {}, accountReady: async () => true, orderIdFromTrade: fromWechatOrderId });
  const transaction = (order, state) => ({ appid: 'wxfixture', mchid: '1900000001', out_trade_no: toWechatOrderId(order.id),
    trade_type: 'APP', trade_state: state, amount: { total: order.amountFen, currency: 'CNY' }, ...(state === 'SUCCESS' ? { transaction_id: `remote-${order.id}` } : {}) });
  const request = (route, method = 'GET', body, user = userId) => app.request(route, { method, headers: { 'content-type': 'application/json', 'x-fixture-user': user }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { request, transaction, remote, jobs, pendingQueries, prepayments, setProduct(value) { product = value; } };
}

test('authoritative CLOSED query ends pending order; late confirmed success still grants exactly once', async () => {
  const user = 'closed-query-owner';
  const env = routeFixture(user);
  const { order } = await ledger.createOrder({ userId: user, channel: 'android', idempotencyKey: 'closed-query-order', productSnapshot: credits });
  env.remote.set(order.id, env.transaction(order, 'CLOSED'));
  const queried = await env.request(`/api/orders/${order.id}`);
  assert.equal(queried.status, 200);
  assert.equal((await queried.json()).data.status, 'closed');
  assert.equal((await ledger.entitlements(user)).totalRemaining, 0);
  await env.jobs.reconcilePending();
  assert.equal(env.pendingQueries.filter(id => id === order.id).length, 1, 'closed order must leave the pending sweep');
  const event = { eventType: 'TRANSACTION.SUCCESS', resource: env.transaction(order, 'SUCCESS') };
  for (let i = 0; i < 2; i++) assert.equal((await env.request('/api/payments/wechat/notify', 'POST', event)).status, 204);
  assert.equal((await ledger.entitlements(user)).totalRemaining, 10);
});

test('pending sweep converges CLOSED, but timeout, changed amount and foreign order do not close or grant', async () => {
  const user = 'closed-sweep-owner';
  const env = routeFixture(user);
  const create = async key => (await ledger.createOrder({ userId: user, channel: 'android', idempotencyKey: key, productSnapshot: credits })).order;
  const closed = await create('sweep-closed-order');
  const timeout = await create('sweep-timeout-order');
  const invalid = await create('sweep-invalid-order');
  env.remote.set(closed.id, env.transaction(closed, 'CLOSED'));
  env.remote.set(timeout.id, new Error('fixture timeout'));
  env.remote.set(invalid.id, { ...env.transaction(invalid, 'CLOSED'), amount: { total: 1, currency: 'CNY' } });
  await env.jobs.reconcilePending();
  assert.equal((await ledger.getOrder(closed.id)).status, 'closed');
  assert.equal((await ledger.getOrder(timeout.id)).status, 'pending');
  assert.equal((await ledger.getOrder(invalid.id)).status, 'pending');
  env.remote.set(timeout.id, env.transaction(closed, 'CLOSED'));
  assert.equal((await env.request(`/api/orders/${timeout.id}`)).status, 502);
  assert.equal((await env.request(`/api/orders/${closed.id}`, 'GET', undefined, 'other-user')).status, 404);
  assert.equal((await ledger.entitlements(user)).totalRemaining, 0);
});

test('an older CLOSED query cannot overwrite payment that wins the account lock', async () => {
  const user = 'closed-paid-race';
  const { order } = await ledger.createOrder({ userId: user, channel: 'android', idempotencyKey: 'closed-paid-race-key', productSnapshot: credits });
  const paidEvent = { orderId: order.id, eventId: 'closed-paid-race-event', status: 'paid', providerTradeId: 'closed-paid-race-trade' };
  const env = routeFixture(user, { ...ledger, closePaymentOrder: async (id, owner) => {
    // The query read pending, but the callback commits before the close acquires
    // the account lock. Exercise the real transactions in this deterministic order.
    await ledger.applyPaymentEvent(paidEvent);
    return ledger.closePaymentOrder(id, owner);
  } });
  env.remote.set(order.id, env.transaction(order, 'CLOSED'));
  const response = await env.request(`/api/orders/${order.id}`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.status, 'paid');
  assert.equal((await ledger.applyPaymentEvent(paidEvent)).duplicate, true);
  assert.equal((await ledger.entitlements(user)).totalRemaining, 10);
  assert.equal((await ledger.reconcileEntitlements()).ok, true);
});

test('close timeout recovery does not close twice when a success arrives after authoritative CLOSED settlement', async () => {
  const user = 'close-retry-race';
  const { order } = await ledger.createOrder({ userId: user, channel: 'android', idempotencyKey: 'close-retry-race-key', productSnapshot: credits });
  let closes = 0;
  const env = routeFixture(user, { ...ledger, closePaymentOrder: async (id, owner) => {
    closes++;
    const result = await ledger.closePaymentOrder(id, owner);
    if (closes === 1) await ledger.applyPaymentEvent({ orderId: id, eventId: 'close-retry-event', status: 'paid', providerTradeId: 'close-retry-trade' });
    return result;
  } });
  env.remote.set(order.id, env.transaction(order, 'CLOSED'));
  const response = await env.request(`/api/orders/${order.id}/close`, 'POST', {});
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.order?.id, order.id, 'successful close response must always include its known order');
  assert.equal(closes, 1, 'settle already performed the close; do not mutate again');
  assert.equal((await ledger.getOrder(order.id)).status, 'paid');
  assert.equal((await ledger.entitlements(user)).totalRemaining, 10);
  assert.equal((await (await env.request(`/api/orders/${order.id}`)).json()).data.status, 'paid');
});

test('client values and repriced catalog cannot change an idempotent order snapshot', async () => {
  const user = 'snapshot-owner';
  const env = routeFixture(user);
  const body = { productId: credits.id, idempotencyKey: 'snapshot-retry-key', channel: 'android', amountFen: 1, credits: 99999, termsVersion: 'paid-plans-v1' };
  const first = await (await env.request('/api/orders', 'POST', body)).json();
  assert.equal(first.data.order.amountFen, 990);
  assert.equal(first.data.order.credits, 10);
  env.setProduct({ ...credits, amountFen: 1990, credits: 20, name: '新价格' });
  const retry = await (await env.request('/api/orders', 'POST', body)).json();
  assert.equal(retry.data.order.id, first.data.order.id);
  assert.equal(retry.data.order.amountFen, 990);
  assert.equal(retry.data.order.productSnapshot.name, credits.name);
  assert.ok(env.prepayments.every(input => input.amountCents === 990 && input.description === credits.name));
  assert.equal((await ledger.listOrders(user)).length, 1);
});
