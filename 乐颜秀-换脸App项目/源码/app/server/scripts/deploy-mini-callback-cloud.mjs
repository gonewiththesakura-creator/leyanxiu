import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createMessageCodec } from '../payments/virtual/wechat.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envId = 'leyanxiu-prod-d5gimob8af6a6e5c9'; const serviceName = 'buildtest';
const bundle = path.resolve(server, '../output/mini-callback-cloudpush-20260929.zip');
const expectedHash = 'e62c581cb2e81a3b2cd01bc5f7b647149b2cab847bcb351f9e3c7ff0471eb0a5';
const versionRemark = '20260929 mini-callback cloud-push verification-only no-sales';
const action = process.argv[2] || 'status';
const originalLog = console.log;
// The legacy CLI logs raw provider errors; suppress them and emit only allowlisted summaries.
console.log = () => {};
const report = value => originalLog(JSON.stringify(value));
let phase = 'authenticate';
try {
  const credentials = dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-cloud')));
  if (credentials.WXCLOUD_APP_ID !== 'REDACTED_APP_IDENTIFIER' || !credentials.WXCLOUD_PRIVATE_KEY?.trim()) throw new Error('XPAY_CLOUD_CONFIG_REQUIRED');
  const cliRoot = process.env.WXCLOUD_CLI_ROOT || path.join(process.env.LOCALAPPDATA, 'leyanxiu-toolchains/wxcloud-cli/node_modules/@wxcloud/cli');
  const require = createRequire(path.join(cliRoot, 'package.json'));
  require('./lib/utils/log.js').logger.debug = () => {};
  const axios = require('axios'); axios.defaults.timeout = 30000;
  const auth = require('./lib/utils/auth.js');
  auth.readLoginState = async () => ({ appid: credentials.WXCLOUD_APP_ID, privateKey: credentials.WXCLOUD_PRIVATE_KEY.trim() });
  require('./lib/api/adapter.js').initCloudAPI(credentials.WXCLOUD_APP_ID);
  require('./lib/api/common.js').setApiCommonParameters({ region: 'ap-shanghai' });
  const api = require('./lib/api/index.js'); const { CloudAPI, preprocessBaseConfig } = require('@wxcloud/core');
  if (action === 'deploy') {
    const bytes = fs.readFileSync(bundle);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== expectedHash) throw new Error('XPAY_BUNDLE_CHANGED');
    const variables = dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-callback')));
    if (variables.WECHAT_APP_ID !== credentials.WXCLOUD_APP_ID || variables.XPAY_ENABLED !== 'false' || variables.XPAY_MODE !== 'closed') throw new Error('XPAY_CALLBACK_CONFIG_INVALID');
    createMessageCodec({ appId: variables.WECHAT_APP_ID, token: variables.XPAY_MESSAGE_TOKEN, aesKey: variables.XPAY_MESSAGE_AES_KEY });
    const { VersionItems } = await api.DescribeCloudBaseRunServer({ EnvId: envId, ServerName: serviceName, Limit: 100, Offset: 0 });
    const previous = VersionItems.find(v => v.VersionName === 'buildtest-006');
    if (previous?.Status !== 'normal' || previous?.FlowRatio !== 100
      || previous?.Remark !== '20260929 mini-callback verification-only no-sales'
      || VersionItems.some(v => v !== previous && (!['build_failed', 'deploy_failed', 'create_failed'].includes(v.Status) || v.FlowRatio > 0))) throw new Error('XPAY_EXISTING_SERVICE_IN_USE');
    const { serviceBaseConfig: before } = await CloudAPI.tcbDescribeServiceBaseConfig({ envId, serverName: serviceName });
    const existingEnv = JSON.parse(before.envParams || '{}');
    if (Object.keys(existingEnv).length && (existingEnv.WECHAT_APP_ID !== variables.WECHAT_APP_ID
      || existingEnv.XPAY_MODE !== 'closed' || existingEnv.XPAY_ENABLED !== 'false'
      || existingEnv.XPAY_MESSAGE_TOKEN !== variables.XPAY_MESSAGE_TOKEN || existingEnv.XPAY_MESSAGE_AES_KEY !== variables.XPAY_MESSAGE_AES_KEY
      || Object.keys(existingEnv).some(k => !['WECHAT_APP_ID', 'XPAY_MODE', 'XPAY_ENABLED', 'XPAY_MESSAGE_TOKEN', 'XPAY_MESSAGE_AES_KEY', 'PORT', 'NODE_ENV'].includes(k)))) throw new Error('XPAY_EXISTING_SERVICE_HAS_CONFIG');
    const backup = path.join(server, 'data/mini-callback-before-deploy.json');
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (!fs.existsSync(backup)) fs.writeFileSync(backup, JSON.stringify({ envId, serviceName, before, versions: VersionItems.map(v => ({ name: v.VersionName, status: v.Status, flow: v.FlowRatio })) }, null, 2), { flag: 'wx', mode: 0o600 });
    const envParams = Object.fromEntries(['WECHAT_APP_ID', 'XPAY_MODE', 'XPAY_ENABLED', 'XPAY_MESSAGE_TOKEN', 'XPAY_MESSAGE_AES_KEY'].map(k => [k, variables[k]]));
    envParams.PORT = '3000'; envParams.NODE_ENV = 'production';
    await CloudAPI.tcbUpdateServerBaseConfig({ envId, serverName: serviceName, wxAppId: credentials.WXCLOUD_APP_ID,
      conf: { ...preprocessBaseConfig(before), cpu: 0.25, mem: 0.5, minNum: 0, maxNum: 1, timerScale: [],
        port: 3000, envParams: JSON.stringify(envParams), openAccessTypes: ['MINIAPP', 'PUBLIC'], publicAccess: true,
        logType: 'none', operatorRemark: 'mini-callback verification-only; sales closed' } });
    report({ stage: 'configured', service: serviceName, cpu: 0.25, memory: 0.5, min: 0, max: 1 });
    const upload = await api.DescribeCloudBaseBuildService({ EnvId: envId, ServiceName: serviceName });
    const uploadUrl = new URL(upload.UploadUrl);
    if (uploadUrl.protocol !== 'https:' || (!/\.(myqcloud\.com|tencentcos\.cn)$/.test(uploadUrl.hostname) && uploadUrl.hostname !== 'cloudbaserun-code-cos.cloudbase.net')) {
      report({ uploadProtocol: uploadUrl.protocol, uploadHost: uploadUrl.hostname });
      throw new Error('XPAY_UNEXPECTED_UPLOAD_HOST');
    }
    await axios.put(upload.UploadUrl, bytes, { headers: { 'content-type': 'application/zip' }, maxRedirects: 0, timeout: 60000 });
    report({ stage: 'uploaded', sha256: expectedHash, containsSecrets: false });
    await api.SubmitServerRelease({ EnvId: envId, ServerName: serviceName, WxAppId: credentials.WXCLOUD_APP_ID,
      DeployType: 'package', ReleaseType: 'FULL', HasDockerfile: true, BuildDir: '.', Dockerfile: 'Dockerfile', Port: 3000,
      PackageName: upload.PackageName, PackageVersion: upload.PackageVersion, VersionRemark: versionRemark });
    report({ stage: 'submitted', service: serviceName });
  } else if (!['status', 'logs', 'private'].includes(action)) throw new Error('XPAY_ACTION_INVALID');
  phase = 'read task';
  const { task } = await CloudAPI.tcbDescribeServerManageTask({ envId, serverName: serviceName });
  phase = 'read versions';
  const { VersionItems } = await api.DescribeCloudBaseRunServer({ EnvId: envId, ServerName: serviceName, Limit: 100, Offset: 0 });
  const latest = VersionItems.find(v => v.VersionName === task?.versionName);
  if (action === 'private') {
    if (latest?.Status !== 'normal' || latest?.FlowRatio !== 100 || latest?.Remark !== versionRemark) throw new Error('XPAY_CALLBACK_VERSION_NOT_READY');
    await CloudAPI.tcbModifyCloudBaseRunServiceDomain({ envId, serviceName, openAccessTypes: [], closeAccessTypes: ['PUBLIC'] });
  }
  if (action === 'logs' && latest) {
    phase = 'read build metadata';
    const { versionItems } = await CloudAPI.tcbDescribeCloudBaseRunServer({ envId, serverName: serviceName, versionName: latest.VersionName, offset: 0, limit: 1 });
    const version = versionItems[0];
    if (version?.buildId) {
      phase = 'read build logs';
      const result = await api.DescribeCloudBaseRunBuildLog({ EnvId: envId, ServiceVersion: latest.VersionName, BuildId: version.buildId });
      let log = String(result.Log?.Text || '');
      const privateValues = Object.values(dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-callback'))));
      for (const value of [credentials.WXCLOUD_PRIVATE_KEY, ...privateValues].filter(x => x?.length > 8)) log = log.replaceAll(value, '[REDACTED]');
      log = log.replace(/https?:\/\/[^\s<>"']+/g, '[URL]');
      report({ buildLog: log.slice(-6000) });
    } else report({ buildLog: 'not available', buildStatus: version?.buildStatus, versionStatus: version?.status });
  }
  const domain = await api.DescribeCloudBaseRunServiceDomain({ EnvId: envId, ServiceName: serviceName });
  report({ task: { status: task?.status, version: task?.versionName, steps: task?.steps?.map(s => ({ name: s.name, status: s.status })) },
    version: latest && { name: latest.VersionName, status: latest.Status, flow: latest.FlowRatio }, domain: domain.DefaultPublicDomain, accessTypes: domain.AccessTypes });
} catch (error) {
  report({ failed: true, phase, type: error?.name, code: /^XPAY_[A-Z_]+$/.test(error?.message) ? error.message : String(error?.Code || error?.code || 'XPAY_CLOUD_OPERATION_UNCONFIRMED').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) });
  process.exitCode = 1;
}
