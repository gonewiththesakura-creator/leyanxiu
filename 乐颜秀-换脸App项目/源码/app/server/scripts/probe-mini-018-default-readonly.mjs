// Official original miniprogram only. Default CLI is inert; no navigation or cloud writes.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { privatePath, privateRead, privateCreate, evaluateOfficialProbe } from './probe-mini-merchant-identity.mjs';
import { default018MerchantProfile, merchantProbeIdentity, startMerchantReadonlyProbe, pollMerchantReadonlyProbe,
  safeMerchantReadonlyReport } from './probe-mini-merchant-readonly.mjs';
import { fallbackPublicFacts } from './mini-disclosure-fallback-probe-route.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const project = path.join(root, 'miniprogram');
const target = Object.freeze({ appId: 'REDACTED_APP_IDENTIFIER', envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', serviceName: 'buildtest' });
const anonymousProfile = 'default-018-anonymous-v1-20261015';
const fail = () => { throw Error('DEFAULT_READONLY_UNCONFIRMED'); };
export function startDefaultAnonymousProbe(config) {
  const slot = '__leyanxiuDefault018AnonymousReadonly20261015';
  if (globalThis[slot]) return { merchantReadProbeVersion: 1, alreadyStarted: true };
  const report = { merchantReadProbeVersion: 1, started: true, pending: true, completed: false, ok: false,
    runtimeMatched: false, calls: 0, loginAttempted: false, paymentCalled: false, uploadCalled: false,
    generationCalled: false, failure: '', reads: {} };
  globalThis[slot] = { nonce: config.nonce, report };
  void (async () => {
    try {
      const app = getApp(), account = wx.getAccountInfoSync(), pages = getCurrentPages();
      if (account?.miniProgram?.appId !== config.target.appId || wx.getDeviceInfo().platform !== 'devtools'
        || app?.globalData?.creationEnabled !== true || app.globalData.apiTransport?.mode !== 'cloud'
        || app.globalData.apiTransport.env !== config.target.envId || app.globalData.apiTransport.service !== config.target.serviceName
        || pages[pages.length - 1]?.route !== 'pages/mine/index' || pages[pages.length - 1]?.data?.connected === true || !!pages[pages.length - 1]?.client) throw Error();
      report.runtimeMatched = true;
      const routes = [['health', '/health'], ['callback', '/api/mini/payments/notify/cloud'],
        ['products', '/api/mini/payments/products'], ['catalog', '/api/catalog'], ['capabilities', '/api/capabilities']];
      for (const [name, route] of routes) {
        const row = report.reads[name] = { status: 0, ok: false }; let timer;
        report.calls++;
        try {
          const response = await Promise.race([wx.cloud.callContainer({ config: { env: config.target.envId }, path: route,
            method: 'GET', timeout: 15000, header: { 'X-WX-SERVICE': config.target.serviceName } }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error()), 17000); })]);
          row.status = Number.isInteger(response?.statusCode) ? response.statusCode : 0;
          let body = response?.data;
          if (typeof body === 'string') { if (body.length > 1048576) throw Error(); body = JSON.parse(body); }
          const value = body?.data;
          if (name === 'health') row.ok = row.status === 200 && body?.ok === true && body.service === 'mini-photo-production'
            && body.env === 0 && body.mode === 'merchant_test' && body.ledgerOnlySandbox === false && body.accepting === true
            && body.payment?.prepared === true && body.payment.operationsReady === true && body.photo?.prepared === true
            && body.salesEnabled === true && body.productionPaymentsEnabled === true && body.photo.generationEnabled === true
            && body.generationAvailable === true && body.photo.available === true;
          else if (name === 'callback') row.ok = row.status === 405 && body?.ErrCode === 1 && body.ErrMsg === 'XPAY_METHOD_INVALID';
          else if (name === 'products') row.ok = row.status === 200 && body?.code === 0 && value?.mode === 'merchant_test'
            && value.ledgerOnlySandbox === false && value.available === false && Array.isArray(value.products) && value.products.length === 0;
          else if (name === 'catalog') row.ok = row.status === 200 && body?.code === 0 && value?.settings?.generationEnabled === false
            && value.miniProgramCreation?.available === false && Array.isArray(value.photoEffects) && value.photoEffects.length === 0
            && Array.isArray(value.miniProgramCreation.photoEffectIds) && value.miniProgramCreation.photoEffectIds.length === 0;
          else if (name === 'capabilities') row.ok = row.status === 200 && body?.code === 0 && Array.isArray(value)
            && value.length === 1 && value[0]?.id === 'photo-effects' && value[0].ready === false;
          if (!row.ok) throw Error();
        } finally { clearTimeout(timer); }
      }
      report.ok = report.calls === 5 && Object.values(report.reads).every(row => row.ok);
    } catch { report.failure = report.runtimeMatched ? 'unconfirmed' : 'runtime_mismatch'; }
    finally { report.pending = false; report.completed = true; }
  })();
  return { merchantReadProbeVersion: 1, started: true, pending: true };
}
export function pollDefaultAnonymousProbe(nonce) {
  const value = globalThis.__leyanxiuDefault018AnonymousReadonly20261015;
  return value?.nonce === nonce ? value.report : { merchantReadProbeVersion: 1, started: false, pending: false };
}
export function safeDefaultReport(value) {
  const report = safeMerchantReadonlyReport(value);
  if (value?.reads?.callback) report.reads.callback = { status: Number.isInteger(value.reads.callback.status)
    && value.reads.callback.status >= 0 && value.reads.callback.status <= 599 ? value.reads.callback.status : 0, ok: value.reads.callback.ok === true };
  return report;
}
const plan = Object.freeze({ planOnly: true, privateFilesRead: false, cloudOperationPerformed: false,
  originalProject: 'miniprogram', requiredPage: 'pages/mine/index, disconnected, no page client',
  anonymousMaximumCalls: 5, allowlistedMaximumCalls: 10, grayParameterUsed: false,
  paymentCalled: false, uploadCalled: false, generationCalled: false, consentWriteCalled: false });
export async function runDefaultReadonly({ outputFile, identityFile }) {
  const profile = identityFile ? default018MerchantProfile : anonymousProfile;
  privatePath(outputFile, true); privatePath(outputFile + '.attempt.json', true);
  const projectConfig = JSON.parse(fs.readFileSync(path.join(project, 'project.config.json')));
  if (projectConfig.appid !== target.appId || projectConfig.compileType !== 'miniprogram') fail();
  const expectedUserId = identityFile ? merchantProbeIdentity(privateRead(identityFile)) : undefined;
  const nonce = crypto.randomBytes(16).toString('hex');
  privateCreate(outputFile + '.attempt.json', { version: 1, profile, nonce, project, status: 'attempted-do-not-replay' });
  const argsFile = outputFile + '.args.json';
  privateCreate(argsFile, [{ target, nonce, ...(identityFile ? { profile, expectedUserId, expectedPublicFacts: fallbackPublicFacts() } : {}) }]);
  try {
    const result = await evaluateOfficialProbe(project, identityFile ? startMerchantReadonlyProbe : startDefaultAnonymousProbe, argsFile, 'merchantReadProbeVersion');
    if (result.started !== true || result.alreadyStarted) fail();
  } finally { try { fs.unlinkSync(argsFile); } catch {} }
  return pollDefaultReadonly(outputFile, true);
}
export async function pollDefaultReadonly(outputFile, wait = false) {
  privatePath(outputFile, true);
  const attempt = privateRead(outputFile + '.attempt.json');
  if (attempt.version !== 1 || attempt.project !== project || attempt.status !== 'attempted-do-not-replay'
    || !/^[a-f0-9]{32}$/.test(attempt.nonce) || ![anonymousProfile, default018MerchantProfile].includes(attempt.profile)) fail();
  const argsFile = outputFile + '.poll-' + crypto.randomBytes(8).toString('hex') + '.json';
  const anonymous = attempt.profile === anonymousProfile;
  privateCreate(argsFile, anonymous ? [attempt.nonce] : [attempt.nonce, default018MerchantProfile]);
  try {
    const deadline = Date.now() + (wait ? 95000 : 0); let report;
    do {
      report = safeDefaultReport(await evaluateOfficialProbe(project, anonymous ? pollDefaultAnonymousProbe : pollMerchantReadonlyProbe, argsFile, 'merchantReadProbeVersion'));
      if (!report.pending) break;
      if (Date.now() >= deadline) return { pending: true, queryOnly: true };
      await new Promise(resolve => setTimeout(resolve, 1000));
    } while (true);
    if (report.completed !== true || report.pending !== false) fail();
    privateCreate(outputFile, { version: 1, capturedAt: new Date().toISOString(), profile: attempt.profile, report,
      scope: 'official-original-miniprogram-default-route-readonly', grayParameterUsed: false,
      versionIdentifierReturnedByHealth: false, expectedDefaultVersion: 'buildtest-018',
      controlPlaneVersionVerificationRequired: true, callbackBusinessEventTested: false, realPaymentOrDeliveryVerified: false });
    return report;
  } finally { try { fs.unlinkSync(argsFile); } catch {} }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), show = value => { console.log(JSON.stringify(value)); if (value.completed && !value.ok) process.exitCode = 1; };
  const error = () => { console.error('DEFAULT_READONLY_UNCONFIRMED'); process.exitCode = 1; };
  if (!args.length || args.length === 1 && args[0] === '--plan') show(plan);
  else if (args.length === 2 && args[0] === '--anonymous') runDefaultReadonly({ outputFile: path.resolve(args[1]) }).then(show, error);
  else if (args.length === 3 && args[0] === '--allowlisted') runDefaultReadonly({ identityFile: path.resolve(args[1]), outputFile: path.resolve(args[2]) }).then(show, error);
  else if (args.length === 2 && args[0] === '--poll') pollDefaultReadonly(path.resolve(args[1])).then(show, error);
  else error();
}
