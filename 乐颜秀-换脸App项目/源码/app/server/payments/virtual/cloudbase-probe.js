import crypto from 'node:crypto';
import { draftProducts, parseVirtualProducts } from './products.js';
import { validatePaidOrder } from './wechat.js';

export const cloudbaseProbeAppId = 'REDACTED_APP_IDENTIFIER';
export const cloudbaseProbePrefix = 'lyx_xpay_probe_';
const product = parseVirtualProducts([draftProducts[0]])[0];
const hash = (...parts) => crypto.createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const fail = code => { throw new Error(code); };
const validUser = value => /^probe_user_[a-z0-9]{1,24}$/.test(value || '');
const validReference = value => /^[a-f0-9]{64}$/.test(value || '');
const assertBucket = bucket => {
  if (!bucket || ![bucket.quantity, bucket.remaining, bucket.reserved, bucket.frozen].every(Number.isSafeInteger)
    || bucket.quantity !== 10 || Math.min(bucket.remaining, bucket.reserved, bucket.frozen) < 0
    || bucket.remaining + bucket.reserved + bucket.frozen > bucket.quantity) fail('XPAY_PROBE_BUCKET_INVARIANT');
};

// Inject wx-server-sdk cloud.database({ throwOnNotFound: false }); this is not a production ledger.
export function createCloudbaseProbe({ database, runId, appId, env, mode, synthetic,
  collectionPrefix = cloudbaseProbePrefix, deployment = 'isolated-probe', now = Date.now }) {
  if (!database?.startTransaction || !/^[a-f0-9]{12}$/.test(runId || '')
    || appId !== cloudbaseProbeAppId || env !== 1 || mode !== 'probe' || synthetic !== true
    || collectionPrefix !== cloudbaseProbePrefix || deployment !== 'isolated-probe') fail('XPAY_PROBE_ISOLATION_REQUIRED');
  const collections = Object.freeze(Object.fromEntries(['binding', 'accounts', 'orders', 'trades', 'events', 'buckets', 'reservations', 'audit']
    .map(name => [name, `${cloudbaseProbePrefix}${name}`])));
  const docId = (kind, reference) => hash(runId, kind, reference);
  const ref = (transaction, kind, reference) => transaction.collection(collections[kind]).doc(docId(kind, reference));
  const checked = result => {
    if (result?.code) { const error = new Error('XPAY_PROBE_DATABASE_ERROR'); error.code = result.code; throw error; }
    return result;
  };
  const read = async (transaction, kind, reference) => {
    const result = checked(await ref(transaction, kind, reference).get());
    if (!result || !Object.hasOwn(result, 'data')) fail('XPAY_PROBE_DATABASE_RESPONSE_INVALID');
    if (Array.isArray(result.data) || (result.data != null && typeof result.data !== 'object')) fail('XPAY_PROBE_WECHAT_SDK_REQUIRED');
    const value = result.data;
    if (value == null) return null;
    const { _id, ...document } = value;
    return document;
  };
  const write = async (transaction, kind, reference, value) => checked(await ref(transaction, kind, reference).set({ data: value }));
  async function transaction(callback) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const current = await database.startTransaction();
      try {
        const result = await callback(current);
        checked(await current.commit());
        return result;
      } catch (error) {
        await current.rollback().catch(() => {});
        // Retry only an explicit conflict, never a timeout or an ambiguous commit response.
        if (error.code !== 'TRANSACTION_CONFLICT' || attempt === 31) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 8) + 1));
      }
    }
  }
  const binding = { runId, appId, env, synthetic: true, version: 1 };
  const matchesBinding = stored => stored && Object.entries(binding).every(([field, value]) => stored[field] === value);
  const assertBinding = async current => {
    const stored = await read(current, 'binding', 'singleton');
    if (!matchesBinding(stored)) fail('XPAY_PROBE_BINDING_REQUIRED');
  };
  const touchAccount = async (current, userId) => {
    if (!validUser(userId)) fail('XPAY_PROBE_USER_REQUIRED');
    const account = await read(current, 'accounts', userId);
    if (!account || account.userId !== userId) fail('XPAY_PROBE_USER_REQUIRED');
    // A real write supplies the conflict boundary that a read alone cannot provide.
    await write(current, 'accounts', userId, { ...account, revision: account.revision + 1 });
  };
  const audit = (current, action, reference, userId) => write(current, 'audit', `${action}:${reference}`, {
    action, reference, userId, at: now(), synthetic: true,
  });
  const ownedOrder = async (current, orderId, userId) => {
    const order = await read(current, 'orders', orderId);
    if (!order) fail('XPAY_PROBE_ORDER_NOT_FOUND');
    if (userId && order.userId !== userId) fail('XPAY_PROBE_OWNERSHIP_REQUIRED');
    return order;
  };
  return {
    collections,
    evidenceScope: 'isolated-synthetic-document-ledger',
    initialize() {
      return transaction(async current => {
        const existing = await read(current, 'binding', 'singleton');
        if (existing && !matchesBinding(existing)) fail('XPAY_PROBE_BINDING_CONFLICT');
        if (!existing) await write(current, 'binding', 'singleton', binding);
        return binding;
      });
    },
    createAccount(userId) {
      if (!validUser(userId)) fail('XPAY_PROBE_USER_REQUIRED');
      return transaction(async current => {
        await assertBinding(current);
        const existing = await read(current, 'accounts', userId);
        if (!existing) await write(current, 'accounts', userId, { userId, revision: 0, synthetic: true });
        return { userId };
      });
    },
    createOrder({ userId, idempotencyKey }) {
      if (!/^probe_[a-z0-9_-]{8,80}$/.test(idempotencyKey || '')) fail('XPAY_PROBE_IDEMPOTENCY_REQUIRED');
      const orderId = hash(runId, userId, idempotencyKey).slice(0, 32);
      return transaction(async current => {
        await assertBinding(current); await touchAccount(current, userId);
        const existing = await read(current, 'orders', orderId);
        if (existing) {
          if (existing.userId !== userId || existing.idempotencyKey !== idempotencyKey) fail('XPAY_PROBE_IDEMPOTENCY_CONFLICT');
          return existing;
        }
        const order = { id: orderId, userId, appId, env, openid: `synthetic:${runId}:${userId}`, platform: 'android',
          productId: product.id, product: structuredClone(product), amountFen: product.amountFen, status: 'pending', createdAt: now(), idempotencyKey, synthetic: true };
        await write(current, 'orders', orderId, order);
        await audit(current, 'order.created', orderId, userId);
        return order;
      });
    },
    settle(orderId, remote) {
      return transaction(async current => {
        await assertBinding(current);
        const order = await ownedOrder(current, orderId);
        validatePaidOrder(remote, order);
        if (!/^probe_trade_[a-z0-9_-]{8,80}$/.test(remote.wx_order_id)) fail('XPAY_PROBE_SYNTHETIC_TRADE_REQUIRED');
        if (remote.order_type !== 0 || !['pending', 'paid'].includes(order.status)) fail('XPAY_PROBE_PAYMENT_TRANSITION');
        if (order.providerId && order.providerId !== remote.wx_order_id) fail('XPAY_PROBE_TRADE_CONFLICT');
        const paidAt = remote.paid_time * 1000;
        if (paidAt > now() + 300000 || paidAt < order.createdAt - 300000) fail('XPAY_PROBE_PAYMENT_TIME_INVALID');
        await touchAccount(current, order.userId);
        const prior = await read(current, 'trades', remote.wx_order_id);
        if (prior && prior.orderId !== orderId) fail('XPAY_PROBE_TRADE_CONFLICT');
        const eventId = `paid:${remote.wx_order_id}`;
        const material = hash(orderId, order.amountFen, remote.wx_order_id);
        const event = await read(current, 'events', eventId);
        if (event && (event.orderId !== orderId || event.material !== material)) fail('XPAY_PROBE_EVENT_CONFLICT');
        if (order.status === 'paid') {
          if (!prior || !event) fail('XPAY_PROBE_PAYMENT_INVARIANT');
          return order;
        }
        const bucket = { orderId, userId: order.userId, quantity: 10, remaining: 10, reserved: 0, frozen: 0,
          startsAt: paidAt, expiresAt: paidAt + product.days * 86400000 };
        assertBucket(bucket);
        Object.assign(order, { status: 'paid', providerId: remote.wx_order_id, paidAt });
        await write(current, 'trades', remote.wx_order_id, { orderId });
        await write(current, 'events', eventId, { orderId, material });
        await write(current, 'buckets', orderId, bucket);
        await write(current, 'orders', orderId, order);
        await audit(current, 'payment.granted', orderId, order.userId);
        return order;
      });
    },
    reserve(userId, orderId, reference) {
      if (!validReference(reference)) fail('XPAY_PROBE_REFERENCE_REQUIRED');
      return transaction(async current => {
        await assertBinding(current); await touchAccount(current, userId);
        const order = await ownedOrder(current, orderId, userId);
        const prior = await read(current, 'reservations', reference);
        if (prior) {
          if (prior.userId !== userId || prior.orderId !== orderId) fail('XPAY_PROBE_RESERVATION_CONFLICT');
          return { ok: prior.status !== 'returned', duplicate: true };
        }
        if (order.status !== 'paid') return { ok: false, duplicate: false };
        const bucket = await read(current, 'buckets', orderId); assertBucket(bucket);
        if (bucket.remaining < 1 || bucket.startsAt > now() || bucket.expiresAt <= now()) return { ok: false, duplicate: false };
        bucket.remaining--; bucket.reserved++; assertBucket(bucket);
        await write(current, 'buckets', orderId, bucket);
        await write(current, 'reservations', reference, { userId, orderId, status: 'reserved', createdAt: now() });
        await audit(current, 'creation.reserved', reference, userId);
        return { ok: true, duplicate: false };
      });
    },
    finish(userId, reference, outcome) {
      if (!validReference(reference) || !['success', 'failed', 'unknown'].includes(outcome)) fail('XPAY_PROBE_OUTCOME_INVALID');
      return transaction(async current => {
        await assertBinding(current); await touchAccount(current, userId);
        const reservation = await read(current, 'reservations', reference);
        if (!reservation) return false;
        if (reservation.userId !== userId) fail('XPAY_PROBE_OWNERSHIP_REQUIRED');
        if (['consumed', 'returned'].includes(reservation.status)) return false;
        if (outcome === 'unknown') {
          reservation.status = 'unknown';
        } else {
          const order = await ownedOrder(current, reservation.orderId, userId);
          const bucket = await read(current, 'buckets', order.id); assertBucket(bucket);
          if (bucket.reserved < 1) fail('XPAY_PROBE_RESERVATION_INVARIANT');
          bucket.reserved--;
          if (outcome === 'failed' && order.status === 'paid' && bucket.expiresAt > now()) bucket.remaining++;
          assertBucket(bucket); await write(current, 'buckets', order.id, bucket);
          reservation.status = outcome === 'success' ? 'consumed' : 'returned';
        }
        await write(current, 'reservations', reference, reservation);
        await audit(current, `creation.${outcome}`, reference, userId);
        return true;
      });
    },
    requestRefund(orderId, userId) {
      return transaction(async current => {
        await assertBinding(current); await touchAccount(current, userId);
        const order = await ownedOrder(current, orderId, userId);
        if (order.status === 'refund_pending') return order;
        if (order.status !== 'paid') fail('XPAY_PROBE_REFUND_TRANSITION');
        const bucket = await read(current, 'buckets', orderId); assertBucket(bucket);
        if (bucket.reserved > 0) fail('XPAY_PROBE_REFUND_GENERATION_PENDING');
        if (bucket.remaining === 0) fail('XPAY_PROBE_REFUND_NO_UNUSED_RIGHTS');
        bucket.frozen += bucket.remaining; bucket.remaining = 0; assertBucket(bucket);
        order.status = 'refund_pending';
        await write(current, 'buckets', orderId, bucket); await write(current, 'orders', orderId, order);
        await audit(current, 'refund.frozen', orderId, userId);
        return order;
      });
    },
    applyFullRefund(orderId, userId, refundId) {
      if (!/^probe_refund_[a-z0-9_-]{8,80}$/.test(refundId || '')) fail('XPAY_PROBE_SYNTHETIC_REFUND_REQUIRED');
      return transaction(async current => {
        await assertBinding(current); await touchAccount(current, userId);
        const order = await ownedOrder(current, orderId, userId);
        const eventId = `refund:${refundId}`;
        const previous = await read(current, 'events', eventId);
        if (previous) {
          if (previous.orderId !== orderId || order.status !== 'refunded') fail('XPAY_PROBE_EVENT_CONFLICT');
          return order;
        }
        if (!['paid', 'refund_pending'].includes(order.status)) fail('XPAY_PROBE_REFUND_TRANSITION');
        const bucket = await read(current, 'buckets', orderId); assertBucket(bucket);
        // A channel refund can overtake an unknown generation; retain its hold but revoke spendable rights.
        bucket.remaining = 0; bucket.frozen = 0; assertBucket(bucket);
        order.status = 'refunded'; order.refundedFen = order.amountFen;
        await write(current, 'events', eventId, { orderId });
        await write(current, 'buckets', orderId, bucket); await write(current, 'orders', orderId, order);
        await audit(current, 'refund.succeeded', orderId, userId);
        return order;
      });
    },
    state(orderId, userId) {
      if (!validUser(userId)) fail('XPAY_PROBE_USER_REQUIRED');
      return transaction(async current => {
        await assertBinding(current);
        const order = await ownedOrder(current, orderId, userId);
        return { order, bucket: await read(current, 'buckets', orderId) };
      });
    },
  };
}
