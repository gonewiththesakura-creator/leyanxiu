import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { prepareGray, deployGray, grayTarget, validateGrayPredecessor, verifyGrayBeforeRelease,
  safeGrayState, grayStatus } from '../scripts/deploy-mini-production-gray.mjs';
import { inspectProductionCloud, cloudInventorySummary } from '../scripts/inspect-mini-production-cloud.mjs';
import { buildPhotoProduction } from '../scripts/build-mini-photo-production.mjs';
import { packageBundle, normalizedConfig } from '../scripts/deploy-mini-sandbox-cloud.mjs';

const server = fileURLToPath(new URL('../', import.meta.url));
const clone = value => structuredClone(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const canary = 'SYNTHETIC_PRIVATE_GRAY_CANARY';
const oldVariables = { WECHAT_APP_ID: grayTarget.appId, XPAY_OFFER_ID: '1450662722',
  XPAY_ENV: '1', XPAY_MODE: 'closed', RELEASE_CHANNEL: 'wechat-mini-program',
  XPAY_MESSAGE_TOKEN: 'synthetic-token', XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 3).toString('base64').slice(0, -1),
  WECHAT_APP_SECRET: canary };
function predecessor() {
  const base = normalizedConfig({ envParams: JSON.stringify(oldVariables), openAccessTypes: ['MINIAPP'],
    minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5, port: 0, logType: 'none' });
  return { serverName: 'buildtest', base, domain: { AccessTypes: ['MINIAPP'] },
    task: { id: 2313130, status: 'finished', envId: grayTarget.envId, serverName: 'buildtest' },
    versions: [{ VersionName: 'buildtest-012', Status: 'normal', FlowRatio: 0, Remark: canary },
      { VersionName: 'buildtest-013', Status: 'normal', FlowRatio: 100, Remark: canary }],
    active: [{ versionName: 'buildtest-013', containerPort: 3000, minNum: 0, maxNum: 1, cpu: 0.25, mem: 0.5,
      envParams: JSON.stringify(oldVariables) }] };
}
function inputs() {
  return { payment: { ...oldVariables, XPAY_SANDBOX_APP_KEY: 'synthetic-sandbox-key', XPAY_SESSION_ENCRYPTION_KEY: '1'.repeat(64) },
    production: { WECHAT_APP_ID: grayTarget.appId, XPAY_OFFER_ID: '1450662722', XPAY_ENV: '0', XPAY_APP_KEY: 'synthetic-production-key' },
    database: { XPAY_MYSQL_DATABASE: 'leyanxiu_xpay_production', XPAY_MYSQL_USER: 'lyx_xpay_prod',
      XPAY_MYSQL_ACCOUNT_HOST: '%', XPAY_MYSQL_PASSWORD: 'synthetic-db-password' },
    media: { ALIYUN_ACCESS_KEY_ID: 'synthetic-ak', ALIYUN_ACCESS_KEY_SECRET: 'synthetic-ak-secret',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-key', DASHSCOPE_BASE: 'https://demo.cn-beijing.maas.aliyuncs.com',
      OSS_BUCKET: 'synthetic-private-bucket', OSS_REGION: 'oss-cn-shanghai' },
    policyBytes: fs.readFileSync(path.join(server, 'docs/production-config/closed-policy-2026-10-12.json')) };
}
let directory, bundle, manifestSha256, baseline, archive;
test.before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-gray-review-'));
  bundle = path.join(directory, 'bundle');
  ({ manifestSha256 } = buildPhotoProduction({ output: bundle }));
  await prepareGray({}, { bundle, manifestSha256, inputs: inputs(), read: () => null,
    write: record => { baseline = clone(record); }, inspect: async () => [predecessor()] });
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'manifest.json')));
  archive = await packageBundle({ entries: [...manifest.files.map(file => ({ name: file.path,
    bytes: fs.readFileSync(path.join(bundle, file.path)) })), { name: 'manifest.json', bytes: fs.readFileSync(path.join(bundle, 'manifest.json')) }] });
});
test.after(() => { if (directory) fs.rmSync(directory, { recursive: true, force: true }); });

function operation({ corrupt, failAt, afterUpdate, uploadUrl, writeFailure } = {}) {
  let record = clone(baseline), current = predecessor();
  if (corrupt) corrupt(record);
  const events = [], calls = [];
  const checkpoint = (name, phase) => {
    assert.equal(record.phase, phase, `${name} must have durable intent before invocation`);
    calls.push(name); events.push(`call:${name}`);
    if (failAt === name) throw new Error(canary);
  };
  const adapter = {
    CloudAPI: {
      async tcbUpdateServerBaseConfig(args) {
        checkpoint('configure', 'configure_requested');
        assert.equal(args.envId, grayTarget.envId); assert.equal(args.serverName, 'buildtest');
        assert.deepEqual({ ...args.conf, envParams: '' }, { ...normalizedConfig(baseline.before.base), envParams: '' });
        current.base = clone(args.conf); afterUpdate?.(current);
      },
      async tcbSubmitServerRelease(args) {
        checkpoint('release', 'release_requested');
        assert.equal(args.releaseType, 'GRAY'); assert.equal(args.deployType, 'package');
        assert.equal(args.envId, grayTarget.envId); assert.equal(args.serverName, 'buildtest');
        assert.equal(args.wxAppId, grayTarget.appId); assert.equal(args.port, 3000);
        assert.equal(args.versionRemark, record.remark); assert.equal(args.operatorRemark, record.remark);
        assert.equal(args.packageName, 'synthetic-package'); assert.equal(args.packageVersion, 'synthetic-version');
        assert.equal(args.hasDockerfile, true); assert.equal(args.dockerfile, 'Dockerfile'); assert.equal(args.buildDir, '.');
        assert.equal(Object.keys(args).some(key => /flow/i.test(key)), false);
        return { taskId: 2314000 };
      },
    },
    api: { async DescribeCloudBaseBuildService(args) {
      checkpoint('authorize', 'upload_authorization_requested');
      assert.deepEqual(args, { EnvId: grayTarget.envId, ServiceName: 'buildtest' });
      return { UploadUrl: uploadUrl || 'https://synthetic.cos.ap-shanghai.myqcloud.com/upload?token=REDACTED_SECRET
        PackageName: 'synthetic-package', PackageVersion: 'synthetic-version' };
    } },
    axios: { async put(url, bytes, config) {
      checkpoint('upload', 'upload_requested'); assert.deepEqual(bytes, archive);
      assert.deepEqual(config, { headers: { 'content-type': 'application/zip' }, timeout: 60000, maxRedirects: 0 });
      return { status: 200 };
    } },
  };
  const options = { read: () => clone(record), write(next, previous) {
    assert.deepEqual(previous, record); events.push(`journal:${next.phase}`);
    if (writeFailure === next.phase) throw new Error('synthetic journal not durable');
    record = clone(next);
  }, inspect: async () => { events.push('inspect'); return [clone(current)]; }, zipBundle: async () => archive };
  return { adapter, options, events, calls, record: () => clone(record), current: () => clone(current),
    run: () => deployGray(adapter, options) };
}

test('prepare packages only reviewed manifest bytes and privately journals closed env0 without SDK mutations', () => {
  assert.equal(baseline.phase, 'prepared'); assert.equal(baseline.manifestSha256, manifestSha256);
  assert.equal(baseline.zipSha256, sha(archive)); assert.equal(baseline.zipBytes, archive.length);
  assert.deepEqual(baseline.before, predecessor()); assert.equal(baseline.variables.XPAY_ENV, '0');
  assert.equal(baseline.variables.XPAY_MODE, 'closed'); assert.equal(baseline.variables.XPAY_PRODUCTS_JSON, '[]');
  for (const name of ['PHOTO_PRODUCTION_GENERATION_ENABLED', 'PHOTO_PRODUCTION_PROCESS_ENABLED',
    'PHOTO_PRODUCTION_CLEANUP_ENABLED', 'XPAY_RECONCILE_ENABLED']) assert.equal(baseline.variables[name], 'false');
  assert.equal(baseline.variables.XPAY_SANDBOX_APP_KEY, undefined);
  assert.notEqual(baseline.variables.XPAY_SESSION_ENCRYPTION_KEY, inputs().payment.XPAY_SESSION_ENCRYPTION_KEY);
  assert.deepEqual({ ...baseline.desiredConfig, envParams: '' }, { ...normalizedConfig(baseline.before.base), envParams: '' });
  const summary = JSON.stringify(safeGrayState(baseline));
  for (const secret of [canary, baseline.variables.XPAY_SESSION_ENCRYPTION_KEY, 'synthetic-db-password', 'synthetic-production-key']) {
    assert.equal(summary.includes(secret), false);
  }
});

test('prepared deployment journals every mutation, preserves active predecessor, and requests GRAY without promotion', async () => {
  const f = operation(), report = await f.run();
  assert.equal(report.phase, 'submitted'); assert.equal(report.promoted, false); assert.equal(report.releaseType, 'GRAY');
  assert.equal(report.taskId, 2314000); assert.equal(report.paymentEnvironment, 0); assert.equal(report.mode, 'closed');
  assert.deepEqual(f.calls, ['configure', 'authorize', 'upload', 'release']);
  assert.deepEqual(f.current().active, baseline.before.active); assert.deepEqual(f.current().versions, baseline.before.versions);
  assert.equal(f.record().phase, 'submitted');
  await assert.rejects(f.run(), /GRAY_NOT_PREPARED_OR_REQUEST_UNCERTAIN/);
  assert.equal(f.calls.length, 4);
});

test('pending preparation, wrong manifest, and callback drift cannot create another private intent or write the cloud', async () => {
  let writes=0, inspections=0;
  const options={bundle,manifestSha256,inputs:inputs(),write:()=>{writes++;},inspect:async()=>{inspections++;return [predecessor()];}};
  await assert.rejects(prepareGray({}, {...options,read:()=>clone(baseline)}),/GRAY_PENDING_EXISTS/);
  assert.equal(inspections,0);
  await assert.rejects(prepareGray({}, {...options,read:()=>null,manifestSha256:'0'.repeat(64)}),/GRAY_BUNDLE_HASH_CHANGED/);
  assert.equal(inspections,0);
  const mismatched=inputs();mismatched.payment.XPAY_MESSAGE_TOKEN='different-valid-token';
  await assert.rejects(prepareGray({}, {...options,read:()=>null,inputs:mismatched}),/GRAY_CALLBACK_CONFIGURATION_CHANGED/);
  assert.equal(writes,0);
});

test('archive byte changes and predecessor changes since preparation stop before any cloud mutation', async () => {
  const archiveChanged=operation();archiveChanged.options.zipBundle=async()=>Buffer.concat([archive,Buffer.from('changed')]);
  await assert.rejects(archiveChanged.run(),/GRAY_ARCHIVE_CHANGED/);assert.deepEqual(archiveChanged.calls,[]);
  for(const mutate of [v=>{v.base.logType='new-log-type';},v=>{v.task.id++;},v=>{v.versions.push({VersionName:'buildtest-014',FlowRatio:0,Status:'normal'});}]) {
    const f=operation(),changed=predecessor();mutate(changed);f.options.inspect=async()=>[changed];
    await assert.rejects(f.run());assert.deepEqual(f.calls,[]);assert.equal(f.record().phase,'prepared');
  }
});

test('SDK optional undefined fields and environment JSON key order survive journal serialization without hiding real changes', async () => {
  const sdkShape = row => {
    row.base.optionalSdkField = undefined;
    row.base.publicAccess = undefined;
    row.base.envParams = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(row.base.envParams)).reverse()), null, 2);
    row.active[0].envParams = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(row.active[0].envParams)).reverse()));
    return row;
  };
  const f=operation(),read=f.options.read,inspect=f.options.inspect;
  // The durable file is ordinary JSON; omitted undefined properties cannot be
  // reconstructed after reading it. Fresh SDK objects may include them again.
  f.options.read=()=>JSON.parse(JSON.stringify(read()));
  f.options.inspect=async()=> (await inspect()).map(sdkShape);
  const result=await f.run();
  assert.equal(result.phase,'submitted');assert.deepEqual(f.calls,['configure','authorize','upload','release']);
  assert.deepEqual(f.current().active,baseline.before.active);

  for(const change of [row=>{row.base.logType='changed';},row=>{row.base.publicAccess=null;},
    row=>{row.base.optionalSdkField='now-present';},row=>{
      const env=JSON.parse(row.base.envParams);env.WECHAT_APP_SECRET='changed-real-value';
      row.base.envParams=JSON.stringify(env);row.active[0].envParams=JSON.stringify(env);
    }]) {
    const rejected=operation(),source=rejected.options.inspect;
    rejected.options.inspect=async()=> (await source()).map(row=>{sdkShape(row);change(row);return row;});
    await assert.rejects(rejected.run());assert.deepEqual(rejected.calls,[]);assert.equal(rejected.record().phase,'prepared');
  }
});

test('ambiguous configure, authorization, upload, and release responses never retry or continue', async t => {
  for (const [name, phase] of [['configure','configure_requested'], ['authorize','upload_authorization_requested'],
    ['upload','upload_requested'], ['release','release_requested']]) await t.test(name, async () => {
    const f = operation({ failAt: name }); await assert.rejects(f.run());
    assert.equal(f.record().phase, phase); const count = f.calls.length;
    await assert.rejects(f.run(), /GRAY_NOT_PREPARED_OR_REQUEST_UNCERTAIN/); assert.equal(f.calls.length, count);
  });
});

test('a failed durable journal write prevents its corresponding mutation', async t => {
  for (const [phase, prohibited] of [['configure_requested','configure'], ['upload_authorization_requested','authorize'],
    ['upload_requested','upload'], ['release_requested','release']]) await t.test(phase, async () => {
    const f = operation({ writeFailure: phase }); await assert.rejects(f.run()); assert.equal(f.calls.includes(prohibited), false);
  });
});

test('fixed predecessor rejects different version/task/environment/private ingress/capacity and running competitors', () => {
  const valid = predecessor(); assert.doesNotThrow(() => validateGrayPredecessor(valid));
  for (const mutate of [v => { v.versions[1].VersionName = 'buildtest-014'; }, v => { v.versions[1].FlowRatio = 99; },
    v => { v.task.id++; }, v => { v.task.status = 'running'; }, v => { v.domain.AccessTypes.push('PUBLIC'); },
    v => { v.base.publicAccess = true; }, v => { v.base.minNum = 1; }, v => { v.base.cpu = 0.5; },
    v => { v.base.envParams = JSON.stringify({ ...oldVariables, XPAY_MODE: 'sandbox' }); },
    v => { v.versions[0].Status = 'deploying'; }, v => { v.active[0].envParams = '{}'; }]) {
    const value = clone(valid); mutate(value); assert.throws(() => validateGrayPredecessor(value));
  }
});

test('the returned active version and task scope must be the exact requested predecessor', () => {
  for (const mutate of [v => { v.active[0].versionName = 'buildtest-999'; },
    v => { v.task.envId = 'another-environment'; }, v => { v.task.serverName = 'leyanxiu-api'; }]) {
    const value = predecessor(); mutate(value); assert.throws(() => validateGrayPredecessor(value));
  }
});

test('journal mutation cannot broaden desired base configuration or enable work before the first cloud write', async t => {
  for (const [name, mutate] of [['capacity',r=>{r.desiredConfig.cpu=2;}], ['public-access',r=>{r.desiredConfig.publicAccess=true;}],
    ['live',r=>{r.variables.XPAY_MODE='live';}], ['generation',r=>{r.variables.PHOTO_PRODUCTION_GENERATION_ENABLED='true';}],
    ['reconcile',r=>{r.variables.XPAY_RECONCILE_ENABLED='true';}], ['sandbox-key',r=>{r.variables.XPAY_SANDBOX_APP_KEY='synthetic';}]]) {
    await t.test(name, async () => {
      const f=operation({corrupt:r=>{mutate(r);r.desiredConfig.envParams=JSON.stringify(r.variables);}});
      await assert.rejects(f.run()); assert.equal(f.calls.length,0);
    });
  }
});

test('base update is read back and any predecessor/environment/flow drift blocks upload and release', async t => {
  for (const [name, afterUpdate] of [['flow',v=>{v.versions[1].FlowRatio=0;}],
    ['old-environment',v=>{v.active[0].envParams='{}';}], ['task',v=>{v.task.id++;}],
    ['base-key',v=>{const e=JSON.parse(v.base.envParams);e.XPAY_APP_KEY='wrong';v.base.envParams=JSON.stringify(e);}]]) {
    await t.test(name,async()=>{const f=operation({afterUpdate});await assert.rejects(f.run());assert.deepEqual(f.calls,['configure']);});
  }
  const valid=predecessor();valid.base=clone(baseline.desiredConfig);assert.equal(verifyGrayBeforeRelease(valid,baseline),true);
});

test('invalid upload destinations never send archive bytes or submit a release', async t => {
  for (const uploadUrl of ['http://synthetic.myqcloud.com/x', 'https://myqcloud.com.evil.invalid/x',
    'https://REDACTED_USER:REDACTED_PASSWORD@synthetic.myqcloud.com/x', 'https://synthetic.myqcloud.com:444/x', 'https://127.0.0.1/x']) {
    await t.test(uploadUrl,async()=>{const f=operation({uploadUrl});await assert.rejects(f.run(),/GRAY_UPLOAD_DESTINATION_INVALID/);
      assert.deepEqual(f.calls,['configure','authorize']);assert.equal(f.record().phase,'upload_authorization_requested');});
  }
});

function inventoryAdapter({ batch, domainFailure, delayedBase } = {}) {
  const requests=[];
  return { requests, api: {
    async DescribeWxCloudBaseRunEnvs(){return {EnvList:[{EnvId:grayTarget.envId}]};},
    DescribeCloudBaseRunServiceDomain(args){requests.push(['domain',args.ServiceName]);if(domainFailure)throw new Error(canary);return Promise.resolve({AccessTypes:['MINIAPP']});},
    async DescribeCloudBaseRunServer(args){requests.push(['versions',args.ServerName,args.Offset]);
      return batch ? batch(args) : {ServerName:args.ServerName,TotalCount:1,VersionItems:[{VersionName:`${args.ServerName}-013`,Status:'normal',FlowRatio:100}]};},
  },CloudAPI:{
    async tcbDescribeServiceBaseConfig(args){if(delayedBase)await delayedBase();return {serviceBaseConfig:{...predecessor().base}};},
    async tcbDescribeServerManageTask(){return {task:{id:2313130,status:'finished'}};},
    async tcbDescribeCloudBaseRunServerVersion(args){return {versionName:args.versionName,envParams:JSON.stringify(oldVariables)};},
  }};
}

test('cloud inventory paginates all three fixed services and rejects duplicate, missing or changing totals', async () => {
  const a=inventoryAdapter();const rows=await inspectProductionCloud(a);
  assert.deepEqual(rows.map(r=>r.serverName),['buildtest','leyanxiu-stage','leyanxiu-api']);
  const paged=inventoryAdapter({batch:args=>({ServerName:args.ServerName,TotalCount:11,
    VersionItems:Array.from({length:args.Offset===0?10:1},(_,i)=>({VersionName:`${args.ServerName}-${String(args.Offset+i+1).padStart(3,'0')}`,
      Status:'normal',FlowRatio:args.Offset+i===10?100:0}))})});
  assert.ok((await inspectProductionCloud(paged)).every(row=>row.versions.length===11));
  assert.deepEqual(paged.requests.filter(r=>r[0]==='versions').map(r=>r[2]),[0,10,0,10,0,10]);
  for(const batch of [args=>({ServerName:args.ServerName,TotalCount:2,VersionItems:[{VersionName:`${args.ServerName}-013`,FlowRatio:100}]}),
    args=>({ServerName:args.ServerName,TotalCount:1,VersionItems:[]}),
    args=>({ServerName:args.ServerName,TotalCount:args.Offset===0?2:3,VersionItems:[{VersionName:`${args.ServerName}-${args.Offset+10}`,FlowRatio:0}]}),
    args=>({ServerName:'another',TotalCount:1,VersionItems:[{VersionName:'another-013'}]})]) {
    await assert.rejects(inspectProductionCloud(inventoryAdapter({batch})),/CLOUD_VERSIONS_UNCONFIRMED/);
  }
});

test('a synchronous sibling SDK failure still waits for the started request before restoring logging', async () => {
  let settled=false;
  const adapter=inventoryAdapter({domainFailure:true,delayedBase:async()=>{await new Promise(resolve=>setTimeout(resolve,15));settled=true;}});
  await assert.rejects(inspectProductionCloud(adapter));assert.equal(settled,true);
});

test('public inventory output omits secret values and arbitrary version remarks', () => {
  const report=JSON.stringify(cloudInventorySummary([predecessor()]));
  assert.equal(report.includes(canary),false);assert.equal(report.includes(oldVariables.XPAY_MESSAGE_AES_KEY),false);
});

function statusFixture(mutate=()=>{}) {
  const record={...clone(baseline),phase:'submitted',taskId:2314000};
  const current=predecessor();current.base=clone(record.desiredConfig);
  current.task={...current.task,id:record.taskId,status:'running',steps:[{name:'CreateVersion',type:'CreateVersion',status:'finished'},
    {name:'GrayRelease',type:'GrayRelease',status:'running'}]};
  const candidate={VersionName:'buildtest-014',Status:'normal',FlowRatio:0,Remark:record.remark};
  current.versions.push(candidate);
  const detail={versionName:candidate.VersionName,containerPort:3000,minNum:0,maxNum:1,cpu:0.25,mem:0.5,status:'normal',
    envParams:JSON.stringify(Object.fromEntries(Object.entries(record.variables).reverse()),null,2)};
  const state={record,current,candidate,detail};mutate(state);
  const adapter=inventoryAdapter(),reads=[],directReads=[];
  const oldBase=adapter.CloudAPI.tcbDescribeServiceBaseConfig,oldTask=adapter.CloudAPI.tcbDescribeServerManageTask;
  const oldVersions=adapter.api.DescribeCloudBaseRunServer,oldDetail=adapter.CloudAPI.tcbDescribeCloudBaseRunServerVersion;
  adapter.CloudAPI.tcbDescribeServiceBaseConfig=async args=>args.serverName==='buildtest'?{serviceBaseConfig:clone(current.base)}:oldBase(args);
  adapter.CloudAPI.tcbDescribeServerManageTask=async args=>args.serverName==='buildtest'?{task:clone(current.task)}:oldTask(args);
  adapter.api.DescribeCloudBaseRunServer=async args=>args.ServerName==='buildtest'
    ?{ServerName:'buildtest',TotalCount:current.versions.length,VersionItems:clone(current.versions)}:oldVersions(args);
  adapter.CloudAPI.tcbDescribeCloudBaseRunServerVersion=async args=>{
    reads.push(args);
    if(args.serverName!=='buildtest')return oldDetail(args);
    if(args.versionName===grayTarget.predecessor)return clone(current.active[0]);
    return {...clone(detail),cpu:0,mem:0}; // Actual SDK field-mapping defect.
  };
  adapter.api.DescribeCloudBaseRunServerVersion=async args=>{
    directReads.push(args);reads.push({envId:args.EnvId,serverName:args.ServerName,versionName:args.VersionName});
    assert.deepEqual(args,{EnvId:grayTarget.envId,ServerName:'buildtest',VersionName:candidate.VersionName});
    return {VersionName:detail.versionName,ServerName:detail.serverName,EnvId:detail.envId,
      EnvParams:detail.envParams,ContainerPort:detail.containerPort,Status:detail.status,
      MinNum:detail.minNum,MaxNum:detail.maxNum,Cpu:detail.cpu,Mem:detail.mem,CpuSize:0,MemSize:0};
  };
  return {...state,adapter,reads,directReads,run:()=>grayStatus(adapter,record)};
}

test('gray status explicitly reads the zero-flow candidate and verifies its actual environment and base resources without leaking secrets',async()=>{
  const f=statusFixture(),result=await f.run(),cloud=result.cloud;
  assert.equal(cloud.candidateVersion,'buildtest-014');assert.equal(cloud.currentTaskMatches,true);
  for(const key of ['newVersionEnvironmentVerified','newVersionBasicConfigurationVerified','newVersionZeroFlowVerified',
    'predecessorFlowUnchanged','privateIngressVerified','oldVersionEnvironmentUnchanged'])assert.equal(cloud[key],true,key);
  assert.equal(cloud.startupVerified,false);assert.equal(result.promoted,false);
  assert.equal(f.directReads.length,1);
  assert.deepEqual(f.reads.filter(r=>r.versionName==='buildtest-014'),[{envId:grayTarget.envId,serverName:'buildtest',versionName:'buildtest-014'}]);
  const output=JSON.stringify(result);
  for(const secret of [canary,f.record.variables.XPAY_APP_KEY,f.record.variables.XPAY_SESSION_ENCRYPTION_KEY,
    f.record.variables.XPAY_MYSQL_PASSWORD,f.record.variables.ALIYUN_ACCESS_KEY_SECRET])assert.equal(output.includes(secret),false);
});

test('candidate environment verification uses candidate bytes rather than desired base and fails closed for malformed, missing or changed values',async()=>{
  for(const envParams of [undefined,'{invalid','{}',JSON.stringify({...baseline.variables,XPAY_ENV:'1'}),
    JSON.stringify({...baseline.variables,XPAY_APP_KEY:'changed-candidate-key'})]){
    const f=statusFixture(v=>{v.detail.envParams=envParams;});
    assert.equal((await f.run()).cloud.newVersionEnvironmentVerified,false);
  }
  for(const mutate of [v=>{v.detail.containerPort=3001;},v=>{delete v.detail.cpu;},v=>{v.detail.cpu='0.25';},
    v=>{v.detail.cpu=0;},v=>{v.detail.mem='0.5';},v=>{v.detail.mem=0;},v=>{v.detail.maxNum=2;},
    v=>{v.detail.status='deploying';},v=>{v.candidate.Status='deploying';}]){
    const f=statusFixture(mutate);assert.equal((await f.run()).cloud.newVersionBasicConfigurationVerified,false);
  }
  const shifted=statusFixture(v=>{v.candidate.FlowRatio=1;v.current.versions[1].FlowRatio=99;});
  const cloud=(await shifted.run()).cloud;
  assert.equal(cloud.newVersionZeroFlowVerified,false);assert.equal(cloud.predecessorFlowUnchanged,false);
});

test('candidate identity, unique journal correlation and current task must be established before status can claim verification',async()=>{
  for(const mutate of [v=>{v.detail.versionName='buildtest-999';},v=>{v.detail.envId='another-env';},
    v=>{v.current.task.id++;},v=>{v.current.task.serverName='another-service';},
    v=>{v.candidate.Remark='different-journal';},v=>{v.current.versions.push({...v.candidate,VersionName:'buildtest-015'});},
    v=>{v.record.phase='release_requested';}]){
    const f=statusFixture(mutate),cloud=(await f.run()).cloud;
    assert.equal(cloud.candidateVersion,null);assert.equal(cloud.newVersionEnvironmentVerified,false);
    assert.equal(cloud.newVersionBasicConfigurationVerified,false);assert.equal(cloud.newVersionZeroFlowVerified,false);
    assert.equal(cloud.startupVerified,false);
  }
});

test('module imports and invalid CLI invocations are inert and do not read private configuration', () => {
  const script=path.join(server,'scripts/deploy-mini-production-gray.mjs');
  const result=spawnSync(process.execPath,[script,'--deploy'],{encoding:'utf8',cwd:directory});
  assert.equal(result.status,1);assert.equal(result.stdout,'');assert.match(result.stderr,/^GRAY_ARGUMENT_INVALID\s*$/);
  const imported=spawnSync(process.execPath,['--input-type=module','-e',`await import(${JSON.stringify(new URL('../scripts/deploy-mini-production-gray.mjs',import.meta.url).href)});`],{encoding:'utf8',cwd:directory});
  assert.equal(imported.status,0,imported.stderr);assert.equal(imported.stdout,'');assert.equal(imported.stderr,'');
});
