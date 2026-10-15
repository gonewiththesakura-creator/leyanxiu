import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

// Read-only inventory by default; --resume-database explicitly resumes the existing paused DB.
// No CLI login persistence, deployment, or secret logging.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(server, '.env.mini-cloud');
const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);
// Never emit transport messages: SDK errors may embed authentication headers.
const inventoryFailure = error => {
  const message = String(error?.message || '');
  if (error instanceof TypeError && /is not a function/.test(message)) return 'SDK_METHOD_UNAVAILABLE';
  if (/permission|unauthori[sz]ed|access.?denied|权限|无权/i.test(message)) return 'PERMISSION_DENIED';
  if (/timeout|timed.?out|超时/i.test(message)) return 'REQUEST_TIMEOUT';
  const code = String(error?.Code || error?.code || '');
  if (/^[A-Za-z0-9_.-]{1,100}$/.test(code)) return code;
  // @wxcloud/cloudapi wraps provider codes into Error.message. Extract only
  // recognized code families, never the provider message or request contents.
  const wrapped = message.match(/^((?:UnknownParameter|InvalidParameter|MissingParameter|UnauthorizedOperation|AuthFailure|ResourceNotFound|FailedOperation|InternalError|LimitExceeded|UnsupportedOperation)(?:\.[A-Za-z0-9_]+)*), /);
  return wrapped?.[1] || 'XPAY_NETWORK_INVENTORY_UNCONFIRMED';
};
// The SDK can log raw transport errors; keep inventory output allowlisted.
console.log = () => {};
try {
  const env = dotenv.parse(fs.readFileSync(file));
  if (env.WXCLOUD_APP_ID !== 'REDACTED_APP_IDENTIFIER') throw new Error('XPAY_CLOUD_APPID_MISMATCH');
  if (!env.WXCLOUD_PRIVATE_KEY?.trim()) throw new Error('XPAY_CLOUD_CLI_KEY_REQUIRED');
  const cliRoot = process.env.WXCLOUD_CLI_ROOT || path.join(process.env.LOCALAPPDATA || '', 'leyanxiu-toolchains', 'wxcloud-cli', 'node_modules', '@wxcloud', 'cli');
  const require = createRequire(path.join(cliRoot, 'package.json'));
  const { logger } = require('./lib/utils/log.js'); logger.debug = () => {};
  const axios = require('axios'); axios.defaults.timeout = 15000;
  const auth = require('./lib/utils/auth.js');
  const state = { appid: env.WXCLOUD_APP_ID, privateKey: env.WXCLOUD_PRIVATE_KEY.trim() };
  auth.readLoginState = async () => state;
  if (!await auth.checkLoginState(state.appid, state.privateKey)) throw new Error('XPAY_CLOUD_CLI_AUTH_FAILED');
  require('./lib/api/adapter.js').initCloudAPI(state.appid);
  require('./lib/api/common.js').setApiCommonParameters({ region: 'ap-shanghai' });
  const { EnvList } = await require('./lib/api/index.js').DescribeWxCloudBaseRunEnvs();
  report({ authenticated: true, changedRemoteState: false, environments: EnvList.map(x => ({ id: x.EnvId, name: x.Alias })) });
  if (process.argv.includes('--network')) {
    const { CloudAPI } = require('@wxcloud/core');
    const envId = 'leyanxiu-prod-d5gimob8af6a6e5c9';
    // The official CLI adapter already supplies the region in its API envelope.
    // SDK 1.1.4 leaves opts.region in the JSON body, which some read APIs reject
    // with UnknownParameter. Omit that optional body field consistently.
    report({ check: 'networkInventoryScope', scope: 'current_wechat_environment',
      accountWideVpcInventory: false, accountWideDatabaseInventory: false, changedRemoteState: false });
    const checks = [
      ['architecture', () => CloudAPI.tcbrDescribeArchitectureType({}), x => ({ architectureType: x.architectureType })],
      ['environmentNetwork', () => CloudAPI.tcbDescribeCloudBaseRunResource({ envId, needSubnet: true }), x => ({
        status: x.clusterStatus, vpcId: x.vpcId, region: x.region,
        subnets: x.subnetIds?.map(s => ({ id: s.id, cidr: s.cidr, zone: s.zone, region: s.region, type: s.type })) ?? [],
        accountVpcAbsenceConfirmed: false,
      })],
      ['existingPeering', () => CloudAPI.tcbDescribeCloudRunPeeringConnection({ envId }), x => ({
        count: x.totalCount, connections: x.peeringConnectionInfos?.map(p => ({ envId: p.envId, vpcId: p.userVpcId, status: p.status })) ?? [],
      })],
      ['peeringQuota', () => CloudAPI.tcbDescribeCloudRunPeeringConnectionQuota({ envId }), x => ({ quota: x.quota })],
      ['databaseNetwork', () => CloudAPI.tcbDescribeWxCloudBaseRunDBClusterDetail({ envId, wxAppId: state.appid }), x => ({
        instanceId: x.dbClusterId, network: x.netInfo?.net, privateAddress: x.netInfo?.privateNetAddress,
        publicAccess: x.dbInfo?.isOpenPubNetAccess, publicAddressPresent: Boolean(x.netInfo?.pubNetAddress),
        status: x.dbInfo?.status, autoPause: x.dbInfo?.isOpenAutoPause,
        minCpu: x.dbInfo?.minCpu, maxCpu: x.dbInfo?.maxCpu,
      })],
      ['databaseAccounts', () => CloudAPI.tcbDescribeWxCloudBaseRunDBAccounts({ envId, wxAppId: state.appid }), x => ({
        status: x.clusterStatus,
        accountsEnumerationConfirmed: Array.isArray(x.accounts)
          && (x.accounts.length > 0 || ['running', 'normal'].includes(String(x.clusterStatus).toLowerCase())),
        accounts: x.accounts?.map(a => ({ name: a.accountName, host: a.host, privileges: a.privileges })) ?? [],
      })],
    ];
    await Promise.all(checks.map(async ([name, run, select]) => {
      try { report({ check: name, verified: true, changedRemoteState: false, ...select(await run()) }); }
      catch (error) { report({ check: name, verified: false,
        code: inventoryFailure(error) }); }
    }));
    for (const serverName of ['buildtest', 'leyanxiu-stage', 'leyanxiu-api']) {
      try {
        const { versionItems } = await CloudAPI.tcbDescribeCloudBaseRunServer({ envId, serverName, offset: 0, limit: 100 });
        for (const version of versionItems.filter(v => v.flowRatio > 0)) {
          const detail = await CloudAPI.tcbDescribeCloudBaseRunServerVersion({ envId, serverName, versionName: version.versionName });
          report({ check: 'serviceNetwork', service: serverName, version: version.versionName, flow: version.flowRatio,
            vpcId: detail.vpcId ?? null, subnetIds: detail.subnetIds ?? [], changedRemoteState: false });
        }
      } catch (error) { report({ check: 'serviceNetwork', service: serverName, verified: false,
        code: inventoryFailure(error) }); }
    }
  }
  if (process.argv.includes('--database') || process.argv.includes('--resume-database')) {
    const { CloudAPI } = require('@wxcloud/core');
    try {
      const result = await CloudAPI.tcbDescribeWxCloudBaseRunDBClusterDetail({ envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', wxAppId: state.appid });
      report({ database: { present: Boolean(result.dbClusterId), status: result.dbInfo?.status, type: result.dbInfo?.dbType,
        version: result.dbInfo?.dbVersion, publicAccess: result.dbInfo?.isOpenPubNetAccess, autoPause: result.dbInfo?.isOpenAutoPause } });
      if (process.argv.includes('--resume-database')) {
        if (result.dbClusterId !== 'cynosdbmysql-7jg96bj6') throw new Error('XPAY_DATABASE_INSTANCE_MISMATCH');
        if (result.dbInfo?.status === 'pause') {
          await CloudAPI.tcbResumeCloudBaseRunTdsql({ envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', wxAppId: state.appid });
          report({ databaseResumeRequested: true, changedRemoteState: true });
        } else report({ databaseResumeRequested: false, changedRemoteState: false });
      }
    } catch (error) {
      report({ database: { verified: false, code: String(error?.Code || error?.code || 'XPAY_DATABASE_INVENTORY_UNCONFIRMED').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100) } });
      if (process.argv.includes('--resume-database')) process.exitCode = 1;
    }
  }
  if (process.argv.includes('--runtime')) {
    const { CloudAPI } = require('@wxcloud/core');
    const envId = 'leyanxiu-prod-d5gimob8af6a6e5c9'; const serverName = 'buildtest';
    const { serviceBaseConfig: config } = await CloudAPI.tcbDescribeServiceBaseConfig({ envId, serverName });
    report({ service: serverName, config: { min: config.minNum, max: config.maxNum, cpu: config.cpu, memory: config.mem,
      port: config.port, logType: config.logType, internalAccess: config.internalAccess, accessTypes: config.openAccessTypes } });
    const { versionItems } = await CloudAPI.tcbDescribeCloudBaseRunServer({ envId, serverName, offset: 0, limit: 100 });
    for (const version of versionItems.filter(v => v.flowRatio > 0)) {
      const versionName = version.versionName;
      const details = await CloudAPI.tcbDescribeCloudBaseRunServerVersion({ envId, serverName, versionName });
      const pods = await CloudAPI.tcbDescribeCloudBaseRunPodList({ envId, serverName, versionName, offset: 0, limit: 100 });
      report({ version: versionName, status: version.status, flow: version.flowRatio, currentReplicas: version.currentReplicas,
        min: details.minNum, max: details.maxNum, port: details.containerPort, podCount: pods.totalCount,
        pods: pods.podList?.map(p => ({ id: p.podId, status: p.status, created: p.createTime })) });
    }
  }
  if (process.argv.includes('--domains')) {
    const api = require('./lib/api/index.js');
    for (const environment of EnvList) {
      const result = await api.DescribeCustomDomains({ EnvId: environment.EnvId });
      report({ environment: environment.EnvId, customDomains: result.DomainList?.map(d => ({
        domain: d.Domain, service: d.ServiceName, status: d.Status
      })) ?? [], count: result.DomainList?.length ?? 0 });
    }
  }
  if (process.argv.includes('--services')) {
    const api = require('./lib/api/index.js'); const { CloudAPI } = require('@wxcloud/core');
    for (const environment of EnvList) {
      const { CloudBaseRunServerSet } = await api.DescribeCloudBaseRunServers({ EnvId: environment.EnvId, Limit: 100, Offset: 0 });
      for (const item of CloudBaseRunServerSet) {
        const domain = await api.DescribeCloudBaseRunServiceDomain({ EnvId: environment.EnvId, ServiceName: item.ServerName });
        const { serviceBaseConfig: config } = await CloudAPI.tcbDescribeServiceBaseConfig({ envId: environment.EnvId, serverName: item.ServerName });
        report({ environment: environment.EnvId, service: item.ServerName, status: item.Status,
          domain: domain.DefaultPublicDomain, accessTypes: domain.AccessTypes,
          capacity: { min: config?.minNum, max: config?.maxNum, cpu: config?.cpu, memory: config?.mem } });
        if (process.argv.includes('--versions')) {
          const versions = await api.DescribeCloudBaseRunServer({ EnvId: environment.EnvId, ServerName: item.ServerName, Limit: 10, Offset: 0 });
          report({ service: item.ServerName, versions: versions.VersionItems?.map(v => ({ name: v.VersionName, status: v.Status, created: v.CreatedTime, updated: v.UpdatedTime, flow: v.FlowRatio, remark: v.Remark })) });
          if (item.ServerName === 'buildtest') {
            report({ service: item.ServerName, configKeys: Object.keys(config || {}),
              environmentKeys: Object.keys(JSON.parse(config?.envParams || '{}')),
              volumes: config?.volumeMounts?.map(v => ({ name: v.name, mountPath: v.mountPath })),
              accessTypes: config?.openAccessTypes, policyType: config?.policyType, customLogs: config?.customLogs });
          }
        }
      }
    }
  }
} catch (error) {
  const allowed = new Set(['XPAY_CLOUD_APPID_MISMATCH', 'XPAY_CLOUD_CLI_KEY_REQUIRED', 'XPAY_CLOUD_CLI_AUTH_FAILED']);
  console.error(allowed.has(error.message) ? error.message : 'XPAY_CLOUD_INVENTORY_FAILED'); process.exitCode = 1;
}
