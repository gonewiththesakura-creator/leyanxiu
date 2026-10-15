import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { virtualMysqlOptions, privateSandboxTransport } from '../payments/virtual/mysql-transport.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(server, '.env.mini-payment');
const required = ['WECHAT_APP_SECRET', 'XPAY_SANDBOX_APP_KEY', 'XPAY_MYSQL_HOST', 'XPAY_MYSQL_USER',
  'XPAY_MYSQL_PASSWORD', 'XPAY_MYSQL_DATABASE'];
try {
  if (!fs.existsSync(file)) {
    const callback = dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-callback')));
    if (callback.WECHAT_APP_ID !== 'REDACTED_APP_IDENTIFIER') throw new Error('wrong app');
    createMessageCodec({ appId: callback.WECHAT_APP_ID, token: callback.XPAY_MESSAGE_TOKEN, aesKey: callback.XPAY_MESSAGE_AES_KEY });
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
      if (process.platform === 'win32') {
        const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
        const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
        if (!sid) throw new Error('identity unavailable');
        execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { stdio: 'pipe', windowsHide: true });
      }
      const values = {
        WECHAT_APP_SECRET: '', XPAY_SANDBOX_APP_KEY: '',
        WECHAT_APP_ID: callback.WECHAT_APP_ID, XPAY_OFFER_ID: '1450662722',
        RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', DEPLOY_ENV: 'production',
        XPAY_ENABLED: 'false', XPAY_MODE: 'closed', XPAY_ENV: '1', XPAY_DB_BACKEND: 'mysql',
        XPAY_MYSQL_HOST: '', XPAY_MYSQL_PORT: '3306', XPAY_MYSQL_USER: '', XPAY_MYSQL_PASSWORD: '',
        XPAY_MYSQL_DATABASE: 'leyanxiu_xpay_sandbox', XPAY_MYSQL_CA_FILE: '',
        XPAY_SESSION_ENCRYPTION_KEY: crypto.randomBytes(32).toString('hex'),
        AUTH_SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
        XPAY_MESSAGE_TOKEN: callback.XPAY_MESSAGE_TOKEN, XPAY_MESSAGE_AES_KEY: callback.XPAY_MESSAGE_AES_KEY,
        XPAY_PRODUCTS_JSON: '[]', XPAY_PURPOSE_RULES_JSON: '{}', XPAY_RECONCILE_ENABLED: 'false',
      };
      const note = '# 私有沙箱准备文件：只先填写下面两项，值不要发聊天。\n'
        + '# WECHAT_APP_SECRET：本小程序 AppSecret；XPAY_SANDBOX_APP_KEY：虚拟支付的沙箱 AppKey。\n'
        + '# 不要重置已有密钥。数据库字段由后续部署配置；本文件不会自动启用支付或上传。\n';
      fs.writeFileSync(descriptor, note + Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  }
  const saved = dotenv.parse(fs.readFileSync(file));
  if (saved.WECHAT_APP_ID !== 'REDACTED_APP_IDENTIFIER' || saved.XPAY_ENV !== '1'
    || saved.XPAY_MODE !== 'closed' || saved.XPAY_ENABLED !== 'false') throw new Error('unsafe config');
  const transport = saved.XPAY_MYSQL_TRANSPORT || 'tls';
  if (!['tls', privateSandboxTransport].includes(transport)) throw new Error('invalid transport');
  const transportFields = transport === 'tls' ? ['XPAY_MYSQL_CA_FILE'] : ['XPAY_CLOUD_ENV_ID', 'XPAY_MYSQL_INSTANCE_ID'];
  const missing = [...required, ...transportFields].filter(key => !saved[key]?.trim());
  if (!missing.length) virtualMysqlOptions(saved, { allowCloudrunPrivateSandbox: true }); // Configuration only; no connection.
  console.log(JSON.stringify({ file, existingValuesPreserved: true, missing, sandboxCredentialsPresent: !missing.some(k => ['WECHAT_APP_SECRET', 'XPAY_SANDBOX_APP_KEY'].includes(k)),
    transport, configurationValidated: !missing.length,
    salesEnabled: false, credentialsValidatedWithWechat: false, databaseConnected: false }));
} catch {
  console.error('XPAY_PRIVATE_PREPARATION_FAILED: no secret values logged; existing files not overwritten'); process.exitCode = 1;
}
