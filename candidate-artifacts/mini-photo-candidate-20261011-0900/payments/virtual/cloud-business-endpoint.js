import { readMessageJson } from './message-endpoint.js';
import { validateDelivery, validatePaidOrder } from './wechat.js';

const fail = code => { throw new Error(code); };
const paymentEvents = new Set(['xpay_goods_deliver_notify', 'xpay_refund_notify']);

// Query-authoritative transport: neither the body nor x-wx-source(s) proves
// that a request is an official payment notification. An arbitrary caller can
// only ask us to query a pre-existing local order/refund through the configured
// adapter. Provider-confirmed state, not the caller's claimed state, changes
// the ledger. Unsupported events remain retryable until their source and
// business contracts are established.
export function createCloudBusinessEndpoint({ appId, ledger, adapter, readiness, alert = () => {} }) {
  if (!appId || adapter?.appId !== appId || ![0, 1].includes(adapter?.env)
    || !ledger || typeof readiness !== 'function') fail('XPAY_CLOUD_CONFIG_REQUIRED');
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
  const response = (body, status = 200) => Response.json(body, { status, headers });
  const confirmed = () => response({ ErrCode: 0, ErrMsg: 'success' });
  const retry = (code, status = 503) => {
    try { alert('virtual_payment.cloud_callback_rejected', { code, mode: 'query-authoritative' }); }
    catch { /* Alert failures must never acknowledge uncommitted processing. */ }
    return response({ ErrCode: 1, ErrMsg: code }, status);
  };
  const checkOrder = order => {
    if (!order) fail('XPAY_ORDER_NOT_FOUND');
    if (order.appId !== appId || order.env !== adapter.env) fail('XPAY_ORDER_MISMATCH');
  };

  async function delivery(message) {
    const order = await ledger.order(message.OutTradeNo);
    checkOrder(order);
    validateDelivery(message, order);
    if (!['pending', 'paid', 'refund_pending'].includes(order.status) || order.refundedFen !== 0) fail('XPAY_PAYMENT_TRANSITION');
    if (!await ledger.claimQuery(order.id)) fail('XPAY_QUERY_BUSY');
    // Only the stored OpenID and order ID reach the provider adapter.
    const remote = (await adapter.query(order))?.order;
    validatePaidOrder(remote, order);
    if (order.status === 'pending') await ledger.settle(order.id, remote);
    const paid = await ledger.order(order.id);
    checkOrder(paid);
    validateDelivery(message, paid);
    if (!['paid', 'refund_pending'].includes(paid.status) || paid.refundedFen !== 0
      || paid.providerId !== remote.wx_order_id) fail('XPAY_PAYMENT_UNCONFIRMED');
    // This caller may be a user, so our HTTP ACK does not prove that WeChat
    // received it. Keep the durable delivery job: reconciliation actively calls
    // notify_provide_goods and only then marks that job complete.
  }

  async function refund(message) {
    if (message.MsgType !== 'event' || message.RetCode !== 0) fail('XPAY_REFUND_REVIEW_REQUIRED');
    const order = await ledger.order(message.MchOrderId);
    checkOrder(order);
    const local = await ledger.refund(message.MchRefundId);
    // The current ledger calls an approved refund "processing". Requested,
    // rejected, abnormal and channel-initiated refunds require another workflow.
    if (!local || !['processing', 'succeeded'].includes(local.status)
      || typeof local.reviewer !== 'string' || !local.reviewer.trim()) fail('XPAY_REFUND_REVIEW_REQUIRED');
    if (local.orderId !== order.id || local.userId !== order.userId
      || message.OpenId !== order.openid || message.WxOrderId !== order.providerId
      || !Number.isSafeInteger(message.RefundFee) || message.RefundFee !== local.amountFen
      || typeof message.WxRefundId !== 'string' || !message.WxRefundId
      || (local.status === 'succeeded' && local.providerRefundId !== message.WxRefundId)) fail('XPAY_REFUND_MISMATCH');
    if (!await ledger.claimQuery(order.id)) fail('XPAY_QUERY_BUSY');
    const remote = (await adapter.queryRefund(order, local))?.order;
    // This endpoint trusts the query, not the caller's RetCode. Status 5 is
    // only the merchant debit; acknowledge completion after user receipt (8).
    if (!remote || remote.order_id !== local.id || remote.env_type !== order.env + 1
      || ![1, 8].includes(remote.order_type) || remote.status !== 8
      || remote.refund_fee !== local.amountFen || remote.wx_order_id !== message.WxRefundId) fail('XPAY_REFUND_UNCONFIRMED');
    await ledger.applyRefund({ MchOrderId: order.id, OpenId: order.openid, WxOrderId: order.providerId,
      MchRefundId: local.id, WxRefundId: remote.wx_order_id, RefundFee: remote.refund_fee, RetCode: 0 },
    undefined, { requireApproved: true });
    const applied = await ledger.refund(local.id);
    const updated = await ledger.order(order.id);
    if (applied?.status !== 'succeeded' || applied.providerRefundId !== remote.wx_order_id
      || updated?.status !== 'refunded' || updated.refundedFen < local.amountFen) fail('XPAY_REFUND_UNCONFIRMED');
    // Reconciliation can complete the refund job after observing this committed
    // succeeded state; this endpoint never submits or retries a refund itself.
  }

  return async request => {
    if (request.method !== 'POST') return response({ ErrCode: 1, ErrMsg: 'XPAY_METHOD_INVALID' }, 405);
    try {
      const message = await readMessageJson(request);
      if (!message || typeof message !== 'object' || Array.isArray(message)) fail('XPAY_MESSAGE_INVALID');
      // Connectivity checks are isolated from readiness, provider queries and
      // ledger writes. Adding an event or other business fields removes the probe.
      if (message.action === 'CheckContainerPath' && Object.keys(message).length === 1) return new Response('success', { headers });
      if (message.action !== undefined || !paymentEvents.has(message.Event)) fail('XPAY_EVENT_REVIEW_REQUIRED');
      if ((await readiness())?.operationsReady !== true) fail('XPAY_NOT_READY');
      if (message.Event === 'xpay_goods_deliver_notify') await delivery(message);
      else await refund(message);
      return confirmed();
    } catch (error) {
      const code = /^XPAY_[A-Z_]+$/.test(error?.message) ? error.message : 'XPAY_UNCONFIRMED';
      return retry(code, code === 'XPAY_MESSAGE_TOO_LARGE' ? 413 : code === 'XPAY_MESSAGE_INVALID' ? 400 : 503);
    }
  };
}
