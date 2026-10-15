import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { materializePhotoProductionFiles, startPhotoProductionBootstrap } from '../photo-jobs/production-bootstrap.js';
import { photoProductionConfig } from '../photo-jobs/production-server.js';
import { builtinProductionMysql, privateProductionTransport } from '../payments/virtual/mysql-transport.js';
import { acceptedVirtualPaymentEvidence } from '../payments/virtual/runtime.js';
import { QWEN_PHOTO_PROVIDER, QWEN_PHOTO_MODEL, QWEN_PHOTO_RESULT_POLICY, QWEN_PHOTO_RESULT_HOSTS } from '../photo-jobs/qwen-provider.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-bootstrap-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function inline(name, bytes) {
  return { [`PHOTO_PRODUCTION_${name}_BASE64`]: bytes.toString('base64'), [`PHOTO_PRODUCTION_${name}_SHA256`]: hash(bytes) };
}
function paymentInline(bytes) {
  return { XPAY_ACCEPTANCE_BASE64: bytes.toString('base64'), XPAY_ACCEPTANCE_SHA256: hash(bytes) };
}
const policyBytes = Buffer.from('{\r\n "synthetic": "合成策略", "approved": false\r\n}\r\n');
const reportBytes = Buffer.from(' {"executed":false, "passed":false, "fixture":"原始报告"}\n');
const paymentReportBytes = Buffer.from('{\r\n "env":0, "checks":{}, "executed":false, "fixture":"未验收支付"\r\n}\r\n');

test('inline documents preserve every byte and digest in separate ordinary private files, then clean only their directory', t => {
  const root = fixture(t), env = { ...inline('CONFIG', policyBytes), ...inline('ACCEPTANCE', reportBytes) };
  const original = structuredClone(env), prepared = materializePhotoProductionFiles({ env, temporaryRoot: root });
  assert.deepEqual(env, original); assert.equal(fs.readdirSync(root).length, 1);
  for (const [name, bytes] of [['CONFIG', policyBytes], ['ACCEPTANCE', reportBytes]]) {
    const filename = prepared.paths[`PHOTO_PRODUCTION_${name}_FILE`], stat = fs.lstatSync(filename);
    assert.ok(path.isAbsolute(filename)); assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false);
    assert.deepEqual(fs.readFileSync(filename), bytes); assert.equal(hash(fs.readFileSync(filename)), env[`PHOTO_PRODUCTION_${name}_SHA256`]);
    if (process.platform !== 'win32') { assert.equal(stat.mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(filename)).mode & 0o777, 0o700); }
  }
  prepared.cleanup(); prepared.cleanup(); assert.deepEqual(fs.readdirSync(root), []);
});

test('invalid base64, UTF8, JSON, size, digest and conflicting sources reject before any file or server is created', async t => {
  const root = fixture(t), base = inline('CONFIG', policyBytes);
  const invalidBytes = [Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0x80, 0x22, 0x7d]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{}')]), Buffer.from('null'), Buffer.from('[]'), Buffer.from('{'),
    Buffer.from(JSON.stringify({ value: 'x'.repeat(65536) }))];
  const cases = [
    { ...base, PHOTO_PRODUCTION_CONFIG_FILE: '' }, { ...base, PHOTO_PRODUCTION_CONFIG_FILE: path.join(root, 'do-not-touch') },
    { ...base, PHOTO_PRODUCTION_CONFIG_JSON: '{}' }, { ...base, PHOTO_PRODUCTION_CONFIG_BASE64: '' },
    { ...base, PHOTO_PRODUCTION_CONFIG_BASE64: base.PHOTO_PRODUCTION_CONFIG_BASE64 + '\n' },
    { ...base, PHOTO_PRODUCTION_CONFIG_BASE64: 'e31=' }, // non-canonical unused padding bits
    { ...base, PHOTO_PRODUCTION_CONFIG_BASE64: 'e30' }, { ...base, PHOTO_PRODUCTION_CONFIG_SHA256: '0'.repeat(64) },
    { ...base, PHOTO_PRODUCTION_CONFIG_SHA256: base.PHOTO_PRODUCTION_CONFIG_SHA256.toUpperCase() },
    ...invalidBytes.map(bytes => inline('CONFIG', bytes)),
    { ...base, ...inline('ACCEPTANCE', Buffer.from('not JSON')) },
    { ...base, ...inline('ACCEPTANCE', reportBytes), PHOTO_PRODUCTION_ACCEPTANCE_FILE: path.join(root, 'existing') },
  ];
  for (const env of cases) {
    let calls = 0;
    await assert.rejects(startPhotoProductionBootstrap({ env, temporaryRoot: root, signals: new EventEmitter(), startServer: async () => { calls++; } }), /PHOTO_PRODUCTION_BOOTSTRAP_/);
    assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(root), []);
  }
});

test('payment evidence has its own raw bytes, path and digest; photo evidence cannot substitute for payment acceptance', t => {
  const root = fixture(t), photoOnly = { ...inline('CONFIG', policyBytes), ...inline('ACCEPTANCE', reportBytes) };
  const withoutPayment = materializePhotoProductionFiles({ env: photoOnly, temporaryRoot: root });
  assert.equal(Object.hasOwn(withoutPayment.paths, 'XPAY_ACCEPTANCE_FILE'), false);
  assert.equal(acceptedVirtualPaymentEvidence({ ...photoOnly, ...withoutPayment.paths, XPAY_ENV: '0' }), false);
  withoutPayment.cleanup();
  const env = { ...photoOnly, ...paymentInline(paymentReportBytes), XPAY_ENV: '0', XPAY_MODE: 'closed' };
  const original = structuredClone(env), prepared = materializePhotoProductionFiles({ env, temporaryRoot: root });
  const payment = prepared.paths.XPAY_ACCEPTANCE_FILE, photo = prepared.paths.PHOTO_PRODUCTION_ACCEPTANCE_FILE;
  assert.notEqual(payment, photo); assert.equal(path.basename(payment), 'xpay-acceptance.json');
  assert.deepEqual(fs.readFileSync(payment), paymentReportBytes); assert.deepEqual(fs.readFileSync(photo), reportBytes);
  assert.equal(hash(fs.readFileSync(payment)), env.XPAY_ACCEPTANCE_SHA256);
  assert.equal(hash(fs.readFileSync(photo)), env.PHOTO_PRODUCTION_ACCEPTANCE_SHA256);
  const stat = fs.lstatSync(payment); assert.equal(stat.isFile(), true); assert.equal(stat.isSymbolicLink(), false); assert.equal(stat.nlink, 1);
  if (process.platform !== 'win32') { assert.equal(stat.mode & 0o777, 0o600); assert.equal(fs.statSync(path.dirname(payment)).mode & 0o777, 0o700); }
  // Framing and SHA validation do not turn incomplete/failed reports into acceptance.
  assert.equal(acceptedVirtualPaymentEvidence({ ...env, ...prepared.paths }), false);
  assert.deepEqual(env, original);
  prepared.cleanup(); assert.deepEqual(fs.readdirSync(root), []);
});

test('payment inline documents enforce the same source, SHA, base64, UTF8/JSON and 64KiB boundaries before startup', async t => {
  const root = fixture(t), valid = paymentInline(paymentReportBytes);
  const invalid = [
    { ...valid, XPAY_ACCEPTANCE_FILE: '' }, { ...valid, XPAY_ACCEPTANCE_FILE: path.join(root, 'caller.json') },
    { ...valid, XPAY_ACCEPTANCE_JSON: '{}' }, { ...valid, XPAY_ACCEPTANCE_SHA256: hash(reportBytes) },
    { ...valid, XPAY_ACCEPTANCE_SHA256: valid.XPAY_ACCEPTANCE_SHA256.toUpperCase() },
    { ...valid, XPAY_ACCEPTANCE_SHA256: undefined }, { ...valid, XPAY_ACCEPTANCE_BASE64: '' },
    { ...valid, XPAY_ACCEPTANCE_BASE64: valid.XPAY_ACCEPTANCE_BASE64 + '\n' },
    { ...valid, XPAY_ACCEPTANCE_BASE64: 'e31=' }, { ...valid, XPAY_ACCEPTANCE_BASE64: 'e30' },
    ...[Buffer.from('null'), Buffer.from('[]'), Buffer.from('{'), Buffer.from([0x7b,0xff,0x7d]),
      Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from('{}')]), Buffer.from(JSON.stringify({ fixture: 'x'.repeat(65536) }))].map(paymentInline),
  ];
  for (const payment of invalid) {
    let calls = 0;
    await assert.rejects(startPhotoProductionBootstrap({ env: { ...inline('CONFIG', policyBytes), ...inline('ACCEPTANCE', reportBytes), ...payment },
      temporaryRoot: root, signals: new EventEmitter(), startServer: async () => { calls++; } }), /PHOTO_PRODUCTION_BOOTSTRAP_/);
    assert.equal(calls, 0); assert.deepEqual(fs.readdirSync(root), []);
  }
  const prefix = '{"fixture":"', suffix = '"}';
  const exactLimit = Buffer.from(prefix + 'x'.repeat(65536 - prefix.length - suffix.length) + suffix);
  assert.equal(exactLimit.length, 65536);
  const prepared = materializePhotoProductionFiles({ env: paymentInline(exactLimit), temporaryRoot: root });
  assert.deepEqual(fs.readFileSync(prepared.paths.XPAY_ACCEPTANCE_FILE), exactLimit);
  prepared.cleanup(); assert.deepEqual(fs.readdirSync(root), []);
});

test('caller-owned mounted files remain unchanged and are never added to cleanup', async t => {
  const root = fixture(t), file = path.join(root, 'owned-by-caller.json'); fs.writeFileSync(file, policyBytes);
  const paymentFile = path.join(root, 'caller-payment.json'); fs.writeFileSync(paymentFile, paymentReportBytes);
  const env = { PHOTO_PRODUCTION_CONFIG_FILE: file, PHOTO_PRODUCTION_CONFIG_SHA256: hash(policyBytes),
    XPAY_ACCEPTANCE_FILE: paymentFile, XPAY_ACCEPTANCE_SHA256: hash(paymentReportBytes) }, signals = new EventEmitter();
  const running = await startPhotoProductionBootstrap({ env, temporaryRoot: root, signals,
    startServer: async ({ env: actual }) => { assert.equal(actual, env); assert.equal(actual.PHOTO_PRODUCTION_CONFIG_FILE, file);
      assert.equal(actual.XPAY_ACCEPTANCE_FILE, paymentFile); return { shutdown: async () => ({ stopped: true }) }; } });
  await running.shutdown(); assert.deepEqual(fs.readFileSync(file), policyBytes); assert.equal(env.PHOTO_PRODUCTION_CONFIG_FILE, file);
  assert.deepEqual(fs.readFileSync(paymentFile), paymentReportBytes); assert.equal(env.XPAY_ACCEPTANCE_FILE, paymentFile);
  assert.deepEqual(fs.readdirSync(root).sort(), ['caller-payment.json', 'owned-by-caller.json']);
});

test('linked temporary roots are refused without traversing into the target', t => {
  const root = fixture(t), target = path.join(root, 'target'), link = path.join(root, 'link'); fs.mkdirSync(target); fs.symlinkSync(target, link, 'junction');
  assert.throws(() => materializePhotoProductionFiles({ env: inline('CONFIG', policyBytes), temporaryRoot: link }), /TEMP_ROOT_INVALID/);
  assert.deepEqual(fs.readdirSync(target), []);
});

test('cleanup cannot delete an unrelated entry or follow a replacement directory', t => {
  const root = fixture(t), prepared = materializePhotoProductionFiles({ env: inline('CONFIG', policyBytes), temporaryRoot: root });
  const directory = path.dirname(prepared.paths.PHOTO_PRODUCTION_CONFIG_FILE), unexpected = path.join(directory, 'unrelated.txt');
  fs.writeFileSync(unexpected, 'preserve');
  assert.throws(prepared.cleanup, /CLEANUP_UNCONFIRMED/); assert.equal(fs.readFileSync(unexpected, 'utf8'), 'preserve');
  fs.unlinkSync(unexpected); prepared.cleanup();
  const second = materializePhotoProductionFiles({ env: inline('CONFIG', policyBytes), temporaryRoot: root });
  const original = path.dirname(second.paths.PHOTO_PRODUCTION_CONFIG_FILE), moved = original + '-moved', other = path.join(root, 'other');
  fs.renameSync(original, moved); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'config.json'), 'keep-target'); fs.symlinkSync(other, original, 'junction');
  assert.throws(second.cleanup, /CLEANUP_UNCONFIRMED/); assert.equal(fs.readFileSync(path.join(other, 'config.json'), 'utf8'), 'keep-target');
  assert.deepEqual(fs.readFileSync(path.join(moved, 'config.json')), policyBytes);
});

test('shutdown is idempotent and preserves documents until the real drain settles, without changing sales or workers', async t => {
  const root = fixture(t), env = { ...inline('CONFIG', policyBytes), ...inline('ACCEPTANCE', reportBytes), ...paymentInline(paymentReportBytes), XPAY_ENV: '0', XPAY_MODE: 'closed',
    PHOTO_PRODUCTION_GENERATION_ENABLED: 'false', PHOTO_PRODUCTION_PROCESS_ENABLED: 'false', PHOTO_PRODUCTION_CLEANUP_ENABLED: 'false', XPAY_RECONCILE_ENABLED: 'false' };
  const original = structuredClone(env), signals = new EventEmitter(), draining = deferred(); let shutdowns = 0;
  const running = await startPhotoProductionBootstrap({ env, temporaryRoot: root, signals, startServer: async ({ env: actual, signals: actualSignals }) => {
    assert.equal(actual, env); assert.equal(actualSignals, signals);
    for (const [key, value] of Object.entries(original)) assert.equal(actual[key], value);
    return { state: { env: 0, mode: 'closed' }, shutdown: async () => { shutdowns++; await draining.promise; return { stopped: true }; } };
  } });
  const config = env.PHOTO_PRODUCTION_CONFIG_FILE, payment = env.XPAY_ACCEPTANCE_FILE;
  const stop = running.shutdown(); assert.equal(running.shutdown(), stop); await tick();
  assert.equal(shutdowns, 1); assert.equal(fs.existsSync(config), true); assert.deepEqual(fs.readFileSync(payment), paymentReportBytes);
  draining.resolve(); assert.deepEqual(await stop, { stopped: true });
  assert.equal(fs.existsSync(config), false); assert.equal(fs.existsSync(payment), false); assert.deepEqual(env, original); assert.equal(signals.listenerCount('SIGTERM'), 0); assert.equal(signals.listenerCount('exit'), 0);
});

test('SIGTERM arriving during asynchronous startup waits for startup and drain before cleanup', async t => {
  const root = fixture(t), env = { ...inline('CONFIG', policyBytes), ...paymentInline(paymentReportBytes) }, signals = new EventEmitter(), started = deferred(), drained = deferred(); let calls = 0;
  const promise = startPhotoProductionBootstrap({ env, temporaryRoot: root, signals, startServer: () => started.promise });
  const filename = env.PHOTO_PRODUCTION_CONFIG_FILE, payment = env.XPAY_ACCEPTANCE_FILE; signals.emit('SIGTERM'); await tick(); assert.equal(fs.existsSync(filename), true);
  assert.deepEqual(fs.readFileSync(payment), paymentReportBytes);
  started.resolve({ shutdown: async () => { calls++; await drained.promise; return { stopped: true }; } });
  const running = await promise; await tick(); assert.equal(calls, 1); assert.equal(fs.existsSync(filename), true); assert.equal(fs.existsSync(payment), true);
  drained.resolve(); await running.shutdown(); assert.equal(fs.existsSync(filename), false); assert.equal(fs.existsSync(payment), false); assert.deepEqual(fs.readdirSync(root), []);
});

test('failed startup cleans generated files, restores only its paths and hides arbitrary error text', async t => {
  const root = fixture(t), env = { ...inline('CONFIG', policyBytes), ...paymentInline(paymentReportBytes) }, original = structuredClone(env), signals = new EventEmitter();
  await assert.rejects(startPhotoProductionBootstrap({ env, temporaryRoot: root, signals, startServer: async ({ env }) => {
    assert.deepEqual(fs.readFileSync(env.PHOTO_PRODUCTION_CONFIG_FILE), policyBytes);
    assert.deepEqual(fs.readFileSync(env.XPAY_ACCEPTANCE_FILE), paymentReportBytes);
    throw Error('PRIVATE_SYNTHETIC_CANARY password=not-real');
  } }), error => { assert.equal(error.message, 'PHOTO_PRODUCTION_BOOTSTRAP_START_UNCONFIRMED'); return true; });
  assert.deepEqual(env, original); assert.deepEqual(fs.readdirSync(root), []); assert.equal(signals.listenerCount('SIGTERM'), 0);
});

function productionFixture(root) {
  const appId = builtinProductionMysql.appId;
  const policy = { version: 1, policy: { approved: true, reviewReference: 'synthetic_config_review', acceptanceVersion: 'synthetic_probe',
    serviceProviderCode: appId, provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, resultUrlPolicy: QWEN_PHOTO_RESULT_POLICY,
    sourceHosts: [...QWEN_PHOTO_RESULT_HOSTS], operation: 'edit', basicVersion: 'synthetic_basic', faceVersion: 'synthetic_face', labelVersion: 'synthetic_probe',
    moderationVersion: 'synthetic_probe', moderationService: 'aigcCheck', sourceRetentionMs: 86400000, resultRetentionMs: 86400000, maxDailyUploads: 20, maxDailyUploadsPerUser: 5 },
    approvedEffects: [], moderationPolicy: { approved: true, version: 'synthetic_probe', region: 'cn-shanghai', services: { input: 'baselineCheck', output: 'aigcCheck' },
      lowRisk: 'review', timeoutMs: 12000, maxBytes: 20971520 }, cleanupPolicy: { timeoutMs: 12000, retryAfterMs: 60000, recheckAfterMs: 300000, inFlightGraceMs: 600000 } };
  const env = { ...inline('CONFIG', Buffer.from(JSON.stringify(policy))), RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENABLED: 'true', XPAY_ENV: '0',
    XPAY_MODE: 'closed', XPAY_DB_BACKEND: 'mysql', WECHAT_APP_ID: appId, WECHAT_APP_SECRET: 'synthetic-only', XPAY_APP_KEY: 'synthetic-formal-only',
    XPAY_SESSION_ENCRYPTION_KEY: '8'.repeat(64), XPAY_MYSQL_TRANSPORT: privateProductionTransport, XPAY_MYSQL_HOST: builtinProductionMysql.host,
    XPAY_MYSQL_PORT: '3306', XPAY_MYSQL_DATABASE: builtinProductionMysql.database, XPAY_MYSQL_USER: 'lyx_xpay_fixture', XPAY_MYSQL_PASSWORD: 'synthetic-only',
    XPAY_MYSQL_ACCOUNT_HOST: '%', XPAY_CLOUD_ENV_ID: builtinProductionMysql.cloudEnvId, XPAY_MYSQL_INSTANCE_ID: builtinProductionMysql.instanceId,
    OSS_BUCKET: 'synthetic-private', OSS_REGION: 'cn-shanghai', PYTHON_PATH: process.execPath, AI_MARK_FONT: path.join(root, 'synthetic-font') };
  return { policy, env };
}

test('materialized documents use the existing real production policy validator; absent or failed evidence cannot be minted into readiness', async t => {
  const root = fixture(t), { env } = productionFixture(root), signals = new EventEmitter();
  const running = await startPhotoProductionBootstrap({ env, temporaryRoot: root, signals, startServer: async ({ env: actual }) => {
    const config = photoProductionConfig(actual); assert.equal(config.env, 0); assert.equal(config.mode, 'closed'); assert.equal(config.acceptanceFile, null);
    assert.deepEqual(config.approvedEffects, []);
    for (const name of ['generationEnabled', 'processEnabled', 'cleanupEnabled', 'reconcileEnabled']) assert.equal(config[name], false);
    return { shutdown: async () => ({ stopped: true }) };
  } });
  await running.shutdown();
  let runtimeCalls = 0;
  await assert.rejects(startPhotoProductionBootstrap({ env: { ...env, ...inline('CONFIG', Buffer.from('{}')) }, temporaryRoot: root, signals,
    serverOptions: { runtimeFactory: async () => { runtimeCalls++; } } }), /PHOTO_CANDIDATE_POLICY_REQUIRED/);
  assert.equal(runtimeCalls, 0); assert.deepEqual(fs.readdirSync(root), []);
});

test('imports are inert; CLI rejects arguments without echoing inline documents', () => {
  const script = fileURLToPath(new URL('../photo-jobs/production-bootstrap.js', import.meta.url));
  const env = { ...process.env, ...inline('CONFIG', Buffer.from('{"fixture":"PRIVATE_SYNTHETIC_CANARY"}')) };
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../photo-jobs/production-bootstrap.js', import.meta.url).href)})`], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
  const result = spawnSync(process.execPath, [script, '--execute'], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1); assert.match(result.stderr, /PHOTO_PRODUCTION_BOOTSTRAP_NO_ARGUMENTS_ALLOWED/);
  assert.equal(result.stdout, ''); assert.equal(result.stderr.includes('PRIVATE_SYNTHETIC_CANARY'), false);
});
