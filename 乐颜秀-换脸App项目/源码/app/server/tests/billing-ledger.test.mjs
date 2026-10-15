import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { BILLING_SCHEMA } from '../payments/database.js';
import { createBillingLedger } from '../payments/ledger.js';
import { Hono } from 'hono';
import { registerPaymentRoutes } from '../payments/routes.js';
import { fromWechatOrderId,toWechatOrderId } from '../payments/wechat.js';

const pg = new PGlite();
await pg.exec(BILLING_SCHEMA);
const db = { query: (sql, args) => pg.query(sql, args), transaction: (userId, fn) => pg.transaction(async q => {
  await q.query('INSERT INTO billing_accounts(id) VALUES($1) ON CONFLICT DO NOTHING', [userId]);
  await q.query('SELECT id FROM billing_accounts WHERE id=$1 FOR UPDATE', [userId]);
  return fn(q);
}) };
let time = Date.parse('2026-09-01T00:00:00Z');
const ledger = createBillingLedger(db, { now: () => time });
let counter = 0;
async function paid(userId, { type = 'credits', credits = 10, amountFen = 1000 } = {}) {
  const key = `order-key-${counter++}`;
  const { order } = await ledger.createOrder({ userId, channel: 'android', idempotencyKey: key,
    productSnapshot: { id: type, name: type, amountFen, credits, type, durationDays: type === 'monthly' ? 30 : null } });
  return (await ledger.applyPaymentEvent({ orderId: order.id, eventId: key, status: 'paid', providerTradeId: key })).order;
}
test.after(() => pg.close());

test('SQL grants are exactly once; simultaneous reservations cannot overspend', async () => {
  const order = await paid('race', { credits: 2 });
  const repeat = await ledger.applyPaymentEvent({ orderId: order.id, eventId: 'repeated', status: 'paid', providerTradeId: order.providerTradeId });
  assert.equal(repeat.duplicate, true);
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, i) => ledger.reserveCreation('race', `race-${i}`, 'photo')));
  assert.equal(attempts.filter(r => r.ok).length, 2);
  assert.equal((await ledger.entitlements('race')).totalRemaining, 0);
  assert.equal(await ledger.confirmCreation('race', 'race-0'), true);
  assert.equal(await ledger.confirmCreation('race', 'race-0'), true);
  assert.equal(await ledger.refundCreation('race', 'race-0'), false);
  assert.equal(await ledger.refundCreation('race', 'race-1'), true);
  assert.equal(await ledger.refundCreation('race', 'race-1'), false);
  assert.equal((await ledger.entitlements('race')).totalRemaining, 1);
});
test('order-scoped partial refund holds only original remaining units, not another purchase', async () => {
  const order = await paid('partial');
  await ledger.reserveCreation('partial', 'partial-task', 'photo');
  assert.equal((await ledger.requestRefund(order.id, 'partial')).error, 'REFUND_TASK_IN_PROGRESS');
  await ledger.confirmCreation('partial', 'partial-task');
  await paid('partial', { credits: 3 });
  const { refund } = await ledger.requestRefund(order.id, 'partial');
  assert.equal(refund.amountFen, 900);
  assert.equal(refund.credits, 9);
  assert.equal((await ledger.entitlements('partial')).totalRemaining, 3);
  await ledger.approveRefund(refund.id, 'owner');
  assert.equal((await ledger.rejectRefund(refund.id, 'owner', 'timeout')).error, 'REFUND_AUTHORITATIVE_STATUS_REQUIRED');
  const result = { refundId: refund.id, status: 'SUCCESS', providerRefundId: 'wx-refund', providerTradeId: order.providerTradeId };
  await ledger.applyRefundResult(result);
  assert.equal((await ledger.applyRefundResult(result)).duplicate, true);
  assert.equal((await ledger.getOrder(order.id)).status, 'partially_refunded');
  assert.equal((await ledger.getOrder(order.id)).refundedFen, 900);
  assert.equal((await ledger.entitlements('partial')).totalRemaining, 3);
});
test('monthly renewal queues periods; expiry stops new use; failed in-flight task gets seven-day compensation', async () => {
  time = Date.parse('2026-09-01T00:00:00Z');
  const first = await paid('monthly', { type: 'monthly', credits: 2 });
  const second = await paid('monthly', { type: 'monthly', credits: 3 });
  assert.equal(first.expiresAt, second.startsAt);
  assert.equal((await ledger.entitlements('monthly')).totalRemaining, 2);
  await ledger.reserveCreation('monthly', 'monthly-task', 'video');
  time += 30 * 86400000;
  assert.equal((await ledger.entitlements('monthly')).totalRemaining, 3);
  await ledger.refundCreation('monthly', 'monthly-task');
  assert.equal((await ledger.entitlements('monthly')).totalRemaining, 4);
  time += 7 * 86400000;
  assert.equal((await ledger.entitlements('monthly')).totalRemaining, 3);
});
test('monthly refunds are capped by both unused units and remaining time', async () => {
  const order = await paid('monthly-refund', { type: 'monthly', credits: 10, amountFen: 3000 });
  time += 15 * 86400000;
  const { refund } = await ledger.requestRefund(order.id, 'monthly-refund');
  assert.equal(refund.amountFen, 1500);
  await ledger.rejectRefund(refund.id, 'owner', 'user withdrew');
  assert.equal((await ledger.entitlements('monthly-refund')).totalRemaining, 10);
});
test('cross-account IDs, reused trade IDs and unsupported product claims fail closed', async () => {
  const order = await paid('ownership');
  assert.equal(await ledger.getOrder(order.id, 'stranger'), null);
  assert.equal((await ledger.requestRefund(order.id, 'stranger')).error, 'ORDER_NOT_FOUND');
  await assert.rejects(ledger.savePaymentProducts([{ id:'bad',name:'unlimited',amountFen:1,credits:1,type:'unlimited' }], 'owner'));
  const created = await ledger.createOrder({ userId: 'other', channel: 'android', idempotencyKey: 'other-key', productId: 'pack', amountFen: 100, credits: 1 });
  await assert.rejects(ledger.applyPaymentEvent({ orderId: created.order.id, eventId: 'unique-event', status: 'paid', providerTradeId: order.providerTradeId }));
  assert.equal((await ledger.entitlements('other')).totalRemaining, 0);
  assert.equal((await ledger.getOrder(created.order.id)).status, 'pending');
  assert.equal((await ledger.reconcileEntitlements()).ok, true);
});
test('fractional quota refund does not lose an extra cent to floating point multiplication',async()=>{
  const order=await paid('rounding',{amountFen:100,credits:100});
  for(let i=0;i<71;i++) {await ledger.reserveCreation('rounding',`rounding-${i}`,'photo');await ledger.confirmCreation('rounding',`rounding-${i}`);}
  assert.equal((await ledger.quoteRefund(order.id,'rounding')).amountFen,29);
});
test('async HTTP purchase, settlement, refund quote and approval preserve partial amounts', async()=>{
  const app=new Hono();const product={id:'http-pack',name:'HTTP fixture',type:'credits',amountFen:990,credits:10};
  const gateway={createAppOrder:async()=>({prepayid:'fixture'}),validateTransaction:()=>{},validateRefund:(remote,expected)=>assert.equal(remote.amount.refund,expected.refundCents),
    verifyNotification:raw=>JSON.parse(raw),refund:async args=>{
      assert.equal(args.refundCents,891);assert.equal(args.totalCents,990);
      const order=await ledger.getOrder(args.orderId);
      return {status:'SUCCESS',refund_id:'http-refund',transaction_id:order.providerTradeId,amount:{refund:args.refundCents,total:args.totalCents}};
    }};
  registerPaymentRoutes(app,{store:ledger,products:async()=>[product],readiness:async()=>({ready:true}),adapter:()=>gateway,orderIdFromTrade:fromWechatOrderId,flush:async()=>{},
    authenticated:()=>({auth:{userId:'http-user'}}),requireAdmin:()=>({session:{username:'owner'}})});
  const request=(url,body,method='POST')=>app.request(url,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  const created=await (await request('/api/orders',{productId:product.id,idempotencyKey:'http-order-key',channel:'android',amountFen:1})).json();
  const order=created.data.order;assert.equal(order.amountFen,990);
  const callback=await request('/api/payments/wechat/notify',{eventType:'TRANSACTION.SUCCESS',resource:{out_trade_no:toWechatOrderId(order.id),transaction_id:'http-trade',trade_state:'SUCCESS'}});
  assert.equal(callback.status,204);
  await ledger.reserveCreation('http-user','http-task','photo');await ledger.confirmCreation('http-user','http-task');
  const quote=await (await request(`/api/orders/${order.id}/refund-quote`,null,'GET')).json();assert.equal(quote.data.amountFen,891);
  assert.equal((await request(`/api/orders/${order.id}/refund`,{reason:'fixture',expectedAmountFen:990})).status,409);
  assert.equal((await ledger.entitlements('http-user')).totalRemaining,9);
  const asked=await (await request(`/api/orders/${order.id}/refund`,{reason:'fixture',expectedAmountFen:891})).json();
  assert.equal((await request(`/api/admin/billing/refunds/${asked.data.refund.id}/approve`,{})).status,200);
  assert.equal((await ledger.getOrder(order.id)).refundedFen,891);
});
