// Explicit local acceptance only; no .env, cloud connection, provider or cleanup.
// Usage: node tests/photo-upload-mysql-isolated.mjs <previous verified portable package directory>
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
import { createPhotoJobContext } from '../photo-jobs/context.js';
import { createPhotoUploadRepository, parsePhotoUpload } from '../photo-jobs/upload-repository.js';

const version = '8.0.46';
const officialMd5 = '003f527d5df61b663ff191038cd676bd';
const cleanupOnly = process.argv[3] === '--cleanup-only';
const portableRoot = fs.realpathSync(process.argv[2] || '');
const tempRoot = fs.realpathSync(os.tmpdir());
assert.equal(path.dirname(portableRoot).toLowerCase(), tempRoot.toLowerCase());
assert.match(path.basename(portableRoot), /^lyx-photo-mysql-[A-Za-z0-9-]+$/);
const archive = path.join(portableRoot, `mysql-${version}-winx64.zip`);
assert.equal(createHash('md5').update(fs.readFileSync(archive)).digest('hex'), officialMd5);
const basedir = path.join(portableRoot, `mysql-${version}-winx64`);
const executable = path.join(basedir, 'bin', 'mysqld.exe');
const taskDirectory = fs.mkdtempSync(path.join(tempRoot, 'lyx-photo-upload-mysql-'));
const datadir = path.join(taskDirectory, 'data');
assert.equal(fs.existsSync(datadir), false);
const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
const databaseName = `upload_test_${randomBytes(6).toString('hex')}`;
const password = randomBytes(24).toString('hex');
const rootPassword = randomBytes(24).toString('hex');
const applicationUser = 'upload_fixture';
const connections = new Set();
const report = { version, officialMd5, taskDirectory, datadir, host: '127.0.0.1', port, databaseName,
  source: `https://cdn.mysql.com/Downloads/MySQL-8.0/mysql-${version}-winx64.zip`, networkCallsToOssOrGreen: 0, checks: [], deadlocks: 0 };
const policy = { basicVersion: 'fixture_basic', faceVersion: 'fixture_face', moderationVersion: 'fixture_review', moderationService: 'baselineCheck',
  sourceRetentionMs: 86400000, maxDailyUploads: 100, maxDailyUploadsPerUser: 50 };
const stamp = Date.now(); const key = n => n.toString(16).padStart(32, '0');
const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XAZkAAAAASUVORK5CYII=';
const source = parsePhotoUpload(image);
let server, admin, userNumber = 0;

const check = async (name, operation) => {
  if (cleanupOnly && !name.startsWith('cleanup_')) return;
  await operation(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`);
};
function barrier(expected) {
  let count = 0, release, reject;
  const promise = new Promise((yes, no) => { release = yes; reject = no; });
  const timer = setTimeout(() => reject(new Error('FIXTURE_BARRIER_TIMEOUT')), 10000); timer.unref();
  return async () => { if (++count === expected) { clearTimeout(timer); release(); } await promise; };
}
async function open({ afterQuery, customPolicy = policy, clock = () => stamp } = {}) {
  const db = await openVirtualDatabase({ backend: 'mysql', mysqlOptions: { host: '127.0.0.1', port,
    user: applicationUser, password, database: databaseName, connectTimeout: 3000 } });
  const database = { ...db, transaction: callback => db.transaction(q => callback(async (sql, args) => {
    let result;
    try { result = await q(sql, args); } catch (error) { if (error.errno === 1213) report.deadlocks++; throw error; }
    await afterQuery?.(sql, result); return result;
  })) };
  connections.add(database);
  const repository = createPhotoUploadRepository({ database, policy: customPolicy, now: clock });
  const ledger = createVirtualLedger({ database, encryptionKey: '5'.repeat(64), now: clock });
  const context = createPhotoJobContext({ ledger, policy: { ...policy, labelVersion: 'fixture_label' }, now: clock });
  return { database, repository, context, rows: (sql, args = []) => database.transaction(q => q(sql, args)) };
}
async function user() {
  const f = await open(); const userId = `user_${++userNumber}`;
  await f.rows('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [userId, 'fixture_app', `openid_${userNumber}`]);
  await f.context.grantBasicConsent(userId, policy.basicVersion);
  await f.context.grantFaceConsent(userId, { version: policy.faceVersion, subjectAuthorization: 'self' });
  return { ...f, userId, input: { userId, idempotencyKey: key(userNumber), sha256: source.sha256, byteLength: source.byteLength, contentType: source.contentType } };
}
async function review(f, uploadId) {
  const reference = randomBytes(16).toString('hex');
  await f.repository.recordModerationIntent(uploadId, { reference, extension: 'png' });
  return f.repository.recordReview(uploadId, { provider: 'aliyun-green', policyVersion: policy.moderationVersion,
    service: policy.moderationService, direction: 'input', sha256: source.sha256, byteLength: source.byteLength,
    decision: 'allow', reference: `mod_${'1'.repeat(64)}`, requestId: 'fixture_review_request', cleanupPending: false,
    cleanupReference: reference, cleanupExtension: 'png' });
}

try {
  const initializer = spawn(executable, ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--initialize-insecure',
    `--log-error=${path.join(taskDirectory, 'initialize.log')}`], { windowsHide: true, stdio: 'ignore' });
  assert.equal((await once(initializer, 'exit'))[0], 0);
  server = spawn(executable, ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--bind-address=127.0.0.1', `--port=${port}`,
    '--mysqlx=OFF', '--skip-log-bin', '--performance-schema=OFF', '--innodb-buffer-pool-size=64M', '--innodb-default-row-format=DYNAMIC',
    '--character-set-server=utf8mb4', '--collation-server=utf8mb4_bin', `--log-error=${path.join(taskDirectory, 'mysqld.log')}`], { windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error('FIXTURE_MYSQL_START_FAILED');
    try { admin = await createConnection({ host: '127.0.0.1', port, user: 'root', password: '', connectTimeout: 1000 }); break; }
    catch (error) { if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(error.code)) throw error; await delay(200); }
  }
  assert.ok(admin);
  await admin.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${admin.escape(rootPassword)}`);
  const [identity] = await admin.query('SELECT @@version AS version,@@datadir AS datadir,@@bind_address AS bind_address');
  assert.equal(identity[0].version, version); assert.equal(identity[0].bind_address, '127.0.0.1');
  assert.equal(path.resolve(identity[0].datadir).toLowerCase(), path.resolve(datadir).toLowerCase());
  await admin.query(`CREATE DATABASE ${databaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`); await admin.query(`USE ${databaseName}`);
  for (const name of ['../deploy/mini-payment/sandbox-schema-v1.sql', '../photo-jobs/context-schema.sql', '../photo-jobs/upload-schema.sql']) {
    const sql = fs.readFileSync(new URL(name, import.meta.url), 'utf8').replace(/^--.*$/gm, '');
    for (const statement of sql.split(';').map(x => x.trim()).filter(x => /^(CREATE TABLE|CREATE INDEX|INSERT IGNORE INTO vp_schema)/i.test(x))) await admin.query(statement);
  }
  await admin.query(`CREATE USER '${applicationUser}'@'localhost' IDENTIFIED BY ${admin.escape(password)}`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ${databaseName}.* TO '${applicationUser}'@'localhost'`);

  await check('new_DDL_binary_InnoDB_enforces_user_key_object_scratch_uniqueness_and_checks', async () => {
    const [tables] = await admin.query("SELECT ENGINE,TABLE_COLLATION,ROW_FORMAT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='mini_photo_uploads'", [databaseName]);
    assert.deepEqual(tables[0], { ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_bin', ROW_FORMAT: 'Dynamic' });
    const [indexes] = await admin.query("SELECT INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='mini_photo_uploads' AND NON_UNIQUE=0 GROUP BY INDEX_NAME", [databaseName]);
    for (const cols of ['id', 'user_id,idem', 'storage_key', 'asset_id', 'moderation_cleanup_reference']) assert.ok(indexes.some(row => row.cols === cols));
    const [checks] = await admin.query("SELECT ENFORCED FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='mini_photo_uploads' AND CONSTRAINT_TYPE='CHECK'", [databaseName]);
    assert.equal(checks.length, 5); assert.ok(checks.every(row => row.ENFORCED === 'YES'));
    const f = await user(); const { upload } = await f.repository.submitIntent(f.input);
    await assert.rejects(f.rows('UPDATE mini_photo_uploads SET attempts=2 WHERE id=?', [upload.id]), e => e.errno === 3819);
    await assert.rejects(f.rows("UPDATE mini_photo_uploads SET user_id='missing_user' WHERE id=?", [upload.id]), e => [1216,1452].includes(e.errno));
    report.schema = { uniqueIndexes: indexes.map(x => x.cols), enforcedChecks: checks.length };
  });

  await check('last_global_upload_budget_across_two_users_and_two_pools_admits_exactly_one', async () => {
    const first = await user(); const second = await user();
    const count = (await first.rows('SELECT COUNT(*) AS n FROM mini_photo_uploads'))[0].n;
    const wait = barrier(2); const peers = await Promise.all([0, 1].map(async () => {
      let visited = false; return open({ customPolicy: { ...policy, maxDailyUploads: count + 1 }, afterQuery: async sql => {
        if (!visited && sql === 'SELECT COUNT(*) AS n FROM mini_photo_uploads WHERE created_at >= ?') { visited = true; await wait(); }
      } });
    }));
    const result = await Promise.allSettled(peers.map((p, i) => p.repository.submitIntent([first, second][i].input)));
    assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
    const error = result.find(r => r.status === 'rejected').reason;
    assert.equal(error.code, 'PHOTO_UPLOAD_BUDGET_LIMIT');
    assert.equal((await first.rows('SELECT COUNT(*) AS n FROM mini_photo_uploads'))[0].n, count + 1);
  });

  await check('six_independent_pools_same_key_one_intent_claim_journal_publication', async () => {
    const f = await user(); const peers = await Promise.all(Array.from({ length: 6 }, () => open()));
    const ids = await Promise.all(peers.map(p => p.rows('SELECT CONNECTION_ID() AS id')));
    assert.equal(new Set(ids.map(x => x[0].id)).size, 6);
    const result = await Promise.all(peers.map(p => p.repository.submitIntent(f.input)));
    assert.equal(result.filter(x => !x.duplicate).length, 1); assert.equal(new Set(result.map(x => x.upload.id)).size, 1);
    const uploadId = result[0].upload.id; await f.repository.confirmStored(uploadId, source);
    const claimWait = barrier(6); const claimers = await Promise.all(Array.from({ length: 6 }, async () => {
      let visited = false; return open({ afterQuery: async sql => {
        if (!visited && sql.includes("WHERE state = 'queued' AND attempts = 0 ORDER BY")) { visited = true; await claimWait(); }
      } });
    }));
    const claimed = await Promise.allSettled(claimers.map(p => p.repository.claimNext()));
    const winners = claimed.filter(x => x.status === 'fulfilled' && x.value);
    assert.equal(winners.length, 1); assert.equal(winners[0].value.id, uploadId);
    const exhausted = claimed.filter(x => x.status === 'rejected');
    assert.ok(exhausted.every(x => x.reason.errno === 1213)); report.claimRetriesExhausted = exhausted.length;
    const journal = await Promise.allSettled(peers.map((p, i) => p.repository.recordModerationIntent(uploadId, { reference: key(100 + i), extension: 'png' })));
    assert.equal(journal.filter(x => x.status === 'fulfilled').length, 1);
    assert.ok(journal.filter(x => x.status === 'rejected').every(x => x.reason.code === 'PHOTO_UPLOAD_REVIEW_ALREADY_DISPATCHED'));
    const [row] = await f.rows('SELECT * FROM mini_photo_uploads WHERE id=?', [uploadId]);
    await f.repository.recordReview(uploadId, { provider: 'aliyun-green', policyVersion: policy.moderationVersion,
      service: policy.moderationService, direction: 'input', sha256: source.sha256, byteLength: source.byteLength, decision: 'allow',
      reference: `mod_${'1'.repeat(64)}`, requestId: 'fixture_request', cleanupPending: false,
      cleanupReference: row.moderation_cleanup_reference, cleanupExtension: 'png' });
    const published = await Promise.allSettled(peers.map(p => p.repository.publishNext()));
    assert.equal(published.filter(x => x.status === 'fulfilled' && x.value?.state === 'ready').length, 1);
    assert.ok(published.filter(x => x.status === 'rejected').every(x => x.reason.errno === 1213));
    assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_assets WHERE user_id=?', [f.userId]))[0].n, 1);
    assert.equal((await f.repository.readOwned(f.userId, uploadId)).state, 'ready');
    assert.equal((await f.rows('SELECT COUNT(*) AS n FROM vp_reservations'))[0].n, 0);
  });

  await check('asset_insert_and_ready_state_roll_back_together_then_publish_without_second_review', async () => {
    const f = await user(); const { upload } = await f.repository.submitIntent(f.input); await f.repository.confirmStored(upload.id, source);
    assert.equal((await f.repository.claimNext()).id, upload.id); await review(f, upload.id);
    const faulty = await open({ afterQuery: async sql => { if (sql.includes("SET state = 'ready'")) throw new Error('FIXTURE_BEFORE_COMMIT'); } });
    await assert.rejects(faulty.repository.publishNext(), /FIXTURE_BEFORE_COMMIT/);
    assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_assets WHERE user_id=?', [f.userId]))[0].n, 0);
    assert.equal((await f.repository.readOwned(f.userId, upload.id)).state, 'reviewed');
    assert.equal((await f.repository.publishNext()).state, 'ready');
  });

  await check('consent_withdrawal_racing_publication_always_hides_old_input_and_records_cleanup', async () => {
    const f = await user(); const { upload } = await f.repository.submitIntent(f.input); await f.repository.confirmStored(upload.id, source);
    assert.equal((await f.repository.claimNext()).id, upload.id); await review(f, upload.id);
    const peer = await open(); await Promise.all([f.context.withdrawFaceConsent(f.userId), peer.repository.publishNext()]);
    const owned = await f.repository.readOwned(f.userId, upload.id); assert.equal(owned.state, 'cancelled'); assert.equal(owned.assetId, undefined);
    const row = (await f.rows('SELECT * FROM mini_photo_uploads WHERE id=?', [upload.id]))[0];
    assert.equal(await f.context.readOwnedAsset(f.userId, row.asset_id), null);
    assert.ok((await f.repository.cleanupCandidates()).some(x => x.id === upload.id && x.source_cleanup_pending === 1));
  });

  const cleanupTiming = { retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000, claimHoldMs: 1100 };
  await check('cleanup_DDL_enforces_scope_unique_key_and_observation_state_constraints', async () => {
    const [table] = await admin.query("SELECT ENGINE,TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME='mini_photo_upload_cleanup'", [databaseName]);
    assert.deepEqual(table[0], { ENGINE: 'InnoDB', TABLE_COLLATION: 'utf8mb4_bin' });
    const [checks] = await admin.query("SELECT ENFORCED FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='mini_photo_upload_cleanup' AND CONSTRAINT_TYPE='CHECK'", [databaseName]);
    assert.equal(checks.length, 6); assert.ok(checks.every(row => row.ENFORCED === 'YES'));
    const [indexes] = await admin.query("SELECT INDEX_NAME,GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=? AND TABLE_NAME='mini_photo_upload_cleanup' AND NON_UNIQUE=0 GROUP BY INDEX_NAME", [databaseName]);
    assert.ok(indexes.some(row => row.cols === 'upload_id,kind')); assert.ok(indexes.some(row => row.cols === 'storage_key'));
    report.cleanupSchema = { enforcedChecks: checks.length, uniqueIndexes: indexes.map(row => row.cols) };
  });

  await check('cleanup_six_pools_claim_one_delete_intent_and_absence_stays_due_for_recheck', async () => {
    const f = await user(); const { upload } = await f.repository.submitIntent(f.input); await f.context.withdrawFaceConsent(f.userId);
    await f.repository.prepareCleanup(cleanupTiming);
    // Other historical upload cases may already have cleanup responsibilities.
    // Keep this controlled race targeted to its own fresh synthetic source.
    await f.rows('UPDATE mini_photo_upload_cleanup SET next_at=? WHERE upload_id<>?', [stamp + 86400000, upload.id]);
    const wait = barrier(6);
    const peers = await Promise.all(Array.from({ length: 6 }, async () => {
      let visited = false; return open({ afterQuery: async sql => {
        if (!visited && sql.includes('JOIN mini_photo_uploads u ON u.id = c.upload_id WHERE c.next_at <= ?')) { visited = true; await wait(); }
      } });
    }));
    const claimed = await Promise.allSettled(peers.map(peer => peer.repository.claimCleanup(cleanupTiming)));
    const winners = claimed.filter(row => row.status === 'fulfilled' && row.value);
    assert.equal(winners.length, 1); const claim = winners[0].value;
    assert.equal(claim.uploadId, upload.id); assert.equal(claim.kind, 'source');
    const exhausted = claimed.filter(row => row.status === 'rejected'); assert.ok(exhausted.every(row => row.reason.errno === 1213));
    report.cleanupClaimRetriesExhausted = exhausted.length;
    await f.repository.recordCleanupObservation(claim, { deleteAcknowledged: true, observation: 'absent' }, cleanupTiming);
    const [row] = await f.repository.cleanupJournal(upload.id); assert.equal(row.state, 'absent_observed'); assert.equal(row.next_at, stamp + 5000);
    assert.equal(await f.repository.claimCleanup(cleanupTiming), null);
    const later = await open({ clock: () => stamp + 5001 }); const revisited = await later.repository.claimCleanup(cleanupTiming);
    assert.equal(revisited.uploadId, upload.id); assert.equal(revisited.attempt, 2);
    await later.repository.recordCleanupObservation(revisited, { deleteAcknowledged: true, observation: 'present' }, cleanupTiming);
    const [observed] = await later.repository.cleanupJournal(upload.id); assert.equal(observed.state, 'present'); assert.equal(observed.next_at, stamp + 6001);
    assert.equal((await f.rows('SELECT source_cleanup_pending FROM mini_photo_uploads WHERE id=?', [upload.id]))[0].source_cleanup_pending, 1);
  });

  await check('cleanup_claim_rollback_and_stale_observation_never_erase_newer_unknown_attempt', async () => {
    const f = await user(); const { upload } = await f.repository.submitIntent(f.input); await f.context.withdrawFaceConsent(f.userId);
    await f.repository.prepareCleanup(cleanupTiming);
    await f.rows('UPDATE mini_photo_upload_cleanup SET next_at=? WHERE upload_id<>?', [stamp + 86400000, upload.id]);
    const faulty = await open({ afterQuery: async sql => { if (sql.includes("SET state = 'observing'")) throw new Error('CLEANUP_FIXTURE_ROLLBACK'); } });
    await assert.rejects(faulty.repository.claimCleanup(cleanupTiming), /CLEANUP_FIXTURE_ROLLBACK/);
    const [rolledBack] = await f.repository.cleanupJournal(upload.id); assert.equal(rolledBack.attempts, 0); assert.equal(rolledBack.state, 'pending');
    const old = await f.repository.claimCleanup(cleanupTiming);
    const later = await open({ clock: () => stamp + cleanupTiming.claimHoldMs + 1 }); const current = await later.repository.claimCleanup(cleanupTiming);
    assert.notEqual(old.operationToken, current.operationToken);
    assert.equal(await later.repository.recordCleanupObservation(old, { deleteAcknowledged: true, observation: 'absent' }, cleanupTiming), false);
    assert.equal(await later.repository.recordCleanupObservation(current, { deleteAcknowledged: false, observation: 'unknown' }, cleanupTiming), true);
    const [result] = await f.repository.cleanupJournal(upload.id); assert.equal(result.state, 'unknown'); assert.equal(result.observation, 'unknown');
  });
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = { message: error.message, code: error.code, errno: error.errno };
  console.error(`FAIL ${error.code || error.message}`); process.exitCode = 1;
} finally {
  for (const db of connections) await db.close().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    try { await admin?.query('SHUTDOWN'); } catch (error) { if (error.code !== 'PROTOCOL_CONNECTION_LOST') report.shutdownError = error.code; }
    await admin?.end().catch(() => {});
    await Promise.race([exited, delay(10000).then(() => { throw new Error('MYSQL_SHUTDOWN_TIMEOUT'); })]);
  }
  report.serverStopped = !server || server.exitCode !== null;
  fs.writeFileSync(path.join(taskDirectory, 'upload-mysql-acceptance.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, deadlocks: report.deadlocks,
    serverStopped: report.serverStopped, report: path.join(taskDirectory, 'upload-mysql-acceptance.json') }));
}
