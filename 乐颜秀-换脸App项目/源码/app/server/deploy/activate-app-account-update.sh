#!/bin/bash
# Explicitly authorized activation only; default prints a plan and performs no I/O.
# bash deploy/activate-app-account-update.sh --apply --sha256 REVIEWED_BUNDLE_SHA256
# Rollback stops the new process BEFORE restoring config/unit. It never restores
# stale business data over current state, so post-backup deletion stays effective.
set -Eeuo pipefail
umask 077
if [[ $# -eq 0 || ( $# -eq 1 && "$1" == --plan ) ]]; then
  printf 'APP_UPDATE_PLAN_ONLY\n'
  exit 0
fi
[[ $# -eq 3 && "$1" == --apply && "$2" == --sha256 && "$3" =~ ^[a-f0-9]{64}$ ]] || { printf 'APP_UPDATE_ARGUMENTS_INVALID\n'; exit 1; }
[[ "$EUID" -eq 0 ]] || { printf 'APP_UPDATE_ROOT_REQUIRED\n'; exit 1; }
expected=$3
service=leyanxiu-app-account
old=/opt/leyanxiu-app-account/releases/20260930-account
release=/opt/leyanxiu-app-account/releases/20261009-account
state=/var/lib/leyanxiu-app-account
config=/etc/leyanxiu-app-account/server.env
unit=/etc/systemd/system/leyanxiu-app-account.service
[[ -d "$release" && ! -L "$release" && -f "$config" && ! -L "$config" && -f "$unit" && ! -L "$unit" ]] || { printf 'APP_UPDATE_TARGET_INVALID\n'; exit 1; }
[[ "$(systemctl show -p WorkingDirectory --value "$service")" == "$old" ]] || { printf 'APP_UPDATE_OLD_RELEASE_REQUIRED\n'; exit 1; }
[[ -z "$(systemctl show -p DropInPaths --value "$service")" ]] || { printf 'APP_UPDATE_UNREVIEWED_UNIT_OVERRIDE\n'; exit 1; }
systemctl is-active --quiet "$service" || { printf 'APP_UPDATE_OLD_SERVICE_INACTIVE\n'; exit 1; }
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/var/backups/leyanxiu-app-account/update-20261009-$stamp
[[ ! -e "$backup" ]] || { printf 'APP_UPDATE_BACKUP_EXISTS\n'; exit 1; }
install -d -m 0700 "$backup"
exec 3>&1
exec >/dev/null 2>&1
# Never retain raw pg_restore/SQL/exception output, which can contain row values.
say() { printf '%s\n' "$1" >&3; printf '%s\n' "$1" >>"$backup/activation.log"; }
stopped=0
changed=0
restore_created=0
restore_db=lyx_app_restore_update_$(date -u +%Y%m%d%H%M%S)
cleanup_restore() {
  if [[ "$restore_created" == 1 ]]; then
    runuser -u postgres -- dropdb "$restore_db" && restore_created=0
  fi
}
wait_health() {
  for attempt in $(seq 1 30); do
    if curl --fail --silent --output /dev/null --max-time 3 http://127.0.0.1:3300/health; then return 0; fi
    sleep 1
  done
  return 1
}
rollback() {
  trap - ERR INT TERM HUP
  set +e
  cleanup_restore
  if [[ "$stopped" == 1 ]]; then
    if ! systemctl stop "$service" || [[ "$(systemctl show -p MainPID --value "$service")" != 0 ]]; then say APP_UPDATE_ROLLBACK_HALT_FAILED; exit 1; fi
    if [[ "$changed" == 1 ]]; then
      if ! (install -m 0600 "$backup/server.env" "${config}.rollback" && mv -T "${config}.rollback" "$config" &&
        install -m 0644 "$backup/service.unit" "${unit}.rollback" && mv -T "${unit}.rollback" "$unit" && systemctl daemon-reload); then
        say APP_UPDATE_ROLLBACK_RESTORE_FAILED; exit 1
      fi
      if [[ "$(systemctl show -p WorkingDirectory --value "$service")" != "$old" ]]; then say APP_UPDATE_ROLLBACK_RESTORE_FAILED; exit 1; fi
    fi
    systemctl start "$service"
    if wait_health; then say APP_UPDATE_ROLLED_BACK; else say APP_UPDATE_ROLLBACK_HEALTH_FAILED; fi
  fi
  say APP_UPDATE_ACTIVATION_FAILED
  exit 1
}
trap rollback ERR INT TERM HUP
cd "$release"
python3 - "$release" "$expected" <<'PY'
import sys,pathlib,hashlib,gzip,json,base64
root=pathlib.Path(sys.argv[1]);data=(root/'source-bundle.json.gz').read_bytes()
assert hashlib.sha256(data).hexdigest()==sys.argv[2]
payload=json.loads(gzip.decompress(data))
assert payload['release']==str(root) and payload['oldRelease']=='/opt/leyanxiu-app-account/releases/20260930-account'
for name,value in payload['files'].items():
 file=root/name
 assert file.resolve().is_relative_to(root.resolve()) and file.is_file() and not file.is_symlink()
 assert hashlib.sha256(file.read_bytes()).digest()==hashlib.sha256(base64.b64decode(value,validate=True)).digest()
PY
say APP_UPDATE_HASH_VERIFIED
node --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parse } from 'dotenv';
try {
 const stat=fs.lstatSync('/etc/leyanxiu-app-account/server.env');
 assert.equal(stat.mode&0o7777,0o600);assert.equal(stat.uid,0);assert.equal(stat.isSymbolicLink(),false);
 const env=parse(fs.readFileSync('/etc/leyanxiu-app-account/server.env'));
 assert.equal(env.DEPLOY_ENV,'staging');assert.equal(env.PAYMENT_MODE,'closed_test');assert.equal(env.CLOSED_TEST_REQUIRE_INVITE,'true');
 assert.equal(env.COMPLIANCE_BACKEND,'sqlite');assert.equal(env.BILLING_BACKEND,'postgres');
 assert.equal(env.BIND_HOST,'127.0.0.1');assert.equal(env.PORT,'3300');
 assert.equal(env.COMPLIANCE_SQLITE_FILE,'/var/lib/leyanxiu-app-account/data/identity.db');
 const database=new URL(env.BILLING_DATABASE_URL);assert.equal(database.pathname,'/lyx_app_account');
 assert.ok(['127.0.0.1','localhost','127.0.1.1'].includes(database.hostname));
 assert.equal(decodeURIComponent(database.username),'lyx_app_account');
 assert.ok(!env.SMS_PROVIDER);assert.ok(env.ACCOUNT_OTP_SECRET.length>=32);
} catch {console.error('APP_UPDATE_CONFIG_PREFLIGHT_FAILED');process.exitCode=1;}
JS
say APP_UPDATE_CONFIG_PREFLIGHT_PASSED
stopped=1
systemctl stop "$service"
[[ "$(systemctl show -p MainPID --value "$service")" == 0 ]]
say APP_UPDATE_SERVICE_STOPPED
install -m 0600 "$config" "$backup/server.env"
install -m 0600 "$unit" "$backup/service.unit"
runuser -u postgres -- pg_dump -Fc lyx_app_account >"$backup/ledger.dump"
tar -czf "$backup/state.tar.gz" -C "$state" .
sha256sum "$backup/ledger.dump" "$backup/state.tar.gz" "$backup/server.env" "$backup/service.unit" >"$backup/SHA256SUMS"
say APP_UPDATE_BACKUP_WRITTEN
runuser -u postgres -- createdb --owner=lyx_app_account "$restore_db"
restore_created=1
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges --role=lyx_app_account -d "$restore_db" <"$backup/ledger.dump"
install -d -m 0700 "$backup/restored-state"
tar -xzf "$backup/state.tar.gz" -C "$backup/restored-state" --no-same-owner
node --input-type=module - "$backup/restored-state/data/identity.db" <<'JS'
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
try {
 const restored=new Database(process.argv[2],{readonly:true,fileMustExist:true});
 const original=new Database('/var/lib/leyanxiu-app-account/data/identity.db',{readonly:true,fileMustExist:true});
 assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
 assert.equal(original.pragma('integrity_check',{simple:true}),'ok');
 assert.deepEqual(original.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name),['compliance_snapshot']);
 assert.equal(original.prepare('SELECT COUNT(*) AS n FROM compliance_snapshot').get().n,1);
 const payload=original.prepare('SELECT payload FROM compliance_snapshot WHERE id=1').get().payload;
 assert.equal(restored.prepare('SELECT payload FROM compliance_snapshot WHERE id=1').get().payload,payload);
 const snapshot=JSON.parse(payload);assert.equal(snapshot.schemaVersion,1);
 for(const name of ['orders','refunds','paymentEvents']) assert.equal(Object.keys(snapshot[name]||{}).length,0);
 assert.equal((snapshot.ledger||[]).length,0);
 restored.close();original.close();
} catch {console.error('APP_UPDATE_SQLITE_RESTORE_FAILED');process.exitCode=1;}
JS
say APP_UPDATE_SQLITE_RESTORE_VERIFIED
tables=$(runuser -u postgres -- psql -d lyx_app_account -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
restored_tables=$(runuser -u postgres -- psql -d "$restore_db" -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
[[ "$tables" == "$restored_tables" ]]
for table in $tables; do
  [[ "$table" =~ ^[a-z_]+$ ]]
  query="SELECT row_to_json(t)::text FROM $table t ORDER BY row_to_json(t)::text"
  original_hash=$(runuser -u postgres -- psql -d lyx_app_account -Atc "$query" | sha256sum | cut -d' ' -f1)
  restored_hash=$(runuser -u postgres -- psql -d "$restore_db" -Atc "$query" | sha256sum | cut -d' ' -f1)
  [[ "$original_hash" == "$restored_hash" ]]
done
say APP_UPDATE_CONSISTENT_RESTORE_VERIFIED
# Preview against the verified isolated copies, never apply cleanup to live data here.
node --input-type=module - "$backup" "$restore_db" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { parse } from 'dotenv';
try {
 const backup=process.argv[2];const database=process.argv[3];
 const env=parse(fs.readFileSync(backup+'/server.env'));
 for(const [key,value] of Object.entries(env)) process.env[key]=value.startsWith('/var/lib/leyanxiu-app-account/')?backup+'/restored-state/'+value.slice('/var/lib/leyanxiu-app-account/'.length):value;
 process.env.DOTENV_CONFIG_PATH='/dev/null';
 const url=new URL(env.BILLING_DATABASE_URL);url.pathname='/'+database;process.env.BILLING_DATABASE_URL=url.toString();
 const {connectBillingDatabase,BILLING_SCHEMA}=await import('./payments/database.js');
 const {store,flushComplianceStore}=await import('./compliance-store.js');
 const {createAccountRetention}=await import('./accounts/retention.js');
 const db=connectBillingDatabase();
 try {
  const knownTables=[...BILLING_SCHEMA.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+)/g)].map(match=>match[1]).sort();
  const actualTables=(await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row=>row.tablename);
  fs.writeSync(3,JSON.stringify({code:'APP_UPDATE_DRYRUN_COUNTS',knownTables:knownTables.length,actualTables:actualTables.length,unknownTables:actualTables.filter(name=>!knownTables.includes(name)).length})+'\n');
  assert.deepEqual(actualTables,knownTables);
  const rowCounts={};
  for(const name of knownTables) rowCounts[name]=Number((await db.query('SELECT COUNT(*) AS n FROM '+name)).rows[0].n);
  fs.writeSync(3,JSON.stringify({code:'APP_UPDATE_DRYRUN_COUNTS',billingAccounts:rowCounts.billing_accounts,billingOrders:rowCounts.billing_orders,phoneBindings:rowCounts.billing_phones,otpRows:rowCounts.billing_otp,deviceMappings:rowCounts.app_login_devices})+'\n');
  // This first activation is approved only for the observed empty account/ledger DB.
  // A catalog configuration row is harmless; all identity/financial rows must be zero.
  for(const [name,count] of Object.entries(rowCounts)) assert.ok(name==='billing_catalog'?count<=1:count===0);
  const report=await createAccountRetention({db,store,flush:flushComplianceStore}).run({apply:false});
  fs.writeSync(3,JSON.stringify({code:'APP_UPDATE_DRYRUN_COUNTS',otpRowsDeleted:report.otpRowsDeleted,otpValuesCleared:report.otpValuesCleared,deviceMappingsDeleted:report.deviceMappingsDeleted,sessionTokenHashesCleared:report.sessionTokenHashesCleared,sessionsDeleted:report.sessionsDeleted,invalidSessionTimes:report.invalidSessionTimes})+'\n');
  assert.equal(report.invalidSessionTimes,0);
  fs.writeFileSync(backup+'/retention-dry-run.json',JSON.stringify(report),{flag:'wx',mode:0o600});
  fs.writeFileSync(backup+'/runtime-approved.json',JSON.stringify({consistentBackupVerified:true}),{flag:'wx',mode:0o600});
 } finally {await db.close();}
} catch {console.error('APP_UPDATE_RETENTION_PREVIEW_FAILED');process.exitCode=1;}
JS
say APP_UPDATE_RETENTION_PREVIEW_READY
cleanup_restore
node deploy/update-app-account-runtime.mjs --input "$backup/runtime-approved.json"
changed=1
node deploy/update-app-account-runtime.mjs --input "$backup/runtime-approved.json" --apply
python3 - "$unit" "$old" "$release" <<'PY'
import sys,pathlib,os
unit=pathlib.Path(sys.argv[1]);text=unit.read_text()
old='WorkingDirectory='+sys.argv[2]
assert text.count(old)==1 and 'ExecStart=/usr/bin/node bootstrap.js' in text
replacement=text.replace(old,'WorkingDirectory='+sys.argv[3])
target=unit.with_name(unit.name+'.update')
fd=os.open(target,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o644)
with os.fdopen(fd,'w') as output: output.write(replacement);output.flush();os.fsync(output.fileno())
os.replace(target,unit)
PY
systemctl daemon-reload
systemctl start "$service"
wait_health
node --input-type=module - "$backup" <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parse} from 'dotenv';
import {ACCOUNT_RUNTIME_SETTINGS} from './deploy/update-app-account-runtime.mjs';
try {
 const before=parse(fs.readFileSync(process.argv[2]+'/server.env'));
 const current=parse(fs.readFileSync('/etc/leyanxiu-app-account/server.env'));
 assert.equal(current.ACCOUNT_OTP_SECRET,before.ACCOUNT_OTP_SECRET);
 for(const [key,value] of Object.entries(before)) if(!(key in ACCOUNT_RUNTIME_SETTINGS)) assert.equal(current[key],value);
 assert.equal(current.PAYMENT_MODE,'closed_test');assert.ok(!current.SMS_PROVIDER);
 const base='http://127.0.0.1:3300';
 const get=async route=>{const r=await fetch(base+route,{signal:AbortSignal.timeout(10000)});return {status:r.status,text:await r.text()};};
 assert.equal((await get('/health')).status,200);
 const ready=await get('/api/readiness');assert.equal(ready.status,200);const value=JSON.parse(ready.text);assert.equal(value.data?.publicLaunchAllowed??value.publicLaunchAllowed,false);
 const compliance=await get('/api/public/compliance');assert.equal(compliance.status,200);
 for(const route of ['/app/legal/terms.html','/app/legal/privacy.html']) {const r=await get(route);assert.equal(r.status,200);assert.match(r.text,/licui@yibohuaxia\.cn/);}
 const blocked=await fetch(base+'/api/orders',{method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:AbortSignal.timeout(10000)});
 assert.equal(blocked.status,403);assert.equal((await blocked.json()).code,'APP_ACCOUNT_ONLY');
 const media=await fetch(base+'/api/upload',{method:'POST',body:'',signal:AbortSignal.timeout(10000)});assert.equal(media.status,403);
 assert.ok(current.INTERNAL_CRON_TOKEN?.length>=32);
 const operations=await fetch(base+'/api/internal/account-operations',{headers:{'x-internal-token':current.INTERNAL_CRON_TOKEN},signal:AbortSignal.timeout(10000)});
 assert.equal(operations.status,200);
 const status=(await operations.json()).data;assert.equal(status.enabled,true);assert.equal(status.log.healthy,true);
 assert.ok(status.log.written>=1);assert.equal(status.retention.overdue,false);
 assert.ok(Number.isSafeInteger(status.retention.lastAppliedAt)&&status.retention.lastAppliedAt>0);
 assert.equal(status.retention.lastError,null);assert.equal(status.retention.lastNotificationError,null);
 assert.equal(status.retention.lastReport.mode,'apply');
} catch {console.error('APP_UPDATE_SMOKE_FAILED');process.exitCode=1;}
JS
say APP_UPDATE_LOOPBACK_CHECKS_PASSED
trap - ERR INT TERM HUP
say "APP_UPDATE_ACTIVATED $expected"
