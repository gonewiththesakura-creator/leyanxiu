import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createPhotoJobRepository, photoJobsSchema } from '../photo-jobs/repository.js';
import { createPhotoJobWorker } from '../photo-jobs/worker.js';
import { createPhotoJobContext, photoContextSchema } from '../photo-jobs/context.js';

const spec = overrides => ({ userId: 'user_owner', idempotencyKey: 'test_request_0001', inputAssetId: 'input_private_1',
  effectId: 'first_photo', effectVersion: 'review_1', purpose: 'photo-effect:first_photo', billingRef: 'billing_ref_0001',
  provider: 'fixture_provider', model: 'fixture_model', effectParameters: { strength: 1, style: 'reviewed' }, ...overrides });

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-jobs-'));
  const filename = path.join(dir, 'isolated.sqlite');
  const database = await openVirtualDatabase({ backend: 'sqlite', filename, migrate: true });
  t.after(async () => { await database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await database.transaction(async q => {
    await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', ['user_owner', 'fixture_app', 'fixture_openid']);
    await q(photoJobsSchema('sqlite'));
    await q('CREATE TABLE fixture_auth (user_id TEXT PRIMARY KEY, enabled INTEGER, consent INTEGER, input_valid INTEGER)');
    await q('INSERT INTO fixture_auth VALUES (?,?,?,?)', ['user_owner', 1, 1, 1]);
    await q('CREATE TABLE fixture_credit (user_id TEXT PRIMARY KEY, remaining INTEGER, reserved INTEGER, used INTEGER)');
    await q('INSERT INTO fixture_credit VALUES (?,?,?,?)', ['user_owner', 10, 0, 0]);
    await q('CREATE TABLE fixture_reservation (id TEXT PRIMARY KEY, state TEXT)');
    await q('CREATE TABLE fixture_work (id TEXT PRIMARY KEY, job_id TEXT UNIQUE, user_id TEXT)');
  });
  const ports = {
    async authorize({ query, job }) {
      const row = (await query('SELECT * FROM fixture_auth WHERE user_id = ?', [job.user_id]))[0];
      return row?.enabled === 1 && row.consent === 1 && row.input_valid === 1;
    },
    async reserve({ query, job }) {
      const row = (await query('SELECT * FROM fixture_credit WHERE user_id = ?', [job.user_id]))[0];
      if (!row || row.remaining < 1) return false;
      await query('UPDATE fixture_credit SET remaining = remaining - 1,reserved = reserved + 1 WHERE user_id = ?', [job.user_id]);
      await query('INSERT INTO fixture_reservation VALUES (?,?)', [job.billing_ref, 'held']);
      return true;
    },
    async settle({ query, job, outcome }) {
      const row = (await query('SELECT * FROM fixture_reservation WHERE id = ?', [job.billing_ref]))[0];
      if (row?.state !== 'held') throw new Error('FIXTURE_DUPLICATE_SETTLEMENT');
      await query(outcome === 'succeeded'
        ? 'UPDATE fixture_credit SET reserved = reserved - 1,used = used + 1 WHERE user_id = ?'
        : 'UPDATE fixture_credit SET reserved = reserved - 1,remaining = remaining + 1 WHERE user_id = ?', [job.user_id]);
      await query('UPDATE fixture_reservation SET state = ? WHERE id = ?', [outcome, job.billing_ref]);
      return true;
    },
    async publish({ query, job, assetId }) {
      await query('INSERT INTO fixture_work VALUES (?,?,?)', [assetId, job.id, job.user_id]);
      return true;
    },
  };
  const repo = overrides => createPhotoJobRepository({ database, ...ports, ...overrides });
  const rows = (sql, args = []) => database.transaction(q => q(sql, args));
  const balance = async () => (await rows('SELECT remaining,reserved,used FROM fixture_credit'))[0];
  return { database, ports, repo, rows, balance, filename };
}

test('concurrent same-key submit freezes identity, input, effect, purpose and billing while reserving once', async t => {
  const f = await fixture(t); const repository = f.repo();
  const results = await Promise.all(Array.from({ length: 24 }, () => repository.submit(spec())));
  assert.equal(new Set(results.map(row => row.job.id)).size, 1);
  assert.equal(results.filter(row => !row.duplicate).length, 1);
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
  for (const mutation of [{ inputAssetId: 'other_input' }, { effectId: 'other_effect' }, { effectVersion: 'review_2' },
    { purpose: 'other:purpose' }, { billingRef: 'different_ref' }, { provider: 'alternate_provider' },
    { model: 'alternate_model' }, { effectParameters: { strength: 2 } }]) {
    await assert.rejects(repository.submit(spec(mutation)), { code: 'PHOTO_JOB_IDEMPOTENCY_CONFLICT' });
  }
  assert.equal((await repository.submit(spec({ effectParameters: { style: 'reviewed', strength: 1 } }))).duplicate, true);
  assert.equal(await repository.readOwned('user_stranger', results[0].job.id), null);
  assert.equal(await repository.findOwnedByKey('user_stranger', spec().idempotencyKey), null);
  assert.equal((await repository.findOwnedByKey('user_owner', spec().idempotencyKey)).id, results[0].job.id);
  assert.equal(JSON.stringify(results).includes('input_private'), false);
});

test('reservation and job insertion roll back together when reused billing reference conflicts', async t => {
  const f = await fixture(t); const repository = f.repo(); await repository.submit(spec());
  await assert.rejects(repository.submit(spec({ idempotencyKey: 'new_request_0002' })));
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
  assert.equal((await f.rows('SELECT * FROM mini_photo_jobs')).length, 1);
});

test('20 concurrent worker attempts make exactly one provider call and publish/settle exactly once', async t => {
  const f = await fixture(t); const repository = f.repo(); const { job } = await repository.submit(spec());
  let calls = 0;
  const workers = Array.from({ length: 20 }, () => createPhotoJobWorker({ repository: f.repo(), runProvider: async input => {
    calls++; assert.equal(input.spec.provider, 'fixture_provider'); return { assetId: 'output_private_1' };
  } }));
  await Promise.all(workers.map(worker => worker.runOnce()));
  assert.equal(calls, 1);
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 0, used: 1 });
  assert.equal((await f.rows('SELECT * FROM fixture_work')).length, 1);
  assert.deepEqual((await repository.readOwned('user_owner', job.id)).assetId, 'output_private_1');
});

test('a process lost immediately after durable claim cannot be automatically re-claimed after database reopen', async t => {
  const f = await fixture(t); const repository = f.repo(); const { job } = await repository.submit(spec());
  await repository.claimNext();
  const reopened = await openVirtualDatabase({ backend: 'sqlite', filename: f.filename });
  try {
    const second = createPhotoJobRepository({ database: reopened, ...f.ports });
    assert.equal(await second.claimNext(), null);
    assert.equal((await second.readOwned('user_owner', job.id)).state, 'claimed');
  } finally { await reopened.close(); }
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
});

test('provider timeout or malformed success holds the reservation and never invokes fallback, retries or refunds', async t => {
  for (const mode of ['throw', 'malformed']) await t.test(mode, async t => {
    const f = await fixture(t); const repository = f.repo(); const { job } = await repository.submit(spec()); let calls = 0;
    const worker = createPhotoJobWorker({ repository, runProvider: async () => {
      calls++; if (mode === 'throw') throw new Error('PRIVATE_PROVIDER_URL_AND_CREDENTIAL');
      return { url: 'https://private.invalid/raw' };
    } });
    await worker.runOnce(); await worker.runOnce();
    assert.equal(calls, 1); assert.equal((await repository.readOwned('user_owner', job.id)).state, 'unknown');
    assert.equal(JSON.stringify(await f.rows('SELECT * FROM mini_photo_jobs')).includes('PRIVATE_PROVIDER'), false);
    assert.equal((await f.rows('SELECT * FROM fixture_work')).length, 0);
    assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
  });
});

test('revoked consent before dispatch cancels without provider cost; revoked during provider processing blocks publication', async t => {
  for (const phase of ['dispatch', 'publish']) await t.test(phase, async t => {
    const f = await fixture(t); const repository = f.repo(); const { job } = await repository.submit(spec()); let calls = 0;
    if (phase === 'dispatch') await f.rows('UPDATE fixture_auth SET consent = 0');
    const worker = createPhotoJobWorker({ repository, runProvider: async () => {
      calls++; await f.rows('UPDATE fixture_auth SET consent = 0'); return { assetId: 'output_private_1' };
    } });
    await worker.runOnce();
    const owned = await repository.readOwned('user_owner', job.id);
    assert.equal(owned.state, phase === 'dispatch' ? 'cancelled' : 'blocked');
    assert.equal(owned.assetId, undefined); assert.equal(calls, phase === 'dispatch' ? 0 : 1);
    assert.equal((await f.rows('SELECT * FROM fixture_work')).length, 0);
    assert.deepEqual(await f.balance(), phase === 'dispatch'
      ? { remaining: 10, reserved: 0, used: 0 } : { remaining: 9, reserved: 1, used: 0 });
  });
});

test('account disabled or input expired cannot dispatch even if submit was authorized', async t => {
  for (const column of ['enabled', 'input_valid']) await t.test(column, async t => {
    const f = await fixture(t); const repository = f.repo(); await repository.submit(spec());
    await f.rows(`UPDATE fixture_auth SET ${column} = 0`);
    const worker = createPhotoJobWorker({ repository, runProvider: () => { throw new Error('MUST_NOT_CALL'); } });
    assert.equal((await worker.runOnce()).state, 'cancelled');
    assert.deepEqual(await f.balance(), { remaining: 10, reserved: 0, used: 0 });
  });
});

test('failure after asset publish rolls back asset, billing and state; recovery publishes without regenerating', async t => {
  const f = await fixture(t); let failSettlement = true; let calls = 0;
  const repository = f.repo({ settle: async context => {
    if (failSettlement) throw new Error('FIXTURE_DATABASE_UNAVAILABLE');
    return f.ports.settle(context);
  } });
  const { job } = await repository.submit(spec());
  const worker = createPhotoJobWorker({ repository, runProvider: async () => { calls++; return { assetId: 'output_private_1' }; } });
  await assert.rejects(worker.runOnce(), /FIXTURE_DATABASE_UNAVAILABLE/);
  assert.equal((await repository.readOwned('user_owner', job.id)).state, 'result_ready');
  assert.equal((await f.rows('SELECT * FROM fixture_work')).length, 0);
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
  failSettlement = false; await worker.runOnce();
  assert.equal(calls, 1); assert.equal((await repository.readOwned('user_owner', job.id)).state, 'succeeded');
});

test('lost result commit response preserves the durable receipt and recovers without another provider request', async t => {
  const f = await fixture(t); let loseOnce = true; let calls = 0;
  const database = { transaction: async callback => {
    let recorded = false;
    const result = await f.database.transaction(query => callback(async (sql, args) => {
      if (sql.includes("SET state = 'result_ready'")) recorded = true;
      return query(sql, args);
    }));
    if (recorded && loseOnce) { loseOnce = false; throw new Error('FIXTURE_RESPONSE_LOST'); }
    return result;
  } };
  const repository = f.repo({ database }); const { job } = await repository.submit(spec());
  const worker = createPhotoJobWorker({ repository, runProvider: async () => { calls++; return { assetId: 'output_private_1' }; } });
  assert.equal((await worker.runOnce()).state, 'result_ready');
  await worker.runOnce(); assert.equal(calls, 1);
  assert.equal((await repository.readOwned('user_owner', job.id)).state, 'succeeded');
});

test('forged or stale worker claim cannot attach output; held task has no public provider or input data', async t => {
  const f = await fixture(t); const repository = f.repo(); const { job } = await repository.submit(spec());
  const claim = await repository.claimNext();
  await assert.rejects(repository.recordResult(job.id, 'wrong-token', { assetId: 'attacker_asset' }), { code: 'PHOTO_JOB_CLAIM_CONFLICT' });
  await repository.recordUnknown(job.id, claim.claim_token);
  await assert.rejects(repository.recordResult(job.id, claim.claim_token, { assetId: 'late_asset' }), { code: 'PHOTO_JOB_CLAIM_CONFLICT' });
  const owned = await repository.readOwned('user_owner', job.id);
  assert.deepEqual(Object.keys(owned).sort(), ['createdAt', 'id', 'state', 'updatedAt']);
});

test('drain stops new paid dispatches and waits for an already-running provider', async t => {
  const f = await fixture(t); const repository = f.repo(); await repository.submit(spec());
  let release; let started;
  const began = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const worker = createPhotoJobWorker({ repository, runProvider: async () => { started(); await gate; return { assetId: 'output_private_1' }; } });
  const active = worker.runOnce(); await began;
  let drained = false; const draining = worker.drain().then(result => { drained = true; return result; });
  assert.equal(await worker.runOnce(), null); assert.equal(drained, false);
  release(); await active;
  const result = await draining; assert.equal(result.active, 0); assert.equal(result.accepting, false);
  assert.equal(result.durableStates.succeeded, 1);
});

test('drain during publication recovery does not admit a subsequent new claim', async t => {
  const f = await fixture(t); const actual = f.repo(); const { job } = await actual.submit(spec());
  let entered; let release; let claims = 0; let calls = 0;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const repository = { ...actual,
    publishNext: async () => { entered(); await gate; return actual.publishNext(); },
    claimNext: async () => { claims++; return actual.claimNext(); } };
  const worker = createPhotoJobWorker({ repository, runProvider: async () => { calls++; return { assetId: 'output_private_1' }; } });
  const active = worker.runOnce(); await began;
  let drained = false; const draining = worker.drain().then(value => { drained = true; return value; });
  assert.equal(worker.status().accepting, false); assert.equal(drained, false);
  release(); await active; await draining;
  assert.equal(claims, 0); assert.equal(calls, 0);
  assert.equal((await actual.readOwned('user_owner', job.id)).state, 'queued');
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
});

test('a claim admitted before drain is in flight and completes once even when its response arrives during drain', async t => {
  const f = await fixture(t); const actual = f.repo(); const { job } = await actual.submit(spec());
  let entered; let releaseClaim; let providerStarted; let releaseProvider; let claims = 0; let calls = 0;
  const claimBegan = new Promise(resolve => { entered = resolve; });
  const claimGate = new Promise(resolve => { releaseClaim = resolve; });
  const providerBegan = new Promise(resolve => { providerStarted = resolve; });
  const providerGate = new Promise(resolve => { releaseProvider = resolve; });
  const repository = { ...actual, claimNext: async () => {
    claims++; const claimed = await actual.claimNext(); entered(); await claimGate; return claimed;
  } };
  const worker = createPhotoJobWorker({ repository, runProvider: async () => {
    calls++; providerStarted(); await providerGate; return { assetId: 'output_private_1' };
  } });
  const active = worker.runOnce(); await claimBegan;
  let drained = false; const draining = worker.drain().then(value => { drained = true; return value; });
  assert.equal((await actual.readOwned('user_owner', job.id)).state, 'claimed');
  assert.equal(drained, false); assert.equal(await worker.runOnce(), null);
  releaseClaim(); await providerBegan;
  assert.equal(drained, false); assert.equal(worker.status().active, 1);
  releaseProvider(); await active; await draining;
  assert.equal(claims, 1); assert.equal(calls, 1);
  assert.equal((await actual.readOwned('user_owner', job.id)).state, 'succeeded');
  assert.equal(await actual.claimNext(), null);
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 0, used: 1 });
});

test('false or missing transactional port confirmation never publishes success', async t => {
  const f = await fixture(t); const repository = f.repo({ publish: async () => undefined });
  const { job } = await repository.submit(spec());
  const worker = createPhotoJobWorker({ repository, runProvider: async () => ({ assetId: 'output_private_1' }) });
  await assert.rejects(worker.runOnce(), { code: 'PHOTO_JOB_PUBLICATION_UNCONFIRMED' });
  assert.equal((await repository.readOwned('user_owner', job.id)).state, 'result_ready');
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
});

test('lost claim commit response does not start a provider and cannot be silently retried', async t => {
  const f = await fixture(t); let loseOnce = true; let calls = 0;
  const database = { transaction: async callback => {
    let claimed = false;
    const result = await f.database.transaction(query => callback(async (sql, args) => {
      if (sql.includes("SET state = 'claimed'")) claimed = true;
      return query(sql, args);
    }));
    if (claimed && loseOnce) { loseOnce = false; throw new Error('FIXTURE_CLAIM_RESPONSE_LOST'); }
    return result;
  } };
  const repository = f.repo({ database }); const { job } = await repository.submit(spec());
  const worker = createPhotoJobWorker({ repository, runProvider: async () => { calls++; return { assetId: 'output_private_1' }; } });
  await assert.rejects(worker.runOnce(), /FIXTURE_CLAIM_RESPONSE_LOST/);
  assert.equal(await worker.runOnce(), null); assert.equal(calls, 0);
  assert.equal((await repository.readOwned('user_owner', job.id)).state, 'claimed');
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
});

test('database failure recording both result and uncertainty leaves claim durable without refund or regeneration', async t => {
  const f = await fixture(t); let calls = 0;
  const database = { transaction: callback => f.database.transaction(query => callback(async (sql, args) => {
    if (sql.includes("SET state = 'result_ready'") || sql.includes("SET state = 'unknown'")) throw new Error('FIXTURE_WRITE_UNAVAILABLE');
    return query(sql, args);
  })) };
  const repository = f.repo({ database }); const { job } = await repository.submit(spec());
  const worker = createPhotoJobWorker({ repository, runProvider: async () => { calls++; return { assetId: 'output_private_1' }; } });
  await assert.rejects(worker.runOnce(), /FIXTURE_WRITE_UNAVAILABLE/);
  assert.equal(await worker.runOnce(), null); assert.equal(calls, 1);
  assert.equal((await repository.readOwned('user_owner', job.id)).state, 'claimed');
  assert.deepEqual(await f.balance(), { remaining: 9, reserved: 1, used: 0 });
});

test('caller mutation while awaiting submission cannot change frozen execution parameters', async t => {
  const f = await fixture(t); let unblock; let begin;
  const started = new Promise(resolve => { begin = resolve; });
  const gate = new Promise(resolve => { unblock = resolve; });
  const repository = f.repo({ authorize: async context => { begin(); await gate; return f.ports.authorize(context); } });
  const input = spec(); const operation = repository.submit(input); await started;
  input.effectParameters.strength = 999; input.effectId = 'changed_after_submit'; unblock();
  await operation;
  const job = await repository.claimNext();
  assert.equal(job.spec.effectId, 'first_photo'); assert.equal(job.spec.effectParameters.strength, 1);
});

test('provider result mutation while waiting for a transaction cannot persist an unvalidated asset or provider reference', async t => {
  const f = await fixture(t); let entered; let release; let defer = false;
  const began = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const database = { transaction: async callback => {
    if (defer) { defer = false; entered(); await gate; }
    return f.database.transaction(callback);
  } };
  const repository = f.repo({ database }); const { job } = await repository.submit(spec());
  const claim = await repository.claimNext();
  const result = { assetId: 'output_private_1', providerRef: 'provider_receipt_1' }; defer = true;
  const operation = repository.recordResult(job.id, claim.claim_token, result); await began;
  result.assetId = 'https://private.invalid/raw'; result.providerRef = 'https://private.invalid/key';
  release(); await operation; await repository.publishNext();
  assert.equal((await repository.readOwned('user_owner', job.id)).assetId, 'output_private_1');
  assert.equal((await f.rows('SELECT provider_ref FROM mini_photo_jobs'))[0].provider_ref, 'provider_receipt_1');
});

test('each provider result field is read once so changing getters cannot bypass validation', async t => {
  const f = await fixture(t); const repository = f.repo(); const { job } = await repository.submit(spec());
  const claim = await repository.claimNext(); let assetReads = 0; let referenceReads = 0;
  const result = { get assetId() { assetReads++; return assetReads === 1 ? 'output_private_1' : 'https://private.invalid/raw'; },
    get providerRef() { referenceReads++; return referenceReads === 1 ? 'provider_receipt_1' : 'https://private.invalid/key'; } };
  await repository.recordResult(job.id, claim.claim_token, result); await repository.publishNext();
  assert.equal(assetReads, 1); assert.equal(referenceReads, 1);
  assert.equal((await repository.readOwned('user_owner', job.id)).assetId, 'output_private_1');
});

test('JSON contract rejects oversized, unsupported and cyclic specs before reserving anything', async t => {
  const f = await fixture(t); const repository = f.repo(); const cycle = {}; cycle.self = cycle;
  for (const input of [spec({ effectParameters: { prompt: 'x'.repeat(8192) } }), spec({ effectParameters: { value: NaN } }),
    spec({ effectParameters: cycle }), spec({ userId: '' }), spec({ effectVersion: '' }), spec({ provider: '' })]) {
    await assert.rejects(repository.submit(input), { code: 'PHOTO_JOB_INVALID_SPEC' });
  }
  assert.equal((await f.rows('SELECT * FROM mini_photo_jobs')).length, 0);
  assert.deepEqual(await f.balance(), { remaining: 10, reserved: 0, used: 0 });
});

const contextPolicy = { basicVersion: 'basic_1', faceVersion: 'face_1', labelVersion: 'ai_label_1' };
const contextEffect = { id: 'first_photo', version: 'review_1', provider: 'fixture_provider', model: 'fixture_model',
  purpose: 'photo-effect:first_photo', parameters: { strength: 1 }, enabled: true, reviewReference: 'effect_review_1' };
const contextAsset = (kind, timestamp = 1000000) => ({ id: `${kind}_private_1`, storageKey: `private/${kind}/fixture.png`,
  sha256: 'a'.repeat(64), byteLength: 64, contentType: 'image/png', expiresAt: timestamp + 60000,
  moderation: { decision: 'allow', reference: `${kind}_review_1` }, ...(kind === 'output' ? { labelVersion: 'ai_label_1' } : {}) });

async function contextFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-context-'));
  const filename = path.join(dir, 'isolated.sqlite');
  const database = await openVirtualDatabase({ backend: 'sqlite', filename, migrate: true });
  let timestamp = 1000000;
  const now = () => timestamp;
  const ledger = createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now });
  t.after(async () => { await database.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  await database.transaction(async q => {
    for (const sql of photoContextSchema('sqlite')) await q(sql);
    await q(photoJobsSchema('sqlite'));
    for (const user of ['user_owner', 'user_stranger']) await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [user, 'fixture_app', `${user}_openid`]);
    await q('INSERT INTO vp_orders(id,user_id,idem,status,payload,created_at) VALUES (?,?,?,?,?,?)',
      ['fixture_order', 'user_owner', 'fixture_order_key', 'paid', JSON.stringify({ id: 'fixture_order', userId: 'user_owner', status: 'paid' }), timestamp]);
    await q('INSERT INTO vp_buckets(id,user_id,order_id,kind,starts_at,expires_at,quantity,remaining,value_fen) VALUES (?,?,?,?,?,?,?,?,?)',
      ['fixture_bucket', 'user_owner', 'fixture_order', 'photo', 0, timestamp + 86400000, 10, 10, 990]);
  });
  const context = createPhotoJobContext({ ledger, policy: contextPolicy, now });
  await context.grantBasicConsent('user_owner', 'basic_1');
  await context.grantFaceConsent('user_owner', { version: 'face_1', subjectAuthorization: 'self' });
  await context.putEffect(contextEffect);
  await context.registerInput('user_owner', contextAsset('input'));
  const request = overrides => context.submission({ userId: 'user_owner', idempotencyKey: 'request_context_0001', inputAssetId: 'input_private_1', effectId: 'first_photo', ...overrides });
  const submit = async overrides => context.repository.submit(await request(overrides));
  const rows = (sql, args = []) => database.transaction(q => q(sql, args));
  const credits = async () => (await rows('SELECT remaining,reserved FROM vp_buckets WHERE id = ?', ['fixture_bucket']))[0];
  const provider = async ({ jobId, userId }) => { await context.registerOutput(userId, jobId, contextAsset('output', timestamp)); return { assetId: 'output_private_1' }; };
  return { database, filename, ledger, context, request, submit, rows, credits, provider, now, setTime: value => { timestamp = value; } };
}

test('real context uses canonical vp reservation and atomically publishes a private reviewed labelled output', async t => {
  const f = await contextFixture(t); const results = await Promise.all(Array.from({ length: 12 }, () => f.submit()));
  assert.equal(new Set(results.map(result => result.job.id)).size, 1);
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  assert.equal((await f.rows('SELECT * FROM vp_reservations')).length, 1);
  assert.equal(await f.context.readOwnedAsset('user_stranger', 'input_private_1'), null);
  let calls = 0;
  const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: async input => { calls++; return f.provider(input); } });
  await worker.runOnce(); await worker.runOnce();
  assert.equal(calls, 1);
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 0 });
  assert.equal((await f.rows('SELECT status FROM vp_reservations'))[0].status, 'consumed');
  const works = await f.context.listWorks('user_owner');
  assert.equal(works.length, 1); assert.equal(works[0].assetId, 'output_private_1');
  assert.equal(JSON.stringify(works).includes('storageKey'), false);
  assert.equal((await f.context.readOwnedAsset('user_owner', 'output_private_1')).storageKey, 'private/output/fixture.png');
});

test('real context revocation before dispatch returns only the existing reserved right exactly once', async t => {
  const f = await contextFixture(t); const { job } = await f.submit();
  await f.context.withdrawFaceConsent('user_owner');
  const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: () => { throw new Error('MUST_NOT_DISPATCH'); } });
  await worker.runOnce(); await worker.runOnce();
  assert.equal((await f.context.repository.readOwned('user_owner', job.id)).state, 'cancelled');
  assert.deepEqual(await f.credits(), { remaining: 10, reserved: 0 });
  assert.equal((await f.rows('SELECT status FROM vp_reservations'))[0].status, 'returned');
  assert.equal((await f.rows("SELECT * FROM vp_audit WHERE action = 'creation.failed'")).length, 1);
});

test('real context never recreates a right after channel refund races cancellation', async t => {
  const f = await contextFixture(t); await f.submit();
  await f.rows('UPDATE vp_orders SET status = ?,payload = ?', ['refunded', JSON.stringify({ id: 'fixture_order', userId: 'user_owner', status: 'refunded' })]);
  await f.rows('UPDATE vp_buckets SET remaining = 0');
  await f.context.withdrawFaceConsent('user_owner');
  await f.context.repository.claimNext();
  assert.deepEqual(await f.credits(), { remaining: 0, reserved: 0 });
});

test('channel refund alone cancels a queued job before any provider call or replacement right', async t => {
  const f = await contextFixture(t); const { job } = await f.submit();
  await f.rows('UPDATE vp_orders SET status = ?,payload = ?', ['refunded', JSON.stringify({ id: 'fixture_order', userId: 'user_owner', status: 'refunded' })]);
  await f.rows('UPDATE vp_buckets SET remaining = 0');
  let calls = 0;
  const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: async input => { calls++; return f.provider(input); } });
  assert.equal((await worker.runOnce()).state, 'cancelled');
  assert.equal(calls, 0); assert.deepEqual(await f.credits(), { remaining: 0, reserved: 0 });
  assert.equal((await f.context.repository.readOwned('user_owner', job.id)).assetId, undefined);
});

test('channel refund during a claimed job or after result receipt cannot publish or recreate rights', async t => {
  for (const phase of ['claimed', 'result_ready']) await t.test(phase, async t => {
    const f = await contextFixture(t); const { job } = await f.submit(); const claim = await f.context.repository.claimNext();
    if (phase === 'result_ready') {
      await f.provider({ jobId: job.id, userId: 'user_owner' });
      await f.context.repository.recordResult(job.id, claim.claim_token, { assetId: 'output_private_1' });
    }
    await f.rows('UPDATE vp_orders SET status = ?,payload = ?', ['refunded', JSON.stringify({ id: 'fixture_order', userId: 'user_owner', status: 'refunded' })]);
    await f.rows('UPDATE vp_buckets SET remaining = 0');
    if (phase === 'claimed') {
      await assert.rejects(f.provider({ jobId: job.id, userId: 'user_owner' }), { code: 'PHOTO_JOB_NOT_AUTHORIZED' });
      await f.context.repository.recordUnknown(job.id, claim.claim_token);
    } else assert.equal((await f.context.repository.publishNext()).state, 'blocked');
    assert.deepEqual(await f.context.listWorks('user_owner'), []);
    assert.deepEqual(await f.credits(), { remaining: 0, reserved: 1 });
    assert.equal((await f.context.repository.readOwned('user_owner', job.id)).assetId, undefined);
  });
});

test('real context timeout keeps canonical reservation held and staged output cannot appear as a work', async t => {
  const f = await contextFixture(t); const { job } = await f.submit(); let calls = 0;
  const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: async input => {
    calls++; await f.provider(input);
    assert.deepEqual(await f.context.listWorks('user_owner'), []);
    assert.equal(await f.context.readOwnedAsset('user_owner', 'output_private_1'), null);
    throw new Error('RESPONSE_LOST');
  } });
  await worker.runOnce(); await worker.runOnce();
  assert.equal(calls, 1); assert.equal((await f.context.repository.readOwned('user_owner', job.id)).state, 'unknown');
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  assert.equal((await f.rows('SELECT status FROM vp_reservations'))[0].status, 'reserved');
});

test('real context rejects stale consent, ownership and execution changes before reserving', async t => {
  const f = await contextFixture(t);
  await assert.rejects(f.context.grantBasicConsent('user_owner', 'basic_old'), { code: 'STALE_CONSENT_VERSION' });
  await assert.rejects(f.context.grantFaceConsent('user_owner', { version: 'face_1', subjectAuthorization: 'inferred' }), { code: 'STALE_CONSENT_VERSION' });
  const good = await f.request();
  for (const changes of [{ userId: 'user_stranger' }, { provider: 'alternate_provider' }, { effectParameters: { strength: 2 } }, { effectVersion: 'old_version' }]) {
    await assert.rejects(f.context.repository.submit({ ...good, ...changes }), { code: 'PHOTO_JOB_NOT_AUTHORIZED' });
  }
  await assert.rejects(f.context.putEffect({ ...contextEffect, parameters: { strength: 3 } }), { code: 'PHOTO_CONTEXT_EFFECT_VERSION_IMMUTABLE' });
  assert.deepEqual(await f.credits(), { remaining: 10, reserved: 0 });
});

test('frozen provider/model identifiers accept current adapter dots while rejecting URLs', async t => {
  const f = await contextFixture(t);
  await f.context.putEffect({ ...contextEffect, version: 'review_2', provider: 'aliyun-qwen-image-3.0', model: 'qwen-image-3.0-pro', reviewReference: 'review_2' });
  const saved = await f.request();
  assert.equal(saved.model, 'qwen-image-3.0-pro');
  const { job } = await f.context.repository.submit(saved);
  assert.equal((await f.context.repository.claimNext()).id, job.id);
  await assert.rejects(f.context.putEffect({ ...contextEffect, version: 'review_bad', model: 'https://private.invalid/model' }), { code: 'PHOTO_CONTEXT_INVALID_EFFECT' });
});

test('accepted key restores its frozen job after effect update/disable or consent withdrawal without reserving again', async t => {
  for (const change of ['updateEffect', 'disableEffect', 'withdraw', 'disableAccount']) await t.test(change, async t => {
    const f = await contextFixture(t); const first = await f.submit();
    if (change === 'updateEffect') await f.context.putEffect({ ...contextEffect, version: 'review_2', parameters: { strength: 2 }, reviewReference: 'review_2' });
    if (change === 'disableEffect') await f.context.putEffect({ ...contextEffect, enabled: false });
    if (change === 'withdraw') await f.context.withdrawFaceConsent('user_owner');
    if (change === 'disableAccount') await f.context.disableAccount('user_owner');
    const restoredSpec = await f.request(); assert.equal(restoredSpec.effectVersion, 'review_1');
    const restored = await f.context.repository.submit(restoredSpec);
    assert.equal(restored.duplicate, true); assert.equal(restored.job.id, first.job.id);
    assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
    assert.equal((await f.rows('SELECT * FROM vp_reservations')).length, 1);
    for (const mismatch of [{ effectId: 'other_effect' }, { inputAssetId: 'other_input' }]) {
      await assert.rejects(f.request(mismatch), { code: 'PHOTO_JOB_IDEMPOTENCY_CONFLICT' });
    }
  });
});

test('expired input cancels before dispatch; expired paid bucket receives only canonical seven-day compensation', async t => {
  const f = await contextFixture(t); await f.submit();
  await f.rows('UPDATE vp_buckets SET expires_at = ?', [f.now() + 1]);
  f.setTime(f.now() + 60001);
  assert.equal((await f.context.repository.claimNext()).cancelled, true);
  assert.equal(await f.context.repository.claimNext(), null);
  const compensation = (await f.rows("SELECT * FROM vp_buckets WHERE id LIKE 'comp:%'"))[0];
  assert.equal(compensation.remaining, 1); assert.equal(compensation.expires_at - f.now(), 7 * 86400000);
  assert.equal((await f.rows("SELECT * FROM vp_audit WHERE action = 'creation.failed'")).length, 1);
});

test('candidate MySQL context DDL matches the explicit schema generator', () => {
  const file = fs.readFileSync(new URL('../photo-jobs/context-schema.sql', import.meta.url), 'utf8');
  const normalizeSql = value => value.replace(/^--.*$/gm, '').replace(/\s+/g, ' ').replace(/\s*([(),;])\s*/g, '$1').trim().replace(/;$/, '');
  assert.equal(normalizeSql(file), normalizeSql(photoContextSchema('mysql').join(';')));
});

test('real context refuses unchecked output, raw URLs and mutable registration data', async t => {
  const f = await contextFixture(t); const { job } = await f.submit(); await f.context.repository.claimNext();
  for (const asset of [{ ...contextAsset('output'), moderation: { decision: 'review', reference: 'pending_review' } },
    { ...contextAsset('output'), labelVersion: 'old_label' }, { ...contextAsset('output'), storageKey: 'https://private.invalid/image' },
    { ...contextAsset('output'), storageKey: 'private/../escape.png' }]) {
    await assert.rejects(f.context.registerOutput('user_owner', job.id, asset), { code: 'PHOTO_CONTEXT_INVALID_ASSET' });
  }
  const source = contextAsset('output'); const operation = f.context.registerOutput('user_owner', job.id, source);
  source.storageKey = 'https://private.invalid/image'; source.moderation.reference = 'changed_after_call';
  await operation;
  const row = (await f.rows('SELECT storage_key,moderation_reference FROM mini_photo_assets WHERE id = ?', ['output_private_1']))[0];
  assert.deepEqual(row, { storage_key: 'private/output/fixture.png', moderation_reference: 'output_review_1' });
});

test('real context revoke/delete/effect-disable racing a ready output blocks publication and never automatically returns a spent attempt', async t => {
  for (const change of ['withdraw', 'deleteInput', 'deleteOutput', 'disableEffect', 'disableAccount']) await t.test(change, async t => {
    const f = await contextFixture(t); const { job } = await f.submit(); const claim = await f.context.repository.claimNext();
    await f.provider({ jobId: job.id, userId: 'user_owner' });
    await f.context.repository.recordResult(job.id, claim.claim_token, { assetId: 'output_private_1' });
    if (change === 'withdraw') await f.context.withdrawFaceConsent('user_owner');
    if (change === 'deleteInput') await f.context.deleteAsset('user_owner', 'input_private_1');
    if (change === 'deleteOutput') await f.context.deleteAsset('user_owner', 'output_private_1');
    if (change === 'disableEffect') await f.context.putEffect({ ...contextEffect, enabled: false });
    if (change === 'disableAccount') await f.context.disableAccount('user_owner');
    assert.equal((await f.context.repository.publishNext()).state, 'blocked');
    assert.deepEqual(await f.context.listWorks('user_owner'), []);
    assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
    assert.equal((await f.context.repository.readOwned('user_owner', job.id)).assetId, undefined);
  });
});

test('regranting consent cannot resurrect revoked inputs or formerly published works', async t => {
  const f = await contextFixture(t); await f.submit();
  await createPhotoJobWorker({ repository: f.context.repository, runProvider: f.provider }).runOnce();
  await f.context.withdrawFaceConsent('user_owner');
  await f.context.grantFaceConsent('user_owner', { version: 'face_1', subjectAuthorization: 'self' });
  assert.deepEqual(await f.context.listWorks('user_owner'), []);
  assert.equal(await f.context.readOwnedAsset('user_owner', 'input_private_1'), null);
  assert.equal(await f.context.readOwnedAsset('user_owner', 'output_private_1'), null);
  await assert.rejects(f.context.registerInput('user_owner', contextAsset('input')), { code: 'PHOTO_CONTEXT_ASSET_CONFLICT' });
});

test('real context publication and ledger consumption rollback together and recover after opening another database connection', async t => {
  const f = await contextFixture(t); const { job } = await f.submit(); const claim = await f.context.repository.claimNext();
  await f.provider({ jobId: job.id, userId: 'user_owner' }); await f.context.repository.recordResult(job.id, claim.claim_token, { assetId: 'output_private_1' });
  const broken = createPhotoJobRepository({ database: f.database, ...f.context.ports, settle: async args => {
    await f.context.ports.settle(args); throw new Error('AFTER_CONSUMPTION_BEFORE_COMMIT');
  }, now: f.now });
  await assert.rejects(broken.publishNext(), /AFTER_CONSUMPTION_BEFORE_COMMIT/);
  assert.deepEqual(await f.context.listWorks('user_owner'), []); assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  const reopened = await openVirtualDatabase({ backend: 'sqlite', filename: f.filename });
  try {
    const ledger = createVirtualLedger({ database: reopened, encryptionKey: '1'.repeat(64), now: f.now });
    const recovered = createPhotoJobContext({ ledger, policy: contextPolicy, now: f.now });
    assert.equal((await recovered.repository.publishNext()).state, 'succeeded');
    assert.equal((await recovered.listWorks('user_owner')).length, 1);
    assert.equal(await recovered.repository.claimNext(), null);
  } finally { await reopened.close(); }
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 0 });
});

test('independent worker threads and SQLite connections compete for one canonical reservation, provider attempt and publication', async t => {
  const f = await contextFixture(t);
  const code = `const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {openVirtualDatabase}=await import(workerData.databaseModule);
      const {createVirtualLedger}=await import(workerData.ledgerModule);
      const {createPhotoJobContext}=await import(workerData.contextModule);
      const {createPhotoJobWorker}=await import(workerData.workerModule);
      const database=await openVirtualDatabase({backend:'sqlite',filename:workerData.filename});
      const ledger=createVirtualLedger({database,encryptionKey:'1'.repeat(64),now:()=>1000000});
      const context=createPhotoJobContext({ledger,policy:workerData.policy,now:()=>1000000});
      parentPort.postMessage({ready:true}); await new Promise(resolve=>parentPort.once('message',resolve));
      try {
        const spec=await context.submission({userId:'user_owner',idempotencyKey:'request_context_0001',inputAssetId:'input_private_1',effectId:'first_photo'});
        const submitted=await context.repository.submit(spec);
        const worker=createPhotoJobWorker({repository:context.repository,runProvider:async({jobId,userId})=>{
          parentPort.postMessage({provider:true});
          await context.registerOutput(userId,jobId,workerData.asset);return {assetId:'output_private_1'};
        }});
        await worker.runOnce();
        parentPort.postMessage({done:true,id:submitted.job.id,duplicate:submitted.duplicate});
      } finally { await database.close(); }
    })().catch(error=>{parentPort.postMessage({failure:error.message});process.exitCode=1;});`;
  let providerCalls = 0;
  const workers = Array.from({ length: 6 }, () => {
    const worker = new Worker(code, { eval: true, workerData: { filename: f.filename, policy: contextPolicy, asset: contextAsset('output'),
      databaseModule: new URL('../payments/virtual/database.js', import.meta.url).href, ledgerModule: new URL('../payments/virtual/ledger.js', import.meta.url).href,
      contextModule: new URL('../photo-jobs/context.js', import.meta.url).href, workerModule: new URL('../photo-jobs/worker.js', import.meta.url).href } });
    t.after(() => worker.terminate());
    const ready = new Promise((resolve, reject) => { worker.on('message', message => { if (message.ready) resolve(); if (message.failure) reject(new Error(message.failure)); }); worker.once('error', reject); });
    const done = new Promise((resolve, reject) => { let result;
      worker.on('message', message => { if (message.provider) providerCalls++; if (message.done) result = message; if (message.failure) reject(new Error(message.failure)); });
      worker.once('error', reject); worker.once('exit', code => code === 0 && result ? resolve(result) : reject(new Error(`WORKER_EXIT_${code}`)));
    });
    return { worker, ready, done };
  });
  await Promise.all(workers.map(item => item.ready)); workers.forEach(item => item.worker.postMessage('start'));
  const results = await Promise.all(workers.map(item => item.done));
  assert.equal(providerCalls, 1); assert.equal(results.filter(result => !result.duplicate).length, 1);
  assert.equal(new Set(results.map(result => result.id)).size, 1);
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 0 });
  assert.equal((await f.context.listWorks('user_owner')).length, 1);
  assert.equal((await f.rows('SELECT * FROM vp_reservations')).length, 1);
});
