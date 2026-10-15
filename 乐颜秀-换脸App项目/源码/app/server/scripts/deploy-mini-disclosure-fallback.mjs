import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import { withProductionCloud } from './inspect-mini-production-cloud.mjs';
import { normalizedConfig } from './deploy-mini-sandbox-cloud.mjs';
import { archiveMultiEffectMerchantBundle, inspectMultiEffectMerchantRelease, multiEffectMerchantTarget,
  executePinnedMerchantPackageRelease } from './deploy-mini-multieffect-merchant-test.mjs';
import { disclosure017Target, readDisclosure017State, validateDisclosure017Record, privateRead, privateCreate,
  safeDisclosureCloudError } from './update-mini-017-disclosure.mjs';

// New operation only, after the console has canceled 017's test. The earlier
// version-specific unknown update remains unknown forever in its own journal.
// This module never cancels, retries that update, promotes or configures routes.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const journal = path.join(server, '.env.mini-disclosure-fallback.json');
export const disclosureFallbackTarget = Object.freeze({ ...multiEffectMerchantTarget,
  canceledReleaseOrderId: 2856443, canceledTaskId: 2361455, isolatedVersion: 'buildtest-017',
  isolatedOperationId: '47ea7c601bd43cae24031170', factsSha256: disclosure017Target.factsSha256 });
const fail = code => { throw Object.assign(new Error(`DISCLOSURE_FALLBACK_${code}`), { code: `DISCLOSURE_FALLBACK_${code}` }); };
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const env = value => JSON.parse(value || '{}');
const positive = value => Number.isSafeInteger(value) && value > 0;
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const detail = value => ({ ...clone(Object.fromEntries(Object.entries(value).filter(([key]) =>
  !['RequestId', 'CreatedTime', 'UpdatedTime', 'Status', 'CpuTotalQuota', 'MemTotalQuota', 'VersionIP'].includes(key)))), EnvParams: env(value.EnvParams) });
const base = value => clone({ ...value, envParams: env(value.envParams) });
// The legacy normalizer defaults an absent/empty logType to "none". This facts
// refresh must preserve the live logging representation as well as its policy.
const desiredConfig = (before, variables) => clone({ ...normalizedConfig({ ...before, envParams: JSON.stringify(variables) }), logType: before.logType });
const domain = value => clone(Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'RequestId')));
const versionState = list => list.map(v => ({ name: v.VersionName, status: v.Status, flow: v.FlowRatio, remark: v.Remark })).sort((a, b) => a.name.localeCompare(b.name));
const order = value => {
  const result = clone(value), info = result.releaseOrderInfo;
  for (const item of [result, info, info?.currentVersion, info?.releaseVersion]) {
    if (item) { delete item.createdTime; delete item.updatedTime; }
  }
  return result;
};
const phases = ['prepared', 'configure_requested', 'configured', 'upload_authorization_requested', 'upload_ready',
  'upload_requested', 'uploaded', 'release_requested', 'submitted'];
const mutable = new Set(['phase', 'packageName', 'packageVersion', 'taskId', 'releaseRequestedAt']);
const immutable = record => Object.fromEntries(Object.entries(record).filter(([key]) => !mutable.has(key)));
function validateUnknown(record) {
  validateDisclosure017Record(record);
  if (record.id !== disclosureFallbackTarget.isolatedOperationId || record.phase !== 'update_requested' || record.ackSha256 !== undefined) fail('UNKNOWN_OPERATION_CHANGED');
}
function evidence() {
  for (const [filename, expected] of [['mini-original-effects-legal-refresh-2026-10-15.json', disclosure017Target.legalEvidenceSha256],
    ['mini-original-effects-route-readonly-2026-10-15.json', disclosure017Target.routeEvidenceSha256]]) {
    if (hash(fs.readFileSync(path.join(server, 'evidence', filename))) !== expected) fail('EVIDENCE_CHANGED');
  }
}
export async function inspectDisclosureFallback(adapter, candidateName) {
  const snapshot = await inspectMultiEffectMerchantRelease(adapter, 'buildtest-017');
  // inspectMultiEffectMerchantRelease already validates every page against the
  // official TotalCount, including duplicate and incomplete-list rejection.
  snapshot.versionsComplete = true; snapshot.versionTotalCount = snapshot.versions.length;
  snapshot.isolatedCandidate = snapshot.candidate;
  snapshot.knownVersions = {};
  if (!Array.isArray(snapshot.versions) || snapshot.versions.length > 100) fail('INVENTORY_INVALID');
  const existing = [snapshot.current, snapshot.historicalCurrent, snapshot.historicalPrevious, snapshot.isolatedCandidate];
  for (const item of snapshot.versions) {
    snapshot.knownVersions[item.VersionName] = existing.find(v => v?.VersionName === item.VersionName)
      || await adapter.api.DescribeCloudBaseRunServerVersion({ EnvId: disclosure017Target.envId,
        ServerName: 'buildtest', VersionName: item.VersionName });
  }
  snapshot.candidate = candidateName ? snapshot.knownVersions[candidateName] : null;
  return snapshot;
}
function unchangedDetails(snapshot, before) {
  return Object.keys(before.knownVersions).every(name => snapshot.knownVersions[name]
    && same(detail(snapshot.knownVersions[name]), detail(before.knownVersions[name])));
}
// Readback only: reuse the latest-ten retention rule already documented in
// deploy-mini-sandbox-cloud. Never use this exception before any mutation.
export function fallbackHistoricalReadback(snapshot, record, candidateName) {
  const prior = record.before.versions, actual = snapshot.versions.map(v => v.VersionName);
  const names = prior.map(v => v.VersionName), missing = names.filter(name => !actual.includes(name));
  if (!missing.length) return { configurationsUnchanged: unchangedDetails(snapshot, record.before), expectedHistoricalEviction: null };
  const expected = [...names, candidateName];
  const validNames = expected.every(name => /^buildtest-\d+$/.test(name || '') && Number.isSafeInteger(Number(name.slice(10))));
  const sorted = validNames ? [...expected].sort((a, b) => Number(a.slice(10)) - Number(b.slice(10))) : [];
  const oldest = prior.find(v => v.VersionName === sorted[0]);
  const allowed = record.id === '22e44a104421bb656feef8e1' && record.taskId === 2363777
    && candidateName === 'buildtest-018' && missing[0] === 'buildtest-008' && validNames && prior.length === 10 && snapshot.versionsComplete === true
    && snapshot.versionTotalCount === 10 && actual.length === 10 && new Set(actual).size === 10 && new Set(expected).size === 11
    && missing.length === 1 && missing[0] === sorted[0] && sorted.at(-1) === candidateName
    && !['buildtest-016', 'buildtest-017'].includes(missing[0]) && oldest?.FlowRatio === 0 && oldest.Status === 'normal'
    && same([...actual].sort(), sorted.slice(1).sort());
  if (!allowed) return { configurationsUnchanged: false, expectedHistoricalEviction: null };
  const retained = Object.fromEntries(Object.entries(record.before.knownVersions).filter(([name]) => name !== missing[0]));
  return { configurationsUnchanged: unchangedDetails(snapshot, { knownVersions: retained }), expectedHistoricalEviction: missing[0] };
}
export function validateFallbackPredecessor(snapshot, unknown, desiredBase) {
  validateUnknown(unknown);
  const info = snapshot.order?.releaseOrderInfo;
  if (snapshot.order?.isExist !== true || info?.id !== 2856443 || info.serverName !== 'buildtest'
    || info.currentVersion?.versionName !== 'buildtest-016' || info.releaseVersion?.versionName !== 'buildtest-017'
    || info.releaseStatus !== 'cancel' || info.isReleasing !== false || info.trafficType !== 'FLOW' || !same(info.trafficTypeValues, [])
    || snapshot.task?.id !== 2361455 || snapshot.task.status !== 'stopped'
    || snapshot.task.envId !== undefined && snapshot.task.envId !== disclosure017Target.envId
    || snapshot.task.serverName !== undefined && snapshot.task.serverName !== 'buildtest') fail('CANCELED_017_REQUIRED');
  if (!same(domain(snapshot.domain), domain(unknown.before.domain))
    || !same(base(snapshot.base), base(desiredBase || unknown.before.base))) fail('BASE_OR_INGRESS_CHANGED');
  const expectedVersions = unknown.before.versions.map(v => ({ ...v, FlowRatio: v.VersionName === 'buildtest-016' ? 100 : 0 }));
  if (!same(versionState(snapshot.versions), versionState(expectedVersions))) fail('DEFAULT_016_REQUIRED');
  for (const key of ['current', 'historicalCurrent', 'historicalPrevious']) {
    if (!same(detail(snapshot[key]), detail(unknown.before[key]))) fail('SOURCE_CHANGED');
  }
  // A late response may only change this quarantined version's one facts field.
  // New version creation uses the new base, never 017's mutable environment.
  const isolated = detail(snapshot.isolatedCandidate), old = detail(unknown.before.candidate);
  if (!same(isolated, old) && !same(isolated, { ...old, EnvParams: unknown.variables })) fail('ISOLATED_VERSION_CHANGED');
  const names = snapshot.versions.map(v => v.VersionName).sort();
  if (!same(Object.keys(snapshot.knownVersions || {}).sort(), names)
    || names.some(name => snapshot.knownVersions[name].VersionName !== name
      || snapshot.knownVersions[name].ServerName !== 'buildtest' || snapshot.knownVersions[name].Status !== 'normal'
      || snapshot.knownVersions[name].EnvId !== undefined && snapshot.knownVersions[name].EnvId !== disclosure017Target.envId)) fail('DETAIL_INVENTORY_INVALID');
  return unknown.variables;
}
export function validateDisclosureFallbackRecord(record) {
  if (!record || record.version !== 1 || !same(record.target, disclosureFallbackTarget) || !phases.includes(record.phase)
    || !/^[a-f0-9]{24}$/.test(record.id || '') || !Number.isFinite(Date.parse(record.createdAt))
    || record.remark !== `mini-disclosure fallback ${record.id}` || !path.isAbsolute(record.bundle || '')
    || path.basename(record.bundle) !== disclosureFallbackTarget.bundleName || record.manifestSha256 !== disclosureFallbackTarget.manifestSha256
    || !sha(record.zipSha256) || !Number.isSafeInteger(record.zipBytes) || record.zipBytes < 100 || record.zipBytes > 2 * 1024 * 1024) fail('JOURNAL_INVALID');
  const variables = validateFallbackPredecessor(record.before, record.unknown);
  if (!same(variables, record.variables) || !same(record.desiredConfig, desiredConfig(record.before.base, variables))
    || !same(base(record.desiredConfig), base({ ...record.before.base, envParams: JSON.stringify(variables) }))) fail('JOURNAL_INVALID');
  const index = phases.indexOf(record.phase);
  if (index >= phases.indexOf('upload_ready') && (!/^[A-Za-z0-9._/-]{1,512}$/.test(record.packageName || '')
    || !/^[A-Za-z0-9._-]{1,128}$/.test(record.packageVersion || ''))) fail('JOURNAL_INVALID');
  if (index >= phases.indexOf('release_requested') && !Number.isFinite(Date.parse(record.releaseRequestedAt))) fail('JOURNAL_INVALID');
  if (record.phase === 'submitted' && (!positive(record.taskId) || record.taskId === 2361455)) fail('JOURNAL_INVALID');
  return record;
}
function sameBefore(snapshot, record, configured) {
  validateFallbackPredecessor(snapshot, record.unknown, configured ? record.desiredConfig : undefined);
  if (!same(order(snapshot.order), order(record.before.order)) || !unchangedDetails(snapshot, record.before)
    || !same({ id: snapshot.task.id, status: snapshot.task.status }, { id: record.before.task.id, status: record.before.task.status })) fail('REMOTE_STATE_CHANGED');
}
export async function prepareDisclosureFallback(adapter, { bundle, manifestSha256, read = readState, write = saveState,
  readUnknown = readDisclosure017State, inspect = inspectDisclosureFallback, zipBundle = archiveMultiEffectMerchantBundle } = {}) {
  if (read()) fail('JOURNAL_EXISTS'); evidence();
  const unknown = readUnknown(); validateUnknown(unknown);
  const bytes = await zipBundle(bundle, manifestSha256), before = await inspect(adapter);
  const variables = validateFallbackPredecessor(before, unknown), id = crypto.randomBytes(12).toString('hex');
  const record = { version: 1, id, target: disclosureFallbackTarget, phase: 'prepared', createdAt: new Date().toISOString(),
    bundle, manifestSha256, zipSha256: hash(bytes), zipBytes: bytes.length, remark: `mini-disclosure fallback ${id}`,
    before, unknown, variables, desiredConfig: desiredConfig(before.base, variables) };
  validateDisclosureFallbackRecord(record); write(record, null); return safeDisclosureFallback(record);
}
export async function submitDisclosureFallback(adapter, { read = readState, write = saveState, readUnknown = readDisclosure017State,
  inspect = inspectDisclosureFallback, zipBundle = archiveMultiEffectMerchantBundle } = {}) {
  const record = read(); if (!record || record.phase !== 'prepared') fail('NOT_PREPARED_OR_REQUEST_UNCERTAIN');
  validateDisclosureFallbackRecord(record); evidence();
  if (!same(readUnknown(), record.unknown)) fail('UNKNOWN_OPERATION_CHANGED');
  const bytes = await zipBundle(record.bundle, record.manifestSha256);
  if (hash(bytes) !== record.zipSha256 || bytes.length !== record.zipBytes) fail('ARCHIVE_CHANGED');
  return executePinnedMerchantPackageRelease(adapter, { record, bytes, write, inspect, sameBefore, status: disclosureFallbackStatus });
}
export function safeDisclosureFallback(record) {
  return record ? { operationId: record.id, phase: record.phase, sourceVersion: 'buildtest-016', isolatedVersion: 'buildtest-017',
    isolatedOperationId: disclosureFallbackTarget.isolatedOperationId, originalRequestOutcomeKnown: false,
    taskId: record.taskId || null, manifestSha256: record.manifestSha256, factsSha256: disclosureFallbackTarget.factsSha256,
    changedBaseKeys: ['AI_SERVICE_DISCLOSURES_JSON'], releaseType: 'GRAY', retryAllowed: record.phase === 'prepared',
    modifiesTraffic: false, promoted: false, modifiesProduct: false, runtimeVerified: false } : { prepared: false };
}
export async function disclosureFallbackStatus(adapter, record = readState(), inspect = inspectDisclosureFallback) {
  if (!record) return safeDisclosureFallback(record); validateDisclosureFallbackRecord(record);
  let snapshot = await inspect(adapter);
  const matches = state => state.versions.filter(v => v.Remark === record.remark && !record.before.versions.some(old => old.VersionName === v.VersionName));
  const found = matches(snapshot), correlated = record.phase === 'submitted' && snapshot.task?.id === record.taskId && found.length === 1;
  const name = correlated ? found[0].VersionName : null;
  if (name) snapshot = await inspect(adapter, name);
  const info = snapshot.order?.releaseOrderInfo;
  const taskScoped = snapshot.task?.id === record.taskId
    && (snapshot.task.envId === undefined || snapshot.task.envId === disclosure017Target.envId)
    && (snapshot.task.serverName === undefined || snapshot.task.serverName === 'buildtest');
  const candidate = snapshot.candidate;
  const privateIngress = same(domain(snapshot.domain), domain(record.before.domain));
  const candidateVerified = Boolean(name && matches(snapshot).length === 1 && taskScoped && candidate?.VersionName === name
    && candidate.ServerName === 'buildtest' && candidate.Status === 'normal'
    && (candidate.EnvId === undefined || candidate.EnvId === disclosure017Target.envId)
    && same(env(candidate.EnvParams), record.variables) && candidate.Cpu === 0.25 && candidate.Mem === 0.5
    && candidate.MinNum === 0 && candidate.MaxNum === 1 && candidate.ContainerPort === 3000
    && candidate.IsPublic === record.before.isolatedCandidate.IsPublic);
  const historical = fallbackHistoricalReadback(snapshot, record, taskScoped ? name : null);
  return { ...safeDisclosureFallback(record), cloud: { candidateVersion: name, candidateConfigurationVerified: candidateVerified,
    privateIngressVerified: privateIngress, priorVersionConfigurationsUnchanged: historical.configurationsUnchanged,
    expectedHistoricalEviction: historical.expectedHistoricalEviction,
    isolatedVersionHasZeroFlow: snapshot.versions.find(v => v.VersionName === 'buildtest-017')?.FlowRatio === 0,
    desiredBaseVerified: same(base(snapshot.base), base(record.desiredConfig)),
    grayTestReleaseVerified: Boolean(taskScoped && name && info?.serverName === 'buildtest' && positive(info.id) && info.id !== 2856443
      && info.currentVersion?.versionName === 'buildtest-016' && info.releaseVersion?.versionName === name
      && info.releaseStatus === 'test' && info.isReleasing === true) } };
}
export function readDisclosureFallbackState() { return readState(); }
function readState() {
  if (!fs.existsSync(journal)) { if (fs.existsSync(`${journal}.backup`)) fail('PARTIAL_JOURNAL_EXISTS'); return null; }
  const record = JSON.parse(privateRead(journal)), backup = JSON.parse(privateRead(`${journal}.backup`));
  if (backup.phase !== 'prepared' || !same(immutable(record), immutable(backup))) fail('JOURNAL_CHANGED');
  return validateDisclosureFallbackRecord(record);
}
function saveState(record, previous) {
  validateDisclosureFallbackRecord(record);
  if (!previous) { privateCreate(`${journal}.backup`, JSON.stringify(record) + '\n'); privateCreate(journal, JSON.stringify(record) + '\n'); return; }
  if (privateRead(journal) !== JSON.stringify(previous) + '\n' || !same(immutable(record), immutable(previous))) fail('JOURNAL_CHANGED');
  const temp = `${journal}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  privateCreate(temp, JSON.stringify(record) + '\n'); fs.renameSync(temp, journal);
  if (privateRead(journal) !== JSON.stringify(record) + '\n') fail('JOURNAL_SAVE_UNCONFIRMED');
}
async function withLock(operation) {
  const filename = `${journal}.lock`, token = crypto.randomBytes(24).toString('hex'); privateCreate(filename, token);
  try { return await operation(); } finally { if (privateRead(filename) === token) fs.unlinkSync(filename); }
}
export const disclosureFallbackPlan = Object.freeze({ action: 'plan', cloudOperationPerformed: false, privateFilesRead: false,
  sourceVersion: 'buildtest-016', isolatedVersion: 'buildtest-017', requiresCanceledOrder: 2856443, requiresStoppedTask: 2361455,
  requiresDefault016Flow100: true, bundleName: disclosureFallbackTarget.bundleName, manifestSha256: disclosureFallbackTarget.manifestSha256,
  changedBaseKeys: ['AI_SERVICE_DISCLOSURES_JSON'], releaseType: 'GRAY', candidateNameFromReceiptAndReadbackOnly: true,
  cancels: false, retriesUnknownUpdate: false, promotes: false, changesTraffic: false });
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), [action, bundle, manifestSha256] = args;
    if (!args.length || args.length === 1 && action === 'plan') console.log(JSON.stringify(disclosureFallbackPlan));
    else {
      if (!['prepare', 'submit', 'status'].includes(action)
        || (action === 'prepare' ? args.length !== 3 || !path.isAbsolute(bundle) || !sha(manifestSha256) : args.length !== 1)) fail('ARGUMENT_INVALID');
      const run = () => withProductionCloud(adapter => action === 'prepare' ? prepareDisclosureFallback(adapter, { bundle, manifestSha256 })
        : action === 'submit' ? submitDisclosureFallback(adapter) : disclosureFallbackStatus(adapter));
      console.log(JSON.stringify(await (action === 'status' ? run() : withLock(run))));
    }
  } catch (error) {
    const code = /^(DISCLOSURE_FALLBACK|MULTIEFFECT_DEPLOY|DISCLOSURE_017)_[A-Z_]+$/.test(error?.code || '') ? error.code : 'DISCLOSURE_FALLBACK_OPERATION_UNCONFIRMED';
    console.error(JSON.stringify({ code, safeDiagnostic: safeDisclosureCloudError(error) })); process.exitCode = 1;
  }
}
