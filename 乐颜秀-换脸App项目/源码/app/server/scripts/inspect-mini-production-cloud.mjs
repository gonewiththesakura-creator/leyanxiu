import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { silenceSdk, settleSdkCalls } from './deploy-mini-sandbox-cloud.mjs';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const productionCloud = Object.freeze({ appId: 'REDACTED_APP_IDENTIFIER',
  envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', region: 'ap-shanghai' });
const services = ['buildtest', 'leyanxiu-stage', 'leyanxiu-api'];

// Credentials stay in memory. SDK diagnostics can contain complete envParams.
export async function withProductionCloud(operation) {
  return silenceSdk(async () => {
    const cloud = dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-cloud')));
    if (cloud.WXCLOUD_APP_ID !== productionCloud.appId || !cloud.WXCLOUD_PRIVATE_KEY?.trim())
      throw new Error('CLOUD_CONFIGURATION_INVALID');
    const require = createRequire(path.join(process.env.LOCALAPPDATA,
      'leyanxiu-toolchains/wxcloud-cli/node_modules/@wxcloud/cli/package.json'));
    const { logger } = require('./lib/utils/log.js'), auth = require('./lib/utils/auth.js');
    const axios = require('axios');
    const prior = { debug: logger.debug, read: auth.readLoginState, timeout: axios.defaults.timeout };
    try {
      logger.debug = () => {}; axios.defaults.timeout = 20000;
      const state = { appid: productionCloud.appId, privateKey: cloud.WXCLOUD_PRIVATE_KEY.trim() };
      auth.readLoginState = async () => state;
      if (!await auth.checkLoginState(state.appid, state.privateKey)) throw new Error('CLOUD_AUTH_UNCONFIRMED');
      require('./lib/api/adapter.js').initCloudAPI(state.appid);
      require('./lib/api/common.js').setApiCommonParameters({ region: productionCloud.region });
      const api = require('./lib/api/index.js'), { CloudAPI } = require('@wxcloud/core');
      return await operation({ api, CloudAPI, axios, require });
    } finally {
      logger.debug = prior.debug; auth.readLoginState = prior.read; axios.defaults.timeout = prior.timeout;
    }
  });
}

export async function inspectProductionCloud({ api, CloudAPI }) {
  const { envId } = productionCloud;
  const envs = await api.DescribeWxCloudBaseRunEnvs();
  if (!envs.EnvList?.some(e => e.EnvId === envId)) throw new Error('CLOUD_ENVIRONMENT_UNCONFIRMED');
  const inventories = [];
  for (const serverName of services) {
    const scope = { envId, serverName };
    const [base, domain, task] = await settleSdkCalls([
      () => CloudAPI.tcbDescribeServiceBaseConfig(scope),
      () => api.DescribeCloudBaseRunServiceDomain({ EnvId: envId, ServiceName: serverName }),
      () => CloudAPI.tcbDescribeServerManageTask(scope),
    ]);
    const versions = []; let total;
    for (let pages = 0; pages < 10; pages++) {
      const batch = await api.DescribeCloudBaseRunServer({ EnvId: envId, ServerName: serverName,
        Limit: 10, Offset: versions.length });
      if (batch.ServerName !== serverName || !Number.isSafeInteger(batch.TotalCount)
          || batch.TotalCount < 1 || batch.TotalCount > 100 || !Array.isArray(batch.VersionItems)
          || (total !== undefined && batch.TotalCount !== total)) throw new Error('CLOUD_VERSIONS_UNCONFIRMED');
      total = batch.TotalCount;
      for (const v of batch.VersionItems) {
        if (!new RegExp(`^${serverName}-[0-9]+$`).test(v.VersionName)
            || versions.some(old => old.VersionName === v.VersionName)) throw new Error('CLOUD_VERSIONS_UNCONFIRMED');
        versions.push(v);
      }
      if (versions.length === total) break;
      if (!batch.VersionItems.length || versions.length > total) throw new Error('CLOUD_VERSIONS_UNCONFIRMED');
    }
    if (versions.length !== total) throw new Error('CLOUD_VERSIONS_UNCONFIRMED');
    const active = [];
    for (const v of versions.filter(v => v.FlowRatio > 0)) {
      active.push(await CloudAPI.tcbDescribeCloudBaseRunServerVersion({ ...scope, versionName: v.VersionName }));
    }
    inventories.push({ serverName, base: base.serviceBaseConfig, domain, task: task.task, versions, active });
  }
  return inventories;
}

export function cloudInventorySummary(inventories) {
  return { checkedAt: new Date().toISOString(), changedRemoteState: false,
    environment: productionCloud.envId, services: inventories.map(item => {
      const env = JSON.parse(item.base.envParams || '{}');
      return { name: item.serverName, accessTypes: item.domain.AccessTypes,
        baseConfigKeys: Object.keys(item.base), environmentKeys: Object.keys(env).sort(),
        deploymentMode: env.DEPLOY_ENV || null, paymentMode: env.XPAY_MODE || null,
        paymentEnvironment: env.XPAY_ENV || null, releaseChannel: env.RELEASE_CHANNEL || null,
        capacity: { min: item.base.minNum, max: item.base.maxNum, cpu: item.base.cpu, memory: item.base.mem },
        task: item.task ? { id: item.task.id, status: item.task.status } : null,
        versionsComplete: true, versions: item.versions.map(v => ({ name: v.VersionName,
          status: v.Status, flow: v.FlowRatio })),
        activeDetails: item.active.map(v => ({ keys: Object.keys(v), port: v.containerPort,
          min: v.minNum, max: v.maxNum, publicAccess: v.publicAccess })) };
    }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await withProductionCloud(inspectProductionCloud);
    process.stdout.write(`${JSON.stringify(cloudInventorySummary(result), null, 2)}\n`);
  } catch { process.stderr.write('CLOUD_READONLY_INVENTORY_UNCONFIRMED\n'); process.exitCode = 1; }
}
