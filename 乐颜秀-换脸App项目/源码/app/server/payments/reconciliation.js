import { fromWechatOrderId } from './wechat.js';
const fail=()=>{throw new Error('UNSUPPORTED_OR_INVALID_TRADE_BILL');};
const fen=value=>{
  if(!/^\d+(\.\d{1,2})?$/.test(value || '')) return fail();
  const [whole,fraction='']=value.split('.'); const result=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(!Number.isSafeInteger(result)) return fail();return result;
};
const day=value=>value ? new Date(Date.parse(value)+8*3600000).toISOString().slice(0,10) : null;

// WeChat's modern ALL format prefixes every cell with a backtick. Unknown formats fail closed.
// Reports never alter money or entitlements; signed order/refund queries perform recovery.
export function reconcileTradeBill({csv,date,appId,mchId,orders,refunds}) {
  const lines=csv.replace(/^\uFEFF/,'').trim().split(/\r?\n/);
  const headers=lines.shift()?.split(',');
  const required=['公众账号ID','商户号','微信订单号','商户订单号','交易状态','货币种类','订单金额','商户退款单号','微信退款单号','申请退款金额','退款状态'];
  if(!headers || !required.every(key=>headers.includes(key))) return fail();
  const summaryIndex=lines.findIndex(line=>line.startsWith('总交易单数,'));
  if(summaryIndex<0 || summaryIndex!==lines.length-2) return fail();
  const data=lines.slice(0,summaryIndex);
  if(Number(lines.at(-1).replace(/^`/,'').split(',')[0])!==data.length) return fail();
  const seenPayments=new Set(),seenRefunds=new Set(),differences=[];
  let paymentFen=0,refundFen=0,ignored=0;
  const orderMap=new Map(orders.map(o=>[o.id,o])),refundMap=new Map(refunds.map(r=>[r.id,r]));
  for(const line of data) {
    if(!line.startsWith('`')) return fail();
    const cells=line.slice(1).split(',`');if(cells.length!==headers.length) return fail();
    const row=Object.fromEntries(headers.map((key,i)=>[key,cells[i]]));
    if(row['商户号']!==mchId) return fail();
    if(row['公众账号ID']!==appId) {ignored++;continue;}
    if(row['货币种类']!=='CNY') return fail();
    const orderId=fromWechatOrderId(row['商户订单号']);const order=orderMap.get(orderId);
    if(row['交易状态']==='SUCCESS') {
      const amount=fen(row['订单金额']);paymentFen+=amount;
      if(seenPayments.has(orderId)) differences.push({type:'duplicate_payment',orderId});seenPayments.add(orderId);
      if(!order || !order.fulfilledAt || order.providerTradeId!==row['微信订单号'] || order.amountFen!==amount) differences.push({type:'payment_mismatch',orderId});
    } else if(row['交易状态']==='REFUND') {
      if(!['SUCCESS','PROCESSING','CHANGE','REFUNDCLOSE','CLOSED'].includes(row['退款状态'])) return fail();
      if(row['退款状态']!=='SUCCESS') {differences.push({type:'refund_not_final',orderId});continue;}
      const id=row['商户退款单号'];const refund=refundMap.get(id);const amount=fen(row['申请退款金额']);refundFen+=amount;
      if(seenRefunds.has(id)) differences.push({type:'duplicate_refund',refundId:id});seenRefunds.add(id);
      if(!refund || refund.status!=='succeeded' || refund.orderId!==orderId || refund.amountFen!==amount || refund.providerRefundId!==row['微信退款单号'] || !order || order.providerTradeId!==row['微信订单号']) differences.push({type:'refund_mismatch',orderId,refundId:id});
    } else return fail();
  }
  for(const order of orders) if(order.fulfilledAt && day(order.providerPaidAt || order.fulfilledAt)===date && !seenPayments.has(order.id)) differences.push({type:'payment_missing_in_bill',orderId:order.id});
  for(const refund of refunds) if(refund.status==='succeeded' && day(refund.providerRefundedAt || refund.updatedAt)===date && !seenRefunds.has(refund.id)) differences.push({type:'refund_missing_in_bill',refundId:refund.id});
  return {date,ok:differences.length===0,paymentFen,refundFen,paymentCount:seenPayments.size,refundCount:seenRefunds.size,ignoredOtherApps:ignored,differences};
}
