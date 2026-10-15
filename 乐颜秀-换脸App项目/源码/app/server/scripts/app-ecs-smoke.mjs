// Run on the App ECS only. No SMS, payment or model requests.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import dotenv from 'dotenv';
const env=dotenv.parse(fs.readFileSync('/etc/leyanxiu-app-account/server.env'));
const proofFile='/etc/leyanxiu-app-account/smoke-device.json';
const https=process.argv.includes('--https');
const base=https?'https://REDACTED_COMPANY_INFRASTRUCTURE':'http://127.0.0.1:3300';
const repeat=process.argv.includes('--restart');
const call=async(route,body,token)=>{
  const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(10000)});
  return {status:response.status,body:await response.json()};
};
try {
  assert.equal((await call('/health')).status,200);
  if(https) {
    for(const route of ['/api/internal/reconciliation','/api/admin/dashboard','/api/ops/metrics','/admin','/.env']) {
      assert.equal((await fetch(base+route,{signal:AbortSignal.timeout(10000)})).status,404);
    }
    const cors=await fetch(base+'/api/account/login-status',{method:'OPTIONS',headers:{Origin:'https://localhost','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization'},signal:AbortSignal.timeout(10000)});
    assert.equal(cors.headers.get('access-control-allow-origin'),'https://localhost');
  }
  const ready=await call('/api/readiness');assert.equal(ready.status,200);
  assert.equal(ready.body.data?.publicLaunchAllowed??ready.body.publicLaunchAllowed,false);
  assert.equal((await call('/api/auth/session',{clientId:'app-ecs-smoke'})).status,403);
  assert.equal((await call('/api/auth/device/challenge',{algorithm:'ES256'})).status,403);
  let pair,previous;
  if(repeat){previous=JSON.parse(fs.readFileSync(proofFile));pair={privateKey:crypto.createPrivateKey(previous.privateKey),publicKey:crypto.createPublicKey(previous.privateKey)};}
  else pair=crypto.generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const publicKeySpki=pair.publicKey.export({format:'der',type:'spki'}).toString('base64url');
  const c=await call('/api/auth/device/challenge',{algorithm:'ES256',publicKeySpki,inviteCode:env.CLOSED_TEST_INVITE_SECRET});assert.equal(c.status,200);
  const proof={...c.body.data,publicKeySpki,signature:crypto.sign('sha256',Buffer.from(c.body.data.challenge),pair.privateKey).toString('base64url'),inviteCode:env.CLOSED_TEST_INVITE_SECRET};
  const verified=await call('/api/auth/device/verify',proof);assert.equal(verified.status,200);
  assert.equal((await call('/api/auth/device/verify',proof)).status,409);
  const session=verified.body.data;
  const status=await call('/api/account/login-status',undefined,session.token);assert.equal(status.status,200);
  assert.equal(status.body.data.loginEnabled,true);assert.equal(status.body.data.loggedIn,false);
  assert.equal(status.body.data.available,false);assert.equal(status.body.data.wechatAvailable,false);
  assert.equal((await call('/api/account/entitlements',undefined,session.token)).body.data.totalRemaining,0);
  assert.equal((await call('/api/orders',{productId:'no-sale'},session.token)).body.code,'LOGIN_REQUIRED');
  assert.equal((await call('/api/account/login/phone/challenge',{phone:'13800000000',termsVersion:'account-v1'},session.token)).body.code,'LOGIN_NOT_CONFIGURED');
  assert.equal((await call('/api/account/login/wechat/start',{termsVersion:'account-v1'},session.token)).body.code,'WECHAT_NOT_READY');
  const products=await call('/api/products');assert.equal(products.body.data.available,false);assert.equal(products.body.data.mode,'closed_test');
  if(repeat)assert.equal(session.user.id,previous.userId);
  else fs.writeFileSync(proofFile,JSON.stringify({userId:session.user.id,privateKey:pair.privateKey.export({format:'pem',type:'pkcs8'})}),{flag:'wx',mode:0o600});
  console.log(JSON.stringify({result:'pass',https,restart:repeat,health:true,publicLaunchAllowed:false,anonymousRejected:true,inviteRequired:true,deviceP256Verified:true,replayRejected:true,accountApiConnected:true,smsClosed:true,wechatClosed:true,salesClosed:true,startingBalance:0,stableDeviceAfterRestart:repeat,realLogin:false,realPayment:false}));
}catch(e){console.error(JSON.stringify({result:'fail',type:e.name,code:e.code||'SMOKE_FAILED'}));process.exitCode=1;}
