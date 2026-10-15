import { createHash, randomUUID } from 'node:crypto';
import { createPhotoJobRepository } from './repository.js';

const fail = code => Object.assign(new Error(code), { code });
const identifier = (value, max = 128) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value);
const providerIdentifier = (value, max) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const encoded = value => {
  const visit = (item, depth = 0) => {
    if (depth > 8) throw fail('PHOTO_CONTEXT_INVALID_VALUE');
    if (item === null || ['boolean', 'string'].includes(typeof item)) return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${Array.from(item, child => visit(child, depth + 1)).join(',')}]`;
    if (item && Object.getPrototypeOf(item) === Object.prototype) return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${visit(item[key], depth + 1)}`).join(',')}}`;
    throw fail('PHOTO_CONTEXT_INVALID_VALUE');
  };
  const text = visit(value);
  if (Buffer.byteLength(text) > 8192) throw fail('PHOTO_CONTEXT_INVALID_VALUE');
  return text;
};

// Explicit candidate DDL only. Importing this module never runs SQL or starts a worker.
export function photoContextSchema(dialect) {
  if (!['mysql', 'sqlite'].includes(dialect)) throw fail('PHOTO_CONTEXT_DATABASE_REQUIRED');
  const text = dialect === 'mysql' ? 'LONGTEXT' : 'TEXT';
  const suffix = dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' : '';
  return [
    `CREATE TABLE IF NOT EXISTS mini_photo_accounts (user_id VARCHAR(80) PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
      consent_epoch INTEGER NOT NULL DEFAULT 0, basic_version VARCHAR(80), face_version VARCHAR(80), subject_authorization VARCHAR(16),
      updated_at BIGINT NOT NULL, FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id), CHECK(enabled IN (0,1)))`,
    `CREATE TABLE IF NOT EXISTS mini_photo_effects (effect_id VARCHAR(80) NOT NULL, version VARCHAR(80) NOT NULL,
      provider VARCHAR(80) NOT NULL, model VARCHAR(100) NOT NULL, purpose VARCHAR(100) NOT NULL, parameters ${text} NOT NULL,
      enabled INTEGER NOT NULL, review_reference VARCHAR(128) NOT NULL, created_at BIGINT NOT NULL,
      PRIMARY KEY(effect_id,version), CHECK(enabled IN (0,1)))`,
    `CREATE TABLE IF NOT EXISTS mini_photo_assets (id VARCHAR(128) PRIMARY KEY, user_id VARCHAR(80) NOT NULL,
      kind VARCHAR(16) NOT NULL, state VARCHAR(16) NOT NULL, storage_key VARCHAR(512) NOT NULL UNIQUE,
      sha256 CHAR(64) NOT NULL, byte_length BIGINT NOT NULL, content_type VARCHAR(32) NOT NULL,
      consent_epoch INTEGER NOT NULL, job_id VARCHAR(80) UNIQUE, moderation_reference VARCHAR(128) NOT NULL,
      label_version VARCHAR(80), expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id), CHECK(kind IN ('input','output')),
      CHECK(state IN ('ready','staged','published','revoked','deleted')))`,
    `CREATE TABLE IF NOT EXISTS mini_photo_works (job_id VARCHAR(80) PRIMARY KEY, asset_id VARCHAR(128) NOT NULL UNIQUE,
      user_id VARCHAR(80) NOT NULL, created_at BIGINT NOT NULL, FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
      FOREIGN KEY(asset_id) REFERENCES mini_photo_assets(id))`,
  ].map(sql => sql + suffix);
}

/** Server-only persistence boundary. Media bytes and review/marking evidence must already
 * exist before registration. Never expose these mutation methods directly as client flags.
 * The existing virtual ledger is the only authority for credits and refund compensation.
 */
export function createPhotoJobContext({ ledger, policy, now = Date.now }) {
  const database = ledger?.database;
  if (!database?.transaction || !['reserveInTransaction', 'finishInTransaction'].every(name => typeof ledger[name] === 'function')) {
    throw fail('PHOTO_CONTEXT_SHARED_LEDGER_REQUIRED');
  }
  const basicVersion = policy?.basicVersion;
  const faceVersion = policy?.faceVersion;
  const labelVersion = policy?.labelVersion;
  const sourceRetentionMs = policy?.sourceRetentionMs ?? 86400000;
  const resultRetentionMs = policy?.resultRetentionMs ?? 86400000;
  if (![basicVersion, faceVersion, labelVersion].every(value => identifier(value, 80))
    || ![sourceRetentionMs, resultRetentionMs].every(value => Number.isSafeInteger(value) && value > 0 && value <= 30 * 86400000)) {
    throw fail('PHOTO_CONTEXT_POLICY_REQUIRED');
  }
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw fail('PHOTO_CONTEXT_INVALID_TIME'); return value; };
  const tx = callback => database.transaction(callback);
  const audit = (query, userId, action, reference, detail = {}) => query(
    'INSERT INTO vp_audit(id,user_id,action,reference_id,detail,created_at) VALUES (?,?,?,?,?,?)',
    [randomUUID().replaceAll('-', ''), userId, action, reference, JSON.stringify(detail), time()]);
  const lock = async (query, userId) => {
    if (!identifier(userId, 80)) throw fail('PHOTO_CONTEXT_ACCOUNT_REQUIRED');
    const account = (await query(`SELECT user_id FROM vp_accounts WHERE user_id = ?${database.backend === 'mysql' ? ' FOR UPDATE' : ''}`, [userId]))[0];
    if (!account) throw fail('PHOTO_CONTEXT_ACCOUNT_REQUIRED');
    return (await query('SELECT * FROM mini_photo_accounts WHERE user_id = ?', [userId]))[0];
  };
  const ensure = async (query, userId) => {
    const existing = await lock(query, userId);
    if (existing) return existing;
    await query('INSERT INTO mini_photo_accounts(user_id,enabled,consent_epoch,updated_at) VALUES (?,1,0,?)', [userId, time()]);
    return { user_id: userId, enabled: 1, consent_epoch: 0 };
  };
  const consentReady = account => account?.enabled === 1 && account.basic_version === basicVersion
    && account.face_version === faceVersion && ['self', 'authorized'].includes(account.subject_authorization);
  const activeAsset = (asset, account) => asset && asset.user_id === account.user_id && asset.consent_epoch === account.consent_epoch
    && asset.expires_at > time() && !['deleted', 'revoked'].includes(asset.state);
  const assetById = async (query, id) => (await query('SELECT * FROM mini_photo_assets WHERE id = ?', [id]))[0];
  const ownedAsset = asset => ({ assetId: asset.id, kind: 'image', createdAt: Number(asset.created_at), expiresAt: Number(asset.expires_at), contentType: asset.content_type });
  const authorize = async ({ query, job, phase }) => {
    const account = await lock(query, job.user_id);
    if (!consentReady(account)) return false;
    if (phase !== 'submit') {
      // A channel-initiated refund can invalidate a paid bucket while a job
      // remains reserved. Recheck the canonical money/rights source under the
      // same account lock before spending a provider call or exposing output.
      const reservation = (await query(`SELECT r.user_id,r.purpose,r.status,b.user_id AS bucket_user,b.kind,b.reserved,
        o.user_id AS order_user,o.status AS order_status,o.payload AS order_payload
        FROM vp_reservations r JOIN vp_buckets b ON b.id = r.bucket_id JOIN vp_orders o ON o.id = b.order_id
        WHERE r.id = ?`, [job.billing_ref]))[0];
      if (!reservation || reservation.user_id !== job.user_id || reservation.bucket_user !== job.user_id
        || reservation.order_user !== job.user_id || reservation.purpose !== job.spec.purpose
        || reservation.status !== 'reserved' || reservation.kind !== 'photo' || reservation.reserved < 1
        || reservation.order_status !== 'paid') return false;
      const order = JSON.parse(reservation.order_payload);
      if (order.userId !== job.user_id || order.status !== 'paid') return false;
    }
    const input = await assetById(query, job.spec.inputAssetId);
    if (!activeAsset(input, account) || input.kind !== 'input' || input.state !== 'ready') return false;
    const effect = (await query('SELECT * FROM mini_photo_effects WHERE effect_id = ? AND version = ?', [job.spec.effectId, job.spec.effectVersion]))[0];
    if (!effect || effect.enabled !== 1 || effect.provider !== job.spec.provider || effect.model !== job.spec.model
      || effect.purpose !== job.spec.purpose || effect.parameters !== encoded(job.spec.effectParameters)) return false;
    if (phase === 'publish') {
      const output = await assetById(query, job.output_asset_id);
      if (!activeAsset(output, account) || output.kind !== 'output' || output.state !== 'staged'
        || output.job_id !== job.id || output.label_version !== labelVersion) return false;
    }
    return true;
  };
  const ports = {
    authorize,
    async reserve({ query, job }) {
      const result = await ledger.reserveInTransaction(query, { userId: job.user_id, reference: job.billing_ref, purpose: job.spec.purpose, kind: 'photo' });
      // A reservation with no matching persisted job is never a license to dispatch again.
      return result?.ok === true && result.duplicate === false;
    },
    async settle({ query, job, outcome }) {
      if (!['succeeded', 'not_started'].includes(outcome)) throw fail('PHOTO_CONTEXT_INVALID_SETTLEMENT');
      return ledger.finishInTransaction(query, { userId: job.user_id, reference: job.billing_ref, outcome: outcome === 'succeeded' ? 'success' : 'failed' });
    },
    async publish({ query, job, assetId }) {
      await query('INSERT INTO mini_photo_works(job_id,asset_id,user_id,created_at) VALUES (?,?,?,?)', [job.id, assetId, job.user_id, time()]);
      const result = await query("UPDATE mini_photo_assets SET state = 'published' WHERE id = ? AND user_id = ? AND state = 'staged'", [assetId, job.user_id]);
      return Number(result?.affectedRows ?? result?.changes ?? 0) === 1;
    },
  };
  const repository = createPhotoJobRepository({ database, ...ports, now });
  const register = async (userId, kind, input, jobId) => {
    // Capture caller-owned values before the first await, including nested review evidence.
    const asset = { id: input?.id, storageKey: input?.storageKey, sha256: input?.sha256, byteLength: input?.byteLength,
      contentType: input?.contentType, expiresAt: input?.expiresAt, moderationDecision: input?.moderation?.decision,
      moderationReference: input?.moderation?.reference, labelVersion: input?.labelVersion };
    if (!identifier(asset.id) || typeof asset.storageKey !== 'string' || asset.storageKey.length > 512
      || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(asset.storageKey) || asset.storageKey.split('/').some(part => !part || part === '.' || part === '..')
      || !/^[a-f0-9]{64}$/.test(asset.sha256 || '') || !Number.isSafeInteger(asset.byteLength)
      || asset.byteLength < 1 || asset.byteLength > (kind === 'input' ? 2 : 20) * 1024 * 1024
      || !['image/jpeg', 'image/png', 'image/webp'].includes(asset.contentType)
      || asset.moderationDecision !== 'allow' || !identifier(asset.moderationReference)
      || !Number.isSafeInteger(asset.expiresAt) || asset.expiresAt <= time()
      || asset.expiresAt > time() + (kind === 'input' ? sourceRetentionMs : resultRetentionMs)
      || (kind === 'output' && (!identifier(jobId, 80) || asset.labelVersion !== labelVersion))) throw fail('PHOTO_CONTEXT_INVALID_ASSET');
    return tx(async query => {
      const account = await lock(query, userId);
      if (!consentReady(account)) throw fail('PHOTO_JOB_NOT_AUTHORIZED');
      if (kind === 'output') {
        const job = (await query('SELECT * FROM mini_photo_jobs WHERE id = ? AND user_id = ?', [jobId, userId]))[0];
        // An uncertain first attempt may finish from its durable receipt. It
        // retains the original claim and must pass current rights/consent checks.
        if (!job || !['claimed', 'unknown'].includes(job.state) || job.attempt !== 1 || !job.claim_token
          || !await authorize({ query, job: { ...job, spec: JSON.parse(job.spec) }, phase: 'dispatch' })) throw fail('PHOTO_JOB_NOT_AUTHORIZED');
      }
      const previous = await assetById(query, asset.id);
      if (previous) {
        if (previous.user_id !== userId || previous.kind !== kind || previous.storage_key !== asset.storageKey || previous.sha256 !== asset.sha256
          || Number(previous.byte_length) !== asset.byteLength || previous.content_type !== asset.contentType || Number(previous.expires_at) !== asset.expiresAt
          || previous.moderation_reference !== asset.moderationReference || previous.job_id !== (jobId || null)
          || previous.label_version !== (kind === 'output' ? asset.labelVersion : null) || !activeAsset(previous, account)) throw fail('PHOTO_CONTEXT_ASSET_CONFLICT');
        return ownedAsset(previous);
      }
      const timestamp = time();
      if (asset.expiresAt <= timestamp) throw fail('PHOTO_CONTEXT_INVALID_ASSET');
      await query(`INSERT INTO mini_photo_assets (id,user_id,kind,state,storage_key,sha256,byte_length,content_type,consent_epoch,
        job_id,moderation_reference,label_version,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [asset.id, userId, kind, kind === 'input' ? 'ready' : 'staged', asset.storageKey, asset.sha256, asset.byteLength, asset.contentType,
        account.consent_epoch, jobId || null, asset.moderationReference, kind === 'output' ? asset.labelVersion : null, asset.expiresAt, timestamp]);
      return { assetId: asset.id, kind: 'image', createdAt: timestamp, expiresAt: asset.expiresAt, contentType: asset.contentType };
    });
  };
  return {
    database, ports, repository,
    async grantBasicConsent(userId, version) {
      if (version !== basicVersion) throw fail('STALE_CONSENT_VERSION');
      return tx(async query => { const account = await ensure(query, userId); if (account.enabled !== 1) throw fail('PHOTO_JOB_NOT_AUTHORIZED');
        await query('UPDATE mini_photo_accounts SET basic_version = ?,updated_at = ? WHERE user_id = ?', [basicVersion, time(), userId]);
        await audit(query, userId, 'photo.consent.basic_granted', basicVersion); return true; });
    },
    async grantFaceConsent(userId, { version, subjectAuthorization } = {}) {
      if (version !== faceVersion || !['self', 'authorized'].includes(subjectAuthorization)) throw fail('STALE_CONSENT_VERSION');
      return tx(async query => { const account = await lock(query, userId);
        if (account?.enabled !== 1 || account.basic_version !== basicVersion) throw fail('PHOTO_JOB_NOT_AUTHORIZED');
        await query('UPDATE mini_photo_accounts SET face_version = ?,subject_authorization = ?,updated_at = ? WHERE user_id = ?', [faceVersion, subjectAuthorization, time(), userId]);
        await audit(query, userId, 'photo.consent.face_granted', faceVersion, { subjectAuthorization }); return true; });
    },
    async readConsents(userId) {
      return tx(async query => { const account = await lock(query, userId); return { current: { basic: basicVersion, face_processing: faceVersion },
        basicGranted: account?.enabled === 1 && account.basic_version === basicVersion, faceGranted: consentReady(account) }; });
    },
    async withdrawFaceConsent(userId) {
      return tx(async query => { await lock(query, userId);
        await query('UPDATE mini_photo_accounts SET face_version = NULL,subject_authorization = NULL,consent_epoch = consent_epoch + 1,updated_at = ? WHERE user_id = ?', [time(), userId]);
        await query("UPDATE mini_photo_assets SET state = 'revoked' WHERE user_id = ? AND state NOT IN ('deleted','revoked')", [userId]);
        await audit(query, userId, 'photo.consent.face_withdrawn', faceVersion); return true; });
    },
    async withdrawBasicConsent(userId) {
      // Withdrawal ends both processing permissions but is not account deletion.
      // A later explicit grant may start a new epoch; old photos stay revoked.
      return tx(async query => { await lock(query, userId);
        await query('UPDATE mini_photo_accounts SET basic_version = NULL,face_version = NULL,subject_authorization = NULL,consent_epoch = consent_epoch + 1,updated_at = ? WHERE user_id = ?', [time(), userId]);
        await query("UPDATE mini_photo_assets SET state = 'revoked' WHERE user_id = ? AND state NOT IN ('deleted','revoked')", [userId]);
        await audit(query, userId, 'photo.consent.basic_withdrawn', basicVersion); return true; });
    },
    async disableAccount(userId) {
      return tx(async query => { await ensure(query, userId);
        await query('UPDATE mini_photo_accounts SET enabled = 0,basic_version = NULL,face_version = NULL,subject_authorization = NULL,consent_epoch = consent_epoch + 1,updated_at = ? WHERE user_id = ?', [time(), userId]);
        await query("UPDATE mini_photo_assets SET state = 'revoked' WHERE user_id = ? AND state NOT IN ('deleted','revoked')", [userId]);
        await audit(query, userId, 'photo.account.disabled', userId); return true; });
    },
    async putEffect(input) {
      const effect = { id: input?.id, version: input?.version, provider: input?.provider, model: input?.model, purpose: input?.purpose,
        parameters: encoded(input?.parameters ?? {}), enabled: input?.enabled, reviewReference: input?.reviewReference };
      if (![effect.id, effect.version].every(value => identifier(value, 80)) || !providerIdentifier(effect.provider, 80) || !providerIdentifier(effect.model, 100)
        || !identifier(effect.purpose, 100) || effect.purpose !== `photo-effect:${effect.id}`
        || typeof effect.enabled !== 'boolean' || !identifier(effect.reviewReference)) throw fail('PHOTO_CONTEXT_INVALID_EFFECT');
      return tx(async query => {
        const previous = (await query('SELECT * FROM mini_photo_effects WHERE effect_id = ? AND version = ?', [effect.id, effect.version]))[0];
        if (previous && (previous.provider !== effect.provider || previous.model !== effect.model || previous.purpose !== effect.purpose
          || previous.parameters !== effect.parameters || previous.review_reference !== effect.reviewReference)) throw fail('PHOTO_CONTEXT_EFFECT_VERSION_IMMUTABLE');
        if (effect.enabled) await query('UPDATE mini_photo_effects SET enabled = 0 WHERE effect_id = ?', [effect.id]);
        if (previous) await query('UPDATE mini_photo_effects SET enabled = ? WHERE effect_id = ? AND version = ?', [Number(effect.enabled), effect.id, effect.version]);
        else await query('INSERT INTO mini_photo_effects(effect_id,version,provider,model,purpose,parameters,enabled,review_reference,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
          [effect.id, effect.version, effect.provider, effect.model, effect.purpose, effect.parameters, Number(effect.enabled), effect.reviewReference, time()]);
        return true;
      });
    },
    async submission({ userId, idempotencyKey, inputAssetId, effectId }) {
      if (!identifier(idempotencyKey) || idempotencyKey.length < 8 || !identifier(inputAssetId) || !identifier(effectId, 80)) throw fail('PHOTO_JOB_INVALID_SPEC');
      return tx(async query => {
        await lock(query, userId);
        // Reopening an accepted request recovers its frozen contract even after
        // publication/configuration/consent has changed. It cannot reserve or
        // generate again, and changing input/effect under the key is forbidden.
        const previous = (await query('SELECT spec FROM mini_photo_jobs WHERE user_id = ? AND idem = ?', [userId, idempotencyKey]))[0];
        if (previous) {
          const frozen = JSON.parse(previous.spec);
          if (frozen.inputAssetId !== inputAssetId || frozen.effectId !== effectId) throw fail('PHOTO_JOB_IDEMPOTENCY_CONFLICT');
          return { userId, idempotencyKey, ...frozen };
        }
        const effect = (await query('SELECT * FROM mini_photo_effects WHERE effect_id = ? AND enabled = 1', [effectId]))[0];
        if (!effect) throw fail('EFFECT_DISABLED');
        return { userId, idempotencyKey, inputAssetId, effectId, effectVersion: effect.version, provider: effect.provider, model: effect.model,
          purpose: effect.purpose, effectParameters: JSON.parse(effect.parameters), billingRef: digest(`photo\n${userId}\n${idempotencyKey}`) };
      });
    },
    registerInput: (userId, asset) => register(userId, 'input', asset),
    registerOutput: (userId, jobId, asset) => register(userId, 'output', asset, jobId),
    async readOwnedAsset(userId, assetId) {
      return tx(async query => { const account = await lock(query, userId); const asset = await assetById(query, assetId);
        if (!consentReady(account) || !activeAsset(asset, account) || !['ready', 'published'].includes(asset.state)) return null;
        // Internal return: only the route may exchange storageKey for a short-lived private URL.
        return { ...ownedAsset(asset), assetKind: asset.kind, byteLength: Number(asset.byte_length),
          storageKey: asset.storage_key, sha256: asset.sha256 }; });
    },
    async listWorks(userId) {
      return tx(async query => { const account = await lock(query, userId); if (!consentReady(account)) return [];
        const rows = await query("SELECT a.* FROM mini_photo_works w JOIN mini_photo_assets a ON a.id = w.asset_id WHERE w.user_id = ? AND a.state = 'published' ORDER BY w.created_at DESC", [userId]);
        return rows.filter(asset => activeAsset(asset, account)).map(ownedAsset); });
    },
    async deleteAsset(userId, assetId) {
      return tx(async query => { await lock(query, userId); const asset = await assetById(query, assetId);
        if (!asset || asset.user_id !== userId) return null;
        await query("UPDATE mini_photo_assets SET state = 'deleted' WHERE id = ? AND user_id = ?", [assetId, userId]);
        await audit(query, userId, 'photo.asset.deleted', assetId);
        return { assetId, storageKey: asset.storage_key }; });
    },
  };
}
