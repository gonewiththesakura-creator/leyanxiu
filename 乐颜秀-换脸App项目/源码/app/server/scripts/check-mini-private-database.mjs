import fs from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';
import { builtinSandboxMysql, privateSandboxTransport } from '../payments/virtual/mysql-transport.js';

// Deployment-time control-plane preflight only. No SQL connection, resume,
// account changes, persisted CLI login, or generated authorization evidence.
export const target = builtinSandboxMysql;
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const present = value => typeof value === 'string' && value.trim().length > 0;
const running = value => typeof value === 'string' && ['running', 'normal'].includes(value.toLowerCase());
const requiredConfigFields = Object.freeze([
  'WECHAT_APP_ID', 'RELEASE_CHANNEL', 'AUTH_MODE', 'XPAY_ENV', 'XPAY_MODE', 'XPAY_DB_BACKEND',
  'XPAY_MYSQL_TRANSPORT', 'XPAY_CLOUD_ENV_ID', 'XPAY_MYSQL_INSTANCE_ID', 'XPAY_MYSQL_HOST',
  'XPAY_MYSQL_PORT', 'XPAY_MYSQL_USER', 'XPAY_MYSQL_PASSWORD', 'XPAY_MYSQL_DATABASE',
]);

export function validateMiniPrivateDatabase({ appId, envId, environmentConfirmed, config = {}, detail, accounts } = {}) {
  const missingConfigFields = requiredConfigFields.filter(field => !present(config[field]));
  const configurationChecks = {
    appId: config.WECHAT_APP_ID === target.appId,
    releaseChannel: config.RELEASE_CHANNEL === 'wechat-mini-program',
    authMode: config.AUTH_MODE === 'wechat',
    sandbox: config.XPAY_ENV === '1' && ['closed', 'sandbox'].includes(config.XPAY_MODE),
    mysqlBackend: config.XPAY_DB_BACKEND === 'mysql',
    privateTransport: config.XPAY_MYSQL_TRANSPORT === privateSandboxTransport,
    cloudEnvironment: config.XPAY_CLOUD_ENV_ID === target.cloudEnvId,
    instance: config.XPAY_MYSQL_INSTANCE_ID === target.instanceId,
    privateHost: config.XPAY_MYSQL_HOST === target.host && isIP(config.XPAY_MYSQL_HOST) === 4,
    port: config.XPAY_MYSQL_PORT === String(target.port),
    account: config.XPAY_MYSQL_USER === target.user,
    database: config.XPAY_MYSQL_DATABASE === target.database,
    passwordPresent: present(config.XPAY_MYSQL_PASSWORD),
    noTlsConfigurationConflict: !present(config.XPAY_MYSQL_CA_FILE),
  };
  const net = detail?.netInfo;
  const controlPlaneChecks = {
    appId: appId === target.appId,
    environment: envId === target.cloudEnvId && environmentConfirmed === true,
    instance: detail?.dbClusterId === target.instanceId,
    privateAddress: net?.privateNetAddress === `${target.host}:${target.port}`,
    // Unknown, missing, string 'false', and truthy addresses all fail closed.
    publicAccessClosed: detail?.dbInfo?.isOpenPubNetAccess === false,
    publicAddressEmpty: net?.pubNetAddress === null || net?.pubNetAddress === '',
    databaseRunning: running(detail?.dbInfo?.status),
    accountsRunning: running(accounts?.clusterStatus),
    applicationAccountPresent: Array.isArray(accounts?.accounts)
      && accounts.accounts.some(account => account?.accountName === target.user),
  };
  const controlPlaneReady = Object.values(controlPlaneChecks).every(value => value === true);
  const configurationReady = missingConfigFields.length === 0
    && Object.values(configurationChecks).every(value => value === true);
  return {
    check: 'miniPrivateDatabaseDeploymentPreflight',
    target,
    scope: 'deployment_time_snapshot',
    changedRemoteState: false,
    continuousNetworkCertification: false,
    transportEncryption: false,
    privateNetworkEvidenceProvesTls: false,
    transportStatement: 'Private network evidence does not prove TLS.',
    databaseLoginAttempted: false,
    databaseLoginVerified: false,
    schemaVerified: false,
    accountGrantsVerified: false,
    controlPlaneReady,
    controlPlaneChecks,
    configurationReady,
    configurationMissing: missingConfigFields.length > 0,
    missingConfigFields,
    configurationChecks,
    preflightPassed: controlPlaneReady && configurationReady,
  };
}

function readConfig(filename) {
  try { return { config: dotenv.parse(fs.readFileSync(path.join(server, filename))), readable: true }; }
  catch { return { config: {}, readable: false }; }
}

async function inspectOfficialCloud(cloudConfig) {
  // Official CLI authentication is reused in memory; never call its login,
  // writeLoginState, saveLoginState, resume, or mutation APIs.
  const cliRoot = process.env.WXCLOUD_CLI_ROOT || path.join(process.env.LOCALAPPDATA || '',
    'leyanxiu-toolchains', 'wxcloud-cli', 'node_modules', '@wxcloud', 'cli');
  const require = createRequire(path.join(cliRoot, 'package.json'));
  const originalConsole = { log: console.log, error: console.error, warn: console.warn, debug: console.debug, info: console.info };
  let logger, originalDebug, auth, originalReadLoginState, axios, originalTimeout;
  let stage = 'OFFICIAL_SDK_UNAVAILABLE';
  try {
    // The SDK may log entire HTTP errors including authentication headers.
    for (const method of Object.keys(originalConsole)) console[method] = () => {};
    ({ logger } = require('./lib/utils/log.js'));
    originalDebug = logger.debug; logger.debug = () => {};
    axios = require('axios'); originalTimeout = axios.defaults.timeout; axios.defaults.timeout = 15000;
    auth = require('./lib/utils/auth.js'); originalReadLoginState = auth.readLoginState;
    const state = { appid: cloudConfig.WXCLOUD_APP_ID, privateKey: cloudConfig.WXCLOUD_PRIVATE_KEY.trim() };
    auth.readLoginState = async () => state;
    stage = 'OFFICIAL_AUTH_UNCONFIRMED';
    if (!await auth.checkLoginState(state.appid, state.privateKey)) throw new Error(stage);
    require('./lib/api/adapter.js').initCloudAPI(state.appid);
    require('./lib/api/common.js').setApiCommonParameters({ region: 'ap-shanghai' });
    stage = 'ENVIRONMENT_INVENTORY_UNCONFIRMED';
    const { EnvList } = await require('./lib/api/index.js').DescribeWxCloudBaseRunEnvs();
    const environmentConfirmed = Array.isArray(EnvList) && EnvList.some(env => env?.EnvId === target.cloudEnvId);
    if (!environmentConfirmed) return { environmentConfirmed: false };
    const { CloudAPI } = require('@wxcloud/core');
    // The adapter supplies region in the envelope. Adding opts.region would
    // leave an unsupported region field in these APIs' JSON body on SDK 1.1.4.
    const options = { envId: target.cloudEnvId, wxAppId: target.appId };
    stage = 'DATABASE_DETAIL_UNCONFIRMED';
    const detail = await CloudAPI.tcbDescribeWxCloudBaseRunDBClusterDetail(options);
    stage = 'DATABASE_ACCOUNTS_UNCONFIRMED';
    const accounts = await CloudAPI.tcbDescribeWxCloudBaseRunDBAccounts(options);
    return { environmentConfirmed, detail, accounts };
  } catch {
    // Emit only our bounded stage code, never provider codes or transport text.
    throw new Error(stage);
  } finally {
    if (auth && originalReadLoginState) auth.readLoginState = originalReadLoginState;
    if (logger && originalDebug) logger.debug = originalDebug;
    if (axios) axios.defaults.timeout = originalTimeout;
    Object.assign(console, originalConsole);
  }
}

export async function main({ loadConfig = readConfig, inspect = inspectOfficialCloud,
  checkedAt = () => new Date().toISOString() } = {}) {
  const payment = loadConfig('.env.mini-payment');
  const cloud = loadConfig('.env.mini-cloud');
  const missingCloudConfigFields = ['WXCLOUD_APP_ID', 'WXCLOUD_PRIVATE_KEY']
    .filter(field => !present(cloud.config?.[field]));
  const cloudConfigurationReady = cloud.readable === true && missingCloudConfigFields.length === 0
    && cloud.config.WXCLOUD_APP_ID === target.appId;
  let inventory = {}, failureCode = null;
  if (cloudConfigurationReady) {
    try { inventory = await inspect(cloud.config); }
    catch (error) {
      const allowed = new Set(['OFFICIAL_SDK_UNAVAILABLE', 'OFFICIAL_AUTH_UNCONFIRMED',
        'ENVIRONMENT_INVENTORY_UNCONFIRMED', 'DATABASE_DETAIL_UNCONFIRMED', 'DATABASE_ACCOUNTS_UNCONFIRMED']);
      failureCode = allowed.has(error?.message) ? error.message : 'CONTROL_PLANE_UNCONFIRMED';
    }
  } else failureCode = 'CLOUD_CONFIGURATION_NOT_READY';
  const result = validateMiniPrivateDatabase({ appId: cloud.config?.WXCLOUD_APP_ID,
    envId: target.cloudEnvId, config: payment.config, ...inventory });
  return { ...result, checkedAt: checkedAt(),
    paymentConfigFileReadable: payment.readable === true,
    cloudConfigFileReadable: cloud.readable === true,
    cloudConfigurationReady,
    cloudConfigurationMissing: missingCloudConfigFields.length > 0,
    missingCloudConfigFields,
    preflightPassed: result.preflightPassed && payment.readable === true && cloudConfigurationReady,
    failureCode,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await main();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.preflightPassed) process.exitCode = 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ check: 'miniPrivateDatabaseDeploymentPreflight',
      preflightPassed: false, changedRemoteState: false, failureCode: 'PREFLIGHT_UNCONFIRMED',
      transportEncryption: false, privateNetworkEvidenceProvesTls: false })}\n`);
    process.exitCode = 1;
  }
}
