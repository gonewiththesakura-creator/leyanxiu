// One env0 identity preparation only. No payment, photo or cloud configuration
// operations. The only server writes are one login and its logout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { officialCommand, validateProbeConfig } from './probe-mini-closed-client.mjs';

const exec = promisify(execFile);
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fail = code => { throw new Error(code); };
const validUser = value => typeof value === 'string' && /^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

// Serialized for official automation_evaluate; no imports or raw error output.
export function startMerchantIdentityProbe(config) {
  const slot = '__leyanxiuMerchantIdentityProbeV1';
  if (globalThis[slot]) return { identityProbeVersion: 1, alreadyStarted: true, pending: false };
  const report = { identityProbeVersion: 1, started: true, pending: true, completed: false,
    ok: false, runtimeMatched: false, healthEnv0Closed: false, loginAttempted: false,
    loginConfirmed: false, logoutAttempted: false, logoutConfirmed: false,
    cleanupUnconfirmed: false, calls: 0, failure: '' };
  const state = globalThis[slot] = { nonce: config.nonce, report, privateUserId: null };
  let session;
  const bad = code => { throw Object.assign(new Error(code), { probeCode: code }); };
  const bounded = value => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { probeCode: 'timeout' })), 17000);
    Promise.resolve(value).then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); });
  });
  const request = async (route, method, data, token) => {
    if (!(route === '/health' && method === 'GET' && report.calls === 0
      || route === '/api/auth/wechat' && method === 'POST' && report.healthEnv0Closed && !report.loginAttempted
      || route === '/api/auth/logout' && method === 'POST' && session?.token && !report.logoutAttempted)) bad('request_blocked');
    if (route === '/api/auth/wechat') report.loginAttempted = true;
    if (route === '/api/auth/logout') report.logoutAttempted = true;
    report.calls++;
    const result = await bounded(wx.cloud.callContainer({ config: { env: config.target.envId },
      path: route + '?' + encodeURIComponent(config.gray.key) + '=' + encodeURIComponent(config.gray.value),
      method, data, timeout: 15000,
      header: { 'Content-Type': 'application/json', 'X-WX-SERVICE': config.target.serviceName,
        ...(token ? { Authorization: 'Bearer ' + token } : {}) } }));
    if (typeof result?.data === 'string') {
      if (result.data.length > 65536) bad('response_invalid');
      try { result.data = JSON.parse(result.data); } catch { bad('response_invalid'); }
    }
    if (result?.statusCode !== 200) bad('response_rejected');
    if (route === '/health') return result.data;
    if (result?.data?.code !== 0) bad('response_rejected');
    return result.data.data;
  };
  void (async () => {
    try {
      const app = getApp(), account = wx.getAccountInfoSync();
      const device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
      const pages = getCurrentPages();
      if (account?.miniProgram?.appId !== config.target.appId || device?.platform !== 'devtools'
        || pages[pages.length - 1]?.route !== 'pages/refund-ops/index'
        || app?.globalData?.apiTransport?.mode !== 'cloud'
        || app.globalData.apiTransport.env !== config.target.envId
        || app.globalData.apiTransport.service !== config.target.serviceName
        || typeof wx.cloud?.callContainer !== 'function') bad('runtime_mismatch');
      report.runtimeMatched = true;
      const h = await request('/health', 'GET');
      if (h?.ok !== true || h.service !== 'mini-photo-production' || h.env !== 0 || h.mode !== 'closed'
        || h.ledgerOnlySandbox !== false || h.accepting !== true || h.payment?.prepared !== true
        || h.payment?.operationsReady !== true || h.photo?.prepared !== true
        || h.productionPaymentsEnabled !== false || h.salesEnabled !== false
        || h.generationAvailable !== false || h.photo?.generationEnabled !== false || h.photo?.available !== false) bad('health_not_env0_closed');
      report.healthEnv0Closed = true;
      const native = await bounded(new Promise((resolve, reject) => wx.login({ timeout: 10000, success: resolve, fail: reject })));
      if (typeof native?.code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(native.code)) bad('native_login_invalid');
      session = await request('/api/auth/wechat', 'POST', { code: native.code });
      if (typeof session?.token !== 'string' || !session.token || session.token.length > 4096
        || typeof session?.user?.id !== 'string'
        || !/^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(session.user.id)) bad('identity_invalid');
      report.loginConfirmed = true;
      state.privateUserId = session.user.id;
    } catch (error) {
      report.failure = ['runtime_mismatch', 'health_not_env0_closed', 'request_blocked', 'response_invalid',
        'response_rejected', 'native_login_invalid', 'identity_invalid', 'timeout'].includes(error?.probeCode) ? error.probeCode : 'unconfirmed';
    } finally {
      if (typeof session?.token === 'string' && session.token) {
        try { const result = await request('/api/auth/logout', 'POST', undefined, session.token); report.logoutConfirmed = result?.loggedOut === true; } catch {}
      }
      session = undefined;
      report.cleanupUnconfirmed = report.loginAttempted && !report.logoutConfirmed;
      report.ok = report.runtimeMatched && report.healthEnv0Closed && report.loginConfirmed && report.logoutConfirmed && report.calls === 3 && !report.failure;
      if (!report.ok) state.privateUserId = null;
      report.pending = false; report.completed = true;
    }
  })();
  return { identityProbeVersion: 1, started: true, pending: true };
}

export function pollMerchantIdentityProbe(nonce) {
  const state = globalThis.__leyanxiuMerchantIdentityProbeV1;
  if (!state || state.nonce !== nonce) return { identityProbeVersion: 1, started: false, pending: false };
  // Only the local caller receives this projection; it must never print it.
  return { ...state.report, ...(state.report.ok ? { privateUserId: state.privateUserId } : {}) };
}

export function privateIdentityRecord(result, { capturedAt = new Date().toISOString(), sameAccountRefundOperator = false } = {}) {
  if (sameAccountRefundOperator !== true || result?.identityProbeVersion !== 1 || result.ok !== true
    || result.completed !== true || result.pending !== false || result.runtimeMatched !== true
    || result.healthEnv0Closed !== true || result.loginConfirmed !== true || result.logoutConfirmed !== true
    || result.cleanupUnconfirmed !== false || result.calls !== 3 || result.failure !== '' || !validUser(result.privateUserId)) fail('IDENTITY_RESULT_INVALID');
  return { version: 1, purpose: 'mini-env0-merchant-identities', capturedAt, env: 0,
    source: 'official-devtools-env0-closed-login', env0Verified: true, logoutConfirmed: true,
    sameAccountRefundOperatorExplicitlyAuthorized: true,
    testUserIds: [result.privateUserId], refundOperatorUserIds: [result.privateUserId] };
}

function privatePath(filename, absent = false) {
  if (!path.isAbsolute(filename)) fail('IDENTITY_PRIVATE_PATH_REQUIRED');
  try { execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true }); }
  catch { fail('IDENTITY_PRIVATE_PATH_REQUIRED'); }
  if (absent && fs.existsSync(filename)) fail('IDENTITY_ATTEMPT_EXISTS');
}
function privateRead(filename) {
  privatePath(filename);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || fs.realpathSync(filename) !== path.resolve(filename)) fail('IDENTITY_PRIVATE_FILE_INVALID');
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function privateCreate(filename, value) {
  privatePath(filename, true);
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) fail('IDENTITY_ACL_UNCONFIRMED');
      execFileSync('icacls.exe', [filename, '/inheritance:r', '/grant:r', '*' + sid + ':(F)', '*S-1-5-18:(F)'], { stdio: 'pipe', windowsHide: true });
    }
    fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
async function evaluate(project, fn, argsFile, marker = 'identityProbeVersion') {
  const command = officialCommand('automation_evaluate', ['--project', project, '--fn-source', fn.toString(), '--args-file', argsFile]);
  const result = await exec(command.executable, command.args, command.options);
  const envelope = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
  if (envelope.ok !== true || envelope.tool !== 'automation_evaluate' || envelope.clientName !== 'codex-leyanxiu' || envelope.result?.success !== true) fail('IDENTITY_OFFICIAL_TOOL_UNCONFIRMED');
  let value = envelope.result;
  for (let i = 0; i < 5; i++, value = value?.result) if (value?.[marker] === 1) return value;
  fail('IDENTITY_OFFICIAL_TOOL_UNCONFIRMED');
}

// Shared official transport and private-file handling; importing is inert.
export { privatePath, privateRead, privateCreate, evaluate as evaluateOfficialProbe };
function saveResult(outputFile, result, sameAccountRefundOperator) {
  const record = privateIdentityRecord(result, { sameAccountRefundOperator });
  privateCreate(outputFile, record);
  return { privateFile: outputFile, env0Verified: true, logoutConfirmed: true,
    testUserCount: 1, refundOperatorCount: 1, sameAccountExplicitlyAuthorized: true,
    paymentCalled: false, generationCalled: false };
}
// Queries the recorded attempt only. It can never restart a login or replay a route.
export async function recoverIdentityProbe({ outputFile, sameAccountRefundOperator = false }) {
  if (!sameAccountRefundOperator) fail('IDENTITY_SCOPE_REQUIRED');
  privatePath(outputFile, true);
  const attempt = privateRead(outputFile + '.attempt.json');
  if (attempt.version !== 1 || attempt.status !== 'attempted-do-not-replay'
    || !path.isAbsolute(attempt.project) || !/^[a-f0-9]{32}$/.test(attempt.nonce)) fail('IDENTITY_ATTEMPT_INVALID');
  const pollFile = outputFile + '.recovery-' + crypto.randomBytes(8).toString('hex') + '.json';
  privateCreate(pollFile, [attempt.nonce]);
  try {
    const result = await evaluate(attempt.project, pollMerchantIdentityProbe, pollFile);
    if (result.pending) return { pending: true, env0Verified: false, queryOnly: true };
    return saveResult(outputFile, result, sameAccountRefundOperator);
  } finally { try { fs.unlinkSync(pollFile); } catch {} }
}
export async function runIdentityProbe({ routeFile, outputFile, project, sameAccountRefundOperator = false }) {
  if (!sameAccountRefundOperator || !path.isAbsolute(project)) fail('IDENTITY_SCOPE_REQUIRED');
  const config = validateProbeConfig(privateRead(routeFile));
  const projectConfig = JSON.parse(fs.readFileSync(path.join(project, 'project.config.json'), 'utf8'));
  const app = JSON.parse(fs.readFileSync(path.join(project, 'app.json'), 'utf8'));
  if (projectConfig.appid !== config.target.appId || projectConfig.compileType !== 'miniprogram'
    || app.pages?.[0] !== 'pages/refund-ops/index') fail('IDENTITY_SAFE_START_REQUIRED');
  privatePath(outputFile, true); privatePath(outputFile + '.attempt.json', true);
  const nonce = crypto.randomBytes(16).toString('hex');
  privateCreate(outputFile + '.attempt.json', { version: 1, nonce, project, startedAt: new Date().toISOString(), status: 'attempted-do-not-replay' });
  const argsFile = outputFile + '.args.json', pollFile = outputFile + '.poll.json';
  privateCreate(argsFile, [{ ...config, nonce }]); privateCreate(pollFile, [nonce]);
  try {
    let result = await evaluate(project, startMerchantIdentityProbe, argsFile);
    if (result.started !== true || result.alreadyStarted) fail('IDENTITY_ALREADY_STARTED');
    const deadline = Date.now() + 90000;
    while (result.pending && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      result = await evaluate(project, pollMerchantIdentityProbe, pollFile);
    }
    if (result.pending) fail('IDENTITY_PENDING_QUERY_ONLY');
    return saveResult(outputFile, result, sameAccountRefundOperator);
  } finally {
    for (const filename of [argsFile, pollFile]) { try { fs.unlinkSync(filename); } catch {} }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length || args.length === 1 && args[0] === '--plan') console.log(JSON.stringify({ planOnly: true,
    requests: ['GET health', 'one wx.login and POST auth/wechat', 'POST auth/logout'], env: 0,
    startupPage: 'pages/refund-ops/index', writes: 'new ignored ACL private identity record and attempt journal', paymentCalled: false, generationCalled: false }));
  else if (args.length === 5 && args[0] === '--run' && args[4] === '--same-account-refund-operator') {
    runIdentityProbe({ routeFile: path.resolve(args[1]), outputFile: path.resolve(args[2]), project: path.resolve(args[3]), sameAccountRefundOperator: true })
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(/^IDENTITY_[A-Z_]+$/.test(error?.message) ? error.message : 'IDENTITY_UNCONFIRMED'); process.exitCode = 1; });
  } else if (args.length === 3 && args[0] === '--poll' && args[2] === '--same-account-refund-operator') {
    recoverIdentityProbe({ outputFile: path.resolve(args[1]), sameAccountRefundOperator: true })
      .then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(/^IDENTITY_[A-Z_]+$/.test(error?.message) ? error.message : 'IDENTITY_UNCONFIRMED'); process.exitCode = 1; });
  } else { console.error('IDENTITY_ARGUMENT_INVALID'); process.exitCode = 1; }
}
