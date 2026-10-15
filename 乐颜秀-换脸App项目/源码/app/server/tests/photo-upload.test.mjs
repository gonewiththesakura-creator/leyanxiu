import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Hono } from 'hono';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createPhotoJobContext, photoContextSchema } from '../photo-jobs/context.js';
import { createPhotoUploadRepository, photoUploadSchema, photoUploadCleanupSchema, parsePhotoUpload } from '../photo-jobs/upload-repository.js';
import { createPhotoUploadService, createPhotoUploadWorker } from '../photo-jobs/upload-service.js';
import { createPhotoUploadOssStorage } from '../photo-jobs/upload-storage.js';
import { registerPhotoUploadRoutes } from '../photo-jobs/upload-routes.js';
import { createPhotoImageModerator } from '../photo-jobs/moderation.js';
import { createPhotoInputNormalizer } from '../photo-jobs/input-normalizer.js';

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMISKkAAAI0AS3HG8jrAAAAAElFTkSuQmCC';
const digest = value => createHash('sha256').update(value).digest('hex');
const policy = { basicVersion: 'basic_1', faceVersion: 'face_1', moderationVersion: 'review_1', moderationService: 'baselineCheck',
  sourceRetentionMs: 86400000, maxDailyUploads: 100, maxDailyUploadsPerUser: 10 };
const key = n => n.toString(16).padStart(32, '0');
const deferred = () => { let resolve; let reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const request = (n = 1, userId = 'owner') => ({ userId, idempotencyKey: key(n), image });

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-upload-isolated-'));
  const filename = path.join(directory, 'fixture.sqlite');
  const database = await openVirtualDatabase({ backend: 'sqlite', filename, migrate: true });
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let stamp = 1000000;
  const now = () => stamp;
  await database.transaction(async q => {
    for (const sql of photoContextSchema('sqlite')) await q(sql);
    await q(photoUploadSchema('sqlite'));
    for (const user of ['owner', 'other']) await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [user, 'fixture_app', `openid_${user}`]);
  });
  const context = createPhotoJobContext({ ledger: createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now }),
    policy: { ...policy, labelVersion: 'label_1' }, now });
  for (const user of ['owner', 'other']) {
    await context.grantBasicConsent(user, policy.basicVersion);
    await context.grantFaceConsent(user, { version: policy.faceVersion, subjectAuthorization: 'self' });
  }
  const repository = createPhotoUploadRepository({ database, policy: { ...policy, ...options.policy }, now });
  const objects = new Map(); const counts = { put: 0, read: 0, moderate: 0 };
  const storage = {
    async put(objectKey, bytes, settings) { counts.put++; assert.equal(objects.has(objectKey), false); objects.set(objectKey, { bytes: Buffer.from(bytes), contentType: settings.contentType }); },
    async read(objectKey) { counts.read++; const object = objects.get(objectKey); return object
      ? { found: true, ...object, bytes: Buffer.from(object.bytes), byteLength: object.bytes.length, sha256: digest(object.bytes) } : { found: false }; },
  };
  const moderator = { async moderate({ bytes, contentType, direction, journal }) {
    await journal({ reference: 'a'.repeat(32), extension: 'png' });
    counts.moderate++; assert.equal(contentType, 'image/png');
    return { provider: 'aliyun-green', policyVersion: policy.moderationVersion, service: policy.moderationService,
      direction, sha256: digest(bytes), byteLength: bytes.length, decision: 'allow', reference: `mod_${'1'.repeat(64)}`, requestId: 'fixture_request', cleanupPending: false,
      cleanupReference: 'a'.repeat(32), cleanupExtension: 'png' };
  } };
  const service = createPhotoUploadService({ repository, storage, timeoutMs: 40 });
  const worker = overrides => createPhotoUploadWorker({ repository, storage, moderator, timeoutMs: 40, ...overrides });
  const rows = (sql, args = []) => database.transaction(q => q(sql, args));
  return { database, filename, repository, context, objects, counts, storage, moderator, service, worker, rows, now, advance: amount => { stamp += amount; } };
}

test('candidate MySQL DDL exactly matches code and contains metadata, not photo bytes', () => {
  const ddl = fs.readFileSync(new URL('../photo-jobs/upload-schema.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').trim().replace(/;$/, '');
  const normalize = s => s.replace(/\s+/g, ' ').trim();
  assert.equal(normalize(ddl), normalize(`${photoUploadSchema('mysql')}; ${photoUploadCleanupSchema('mysql')}`));
  assert.doesNotMatch(ddl, /\bBLOB\b|image_base64|raw_bytes/i);
  assert.throws(() => createPhotoUploadRepository({ database: { backend: 'sqlite', transaction() {} }, policy: { ...policy, maxDailyUploads: undefined } }), /PHOTO_UPLOAD_POLICY_REQUIRED/);
});

test('concurrent same-key uploads save one private object, claim one review and atomically register one input', async t => {
  const f = await fixture(t);
  const result = await Promise.all(Array.from({ length: 4 }, () => f.service.submit(request())));
  assert.equal(new Set(result.map(r => r.upload.id)).size, 1); assert.equal(result.filter(r => !r.duplicate).length, 1);
  assert.equal(f.counts.put, 1); assert.equal(f.counts.moderate, 0);
  await Promise.all(Array.from({ length: 16 }, () => f.worker().runOnce()));
  assert.equal(f.counts.moderate, 1);
  const upload = await f.repository.findOwnedByKey('owner', key(1));
  assert.equal(upload.state, 'ready'); assert.ok(upload.assetId);
  assert.equal((await f.rows('SELECT * FROM mini_photo_assets')).length, 1);
  assert.ok(await f.context.readOwnedAsset('owner', upload.assetId));
  assert.equal(await f.repository.readOwned('other', upload.id), null);
  assert.equal(await f.repository.findOwnedByKey('other', key(1)), null);
  assert.doesNotMatch(JSON.stringify(result), /storage_key|storageKey|private\/|sha256/);
  assert.equal((await f.rows('SELECT * FROM vp_reservations')).length, 0, 'uploads do not make another entitlement ledger');
});

test('same key with changed bytes conflicts even after completion; original key never performs a second PUT', async t => {
  const f = await fixture(t); await f.service.submit(request()); await f.worker().runOnce();
  const changed = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOoSAkAAAKEAS2hSmd5AAAAAElFTkSuQmCC', 'base64');
  await assert.rejects(f.service.submit({ ...request(), image: `data:image/png;base64,${changed.toString('base64')}` }), /PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT/);
  assert.equal((await f.service.submit(request())).duplicate, true); assert.equal(f.counts.put, 1); assert.equal(f.counts.moderate, 1);
});

test('lost successful PUT response remains staging and recovers by authenticated read, never PUT again', async t => {
  const f = await fixture(t);
  const storage = { ...f.storage, async put(...args) { await f.storage.put(...args); throw new Error('LOST_PRIVATE_PUT_RESPONSE'); } };
  const service = createPhotoUploadService({ repository: f.repository, storage, timeoutMs: 40 });
  const first = await service.submit(request()); assert.equal(first.upload.state, 'staging');
  assert.equal((await service.submit(request())).duplicate, true); assert.equal(f.counts.put, 1);
  await f.worker().runOnce(); assert.equal((await f.repository.readOwned('owner', first.upload.id)).state, 'ready');
  assert.equal(f.counts.put, 1); assert.equal(f.counts.moderate, 1);
});

test('durable intent before PUT and missing object do not permit automatic retransmission', async t => {
  const f = await fixture(t); const source = parsePhotoUpload(image);
  const intent = await f.repository.submitIntent({ ...request(), ...source });
  assert.equal(intent.upload.state, 'staging');
  for (let n = 0; n < 3; n++) await f.worker().runOnce();
  const result = await f.service.submit(request()); assert.equal(result.duplicate, true); assert.equal(result.upload.state, 'staging');
  assert.equal(f.counts.put, 0); assert.equal(f.counts.moderate, 0);
});

test('slow PUT returns staging promptly; late completion and recovery do not duplicate bytes or moderation', async t => {
  const f = await fixture(t); const gate = deferred();
  const storage = { ...f.storage, async put(...args) { await gate.promise; await f.storage.put(...args); } };
  const service = createPhotoUploadService({ repository: f.repository, storage, timeoutMs: 10 });
  const result = await service.submit(request()); assert.equal(result.upload.state, 'staging');
  await f.worker().runOnce(); assert.equal(f.counts.moderate, 0);
  gate.resolve(); await new Promise(resolve => setTimeout(resolve, 15));
  await f.worker().runOnce(); assert.equal((await f.repository.readOwned('owner', result.upload.id)).state, 'ready');
  assert.equal(f.counts.put, 1); assert.equal(f.counts.moderate, 1);
});

test('admission budget is atomic and separate from generation credits; duplicate recovery remains allowed at the cap', async t => {
  const f = await fixture(t, { policy: { maxDailyUploads: 2, maxDailyUploadsPerUser: 1 } });
  const results = await Promise.allSettled([f.service.submit(request(1)), f.service.submit(request(2)), f.service.submit(request(3, 'other'))]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'PHOTO_UPLOAD_BUDGET_LIMIT');
  assert.equal(f.counts.put, 2); assert.equal((await f.service.submit(request(1))).duplicate, true);
  assert.equal((await f.rows('SELECT * FROM vp_reservations')).length, 0);
});

test('read-only preflight rejects missing consent and exhausted budgets before starting Pillow', async t => {
  for (const mode of ['consent', 'budget']) await t.test(mode, async t => {
    const f = await fixture(t, { policy: { maxDailyUploads: 1, maxDailyUploadsPerUser: 1 } });
    if (mode === 'consent') await f.context.withdrawFaceConsent('owner');
    else await f.service.submit(request());
    let children = 0; const queries = [];
    const database = { ...f.database, transaction: callback => f.database.transaction(q => callback(async (sql, args) => { queries.push(sql); return q(sql, args); })) };
    const repository = createPhotoUploadRepository({ database, policy: { ...policy, maxDailyUploads: 1, maxDailyUploadsPerUser: 1 }, now: f.now });
    const service = createPhotoUploadService({ repository, storage: f.storage,
      inputNormalizer: createPhotoInputNormalizer({ spawnProcess: (...args) => { children++; return spawn(...args); } }) });
    await assert.rejects(service.submit(request(2)), { code: mode === 'consent' ? 'PHOTO_UPLOAD_NOT_AUTHORIZED' : 'PHOTO_UPLOAD_BUDGET_LIMIT' });
    assert.equal(children, 0); assert.ok(queries.length > 0); assert.ok(queries.every(sql => /^SELECT /.test(sql)));
    assert.equal(f.counts.put, mode === 'consent' ? 0 : 1);
  });
});

test('withdrawal during actual normalization rejects even if the same-version consent was granted again', async t => {
  for (const grantAgain of [false, true]) await t.test(String(grantAgain), async t => {
    const f = await fixture(t); const actual = createPhotoInputNormalizer();
    const service = createPhotoUploadService({ repository: f.repository, storage: f.storage, inputNormalizer: {
      async normalize(value) { const clean = await actual.normalize(value); await f.context.withdrawFaceConsent('owner');
        if (grantAgain) await f.context.grantFaceConsent('owner', { version: policy.faceVersion, subjectAuthorization: 'self' });
        return clean; },
    } });
    await assert.rejects(service.submit(request()), { code: 'PHOTO_UPLOAD_NOT_AUTHORIZED' });
    assert.equal((await f.rows('SELECT id FROM mini_photo_uploads')).length, 0); assert.equal(f.counts.put, 0);
  });
});

test('another same-key commit during failed normalization remains recoverable and never becomes definite-not-started', async t => {
  const f = await fixture(t); const gate = deferred(); const started = deferred();
  const service = createPhotoUploadService({ repository: f.repository, storage: f.storage, inputNormalizer: {
    async normalize() { started.resolve(); await gate.promise; throw new Error('LOCAL_DECODER_UNAVAILABLE'); },
  } });
  const losing = service.submit(request()); const checked = assert.rejects(losing, { code: 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE' });
  await started.promise; const accepted = await f.service.submit(request()); gate.resolve(); await checked;
  assert.equal(f.counts.put, 1); assert.equal((await f.repository.findOwnedByKey('owner', key(1))).id, accepted.upload.id);
  assert.equal((await f.rows('SELECT id FROM mini_photo_uploads')).length, 1);
});

test('preprocessing failure for an existing key keeps its immutable object, original SQL row and recovery receipt', async t => {
  const f = await fixture(t); const original = await f.service.submit(request());
  const before = await f.rows('SELECT * FROM mini_photo_uploads');
  const bytesBefore = Buffer.from([...f.objects.values()][0].bytes);
  const unavailable = createPhotoUploadService({ repository: f.repository, storage: f.storage,
    inputNormalizer: createPhotoInputNormalizer({ python: 'synthetic-nonexistent-python-program' }) });
  await assert.rejects(unavailable.submit(request()), { code: 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT' });
  await assert.rejects(unavailable.submit({ ...request(), image: 'invalid' }), { code: 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(await f.rows('SELECT * FROM mini_photo_uploads'), before);
  assert.deepEqual([...f.objects.values()][0].bytes, bytesBefore); assert.equal(f.counts.put, 1);
  assert.deepEqual(await f.repository.findOwnedByKey('owner', key(1)), original.upload);
});

test('crash after claim and actual database reopen never reclaim or re-review', async t => {
  const f = await fixture(t); const { upload } = await f.service.submit(request()); await f.repository.claimNext();
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: f.filename });
  try {
    const repository = createPhotoUploadRepository({ database, policy, now: f.now });
    const worker = createPhotoUploadWorker({ repository, storage: f.storage, moderator: f.moderator });
    await worker.runOnce(); assert.equal((await repository.readOwned('owner', upload.id)).state, 'claimed'); assert.equal(f.counts.moderate, 0);
  } finally { await database.close(); }
});

test('uncertain review and mismatched receipts stay locked without another paid call or asset publication', async t => {
  for (const mode of ['throw', 'wrong_sha', 'wrong_policy', 'wrong_service', 'wrong_direction', 'bad_ref']) await t.test(mode, async t => {
    const f = await fixture(t); const { upload } = await f.service.submit(request());
    const moderator = { async moderate(input) {
      const receipt = await f.moderator.moderate(input);
      if (mode === 'throw') throw new Error('PRIVATE_MODERATION_URL');
      return { ...receipt, ...({ wrong_sha: { sha256: '0'.repeat(64) }, wrong_policy: { policyVersion: 'stale' },
        wrong_service: { service: 'aigcCheck' }, wrong_direction: { direction: 'output' }, bad_ref: { reference: 'https://private.invalid' } })[mode] };
    } };
    await f.worker({ moderator }).runOnce(); await f.worker({ moderator }).runOnce();
    assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'unknown'); assert.equal(f.counts.moderate, 1);
    assert.equal((await f.rows('SELECT * FROM mini_photo_assets')).length, 0);
    assert.doesNotMatch(JSON.stringify(await f.rows('SELECT * FROM mini_photo_uploads')), /PRIVATE_MODERATION|https:/);
  });
});

test('withdrawal before review cancels without cost; withdrawal during review denies publication and keeps deletion responsibility', async t => {
  for (const phase of ['before', 'during']) await t.test(phase, async t => {
    const f = await fixture(t); const { upload } = await f.service.submit(request());
    if (phase === 'before') await f.context.withdrawFaceConsent('owner');
    const moderator = { async moderate(input) { const receipt = await f.moderator.moderate(input); await f.context.withdrawFaceConsent('owner');
      return { ...receipt, cleanupPending: true, cleanupReference: 'a'.repeat(32), cleanupExtension: 'png' }; } };
    await f.worker({ moderator }).runOnce(); const state = await f.repository.readOwned('owner', upload.id);
    assert.equal(state.state, 'cancelled'); assert.equal(state.assetId, undefined); assert.equal(f.counts.moderate, phase === 'before' ? 0 : 1);
    const [cleanup] = await f.repository.cleanupCandidates(); assert.equal(cleanup.id, upload.id); assert.equal(cleanup.source_cleanup_pending, 1);
    if (phase === 'during') { assert.equal(cleanup.moderation_cleanup_pending, 1); assert.equal(cleanup.moderation_cleanup_reference, 'a'.repeat(32)); }
  });
});

test('expired or changed-policy uploads cannot be resurrected; ready asset deletion invalidates upload recovery', async t => {
  for (const mode of ['expiry', 'policy', 'deleted', 'disabled']) await t.test(mode, async t => {
    const f = await fixture(t); const { upload } = await f.service.submit(request());
    let repository = f.repository;
    if (mode === 'expiry') f.advance(policy.sourceRetentionMs + 1);
    if (mode === 'policy') repository = createPhotoUploadRepository({ database: f.database, policy: { ...policy, moderationVersion: 'review_2' }, now: f.now });
    if (mode === 'disabled') await f.context.disableAccount('owner');
    if (mode === 'deleted') { await f.worker().runOnce(); const ready = await repository.readOwned('owner', upload.id); await f.context.deleteAsset('owner', ready.assetId); }
    await f.worker({ repository }).runOnce();
    const recovered = await repository.findOwnedByKey('owner', key(1)); assert.equal(recovered.state, 'cancelled'); assert.equal(recovered.assetId, undefined);
    const service = createPhotoUploadService({ repository, storage: f.storage });
    if (mode === 'disabled') await assert.rejects(service.submit(request()), { code: 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT' });
    else assert.equal((await service.submit(request())).duplicate, true);
    assert.equal((await repository.findOwnedByKey('owner', key(1))).state, 'cancelled'); assert.equal(f.counts.put, 1);
  });
});

test('DB-only publication recovers after rollback without re-review; source and upload state commit together', async t => {
  const f = await fixture(t); const { upload } = await f.service.submit(request()); let failOnce = true;
  const database = { ...f.database, transaction: callback => f.database.transaction(q => callback(async (sql, args) => {
    if (failOnce && sql.includes("SET state = 'ready'")) { failOnce = false; throw new Error('FIXTURE_ROLLBACK'); } return q(sql, args);
  })) };
  const repository = createPhotoUploadRepository({ database, policy, now: f.now });
  await assert.rejects(f.worker({ repository }).runOnce(), /FIXTURE_ROLLBACK/);
  assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'reviewed'); assert.equal((await f.rows('SELECT * FROM mini_photo_assets')).length, 0);
  await f.worker().runOnce(); assert.equal(f.counts.moderate, 1); assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'ready');
});

test('receipt snapshots resist mutation while waiting for a transaction', async t => {
  const f = await fixture(t); const { upload } = await f.service.submit(request()); await f.repository.claimNext();
  const gate = deferred(); const entered = deferred();
  const database = { ...f.database, async transaction(callback) { entered.resolve(); await gate.promise; return f.database.transaction(callback); } };
  const repository = createPhotoUploadRepository({ database, policy, now: f.now });
  const receipt = await f.moderator.moderate({ ...parsePhotoUpload(image), direction: 'input', journal: intent => f.repository.recordModerationIntent(upload.id, intent) });
  const operation = repository.recordReview(upload.id, receipt); await entered.promise;
  receipt.reference = 'https://private.invalid'; receipt.sha256 = '0'.repeat(64); gate.resolve(); await operation;
  await repository.publishNext(); assert.equal((await repository.readOwned('owner', upload.id)).state, 'ready');
  assert.doesNotMatch(JSON.stringify(await f.rows('SELECT receipt FROM mini_photo_uploads')), /https:/);
});

test('drain begun during staging read prevents a later claim; claimed work can finish once', async t => {
  const f = await fixture(t); await f.service.submit(request()); const gate = deferred(); const entered = deferred();
  const repository = { ...f.repository, async nextStaging() { entered.resolve(); await gate.promise; return null; } };
  const worker = f.worker({ repository }); const running = worker.runOnce(); await entered.promise;
  const drained = worker.drain(); gate.resolve(); await running; await drained;
  assert.equal(f.counts.moderate, 0); assert.equal((await f.repository.findOwnedByKey('owner', key(1))).state, 'queued');
  assert.equal(await worker.runOnce(), null);
  const claimedGate = deferred(); const claimedEntered = deferred();
  const second = f.worker({ moderator: { async moderate(input) { claimedEntered.resolve(); await claimedGate.promise; return f.moderator.moderate(input); } } });
  const work = second.runOnce(); await claimedEntered.promise; const drain = second.drain(); claimedGate.resolve(); await work; await drain;
  assert.equal(f.counts.moderate, 1); assert.equal((await f.repository.findOwnedByKey('owner', key(1))).state, 'ready');
});

test('HTTP upload is fast durable intent only, owner-isolated, sanitized and recoverable while closed', async t => {
  const f = await fixture(t); let enabled = true; const app = new Hono();
  registerPhotoUploadRoutes(app, { service: f.service, authenticated: async c => ({ auth: { authMethod: 'wechat', userId: c.req.header('test-user') || 'owner' } }), readiness: async () => ({ ready: enabled }) });
  const post = (n, body = { image }) => app.request('/api/mini/photo-uploads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key(n) }, body: JSON.stringify(body) });
  const first = await post(1); assert.equal(first.status, 202); const data = (await first.json()).data;
  assert.equal(data.upload.state, 'queued'); assert.equal(f.counts.moderate, 0); assert.doesNotMatch(JSON.stringify(data), /private\/|storageKey|sha256/);
  enabled = false; assert.equal((await post(1)).status, 200); assert.equal((await post(2)).status, 503);
  assert.equal((await post(2, { image, approved: true })).status, 400);
  const own = await app.request(`/api/mini/photo-uploads/by-key/${key(1)}`); assert.equal((await own.json()).data.upload.id, data.upload.id);
  const other = await app.request(`/api/mini/photo-uploads/${data.upload.id}`, { headers: { 'test-user': 'other' } }); assert.equal(other.status, 404);
  const absent = await app.request(`/api/mini/photo-uploads/by-key/${key(99)}`); assert.equal((await absent.json()).data.upload, null);
});

test('default OSS port uses immutable private PUT and authenticated bounded GET, never signed/public URLs', async () => {
  const source = parsePhotoUpload(image); const calls = [];
  const client = {
    async put(...args) { calls.push(['put', ...args]); },
    async head(...args) { calls.push(['head', ...args]); return { res: { headers: { 'content-length': String(source.byteLength), 'content-type': source.contentType } } }; },
    async get(...args) { calls.push(['get', ...args]); return { content: source.bytes, res: { headers: { 'content-type': source.contentType } } }; },
  };
  const storage = createPhotoUploadOssStorage({ bucket: 'fixture-private-bucket', region: 'cn-shanghai', client });
  const objectKey = `private/mini-photo-input/${'a'.repeat(32)}.png`;
  await storage.put(objectKey, source.bytes, { contentType: source.contentType, timeoutMs: 100 });
  const stored = await storage.read(objectKey, { timeoutMs: 100 }); assert.equal(stored.sha256, source.sha256);
  assert.equal(calls[0][3].headers['x-oss-object-acl'], 'private'); assert.equal(calls[0][3].headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(calls[2][2].headers.Range, 'bytes=0-2097152');
  await assert.rejects(storage.read('private/another-owner.png'), /STORAGE_KEY_INVALID/);
  const missing = createPhotoUploadOssStorage({ bucket: 'fixture-private-bucket', region: 'cn-shanghai', client: { async head() { throw { status: 404 }; } } });
  assert.deepEqual(await missing.read(objectKey), { found: false });
});

test('source intent commit reply loss cannot lead to a second PUT on retry', async t => {
  const f = await fixture(t); let loseOnce = true;
  const database = { ...f.database, async transaction(callback) {
    let inserted = false; const result = await f.database.transaction(q => callback(async (sql, args) => {
      if (sql.startsWith('INSERT INTO mini_photo_uploads')) inserted = true; return q(sql, args);
    }));
    if (inserted && loseOnce) { loseOnce = false; throw new Error('COMMIT_REPLY_LOST'); } return result;
  } };
  const repository = createPhotoUploadRepository({ database, policy, now: f.now });
  const service = createPhotoUploadService({ repository, storage: f.storage });
  await assert.rejects(service.submit(request()), /COMMIT_REPLY_LOST/);
  const recovered = await repository.findOwnedByKey('owner', key(1)); assert.equal(recovered.state, 'staging');
  assert.equal((await service.submit(request())).duplicate, true); assert.equal(f.counts.put, 0); assert.equal(f.counts.moderate, 0);
});

test('claim commit reply loss remains claimed; receipt commit reply loss recovers publication only', async t => {
  for (const phase of ['claim', 'receipt']) await t.test(phase, async t => {
    const f = await fixture(t); const { upload } = await f.service.submit(request()); let loseOnce = true;
    const database = { ...f.database, async transaction(callback) {
      let changed = false; const result = await f.database.transaction(q => callback(async (sql, args) => {
        if (phase === 'claim' ? sql.includes("SET state = 'claimed'") : sql.includes('SET state = ?,receipt = ?')) changed = true;
        return q(sql, args);
      }));
      if (changed && loseOnce) { loseOnce = false; throw new Error('COMMIT_REPLY_LOST'); } return result;
    } };
    const repository = createPhotoUploadRepository({ database, policy, now: f.now });
    await assert.rejects(f.worker({ repository }).runOnce(), /COMMIT_REPLY_LOST/); await f.worker().runOnce();
    assert.equal((await f.repository.readOwned('owner', upload.id)).state, phase === 'claim' ? 'claimed' : 'ready');
    assert.equal(f.counts.moderate, phase === 'claim' ? 0 : 1);
  });
});

test('scratch journal survives process reopen, forbids a new review intent, and exposes cleanup without a moderation response', async t => {
  const f = await fixture(t); const { upload } = await f.service.submit(request()); await f.repository.claimNext();
  await f.repository.recordModerationIntent(upload.id, { reference: 'b'.repeat(32), extension: 'png' });
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: f.filename });
  try {
    const repository = createPhotoUploadRepository({ database, policy, now: f.now });
    const [cleanup] = await repository.cleanupCandidates();
    assert.equal(cleanup.moderation_cleanup_pending, 1); assert.equal(cleanup.moderation_cleanup_reference, 'b'.repeat(32));
    await assert.rejects(repository.recordModerationIntent(upload.id, { reference: 'c'.repeat(32), extension: 'png' }), /PHOTO_UPLOAD_REVIEW_ALREADY_DISPATCHED/);
    await f.worker({ repository }).runOnce(); assert.equal(f.counts.moderate, 0);
  } finally { await database.close(); }
});

test('missing or mismatched scratch journal cannot publish and cannot erase prior deletion responsibility', async t => {
  for (const mode of ['missing', 'mismatch', 'throw_after_journal']) await t.test(mode, async t => {
    const f = await fixture(t); const { upload } = await f.service.submit(request());
    const moderator = { async moderate(input) {
      const receipt = await f.moderator.moderate({ ...input, journal: mode === 'missing' ? async () => {} : input.journal });
      if (mode === 'throw_after_journal') throw new Error('LOST_MODERATION_RESPONSE');
      return mode === 'mismatch' ? { ...receipt, cleanupReference: 'f'.repeat(32), cleanupPending: false } : receipt;
    } };
    await f.worker({ moderator }).runOnce(); assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'unknown');
    const [row] = await f.rows('SELECT * FROM mini_photo_uploads');
    if (mode !== 'missing') { assert.equal(row.moderation_cleanup_pending, 1); assert.equal(row.moderation_cleanup_reference, 'a'.repeat(32)); }
    assert.equal((await f.rows('SELECT * FROM mini_photo_assets')).length, 0);
  });
});

test('cleanup sweep sees withdrawal and deleted ready assets without requiring the user to poll', async t => {
  for (const mode of ['withdraw', 'delete']) await t.test(mode, async t => {
    const f = await fixture(t); const { upload } = await f.service.submit(request()); await f.worker().runOnce();
    const ready = await f.repository.readOwned('owner', upload.id);
    if (mode === 'withdraw') await f.context.withdrawFaceConsent('owner'); else await f.context.deleteAsset('owner', ready.assetId);
    const [candidate] = await f.repository.cleanupCandidates(); assert.equal(candidate.id, upload.id); assert.equal(candidate.source_cleanup_pending, 1);
    assert.equal(candidate.state, 'cancelled');
  });
});

test('object bytes changed after queued fail closed before any moderation call', async t => {
  const f = await fixture(t); const { upload } = await f.service.submit(request());
  const [object] = f.objects.values(); object.bytes[30] ^= 1;
  await f.worker().runOnce(); assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'unknown');
  assert.equal(f.counts.moderate, 0); assert.equal((await f.rows('SELECT * FROM mini_photo_assets')).length, 0);
});

test('actual moderator adapter commits scratch journal before fake OSS PUT and binds receipt to the same input', async t => {
  const f = await fixture(t); const { upload } = await f.service.submit(request()); const sequence = [];
  const moderator = createPhotoImageModerator({ policy: { approved: true, version: policy.moderationVersion,
    region: 'cn-shanghai', services: { input: policy.moderationService, output: 'aigcCheck' }, lowRisk: 'review', timeoutMs: 100 },
  storage: {
    async put(objectKey) {
      const [row] = await f.rows('SELECT * FROM mini_photo_uploads WHERE id = ?', [upload.id]);
      assert.equal(row.moderation_cleanup_pending, 1);
      assert.equal(objectKey, `private/photo-moderation/${row.moderation_cleanup_reference}.${row.moderation_cleanup_extension}`);
      sequence.push('put');
    },
    signedUrl: objectKey => `https://fixture-private.oss-cn-shanghai.aliyuncs.com/${objectKey}?Signature=REDACTED_SECRET
    async delete() { sequence.push('delete'); },
  },
  transport: async input => { sequence.push('review'); return { statusCode: 200, body: { Code: 200, RequestId: 'fixture_green_request',
    Data: { DataId: input.serviceParameters.dataId, RiskLevel: 'none', Result: [{ Label: 'nonLabel' }] } } }; }, now: f.now });
  await f.worker({ moderator }).runOnce();
  assert.deepEqual(sequence, ['put', 'review', 'delete']);
  const [row] = await f.rows('SELECT * FROM mini_photo_uploads WHERE id = ?', [upload.id]);
  assert.equal(row.state, 'ready'); assert.equal(row.moderation_cleanup_pending, 0);
  assert.match(row.moderation_cleanup_reference, /^[a-f0-9]{32}$/); assert.equal(row.receipt.includes('fixture_green_request'), true);
});

test('journal commit response loss prevents actual moderator from uploading scratch or auditing, preserves cleanup key', async t => {
  const f = await fixture(t); const { upload } = await f.service.submit(request()); let journalOnce = true; let remoteCalls = 0;
  const repository = { ...f.repository, async recordModerationIntent(...args) {
    const result = await f.repository.recordModerationIntent(...args); if (journalOnce) { journalOnce = false; throw new Error('JOURNAL_COMMIT_REPLY_LOST'); } return result;
  } };
  const moderator = createPhotoImageModerator({ policy: { approved: true, version: policy.moderationVersion,
    region: 'cn-shanghai', services: { input: policy.moderationService, output: 'aigcCheck' }, lowRisk: 'review', timeoutMs: 100 },
  storage: { async put() { remoteCalls++; }, signedUrl() { remoteCalls++; }, async delete() { remoteCalls++; } },
  transport: async () => { remoteCalls++; }, now: f.now });
  await f.worker({ repository, moderator }).runOnce(); await f.worker({ repository, moderator }).runOnce();
  assert.equal(remoteCalls, 0); assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'unknown');
  const [candidate] = await f.repository.cleanupCandidates(); assert.equal(candidate.moderation_cleanup_pending, 1);
  assert.match(candidate.moderation_cleanup_reference, /^[a-f0-9]{32}$/);
});
