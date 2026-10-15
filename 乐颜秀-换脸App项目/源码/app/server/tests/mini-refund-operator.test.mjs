import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { miniIdentitySchema } from '../payments/virtual/mini-identity.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createMiniProductionService } from '../payments/virtual/mini-production-service.js';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { draftProducts, purchaseRulesVersion } from '../payments/virtual/products.js';

const appId = 'wx1234567890abcdef';
const operatorId = 'usr_00000000-0000-4000-8000-000000000001';
const customerId = 'usr_00000000-0000-4000-8000-000000000002';
const foreignId = 'usr_00000000-0000-4000-8000-000000000003';
const endpoint = '/api/mini/operations/refunds';
const sessionKey = Buffer.alloc(16, 7).toString('base64');
const { createRefundOperationsClient } = createRequire(import.meta.url)('../../miniprogram/refund-operations.js');

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-refund-operator-'));
  const source = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'isolated.sqlite'), migrate: true });
  t.after(async () => { await source.close(); fs.rmSync(directory, {recursive:true,force:true}); });
  const state = { at: 1800000000000, loseCommit: false }; const now = () => state.at;
  // Real isolated SQL/identity/ledger with a MySQL-shaped port. This is not a MySQL locking acceptance.
  const database = { backend: 'mysql', async transaction(callback) {
    let reviewed = false;
    const result = await source.transaction(q => callback(async (sql, args) => {
      if (sql.startsWith('INSERT INTO vp_audit') && args?.[2] === 'refund.processing') reviewed = true;
      return q(sql.replace(/ FOR UPDATE/g, ''), args);
    }));
    if (state.loseCommit && reviewed) { state.loseCommit = false; throw Error('private unknown commit detail'); }
    return result;
  } };
  await database.transaction(async q => {
    for (const sql of miniIdentitySchema('sqlite')) await q(sql);
    for (const [id, app, openid] of [[operatorId, appId, 'fixture-operator'], [customerId, appId, 'fixture-customer'], [foreignId, 'wx0000000000000000', 'foreign']]) {
      await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [id, app, openid]);
    }
  });
  const ledger = createVirtualLedger({database,encryptionKey:'a'.repeat(64),now}); await ledger.bindEnvironment(appId,0);
  const calls = [];
  const adapter = {appId,env:0, query(){ assert.fail('no provider request'); }, refund(){ assert.fail('no refund request'); }, deliver(){ assert.fail('no delivery'); }};
  const codec = createMessageCodec({appId,token:'fixture',aesKey:Buffer.alloc(32,2).toString('base64').slice(0,-1)});
  const serviceOptions = {ledger,adapter,codec,appSecret:'fixture',products:[draftProducts[0]],now,
    mode:'live',readiness:async()=>({ready:true,operationsReady:true,purchaseProfile:'android-only-v1'}),refundOperatorUserIds:[operatorId],
    fetchImpl:async target => { calls.push(new URL(target).pathname); assert.equal(calls.at(-1),'/sns/jscode2session');
      return Response.json({openid:new URL(target).searchParams.get('js_code')==='operator'?'fixture-operator':'fixture-customer',session_key:sessionKey}); }, ...options};
  const service = createMiniProductionService(serviceOptions);
  const request = async (url, {token,method='GET',body,headers={}} = {}, app=service.app) => {
    const response=await app.request(url,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`} : {}),...headers},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json()};
  };
  const login=async code=>{const r=await request('/api/auth/wechat',{method:'POST',body:{code}});assert.equal(r.status,200);return r.body.data;};
  const operator=await login('operator'),customer=await login('customer');
  const order=await ledger.createOrder({userId:customerId,appId,env:0,product:draftProducts[0],platform:'android',
    rulesVersion:purchaseRulesVersion,idempotencyKey:'fixture-order'});
  await ledger.settle(order.id,{order_id:order.id,env_type:1,order_fee:990,paid_fee:990,left_fee:990,status:2,order_type:0,
    wx_order_id:'fixture-channel-order',paid_time:now()/1000});
  const refund=await ledger.requestRefund(order.id,customerId,'fixture');
  const confirm={confirm:true,approve:true,expectedOrderId:order.id,expectedAmountFen:990};
  const review=(body=confirm,token=operator.token)=>request(`${endpoint}/${refund.id}/review`,{method:'POST',token,body});
  return {...service,serviceOptions,ledger,database,state,operator,customer,order,refund,request,review,login,confirm,calls,
    rows:(sql,args=[])=>database.transaction(q=>q(sql,args))};
}

test('only an explicitly configured existing env0 operator makes the narrow reviewer available; empty/foreign/missing stay closed',async t=>{
  for (const ids of [[],[foreignId],['usr_00000000-0000-4000-8000-000000000099']]) {
    const f=await fixture(t,{refundOperatorUserIds:ids});
    assert.equal((await f.refundOperator.readiness()).ready,false);assert.equal((await f.readiness()).ready,false);
    assert.notEqual((await f.review()).status,200);
  }
  const f=await fixture(t);assert.equal((await f.refundOperator.readiness()).ready,true);assert.equal((await f.readiness()).ready,true);
  assert.throws(()=>createMiniProductionService({...f.serviceOptions,requireAdmin:c=>({response:c.json({},403)})}),/XPAY_REFUND_OPERATOR_ADMIN_CONFLICT/);
  await f.rows('UPDATE vp_environment SET env=1');assert.equal((await f.refundOperator.readiness()).ready,false);
  assert.equal((await f.review()).status,503);
});

test('customer, cookies, forged identity/role headers and legacy admin routes never gain operator authority',async t=>{
  const f=await fixture(t);
  assert.equal((await f.request(endpoint,{token:f.customer.token})).status,403);
  assert.equal((await f.review(f.confirm,f.customer.token)).status,403);
  assert.equal((await f.request(endpoint,{headers:{cookie:'ly_admin_session=forged','x-user-id':operatorId,'x-role':'owner'}})).status,401);
  for(const url of ['/api/admin/mini-payments',`/api/admin/mini-payments/refunds/${f.refund.id}/review`,'/api/admin/mini-payments/reconcile',
    '/api/admin/mini-payments/generations/fake/resolve']) {
    assert.equal((await f.request(url,{method:url==='/api/admin/mini-payments'?'GET':'POST',token:f.operator.token,body:url==='/api/admin/mini-payments'?undefined:{approve:true}})).status,403);
  }
  assert.equal((await f.ledger.refund(f.refund.id)).status,'requested');assert.equal((await f.ledger.outbox()).filter(x=>x.kind==='refund').length,0);
});

test('operator discovery is a no-store boolean from authenticated server identity and never reveals configured users',async t=>{
  const f=await fixture(t);
  for(const [token,operator] of [[f.operator.token,true],[f.customer.token,false]]){
    const response=await f.request('/api/mini/operations/status',{token});
    assert.equal(response.status,200);assert.deepEqual(response.body,{code:0,data:{operator}});
  }
  assert.equal((await f.request('/api/mini/operations/status',{headers:{'x-user-id':operatorId,'x-role':'operator'}})).status,401);
  const raw=await f.app.request('/api/mini/operations/status',{headers:{Authorization:`Bearer ${f.operator.token}`}});
  assert.equal(raw.headers.get('cache-control'),'no-store');
  const unconfigured=await fixture(t,{refundOperatorUserIds:[]});
  assert.deepEqual((await unconfigured.request('/api/mini/operations/status',{token:unconfigured.operator.token})).body,{code:0,data:{operator:false}});
  // Deep links and client-side forged flags cannot bypass the protected routes.
  assert.equal((await f.request(`${endpoint}/${f.refund.id}`,{token:f.customer.token})).status,403);
  await f.identity.logout(`Bearer ${f.operator.token}`);
  assert.equal((await f.request('/api/mini/operations/status',{token:f.operator.token})).status,401);
});

test('five-minute re-login window and persistent cross-instance revoke are enforced without replacing mini identity',async t=>{
  const f=await fixture(t);f.state.at+=300000;
  assert.equal((await f.request(endpoint,{token:f.operator.token})).status,401);assert.equal((await f.review()).status,401);
  const fresh=await f.login('operator');assert.equal(fresh.user.id,operatorId);
  const second=createMiniProductionService(f.serviceOptions);
  assert.equal((await f.request(endpoint,{token:fresh.token},second.app)).status,200);
  await second.identity.logout(`Bearer ${fresh.token}`);
  assert.equal((await f.review(f.confirm,fresh.token)).status,401);
  const fresh2=await f.login('operator');f.state.at+=86400000;
  assert.equal((await f.review(f.confirm,fresh2.token)).status,401);
});

test('review projection omits identity and secrets; exact amount/order confirmation is required before canonical approval',async t=>{
  const f=await fixture(t);const display=await f.request(`${endpoint}/${f.refund.id}`,{token:f.operator.token});
  assert.equal(display.status,200);assert.deepEqual(Object.keys(display.body.data).sort(),['id','orderId','amountFen','status','createdAt','reviewable'].sort());
  for(const body of [{...f.confirm,confirm:false},{...f.confirm,expectedAmountFen:1},{...f.confirm,expectedOrderId:'0'.repeat(32)},
    {...f.confirm,reviewer:operatorId},{...f.confirm,approve:'true'}]) assert.equal((await f.review(body)).status,409);
  assert.equal((await f.review()).status,200);
  assert.equal((await f.ledger.refund(f.refund.id)).reviewer,'mini-operator:'+operatorId);
  assert.equal((await f.ledger.order(f.order.id)).status,'refund_pending');
  assert.deepEqual(await f.rows('SELECT remaining,reserved,frozen FROM vp_buckets'),[{remaining:0,reserved:0,frozen:10}]);
  assert.equal((await f.ledger.outbox()).filter(x=>x.kind==='refund').length,1);
  const audit=await f.rows("SELECT detail FROM vp_audit WHERE action='refund.processing'");assert.equal(audit.length,1);
  assert.equal(JSON.parse(audit[0].detail).reviewer,'mini-operator:'+operatorId);
  assert.ok(f.calls.every(call=>call==='/sns/jscode2session'));
});

test('revocation and amount drift after preliminary authentication are rechecked inside the ledger transaction',async t=>{
  for(const reason of ['revoked','amount']){
    const f=await fixture(t);const original=f.ledger.reviewRefund;
    f.ledger.reviewRefund=async(...args)=>{
      if(reason==='revoked')await f.identity.logout(`Bearer ${f.operator.token}`);
      else {const refund=await f.ledger.refund(f.refund.id);refund.amountFen=989;await f.rows('UPDATE vp_refunds SET payload=? WHERE id=?',[JSON.stringify(refund),refund.id]);}
      return original(...args);
    };
    const result=await f.review();assert.equal(result.status,reason==='revoked'?401:409);
    assert.equal((await f.ledger.refund(f.refund.id)).status,'requested');
    assert.equal((await f.ledger.outbox()).filter(x=>x.kind==='refund').length,0);
  }
});

test('duplicate and concurrent opposite decisions cause only one canonical transition, with no automatic supplier call',async t=>{
  const f=await fixture(t);
  const results=await Promise.all([f.review(),f.review({...f.confirm,approve:false})]);
  assert.deepEqual(results.map(x=>x.status).sort(),[200,409]);
  assert.equal((await f.review()).status,409);
  const current=await f.ledger.refund(f.refund.id);
  assert.equal((await f.rows("SELECT id FROM vp_audit WHERE action IN ('refund.processing','refund.rejected')")).length,1);
  assert.equal((await f.ledger.outbox()).filter(x=>x.kind==='refund').length,current.status==='processing'?1:0);
  assert.ok(f.calls.every(call=>call==='/sns/jscode2session'));
});

test('unknown commit is reported unknown; authenticated GET recovers the original review and replay cannot enqueue again',async t=>{
  const f=await fixture(t);f.state.loseCommit=true;
  const response=await f.review();assert.equal(response.status,503);assert.equal(response.body.code,'XPAY_REFUND_REVIEW_UNCONFIRMED');
  assert.equal(JSON.stringify(response).includes('private unknown'),false);
  assert.equal((await f.request(`${endpoint}/${f.refund.id}`,{token:f.operator.token})).body.data.status,'processing');
  assert.equal((await f.review()).status,409);
  assert.equal((await f.ledger.outbox()).filter(x=>x.kind==='refund').length,1);
});

test('real native operations client through Hono and canonical SQL recovers a committed lost response without review replay',async t=>{
  const f=await fixture(t);const storage=new Map(),calls=[];
  const wx={login:options=>options.success({code:'operator'}),
    getStorageSync:key=>structuredClone(storage.get(key)),setStorageSync:(key,value)=>storage.set(key,structuredClone(value)),removeStorageSync:key=>storage.delete(key),
    request:()=>assert.fail('no public fallback'),cloud:{async callContainer(call){
      calls.push({path:call.path,method:call.method});
      const response=await f.app.request(call.path,{method:call.method,headers:call.header,
        ...(call.data===undefined?{}:{body:JSON.stringify(call.data)})});
      return {statusCode:response.status,data:await response.json()};
    }}};
  const connection={mode:'cloud',env:'synthetic',service:'synthetic'};
  const client=createRefundOperationsClient(wx,connection);await client.login();
  const displayed=await client.detail(f.refund.id);assert.equal(displayed.amountFen,990);f.state.loseCommit=true;
  await assert.rejects(client.review(displayed,true,true),{code:'REFUND_OPS_UNCONFIRMED'});
  assert.ok(client.snapshot().pending);assert.equal((await f.ledger.refund(f.refund.id)).status,'processing');
  const restarted=createRefundOperationsClient(wx,connection);const restored=await restarted.login();
  assert.equal(restored.pending,null);assert.match(restored.records[0].statusLabel,/尚未确认到账/);
  assert.equal(calls.filter(call=>call.path.endsWith('/review')).length,1);
  assert.equal((await f.ledger.outbox()).filter(row=>row.kind==='refund').length,1);
  assert.equal((await f.rows("SELECT id FROM vp_audit WHERE action='refund.processing'")).length,1);
});

test('an explicit rejection reuses the ledger return of frozen rights and remains possible with sales closed',async t=>{
  const f=await fixture(t,{mode:'closed'});assert.equal((await f.readiness()).ready,false);
  const result=await f.review({...f.confirm,approve:false});assert.equal(result.status,200);assert.equal(result.body.data.status,'rejected');
  assert.equal((await f.ledger.order(f.order.id)).status,'paid');
  assert.deepEqual(await f.rows('SELECT remaining,reserved,frozen FROM vp_buckets'),[{remaining:10,reserved:0,frozen:0}]);
  assert.equal((await f.ledger.outbox()).filter(x=>x.kind==='refund').length,0);
});
