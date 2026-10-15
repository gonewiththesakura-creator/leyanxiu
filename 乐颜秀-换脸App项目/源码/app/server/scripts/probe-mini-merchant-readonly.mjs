// One new official native read-only merchant probe. The caller supplies a new
// route file only after the actual release-order routing has been read back.
// No payment, media upload, generation, consent write or cloud mutation.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateProbeConfig } from './probe-mini-closed-client.mjs';
import { privatePath, privateRead, privateCreate, evaluateOfficialProbe } from './probe-mini-merchant-identity.mjs';
import { fallbackMerchantProfile, fallbackMerchantRouteFilename, loadFallbackProbeRoute } from './mini-disclosure-fallback-probe-route.mjs';

const fail = code => { throw new Error(code); };
const marker = 'merchantReadProbeVersion';
export const threeEffectsMerchantProfile = 'three-effects-v1-20261015';
export const threeEffectsMerchantRouteFilename = '.env.mini-merchant-three-effects-probe-20261015.json';
export const default018MerchantProfile = 'default-018-three-effects-v1-20261015';
const validateProfile = profile => {
  if (profile !== undefined && profile !== threeEffectsMerchantProfile && profile !== fallbackMerchantProfile) fail('MERCHANT_PROBE_PROFILE_INVALID');
  return profile;
};
const validUser = value => typeof value === 'string' && /^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
export function merchantProbeIdentity(record) {
  if (record?.version !== 1 || record.purpose !== 'mini-env0-merchant-identities'
    || record.source !== 'official-devtools-env0-closed-login' || record.env !== 0
    || record.env0Verified !== true || record.logoutConfirmed !== true
    || record.sameAccountRefundOperatorExplicitlyAuthorized !== true
    || !Array.isArray(record.testUserIds) || record.testUserIds.length !== 1 || !validUser(record.testUserIds[0])
    || !Array.isArray(record.refundOperatorUserIds) || record.refundOperatorUserIds.length !== 1
    || record.refundOperatorUserIds[0] !== record.testUserIds[0]) fail('MERCHANT_PROBE_IDENTITY_UNCONFIRMED');
  return record.testUserIds[0];
}

// Serialized unchanged into automation_evaluate. Identity and login credentials
// exist only in the task closure; the global report contains booleans/counts.
export function startMerchantReadonlyProbe(config) {
  // Keep these constants inside the serialized function: no caller-controlled
  // effect list or slot may weaken the fixed catalog contract.
  const defaultRoute = config.profile === 'default-018-three-effects-v1-20261015';
  const fallback = config.profile === 'disclosure-fallback-three-effects-v1-20261015' || defaultRoute;
  const three = config.profile === 'three-effects-v1-20261015' || fallback;
  if (config.profile !== undefined && !three) throw new Error('MERCHANT_PROBE_PROFILE_INVALID');
  const slot = defaultRoute ? '__leyanxiuDefault018MerchantReadonlyProbeV1_20261015'
    : fallback ? '__leyanxiuDisclosureFallbackMerchantReadonlyProbeV1_20261015'
    : three ? '__leyanxiuMerchantThreeEffectsReadonlyProbeV1_20261015' : '__leyanxiuMerchantReadonlyProbeV1';
  if (globalThis[slot]) return { merchantReadProbeVersion: 1, alreadyStarted: true, pending: false };
  const report = { merchantReadProbeVersion: 1, started: true, pending: true, completed: false, ok: false,
    runtimeMatched: false, healthEnv0Merchant: false, identityMatched: false,
    loginAttempted: false, loginConfirmed: false, logoutAttempted: false, logoutConfirmed: false,
    cleanupUnconfirmed: false, readonlyConfirmed: false, generationGatesConfirmed: false,
    testUserAdmissionConfirmed: false, forbiddenRequestBlocked: false,
    paymentCalled: false, uploadCalled: false, generationCalled: false,
    calls: 0, stage: 'runtime', failure: '', reads: {} };
  if (three) Object.assign(report, { profile: config.profile, consentWriteCalled: false });
  globalThis[slot] = { nonce: config.nonce, report };
  const allowed = { '/api/mini/payments/products': 'products', '/api/catalog': 'catalog',
    '/api/capabilities': 'capabilities', '/api/mini/payments/entitlements': 'entitlements',
    '/api/mini/payments/orders': 'orders', '/api/mini/payments/refunds': 'refunds', '/api/public/compliance': 'compliance' };
  const seen = new Set(); let session, closed = false;
  const bad = code => { throw Object.assign(new Error(code), { probeCode: code }); };
  const bounded = value => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { probeCode: 'timeout' })), 17000);
    Promise.resolve(value).then(result => { clearTimeout(timer); resolve(result); }, error => { clearTimeout(timer); reject(error); });
  });
  const raw = async (route, method = 'GET', data) => {
    const read = method === 'GET' && Object.hasOwn(allowed, route) && report.identityMatched;
    if (closed || seen.has(method + route) || report.calls >= 10 || !(read
      || route === '/health' && method === 'GET' && report.calls === 0
      || route === '/api/auth/wechat' && method === 'POST' && report.healthEnv0Merchant && !report.loginAttempted
      || route === '/api/auth/logout' && method === 'POST' && session?.token && !report.logoutAttempted)) {
      report.forbiddenRequestBlocked = true; bad('request_blocked');
    }
    seen.add(method + route);
    if (route === '/api/auth/wechat') report.loginAttempted = true;
    if (route === '/api/auth/logout') report.logoutAttempted = true;
    report.calls++;
    const row = allowed[route] || (route === '/health' ? 'health' : null);
    if (row) report.reads[row] = { status: 0, ok: false };
    const result = await bounded(wx.cloud.callContainer({ config: { env: config.target.envId },
      path: defaultRoute ? route : route + '?' + encodeURIComponent(config.gray.key) + '=' + encodeURIComponent(config.gray.value),
      method, data, timeout: 15000, header: { 'Content-Type': 'application/json', 'X-WX-SERVICE': config.target.serviceName,
        ...(session?.token ? { Authorization: 'Bearer ' + session.token } : {}) } }));
    if (row) report.reads[row].status = Number.isInteger(result?.statusCode) ? result.statusCode : 0;
    if (typeof result?.data === 'string') {
      if (result.data.length > 1048576) bad('response_invalid');
      try { result.data = JSON.parse(result.data); } catch { bad('response_invalid'); }
    }
    if (result?.statusCode !== 200) bad('response_rejected');
    if (route === '/health') return result.data;
    if (result?.data?.code !== 0) bad('response_rejected');
    return result.data.data;
  };
  const text = value => typeof value === 'string' && value.trim().length > 0;
  void (async () => {
    try {
      const app = getApp(), account = wx.getAccountInfoSync();
      const device = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
      const pages = getCurrentPages();
      if (account?.miniProgram?.appId !== config.target.appId || device?.platform !== 'devtools'
        || (defaultRoute ? pages[pages.length - 1]?.route !== 'pages/mine/index'
          || pages[pages.length - 1]?.data?.connected === true || !!pages[pages.length - 1]?.client
          : pages[pages.length - 1]?.route !== 'pages/refund-ops/index')
        || app?.globalData?.creationEnabled !== true || app.globalData.apiTransport?.mode !== 'cloud'
        || app.globalData.apiTransport.env !== config.target.envId || app.globalData.apiTransport.service !== config.target.serviceName
        || typeof wx.cloud?.callContainer !== 'function') bad('runtime_mismatch');
      report.runtimeMatched = true; report.stage = 'health';
      const h = await raw('/health'), health = report.reads.health;
      if (h?.ok !== true || h.service !== 'mini-photo-production' || h.env !== 0 || h.mode !== 'merchant_test'
        || h.ledgerOnlySandbox !== false || h.accepting !== true || h.payment?.prepared !== true
        || h.payment?.operationsReady !== true || h.photo?.prepared !== true) bad('health_not_env0_merchant');
      health.salesEnabled = h.salesEnabled === true && h.productionPaymentsEnabled === true;
      health.generationEnabled = h.photo.generationEnabled === true;
      health.generationAvailable = h.generationAvailable === true && h.photo.available === true;
      health.ok = true; report.healthEnv0Merchant = true; report.stage = 'login';
      const native = await bounded(new Promise((resolve, reject) => wx.login({ timeout: 10000, success: resolve, fail: reject })));
      if (typeof native?.code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(native.code)) bad('login_invalid');
      session = await raw('/api/auth/wechat', 'POST', { code: native.code });
      if (typeof session?.token !== 'string' || !session.token || session.token.length > 4096) bad('login_invalid');
      report.loginConfirmed = true;
      if (session.user?.id !== config.expectedUserId) bad('identity_mismatch');
      report.identityMatched = true; report.stage = 'reads';
      const completed = await Promise.all(Object.entries(allowed).map(async ([route, name]) => {
        try {
          const value = await raw(route), row = report.reads[name];
          if (name === 'products') {
            row.count = Array.isArray(value?.products) ? value.products.length : 0;
            const p = value?.products?.[0], part = p?.components?.[0];
            row.exactProduct = row.count === 1 && p.id === 'photo10' && p.name === '图片处理10次包'
              && p.type === 'pack' && p.amountFen === 990 && p.days === 365 && p.components.length === 1
              && part?.kind === 'photo' && part.quantity === 10 && part.valueFen === 990;
            row.merchantMode = value?.mode === 'merchant_test' && value.ledgerOnlySandbox === false && value.autoRenew === false;
            row.androidScope = value?.purchaseProfile === 'android-only-v1' && value.supportedPlatforms?.length === 1
              && value.supportedPlatforms[0] === 'android';
            row.rulesCurrent = value?.rulesVersion === 'mini-pay-v1-20260927';
            row.available = value?.available === true;
            row.ok = row.exactProduct && row.merchantMode && row.androidScope && row.rulesCurrent && row.available;
          } else if (name === 'catalog') {
            row.count = Array.isArray(value?.photoEffects) ? value.photoEffects.length : 0;
            const effect = value?.photoEffects?.[0], mini = value?.miniProgramCreation;
            row.exactEffect = row.count === 1 && effect.id === 'natural-avatar' && effect.title === '自然 AI 头像' && effect.enabled === true;
            row.protocolsConfirmed = mini?.jobProtocol === 'photo-jobs-v1' && mini.uploadProtocol === 'photo-uploads-v1';
            row.declaredEffect = Array.isArray(mini?.photoEffectIds) && mini.photoEffectIds.length === 1 && mini.photoEffectIds[0] === 'natural-avatar';
            if (three) {
              const ids = ['natural-avatar', 'modern-comic', 'gentle-watercolor'];
              row.exactEffect = row.count === 3 && ids.every(id => {
                const matches = value.photoEffects.filter(item => item?.id === id);
                return matches.length === 1 && matches[0].enabled === true
                  && matches[0].available !== false && matches[0].included !== false;
              });
              row.declaredEffect = Array.isArray(mini?.photoEffectIds) && mini.photoEffectIds.length === 3
                && ids.every(id => mini.photoEffectIds.filter(item => item === id).length === 1);
            }
            row.available = mini?.available === true && value?.settings?.generationEnabled === true;
            row.ok = row.exactEffect && row.protocolsConfirmed && row.declaredEffect && row.available;
          } else if (name === 'capabilities') {
            row.count = Array.isArray(value) ? value.length : 0;
            row.verified = row.count === 1 && value[0]?.id === 'photo-effects' && value[0].route === '/api/mini/photo-jobs'
              && value[0].ready === true && value[0].status === 'verified';
            row.ok = row.verified;
          } else if (name === 'entitlements') {
            row.validCounts = Number.isSafeInteger(value?.available?.photo) && value.available.photo >= 0
              && Number.isSafeInteger(value?.available?.video) && value.available.video >= 0;
            row.ok = row.validCounts;
          } else if (name === 'orders' || name === 'refunds') {
            if (!Array.isArray(value)) bad('response_invalid'); row.count = value.length; row.ok = true;
          } else if (name === 'compliance') {
            row.documentsPresent = ['privacyPolicyUrl', 'userAgreementUrl', 'thirdPartyListUrl'].every(key =>
              typeof value?.[key] === 'string' && /^https:\/\//.test(value[key]));
            row.contactPresent = text(value?.operatorName) && text(value?.supportContact);
            row.consentVersionsPresent = value?.consentVersions?.basic === 'mini-photo-basic-closed-20261012'
              && value.consentVersions.faceProcessing === 'mini-photo-face-closed-20261012';
            row.retentionPresent = value?.retention?.sourceHours === 24 && value.retention.resultHours === 24
              && text(value.retention.supplierPolicy);
            row.providerMatches = Array.isArray(value?.aiServices) && value.aiServices.length === 1
              && value.aiServices[0]?.provider === 'aliyun-qwen-image' && value.aiServices[0].model === 'qwen-image-2.0-2026-03-03'
              && text(value.aiServices[0].purpose) && text(value.aiServices[0].region)
              && text(value.aiServices[0].filingReference) && value.aiServices[0].capabilities?.includes('photo-effect') === true;
            row.disclosuresComplete = value?.status === 'approved';
            if (fallback) {
              const facts = config.expectedPublicFacts;
              row.factsExactlyMatch = !!facts && ['privacyPolicyUrl', 'userAgreementUrl', 'thirdPartyListUrl', 'operatorName', 'supportContact']
                .every(key => value?.[key] === facts[key]) && value?.retention?.supplierPolicy === facts.retentionSupplierPolicy
                && Array.isArray(value?.aiServices) && Array.isArray(facts.aiServices) && value.aiServices.length === facts.aiServices.length
                && facts.aiServices.every((expected, i) => ['provider', 'model', 'purpose', 'region', 'filingReference']
                  .every(key => value.aiServices[i]?.[key] === expected[key])
                  && value.aiServices[i]?.capabilities?.length === 1 && value.aiServices[i].capabilities[0] === 'photo-effect');
            }
            row.ok = row.documentsPresent && row.contactPresent && row.consentVersionsPresent && row.retentionPresent
              && row.providerMatches && row.disclosuresComplete && (!fallback || row.factsExactlyMatch);
          }
          return row.ok === true;
        } catch { return false; }
      }));
      report.testUserAdmissionConfirmed = report.identityMatched && report.reads.products?.exactProduct === true
        && report.reads.products.merchantMode === true && report.reads.catalog?.available === true;
      report.generationGatesConfirmed = health.generationEnabled && health.generationAvailable
        && report.reads.catalog?.ok === true && report.reads.capabilities?.ok === true && report.reads.compliance?.ok === true;
      report.readonlyConfirmed = completed.every(Boolean);
      if (!report.readonlyConfirmed || !health.salesEnabled || !report.generationGatesConfirmed || !report.testUserAdmissionConfirmed) bad('gates_unconfirmed');
    } catch (error) {
      report.failure = ['runtime_mismatch', 'health_not_env0_merchant', 'request_blocked', 'response_invalid', 'response_rejected',
        'login_invalid', 'identity_mismatch', 'timeout', 'gates_unconfirmed'].includes(error?.probeCode) ? error.probeCode : 'unconfirmed';
    } finally {
      report.stage = 'logout';
      if (typeof session?.token === 'string' && session.token) {
        try { const value = await raw('/api/auth/logout', 'POST'); report.logoutConfirmed = value?.loggedOut === true; } catch {}
      }
      session = undefined; closed = true;
      report.cleanupUnconfirmed = report.loginAttempted && !report.logoutConfirmed;
      report.ok = report.readonlyConfirmed && report.generationGatesConfirmed && report.testUserAdmissionConfirmed
        && report.logoutConfirmed && !report.failure && !report.forbiddenRequestBlocked && report.calls === 10;
      report.pending = false; report.completed = true; report.stage = 'complete';
    }
  })();
  return { merchantReadProbeVersion: 1, started: true, pending: true };
}
export function pollMerchantReadonlyProbe(nonce, profile) {
  if (profile !== undefined && profile !== 'three-effects-v1-20261015' && profile !== 'disclosure-fallback-three-effects-v1-20261015'
    && profile !== 'default-018-three-effects-v1-20261015') throw new Error('MERCHANT_PROBE_PROFILE_INVALID');
  const state = profile === 'default-018-three-effects-v1-20261015'
    ? globalThis.__leyanxiuDefault018MerchantReadonlyProbeV1_20261015 : profile === 'disclosure-fallback-three-effects-v1-20261015'
    ? globalThis.__leyanxiuDisclosureFallbackMerchantReadonlyProbeV1_20261015 : profile === 'three-effects-v1-20261015'
    ? globalThis.__leyanxiuMerchantThreeEffectsReadonlyProbeV1_20261015 : globalThis.__leyanxiuMerchantReadonlyProbeV1;
  if (!state || state.nonce !== nonce) return { merchantReadProbeVersion: 1, started: false, pending: false };
  return state.report;
}

export function safeMerchantReadonlyReport(value) {
  if (value?.merchantReadProbeVersion !== 1) fail('MERCHANT_PROBE_RESULT_INVALID');
  const result = { merchantReadProbeVersion: 1 };
  if (value.profile === threeEffectsMerchantProfile || value.profile === fallbackMerchantProfile || value.profile === default018MerchantProfile) {
    result.profile = value.profile;
    if (typeof value.consentWriteCalled === 'boolean') result.consentWriteCalled = value.consentWriteCalled;
  }
  for (const key of ['started', 'alreadyStarted', 'pending', 'completed', 'ok', 'runtimeMatched', 'healthEnv0Merchant', 'identityMatched',
    'loginAttempted', 'loginConfirmed', 'logoutAttempted', 'logoutConfirmed', 'cleanupUnconfirmed', 'readonlyConfirmed',
    'generationGatesConfirmed', 'testUserAdmissionConfirmed', 'forbiddenRequestBlocked', 'paymentCalled', 'uploadCalled', 'generationCalled']) {
    if (typeof value[key] === 'boolean') result[key] = value[key];
  }
  if (Number.isSafeInteger(value.calls) && value.calls >= 0 && value.calls <= 10) result.calls = value.calls;
  if (['runtime', 'health', 'login', 'reads', 'logout', 'complete'].includes(value.stage)) result.stage = value.stage;
  if (['', 'runtime_mismatch', 'health_not_env0_merchant', 'request_blocked', 'response_invalid', 'response_rejected',
    'login_invalid', 'identity_mismatch', 'timeout', 'gates_unconfirmed', 'unconfirmed'].includes(value.failure)) result.failure = value.failure;
  result.reads = {};
  for (const name of ['health', 'products', 'catalog', 'capabilities', 'entitlements', 'orders', 'refunds', 'compliance']) {
    const row = value.reads?.[name]; if (!row) continue;
    const safe = {};
    for (const key of ['status', 'count']) if (Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= (key === 'status' ? 599 : 10000000)) safe[key] = row[key];
    for (const key of ['ok', 'salesEnabled', 'generationEnabled', 'generationAvailable', 'exactProduct', 'merchantMode', 'androidScope',
      'rulesCurrent', 'available', 'exactEffect', 'protocolsConfirmed', 'declaredEffect', 'verified', 'validCounts', 'documentsPresent',
      'contactPresent', 'consentVersionsPresent', 'retentionPresent', 'providerMatches', 'disclosuresComplete', 'factsExactlyMatch']) {
      if (typeof row[key] === 'boolean') safe[key] = row[key];
    }
    result.reads[name] = safe;
  }
  return result;
}
function saveResult(outputFile, result, profile, releaseBinding) {
  const report = safeMerchantReadonlyReport(result);
  if (report.profile !== profile) fail('MERCHANT_PROBE_PROFILE_INVALID');
  if (report.completed !== true || report.pending !== false) fail('MERCHANT_PROBE_RESULT_UNCONFIRMED');
  privateCreate(outputFile, { version: 1, capturedAt: new Date().toISOString(), report,
    ...(releaseBinding ? { releaseBinding } : {}),
    scope: profile === fallbackMerchantProfile ? 'official-native-disclosure-fallback-three-effects-readonly-contracts'
      : profile ? 'official-native-three-effects-readonly-contracts' : 'official-native-readonly-contracts',
    uiPaymentVerified: false, actualGenerationVerified: false, platformPrivacyApprovalVerified: false });
  return { reportFile: outputFile, ...report };
}
export async function runMerchantReadonlyProbe({ routeFile, identityFile, outputFile, project, profile }) {
  validateProfile(profile);
  if (profile && path.basename(routeFile) !== (profile === fallbackMerchantProfile ? fallbackMerchantRouteFilename : threeEffectsMerchantRouteFilename)) fail('MERCHANT_PROBE_NEW_ROUTE_REQUIRED');
  if (!path.isAbsolute(project) || path.basename(routeFile) === '.env.mini-closed-client-probe.json') fail('MERCHANT_PROBE_NEW_ROUTE_REQUIRED');
  const legacyRoute = profile === fallbackMerchantProfile ? null : validateProbeConfig(privateRead(routeFile));
  const expectedUserId = merchantProbeIdentity(privateRead(identityFile));
  const fallback = profile === fallbackMerchantProfile ? await loadFallbackProbeRoute(routeFile, expectedUserId) : null;
  const route = fallback ? fallback.route : legacyRoute;
  const projectConfig = JSON.parse(fs.readFileSync(path.join(project, 'project.config.json'), 'utf8'));
  const app = JSON.parse(fs.readFileSync(path.join(project, 'app.json'), 'utf8'));
  if (projectConfig.appid !== route.target.appId || projectConfig.compileType !== 'miniprogram'
    || app.pages?.[0] !== 'pages/refund-ops/index') fail('MERCHANT_PROBE_SAFE_START_REQUIRED');
  privatePath(outputFile, true); privatePath(outputFile + '.attempt.json', true);
  const nonce = crypto.randomBytes(16).toString('hex');
  privateCreate(outputFile + '.attempt.json', { version: 1, nonce, project, startedAt: new Date().toISOString(),
    ...(profile ? { profile } : {}),
    ...(fallback ? { releaseBinding: fallback.binding } : {}),
    status: 'attempted-do-not-replay', routeSha256: crypto.createHash('sha256').update(JSON.stringify(route)).digest('hex') });
  const argsFile = outputFile + '.args.json', pollFile = outputFile + '.poll.json';
  privateCreate(argsFile, [{ ...route, expectedUserId, nonce, ...(profile ? { profile } : {}),
    ...(fallback ? { expectedPublicFacts: fallback.expectedPublicFacts } : {}) }]);
  privateCreate(pollFile, profile ? [nonce, profile] : [nonce]);
  try {
    let result = await evaluateOfficialProbe(project, startMerchantReadonlyProbe, argsFile, marker);
    if (result.started !== true || result.alreadyStarted) fail('MERCHANT_PROBE_ALREADY_STARTED');
    const deadline = Date.now() + 90000;
    while (result.pending && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      result = await evaluateOfficialProbe(project, pollMerchantReadonlyProbe, pollFile, marker);
    }
    if (result.pending) fail('MERCHANT_PROBE_PENDING_QUERY_ONLY');
    return saveResult(outputFile, result, profile, fallback?.binding);
  } finally { for (const filename of [argsFile, pollFile]) { try { fs.unlinkSync(filename); } catch {} } }
}
export async function recoverMerchantReadonlyProbe({ outputFile, profile }) {
  validateProfile(profile);
  privatePath(outputFile, true);
  const attempt = privateRead(outputFile + '.attempt.json');
  if (attempt.profile !== profile) fail('MERCHANT_PROBE_PROFILE_INVALID');
  if (attempt.version !== 1 || attempt.status !== 'attempted-do-not-replay' || !path.isAbsolute(attempt.project)
    || !/^[a-f0-9]{32}$/.test(attempt.nonce) || !/^[a-f0-9]{64}$/.test(attempt.routeSha256)) fail('MERCHANT_PROBE_ATTEMPT_INVALID');
  const argsFile = outputFile + '.recovery-' + crypto.randomBytes(8).toString('hex') + '.json';
  privateCreate(argsFile, profile ? [attempt.nonce, profile] : [attempt.nonce]);
  try {
    const result = await evaluateOfficialProbe(attempt.project, pollMerchantReadonlyProbe, argsFile, marker);
    return result.pending ? { pending: true, queryOnly: true } : saveResult(outputFile, result, profile,
      profile === fallbackMerchantProfile ? attempt.releaseBinding : undefined);
  } finally { try { fs.unlinkSync(argsFile); } catch {} }
}
export const merchantReadonlyPlan = Object.freeze({ planOnly: true, privateFilesRead: false, cloudOperationPerformed: false,
  requiredRoute: 'new release URL routing verified by the caller; never reuse the closed 015 route',
  requests: ['GET health', 'one wx.login and POST auth/wechat', 'GET products/catalog/capabilities/entitlements/orders/refunds/public-compliance', 'POST auth/logout'],
  maximumCloudCalls: 10, expectedEnv: 0, expectedMode: 'merchant_test', paymentCalled: false, uploadCalled: false, generationCalled: false });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const show = result => { console.log(JSON.stringify(result)); if (result.completed && !result.ok) process.exitCode = 1; };
  const error = value => { console.error(/^MERCHANT_PROBE_[A-Z_]+$/.test(value?.message) ? value.message : 'MERCHANT_PROBE_UNCONFIRMED'); process.exitCode = 1; };
  if (!args.length || args.length === 1 && args[0] === '--plan') console.log(JSON.stringify(merchantReadonlyPlan));
  else if (args.length === 5 && args[0] === '--run') {
    runMerchantReadonlyProbe({ routeFile: path.resolve(args[1]), identityFile: path.resolve(args[2]), outputFile: path.resolve(args[3]), project: path.resolve(args[4]) }).then(show, error);
  } else if (args.length === 2 && args[0] === '--poll') recoverMerchantReadonlyProbe({ outputFile: path.resolve(args[1]) }).then(show, error);
  else error(new Error('MERCHANT_PROBE_ARGUMENT_INVALID'));
}
