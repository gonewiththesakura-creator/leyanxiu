#!/bin/bash
# Enables the reviewed private SMS configuration; never sends a message.
set -Eeuo pipefail
umask 077
if [[ $# -eq 0 ]]; then printf 'APP_SMS_PLAN_ONLY\n'; exit 0; fi
[[ $# -eq 1 && "$1" == --apply && "$EUID" == 0 ]] || { printf 'APP_SMS_ARGUMENTS_INVALID\n'; exit 1; }
cd /opt/leyanxiu-app-account/releases/20261009-account
service=leyanxiu-app-account
config=/etc/leyanxiu-app-account/server.env
backup=/etc/leyanxiu-app-account/server.env.pre-sms-$(date -u +%Y%m%dT%H%M%SZ)
exec 3>&1
exec >/dev/null 2>&1
changed=0
say() { printf '%s\n' "$1" >&3; }
wait_health() {
  for attempt in $(seq 1 30); do
    if curl --fail --silent --output /dev/null --max-time 2 http://127.0.0.1:3300/health; then return 0; fi
    sleep 1
  done
  return 1
}
rollback() {
  trap - ERR INT TERM HUP
  set +e
  if [[ "$changed" == 1 ]]; then
    if ! systemctl stop "$service" || [[ "$(systemctl show -p MainPID --value "$service")" != 0 ]]; then say APP_SMS_ROLLBACK_HALT_FAILED; exit 1; fi
    if ! (install -m 0600 "$backup" "${config}.sms-rollback" && mv -T "${config}.sms-rollback" "$config"); then say APP_SMS_ROLLBACK_CONFIG_FAILED; exit 1; fi
    systemctl start "$service"
    if wait_health; then say APP_SMS_ROLLED_BACK; else say APP_SMS_ROLLBACK_HEALTH_FAILED; fi
  fi
  say APP_SMS_ACTIVATION_FAILED
  exit 1
}
trap rollback ERR INT TERM HUP
[[ "$(systemctl show -p WorkingDirectory --value "$service")" == /opt/leyanxiu-app-account/releases/20261009-account ]]
systemctl is-active --quiet "$service"
node --input-type=module <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {parse} from 'dotenv';
try {
 const env=parse(fs.readFileSync('/etc/leyanxiu-app-account/server.env'));
 assert.equal(env.APP_ACCOUNT_ONLY,'true');assert.equal(env.APP_ACCOUNT_OPERATIONS_ENABLED,'true');
 assert.equal(env.PAYMENT_MODE,'closed_test');assert.equal(env.CLOSED_TEST_REQUIRE_INVITE,'true');assert.ok(!env.SMS_PROVIDER);
 const r=await fetch('http://127.0.0.1:3300/api/internal/account-operations',{headers:{'x-internal-token':env.INTERNAL_CRON_TOKEN},signal:AbortSignal.timeout(5000)});
 assert.equal(r.status,200);const status=(await r.json()).data;
 assert.equal(status.enabled,true);assert.equal(status.log.healthy,true);assert.equal(status.retention.lastReport.mode,'apply');
 assert.ok(status.retention.lastAppliedAt);assert.equal(status.retention.overdue,false);assert.equal(status.retention.lastError,null);assert.equal(status.retention.lastNotificationError,null);
} catch {process.exitCode=1;}
JS
node deploy/update-app-sms-config.mjs --input /etc/leyanxiu-app-account/incoming-sms/app-sms.json
say APP_SMS_PREFLIGHT_PASSED
[[ ! -e "$backup" ]]
install -m 0600 "$config" "$backup"
changed=1
node deploy/update-app-sms-config.mjs --input /etc/leyanxiu-app-account/incoming-sms/app-sms.json --apply
node --input-type=module - "$backup" <<'JS'
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {parse} from 'dotenv';
try {
 const before=parse(fs.readFileSync(process.argv[2]));const after=parse(fs.readFileSync('/etc/leyanxiu-app-account/server.env'));
 const allowed=new Set(['SMS_PROVIDER','SMS_ACCESS_KEY_ID','SMS_ACCESS_KEY_SECRET','SMS_SIGN_NAME','SMS_TEMPLATE_CODE','SMS_DAILY_LIMIT','PRIVACY_POLICY_URL','USER_AGREEMENT_URL']);
 for(const [key,value] of Object.entries(before)) if(!allowed.has(key)) assert.equal(after[key],value);
 assert.equal(after.ACCOUNT_OTP_SECRET,before.ACCOUNT_OTP_SECRET);assert.equal(after.SMS_PROVIDER,'aliyun');assert.equal(after.SMS_DAILY_LIMIT,'20');
 Object.assign(process.env,after);const {smsReadiness}=await import('./payments/sms.js');assert.equal(smsReadiness(),true);
} catch {process.exitCode=1;}
JS
say APP_SMS_CONFIG_APPLIED
systemctl restart "$service"
wait_health
node --input-type=module <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';import {parse} from 'dotenv';
try {
 const env=parse(fs.readFileSync('/etc/leyanxiu-app-account/server.env'));
 const response=await fetch('http://127.0.0.1:3300/api/internal/account-operations',{headers:{'x-internal-token':env.INTERNAL_CRON_TOKEN},signal:AbortSignal.timeout(5000)});
 assert.equal(response.status,200);const status=(await response.json()).data;
 assert.equal(status.enabled,true);assert.equal(status.log.healthy,true);assert.ok(status.retention.lastAppliedAt);assert.equal(status.retention.overdue,false);
 assert.equal(status.retention.lastError,null);assert.equal(status.retention.lastNotificationError,null);
} catch {process.exitCode=1;}
JS
trap - ERR INT TERM HUP
say APP_SMS_ACTIVATED_WITHOUT_SENDING
