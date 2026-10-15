import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'dotenv';
import { updatePrivateConfigFiles } from './update-app-sms-config.mjs';

export const ACCOUNT_RUNTIME_SETTINGS = Object.freeze({
  APP_ACCOUNT_ONLY: 'true', APP_ACCOUNT_OPERATIONS_ENABLED: 'true',
  ACCOUNT_SECURITY_LOG_DIR: '/var/lib/leyanxiu-app-account/security-log',
  ACCOUNT_RETENTION_MODE: 'apply', BASIC_CONSENT_VERSION: '2026-10-09-account',
  USER_AGREEMENT_URL: 'https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/terms.html',
  PRIVACY_POLICY_URL: 'https://REDACTED_COMPANY_INFRASTRUCTURE/app/legal/privacy.html',
  SUPPORT_CONTACT: 'REDACTED_COMPANY_CONTACT_EMAIL',
});
const fail = code => { throw new Error(code); };

export function planAccountRuntime(current, input) {
  if (!input || Object.keys(input).length !== 1 || input.consistentBackupVerified !== true) fail('BACKUP_VERIFICATION_REQUIRED');
  const seen = new Set();
  const lines = current.match(/[^\n]*\n|[^\n]+$/g) || [];
  const records = lines.map(raw => {
    if (/^\s*(?:[#;].*)?$/.test(raw)) return { raw };
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)=("[^"\\\r\n]*"|'[^'\\\r\n]*'|[^'"`#\\\r\n]*)(\r?\n)?$/);
    if (!m || seen.has(m[1])) fail('AMBIGUOUS_ENV');
    seen.add(m[1]); return { raw, key: m[1], ending: m[3] || '' };
  });
  const old = parse(current);
  if (old.DEPLOY_ENV !== 'staging' || old.RELEASE_CHANNEL !== 'android-app'
    || old.AUTH_MODE !== 'device_key' || old.APP_LOGIN_ENABLED !== 'true'
    || old.CLOSED_TEST_MODE !== 'true' || old.CLOSED_TEST_REQUIRE_INVITE !== 'true'
    || old.PAYMENT_MODE !== 'closed_test' || old.PROVIDER !== 'mock'
    || old.OBJECT_STORAGE_BACKEND !== 'file' || (old.ACCOUNT_OTP_SECRET || '').length < 32) fail('ACCOUNT_RUNTIME_TARGET_INVALID');
  const changedFields = Object.keys(ACCOUNT_RUNTIME_SETTINGS).filter(k => old[k] !== ACCOUNT_RUNTIME_SETTINGS[k]);
  let text = records.map(r => changedFields.includes(r.key) ? `${r.key}=${JSON.stringify(ACCOUNT_RUNTIME_SETTINGS[r.key])}${r.ending}` : r.raw).join('');
  const missing = changedFields.filter(k => !seen.has(k));
  if (missing.length) {
    const ending = current.includes('\r\n') ? '\r\n' : '\n';
    if (text && !text.endsWith('\n')) text += ending;
    text += missing.map(k => `${k}=${JSON.stringify(ACCOUNT_RUNTIME_SETTINGS[k])}${ending}`).join('');
  }
  const next = parse(text);
  for (const k of Object.keys(old)) if (!(k in ACCOUNT_RUNTIME_SETTINGS) && next[k] !== old[k]) fail('PROTECTED_FIELD_CHANGED');
  return { text, changedFields: changedFields.sort() };
}

async function main(args) {
  if (args.length < 2 || args[0] !== '--input' || (args.length > 2 && (args.length !== 3 || args[2] !== '--apply'))) fail('INVALID_ARGUMENTS');
  const apply = args[2] === '--apply';
  if (apply && (process.platform !== 'linux' || process.getuid?.() !== 0)) fail('APPLY_REQUIRES_LINUX_ROOT');
  const result = await updatePrivateConfigFiles({ inputPath: args[1], apply, ownerUid: apply ? 0 : undefined, planConfig: planAccountRuntime });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(() => {
  console.error('ACCOUNT_RUNTIME_UPDATE_FAILED'); process.exitCode = 1;
});
