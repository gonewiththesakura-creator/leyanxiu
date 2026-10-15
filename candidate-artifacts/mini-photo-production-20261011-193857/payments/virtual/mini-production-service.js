import { createMiniPaymentService } from './mini-service.js';
import { createMiniIdentity } from './mini-identity.js';
import { parseVirtualProducts } from './products.js';
import { createMiniRefundOperator } from './mini-refund-operator.js';

const modes = new Set(['closed', 'merchant_test', 'live']);
const fail = code => { throw new Error(code); };
function allowlist(values) {
  if (!Array.isArray(values)) fail('XPAY_PRODUCTION_ALLOWLIST_INVALID');
  const unique = [...new Set(values)];
  if (unique.length > 20 || unique.some(value => typeof value !== 'string' || !/^usr_[a-f0-9-]{36}$/.test(value))) {
    fail('XPAY_PRODUCTION_ALLOWLIST_INVALID');
  }
  return Object.freeze(unique);
}

// Explicit host configuration only. This does not open a database, start a
// listener, approve a product, or turn a readiness report into acceptance.
export function miniProductionConfig(env) {
  const mode = env.XPAY_MODE || 'closed';
  if (env.RELEASE_CHANNEL !== 'wechat-mini-program' || env.AUTH_MODE !== 'wechat'
    || env.XPAY_ENV !== '0' || !modes.has(mode)) fail('XPAY_PRODUCTION_SCOPE_REQUIRED');
  if (env.XPAY_ENABLED !== 'true') fail('XPAY_PRODUCTION_API_DISABLED');
  if (env.XPAY_DB_BACKEND !== 'mysql') fail('XPAY_PRODUCTION_MYSQL_REQUIRED');
  const testUserIds = allowlist(String(env.XPAY_TEST_USER_IDS || '').split(',').map(value => value.trim()).filter(Boolean));
  if (mode === 'merchant_test' && !testUserIds.length) fail('XPAY_PRODUCTION_ALLOWLIST_REQUIRED');
  if (mode !== 'closed' && env.XPAY_RECONCILE_ENABLED !== 'true') fail('XPAY_PRODUCTION_RECONCILIATION_REQUIRED');
  return Object.freeze({ mode, testUserIds });
}

/** Env0 composition over the canonical ledger; no new account or payment
 * implementation. The host must supply current aggregate readiness (identity,
 * usable photo service, administrator and real acceptance), and its existing
 * synchronous owner/CSRF authentication port. Neither comes from a request.
 * Default/missing/failed readiness closes sales while preserving recovery.
 * Production deployment still needs shared login admission across replicas;
 * the common service's process-local limit is only a bounded fallback.
 */
export function createMiniProductionService({ ledger, adapter, codec, appSecret,
  products = [], mode = 'closed', testUserIds = [], readiness: inspectReadiness = async () => ({ ready: false }),
  requireAdmin, refundOperatorUserIds = [], fetchImpl = fetch, alert = () => {}, now = Date.now } = {}) {
  const database = ledger?.database;
  if (!database?.transaction || database.backend !== 'mysql' || adapter?.env !== 0
    || !/^wx[a-z0-9]{16}$/.test(adapter?.appId || '') || !appSecret || !modes.has(mode)
    || typeof inspectReadiness !== 'function' || (requireAdmin !== undefined && typeof requireAdmin !== 'function')) {
    fail('XPAY_PRODUCTION_SCOPE_REQUIRED');
  }
  const appId = adapter.appId;
  const allowedUsers = allowlist(testUserIds);
  if (mode === 'merchant_test' && !allowedUsers.length) fail('XPAY_PRODUCTION_ALLOWLIST_REQUIRED');
  const reviewedProducts = parseVirtualProducts(products);
  const adminConfigured = typeof requireAdmin === 'function';
  const checkScope = async () => {
    if (ledger.database !== database || database.backend !== 'mysql' || adapter.appId !== appId || adapter.env !== 0) {
      fail('XPAY_PRODUCTION_SCOPE_REQUIRED');
    }
    await database.transaction(async q => {
      const rows = await q('SELECT id,app_id,env FROM vp_environment');
      if (rows.length !== 1 || Number(rows[0].id) !== 1 || rows[0].app_id !== appId || Number(rows[0].env) !== 0) {
        fail('XPAY_PRODUCTION_LEDGER_MISMATCH');
      }
    });
  };
  const identity = createMiniIdentity({ database, appId, bindSession: value => ledger.bindSession(value), now });
  const refundOperator = createMiniRefundOperator({ ledger, identity, appId, operatorUserIds: refundOperatorUserIds, now });
  if (refundOperatorUserIds.length && adminConfigured) fail('XPAY_REFUND_OPERATOR_ADMIN_CONFLICT');
  const readiness = async userId => {
    let operationsReady = false, approved = false;
    try {
      await checkScope(); operationsReady = true;
      // Mode is owned by this wrapper. A readiness return value cannot change
      // env, remove the merchant-test allowlist, or reopen a closed wrapper.
      if (mode !== 'closed') {
        const current = await inspectReadiness(userId);
        approved = current?.ready === true && current?.operationsReady === true;
      }
    } catch { /* Keep known recovery separate from an unavailable sales gate. */ }
    const reviewerReady = adminConfigured || (await refundOperator.readiness()).ready;
    const ready = operationsReady && mode !== 'closed' && reviewedProducts.length > 0 && reviewerReady && approved;
    return { ready, operationsReady, mode, testUserIds: [...allowedUsers], ledgerOnlySandbox: false,
      blockers: ready ? [] : ['production sales readiness not confirmed'] };
  };
  const service = createMiniPaymentService({ ledger, identity, adapter, codec, appSecret, products: reviewedProducts,
    readiness, requireAdmin: requireAdmin || (c => ({ response: c.json({ code: 'XPAY_PRODUCTION_ADMIN_UNAVAILABLE' }, 403) })),
    beforeRequest: checkScope, fetchImpl, alert, now });
  refundOperator.mount(service.app);
  // Deliberately no sandbox self-confirmation route. Formal user refunds stay
  // requested until the existing privileged reviewer approves them; only an
  // explicit reconciliation call can dispatch the persisted channel outbox.
  service.app.get('/health', async c => {
    const state = await readiness();
    return c.json({ ok: state.operationsReady, service: 'mini-payment-production', env: 0, mode,
      salesEnabled: state.ready, productionPaymentsEnabled: state.ready, ledgerOnlySandbox: false,
      cloudBusinessEventsReady: false, cloudCallbackMode: 'query-authoritative' }, state.operationsReady ? 200 : 503);
  });
  // The photo application mounts outside the payment sub-app, so its auth
  // port must not depend on that sub-app's miniAuth hydration middleware.
  const authenticated = async c => {
    await checkScope();
    const auth = await identity.authenticateBearer(c.req.header('authorization'));
    return auth ? { auth } : { response: c.json({ code: 'AUTH_SESSION_EXPIRED', message: '请重新登录' }, 401) };
  };
  return { ...service, identity, authenticated, refundOperator };
}
