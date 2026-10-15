import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMiniProductionCloudProfile, productionClosedPolicy } from '../scripts/mini-production-cloud-profile.mjs';
import { merchantTestAcceptanceSha256 } from '../scripts/prepare-mini-production-merchant-test.mjs';
import { grayTarget, validateGrayPredecessor } from '../scripts/deploy-mini-production-gray.mjs';
import { refreshTarget } from '../scripts/refresh-mini-production-closed.mjs';
import { normalizedConfig } from '../scripts/deploy-mini-sandbox-cloud.mjs';
import { avatarMerchantTarget, avatarMerchantPlan, prepareAvatarMerchantRelease, submitAvatarMerchantRelease,
  validateAvatarPredecessor, validateAvatarMerchantRecord, inspectAvatarMerchantRelease, avatarMerchantReleaseStatus,
  safeAvatarMerchantState, archiveAvatarMerchantBundle } from '../scripts/deploy-mini-avatar-merchant-test.mjs';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(server, relative));
const clone = value => structuredClone(value), digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canary = 'SYNTHETIC_MERCHANT_SECRET_MUST_NOT_PRINT';
const appId = avatarMerchantTarget.appId;
const allowUser = 'usr_00000000-0000-0000-0000-000000000001', operatorUser = 'usr_00000000-0000-0000-0000-000000000002';
const bundle = path.resolve(server, '../../../../candidate-artifacts', avatarMerchantTarget.bundleName);
const archive = Buffer.alloc(1024, 0x45);
const oldEnv = { WECHAT_APP_ID: appId, XPAY_OFFER_ID: '1450662722', XPAY_ENV: '1', XPAY_MODE: 'closed',
  RELEASE_CHANNEL: 'wechat-mini-program', WECHAT_APP_SECRET: canary, XPAY_MESSAGE_TOKEN: 'synthetic-token',
  XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 3).toString('base64').slice(0, -1) };
const inherited = buildMiniProductionCloudProfile({ payment: { ...oldEnv, XPAY_SANDBOX_APP_KEY: 'synthetic-sandbox',
    XPAY_SESSION_ENCRYPTION_KEY: '1'.repeat(64) },
  production: { WECHAT_APP_ID: appId, XPAY_OFFER_ID: '1450662722', XPAY_ENV: '0', XPAY_APP_KEY: canary },
  database: { XPAY_MYSQL_DATABASE: 'leyanxiu_xpay_production', XPAY_MYSQL_USER: 'lyx_xpay_prod', XPAY_MYSQL_ACCOUNT_HOST: '%', XPAY_MYSQL_PASSWORD: canary },
  media: { ALIYUN_ACCESS_KEY_ID: 'synthetic-ak', ALIYUN_ACCESS_KEY_SECRET: canary, DASHSCOPE_API_KEY: canary,
    DASHSCOPE_BASE: 'https://dashscope.aliyuncs.com', OSS_BUCKET: 'synthetic-private-bucket', OSS_REGION: 'oss-cn-shanghai' },
  sessionEncryptionKey: 'a'.repeat(64), policyBytes: read(productionClosedPolicy.relativePath),
  acceptanceBytes: read('evidence/mini-photo-synthetic-generation-v4.json'),
  acceptanceSha256: 'f8cc698254966ab46c22ef60bbfa7c2b47cb82d5705483d45043a9f944a37dde' }).variables;
const inputs = () => ({ inherited: { ...inherited }, policyBytes: read('docs/production-config/natural-avatar-merchant-policy-2026-10-13.json'),
  acceptanceBytes: read('evidence/mini-photo-natural-avatar-v2-runtime-2026-10-13.json'), acceptanceSha256: merchantTestAcceptanceSha256,
  testUserIds: [allowUser], refundOperatorUserIds: [operatorUser],
  publicDocuments: { privacyPolicyUrl: 'https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/privacy.html', userAgreementUrl: 'https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/terms.html', thirdPartyListUrl: 'https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/third-parties.html' },
  retentionSupplierPolicy: 'Synthetic retention fixture only.', pipiaReference: 'synthetic-assessment-not-company-approval',
  aiServiceDisclosures: [{ provider: 'aliyun-qwen-image', model: 'qwen-image-2.0-2026-03-03', filingReference: 'synthetic-reference',
    purpose: 'photo-effect:natural-avatar', region: 'cn-shanghai', capabilities: ['photo-effect'] }] });
const detail = (name, variables) => ({ VersionName: name, ServerName: 'buildtest', EnvId: avatarMerchantTarget.envId,
  Status: 'normal', EnvParams: JSON.stringify(variables), ContainerPort: 3000, MinNum: 0, MaxNum: 1, Cpu: 0.25, Mem: 0.5,
  IsPublic: true, ImageUrl: `private.invalid/${name}`, RequestId: 'dynamic', VersionIP: 'dynamic' });
function predecessorJournal() {
  const before = { serverName: 'buildtest', base: normalizedConfig({ envParams: JSON.stringify(oldEnv), openAccessTypes: ['MINIAPP'], minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5 }),
    domain: { AccessTypes: ['MINIAPP'] }, task: { id: 2313130, status: 'finished' },
    versions: [{ VersionName: 'buildtest-013', Status: 'normal', FlowRatio: 100 }],
    active: [{ versionName: 'buildtest-013', containerPort: 3000, envParams: JSON.stringify(oldEnv), minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5 }] };
  const gray = { version: 1, id: '1'.repeat(24), target: grayTarget, phase: 'submitted', createdAt: '2026-10-12T00:00:00.000Z',
    bundle, manifestSha256: '2'.repeat(64), zipSha256: '3'.repeat(64), zipBytes: 1024, remark: `mini-photo-production closed env0 gray ${'1'.repeat(24)}`,
    before, beforeControl: validateGrayPredecessor(before), variables: { ...inherited },
    desiredConfig: normalizedConfig({ ...before.base, envParams: JSON.stringify(inherited) }), taskId: 2335630 };
  const refreshBefore = { base: gray.desiredConfig, domain: { AccessTypes: ['MINIAPP'] }, task: { id: 2335630, status: 'stopped' },
    order: { isExist: true, releaseOrderInfo: { id: 2830122, serverName: 'buildtest', currentVersion: { versionName: 'buildtest-013' },
      releaseVersion: { versionName: 'buildtest-014' }, releaseStatus: 'cancel', isReleasing: false } },
    versions: [{ VersionName: 'buildtest-013', Status: 'normal', FlowRatio: 0 }, { VersionName: 'buildtest-014', Status: 'normal', FlowRatio: 0, Remark: gray.remark }],
    current: detail('buildtest-013', oldEnv), previous: detail('buildtest-014', inherited) };
  const record = { version: 1, id: '4'.repeat(24), target: refreshTarget, phase: 'submitted', createdAt: '2026-10-12T01:00:00.000Z',
    bundle, manifestSha256: refreshTarget.manifestSha256, zipSha256: '5'.repeat(64), zipBytes: 1024,
    previousJournalSha256: '6'.repeat(64), previousBackupSha256: '7'.repeat(64), preparedAfterExternalCancellation: true,
    remark: `mini-photo-production closed refresh ${'4'.repeat(24)}`, previousJournal: gray, before: refreshBefore, taskId: 2335999 };
  return { record, sha256: digest(JSON.stringify(record)), backupSha256: '8'.repeat(64) };
}
const previous = () => predecessorJournal();
function predecessor() {
  const prior = previous();
  return { ...clone(prior.record.before), task: { id: prior.record.taskId, status: 'running', envId: avatarMerchantTarget.envId, serverName: 'buildtest' },
    order: { isExist: true, releaseOrderInfo: { id: 2830999, serverName: 'buildtest', currentVersion: { versionName: 'buildtest-013' },
      releaseVersion: { versionName: 'buildtest-015' }, releaseStatus: 'test', isReleasing: true, trafficTypeValues: [{ key: 'private', value: canary }] } },
    versions: [...clone(prior.record.before.versions), { VersionName: 'buildtest-015', Status: 'normal', FlowRatio: 0, Remark: prior.record.remark }],
    predecessor: detail('buildtest-015', inherited), candidate: null };
}
let baseline;
test.before(async () => {
  await prepareAvatarMerchantRelease({}, { bundle, inputs: inputs(), previous, read: () => null,
    write: value => { baseline = clone(value); }, inspect: async () => predecessor(), zipBundle: async () => archive });
});
function operation({ failAt, writeFailure, afterConfigure, afterUpload, corrupt, uploadUrl } = {}) {
  let record = clone(baseline), snapshot = predecessor();
  snapshot.task.status = 'stopped'; snapshot.order.releaseOrderInfo.releaseStatus = 'cancel'; snapshot.order.releaseOrderInfo.isReleasing = false;
  corrupt?.(record);
  const calls = [], checkpoint = (name, phase) => {
    assert.equal(record.phase, phase); calls.push(name); if (name === failAt) throw new Error(canary);
  };
  const adapter = { CloudAPI: {
    async tcbUpdateServerBaseConfig(args) { checkpoint('configure', 'configure_requested');
      assert.deepEqual(args, { envId: avatarMerchantTarget.envId, serverName: 'buildtest', wxAppId: appId, conf: record.desiredConfig });
      snapshot.base = clone(args.conf); afterConfigure?.(snapshot); },
    async tcbSubmitServerRelease(args) { checkpoint('release', 'release_requested');
      assert.equal(args.releaseType, 'GRAY'); assert.equal(args.serverName, 'buildtest'); assert.equal(args.wxAppId, appId);
      assert.equal(args.versionRemark, record.remark); assert.equal(Object.keys(args).some(key => /flow|envParams|conf/i.test(key)), false);
      return { taskId: 2336999 }; },
  }, api: { async DescribeCloudBaseBuildService(args) { checkpoint('authorize', 'upload_authorization_requested');
    assert.deepEqual(args, { EnvId: avatarMerchantTarget.envId, ServiceName: 'buildtest' });
    return { UploadUrl: uploadUrl || 'https://synthetic.cos.ap-shanghai.myqcloud.com/path', PackageName: 'package.zip', PackageVersion: 'version' }; } },
  axios: { async put(_url, bytes, options) { checkpoint('upload', 'upload_requested'); assert.deepEqual(bytes, archive);
    assert.equal(options.maxRedirects, 0); afterUpload?.(snapshot); return { status: 200 }; } } };
  const options = { read: () => clone(record), previous, inspect: async () => clone(snapshot), zipBundle: async () => archive,
    write(next, prior) { assert.deepEqual(prior, record); if (next.phase === writeFailure) throw new Error(canary); record = clone(next); } };
  return { adapter, options, calls, snapshot, record: () => clone(record), run: () => submitAvatarMerchantRelease(adapter, options) };
}

test('prepare only records the exact live 015 test release and inherits its unchanged formal identity', () => {
  assert.equal(baseline.phase, 'prepared'); assert.equal(baseline.before.order.releaseOrderInfo.id, 2830999);
  assert.equal(baseline.previous.record.taskId, 2335999); assert.equal(baseline.manifestSha256, avatarMerchantTarget.manifestSha256);
  assert.equal(baseline.variables.XPAY_ENV, '0'); assert.equal(baseline.variables.XPAY_MODE, 'merchant_test');
  for (const key of ['XPAY_SESSION_ENCRYPTION_KEY', 'XPAY_APP_KEY', 'XPAY_MYSQL_PASSWORD', 'XPAY_MYSQL_DATABASE', 'XPAY_MESSAGE_TOKEN']) assert.equal(baseline.variables[key], inherited[key]);
  assert.equal(baseline.variables.XPAY_TEST_USER_IDS, allowUser); assert.equal(baseline.variables.XPAY_REFUND_OPERATOR_USER_IDS, operatorUser);
  assert.equal(baseline.variables.XPAY_SANDBOX_APP_KEY, undefined);
  assert.equal(safeAvatarMerchantState(baseline).realChargesPossibleAfterDeployment, true);
  assert.equal(safeAvatarMerchantState(baseline).callbackRoutingVerified, false);
});

test('unknown pending releases, wrong predecessor and existing journal stop prepare before any mutation', async () => {
  let writes = 0, inspections = 0;
  const options = { bundle, inputs: inputs(), previous, read: () => null, write: () => { writes++; }, zipBundle: async () => archive,
    inspect: async () => { inspections++; return predecessor(); } };
  await assert.rejects(prepareAvatarMerchantRelease({}, { ...options, read: () => clone(baseline) }), /PENDING_JOURNAL_EXISTS/);
  assert.equal(inspections, 0);
  await assert.rejects(prepareAvatarMerchantRelease({}, { ...options, inputs: { ...inputs(), inherited: { ...inherited, XPAY_SESSION_ENCRYPTION_KEY: 'b'.repeat(64) } } }), /INHERITED_CONFIGURATION_CHANGED/);
  for (const change of [s => { s.order.releaseOrderInfo.releaseVersion.versionName = 'buildtest-016'; },
    s => { s.task.id++; }, s => { s.task.serverName = 'another'; }, s => { s.predecessor.EnvParams = '{}'; },
    s => { s.versions[0].FlowRatio = 42; },
    s => { s.order.releaseOrderInfo.releaseStatus = 'cancel'; }, s => { s.domain.AccessTypes.push('PUBLIC'); },
    s => { s.versions.push({ VersionName: 'buildtest-016', Status: 'deploying', FlowRatio: 0 }); }]) {
    const snapshot = predecessor(); change(snapshot);
    await assert.rejects(prepareAvatarMerchantRelease({}, { ...options, inspect: async () => snapshot }), /AVATAR_MERCHANT_/);
  }
  assert.equal(writes, 0);
});

test('submit requires external cancellation of the same order; test state never triggers a cancel or cloud write', async () => {
  const f = operation(); f.options.inspect = async () => predecessor();
  await assert.rejects(f.run(), /PREDECESSOR_RELEASE_UNCONFIRMED/); assert.deepEqual(f.calls, []);
  const changed = operation(); changed.snapshot.order.releaseOrderInfo.id++;
  await assert.rejects(changed.run(), /REMOTE_STATE_CHANGED/); assert.deepEqual(changed.calls, []);
  const valid = operation(), result = await valid.run();
  assert.deepEqual(valid.calls, ['configure', 'authorize', 'upload', 'release']);
  assert.equal(result.phase, 'submitted'); assert.equal(result.promoted, false); assert.equal(result.taskId, 2336999);
  assert.deepEqual(valid.snapshot.current, baseline.before.current); assert.deepEqual(valid.snapshot.predecessor, baseline.before.predecessor);
  assert.deepEqual(valid.snapshot.versions, baseline.before.versions);
  await assert.rejects(valid.run(), /NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(valid.calls.length, 4);
});

test('each uncertain SDK response is journaled once and never resent', async t => {
  for (const [name, phase] of [['configure', 'configure_requested'], ['authorize', 'upload_authorization_requested'],
    ['upload', 'upload_requested'], ['release', 'release_requested']]) await t.test(name, async () => {
    const f = operation({ failAt: name }); await assert.rejects(f.run()); assert.equal(f.record().phase, phase);
    const calls = f.calls.length; await assert.rejects(f.run(), /NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(f.calls.length, calls);
  });
});

test('cancellation permits only the frozen current version restoration from zero to full flow', async () => {
  const restored = operation();
  restored.snapshot.versions.find(v => v.VersionName === avatarMerchantTarget.currentVersion).FlowRatio = 100;
  const preparedBefore = clone(restored.record().before);
  const result = await restored.run();
  assert.equal(result.phase, 'submitted');
  assert.deepEqual(restored.calls, ['configure', 'authorize', 'upload', 'release']);
  assert.deepEqual(restored.record().before, preparedBefore);
  assert.equal(restored.record().before.versions.find(v => v.VersionName === avatarMerchantTarget.currentVersion).FlowRatio, 0);

  for (const mutate of [
    s => { s.versions.find(v => v.VersionName === avatarMerchantTarget.currentVersion).FlowRatio = 99; },
    s => { s.versions.find(v => v.VersionName === avatarMerchantTarget.previousVersion).FlowRatio = 100; },
    s => { s.versions.find(v => v.VersionName === avatarMerchantTarget.predecessorVersion).FlowRatio = 100; },
    s => { s.versions.find(v => v.VersionName === avatarMerchantTarget.currentVersion).Remark = 'changed'; },
    s => { s.versions.push({ VersionName: 'buildtest-016', Status: 'normal', FlowRatio: 0 }); },
    s => { s.order.releaseOrderInfo.id++; },
    s => { s.order.releaseOrderInfo.releaseStatus = 'test'; s.order.releaseOrderInfo.isReleasing = true; },
    s => { s.task.status = 'running'; },
  ]) {
    const rejected = operation();
    rejected.snapshot.versions.find(v => v.VersionName === avatarMerchantTarget.currentVersion).FlowRatio = 100;
    mutate(rejected.snapshot);
    await assert.rejects(rejected.run(), /AVATAR_MERCHANT_/);
    assert.deepEqual(rejected.calls, []); assert.equal(rejected.record().phase, 'prepared');
  }
  const reversal = operation({ corrupt: record => {
    record.before.versions.find(v => v.VersionName === avatarMerchantTarget.currentVersion).FlowRatio = 100;
  } });
  await assert.rejects(reversal.run(), /REMOTE_STATE_CHANGED/); assert.deepEqual(reversal.calls, []);
});

test('the first canceled version readback stays exact through configuration and upload', async () => {
  const current = s => s.versions.find(v => v.VersionName === avatarMerchantTarget.currentVersion);
  for (const [hook, initialFlow, nextFlow, expectedCalls] of [
    ['afterConfigure', 0, 100, ['configure']],
    ['afterConfigure', 100, 0, ['configure']],
    ['afterUpload', 0, 100, ['configure', 'authorize', 'upload']],
    ['afterUpload', 100, 0, ['configure', 'authorize', 'upload']],
  ]) {
    const changed = operation({ [hook]: s => { current(s).FlowRatio = nextFlow; } });
    current(changed.snapshot).FlowRatio = initialFlow;
    await assert.rejects(changed.run(), /REMOTE_STATE_CHANGED/); assert.deepEqual(changed.calls, expectedCalls);
    assert.equal(changed.calls.includes('release'), false);
  }
});

test('failed durable intent writes prevent the corresponding cloud call', async t => {
  for (const [phase, prohibited] of [['configure_requested', 'configure'], ['upload_authorization_requested', 'authorize'],
    ['upload_requested', 'upload'], ['release_requested', 'release']]) await t.test(phase, async () => {
    const f = operation({ writeFailure: phase }); await assert.rejects(f.run()); assert.equal(f.calls.includes(prohibited), false);
  });
});

test('modified archive, predecessor journal, environment or desired resources cannot reach a cloud mutation', async () => {
  const archiveChange = operation(); archiveChange.options.zipBundle = async () => Buffer.concat([archive, Buffer.from('changed')]);
  await assert.rejects(archiveChange.run(), /ARCHIVE_CHANGED/); assert.deepEqual(archiveChange.calls, []);
  const priorChange = operation(); priorChange.options.previous = () => ({ ...previous(), sha256: 'f'.repeat(64) });
  await assert.rejects(priorChange.run(), /PREDECESSOR_JOURNAL_CHANGED/); assert.deepEqual(priorChange.calls, []);
  for (const mutate of [r => { r.variables.XPAY_MODE = 'live'; }, r => { r.variables.XPAY_ENV = '1'; },
    r => { r.variables.XPAY_SESSION_ENCRYPTION_KEY = 'b'.repeat(64); }, r => { r.variables.XPAY_TEST_USER_IDS = ''; },
    r => { r.desiredConfig.cpu = 1; }, r => { r.desiredConfig.publicAccess = true; }, r => { r.manifestSha256 = 'e'.repeat(64); },
    r => { r.merchantInputs.acceptanceSha256 = 'e'.repeat(64); }]) {
    const f = operation({ corrupt: mutate }); await assert.rejects(f.run()); assert.deepEqual(f.calls, []);
  }
});

test('post-configuration readback and pre-release recheck reject drift without automatic rollback', async () => {
  for (const change of [s => { s.base.logType = 'changed'; }, s => { s.task.id++; }, s => { s.current.EnvParams = '{}'; },
    s => { s.predecessor.MinNum = 1; }, s => { s.versions[0].FlowRatio = 100; }, s => { s.domain.AccessTypes.push('PUBLIC'); }]) {
    const f = operation({ afterConfigure: change }); await assert.rejects(f.run()); assert.deepEqual(f.calls, ['configure']);
    assert.equal(f.record().phase, 'configure_requested');
  }
  const afterUpload = operation({ afterUpload: s => { s.order.releaseOrderInfo.id++; } });
  await assert.rejects(afterUpload.run()); assert.deepEqual(afterUpload.calls, ['configure', 'authorize', 'upload']);
  assert.equal(afterUpload.record().phase, 'uploaded');
});

test('untrusted upload destinations never receive the archive', async () => {
  for (const uploadUrl of ['http://synthetic.myqcloud.com/x', 'https://myqcloud.com.evil.invalid/x',
    'https://REDACTED_USER:REDACTED_PASSWORD@synthetic.myqcloud.com/x', 'https://synthetic.myqcloud.com:444/x', 'https://127.0.0.1/x']) {
    const f = operation({ uploadUrl }); await assert.rejects(f.run(), /UPLOAD_DESTINATION_INVALID/);
    assert.deepEqual(f.calls, ['configure', 'authorize']);
  }
});

function submittedState() {
  const record = { ...clone(baseline), phase: 'submitted', packageName: 'package.zip', packageVersion: 'version', taskId: 2336999,
    releaseRequestedAt: '2026-10-13T00:00:00.000Z' };
  const snapshot = predecessor(); snapshot.base = clone(record.desiredConfig); snapshot.task.id = record.taskId;
  snapshot.versions.push({ VersionName: 'buildtest-016', Status: 'normal', FlowRatio: 0, Remark: record.remark });
  snapshot.candidate = detail('buildtest-016', record.variables); snapshot.order.releaseOrderInfo.id++;
  snapshot.order.releaseOrderInfo.releaseVersion.versionName = 'buildtest-016';
  return { record, snapshot };
}
test('status correlates new task/order/version and reads candidate variables, while withholding runtime and routing claims', async () => {
  const f = submittedState(), reads = [];
  const report = await avatarMerchantReleaseStatus({}, f.record, async (_adapter, name) => { reads.push(name); return clone(f.snapshot); });
  assert.deepEqual(reads, [undefined, 'buildtest-016']);
  for (const key of ['currentTaskMatches', 'releaseOrderCorrelated', 'grayTestReleaseVerified', 'candidateConfigurationVerified',
    'privateIngressVerified', 'desiredBaseVerified', 'predecessorConfigurationsUnchanged', 'priorVersionStateUnchanged']) assert.equal(report.cloud[key], true, key);
  for (const key of ['startupVerified', 'routingVerified', 'paymentCallbackRoutingVerified']) assert.equal(report.cloud[key], false);
  const output = JSON.stringify(report);
  for (const secret of [canary, inherited.XPAY_SESSION_ENCRYPTION_KEY, allowUser, operatorUser, 'private.invalid', 'trafficTypeValues']) assert.equal(output.includes(secret), false);
  for (const change of [s => { s.snapshot.candidate.EnvParams = JSON.stringify({ ...s.record.variables, XPAY_ENV: '1' }); },
    s => { s.snapshot.candidate.Cpu = 0; }, s => { s.snapshot.task.id++; },
    s => { s.snapshot.versions.push({ ...s.snapshot.versions.at(-1), VersionName: 'buildtest-017' }); },
    s => { s.record.phase = 'release_requested'; delete s.record.taskId; }]) {
    const rejected = submittedState(); change(rejected);
    assert.equal((await avatarMerchantReleaseStatus({}, rejected.record, async () => rejected.snapshot)).cloud.candidateConfigurationVerified, false);
  }
  const drift = submittedState(); let inspections = 0;
  const driftReport = await avatarMerchantReleaseStatus({}, drift.record, async () => {
    const snapshot = clone(drift.snapshot); if (++inspections > 1) snapshot.task.id++; return snapshot;
  });
  assert.equal(driftReport.cloud.currentTaskMatches, false);
  assert.equal(driftReport.cloud.candidateConfigurationVerified, false);
  assert.equal(driftReport.cloud.grayTestReleaseVerified, false);
});

test('read-only inventory uses existing SDK inspection and explicitly reads 015 and the correlated candidate', async () => {
  const f = submittedState(), requested = [], snapshot = f.snapshot;
  const adapter = { CloudAPI: {
    async tcbDescribeServiceBaseConfig() { return { serviceBaseConfig: snapshot.base }; },
    async tcbDescribeServerManageTask() { return { task: snapshot.task }; },
    async tcbDescribeWxCloudBaseRunReleaseOrder() { return snapshot.order; },
  }, api: {
    async DescribeCloudBaseRunServiceDomain() { return snapshot.domain; },
    async DescribeCloudBaseRunServer() { return { ServerName: 'buildtest', TotalCount: snapshot.versions.length, VersionItems: snapshot.versions }; },
    async DescribeCloudBaseRunServerVersion(args) { requested.push(args.VersionName);
      return Object.values(snapshot).find(value => value?.VersionName === args.VersionName); },
  } };
  const inspected = await inspectAvatarMerchantRelease(adapter, 'buildtest-016');
  assert.deepEqual(requested, ['buildtest-013', 'buildtest-014', 'buildtest-015', 'buildtest-016']);
  assert.equal(inspected.predecessor.VersionName, 'buildtest-015'); assert.equal(inspected.candidate.VersionName, 'buildtest-016');
});

test('archive accepts only the pinned avatar-ready package and detects any changed source byte', async t => {
  const bytes = await archiveAvatarMerchantBundle(bundle);
  assert.ok(bytes.length > 100); assert.ok(bytes.length < 2 * 1024 * 1024);
  assert.equal(digest(await archiveAvatarMerchantBundle(bundle)), digest(bytes));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-merchant-deploy-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const copied = path.join(directory, avatarMerchantTarget.bundleName);
  fs.mkdirSync(copied);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json')));
  for (const relative of [...manifest.files.map(file => file.path), 'manifest.json']) {
    const destination = path.join(copied, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(bundle, relative), destination, fs.constants.COPYFILE_EXCL);
  }
  fs.appendFileSync(path.join(copied, 'photo-jobs/production-host.js'), '\n// synthetic tamper\n');
  await assert.rejects(archiveAvatarMerchantBundle(copied), /FILE_HASH_MISMATCH|BUNDLE_CHANGED/);
  await assert.rejects(archiveAvatarMerchantBundle(path.join(directory, 'other-bundle')), /BUNDLE_INVALID/);
});

test('imports and default/plan CLI are inert, and invalid action cannot read private files or print argument secrets', () => {
  const script = path.join(server, 'scripts/deploy-mini-avatar-merchant-test.mjs');
  for (const args of [[], ['plan']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: 'nonexistent-private-config', XPAY_MODE: 'live', XPAY_APP_KEY: canary } });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), avatarMerchantPlan); assert.equal(result.stderr, '');
  }
  const invalid = spawnSync(process.execPath, [script, 'deploy', canary], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr.trim(), 'AVATAR_MERCHANT_ARGUMENT_INVALID');
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/deploy-mini-avatar-merchant-test.mjs', import.meta.url).href)});`], { encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
  assert.equal(avatarMerchantPlan.privateFilesRead, false); assert.equal(avatarMerchantPlan.cloudOperationPerformed, false);
  assert.doesNotThrow(() => validateAvatarMerchantRecord(baseline)); assert.equal(validateAvatarPredecessor(predecessor(), previous()), true);
});
