import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
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
import { createPhotoProductionHost } from '../photo-jobs/production-host.js';
import { photoCandidatePublicProfile } from '../photo-jobs/candidate-public.js';

const appId = 'wx1234567890abcdef';
const now = () => 1800000000000;
const sessionKey = Buffer.alloc(16, 7).toString('base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const key = n => n.toString(16).padStart(32, '0');
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMISKkAAAI0AS3HG8jrAAAAAElFTkSuQmCC', 'base64');
const image = size => {
  if (size <= png.length) return 'data:image/png;base64,' + png.toString('base64');
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

async function fixture(t, { enabled = false, photoSchema = true, authSchema = true, prepare = true, lifecycleReady = true, loginGate, queryGate, putGate, publicProfile, mode = 'closed', pictureReady = false, paymentReady = false, misassembled = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-host-'));
  const sourceDb = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'isolated.sqlite'), migrate: true });
  // Explicit MySQL-shaped test adapter over real isolated SQLite, not MySQL acceptance.
  const database = { backend: 'mysql', transaction: callback => sourceDb.transaction(q => callback((sql,args) => q(sql.replace(/ FOR UPDATE/g, ''),args))), close: () => sourceDb.close() };
  const hosts = [];
  t.after(async () => { for (const host of hosts) await host.drain(); await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  await database.transaction(async q => {
    if (authSchema) for (const sql of miniIdentitySchema('sqlite')) await q(sql);
    if (photoSchema) for (const sql of [...photoContextSchema('sqlite'), photoJobsSchema('sqlite'), photoUploadSchema('sqlite'),
      photoUploadCleanupSchema('sqlite'), ...photoGenerationSchema('sqlite')]) await q(sql);
  });
  const ledger = createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now });
  await ledger.bindEnvironment(appId, 0);
  const state = { pictureReady, paymentReady, lifecycleReady, deniedUser: null, lifecycleDeniedUser: null, throwPicture: false };
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
  const adapter = { appId, env: 0, async query(order) { counts.query++; if (queryGate) { queryGate.started.resolve(); await queryGate.promise; }
    return { order: { order_id: order.id, env_type: 1, status: 6 } }; },
    paymentArgs(order) { return { signData: JSON.stringify({ env: 0, goodsPrice: order.amountFen, productId: order.productId, outTradeNo: order.id }) }; },
    async deliver() { assert.fail('no delivery request in host fixture'); }, async refund() { assert.fail('no channel refund in host fixture'); } };
  const codec = createMessageCodec({ appId, token: 'fixture-only', aesKey: Buffer.alloc(32, 8).toString('base64').slice(0, -1) });
  const settings = { ledger, adapter, codec, appSecret: 'fixture-only', products: [draftProducts[0]], now, generationEnabled: enabled, publicProfile, mode,
    pictureReadiness: async userId => { if(state.throwPicture) throw Error('private-error'); return { ready: state.pictureReady && userId !== state.deniedUser }; },
    paymentReadiness: async () => ({ ready: state.paymentReady, operationsReady: true, mode, purchaseProfile: 'android-only-v1' }),
    requireAdmin: c => ({ response: c.json({ code: 'FIXTURE_ADMIN_DENIED' }, 403) }),
    fetchImpl: async target => { counts.login++; assert.equal(new URL(target).pathname, '/sns/jscode2session');
      if (loginGate) { loginGate.started.resolve(); await loginGate.promise; }
      return Response.json({ openid: new URL(target).searchParams.get('js_code') === 'other' ? 'fixture_other' : 'fixture_owner', session_key: sessionKey }); },
    photoApplicationFactory: ports => createPhotoApplication({ ...ports, ...(misassembled ? {generationEnabled: true, readiness: async () => ({ready:true})} : {}), policy, approvedEffects: [effect], uploadStorage: source, now,
      storageTimeoutMs: 1000,
      moderator: { async moderate() { counts.review++; throw new Error('fixture moderation deliberately not run'); } },
      runProviderFactory: ({ context }) => ({ database: context.database,
        async prepare() { counts.prepare++; return { prepared: true }; }, readiness: async userId => ({ ready: state.lifecycleReady && userId !== state.lifecycleDeniedUser }),
        async runProvider() { counts.generate++; assert.fail('host fixture must not generate'); },
        async runCleanupOnce() { counts.cleanup++; return null; }, async drain() { counts.drain++; } }),
      mediaUrl: { allowedHosts: ['fixture.invalid'], sign: async () => { assert.fail('no signed URL needed'); } },
      cleanup: { sourceStorage: source, moderationStorage: source,
        policy: { timeoutMs: 100, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000 } } }),
  };
  const build = overrides => { const host = createPhotoProductionHost({ ...settings, ...overrides }); hosts.push(host); return host; };
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
  return { host, build, settings, database, ledger, counts, source, objects, request, login, agree, upload, state,
    rows: (sql, args = []) => database.transaction(q => q(sql, args)) };
}

function disclosures() {
  return photoCandidatePublicProfile({ policy: { ...policy, provider: effect.provider, model: effect.model }, env: {
    PRIVACY_POLICY_URL: 'https://fixture.invalid/privacy', USER_AGREEMENT_URL: 'https://fixture.invalid/terms',
    THIRD_PARTY_LIST_URL: 'https://fixture.invalid/processors', RETENTION_SUPPLIER_POLICY: '仅为本地测试的处理方说明',
    PIPIA_REFERENCE: 'fictional-internal-assessment', AI_SERVICE_DISCLOSURES_JSON: JSON.stringify([{ provider: effect.provider,
      model: effect.model, filingReference: 'fictional-review', purpose: '合成测试', region: '中国内地', capabilities: ['photo-effect'] }]),
  } });
}
const createOrder = (f, token, idem = 'fixture-live-order') => f.request('/api/mini/payments/orders', {
  method: 'POST', token, headers: { 'Idempotency-Key': idem }, body: { productId: 'photo10', platform: 'android',
    agreed: true, rulesVersion: purchaseRulesVersion, amountFen: 1, env: 1 } });
async function seedPaid(f, session) {
  const order = await f.ledger.createOrder({ userId: session.user.id, appId, env: 0, product: draftProducts[0],
    platform: 'android', rulesVersion: purchaseRulesVersion, idempotencyKey: 'fixture-prior-paid' });
  await f.ledger.settle(order.id, { order_id: order.id, env_type: 1, order_fee: 990, paid_fee: 990, left_fee: 990,
    status: 2, order_type: 0, wx_order_id: 'fixture-prior-wx', paid_time: now() / 1000 });
  return order;
}

test('default production host is unprepared and closed; preparing never starts provider or payment work', async t => {
  const f = await fixture(t, { prepare: false });
  assert.equal((await f.request('/health')).status, 503);
  assert.equal((await f.request('/api/catalog')).status, 503);
  assert.deepEqual(await f.host.prepare(), { prepared: true, paymentPrepared: true, photoPrepared: true });
  const health = (await f.request('/health')).body;
  assert.equal(health.env, 0); assert.equal(health.mode, 'closed');
  assert.equal(health.generationAvailable, false); assert.equal(health.salesEnabled, false);
  assert.equal((await f.request('/api/capabilities')).body.data[0].ready, false);
  assert.equal((await f.request('/api/mini/payments/products')).body.data.available, false);
  assert.equal(f.counts.login + f.counts.put + f.counts.generate + f.counts.review + f.counts.query, 0);
});

test('public status, child synthetic readiness, current payment readiness or private mode alone cannot open sales', async t => {
  for (const change of [{ pictureReady: false }, { paymentReady: false }, { lifecycleReady: false },
    { publicProfile: { ...disclosures() } }, { publicProfile: photoCandidatePublicProfile() }, { enabled: false }, { mode: 'closed' }]) {
    const f = await fixture(t, { enabled: true, pictureReady: true, paymentReady: true, lifecycleReady: true,
      publicProfile: disclosures(), mode: 'live', ...change });
    const owner = await f.login();
    assert.equal((await f.request('/api/mini/payments/products', { token: owner.token })).body.data.available, false);
    assert.equal((await createOrder(f, owner.token)).status, 503);
    assert.deepEqual(await f.ledger.orders(), []);
  }
});

test('live buyer uses the same current picture gate as capabilities and new uploads; scope and actual price remain env0', async t => {
  const f = await fixture(t, { enabled: true, pictureReady: true, paymentReady: true, publicProfile: disclosures(), mode: 'live' });
  const owner = await f.login(); await f.agree(owner.token);
  assert.equal((await f.request('/api/capabilities', { token: owner.token })).body.data[0].status, 'verified');
  assert.equal((await f.request('/api/catalog', { token: owner.token })).body.data.miniProgramCreation.available, true);
  assert.equal((await f.request('/api/mini/payments/products', { token: owner.token })).body.data.available, true);
  const created = await createOrder(f, owner.token);
  assert.equal(created.status, 200); assert.equal(created.body.data.order.amountFen, 990);
  assert.equal(JSON.parse(created.body.data.payment.signData).env, 0);
  assert.equal((await f.ledger.order(created.body.data.order.id)).userId, owner.user.id);
  const uploaded = await f.upload(owner.token); assert.equal(uploaded.status, 202); assert.equal(f.counts.put, 1);
  f.state.pictureReady = false;
  for (const route of ['/api/capabilities', '/api/catalog', '/api/mini/payments/products']) {
    const value = (await f.request(route, { token: owner.token })).body.data;
    assert.equal(route.includes('capabilities') ? value[0].ready : route.includes('catalog') ? value.miniProgramCreation.available : value.available, false);
  }
  assert.equal((await createOrder(f, owner.token, 'second-must-not-create')).status, 503);
  const repeat = await f.upload(owner.token);
  assert.equal(repeat.status, 503); assert.equal(repeat.body.code, 'PHOTO_PRODUCTION_GENERATION_CLOSED');
  assert.equal(f.counts.put, 1); assert.equal((await f.ledger.orders()).length, 1);
});

test('per-user picture denial cannot leave that user purchase-enabled while others are available', async t => {
  const f = await fixture(t, { enabled: true, pictureReady: true, paymentReady: true, publicProfile: disclosures(), mode: 'live' });
  const owner = await f.login(); const other = await f.login('other'); f.state.deniedUser = other.user.id;
  assert.equal((await f.request('/api/mini/payments/products', { token: other.token })).body.data.available, false);
  assert.equal((await f.request('/api/capabilities', { token: other.token })).body.data[0].ready, false);
  assert.equal((await f.request('/api/catalog', { token: other.token })).body.data.miniProgramCreation.available, false);
  assert.equal((await createOrder(f, other.token)).status, 503);
  assert.equal((await f.upload(other.token)).status, 503);
  assert.equal((await createOrder(f, owner.token)).status, 200);
  f.state.throwPicture = true;
  assert.equal((await createOrder(f, owner.token, 'throw-closed')).status, 503);
  assert.equal((await f.request('/api/mini/payments/products', { token: owner.token })).body.data.available, false);
  assert.equal(f.counts.put + f.counts.generate + f.counts.review, 0);
});

test('a lifecycle user denial also closes that user catalog and purchase while global readiness remains true', async t => {
  const f = await fixture(t, { enabled: true, pictureReady: true, paymentReady: true, publicProfile: disclosures(), mode: 'live' });
  const owner = await f.login(); const other = await f.login('other'); f.state.lifecycleDeniedUser = other.user.id;
  assert.equal((await f.host.photo.catalog()).miniProgramCreation.available, true);
  assert.equal((await f.request('/api/mini/payments/products', { token: other.token })).body.data.available, false);
  assert.equal((await f.request('/api/capabilities', { token: other.token })).body.data[0].ready, false);
  assert.equal((await f.request('/api/catalog', { token: other.token })).body.data.miniProgramCreation.available, false);
  assert.equal((await createOrder(f, other.token)).status, 503);
  assert.equal((await f.upload(other.token)).status, 503);
  assert.equal((await createOrder(f, owner.token)).status, 200);
  assert.equal(f.counts.put + f.counts.generate + f.counts.review, 0);
  assert.equal((await f.ledger.orders()).length, 1);
});

test('anonymous projections stay closed and invalid credentials are rejected even when global readiness is true', async t => {
  const f = await fixture(t, { enabled: true, pictureReady: true, paymentReady: true, publicProfile: disclosures(), mode: 'live' });
  const owner = await f.login();
  assert.equal((await f.host.photo.catalog()).miniProgramCreation.available, true);
  assert.equal((await f.request('/api/capabilities', { token: owner.token })).body.data[0].ready, true);
  assert.equal((await f.request('/api/catalog', { token: owner.token })).body.data.miniProgramCreation.available, true);
  const anonymousCapabilities = await f.request('/api/capabilities');
  assert.equal(anonymousCapabilities.status, 200); assert.equal(anonymousCapabilities.body.data[0].ready, false);
  const anonymousCatalog = await f.request('/api/catalog');
  assert.equal(anonymousCatalog.status, 200); assert.equal(anonymousCatalog.body.data.miniProgramCreation.available, false);
  assert.equal(anonymousCatalog.body.data.settings.generationEnabled, false); assert.deepEqual(anonymousCatalog.body.data.photoEffects, []);
  for (const route of ['/api/catalog', '/api/capabilities']) {
    assert.equal((await f.request(route, { token: 'invalid-session-token' })).status, 401);
    assert.equal((await f.request(route, { headers: { Authorization: 'Basic invalid' } })).status, 401);
  }
  assert.equal((await f.request('/api/public/compliance')).status, 200);
  assert.equal(f.counts.put + f.counts.generate + f.counts.review + f.counts.query, 0);
  assert.equal((await f.ledger.orders()).length, 0);
});

test('closed picture service keeps original upload, own order, restore, withdrawal and cleanup available', async t => {
  const f = await fixture(t, { enabled: true, pictureReady: true, publicProfile: disclosures() });
  const owner = await f.login(); const other = await f.login('other'); await f.agree(owner.token);
  const order = await seedPaid(f, owner); const upload = (await f.upload(owner.token)).body.data.upload;
  f.state.pictureReady = false;
  assert.equal((await f.request('/api/mini/photo-uploads/' + upload.id, { token: owner.token })).status, 200);
  assert.equal((await f.request('/api/mini/photo-uploads/' + upload.id, { token: other.token })).status, 404);
  assert.equal((await f.request('/api/mini/payments/orders/' + order.id, { token: owner.token })).body.data.status, 'paid');
  const restore = await f.request('/api/account/restore-purchases', { method: 'POST', token: owner.token });
  assert.equal(restore.body.data.entitlements.available.photo, 10);
  const refund = await f.request(`/api/mini/payments/orders/${order.id}/refund`, { method: 'POST', token: owner.token, body: {} });
  assert.equal(refund.status, 200); assert.equal(refund.body.data.status, 'requested');
  assert.equal((await f.request(`/api/mini/payments/sandbox/refunds/${refund.body.data.id}/confirm`, { method: 'POST', token: owner.token, body: {confirm:true} })).status, 404);
  const withdrawn = await f.request('/api/consents/basic/withdraw', { method: 'POST', token: owner.token, body: {} });
  assert.equal(withdrawn.status, 202); assert.equal(withdrawn.body.data.accessRevoked, true);
  await f.host.runOnce({ process: true, cleanup: true });
  assert.equal(f.counts.cleanup, 1); assert.equal(f.counts.review + f.counts.generate + f.counts.query, 0);
});

test('env0 paid credits reserve once through actual photo job HTTP and remain recoverable when creation closes', async t => {
  const f = await fixture(t, { enabled: true, pictureReady: true, publicProfile: disclosures() });
  const owner = await f.login(); const other = await f.login('other'); await f.agree(owner.token); await seedPaid(f, owner);
  // Server-trusted synthetic media receipt, not a user request or real Green verification.
  const asset = { id: 'fixture_input', storageKey: 'private/photo-inputs/fixture.png', sha256: sha(png), byteLength: png.length,
    contentType: 'image/png', expiresAt: now() + 60000, moderation: { decision: 'allow', reference: 'fixture_receipt',
      sha256: sha(png), direction: 'input', version: policy.moderationVersion, service: policy.moderationService } };
  await f.host.photo.context.registerInput(owner.user.id, asset);
  const submit = token => f.request('/api/mini/photo-jobs', { method: 'POST', token, headers: { 'Idempotency-Key': key(17) },
    body: { effectId: effect.id, inputAssetId: asset.id } });
  const first = await submit(owner.token); assert.equal(first.status, 202); const job = first.body.data.job;
  const duplicate = await submit(owner.token); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.data.job.id, job.id);
  assert.deepEqual(await f.rows('SELECT remaining,reserved,frozen FROM vp_buckets'), [{remaining:9,reserved:1,frozen:0}]);
  f.state.pictureReady = false;
  assert.equal((await submit(owner.token)).body.code, 'PHOTO_PRODUCTION_GENERATION_CLOSED');
  const recovered = await f.request('/api/mini/photo-jobs/by-key/' + key(17), {token:owner.token});
  assert.equal(recovered.body.data.job.id, job.id);
  assert.equal((await f.request('/api/mini/photo-jobs/' + job.id, {token:other.token})).status, 404);
  assert.deepEqual(await f.rows('SELECT remaining,reserved,frozen FROM vp_buckets'), [{remaining:9,reserved:1,frozen:0}]);
  assert.equal(f.counts.review + f.counts.generate + f.counts.query, 0);
});

test('outer gate refuses an incorrectly enabled child factory and second-database assembly', async t => {
  const f = await fixture(t, { enabled: false, pictureReady: true, paymentReady: true, publicProfile: disclosures(), mode: 'live', misassembled: true });
  const owner = await f.login();
  assert.equal((await f.host.photo.catalog()).miniProgramCreation.available, true);
  assert.equal((await f.upload(owner.token)).status, 503);
  assert.equal((await createOrder(f, owner.token)).status, 503);
  await f.host.runOnce({ process: true, cleanup: true });
  assert.equal(f.counts.put + f.counts.generate + f.counts.review, 0); assert.equal(f.counts.cleanup, 1);
  assert.throws(() => f.build({ adapter: { ...f.settings.adapter, env: 1 } }), /SCOPE_REQUIRED/);
  assert.throws(() => f.build({ photoApplicationFactory: shared => ({ active: true, managesSales: false,
    context: { database: {} }, mount() {}, prepare() {}, catalog() {}, runOnce() {}, drain() {} }) }), /SHARED_DATABASE_REQUIRED/);
  await f.rows('UPDATE vp_environment SET env=1');
  assert.equal((await f.request('/api/auth/wechat', {method:'POST',body:{code:'owner'}})).status, 503);
  assert.deepEqual(await f.host.reconcileOnce(), { skipped: true });
});

test('photo upload owns its large body while payment and consent limits remain smaller', async t => {
  const f = await fixture(t, { enabled: true, pictureReady: true, publicProfile: disclosures() });
  const owner = await f.login(); await f.agree(owner.token);
  assert.equal((await f.upload(owner.token, 1, 200000)).status, 202);
  assert.equal((await f.request('/api/mini/payments/orders', {method:'POST',token:owner.token,
    headers:{'Content-Length':'1'},body:{padding:'x'.repeat(128*1024)}})).status, 413);
  assert.equal((await f.request('/api/consents', {method:'POST',token:owner.token,body:{padding:'x'.repeat(2048)}})).status, 413);
  assert.equal(f.counts.put, 1); assert.deepEqual(await f.ledger.orders(), []);
});

test('drain stops admission and waits for an admitted private PUT plus its queued SQL receipt without closing DB', async t => {
  const putGate = { ...deferred(), started: deferred() };
  const f = await fixture(t, { enabled: true, pictureReady: true, publicProfile: disclosures(), putGate });
  const owner = await f.login(); await f.agree(owner.token);
  const pendingUpload = f.upload(owner.token); await putGate.started.promise;
  let drained = false; const pendingDrain = f.host.drain().then(value => {drained=true;return value;});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(drained, false);
  assert.equal((await f.request('/api/account/entitlements', {token:owner.token})).status, 503);
  putGate.resolve(); assert.equal((await pendingUpload).status, 202);
  const result = await pendingDrain; assert.equal(result.databaseClosed, false); assert.equal(result.active, 0);
  const rows = await f.rows('SELECT state FROM mini_photo_uploads'); assert.deepEqual(rows.map(row=>row.state), ['queued']);
  assert.equal(f.counts.put, 1); assert.equal(f.counts.review + f.counts.generate, 0);
});
