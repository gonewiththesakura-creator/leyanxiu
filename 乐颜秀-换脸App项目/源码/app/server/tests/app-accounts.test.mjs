import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { Hono } from 'hono';
import { BILLING_SCHEMA } from '../payments/database.js';
import { createBillingLedger } from '../payments/ledger.js';
import { createPaymentAccounts } from '../payments/accounts.js';
import { createAccountRegistry } from '../accounts/registry.js';
import { createWechatLogin,wechatLoginReady } from '../accounts/wechat.js';
import { registerAppAccountRoutes } from '../accounts/routes.js';
import { accountSessionGuard } from '../accounts/middleware.js';

const pg=new PGlite();await pg.exec(BILLING_SCHEMA);
const db={query:(s,a)=>pg.query(s,a),transaction:(id,fn)=>pg.transaction(fn)};
let time=Date.now();let counter=0;const usersById=new Map();const subjects=new Map();const sent=[];
const users={getUser:id=>usersById.get(id),revokeUserSessions:()=>{},createOrGetUser:({subject})=>{
  if(subjects.has(subject) && usersById.get(subjects.get(subject)).status!=='deleted')return usersById.get(subjects.get(subject));
  const user={id:`user-${++counter}`,status:'active'};usersById.set(user.id,user);subjects.set(subject,user.id);return user;
}};
const registry=createAccountRegistry(db,{users,now:()=>time});
const otp=createPaymentAccounts(db,{secret:'test-only-'.repeat(5),now:()=>time,sendSms:async(phone,code)=>sent.push({phone,code}),resolveLogin:(...args)=>registry.phoneLogin(...args)});
async function phoneLogin(phone,deviceId,extra={}) {
  time+=61000;
  const challenge=await otp.challenge({phone,deviceUserId:deviceId,ip:deviceId,purpose:'login',...extra});
  assert.ok(challenge.challengeId,challenge.error);
  const result=await otp.verify({...challenge,deviceUserId:deviceId,code:sent.at(-1).code,expectedPurpose:['login','link-phone']});
  return {...result,authMethod:'phone',authenticatedAt:time};
}
test.after(()=>pg.close());
test('phone login preserves the same paid account across devices; switching does not merge balances',async()=>{
  const first=await phoneLogin('13800000101','device-a');
  const ledger=createBillingLedger(db,{now:()=>time});
  const {order}=await ledger.createOrder({userId:first.userId,productId:'p',amountFen:100,credits:3,idempotencyKey:'order-account-1',channel:'android',productSnapshot:{id:'p',name:'pack',amountFen:100,credits:3,type:'credits'}});
  await ledger.applyPaymentEvent({orderId:order.id,status:'paid',providerTradeId:'trade-account',eventId:'event-account'});
  const second=await phoneLogin('13800000101','device-b');
  assert.equal(second.userId,first.userId);
  assert.equal((await ledger.entitlements(second.userId)).totalRemaining,3);
  const other=await phoneLogin('13800000102','device-a');
  assert.notEqual(other.userId,first.userId);
  assert.equal(await registry.validSession(first),false);
  assert.equal((await ledger.entitlements(other.userId)).totalRemaining,0);
  assert.equal((await ledger.entitlements(second.userId)).totalRemaining,3);
});
test('logout invalidates device sessions, including old signed tokens, and all-device logout blocks resume',async()=>{
  const a=await phoneLogin('13800000103','logout-a');
  const b=await phoneLogin('13800000103','logout-b');
  assert.equal(await registry.validSession(a),true);
  await registry.logout(a);
  assert.equal(await registry.validSession(a),false);
  assert.equal((await registry.device('logout-a')).userId,'logout-a');
  assert.equal(await registry.validSession(b),true);
  await registry.logout(b,true);
  assert.equal(await registry.validSession(b),false);
});
test('WeChat explicit link preserves account ID, rejects cross-account links and replay',async()=>{
  const auth=await phoneLogin('13800000104','wechat-a');
  const start=await registry.startWechat(auth,'link');
  assert.ok(start.state);
  assert.equal((await registry.consumeWechat({...auth,deviceId:'intruder'},start.state)).error,'LOGIN_STATE_INVALID');
  const challenge=await registry.consumeWechat(auth,start.state);
  assert.equal((await registry.consumeWechat(auth,start.state)).error,'LOGIN_STATE_INVALID');
  const provider={appId:'wx1234567890abcdef',openid:'openid-user-1'};
  const linked=await registry.finishWechat(auth,challenge,provider);
  assert.equal(linked.userId,auth.userId);
  assert.equal((await registry.status(auth.userId)).wechatLinked,true);
  const newDevice={userId:'wechat-b',deviceId:'wechat-b',deviceVersion:null};
  const loginStart=await registry.startWechat(newDevice,'login');
  const logged=await registry.finishWechat(newDevice,await registry.consumeWechat(newDevice,loginStart.state),provider);
  assert.equal(logged.userId,auth.userId);
  const stranger=await phoneLogin('13800000105','wechat-c');
  const conflict=await registry.startWechat(stranger,'link');
  assert.equal((await registry.finishWechat(stranger,await registry.consumeWechat(stranger,conflict.state),provider)).error,'ACCOUNT_LINK_CONFLICT');
  time+=300001;
  assert.equal((await registry.startWechat(stranger,'link')).error,'RECENT_PHONE_LOGIN_REQUIRED');
});
test('optional phone linking never claims another paid account and rejects a changed session',async()=>{
  const auth=await phoneLogin('13800000106','phone-link');
  const conflict=await phoneLogin('13800000101','phone-link',{purpose:'link-phone',loginUserId:auth.userId,deviceVersion:auth.deviceVersion});
  assert.equal(conflict.error,'ACCOUNT_LINK_CONFLICT');
  time+=61000;
  const challenge=await otp.challenge({phone:'13800000107',deviceUserId:'phone-link',ip:'new',purpose:'link-phone',loginUserId:auth.userId,deviceVersion:auth.deviceVersion});
  await registry.logout(auth);
  assert.equal((await otp.verify({...challenge,code:sent.at(-1).code,deviceUserId:'phone-link'})).error,'OTP_INVALID');
});
test('disabled accounts cannot resume via phone and OTP endpoints do not accept legacy binding challenges',async()=>{
  const auth=await phoneLogin('13800000108','disabled');
  usersById.get(auth.userId).status='suspended';
  assert.equal((await phoneLogin('13800000108','disabled-new')).error,'ACCOUNT_UNAVAILABLE');
  time+=61000;
  const challenge=await otp.challenge({phone:'13800000109',purpose:'bind',deviceUserId:'legacy-device',ip:'legacy'});
  assert.equal((await otp.verify({...challenge,code:sent.at(-1).code,deviceUserId:'legacy-device',expectedPurpose:'login'})).error,'OTP_INVALID');
});
test('WeChat adapter fixes host, keeps secrets server-side and rejects errors without leaking tokens',async()=>{
  assert.equal(wechatLoginReady({}),false);
  const exchange=createWechatLogin({appId:'wx1234567890abcdef',secret:'test-secret',fetchImpl:async(url,options)=>{
    assert.equal(url.origin,'https://api.weixin.qq.com');assert.equal(options.redirect,'error');
    return {ok:true,json:async()=>({openid:'openid-user-test',access_token:'never-return',unionid:'not-auto-merged'})};
  }});
  assert.deepEqual(await exchange('code123456'),{appId:'wx1234567890abcdef',openid:'openid-user-test'});
  const fails=createWechatLogin({appId:'wx1234567890abcdef',secret:'test-secret',fetchImpl:async()=>{throw new Error('sensitive-transport-details');}});
  await assert.rejects(fails('code123456'),/^Error: WECHAT_LOGIN_FAILED$/);
});
test('HTTP login requires terms; persistence failure revokes resume; no configuration stays closed',async()=>{
  const app=new Hono();let current={userId:'http-device',deviceId:'http-device',deviceVersion:null};let flushFails=false,sessionFails=false;
  registerAppAccountRoutes(app,{registry,otp,users,authenticated:()=>({auth:current}),sessionForUser:(id)=>{if(sessionFails)throw new Error('session write failed');return {token:'test-session',user:{id}};},flush:async()=>{if(flushFails)throw new Error('offline');},clientAddress:()=> 'http',smsReady:()=>true,wechatReady:()=>false,rateLimit:()=>true});
  const post=(path,body)=>app.request(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await post('/api/account/login/phone/challenge',{phone:'13800000110'})).status,400);
  time+=61000;
  const challenge=await (await post('/api/account/login/phone/challenge',{phone:'13800000110',termsVersion:'account-v1'})).json();
  flushFails=true;
  const failed=await post('/api/account/login/phone/verify',{challengeId:challenge.data.challengeId,code:sent.at(-1).code,termsVersion:'account-v1'});
  assert.equal(failed.status,503);
  assert.equal((await registry.device(current.deviceId)).deviceVersion,null);
  time+=61000;flushFails=false;sessionFails=true;
  const retry=await (await post('/api/account/login/phone/challenge',{phone:'13800000110',termsVersion:'account-v1'})).json();
  assert.equal((await post('/api/account/login/phone/verify',{challengeId:retry.data.challengeId,code:sent.at(-1).code,termsVersion:'account-v1'})).status,503);
  assert.equal((await registry.device(current.deviceId)).deviceVersion,null);
  assert.equal((await post('/api/account/login/wechat/start',{termsVersion:'account-v1'})).status,503);
});

test('HTTP guard rejects old signed sessions and guest spending; logout consumes pending authorizations',async()=>{
  const app=new Hono();let auth={userId:'guard-device',deviceId:'guard-device',deviceVersion:null,authMethod:'device_bootstrap'};
  app.use('/api/*',accountSessionGuard({registry,getAuth:()=>auth}));
  app.post('/api/payments/orders',c=>c.json({ok:true}));
  app.post('/api/account/login/phone/challenge',c=>c.json({ok:true}));
  app.get('/api/account/entitlements',c=>c.json({ok:true}));
  assert.equal((await app.request('/api/payments/orders',{method:'POST'})).status,403);
  assert.equal((await app.request('/api/account/login/phone/challenge',{method:'POST'})).status,200);
  assert.equal((await app.request('/api/account/phone/bind',{method:'POST'})).status,409);
  auth=await phoneLogin('13800000111','guard-device');
  assert.equal((await app.request('/api/payments/orders',{method:'POST'})).status,200);
  const pending=await registry.startWechat(auth,'login');
  await registry.logout(auth);
  assert.equal((await registry.consumeWechat(auth,pending.state)).error,'LOGIN_STATE_INVALID');
  assert.equal((await app.request('/api/account/entitlements')).status,401);
});

test('concurrent OTP verification succeeds once and a WeChat account can explicitly add an unused phone',async()=>{
  time+=61000;
  const challenge=await otp.challenge({phone:'13800000112',deviceUserId:'concurrent',ip:'concurrent',purpose:'login'});
  const request={...challenge,deviceUserId:'concurrent',code:sent.at(-1).code,expectedPurpose:'login'};
  const results=await Promise.all([otp.verify(request),otp.verify(request)]);
  assert.equal(results.filter(value=>value.userId).length,1);
  assert.equal(results.filter(value=>value.error==='OTP_INVALID').length,1);
  const guest={userId:'wechat-first',deviceId:'wechat-first',deviceVersion:null};
  const start=await registry.startWechat(guest,'login');
  const account=await registry.finishWechat(guest,await registry.consumeWechat(guest,start.state),{appId:'wx1234567890abcdef',openid:'wechat-first-account'});
  const linked=await phoneLogin('13800000113',guest.deviceId,{purpose:'link-phone',loginUserId:account.userId,deviceVersion:account.deviceVersion});
  assert.equal(linked.userId,account.userId);
  assert.equal((await registry.status(linked.userId)).maskedPhone,'138****0113');
  assert.equal((await phoneLogin('13800000113','fresh-phone-device')).userId,account.userId);
});

test('account deletion clears login identities and device resume; re-registration cannot inherit an old ledger',async()=>{
  const account=await phoneLogin('13800000114','delete-account');
  await registry.deleteIdentity(account.userId,async()=>{usersById.get(account.userId).status='deleted';});
  assert.equal(await registry.validSession(account),false);
  assert.equal((await registry.device(account.deviceId)).userId,account.deviceId);
  assert.equal((await registry.status(account.userId)).loggedIn,false);
  const fresh=await phoneLogin('13800000114','delete-account');
  assert.notEqual(fresh.userId,account.userId);
  assert.equal((await createBillingLedger(db).entitlements(fresh.userId)).totalRemaining,0);
  assert.equal((await db.query('SELECT id FROM billing_accounts WHERE id=$1',[account.userId])).rows.length,1);
});
