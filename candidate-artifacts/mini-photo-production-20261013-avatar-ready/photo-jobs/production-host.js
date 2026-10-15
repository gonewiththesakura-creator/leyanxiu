import { Hono } from 'hono';
import { createMiniProductionService, miniProductionPurchaseProfile } from '../payments/virtual/mini-production-service.js';
import { photoPublicDisclosureReady, registerPhotoCandidatePublicRoutes } from './candidate-public.js';

const fail = code => Object.assign(new Error(code), { code });
const photoPath = path => /^\/api\/(?:catalog$|consents(?:\/|$)|assets(?:\/|$)|works$|mini\/photo-(?:uploads|jobs)(?:\/|$))/.test(path);
const closedCatalog = () => ({ settings: { generationEnabled: false }, photoEffects: [], miniProgramCreation: {
  available: false, jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1', photoEffectIds: [],
} });
const disabled = async () => ({ ready: false });

/** Env0 host only: no listener, scheduler, credentials, migrations or DB close.
 * The existing production service owns one durable identity. Its ledger and
 * auth ports are shared with the existing photo application. pictureReadiness
 * is the host's current service/launch gate (not a synthetic probe alone);
 * paymentReadiness must call the existing virtualReadiness with the reviewed
 * runtime options and identity/admin acceptance. No HTTP field supplies them.
 */
export function createPhotoProductionHost({ ledger, adapter, codec, appSecret, products = [],
  mode = 'closed', testUserIds = [], purchaseProfile = miniProductionPurchaseProfile, requireAdmin, refundOperatorUserIds = [], photoApplicationFactory, publicProfile,
  generationEnabled = false, pictureReadiness = disabled, paymentReadiness = disabled,
  fetchImpl, alert, now = Date.now } = {}) {
  const database = ledger?.database;
  if (!database?.transaction || database.backend !== 'mysql' || adapter?.env !== 0
    || !/^wx[a-z0-9]{16}$/.test(adapter?.appId || '') || typeof generationEnabled !== 'boolean'
    || typeof photoApplicationFactory !== 'function' || typeof pictureReadiness !== 'function'
    || typeof paymentReadiness !== 'function' || typeof now !== 'function'
    || purchaseProfile !== miniProductionPurchaseProfile) throw fail('PHOTO_PRODUCTION_SCOPE_REQUIRED');
  const appId = adapter.appId;
  let accepting = true, paymentPrepared = false, photoPrepared = false, preparing, reconciling, draining;
  let photo, photoCalls;
  const activeHttp = new Set(), activeRuns = new Set();
  const checkScope = () => database.transaction(async q => {
    if (adapter.env !== 0 || adapter.appId !== appId || ledger.database !== database || photo.context.database !== database) {
      throw fail('PHOTO_PRODUCTION_SCOPE_REQUIRED');
    }
    const rows = await q('SELECT id,app_id,env FROM vp_environment');
    if (rows.length !== 1 || rows[0].id !== 1 || rows[0].app_id !== appId || rows[0].env !== 0) throw fail('PHOTO_PRODUCTION_SCOPE_REQUIRED');
  });
  const operationsReady = async () => {
    if (!accepting || !paymentPrepared) return false;
    try { await checkScope(); return accepting; } catch { return false; }
  };
  // This gate is passed to the application for per-user submission/dispatch;
  // the outer host checks it too, so an incorrectly assembled factory cannot
  // turn an unavailable service into a new upload or reservation.
  const pictureGate = async userId => {
    if (!photoPrepared || !generationEnabled || !photoPublicDisclosureReady(publicProfile) || !await operationsReady()) return { ready: false };
    try { return { ready: (await pictureReadiness(userId))?.ready === true && accepting }; }
    catch { return { ready: false }; }
  };
  const photoState = async userId => {
    if (!(await pictureGate(userId)).ready) return { ready: false, catalog: closedCatalog() };
    try {
      const value = await photoCalls.catalog(userId);
      const mini = value?.miniProgramCreation;
      if (mini?.jobProtocol !== 'photo-jobs-v1' || mini?.uploadProtocol !== 'photo-uploads-v1') throw fail('PHOTO_PRODUCTION_PROTOCOL_REQUIRED');
      const ready = accepting && value.settings?.generationEnabled === true && mini.available === true
        && Array.isArray(mini.photoEffectIds) && mini.photoEffectIds.length > 0;
      return { ready, catalog: ready ? value : closedCatalog() };
    } catch { return { ready: false, catalog: closedCatalog() }; }
  };
  const salesReadiness = async userId => {
    if (!(await photoState(userId)).ready || !await operationsReady()) return { ready: false, operationsReady: await operationsReady() };
    try {
      const state = await paymentReadiness(userId);
      // Match the explicit wrapper mode. An env1 sandbox report or a stale
      // differently configured runtime cannot approve this env0 wrapper.
      return { ready: accepting && state?.ready === true && state?.operationsReady === true && state?.mode === mode
          && state?.purchaseProfile === purchaseProfile,
        operationsReady: await operationsReady(), purchaseProfile };
    } catch { return { ready: false, operationsReady: await operationsReady() }; }
  };
  const payment = createMiniProductionService({ ledger, adapter, codec, appSecret, products, mode, testUserIds, purchaseProfile,
    requireAdmin, refundOperatorUserIds, readiness: salesReadiness, fetchImpl, alert, now });
  photo = photoApplicationFactory({ ledger, authenticated: payment.authenticated, channel: 'wechat-mini-program',
    generationEnabled, readiness: pictureGate });
  const methods = ['mount', 'prepare', 'catalog', 'runOnce', 'drain'];
  if (photo?.active !== true || photo.managesSales !== false || photo.context?.database !== database
    || methods.some(name => typeof photo[name] !== 'function')) throw fail('PHOTO_PRODUCTION_SHARED_DATABASE_REQUIRED');
  photoCalls = Object.fromEntries(methods.map(name => [name, photo[name].bind(photo)]));
  const catalog = async userId => (await photoState(userId)).catalog;
  const health = async () => {
    const operational = await operationsReady();
    const available = operational && (await photoState()).ready;
    const sales = operational && (await payment.readiness()).ready;
    return { ok: operational, service: 'mini-photo-production', env: 0, mode, accepting,
      productionPaymentsEnabled: sales, salesEnabled: sales, ledgerOnlySandbox: false,
      payment: { prepared: paymentPrepared, operationsReady: operational },
      photo: { prepared: photoPrepared, generationEnabled, available }, generationAvailable: available,
      cloudBusinessEventsReady: false, cloudCallbackMode: 'query-authoritative' };
  };
  const app = new Hono();
  app.onError((_error, c) => c.json({ code: 'PHOTO_PRODUCTION_UNCONFIRMED', message: '服务状态尚未确认，请查询原记录。' }, 503));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    if (!accepting) return c.req.path === '/health' ? next() : c.json({ code: 'PHOTO_PRODUCTION_DRAINING' }, 503);
    let done; const operation = new Promise(resolve => { done = resolve; }); activeHttp.add(operation);
    try {
      if (c.req.path === '/health') return await next();
      if (!await operationsReady()) return c.json({ code: 'PHOTO_PRODUCTION_NOT_PREPARED' }, 503);
      if (c.req.method === 'POST' && ['/api/mini/photo-uploads', '/api/mini/photo-jobs', '/api/consents'].includes(c.req.path)) {
        const identity = await payment.authenticated(c); if (identity.response) return identity.response;
        if (!(await photoState(identity.auth.userId)).ready) {
          // The original key may already exist: this is NOT a definite
          // not-started code. Keep client locks and permit GET recovery.
          return c.json({ code: 'PHOTO_PRODUCTION_GENERATION_CLOSED', message: '图片新提交已关闭，请查询原上传或任务。' }, 503);
        }
      }
      if (photoPath(c.req.path) && !photoPrepared && c.req.path !== '/api/catalog') return c.json({ code: 'PHOTO_PRODUCTION_PHOTO_NOT_PREPARED' }, 503);
      await next();
    } finally { activeHttp.delete(operation); done(); }
  });
  app.get('/health', async c => { const value = await health(); return c.json(value, value.ok ? 200 : 503); });
  app.get('/api/catalog', async c => {
    const identity = await payment.authenticated(c);
    if (identity.response && c.req.header('authorization') !== undefined) return identity.response;
    // No identity must never inherit the scheduler's global readiness gate.
    return c.json({ code: 0, data: identity.auth?.userId ? await catalog(identity.auth.userId) : closedCatalog() });
  });
  app.get('/api/capabilities', async c => {
    const identity = await payment.authenticated(c);
    if (identity.response && c.req.header('authorization') !== undefined) return identity.response;
    const ready = Boolean(identity.auth?.userId) && (await photoState(identity.auth.userId)).ready;
    return c.json({ code: 0, data: [{ id: 'photo-effects', route: '/api/mini/photo-jobs', ready,
      status: ready ? 'verified' : photoPublicDisclosureReady(publicProfile) ? 'blocked_pending_evidence' : 'blocked_pending_disclosure' }] });
  });
  // Reuse exact public projection and explicit unaccepted-report contract;
  // the production capability route above is governed by the shared gate.
  registerPhotoCandidatePublicRoutes(app, { profile: publicProfile, catalog, authenticated: payment.authenticated });
  photoCalls.mount(app); // Upload/native limits precede payment's 128 KiB reader.
  app.route('/', payment.app);
  app.notFound(c => c.json({ code: 'PHOTO_PRODUCTION_ROUTE_NOT_FOUND' }, 404));
  return Object.freeze({ app, database, identity: payment.identity, refundOperator: payment.refundOperator, photo, health, catalog,
    prepare() {
      if (!accepting) return Promise.reject(fail('PHOTO_PRODUCTION_DRAINING'));
      if (!preparing) preparing = (async () => {
        paymentPrepared = false;
        await checkScope();
        await database.transaction(async q => {
          await q('SELECT user_id,app_id,openid FROM vp_accounts LIMIT 0');
          await q('SELECT id,user_id,app_id,token_hash,expires_at,revoked_at FROM vp_auth_sessions LIMIT 0');
          await q('SELECT id,user_id,sealed,expires_at FROM vp_sessions LIMIT 0');
          await q('SELECT id,user_id,status,payload FROM vp_orders LIMIT 0');
          await q('SELECT id,user_id,remaining,reserved,frozen FROM vp_buckets LIMIT 0');
          await q('SELECT id,order_id,status,payload FROM vp_refunds LIMIT 0');
          await q('SELECT id,order_id,kind,status,attempts,next_at FROM vp_outbox LIMIT 0');
          await q('SELECT id,user_id,bucket_id,purpose,status,created_at FROM vp_reservations LIMIT 0');
          await q('SELECT id,order_id,digest,created_at FROM vp_events LIMIT 0');
          await q('SELECT id,user_id,action,reference_id,detail,created_at FROM vp_audit LIMIT 0');
          await q('SELECT id,payload,created_at FROM vp_reconciliation LIMIT 0');
        });
        paymentPrepared = true;
        try { photoPrepared = (await photoCalls.prepare())?.prepared === true; }
        catch { photoPrepared = false; }
        return { prepared: accepting && paymentPrepared && photoPrepared, paymentPrepared, photoPrepared };
      })().finally(() => { preparing = undefined; });
      return preparing;
    },
    runOnce({ process = false, cleanup = false } = {}) {
      if (!accepting || !photoPrepared || (!process && !cleanup)) return Promise.resolve(null);
      const operation = (async () => {
        if (!await operationsReady()) return null;
        return photoCalls.runOnce({ process: process === true && (await photoState()).ready, cleanup: cleanup === true });
      })();
      activeRuns.add(operation); operation.finally(() => activeRuns.delete(operation)).catch(() => {}); return operation;
    },
    reconcileOnce() {
      if (!accepting || !paymentPrepared) return Promise.resolve({ skipped: true });
      if (!reconciling) reconciling = (async () => {
        if (!await operationsReady()) return { skipped: true };
        return payment.payments.reconcile();
      })().finally(() => { reconciling = undefined; });
      return reconciling;
    },
    drain() {
      if (draining) return draining;
      accepting = false;
      const photoDrain = photoCalls.drain();
      draining = (async () => {
        const results = await Promise.allSettled([photoDrain, preparing, reconciling, ...activeRuns, ...activeHttp].filter(Boolean));
        if (results.some(result => result.status === 'rejected')) throw fail('PHOTO_PRODUCTION_DRAIN_UNCONFIRMED');
        return { accepting: false, active: activeHttp.size + activeRuns.size, databaseClosed: false };
      })();
      return draining;
    },
  });
}
