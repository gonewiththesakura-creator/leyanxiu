import test from 'node:test';
import assert from 'node:assert/strict';
import { createPool } from 'mysql2/promise';
import { builtinSandboxMysql as target, privateSandboxTransport,
  virtualMysqlOptions, verifyPrivateSandboxDatabase } from '../payments/virtual/mysql-transport.js';
import { virtualRuntime } from '../payments/virtual/runtime.js';

const permitted = { allowCloudrunPrivateSandbox: true };
const config = {
  RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENV: '1', XPAY_MODE: 'closed',
  XPAY_DB_BACKEND: 'mysql', WECHAT_APP_ID: target.appId, XPAY_CLOUD_ENV_ID: target.cloudEnvId,
  XPAY_MYSQL_INSTANCE_ID: target.instanceId, XPAY_MYSQL_TRANSPORT: privateSandboxTransport,
  XPAY_MYSQL_HOST: target.host, XPAY_MYSQL_PORT: String(target.port), XPAY_MYSQL_USER: target.user,
  XPAY_MYSQL_DATABASE: target.database, XPAY_MYSQL_PASSWORD: 'test-fixture-only',
};

test('only explicit sandbox entry can configure the pinned private MySQL target', async t => {
  assert.throws(() => virtualMysqlOptions(config), /PRIVATE_SANDBOX_ONLY/);
  for (const mode of ['closed', 'sandbox']) {
    const options = virtualMysqlOptions({ ...config, XPAY_MODE: mode }, permitted);
    const pool = createPool(options); // Lazy: no real connection or credentials.
    t.after(() => pool.end());
    assert.equal(pool.pool.config.connectionConfig.ssl, false);
    assert.equal(options.host, target.host);
    assert.equal(options.database, target.database);
    assert.equal(options.connectTimeout, 10000);
    assert.equal(options.authPlugins, undefined);
  }
});

test('scope checks reject live money, other entry channels and alternate targets', () => {
  for (const changes of [
    { XPAY_ENV: '0' }, { XPAY_ENV: '' }, { XPAY_MODE: 'live' }, { XPAY_MODE: 'merchant_test' },
    { RELEASE_CHANNEL: 'android' }, { AUTH_MODE: 'anonymous' }, { XPAY_DB_BACKEND: 'sqlite' },
    { WECHAT_APP_ID: 'another-app' }, { XPAY_CLOUD_ENV_ID: '' }, { XPAY_CLOUD_ENV_ID: 'other-env' },
    { XPAY_MYSQL_INSTANCE_ID: 'other-instance' }, { XPAY_MYSQL_HOST: 'PRIVATE_IP' },
    { XPAY_MYSQL_HOST: '127.0.0.1' }, { XPAY_MYSQL_HOST: '8.8.8.8' },
    { XPAY_MYSQL_HOST: 'db.example.invalid' }, { XPAY_MYSQL_PORT: '3307' },
    { XPAY_MYSQL_DATABASE: 'mysql' }, { XPAY_MYSQL_USER: 'root' },
  ]) assert.throws(() => virtualMysqlOptions({ ...config, ...changes }, permitted), /XPAY_MYSQL_PRIVATE_/, JSON.stringify(changes));
});

test('TLS defaults and failed CA loading never select the private transport', () => {
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_TRANSPORT: '' }, permitted), /TLS_REQUIRED/);
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_TRANSPORT: 'auto' }, permitted), /TRANSPORT_INVALID/);
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_CA_FILE: 'ca.pem' }, permitted), /TRANSPORT_CONFLICT/);
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_TRANSPORT: 'tls',
    XPAY_MYSQL_CA_FILE: 'absent-fixture-certificate.pem' }, permitted), /ENOENT/);
});

function databaseFixture({ connection = { db: target.database, account: `${target.user}@%` },
  binding = [{ id: 1, app_id: target.appId, env: 1 }], backend = 'mysql' } = {}) {
  const queries = [];
  return { backend, queries, transaction: callback => callback(async sql => {
    assert.match(sql, /^SELECT /); queries.push(sql);
    if (sql.includes('CURRENT_USER()')) return connection ? [connection] : [];
    if (sql.includes('vp_environment')) return binding;
    throw new Error('UNEXPECTED_QUERY');
  }) };
}

test('private startup checks actual database account and previously bound ledger without writes', async () => {
  const db = databaseFixture(); await verifyPrivateSandboxDatabase(db);
  assert.equal(db.queries.length, 2);
  for (const values of [
    { backend: 'sqlite' }, { connection: null }, { connection: { db: 'mysql', account: `${target.user}@%` } },
    { connection: { db: target.database, account: 'root@%' } },
    { connection: { db: target.database, account: `${target.user}_other@%` } },
    { binding: [] }, { binding: [{ id: 1, app_id: target.appId, env: 0 }] },
    { binding: [{ id: 1, app_id: 'different-app', env: 1 }] },
    { binding: [{ id: 2, app_id: target.appId, env: 1 }] },
  ]) await assert.rejects(verifyPrivateSandboxDatabase(databaseFixture(values)), /XPAY_MYSQL_PRIVATE_/);
});

test('ordinary runtime cannot opt in to the private route through environment values alone', async () => {
  const values = { ...config, XPAY_ENABLED: 'true' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, values);
    await assert.rejects(virtualRuntime(), /XPAY_MYSQL_PRIVATE_SANDBOX_ONLY/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
