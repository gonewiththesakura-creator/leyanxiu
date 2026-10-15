import crypto from 'node:crypto';
import { parseVirtualProducts } from './products.js';
import { validatePaidOrder } from './wechat.js';
import { createReservationTransactions, validateReservationInput, validateReservationFinish } from './reservation-transactions.js';

const DAY = 86400000;
const id = () => crypto.randomUUID().replaceAll('-', '');
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = code => { throw new Error(code); };
const read = row => row ? JSON.parse(row.payload) : null;
export const publicOrder = order => order && ({ id: order.id, productId: order.productId, product: order.product, amountFen: order.amountFen,
  status: order.status, createdAt: order.createdAt, paidAt: order.paidAt, startsAt: order.startsAt, expiresAt: order.expiresAt,
  refundedFen: order.refundedFen, platform: order.platform, paymentRetryable: order.status === 'pending' && order.remoteStatus === 0 });

export function createVirtualLedger({ database, encryptionKey, now = Date.now }) {
  if (!/^[a-f0-9]{64}$/i.test(encryptionKey || '')) throw new Error('XPAY_SESSION_KEY_ENCRYPTION_REQUIRED');
  const key = Buffer.from(encryptionKey, 'hex');
  const tx = database.transaction.bind(database);
  const lock = async (q, userId) => {
    const rows = await q(`SELECT user_id FROM vp_accounts WHERE user_id = ?${database.backend === 'mysql' ? ' FOR UPDATE' : ''}`, [userId]);
    if (!rows.length) fail('XPAY_IDENTITY_REQUIRED');
  };
  const audit = (q, user, action, reference, detail = {}) => q('INSERT INTO vp_audit(id,user_id,action,reference_id,detail,created_at) VALUES (?,?,?,?,?,?)', [id(), user, action, reference, JSON.stringify(detail), now()]);
  const get = async (q, orderId) => read((await q('SELECT payload FROM vp_orders WHERE id = ?', [orderId]))[0]);
  const reservations = createReservationTransactions({ lock, audit, getOrder: get, now });
  const save = (q, order) => q('UPDATE vp_orders SET status = ?, provider_id = ?, payload = ? WHERE id = ?', [order.status, order.providerId || null, JSON.stringify(order), order.id]);
  const getRefund = async (q, refundId) => read((await q('SELECT payload FROM vp_refunds WHERE id = ?', [refundId]))[0]);
  const saveRefund = (q, refund) => q('UPDATE vp_refunds SET status = ?, payload = ? WHERE id = ?', [refund.status, JSON.stringify(refund), refund.id]);
  async function event(q, eventId, orderId, material) {
    const hash = digest(material); const prior = (await q('SELECT * FROM vp_events WHERE id = ?', [eventId]))[0];
    if (prior) { if (prior.order_id !== orderId || prior.digest !== hash) fail('XPAY_EVENT_CONFLICT'); return false; }
    await q('INSERT INTO vp_events(id,order_id,digest,created_at) VALUES (?,?,?,?)', [eventId, orderId, hash, now()]); return true;
  }
  const seal = (value, aad) => {
    const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(aad));
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), value: encrypted.toString('base64') });
  };
  const open = (sealed, aad) => {
    const value = JSON.parse(sealed); const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(value.value, 'base64')), decipher.final()]).toString();
  };
  return {
    database,
    bindEnvironment(appId, env) {
      if (!appId || ![0, 1].includes(env)) fail('XPAY_ENV_INVALID');
      return tx(async q => {
        const current = (await q('SELECT * FROM vp_environment WHERE id = 1'))[0];
        if (current && (current.app_id !== appId || current.env !== env)) fail('XPAY_DATABASE_ENV_MISMATCH');
        if (!current) await q('INSERT INTO vp_environment(id,app_id,env) VALUES (1,?,?)', [appId, env]);
      });
    },
    async bindSession({ userId, sessionId, appId, openid, sessionKey }) {
      if (!userId || !sessionId || !appId || typeof openid !== 'string' || !openid || openid.length > 128 || typeof sessionKey !== 'string' || Buffer.from(sessionKey, 'base64').length !== 16) fail('XPAY_IDENTITY_INVALID');
      return tx(async q => {
        const prior = (await q('SELECT * FROM vp_accounts WHERE user_id = ?', [userId]))[0];
        if (prior && (prior.app_id !== appId || prior.openid !== openid)) fail('XPAY_IDENTITY_CONFLICT');
        if (!prior) await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [userId, appId, openid]);
        await lock(q, userId);
        // A new login rotates the WeChat session key; old sessions retain identity but must login again to pay.
        await q('DELETE FROM vp_sessions WHERE user_id = ? OR expires_at <= ?', [userId, now()]);
        await q('INSERT INTO vp_sessions(id,user_id,sealed,expires_at) VALUES (?,?,?,?)', [sessionId, userId, seal(sessionKey, `${appId}:${userId}:${sessionId}`), now() + 10 * 60000]);
        await audit(q, userId, 'session.bound', sessionId);
      });
    },
    identity(userId) { return tx(async q => (await q('SELECT * FROM vp_accounts WHERE user_id = ?', [userId]))[0] || null); },
    sessionKey(userId, sessionId) {
      return tx(async q => {
        const row = (await q('SELECT * FROM vp_sessions WHERE id = ? AND user_id = ?', [sessionId, userId]))[0];
        const account = (await q('SELECT * FROM vp_accounts WHERE user_id = ?', [userId]))[0];
        if (!row || !account || row.expires_at <= now()) fail('XPAY_LOGIN_REFRESH_REQUIRED');
        return open(row.sealed, `${account.app_id}:${userId}:${sessionId}`);
      });
    },
    createOrder({ userId, product, idempotencyKey, appId, env, platform, rulesVersion }) {
      const approved = parseVirtualProducts([product])[0];
      if (!/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey || '') || ![0, 1].includes(env) || !['android', 'ios', 'windows'].includes(platform) || (platform === 'ios' && env === 1)) fail('XPAY_ORDER_INVALID');
      return tx(async q => {
        await lock(q, userId);
        const environment = (await q('SELECT * FROM vp_environment WHERE id = 1'))[0];
        if (!environment || environment.app_id !== appId || environment.env !== env) fail('XPAY_DATABASE_ENV_MISMATCH');
        const account = (await q('SELECT * FROM vp_accounts WHERE user_id = ?', [userId]))[0];
        if (account.app_id !== appId) fail('XPAY_IDENTITY_MISMATCH');
        const prior = read((await q('SELECT payload FROM vp_orders WHERE user_id = ? AND idem = ?', [userId, idempotencyKey]))[0]);
        if (prior) {
          if (digest(prior.product) !== digest(approved) || prior.env !== env || prior.platform !== platform) fail('XPAY_IDEMPOTENCY_CONFLICT');
          return prior;
        }
        const pendingCount = Number((await q("SELECT COUNT(*) AS n FROM vp_orders WHERE user_id = ? AND status = 'pending'", [userId]))[0].n);
        if (pendingCount >= 10) fail('XPAY_PENDING_ORDER_LIMIT');
        const order = { id: id(), userId, appId, openid: account.openid, env, platform, productId: approved.id, product: approved,
          amountFen: approved.amountFen, status: 'pending', refundedFen: 0, createdAt: now(),
          purchaseAcceptance: rulesVersion ? { rulesVersion, acceptedAt: now() } : null };
        await q('INSERT INTO vp_orders(id,user_id,idem,status,payload,created_at) VALUES (?,?,?,?,?,?)', [order.id, userId, idempotencyKey, order.status, JSON.stringify(order), now()]);
        await audit(q, userId, 'order.created', order.id, { productId: order.productId, amountFen: order.amountFen }); return order;
      });
    },
    order(orderId, userId) { return tx(async q => { const order = await get(q, orderId); return order && (!userId || order.userId === userId) ? order : null; }); },
    orders(userId, { pending = false } = {}) {
      return tx(async q => (await q(`SELECT payload FROM vp_orders WHERE ${userId ? 'user_id = ?' : '1 = 1'}${pending ? " AND status = 'pending'" : ''} ORDER BY ${pending ? 'checked_at ASC, created_at ASC' : 'created_at DESC'} LIMIT 100`, userId ? [userId] : [])).map(read));
    },
    claimQuery(orderId) {
      return tx(async q => {
        const row = (await q(`SELECT checked_at FROM vp_orders WHERE id = ?${database.backend === 'mysql' ? ' FOR UPDATE' : ''}`, [orderId]))[0];
        if (!row || row.checked_at > now() - 5000) return false;
        await q('UPDATE vp_orders SET checked_at = ? WHERE id = ?', [now(), orderId]); return true;
      });
    },
    closeOrder(orderId, remote) {
      return tx(async q => {
        const order = await get(q, orderId); if (!order) fail('XPAY_ORDER_NOT_FOUND'); await lock(q, order.userId);
        if (remote.order_id !== order.id || remote.env_type !== order.env + 1 || remote.status !== 6) fail('XPAY_ORDER_MISMATCH');
        if (order.status === 'pending') { order.status = 'closed'; await save(q, order); await audit(q, order.userId, 'order.closed', order.id); }
        return order;
      });
    },
    recordPendingQuery(orderId, remote) {
      return tx(async q => {
        const order = await get(q, orderId); if (!order) fail('XPAY_ORDER_NOT_FOUND'); await lock(q, order.userId);
        if (remote.order_id !== order.id || remote.env_type !== order.env + 1 || ![0, 1].includes(remote.status)) fail('XPAY_ORDER_MISMATCH');
        if (order.status === 'pending') { order.remoteStatus = remote.status; await save(q, order); }
        return order;
      });
    },
    settle(orderId, remote) {
      return tx(async q => {
        const order = await get(q, orderId); if (!order) fail('XPAY_ORDER_NOT_FOUND'); await lock(q, order.userId);
        validatePaidOrder(remote, order);
        if (order.providerId && order.providerId !== remote.wx_order_id) fail('XPAY_TRADE_CONFLICT');
        if (!['pending', 'paid'].includes(order.status)) fail('XPAY_PAYMENT_TRANSITION');
        await event(q, `paid:${order.appId}:${order.env}:${remote.wx_order_id}`, order.id, { orderId, amountFen: order.amountFen, providerId: remote.wx_order_id });
        if (order.status === 'paid') return order;
        const paidAt = remote.paid_time * 1000;
        if (paidAt > now() + 300000 || paidAt < order.createdAt - 300000) fail('XPAY_PAYMENT_TIME_INVALID');
        let startsAt = paidAt;
        if (order.product.type === 'membership') {
          const previous = (await q("SELECT payload FROM vp_orders WHERE user_id = ? AND status IN ('paid','refund_pending')", [order.userId])).map(read);
          for (const item of previous) if (item.product.type === 'membership') startsAt = Math.max(startsAt, item.expiresAt || 0);
        }
        const expiresAt = startsAt + order.product.days * DAY;
        Object.assign(order, { status: 'paid', providerId: remote.wx_order_id, platform: remote.order_type === 7 ? 'ios' : order.platform, paidAt, startsAt, expiresAt });
        for (const part of order.product.components) await q('INSERT INTO vp_buckets(id,user_id,order_id,kind,starts_at,expires_at,quantity,remaining,value_fen) VALUES (?,?,?,?,?,?,?,?,?)',
          [`${order.id}:${part.kind}`, order.userId, order.id, part.kind, startsAt, expiresAt, part.quantity, part.quantity, part.valueFen]);
        await save(q, order);
        await q('INSERT INTO vp_outbox(id,order_id,kind,status,next_at) VALUES (?,?,?,?,?)', [`deliver:${order.id}`, order.id, 'deliver', 'pending', now()]);
        await audit(q, order.userId, 'payment.granted', order.id, { amountFen: order.amountFen, startsAt, expiresAt }); return order;
      });
    },
    entitlements(userId) {
      return tx(async q => {
        const buckets = await q('SELECT id,order_id,kind,starts_at,expires_at,quantity,remaining,reserved,frozen FROM vp_buckets WHERE user_id = ? ORDER BY expires_at,id', [userId]);
        const available = { photo: 0, video: 0 };
        for (const b of buckets) if (b.starts_at <= now() && b.expires_at > now()) available[b.kind] += b.remaining;
        const orders = (await q("SELECT payload FROM vp_orders WHERE user_id = ? AND status = 'paid'", [userId])).map(read);
        return { available, membership: orders.filter(o => o.product.type === 'membership').map(o => ({ orderId: o.id, startsAt: o.startsAt, expiresAt: o.expiresAt, active: o.startsAt <= now() && o.expiresAt > now() })), buckets };
      });
    },
    reserve(userId, reference, purpose, kind) {
      const input = { userId, reference, purpose, kind }; validateReservationInput(input);
      return tx(q => reservations.reserve(q, input));
    },
    // q must belong to this ledger.database.transaction. Job/asset writes and
    // entitlement changes either commit together or roll back together.
    reserveInTransaction(q, input) { return reservations.reserve(q, input); },
    finish(userId, reference, outcome, review) {
      const input = { userId, reference, outcome, review }; validateReservationFinish(input);
      return tx(q => reservations.finish(q, input));
    },
    finishInTransaction(q, input) { return reservations.finish(q, input); },
    requestRefund(orderId, userId, reason) {
      return tx(async q => {
        await lock(q, userId); const order = await get(q, orderId);
        if (!order || order.userId !== userId) fail('XPAY_ORDER_NOT_FOUND');
        const previous = read((await q('SELECT payload FROM vp_refunds WHERE order_id = ?', [orderId]))[0]); if (previous) return previous;
        if (order.status !== 'paid' || now() - order.paidAt > 365 * DAY) fail('XPAY_REFUND_UNAVAILABLE');
        if (order.platform === 'ios') fail('XPAY_REFUND_VIA_APPLE');
        const buckets = await q('SELECT * FROM vp_buckets WHERE order_id = ?', [orderId]);
        if (buckets.some(b => b.reserved > 0)) fail('XPAY_REFUND_GENERATION_PENDING');
        let amountFen = 0;
        for (const b of buckets) {
          const timeRatio = order.product.type === 'membership' ? Math.max(0, Math.min(1, (order.expiresAt - now()) / (order.expiresAt - order.startsAt))) : 1;
          amountFen += Math.floor(b.value_fen * Math.min(b.remaining / b.quantity, timeRatio));
        }
        if (amountFen < 1 || amountFen > order.amountFen - order.refundedFen) fail('XPAY_REFUND_NO_UNUSED_VALUE');
        const refund = { id: id(), orderId, userId, amountFen, status: 'requested', requestSource: 'user',
          reason: String(reason || '用户申请').slice(0, 200), createdAt: now() };
        await q('INSERT INTO vp_refunds(id,order_id,user_id,status,payload,created_at) VALUES (?,?,?,?,?,?)', [refund.id, orderId, userId, refund.status, JSON.stringify(refund), now()]);
        await q('UPDATE vp_buckets SET frozen = frozen + remaining, remaining = 0 WHERE order_id = ?', [orderId]);
        order.status = 'refund_pending'; await save(q, order); await audit(q, userId, 'refund.requested', refund.id, { amountFen }); return refund;
      });
    },
    reviewRefund(refundId, reviewer, approve) {
      if (!reviewer) fail('XPAY_REVIEW_REQUIRED');
      return tx(async q => {
        const refund = await getRefund(q, refundId); if (!refund) fail('XPAY_REFUND_NOT_FOUND'); await lock(q, refund.userId);
        if (refund.status !== 'requested') fail('XPAY_REFUND_TRANSITION');
        const order = await get(q, refund.orderId);
        if (!order || order.userId !== refund.userId || order.status !== 'refund_pending'
          || refund.amountFen > order.amountFen - order.refundedFen) fail('XPAY_REFUND_TRANSITION');
        refund.status = approve ? 'processing' : 'rejected'; refund.reviewer = reviewer;
        if (approve) await q('INSERT INTO vp_outbox(id,order_id,kind,status,next_at) VALUES (?,?,?,?,?)', [`refund:${refund.id}`, refund.orderId, 'refund', 'pending', now()]);
        else {
          await q('UPDATE vp_buckets SET remaining = remaining + frozen, frozen = 0 WHERE order_id = ?', [refund.orderId]);
          order.status = 'paid'; await save(q, order);
        }
        await saveRefund(q, refund); await audit(q, refund.userId, `refund.${refund.status}`, refund.id, { reviewer }); return refund;
      });
    },
    refunds(userId) { return tx(async q => (await q(`SELECT payload FROM vp_refunds${userId ? ' WHERE user_id = ?' : ''} ORDER BY created_at DESC LIMIT 100`, userId ? [userId] : [])).map(read)); },
    refund(refundId) { return tx(q => getRefund(q, refundId)); },
    applyRefund(message, remotePayment, { requireApproved = false } = {}) {
      return tx(async q => {
        const order = await get(q, message.MchOrderId); if (!order) fail('XPAY_ORDER_NOT_FOUND'); await lock(q, order.userId);
        if (order.status === 'pending' && message.RetCode === 0) {
          if (!remotePayment || remotePayment.order_id !== order.id || remotePayment.env_type !== order.env + 1
            || remotePayment.wx_order_id !== message.WxOrderId || ![5, 8].includes(remotePayment.status)
            || ![0, 7].includes(remotePayment.order_type) || remotePayment.order_fee !== order.amountFen
            || remotePayment.paid_fee !== order.amountFen || remotePayment.left_fee !== 0 || message.RefundFee !== order.amountFen) fail('XPAY_REFUND_MISMATCH');
          order.providerId = remotePayment.wx_order_id; order.status = 'paid';
        }
        if (message.OpenId !== order.openid || message.WxOrderId !== order.providerId || !message.WxRefundId || !message.MchRefundId
          || !Number.isSafeInteger(message.RefundFee) || message.RefundFee <= 0 || !Number.isSafeInteger(message.RetCode)) fail('XPAY_REFUND_MISMATCH');
        const refund = await getRefund(q, message.MchRefundId);
        if (refund && (refund.orderId !== order.id || refund.amountFen !== message.RefundFee)) fail('XPAY_REFUND_MISMATCH');
        // Query-authoritative cloud processing has a narrower contract than
        // trusted provider callbacks. Recheck approval inside the transaction:
        // another callback may have changed the state during the network query.
        if (requireApproved && (!refund || refund.userId !== order.userId
          || !['processing', 'succeeded'].includes(refund.status)
          || typeof refund.reviewer !== 'string' || !refund.reviewer.trim())) fail('XPAY_REFUND_REVIEW_REQUIRED');
        const material = { id: message.WxRefundId, orderId: order.id, amount: message.RefundFee, result: message.RetCode };
        if (!await event(q, `refund:${order.appId}:${message.WxRefundId}:${message.RetCode}`, order.id, material)) return order;
        if (refund?.status === 'succeeded') fail('XPAY_REFUND_TRANSITION');
        if (message.RetCode !== 0) {
          // Keep a hold on ambiguous failures until a reviewed provider resolution; never retry with another ID.
          if (refund) { refund.status = 'abnormal'; await saveRefund(q, refund); }
          await audit(q, order.userId, 'refund.abnormal', order.id); return order;
        }
        if (message.RefundFee > order.amountFen - order.refundedFen || !['paid', 'refund_pending'].includes(order.status)) fail('XPAY_REFUND_MISMATCH');
        // Channel-initiated partial refunds need explicit allocation; fail closed for manual reconciliation.
        if (!refund && message.RefundFee !== order.amountFen - order.refundedFen) fail('XPAY_EXTERNAL_PARTIAL_REFUND_REVIEW');
        await q('UPDATE vp_buckets SET remaining = 0, frozen = 0 WHERE order_id = ?', [order.id]);
        order.refundedFen += message.RefundFee; order.status = 'refunded'; await save(q, order);
        if (refund) { refund.status = 'succeeded'; refund.providerRefundId = message.WxRefundId; await saveRefund(q, refund); }
        else {
          // A channel-initiated refund may race a merchant request with another
          // ID. Keep that request unresolved for review instead of treating it
          // as channel-confirmed or allowing it to submit a second refund.
          const pending = read((await q('SELECT payload FROM vp_refunds WHERE order_id = ?', [order.id]))[0]);
          if (pending && ['requested', 'processing'].includes(pending.status)) {
            pending.status = 'abnormal'; pending.resolutionReason = 'channel_refund_reconciliation_required';
            await saveRefund(q, pending);
            await audit(q, order.userId, 'refund.superseded_by_channel', pending.id);
          }
        }
        await audit(q, order.userId, 'refund.succeeded', order.id, { amountFen: message.RefundFee, external: !refund }); return order;
      });
    },
    outbox() { return tx(q => q("SELECT * FROM vp_outbox WHERE status = 'pending' AND next_at <= ? ORDER BY next_at LIMIT 50", [now()])); },
    claimOutbox(outboxId) {
      return tx(async q => {
        const job = (await q(`SELECT * FROM vp_outbox WHERE id = ?${database.backend === 'mysql' ? ' FOR UPDATE' : ''}`, [outboxId]))[0];
        if (!job || job.status !== 'pending' || job.next_at > now()) return null;
        await q('UPDATE vp_outbox SET attempts = attempts + 1, next_at = ? WHERE id = ?', [now() + 60000, outboxId]);
        return job;
      });
    },
    completeOutbox(outboxId) { return tx(q => q("UPDATE vp_outbox SET status = 'done' WHERE id = ?", [outboxId])); },
    deferOutbox(outboxId) { return tx(q => q('UPDATE vp_outbox SET next_at = ? WHERE id = ?', [now() + 60000, outboxId])); },
    countReservations(since, userId) { return tx(async q => Number((await q(`SELECT COUNT(*) AS n FROM vp_reservations WHERE created_at >= ?${userId ? ' AND user_id = ?' : ''}`, userId ? [since, userId] : [since]))[0].n)); },
    unresolvedGenerations() { return tx(q => q("SELECT * FROM vp_reservations WHERE status IN ('unknown','reserved') ORDER BY created_at ASC LIMIT 100")); },
    reconciliationPage(afterId = '') {
      return tx(async q => (await q("SELECT payload FROM vp_orders WHERE status IN ('paid','refund_pending','refunded') AND id > ? ORDER BY id ASC LIMIT 5", [afterId])).map(read));
    },
    saveReconciliation(report) {
      return tx(async q => {
        const record = { ...report, id: id(), createdAt: now() };
        await q('INSERT INTO vp_reconciliation(id,payload,created_at) VALUES (?,?,?)', [record.id, JSON.stringify(record), record.createdAt]);
        return record;
      });
    },
    reconciliationReports() { return tx(async q => (await q('SELECT payload FROM vp_reconciliation ORDER BY created_at DESC LIMIT 20')).map(read)); },
    auditLog() { return tx(q => q('SELECT * FROM vp_audit ORDER BY created_at DESC LIMIT 100')); },
  };
}
