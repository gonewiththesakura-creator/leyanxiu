// Local plan by default. --run performs one official DevTools runtime probe.
// The only writes allowed remotely are a new WeChat login/session and its logout.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const exec = promisify(execFile);
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.resolve(server, '../miniprogram');
const install = 'C:/Program Files (x86)/Tencent/微信web开发者工具';
const target = Object.freeze({ appId: 'REDACTED_APP_IDENTIFIER', envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', serviceName: 'buildtest' });
const clientName = 'codex-leyanxiu';
const defaultPrivate = path.join(server, '.env.mini-closed-client-probe.json');
const marker = 'leyanxiu-closed-client-probe-v1';
const failures = new Set(['PROBE_ARGUMENT_INVALID', 'PROBE_PRIVATE_FILE_REQUIRED', 'PROBE_PRIVATE_FILE_INVALID',
  'PROBE_PRIVATE_FILE_NOT_IGNORED', 'PROBE_CONFIG_INVALID', 'PROBE_PROJECT_MISMATCH', 'PROBE_ALREADY_ATTEMPTED',
  'PROBE_TOOL_UNAVAILABLE', 'PROBE_TOOL_UNCONFIRMED', 'PROBE_TOOL_RESULT_INVALID', 'PROBE_TOOL_NOT_READY',
  'PROBE_RUNTIME_UNCONFIRMED', 'PROBE_RUNTIME_TIMEOUT', 'PROBE_PRIVATE_SAVE_FAILED', 'PROBE_CONFIG_ALREADY_EXISTS',
  'PROBE_REFRESH_JOURNAL_UNCONFIRMED', 'PROBE_RELEASE_ROUTE_UNCONFIRMED']);
const fail = code => { throw new Error(code); };
const safeFailure = error => failures.has(error?.message) ? error.message : 'PROBE_RUNTIME_UNCONFIRMED';

export function validateProbeConfig(value) {
  if (!value || value.version !== 1 || !value.target || Object.keys(target).some(key => value.target[key] !== target[key])
    || !value.gray || typeof value.gray.key !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.gray.key)
    || typeof value.gray.value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value.gray.value)
    || Object.keys(value).some(key => !['version', 'target', 'gray'].includes(key))
    || Object.keys(value.target).some(key => !Object.hasOwn(target, key))
    || Object.keys(value.gray).some(key => !['key', 'value'].includes(key))) fail('PROBE_CONFIG_INVALID');
  return { version: 1, target: { ...target }, gray: { key: value.gray.key, value: value.gray.value } };
}

// This function is serialized unchanged for automation_evaluate. All secrets and
// account state remain inside its task closure. The global slot contains only a
// random correlation nonce and allowlisted status/count/boolean summaries.
export function startClosedClientProbe(config) {
  const slot = '__leyanxiuClosedClientProbeV1';
  if (globalThis[slot]) return { probeVersion: 1, started: false, alreadyStarted: true };
  const report = { probeVersion: 1, started: true, pending: true, completed: false, ok: false,
    runtimeMatched: false, healthClosed: false, moduleClientUsed: false, directContractUsed: false,
    loginAttempted: false, loginConfirmed: false, logoutAttempted: false, logoutConfirmed: false,
    cleanupUnconfirmed: false, readonlyConfirmed: false, forbiddenRequestBlocked: false, calls: 0,
    stage: 'runtime', failure: '', reads: {} };
  globalThis[slot] = { nonce: config.nonce, report };
  const bad = code => { throw Object.assign(new Error(code), { probeCode: code }); };
  let session, loginCount = 0, closed = false;
  const allowed = {
    '/health': 'health', '/api/catalog': 'catalog', '/api/public/compliance': 'compliance',
    '/api/capabilities': 'capabilities', '/api/mini/payments/products': 'products',
    '/api/mini/payments/entitlements': 'entitlements', '/api/works': 'works',
    '/api/mini/payments/orders': 'orders', '/api/mini/payments/refunds': 'refunds',
  };
  const bounded = promise => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { probeCode: 'timeout' })), 17000);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  const routed = async options => {
    const method = options.method || 'GET', route = options.path;
    const permitted = method === 'GET' && Object.hasOwn(allowed, route)
      || method === 'POST' && route === '/api/auth/wechat' && report.healthClosed && !report.loginAttempted
      || method === 'POST' && route === '/api/auth/logout' && session && !report.logoutAttempted;
    if (closed || !permitted || options.config?.env !== config.target.envId
      || options.header?.['X-WX-SERVICE'] !== config.target.serviceName) {
      report.forbiddenRequestBlocked = true; bad('request_blocked');
    }
    if (route === '/api/auth/wechat') {
      if (!options.data || Object.keys(options.data).length !== 1 || typeof options.data.code !== 'string') bad('request_blocked');
      report.loginAttempted = true;
    }
    if (route === '/api/auth/logout') report.logoutAttempted = true;
    report.calls++;
    const response = await bounded(wx.cloud.callContainer({ ...options, timeout: 15000,
      path: route + '?' + encodeURIComponent(config.gray.key) + '=' + encodeURIComponent(config.gray.value) }));
    if (response && typeof response.data === 'string') {
      if (response.data.length > 1048576) bad('response_invalid');
      try { response.data = JSON.parse(response.data); } catch { bad('response_invalid'); }
    }
    if (allowed[route]) report.reads[allowed[route]] = { status: Number.isInteger(response?.statusCode) ? response.statusCode : 0, ok: false };
    return response;
  };
  const raw = async (route, method = 'GET', data, token) => {
    const response = await routed({ config: { env: config.target.envId }, path: route, method, data,
      header: { 'Content-Type': 'application/json', 'X-WX-SERVICE': config.target.serviceName,
        ...(token ? { Authorization: 'Bearer ' + token } : {}) } });
    if (response?.statusCode !== 200 || response?.data?.code !== 0) bad('response_rejected');
    return response.data.data;
  };
  const loginNative = options => {
    if (++loginCount !== 1) { report.forbiddenRequestBlocked = true; options.fail({ errMsg: 'probe relogin disabled' }); return; }
    wx.login({ ...options, timeout: 10000 });
  };
  void (async () => {
    try {
      const app = getApp(), identity = wx.getAccountInfoSync(), device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
      if (identity?.miniProgram?.appId !== config.target.appId || device?.platform !== 'devtools'
        || app?.globalData?.creationEnabled !== false || app?.globalData?.apiTransport?.mode !== 'cloud'
        || app.globalData.apiTransport.env !== config.target.envId || app.globalData.apiTransport.service !== config.target.serviceName
        || typeof wx.cloud?.callContainer !== 'function') bad('runtime_mismatch');
      report.runtimeMatched = true; report.stage = 'health';
      const response = await routed({ config: { env: config.target.envId }, path: '/health', method: 'GET',
        header: { 'X-WX-SERVICE': config.target.serviceName } });
      const h = response?.data;
      if (response?.statusCode !== 200 || h?.ok !== true || h.service !== 'mini-photo-production' || h.env !== 0
        || h.mode !== 'closed' || h.ledgerOnlySandbox !== false || h.accepting !== true
        || h.payment?.prepared !== true || h.payment?.operationsReady !== true || h.photo?.prepared !== true
        || h.productionPaymentsEnabled !== false || h.salesEnabled !== false || h.generationAvailable !== false
        || h.photo.generationEnabled !== false || h.photo.available !== false) bad('health_not_closed');
      report.healthClosed = true; report.reads.health.ok = true; report.stage = 'login';
      let createClient;
      try { if (typeof require === 'function') createClient = require('payments.js')?.createPaymentClient; } catch { /* Runtime module loader can be unavailable. */ }
      let api;
      if (typeof createClient === 'function') {
        report.moduleClientUsed = true;
        api = createClient({ cloud: { callContainer: routed }, login: loginNative },
          { mode: 'cloud', env: config.target.envId, service: config.target.serviceName });
        session = await bounded(api.login());
      } else {
        report.directContractUsed = true;
        const native = await bounded(new Promise((resolve, reject) => loginNative({ success: resolve, fail: reject })));
        session = await raw('/api/auth/wechat', 'POST', { code: native.code });
        api = { request: route => raw(route, 'GET', undefined, session.token) };
      }
      if (typeof session?.token !== 'string' || !session.token || typeof session.user?.id !== 'string' || !session.user.id) bad('login_invalid');
      report.loginConfirmed = true; report.stage = 'reads';
      const readEntries = Object.entries(allowed).filter(([, name]) => name !== 'health');
      const results = await Promise.all(readEntries.map(async ([route, name]) => {
        try {
          const value = await api.request(route);
          const row = report.reads[name];
          if (!row || row.status !== 200) bad('response_invalid');
          if (['works', 'orders', 'refunds', 'capabilities'].includes(name)) {
            if (!Array.isArray(value)) bad('response_invalid');
            row.count = value.length;
            if (name === 'capabilities') { row.allClosed = value.every(item => item?.ready === false); if (!row.allClosed) bad('not_closed'); }
          } else if (name === 'catalog') {
            row.protocolsConfirmed = value?.miniProgramCreation?.jobProtocol === 'photo-jobs-v1'
              && value.miniProgramCreation.uploadProtocol === 'photo-uploads-v1';
            row.closed = value?.settings?.generationEnabled === false && value.miniProgramCreation?.available === false;
            if (!row.protocolsConfirmed || !row.closed || !Array.isArray(value.photoEffects)) bad('response_invalid');
            row.count = value.photoEffects.length;
          } else if (name === 'products') {
            row.closed = value?.available === false && value?.mode === 'closed' && value?.ledgerOnlySandbox === false;
            row.androidScope = value?.purchaseProfile === 'android-only-v1' && Array.isArray(value.supportedPlatforms)
              && value.supportedPlatforms.length === 1 && value.supportedPlatforms[0] === 'android';
            if (!row.closed || !row.androidScope || !Array.isArray(value.products)) bad('response_invalid');
            row.count = value.products.length;
          } else if (name === 'entitlements') {
            row.validCounts = Number.isSafeInteger(value?.available?.photo) && value.available.photo >= 0
              && Number.isSafeInteger(value?.available?.video) && value.available.video >= 0;
            if (!row.validCounts) bad('response_invalid');
          } else if (name === 'compliance') {
            if (!value || typeof value !== 'object' || Array.isArray(value)) bad('response_invalid');
            row.documentsPresent = ['privacyPolicyUrl', 'userAgreementUrl', 'thirdPartyListUrl'].every(key => typeof value[key] === 'string' && value[key].startsWith('https://'));
            row.contactPresent = typeof value.supportContact === 'string' && value.supportContact.length > 0;
            row.consentVersionsPresent = typeof value.consentVersions?.basic === 'string' && typeof value.consentVersions?.faceProcessing === 'string';
            row.disclosuresComplete = value.status === 'approved';
          }
          row.ok = true; return true;
        } catch { return false; }
      }));
      report.readonlyConfirmed = results.every(Boolean);
      if (!report.readonlyConfirmed) bad('readonly_unconfirmed');
    } catch (error) {
      report.failure = ['runtime_mismatch', 'health_not_closed', 'request_blocked', 'response_invalid', 'response_rejected',
        'login_invalid', 'timeout', 'readonly_unconfirmed'].includes(error?.probeCode) ? error.probeCode : 'unconfirmed';
    } finally {
      report.stage = 'logout';
      if (typeof session?.token === 'string' && session.token) {
        try { const result = await raw('/api/auth/logout', 'POST', undefined, session.token); report.logoutConfirmed = result?.loggedOut === true; } catch {}
      }
      report.cleanupUnconfirmed = report.loginAttempted && !report.logoutConfirmed;
      session = undefined; closed = true;
      report.ok = report.readonlyConfirmed && report.logoutConfirmed && !report.forbiddenRequestBlocked;
      report.pending = false; report.completed = true; report.stage = 'complete';
    }
  })();
  return { probeVersion: 1, started: true, pending: true };
}

export function pollClosedClientProbe(nonce) {
  const state = globalThis.__leyanxiuClosedClientProbeV1;
  if (!state || state.nonce !== nonce) return { probeVersion: 1, started: false, pending: false };
  return state.report;
}

export function safeProbeReport(value) {
  if (!value || value.probeVersion !== 1) fail('PROBE_TOOL_RESULT_INVALID');
  const output = { probeVersion: 1 };
  for (const name of ['started', 'alreadyStarted', 'pending', 'completed', 'ok', 'runtimeMatched', 'healthClosed',
    'moduleClientUsed', 'directContractUsed', 'loginAttempted', 'loginConfirmed', 'logoutAttempted', 'logoutConfirmed',
    'cleanupUnconfirmed', 'readonlyConfirmed', 'forbiddenRequestBlocked']) if (typeof value[name] === 'boolean') output[name] = value[name];
  if (Number.isSafeInteger(value.calls) && value.calls >= 0 && value.calls <= 20) output.calls = value.calls;
  if (['runtime', 'health', 'login', 'reads', 'logout', 'complete'].includes(value.stage)) output.stage = value.stage;
  if (['', 'runtime_mismatch', 'health_not_closed', 'request_blocked', 'response_invalid', 'response_rejected',
    'login_invalid', 'timeout', 'readonly_unconfirmed', 'unconfirmed'].includes(value.failure)) output.failure = value.failure;
  output.reads = {};
  for (const name of ['health', 'catalog', 'compliance', 'capabilities', 'products', 'entitlements', 'works', 'orders', 'refunds']) {
    const row = value.reads?.[name]; if (!row || typeof row !== 'object') continue;
    const safe = {};
    if (Number.isInteger(row.status) && row.status >= 0 && row.status <= 599) safe.status = row.status;
    if (Number.isSafeInteger(row.count) && row.count >= 0 && row.count <= 10000000) safe.count = row.count;
    for (const key of ['ok', 'allClosed', 'protocolsConfirmed', 'closed', 'androidScope', 'validCounts',
      'documentsPresent', 'contactPresent', 'consentVersionsPresent', 'disclosuresComplete']) if (typeof row[key] === 'boolean') safe[key] = row[key];
    output.reads[name] = safe;
  }
  return output;
}

export function parseToolEnvelope(stdout, tool) {
  if (typeof stdout !== 'string' || stdout.length > 1048576) fail('PROBE_TOOL_RESULT_INVALID');
  const start = stdout.indexOf('{'); let value;
  try { value = JSON.parse(stdout.slice(start)); } catch { fail('PROBE_TOOL_RESULT_INVALID'); }
  if (value?.ok !== true || value.tool !== tool || value.clientName !== clientName || value.result?.success !== true) fail('PROBE_TOOL_UNCONFIRMED');
  let result = value.result;
  for (let i = 0; i < 5; i++) {
    if (tool === 'automation_evaluate' && result?.probeVersion === 1) return safeProbeReport(result);
    if (tool === 'check_wechatide_status' && result && Object.hasOwn(result, 'versionRelation')) return {
      versionAcceptable: ['equal', 'agent_ahead'].includes(result.versionRelation), loggedIn: result.loginExpired === false,
      tokenRequired: result.cliTokenRequired === true || result.tokenRequired === true,
    };
    result = result?.result;
  }
  fail('PROBE_TOOL_RESULT_INVALID');
}

async function ignored(filename) {
  try { await exec('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, windowsHide: true }); }
  catch { fail('PROBE_PRIVATE_FILE_NOT_IGNORED'); }
}
async function readPrivate(filename, maximumBytes = 16384) {
  await ignored(filename);
  let stat; try { stat = fs.lstatSync(filename); } catch { fail('PROBE_PRIVATE_FILE_REQUIRED'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes || fs.realpathSync(filename) !== path.resolve(filename)) fail('PROBE_PRIVATE_FILE_INVALID');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('PROBE_PRIVATE_FILE_INVALID'); }
}
async function readJournal(filename) {
  await ignored(filename);
  let stat; try { stat = fs.lstatSync(filename); } catch { fail('PROBE_PRIVATE_FILE_REQUIRED'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384 || fs.realpathSync(filename) !== path.resolve(filename)) fail('PROBE_PRIVATE_FILE_INVALID');
  let entries;
  try { entries = fs.readFileSync(filename, 'utf8').trim().split('\n').map(line => JSON.parse(line)); } catch { fail('PROBE_PRIVATE_FILE_INVALID'); }
  if (!entries.length || entries[0].marker !== marker || !/^[a-f0-9]{32}$/.test(entries[0].nonce || '')
    || entries.some(entry => entry.marker !== marker)) fail('PROBE_PRIVATE_FILE_INVALID');
  return { first: entries[0], last: entries.at(-1) };
}
async function createPrivate(filename, value) {
  await ignored(filename);
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const user = await exec('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
      const sid = user.stdout.match(/S-1-5-(?:\d+-)*\d+/)?.[0]; if (!sid) fail('PROBE_PRIVATE_SAVE_FAILED');
      await exec('icacls.exe', [filename, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { windowsHide: true });
    }
    fs.writeFileSync(descriptor, JSON.stringify(value)); fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}
export function officialCommand(tool, flags = []) {
  // Mirror the installed official wechatide.cmd bootstrap, but invoke Electron
  // directly with an argument array. No shell evaluates JS, paths or JSON.
  const executable = path.join(install, '微信开发者工具.exe');
  const entry = path.join(install, 'resources/app.asar.unpacked/js/common/cli/skill-index.js');
  const bootstrap = "const e=process.argv[1],a=process.argv.slice(2);process.argv=[process.execPath,e,'--electron'].concat(a);require(e)";
  return { executable, args: ['-e', bootstrap, entry, '-c', clientName, tool, ...flags],
    options: { cwd: install, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', cwd: server }, windowsHide: true, timeout: 25000, maxBuffer: 1048576 } };
}
async function callOfficial(tool, flags) {
  const command = officialCommand(tool, flags);
  if (!fs.existsSync(command.executable) || !fs.existsSync(command.args[2])) fail('PROBE_TOOL_UNAVAILABLE');
  let result;
  try { result = await exec(command.executable, command.args, command.options); } catch { fail('PROBE_TOOL_UNCONFIRMED'); }
  return parseToolEnvelope(result.stdout, tool);
}

// Pure correlation only. The caller first validates the complete private
// deployment record and its immutable backup, then passes fresh official reads.
export function probeConfigFromRelease(record, order, task) {
  const o = order?.releaseOrderInfo, values = o?.trafficTypeValues;
  if (record?.phase !== 'submitted' || record.taskId !== 2337711 || !/^[a-f0-9]{24}$/.test(record.id || '')
    || record.target?.appId !== target.appId || record.target.envId !== target.envId || record.target.serverName !== target.serviceName
    || task?.id !== 2337711 || (task.envId !== undefined && task.envId !== target.envId)
    || (task.serverName !== undefined && task.serverName !== target.serviceName)) fail('PROBE_REFRESH_JOURNAL_UNCONFIRMED');
  if (order?.isExist !== true || o?.id !== 2832312 || o.serverName !== target.serviceName
    || o.currentVersion?.versionName !== 'buildtest-013' || o.currentVersion.status !== 'normal'
    || o.releaseVersion?.versionName !== 'buildtest-015' || o.releaseVersion.status !== 'normal'
    || o.releaseStatus !== 'test' || o.isReleasing !== true || o.trafficType !== 'URL_PARAMS'
    || !Array.isArray(values) || values.length !== 1 || values[0]?.key !== 'lyx_gray_probe' || values[0].value !== record.id)
    fail('PROBE_RELEASE_ROUTE_UNCONFIRMED');
  const mirror = o.releaseVersion.urlParam;
  if (mirror && (mirror.key || mirror.value) && (mirror.key !== values[0].key || mirror.value !== values[0].value)) fail('PROBE_RELEASE_ROUTE_UNCONFIRMED');
  return validateProbeConfig({ version: 1, target: { ...target }, gray: { key: values[0].key, value: values[0].value } });
}

export async function prepareProbe(privateFile = defaultPrivate, { record, order, task, write = createPrivate, exists = fs.existsSync } = {}) {
  if (exists(privateFile) || exists(privateFile + '.run.json')) fail('PROBE_CONFIG_ALREADY_EXISTS');
  const config = probeConfigFromRelease(record, order, task);
  await write(privateFile, config);
  return { mode: 'prepare', prepared: true, releaseCorrelated: true, routeCorrelated: true,
    changedCloudConfiguration: false, createdLoginSession: false, invokedRuntime: false, sensitiveValuesPrinted: false };
}

async function prepareFromCloud(privateFile) {
  if (fs.existsSync(privateFile) || fs.existsSync(privateFile + '.run.json')) fail('PROBE_CONFIG_ALREADY_EXISTS');
  const source = path.join(server, '.env.mini-production-refresh015.json');
  const record = await readPrivate(source, 2 * 1024 * 1024), backup = await readPrivate(source + '.backup', 2 * 1024 * 1024);
  const { validateRefreshRecord } = await import('./refresh-mini-production-closed.mjs');
  try {
    validateRefreshRecord(record); validateRefreshRecord(backup);
    const mutable = new Set(['phase', 'packageName', 'packageVersion', 'taskId', 'releaseRequestedAt']);
    const immutable = value => Object.fromEntries(Object.entries(value).filter(([key]) => !mutable.has(key)));
    if (record.phase !== 'submitted' || record.taskId !== 2337711 || backup.phase !== 'prepared'
      || !isDeepStrictEqual(immutable(record), immutable(backup))) fail('PROBE_REFRESH_JOURNAL_UNCONFIRMED');
  } catch { fail('PROBE_REFRESH_JOURNAL_UNCONFIRMED'); }
  const { withProductionCloud } = await import('./inspect-mini-production-cloud.mjs');
  return withProductionCloud(async ({ CloudAPI }) => {
    const scope = { envId: target.envId, serverName: target.serviceName };
    const [orderRead, taskRead] = await Promise.allSettled([
      CloudAPI.tcbDescribeWxCloudBaseRunReleaseOrder({ ...scope, wxAppid: target.appId }),
      CloudAPI.tcbDescribeServerManageTask(scope),
    ]);
    if (orderRead.status !== 'fulfilled' || taskRead.status !== 'fulfilled') fail('PROBE_RELEASE_ROUTE_UNCONFIRMED');
    return prepareProbe(privateFile, { record, order: orderRead.value, task: taskRead.value?.task });
  });
}
export async function runProbe(privateFile, { call = callOfficial, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const config = validateProbeConfig(await readPrivate(privateFile));
  const projectConfig = JSON.parse(fs.readFileSync(path.join(project, 'project.config.json'), 'utf8'));
  if (projectConfig.appid !== target.appId || projectConfig.compileType !== 'miniprogram' || projectConfig.miniprogramRoot !== './') fail('PROBE_PROJECT_MISMATCH');
  const journal = privateFile + '.run.json';
  if (fs.existsSync(journal)) fail('PROBE_ALREADY_ATTEMPTED');
  const state = await call('check_wechatide_status', ['--skill-version', '0.3.11']);
  if (!state.versionAcceptable || !state.loggedIn || state.tokenRequired) fail('PROBE_TOOL_NOT_READY');
  const nonce = crypto.randomBytes(16).toString('hex');
  const argsFile = privateFile + '.args-' + nonce + '.json';
  const pollFile = privateFile + '.poll-' + nonce + '.json';
  let result;
  await createPrivate(journal, { marker, nonce, attemptedAt: new Date().toISOString(), status: 'uncertain' });
  try {
    await createPrivate(argsFile, [{ ...config, nonce }]); await createPrivate(pollFile, [nonce]);
    result = await call('automation_evaluate', ['--project', project, '--fn-source', startClosedClientProbe.toString(), '--args-file', argsFile]);
    if (result.started !== true || result.alreadyStarted) fail('PROBE_ALREADY_ATTEMPTED');
    const deadline = Date.now() + 90000;
    while (result.pending && Date.now() < deadline) {
      await wait(1000);
      result = await call('automation_evaluate', ['--project', project, '--fn-source', pollClosedClientProbe.toString(), '--args-file', pollFile]);
    }
    if (result.pending || result.completed !== true) fail('PROBE_RUNTIME_TIMEOUT');
    result = safeProbeReport(result);
    fs.appendFileSync(journal, '\n' + JSON.stringify({ marker, finishedAt: new Date().toISOString(), result }));
    return result;
  } finally {
    for (const filename of [argsFile, pollFile]) { try { fs.unlinkSync(filename); } catch {} }
  }
}

// Recovery after a tool/process timeout only reads the same runtime task. It
// never re-runs its function, creates another session, or reloads gray secrets.
export async function pollProbe(privateFile, { call = callOfficial } = {}) {
  const journal = privateFile + '.run.json', entries = await readJournal(journal);
  if (entries.last.result) return safeProbeReport(entries.last.result);
  const pollFile = privateFile + '.poll-' + crypto.randomBytes(16).toString('hex') + '.json';
  try {
    await createPrivate(pollFile, [entries.first.nonce]);
    const result = safeProbeReport(await call('automation_evaluate', ['--project', project, '--fn-source', pollClosedClientProbe.toString(), '--args-file', pollFile]));
    if (result.completed === true) fs.appendFileSync(journal, '\n' + JSON.stringify({ marker, finishedAt: new Date().toISOString(), result }));
    return result;
  } finally { try { fs.unlinkSync(pollFile); } catch {} }
}

async function main(args) {
  let action, privateFile = defaultPrivate;
  for (let i = 0; i < args.length; i++) {
    if (['--run', '--plan', '--poll', '--prepare'].includes(args[i])) { if (action) fail('PROBE_ARGUMENT_INVALID'); action = args[i].slice(2); }
    else if (args[i] === '--private-file' && args[i + 1]) privateFile = path.resolve(args[++i]);
    else fail('PROBE_ARGUMENT_INVALID');
  }
  if (!action || action === 'plan') return { mode: 'plan', invokesTool: false, projectConfigured: fs.existsSync(path.join(project, 'project.config.json')),
    privateConfigPresent: fs.existsSync(privateFile), createsLoginSessionWhenRun: true, queriesOnlyFixedLists: true,
    paysOrGenerates: false, mutatesCloudConfig: false, publishes: false, runRequiresFreshPrivateJournal: true };
  if (action === 'prepare') return prepareFromCloud(privateFile);
  if (action === 'poll') return { mode: 'poll', ...(await pollProbe(privateFile)) };
  return { mode: 'run', ...(await runProbe(privateFile)) };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(result => { console.log(JSON.stringify(result)); if (result.mode === 'run' && !result.ok) process.exitCode = 1; })
    .catch(error => { console.error(JSON.stringify({ ok: false, code: safeFailure(error), retryAutomatically: false })); process.exitCode = 1; });
}
