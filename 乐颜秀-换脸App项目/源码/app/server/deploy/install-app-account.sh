#!/bin/bash
set -Eeuo pipefail
umask 077
# Dedicated loopback-only App test service on the user-confirmed Alibaba ECS.
release=/opt/leyanxiu-app-account/releases/20260930-account
state=/var/lib/leyanxiu-app-account
config=/etc/leyanxiu-app-account
test -f "$release/package.json"
test -f "$release/web/effects/art-styles.webp"
test ! -e "$config/server.env"
test ! -e /etc/systemd/system/leyanxiu-app-account.service
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=l
apt-get update -qq
apt-get install -y --no-install-recommends nodejs npm postgresql python3 build-essential ca-certificates
id leyanxiu-app >/dev/null 2>&1 || useradd --system --home-dir "$state" --shell /usr/sbin/nologin leyanxiu-app
install -d -m 0700 "$config" /var/backups/leyanxiu-app-account
install -d -o leyanxiu-app -g leyanxiu-app -m 0750 "$state" "$state/data" "$state/objects" "$state/reports" "$state/work"
cd "$release"
npm ci --omit=dev --no-audit --no-fund --registry=https://registry.npmjs.org
chgrp -R leyanxiu-app "$release"
chmod -R g+rX "$release"
python3 - <<'PY'
import os,secrets,json,subprocess
root='/var/lib/leyanxiu-app-account'
password=secrets.token_hex(32)
# Generated credentials stay on this ECS; never printed or passed as argv.
sql="CREATE ROLE lyx_app_account LOGIN PASSWORD '%s';\nCREATE DATABASE lyx_app_account OWNER lyx_app_account;\n"%password
subprocess.run(['runuser','-u','postgres','--','psql','-v','ON_ERROR_STOP=1'],input=sql,text=True,check=True,stdout=subprocess.DEVNULL)
env=dict(DEPLOY_ENV='staging',RELEASE_CHANNEL='android-app',APP_PACKAGE_NAME='com.yibohuaxia.leyanxiu',AUTH_MODE='device_key',APP_LOGIN_ENABLED='true',BILLING_BACKEND='postgres',BILLING_DATABASE_URL='postgresql://lyx_app_account:'+password+'@127.0.0.1:5432/lyx_app_account',COMPLIANCE_BACKEND='sqlite',COMPLIANCE_SQLITE_FILE=root+'/data/identity.db',COMPLIANCE_STORE_FILE=root+'/data/compliance.json',DATA_DIR=root+'/data',ADMIN_DATA_DIR=root+'/data',ADMIN_WORKFLOW_DATA_DIR=root+'/data',ADMIN_STORE_FILE=root+'/data/admin-console.json',ADMIN_WORKFLOW_STORE_FILE=root+'/data/admin-workflows.json',ADMIN_ASSET_DIR=root+'/data/admin-assets',ADMIN_SNAPSHOT_BACKEND='file',TASKS_BACKEND='file',TASKS_FILE=root+'/data/tasks.json',OBJECT_STORAGE_BACKEND='file',PRIVATE_OBJECT_DIR=root+'/objects',OBJECT_INDEX_FILE=root+'/data/object-index.json',CAPABILITY_EVIDENCE_DIR=root+'/reports',METRICS_BACKEND='file',METRICS_LOG_PATH=root+'/data/metrics.ndjson',REPAIR_WORK_DIR=root+'/work',PROVIDER='mock',ALLOW_MOCK_PROVIDER='true',PAYMENT_MODE='closed_test',PAYMENT_RECONCILE_ENABLED='false',PAYMENT_BILL_RECONCILE_ENABLED='false',XPAY_ENABLED='false',XPAY_MODE='closed',WECHAT_LOGIN_APPROVED='false',CLOSED_TEST_MODE='true',CLOSED_TEST_REQUIRE_INVITE='true',CLOSED_TEST_CREDITS='0',CLOSED_TEST_MAX_USERS='20',CLOSED_TEST_DAILY_GENERATION_LIMIT='1',SMS_DAILY_LIMIT='20',BIND_HOST='127.0.0.1',PORT='3300',PUBLIC_BASE_URL='https://REDACTED_COMPANY_INFRASTRUCTURE',CORS_ORIGIN='https://localhost,https://REDACTED_COMPANY_INFRASTRUCTURE',TRUST_PROXY_HEADERS='false',ADMIN_COOKIE_SECURE='true',ADMIN_REQUIRE_DUAL_APPROVAL='true',AI_MARKING_REQUIRED='true',CONTENT_SAFETY_MODE='local_rules')
env['METRICS_SNAPSHOT_PATH']=root+'/data/metrics-snapshot.json'
for k in ['AUTH_SESSION_SECRET','OBJECT_SIGNING_SECRET','ADMIN_SESSION_SECRET','REPORT_DATA_ENCRYPTION_KEY','ACCOUNT_OTP_SECRET','INTERNAL_CRON_TOKEN','CLOSED_TEST_INVITE_SECRET']:env[k]=secrets.token_hex(48)
p='/etc/leyanxiu-app-account/server.env'
fd=os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:
 for k,v in env.items():f.write(k+'='+v+'\n')
PY
set -a
source "$config/server.env"
set +a
DOTENV_CONFIG_PATH=/dev/null node scripts/app-billing-migrate.mjs --apply
# Only this service is created. Other applications and public ingress stay as-is.
install -m 0644 deploy/leyanxiu-app-account.service /etc/systemd/system/leyanxiu-app-account.service
systemctl daemon-reload
systemctl enable --now leyanxiu-app-account
for attempt in $(seq 1 30); do
  if node -e "fetch('http://127.0.0.1:3300/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then
    echo APP_ACCOUNT_LOOPBACK_HEALTHY
    exit 0
  fi
  sleep 2
done
echo APP_ACCOUNT_HEALTH_FAILED >&2
exit 1
