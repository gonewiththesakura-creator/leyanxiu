import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { normalizedConfig } from '../scripts/deploy-mini-sandbox-cloud.mjs';
import { buildPhotoProduction } from '../scripts/build-mini-photo-production.mjs';
import { multiEffectMerchantTarget as target, multiEffectMerchantDeployPlan, prepareMultiEffectMerchantRelease,
  submitMultiEffectMerchantRelease, validateMultiEffectPredecessor, validateMultiEffectMerchantRecord,
  safeMultiEffectMerchantState, multiEffectMerchantReleaseStatus, inspectMultiEffectMerchantRelease,
  archiveMultiEffectMerchantBundle } from '../scripts/deploy-mini-multieffect-merchant-test.mjs';

const clone = value => structuredClone(value), hash = value => createHash('sha256').update(value).digest('hex');
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFileSync(path.join(server, name));
const canary = 'SYNTHETIC_PRIVATE_SECRET_MUST_NOT_PRINT';
const oldPolicy = read('docs/production-config/natural-avatar-merchant-policy-2026-10-13.json');
const oldAcceptance = read('evidence/mini-photo-natural-avatar-v2-runtime-2026-10-13.json');
const variables = {
  NODE_ENV: 'production', RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', DEPLOY_ENV: 'production',
  WECHAT_APP_ID: target.appId, XPAY_ENV: '0', XPAY_MODE: 'merchant_test', XPAY_ENABLED: 'true', XPAY_DB_BACKEND: 'mysql',
  XPAY_RECONCILE_ENABLED: 'true', XPAY_SESSION_ENCRYPTION_KEY: '1'.repeat(64), XPAY_APP_KEY: canary,
  XPAY_TEST_USER_IDS: 'usr_11111111-1111-1111-1111-111111111111', XPAY_REFUND_OPERATOR_USER_IDS: 'usr_22222222-2222-2222-2222-222222222222',
  PHOTO_PRODUCTION_CONFIG_BASE64: oldPolicy.toString('base64'), PHOTO_PRODUCTION_CONFIG_SHA256: hash(oldPolicy),
  PHOTO_PRODUCTION_ACCEPTANCE_BASE64: oldAcceptance.toString('base64'), PHOTO_PRODUCTION_ACCEPTANCE_SHA256: hash(oldAcceptance),
  XPAY_PURPOSE_RULES_JSON: JSON.stringify({ 'photo-effect:natural-avatar': { kind: 'photo', reviewed: true }, 'other:keep': { kind: 'video' } }),
  XPAY_PRODUCTS_JSON: '[{"id":"synthetic-preserve"}]', XPAY_MYSQL_PASSWORD: canary,
};
const detail = (name, vars = variables) => ({ VersionName: name, ServerName: target.serverName, EnvId: target.envId,
  Status: 'normal', EnvParams: JSON.stringify(vars), ContainerPort: 3000, MinNum: 0, MaxNum: 1, Cpu: 0.25, Mem: 0.5,
  IsPublic: true, ImageUrl: `private.invalid/${name}`, RequestId: 'dynamic', VersionIP: 'dynamic' });
function predecessor() {
  return { base: normalizedConfig({ envParams: JSON.stringify(variables), openAccessTypes: ['MINIAPP'], publicAccess: false,
    minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5, port: 0, internalDomain: 'private.invalid' }),
  domain: { AccessTypes: ['MINIAPP'], RequestId: 'dynamic' }, task: { id: target.completedTaskId, status: 'finished', envId: target.envId, serverName: target.serverName },
  order: { isExist: true, releaseOrderInfo: { id: target.completedReleaseOrderId, serverName: 'buildtest', currentVersion: { versionName: 'buildtest-013' },
    releaseVersion: { versionName: 'buildtest-016' }, releaseStatus: 'success', isReleasing: false } },
  versions: ['013', '014', '015', '016'].map(n => ({ VersionName: `buildtest-${n}`, Status: 'normal', FlowRatio: n === '016' ? 100 : 0, Remark: `historical-${n}` })),
  current: detail('buildtest-016'), historicalCurrent: detail('buildtest-013', { historical: 'closed' }),
  historicalPrevious: detail('buildtest-014', { historical: 'closed' }), candidate: null };
}
const bundle = path.resolve(server, '..', 'output', target.bundleName), manifestSha256 = target.manifestSha256, archive = Buffer.alloc(1024, 9);
let baseline;
test.before(async () => {
  await prepareMultiEffectMerchantRelease({}, { bundle, manifestSha256, read: () => null, write: value => { baseline = clone(value); },
    inspect: async () => predecessor(), zipBundle: async () => archive });
});
function operation({ failAt, writeFailure, afterConfigure, afterUpload, corrupt, uploadUrl } = {}) {
  let record = clone(baseline), snapshot = predecessor(); corrupt?.(record);
  const calls = [], checkpoint = (name, phase) => { assert.equal(record.phase, phase); calls.push(name); if (name === failAt) throw Error(canary); };
  const adapter = { CloudAPI: {
    async tcbUpdateServerBaseConfig(args) { checkpoint('configure', 'configure_requested');
      assert.deepEqual(args, { envId: target.envId, serverName: target.serverName, wxAppId: target.appId, conf: record.desiredConfig });
      snapshot.base = clone(args.conf); afterConfigure?.(snapshot); },
    async tcbSubmitServerRelease(args) { checkpoint('release', 'release_requested');
      assert.equal(args.releaseType, 'GRAY'); assert.equal(args.versionRemark, record.remark);
      assert.equal(args.envId, target.envId); assert.equal(args.serverName, target.serverName); assert.equal(args.wxAppId, target.appId);
      assert.equal(Object.keys(args).some(key => /flow|conf|envParams|promot/i.test(key)), false);
      return { taskId: target.completedTaskId + 100 }; },
  }, api: { async DescribeCloudBaseBuildService(args) { checkpoint('authorize', 'upload_authorization_requested');
    assert.deepEqual(args, { EnvId: target.envId, ServiceName: target.serverName });
    return { UploadUrl: uploadUrl || 'https://test.cos.ap-shanghai.myqcloud.com/path', PackageName: 'package.zip', PackageVersion: 'version' }; } },
  axios: { async put(_url, bytes, options) { checkpoint('upload', 'upload_requested'); assert.deepEqual(bytes, archive);
    assert.equal(options.maxRedirects, 0); afterUpload?.(snapshot); return { status: 200 }; } } };
  const options = { read: () => clone(record), inspect: async () => clone(snapshot), zipBundle: async () => archive,
    write(next, prior) { assert.deepEqual(prior, record); if (next.phase === writeFailure) throw Error(canary); record = clone(next); } };
  return { adapter, options, calls, snapshot, record: () => clone(record), run: () => submitMultiEffectMerchantRelease(adapter, options) };
}

test('prepare binds actual reviewed evidence, explicit package and live completed 016 without changing merchant scope', () => {
  assert.equal(baseline.phase, 'prepared'); assert.equal(baseline.before.current.VersionName, 'buildtest-016');
  assert.equal(baseline.manifestSha256, manifestSha256); assert.equal(baseline.zipSha256, hash(archive));
  const allowed = ['PHOTO_PRODUCTION_CONFIG_BASE64', 'PHOTO_PRODUCTION_CONFIG_SHA256', 'PHOTO_PRODUCTION_ACCEPTANCE_BASE64', 'PHOTO_PRODUCTION_ACCEPTANCE_SHA256', 'XPAY_PURPOSE_RULES_JSON'];
  assert.deepEqual(Object.keys(baseline.variables).sort(), Object.keys(variables).sort());
  for (const key of Object.keys(variables)) if (!allowed.includes(key)) assert.equal(baseline.variables[key], variables[key], key);
  assert.deepEqual(Object.keys(JSON.parse(baseline.variables.XPAY_PURPOSE_RULES_JSON)), ['other:keep', 'photo-effect:natural-avatar', 'photo-effect:modern-comic', 'photo-effect:gentle-watercolor']);
  assert.deepEqual(normalizedConfig({ ...baseline.before.base, envParams: JSON.stringify(baseline.variables) }), baseline.desiredConfig);
  assert.doesNotMatch(JSON.stringify(safeMultiEffectMerchantState(baseline)), /SYNTHETIC_PRIVATE|private\.invalid|usr_|BASE64/);
});
test('pending, wrong completed order/task, changed base env, nondefault 016 and any public/capacity change close prepare', async () => {
  const mutations = [s => { s.order.releaseOrderInfo.releaseStatus = 'test'; }, s => { s.order.releaseOrderInfo.isReleasing = true; },
    s => { s.order.releaseOrderInfo.currentVersion.versionName = 'buildtest-015'; }, s => { s.order.releaseOrderInfo.releaseVersion.versionName = 'buildtest-015'; },
    s => { s.task.status = 'running'; }, s => { s.task.id++; }, s => { s.task.envId = 'other'; },
    s => { s.base.envParams = '{}'; }, s => { s.current.Status = 'building'; }, s => { s.current.VersionName = 'buildtest-015'; },
    s => { s.versions[3].FlowRatio = 0; }, s => { s.versions[0].FlowRatio = 1; }, s => { s.versions.push(clone(s.versions[0])); },
    s => { s.versions[0].Status = 'building'; }, s => { s.base.maxNum = 2; }, s => { s.base.publicAccess = true; },
    s => { s.domain.AccessTypes = ['PUBLIC']; }, s => { s.current.MaxNum = 2; }];
  for (const mutate of mutations) {
    const snapshot = predecessor(); mutate(snapshot); let writes = 0;
    await assert.rejects(prepareMultiEffectMerchantRelease({}, { bundle, manifestSha256, read: () => null, write: () => { writes++; },
      inspect: async () => snapshot, zipBundle: async () => archive })); assert.equal(writes, 0);
  }
  await assert.rejects(prepareMultiEffectMerchantRelease({}, { read: () => clone(baseline) }), /JOURNAL_EXISTS/);
});
test('submit journals each side effect, has only four supported calls, then performs read-only readback', async () => {
  const op = operation(); let inspections = 0; op.options.inspect = async () => { inspections++; return clone(op.snapshot); };
  const result = await op.run(); assert.deepEqual(op.calls, ['configure', 'authorize', 'upload', 'release']);
  assert.equal(inspections, 4); assert.equal(op.record().phase, 'submitted'); assert.equal(result.retryAllowed, false);
  assert.equal(result.cloud.currentTaskMatches, false); assert.equal(result.cloud.candidateConfigurationVerified, false);
  await assert.rejects(op.run(), /NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(op.calls.length, 4);
});
test('unknown outcomes at every remote stage remain nonretryable and secrets never become output', async () => {
  const phases = { configure: 'configure_requested', authorize: 'upload_authorization_requested', upload: 'upload_requested', release: 'release_requested' };
  for (const [failAt, phase] of Object.entries(phases)) {
    const op = operation({ failAt }); await assert.rejects(op.run()); assert.equal(op.record().phase, phase);
    const count = op.calls.length; await assert.rejects(op.run(), /NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(op.calls.length, count);
    assert.doesNotMatch(JSON.stringify(safeMultiEffectMerchantState(op.record())), /SYNTHETIC_PRIVATE|private\.invalid|usr_/);
  }
});
test('journal persistence failure precedes its side effect, and acknowledged side effects cannot be replayed', async () => {
  for (const [writeFailure, calls, phase] of [
    ['configure_requested', [], 'prepared'], ['configured', ['configure'], 'configure_requested'],
    ['upload_authorization_requested', ['configure'], 'configured'], ['upload_requested', ['configure', 'authorize'], 'upload_ready'],
    ['release_requested', ['configure', 'authorize', 'upload'], 'uploaded'], ['submitted', ['configure', 'authorize', 'upload', 'release'], 'release_requested']]) {
    const op = operation({ writeFailure }); await assert.rejects(op.run()); assert.deepEqual(op.calls, calls); assert.equal(op.record().phase, phase);
  }
});
test('live drift and archive drift reject before first write, postconfiguration drift stops release', async () => {
  for (const mutate of [s => { s.order.releaseOrderInfo.id++; }, s => { s.versions[0].Remark = 'changed'; },
    s => { s.base.internalDomain = 'other'; }, s => { s.current.ImageUrl = 'different'; }, s => { s.domain.Extra = 'new'; }]) {
    const op = operation(); mutate(op.snapshot); await assert.rejects(op.run()); assert.deepEqual(op.calls, []);
  }
  const archiveDrift = operation(); archiveDrift.options.zipBundle = async () => Buffer.alloc(1024, 8);
  await assert.rejects(archiveDrift.run(), /ARCHIVE_CHANGED/); assert.deepEqual(archiveDrift.calls, []);
  const afterConfigure = operation({ afterConfigure: s => { s.base.maxNum = 2; } }); await assert.rejects(afterConfigure.run()); assert.deepEqual(afterConfigure.calls, ['configure']);
  const afterUpload = operation({ afterUpload: s => { s.task.status = 'running'; } }); await assert.rejects(afterUpload.run()); assert.deepEqual(afterUpload.calls, ['configure', 'authorize', 'upload']);
  const requestIdOnly = operation({ afterConfigure: s => { s.domain.RequestId = 'new'; s.current.RequestId = 'new'; } }); await requestIdOnly.run();
});
test('record config tampering and untrusted upload destinations fail closed', async () => {
  for (const corrupt of [r => { r.variables.XPAY_ENV = '1'; }, r => { r.variables.XPAY_TEST_USER_IDS = '*'; },
    r => { r.variables.PHOTO_PRODUCTION_ACCEPTANCE_SHA256 = 'f'.repeat(64); }, r => { r.desiredConfig.maxNum = 2; },
    r => { r.manifestSha256 = 'bad'; }, r => { r.target.serverName = 'leyanxiu-api'; }]) {
    const op = operation({ corrupt }); await assert.rejects(op.run()); assert.deepEqual(op.calls, []);
  }
  for (const uploadUrl of ['http://x.myqcloud.com/path', 'https://evil.test/path', 'https://x.myqcloud.com.evil.test/path',
    'https://REDACTED_USER:REDACTED_PASSWORD@x.myqcloud.com/path', 'https://x.myqcloud.com:8443/path', 'https://x.myqcloud.com/path#fragment']) {
    const op = operation({ uploadUrl }); await assert.rejects(op.run(), /UPLOAD_DESTINATION_INVALID/); assert.deepEqual(op.calls, ['configure', 'authorize']);
  }
});
test('read-only status correlates only new task plus unique remark, never guesses a candidate name or promotion', async () => {
  const op = operation(); await op.run(); const record = op.record(), snapshot = clone(op.snapshot), candidateName = 'buildtest-041';
  snapshot.task = { id: record.taskId, status: 'running', envId: target.envId, serverName: target.serverName };
  snapshot.versions.push({ VersionName: candidateName, Status: 'normal', FlowRatio: 0, Remark: record.remark });
  snapshot.order.releaseOrderInfo = { id: 2842000, serverName: 'buildtest', currentVersion: { versionName: 'buildtest-016' },
    releaseVersion: { versionName: candidateName }, releaseStatus: 'test', isReleasing: true };
  snapshot.candidate = detail(candidateName, record.variables);
  let names = [];
  const inspect = async (_adapter, name) => { names.push(name); return clone(snapshot); };
  const report = await multiEffectMerchantReleaseStatus({}, record, inspect);
  assert.deepEqual(names, [undefined, candidateName]); assert.equal(report.cloud.grayTestReleaseVerified, true);
  assert.equal(report.cloud.candidateConfigurationVerified, true); assert.equal(report.cloud.sourceConfigurationsUnchanged, true);
  assert.equal(report.cloud.priorVersionStateUnchanged, true); assert.equal(report.promoted, false); assert.equal(report.cloud.defaultRoutingVerified, false);
  snapshot.task.id++; names = []; const unrelated = await multiEffectMerchantReleaseStatus({}, record, inspect);
  assert.equal(unrelated.cloud.candidateVersion, null); assert.deepEqual(names, [undefined]);
  snapshot.task.id--; snapshot.versions.push({ VersionName: 'buildtest-042', Remark: record.remark });
  assert.equal((await multiEffectMerchantReleaseStatus({}, record, inspect)).cloud.candidateVersion, null);
});
test('real package verifier rejects a wrong manifest pin before upload and catches package tampering', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'multi-deploy-build-')), out = path.join(temp, target.bundleName);
  try {
    const built = buildPhotoProduction({ output: out });
    assert.equal(built.manifestSha256, target.manifestSha256);
    await assert.rejects(archiveMultiEffectMerchantBundle(out, 'f'.repeat(64)), /BUNDLE_INVALID/);
    const first = await archiveMultiEffectMerchantBundle(out, built.manifestSha256);
    const second = await archiveMultiEffectMerchantBundle(out, built.manifestSha256);
    assert.equal(first.subarray(0, 2).toString(), 'PK'); assert.equal(hash(first), hash(second));
    fs.appendFileSync(path.join(out, 'photo-jobs/generation-acceptance.js'), '\n// synthetic tamper\n');
    await assert.rejects(archiveMultiEffectMerchantBundle(out, built.manifestSha256), /FILE_HASH_MISMATCH/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('inspector reuses supported scoped read-only endpoints with complete pagination and explicit candidate lookup', async () => {
  const snapshot = predecessor(), calls = [], names = [];
  const scoped = args => { assert.equal(args.envId, target.envId); assert.equal(args.serverName, target.serverName); };
  const adapter = { CloudAPI: {
    async tcbDescribeServiceBaseConfig(args) { scoped(args); calls.push('base'); return { serviceBaseConfig: clone(snapshot.base) }; },
    async tcbDescribeServerManageTask(args) { scoped(args); calls.push('task'); return { task: clone(snapshot.task) }; },
    async tcbDescribeWxCloudBaseRunReleaseOrder(args) { scoped(args); assert.equal(args.wxAppid, target.appId); calls.push('order'); return clone(snapshot.order); },
  }, api: {
    async DescribeCloudBaseRunServiceDomain(args) { assert.deepEqual(args, { EnvId: target.envId, ServiceName: 'buildtest' }); calls.push('domain'); return clone(snapshot.domain); },
    async DescribeCloudBaseRunServerVersion(args) { assert.equal(args.EnvId, target.envId); assert.equal(args.ServerName, 'buildtest'); names.push(args.VersionName); return detail(args.VersionName); },
    async DescribeCloudBaseRunServer(args) { assert.equal(args.EnvId, target.envId); assert.equal(args.ServerName, 'buildtest'); assert.equal(args.Limit, 10);
      return { ServerName: 'buildtest', TotalCount: 4, VersionItems: clone(snapshot.versions.slice(args.Offset, args.Offset + 2)) }; },
  } };
  const actual = await inspectMultiEffectMerchantRelease(adapter, 'buildtest-041');
  assert.deepEqual(calls.sort(), ['base', 'domain', 'order', 'task']);
  assert.deepEqual(names.sort(), ['buildtest-013', 'buildtest-014', 'buildtest-016', 'buildtest-041']);
  assert.equal(actual.current.VersionName, 'buildtest-016'); assert.equal(actual.candidate.VersionName, 'buildtest-041');
  assert.equal(actual.versions.length, 4); validateMultiEffectPredecessor(actual);
  adapter.api.DescribeCloudBaseRunServer = async () => ({ ServerName: 'buildtest', TotalCount: 4, VersionItems: clone(snapshot.versions.slice(0, 2)) });
  await assert.rejects(inspectMultiEffectMerchantRelease(adapter), /INVENTORY_UNCONFIRMED/);
});
test('default plan/import read no private files and perform no network or cloud action', () => {
  const script = fileURLToPath(new URL('../scripts/deploy-mini-multieffect-merchant-test.mjs', import.meta.url));
  const program = `import fs from 'node:fs';import http from 'node:http';import https from 'node:https';
const read=fs.readFileSync;fs.readFileSync=function(p,...args){if(/(?:^|[\\\\/])\\.env(?:[.\\\\/]|$)/.test(String(p)))throw Error('PRIVATE_READ');return read.call(this,p,...args)};
globalThis.fetch=()=>{throw Error('NETWORK')};http.request=https.request=http.get=https.get=()=>{throw Error('NETWORK')};
process.argv=[process.execPath,${JSON.stringify(script)},'plan'];await import(${JSON.stringify(new URL('../scripts/deploy-mini-multieffect-merchant-test.mjs', import.meta.url).href)});`;
  const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' }));
  assert.deepEqual(report, multiEffectMerchantDeployPlan); assert.equal(report.cloudOperationPerformed, false);
  assert.equal(report.defaultVersionChangeRequested, false); assert.equal(report.privateFilesRead, false);
});
