import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
import { BILLING_SCHEMA } from '../payments/database.js';
import { createBillingLedger } from '../payments/ledger.js';
import { createPaymentAccounts } from '../payments/accounts.js';
import { createAccountRegistry } from '../accounts/registry.js';
import { createAccountRetention, startAccountRetentionJob, ACCOUNT_RETENTION_INTERVAL_MS } from '../accounts/retention.js';

// Never import index/bootstrap/env or load a real configuration/data directory.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-account-retention-'));
Object.assign(process.env, { NODE_ENV: 'test', DEPLOY_ENV: 'test', COMPLIANCE_BACKEND: 'file', DATA_DIR: root, COMPLIANCE_STORE_FILE: path.join(root, 'identity.json'), CLOSED_TEST_MODE: 'false' });
const { store, resetStoreForTests, flushComplianceStore } = await import('../compliance-store.js');
const DAY = 86_400_000;
const BASE = Date.UTC(2026, 9, 9);
const secret = 'retention-test-only-secret-'.repeat(3);
test.after(async () => { await flushComplianceStore(); fs.rmSync(root, { recursive: true, force: true }); });

async function fixture(t, dailyLimit = 200) {
  resetStoreForTests();
  t.mock.timers.enable({ apis: ['Date'], now: BASE });
  let time = BASE;
  const pg = new PGlite();
  await pg.exec(BILLING_SCHEMA);
  t.after(() => pg.close());
  const keys = [];
  const db = { query: (sql, args) => pg.query(sql, args), transaction: (key, fn) => { keys.push(key); return pg.transaction(fn); } };
  const now = () => time;
  const sent = [];
  const registry = createAccountRegistry(db, { users: store, now });
  const otp = createPaymentAccounts(db, { secret, dailyLimit, now, sendSms: async (phone, code) => { sent.push({ phone, code }); }, resolveLogin: (...args) => registry.phoneLogin(...args) });
  const retention = createAccountRetention({ db, store, flush: flushComplianceStore, now });
  return { pg, db, registry, otp, retention, now, sent, keys, advance(ms) { time += ms; t.mock.timers.setTime(time); } };
}

async function seedOtp(db, id, createdAt, { consumed = false, attempts = 0, codeHash = 'a'.repeat(64) } = {}) {
  await db.query('INSERT INTO billing_otp(id,phone_hash,masked,device_user_id,purpose,code_hash,ip_hash,created_at,consumed,attempts,sent) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true)', [id, `phone-${id}`, '138****0000', `device-${id}`, 'login', codeHash, `ip-${id}`, createdAt, consumed, attempts]);
}
async function financialSnapshot(db) {
  const tables = ['billing_accounts', 'billing_orders', 'billing_events', 'billing_grants', 'billing_reservations', 'billing_refunds', 'billing_ledger', 'billing_audit', 'billing_reconciliation', 'billing_phones', 'billing_devices', 'app_login_identities'];
  return Object.fromEntries(await Promise.all(tables.map(async table => [table, (await db.query(`SELECT * FROM ${table} ORDER BY 1`)).rows])));
}

test('default dry-run changes no state; apply honors exact retention boundaries and leaves money/consents/phone indexes intact', async t => {
  const f = await fixture(t);
  const user = store.createOrGetUser({ subject: 'paid-account', channel: 'android', authMethod: 'account' });
  await f.db.query('INSERT INTO billing_accounts(id) VALUES($1)', [user.id]);
  const ledger = createBillingLedger(f.db, { now: f.now });
  const { order } = await ledger.createOrder({ userId: user.id, productId: 'pack', amountFen: 100, credits: 3, idempotencyKey: 'paid-order', channel: 'android', productSnapshot: { id: 'pack', name: 'pack', type: 'credits', amountFen: 100, credits: 3 } });
  await ledger.applyPaymentEvent({ orderId: order.id, status: 'paid', providerTradeId: 'test-trade', eventId: 'test-event' });
  await f.db.query('INSERT INTO billing_phones VALUES($1,$2,$3)', ['stable-phone-hmac', user.id, '138****0000']);
  await f.db.query('INSERT INTO billing_devices VALUES($1,$2,false)', ['legacy-financial-alias', user.id]);
  await f.db.query('INSERT INTO app_login_identities VALUES($1,$2,$3)', ['wechat-app:test', 'test-openid', user.id]);
  store.recordConsent({ userId: user.id, consentType: 'basic', version: '2026-09-05', action: 'granted' });
  f.advance(1);
  store.recordConsent({ userId: user.id, consentType: 'basic', version: '2026-09-05', action: 'withdrawn' });
  const time = f.now();
  await seedOtp(f.db, 'past-day', time - DAY - 1);
  await seedOtp(f.db, 'at-day', time - DAY);
  await seedOtp(f.db, 'at-expiry', time - 300_000);
  await seedOtp(f.db, 'still-valid', time - 299_999);
  await seedOtp(f.db, 'consumed', time, { consumed: true });
  await seedOtp(f.db, 'guess-limit', time, { attempts: 5 });
  for (const [device, account, expiry] of [['empty', null, time + DAY], ['at-device-cutoff', user.id, time - 7 * DAY], ['recently-expired', user.id, time - 7 * DAY + 1], ['active-device', user.id, time + DAY]]) await f.db.query('INSERT INTO app_login_devices VALUES($1,$2,$3,$4)', [device, account, `version-${device}`, expiry]);
  for (const [sessionId, expiry] of [['active-session', time + DAY], ['recent-expiry', time - 1], ['at-session-cutoff', time - 7 * DAY]]) store.createSession({ userId: user.id, sessionId, tokenHash: `hash-${sessionId}`, channel: 'android', expiresAt: new Date(expiry).toISOString() });
  const finances = await financialSnapshot(f.db);
  const consent = store.listConsents(user.id);
  const identityBefore = fs.readFileSync(store.file, 'utf8');
  const rowsBefore = (await f.db.query('SELECT * FROM billing_otp ORDER BY id')).rows;
  f.keys.length = 0;
  const preview = await f.retention.run();
  assert.deepEqual({ mode: preview.mode, otpRowsDeleted: preview.otpRowsDeleted, otpValuesCleared: preview.otpValuesCleared, deviceMappingsDeleted: preview.deviceMappingsDeleted, sessionsDeleted: preview.sessionsDeleted, sessionTokenHashesCleared: preview.sessionTokenHashesCleared }, { mode: 'dry-run', otpRowsDeleted: 1, otpValuesCleared: 4, deviceMappingsDeleted: 2, sessionsDeleted: 1, sessionTokenHashesCleared: 1 });
  assert.deepEqual(f.keys, []); // Even no lock-row inserts in read-only preview.
  assert.equal(fs.readFileSync(store.file, 'utf8'), identityBefore);
  assert.deepEqual((await f.db.query('SELECT * FROM billing_otp ORDER BY id')).rows, rowsBefore);
  const applied = await f.retention.run({ apply: true });
  assert.deepEqual(f.keys, ['system:sms-limit', 'system:account-binding']);
  for (const field of ['otpRowsDeleted', 'otpValuesCleared', 'deviceMappingsDeleted', 'sessionsDeleted', 'sessionTokenHashesCleared']) assert.equal(applied[field], preview[field]);
  const rows = (await f.db.query('SELECT * FROM billing_otp ORDER BY id')).rows;
  assert.equal(rows.length, 5);
  assert.equal(rows.find(row => row.id === 'still-valid').code_hash.length, 64);
  assert.ok(rows.filter(row => row.id !== 'still-valid').every(row => row.code_hash === '' && row.consumed));
  assert.deepEqual(rows.find(row => row.id === 'at-day').phone_hash, 'phone-at-day');
  assert.equal((await f.db.query('SELECT device_id FROM app_login_devices ORDER BY device_id')).rows.length, 2);
  assert.equal(store.snapshot().sessions.length, 2);
  assert.equal(store.findSession('recent-expiry'), null);
  assert.ok(store.findSession('active-session'));
  assert.deepEqual(await financialSnapshot(f.db), finances);
  assert.deepEqual(store.listConsents(user.id), consent);
  assert.equal(store.hasActiveConsent(user.id, 'basic', '2026-09-05'), false);
  assert.equal((await ledger.entitlements(user.id)).totalRemaining, 3);
  const repeated = await f.retention.run({ apply: true });
  assert.equal(repeated.otpValuesCleared + repeated.otpRowsDeleted + repeated.deviceMappingsDeleted + repeated.sessionsDeleted + repeated.sessionTokenHashesCleared, 0);
  f.advance(1);
  assert.equal((await f.retention.run({ apply: true })).otpRowsDeleted, 1);
});

test('success, failed delivery, fifth guess, logout and account deletion erase OTP values without throwing on an empty digest', async t => {
  const f = await fixture(t);
  let challenge = await f.otp.challenge({ phone: '13800000001', purpose: 'login', deviceUserId: 'device-a', ip: 'a' });
  const auth = await f.otp.verify({ ...challenge, code: f.sent.at(-1).code, deviceUserId: 'device-a' });
  assert.ok(auth.userId);
  assert.equal((await f.db.query('SELECT code_hash FROM billing_otp WHERE id=$1', [challenge.challengeId])).rows[0].code_hash, '');
  assert.equal((await f.otp.verify({ ...challenge, code: f.sent.at(-1).code, deviceUserId: 'device-a' })).error, 'OTP_INVALID');
  f.advance(61_000);
  challenge = await f.otp.challenge({ phone: '13800000002', purpose: 'login', deviceUserId: 'device-a', ip: 'a' });
  await f.registry.logout(auth);
  assert.equal((await f.db.query('SELECT code_hash FROM billing_otp WHERE id=$1', [challenge.challengeId])).rows[0].code_hash, '');
  f.advance(61_000);
  const deleting = await f.otp.challenge({ phone: '13800000001', purpose: 'login', deviceUserId: 'device-b', ip: 'b' });
  await f.registry.deleteIdentity(auth.userId, () => store.markUserDeleted(auth.userId));
  const deletedOtp = (await f.db.query('SELECT * FROM billing_otp WHERE id=$1', [deleting.challengeId])).rows[0];
  assert.equal(deletedOtp.code_hash, '');
  assert.equal(deletedOtp.masked, '');
  assert.ok(deletedOtp.phone_hash && deletedOtp.ip_hash && deletedOtp.device_user_id);
  const guesses = await f.otp.challenge({ phone: '13800000003', purpose: 'bind', deviceUserId: 'guesses', ip: 'c' });
  for (let i = 0; i < 5; i++) assert.equal((await f.otp.verify({ ...guesses, code: 'not-a-code', deviceUserId: 'guesses' })).error, 'OTP_INVALID');
  assert.equal((await f.db.query('SELECT code_hash FROM billing_otp WHERE id=$1', [guesses.challengeId])).rows[0].code_hash, '');
  await seedOtp(f.db, 'broken-empty', f.now(), { codeHash: '' });
  assert.equal((await f.otp.verify({ challengeId: 'broken-empty', code: '000000', deviceUserId: 'device-broken-empty' })).error, 'OTP_INVALID');
  const failed = createPaymentAccounts(f.db, { secret, now: f.now, sendSms: async () => { throw new Error('fixture-delivery-failure'); } });
  assert.equal((await failed.challenge({ phone: '13800000004', purpose: 'bind', deviceUserId: 'failed', ip: 'd' })).error, 'SMS_DELIVERY_UNCONFIRMED');
  assert.equal((await f.db.query('SELECT code_hash FROM billing_otp WHERE device_user_id=$1', ['failed'])).rows[0].code_hash, '');
});

test('logout, deletion and five-minute sweeps retain the phone budget for the full 24 hours', async t => {
  const f = await fixture(t);
  const phone = '13800000100';
  const first = await f.otp.challenge({ phone, purpose: 'login', deviceUserId: 'budget', ip: 'phone-ip' });
  const auth = await f.otp.verify({ ...first, code: f.sent.at(-1).code, deviceUserId: 'budget' });
  for (let i = 1; i < 5; i++) { f.advance(61_000); assert.ok((await f.otp.challenge({ phone, purpose: 'login', deviceUserId: 'budget', ip: 'phone-ip' })).challengeId); }
  await f.registry.logout(auth);
  await f.registry.deleteIdentity(auth.userId, () => store.markUserDeleted(auth.userId));
  f.advance(300_000);
  await f.retention.run({ apply: true });
  assert.equal((await f.db.query('SELECT COUNT(*) AS n FROM billing_otp')).rows[0].n, 5);
  assert.equal((await f.otp.challenge({ phone, purpose: 'login', deviceUserId: 'new-device', ip: 'new-ip' })).error, 'SMS_RATE_LIMIT');
  f.advance(DAY);
  await f.retention.run({ apply: true });
  assert.ok((await f.otp.challenge({ phone, purpose: 'login', deviceUserId: 'new-device', ip: 'new-ip' })).challengeId);
});

test('clearing expired OTP values does not reset device, IP or global budgets', async t => {
  for (const [kind, limit] of [['device', 10], ['ip', 20], ['global', 3]]) {
    await t.test(kind, async child => {
      const f = await fixture(child, kind === 'global' ? limit : 200);
      for (let i = 0; i < limit; i++) {
        assert.ok((await f.otp.challenge({ phone: `1380000${String(i).padStart(4, '0')}`, purpose: 'bind', deviceUserId: kind === 'device' ? 'shared-device' : `d-${i}`, ip: kind === 'ip' ? 'shared-ip' : `ip-${i}` })).challengeId);
        f.advance(61_000);
      }
      f.advance(300_000);
      await f.retention.run({ apply: true });
      assert.equal((await f.db.query('SELECT COUNT(*) AS n FROM billing_otp')).rows[0].n, limit);
      assert.equal((await f.otp.challenge({ phone: '13900000999', purpose: 'bind', deviceUserId: kind === 'device' ? 'shared-device' : 'fresh-device', ip: kind === 'ip' ? 'shared-ip' : 'fresh-ip' })).error, 'SMS_RATE_LIMIT');
    });
  }
});

test('old bootstrap sessions stay revoked through login/logout/cleanup and historical empty mappings are repaired', async t => {
  const f = await fixture(t);
  const guest = store.createOrGetUser({ subject: 'device-proof', channel: 'android', authMethod: 'device_key' });
  const bootstrap = { userId: guest.id, deviceId: guest.id, deviceVersion: null, authMethod: 'device_bootstrap' };
  store.createSession({ userId: guest.id, sessionId: 'old-bootstrap', tokenHash: 'old-token-hash', channel: 'android', expiresAt: new Date(f.now() + 30 * DAY).toISOString() });
  assert.ok(store.findSession('old-bootstrap'));
  const challenge = await f.otp.challenge({ phone: '13800000200', purpose: 'login', deviceUserId: guest.id, ip: 'guest', loginUserId: guest.id });
  const account = await f.otp.verify({ ...challenge, code: f.sent.at(-1).code, deviceUserId: guest.id });
  assert.equal(store.findSession('old-bootstrap'), null);
  assert.equal(await f.registry.validSession(bootstrap), false);
  await f.registry.logout(account);
  await f.retention.run({ apply: true });
  assert.equal(store.findSession('old-bootstrap'), null); // Mapping fallback cannot revive an authenticated token.
  assert.equal(await f.registry.validSession(account), false);
  const raw = JSON.parse(fs.readFileSync(store.file, 'utf8'));
  assert.equal(raw.sessions['old-bootstrap'].tokenHash, null);
  const historical = store.createOrGetUser({ subject: 'historical-device' });
  await f.db.query('INSERT INTO app_login_devices VALUES($1,NULL,$2,0)', [historical.id, 'old-cleared-version']);
  store.createSession({ userId: historical.id, sessionId: 'historical-bootstrap', tokenHash: 'historical-hash', channel: 'android', expiresAt: new Date(f.now() + 30 * DAY).toISOString() });
  await f.retention.run({ apply: true });
  assert.equal(store.findSession('historical-bootstrap'), null);
  store.createSession({ userId: historical.id, sessionId: 'new-device-proof', tokenHash: 'new-proof-hash', channel: 'android', expiresAt: new Date(f.now() + DAY).toISOString() });
  assert.ok(store.findSession('new-device-proof')); // A fresh device proof still works.
  f.advance(7 * DAY);
  await f.retention.run({ apply: true });
  assert.equal(store.snapshot().sessions.some(row => row.id === 'old-bootstrap' || row.id === 'historical-bootstrap'), false);
  assert.equal(store.findSession('old-bootstrap'), null);
});

test('revocation immediately clears hashes; revoked metadata is kept until the seven-day boundary', async t => {
  const f = await fixture(t);
  const user = store.createOrGetUser({ subject: 'revoked-sessions' });
  for (const sessionId of ['single', 'all']) store.createSession({ userId: user.id, sessionId, tokenHash: `hash-${sessionId}`, channel: 'android', expiresAt: new Date(f.now() + 30 * DAY).toISOString() });
  assert.equal(store.revokeSession('single'), true);
  assert.equal(store.revokeUserSessions(user.id), 1);
  assert.ok(Object.values(JSON.parse(fs.readFileSync(store.file, 'utf8')).sessions).every(row => row.tokenHash === null));
  f.advance(7 * DAY - 1);
  assert.equal((await f.retention.run({ apply: true })).sessionsDeleted, 0);
  f.advance(1);
  assert.equal((await f.retention.run({ apply: true })).sessionsDeleted, 2);
  assert.equal(store.findSession('single'), null);
});

test('five-minute scheduler runs with no requests, defaults to preview, supports explicit apply and reports stale/failed jobs', async t => {
  const f = await fixture(t);
  await seedOtp(f.db, 'scheduled-expired', f.now() - 300_000);
  let tick, interval, cleared = false;
  const timer = { unref() {} };
  const options = { setIntervalImpl(fn, ms) { tick = fn; interval = ms; return timer; }, clearIntervalImpl(value) { assert.equal(value, timer); cleared = true; } };
  const preview = startAccountRetentionJob(f.retention, options);
  assert.equal((await preview.ready).mode, 'dry-run');
  assert.equal(interval, ACCOUNT_RETENTION_INTERVAL_MS);
  f.advance(ACCOUNT_RETENTION_INTERVAL_MS);
  assert.equal((await tick()).mode, 'dry-run');
  assert.equal((await f.db.query('SELECT code_hash FROM billing_otp WHERE id=$1', ['scheduled-expired'])).rows[0].code_hash.length, 64);
  await preview.stop();
  assert.equal(cleared, true);
  assert.equal(await tick(), null);
  const apply = startAccountRetentionJob(f.retention, { ...options, apply: true });
  assert.equal((await apply.ready).otpValuesCleared, 1);
  await seedOtp(f.db, 'offline-no-requests', f.now());
  f.advance(ACCOUNT_RETENTION_INTERVAL_MS);
  assert.equal((await tick()).otpValuesCleared, 1);
  assert.equal(f.sent.length, 0);
  await apply.stop();
  f.advance(2 * ACCOUNT_RETENTION_INTERVAL_MS + 1);
  assert.equal(apply.status().overdue, true);
  assert.equal(apply.status().stopped, true);
  const failing = createAccountRetention({ db: { query: async () => { throw new Error('private-db-connection-string'); }, transaction: f.db.transaction }, store, now: f.now });
  const failedJob = startAccountRetentionJob(failing, { ...options, onError: async () => { throw new Error('notification-down'); } });
  assert.equal(await failedJob.ready, null);
  assert.equal(await tick(), null);
  assert.equal(failedJob.status().running, false);
  assert.equal(failedJob.status().lastError.code, 'ACCOUNT_RETENTION_FAILED');
  assert.equal(failedJob.status().lastNotificationError.code, 'ACCOUNT_RETENTION_NOTIFICATION_FAILED');
  assert.equal(JSON.stringify(failedJob.status()).includes('private-db-connection-string'), false);
  await failedJob.stop();
  const observer = startAccountRetentionJob(f.retention, { ...options, onResult: async () => { throw new Error('result-observer-down'); } });
  await observer.ready;
  assert.equal(observer.status().lastNotificationError.code, 'ACCOUNT_RETENTION_NOTIFICATION_FAILED');
  assert.equal((await tick()), null);
  await observer.stop();
});

test('failed session persistence keeps historical device markers for retry; PG/session partial progress is idempotent', async t => {
  const f = await fixture(t);
  const guest = store.createOrGetUser({ subject: 'failed-flush-guest' });
  store.createSession({ userId: guest.id, sessionId: 'failed-flush-token', tokenHash: 'hash', channel: 'android', expiresAt: new Date(f.now() + DAY).toISOString() });
  await f.db.query('INSERT INTO app_login_devices VALUES($1,NULL,$2,0)', [guest.id, 'cleared']);
  await seedOtp(f.db, 'old-on-partial-failure', f.now() - DAY - 1);
  const failure = createAccountRetention({ db: f.db, store, now: f.now, flush: async () => { throw new Error('private-persistence-path'); } });
  await assert.rejects(failure.run({ apply: true }), { code: 'ACCOUNT_RETENTION_FAILED' });
  assert.equal((await f.db.query('SELECT COUNT(*) AS n FROM billing_otp')).rows[0].n, 0);
  assert.equal((await f.db.query('SELECT COUNT(*) AS n FROM app_login_devices')).rows[0].n, 1);
  assert.equal(store.findSession('failed-flush-token'), null);
  assert.equal(failure.status().lastAppliedAt, null);
  assert.equal(failure.status().running, false);
  assert.equal(JSON.stringify(failure.status()).includes('private-persistence-path'), false);
  assert.equal((await f.retention.run({ apply: true })).deviceMappingsDeleted, 1);
});

test('concurrent runs are rejected without corrupting status and malformed options fail closed', async t => {
  const f = await fixture(t);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const blocked = createAccountRetention({ db: { ...f.db, async query(...args) { await gate; return f.db.query(...args); } }, store, now: f.now });
  const first = blocked.run();
  assert.equal(blocked.status().running, true);
  await assert.rejects(blocked.run({ apply: true }), { code: 'ACCOUNT_RETENTION_RUNNING' });
  release();
  assert.equal((await first).mode, 'dry-run');
  assert.equal(blocked.status().running, false);
  await assert.rejects(blocked.run({ apply: 'true' }), { code: 'ACCOUNT_RETENTION_OPTIONS_INVALID' });
  assert.throws(() => store.retainAccountSessions({ now: NaN, apply: true }), /ACCOUNT_RETENTION_OPTIONS_INVALID/);
});

async function child(code, env) {
  return new Promise((resolve, reject) => {
    const processEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: root, TMP: root, NODE_ENV: 'test', DEPLOY_ENV: 'test', ...env };
    const worker = spawn(process.execPath, ['--input-type=module', '-e', code], { env: processEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    worker.stdout.on('data', data => { output += data; });
    worker.stderr.on('data', data => { output += data; });
    worker.on('error', reject);
    worker.on('exit', code => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}

test('SQLite preview leaves the snapshot byte-for-byte unchanged; cleanup and revocation survive a real process restart', async () => {
  const sqliteDir = fs.mkdtempSync(path.join(root, 'sqlite-'));
  const filename = path.join(sqliteDir, 'identity.db');
  const env = { DATA_DIR: sqliteDir, COMPLIANCE_BACKEND: 'sqlite', COMPLIANCE_SQLITE_FILE: filename };
  const url = new URL('../compliance-store.js', import.meta.url).href;
  await child(`
    import assert from 'node:assert/strict';
    import Database from 'better-sqlite3';
    const {store}=await import(${JSON.stringify(url)});
    const time=Date.now();
    const user=store.createOrGetUser({subject:'sqlite-retention'});
    store.recordConsent({userId:user.id,consentType:'basic',version:'v1',action:'withdrawn'});
    store.createSession({userId:user.id,sessionId:'sqlite-expired',tokenHash:'old',channel:'android',expiresAt:new Date(time-7*86400000).toISOString()});
    store.createSession({userId:user.id,sessionId:'sqlite-revoked',tokenHash:'revoked',channel:'android',expiresAt:new Date(time+30*86400000).toISOString()});
    store.createSession({userId:user.id,sessionId:'sqlite-active',tokenHash:'active',channel:'android',expiresAt:new Date(time+30*86400000).toISOString()});
    store.revokeSession('sqlite-revoked');
    const db=new Database(${JSON.stringify(filename)},{readonly:true});
    const read=()=>db.prepare('SELECT payload FROM compliance_snapshot WHERE id=1').get().payload;
    const before=read();
    assert.equal(JSON.parse(before).sessions['sqlite-revoked'].tokenHash,null);
    assert.equal(store.retainAccountSessions({now:time}).sessionsDeleted,1);
    assert.equal(read(),before);
    store.retainAccountSessions({now:time,apply:true});
    const after=JSON.parse(read());
    const prior=JSON.parse(before);
    for(const key of Object.keys(prior).filter(key=>key!=='sessions')) assert.deepEqual(after[key],prior[key]);
    assert.equal(after.sessions['sqlite-expired'],undefined);
    assert.equal(store.findSession('sqlite-revoked'),null);
    db.close();
  `, env);
  await child(`
    import assert from 'node:assert/strict';
    const {store}=await import(${JSON.stringify(url)});
    assert.equal(store.findSession('sqlite-expired'),null);
    assert.equal(store.findSession('sqlite-revoked'),null);
    const active=store.findSession('sqlite-active');
    assert.ok(active);
    assert.equal(store.hasActiveConsent(active.user.id,'basic','v1'),false);
  `, env);
});
