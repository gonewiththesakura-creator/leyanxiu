import { publicOrder } from './ledger.js';
import { validateDelivery } from './wechat.js';
import fs from 'node:fs/promises';
import { purchaseRulesVersion } from './products.js';
import { reconcileVirtualPage } from './reconciliation.js';
import { createVirtualMessageEndpoint, virtualMessagePath } from './message-endpoint.js';

export function registerVirtualPaymentRoutes(app, { ledger, adapter, codec, authenticated, requireAdmin, readiness, products, purchaseProfile, alert = () => {} }) {
  if (purchaseProfile !== undefined && purchaseProfile !== 'android-only-v1') throw new Error('XPAY_PURCHASE_PROFILE_INVALID');
  for (const [url, file, type] of [
    ['/admin/mini-payments', 'admin.html', 'text/html; charset=utf-8'],
    ['/admin/mini-payments.js', 'admin.js', 'application/javascript; charset=utf-8'],
  ]) app.get(url, async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: false }); if (auth.response) return auth.response;
    c.header('Content-Type', type); c.header('Cache-Control', 'no-store');
    return c.body(await fs.readFile(new URL(file, import.meta.url), 'utf8'));
  });
  const protect = handler => async c => {
    try { return await handler(c); }
    catch (error) {
      const code = /^XPAY_[A-Z_]+$/.test(error.message) ? error.message : 'XPAY_UNCONFIRMED';
      alert('virtual_payment.error', { code });
      const status = code.includes('NOT_FOUND') ? 404 : code.includes('LOGIN') || code.includes('IDENTITY') ? 401 : code.includes('UNCONFIRMED') ? 503 : 409;
      return c.json({ code, message: code === 'XPAY_REFUND_VIA_APPLE' ? '请通过 Apple 申请此订单退款' : '操作尚未确认，请刷新订单或联系客户支持' }, status);
    }
  };
  const user = c => {
    const result = authenticated(c);
    if (result.response) return result;
    if (result.auth.authMethod !== 'wechat') return { response: c.json({ code: 'XPAY_WECHAT_LOGIN_REQUIRED' }, 401) };
    return result;
  };
  const available = async (c, auth, operation = false) => {
    const state = await readiness(auth.userId);
    if (!(operation ? state.operationsReady : state.ready)) return c.json({ code: 'XPAY_NOT_READY', message: '支付服务尚未开放' }, 503);
    if (!operation && ['sandbox', 'merchant_test'].includes(state.mode)
      && !state.testUserIds?.includes(auth.userId)) return c.json({ code: 'XPAY_TEST_ALLOWLIST_REQUIRED' }, 403);
    return null;
  };
  async function sync(order) {
    if (!await ledger.claimQuery(order.id)) return await ledger.order(order.id);
    const result = await adapter().query(order);
    if (!result.order || result.order.order_id !== order.id || result.order.env_type !== order.env + 1) throw new Error('XPAY_ORDER_MISMATCH');
    if ([2, 3, 4].includes(result.order.status) && order.status === 'pending') return ledger.settle(order.id, result.order);
    if (result.order.status === 6) return ledger.closeOrder(order.id, result.order);
    if ([0, 1].includes(result.order.status)) return ledger.recordPendingQuery(order.id, result.order);
    return order;
  }
  app.get('/api/mini/payments/products', protect(async c => {
    const identity = authenticated(c);
    const state = await readiness(identity.auth?.userId);
    let allowed = true;
    if (['sandbox', 'merchant_test'].includes(state.mode)) {
      allowed = !identity.response && identity.auth?.authMethod === 'wechat'
        && state.testUserIds?.includes(identity.auth.userId) === true;
    }
    return c.json({ code: 0, data: { available: state.ready && allowed, mode: state.mode, products: allowed ? products() : [],
      ledgerOnlySandbox: state.ledgerOnlySandbox === true, autoRenew: false, rulesVersion: purchaseRulesVersion,
      ...(purchaseProfile ? { purchaseProfile, supportedPlatforms: ['android'] } : {}) } });
  }));
  app.get('/api/mini/payments/entitlements', protect(async c => {
    const auth = user(c); if (auth.response) return auth.response;
    return c.json({ code: 0, data: await ledger.entitlements(auth.auth.userId) });
  }));
  app.get('/api/mini/payments/orders', protect(async c => {
    const auth = user(c); if (auth.response) return auth.response;
    return c.json({ code: 0, data: (await ledger.orders(auth.auth.userId)).map(publicOrder) });
  }));
  app.post('/api/mini/payments/orders', protect(async c => {
    const result = user(c); if (result.response) return result.response; const auth = result.auth;
    const gate = await available(c, auth); if (gate) return gate;
    const body = await c.req.json().catch(() => ({}));
    // This is a declaration check, not trusted device attestation. The actual
    // Apple channel must remain disabled in the reviewed WeChat console.
    // Recovery/notification/refund routes deliberately do not use this gate.
    if (purchaseProfile && (adapter().env !== 0 || body.platform !== 'android')) {
      return c.json({ code: 'XPAY_PURCHASE_PLATFORM_UNSUPPORTED', message: '当前终端暂不支持购买，已有订单和权益仍可查询。' }, 403);
    }
    if (body.agreed !== true || body.rulesVersion !== purchaseRulesVersion) return c.json({ code: 'XPAY_PURCHASE_RULES_REQUIRED', message: '请阅读并确认当前套餐与退款规则' }, 400);
    const product = products().find(x => x.id === body.productId);
    if (!product) return c.json({ code: 'XPAY_PRODUCT_NOT_FOUND' }, 400);
    const sessionKey = await ledger.sessionKey(auth.userId, auth.sessionId);
    const order = await ledger.createOrder({ userId: auth.userId, product, idempotencyKey: c.req.header('idempotency-key'), appId: adapter().appId,
      env: adapter().env, platform: body.platform, rulesVersion: purchaseRulesVersion });
    return c.json({ code: 0, data: { order: publicOrder(order), payment: order.status === 'pending' ? adapter().paymentArgs(order, sessionKey) : null } });
  }));
  app.get('/api/mini/payments/orders/:id', protect(async c => {
    const result = user(c); if (result.response) return result.response;
    let order = await ledger.order(c.req.param('id'), result.auth.userId);
    if (!order) return c.json({ code: 'XPAY_ORDER_NOT_FOUND' }, 404);
    if (order.status === 'pending' && (await readiness()).operationsReady) order = await sync(order);
    return c.json({ code: 0, data: publicOrder(order) });
  }));
  app.post('/api/mini/payments/orders/:id/refund', protect(async c => {
    const result = user(c); if (result.response) return result.response;
    const gate = await available(c, result.auth, true); if (gate) return gate;
    const body = await c.req.json().catch(() => ({}));
    return c.json({ code: 0, data: await ledger.requestRefund(c.req.param('id'), result.auth.userId, body.reason) });
  }));
  app.get('/api/mini/payments/refunds', protect(async c => {
    const result = user(c); if (result.response) return result.response;
    return c.json({ code: 0, data: await ledger.refunds(result.auth.userId) });
  }));
  const notification = createVirtualMessageEndpoint({ codec, alert, handleEvent: async (message, query) => {
    if (!(await readiness()).operationsReady) throw new Error('XPAY_NOT_READY');
    if (message.Event === 'xpay_goods_deliver_notify') {
      const order = await ledger.order(message.OutTradeNo); if (!order) throw new Error('XPAY_ORDER_NOT_FOUND');
      validateDelivery(message, order);
      if (order.status === 'pending') await sync(order);
      const confirmed = await ledger.order(order.id);
      if (!['paid', 'refund_pending', 'refunded'].includes(confirmed.status)) throw new Error('XPAY_PAYMENT_UNCONFIRMED');
      await ledger.completeOutbox(`deliver:${order.id}`);
    } else if (message.Event === 'xpay_refund_notify') {
      const order = await ledger.order(message.MchOrderId);
      const remote = order?.status === 'pending' ? (await adapter().query(order)).order : undefined;
      await ledger.applyRefund(message, remote);
    }
    else if (message.Event === 'xpay_subscribe_ios_refund_query_notify') {
      // No unsupported claim of consumption is sent to Apple. Final result comes in refund_notify.
      return codec().encode({ result_code: 0, result_info: '建议退款', evidence: '商户支持用户退款申请，最终结果以渠道退款通知为准' }, query.nonce);
    } else {
      alert('virtual_payment.unhandled_event', { code: 'XPAY_EVENT_REVIEW_REQUIRED' });
      throw new Error('XPAY_EVENT_REVIEW_REQUIRED');
    }
  } });
  app.all(virtualMessagePath, c => notification(c.req.raw));
  app.get('/api/admin/mini-payments', protect(async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: false }); if (auth.response) return auth.response;
    return c.json({ code: 0, data: { readiness: await readiness(), orders: (await ledger.orders()).map(publicOrder), refunds: await ledger.refunds(), audit: await ledger.auditLog(), generations: await ledger.unresolvedGenerations(), reports: await ledger.reconciliationReports() } });
  }));
  app.post('/api/admin/mini-payments/generations/:id/resolve', protect(async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    if (!['success', 'failed'].includes(body.outcome) || typeof body.userId !== 'string') return c.json({ code: 'XPAY_RESOLUTION_INVALID' }, 400);
    const changed = await ledger.finish(body.userId, c.req.param('id'), body.outcome, { reviewer: auth.session.username, evidence: body.evidence });
    return c.json({ code: 0, data: { changed } });
  }));
  app.post('/api/admin/mini-payments/refunds/:id/review', protect(async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.approve !== 'boolean') return c.json({ code: 'XPAY_REVIEW_INVALID' }, 400);
    const reviewer = auth.session?.username || auth.admin?.username || auth.user?.username;
    return c.json({ code: 0, data: await ledger.reviewRefund(c.req.param('id'), reviewer, body.approve) });
  }));
  let sweeping = false;
  const requireApprovedRefund = (refund, order) => {
    if (!refund || !order || order.status !== 'refund_pending' || refund.amountFen > order.amountFen - order.refundedFen
      || refund.status !== 'processing' || refund.orderId !== order.id || refund.userId !== order.userId
      || typeof refund.reviewer !== 'string' || !refund.reviewer.trim()) throw new Error('XPAY_REFUND_REVIEW_REQUIRED');
    return refund;
  };
  async function reconcile() {
    if (sweeping || !(await readiness()).operationsReady) return { skipped: true };
    sweeping = true; const summary = { checked: 0, delivered: 0, errors: 0 };
    try {
      for (const order of await ledger.orders(null, { pending: true })) {
        try { await sync(order); summary.checked++; } catch { summary.errors++; }
      }
      for (const candidate of await ledger.outbox()) {
        const job = await ledger.claimOutbox(candidate.id); if (!job) continue;
        try {
          const order = await ledger.order(job.order_id);
          if (job.kind === 'deliver') { await adapter().deliver(order); await ledger.completeOutbox(job.id); summary.delivered++; }
          if (job.kind === 'refund') {
            const refund = await ledger.refund(job.id.slice('refund:'.length));
            if (refund?.status === 'succeeded' || refund?.status === 'rejected') { await ledger.completeOutbox(job.id); continue; }
            requireApprovedRefund(refund, order);
            if (job.attempts > 0) {
              const remote = (await adapter().queryRefund(order, refund)).order;
              // Query status 5 confirms the merchant debit only; status 8
              // confirms receipt by the user. Keep the hold and job until then.
              if (remote?.order_id === refund.id && remote.env_type === order.env + 1 && [1, 8].includes(remote.order_type)
                && remote.refund_fee === refund.amountFen && remote.status === 8 && remote.wx_order_id) {
                await ledger.applyRefund({ MchOrderId: order.id, OpenId: order.openid, WxOrderId: order.providerId,
                  WxRefundId: remote.wx_order_id, MchRefundId: refund.id, RefundFee: refund.amountFen, RetCode: 0 },
                undefined, { requireApproved: true });
                await ledger.completeOutbox(job.id); continue;
              }
              // Unknown refund submission must be resolved by query/callback, never a fresh automatic charge mutation.
              await ledger.deferOutbox(job.id); continue;
            }
            const payment = (await adapter().query(order)).order;
            if (payment?.order_id !== order.id || payment.env_type !== order.env + 1 || payment.wx_order_id !== order.providerId
              || payment.left_fee !== order.amountFen - order.refundedFen) throw new Error('XPAY_REFUND_BALANCE_MISMATCH');
            // Channel callbacks may change the refund while its payment query is
            // in flight. Never submit a request using an obsolete approval state.
            const current = await ledger.refund(refund.id);
            if (current?.status === 'succeeded' || current?.status === 'rejected') { await ledger.completeOutbox(job.id); continue; }
            const currentOrder = await ledger.order(order.id);
            await adapter().refund(currentOrder, requireApprovedRefund(current, currentOrder));
          }
        } catch { summary.errors++; await ledger.deferOutbox(job.id); }
      }
      if (summary.errors) alert('virtual_payment.reconciliation_required', summary);
      return summary;
    } finally { sweeping = false; }
  }
  app.post('/api/admin/mini-payments/reconcile', protect(async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    return c.json({ code: 0, data: await reconcile() });
  }));
  app.post('/api/admin/mini-payments/reconcile-paid', protect(async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    if (!(await readiness()).operationsReady) return c.json({ code: 'XPAY_NOT_READY' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const report = await reconcileVirtualPage({ ledger, adapter: adapter(), afterId: body.afterId || '', reviewer: auth.session.username });
    if (report.differences) alert('virtual_payment.balance_discrepancy', { reportId: report.id, differences: report.differences });
    return c.json({ code: 0, data: report });
  }));
  app.post('/api/admin/mini-payments/bill', protect(async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    if (!(await readiness()).operationsReady) return c.json({ code: 'XPAY_NOT_READY' }, 503);
    const body = await c.req.json().catch(() => ({}));
    const pattern = body.ios ? /^20\d{2}(0[1-9]|1[0-2])$/ : /^20\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/;
    if (!pattern.test(String(body.begin)) || !pattern.test(String(body.end)) || Number(body.begin) > Number(body.end)) return c.json({ code: 'XPAY_BILL_RANGE_INVALID' }, 400);
    return c.json({ code: 0, data: body.ios ? await adapter().downloadIosBill(String(body.begin), String(body.end)) : await adapter().downloadBill(Number(body.begin), Number(body.end)) });
  }));
  return { reconcile, sync };
}
