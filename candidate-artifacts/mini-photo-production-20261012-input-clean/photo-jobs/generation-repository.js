import { randomBytes } from 'node:crypto';
import { checkedQwenPhotoResultUrl, QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_RESULT_POLICY } from './qwen-provider.js';

const fail = code => Object.assign(new Error(code), { code });
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const steps = new Set(['input_read', 'generate', 'result_read', 'mark', 'output_put', 'output_read', 'moderate', 'register']);
const repeatable = new Set(['input_read', 'result_read', 'mark', 'output_read', 'register']);

export function photoGenerationSchema(dialect) {
  if (!['mysql', 'sqlite'].includes(dialect)) throw fail('PHOTO_GENERATION_DATABASE_REQUIRED');
  const text = dialect === 'mysql' ? 'LONGTEXT' : 'TEXT';
  const suffix = dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' : '';
  return [
    `CREATE TABLE IF NOT EXISTS mini_photo_generation (
      job_id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, spec_hash CHAR(64) NOT NULL,
      policy ${text} NOT NULL, asset_id VARCHAR(128) NOT NULL UNIQUE, output_key VARCHAR(512) NOT NULL UNIQUE,
      marked_sha256 CHAR(64), marked_length BIGINT, marked_type VARCHAR(32), provider_receipt ${text}, review_receipt ${text},
      moderation_reference CHAR(32) UNIQUE, moderation_extension VARCHAR(4), moderation_cleanup_pending INTEGER NOT NULL DEFAULT 0,
      output_cleanup_pending INTEGER NOT NULL DEFAULT 1, registered INTEGER NOT NULL DEFAULT 0,
      expires_at BIGINT NOT NULL, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      FOREIGN KEY(job_id) REFERENCES mini_photo_jobs(id), FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
      CHECK(registered IN (0,1)), CHECK(output_cleanup_pending IN (0,1)), CHECK(moderation_cleanup_pending IN (0,1)))`,
    `CREATE TABLE IF NOT EXISTS mini_photo_generation_operations (
      job_id VARCHAR(80) NOT NULL, step VARCHAR(24) NOT NULL, state VARCHAR(16) NOT NULL,
      token CHAR(32) NOT NULL, attempts INTEGER NOT NULL, started_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      PRIMARY KEY(job_id,step), FOREIGN KEY(job_id) REFERENCES mini_photo_generation(job_id),
      CHECK(state IN ('started','succeeded','unknown')), CHECK(attempts > 0))`,
    `CREATE TABLE IF NOT EXISTS mini_photo_generation_cleanup (
      job_id VARCHAR(80) NOT NULL, kind VARCHAR(16) NOT NULL, storage_key VARCHAR(512) NOT NULL UNIQUE,
      state VARCHAR(24) NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, operation_token CHAR(32),
      delete_status VARCHAR(16) NOT NULL DEFAULT 'not_started', observation VARCHAR(16) NOT NULL DEFAULT 'not_checked',
      next_at BIGINT NOT NULL, checked_at BIGINT, absent_observations INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
      PRIMARY KEY(job_id,kind), FOREIGN KEY(job_id) REFERENCES mini_photo_generation(job_id),
      CHECK(kind IN ('output','moderation')), CHECK(state IN ('pending','observing','absent_observed','present','unknown')),
      CHECK(delete_status IN ('not_started','unknown','acknowledged')), CHECK(observation IN ('not_checked','unknown','absent','present')),
      CHECK(attempts >= 0), CHECK(absent_observations >= 0))`,
  ].map(sql => sql + suffix);
}

export function createPhotoGenerationRepository({ context, policy, now = Date.now }) {
  const database = context?.database;
  if (!database?.transaction || typeof context?.ports?.authorize !== 'function') throw fail('PHOTO_GENERATION_CONTEXT_REQUIRED');
  const config = { labelVersion: policy?.labelVersion, moderationVersion: policy?.moderationVersion,
    moderationService: policy?.moderationService, operation: policy?.operation, provider: policy?.provider,
    model: policy?.model, sourceHosts: [...(policy?.sourceHosts || [])], resultRetentionMs: policy?.resultRetentionMs };
  // Absent means the original exact-host contract, including its persisted
  // canonical policy bytes. Never silently widen an existing/unknown job.
  if (policy?.resultUrlPolicy !== undefined) config.resultUrlPolicy = policy.resultUrlPolicy;
  if (![config.labelVersion, config.moderationVersion, config.provider, config.model].every(identifier)
    || !['baselineCheck', 'aigcCheck'].includes(config.moderationService) || !['generate', 'edit'].includes(config.operation)
    || !config.sourceHosts.length || !config.sourceHosts.every(host => typeof host === 'string' && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(host) && host.includes('.') && !host.includes('..') && !/^\d+(?:\.\d+){3}$/.test(host))
    || (config.resultUrlPolicy !== undefined && (config.resultUrlPolicy !== QWEN_PHOTO_RESULT_POLICY
      || config.provider !== QWEN_PHOTO_PROVIDER || config.model !== QWEN_PHOTO_MODEL))
    || !Number.isSafeInteger(config.resultRetentionMs) || config.resultRetentionMs < 1 || config.resultRetentionMs > 30 * 86400000) throw fail('PHOTO_GENERATION_POLICY_REQUIRED');
  const encodedPolicy = canonical(config);
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw fail('PHOTO_GENERATION_TIME_INVALID'); return value; };
  const tx = callback => database.transaction(callback);
  const get = async (q, jobId) => (await q('SELECT * FROM mini_photo_generation WHERE job_id = ?', [jobId]))[0];
  async function locked(q, jobId, userId) {
    await q(`SELECT user_id FROM vp_accounts WHERE user_id = ?${database.backend === 'mysql' ? ' FOR UPDATE' : ''}`, [userId]);
    const row = (await q('SELECT * FROM mini_photo_jobs WHERE id = ? AND user_id = ?', [jobId, userId]))[0];
    if (!row || !['claimed', 'unknown', 'result_ready', 'succeeded'].includes(row.state) || row.attempt !== 1 || !row.claim_token) throw fail('PHOTO_GENERATION_JOB_REQUIRED');
    return { ...row, spec: JSON.parse(row.spec) };
  }
  async function authorized(q, job) {
    if (!['claimed', 'unknown'].includes(job.state) || await context.ports.authorize({ query: q, job, phase: 'dispatch' }) !== true) throw fail('PHOTO_GENERATION_NOT_AUTHORIZED');
  }
  const typedReceipt = input => {
    const receipt = { providerRef: input?.requestId, resultUrl: input?.url, provider: input?.provider, model: input?.model };
    if (receipt.provider !== config.provider || receipt.model !== config.model || !identifier(receipt.providerRef)) throw fail('PHOTO_GENERATION_RECEIPT_INVALID');
    try {
      if (config.resultUrlPolicy === QWEN_PHOTO_RESULT_POLICY) {
        // This is a private receipt from the fixed provider/model, not a user
        // URL. Reuse the provider's syntax policy; no second hostname regex.
        checkedQwenPhotoResultUrl(receipt.resultUrl);
      } else {
        const url = new URL(receipt.resultUrl);
        if (typeof receipt.resultUrl !== 'string' || receipt.resultUrl.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(receipt.resultUrl)
          || url.protocol !== 'https:' || url.username || url.password || url.hash || url.port || !config.sourceHosts.includes(url.hostname)) throw fail('PHOTO_GENERATION_RECEIPT_INVALID');
      }
    } catch { throw fail('PHOTO_GENERATION_RECEIPT_INVALID'); }
    return receipt;
  };
  const read = row => {
    if (!row) return row;
    if (row.policy !== encodedPolicy) throw fail('PHOTO_GENERATION_POLICY_CONFLICT');
    let providerReceipt = null;
    if (row.provider_receipt) {
      let saved; try { saved = JSON.parse(row.provider_receipt); } catch { throw fail('PHOTO_GENERATION_RECEIPT_INVALID'); }
      providerReceipt = typedReceipt({ requestId: saved?.providerRef, url: saved?.resultUrl, provider: saved?.provider, model: saved?.model });
    }
    return { ...row, policy: JSON.parse(row.policy), providerReceipt,
      reviewReceipt: row.review_receipt ? JSON.parse(row.review_receipt) : null };
  };
  return {
    database,
    async open({ jobId, userId, spec }) {
      if (!identifier(jobId) || !identifier(userId) || !spec || typeof spec !== 'object') throw fail('PHOTO_GENERATION_REQUEST_INVALID');
      const supplied = canonical(spec);
      return tx(async q => {
        const job = await locked(q, jobId, userId);
        if (canonical(job.spec) !== supplied || job.spec.provider !== config.provider || job.spec.model !== config.model) throw fail('PHOTO_GENERATION_SPEC_CONFLICT');
        const existing = await get(q, jobId);
        if (existing) {
          if (existing.policy !== encodedPolicy || existing.spec_hash !== job.spec_hash) throw fail('PHOTO_GENERATION_POLICY_CONFLICT');
          return { ...read(existing), spec: job.spec, jobState: job.state };
        }
        await authorized(q, job);
        const token = randomBytes(16).toString('hex'); const stamp = time();
        await q(`INSERT INTO mini_photo_generation(job_id,user_id,spec_hash,policy,asset_id,output_key,expires_at,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,?,?)`, [jobId, userId, job.spec_hash, encodedPolicy, `output_${token}`, `private/photo-outputs/${token}.png`,
          stamp + config.resultRetentionMs, stamp, stamp]);
        return { ...read(await get(q, jobId)), spec: job.spec, jobState: job.state };
      });
    },
    read: (jobId, userId) => tx(async q => { await locked(q, jobId, userId); return read(await get(q, jobId)); }),
    async begin(jobId, userId, step) {
      if (!steps.has(step)) throw fail('PHOTO_GENERATION_STEP_INVALID');
      return tx(async q => {
        const job = await locked(q, jobId, userId); const generation = await get(q, jobId);
        if (!generation || generation.expires_at <= time() || generation.policy !== encodedPolicy) throw fail('PHOTO_GENERATION_NOT_AUTHORIZED');
        await authorized(q, job);
        const previous = (await q('SELECT * FROM mini_photo_generation_operations WHERE job_id = ? AND step = ?', [jobId, step]))[0];
        if (previous && !repeatable.has(step)) return { dispatch: false, state: previous.state };
        const token = randomBytes(16).toString('hex');
        if (previous) await q("UPDATE mini_photo_generation_operations SET state = 'started',token = ?,attempts = attempts + 1,started_at = ?,updated_at = ? WHERE job_id = ? AND step = ?", [token, time(), time(), jobId, step]);
        else await q("INSERT INTO mini_photo_generation_operations(job_id,step,state,token,attempts,started_at,updated_at) VALUES (?,?,'started',?,1,?,?)", [jobId, step, token, time(), time()]);
        return { dispatch: true, token };
      });
    },
    async complete(jobId, userId, step, token, outcome = 'succeeded') {
      if (!steps.has(step) || !/^[a-f0-9]{32}$/.test(token || '') || !['succeeded', 'unknown'].includes(outcome)) throw fail('PHOTO_GENERATION_STEP_INVALID');
      return tx(async q => { await locked(q, jobId, userId);
        const result = await q("UPDATE mini_photo_generation_operations SET state = ?,updated_at = ? WHERE job_id = ? AND step = ? AND token = ? AND state = 'started'", [outcome, time(), jobId, step, token]);
        return Number(result.changes ?? result.affectedRows) === 1;
      });
    },
    async saveProviderReceipt(jobId, userId, token, input) {
      const receipt = typedReceipt(input);
      return tx(async q => {
        await locked(q, jobId, userId);
        const operation = (await q("SELECT * FROM mini_photo_generation_operations WHERE job_id = ? AND step = 'generate'", [jobId]))[0];
        if (operation?.token !== token || operation.state !== 'started') throw fail('PHOTO_GENERATION_OPERATION_CONFLICT');
        await q('UPDATE mini_photo_generation SET provider_receipt = ?,updated_at = ? WHERE job_id = ?', [JSON.stringify(receipt), time(), jobId]);
        await q("UPDATE mini_photo_generation_operations SET state = 'succeeded',updated_at = ? WHERE job_id = ? AND step = 'generate'", [time(), jobId]);
      });
    },
    async freezeMarked(jobId, userId, input) {
      const evidence = { sha256: input?.sha256, byteLength: input?.byteLength, contentType: input?.contentType,
        labelVersion: input?.labelVersion, contentId: input?.contentId, operation: input?.operation, verified: input?.verified };
      if (!/^[a-f0-9]{64}$/.test(evidence.sha256 || '') || !Number.isSafeInteger(evidence.byteLength) || evidence.byteLength < 16
        || evidence.byteLength > 20 * 1024 * 1024 || evidence.contentType !== 'image/png' || evidence.labelVersion !== config.labelVersion
        || evidence.contentId !== jobId || evidence.operation !== config.operation || evidence.verified !== true) throw fail('PHOTO_GENERATION_MARK_INVALID');
      return tx(async q => {
        const job = await locked(q, jobId, userId); await authorized(q, job); const row = await get(q, jobId);
        if (row.marked_sha256 && (row.marked_sha256 !== evidence.sha256 || row.marked_length !== evidence.byteLength || row.marked_type !== evidence.contentType)) throw fail('PHOTO_GENERATION_MARK_CONFLICT');
        await q('UPDATE mini_photo_generation SET marked_sha256 = ?,marked_length = ?,marked_type = ?,updated_at = ? WHERE job_id = ?', [evidence.sha256, evidence.byteLength, evidence.contentType, time(), jobId]);
      });
    },
    async journalModeration(jobId, userId, intent) {
      const reference = intent?.reference; const extension = intent?.extension;
      if (!/^[a-f0-9]{32}$/.test(reference || '') || extension !== 'png') throw fail('PHOTO_GENERATION_MODERATION_INVALID');
      return tx(async q => {
        const job = await locked(q, jobId, userId); await authorized(q, job); const row = await get(q, jobId);
        const operation = (await q("SELECT state FROM mini_photo_generation_operations WHERE job_id = ? AND step = 'moderate'", [jobId]))[0];
        if (!row.marked_sha256 || row.moderation_reference || operation?.state !== 'started') throw fail('PHOTO_GENERATION_MODERATION_CONFLICT');
        await q('UPDATE mini_photo_generation SET moderation_reference = ?,moderation_extension = ?,moderation_cleanup_pending = 1,updated_at = ? WHERE job_id = ?', [reference, extension, time(), jobId]);
        return true;
      });
    },
    async saveReview(jobId, userId, token, input) {
      const receipt = { provider: input?.provider, policyVersion: input?.policyVersion, service: input?.service, direction: input?.direction,
        sha256: input?.sha256, byteLength: input?.byteLength, decision: input?.decision, reference: input?.reference, requestId: input?.requestId,
        cleanupReference: input?.cleanupReference, cleanupExtension: input?.cleanupExtension, cleanupPending: input?.cleanupPending };
      return tx(async q => {
        await locked(q, jobId, userId); const row = await get(q, jobId);
        const operation = (await q("SELECT * FROM mini_photo_generation_operations WHERE job_id = ? AND step = 'moderate'", [jobId]))[0];
        if (operation?.token !== token || operation.state !== 'started') throw fail('PHOTO_GENERATION_OPERATION_CONFLICT');
        const valid = receipt.provider === 'aliyun-green' && receipt.policyVersion === config.moderationVersion
          && receipt.service === config.moderationService && receipt.direction === 'output' && receipt.sha256 === row.marked_sha256
          && receipt.byteLength === row.marked_length && ['allow', 'block', 'review'].includes(receipt.decision)
          && /^mod_[a-f0-9]{64}$/.test(receipt.reference || '') && identifier(receipt.requestId)
          && receipt.cleanupReference === row.moderation_reference && receipt.cleanupExtension === row.moderation_extension;
        if (!valid) throw fail('PHOTO_GENERATION_REVIEW_UNCONFIRMED');
        await q('UPDATE mini_photo_generation SET review_receipt = ?,updated_at = ? WHERE job_id = ?', [JSON.stringify(receipt), time(), jobId]);
        await q("UPDATE mini_photo_generation_operations SET state = 'succeeded',updated_at = ? WHERE job_id = ? AND step = 'moderate'", [time(), jobId]);
      });
    },
    async registered(jobId, userId) {
      return tx(async q => { const job = await locked(q, jobId, userId); await authorized(q, job); const row = await get(q, jobId);
        const asset = (await q('SELECT * FROM mini_photo_assets WHERE id = ? AND user_id = ? AND job_id = ?', [row.asset_id, userId, jobId]))[0];
        if (!asset || asset.state !== 'staged' || asset.sha256 !== row.marked_sha256 || asset.storage_key !== row.output_key
          || asset.label_version !== config.labelVersion) throw fail('PHOTO_GENERATION_REGISTRATION_UNCONFIRMED');
        await q('UPDATE mini_photo_generation SET registered = 1,output_cleanup_pending = 0,updated_at = ? WHERE job_id = ?', [time(), jobId]);
        return { assetId: row.asset_id, providerRef: JSON.parse(row.provider_receipt).providerRef };
      });
    },
    async recordRecoveredResult(jobId, userId) {
      return tx(async q => {
        const job = await locked(q, jobId, userId); const row = await get(q, jobId);
        if (!row?.registered || !row.review_receipt || JSON.parse(row.review_receipt).decision !== 'allow') throw fail('PHOTO_GENERATION_RECOVERY_NOT_READY');
        if (['result_ready', 'succeeded'].includes(job.state)) return { assetId: row.asset_id, state: job.state };
        const output = (await q('SELECT * FROM mini_photo_assets WHERE id = ? AND user_id = ? AND job_id = ?', [row.asset_id, userId, jobId]))[0];
        if (!output || output.storage_key !== row.output_key || output.sha256 !== row.marked_sha256
          || await context.ports.authorize({ query: q, job: { ...job, output_asset_id: row.asset_id }, phase: 'publish' }) !== true) throw fail('PHOTO_GENERATION_NOT_AUTHORIZED');
        // No redispatch and no lease reset. Only a complete, already registered
        // private output can move the original claim to DB-only publication.
        await q("UPDATE mini_photo_jobs SET state = 'result_ready',output_asset_id = ?,provider_ref = ?,updated_at = ? WHERE id = ? AND claim_token = ? AND state IN ('claimed','unknown')",
          [row.asset_id, JSON.parse(row.provider_receipt).providerRef, time(), jobId, job.claim_token]);
        return { assetId: row.asset_id, state: 'result_ready' };
      });
    },
    async operations(jobId, userId) { return tx(async q => { await locked(q, jobId, userId); return q('SELECT step,state,attempts FROM mini_photo_generation_operations WHERE job_id = ? ORDER BY step', [jobId]); }); },
  };
}
