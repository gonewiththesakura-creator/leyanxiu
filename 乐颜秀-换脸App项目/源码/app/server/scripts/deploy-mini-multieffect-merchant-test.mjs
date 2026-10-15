import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { productionCloud, withProductionCloud } from './inspect-mini-production-cloud.mjs';
import { inspectClosedRefresh } from './refresh-mini-production-closed.mjs';
import { normalizedConfig, packageBundle } from './deploy-mini-sandbox-cloud.mjs';
import { verifyPhotoProductionBundle } from './build-mini-photo-production.mjs';
import { assembleMiniMultiEffectMerchantCandidate } from './prepare-mini-multieffect-merchant-candidate.mjs';

// One new operation, independent of every historical deployment journal.
// Import/default CLI are inert. No cancel, promote or traffic mutation exists.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const journalFile = path.join(server, '.env.mini-multieffect-merchant-test.json');
export const multiEffectMerchantTarget = Object.freeze({ ...productionCloud, serverName: 'buildtest',
  currentVersion: 'buildtest-016', priorOrderCurrentVersion: 'buildtest-013', completedTaskId: 2349217, completedReleaseOrderId: 2844375,
  bundleName: 'mini-photo-production-20261015-three-effects',
  manifestSha256: '9794d95849bd32a333a18fad85363a161cb8846e3dea80ad5a04dc26642069c9',
  policySha256: '8555665251fe559e1a7938e4bd63170a5fb1a7c203557aa95a8786d7c49d723f',
  acceptanceSha256: '5aa5da1e046d54e349dac2f8e72db478d593ec8bf360de570bbb6880fa6a83e0' });
const scope = { envId: multiEffectMerchantTarget.envId, serverName: multiEffectMerchantTarget.serverName };
const fail = suffix => { throw Object.assign(new Error(`MULTIEFFECT_DEPLOY_${suffix}`), { code: `MULTIEFFECT_DEPLOY_${suffix}` }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const data = value => JSON.parse(JSON.stringify(value));
const env = value => JSON.parse(value || '{}');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const phases = ['prepared', 'configure_requested', 'configured', 'upload_authorization_requested',
  'upload_ready', 'upload_requested', 'uploaded', 'release_requested', 'submitted'];
const mutable = new Set(['phase', 'packageName', 'packageVersion', 'taskId', 'releaseRequestedAt']);
const immutable = record => Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)));
const baseConfig = base => data({ ...normalizedConfig(base), envParams: env(base.envParams) });
const detailConfig = detail => data({ ...Object.fromEntries(Object.entries(detail).filter(([key]) =>
  !['RequestId', 'CreatedTime', 'UpdatedTime', 'Status', 'CpuTotalQuota', 'MemTotalQuota', 'VersionIP'].includes(key))),
  EnvParams: env(detail.EnvParams) });
const versionState = versions => versions.map(v => ({ name: v.VersionName, status: v.Status, flow: v.FlowRatio, remark: v.Remark }))
  .sort((a, b) => a.name.localeCompare(b.name));
const orderIdentity = snapshot => {
  const order = snapshot.order?.releaseOrderInfo;
  return { exists: snapshot.order?.isExist, id: order?.id, serverName: order?.serverName,
    current: order?.currentVersion?.versionName, candidate: order?.releaseVersion?.versionName,
    status: order?.releaseStatus, isReleasing: order?.isReleasing };
};
const taskScoped = task => task && (task.envId === undefined || task.envId === scope.envId)
  && (task.serverName === undefined || task.serverName === scope.serverName);
const taskIdentity = task => ({ id: task?.id, status: task?.status, envId: task?.envId, serverName: task?.serverName });
const domainConfig = domain => Object.fromEntries(Object.entries(domain).filter(([key]) => key !== 'RequestId'));

function checkPrivate(snapshot) {
  if (!same(snapshot.domain?.AccessTypes, ['MINIAPP']) || !same(snapshot.base?.openAccessTypes, ['MINIAPP'])
    || snapshot.base.publicAccess === true || snapshot.base.minNum !== 0 || snapshot.base.maxNum !== 1
    || snapshot.base.cpu !== 0.25 || snapshot.base.mem !== 0.5) fail('PRIVATE_SCOPE_REQUIRED');
}
function checkDetail(detail, name, variables) {
  if (!detail || detail.VersionName !== name || detail.ServerName !== scope.serverName
    || (detail.EnvId !== undefined && detail.EnvId !== scope.envId) || detail.Status !== 'normal'
    || detail.ContainerPort !== 3000 || detail.MinNum !== 0 || detail.MaxNum !== 1
    || detail.Cpu !== 0.25 || detail.Mem !== 0.5 || !same(env(detail.EnvParams), variables)) fail('VERSION_CONFIGURATION_UNCONFIRMED');
}
export function validateMultiEffectPredecessor(snapshot, baseVariables) {
  checkPrivate(snapshot);
  const variables = env(snapshot.current?.EnvParams), order = orderIdentity(snapshot);
  checkDetail(snapshot.current, multiEffectMerchantTarget.currentVersion, variables);
  if (!same(env(snapshot.base.envParams), baseVariables || variables)
    || order.exists !== true || order.id !== multiEffectMerchantTarget.completedReleaseOrderId || order.serverName !== scope.serverName
    || order.current !== multiEffectMerchantTarget.priorOrderCurrentVersion || order.candidate !== multiEffectMerchantTarget.currentVersion
    || order.status !== 'success' || order.isReleasing !== false
    || snapshot.task?.id !== multiEffectMerchantTarget.completedTaskId || !taskScoped(snapshot.task) || snapshot.task.status !== 'finished'
    || !Array.isArray(snapshot.versions) || !snapshot.versions.length || snapshot.versions.length > 100
    || new Set(snapshot.versions.map(v => v.VersionName)).size !== snapshot.versions.length
    || snapshot.versions.some(v => !/^buildtest-[0-9]+$/.test(v.VersionName)
      || !['normal', 'build_failed', 'deploy_failed', 'create_failed'].includes(v.Status)
      || !Number.isFinite(v.FlowRatio) || v.FlowRatio < 0 || v.FlowRatio > 100)
    || !snapshot.versions.some(v => v.VersionName === multiEffectMerchantTarget.currentVersion && v.Status === 'normal')
    || snapshot.versions.find(v => v.VersionName === multiEffectMerchantTarget.currentVersion)?.FlowRatio !== 100
    || snapshot.versions.some(v => v.VersionName !== multiEffectMerchantTarget.currentVersion && v.FlowRatio !== 0)) fail('COMPLETED_016_REQUIRED');
  return variables;
}

export async function inspectMultiEffectMerchantRelease(adapter, candidateName) {
  // Reuse the existing paginated inventory and supported read-only endpoints.
  const prior = await inspectClosedRefresh(adapter, multiEffectMerchantTarget.currentVersion);
  const candidate = candidateName ? await adapter.api.DescribeCloudBaseRunServerVersion({
    EnvId: scope.envId, ServerName: scope.serverName, VersionName: candidateName }) : null;
  return { ...prior, historicalCurrent: prior.current, historicalPrevious: prior.previous, current: prior.candidate, candidate };
}
function sameBefore(snapshot, record, configured) {
  validateMultiEffectPredecessor(snapshot, configured ? record.variables : undefined);
  if (!same(orderIdentity(snapshot), orderIdentity(record.before))
    || !same(taskIdentity(snapshot.task), taskIdentity(record.before.task))
    || !same(versionState(snapshot.versions), versionState(record.before.versions))
    || !same(domainConfig(snapshot.domain), domainConfig(record.before.domain))
    || !['current', 'historicalCurrent', 'historicalPrevious'].every(key => same(detailConfig(snapshot[key]), detailConfig(record.before[key])))
    || !same(baseConfig(snapshot.base), baseConfig(configured ? record.desiredConfig : record.before.base))) fail('REMOTE_STATE_CHANGED');
}
function pinnedEvidence() {
  const policyBytes = fs.readFileSync(path.join(server, 'docs/production-config/original-effects-merchant-policy-2026-10-15.json'));
  const acceptanceBytes = fs.readFileSync(path.join(server, 'evidence/mini-photo-original-effects-acceptance-bundle-2026-10-15.json'));
  if (hash(policyBytes) !== multiEffectMerchantTarget.policySha256 || hash(acceptanceBytes) !== multiEffectMerchantTarget.acceptanceSha256) fail('EVIDENCE_CHANGED');
  return { policyBytes, acceptanceBytes, policySha256: multiEffectMerchantTarget.policySha256, acceptanceSha256: multiEffectMerchantTarget.acceptanceSha256 };
}
function assemble(variables, evidence) {
  try { return assembleMiniMultiEffectMerchantCandidate({ current: { version: multiEffectMerchantTarget.currentVersion, variables }, ...evidence }); }
  catch { fail('CANDIDATE_INVALID'); }
}
export function validateMultiEffectMerchantRecord(record) {
  if (!record || record.version !== 1 || !same(record.target, multiEffectMerchantTarget) || !phases.includes(record.phase)
    || !/^[a-f0-9]{24}$/.test(record.id || '') || !instant(record.createdAt)
    || typeof record.bundle !== 'string' || !path.isAbsolute(record.bundle) || path.basename(record.bundle) !== multiEffectMerchantTarget.bundleName
    || record.manifestSha256 !== multiEffectMerchantTarget.manifestSha256 || !sha(record.zipSha256)
    || !Number.isSafeInteger(record.zipBytes) || record.zipBytes < 100 || record.zipBytes > 2 * 1024 * 1024
    || record.remark !== `mini-multieffect merchant-test ${record.id}` || !record.variables) fail('JOURNAL_INVALID');
  const inherited = validateMultiEffectPredecessor(record.before);
  const profile = assemble(inherited, { policyBytes: Buffer.from(record.variables.PHOTO_PRODUCTION_CONFIG_BASE64 || '', 'base64'),
    policySha256: multiEffectMerchantTarget.policySha256,
    acceptanceBytes: Buffer.from(record.variables.PHOTO_PRODUCTION_ACCEPTANCE_BASE64 || '', 'base64'),
    acceptanceSha256: multiEffectMerchantTarget.acceptanceSha256 });
  if (!same(profile.variables, record.variables)
    || !same(baseConfig(record.desiredConfig), baseConfig({ ...record.before.base, envParams: JSON.stringify(record.variables) }))) fail('JOURNAL_INVALID');
  const index = phases.indexOf(record.phase);
  if (index >= phases.indexOf('upload_ready') && (!/^[A-Za-z0-9._/-]{1,512}$/.test(record.packageName || '')
    || !/^[A-Za-z0-9._-]{1,128}$/.test(record.packageVersion || ''))) fail('JOURNAL_INVALID');
  if (index >= phases.indexOf('release_requested') && !instant(record.releaseRequestedAt)) fail('JOURNAL_INVALID');
  if (record.phase === 'submitted' && (!positive(record.taskId) || record.taskId === record.before.task.id)) fail('JOURNAL_INVALID');
  return record;
}
export async function archiveMultiEffectMerchantBundle(bundle, manifestSha256) {
  if (typeof bundle !== 'string' || !path.isAbsolute(bundle) || path.basename(bundle) !== multiEffectMerchantTarget.bundleName
    || manifestSha256 !== multiEffectMerchantTarget.manifestSha256) fail('BUNDLE_INVALID');
  const report = verifyPhotoProductionBundle(bundle);
  if (report.manifestSha256 !== manifestSha256) fail('BUNDLE_CHANGED');
  const manifestBytes = fs.readFileSync(path.join(bundle, 'manifest.json'));
  if (hash(manifestBytes) !== manifestSha256) fail('BUNDLE_CHANGED');
  const entries = JSON.parse(manifestBytes).files.map(item => {
    const filename = path.join(bundle, item.path), stat = fs.lstatSync(filename), bytes = fs.readFileSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== path.resolve(filename)
      || bytes.length !== item.bytes || hash(bytes) !== item.sha256) fail('BUNDLE_CHANGED');
    return { name: item.path, bytes };
  });
  return packageBundle({ entries: [...entries, { name: 'manifest.json', bytes: manifestBytes }] });
}

export async function prepareMultiEffectMerchantRelease(adapter, { bundle, manifestSha256, read = readState, write = saveState,
  inspect = inspectMultiEffectMerchantRelease, zipBundle = archiveMultiEffectMerchantBundle } = {}) {
  if (read()) fail('JOURNAL_EXISTS');
  const evidence = pinnedEvidence(), bytes = await zipBundle(bundle, manifestSha256);
  const before = await inspect(adapter), inherited = validateMultiEffectPredecessor(before);
  const profile = assemble(inherited, evidence), id = crypto.randomBytes(12).toString('hex');
  const record = { version: 1, id, target: multiEffectMerchantTarget, phase: 'prepared', createdAt: new Date().toISOString(),
    bundle, manifestSha256, zipSha256: hash(bytes), zipBytes: bytes.length, remark: `mini-multieffect merchant-test ${id}`,
    before, variables: profile.variables, desiredConfig: normalizedConfig({ ...before.base, envParams: JSON.stringify(profile.variables) }) };
  validateMultiEffectMerchantRecord(record); write(record, null); return safeMultiEffectMerchantState(record);
}
export async function submitMultiEffectMerchantRelease(adapter, { read = readState, write = saveState,
  inspect = inspectMultiEffectMerchantRelease, zipBundle = archiveMultiEffectMerchantBundle } = {}) {
  let record = read();
  if (!record || record.phase !== 'prepared') fail('NOT_PREPARED_OR_REQUEST_UNCERTAIN');
  validateMultiEffectMerchantRecord(record); pinnedEvidence();
  const bytes = await zipBundle(record.bundle, record.manifestSha256);
  if (hash(bytes) !== record.zipSha256 || bytes.length !== record.zipBytes) fail('ARCHIVE_CHANGED');
  return executePinnedMerchantPackageRelease(adapter, { record, bytes, write, inspect, sameBefore,
    status: multiEffectMerchantReleaseStatus });
}
// Shared transport sequence only. Each caller owns a separate, validated
// journal, exact predecessor checks and readback; no historical target changes.
export async function executePinnedMerchantPackageRelease(adapter, { record, bytes, write, inspect, sameBefore, status }) {
  sameBefore(await inspect(adapter), record, false);
  const save = (phase, extra = {}) => { const next = { ...record, ...extra, phase }; write(next, record); record = next; };
  save('configure_requested');
  await adapter.CloudAPI.tcbUpdateServerBaseConfig({ ...scope, wxAppId: multiEffectMerchantTarget.appId, conf: record.desiredConfig });
  sameBefore(await inspect(adapter), record, true); save('configured');
  save('upload_authorization_requested');
  const upload = await adapter.api.DescribeCloudBaseBuildService({ EnvId: scope.envId, ServiceName: scope.serverName });
  const url = new URL(upload.UploadUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash
    || (!/\.(myqcloud\.com|tencentcos\.cn)$/.test(url.hostname) && url.hostname !== 'cloudbaserun-code-cos.cloudbase.net')
    || !/^[A-Za-z0-9._/-]{1,512}$/.test(upload.PackageName || '')
    || !/^[A-Za-z0-9._-]{1,128}$/.test(upload.PackageVersion || '')) fail('UPLOAD_DESTINATION_INVALID');
  save('upload_ready', { packageName: upload.PackageName, packageVersion: upload.PackageVersion });
  save('upload_requested');
  const response = await adapter.axios.put(url.toString(), bytes, { headers: { 'content-type': 'application/zip' }, timeout: 60000, maxRedirects: 0 });
  if (![200, 204].includes(response.status)) fail('UPLOAD_UNCONFIRMED');
  save('uploaded'); sameBefore(await inspect(adapter), record, true);
  save('release_requested', { releaseRequestedAt: new Date().toISOString() });
  const result = await adapter.CloudAPI.tcbSubmitServerRelease({ ...scope, wxAppId: multiEffectMerchantTarget.appId,
    deployType: 'package', releaseType: 'GRAY', hasDockerfile: true, buildDir: '.', dockerfile: 'Dockerfile', port: 3000,
    packageName: record.packageName, packageVersion: record.packageVersion, versionRemark: record.remark, operatorRemark: record.remark });
  if (!positive(result.taskId) || result.taskId === record.before.task.id) fail('RELEASE_UNCONFIRMED');
  save('submitted', { taskId: result.taskId });
  return status(adapter, record, inspect);
}
export function safeMultiEffectMerchantState(record) {
  return record ? { operationId: record.id, phase: record.phase, taskId: record.taskId || null,
    sourceVersion: multiEffectMerchantTarget.currentVersion, completedReleaseOrderId: orderIdentity(record.before).id,
    manifestSha256: record.manifestSha256, zipSha256: record.zipSha256, zipBytes: record.zipBytes,
    policySha256: multiEffectMerchantTarget.policySha256, acceptanceSha256: multiEffectMerchantTarget.acceptanceSha256,
    paymentEnvironment: 0, mode: 'merchant_test', releaseType: 'GRAY', promoted: false,
    retryAllowed: record.phase === 'prepared', realChargesPossibleAfterDeployment: true,
    startupVerified: false, routingVerified: false, paymentCallbackRoutingVerified: false } : { prepared: false };
}
export async function multiEffectMerchantReleaseStatus(adapter, record = readState(), inspect = inspectMultiEffectMerchantRelease) {
  if (!record) return safeMultiEffectMerchantState(record);
  validateMultiEffectMerchantRecord(record);
  let snapshot = await inspect(adapter);
  const matches = state => state.versions.filter(v => v.Remark === record.remark && !record.before.versions.some(old => old.VersionName === v.VersionName));
  const taskMatches = () => record.phase === 'submitted' && snapshot.task?.id === record.taskId && Boolean(taskScoped(snapshot.task));
  const found = matches(snapshot), candidateName = taskMatches() && found.length === 1 ? found[0].VersionName : null;
  if (candidateName) snapshot = await inspect(adapter, candidateName);
  const final = matches(snapshot), candidateCorrelated = Boolean(candidateName && taskMatches() && final.length === 1 && final[0].VersionName === candidateName);
  let candidateConfigurationVerified = false, privateIngressVerified = false, sourceConfigurationsUnchanged = false;
  try { checkPrivate(snapshot); privateIngressVerified = true; } catch { /* Report, never repair. */ }
  try { checkDetail(snapshot.candidate, candidateName, record.variables);
    candidateConfigurationVerified = candidateCorrelated && snapshot.candidate.IsPublic === record.before.current.IsPublic;
  } catch { /* Building and missing candidates are unverified. */ }
  try { sourceConfigurationsUnchanged = ['current', 'historicalCurrent', 'historicalPrevious']
    .every(key => same(detailConfig(snapshot[key]), detailConfig(record.before[key]))); } catch { /* Unverified. */ }
  const order = orderIdentity(snapshot), releaseOrderCorrelated = candidateCorrelated && order.exists === true && positive(order.id)
    && order.id !== orderIdentity(record.before).id && order.serverName === scope.serverName
    && order.current === multiEffectMerchantTarget.currentVersion && order.candidate === candidateName;
  return { ...safeMultiEffectMerchantState(record), cloud: { candidateVersion: candidateName,
    taskId: positive(snapshot.task?.id) ? snapshot.task.id : null,
    taskStatus: ['running', 'finished', 'stopped', 'failed'].includes(snapshot.task?.status) ? snapshot.task.status : 'unknown',
    currentTaskMatches: Boolean(taskMatches()), releaseOrderCorrelated: Boolean(releaseOrderCorrelated),
    grayTestReleaseVerified: Boolean(releaseOrderCorrelated && order.status === 'test' && order.isReleasing === true),
    candidateConfigurationVerified, privateIngressVerified, sourceConfigurationsUnchanged,
    desiredBaseVerified: same(baseConfig(snapshot.base), baseConfig(record.desiredConfig)),
    priorVersionStateUnchanged: same(versionState(snapshot.versions.filter(v => record.before.versions.some(old => old.VersionName === v.VersionName))), versionState(record.before.versions)),
    defaultRoutingVerified: false } };
}

function privateRead(filename) {
  execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true });
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 4 * 1024 * 1024) fail('PRIVATE_FILE_INVALID');
  return fs.readFileSync(filename, 'utf8');
}
function privateCreate(filename, content) {
  execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true });
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true }).match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) fail('PRIVATE_FILE_INVALID');
      execFileSync('icacls.exe', [filename, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { stdio: 'pipe', windowsHide: true });
    }
    fs.writeFileSync(fd, content); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (privateRead(filename) !== content) fail('JOURNAL_SAVE_UNCONFIRMED');
}
function readState() {
  if (!fs.existsSync(journalFile)) {
    if (fs.existsSync(`${journalFile}.backup`)) fail('PARTIAL_JOURNAL_EXISTS');
    return null;
  }
  const record = JSON.parse(privateRead(journalFile)), backup = JSON.parse(privateRead(`${journalFile}.backup`));
  if (backup.phase !== 'prepared' || !same(immutable(record), immutable(backup))) fail('JOURNAL_CHANGED');
  return validateMultiEffectMerchantRecord(record);
}
function saveState(record, previous) {
  validateMultiEffectMerchantRecord(record);
  if (!previous) {
    privateCreate(`${journalFile}.backup`, JSON.stringify(record) + '\n');
    privateCreate(journalFile, JSON.stringify(record) + '\n'); return;
  }
  if (privateRead(journalFile) !== JSON.stringify(previous) + '\n' || !same(immutable(record), immutable(previous))) fail('JOURNAL_CHANGED');
  const temporary = `${journalFile}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  privateCreate(temporary, JSON.stringify(record) + '\n'); fs.renameSync(temporary, journalFile);
  if (privateRead(journalFile) !== JSON.stringify(record) + '\n') fail('JOURNAL_SAVE_UNCONFIRMED');
}
async function withLock(operation) {
  const filename = `${journalFile}.lock`, token = crypto.randomBytes(24).toString('hex'); privateCreate(filename, token);
  try { return await operation(); } finally { if (privateRead(filename) === token) fs.unlinkSync(filename); }
}
export const multiEffectMerchantDeployPlan = Object.freeze({ action: 'plan', privateFilesRead: false, cloudOperationPerformed: false,
  target: 'buildtest', sourceVersion: 'buildtest-016', releaseType: 'GRAY', promoted: false,
  bundleName: multiEffectMerchantTarget.bundleName, manifestSha256: multiEffectMerchantTarget.manifestSha256,
  completedReleaseOrderId: multiEffectMerchantTarget.completedReleaseOrderId, completedTaskId: multiEffectMerchantTarget.completedTaskId,
  policySha256: multiEffectMerchantTarget.policySha256, acceptanceSha256: multiEffectMerchantTarget.acceptanceSha256,
  operations: ['prepare: verify local pinned package and evidence, inspect completed 016 and save new exclusive private journal',
    'submit: recheck exact snapshot, change five assembler variables, upload package and submit one GRAY test version',
    'status: read-only correlated candidate verification'],
  requiredInputs: ['absolute reviewed bundle directory', 'independently reviewed manifest SHA256'],
  uncertainRequestPolicy: 'never retry after prepared; read-only status only',
  defaultVersionChangeRequested: false, publicIngressChangeRequested: false, paymentScopeChangeRequested: false });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || (args.length === 1 && args[0] === 'plan')) console.log(JSON.stringify(multiEffectMerchantDeployPlan));
    else {
      const [action, bundle, manifestSha256] = args;
      if (!['prepare', 'submit', 'status'].includes(action)
        || (action === 'prepare' ? args.length !== 3 || !path.isAbsolute(bundle) || !sha(manifestSha256) : args.length !== 1)) fail('ARGUMENT_INVALID');
      const run = () => withProductionCloud(adapter => action === 'prepare'
        ? prepareMultiEffectMerchantRelease(adapter, { bundle, manifestSha256 })
        : action === 'submit' ? submitMultiEffectMerchantRelease(adapter) : multiEffectMerchantReleaseStatus(adapter));
      console.log(JSON.stringify(await (action === 'status' ? run() : withLock(run))));
    }
  } catch (error) {
    console.error(/^MULTIEFFECT_DEPLOY_[A-Z_]+$/.test(error?.code || '') ? error.code : 'MULTIEFFECT_DEPLOY_OPERATION_UNCONFIRMED');
    process.exitCode = 1;
  }
}
