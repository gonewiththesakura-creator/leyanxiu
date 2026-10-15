import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareGray, grayTarget } from '../scripts/deploy-mini-production-gray.mjs';
import { buildPhotoProduction } from '../scripts/build-mini-photo-production.mjs';
import { normalizedConfig } from '../scripts/deploy-mini-sandbox-cloud.mjs';
import { prepareClosedRefresh, submitClosedRefresh, safeRefreshState, closedRefreshStatus,
  refreshTarget, validateRefreshStart } from '../scripts/refresh-mini-production-closed.mjs';

const server = fileURLToPath(new URL('../', import.meta.url)), clone = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const canary = 'SYNTHETIC_REFRESH_SECRET_NEVER_PRINT';
const oldEnv = { WECHAT_APP_ID: grayTarget.appId, XPAY_OFFER_ID: '1450662722', XPAY_ENV: '1', XPAY_MODE: 'closed',
  RELEASE_CHANNEL: 'wechat-mini-program', XPAY_MESSAGE_TOKEN: 'synthetic-token',
  XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 3).toString('base64').slice(0, -1), WECHAT_APP_SECRET: canary };
let directory, bundle, previousJournal, baseline;
const bytes = Buffer.alloc(1024, 0x45);
function oldStart() {
  return { serverName: 'buildtest', base: normalizedConfig({ envParams: JSON.stringify(oldEnv), openAccessTypes: ['MINIAPP'],
    minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5, port: 0 }), domain: { AccessTypes: ['MINIAPP'] },
    task: { id: 2313130, status: 'finished' },
    versions: [{ VersionName: 'buildtest-013', Status: 'normal', FlowRatio: 100 }],
    active: [{ versionName: 'buildtest-013', containerPort: 3000, minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5,
      envParams: JSON.stringify(oldEnv) }] };
}
function detail(name, variables) {
  return { VersionName: name, ServerName: 'buildtest', Status: 'normal', EnvParams: JSON.stringify(variables),
    ContainerPort: 3000, MinNum: 0, MaxNum: 1, Cpu: 0.25, Mem: 0.5, IsPublic: true,
    ImageUrl: `private.invalid/${name}`, VersionIP: 'dynamic', RequestId: 'dynamic' };
}
function canceled() {
  return { base: clone(previousJournal.desiredConfig), domain: { AccessTypes: ['MINIAPP'] },
    task: { id: 2335630, status: 'stopped', steps: [{ name: 'GrayRelease', status: 'stopped' }] },
    order: { isExist: true, releaseOrderInfo: { id: 2830122, serverName: 'buildtest',
      currentVersion: { versionName: 'buildtest-013' }, releaseVersion: { versionName: 'buildtest-014' },
      releaseStatus: 'cancel', isReleasing: false, trafficTypeValues: [{ key: 'private', value: canary }] } },
    // All zero is the observed platform shape; never infer routing percentages.
    versions: [{ VersionName: 'buildtest-013', Status: 'normal', FlowRatio: 0 },
      { VersionName: 'buildtest-014', Status: 'normal', FlowRatio: 0, Remark: previousJournal.remark }],
    current: detail('buildtest-013', oldEnv), previous: detail('buildtest-014', previousJournal.variables) };
}
const previous = () => ({ record: clone(previousJournal), sha256: 'a'.repeat(64), backupSha256: 'b'.repeat(64) });
test.before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-refresh-'));
  bundle = path.join(directory, 'bundle');
  const built = buildPhotoProduction({ output: bundle });
  await prepareGray({}, { bundle, manifestSha256: built.manifestSha256, read: () => null,
    write: r => { previousJournal = { ...r, phase: 'submitted', taskId: 2335630 }; }, inspect: async () => [oldStart()],
    inputs: { payment: { ...oldEnv, XPAY_SANDBOX_APP_KEY: 'synthetic', XPAY_SESSION_ENCRYPTION_KEY: '1'.repeat(64) },
      production: { WECHAT_APP_ID: grayTarget.appId, XPAY_OFFER_ID: '1450662722', XPAY_ENV: '0', XPAY_APP_KEY: canary },
      database: { XPAY_MYSQL_DATABASE: 'leyanxiu_xpay_production', XPAY_MYSQL_USER: 'lyx_xpay_prod',
        XPAY_MYSQL_ACCOUNT_HOST: '%', XPAY_MYSQL_PASSWORD: canary },
      media: { ALIYUN_ACCESS_KEY_ID: 'synthetic', ALIYUN_ACCESS_KEY_SECRET: canary, DASHSCOPE_API_KEY: canary,
        DASHSCOPE_BASE: 'https://demo.cn-beijing.maas.aliyuncs.com', OSS_BUCKET: 'synthetic', OSS_REGION: 'oss-cn-shanghai' },
      policyBytes: fs.readFileSync(path.join(server, 'docs/production-config/closed-policy-2026-10-12.json')) } });
  await prepareClosedRefresh({}, { bundle, read: () => null, write: r => { baseline = clone(r); }, previous,
    inspect: async () => canceled(), zipBundle: async () => bytes });
});
test.after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

function operation({ failAt, writeFailure, afterUpload, corrupt, badUrl } = {}) {
  let record = clone(baseline), snapshot = canceled(); corrupt?.(record);
  const calls = [], checkpoint = (name, phase) => {
    assert.equal(record.phase, phase); calls.push(name); if (failAt === name) throw new Error(canary);
  };
  const adapter = { api: { async DescribeCloudBaseBuildService(args) {
    checkpoint('authorize', 'upload_authorization_requested');
    assert.deepEqual(args, { EnvId: refreshTarget.envId, ServiceName: 'buildtest' });
    return { UploadUrl: badUrl || 'https://synthetic.cos.ap-shanghai.myqcloud.com/path', PackageName: 'package', PackageVersion: 'version' };
  } }, axios: { async put(url, sent, config) {
    checkpoint('upload', 'upload_requested'); assert.deepEqual(sent, bytes); assert.equal(config.maxRedirects, 0);
    afterUpload?.(snapshot); return { status: 200 };
  } }, CloudAPI: { async tcbSubmitServerRelease(args) {
    checkpoint('release', 'release_requested');
    assert.equal(args.releaseType, 'GRAY'); assert.equal(args.wxAppId, refreshTarget.appId);
    assert.equal(args.envId, refreshTarget.envId); assert.equal(args.serverName, 'buildtest');
    assert.equal(args.versionRemark, record.remark); assert.equal(args.port, 3000);
    assert.equal(Object.keys(args).some(k => /flow|envParams|conf/i.test(k)), false);
    return { taskId: 2335999 };
  } } };
  const options = { read: () => clone(record), write(next, prior) {
    assert.deepEqual(prior, record); if (next.phase === writeFailure) throw new Error('journal failed'); record = clone(next);
  }, previous, inspect: async () => clone(snapshot), zipBundle: async () => bytes };
  return { adapter, options, calls, record: () => record, run: () => submitClosedRefresh(adapter, options) };
}

test('a canceled release is the starting fact; all zero flow does not block or pretend to prove percentages', () => {
  assert.equal(validateRefreshStart(canceled(), previousJournal), true);
  assert.equal(baseline.preparedAfterExternalCancellation, true);
  assert.equal(baseline.manifestSha256, refreshTarget.manifestSha256);
  assert.equal(baseline.previousJournal.variables.XPAY_SESSION_ENCRYPTION_KEY, previousJournal.variables.XPAY_SESSION_ENCRYPTION_KEY);
});
test('only a new GRAY package is submitted; no base/traffic/cancel operations exist in the adapter', async () => {
  const f = operation(), result = await f.run();
  assert.deepEqual(f.calls, ['authorize', 'upload', 'release']); assert.equal(result.phase, 'submitted');
  assert.equal(result.promoted, false); assert.equal(JSON.stringify(result).includes(canary), false);
});
test('unconfirmed cancellation, changed identity, resources, ingress, or environment rejects before any cloud writes', async () => {
  for (const mutate of [s => { s.order.releaseOrderInfo.releaseStatus = 'test'; }, s => { s.order.releaseOrderInfo.isReleasing = true; },
    s => { s.order.releaseOrderInfo.id++; }, s => { s.task.id++; }, s => { s.task.status = 'running'; },
    s => { s.order.releaseOrderInfo.currentVersion.versionName = 'buildtest-014'; },
    s => { s.domain.AccessTypes.push('PUBLIC'); }, s => { s.previous.Cpu = 1; }, s => { s.current.EnvParams = '{}'; },
    s => { s.previous.EnvParams = '{}'; }, s => { s.base.envParams = '{}'; },
    s => { s.versions.push({ VersionName: 'buildtest-015', Status: 'deploying', FlowRatio: 0 }); }]) {
    const f = operation(), snapshot = canceled(); mutate(snapshot); f.options.inspect = async () => snapshot;
    await assert.rejects(f.run()); assert.deepEqual(f.calls, []);
  }
});
test('changed predecessor image, deployment config, or additional competitor blocks release before upload', async () => {
  for (const mutate of [s => { s.current.ImageUrl = 'changed'; }, s => { s.previous.ImageUrl = 'changed'; },
    s => { s.previous.IsPublic = false; },
    s => { s.base.logType = 'changed'; }, s => { s.versions.push({ VersionName: 'buildtest-015', Status: 'normal' }); }]) {
    const f = operation(), snapshot = canceled(); mutate(snapshot); f.options.inspect = async () => snapshot;
    await assert.rejects(f.run(), /REFRESH_REMOTE_STATE_CHANGED/); assert.deepEqual(f.calls, []);
  }
});
test('transport request ids, volatile IP, and JSON environment key order do not hide actual configuration matches', async () => {
  const f = operation(), snapshot = canceled();
  for (const k of ['current', 'previous']) {
    snapshot[k].RequestId = 'another'; snapshot[k].VersionIP = 'changed';
    snapshot[k].EnvParams = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(snapshot[k].EnvParams)).reverse()));
  }
  f.options.inspect = async () => snapshot; assert.equal((await f.run()).phase, 'submitted');
});
test('journal/archive tampering blocks before first remote mutation', async () => {
  for (const corrupt of [r => { r.target.serverName = 'other'; }, r => { r.manifestSha256 = 'c'.repeat(64); },
    r => { r.previousJournal.variables.XPAY_MODE = 'live'; }, r => { r.preparedAfterExternalCancellation = false; }]) {
    const f = operation({ corrupt }); await assert.rejects(f.run()); assert.deepEqual(f.calls, []);
  }
  const changed = operation(); changed.options.zipBundle = async () => Buffer.alloc(1024, 0x46);
  await assert.rejects(changed.run(), /REFRESH_ARCHIVE_CHANGED/); assert.deepEqual(changed.calls, []);
  const old = operation(); old.options.previous = () => ({ ...previous(), sha256: 'c'.repeat(64) });
  await assert.rejects(old.run(), /REFRESH_PREVIOUS_JOURNAL_CHANGED/); assert.deepEqual(old.calls, []);
});
test('each uncertain network response stays stopped and cannot be automatically repeated', async () => {
  for (const [failAt, phase] of [['authorize', 'upload_authorization_requested'], ['upload', 'upload_requested'], ['release', 'release_requested']]) {
    const f = operation({ failAt }); await assert.rejects(f.run()); assert.equal(f.record().phase, phase);
    const count = f.calls.length; await assert.rejects(f.run(), /REFRESH_NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(f.calls.length, count);
  }
});
test('failed durable intent prevents its corresponding remote write', async () => {
  for (const [writeFailure, prohibited] of [['upload_authorization_requested', 'authorize'], ['upload_requested', 'upload'], ['release_requested', 'release']]) {
    const f = operation({ writeFailure }); await assert.rejects(f.run()); assert.equal(f.calls.includes(prohibited), false);
  }
});
test('post-upload drift blocks release and invalid upload origins never receive bytes', async () => {
  for (const afterUpload of [s => { s.order.releaseOrderInfo.isReleasing = true; }, s => { s.base.envParams = '{}'; },
    s => { s.previous.ImageUrl = 'changed'; }]) {
    const f = operation({ afterUpload }); await assert.rejects(f.run()); assert.deepEqual(f.calls, ['authorize', 'upload']);
  }
  for (const badUrl of ['http://synthetic.myqcloud.com/x', 'https://myqcloud.com.evil.invalid/x',
    'https://REDACTED_USER:REDACTED_PASSWORD@synthetic.myqcloud.com/x', 'https://synthetic.myqcloud.com:444/x']) {
    const f = operation({ badUrl }); await assert.rejects(f.run(), /REFRESH_UPLOAD_DESTINATION_INVALID/); assert.deepEqual(f.calls, ['authorize']);
  }
});
test('status explicitly reads candidate and never claims startup or routing solely from control plane', async () => {
  const record = { ...clone(baseline), phase: 'submitted', taskId: 2335999 }, snapshot = canceled();
  snapshot.task = { id: record.taskId, status: 'running' };
  snapshot.versions.push({ VersionName: 'buildtest-015', Status: 'normal', FlowRatio: 0, Remark: record.remark });
  snapshot.candidate = detail('buildtest-015', previousJournal.variables);
  const requests = [], inspect = async (adapter, version) => { requests.push(version); return clone(snapshot); };
  const result = await closedRefreshStatus({}, record, inspect);
  assert.deepEqual(requests, [undefined, 'buildtest-015']); assert.equal(result.cloud.candidateConfigurationVerified, true);
  assert.equal(result.cloud.predecessorConfigurationUnchanged, true); assert.equal(result.cloud.startupVerified, false);
  assert.equal(result.cloud.routingVerified, false); assert.equal(JSON.stringify(result).includes(canary), false);
  assert.equal(result.cloud.releaseOrderCorrelated, false); assert.equal(result.cloud.grayTestReleaseVerified, false);
  Object.assign(snapshot.order.releaseOrderInfo, { id: 2830999, releaseVersion: { versionName: 'buildtest-015' },
    releaseStatus: 'test', isReleasing: true });
  assert.equal((await closedRefreshStatus({}, record, inspect)).cloud.grayTestReleaseVerified, true);
  snapshot.order.releaseOrderInfo.currentVersion.versionName = 'buildtest-014';
  assert.equal((await closedRefreshStatus({}, record, inspect)).cloud.grayTestReleaseVerified, false);
  snapshot.candidate.IsPublic = false;
  assert.equal((await closedRefreshStatus({}, record, inspect)).cloud.candidateConfigurationVerified, false);
  snapshot.candidate.IsPublic = true;
  snapshot.candidate.EnvParams = '{}'; assert.equal((await closedRefreshStatus({}, record, inspect)).cloud.candidateConfigurationVerified, false);
});
test('safe output does not contain private state and CLI invalid actions/import are inert', () => {
  assert.equal(JSON.stringify(safeRefreshState(baseline)).includes(canary), false);
  const script = path.join(server, 'scripts/refresh-mini-production-closed.mjs');
  const invalid = spawnSync(process.execPath, [script, 'cancel'], { cwd: directory, encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.match(invalid.stderr, /^REFRESH_ARGUMENT_INVALID\s*$/);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../scripts/refresh-mini-production-closed.mjs', import.meta.url).href)});`],
    { cwd: directory, encoding: 'utf8' });
  assert.equal(imported.status, 0); assert.equal(imported.stdout, ''); assert.equal(imported.stderr, '');
});
