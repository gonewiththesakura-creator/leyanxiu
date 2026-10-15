import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { virtualRuntime, virtualReadiness } from '../payments/virtual/runtime.js';
import { miniProductionConfig } from '../payments/virtual/mini-production-service.js';
import { createPrivateProductionMysqlTarget, privateProductionTransport,
  virtualMysqlOptions, verifyPrivateProductionDatabase } from '../payments/virtual/mysql-transport.js';
import { photoCandidateConfig, createPhotoCandidatePorts } from './candidate-server.js';
import { createPhotoProductionHost } from './production-host.js';
import { createPhotoApplication } from './application.js';
import { createPhotoGenerationLifecycle } from './generation-lifecycle.js';

const fail = code => Object.assign(new Error(code), { code });
const bool = (env, key) => {
  if (env[key] === undefined || env[key] === '') return false;
  if (!['true', 'false'].includes(env[key])) throw fail('PHOTO_PRODUCTION_BOOLEAN_INVALID');
  return env[key] === 'true';
};
const safeCode = error => /^(?:PHOTO|XPAY)_[A-Z0-9_]+$/.test(error?.code || error?.message)
  ? error.code || error.message : 'PHOTO_PRODUCTION_UNCONFIRMED';
function refundOperators(value) {
  if (value === undefined || value === '') return Object.freeze([]);
  if (typeof value !== 'string') throw fail('XPAY_REFUND_OPERATOR_CONFIG_REQUIRED');
  const users = value.split(',').map(user => user.trim());
  if (users.length > 20 || users.some(user => !/^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(user))) {
    throw fail('XPAY_REFUND_OPERATOR_CONFIG_REQUIRED');
  }
  return Object.freeze([...new Set(users)]);
}

/** Config/pinned-file validation only. The candidate projection below reuses
 * its photo policy/storage/marker validators, not its sandbox runtime or sales
 * contract. Its artificial env1/closed values never leave this function.
 */
export function photoProductionConfig(env = process.env) {
  const production = miniProductionConfig(env);
  const refundOperatorUserIds = refundOperators(env.XPAY_REFUND_OPERATOR_USER_IDS);
  if (env.XPAY_MYSQL_TRANSPORT !== privateProductionTransport) throw fail('PHOTO_PRODUCTION_PRIVATE_PROFILE_REQUIRED');
  if (typeof env.XPAY_APP_KEY !== 'string' || !env.XPAY_APP_KEY.trim()
    || env.XPAY_APP_KEY === env.XPAY_SANDBOX_APP_KEY) throw fail('PHOTO_PRODUCTION_APP_KEY_REQUIRED');
  const productionTarget = createPrivateProductionMysqlTarget({ database: env.XPAY_MYSQL_DATABASE,
    user: env.XPAY_MYSQL_USER, accountHost: env.XPAY_MYSQL_ACCOUNT_HOST });
  const runtimeOptions = Object.freeze({ allowCloudrunPrivateProduction: true, productionTarget });
  // Validate the exact private app/environment/instance/host/account before
  // constructing any SDK/database. This does not establish cloud existence.
  virtualMysqlOptions(env, runtimeOptions);
  const generationEnabled = bool(env, 'PHOTO_PRODUCTION_GENERATION_ENABLED');
  const processEnabled = bool(env, 'PHOTO_PRODUCTION_PROCESS_ENABLED');
  const cleanupEnabled = bool(env, 'PHOTO_PRODUCTION_CLEANUP_ENABLED');
  if (processEnabled && !generationEnabled) throw fail('PHOTO_PRODUCTION_PROCESS_REQUIRES_GENERATION');
  const photo = photoCandidateConfig({ ...env, XPAY_ENV: '1', XPAY_MODE: 'closed',
    PHOTO_CANDIDATE_CONFIG_FILE: env.PHOTO_PRODUCTION_CONFIG_FILE,
    PHOTO_CANDIDATE_CONFIG_SHA256: env.PHOTO_PRODUCTION_CONFIG_SHA256,
    PHOTO_CANDIDATE_ACCEPTANCE_FILE: env.PHOTO_PRODUCTION_ACCEPTANCE_FILE,
    PHOTO_CANDIDATE_ACCEPTANCE_SHA256: env.PHOTO_PRODUCTION_ACCEPTANCE_SHA256,
    PHOTO_CANDIDATE_GENERATION_ENABLED: 'false', PHOTO_CANDIDATE_PROCESS_ENABLED: 'false',
    PHOTO_CANDIDATE_CLEANUP_ENABLED: 'false',
    PHOTO_CANDIDATE_INTERVAL_MS: env.PHOTO_PRODUCTION_INTERVAL_MS,
    PHOTO_CANDIDATE_STORAGE_TIMEOUT_MS: env.PHOTO_PRODUCTION_STORAGE_TIMEOUT_MS });
  return Object.freeze({ ...photo, env: 0, mode: production.mode, purchaseProfile: production.purchaseProfile,
    testUserIds: production.testUserIds, refundOperatorUserIds,
    generationEnabled, processEnabled, cleanupEnabled, productionTarget, runtimeOptions });
}

/** One production ledger and identity own payment and photo work. Identity
 * readiness follows prepared durable tables; refund readiness follows the
 * same identity's explicit operator list and current account binding. Optional
 * operationalReadiness may close these facts, never replace missing facts.
 */
export async function startPhotoProductionServer({ env = process.env, runtimeFactory,
  portsFactory = createPhotoCandidatePorts, readinessFactory,
  operationalReadiness = async () => ({}), requireAdmin,
  listen = serve, signals = process, timers = { setTimeout, clearTimeout },
  logger = value => console.log(JSON.stringify(value)) } = {}) {
  const sourceEnv = env; env = Object.freeze({ ...env });
  const config = photoProductionConfig(env);
  if (!runtimeFactory && sourceEnv !== process.env) throw fail('PHOTO_PRODUCTION_RUNTIME_ENV_REQUIRED');
  if (typeof operationalReadiness !== 'function' || (requireAdmin !== undefined && typeof requireAdmin !== 'function')
    || (readinessFactory !== undefined && typeof readinessFactory !== 'function')) throw fail('PHOTO_PRODUCTION_OPERATIONS_REQUIRED');
  // An offline runtime substitute never accidentally falls through to the
  // real process runtime when the matching readiness substitute is omitted.
  const inspectPayment = readinessFactory || (runtimeFactory ? async () => ({ ready: false, operationsReady: false, mode: config.mode }) : virtualReadiness);
  const log = (event, error) => { try { logger({ event, ...(error ? { code: safeCode(error) } : {}) }); } catch {} };
  let runtime, host, server, ports, timer, sweep, stopped = false, stopping, identityPrepared = false;
  const stopSignals = () => { for (const name of ['SIGTERM', 'SIGINT']) signals.removeListener(name, signalStop); };
  const shutdown = () => {
    if (stopping) return stopping;
    stopped = true; timers.clearTimeout(timer); stopSignals();
    const drained = host?.drain();
    const closed = server ? new Promise(resolve => { server.close(() => resolve()); server.closeIdleConnections?.(); }) : Promise.resolve();
    stopping = (async () => {
      const results = await Promise.allSettled([drained, closed, sweep].filter(Boolean));
      await ports?.drain();
      await runtime?.ledger.database.close();
      if (results.some(result => result.status === 'rejected')) throw fail('PHOTO_PRODUCTION_SHUTDOWN_UNCONFIRMED');
      return { stopped: true, databaseClosed: Boolean(runtime) };
    })();
    return stopping;
  };
  function signalStop() { shutdown().catch(error => { log('photo_production.shutdown_failed', error); process.exitCode = 1; }); }
  try {
    // Called before the first await can change the process environment; the
    // runtime itself captures and binds an immutable configuration scope.
    runtime = await (runtimeFactory || virtualRuntime)(config.runtimeOptions);
    if (runtime?.ledger?.database?.backend !== 'mysql' || runtime.adapter?.appId !== config.appId || runtime.adapter?.env !== 0) {
      throw fail('PHOTO_PRODUCTION_RUNTIME_SCOPE_REQUIRED');
    }
    await verifyPrivateProductionDatabase(runtime.ledger.database, config.productionTarget);
    ports = await portsFactory(config, env);
    const authorizedUser = async userId => userId === undefined || (Boolean(await runtime.ledger.identity(userId))
      && (config.mode !== 'merchant_test' || config.testUserIds.includes(userId)));
    host = createPhotoProductionHost({ ...runtime, appSecret: env.WECHAT_APP_SECRET, products: config.products,
      mode: config.mode, purchaseProfile: config.purchaseProfile, testUserIds: config.testUserIds,
      refundOperatorUserIds: config.refundOperatorUserIds, publicProfile: config.publicProfile,
      generationEnabled: config.generationEnabled, requireAdmin,
      pictureReadiness: async userId => ({ ready: !stopped && config.processEnabled && config.cleanupEnabled && await authorizedUser(userId) }),
      paymentReadiness: async userId => {
        const operations = await operationalReadiness({ database: runtime.ledger.database, identity: host.identity, userId });
        const operator = await host.refundOperator.readiness();
        return inspectPayment({ identityReady: !stopped && identityPrepared && operations?.identityReady !== false,
          adminReady: !stopped && operator?.ready === true && operations?.adminReady !== false,
          purchaseProfile: config.purchaseProfile, runtimeOptions: config.runtimeOptions });
      },
      alert: () => log('photo_production.payment_operation_unconfirmed'),
      photoApplicationFactory: shared => createPhotoApplication({ ...shared,
        policy: { ...config.policy, moderationService: config.moderationPolicy.services.input }, approvedEffects: config.approvedEffects,
        uploadStorage: ports.inputStorage, inputNormalizer: ports.inputNormalizer, moderator: ports.moderator, storageTimeoutMs: config.storageTimeoutMs,
        // shared.readiness is the host's joint per-user gate; do not replace it.
        cleanup: { sourceStorage: ports.sourceCleanup, moderationStorage: ports.moderationCleanup, policy: config.cleanupPolicy },
        mediaUrl: { allowedHosts: [`${config.bucket}.oss-${config.region}.aliyuncs.com`],
          sign: async ({ assetId, storageKey, expiresAt }) => ({ assetId, ...await ports.outputStorage.signedUrl(storageKey, { ttlSeconds: 60, maxExpiresAt: expiresAt }) }) },
        runProviderFactory: ({ context }) => createPhotoGenerationLifecycle({ context, policy: config.policy, approvedEffects: config.approvedEffects,
          generationEnabled: config.generationEnabled,
          media: { inputStorage: ports.inputStorage, outputStorage: ports.outputStorage, provider: ports.provider,
            marker: ports.marker, moderator: ports.moderator, storageTimeoutMs: config.storageTimeoutMs },
          cleanup: { moderationStorage: ports.moderationCleanup, policy: config.cleanupPolicy },
          inspectPrerequisites: ports.inspectPrerequisites,
          authorizeUser: async ({ userId }) => userId !== undefined && authorizedUser(userId) }) }) });
    const prepared = await host.prepare();
    if (prepared.paymentPrepared !== true) throw fail('PHOTO_PRODUCTION_PAYMENT_NOT_PREPARED');
    identityPrepared = true;
    await new Promise((resolve, reject) => {
      try { server = listen({ fetch: host.app.fetch, port: config.port, hostname: config.hostname }, resolve);
        server.once('error', () => reject(fail('PHOTO_PRODUCTION_LISTEN_FAILED'))); }
      catch { reject(fail('PHOTO_PRODUCTION_LISTEN_FAILED')); }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
    server.setTimeout(15000, socket => socket.destroy());
    server.on('error', () => { log('photo_production.listen_failed'); signalStop(); });
    const schedule = () => {
      if (stopped || !(config.processEnabled || config.cleanupEnabled || config.reconcileEnabled)) return;
      timer = timers.setTimeout(() => {
        if (stopped) return;
        sweep = (async () => {
          if (config.processEnabled || config.cleanupEnabled) await host.runOnce({ process: config.processEnabled, cleanup: config.cleanupEnabled })
            .catch(error => log('photo_production.photo_worker_unconfirmed', error));
          if (!stopped && config.reconcileEnabled) await host.reconcileOnce().catch(error => log('photo_production.reconciliation_unconfirmed', error));
        })().catch(error => log('photo_production.worker_unconfirmed', error)).finally(() => { sweep = undefined; schedule(); });
      }, config.intervalMs);
      timer.unref?.();
    };
    for (const name of ['SIGTERM', 'SIGINT']) signals.once(name, signalStop);
    schedule(); log('photo_production.started');
    return Object.freeze({ host, address: () => server.address(), shutdown,
      state: Object.freeze({ env: 0, mode: config.mode, generationEnabled: config.generationEnabled,
        processEnabled: config.processEnabled, cleanupEnabled: config.cleanupEnabled, reconcileEnabled: config.reconcileEnabled }) });
  } catch (error) { await shutdown().catch(() => {}); throw fail(safeCode(error)); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) { console.error('PHOTO_PRODUCTION_NO_ARGUMENTS_ALLOWED'); process.exitCode = 1; }
  else startPhotoProductionServer().catch(error => { console.error(safeCode(error)); process.exitCode = 1; });
}
