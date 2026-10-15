import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { PGlite } from '@electric-sql/pglite';
import { BILLING_SCHEMA } from '../payments/database.js';
import { createBillingLedger } from '../payments/ledger.js';
import { createPaymentAccounts } from '../payments/accounts.js';
import { createAccountRegistry } from '../accounts/registry.js';
import { openAccountDeletionJournal } from '../deploy/account-deletion-journal.mjs';
import { captureAccountRestoreBaseline, checkAccountRestore } from '../deploy/account-restore-guard.mjs';
import { runRestoreCheckCli } from '../scripts/check-app-account-restore.mjs';

const storeUrl = new URL('../compliance-store.js', import.meta.url).href;
const journalUrl = new URL('../deploy/account-deletion-journal.mjs', import.meta.url).href;
// Windows cannot prove POSIX ownership/mode bits. Only that check is adapted;
// every database below is real SQLite or PGlite, never a synthetic DB adapter.
const verifyPath = process.platform === 'win32' ? filename => {
  if (fs.existsSync(filename)) assert.ok(fs.lstatSync(filename).isFile() && !fs.lstatSync(filename).isSymbolicLink());
} : undefined;
const userId = () => `usr_${crypto.randomUUID()}`;
function temporary(t, beforeRemove = async () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-restore-guard-'));
  fs.chmodSync(root, 0o700);
  t.after(async () => { await beforeRemove(); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function openJournal(file, options = {}) { return openAccountDeletionJournal({ file, verifyPath, ...options }); }
function storeAction(file, code) {
  return execFileSync(process.execPath, ['--input-type=module', '-e', `import assert from 'node:assert/strict'; const {store,flushComplianceStore}=await import(${JSON.stringify(storeUrl)}); ${code}; await flushComplianceStore();`], {
    windowsHide: true, encoding: 'utf8', env: { ...process.env, DEPLOY_ENV: 'test', NODE_ENV: 'test', COMPLIANCE_BACKEND: 'sqlite', COMPLIANCE_SQLITE_FILE: file, DATA_DIR: path.dirname(file), COMPLIANCE_STORE_FILE: path.join(path.dirname(file), 'unused.json') },
  }).trim();
}

test('journal persists minimal deletion intents, duplicate requests are idempotent, and closed writes fail safely', t => {
  const root = temporary(t), file = path.join(root, 'journal.db');
  let time = Date.now();
  let journal = openJournal(file, { now: () => time });
  const id = userId();
  const first = journal.recordDeletion(id);
  assert.deepEqual(first, { ok: true, sequence: 1, alreadyRecorded: false });
  assert.deepEqual(journal.recordDeletion(id), { ok: true, sequence: 1, alreadyRecorded: true });
  const checkpoint = journal.checkpoint();
  assert.equal(JSON.stringify(checkpoint).includes(id), false);
  journal.close();
  assert.throws(() => journal.recordDeletion(userId()), { message: 'DELETION_JOURNAL_UNAVAILABLE' });
  journal = openJournal(file, { readOnly: true, now: () => time });
  assert.deepEqual(journal.readVerified(checkpoint).entries, [{ sequence: 1, accountId: id, deletedAt: time }]);
  assert.throws(() => journal.recordDeletion(userId()), { message: 'DELETION_JOURNAL_READ_ONLY' });
  journal.close();
  const sqlite = new Database(file, { readonly: true });
  assert.deepEqual(sqlite.prepare('PRAGMA table_info(deletion_events)').all().map(row => row.name), ['sequence', 'account_id', 'deleted_at']);
  sqlite.close();
});

test('an old journal copy cannot validate against the independent latest checkpoint; stale or missing checkpoints fail', t => {
  const root = temporary(t), file = path.join(root, 'journal.db'), old = path.join(root, 'old.db');
  let time = Date.now();
  const journal = openJournal(file, { now: () => time });
  journal.recordDeletion(userId());
  const earlier = journal.checkpoint();
  fs.copyFileSync(file, old); fs.chmodSync(old, 0o600);
  time += 1; journal.recordDeletion(userId());
  const current = journal.checkpoint();
  const stale = openJournal(old, { readOnly: true, now: () => time });
  assert.throws(() => stale.readVerified(current), { message: 'DELETION_JOURNAL_CHECKPOINT_MISMATCH' });
  assert.throws(() => journal.readVerified(earlier), { message: 'DELETION_JOURNAL_CHECKPOINT_MISMATCH' });
  assert.throws(() => journal.readVerified(), { message: 'DELETION_JOURNAL_CHECKPOINT_MISMATCH' });
  time += 300_001;
  assert.throws(() => journal.readVerified(current), { message: 'DELETION_JOURNAL_CHECKPOINT_MISMATCH' });
  assert.equal(journal.health().healthy, true); // A bad caller checkpoint is not disk failure.
  stale.close(); journal.close();
});

test('separate processes serialize journal commits without losing distinct or repeated account IDs', async t => {
  const root = temporary(t), file = path.join(root, 'journal.db');
  openJournal(file).close();
  const repeated = userId(), other = userId();
  const ids = [repeated, other, repeated];
  await Promise.all(ids.map(id => new Promise((resolve, reject) => {
    const code = `import {openAccountDeletionJournal} from ${JSON.stringify(journalUrl)}; const j=openAccountDeletionJournal({file:${JSON.stringify(file)},${process.platform === 'win32' ? 'verifyPath:()=>{},' : ''}});j.recordDeletion(${JSON.stringify(id)});j.close();`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => reject(new Error('FIXTURE_PROCESS_FAILED')));
    child.once('exit', exit => exit === 0 ? resolve() : reject(new Error('FIXTURE_PROCESS_FAILED')));
  })));
  const journal = openJournal(file);
  const checkpoint = journal.checkpoint();
  assert.equal(checkpoint.sequence, 2);
  assert.equal(new Set(journal.readVerified(checkpoint).entries.map(row => row.accountId)).size, 2);
  journal.close();
});

test('I/O rejection and invalid identifiers expose fixed errors, never original input', t => {
  const root = temporary(t), file = path.join(root, 'journal.db');
  assert.throws(() => openAccountDeletionJournal({ file, verifyPath() { throw new Error('fixture-secret-phone-token'); } }), { message: 'DELETION_JOURNAL_UNAVAILABLE' });
  const journal = openJournal(file);
  assert.throws(() => journal.recordDeletion({ toString() { throw new Error('fixture-secret'); } }), { message: 'DELETION_JOURNAL_ACCOUNT_INVALID' });
  assert.throws(() => journal.recordDeletion('13800000000'), { message: 'DELETION_JOURNAL_ACCOUNT_INVALID' });
  assert.equal(journal.checkpoint().sequence, 0);
  journal.close();
});

test('CLI defaults to no I/O and rejects mutation flags', async t => {
  t.mock.method(fs, 'readFileSync', () => { throw new Error('PLAN_MUST_NOT_READ'); });
  assert.deepEqual(await runRestoreCheckCli([]), { version: 1, code: 'RESTORE_CHECK_PLAN_ONLY', mode: 'dry-run', readsConfiguration: false, readsDatabase: false, reopenAllowed: false });
  await assert.rejects(runRestoreCheckCli(['--apply']), { message: 'RESTORE_CHECK_INPUT_INVALID' });
});

test('POSIX permissions reject public files and links without repairing them', { skip: process.platform === 'win32' }, t => {
  const root = temporary(t), file = path.join(root, 'journal.db');
  openJournal(file).close();
  fs.chmodSync(file, 0o644);
  assert.throws(() => openJournal(file), { message: 'DELETION_JOURNAL_UNAVAILABLE' });
  assert.equal(fs.statSync(file).mode & 0o777, 0o644);
  fs.chmodSync(file, 0o600);
  const link = path.join(root, 'linked.db'); fs.symlinkSync(file, link);
  assert.throws(() => openJournal(link), { message: 'DELETION_JOURNAL_UNAVAILABLE' });
});

test('real old PGlite dump and SQLite backup are rejected, existing registry/store replay restores deletion safety without changing money or budgets', async t => {
  let journal, live, restored;
  const root = temporary(t, async () => {
    journal?.close();
    if (live && !live.closed) await live.close();
    if (restored && !restored.closed) await restored.close();
  });
  const sourceRoot = path.join(root, 'source'), restoreRoot = path.join(root, 'restore'), privateRoot = path.join(root, 'independent');
  for (const dir of [sourceRoot, restoreRoot, privateRoot]) fs.mkdirSync(dir, { mode: 0o700 });
  let time = Date.now();
  journal = openJournal(path.join(privateRoot, 'deletions.db'), { now: () => time });
  const sourceFile = path.join(sourceRoot, 'identity.db'), identityFile = path.join(restoreRoot, 'identity.db');
  const ids = JSON.parse(storeAction(sourceFile, `
    const account=store.createOrGetUser({subject:'fixture-account',channel:'android',authMethod:'account'});
    const guest=store.createOrGetUser({subject:'fixture-device',channel:'android',authMethod:'device'});
    for(const user of [account,guest])store.createSession({userId:user.id,sessionId:'session-'+user.id,tokenHash:'fixture-only-hash',expiresAt:'2099-01-01'});
    store.createAuthChallenge({challengeId:'fixture-challenge',publicKeySpki:'fixture-key',challengeDigest:'fixture-digest',expiresAt:'2099-01-01'});
    store.recordConsent({userId:account.id,consentType:'basic',version:'v1',action:'granted'});
    store.recordConsent({userId:account.id,consentType:'basic',version:'v1',action:'withdrawn'});
    console.log(JSON.stringify({account:account.id,guest:guest.id}));
  `));
  live = new PGlite();
  await live.exec(BILLING_SCHEMA);
  const liveDb = { query: (...args) => live.query(...args), transaction: (_key, fn) => live.transaction(fn) };
  await live.query('INSERT INTO billing_accounts(id) VALUES($1)', [ids.account]);
  const { order } = await createBillingLedger(liveDb).createOrder({ userId: ids.account, productId: 'fixture-pack', amountFen: 100, credits: 3, idempotencyKey: 'fixture-order', channel: 'android', productSnapshot: { id: 'fixture-pack', name: 'Fixture pack', type: 'credits', amountFen: 100, credits: 3 } });
  await createBillingLedger(liveDb).applyPaymentEvent({ orderId: order.id, status: 'paid', eventId: 'fixture-payment', providerTradeId: 'fixture-trade' });
  await live.query('INSERT INTO billing_phones VALUES($1,$2,$3)', ['fixture-phone-hash', ids.account, 'fixture-masked']);
  await live.query('INSERT INTO app_login_devices VALUES($1,$2,$3,$4)', [ids.guest, ids.account, 'fixture-version', time + 100_000]);
  await live.query('INSERT INTO billing_devices VALUES($1,$2,false)', [ids.guest, ids.account]);
  await live.query('INSERT INTO app_login_identities VALUES($1,$2,$3)', ['wechat-app:fixture', 'fixture-subject', ids.account]);
  await live.query('INSERT INTO app_login_challenges VALUES($1,$2,$3,$4,$5,false)', ['fixture-state', ids.guest, ids.account, 'login', time + 100_000]);
  await live.query('INSERT INTO billing_otp(id,phone_hash,masked,device_user_id,purpose,code_hash,ip_hash,created_at,attempts,sent,login_user_id,device_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,2,true,$9,$10)', ['fixture-otp', 'fixture-phone-hash', 'fixture-masked', ids.guest, 'login', 'fixture-otp-hash', 'fixture-ip-hash', time, ids.account, 'fixture-version']);
  const dump = await live.dumpDataDir();
  const sourceIdentity = new Database(sourceFile, { readonly: true });
  await sourceIdentity.backup(identityFile); sourceIdentity.close();
  const backupTakenAt = time;
  time += 1000; journal.recordDeletion(ids.account);
  storeAction(sourceFile, `store.markUserDeleted(${JSON.stringify(ids.account)});assert.equal(store.getUser(${JSON.stringify(ids.account)}),null);`);
  await live.close();
  restored = new PGlite({ loadDataDir: dump });
  const db = { query: (...args) => restored.query(...args), transaction: (_key, fn) => restored.transaction(fn) };
  const baseline = await captureAccountRestoreBaseline({ db, identityFile, restoreRoot });
  const options = { db, identityFile, restoreRoot, journal, trustedCheckpoint: journal.checkpoint(), backupTakenAt, baseline };
  const bytesBefore = fs.readFileSync(identityFile);
  const otpBefore = (await db.query('SELECT * FROM billing_otp')).rows;
  const denied = await checkAccountRestore(options);
  assert.equal(denied.code, 'RESTORE_REPLAY_REQUIRED');
  assert.equal(denied.counts.resurrectedUsers, 1);
  assert.equal(denied.counts.usableOtp, 1);
  assert.equal(denied.counts.usableSessions, 2);
  assert.deepEqual(fs.readFileSync(identityFile), bytesBefore);
  assert.deepEqual((await db.query('SELECT * FROM billing_otp')).rows, otpBefore);
  assert.equal((await checkAccountRestore({ ...options, journal: null })).code, 'RESTORE_INDEPENDENT_JOURNAL_REQUIRED');
  assert.equal((await checkAccountRestore({ ...options, backupTakenAt: options.trustedCheckpoint.coverageStartedAt - 1 })).code, 'RESTORE_JOURNAL_COVERAGE_MISSING');
  assert.equal((await checkAccountRestore({ ...options, journal: { ...journal, file: path.join(restoreRoot, 'fake.db') } })).code, 'RESTORE_JOURNAL_NOT_INDEPENDENT');
  const registry = createAccountRegistry(db, { users: {}, now: () => time });
  await registry.deleteIdentity(ids.account, () => storeAction(identityFile, `store.markUserDeleted(${JSON.stringify(ids.account)});`));
  assert.equal((await checkAccountRestore(options)).code, 'RESTORE_REPLAY_REQUIRED'); // Guest session/challenge must also be revoked.
  storeAction(identityFile, `
    for(const user of store.snapshot().users)store.revokeUserSessions(user.id,'restore');
    assert.equal(store.consumeAuthChallenge({challengeId:'fixture-challenge',publicKeySpki:'fixture-key',challengeDigest:'fixture-digest'}).ok,true);
    assert.equal(store.getUser(${JSON.stringify(ids.account)}),null);
    assert.equal(store.findSession('session-'+${JSON.stringify(ids.account)}),null);
    assert.equal(store.hasActiveConsent(${JSON.stringify(ids.account)},'basic','v1'),false);
  `);
  await db.query("UPDATE billing_otp SET consumed=true,code_hash='' ");
  await db.query('UPDATE app_login_challenges SET consumed=true');
  await db.query("UPDATE app_login_devices SET user_id=NULL,version='fixture-restore-version',expires_at=0");
  await db.query('UPDATE billing_devices SET disabled=true');
  const passed = await checkAccountRestore(options);
  assert.equal(passed.code, 'RESTORE_DELETION_GATE_PASSED');
  assert.equal(passed.ok, true);
  assert.equal(passed.reopenAllowed, false);
  assert.ok(Object.values(passed.preserved).every(Boolean));
  assert.equal((await createBillingLedger(db).entitlements(ids.account)).totalRemaining, 3);
  const otp = createPaymentAccounts(db, { secret: 'fixture-only-secret'.repeat(3), sendSms: () => { throw new Error('SMS_MUST_NOT_RUN'); } });
  assert.equal((await otp.verify({ challengeId: 'fixture-otp', code: 'fixture-code', deviceUserId: ids.guest })).error, 'OTP_INVALID');
  assert.equal(JSON.stringify(passed).includes(ids.account), false);
  await db.query('UPDATE billing_otp SET attempts=0');
  assert.equal((await checkAccountRestore(options)).code, 'RESTORE_PRESERVED_DATA_CHANGED');
  await db.query('CREATE TABLE unexpected_credentials(secret TEXT)');
  assert.equal((await checkAccountRestore(options)).code, 'RESTORE_CHECK_FAILED');
});
