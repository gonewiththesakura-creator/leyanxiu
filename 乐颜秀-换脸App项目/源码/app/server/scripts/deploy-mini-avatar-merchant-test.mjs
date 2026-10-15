import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { withProductionCloud, productionCloud } from './inspect-mini-production-cloud.mjs';
import { inspectClosedRefresh, validateRefreshRecord } from './refresh-mini-production-closed.mjs';
import { verifyPhotoProductionBundle } from './build-mini-photo-production.mjs';
import { packageBundle, normalizedConfig } from './deploy-mini-sandbox-cloud.mjs';
import { buildMiniProductionMerchantTestProfile } from './prepare-mini-production-merchant-test.mjs';

// A separate one-use transition from the already submitted closed 015 test
// release. Import/default CLI are inert. The existing closed deployers remain
// unchanged; this module never calls their prepare/submit or rotates keys.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const predecessorFile = path.join(server, '.env.mini-production-refresh015.json');
const journalFile = path.join(server, '.env.mini-avatar-merchant-test.json');
export const avatarMerchantTarget = Object.freeze({ ...productionCloud, serverName: 'buildtest',
  currentVersion: 'buildtest-013', previousVersion: 'buildtest-014', predecessorVersion: 'buildtest-015',
  bundleName: 'mini-photo-production-20261013-avatar-ready',
  manifestSha256: '276619461e2e80ba626b193379132b38c3f065585a4d65e9b397a3105e54c3a8' });
const scope = { envId: avatarMerchantTarget.envId, serverName: avatarMerchantTarget.serverName };
const fail = suffix => { throw Object.assign(new Error(`AVATAR_MERCHANT_${suffix}`), { code: `AVATAR_MERCHANT_${suffix}` }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const data = value => JSON.parse(JSON.stringify(value));
const parseEnv = value => JSON.parse(value || '{}');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const phases = ['prepared', 'configure_requested', 'configured', 'upload_authorization_requested',
  'upload_ready', 'upload_requested', 'uploaded', 'release_requested', 'submitted'];
const mutable = new Set(['phase', 'packageName', 'packageVersion', 'taskId', 'releaseRequestedAt']);
const immutable = record => Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)));
const comparableBase = base => data({ ...normalizedConfig(base), envParams: parseEnv(base.envParams) });
const detailConfiguration = value => data(Object.fromEntries(Object.entries(value).filter(([key]) =>
  !['RequestId', 'CreatedTime', 'UpdatedTime', 'Status', 'CpuTotalQuota', 'MemTotalQuota', 'VersionIP'].includes(key))));
const comparableDetail = value => ({ ...detailConfiguration(value), EnvParams: parseEnv(value.EnvParams) });
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

function checkedPredecessor(previous) {
  if (!previous || !sha(previous.sha256) || !sha(previous.backupSha256)) fail('PREDECESSOR_JOURNAL_INVALID');
  try { validateRefreshRecord(previous.record); } catch { fail('PREDECESSOR_JOURNAL_INVALID'); }
  if (previous.record.phase !== 'submitted' || !positive(previous.record.taskId)
    || previous.record.taskId === previous.record.previousJournal.taskId) fail('PREDECESSOR_JOURNAL_INVALID');
  return previous.record.previousJournal.variables;
}
function checkPrivate(snapshot) {
  if (!same(snapshot.domain?.AccessTypes, ['MINIAPP']) || !same(snapshot.base?.openAccessTypes, ['MINIAPP'])
    || snapshot.base.publicAccess === true || snapshot.base.minNum !== 0 || snapshot.base.maxNum !== 1
    || snapshot.base.cpu !== 0.25 || snapshot.base.mem !== 0.5) fail('PRIVATE_SCOPE_REQUIRED');
}
function checkDetail(detail, name, variables) {
  if (!detail || detail.VersionName !== name || detail.ServerName !== scope.serverName
    || (detail.EnvId !== undefined && detail.EnvId !== scope.envId) || detail.Status !== 'normal'
    || detail.ContainerPort !== 3000 || detail.MinNum !== 0 || detail.MaxNum !== 1
    || detail.Cpu !== 0.25 || detail.Mem !== 0.5
    || !same(parseEnv(detail.EnvParams), variables)) fail('VERSION_CONFIGURATION_UNCONFIRMED');
}

/** The one pending operation accepted at prepare is the exact known 015
 * test release. After external cancellation, the same order must read cancel
 * and the same task stopped. No guessed cancel operateType or promotion API.
 */
export function validateAvatarPredecessor(snapshot, previous, { canceled = false, baseVariables } = {}) {
  const inherited = checkedPredecessor(previous), old = previous.record.previousJournal;
  checkPrivate(snapshot);
  checkDetail(snapshot.current, avatarMerchantTarget.currentVersion, parseEnv(old.before.active[0].envParams));
  checkDetail(snapshot.previous, avatarMerchantTarget.previousVersion, inherited);
  checkDetail(snapshot.predecessor, avatarMerchantTarget.predecessorVersion, inherited);
  const order = orderIdentity(snapshot);
  if (order.exists !== true || !positive(order.id) || order.id === previous.record.target.canceledReleaseId
    || order.serverName !== scope.serverName || order.current !== avatarMerchantTarget.currentVersion
    || order.candidate !== avatarMerchantTarget.predecessorVersion
    || order.status !== (canceled ? 'cancel' : 'test') || order.isReleasing !== !canceled
    || snapshot.task?.id !== previous.record.taskId || !taskScoped(snapshot.task)
    || snapshot.task.status !== (canceled ? 'stopped' : 'running')
    || !same(parseEnv(snapshot.base.envParams), baseVariables || inherited)
    || !Array.isArray(snapshot.versions) || snapshot.versions.length < 3 || snapshot.versions.length > 100
    || new Set(snapshot.versions.map(v => v.VersionName)).size !== snapshot.versions.length
    || snapshot.versions.some(v => !/^buildtest-[0-9]+$/.test(v.VersionName)
      || !['normal', 'build_failed', 'deploy_failed', 'create_failed'].includes(v.Status)
      || !Number.isFinite(v.FlowRatio) || v.FlowRatio < 0 || v.FlowRatio > 100)
    || [avatarMerchantTarget.currentVersion, avatarMerchantTarget.previousVersion, avatarMerchantTarget.predecessorVersion]
      .some(name => !snapshot.versions.some(v => v.VersionName === name && v.Status === 'normal'))
    || ![0, 100].includes(snapshot.versions.find(v => v.VersionName === avatarMerchantTarget.currentVersion)?.FlowRatio)
    || snapshot.versions.some(v => v.VersionName !== avatarMerchantTarget.currentVersion && v.FlowRatio !== 0)
    || snapshot.versions.find(v => v.VersionName === avatarMerchantTarget.predecessorVersion)?.Remark !== previous.record.remark) {
    fail('PREDECESSOR_RELEASE_UNCONFIRMED');
  }
  // All-zero FlowRatio is an observed platform shape. Release-order identity,
  // exact before/after comparisons and later real routing checks own routing.
  return true;
}

export async function inspectAvatarMerchantRelease(adapter, candidateName) {
  const prior = await inspectClosedRefresh(adapter, avatarMerchantTarget.predecessorVersion);
  const candidate = candidateName ? await adapter.api.DescribeCloudBaseRunServerVersion({
    EnvId: scope.envId, ServerName: scope.serverName, VersionName: candidateName }) : null;
  return { ...prior, predecessor: prior.candidate, candidate };
}

function sameBeforeSubmission(snapshot, record, configured, canceledVersionState) {
  validateAvatarPredecessor(snapshot, record.previous, { canceled: true,
    baseVariables: configured ? record.variables : undefined });
  const order = orderIdentity(snapshot), original = orderIdentity(record.before);
  const actualVersions = versionState(snapshot.versions);
  const expectedVersions = canceledVersionState || versionState(record.before.versions);
  if (!configured && !canceledVersionState) {
    // Canceling the exact test order can restore only its frozen default
    // version from the platform's all-zero test shape to 100. Capture this
    // first readback; later checks may not normalize another traffic change.
    const beforeCurrent = expectedVersions.find(v => v.name === avatarMerchantTarget.currentVersion);
    const actualCurrent = actualVersions.find(v => v.name === avatarMerchantTarget.currentVersion);
    if (beforeCurrent?.flow === 0 && actualCurrent?.flow === 100) beforeCurrent.flow = 100;
  }
  if (order.id !== original.id || !same(actualVersions, expectedVersions)
    || !same(comparableDetail(snapshot.current), comparableDetail(record.before.current))
    || !same(comparableDetail(snapshot.previous), comparableDetail(record.before.previous))
    || !same(comparableDetail(snapshot.predecessor), comparableDetail(record.before.predecessor))
    || !same(comparableBase(snapshot.base), comparableBase(configured ? record.desiredConfig : record.before.base))) {
    fail('REMOTE_STATE_CHANGED');
  }
  return actualVersions;
}
function assemble(inherited, inputs) {
  try { return buildMiniProductionMerchantTestProfile({ ...inputs, inherited }); }
  catch { fail('MERCHANT_INPUT_INVALID'); }
}
function recordProfile(record) {
  // Re-run the existing pure assembler against the unchanged saved 015
  // credentials. BASE64 is only the exact policy/report transport, never a new
  // source of acceptance or a permit to change provider/runtime configuration.
  const inherited = checkedPredecessor(record.previous);
  const profile = assemble(inherited, { ...record.merchantInputs,
    policyBytes: Buffer.from(record.variables.PHOTO_PRODUCTION_CONFIG_BASE64 || '', 'base64'),
    acceptanceBytes: Buffer.from(record.variables.PHOTO_PRODUCTION_ACCEPTANCE_BASE64 || '', 'base64') });
  if (!same(profile.variables, record.variables)) fail('MERCHANT_CONFIGURATION_CHANGED');
  return profile;
}
export function validateAvatarMerchantRecord(record) {
  if (!record || record.version !== 1 || !same(record.target, avatarMerchantTarget) || !phases.includes(record.phase)
    || !/^[a-f0-9]{24}$/.test(record.id || '') || !instant(record.createdAt)
    || typeof record.bundle !== 'string' || !path.isAbsolute(record.bundle)
    || path.basename(record.bundle) !== avatarMerchantTarget.bundleName
    || record.manifestSha256 !== avatarMerchantTarget.manifestSha256 || !sha(record.zipSha256)
    || !Number.isSafeInteger(record.zipBytes) || record.zipBytes < 100 || record.zipBytes > 2 * 1024 * 1024
    || record.remark !== `mini-avatar merchant-test ${record.id}` || !record.variables || !record.merchantInputs) fail('JOURNAL_INVALID');
  validateAvatarPredecessor(record.before, record.previous);
  recordProfile(record);
  if (!same(comparableBase(record.desiredConfig), comparableBase({ ...record.before.base, envParams: JSON.stringify(record.variables) }))) fail('JOURNAL_INVALID');
  const index = phases.indexOf(record.phase);
  if (index >= phases.indexOf('upload_ready') && (!/^[A-Za-z0-9._/-]{1,512}$/.test(record.packageName || '')
    || !/^[A-Za-z0-9._-]{1,128}$/.test(record.packageVersion || ''))) fail('JOURNAL_INVALID');
  if (index >= phases.indexOf('release_requested') && !instant(record.releaseRequestedAt)) fail('JOURNAL_INVALID');
  if (record.phase === 'submitted' && (!positive(record.taskId) || record.taskId === record.previous.record.taskId)) fail('JOURNAL_INVALID');
  return record;
}

export async function archiveAvatarMerchantBundle(bundle) {
  if (typeof bundle !== 'string' || !path.isAbsolute(bundle) || path.basename(bundle) !== avatarMerchantTarget.bundleName) fail('BUNDLE_INVALID');
  const report = verifyPhotoProductionBundle(bundle);
  if (report.manifestSha256 !== avatarMerchantTarget.manifestSha256) fail('BUNDLE_CHANGED');
  const manifestBytes = fs.readFileSync(path.join(bundle, 'manifest.json'));
  if (hash(manifestBytes) !== avatarMerchantTarget.manifestSha256) fail('BUNDLE_CHANGED');
  const manifest = JSON.parse(manifestBytes), entries = manifest.files.map(item => {
    const filename = path.join(bundle, item.path), stat = fs.lstatSync(filename), bytes = fs.readFileSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename) !== path.resolve(filename)
      || bytes.length !== item.bytes || hash(bytes) !== item.sha256) fail('BUNDLE_CHANGED');
    return { name: item.path, bytes };
  });
  return packageBundle({ entries: [...entries, { name: 'manifest.json', bytes: manifestBytes }] });
}

export async function prepareAvatarMerchantRelease(adapter, { bundle, inputs, read = readState, write = saveState,
  previous = readPredecessor, inspect = inspectAvatarMerchantRelease, zipBundle = archiveAvatarMerchantBundle } = {}) {
  if (read()) fail('PENDING_JOURNAL_EXISTS');
  const prior = previous(), inherited = checkedPredecessor(prior);
  if (!inputs || !same(inputs.inherited, inherited)) fail('INHERITED_CONFIGURATION_CHANGED');
  const profile = assemble(inherited, inputs), bytes = await zipBundle(bundle);
  const before = await inspect(adapter);
  validateAvatarPredecessor(before, prior);
  const { inherited: _inherited, policyBytes: _policy, acceptanceBytes: _report, ...merchantInputs } = inputs;
  const id = crypto.randomBytes(12).toString('hex');
  const record = { version: 1, id, target: avatarMerchantTarget, phase: 'prepared', createdAt: new Date().toISOString(),
    bundle, manifestSha256: avatarMerchantTarget.manifestSha256, zipSha256: hash(bytes), zipBytes: bytes.length,
    remark: `mini-avatar merchant-test ${id}`, previous: prior, before, merchantInputs,
    variables: profile.variables, desiredConfig: normalizedConfig({ ...before.base, envParams: JSON.stringify(profile.variables) }) };
  validateAvatarMerchantRecord(record); write(record, null); return safeAvatarMerchantState(record);
}

export async function submitAvatarMerchantRelease(adapter, { read = readState, write = saveState,
  previous = readPredecessor, inspect = inspectAvatarMerchantRelease, zipBundle = archiveAvatarMerchantBundle } = {}) {
  let record = read();
  if (!record || record.phase !== 'prepared') fail('NOT_PREPARED_OR_REQUEST_UNCERTAIN');
  validateAvatarMerchantRecord(record);
  if (!same(previous(), record.previous)) fail('PREDECESSOR_JOURNAL_CHANGED');
  const bytes = await zipBundle(record.bundle);
  if (hash(bytes) !== record.zipSha256 || bytes.length !== record.zipBytes) fail('ARCHIVE_CHANGED');
  const canceledVersionState = sameBeforeSubmission(await inspect(adapter), record, false);
  const save = (phase, extra = {}) => { const next = { ...record, ...extra, phase }; write(next, record); record = next; };
  save('configure_requested');
  await adapter.CloudAPI.tcbUpdateServerBaseConfig({ ...scope, wxAppId: avatarMerchantTarget.appId, conf: record.desiredConfig });
  sameBeforeSubmission(await inspect(adapter), record, true, canceledVersionState); save('configured');
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
  save('uploaded'); sameBeforeSubmission(await inspect(adapter), record, true, canceledVersionState);
  save('release_requested', { releaseRequestedAt: new Date().toISOString() });
  const result = await adapter.CloudAPI.tcbSubmitServerRelease({ ...scope, wxAppId: avatarMerchantTarget.appId,
    deployType: 'package', releaseType: 'GRAY', hasDockerfile: true, buildDir: '.', dockerfile: 'Dockerfile', port: 3000,
    packageName: record.packageName, packageVersion: record.packageVersion, versionRemark: record.remark, operatorRemark: record.remark });
  if (!positive(result.taskId) || result.taskId === record.previous.record.taskId) fail('RELEASE_UNCONFIRMED');
  save('submitted', { taskId: result.taskId }); return safeAvatarMerchantState(record);
}

export function safeAvatarMerchantState(record) {
  return record ? { operationId: record.id, phase: record.phase, taskId: record.taskId || null,
    predecessorVersion: avatarMerchantTarget.predecessorVersion, predecessorReleaseOrderId: orderIdentity(record.before).id,
    manifestSha256: record.manifestSha256, zipSha256: record.zipSha256, zipBytes: record.zipBytes,
    paymentEnvironment: 0, mode: 'merchant_test', releaseType: 'GRAY', promoted: false,
    merchantSalesConfigured: true, runtimeSalesEnabled: null, realChargesPossibleAfterDeployment: true,
    retryAllowed: record.phase === 'prepared', callbackRoutingVerified: false } : { prepared: false };
}
export async function avatarMerchantReleaseStatus(adapter, record = readState(), inspect = inspectAvatarMerchantRelease) {
  if (!record) return safeAvatarMerchantState(record);
  validateAvatarMerchantRecord(record);
  let snapshot = await inspect(adapter);
  const matches = snapshot.versions.filter(v => v.Remark === record.remark && !record.before.versions.some(old => old.VersionName === v.VersionName));
  const taskMatches = () => record.phase === 'submitted' && snapshot.task?.id === record.taskId && Boolean(taskScoped(snapshot.task));
  const candidateName = taskMatches() && matches.length === 1 ? matches[0].VersionName : null;
  if (candidateName) snapshot = await inspect(adapter, candidateName);
  const currentTaskMatches = taskMatches();
  const finalMatches = snapshot.versions.filter(v => v.Remark === record.remark
    && !record.before.versions.some(old => old.VersionName === v.VersionName));
  const candidateCorrelated = Boolean(candidateName && currentTaskMatches && finalMatches.length === 1
    && finalMatches[0].VersionName === candidateName);
  let candidateConfigurationVerified = false, privateIngressVerified = false;
  try {
    checkPrivate(snapshot); privateIngressVerified = true;
    checkDetail(snapshot.candidate, candidateName, record.variables);
    candidateConfigurationVerified = Boolean(candidateCorrelated
      && snapshot.candidate.IsPublic === record.before.predecessor.IsPublic);
  } catch { /* A building, missing or differently configured candidate is not verified. */ }
  const order = orderIdentity(snapshot);
  const releaseOrderCorrelated = Boolean(candidateCorrelated && order.exists === true && positive(order.id)
    && order.id !== orderIdentity(record.before).id && order.serverName === scope.serverName
    && order.current === avatarMerchantTarget.currentVersion && order.candidate === candidateName);
  const sameDetails = () => {
    try { return ['current', 'previous', 'predecessor'].every(key => same(comparableDetail(snapshot[key]), comparableDetail(record.before[key]))); }
    catch { return false; }
  };
  const taskStatus = ['running', 'finished', 'stopped', 'failed'].includes(snapshot.task?.status) ? snapshot.task.status : 'unknown';
  return { ...safeAvatarMerchantState(record), cloud: { candidateVersion: candidateName, taskId: positive(snapshot.task?.id) ? snapshot.task.id : null,
    taskStatus, currentTaskMatches, releaseOrderCorrelated,
    grayTestReleaseVerified: releaseOrderCorrelated && order.status === 'test' && order.isReleasing === true,
    candidateConfigurationVerified, privateIngressVerified,
    desiredBaseVerified: same(comparableBase(snapshot.base), comparableBase(record.desiredConfig)),
    predecessorConfigurationsUnchanged: sameDetails(),
    priorVersionStateUnchanged: same(versionState(snapshot.versions.filter(v => record.before.versions.some(old => old.VersionName === v.VersionName))), versionState(record.before.versions)),
    startupVerified: false, routingVerified: false, paymentCallbackRoutingVerified: false } };
}

function privateRead(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('PRIVATE_FILE_INVALID');
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
function readPredecessor() {
  const bytes = privateRead(predecessorFile), backupBytes = privateRead(`${predecessorFile}.backup`);
  const record = JSON.parse(bytes), backup = JSON.parse(backupBytes);
  if (backup.phase !== 'prepared' || !same(immutable(record), immutable(backup))) fail('PREDECESSOR_JOURNAL_CHANGED');
  const previous = { record, sha256: hash(bytes), backupSha256: hash(backupBytes) };
  checkedPredecessor(previous); return previous;
}
function readState() {
  if (!fs.existsSync(journalFile)) {
    if (fs.existsSync(`${journalFile}.backup`)) fail('PARTIAL_JOURNAL_EXISTS');
    return null;
  }
  const record = JSON.parse(privateRead(journalFile)), backup = JSON.parse(privateRead(`${journalFile}.backup`));
  if (backup.phase !== 'prepared' || !same(immutable(record), immutable(backup))) fail('JOURNAL_CHANGED');
  return validateAvatarMerchantRecord(record);
}
function saveState(record, previous) {
  validateAvatarMerchantRecord(record);
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
function readInputs(filename) {
  const input = JSON.parse(privateRead(path.resolve(filename)));
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.hasOwn(input, 'policyBytes') || Object.hasOwn(input, 'acceptanceBytes')) fail('MERCHANT_INPUT_INVALID');
  // Exact reviewed local evidence only; no override file, env loader or inferred
  // identity/disclosure. The existing assembler rejects every unknown field.
  return { ...input,
    policyBytes: fs.readFileSync(path.join(server, 'docs/production-config/natural-avatar-merchant-policy-2026-10-13.json')),
    acceptanceBytes: fs.readFileSync(path.join(server, 'evidence/mini-photo-natural-avatar-v2-runtime-2026-10-13.json')) };
}
export const avatarMerchantPlan = Object.freeze({ action: 'plan', privateFilesRead: false, cloudOperationPerformed: false,
  target: 'buildtest', predecessor: 'buildtest-015', bundleName: avatarMerchantTarget.bundleName,
  manifestSha256: avatarMerchantTarget.manifestSha256, paymentEnvironment: 0, mode: 'merchant_test',
  releaseType: 'GRAY', promoted: false, realChargesPossibleAfterDeployment: true,
  operations: ['prepare: read-only cloud inspection and new private journal', 'cancel the exact recorded 015 test release in console',
    'submit: verify cancellation, update base configuration, upload the pinned package, submit one GRAY release', 'status: read-only candidate verification'],
  uncertainRequestPolicy: 'never resubmit; inspect status',
  requiredInputs: ['complete unchanged 015 refresh journal and backup', 'explicit merchant-profile input JSON',
    'verified native test/refund identities and disclosure facts', 'pinned avatar-ready bundle'],
  remainingChecks: ['native route and runtime', 'formal WeChat product and notification route to the same ledger', 'payment, delivery and refund'] });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || (args.length === 1 && args[0] === 'plan')) console.log(JSON.stringify(avatarMerchantPlan));
    else {
      const [action, bundle, inputFile, ...rest] = args;
      if (rest.length || !['prepare', 'submit', 'status'].includes(action)
        || (action === 'prepare' ? !bundle || !inputFile : args.length !== 1)) fail('ARGUMENT_INVALID');
      const run = () => withProductionCloud(adapter => action === 'prepare'
        ? prepareAvatarMerchantRelease(adapter, { bundle: path.resolve(bundle), inputs: readInputs(inputFile) })
        : action === 'submit' ? submitAvatarMerchantRelease(adapter) : avatarMerchantReleaseStatus(adapter));
      console.log(JSON.stringify(await (action === 'status' ? run() : withLock(run))));
    }
  } catch (error) {
    console.error(/^AVATAR_MERCHANT_[A-Z_]+$/.test(error?.code || '') ? error.code : 'AVATAR_MERCHANT_OPERATION_UNCONFIRMED');
    process.exitCode = 1;
  }
}
