import { randomBytes } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const id = value => typeof value === 'string' && /^[A-Za-z0-9:_-]{1,80}$/.test(value);
const exactKey = (kind, key) => kind === 'output' ? /^private\/photo-outputs\/[a-f0-9]{32}\.png$/.test(key)
  : kind === 'moderation' && /^private\/photo-moderation\/[a-f0-9]{32}\.png$/.test(key);
function timing(value) {
  const settings = { inFlightGraceMs: value?.inFlightGraceMs, retryAfterMs: value?.retryAfterMs,
    recheckAfterMs: value?.recheckAfterMs, claimHoldMs: value?.claimHoldMs };
  if (!Number.isSafeInteger(settings.inFlightGraceMs) || settings.inFlightGraceMs < 300000 || settings.inFlightGraceMs > 86400000
    || !Number.isSafeInteger(settings.retryAfterMs) || settings.retryAfterMs < 1000 || settings.retryAfterMs > 86400000
    || !Number.isSafeInteger(settings.recheckAfterMs) || settings.recheckAfterMs < settings.retryAfterMs || settings.recheckAfterMs > 7 * 86400000
    || !Number.isSafeInteger(settings.claimHoldMs) || settings.claimHoldMs < 1000 || settings.claimHoldMs > 86400000) throw fail('PHOTO_GENERATION_CLEANUP_POLICY_REQUIRED');
  return settings;
}
const outputCondition = `(g.expires_at <= ? OR a.user_id IS NULL OR a.enabled <> 1 OR a.basic_version IS NULL
  OR a.face_version IS NULL OR a.subject_authorization IS NULL OR a.subject_authorization NOT IN ('self','authorized')
  OR i.id IS NULL OR a.consent_epoch <> i.consent_epoch OR i.state IN ('deleted','revoked')
  OR s.state IN ('deleted','revoked') OR o.status = 'refunded')`;
const scratchCondition = `(g.moderation_reference IS NOT NULL AND (g.review_receipt IS NOT NULL OR m.started_at <= ?))`;
function from(database) {
  const input = database.backend === 'mysql' ? "JSON_UNQUOTE(JSON_EXTRACT(j.spec,'$.inputAssetId'))" : "json_extract(j.spec,'$.inputAssetId')";
  return `FROM mini_photo_generation g JOIN mini_photo_jobs j ON j.id = g.job_id
    LEFT JOIN mini_photo_accounts a ON a.user_id = g.user_id LEFT JOIN mini_photo_assets i ON i.id = ${input}
    LEFT JOIN mini_photo_assets s ON s.id = g.asset_id
    LEFT JOIN vp_reservations r ON r.id = j.billing_ref LEFT JOIN vp_buckets b ON b.id = r.bucket_id
    LEFT JOIN vp_orders o ON o.id = b.order_id
    LEFT JOIN mini_photo_generation_operations m ON m.job_id = g.job_id AND m.step = 'moderate'`;
}
const fields = `g.*,a.enabled,a.consent_epoch AS current_epoch,a.basic_version,a.face_version,a.subject_authorization,
  i.id AS input_id,i.consent_epoch AS original_epoch,i.state AS input_state,s.state AS asset_state,
  o.status AS order_status,m.started_at AS moderation_started_at`;
function disposable(row, stamp, settings) {
  const output = row.expires_at <= stamp || row.enabled !== 1 || !row.basic_version || !row.face_version
    || !['self', 'authorized'].includes(row.subject_authorization) || !row.input_id
    || row.current_epoch !== row.original_epoch || ['deleted', 'revoked'].includes(row.input_state)
    || ['deleted', 'revoked'].includes(row.asset_state) || row.order_status === 'refunded';
  const scratch = row.moderation_reference && (row.review_receipt
    || (Number.isSafeInteger(row.moderation_started_at) && row.moderation_started_at <= stamp - settings.inFlightGraceMs));
  return [
    ...(output ? [{ kind: 'output', storageKey: row.output_key }] : []),
    ...(scratch ? [{ kind: 'moderation', storageKey: `private/photo-moderation/${row.moderation_reference}.${row.moderation_extension}` }] : []),
  ];
}

/** Internal-only bounded listing. Keys must never be returned in public APIs. */
export async function listPhotoGenerationCleanup({ database, now = Date.now, inFlightGraceMs, afterJobId = '' }) {
  if (!database?.transaction || typeof afterJobId !== 'string' || (afterJobId && !id(afterJobId))) throw fail('PHOTO_GENERATION_CLEANUP_POLICY_REQUIRED');
  const settings = timing({ inFlightGraceMs, retryAfterMs: 1000, recheckAfterMs: 1000, claimHoldMs: 1000 });
  const stamp = now(); if (!Number.isSafeInteger(stamp) || stamp < 0) throw fail('PHOTO_GENERATION_TIME_INVALID');
  const rows = await database.transaction(q => q(`SELECT ${fields} ${from(database)} WHERE g.job_id > ?
    AND (${outputCondition} OR ${scratchCondition}) ORDER BY g.job_id LIMIT 100`, [afterJobId, stamp, stamp - settings.inFlightGraceMs]));
  return { items: rows.flatMap(row => disposable(row, stamp, settings).map(scope => ({ jobId: row.job_id, ...scope, deletionPending: true }))),
    nextCursor: rows.length === 100 ? rows.at(-1).job_id : null };
}

/** Same canonical ledger database. This journal authorizes repeated exact-key
 * deletion only; it never changes generation claims, provider calls or rights.
 */
export function createPhotoGenerationCleanupRepository({ context, now = Date.now }) {
  const database = context?.database; if (!database?.transaction || !context?.ports?.authorize) throw fail('PHOTO_GENERATION_CONTEXT_REQUIRED');
  const tx = callback => database.transaction(callback);
  const time = () => { const stamp = now(); if (!Number.isSafeInteger(stamp) || stamp < 0) throw fail('PHOTO_GENERATION_TIME_INVALID'); return stamp; };
  async function fresh(q, jobId, userId) {
    await q(`SELECT user_id FROM vp_accounts WHERE user_id = ?${database.backend === 'mysql' ? ' FOR UPDATE' : ''}`, [userId]);
    return (await q(`SELECT ${fields} ${from(database)} WHERE g.job_id = ? AND g.user_id = ?`, [jobId, userId]))[0];
  }
  const cleanup = async (q, jobId, kind) => (await q('SELECT * FROM mini_photo_generation_cleanup WHERE job_id = ? AND kind = ?', [jobId, kind]))[0];
  return {
    database,
    async prepareCleanup(input) {
      const settings = timing(input);
      // The discovery transaction finishes before any account lock. Existing
      // journals are excluded and scheduled by next_at, so late rows progress.
      const candidates = await tx(q => q(`SELECT g.job_id,g.user_id ${from(database)} WHERE
        (${outputCondition} AND NOT EXISTS (SELECT 1 FROM mini_photo_generation_cleanup c WHERE c.job_id = g.job_id AND c.kind = 'output'))
        OR (${scratchCondition} AND NOT EXISTS (SELECT 1 FROM mini_photo_generation_cleanup c WHERE c.job_id = g.job_id AND c.kind = 'moderation'))
        ORDER BY g.created_at,g.job_id LIMIT 100`, [time(), time() - settings.inFlightGraceMs]));
      let inserted = 0;
      for (const candidate of candidates) inserted += await tx(async q => {
        const row = await fresh(q, candidate.job_id, candidate.user_id); if (!row) return 0;
        let count = 0;
        for (const scope of disposable(row, time(), settings)) {
          if (!exactKey(scope.kind, scope.storageKey)) throw fail('PHOTO_GENERATION_CLEANUP_KEY_INVALID');
          const previous = await cleanup(q, row.job_id, scope.kind);
          if (previous && previous.storage_key !== scope.storageKey) throw fail('PHOTO_GENERATION_CLEANUP_KEY_CONFLICT');
          if (!previous) { await q(`INSERT INTO mini_photo_generation_cleanup(job_id,kind,storage_key,next_at,created_at,updated_at)
            VALUES (?,?,?,?,?,?)`, [row.job_id, scope.kind, scope.storageKey, time(), time(), time()]); count++; }
          await q(`UPDATE mini_photo_generation SET ${scope.kind === 'output' ? 'output' : 'moderation'}_cleanup_pending = 1 WHERE job_id = ?`, [row.job_id]);
        }
        return count;
      });
      return inserted;
    },
    async claimCleanup(input) {
      const settings = timing(input);
      return tx(async q => {
        const candidate = (await q(`SELECT c.job_id,c.kind,g.user_id FROM mini_photo_generation_cleanup c
          JOIN mini_photo_generation g ON g.job_id = c.job_id WHERE c.next_at <= ? ORDER BY c.next_at,c.job_id,c.kind LIMIT 1`, [time()]))[0];
        if (!candidate) return null;
        const row = await fresh(q, candidate.job_id, candidate.user_id); const previous = await cleanup(q, candidate.job_id, candidate.kind);
        if (!row || !previous || previous.next_at > time()) return null;
        const scope = disposable(row, time(), settings).find(item => item.kind === candidate.kind);
        if (!scope) { await q('UPDATE mini_photo_generation_cleanup SET next_at = ?,updated_at = ? WHERE job_id = ? AND kind = ?',
          [time() + settings.retryAfterMs, time(), row.job_id, candidate.kind]); return null; }
        if (scope.storageKey !== previous.storage_key || !exactKey(scope.kind, scope.storageKey)) throw fail('PHOTO_GENERATION_CLEANUP_KEY_INVALID');
        const token = randomBytes(16).toString('hex');
        await q(`UPDATE mini_photo_generation_cleanup SET state = 'observing',attempts = attempts + 1,operation_token = ?,
          delete_status = 'unknown',observation = 'not_checked',next_at = ?,updated_at = ? WHERE job_id = ? AND kind = ?`,
        [token, time() + settings.claimHoldMs, time(), row.job_id, scope.kind]);
        return { jobId: row.job_id, userId: row.user_id, kind: scope.kind, storageKey: scope.storageKey, operationToken: token };
      });
    },
    async recordCleanupObservation(claim, evidence, input) {
      const settings = timing(input); const frozen = { jobId: claim?.jobId, userId: claim?.userId, kind: claim?.kind,
        operationToken: claim?.operationToken, acknowledged: evidence?.acknowledged === true, observation: evidence?.observation };
      if (!id(frozen.jobId) || !id(frozen.userId) || !['output', 'moderation'].includes(frozen.kind)
        || !/^[a-f0-9]{32}$/.test(frozen.operationToken || '') || !['unknown', 'present', 'absent'].includes(frozen.observation)) throw fail('PHOTO_GENERATION_CLEANUP_EVIDENCE_INVALID');
      return tx(async q => {
        const row = await fresh(q, frozen.jobId, frozen.userId); const previous = await cleanup(q, frozen.jobId, frozen.kind);
        if (!row || previous?.state !== 'observing' || previous.operation_token !== frozen.operationToken) return false;
        const state = !frozen.acknowledged || frozen.observation === 'unknown' ? 'unknown' : frozen.observation === 'absent' ? 'absent_observed' : 'present';
        await q(`UPDATE mini_photo_generation_cleanup SET state = ?,delete_status = ?,observation = ?,checked_at = ?,next_at = ?,
          absent_observations = absent_observations + ?,updated_at = ? WHERE job_id = ? AND kind = ? AND operation_token = ?`,
        [state, frozen.acknowledged ? 'acknowledged' : 'unknown', frozen.observation, time(),
          time() + (state === 'absent_observed' ? settings.recheckAfterMs : settings.retryAfterMs), Number(frozen.observation === 'absent'), time(), frozen.jobId, frozen.kind, frozen.operationToken]);
        return true;
      });
    },
    cleanupJournal: jobId => tx(q => q('SELECT * FROM mini_photo_generation_cleanup WHERE job_id = ? ORDER BY kind', [jobId])),
  };
}

async function deadline(call, milliseconds) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(call), new Promise((_, reject) => {
    timer = setTimeout(() => reject(fail('PHOTO_GENERATION_CLEANUP_UNCONFIRMED')), milliseconds);
  })]); } finally { clearTimeout(timer); }
}

/** Explicit scheduling only. A successful DELETE/HEAD pair is one absence
 * observation, never proof against late writes, versions or retained backups.
 */
export function createPhotoGenerationCleanupWorker({ repository, outputStorage, moderationStorage, policy }) {
  const timeoutMs = policy?.timeoutMs;
  const settings = timing({ ...policy, claimHoldMs: Math.max(policy?.retryAfterMs || 0, (timeoutMs || 0) * 2 + 1000) });
  if (!['prepareCleanup', 'claimCleanup', 'recordCleanupObservation'].every(key => typeof repository?.[key] === 'function')
    || ![outputStorage, moderationStorage].every(storage => ['delete', 'inspect'].every(key => typeof storage?.[key] === 'function'))
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw fail('PHOTO_GENERATION_CLEANUP_PORTS_REQUIRED');
  let accepting = true; const active = new Set();
  async function operate() {
    await repository.prepareCleanup(settings); if (!accepting) return null;
    const claim = await repository.claimCleanup(settings); if (!claim) return null;
    if (!exactKey(claim.kind, claim.storageKey)) throw fail('PHOTO_GENERATION_CLEANUP_KEY_INVALID');
    const storage = claim.kind === 'output' ? outputStorage : moderationStorage;
    let acknowledged = false, observation = 'unknown';
    try { acknowledged = (await deadline(() => storage.delete(claim.storageKey, { timeoutMs }), timeoutMs))?.acknowledged === true; } catch { /* unknown */ }
    try { const found = (await deadline(() => storage.inspect(claim.storageKey, { timeoutMs }), timeoutMs))?.found;
      if (found === true) observation = 'present'; else if (found === false) observation = 'absent'; } catch { /* unknown */ }
    const recorded = await repository.recordCleanupObservation(claim, { acknowledged, observation }, settings);
    return { jobId: claim.jobId, kind: claim.kind, acknowledged, observation, recorded, permanentErasureConfirmed: false };
  }
  return {
    runOnce() { if (!accepting) return Promise.resolve(null); const operation = operate(); active.add(operation);
      operation.finally(() => active.delete(operation)).catch(() => {}); return operation; },
    async drain() { accepting = false; await Promise.allSettled([...active]); return { accepting: false, active: active.size }; },
  };
}
