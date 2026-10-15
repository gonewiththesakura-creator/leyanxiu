import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lyx-refund-'));
process.env.COMPLIANCE_BACKEND='sqlite';
process.env.COMPLIANCE_SQLITE_FILE=path.join(dir,'ledger.db');
process.env.DEPLOY_ENV='test';
const {store,resetStoreForTests}=await import('../compliance-store.js');
function paid() {
  resetStoreForTests();
  const user=store.createOrGetUser({subject:'refund'});
  const {order}=store.createOrder({userId:user.id,productId:'pack',amountFen:100,credits:5,channel:'wechat',idempotencyKey:'order'});
  store.applyPaymentEvent({eventId:'paid',orderId:order.id,status:'paid',providerTradeId:'trade',rawDigest:'a'.repeat(64)});
  return {user,order};
}
test('refund holds exactly once, prevents spend and success never double revokes',()=>{
  const {user,order}=paid();
  const {refund}=store.requestRefund(order.id,user.id,'not needed');
  assert.ok(refund.id.length<=32);
  assert.equal(store.requestRefund(order.id,user.id,'again').duplicate,true);
  assert.equal(store.entitlements(user.id).purchasedRemaining,0);
  assert.equal(store.reserveCreation(user.id,'generation').ok,false);
  assert.equal(store.approveRefund(refund.id,'admin').refund.status,'processing');
  assert.equal(store.rejectRefund(refund.id,'admin','uncertain').error,'REFUND_AUTHORITATIVE_STATUS_REQUIRED');
  assert.equal(store.applyRefundResult({refundId:refund.id,status:'SUCCESS',providerTradeId:'wrong',providerRefundId:'wx-refund'}).error,'PAYMENT_TRADE_ID_CONFLICT');
  assert.equal(store.applyRefundResult({refundId:refund.id,status:'SUCCESS',providerTradeId:'trade',providerRefundId:'wx-refund'}).refund.status,'succeeded');
  assert.equal(store.entitlements(user.id).purchasedRemaining,0);
  assert.equal(store.applyRefundResult({refundId:refund.id,status:'SUCCESS',providerTradeId:'trade',providerRefundId:'wx-refund'}).duplicate,true);
});
test('reject releases hold once, ambiguous provider outcome keeps frozen',()=>{
  const {user,order}=paid();
  const {refund}=store.requestRefund(order.id,user.id,'refund');
  store.approveRefund(refund.id,'admin');
  store.applyRefundResult({refundId:refund.id,status:'ABNORMAL',providerTradeId:'trade',providerRefundId:'wx-refund'});
  assert.equal(store.entitlements(user.id).purchasedRemaining,0);
  assert.equal(store.applyRefundResult({refundId:refund.id,status:'CLOSED',providerTradeId:'trade',providerRefundId:'wx-refund'}).refund.status,'rejected');
  assert.equal(store.entitlements(user.id).purchasedRemaining,5);
  assert.equal(store.applyRefundResult({refundId:refund.id,status:'CLOSED',providerTradeId:'trade',providerRefundId:'wx-refund'}).duplicate,true);
  store.rejectRefund(refund.id,'admin','again');
  assert.equal(store.entitlements(user.id).purchasedRemaining,5);
});
test('cannot refund another user, insufficient credits or reuse failed generation reference',()=>{
  const {user,order}=paid();
  assert.equal(store.requestRefund(order.id,'other','refund').error,'ORDER_NOT_FOUND');
  store.reserveCreation(user.id,'generation');
  assert.equal(store.requestRefund(order.id,user.id,'refund').error,'REFUND_CREDITS_IN_USE');
  store.refundCreation(user.id,'generation');
  assert.equal(store.reserveCreation(user.id,'generation').ok,false);
});
test('unexpected payment states cannot downgrade paid orders',()=>{
  const {user,order}=paid();
  assert.equal(store.applyPaymentEvent({eventId:'downgrade',orderId:order.id,status:'pending',providerTradeId:'trade',rawDigest:'b'.repeat(64)}).error,'PAYMENT_STATUS_INVALID');
  assert.equal(store.getOrder(order.id,user.id).status,'paid');
});
test('product catalog validates prices and names and never rewrites historic order pricing',()=>{
  const {user,order}=paid();
  assert.equal(store.paymentProducts(),null);
  assert.throws(()=>store.savePaymentProducts([{id:'pack',name:'套餐',amountFen:0,credits:5}],'owner'));
  assert.throws(()=>store.savePaymentProducts([{id:'pack',name:'套'.repeat(43),amountFen:100,credits:5}],'owner'));
  const products=[{id:'pack',name:'制作套餐',amountFen:200,credits:8}];
  assert.throws(()=>store.savePaymentProducts([...products,...products],'owner'));
  store.savePaymentProducts(products,'owner');
  assert.equal(store.paymentProducts()[0].amountFen,200);
  assert.equal(store.getOrder(order.id,user.id).amountFen,100);
  store.savePaymentProducts([],'owner');
  assert.deepEqual(store.paymentProducts(),[]);
});
