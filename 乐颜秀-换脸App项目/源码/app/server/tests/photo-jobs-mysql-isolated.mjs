// Explicit local acceptance runner, deliberately not *.test.mjs. Never loads .env/runtime.
// Usage: node tests/photo-jobs-mysql-isolated.mjs <fresh task directory containing the verified ZIP and extraction>
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
import { createPhotoJobRepository } from '../photo-jobs/repository.js';
import { createPhotoJobWorker } from '../photo-jobs/worker.js';

const version = '8.0.46';
const officialMd5 = '003f527d5df61b663ff191038cd676bd';
const root = fs.realpathSync(process.argv[2] || '');
const tempRoot = fs.realpathSync(os.tmpdir());
assert.equal(path.dirname(root).toLowerCase(), tempRoot.toLowerCase(), 'Only a direct OS temporary task directory is allowed');
assert.match(path.basename(root), /^lyx-photo-mysql-[A-Za-z0-9-]+$/);
const basedir = path.join(root, `mysql-${version}-winx64`);
const archive = path.join(root, `mysql-${version}-winx64.zip`);
const md5 = createHash('md5').update(fs.readFileSync(archive)).digest('hex');
assert.equal(md5, officialMd5, 'Official CDN archive checksum mismatch');
const datadir = path.join(root, `data-${randomBytes(6).toString('hex')}`);
assert.equal(fs.existsSync(datadir), false);
const executable = path.join(basedir, 'bin', 'mysqld.exe');
const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const rootPassword = randomBytes(24).toString('hex');
const applicationPassword = randomBytes(24).toString('hex');
const databaseName = `lyx_photo_test_${randomBytes(6).toString('hex')}`;
const appUser = 'lyx_photo_fixture';
const connections = new Set();
const checks = [];
const policy = { basicVersion: 'basic_fixture_1', faceVersion: 'face_fixture_1', labelVersion: 'mark_fixture_1' };
const effect = { id: 'first_photo', version: 'review_fixture_1', provider: 'fixture_provider', model: 'fixture-model.1',
  purpose: 'photo-effect:first_photo', parameters: { prompt: 'synthetic local fixture' }, enabled: true, reviewReference: 'review_fixture_1' };
const appId = 'wx-local-mysql-fixture';
const now = Date.now();
let server, admin, initialized = false, counter = 0;
const report = { version, source: `https://cdn.mysql.com/Downloads/MySQL-8.0/mysql-${version}-winx64.zip`, officialMd5,
  datadir, host: '127.0.0.1', port, databaseName, providerCallsAreFake: true, checks };

const childRun = async args => {
  const child = spawn(executable, args, { windowsHide: true, stdio: 'ignore' });
  const [code] = await once(child, 'exit'); assert.equal(code, 0, `mysqld child failed; inspect ${root}`);
};
async function start() {
  server = spawn(executable, ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--bind-address=127.0.0.1',
    `--port=${port}`, '--mysqlx=OFF', '--skip-log-bin', '--performance-schema=OFF', '--innodb-buffer-pool-size=64M',
    '--innodb-default-row-format=DYNAMIC', '--innodb-page-size=16384', '--character-set-server=utf8mb4', '--collation-server=utf8mb4_bin',
    `--log-error=${path.join(root, 'isolated-mysqld.log')}`, '--log-error-verbosity=2'], { windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`MYSQL_START_EXIT_${server.exitCode}`);
    try { admin = await createConnection({ host: '127.0.0.1', port, user: 'root', password: initialized ? rootPassword : '', connectTimeout: 1000 }); break; }
    catch (error) { if (!['ECONNREFUSED', 'ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ETIMEDOUT'].includes(error.code)) throw error; await delay(200); }
  }
  assert.ok(admin, 'MySQL did not become ready');
  const [rows] = await admin.query('SELECT @@version AS version,@@datadir AS datadir,@@port AS port,@@bind_address AS bind_address,@@innodb_page_size AS page_size');
  assert.equal(rows[0].version, version);
  assert.equal(path.resolve(rows[0].datadir).toLowerCase(), path.resolve(datadir).toLowerCase());
  assert.equal(rows[0].port, port); assert.equal(rows[0].bind_address, '127.0.0.1'); assert.equal(rows[0].page_size, 16384);
  report.server = rows[0];
  if (!initialized) {
    await admin.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${admin.escape(rootPassword)}`);
    initialized = true;
  }
}
async function stop() {
  for (const db of connections) await db.close(); connections.clear();
  if (!server || server.exitCode !== null) return;
  const exited = once(server, 'exit');
  try { if (admin) await admin.query('SHUTDOWN'); } catch (error) { if (error.code !== 'PROTOCOL_CONNECTION_LOST') throw error; }
  await admin?.end().catch(() => {}); admin = null;
  const code = await Promise.race([exited, delay(10000).then(() => { throw new Error('MYSQL_SHUTDOWN_TIMEOUT'); })]);
  assert.equal(code[0], 0);
}
async function open(afterQuery) {
  const underlying = await openVirtualDatabase({ backend: 'mysql', mysqlOptions: { host: '127.0.0.1', port, user: appUser,
    password: applicationPassword, database: databaseName, connectTimeout: 3000 } });
  const database = { ...underlying, transaction: callback => underlying.transaction(query => callback(async (sql, args) => {
    let result;
    try { result = await query(sql, args); }
    catch (error) { if (error.errno === 1213) report.deadlocksObserved = (report.deadlocksObserved || 0) + 1; throw error; }
    await afterQuery?.(sql, result);
    return result;
  })) };
  connections.add(database);
  const ledger = createVirtualLedger({ database, encryptionKey: '7'.repeat(64), now: () => now });
  const context = createPhotoJobContext({ ledger, policy, now: () => now });
  return { database, ledger, context, rows: (sql, args = []) => database.transaction(q => q(sql, args)) };
}
async function funded() {
  const f = await open(); const userId = `fixture_user_${++counter}`;
  await f.ledger.bindSession({ userId, sessionId: `${userId}_session`, appId, openid: `${userId}_openid`, sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const order = await f.ledger.createOrder({ userId, product: draftProducts[0], idempotencyKey: `${userId}_order`, appId, env: 1, platform: 'android' });
  const paid = await f.ledger.settle(order.id, { order_id: order.id, env_type: 2, order_fee: order.amountFen, paid_fee: order.amountFen,
    status: 2, order_type: 0, wx_order_id: `wx_${order.id}`, paid_time: Math.floor(now / 1000), refund_fee: 0, left_fee: order.amountFen });
  await f.context.grantBasicConsent(userId, policy.basicVersion);
  await f.context.grantFaceConsent(userId, { version: policy.faceVersion, subjectAuthorization: 'self' });
  const asset = kind => ({ id: `${userId}_${kind}`, storageKey: `private/${userId}/${kind}.png`, sha256: 'a'.repeat(64), byteLength: 200,
    contentType: 'image/png', expiresAt: now + 60000, moderation: { decision: 'allow', reference: `${userId}_review` },
    ...(kind === 'output' ? { labelVersion: policy.labelVersion } : {}) });
  await f.context.registerInput(userId, asset('input'));
  const request = { userId, idempotencyKey: `${userId}_photo_key`, inputAssetId: asset('input').id, effectId: effect.id };
  const submit = async context => context.repository.submit(await context.submission(request));
  const provider = async (context, { jobId }) => { await context.registerOutput(userId, jobId, asset('output')); return { assetId: asset('output').id }; };
  const forceRefund = () => f.ledger.applyRefund({ MchOrderId: paid.id, OpenId: paid.openid, WxOrderId: paid.providerId,
    WxRefundId: `wx_refund_${paid.id}`, MchRefundId: `external_${paid.id}`, RefundFee: paid.amountFen, RetCode: 0 });
  const credit = async () => (await f.rows('SELECT remaining,reserved FROM vp_buckets WHERE order_id = ?', [paid.id]))[0];
  return { ...f, userId, paid, asset, request, submit, provider, forceRefund, credit };
}
async function check(name, action) {
  await action(); checks.push({ name, passed: true }); console.log(`PASS ${name}`);
}
function barrier(expected) {
  let arrivals = 0, resolve, reject;
  const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
  const timeout = setTimeout(() => reject(new Error('SYNTHETIC_BARRIER_TIMEOUT')), 10000); timeout.unref();
  return { get arrivals() { return arrivals; }, async wait() {
    if (++arrivals === expected) { clearTimeout(timeout); resolve(); }
    await ready;
  } };
}
async function simultaneousReaders(expected, pattern, rendezvous) {
  return Promise.all(Array.from({ length: expected }, () => {
    let stopped = false;
    return open(async (sql, result) => {
      if (!stopped && pattern.test(sql)) { stopped = true; await rendezvous.wait(); }
    });
  }));
}
try {
  await childRun(['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--initialize-insecure', `--log-error=${path.join(root, 'initialize.log')}`]);
  await start();
  await admin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  await admin.query(`USE ${databaseName}`);
  // Parse only local reviewed DDL, never the historical USE cloud-database statement.
  for (const location of ['../deploy/mini-payment/sandbox-schema-v1.sql', '../photo-jobs/context-schema.sql', '../deploy/mini-payment/photo-jobs-schema-v1.sql']) {
    const statements = fs.readFileSync(new URL(location, import.meta.url), 'utf8').replace(/^--.*$/gm, '').split(';').map(value => value.trim()).filter(Boolean);
    for (const sql of statements.filter(value => /^(CREATE TABLE|CREATE INDEX|INSERT IGNORE INTO vp_schema)/i.test(value))) await admin.query(sql);
  }
  await admin.query(`CREATE USER '${appUser}'@'localhost' IDENTIFIED BY ${admin.escape(applicationPassword)}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${databaseName}.* TO '${appUser}'@'localhost'`);
  const initial = await open(); await initial.ledger.bindEnvironment(appId, 1); await initial.context.putEffect(effect);
  await check('DDL_InnoDB_binary_collation_enforced_checks_foreign_keys_and_pending_index', async () => {
    const [tables] = await admin.query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION,ROW_FORMAT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [databaseName]);
    assert.equal(tables.length, 17); assert.ok(tables.every(row => row.ENGINE === 'InnoDB' && row.TABLE_COLLATION === 'utf8mb4_bin' && row.ROW_FORMAT === 'Dynamic'));
    const [constraints] = await admin.query("SELECT TABLE_NAME,CONSTRAINT_NAME,ENFORCED FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_TYPE = 'CHECK'", [databaseName]);
    assert.ok(constraints.length >= 13); assert.ok(constraints.every(row => row.ENFORCED === 'YES'));
    const [indexes] = await admin.query('SELECT COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX', [databaseName, 'mini_photo_jobs', 'mini_photo_jobs_pending']);
    assert.deepEqual(indexes.map(row => row.COLUMN_NAME), ['state', 'created_at', 'id']);
    await assert.rejects(initial.rows('INSERT INTO mini_photo_accounts(user_id,enabled,updated_at) VALUES (?,1,0)', ['not_an_account']), error => {
      report.foreignKeyError = { code: error.code, errno: error.errno };
      return [1216, 1452].includes(error.errno);
    });
    await assert.rejects(initial.rows('UPDATE vp_environment SET env = 4'), error => {
      report.checkConstraintError = { code: error.code, errno: error.errno };
      return error.errno === 3819;
    });
    report.schema = { tables: tables.length, enforcedChecks: constraints.length, pendingIndex: true, runtimeCrudOnly: true };
  });
  await check('six_independent_pools_duplicate_submit_claim_publish_once', async () => {
    const f = await funded(); const peers = await Promise.all(Array.from({ length: 6 }, () => open()));
    const ids = await Promise.all(peers.map(peer => peer.rows('SELECT CONNECTION_ID() AS id')));
    assert.equal(new Set(ids.map(rows => rows[0].id)).size, 6);
    const submitted = await Promise.all(peers.map(peer => f.submit(peer.context)));
    assert.equal(new Set(submitted.map(result => result.job.id)).size, 1); assert.equal(submitted.filter(result => !result.duplicate).length, 1);
    let providerCalls = 0;
    const workers = peers.map(peer => createPhotoJobWorker({ repository: peer.context.repository, runProvider: async job => { providerCalls++; return f.provider(peer.context, job); } }));
    await Promise.all(workers.map(worker => worker.runOnce()));
    assert.equal(providerCalls, 1); assert.equal((await f.context.listWorks(f.userId)).length, 1);
    assert.deepEqual(await f.credit(), { remaining: 9, reserved: 0 });
  });
  await check('barrier_six_empty_same_key_reads_still_commit_one_reservation', async () => {
    const f = await funded(); const rendezvous = barrier(6);
    const peers = await simultaneousReaders(6, /^SELECT \* FROM mini_photo_jobs WHERE user_id = \? AND idem = \?$/, rendezvous);
    const submitted = await Promise.all(peers.map(peer => f.submit(peer.context)));
    assert.equal(rendezvous.arrivals, 6);
    assert.equal(submitted.filter(result => !result.duplicate).length, 1);
    assert.equal(new Set(submitted.map(result => result.job.id)).size, 1);
    assert.deepEqual(await f.credit(), { remaining: 9, reserved: 1 });
    const claims = barrier(6);
    const claimers = await simultaneousReaders(6, /^SELECT \* FROM mini_photo_jobs WHERE state = 'queued'/, claims);
    const claimed = await Promise.all(claimers.map(peer => peer.context.repository.claimNext()));
    assert.equal(claims.arrivals, 6); assert.equal(claimed.filter(Boolean).length, 1);
    const claim = claimed.find(Boolean); assert.equal(claim.attempt, 1);
    await f.provider(f.context, { jobId: claim.id });
    await f.context.repository.recordResult(claim.id, claim.claim_token, { assetId: f.asset('output').id });
    const publications = barrier(6);
    const publishers = await simultaneousReaders(6, /^SELECT \* FROM mini_photo_jobs WHERE state = 'result_ready'/, publications);
    const published = await Promise.all(publishers.map(peer => peer.context.repository.publishNext()));
    assert.equal(publications.arrivals, 6); assert.equal(published.filter(Boolean).length, 1);
    assert.equal(published.find(Boolean).state, 'succeeded');
    assert.equal((await f.context.listWorks(f.userId)).length, 1);
    assert.deepEqual(await f.credit(), { remaining: 9, reserved: 0 });
  });
  await check('publication_and_canonical_ledger_consumption_rollback_together', async () => {
    const f = await funded(); const { job } = await f.submit(f.context); const claim = await f.context.repository.claimNext();
    await f.provider(f.context, { jobId: job.id }); await f.context.repository.recordResult(job.id, claim.claim_token, { assetId: f.asset('output').id });
    const faulty = createPhotoJobRepository({ database: f.database, ...f.context.ports, now: () => now, settle: async args => { await f.context.ports.settle(args); throw new Error('SYNTHETIC_BEFORE_COMMIT'); } });
    await assert.rejects(faulty.publishNext(), /SYNTHETIC_BEFORE_COMMIT/);
    assert.deepEqual(await f.context.listWorks(f.userId), []); assert.deepEqual(await f.credit(), { remaining: 9, reserved: 1 });
    assert.equal((await f.context.repository.publishNext()).state, 'succeeded');
    assert.deepEqual(await f.credit(), { remaining: 9, reserved: 0 });
  });
  await check('real_applyRefund_before_dispatch_cancels_without_provider_or_returned_right', async () => {
    const f = await funded(); await f.submit(f.context); await f.forceRefund(); let calls = 0;
    const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: async () => { calls++; throw new Error('MUST_NOT_CALL'); } });
    assert.equal((await worker.runOnce()).state, 'cancelled'); assert.equal(calls, 0);
    assert.deepEqual(await f.credit(), { remaining: 0, reserved: 0 });
  });
  await check('real_applyRefund_racing_publication_serializes_without_restoring_rights', async () => {
    const f = await funded(); const { job } = await f.submit(f.context); const claim = await f.context.repository.claimNext();
    await f.provider(f.context, { jobId: job.id }); await f.context.repository.recordResult(job.id, claim.claim_token, { assetId: f.asset('output').id });
    // Begin the channel refund first; concurrent publication must wait on the shared user lock.
    const refunded = f.forceRefund(); const publication = f.context.repository.publishNext();
    await refunded; const outcome = await publication;
    // Either serialization is valid. A result published first may already have been delivered.
    if (outcome.state === 'blocked') { assert.deepEqual(await f.context.listWorks(f.userId), []); assert.deepEqual(await f.credit(), { remaining: 0, reserved: 1 }); }
    else { assert.equal(outcome.state, 'succeeded'); assert.deepEqual(await f.credit(), { remaining: 0, reserved: 0 }); }
    assert.equal((await f.ledger.order(f.paid.id)).status, 'refunded');
    report.refundRaceOutcome = outcome.state;
  });
  await check('withdrawal_racing_publication_makes_all_old_assets_unreadable', async () => {
    const f = await funded(); const { job } = await f.submit(f.context); const claim = await f.context.repository.claimNext();
    await f.provider(f.context, { jobId: job.id }); await f.context.repository.recordResult(job.id, claim.claim_token, { assetId: f.asset('output').id });
    await Promise.all([f.context.withdrawFaceConsent(f.userId), f.context.repository.publishNext()]);
    assert.deepEqual(await f.context.listWorks(f.userId), []); assert.equal(await f.context.readOwnedAsset(f.userId, f.asset('output').id), null);
    assert.ok([0, 1].includes((await f.credit()).reserved));
  });
  const lost = await funded(); const lostJob = (await lost.submit(lost.context)).job; await lost.context.repository.claimNext();
  const ready = await funded(); const readyJob = (await ready.submit(ready.context)).job; const readyClaim = await ready.context.repository.claimNext();
  await ready.provider(ready.context, { jobId: readyJob.id }); await ready.context.repository.recordResult(readyJob.id, readyClaim.claim_token, { assetId: ready.asset('output').id });
  await check('mysqld_restart_preserves_claim_and_recovers_only_ready_publication', async () => {
    await stop(); await start();
    const restored = await open();
    assert.equal((await restored.context.repository.readOwned(lost.userId, lostJob.id)).state, 'claimed');
    assert.equal(await restored.context.repository.claimNext(), null);
    assert.equal((await restored.context.repository.publishNext()).id, readyJob.id);
    assert.equal((await restored.context.listWorks(ready.userId)).length, 1);
    assert.equal((await restored.context.repository.readOwned(lost.userId, lostJob.id)).state, 'claimed');
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.failure = { code: error.code || error.name, message: String(error.message).slice(0, 700) };
  process.exitCode = 1;
} finally {
  try { await stop(); report.serverStopped = true; }
  catch (error) { report.serverStopped = false; report.shutdownError = error.code || error.message; if (server && server.exitCode === null) server.kill(); process.exitCode = 1; }
  fs.writeFileSync(path.join(root, 'mysql-photo-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, serverStopped: report.serverStopped, report: path.join(root, 'mysql-photo-acceptance.json'), failure: report.failure }));
}
