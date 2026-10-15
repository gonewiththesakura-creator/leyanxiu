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
import { registerNativePhotoRoutes } from '../photo-jobs/native-routes.js';
const { createCreationClient } = createRequire(import.meta.url)('../../miniprogram/creation.js');

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const grant = (consentType, extra = {}) => ({ consentType, action: 'granted',
  version: consentType === 'basic' ? 'basic_v1' : 'face_v1', ...(consentType === 'face_processing' ? { subjectAuthorization: 'self' } : {}), ...extra });
async function fixture(t, { signer } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-native-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'isolated.sqlite'), migrate: true });
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let timestamp = 100000, ready = true;
  const rows = (sql, args = []) => database.transaction(q => q(sql, args));
  const ledger = createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now: () => timestamp });
  const context = createPhotoJobContext({ ledger, now: () => timestamp,
    policy: { basicVersion: 'basic_v1', faceVersion: 'face_v1', labelVersion: 'mark_v1' } });
  await database.transaction(async q => {
    for (const sql of photoContextSchema('sqlite')) await q(sql);
    await q(photoJobsSchema('sqlite'));
    for (const userId of ['buyer', 'stranger']) await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [userId, 'fixture_app', userId]);
    await q('INSERT INTO vp_orders(id,user_id,idem,status,payload,created_at) VALUES (?,?,?,?,?,?)',
      ['order1', 'buyer', 'fixture_order_key', 'paid', JSON.stringify({ id: 'order1', userId: 'buyer', status: 'paid', product: { type: 'pack' } }), timestamp]);
    await q('INSERT INTO vp_buckets(id,user_id,order_id,kind,starts_at,expires_at,quantity,remaining,value_fen) VALUES (?,?,?,?,?,?,?,?,?)',
      ['bucket1', 'buyer', 'order1', 'photo', 0, timestamp + 86400000, 10, 10, 990]);
  });
  const signCalls = [];
  const normalSign = args => ({ assetId: args.assetId, url: `https://media.example.test/${args.assetId}?signature=REDACTED_SECRET expiresAt: args.expiresAt });
  const mediaUrl = { allowedHosts: ['media.example.test'], maxAgeMs: 60000,
    async sign(args) { signCalls.push({ ...args }); return signer ? signer(args, normalSign) : normalSign(args); } };
  const authenticated = c => {
    const user = c.req.header('authorization')?.replace('Bearer ', '');
    return { auth: ['buyer', 'stranger', 'missing', 'legacy'].includes(user)
      ? { userId: user === 'legacy' ? 'buyer' : user, authMethod: user === 'legacy' ? 'phone' : 'wechat' } : null };
  };
  const app = new Hono();
  registerNativePhotoRoutes(app, { authenticated, context, ready: () => ({ ready }), mediaUrl, now: () => timestamp });
  const request = async (url, { method = 'GET', body, user = 'buyer' } = {}) => {
    const response = await app.request(url, { method, headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const agree = async () => {
    assert.equal((await request('/api/consents', { method: 'POST', body: grant('basic') })).status, 200);
    assert.equal((await request('/api/consents', { method: 'POST', body: grant('face_processing') })).status, 200);
  };
  const asset = (id, kind) => ({ id, storageKey: `private/fixture/${id}.png`, sha256: 'a'.repeat(64), byteLength: 123,
    contentType: 'image/png', expiresAt: timestamp + 300000, moderation: { decision: 'allow', reference: 'fixture_receipt' },
    ...(kind === 'output' ? { labelVersion: 'mark_v1' } : {}) });
  let sequence = 0;
  const makeWork = async ({ publish = true } = {}) => {
    const suffix = ++sequence, input = `input_${suffix}`, output = `output_${suffix}`;
    await context.putEffect({ id: 'repair', version: 'v1', provider: 'fictional', model: 'fixture-model',
      purpose: 'photo-effect:repair', parameters: {}, enabled: true, reviewReference: 'fixture_review' });
    await context.registerInput('buyer', asset(input, 'input'));
    const spec = await context.submission({ userId: 'buyer', idempotencyKey: String(suffix).repeat(32), inputAssetId: input, effectId: 'repair' });
    const result = await context.repository.submit(spec);
    if (publish) {
      const worker = createPhotoJobWorker({ repository: context.repository, runProvider: async ({ jobId, userId }) => {
        await context.registerOutput(userId, jobId, asset(output, 'output'));
        return { assetId: output, providerRef: `fixture_${suffix}` };
      } });
      await worker.runOnce(); await worker.drain();
    } else {
      const claimed = await context.repository.claimNext();
      await context.registerOutput('buyer', claimed.id, asset(output, 'output'));
    }
    return { input, output, job: result.job };
  };
  return { app, context, database, ledger, rows, request, agree, makeWork, asset, signCalls, mediaUrl, authenticated,
    now: () => timestamp, advance: delta => { timestamp += delta; }, closed: () => { ready = false; }, open: () => { ready = true; } };
}

test('native HTTP uses one SQL consent source and rejects forged versions, identity and review flags', async t => {
  const f = await fixture(t);
  const initial = await f.request('/api/consents');
  assert.deepEqual(initial.body.data, { current: { basic: 'basic_v1', face_processing: 'face_v1' }, basicGranted: false, faceGranted: false });
  assert.match(initial.headers.get('cache-control'), /no-store/);
  assert.equal((await f.request('/api/consents', { method: 'POST', body: grant('face_processing') })).status, 403);
  assert.equal((await f.request('/api/consents', { method: 'POST', body: grant('basic', { version: 'client_v2' }) })).status, 409);
  for (const field of ['userId', 'reviewed', 'noticeSha256', 'current', 'subjectAuthorization']) {
    assert.equal((await f.request('/api/consents', { method: 'POST', body: grant('basic', { [field]: 'forged' }) })).status, 400);
  }
  assert.equal((await f.request('/api/consents', { method: 'POST', body: 'not-json' })).status, 400);
  assert.equal((await f.request('/api/consents', { method: 'POST', body: grant('basic', { payload: 'x'.repeat(1100) }) })).status, 413);
  assert.equal((await f.rows('SELECT * FROM mini_photo_accounts')).length, 0);
  await f.agree();
  assert.equal((await f.context.readConsents('buyer')).faceGranted, true);
  assert.equal((await f.context.readConsents('stranger')).basicGranted, false);
  assert.deepEqual((await f.rows('SELECT action FROM vp_audit')).map(row => row.action), ['photo.consent.basic_granted', 'photo.consent.face_granted']);
});

test('unauthenticated, legacy and nonexistent WeChat identities cannot grant or read private media', async t => {
  const f = await fixture(t); await f.agree(); const work = await f.makeWork();
  const endpoints = [ ['/api/consents', 'GET'], ['/api/consents', 'POST', grant('basic')],
    ['/api/consents/basic/withdraw', 'POST'], [`/api/assets/${work.output}/url`, 'GET'],
    [`/api/assets/${work.output}`, 'DELETE'], ['/api/works', 'GET'] ];
  for (const user of ['none', 'legacy', 'missing']) for (const [url, method, body] of endpoints) {
    assert.equal((await f.request(url, { user, method, body })).status, 401);
  }
  assert.equal(f.signCalls.length, 0); assert.equal((await f.context.readConsents('buyer')).faceGranted, true);
});

test('basic withdrawal revokes both consents and existing assets but allows explicit new consent without restoring old photos', async t => {
  const f = await fixture(t); await f.agree(); const work = await f.makeWork();
  const rights = await f.rows('SELECT remaining,reserved FROM vp_buckets');
  const result = await f.request('/api/consents/basic/withdraw', { method: 'POST' });
  assert.equal(result.status, 202); assert.equal(result.body.code, 'ERASURE_PARTIAL');
  assert.equal(result.body.data.consent.action, 'withdrawn'); assert.equal(result.body.data.physicalDeletion, 'pending');
  assert.equal(result.body.data.accessRevoked, true); assert.equal(result.body.data.deletionScheduled, false);
  assert.deepEqual(await f.context.readConsents('buyer'), { current: { basic: 'basic_v1', face_processing: 'face_v1' }, basicGranted: false, faceGranted: false });
  const row = (await f.rows('SELECT enabled,consent_epoch FROM mini_photo_accounts WHERE user_id = ?', ['buyer']))[0];
  assert.deepEqual(row, { enabled: 1, consent_epoch: 1 });
  assert.equal((await f.request(`/api/assets/${work.output}/url`)).status, 404);
  assert.deepEqual((await f.request('/api/works')).body.data, []);
  await f.agree();
  assert.equal((await f.context.readConsents('buyer')).faceGranted, true);
  assert.equal((await f.request(`/api/assets/${work.input}/url`)).status, 404);
  assert.equal((await f.request(`/api/assets/${work.output}/url`)).status, 404);
  assert.deepEqual(await f.rows('SELECT remaining,reserved FROM vp_buckets'), rights);
  const fresh = await f.makeWork(); assert.equal((await f.request(`/api/assets/${fresh.output}/url`)).status, 200);
});

test('face withdrawal preserves basic permission, rejects forged withdrawal bodies and never reenables disabled accounts', async t => {
  const f = await fixture(t); await f.agree();
  assert.equal((await f.request('/api/consents/face_processing/withdraw', { method: 'POST', body: { userId: 'stranger' } })).status, 400);
  assert.equal((await f.request('/api/consents/marketing/withdraw', { method: 'POST' })).status, 400);
  assert.equal((await f.request('/api/consents/face_processing/withdraw', { method: 'POST', body: {} })).status, 202);
  assert.equal((await f.context.readConsents('buyer')).basicGranted, true);
  assert.equal((await f.context.readConsents('buyer')).faceGranted, false);
  await f.context.disableAccount('buyer');
  await f.request('/api/consents/basic/withdraw', { method: 'POST' });
  assert.equal((await f.request('/api/consents', { method: 'POST', body: grant('basic') })).status, 403);
  assert.equal((await f.rows('SELECT enabled FROM mini_photo_accounts WHERE user_id = ?', ['buyer']))[0].enabled, 0);
});

test('works and URLs expose only owned published unexpired media, with private signing and no internal evidence', async t => {
  const f = await fixture(t); await f.agree(); const published = await f.makeWork(); const staged = await f.makeWork({ publish: false });
  const works = await f.request('/api/works');
  assert.equal(works.status, 200); assert.deepEqual(works.body.data.map(item => item.assetId), [published.output]);
  assert.equal(works.body.data[0].urlExpiresAt, f.now() + 60000);
  assert.equal(works.body.data[0].expiresAt, f.now() + 300000);
  assert.equal(works.body.data[0].contentType, 'image/png'); assert.equal(works.body.data[0].ext, 'png');
  assert.doesNotMatch(JSON.stringify(works.body), /storageKey|sha256|fixture-model|moderation|private\/fixture/);
  assert.equal((await f.request(`/api/assets/${published.output}/url`, { user: 'stranger' })).status, 404);
  assert.equal((await f.request(`/api/assets/${staged.output}/url`)).status, 404);
  assert.deepEqual((await f.request('/api/works', { user: 'stranger' })).body.data, []);
  f.advance(300000);
  assert.equal((await f.request(`/api/assets/${published.output}/url`)).status, 404);
  assert.deepEqual((await f.request('/api/works')).body.data, []);
});

test('DELETE revokes visibility with partial erasure, never leaks keys or alters credits, including repeated requests', async t => {
  const f = await fixture(t); await f.agree(); const work = await f.makeWork();
  const before = await f.rows('SELECT remaining,reserved FROM vp_buckets');
  assert.equal((await f.request(`/api/assets/${work.output}`, { method: 'DELETE', user: 'stranger' })).status, 404);
  for (let i = 0; i < 2; i++) {
    const result = await f.request(`/api/assets/${work.output}`, { method: 'DELETE' });
    assert.equal(result.status, 202); assert.equal(result.body.code, 'ERASURE_PARTIAL');
    assert.equal(result.body.data.deleted, true); assert.equal(result.body.data.physicalDeletion, 'pending');
    assert.equal(result.body.data.deletionScheduled, false);
    assert.doesNotMatch(JSON.stringify(result.body), /storageKey|private\/fixture|sha256/);
  }
  assert.equal((await f.request(`/api/assets/${work.output}/url`)).status, 404);
  assert.deepEqual((await f.request('/api/works')).body.data, []);
  assert.deepEqual(await f.rows('SELECT remaining,reserved FROM vp_buckets'), before);
});

test('closed generation readiness preserves privacy withdrawal, deletion, existing downloads and recovery', async t => {
  const f = await fixture(t); await f.agree(); const work = await f.makeWork(); f.closed();
  assert.equal((await f.request('/api/consents', { method: 'POST', body: grant('basic') })).status, 503);
  assert.equal((await f.request('/api/works')).body.data.length, 1);
  assert.equal((await f.request(`/api/assets/${work.output}/url`)).status, 200);
  assert.equal((await f.request(`/api/assets/${work.output}`, { method: 'DELETE' })).status, 202);
  assert.equal((await f.request('/api/consents/face_processing/withdraw', { method: 'POST' })).status, 202);
});

test('invalid or overlong private URL receipts never reach native clients', async t => {
  const variants = [
    (r, a) => ({ ...r, assetId: 'other' }),
    r => ({ ...r, url: 'http://media.example.test/image' }),
    r => ({ ...r, url: 'https://public.example.test/image' }),
    r => ({ ...r, url: 'https://media.example.test.evil.test/image' }),
    r => ({ ...r, url: 'https://REDACTED_USER:REDACTED_PASSWORD@media.example.test/image' }),
    r => ({ ...r, url: 'https://media.example.test:8443/image' }),
    r => ({ ...r, url: 'https://media.example.test/image#private' }),
    (r, a) => ({ ...r, expiresAt: a.expiresAt + 1 }),
    r => ({ ...r, expiresAt: 100000 }),
    r => ({ ...r, expiresAt: String(r.expiresAt) }),
  ];
  for (const [index, mutate] of variants.entries()) await t.test(String(index), async t => {
    const f = await fixture(t, { signer: (args, normal) => mutate(normal(args), args) });
    await f.agree(); const work = await f.makeWork();
    const result = await f.request(`/api/assets/${work.output}/url`);
    assert.equal(result.status, 503); assert.equal(result.body.data, undefined);
    assert.doesNotMatch(JSON.stringify(result.body), /https:|secret|storageKey/);
  });
});

test('signing expiry is clamped to the asset lifetime and caller-owned signing properties are read once', async t => {
  let reads = 0;
  const f = await fixture(t, { signer: (args, normal) => ({ ...normal(args), get url() {
    reads++; return reads === 1 ? normal(args).url : 'https://evil.test';
  } }) });
  await f.agree(); const work = await f.makeWork(); f.advance(299000);
  const result = await f.request(`/api/assets/${work.output}/url`);
  assert.equal(result.status, 200); assert.equal(reads, 1); assert.equal(result.body.data.urlExpiresAt, f.now() + 1000);
});

test('withdrawal, deletion or expiry while signing prevents a late link from disclosing the photo', async t => {
  for (const mode of ['withdraw', 'delete', 'expire']) await t.test(mode, async t => {
    const started = deferred(), resume = deferred();
    const f = await fixture(t, { signer: async (args, normal) => { started.resolve(); await resume.promise; return normal(args); } });
    await f.agree(); const work = await f.makeWork();
    const pending = f.request(`/api/assets/${work.output}/url`); await started.promise;
    if (mode === 'withdraw') { await f.context.withdrawFaceConsent('buyer'); await f.agree(); }
    if (mode === 'delete') await f.context.deleteAsset('buyer', work.output);
    if (mode === 'expire') f.advance(300000);
    resume.resolve(); const result = await pending;
    assert.ok([404, 503].includes(result.status)); assert.equal(result.body.data, undefined);
  });
});

test('a multi-work response cannot restore an earlier signed photo withdrawn during a later signature', async t => {
  const started = deferred(), resume = deferred(); let count = 0;
  const f = await fixture(t, { signer: async (args, normal) => {
    if (++count === 2) { started.resolve(); await resume.promise; } return normal(args);
  } });
  await f.agree(); await f.makeWork(); await f.makeWork();
  const pending = f.request('/api/works'); await started.promise;
  await f.context.withdrawBasicConsent('buyer'); await f.agree(); resume.resolve();
  assert.deepEqual((await pending).body.data, []);
});

test('commit reply loss stays unconfirmed even if a withdrawal committed; no raw SQL or private data escapes', async t => {
  const f = await fixture(t); await f.agree(); await f.makeWork();
  const original = f.context.withdrawBasicConsent.bind(f.context);
  f.context.withdrawBasicConsent = async userId => { await original(userId); throw new Error('DB_COMMIT_UNKNOWN sql secret private/fixture/key'); };
  const result = await f.request('/api/consents/basic/withdraw', { method: 'POST' });
  assert.equal(result.status, 503); assert.equal(result.body.code, 'PHOTO_NATIVE_UNCONFIRMED');
  assert.equal(result.body.data, undefined); assert.doesNotMatch(JSON.stringify(result.body), /sql|secret|private/);
  assert.equal((await f.context.readConsents('buyer')).basicGranted, false);
  assert.deepEqual((await f.request('/api/works')).body.data, []);
});

test('native routes mounted before overlapping legacy routes never fall through on success or rejection', async t => {
  const f = await fixture(t); let legacy = 0;
  for (const route of ['/api/consents', '/api/consents/:type/withdraw', '/api/assets/:id/url', '/api/assets/:id', '/api/works']) {
    f.app.all(route, c => { legacy++; return c.json({ legacy: true }); });
  }
  await f.agree();
  assert.equal((await f.request('/api/consents', { user: 'legacy' })).status, 401);
  assert.equal((await f.request('/api/consents/basic/withdraw', { method: 'POST' })).status, 202);
  assert.equal((await f.request('/api/assets/missing/url')).status, 404);
  assert.equal((await f.request('/api/assets/missing', { method: 'DELETE' })).status, 404);
  assert.deepEqual((await f.request('/api/works')).body.data, []); assert.equal(legacy, 0);
});

test('the actual native client grants consent, reads signed works and acknowledges partial deletion through Hono and SQL', async t => {
  const f = await fixture(t);
  // Only public configuration, wx login and the storage signer are fictional;
  // the actual client, Hono privacy routes, context and ledger are exercised.
  const reply = data => ({ code: 0, data });
  f.app.post('/api/auth/wechat', c => c.json(reply({ token: 'buyer', user: { id: 'buyer' } })));
  f.app.get('/api/catalog', c => c.json(reply({ settings: { generationEnabled: true },
    miniProgramCreation: { available: true, jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1', photoEffectIds: ['repair'] },
    photoEffects: [{ id: 'repair', enabled: true, title: 'Fictional test effect' }] })));
  f.app.get('/api/public/compliance', c => c.json(reply({ status: 'approved', operatorName: 'Fictional operator',
    consentVersions: { basic: 'basic_v1', faceProcessing: 'face_v1' },
    retention: { sourceHours: 24, resultHours: 24, supplierPolicy: 'Fictional policy' },
    aiServices: [{ provider: 'fictional', model: 'fixture-model', filingReference: 'fictional-reference', purpose: 'fixture', region: 'fictional', capabilities: ['photo-effect'] }] })));
  f.app.get('/api/capabilities', c => c.json(reply([{ id: 'photo-effects', ready: true, status: 'verified' }])));
  f.app.get('/api/mini/payments/entitlements', async c => c.json(reply(await f.ledger.entitlements('buyer'))));
  const storage = new Map();
  const wx = { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, structuredClone(value)), removeStorageSync: key => storage.delete(key),
    login: options => options.success({ code: 'fictional_login' }), requestVirtualPayment: () => assert.fail('privacy APIs must not create a payment'),
    cloud: { callContainer: async options => {
      const response = await f.app.request(options.path, { method: options.method, headers: options.header,
        ...(options.data ? { body: JSON.stringify(options.data) } : {}) });
      return { statusCode: response.status, data: await response.json() };
    } } };
  const client = createCreationClient(wx, { mode: 'cloud', env: 'fixture', service: 'fixture' }, { enabled: true });
  assert.equal((await client.refresh()).available, true);
  await client.authorize({ basicAgreed: true, faceAgreed: true, subjectAuthorization: 'self', basicVersion: 'basic_v1', faceVersion: 'face_v1' });
  const work = await f.makeWork();
  const works = (await client.refresh()).works;
  assert.equal(works.length, 1); assert.equal(works[0].assetId, work.output); assert.match(works[0].url, /^https:\/\/media\.example\.test\//);
  assert.equal((await client.assetUrl(work.output)).assetId, work.output);
  const removed = await client.deleteAsset(work.output);
  assert.equal(removed.partial, true); assert.equal(removed.data.physicalDeletion, 'pending');
  assert.deepEqual((await client.refresh()).works, []);
  assert.equal((await client.withdrawFaceConsent()).partial, true);
  assert.equal((await f.context.readConsents('buyer')).faceGranted, false);
});
