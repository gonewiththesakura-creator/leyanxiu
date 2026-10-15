import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { Hono } from 'hono';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { photoContextSchema } from '../photo-jobs/context.js';
import { photoJobsSchema } from '../photo-jobs/repository.js';
import { photoUploadSchema, photoUploadCleanupSchema } from '../photo-jobs/upload-repository.js';
import { createPhotoApplication } from '../photo-jobs/application.js';
import { createPhotoGenerationRepository, photoGenerationSchema } from '../photo-jobs/generation-repository.js';
import { createPhotoGenerationPipeline } from '../photo-jobs/generation-pipeline.js';
import { createPhotoGenerationCleanupRepository, createPhotoGenerationCleanupWorker } from '../photo-jobs/generation-cleanup.js';
import { createPhotoMediaPorts } from '../photo-jobs/media-ports.js';
import { createPhotoUploadOssStorage, createPhotoCleanupOssStorage } from '../photo-jobs/upload-storage.js';
import { createPhotoOutputOssStorage } from '../photo-jobs/output-storage.js';
import { createPhotoImageModerator, createOssModerationStorage, createGreenImageTransport } from '../photo-jobs/moderation.js';
import { createQwenPhotoProvider, QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_RESULT_HOSTS } from '../photo-jobs/qwen-provider.js';
import { createPhotoImageMarker } from '../photo-jobs/image-marker.js';
const { createCreationClient } = createRequire(import.meta.url)('../../miniprogram/creation.js');

const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMISKkAAAI0AS3HG8jrAAAAAElFTkSuQmCC';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const key = n => n.toString(16).padStart(32, '0');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const effect = { id: 'repair', version: 'v1', provider: 'fictional', model: 'fixture-model', purpose: 'photo-effect:repair',
  parameters: { prompt: 'fictional server-only prompt', strength: 1 }, enabled: true, approved: true, reviewReference: 'fixture_review_v1', title: '测试照片修复' };
const policy = { basicVersion: 'basic_v1', faceVersion: 'face_v1', labelVersion: 'mark_v1', moderationVersion: 'review_v1',
  moderationService: 'baselineCheck', sourceRetentionMs: 86400000, resultRetentionMs: 86400000,
  maxDailyUploads: 20, maxDailyUploadsPerUser: 10 };
const consent = { basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self', basicVersion: 'basic_v1', faceVersion: 'face_v1' };
async function fixture(t, { enabled, prepare = true, ready = true, migrate = true, generationSchema = true, effects = [effect], putGate, providerGate, reviewGate, overrides = {}, configure } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-application-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'isolated.sqlite'), migrate: true });
  let application;
  t.after(async () => { await application?.drain(); await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let timestamp = 1000000; const now = () => timestamp;
  await database.transaction(async q => {
    if (migrate) { for (const sql of photoContextSchema('sqlite')) await q(sql); await q(photoJobsSchema('sqlite'));
      await q(photoUploadSchema('sqlite')); await q(photoUploadCleanupSchema('sqlite'));
      if (generationSchema) for (const sql of photoGenerationSchema('sqlite')) await q(sql); }
    for (const user of ['buyer', 'stranger']) await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [user, 'fixture_app', user]);
    await q('INSERT INTO vp_orders(id,user_id,idem,status,payload,created_at) VALUES (?,?,?,?,?,?)',
      ['order1', 'buyer', 'order1', 'paid', JSON.stringify({ id: 'order1', userId: 'buyer', status: 'paid', product: { type: 'pack' } }), now()]);
    await q('INSERT INTO vp_buckets(id,user_id,order_id,kind,starts_at,expires_at,quantity,remaining,value_fen) VALUES (?,?,?,?,?,?,?,?,?)',
      ['bucket1', 'buyer', 'order1', 'photo', 0, now() + 86400000, 10, 10, 990]);
  });
  const ledger = createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now });
  const rows = (sql, args = []) => database.transaction(q => q(sql, args));
  const objects = new Map(), counts = { put: 0, read: 0, review: 0, provider: 0, deletes: 0, legacy: 0, payment: 0,
    generationPrepare: 0, generationCleanup: 0, generationDrain: 0 };
  const uploadStorage = {
    async put(storageKey, bytes, options) { counts.put++; if (putGate) { putGate.started.resolve(); await putGate.promise; }
      assert.equal(objects.has(storageKey), false); objects.set(storageKey, { bytes: Buffer.from(bytes), contentType: options.contentType }); },
    async read(storageKey) { counts.read++; const item = objects.get(storageKey); return item
      ? { found: true, ...item, bytes: Buffer.from(item.bytes), byteLength: item.bytes.length, sha256: sha(item.bytes) } : { found: false }; },
  };
  const moderator = { async moderate({ bytes, contentType, direction, journal }) {
    counts.review++; const reference = key(100 + counts.review);
    await journal({ reference, extension: 'png' }); assert.equal(direction, 'input'); assert.equal(contentType, 'image/png');
    if (reviewGate) { reviewGate.started.resolve(); await reviewGate.promise; }
    return { provider: 'aliyun-green', policyVersion: policy.moderationVersion, service: policy.moderationService, direction,
      sha256: sha(bytes), byteLength: bytes.length, decision: 'allow', reference: `mod_${'1'.repeat(64)}`, requestId: 'fixture_request',
      cleanupPending: false, cleanupReference: reference, cleanupExtension: 'png' };
  } };
  const cleanupStorage = { async delete(storageKey) { counts.deletes++; objects.delete(storageKey); return { acknowledged: true }; },
    async inspect(storageKey) { return { found: objects.has(storageKey) }; } };
  const settings = { channel: 'wechat-mini-program', ledger, policy: structuredClone(policy), approvedEffects: structuredClone(effects),
    authenticated: c => { const token = c.req.header('authorization')?.replace('Bearer ', '');
      return { auth: ['buyer', 'stranger'].includes(token) ? { userId: token, authMethod: 'wechat' } : null }; },
    uploadStorage, moderator, readiness: async () => ({ ready }), now,
    runProviderFactory: ({ context }) => ({ database, prepare: async () => { counts.generationPrepare++; return { prepared: true }; },
      readiness: async () => ({ ready: true }), runCleanupOnce: async () => { counts.generationCleanup++; return null; },
      drain: async () => { counts.generationDrain++; }, runProvider: async ({ jobId, userId, spec }) => {
      assert.equal(context.database, database); counts.provider++;
      if (providerGate) { providerGate.started.resolve(); await providerGate.promise; }
      assert.equal(spec.provider, 'fictional'); assert.equal(spec.effectParameters.prompt, effect.parameters.prompt);
      await context.registerOutput(userId, jobId, { id: `output_${counts.provider}`, storageKey: `private/output/${key(counts.provider)}.png`,
        sha256: 'a'.repeat(64), byteLength: 100, contentType: 'image/png', expiresAt: now() + 86400000,
        moderation: { decision: 'allow', reference: 'fixture_output_receipt' }, labelVersion: policy.labelVersion });
      return { assetId: `output_${counts.provider}`, providerRef: `fixture_provider_${counts.provider}` };
    } }),
    mediaUrl: { allowedHosts: ['private.example.test'], sign: async ({ assetId, expiresAt }) => ({ assetId, expiresAt, url: `https://private.example.test/${assetId}?signature=REDACTED_SECRET }) },
    cleanup: { sourceStorage: cleanupStorage, moderationStorage: cleanupStorage,
      policy: { timeoutMs: 50, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000 } },
    ...(enabled === undefined ? {} : { generationEnabled: enabled }), ...overrides };
  if (configure) Object.assign(settings, await configure({ settings, database, ledger, now, rows, objects, counts }));
  application = createPhotoApplication(settings);
  const app = new Hono(); application.mount(app); if (prepare) await application.prepare();
  app.post('/api/photo/effect', c => { counts.legacy++; return c.json({ code: 0 }); });
  app.delete('/api/account', c => { counts.legacy++; return c.json({ code: 0 }); });
  app.get('/api/catalog', c => { counts.legacy++; return c.json({ code: 0, data: { settings: { generationEnabled: true } } }); });
  app.post('/api/mini/payments/orders', c => { counts.payment++; return c.json({ code: 'FIXTURE_EXISTING_PAYMENT_MODE_CLOSED' }, 403); });
  app.post('/api/auth/wechat', c => c.json({ code: 0, data: { token: 'buyer', user: { id: 'buyer' } } }));
  app.get('/api/mini/payments/entitlements', async c => c.json({ code: 0, data: await ledger.entitlements('buyer') }));
  app.get('/api/capabilities', c => c.json({ code: 0, data: [{ id: 'photo-effects', ready: true, status: 'verified' }] }));
  app.get('/api/public/compliance', c => c.json({ code: 0, data: { status: 'approved', operatorName: 'Fictional operator',
    consentVersions: { basic: policy.basicVersion, faceProcessing: policy.faceVersion }, retention: { sourceHours: 24, resultHours: 24, supplierPolicy: 'Fictional policy' },
    aiServices: [{ provider: 'fictional', model: 'fixture-model', filingReference: 'fictional-reference', purpose: 'fixture', region: 'fictional', capabilities: ['photo-effect'] }] } }));
  const request = async (url, { method = 'GET', data, user = 'buyer', idem } = {}) => {
    const response = await app.request(url, { method, headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json', ...(idem ? { 'Idempotency-Key': idem } : {}) },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json() };
  };
  const store = new Map(); let random = 0;
  const wx = { getStorageSync: name => store.get(name), setStorageSync: (name, value) => store.set(name, structuredClone(value)), removeStorageSync: name => store.delete(name),
    login: options => options.success({ code: 'fixture_code' }), getRandomValues: options => options.success({ randomValues: new Uint8Array(16).fill(++random).buffer }),
    requestVirtualPayment: () => assert.fail('photo composition must not call WeChat payment'), cloud: { callContainer: async options => {
      const response = await app.request(options.path, { method: options.method, headers: options.header,
        ...(options.data ? { body: JSON.stringify(options.data) } : {}) }); return { statusCode: response.status, data: await response.json() };
    } } };
  const client = createCreationClient(wx, { mode: 'cloud', env: 'fixture-env', service: 'fixture-service' }, { enabled: true });
  const agree = async () => { await application.context.grantBasicConsent('buyer', policy.basicVersion);
    await application.context.grantFaceConsent('buyer', { version: policy.faceVersion, subjectAuthorization: 'self' }); };
  const upload = n => request('/api/mini/photo-uploads', { method: 'POST', data: { image }, idem: key(n) });
  const job = (assetId, n) => request('/api/mini/photo-jobs', { method: 'POST', data: { inputAssetId: assetId, effectId: 'repair' }, idem: key(n) });
  return { application, app, settings, ledger, database, rows, request, client, store, counts, objects, agree, upload, job,
    setReady: value => { ready = value; }, advance: value => { timestamp += value; } };
}

test('non-native channel has no mounts, SQL, factory calls or effect on legacy/payment paths', async () => {
  const app = new Hono();
  const application = createPhotoApplication({ channel: 'android', runProviderFactory: () => assert.fail('inactive provider factory') });
  assert.equal(application.active, false); assert.equal(application.mount(app), false);
  app.post('/api/photo/effect', c => c.json({ legacy: true }));
  assert.deepEqual(await (await app.request('/api/photo/effect', { method: 'POST' })).json(), { legacy: true });
  assert.deepEqual(await application.prepare(), { prepared: false }); assert.equal(await application.runOnce({ process: true }), null);
});

test('default-closed composition advertises both protocols without opening sales, generation, timers or legacy bypasses', async t => {
  const f = await fixture(t); const catalog = (await f.request('/api/catalog')).body.data;
  assert.equal(catalog.settings.generationEnabled, false); assert.equal(catalog.miniProgramCreation.available, false);
  assert.equal(catalog.miniProgramCreation.jobProtocol, 'photo-jobs-v1'); assert.equal(catalog.miniProgramCreation.uploadProtocol, 'photo-uploads-v1');
  assert.equal(f.application.managesSales, false); assert.equal(await f.application.runOnce(), null);
  assert.deepEqual(await f.application.runOnce({ process: true }), {}); assert.equal(f.counts.put + f.counts.review + f.counts.provider, 0);
  assert.equal((await f.upload(1)).status, 503); assert.equal((await f.job('input_missing', 2)).status, 503);
  for (const [url, method] of [['/api/photo/effect', 'POST'], ['/api/account', 'DELETE']]) assert.equal((await f.request(url, { method })).status, 409);
  assert.equal(f.counts.legacy, 0);
  assert.equal((await f.request('/api/mini/payments/orders', { method: 'POST' })).body.code, 'FIXTURE_EXISTING_PAYMENT_MODE_CLOSED');
  assert.equal(f.counts.payment, 1, 'payment policy is still handled by the pre-existing host route');
  assert.deepEqual(await f.rows('SELECT remaining,reserved FROM vp_buckets'), [{ remaining: 10, reserved: 0 }]);
});

test('every actual legacy media/provider POST in index is intercepted before an overlapping host handler', async t => {
  const f = await fixture(t, { enabled: true });
  const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
  // Derive real legacy media/provider entries rather than sharing the adapter's
  // constant: adding another old entry must force an explicit routing decision.
  const paths = [...source.matchAll(/app\.post\(["']([^"']+)["']/g)].map(match => match[1]).filter(value =>
    /^\/api\/(?:photo\/|video\/|upload(?:\/|$)|fusion$|llm\/|play\/|moderation\/check$)/.test(value));
  assert.ok(paths.length >= 14);
  for (const url of paths) f.app.post(url, c => { f.counts.legacy++; return c.json({ code: 'LEGACY_MEDIA_WAS_CALLED' }); });
  for (const url of paths) {
    const response = await f.request(url, { method: 'POST', data: { imageUrl: 'https://fixture.invalid/private', image } });
    assert.equal(response.status, 409, url); assert.equal(response.body.code, 'PHOTO_NATIVE_ASYNC_REQUIRED', url);
  }
  assert.equal(f.counts.legacy, 0); assert.equal(f.counts.put + f.counts.review + f.counts.provider, 0);
});

test('prepare is explicit and checks existing DDL without auto-migrating missing tables', async t => {
  const f = await fixture(t, { enabled: true, prepare: false, migrate: false });
  assert.equal((await f.application.catalog()).miniProgramCreation.available, false);
  assert.equal((await f.rows("SELECT name FROM sqlite_master WHERE name LIKE 'mini_photo_%'")).length, 0);
  await assert.rejects(f.application.prepare(), /no such table/);
  assert.equal((await f.rows("SELECT name FROM sqlite_master WHERE name LIKE 'mini_photo_%'")).length, 0);
  assert.equal((await f.application.catalog()).miniProgramCreation.available, false);
});

test('empty or unapproved server effect configuration cannot enable a public catalog', async t => {
  const empty = await fixture(t, { enabled: true, effects: [] }); assert.equal((await empty.application.catalog()).miniProgramCreation.available, false);
  for (const change of [{ approved: false }, { reviewReference: '' }, { title: '' }]) {
    assert.throws(() => createPhotoApplication({ ...empty.settings, approvedEffects: [{ ...effect, ...change }] }), /APPROVAL_REQUIRED/);
  }
  assert.throws(() => createPhotoApplication({ ...empty.settings, approvedEffects: [effect, effect] }), /APPROVAL_REQUIRED/);
});

test('one frozen approved list supplies both public effect IDs and provider parameters; mutation and database drift cannot open alternate versions', async t => {
  const f = await fixture(t, { enabled: true, prepare: false });
  f.settings.approvedEffects[0].parameters.prompt = 'mutated'; f.settings.approvedEffects.push({ ...effect, id: 'injected' });
  f.settings.policy.basicVersion = 'mutated';
  const first = f.application.prepare(), second = f.application.prepare(); assert.equal(first, second); await first;
  const catalog = await f.application.catalog();
  assert.equal(catalog.miniProgramCreation.available, true); assert.deepEqual(catalog.miniProgramCreation.photoEffectIds, ['repair']);
  assert.doesNotMatch(JSON.stringify(catalog), /fictional server-only prompt|provider|model|reviewReference/);
  assert.equal((await f.application.context.readConsents('buyer')).current.basic, 'basic_v1');
  assert.equal(JSON.parse((await f.rows('SELECT parameters FROM mini_photo_effects'))[0].parameters).prompt, effect.parameters.prompt);
  await f.rows("UPDATE mini_photo_effects SET review_reference = 'drifted'");
  assert.equal((await f.application.catalog()).miniProgramCreation.available, false);
  assert.equal((await f.upload(1)).status, 503); assert.equal(f.counts.put, 0);
});

test('readiness errors and missing cleanup stay closed; preparation alone never grants approval', async t => {
  const f = await fixture(t, { enabled: true, ready: false }); assert.equal((await f.application.catalog()).miniProgramCreation.available, false);
  const missing = await fixture(t, { enabled: true, overrides: { cleanup: undefined } });
  assert.equal((await missing.application.catalog()).miniProgramCreation.available, false);
  const error = await fixture(t, { enabled: true, overrides: { readiness: async () => { throw new Error('private upstream config'); } } });
  assert.equal((await error.application.catalog()).miniProgramCreation.available, false);
  assert.equal((await error.upload(1)).status, 503); assert.equal(error.counts.put, 0);
});

test('generation cannot open without same-database lifecycle, all generation DDL and explicit preparation', async t => {
  const f = await fixture(t);
  for (const changes of [{ runProviderFactory: () => async () => ({}) },
    { runProviderFactory: ({ context }) => ({ database: context.database, runProvider: async () => ({}) }) },
    { runProviderFactory: () => ({ database: {}, runProvider: async () => ({}), prepare() {}, readiness() {}, runCleanupOnce() {}, drain() {} }) }]) {
    assert.throws(() => createPhotoApplication({ ...f.settings, generationEnabled: true, ...changes }), /GENERATION_LIFECYCLE_REQUIRED/);
  }
  const absent = await fixture(t, { enabled: true, generationSchema: false, prepare: false });
  await assert.rejects(absent.application.prepare(), /mini_photo_generation/);
  assert.equal(absent.counts.generationPrepare, 0);
  assert.equal((await absent.rows("SELECT name FROM sqlite_master WHERE name LIKE 'mini_photo_generation%'")).length, 0);
  assert.equal((await absent.application.catalog()).miniProgramCreation.available, false);
  const refused = await fixture(t, { enabled: true, prepare: false, configure: ({ settings }) => {
    const original = settings.runProviderFactory;
    return { runProviderFactory: value => ({ ...original(value), prepare: async () => ({ prepared: false }) }) };
  } });
  await assert.rejects(refused.application.prepare(), /GENERATION_NOT_PREPARED/);
  assert.equal((await refused.application.catalog()).miniProgramCreation.available, false);
});

test('generation lifecycle readiness fails closed while explicitly scheduled cleanup remains available', async t => {
  let state = false;
  const f = await fixture(t, { enabled: true, configure: ({ settings }) => {
    const original = settings.runProviderFactory;
    return { runProviderFactory: value => ({ ...original(value), readiness: async () => {
      if (state === 'error') throw new Error('synthetic lifecycle unavailable'); return { ready: state };
    } }) };
  } });
  assert.equal((await f.application.catalog()).miniProgramCreation.available, false);
  assert.equal((await f.upload(1)).status, 503);
  state = 'error'; assert.equal((await f.application.catalog()).miniProgramCreation.available, false);
  await f.application.runOnce({ process: true, cleanup: true });
  assert.equal(f.counts.generationCleanup, 1); assert.equal(f.counts.provider + f.counts.review, 0);
  state = true; assert.equal((await f.application.catalog()).miniProgramCreation.available, true);
});

test('drain waits for admitted generation before closing its lifecycle and never dispatches another job', async t => {
  const gate = { ...deferred(), started: deferred() };
  const f = await fixture(t, { enabled: true, providerGate: gate });
  await f.agree(); const uploaded = await f.upload(1); await f.application.runOnce({ process: true });
  const input = (await f.request(`/api/mini/photo-uploads/${uploaded.body.data.upload.id}`)).body.data.upload.assetId;
  await f.job(input, 2); const pending = f.application.runOnce({ process: true }); await gate.started.promise;
  let drained = false; const draining = f.application.drain().then(value => { drained = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(drained, false); assert.equal(f.counts.generationDrain, 0);
  assert.equal(await f.application.runOnce({ process: true, cleanup: true }), null);
  gate.resolve(); await pending; await draining;
  assert.equal(f.counts.provider, 1); assert.equal(f.counts.generationDrain, 1);
  assert.equal((await f.rows('SELECT state FROM mini_photo_jobs'))[0].state, 'succeeded');
});

test('actual native client traverses one SQL consent/upload/job ledger and private delivery without calling a payment API', async t => {
  const f = await fixture(t, { enabled: true });
  assert.equal(f.application.context.database, f.database);
  const accepted = await f.client.generate({ image, effectId: 'repair', consent }); assert.equal(accepted.job.state, 'upload_queued');
  assert.equal(f.counts.put, 1); assert.equal(f.counts.review + f.counts.provider, 0);
  assert.deepEqual(await f.rows('SELECT remaining,reserved FROM vp_buckets'), [{ remaining: 10, reserved: 0 }]);
  await f.application.runOnce({ process: true }); assert.equal(f.counts.review, 1); assert.equal(f.counts.provider, 0);
  const queued = await f.client.refresh(); assert.equal(queued.job.state, 'queued');
  assert.deepEqual(await f.rows('SELECT remaining,reserved FROM vp_buckets'), [{ remaining: 9, reserved: 1 }]);
  await f.application.runOnce({ process: true });
  const completed = await f.client.refresh(); assert.equal(completed.result.assetId, 'output_1'); assert.equal(completed.pending, null);
  assert.equal(completed.works.length, 1); assert.match(completed.result.url, /^https:\/\/private\.example\.test/);
  assert.deepEqual(await f.rows('SELECT remaining,reserved FROM vp_buckets'), [{ remaining: 9, reserved: 0 }]);
  assert.equal(f.counts.provider, 1); assert.equal(f.counts.payment, 0);
  assert.equal((await f.request('/api/works', { user: 'stranger' })).body.data.length, 0);
  assert.equal((await f.request('/api/assets/output_1/url', { user: 'stranger' })).status, 404);
  assert.equal((await f.client.deleteAsset('output_1')).partial, true); assert.equal((await f.client.refresh()).works.length, 0);
});

test('serial runOnce coalesces concurrent calls, processes at most one item per stage and never repeats accepted provider work', async t => {
  const gate = { ...deferred(), started: deferred() };
  const f = await fixture(t, { enabled: true, reviewGate: gate }); await f.agree(); await f.upload(1); await f.upload(2);
  const one = f.application.runOnce({ process: true }); await gate.started.promise;
  const two = f.application.runOnce({ process: true }); assert.equal(one, two); gate.resolve(); await one;
  assert.equal(f.counts.review, 1); assert.equal((await f.rows("SELECT COUNT(*) AS n FROM mini_photo_uploads WHERE state = 'queued'"))[0].n, 1);
  const input = (await f.rows("SELECT asset_id FROM mini_photo_uploads WHERE state = 'ready'"))[0].asset_id;
  await f.job(input, 3); await f.application.runOnce({ process: true }); assert.equal(f.counts.provider, 1);
  await f.application.runOnce({ process: true }); assert.equal(f.counts.provider, 1);
});

test('drain stops downstream generation while admitted upload review finishes, preserves query and privacy recovery', async t => {
  const gate = { ...deferred(), started: deferred() };
  const f = await fixture(t, { enabled: true, reviewGate: gate }); await f.agree(); const upload = (await f.upload(1)).body.data.upload;
  const run = f.application.runOnce({ process: true }); await gate.started.promise;
  let finished = false; const draining = f.application.drain().then(value => { finished = true; return value; });
  await Promise.resolve(); assert.equal(finished, false); assert.equal(await f.application.runOnce({ process: true }), null);
  assert.equal((await f.application.catalog()).miniProgramCreation.available, false);
  gate.resolve(); await run; assert.equal((await draining).active, 0); assert.equal(f.counts.provider, 0);
  assert.equal((await f.request(`/api/mini/photo-uploads/${upload.id}`)).body.data.upload.state, 'ready');
  assert.equal((await f.request('/api/consents/basic/withdraw', { method: 'POST' })).status, 202);
  assert.equal((await f.rows('SELECT 1 AS alive'))[0].alive, 1, 'shared database ownership remains with host');
  await assert.rejects(f.application.prepare(), /DRAINING/);
});

test('drain waits for late HTTP upload PUT and its SQL confirmation after the bounded response already returned', async t => {
  const gate = { ...deferred(), started: deferred() };
  const f = await fixture(t, { enabled: true, putGate: gate, overrides: { storageTimeoutMs: 10 } }); await f.agree();
  const pending = f.upload(1); await gate.started.promise; const response = await pending;
  assert.equal(response.body.data.upload.state, 'staging');
  let finished = false; const drained = f.application.drain().then(value => { finished = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(finished, false);
  gate.resolve(); assert.equal((await drained).active, 0);
  assert.equal((await f.rows('SELECT state FROM mini_photo_uploads'))[0].state, 'queued');
  assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 0);
});

test('explicit cleanup remains possible when new generation readiness closes, with durable SQL deletion observations', async t => {
  const f = await fixture(t, { enabled: true }); await f.agree(); await f.upload(1);
  await f.request('/api/consents/basic/withdraw', { method: 'POST' }); f.setReady(false);
  const result = await f.application.runOnce({ cleanup: true });
  assert.equal(result.cleanup.kind, 'source'); assert.equal(result.cleanup.observation, 'absent');
  assert.equal(result.cleanup.permanentErasureConfirmed, false); assert.equal(f.counts.deletes, 1);
  assert.equal((await f.rows('SELECT observation FROM mini_photo_upload_cleanup'))[0].observation, 'absent');
  assert.equal(f.counts.review + f.counts.provider, 0);
});

async function realPipelineFixture(t, { lostProviderReply = false } = {}) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const png = execFileSync(python, ['-c', 'import sys; from PIL import Image; Image.new("RGB",(512,512),(80,100,120)).save(sys.stdout.buffer,format="PNG")']);
  const calls = { provider: 0, generatedRead: 0, marks: 0, puts: [], reviews: [], signs: [] }, bucket = 'fixture-private', region = 'cn-shanghai';
  let storageObjects, generationRepository;
  const realEffect = { ...effect, provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL,
    parameters: { prompt: 'Restore this synthetic image, keeping content unchanged.', negativePrompt: '', n: 1,
      size: '1024*1024', watermark: true, promptExtend: false } };
  const f = await fixture(t, { enabled: true, effects: [realEffect], configure: ({ database, now, rows, objects }) => {
    storageObjects = objects;
    const absent = () => Object.assign(new Error('synthetic absent object'), { code: 'NoSuchKey', status: 404 });
    const item = key => { const value = objects.get(key); if (!value) throw absent(); return value; };
    const headers = value => ({ 'content-type': value.contentType, 'content-length': String(value.bytes.length),
      'x-oss-meta-sha256': sha(value.bytes), etag: `"${sha(value.bytes)}"` });
    const sdk = {
      async put(key, bytes, options) {
        assert.equal(objects.has(key), false, 'immutable key is put at most once');
        assert.equal(options.headers['x-oss-object-acl'], 'private'); assert.equal(options.headers['x-oss-forbid-overwrite'], 'true');
        if (key.startsWith('private/mini-photo-input/')) assert.equal((await rows('SELECT state FROM mini_photo_uploads'))[0].state, 'staging');
        if (key.startsWith('private/photo-outputs/')) assert.equal((await rows("SELECT state FROM mini_photo_generation_operations WHERE step='output_put'"))[0].state, 'started');
        calls.puts.push(key); objects.set(key, { bytes: Buffer.from(bytes), contentType: options.headers['Content-Type'] });
        return { res: { status: 200, headers: {} } };
      },
      async head(key) { return { res: { status: 200, headers: headers(item(key)) } }; },
      async get(key, options) {
        const value = item(key), metadata = headers(value);
        if (key.startsWith('private/photo-outputs/')) { assert.equal(options.headers['If-Match'], metadata.etag);
          assert.equal(options.headers.Range, `bytes=0-${value.bytes.length - 1}`); }
        return { content: Buffer.from(value.bytes), res: { status: 206,
          headers: { ...metadata, 'content-range': `bytes 0-${value.bytes.length - 1}/${value.bytes.length}` } } };
      },
      signatureUrl(key, options) { calls.signs.push(key);
        assert.ok(!key.startsWith('private/mini-photo-input/'), 'original input never gets a signed URL');
        return `https://${bucket}.oss-${region}.aliyuncs.com/${key}?Expires=${Math.round(now() / 1000) + options.expires}&Signature=REDACTED_SECRET },
      async delete(key) { objects.delete(key); return { res: { status: 204, headers: {} } }; },
    };
    const uploadStorage = createPhotoUploadOssStorage({ bucket, region, client: sdk });
    const outputStorage = createPhotoOutputOssStorage({ bucket, region, client: sdk, now });
    const sourceCleanup = createPhotoCleanupOssStorage({ kind: 'source', bucket, region, client: sdk });
    const moderationCleanup = createPhotoCleanupOssStorage({ kind: 'moderation', bucket, region, client: sdk });
    const moderator = createPhotoImageModerator({ now, policy: { approved: true, version: policy.moderationVersion,
      region, services: { input: policy.moderationService, output: policy.moderationService }, lowRisk: 'review', timeoutMs: 1000 },
      storage: createOssModerationStorage({ bucket, region, client: sdk }),
      transport: createGreenImageTransport({ region, client: { async callApi(params, request, runtime) {
        assert.equal(params.action, 'ImageModeration'); assert.equal(runtime.autoretry, false);
        const value = JSON.parse(request.body.ServiceParameters), key = new URL(value.imageUrl).pathname.slice(1);
        const stored = item(key); const reference = key.split('/').at(-1).replace('.png', '');
        const recorded = await rows('SELECT moderation_cleanup_reference AS ref FROM mini_photo_uploads UNION ALL SELECT moderation_reference AS ref FROM mini_photo_generation');
        assert.ok(recorded.some(row => row.ref === reference), 'scratch deletion responsibility precedes review');
        calls.reviews.push({ sha256: sha(stored.bytes), bytes: Buffer.from(stored.bytes), dataId: value.dataId });
        return { statusCode: 200, body: { Code: 200, RequestId: `synthetic_review_${calls.reviews.length}`,
          Data: { DataId: value.dataId, RiskLevel: 'none', Result: [{ Label: 'nonLabel', Confidence: 100 }] } } };
      } } }) });
    const provider = createQwenPhotoProvider({ apiKey: 'synthetic-only-key', transport: async request => {
      if (request.method === 'POST') {
        calls.provider++; assert.equal((await rows("SELECT state FROM mini_photo_generation_operations WHERE step='generate'"))[0].state, 'started');
        const body = JSON.parse(request.body.toString());
        assert.equal(body.model, QWEN_PHOTO_MODEL); assert.equal(body.parameters.n, 1);
        assert.equal(body.input.messages[0].content[0].image, `data:image/png;base64,${png.toString('base64')}`);
        if (lostProviderReply) throw new Error('synthetic response lost after acceptance');
        return { status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ request_id: 'synthetic_provider_receipt',
          output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: `https://${QWEN_PHOTO_RESULT_HOSTS[0]}/synthetic.png?signature=REDACTED_SECRET }] } }] },
          usage: { image_count: 1, width: 512, height: 512 } })) };
      }
      calls.generatedRead++; return { status: 200, contentType: 'image/png', bytes: Buffer.from(png) };
    } });
    const actualMarker = createPhotoImageMarker({ serviceProviderCode: 'synthetic-provider-only', labelVersion: policy.labelVersion, python });
    const marker = { async mark(value) { calls.marks++; return actualMarker.mark(value); } };
    const cleanupPolicy = { timeoutMs: 100, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000 };
    return { uploadStorage, moderator,
      cleanup: { sourceStorage: sourceCleanup, moderationStorage: moderationCleanup, policy: cleanupPolicy },
      mediaUrl: { allowedHosts: [`${bucket}.oss-${region}.aliyuncs.com`],
        sign: async ({ assetId, storageKey, expiresAt }) => ({ assetId, ...outputStorage.signedUrl(storageKey, { maxExpiresAt: expiresAt }) }) },
      runProviderFactory: ({ context }) => {
        generationRepository = createPhotoGenerationRepository({ context, now, policy: { ...policy, operation: 'edit',
          provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, sourceHosts: [...QWEN_PHOTO_RESULT_HOSTS] } });
        const pipeline = createPhotoGenerationPipeline({ repository: generationRepository, context,
          ports: createPhotoMediaPorts({ context, inputStorage: uploadStorage, outputStorage, provider, marker, moderator }) });
        const generationCleanup = createPhotoGenerationCleanupWorker({ repository: createPhotoGenerationCleanupRepository({ context, now }),
          outputStorage, moderationStorage: moderationCleanup, policy: cleanupPolicy });
        return { database, runProvider: pipeline.runProvider, prepare: async () => ({ prepared: true }), readiness: async () => ({ ready: true }),
          runCleanupOnce: () => generationCleanup.runOnce(), drain: () => generationCleanup.drain() };
      } };
  } });
  return { ...f, calls, png, storageObjects, generationRepository,
    image: `data:image/png;base64,${png.toString('base64')}`, python };
}

test('real application → generation pipeline → Qwen adapter → Pillow → final Green binding → private owner download consumes exactly once', async t => {
  const f = await realPipelineFixture(t);
  const initial = await f.client.generate({ image: f.image, effectId: 'repair', consent }); assert.equal(initial.job.state, 'upload_queued');
  await f.application.runOnce({ process: true }); assert.equal(f.calls.reviews.length, 1); assert.equal(f.calls.provider, 0);
  assert.equal((await f.client.refresh()).job.state, 'queued'); await f.application.runOnce({ process: true });
  const completed = await f.client.refresh(); assert.ok(completed.result?.assetId, JSON.stringify(completed.job));
  const generation = (await f.rows('SELECT * FROM mini_photo_generation'))[0];
  assert.equal(generation.registered, 1); assert.equal(generation.asset_id, completed.result.assetId);
  assert.match(generation.output_key, /^private\/photo-outputs\/[a-f0-9]{32}\.png$/);
  const final = f.storageObjects.get(generation.output_key).bytes;
  assert.notEqual(sha(final), sha(f.png)); assert.equal(generation.marked_sha256, sha(final));
  assert.equal(f.calls.reviews.length, 2); assert.equal(f.calls.reviews[0].sha256, sha(f.png));
  assert.equal(f.calls.reviews[1].sha256, sha(final));
  assert.equal(JSON.parse(generation.review_receipt).sha256, sha(final));
  const metadata = JSON.parse(execFileSync(f.python, ['-c',
    'import io,json,sys,xml.etree.ElementTree as E; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); im.load(); root=E.fromstring(im.info["XML:com.adobe.xmp"]); print(json.dumps(json.loads(root.find(".//{http://www.tc260.org.cn/ns/AIGC/1.0}AIGC").text)))'],
  { input: final, encoding: 'utf8' }));
  assert.equal(metadata.Label, '1'); assert.equal(metadata.ProduceID, generation.job_id); assert.equal(metadata.ContentProducer, 'synthetic-provider-only');
  const download = new URL(completed.result.url);
  assert.equal(decodeURIComponent(download.pathname), '/' + generation.output_key);
  assert.ok(Number(download.searchParams.get('Expires')) * 1000 <= 1060000);
  assert.equal((await f.request(`/api/assets/${generation.asset_id}/url`, { user: 'stranger' })).status, 404);
  assert.doesNotMatch(JSON.stringify(completed), /synthetic_provider_receipt|dashscope-result|Restore this synthetic/);
  await f.application.runOnce({ process: true }); await f.client.refresh();
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.generatedRead, 1); assert.equal(f.calls.marks, 1); assert.equal(f.calls.reviews.length, 2);
  assert.equal(f.calls.puts.filter(key => key.startsWith('private/photo-outputs/')).length, 1);
  assert.deepEqual(await f.rows('SELECT remaining,reserved FROM vp_buckets'), [{ remaining: 9, reserved: 0 }]);
  assert.equal((await f.rows("SELECT status FROM vp_reservations"))[0].status, 'consumed');
  await f.client.deleteAsset(generation.asset_id);
  assert.equal((await f.request(`/api/assets/${generation.asset_id}/url`)).status, 404);
  await f.application.runOnce({ cleanup: true }); await f.application.runOnce({ cleanup: true });
  assert.equal(f.storageObjects.has(generation.output_key), false);
  const observations = await f.rows("SELECT kind,state,observation FROM mini_photo_generation_cleanup WHERE kind='output'");
  assert.deepEqual(observations, [{ kind: 'output', state: 'absent_observed', observation: 'absent' }]);
});

test('real composed pipeline holds an accepted-but-lost provider response without a second POST, mark, delivery or debit', async t => {
  const f = await realPipelineFixture(t, { lostProviderReply: true });
  await f.client.generate({ image: f.image, effectId: 'repair', consent });
  await f.application.runOnce({ process: true }); await f.client.refresh(); await f.application.runOnce({ process: true });
  const state = await f.client.refresh(); assert.equal(state.job.state, 'unknown'); assert.equal(state.result, undefined);
  await f.application.runOnce({ process: true }); await f.client.refresh();
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.generatedRead + f.calls.marks, 0); assert.equal(f.calls.reviews.length, 1);
  assert.equal(f.calls.puts.filter(key => key.startsWith('private/photo-outputs/')).length, 0);
  assert.deepEqual(await f.rows('SELECT remaining,reserved FROM vp_buckets'), [{ remaining: 9, reserved: 1 }]);
  assert.equal((await f.rows('SELECT status FROM vp_reservations'))[0].status, 'reserved');
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_works'))[0].n, 0);
});
