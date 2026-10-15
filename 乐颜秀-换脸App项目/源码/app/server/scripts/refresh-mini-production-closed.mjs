import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { withProductionCloud, productionCloud } from './inspect-mini-production-cloud.mjs';
import { validateGrayRecord } from './deploy-mini-production-gray.mjs';
import { verifyPhotoProductionBundle } from './build-mini-photo-production.mjs';
import { packageBundle, settleSdkCalls } from './deploy-mini-sandbox-cloud.mjs';

// One closed refresh after the console canceled 014's test release. This does
// not cancel, promote, change traffic, update base config, or rotate any key.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const oldFile = path.join(server, '.env.mini-production-gray.json');
const stateFile = path.join(server, '.env.mini-production-refresh015.json');
export const refreshTarget = Object.freeze({ ...productionCloud, serverName: 'buildtest',
  currentVersion: 'buildtest-013', previousVersion: 'buildtest-014',
  previousTaskId: 2335630, canceledReleaseId: 2830122,
  manifestSha256: '347f8f8ec7889d1cc19adb1c256857780c9e2fa6fbf61e348b84d6e8efa539ed' });
const scope = { envId: refreshTarget.envId, serverName: refreshTarget.serverName };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(code); };
const data = value => JSON.parse(JSON.stringify(value));
const env = value => JSON.parse(value || '{}');
const phases = ['prepared', 'upload_authorization_requested', 'upload_ready', 'upload_requested',
  'uploaded', 'release_requested', 'submitted'];
const mutable = new Set(['phase', 'packageName', 'packageVersion', 'taskId', 'releaseRequestedAt']);
const immutable = record => Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)));
const comparableBase = base => data({ ...base, envParams: env(base.envParams) });
const versionConfig = raw => data(Object.fromEntries(Object.entries(raw).filter(([key]) =>
  !['RequestId', 'CreatedTime', 'UpdatedTime', 'Status', 'CpuTotalQuota', 'MemTotalQuota', 'VersionIP'].includes(key))));
const compareVersion = raw => ({ ...versionConfig(raw), EnvParams: env(raw.EnvParams) });
const versionIdentity = versions => versions.map(v => ({ name: v.VersionName, status: v.Status }))
  .sort((a, b) => a.name.localeCompare(b.name));
const orderIdentity = order => {
  const o = order.releaseOrderInfo;
  return { exists: order.isExist, id: o?.id, serverName: o?.serverName,
    current: o?.currentVersion?.versionName, candidate: o?.releaseVersion?.versionName,
    status: o?.releaseStatus, isReleasing: o?.isReleasing };
};

function privateRead(filename) {
  execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true });
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) fail('REFRESH_PRIVATE_FILE_INVALID');
  return fs.readFileSync(filename, 'utf8');
}
function privateCreate(filename, content) {
  execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true });
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true })
        .match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) fail('REFRESH_PRIVATE_FILE_INVALID');
      execFileSync('icacls.exe', [filename, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'],
        { stdio: 'pipe', windowsHide: true });
    }
    fs.writeFileSync(fd, content); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (privateRead(filename) !== content) fail('REFRESH_SAVE_UNCONFIRMED');
}
function readPrevious() {
  const bytes = privateRead(oldFile), backupBytes = privateRead(`${oldFile}.backup`);
  const record = validateGrayRecord(JSON.parse(bytes)), backup = validateGrayRecord(JSON.parse(backupBytes));
  const keys = ['version', 'id', 'target', 'createdAt', 'bundle', 'manifestSha256', 'zipSha256', 'zipBytes',
    'remark', 'before', 'beforeControl', 'variables', 'desiredConfig'];
  if (backup.phase !== 'prepared' || record.phase !== 'submitted' || record.taskId !== refreshTarget.previousTaskId
      || keys.some(key => !same(record[key], backup[key]))) fail('REFRESH_PREVIOUS_JOURNAL_INVALID');
  return { record, sha256: hash(bytes), backupSha256: hash(backupBytes) };
}
function readState() {
  if (!fs.existsSync(stateFile)) return null;
  const record = JSON.parse(privateRead(stateFile)), backup = JSON.parse(privateRead(`${stateFile}.backup`));
  if (backup.phase !== 'prepared' || !same(immutable(record), immutable(backup))) fail('REFRESH_JOURNAL_CHANGED');
  return validateRefreshRecord(record);
}
function saveState(record, previous) {
  validateRefreshRecord(record);
  if (!previous) {
    privateCreate(`${stateFile}.backup`, JSON.stringify(record) + '\n');
    privateCreate(stateFile, JSON.stringify(record) + '\n'); return;
  }
  if (privateRead(stateFile) !== JSON.stringify(previous) + '\n' || !same(immutable(record), immutable(previous)))
    fail('REFRESH_JOURNAL_CHANGED');
  const temp = `${stateFile}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  privateCreate(temp, JSON.stringify(record) + '\n'); fs.renameSync(temp, stateFile);
  if (privateRead(stateFile) !== JSON.stringify(record) + '\n') fail('REFRESH_SAVE_UNCONFIRMED');
}

export async function inspectClosedRefresh({ api, CloudAPI }, candidateVersion) {
  const [base, domain, task, order, current, previous] = await settleSdkCalls([
    () => CloudAPI.tcbDescribeServiceBaseConfig(scope),
    () => api.DescribeCloudBaseRunServiceDomain({ EnvId: scope.envId, ServiceName: scope.serverName }),
    () => CloudAPI.tcbDescribeServerManageTask(scope),
    () => CloudAPI.tcbDescribeWxCloudBaseRunReleaseOrder({ ...scope, wxAppid: refreshTarget.appId }),
    ...[refreshTarget.currentVersion, refreshTarget.previousVersion].map(VersionName =>
      () => api.DescribeCloudBaseRunServerVersion({ EnvId: scope.envId, ServerName: scope.serverName, VersionName })),
  ]);
  const versions = []; let total;
  for (let page = 0; page < 10; page++) {
    const batch = await api.DescribeCloudBaseRunServer({ EnvId: scope.envId, ServerName: scope.serverName,
      Limit: 10, Offset: versions.length });
    if (batch.ServerName !== scope.serverName || !Number.isSafeInteger(batch.TotalCount) || batch.TotalCount < 2
        || batch.TotalCount > 100 || !Array.isArray(batch.VersionItems)
        || (total !== undefined && total !== batch.TotalCount)) fail('REFRESH_INVENTORY_UNCONFIRMED');
    total = batch.TotalCount;
    for (const v of batch.VersionItems) {
      if (!/^buildtest-[0-9]+$/.test(v.VersionName) || versions.some(old => old.VersionName === v.VersionName))
        fail('REFRESH_INVENTORY_UNCONFIRMED');
      versions.push(v);
    }
    if (versions.length === total) break;
    if (!batch.VersionItems.length || versions.length > total) fail('REFRESH_INVENTORY_UNCONFIRMED');
  }
  if (versions.length !== total) fail('REFRESH_INVENTORY_UNCONFIRMED');
  const candidate = candidateVersion ? await api.DescribeCloudBaseRunServerVersion({
    EnvId: scope.envId, ServerName: scope.serverName, VersionName: candidateVersion }) : null;
  return { base: base.serviceBaseConfig, domain, task: task.task, order, versions, current, previous, candidate };
}

function checkDetail(detail, name) {
  if (detail?.VersionName !== name || detail.ServerName !== scope.serverName || detail.Status !== 'normal'
      || (detail.EnvId !== undefined && detail.EnvId !== scope.envId) || detail.ContainerPort !== 3000
      || detail.MinNum !== 0 || detail.MaxNum !== 1 || detail.Cpu !== 0.25 || detail.Mem !== 0.5)
    fail('REFRESH_VERSION_CONFIGURATION_UNCONFIRMED');
}
function checkPrivate(snapshot) {
  // Official CLI service:create sends IsPublic:true even when OpenAccessTypes
  // is MINIAPP only; service:list uses AccessTypes to report actual ingress.
  // IsPublic remains in the immutable version config comparisons below.
  if (!same(snapshot.domain?.AccessTypes, ['MINIAPP']) || !same(snapshot.base?.openAccessTypes, ['MINIAPP'])
      || snapshot.base.publicAccess === true || snapshot.base.minNum !== 0 || snapshot.base.maxNum !== 1
      || snapshot.base.cpu !== 0.25 || snapshot.base.mem !== 0.5) fail('REFRESH_PRIVATE_CONFIGURATION_UNCONFIRMED');
}
export function validateRefreshStart(snapshot, old) {
  validateGrayRecord(old);
  if (old.phase !== 'submitted' || old.taskId !== refreshTarget.previousTaskId) fail('REFRESH_PREVIOUS_JOURNAL_INVALID');
  checkPrivate(snapshot); checkDetail(snapshot.current, refreshTarget.currentVersion);
  checkDetail(snapshot.previous, refreshTarget.previousVersion);
  const o = orderIdentity(snapshot.order), t = snapshot.task;
  if (o.exists !== true || o.id !== refreshTarget.canceledReleaseId || o.serverName !== scope.serverName
      || o.current !== refreshTarget.currentVersion || o.candidate !== refreshTarget.previousVersion
      || o.status !== 'cancel' || o.isReleasing !== false || t?.id !== refreshTarget.previousTaskId || t.status !== 'stopped'
      || (t.envId !== undefined && t.envId !== scope.envId) || (t.serverName !== undefined && t.serverName !== scope.serverName)
      || !same(env(snapshot.base.envParams), old.variables) || !same(env(snapshot.previous.EnvParams), old.variables)
      || !same(env(snapshot.current.EnvParams), env(old.before.active[0].envParams))
      || snapshot.versions.some(v => !['normal', 'build_failed', 'deploy_failed', 'create_failed'].includes(v.Status))
      || !snapshot.versions.some(v => v.VersionName === refreshTarget.currentVersion)
      || !snapshot.versions.some(v => v.VersionName === refreshTarget.previousVersion)) fail('REFRESH_CANCELED_STATE_UNCONFIRMED');
  return true;
}
function sameStart(snapshot, record) {
  validateRefreshStart(snapshot, record.previousJournal);
  if (!same(comparableBase(snapshot.base), comparableBase(record.before.base))
      || !same(compareVersion(snapshot.current), compareVersion(record.before.current))
      || !same(compareVersion(snapshot.previous), compareVersion(record.before.previous))
      || !same(versionIdentity(snapshot.versions), versionIdentity(record.before.versions))
      || !same(orderIdentity(snapshot.order), orderIdentity(record.before.order))) fail('REFRESH_REMOTE_STATE_CHANGED');
}
export function validateRefreshRecord(record) {
  if (!record || record.version !== 1 || !same(record.target, refreshTarget) || !phases.includes(record.phase)
      || !/^[a-f0-9]{24}$/.test(record.id || '') || !path.isAbsolute(record.bundle || '')
      || record.manifestSha256 !== refreshTarget.manifestSha256 || !/^[a-f0-9]{64}$/.test(record.zipSha256 || '')
      || !/^[a-f0-9]{64}$/.test(record.previousJournalSha256 || '') || !/^[a-f0-9]{64}$/.test(record.previousBackupSha256 || '')
      || !Number.isSafeInteger(record.zipBytes) || record.zipBytes < 100 || record.zipBytes > 2 * 1024 * 1024
      || !Number.isFinite(Date.parse(record.createdAt)) || record.preparedAfterExternalCancellation !== true
      || record.remark !== `mini-photo-production closed refresh ${record.id}`) fail('REFRESH_JOURNAL_INVALID');
  validateRefreshStart(record.before, record.previousJournal);
  return record;
}
async function archive(bundle) {
  const report = verifyPhotoProductionBundle(bundle);
  if (report.manifestSha256 !== refreshTarget.manifestSha256) fail('REFRESH_BUNDLE_CHANGED');
  const manifestBytes = fs.readFileSync(path.join(bundle, 'manifest.json'));
  if (hash(manifestBytes) !== report.manifestSha256) fail('REFRESH_BUNDLE_CHANGED');
  const manifest = JSON.parse(manifestBytes), entries = manifest.files.map(file => {
    const filename = path.join(bundle, file.path), stat = fs.lstatSync(filename), bytes = fs.readFileSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== path.resolve(filename)
        || bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail('REFRESH_BUNDLE_CHANGED');
    return { name: file.path, bytes };
  });
  return packageBundle({ entries: [...entries, { name: 'manifest.json', bytes: manifestBytes }] });
}
export async function prepareClosedRefresh(adapter, { bundle, read = readState, write = saveState,
  previous = readPrevious, inspect = inspectClosedRefresh, zipBundle = archive } = {}) {
  if (read()) fail('REFRESH_ALREADY_PREPARED');
  const old = previous(), bytes = await zipBundle(bundle), before = await inspect(adapter);
  validateRefreshStart(before, old.record);
  const id = crypto.randomBytes(12).toString('hex');
  const record = { version: 1, id, target: refreshTarget, phase: 'prepared', createdAt: new Date().toISOString(),
    preparedAfterExternalCancellation: true, bundle, manifestSha256: refreshTarget.manifestSha256,
    zipSha256: hash(bytes), zipBytes: bytes.length, remark: `mini-photo-production closed refresh ${id}`,
    previousJournalSha256: old.sha256, previousBackupSha256: old.backupSha256, previousJournal: old.record, before };
  validateRefreshRecord(record); write(record, null); return safeRefreshState(record);
}
export async function submitClosedRefresh(adapter, { read = readState, write = saveState,
  previous = readPrevious, inspect = inspectClosedRefresh, zipBundle = archive } = {}) {
  let record = read();
  if (!record || record.phase !== 'prepared') fail('REFRESH_NOT_PREPARED_OR_REQUEST_UNCERTAIN');
  validateRefreshRecord(record);
  const old = previous();
  if (old.sha256 !== record.previousJournalSha256 || old.backupSha256 !== record.previousBackupSha256
      || !same(old.record, record.previousJournal)) fail('REFRESH_PREVIOUS_JOURNAL_CHANGED');
  const bytes = await zipBundle(record.bundle);
  if (hash(bytes) !== record.zipSha256 || bytes.length !== record.zipBytes) fail('REFRESH_ARCHIVE_CHANGED');
  sameStart(await inspect(adapter), record);
  const save = (phase, extra = {}) => { const next = { ...record, ...extra, phase }; write(next, record); record = next; };
  save('upload_authorization_requested');
  const upload = await adapter.api.DescribeCloudBaseBuildService({ EnvId: scope.envId, ServiceName: scope.serverName });
  const url = new URL(upload.UploadUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || (!/\.(myqcloud\.com|tencentcos\.cn)$/.test(url.hostname) && url.hostname !== 'cloudbaserun-code-cos.cloudbase.net')
      || !upload.PackageName || !upload.PackageVersion) fail('REFRESH_UPLOAD_DESTINATION_INVALID');
  save('upload_ready', { packageName: upload.PackageName, packageVersion: upload.PackageVersion });
  save('upload_requested');
  const uploaded = await adapter.axios.put(url.toString(), bytes, {
    headers: { 'content-type': 'application/zip' }, timeout: 60000, maxRedirects: 0 });
  if (![200, 204].includes(uploaded.status)) fail('REFRESH_UPLOAD_UNCONFIRMED');
  save('uploaded'); sameStart(await inspect(adapter), record);
  save('release_requested', { releaseRequestedAt: new Date().toISOString() });
  const result = await adapter.CloudAPI.tcbSubmitServerRelease({ ...scope, wxAppId: refreshTarget.appId,
    deployType: 'package', releaseType: 'GRAY', hasDockerfile: true, buildDir: '.', dockerfile: 'Dockerfile', port: 3000,
    packageName: record.packageName, packageVersion: record.packageVersion, versionRemark: record.remark, operatorRemark: record.remark });
  if (!Number.isSafeInteger(result.taskId) || result.taskId < 1 || result.taskId === refreshTarget.previousTaskId)
    fail('REFRESH_RELEASE_UNCONFIRMED');
  save('submitted', { taskId: result.taskId }); return safeRefreshState(record);
}
export function safeRefreshState(record) {
  return record ? { operationId: record.id, phase: record.phase, taskId: record.taskId || null,
    manifestSha256: record.manifestSha256, zipSha256: record.zipSha256, zipBytes: record.zipBytes,
    paymentEnvironment: 0, mode: 'closed', releaseType: 'GRAY', promoted: false, inheritedEnvironment: true,
    preparedAfterExternalCancellation: true } : { prepared: false };
}
export async function closedRefreshStatus(adapter, record = readState(), inspect = inspectClosedRefresh) {
  if (!record) return safeRefreshState(record);
  validateRefreshRecord(record);
  let snapshot = await inspect(adapter);
  const matches = snapshot.versions.filter(v => v.Remark === record.remark
    && !record.before.versions.some(old => old.VersionName === v.VersionName));
  const candidateName = record.phase === 'submitted' && snapshot.task?.id === record.taskId && matches.length === 1
    ? matches[0].VersionName : null;
  if (candidateName) snapshot = await inspect(adapter, candidateName);
  let candidateConfigurationVerified = false;
  try {
    checkDetail(snapshot.candidate, candidateName); checkPrivate(snapshot);
    candidateConfigurationVerified = Boolean(candidateName && snapshot.task?.id === record.taskId
      && snapshot.candidate.IsPublic === record.before.previous.IsPublic
      && same(env(snapshot.candidate.EnvParams), record.previousJournal.variables));
  } catch { /* Unknown or building is never verified. */ }
  const order = orderIdentity(snapshot.order);
  const releaseOrderCorrelated = Boolean(candidateName && order.exists === true
    && Number.isSafeInteger(order.id) && order.id !== refreshTarget.canceledReleaseId
    && order.serverName === scope.serverName && order.current === refreshTarget.currentVersion
    && order.candidate === candidateName && snapshot.task?.id === record.taskId);
  const grayTestReleaseVerified = releaseOrderCorrelated && order.status === 'test' && order.isReleasing === true;
  return { ...safeRefreshState(record), cloud: { candidateVersion: candidateName,
    taskId: snapshot.task?.id, taskStatus: snapshot.task?.status, order, releaseOrderCorrelated, grayTestReleaseVerified,
    steps: snapshot.task?.steps?.map(step => ({ name: step.name, status: step.status })),
    candidateConfigurationVerified, baseUnchanged: same(comparableBase(snapshot.base), comparableBase(record.before.base)),
    predecessorConfigurationUnchanged: same(compareVersion(snapshot.current), compareVersion(record.before.current)),
    previousCandidateConfigurationUnchanged: same(compareVersion(snapshot.previous), compareVersion(record.before.previous)),
    startupVerified: false, routingVerified: false } };
}
async function withLock(operation) {
  const filename = `${stateFile}.lock`, token = crypto.randomBytes(24).toString('hex'); privateCreate(filename, token);
  try { return await operation(); } finally { if (privateRead(filename) === token) fs.unlinkSync(filename); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, bundle, ...rest] = process.argv.slice(2);
    if (rest.length || !['prepare', 'submit', 'status'].includes(action)
        || (action === 'prepare' ? !bundle : bundle !== undefined)) fail('REFRESH_ARGUMENT_INVALID');
    const run = () => withProductionCloud(adapter => action === 'prepare' ? prepareClosedRefresh(adapter, { bundle })
      : action === 'submit' ? submitClosedRefresh(adapter) : closedRefreshStatus(adapter));
    const result = await (action === 'status' ? run() : withLock(run));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(/^REFRESH_[A-Z_]+$/.test(error?.message) ? error.message : 'REFRESH_OPERATION_UNCONFIRMED');
    process.exitCode = 1;
  }
}
