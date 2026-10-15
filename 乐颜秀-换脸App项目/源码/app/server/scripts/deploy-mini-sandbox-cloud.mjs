import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { builtinSandboxMysql, privateSandboxTransport, virtualMysqlOptions } from '../payments/virtual/mysql-transport.js';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { validateMiniPrivateDatabase } from './check-mini-private-database.mjs';
import { nextUpgradeSource, nextSourceManifest, nextProfiles, nextEnvironment,
  nextEnvironmentMatches, nextProfileSummary, repairSource, repairSourceManifest,
  repairProfile, repairEnvironment, repairEnvironmentMatches, resumeSource, resumeSourceManifest,
  resumeProfile, closeProfile, acceptanceProfiles, acceptanceEnvironment,
  acceptanceEnvironmentMatches } from './mini-sandbox-next-profile.mjs';

// One controlled replacement of the existing callback receiver. No SQL, account
// changes, client edits, message-push changes, new service or production mode.
export const target = Object.freeze({ ...builtinSandboxMysql, serviceName: 'buildtest', region: 'ap-shanghai' });
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const recordName = '.env.mini-sandbox-deploy.pending.json';
const backupName = '.env.mini-sandbox-deploy.backup.json';
const lockName = '.env.mini-sandbox-deploy.lock';
const archiveIntentName = '.env.mini-sandbox-deploy.archive-intent.json';
// A reviewed one-time correction of this confirmed sandbox deployment only.
export const upgradeSource = Object.freeze({ operationId: 'cae5e3f718c02708f500b31f',
  releaseTaskId: 2306400, version: 'buildtest-008' });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const present = value => typeof value === 'string' && value.trim().length > 0;
const fail = code => { throw new Error(code); };
const codes = new Set(['ARGUMENT_INVALID', 'LOCAL_CONFIGURATION_INVALID', 'BUNDLE_INVALID', 'BUNDLE_HASH_MISMATCH',
  'CLOUD_SCOPE_UNCONFIRMED', 'SERVICE_SCOPE_MISMATCH', 'DATABASE_PREFLIGHT_FAILED', 'VERSION_CHANGED',
  'PRIVATE_FILE_UNSAFE', 'PRIVATE_SAVE_FAILED', 'OPERATION_LOCKED', 'PENDING_INVALID', 'PENDING_REQUIRES_REVIEW',
  'CONFIGURATION_UNCONFIRMED', 'UPLOAD_UNCONFIRMED', 'UPLOAD_HOST_REJECTED', 'RELEASE_UNCONFIRMED',
  'TASK_NOT_FINISHED', 'ROLLBACK_UNCONFIRMED', 'RESTORE_UNCONFIRMED', 'PUBLIC_ACCESS_UNCONFIRMED',
  'OFFICIAL_SDK_UNAVAILABLE', 'OFFICIAL_AUTH_UNCONFIRMED', 'UPGRADE_SOURCE_UNCONFIRMED',
  'ARCHIVE_REQUIRES_REVIEW']);
const safeCode = error => codes.has(error?.message) ? error.message : 'SANDBOX_OPERATION_UNCONFIRMED';
const oldRemarks = new Set(['20260929 mini-callback verification-only no-sales',
  '20260929 mini-callback cloud-push verification-only no-sales']);
const oldEnvKeys = new Set(['WECHAT_APP_ID', 'XPAY_MODE', 'XPAY_ENABLED', 'XPAY_MESSAGE_TOKEN',
  'XPAY_MESSAGE_AES_KEY', 'PORT', 'NODE_ENV']);
export const bundlePaths = Object.freeze(['Dockerfile', 'package.json', 'package-lock.json', 'README.md',
  'migration/mini-identity-schema-v1.sql', ...['database.js', 'ledger.js', 'reservation-transactions.js', 'wechat.js', 'runtime.js',
    'mysql-transport.js', 'products.js', 'routes.js', 'reconciliation.js', 'message-endpoint.js',
    'cloud-message-endpoint.js', 'cloud-business-endpoint.js', 'mini-identity.js',
    'mini-sandbox-service.js', 'mini-sandbox-server.js', 'admin.html', 'admin.js'].map(name => `payments/virtual/${name}`)]);
const secretKeys = ['WECHAT_APP_SECRET', 'XPAY_SANDBOX_APP_KEY', 'XPAY_MYSQL_PASSWORD',
  'XPAY_SESSION_ENCRYPTION_KEY', 'XPAY_MESSAGE_TOKEN', 'XPAY_MESSAGE_AES_KEY'];
const sourceKeys = ['WECHAT_APP_ID', 'XPAY_OFFER_ID', ...secretKeys, 'XPAY_CLOUD_ENV_ID',
  'XPAY_MYSQL_INSTANCE_ID', 'XPAY_MYSQL_HOST', 'XPAY_MYSQL_PORT', 'XPAY_MYSQL_USER', 'XPAY_MYSQL_DATABASE'];
const stable = value => JSON.stringify(value, (key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item);
const same = (a, b) => stable(a) === stable(b);
const parseEnv = config => {
  try { const value = JSON.parse(config?.envParams || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('SERVICE_SCOPE_MISMATCH'); return value;
  } catch { fail('SERVICE_SCOPE_MISMATCH'); }
};
const versionName = value => typeof value === 'string' && /^buildtest-\d+$/.test(value);
const taskFinished = task => task?.status === 'finished';
const taskFailed = task => task?.status === 'failed'
  || (taskFinished(task) && task.steps?.some(step => step.status === 'failed'));
const explicitPrivateIngress = inventory => same(inventory?.accessTypes, ['MINIAPP'])
  && same(inventory?.baseConfig?.openAccessTypes, ['MINIAPP'])
  && [false, null, undefined].includes(inventory.baseConfig.publicAccess);
// The service API omits publicAccess and reports port=0 for this existing
// private MINIAPP service. Ingress is proven by both access-type fields and a
// real public 403 probe; a returned true remains an immediate failure.
const privateService = inventory => explicitPrivateIngress(inventory);
const activeVersion = inventory => {
  const active = inventory?.versions?.filter(item => item.FlowRatio > 0);
  return active?.length === 1 && active[0].FlowRatio === 100 && active[0].Status === 'normal' ? active[0] : null;
};

export function deploymentEnvironment(payment) {
  if (payment?.XPAY_ENABLED !== 'false' || payment.XPAY_MODE !== 'closed' || payment.XPAY_ENV !== '1'
    || payment.RELEASE_CHANNEL !== 'wechat-mini-program' || payment.AUTH_MODE !== 'wechat'
    || payment.XPAY_MYSQL_TRANSPORT !== privateSandboxTransport || payment.XPAY_DB_BACKEND !== 'mysql'
    || payment.WECHAT_APP_ID !== target.appId || payment.XPAY_OFFER_ID !== '1450662722'
    || sourceKeys.some(key => !present(payment[key])) || !/^[0-9a-f]{64}$/i.test(payment.XPAY_SESSION_ENCRYPTION_KEY)
    || payment.XPAY_MYSQL_CA_FILE?.trim()) fail('LOCAL_CONFIGURATION_INVALID');
  try {
    virtualMysqlOptions(payment, { allowCloudrunPrivateSandbox: true });
    createMessageCodec({ appId: payment.WECHAT_APP_ID, token: payment.XPAY_MESSAGE_TOKEN, aesKey: payment.XPAY_MESSAGE_AES_KEY });
  } catch { fail('LOCAL_CONFIGURATION_INVALID'); }
  return { ...Object.fromEntries(sourceKeys.map(key => [key, payment[key]])),
    RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', DEPLOY_ENV: 'production', NODE_ENV: 'production',
    PORT: '3000', XPAY_ENABLED: 'true', XPAY_MODE: 'closed', XPAY_ENV: '1', XPAY_DB_BACKEND: 'mysql',
    XPAY_MYSQL_TRANSPORT: privateSandboxTransport, XPAY_PRODUCTS_JSON: '[]', XPAY_PURPOSE_RULES_JSON: '{}',
    XPAY_RECONCILE_ENABLED: 'false' };
}

// Read the exact reviewed file bytes once; never glob a candidate containing
// node_modules, private files or later editor output into the uploaded archive.
export function readBundle(directory, expectedHash) {
  try {
    if (!path.isAbsolute(directory) || fs.lstatSync(directory).isSymbolicLink()) fail('BUNDLE_INVALID');
    const root = fs.realpathSync(directory);
    const read = relative => {
      const full = path.join(root, relative);
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) fail('BUNDLE_INVALID');
      const resolved = fs.realpathSync(full);
      const rel = path.relative(root, resolved);
      if (rel.startsWith('..') || path.isAbsolute(rel) || resolved !== full) fail('BUNDLE_INVALID');
      return fs.readFileSync(full);
    };
    const manifestBytes = read('manifest.json'), manifestHash = hash(manifestBytes);
    if (expectedHash && expectedHash !== manifestHash) fail('BUNDLE_HASH_MISMATCH');
    const manifest = JSON.parse(manifestBytes);
    // New candidates must state the payment environment and cash risk explicitly.
    // Legacy manifest hashes remain source evidence in the fixed confirmed journal;
    // an old "realMoneyAllowed:false" manifest is never accepted for a new upload.
    if (!manifest || !same(Object.keys(manifest).sort(),
      ['version', 'scope', 'env', 'productionPaymentsEnabled', 'sandboxMayCharge', 'files'].sort())
      || manifest.version !== 2 || manifest.scope !== 'sandbox-only' || manifest.env !== 1
      || manifest.productionPaymentsEnabled !== false || manifest.sandboxMayCharge !== true
      || !Array.isArray(manifest.files) || !same(manifest.files.map(f => f.path).sort(), [...bundlePaths].sort())) fail('BUNDLE_INVALID');
    const entries = manifest.files.map(item => {
      const bytes = read(item.path);
      if (!Number.isSafeInteger(item.bytes) || bytes.length !== item.bytes || hash(bytes) !== item.sha256) fail('BUNDLE_INVALID');
      return { name: item.path, bytes };
    });
    entries.push({ name: 'manifest.json', bytes: manifestBytes });
    if (entries.reduce((n, item) => n + item.bytes.length, 0) > 8 * 1024 * 1024) fail('BUNDLE_INVALID');
    return { directory: root, manifestHash, entries };
  } catch (error) { fail(error.message === 'BUNDLE_HASH_MISMATCH' ? error.message : 'BUNDLE_INVALID'); }
}

function cliRequire() {
  return createRequire(path.join(process.env.WXCLOUD_CLI_ROOT || path.join(process.env.LOCALAPPDATA || '',
    'leyanxiu-toolchains/wxcloud-cli/node_modules/@wxcloud/cli'), 'package.json'));
}

export async function packageBundle(bundle, archiver = cliRequire()('archiver')) {
  const archive = archiver('zip', { zlib: { level: 9 } });
  const chunks = [];
  return new Promise((resolve, reject) => {
    archive.on('data', chunk => chunks.push(chunk)); archive.on('error', () => reject(new Error('BUNDLE_INVALID')));
    archive.on('warning', () => reject(new Error('BUNDLE_INVALID')));
    archive.on('end', () => resolve(Buffer.concat(chunks)));
    for (const entry of bundle.entries) archive.append(entry.bytes, { name: entry.name, date: new Date('2026-01-01T00:00:00Z'), mode: 0o644 });
    archive.finalize().catch(() => reject(new Error('BUNDLE_INVALID')));
  });
}

export function validateService(inventory, variables, expectedVersion) {
  const active = activeVersion(inventory);
  const before = parseEnv(inventory.baseConfig);
  const checks = {
    environment: inventory.environmentConfirmed === true,
    privateService: privateService(inventory),
    finishedTask: taskFinished(inventory.task) && Number.isSafeInteger(inventory.task?.id) && inventory.task.id > 0
      && inventory.task.envId === target.cloudEnvId && inventory.task.serverName === target.serviceName,
    expectedVersion: versionName(expectedVersion) && active?.VersionName === expectedVersion,
    callbackOnly: oldRemarks.has(active?.Remark) && before.WECHAT_APP_ID === target.appId
      && before.XPAY_MODE === 'closed' && before.XPAY_ENABLED === 'false'
      && Object.keys(before).every(key => oldEnvKeys.has(key)),
    preservesCallback: before.XPAY_MESSAGE_TOKEN === variables.XPAY_MESSAGE_TOKEN
      && before.XPAY_MESSAGE_AES_KEY === variables.XPAY_MESSAGE_AES_KEY,
    noOtherRunningVersion: Array.isArray(inventory.versions) && inventory.versions.every(item => item === active
      || (item.FlowRatio === 0 && ['normal', 'build_failed', 'deploy_failed', 'create_failed'].includes(item.Status))),
    preservesCapacity: [0, 3000].includes(inventory.baseConfig?.port)
      && inventory.activeVersionPort === 3000 && inventory.baseConfig?.minNum === 0
      && inventory.baseConfig?.maxNum === 1,
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

function recordSource(record) {
  if (record?.releaseProfile === closeProfile) return record.upgradeFrom;
  if (record?.releaseProfile === resumeProfile) return resumeSource;
  return record?.releaseProfile === repairProfile ? repairSource
    : record?.releaseProfile !== undefined ? nextUpgradeSource : upgradeSource;
}

function validCloseSource(source) {
  return source && same(Object.keys(source).sort(), ['operationId', 'releaseTaskId', 'version', 'manifestSha256'].sort())
    && /^[a-f0-9]{24}$/.test(source.operationId) && Number.isSafeInteger(source.releaseTaskId) && source.releaseTaskId > 0
    && versionName(source.version) && Number(source.version.slice('buildtest-'.length)) > 11
    && /^[a-f0-9]{64}$/.test(source.manifestSha256);
}

function acceptanceCloseSource(record, version) {
  if (record?.phase !== 'submitted' || record.releaseProfile !== resumeProfile
    || !same(record.upgradeFrom, resumeSource)) fail('UPGRADE_SOURCE_UNCONFIRMED');
  const source = { operationId: record.operationId, releaseTaskId: record.releaseTaskId,
    version, manifestSha256: record.manifestSha256 };
  if (!validCloseSource(source)) fail('UPGRADE_SOURCE_UNCONFIRMED');
  return source;
}

function validateRecord(record) {
  const repair = record?.releaseProfile === repairProfile;
  const acceptance = acceptanceProfiles.includes(record?.releaseProfile);
  const next = record?.releaseProfile !== undefined && !repair && !acceptance;
  const source = recordSource(record);
  if (record?.releaseProfile === closeProfile && !validCloseSource(source)) fail('PENDING_INVALID');
  if (!record || record.version !== 1 || !same(record.target, target)
    || !/^[a-f0-9]{24}$/.test(record.operationId) || record.remark !== `mini-payment-sandbox ${record.variables?.XPAY_MODE} env1 ${record.operationId}`
    || hash(stable(record.before)) !== record.beforeDigest || !versionName(record.before?.version)
    || !Number.isSafeInteger(record.before?.taskId) || record.before.taskId <= 0
    || !Array.isArray(record.before?.versions) || !record.desiredConfig
    || !same(parseEnv(record.desiredConfig), record.variables)
    || !(next ? nextProfiles.includes(record.releaseProfile)
      : record.variables?.XPAY_MODE === (record.releaseProfile === resumeProfile ? 'sandbox' : 'closed')) || record.variables?.XPAY_ENV !== '1'
    || record.variables?.XPAY_MYSQL_TRANSPORT !== privateSandboxTransport
    || record.variables?.WECHAT_APP_ID !== target.appId
    || !['prepared', 'configure_requested', 'configured', 'upload_authorization_requested', 'upload_ready',
      'upload_requested', 'uploaded', 'release_requested', 'submitted', 'rollback_requested', 'rollback_submitted',
      'restore_requested', 'rolled_back'].includes(record.phase)) fail('PENDING_INVALID');
  try {
    const base = deploymentEnvironment({ ...record.variables, XPAY_ENABLED: 'false', XPAY_MODE: 'closed' });
    if (acceptance) {
      const before = parseEnv(record.before.baseConfig);
      if (!nextEnvironmentMatches(base, { ...before, XPAY_MODE: 'sandbox' }, 'sandbox-ledger')
        || !acceptanceEnvironmentMatches(before, record.variables, record.releaseProfile)) fail('PENDING_INVALID');
    } else if (repair) {
      const before = parseEnv(record.before.baseConfig);
      if (!nextEnvironmentMatches(base, before, 'sandbox-ledger') || !repairEnvironmentMatches(before, record.variables)) fail('PENDING_INVALID');
    } else if (!(next ? nextEnvironmentMatches(base, record.variables, record.releaseProfile) : same(base, record.variables))) fail('PENDING_INVALID');
  } catch { fail('PENDING_INVALID'); }
  if (((next || repair || acceptance) && !record.upgradeFrom) || (record.upgradeFrom && (!same(record.upgradeFrom, source)
    || record.before.version !== source.version || record.before.taskId !== source.releaseTaskId
    || record.operationId === source.operationId))) fail('PENDING_INVALID');
  return record;
}

function validateRecordPair(record, backup) {
  validateRecord(record); validateRecord(backup);
  if (backup.phase !== 'prepared' || ['operationId', 'beforeDigest', 'manifestSha256', 'zipSha256', 'remark', 'createdAt']
    .some(key => backup[key] !== record[key]) || !same(backup.variables, record.variables)
    || !same(backup.desiredConfig, record.desiredConfig) || !same(backup.upgradeFrom, record.upgradeFrom)
    || backup.releaseProfile !== record.releaseProfile) fail('PENDING_INVALID');
  return record;
}

export function privateFiles(root = server, { afterArchiveStep = () => {} } = {}) {
  const filename = name => path.join(root, name);
  const ignored = name => {
    try { execFileSync('git', ['check-ignore', '--quiet', '--', filename(name)], { cwd: root, stdio: 'pipe', windowsHide: true }); }
    catch { fail('PRIVATE_FILE_UNSAFE'); }
  };
  const read = name => {
    ignored(name); const stat = fs.lstatSync(filename(name));
    if (!stat.isFile() || stat.isSymbolicLink()) fail('PRIVATE_FILE_UNSAFE');
    return fs.readFileSync(filename(name), 'utf8');
  };
  const create = (name, contents) => {
    ignored(name); let fd;
    try {
      fd = fs.openSync(filename(name), 'wx', 0o600);
      if (process.platform === 'win32') {
        const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-(?:\d+-)*\d+/)?.[0];
        if (!sid) fail('PRIVATE_FILE_UNSAFE');
        execFileSync('icacls.exe', [filename(name), '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { stdio: 'pipe', windowsHide: true });
      }
      fs.writeFileSync(fd, contents); fs.fsyncSync(fd);
    } catch { fail('PRIVATE_SAVE_FAILED'); }
    finally { if (fd !== undefined) fs.closeSync(fd); }
    if (read(name) !== contents) fail('PRIVATE_SAVE_FAILED');
  };
  return {
    readConfiguration: () => ({ payment: dotenv.parse(read('.env.mini-payment')), cloud: dotenv.parse(read('.env.mini-cloud')) }),
    readPending() {
      if (fs.existsSync(filename(archiveIntentName))) fail('ARCHIVE_REQUIRES_REVIEW');
      if (!fs.existsSync(filename(recordName))) {
        if (fs.existsSync(filename(backupName))) fail('PENDING_REQUIRES_REVIEW'); return null;
      }
      try {
        return validateRecordPair(JSON.parse(read(recordName)), JSON.parse(read(backupName)));
      } catch { fail('PENDING_INVALID'); }
    },
    createPending(record) { create(backupName, `${JSON.stringify(record)}\n`); create(recordName, `${JSON.stringify(record)}\n`); },
    archiveConfirmedPending(next, previous, evidence) {
      if (fs.existsSync(filename(archiveIntentName))) fail('ARCHIVE_REQUIRES_REVIEW');
      const previousBytes = read(recordName), backupBytes = read(backupName);
      const saved = validateRecordPair(JSON.parse(previousBytes), JSON.parse(backupBytes));
      validateRecord(next);
      const repair = next.releaseProfile === repairProfile;
      const acceptance = acceptanceProfiles.includes(next.releaseProfile);
      const source = recordSource(next);
      if (!same(saved, previous) || !confirmedPredecessor(previous, source)
        || !same(next.upgradeFrom, source) || next.phase !== 'prepared'
        || !(acceptance ? acceptanceEnvironmentMatches(previous.variables, next.variables, next.releaseProfile)
          : repair ? repairEnvironmentMatches(previous.variables, next.variables)
          : next.releaseProfile !== undefined ? nextEnvironmentMatches(previous.variables, next.variables, next.releaseProfile)
          : same(next.variables, previous.variables))
        || (next.releaseProfile === closeProfile ? next.manifestSha256 !== previous.manifestSha256
          : next.manifestSha256 === previous.manifestSha256)
        || !same(evidence.source, source) || evidence.controlPlaneVerified !== true
        || !same(evidence.public403Checks?.map(item => [item.route, item.status]),
          [['/health', 403], ['/api/mini/payments/notify/cloud', 403]])) fail('UPGRADE_SOURCE_UNCONFIRMED');
      const archiveName = `.env.mini-sandbox-deploy.confirmed-${previous.operationId}.json`;
      const stagedArchive = `${archiveName}.tmp-${next.operationId}`;
      const stagedBackup = `${backupName}.tmp-${next.operationId}`, stagedPending = `${recordName}.tmp-${next.operationId}`;
      if ([archiveName, stagedArchive, stagedBackup, stagedPending].some(name => fs.existsSync(filename(name)))) fail('ARCHIVE_REQUIRES_REVIEW');
      const archive = `${JSON.stringify({ version: 1, target, evidence, previousPending: saved,
        previousBackup: JSON.parse(backupBytes), nextOperationId: next.operationId })}\n`;
      const nextBytes = `${JSON.stringify(next)}\n`;
      // Intent is durable before any replacement. A crash at every following
      // boundary blocks all normal commands instead of guessing a fresh run.
      create(archiveIntentName, `${JSON.stringify({ version: 1, target, archiveName, archiveSha256: hash(archive),
        previousOperationId: previous.operationId, previousPendingSha256: hash(previousBytes),
        previousBackupSha256: hash(backupBytes), nextOperationId: next.operationId, nextRecordSha256: hash(nextBytes) })}\n`);
      afterArchiveStep('intent');
      create(stagedArchive, archive);
      if (fs.existsSync(filename(archiveName))) fail('ARCHIVE_REQUIRES_REVIEW');
      fs.renameSync(filename(stagedArchive), filename(archiveName));
      if (read(archiveName) !== archive) fail('PRIVATE_SAVE_FAILED');
      afterArchiveStep('archive');
      create(stagedBackup, nextBytes); create(stagedPending, nextBytes);
      if (read(recordName) !== previousBytes || read(backupName) !== backupBytes) fail('PENDING_INVALID');
      fs.renameSync(filename(stagedBackup), filename(backupName)); afterArchiveStep('backup');
      fs.renameSync(filename(stagedPending), filename(recordName)); afterArchiveStep('pending');
      if (read(backupName) !== nextBytes || read(recordName) !== nextBytes || read(archiveName) !== archive) fail('PRIVATE_SAVE_FAILED');
      afterArchiveStep('verified');
      fs.unlinkSync(filename(archiveIntentName));
      return { archiveName };
    },
    updatePending(record, before) {
      const original = `${JSON.stringify(before)}\n`, next = `${JSON.stringify(record)}\n`;
      if (record.operationId !== before.operationId || record.beforeDigest !== before.beforeDigest
        || !same(record.before, before.before) || read(recordName) !== original) fail('PENDING_INVALID');
      const temporary = `${recordName}.tmp-${crypto.randomBytes(8).toString('hex')}`;
      create(temporary, next);
      try {
        if (read(recordName) !== original) fail('PENDING_INVALID');
        fs.renameSync(filename(temporary), filename(recordName));
        if (read(recordName) !== next) fail('PRIVATE_SAVE_FAILED');
      } finally { if (fs.existsSync(filename(temporary))) fs.unlinkSync(filename(temporary)); }
    },
    async withLock(operation) {
      if (fs.existsSync(filename(lockName))) fail('OPERATION_LOCKED');
      const marker = crypto.randomBytes(24).toString('hex'); create(lockName, marker);
      try { return await operation(); }
      finally { if (read(lockName) === marker) fs.unlinkSync(filename(lockName)); }
    },
  };
}

// SDK diagnostics can contain authorization headers or full envParams. The
// SDK runs only inside this scope; emit our bounded report after restoration.
export async function silenceSdk(operation) {
  const methods = ['log', 'error', 'warn', 'debug', 'info', 'trace', 'dir', 'table'];
  const prior = Object.fromEntries(methods.map(key => [key, console[key]]));
  const stdout = process.stdout.write, stderr = process.stderr.write;
  const discard = (chunk, encoding, callback) => { const cb = typeof encoding === 'function' ? encoding : callback; cb?.(); return true; };
  for (const key of methods) console[key] = () => {};
  process.stdout.write = discard; process.stderr.write = discard;
  try { return await operation(); }
  finally { Object.assign(console, prior); process.stdout.write = stdout; process.stderr.write = stderr; }
}

// Do not restore logging while any sibling SDK request can still print a late
// transport error. Wrappers capture synchronous throws as settled rejections too.
export async function settleSdkCalls(calls) {
  const results = await Promise.allSettled(calls.map(async call => call()));
  if (results.some(result => result.status !== 'fulfilled')) fail('CLOUD_SCOPE_UNCONFIRMED');
  return results.map(result => result.value);
}

// A requested Limit alone does not prove that a paginated response is complete.
// Confirm TotalCount; never treat a short page alone as completion. The cloud
// proxy can ignore Offset once all retained versions have already been returned.
export async function readAllCloudVersions(describe, scope) {
  const pageSize = 10, maximum = 100, items = [], seen = new Set();
  let total;
  for (let pageNumber = 0; pageNumber <= maximum; pageNumber++) {
    const page = await describe({ ...scope, Limit: pageSize, Offset: items.length });
    if (!page || page.ServerName !== scope.ServerName || !Number.isSafeInteger(page.TotalCount)
      || page.TotalCount < 0 || page.TotalCount > maximum || !Array.isArray(page.VersionItems)
      || page.VersionItems.length > pageSize || (total !== undefined && page.TotalCount !== total)) {
      fail('CLOUD_SCOPE_UNCONFIRMED');
    }
    total = page.TotalCount;
    if (page.VersionItems.length === 0) {
      if (items.length !== total) fail('CLOUD_SCOPE_UNCONFIRMED');
      return { versions: items, totalCount: total };
    }
    if (items.length + page.VersionItems.length > total) fail('CLOUD_SCOPE_UNCONFIRMED');
    for (const item of page.VersionItems) {
      if (!versionName(item?.VersionName) || seen.has(item.VersionName)) fail('CLOUD_SCOPE_UNCONFIRMED');
      seen.add(item.VersionName); items.push(item);
    }
    if (items.length === total) return { versions: items, totalCount: total };
  }
  fail('CLOUD_SCOPE_UNCONFIRMED');
}

async function withOfficialCloud(cloud, operation) {
  return silenceSdk(async () => {
    let auth, oldAuth, axios, oldTimeout, logger, oldDebug;
    try {
      const require = cliRequire();
      ({ logger } = require('./lib/utils/log.js')); oldDebug = logger.debug; logger.debug = () => {};
      axios = require('axios'); oldTimeout = axios.defaults.timeout; axios.defaults.timeout = 20000;
      auth = require('./lib/utils/auth.js'); oldAuth = auth.readLoginState;
      auth.readLoginState = async () => ({ appid: target.appId, privateKey: cloud.WXCLOUD_PRIVATE_KEY.trim() });
      if (!await auth.checkLoginState(target.appId, cloud.WXCLOUD_PRIVATE_KEY.trim())) fail('OFFICIAL_AUTH_UNCONFIRMED');
      require('./lib/api/adapter.js').initCloudAPI(target.appId);
      require('./lib/api/common.js').setApiCommonParameters({ region: target.region });
      const api = require('./lib/api/index.js'), { CloudAPI } = require('@wxcloud/core');
      const scope = { envId: target.cloudEnvId, serverName: target.serviceName };
      const direct = { EnvId: target.cloudEnvId, ServerName: target.serviceName };
      const dbScope = { envId: target.cloudEnvId, wxAppId: target.appId };
      const adapter = {
        async inspect() {
          const [envs, base, versionList, domain, task, detail, accounts] = await settleSdkCalls([
            () => api.DescribeWxCloudBaseRunEnvs(), () => CloudAPI.tcbDescribeServiceBaseConfig(scope),
            () => readAllCloudVersions(params => api.DescribeCloudBaseRunServer(params), direct),
            () => api.DescribeCloudBaseRunServiceDomain({ EnvId: target.cloudEnvId, ServiceName: target.serviceName }),
            () => CloudAPI.tcbDescribeServerManageTask(scope), () => CloudAPI.tcbDescribeWxCloudBaseRunDBClusterDetail(dbScope),
            () => CloudAPI.tcbDescribeWxCloudBaseRunDBAccounts(dbScope),
          ]);
          const versions = versionList.versions;
          const active = versions.filter(item => item.FlowRatio > 0);
          const version = active?.length === 1 && versionName(active[0].VersionName)
            ? await CloudAPI.tcbDescribeCloudBaseRunServerVersion({ ...scope, versionName: active[0].VersionName }) : null;
          return { environmentConfirmed: envs.EnvList?.some(item => item.EnvId === target.cloudEnvId) === true,
            baseConfig: base.serviceBaseConfig, versions, versionsComplete: true, versionTotalCount: versionList.totalCount,
            activeVersionPort: version?.containerPort,
            accessTypes: domain.AccessTypes, publicDomain: domain.DefaultPublicDomain, task: task.task, detail, accounts };
        },
        updateConfig: conf => CloudAPI.tcbUpdateServerBaseConfig({ ...scope, wxAppId: target.appId, conf: normalizedConfig(conf) }),
        prepareUpload: () => api.DescribeCloudBaseBuildService({ EnvId: target.cloudEnvId, ServiceName: target.serviceName }),
        async upload(url, bytes) {
          const result = await axios.put(url, bytes, { headers: { 'content-type': 'application/zip' }, maxRedirects: 0, timeout: 60000 });
          if (![200, 204].includes(result.status)) fail('UPLOAD_UNCONFIRMED');
        },
        release: record => CloudAPI.tcbSubmitServerRelease({ ...scope, wxAppId: target.appId, deployType: 'package', releaseType: 'FULL',
          hasDockerfile: true, buildDir: '.', dockerfile: 'Dockerfile', port: 3000,
          packageName: record.packageName, packageVersion: record.packageVersion,
          versionRemark: record.remark, operatorRemark: record.remark }),
        rollback: record => CloudAPI.tcbSubmitServerRollback({ ...scope, wxAppId: target.appId,
          currentVersionName: record.releaseVersion, rollbackVersionName: record.before.version,
          operatorRemark: `${record.remark} rollback` }),
        task: async taskId => (await CloudAPI.tcbDescribeServerManageTask({ ...scope, taskId })).task,
      };
      return await operation(adapter);
    } finally {
      if (auth && oldAuth) auth.readLoginState = oldAuth;
      if (logger && oldDebug) logger.debug = oldDebug;
      if (axios) axios.defaults.timeout = oldTimeout;
    }
  });
}

const safeVersion = value => versionName(value) ? value : null;
const validTaskId = value => Number.isSafeInteger(value) && value > 0;
const taskMatches = (task, id) => validTaskId(id) && task?.id === id
  && task.envId === target.cloudEnvId && task.serverName === target.serviceName;
const versionStatuses = new Set(['normal', 'creating', 'building', 'deploying', 'build_failed', 'deploy_failed', 'create_failed', 'stopped']);
const taskStatuses = new Set(['todo', 'running', 'finished', 'failed']);
const accessSummary = value => Array.isArray(value)
  ? value.map(item => ['MINIAPP', 'PUBLIC', 'PUBLICGATEWAY', 'INNER'].includes(item) ? item : 'unrecognized')
  : value === null ? 'null' : typeof value;
const summary = inventory => ({ service: target.serviceName, privateService: privateService(inventory),
  accessEvidence: { domainAccessTypes: accessSummary(inventory.accessTypes),
    baseAccessTypes: accessSummary(inventory.baseConfig?.openAccessTypes),
    publicAccessValue: typeof inventory.baseConfig?.publicAccess === 'boolean' ? inventory.baseConfig.publicAccess
      : inventory.baseConfig?.publicAccess === null ? 'null' : typeof inventory.baseConfig?.publicAccess,
    port: Number.isFinite(inventory.baseConfig?.port) ? inventory.baseConfig.port : null,
    activeVersionPort: Number.isFinite(inventory.activeVersionPort) ? inventory.activeVersionPort : null,
    min: Number.isFinite(inventory.baseConfig?.minNum) ? inventory.baseConfig.minNum : null,
    max: Number.isFinite(inventory.baseConfig?.maxNum) ? inventory.baseConfig.maxNum : null },
  versions: (inventory.versions || []).map(v => ({ name: safeVersion(v.VersionName),
    status: versionStatuses.has(v.Status) ? v.Status : 'unknown', flow: Number.isFinite(v.FlowRatio) ? v.FlowRatio : null })),
  task: { status: taskStatuses.has(inventory.task?.status) ? inventory.task.status : 'unknown',
    version: safeVersion(inventory.task?.versionName) } });
export function normalizedConfig(input) {
  const result = { ...input, envParams: JSON.stringify(parseEnv(input)), logType: input.logType || 'none' };
  result.policyDetails = input.policyType && input.policyThreshold
    ? [{ policyType: input.policyType, policyThreshold: input.policyThreshold }]
    : input.policyDetails?.length ? input.policyDetails : [{ policyThreshold: 60, policyType: 'cpu' }];
  result.policyType = ''; result.policyThreshold = 0;
  // Keep the SDK's response identity fields, matching the CLI's
  // preprocessBaseConfig behavior. The Cloud API maps these fields into its
  // Conf object and some service versions reject an otherwise identical
  // update when they are omitted.
  return result;
}
const comparableConfig = config => {
  const value = { ...config };
  if (value.publicAccess === undefined || value.publicAccess === null) value.publicAccess = false;
  if (value.port === 0 && value.containerPort === undefined) value.port = 3000;
  return value;
};
const configMatches = (inventory, wanted) => privateService(inventory)
  && inventory.activeVersionPort === 3000
  && same({ ...normalizedConfig(comparableConfig(inventory.baseConfig)), envParams: parseEnv(inventory.baseConfig) },
    { ...normalizedConfig(comparableConfig(wanted)), envParams: parseEnv(wanted) });
const stillBeforeRelease = (inventory, record) => activeVersion(inventory)?.VersionName === record.before.version
  && same(inventory.versions.map(v => v.VersionName).sort(), record.before.versions.map(v => v.VersionName).sort())
  && inventory.task?.id === record.before.taskId && taskFinished(inventory.task) && configMatches(inventory, record.desiredConfig);

function confirmedPredecessor(record, source) {
  if (validCloseSource(source)) {
    try { return same(acceptanceCloseSource(record, source.version), source); } catch { return false; }
  }
  if (same(source, resumeSource)) return record?.phase === 'submitted' && record.releaseProfile === repairProfile
    && record.operationId === resumeSource.operationId && record.releaseTaskId === resumeSource.releaseTaskId
    && same(record.upgradeFrom, repairSource) && record.manifestSha256 === resumeSourceManifest;
  // Preserve historical records and their pinned hashes as evidence only. In
  // particular, a submitted 009 -> 010 profile cannot become the 009 source again.
  if (same(source, repairSource)) return record?.phase === 'submitted' && record.releaseProfile === 'sandbox-ledger'
    && record.operationId === repairSource.operationId && record.releaseTaskId === repairSource.releaseTaskId
    && same(record.upgradeFrom, nextUpgradeSource) && record.manifestSha256 === repairSourceManifest;
  return record?.phase === 'submitted' && record.releaseProfile === undefined
    && record.operationId === source.operationId && record.releaseTaskId === source.releaseTaskId
    && (same(source, nextUpgradeSource)
      ? same(record.upgradeFrom, upgradeSource) && record.manifestSha256 === nextSourceManifest
      : !record.upgradeFrom);
}

// WeChat CloudRun automatically retains the latest ten versions (official TCB
// notice: https://developer.cloud.tencent.com/article/1949490). Preserve the
// journal unchanged; recognize only eviction of its oldest inactive version
// when the official complete count proves the remaining ten. No arbitrary
// deletion, unknown version, active source or rollback target may be omitted.
function expectedVersionSetMatches(inventory, record, source) {
  const before = record?.before?.versions, actual = inventory.versions?.map(v => v.VersionName);
  if (!Array.isArray(before) || !Array.isArray(actual)) return false;
  const expected = [...before.map(v => v.VersionName), source.version];
  if (new Set(expected).size !== expected.length || new Set(actual).size !== actual.length) return false;
  if (same([...actual].sort(), [...expected].sort())) return true;
  if (before.length !== 10 || inventory.versionsComplete !== true || inventory.versionTotalCount !== 10
    || actual.length !== 10 || expected.some(name => !versionName(name)
      || !Number.isSafeInteger(Number(name.slice('buildtest-'.length))))) return false;
  expected.sort((a, b) => Number(a.slice('buildtest-'.length)) - Number(b.slice('buildtest-'.length)));
  const evicted = before.find(v => v.VersionName === expected[0]);
  return expected.at(-1) === source.version && evicted?.FlowRatio === 0
    && ['normal', 'build_failed', 'deploy_failed', 'create_failed'].includes(evicted.Status)
    && evicted.VersionName !== record.before.version
    && same([...actual].sort(), expected.slice(1).sort());
}

function validateUpgrade(inventory, variables, expectedVersion, record, controlPlaneVerified, manifestHash,
  source = upgradeSource, profile) {
  const active = activeVersion(inventory);
  const checks = {
    confirmedSource: confirmedPredecessor(record, source) && controlPlaneVerified === true,
    expectedVersion: expectedVersion === source.version && active?.VersionName === source.version,
    exactEnvironmentUnchanged: Boolean(record && same(parseEnv(inventory.baseConfig), record.variables)),
    approvedEnvironmentDelta: Boolean(record && (acceptanceProfiles.includes(profile)
      ? acceptanceEnvironmentMatches(record.variables, variables, profile) : profile === repairProfile
      ? repairEnvironmentMatches(record.variables, variables) : profile !== undefined
      ? nextEnvironmentMatches(record.variables, variables, profile) : same(variables, record.variables))),
    exactVersionSet: expectedVersionSetMatches(inventory, record, source),
    // Closing changes only the mode: it must reuse the exact resumed code. Resume
    // requires a new reviewed candidate; both still pass strict v2 bundle checks.
    newReviewedBundle: Boolean(record && (profile === closeProfile
      ? manifestHash === record.manifestSha256 : manifestHash !== record.manifestSha256)),
    privateService: privateService(inventory),
    preservesCapacity: [0, 3000].includes(inventory.baseConfig?.port) && inventory.activeVersionPort === 3000
      && inventory.baseConfig?.minNum === 0 && inventory.baseConfig?.maxNum === 1,
    noOtherRunningVersion: Array.isArray(inventory.versions) && inventory.versions.every(item => item === active
      || (item.FlowRatio === 0 && ['normal', 'build_failed', 'deploy_failed', 'create_failed'].includes(item.Status))),
  };
  return { passed: Object.values(checks).every(Boolean), checks };
}

export async function verifyPublicClosed(inventory, fetchImpl = fetch) {
  if (!explicitPrivateIngress(inventory)) fail('PUBLIC_ACCESS_UNCONFIRMED');
  let origin;
  try {
    origin = new URL(inventory.publicDomain.includes('://') ? inventory.publicDomain : `https://${inventory.publicDomain}`);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port || origin.pathname !== '/'
      || origin.search || origin.hash || !/^buildtest-[a-z0-9-]+\.sh\.run\.tcloudbase\.com$/.test(origin.hostname)) fail('PUBLIC_ACCESS_UNCONFIRMED');
  } catch { fail('PUBLIC_ACCESS_UNCONFIRMED'); }
  const checks = [];
  for (const route of ['/health', '/api/mini/payments/notify/cloud']) {
    const response = await fetchImpl(new URL(route, origin), { redirect: 'error', signal: AbortSignal.timeout(10000),
      ...(route === '/health' ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json',
        'x-wx-source': 'forged-public-source', 'x-wx-sources': 'forged-public-source' }, body: '{"action":"CheckContainerPath"}' }) });
    await response.body?.cancel(); checks.push({ route, status: response.status });
    if (response.status !== 403) fail('PUBLIC_ACCESS_UNCONFIRMED');
  }
  return checks;
}

export async function main({ action = 'status', bundleDirectory, manifestSha256, expectedVersion, profile,
  files = privateFiles(), withCloud = withOfficialCloud, loadBundle = readBundle, zip = packageBundle,
  fetchImpl = fetch, operationId = () => crypto.randomBytes(12).toString('hex'), now = () => new Date().toISOString() } = {}) {
  const report = { action, target, changedRemoteState: false, submitted: false,
    env: 1, productionPaymentsEnabled: false, sandboxMayCharge: true,
    privateHealthVerified: false, databaseLoginVerified: false, schemaVerified: false, sandboxPurchaseReadinessVerified: false };
  let record;
  const save = patch => { const next = { ...record, ...patch }; validateRecord(next); files.updatePending(next, record); record = next; };
  try {
    if (!['status', 'plan', 'deploy', 'plan-upgrade', 'upgrade', 'plan-next', 'deploy-next', 'plan-repair', 'deploy-repair', 'plan-resume', 'deploy-resume', 'plan-close', 'deploy-close', 'rollback', 'verify-public', 'reconcile'].includes(action)) fail('ARGUMENT_INVALID');
    const next = ['plan-next', 'deploy-next'].includes(action);
    const repair = ['plan-repair', 'deploy-repair'].includes(action);
    const resume = ['plan-resume', 'deploy-resume'].includes(action);
    const close = ['plan-close', 'deploy-close'].includes(action);
    const acceptance = resume || close;
    if ((profile !== undefined && !next) || (next && !nextProfiles.includes(profile || 'closed'))) fail('ARGUMENT_INVALID');
    const releaseProfile = resume ? resumeProfile : close ? closeProfile : repair ? repairProfile : next ? profile || 'closed' : undefined;
    const fixedSource = resume ? resumeSource : repair ? repairSource : next ? nextUpgradeSource : upgradeSource;
    const upgrading = ['plan-upgrade', 'upgrade', 'plan-next', 'deploy-next', 'plan-repair', 'deploy-repair', 'plan-resume', 'deploy-resume', 'plan-close', 'deploy-close'].includes(action);
    if (['deploy', 'upgrade', 'plan-next', 'deploy-next', 'plan-repair', 'deploy-repair', 'plan-resume', 'deploy-resume', 'plan-close', 'deploy-close'].includes(action) && (!/^[a-f0-9]{64}$/.test(manifestSha256) || !versionName(expectedVersion))) fail('ARGUMENT_INVALID');
    if ((['upgrade', 'deploy-next'].includes(action) || next || repair || resume) && expectedVersion !== fixedSource.version) fail('UPGRADE_SOURCE_UNCONFIRMED');
    const execute = async () => {
      const config = files.readConfiguration();
      if (config.cloud?.WXCLOUD_APP_ID !== target.appId || !present(config.cloud.WXCLOUD_PRIVATE_KEY)) fail('LOCAL_CONFIGURATION_INVALID');
      record = files.readPending(); if (record) validateRecord(record);
      const source = close ? acceptanceCloseSource(record, expectedVersion) : fixedSource;
      const preparing = ['plan', 'deploy', 'plan-upgrade', 'upgrade', 'plan-next', 'deploy-next', 'plan-repair', 'deploy-repair', 'plan-resume', 'deploy-resume', 'plan-close', 'deploy-close'].includes(action);
      const baseVariables = preparing ? deploymentEnvironment(config.payment) : null;
      if (repair && (!confirmedPredecessor(record, repairSource)
        || !nextEnvironmentMatches(baseVariables, record.variables, 'sandbox-ledger'))) fail('UPGRADE_SOURCE_UNCONFIRMED');
      if (acceptance && (!confirmedPredecessor(record, source)
        || !nextEnvironmentMatches(baseVariables, { ...record.variables, XPAY_MODE: 'sandbox' }, 'sandbox-ledger'))) fail('UPGRADE_SOURCE_UNCONFIRMED');
      const variables = acceptance ? acceptanceEnvironment(record.variables, releaseProfile)
        : repair ? repairEnvironment(record.variables) : next ? nextEnvironment(baseVariables, config.payment, releaseProfile) : baseVariables;
      const bundle = preparing ? loadBundle(bundleDirectory, manifestSha256) : null;
      return withCloud(config.cloud, async api => {
        const inventory = await api.inspect();
        if (!inventory.environmentConfirmed) fail('CLOUD_SCOPE_UNCONFIRMED');
        report.cloud = summary(inventory);
        if (record) report.pending = { operationId: record.operationId, phase: record.phase, releaseVersion: safeVersion(record.releaseVersion) };
        if (record && validTaskId(record.releaseTaskId)) {
          const releaseTask = await api.task(record.releaseTaskId);
          report.releaseTask = { id: record.releaseTaskId, confirmedTarget: taskMatches(releaseTask, record.releaseTaskId),
            finished: taskFinished(releaseTask), version: safeVersion(releaseTask?.versionName) };
          report.controlPlaneDeploymentVerified = taskMatches(releaseTask, record.releaseTaskId) && taskFinished(releaseTask)
            && !taskFailed(releaseTask)
            && inventory.task?.id === record.releaseTaskId && taskFinished(inventory.task)
            && !taskFailed(inventory.task)
            && activeVersion(inventory)?.VersionName === releaseTask.versionName
            && activeVersion(inventory)?.Remark === record.remark && configMatches(inventory, record.desiredConfig);
        }
        if (record && validTaskId(record.rollbackTaskId)) {
          const rollbackTask = await api.task(record.rollbackTaskId);
          report.rollbackTask = { id: record.rollbackTaskId, confirmedTarget: taskMatches(rollbackTask, record.rollbackTaskId),
            finished: taskFinished(rollbackTask), version: safeVersion(rollbackTask?.versionName) };
        }
        if (action === 'status') return { ...report, ok: true };
        if (action === 'verify-public') return { ...report, ok: true, public403Checks: await verifyPublicClosed(inventory, fetchImpl) };
        if (action === 'reconcile') {
          // A matching snapshot is an observation, not proof that an earlier
          // timed-out request cannot apply later. Never advance or archive the
          // journal, and never turn this report into permission to retry.
          const beforeConfigObserved = Boolean(record && configMatches(inventory, record.before.baseConfig));
          const desiredConfigObserved = Boolean(record && configMatches(inventory, record.desiredConfig));
          const beforeVersionObserved = Boolean(record && activeVersion(inventory)?.VersionName === record.before.version);
          const beforeVersionSetObserved = Boolean(record && same(inventory.versions?.map(v => v.VersionName).sort(),
            record.before.versions.map(v => v.VersionName).sort()));
          const beforeTaskObserved = Boolean(record && taskMatches(inventory.task, record.before.taskId) && taskFinished(inventory.task));
          return { ...report, ok: true, reconciliation: { readOnly: true, pendingExists: Boolean(record),
            beforeConfigObserved, desiredConfigObserved, beforeVersionObserved, beforeVersionSetObserved, beforeTaskObserved,
            recordedReleaseObserved: report.controlPlaneDeploymentVerified === true,
            pendingBlocksDeployment: Boolean(record), automaticRetryAllowed: false, archivalAuthorized: false,
            observationIsFinalRequestOutcome: false } };
        }
        if (action === 'rollback') {
          if (!record) return { ...report, ok: true, rollbackComplete: false, noMutation: true };
          if (!privateService(inventory)) fail('SERVICE_SCOPE_MISMATCH');
          // Rolling back the safety fix must never reopen the predecessor's sales.
          const restoreConfig = record.releaseProfile === repairProfile || acceptanceProfiles.includes(record.releaseProfile)
            ? { ...record.before.baseConfig, envParams: JSON.stringify({ ...parseEnv(record.before.baseConfig), XPAY_MODE: 'closed' }) }
            : record.before.baseConfig;
          if (record.phase === 'rolled_back') {
            if (activeVersion(inventory)?.VersionName !== record.before.version || !configMatches(inventory, restoreConfig)) fail('RESTORE_UNCONFIRMED');
            return { ...report, ok: true, rollbackComplete: true, noMutation: true };
          }
          if (record.phase === 'restore_requested') {
            if (activeVersion(inventory)?.VersionName !== record.before.version
              || (!taskFinished(inventory.task) && !taskFailed(inventory.task))
              || ![record.before.taskId, record.releaseTaskId, record.rollbackTaskId].includes(inventory.task?.id)
              || !configMatches(inventory, restoreConfig)) fail('RESTORE_UNCONFIRMED');
            save({ phase: 'rolled_back', restoredAt: now() });
            return { ...report, ok: true, rollbackComplete: true, remoteRequestRepeated: false };
          }
          if (record.phase === 'rollback_requested') fail('PENDING_REQUIRES_REVIEW');
          if (record.phase === 'rollback_submitted') {
            const task = await api.task(record.rollbackTaskId);
            if (!taskMatches(task, record.rollbackTaskId) || !taskFinished(task) || task.versionName !== record.before.version
              || inventory.task?.id !== record.rollbackTaskId
              || activeVersion(inventory)?.VersionName !== record.before.version) fail('TASK_NOT_FINISHED');
            if (!configMatches(inventory, record.desiredConfig)) fail('SERVICE_SCOPE_MISMATCH');
          } else if (['configured', 'upload_authorization_requested', 'upload_ready', 'upload_requested', 'uploaded'].includes(record.phase)) {
            if (!stillBeforeRelease(inventory, record)) fail('SERVICE_SCOPE_MISMATCH');
          } else if (record.phase === 'submitted') {
            const task = await api.task(record.releaseTaskId);
            if (!taskMatches(task, record.releaseTaskId) || (!taskFinished(task) && !taskFailed(task)) || !versionName(task.versionName)
              || inventory.task?.id !== record.releaseTaskId || !configMatches(inventory, record.desiredConfig)) fail('TASK_NOT_FINISHED');
            if (!inventory.versions.some(v => v.VersionName === record.before.version && v.Status === 'normal')) fail('ROLLBACK_UNCONFIRMED');
            const candidate = inventory.versions.find(v => v.VersionName === task.versionName);
            const failedBeforeSwitch = taskFailed(task) && activeVersion(inventory)?.VersionName === record.before.version
              && candidate?.FlowRatio === 0 && ['build_failed', 'deploy_failed', 'create_failed'].includes(candidate.Status)
              && candidate.Remark === record.remark && inventory.versions.every(v => v.VersionName === task.versionName
                || record.before.versions.some(old => old.VersionName === v.VersionName));
            if (!failedBeforeSwitch) {
              if (!taskFinished(task) || activeVersion(inventory)?.VersionName !== task.versionName
                || activeVersion(inventory)?.Remark !== record.remark) fail('TASK_NOT_FINISHED');
              save({ phase: 'rollback_requested', releaseVersion: task.versionName, rollbackRequestedAt: now() }); report.changedRemoteState = 'unconfirmed';
              const response = await api.rollback(record);
              if (!validTaskId(response?.taskId)) fail('ROLLBACK_UNCONFIRMED');
              save({ phase: 'rollback_submitted', rollbackTaskId: response.taskId });
              return { ...report, ok: true, changedRemoteState: true, rollbackSubmitted: true, rollbackComplete: false };
            }
          } else fail('PENDING_REQUIRES_REVIEW');
          save({ phase: 'restore_requested', restoreRequestedAt: now() }); report.changedRemoteState = 'unconfirmed';
          await api.updateConfig(restoreConfig);
          const restored = await api.inspect();
          if (!configMatches(restored, restoreConfig) || activeVersion(restored)?.VersionName !== record.before.version) fail('RESTORE_UNCONFIRMED');
          save({ phase: 'rolled_back', restoredAt: now() });
          return { ...report, ok: true, changedRemoteState: true, rollbackComplete: true };
        }
        const previous = expectedVersion || activeVersion(inventory)?.VersionName;
        const service = upgrading
          ? validateUpgrade(inventory, variables, previous, record, report.controlPlaneDeploymentVerified, bundle.manifestHash, source, releaseProfile)
          : validateService(inventory, variables, previous);
        const database = validateMiniPrivateDatabase({ ...inventory, appId: target.appId,
          envId: target.cloudEnvId, config: config.payment });
        // The two control-plane access fields may omit publicAccess entirely.
        // A ready plan must also prove the public gateway denies both routes.
        if (service.passed && database.preflightPassed && (!record || upgrading)) {
          report.public403Checks = await verifyPublicClosed(inventory, fetchImpl);
        }
        const plan = { ...report, manifestSha256: bundle.manifestHash, bundleFiles: bundle.entries.length,
          expectedVersion: previous, checks: service.checks, databasePreflightPassed: database.preflightPassed,
          environmentKeys: Object.keys(variables).sort(), pendingBlocksDeployment: Boolean(record && !upgrading),
          ...(next || repair || acceptance ? { reviewedSource: source, ...nextProfileSummary(variables, releaseProfile),
            ...(repair || acceptance ? { testUserCount: variables.XPAY_TEST_USER_IDS.split(',').length, rollbackKeepsPurchasesClosed: true } : {}),
            environmentChangedKeys: Object.keys(variables).filter(key => variables[key] !== record?.variables?.[key]).sort() } : {}),
          planReady: service.passed && database.preflightPassed && (!record || upgrading) };
        if (['plan', 'plan-upgrade', 'plan-next', 'plan-repair', 'plan-resume', 'plan-close'].includes(action)) return { ...plan, ok: true };
        if (record && !upgrading) fail('PENDING_REQUIRES_REVIEW');
        if (upgrading && !service.passed) fail('UPGRADE_SOURCE_UNCONFIRMED');
        if (!service.passed) fail('SERVICE_SCOPE_MISMATCH');
        if (!database.preflightPassed) fail('DATABASE_PREFLIGHT_FAILED');
        const bytes = await zip(bundle);
        const id = operationId();
        const preceding = record;
        const before = { baseConfig: inventory.baseConfig, version: previous, taskId: inventory.task.id, accessTypes: inventory.accessTypes,
          versions: inventory.versions.map(v => ({ VersionName: v.VersionName, Status: v.Status, FlowRatio: v.FlowRatio })) };
        const nextRecord = validateRecord({ version: 1, target, operationId: id, phase: 'prepared', createdAt: now(),
          remark: `mini-payment-sandbox ${variables.XPAY_MODE} env1 ${id}`, manifestSha256: bundle.manifestHash, zipSha256: hash(bytes),
          before, beforeDigest: hash(stable(before)), variables, ...(upgrading ? { upgradeFrom: source } : {}),
          ...(next || repair || acceptance ? { releaseProfile } : {}),
          // The service API omits PublicAccess for an already-private MINIAPP
          // service. Keep the existing omission; openAccessTypes is the
          // explicit ingress control and is checked again with a real 403.
          desiredConfig: { ...before.baseConfig, envParams: JSON.stringify(variables),
            openAccessTypes: ['MINIAPP'], port: 3000 } });
        if (upgrading) {
          // Recheck the same final task/version/config immediately before the
          // local journal rotation. No cloud writes or secret changes needed.
          const fresh = await api.inspect(), sourceTask = await api.task(preceding.releaseTaskId);
          if (!same(fresh.versions, inventory.versions) || !taskMatches(sourceTask, preceding.releaseTaskId)
            || !taskFinished(sourceTask) || taskFailed(sourceTask) || sourceTask.versionName !== previous
            || fresh.task?.id !== preceding.releaseTaskId || !taskFinished(fresh.task) || taskFailed(fresh.task)
            || activeVersion(fresh)?.VersionName !== previous || activeVersion(fresh)?.Remark !== preceding.remark
            || !configMatches(fresh, preceding.desiredConfig)
            || !validateMiniPrivateDatabase({ ...fresh, appId: target.appId, envId: target.cloudEnvId, config: config.payment }).preflightPassed) fail('UPGRADE_SOURCE_UNCONFIRMED');
          const checks = await verifyPublicClosed(fresh, fetchImpl);
          files.archiveConfirmedPending(nextRecord, preceding, { source, controlPlaneVerified: true,
            public403Checks: checks, observedAt: now() });
          record = nextRecord;
          report.precedingOperationArchived = true; report.controlPlaneDeploymentVerified = false;
          report.pending = { operationId: record.operationId, phase: record.phase, releaseVersion: null };
          if ((next || repair || acceptance) && !same(variables, preceding.variables)) {
            save({ phase: 'configure_requested' }); report.changedRemoteState = 'unconfirmed';
            await api.updateConfig(record.desiredConfig);
          }
        } else {
          record = nextRecord; files.createPending(record);
          save({ phase: 'configure_requested' }); report.changedRemoteState = 'unconfirmed';
          await api.updateConfig(record.desiredConfig);
        }
        const configured = await api.inspect();
        if (!stillBeforeRelease(configured, record)) fail('CONFIGURATION_UNCONFIRMED');
        save({ phase: 'configured' });
        await verifyPublicClosed(configured, fetchImpl);
        save({ phase: 'upload_authorization_requested' });
        report.changedRemoteState = 'unconfirmed';
        const upload = await api.prepareUpload();
        let url;
        try { url = new URL(upload.UploadUrl); } catch { fail('UPLOAD_HOST_REJECTED'); }
        if (url.protocol !== 'https:' || url.username || url.password || url.port
          || (!/\.(myqcloud\.com|tencentcos\.cn)$/.test(url.hostname)
            && url.hostname !== 'cloudbaserun-code-cos.cloudbase.net')) fail('UPLOAD_HOST_REJECTED');
        if (!present(upload.PackageName) || !present(upload.PackageVersion)) fail('UPLOAD_UNCONFIRMED');
        save({ phase: 'upload_ready', packageName: upload.PackageName, packageVersion: upload.PackageVersion });
        save({ phase: 'upload_requested' }); await api.upload(url.toString(), bytes); save({ phase: 'uploaded' });
        const beforeRelease = await api.inspect();
        if (!stillBeforeRelease(beforeRelease, record)) fail('VERSION_CHANGED');
        await verifyPublicClosed(beforeRelease, fetchImpl);
        save({ phase: 'release_requested', releaseRequestedAt: now() });
        const release = await api.release(record);
        if (!validTaskId(release?.taskId)) fail('RELEASE_UNCONFIRMED');
        save({ phase: 'submitted', releaseTaskId: release.taskId });
        return { ...plan, ok: true, changedRemoteState: true, submitted: true, operationId: id,
          controlPlaneDeploymentVerified: false,
          pending: { operationId: id, phase: record.phase, releaseVersion: null },
          ...(upgrading ? { precedingOperationArchived: true, upgradeFrom: source } : {}),
          releaseTaskId: record.releaseTaskId, deploymentVerified: false };
      });
    };
    return await (['deploy', 'upgrade', 'deploy-next', 'deploy-repair', 'deploy-resume', 'deploy-close', 'rollback'].includes(action) ? files.withLock(execute) : execute());
  } catch (error) {
    return { ...report, ok: false, failureCode: safeCode(error),
      ...(record ? { pending: { operationId: record.operationId, phase: record.phase, releaseVersion: safeVersion(record.releaseVersion) } } : {}) };
  }
}

export function parseArguments(args) {
  const result = { action: args[0] || 'status' };
  const names = { '--bundle': 'bundleDirectory', '--manifest-sha256': 'manifestSha256', '--expected-version': 'expectedVersion', '--profile': 'profile' };
  for (let i = 1; i < args.length; i += 2) {
    const key = names[args[i]];
    if (!key || result[key] !== undefined || !args[i + 1] || args[i + 1].startsWith('--')) fail('ARGUMENT_INVALID');
    result[key] = args[i + 1];
  }
  if (!['status', 'plan', 'deploy', 'plan-upgrade', 'upgrade', 'plan-next', 'deploy-next', 'plan-repair', 'deploy-repair', 'plan-resume', 'deploy-resume', 'plan-close', 'deploy-close', 'rollback', 'verify-public', 'reconcile'].includes(result.action)
    || (['status', 'rollback', 'verify-public', 'reconcile'].includes(result.action) && args.length > 1)
    || (result.profile !== undefined && (!['plan-next', 'deploy-next'].includes(result.action) || !nextProfiles.includes(result.profile)))
    || (['plan', 'deploy', 'plan-upgrade', 'upgrade', 'plan-next', 'deploy-next', 'plan-repair', 'deploy-repair', 'plan-resume', 'deploy-resume', 'plan-close', 'deploy-close'].includes(result.action) && !result.bundleDirectory)) fail('ARGUMENT_INVALID');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try { result = await main(parseArguments(process.argv.slice(2))); }
  catch (error) { result = { ok: false, failureCode: safeCode(error), changedRemoteState: false }; }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}
