import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { registerVirtualPaymentRoutes } from '../payments/virtual/routes.js';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { draftProducts } from '../payments/virtual/products.js';

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-refund-approval-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'ledger.sqlite'), migrate: true });
  let at = Date.now();
  const ledger = createVirtualLedger({ database, encryptionKey: '8'.repeat(64), now: () => at });
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const appId = 'wx-refund-approval';
  await ledger.bindEnvironment(appId, 1);
  await ledger.bindSession({ appId, userId: 'buyer', sessionId: 'session', openid: 'openid-buyer', sessionKey: Buffer.alloc(16, 8).toString('base64') });
  const order = await ledger.createOrder({ userId: 'buyer', product: draftProducts[0], idempotencyKey: 'refund-approval-order', appId, env: 1, platform: 'android' });
  const paid = { order_id: order.id, env_type: 2, order_fee: order.amountFen, paid_fee: order.amountFen,
    order_type: 0, status: 2, wx_order_id: `wx-${order.id}`, paid_time: Math.floor(at / 1000), left_fee: order.amountFen };
  await ledger.settle(order.id, paid);
  await ledger.completeOutbox(`deliver:${order.id}`);
  const refund = await ledger.requestRefund(order.id, 'buyer');
  await ledger.reviewRefund(refund.id, 'finance', true);
  const message = { MchOrderId: order.id, OpenId: order.openid, WxOrderId: paid.wx_order_id,
    MchRefundId: refund.id, WxRefundId: `wx-refund-${refund.id}`, RefundFee: refund.amountFen, RetCode: 0 };
  const remoteRefund = { order_id: refund.id, env_type: 2, order_type: 1, status: 8,
    refund_fee: refund.amountFen, wx_order_id: message.WxRefundId };
  const calls = { refund: 0, query: 0, queryRefund: 0 }; const alerts = [];
  const adapter = {
    query: async () => { calls.query++; return { order: paid }; },
    queryRefund: async () => { calls.queryRefund++; return { order: remoteRefund }; },
    refund: async () => { calls.refund++; return {}; },
  };
  const service = registerVirtualPaymentRoutes(new Hono(), { ledger, adapter: () => adapter, codec: () => null,
    authenticated: c => ({ response: c.json({}, 401) }), requireAdmin: c => ({ response: c.json({}, 403) }),
    products: () => draftProducts, readiness: async () => ({ ready: false, operationsReady: true, mode: 'closed' }),
    alert: (event, details) => alerts.push({ event, details }) });
  const abnormal = () => ledger.applyRefund({ ...message, RetCode: 1 });
  const retry = async () => { await ledger.claimOutbox(`refund:${refund.id}`); at += 61000; };
  const assertHeld = async () => {
    assert.equal((await ledger.refund(refund.id)).status, 'abnormal');
    assert.equal((await ledger.order(order.id)).status, 'refund_pending');
    assert.equal((await ledger.order(order.id)).refundedFen, 0);
    assert.equal((await ledger.entitlements('buyer')).available.photo, 0);
    const [job] = await database.transaction(q => q('SELECT status FROM vp_outbox WHERE id = ?', [`refund:${refund.id}`]));
    assert.equal(job.status, 'pending');
    assert.equal((await ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 0);
    assert.equal(calls.refund, 0);
  };
  return { ledger, database, order, refund, paid, message, remoteRefund, adapter, calls, alerts, service, abnormal, retry, assertHeld,
    advance: () => { at += 61000; } };
}

test('reconciliation leaves a previously abnormal refund held without a channel query or mutation', async t => {
  const f = await setup(t); await f.retry(); await f.abnormal();
  const result = await f.service.reconcile();
  await f.assertHeld();
  assert.equal(f.calls.queryRefund, 0); assert.equal(result.errors, 1);
  assert.equal(f.alerts.at(-1).event, 'virtual_payment.reconciliation_required');
});

test('refund becoming abnormal during channel confirmation cannot be automatically finalized by reconciliation', async t => {
  const f = await setup(t); await f.retry();
  f.adapter.queryRefund = async () => { f.calls.queryRefund++; await f.abnormal(); return { order: f.remoteRefund }; };
  const result = await f.service.reconcile();
  await f.assertHeld();
  assert.equal(f.calls.queryRefund, 1); assert.equal(result.errors, 1);
});

test('refund becoming abnormal during the initial payment query is not submitted', async t => {
  const f = await setup(t);
  f.adapter.query = async () => { f.calls.query++; await f.abnormal(); return { order: f.paid }; };
  const result = await f.service.reconcile();
  await f.assertHeld();
  assert.equal(f.calls.query, 1); assert.equal(result.errors, 1);
});

test('an approved refund still completes once after authoritative query confirmation', async t => {
  const f = await setup(t); await f.retry();
  const result = await f.service.reconcile();
  assert.equal(result.errors, 0);
  assert.equal((await f.ledger.refund(f.refund.id)).status, 'succeeded');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, f.refund.amountFen);
  assert.equal(f.calls.refund, 0);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 1);
  await f.service.reconcile();
  assert.equal(f.calls.queryRefund, 1);
});

test('merchant-debited refund remains frozen through repeated status 5 until the user receives funds at status 8', async t => {
  const f = await setup(t);
  await f.service.reconcile();
  assert.equal(f.calls.refund, 1);
  f.remoteRefund.status = 5;
  for (let attempt = 0; attempt < 2; attempt++) {
    f.advance(); await f.service.reconcile();
    assert.equal((await f.ledger.refund(f.refund.id)).status, 'processing');
    assert.equal((await f.ledger.order(f.order.id)).status, 'refund_pending');
    assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
    const [bucket] = (await f.ledger.entitlements('buyer')).buckets;
    assert.equal(bucket.remaining, 0); assert.equal(bucket.frozen, 10);
    const [job] = await f.database.transaction(q => q('SELECT status FROM vp_outbox WHERE id = ?', [`refund:${f.refund.id}`]));
    assert.equal(job.status, 'pending');
    assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 0);
    assert.equal(f.calls.refund, 1);
  }
  f.remoteRefund.status = 8; f.advance(); await f.service.reconcile();
  assert.equal((await f.ledger.refund(f.refund.id)).status, 'succeeded');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, 990);
  assert.equal((await f.ledger.entitlements('buyer')).buckets[0].frozen, 0);
  const [job] = await f.database.transaction(q => q('SELECT status FROM vp_outbox WHERE id = ?', [`refund:${f.refund.id}`]));
  assert.equal(job.status, 'done');
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 1);
  f.advance(); await f.service.reconcile();
  assert.equal(f.calls.refund, 1); assert.equal(f.calls.queryRefund, 3);
});

test('status 8 cannot finalize a different refund, environment, amount, type or missing channel receipt', async t => {
  const f = await setup(t); await f.retry();
  for (const patch of [{ order_id: 'unknown-refund' }, { env_type: 1 }, { refund_fee: 1 },
    { order_type: 0 }, { wx_order_id: '' }, { status: 7 }]) {
    f.adapter.queryRefund = async () => { f.calls.queryRefund++; return { order: { ...f.remoteRefund, ...patch } }; };
    await f.service.reconcile(); f.advance();
    assert.equal((await f.ledger.refund(f.refund.id)).status, 'processing');
    assert.equal((await f.ledger.order(f.order.id)).refundedFen, 0);
    assert.equal((await f.ledger.entitlements('buyer')).buckets[0].frozen, 10);
    const [job] = await f.database.transaction(q => q('SELECT status FROM vp_outbox WHERE id = ?', [`refund:${f.refund.id}`]));
    assert.equal(job.status, 'pending');
  }
  assert.equal(f.calls.refund, 0);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 0);
});

test('authenticated refund-success notification remains final without requiring a second query', async t => {
  const f = await setup(t);
  const codec = createMessageCodec({ appId: f.order.appId, token: 'test-token',
    aesKey: Buffer.alloc(32, 9).toString('base64').slice(0, -1) });
  const app = new Hono();
  registerVirtualPaymentRoutes(app, { ledger: f.ledger, adapter: () => f.adapter, codec: () => codec,
    products: () => [], readiness: async () => ({ ready: false, operationsReady: true, mode: 'closed' }),
    authenticated: c => ({ response: c.json({}, 401) }), requireAdmin: c => ({ response: c.json({}, 403) }) });
  const message = codec.encode({ ...f.message, MsgType: 'event', Event: 'xpay_refund_notify' });
  const query = new URLSearchParams({ timestamp: String(message.TimeStamp), nonce: message.Nonce,
    msg_signature: message.MsgSignature, encrypt_type: 'aes' });
  const url = `/api/mini/payments/notify?${query}`;
  assert.notEqual((await app.request(url, { method: 'POST', body: JSON.stringify({ Encrypt: message.Encrypt.slice(1) }) })).status, 200);
  assert.equal((await f.ledger.refund(f.refund.id)).status, 'processing');
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await app.request(url, { method: 'POST', body: JSON.stringify({ Encrypt: message.Encrypt }) })).status, 200);
  }
  assert.equal((await f.ledger.refund(f.refund.id)).status, 'succeeded');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, f.refund.amountFen);
  assert.equal(f.calls.query, 0); assert.equal(f.calls.queryRefund, 0); assert.equal(f.calls.refund, 0);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'refund.succeeded').length, 1);
});

test('a channel refund during the payment query prevents submitting the stale merchant refund', async t => {
  const f = await setup(t);
  f.adapter.query = async () => {
    f.calls.query++;
    await f.ledger.applyRefund({ ...f.message, MchRefundId: 'external-channel-refund', WxRefundId: 'external-channel-receipt' });
    return { order: f.paid };
  };
  await f.service.reconcile();
  assert.equal(f.calls.query, 1);
  assert.equal(f.calls.refund, 0);
  assert.equal((await f.ledger.order(f.order.id)).status, 'refunded');
  assert.equal((await f.ledger.order(f.order.id)).refundedFen, f.order.amountFen);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 0);
});
