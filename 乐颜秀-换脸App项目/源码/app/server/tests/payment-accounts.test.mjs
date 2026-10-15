import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { BILLING_SCHEMA } from '../payments/database.js';
import { createPaymentAccounts } from '../payments/accounts.js';
import { createSmsSender } from '../payments/sms.js';
const pg=new PGlite(); await pg.exec(BILLING_SCHEMA);
const db={query:(s,a)=>pg.query(s,a),transaction:(id,fn)=>pg.transaction(fn)};
let time=Date.now(); const sent=[];
const accounts=createPaymentAccounts(db,{secret:'test-only-secret-'.repeat(3),now:()=>time,sendSms:async(phone,code)=>{sent.push({phone,code});}});
test.after(()=>pg.close());
test('official SMS client initializes without sending a message',()=> {
  const sender=createSmsSender({SMS_PROVIDER:'aliyun',SMS_ACCESS_KEY_ID:'test',SMS_ACCESS_KEY_SECRET:'test',SMS_SIGN_NAME:'test',SMS_TEMPLATE_CODE:'test',ACCOUNT_OTP_SECRET:'x'.repeat(32)});
  assert.equal(typeof sender,'function');
});
test('verified binding restores original account on a new device without exposing phone or OTP',async()=>{
  const challenge=await accounts.challenge({phone:'13800000001',purpose:'bind',deviceUserId:'original',ip:'ip1'});
  assert.equal(JSON.stringify(challenge).includes(sent[0].code),false);
  assert.equal((await accounts.verify({...challenge,code:sent[0].code,deviceUserId:'intruder'})).error,'OTP_INVALID');
  assert.equal((await accounts.verify({...challenge,code:sent[0].code,deviceUserId:'original'})).userId,'original');
  assert.deepEqual(await accounts.status('original'),{bound:true,maskedPhone:'138****0001'});
  assert.equal((await accounts.verify({...challenge,code:sent[0].code,deviceUserId:'original'})).error,'OTP_INVALID');
  time+=61000;
  const recovery=await accounts.challenge({phone:'13800000001',purpose:'recover',deviceUserId:'new-device',ip:'ip2'});
  assert.equal((await accounts.verify({...recovery,code:sent.at(-1).code,deviceUserId:'new-device'})).userId,'original');
  assert.equal(await accounts.deviceAccount('new-device'),'original');
  const raw=JSON.stringify((await pg.query('SELECT * FROM billing_otp')).rows);
  assert.equal(raw.includes('13800000001'),false);
});
test('guess limits and expiration persist in database and sending is throttled',async()=>{
  const challenge=await accounts.challenge({phone:'13800000002',purpose:'bind',deviceUserId:'guesses',ip:'ip3'});
  assert.equal((await accounts.challenge({phone:'13800000003',purpose:'bind',deviceUserId:'guesses',ip:'ip3'})).error,'SMS_RATE_LIMIT');
  for(let i=0;i<5;i++) assert.equal((await accounts.verify({...challenge,code:'bad',deviceUserId:'guesses'})).error,'OTP_INVALID');
  assert.equal((await accounts.verify({...challenge,code:sent.at(-1).code,deviceUserId:'guesses'})).error,'OTP_INVALID');
  time+=61000;
  const expires=await accounts.challenge({phone:'13800000002',purpose:'bind',deviceUserId:'guesses',ip:'ip3'});
  time+=300000;
  assert.equal((await accounts.verify({...expires,code:sent.at(-1).code,deviceUserId:'guesses'})).error,'OTP_INVALID');
});
test('delivery failure invalidates code and a bound phone cannot be claimed by another account',async()=>{
  const failed=createPaymentAccounts(db,{secret:'test-only-secret-'.repeat(3),now:()=>time,sendSms:async()=>{throw new Error('timeout');}});
  assert.equal((await failed.challenge({phone:'13800000004',purpose:'bind',deviceUserId:'failed',ip:'ip4'})).error,'SMS_DELIVERY_UNCONFIRMED');
  const conflict=await accounts.challenge({phone:'13800000001',purpose:'bind',deviceUserId:'conflict',ip:'ip5'});
  assert.equal((await accounts.verify({...conflict,code:sent.at(-1).code,deviceUserId:'conflict'})).error,'PHONE_BINDING_CONFLICT');
});
