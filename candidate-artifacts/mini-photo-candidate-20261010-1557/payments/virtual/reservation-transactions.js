const DAY = 86400000;
const fail = code => { throw new Error(code); };

export function validateReservationInput({ reference, kind }) {
  if (!/^[a-f0-9]{64}$/.test(reference) || !['photo', 'video'].includes(kind)) fail('XPAY_RESERVATION_INVALID');
}

export function validateReservationFinish({ outcome, review }) {
  if (!['success', 'failed', 'unknown'].includes(outcome)) fail('XPAY_OUTCOME_INVALID');
  if (review && (!review.reviewer || typeof review.evidence !== 'string' || review.evidence.trim().length < 8
    || review.evidence.length > 500 || outcome === 'unknown')) fail('XPAY_REVIEW_EVIDENCE_REQUIRED');
}

// One implementation for the public ledger and durable photo jobs. The caller
// supplies q from this ledger's database.transaction; these methods never open
// a nested transaction, perform provider I/O, or retry a partial unit of work.
export function createReservationTransactions({ lock, audit, getOrder, now }) {
  return {
    async reserve(q, input) {
      validateReservationInput(input);
      const { userId, reference, purpose, kind } = input;
      await lock(q, userId);
      const prior = (await q('SELECT * FROM vp_reservations WHERE id = ?', [reference]))[0];
      if (prior) { if (prior.user_id !== userId || prior.purpose !== purpose) fail('XPAY_RESERVATION_CONFLICT'); return { ok: prior.status !== 'returned', duplicate: true }; }
      const boundedLimit = (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
      const all = Number((await q('SELECT COUNT(*) AS n FROM vp_reservations WHERE created_at >= ?', [now() - DAY]))[0].n);
      const own = Number((await q('SELECT COUNT(*) AS n FROM vp_reservations WHERE created_at >= ? AND user_id = ?', [now() - DAY, userId]))[0].n);
      if (all >= boundedLimit(process.env.PROVIDER_DAILY_CALL_LIMIT, 500) || own >= boundedLimit(process.env.USER_DAILY_GENERATION_LIMIT, 30)) fail('XPAY_PROVIDER_BUDGET_LIMIT');
      const bucket = (await q('SELECT * FROM vp_buckets WHERE user_id = ? AND kind = ? AND starts_at <= ? AND expires_at > ? AND remaining > 0 ORDER BY expires_at,id LIMIT 1', [userId, kind, now(), now()]))[0];
      if (!bucket) return { ok: false, duplicate: false };
      await q('UPDATE vp_buckets SET remaining = remaining - 1, reserved = reserved + 1 WHERE id = ?', [bucket.id]);
      await q('INSERT INTO vp_reservations(id,user_id,bucket_id,purpose,status,created_at) VALUES (?,?,?,?,?,?)', [reference, userId, bucket.id, purpose, 'reserved', now()]);
      await audit(q, userId, 'creation.reserved', reference, { bucketId: bucket.id, purpose }); return { ok: true, duplicate: false };
    },
    async finish(q, input) {
      validateReservationFinish(input);
      const { userId, reference, outcome, review } = input;
      await lock(q, userId);
      const reservation = (await q('SELECT * FROM vp_reservations WHERE id = ? AND user_id = ?', [reference, userId]))[0];
      if (!reservation || ['consumed', 'returned'].includes(reservation.status)) return false;
      if (outcome === 'unknown') { await q("UPDATE vp_reservations SET status = 'unknown' WHERE id = ?", [reference]); await audit(q, userId, 'creation.unconfirmed', reference); return true; }
      const bucket = (await q('SELECT * FROM vp_buckets WHERE id = ?', [reservation.bucket_id]))[0];
      await q('UPDATE vp_buckets SET reserved = reserved - 1 WHERE id = ?', [bucket.id]);
      if (outcome === 'failed') {
        const order = await getOrder(q, bucket.order_id);
        // A forced channel refund never recreates paid rights through a later failed job.
        if (order.status === 'paid') {
          if (bucket.expires_at > now()) await q('UPDATE vp_buckets SET remaining = remaining + 1 WHERE id = ?', [bucket.id]);
          else await q('INSERT INTO vp_buckets(id,user_id,order_id,kind,starts_at,expires_at,quantity,remaining,value_fen) VALUES (?,?,?,?,?,?,?,?,?)',
            [`comp:${reference}`, userId, bucket.order_id, bucket.kind, now(), now() + 7 * DAY, 1, 1, 0]);
        }
      }
      await q('UPDATE vp_reservations SET status = ? WHERE id = ?', [outcome === 'success' ? 'consumed' : 'returned', reference]);
      await audit(q, userId, `creation.${outcome}`, reference, review || {}); return true;
    },
  };
}
