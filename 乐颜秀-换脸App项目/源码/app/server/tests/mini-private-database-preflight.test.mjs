import test from 'node:test';
import assert from 'node:assert/strict';
import { main, target, validateMiniPrivateDatabase } from '../scripts/check-mini-private-database.mjs';

function fixture() {
  return {
    appId: target.appId, envId: target.cloudEnvId, environmentConfirmed: true,
    config: {
      WECHAT_APP_ID: target.appId, RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat',
      XPAY_ENV: '1', XPAY_MODE: 'closed', XPAY_DB_BACKEND: 'mysql',
      XPAY_MYSQL_TRANSPORT: 'cloudrun_builtin_private', XPAY_CLOUD_ENV_ID: target.cloudEnvId,
      XPAY_MYSQL_INSTANCE_ID: target.instanceId, XPAY_MYSQL_HOST: target.host,
      XPAY_MYSQL_PORT: String(target.port), XPAY_MYSQL_USER: target.user,
      XPAY_MYSQL_PASSWORD: 'fictional-password-for-local-unit-test', XPAY_MYSQL_DATABASE: target.database,
    },
    detail: { dbClusterId: target.instanceId,
      netInfo: { privateNetAddress: `${target.host}:${target.port}`, pubNetAddress: null },
      dbInfo: { isOpenPubNetAccess: false, status: 'running' } },
    accounts: { clusterStatus: 'running', accounts: [{ accountName: target.user }] },
  };
}

test('an exact running private sandbox produces only a deployment snapshot, not TLS or SQL evidence', () => {
  const input = fixture(), before = structuredClone(input);
  const report = validateMiniPrivateDatabase(input);
  assert.equal(report.preflightPassed, true);
  assert.equal(report.controlPlaneReady, true);
  assert.equal(report.configurationReady, true);
  assert.equal(report.transportEncryption, false);
  assert.equal(report.privateNetworkEvidenceProvesTls, false);
  assert.equal(report.databaseLoginAttempted, false);
  assert.equal(report.databaseLoginVerified, false);
  assert.equal(report.accountGrantsVerified, false);
  assert.equal(report.continuousNetworkCertification, false);
  assert.equal(report.changedRemoteState, false);
  assert.equal(report.scope, 'deployment_time_snapshot');
  assert.equal(JSON.stringify(report).includes(input.config.XPAY_MYSQL_PASSWORD), false);
  assert.deepEqual(input, before);
});

test('changed cloud app, environment, missing authorization, or instance fails closed', () => {
  for (const change of [
    input => { input.appId = 'wx_other'; },
    input => { input.envId = 'other-environment'; },
    input => { input.environmentConfirmed = undefined; },
    input => { input.environmentConfirmed = 'true'; },
    input => { input.detail.dbClusterId = 'another-instance'; },
  ]) {
    const input = fixture(); change(input);
    const report = validateMiniPrivateDatabase(input);
    assert.equal(report.controlPlaneReady, false);
    assert.equal(report.preflightPassed, false);
  }
});

test('private address must be the exact IPv4 and port on the expected instance', () => {
  for (const address of [undefined, '', 'PRIVATE_IP:3306', 'REDACTED_PRIVATE_NETWORK_ADDRESS:3307',
    '203.0.113.8:3306', 'mysql.example:3306', 'REDACTED_PRIVATE_NETWORK_ADDRESS', 'REDACTED_PRIVATE_NETWORK_ADDRESS:3306 ']) {
    const input = fixture(); input.detail.netInfo.privateNetAddress = address;
    const report = validateMiniPrivateDatabase(input);
    assert.equal(report.controlPlaneChecks.privateAddress, false);
    assert.equal(report.preflightPassed, false);
  }
});

test('public access must be explicitly false, and a missing public address is unknown', () => {
  for (const publicAccess of [undefined, null, true, 0, 'false']) {
    const input = fixture(); input.detail.dbInfo.isOpenPubNetAccess = publicAccess;
    assert.equal(validateMiniPrivateDatabase(input).preflightPassed, false);
  }
  for (const address of [undefined, ' ', '203.0.113.8:3306', 'mysql.example:3306']) {
    const input = fixture(); input.detail.netInfo.pubNetAddress = address;
    assert.equal(validateMiniPrivateDatabase(input).preflightPassed, false);
  }
  const input = fixture(); input.detail.netInfo.pubNetAddress = '';
  assert.equal(validateMiniPrivateDatabase(input).preflightPassed, true);
});

test('paused or unknown database/accounts cannot pass even with a populated accounts array', () => {
  for (const status of [undefined, null, '', 'pause', 'paused', 'unknown', 'resuming']) {
    for (const source of ['detail', 'accounts']) {
      const input = fixture();
      if (source === 'detail') input.detail.dbInfo.status = status;
      else input.accounts.clusterStatus = status;
      assert.equal(validateMiniPrivateDatabase(input).preflightPassed, false);
    }
  }
  for (const accounts of [undefined, null, [], [{ accountName: 'root' }]]) {
    const input = fixture(); input.accounts.accounts = accounts;
    assert.equal(validateMiniPrivateDatabase(input).preflightPassed, false);
  }
});

test('application configuration is separately checked without hiding valid control-plane evidence', () => {
  for (const [field, value] of [
    ['WECHAT_APP_ID', 'wx_other'], ['XPAY_CLOUD_ENV_ID', 'other-environment'],
    ['XPAY_MYSQL_INSTANCE_ID', 'another-instance'], ['XPAY_MYSQL_HOST', 'PRIVATE_IP'],
    ['XPAY_MYSQL_HOST', 'mysql.example'], ['XPAY_MYSQL_PORT', '3307'],
    ['XPAY_MYSQL_DATABASE', 'production'], ['XPAY_MYSQL_USER', 'root'],
    ['XPAY_ENV', '0'], ['XPAY_MODE', 'production'], ['XPAY_DB_BACKEND', 'sqlite'],
    ['XPAY_MYSQL_TRANSPORT', 'tls'], ['XPAY_MYSQL_CA_FILE', '/fictional/ca.pem'],
    ['AUTH_MODE', 'test'], ['RELEASE_CHANNEL', 'other-channel'],
  ]) {
    const input = fixture(); input.config[field] = value;
    const report = validateMiniPrivateDatabase(input);
    assert.equal(report.controlPlaneReady, true);
    assert.equal(report.configurationReady, false);
    assert.equal(report.preflightPassed, false);
  }
  const input = fixture(); delete input.config.XPAY_MYSQL_PASSWORD;
  delete input.config.XPAY_CLOUD_ENV_ID;
  const report = validateMiniPrivateDatabase(input);
  assert.equal(report.configurationMissing, true);
  assert.deepEqual(report.missingConfigFields, ['XPAY_CLOUD_ENV_ID', 'XPAY_MYSQL_PASSWORD']);
  assert.equal(report.controlPlaneReady, true);
  assert.equal(report.configurationReady, false);
});

test('main inspects read-only with missing payment fields and outputs no secrets or raw inventory values', async () => {
  const input = fixture(); delete input.config.XPAY_MYSQL_PASSWORD;
  const cloudConfig = { WXCLOUD_APP_ID: target.appId, WXCLOUD_PRIVATE_KEY: 'fictional-private-api-key' };
  let calls = 0;
  const report = await main({
    loadConfig: filename => ({ config: filename === '.env.mini-payment' ? input.config : cloudConfig, readable: true }),
    inspect: async config => {
      assert.deepEqual(config, cloudConfig); calls += 1;
      return { environmentConfirmed: true, detail: input.detail, accounts: { ...input.accounts,
        secret: 'fictional-unexpected-api-response-secret' } };
    },
    checkedAt: () => '2026-10-06T00:00:00.000Z',
  });
  assert.equal(calls, 1);
  assert.equal(report.controlPlaneReady, true);
  assert.equal(report.configurationReady, false);
  assert.equal(report.preflightPassed, false);
  assert.equal(report.databaseLoginVerified, false);
  const json = JSON.stringify(report);
  assert.equal(json.includes(cloudConfig.WXCLOUD_PRIVATE_KEY), false);
  assert.equal(json.includes('fictional-unexpected-api-response-secret'), false);
});

test('main never inspects with missing CLI credentials, wrong AppID, or unreadable cloud config', async () => {
  for (const cloud of [
    { config: {}, readable: false },
    { config: { WXCLOUD_APP_ID: target.appId }, readable: true },
    { config: { WXCLOUD_APP_ID: 'wx_other', WXCLOUD_PRIVATE_KEY: 'fictional-api-key' }, readable: true },
  ]) {
    const report = await main({
      loadConfig: filename => filename === '.env.mini-cloud' ? cloud : { config: fixture().config, readable: true },
      inspect: async () => { assert.fail('inspection must not run'); },
    });
    assert.equal(report.preflightPassed, false);
    assert.equal(report.controlPlaneReady, false);
    assert.equal(report.cloudConfigurationReady, false);
    assert.equal(report.failureCode, 'CLOUD_CONFIGURATION_NOT_READY');
  }
});

test('SDK transport failures only yield an allowlisted failure code, never raw errors', async () => {
  const input = fixture();
  const report = await main({
    loadConfig: filename => ({ config: filename === '.env.mini-payment' ? input.config
      : { WXCLOUD_APP_ID: target.appId, WXCLOUD_PRIVATE_KEY: 'fictional-api-key' }, readable: true }),
    inspect: async () => { throw new Error('HTTP request Authorization: REDACTED_SECRET'); },
  });
  assert.equal(report.preflightPassed, false);
  assert.equal(report.controlPlaneReady, false);
  assert.equal(report.failureCode, 'CONTROL_PLANE_UNCONFIRMED');
  assert.equal(JSON.stringify(report).includes('fictional-authentication-secret'), false);
});
