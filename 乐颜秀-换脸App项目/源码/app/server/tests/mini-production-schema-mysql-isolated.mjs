// Explicit local acceptance; no supplied host, credentials, .env, or cloud SQL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createConnection } from 'mysql2/promise';
import { productionSchemaPlan, renderProductionSchema, productionSchemaPath, productionDatabase, productionAppId } from '../scripts/generate-mini-production-schema.mjs';

const portable = 'REDACTED_LOCAL_USER_PATH/AppData/Local/Temp/lyx-photo-mysql-20261009-6f5d34b2';
if (process.argv.length === 2) { console.log('NO_OP: requires reviewed portable MySQL directory; only a fresh localhost instance.'); process.exit(0); }
assert.equal(process.argv.length, 3); assert.equal(fs.realpathSync(process.argv[2]).toLowerCase(), fs.realpathSync(portable).toLowerCase());
assert.equal(createHash('md5').update(fs.readFileSync(path.join(portable, 'mysql-8.0.46-winx64.zip'))).digest('hex'), '003f527d5df61b663ff191038cd676bd');
const sql = fs.readFileSync(productionSchemaPath, 'utf8'); assert.equal(sql, renderProductionSchema());
const plan = productionSchemaPlan();
const taskDirectory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lyx-production-schema-'));
const datadir = path.join(taskDirectory, 'data'), basedir = path.join(portable, 'mysql-8.0.46-winx64');
const mysql = path.join(basedir, 'bin/mysqld.exe'), password = randomBytes(24).toString('hex');
const safeEnv = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'].filter(k => process.env[k]).map(k => [k, process.env[k]]));
const listener = net.createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
const port = listener.address().port; await new Promise(resolve => listener.close(resolve));
const report = { version: 1, localOnly: true, cloudSqlExecuted: false, providerCalls: 0, mysqlVersion: '8.0.46', taskDirectory,
  sqlSha256: createHash('sha256').update(sql).digest('hex'), checks: [], passed: false, stopped: false };
let server, admin; const connections = new Set();
async function connect(database, initializing = false) {
  const db = await createConnection({ host: '127.0.0.1', port, user: 'root', password: initializing ? '' : password, database, connectTimeout: 1000 });
  connections.add(db); return db;
}
async function run(statements, db = admin) { let result; for (const statement of statements) [result] = await db.query(statement); return result; }
async function check(name, callback) { await callback(); report.checks.push({ name, passed: true }); console.log(`PASS ${name}`); }
async function attemptBinding() { try { return Number((await run(plan.bind))[0].inserted_binding_rows); } finally { await admin.query('ROLLBACK'); } }
const target = table => `\`${productionDatabase}\`.\`${table}\``;

try {
  const init = spawn(mysql, ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--initialize-insecure', `--log-error=${path.join(taskDirectory, 'initialize.log')}`], { windowsHide: true, env: safeEnv, stdio: 'ignore' });
  const initTimer = setTimeout(() => init.kill(), 120000);
  try { assert.equal((await once(init, 'exit'))[0], 0); } finally { clearTimeout(initTimer); }
  server = spawn(mysql, ['--no-defaults', `--basedir=${basedir}`, `--datadir=${datadir}`, '--bind-address=127.0.0.1', `--port=${port}`,
    '--mysqlx=OFF', '--skip-log-bin', '--performance-schema=OFF', '--innodb-buffer-pool-size=64M', '--innodb-default-row-format=DYNAMIC',
    '--character-set-server=utf8mb4', '--collation-server=utf8mb4_bin', `--log-error=${path.join(taskDirectory, 'mysql.log')}`],
  { windowsHide: true, env: safeEnv, stdio: 'ignore' });
  const deadline = Date.now() + 45000;
  while (!admin && Date.now() < deadline) {
    assert.equal(server.exitCode, null);
    try { admin = await connect(undefined, true); } catch (e) { if (!['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(e.code)) throw e; await delay(200); }
  }
  assert.ok(admin); const [[identity]] = await admin.query('SELECT @@version AS version,@@datadir AS datadir,@@port AS port,@@bind_address AS host');
  assert.equal(identity.version, '8.0.46'); assert.equal(identity.port, port); assert.equal(identity.host, '127.0.0.1');
  assert.equal(path.resolve(identity.datadir).toLowerCase(), datadir.toLowerCase());
  await admin.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${admin.escape(password)}`);
  await admin.query('CREATE DATABASE leyanxiu_xpay_sandbox CHARACTER SET utf8mb4 COLLATE utf8mb4_bin');
  await admin.query('CREATE TABLE leyanxiu_xpay_sandbox.guard_fixture (id INTEGER PRIMARY KEY,value VARCHAR(40))');
  await admin.query("INSERT INTO leyanxiu_xpay_sandbox.guard_fixture VALUES (1,'synthetic_existing_data')");

  await check('fresh_preflight_and_all_23_canonical_tables_in_new_database', async () => {
    assert.equal((await run(plan.preflight.slice(0, 2)))[0].preflight, 'READY_NEW_DATABASE');
    await admin.query('USE leyanxiu_xpay_sandbox'); // Qualified DDL must ignore current schema.
    await run(plan.ddl); assert.equal((await run(plan.beforeBinding))[0].ready_to_bind, 1);
    const [tables] = await admin.query('SELECT TABLE_NAME,ENGINE,TABLE_COLLATION,ROW_FORMAT FROM information_schema.TABLES WHERE TABLE_SCHEMA=?', [productionDatabase]);
    assert.equal(tables.length, 23); assert.ok(tables.every(t => t.ENGINE === 'InnoDB' && t.TABLE_COLLATION === 'utf8mb4_bin' && t.ROW_FORMAT === 'Dynamic'));
    assert.deepEqual(tables.map(t => t.TABLE_NAME).sort(), plan.tables.map(t => t.name).sort());
    const [[constraints]] = await admin.query("SELECT COUNT(*) AS n FROM information_schema.TABLE_CONSTRAINTS WHERE TABLE_SCHEMA=? AND CONSTRAINT_TYPE='CHECK' AND ENFORCED='YES'", [productionDatabase]);
    assert.equal(constraints.n, 36);
    const [foreignKeys] = await admin.query('SELECT REFERENCED_TABLE_SCHEMA FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=? AND REFERENCED_TABLE_NAME IS NOT NULL', [productionDatabase]);
    assert.equal(foreignKeys.length, 12); assert.ok(foreignKeys.every(f => f.REFERENCED_TABLE_SCHEMA === productionDatabase));
    report.schema = { tables: 23, enforcedChecks: 36, foreignKeys: 12, businessTables: 21 };
  });

  await check('replay_and_partial_schema_fail_instead_of_silent_IF_NOT_EXISTS', async () => {
    assert.equal((await run(plan.preflight.slice(0, 2)))[0].preflight, 'STOP_DATABASE_ALREADY_EXISTS');
    await assert.rejects(admin.query(plan.ddl[0]), e => e.errno === 1007);
    await assert.rejects(admin.query(plan.ddl[1]), e => e.errno === 1050);
    await assert.rejects(admin.query(plan.ddl.find(s => s.startsWith('CREATE INDEX'))), e => e.errno === 1061);
    await admin.query(`RENAME TABLE ${target('mini_photo_generation_cleanup')} TO ${target('partial_fixture')}`);
    await assert.rejects(attemptBinding(), e => e.errno === 1146);
    await admin.query(`RENAME TABLE ${target('partial_fixture')} TO ${target('mini_photo_generation_cleanup')}`);
    assert.deepEqual((await admin.query(`SELECT * FROM ${target('vp_environment')}`))[0], []);
  });

  await check('unrelated_business_rows_schema_version_and_extra_objects_block_binding', async () => {
    await admin.query(`INSERT INTO ${target('vp_audit')} VALUES ('fixture','nobody','fixture','ref','{}',0)`);
    assert.equal(await attemptBinding(), 0); await admin.query(`DELETE FROM ${target('vp_audit')}`);
    await admin.query(`INSERT INTO ${target('mini_photo_effects')} VALUES ('fixture','v1','fixture','fixture','fixture','{}',0,'fixture',0)`);
    assert.equal(await attemptBinding(), 0); await admin.query(`DELETE FROM ${target('mini_photo_effects')}`);
    await admin.query(`INSERT INTO ${target('vp_schema')} VALUES (2)`); assert.equal(await attemptBinding(), 0);
    await admin.query(`DELETE FROM ${target('vp_schema')} WHERE version=2`);
    await admin.query(`CREATE TABLE ${target('unexpected_fixture')}(id INTEGER)`); assert.equal(await attemptBinding(), 0);
    await admin.query(`DROP TABLE ${target('unexpected_fixture')}`);
    assert.equal((await run(plan.beforeBinding))[0].ready_to_bind, 1);
  });

  await check('existing_sandbox_or_foreign_app_binding_is_never_replaced', async () => {
    for (const [appId, env] of [[productionAppId, 1], ['wx0000000000000000', 0], [productionAppId, 0]]) {
      await admin.query(`INSERT INTO ${target('vp_environment')} VALUES (1,?,?)`, [appId, env]);
      assert.equal(await attemptBinding(), 0);
      const [[row]] = await admin.query(`SELECT * FROM ${target('vp_environment')}`); assert.deepEqual(row, { id: 1, app_id: appId, env });
      await admin.query(`DELETE FROM ${target('vp_environment')}`);
    }
    assert.equal(await attemptBinding(), 1); // Explicit rollback leaves no binding.
    assert.deepEqual((await admin.query(`SELECT * FROM ${target('vp_environment')}`))[0], []);
  });

  await check('binding_uses_locking_reads_until_explicit_commit_then_fresh_connection_verifies_env0', async () => {
    assert.equal((await run(plan.bind))[0].inserted_binding_rows, 1);
    assert.equal((await run(plan.postflight))[0].production_initialization_verified, 1);
    const other = await connect(productionDatabase); await other.query('SET SESSION innodb_lock_wait_timeout=1');
    await assert.rejects(other.query("INSERT INTO vp_audit VALUES ('concurrent_fixture','nobody','fixture','ref','{}',0)"), e => e.errno === 1205);
    await admin.query('COMMIT');
    assert.equal((await run(plan.postflight, other))[0].production_initialization_verified, 1);
    assert.deepEqual((await other.query('SELECT * FROM vp_environment'))[0], [{ id: 1, app_id: productionAppId, env: 0 }]);
    assert.equal(await attemptBinding(), 0);
  });

  await check('existing_synthetic_sandbox_unchanged_and_DDL_is_not_transactionally_reversible', async () => {
    assert.deepEqual((await admin.query('SELECT * FROM leyanxiu_xpay_sandbox.guard_fixture'))[0], [{ id: 1, value: 'synthetic_existing_data' }]);
    const [[count]] = await admin.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA='leyanxiu_xpay_sandbox'"); assert.equal(count.n, 1);
    await admin.query('START TRANSACTION'); await admin.query('CREATE TABLE leyanxiu_xpay_sandbox.ddl_commit_fixture(id INTEGER)'); await admin.query('ROLLBACK');
    assert.equal((await admin.query("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA='leyanxiu_xpay_sandbox' AND TABLE_NAME='ddl_commit_fixture'"))[0][0].n, 1);
    // All mutations in this test, including DROP above, were fresh localhost fixtures only.
  });
  report.passed = true;
} catch (error) {
  report.error = { code: typeof error.code === 'string' ? error.code : error.name, errno: Number.isInteger(error.errno) ? error.errno : null,
    testLines: [...String(error.stack || '').matchAll(/mini-production-schema-mysql-isolated\.mjs:(\d+):(\d+)/g)].map(m => `${m[1]}:${m[2]}`) };
  console.error(`FAIL ${report.error.code}`); process.exitCode = 1;
} finally {
  await admin?.query('ROLLBACK').catch(() => {});
  for (const db of connections) if (db !== admin) await db.end().catch(() => {});
  if (server && server.exitCode === null) {
    const exited = once(server, 'exit'); try { await admin?.query('SHUTDOWN'); } catch {}
    let timer; const result = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => { server.kill(); resolve([null]); }, 15000); })]);
    clearTimeout(timer); report.stopped = result[0] === 0;
  }
  await admin?.end().catch(() => {});
  report.portClosed = await new Promise(resolve => { const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); }); socket.once('error', e => { socket.destroy(); resolve(e.code === 'ECONNREFUSED'); });
    socket.setTimeout(1000, () => { socket.destroy(); resolve(false); }); });
  if (!report.stopped || !report.portClosed) { report.passed = false; process.exitCode = 1; }
  fs.writeFileSync(path.join(taskDirectory, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(report));
}
