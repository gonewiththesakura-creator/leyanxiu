import crypto from 'node:crypto';
import { validateProducts } from './catalog.js';
import { reconcileTradeBill } from './reconciliation.js';

export function parseProducts(raw) {
  try {
    return validateProducts(JSON.parse(raw || '[]'));
  } catch { return []; }
}

export function registerPaymentRoutes(app, { store, authenticated, requireAdmin, adapter, readiness, operationsReadiness = readiness, products, flush, orderIdFromTrade, accountReady = async () => false, alert = () => {} }) {
  const fail = (c, code, status = 409) => c.json({ code, message: ({ PAYMENT_NOT_READY: '支付暂未开放，请稍后再试', PAYMENT_CHANNEL_UNSUPPORTED: '请使用安卓客户端购买', PAYMENT_QUERY_FAILED: '支付结果确认中，请稍后刷新订单', PAYMENT_PREPAY_FAILED: '暂未获取支付信息，请使用原订单重试', REFUND_FAILED: '退款状态待确认，请勿重复申请', REFUND_QUOTE_CHANGED:'可退金额已变化，请重新查看金额后提交', REFUND_TASK_IN_PROGRESS:'本订单有制作中任务或退款申请，请等待处理结束', REFUND_NOT_AVAILABLE:'当前订单已无可退金额', REFUND_CREDITS_IN_USE:'本订单次数已用完，无法申请未用部分退款' })[code] || '订单状态不允许此操作' }, status);
  const settle = async (transaction, expectedOrderId) => {
    if (!(await operationsReadiness()).ready) throw new Error('PAYMENT_NOT_READY');
    if (expectedOrderId && orderIdFromTrade(transaction.out_trade_no) !== expectedOrderId) throw new Error('PAYMENT_ORDER_MISMATCH');
    const order = await store.getOrder(orderIdFromTrade(transaction.out_trade_no));
    if (!order) throw new Error('ORDER_NOT_FOUND');
    adapter().validateTransaction(transaction, { orderId: order.id, amountCents: order.amountFen });
    if (transaction.trade_state === 'CLOSED' && order.status === 'pending') {
      const result = await store.closePaymentOrder(order.id, order.userId);
      if (result.error) {
        // A successful notification may win the account lock after this query
        // started. Never overwrite its fulfilled order with the older CLOSED read.
        if (result.error === 'PAYMENT_TRANSITION_INVALID') {
          const latest = await store.getOrder(order.id, order.userId);
          if (latest?.fulfilledAt) return latest;
        }
        throw new Error(result.error);
      }
      return result.order;
    }
    if (transaction.trade_state !== 'SUCCESS') return order;
    const result = await store.applyPaymentEvent({ eventId: `wechat:${transaction.transaction_id}`, orderId: order.id, status: 'paid', providerTradeId: transaction.transaction_id, providerPaidAt: transaction.success_time,
      rawDigest: crypto.createHash('sha256').update(JSON.stringify({ orderId: order.id, tradeId: transaction.transaction_id, amount: order.amountFen })).digest('hex') });
    if (result.error) throw new Error(result.error);
    return result.order;
  };
  app.get('/api/products', async c => c.json({ code: 0, data: { available: (await readiness()).ready, mode: process.env.PAYMENT_MODE || 'closed_test', products: await products() } }));
  app.post('/api/orders', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    if (!(await readiness()).ready) return fail(c, 'PAYMENT_NOT_READY', 503);
    if (process.env.PAYMENT_MODE === 'merchant_test' && !String(process.env.PAYMENT_TEST_USER_IDS || '').split(',').map(id => id.trim()).includes(auth.auth.userId)) return fail(c, 'PAYMENT_TEST_ONLY', 403);
    if (process.env.PAYMENT_MODE === 'live' && !(await accountReady(auth.auth.userId))) return c.json({code:'PAYMENT_ACCOUNT_REQUIRED',message:'请先完成账号登录验证，购买记录将保存在账号下'},403);
    const body = await c.req.json().catch(() => ({}));
    if (process.env.PAYMENT_MODE==='live' && body.termsVersion!=='paid-plans-v1') return c.json({code:'PAYMENT_TERMS_REQUIRED',message:'请确认套餐有效期和退款规则后购买'},400);
    if (body.channel !== 'android') return fail(c, 'PAYMENT_CHANNEL_UNSUPPORTED', 400);
    const product = (await products()).find(p => p.id === body.productId);
    const key = String(body.idempotencyKey || c.req.header('idempotency-key') || '');
    if (!product || !/^[A-Za-z0-9:_-]{8,128}$/.test(key)) return fail(c, 'INVALID_ORDER', 400);
    if (product.type === 'monthly' && store.backend !== 'postgres') return fail(c, 'MONTHLY_LEDGER_REQUIRED', 503);
    const created = await store.createOrder({ userId: auth.auth.userId, productId: product.id, amountFen: product.amountFen, credits: product.credits, productSnapshot: product, termsVersion:body.termsVersion, channel: 'android', idempotencyKey: key });
    if (created.error) return fail(c, created.error);
    await flush();
    if (created.order.status !== 'pending') return c.json({ code: 0, data: { order: created.order, paymentRequired: false } });
    try {
      const payment = await adapter().createAppOrder({ orderId: created.order.id, amountCents: created.order.amountFen, description: created.order.productSnapshot?.name || product.name });
      return c.json({ code: 0, data: { order: created.order, paymentRequired: true, payment } });
    } catch {
      alert('payment.prepay_unconfirmed', { orderId: created.order.id });
      // Preserve the recoverable local order even if the remote response was lost.
      return c.json({ code: 0, data: { order: created.order, paymentRequired: true, paymentStatus: 'unconfirmed' } });
    }
  });
  app.get('/api/orders', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    return c.json({ code: 0, data: await store.listOrders(auth.auth.userId) });
  });
  app.post('/api/orders/:orderId/close', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    const order = await store.getOrder(c.req.param('orderId'), auth.auth.userId);
    if (!order) return fail(c, 'NOT_FOUND', 404);
    if (order.status !== 'pending') return c.json({ code: 0, data: { order } });
    if (!(await operationsReadiness()).ready) return fail(c, 'PAYMENT_NOT_READY', 503);
    try {
      await adapter().closeOrder(order.id);
      const result = await store.closePaymentOrder(order.id, auth.auth.userId);
      if (result.error) return fail(c, result.error);
      await flush(); return c.json({ code: 0, data: result });
    } catch {
      try {
        const remote = await adapter().queryOrder(order.id);
        const actual = await settle(remote, order.id);
        if (actual.status === 'closed' || actual.fulfilledAt) { await flush(); return c.json({ code: 0, data: { order: actual } }); }
      } catch { /* An uncertain result cannot release the pending order. */ }
      return fail(c, 'PAYMENT_QUERY_FAILED', 502);
    }
  });
  app.get('/api/orders/:orderId', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    let order = await store.getOrder(c.req.param('orderId'), auth.auth.userId);
    if (!order) return fail(c, 'NOT_FOUND', 404);
    if (order.status === 'pending' && (await operationsReadiness()).ready) {
      try { order = await settle(await adapter().queryOrder(order.id), order.id); await flush(); }
      catch { return fail(c, 'PAYMENT_QUERY_FAILED', 502); }
    }
    return c.json({ code: 0, data: order });
  });
  app.post('/api/payments/wechat/notify', async c => {
    if (!(await operationsReadiness()).ready) return fail(c, 'PAYMENT_NOT_READY', 503);
    try {
      const event = adapter().verifyNotification(await c.req.text(), c.req.raw.headers);
      if (event.eventType !== 'TRANSACTION.SUCCESS') return c.json({ code: 'FAIL', message: 'Unsupported event' }, 400);
      await settle(event.resource); await flush();
      return c.body(null, 204);
    } catch { alert('payment.notification_rejected', {}); return c.json({ code: 'FAIL', message: 'Notification rejected' }, 400); }
  });
  app.get('/api/orders/:orderId/refund-quote', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    const order = await store.getOrder(c.req.param('orderId'),auth.auth.userId);
    if (!order) return fail(c,'NOT_FOUND',404);
    const quote = store.quoteRefund ? await store.quoteRefund(order.id,auth.auth.userId) : {amountFen:order.amountFen,credits:order.credits};
    return quote.error ? fail(c,quote.error) : c.json({code:0,data:quote});
  });
  app.post('/api/orders/:orderId/refund', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    if (store.backend==='postgres' && !Number.isSafeInteger(body.expectedAmountFen)) return fail(c,'REFUND_QUOTE_REQUIRED',400);
    const result = await store.requestRefund(c.req.param('orderId'), auth.auth.userId, String(body.reason || '').slice(0, 200), body.expectedAmountFen);
    if (result.error) return fail(c, result.error);
    await flush(); return c.json({ code: 0, data: result });
  });
  app.get('/api/admin/billing', async c => {
    const auth = requireAdmin(c, { roles: ['owner', 'reviewer', 'auditor'] }); if (auth.response) return auth.response;
    return c.json({ code: 0, data: { readiness: await readiness(), operationsReadiness: await operationsReadiness(), orders: await store.listOrders(), refunds: await store.listRefunds(), reconciliation: await store.reconcileEntitlements(), products: await products(), dailyBills:store.listReconciliations ? await store.listReconciliations() : [] } });
  });
  app.put('/api/admin/billing/products', async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    try {
      if (body.products?.some(p => p.type === 'monthly') && store.backend !== 'postgres') return fail(c, 'MONTHLY_LEDGER_REQUIRED', 400);
      const result = await store.savePaymentProducts(body.products, auth.session.username);
      await flush(); return c.json({ code: 0, data: { products: result } });
    } catch { return fail(c, 'INVALID_PAYMENT_PRODUCTS', 400); }
  });
  app.post('/api/admin/billing/refunds/:refundId/approve', async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    if (!(await operationsReadiness()).ready) return fail(c, 'PAYMENT_NOT_READY', 503);
    const result = await store.approveRefund(c.req.param('refundId'), auth.session.username);
    if (result.error) return fail(c, result.error);
    await flush();
    try {
      const refund = result.refund;
      const order = await store.getOrder(refund.orderId);
      // Full reason is retained in the audit ledger; WeChat allows at most 80 UTF-8 bytes.
      let reason = '';
      for (const character of refund.reason) { if (Buffer.byteLength(reason + character) > 80) break; reason += character; }
      const remote = await adapter().refund({ orderId: order.id, refundId: refund.id, totalCents: order.amountFen, refundCents: refund.amountFen, reason });
      adapter().validateRefund(remote, { orderId: order.id, refundId: refund.id, totalCents: order.amountFen, refundCents: refund.amountFen, transactionId: order.providerTradeId });
      const applied = await store.applyRefundResult({ refundId: refund.id, status: remote.status, providerRefundId: remote.refund_id, providerTradeId: remote.transaction_id, providerRefundedAt: remote.success_time });
      if (applied.error) return fail(c, applied.error);
      await flush(); return c.json({ code: 0, data: applied });
    } catch { alert('payment.refund_unconfirmed', { refundId: result.refund.id }); return fail(c, 'REFUND_FAILED', 502); }
  });
  app.post('/api/payments/wechat/refund-notify', async c => {
    if (!(await operationsReadiness()).ready) return fail(c, 'PAYMENT_NOT_READY', 503);
    try {
      const event = adapter().verifyNotification(await c.req.text(), c.req.raw.headers);
      if (!['REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED'].includes(event.eventType)) throw new Error('INVALID_EVENT');
      const remote = event.resource;
      const refund = await store.getRefund(remote.out_refund_no);
      if (!refund) throw new Error('UNKNOWN_REFUND');
      const order = await store.getOrder(refund.orderId);
      adapter().validateRefund(remote, { orderId: order.id, refundId: refund.id, totalCents: order.amountFen, refundCents: refund.amountFen, transactionId: order.providerTradeId });
      const result = await store.applyRefundResult({ refundId: refund.id, status: remote.refund_status, providerRefundId: remote.refund_id, providerTradeId: remote.transaction_id, providerRefundedAt: remote.success_time });
      if (result.error) throw new Error(result.error);
      await flush(); return c.body(null, 204);
    } catch { return c.json({ code: 'FAIL', message: 'Notification rejected' }, 400); }
  });
  app.get('/api/refunds', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    return c.json({ code: 0, data: await store.listRefunds(auth.auth.userId) });
  });
  app.post('/api/admin/billing/refunds/:refundId/reject', async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    const body = await c.req.json().catch(() => ({}));
    const reason = String(body.reason || '').trim();
    if (!reason || reason.length > 200) return fail(c, 'REFUND_REVIEW_REQUIRED', 400);
    const result = await store.rejectRefund(c.req.param('refundId'), auth.session.username, reason);
    if (result.error) return fail(c, result.error);
    await flush(); return c.json({ code: 0, data: result });
  });
  app.post('/api/admin/billing/refunds/:refundId/sync', async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    if (!(await operationsReadiness()).ready) return fail(c, 'PAYMENT_NOT_READY', 503);
    const refund = await store.getRefund(c.req.param('refundId'));
    if (!refund) return fail(c, 'REFUND_NOT_FOUND', 404);
    try {
      const order = await store.getOrder(refund.orderId);
      const remote = await adapter().queryRefund(refund.id);
      adapter().validateRefund(remote, { orderId: order.id, refundId: refund.id, totalCents: order.amountFen, refundCents: refund.amountFen, transactionId: order.providerTradeId });
      const result = await store.applyRefundResult({ refundId: refund.id, status: remote.status, providerRefundId: remote.refund_id, providerTradeId: remote.transaction_id, providerRefundedAt: remote.success_time });
      if (result.error) return fail(c, result.error);
      await flush(); return c.json({ code: 0, data: result });
    } catch { return fail(c, 'REFUND_FAILED', 502); }
  });
  let sweeping = false;
  let offset = 0;
  let refundOffset = 0;
  async function reconcilePending() {
    if (!(await operationsReadiness()).ready) return { blocked: true, checked: 0, settled: 0, errors: 0 };
    if (sweeping) return { busy: true };
    sweeping = true;
    const summary = { checked: 0, settled: 0, errors: 0, refundsChecked: 0, refundsConfirmed: 0 };
    try {
      const pending = (await store.listOrders()).filter(order => order.channel === 'android' && order.status === 'pending');
      if (offset >= pending.length) offset = 0;
      const batch = pending.slice(offset, offset + 20); offset += batch.length;
      for (const order of batch) {
        summary.checked++;
        try { const result = await settle(await adapter().queryOrder(order.id), order.id); if (result.status === 'paid') summary.settled++; }
        catch { summary.errors++; }
      }
      const refunds = (await store.listRefunds()).filter(refund => ['processing', 'abnormal'].includes(refund.status));
      if (refundOffset >= refunds.length) refundOffset = 0;
      const refundBatch = refunds.slice(refundOffset, refundOffset + 10); refundOffset += refundBatch.length;
      for (const refund of refundBatch) {
        summary.refundsChecked++;
        try {
          const order = await store.getOrder(refund.orderId);
          const remote = await adapter().queryRefund(refund.id);
          adapter().validateRefund(remote, { orderId: order.id, refundId: refund.id, totalCents: order.amountFen, refundCents: refund.amountFen, transactionId: order.providerTradeId });
          const result = await store.applyRefundResult({ refundId: refund.id, status: remote.status, providerRefundId: remote.refund_id, providerTradeId: remote.transaction_id, providerRefundedAt: remote.success_time });
          if (result.error) throw new Error(result.error);
          if (result.refund.status === 'succeeded') summary.refundsConfirmed++;
        } catch { summary.errors++; }
      }
      await flush();
      if (summary.errors) alert('payment.reconciliation_unconfirmed', summary);
      return summary;
    } finally { sweeping = false; }
  }
  app.post('/api/admin/billing/reconcile', async c => {
    const auth = requireAdmin(c, { roles: ['owner'], csrf: true }); if (auth.response) return auth.response;
    return c.json({ code: 0, data: await reconcilePending() });
  });
  let reconcilingBill=false;
  async function reconcileDaily(date,actor='scheduler') {
    if (reconcilingBill) return {busy:true};
    if (!(await operationsReadiness()).ready || !store.saveReconciliation) return {blocked:true};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('INVALID_BILL_DATE');
    reconcilingBill=true;
    try {
      const bill=await adapter().downloadTradeBill(date);
      const report=reconcileTradeBill({...bill,date,orders:await store.listOrders(),refunds:await store.listRefunds()});
      const saved=await store.saveReconciliation({...report,hash:bill.hash,checkedAt:new Date().toISOString()},actor);
      if(!report.ok) alert('payment.daily_bill_mismatch',{date,differences:report.differences.length});
      return saved;
    } finally {reconcilingBill=false;}
  }
  app.post('/api/admin/billing/daily-bill',async c=>{
    const auth=requireAdmin(c,{roles:['owner'],csrf:true});if(auth.response)return auth.response;
    const body=await c.req.json().catch(()=>({}));
    try {return c.json({code:0,data:await reconcileDaily(body.date,auth.session.username)});}
    catch {alert('payment.daily_bill_unconfirmed',{});return fail(c,'BILL_RECONCILIATION_FAILED',502);}
  });
  return { reconcilePending, reconcileDaily };
}
