#!/usr/bin/env node
// Local preparation only until this configuration has been approved by the operator.
// Default: node deploy/update-app-sms-config.mjs --input /root/private/app-sms.json
// Only when authorized, append --apply on the ECS as Linux root. No service restart,
// SMS delivery, agreement acceptance, or payment change is performed by this tool.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parse } from 'dotenv';

const TARGET = '/etc/leyanxiu-app-account/server.env';
const ALLOWED = new Set([
  'SMS_PROVIDER', 'SMS_ACCESS_KEY_ID', 'SMS_ACCESS_KEY_SECRET', 'SMS_SIGN_NAME',
  'SMS_TEMPLATE_CODE', 'SMS_DAILY_LIMIT', 'PRIVACY_POLICY_URL', 'USER_AGREEMENT_URL',
]);
function requireCondition(ok, code) { if (!ok) throw new Error(code); }

function envLines(text) {
  requireCondition(typeof text === 'string' && !text.includes('\0'), 'INVALID_ENV');
  const values = Object.create(null);
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [];
  const records = lines.map(raw => {
    const ending = raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : '';
    const body = raw.slice(0, raw.length - ending.length);
    if (/^\s*(?:[#;].*)?$/.test(body)) return { raw };
    // The installer emits simple KEY=value lines. Reject inline comments and
    // backslashes rather than interpret differences between dotenv and systemd.
    // Full-line comments stay untouched; multiline/export/duplicates also fail.
    requireCondition(!body.includes('\\'), 'AMBIGUOUS_ENV');
    const match = body.match(/^([ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*)("[^"\r\n]*"|'[^'\r\n]*'|[^'"`#\r\n]*?)([ \t]*)$/);
    requireCondition(match && !Object.hasOwn(values, match[2]), 'AMBIGUOUS_ENV');
    const key = match[2];
    values[key] = parse(body)[key];
    requireCondition(typeof values[key] === 'string', 'INVALID_ENV');
    return { raw, key, prefix: match[1], suffix: match[4], ending };
  });
  return { records, values };
}

function httpsPolicyUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('INVALID_POLICY_URL'); }
  const hostname = url.hostname.toLowerCase();
  requireCondition(url.protocol === 'https:' && !url.username && !url.password
    && hostname.includes('.') && /^[a-z0-9.-]+$/.test(hostname)
    && !/^\d+(?:\.\d+){3}$/.test(hostname)
    && !hostname.split('.').some(part => /^(?:example|invalid|test|localhost|local|placeholder|changeme|yourdomain|your-domain)$/.test(part)),
  'INVALID_POLICY_URL');
}

export function planSmsConfig(currentText, patch) {
  requireCondition(patch && Object.getPrototypeOf(patch) === Object.prototype, 'INVALID_PATCH');
  requireCondition(Object.keys(patch).length > 0, 'EMPTY_PATCH');
  requireCondition(Object.keys(patch).every(key => ALLOWED.has(key)), 'UNKNOWN_FIELD');
  const current = envLines(currentText);
  const old = current.values;
  // Runtime skips the invitation gate in production, even if its flag is true.
  requireCondition(String(old.DEPLOY_ENV || old.NODE_ENV || 'development').toLowerCase() === 'staging'
    && old.PAYMENT_MODE === 'closed_test' && old.CLOSED_TEST_MODE === 'true'
    && old.CLOSED_TEST_REQUIRE_INVITE === 'true' && old.APP_LOGIN_ENABLED === 'true', 'CLOSED_TEST_REQUIRED');
  requireCondition(typeof old.ACCOUNT_OTP_SECRET === 'string' && old.ACCOUNT_OTP_SECRET.length >= 32, 'OTP_SECRET_REQUIRED');
  requireCondition(/^[1-9]\d*$/.test(old.SMS_DAILY_LIMIT || '') && Number(old.SMS_DAILY_LIMIT) <= 20, 'INVALID_EXISTING_BUDGET');
  const updates = Object.create(null);
  for (const [key, supplied] of Object.entries(patch)) {
    const value = key === 'SMS_DAILY_LIMIT' && Number.isInteger(supplied) ? String(supplied) : supplied;
    // No expansion/escaping differences between systemd EnvironmentFile and dotenv.
    requireCondition(typeof value === 'string' && value.length > 0 && value.length <= 2048
      && value === value.trim() && !/[\x00-\x1f\x7f'"`\\$#]/.test(value), 'INVALID_PATCH_VALUE');
    updates[key] = value;
  }
  const next = { ...old, ...updates };
  requireCondition(next.SMS_PROVIDER === 'aliyun', 'ALIYUN_PROVIDER_REQUIRED');
  for (const key of ['SMS_ACCESS_KEY_ID', 'SMS_ACCESS_KEY_SECRET', 'SMS_SIGN_NAME', 'SMS_TEMPLATE_CODE']) {
    requireCondition(typeof next[key] === 'string' && next[key].trim().length > 0, 'SMS_CONFIG_INCOMPLETE');
  }
  requireCondition(/^SMS_[A-Za-z0-9]+$/.test(next.SMS_TEMPLATE_CODE), 'INVALID_TEMPLATE_CODE');
  requireCondition(/^[1-9]\d*$/.test(next.SMS_DAILY_LIMIT)
    && Number(next.SMS_DAILY_LIMIT) <= Number(old.SMS_DAILY_LIMIT), 'BUDGET_INCREASE_REFUSED');
  httpsPolicyUrl(next.PRIVACY_POLICY_URL);
  httpsPolicyUrl(next.USER_AGREEMENT_URL);
  const changedFields = Object.keys(updates).filter(key => updates[key] !== old[key]).sort();
  let text = current.records.map(record => changedFields.includes(record.key)
    ? `${record.prefix}${JSON.stringify(updates[record.key])}${record.suffix}${record.ending}` : record.raw).join('');
  const missing = changedFields.filter(key => !Object.hasOwn(old, key));
  if (missing.length) {
    const ending = currentText.includes('\r\n') ? '\r\n' : '\n';
    if (text && !text.endsWith('\n')) text += ending;
    text += missing.map(key => `${key}=${JSON.stringify(updates[key])}${ending}`).join('');
  }
  // Compare parsed values as a second guard; original non-allowlisted lines remain intact.
  const resulting = envLines(text).values;
  for (const key of Object.keys(old).filter(key => !ALLOWED.has(key))) {
    requireCondition(resulting[key] === old[key], 'PROTECTED_FIELD_CHANGED');
  }
  return { text, changedFields };
}

export function assertPrivateFile(stat, ownerUid) {
  requireCondition(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'UNSAFE_FILE_TYPE');
  requireCondition((stat.mode & 0o7777) === 0o600, 'FILE_MODE_MUST_BE_0600');
  if (ownerUid !== undefined) requireCondition(stat.uid === ownerUid, 'FILE_OWNER_MISMATCH');
}

async function privateFile(filename, io, ownerUid) {
  const absolute = path.resolve(filename);
  for (let parent = path.dirname(absolute); ; parent = path.dirname(parent)) {
    const directory = await io.lstat(parent);
    requireCondition(directory.isDirectory() && !directory.isSymbolicLink(), 'UNSAFE_PARENT');
    if (parent === path.dirname(absolute)) {
      requireCondition((directory.mode & 0o022) === 0, 'WRITABLE_PARENT');
      if (ownerUid !== undefined) requireCondition(directory.uid === ownerUid, 'PARENT_OWNER_MISMATCH');
    }
    if (parent === path.dirname(parent)) break;
  }
  const before = await io.lstat(absolute);
  assertPrivateFile(before, ownerUid);
  const handle = await io.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const opened = await handle.stat();
    assertPrivateFile(opened, ownerUid);
    requireCondition(before.dev === opened.dev && before.ino === opened.ino, 'FILE_CHANGED');
    requireCondition(opened.size <= 128 * 1024, 'FILE_TOO_LARGE');
    const bytes = await handle.readFile();
    requireCondition(Buffer.from(bytes.toString('utf8')).equals(bytes), 'INVALID_UTF8');
    return { absolute, bytes, stat: opened };
  } finally { await handle.close(); }
}

async function exclusiveWrite(filename, bytes, io) {
  const handle = await io.open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
  let complete = false;
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); complete = true; }
  finally {
    await handle.close();
    if (!complete) await io.unlink(filename).catch(() => {});
  }
}

// io injection exists for filesystem fault tests. CLI always uses Node's real fs.
export async function updatePrivateConfigFiles({ targetPath = TARGET, inputPath, apply = false, ownerUid, planConfig }, io = fs) {
  requireCondition(typeof planConfig === 'function', 'CONFIG_PLANNER_REQUIRED');
  requireCondition(typeof inputPath === 'string' && inputPath.length > 0, 'INPUT_REQUIRED');
  requireCondition(path.resolve(inputPath) !== path.resolve(targetPath), 'INPUT_EQUALS_TARGET');
  const target = await privateFile(targetPath, io, ownerUid);
  const input = await privateFile(inputPath, io, ownerUid);
  let patch;
  try { patch = JSON.parse(input.bytes.toString('utf8')); } catch { throw new Error('INVALID_PATCH_JSON'); }
  const plan = planConfig(target.bytes.toString('utf8'), patch);
  if (!apply || plan.changedFields.length === 0) return { applied: false, changedFields: plan.changedFields };
  const nonce = randomUUID();
  const temporary = `${target.absolute}.sms-${nonce}.tmp`;
  const backup = `${target.absolute}.sms-${nonce}.bak`;
  const lock = `${target.absolute}.sms-config.lock`;
  let locked = false;
  let temporaryCreated = false;
  try {
    const handle = await io.open(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    locked = true;
    await handle.close();
    // A protected backup is made before the replacement. A failed apply retains it.
    await exclusiveWrite(backup, target.bytes, io);
    await exclusiveWrite(temporary, Buffer.from(plan.text), io);
    temporaryCreated = true;
    const latest = await privateFile(target.absolute, io, ownerUid);
    requireCondition(latest.stat.dev === target.stat.dev && latest.stat.ino === target.stat.ino
      && latest.bytes.equals(target.bytes), 'TARGET_CHANGED');
    await io.rename(temporary, target.absolute);
    temporaryCreated = false;
    return { applied: true, changedFields: plan.changedFields };
  } finally {
    // Cleanup errors must not misreport an already committed atomic rename as failure.
    if (temporaryCreated) await io.unlink(temporary).catch(() => {});
    if (locked) await io.unlink(lock).catch(() => {});
  }
}

export function updateSmsConfigFiles(options, io = fs) {
  return updatePrivateConfigFiles({ ...options, planConfig: planSmsConfig }, io);
}

async function main(args) {
  let apply = false;
  let inputPath;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--apply' && !apply) apply = true;
    else if (args[index] === '--input' && !inputPath && args[index + 1] && !args[index + 1].startsWith('--')) inputPath = args[++index];
    else throw new Error('USAGE: --input PRIVATE_JSON [--apply]');
  }
  if (apply) requireCondition(process.platform === 'linux' && process.getuid?.() === 0, 'APPLY_REQUIRES_LINUX_ROOT');
  const result = await updateSmsConfigFiles({ inputPath, apply, ownerUid: apply ? 0 : undefined });
  // Never print input values, target content, credentials, or native exception details.
  console.log(JSON.stringify(apply ? result : result.changedFields));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => {
    const safe = /^(?:[A-Z][A-Z_]+|USAGE: --input PRIVATE_JSON \[--apply\])$/.test(error.message);
    console.error(safe ? error.message : 'SMS_CONFIG_UPDATE_FAILED');
    process.exitCode = 1;
  });
}
