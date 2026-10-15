import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { virtualRuntime } from '../payments/virtual/runtime.js';
import { miniSandboxConfig } from '../payments/virtual/mini-sandbox-service.js';
import { parseVirtualProducts } from '../payments/virtual/products.js';
import { createPhotoCandidateHost } from './candidate-host.js';
import { photoCandidatePublicProfile } from './candidate-public.js';
import { createPhotoApplication } from './application.js';
import { createPhotoGenerationLifecycle } from './generation-lifecycle.js';
import { createPhotoUploadOssStorage, createPhotoCleanupOssStorage } from './upload-storage.js';
import { createPhotoOutputOssStorage } from './output-storage.js';
import { createPhotoImageModerator, createOssModerationStorage, createGreenImageTransport } from './moderation.js';
import { createQwenPhotoProvider, checkedQwenPhotoResultUrl, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_MODEL, QWEN_PHOTO_RESULT_POLICY } from './qwen-provider.js';
import { createPhotoImageMarker } from './image-marker.js';

const fail = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const script = fileURLToPath(new URL('../mark-ai.py', import.meta.url));
const identifier = (value, max = 128) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const bool = (env, name) => { if (env[name] === undefined || env[name] === '') return false;
  if (!['true', 'false'].includes(env[name])) throw fail('PHOTO_CANDIDATE_BOOLEAN_INVALID'); return env[name] === 'true'; };
const number = (value, fallback, minimum, maximum) => {
  if (value !== undefined && !/^[0-9]+$/.test(value)) throw fail('PHOTO_CANDIDATE_NUMBER_INVALID');
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) throw fail('PHOTO_CANDIDATE_NUMBER_INVALID'); return result;
};
const keys = (value, allowed) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).every(name => allowed.includes(name));
function pinnedJson(filename, digest, maximum = 65536) {
  if (!path.isAbsolute(filename || '') || !/^[a-f0-9]{64}$/.test(digest || '')) throw fail('PHOTO_CANDIDATE_PINNED_FILE_REQUIRED');
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum || stat.size < 2) throw fail('PHOTO_CANDIDATE_PINNED_FILE_INVALID');
    const bytes = fs.readFileSync(filename);
    if (bytes.length !== stat.size || hash(bytes) !== digest) throw fail('PHOTO_CANDIDATE_PINNED_FILE_MISMATCH');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) { throw fail(/^PHOTO_CANDIDATE_PINNED_FILE_/.test(error?.code) ? error.code : 'PHOTO_CANDIDATE_PINNED_FILE_UNCONFIRMED'); }
}

/** Host-owned configuration only. No dotenv, SDK construction, SQL, timers or
 * network. The pinned JSON is actual reviewed policy, never a generated proof.
 * Missing/failed image acceptance is handled by readiness, not payment startup.
 */
export function photoCandidateConfig(env = process.env) {
  // SDK/Node debug streams can print signed URLs, request headers or secrets
  // independently of our logger. Fail before any SDK/runtime construction.
  if (['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].some(name => typeof env[name] === 'string' && env[name].length > 0)) {
    throw fail('PHOTO_CANDIDATE_DEBUG_DISABLED');
  }
  const sandbox = miniSandboxConfig(env);
  if (env.XPAY_MODE !== 'closed' || sandbox.purchaseEnabled) throw fail('PHOTO_CANDIDATE_SALES_MUST_BE_CLOSED');
  if (!/^wx[a-z0-9]{16}$/.test(env.WECHAT_APP_ID || '') || !env.WECHAT_APP_SECRET
    || !/^[a-f0-9]{64}$/i.test(env.XPAY_SESSION_ENCRYPTION_KEY || '') || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    throw fail('PHOTO_CANDIDATE_IDENTITY_CONFIG_REQUIRED');
  }
  const generationEnabled = bool(env, 'PHOTO_CANDIDATE_GENERATION_ENABLED');
  const processEnabled = bool(env, 'PHOTO_CANDIDATE_PROCESS_ENABLED');
  const cleanupEnabled = bool(env, 'PHOTO_CANDIDATE_CLEANUP_ENABLED');
  const reconcileEnabled = bool(env, 'XPAY_RECONCILE_ENABLED');
  if (processEnabled && !generationEnabled) throw fail('PHOTO_CANDIDATE_PROCESS_REQUIRES_GENERATION');
  if (generationEnabled && !sandbox.testUserIds.length) throw fail('PHOTO_CANDIDATE_TEST_ALLOWLIST_REQUIRED');
  const document = pinnedJson(env.PHOTO_CANDIDATE_CONFIG_FILE, env.PHOTO_CANDIDATE_CONFIG_SHA256);
  if (!keys(document, ['version', 'policy', 'approvedEffects', 'moderationPolicy', 'cleanupPolicy']) || document.version !== 1) {
    throw fail('PHOTO_CANDIDATE_POLICY_REQUIRED');
  }
  const p = document.policy, m = document.moderationPolicy, c = document.cleanupPolicy;
  if (!keys(p, ['approved', 'reviewReference', 'acceptanceVersion', 'serviceProviderCode', 'provider', 'model', 'resultUrlPolicy',
    'sourceHosts', 'operation', 'basicVersion', 'faceVersion', 'labelVersion', 'moderationVersion', 'moderationService',
    'sourceRetentionMs', 'resultRetentionMs', 'maxDailyUploads', 'maxDailyUploadsPerUser'])
    || p.approved !== true || !identifier(p.reviewReference) || !identifier(p.acceptanceVersion, 80)
    || p.serviceProviderCode !== env.WECHAT_APP_ID || p.provider !== QWEN_PHOTO_PROVIDER || p.model !== QWEN_PHOTO_MODEL
    || p.resultUrlPolicy !== QWEN_PHOTO_RESULT_POLICY || p.operation !== 'edit' || p.moderationService !== 'aigcCheck'
    || ![p.basicVersion, p.faceVersion, p.labelVersion, p.moderationVersion].every(value => identifier(value, 80))
    || ![p.sourceRetentionMs, p.resultRetentionMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 30 * 86400000)
    || ![p.maxDailyUploads, p.maxDailyUploadsPerUser].every(value => Number.isSafeInteger(value) && value > 0 && value <= 100000)
    || p.maxDailyUploadsPerUser > p.maxDailyUploads || !Array.isArray(p.sourceHosts) || !p.sourceHosts.length
    || !p.sourceHosts.every(value => { try { return typeof value === 'string' && checkedQwenPhotoResultUrl(`https://${value}/fixture.png`).hostname === value; } catch { return false; } })) {
    throw fail('PHOTO_CANDIDATE_POLICY_REQUIRED');
  }
  if (!keys(m, ['approved', 'version', 'region', 'services', 'lowRisk', 'timeoutMs', 'maxBytes']) || m.approved !== true
    || m.version !== p.moderationVersion || !keys(m.services, ['input', 'output'])
    || m.services.input !== 'baselineCheck' || m.services.output !== 'aigcCheck' || m.lowRisk !== 'review'
    || !Number.isSafeInteger(m.timeoutMs) || m.timeoutMs < 10 || m.timeoutMs > 30000
    || m.maxBytes !== 20 * 1024 * 1024) throw fail('PHOTO_CANDIDATE_MODERATION_POLICY_REQUIRED');
  const region = String(env.OSS_REGION || '').replace(/^oss-/, '');
  if (!['cn-shanghai', 'cn-beijing', 'cn-hangzhou', 'cn-shenzhen'].includes(region) || m.region !== region
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(env.OSS_BUCKET || '')) throw fail('PHOTO_CANDIDATE_STORAGE_CONFIG_REQUIRED');
  if (!keys(c, ['timeoutMs', 'retryAfterMs', 'recheckAfterMs', 'inFlightGraceMs'])
    || !Number.isSafeInteger(c.timeoutMs) || c.timeoutMs < 10 || c.timeoutMs > 30000
    || !Number.isSafeInteger(c.retryAfterMs) || c.retryAfterMs < 1000 || c.retryAfterMs > 86400000
    || !Number.isSafeInteger(c.recheckAfterMs) || c.recheckAfterMs < c.retryAfterMs || c.recheckAfterMs > 7 * 86400000
    || !Number.isSafeInteger(c.inFlightGraceMs) || c.inFlightGraceMs < 300000 || c.inFlightGraceMs > 86400000) throw fail('PHOTO_CANDIDATE_CLEANUP_POLICY_REQUIRED');
  const effects = document.approvedEffects;
  if (!Array.isArray(effects) || effects.length > 100 || new Set(effects.map(effect => effect?.id)).size !== effects.length
    || effects.some(effect => !keys(effect, ['id', 'version', 'provider', 'model', 'purpose', 'parameters', 'enabled', 'approved', 'reviewReference', 'title', 'subtitle'])
      || effect.approved !== true || effect.enabled !== true || !identifier(effect.id, 80) || !identifier(effect.version, 80)
      || !identifier(effect.reviewReference) || effect.provider !== p.provider || effect.model !== p.model
      || effect.purpose !== `photo-effect:${effect.id}` || typeof effect.title !== 'string' || !effect.title.trim() || effect.title.length > 100
      || (effect.subtitle !== undefined && (typeof effect.subtitle !== 'string' || effect.subtitle.length > 300))
      || !keys(effect.parameters, ['prompt', 'negativePrompt', 'size', 'seed', 'n', 'watermark', 'promptExtend'])
      || typeof effect.parameters.prompt !== 'string' || !effect.parameters.prompt.trim() || effect.parameters.prompt.length > 1000
      || typeof effect.parameters.negativePrompt !== 'string' || effect.parameters.negativePrompt.length > 500
      || !['1024*1024', '960*1280', '1280*960'].includes(effect.parameters.size) || effect.parameters.n !== 1
      || effect.parameters.watermark !== true || effect.parameters.promptExtend !== false
      || (effect.parameters.seed !== undefined && (!Number.isInteger(effect.parameters.seed) || effect.parameters.seed < 0 || effect.parameters.seed > 2147483647)))) {
    throw fail('PHOTO_CANDIDATE_EFFECTS_REQUIRED');
  }
  const acceptanceFile = env.PHOTO_CANDIDATE_ACCEPTANCE_FILE || null, acceptanceSha256 = env.PHOTO_CANDIDATE_ACCEPTANCE_SHA256 || null;
  if (Boolean(acceptanceFile) !== Boolean(acceptanceSha256) || (acceptanceFile && (!path.isAbsolute(acceptanceFile) || !/^[a-f0-9]{64}$/.test(acceptanceSha256)))) {
    throw fail('PHOTO_CANDIDATE_ACCEPTANCE_CONFIG_INVALID');
  }
  const python = env.PYTHON_PATH || (process.platform === 'win32' ? '' : '/usr/bin/python3');
  const font = env.AI_MARK_FONT || (process.platform === 'win32' ? 'C:\\Windows\\Fonts\\msyh.ttc' : '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc');
  if (!path.isAbsolute(python) || !path.isAbsolute(font)) throw fail('PHOTO_CANDIDATE_MARKER_PATH_REQUIRED');
  let products; try { products = parseVirtualProducts(env.XPAY_PRODUCTS_JSON || '[]'); } catch { throw fail('PHOTO_CANDIDATE_PRODUCTS_INVALID'); }
  return freeze({ ...structuredClone(document), products, testUserIds: [...sandbox.testUserIds], purchaseEnabled: false,
    appId: env.WECHAT_APP_ID, generationEnabled, processEnabled, cleanupEnabled, reconcileEnabled, region,
    bucket: env.OSS_BUCKET, python, font, acceptanceFile, acceptanceSha256, publicProfile: photoCandidatePublicProfile({ env, policy: p }),
    port: number(env.PORT, 3000, 1, 65535), hostname: ['0.0.0.0', '127.0.0.1', '::1'].includes(env.BIND_HOST || '0.0.0.0') ? env.BIND_HOST || '0.0.0.0' : (() => { throw fail('PHOTO_CANDIDATE_BIND_INVALID'); })(),
    intervalMs: number(env.PHOTO_CANDIDATE_INTERVAL_MS, 30000, 1000, 300000),
    storageTimeoutMs: number(env.PHOTO_CANDIDATE_STORAGE_TIMEOUT_MS, 4000, 10, 10000) });
}

/** Read-only marker/probe inspection. A successful check is cached only while
 * the actual executable, script and configured font file identities stay the
 * same. Evidence bytes are pinned anew on every inspection, never synthesized.
 */
export function createPhotoCandidateInspector(config, { execute = execFile } = {}) {
  let fingerprint, check;
  const inspectMarker = async () => {
    let signature;
    try { signature = [config.python, config.font, script].map(filename => { const s = fs.statSync(filename, { bigint: true });
      if (!s.isFile()) throw fail('PHOTO_CANDIDATE_MARKER_UNAVAILABLE'); return `${filename}:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }).join('|'); }
    catch { return false; }
    if (signature !== fingerprint) {
      fingerprint = signature;
      check = new Promise(resolve => {
        const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL']
          .filter(name => process.env[name]).map(name => [name, process.env[name]]));
        env.PYTHONIOENCODING = 'utf-8'; env.AI_MARK_FONT = config.font;
        try { execute(config.python, [script, '--check-font'], { env, windowsHide: true, timeout: 10000, maxBuffer: 65536 }, error => resolve(!error)); }
        catch { resolve(false); }
      });
    }
    return check;
  };
  return async () => {
    const ready = await inspectMarker(), p = config.policy;
    let providerEvidence;
    try {
      if (config.acceptanceFile) {
        const report = pinnedJson(config.acceptanceFile, config.acceptanceSha256);
        providerEvidence = { provider: report.provider, model: report.model, version: report.probeVersion,
          resultUrlPolicy: report.resultUrlPolicy, labelVersion: report.labelVersion, moderationVersion: report.moderationVersion,
          moderationService: report.moderationServices?.output, report };
      }
    } catch { /* Failed/missing evidence cannot open generation; cleanup remains. */ }
    return { marker: { ready, python: ready, pillow: ready, chineseFont: ready,
      labelVersion: p.labelVersion, operation: p.operation, serviceProviderCode: p.serviceProviderCode }, providerEvidence };
  };
}

/** SDK construction alone performs no provider/OSS calls. Track raw calls too:
 * the moderator's own deadline may return before a late scratch PUT resolves.
 */
export function createPhotoCandidatePorts(config, env = process.env) {
  for (const name of ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'DASHSCOPE_API_KEY']) {
    if (typeof env[name] !== 'string' || !env[name].trim()) throw fail('PHOTO_CANDIDATE_MEDIA_CREDENTIALS_REQUIRED');
  }
  const active = new Set();
  const track = operation => { const pending = Promise.resolve().then(operation); active.add(pending);
    pending.finally(() => active.delete(pending)).catch(() => {}); return pending; };
  const wrap = port => Object.fromEntries(Object.keys(port).map(name => [name, (...args) => track(() => port[name](...args))]));
  const credential = { accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
    ...(env.ALIYUN_SECURITY_TOKEN ? { securityToken: env.ALIYUN_SECURITY_TOKEN } : {}) };
  const options = { credential, bucket: config.bucket, region: config.region };
  const inputStorage = wrap(createPhotoUploadOssStorage(options));
  const outputStorage = wrap(createPhotoOutputOssStorage(options));
  const sourceCleanup = wrap(createPhotoCleanupOssStorage({ ...options, kind: 'source' }));
  const moderationCleanup = wrap(createPhotoCleanupOssStorage({ ...options, kind: 'moderation' }));
  const scratch = wrap(createOssModerationStorage(options)), transport = createGreenImageTransport(options);
  const moderator = wrap(createPhotoImageModerator({ policy: config.moderationPolicy, storage: scratch,
    transport: input => track(() => transport(input)) }));
  const provider = wrap(createQwenPhotoProvider({ apiKey: env.DASHSCOPE_API_KEY, baseUrl: env.DASHSCOPE_BASE }));
  const marker = wrap(createPhotoImageMarker({ serviceProviderCode: config.policy.serviceProviderCode,
    labelVersion: config.policy.labelVersion, python: config.python, font: config.font }));
  return { inputStorage, outputStorage, sourceCleanup, moderationCleanup, moderator, provider, marker,
    inspectPrerequisites: createPhotoCandidateInspector(config),
    async drain() { while (active.size) await Promise.allSettled([...active]); } };
}

const safeCode = error => /^(?:PHOTO|XPAY)_[A-Z0-9_]+$/.test(error?.code || error?.message)
  ? error.code || error.message : 'PHOTO_CANDIDATE_UNCONFIRMED';

/** Explicit server start; importing this file has no runtime effects. Trusted
 * injectable factories are for offline acceptance, never HTTP/env-selected.
 */
export async function startPhotoCandidateServer({ env = process.env, runtimeFactory, portsFactory = createPhotoCandidatePorts,
  listen = serve, signals = process, logger = value => console.log(JSON.stringify(value)) } = {}) {
  const config = photoCandidateConfig(env);
  if (!runtimeFactory && env !== process.env) throw fail('PHOTO_CANDIDATE_RUNTIME_ENV_REQUIRED');
  const log = (event, error) => { try { logger({ event, ...(error ? { code: safeCode(error) } : {}) }); } catch {} };
  let runtime, host, server, ports, timer, sweep, stopped = false, stopping;
  const stopSignals = () => { for (const name of ['SIGTERM', 'SIGINT']) signals.removeListener(name, signalStop); };
  const shutdown = () => {
    if (stopping) return stopping;
    stopped = true; clearTimeout(timer); stopSignals();
    // drain() synchronously closes admission before waiting for existing work.
    const drained = host?.drain();
    const closed = server ? new Promise(resolve => { server.close(() => resolve()); server.closeIdleConnections?.(); }) : Promise.resolve();
    stopping = (async () => {
      const results = await Promise.allSettled([drained, closed, sweep].filter(Boolean));
      await ports?.drain();
      // Even a rejected drain means the host waited for admitted operations;
      // never close before the underlying raw SDK promises have settled.
      await runtime?.ledger.database.close();
      if (results.some(result => result.status === 'rejected')) throw fail('PHOTO_CANDIDATE_SHUTDOWN_UNCONFIRMED');
      return { stopped: true, databaseClosed: Boolean(runtime) };
    })();
    return stopping;
  };
  function signalStop() { shutdown().catch(error => { log('photo_candidate.shutdown_failed', error); process.exitCode = 1; }); }
  try {
    ports = await portsFactory(config, env);
    runtime = await (runtimeFactory || virtualRuntime)({ allowCloudrunPrivateSandbox: true });
    if (runtime?.ledger?.database?.backend !== 'mysql' || runtime.adapter?.appId !== config.appId || runtime.adapter?.env !== 1) throw fail('PHOTO_CANDIDATE_RUNTIME_SCOPE_REQUIRED');
    host = createPhotoCandidateHost({ ...runtime, appSecret: env.WECHAT_APP_SECRET, products: config.products,
      testUserIds: config.testUserIds, publicProfile: config.publicProfile, generationEnabled: config.generationEnabled, purchaseEnabled: false,
      alert: () => log('photo_candidate.payment_operation_unconfirmed'),
      photoApplicationFactory: shared => createPhotoApplication({ ...shared,
        // Upload and generated-output receipts deliberately use different
        // reviewed services while sharing versions/identity/retention/context.
        policy: { ...config.policy, moderationService: config.moderationPolicy.services.input }, approvedEffects: config.approvedEffects,
        uploadStorage: ports.inputStorage, moderator: ports.moderator, storageTimeoutMs: config.storageTimeoutMs,
        readiness: async userId => ({ ready: config.processEnabled && config.cleanupEnabled
          && (userId === undefined || config.testUserIds.includes(userId)) }),
        cleanup: { sourceStorage: ports.sourceCleanup, moderationStorage: ports.moderationCleanup, policy: config.cleanupPolicy },
        mediaUrl: { allowedHosts: [`${config.bucket}.oss-${config.region}.aliyuncs.com`],
          sign: async ({ assetId, storageKey, expiresAt }) => ({ assetId, ...await ports.outputStorage.signedUrl(storageKey, { ttlSeconds: 60, maxExpiresAt: expiresAt }) }) },
        runProviderFactory: ({ context }) => createPhotoGenerationLifecycle({ context, policy: config.policy,
          generationEnabled: config.generationEnabled, media: { inputStorage: ports.inputStorage, outputStorage: ports.outputStorage,
            provider: ports.provider, marker: ports.marker, moderator: ports.moderator, storageTimeoutMs: config.storageTimeoutMs },
          cleanup: { moderationStorage: ports.moderationCleanup, policy: config.cleanupPolicy },
          inspectPrerequisites: ports.inspectPrerequisites, authorizeUser: async ({ userId }) => config.testUserIds.includes(userId) }) }) });
    const prepared = await host.prepare();
    if (prepared.paymentPrepared !== true) throw fail('PHOTO_CANDIDATE_PAYMENT_NOT_PREPARED');
    await new Promise((resolve, reject) => {
      try { server = listen({ fetch: host.app.fetch, port: config.port, hostname: config.hostname }, resolve);
        server.once('error', () => reject(fail('PHOTO_CANDIDATE_LISTEN_FAILED'))); }
      catch { reject(fail('PHOTO_CANDIDATE_LISTEN_FAILED')); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
    server.setTimeout(15000, socket => socket.destroy());
    server.on('error', () => { log('photo_candidate.listen_failed'); signalStop(); });
    const schedule = () => {
      if (stopped || !(config.processEnabled || config.cleanupEnabled || config.reconcileEnabled)) return;
      timer = setTimeout(() => {
        if (stopped) return;
        sweep = (async () => {
          if (config.processEnabled || config.cleanupEnabled) await host.runOnce({ process: config.processEnabled, cleanup: config.cleanupEnabled })
            .catch(error => log('photo_candidate.photo_worker_unconfirmed', error));
          // Failed photo work cannot suppress existing payment reconciliation.
          if (!stopped && config.reconcileEnabled) await host.reconcileOnce().catch(error => log('photo_candidate.reconciliation_unconfirmed', error));
        })().catch(error => log('photo_candidate.worker_unconfirmed', error)).finally(() => { sweep = undefined; schedule(); });
      }, config.intervalMs);
      timer.unref?.();
    };
    for (const name of ['SIGTERM', 'SIGINT']) signals.once(name, signalStop);
    schedule();
    log('photo_candidate.started_closed');
    return Object.freeze({ host, address: () => server.address(), shutdown,
      state: Object.freeze({ env: 1, purchaseEnabled: false, generationEnabled: config.generationEnabled,
        processEnabled: config.processEnabled, cleanupEnabled: config.cleanupEnabled, reconcileEnabled: config.reconcileEnabled }) });
  } catch (error) { await shutdown().catch(() => {}); throw fail(safeCode(error)); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('PHOTO_CANDIDATE_NO_ARGUMENTS_ALLOWED'); process.exitCode = 1; }
  else startPhotoCandidateServer().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
}
