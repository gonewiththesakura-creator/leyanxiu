// Explicit localhost acceptance runner, deliberately not *.test.mjs.
// No .env, cloud database, real image provider, Green or OSS access.
// Usage: node tests/photo-generation-mysql-isolated.mjs <verified portable package directory>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mysql2/promise';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { draftProducts } from '../payments/virtual/products.js';
import { createPhotoJobContext } from '../photo-jobs/context.js';
import { createPhotoJobWorker } from '../photo-jobs/worker.js';
import { createPhotoGenerationRepository, photoGenerationSchema } from '../photo-jobs/generation-repository.js';
import { createPhotoGenerationPipeline } from '../photo-jobs/generation-pipeline.js';
import { createPhotoGenerationCleanupRepository, createPhotoGenerationCleanupWorker } from '../photo-jobs/generation-cleanup.js';
import { createPhotoOutputOssStorage } from '../photo-jobs/output-storage.js';
import { QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER } from '../photo-jobs/qwen-provider.js';

const version = '8.0.46';
const officialMd5 = '003f527d5df61b663ff191038cd676bd';
const expectedPackage = 'REDACTED_LOCAL_USER_PATH/AppData/Local/Temp/lyx-photo-mysql-20261009-6f5d34b2';
if (!process.argv[2]) {
  console.log('NO_OP: supply the existing verified portable MySQL package directory for an isolated localhost test.');
  process.exit(0);
}
const packageRoot = fs.realpathSync(process.argv[2]);
assert.equal(packageRoot.toLowerCase(), fs.realpathSync(expectedPackage).toLowerCase(), 'Only the reviewed portable package is permitted');
const archive = path.join(packageRoot, `mysql-${version}-winx64.zip`);
assert.equal(createHash('md5').update(fs.readFileSync(archive)).digest('hex'), officialMd5);
const basedir = path.join(packageRoot, `mysql-${version}-winx64`);
const executable = path.join(basedir, 'bin', 'mysqld.exe');
const taskDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lyx-photo-generation-mysql-'));
const datadir = path.join(taskDirectory, 'data');
assert.equal(fs.existsSync(datadir), false);
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const databaseName = `generation_test_${randomBytes(6).toString('hex')}`;
const appUser = 'generation_fixture';
const rootPassword = randomBytes(24).toString('hex'), password = randomBytes(24).toString('hex');
const connections = new Set();
const report = { version, officialMd5, taskDirectory, datadir, host: '127.0.0.1', port, databaseName,
  source: `https://cdn.mysql.com/Downloads/MySQL-8.0/mysql-${version}-winx64.zip`,
  providerCallsAreFake: true, networkCallsToProvidersOrOss: 0, checks: [], deadlocks: 0 };
const policy = { basicVersion: 'fixture_basic', faceVersion: 'fixture_face', labelVersion: 'fixture_label',
  provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, operation: 'edit',
  moderationVersion: 'fixture_review', moderationService: 'aigcCheck', sourceHosts: ['result.example.test'],
  sourceRetentionMs: 86400000, resultRetentionMs: 86400000 };
const effect = { id: 'repair', version: 'fixture_v1', provider: policy.provider, model: policy.model,
  purpose: 'photo-effect:repair', parameters: { prompt: 'synthetic local fixture', n: 1 }, enabled: true, reviewReference: 'fixture_review' };
const appId = 'wx-local-generation-fixture';
const raw = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XAZkAAAAASUVORK5CYII=', 'base64');
// Bytes only test fixtures: neither a marking-conformance nor cloud moderation claim.
const marked = Buffer.concat([raw, Buffer.from('synthetic-marked-generation')]);
const sha = value => createHash('sha256').update(value).digest('hex');
const media = bytes => ({ bytes: Buffer.from(bytes), sha256: sha(bytes), byteLength: bytes.length, contentType: 'image/png' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const cleanupTiming = { retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000, claimHoldMs: 1200 };
let stamp = Date.now(), server, admin, initialized = false, counter = 0;
const now = () => stamp;

async function check(name, operation) {
  await operation(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`);
}
async function waitExit(child, timeoutMs) {
  let timer;
  try { return await Promise.race([once(child, 'exit'), new Promise((_, reject) => {
    timer = setTimeout(() => { child.kill(); reject(new Error('LOCAL_MYSQL_PROCESS_TIMEOUT')); }, timeoutMs);
  })]); } finally { clearTimeout(timer); }
}
async function portClosed() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
  });
}
async function start() {
  admin = null;
  server = spawn(executable, ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--bind-address=127.0.0.1',
    `--port=${port}`, '--mysqlx=OFF', '--skip-log-bin', '--performance-schema=OFF', '--innodb-buffer-pool-size=64M',
    '--innodb-default-row-format=DYNAMIC', '--innodb-page-size=16384', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_bin',
    `--log-error=${path.join(taskDirectory, 'mysqld.log')}`], { windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('LOCAL_MYSQL_START_EXIT');
    try { admin = await createConnection({ host: '127.0.0.1', port, user: 'root', password: initialized ? rootPassword : '', connectTimeout: 1000 }); break; }
    catch (error) { if (!['ECONNREFUSED', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT'].includes(error.code)) throw error; await delay(200); }
  }
  assert.ok(admin, 'LOCAL_MYSQL_NOT_READY');
  const [identity] = await admin.query('SELECT @@version AS version,@@datadir AS datadir,@@bind_address AS host,@@port AS port,@@innodb_page_size AS page_size');
  assert.equal(identity[0].version, version); assert.equal(identity[0].host, '127.0.0.1'); assert.equal(identity[0].port, port);
  assert.equal(path.resolve(identity[0].datadir).toLowerCase(), datadir.toLowerCase()); assert.equal(identity[0].page_size, 16384);
  if (!initialized) { await admin.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${admin.escape(rootPassword)}`); initialized = true; }
}
async function stop() {
  for (const db of connections) await db.close(); connections.clear();
  if (server && server.exitCode === null) {
    const exiting = waitExit(server, 15000);
    try { await admin?.query('SHUTDOWN'); } catch (error) { if (error.code !== 'PROTOCOL_CONNECTION_LOST') throw error; }
    await admin?.end().catch(() => {}); admin = null;
    const [code] = await exiting; assert.equal(code, 0);
  }
  assert.equal(await portClosed(), true, 'LOCAL_MYSQL_PORT_NOT_CLOSED');
}
async function open(afterQuery) {
  const underlying = await openVirtualDatabase({ backend: 'mysql', mysqlOptions: { host: '127.0.0.1', port,
    user: appUser, password, database: databaseName, connectTimeout: 3000 } });
  const database = { ...underlying, transaction: callback => underlying.transaction(q => callback(async (sql, args) => {
    let value;
    try { value = await q(sql, args); } catch (error) { if (error.errno === 1213) report.deadlocks++; throw error; }
    await afterQuery?.(sql, value); return value;
  })) };
  connections.add(database);
  const ledger = createVirtualLedger({ database, encryptionKey: '7'.repeat(64), now });
  const context = createPhotoJobContext({ ledger, policy, now });
  const repository = createPhotoGenerationRepository({ context, policy, now });
  const cleanup = createPhotoGenerationCleanupRepository({ context, now });
  return { database, ledger, context, repository, cleanup, rows: (sql, args = []) => database.transaction(q => q(sql, args)) };
}
async function fixture({ claim = true } = {}) {
  const f = await open(); const userId = `fixture_${++counter}`;
  await f.ledger.bindSession({ userId, sessionId: `${userId}_session`, appId, openid: `${userId}_openid`, sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const order = await f.ledger.createOrder({ userId, product: draftProducts[0], idempotencyKey: `${userId}_order`, appId, env: 1, platform: 'android' });
  const paid = await f.ledger.settle(order.id, { order_id: order.id, env_type: 2, order_fee: order.amountFen, paid_fee: order.amountFen,
    status: 2, order_type: 0, wx_order_id: `wx_${order.id}`, paid_time: Math.floor(now() / 1000), refund_fee: 0, left_fee: order.amountFen });
  await f.context.grantBasicConsent(userId, policy.basicVersion);
  await f.context.grantFaceConsent(userId, { version: policy.faceVersion, subjectAuthorization: 'self' });
  await f.context.registerInput(userId, { id: `${userId}_source`, storageKey: `private/fixture/${userId}.png`, ...media(raw),
    expiresAt: now() + 86400000, moderation: { decision: 'allow', reference: 'fixture_input_review' } });
  const submission = await f.context.submission({ userId, idempotencyKey: `${userId}_request`, inputAssetId: `${userId}_source`, effectId: effect.id });
  const { job } = await f.context.repository.submit(submission);
  const claimed = claim ? await f.context.repository.claimNext() : null;
  if (claimed) assert.equal(claimed.id, job.id);
  const counts = { generate: 0, put: 0, review: 0, delete: 0 };
  const objects = new Map();
  const absent = () => Object.assign(new Error('SYNTHETIC_ABSENT'), { code: 'NoSuchKey', status: 404 });
  const client = {
    async put(key, bytes, options) {
      counts.put++; assert.equal(options.headers['x-oss-object-acl'], 'private'); assert.equal(options.headers['x-oss-forbid-overwrite'], 'true');
      assert.equal(objects.has(key), false); objects.set(key, { bytes: Buffer.from(bytes), headers: {
        'content-type': options.headers['Content-Type'], 'content-length': String(bytes.length),
        'x-oss-meta-sha256': options.headers['x-oss-meta-sha256'], etag: 'fixture-etag' } });
      return { res: { status: 200, headers: {} } };
    },
    async head(key) { const value = objects.get(key); if (!value) throw absent(); return { res: { status: 200, headers: value.headers } }; },
    async get(key, options) { const value = objects.get(key); if (!value) throw absent(); assert.equal(options.headers['If-Match'], value.headers.etag);
      return { content: value.bytes, res: { status: 200, headers: value.headers } }; },
    async delete(key) { counts.delete++; objects.delete(key); return { res: { status: 204, headers: {} } }; },
  };
  const output = createPhotoOutputOssStorage({ bucket: 'synthetic-fixture', region: 'cn-shanghai', client, now });
  const ports = {
    readInput: async () => media(raw),
    async generate({ input }) { assert.deepEqual(input, media(raw)); counts.generate++;
      return { provider: policy.provider, model: policy.model, requestId: `fixture_provider_${counter}`, url: 'https://result.example.test/synthetic.png' }; },
    readGenerated: async () => media(raw),
    mark: async args => ({ ...media(marked), contentId: args.contentId, operation: args.operation, labelVersion: args.labelVersion, verified: true }),
    output: { put: ({ key, bytes, contentType }) => output.put(key, bytes, { contentType }),
      read: ({ key, expected }) => output.read(key, { expected }) },
    moderator: { async moderate({ bytes, direction, journal }) {
      const reference = randomBytes(16).toString('hex'); await journal({ reference, extension: 'png' }); counts.review++;
      return { provider: 'aliyun-green', policyVersion: policy.moderationVersion, service: policy.moderationService, direction,
        sha256: sha(bytes), byteLength: bytes.length, decision: 'allow', reference: `mod_${'1'.repeat(64)}`, requestId: 'fixture_green',
        cleanupReference: reference, cleanupExtension: 'png', cleanupPending: false };
    } },
  };
  const pipeline = (peer = f) => createPhotoGenerationPipeline({ repository: peer.repository, context: peer.context, ports });
  const forceRefund = () => f.ledger.applyRefund({ MchOrderId: paid.id, OpenId: paid.openid, WxOrderId: paid.providerId,
    WxRefundId: `wx_refund_${paid.id}`, MchRefundId: `external_${paid.id}`, RefundFee: paid.amountFen, RetCode: 0 });
  return { ...f, userId, job, claimed, counts, objects, output, ports, pipeline, forceRefund,
    input: { jobId: job.id, userId, spec: claimed?.spec },
    credit: () => f.rows('SELECT remaining,reserved FROM vp_buckets WHERE order_id = ?', [paid.id]) };
}
async function focusCleanup(f, kind = 'output') {
  await f.cleanup.prepareCleanup(cleanupTiming);
  await f.rows('UPDATE mini_photo_generation_cleanup SET next_at = ? WHERE job_id <> ? OR kind <> ?', [now() + 86400000, f.job.id, kind]);
}
function barrier(expected) {
  let arrived = 0, resolve, reject; const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timer = setTimeout(() => reject(new Error('FIXTURE_BARRIER_TIMEOUT')), 10000); timer.unref();
  return async () => { if (++arrived === expected) { clearTimeout(timer); resolve(); } await ready; };
}

try {
  const initializer = spawn(executable, ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--initialize-insecure',
    `--log-error=${path.join(taskDirectory, 'initialize.log')}`], { windowsHide: true, stdio: 'ignore' });
  assert.equal((await waitExit(initializer, 120000))[0], 0);
  await start();
  await admin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  await admin.query(`USE ${databaseName}`);
  for (const location of ['../deploy/mini-payment/sandbox-schema-v1.sql', '../photo-jobs/context-schema.sql',
    '../deploy/mini-payment/photo-jobs-schema-v1.sql', '../photo-jobs/generation-schema.sql']) {
    const statements = fs.readFileSync(new URL(location, import.meta.url), 'utf8').replace(/^--.*$/gm, '').split(';').map(x => x.trim());
    for (const sql of statements.filter(x => /^(CREATE TABLE|CREATE INDEX|INSERT IGNORE INTO vp_schema)/i.test(x))) await admin.query(sql);
  }
  await admin.query(`CREATE USER '${appUser}'@'localhost' IDENTIFIED BY ${admin.escape(password)}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${databaseName}.* TO '${appUser}'@'localhost'`);
  const initial = await open(); await initial.ledger.bindEnvironment(appId, 1); await initial.context.putEffect(effect);

  await check('MySQL_three_new_tables_enforce_binary_InnoDB_keys_checks_lengths_and_CRUD_role', async () => {
    const [tables] = await admin.query("SELECT TABLE_NAME,ENGINE,TABLE_COLLATION,ROW_FORMAT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'mini_photo_generation%'", [databaseName]);
    assert.equal(tables.length, 3); assert.ok(tables.every(x => x.ENGINE === 'InnoDB' && x.TABLE_COLLATION === 'utf8mb4_bin' && x.ROW_FORMAT === 'Dynamic'));
    const [checks] = await admin.query("SELECT ENFORCED FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME LIKE 'mini_photo_generation%' AND CONSTRAINT_TYPE='CHECK'", [databaseName]);
    assert.equal(checks.length, 11); assert.ok(checks.every(x => x.ENFORCED === 'YES'));
    const [lengths] = await admin.query("SELECT TABLE_NAME,COLUMN_NAME,CHARACTER_MAXIMUM_LENGTH AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'mini_photo_generation%' AND COLUMN_NAME IN ('job_id','output_key','storage_key','moderation_reference')", [databaseName]);
    assert.ok(lengths.filter(x => x.COLUMN_NAME === 'job_id').every(x => x.n === 80));
    assert.ok(lengths.filter(x => ['output_key', 'storage_key'].includes(x.COLUMN_NAME)).every(x => x.n === 512));
    assert.equal(lengths.find(x => x.COLUMN_NAME === 'moderation_reference').n, 32);
    await assert.rejects(initial.rows("INSERT INTO mini_photo_generation_operations(job_id,step,state,token,attempts,started_at,updated_at) VALUES ('missing','generate','started',?,1,0,0)", ['a'.repeat(32)]), x => [1216, 1452].includes(x.errno));
    const constrained = await fixture(); await constrained.repository.open(constrained.input);
    await assert.rejects(initial.rows("INSERT INTO mini_photo_generation_operations(job_id,step,state,token,attempts,started_at,updated_at) VALUES (?,'generate','started',?,0,0,0)", [constrained.job.id, 'a'.repeat(32)]), x => x.errno === 3819);
    await assert.rejects(initial.rows('CREATE TABLE forbidden_fixture(id INTEGER)'), x => x.errno === 1142);
    const sql = fs.readFileSync(new URL('../photo-jobs/generation-schema.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').trim().replace(/;$/, '');
    const normalize = x => x.replace(/\s+/g, ' ').replace(/\s*\)/g, ')').trim();
    assert.equal(normalize(sql), normalize(photoGenerationSchema('mysql').join('; ')));
    report.schema = { generationTables: tables.length, enforcedChecks: checks.length, runtimeCrudOnly: true };
  });

  await check('four_independent_worker_pools_dispatch_generate_PUT_Green_and_consume_once', async () => {
    const f = await fixture({ claim: false }); const peers = await Promise.all(Array.from({ length: 4 }, () => open()));
    const ids = await Promise.all(peers.map(x => x.rows('SELECT CONNECTION_ID() AS id'))); assert.equal(new Set(ids.map(x => x[0].id)).size, 4);
    const workers = peers.map(peer => createPhotoJobWorker({ repository: peer.context.repository, runProvider: f.pipeline(peer).runProvider }));
    await Promise.all(workers.map(worker => worker.runOnce()));
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 1);
    assert.equal((await f.context.repository.readOwned(f.userId, f.job.id)).state, 'succeeded');
    assert.equal((await f.context.listWorks(f.userId)).length, 1); assert.deepEqual(await f.credit(), [{ remaining: 9, reserved: 0 }]);
    const operations = await f.repository.operations(f.job.id, f.userId);
    assert.ok(operations.filter(x => ['generate', 'output_put', 'moderate'].includes(x.step)).every(x => x.attempts === 1 && x.state === 'succeeded'));
  });

  await check('ambiguous_generation_is_durable_unknown_without_second_provider_or_returned_right', async () => {
    const f = await fixture({ claim: false }); f.ports.generate = async () => { f.counts.generate++; throw new Error('SYNTHETIC_PROVIDER_TIMEOUT'); };
    const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: f.pipeline().runProvider });
    assert.equal((await worker.runOnce()).state, 'unknown'); const saved = (await f.rows('SELECT * FROM mini_photo_jobs WHERE id=?', [f.job.id]))[0];
    const peer = await open(); await assert.rejects(f.pipeline(peer).runProvider({ jobId: f.job.id, userId: f.userId, spec: JSON.parse(saved.spec) }));
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 0); assert.deepEqual(await f.credit(), [{ remaining: 9, reserved: 1 }]);
  });

  await check('mysqld_restart_recovers_lost_PUT_original_claim_by_GET_without_second_paid_calls', async () => {
    const f = await fixture({ claim: false }); const originalPut = f.ports.output.put;
    f.ports.output.put = async args => { await originalPut(args); throw new Error('SYNTHETIC_LOST_PUT_REPLY'); };
    const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: f.pipeline().runProvider });
    assert.equal((await worker.runOnce()).state, 'unknown'); const saved = (await f.rows('SELECT * FROM mini_photo_jobs WHERE id=?', [f.job.id]))[0];
    await stop(); await start(); const peer = await open();
    await f.pipeline(peer).runProvider({ jobId: f.job.id, userId: f.userId, spec: JSON.parse(saved.spec) });
    assert.equal((await peer.repository.recordRecoveredResult(f.job.id, f.userId)).state, 'result_ready');
    assert.equal((await peer.context.repository.publishNext()).state, 'succeeded');
    const recovered = (await peer.rows('SELECT claim_token,attempt,state FROM mini_photo_jobs WHERE id=?', [f.job.id]))[0];
    assert.equal(recovered.claim_token, saved.claim_token); assert.equal(recovered.attempt, 1); assert.equal(recovered.state, 'succeeded');
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 1);
    assert.equal((await peer.context.listWorks(f.userId)).length, 1);
    report.mysqldRestartRecovery = true;
  });

  await check('real_channel_refund_after_output_review_prevents_registration_and_restored_rights', async () => {
    const f = await fixture(); const moderate = f.ports.moderator.moderate;
    f.ports.moderator.moderate = async args => { const value = await moderate(args); await f.forceRefund(); return value; };
    await assert.rejects(f.pipeline().runProvider(f.input));
    assert.equal((await f.rows("SELECT COUNT(*) AS n FROM mini_photo_assets WHERE user_id=? AND kind='output'", [f.userId]))[0].n, 0);
    assert.equal((await f.context.listWorks(f.userId)).length, 0); assert.equal((await f.credit())[0].remaining, 0);
    await focusCleanup(f); assert.ok((await f.cleanup.cleanupJournal(f.job.id)).some(x => x.kind === 'output'));
  });

  await check('four_barrier_synchronized_cleanup_claims_commit_one_token_and_keep_absence_recheck', async () => {
    const f = await fixture(); await f.pipeline().runProvider(f.input); await f.context.withdrawFaceConsent(f.userId); await focusCleanup(f);
    const rendezvous = barrier(4); const peers = await Promise.all(Array.from({ length: 4 }, async () => {
      let waited = false; return open(async sql => { if (!waited && sql.includes('FROM mini_photo_generation_cleanup c')) { waited = true; await rendezvous(); } });
    }));
    const claims = await Promise.allSettled(peers.map(x => x.cleanup.claimCleanup(cleanupTiming)));
    const winners = claims.filter(x => x.status === 'fulfilled' && x.value); assert.equal(winners.length, 1);
    assert.ok(claims.filter(x => x.status === 'rejected').every(x => x.reason.errno === 1213));
    const first = winners[0].value; assert.equal(first.jobId, f.job.id); assert.equal(first.kind, 'output');
    await f.cleanup.recordCleanupObservation(first, { acknowledged: true, observation: 'absent' }, cleanupTiming);
    let row = (await f.cleanup.cleanupJournal(f.job.id)).find(x => x.kind === 'output'); assert.equal(row.state, 'absent_observed');
    assert.equal(row.next_at, now() + cleanupTiming.recheckAfterMs); assert.equal(await f.cleanup.claimCleanup(cleanupTiming), null);
    stamp += cleanupTiming.recheckAfterMs + 1; const second = await f.cleanup.claimCleanup(cleanupTiming);
    assert.notEqual(first.operationToken, second.operationToken);
    assert.equal(await f.cleanup.recordCleanupObservation(first, { acknowledged: true, observation: 'absent' }, cleanupTiming), false);
    assert.equal(await f.cleanup.recordCleanupObservation(second, { acknowledged: false, observation: 'unknown' }, cleanupTiming), true);
    row = (await f.cleanup.cleanupJournal(f.job.id)).find(x => x.kind === 'output'); assert.equal(row.state, 'unknown'); assert.equal(row.attempts, 2);
  });

  await check('withdrawal_and_late_original_PUT_keep_cleanup_live_then_remove_reappearing_object', async () => {
    const f = await fixture(); const entered = deferred(), release = deferred(); const originalPut = f.ports.output.put;
    f.ports.output.put = async args => { entered.resolve(); await release.promise; return originalPut(args); };
    const pending = f.pipeline().runProvider(f.input); pending.catch(() => {}); await entered.promise;
    await f.context.withdrawFaceConsent(f.userId); await focusCleanup(f);
    const scratch = { delete: async () => ({ acknowledged: true }), inspect: async () => ({ found: false }) };
    const worker = createPhotoGenerationCleanupWorker({ repository: f.cleanup, outputStorage: f.output, moderationStorage: scratch,
      policy: { ...cleanupTiming, timeoutMs: 100 } });
    const first = await worker.runOnce(); assert.equal(first.observation, 'absent'); assert.equal(first.permanentErasureConfirmed, false);
    release.resolve(); await assert.rejects(pending); assert.equal(f.objects.size, 1);
    stamp += cleanupTiming.recheckAfterMs + 1; const second = await worker.runOnce();
    assert.equal(second.observation, 'absent'); assert.equal(second.permanentErasureConfirmed, false); assert.equal(f.objects.size, 0);
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 0);
    const row = (await f.cleanup.cleanupJournal(f.job.id)).find(x => x.kind === 'output'); assert.equal(row.attempts, 2); assert.ok(row.next_at > now());
    assert.equal((await f.context.listWorks(f.userId)).length, 0); await worker.drain();
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = { code: error.code || error.name, errno: error.errno };
  // Assertion detail here is only synthetic local state; SDK/SQL messages are not printed.
  if (error.code === 'ERR_ASSERTION') report.assertion = { message: error.message, actual: error.actual, expected: error.expected };
  console.error(`FAIL ${error.code || error.name}`); process.exitCode = 1;
} finally {
  try { await stop(); }
  catch (error) { report.shutdownError = error.code || error.name; process.exitCode = 1;
    if (server && server.exitCode === null) { server.kill(); await waitExit(server, 10000).catch(() => {}); }
  }
  report.serverStopped = !server || server.exitCode !== null;
  report.portClosed = await portClosed();
  if (!report.serverStopped || !report.portClosed) { report.passed = false; process.exitCode = 1; }
  const reportPath = path.join(taskDirectory, 'generation-mysql-acceptance.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, deadlocks: report.deadlocks,
    serverStopped: report.serverStopped, portClosed: report.portClosed, report: reportPath }));
}
