// Explicit LOCAL acceptance only. Never run against a supplied host or real database.
// node tests/photo-candidate-schema-mysql-isolated.mjs <existing verified portable package>
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mysql2/promise';
import { verifyPhotoCandidateBundle } from '../scripts/build-mini-photo-candidate.mjs';

const packageDirectory = 'REDACTED_LOCAL_USER_PATH/AppData/Local/Temp/lyx-photo-mysql-20261009-6f5d34b2';
const bundle = 'D:/JT/乐颜秀/workspace/candidate-artifacts/mini-photo-candidate-20261011-0900';
const candidateHash = 'e99b22faf1c7a6bf91941504b1eef096f1d3fcce61ff85125679e0deb680890a';
const hash = value => createHash('sha256').update(value).digest('hex');
if (process.argv.length === 2) { console.log('NO_OP: explicit reviewed portable MySQL directory required; localhost only.'); process.exit(0); }
assert.equal(process.argv.length, 3);
assert.equal(fs.realpathSync(process.argv[2]).toLowerCase(), fs.realpathSync(packageDirectory).toLowerCase());
assert.equal(verifyPhotoCandidateBundle(bundle).manifestSha256, candidateHash);
assert.equal(createHash('md5').update(fs.readFileSync(path.join(packageDirectory, 'mysql-8.0.46-winx64.zip'))).digest('hex'), '003f527d5df61b663ff191038cd676bd');
const basedir = path.join(packageDirectory, 'mysql-8.0.46-winx64');
const executable = name => path.join(basedir, 'bin', `${name}.exe`);
const taskDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lyx-photo-schema-'));
const datadir = path.join(taskDirectory, 'data');
const serverName = `photoaudit${randomBytes(5).toString('hex')}`;
const restoreName = `photorestore${randomBytes(5).toString('hex')}`;
const driftName = `photodrift${randomBytes(5).toString('hex')}`;
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const password = randomBytes(24).toString('hex');
const report = { version: 1, candidateHash, localOnly: true, cloudSqlExecuted: false, providerCalls: 0,
  taskDirectory, mysqlVersion: '8.0.46', checks: [], passed: false, stopped: false };
const connections = new Set();
let server, admin;
const safeEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
// Only a fresh synthetic localhost credential is passed; never inherit a real MYSQL_PWD or .env.
async function command(name, args, { input, stdout, mysqlPassword, timeout = 30000 } = {}) {
  const child = spawn(executable(name), args, { windowsHide: true, env: { ...safeEnv, ...(mysqlPassword ? { MYSQL_PWD: mysqlPassword } : {}) }, stdio: ['pipe', stdout ?? 'ignore', 'pipe'] });
  let stderr = ''; child.stderr.on('data', bytes => { if (stderr.length < 8192) stderr += bytes.toString(); });
  const timer = setTimeout(() => child.kill(), timeout);
  if (input) input.pipe(child.stdin); else child.stdin.end();
  try {
    const [code] = await once(child, 'exit');
    if (code !== 0) { fs.writeFileSync(path.join(taskDirectory, `${name}-failure.txt`), stderr); throw new Error(`LOCAL_${name.toUpperCase()}_FAILED`); }
  } finally { clearTimeout(timer); }
}
async function connection(user = 'root', database) {
  const db = await createConnection({ host: '127.0.0.1', port, user, password: user === 'root' && !admin ? '' : password, database, connectTimeout: 1000 });
  connections.add(db); return db;
}
const statements = relative => fs.readFileSync(path.join(bundle, relative), 'utf8').replace(/^--.*$/gm, '').split(';').map(x => x.trim()).filter(Boolean);
const photoFiles = ['photo-jobs/context-schema.sql', 'deploy/mini-payment/photo-jobs-schema-v1.sql', 'photo-jobs/upload-schema.sql', 'photo-jobs/generation-schema.sql'];
const photoSql = photoFiles.flatMap(statements);
assert.ok(photoSql.every(sql => /^(CREATE TABLE|CREATE INDEX)\b/.test(sql)));
const photoTables = photoSql.filter(sql => sql.startsWith('CREATE TABLE')).map(sql => sql.match(/^CREATE TABLE IF NOT EXISTS ([a-z_]+)/)[1]);
assert.equal(photoTables.length, 10); assert.equal(new Set(photoTables).size, 10);
async function check(name, run) { await run(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function tableSnapshot(database) {
  // SHOW CREATE qualifies FK schema names relative to the current database.
  // Select each isolated database consistently; independently assert FK scope.
  await admin.query(`USE \`${database}\``);
  const [foreignKeys] = await admin.query('SELECT REFERENCED_TABLE_SCHEMA FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL', [database]);
  assert.ok(foreignKeys.every(key => key.REFERENCED_TABLE_SCHEMA === database));
  const [names] = await admin.query('SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? ORDER BY TABLE_NAME', [database]);
  const result = {};
  for (const { TABLE_NAME: name } of names) {
    const [rows] = await admin.query(`SELECT * FROM \`${database}\`.\`${name}\``);
    const [ddl] = await admin.query(`SHOW CREATE TABLE \`${database}\`.\`${name}\``);
    const [columns] = await admin.query('SELECT COLUMN_NAME,ORDINAL_POSITION,COLUMN_TYPE,IS_NULLABLE,COLUMN_DEFAULT,CHARACTER_SET_NAME,COLLATION_NAME,EXTRA FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION', [database, name]);
    // Dump/restore makes inherited utf8mb4 declarations explicit. Compare actual
    // column metadata as well as DDL, normalizing only this redundant spelling.
    result[name] = { rows: rows.length, rowHash: hash(JSON.stringify(rows.map(x => JSON.stringify(x)).sort())), columns,
      ddl: ddl[0]['Create Table'].replaceAll(' CHARACTER SET utf8mb4 COLLATE utf8mb4_bin', ' COLLATE utf8mb4_bin') };
  }
  return result;
}
async function insert(table, values) {
  await admin.query(`INSERT INTO \`${table}\` (${Object.keys(values).map(x => `\`${x}\``).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`, Object.values(values));
}

try {
  await command('mysqld', ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--initialize-insecure', `--log-error=${path.join(taskDirectory, 'initialize.log')}`], { timeout: 120000 });
  server = spawn(executable('mysqld'), ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--bind-address=127.0.0.1', `--port=${port}`,
    '--mysqlx=OFF', '--skip-log-bin', '--performance-schema=OFF', '--innodb-buffer-pool-size=64M', '--innodb-default-row-format=DYNAMIC',
    '--character-set-server=utf8mb4', '--collation-server=utf8mb4_bin', `--log-error=${path.join(taskDirectory, 'mysqld.log')}`], { windowsHide: true, env: safeEnv, stdio: 'ignore' });
  const deadline = Date.now() + 45000;
  while (!admin && Date.now() < deadline) {
    assert.equal(server.exitCode, null);
    try { admin = await connection(); } catch (error) { if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code)) throw error; await delay(200); }
  }
  assert.ok(admin);
  const [identity] = await admin.query('SELECT @@version AS version,@@datadir AS datadir,@@bind_address AS host,@@port AS port');
  assert.equal(identity[0].version, '8.0.46'); assert.equal(identity[0].host, '127.0.0.1'); assert.equal(identity[0].port, port);
  assert.equal(path.resolve(identity[0].datadir).toLowerCase(), datadir.toLowerCase());
  await admin.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${admin.escape(password)}`);
  for (const name of [serverName, restoreName, driftName]) await admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
  await admin.query(`USE \`${serverName}\``);
  for (const sql of statements('deploy/mini-payment/sandbox-schema-v1.sql').filter(sql => /^(CREATE TABLE|CREATE INDEX|INSERT IGNORE INTO vp_schema)/.test(sql))) await admin.query(sql);
  const authSql = statements('deploy/mini-payment/mini-identity-schema-v1.sql').filter(sql => sql.startsWith('CREATE TABLE'));
  assert.equal(authSql.length, 1);
  await admin.query(authSql[0].replaceAll('leyanxiu_xpay_sandbox.', `${serverName}.`));
  for (const user of ['schema_fixture', 'runtime_fixture', 'backup_fixture']) await admin.query(`CREATE USER '${user}'@'localhost' IDENTIFIED BY ${admin.escape(password)}`);
  await admin.query(`GRANT CREATE,INDEX,REFERENCES ON \`${serverName}\`.* TO 'schema_fixture'@'localhost'`);
  await admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON \`${serverName}\`.* TO 'runtime_fixture'@'localhost'`);
  await admin.query(`GRANT SELECT ON \`${serverName}\`.* TO 'backup_fixture'@'localhost'`);
  const migrator = await connection('schema_fixture', serverName), runtime = await connection('runtime_fixture', serverName);

  await check('ten_tables_apply_with_CREATE_INDEX_REFERENCES_without_runtime_DDL', async () => {
    for (const sql of photoSql) await migrator.query(sql);
    const [tables] = await admin.query("SELECT TABLE_NAME,ENGINE,TABLE_COLLATION,ROW_FORMAT FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'mini_photo_%'", [serverName]);
    assert.equal(tables.length, 10); assert.ok(tables.every(t => t.ENGINE === 'InnoDB' && t.TABLE_COLLATION === 'utf8mb4_bin' && t.ROW_FORMAT === 'Dynamic'));
    const [constraints] = await admin.query("SELECT CONSTRAINT_TYPE,ENFORCED FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=? AND TABLE_NAME LIKE 'mini_photo_%'", [serverName]);
    const checks = constraints.filter(x => x.CONSTRAINT_TYPE === 'CHECK'); assert.equal(checks.length, 29); assert.ok(checks.every(x => x.ENFORCED === 'YES'));
    assert.equal(constraints.filter(x => x.CONSTRAINT_TYPE === 'FOREIGN KEY').length, 11);
    report.schema = { tables: tables.length, enforcedChecks: checks.length, foreignKeys: 11 };
    await assert.rejects(runtime.query('CREATE TABLE denied_fixture(id INTEGER)'), error => error.errno === 1142);
    await assert.rejects(runtime.query('ALTER TABLE mini_photo_jobs ADD COLUMN denied INTEGER'), error => error.errno === 1142);
    await assert.rejects(migrator.query('DELETE FROM mini_photo_accounts'), error => error.errno === 1142);
  });

  await check('existing_table_skip_and_index_replay_do_not_prove_migration_complete', async () => {
    await admin.query(`CREATE TABLE \`${driftName}\`.mini_photo_accounts (user_id VARCHAR(80) PRIMARY KEY) ENGINE=InnoDB`);
    await admin.query(`USE \`${driftName}\``); await admin.query(photoSql[0]);
    await assert.rejects(admin.query('SELECT consent_epoch FROM mini_photo_accounts LIMIT 0'), error => error.errno === 1054);
    await admin.query('START TRANSACTION'); await admin.query('CREATE TABLE ddl_commit_fixture(id INTEGER) ENGINE=InnoDB'); await admin.query('ROLLBACK');
    const [kept] = await admin.query("SHOW TABLES LIKE 'ddl_commit_fixture'"); assert.equal(kept.length, 1);
    await admin.query(`USE \`${serverName}\``);
    await assert.rejects(migrator.query(photoSql.find(x => x.startsWith('CREATE INDEX'))), error => error.errno === 1061);
  });

  await check('same_database_snapshot_contains_identity_ledger_jobs_media_and_cleanup', async () => {
    const user = 'synthetic_user', job = 'synthetic_job', order = 'a'.repeat(32), asset = 'synthetic_output';
    await insert('vp_environment', { id: 1, app_id: 'wx_synthetic', env: 1 });
    await insert('vp_accounts', { user_id: user, app_id: 'wx_synthetic', openid: 'synthetic_openid' });
    await insert('vp_auth_sessions', { id: 'synthetic_auth', user_id: user, app_id: 'wx_synthetic', token_hash: 'b'.repeat(64), created_at: 0, expires_at: 86400000 });
    await insert('vp_sessions', { id: 'synthetic_session', user_id: user, sealed: 'synthetic_opaque_not_a_credential', expires_at: 86400000 });
    await insert('vp_orders', { id: order, user_id: user, idem: 'synthetic_order_key', status: 'paid', provider_id: 'synthetic_provider_order', payload: '{}', created_at: 0 });
    await insert('vp_buckets', { id: 'synthetic_bucket', user_id: user, order_id: order, kind: 'photo', starts_at: 0, expires_at: 86400000, quantity: 1, remaining: 0, reserved: 0, frozen: 0, value_fen: 990 });
    await insert('vp_reservations', { id: 'synthetic_bill', user_id: user, bucket_id: 'synthetic_bucket', purpose: 'photo-effect:repair', status: 'consumed', created_at: 0 });
    await insert('vp_refunds', { id: 'c'.repeat(32), order_id: order, user_id: user, status: 'processing', payload: '{}', created_at: 0 });
    await insert('vp_events', { id: 'synthetic_event', order_id: order, digest: 'd'.repeat(64), created_at: 0 });
    await insert('vp_outbox', { id: 'synthetic_outbox', order_id: order, kind: 'refund', status: 'pending', attempts: 1, next_at: 1000 });
    await insert('vp_audit', { id: 'e'.repeat(32), user_id: user, action: 'fixture', reference_id: job, detail: '{}', created_at: 0 });
    await insert('vp_reconciliation', { id: 'f'.repeat(32), payload: '{}', created_at: 0 });
    await insert('mini_photo_accounts', { user_id: user, enabled: 1, consent_epoch: 1, basic_version: 'fixture_basic', face_version: 'fixture_face', subject_authorization: 'self', updated_at: 0 });
    await insert('mini_photo_effects', { effect_id: 'repair', version: 'fixture_v1', provider: 'fixture_provider', model: 'fixture_model', purpose: 'photo-effect:repair', parameters: '{}', enabled: 1, review_reference: 'fixture_only', created_at: 0 });
    for (const kind of ['input', 'output']) await insert('mini_photo_assets', { id: `synthetic_${kind}`, user_id: user, kind, state: kind === 'input' ? 'ready' : 'published', storage_key: `private/fixture/${kind}.png`, sha256: '1'.repeat(64), byte_length: 128, content_type: 'image/png', consent_epoch: 1, job_id: kind === 'output' ? job : null, moderation_reference: 'synthetic_moderation', label_version: kind === 'output' ? 'fixture_label' : null, expires_at: 86400000, created_at: 0 });
    await insert('mini_photo_jobs', { id: job, user_id: user, idem: 'synthetic_job_key', spec: '{}', spec_hash: '2'.repeat(64), billing_ref: 'synthetic_bill', state: 'succeeded', attempt: 1, output_asset_id: asset, created_at: 0, updated_at: 0 });
    await insert('mini_photo_works', { job_id: job, asset_id: asset, user_id: user, created_at: 0 });
    await insert('mini_photo_uploads', { id: 'synthetic_upload', user_id: user, idem: '3'.repeat(32), state: 'ready', storage_key: 'private/fixture/input.png', asset_id: 'synthetic_input', sha256: '1'.repeat(64), byte_length: 128, content_type: 'image/png', consent_epoch: 1, basic_version: 'fixture_basic', face_version: 'fixture_face', moderation_version: 'fixture_review', moderation_service: 'baselineCheck', attempts: 1, source_cleanup_pending: 1, expires_at: 86400000, created_at: 0, updated_at: 0 });
    await insert('mini_photo_upload_cleanup', { upload_id: 'synthetic_upload', kind: 'source', storage_key: 'private/fixture/input.png', state: 'unknown', attempts: 1, next_at: 1000, created_at: 0, updated_at: 0 });
    await insert('mini_photo_generation', { job_id: job, user_id: user, spec_hash: '2'.repeat(64), policy: '{}', asset_id: asset, output_key: 'private/fixture/output.png', registered: 1, expires_at: 86400000, created_at: 0, updated_at: 0 });
    await insert('mini_photo_generation_operations', { job_id: job, step: 'generate', state: 'succeeded', token: '4'.repeat(32), attempts: 1, started_at: 0, updated_at: 0 });
    await insert('mini_photo_generation_cleanup', { job_id: job, kind: 'output', storage_key: 'private/fixture/output.png', state: 'unknown', attempts: 1, next_at: 1000, created_at: 0, updated_at: 0 });
    const snapshot = await tableSnapshot(serverName); assert.equal(Object.keys(snapshot).length, 23); assert.ok(Object.values(snapshot).every(x => x.rows > 0));
    await assert.rejects(runtime.query('UPDATE mini_photo_jobs SET attempt=2 WHERE id=?', [job]), error => error.errno === 3819);
    await assert.rejects(runtime.query("INSERT INTO mini_photo_accounts(user_id,updated_at) VALUES ('missing',0)"), error => {
      report.missingParentError = { code: error.code, errno: error.errno };
      // MySQL may use the non-detailed 1216 form for a restricted account.
      return [1216, 1452].includes(error.errno);
    });
    await runtime.query("UPDATE mini_photo_accounts SET updated_at=1 WHERE user_id='synthetic_user'");
    await runtime.query("UPDATE mini_photo_accounts SET updated_at=0 WHERE user_id='synthetic_user'");
  });

  await check('SELECT_only_logical_backup_restores_all_23_tables_without_overwriting_source', async () => {
    const before = await tableSnapshot(serverName), backup = path.join(taskDirectory, 'synthetic-only.sql');
    const file = fs.openSync(backup, 'wx');
    try { await command('mysqldump', ['--no-defaults', '--protocol=TCP', '--host=127.0.0.1', `--port=${port}`, '--user=backup_fixture', '--single-transaction', '--quick', '--skip-lock-tables', '--no-tablespaces', '--set-gtid-purged=OFF', '--column-statistics=0', '--skip-triggers', '--skip-add-drop-table', '--skip-add-locks', '--skip-disable-keys', '--hex-blob', '--skip-comments', serverName], { stdout: file, mysqlPassword: password }); }
    finally { fs.closeSync(file); }
    const dump = fs.readFileSync(backup); assert.ok(dump.length > 1000); assert.doesNotMatch(dump.toString(), /DROP TABLE|CREATE DATABASE|\bUSE\s/);
    await command('mysql', ['--no-defaults', '--protocol=TCP', '--host=127.0.0.1', `--port=${port}`, '--user=root', '--binary-mode', restoreName], { input: fs.createReadStream(backup), mysqlPassword: password });
    const restored = await tableSnapshot(restoreName);
    report.restoreDifferences = Object.keys(before).filter(name => JSON.stringify(before[name]) !== JSON.stringify(restored[name])).map(name => ({ name,
      rowsMatch: before[name].rows === restored[name]?.rows, rowsHashMatch: before[name].rowHash === restored[name]?.rowHash,
      ddlMatch: before[name].ddl === restored[name]?.ddl }));
    if (report.restoreDifferences.length) fs.writeFileSync(path.join(taskDirectory, 'synthetic-restore-comparison.json'), JSON.stringify({ before, restored }, null, 2));
    assert.deepEqual(restored, before); assert.deepEqual(await tableSnapshot(serverName), before);
    report.backup = { tables: 23, sourceUnchanged: true, restoreMatches: true, bytes: dump.length, sha256: hash(dump), syntheticOnly: true };
  });
  report.passed = true;
} catch (error) {
  // Test output never serializes SQL, configuration, credentials or request payloads.
  report.error = { code: typeof error.code === 'string' ? error.code : error.name, errno: Number.isInteger(error.errno) ? error.errno : null };
  report.error.testLines = [...String(error.stack || '').matchAll(/photo-candidate-schema-mysql-isolated\.mjs:(\d+):(\d+)/g)].map(match => `${match[1]}:${match[2]}`);
  process.exitCode = 1; console.error(`FAIL ${report.error.code}`);
} finally {
  for (const db of connections) if (db !== admin) await db.end().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit');
    try { await admin?.query('SHUTDOWN'); } catch (error) { if (error.code !== 'PROTOCOL_CONNECTION_LOST') report.shutdownUnconfirmed = true; }
    let timer; const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { server.kill(); resolve([null]); }, 15000); })]);
    clearTimeout(timer); report.stopped = result[0] === 0;
  }
  await admin?.end().catch(() => {});
  report.portClosed = await new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', error => { socket.destroy(); resolve(error.code === 'ECONNREFUSED'); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); }); });
  if (!report.stopped || !report.portClosed) { report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(taskDirectory, 'schema-acceptance.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report));
}
