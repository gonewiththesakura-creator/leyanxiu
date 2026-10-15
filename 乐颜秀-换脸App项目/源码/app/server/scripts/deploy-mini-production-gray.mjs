import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual as same } from 'node:util';
import dotenv from 'dotenv';
import { withProductionCloud, inspectProductionCloud, productionCloud } from './inspect-mini-production-cloud.mjs';
import { verifyPhotoProductionBundle } from './build-mini-photo-production.mjs';
import { packageBundle, normalizedConfig } from './deploy-mini-sandbox-cloud.mjs';
import { buildMiniProductionCloudProfile } from './mini-production-cloud-profile.mjs';
import { materializePhotoProductionFiles } from '../photo-jobs/production-bootstrap.js';
import { photoProductionConfig } from '../photo-jobs/production-server.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateFile = path.join(server, '.env.mini-production-gray.json');
const lockFile = `${stateFile}.lock`;
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const fail = code => { throw new Error(code); };
export const grayTarget = Object.freeze({ ...productionCloud, serverName: 'buildtest',
  predecessor: 'buildtest-013', predecessorTask: 2313130 });
const scope = { envId: grayTarget.envId, serverName: grayTarget.serverName };
const phases = ['prepared', 'configure_requested', 'configured', 'upload_authorization_requested',
  'upload_ready', 'upload_requested', 'uploaded', 'release_requested', 'submitted'];
const parseEnv = value => JSON.parse(value?.envParams || '{}');
// Official SDK responses include optional own-properties with undefined;
// durable JSON necessarily omits those. Compare the persisted data model.
const data = value => JSON.parse(JSON.stringify(value));
const withoutEnvironment = value => data({ ...normalizedConfig(value), envParams: '' });
const comparableBase = value => data({ ...value, envParams: parseEnv(value) });
const immutableRecord = record => Object.fromEntries(['version','id','target','createdAt','bundle','manifestSha256',
  'zipSha256','zipBytes','remark','before','beforeControl','variables','desiredConfig'].map(k=>[k,record[k]]));
const versionSummary = versions => versions.map(v => ({ name: v.VersionName, status: v.Status, flow: v.FlowRatio })).sort((a,b) => a.name.localeCompare(b.name));
function controlFingerprint(item) {
  return { versions: versionSummary(item.versions), taskId: item.task?.id, taskStatus: item.task?.status,
    accessTypes: item.domain.AccessTypes, active: item.active.map(v => ({ version: v.versionName,
      envDigest: hash(JSON.stringify(Object.entries(parseEnv(v)).sort())), port: v.containerPort,
      min: v.minNum, max: v.maxNum, cpu: v.cpu, mem: v.mem })) };
}
export function validateGrayPredecessor(item) {
  const active = item.versions.filter(v => v.FlowRatio > 0), variables = parseEnv(item.base);
  if (item.serverName !== grayTarget.serverName || active.length !== 1
      || active[0].VersionName !== grayTarget.predecessor || active[0].FlowRatio !== 100
      || active[0].Status !== 'normal' || item.task?.id !== grayTarget.predecessorTask
      || item.task.status !== 'finished' || !same(item.domain.AccessTypes, ['MINIAPP'])
      || !same(item.base.openAccessTypes, ['MINIAPP']) || item.base.publicAccess === true
      || item.base.minNum !== 0 || item.base.maxNum !== 1 || item.base.cpu !== 0.25 || item.base.mem !== 0.5
      || item.active.length !== 1 || item.active[0].containerPort !== 3000
      || item.active[0].versionName !== grayTarget.predecessor
      || (item.task.envId !== undefined && item.task.envId !== grayTarget.envId)
      || (item.task.serverName !== undefined && item.task.serverName !== grayTarget.serverName)
      || variables.WECHAT_APP_ID !== grayTarget.appId || variables.XPAY_ENV !== '1'
      || variables.XPAY_MODE !== 'closed' || variables.RELEASE_CHANNEL !== 'wechat-mini-program'
      || !same(parseEnv(item.active[0]), variables)
      || item.versions.some(v => v.FlowRatio === 0 && !['normal','build_failed','deploy_failed','create_failed'].includes(v.Status)))
    fail('GRAY_PREDECESSOR_UNCONFIRMED');
  return controlFingerprint(item);
}
export function validateGrayRecord(record) {
  if (!record || record.version !== 1 || !same(record.target, grayTarget) || !phases.includes(record.phase)
      || !/^[a-f0-9]{24}$/.test(record.id) || !path.isAbsolute(record.bundle || '')
      || !/^[a-f0-9]{64}$/.test(record.manifestSha256 || '') || !/^[a-f0-9]{64}$/.test(record.zipSha256 || '')
      || !Number.isSafeInteger(record.zipBytes) || record.zipBytes < 100 || record.zipBytes > 2*1024*1024
      || !Number.isFinite(Date.parse(record.createdAt))
      || !same(validateGrayPredecessor(record.before),record.beforeControl)
      || !same(withoutEnvironment(record.desiredConfig),withoutEnvironment(record.before.base))
      || !same(parseEnv(record.desiredConfig),record.variables)
      || record.remark !== `mini-photo-production closed env0 gray ${record.id}`) fail('GRAY_STATE_INVALID');
  const v=record.variables;
  const required={ XPAY_ENV:'0', XPAY_MODE:'closed', XPAY_ENABLED:'true', XPAY_DB_BACKEND:'mysql',
    RELEASE_CHANNEL:'wechat-mini-program', AUTH_MODE:'wechat', DEPLOY_ENV:'production',
    WECHAT_APP_ID:grayTarget.appId, XPAY_OFFER_ID:'1450662722',
    XPAY_MYSQL_TRANSPORT:'cloudrun_builtin_private_production', XPAY_CLOUD_ENV_ID:grayTarget.envId,
    XPAY_MYSQL_INSTANCE_ID:'cynosdbmysql-7jg96bj6', XPAY_MYSQL_HOST:'REDACTED_PRIVATE_NETWORK_ADDRESS', XPAY_MYSQL_PORT:'3306',
    XPAY_MYSQL_DATABASE:'leyanxiu_xpay_production', XPAY_MYSQL_USER:'lyx_xpay_prod', XPAY_MYSQL_ACCOUNT_HOST:'%',
    PHOTO_PRODUCTION_GENERATION_ENABLED:'false', PHOTO_PRODUCTION_PROCESS_ENABLED:'false',
    PHOTO_PRODUCTION_CLEANUP_ENABLED:'false', XPAY_RECONCILE_ENABLED:'false',
    PHOTO_CANDIDATE_GENERATION_ENABLED:'false',PHOTO_CANDIDATE_PROCESS_ENABLED:'false',PHOTO_CANDIDATE_CLEANUP_ENABLED:'false',
    XPAY_PRODUCTS_JSON:'[]',XPAY_PURPOSE_RULES_JSON:'{}',XPAY_TEST_USER_IDS:'',XPAY_REFUND_OPERATOR_USER_IDS:'',
    PORT:'3000',BIND_HOST:'0.0.0.0', DEBUG:'',NODE_DEBUG:'',NODE_DEBUG_NATIVE:'' };
  if (!v || Object.entries(required).some(([k,value])=>v[k]!==value)
      || v.XPAY_SANDBOX_APP_KEY !== undefined || v.PHOTO_PRODUCTION_CONFIG_FILE !== undefined
      || v.PHOTO_PRODUCTION_ACCEPTANCE_FILE !== undefined || v.XPAY_ACCEPTANCE_FILE !== undefined
      || !/^[a-f0-9]{64}$/.test(v.XPAY_SESSION_ENCRYPTION_KEY||'')) fail('GRAY_CLOSED_CONFIGURATION_INVALID');
  return record;
}
export function verifyGrayBeforeRelease(item, record) {
  if (!same(controlFingerprint(item), record.beforeControl)
      || !same(parseEnv(item.base), record.variables)
      || !same(withoutEnvironment(item.base),withoutEnvironment(record.desiredConfig)))
    fail('GRAY_CONFIGURATION_OR_PREDECESSOR_CHANGED');
  return true;
}
function privateRead(filename) {
  execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true });
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('GRAY_PRIVATE_FILE_INVALID');
  return fs.readFileSync(filename, 'utf8');
}
function privateCreate(filename, content) {
  execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true });
  const fd = fs.openSync(filename, 'wx', 0o600);
  try {
    if (process.platform === 'win32') {
      const sid = execFileSync('whoami.exe', ['/user','/fo','csv','/nh'], { encoding:'utf8', windowsHide:true }).match(/S-1-5-(?:\d+-)*\d+/)?.[0];
      if (!sid) fail('GRAY_PRIVATE_FILE_INVALID');
      execFileSync('icacls.exe',[filename,'/inheritance:r','/grant:r',`*${sid}:(F)`,'*S-1-5-18:(F)'],{stdio:'pipe',windowsHide:true});
    }
    fs.writeFileSync(fd, content); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (privateRead(filename) !== content) fail('GRAY_PRIVATE_SAVE_UNCONFIRMED');
}
function readState() {
  if (!fs.existsSync(stateFile)) return null;
  const record = JSON.parse(privateRead(stateFile));
  const backup=validateGrayRecord(JSON.parse(privateRead(`${stateFile}.backup`)));
  if (backup.phase!=='prepared' || !same(immutableRecord(record),immutableRecord(backup))) fail('GRAY_BACKUP_MISMATCH');
  return validateGrayRecord(record);
}
function saveState(record, previous) {
  validateGrayRecord(record);
  if (!previous) { privateCreate(`${stateFile}.backup`, JSON.stringify(record)+'\n'); privateCreate(stateFile,JSON.stringify(record)+'\n'); return; }
  if (privateRead(stateFile) !== JSON.stringify(previous)+'\n'
      || !same(immutableRecord(record),immutableRecord(previous))) fail('GRAY_STATE_CHANGED');
  const temporary = `${stateFile}.tmp-${crypto.randomBytes(8).toString('hex')}`;
  privateCreate(temporary, JSON.stringify(record)+'\n'); fs.renameSync(temporary,stateFile);
  if (privateRead(stateFile) !== JSON.stringify(record)+'\n') fail('GRAY_PRIVATE_SAVE_UNCONFIRMED');
}
function bundleEntries(directory, expectedHash) {
  const report = verifyPhotoProductionBundle(directory);
  if (report.manifestSha256 !== expectedHash) fail('GRAY_BUNDLE_HASH_CHANGED');
  const manifestBytes=fs.readFileSync(path.join(directory,'manifest.json'));
  if(hash(manifestBytes)!==expectedHash) fail('GRAY_BUNDLE_HASH_CHANGED');
  const manifest=JSON.parse(manifestBytes);
  const entries=manifest.files.map(f=>{
    const filename=path.join(directory,f.path),stat=fs.lstatSync(filename);
    if(!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(filename)!==path.resolve(filename)) fail('GRAY_BUNDLE_HASH_CHANGED');
    const bytes=fs.readFileSync(filename);
    if(bytes.length!==f.bytes || hash(bytes)!==f.sha256) fail('GRAY_BUNDLE_HASH_CHANGED');
    return {name:f.path,bytes};
  });
  return { entries:[...entries,{name:'manifest.json',bytes:manifestBytes}] };
}
function validateAssembledConfiguration(variables) {
  const files=materializePhotoProductionFiles({env:variables});
  try {
    const config=photoProductionConfig({...variables,...files.paths});
    if(config.env!==0 || config.mode!=='closed' || config.generationEnabled || config.processEnabled
      || config.cleanupEnabled || config.reconcileEnabled || config.products.length || config.approvedEffects.length)
      fail('GRAY_CLOSED_CONFIGURATION_INVALID');
  } finally {files.cleanup();}
}
export async function prepareGray(adapter, { bundle, manifestSha256, write = saveState,
  read = readState, inspect = inspectProductionCloud, inputs } = {}) {
  if (read()) fail('GRAY_PENDING_EXISTS');
  const entries = bundleEntries(bundle,manifestSha256), zip = await packageBundle(entries);
  const inventories = await inspect(adapter), before = inventories.find(x => x.serverName === grayTarget.serverName);
  const beforeControl = validateGrayPredecessor(before);
  const load = filename => dotenv.parse(privateRead(path.join(server,filename)));
  const source = inputs || { payment:load('.env.mini-payment'),production:load('.env.mini-production'),
    database:load('.env.mini-production-db'),media:load('.env'),
    policyBytes:fs.readFileSync(path.join(server,'docs/production-config/closed-policy-2026-10-12.json')),
    acceptanceBytes:fs.readFileSync(path.join(server,'evidence/mini-photo-synthetic-generation-v4.json')),
    acceptanceSha256:'f8cc698254966ab46c22ef60bbfa7c2b47cb82d5705483d45043a9f944a37dde' };
  const profile = buildMiniProductionCloudProfile({ ...source,sessionEncryptionKey:crypto.randomBytes(32).toString('hex') });
  validateAssembledConfiguration(profile.variables);
  const old = parseEnv(before.base);
  if (['WECHAT_APP_ID','XPAY_OFFER_ID','XPAY_MESSAGE_TOKEN','XPAY_MESSAGE_AES_KEY'].some(k => profile.variables[k] !== old[k]))
    fail('GRAY_CALLBACK_CONFIGURATION_CHANGED');
  const id = crypto.randomBytes(12).toString('hex'), remark = `mini-photo-production closed env0 gray ${id}`;
  const record = { version:1,id,target:grayTarget,phase:'prepared',createdAt:new Date().toISOString(),
    bundle,manifestSha256,zipSha256:hash(zip),zipBytes:zip.length,remark,before, beforeControl,
    variables:profile.variables, desiredConfig:normalizedConfig({ ...before.base, envParams:JSON.stringify(profile.variables) }) };
  write(record,null); return safeGrayState(record);
}
export async function deployGray(adapter, { read = readState, write = saveState, inspect = inspectProductionCloud,
  zipBundle = async record => packageBundle(bundleEntries(record.bundle,record.manifestSha256)) } = {}) {
  let record = read();
  if (!record || record.phase !== 'prepared') fail('GRAY_NOT_PREPARED_OR_REQUEST_UNCERTAIN');
  validateGrayRecord(record);
  validateAssembledConfiguration(record.variables);
  const bytes = await zipBundle(record);
  if (hash(bytes) !== record.zipSha256 || bytes.length !== record.zipBytes) fail('GRAY_ARCHIVE_CHANGED');
  const inventory = async () => (await inspect(adapter)).find(x => x.serverName === grayTarget.serverName);
  const fresh = await inventory();
  if (!same(validateGrayPredecessor(fresh),record.beforeControl)
      || !same(comparableBase(fresh.base),comparableBase(record.before.base))) fail('GRAY_PREDECESSOR_CHANGED');
  const save = (phase,extra={}) => { const next={...record,...extra,phase}; write(next,record); record=next; };
  save('configure_requested');
  await adapter.CloudAPI.tcbUpdateServerBaseConfig({ ...scope, wxAppId:grayTarget.appId, conf:record.desiredConfig });
  verifyGrayBeforeRelease(await inventory(),record); save('configured');
  save('upload_authorization_requested');
  const upload = await adapter.api.DescribeCloudBaseBuildService({ EnvId:grayTarget.envId,ServiceName:grayTarget.serverName });
  const url = new URL(upload.UploadUrl);
  if (url.protocol !== 'https:' || url.username || url.password || url.port
      || (!/\.(myqcloud\.com|tencentcos\.cn)$/.test(url.hostname) && url.hostname !== 'cloudbaserun-code-cos.cloudbase.net')
      || !upload.PackageName || !upload.PackageVersion) fail('GRAY_UPLOAD_DESTINATION_INVALID');
  save('upload_ready',{packageName:upload.PackageName,packageVersion:upload.PackageVersion});
  save('upload_requested');
  const response = await adapter.axios.put(url.toString(),bytes,{headers:{'content-type':'application/zip'},timeout:60000,maxRedirects:0});
  if (![200,204].includes(response.status)) fail('GRAY_UPLOAD_UNCONFIRMED');
  save('uploaded'); verifyGrayBeforeRelease(await inventory(),record);
  save('release_requested',{releaseRequestedAt:new Date().toISOString()});
  const release = await adapter.CloudAPI.tcbSubmitServerRelease({ ...scope,wxAppId:grayTarget.appId,deployType:'package',
    releaseType:'GRAY',hasDockerfile:true,buildDir:'.',dockerfile:'Dockerfile',port:3000,
    packageName:record.packageName,packageVersion:record.packageVersion,versionRemark:record.remark,operatorRemark:record.remark });
  if (!Number.isSafeInteger(release.taskId) || release.taskId < 1) fail('GRAY_RELEASE_UNCONFIRMED');
  save('submitted',{taskId:release.taskId}); return safeGrayState(record);
}
export function safeGrayState(record) {
  return record ? { operationId:record.id,phase:record.phase,taskId:record.taskId||null,
    manifestSha256:record.manifestSha256,zipSha256:record.zipSha256,zipBytes:record.zipBytes,
    paymentEnvironment:0,mode:'closed',releaseType:'GRAY',promoted:false } : {prepared:false};
}
export async function grayStatus(adapter, record=readState()) {
  if (!record) return safeGrayState(record);
  validateGrayRecord(record);
  const inventories = await inspectProductionCloud(adapter), item = inventories.find(x=>x.serverName===grayTarget.serverName);
  const task = record.taskId ? (await adapter.CloudAPI.tcbDescribeServerManageTask({...scope,taskId:record.taskId})).task : item.task;
  const next = item.versions.filter(v=>v.Remark===record.remark);
  const beforeActive = item.active.find(v=>v.versionName===grayTarget.predecessor);
  const inScope = value => value && (value.envId === undefined || value.envId === grayTarget.envId)
    && (value.serverName === undefined || value.serverName === grayTarget.serverName);
  const currentTaskMatches = Number.isSafeInteger(record.taskId) && record.taskId > 0
    && item.task?.id === record.taskId && task?.id === record.taskId && inScope(item.task) && inScope(task);
  // Zero-flow versions are absent from inventory.active. Read the one version
  // correlated to this journal explicitly; the service's base config alone
  // cannot establish what environment the candidate actually received.
  const candidate = record.phase === 'submitted' && currentTaskMatches && next.length === 1
    && !record.before.versions.some(v=>v.VersionName===next[0].VersionName) ? next[0] : null;
  // @wxcloud/cloudapi 1.1.4 maps cpu/mem from CpuSize/MemSize (observed as 0
  // for fractional resources), while the official response's Cpu/Mem carry
  // the actual 0.25/0.5 allocation. Use that response without coercion.
  const rawDetail = candidate ? await adapter.api.DescribeCloudBaseRunServerVersion({
    EnvId:grayTarget.envId,ServerName:grayTarget.serverName,VersionName:candidate.VersionName }) : null;
  const detail = rawDetail ? { versionName:rawDetail.VersionName,serverName:rawDetail.ServerName,envId:rawDetail.EnvId,
    envParams:rawDetail.EnvParams,containerPort:rawDetail.ContainerPort,status:rawDetail.Status,
    minNum:rawDetail.MinNum,maxNum:rawDetail.MaxNum,cpu:rawDetail.Cpu,mem:rawDetail.Mem } : null;
  const candidateIdentityVerified = Boolean(detail && detail.versionName === candidate.VersionName && inScope(detail));
  const environmentMatches = (actual, expected) => {
    try { return Boolean(actual) && same(parseEnv(actual),parseEnv(expected)); } catch { return false; }
  };
  const newVersionEnvironmentVerified = candidateIdentityVerified && environmentMatches(detail,record.desiredConfig);
  const newVersionBasicConfigurationVerified = candidateIdentityVerified && candidate.Status === 'normal' && detail.status === 'normal'
    && detail.containerPort === 3000
    && ['minNum','maxNum','cpu','mem'].every(key=>detail[key] === record.desiredConfig[key]);
  const newVersionZeroFlowVerified = candidateIdentityVerified && candidate.FlowRatio === 0;
  const predecessorFlowUnchanged = same(versionSummary(item.versions.filter(v=>v.FlowRatio>0)),
    versionSummary(record.before.versions.filter(v=>v.FlowRatio>0)));
  const privateIngressVerified = same(item.domain.AccessTypes,['MINIAPP'])
    && same(item.base.openAccessTypes,['MINIAPP']) && [false,null,undefined].includes(item.base.publicAccess);
  return { ...safeGrayState(record), cloud:{ taskId:task?.id,status:task?.status,
    steps:task?.steps?.map(s=>({name:s.name,type:s.type,status:s.status})),
    flow:versionSummary(item.versions).filter(v=>v.flow>0 || next.some(n=>n.VersionName===v.name)),
    oldVersionEnvironmentUnchanged: environmentMatches(beforeActive,record.before.active[0]),
    currentTaskMatches, candidateVersion:candidateIdentityVerified ? candidate.VersionName : null,
    newVersionEnvironmentVerified,newVersionBasicConfigurationVerified,newVersionZeroFlowVerified,
    predecessorFlowUnchanged,privateIngressVerified,startupVerified:false } };
}

async function withLock(operation) {
  const token=crypto.randomBytes(24).toString('hex'); privateCreate(lockFile,token);
  try { return await operation(); } finally { if (privateRead(lockFile)===token) fs.unlinkSync(lockFile); }
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const [action,bundle,manifestSha256,...rest]=process.argv.slice(2);
    if (rest.length || !['prepare','deploy','status'].includes(action)
        || (action==='prepare' ? !bundle || !/^[a-f0-9]{64}$/.test(manifestSha256||'') : bundle!==undefined)) fail('GRAY_ARGUMENT_INVALID');
    const run=()=>withProductionCloud(adapter=>action==='prepare'?prepareGray(adapter,{bundle,manifestSha256})
      :action==='deploy'?deployGray(adapter):grayStatus(adapter));
    const result=await(action==='status'?run():withLock(run)); console.log(JSON.stringify(result));
  } catch(error) {
    console.error(/^GRAY_[A-Z_]+$/.test(error?.message)?error.message:'GRAY_OPERATION_UNCONFIRMED'); process.exitCode=1;
  }
}
