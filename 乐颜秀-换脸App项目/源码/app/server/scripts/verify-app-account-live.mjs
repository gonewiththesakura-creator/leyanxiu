// Review this source before explicit `run`. Default `plan` performs no file reads,
// credential import or network requests. This verifier is not in the release bundle.
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const INSTANCE = 'REDACTED_COMPANY_CLOUD_INSTANCE';
const RELEASE = '/opt/leyanxiu-app-account/releases/20261009-account';
const PUBLIC_BASE = 'https://REDACTED_COMPANY_INFRASTRUCTURE';
const CONSENT_VERSION = '2026-10-09-account';
const CONTACT = 'REDACTED_COMPANY_CONTACT_EMAIL';
const INTERNAL_PATH = '/api/internal/account-operations';
const RESULT_KEYS = Object.freeze([
  'newReleaseActive', 'accountOnlyEnabled', 'operationsEnabled', 'closedTestOnly',
  'otpSecretComparisonAvailable', 'otpSecretContinuityVerified',
  'operationHealthBefore', 'recentApplyBefore', 'operationHealthAfter', 'recentApplyAfter',
  'auditAdvanced', 'httpsHealth', 'publicInternalHidden', 'termsReachable',
  'privacyReachable', 'policyContactsPresent', 'deviceProofVerified', 'guestSession',
  'basicConsentRecorded', 'loginStatusChecked', 'smsAvailable', 'wechatAvailable',
  'guestZeroBalance', 'uploadRejected', 'ordersRejected', 'logoutVerified', 'oldTokenRejected',
]);
export const SAFE_PUBLIC_REQUESTS = Object.freeze([
  'GET /health', 'GET /app/legal/terms.html', 'GET /app/legal/privacy.html',
  'GET /api/internal/account-operations', 'POST /api/auth/device/challenge',
  'POST /api/auth/device/verify', 'GET /api/auth/me', 'POST /api/consents',
  'GET /api/consents', 'GET /api/account/login-status', 'GET /api/account/entitlements',
  'POST /api/upload', 'POST /api/orders', 'POST /api/auth/logout',
]);
const emptyResult = () => Object.fromEntries(RESULT_KEYS.map(key => [key, false]));
const check = condition => { if (!condition) throw new Error('APP_ACCOUNT_LIVE_VERIFY_FAILED'); };

export function accountLiveVerificationPlan() {
  return { code: 'APP_ACCOUNT_LIVE_VERIFY_PLAN', readsLocalEnv: false, sendsRemoteCommand: false,
    requiresReviewedRun: true, createsTemporaryGuestSession: true, preservesAudit: true,
    callsPhoneApi: false, sendsSms: false, callsSupplier: false, performsPayment: false, deletesAccount: false };
}

async function boundedText(response) {
  const limit = 128 * 1024;
  const length = Number(response.headers.get('content-length'));
  check(!Number.isFinite(length) || length <= limit);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); check(false); }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { reader.releaseLock(); }
}

function operationChecks(value, now) {
  const retention = value?.retention;
  const validAge = stamp => Number.isSafeInteger(stamp) && stamp > 0 && stamp <= now + 300_000 && now - stamp <= 600_000;
  return {
    healthy: value?.enabled === true && value.log?.healthy === true && Number.isSafeInteger(value.log.written)
      && value.log.written >= 1 && retention?.overdue === false && retention.stopped === false
      && retention.lastError === null && retention.lastNotificationError === null,
    recentApply: validAge(retention?.lastAppliedAt) && retention?.lastReport?.mode === 'apply'
      && validAge(retention.lastReport.checkedAt) && retention.lastReport.invalidSessionTimes === 0,
  };
}

// A pure verifier for local mocked tests and the remote command. Its only writes
// are normal HTTPS device verification, one basic consent, and its own logout.
// No key/token/account ID escapes this function; no database/state is deleted.
export async function verifyAccountLiveFlow({ env, fetchImpl = fetch, readOperations, now = Date.now }) {
  const flags = emptyResult();
  let token;
  let before;
  let verified = false;
  const request = async (method, route, body, authenticated = false, invite = false) => {
    check(SAFE_PUBLIC_REQUESTS.includes(`${method} ${route}`));
    const response = await fetchImpl(`${PUBLIC_BASE}${route}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
        ...(invite ? { 'x-closed-test-invite': env.CLOSED_TEST_INVITE_SECRET } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await boundedText(response);
    return { status: response.status, text, json: () => JSON.parse(text) };
  };
  try {
    check(typeof env.CLOSED_TEST_INVITE_SECRET === 'string' && env.CLOSED_TEST_INVITE_SECRET.length > 0);
    check(env.BASIC_CONSENT_VERSION === CONSENT_VERSION);
    before = await readOperations();
    const beforeChecks = operationChecks(before, now());
    flags.operationHealthBefore = beforeChecks.healthy;
    flags.recentApplyBefore = beforeChecks.recentApply;
    check(beforeChecks.healthy && beforeChecks.recentApply);

    const health = await request('GET', '/health');
    flags.httpsHealth = health.status === 200 && health.json().ok === true;
    check(flags.httpsHealth);
    const hidden = await request('GET', INTERNAL_PATH);
    flags.publicInternalHidden = hidden.status === 404;
    check(flags.publicInternalHidden);
    const terms = await request('GET', '/app/legal/terms.html');
    const privacy = await request('GET', '/app/legal/privacy.html');
    flags.termsReachable = terms.status === 200;
    flags.privacyReachable = privacy.status === 200;
    flags.policyContactsPresent = terms.text.includes(CONTACT) && privacy.text.includes(CONTACT);
    check(flags.termsReachable && flags.privacyReachable && flags.policyContactsPresent);

    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const publicKeySpki = pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
    const challenge = await request('POST', '/api/auth/device/challenge', { algorithm: 'ES256', publicKeySpki }, false, true);
    check(challenge.status === 200);
    const proof = challenge.json().data;
    check(proof && /^dch_[0-9a-f-]{36}$/i.test(proof.challengeId || '') && typeof proof.challenge === 'string'
      && proof.challenge.length >= 16 && proof.challenge.length <= 4096 && proof.algorithm === 'ES256');
    const sessionResponse = await request('POST', '/api/auth/device/verify', {
      algorithm: 'ES256', challengeId: proof.challengeId, challenge: proof.challenge, publicKeySpki,
      signature: crypto.sign('sha256', Buffer.from(proof.challenge), pair.privateKey).toString('base64url'),
    }, false, true);
    check(sessionResponse.status === 200);
    const session = sessionResponse.json().data;
    check(typeof session?.token === 'string' && session.token.length >= 32 && session.token.length <= 4096);
    token = session.token; // Capture before further checks so finally can revoke it.
    check(/^usr_[0-9a-f-]{36}$/i.test(session.user?.id || ''));
    flags.deviceProofVerified = true;
    const me = await request('GET', '/api/auth/me', undefined, true);
    flags.guestSession = me.status === 200 && me.json().data?.authMethod === 'device_bootstrap';
    check(flags.guestSession);

    const consent = await request('POST', '/api/consents', { consentType: 'basic', action: 'granted', version: CONSENT_VERSION }, true);
    check(consent.status === 200);
    const entry = consent.json().data;
    check(entry?.userId === session.user.id && entry.consentType === 'basic' && entry.action === 'granted' && entry.version === CONSENT_VERSION);
    const saved = await request('GET', '/api/consents', undefined, true);
    flags.basicConsentRecorded = saved.status === 200 && saved.json().data?.entries?.some(item => item.id === entry.id
      && item.consentType === 'basic' && item.action === 'granted' && item.version === CONSENT_VERSION) === true;
    check(flags.basicConsentRecorded);

    const loginResponse = await request('GET', '/api/account/login-status', undefined, true);
    check(loginResponse.status === 200);
    const login = loginResponse.json().data;
    flags.loginStatusChecked = login?.loginEnabled === true && login.loggedIn === false && login.bound === false
      && login.userId === session.user.id && login.maskedPhone === null && login.wechatLinked === false && typeof login.available === 'boolean'
      && typeof login.wechatAvailable === 'boolean';
    check(flags.loginStatusChecked);
    flags.smsAvailable = login.available; // Configuration readiness, never SMS delivery proof.
    flags.wechatAvailable = login.wechatAvailable;
    const entitlements = await request('GET', '/api/account/entitlements', undefined, true);
    flags.guestZeroBalance = entitlements.status === 200 && entitlements.json().data?.totalRemaining === 0;
    check(flags.guestZeroBalance);

    // Empty bodies cannot initiate a valid upload/order if an expected gate fails.
    // This is a gate check, never a checkout, payment or supplier request.
    const upload = await request('POST', '/api/upload', {}, true);
    flags.uploadRejected = upload.status === 403 && upload.json().code === 'APP_ACCOUNT_ONLY';
    check(flags.uploadRejected);
    const order = await request('POST', '/api/orders', {}, true);
    flags.ordersRejected = order.status === 403 && order.json().code === 'APP_ACCOUNT_ONLY';
    check(flags.ordersRejected);
    verified = true;
  } catch { verified = false; }
  finally {
    if (token) {
      try {
        const logout = await request('POST', '/api/auth/logout', {}, true);
        flags.logoutVerified = logout.status === 200 && logout.json().data?.loggedOut === true;
      } catch { flags.logoutVerified = false; }
      try {
        const old = await request('GET', '/api/auth/me', undefined, true);
        flags.oldTokenRejected = old.status === 401 && old.json().code === 'AUTH_REQUIRED';
      } catch { flags.oldTokenRejected = false; }
    }
    try {
      const after = await readOperations();
      const afterChecks = operationChecks(after, now());
      flags.operationHealthAfter = afterChecks.healthy;
      flags.recentApplyAfter = afterChecks.recentApply;
      // challenge + verify + logout each writes attempt/result. Denied requests
      // add events too; only a boolean is returned, never audit contents or IDs.
      flags.auditAdvanced = Boolean(token && Number.isSafeInteger(before?.log?.written)
        && Number.isSafeInteger(after?.log?.written) && after.log.written >= before.log.written + 6
        && ['writeFailures', 'invalidEvents', 'droppedEvents'].every(key => Number.isSafeInteger(before.log[key])
          && Number.isSafeInteger(after.log[key]) && after.log[key] === before.log[key]));
    } catch { flags.operationHealthAfter = false; }
    token = undefined;
  }
  const passed = verified && flags.logoutVerified && flags.oldTokenRejected && flags.operationHealthAfter && flags.recentApplyAfter && flags.auditAdvanced;
  return { code: passed ? 'APP_ACCOUNT_LIVE_VERIFY_PASS' : 'APP_ACCOUNT_LIVE_VERIFY_FAILED', ...flags };
}

// Only recognized fixed codes and boolean fields are eligible for local output.
export function safeLiveVerificationResult(output) {
  const lines = String(output || '').trim().split(/\r?\n/);
  check(lines.length === 1 && lines[0].length <= 16 * 1024);
  const result = JSON.parse(lines[0]);
  check(result && ['APP_ACCOUNT_LIVE_VERIFY_PASS', 'APP_ACCOUNT_LIVE_VERIFY_FAILED'].includes(result.code));
  check(Object.keys(result).length === RESULT_KEYS.length + 1
    && Object.keys(result).every(key => key === 'code' || RESULT_KEYS.includes(key))
    && RESULT_KEYS.every(key => typeof result[key] === 'boolean'));
  check(!result.otpSecretComparisonAvailable || result.otpSecretContinuityVerified || result.code === 'APP_ACCOUNT_LIVE_VERIFY_FAILED');
  if (result.code === 'APP_ACCOUNT_LIVE_VERIFY_PASS') check(RESULT_KEYS.filter(key => ![
    'otpSecretComparisonAvailable', 'otpSecretContinuityVerified', 'smsAvailable', 'wechatAvailable',
  ].includes(key)).every(key => result[key]));
  return { code: result.code, ...Object.fromEntries(RESULT_KEYS.map(key => [key, result[key]])) };
}

export function buildAccountLiveVerifyCommand() {
  return `#!/bin/bash
set -Eeuo pipefail
umask 077
exec 3>&1
exec >/dev/null 2>&1
APP_VERIFY_SHELL_FAILURE='${JSON.stringify({ code: 'APP_ACCOUNT_LIVE_VERIFY_FAILED', ...emptyResult() })}'
trap 'printf "%s\\n" "$APP_VERIFY_SHELL_FAILURE" >&3' ERR
test "$EUID" -eq 0
cd '${RELEASE}'
trap - ERR
/usr/bin/node --input-type=module <<'ACCOUNT_VERIFY_JS' >&3 2>/dev/null
import fs from 'node:fs';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {parse} from 'dotenv';
const PUBLIC_BASE=${JSON.stringify(PUBLIC_BASE)};
const CONSENT_VERSION=${JSON.stringify(CONSENT_VERSION)};
const CONTACT=${JSON.stringify(CONTACT)};
const INTERNAL_PATH=${JSON.stringify(INTERNAL_PATH)};
const RESULT_KEYS=${JSON.stringify(RESULT_KEYS)};
const SAFE_PUBLIC_REQUESTS=${JSON.stringify(SAFE_PUBLIC_REQUESTS)};
const emptyResult=${emptyResult.toString()};
const check=${check.toString()};
${boundedText.toString()}
${operationChecks.toString()}
${verifyAccountLiveFlow.toString()}
const flags=emptyResult();
try {
  const release=${JSON.stringify(RELEASE)};
  const service='leyanxiu-app-account';
  const systemctl=(...args)=>execFileSync('/usr/bin/systemctl',args,{encoding:'utf8',stdio:['ignore','pipe','ignore'],timeout:10000}).trim();
  check(systemctl('is-active',service)==='active');
  check(systemctl('show','-p','WorkingDirectory','--value',service)===release);
  const pid=systemctl('show','-p','MainPID','--value',service);
  check(/^[1-9][0-9]{0,9}$/.test(pid));
  check(fs.realpathSync('/proc/'+pid+'/cwd')===release);
  flags.newReleaseActive=true;
  const file='/etc/leyanxiu-app-account/server.env';
  const stat=fs.lstatSync(file);check(stat.isFile()&&!stat.isSymbolicLink()&&stat.uid===0&&(stat.mode&0o7777)===0o600&&stat.nlink===1);
  const bytes=fs.readFileSync(file);check(bytes.length<=128*1024);
  const env=parse(bytes);
  const active=Object.fromEntries(fs.readFileSync('/proc/'+pid+'/environ','utf8').split('\\0').filter(Boolean).map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
  const required={DEPLOY_ENV:'staging',RELEASE_CHANNEL:'android-app',AUTH_MODE:'device_key',APP_LOGIN_ENABLED:'true',
    APP_ACCOUNT_ONLY:'true',APP_ACCOUNT_OPERATIONS_ENABLED:'true',ACCOUNT_RETENTION_MODE:'apply',
    CLOSED_TEST_MODE:'true',CLOSED_TEST_REQUIRE_INVITE:'true',PAYMENT_MODE:'closed_test',PROVIDER:'mock',
    BILLING_BACKEND:'postgres',COMPLIANCE_BACKEND:'sqlite',BIND_HOST:'127.0.0.1',PORT:'3300',BASIC_CONSENT_VERSION:CONSENT_VERSION,
    USER_AGREEMENT_URL:PUBLIC_BASE+'/app/legal/terms.html',PRIVACY_POLICY_URL:PUBLIC_BASE+'/app/legal/privacy.html'};
  for(const [key,value] of Object.entries(required)) check(env[key]===value&&active[key]===value);
  for(const key of ['ACCOUNT_OTP_SECRET','INTERNAL_CRON_TOKEN','CLOSED_TEST_INVITE_SECRET']) check(typeof env[key]==='string'&&env[key].length>0&&active[key]===env[key]);
  check(env.ACCOUNT_OTP_SECRET.length>=32&&env.INTERNAL_CRON_TOKEN.length>=32);
  flags.accountOnlyEnabled=true;flags.operationsEnabled=true;flags.closedTestOnly=true;
  const manifest=JSON.parse(fs.readFileSync(release+'/source-manifest.json','utf8'));
  check(manifest.format==='app-account-update-v1'&&manifest.release===release&&/^[a-f0-9]{64}$/.test(manifest.bundleSha256||''));
  const backupRoot='/var/backups/leyanxiu-app-account';
  if(fs.existsSync(backupRoot)) {
    const names=fs.readdirSync(backupRoot).filter(name=>/^update-20261009-[0-9]{8}T[0-9]{6}Z$/.test(name)).sort().reverse();
    for(const name of names) {
      const dir=backupRoot+'/'+name;
      const directory=fs.lstatSync(dir);if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==0||(directory.mode&0o7777)!==0o700)continue;
      const log=dir+'/activation.log';if(!fs.existsSync(log))continue;
      const logStat=fs.lstatSync(log);if(!logStat.isFile()||logStat.isSymbolicLink()||logStat.size>128*1024)continue;
      if(!fs.readFileSync(log,'utf8').split(/\\r?\\n/).includes('APP_UPDATE_ACTIVATED '+manifest.bundleSha256))continue;
      const backup=dir+'/server.env';const backupStat=fs.lstatSync(backup);
      check(backupStat.isFile()&&!backupStat.isSymbolicLink()&&backupStat.uid===0&&(backupStat.mode&0o7777)===0o600&&backupStat.nlink===1&&backupStat.size<=128*1024);
      const old=parse(fs.readFileSync(backup));
      flags.otpSecretComparisonAvailable=true;
      const left=Buffer.from(env.ACCOUNT_OTP_SECRET);const right=Buffer.from(String(old.ACCOUNT_OTP_SECRET||''));
      flags.otpSecretContinuityVerified=left.length===right.length&&crypto.timingSafeEqual(left,right);
      check(flags.otpSecretContinuityVerified);
      break;
    }
  }
  const readOperations=async()=>{
    const response=await fetch('http://127.0.0.1:3300'+INTERNAL_PATH,{redirect:'error',headers:{'x-internal-token':env.INTERNAL_CRON_TOKEN},signal:AbortSignal.timeout(10000)});
    check(response.status===200);return JSON.parse(await boundedText(response)).data;
  };
  const result=await verifyAccountLiveFlow({env,readOperations});
  const final={...result,...Object.fromEntries(['newReleaseActive','accountOnlyEnabled','operationsEnabled','closedTestOnly','otpSecretComparisonAvailable','otpSecretContinuityVerified'].map(key=>[key,flags[key]]))};
  console.log(JSON.stringify(final));
  if(final.code!=='APP_ACCOUNT_LIVE_VERIFY_PASS')process.exitCode=1;
} catch {console.log(JSON.stringify({code:'APP_ACCOUNT_LIVE_VERIFY_FAILED',...flags}));process.exitCode=1;}
ACCOUNT_VERIFY_JS
trap - ERR
`;
}

export async function runAccountLiveVerification({ requestImpl, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  try {
  check(typeof requestImpl === 'function');
  const started = await requestImpl('RunCommand', { 'InstanceId.1': INSTANCE, Type: 'RunShellScript',
    Name: 'leyanxiu-app-account-live-verify-20261009', CommandContent: Buffer.from(buildAccountLiveVerifyCommand()).toString('base64'),
    ContentEncoding: 'Base64', Timeout: '150', KeepCommand: 'false' });
  check(/^t-[A-Za-z0-9]+$/.test(started?.InvokeId || ''));
  for (let attempt = 0; attempt < 85; attempt++) {
    const result = await requestImpl('DescribeInvocationResults', { InvokeId: started.InvokeId, InstanceId: INSTANCE, ContentEncoding: 'PlainText' });
    const records = result?.Invocation?.InvocationResults?.InvocationResult;
    check(Array.isArray(records));
    const record = records.find(item => item.InstanceId === INSTANCE);
    if (record && ['Success', 'Finished', 'Failed', 'Error', 'Timeout', 'Cancelled'].includes(record.InvocationStatus)) {
      const safe = safeLiveVerificationResult(record.Output);
      check(safe.code !== 'APP_ACCOUNT_LIVE_VERIFY_PASS' || (record.ExitCode === 0 && ['Success', 'Finished'].includes(record.InvocationStatus)));
      return safe;
    }
    await delay(2000);
  }
  throw new Error('APP_ACCOUNT_LIVE_VERIFY_FAILED');
  } catch { throw new Error('APP_ACCOUNT_LIVE_VERIFY_FAILED'); }
}

async function main(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === 'plan')) {
    console.log(JSON.stringify(accountLiveVerificationPlan()));
    return;
  }
  check(args.length === 1 && args[0] === 'run');
  // The existing helper reads local credentials on import; import only here.
  const { request } = await import('./inspect-app-ecs.mjs');
  const result = await runAccountLiveVerification({ requestImpl: request });
  console.log(JSON.stringify(result));
  if (result.code !== 'APP_ACCOUNT_LIVE_VERIFY_PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(() => {
  console.log(JSON.stringify({ code: 'APP_ACCOUNT_LIVE_VERIFY_FAILED', ...emptyResult() }));
  process.exitCode = 1;
});
