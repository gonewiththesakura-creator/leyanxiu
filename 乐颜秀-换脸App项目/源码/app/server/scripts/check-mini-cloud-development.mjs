import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const appId = 'REDACTED_APP_IDENTIFIER';
const envId = 'cloudbase-d5gffahoe587434de';
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const safeCode = error => String(error?.Code || error?.code || 'XPAY_CLOUD_DEVELOPMENT_UNCONFIRMED')
  .replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 100);

// Inventory only: never read document contents, function code, logs, or credentials from the platform.
console.log = () => {};
try {
  if (process.argv.includes('--help')) {
    report({ usage: 'node scripts/check-mini-cloud-development.mjs [--functions] [--collections] [--billing]',
      appId, envId, changedRemoteState: false });
  } else {
    const env = dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-cloud')));
    if (env.WXCLOUD_APP_ID !== appId) throw new Error('XPAY_CLOUD_APPID_MISMATCH');
    if (!env.WXCLOUD_PRIVATE_KEY?.trim()) throw new Error('XPAY_CLOUD_CLI_KEY_REQUIRED');
    const cliRoot = process.env.WXCLOUD_CLI_ROOT || path.join(process.env.LOCALAPPDATA || '',
      'leyanxiu-toolchains', 'wxcloud-cli', 'node_modules', '@wxcloud', 'cli');
    const require = createRequire(path.join(cliRoot, 'package.json'));
    const { logger } = require('./lib/utils/log.js'); logger.debug = () => {};
    const axios = require('axios'); axios.defaults.timeout = 15000;
    const auth = require('./lib/utils/auth.js');
    const state = { appid: appId, privateKey: env.WXCLOUD_PRIVATE_KEY.trim() };
    auth.readLoginState = async () => state;
    if (!await auth.checkLoginState(state.appid, state.privateKey)) throw new Error('XPAY_CLOUD_CLI_AUTH_FAILED');
    require('./lib/api/adapter.js').initCloudAPI(appId);
    require('./lib/api/common.js').setApiCommonParameters({ region: 'ap-shanghai' });
    const { CloudAPI } = require('@wxcloud/core');
    const result = await CloudAPI.tcbGetEnvironments({ envId, appId });
    const environment = result.envList?.find(item => item.envId === envId);
    if (!environment) throw new Error('XPAY_CLOUD_DEVELOPMENT_ENV_UNCONFIRMED');
    report({ authenticated: true, changedRemoteState: false, environment: {
      id: environment.envId, name: environment.alias, status: environment.status,
      region: environment.region, source: environment.source,
      packageId: environment.packageId, packageName: environment.packageName, payMode: environment.payMode,
      databases: environment.databases?.map(item => ({ id: item.instanceId, status: item.status, region: item.region })),
      functionNamespaces: environment.functions?.map(item => ({ namespace: item.namespace, region: item.region })),
    } });
    if (process.argv.includes('--billing')) {
      try {
        const billing = await CloudAPI.tcbDescribeBillingInfo({ region: 'ap-shanghai', envId, appId, needOrderInfo: false });
        report({ environment: envId, billing: billing.envBillingInfoList?.filter(item => item.envId === envId)
          .map(item => ({ packageId: item.packageId, status: item.status, payMode: item.payMode,
            isAutoRenew: item.isAutoRenew, isAlwaysFree: item.isAlwaysFree, expireTime: item.expireTime,
            paymentChannel: item.paymentChannel })) });
      } catch (error) { report({ environment: envId, billingVerified: false, code: safeCode(error) }); }
      try {
        const limits = await CloudAPI.tcbGetResourceLimit({ region: 'ap-shanghai', envId, appId });
        report({ environment: envId, resourceLimits: { database: limits.database, functions: limits.function } });
      } catch (error) { report({ environment: envId, resourceLimitsVerified: false, code: safeCode(error) }); }
    }
    if (process.argv.includes('--functions')) {
      for (const item of environment.functions || []) {
        try {
          const response = await CloudAPI.scfListFunctions({ region: item.region, namespace: item.namespace,
            order: 'ASC', orderBy: 'AddTime', offset: 0, limit: 100, searchKey: '', description: '' });
          report({ environment: envId, functionCount: response.totalCount,
            truncated: response.totalCount > response.functions?.length,
            functions: response.functions?.map(fn => ({ name: fn.functionName, runtime: fn.runtime, status: fn.status })) });
        } catch (error) { report({ environment: envId, functionsVerified: false, code: safeCode(error) }); }
      }
    }
    if (process.argv.includes('--collections')) {
      for (const item of environment.databases || []) {
        try {
          const response = await CloudAPI.flexdbListTables({ region: item.region, tag: item.instanceId,
            mgoLimit: 100, mgoOffset: 0 });
          report({ environment: envId, collectionCount: response.pager?.total,
            truncated: response.pager?.total > response.tables?.length,
            collections: response.tables?.map(table => ({ name: table.tableName, indexCount: table.indexCount })) });
        } catch (error) { report({ environment: envId, collectionsVerified: false, code: safeCode(error) }); }
      }
    }
  }
} catch (error) {
  const codes = new Set(['XPAY_CLOUD_APPID_MISMATCH', 'XPAY_CLOUD_CLI_KEY_REQUIRED',
    'XPAY_CLOUD_CLI_AUTH_FAILED', 'XPAY_CLOUD_DEVELOPMENT_ENV_UNCONFIRMED']);
  report({ changedRemoteState: false, verified: false, code: codes.has(error.message) ? error.message : safeCode(error) });
  process.exitCode = 1;
}
