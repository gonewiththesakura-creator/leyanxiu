import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { createRequire } from 'node:module';
import { serve } from '@hono/node-server';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { miniIdentitySchema } from '../payments/virtual/mini-identity.js';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { draftProducts, purchaseRulesVersion } from '../payments/virtual/products.js';
import { photoContextSchema } from '../photo-jobs/context.js';
import { photoJobsSchema } from '../photo-jobs/repository.js';
import { photoUploadSchema, photoUploadCleanupSchema } from '../photo-jobs/upload-repository.js';
import { photoGenerationSchema } from '../photo-jobs/generation-repository.js';
import { createPhotoApplication } from '../photo-jobs/application.js';
import { createPhotoCandidateHost } from '../photo-jobs/candidate-host.js';
import { photoCandidatePublicProfile } from '../photo-jobs/candidate-public.js';

const appId = 'wx-candidate-fixture';
const now = () => 1800000000000;
const sessionKey = Buffer.alloc(16, 7).toString('base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const key = n => n.toString(16).padStart(32, '0');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMISKkAAAI0AS3HG8jrAAAAAElFTkSuQmCC', 'base64');
const image = size => {
  if (size <= png.length) return 'data:image/png;base64,' + png.toString('base64');
  // A valid bounded private ancillary chunk exercises the real large-body
  // route. It is discarded by pixel normalization; no corrupt PNG bypass.
  const body = Buffer.alloc(Math.max(0, size - png.length - 12));
  const kind = Buffer.from('vpAg'), length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([kind, body])));
  return 'data:image/png;base64,' + Buffer.concat([png.subarray(0, -12), length, kind, body, crc, png.subarray(-12)]).toString('base64');
};
const policy = { basicVersion: 'fixture_basic_v1', faceVersion: 'fixture_face_v1', labelVersion: 'fixture_label_v1',
  moderationVersion: 'fixture_review_v1', moderationService: 'baselineCheck', sourceRetentionMs: 86400000,
  resultRetentionMs: 86400000, maxDailyUploads: 20, maxDailyUploadsPerUser: 10 };
const effect = { id: 'fixture_effect', version: 'v1', provider: 'fixture', model: 'fixture-model', purpose: 'photo-effect:fixture_effect',
  parameters: {}, enabled: true, approved: true, reviewReference: 'fictional_review_only', title: '本地合成效果' };

async function fixture(t, { enabled = false, photoSchema = true, authSchema = true, prepare = true, lifecycleReady = true, loginGate, queryGate, putGate, publicProfile } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-host-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'isolated.sqlite'), migrate: true });
  const hosts = [];
  t.after(async () => { for (const host of hosts) await host.drain(); await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await database.transaction(async q => {
    if (authSchema) for (const sql of miniIdentitySchema('sqlite')) await q(sql);
    if (photoSchema) for (const sql of [...photoContextSchema('sqlite'), photoJobsSchema('sqlite'), photoUploadSchema('sqlite'),
      photoUploadCleanupSchema('sqlite'), ...photoGenerationSchema('sqlite')]) await q(sql);
  });
  const ledger = createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now });
  await ledger.bindEnvironment(appId, 1);
  const counts = { login: 0, query: 0, generate: 0, review: 0, put: 0, cleanup: 0, prepare: 0, drain: 0 };
  const objects = new Map();
  const source = {
    async put(storageKey, bytes, options) { counts.put++; if (putGate) { putGate.started.resolve(); await putGate.promise; }
      assert.equal(objects.has(storageKey), false); objects.set(storageKey, { bytes: Buffer.from(bytes), contentType: options.contentType }); },
    async read(storageKey) { const item = objects.get(storageKey); return item ? { found: true, ...item,
      sha256: sha(item.bytes), byteLength: item.bytes.length } : { found: false }; },
    async delete(storageKey) { objects.delete(storageKey); return { acknowledged: true }; },
    async inspect(storageKey) { return { found: objects.has(storageKey) }; },
  };
  const adapter = { appId, env: 1, async query(order) { counts.query++; if (queryGate) { queryGate.started.resolve(); await queryGate.promise; }
    return { order: { order_id: order.id, env_type: 2, status: 6 } }; },
    paymentArgs() { assert.fail('closed host must not request payment arguments'); },
    async deliver() { assert.fail('no delivery request in host fixture'); }, async refund() { assert.fail('no channel refund in host fixture'); } };
  const codec = createMessageCodec({ appId, token: 'fixture-only', aesKey: Buffer.alloc(32, 8).toString('base64').slice(0, -1) });
  const settings = { ledger, adapter, codec, appSecret: 'fixture-only', products: [draftProducts[0]], now, generationEnabled: enabled, publicProfile,
    fetchImpl: async target => { counts.login++; assert.equal(new URL(target).pathname, '/sns/jscode2session');
      if (loginGate) { loginGate.started.resolve(); await loginGate.promise; }
      return Response.json({ openid: new URL(target).searchParams.get('js_code') === 'other' ? 'fixture_other' : 'fixture_owner', session_key: sessionKey }); },
    photoApplicationFactory: ports => createPhotoApplication({ ...ports, policy, approvedEffects: [effect], uploadStorage: source, now,
      storageTimeoutMs: 1000, readiness: async () => ({ ready: true }),
      moderator: { async moderate() { counts.review++; throw new Error('fixture moderation deliberately not run'); } },
      runProviderFactory: ({ context }) => ({ database: context.database,
        async prepare() { counts.prepare++; return { prepared: true }; }, readiness: async () => ({ ready: lifecycleReady }),
        async runProvider() { counts.generate++; assert.fail('host fixture must not generate'); },
        async runCleanupOnce() { counts.cleanup++; return null; }, async drain() { counts.drain++; } }),
      mediaUrl: { allowedHosts: ['fixture.invalid'], sign: async () => { assert.fail('no signed URL needed'); } },
      cleanup: { sourceStorage: source, moderationStorage: source,
        policy: { timeoutMs: 100, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000 } } }),
  };
  const build = overrides => { const host = createPhotoCandidateHost({ ...settings, ...overrides }); hosts.push(host); return host; };
  const host = build(); if (prepare) await host.prepare();
  const request = async (url, { method = 'GET', body, token, headers = {}, raw } = {}, target = host) => {
    const response = await target.app.request(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(raw === undefined && body === undefined ? {} : { body: raw ?? JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const login = async (code = 'owner', target = host) => { const response = await request('/api/auth/wechat', { method: 'POST', body: { code,
    userId: 'forged', openid: 'forged', sessionKey: 'forged' } }, target); assert.equal(response.status, 200); return response.body.data; };
  const agree = async (token, target = host) => {
    for (const consentType of ['basic', 'face_processing']) {
      const body = { consentType, action: 'granted', version: consentType === 'basic' ? policy.basicVersion : policy.faceVersion,
        ...(consentType === 'face_processing' ? { subjectAuthorization: 'self' } : {}) };
      assert.equal((await request('/api/consents', { method: 'POST', body, token }, target)).status, 200);
    }
  };
  const upload = (token, n = 1, size = 200000) => request('/api/mini/photo-uploads', { method: 'POST', token,
    headers: { 'Idempotency-Key': key(n) }, body: { image: image(size) } });
  return { host, build, settings, database, ledger, counts, source, objects, request, login, agree, upload,
    rows: (sql, args = []) => database.transaction(q => q(sql, args)) };
}

test('host construction stays unprepared and closed; explicit preparation does not dispatch or create identities', async t => {
  const f = await fixture(t, { prepare: false });
  assert.equal((await f.request('/health')).status, 503);
  assert.equal((await f.request('/api/auth/wechat', { method: 'POST', body: { code: 'owner' } })).status, 503);
  assert.deepEqual(await f.rows('SELECT user_id FROM vp_accounts'), []);
  assert.equal(f.counts.login + f.counts.generate + f.counts.review + f.counts.put, 0);
  assert.deepEqual(await f.host.prepare(), { prepared: true, paymentPrepared: true, photoPrepared: true });
  const health = (await f.request('/health')).body;
  assert.equal(health.service, 'mini-photo-candidate'); assert.equal(health.env, 1); assert.equal(health.mode, 'closed');
  assert.equal(health.salesEnabled, false); assert.equal(health.productionPaymentsEnabled, false); assert.equal(health.sandboxMayCharge, true);
  assert.equal(health.ledgerOnlySandbox, false); assert.equal(health.photo.prepared, true); assert.equal(health.generationAvailable, false);
  const catalog = (await f.request('/api/catalog')).body.data;
  assert.equal(catalog.miniProgramCreation.jobProtocol, 'photo-jobs-v1'); assert.equal(catalog.miniProgramCreation.uploadProtocol, 'photo-uploads-v1');
  assert.equal(catalog.miniProgramCreation.available, false); assert.equal(await f.host.runOnce(), null);
  await f.host.runOnce({ process: true }); assert.equal(f.counts.generate + f.counts.review, 0);
  assert.equal(f.counts.cleanup, 0); await f.host.runOnce({ cleanup: true }); assert.equal(f.counts.cleanup, 1);
});

test('one durable WeChat identity reaches both photo consent and ledger routes; forged identities and revoked bearer fail', async t => {
  const f = await fixture(t, { enabled: true }); const login = await f.login();
  const again = await f.login(); assert.equal(again.user.id, login.user.id); assert.notEqual(again.token, login.token);
  await f.agree(again.token);
  const consent = await f.request('/api/consents', { token: again.token }); assert.equal(consent.status, 200);
  assert.deepEqual(await f.rows('SELECT user_id FROM mini_photo_accounts'), [{ user_id: login.user.id }]);
  assert.deepEqual(await f.rows('SELECT user_id FROM vp_accounts'), [{ user_id: login.user.id }]);
  assert.equal((await f.request('/api/account/entitlements', { token: again.token })).status, 200);
  assert.equal((await f.request('/api/consents', { headers: { 'X-WX-OPENID': 'fixture_owner', 'X-User-ID': login.user.id } })).status, 401);
  assert.equal((await f.request('/api/mini/payments/orders', { method: 'POST', token: again.token,
    body: { productId: 'photo10', agreed: true, platform: 'android', rulesVersion: purchaseRulesVersion } })).status, 503);
  assert.deepEqual(await f.rows('SELECT id FROM vp_orders'), []);
  await f.request('/api/auth/logout', { method: 'POST', token: again.token, body: {} });
  for (const url of ['/api/consents', '/api/account/entitlements']) assert.equal((await f.request(url, { token: again.token })).status, 401);
  assert.equal(f.counts.generate + f.counts.review, 0);
});

test('photo upload keeps its own bounded body; payment 128 KiB and consent 1 KiB limits remain intact', async t => {
  const f = await fixture(t, { enabled: true }); const login = await f.login(); await f.agree(login.token);
  const uploaded = await f.upload(login.token); assert.equal(uploaded.status, 202); assert.equal(uploaded.body.data.upload.state, 'queued');
  assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 0);
  const payment = await f.request('/api/mini/payments/orders', { method: 'POST', token: login.token, body: { image: image(200000) } });
  assert.equal(payment.status, 413); assert.equal(payment.body.code, 'XPAY_MESSAGE_TOO_LARGE');
  const over = await f.request('/api/mini/photo-uploads', { method: 'POST', token: login.token,
    headers: { 'Idempotency-Key': key(2) }, body: { image: 'x'.repeat(2800101) } });
  assert.equal(over.status, 413); assert.equal(over.body.code, 'PHOTO_UPLOAD_INVALID_REQUEST');
  assert.equal((await f.request('/api/consents', { method: 'POST', token: login.token, body: { padding: 'x'.repeat(2048) } })).status, 413);
  assert.equal(f.counts.put, 1); assert.equal(f.counts.generate + f.counts.review, 0);
});

test('closed host recovers original upload, consent and refund request without reopening purchase or cross-user access', async t => {
  const f = await fixture(t, { enabled: true }); const owner = await f.login(); const other = await f.login('other'); await f.agree(owner.token);
  const upload = (await f.upload(owner.token)).body.data.upload;
  const order = await f.ledger.createOrder({ userId: owner.user.id, product: draftProducts[0], idempotencyKey: 'fixture-original-order', appId,
    env: 1, platform: 'android', rulesVersion: purchaseRulesVersion });
  await f.ledger.settle(order.id, { order_id: order.id, env_type: 2, order_fee: 990, paid_fee: 990, left_fee: 990,
    status: 2, order_type: 0, wx_order_id: 'fixture_paid_order', paid_time: now() / 1000 });
  const closed = f.build({ generationEnabled: false }); await closed.prepare();
  const replay = await f.request('/api/mini/photo-uploads', { method: 'POST', token: owner.token,
    headers: { 'Idempotency-Key': key(1) }, body: { image: image(200000) } }, closed);
  assert.equal(replay.status, 503); assert.equal(replay.body.code, 'PHOTO_CANDIDATE_GENERATION_CLOSED');
  assert.equal((await f.request('/api/mini/photo-uploads/' + upload.id, { token: owner.token }, closed)).body.data.upload.id, upload.id);
  assert.equal((await f.request('/api/mini/photo-uploads/' + upload.id, { token: other.token }, closed)).status, 404);
  assert.equal((await f.request('/api/mini/payments/orders/' + order.id, { token: other.token }, closed)).status, 404);
  assert.equal((await f.request('/api/mini/payments/orders/' + order.id, { token: owner.token }, closed)).body.data.status, 'paid');
  const refund = await f.request('/api/mini/payments/orders/' + order.id + '/refund', { method: 'POST', token: owner.token, body: { reason: '本地验收退款申请' } }, closed);
  assert.equal(refund.status, 200); assert.equal(refund.body.data.status, 'requested');
  const withdrawn = await f.request('/api/consents/basic/withdraw', { method: 'POST', token: owner.token, body: {} }, closed);
  assert.equal(withdrawn.status, 202); assert.equal(withdrawn.body.data.accessRevoked, true);
  assert.equal((await f.request('/api/account/entitlements', { token: owner.token }, closed)).status, 200);
  assert.equal(f.counts.put, 1); assert.equal(f.counts.generate + f.counts.review + f.counts.query, 0);
});

test('host final creation switch rejects a factory that mistakenly enables its child application', async t => {
  const f = await fixture(t); const login = await f.login();
  const wrong = f.build({ photoApplicationFactory: ports => f.settings.photoApplicationFactory({ ...ports, generationEnabled: true }) });
  await wrong.prepare(); await f.agree(login.token, wrong);
  assert.equal((await wrong.photo.catalog()).miniProgramCreation.available, true, 'fixture child is actually open');
  assert.equal((await f.request('/api/catalog', {}, wrong)).body.data.miniProgramCreation.available, false);
  for (const [url, body] of [['/api/mini/photo-uploads', { image: image(200000) }],
    ['/api/mini/photo-jobs', { inputAssetId: 'input_fixture', effectId: effect.id }]]) {
    const response = await f.request(url, { method: 'POST', token: login.token, headers: { 'Idempotency-Key': key(3) }, body }, wrong);
    assert.equal(response.status, 503); assert.equal(response.body.code, 'PHOTO_CANDIDATE_GENERATION_CLOSED');
  }
  assert.equal((await f.request('/api/mini/photo-uploads/by-key/' + key(3), { token: login.token }, wrong)).body.data.upload, null);
  for (const table of ['mini_photo_uploads', 'mini_photo_jobs', 'vp_reservations']) assert.deepEqual(await f.rows(`SELECT id FROM ${table}`), []);
  await wrong.runOnce({ process: true }); assert.equal(f.counts.put + f.counts.review + f.counts.generate, 0);
  assert.equal((await f.request('/api/consents/basic/withdraw', { method: 'POST', token: login.token, body: {} }, wrong)).status, 202);
});

test('env zero, attempted sales and a photo application from a second database are rejected', async t => {
  const f = await fixture(t, { prepare: false });
  assert.throws(() => f.build({ adapter: { ...f.settings.adapter, env: 0 } }), /PHOTO_CANDIDATE_SCOPE_REQUIRED/);
  assert.throws(() => f.build({ purchaseEnabled: true }), /PHOTO_CANDIDATE_SCOPE_REQUIRED/);
  assert.throws(() => f.build({ photoApplicationFactory: ports => ({ ...f.settings.photoApplicationFactory(ports), context: { database: {} } }) }), /PHOTO_CANDIDATE_SHARED_DATABASE_REQUIRED/);
  await f.rows('UPDATE vp_environment SET env = 0 WHERE id = 1');
  await assert.rejects(f.host.prepare(), /PHOTO_CANDIDATE_SCOPE_REQUIRED/); assert.equal(f.counts.prepare, 0);
  assert.equal((await f.request('/health')).body.payment.operationsReady, false);
});

test('missing auth schema is never migrated and missing photo schema leaves verified payment operations recoverable', async t => {
  const f = await fixture(t, { authSchema: false, prepare: false });
  await assert.rejects(f.host.prepare());
  assert.deepEqual(await f.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'vp_auth_sessions'"), []);
  assert.equal((await f.request('/health')).body.payment.operationsReady, false);
  const g = await fixture(t, { photoSchema: false, prepare: false });
  assert.deepEqual(await g.host.prepare(), { prepared: false, paymentPrepared: true, photoPrepared: false });
  const login = await g.login(); assert.equal((await g.request('/api/account/entitlements', { token: login.token })).status, 200);
  assert.equal((await g.request('/api/consents', { token: login.token })).status, 503);
  assert.equal((await g.request('/api/catalog')).body.data.miniProgramCreation.available, false);
  assert.deepEqual(await g.rows("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'mini_photo_%'"), []);
});

test('a prepared application still cannot bypass its lifecycle readiness and live database environment guard', async t => {
  const f = await fixture(t, { enabled: true, lifecycleReady: false });
  assert.equal((await f.request('/health')).body.photo.prepared, true);
  assert.equal((await f.request('/health')).body.generationAvailable, false);
  await f.host.runOnce({ process: true }); assert.equal(f.counts.generate + f.counts.review, 0);
  await f.rows('UPDATE vp_environment SET app_id = ? WHERE id = 1', ['different-app']);
  assert.equal((await f.request('/health')).status, 503);
  assert.equal((await f.request('/api/auth/wechat', { method: 'POST', body: { code: 'owner' } })).status, 503);
  assert.equal(await f.host.runOnce({ cleanup: true }), null); assert.equal(f.counts.login + f.counts.cleanup, 0);
});

test('drain rejects new HTTP while waiting for admitted login and never closes the shared database', async t => {
  const gate = { ...deferred(), started: deferred() };
  const f = await fixture(t, { loginGate: gate }); const login = f.login(); await gate.started.promise;
  let done = false; const drain = f.host.drain().then(value => { done = true; return value; });
  assert.equal((await f.request('/api/catalog')).status, 503); assert.equal(done, false);
  assert.equal((await f.request('/health')).body.accepting, false);
  assert.equal(await f.host.runOnce({ process: true, cleanup: true }), null);
  gate.resolve(); const issued = await login; assert.ok(issued.user.id);
  assert.deepEqual(await drain, { accepting: false, active: 0, databaseClosed: false });
  assert.equal((await f.rows('SELECT user_id FROM vp_accounts')).length, 1);
  await assert.rejects(f.host.prepare(), /PHOTO_CANDIDATE_DRAINING/);
});

test('explicit reconciliation is single flight and drains its admitted channel query without scheduling another', async t => {
  const gate = { ...deferred(), started: deferred() };
  const f = await fixture(t, { queryGate: gate }); const login = await f.login();
  const order = await f.ledger.createOrder({ userId: login.user.id, product: draftProducts[0], idempotencyKey: 'fixture-pending-order',
    appId, env: 1, platform: 'android', rulesVersion: purchaseRulesVersion });
  assert.equal(f.counts.query, 0); const first = f.host.reconcileOnce(); assert.equal(first, f.host.reconcileOnce()); await gate.started.promise;
  let done = false; const drain = f.host.drain().then(value => { done = true; return value; });
  assert.deepEqual(await f.host.reconcileOnce(), { skipped: true }); assert.equal(done, false);
  gate.resolve(); await first; await drain;
  assert.equal(f.counts.query, 1); assert.equal((await f.ledger.order(order.id)).status, 'closed');
});

test('drain waits for admitted private upload and its durable queued receipt without beginning review', async t => {
  const gate = { ...deferred(), started: deferred() };
  const f = await fixture(t, { enabled: true, putGate: gate }); const login = await f.login(); await f.agree(login.token);
  const upload = f.upload(login.token); await gate.started.promise;
  let done = false; const drain = f.host.drain().then(value => { done = true; return value; });
  assert.equal((await f.request('/api/catalog')).status, 503); assert.equal(done, false);
  assert.deepEqual(await f.rows('SELECT state FROM mini_photo_uploads'), [{ state: 'staging' }]);
  gate.resolve(); assert.equal((await upload).body.data.upload.state, 'queued');
  assert.deepEqual(await drain, { accepting: false, active: 0, databaseClosed: false });
  assert.deepEqual(await f.rows('SELECT state FROM mini_photo_uploads'), [{ state: 'queued' }]);
  assert.equal(f.counts.put, 1); assert.equal(f.counts.review + f.counts.generate, 0);
});

test('candidate exposes no legacy host, fake compliance approval, complaint receipt or worker HTTP trigger', async t => {
  const f = await fixture(t);
  for (const url of ['/api/reports', '/api/photo/run', '/api/worker/run']) assert.equal((await f.request(url)).status, 404);
  const profile = await f.request('/api/public/compliance'); assert.equal(profile.status, 200);
  assert.equal(profile.body.data.status, 'pending_company_approval');
  const capability = (await f.request('/api/capabilities')).body.data;
  assert.equal(capability.length, 1); assert.equal(capability[0].ready, false);
  for (const url of ['/api/photo/effect', '/api/photo/restore', '/api/upload', '/api/video/matting']) assert.equal((await f.request(url, { method: 'POST' })).status, 409);
  assert.equal((await f.request('/api/account', { method: 'DELETE' })).status, 409);
  assert.equal((await f.request('/admin/mini-payments')).status, 403);
  const response = await f.request('/api/catalog'); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(f.counts.generate + f.counts.review + f.counts.login, 0);
});

test('actual native clients refresh configured disclosures over local HTTP without opening creation or accepting disabled reports', async t => {
  for (const complete of [false, true]) await t.test(complete ? 'complete configured disclosure' : 'missing disclosure', async t => {
  const publicProfile = complete ? photoCandidatePublicProfile({ policy: { ...policy, provider: effect.provider, model: effect.model },
    env: { PRIVACY_POLICY_URL: 'https://example.com/privacy', USER_AGREEMENT_URL: 'https://example.com/terms',
      THIRD_PARTY_LIST_URL: 'https://example.com/processors', PIPIA_REFERENCE: 'fictional_private_assessment',
      RETENTION_SUPPLIER_POLICY: '仅本地夹具保存说明。', AI_SERVICE_DISCLOSURES_JSON: JSON.stringify([{ provider: effect.provider,
        model: effect.model, filingReference: '仅本地夹具公开编号', purpose: '仅本地夹具图片处理', region: '仅本地夹具境内地域', capabilities: ['photo-effect'] }]) } }) : undefined;
  const f = await fixture(t, { enabled: true, publicProfile });
  // Technical fixture readiness is deliberately true: it is still insufficient
  // to publish formal verified capability or open the native creation UI.
  assert.equal((await f.host.health()).generationAvailable, true);
  const server = serve({ fetch: f.host.app.fetch, hostname: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.listening ? resolve() : server.once('listening', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeIdleConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`, require = createRequire(import.meta.url);
  const { createCreationClient } = require('../../miniprogram/creation.js');
  const { createServiceClient } = require('../../miniprogram/service.js');
  const wx = { memory: new Map(), login({ success }) { success({ code: 'owner' }); },
    getStorageSync(key) { return this.memory.get(key); }, setStorageSync(key, value) { this.memory.set(key, value); },
    removeStorageSync(key) { this.memory.delete(key); },
    cloud: { async callContainer({ path: route, method, data, header }) {
      const result = await fetch(base + route, { method, headers: header, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { statusCode: result.status, data: await result.json() };
    } } };
  const endpoint = { mode: 'cloud', env: 'fixture-env', service: 'fixture-service' };
  const creation = createCreationClient(wx, endpoint, { enabled: true });
  const created = await creation.refresh();
  assert.equal(created.available, false); assert.equal(created.photo, 0); assert.deepEqual(created.works, []);
  assert.equal(created.compliance.status, complete ? 'approved' : 'pending_company_approval');
  const service = createServiceClient(wx, endpoint), info = await service.refresh();
  assert.equal(info.available, complete); assert.equal(info.support, 'REDACTED_COMPANY_CONTACT_EMAIL'); assert.equal(info.receipt, null);
  if (complete) { assert.equal(created.compliance.retention.sourceHours, 24); assert.equal(info.suppliers[0].model, effect.model); }
  for (const submit of [() => service.submitReport({ category: 'other', description: '这是一条只在隔离本地测试的反馈说明' }),
    () => service.requestAccountDeletion({ informationConfirmed: true, applicationConfirmed: true })]) {
    await assert.rejects(submit(), error => error.code === 'REPORT_SUBMISSION_DISABLED');
    assert.equal(wx.memory.size, 0, 'definitely unaccepted report must not leave an unconfirmed lock');
  }
  assert.equal((await service.refresh()).receipt, null);
  const owner = await f.login(), other = await f.login('other');
  for (const route of ['/api/public/compliance', '/api/capabilities']) {
    const anonymous = await (await fetch(base + route)).json();
    for (const token of [owner.token, other.token]) {
      assert.deepEqual(await (await fetch(base + route, { headers: { Authorization: `Bearer ${token}` } })).json(), anonymous);
    }
    assert.ok(!JSON.stringify(anonymous).includes('fictional_review_only'));
  }
  for (const table of ['vp_orders', 'vp_reservations', 'mini_photo_jobs', 'mini_photo_uploads']) assert.deepEqual(await f.rows(`SELECT id FROM ${table}`), []);
  assert.equal(f.counts.generate + f.counts.review + f.counts.put + f.counts.query, 0);
  });
});
