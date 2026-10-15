import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createCloudBusinessEndpoint } from '../payments/virtual/cloud-business-endpoint.js';
import { draftProducts } from '../payments/virtual/products.js';

const appId = 'wx-cloud-business-test';
async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-cloud-business-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'ledger.sqlite'), migrate: true });
  let now = Date.now();
  const ledger = createVirtualLedger({ database, encryptionKey: '6'.repeat(64), now: () => now });
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await ledger.bindEnvironment(appId, 1);
  await ledger.bindSession({ appId, userId: 'buyer', sessionId: 'buyer-session', openid: 'openid-buyer', sessionKey: Buffer.alloc(16, 6).toString('base64') });
  const order = await ledger.createOrder({ userId: 'buyer', product: draftProducts[0], idempotencyKey: 'cloud-test-order', appId, env: 1, platform: 'android' });
  const paid = { order_id: order.id, env_type: 2, order_fee: order.amountFen, paid_fee: order.amountFen,
    order_type: 0, status: 2, wx_order_id: `wx-${order.id}`, paid_time: Math.floor(now / 1000), left_fee: order.amountFen };
  const delivery = { MsgType: 'event', Event: 'xpay_goods_deliver_notify', OpenId: order.openid, OutTradeNo: order.id, Env: 1,
    GoodsInfo: { ProductId: order.productId, Quantity: 1, OrigPrice: order.amountFen, ActualPrice: order.amountFen, Attach: order.id } };
  let queryResult = { order: { ...paid, status: 1 } }; let refundResult; let ready = true;
  const calls = []; const alerts = [];
  const adapter = { appId, env: 1,
    query: async stored => { calls.push({ type: 'payment', order: stored }); if (queryResult instanceof Error) throw queryResult; return queryResult; },
    queryRefund: async (stored, local) => { calls.push({ type: 'refund', order: stored, refund: local }); if (refundResult instanceof Error) throw refundResult; return refundResult; } };
  const endpoint = createCloudBusinessEndpoint({ appId, ledger, adapter, readiness: async () => ({ operationsReady: ready }),
    alert: (event, details) => alerts.push({ event, details }) });
  const post = (body, headers = {}) => endpoint(new Request('http://localhost/api/mini/payments/notify/cloud',
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }));
  const approveRefund = async () => {
    await ledger.settle(order.id, paid);
    const refund = await ledger.requestRefund(order.id, 'buyer');
    await ledger.reviewRefund(refund.id, 'finance', true);
    const message = { MsgType: 'event', Event: 'xpay_refund_notify', OpenId: order.openid, MchOrderId: order.id,
      WxOrderId: paid.wx_order_id, MchRefundId: refund.id, WxRefundId: `wx-refund-${refund.id}`, RefundFee: refund.amountFen, RetCode: 0 };
    const remote = { order_id: refund.id, env_type: 2, order_type: 1, status: 8, refund_fee: refund.amountFen, wx_order_id: message.WxRefundId };
    return { refund, message, remote };
  };
  return { ledger, database, order, paid, delivery, calls, alerts, adapter, endpoint, post, approveRefund,
    query: value => { queryResult = value; }, refundQuery: value => { refundResult = value; }, readiness: value => { ready = value; },
    advance: () => { now += 6000; } };
}
async function retry(response, code) {
  assert.notEqual(response.status, 200);
  const body = await response.json(); assert.notEqual(body.ErrCode, 0);
  if (code) assert.equal(body.ErrMsg, code);
}

test('fabricated source headers and paid body cannot grant an unpaid order', async t => {
  const f = await setup(t);
  await retry(await f.post(f.delivery, { 'x-wx-source': 'wx_push', 'x-wx-sources': 'official', 'x-wx-openid': 'attacker' }), 'XPAY_ORDER_MISMATCH');
  assert.equal((await f.ledger.order(f.order.id)).status, 'pending');
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].order.openid, 'openid-buyer');
  assert.equal((await f.ledger.outbox()).length, 0);
});

test('fabricated delivery with a channel-confirmed payment grants once and preserves the delivery outbox', async t => {
  const f = await setup(t); f.query({ order: f.paid });
  assert.deepEqual(await (await f.post(f.delivery, { 'x-wx-source': 'fabricated' })).json(), { ErrCode: 0, ErrMsg: 'success' });
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  assert.equal((await f.ledger.outbox()).filter(job => job.kind === 'deliver').length, 1);
  await retry(await f.post(f.delivery), 'XPAY_QUERY_BUSY');
  f.advance(); assert.equal((await f.post(f.delivery)).status, 200);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'payment.granted').length, 1);
  assert.equal((await f.ledger.outbox()).filter(job => job.kind === 'deliver').length, 1);
});

test('wrong notification identity or product cannot initiate a channel query', async t => {
  const f = await setup(t); f.query({ order: f.paid });
  for (const message of [{ ...f.delivery, OpenId: 'attacker' }, { ...f.delivery, Env: 0 },
    { ...f.delivery, GoodsInfo: { ...f.delivery.GoodsInfo, Quantity: 2 } }, { ...f.delivery, OutTradeNo: 'unknown' }]) await retry(await f.post(message));
  assert.equal(f.calls.length, 0); assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
});

test('payment query failures and mismatched channel facts remain retryable without grants', async t => {
  const f = await setup(t);
  for (const result of [new Error('private provider diagnostic'), { order: { ...f.paid, env_type: 1 } },
    { order: { ...f.paid, order_id: 'another-order' } }, { order: { ...f.paid, paid_fee: 1 } }, { order: { ...f.paid, wx_order_id: '' } }]) {
    f.advance(); f.query(result); await retry(await f.post(f.delivery));
    assert.equal((await f.ledger.order(f.order.id)).status, 'pending');
  }
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  assert.ok(!JSON.stringify(f.alerts).includes('private provider diagnostic'));
});

test('refund body cannot remove paid rights when the channel does not confirm the refund', async t => {
  const f = await setup(t); const { refund, message, remote } = await f.approveRefund();
  const before = await f.ledger.entitlements('buyer');
  f.refundQuery({ order: { ...remote, status: 1 } });
  await retry(await f.post(message, { 'x-wx-source': 'official' }), 'XPAY_REFUND_UNCONFIRMED');
  assert.equal((await f.ledger.refund(refund.id)).status, 'processing');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
  assert.deepEqual(await f.ledger.entitlements('buyer'), before);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 0);
});

test('channel-confirmed approved refund commits once and duplicate receipt is idempotent', async t => {
  const f = await setup(t); const { refund, message, remote } = await f.approveRefund(); f.refundQuery({ order: remote });
  assert.equal((await f.post(message)).status, 200);
  f.advance(); assert.equal((await f.post(message)).status, 200);
  assert.equal((await f.ledger.refund(refund.id)).status, 'succeeded');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, refund.amountFen);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 1);
  assert.equal((await f.ledger.outbox()).filter(row => row.kind === 'refund').length, 1);
});

test('cloud refund notification retries while only the merchant is debited and completes only after user receipt', async t => {
  const f = await setup(t); const { refund, message, remote } = await f.approveRefund();
  f.refundQuery({ order: { ...remote, status: 5 } });
  for (let attempt = 0; attempt < 2; attempt++) {
    f.advance(); await retry(await f.post(message), 'XPAY_REFUND_UNCONFIRMED');
    assert.equal((await f.ledger.refund(refund.id)).status, 'processing');
    assert.equal((await f.ledger.order(f.order.id)).status, 'refund_pending');
    assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
    assert.equal((await f.ledger.entitlements('buyer')).buckets[0].frozen, 10);
    assert.equal((await f.ledger.outbox()).filter(job => job.kind === 'refund').length, 1);
    assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 0);
  }
  f.refundQuery({ order: remote }); f.advance();
  assert.equal((await f.post(message)).status, 200);
  assert.equal((await f.ledger.refund(refund.id)).status, 'succeeded');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, refund.amountFen);
  assert.equal((await f.ledger.entitlements('buyer')).buckets[0].frozen, 0);
  f.advance(); assert.equal((await f.post(message)).status, 200);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 1);
});

test('refund amount, environment, IDs, order type and failed query must all match provider proof', async t => {
  const f = await setup(t); const { refund, message, remote } = await f.approveRefund();
  for (const value of [new Error('private refund error'), { order: { ...remote, env_type: 1 } },
    { order: { ...remote, order_id: 'wrong-refund' } }, { order: { ...remote, order_type: 0 } },
    { order: { ...remote, refund_fee: 1 } }, { order: { ...remote, wx_order_id: 'wrong-provider-refund' } }]) {
    f.advance(); f.refundQuery(value); await retry(await f.post(message));
    assert.equal((await f.ledger.refund(refund.id)).status, 'processing');
    assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
  }
});

test('unknown, unreviewed and failed refunds never create a channel query or ledger event', async t => {
  const f = await setup(t); await f.ledger.settle(f.order.id, f.paid);
  const refund = await f.ledger.requestRefund(f.order.id, 'buyer');
  const message = { MsgType: 'event', Event: 'xpay_refund_notify', MchOrderId: f.order.id, MchRefundId: refund.id,
    OpenId: f.order.openid, WxOrderId: f.paid.wx_order_id, WxRefundId: 'fabricated-refund', RefundFee: refund.amountFen, RetCode: 0 };
  f.refundQuery({ order: { order_id: refund.id, env_type: 2, order_type: 1, status: 8,
    refund_fee: refund.amountFen, wx_order_id: message.WxRefundId } });
  for (const body of [message, { ...message, MchRefundId: 'unknown-refund', RefundFee: 1 }, { ...message, RetCode: 1 }]) await retry(await f.post(body), 'XPAY_REFUND_REVIEW_REQUIRED');
  assert.equal(f.calls.length, 0); assert.equal((await f.ledger.refund(refund.id)).status, 'requested');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
});

test('refund request with wrong user, amount or payment cannot query even a real approved refund', async t => {
  const f = await setup(t); const { message } = await f.approveRefund();
  for (const body of [{ ...message, OpenId: 'attacker' }, { ...message, RefundFee: 1 },
    { ...message, WxOrderId: 'wrong-payment' }, { ...message, WxRefundId: '' }]) await retry(await f.post(body), 'XPAY_REFUND_MISMATCH');
  assert.equal(f.calls.length, 0); assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
});

test('refund becoming abnormal during the channel query cannot bypass the transaction approval check', async t => {
  const f = await setup(t); const { refund, message, remote } = await f.approveRefund();
  f.adapter.queryRefund = async () => {
    await f.ledger.applyRefund({ ...message, RetCode: 1 });
    assert.equal((await f.ledger.refund(refund.id)).status, 'abnormal');
    return { order: remote };
  };
  await retry(await f.post(message), 'XPAY_REFUND_REVIEW_REQUIRED');
  assert.equal((await f.ledger.refund(refund.id)).status, 'abnormal');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 0);
});

test('refund write failure rolls back channel-confirmed refund state and preserves its durable job', async t => {
  const f = await setup(t); const { refund, message, remote } = await f.approveRefund(); f.refundQuery({ order: remote });
  const failingLedger = createVirtualLedger({ encryptionKey: '6'.repeat(64), database: { backend: 'sqlite',
    transaction: callback => f.database.transaction(query => callback(async (sql, args) => {
      if (sql.startsWith('UPDATE vp_buckets SET remaining = 0, frozen = 0')) throw new Error('refund database write failed');
      return query(sql, args);
    })) } });
  const failing = createCloudBusinessEndpoint({ appId, adapter: f.adapter, ledger: failingLedger,
    readiness: async () => ({ operationsReady: true }) });
  await retry(await failing(new Request('http://localhost/cloud', { method: 'POST', body: JSON.stringify(message) })), 'XPAY_UNCONFIRMED');
  assert.equal((await f.ledger.refund(refund.id)).status, 'processing');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
  assert.equal((await f.ledger.outbox()).filter(job => job.kind === 'refund').length, 1);
  f.advance(); assert.equal((await f.post(message)).status, 200);
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, refund.amountFen);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 1);
});

test('exact probe is independent while mixed probes, iOS queries and unknown events never acknowledge business', async t => {
  const f = await setup(t); f.readiness(false);
  const probe = await f.post({ action: 'CheckContainerPath' }); assert.equal(probe.status, 200); assert.equal(await probe.text(), 'success');
  for (const body of [{ action: 'CheckContainerPath', ...f.delivery }, { Event: 'debug_demo' },
    { Event: 'xpay_subscribe_ios_refund_query_notify', pay_order_id: f.order.id }, { Event: 'xpay_complaint_notify' }]) await retry(await f.post(body), 'XPAY_EVENT_REVIEW_REQUIRED');
  await retry(await f.post(f.delivery), 'XPAY_NOT_READY');
  assert.equal(f.calls.length, 0);
  assert.ok(f.alerts.every(item => item.details.mode === 'query-authoritative'));
});

test('invalid JSON, excessive body and unsupported method cannot touch the ledger', async t => {
  const f = await setup(t);
  for (const body of [null, [], 'string']) await retry(await f.post(body), 'XPAY_MESSAGE_INVALID');
  await retry(await f.endpoint(new Request('http://localhost/cloud', { method: 'POST', body: '{bad' })), 'XPAY_MESSAGE_INVALID');
  await retry(await f.post({ padding: 'a'.repeat(131073) }), 'XPAY_MESSAGE_TOO_LARGE');
  const method = await f.endpoint(new Request('http://localhost/cloud')); assert.equal(method.status, 405);
  assert.equal(f.calls.length, 0);
});

test('ledger transaction failure rolls back a provider-confirmed payment and prevents a success ACK', async t => {
  const f = await setup(t); f.query({ order: f.paid });
  const failingLedger = createVirtualLedger({ encryptionKey: '6'.repeat(64), database: { backend: 'sqlite',
    transaction: callback => f.database.transaction(query => callback(async (sql, args) => {
      if (sql.startsWith('INSERT INTO vp_buckets')) throw new Error('database write failed');
      return query(sql, args);
    })) } });
  const failing = createCloudBusinessEndpoint({ appId, adapter: f.adapter, readiness: async () => ({ operationsReady: true }),
    ledger: failingLedger });
  await retry(await failing(new Request('http://localhost/cloud', { method: 'POST', body: JSON.stringify(f.delivery) })), 'XPAY_UNCONFIRMED');
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
  assert.equal((await f.ledger.order(f.order.id)).status, 'pending');
  assert.equal((await f.ledger.outbox()).length, 0);
  f.advance(); assert.equal((await f.post(f.delivery)).status, 200);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
});
