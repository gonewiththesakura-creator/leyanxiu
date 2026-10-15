import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const APP_ID = 'REDACTED_APP_IDENTIFIER';
const ENV_ID = 'cloudbase-d5gffahoe587434de';
const REGION = 'ap-shanghai';
const FUNCTION_NAME = 'lyx-xpay-probe-20261002';
const ORIGINAL_ID = 'gh_e10505858237';
const RUNTIME = 'Nodejs18.15';
const PROBE_COLLECTION = 'lyx_xpay_probe_health';
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliRoot = process.env.WXCLOUD_CLI_ROOT || path.join(process.env.LOCALAPPDATA || '',
  'leyanxiu-toolchains', 'wxcloud-cli', 'node_modules', '@wxcloud', 'cli');
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const safeCode = error => String(error?.Code || error?.code || 'XPAY_CLOUD_FUNCTION_UNCONFIRMED')
  .replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100);

function apiContext() {
  const env = dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-cloud')));
  if (env.WXCLOUD_APP_ID !== APP_ID || !env.WXCLOUD_PRIVATE_KEY?.trim()) throw new Error('XPAY_CLOUD_CONFIG_REQUIRED');
  const require = createRequire(path.join(cliRoot, 'package.json'));
  const auth = require(path.join(cliRoot, 'lib/utils/auth.js'));
  auth.readLoginState = async () => ({ appid: APP_ID, privateKey: env.WXCLOUD_PRIVATE_KEY.trim() });
  require(path.join(cliRoot, 'lib/api/adapter.js')).initCloudAPI(APP_ID);
  require(path.join(cliRoot, 'lib/api/common.js')).setApiCommonParameters({ region: REGION });
  const { CloudAPI } = require('@wxcloud/core');
  const zip = require(path.join(cliRoot, 'lib/utils/jszip.js'));
  return { env, require, CloudAPI, zip };
}

async function bundle(zip) {
  // The builder intentionally requires a new, non-existent absolute path.
  const output = path.join(os.tmpdir(), `lyx-xpay-probe-bundle-${crypto.randomBytes(8).toString('hex')}`);
  const builder = path.join(server, 'scripts/build-mini-payment-cloud-function-probe.mjs');
  const { spawn } = await import('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [builder, output], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`XPAY_PROBE_BUILD_FAILED:${stderr || stdout}`)));
  });
  const archive = zip.zipFile(output, { includeRoot: false });
  const bytes = await zip.zipToBuffer(archive);
  return { output, bytes, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

async function functionInfo(CloudAPI) {
  const originalError = console.error;
  console.error = () => {};
  try {
    return await CloudAPI.scfGetFunctionInfo({ namespace: ENV_ID, region: REGION, functionName: FUNCTION_NAME });
  } catch (error) {
    if (error?.code === 'ResourceNotFound.Function' || error?.Code === 'ResourceNotFound.Function'
      || String(error?.message || '').includes('ResourceNotFound.Function')
      || String(error).includes('ResourceNotFound.Function')) return null;
    throw error;
  } finally {
    console.error = originalError;
  }
}

async function waitActive(CloudAPI) {
  const started = Date.now();
  while (Date.now() - started < 180000) {
    const info = await functionInfo(CloudAPI);
    if (info?.status === 'Active') return info;
    if (['CreateFailed', 'UpdateFailed', 'DeleteFailed'].includes(info?.status)) throw new Error(`XPAY_PROBE_FUNCTION_${info.status.toUpperCase()}`);
    await new Promise(resolve => setTimeout(resolve, 3000));
  }
  throw new Error('XPAY_PROBE_FUNCTION_TIMEOUT');
}

async function probeDatabase(CloudAPI) {
  const result = await CloudAPI.tcbGetEnvironments({ envId: ENV_ID, appId: APP_ID });
  const environment = result.envList?.find(item => item.envId === ENV_ID);
  if (environment?.status !== 'NORMAL' || environment.source !== 'miniapp'
    || (environment.region !== undefined && environment.region !== REGION)
    || !environment.functions?.some(item => item.namespace === ENV_ID && item.region === REGION)
    || environment.databases?.length !== 1) {
    throw new Error('XPAY_PROBE_DATABASE_IDENTITY_UNCONFIRMED');
  }
  const database = environment.databases[0];
  if (database.status !== 'RUNNING' || database.region !== REGION || !database.instanceId) {
    throw new Error('XPAY_PROBE_DATABASE_NOT_RUNNING');
  }
  return database;
}

async function assertProbeACL(CloudAPI) {
  const acl = await CloudAPI.tcbDescribeSafeRule({ region: REGION, envId: ENV_ID,
    collectionName: PROBE_COLLECTION });
  if (acl.aclTag !== 'ADMINONLY') throw new Error('XPAY_PROBE_DATABASE_ACL_UNCONFIRMED');
}

const action = process.argv[2] || 'status';
if (!['status', 'plan', 'deploy', 'update', 'prepare-db', 'invoke', 'logs'].includes(action)) throw new Error('XPAY_PROBE_ACTION_INVALID');
let changedRemoteState = false;
let operationStage = 'initialize';
console.log = () => {};
console.error = () => {};
try {
  const { CloudAPI, zip } = apiContext();
  const current = await functionInfo(CloudAPI);
  if (action === 'status') {
    emit({ changedRemoteState: false, environment: ENV_ID, function: current && { name: current.functionName, status: current.status, runtime: current.runtime, handler: current.handler, timeout: current.timeout, memory: current.memorySize, description: current.description } });
  } else if (action === 'plan') {
    const built = await bundle(zip);
    emit({ changedRemoteState: false, action, environment: ENV_ID, function: FUNCTION_NAME, runtime: RUNTIME, bundleSha256: built.sha256, bundleBytes: built.bytes.length, existing: Boolean(current), deployment: 'isolated-verification-only', salesEnabled: false });
  } else if (action === 'deploy') {
    if (current) throw new Error('XPAY_PROBE_FUNCTION_ALREADY_EXISTS');
    const built = await bundle(zip);
    const variables = [
      { key: 'WECHAT_APP_ID', value: APP_ID },
      { key: 'WECHAT_MINIPROGRAM_ORIGINAL_ID', value: ORIGINAL_ID },
      { key: 'XPAY_MODE', value: 'closed' },
      { key: 'XPAY_ENABLED', value: 'false' },
      { key: 'XPAY_PROBE_ENV', value: '1' },
      { key: 'XPAY_PROBE_SYNTHETIC_ENABLED', value: 'false' },
    ];
    changedRemoteState = true;
    await CloudAPI.scfCreateFunction({
      functionName: FUNCTION_NAME,
      code: { zipFile: built.bytes.toString('base64') },
      handler: 'index.main',
      description: 'verification-only mini-program virtual-payment probe; sales disabled',
      memorySize: 256,
      timeout: 10,
      environment: { variables },
      role: 'TCB_QcsRole',
      runtime: RUNTIME,
      namespace: ENV_ID,
      region: REGION,
      stamp: 'MINI_QCBASE',
      installDependency: true,
    });
    const info = await waitActive(CloudAPI);
    emit({ changedRemoteState: true, action, environment: ENV_ID, function: FUNCTION_NAME, status: info.status, runtime: info.runtime, handler: info.handler, bundleSha256: built.sha256, bundleBytes: built.bytes.length, salesEnabled: false, callbackChanged: false });
  } else if (action === 'update') {
    if (!current) throw new Error('XPAY_PROBE_FUNCTION_NOT_FOUND');
    const expectedDescription = 'verification-only mini-program virtual-payment probe; sales disabled';
    if (current.runtime !== RUNTIME || current.handler !== 'index.main'
      || (current.description !== undefined && !String(current.description).includes(expectedDescription))) {
      throw new Error('XPAY_PROBE_FUNCTION_IDENTITY_MISMATCH');
    }
    const built = await bundle(zip);
    changedRemoteState = true;
    await CloudAPI.scfUpdateFunction({
      functionName: FUNCTION_NAME,
      namespace: ENV_ID,
      region: REGION,
      handler: 'index.main',
      installDependency: true,
      fileData: built.bytes.toString('base64'),
    });
    const info = await waitActive(CloudAPI);
    emit({ changedRemoteState: true, action, environment: ENV_ID, function: FUNCTION_NAME, status: info.status, runtime: info.runtime, handler: info.handler, bundleSha256: built.sha256, bundleBytes: built.bytes.length, salesEnabled: false, callbackChanged: false });
  } else if (action === 'prepare-db') {
    if (process.argv.length > 3) throw new Error('XPAY_PROBE_ACTION_INVALID');
    if (!current || current.status !== 'Active') throw new Error('XPAY_PROBE_FUNCTION_NOT_ACTIVE');
    operationStage = 'database-identity';
    const database = await probeDatabase(CloudAPI);
    const listOptions = { region: REGION, tag: database.instanceId, mgoLimit: 100, mgoOffset: 0 };
    operationStage = 'collection-inventory';
    const before = await CloudAPI.flexdbListTables(listOptions);
    if (before.pager?.total > before.tables?.length) throw new Error('XPAY_PROBE_COLLECTION_INVENTORY_INCOMPLETE');
    const existed = before.tables?.some(table => table.tableName === PROBE_COLLECTION);
    if (!existed) {
      changedRemoteState = true;
      operationStage = 'create-collection';
      await CloudAPI.flexdbCreateTable({ region: REGION, tag: database.instanceId, tableName: PROBE_COLLECTION });
    }
    changedRemoteState = true;
    operationStage = 'set-client-deny';
    await CloudAPI.tcbModifyDatabaseACL({ region: REGION, envId: ENV_ID,
      collectionName: PROBE_COLLECTION, appId: APP_ID, aclTag: 'ADMINONLY' });
    operationStage = 'verify-client-deny';
    await assertProbeACL(CloudAPI);
    operationStage = 'verify-collection';
    const after = await CloudAPI.flexdbListTables(listOptions);
    const collection = after.tables?.find(table => table.tableName === PROBE_COLLECTION);
    if (!collection) throw new Error('XPAY_PROBE_COLLECTION_UNCONFIRMED');
    emit({ changedRemoteState, action, environment: ENV_ID, collection: PROBE_COLLECTION,
      created: !existed, acl: 'ADMINONLY', ...(Number.isSafeInteger(collection.count) ? { documentCount: collection.count } : {}),
      verified: true, salesEnabled: false, callbackChanged: false });
  } else if (action === 'invoke') {
    if (!current) throw new Error('XPAY_PROBE_FUNCTION_NOT_FOUND');
    if (current.status !== 'Active') throw new Error('XPAY_PROBE_FUNCTION_NOT_ACTIVE');
    const probe = process.argv[3] ?? 'echo';
    if (!['echo', 'db', 'closed'].includes(probe) || process.argv.length > 4) throw new Error('XPAY_PROBE_INVOCATION_INVALID');
    if (probe !== 'echo') {
      await probeDatabase(CloudAPI);
      await assertProbeACL(CloudAPI);
    }
    changedRemoteState = probe !== 'echo';
    const clientContext = JSON.stringify({ action: probe === 'echo' ? 'probe_echo' : 'probe_db', synthetic: true,
      runId: crypto.randomBytes(6).toString('hex'), Env: 1, ToUserName: ORIGINAL_ID });
    // The high-level wrapper discards the synchronous result. Reuse its
    // initialized adapter, but never print the raw result, log, or SDK error.
    const originalLog = console.log;
    const originalError = console.error;
    let raw;
    let invocationFailed = false;
    try {
      console.log = () => {};
      console.error = () => {};
      raw = await CloudAPI.transact(CloudAPI.scfInvokeFunctionContract, {
        Action: 'Invoke', Version: '2018-04-16', Region: REGION, FunctionName: FUNCTION_NAME,
        Namespace: ENV_ID, InvocationType: 'RequestResponse', Qualifier: '$LATEST',
        ClientContext: clientContext, LogType: 'Tail',
      }, { autoRecord: false });
    } catch {
      invocationFailed = true;
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    const result = raw?.Result;
    let response;
    try {
      const parsed = typeof result?.RetMsg === 'string' && result.RetMsg.length <= 8192 ? JSON.parse(result.RetMsg) : null;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) response = parsed;
    } catch { /* return a fixed unconfirmed code, never raw RetMsg */ }
    const evidence = {};
    for (const key of ['synthetic', 'businessAcknowledged', 'database', 'committed', 'roundTrip', 'removed']) {
      if (typeof response?.evidence?.[key] === 'boolean') evidence[key] = response.evidence[key];
    }
    const errMsg = response?.ErrMsg === 'success' || /^XPAY_[A-Z0-9_]+$/.test(response?.ErrMsg)
      ? response.ErrMsg : 'XPAY_PROBE_RESPONSE_UNCONFIRMED';
    const expectedProbe = probe === 'db' ? 'database' : 'echo';
    const verified = !invocationFailed && result?.InvokeResult === 0 && evidence.synthetic === true
      && (probe === 'closed'
        ? response?.ErrCode === 1 && errMsg === 'XPAY_PROBE_SYNTHETIC_DISABLED' && evidence.businessAcknowledged === false
        : response?.ErrCode === 0 && errMsg === 'success' && response?.Probe === expectedProbe
          && (probe === 'db' ? evidence.database === true && evidence.committed === true
            && evidence.roundTrip === true && evidence.removed === true : evidence.businessAcknowledged === false));
    if (probe === 'closed' && verified) changedRemoteState = false;
    emit({ changedRemoteState, action, probe, environment: ENV_ID, function: FUNCTION_NAME,
      ...(typeof result?.FunctionRequestId === 'string' && /^[a-f0-9-]{36}$/i.test(result.FunctionRequestId)
        ? { requestId: result.FunctionRequestId } : {}),
      ...(Number.isInteger(result?.InvokeResult) ? { invokeResult: result.InvokeResult } : {}),
      ...(Number.isInteger(response?.ErrCode) ? { ErrCode: response.ErrCode } : {}),
      ErrMsg: invocationFailed ? 'XPAY_PROBE_INVOKE_UNCONFIRMED' : errMsg,
      ...(['echo', 'database', 'verification-only'].includes(response?.Probe) ? { Probe: response.Probe } : {}),
      evidence, verified,
      ...(probe !== 'echo' ? { syntheticDatabaseWriteMayHaveOccurred: changedRemoteState } : {}),
    });
    if (!verified) process.exitCode = 1;
  } else if (action === 'logs') {
    if (!current) throw new Error('XPAY_PROBE_FUNCTION_NOT_FOUND');
    const requestId = process.argv[3];
    const result = await CloudAPI.scfGetFunctionLogs({ namespace: ENV_ID, region: REGION, functionName: FUNCTION_NAME,
      offset: 0, limit: requestId ? 10 : 5, ...(requestId ? { functionRequestId: requestId } : {}) });
    emit({ changedRemoteState: false, action, environment: ENV_ID, function: FUNCTION_NAME,
      logs: (result.data || []).map(item => ({
        ...(typeof item.requestId === 'string' && /^[a-f0-9-]{36}$/i.test(item.requestId) ? { requestId: item.requestId } : {}),
        ...(Number.isInteger(item.retCode) ? { retCode: item.retCode } : {}),
        ...(typeof item.invokeFinished === 'boolean' ? { invokeFinished: item.invokeFinished } : {}),
        ...(Number.isFinite(item.duration) ? { duration: item.duration } : {}),
      })) });
  }
} catch (error) {
  const code = /^XPAY_[A-Z0-9_]+$/.test(error?.message) ? error.message : safeCode(error);
  const messageCode = /^([A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)*), /.exec(error?.message || '')?.[1];
  const errorCode = [error?.Code, error?.code, error?.response?.data?.Response?.Error?.Code, messageCode,
    error?.response?.data?.Error?.Code].find(value => typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_.]{0,99}$/.test(value));
  emit({ changedRemoteState, action, environment: ENV_ID, function: FUNCTION_NAME, verified: false, code,
    operationStage, ...(errorCode ? { apiCode: errorCode } : {}),
    ...(Number.isSafeInteger(error?.response?.status) ? { httpStatus: error.response.status } : {}),
  });
  process.exitCode = 1;
}
