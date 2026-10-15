import { createHash, randomBytes } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const id = (value, max = 128) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const types = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp']]);
const unfinished = new Set(['staging', 'queued', 'claimed', 'reviewed']);

export function photoUploadSchema(dialect) {
  if (!['mysql', 'sqlite'].includes(dialect)) throw fail('PHOTO_UPLOAD_DATABASE_REQUIRED');
  return `CREATE TABLE IF NOT EXISTS mini_photo_uploads (
    id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, idem CHAR(32) NOT NULL,
    state VARCHAR(16) NOT NULL, storage_key VARCHAR(512) NOT NULL UNIQUE, asset_id VARCHAR(128) NOT NULL UNIQUE,
    sha256 CHAR(64) NOT NULL, byte_length BIGINT NOT NULL, content_type VARCHAR(32) NOT NULL,
    consent_epoch INTEGER NOT NULL, basic_version VARCHAR(80) NOT NULL, face_version VARCHAR(80) NOT NULL,
    moderation_version VARCHAR(80) NOT NULL, moderation_service VARCHAR(80) NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, recovery_checks INTEGER NOT NULL DEFAULT 0, receipt ${dialect === 'mysql' ? 'LONGTEXT' : 'TEXT'},
    source_cleanup_pending INTEGER NOT NULL DEFAULT 0, moderation_cleanup_pending INTEGER NOT NULL DEFAULT 0,
    moderation_cleanup_reference CHAR(32) UNIQUE, moderation_cleanup_extension VARCHAR(4),
    expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    UNIQUE(user_id,idem), FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
    CHECK(state IN ('staging','queued','claimed','reviewed','ready','rejected','review','unknown','cancelled')),
    CHECK(attempts IN (0,1)), CHECK(source_cleanup_pending IN (0,1)), CHECK(moderation_cleanup_pending IN (0,1)),
    CHECK(byte_length > 0 AND byte_length <= 2097152)
  )${dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' : ''}`;
}

export function photoUploadCleanupSchema(dialect) {
  if (!['mysql', 'sqlite'].includes(dialect)) throw fail('PHOTO_UPLOAD_DATABASE_REQUIRED');
  return `CREATE TABLE IF NOT EXISTS mini_photo_upload_cleanup (
    upload_id VARCHAR(80) NOT NULL, kind VARCHAR(16) NOT NULL, storage_key VARCHAR(512) NOT NULL UNIQUE,
    state VARCHAR(24) NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, operation_token CHAR(32),
    delete_status VARCHAR(16) NOT NULL DEFAULT 'not_started', observation VARCHAR(16) NOT NULL DEFAULT 'not_checked',
    next_at BIGINT NOT NULL, delete_started_at BIGINT, checked_at BIGINT, last_absent_at BIGINT, last_present_at BIGINT,
    absent_observations INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    PRIMARY KEY(upload_id,kind), FOREIGN KEY(upload_id) REFERENCES mini_photo_uploads(id),
    CHECK(kind IN ('source','moderation')), CHECK(state IN ('pending','observing','absent_observed','present','unknown')),
    CHECK(delete_status IN ('not_started','unknown','acknowledged')), CHECK(observation IN ('not_checked','unknown','absent','present')),
    CHECK(attempts >= 0), CHECK(absent_observations >= 0)
  )${dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' : ''}`;
}

/** No bytes, URLs, credentials, OCR text, or entitlement accounting live here.
 * All ports share the canonical vp account lock; imports never migrate or dispatch.
 */
export function createPhotoUploadRepository({ database, policy, now = Date.now }) {
  if (!database?.transaction || !['mysql', 'sqlite'].includes(database.backend)) throw fail('PHOTO_UPLOAD_DATABASE_REQUIRED');
  const config = Object.freeze({ basicVersion: policy?.basicVersion, faceVersion: policy?.faceVersion,
    moderationVersion: policy?.moderationVersion, moderationService: policy?.moderationService,
    sourceRetentionMs: policy?.sourceRetentionMs, maxDailyUploads: policy?.maxDailyUploads,
    maxDailyUploadsPerUser: policy?.maxDailyUploadsPerUser });
  if (![config.basicVersion, config.faceVersion, config.moderationVersion].every(v => id(v, 80))
    || !['baselineCheck', 'aigcCheck'].includes(config.moderationService)
    || !Number.isSafeInteger(config.sourceRetentionMs) || config.sourceRetentionMs < 1 || config.sourceRetentionMs > 30 * 86400000
    || ![config.maxDailyUploads, config.maxDailyUploadsPerUser].every(v => Number.isSafeInteger(v) && v > 0 && v <= 100000)) {
    throw fail('PHOTO_UPLOAD_POLICY_REQUIRED');
  }
  const time = () => { const t = now(); if (!Number.isSafeInteger(t) || t < 0) throw fail('PHOTO_UPLOAD_TIME_INVALID'); return t; };
  const tx = callback => database.transaction(callback);
  const lock = async (q, userId) => {
    if (!id(userId, 80)) throw fail('PHOTO_UPLOAD_ACCOUNT_REQUIRED');
    const account = (await q(`SELECT user_id FROM vp_accounts WHERE user_id = ?${database.backend === 'mysql' ? ' FOR UPDATE' : ''}`, [userId]))[0];
    if (!account) throw fail('PHOTO_UPLOAD_ACCOUNT_REQUIRED');
    return (await q('SELECT * FROM mini_photo_accounts WHERE user_id = ?', [userId]))[0];
  };
  const rowById = async (q, uploadId) => (await q('SELECT * FROM mini_photo_uploads WHERE id = ?', [uploadId]))[0];
  const authorized = (account, row) => account?.enabled === 1 && account.basic_version === config.basicVersion
    && account.face_version === config.faceVersion && ['self', 'authorized'].includes(account.subject_authorization)
    && (!row || (row.consent_epoch === account.consent_epoch && row.expires_at > time()
      && row.basic_version === config.basicVersion && row.face_version === config.faceVersion
      && row.moderation_version === config.moderationVersion && row.moderation_service === config.moderationService));
  const publicRow = row => row && ({ id: row.id, state: row.state, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    ...(row.state === 'ready' ? { assetId: row.asset_id } : {}) });
  async function fresh(q, row, account) {
    if (!row) return null;
    let valid = authorized(account, row);
    if (row.state === 'ready') {
      const asset = (await q('SELECT state,consent_epoch FROM mini_photo_assets WHERE id = ? AND user_id = ?', [row.asset_id, row.user_id]))[0];
      valid = valid && asset?.state === 'ready' && asset.consent_epoch === row.consent_epoch;
    }
    if (!valid && (unfinished.has(row.state) || row.state === 'ready')) {
      await q("UPDATE mini_photo_uploads SET state = 'cancelled',source_cleanup_pending = 1,updated_at = ? WHERE id = ?", [time(), row.id]);
      return { ...row, state: 'cancelled', source_cleanup_pending: 1, updated_at: time() };
    }
    return row;
  }
  const owned = async (userId, column, value) => tx(async q => {
    const account = await lock(q, userId);
    const row = (await q(`SELECT * FROM mini_photo_uploads WHERE user_id = ? AND ${column} = ?`, [userId, value]))[0];
    return publicRow(await fresh(q, row, account));
  });
  const pending = async state => tx(async q => {
    const candidate = (await q('SELECT id,user_id FROM mini_photo_uploads WHERE state = ? ORDER BY recovery_checks,created_at,id LIMIT 1', [state]))[0];
    if (!candidate) return null;
    const account = await lock(q, candidate.user_id);
    // Re-read after the account lock: another connection may have progressed it.
    const row = await rowById(q, candidate.id);
    if (row?.state !== state) return null;
    await q('UPDATE mini_photo_uploads SET recovery_checks = recovery_checks + 1 WHERE id = ?', [row.id]);
    return { account, row: await fresh(q, row, account) };
  });
  const cleanupTiming = settings => {
    const snapshot = { retryAfterMs: settings?.retryAfterMs, recheckAfterMs: settings?.recheckAfterMs,
      inFlightGraceMs: settings?.inFlightGraceMs, claimHoldMs: settings?.claimHoldMs };
    if (!Number.isSafeInteger(snapshot.retryAfterMs) || snapshot.retryAfterMs < 1000 || snapshot.retryAfterMs > 86400000
      || !Number.isSafeInteger(snapshot.recheckAfterMs) || snapshot.recheckAfterMs < snapshot.retryAfterMs || snapshot.recheckAfterMs > 7 * 86400000
      || !Number.isSafeInteger(snapshot.inFlightGraceMs) || snapshot.inFlightGraceMs < 300000 || snapshot.inFlightGraceMs > 86400000
      || !Number.isSafeInteger(snapshot.claimHoldMs) || snapshot.claimHoldMs < 1000 || snapshot.claimHoldMs > 86400000) throw fail('PHOTO_UPLOAD_CLEANUP_POLICY_REQUIRED');
    return snapshot;
  };
  const sourceDisposable = async (q, row, account) => {
    if (row.expires_at <= time() || !account || account.enabled !== 1 || account.consent_epoch !== row.consent_epoch
      || !account.basic_version || !account.face_version || !['self', 'authorized'].includes(account.subject_authorization)) return true;
    const asset = (await q('SELECT state FROM mini_photo_assets WHERE id = ? AND user_id = ?', [row.asset_id, row.user_id]))[0];
    // A failed/unknown audit alone is NOT permission to delete an unexpired
    // source. Explicit deletion, withdrawal, disabled account or expiry is.
    return ['deleted', 'revoked'].includes(asset?.state);
  };
  const scratchDisposable = (row, account, settings) => Boolean(row.moderation_cleanup_reference)
    && (row.state !== 'claimed' || !authorized(account, row) || row.updated_at + settings.inFlightGraceMs <= time());
  const cleanupRow = async (q, uploadId, kind) => (await q('SELECT * FROM mini_photo_upload_cleanup WHERE upload_id = ? AND kind = ?', [uploadId, kind]))[0];
  const checkBudget = async (q, userId, stamp) => {
    const dayStart = Math.floor(stamp / 86400000) * 86400000;
    const all = (await q('SELECT COUNT(*) AS n FROM mini_photo_uploads WHERE created_at >= ?', [dayStart]))[0].n;
    const own = (await q('SELECT COUNT(*) AS n FROM mini_photo_uploads WHERE user_id = ? AND created_at >= ?', [userId, dayStart]))[0].n;
    if (all >= config.maxDailyUploads || own >= config.maxDailyUploadsPerUser) throw fail('PHOTO_UPLOAD_BUDGET_LIMIT');
  };
  return {
    database, policy: config,
    async preflight({ userId, idempotencyKey }) {
      if (!id(userId, 80) || !/^[a-f0-9]{32}$/.test(idempotencyKey || '')) throw fail('PHOTO_UPLOAD_INVALID_REQUEST');
      // SELECT only; no placeholder intent, quota reservation, state refresh or
      // lock survives this transaction. submitIntent repeats the atomic checks.
      return tx(async q => {
        const account = await lock(q, userId);
        const existing = Boolean((await q('SELECT id FROM mini_photo_uploads WHERE user_id = ? AND idem = ?', [userId, idempotencyKey]))[0]);
        if (!authorized(account)) throw fail(existing ? 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT' : 'PHOTO_UPLOAD_NOT_AUTHORIZED');
        if (!existing) await checkBudget(q, userId, time());
        return { existing, consentEpoch: account.consent_epoch };
      });
    },
    async submitIntent({ userId, idempotencyKey, sha256, byteLength, contentType, expectedConsentEpoch }) {
      if (!id(userId, 80) || !/^[a-f0-9]{32}$/.test(idempotencyKey || '') || !/^[a-f0-9]{64}$/.test(sha256 || '')
        || !Number.isSafeInteger(byteLength) || byteLength < 16 || byteLength > 2097152 || !types.has(contentType)) throw fail('PHOTO_UPLOAD_INVALID_REQUEST');
      return tx(async q => {
        const account = await lock(q, userId);
        const previous = (await q('SELECT * FROM mini_photo_uploads WHERE user_id = ? AND idem = ?', [userId, idempotencyKey]))[0];
        if (previous) {
          if (previous.sha256 !== sha256 || previous.byte_length !== byteLength || previous.content_type !== contentType) throw fail('PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT');
          return { upload: publicRow(await fresh(q, previous, account)), duplicate: true };
        }
        if (!authorized(account) || (expectedConsentEpoch !== undefined && account.consent_epoch !== expectedConsentEpoch)) throw fail('PHOTO_UPLOAD_NOT_AUTHORIZED');
        const stamp = time();
        // Separate upload admission budget. Counting all intents is conservative:
        // lost PUTs and abandoned uploads never silently release cost allowance.
        // MySQL SERIALIZABLE range reads serialize conflicting insertions.
        await checkBudget(q, userId, stamp);
        const token = randomBytes(16).toString('hex');
        const row = { id: `upload_${token}`, user_id: userId, state: 'staging', asset_id: `input_${token}`,
          storage_key: `private/mini-photo-input/${token}.${types.get(contentType)}`, created_at: stamp, updated_at: stamp };
        await q(`INSERT INTO mini_photo_uploads(id,user_id,idem,state,storage_key,asset_id,sha256,byte_length,content_type,
          consent_epoch,basic_version,face_version,moderation_version,moderation_service,expires_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.id, userId, idempotencyKey, row.state, row.storage_key, row.asset_id,
          sha256, byteLength, contentType, account.consent_epoch, config.basicVersion, config.faceVersion,
          config.moderationVersion, config.moderationService, stamp + config.sourceRetentionMs, stamp, stamp]);
        // Only the first successful commit obtains the server-internal PUT key.
        return { upload: publicRow(row), duplicate: false, storageKey: row.storage_key };
      });
    },
    readOwned: (userId, uploadId) => owned(userId, 'id', uploadId),
    findOwnedByKey: (userId, key) => owned(userId, 'idem', key),
    async nextStaging() { const item = await pending('staging'); return item?.row.state === 'staging' ? item.row : null; },
    async confirmStored(uploadId, evidence) {
      const frozen = { sha256: evidence?.sha256, byteLength: evidence?.byteLength, contentType: evidence?.contentType };
      return tx(async q => {
        const initial = await rowById(q, uploadId); if (!initial) return null;
        const account = await lock(q, initial.user_id); const row = await fresh(q, await rowById(q, uploadId), account);
        if (row.state !== 'staging') return publicRow(row);
        const match = frozen.sha256 === row.sha256 && frozen.byteLength === row.byte_length && frozen.contentType === row.content_type;
        const state = match ? 'queued' : 'unknown';
        await q('UPDATE mini_photo_uploads SET state = ?,source_cleanup_pending = ?,updated_at = ? WHERE id = ?', [state, match ? 0 : 1, time(), row.id]);
        return publicRow({ ...row, state, updated_at: time() });
      });
    },
    async claimNext() {
      return tx(async q => {
        const candidate = (await q("SELECT id,user_id FROM mini_photo_uploads WHERE state = 'queued' AND attempts = 0 ORDER BY created_at,id LIMIT 1"))[0];
        if (!candidate) return null;
        const account = await lock(q, candidate.user_id); let row = await rowById(q, candidate.id);
        if (row?.state !== 'queued' || row.attempts !== 0) return null;
        row = await fresh(q, row, account); if (row.state !== 'queued') return null;
        await q("UPDATE mini_photo_uploads SET state = 'claimed',attempts = 1,updated_at = ? WHERE id = ? AND state = 'queued' AND attempts = 0", [time(), row.id]);
        return { ...row, state: 'claimed', attempts: 1 };
      });
    },
    async recordModerationIntent(uploadId, intent) {
      const reference = intent?.reference; const extension = intent?.extension;
      if (!/^[a-f0-9]{32}$/.test(reference || '') || !['jpg', 'png', 'webp'].includes(extension)) throw fail('PHOTO_UPLOAD_REVIEW_INTENT_INVALID');
      return tx(async q => {
        const initial = await rowById(q, uploadId); if (!initial) throw fail('PHOTO_UPLOAD_REVIEW_INTENT_INVALID');
        const account = await lock(q, initial.user_id); const row = await rowById(q, uploadId);
        if (row.state !== 'claimed' || row.attempts !== 1 || !authorized(account, row)
          || extension !== types.get(row.content_type)) throw fail('PHOTO_UPLOAD_NOT_AUTHORIZED');
        if (row.moderation_cleanup_reference) throw fail('PHOTO_UPLOAD_REVIEW_ALREADY_DISPATCHED');
        await q(`UPDATE mini_photo_uploads SET moderation_cleanup_pending = 1,moderation_cleanup_reference = ?,
          moderation_cleanup_extension = ?,updated_at = ? WHERE id = ?`, [reference, extension, time(), row.id]);
        return true;
      });
    },
    async recordReview(uploadId, evidence) {
      // Snapshot before any await. Never store unbounded provider text or URLs.
      const receipt = { provider: evidence?.provider, policyVersion: evidence?.policyVersion, service: evidence?.service,
        direction: evidence?.direction, sha256: evidence?.sha256, byteLength: evidence?.byteLength,
        decision: evidence?.decision, reference: evidence?.reference, requestId: evidence?.requestId };
      const cleanupPending = evidence?.cleanupPending === true;
      const cleanupConfirmed = evidence?.cleanupPending === false;
      const cleanupReference = evidence?.cleanupReference;
      const cleanupExtension = evidence?.cleanupExtension;
      return tx(async q => {
        const initial = await rowById(q, uploadId); if (!initial) return null;
        const account = await lock(q, initial.user_id); const row = await rowById(q, uploadId);
        // A consent withdrawal may cancel an in-flight review. Persist cleanup
        // responsibility even then, without publishing the cancelled source.
        if (row.attempts !== 1 || !['claimed', 'cancelled'].includes(row.state)) return publicRow(row);
        const journalMatches = /^[a-f0-9]{32}$/.test(row.moderation_cleanup_reference || '')
          && row.moderation_cleanup_reference === cleanupReference && row.moderation_cleanup_extension === cleanupExtension;
        const valid = journalMatches && receipt.provider === 'aliyun-green' && receipt.policyVersion === row.moderation_version
          && receipt.service === row.moderation_service && receipt.direction === 'input' && receipt.sha256 === row.sha256
          && receipt.byteLength === row.byte_length && ['allow', 'review', 'block'].includes(receipt.decision)
          && /^mod_[a-f0-9]{64}$/.test(receipt.reference || '') && id(receipt.requestId);
        const state = !authorized(account, row) || row.state === 'cancelled' ? 'cancelled'
          : !valid ? 'unknown' : ({ allow: 'reviewed', review: 'review', block: 'rejected' })[receipt.decision];
        await q(`UPDATE mini_photo_uploads SET state = ?,receipt = ?,source_cleanup_pending = ?,moderation_cleanup_pending = ?,
          moderation_cleanup_reference = ?,moderation_cleanup_extension = ?,updated_at = ? WHERE id = ?`,
        [state, valid ? JSON.stringify(receipt) : null, state === 'reviewed' ? 0 : 1,
          journalMatches && cleanupConfirmed ? 0 : Number(row.moderation_cleanup_pending === 1 || cleanupPending),
          row.moderation_cleanup_reference, row.moderation_cleanup_extension, time(), row.id]);
        return publicRow({ ...row, state, updated_at: time() });
      });
    },
    async publishNext() {
      return tx(async q => {
        const candidate = (await q("SELECT id,user_id FROM mini_photo_uploads WHERE state = 'reviewed' ORDER BY created_at,id LIMIT 1"))[0];
        if (!candidate) return null;
        const account = await lock(q, candidate.user_id); let row = await rowById(q, candidate.id);
        if (row?.state !== 'reviewed') return null;
        row = await fresh(q, row, account); if (row.state !== 'reviewed') return publicRow(row);
        const receipt = JSON.parse(row.receipt);
        await q(`INSERT INTO mini_photo_assets(id,user_id,kind,state,storage_key,sha256,byte_length,content_type,
          consent_epoch,job_id,moderation_reference,label_version,expires_at,created_at) VALUES (?,?,'input','ready',?,?,?,?,?,NULL,?,NULL,?,?)`,
        [row.asset_id, row.user_id, row.storage_key, row.sha256, row.byte_length, row.content_type, row.consent_epoch, receipt.reference, row.expires_at, time()]);
        await q("UPDATE mini_photo_uploads SET state = 'ready',updated_at = ? WHERE id = ?", [time(), row.id]);
        return publicRow({ ...row, state: 'ready', updated_at: time() });
      });
    },
    // Internal-only durable deletion responsibilities. Both source and scratch
    // keys exist in SQL BEFORE their respective PUTs, including crash/lost reply.
    // No automatic deletion/ack here: a late PUT after DELETE needs a revisit.
    async cleanupCandidates() {
      return tx(async q => {
        const candidates = await q(`SELECT u.id,u.user_id FROM mini_photo_uploads u
          LEFT JOIN mini_photo_accounts a ON a.user_id = u.user_id
          LEFT JOIN mini_photo_assets s ON s.id = u.asset_id
          WHERE u.source_cleanup_pending = 1 OR u.moderation_cleanup_pending = 1 OR u.expires_at <= ?
          OR a.user_id IS NULL OR a.enabled <> 1 OR a.basic_version IS NULL OR a.basic_version <> ?
          OR a.face_version IS NULL OR a.face_version <> ? OR a.consent_epoch <> u.consent_epoch
          OR a.subject_authorization IS NULL OR a.subject_authorization NOT IN ('self','authorized')
          OR u.basic_version <> ? OR u.face_version <> ? OR u.moderation_version <> ? OR u.moderation_service <> ?
          OR (u.state = 'ready' AND (s.id IS NULL OR s.state <> 'ready')) ORDER BY u.user_id,u.id`,
        [time(), config.basicVersion, config.faceVersion, config.basicVersion, config.faceVersion, config.moderationVersion, config.moderationService]);
        const results = [];
        for (const candidate of candidates) {
          const account = await lock(q, candidate.user_id); const row = await fresh(q, await rowById(q, candidate.id), account);
          if (row.source_cleanup_pending === 1 || row.moderation_cleanup_pending === 1 || row.expires_at <= time()) {
            results.push({ id: row.id, storage_key: row.storage_key, expires_at: row.expires_at, state: row.state,
              source_cleanup_pending: row.source_cleanup_pending, moderation_cleanup_pending: row.moderation_cleanup_pending,
              moderation_cleanup_reference: row.moderation_cleanup_reference, moderation_cleanup_extension: row.moderation_cleanup_extension });
          }
        }
        return results;
      });
    },
    async prepareCleanup(input) {
      const settings = cleanupTiming(input);
      // Commit the bounded discovery read before locking any user for changes.
      // A SERIALIZABLE scan must not retain its range locks while 100 accounts
      // are processed. Every candidate is revalidated in the following transaction.
      const candidates = await tx(q => {
        // Discover at most 100 NEW object responsibilities, not every historical
        // upload/account. Existing journals are scheduled independently by next_at.
        // NOT EXISTS removes each discovered scope from future scans, so late
        // rows progress on subsequent runs without user polling or a reset cursor.
        return q(`SELECT u.id,u.user_id FROM mini_photo_uploads u
          LEFT JOIN mini_photo_accounts a ON a.user_id = u.user_id
          LEFT JOIN mini_photo_assets s ON s.id = u.asset_id
          WHERE (NOT EXISTS (SELECT 1 FROM mini_photo_upload_cleanup c WHERE c.upload_id = u.id AND c.kind = 'source')
            AND (u.expires_at <= ? OR a.user_id IS NULL OR a.enabled <> 1 OR a.consent_epoch <> u.consent_epoch
              OR a.basic_version IS NULL OR a.face_version IS NULL OR a.subject_authorization IS NULL
              OR a.subject_authorization NOT IN ('self','authorized') OR s.state IN ('deleted','revoked')))
          OR (u.moderation_cleanup_reference IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM mini_photo_upload_cleanup c WHERE c.upload_id = u.id AND c.kind = 'moderation')
            AND (u.state <> 'claimed' OR u.updated_at <= ? OR a.user_id IS NULL OR a.enabled <> 1
              OR a.basic_version IS NULL OR a.basic_version <> ? OR a.face_version IS NULL OR a.face_version <> ?
              OR a.consent_epoch <> u.consent_epoch OR a.subject_authorization IS NULL
              OR a.subject_authorization NOT IN ('self','authorized') OR u.expires_at <= ?
              OR u.basic_version <> ? OR u.face_version <> ? OR u.moderation_version <> ? OR u.moderation_service <> ?))
          ORDER BY u.created_at,u.id LIMIT 100`, [time(), time() - settings.inFlightGraceMs, config.basicVersion, config.faceVersion,
          time(), config.basicVersion, config.faceVersion, config.moderationVersion, config.moderationService]);
      });
      candidates.sort((a, b) => a.user_id < b.user_id ? -1 : a.user_id > b.user_id ? 1 : a.id < b.id ? -1 : 1);
      return tx(async q => {
        // No network and no re-upload/re-review. The normal account lock also
        // serializes consent withdrawal and asset publication/deletion.
        let inserted = 0;
        for (const candidate of candidates) {
          const account = await lock(q, candidate.user_id); const row = await fresh(q, await rowById(q, candidate.id), account);
          const scopes = [];
          if (await sourceDisposable(q, row, account)) scopes.push(['source', row.storage_key]);
          if (scratchDisposable(row, account, settings)) scopes.push(['moderation', `private/photo-moderation/${row.moderation_cleanup_reference}.${row.moderation_cleanup_extension}`]);
          for (const [kind, storageKey] of scopes) {
            const previous = await cleanupRow(q, row.id, kind);
            if (previous && previous.storage_key !== storageKey) throw fail('PHOTO_UPLOAD_CLEANUP_KEY_CONFLICT');
            if (!previous) {
              await q(`INSERT INTO mini_photo_upload_cleanup(upload_id,kind,storage_key,next_at,created_at,updated_at)
                VALUES (?,?,?,?,?,?)`, [row.id, kind, storageKey, time(), time(), time()]);
              inserted++;
            }
            await q(`UPDATE mini_photo_uploads SET ${kind === 'source' ? 'source' : 'moderation'}_cleanup_pending = 1 WHERE id = ?`, [row.id]);
          }
        }
        return inserted;
      });
    },
    async claimCleanup(input) {
      const settings = cleanupTiming(input);
      return tx(async q => {
        const candidate = (await q(`SELECT c.upload_id,c.kind,u.user_id FROM mini_photo_upload_cleanup c
          JOIN mini_photo_uploads u ON u.id = c.upload_id WHERE c.next_at <= ? ORDER BY c.next_at,c.upload_id,c.kind LIMIT 1`, [time()]))[0];
        if (!candidate) return null;
        const account = await lock(q, candidate.user_id); const row = await rowById(q, candidate.upload_id);
        const cleanup = await cleanupRow(q, row.id, candidate.kind);
        if (!cleanup || cleanup.next_at > time()) return null;
        const disposable = candidate.kind === 'source' ? await sourceDisposable(q, row, account) : scratchDisposable(row, account, settings);
        if (!disposable) {
          await q('UPDATE mini_photo_upload_cleanup SET next_at = ?,updated_at = ? WHERE upload_id = ? AND kind = ?',
            [time() + settings.retryAfterMs, time(), row.id, candidate.kind]);
          return null;
        }
        const token = randomBytes(16).toString('hex');
        // Only deletion has a retry time. This NEVER changes the upload claim,
        // never leases/retries Green, and never authorizes another source PUT.
        await q(`UPDATE mini_photo_upload_cleanup SET state = 'observing',attempts = attempts + 1,operation_token = ?,
          delete_status = 'unknown',observation = 'not_checked',delete_started_at = ?,next_at = ?,updated_at = ?
          WHERE upload_id = ? AND kind = ?`, [token, time(), time() + settings.claimHoldMs, time(), row.id, candidate.kind]);
        return { uploadId: row.id, kind: candidate.kind, storageKey: cleanup.storage_key, operationToken: token,
          attempt: cleanup.attempts + 1 };
      });
    },
    async recordCleanupObservation(claim, evidence, input) {
      const settings = cleanupTiming(input);
      const frozen = { uploadId: claim?.uploadId, kind: claim?.kind, operationToken: claim?.operationToken,
        deleteAcknowledged: evidence?.deleteAcknowledged === true, observation: evidence?.observation };
      if (!/^upload_[a-f0-9]{32}$/.test(frozen.uploadId || '') || !['source', 'moderation'].includes(frozen.kind)
        || !/^[a-f0-9]{32}$/.test(frozen.operationToken || '') || !['absent', 'present', 'unknown'].includes(frozen.observation)) throw fail('PHOTO_UPLOAD_CLEANUP_OBSERVATION_INVALID');
      return tx(async q => {
        const initial = await rowById(q, frozen.uploadId); if (!initial) return false;
        await lock(q, initial.user_id); const row = await cleanupRow(q, frozen.uploadId, frozen.kind);
        // A timed-out older DELETE/HEAD may finish after another cleanup attempt.
        // Persist only the currently claimed token; old replies cannot regress it.
        if (row?.state !== 'observing' || row.operation_token !== frozen.operationToken) return false;
        const absent = frozen.observation === 'absent'; const present = frozen.observation === 'present';
        const state = !frozen.deleteAcknowledged || frozen.observation === 'unknown' ? 'unknown' : absent ? 'absent_observed' : 'present';
        await q(`UPDATE mini_photo_upload_cleanup SET state = ?,delete_status = ?,observation = ?,next_at = ?,checked_at = ?,
          last_absent_at = ?,last_present_at = ?,absent_observations = absent_observations + ?,updated_at = ?
          WHERE upload_id = ? AND kind = ? AND operation_token = ?`, [state, frozen.deleteAcknowledged ? 'acknowledged' : 'unknown',
          frozen.observation, time() + (state === 'absent_observed' ? settings.recheckAfterMs : settings.retryAfterMs), time(),
          absent ? time() : row.last_absent_at, present ? time() : row.last_present_at, absent ? 1 : 0, time(), frozen.uploadId, frozen.kind, frozen.operationToken]);
        // An absence observation is durable evidence of THIS check only. Keep
        // responsibility active forever until an external writer/retention proof
        // can safely close it; no such privileged closure API exists here.
        await q(`UPDATE mini_photo_uploads SET ${frozen.kind === 'source' ? 'source' : 'moderation'}_cleanup_pending = 1 WHERE id = ?`, [frozen.uploadId]);
        return true;
      });
    },
    cleanupJournal: uploadId => tx(q => q('SELECT * FROM mini_photo_upload_cleanup WHERE upload_id = ? ORDER BY kind', [uploadId])),
  };
}

export function parsePhotoUpload(image) {
  if (typeof image !== 'string' || image.length > 2800000) throw fail('PHOTO_UPLOAD_INVALID_REQUEST');
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match) throw fail('PHOTO_UPLOAD_INVALID_REQUEST');
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 16 || bytes.length > 2097152 || bytes.toString('base64') !== match[2]) throw fail('PHOTO_UPLOAD_INVALID_REQUEST');
  const type = match[1];
  const matches = type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && bytes.readUInt32LE(4) + 8 === bytes.length;
  if (!matches) throw fail('PHOTO_UPLOAD_INVALID_REQUEST');
  return { bytes, contentType: type, byteLength: bytes.length, sha256: hash(bytes) };
}
