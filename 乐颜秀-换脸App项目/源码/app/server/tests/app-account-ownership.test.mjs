import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const filename = fileURLToPath(import.meta.url);
const childFixture = process.argv[2] === '--ownership-fixture';

if (!childFixture) {
  test('signed App account/paid-plan ownership scenarios use isolated PGlite and SQLite', async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-account-ownership-'));
    // A child owns SQLite's native handle. Wait for its exit before deleting the
    // fixture; never rely on ignoring EPERM while a database is still open.
    const env = Object.fromEntries(['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'PATHEXT']
      .filter(key => process.env[key]).map(key => [key, process.env[key]]));
    let output = '';
    let exited = false;
    const child = spawn(process.execPath, [filename, '--ownership-fixture', root], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { output += bytes; });
    const timeout = setTimeout(() => child.kill(), 120_000);
    const completion = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => { exited = true; resolve({ code, signal }); });
    });
    t.after(async () => {
      clearTimeout(timeout);
      if (!exited) { child.kill(); await completion; }
      fs.rmSync(root, { recursive: true, force: true });
    });
    const result = await completion;
    clearTimeout(timeout);
    assert.equal(result.code, 0, output);
    assert.equal(result.signal, null, output);
    assert.match(output, /# fail 0\b/, output);
    assert.match(output, /# tests 7\b/, output);
  });
} else {
  test('HTTP device proof, phone login and paid ownership with SQLite persistence and PGlite', async t => {
    const root = process.argv[3];
    assert.ok(path.isAbsolute(root) && path.dirname(root) === path.resolve(os.tmpdir())
      && path.basename(root).startsWith('lyx-account-ownership-'));
    assert.equal(fs.readdirSync(root).length, 0);
    let time = Date.UTC(2026, 9, 9);
    t.mock.timers.enable({ apis: ['Date'], now: time });
    const advance = (amount = 61_000) => { time += amount; t.mock.timers.setTime(time); };
    Object.assign(process.env, {
      DOTENV_CONFIG_PATH: path.join(root, 'does-not-exist.env'), START_SERVER: 'false', NODE_ENV: 'test', DEPLOY_ENV: 'test',
      APP_ACCOUNT_ONLY: 'true', APP_ACCOUNT_OPERATIONS_ENABLED: 'false', APP_LOGIN_ENABLED: 'true', XPAY_MODE: 'disabled',
      BILLING_BACKEND: 'postgres', BILLING_DATABASE_URL: 'postgres://isolated:isolated@127.0.0.1:1/test',
      PROVIDER: 'mock', ALLOW_MOCK_PROVIDER: 'true', AUTH_MODE: 'device_key', RELEASE_CHANNEL: 'android-app',
      ACCOUNT_OTP_SECRET: 'isolated-account-ownership-secret-not-a-real-credential', SMS_PROVIDER: 'unset',
      PAYMENT_MODE: 'closed_test', CLOSED_TEST_MODE: 'true', CLOSED_TEST_CREDITS: '0', CLOSED_TEST_REQUIRE_INVITE: 'true',
      CLOSED_TEST_INVITE_SECRET: 'isolated-ownership-invite', AUTH_SESSION_SECRET: 'isolated-ownership-session-secret-not-a-real-credential',
      OBJECT_SIGNING_SECRET: 'isolated-ownership-object-secret-not-a-real-credential', BASIC_CONSENT_VERSION: '2026-10-09-account',
      TASKS_BACKEND: 'file', TASKS_FILE: path.join(root, 'tasks.json'), DATA_DIR: root,
      COMPLIANCE_BACKEND: 'sqlite', COMPLIANCE_SQLITE_FILE: path.join(root, 'identity.sqlite'), COMPLIANCE_STORE_FILE: path.join(root, 'unused.json'),
      OBJECT_STORAGE_BACKEND: 'file', PRIVATE_OBJECT_DIR: path.join(root, 'objects'), OBJECT_INDEX_FILE: path.join(root, 'objects', 'index.json'),
      ADMIN_DATA_DIR: root, ADMIN_STORE_FILE: path.join(root, 'admin.json'), ADMIN_WORKFLOW_DATA_DIR: root,
      ADMIN_WORKFLOW_STORE_FILE: path.join(root, 'workflows.json'), ADMIN_SNAPSHOT_BACKEND: 'local', METRICS_BACKEND: 'memory',
      SECURITY_LOG_PATH: path.join(root, 'security.jsonl'), METRICS_LOG_PATH: path.join(root, 'metrics.jsonl'),
      REPAIR_WORK_DIR: path.join(root, 'repair'), FFMPEG_PATH: path.join(root, 'execution-forbidden-ffmpeg'),
    });
    let externalRequests = 0;
    const forbidNetwork = () => { externalRequests++; throw new Error('EXTERNAL_NETWORK_FORBIDDEN_IN_ACCOUNT_FIXTURE'); };
    globalThis.fetch = forbidNetwork;
    const [{ default: http }, { default: https }, { default: net }, { Pool }, { PGlite }, { Hono }, { BILLING_SCHEMA }] = await Promise.all([
      import('node:http'), import('node:https'), import('node:net'), import('pg'), import('@electric-sql/pglite'), import('hono'), import('../payments/database.js'),
    ]);
    http.request = http.get = https.request = https.get = net.connect = net.createConnection = forbidNetwork;
    const pg = new PGlite(); await pg.exec(BILLING_SCHEMA);
    Pool.prototype.query = function (sql, args) { return pg.query(sql, args); };
    Pool.prototype.connect = async function () { return { query: (sql, args) => pg.query(sql, args), release() {} }; };
    t.after(() => pg.close());

    const { app } = await import('../index.js');
    const { billingDatabase, billingStore, accountRegistry } = await import('../payments/runtime.js');
    const { store, resetStoreForTests, flushComplianceStore } = await import('../compliance-store.js');
    const { getAuth, requireAuth, createSessionForUser, authenticateToken } = await import('../auth.js');
    const { createPaymentAccounts } = await import('../payments/accounts.js');
    const { registerAppAccountRoutes } = await import('../accounts/routes.js');
    const { accountSessionGuard } = await import('../accounts/middleware.js');
    const { registerPaymentRoutes } = await import('../payments/routes.js');
    const { toWechatOrderId, fromWechatOrderId } = await import('../payments/wechat.js');

    const sent = [];
    const otp = createPaymentAccounts(billingDatabase, { secret: process.env.ACCOUNT_OTP_SECRET,
      sendSms: async (phone, code) => sent.push({ phone, code }), resolveLogin: (...args) => accountRegistry.phoneLogin(...args) });
    const phoneApp = new Hono();
    phoneApp.use('*', accountSessionGuard({ registry: accountRegistry, getAuth, accountOnly: true }));
    registerAppAccountRoutes(phoneApp, { registry: accountRegistry, otp, authenticated: requireAuth,
      sessionForUser: createSessionForUser, flush: flushComplianceStore, users: store, clientAddress: () => '127.0.0.1',
      smsReady: () => true, wechatReady: () => false, rateLimit: () => true, appId: () => '', wechatExchange: forbidNetwork });

    // Production payment routes/ledger, with only the external gateway replaced.
    // This fixture intentionally exercises future account-owned orders outside
    // account-only middleware; the imported production app remains closed.
    const product = { id: 'isolation_pack', name: 'isolated pack', amountFen: 100, credits: 5, type: 'credits' };
    const gatewayCalls = [];
    const adapter = {
      createAppOrder: async input => { gatewayCalls.push({ kind: 'prepay', orderId: input.orderId }); return { prepayid: 'isolated-prepay' }; },
      queryOrder: async orderId => { gatewayCalls.push({ kind: 'query', orderId }); return {
        out_trade_no: toWechatOrderId(orderId), trade_state: 'SUCCESS', transaction_id: `isolated-trade-${orderId}`,
        amount: { total: product.amountFen, currency: 'CNY' }, success_time: new Date(time).toISOString(),
      }; },
      validateTransaction: (transaction, expected) => {
        assert.equal(fromWechatOrderId(transaction.out_trade_no), expected.orderId);
        assert.equal(transaction.amount.total, expected.amountCents);
        assert.equal(transaction.trade_state, 'SUCCESS');
      },
      closeOrder: async orderId => { gatewayCalls.push({ kind: 'close', orderId }); },
    };
    const paymentApp = new Hono();
    paymentApp.use('*', accountSessionGuard({ registry: accountRegistry, getAuth, accountOnly: false }));
    registerPaymentRoutes(paymentApp, { store: billingStore, authenticated: requireAuth,
      requireAdmin: c => ({ response: c.json({ code: 'FORBIDDEN' }, 403) }), adapter: () => adapter,
      readiness: async () => ({ ready: true }), operationsReadiness: async () => ({ ready: true }), products: async () => [product],
      flush: flushComplianceStore, orderIdFromTrade: fromWechatOrderId, accountReady: async id => (await accountRegistry.status(id)).loggedIn });

    const request = async (target, route, session, body, method = body === undefined ? 'GET' : 'POST') => {
      const response = await target.request(route, { method, headers: { 'Content-Type': 'application/json',
        'X-Closed-Test-Invite': process.env.CLOSED_TEST_INVITE_SECRET, ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: response.status, ...(await response.json()) };
    };
    const accepted = async (...args) => { const response = await request(...args); assert.equal(response.status, 200, response.code); assert.equal(response.code, 0); return response.data; };
    const bootstrap = async (pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })) => {
      advance();
      const publicKeySpki = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
      const challenge = await accepted(app, '/api/auth/device/challenge', null, { algorithm: 'ES256', publicKeySpki });
      const signature = crypto.sign('sha256', Buffer.from(challenge.challenge), pair.privateKey).toString('base64url');
      const session = await accepted(app, '/api/auth/device/verify', null, { ...challenge, algorithm: 'ES256', publicKeySpki, signature });
      return { pair, ...session };
    };
    const challenge = async (device, phone, extra = {}) => {
      advance();
      const result = await accepted(phoneApp, '/api/account/login/phone/challenge', device, { phone, termsVersion: 'account-v1', ...extra });
      assert.equal(sent.at(-1).phone, phone);
      assert.equal(JSON.stringify(result).includes(sent.at(-1).code), false);
      return { ...result, code: sent.at(-1).code };
    };
    const verify = (device, pending, extra = {}) => request(phoneApp, '/api/account/login/phone/verify', device, { ...pending, termsVersion: 'account-v1', ...extra });
    const login = async (device, phone) => {
      const response = await verify(device, await challenge(device, phone));
      assert.equal(response.status, 200, response.code); assert.equal(response.code, 0);
      return { pair: device.pair, ...response.data };
    };
    const purchase = async (session, key = crypto.randomUUID(), extra = {}) => {
      const created = await accepted(paymentApp, '/api/orders', session, { productId: product.id, channel: 'android', idempotencyKey: key, ...extra });
      const paid = await accepted(paymentApp, `/api/orders/${created.order.id}`, session);
      assert.equal(paid.status, 'paid');
      return paid;
    };
    const assertUnauthorized = async (target, route, session, body) => {
      const result = await request(target, route, session, body);
      assert.equal(result.status, 401, route); assert.equal(result.code, 'AUTH_REQUIRED');
    };
    const entitlement = session => accepted(app, '/api/account/entitlements', session);
    const moneySnapshot = async () => Object.fromEntries(await Promise.all([
      'billing_accounts', 'billing_orders', 'billing_events', 'billing_grants', 'billing_reservations', 'billing_refunds', 'billing_ledger',
    ].map(async table => [table, (await pg.query(`SELECT * FROM ${table} ORDER BY 1`)).rows])));
    const reset = async () => {
      await flushComplianceStore();
      await pg.exec('TRUNCATE billing_accounts,billing_instance,billing_catalog,billing_audit,billing_reconciliation,billing_otp,app_login_devices,app_login_identities,app_login_challenges CASCADE');
      resetStoreForTests(); sent.length = 0; gatewayCalls.length = 0; advance();
    };

    await t.test('same phone on a new device resumes the same account and original order/grant', async () => {
      await reset();
      const oldGuest = await bootstrap();
      const first = await login(oldGuest, '13800000201');
      await assertUnauthorized(app, '/api/auth/me', oldGuest);
      const order = await purchase(first);
      const original = await moneySnapshot();
      const freshGuest = await bootstrap();
      assert.notEqual(freshGuest.user.id, oldGuest.user.id);
      const second = await login(freshGuest, '13800000201');
      assert.equal(second.user.id, first.user.id);
      assert.notEqual(authenticateToken(second.token).deviceId, authenticateToken(first.token).deviceId);
      assert.deepEqual(await moneySnapshot(), original, 'login does not rewrite financial ownership');
      assert.equal((await entitlement(first)).totalRemaining, 5);
      assert.equal((await entitlement(second)).grants[0].orderId, order.id);
      assert.deepEqual((await accepted(paymentApp, '/api/orders', second)).map(item => item.id), [order.id]);
      const resumed = await bootstrap(first.pair);
      assert.equal(resumed.user.id, first.user.id);
      assert.equal((await accepted(app, '/api/auth/me', resumed)).authMethod, 'account-device');
      assert.equal((await entitlement(resumed)).totalRemaining, 5);
      assert.equal((await request(app, '/api/orders', first, {})).code, 'APP_ACCOUNT_ONLY');
    });

    await t.test('different phones cannot link or read/mutate another account by injecting identity fields', async () => {
      await reset();
      const a = await login(await bootstrap(), '13800000202');
      const b = await login(await bootstrap(), '13800000203');
      const aOrder = await purchase(a);
      const bOrder = await purchase(b, crypto.randomUUID(), { userId: a.user.id, amountFen: 1, credits: 999 });
      assert.equal(bOrder.userId, b.user.id); assert.equal(bOrder.amountFen, product.amountFen);
      const original = await moneySnapshot();
      const aAuth = authenticateToken(a.token);
      const pending = await challenge(a, '13800000203', { purpose: 'link-phone', userId: b.user.id,
        loginUserId: b.user.id, deviceId: authenticateToken(b.token).deviceId, deviceVersion: authenticateToken(b.token).deviceVersion });
      const rejected = await verify(a, pending, { userId: b.user.id, deviceUserId: authenticateToken(b.token).deviceId });
      assert.equal(rejected.code, 'ACCOUNT_LINK_CONFLICT');
      assert.equal(await accountRegistry.validSession(aAuth), true);
      assert.equal((await accepted(phoneApp, '/api/account/login-status', a)).maskedPhone, '138****0202');
      assert.equal((await accepted(phoneApp, '/api/account/login-status', b)).maskedPhone, '138****0203');
      assert.deepEqual(await moneySnapshot(), original);
      const calls = gatewayCalls.length;
      for (const [suffix, body] of [['', undefined], ['/close', { userId: a.user.id }], ['/refund-quote', undefined], ['/refund', { expectedAmountFen: 100, userId: a.user.id }]]) {
        const result = await request(paymentApp, `/api/orders/${aOrder.id}${suffix}`, b, body);
        assert.equal([404, 409].includes(result.status), true, suffix);
        assert.equal(['NOT_FOUND', 'ORDER_NOT_FOUND'].includes(result.code), true, suffix);
      }
      assert.equal(gatewayCalls.length, calls, 'unauthorized order operations never contact even the mock gateway');
      assert.deepEqual((await accepted(paymentApp, `/api/orders?userId=${a.user.id}`, b)).map(item => item.id), [bOrder.id]);
      assert.equal((await accepted(app, `/api/account/entitlements?userId=${a.user.id}`, b)).grants[0].orderId, bOrder.id);
      const [tokenBody, signature] = b.token.split('.');
      const payload = JSON.parse(Buffer.from(tokenBody, 'base64url'));
      payload.sub = a.user.id; payload.deviceId = aAuth.deviceId; payload.deviceVersion = aAuth.deviceVersion;
      await assertUnauthorized(paymentApp, '/api/orders', { token: `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${signature}` });
      assert.deepEqual(await moneySnapshot(), original);
    });

    await t.test('cross-device OTP replay fails; switching phones revokes the old mapping without moving assets', async () => {
      await reset();
      const a = await login(await bootstrap(), '13800000204');
      const aOther = await login(await bootstrap(), '13800000204');
      const b = await login(await bootstrap(), '13800000205');
      const aOrder = await purchase(a); const bOrder = await purchase(b);
      const original = await moneySnapshot();
      const pending = await challenge(a, '13800000205');
      const replay = await verify(aOther, pending);
      assert.equal(replay.code, 'OTP_INVALID');
      const switched = await verify(a, pending, { userId: a.user.id });
      assert.equal(switched.status, 200); assert.equal(switched.data.user.id, b.user.id);
      await assertUnauthorized(app, '/api/auth/me', a);
      await assertUnauthorized(paymentApp, '/api/orders', a);
      assert.equal((await entitlement(aOther)).grants[0].orderId, aOrder.id);
      assert.equal((await entitlement(switched.data)).grants[0].orderId, bOrder.id);
      const resumed = await bootstrap(a.pair);
      assert.equal(resumed.user.id, b.user.id);
      assert.deepEqual(await moneySnapshot(), original);
      assert.equal((await verify(switched.data, pending)).code, 'OTP_INVALID');
    });

    await t.test('logout-all invalidates every old device/token/authorization while a different account stays valid', async () => {
      await reset();
      const a = await login(await bootstrap(), '13800000206');
      const aOther = await login(await bootstrap(), '13800000206');
      const b = await login(await bootstrap(), '13800000207');
      const order = await purchase(a);
      const original = await moneySnapshot();
      const unrelatedPending = await challenge(b, '13800000207');
      const mappedPending = await challenge(aOther, '13800000206');
      const unbound = await bootstrap();
      const unboundPending = await challenge(unbound, '13800000206');
      const otpCount = Number((await pg.query('SELECT COUNT(*) AS n FROM billing_otp')).rows[0].n);
      await accepted(phoneApp, '/api/account/login/logout', a, { all: true, userId: b.user.id });
      const codes = (await pg.query('SELECT id,consumed,code_hash FROM billing_otp WHERE id=ANY($1::text[])',
        [[mappedPending.challengeId, unboundPending.challengeId, unrelatedPending.challengeId]])).rows;
      for (const id of [mappedPending.challengeId, unboundPending.challengeId]) {
        assert.equal(codes.find(row => row.id === id).consumed, true);
        assert.equal(codes.find(row => row.id === id).code_hash, '');
      }
      assert.equal(codes.find(row => row.id === unrelatedPending.challengeId).consumed, false);
      assert.match(codes.find(row => row.id === unrelatedPending.challengeId).code_hash, /^[0-9a-f]{64}$/);
      assert.equal((await request(phoneApp, '/api/account/login/phone/challenge', unbound, { phone: '13800000206', termsVersion: 'account-v1' })).code, 'SMS_RATE_LIMIT');
      await assertUnauthorized(app, '/api/auth/me', a);
      await assertUnauthorized(app, '/api/account/entitlements', aOther);
      assert.equal((await accepted(app, '/api/auth/me', b)).user.id, b.user.id);
      const aFresh = await bootstrap(a.pair); const otherFresh = await bootstrap(aOther.pair);
      for (const fresh of [aFresh, otherFresh]) {
        assert.equal((await accepted(app, '/api/auth/me', fresh)).authMethod, 'device_bootstrap');
        assert.equal((await entitlement(fresh)).totalRemaining, 0);
      }
      assert.equal((await verify(otherFresh, mappedPending)).code, 'OTP_INVALID');
      assert.equal((await verify(unbound, unboundPending)).code, 'OTP_INVALID', 'logout-all also consumes pre-existing login authorization on an unbound device');
      assert.equal(Number((await pg.query('SELECT COUNT(*) AS n FROM billing_otp')).rows[0].n), otpCount, 'revocation keeps SMS anti-abuse counters');
      assert.deepEqual(await moneySnapshot(), original);
      const recovered = await login(aFresh, '13800000206');
      assert.equal(recovered.user.id, a.user.id, 'fresh phone verification can intentionally re-login after logout');
      assert.equal((await entitlement(recovered)).grants[0].orderId, order.id);
      await assertUnauthorized(app, '/api/auth/me', a);
    });

    await t.test('account deletion rejects old credentials; same-phone registration is new and cannot inherit retained money', async () => {
      await reset();
      const a = await login(await bootstrap(), '13800000208');
      const aOther = await login(await bootstrap(), '13800000208');
      const b = await login(await bootstrap(), '13800000209');
      const order = await purchase(a);
      const original = await moneySnapshot();
      const unbound = await bootstrap(); const pending = await challenge(unbound, '13800000208');
      const deleted = await request(app, '/api/account', a, { userId: b.user.id }, 'DELETE');
      assert.equal(deleted.status, 200); assert.equal(deleted.code, 0);
      await assertUnauthorized(app, '/api/auth/me', a);
      await assertUnauthorized(paymentApp, `/api/orders/${order.id}`, aOther);
      assert.equal(store.getUser(a.user.id), null);
      assert.equal((await verify(unbound, pending)).code, 'OTP_INVALID');
      assert.equal((await accepted(app, '/api/auth/me', b)).user.id, b.user.id);
      const resumed = await bootstrap(aOther.pair);
      assert.equal((await accepted(app, '/api/auth/me', resumed)).authMethod, 'device_bootstrap');
      assert.equal((await entitlement(resumed)).totalRemaining, 0);
      const fresh = await login(resumed, '13800000208');
      assert.notEqual(fresh.user.id, a.user.id);
      assert.equal((await entitlement(fresh)).totalRemaining, 0);
      assert.deepEqual(await accepted(paymentApp, '/api/orders', fresh), []);
      assert.equal((await request(paymentApp, `/api/orders/${order.id}`, fresh)).status, 404);
      const after = await moneySnapshot();
      for (const table of Object.keys(original).filter(name => name !== 'billing_accounts')) assert.deepEqual(after[table], original[table], table);
      assert.deepEqual(after.billing_accounts.filter(row => original.billing_accounts.some(before => before.id === row.id)), original.billing_accounts);
      assert.equal((await pg.query('SELECT user_id FROM billing_orders WHERE id=$1', [order.id])).rows[0].user_id, a.user.id);
      await assertUnauthorized(app, '/api/auth/me', aOther);
    });

    await t.test('fixture persisted real signed/revoked sessions in SQLite and made zero external calls', async () => {
      await flushComplianceStore();
      const { default: Database } = await import('better-sqlite3');
      const inspection = new Database(path.join(root, 'identity.sqlite'), { readonly: true });
      try {
        const state = JSON.parse(inspection.prepare('SELECT payload FROM compliance_snapshot WHERE id=1').get().payload);
        assert.ok(Object.values(state.sessions).some(session => session.revokedAt && session.tokenHash === null));
        assert.ok(Object.values(state.sessions).some(session => !session.revokedAt && session.tokenHash?.length === 64));
        assert.ok(Object.values(state.users).some(user => user.status === 'deleted'));
      } finally { inspection.close(); }
      assert.equal(externalRequests, 0);
    });
    await flushComplianceStore();
  });
}
