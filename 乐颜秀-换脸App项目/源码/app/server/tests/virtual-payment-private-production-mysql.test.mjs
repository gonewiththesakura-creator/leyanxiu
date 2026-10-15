import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from 'mysql2/promise';
import { builtinSandboxMysql, builtinProductionMysql, privateSandboxTransport, privateProductionTransport,
  createPrivateProductionMysqlTarget, virtualMysqlOptions, verifyPrivateProductionDatabase } from '../payments/virtual/mysql-transport.js';
import { virtualRuntime } from '../payments/virtual/runtime.js';

// Fictional dedicated account: this fixture does not establish a real account
// or database, and lazy mysql2 pool construction never opens a connection.
const target = createPrivateProductionMysqlTarget({ database: builtinProductionMysql.database,
  user: 'lyx_xpay_fixture', accountHost: '%' });
const permitted = { allowCloudrunPrivateProduction: true, productionTarget: target };
const config = { RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENV: '0', XPAY_MODE: 'closed',
  XPAY_DB_BACKEND: 'mysql', WECHAT_APP_ID: target.appId, XPAY_CLOUD_ENV_ID: target.cloudEnvId,
  XPAY_MYSQL_INSTANCE_ID: target.instanceId, XPAY_MYSQL_TRANSPORT: privateProductionTransport,
  XPAY_MYSQL_HOST: target.host, XPAY_MYSQL_PORT: String(target.port), XPAY_MYSQL_USER: target.user,
  XPAY_MYSQL_DATABASE: target.database, XPAY_MYSQL_PASSWORD: 'local-fixture-only' };

test('production allocation is explicit and separate, with unchanged sandbox identifiers', () => {
  assert.equal(builtinProductionMysql.database, 'leyanxiu_xpay_production');
  assert.equal(builtinSandboxMysql.database, 'leyanxiu_xpay_sandbox');
  assert.equal(builtinSandboxMysql.user, 'lyx_xpay_sandbox');
  assert.notEqual(privateProductionTransport, privateSandboxTransport);
  assert.ok(Object.isFrozen(target)); assert.equal(target.accountHost, '%');
  const exactHost = createPrivateProductionMysqlTarget({ database: target.database, user: target.user, accountHost: 'PRIVATE_IP' });
  assert.equal(exactHost.accountHost, 'PRIVATE_IP');
  for (const value of [{}, { database: target.database }, { database: target.database, user: target.user },
    { ...target, database: builtinSandboxMysql.database }, { ...target, database: 'mysql' },
    { ...target, user: 'root' }, { ...target, user: builtinSandboxMysql.user }, { ...target, user: 'lyx_xpay_fixture2' },
    { ...target, user: 'lyx_xpay_prod;--' }, { ...target, user: ' lyx_xpay_prod' },
    { ...target, accountHost: '' }, { ...target, accountHost: '10.%' }, { ...target, accountHost: '010.14.1.2' },
    { ...target, accountHost: '999.14.1.2' }, { ...target, accountHost: '%@other' }]) {
    assert.throws(() => createPrivateProductionMysqlTarget(value), /PRIVATE_PRODUCTION_TARGET_REQUIRED/);
  }
});

test('only production opt-in plus an explicit target configures env0 without enabling sales', async t => {
  assert.throws(() => virtualMysqlOptions(config), /PRIVATE_PRODUCTION_ONLY/);
  assert.throws(() => virtualMysqlOptions(config, { allowCloudrunPrivateSandbox: true }), /PRIVATE_PRODUCTION_ONLY/);
  for (const allowCloudrunPrivateProduction of [false, 'true', 1, null]) {
    assert.throws(() => virtualMysqlOptions(config, { ...permitted, allowCloudrunPrivateProduction }), /PRIVATE_PRODUCTION_ONLY/);
  }
  assert.throws(() => virtualMysqlOptions(config, { allowCloudrunPrivateProduction: true }), /PRIVATE_PRODUCTION_TARGET_REQUIRED/);
  for (const mode of ['closed', 'merchant_test', 'live']) {
    const options = virtualMysqlOptions({ ...config, XPAY_MODE: mode }, permitted);
    const pool = createPool(options); t.after(() => pool.end());
    assert.equal(pool.pool.config.connectionConfig.ssl, false);
    assert.equal(options.host, target.host); assert.equal(options.database, target.database); assert.equal(options.user, target.user);
    assert.equal(options.connectTimeout, 10000); assert.equal(options.authPlugins, undefined);
    assert.equal(options.multipleStatements, undefined);
  }
  assert.equal(config.XPAY_MODE, 'closed');
});

test('production scope refuses other modes, envs, identities, cloud resources and sandbox credentials', () => {
  for (const changes of [{ XPAY_ENV: '1' }, { XPAY_ENV: '' }, { XPAY_ENV: 0 }, { XPAY_MODE: 'sandbox' },
    { XPAY_MODE: 'closed ' }, { XPAY_MODE: '' }, { RELEASE_CHANNEL: 'android-app' }, { AUTH_MODE: 'anonymous' },
    { XPAY_DB_BACKEND: 'sqlite' }, { WECHAT_APP_ID: 'other-app' }, { XPAY_CLOUD_ENV_ID: 'other-environment' },
    { XPAY_MYSQL_INSTANCE_ID: 'other-instance' }, { XPAY_MYSQL_HOST: 'PRIVATE_IP' },
    { XPAY_MYSQL_HOST: '127.0.0.1' }, { XPAY_MYSQL_HOST: '8.8.8.8' }, { XPAY_MYSQL_HOST: 'mysql.example.com' },
    { XPAY_MYSQL_PORT: '3307' }, { XPAY_MYSQL_PORT: '3306.0' }, { XPAY_MYSQL_PORT: ' 3306' },
    { XPAY_MYSQL_DATABASE: builtinSandboxMysql.database }, { XPAY_MYSQL_DATABASE: 'mysql' },
    { XPAY_MYSQL_USER: builtinSandboxMysql.user }, { XPAY_MYSQL_USER: 'root' }]) {
    assert.throws(() => virtualMysqlOptions({ ...config, ...changes }, permitted), /XPAY_MYSQL_PRIVATE_PRODUCTION_/);
  }
  for (const field of ['appId', 'cloudEnvId', 'instanceId', 'host', 'port', 'database', 'user', 'accountHost']) {
    assert.throws(() => virtualMysqlOptions(config, { ...permitted, productionTarget: { ...target, [field]: 'unexpected' } }),
      /PRIVATE_PRODUCTION_TARGET_REQUIRED/);
  }
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_TRANSPORT: privateSandboxTransport }, permitted), /PRIVATE_SANDBOX_ONLY/);
});

test('production explicit private route cannot be selected by a CA failure or environment approval switch', async () => {
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_CA_FILE: 'fixture.pem' }, permitted), /TRANSPORT_CONFLICT/);
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_TRANSPORT: '' }, permitted), /TLS_REQUIRED/);
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_TRANSPORT: 'auto' }, permitted), /TRANSPORT_INVALID/);
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_TRANSPORT: 'tls', XPAY_MYSQL_CA_FILE: 'absent-fixture-ca.pem' }, permitted), /ENOENT/);
  const values = { ...config, XPAY_ENABLED: 'true', ALLOW_CLOUDRUN_PRIVATE_PRODUCTION: 'true' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    await assert.rejects(virtualRuntime(), /PRIVATE_PRODUCTION_ONLY/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

function databaseFixture({ connections = [{ db: target.database, account: `${target.user}@${target.accountHost}` }],
  binding = [{ id: 1, app_id: target.appId, env: 0 }], backend = 'mysql' } = {}) {
  const queries = [];
  return { backend, queries, transaction: callback => callback(async sql => {
    assert.match(sql, /^SELECT /); queries.push(sql);
    if (sql.includes('CURRENT_USER()')) return connections;
    if (sql.includes('vp_environment')) return binding;
    assert.fail('No initialization or business write is permitted');
  }) };
}

test('production startup requires exactly the selected account host and existing env0 binding using only SELECT', async () => {
  const db = databaseFixture(); await verifyPrivateProductionDatabase(db, target);
  assert.equal(db.queries.length, 2);
  for (const values of [{ backend: 'sqlite' }, { connections: [] }, { connections: null },
    { connections: [{ db: builtinSandboxMysql.database, account: `${target.user}@%` }] },
    { connections: [{ db: target.database, account: 'root@%' }] },
    { connections: [{ db: target.database, account: `${target.user}_other@%` }] },
    { connections: [{ db: target.database, account: `${target.user}@PRIVATE_IP` }] },
    { connections: [{ db: target.database, account: `${target.user}@` }] },
    { connections: [{ db: target.database, account: `${target.user}@%` }, { db: target.database, account: `${target.user}@%` }] },
    { binding: [] }, { binding: null }, { binding: [{ id: 1, app_id: target.appId, env: 1 }] },
    { binding: [{ id: 1, app_id: 'different-app', env: 0 }] }, { binding: [{ id: 2, app_id: target.appId, env: 0 }] },
    { binding: [{ id: 1, app_id: target.appId, env: '0' }] },
    { binding: [{ id: 1, app_id: target.appId, env: 0 }, { id: 1, app_id: target.appId, env: 0 }] }]) {
    await assert.rejects(verifyPrivateProductionDatabase(databaseFixture(values), target), /XPAY_MYSQL_PRIVATE_PRODUCTION_/);
  }
  const untouched = databaseFixture();
  await assert.rejects(verifyPrivateProductionDatabase(untouched), /PRIVATE_PRODUCTION_TARGET_REQUIRED/);
  assert.equal(untouched.queries.length, 0);
});
