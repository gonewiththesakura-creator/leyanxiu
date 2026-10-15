#!/bin/bash
set -Eeuo pipefail
umask 077
test "$EUID" -eq 0
service=leyanxiu-app-account
release=/opt/leyanxiu-app-account/releases/20260930-account
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=/var/backups/leyanxiu-app-account/$stamp
restore_db=lyx_app_restore_${stamp,,}
install -d -m 0700 "$backup"
systemctl is-active --quiet "$service"
trap 'systemctl start "$service"' EXIT
systemctl stop "$service"
# Service is stopped across BOTH snapshots so identity and ledger share a boundary.
runuser -u postgres -- pg_dump -Fc lyx_app_account > "$backup/ledger.dump"
tar -czf "$backup/state.tar.gz" -C /var/lib/leyanxiu-app-account .
install -m 0600 /etc/leyanxiu-app-account/server.env "$backup/server.env"
sha256sum "$backup/ledger.dump" "$backup/state.tar.gz" > "$backup/SHA256SUMS"
runuser -u postgres -- createdb "$restore_db"
runuser -u postgres -- pg_restore --exit-on-error --no-owner --no-privileges -d "$restore_db" < "$backup/ledger.dump"
mkdir "$backup/restored-state"
tar -xzf "$backup/state.tar.gz" -C "$backup/restored-state"
cd "$release"
node --input-type=module - "$backup/restored-state/data/identity.db" <<'JS'
import Database from 'better-sqlite3';
import assert from 'node:assert/strict';
const restored=new Database(process.argv[2],{readonly:true});
const original=new Database('/var/lib/leyanxiu-app-account/data/identity.db',{readonly:true});
assert.equal(restored.pragma('integrity_check',{simple:true}),'ok');
assert.equal(restored.prepare('SELECT payload FROM compliance_snapshot WHERE id=1').get().payload,original.prepare('SELECT payload FROM compliance_snapshot WHERE id=1').get().payload);
restored.close();original.close();
JS
# Compare canonical per-table JSON rows without printing customer data.
tables=$(runuser -u postgres -- psql -d lyx_app_account -Atc "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")
for table in $tables; do
  [[ $table =~ ^[a-z_]+$ ]]
  query="SELECT row_to_json(t)::text FROM $table t ORDER BY row_to_json(t)::text"
  left=$(runuser -u postgres -- psql -d lyx_app_account -Atc "$query" | sha256sum | cut -d' ' -f1)
  right=$(runuser -u postgres -- psql -d "$restore_db" -Atc "$query" | sha256sum | cut -d' ' -f1)
  test "$left" = "$right"
done
runuser -u postgres -- dropdb "$restore_db"
systemctl start "$service"
trap - EXIT
echo "APP_BACKUP_RESTORE_VERIFIED $backup"
# No automatic pruning; off-host encrypted backup is a separate release gate.
