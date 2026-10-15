import { createRequire } from 'node:module';
import path from 'node:path';
const root = path.join(process.env.APPDATA, 'kimi-desktop/daimon-share/daimon/npm-global/node_modules/@wxcloud/cli');
const require = createRequire(path.join(root, 'package.json'));
const { readLoginState } = require('./lib/utils/auth.js');
const { initCloudAPI } = require('./lib/api/adapter.js');
const { CloudAPI } = require('@wxcloud/core');
const { setApiCommonParameters } = require('./lib/api/common.js');
const { appid } = await readLoginState();
initCloudAPI(appid); setApiCommonParameters({ region: 'ap-shanghai' });
const { serviceBaseConfig: config } = await CloudAPI.tcbDescribeServiceBaseConfig({ envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', serverName: 'leyanxiu-stage' });
console.log(JSON.stringify({ minNum: config.minNum, maxNum: config.maxNum, cpu: config.cpu, mem: config.mem }));
if (Number(config.maxNum) !== 1) throw new Error('Single-instance snapshots require maxNum=1; do not deploy this configuration');
const { task } = await CloudAPI.tcbDescribeServerManageTask({ envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', serverName: 'leyanxiu-stage' });
console.log(JSON.stringify({ deployStatus: task?.status, versionName: task?.versionName, steps: task?.steps?.map(step => ({ status: step.status, name: step.name })) }));
if (task?.versionName) {
  const { versionItems } = await CloudAPI.tcbDescribeCloudBaseRunServer({ envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', serverName: 'leyanxiu-stage', versionName: task.versionName, offset: 0, limit: 1 });
  console.log(JSON.stringify(versionItems?.map(v => ({ versionName: v.versionName, status: v.status, buildStatus: v.buildStatus, createdTime: v.createdTime }))));
}
