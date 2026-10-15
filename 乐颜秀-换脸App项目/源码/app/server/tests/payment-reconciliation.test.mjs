import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync,sign,createHash } from 'node:crypto';
import { reconcileTradeBill } from '../payments/reconciliation.js';
import { createWechatPay } from '../payments/wechat.js';
const headers=['公众账号ID','商户号','微信订单号','商户订单号','交易状态','货币种类','订单金额','商户退款单号','微信退款单号','申请退款金额','退款状态'];
const csv=rows=>headers.join(',')+'\n'+rows.map(row=>'`'+row.join(',`')).join('\n')+'\n总交易单数,订单总金额\n`'+rows.length+',`9.90';
const order={id:'order1',providerTradeId:'trade1',amountFen:990,fulfilledAt:'2026-09-26T15:59:59Z',providerPaidAt:'2026-09-26T14:00:00Z'};
const payment=['wxapp','12345','trade1','order1','SUCCESS','CNY','9.90','','','0.00',''];
test('daily bill detects amount, missing and duplicate differences without granting money',()=>{
  const base={date:'2026-09-26',appId:'wxapp',mchId:'12345',orders:[order],refunds:[]};
  assert.equal(reconcileTradeBill({...base,csv:csv([payment])}).ok,true);
  const altered=[...payment];altered[6]='9.91';
  assert.equal(reconcileTradeBill({...base,csv:csv([altered])}).ok,false);
  assert.equal(reconcileTradeBill({...base,csv:csv([payment,payment])}).ok,false);
  const missing={...order,id:'other'};
  assert.equal(reconcileTradeBill({...base,orders:[order,missing],csv:csv([payment])}).differences[0].type,'payment_missing_in_bill');
  const invalid=[...payment];invalid[1]='other';assert.throws(()=>reconcileTradeBill({...base,csv:csv([invalid])}));
});
test('partial refunds compare requested amount rather than settlement/coupon values',()=>{
  const refund={id:'refund1',orderId:'order1',amountFen:891,providerRefundId:'wxrefund1',status:'succeeded',updatedAt:'2026-09-26T14:00:00Z'};
  const row=['wxapp','12345','trade1','order1','REFUND','CNY','9.90','refund1','wxrefund1','8.91','SUCCESS'];
  const result=reconcileTradeBill({csv:csv([payment,row]),date:'2026-09-26',appId:'wxapp',mchId:'12345',orders:[order],refunds:[refund]});
  assert.equal(result.ok,true);assert.equal(result.refundFen,891);
});
test('bill download trusts only signed manifest, fixed WeChat host and matching file hash',async()=>{
  const pair=generateKeyPairSync('rsa',{modulusLength:2048}); const now=Date.now();const time=String(Math.floor(now/1000));
  const content=csv([payment]);let corrupt=false;let wrongHost=false;let calls=0;
  const adapter=createWechatPay({appId:'wxapp',mchId:'12345',merchantSerial:'MERCHANT',apiV3Key:'1'.repeat(32),privateKey:pair.privateKey.export({type:'pkcs8',format:'pem'}),platformKeys:{PLATFORM:pair.publicKey.export({type:'spki',format:'pem'})},notifyUrl:'https://example.com/notify',now:()=>now,
    fetchImpl:async url=>{
      calls++;
      if(url.includes('tradebill')) {
        const body=JSON.stringify({hash_type:'SHA1',hash_value:createHash('sha1').update(content).digest('hex'),download_url:wrongHost?'https://attacker.invalid/file':'https://api.mch.weixin.qq.com/v3/billdownload/file?token=REDACTED_SECRET
        return new Response(body,{headers:{'Wechatpay-Timestamp':time,'Wechatpay-Nonce':'n','Wechatpay-Serial':'PLATFORM','Wechatpay-Signature':sign('RSA-SHA256',Buffer.from(`${time}\nn\n${body}\n`),pair.privateKey).toString('base64')}});
      }
      return new Response(corrupt?content+'tampered':content);
    }});
  assert.equal((await adapter.downloadTradeBill('2026-09-26')).csv,content);
  corrupt=true;await assert.rejects(adapter.downloadTradeBill('2026-09-26'),/HASH_MISMATCH/);
  wrongHost=true;const before=calls;await assert.rejects(adapter.downloadTradeBill('2026-09-26'),/BILL_URL/);assert.equal(calls-before,1);
});
