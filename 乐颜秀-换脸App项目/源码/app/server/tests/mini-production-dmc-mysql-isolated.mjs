// Local-only acceptance of the exact DMC single statement. No remote host option.
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
import { productionSchemaPlan, productionDatabase, productionAppId } from '../scripts/generate-mini-production-schema.mjs';
import { productionDmcBindingPlan, renderProductionDmcBinding, dmcBindingPath } from '../scripts/generate-mini-production-dmc-binding.mjs';

const portable = 'REDACTED_LOCAL_USER_PATH/AppData/Local/Temp/lyx-photo-mysql-20261009-6f5d34b2';
if (process.argv.length === 2) { console.log('NO_OP: requires reviewed portable MySQL; starts only fresh localhost.'); process.exit(0); }
assert.equal(process.argv.length, 3); assert.equal(fs.realpathSync(process.argv[2]).toLowerCase(), fs.realpathSync(portable).toLowerCase());
assert.equal(createHash('md5').update(fs.readFileSync(path.join(portable, 'mysql-8.0.46-winx64.zip'))).digest('hex'), '003f527d5df61b663ff191038cd676bd');
const sql = fs.readFileSync(dmcBindingPath, 'utf8'); assert.equal(sql, renderProductionDmcBinding());
const dmc = productionDmcBindingPlan(), schema = productionSchemaPlan();
const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'lyx-production-dmc-'));
const datadir = path.join(directory, 'data'), basedir = path.join(portable, 'mysql-8.0.46-winx64');
const executable = path.join(basedir, 'bin/mysqld.exe'), password = randomBytes(24).toString('hex');
const safeEnv = Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP'].filter(key => process.env[key]).map(key => [key,process.env[key]]));
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
const report = {version:1,localOnly:true,cloudSqlExecuted:false,providerCalls:0,mysqlVersion:'8.0.46',directory,
  sqlSha256:createHash('sha256').update(sql).digest('hex'),checks:[],passed:false,stopped:false};
const connections = new Set(); let server, admin;
async function connect(database, initializing = false) {
  const db = await createConnection({host:'127.0.0.1',port,user:'root',password:initializing?'':password,database,connectTimeout:1000});
  connections.add(db); return db;
}
async function check(name, action) { await action(); report.checks.push({name,passed:true}); console.log('PASS '+name); }
async function insert(db = admin) { const [result] = await db.query(dmc.statement); return result.affectedRows; }
const target = name => `\`${productionDatabase}\`.\`${name}\``;
const emptyBinding = async () => assert.deepEqual((await admin.query(`SELECT * FROM ${target('vp_environment')}`))[0], []);
try {
  const init = spawn(executable,['--no-defaults',`--basedir=${basedir}`,`--datadir=${datadir}`,'--initialize-insecure',`--log-error=${path.join(directory,'initialize.log')}`],
    {windowsHide:true,env:safeEnv,stdio:'ignore'});
  const timer = setTimeout(() => init.kill(),120000); try {assert.equal((await once(init,'exit'))[0],0);} finally {clearTimeout(timer);}
  server = spawn(executable,['--no-defaults',`--basedir=${basedir}`,`--datadir=${datadir}`,'--bind-address=127.0.0.1',`--port=${port}`,
    '--mysqlx=OFF','--skip-log-bin','--performance-schema=OFF','--innodb-buffer-pool-size=64M','--innodb-default-row-format=DYNAMIC',
    '--transaction-isolation=READ-COMMITTED','--character-set-server=utf8mb4','--collation-server=utf8mb4_bin',`--log-error=${path.join(directory,'mysql.log')}`],
    {windowsHide:true,env:safeEnv,stdio:'ignore'});
  const deadline = Date.now()+45000;
  while(!admin && Date.now()<deadline) {
    assert.equal(server.exitCode,null);
    try {admin=await connect(undefined,true);} catch(error) {if(!['ECONNREFUSED','ECONNRESET','ETIMEDOUT'].includes(error.code))throw error; await delay(200);}
  }
  assert.ok(admin); const [[actual]] = await admin.query('SELECT @@version version,@@datadir datadir,@@port port,@@bind_address host');
  assert.equal(actual.version,'8.0.46'); assert.equal(actual.port,port); assert.equal(actual.host,'127.0.0.1');
  assert.equal(path.resolve(actual.datadir).toLowerCase(),datadir.toLowerCase());
  await admin.query(`ALTER USER 'root'@'localhost' IDENTIFIED BY ${admin.escape(password)}`);
  for(const statement of schema.ddl) await admin.query(statement);
  await admin.query(`USE \`${productionDatabase}\``);

  await check('exact_single_statement_preflight_and_session_guards',async()=>{
    const [[before]] = await admin.query(dmc.preflight);
    assert.equal(before.selected_database,productionDatabase);assert.equal(before.autocommit,1);
    assert.equal(before.transaction_isolation,'READ-COMMITTED');assert.equal(before.ready_to_bind,1);
    const wrong = await connect('information_schema'); assert.equal(await insert(wrong),0); await emptyBinding();
    const noCommit = await connect(productionDatabase); await noCommit.query('SET autocommit=0');
    assert.equal(await insert(noCommit),0);await noCommit.query('ROLLBACK');await emptyBinding();
    for(const isolation of ['READ UNCOMMITTED']) {
      const unsuitable=await connect(productionDatabase);await unsuitable.query('SET SESSION TRANSACTION ISOLATION LEVEL '+isolation);
      assert.equal(await insert(unsuitable),0);await emptyBinding();
    }
  });

  await check('nonempty_business_binding_or_changed_structure_never_bind_or_replace',async()=>{
    await admin.query(`INSERT INTO ${target('vp_audit')} VALUES ('fixture','none','fixture','ref','{}',0)`);
    assert.equal(await insert(),0);await admin.query(`DELETE FROM ${target('vp_audit')}`);
    await admin.query(`INSERT INTO ${target('mini_photo_effects')} VALUES ('fixture','v1','fixture','fixture','fixture','{}',0,'fixture',0)`);
    assert.equal(await insert(),0);await admin.query(`DELETE FROM ${target('mini_photo_effects')}`);
    for(const [appId,env] of [[productionAppId,1],['wx0000000000000000',0],[productionAppId,0]]) {
      await admin.query(`INSERT INTO ${target('vp_environment')} VALUES (1,?,?)`,[appId,env]);
      assert.equal(await insert(),0);assert.deepEqual((await admin.query(`SELECT * FROM ${target('vp_environment')}`))[0],[{id:1,app_id:appId,env}]);
      await admin.query(`DELETE FROM ${target('vp_environment')}`);
    }
    await admin.query(`CREATE TABLE ${target('unexpected_fixture')}(id INTEGER)`);assert.equal(await insert(),0);
    await admin.query(`DROP TABLE ${target('unexpected_fixture')}`);
    const [[constraint]] = await admin.query("SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=? AND TABLE_NAME='vp_buckets' AND CONSTRAINT_TYPE='CHECK' LIMIT 1",[productionDatabase]);
    await admin.query(`ALTER TABLE ${target('vp_buckets')} ALTER CHECK \`${constraint.CONSTRAINT_NAME}\` NOT ENFORCED`);
    assert.equal(await insert(),0);
    await admin.query(`ALTER TABLE ${target('vp_buckets')} ALTER CHECK \`${constraint.CONSTRAINT_NAME}\` ENFORCED`);
    await emptyBinding();
  });

  await check('RC_concurrent_admin_write_counterexample_requires_external_maintenance_isolation',async()=>{
    const blocker=await connect(productionDatabase),binder=await connect(productionDatabase),writer=await connect(productionDatabase);
    // Test instrumentation only: RR gap lock holds the target insert long enough
    // to observe the true RC source-read behavior. The deployed statement is exact.
    await blocker.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await blocker.query('START TRANSACTION'); await blocker.query('SELECT id FROM vp_environment FOR UPDATE');
    await binder.query('SET SESSION innodb_lock_wait_timeout=15');await writer.query('SET SESSION innodb_lock_wait_timeout=1');
    const [[identity]]=await binder.query('SELECT CONNECTION_ID() AS id,@@autocommit AS autocommit,@@transaction_isolation AS isolation');
    assert.equal(identity.autocommit,1);assert.equal(identity.isolation,'READ-COMMITTED');
    let settled=false;const attempt=insert(binder).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
    try {
      let waiting=false;const until=Date.now()+7000;
      while(!waiting && !settled && Date.now()<until) {
        const [rows]=await admin.query('SELECT trx_state FROM information_schema.INNODB_TRX WHERE trx_mysql_thread_id=?',[identity.id]);
        waiting=rows.some(row=>row.trx_state==='LOCK WAIT');if(!waiting)await delay(100);
      }
      assert.equal(waiting,true,'exact binding must wait at its target insert');
      assert.equal((await writer.query("INSERT INTO vp_audit VALUES ('concurrent_fixture','none','fixture','ref','{}',0)"))[0].affectedRows,1);
      await blocker.query('ROLLBACK');
      const result=await attempt;if(result.error)throw result.error;assert.equal(result.value,1);
      const fresh=await connect(productionDatabase);
      assert.deepEqual((await fresh.query('SELECT * FROM vp_environment'))[0],[{id:1,app_id:productionAppId,env:0}]);
      assert.equal((await fresh.query(dmc.postflight.at(-1)))[0][0].production_initialization_verified,0);
      assert.equal(await insert(fresh),0); // Replaying cannot duplicate/replace the committed binding.
      report.concurrency={isolation:'READ-COMMITTED',autocommit:1,bindingWaitObserved:true,otherAdminWriteBlocked:false,
        insertedRows:1,postflightDetectedConcurrentWrite:true,externalQuiescenceRequired:true};
    } finally {await blocker.query('ROLLBACK').catch(()=>{});await attempt;}
  });
  await check('quiescent_new_database_single_statement_autocommits_once_and_fresh_connection_confirms_exact_env0',async()=>{
    // Reset only this fresh synthetic localhost fixture after the explicit counterexample.
    await admin.query(`DELETE FROM ${target('vp_audit')}`);await admin.query(`DELETE FROM ${target('vp_environment')}`);
    const fresh=await connect(productionDatabase);assert.equal((await fresh.query(dmc.preflight))[0][0].ready_to_bind,1);
    assert.equal(await insert(fresh),1);
    const verify=await connect(productionDatabase);
    assert.deepEqual((await verify.query('SELECT * FROM vp_environment'))[0],[{id:1,app_id:productionAppId,env:0}]);
    assert.equal((await verify.query(dmc.postflight.at(-1)))[0][0].production_initialization_verified,1);
    assert.equal(await insert(verify),0);
    assert.equal((await verify.query(dmc.postflight.at(-1)))[0][0].production_initialization_verified,1);
  });
  report.passed=true;
} catch(error) {
  report.error={code:typeof error.code==='string'?error.code:error.name,errno:Number.isInteger(error.errno)?error.errno:null,
    testLines:[...String(error.stack||'').matchAll(/mini-production-dmc-mysql-isolated\.mjs:(\d+):(\d+)/g)].map(m=>`${m[1]}:${m[2]}`)};
  console.error('FAIL '+report.error.code);process.exitCode=1;
} finally {
  for(const connection of connections)await connection.query('ROLLBACK').catch(()=>{});
  for(const connection of connections)if(connection!==admin)await connection.end().catch(()=>{});
  if(server && server.exitCode===null) {
    const exited=once(server,'exit');try{await admin?.query('SHUTDOWN');}catch{}
    let timer;const result=await Promise.race([exited,new Promise(resolve=>{timer=setTimeout(()=>{server.kill();resolve([null]);},15000);})]);
    clearTimeout(timer);report.stopped=result[0]===0;
  }
  await admin?.end().catch(()=>{});
  report.portClosed=await new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port});
    socket.once('connect',()=>{socket.destroy();resolve(false);});socket.once('error',error=>{socket.destroy();resolve(error.code==='ECONNREFUSED');});
    socket.setTimeout(1000,()=>{socket.destroy();resolve(false);});});
  if(!report.stopped||!report.portClosed){report.passed=false;process.exitCode=1;}
  fs.writeFileSync(path.join(directory,'acceptance.json'),JSON.stringify(report,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(report));
}
