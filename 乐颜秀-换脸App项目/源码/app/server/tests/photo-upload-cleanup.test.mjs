import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createPhotoJobContext, photoContextSchema } from '../photo-jobs/context.js';
import { createPhotoUploadRepository, photoUploadSchema, photoUploadCleanupSchema, parsePhotoUpload } from '../photo-jobs/upload-repository.js';
import { createPhotoCleanupOssStorage } from '../photo-jobs/upload-storage.js';
import { createPhotoUploadCleanupWorker } from '../photo-jobs/upload-cleanup.js';

const uploadPolicy = { basicVersion: 'basic_1', faceVersion: 'face_1', moderationVersion: 'review_1', moderationService: 'baselineCheck',
  sourceRetentionMs: 86400000, maxDailyUploads: 100, maxDailyUploadsPerUser: 100 };
const cleanupPolicy = { timeoutMs: 20, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000 };
const timing = { ...cleanupPolicy, claimHoldMs: 1040 };
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XAZkAAAAASUVORK5CYII=';
const source = parsePhotoUpload(image);
const key = n => n.toString(16).padStart(32, '0');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-upload-cleanup-'));
  const filename = path.join(directory, 'fixture.sqlite');
  const database = await openVirtualDatabase({ backend: 'sqlite', filename, migrate: true });
  let closed = false;
  t.after(async () => { if (!closed) await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let timestamp = 1000000; const now = () => timestamp;
  await database.transaction(async q => {
    for (const sql of photoContextSchema('sqlite')) await q(sql);
    await q(photoUploadSchema('sqlite')); await q(photoUploadCleanupSchema('sqlite'));
    await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', ['owner', 'fixture_app', 'fixture_openid']);
  });
  const context = createPhotoJobContext({ ledger: createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now }),
    policy: { ...uploadPolicy, labelVersion: 'label_1' }, now });
  await context.grantBasicConsent('owner', uploadPolicy.basicVersion);
  await context.grantFaceConsent('owner', { version: uploadPolicy.faceVersion, subjectAuthorization: 'self' });
  const repository = createPhotoUploadRepository({ database, policy: { ...uploadPolicy, ...options.uploadPolicy }, now });
  const rows = (sql, args = []) => database.transaction(q => q(sql, args));
  const objects = new Map(); const calls = [];
  const storage = kind => ({
    async delete(storageKey) {
      const pending = await rows('SELECT state,attempts,operation_token FROM mini_photo_upload_cleanup WHERE storage_key = ?', [storageKey]);
      assert.equal(pending[0]?.state, 'observing', 'DELETE must follow a durable attempt commit');
      assert.ok(pending[0].attempts >= 1); assert.match(pending[0].operation_token, /^[a-f0-9]{32}$/);
      calls.push({ type: 'delete', kind, key: storageKey }); objects.delete(storageKey); return { acknowledged: true };
    },
    async inspect(storageKey) { calls.push({ type: 'inspect', kind, key: storageKey }); return { found: objects.has(storageKey) }; },
  });
  const sourceStorage = storage('source'); const moderationStorage = storage('moderation');
  const worker = overrides => createPhotoUploadCleanupWorker({ repository, sourceStorage, moderationStorage, policy: cleanupPolicy, ...overrides });
  const makeUpload = async (n = 1) => {
    const result = await repository.submitIntent({ userId: 'owner', idempotencyKey: key(n), ...source });
    objects.set(result.storageKey, Buffer.from(source.bytes));
    await repository.confirmStored(result.upload.id, source);
    return { ...result.upload, storageKey: result.storageKey };
  };
  const journal = async upload => {
    assert.equal((await repository.claimNext()).id, upload.id);
    const reference = upload.id.slice(7);
    await repository.recordModerationIntent(upload.id, { reference, extension: 'png' });
    const scratchKey = `private/photo-moderation/${reference}.png`;
    objects.set(scratchKey, Buffer.from(source.bytes)); return { reference, scratchKey };
  };
  const publish = async upload => {
    const scratch = await journal(upload);
    await repository.recordReview(upload.id, { provider: 'aliyun-green', policyVersion: uploadPolicy.moderationVersion,
      service: uploadPolicy.moderationService, direction: 'input', ...source, decision: 'allow', reference: `mod_${'1'.repeat(64)}`,
      requestId: 'fixture_request', cleanupPending: true, cleanupReference: scratch.reference, cleanupExtension: 'png' });
    const ready = await repository.publishNext(); return { ...ready, ...scratch };
  };
  return { database, filename, repository, context, rows, now, objects, calls, sourceStorage, moderationStorage, worker, makeUpload, journal, publish,
    advance: amount => { timestamp += amount; }, close: async () => { await database.close(); closed = true; } };
}

test('active source is never deleted just because upload review failed or source_cleanup_pending is set', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); await f.journal(upload);
  await f.repository.recordReview(upload.id, { decision: 'unconfirmed' });
  await f.worker().runOnce();
  assert.equal(f.calls.filter(x => x.type === 'delete' && x.kind === 'source').length, 0);
  assert.equal(f.objects.has(upload.storageKey), true);
  assert.equal((await f.repository.cleanupJournal(upload.id)).every(row => row.kind === 'moderation'), true);
});

test('expiry deletion records intent before IO and repeated absence remains scheduled, never permanent', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); f.advance(uploadPolicy.sourceRetentionMs + 1);
  const result = await f.worker().runOnce(); assert.equal(result.observation, 'absent'); assert.equal(result.permanentErasureConfirmed, false);
  const [first] = await f.repository.cleanupJournal(upload.id);
  assert.equal(first.state, 'absent_observed'); assert.equal(first.attempts, 1); assert.equal(first.absent_observations, 1);
  assert.equal(first.next_at, f.now() + cleanupPolicy.recheckAfterMs); assert.equal(first.last_absent_at, f.now());
  assert.equal(await f.worker().runOnce(), null);
  f.advance(cleanupPolicy.recheckAfterMs + 1); await f.worker().runOnce();
  const [second] = await f.repository.cleanupJournal(upload.id);
  assert.equal(second.attempts, 2); assert.equal(second.absent_observations, 2); assert.equal(second.state, 'absent_observed');
  assert.equal((await f.rows('SELECT source_cleanup_pending FROM mini_photo_uploads'))[0].source_cleanup_pending, 1);
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM vp_reservations'))[0].n, 0);
});

test('PUT arriving after multiple absent observations is deleted on a later durable check', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); f.advance(uploadPolicy.sourceRetentionMs + 1);
  for (let n = 0; n < 3; n++) { await f.worker().runOnce(); f.advance(cleanupPolicy.recheckAfterMs + 1); }
  f.objects.set(upload.storageKey, Buffer.from(source.bytes));
  await f.worker().runOnce(); assert.equal(f.objects.has(upload.storageKey), false);
  const [row] = await f.repository.cleanupJournal(upload.id); assert.equal(row.attempts, 4); assert.equal(row.state, 'absent_observed');
  assert.ok(row.next_at > f.now());
});

test('PUT racing DELETE before HEAD records present and retries deletion without reupload or reaudit', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); f.advance(uploadPolicy.sourceRetentionMs + 1); let insertLate = true;
  const sourceStorage = { ...f.sourceStorage, async delete(storageKey) {
    const result = await f.sourceStorage.delete(storageKey);
    if (insertLate) { insertLate = false; f.objects.set(storageKey, Buffer.from(source.bytes)); } return result;
  } };
  const first = await f.worker({ sourceStorage }).runOnce(); assert.equal(first.observation, 'present');
  const [row] = await f.repository.cleanupJournal(upload.id); assert.equal(row.state, 'present'); assert.equal(row.last_present_at, f.now());
  f.advance(cleanupPolicy.retryAfterMs + 1); await f.worker({ sourceStorage }).runOnce(); assert.equal(f.objects.has(upload.storageKey), false);
  assert.equal((await f.rows('SELECT attempts FROM mini_photo_uploads'))[0].attempts, 0);
});

test('DELETE acknowledgement lost plus HEAD404 is unknown; HEAD errors never masquerade as absence', async t => {
  for (const mode of ['delete_lost', 'head_denied', 'malformed_head']) await t.test(mode, async t => {
    const f = await fixture(t); const upload = await f.makeUpload(); f.advance(uploadPolicy.sourceRetentionMs + 1);
    const sourceStorage = { ...f.sourceStorage,
      async delete(storageKey) { const result = await f.sourceStorage.delete(storageKey); if (mode === 'delete_lost') throw new Error('PRIVATE_KEY_LOST_RESPONSE'); return result; },
      async inspect(storageKey) { if (mode === 'head_denied') throw new Error('PRIVATE_CREDENTIAL_403'); if (mode === 'malformed_head') return {}; return f.sourceStorage.inspect(storageKey); },
    };
    await f.worker({ sourceStorage }).runOnce(); const [row] = await f.repository.cleanupJournal(upload.id);
    assert.equal(row.state, 'unknown'); assert.equal(row.next_at, f.now() + cleanupPolicy.retryAfterMs);
    assert.equal(row.observation, mode === 'delete_lost' ? 'absent' : 'unknown');
    assert.equal(row.delete_status, mode === 'delete_lost' ? 'unknown' : 'acknowledged');
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE_/);
  });
});

test('reopening after crash between delete-intent commit and DELETE only retries deletion after its hold', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); f.advance(uploadPolicy.sourceRetentionMs + 1);
  await f.repository.prepareCleanup(timing); const abandoned = await f.repository.claimCleanup(timing); assert.ok(abandoned); await f.close();
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: f.filename });
  try {
    const repository = createPhotoUploadRepository({ database, policy: uploadPolicy, now: f.now }); let deleted = 0;
    const storage = { async delete(storageKey) { deleted++; f.objects.delete(storageKey); return { acknowledged: true }; }, async inspect(storageKey) { return { found: f.objects.has(storageKey) }; } };
    const worker = createPhotoUploadCleanupWorker({ repository, sourceStorage: storage, moderationStorage: storage, policy: cleanupPolicy });
    assert.equal(await worker.runOnce(), null); assert.equal(deleted, 0);
    f.advance(timing.claimHoldMs + 1); await worker.runOnce(); assert.equal(deleted, 1);
    const [row] = await repository.cleanupJournal(upload.id); assert.equal(row.attempts, 2); assert.equal(row.state, 'absent_observed');
  } finally { await database.close(); }
});

test('cleanup claim commit response loss performs no DELETE; observation response loss preserves committed evidence', async t => {
  for (const phase of ['claim', 'observation']) await t.test(phase, async t => {
    const f = await fixture(t); const upload = await f.makeUpload(); f.advance(uploadPolicy.sourceRetentionMs + 1); let loseOnce = true;
    const database = { ...f.database, async transaction(callback) {
      let changed = false;
      const result = await f.database.transaction(q => callback(async (sql, args) => {
        if (phase === 'claim' ? sql.includes("SET state = 'observing'") : sql.includes('SET state = ?,delete_status = ?')) changed = true;
        return q(sql, args);
      }));
      if (changed && loseOnce) { loseOnce = false; throw new Error('FIXTURE_COMMIT_REPLY_LOST'); } return result;
    } };
    const repository = createPhotoUploadRepository({ database, policy: uploadPolicy, now: f.now });
    await assert.rejects(f.worker({ repository }).runOnce(), /FIXTURE_COMMIT_REPLY_LOST/);
    const [row] = await f.repository.cleanupJournal(upload.id);
    assert.equal(f.calls.filter(x => x.type === 'delete').length, phase === 'claim' ? 0 : 1);
    assert.equal(row.state, phase === 'claim' ? 'observing' : 'absent_observed');
    assert.equal(await f.worker().runOnce(), null);
    f.advance(Math.max(timing.claimHoldMs, cleanupPolicy.recheckAfterMs) + 1); await f.worker().runOnce();
    assert.equal((await f.repository.cleanupJournal(upload.id))[0].attempts, 2);
  });
});

test('concurrent cleaners claim one due attempt; stale response cannot overwrite a later attempt', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); f.advance(uploadPolicy.sourceRetentionMs + 1);
  await Promise.all(Array.from({ length: 12 }, () => f.worker().runOnce()));
  assert.equal(f.calls.filter(x => x.type === 'delete').length, 1);
  f.advance(cleanupPolicy.recheckAfterMs + 1); const old = await f.repository.claimCleanup(timing);
  f.advance(timing.claimHoldMs + 1); const current = await f.repository.claimCleanup(timing);
  assert.notEqual(old.operationToken, current.operationToken);
  assert.equal(await f.repository.recordCleanupObservation(old, { deleteAcknowledged: true, observation: 'absent' }, timing), false);
  assert.equal(await f.repository.recordCleanupObservation(current, { deleteAcknowledged: false, observation: 'unknown' }, timing), true);
  assert.equal(await f.repository.recordCleanupObservation(old, { deleteAcknowledged: true, observation: 'absent' }, timing), false);
  assert.equal((await f.repository.cleanupJournal(upload.id))[0].state, 'unknown');
});

test('active scratch is protected; expired in-flight window permits cleanup but never reclaims moderation', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); const scratch = await f.journal(upload);
  assert.equal(await f.worker().runOnce(), null); assert.equal(f.objects.has(scratch.scratchKey), true);
  f.advance(cleanupPolicy.inFlightGraceMs + 1); await f.worker().runOnce();
  assert.equal(f.objects.has(scratch.scratchKey), false); assert.equal(f.objects.has(upload.storageKey), true);
  assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'claimed');
  assert.equal(await f.repository.claimNext(), null); assert.equal((await f.rows('SELECT attempts FROM mini_photo_uploads'))[0].attempts, 1);
});

test('withdrawal racing cleanup preparation cannot lose source or scratch deletion responsibility', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); const scratch = await f.journal(upload);
  await Promise.all([f.repository.prepareCleanup(timing), f.context.withdrawFaceConsent('owner')]);
  await f.worker().runOnce(); await f.worker().runOnce();
  assert.equal(f.objects.has(upload.storageKey), false); assert.equal(f.objects.has(scratch.scratchKey), false);
  const rows = await f.repository.cleanupJournal(upload.id); assert.deepEqual(rows.map(x => x.kind), ['moderation', 'source']);
  assert.ok(rows.every(x => x.state === 'absent_observed' && x.next_at > f.now()));
  assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'cancelled');
});

test('source stays intact while ready; explicit asset deletion permits cleanup and regrant never resurrects old epoch', async t => {
  const f = await fixture(t); const upload = await f.makeUpload(); const ready = await f.publish(upload);
  await f.worker().runOnce(); assert.equal(f.objects.has(upload.storageKey), true);
  await f.context.deleteAsset('owner', ready.assetId); await f.worker().runOnce(); assert.equal(f.objects.has(upload.storageKey), false);
  const [sourceRow] = (await f.repository.cleanupJournal(upload.id)).filter(x => x.kind === 'source'); assert.equal(sourceRow.state, 'absent_observed');
  await f.context.withdrawFaceConsent('owner'); await f.context.grantFaceConsent('owner', { version: uploadPolicy.faceVersion, subjectAuthorization: 'self' });
  assert.equal((await f.repository.readOwned('owner', upload.id)).state, 'cancelled');
  assert.equal(await f.context.readOwnedAsset('owner', ready.assetId), null);
});

test('policy version change alone does not prematurely delete an unexpired source', async t => {
  const f = await fixture(t); const upload = await f.makeUpload();
  const repository = createPhotoUploadRepository({ database: f.database, policy: { ...uploadPolicy, moderationVersion: 'review_2' }, now: f.now });
  await f.worker({ repository }).runOnce(); assert.equal(f.calls.length, 0); assert.equal(f.objects.has(upload.storageKey), true);
  assert.equal((await repository.readOwned('owner', upload.id)).state, 'cancelled');
});

test('drain during preparation blocks a new deletion; timeout remains unknown and schedules recovery', async t => {
  const f = await fixture(t); await f.makeUpload(); f.advance(uploadPolicy.sourceRetentionMs + 1); const gate = deferred(); const entered = deferred();
  const repository = { ...f.repository, async prepareCleanup(settings) { await f.repository.prepareCleanup(settings); entered.resolve(); await gate.promise; } };
  const worker = f.worker({ repository }); const work = worker.runOnce(); await entered.promise; const drain = worker.drain(); gate.resolve(); await work; await drain;
  assert.equal(f.calls.length, 0); assert.equal(await worker.runOnce(), null);
  const never = new Promise(() => {});
  const timed = f.worker({ sourceStorage: { delete: () => never, inspect: () => never } }); const result = await timed.runOnce();
  assert.equal(result.observation, 'unknown'); assert.equal(result.deleteAcknowledged, false);
});

test('default cleanup OSS ports restrict scope and distinguish authenticated absence from access failure', async () => {
  const calls = []; const sourceKey = `private/mini-photo-input/${key(1)}.png`; const scratchKey = `private/photo-moderation/${key(1)}.png`;
  const client = { async delete(objectKey, options) { calls.push(['delete', objectKey, options]); return { res: { status: 204 } }; },
    async head(objectKey, options) { calls.push(['head', objectKey, options]); throw { code: 'NoSuchKey', status: 404 }; } };
  const storage = createPhotoCleanupOssStorage({ kind: 'source', bucket: 'fixture-bucket', region: 'cn-shanghai', client });
  assert.deepEqual(await storage.delete(sourceKey, { timeoutMs: 50 }), { acknowledged: true });
  assert.deepEqual(await storage.inspect(sourceKey, { timeoutMs: 50 }), { found: false });
  await assert.rejects(storage.delete(scratchKey, { timeoutMs: 50 }), /CLEANUP_KEY_INVALID/);
  await assert.rejects(storage.delete('private/mini-photo-input/../../other', { timeoutMs: 50 }), /CLEANUP_KEY_INVALID/);
  assert.equal(calls.length, 2); assert.equal(calls[0][2].timeout, 50);
  const denied = createPhotoCleanupOssStorage({ kind: 'moderation', bucket: 'fixture-bucket', region: 'cn-shanghai', client: {
    async head() { throw { code: 'AccessDenied', status: 403 }; }, async delete() { return {}; },
  } });
  await assert.rejects(denied.inspect(scratchKey, { timeoutMs: 50 }), /HEAD_UNCONFIRMED/);
  await assert.rejects(denied.delete(scratchKey, { timeoutMs: 50 }), /DELETE_UNCONFIRMED/);
});

test('discovery caps account locking to 100 new upload candidates and later rows progress without polling', async t => {
  const f = await fixture(t, { uploadPolicy: { maxDailyUploads: 200, maxDailyUploadsPerUser: 200 } });
  for (let n = 1; n <= 105; n++) await f.makeUpload(n);
  f.advance(uploadPolicy.sourceRetentionMs + 1);
  let locks = 0;
  const database = { ...f.database, transaction: callback => f.database.transaction(q => callback((sql, args) => {
    if (sql.startsWith('SELECT user_id FROM vp_accounts WHERE user_id = ?')) locks++;
    return q(sql, args);
  })) };
  const repository = createPhotoUploadRepository({ database, policy: uploadPolicy, now: f.now });
  assert.equal(await repository.prepareCleanup(timing), 100); assert.equal(locks, 100);
  const late = await f.makeUpload(106); await f.context.withdrawFaceConsent('owner'); locks = 0;
  assert.equal(await repository.prepareCleanup(timing), 6); assert.equal(locks, 6);
  assert.equal((await repository.cleanupJournal(late.id))[0].state, 'pending');
  locks = 0; assert.equal(await repository.prepareCleanup(timing), 0); assert.equal(locks, 0);
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_upload_cleanup'))[0].n, 106);
});
