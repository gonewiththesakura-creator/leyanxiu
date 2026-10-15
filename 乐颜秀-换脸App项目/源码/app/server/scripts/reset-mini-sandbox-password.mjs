import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { builtinSandboxMysql as target } from '../payments/virtual/mysql-transport.js';

// Default: read-only control-plane dry run. --apply changes ONLY the named
// sandbox account password. It never resumes a cluster, enables public access,
// changes grants/TLS/root, connects to SQL, deploys, or enables charging.
// An uncertain request is deliberately not retried. The private pending file
// preserves the SAME proposed password and the complete original env backup.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pendingName = '.env.mini-db-password.pending.json';
const paymentName = '.env.mini-payment';
const present = value => typeof value === 'string' && value.trim().length > 0;
const running = value => typeof value === 'string' && ['running', 'normal'].includes(value.toLowerCase());
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const codes = new Set(['MODE_INVALID', 'LOCAL_CONFIGURATION_INVALID', 'CONTROL_PLANE_SCOPE_MISMATCH',
  'PRIVATE_FILE_UNSAFE', 'PRIVATE_SAVE_FAILED', 'PENDING_INVALID', 'PENDING_REQUIRES_REVIEW',
  'PAYMENT_CONFIG_CHANGED', 'REMOTE_RESET_UNCONFIRMED', 'CONFIRMATION_NOT_SAVED', 'PROMOTION_FAILED',
  'OFFICIAL_SDK_UNAVAILABLE', 'OFFICIAL_AUTH_UNCONFIRMED', 'ENVIRONMENT_INVENTORY_UNCONFIRMED',
  'DATABASE_DETAIL_UNCONFIRMED', 'DATABASE_ACCOUNTS_UNCONFIRMED']);
const safeCode = error => codes.has(error?.message) ? error.message : 'PASSWORD_OPERATION_UNCONFIRMED';

export function validatePasswordResetScope({ payment = {}, cloud = {}, inventory = {} } = {}) {
  const matches = Array.isArray(inventory.accounts?.accounts)
    ? inventory.accounts.accounts.filter(account => account?.accountName === target.user && account.host === '%') : [];
  const checks = {
    cloudApp: cloud.WXCLOUD_APP_ID === target.appId && present(cloud.WXCLOUD_PRIVATE_KEY),
    application: payment.WECHAT_APP_ID === target.appId,
    miniProgram: payment.RELEASE_CHANNEL === 'wechat-mini-program' && payment.AUTH_MODE === 'wechat',
    sandboxClosed: payment.XPAY_ENV === '1' && ['closed', 'sandbox'].includes(payment.XPAY_MODE)
      && payment.XPAY_ENABLED === 'false',
    mysql: payment.XPAY_DB_BACKEND === 'mysql',
    environment: payment.XPAY_CLOUD_ENV_ID === target.cloudEnvId && inventory.environmentConfirmed === true,
    instance: payment.XPAY_MYSQL_INSTANCE_ID === target.instanceId && inventory.detail?.dbClusterId === target.instanceId,
    privateAddress: payment.XPAY_MYSQL_HOST === target.host && payment.XPAY_MYSQL_PORT === String(target.port)
      && inventory.detail?.netInfo?.privateNetAddress === `${target.host}:${target.port}`,
    database: payment.XPAY_MYSQL_DATABASE === target.database,
    dedicatedAccount: payment.XPAY_MYSQL_USER === target.user && matches?.length === 1,
    publicAccessClosed: inventory.detail?.dbInfo?.isOpenPubNetAccess === false
      && [null, ''].includes(inventory.detail?.netInfo?.pubNetAddress),
    running: running(inventory.detail?.dbInfo?.status) && running(inventory.accounts?.clusterStatus),
  };
  return { passed: Object.values(checks).every(value => value === true), checks };
}

export function paymentWithPassword(original, password) {
  if (!/^Aa1![A-Za-z0-9_-]{43}$/.test(password)) fail('PENDING_INVALID');
  const assignments = original.match(/^\s*(?:export\s+)?XPAY_MYSQL_PASSWORD\s*=/gm) || [];
  if (assignments.length > 1) fail('LOCAL_CONFIGURATION_INVALID');
  const updated = assignments.length
    ? original.replace(/^[\t ]*(?:export[\t ]+)?XPAY_MYSQL_PASSWORD[\t ]*=.*$/m, `XPAY_MYSQL_PASSWORD=${password}`)
    : `${original}${original.endsWith('\n') ? '' : '\n'}XPAY_MYSQL_PASSWORD=${password}\n`;
  const before = dotenv.parse(original), after = dotenv.parse(updated);
  delete before.XPAY_MYSQL_PASSWORD; delete after.XPAY_MYSQL_PASSWORD;
  if (JSON.stringify(before) !== JSON.stringify(after) || dotenv.parse(updated).XPAY_MYSQL_PASSWORD !== password) {
    fail('LOCAL_CONFIGURATION_INVALID');
  }
  return updated;
}

function validatePending(record) {
  if (!record || record.version !== 1 || JSON.stringify(record.target) !== JSON.stringify(target)
    || record.accountHost !== '%' || !['prepared', 'request_started', 'confirmed', 'promoted'].includes(record.phase)
    || typeof record.originalPayment !== 'string' || digest(record.originalPayment) !== record.originalPaymentDigest) {
    fail('PENDING_INVALID');
  }
  paymentWithPassword(record.originalPayment, record.password);
  return record;
}

function privateFiles() {
  const filename = name => path.join(server, name);
  const assertIgnored = name => {
    try { execFileSync('git', ['check-ignore', '--quiet', '--', filename(name)], { cwd: server, stdio: 'pipe', windowsHide: true }); }
    catch { fail('PRIVATE_FILE_UNSAFE'); }
  };
  const read = name => {
    const stat = fs.lstatSync(filename(name));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('PRIVATE_FILE_UNSAFE');
    return fs.readFileSync(filename(name), 'utf8');
  };
  const protect = name => {
    if (process.platform !== 'win32') return fs.chmodSync(filename(name), 0o600);
    const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
    if (!sid) fail('PRIVATE_FILE_UNSAFE');
    execFileSync('icacls.exe', [filename(name), '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'],
      { stdio: 'pipe', windowsHide: true });
  };
  const create = (name, contents) => {
    assertIgnored(name);
    let fd;
    try {
      fd = fs.openSync(filename(name), 'wx', 0o600);
      protect(name); // Restrict the empty file before writing any secret.
      fs.writeFileSync(fd, contents, 'utf8'); fs.fsyncSync(fd);
    } catch { fail('PRIVATE_SAVE_FAILED'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    if (read(name) !== contents) fail('PRIVATE_SAVE_FAILED');
  };
  const replace = (name, contents, expected) => {
    assertIgnored(name);
    if (read(name) !== expected) fail('PAYMENT_CONFIG_CHANGED');
    const temporary = `${name}.tmp-${crypto.randomBytes(8).toString('hex')}`;
    create(temporary, contents);
    try {
      if (read(name) !== expected) fail('PAYMENT_CONFIG_CHANGED');
      fs.renameSync(filename(temporary), filename(name));
      if (read(name) !== contents) fail('PRIVATE_SAVE_FAILED');
    } finally { if (fs.existsSync(filename(temporary))) fs.unlinkSync(filename(temporary)); }
  };
  return {
    readConfiguration() {
      assertIgnored(paymentName); assertIgnored('.env.mini-cloud'); assertIgnored(pendingName);
      const originalPayment = read(paymentName);
      return { originalPayment, payment: dotenv.parse(originalPayment), cloud: dotenv.parse(read('.env.mini-cloud')) };
    },
    readPending() {
      if (!fs.existsSync(filename(pendingName))) return null;
      assertIgnored(pendingName);
      const contents = read(pendingName); // Read-only, including in dry run.
      try { return JSON.parse(contents); } catch { fail('PENDING_INVALID'); }
    },
    createPending(record) { create(pendingName, `${JSON.stringify(record)}\n`); },
    updatePending(record, previous) { replace(pendingName, `${JSON.stringify(record)}\n`, `${JSON.stringify(previous)}\n`); },
    promote(record) {
      const updated = paymentWithPassword(record.originalPayment, record.password);
      if (read(paymentName) === updated) return; // Recovery after an acknowledged promotion.
      replace(paymentName, updated, record.originalPayment);
    },
  };
}

async function withOfficialCloud(cloud, operation) {
  const cliRoot = process.env.WXCLOUD_CLI_ROOT || path.join(process.env.LOCALAPPDATA || '',
    'leyanxiu-toolchains', 'wxcloud-cli', 'node_modules', '@wxcloud', 'cli');
  const require = createRequire(path.join(cliRoot, 'package.json'));
  const methods = ['log', 'error', 'warn', 'debug', 'info', 'trace', 'dir', 'table'];
  const originalConsole = Object.fromEntries(methods.map(method => [method, console[method]]));
  let auth, originalAuth, logger, originalDebug, axios, originalTimeout;
  let stage = 'OFFICIAL_SDK_UNAVAILABLE';
  try {
    for (const method of methods) console[method] = () => {};
    ({ logger } = require('./lib/utils/log.js')); originalDebug = logger.debug; logger.debug = () => {};
    axios = require('axios'); originalTimeout = axios.defaults.timeout; axios.defaults.timeout = 15000;
    auth = require('./lib/utils/auth.js'); originalAuth = auth.readLoginState;
    auth.readLoginState = async () => ({ appid: target.appId, privateKey: cloud.WXCLOUD_PRIVATE_KEY.trim() });
    stage = 'OFFICIAL_AUTH_UNCONFIRMED';
    if (!await auth.checkLoginState(target.appId, cloud.WXCLOUD_PRIVATE_KEY.trim())) fail(stage);
    require('./lib/api/adapter.js').initCloudAPI(target.appId);
    require('./lib/api/common.js').setApiCommonParameters({ region: 'ap-shanghai' });
    const { CloudAPI } = require('@wxcloud/core');
    const options = { envId: target.cloudEnvId, wxAppId: target.appId };
    stage = 'ENVIRONMENT_INVENTORY_UNCONFIRMED';
    const { EnvList } = await require('./lib/api/index.js').DescribeWxCloudBaseRunEnvs();
    const environmentConfirmed = Array.isArray(EnvList) && EnvList.some(env => env?.EnvId === target.cloudEnvId);
    const api = {
      async inspect() {
        stage = 'DATABASE_DETAIL_UNCONFIRMED';
        const detail = await CloudAPI.tcbDescribeWxCloudBaseRunDBClusterDetail(options);
        stage = 'DATABASE_ACCOUNTS_UNCONFIRMED';
        const accounts = await CloudAPI.tcbDescribeWxCloudBaseRunDBAccounts(options);
        return { environmentConfirmed, detail, accounts };
      },
      async reset(password) {
        stage = 'REMOTE_RESET_UNCONFIRMED';
        // Exact installed SDK schema: AccountName, AccountPassword, EnvId,
        // optional Host and WxAppId. Region belongs to the CLI envelope.
        return CloudAPI.tcbResetWxCloudBaseRunDBPassword({ ...options,
          accountName: target.user, host: '%', accountPassword: password });
      },
    };
    return await operation(api);
  } catch (error) {
    // Provider errors can contain complete headers/request bodies. Never emit them.
    fail(codes.has(error?.message) ? error.message : stage);
  } finally {
    if (auth && originalAuth) auth.readLoginState = originalAuth;
    if (logger && originalDebug) logger.debug = originalDebug;
    if (axios) axios.defaults.timeout = originalTimeout;
    Object.assign(console, originalConsole);
  }
}

export async function main({ mode = 'dry-run', files = privateFiles(), withCloud = withOfficialCloud,
  generatePassword = () => `Aa1!${crypto.randomBytes(32).toString('base64url')}`,
  now = () => new Date().toISOString() } = {}) {
  const result = { operation: 'dedicatedMiniSandboxPassword', mode, target, accountHost: '%',
    changedRemoteState: false, remoteResetConfirmed: false, pendingRetained: false,
    localConfigPromoted: false, sqlLoginVerified: false, permissionsChanged: false,
    sslChanged: false, deployed: false, chargingEnabled: false };
  try {
    if (!['dry-run', 'apply'].includes(mode)) fail('MODE_INVALID');
    const state = files.readConfiguration();
    const local = validatePasswordResetScope({ ...state });
    // Control-plane checks are false before inspection; reject only local fields.
    const localFields = ['cloudApp', 'application', 'miniProgram', 'sandboxClosed', 'mysql', 'database'];
    if (!localFields.every(field => local.checks[field])
      || state.payment.XPAY_CLOUD_ENV_ID !== target.cloudEnvId
      || state.payment.XPAY_MYSQL_INSTANCE_ID !== target.instanceId
      || state.payment.XPAY_MYSQL_HOST !== target.host || state.payment.XPAY_MYSQL_PORT !== String(target.port)
      || state.payment.XPAY_MYSQL_USER !== target.user) fail('LOCAL_CONFIGURATION_INVALID');
    let pending = files.readPending();
    if (pending) { validatePending(pending); result.pendingRetained = true; result.pendingPhase = pending.phase; }
    return await withCloud(state.cloud, async api => {
      const scope = validatePasswordResetScope({ ...state, inventory: await api.inspect() });
      result.checks = scope.checks; result.preflightPassed = scope.passed;
      if (!scope.passed) fail('CONTROL_PLANE_SCOPE_MISMATCH');
      if (mode === 'dry-run') return { ...result, ok: true, resetWouldBeAllowed: !pending };
      if (pending && !['confirmed', 'promoted'].includes(pending.phase)) fail('PENDING_REQUIRES_REVIEW');
      if (pending?.phase === 'promoted') {
        if (state.originalPayment !== paymentWithPassword(pending.originalPayment, pending.password)) fail('PAYMENT_CONFIG_CHANGED');
        return { ...result, ok: true, alreadyPromoted: true };
      }
      if (!pending) {
        const password = generatePassword(); paymentWithPassword(state.originalPayment, password);
        pending = { version: 1, target, accountHost: '%', phase: 'prepared', createdAt: now(),
          password, originalPayment: state.originalPayment, originalPaymentDigest: digest(state.originalPayment) };
        files.createPending(pending); result.pendingRetained = true;
        const started = { ...pending, phase: 'request_started' };
        files.updatePending(started, pending); pending = started; result.pendingPhase = started.phase;
        result.changedRemoteState = 'unconfirmed';
        let acknowledged;
        try { acknowledged = await api.reset(pending.password); }
        catch { fail('REMOTE_RESET_UNCONFIRMED'); }
        // Installed SDK returns exactly {} only after its transaction succeeds.
        if (!acknowledged || typeof acknowledged !== 'object' || Array.isArray(acknowledged)
          || Object.keys(acknowledged).length !== 0) fail('REMOTE_RESET_UNCONFIRMED');
        result.remoteResetConfirmed = true; result.changedRemoteState = true;
        const confirmed = { ...pending, phase: 'confirmed', confirmedAt: now() };
        try { files.updatePending(confirmed, pending); } catch { fail('CONFIRMATION_NOT_SAVED'); }
        pending = confirmed; result.pendingPhase = confirmed.phase;
      }
      result.remoteResetConfirmed = true;
      try { files.promote(pending); } catch { fail('PROMOTION_FAILED'); }
      result.localConfigPromoted = true;
      const promoted = { ...pending, phase: 'promoted', promotedAt: now() };
      try { files.updatePending(promoted, pending); } catch { fail('CONFIRMATION_NOT_SAVED'); }
      return { ...result, pendingPhase: 'promoted', ok: true };
    });
  } catch (error) { return { ...result, ok: false, failureCode: safeCode(error) }; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const mode = args.length === 0 || (args.length === 1 && args[0] === '--dry-run') ? 'dry-run'
    : args.length === 1 && args[0] === '--apply' ? 'apply' : 'invalid';
  const result = await main({ mode });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
