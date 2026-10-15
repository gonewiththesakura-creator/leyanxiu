import fs from 'node:fs';
import crypto from 'node:crypto';
import { openVirtualDatabase } from './database.js';
import { createVirtualLedger } from './ledger.js';
import { createVirtualWechat, createMessageCodec } from './wechat.js';
import { parseVirtualProducts } from './products.js';
import { virtualMysqlOptions, privateSandboxTransport, verifyPrivateSandboxDatabase } from './mysql-transport.js';
export { virtualMysqlOptions } from './mysql-transport.js';

export const virtualEnabled = () => process.env.XPAY_ENABLED === 'true';
export function virtualMessageCodec() {
  return createMessageCodec({ appId: process.env.WECHAT_APP_ID, token: process.env.XPAY_MESSAGE_TOKEN, aesKey: process.env.XPAY_MESSAGE_AES_KEY });
}
let pending;
export async function virtualRuntime({ allowCloudrunPrivateSandbox = false } = {}) {
  if (!virtualEnabled()) return null;
  // Check before the singleton cache too: another entry point cannot inherit
  // an already initialized private connection without its explicit opt-in.
  const privateSandbox = process.env.XPAY_MYSQL_TRANSPORT === privateSandboxTransport;
  const mysqlOptions = process.env.XPAY_DB_BACKEND === 'mysql'
    ? virtualMysqlOptions(process.env, { allowCloudrunPrivateSandbox }) : undefined;
  if (privateSandbox && !mysqlOptions) throw new Error('XPAY_MYSQL_PRIVATE_SANDBOX_ONLY');
  if (!pending) pending = (async () => {
    if (process.env.RELEASE_CHANNEL !== 'wechat-mini-program' || process.env.AUTH_MODE !== 'wechat') throw new Error('XPAY_CHANNEL_CONFIG_REQUIRED');
    const backend = process.env.XPAY_DB_BACKEND;
    if (process.env.DEPLOY_ENV === 'production' && backend !== 'mysql') throw new Error('XPAY_PRODUCTION_MYSQL_REQUIRED');
    const database = await openVirtualDatabase({ backend, filename: process.env.XPAY_SQLITE_FILE,
      mysqlOptions });
    try {
      if (privateSandbox) await verifyPrivateSandboxDatabase(database);
      const ledger = createVirtualLedger({ database, encryptionKey: process.env.XPAY_SESSION_ENCRYPTION_KEY });
      if (!['0', '1'].includes(process.env.XPAY_ENV)) throw new Error('XPAY_ENV_REQUIRED');
      const env = Number(process.env.XPAY_ENV);
      await ledger.bindEnvironment(process.env.WECHAT_APP_ID, env);
      const adapter = createVirtualWechat({ appId: process.env.WECHAT_APP_ID, appSecret: process.env.WECHAT_APP_SECRET,
        offerId: process.env.XPAY_OFFER_ID, appKey: env === 1 ? process.env.XPAY_SANDBOX_APP_KEY : process.env.XPAY_APP_KEY, env });
      const codec = createMessageCodec({ appId: process.env.WECHAT_APP_ID, token: process.env.XPAY_MESSAGE_TOKEN, aesKey: process.env.XPAY_MESSAGE_AES_KEY });
      return { ledger, adapter, codec };
    } catch (error) { await database.close(); throw error; }
  })().catch(error => { pending = null; throw error; });
  return pending;
}
export const virtualProducts = () => {
  try { return parseVirtualProducts(process.env.XPAY_PRODUCTS_JSON || '[]'); } catch { return []; }
};
function acceptedEvidence() {
  try {
    const bytes = fs.readFileSync(process.env.XPAY_ACCEPTANCE_FILE);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== process.env.XPAY_ACCEPTANCE_SHA256) return false;
    const report = JSON.parse(bytes);
    return report.appId === process.env.WECHAT_APP_ID && Date.parse(report.acceptedAt) <= Date.now()
      && Date.now() - Date.parse(report.acceptedAt) < 30 * 86400000
      && ['mysqlRestore', 'merchantPayment', 'merchantRefund', 'crossDeviceRestore', 'iosRefund', 'securityReview', 'dailyReconciliation'].every(key => report.checks?.[key] === true);
  } catch { return false; }
}
export async function virtualReadiness({ identityReady = false, adminReady = false } = {}) {
  const mode = process.env.XPAY_MODE || 'closed';
  const testUserIds = String(process.env.XPAY_TEST_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const blockers = []; let runtime;
  if (!virtualEnabled()) blockers.push('virtual payment disabled');
  else try { runtime = await virtualRuntime(); } catch { blockers.push('virtual payment database, migration or credentials unavailable'); }
  const operationsReady = Boolean(runtime);
  if (!['sandbox', 'merchant_test', 'live'].includes(mode)) blockers.push('sales closed');
  if (runtime && (mode === 'sandbox' ? runtime.adapter.env !== 1 : runtime.adapter.env !== 0)) blockers.push('payment environment mismatch');
  if (process.env.RELEASE_CHANNEL !== 'wechat-mini-program' || process.env.AUTH_MODE !== 'wechat') blockers.push('WeChat mini-program identity required');
  if (!virtualProducts().length) blockers.push('reviewed catalog required');
  try {
    const rules = JSON.parse(process.env.XPAY_PURPOSE_RULES_JSON || '{}');
    const supported = new Set(Object.entries(rules).filter(([purpose, rule]) => rule?.reviewed === true
      && (rule.kind === 'photo' || (rule.kind === 'video' && purpose === 'video-fusion' && Array.isArray(rule.templateIds) && rule.templateIds.length > 0))).map(([, rule]) => rule.kind));
    if (virtualProducts().some(product => product.components.some(part => !supported.has(part.kind)))) blockers.push('catalog rights need approved usable generation purposes');
  } catch { blockers.push('generation purpose policy invalid'); }
  if (['sandbox', 'merchant_test'].includes(mode) && !testUserIds.length) blockers.push('payment test user allowlist required');
  if (mode !== 'sandbox' && runtime?.ledger.database.backend !== 'mysql') blockers.push('real money requires transactional MySQL');
  if (['merchant_test', 'live'].includes(mode) && !identityReady) blockers.push('durable identity and recovery acceptance required');
  if (mode === 'live') {
    if (!acceptedEvidence()) blockers.push('pinned merchant and operational acceptance required');
    if (!adminReady) blockers.push('administrator security acceptance required');
  }
  return { ready: blockers.length === 0, operationsReady, mode, testUserIds, blockers };
}
