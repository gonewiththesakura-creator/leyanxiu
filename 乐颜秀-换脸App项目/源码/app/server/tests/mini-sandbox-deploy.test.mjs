import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { main, target, deploymentEnvironment, bundlePaths, readBundle, packageBundle, parseArguments,
  privateFiles, verifyPublicClosed, normalizedConfig, upgradeSource, readAllCloudVersions } from '../scripts/deploy-mini-sandbox-cloud.mjs';
import { nextUpgradeSource, nextSourceManifest, nextEnvironment, repairSource, repairSourceManifest,
  repairProfile, repairEnvironment, repairEnvironmentMatches, resumeSource, resumeSourceManifest,
  resumeProfile, closeProfile, acceptanceEnvironment, acceptanceEnvironmentMatches } from '../scripts/mini-sandbox-next-profile.mjs';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function fixture(historicalVersions = []) {
  const payment = { WECHAT_APP_ID: target.appId, XPAY_OFFER_ID: '1450662722',
    WECHAT_APP_SECRET: 'fictional-app-secret', XPAY_SANDBOX_APP_KEY: 'fictional-sandbox-key',
    XPAY_MESSAGE_TOKEN: 'fictionalmessagetoken', XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 7).toString('base64').slice(0, -1),
    XPAY_SESSION_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString('hex'),
    RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', XPAY_ENABLED: 'false', XPAY_MODE: 'closed', XPAY_ENV: '1',
    XPAY_DB_BACKEND: 'mysql', XPAY_MYSQL_TRANSPORT: 'cloudrun_builtin_private',
    XPAY_CLOUD_ENV_ID: target.cloudEnvId, XPAY_MYSQL_INSTANCE_ID: target.instanceId,
    XPAY_MYSQL_HOST: target.host, XPAY_MYSQL_PORT: String(target.port), XPAY_MYSQL_USER: target.user,
    XPAY_MYSQL_DATABASE: target.database, XPAY_MYSQL_PASSWORD: 'fictional-mysql-password',
    AUTH_SESSION_SECRET: 'fictional-unrelated-secret', XPAY_APP_KEY: 'fictional-real-money-key', UNRELATED_SECRET: 'fictional-extra-secret' };
  const cloud = { WXCLOUD_APP_ID: target.appId, WXCLOUD_PRIVATE_KEY: 'fictional-cloud-private-key' };
  const initialEnv = Object.fromEntries(['WECHAT_APP_ID', 'XPAY_ENABLED', 'XPAY_MODE', 'XPAY_MESSAGE_TOKEN', 'XPAY_MESSAGE_AES_KEY']
    .map(key => [key, payment[key]]));
  const task = { id: 100, envId: target.cloudEnvId, serverName: target.serviceName, status: 'finished', versionName: 'buildtest-007' };
  const inventory = { environmentConfirmed: true, baseConfig: { publicAccess: false, openAccessTypes: ['MINIAPP'],
    port: 3000, minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5, logType: 'none', internalAccess: 'none',
    policyType: 'cpu', policyThreshold: 60, envParams: JSON.stringify(initialEnv) }, accessTypes: ['MINIAPP'],
    publicDomain: 'buildtest-292172-5-1463758271.sh.run.tcloudbase.com', activeVersionPort: 3000,
    versions: [...clone(historicalVersions), { VersionName: 'buildtest-007', FlowRatio: 100, Status: 'normal', Remark: '20260929 mini-callback cloud-push verification-only no-sales' }],
    task, detail: { dbClusterId: target.instanceId, dbInfo: { status: 'running', isOpenPubNetAccess: false },
      netInfo: { privateNetAddress: `${target.host}:${target.port}`, pubNetAddress: null } },
    accounts: { clusterStatus: 'running', accounts: [{ accountName: target.user, host: '%' }] } };
  const original = clone(inventory), events = [], tasks = new Map([[100, task]]);
  const state = { pending: null, backup: null, locked: false, writes: [], failSavePhase: null, failCall: null, cloudCalls: 0,
    archives: [], nextReleaseTaskId: 101, nextReleaseVersion: 'buildtest-008' };
  const files = {
    readConfiguration: () => ({ payment: clone(payment), cloud: clone(cloud) }),
    readPending: () => clone(state.pending),
    createPending(record) { events.push('snapshot'); assert.equal(state.pending, null); state.backup = clone(record); state.pending = clone(record); },
    archiveConfirmedPending(next, previous, evidence) {
      events.push('archive'); assert.deepEqual(state.pending, previous);
      assert.equal(evidence.controlPlaneVerified, true); assert.deepEqual(evidence.source, next.upgradeFrom);
      state.archives.push({ pending: clone(previous), backup: clone(state.backup), evidence: clone(evidence) });
      state.backup = clone(next); state.pending = clone(next);
    },
    updatePending(record, before) {
      assert.deepEqual(state.pending, before); events.push(record.phase);
      if (state.failSavePhase === record.phase) throw new Error('disk failure fictional-private-key');
      state.pending = clone(record);
    },
    async withLock(operation) {
      if (state.locked) throw new Error('OPERATION_LOCKED'); state.locked = true;
      try { return await operation(); } finally { state.locked = false; }
    },
  };
  const wrote = kind => {
    events.push(kind); state.writes.push(kind);
    if (state.failCall === kind) throw new Error('unknown remote result fictional-cloud-private-key');
  };
  const api = {
    async inspect() { state.cloudCalls++; events.push('inspect'); return clone(inventory); },
    async updateConfig(conf) {
      assert.ok(['configure_requested', 'restore_requested'].includes(state.pending.phase)); wrote('configure');
      inventory.baseConfig = clone(conf); return {};
    },
    async prepareUpload() {
      assert.equal(state.pending.phase, 'upload_authorization_requested'); wrote('allocate');
      return { UploadUrl: 'https://fictional-upload.myqcloud.com/signed?signature=REDACTED_SECRET
        PackageName: 'fictional.zip', PackageVersion: 'fictional-package-version' };
    },
    async upload() { assert.equal(state.pending.phase, 'upload_requested'); wrote('upload'); },
    async release(record) {
      assert.equal(state.pending.phase, 'release_requested'); wrote('release');
      inventory.versions.push({ VersionName: state.nextReleaseVersion, FlowRatio: 0, Status: 'creating', Remark: record.remark });
      inventory.task = { id: state.nextReleaseTaskId, envId: target.cloudEnvId, serverName: target.serviceName,
        status: 'running', versionName: state.nextReleaseVersion, preVersionName: record.before.version };
      tasks.set(inventory.task.id, inventory.task); return { taskId: inventory.task.id };
    },
    async rollback(record) {
      assert.equal(state.pending.phase, 'rollback_requested'); wrote('rollback');
      inventory.task = { id: 102, envId: target.cloudEnvId, serverName: target.serviceName,
        status: 'running', versionName: record.before.version, preVersionName: record.releaseVersion };
      tasks.set(102, inventory.task); return { taskId: 102 };
    },
    async task(id) { events.push(`task:${id}`); return clone(tasks.get(id)); },
  };
  const options = { files, withCloud: async (value, operation) => { assert.deepEqual(value, cloud); return operation(api); },
    bundleDirectory: 'fictional-candidate', manifestSha256: 'a'.repeat(64), expectedVersion: 'buildtest-007',
    loadBundle: () => ({ manifestHash: 'a'.repeat(64), entries: bundlePaths.map(name => ({ name, bytes: Buffer.from('fictional') })) }),
    zip: async () => Buffer.from('fictional-zip'), operationId: () => 'abcdef0123456789abcdef01', now: () => '2026-10-08T00:00:00.000Z',
    fetchImpl: async (url, options) => { events.push(`probe:${new URL(url).pathname}`); assert.equal(options.redirect, 'error');
      return new Response('fictional gateway denied', { status: 403 }); } };
  const finishRelease = () => {
    inventory.task.status = 'finished';
    for (const version of inventory.versions) version.FlowRatio = version.VersionName === inventory.task.versionName ? 100 : 0;
    inventory.versions.find(v => v.VersionName === inventory.task.versionName).Status = 'normal';
  };
  const finishRollback = () => {
    inventory.task.status = 'finished';
    for (const version of inventory.versions) version.FlowRatio = version.VersionName === inventory.task.versionName ? 100 : 0;
  };
  return { payment, cloud, original, inventory, events, tasks, state, files, api, options, finishRelease, finishRollback };
}

test('default status and plan perform only reads, disclose names only, and leave local disabled env untouched', async () => {
  const f = fixture(), before = clone(f.payment);
  assert.equal((await main(f.options)).action, 'status');
  const report = await main({ ...f.options, action: 'plan' });
  assert.equal(report.planReady, true); assert.equal(report.privateHealthVerified, false);
  assert.equal(report.env, 1); assert.equal(report.productionPaymentsEnabled, false);
  assert.equal(report.sandboxMayCharge, true); assert.equal(report.realMoneyAllowed, undefined);
  assert.equal(report.chargingEnabled, undefined); assert.equal(report.sandboxPurchaseReadinessVerified, false);
  assert.deepEqual(report.public403Checks.map(item => item.status), [403, 403]);
  assert.equal(report.databaseLoginVerified, false); assert.equal(f.state.pending, null); assert.deepEqual(f.state.writes, []);
  assert.deepEqual(f.payment, before);
  for (const value of Object.values(f.payment).filter(v => v.startsWith('fictional-'))) assert.equal(JSON.stringify(report).includes(value), false);
});

test('both public routes must be denied before plan readiness, snapshot creation or any deployment write', async () => {
  for (const action of ['plan', 'deploy']) {
    for (const route of ['/health', '/api/mini/payments/notify/cloud']) {
      for (const failure of ['200', '500', 'timeout']) {
        const f = fixture();
        f.options.fetchImpl = async url => {
          if (new URL(url).pathname !== route) return new Response('denied', { status: 403 });
          if (failure === 'timeout') throw new Error('fictional network timeout with private detail');
          return new Response('not denied', { status: Number(failure) });
        };
        const result = await main({ ...f.options, action });
        assert.equal(result.ok, false); assert.notEqual(result.planReady, true);
        assert.equal(f.state.pending, null); assert.deepEqual(f.state.writes, []);
        assert.equal(JSON.stringify(result).includes('private detail'), false);
      }
    }
  }
});

test('public ingress is rechecked after configuration and immediately before release', async () => {
  for (const [firstBadProbe, expectedWrites, expectedPhase] of [
    [3, ['configure'], 'configured'], [5, ['configure', 'allocate', 'upload'], 'uploaded'],
  ]) {
    const f = fixture(); let probes = 0;
    f.options.fetchImpl = async () => new Response('fictional', { status: ++probes < firstBadProbe ? 403 : 200 });
    const result = await main({ ...f.options, action: 'deploy' });
    assert.equal(result.failureCode, 'PUBLIC_ACCESS_UNCONFIRMED');
    assert.deepEqual(f.state.writes, expectedWrites); assert.equal(f.state.pending.phase, expectedPhase);
    assert.equal(f.state.writes.includes('release'), false);
    const count = f.state.writes.length;
    assert.equal((await main({ ...f.options, action: 'deploy' })).failureCode, 'PENDING_REQUIRES_REVIEW');
    assert.equal(f.state.writes.length, count);
  }
});

test('observed SDK omissions and port zero work through deployment and rollback while identity fields survive normalization', async () => {
  for (const publicAccess of [undefined, null, false]) {
    const f = fixture();
    if (publicAccess === undefined) delete f.inventory.baseConfig.publicAccess;
    else f.inventory.baseConfig.publicAccess = publicAccess;
    Object.assign(f.inventory.baseConfig, { port: 0, envId: target.cloudEnvId, serverName: target.serviceName,
      serviceId: 'fictional-service-identity', createdAt: 'fictional-create-time', updatedAt: 'fictional-update-time' });
    const before = clone(f.inventory.baseConfig), normalized = normalizedConfig(before);
    for (const key of ['envId', 'serverName', 'serviceId', 'createdAt', 'updatedAt']) assert.equal(normalized[key], before[key]);
    assert.equal('publicAccess' in normalized, 'publicAccess' in before);
    assert.equal((await main({ ...f.options, action: 'plan' })).planReady, true);
    assert.equal((await main({ ...f.options, action: 'deploy' })).submitted, true);
    assert.equal(f.inventory.baseConfig.publicAccess, publicAccess);
    f.finishRelease(); assert.equal((await main({ ...f.options, action: 'status' })).controlPlaneDeploymentVerified, true);
    await main({ ...f.options, action: 'rollback' }); f.finishRollback();
    assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackComplete, true);
    assert.deepEqual(f.inventory.baseConfig, before);
  }
  for (const port of [undefined, 0, 8080]) {
    const f = fixture(); f.inventory.activeVersionPort = port;
    assert.equal((await main({ ...f.options, action: 'plan' })).planReady, false);
    assert.equal((await main({ ...f.options, action: 'deploy' })).ok, false); assert.deepEqual(f.state.writes, []);
  }
});

test('deployment mapping is an exact sandbox allowlist and cannot copy unrelated or production secrets', () => {
  const f = fixture(), env = deploymentEnvironment(f.payment);
  assert.equal(env.XPAY_ENABLED, 'true'); assert.equal(env.XPAY_MODE, 'closed'); assert.equal(env.XPAY_ENV, '1');
  assert.equal(env.XPAY_RECONCILE_ENABLED, 'false'); assert.equal(env.XPAY_PRODUCTS_JSON, '[]');
  for (const field of ['AUTH_SESSION_SECRET', 'XPAY_APP_KEY', 'UNRELATED_SECRET']) assert.equal(field in env, false);
  for (const change of [{ XPAY_ENABLED: 'true' }, { XPAY_MODE: 'sandbox' }, { XPAY_ENV: '0' },
    { XPAY_MYSQL_USER: 'root' }, { XPAY_MYSQL_HOST: '203.0.113.1' }, { XPAY_MYSQL_CA_FILE: '/wrong-ca' },
    { XPAY_CLOUD_ENV_ID: 'other' }, { XPAY_MYSQL_PASSWORD: '' }, { XPAY_OFFER_ID: 'other' }]) {
    assert.throws(() => deploymentEnvironment({ ...f.payment, ...change }), /LOCAL_CONFIGURATION_INVALID/);
  }
});

test('wrong cloud app, unsafe local config or invalid explicit deploy arguments cannot reach cloud', async () => {
  for (const change of [f => { f.cloud.WXCLOUD_APP_ID = 'other'; }, f => { f.payment.XPAY_ENV = '0'; },
    f => { f.options.manifestSha256 = ''; }, f => { f.options.expectedVersion = 'leyanxiu-stage-011'; }]) {
    const f = fixture(); change(f); f.options.withCloud = async () => assert.fail('cloud must not be reached');
    assert.equal((await main({ ...f.options, action: 'deploy' })).ok, false); assert.deepEqual(f.state.writes, []);
  }
});

test('changed service, other live version, new task, public entry and database mismatch all stop before snapshot or writes', async () => {
  for (const change of [f => { f.inventory.accessTypes.push('PUBLIC'); }, f => { f.inventory.baseConfig.publicAccess = true; },
    f => { f.inventory.task.status = 'running'; }, f => { f.inventory.versions[0].Remark = 'business-live'; },
    f => { f.inventory.versions[0].VersionName = 'buildtest-009'; }, f => { f.inventory.baseConfig.maxNum = 2; },
    f => { f.inventory.versions.push({ VersionName: 'buildtest-006', FlowRatio: 1, Status: 'normal' }); },
    f => { f.inventory.environmentConfirmed = false; }, f => { f.inventory.detail.dbInfo.isOpenPubNetAccess = true; },
    f => { f.inventory.detail.dbClusterId = 'other'; }, f => { f.inventory.accounts.clusterStatus = 'pause'; },
    f => { const env = JSON.parse(f.inventory.baseConfig.envParams); env.XPAY_MESSAGE_TOKEN = 'changed'; f.inventory.baseConfig.envParams = JSON.stringify(env); },
  ]) {
    const f = fixture(); change(f);
    const result = await main({ ...f.options, action: 'deploy' });
    assert.equal(result.ok, false); assert.equal(f.state.pending, null); assert.deepEqual(f.state.writes, []);
  }
});

test('successful submission saves immutable before-config, preserves scale/access and closes purchases without claiming health', async () => {
  const f = fixture(), result = await main({ ...f.options, action: 'deploy' });
  assert.equal(result.ok, true); assert.equal(result.submitted, true); assert.equal(result.releaseTaskId, 101);
  assert.equal(result.deploymentVerified, false); assert.equal(result.privateHealthVerified, false);
  assert.deepEqual(f.state.writes, ['configure', 'allocate', 'upload', 'release']);
  assert.equal(f.state.backup.phase, 'prepared'); assert.deepEqual(f.state.backup.before.baseConfig, f.original.baseConfig);
  assert.equal(f.state.pending.phase, 'submitted'); assert.equal(f.payment.XPAY_ENABLED, 'false');
  const actual = f.inventory.baseConfig;
  assert.deepEqual(actual.openAccessTypes, ['MINIAPP']); assert.equal(actual.publicAccess, false);
  for (const field of ['minNum', 'maxNum', 'cpu', 'mem', 'internalAccess']) assert.equal(actual[field], f.original.baseConfig[field]);
  assert.equal(f.events.indexOf('snapshot') < f.events.indexOf('configure'), true);
  assert.equal(f.events.indexOf('release_requested') < f.events.indexOf('release'), true);
  assert.equal(JSON.stringify(result).includes('fictional-'), false);
  const repeated = await main({ ...f.options, action: 'deploy' });
  assert.equal(repeated.failureCode, 'PENDING_REQUIRES_REVIEW'); assert.equal(f.state.writes.filter(v => v === 'release').length, 1);
});

test('each uncertain write keeps its requested fence and no repeated deploy issues another cloud write', async () => {
  for (const [call, phase] of [['configure', 'configure_requested'], ['allocate', 'upload_authorization_requested'],
    ['upload', 'upload_requested'], ['release', 'release_requested']]) {
    const f = fixture(); f.state.failCall = call;
    const result = await main({ ...f.options, action: 'deploy' });
    assert.equal(result.ok, false); assert.equal(f.state.pending.phase, phase);
    assert.equal(result.changedRemoteState, 'unconfirmed'); assert.equal(JSON.stringify(result).includes('fictional-'), false);
    const count = f.state.writes.length; f.state.failCall = null;
    assert.equal((await main({ ...f.options, action: 'deploy' })).failureCode, 'PENDING_REQUIRES_REVIEW');
    assert.equal(f.state.writes.length, count);
  }
});

test('a failed requested-fence persistence prevents that request, and failed acknowledgement persistence never resubmits', async () => {
  for (const [phase, forbidden] of [['configure_requested', 'configure'], ['upload_requested', 'upload'], ['release_requested', 'release']]) {
    const f = fixture(); f.state.failSavePhase = phase;
    assert.equal((await main({ ...f.options, action: 'deploy' })).ok, false); assert.equal(f.state.writes.includes(forbidden), false);
  }
  const f = fixture(); f.state.failSavePhase = 'submitted';
  assert.equal((await main({ ...f.options, action: 'deploy' })).ok, false); assert.equal(f.state.pending.phase, 'release_requested');
  f.state.failSavePhase = null;
  assert.equal((await main({ ...f.options, action: 'rollback' })).failureCode, 'PENDING_REQUIRES_REVIEW');
  assert.equal((await main({ ...f.options, action: 'deploy' })).failureCode, 'PENDING_REQUIRES_REVIEW');
  assert.equal(f.state.writes.filter(v => v === 'release').length, 1); assert.equal(f.state.writes.includes('rollback'), false);
});

test('unexpected release response is unknown rather than guessed successful', async () => {
  const f = fixture(); f.api.release = async () => ({ VersionName: 'buildtest-008', Result: 'success' });
  assert.equal((await main({ ...f.options, action: 'deploy' })).failureCode, 'RELEASE_UNCONFIRMED');
  assert.equal(f.state.pending.phase, 'release_requested');
});

test('status verifies the recorded task ID read-only and never labels private runtime or database login verified', async () => {
  const f = fixture(); await main({ ...f.options, action: 'deploy' }); f.finishRelease();
  const pending = clone(f.state.pending), writes = f.state.writes.length;
  const result = await main({ ...f.options, action: 'status' });
  assert.equal(result.controlPlaneDeploymentVerified, true); assert.equal(result.releaseTask.id, 101);
  assert.equal(result.privateHealthVerified, false); assert.equal(result.databaseLoginVerified, false);
  assert.deepEqual(f.state.pending, pending); assert.equal(f.state.writes.length, writes);
  f.tasks.get(101).envId = 'different-env';
  assert.equal((await main({ ...f.options, action: 'status' })).controlPlaneDeploymentVerified, false);
});

test('wrong active container port or failed task step cannot be reported as a verified control-plane deployment', async () => {
  for (const change of [f => { f.inventory.activeVersionPort = 8080; },
    f => { f.tasks.get(101).steps = [{ status: 'failed' }]; }]) {
    const f = fixture(); await main({ ...f.options, action: 'deploy' }); f.finishRelease(); change(f);
    assert.equal((await main({ ...f.options, action: 'status' })).controlPlaneDeploymentVerified, false);
  }
});

test('reconcile only reports observations and never archives, advances or clears an uncertain request fence', async () => {
  const clean = fixture();
  const noRecord = await main({ ...clean.options, action: 'reconcile' });
  assert.equal(noRecord.reconciliation.pendingExists, false); assert.deepEqual(clean.state.writes, []);
  for (const observedDesired of [false, true]) {
    const f = fixture(); f.state.failCall = 'configure';
    await main({ ...f.options, action: 'deploy' });
    const saved = clone(f.state.pending), writes = [...f.state.writes];
    if (observedDesired) f.inventory.baseConfig = clone(saved.desiredConfig);
    const result = await main({ ...f.options, action: 'reconcile' });
    assert.equal(result.ok, true); assert.equal(result.reconciliation.readOnly, true);
    assert.equal(result.reconciliation.beforeConfigObserved, !observedDesired);
    assert.equal(result.reconciliation.desiredConfigObserved, observedDesired);
    assert.equal(result.reconciliation.beforeVersionObserved, true);
    assert.equal(result.reconciliation.beforeVersionSetObserved, true);
    assert.equal(result.reconciliation.beforeTaskObserved, true);
    for (const key of ['automaticRetryAllowed', 'archivalAuthorized', 'observationIsFinalRequestOutcome']) {
      assert.equal(result.reconciliation[key], false);
    }
    assert.equal(result.reconciliation.pendingBlocksDeployment, true);
    assert.deepEqual(f.state.pending, saved); assert.deepEqual(f.state.writes, writes);
    assert.equal(JSON.stringify(result).includes('fictional-'), false);
  }
});

test('rollback follows its exact task, restores the previous config only after completion, and cannot repeat rollback', async () => {
  const f = fixture(); await main({ ...f.options, action: 'deploy' });
  assert.equal((await main({ ...f.options, action: 'rollback' })).failureCode, 'TASK_NOT_FINISHED');
  f.finishRelease(); const submitted = await main({ ...f.options, action: 'rollback' });
  assert.equal(submitted.rollbackSubmitted, true); assert.equal(f.state.pending.phase, 'rollback_submitted');
  assert.equal((await main({ ...f.options, action: 'rollback' })).failureCode, 'TASK_NOT_FINISHED');
  assert.equal(f.state.writes.filter(v => v === 'rollback').length, 1);
  f.finishRollback();
  assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackComplete, true);
  assert.deepEqual(f.inventory.baseConfig, f.original.baseConfig); assert.equal(f.state.pending.phase, 'rolled_back');
  const count = f.state.writes.length;
  assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackComplete, true); assert.equal(f.state.writes.length, count);
});

test('rollback timeout is fenced even if provider already switched back', async () => {
  const f = fixture(); await main({ ...f.options, action: 'deploy' }); f.finishRelease(); f.state.failCall = 'rollback';
  assert.equal((await main({ ...f.options, action: 'rollback' })).ok, false);
  assert.equal(f.state.pending.phase, 'rollback_requested'); f.state.failCall = null;
  f.inventory.versions[0].FlowRatio = 100; f.inventory.versions[1].FlowRatio = 0;
  assert.equal((await main({ ...f.options, action: 'rollback' })).failureCode, 'PENDING_REQUIRES_REVIEW');
  assert.equal(f.state.writes.filter(v => v === 'rollback').length, 1);
});

test('uncertain configuration restore can be confirmed from observed state without repeating the mutation', async () => {
  const f = fixture(); await main({ ...f.options, action: 'deploy' }); f.finishRelease();
  await main({ ...f.options, action: 'rollback' }); f.finishRollback(); f.state.failSavePhase = 'rolled_back';
  assert.equal((await main({ ...f.options, action: 'rollback' })).ok, false);
  assert.equal(f.state.pending.phase, 'restore_requested'); assert.deepEqual(f.inventory.baseConfig, f.original.baseConfig);
  const writes = f.state.writes.length; f.state.failSavePhase = null;
  assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackComplete, true); assert.equal(f.state.writes.length, writes);
});

test('confirmed failed release with old version still serving restores config without an old-to-old rollback', async () => {
  for (const status of ['failed', 'finished']) {
    const f = fixture(); await main({ ...f.options, action: 'deploy' });
    f.inventory.task.status = status; f.inventory.task.steps = [{ status: 'failed' }];
    f.inventory.versions[1].Status = 'build_failed';
    const result = await main({ ...f.options, action: 'rollback' });
    assert.equal(result.rollbackComplete, true); assert.equal(f.state.writes.includes('rollback'), false);
    assert.deepEqual(f.inventory.baseConfig, f.original.baseConfig);
  }
});

test('task identity or latest-task drift cannot trigger a rollback, and completed local state is rechecked live', async () => {
  for (const change of [f => { f.inventory.task = { ...f.inventory.task, id: 999 }; },
    f => { f.tasks.get(101).envId = 'other'; }, f => { f.inventory.baseConfig.internalAccess = 'changed-network-policy'; }]) {
    const f = fixture(); await main({ ...f.options, action: 'deploy' }); f.finishRelease(); change(f);
    assert.equal((await main({ ...f.options, action: 'rollback' })).ok, false); assert.equal(f.state.writes.includes('rollback'), false);
  }
  const f = fixture(); await main({ ...f.options, action: 'deploy' }); f.finishRelease();
  await main({ ...f.options, action: 'rollback' }); f.finishRollback(); await main({ ...f.options, action: 'rollback' });
  f.inventory.baseConfig.maxNum = 2;
  assert.equal((await main({ ...f.options, action: 'rollback' })).failureCode, 'RESTORE_UNCONFIRMED');
});

test('state tampering and a held operation lock stop all remote writes', async () => {
  const f = fixture(); await main({ ...f.options, action: 'deploy' });
  f.state.pending.before.baseConfig.maxNum = 99;
  assert.equal((await main({ ...f.options, action: 'rollback' })).failureCode, 'PENDING_INVALID');
  const g = fixture(); g.state.locked = true;
  assert.equal((await main({ ...g.options, action: 'deploy' })).failureCode, 'OPERATION_LOCKED'); assert.deepEqual(g.state.writes, []);
});

test('public verification accepts only two denied responses from the provider-reported fixed service domain', async () => {
  const f = fixture(), calls = [];
  const denied = async (url, options) => { calls.push([String(url), options]); return new Response('denied', { status: 403 }); };
  assert.equal((await verifyPublicClosed(f.inventory, denied)).length, 2);
  assert.equal(calls[0][1].redirect, 'error'); assert.equal(calls[1][1].method, 'POST');
  for (const domain of ['http://buildtest-x.sh.run.tcloudbase.com', 'https://evil.example', 'https://127.0.0.1',
    'https://buildtest-x.sh.run.tcloudbase.com@evil.example', 'https://buildtest-x.sh.run.tcloudbase.com/?token=REDACTED_SECRET {
    await assert.rejects(verifyPublicClosed({ ...f.inventory, publicDomain: domain }, () => assert.fail('must not fetch')), /PUBLIC_ACCESS_UNCONFIRMED/);
  }
  await assert.rejects(verifyPublicClosed(f.inventory, async () => new Response('wrong public content', { status: 200 })), /PUBLIC_ACCESS_UNCONFIRMED/);
});

function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sandbox-deploy-test-'));
  t.after(() => {
    const absolute = path.resolve(root), base = path.resolve(os.tmpdir());
    if (path.dirname(absolute) !== base || !path.basename(absolute).startsWith('mini-sandbox-deploy-test-')) throw new Error('unsafe test cleanup');
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return root;
}
function fixtureBundle(root) {
  const files = bundlePaths.map(name => {
    const bytes = Buffer.from(`fictional package file ${name}\n`), filename = path.join(root, name);
    fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, bytes);
    return { path: name, bytes: bytes.length, sha256: digest(bytes) };
  });
  const manifest = JSON.stringify({ version: 2, scope: 'sandbox-only', env: 1,
    productionPaymentsEnabled: false, sandboxMayCharge: true, files });
  fs.writeFileSync(path.join(root, 'manifest.json'), manifest);
  return { manifest, files };
}
function unzipContents(bytes) {
  const end = bytes.length - 22; assert.equal(bytes.readUInt32LE(end), 0x06054b50);
  const count = bytes.readUInt16LE(end + 10); let cursor = bytes.readUInt32LE(end + 16); const entries = new Map();
  for (let i = 0; i < count; i++) {
    assert.equal(bytes.readUInt32LE(cursor), 0x02014b50);
    const method = bytes.readUInt16LE(cursor + 10), size = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), commentLength = bytes.readUInt16LE(cursor + 32);
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    const local = bytes.readUInt32LE(cursor + 42), start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const compressed = bytes.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : compressed);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test('real ZIP contains only reviewed in-memory bytes even when candidate also contains env and node_modules', async t => {
  const root = temporary(t), { manifest } = fixtureBundle(root);
  fs.mkdirSync(path.join(root, 'node_modules')); fs.writeFileSync(path.join(root, 'node_modules/private.js'), 'excluded');
  fs.writeFileSync(path.join(root, '.env'), 'EXCLUDED_SECRET=fictional-secret');
  const bundle = readBundle(root, digest(manifest));
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'changed after inspection');
  const archive = unzipContents(await packageBundle(bundle));
  assert.deepEqual([...archive.keys()].sort(), [...bundlePaths, 'manifest.json'].sort());
  for (const entry of bundle.entries) assert.deepEqual(archive.get(entry.name), entry.bytes);
  assert.equal([...archive.values()].some(bytes => bytes.includes('EXCLUDED_SECRET')), false);
});

test('tampered bytes, wrong pinned hash, extra manifest files and duplicated names fail closed', t => {
  const root = temporary(t); let built = fixtureBundle(root);
  assert.throws(() => readBundle(root, '0'.repeat(64)), /BUNDLE_HASH_MISMATCH/);
  fs.writeFileSync(path.join(root, 'Dockerfile'), 'tampered'); assert.throws(() => readBundle(root), /BUNDLE_INVALID/);
  for (const paths of [[...bundlePaths, '.env'], [...bundlePaths.slice(1), bundlePaths[1]], ['../outside', ...bundlePaths.slice(1)]]) {
    built = fixtureBundle(root); const parsed = JSON.parse(built.manifest);
    parsed.files = paths.map(name => ({ path: name, bytes: 0, sha256: '0'.repeat(64) }));
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(parsed));
    assert.throws(() => readBundle(root), /BUNDLE_INVALID/);
  }
});

test('candidate manifest strictly distinguishes env1 from fictitious funds and rejects legacy declarations even with a pinned hash', t => {
  const root = temporary(t), { manifest, files } = fixtureBundle(root), valid = JSON.parse(manifest);
  const invalid = [
    { scope: 'sandbox-only', realMoneyAllowed: false, files },
    { ...valid, realMoneyAllowed: false }, { ...valid, realMoneyAllowed: true },
    { ...valid, version: 1 }, { ...valid, version: '2' },
    { ...valid, scope: 'production' }, { ...valid, env: 0 }, { ...valid, env: '1' },
    { ...valid, productionPaymentsEnabled: true }, { ...valid, productionPaymentsEnabled: 'false' },
    { ...valid, sandboxMayCharge: false }, { ...valid, sandboxMayCharge: 'true' },
    { ...valid, unreviewed: true },
    ...['version', 'env', 'productionPaymentsEnabled', 'sandboxMayCharge'].map(key => {
      const missing = { ...valid }; delete missing[key]; return missing;
    }),
  ];
  for (const candidate of invalid) {
    const bytes = JSON.stringify(candidate);
    fs.writeFileSync(path.join(root, 'manifest.json'), bytes);
    assert.throws(() => readBundle(root, digest(bytes)), /BUNDLE_INVALID/);
  }
  fs.writeFileSync(path.join(root, 'manifest.json'), manifest);
  assert.equal(readBundle(root, digest(manifest)).manifestHash, digest(manifest));
});

test('private journal persists original snapshot separately, uses exclusive lock and never overwrites local payment env', async t => {
  const root = temporary(t);
  execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe', windowsHide: true });
  fs.writeFileSync(path.join(root, '.gitignore'), '.env*\n');
  fs.writeFileSync(path.join(root, '.env.mini-payment'), 'XPAY_ENABLED=false\n');
  fs.writeFileSync(path.join(root, '.env.mini-cloud'), 'WXCLOUD_APP_ID=fictional\n');
  const f = fixture(); await main({ ...f.options, action: 'deploy' });
  const files = privateFiles(root); files.createPending(f.state.backup);
  assert.deepEqual(files.readPending(), f.state.backup);
  files.updatePending(f.state.pending, f.state.backup); assert.deepEqual(files.readPending(), f.state.pending);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.env.mini-sandbox-deploy.backup.json'))).phase, 'prepared');
  await files.withLock(async () => { await assert.rejects(files.withLock(async () => {}), /OPERATION_LOCKED/); });
  assert.equal(fs.existsSync(path.join(root, '.env.mini-sandbox-deploy.lock')), false);
  assert.equal(fs.readFileSync(path.join(root, '.env.mini-payment'), 'utf8'), 'XPAY_ENABLED=false\n');
});

test('SDK console, stdout, stderr and thrown details stay suppressed while output streams restore normally', () => {
  const moduleUrl = new URL('../scripts/deploy-mini-sandbox-cloud.mjs', import.meta.url).href;
  const code = `const {silenceSdk}=await import(${JSON.stringify(moduleUrl)}); await silenceSdk(async()=>{console.log('fictional-secret');console.error('fictional-secret');process.stdout.write('fictional-secret');process.stderr.write('fictional-secret');}); console.log('restored');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true }).trim(), 'restored');
});

test('an early SDK rejection cannot restore logging before delayed sibling requests have settled', () => {
  const moduleUrl = new URL('../scripts/deploy-mini-sandbox-cloud.mjs', import.meta.url).href;
  const code = `const {silenceSdk,settleSdkCalls}=await import(${JSON.stringify(moduleUrl)}); try { await silenceSdk(()=>settleSdkCalls([()=>Promise.reject(new Error('fictional-early-secret')),async()=>{await new Promise(r=>setTimeout(r,20));console.log('fictional-late-secret');process.stderr.write('fictional-late-secret');throw Error('fictional-late-secret');}])); }catch(e){console.log(e.message);} console.log('restored');`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', windowsHide: true }).trim(), 'CLOUD_SCOPE_UNCONFIRMED\nrestored');
});

const versionScope = { EnvId: target.cloudEnvId, ServerName: target.serviceName };
const inventoryVersions = count => Array.from({ length: count }, (_, i) => ({
  VersionName: `buildtest-${String(i + 1).padStart(3, '0')}`,
  Status: i < 4 ? 'build_failed' : i === 4 ? 'deploy_failed' : 'normal',
  FlowRatio: i === count - 1 ? 100 : 0,
}));
const versionPage = (items, total) => ({ ServerName: target.serviceName, TotalCount: total, VersionItems: items });

test('official version pagination reads beyond the ten-item 002..011 page and proves the complete count', async () => {
  const versions = inventoryVersions(11).reverse(), requests = [];
  const actual = await readAllCloudVersions(async request => {
    requests.push(clone(request));
    return versionPage(versions.slice(request.Offset, request.Offset + request.Limit), versions.length);
  }, versionScope);
  assert.deepEqual(actual, { versions, totalCount: 11 });
  assert.deepEqual(requests, [0, 10].map(Offset => ({ ...versionScope, Limit: 10, Offset })));
  assert.deepEqual(actual.versions.slice(0, 10).map(v => v.VersionName).sort(),
    Array.from({ length: 10 }, (_, i) => `buildtest-${String(i + 2).padStart(3, '0')}`));
  const capped = [];
  assert.deepEqual(await readAllCloudVersions(async request => {
    capped.push(request.Offset);
    return versionPage(versions.slice(request.Offset, request.Offset + 3), versions.length);
  }, versionScope), { versions, totalCount: 11 });
  assert.deepEqual(capped, [0, 3, 6, 9]);
  let completeCalls = 0;
  const retained = versions.slice(0, 10);
  assert.deepEqual(await readAllCloudVersions(async () => {
    completeCalls++; return versionPage(retained, 10); // Real proxy ignores Offset; no extra request needed.
  }, versionScope), { versions: retained, totalCount: 10 });
  assert.equal(completeCalls, 1);
});

test('version pagination rejects missing, drifting, repeated, unbounded and malformed inventory evidence', async () => {
  const versions = inventoryVersions(11).reverse();
  const valid = [versionPage(versions.slice(0, 10), 11), versionPage(versions.slice(10), 11), versionPage([], 11)];
  const changes = [
    pages => { pages[0].TotalCount = undefined; }, pages => { pages[0].TotalCount = null; },
    pages => { pages[0].TotalCount = '11'; }, pages => { pages[0].TotalCount = -1; },
    pages => { pages[0].TotalCount = 101; }, pages => { pages[0].TotalCount = 10.5; },
    pages => { pages[0].VersionItems = null; }, pages => { pages[0].VersionItems.push(versions[10]); },
    pages => { pages[0].ServerName = 'other-service'; }, pages => { pages[0].VersionItems[0].VersionName = 'unrelated-011'; },
    pages => { pages[0].VersionItems[1] = pages[0].VersionItems[0]; },
    pages => { pages[1].VersionItems = [versions[0]]; }, pages => { pages[1].TotalCount = 12; },
    pages => { pages[1].VersionItems = []; }, pages => { pages[1].VersionItems.push(versions[0]); },
  ];
  for (const change of changes) {
    const pages = clone(valid); change(pages); let calls = 0;
    await assert.rejects(readAllCloudVersions(async () => pages[calls++], versionScope), /CLOUD_SCOPE_UNCONFIRMED/);
    assert.ok(calls <= 3);
  }
  let calls = 0;
  await assert.rejects(readAllCloudVersions(async () => {
    if (calls++) throw new Error('fictional second-page transport failure');
    return valid[0];
  }, versionScope), /second-page transport failure/);
  assert.equal(calls, 2);
  assert.deepEqual(await readAllCloudVersions(async () => versionPage([], 0), versionScope), { versions: [], totalCount: 0 });
});

test('CLI defaults to status and rejects unexpected, duplicate or missing options', () => {
  assert.deepEqual(parseArguments([]), { action: 'status' });
  assert.deepEqual(parseArguments(['reconcile']), { action: 'reconcile' });
  assert.deepEqual(parseArguments(['plan', '--bundle', 'C:/fictional']), { action: 'plan', bundleDirectory: 'C:/fictional' });
  for (const args of [['--apply'], ['deploy'], ['status', '--bundle', 'x'], ['rollback', '--force', 'true'],
    ['plan', '--bundle', 'x', '--bundle', 'y'], ['plan', '--bundle']]) assert.throws(() => parseArguments(args), /ARGUMENT_INVALID/);
});

async function upgradeFixture(historicalVersions = []) {
  const f = fixture(historicalVersions);
  f.options.operationId = () => upgradeSource.operationId; f.state.nextReleaseTaskId = upgradeSource.releaseTaskId;
  assert.equal((await main({ ...f.options, action: 'deploy' })).submitted, true); f.finishRelease();
  f.options.expectedVersion = upgradeSource.version; f.options.manifestSha256 = 'b'.repeat(64);
  f.options.loadBundle = () => ({ manifestHash: 'b'.repeat(64), entries: bundlePaths.map(name => ({ name, bytes: Buffer.from('fictional-upgrade') })) });
  f.options.operationId = () => '0123456789abcdef01234567';
  f.state.nextReleaseTaskId = 103; f.state.nextReleaseVersion = 'buildtest-009';
  f.state.writes.length = 0; f.events.length = 0;
  return f;
}

async function nextFixture(profile = 'closed', historicalVersions = []) {
  const f = await upgradeFixture(historicalVersions);
  f.options.manifestSha256 = nextSourceManifest;
  f.options.loadBundle = () => ({ manifestHash: nextSourceManifest, entries: bundlePaths.map(name => ({ name, bytes: Buffer.from('fictional-source-009') })) });
  f.options.operationId = () => nextUpgradeSource.operationId;
  f.state.nextReleaseTaskId = nextUpgradeSource.releaseTaskId;
  assert.equal((await main({ ...f.options, action: 'upgrade' })).submitted, true); f.finishRelease();
  f.options.expectedVersion = nextUpgradeSource.version; f.options.manifestSha256 = 'c'.repeat(64);
  f.options.loadBundle = () => ({ manifestHash: 'c'.repeat(64), entries: bundlePaths.map(name => ({ name, bytes: Buffer.from('fictional-next') })) });
  f.options.operationId = () => 'bcdef0123456789abcdef012'; f.options.profile = profile;
  f.payment.XPAY_TEST_USER_IDS = 'usr_11111111-1111-4111-8111-111111111111';
  f.state.nextReleaseTaskId = 104; f.state.nextReleaseVersion = 'buildtest-010';
  f.state.writes.length = 0; f.events.length = 0;
  return f;
}

async function repairFixture(historicalVersions = []) {
  const f = await nextFixture('sandbox-ledger', historicalVersions);
  f.options.operationId = () => repairSource.operationId;
  f.options.manifestSha256 = repairSourceManifest;
  f.options.loadBundle = () => ({ manifestHash: repairSourceManifest,
    entries: bundlePaths.map(name => ({ name, bytes: Buffer.from('fictional-source-010') })) });
  f.state.nextReleaseTaskId = repairSource.releaseTaskId;
  assert.equal((await main({ ...f.options, action: 'deploy-next' })).submitted, true); f.finishRelease();
  delete f.options.profile;
  f.options.expectedVersion = repairSource.version; f.options.manifestSha256 = 'd'.repeat(64);
  f.options.loadBundle = () => ({ manifestHash: 'd'.repeat(64),
    entries: bundlePaths.map(name => ({ name, bytes: Buffer.from('fictional-safety-repair') })) });
  f.options.operationId = () => 'cdef0123456789abcdef0123';
  f.state.nextReleaseTaskId = 105; f.state.nextReleaseVersion = 'buildtest-011';
  f.state.writes.length = 0; f.events.length = 0;
  return f;
}

async function acceptanceFixture(closing = false, historicalVersions = []) {
  const f = await repairFixture(historicalVersions);
  f.options.operationId = () => resumeSource.operationId;
  f.options.manifestSha256 = resumeSourceManifest;
  f.options.loadBundle = () => ({ manifestHash: resumeSourceManifest,
    entries: bundlePaths.map(name => ({ name, bytes: Buffer.from('fictional-source-011') })) });
  f.state.nextReleaseTaskId = resumeSource.releaseTaskId;
  assert.equal((await main({ ...f.options, action: 'deploy-repair' })).submitted, true); f.finishRelease();
  f.options.expectedVersion = resumeSource.version; f.options.manifestSha256 = 'e'.repeat(64);
  f.options.loadBundle = () => ({ manifestHash: 'e'.repeat(64),
    entries: bundlePaths.map(name => ({ name, bytes: Buffer.from('fictional-reviewed-acceptance') })) });
  f.options.operationId = () => 'def0123456789abcdef01234';
  f.state.nextReleaseTaskId = 106; f.state.nextReleaseVersion = 'buildtest-012';
  if (closing) {
    assert.equal((await main({ ...f.options, action: 'deploy-resume' })).submitted, true); f.finishRelease();
    f.options.expectedVersion = 'buildtest-012';
    f.options.operationId = () => 'ef0123456789abcdef012345';
    f.state.nextReleaseTaskId = 107; f.state.nextReleaseVersion = 'buildtest-013';
  }
  f.state.writes.length = 0; f.events.length = 0;
  return f;
}

test('real 002..011 retained inventory permits only official oldest inactive eviction and preserves later close', async () => {
  const history = inventoryVersions(7).slice(0, 6), f = await acceptanceFixture(false, history);
  const complete = clone(f.inventory.versions).reverse();
  assert.deepEqual(complete.map(v => v.VersionName).sort(), inventoryVersions(11).map(v => v.VersionName));
  f.inventory.versions = complete.slice(0, 10);
  const truncated = await main({ ...f.options, action: 'plan-resume' });
  assert.equal(truncated.planReady, false); assert.equal(truncated.checks.exactVersionSet, false);
  const recoveredList = await readAllCloudVersions(async request =>
    versionPage(complete.slice(request.Offset, request.Offset + request.Limit), complete.length), versionScope);
  f.inventory.versions = recoveredList.versions;
  const recovered = await main({ ...f.options, action: 'plan-resume' });
  assert.equal(recovered.planReady, true); assert.equal(recovered.checks.exactVersionSet, true);
  // The complete count permits the documented oldest inactive eviction only.
  const missing = complete.filter(v => v.VersionName !== 'buildtest-001');
  const retainedList = await readAllCloudVersions(async request =>
    versionPage(missing.slice(request.Offset, request.Offset + request.Limit), missing.length), versionScope);
  f.inventory.versions = retainedList.versions;
  f.inventory.versionsComplete = true; f.inventory.versionTotalCount = retainedList.totalCount;
  assert.equal((await main({ ...f.options, action: 'plan-resume' })).planReady, true);
  assert.deepEqual(f.state.writes, []); assert.equal(f.state.pending.releaseTaskId, resumeSource.releaseTaskId);
  for (const versions of [complete.filter(v => v.VersionName !== 'buildtest-005'),
    complete.filter(v => v.VersionName !== 'buildtest-010'), missing.slice(1),
    [...missing.slice(1), { VersionName: 'buildtest-099', Status: 'normal', FlowRatio: 0 }],
    [...missing.slice(1), missing[1]]]) {
    f.inventory.versions = clone(versions);
    assert.equal((await main({ ...f.options, action: 'plan-resume' })).planReady, false);
  }
  f.inventory.versions = missing;
  assert.equal((await main({ ...f.options, action: 'deploy-resume' })).submitted, true); f.finishRelease();
  f.inventory.versions = f.inventory.versions.filter(v => v.VersionName !== 'buildtest-002');
  f.options.expectedVersion = 'buildtest-012';
  assert.equal((await main({ ...f.options, action: 'plan-close' })).planReady, true);
});

test('fixed 011 resume and exact acceptance close change only mode and preserve one test user, catalog and reconciliation', async () => {
  for (const closing of [false, true]) {
    const f = await acceptanceFixture(closing), previous = clone(f.state.pending), before = clone(f.state), local = clone(f.payment);
    const action = closing ? 'close' : 'resume', profile = closing ? closeProfile : resumeProfile;
    const plan = await main({ ...f.options, action: `plan-${action}` });
    assert.equal(plan.planReady, true); assert.equal(plan.profile, profile);
    assert.equal(plan.sandboxPurchasesPlanned, !closing); assert.equal(plan.sandboxMayCharge, true);
    assert.equal(plan.testUserCount, 1); assert.equal(plan.rollbackKeepsPurchasesClosed, true);
    assert.deepEqual(plan.environmentChangedKeys, ['XPAY_MODE']);
    assert.deepEqual(plan.catalog, [{ id: 'photo10', amountFen: 990, photoCredits: 10, days: 365 }]);
    assert.equal(JSON.stringify(plan).includes(f.payment.XPAY_TEST_USER_IDS), false);
    assert.deepEqual(f.state.pending, before.pending); assert.deepEqual(f.state.backup, before.backup);
    assert.deepEqual(f.state.archives, before.archives); assert.deepEqual(f.state.writes, []); assert.deepEqual(f.payment, local);
    if (closing) {
      assert.deepEqual(plan.reviewedSource, { operationId: previous.operationId, releaseTaskId: previous.releaseTaskId,
        version: 'buildtest-012', manifestSha256: previous.manifestSha256 });
      assert.equal(plan.manifestSha256, previous.manifestSha256); // Reuse the same strictly checked v2 code.
    } else assert.deepEqual(plan.reviewedSource, resumeSource);
    const deployed = await main({ ...f.options, action: `deploy-${action}` });
    assert.equal(deployed.submitted, true);
    assert.deepEqual(f.state.pending.variables, { ...previous.variables, XPAY_MODE: closing ? 'closed' : 'sandbox' });
    assert.deepEqual(f.state.archives.at(-1).pending, previous);
    assert.deepEqual(f.state.writes, ['configure', 'allocate', 'upload', 'release']);
    assert.equal(f.events.indexOf('archive') < f.events.indexOf('configure_requested'), true);
    f.finishRelease();
    assert.equal((await main({ ...f.options, action: 'status' })).controlPlaneDeploymentVerified, true);
    const writes = [...f.state.writes], archives = f.state.archives.length;
    assert.equal((await main({ ...f.options, action: `deploy-${action}` })).ok, false);
    assert.deepEqual(f.state.writes, writes); assert.equal(f.state.archives.length, archives);
    assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackSubmitted, true); f.finishRollback();
    assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackComplete, true);
    assert.deepEqual(JSON.parse(f.inventory.baseConfig.envParams), { ...previous.variables, XPAY_MODE: 'closed' });
    const settledWrites = [...f.state.writes];
    assert.equal((await main({ ...f.options, action: 'rollback' })).noMutation, true);
    assert.deepEqual(f.state.writes, settledWrites);
  }
});

test('acceptance modes reject any extra env delta, multiple testers, changed price and production environment', async () => {
  const f = await acceptanceFixture(), base = f.state.pending.variables;
  for (const profile of [resumeProfile, closeProfile]) {
    const before = { ...base, XPAY_MODE: profile === resumeProfile ? 'closed' : 'sandbox' };
    const expected = acceptanceEnvironment(before, profile);
    assert.equal(acceptanceEnvironmentMatches(before, expected, profile), true);
    for (const key of Object.keys(before).filter(key => key !== 'XPAY_MODE')) {
      assert.equal(acceptanceEnvironmentMatches(before, { ...expected, [key]: 'tampered' }, profile), false);
    }
    assert.equal(acceptanceEnvironmentMatches(before, { ...expected, XPAY_APP_KEY: 'forbidden' }, profile), false);
    for (const bad of [{ XPAY_ENV: '0' }, { XPAY_ENABLED: 'false' }, { XPAY_RECONCILE_ENABLED: 'false' },
      { XPAY_TEST_USER_IDS: '' }, { XPAY_TEST_USER_IDS: before.XPAY_TEST_USER_IDS + ',usr_22222222-2222-4222-8222-222222222222' },
      { XPAY_PRODUCTS_JSON: before.XPAY_PRODUCTS_JSON.replaceAll('990', '1') }, { XPAY_PRODUCTS_JSON: '[]' },
      { XPAY_PURPOSE_RULES_JSON: '{"all":true}' }]) {
      assert.throws(() => acceptanceEnvironment({ ...before, ...bad }, profile), /LOCAL_CONFIGURATION_INVALID/);
    }
  }
});

test('resume and close refuse source, secrets, task, versions and live configuration drift before archive or writes', async () => {
  for (const closing of [false, true]) for (const change of [
    f => { f.state.pending.phase = 'release_requested'; },
    f => { f.state.pending.upgradeFrom = upgradeSource; },
    f => { f.inventory.task.status = 'running'; },
    f => { f.inventory.task.steps = [{ status: 'failed' }]; },
    f => { f.inventory.task = { ...f.inventory.task, id: 999 }; },
    f => { f.inventory.versions.at(-1).Remark = 'unexpected'; },
    f => { f.inventory.versions.push({ VersionName: 'buildtest-099', FlowRatio: 0, Status: 'normal' }); },
    f => { f.inventory.baseConfig.envParams = JSON.stringify({ ...JSON.parse(f.inventory.baseConfig.envParams), XPAY_MODE: 'closed' });
      if (!closing) f.inventory.baseConfig.envParams = JSON.stringify({ ...JSON.parse(f.inventory.baseConfig.envParams), XPAY_MODE: 'sandbox' }); },
    f => { f.inventory.baseConfig.envParams = JSON.stringify({ ...JSON.parse(f.inventory.baseConfig.envParams), XPAY_RECONCILE_ENABLED: 'false' }); },
    f => { f.payment.WECHAT_APP_SECRET = 'fictional-changed-secret'; },
    f => { f.inventory.baseConfig.maxNum = 2; },
    f => { f.inventory.detail.dbInfo.isOpenPubNetAccess = true; },
    f => { f.options.expectedVersion = 'buildtest-099'; },
    f => { f.options.fetchImpl = async () => new Response('unexpected', { status: 200 }); },
  ]) {
    const f = await acceptanceFixture(closing); change(f);
    const before = clone(f.state.pending), archives = f.state.archives.length;
    for (const verb of ['plan', 'deploy']) {
      const result = await main({ ...f.options, action: `${verb}-${closing ? 'close' : 'resume'}` });
      assert.notEqual(result.planReady, true); assert.notEqual(result.submitted, true);
      assert.deepEqual(f.state.writes, []); assert.equal(f.state.archives.length, archives); assert.deepEqual(f.state.pending, before);
    }
  }
  const f = await acceptanceFixture(); f.state.pending.manifestSha256 = 'f'.repeat(64);
  assert.equal((await main({ ...f.options, action: 'deploy-resume' })).failureCode, 'UPGRADE_SOURCE_UNCONFIRMED');
  assert.deepEqual(f.state.writes, []);
  for (const closing of [false, true]) {
    const wrongBundle = await acceptanceFixture(closing);
    const manifestHash = closing ? 'f'.repeat(64) : resumeSourceManifest;
    wrongBundle.options.manifestSha256 = manifestHash;
    wrongBundle.options.loadBundle = () => ({ manifestHash, entries: [] });
    const result = await main({ ...wrongBundle.options, action: closing ? 'deploy-close' : 'deploy-resume' });
    assert.equal(result.failureCode, 'UPGRADE_SOURCE_UNCONFIRMED'); assert.deepEqual(wrongBundle.state.writes, []);
  }
  for (const make of [() => nextFixture('sandbox-ledger'), () => repairFixture(), () => acceptanceFixture()]) {
    const unrelated = await make();
    assert.equal((await main({ ...unrelated.options, profile: undefined, expectedVersion: 'buildtest-012', action: 'deploy-close' })).ok, false);
    assert.deepEqual(unrelated.state.writes, []);
  }
});

test('acceptance unknown writes cannot repeat and post-package drift aborts before archival', async () => {
  for (const closing of [false, true]) {
    const action = closing ? 'deploy-close' : 'deploy-resume';
    for (const [call, phase] of [['configure', 'configure_requested'], ['allocate', 'upload_authorization_requested'],
      ['upload', 'upload_requested'], ['release', 'release_requested']]) {
      const f = await acceptanceFixture(closing); f.state.failCall = call;
      assert.equal((await main({ ...f.options, action })).ok, false); assert.equal(f.state.pending.phase, phase);
      const before = clone(f.state.pending), writes = [...f.state.writes], archives = f.state.archives.length;
      f.state.failCall = null;
      assert.equal((await main({ ...f.options, action })).ok, false);
      assert.deepEqual(f.state.pending, before); assert.deepEqual(f.state.writes, writes); assert.equal(f.state.archives.length, archives);
    }
    const f = await acceptanceFixture(closing), archives = f.state.archives.length;
    f.options.zip = async () => { f.inventory.task = { ...f.inventory.task, id: 999 }; return Buffer.from('fictional'); };
    assert.equal((await main({ ...f.options, action })).failureCode, 'UPGRADE_SOURCE_UNCONFIRMED');
    assert.deepEqual(f.state.writes, []); assert.equal(f.state.archives.length, archives);
  }
  for (const action of ['plan-resume', 'deploy-resume', 'plan-close', 'deploy-close']) {
    assert.equal(parseArguments([action, '--bundle', 'candidate']).action, action);
    assert.throws(() => parseArguments([action, '--bundle', 'candidate', '--profile', 'sandbox-ledger']), /ARGUMENT_INVALID/);
    assert.throws(() => parseArguments([action]), /ARGUMENT_INVALID/);
  }
});

test('resume and close private archives preserve their exact predecessor and fence every interrupted rotation', async t => {
  for (const closing of [false, true]) {
    const f = await acceptanceFixture(closing), previous = clone(f.state.pending), backup = clone(f.state.backup);
    assert.equal((await main({ ...f.options, action: closing ? 'deploy-close' : 'deploy-resume' })).submitted, true);
    const next = clone(f.state.backup), evidence = clone(f.state.archives.at(-1).evidence);
    for (const interrupted of [null, 'intent', 'archive', 'backup', 'pending', 'verified']) {
      const root = temporary(t);
      execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe', windowsHide: true });
      fs.writeFileSync(path.join(root, '.gitignore'), '.env*\n');
      const files = privateFiles(root, { afterArchiveStep: step => { if (step === interrupted) throw new Error('fictional crash'); } });
      files.createPending(backup); files.updatePending(previous, backup);
      const rotate = () => files.archiveConfirmedPending(next, previous, evidence);
      if (interrupted) {
        assert.throws(rotate, /fictional crash/);
        assert.throws(() => files.readPending(), /ARCHIVE_REQUIRES_REVIEW/);
        assert.throws(rotate, /ARCHIVE_REQUIRES_REVIEW/);
      } else {
        const tampered = clone(next); tampered.variables.XPAY_RECONCILE_ENABLED = 'false';
        tampered.desiredConfig.envParams = JSON.stringify(tampered.variables);
        assert.throws(() => files.archiveConfirmedPending(tampered, previous, evidence), /PENDING_INVALID/);
        rotate(); assert.deepEqual(files.readPending(), next);
        assert.throws(rotate, /UPGRADE_SOURCE_UNCONFIRMED/);
      }
      if (interrupted !== 'intent') {
        const archive = JSON.parse(fs.readFileSync(path.join(root, `.env.mini-sandbox-deploy.confirmed-${previous.operationId}.json`)));
        assert.deepEqual(archive.previousPending, previous); assert.deepEqual(archive.previousBackup, backup);
        assert.deepEqual(archive.evidence, evidence);
      }
    }
  }
});

test('fixed 010 safety repair changes only purchase mode, retains old source evidence and cannot replay 009 or 010 upgrades', async () => {
  const f = await repairFixture(), previous = clone(f.state.pending), local = clone(f.payment);
  const plan = await main({ ...f.options, action: 'plan-repair' });
  assert.equal(plan.planReady, true); assert.equal(plan.profile, repairProfile);
  assert.deepEqual(plan.reviewedSource, repairSource); assert.deepEqual(plan.environmentChangedKeys, ['XPAY_MODE']);
  assert.equal(plan.rollbackKeepsPurchasesClosed, true); assert.equal(plan.sandboxPurchasesPlanned, false);
  assert.equal(plan.sandboxMayCharge, true); assert.equal(plan.productionPaymentsEnabled, false);
  assert.equal(plan.testUserCount, 1); assert.equal(JSON.stringify(plan).includes(f.payment.XPAY_TEST_USER_IDS), false);
  assert.deepEqual(f.state.writes, []); assert.deepEqual(f.state.pending, previous); assert.deepEqual(f.payment, local);
  assert.equal((await main({ ...f.options, action: 'deploy-repair' })).submitted, true);
  assert.deepEqual(f.state.writes, ['configure', 'allocate', 'upload', 'release']);
  assert.deepEqual(f.state.archives.at(-1).pending, previous);
  assert.deepEqual(f.state.pending.variables, { ...previous.variables, XPAY_MODE: 'closed' });
  assert.equal(f.state.pending.variables.XPAY_RECONCILE_ENABLED, 'true');
  const writes = [...f.state.writes], archives = f.state.archives.length;
  f.finishRelease();
  assert.equal((await main({ ...f.options, action: 'status' })).controlPlaneDeploymentVerified, true);
  for (const options of [{ action: 'deploy-repair' }, { action: 'plan-repair' },
    { action: 'deploy-next', profile: 'sandbox-ledger', expectedVersion: 'buildtest-009' }]) {
    const result = await main({ ...f.options, ...options });
    assert.notEqual(result.planReady, true); assert.notEqual(result.submitted, true);
  }
  assert.deepEqual(f.state.writes, writes); assert.equal(f.state.archives.length, archives);
  assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackSubmitted, true); f.finishRollback();
  assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackComplete, true);
  assert.equal(f.inventory.versions.find(v => v.FlowRatio === 100).VersionName, 'buildtest-010');
  assert.deepEqual(JSON.parse(f.inventory.baseConfig.envParams), { ...previous.variables, XPAY_MODE: 'closed' });
  assert.equal(JSON.parse(f.state.pending.before.baseConfig.envParams).XPAY_MODE, 'sandbox'); // Immutable audit evidence.
  const settledWrites = [...f.state.writes];
  assert.equal((await main({ ...f.options, action: 'rollback' })).noMutation, true);
  assert.deepEqual(f.state.writes, settledWrites);
});

test('repair rejects every extra environment change and source, task, manifest or configuration drift before writes', async () => {
  const source = (await repairFixture()).state.pending.variables, expected = repairEnvironment(source);
  assert.equal(repairEnvironmentMatches(source, expected), true);
  for (const key of Object.keys(source)) {
    if (key === 'XPAY_MODE') continue;
    assert.equal(repairEnvironmentMatches(source, { ...expected, [key]: 'tampered' }), false);
  }
  assert.equal(repairEnvironmentMatches(source, { ...expected, XPAY_APP_KEY: 'forbidden' }), false);
  for (const action of ['plan-repair', 'deploy-repair']) for (const change of [
    f => { f.state.pending.phase = 'release_requested'; },
    f => { f.state.pending.manifestSha256 = 'e'.repeat(64); },
    f => { f.state.pending.operationId = 'fedcba0123456789abcdef01'; },
    f => { f.state.pending.releaseTaskId = 999; },
    f => { f.inventory.task.steps = [{ status: 'failed' }]; },
    f => { f.inventory.task = { ...f.inventory.task, id: 999 }; },
    f => { f.inventory.versions.at(-1).Remark = 'unexpected'; },
    f => { f.inventory.baseConfig.envParams = JSON.stringify({ ...JSON.parse(f.inventory.baseConfig.envParams), XPAY_RECONCILE_ENABLED: 'false' }); },
    f => { f.payment.WECHAT_APP_SECRET = 'fictional-changed-secret'; },
    f => { f.inventory.baseConfig.maxNum = 2; },
    f => { f.inventory.detail.dbInfo.isOpenPubNetAccess = true; },
    f => { f.options.expectedVersion = 'buildtest-009'; },
    f => { f.options.loadBundle = () => ({ manifestHash: repairSourceManifest, entries: [] }); },
    f => { f.options.fetchImpl = async () => new Response('unexpected', { status: 200 }); },
  ]) {
    const f = await repairFixture(); change(f); const before = clone(f.state.pending), archives = f.state.archives.length;
    const result = await main({ ...f.options, action });
    assert.notEqual(result.planReady, true); assert.notEqual(result.submitted, true);
    assert.deepEqual(f.state.writes, []); assert.equal(f.state.archives.length, archives); assert.deepEqual(f.state.pending, before);
  }
});

test('repair unknown requests remain fenced and packaging-time drift prevents archival', async () => {
  for (const [call, phase] of [['configure', 'configure_requested'], ['allocate', 'upload_authorization_requested'],
    ['upload', 'upload_requested'], ['release', 'release_requested']]) {
    const f = await repairFixture(); f.state.failCall = call;
    assert.equal((await main({ ...f.options, action: 'deploy-repair' })).ok, false);
    assert.equal(f.state.pending.phase, phase);
    const before = clone(f.state.pending), writes = [...f.state.writes], archives = f.state.archives.length;
    f.state.failCall = null;
    assert.equal((await main({ ...f.options, action: 'deploy-repair' })).ok, false);
    assert.deepEqual(f.state.pending, before); assert.deepEqual(f.state.writes, writes); assert.equal(f.state.archives.length, archives);
  }
  const f = await repairFixture(), archives = f.state.archives.length;
  f.options.zip = async () => { f.inventory.task = { ...f.inventory.task, id: 999 }; return Buffer.from('fictional'); };
  assert.equal((await main({ ...f.options, action: 'deploy-repair' })).failureCode, 'UPGRADE_SOURCE_UNCONFIRMED');
  assert.equal(f.state.archives.length, archives); assert.deepEqual(f.state.writes, []);
  assert.equal(parseArguments(['plan-repair', '--bundle', 'candidate']).action, 'plan-repair');
  assert.throws(() => parseArguments(['deploy-repair', '--bundle', 'candidate', '--profile', 'sandbox-ledger']), /ARGUMENT_INVALID/);
});

test('real repair archival retains the exact 010 record and stops at all five interrupted rotation boundaries', async t => {
  const f = await repairFixture(), previous = clone(f.state.pending), backup = clone(f.state.backup);
  await main({ ...f.options, action: 'deploy-repair' });
  const next = clone(f.state.backup), evidence = clone(f.state.archives.at(-1).evidence);
  for (const interrupted of [null, 'intent', 'archive', 'backup', 'pending', 'verified']) {
    const root = temporary(t);
    execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe', windowsHide: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.env*\n');
    const files = privateFiles(root, { afterArchiveStep: step => { if (step === interrupted) throw new Error('fictional crash'); } });
    files.createPending(backup); files.updatePending(previous, backup);
    const rotate = () => files.archiveConfirmedPending(next, previous, evidence);
    if (interrupted) {
      assert.throws(rotate, /fictional crash/);
      assert.throws(() => files.readPending(), /ARCHIVE_REQUIRES_REVIEW/);
      assert.throws(rotate, /ARCHIVE_REQUIRES_REVIEW/);
    } else {
      const tampered = clone(next); tampered.variables.XPAY_RECONCILE_ENABLED = 'false';
      tampered.desiredConfig.envParams = JSON.stringify(tampered.variables);
      assert.throws(() => files.archiveConfirmedPending(tampered, previous, evidence), /PENDING_INVALID/);
      rotate(); assert.deepEqual(files.readPending(), next);
    }
    if (interrupted !== 'intent') {
      const archive = JSON.parse(fs.readFileSync(path.join(root, `.env.mini-sandbox-deploy.confirmed-${previous.operationId}.json`)));
      assert.deepEqual(archive.previousPending, previous); assert.deepEqual(archive.previousBackup, backup);
      assert.deepEqual(archive.evidence.source, repairSource);
    }
  }
});

test('next plans preserve the confirmed 009 journal and expose only explicit profile changes without private values', async () => {
  for (const profile of ['closed', 'sandbox-ledger']) {
    const f = await nextFixture(profile), before = clone(f.state), local = clone(f.payment);
    const report = await main({ ...f.options, action: 'plan-next' });
    assert.equal(report.planReady, true); assert.equal(report.profile, profile);
    assert.equal(report.submitted, false); assert.equal(report.changedRemoteState, false);
    assert.equal(report.platformCatalogVerified, false); assert.equal(report.realMoneyAllowed, undefined);
    assert.equal(report.env, 1); assert.equal(report.productionPaymentsEnabled, false); assert.equal(report.sandboxMayCharge, true);
    assert.equal(report.testUserCount, profile === 'sandbox-ledger' ? 1 : 0);
    assert.deepEqual(report.environmentChangedKeys, profile === 'closed' ? []
      : ['XPAY_MODE', 'XPAY_PRODUCTS_JSON', 'XPAY_RECONCILE_ENABLED', 'XPAY_TEST_USER_IDS']);
    assert.deepEqual(f.state.pending, before.pending); assert.deepEqual(f.state.backup, before.backup);
    assert.equal(f.state.archives.length, before.archives.length); assert.deepEqual(f.state.writes, []);
    assert.deepEqual(f.payment, local);
    assert.equal(JSON.stringify(report).includes(f.payment.XPAY_TEST_USER_IDS), false);
    for (const value of Object.values(f.payment).filter(v => v.startsWith('fictional-'))) assert.equal(JSON.stringify(report).includes(value), false);
  }
});

test('next deployment uses the exact confirmed 009 source and its reviewed environment delta, then supports rollback', async () => {
  for (const profile of ['closed', 'sandbox-ledger']) {
    const f = await nextFixture(profile), prior = clone(f.state.pending), beforeConfig = clone(f.inventory.baseConfig);
    const result = await main({ ...f.options, action: 'deploy-next' });
    assert.equal(result.submitted, true); assert.equal(result.releaseTaskId, 104);
    assert.deepEqual(f.state.writes, [...(profile === 'sandbox-ledger' ? ['configure'] : []), 'allocate', 'upload', 'release']);
    assert.deepEqual(f.state.archives.at(-1).pending, prior);
    assert.equal(f.state.pending.releaseProfile, profile); assert.deepEqual(f.state.pending.upgradeFrom, nextUpgradeSource);
    const variables = JSON.parse(f.inventory.baseConfig.envParams);
    assert.equal(variables.XPAY_MODE, profile === 'closed' ? 'closed' : 'sandbox');
    assert.equal(variables.XPAY_ENV, '1'); assert.equal(variables.XPAY_PURPOSE_RULES_JSON, '{}');
    assert.equal(variables.XPAY_APP_KEY, undefined); assert.deepEqual(f.inventory.accessTypes, ['MINIAPP']);
    if (profile === 'sandbox-ledger') {
      assert.equal(f.events.indexOf('archive') < f.events.indexOf('configure_requested'), true);
      assert.equal(f.events.indexOf('configure_requested') < f.events.indexOf('configure'), true);
    }
    f.finishRelease();
    const readOptions = { ...f.options }; delete readOptions.profile;
    assert.equal((await main({ ...readOptions, action: 'status' })).controlPlaneDeploymentVerified, true);
    assert.equal((await main({ ...readOptions, action: 'rollback' })).rollbackSubmitted, true); f.finishRollback();
    assert.equal((await main({ ...readOptions, action: 'rollback' })).rollbackComplete, true);
    assert.deepEqual(f.inventory.baseConfig, beforeConfig);
  }
});

test('next profiles reject empty, malformed and duplicate allowlists without accepting production or arbitrary catalogs', async () => {
  const f = await nextFixture('sandbox-ledger'), base = deploymentEnvironment(f.payment);
  for (const ids of ['', 'someone', 'usr_' + '-'.repeat(36), f.payment.XPAY_TEST_USER_IDS + ',' + f.payment.XPAY_TEST_USER_IDS]) {
    assert.throws(() => nextEnvironment(base, { XPAY_TEST_USER_IDS: ids }, 'sandbox-ledger'), /LOCAL_CONFIGURATION_INVALID/);
  }
  const prepared = nextEnvironment(base, { ...f.payment, XPAY_ENV: '0', XPAY_PRODUCTS_JSON: '[{"id":"evil"}]', XPAY_PURPOSE_RULES_JSON: '{"all":true}' }, 'sandbox-ledger');
  assert.equal(prepared.XPAY_ENV, '1'); assert.equal(prepared.XPAY_PURPOSE_RULES_JSON, '{}');
  const product = JSON.parse(prepared.XPAY_PRODUCTS_JSON)[0];
  assert.equal(product.id, 'photo10'); assert.equal(product.amountFen, 990); assert.equal(product.components[0].quantity, 10);
  assert.throws(() => nextEnvironment(base, f.payment, 'live'), /LOCAL_CONFIGURATION_INVALID/);
  f.payment.XPAY_TEST_USER_IDS = '';
  f.options.withCloud = async () => assert.fail('invalid local profile must not reach cloud');
  assert.equal((await main({ ...f.options, action: 'plan-next' })).failureCode, 'LOCAL_CONFIGURATION_INVALID');
});

test('next plan and deployment refuse source, task, manifest, environment, account or public-ingress drift', async () => {
  for (const action of ['plan-next', 'deploy-next']) for (const change of [
    f => { f.state.pending.phase = 'release_requested'; },
    f => { f.state.pending.manifestSha256 = 'e'.repeat(64); },
    f => { f.inventory.task.steps = [{ status: 'failed' }]; },
    f => { f.inventory.task = { ...f.inventory.task, id: 105 }; },
    f => { f.inventory.versions.at(-1).Remark = 'unknown-operation'; },
    f => { f.inventory.versions.push({ VersionName: 'buildtest-099', FlowRatio: 0, Status: 'normal' }); },
    f => { f.payment.WECHAT_APP_SECRET = 'fictional-changed-secret'; },
    f => { f.payment.XPAY_MYSQL_USER = 'root'; },
    f => { f.inventory.baseConfig.maxNum = 2; },
    f => { f.inventory.detail.dbInfo.isOpenPubNetAccess = true; },
    f => { f.options.expectedVersion = 'buildtest-008'; },
    f => { f.options.loadBundle = () => ({ manifestHash: nextSourceManifest, entries: [] }); },
    f => { f.options.fetchImpl = async () => new Response('unexpected', { status: 200 }); },
  ]) {
    const f = await nextFixture('sandbox-ledger'); change(f); const before = clone(f.state.pending), count = f.state.archives.length;
    const result = await main({ ...f.options, action });
    assert.notEqual(result.planReady, true); assert.notEqual(result.submitted, true);
    assert.deepEqual(f.state.writes, []); assert.equal(f.state.archives.length, count); assert.deepEqual(f.state.pending, before);
  }
});

test('each uncertain next deployment write preserves its fence and cannot be retried or archived again', async () => {
  for (const [call, phase] of [['configure', 'configure_requested'], ['allocate', 'upload_authorization_requested'],
    ['upload', 'upload_requested'], ['release', 'release_requested']]) {
    const f = await nextFixture('sandbox-ledger'); f.state.failCall = call;
    const first = await main({ ...f.options, action: 'deploy-next' });
    assert.equal(first.ok, false); assert.equal(f.state.pending.phase, phase);
    const before = clone(f.state.pending), writes = [...f.state.writes], count = f.state.archives.length;
    f.state.failCall = null;
    assert.equal((await main({ ...f.options, action: 'deploy-next' })).ok, false);
    assert.deepEqual(f.state.writes, writes); assert.deepEqual(f.state.pending, before); assert.equal(f.state.archives.length, count);
  }
});

test('next deployment rechecks the finalized source after packaging before journaling any environment delta', async () => {
  const f = await nextFixture('sandbox-ledger'), count = f.state.archives.length;
  f.options.zip = async () => { f.inventory.task = { ...f.inventory.task, id: 105 }; return Buffer.from('fictional'); };
  assert.equal((await main({ ...f.options, action: 'deploy-next' })).failureCode, 'UPGRADE_SOURCE_UNCONFIRMED');
  assert.equal(f.state.archives.length, count); assert.deepEqual(f.state.writes, []);
});

test('profile arguments cannot enable next behavior on an older or unrelated action', () => {
  assert.equal(parseArguments(['plan-next', '--bundle', 'candidate', '--profile', 'sandbox-ledger']).profile, 'sandbox-ledger');
  for (const args of [['plan-next', '--bundle', 'candidate', '--profile', 'live'],
    ['upgrade', '--bundle', 'candidate', '--profile', 'sandbox-ledger'], ['status', '--profile', 'closed']]) {
    assert.throws(() => parseArguments(args), /ARGUMENT_INVALID/);
  }
});

test('one-time upgrade archives only its confirmed source, keeps every env value and skips configuration writes', async () => {
  const f = await upgradeFixture(), prior = clone(f.state.pending), config = clone(f.inventory.baseConfig);
  const plan = await main({ ...f.options, action: 'plan-upgrade' });
  assert.equal(plan.planReady, true); assert.deepEqual(f.state.writes, []); assert.equal(f.state.archives.length, 0);
  const result = await main({ ...f.options, action: 'upgrade' });
  assert.equal(result.submitted, true); assert.equal(result.controlPlaneDeploymentVerified, false);
  assert.equal(result.precedingOperationArchived, true); assert.equal(result.releaseTaskId, 103);
  assert.deepEqual(f.state.writes, ['allocate', 'upload', 'release']);
  assert.equal(f.state.archives.length, 1); assert.deepEqual(f.state.archives[0].pending, prior);
  assert.deepEqual(f.state.pending.variables, prior.variables); assert.deepEqual(f.inventory.baseConfig, config);
  assert.deepEqual(f.state.pending.upgradeFrom, upgradeSource); assert.equal(f.state.pending.before.version, 'buildtest-008');
  assert.equal(f.events.indexOf('archive') < f.events.indexOf('allocate'), true);
  const writes = [...f.state.writes];
  assert.equal((await main({ ...f.options, action: 'upgrade' })).failureCode, 'UPGRADE_SOURCE_UNCONFIRMED');
  assert.deepEqual(f.state.writes, writes); assert.equal(f.state.archives.length, 1);
  f.finishRelease(); assert.equal((await main({ ...f.options, action: 'status' })).controlPlaneDeploymentVerified, true);
  assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackSubmitted, true); f.finishRollback();
  assert.equal((await main({ ...f.options, action: 'rollback' })).rollbackComplete, true);
  assert.equal(f.inventory.versions.find(v => v.FlowRatio === 100).VersionName, upgradeSource.version);
  assert.deepEqual(f.inventory.baseConfig, config);
});

test('source uncertainty, configuration/secret/task/version drift and public responses block upgrade before archive or write', async () => {
  for (const change of [
    f => { f.state.pending.phase = 'release_requested'; },
    f => { f.inventory.task.status = 'running'; },
    f => { f.inventory.task.steps = [{ status: 'failed' }]; },
    f => { f.inventory.task = { ...f.inventory.task, id: 104 }; },
    f => { f.inventory.versions[1].Remark = 'other-operation'; },
    f => { f.inventory.versions.push({ VersionName: 'buildtest-099', FlowRatio: 0, Status: 'normal' }); },
    f => { f.payment.WECHAT_APP_SECRET = 'fictional-new-secret'; },
    f => { f.inventory.baseConfig.maxNum = 2; },
    f => { f.inventory.baseConfig.envParams = JSON.stringify({ ...JSON.parse(f.inventory.baseConfig.envParams), XPAY_PRODUCTS_JSON: '[{}]' }); },
    f => { f.options.expectedVersion = 'buildtest-009'; },
    f => { f.options.loadBundle = () => ({ manifestHash: 'a'.repeat(64), entries: [] }); },
    f => { f.options.fetchImpl = async () => new Response('unexpected', { status: 200 }); },
  ]) {
    const f = await upgradeFixture(); change(f); const before = clone(f.state.pending);
    const result = await main({ ...f.options, action: 'upgrade' });
    assert.equal(result.ok, false); assert.deepEqual(f.state.writes, []); assert.equal(f.state.archives.length, 0);
    assert.deepEqual(f.state.pending, before);
  }
});

test('upgrade rechecks finalized source after packaging and does not archive if it changed', async () => {
  const f = await upgradeFixture();
  f.options.zip = async () => { f.inventory.task = { ...f.inventory.task, id: 105 }; return Buffer.from('fictional'); };
  assert.equal((await main({ ...f.options, action: 'upgrade' })).failureCode, 'UPGRADE_SOURCE_UNCONFIRMED');
  assert.equal(f.state.archives.length, 0); assert.deepEqual(f.state.writes, []);
});

test('unknown upgrade release retains new journal and cannot repeat release or archive', async () => {
  const f = await upgradeFixture(); f.state.failCall = 'release';
  assert.equal((await main({ ...f.options, action: 'upgrade' })).ok, false);
  assert.equal(f.state.pending.phase, 'release_requested'); assert.equal(f.state.archives.length, 1);
  f.state.failCall = null; const writes = [...f.state.writes];
  assert.equal((await main({ ...f.options, action: 'upgrade' })).ok, false);
  assert.deepEqual(f.state.writes, writes); assert.equal(f.state.archives.length, 1);
});

test('real private archive preserves the complete prior journal and blocks every interrupted rotation boundary', async t => {
  const f = await upgradeFixture(), previous = clone(f.state.pending), backup = clone(f.state.backup);
  await main({ ...f.options, action: 'upgrade' }); const next = clone(f.state.backup), evidence = clone(f.state.archives[0].evidence);
  for (const interrupted of [null, 'intent', 'archive', 'backup', 'pending', 'verified']) {
    const root = temporary(t);
    execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe', windowsHide: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.env*\n');
    const files = privateFiles(root, { afterArchiveStep: step => { if (step === interrupted) throw new Error('fictional crash'); } });
    files.createPending(backup); files.updatePending(previous, backup);
    const run = () => files.archiveConfirmedPending(next, previous, evidence);
    if (interrupted) {
      assert.throws(run, /fictional crash/);
      assert.throws(() => files.readPending(), /ARCHIVE_REQUIRES_REVIEW/);
      assert.throws(run, /ARCHIVE_REQUIRES_REVIEW/);
      assert.equal(fs.existsSync(path.join(root, '.env.mini-sandbox-deploy.archive-intent.json')), true);
      if (interrupted === 'intent') assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, '.env.mini-sandbox-deploy.pending.json'))), previous);
    } else {
      run(); assert.deepEqual(files.readPending(), next);
      assert.equal(fs.existsSync(path.join(root, '.env.mini-sandbox-deploy.archive-intent.json')), false);
      assert.throws(run, /UPGRADE_SOURCE_UNCONFIRMED/);
    }
    if (interrupted !== 'intent') {
      const archive = JSON.parse(fs.readFileSync(path.join(root, `.env.mini-sandbox-deploy.confirmed-${previous.operationId}.json`)));
      assert.deepEqual(archive.previousPending, previous); assert.deepEqual(archive.previousBackup, backup);
      assert.deepEqual(archive.evidence, evidence); assert.equal(archive.nextOperationId, next.operationId);
    }
  }
});

test('next profile archive preserves 009 records and blocks interrupted rotation without accepting an extra environment change', async t => {
  const f = await nextFixture('sandbox-ledger'), previous = clone(f.state.pending), backup = clone(f.state.backup);
  await main({ ...f.options, action: 'deploy-next' }); const next = clone(f.state.backup), evidence = clone(f.state.archives.at(-1).evidence);
  for (const interrupted of [null, 'intent', 'archive', 'backup', 'pending', 'verified']) {
    const root = temporary(t);
    execFileSync('git', ['init', '--quiet', root], { stdio: 'pipe', windowsHide: true });
    fs.writeFileSync(path.join(root, '.gitignore'), '.env*\n');
    const files = privateFiles(root, { afterArchiveStep: step => { if (step === interrupted) throw new Error('fictional crash'); } });
    files.createPending(backup); files.updatePending(previous, backup);
    const run = () => files.archiveConfirmedPending(next, previous, evidence);
    if (interrupted) {
      assert.throws(run, /fictional crash/);
      assert.throws(() => files.readPending(), /ARCHIVE_REQUIRES_REVIEW/);
      assert.throws(run, /ARCHIVE_REQUIRES_REVIEW/);
    } else {
      const tampered = clone(next); tampered.variables.WECHAT_APP_SECRET = 'fictional-unauthorized-rotation';
      tampered.desiredConfig.envParams = JSON.stringify(tampered.variables);
      assert.throws(() => files.archiveConfirmedPending(tampered, previous, evidence), /UPGRADE_SOURCE_UNCONFIRMED/);
      assert.deepEqual(files.readPending(), previous);
      run(); assert.deepEqual(files.readPending(), next);
      assert.throws(run, /UPGRADE_SOURCE_UNCONFIRMED/);
    }
    if (interrupted !== 'intent') {
      const archive = JSON.parse(fs.readFileSync(path.join(root, `.env.mini-sandbox-deploy.confirmed-${previous.operationId}.json`)));
      assert.deepEqual(archive.previousPending, previous); assert.deepEqual(archive.previousBackup, backup);
      assert.deepEqual(archive.evidence.source, nextUpgradeSource);
    }
  }
});
