import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { miniIdentitySchema } from '../payments/virtual/mini-identity.js';
import { photoContextSchema } from '../photo-jobs/context.js';
import { photoJobsSchema } from '../photo-jobs/repository.js';
import { photoUploadSchema, photoUploadCleanupSchema } from '../photo-jobs/upload-repository.js';
import { photoGenerationSchema } from '../photo-jobs/generation-repository.js';
import { QWEN_PHOTO_PROVIDER, QWEN_PHOTO_MODEL, QWEN_PHOTO_RESULT_POLICY, QWEN_PHOTO_RESULT_HOSTS } from '../photo-jobs/qwen-provider.js';
import { photoCandidateConfig, createPhotoCandidateInspector, createPhotoCandidatePorts, startPhotoCandidateServer } from '../photo-jobs/candidate-server.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const serverRoot = fileURLToPath(new URL('../', import.meta.url));
const appId = 'wx1234567890abcdef';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const approved = () => ({ version: 1, policy: { approved: true, reviewReference: 'fixture_review', acceptanceVersion: 'fixture_probe_v2',
  serviceProviderCode: appId, provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, resultUrlPolicy: QWEN_PHOTO_RESULT_POLICY,
  sourceHosts: [...QWEN_PHOTO_RESULT_HOSTS], operation: 'edit', basicVersion: 'fixture_basic', faceVersion: 'fixture_face',
  labelVersion: 'fixture_probe_v2', moderationVersion: 'fixture_probe_v2', moderationService: 'aigcCheck',
  sourceRetentionMs: 86400000, resultRetentionMs: 86400000, maxDailyUploads: 20, maxDailyUploadsPerUser: 10 }, approvedEffects: [],
  moderationPolicy: { approved: true, version: 'fixture_probe_v2', region: 'cn-shanghai', services: { input: 'baselineCheck', output: 'aigcCheck' },
    lowRisk: 'review', timeoutMs: 10000, maxBytes: 20 * 1024 * 1024 },
  cleanupPolicy: { timeoutMs: 1000, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000 } });

function configFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-entry-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const file = path.join(directory, 'policy.json'), document = approved();
  const save = value => { const bytes = Buffer.from(JSON.stringify(value)); fs.writeFileSync(file, bytes); return sha(bytes); };
  const env = { RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENABLED: 'true', XPAY_ENV: '1',
    XPAY_MODE: 'closed', XPAY_DB_BACKEND: 'mysql', WECHAT_APP_ID: appId, WECHAT_APP_SECRET: 'synthetic-app-secret',
    XPAY_SESSION_ENCRYPTION_KEY: '8'.repeat(64), PHOTO_CANDIDATE_CONFIG_FILE: file, PHOTO_CANDIDATE_CONFIG_SHA256: save(document),
    OSS_BUCKET: 'fixture-private-bucket', OSS_REGION: 'oss-cn-shanghai', PYTHON_PATH: process.execPath,
    AI_MARK_FONT: path.join(directory, 'fixture-font'), BIND_HOST: '127.0.0.1' };
  return { directory, file, document, env, save };
}

async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}

async function runtimeFixture(t, { photos = true, rawDrain, dbBackend = 'mysql' } = {}) {
  const f = configFixture(t);
  const source = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(f.directory, 'fixture.sqlite'), migrate: true });
  let closed = false;
  t.after(async () => { if (!closed) { await source.close(); closed = true; } });
  await source.transaction(async q => {
    for (const sql of miniIdentitySchema('sqlite')) await q(sql);
    await q('INSERT INTO vp_environment(id,app_id,env) VALUES (1,?,1)', [appId]);
    if (photos) {
      for (const sql of photoContextSchema('sqlite')) await q(sql);
      await q(photoJobsSchema('sqlite')); await q(photoUploadSchema('sqlite')); await q(photoUploadCleanupSchema('sqlite'));
      for (const sql of photoGenerationSchema('sqlite')) await q(sql);
    }
  });
  const sql = [], calls = { provider: 0, moderation: 0, storage: 0, inspect: 0, runtime: 0, ports: 0, close: 0 };
  // Explicit test double only. It exposes the MySQL runtime shape to the entry;
  // all real SQL is executed by an isolated SQLite DB, stripping row-lock syntax.
  // This is not a MySQL/runtime or deployment acceptance claim.
  const database = { backend: dbBackend, transaction: callback => source.transaction(q => callback((statement, values) => {
    sql.push(statement); return q(statement.replace(/ FOR UPDATE/g, ''), values);
  })), async close() { calls.close++; if (!closed) { await source.close(); closed = true; } } };
  const ledger = createVirtualLedger({ database, encryptionKey: f.env.XPAY_SESSION_ENCRYPTION_KEY });
  const runtime = { ledger, adapter: { appId, env: 1 }, codec: {} };
  const forbidden = kind => async () => { calls[kind]++; throw new Error('unexpected synthetic upstream'); };
  const storage = { put: forbidden('storage'), read: forbidden('storage'), delete: forbidden('storage'), inspect: forbidden('storage'), signedUrl: forbidden('storage') };
  const ports = { inputStorage: storage, outputStorage: storage, sourceCleanup: storage, moderationCleanup: storage,
    moderator: { moderate: forbidden('moderation') }, provider: { generate: forbidden('provider'), readGenerated: forbidden('provider') },
    marker: { mark: forbidden('provider') }, inspectPrerequisites: async () => { calls.inspect++; return { marker: { ready: false } }; },
    drain: async () => { if (rawDrain) await rawDrain.promise; } };
  f.env.PORT = String(await freePort()); const signals = new EventEmitter(), logs = [];
  const options = { env: f.env, runtimeFactory: async () => { calls.runtime++; return runtime; },
    portsFactory: async () => { calls.ports++; return ports; }, signals, logger: value => logs.push(value) };
  return { ...f, database, options, calls, sql, signals, logs, isClosed: () => closed };
}

test('import does not start a listener, read private env, schedule workers or call a provider', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./photo-jobs/candidate-server.js'); console.log('import-only');"],
    { cwd: serverRoot, encoding: 'utf8', timeout: 10000, env: { ...process.env, PHOTO_CANDIDATE_CONFIG_FILE: 'must-not-read' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'import-only'); assert.equal(result.stderr, '');
});

test('configuration defaults all work switches closed and rejects typo/env0/SQLite/open purchase before runtime', async t => {
  const f = configFixture(t), c = photoCandidateConfig(f.env);
  for (const name of ['purchaseEnabled', 'generationEnabled', 'processEnabled', 'cleanupEnabled', 'reconcileEnabled']) assert.equal(c[name], false);
  assert.equal(c.acceptanceFile, null); assert.ok(Object.isFrozen(c.policy));
  for (const change of [{ XPAY_ENV: '0' }, { XPAY_DB_BACKEND: 'sqlite' }, { XPAY_MODE: 'sandbox' },
    { PHOTO_CANDIDATE_GENERATION_ENABLED: 'yes' }, { PHOTO_CANDIDATE_PROCESS_ENABLED: 'true' },
    { PHOTO_CANDIDATE_GENERATION_ENABLED: 'true' }, { NODE_TLS_REJECT_UNAUTHORIZED: '0' },
    { DEBUG: '*' }, { NODE_DEBUG: 'http' }, { NODE_DEBUG_NATIVE: 'TLS' },
    { PORT: '3000x' }, { PORT: '0' }, { BIND_HOST: 'unexpected-host' }, { PYTHON_PATH: 'python' }]) {
    let touched = 0;
    await assert.rejects(startPhotoCandidateServer({ env: { ...f.env, ...change }, runtimeFactory: async () => { touched++; },
      portsFactory: async () => { touched++; } }), /PHOTO_|XPAY_/);
    assert.equal(touched, 0);
  }
});

test('entry projects existing model disclosures and retention without opening any work switch or exposing private references', t => {
  const f = configFixture(t);
  const env = { ...f.env, PRIVACY_POLICY_URL: 'https://example.com/privacy', USER_AGREEMENT_URL: 'https://example.com/terms',
    THIRD_PARTY_LIST_URL: 'https://example.com/processors', PIPIA_REFERENCE: 'private-fixture-assessment',
    RETENTION_SUPPLIER_POLICY: '隔离测试的保存与删除说明。',
    AI_SERVICE_DISCLOSURES_JSON: JSON.stringify([{ provider: f.document.policy.provider, model: f.document.policy.model,
      filingReference: '仅测试的公开备案编号', purpose: '仅测试的图片处理', region: '仅测试的境内地域', capabilities: ['photo-effect'] }]) };
  const value = photoCandidateConfig(env);
  assert.equal(value.publicProfile.status, 'approved'); assert.equal(value.publicProfile.retention.sourceHours, 24);
  assert.equal(value.publicProfile.aiServices[0].model, f.document.policy.model);
  assert.ok(!JSON.stringify(value.publicProfile).includes('private-fixture-'));
  for (const name of ['purchaseEnabled', 'generationEnabled', 'processEnabled', 'cleanupEnabled', 'reconcileEnabled']) assert.equal(value[name], false);
  assert.equal(photoCandidateConfig({ ...env, PIPIA_REFERENCE: '' }).publicProfile.status, 'pending_company_approval');
});

test('pinned configuration refuses changed bytes and incompatible input/output moderation policy', t => {
  const f = configFixture(t);
  fs.appendFileSync(f.file, ' '); assert.throws(() => photoCandidateConfig(f.env), /PINNED_FILE_MISMATCH/);
  for (const mutate of [p => { p.policy.serviceProviderCode = 'fake_operator'; }, p => { p.policy.model = 'unreviewed'; },
    p => { p.moderationPolicy.services.input = 'aigcCheck'; }, p => { p.moderationPolicy.services.output = 'baselineCheck'; },
    p => { p.moderationPolicy.lowRisk = 'allow'; }, p => { p.extra = true; }, p => { p.policy.maxDailyUploads = 0; }]) {
    const changed = approved(); mutate(changed); f.env.PHOTO_CANDIDATE_CONFIG_SHA256 = f.save(changed);
    assert.throws(() => photoCandidateConfig(f.env), /PHOTO_CANDIDATE_/);
  }
});

test('inspector verifies actual configured files with a child allowlist, caches unchanged tools and never invents acceptance', async t => {
  const f = configFixture(t); fs.writeFileSync(f.env.AI_MARK_FONT, 'synthetic font');
  const c = photoCandidateConfig(f.env); let runs = 0;
  const inspect = createPhotoCandidateInspector(c, { execute: (python, args, options, done) => {
    runs++; assert.equal(python, c.python); assert.equal(args[1], '--check-font'); assert.equal(options.env.AI_MARK_FONT, c.font);
    assert.equal(options.env.WECHAT_APP_SECRET, undefined); assert.equal(options.env.DASHSCOPE_API_KEY, undefined); done(null);
  } });
  assert.equal((await inspect()).marker.ready, true); assert.equal((await inspect()).providerEvidence, undefined); assert.equal(runs, 1);
  fs.appendFileSync(c.font, 'changed'); await inspect(); assert.equal(runs, 2);
  fs.rmSync(c.font); assert.equal((await inspect()).marker.ready, false);
});

test('inspector reads only hash-matching raw report and does not repair report fields with policy values', async t => {
  const f = configFixture(t); fs.writeFileSync(f.env.AI_MARK_FONT, 'fixture');
  const filename = path.join(f.directory, 'report.json'); const report = { passed: false, provider: 'different', model: 'different', probeVersion: 'old' };
  const bytes = Buffer.from(JSON.stringify(report)); fs.writeFileSync(filename, bytes);
  f.env.PHOTO_CANDIDATE_ACCEPTANCE_FILE = filename; f.env.PHOTO_CANDIDATE_ACCEPTANCE_SHA256 = sha(bytes);
  const inspect = createPhotoCandidateInspector(photoCandidateConfig(f.env), { execute: (_python, _args, _options, done) => done(null) });
  const result = await inspect(); assert.deepEqual(result.providerEvidence.report, report); assert.equal(result.providerEvidence.model, 'different');
  assert.equal(result.providerEvidence.labelVersion, undefined);
  fs.appendFileSync(filename, ' '); assert.equal((await inspect()).providerEvidence, undefined);
});

test('real SDK port construction accepts existing mainland endpoint with no call and requires explicit credentials', async t => {
  const f = configFixture(t), c = photoCandidateConfig(f.env);
  assert.throws(() => createPhotoCandidatePorts(c, f.env), /CREDENTIALS_REQUIRED/);
  const ports = createPhotoCandidatePorts(c, { ...f.env, ALIYUN_ACCESS_KEY_ID: 'syntheticKey', ALIYUN_ACCESS_KEY_SECRET: 'syntheticSecret',
    DASHSCOPE_API_KEY: 'synthetic-api-key', DASHSCOPE_BASE: 'https://fixture.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation' });
  await ports.drain(); assert.equal(typeof ports.provider.generate, 'function');
  for (const base of ['', ' https://dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com\n', 'https://fixture.ap-southeast-1.maas.aliyuncs.com']) {
    assert.throws(() => createPhotoCandidatePorts(c, { ...f.env, ALIYUN_ACCESS_KEY_ID: 'syntheticKey', ALIYUN_ACCESS_KEY_SECRET: 'syntheticSecret',
      DASHSCOPE_API_KEY: 'synthetic-api-key', DASHSCOPE_BASE: base }), /ENDPOINT_REJECTED/);
  }
});

test('real local Python/Pillow/font inspection can start with no image acceptance and performs no generation', async t => {
  const f = configFixture(t);
  const executable = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true });
  assert.equal(executable.status, 0, 'local image acceptance requires Python');
  f.env.PYTHON_PATH = executable.stdout.trim();
  f.env.AI_MARK_FONT = process.platform === 'win32' ? 'C:\\Windows\\Fonts\\msyh.ttc' : '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc';
  const inspector = createPhotoCandidateInspector(photoCandidateConfig(f.env)); const result = await inspector();
  assert.equal(result.marker.ready, true); assert.equal(result.marker.chineseFont, true); assert.equal(result.providerEvidence, undefined);
});

test('real HTTP listener defaults closed with unavailable image evidence, same ledger, no DDL or provider work', async t => {
  const f = await runtimeFixture(t); const running = await startPhotoCandidateServer(f.options); t.after(() => running.shutdown());
  const base = `http://127.0.0.1:${running.address().port}`;
  const health = await fetch(`${base}/health`); const status = await health.json();
  assert.equal(health.status, 200); assert.equal(status.salesEnabled, false); assert.equal(status.photo.available, false);
  assert.equal(status.photo.prepared, true); assert.equal(running.host.database, f.database);
  const catalog = await (await fetch(`${base}/api/catalog`)).json(); assert.equal(catalog.data.settings.generationEnabled, false);
  const profile = await (await fetch(`${base}/api/public/compliance`)).json();
  assert.equal(profile.data.status, 'pending_company_approval'); assert.equal(profile.data.consentVersions.basic, f.document.policy.basicVersion);
  assert.equal(profile.data.supportContact, 'REDACTED_COMPANY_CONTACT_EMAIL');
  assert.equal((await (await fetch(`${base}/api/capabilities`)).json()).data[0].ready, false);
  const upload = await fetch(`${base}/api/mini/photo-uploads`, { method: 'POST', body: '{}' }); assert.equal(upload.status, 503);
  const purchase = await fetch(`${base}/api/mini/payments/orders`, { method: 'POST', body: '{}' }); assert.notEqual(purchase.status, 200);
  const admin = await fetch(`${base}/api/admin/mini/payments`); assert.notEqual(admin.status, 200);
  assert.ok(f.sql.length > 25); assert.ok(f.sql.every(statement => /^SELECT\s/i.test(statement)));
  assert.equal(f.calls.provider + f.calls.moderation + f.calls.storage, 0); assert.equal(f.signals.listenerCount('SIGTERM'), 1);
  assert.deepEqual(await running.shutdown(), { stopped: true, databaseClosed: true });
  assert.equal(f.calls.close, 1); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
});

test('missing photo DDL preserves closed payment listener without auto-migrating', async t => {
  const f = await runtimeFixture(t, { photos: false }); const running = await startPhotoCandidateServer(f.options); t.after(() => running.shutdown());
  const status = await (await fetch(`http://127.0.0.1:${running.address().port}/health`)).json();
  assert.equal(status.ok, true); assert.equal(status.payment.prepared, true); assert.equal(status.photo.prepared, false);
  assert.ok(f.sql.every(statement => /^SELECT\s/i.test(statement))); assert.equal(f.calls.provider + f.calls.storage + f.calls.moderation, 0);
  await running.shutdown();
});

test('one actual context stores baseline input review requirements while output policy remains aigc', async t => {
  const f = await runtimeFixture(t), running = await startPhotoCandidateServer(f.options); t.after(() => running.shutdown());
  const auth = await running.host.identity.createLogin({ openid: 'fixture_openid', sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const userId = auth.user.id, context = running.host.photo.context;
  await context.grantBasicConsent(userId, f.document.policy.basicVersion);
  await context.grantFaceConsent(userId, { version: f.document.policy.faceVersion, subjectAuthorization: 'self' });
  await running.host.photo.uploads.submitIntent({ userId, idempotencyKey: '1'.repeat(32), sha256: 'f'.repeat(64), byteLength: 100, contentType: 'image/png' });
  const rows = await f.database.transaction(q => q('SELECT moderation_service,moderation_version FROM mini_photo_uploads'));
  assert.deepEqual(rows, [{ moderation_service: 'baselineCheck', moderation_version: f.document.policy.moderationVersion }]);
  assert.equal(photoCandidateConfig(f.env).policy.moderationService, 'aigcCheck');
  assert.equal(running.host.photo.context.database, running.host.database);
  assert.equal(f.calls.provider + f.calls.moderation + f.calls.storage, 0);
  await running.shutdown();
});

test('runtime scope rejects even an injected wrong database backend, closes it and never listens', async t => {
  const f = await runtimeFixture(t, { dbBackend: 'sqlite' }); let listening = false;
  await assert.rejects(startPhotoCandidateServer({ ...f.options, listen: () => { listening = true; } }), /RUNTIME_SCOPE_REQUIRED/);
  assert.equal(listening, false); assert.equal(f.calls.close, 1);
});

test('SIGTERM stops admission and waits for underlying late media work before closing the canonical database', async t => {
  const gate = deferred(), f = await runtimeFixture(t, { rawDrain: gate });
  const running = await startPhotoCandidateServer(f.options); t.after(() => { gate.resolve(); return running.shutdown(); });
  f.signals.emit('SIGTERM'); let finished = false; const stopping = running.shutdown().then(value => { finished = true; return value; });
  await tick(); assert.equal(finished, false); assert.equal(f.isClosed(), false); assert.equal((await running.host.health()).accepting, false);
  gate.resolve(); assert.equal((await stopping).databaseClosed, true); assert.equal(f.calls.close, 1);
});
