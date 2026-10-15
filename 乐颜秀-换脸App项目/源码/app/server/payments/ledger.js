import crypto from 'node:crypto';
import { validateProducts } from './catalog.js';

const uuid = () => crypto.randomUUID();
const json = value => JSON.stringify(value);
const error = code => ({ error: code });
const DAY = 86400000;

export function createBillingLedger(db, { now = Date.now } = {}) {
  const iso = () => new Date(now()).toISOString();
  async function readOrder(q, id, userId) {
    const result = await q.query('SELECT payload FROM billing_orders WHERE id=$1', [id]);
    const order = result.rows[0]?.payload;
    return order && (!userId || order.userId === userId) ? order : null;
  }
  const saveOrder = (q, order) => q.query('UPDATE billing_orders SET payload=$2,trade_id=$3 WHERE id=$1', [order.id, json(order), order.providerTradeId || null]);
  const saveRefund = (q, refund) => q.query('UPDATE billing_refunds SET payload=$2,provider_id=$3 WHERE id=$1', [refund.id, json(refund), refund.providerRefundId || null]);
  const log = (q, userId, referenceId, kind, amount) => q.query('INSERT INTO billing_ledger VALUES($1,$2,$3,$4,$5,$6)', [uuid(), userId, referenceId, kind, amount, now()]);
  const audit = (q, actor, action, payload) => q.query('INSERT INTO billing_audit VALUES($1,$2,$3,$4,$5)', [uuid(), actor, action, json(payload), now()]);
  const list = async (table, userId) => (await db.query(`SELECT payload FROM ${table}${userId ? ' WHERE user_id=$1' : ''}`, userId ? [userId] : [])).rows.map(row => row.payload);
  async function findRefund(id, userId) {
    const row = (await db.query('SELECT payload FROM billing_refunds WHERE id=$1', [id])).rows[0]?.payload;
    return row && (!userId || row.userId === userId) ? row : null;
  }
  function refundQuote(order, grant) {
    if (order.status !== 'paid') return error('REFUND_ORDER_NOT_PAID');
    if (!grant || grant.held) return error('REFUND_TASK_IN_PROGRESS');
    if (!grant.available) return error('REFUND_CREDITS_IN_USE');
    // Multiply integer units before division: 0.29 * 100 can round down to 28 cents.
    let refundableFen = Math.floor(order.amountFen * grant.available / grant.initial);
    if (grant.kind === 'monthly') {
      const duration = Number(grant.ends_at)-Number(grant.starts_at);
      const remaining = Math.max(0,Math.min(duration,Number(grant.ends_at)-now()));
      const unusedWindow = now()-Date.parse(order.fulfilledAt)<=7*DAY && grant.used===0;
      if (!unusedWindow) refundableFen = Math.min(refundableFen,Math.floor(order.amountFen * remaining / duration));
    }
    const amountFen = Math.min(order.amountFen-order.refundedFen,refundableFen);
    return amountFen>0 ? {amountFen,credits:grant.available,policyVersion:'remaining-units-and-time-v1'} : error('REFUND_NOT_AVAILABLE');
  }

  return {
    backend: 'postgres',
    async paymentProducts() { return (await db.query('SELECT products FROM billing_catalog WHERE id=1')).rows[0]?.products ?? null; },
    async savePaymentProducts(items, actor) {
      if (!actor) throw new Error('ADMIN_REQUIRED');
      const products = validateProducts(items);
      await db.transaction('system:catalog', async q => {
        await q.query('INSERT INTO billing_catalog VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET version=$1,products=$2', [uuid(), json(products)]);
        await audit(q, actor, 'catalog.published', { products });
      });
      return products;
    },
    async createOrder({ userId, productId, amountFen, credits, channel, idempotencyKey, productSnapshot, termsVersion }) {
      if (!userId || channel !== 'android' || !/^[A-Za-z0-9:_-]{8,128}$/.test(idempotencyKey || '')) return error('INVALID_ORDER');
      const [product] = validateProducts([productSnapshot || { id: productId, name: productId, amountFen, credits }]);
      return db.transaction(userId, async q => {
        const existing = (await q.query('SELECT payload FROM billing_orders WHERE user_id=$1 AND idem=$2', [userId, idempotencyKey])).rows[0]?.payload;
        if (existing) return existing.productId === product.id ? { order: existing, duplicate: true } : error('IDEMPOTENCY_CONFLICT');
        const order = { id: `ord_${uuid()}`, userId, productId: product.id, amountFen: product.amountFen,
          credits: product.credits, productSnapshot: product, channel, status: 'pending', currency: 'CNY',
          createdAt: iso(), updatedAt: iso(), refundedFen: 0, termsVersion:termsVersion || null };
        await q.query('INSERT INTO billing_orders(id,user_id,idem,amount,payload) VALUES($1,$2,$3,$4,$5)', [order.id, userId, idempotencyKey, order.amountFen, json(order)]);
        return { order, duplicate: false };
      });
    },
    getOrder: (id, userId) => readOrder(db, id, userId),
    listOrders: userId => list('billing_orders', userId),
    async closePaymentOrder(id, userId) {
      return db.transaction(userId, async q => {
        const order = await readOrder(q, id, userId);
        if (!order) return error('ORDER_NOT_FOUND');
        if (order.status === 'closed') return { order, duplicate: true };
        if (order.status !== 'pending') return error('PAYMENT_TRANSITION_INVALID');
        order.status = 'closed'; order.updatedAt = iso(); await saveOrder(q, order); return { order };
      });
    },
    async applyPaymentEvent({ eventId, orderId, status, providerTradeId, rawDigest, providerPaidAt }) {
      const found = await readOrder(db, orderId);
      if (!found) return error('ORDER_NOT_FOUND');
      if (status !== 'paid' || !eventId || !providerTradeId) return error('PAYMENT_STATUS_INVALID');
      return db.transaction(found.userId, async q => {
        const order = await readOrder(q, orderId);
        const event = (await q.query('SELECT order_id FROM billing_events WHERE id=$1', [eventId])).rows[0];
        if (event && event.order_id !== orderId) return error('PAYMENT_EVENT_CONFLICT');
        if (order.providerTradeId && order.providerTradeId !== providerTradeId) return error('PAYMENT_TRADE_ID_CONFLICT');
        if (order.fulfilledAt) return { order, duplicate: true };
        if (!['pending', 'closed'].includes(order.status)) return error('PAYMENT_TRANSITION_INVALID');
        await q.query('INSERT INTO billing_events VALUES($1,$2,$3)', [eventId, orderId, json({ status, providerTradeId, rawDigest })]);
        let start = now(); let end = null;
        const product = order.productSnapshot;
        if (product.type === 'monthly') {
          // A successful partial refund terminates all remaining rights in that
          // order, even when consumed units make revoked < initial. Keep any
          // separately purchased future periods at their promised dates.
          const periods = await q.query(`SELECT MAX(g.ends_at) AS end FROM billing_grants g
            JOIN billing_orders o ON o.id=g.order_id WHERE g.user_id=$1 AND g.kind='monthly'
            AND g.revoked<g.initial AND o.payload->>'status'='paid'`, [order.userId]);
          start = Math.max(start, Number(periods.rows[0]?.end || 0)); end = start + product.durationDays * DAY;
        }
        await q.query('INSERT INTO billing_grants(id,user_id,order_id,initial,available,starts_at,ends_at,kind) VALUES($1,$2,$3,$4,$4,$5,$6,$7)', [uuid(), order.userId, order.id, order.credits, start, end, product.type]);
        Object.assign(order, { status: 'paid', providerTradeId, fulfilledAt: iso(), updatedAt: iso(), startsAt: new Date(start).toISOString(), expiresAt: end ? new Date(end).toISOString() : null });
        if (Number.isFinite(Date.parse(providerPaidAt))) order.providerPaidAt=providerPaidAt;
        await saveOrder(q, order); await log(q, order.userId, order.id, 'grant', order.credits);
        return { order, duplicate: false };
      });
    },
    async entitlements(userId) {
      const rows = (await db.query(`SELECT g.*,o.payload->>'status' AS order_status FROM billing_grants g
        LEFT JOIN billing_orders o ON o.id=g.order_id WHERE g.user_id=$1 ORDER BY g.starts_at`, [userId])).rows;
      const isActive = row => !['refunded', 'partially_refunded'].includes(row.order_status)
        && Number(row.starts_at) <= now() && (!row.ends_at || Number(row.ends_at) > now());
      const active = rows.filter(isActive);
      const total = active.reduce((sum, row) => sum + row.available, 0);
      return { trialRemaining: 0, purchasedRemaining: total, totalRemaining: total,
        grants: rows.map(row => ({ id: row.id, orderId: row.order_id, type: row.kind, available: row.available, held: row.held,
          used: row.used, startsAt: new Date(Number(row.starts_at)).toISOString(), expiresAt: row.ends_at ? new Date(Number(row.ends_at)).toISOString() : null,
          active: isActive(row) })), updatedAt: iso() };
    },
    async reserveCreation(userId, referenceId, purpose = 'unknown') {
      return db.transaction(userId, async q => {
        const existing = (await q.query('SELECT * FROM billing_reservations WHERE id=$1', [referenceId])).rows[0];
        if (existing) return existing.user_id !== userId || existing.purpose !== purpose ? error('GENERATION_REFERENCE_CONFLICT')
          : { ok: existing.status !== 'refunded', duplicate: true, ...(existing.status === 'refunded' ? error('GENERATION_REFERENCE_REFUNDED') : {}), ledgerId: referenceId };
        const grant = (await q.query('SELECT * FROM billing_grants WHERE user_id=$1 AND available>0 AND starts_at<=$2 AND (ends_at IS NULL OR ends_at>$2) ORDER BY ends_at ASC NULLS LAST, starts_at,id LIMIT 1 FOR UPDATE', [userId, now()])).rows[0];
        if (!grant) return { ok: false, duplicate: false };
        await q.query('UPDATE billing_grants SET available=available-1,held=held+1 WHERE id=$1', [grant.id]);
        await q.query("INSERT INTO billing_reservations VALUES($1,$2,$3,$4,'pending',$5)", [referenceId, userId, grant.id, purpose, now()]);
        await log(q, userId, referenceId, 'reserve', -1); return { ok: true, duplicate: false, ledgerId: referenceId };
      });
    },
    async confirmCreation(userId, referenceId) {
      return db.transaction(userId, async q => {
        const task = (await q.query('SELECT * FROM billing_reservations WHERE id=$1 AND user_id=$2', [referenceId, userId])).rows[0];
        if (!task || task.status === 'refunded') return false;
        if (task.status === 'success') return true;
        await q.query('UPDATE billing_grants SET held=held-1,used=used+1 WHERE id=$1', [task.grant_id]);
        await q.query("UPDATE billing_reservations SET status='success' WHERE id=$1", [referenceId]);
        await log(q, userId, referenceId, 'consume', -1); return true;
      });
    },
    async refundCreation(userId, referenceId) {
      return db.transaction(userId, async q => {
        const task = (await q.query('SELECT * FROM billing_reservations WHERE id=$1 AND user_id=$2', [referenceId, userId])).rows[0];
        if (!task || task.status !== 'pending') return false;
        const grant = (await q.query('SELECT * FROM billing_grants WHERE id=$1', [task.grant_id])).rows[0];
        if (grant.ends_at && Number(grant.ends_at) <= now()) {
          await q.query('UPDATE billing_grants SET held=held-1,revoked=revoked+1 WHERE id=$1', [grant.id]);
          await q.query("INSERT INTO billing_grants(id,user_id,initial,available,starts_at,ends_at,kind) VALUES($1,$2,1,1,$3,$4,'compensation')", [uuid(), userId, now(), now() + 7 * DAY]);
        } else await q.query('UPDATE billing_grants SET held=held-1,available=available+1 WHERE id=$1', [grant.id]);
        await q.query("UPDATE billing_reservations SET status='refunded' WHERE id=$1", [referenceId]);
        await log(q, userId, referenceId, 'release', 1); return true;
      });
    },
    async countGenerationReservationsSince(since, userId) {
      const time = Date.parse(since); if (!Number.isFinite(time)) throw new Error('INVALID_TIME');
      return Number((await db.query(`SELECT COUNT(*) AS n FROM billing_reservations WHERE created_at>=$1${userId ? ' AND user_id=$2' : ''}`, userId ? [time, userId] : [time])).rows[0].n);
    },
    async quoteRefund(orderId, userId) {
      return db.transaction(userId, async q => {
        const order=await readOrder(q,orderId,userId);
        if (!order) return error('ORDER_NOT_FOUND');
        return refundQuote(order,(await q.query('SELECT * FROM billing_grants WHERE order_id=$1',[orderId])).rows[0]);
      });
    },
    async requestRefund(orderId, userId, reason, expectedAmountFen) {
      return db.transaction(userId, async q => {
        const order = await readOrder(q, orderId, userId);
        if (!order) return error('ORDER_NOT_FOUND');
        const previous = (await q.query('SELECT payload FROM billing_refunds WHERE order_id=$1', [orderId])).rows.map(r => r.payload);
        const active = previous.find(r => ['requested','processing','abnormal'].includes(r.status));
        if (active) return { refund: active, order, duplicate: true };
        const grant = (await q.query('SELECT * FROM billing_grants WHERE order_id=$1 FOR UPDATE', [orderId])).rows[0];
        const quote = refundQuote(order,grant);
        if (quote.error) return quote;
        // Reject changed quotes rather than silently refund a different amount.
        const amountFen = quote.amountFen;
        if (expectedAmountFen !== undefined && expectedAmountFen !== amountFen) return error('REFUND_QUOTE_CHANGED');
        const refund = { id: uuid().replaceAll('-', ''), orderId, userId, amountFen, credits: grant.available, grantId: grant.id,
          policyVersion:quote.policyVersion, reason: String(reason || '用户申请退款').slice(0,200), status: 'requested', holdActive: true, createdAt: iso(), updatedAt: iso() };
        await q.query('UPDATE billing_grants SET held=held+available,available=0 WHERE id=$1', [grant.id]);
        await q.query('INSERT INTO billing_refunds(id,order_id,user_id,payload) VALUES($1,$2,$3,$4)', [refund.id, orderId, userId, json(refund)]);
        await log(q,userId,refund.id,'refund_hold',-refund.credits); return { refund, order, duplicate: false };
      });
    },
    getRefund: findRefund,
    listRefunds: userId => list('billing_refunds', userId),
    async approveRefund(id, actor) {
      const found = await findRefund(id); if (!found || !actor) return error('REFUND_NOT_FOUND');
      return db.transaction(found.userId, async q => {
        const refund = (await q.query('SELECT payload FROM billing_refunds WHERE id=$1', [id])).rows[0].payload;
        if (refund.status === 'processing') return { refund, duplicate: true };
        if (refund.status !== 'requested') return error('REFUND_TRANSITION_INVALID');
        Object.assign(refund, { status: 'processing', reviewerId: actor, updatedAt: iso() });
        await saveRefund(q,refund); await audit(q,actor,'refund.approved',{ refundId:id,amountFen:refund.amountFen }); return { refund };
      });
    },
    async rejectRefund(id, actor, reason) {
      const found = await findRefund(id); if (!found || !actor || !reason) return error('REFUND_REVIEW_REQUIRED');
      return db.transaction(found.userId, async q => {
        const refund = (await q.query('SELECT payload FROM billing_refunds WHERE id=$1', [id])).rows[0].payload;
        if (refund.status === 'rejected') return { refund, duplicate:true };
        if (refund.status !== 'requested') return error('REFUND_AUTHORITATIVE_STATUS_REQUIRED');
        await q.query('UPDATE billing_grants SET held=held-$2,available=available+$2 WHERE id=$1',[refund.grantId,refund.credits]);
        Object.assign(refund,{status:'rejected',holdActive:false,reviewReason:String(reason).slice(0,200),updatedAt:iso()});
        await saveRefund(q,refund); await log(q,refund.userId,id,'refund_release',refund.credits);
        await audit(q,actor,'refund.rejected',{refundId:id}); return { refund };
      });
    },
    async applyRefundResult({ refundId, status, providerRefundId, providerTradeId, providerRefundedAt }) {
      const found = await findRefund(refundId); if (!found) return error('REFUND_NOT_FOUND');
      return db.transaction(found.userId, async q => {
        const refund = (await q.query('SELECT payload FROM billing_refunds WHERE id=$1', [refundId])).rows[0].payload;
        const order = await readOrder(q,refund.orderId);
        if (!providerTradeId || providerTradeId !== order.providerTradeId || !providerRefundId || (refund.providerRefundId && refund.providerRefundId !== providerRefundId)) return error('REFUND_PROVIDER_ID_CONFLICT');
        if (!['SUCCESS','PROCESSING','ABNORMAL','CLOSED'].includes(status)) return error('REFUND_STATUS_INVALID');
        if (refund.status === 'succeeded') return status === 'SUCCESS' ? { refund,duplicate:true } : error('REFUND_TRANSITION_INVALID');
        if (refund.status === 'closed') return status === 'CLOSED' ? { refund,duplicate:true } : error('REFUND_TRANSITION_INVALID');
        if (!['processing','abnormal'].includes(refund.status)) return error('REFUND_TRANSITION_INVALID');
        refund.providerRefundId = providerRefundId;
        if (status === 'SUCCESS') {
          if (Number.isFinite(Date.parse(providerRefundedAt))) refund.providerRefundedAt=providerRefundedAt;
          await q.query('UPDATE billing_grants SET held=held-$2,revoked=revoked+$2 WHERE id=$1',[refund.grantId,refund.credits]);
          refund.status = 'succeeded'; refund.holdActive=false;
          order.refundedFen += refund.amountFen; order.refundedAt=iso(); order.status=order.refundedFen === order.amountFen ? 'refunded' : 'partially_refunded';
          await saveOrder(q,order); await log(q,refund.userId,refundId,'refund_confirmed',-refund.credits);
        } else if (status === 'CLOSED') {
          await q.query('UPDATE billing_grants SET held=held-$2,available=available+$2 WHERE id=$1',[refund.grantId,refund.credits]);
          refund.status='closed'; refund.holdActive=false; await log(q,refund.userId,refundId,'refund_release',refund.credits);
        } else refund.status=status === 'ABNORMAL' ? 'abnormal' : 'processing';
        refund.updatedAt=iso(); await saveRefund(q,refund); return {refund,duplicate:false};
      });
    },
    async saveReconciliation(report, actor) {
      const id=uuid();
      await db.transaction('system:reconciliation',async q=>{
        await q.query('INSERT INTO billing_reconciliation VALUES($1,$2,$3)',[id,json(report),now()]);
        await audit(q,actor,'bill.reconciled',{id,date:report.date,ok:report.ok});
      });
      return {id,...report};
    },
    async listReconciliations() {return (await db.query('SELECT id,payload FROM billing_reconciliation ORDER BY created_at DESC LIMIT 30')).rows.map(row=>({id:row.id,...row.payload}));},
    async reconcileEntitlements() {
      const bad = await db.query(`SELECT g.user_id,g.id AS grant_id FROM billing_grants g WHERE
        initial<>available+held+used+revoked OR held <>
        (SELECT COUNT(*) FROM billing_reservations r WHERE r.grant_id=g.id AND r.status='pending') +
        (SELECT COALESCE(SUM((f.payload->>'credits')::integer),0) FROM billing_refunds f WHERE f.payload->>'grantId'=g.id AND (f.payload->>'holdActive')::boolean)
        OR used <> (SELECT COUNT(*) FROM billing_reservations r WHERE r.grant_id=g.id AND r.status='success')
        UNION SELECT o.user_id,o.id FROM billing_orders o WHERE o.payload->>'fulfilledAt' IS NOT NULL AND
        NOT EXISTS(SELECT 1 FROM billing_grants g WHERE g.order_id=o.id AND g.initial=(o.payload->>'credits')::integer)
        UNION SELECT o.user_id,o.id FROM billing_orders o WHERE COALESCE((o.payload->>'refundedFen')::integer,0) <>
        (SELECT COALESCE(SUM((f.payload->>'amountFen')::integer),0) FROM billing_refunds f WHERE f.order_id=o.id AND f.payload->>'status'='succeeded')`);
      return { ok:bad.rows.length===0, mismatches:bad.rows.map(r=>({userId:r.user_id,referenceId:r.grant_id})), users:Number((await db.query("SELECT COUNT(*) AS n FROM billing_accounts WHERE id NOT LIKE 'system:%'")).rows[0].n) };
    },
  };
}
