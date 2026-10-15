import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { productionCloud, withProductionCloud } from './inspect-mini-production-cloud.mjs';
import { inspectMultiEffectMerchantRelease, multiEffectMerchantTarget } from './deploy-mini-multieffect-merchant-test.mjs';
import { prepareOriginalEffectsFacts, ORIGINAL_LEGAL_REVIEW } from './deploy-mini-original-effects-legal.mjs';
import { merchantTestProduct } from './prepare-mini-production-merchant-test.mjs';

// One version-specific environment update. Does not update service base, submit
// a release, rebuild, cancel, promote, set traffic, or edit the 017 deploy journal.
// SDK existence/serialization is verified offline; platform acceptance and runtime
// application remain unconfirmed until this exact operation is read back.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const journalFile = path.join(server, '.env.mini-017-disclosure-update.json');
export const disclosure017Target = Object.freeze({ ...productionCloud, serverName: 'buildtest',
  sourceVersion: 'buildtest-016', candidateVersion: 'buildtest-017', taskId: 2361455, releaseOrderId: 2856443,
  policySha256: multiEffectMerchantTarget.policySha256, acceptanceSha256: multiEffectMerchantTarget.acceptanceSha256,
  factsSha256: ORIGINAL_LEGAL_REVIEW.factsSha256,
  legalEvidenceSha256: '08612bbb3262520619555e36fa63608e4e6a44abb5f2e4cb876c71feafa9be9b',
  routeEvidenceSha256: '1c47df1b203a057c727d04ea3a66a70f86ba8569c4ddeb834947c30e03eef327' });
const fail = suffix => { throw Object.assign(new Error(`DISCLOSURE_017_${suffix}`), { code: `DISCLOSURE_017_${suffix}` }); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const env = value => JSON.parse(value || '{}');
const clone = value => JSON.parse(JSON.stringify(value));
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const clean = value => clone(Object.fromEntries(Object.entries(value).filter(([key]) =>
  !['RequestId', 'CreatedTime', 'UpdatedTime', 'Status', 'CpuTotalQuota', 'MemTotalQuota', 'VersionIP'].includes(key))));
const detailConfig = value => ({ ...clean(value), EnvParams: env(value.EnvParams) });
// The official SDK exposes absent optional properties as own undefined values
// (observed: publicAccess/operatorRemark); JSON journals omit those properties.
// Normalize only that representation difference. Null, false, empty text and
// every other defined configuration value must still compare exactly.
const baseConfig = value => ({ ...Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)), envParams: env(value.envParams) });
const domainConfig = value => Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'RequestId'));
// CloudBase refreshes these control-plane timestamps while a test order is
// running. They carry no routing/configuration meaning; every other order
// identity, status and URL_PARAMS rule remains exact.
const orderConfig = value => {
  const order = clone(value);
  const release = order.releaseOrderInfo && typeof order.releaseOrderInfo === 'object' ? order.releaseOrderInfo : order;
  for (const key of ['createdTime', 'updatedTime']) { delete order[key]; delete release[key]; }
  for (const key of ['currentVersion', 'releaseVersion']) {
    if (release[key] && typeof release[key] === 'object') {
      delete release[key].createdTime; delete release[key].updatedTime;
    }
  }
  return order;
};
const versions = value => value.map(v => ({ name: v.VersionName, status: v.Status, flow: v.FlowRatio, remark: v.Remark })).sort((a, b) => a.name.localeCompare(b.name));
const phases = ['prepared', 'update_requested', 'submitted'];
const immutable = record => Object.fromEntries(Object.entries(record).filter(([key]) => !['phase', 'requestedAt', 'ackSha256'].includes(key)));
function localEvidence() {
  for (const [file, expected] of [['mini-original-effects-legal-refresh-2026-10-15.json', disclosure017Target.legalEvidenceSha256],
    ['mini-original-effects-route-readonly-2026-10-15.json', disclosure017Target.routeEvidenceSha256]]) {
    if (hash(fs.readFileSync(path.join(server, 'evidence', file))) !== expected) fail('EVIDENCE_CHANGED');
  }
}
function checkPrivate(snapshot) {
  if (!same(snapshot.domain?.AccessTypes, ['MINIAPP']) || !same(snapshot.base?.openAccessTypes, ['MINIAPP'])
    || snapshot.base.publicAccess === true || snapshot.base.minNum !== 0 || snapshot.base.maxNum !== 1
    || snapshot.base.cpu !== 0.25 || snapshot.base.mem !== 0.5) fail('PRIVATE_SCOPE_CHANGED');
}
function checkDetail(detail, name) {
  if (!detail || detail.VersionName !== name || detail.ServerName !== 'buildtest'
    || (detail.EnvId !== undefined && detail.EnvId !== disclosure017Target.envId) || detail.Status !== 'normal'
    || detail.ContainerPort !== 3000 || detail.MinNum !== 0 || detail.MaxNum !== 1 || detail.Cpu !== 0.25 || detail.Mem !== 0.5) fail('VERSION_SCOPE_CHANGED');
}
export function validateDisclosure017Snapshot(snapshot) {
  checkPrivate(snapshot); checkDetail(snapshot.current, 'buildtest-016'); checkDetail(snapshot.candidate, 'buildtest-017');
  const order = snapshot.order?.releaseOrderInfo, task = snapshot.task;
  if (snapshot.order?.isExist !== true || order?.id !== disclosure017Target.releaseOrderId || order.serverName !== 'buildtest'
    || order.currentVersion?.versionName !== 'buildtest-016' || order.releaseVersion?.versionName !== 'buildtest-017'
    || order.releaseStatus !== 'test' || order.isReleasing !== true || order.trafficType !== 'URL_PARAMS'
    || !Array.isArray(order.trafficTypeValues) || order.trafficTypeValues.length !== 1
    || !order.trafficTypeValues.every(v => v && typeof v.key === 'string' && v.key.length > 0 && typeof v.value === 'string' && v.value.length > 0)
    || task?.id !== disclosure017Target.taskId || task.status !== 'running'
    || (task.envId !== undefined && task.envId !== disclosure017Target.envId)
    || (task.serverName !== undefined && task.serverName !== 'buildtest')
    || !Array.isArray(snapshot.versions) || !snapshot.versions.length || snapshot.versions.length > 100
    || new Set(snapshot.versions.map(v => v.VersionName)).size !== snapshot.versions.length
    || snapshot.versions.some(v => !/^buildtest-\d+$/.test(v.VersionName) || v.Status !== 'normal' || v.FlowRatio !== 0)
    || !['buildtest-016', 'buildtest-017'].every(name => snapshot.versions.some(v => v.VersionName === name))) fail('TEST_ROUTE_CHANGED');
  return env(snapshot.candidate.EnvParams);
}
function assemble(variables) {
  const users = value => typeof value === 'string' && value.split(',').length <= 20
    && value.split(',').every(id => /^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id.trim()));
  if (variables.WECHAT_APP_ID !== disclosure017Target.appId || variables.XPAY_ENABLED !== 'true'
    || variables.XPAY_RECONCILE_ENABLED !== 'true' || variables.XPAY_DB_BACKEND !== 'mysql'
    || !users(variables.XPAY_TEST_USER_IDS) || !users(variables.XPAY_REFUND_OPERATOR_USER_IDS)
    || !same(env(variables.XPAY_PRODUCTS_JSON), [merchantTestProduct])) fail('MERCHANT_SCOPE_CHANGED');
  if (variables.PHOTO_PRODUCTION_CONFIG_SHA256 !== disclosure017Target.policySha256
    || variables.PHOTO_PRODUCTION_ACCEPTANCE_SHA256 !== disclosure017Target.acceptanceSha256) fail('CANDIDATE_PINS_CHANGED');
  for (const prefix of ['PHOTO_PRODUCTION_CONFIG', 'PHOTO_PRODUCTION_ACCEPTANCE']) {
    const bytes = Buffer.from(variables[`${prefix}_BASE64`] || '', 'base64');
    if (bytes.toString('base64') !== variables[`${prefix}_BASE64`] || hash(bytes) !== variables[`${prefix}_SHA256`]) fail('CANDIDATE_PINS_CHANGED');
  }
  try { return prepareOriginalEffectsFacts(variables).variables; } catch { fail('FACTS_MISMATCH'); }
}
function snapshotComparisons(snapshot, before, desiredVariables) {
  let scope = false;
  try { validateDisclosure017Snapshot(snapshot); scope = true; } catch { /* Safely expose only the failed scope boolean. */ }
  const expectedCandidate = { ...detailConfig(before.candidate), EnvParams: desiredVariables || env(before.candidate.EnvParams) };
  return { scope, candidate: same(detailConfig(snapshot.candidate), expectedCandidate),
    current: same(detailConfig(snapshot.current), detailConfig(before.current)),
    historicalCurrent: same(detailConfig(snapshot.historicalCurrent), detailConfig(before.historicalCurrent)),
    historicalPrevious: same(detailConfig(snapshot.historicalPrevious), detailConfig(before.historicalPrevious)),
    base: same(baseConfig(snapshot.base), baseConfig(before.base)),
    domain: same(domainConfig(snapshot.domain), domainConfig(before.domain)),
    versions: same(versions(snapshot.versions), versions(before.versions)),
    order: same(orderConfig(snapshot.order), orderConfig(before.order)),
    task: same({ id: snapshot.task.id, status: snapshot.task.status }, { id: before.task.id, status: before.task.status }) };
}
function snapshotMatches(snapshot, before, desiredVariables) {
  return Object.values(snapshotComparisons(snapshot, before, desiredVariables)).every(value => value === true);
}
export function validateDisclosure017Record(record) {
  if (!record || record.version !== 1 || !same(record.target, disclosure017Target) || !phases.includes(record.phase)
    || !/^[a-f0-9]{24}$/.test(record.id || '') || !Number.isFinite(Date.parse(record.createdAt))) fail('JOURNAL_INVALID');
  const inherited = validateDisclosure017Snapshot(record.before), variables = assemble(inherited);
  if (!same(env(record.before.base.envParams), inherited) || !same(record.variables, variables)
    || !same(record.changedKeys, ['AI_SERVICE_DISCLOSURES_JSON'])
    || record.phase !== 'prepared' && !Number.isFinite(Date.parse(record.requestedAt))
    || record.phase === 'submitted' && !sha(record.ackSha256)) fail('JOURNAL_INVALID');
  return record;
}
const inspectDefault = adapter => inspectMultiEffectMerchantRelease(adapter, 'buildtest-017');
export async function prepareDisclosure017(adapter, { read = readState, write = saveState, inspect = inspectDefault } = {}) {
  if (read()) fail('JOURNAL_EXISTS'); localEvidence();
  const before = await inspect(adapter), inherited = validateDisclosure017Snapshot(before), variables = assemble(inherited);
  if (!same(env(before.base.envParams), inherited)) fail('BASE_CANDIDATE_DIFFER');
  const record = { version: 1, id: crypto.randomBytes(12).toString('hex'), target: disclosure017Target,
    createdAt: new Date().toISOString(), phase: 'prepared', before, variables, changedKeys: ['AI_SERVICE_DISCLOSURES_JSON'] };
  validateDisclosure017Record(record); write(record, null); return safeDisclosure017(record);
}
export function safeDisclosure017(record) {
  return record ? { operationId: record.id, phase: record.phase, sourceVersion: 'buildtest-016', candidateVersion: 'buildtest-017',
    releaseOrderId: disclosure017Target.releaseOrderId, releaseTaskId: disclosure017Target.taskId,
    changedKeys: ['AI_SERVICE_DISCLOSURES_JSON'], factsSha256: disclosure017Target.factsSha256,
    updatesBase: false, createsVersion: false, modifiesTraffic: false, modifiesProduct: false,
    retryAllowed: record.phase === 'prepared', platformAcceptanceVerified: false, runtimeDisclosureVerified: false } : { prepared: false };
}
// Classify future transport failures without emitting response bodies, request
// configuration, headers, URLs or arbitrary provider message fragments. This
// cannot reconstruct an earlier exception that was not retained by its process.
export function safeDisclosureCloudError(error) {
  const message = String(error?.message || ''), rawCode = String(error?.code || '');
  const roots = ['AuthFailure', 'UnauthorizedOperation', 'InvalidAction', 'UnsupportedOperation', 'ResourceInUse',
    'FailedOperation', 'InvalidParameter', 'MissingParameter', 'RequestLimitExceeded', 'InternalError', 'ResourceNotFound'];
  const sdkFamily = roots.find(root => rawCode === root || rawCode.startsWith(root + '.')
    || message.startsWith(root + ',') || message.startsWith(root + '.')) || null;
  let gatewayRet = null;
  if (message.startsWith('Base resp abnormal, ')) {
    try { const ret = JSON.parse(message.slice('Base resp abnormal, '.length))?.ret;
      if (Number.isSafeInteger(Number(ret)) && /^-?\d{1,9}$/.test(String(ret))) gatewayRet = Number(ret);
    } catch { /* No raw response recovery/output. */ }
  }
  const prefix = /^(-?\d{1,9})\s/.exec(message), gatewayErrCode = prefix ? Number(prefix[1]) : null;
  const networkCode = ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_NETWORK'].includes(rawCode) ? rawCode : null;
  const httpStatus = Number.isInteger(error?.response?.status) && error.response.status >= 100 && error.response.status <= 599 ? error.response.status : null;
  return { sdkFamily, gatewayRet, gatewayErrCode, networkCode, httpStatus,
    thirdPartyManagementDenied: message === 'NO_CLOUD_MANAGE_PERMISSION_AUTHORIZED_TO_3RD_PLATFORM' || gatewayRet === 80210,
    permissionMentioned: /permission|unauthor|forbidden|权限|无权/i.test(message),
    sourceRestrictionMentioned: /source|来源|渠道|用户类型|user type/i.test(message),
    unsupportedMentioned: /not support|unsupported|不支持/i.test(message),
    activeReleaseMentioned: /pending|releasing|发布中|发布单|测试中/i.test(message),
    timeoutMentioned: /timeout|timed out|超时/i.test(message),
    responseValidationFailed: /Type not equal|content empty|validation schema/i.test(message),
    finalRequestOutcomeKnown: false, retryAllowed: false };
}
export async function submitDisclosure017(adapter, { read = readState, write = saveState, inspect = inspectDefault } = {}) {
  let record = read(); if (!record || record.phase !== 'prepared') fail('NOT_PREPARED_OR_REQUEST_UNCERTAIN');
  validateDisclosure017Record(record); localEvidence();
  if (!snapshotMatches(await inspect(adapter), record.before)) fail('REMOTE_STATE_CHANGED');
  if (typeof adapter.CloudAPI?.tcbModifyCloudBaseRunServerVersion !== 'function') fail('SDK_METHOD_UNAVAILABLE');
  const next = { ...record, phase: 'update_requested', requestedAt: new Date().toISOString() }; write(next, record); record = next;
  // The installed official SDK drops omitted optional fields. No BasicModify,
  // resource, remark, traffic, base-config or release parameters are guessed.
  let response;
  try {
    response = await adapter.CloudAPI.tcbModifyCloudBaseRunServerVersion({ region: disclosure017Target.region,
      envId: disclosure017Target.envId, serverName: 'buildtest', versionName: 'buildtest-017', envParams: JSON.stringify(record.variables) });
  } catch (error) {
    throw Object.assign(new Error('DISCLOSURE_017_UPDATE_REQUEST_UNCONFIRMED'), {
      code: 'DISCLOSURE_017_UPDATE_REQUEST_UNCONFIRMED', safeDiagnostic: safeDisclosureCloudError(error) });
  }
  if (typeof response?.result !== 'string' || !response.result || response.result.length > 512) fail('UPDATE_UNCONFIRMED');
  const submitted = { ...record, phase: 'submitted', ackSha256: hash(response.result) }; write(submitted, record); record = submitted;
  return disclosure017Status(adapter, record, inspect);
}
export async function disclosure017Status(adapter, record = readState(), inspect = inspectDefault) {
  if (!record) return safeDisclosure017(record); validateDisclosure017Record(record);
  const snapshot = await inspect(adapter);
  let exactBefore = false, exactAfter = false, beforeComparisons = null, afterComparisons = null, persistedRepresentation = null;
  try {
    beforeComparisons = snapshotComparisons(snapshot, record.before);
    afterComparisons = snapshotComparisons(snapshot, record.before, record.variables);
    exactBefore = Object.values(beforeComparisons).every(value => value === true);
    exactAfter = Object.values(afterComparisons).every(value => value === true);
    persistedRepresentation = { base: same(clone(baseConfig(snapshot.base)), clone(baseConfig(record.before.base))),
      domain: same(clone(domainConfig(snapshot.domain)), clone(domainConfig(record.before.domain))),
      versions: same(clone(versions(snapshot.versions)), clone(versions(record.before.versions))) };
  } catch { /* Any drift is unconfirmed. */ }
  return { ...safeDisclosure017(record), controlPlane: { exactBefore, exactAfter, beforeComparisons, afterComparisons, persistedRepresentation,
    candidateFactsAppliedWithOtherStateUnchanged: exactAfter,
    candidateNormal: snapshot.candidate?.Status === 'normal', baseIntentionallyUnchanged: same(baseConfig(snapshot.base), baseConfig(record.before.base)),
    futureDeploymentMustExplicitlyRetainUpdatedFacts: exactAfter,
    observationIsFinalRequestOutcome: false }, runtimeDisclosureVerified: false };
}

export function privateRead(filename) {
  execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true });
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > 4 * 1024 * 1024) fail('PRIVATE_FILE_INVALID');
  return fs.readFileSync(filename, 'utf8');
}
export function privateCreate(filename, content) {
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
export function readDisclosure017State() { return readState(); }
function readState() {
  if (!fs.existsSync(journalFile)) { if (fs.existsSync(`${journalFile}.backup`)) fail('PARTIAL_JOURNAL_EXISTS'); return null; }
  const record = JSON.parse(privateRead(journalFile)), backup = JSON.parse(privateRead(`${journalFile}.backup`));
  if (backup.phase !== 'prepared' || !same(immutable(record), immutable(backup))) fail('JOURNAL_CHANGED');
  return validateDisclosure017Record(record);
}
function saveState(record, previous) {
  validateDisclosure017Record(record);
  if (!previous) { privateCreate(`${journalFile}.backup`, JSON.stringify(record) + '\n'); privateCreate(journalFile, JSON.stringify(record) + '\n'); return; }
  if (privateRead(journalFile) !== JSON.stringify(previous) + '\n' || !same(immutable(record), immutable(previous))) fail('JOURNAL_CHANGED');
  const temporary = `${journalFile}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  privateCreate(temporary, JSON.stringify(record) + '\n'); fs.renameSync(temporary, journalFile);
  if (privateRead(journalFile) !== JSON.stringify(record) + '\n') fail('JOURNAL_SAVE_UNCONFIRMED');
}
async function withLock(operation) {
  const filename = `${journalFile}.lock`, token = crypto.randomBytes(24).toString('hex'); privateCreate(filename, token);
  try { return await operation(); } finally { if (privateRead(filename) === token) fs.unlinkSync(filename); }
}
export const disclosure017Plan = Object.freeze({ action: 'plan', target: disclosure017Target,
  changedKeys: ['AI_SERVICE_DISCLOSURES_JSON'], api: 'ModifyCloudBaseRunServerVersion',
  readsCredentials: false, cloudOperationPerformed: false, createsVersion: false, updatesBase: false,
  altersDeploymentJournal: false, runtimeDisclosureVerified: false,
  uncertaintyPolicy: 'one request after durable intent; unknown response permits read-only status only',
  platformCompatibility: 'official installed SDK contract verified; live write not yet tested' });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), action = args[0] || 'plan';
    if (args.length > 1 || !['plan', 'prepare', 'submit', 'status'].includes(action)) fail('ARGUMENT_INVALID');
    if (action === 'plan') console.log(JSON.stringify(disclosure017Plan));
    else {
      const run = () => withProductionCloud(adapter => action === 'prepare' ? prepareDisclosure017(adapter)
        : action === 'submit' ? submitDisclosure017(adapter) : disclosure017Status(adapter));
      console.log(JSON.stringify(await (action === 'status' ? run() : withLock(run))));
    }
  } catch (error) {
    const code = /^DISCLOSURE_017_[A-Z_]+$/.test(error?.code || '') ? error.code : 'DISCLOSURE_017_OPERATION_UNCONFIRMED';
    console.error(error?.safeDiagnostic ? JSON.stringify({ code, diagnostic: error.safeDiagnostic }) : code); process.exitCode = 1;
  }
}
