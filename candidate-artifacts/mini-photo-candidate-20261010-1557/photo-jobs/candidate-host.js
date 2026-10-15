import { Hono } from 'hono';
import { createMiniIdentity } from '../payments/virtual/mini-identity.js';
import { createMiniSandboxService } from '../payments/virtual/mini-sandbox-service.js';

const fail = code => Object.assign(new Error(code), { code });
const photoPath = path => /^\/api\/(?:catalog$|consents(?:\/|$)|assets(?:\/|$)|works$|mini\/photo-(?:uploads|jobs)(?:\/|$))/.test(path);
const closedCatalog = () => ({ settings: { generationEnabled: false }, photoEffects: [], miniProgramCreation: {
  available: false, jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1', photoEffectIds: [],
} });

/** Local, injectable candidate composition only. No env reads, migrations,
 * listener, scheduler, provider construction or database ownership. The single
 * existing mini identity implementation is constructed on the canonical ledger
 * database, preserving its durable account mappings and bearer sessions.
 */
export function createPhotoCandidateHost({ ledger, adapter, codec, appSecret, products = [], testUserIds = [],
  photoApplicationFactory, generationEnabled = false, purchaseEnabled = false, fetchImpl, alert, now = Date.now } = {}) {
  const database = ledger?.database;
  if (!database?.transaction || !['mysql', 'sqlite'].includes(database.backend) || typeof ledger?.bindSession !== 'function'
    || adapter?.env !== 1 || typeof adapter.appId !== 'string' || !adapter.appId || purchaseEnabled !== false
    || typeof generationEnabled !== 'boolean' || typeof photoApplicationFactory !== 'function' || typeof now !== 'function') {
    throw fail('PHOTO_CANDIDATE_SCOPE_REQUIRED');
  }
  const appId = adapter.appId;
  const identity = createMiniIdentity({ database, appId, bindSession: value => ledger.bindSession(value), now });
  const authenticated = async c => {
    const auth = await identity.authenticateBearer(c.req.header('authorization'));
    return auth ? { auth } : { response: c.json({ code: 'AUTH_SESSION_EXPIRED', message: '请重新登录' }, 401) };
  };
  const photo = photoApplicationFactory({ ledger, authenticated, channel: 'wechat-mini-program', generationEnabled });
  const methods = ['mount', 'prepare', 'catalog', 'runOnce', 'drain'];
  if (photo?.active !== true || photo.managesSales !== false || photo.context?.database !== database
    || methods.some(name => typeof photo[name] !== 'function')) throw fail('PHOTO_CANDIDATE_SHARED_DATABASE_REQUIRED');
  const photoCalls = Object.fromEntries(methods.map(name => [name, photo[name].bind(photo)]));
  const payment = createMiniSandboxService({ ledger, identity, adapter, codec, appSecret, products, testUserIds,
    purchaseEnabled: false, fetchImpl, alert, now });
  const app = new Hono();
  let accepting = true, paymentPrepared = false, photoPrepared = false, preparing, reconciling, draining;
  const activeHttp = new Set(), activeRuns = new Set();
  const checkScope = () => database.transaction(async q => {
    if (adapter.env !== 1 || adapter.appId !== appId || ledger.database !== database || photo.context.database !== database) {
      throw fail('PHOTO_CANDIDATE_SCOPE_REQUIRED');
    }
    const rows = await q('SELECT id,app_id,env FROM vp_environment');
    if (rows.length !== 1 || Number(rows[0].id) !== 1 || rows[0].app_id !== appId || Number(rows[0].env) !== 1) {
      throw fail('PHOTO_CANDIDATE_SCOPE_REQUIRED');
    }
  });
  const operationsReady = async () => {
    if (!accepting || !paymentPrepared) return false;
    try { await checkScope(); return accepting; } catch { return false; }
  };
  const catalog = async () => {
    if (!photoPrepared || !await operationsReady()) return closedCatalog();
    const value = await photoCalls.catalog();
    if (value?.miniProgramCreation?.jobProtocol !== 'photo-jobs-v1' || value?.miniProgramCreation?.uploadProtocol !== 'photo-uploads-v1') {
      throw fail('PHOTO_CANDIDATE_PROTOCOL_REQUIRED');
    }
    // This additional host switch can only close the application's own gates.
    if (!generationEnabled) return { ...value, settings: { ...value.settings, generationEnabled: false },
      miniProgramCreation: { ...value.miniProgramCreation, available: false, photoEffectIds: [] } };
    return value;
  };
  const health = async () => {
    const operational = await operationsReady();
    let available = false;
    if (operational && photoPrepared) {
      try { const value = await catalog(); available = value.settings.generationEnabled === true && value.miniProgramCreation.available === true; }
      catch { /* A missing photo dependency must not claim availability. */ }
    }
    return { ok: operational, service: 'mini-photo-candidate', env: 1, mode: 'closed', accepting,
      productionPaymentsEnabled: false, sandboxMayCharge: true, salesEnabled: false, ledgerOnlySandbox: false,
      payment: { prepared: paymentPrepared, operationsReady: operational },
      photo: { prepared: photoPrepared, generationEnabled, available }, generationAvailable: available,
      cloudBusinessEventsReady: false, cloudCallbackMode: 'query-authoritative' };
  };
  app.onError((_error, c) => c.json({ code: 'PHOTO_CANDIDATE_UNCONFIRMED', message: '服务状态尚未确认，请查询原记录。' }, 503));
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store'); c.header('X-Content-Type-Options', 'nosniff');
    if (!accepting) return c.req.path === '/health' ? next() : c.json({ code: 'PHOTO_CANDIDATE_DRAINING' }, 503);
    let done; const operation = new Promise(resolve => { done = resolve; }); activeHttp.add(operation);
    try {
      if (c.req.path === '/health') return await next();
      if (!await operationsReady()) return c.json({ code: 'PHOTO_CANDIDATE_NOT_PREPARED' }, 503);
      if (!generationEnabled && c.req.method === 'POST' && ['/api/mini/photo-uploads', '/api/mini/photo-jobs'].includes(c.req.path)) {
        // Even a misassembled trusted factory cannot bypass the host's final
        // switch. Do not claim "not started": an original key may already
        // exist, so the client must retain it and recover using GET by-key.
        return c.json({ code: 'PHOTO_CANDIDATE_GENERATION_CLOSED', message: '图片新提交已关闭，请查询原上传或任务。' }, 503);
      }
      if (photoPath(c.req.path) && !photoPrepared && c.req.path !== '/api/catalog') return c.json({ code: 'PHOTO_CANDIDATE_PHOTO_NOT_PREPARED' }, 503);
      await next();
    } finally { activeHttp.delete(operation); done(); }
  });
  app.get('/health', async c => { const value = await health(); return c.json(value, value.ok ? 200 : 503); });
  app.get('/api/catalog', async c => c.json({ code: 0, data: await catalog() }));
  // Never install a broad outer body reader: upload owns its 2.8 MB cap, while
  // the untouched payment sub-app continues counting its own 128 KiB stream.
  photoCalls.mount(app);
  app.route('/', payment.app);
  app.notFound(c => c.json({ code: 'PHOTO_CANDIDATE_ROUTE_NOT_FOUND' }, 404));

  return Object.freeze({ app, database, identity, photo, health,
    prepare() {
      if (!accepting) return Promise.reject(fail('PHOTO_CANDIDATE_DRAINING'));
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
        return photoCalls.runOnce({ process: generationEnabled && process === true, cleanup: cleanup === true });
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
        // Stop photo claims immediately, then retain the shared database for
        // admitted HTTP (including payment callbacks/login), SQL and late PUTs.
        const results = await Promise.allSettled([photoDrain, preparing, reconciling, ...activeRuns, ...activeHttp].filter(Boolean));
        if (results.some(result => result.status === 'rejected')) throw fail('PHOTO_CANDIDATE_DRAIN_UNCONFIRMED');
        return { accepting: false, active: activeHttp.size + activeRuns.size, databaseClosed: false };
      })();
      return draining;
    },
  });
}
