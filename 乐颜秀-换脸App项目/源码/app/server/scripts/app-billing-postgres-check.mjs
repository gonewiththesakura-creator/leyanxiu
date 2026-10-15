import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Pool } from 'pg';
import { createBillingDatabase } from '../payments/database.js';
import { createBillingLedger } from '../payments/ledger.js';
import { createAccountRegistry } from '../accounts/registry.js';
import { createPaymentAccounts } from '../payments/accounts.js';

// Always creates a new loopback-only fixture cluster; never accepts a production connection URL.
const sourceBin=process.env.APP_TEST_PG_BIN;
if(!sourceBin || !fs.existsSync(path.join(sourceBin,'initdb.exe'))) throw new Error('APP_TEST_PG_BIN_REQUIRED');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'lyx-app-pg-'));
// Windows initdb needs an ASCII installation path for a UTF-8 bootstrap.
if (/[^\x00-\x7f]/.test(sourceBin)) throw new Error('APP_TEST_PG_BIN_MUST_USE_ASCII_PATH');
const bin=sourceBin;
const data=path.join(root,'data'); const log=path.join(root,'postgres.log');
const password=crypto.randomBytes(32).toString('hex');
const passwordFile=path.join(root,'init-password');fs.writeFileSync(passwordFile,password,{mode:0o600});
process.env.COMPLIANCE_BACKEND='file';process.env.COMPLIANCE_STORE_FILE=path.join(root,'identity.json');
process.env.DEPLOY_ENV='development';
const {store:users}=await import('../compliance-store.js');
const listener=net.createServer();await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
const run=(name,args)=>execFileSync(path.join(bin,`${name}.exe`),args,{cwd:root,windowsHide:true,encoding:'utf8',timeout:45000,stdio:name==='pg_ctl'?'ignore':'pipe'});
const connection=database=>({host:'127.0.0.1',port,user:'lyx_test',password,database,max:12,connectionTimeoutMillis:5000});
function copyDirectory(source,destination) {
  fs.mkdirSync(destination);
  for(const entry of fs.readdirSync(source,{withFileTypes:true})) {
    const from=path.join(source,entry.name),to=path.join(destination,entry.name);
    if(entry.isSymbolicLink()) throw new Error('UNEXPECTED_BACKUP_SYMLINK');
    if(entry.isDirectory())copyDirectory(from,to);else fs.copyFileSync(from,to);
  }
}
let running=false,db;
try {
  run('initdb',['-D',data,'-U','lyx_test','-A','scram-sha-256',`--pwfile=${passwordFile}`,'--encoding=UTF8','--locale=C']);
  fs.rmSync(passwordFile);
  const start=()=>{running=true;run('pg_ctl',['-D',data,'-l',log,'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);};
  const stop=()=>{run('pg_ctl',['-D',data,'-m','fast','-w','stop']);running=false;};
  start();
  db=createBillingDatabase(new Pool(connection('postgres')));await db.initialize();
  let clock=Date.now(),smsCode='';
  const registry=createAccountRegistry(db,{users,now:()=>clock});
  const otp=createPaymentAccounts(db,{secret:crypto.randomBytes(32).toString('hex'),now:()=>clock,sendSms:async(_phone,code)=>{smsCode=code;},resolveLogin:(...args)=>registry.phoneLogin(...args)});
  async function login(device,phone='13800000000') {
    clock+=61000;
    const challenge=await otp.challenge({phone,deviceUserId:device,purpose:'login',ip:device,loginUserId:device});
    assert.ok(challenge.challengeId);
    const result=await otp.verify({...challenge,deviceUserId:device,code:smsCode,expectedPurpose:'login'});
    assert.ok(result.userId);return result;
  }
  const account=await login('device-one');
  const secondDevice=await login('device-two');assert.equal(secondDevice.userId,account.userId);
  clock+=61000;
  const challenge=await otp.challenge({phone:'13800000000',deviceUserId:'parallel-device',purpose:'login',ip:'parallel',loginUserId:'parallel-device'});
  const concurrent=await Promise.all(Array.from({length:12},()=>otp.verify({...challenge,deviceUserId:'parallel-device',code:smsCode,expectedPurpose:'login'})));
  assert.equal(concurrent.filter(result=>result.userId===account.userId).length,1);
  assert.equal(concurrent.filter(result=>result.error==='OTP_INVALID').length,11);
  let ledger=createBillingLedger(db);
  const orders=await Promise.all(Array.from({length:16},()=>ledger.createOrder({userId:'fixture-user',channel:'android',productId:'fixture',amountFen:1000,credits:10,idempotencyKey:'fixture-order-key'})));
  assert.equal(new Set(orders.map(r=>r.order.id)).size,1); const order=orders[0].order;
  const events=await Promise.all(Array.from({length:16},()=>ledger.applyPaymentEvent({orderId:order.id,eventId:'fixture-event',status:'paid',providerTradeId:'fixture-trade'})));
  assert.equal(events.filter(r=>!r.duplicate).length,1);
  const attempts=await Promise.all(Array.from({length:40},(_,i)=>ledger.reserveCreation('fixture-user',`fixture-task-${i}`,'photo')));
  assert.equal(attempts.filter(r=>r.ok).length,10);
  const winners=attempts.flatMap((r,i)=>r.ok?[i]:[]);
  await Promise.all(winners.map((i,index)=>index<5?ledger.confirmCreation('fixture-user',`fixture-task-${i}`):ledger.refundCreation('fixture-user',`fixture-task-${i}`)));
  assert.equal((await ledger.entitlements('fixture-user')).totalRemaining,5);
  assert.equal((await ledger.reconcileEntitlements()).ok,true);
  const {order:accountOrder}=await ledger.createOrder({userId:account.userId,channel:'android',productId:'fixture',amountFen:300,credits:3,idempotencyKey:'account-order-fixture'});
  await ledger.applyPaymentEvent({orderId:accountOrder.id,eventId:'account-paid-fixture',status:'paid',providerTradeId:'account-trade-fixture'});
  assert.equal((await ledger.entitlements(secondDevice.userId)).totalRemaining,3);
  await registry.logout(account);
  assert.equal(await registry.validSession(account),false);
  assert.equal(await registry.validSession(secondDevice),true);
  const otherAccount=await login('device-one','13800000001');
  assert.notEqual(otherAccount.userId,account.userId);
  assert.equal((await ledger.entitlements(otherAccount.userId)).totalRemaining,0);
  await db.close();db=null;stop();start();
  db=createBillingDatabase(new Pool(connection('postgres')));ledger=createBillingLedger(db);
  assert.equal((await ledger.entitlements('fixture-user')).totalRemaining,5);
  const restartedRegistry=createAccountRegistry(db,{users,now:()=>clock});
  assert.equal(await restartedRegistry.validSession(account),false);
  assert.equal(await restartedRegistry.validSession(secondDevice),true);
  assert.equal((await ledger.entitlements(secondDevice.userId)).totalRemaining,3);
  const quote=await ledger.quoteRefund(order.id,'fixture-user');assert.equal(quote.amountFen,500);
  const expected=await ledger.getOrder(order.id);
  await db.close();db=null;stop();
  const restoredData=path.join(root,'restored-data');copyDirectory(data,restoredData);
  const restoredIdentity=path.join(root,'restored-identity.json');fs.copyFileSync(process.env.COMPLIANCE_STORE_FILE,restoredIdentity);
  run('pg_ctl',['-D',restoredData,'-l',path.join(root,'restored.log'),'-o',`-h 127.0.0.1 -p ${port}`,'-w','start']);
  const restored=createBillingDatabase(new Pool(connection('postgres')));
  try {
    assert.deepEqual(await createBillingLedger(restored).getOrder(order.id),expected);
    assert.equal((await createBillingLedger(restored).entitlements('fixture-user')).totalRemaining,5);
    assert.equal((await createBillingLedger(restored).reconcileEntitlements()).ok,true);
    const restoredRegistry=createAccountRegistry(restored,{users,now:()=>clock});
    assert.equal((await restoredRegistry.device('device-two')).userId,account.userId);
    assert.equal(await restoredRegistry.validSession(account),false);
    assert.equal((await createBillingLedger(restored).entitlements(account.userId)).totalRemaining,3);
    // Load the independently restored identity file in a fresh process.
    const restoredUser=execFileSync(process.execPath,['--input-type=module','-e',`import {store} from ${JSON.stringify(new URL('../compliance-store.js',import.meta.url).href)};if(!store.getUser(process.env.APP_TEST_USER))process.exit(2);console.log('identity-restored');`],{encoding:'utf8',windowsHide:true,env:{...process.env,COMPLIANCE_STORE_FILE:restoredIdentity,APP_TEST_USER:account.userId}}).trim();
    assert.equal(restoredUser,'identity-restored');
  } finally {await restored.close();run('pg_ctl',['-D',restoredData,'-m','fast','-w','stop']);}
  const report={result:'pass',testedAt:new Date().toISOString(),database:run('postgres',['--version']).trim(),checks:['16 parallel order retries','16 parallel payment events','40 concurrent reservations','12 concurrent OTP verifications consume once','same account on second device','account switch balance isolation','logout revocation survives restart','account and ledger backup restore','identity backup loaded by fresh process'],fixtureDirectory:root,productionAcceptance:false,realSms:false,realWechat:false};
  fs.writeFileSync(path.join(root,'verification-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
} finally {
  if(db) await db.close();
  if(running) run('pg_ctl',['-D',data,'-m','fast','-w','stop']);
}
