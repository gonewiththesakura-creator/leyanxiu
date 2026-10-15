import { createHash, randomUUID } from 'node:crypto';

const fail = code => Object.assign(new Error(code), { code });
const identifier = (value, max = 128) => typeof value === 'string'
  && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value);
const providerIdentifier = (value, max) => typeof value === 'string'
  && value.length <= max && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
const changed = result => Number(result?.affectedRows ?? result?.changes ?? 0);
const hash = value => createHash('sha256').update(value).digest('hex');
const publicJob = row => row ? ({ id: row.id, state: row.state, createdAt: Number(row.created_at),
  updatedAt: Number(row.updated_at), ...(row.state === 'succeeded' ? { assetId: row.output_asset_id } : {}) }) : null;

function canonical(value, depth = 0) {
  if (depth > 8) throw fail('PHOTO_JOB_INVALID_SPEC');
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonical(item, depth + 1)).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key], depth + 1)}`).join(',')}}`;
  }
  throw fail('PHOTO_JOB_INVALID_SPEC');
}

// Only server-approved values enter this boundary. No provider URL, key or bearer token belongs here.
function normalize(input) {
  if (!input || !identifier(input.userId, 80) || !identifier(input.idempotencyKey)
    || input.idempotencyKey.length < 8 || !identifier(input.inputAssetId)
    || !identifier(input.effectId, 80) || !identifier(input.effectVersion, 80)
    || !identifier(input.purpose, 100) || !identifier(input.billingRef)
    || !providerIdentifier(input.provider, 80) || !providerIdentifier(input.model, 100)) throw fail('PHOTO_JOB_INVALID_SPEC');
  const spec = { inputAssetId: input.inputAssetId, effectId: input.effectId, effectVersion: input.effectVersion,
    purpose: input.purpose, billingRef: input.billingRef, provider: input.provider, model: input.model,
    effectParameters: input.effectParameters ?? {} };
  const encoded = canonical(spec);
  if (Buffer.byteLength(encoded) > 8192) throw fail('PHOTO_JOB_INVALID_SPEC');
  return { userId: input.userId, idempotencyKey: input.idempotencyKey, spec: JSON.parse(encoded), encoded, digest: hash(encoded) };
}

export function photoJobsSchema(dialect) {
  if (!['mysql', 'sqlite'].includes(dialect)) throw fail('PHOTO_JOB_DATABASE_REQUIRED');
  const suffix = dialect === 'mysql' ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' : '';
  return `CREATE TABLE IF NOT EXISTS mini_photo_jobs (
    id VARCHAR(80) PRIMARY KEY, user_id VARCHAR(80) NOT NULL, idem VARCHAR(128) NOT NULL,
    spec ${dialect === 'mysql' ? 'LONGTEXT' : 'TEXT'} NOT NULL, spec_hash CHAR(64) NOT NULL,
    billing_ref VARCHAR(128) NOT NULL, state VARCHAR(24) NOT NULL,
    claim_token VARCHAR(80), claimed_at BIGINT, attempt INTEGER NOT NULL DEFAULT 0,
    output_asset_id VARCHAR(128), provider_ref VARCHAR(128), failure_code VARCHAR(64),
    created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
    UNIQUE(user_id, idem), UNIQUE(user_id, billing_ref),
    FOREIGN KEY(user_id) REFERENCES vp_accounts(user_id),
    CHECK(attempt IN (0,1)),
    CHECK(state IN ('queued','claimed','result_ready','succeeded','cancelled','blocked','unknown')),
    CHECK(state NOT IN ('result_ready','succeeded') OR output_asset_id IS NOT NULL)
  )${suffix}`;
}

/**
 * All ports below MUST use only the provided query, on this same database transaction.
 * Never invoke a provider/HTTP request or nested database.transaction() inside a port:
 * the existing adapter can retry a definitively rolled-back MySQL deadlock.
 * authorize rechecks account, consent, input ownership/expiry and the frozen effect version.
 * reserve/settle implement idempotent billing; publish exposes a previously private staged asset.
 */
export function createPhotoJobRepository({ database, authorize, reserve, settle, publish, now = Date.now }) {
  if (!database?.transaction || ![authorize, reserve, settle, publish].every(fn => typeof fn === 'function')) {
    throw fail('PHOTO_JOB_TRANSACTION_PORTS_REQUIRED');
  }
  const transaction = database.transaction.bind(database);
  const time = () => { const value = now(); if (!Number.isSafeInteger(value) || value < 0) throw fail('PHOTO_JOB_INVALID_TIME'); return value; };
  const internal = row => row && ({ ...row, spec: JSON.parse(row.spec) });
  const byId = async (query, id) => (await query('SELECT * FROM mini_photo_jobs WHERE id = ?', [id]))[0];
  const validateWorker = (row, token, state = 'claimed') => {
    if (!row || row.state !== state || !token || row.claim_token !== token) throw fail('PHOTO_JOB_CLAIM_CONFLICT');
  };
  return {
    async submit(input) {
      const value = normalize(input);
      return transaction(async query => {
        const previous = (await query('SELECT * FROM mini_photo_jobs WHERE user_id = ? AND idem = ?',
          [value.userId, value.idempotencyKey]))[0];
        if (previous) {
          if (previous.spec_hash !== value.digest || previous.spec !== value.encoded) throw fail('PHOTO_JOB_IDEMPOTENCY_CONFLICT');
          return { job: publicJob(previous), duplicate: true };
        }
        const timestamp = time();
        const job = { id: `photo_${randomUUID()}`, user_id: value.userId, spec: value.spec,
          billing_ref: value.spec.billingRef, state: 'queued', created_at: timestamp, updated_at: timestamp };
        if (await authorize({ query, job, phase: 'submit' }) !== true) throw fail('PHOTO_JOB_NOT_AUTHORIZED');
        if (await reserve({ query, job }) !== true) throw fail('PHOTO_JOB_ENTITLEMENT_REQUIRED');
        await query(`INSERT INTO mini_photo_jobs
          (id,user_id,idem,spec,spec_hash,billing_ref,state,attempt,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?,0,?,?)`, [job.id, job.user_id, value.idempotencyKey, value.encoded,
          value.digest, job.billing_ref, job.state, timestamp, timestamp]);
        return { job: publicJob(job), duplicate: false };
      });
    },
    async readOwned(userId, id) {
      if (!identifier(userId, 80) || !identifier(id, 80)) return null;
      return transaction(async query => publicJob((await query(
        'SELECT * FROM mini_photo_jobs WHERE id = ? AND user_id = ?', [id, userId]))[0]));
    },
    async findOwnedByKey(userId, idempotencyKey) {
      if (!identifier(userId, 80) || !identifier(idempotencyKey)) return null;
      return transaction(async query => publicJob((await query(
        'SELECT * FROM mini_photo_jobs WHERE user_id = ? AND idem = ?', [userId, idempotencyKey]))[0]));
    },
    async claimNext() {
      return transaction(async query => {
        const row = (await query("SELECT * FROM mini_photo_jobs WHERE state = 'queued' ORDER BY created_at,id LIMIT 1"))[0];
        if (!row) return null;
        const job = internal(row);
        const timestamp = time();
        if (await authorize({ query, job, phase: 'dispatch' }) !== true) {
          if (await settle({ query, job, outcome: 'not_started' }) !== true) throw fail('PHOTO_JOB_SETTLEMENT_UNCONFIRMED');
          await query("UPDATE mini_photo_jobs SET state = 'cancelled', updated_at = ? WHERE id = ? AND state = 'queued'", [timestamp, row.id]);
          return { cancelled: true, id: row.id };
        }
        const token = randomUUID();
        const result = await query(`UPDATE mini_photo_jobs SET state = 'claimed', claim_token = ?, claimed_at = ?,
          attempt = 1, updated_at = ? WHERE id = ? AND state = 'queued' AND attempt = 0`, [token, timestamp, timestamp, row.id]);
        if (changed(result) !== 1) return null;
        return { ...job, state: 'claimed', claim_token: token, claimed_at: timestamp, attempt: 1 };
      });
    },
    async recordResult(id, token, result) {
      // Snapshot once before validation or any await. Provider adapters may
      // reuse/mutate their result object while this transaction waits for DB.
      const assetId = result?.assetId;
      const providerRef = result?.providerRef ?? null;
      if (!identifier(assetId) || (providerRef !== null && !identifier(providerRef))) {
        throw fail('PHOTO_JOB_INVALID_RESULT');
      }
      return transaction(async query => {
        const row = await byId(query, id); validateWorker(row, token);
        await query(`UPDATE mini_photo_jobs SET state = 'result_ready', output_asset_id = ?, provider_ref = ?,
          updated_at = ? WHERE id = ? AND state = 'claimed' AND claim_token = ?`,
        [assetId, providerRef, time(), id, token]);
      });
    },
    async recordUnknown(id, token) {
      return transaction(async query => {
        const row = await byId(query, id);
        // A lost recordResult response may already have committed result_ready. Never erase that receipt.
        if (row?.claim_token === token && ['result_ready', 'succeeded', 'blocked', 'unknown'].includes(row.state)) return row.state;
        validateWorker(row, token);
        await query("UPDATE mini_photo_jobs SET state = 'unknown', failure_code = 'PROVIDER_OUTCOME_UNKNOWN', updated_at = ? WHERE id = ? AND state = 'claimed' AND claim_token = ?",
          [time(), id, token]);
        return 'unknown';
      });
    },
    async publishNext() {
      return transaction(async query => {
        const row = (await query("SELECT * FROM mini_photo_jobs WHERE state = 'result_ready' ORDER BY created_at,id LIMIT 1"))[0];
        if (!row) return null;
        const job = internal(row);
        if (await authorize({ query, job, phase: 'publish' }) !== true) {
          await query("UPDATE mini_photo_jobs SET state = 'blocked', failure_code = 'PUBLICATION_NOT_AUTHORIZED', updated_at = ? WHERE id = ? AND state = 'result_ready'",
            [time(), row.id]);
          return { id: row.id, state: 'blocked' };
        }
        if (await publish({ query, job, assetId: row.output_asset_id }) !== true) throw fail('PHOTO_JOB_PUBLICATION_UNCONFIRMED');
        if (await settle({ query, job, outcome: 'succeeded' }) !== true) throw fail('PHOTO_JOB_SETTLEMENT_UNCONFIRMED');
        await query("UPDATE mini_photo_jobs SET state = 'succeeded', updated_at = ? WHERE id = ? AND state = 'result_ready'", [time(), row.id]);
        return { id: row.id, state: 'succeeded' };
      });
    },
    async counts() {
      return transaction(async query => Object.fromEntries((await query(
        'SELECT state,COUNT(*) AS count FROM mini_photo_jobs GROUP BY state')).map(row => [row.state, Number(row.count)])));
    },
  };
}
