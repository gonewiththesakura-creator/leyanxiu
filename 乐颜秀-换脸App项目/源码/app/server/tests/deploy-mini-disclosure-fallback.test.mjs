import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { merchantTestProduct } from '../scripts/prepare-mini-production-merchant-test.mjs';
import { normalizedConfig } from '../scripts/deploy-mini-sandbox-cloud.mjs';
import { prepareDisclosure017, disclosure017Target } from '../scripts/update-mini-017-disclosure.mjs';
import { disclosureFallbackTarget as target, prepareDisclosureFallback, submitDisclosureFallback,
  disclosureFallbackStatus, safeDisclosureFallback, validateDisclosureFallbackRecord, fallbackHistoricalReadback } from '../scripts/deploy-mini-disclosure-fallback.mjs';
import { evaluate018Boundary, otherServiceFingerprints } from '../scripts/inspect-mini-018-default-boundary.mjs';
import { bindFallbackProbeRoute, fallbackOperationId, fallbackTaskId, fallbackMerchantRouteFilename,
  prepareFallbackProbeRoute, loadFallbackProbeRoute } from '../scripts/mini-disclosure-fallback-probe-route.mjs';
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(server, name));
const clone = value => structuredClone(value);
const facts = JSON.parse(read('docs/production-config/natural-avatar-merchant-public-facts-2026-10-13.json'));
const vars = { WECHAT_APP_ID: target.appId, XPAY_ENV: '0', XPAY_MODE: 'merchant_test', XPAY_ENABLED: 'true', XPAY_RECONCILE_ENABLED: 'true',
  XPAY_DB_BACKEND: 'mysql', XPAY_PRODUCTS_JSON: JSON.stringify([merchantTestProduct]),
  XPAY_TEST_USER_IDS: 'usr_11111111-1111-1111-1111-111111111111', XPAY_REFUND_OPERATOR_USER_IDS: 'usr_22222222-2222-2222-2222-222222222222',
  XPAY_APP_KEY: 'PRIVATE_SYNTHETIC_KEY', PRIVACY_POLICY_URL: facts.publicDocuments.privacyPolicyUrl,
  USER_AGREEMENT_URL: facts.publicDocuments.userAgreementUrl, THIRD_PARTY_LIST_URL: facts.publicDocuments.thirdPartyListUrl,
  RETENTION_SUPPLIER_POLICY: facts.retentionSupplierPolicy, PIPIA_REFERENCE: facts.pipiaReference,
  AI_SERVICE_DISCLOSURES_JSON: JSON.stringify(facts.aiServiceDisclosures),
  PHOTO_PRODUCTION_CONFIG_SHA256: target.policySha256, PHOTO_PRODUCTION_ACCEPTANCE_SHA256: target.acceptanceSha256,
  PHOTO_PRODUCTION_CONFIG_BASE64: read('docs/production-config/original-effects-merchant-policy-2026-10-15.json').toString('base64'),
  PHOTO_PRODUCTION_ACCEPTANCE_BASE64: read('evidence/mini-photo-original-effects-acceptance-bundle-2026-10-15.json').toString('base64') };
const detail = (name, variables = vars) => ({ VersionName: name, ServerName: 'buildtest', EnvId: target.envId, Status: 'normal',
  EnvParams: JSON.stringify(variables), ContainerPort: 3000, MinNum: 0, MaxNum: 1, Cpu: 0.25, Mem: 0.5,
  ImageUrl: 'PRIVATE_IMAGE', IsPublic: true, RequestId: 'dynamic' });
const route = () => ({ base: normalizedConfig({ openAccessTypes: ['MINIAPP'], publicAccess: false,
  minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5, envParams: JSON.stringify(vars) }),
  domain: { AccessTypes: ['MINIAPP'], RequestId: 'dynamic' }, current: detail('buildtest-016', { old: 'source' }),
  historicalCurrent: detail('buildtest-013', { old: 'historical' }), historicalPrevious: detail('buildtest-014', { old: 'historical' }),
  candidate: detail('buildtest-017'), versions: ['013', '014', '015', '016', '017'].map(n => ({ VersionName: `buildtest-${n}`,
    Status: 'normal', FlowRatio: 0, Remark: `keep-${n}` })),
  task: { id: 2361455, status: 'running', envId: target.envId, serverName: 'buildtest' },
  order: { isExist: true, releaseOrderInfo: { id: 2856443, serverName: 'buildtest', releaseStatus: 'test', isReleasing: true,
    currentVersion: { versionName: 'buildtest-016' }, releaseVersion: { versionName: 'buildtest-017' },
    trafficType: 'URL_PARAMS', trafficTypeValues: [{ key: 'synthetic', value: 'PRIVATE_ROUTE' }] } } });
let unknown, prepared;
const archive = Buffer.alloc(1024, 3), bundle = path.resolve(server, '../output', target.bundleName);
function canceled() {
  const state = route(); state.isolatedCandidate = state.candidate; state.candidate = null;
  state.order.releaseOrderInfo.releaseStatus = 'cancel'; state.order.releaseOrderInfo.isReleasing = false; state.task.status = 'stopped';
  state.order.releaseOrderInfo.trafficType = 'FLOW'; state.order.releaseOrderInfo.trafficTypeValues = [];
  state.versions.find(v => v.VersionName === 'buildtest-016').FlowRatio = 100;
  const details = [state.current, state.historicalCurrent, state.historicalPrevious, state.isolatedCandidate, detail('buildtest-015', { keep: 'unrelated' })];
  state.knownVersions = Object.fromEntries(details.map(v => [v.VersionName, v])); return state;
}
test.before(async () => {
  await prepareDisclosure017({}, { read: () => null, write: r => { unknown = clone(r); }, inspect: async () => route() });
  unknown.id = target.isolatedOperationId; unknown.phase = 'update_requested'; unknown.requestedAt = new Date().toISOString();
  await prepareDisclosureFallback({}, { bundle, manifestSha256: target.manifestSha256, read: () => null,
    readUnknown: () => clone(unknown), write: r => { prepared = clone(r); }, inspect: async () => canceled(), zipBundle: async () => archive });
});
function operation({ failAt, writeFailure, driftAfterConfig } = {}) {
  let record = clone(prepared); const snapshot = canceled(), calls = [];
  const enter = (stage, phase) => { assert.equal(record.phase, phase); calls.push(stage); if (failAt === stage) throw Error('PRIVATE_FAILURE'); };
  const adapter = { CloudAPI: {
    async tcbUpdateServerBaseConfig(args) { enter('configure', 'configure_requested'); snapshot.base = clone(args.conf); driftAfterConfig?.(snapshot); },
    async tcbSubmitServerRelease(args) { enter('release', 'release_requested'); assert.equal(args.deployType, 'package'); assert.equal(args.releaseType, 'GRAY');
      assert.equal(args.versionRemark, record.remark); return { taskId: 999000 }; }
  }, api: { async DescribeCloudBaseBuildService() { enter('authorize', 'upload_authorization_requested');
    return { UploadUrl: 'https://cloudbaserun-code-cos.cloudbase.net/private', PackageName: 'test/package', PackageVersion: 'v1' }; } },
  axios: { async put() { enter('upload', 'upload_requested'); return { status: 200 }; } } };
  const options = { read: () => clone(record), readUnknown: () => clone(unknown), write(next, prior) {
    assert.deepEqual(record, prior); if (writeFailure === next.phase) throw Error('disk'); validateDisclosureFallbackRecord(next); record = clone(next);
  }, inspect: async () => clone(snapshot), zipBundle: async () => archive };
  return { adapter, options, snapshot, calls, record: () => clone(record), run: () => submitDisclosureFallback(adapter, options) };
}
test('prepare preserves unknown journal, pins identical package, changes only one base field and records every old version', () => {
  assert.equal(unknown.phase, 'update_requested'); assert.equal(prepared.unknown.phase, 'update_requested');
  assert.equal(prepared.manifestSha256, target.manifestSha256);
  assert.deepEqual(Object.keys(vars).filter(k => vars[k] !== prepared.variables[k]), ['AI_SERVICE_DISCLOSURES_JSON']);
  assert.deepEqual(Object.keys(prepared.before.knownVersions).sort(), prepared.before.versions.map(v => v.VersionName).sort());
  assert.doesNotMatch(JSON.stringify(safeDisclosureFallback(prepared)), /PRIVATE_|BASE64|EnvParams|usr_/);
});
test('absent, undefined and empty legacy logType stay exact through persisted JSON', async () => {
  for (const logType of [undefined, '']) {
    const state = canceled(), prior = clone(unknown); state.base.logType = logType; prior.before.base.logType = logType;
    let record; await prepareDisclosureFallback({}, { bundle, manifestSha256: target.manifestSha256, read: () => null,
      readUnknown: () => prior, write: r => { record = JSON.parse(JSON.stringify(r)); }, inspect: async () => state, zipBundle: async () => archive });
    assert.equal(record.desiredConfig.logType, logType); validateDisclosureFallbackRecord(record);
  }
});
test('pending, wrong order/task, default routing, version scope and isolated drift reject before preparing', async () => {
  for (const change of [s => { s.order.releaseOrderInfo.releaseStatus = 'test'; }, s => { s.order.releaseOrderInfo.isReleasing = true; },
    s => { s.order.releaseOrderInfo.id++; }, s => { s.task.id++; }, s => { s.task.status = 'running'; },
    s => { s.order.releaseOrderInfo.trafficType = 'URL_PARAMS'; }, s => { s.order.releaseOrderInfo.trafficTypeValues = [{ key: 'k', value: 'v' }]; },
    s => { s.versions.find(v => v.VersionName === 'buildtest-016').FlowRatio = 0; },
    s => { s.versions.find(v => v.VersionName === 'buildtest-017').FlowRatio = 1; }, s => { s.base.maxNum = 2; },
    s => { s.current.ImageUrl = 'other'; }, s => { s.isolatedCandidate.ImageUrl = 'other'; },
    s => { delete s.knownVersions['buildtest-015']; }, s => { s.domain.AccessTypes.push('PUBLIC'); }]) {
    const state = canceled(); change(state); let writes = 0;
    await assert.rejects(prepareDisclosureFallback({}, { bundle, manifestSha256: target.manifestSha256, read: () => null,
      readUnknown: () => clone(unknown), write: () => { writes++; }, inspect: async () => state, zipBundle: async () => archive })); assert.equal(writes, 0);
  }
});
test('only the exact known late 017 facts update may be isolated before prepare; never replayed or used as the source', async () => {
  const state = canceled(); state.isolatedCandidate.EnvParams = JSON.stringify(unknown.variables);
  let record; await prepareDisclosureFallback({}, { bundle, manifestSha256: target.manifestSha256, read: () => null, readUnknown: () => clone(unknown),
    write: r => { record = r; }, inspect: async () => state, zipBundle: async () => archive });
  assert.deepEqual(record.variables, unknown.variables); assert.equal(record.target.currentVersion, 'buildtest-016');
  state.isolatedCandidate.EnvParams = JSON.stringify({ ...unknown.variables, XPAY_ENV: '1' });
  await assert.rejects(prepareDisclosureFallback({}, { bundle, manifestSha256: target.manifestSha256, read: () => null, readUnknown: () => clone(unknown),
    write: () => assert.fail(), inspect: async () => state, zipBundle: async () => archive }), /ISOLATED_VERSION_CHANGED/);
});
test('shared engine journals four known side effects once; new operation has no modify/cancel/promote/route call', async () => {
  const op = operation(); await op.run(); assert.deepEqual(op.calls, ['configure', 'authorize', 'upload', 'release']);
  assert.equal(op.record().phase, 'submitted'); assert.equal(op.record().unknown.phase, 'update_requested');
  await assert.rejects(op.run(), /NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(op.calls.length, 4);
});
test('unknown results at every external stage are never retried', async () => {
  for (const [failAt, phase] of Object.entries({ configure: 'configure_requested', authorize: 'upload_authorization_requested', upload: 'upload_requested', release: 'release_requested' })) {
    const op = operation({ failAt }); await assert.rejects(op.run()); assert.equal(op.record().phase, phase);
    const count = op.calls.length; await assert.rejects(op.run()); assert.equal(op.calls.length, count);
  }
});
test('durable intent failures stop their action; postconfiguration and unrelated historical-version drift stop submission', async () => {
  const op = operation({ writeFailure: 'configure_requested' }); await assert.rejects(op.run()); assert.deepEqual(op.calls, []);
  for (const change of [s => { s.knownVersions['buildtest-015'].ImageUrl = 'changed'; },
    s => { s.order.releaseOrderInfo.trafficTypeValues.push({ key: 'k', value: 'changed' }); },
    s => { s.base.envParams = JSON.stringify({ ...prepared.variables, XPAY_PRODUCTS_JSON: '[]' }); }]) {
    const next = operation({ driftAfterConfig: change }); await assert.rejects(next.run()); assert.deepEqual(next.calls, ['configure']);
  }
  const changedUnknown = operation(); changedUnknown.options.readUnknown = () => ({ ...unknown, phase: 'submitted' });
  await assert.rejects(changedUnknown.run(), /UNKNOWN_OPERATION_CHANGED/); assert.deepEqual(changedUnknown.calls, []);
});
test('readback binds actual new candidate via task/unique remark, preserves source and isolates 017', async () => {
  const op = operation(); await op.run(); const record = op.record(), state = clone(op.snapshot), name = 'buildtest-043';
  state.task = { ...state.task, id: record.taskId, status: 'running' };
  state.versions.forEach(v => { v.FlowRatio = 0; }); state.versions.push({ VersionName: name, Status: 'normal', FlowRatio: 0, Remark: record.remark });
  state.knownVersions[name] = detail(name, record.variables); state.candidate = state.knownVersions[name];
  state.order.releaseOrderInfo = { id: 3000000, serverName: 'buildtest', releaseStatus: 'test', isReleasing: true,
    currentVersion: { versionName: 'buildtest-016' }, releaseVersion: { versionName: name } };
  const inspect = async () => clone(state), report = await disclosureFallbackStatus({}, record, inspect);
  assert.equal(report.cloud.candidateVersion, name); assert.equal(report.cloud.candidateConfigurationVerified, true);
  assert.equal(report.cloud.priorVersionConfigurationsUnchanged, true); assert.equal(report.cloud.isolatedVersionHasZeroFlow, true);
  assert.equal(report.cloud.grayTestReleaseVerified, true); assert.equal(report.originalRequestOutcomeKnown, false);
  state.knownVersions['buildtest-015'].ImageUrl = 'changed';
  assert.equal((await disclosureFallbackStatus({}, record, inspect)).cloud.priorVersionConfigurationsUnchanged, false);
  state.task.id++; assert.equal((await disclosureFallbackStatus({}, record, inspect)).cloud.candidateVersion, null);
});
test('plan and import are inert without accessing private journals', () => {
  const output = execFileSync(process.execPath, [path.join(server, 'scripts/deploy-mini-disclosure-fallback.mjs'), 'plan'], { encoding: 'utf8', windowsHide: true });
  const plan = JSON.parse(output); assert.equal(plan.privateFilesRead, false); assert.equal(plan.cloudOperationPerformed, false);
  assert.equal(plan.retriesUnknownUpdate, false); assert.equal(plan.cancels, false);
});
const otherInventories = () => ['leyanxiu-stage', 'leyanxiu-api'].map(serverName => ({ serverName,
  base: { envParams: JSON.stringify({ key: 'PRIVATE_SYNTHETIC_KEY' }), maxNum: 1 }, domain: { AccessTypes: ['MINIAPP'], RequestId: 'volatile' },
  task: { id: 17, status: 'finished' }, versions: [{ VersionName: `${serverName}-001`, Status: 'normal', FlowRatio: 100 }],
  active: [{ versionName: `${serverName}-001`, envParams: JSON.stringify({ key: 'PRIVATE_SYNTHETIC_KEY' }), updatedTime: 'volatile' }] }));
test('018 boundary distinguishes reviewed test routing from completed promotion and never certifies callback delivery', async () => {
  const op = operation(); await op.run(); const record = op.record(), state = clone(op.snapshot), name = 'buildtest-018';
  record.id = '22e44a104421bb656feef8e1'; record.remark = `mini-disclosure fallback ${record.id}`; record.taskId = 2363777;
  state.task = { ...state.task, id: record.taskId, status: 'running' }; state.versions.forEach(v => { v.FlowRatio = 0; });
  state.versions.push({ VersionName: name, Status: 'normal', FlowRatio: 0, Remark: record.remark });
  state.candidate = detail(name, record.variables); state.knownVersions[name] = state.candidate;
  state.order.releaseOrderInfo = { id: 3000000, serverName: 'buildtest', releaseStatus: 'test', isReleasing: true,
    currentVersion: { versionName: 'buildtest-016' }, releaseVersion: { versionName: name },
    trafficType: 'URL_PARAMS', trafficTypeValues: [{ key: 'synthetic', value: record.id }] };
  let report = await evaluate018Boundary(record, state, otherInventories());
  assert.equal(report.controlPlane.beforePromotionVerified, true); assert.equal(report.controlPlane.afterPromotionVerified, false);
  assert.equal(report.merchant.allVariablesExact, true); assert.equal(report.callback.officialDeliveryTo018Verified, false);
  state.order.releaseOrderInfo.releaseStatus = 'success'; state.order.releaseOrderInfo.isReleasing = false;
  state.order.releaseOrderInfo.trafficType = 'FLOW'; state.order.releaseOrderInfo.trafficTypeValues = [];
  state.task.status = 'finished'; state.versions.find(v => v.VersionName === name).FlowRatio = 100;
  report = await evaluate018Boundary(record, state, otherInventories());
  assert.equal(report.controlPlane.afterPromotionVerified, true); assert.equal(report.controlPlane.beforePromotionVerified, false);
  assert.equal(report.controlPlane.rollback016Available, true); assert.equal(report.callback.defaultServiceRoutesTo018, true);
  assert.equal(report.callback.currentMessageBindingVerified, false); assert.equal(report.callback.officialDeliveryTo018Verified, false);
  for (const change of [s => { s.versions.find(v => v.VersionName === 'buildtest-017').FlowRatio = 1; },
    s => { s.candidate.EnvParams = JSON.stringify({ ...record.variables, XPAY_TEST_USER_IDS: '*' }); },
    s => { s.order.releaseOrderInfo.currentVersion.versionName = 'buildtest-017'; }, s => { s.task.status = 'running'; },
    s => { s.domain.AccessTypes = ['PUBLIC']; }, s => { s.order.releaseOrderInfo.trafficTypeValues = [{ key: 'k', value: 'v' }]; }]) {
    const drift = clone(state); change(drift);
    assert.equal((await evaluate018Boundary(record, drift, otherInventories())).controlPlane.afterPromotionVerified, false);
  }
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE_|BASE64|EnvParams|usr_/);
});
test('other-service fingerprints ignore timestamp/request metadata but detect configuration, flow and deployment changes without disclosing values', () => {
  const inventory = otherInventories(), before = otherServiceFingerprints(inventory);
  inventory[0].domain.RequestId = 'next'; inventory[0].active[0].updatedTime = 'next';
  assert.deepEqual(otherServiceFingerprints(inventory), before);
  for (const change of [s => { s.base.maxNum = 2; }, s => { s.base.envParams = '{"key":"OTHER_PRIVATE"}'; },
    s => { s.versions[0].FlowRatio = 0; }, s => { s.task.id++; }]) {
    const next = clone(inventory); change(next[0]); assert.notDeepEqual(otherServiceFingerprints(next), before);
  }
  assert.doesNotMatch(JSON.stringify(before), /PRIVATE_|envParams|key/);
});
test('018 inspection plan imports without private reads or cloud calls', () => {
  const output = execFileSync(process.execPath, [path.join(server, 'scripts/inspect-mini-018-default-boundary.mjs'), 'plan'], { encoding: 'utf8', windowsHide: true });
  const plan = JSON.parse(output); assert.equal(plan.cloudOperationPerformed, false); assert.deepEqual(plan.mutationMethods, []);
});
test('readback permits exactly the oldest inactive version retention eviction, never rollback, isolated or arbitrary deletion', () => {
  const record = clone(prepared), state = canceled();
  record.id = '22e44a104421bb656feef8e1'; record.taskId = 2363777;
  record.before.versions = Array.from({ length: 10 }, (_, index) => ({ VersionName: `buildtest-${String(index + 8).padStart(3, '0')}`,
    Status: 'normal', FlowRatio: index === 8 ? 100 : 0, Remark: `keep-${index}` }));
  record.before.knownVersions = Object.fromEntries(record.before.versions.map(v => [v.VersionName, detail(v.VersionName)]));
  state.versions = [...record.before.versions.slice(1), { VersionName: 'buildtest-018', Status: 'normal', FlowRatio: 0 }];
  state.knownVersions = Object.fromEntries(state.versions.map(v => [v.VersionName, detail(v.VersionName)]));
  state.versionsComplete = true; state.versionTotalCount = 10;
  assert.deepEqual(fallbackHistoricalReadback(state, record, 'buildtest-018'), { configurationsUnchanged: true, expectedHistoricalEviction: 'buildtest-008' });
  for (const change of [s => { s.versionsComplete = false; }, s => { s.versionTotalCount = 11; },
    s => { s.versions[0].VersionName = 'buildtest-008'; }, s => { s.versions[7].VersionName = 'buildtest-008'; },
    s => { s.knownVersions['buildtest-016'].ImageUrl = 'changed'; }, s => { s.knownVersions['buildtest-017'].EnvParams = '{}'; }]) {
    const drift = clone(state); change(drift); assert.equal(fallbackHistoricalReadback(drift, record, 'buildtest-018').configurationsUnchanged, false);
  }
  assert.equal(fallbackHistoricalReadback(state, record, null).configurationsUnchanged, false);
  assert.equal(fallbackHistoricalReadback(state, { ...record, taskId: 2363778 }, 'buildtest-018').configurationsUnchanged, false);
  record.before.versions[0].FlowRatio = 1; assert.equal(fallbackHistoricalReadback(state, record, 'buildtest-018').configurationsUnchanged, false);
});

function readonlyReceipt() {
  const backup = clone(prepared); backup.id = fallbackOperationId; backup.remark = `mini-disclosure fallback ${backup.id}`;
  const record = { ...clone(backup), phase: 'submitted', packageName: 'test/package', packageVersion: 'v1',
    releaseRequestedAt: new Date().toISOString(), taskId: fallbackTaskId };
  const snapshot = clone(backup.before), name = 'buildtest-018';
  snapshot.base = clone(record.desiredConfig);
  snapshot.task = { id: fallbackTaskId, status: 'running', envId: target.envId, serverName: 'buildtest' };
  snapshot.versions.push({ VersionName: name, Status: 'normal', FlowRatio: 0, Remark: record.remark });
  snapshot.knownVersions[name] = detail(name, record.variables); snapshot.candidate = snapshot.knownVersions[name];
  snapshot.order.releaseOrderInfo = { id: 3000001, serverName: 'buildtest', releaseStatus: 'test', isReleasing: true,
    currentVersion: { versionName: 'buildtest-016' }, releaseVersion: { versionName: name }, trafficType: 'URL_PARAMS',
    trafficTypeValues: [{ key: 'lyx_gray_probe', value: record.id }] };
  return { record, backup, snapshot };
}
test('readonly fallback route binds new journal, prepared backup, task, unique candidate receipt and URL only', async () => {
  const { record, backup, snapshot } = readonlyReceipt();
  const route = await bindFallbackProbeRoute(record, backup, snapshot);
  assert.equal(route.taskId, fallbackTaskId); assert.equal(route.candidateVersion, 'buildtest-018');
  assert.equal(route.releaseOrderId, 3000001); assert.equal(route.route.gray.value, record.id);
  assert.equal(route.route.target.serviceName, 'buildtest');
  for (const key of ['recordSha256', 'backupSha256', 'snapshotSha256', 'factsSha256']) assert.match(route[key], /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(route), /PRIVATE_|EnvParams|BASE64|usr_/);
});
test('readonly fallback route rejects journal, backup, task, candidate, ingress, facts or URL drift before runtime', async () => {
  const changes = [
    x => { x.record.phase = 'release_requested'; },
    x => { x.record.taskId++; },
    x => { x.backup.createdAt = new Date(0).toISOString(); },
    x => { x.snapshot.task.id++; },
    x => { x.snapshot.order.releaseOrderInfo.id = 2856443; },
    x => { x.snapshot.order.releaseOrderInfo.releaseVersion.versionName = 'buildtest-017'; },
    x => { x.snapshot.order.releaseOrderInfo.trafficType = 'FLOW'; },
    x => { x.snapshot.order.releaseOrderInfo.trafficTypeValues.push({ key: 'other', value: x.record.id }); },
    x => { x.snapshot.order.releaseOrderInfo.trafficTypeValues[0].value = 'previous_route_123456'; },
    x => { x.snapshot.order.releaseOrderInfo.trafficTypeValues[0].unexpected = true; },
    x => { x.snapshot.order.releaseOrderInfo.releaseVersion.urlParam = { key: 'lyx_gray_probe', value: 'other' }; },
    x => { x.snapshot.versions.push({ VersionName: 'buildtest-099', Remark: x.record.remark, FlowRatio: 0 }); },
    x => { x.snapshot.domain.AccessTypes.push('PUBLIC'); },
    x => { x.snapshot.candidate.EnvParams = JSON.stringify({ ...x.record.variables, XPAY_ENV: '1' }); },
    x => { x.snapshot.knownVersions['buildtest-015'].ImageUrl = 'changed'; },
    x => { x.snapshot.base.maxNum = 2; },
  ];
  for (const change of changes) {
    const x = readonlyReceipt(); change(x); await assert.rejects(bindFallbackProbeRoute(x.record, x.backup, x.snapshot));
  }
});
test('local preparation and reload bind both journal hashes and receipt; tampered evidence and nonallowlisted identity stop', async () => {
  const x = readonlyReceipt(), user = 'usr_11111111-1111-1111-1111-111111111111';
  // Build the same-account fixture through the real validators, never real private files.
  const seed = route(), sameAccountVars = { ...vars, XPAY_REFUND_OPERATOR_USER_IDS: user };
  seed.base.envParams = JSON.stringify(sameAccountVars); seed.candidate.EnvParams = JSON.stringify(sameAccountVars);
  let prior;
  await prepareDisclosure017({}, { read: () => null, write: r => { prior = clone(r); }, inspect: async () => seed });
  prior.id = target.isolatedOperationId; prior.phase = 'update_requested'; prior.requestedAt = new Date().toISOString();
  const state = canceled(); state.base.envParams = seed.base.envParams; state.isolatedCandidate.EnvParams = seed.candidate.EnvParams;
  let backup;
  await prepareDisclosureFallback({}, { bundle, manifestSha256: target.manifestSha256, read: () => null,
    readUnknown: () => prior, write: r => { backup = clone(r); }, inspect: async () => state, zipBundle: async () => archive });
  backup.id = fallbackOperationId; backup.remark = `mini-disclosure fallback ${backup.id}`;
  x.backup = backup; x.record = { ...clone(backup), phase: 'submitted', packageName: 'test/package', packageVersion: 'v1',
    releaseRequestedAt: new Date().toISOString(), taskId: fallbackTaskId };
  x.snapshot = clone(backup.before); x.snapshot.base = clone(x.record.desiredConfig);
  x.snapshot.task = { id: fallbackTaskId, status: 'running' };
  x.snapshot.candidate = detail('buildtest-018', x.record.variables);
  x.snapshot.knownVersions['buildtest-018'] = x.snapshot.candidate;
  x.snapshot.versions.push({ VersionName: 'buildtest-018', Status: 'normal', FlowRatio: 0, Remark: backup.remark });
  x.snapshot.order.releaseOrderInfo = { id: 3000001, serverName: 'buildtest', releaseStatus: 'test', isReleasing: true,
    currentVersion: { versionName: 'buildtest-016' }, releaseVersion: { versionName: 'buildtest-018' }, trafficType: 'URL_PARAMS',
    trafficTypeValues: [{ key: 'lyx_gray_probe', value: backup.id }] };
  const routeFile = path.join(server, fallbackMerchantRouteFilename), snapshotFile = path.join(server, '.env.synthetic-fallback-snapshot.json');
  const files = new Map([[path.join(server, '.env.mini-disclosure-fallback.json'), JSON.stringify(x.record)],
    [path.join(server, '.env.mini-disclosure-fallback.json.backup'), JSON.stringify(x.backup)], [snapshotFile, JSON.stringify(x.snapshot)]]);
  const read = filename => { assert.ok(files.has(filename)); return files.get(filename); };
  let writes = 0;
  const preparedResult = await prepareFallbackProbeRoute({ snapshotFile, routeFile }, { read, create(filename, content) {
    assert.ok(!files.has(filename)); files.set(filename, content); writes++;
  } });
  assert.equal(preparedResult.prepared, true); assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(preparedResult), /PRIVATE_|EnvParams|BASE64|usr_|lyx_gray_probe/);
  const loaded = await loadFallbackProbeRoute(routeFile, user, { read });
  assert.equal(loaded.binding.taskId, fallbackTaskId); assert.equal(loaded.expectedPublicFacts.aiServices[0].purpose.includes('现代漫画像'), true);
  await assert.rejects(loadFallbackProbeRoute(routeFile, 'usr_99999999-9999-9999-9999-999999999999', { read }));
  const value = JSON.parse(files.get(routeFile)); value.recordSha256 = '0'.repeat(64); files.set(routeFile, JSON.stringify(value));
  await assert.rejects(loadFallbackProbeRoute(routeFile, user, { read }));
});
test('probe route consumes the common readback rule for actual latest-ten 008–017 to 009–018 retention', async () => {
  const x = readonlyReceipt(), names = Array.from({ length: 10 }, (_, i) => `buildtest-${String(i + 8).padStart(3, '0')}`);
  for (const record of [x.backup, x.record]) {
    record.before.versions = names.map(VersionName => ({ VersionName, Status: 'normal',
      FlowRatio: VersionName === 'buildtest-016' ? 100 : 0, Remark: `keep-${VersionName}` }));
    record.unknown.before.versions = record.before.versions.map(v => ({ ...v, FlowRatio: 0 }));
    for (const name of names) record.before.knownVersions[name] ||= detail(name, { keep: 'unrelated' });
  }
  x.snapshot.versions = [...x.record.before.versions.filter(v => v.VersionName !== 'buildtest-008').map(v => ({ ...v, FlowRatio: 0 })),
    { VersionName: 'buildtest-018', Status: 'normal', FlowRatio: 0, Remark: x.record.remark }];
  x.snapshot.knownVersions = clone(x.record.before.knownVersions); delete x.snapshot.knownVersions['buildtest-008'];
  x.snapshot.knownVersions['buildtest-018'] = x.snapshot.candidate;
  x.snapshot.versionsComplete = true; x.snapshot.versionTotalCount = 10;
  validateDisclosureFallbackRecord(x.record); validateDisclosureFallbackRecord(x.backup);
  const bound = await bindFallbackProbeRoute(x.record, x.backup, x.snapshot);
  assert.equal(bound.expectedHistoricalEviction, 'buildtest-008');
  assert.equal(bound.candidateVersion, 'buildtest-018');
  for (const change of [s => { s.versionsComplete = false; }, s => { s.versionTotalCount = 11; },
    s => { delete s.knownVersions['buildtest-009']; }, s => { s.knownVersions['buildtest-016'].ImageUrl = 'changed'; },
    s => { s.knownVersions['buildtest-017'].EnvParams = '{}'; }, s => { s.versions[0].VersionName = 'buildtest-008'; }]) {
    const snapshot = clone(x.snapshot); change(snapshot);
    await assert.rejects(bindFallbackProbeRoute(x.record, x.backup, snapshot));
  }
});
