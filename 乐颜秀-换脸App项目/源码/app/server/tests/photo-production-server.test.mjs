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
import { builtinProductionMysql, builtinSandboxMysql, privateProductionTransport } from '../payments/virtual/mysql-transport.js';
import { draftProducts } from '../payments/virtual/products.js';
import { photoContextSchema } from '../photo-jobs/context.js';
import { photoJobsSchema } from '../photo-jobs/repository.js';
import { photoUploadSchema, photoUploadCleanupSchema } from '../photo-jobs/upload-repository.js';
import { photoGenerationSchema } from '../photo-jobs/generation-repository.js';
import { QWEN_PHOTO_PROVIDER, QWEN_PHOTO_MODEL, QWEN_PHOTO_RESULT_POLICY, QWEN_PHOTO_RESULT_HOSTS } from '../photo-jobs/qwen-provider.js';
import { photoProductionConfig, startPhotoProductionServer } from '../photo-jobs/production-server.js';
import { fixtureEffects, fixtureBundle } from './photo-acceptance-fixture.mjs';

const appId = builtinProductionMysql.appId;
const operatorUser = 'usr_00000000-0000-0000-0000-000000000009';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
function configFixture(t, { effects = false, cleanup = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-production-entry-'));
  if (cleanup) t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const document = { version: 1, policy: { approved: true, reviewReference: 'fictional_review', acceptanceVersion: 'fictional_probe',
    serviceProviderCode: appId, provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, resultUrlPolicy: QWEN_PHOTO_RESULT_POLICY,
    sourceHosts: [...QWEN_PHOTO_RESULT_HOSTS], operation: 'edit', basicVersion: 'fictional_basic', faceVersion: 'fictional_face',
    labelVersion: 'fictional_probe', moderationVersion: 'fictional_probe', moderationService: 'aigcCheck',
    sourceRetentionMs: 86400000, resultRetentionMs: 86400000, maxDailyUploads: 20, maxDailyUploadsPerUser: 10 },
    approvedEffects: [], moderationPolicy: { approved: true, version: 'fictional_probe', region: 'cn-shanghai',
      services: { input: 'baselineCheck', output: 'aigcCheck' }, lowRisk: 'review', timeoutMs: 10000, maxBytes: 20 * 1024 * 1024 },
    cleanupPolicy: { timeoutMs: 1000, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000 } };
  if (effects) {
    document.approvedEffects.push(fixtureEffects()[0]);
    document.policy.acceptanceVersion = document.policy.labelVersion = document.policy.moderationVersion = 'original-effects-v1-20261015';
    document.moderationPolicy.version = document.policy.moderationVersion;
  }
  const file = path.join(directory, 'synthetic-policy.json'); const bytes = Buffer.from(JSON.stringify(document)); fs.writeFileSync(file, bytes);
  const env = { RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENABLED: 'true', XPAY_ENV: '0',
    XPAY_MODE: 'closed', DEPLOY_ENV: 'production', XPAY_DB_BACKEND: 'mysql', WECHAT_APP_ID: appId, WECHAT_APP_SECRET: 'fixture-secret',
    XPAY_APP_KEY: 'fixture-production-key', XPAY_OFFER_ID: 'fixture-offer', XPAY_SESSION_ENCRYPTION_KEY: '8'.repeat(64),
    XPAY_MYSQL_TRANSPORT: privateProductionTransport, XPAY_MYSQL_HOST: builtinProductionMysql.host,
    XPAY_MYSQL_PORT: String(builtinProductionMysql.port), XPAY_MYSQL_DATABASE: builtinProductionMysql.database,
    XPAY_MYSQL_USER: 'lyx_xpay_fixture', XPAY_MYSQL_PASSWORD: 'fixture-database-password', XPAY_MYSQL_ACCOUNT_HOST: '%',
    XPAY_CLOUD_ENV_ID: builtinProductionMysql.cloudEnvId, XPAY_MYSQL_INSTANCE_ID: builtinProductionMysql.instanceId,
    PHOTO_PRODUCTION_CONFIG_FILE: file, PHOTO_PRODUCTION_CONFIG_SHA256: sha(bytes),
    OSS_BUCKET: 'fictional-private-bucket', OSS_REGION: 'oss-cn-shanghai', PYTHON_PATH: process.execPath,
    AI_MARK_FONT: path.join(directory, 'fictional-font'), BIND_HOST: '127.0.0.1' };
  return { directory, document, file, env };
}
async function freePort() {
  const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function runtimeFixture(t, { effects = false, photos = true, rawDrain } = {}) {
  const f = configFixture(t, { effects, cleanup: false });
  const source = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(f.directory, 'isolated.sqlite'), migrate: true });
  let closed = false; const running = [];
  t.after(async () => { rawDrain?.resolve(); for (const entry of running) await entry.shutdown(); if (!closed) { await source.close(); closed = true; }
    fs.rmSync(f.directory, { force: true, recursive: true }); });
  await source.transaction(async q => {
    for (const sql of miniIdentitySchema('sqlite')) await q(sql);
    await q('INSERT INTO vp_environment(id,app_id,env) VALUES (1,?,0)', [appId]);
    if (photos) for (const sql of [...photoContextSchema('sqlite'), photoJobsSchema('sqlite'), photoUploadSchema('sqlite'),
      photoUploadCleanupSchema('sqlite'), ...photoGenerationSchema('sqlite')]) await q(sql);
  });
  const sql = [], calls = { provider: 0, moderation: 0, storage: 0, runtime: 0, ports: 0, inspect: 0, close: 0, readiness: 0 };
  const state = { acceptance: false, payment: false, identity: false, admin: false, connectionDatabase: builtinProductionMysql.database };
  // Explicit test adapter over real isolated SQLite. CURRENT_USER/DATABASE are
  // synthetic fixture observations, not cloud/MySQL acceptance evidence.
  const database = { backend: 'mysql', transaction: callback => source.transaction(q => callback((statement, values) => {
    sql.push(statement);
    if (statement.includes('CURRENT_USER()')) return [{ db: state.connectionDatabase, account: 'lyx_xpay_fixture@%' }];
    return q(statement.replace(/ FOR UPDATE(?: SKIP LOCKED)?/g, '').replace(/JSON_UNQUOTE\((JSON_EXTRACT\([^)]*\))\)/g, '$1'), values);
  })), async close() { calls.close++; if (!closed) { await source.close(); closed = true; } } };
  const ledger = createVirtualLedger({ database, encryptionKey: f.env.XPAY_SESSION_ENCRYPTION_KEY });
  const runtime = { ledger, adapter: { appId, env: 0 }, codec: {} };
  const forbidden = name => async () => { calls[name]++; throw Error('forbidden offline upstream call'); };
  const storage = { put: forbidden('storage'), read: forbidden('storage'), delete: forbidden('storage'), inspect: forbidden('storage'), signedUrl: forbidden('storage') };
  const ports = { inputStorage: storage, outputStorage: storage, sourceCleanup: storage, moderationCleanup: storage,
    moderator: { moderate: forbidden('moderation') }, provider: { generate: forbidden('provider'), readGenerated: forbidden('provider') }, marker: { mark: forbidden('provider') },
    inspectPrerequisites: async () => {
      calls.inspect++; const p = f.document.policy;
      const acceptanceBundle = effects ? fixtureBundle(f.document.approvedEffects) : undefined;
      if (acceptanceBundle) acceptanceBundle.pipelineReport.passed = state.acceptance;
      return { marker: { ready: true, python: true, pillow: true, chineseFont: true, labelVersion: p.labelVersion, operation: p.operation, serviceProviderCode: appId },
        providerEvidence: { provider: p.provider, model: p.model, version: p.acceptanceVersion, resultUrlPolicy: p.resultUrlPolicy,
          labelVersion: p.labelVersion, moderationVersion: p.moderationVersion, moderationService: p.moderationService,
          report: { provider: p.provider, model: p.model, probeVersion: p.acceptanceVersion, resultUrlPolicy: p.resultUrlPolicy,
            labelVersion: p.labelVersion, moderationVersion: p.moderationVersion, moderationServices: { input: 'baselineCheck', output: 'aigcCheck' },
            executed: true, syntheticOnly: true, passed: state.acceptance, inputAllowed: true, outputAllowed: true, marked: true,
            outputReadMatches: true, outputAbsentObserved: true, scratchAbsentObserved: 2, cleanupPending: false,
            attemptedGenerationCalls: 1, attemptedGreenCalls: 2 },
          ...(acceptanceBundle ? { acceptanceBundle, report: acceptanceBundle.pipelineReport } : {}) } };
    }, async drain() { if (rawDrain) await rawDrain.promise; } };
  const pendingTimers = new Map(); let timerId = 0;
  const timers = { setTimeout(callback, delay) { const token = { id: ++timerId, unref() {} }; pendingTimers.set(token, { callback, delay }); return token; },
    clearTimeout(token) { pendingTimers.delete(token); } };
  const readinessCalls = [], signals = new EventEmitter(), logs = [];
  f.env.PORT = String(await freePort());
  const options = { env: f.env, timers, signals, logger: value => logs.push(value),
    runtimeFactory: async options => { calls.runtime++; assert.equal(options.allowCloudrunPrivateProduction, true);
      assert.equal(options.allowCloudrunPrivateSandbox, undefined); assert.equal(options.productionTarget.database, builtinProductionMysql.database); return runtime; },
    portsFactory: async () => { calls.ports++; return ports; },
    operationalReadiness: async ({ database: actual, identity }) => { assert.equal(actual, database); assert.ok(identity); return { identityReady: state.identity, adminReady: state.admin }; },
    readinessFactory: async value => { calls.readiness++; readinessCalls.push(value);
      assert.equal(value.purchaseProfile, 'android-only-v1');
      return { ready: state.payment && value.identityReady && value.adminReady, operationsReady: true,
        mode: f.env.XPAY_MODE, purchaseProfile: value.purchaseProfile }; } };
  const start = async overrides => { const entry = await startPhotoProductionServer({ ...options, ...overrides }); running.push(entry); return entry; };
  return { ...f, start, options, runtime, database, state, calls, sql, pendingTimers, readinessCalls, signals, logs,
    async fireTimer() { const next = pendingTimers.entries().next().value; assert.ok(next); pendingTimers.delete(next[0]); next[1].callback();
      for (let i = 0; i < 50 && !pendingTimers.size; i++) await tick(); }, isClosed: () => closed };
}
function openPhotoFixture(f, mode = 'live') {
  Object.assign(f.env, { XPAY_MODE: mode, XPAY_RECONCILE_ENABLED: 'true', PHOTO_PRODUCTION_GENERATION_ENABLED: 'true',
    PHOTO_PRODUCTION_PROCESS_ENABLED: 'true', PHOTO_PRODUCTION_CLEANUP_ENABLED: 'true',
    XPAY_PRODUCTS_JSON: JSON.stringify([draftProducts[0]]), PRIVACY_POLICY_URL: 'https://example.com/privacy',
    USER_AGREEMENT_URL: 'https://example.com/terms', THIRD_PARTY_LIST_URL: 'https://example.com/processors',
    RETENTION_SUPPLIER_POLICY: '仅本地测试保存说明', PIPIA_REFERENCE: 'fictional-internal-assessment',
    AI_SERVICE_DISCLOSURES_JSON: JSON.stringify([{ provider: f.document.policy.provider, model: f.document.policy.model,
      filingReference: '仅本地测试公开编号', purpose: '仅本地测试处理', region: '中国上海', capabilities: ['photo-effect'] }]) });
  Object.assign(f.state, { acceptance: true, payment: true, identity: true, admin: true });
}
async function configureOperator(f) {
  f.env.XPAY_REFUND_OPERATOR_USER_IDS = operatorUser;
  await f.database.transaction(q => q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [operatorUser, appId, 'fixture-operator']));
}

test('production import has no configuration read, listener, migration or provider work', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', "await import('./photo-jobs/production-server.js'); console.log('import-only');"],
    { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PHOTO_PRODUCTION_CONFIG_FILE: 'must-not-read', XPAY_ENV: '1' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'import-only'); assert.equal(result.stderr, '');
});

test('production configuration remains env0 and defaults work closed; wrong scope and sandbox key fail before runtime', async t => {
  const f = configFixture(t), config = photoProductionConfig(f.env);
  assert.equal(config.env, 0); assert.equal(config.mode, 'closed'); assert.equal(config.purchaseProfile, 'android-only-v1');
  assert.deepEqual(config.refundOperatorUserIds, []);
  for (const key of ['generationEnabled', 'processEnabled', 'cleanupEnabled', 'reconcileEnabled']) assert.equal(config[key], false);
  assert.equal(config.policy.serviceProviderCode, appId); assert.equal(config.runtimeOptions.allowCloudrunPrivateSandbox, undefined);
  for (const change of [{ XPAY_ENV: '1' }, { XPAY_MODE: 'sandbox' }, { XPAY_DB_BACKEND: 'sqlite' },
    { XPAY_MYSQL_DATABASE: builtinSandboxMysql.database }, { XPAY_MYSQL_ACCOUNT_HOST: '' },
    { XPAY_MYSQL_TRANSPORT: 'cloudrun_builtin_private' }, { XPAY_APP_KEY: '' },
    { XPAY_SANDBOX_APP_KEY: f.env.XPAY_APP_KEY }, { XPAY_MODE: 'merchant_test' },
    { XPAY_MODE: 'live' }, { XPAY_REFUND_OPERATOR_USER_IDS: 'not-a-user' }, { XPAY_REFUND_OPERATOR_USER_IDS: operatorUser + ',' },
    { XPAY_REFUND_OPERATOR_USER_IDS: [operatorUser] }, { DEBUG: '*' }, { NODE_DEBUG: 'http' }, { NODE_DEBUG_NATIVE: 'TLS' },
    { PHOTO_PRODUCTION_GENERATION_ENABLED: 'yes' }, { PHOTO_PRODUCTION_PROCESS_ENABLED: 'true' }]) {
    let calls = 0;
    await assert.rejects(startPhotoProductionServer({ env: { ...f.env, ...change }, runtimeFactory: async () => { calls++; }, portsFactory: async () => { calls++; } }), /PHOTO_|XPAY_/);
    assert.equal(calls, 0);
  }
  const configured = photoProductionConfig({ ...f.env, XPAY_MODE: 'live', XPAY_RECONCILE_ENABLED: 'true' });
  assert.equal(configured.mode, 'live'); assert.equal(configured.env, 0); assert.equal(configured.generationEnabled, false);
});

test('real production HTTP listener shares the env0 database, remains closed without evidence and creates no schema', async t => {
  const f = await runtimeFixture(t), running = await f.start();
  const base = `http://127.0.0.1:${running.address().port}`;
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.env, 0); assert.equal(health.mode, 'closed'); assert.equal(health.ok, true);
  assert.equal(health.salesEnabled, false); assert.equal(health.generationAvailable, false);
  assert.equal(running.host.database, f.database); assert.equal(running.host.photo.context.database, f.database);
  assert.equal((await (await fetch(`${base}/api/public/compliance`)).json()).data.supportContact, 'REDACTED_COMPANY_CONTACT_EMAIL');
  assert.equal((await (await fetch(`${base}/api/capabilities`)).json()).data[0].ready, false);
  assert.equal((await fetch(`${base}/api/mini/payments/orders`, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(`${base}/api/mini/payments/sandbox/refunds/fixture/confirm`, { method: 'POST', body: '{}' })).status, 404);
  assert.ok(f.sql.every(sql => /^SELECT /i.test(sql))); assert.equal(f.pendingTimers.size, 0);
  assert.equal(f.calls.provider + f.calls.moderation + f.calls.storage, 0);
  assert.deepEqual(await running.shutdown(), { stopped: true, databaseClosed: true }); assert.equal(f.calls.close, 1);
});

test('a wrong production connection closes before ports or listener; missing photo schema does not prevent closed recovery', async t => {
  const wrong = await runtimeFixture(t); wrong.state.connectionDatabase = builtinSandboxMysql.database;
  await assert.rejects(wrong.start(), /PRIVATE_PRODUCTION_CONNECTION_MISMATCH/);
  assert.equal(wrong.calls.close, 1); assert.equal(wrong.calls.ports, 0);
  const missing = await runtimeFixture(t, { photos: false }), running = await missing.start();
  const health = await running.host.health(); assert.equal(health.ok, true); assert.equal(health.photo.prepared, false);
  assert.equal(health.salesEnabled, false); assert.ok(missing.sql.every(sql => /^SELECT /i.test(sql)));
});

test('sales follow current production payment, disclosure and actual photo lifecycle gates on the same ledger', async t => {
  const f = await runtimeFixture(t, { effects: true }); openPhotoFixture(f);
  await configureOperator(f); const running = await f.start();
  assert.equal((await running.host.health()).salesEnabled, true);
  assert.equal(f.readinessCalls.at(-1).runtimeOptions.allowCloudrunPrivateProduction, true);
  assert.equal(f.readinessCalls.at(-1).runtimeOptions.productionTarget.database, builtinProductionMysql.database);
  f.state.acceptance = false; assert.equal((await running.host.health()).salesEnabled, false);
  assert.equal((await running.host.catalog()).settings.generationEnabled, false);
  f.state.acceptance = true; f.state.payment = false; assert.equal((await running.host.health()).salesEnabled, false);
  assert.equal((await running.host.health()).generationAvailable, true);
  f.state.payment = true; f.state.admin = false; assert.equal((await running.host.health()).salesEnabled, false);
  f.state.admin = true; f.state.identity = false; assert.equal((await running.host.health()).salesEnabled, false);
  f.state.identity = true; assert.equal((await running.host.health()).salesEnabled, true);
  assert.equal(f.calls.provider + f.calls.storage + f.calls.moderation, 0);
});

test('missing refund operator never opens sales; an always-denied legacy admin cannot make it ready', async t => {
  const f = await runtimeFixture(t, { effects: true }); openPhotoFixture(f);
  const running = await f.start({ requireAdmin: c => ({ response: c.json({ code: 'FIXTURE_DENIED' }, 403) }) });
  const health = await running.host.health(); assert.equal(health.salesEnabled, false); assert.equal(health.generationAvailable, true);
  assert.equal(f.readinessCalls.at(-1).adminReady, false);
  assert.equal(f.calls.provider + f.calls.storage + f.calls.moderation, 0);
});

test('standalone operational readiness derives from the same durable identity and explicit live operator account', async t => {
  const f = await runtimeFixture(t, { effects: true }); openPhotoFixture(f); await configureOperator(f);
  const running = await f.start({ operationalReadiness: undefined });
  assert.equal((await running.host.health()).salesEnabled, true);
  assert.equal(f.readinessCalls.at(-1).identityReady, true); assert.equal(f.readinessCalls.at(-1).adminReady, true);
  const operator = await running.host.identity.createLogin({ openid: 'fixture-operator', sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const outsider = await running.host.identity.createLogin({ openid: 'fixture-outsider', sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const base = `http://127.0.0.1:${running.address().port}/api/mini/operations/refunds`;
  const allowed = await fetch(base, { headers: { Authorization: `Bearer ${operator.token}` } });
  assert.equal(allowed.status, 200); assert.deepEqual((await allowed.json()).data, []);
  const denied = await fetch(base, { headers: { Authorization: `Bearer ${outsider.token}` } });
  assert.equal(denied.status, 403); assert.equal((await denied.json()).code, 'XPAY_REFUND_OPERATOR_FORBIDDEN');
  await f.database.transaction(q => q('UPDATE vp_accounts SET app_id=? WHERE user_id=?', ['wx0000000000000000', operatorUser]));
  assert.equal((await running.host.health()).salesEnabled, false); assert.equal(f.readinessCalls.at(-1).adminReady, false);
  assert.equal(f.calls.provider + f.calls.storage + f.calls.moderation, 0);
});

test('merchant-test photo admission uses the same durable identity and exact configured user allowlist', async t => {
  const f = await runtimeFixture(t, { effects: true }); openPhotoFixture(f, 'merchant_test');
  const allowedUser = 'usr_00000000-0000-0000-0000-000000000001'; f.env.XPAY_TEST_USER_IDS = allowedUser;
  await f.database.transaction(q => q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [allowedUser, appId, 'fixture-allowed']));
  const running = await f.start({ requireAdmin: c => ({ response: c.json({ code: 'FIXTURE_DENIED' }, 403) }) });
  assert.equal((await running.host.refundOperator.readiness()).ready, false);
  const login = openid => running.host.identity.createLogin({ openid, sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const allowed = await login('fixture-allowed'), denied = await login('fixture-denied');
  assert.equal(allowed.user.id, allowedUser); assert.notEqual(denied.user.id, allowedUser);
  const catalog = async token => (await (await running.host.app.request('/api/catalog', { headers: { Authorization: `Bearer ${token}` } })).json()).data;
  assert.equal((await catalog(allowed.token)).miniProgramCreation.available, true);
  assert.equal((await catalog(denied.token)).miniProgramCreation.available, false);
  const before = await f.database.transaction(q => q('SELECT * FROM mini_photo_accounts'));
  const response = await running.host.app.request('/api/consents', { method: 'POST', headers: { Authorization: `Bearer ${denied.token}` },
    body: JSON.stringify({ consentType: 'basic', action: 'granted', version: f.document.policy.basicVersion }) });
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'PHOTO_PRODUCTION_GENERATION_CLOSED');
  assert.deepEqual(await f.database.transaction(q => q('SELECT * FROM mini_photo_accounts')), before);
  assert.equal(f.calls.provider + f.calls.storage + f.calls.moderation, 0);
});

test('scheduled work is opt-in, serialized and stopped before late raw media drain and database close', async t => {
  const rawDrain = deferred(), f = await runtimeFixture(t, { rawDrain });
  Object.assign(f.env, { PHOTO_PRODUCTION_CLEANUP_ENABLED: 'true', XPAY_RECONCILE_ENABLED: 'true' });
  const running = await f.start(); assert.equal(f.pendingTimers.size, 1);
  await running.host.runOnce({ cleanup: true });
  const before = f.sql.length; await f.fireTimer(); assert.equal(f.pendingTimers.size, 1); assert.ok(f.sql.length > before);
  assert.equal(f.calls.provider + f.calls.storage + f.calls.moderation, 0);
  f.signals.emit('SIGTERM'); await tick(); assert.equal(f.pendingTimers.size, 0); assert.equal(f.calls.close, 0);
  assert.equal((await running.host.app.request('/api/catalog')).status, 503);
  rawDrain.resolve(); await running.shutdown(); assert.equal(f.calls.close, 1); assert.equal(f.signals.listenerCount('SIGTERM'), 0);
  assert.deepEqual(f.logs.map(x => x.event), ['photo_production.started']);
});
