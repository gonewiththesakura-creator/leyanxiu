import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { builtinSandboxMysql, builtinProductionMysql, privateSandboxTransport, privateProductionTransport,
  createPrivateProductionMysqlTarget } from '../payments/virtual/mysql-transport.js';
import { paySignature } from '../payments/virtual/wechat.js';
import { draftProducts } from '../payments/virtual/products.js';

const target = createPrivateProductionMysqlTarget({ database: builtinProductionMysql.database,
  user: 'lyx_xpay_fixture', accountHost: '%' });
const productionOptions = { allowCloudrunPrivateProduction: true, productionTarget: target };
const config = { XPAY_ENABLED: 'true', RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', DEPLOY_ENV: 'production',
  XPAY_DB_BACKEND: 'mysql', XPAY_SQLITE_FILE: '', XPAY_MYSQL_TRANSPORT: privateProductionTransport,
  XPAY_MYSQL_HOST: target.host, XPAY_MYSQL_PORT: String(target.port), XPAY_MYSQL_USER: target.user,
  XPAY_MYSQL_PASSWORD: 'synthetic-database-password', XPAY_MYSQL_DATABASE: target.database, XPAY_MYSQL_CA_FILE: '',
  XPAY_MYSQL_INSTANCE_ID: target.instanceId, XPAY_CLOUD_ENV_ID: target.cloudEnvId, WECHAT_APP_ID: target.appId,
  WECHAT_APP_SECRET: 'synthetic-app-secret', XPAY_ENV: '0', XPAY_MODE: 'closed', XPAY_OFFER_ID: 'synthetic-offer',
  XPAY_APP_KEY: 'synthetic-production-key', XPAY_SANDBOX_APP_KEY: 'synthetic-sandbox-key',
  XPAY_SESSION_ENCRYPTION_KEY: '9'.repeat(64), XPAY_MESSAGE_TOKEN: 'synthetic-message-token',
  XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 9).toString('base64').slice(0, -1), XPAY_PRODUCTS_JSON: '[]',
  XPAY_PURPOSE_RULES_JSON: '{}', XPAY_TEST_USER_IDS: '', XPAY_ACCEPTANCE_FILE: '', XPAY_ACCEPTANCE_SHA256: '' };
const sandboxConfig = { ...config, XPAY_MYSQL_TRANSPORT: privateSandboxTransport, XPAY_ENV: '1',
  XPAY_MYSQL_DATABASE: builtinSandboxMysql.database, XPAY_MYSQL_USER: builtinSandboxMysql.user };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };

// Real runtime, transport, ledger and adapter modules; only the database opener
// is replaced through Node's module-loader API. No live MySQL/provider is used.
async function fixture(t, { env = config, gate, connection, binding } = {}) {
  const previous = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => { for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  } });
  const state = { opened: 0, closed: 0, queries: [], network: 0, openOptions: [],
    connection: connection || { db: env.XPAY_MYSQL_DATABASE, account: `${env.XPAY_MYSQL_USER}@%` },
    binding: binding || [{ id: 1, app_id: env.WECHAT_APP_ID, env: Number(env.XPAY_ENV) }] };
  const fetch = globalThis.fetch;
  globalThis.fetch = async () => { state.network++; throw new Error('TEST_NETWORK_FORBIDDEN'); };
  t.after(() => { globalThis.fetch = fetch; assert.equal(state.network, 0); });
  const database = { backend: 'mysql', close: async () => { state.closed++; },
    transaction: callback => callback(async (sql, args) => {
      state.queries.push(sql); assert.match(sql, /^SELECT /, 'startup must not migrate or bind an empty production ledger');
      if (sql.includes('CURRENT_USER()')) return [state.connection];
      if (sql.includes('vp_environment')) return state.binding.map(row => ({ ...row }));
      assert.fail(`Unexpected test database query: ${sql}`);
    }) };
  const symbolName = `lyx-runtime-scope-fixture-${randomUUID()}`;
  globalThis[Symbol.for(symbolName)] = async options => {
    state.opened++; state.openOptions.push(options); if (gate) await gate.promise; return database;
  };
  t.after(() => { delete globalThis[Symbol.for(symbolName)]; });
  const runtimeUrl = new URL(`../payments/virtual/runtime.js?fixture=${randomUUID()}`, import.meta.url);
  const replacement = `data:text/javascript,${encodeURIComponent(`export const openVirtualDatabase = globalThis[Symbol.for(${JSON.stringify(symbolName)})];`)}`;
  const hook = registerHooks({ resolve(specifier, context, nextResolve) {
    if (specifier === './database.js' && context.parentURL === runtimeUrl.href) return { url: replacement, shortCircuit: true };
    return nextResolve(specifier, context);
  } });
  let runtimeModule;
  try { runtimeModule = await import(runtimeUrl.href); } finally { hook.deregister(); }
  return { ...runtimeModule, state, database };
}

test('production startup checks the existing database/account/env0 before ledger binding, with no writes or network', async t => {
  const f = await fixture(t);
  const runtime = await f.virtualRuntime(productionOptions);
  assert.equal(runtime.adapter.env, 0); assert.equal(runtime.ledger.database, f.database);
  assert.deepEqual(f.state.queries, ['SELECT DATABASE() AS db, CURRENT_USER() AS account',
    'SELECT id, app_id, env FROM vp_environment', 'SELECT * FROM vp_environment WHERE id = 1']);
  assert.equal(f.state.openOptions[0].migrate, undefined);
  assert.equal(f.state.openOptions[0].mysqlOptions.ssl, undefined);
  assert.equal(await f.virtualRuntime(productionOptions), runtime);
  await assert.rejects(f.virtualRuntime(), /PRIVATE_PRODUCTION_ONLY/);
  const normal = await f.virtualReadiness();
  assert.equal(normal.operationsReady, false);
  const authorized = await f.virtualReadiness({ runtimeOptions: productionOptions });
  assert.equal(authorized.operationsReady, true); assert.equal(authorized.ready, false);
  assert.equal(authorized.mode, 'closed'); assert.ok(authorized.blockers.includes('sales closed'));
  assert.equal(f.state.opened, 1); assert.equal(f.state.closed, 0);
});

test('an unbound or env1 production database is closed before bindEnvironment and a corrected retry is possible', async t => {
  const f = await fixture(t, { binding: [] });
  await assert.rejects(f.virtualRuntime(productionOptions), /PRIVATE_PRODUCTION_LEDGER_MISMATCH/);
  assert.equal(f.state.closed, 1); assert.equal(f.state.queries.length, 2);
  f.state.binding = [{ id: 1, app_id: target.appId, env: 1 }];
  await assert.rejects(f.virtualRuntime(productionOptions), /PRIVATE_PRODUCTION_LEDGER_MISMATCH/);
  assert.equal(f.state.closed, 2); assert.equal(f.state.queries.length, 4);
  f.state.binding = [{ id: 1, app_id: target.appId, env: 0 }];
  assert.equal((await f.virtualRuntime(productionOptions)).adapter.env, 0);
  assert.equal(f.state.opened, 3); assert.equal(f.state.closed, 2);
});

test('an initialized env1 runtime cannot be reused as env0 and scope drift never resets its live connection', async t => {
  const f = await fixture(t, { env: sandboxConfig });
  const sandboxOptions = { allowCloudrunPrivateSandbox: true };
  const runtime = await f.virtualRuntime(sandboxOptions);
  Object.assign(process.env, config);
  await assert.rejects(f.virtualRuntime(productionOptions), /XPAY_RUNTIME_SCOPE_MISMATCH/);
  Object.assign(process.env, sandboxConfig);
  for (const [key, value] of Object.entries({ XPAY_MYSQL_PASSWORD: 'different-password', WECHAT_APP_SECRET: 'different-secret',
    XPAY_OFFER_ID: 'different-offer', XPAY_SANDBOX_APP_KEY: 'different-key', XPAY_SESSION_ENCRYPTION_KEY: '8'.repeat(64),
    XPAY_MESSAGE_TOKEN: 'different-token', XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 8).toString('base64').slice(0, -1),
    XPAY_MODE: 'sandbox' })) {
    process.env[key] = value;
    await assert.rejects(f.virtualRuntime(sandboxOptions), error => {
      assert.equal(error.message, 'XPAY_RUNTIME_SCOPE_MISMATCH'); assert.ok(!error.message.includes(value)); return true;
    });
    process.env[key] = sandboxConfig[key];
  }
  assert.equal(await f.virtualRuntime(sandboxOptions), runtime);
  await assert.rejects(f.virtualRuntime(), /PRIVATE_SANDBOX_ONLY/);
  assert.equal(f.state.opened, 1); assert.equal(f.state.closed, 0);
});

test('pending startup and its private target use their original snapshots across configuration mutation', async t => {
  const gate = deferred(), f = await fixture(t, { gate });
  const mutableTarget = { ...target };
  const pending = f.virtualRuntime({ ...productionOptions, productionTarget: mutableTarget });
  assert.equal(f.state.opened, 1);
  mutableTarget.accountHost = 'PRIVATE_IP';
  Object.assign(process.env, { XPAY_ENV: '1', XPAY_APP_KEY: 'changed-while-opening', WECHAT_APP_SECRET: 'changed-secret' });
  gate.resolve(); const runtime = await pending;
  assert.equal(runtime.adapter.env, 0);
  const args = runtime.adapter.paymentArgs({ appId: target.appId, env: 0, id: 'test-order', productId: 'photo10', amountFen: 990 }, 'session-fixture');
  assert.equal(args.paySig, paySignature(config.XPAY_APP_KEY, 'requestVirtualPayment', args.signData));
  Object.assign(process.env, config);
  await assert.rejects(f.virtualRuntime({ ...productionOptions, productionTarget: mutableTarget }), /RUNTIME_SCOPE_MISMATCH/);
  assert.equal(await f.virtualRuntime(productionOptions), runtime);
  assert.equal(f.state.opened, 1); assert.equal(f.state.closed, 0);
});

test('readiness keeps the closed configuration captured before asynchronous startup and requires explicit private options', async t => {
  const gate = deferred(), f = await fixture(t, { gate });
  const pending = f.virtualReadiness({ runtimeOptions: productionOptions });
  assert.equal(f.state.opened, 1); process.env.XPAY_MODE = 'live'; process.env.XPAY_TEST_USER_IDS = 'changed-user';
  gate.resolve(); const readiness = await pending;
  assert.equal(readiness.operationsReady, true); assert.equal(readiness.ready, false);
  assert.equal(readiness.mode, 'closed'); assert.deepEqual(readiness.testUserIds, []);
  assert.ok(readiness.blockers.includes('sales closed'));
  const changed = await f.virtualReadiness({ runtimeOptions: productionOptions });
  assert.equal(changed.operationsReady, false); assert.equal(changed.ready, false);
  assert.equal(f.state.opened, 1); assert.equal(f.state.closed, 0);
});

test('disabled or non-MySQL production startup never constructs a database', async t => {
  const f = await fixture(t);
  process.env.XPAY_ENABLED = 'false'; assert.equal(await f.virtualRuntime(productionOptions), null);
  process.env.XPAY_ENABLED = 'true'; process.env.XPAY_DB_BACKEND = 'sqlite';
  await assert.rejects(f.virtualRuntime(productionOptions), /PRIVATE_PRODUCTION_ONLY/);
  process.env.XPAY_MYSQL_TRANSPORT = 'tls';
  await assert.rejects(f.virtualRuntime(), /PRODUCTION_MYSQL_REQUIRED/);
  assert.equal(f.state.opened, 0);
});

test('live readiness refuses env1 or unscoped acceptance even when all existing checks are true', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-runtime-acceptance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic-acceptance.json');
  const env = { ...config, XPAY_MODE: 'live', XPAY_PRODUCTS_JSON: JSON.stringify([draftProducts[0]]),
    XPAY_PURPOSE_RULES_JSON: JSON.stringify({ 'photo-effect': { kind: 'photo', reviewed: true } }), XPAY_ACCEPTANCE_FILE: file };
  const f = await fixture(t, { env });
  const report = { appId: target.appId, env: 0, offerId: config.XPAY_OFFER_ID, acceptedAt: new Date().toISOString(),
    checks: { mysqlRestore: true, merchantPayment: true, merchantRefund: true, crossDeviceRestore: true,
      iosRefund: true, securityReview: true, dailyReconciliation: true } };
  const options = { identityReady: true, adminReady: true, runtimeOptions: productionOptions };
  const save = value => { const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes);
    process.env.XPAY_ACCEPTANCE_SHA256 = createHash('sha256').update(bytes).digest('hex'); };
  for (const value of [{ ...report, env: 1 }, { ...report, env: undefined }, { ...report, offerId: 'another-offer' }]) {
    save(value); const readiness = await f.virtualReadiness(options);
    assert.equal(readiness.operationsReady, true); assert.equal(readiness.ready, false);
    assert.deepEqual(readiness.blockers, ['pinned merchant and operational acceptance required']);
  }
  save(report); const readiness = await f.virtualReadiness(options);
  assert.equal(readiness.ready, true); assert.equal(f.state.opened, 1); assert.equal(f.state.closed, 0);
});

test('formal Android runtime never reuses a seven-check report, but accepts scoped six-check evidence without changing operations', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-runtime-android-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic-only.json');
  const env = { ...config, XPAY_MODE: 'live', XPAY_PRODUCTS_JSON: JSON.stringify([draftProducts[0]]),
    XPAY_PURPOSE_RULES_JSON: JSON.stringify({ 'photo-effect': { kind: 'photo', reviewed: true } }), XPAY_ACCEPTANCE_FILE: file };
  const f = await fixture(t, { env });
  const report = { appId: target.appId, env: 0, offerId: config.XPAY_OFFER_ID, acceptedAt: new Date().toISOString(),
    checks: { mysqlRestore: true, merchantPayment: true, merchantRefund: true, crossDeviceRestore: true,
      iosRefund: true, securityReview: true, dailyReconciliation: true } };
  const options = { identityReady: true, adminReady: true, runtimeOptions: productionOptions, purchaseProfile: 'android-only-v1' };
  const save = value => { const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes);
    process.env.XPAY_ACCEPTANCE_SHA256 = createHash('sha256').update(bytes).digest('hex'); };
  save(report);
  let state = await f.virtualReadiness(options);
  assert.equal(state.ready, false); assert.equal(state.operationsReady, true); assert.equal(state.purchaseProfile, options.purchaseProfile);
  const scoped = { ...report, purchaseProfile: options.purchaseProfile, supportedPlatforms: ['android'],
    checks: { ...report.checks, iosRefund: 'not_applicable' },
    appleIap: { enabled: false, source: 'wechat-mini-program-console', checkedAt: report.acceptedAt, evidenceSha256: 'b'.repeat(64) } };
  save(scoped); state = await f.virtualReadiness(options); assert.equal(state.ready, true);
  const wrong = await f.virtualReadiness({ ...options, purchaseProfile: 'ios' });
  assert.equal(wrong.ready, false); assert.equal(wrong.operationsReady, true);
  assert.ok(wrong.blockers.includes('payment purchase profile mismatch'));
  save({ ...scoped, checks: { ...scoped.checks, merchantRefund: false } });
  state = await f.virtualReadiness(options); assert.equal(state.ready, false); assert.equal(state.operationsReady, true);
  assert.equal(f.state.opened, 1);
});
