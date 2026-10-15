import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import debug from 'debug';
import OSS from 'ali-oss';
import { createOssModerationStorage } from '../photo-jobs/moderation.js';

// Explicit one-object integration acceptance. No Green/media API, bucket policy,
// ACL, lifecycle, RAM or existing object changes. Never print SDK error objects.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const timeoutMs = 12_000;
// Pillow-generated and independently decoded 32x32 solid colour, no metadata.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAO0lEQVR4nO3RQREAMAjEwKN+6qVykF8J4cMvK+CYCXVfZ9NZXY8HBvwBMhEyETIRMhEyETIRMhEyUcgHKU4BNULpqU8AAAAASUVORK5CYII=', 'base64');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const stop = code => { throw new Error(code); };
const safeCode = error => ['AUTH_READ_MISMATCH', 'ANONYMOUS_READABLE', 'ANONYMOUS_STATUS_UNEXPECTED',
  'SIGNED_READ_MISMATCH', 'READ_TOO_LARGE'].includes(error?.message) ? error.message : 'OPERATION_UNCONFIRMED';

async function readBounded(response, maximum) {
  const parts = [];
  let size = 0;
  for await (const part of response.body || []) {
    size += part.length;
    if (size > maximum) stop('READ_TOO_LARGE');
    parts.push(Buffer.from(part));
  }
  return Buffer.concat(parts);
}

// Testable workflow uses only a single exact generated key, with each network
// operation attempted at most once. The caller must protect/write its journal.
export async function verifyOneObject({ key, bytes, storage, sdk, anonymousUrl, fetcher = fetch, journal }) {
  if (!/^private\/photo-moderation\/[a-f0-9]{32}\.png$/.test(key) || !Buffer.isBuffer(bytes)) stop('INVALID_ACCEPTANCE_INPUT');
  const report = { syntheticOnly: true, attemptedObjects: 0, putConfirmed: false, authenticatedReadMatches: false,
    anonymousStatus: null, signedStatus: null, signedReadMatches: false, deleteConfirmed: false,
    authenticatedHeadNoSuchKey: false, versionHeaderPresent: false, cleanupPending: false, passed: false };
  let cleanupNeeded = false;
  let stage = 'prepared';
  const record = phase => journal({ phase, key, sha256: digest(bytes), report: { ...report } });
  record(stage); // Durable intent precedes every possible remote write.
  try {
    stage = 'put';
    cleanupNeeded = true;
    report.attemptedObjects = 1;
    try {
      await storage.put(key, bytes, { contentType: 'image/png', timeoutMs });
    } catch (error) {
      // A definite rejected create is not authority to delete an existing key.
      if (error?.code === 'ObjectAlreadyExists' || (error?.status >= 400 && error.status < 500 && error.status !== 408)) cleanupNeeded = false;
      throw error;
    }
    report.putConfirmed = true;
    record('put_confirmed');
    stage = 'authenticated_get';
    const read = await sdk.get(key, { timeout: timeoutMs });
    report.authenticatedReadMatches = read?.res?.status === 200 && Buffer.isBuffer(read.content)
      && read.content.length === bytes.length && digest(read.content) === digest(bytes);
    const version = read?.res?.headers?.['x-oss-version-id'];
    report.versionHeaderPresent = typeof version === 'string' && version !== 'null' && version !== '';
    if (!report.authenticatedReadMatches) stop('AUTH_READ_MISMATCH');
    stage = 'anonymous_get';
    const anonymous = await fetcher(anonymousUrl, { method: 'GET', credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs), headers: { 'Cache-Control': 'no-store' } });
    report.anonymousStatus = anonymous.status;
    // Do not consume or log a publicly returned body, even this synthetic image.
    await anonymous.body?.cancel();
    if (anonymous.status === 200) stop('ANONYMOUS_READABLE');
    if (anonymous.status !== 403) stop('ANONYMOUS_STATUS_UNEXPECTED');
    stage = 'signed_get';
    const signedUrl = storage.signedUrl(key, { ttlSeconds: 60 });
    const signed = await fetcher(signedUrl, { method: 'GET', credentials: 'omit', redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs), headers: { 'Cache-Control': 'no-store' } });
    report.signedStatus = signed.status;
    if (signed.status !== 200) { await signed.body?.cancel(); stop('SIGNED_READ_MISMATCH'); }
    const content = await readBounded(signed, bytes.length);
    report.signedReadMatches = content.length === bytes.length && digest(content) === digest(bytes);
    if (!report.signedReadMatches) stop('SIGNED_READ_MISMATCH');
    record('access_verified');
  } catch (error) {
    report.failureStage = stage;
    report.failure = safeCode(error);
  } finally {
    if (cleanupNeeded) {
      // Exactly this run's key; no listing, prefix deletion or retry.
      try { await storage.delete(key, { timeoutMs }); report.deleteConfirmed = true; }
      catch { report.cleanupPending = true; }
      try { await sdk.head(key, { timeout: timeoutMs }); }
      catch (error) { report.authenticatedHeadNoSuchKey = error?.status === 404 && error?.code === 'NoSuchKey'; }
      report.cleanupPending ||= !report.deleteConfirmed || !report.authenticatedHeadNoSuchKey || !report.putConfirmed || report.versionHeaderPresent;
    }
    report.passed = report.putConfirmed && report.authenticatedReadMatches && report.anonymousStatus === 403
      && report.signedStatus === 200 && report.signedReadMatches && report.deleteConfirmed
      && report.authenticatedHeadNoSuchKey && !report.cleanupPending;
    record('finished');
  }
  return report;
}

export function privateJournal(runId, { prefix = 'photo-storage-acceptance', createdBy = 'single-synthetic-object-acceptance' } = {}) {
  if (![runId, prefix, createdBy].every(value => typeof value === 'string' && /^[a-z0-9-]{1,80}$/.test(value))) stop('PRIVATE_JOURNAL_NAME_INVALID');
  const parent = path.join(root, 'data');
  fs.mkdirSync(parent, { recursive: true });
  if (fs.lstatSync(parent).isSymbolicLink()) stop('PRIVATE_JOURNAL_UNCONFIRMED');
  // Exclusive mkdir also prevents concurrent/repeated fixed-name paid probes.
  const directory = path.join(parent, `${prefix}-${runId}`);
  fs.mkdirSync(directory, { mode: 0o700 });
  if (process.platform === 'win32') {
    const pwsh = 'REDACTED_LOCAL_USER_PATH/.cache/codex-runtimes/codex-primary-runtime/dependencies/native/powershell/pwsh.exe';
    const quote = value => "'" + value.replaceAll("'", "''") + "'";
    const command = `$ErrorActionPreference='Stop'; $p=${quote(directory)}; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User; `
      + "$acl=Get-Acl -LiteralPath $p; $acl.SetAccessRuleProtection($true,$false); "
      + "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); "
      + "$acl.SetAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl; $check=Get-Acl -LiteralPath $p; "
      + "if(!$check.AreAccessRulesProtected){throw 'Unprotected'}; foreach($r in $check.Access){ "
      + "if($r.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'UnexpectedPrincipal'} }; 'PRIVATE_LOG_READY'";
    const result = execFileSync(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { timeout: 15_000, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (result.trim() !== 'PRIVATE_LOG_READY') stop('PRIVATE_JOURNAL_UNCONFIRMED');
  }
  const filename = path.join(directory, 'intent.jsonl');
  return value => {
    const fd = fs.openSync(filename, 'a', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ createdBy, recordedAt: new Date().toISOString(), ...value }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  };
}

async function execute() {
  debug.disable(); // SDK debugging must never leak request signatures or hosts.
  const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
  const required = ['ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'OSS_BUCKET', 'OSS_REGION'];
  if (!required.every(key => typeof env[key] === 'string' && env[key].trim())) stop('CONFIGURATION_UNCONFIRMED');
  const runId = crypto.randomBytes(16).toString('hex');
  const key = `private/photo-moderation/${runId}.png`;
  const sdk = new OSS({ accessKeyId: env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: env.ALIYUN_ACCESS_KEY_SECRET,
    bucket: env.OSS_BUCKET, region: env.OSS_REGION, secure: true, retryMax: 0, timeout: timeoutMs });
  const storage = createOssModerationStorage({ client: sdk, bucket: env.OSS_BUCKET, region: env.OSS_REGION.replace(/^oss-/, '') });
  const journal = privateJournal(runId);
  return verifyOneObject({ key, bytes: png, sdk, storage, journal,
    anonymousUrl: `https://${env.OSS_BUCKET}.${env.OSS_REGION}.aliyuncs.com/${key}` });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--execute') {
    console.log(JSON.stringify({ executed: false, reason: 'EXPLICIT_EXECUTE_REQUIRED' }));
  } else {
    try { const report = await execute(); console.log(JSON.stringify(report)); if (!report.passed) process.exitCode = 1; }
    catch { console.log(JSON.stringify({ passed: false, reason: 'ACCEPTANCE_UNCONFIRMED_CHECK_PRIVATE_INTENT' })); process.exitCode = 1; }
  }
}
