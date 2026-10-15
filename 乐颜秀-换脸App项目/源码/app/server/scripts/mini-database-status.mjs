import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envId = 'leyanxiu-prod-d5gimob8af6a6e5c9';
const action = process.argv[2] || 'status';
const report = value => process.stdout.write(`${JSON.stringify(value)}\n`);
console.log = () => {};
try {
  if (!['status', 'resume'].includes(action)) throw new Error('XPAY_ACTION_INVALID');
  const credentials = dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-cloud')));
  const wxAppId = credentials.WXCLOUD_APP_ID;
  if (wxAppId !== 'REDACTED_APP_IDENTIFIER' || !credentials.WXCLOUD_PRIVATE_KEY?.trim()) throw new Error('XPAY_CLOUD_CONFIG_REQUIRED');
  const cliRoot = path.join(process.env.LOCALAPPDATA, 'leyanxiu-toolchains/wxcloud-cli/node_modules/@wxcloud/cli');
  const require = createRequire(path.join(cliRoot, 'package.json'));
  require('./lib/utils/log.js').logger.debug = () => {};
  require('axios').defaults.timeout = 20000;
  require('./lib/utils/auth.js').readLoginState = async () => ({ appid: wxAppId, privateKey: credentials.WXCLOUD_PRIVATE_KEY.trim() });
  require('./lib/api/adapter.js').initCloudAPI(wxAppId);
  require('./lib/api/common.js').setApiCommonParameters({ region: 'ap-shanghai' });
  const { CloudAPI } = require('@wxcloud/core');
  const options = { envId, wxAppId };
  const current = await CloudAPI.tcbDescribeWxCloudBaseRunDBClusterDetail(options);
  if (!current.dbClusterId || current.dbInfo?.dbVersion !== '8.0' || current.dbInfo?.isOpenPubNetAccess !== false) throw new Error('XPAY_DATABASE_SCOPE_MISMATCH');
  if (action === 'resume' && current.dbInfo.status === 'pause') {
    await CloudAPI.tcbResumeCloudBaseRunTdsql(options);
    report({ resumeRequested: true, passwordReset: false, publicAccessChanged: false });
  }
  const result = action === 'resume' ? await CloudAPI.tcbDescribeWxCloudBaseRunDBClusterDetail(options) : current;
  report({ database: { clusterId: result.dbClusterId, status: result.dbInfo.status, version: result.dbInfo.dbVersion, publicAccess: result.dbInfo.isOpenPubNetAccess,
    autoPause: result.dbInfo.isOpenAutoPause, privateAddressAvailable: Boolean(result.netInfo?.privateNetAddress),
    minCpu: result.dbInfo.minCpu, maxCpu: result.dbInfo.maxCpu } });
  try {
    const accounts = await CloudAPI.tcbDescribeWxCloudBaseRunDBAccounts(options);
    report({ accounts: accounts.accounts.map(a => ({ name: a.accountName, host: a.host, privileges: a.privileges })) });
  } catch { report({ accountInventory: 'unconfirmed' }); }
} catch (error) {
  report({ failed: true, code: /^XPAY_[A-Z_]+$/.test(error?.message) ? error.message : 'XPAY_DATABASE_OPERATION_UNCONFIRMED' });
  process.exitCode = 1;
}
