import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createMiniIdentity, miniIdentitySchema, miniAuthTtlMs } from '../payments/virtual/mini-identity.js';

const appId = 'wx-mini-identity-test';
const sessionKey = Buffer.alloc(16, 7).toString('base64');
async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-mini-identity-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'identity.sqlite'), migrate: true });
  for (const sql of miniIdentitySchema('sqlite')) await database.transaction(q => q(sql));
  let at = 1_800_000_000_000;
  const ledger = createVirtualLedger({ database, encryptionKey: '7'.repeat(64), now: () => at });
  await ledger.bindEnvironment(appId, 1);
  const options = { database, appId, bindSession: input => ledger.bindSession(input), now: () => at };
  return { database, ledger, options, identity: createMiniIdentity(options), now: () => at,
    advance: ms => { at += ms; },
    async close() { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

test('new and returning logins retain one ledger identity without persisting bearer plaintext', async t => {
  const f = await fixture(); t.after(() => f.close());
  const first = await f.identity.createLogin({ openid: 'verified-openid-a', sessionKey });
  const second = await f.identity.createLogin({ openid: 'verified-openid-a', sessionKey });
  assert.equal(second.user.id, first.user.id);
  assert.notEqual(second.token, first.token);
  assert.equal(Date.parse(first.expiresAt) - f.now(), miniAuthTtlMs);
  assert.equal((await f.identity.authenticateBearer(`Bearer ${second.token}`)).userId, first.user.id);
  const rows = await f.database.transaction(q => q('SELECT * FROM vp_auth_sessions'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].token_hash, crypto.createHash('sha256').update(first.token).digest('hex'));
  assert.equal(JSON.stringify(rows).includes(first.token), false);
  assert.equal(JSON.stringify(rows).includes(sessionKey), false);
  // A later WeChat login rotates the payment key, while its older bearer may
  // still read orders. It must refresh login before creating another payment.
  const old = await f.identity.authenticateBearer(`Bearer ${first.token}`);
  assert.ok(old);
  await assert.rejects(f.ledger.sessionKey(old.userId, old.sessionId), /XPAY_LOGIN_REFRESH_REQUIRED/);
});

test('an existing vp_accounts mapping is reused exactly, including its legacy user id', async t => {
  const f = await fixture(); t.after(() => f.close());
  await f.ledger.bindSession({ userId: 'existing-ledger-user', sessionId: 'existing-payment-session', appId, openid: 'verified-existing-openid', sessionKey });
  const login = await f.identity.createLogin({ openid: 'verified-existing-openid', sessionKey });
  assert.equal(login.user.id, 'existing-ledger-user');
  const accounts = await f.database.transaction(q => q('SELECT user_id FROM vp_accounts WHERE app_id = ? AND openid = ?', [appId, 'verified-existing-openid']));
  assert.deepEqual(accounts, [{ user_id: 'existing-ledger-user' }]);
});

test('session revocation is immediately visible to another identity instance and is idempotent', async t => {
  const f = await fixture(); t.after(() => f.close());
  const other = createMiniIdentity(f.options);
  const login = await f.identity.createLogin({ openid: 'verified-openid-a', sessionKey });
  const authorization = `Bearer ${login.token}`;
  assert.ok(await other.authenticateBearer(authorization));
  assert.equal(await f.identity.logout(authorization), true);
  assert.equal(await other.authenticateBearer(authorization), null);
  assert.equal(await other.logout(authorization), false);
});

test('bearer identity expires at the fixed deadline and cannot cross AppID boundaries', async t => {
  const f = await fixture(); t.after(() => f.close());
  const login = await f.identity.createLogin({ openid: 'verified-openid-a', sessionKey });
  const authorization = `Bearer ${login.token}`;
  assert.equal(await createMiniIdentity({ ...f.options, appId: 'wx-another-app' }).authenticateBearer(authorization), null);
  f.advance(miniAuthTtlMs - 1);
  assert.ok(await f.identity.authenticateBearer(authorization));
  f.advance(1);
  assert.equal(await f.identity.authenticateBearer(authorization), null);
  assert.equal(await f.identity.logout(authorization), false);
});

test('a failed payment-key binding never issues an authenticated session; retry retains the identity', async t => {
  const f = await fixture(); t.after(() => f.close());
  const failing = createMiniIdentity({ ...f.options, bindSession: async () => { throw new Error('XPAY_DATABASE_UNAVAILABLE'); } });
  await assert.rejects(failing.createLogin({ openid: 'verified-openid-a', sessionKey }), /XPAY_DATABASE_UNAVAILABLE/);
  const retained = await f.database.transaction(q => q('SELECT user_id FROM vp_accounts'));
  assert.equal(retained.length, 1);
  assert.deepEqual(await f.database.transaction(q => q('SELECT id FROM vp_auth_sessions')), []);
  const retry = await f.identity.createLogin({ openid: 'verified-openid-a', sessionKey });
  assert.equal(retry.user.id, retained[0].user_id);
});

test('durable user registration must finish before payment-key rotation or bearer issuance', async t => {
  const f = await fixture(); t.after(() => f.close());
  let bound = false;
  const failing = createMiniIdentity({ ...f.options,
    ensureUser: async () => { throw new Error('COMPLIANCE_PERSISTENCE_UNAVAILABLE'); },
    bindSession: async input => { bound = true; await f.ledger.bindSession(input); } });
  await assert.rejects(failing.createLogin({ openid: 'verified-openid-a', sessionKey }), /COMPLIANCE_PERSISTENCE_UNAVAILABLE/);
  assert.equal(bound, false);
  assert.deepEqual(await f.database.transaction(q => q('SELECT id FROM vp_auth_sessions')), []);
  assert.deepEqual(await f.database.transaction(q => q('SELECT id FROM vp_sessions')), []);
  const mapping = (await f.database.transaction(q => q('SELECT user_id FROM vp_accounts')))[0];
  const ordered = [];
  const retry = createMiniIdentity({ ...f.options,
    ensureUser: async registered => { assert.equal(registered.userId, mapping.user_id); ordered.push('registered-and-flushed'); },
    bindSession: async input => { ordered.push('payment-key-bound'); await f.ledger.bindSession(input); } });
  assert.equal((await retry.createLogin({ openid: 'verified-openid-a', sessionKey })).user.id, mapping.user_id);
  assert.deepEqual(ordered, ['registered-and-flushed', 'payment-key-bound']);
});

test('inactive users cannot authenticate or acquire new sessions and all sessions can be revoked durably', async t => {
  const f = await fixture(); t.after(() => f.close());
  let active = true;
  const identity = createMiniIdentity({ ...f.options, userAvailable: async () => active });
  const first = await identity.createLogin({ openid: 'verified-openid-a', sessionKey });
  const second = await identity.createLogin({ openid: 'verified-openid-a', sessionKey });
  active = false;
  assert.equal(await identity.authenticateBearer(`Bearer ${first.token}`), null);
  await assert.rejects(identity.createLogin({ openid: 'verified-openid-a', sessionKey }), /XPAY_ACCOUNT_UNAVAILABLE/);
  assert.equal((await f.database.transaction(q => q('SELECT id FROM vp_auth_sessions'))).length, 2);
  assert.equal(await identity.revokeUserSessions(first.user.id), 2);
  assert.equal(await identity.revokeUserSessions(first.user.id), 0);
  active = true;
  assert.equal(await f.identity.authenticateBearer(`Bearer ${first.token}`), null);
  assert.equal(await f.identity.authenticateBearer(`Bearer ${second.token}`), null);
});

test('a bind callback that did not persist a payment key cannot return a valid login token', async t => {
  const f = await fixture(); t.after(() => f.close());
  const missing = createMiniIdentity({ ...f.options, bindSession: async () => {} });
  await assert.rejects(missing.createLogin({ openid: 'verified-openid-a', sessionKey }), /XPAY_LOGIN_SUPERSEDED/);
  assert.deepEqual(await f.database.transaction(q => q('SELECT id FROM vp_auth_sessions')), []);
});

test('a simultaneous replacement login prevents the superseded login from issuing a bearer', async t => {
  const f = await fixture(); t.after(() => f.close());
  let entered;
  const firstBound = new Promise(resolve => { entered = resolve; });
  let resume;
  const releaseFirst = new Promise(resolve => { resume = resolve; });
  const first = createMiniIdentity({ ...f.options, bindSession: async input => {
    await f.ledger.bindSession(input); entered(); await releaseFirst;
  } });
  const pending = first.createLogin({ openid: 'verified-openid-a', sessionKey });
  await firstBound;
  const replacement = await f.identity.createLogin({ openid: 'verified-openid-a', sessionKey });
  resume();
  await assert.rejects(pending, /XPAY_LOGIN_SUPERSEDED/);
  const sessions = await f.database.transaction(q => q('SELECT user_id FROM vp_auth_sessions'));
  assert.deepEqual(sessions, [{ user_id: replacement.user.id }]);
});

test('a concurrent MySQL unique insert resolves the winner and does not allocate a second identity', async t => {
  const f = await fixture(); t.after(() => f.close());
  let raced = false;
  const racingDatabase = {
    backend: 'mysql',
    async transaction(callback) {
      try {
        return await f.database.transaction(q => callback(async (sql, args) => {
          if (!raced && sql.startsWith('INSERT INTO vp_accounts')) {
            raced = true;
            const error = new Error('duplicate account'); error.errno = 1062; throw error;
          }
          return q(sql.replaceAll(' FOR UPDATE', ''), args);
        }));
      } catch (error) {
        if (error.errno === 1062) {
          await f.database.transaction(q => q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', ['concurrent-winner', appId, 'verified-racing-openid']));
        }
        throw error;
      }
    },
  };
  const identity = createMiniIdentity({ ...f.options, database: racingDatabase });
  const login = await identity.createLogin({ openid: 'verified-racing-openid', sessionKey });
  assert.equal(login.user.id, 'concurrent-winner');
  assert.equal((await f.database.transaction(q => q('SELECT user_id FROM vp_accounts'))).length, 1);
});

test('the deployable migration adds the same auth table without changing existing payment tables', () => {
  const sql = fs.readFileSync(new URL('../deploy/mini-payment/mini-identity-schema-v1.sql', import.meta.url), 'utf8');
  const statements = sql.replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
  assert.equal(statements[0], 'USE `leyanxiu_xpay_sandbox`');
  assert.match(statements[1], /AS target_verified/);
  const ddl = statements.filter(value => /^CREATE TABLE/i.test(value));
  assert.equal(ddl.length, 1);
  assert.match(ddl[0], /^CREATE TABLE IF NOT EXISTS leyanxiu_xpay_sandbox\.vp_auth_sessions/);
  assert.match(ddl[0], /REFERENCES leyanxiu_xpay_sandbox\.vp_accounts/);
  const deployed = ddl[0].replaceAll('leyanxiu_xpay_sandbox.', '').replace(/\s+/g, ' ');
  const generated = miniIdentitySchema('mysql')[0].replace(/\s+/g, ' ');
  assert.equal(deployed, generated);
  assert.equal(statements.every(value => /^(USE|SELECT|CREATE TABLE|SHOW CREATE TABLE)\b/i.test(value)), true);
  assert.equal(statements.some(value => /\b(ALTER|DROP|TRUNCATE|UPDATE|INSERT INTO)\b/i.test(value)), false);
  assert.ok(statements.some(value => /^SHOW CREATE TABLE leyanxiu_xpay_sandbox\.vp_auth_sessions$/.test(value)));
  assert.ok(statements.some(value => value.includes('information_schema.CHECK_CONSTRAINTS')));
});

test('sandbox binding checks every existing business table and never replaces a binding', () => {
  const sql = fs.readFileSync(new URL('../deploy/mini-payment/builtin-sandbox-bind.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '');
  const insert = sql.split(';').map(value => value.trim()).find(value => /^INSERT/i.test(value));
  assert.match(insert, /^INSERT INTO leyanxiu_xpay_sandbox\.vp_environment\(id, app_id, env\)/);
  assert.match(insert, /WHERE DATABASE\(\) = 'leyanxiu_xpay_sandbox'/);
  for (const table of ['vp_environment', 'vp_accounts', 'vp_orders', 'vp_sessions', 'vp_auth_sessions', 'vp_buckets',
    'vp_reservations', 'vp_refunds', 'vp_events', 'vp_outbox', 'vp_audit', 'vp_reconciliation']) {
    assert.ok(insert.includes(`NOT EXISTS (SELECT 1 FROM leyanxiu_xpay_sandbox.${table})`), table);
  }
  assert.equal(/\b(UPDATE|DELETE|REPLACE|TRUNCATE|DROP|ALTER)\b/i.test(sql), false);
});

test('malformed bearer and unverified login material cannot create an authentication session', async t => {
  const f = await fixture(); t.after(() => f.close());
  for (const value of [null, '', 'Basic abc', `Bearer ${'x'.repeat(42)}`, `Bearer ${'x'.repeat(43)}`, `Bearer ${'x'.repeat(44)}`, `Bearer ${'x'.repeat(43)} extra`]) {
    assert.equal(await f.identity.authenticateBearer(value), null);
    assert.equal(await f.identity.logout(value), false);
  }
  await assert.rejects(f.identity.createLogin({ openid: '', sessionKey }), /XPAY_IDENTITY_INVALID/);
  await assert.rejects(f.identity.createLogin({ openid: 'untrusted-shape', sessionKey: 'not-a-WeChat-key' }), /XPAY_IDENTITY_INVALID/);
  assert.deepEqual(await f.database.transaction(q => q('SELECT user_id FROM vp_accounts')), []);
});
