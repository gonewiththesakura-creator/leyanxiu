import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createPhotoJobContext, photoContextSchema } from '../photo-jobs/context.js';
import { photoJobsSchema } from '../photo-jobs/repository.js';
import { createPhotoJobWorker } from '../photo-jobs/worker.js';
import { registerPhotoJobRoutes } from '../photo-jobs/routes.js';
import { createPhotoUploadRepository, photoUploadSchema } from '../photo-jobs/upload-repository.js';
import { createPhotoUploadService, createPhotoUploadWorker } from '../photo-jobs/upload-service.js';
import { registerPhotoUploadRoutes } from '../photo-jobs/upload-routes.js';
import { createHash } from 'node:crypto';
const { createCreationClient } = createRequire(import.meta.url)('../../miniprogram/creation.js');

const key = '1'.repeat(32);
const input = { inputAssetId: 'input_one', effectId: 'repair' };
const effect = { id: 'repair', version: 'v1', provider: 'fictional', model: 'fixture-model',
  purpose: 'photo-effect:repair', parameters: { strength: 1 }, enabled: true, reviewReference: 'fixture_review' };
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-routes-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'isolated.sqlite'), migrate: true });
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const timestamp = 100000;
  const ledger = createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now: () => timestamp });
  const context = createPhotoJobContext({ ledger, now: () => timestamp,
    policy: { basicVersion: 'basic_v1', faceVersion: 'face_v1', labelVersion: 'mark_v1' } });
  const rows = (sql, args = []) => database.transaction(q => q(sql, args));
  await database.transaction(async q => {
    for (const sql of photoContextSchema('sqlite')) await q(sql);
    await q(photoJobsSchema('sqlite'));
    for (const userId of ['buyer', 'stranger']) await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [userId, 'fixture_app', userId]);
    await q('INSERT INTO vp_orders(id,user_id,idem,status,payload,created_at) VALUES (?,?,?,?,?,?)',
      ['order1', 'buyer', 'fixture_order_key', 'paid', JSON.stringify({ id: 'order1', userId: 'buyer', status: 'paid', product: { type: 'pack' } }), timestamp]);
    await q('INSERT INTO vp_buckets(id,user_id,order_id,kind,starts_at,expires_at,quantity,remaining,value_fen) VALUES (?,?,?,?,?,?,?,?,?)',
      ['bucket1', 'buyer', 'order1', 'photo', 0, timestamp + 86400000, 10, 10, 990]);
  });
  await context.grantBasicConsent('buyer', 'basic_v1');
  await context.grantFaceConsent('buyer', { version: 'face_v1', subjectAuthorization: 'self' });
  await context.putEffect(effect);
  const asset = (id, kind) => ({ id, storageKey: `private/${kind}/${id}.png`, sha256: 'a'.repeat(64), byteLength: 123,
    contentType: 'image/png', expiresAt: timestamp + 60000, moderation: { decision: 'allow', reference: 'fixture_receipt' },
    ...(kind === 'output' ? { labelVersion: 'mark_v1' } : {}) });
  await context.registerInput('buyer', asset('input_one', 'input'));
  let enabled = true, providerCalls = 0;
  const app = new Hono();
  registerPhotoJobRoutes(app, { context, authenticated: c => {
    const token = c.req.header('authorization');
    return { auth: token === 'Bearer buyer' ? { userId: 'buyer', authMethod: 'wechat' }
      : token === 'Bearer stranger' ? { userId: 'stranger', authMethod: 'wechat' }
      : token === 'Bearer legacy' ? { userId: 'buyer', authMethod: 'app' } : null };
  }, readiness: () => ({ ready: enabled, photoEffectIds: ['repair'] }) });
  const request = async (url = '/api/mini/photo-jobs', { method = 'POST', body = input, user = 'buyer', idem = key } = {}) => {
    const response = await app.request(url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${user}`, 'Idempotency-Key': idem },
      ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const worker = createPhotoJobWorker({ repository: context.repository, runProvider: async ({ jobId, userId, spec }) => {
    providerCalls++; assert.equal(spec.model, 'fixture-model');
    await context.registerOutput(userId, jobId, asset('output_one', 'output'));
    return { assetId: 'output_one', providerRef: 'fixture_provider_receipt' };
  } });
  return { app, database, ledger, context, rows, request, worker, close: () => { enabled = false; }, providerCalls: () => providerCalls,
    credits: async () => (await rows('SELECT remaining,reserved FROM vp_buckets'))[0] };
}

test('HTTP submission reserves once, returns 202 without a provider call, and GET recovers after reply loss', async t => {
  const f = await fixture(t);
  const accepted = await f.request(); // Deliberately discard the response in the recovery client.
  assert.equal(accepted.status, 202); assert.equal(accepted.body.data.job.state, 'queued');
  assert.equal(f.providerCalls(), 0); assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  const lookup = await f.request(`/api/mini/photo-jobs/by-key/${key}`, { method: 'GET' });
  assert.deepEqual(lookup.body.data.job, accepted.body.data.job);
  assert.match(lookup.headers.get('cache-control'), /no-store/);
  const retries = await Promise.all(Array.from({ length: 8 }, () => f.request()));
  assert.ok(retries.every(r => r.status === 200 && r.body.data.duplicate));
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  await f.worker.runOnce(); await f.worker.runOnce();
  const done = await f.request(`/api/mini/photo-jobs/${accepted.body.data.job.id}`, { method: 'GET' });
  assert.equal(done.body.data.job.state, 'succeeded'); assert.equal(done.body.data.job.assetId, 'output_one');
  assert.equal(f.providerCalls(), 1); assert.deepEqual(await f.credits(), { remaining: 9, reserved: 0 });
  assert.equal((await f.context.listWorks('buyer')).length, 1);
  assert.doesNotMatch(JSON.stringify([accepted.body, lookup.body, done.body]), /storageKey|fixture-model|sha256|providerRef|billingRef|private\//);
});

test('unauthenticated/legacy requests and forged server fields cannot reserve or expose another account job', async t => {
  const f = await fixture(t);
  for (const user of ['none', 'legacy']) {
    assert.equal((await f.request(undefined, { user })).status, 401);
    assert.equal((await f.request(`/api/mini/photo-jobs/by-key/${key}`, { method: 'GET', user })).status, 401);
  }
  for (const field of ['userId', 'provider', 'model', 'effectVersion', 'purpose', 'billingRef', 'storageKey', 'moderation', 'labelVersion']) {
    assert.equal((await f.request(undefined, { body: { ...input, [field]: 'forged' } })).status, 400);
  }
  assert.deepEqual(await f.credits(), { remaining: 10, reserved: 0 });
  const { job } = (await f.request()).body.data;
  assert.equal((await f.request(`/api/mini/photo-jobs/${job.id}`, { method: 'GET', user: 'stranger' })).status, 404);
  assert.equal((await f.request(`/api/mini/photo-jobs/by-key/${key}`, { method: 'GET', user: 'stranger' })).body.data.job, null);
  assert.equal((await f.request(undefined, { user: 'stranger' })).status, 403);
  assert.equal(f.providerCalls(), 0);
});

test('closed creation and changed effects block new work but preserve owned idempotent recovery', async t => {
  const f = await fixture(t); const original = (await f.request()).body.data.job;
  await f.context.putEffect({ ...effect, version: 'v2', model: 'different-approved-model' });
  await f.context.withdrawFaceConsent('buyer'); f.close();
  const replay = await f.request();
  assert.equal(replay.status, 200); assert.deepEqual(replay.body.data.job, original);
  assert.equal((await f.request(undefined, { idem: '2'.repeat(32) })).body.code, 'PHOTO_JOB_NOT_AVAILABLE');
  assert.equal((await f.request(undefined, { body: { ...input, inputAssetId: 'other_input' } })).body.code, 'PHOTO_JOB_IDEMPOTENCY_CONFLICT');
  assert.equal((await f.request(`/api/mini/photo-jobs/${original.id}`, { method: 'GET' })).status, 200);
  await f.worker.runOnce();
  assert.equal(f.providerCalls(), 0); assert.deepEqual(await f.credits(), { remaining: 10, reserved: 0 });
});

test('malformed requests never create jobs; missing lookup and ambiguous database failures do not invent a terminal state', async t => {
  const f = await fixture(t);
  for (const body of ['{', 'null', '[]', { ...input, inputAssetId: 'https://outside.test/a' }, { effectId: 'repair' }]) {
    assert.equal((await f.request(undefined, { body })).status, 400);
  }
  assert.equal((await f.request(undefined, { body: ' '.repeat(1025) })).status, 413);
  assert.equal((await f.request(undefined, { idem: 'weak' })).status, 400);
  assert.equal((await f.request(`/api/mini/photo-jobs/by-key/${key}`, { method: 'GET' })).body.data.job, null);
  assert.deepEqual(await f.credits(), { remaining: 10, reserved: 0 });
  const submit = f.context.repository.submit;
  f.context.repository.submit = async spec => { await submit(spec); throw new Error('SQL-secret-storage-key'); };
  const response = await f.request();
  assert.equal(response.status, 503); assert.equal(response.body.code, 'PHOTO_JOB_UNCONFIRMED');
  assert.doesNotMatch(JSON.stringify(response.body), /SQL-secret/);
  assert.equal((await f.request(`/api/mini/photo-jobs/by-key/${key}`, { method: 'GET' })).body.data.job.state, 'queued');
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
});

function nativeFixture(f, { discardSubmission = false, uploadService } = {}) {
  // These are explicit synthetic media/auth adapters, not a production
  // deployment or a claim that a real image/moderation service was called.
  const respond = data => ({ code: 0, data });
  f.app.post('/api/auth/wechat', c => c.json(respond({ token: 'buyer', user: { id: 'buyer' } })));
  f.app.get('/api/catalog', c => c.json(respond({ settings: { generationEnabled: true },
    miniProgramCreation: { available: true, jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1', photoEffectIds: ['repair'] },
    photoEffects: [{ id: 'repair', title: 'Fixture repair', enabled: true }] })));
  f.app.get('/api/public/compliance', c => c.json(respond({ status: 'approved', operatorName: 'Fictional test operator',
    consentVersions: { basic: 'basic_v1', faceProcessing: 'face_v1' },
    retention: { sourceHours: 24, resultHours: 24, supplierPolicy: 'Synthetic test policy' },
    aiServices: [{ provider: 'fictional', model: 'fixture-model', filingReference: 'fictional-reference',
      purpose: 'test', region: 'fictional', capabilities: ['photo-effect'] }] })));
  f.app.get('/api/capabilities', c => c.json(respond([{ id: 'photo-effects', ready: true, status: 'verified' }])));
  f.app.get('/api/mini/payments/entitlements', async c => c.json(respond(await f.ledger.entitlements('buyer'))));
  f.app.get('/api/works', async c => c.json(respond(await f.context.listWorks('buyer'))));
  f.app.get('/api/consents', async c => c.json(respond(await f.context.readConsents('buyer'))));
  f.app.post('/api/consents', async c => {
    const body = await c.req.json();
    if (body.consentType === 'basic') await f.context.grantBasicConsent('buyer', body.version);
    else await f.context.grantFaceConsent('buyer', body);
    return c.json(respond({ granted: true }));
  });
  if (uploadService) registerPhotoUploadRoutes(f.app, { service: uploadService,
    authenticated: c => ({ auth: c.req.header('authorization') === 'Bearer buyer' ? { userId: 'buyer', authMethod: 'wechat' } : null }),
    readiness: () => ({ ready: true }) });
  else f.app.post('/api/mini/photo-uploads', c => c.json(respond({ upload: {
    id: `upload_${'a'.repeat(32)}`, state: 'ready', assetId: 'input_one', createdAt: 1, updatedAt: 1,
  }, duplicate: false }), 202));
  f.app.get('/api/assets/:id/url', async c => {
    const asset = await f.context.readOwnedAsset('buyer', c.req.param('id'));
    return asset ? c.json(respond({ assetId: asset.assetId, url: 'https://example.test/fictional-private-output' }))
      : c.json({ code: 'NOT_FOUND' }, 404);
  });
  const storage = new Map(), requests = [];
  let randomCalls = 0;
  const wx = {
    getStorageSync: name => storage.get(name), setStorageSync: (name, value) => storage.set(name, structuredClone(value)),
    removeStorageSync: name => storage.delete(name),
    login: options => options.success({ code: 'fictional_login_code' }),
    getRandomValues: options => options.success({ randomValues: new Uint8Array(16).fill(++randomCalls).buffer }),
    requestVirtualPayment: () => assert.fail('creation cannot charge WeChat'),
    cloud: { callContainer: async options => {
      requests.push({ path: options.path, method: options.method });
      assert.ok(options.timeout <= 15000);
      const response = await f.app.request(options.path, { method: options.method, headers: options.header,
        ...(options.data ? { body: JSON.stringify(options.data) } : {}) });
      if (options.path === '/api/mini/photo-jobs' && discardSubmission) {
        discardSubmission = false; assert.equal(response.status, 202); throw new Error('response lost after committed transaction');
      }
      return { statusCode: response.status, data: await response.json() };
    } },
  };
  const endpoint = { mode: 'cloud', env: 'fictional-env', service: 'fixture-service' };
  const restart = () => createCreationClient(wx, endpoint, { enabled: true });
  return { storage, requests, restart, generate: client => client.generate({ image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lZkAAAAASUVORK5CYII=', effectId: 'repair',
    consent: { basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self', basicVersion: 'basic_v1', faceVersion: 'face_v1' } }) };
}

test('native cloud client recovers a lost accepted response through the real HTTP repository and same ledger', async t => {
  const f = await fixture(t);
  const native = nativeFixture(f, { discardSubmission: true });
  const { storage, requests } = native;
  await assert.rejects(native.generate(native.restart()),
  error => error.code === 'CREATION_UNCONFIRMED');
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  const restarted = native.restart();
  assert.equal((await restarted.refresh()).job.state, 'queued');
  await f.worker.runOnce();
  const finished = await restarted.refresh();
  assert.equal(finished.pending, null); assert.equal(finished.result.assetId, 'output_one');
  assert.equal(finished.photo, 9); assert.equal(finished.works.length, 1); assert.equal(storage.size, 0);
  assert.equal(requests.filter(r => r.path === '/api/mini/photo-jobs' && r.method === 'POST').length, 1);
  assert.equal(f.providerCalls(), 1); assert.deepEqual(await f.credits(), { remaining: 9, reserved: 0 });
});

test('canonical ledger budget rejection rolls back, returns a definite HTTP error and lets the native client recover without a stuck key', async t => {
  const previousLimit = process.env.USER_DAILY_GENERATION_LIMIT;
  t.after(() => { if (previousLimit === undefined) delete process.env.USER_DAILY_GENERATION_LIMIT; else process.env.USER_DAILY_GENERATION_LIMIT = previousLimit; });
  process.env.USER_DAILY_GENERATION_LIMIT = '1';
  const f = await fixture(t);
  const native = nativeFixture(f);
  assert.equal((await f.request()).status, 202); // One existing reservation consumes the test budget.
  const client = native.restart();
  await assert.rejects(native.generate(client), error => error.code === 'XPAY_PROVIDER_BUDGET_LIMIT' && error.statusCode === 429);
  const rejectedKey = '02'.repeat(16);
  assert.equal((await f.request(`/api/mini/photo-jobs/by-key/${rejectedKey}`, { method: 'GET' })).body.data.job, null);
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  assert.equal((await f.rows('SELECT * FROM vp_reservations')).length, 1);
  assert.equal((await f.rows('SELECT * FROM mini_photo_jobs')).length, 1);
  assert.equal(native.storage.size, 0); assert.equal(f.providerCalls(), 0);
  assert.equal((await native.restart().refresh()).pending, null);
  assert.equal(native.requests.filter(r => r.path === '/api/mini/photo-jobs' && r.method === 'POST').length, 1);
  // A later explicit user attempt can proceed after capacity is restored.
  process.env.USER_DAILY_GENERATION_LIMIT = '2';
  assert.equal((await native.generate(client)).job.state, 'queued');
  assert.deepEqual(await f.credits(), { remaining: 8, reserved: 2 });
  assert.equal(f.providerCalls(), 0);
});

test('a committed submission followed by a database acknowledgement failure remains locked and recovers only the original job', async t => {
  const f = await fixture(t);
  const submit = f.context.repository.submit;
  f.context.repository.submit = async spec => { await submit(spec); throw Object.assign(new Error('commit acknowledgement unavailable'), { code: 'DB_COMMIT_UNKNOWN' }); };
  const native = nativeFixture(f);
  await assert.rejects(native.generate(native.restart()), error => error.code === 'CREATION_UNCONFIRMED');
  assert.equal(native.storage.size, 1);
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  const restarted = native.restart();
  assert.equal((await restarted.refresh()).job.state, 'queued');
  await assert.rejects(native.generate(restarted), error => error.code === 'CREATION_UNCONFIRMED');
  assert.equal(native.storage.size, 1);
  assert.equal(native.requests.filter(r => r.path === '/api/mini/photo-jobs' && r.method === 'POST').length, 1);
  assert.equal(f.providerCalls(), 0);
});

test('native client crosses the actual durable upload, review, asset and canonical generation HTTP boundaries once', async t => {
  const f = await fixture(t); await f.rows(photoUploadSchema('sqlite'));
  const policy = { basicVersion: 'basic_v1', faceVersion: 'face_v1', moderationVersion: 'review_v1', moderationService: 'baselineCheck',
    sourceRetentionMs: 86400000, maxDailyUploads: 100, maxDailyUploadsPerUser: 10 };
  const repository = createPhotoUploadRepository({ database: f.database, policy, now: () => 100000 });
  const objects = new Map(); let puts = 0, reviews = 0;
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const storage = { async put(key, bytes, options) { puts++; objects.set(key, { bytes: Buffer.from(bytes), contentType: options.contentType }); },
    async read(key) { const object = objects.get(key); return object ? { found: true, ...object, sha256: hash(object.bytes), byteLength: object.bytes.length } : { found: false }; } };
  const uploadService = createPhotoUploadService({ repository, storage });
  const uploadWorker = createPhotoUploadWorker({ repository, storage, moderator: { async moderate({ bytes, direction, journal }) {
    await journal({ reference: 'a'.repeat(32), extension: 'png' }); reviews++;
    return { provider: 'aliyun-green', policyVersion: policy.moderationVersion, service: policy.moderationService,
      direction, sha256: hash(bytes), byteLength: bytes.length, decision: 'allow', requestId: 'fixture_review',
      reference: `mod_${'b'.repeat(64)}`, cleanupPending: false, cleanupReference: 'a'.repeat(32), cleanupExtension: 'png' };
  } } });
  const native = nativeFixture(f, { uploadService }); const client = native.restart();
  assert.equal((await native.generate(client)).job.state, 'upload_queued');
  assert.deepEqual(await f.credits(), { remaining: 10, reserved: 0 }); assert.equal(puts, 1); assert.equal(reviews, 0);
  const before = structuredClone(native.storage.get('lyx-creation-pending:buyer'));
  await uploadWorker.runOnce();
  const ready = await client.refresh(); assert.equal(ready.job.state, 'queued');
  assert.equal(puts, 1); assert.equal(reviews, 1); assert.deepEqual(await f.credits(), { remaining: 9, reserved: 1 });
  assert.equal(native.storage.get('lyx-creation-pending:buyer').idempotencyKey, before.generationKey);
  await f.worker.runOnce(); const completed = await client.refresh();
  assert.equal(completed.pending, null); assert.equal(completed.result.assetId, 'output_one');
  assert.equal(completed.works.length, 1); assert.equal(f.providerCalls(), 1);
  assert.equal(native.requests.filter(call => call.path === '/api/mini/photo-uploads' && call.method === 'POST').length, 1);
  assert.equal(native.requests.filter(call => call.path === '/api/mini/photo-jobs' && call.method === 'POST').length, 1);
  assert.deepEqual(await f.credits(), { remaining: 9, reserved: 0 });
});
