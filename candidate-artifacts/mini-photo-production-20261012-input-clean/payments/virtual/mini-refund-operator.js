import { readMessageJson } from './message-endpoint.js';

const freshnessMs = 5 * 60 * 1000;
const path = '/api/mini/operations/refunds';
const fail = code => { throw new Error(code); };
const view = refund => ({ id: refund.id, orderId: refund.orderId, amountFen: refund.amountFen,
  status: refund.status, createdAt: refund.createdAt, reviewable: refund.status === 'requested' });

/** Narrow bearer-only operational port. No new identity, cookie session,
 * arbitrary SQL, amount calculation or refund submission is implemented here.
 * Allowlisting an existing canonical user is a reviewed server operation.
 */
export function createMiniRefundOperator({ ledger, identity, appId, operatorUserIds = [], now = Date.now } = {}) {
  const database = ledger?.database;
  if (database?.backend !== 'mysql' || typeof database.transaction !== 'function'
    || typeof identity?.authenticateBearer !== 'function' || typeof ledger.reviewRefund !== 'function'
    || !/^wx[a-z0-9]{16}$/.test(appId || '') || typeof now !== 'function'
    || !Array.isArray(operatorUserIds) || operatorUserIds.length > 20
    || operatorUserIds.some(value => typeof value !== 'string' || !/^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value))) {
    fail('XPAY_REFUND_OPERATOR_CONFIG_REQUIRED');
  }
  const operators = new Set(operatorUserIds);
  const scope = async q => {
    if (ledger.database !== database || database.backend !== 'mysql') fail('XPAY_REFUND_OPERATOR_SCOPE_REQUIRED');
    const rows = await q('SELECT id,app_id,env FROM vp_environment');
    if (rows.length !== 1 || Number(rows[0].id) !== 1 || rows[0].app_id !== appId || Number(rows[0].env) !== 0) {
      fail('XPAY_REFUND_OPERATOR_SCOPE_REQUIRED');
    }
  };
  const session = async (q, auth, locking = false) => {
    await scope(q);
    if (!operators.has(auth?.userId) || auth?.authMethod !== 'wechat') fail('XPAY_REFUND_OPERATOR_FORBIDDEN');
    const rows = await q(`SELECT s.created_at,s.expires_at,s.revoked_at FROM vp_auth_sessions s
      JOIN vp_accounts a ON a.user_id=s.user_id AND a.app_id=s.app_id
      JOIN vp_sessions p ON p.id=s.id AND p.user_id=s.user_id
      WHERE s.id=? AND s.user_id=? AND s.app_id=? AND p.expires_at>?${locking ? ' FOR UPDATE' : ''}`,
    [auth.sessionId, auth.userId, appId, now()]);
    const row = rows[0], at = now();
    if (!Number.isSafeInteger(at) || !row || row.revoked_at !== null || Number(row.expires_at) <= at
      || !Number.isSafeInteger(Number(row.created_at)) || Number(row.created_at) > at || at - Number(row.created_at) >= freshnessMs) {
      fail('XPAY_REFUND_OPERATOR_RELOGIN_REQUIRED');
    }
  };
  const readiness = async () => {
    if (!operators.size) return { ready: false };
    try {
      return await database.transaction(async q => {
        await scope(q);
        for (const userId of operators) {
          const rows = await q('SELECT app_id FROM vp_accounts WHERE user_id=?', [userId]);
          if (rows.length !== 1 || rows[0].app_id !== appId) return { ready: false };
        }
        return { ready: true };
      });
    } catch { return { ready: false }; }
  };
  const protect = action => async c => {
    c.header('Cache-Control', 'no-store');
    try {
      if (!operators.size) return c.json({ code: 'XPAY_REFUND_OPERATOR_UNCONFIGURED' }, 503);
      const auth = await identity.authenticateBearer(c.req.header('authorization'));
      if (!auth) return c.json({ code: 'AUTH_SESSION_EXPIRED' }, 401);
      await database.transaction(q => session(q, auth));
      return await action(c, auth);
    } catch (error) {
      const allowed = new Set(['XPAY_REFUND_OPERATOR_FORBIDDEN', 'XPAY_REFUND_OPERATOR_RELOGIN_REQUIRED',
        'XPAY_REFUND_OPERATOR_SCOPE_REQUIRED', 'XPAY_REFUND_NOT_FOUND', 'XPAY_REFUND_TRANSITION',
        'XPAY_REFUND_CONFIRMATION_REQUIRED', 'XPAY_REFUND_CONFIRMATION_MISMATCH', 'XPAY_MESSAGE_TOO_LARGE', 'XPAY_MESSAGE_INVALID']);
      const code = allowed.has(error?.message) ? error.message : 'XPAY_REFUND_REVIEW_UNCONFIRMED';
      const status = code.endsWith('FORBIDDEN') ? 403 : code.endsWith('RELOGIN_REQUIRED') ? 401 : code.endsWith('NOT_FOUND') ? 404
        : code.endsWith('TOO_LARGE') ? 413 : code.endsWith('UNCONFIRMED') || code.endsWith('SCOPE_REQUIRED') ? 503 : 409;
      return c.json({ code, message: '请重新登录并核对原退款记录；结果未确认时不要创建新的退款。' }, status);
    }
  };
  let mounted = false;
  return Object.freeze({ readiness,
    mount(app) {
      if (mounted || typeof app?.get !== 'function' || typeof app?.post !== 'function') fail('XPAY_REFUND_OPERATOR_MOUNT_INVALID');
      mounted = true;
      app.get('/api/mini/operations/status', async c => {
        c.header('Cache-Control', 'no-store');
        try {
          const auth = await identity.authenticateBearer(c.req.header('authorization'));
          if (!auth) return c.json({ code: 'AUTH_SESSION_EXPIRED' }, 401);
          await database.transaction(scope);
          return c.json({ code: 0, data: { operator: auth.authMethod === 'wechat' && operators.has(auth.userId) } });
        } catch { return c.json({ code: 'XPAY_REFUND_REVIEW_UNCONFIRMED' }, 503); }
      });
      app.get(path, protect(async c => c.json({ code: 0, data: (await ledger.refunds()).map(view) })));
      app.get(path + '/:id', protect(async c => {
        const refund = await ledger.refund(c.req.param('id'));
        if (!refund) fail('XPAY_REFUND_NOT_FOUND');
        return c.json({ code: 0, data: view(refund) });
      }));
      app.post(path + '/:id/review', protect(async (c, auth) => {
        const body = await readMessageJson(c.req.raw);
        if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirm !== true || typeof body.approve !== 'boolean'
          || Object.keys(body).some(key => !['confirm', 'approve', 'expectedOrderId', 'expectedAmountFen'].includes(key))
          || !/^[a-f0-9]{32}$/.test(body.expectedOrderId || '') || !Number.isSafeInteger(body.expectedAmountFen) || body.expectedAmountFen <= 0) {
          fail('XPAY_REFUND_CONFIRMATION_REQUIRED');
        }
        const refund = await ledger.reviewRefund(c.req.param('id'), 'mini-operator:' + auth.userId, body.approve,
          { expectedOrderId: body.expectedOrderId, expectedAmountFen: body.expectedAmountFen, authorize: q => session(q, auth, true) });
        return c.json({ code: 0, data: view(refund) });
      }));
    },
  });
}
