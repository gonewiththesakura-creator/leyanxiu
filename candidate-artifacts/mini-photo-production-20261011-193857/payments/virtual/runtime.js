import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openVirtualDatabase } from './database.js';
import { createVirtualLedger } from './ledger.js';
import { createVirtualWechat, createMessageCodec } from './wechat.js';
import { parseVirtualProducts } from './products.js';
import { virtualMysqlOptions, privateSandboxTransport, privateProductionTransport,
  verifyPrivateSandboxDatabase, verifyPrivateProductionDatabase } from './mysql-transport.js';
export { virtualMysqlOptions } from './mysql-transport.js';

export const virtualEnabled = () => process.env.XPAY_ENABLED === 'true';
export function virtualMessageCodec() {
  return createMessageCodec({ appId: process.env.WECHAT_APP_ID, token: process.env.XPAY_MESSAGE_TOKEN, aesKey: process.env.XPAY_MESSAGE_AES_KEY });
}
const runtimeEnvKeys = ['XPAY_ENABLED', 'RELEASE_CHANNEL', 'AUTH_MODE', 'DEPLOY_ENV', 'XPAY_DB_BACKEND',
  'XPAY_SQLITE_FILE', 'XPAY_MYSQL_TRANSPORT', 'XPAY_MYSQL_HOST', 'XPAY_MYSQL_PORT', 'XPAY_MYSQL_USER',
  'XPAY_MYSQL_PASSWORD', 'XPAY_MYSQL_DATABASE', 'XPAY_MYSQL_CA_FILE', 'XPAY_MYSQL_INSTANCE_ID', 'XPAY_CLOUD_ENV_ID',
  'WECHAT_APP_ID', 'WECHAT_APP_SECRET', 'XPAY_ENV', 'XPAY_MODE', 'XPAY_OFFER_ID', 'XPAY_APP_KEY', 'XPAY_SANDBOX_APP_KEY',
  'XPAY_SESSION_ENCRYPTION_KEY', 'XPAY_MESSAGE_TOKEN', 'XPAY_MESSAGE_AES_KEY'];
const readinessEnvKeys = ['XPAY_PRODUCTS_JSON', 'XPAY_PURPOSE_RULES_JSON', 'XPAY_TEST_USER_IDS',
  'XPAY_ACCEPTANCE_FILE', 'XPAY_ACCEPTANCE_SHA256'];
const environmentSnapshot = () => Object.freeze(Object.fromEntries([...runtimeEnvKeys, ...readinessEnvKeys].map(key => [key, process.env[key]])));
let cached;
export async function virtualRuntime(options = {}) {
  return runtimeForEnvironment(environmentSnapshot(), options);
}
async function runtimeForEnvironment(snapshot, { allowCloudrunPrivateSandbox = false,
  allowCloudrunPrivateProduction = false, productionTarget } = {}) {
  if (snapshot.XPAY_ENABLED !== 'true') return null;
  // Check before the singleton cache too: another entry point cannot inherit
  // an already initialized private connection without its explicit opt-in.
  const privateSandbox = snapshot.XPAY_MYSQL_TRANSPORT === privateSandboxTransport;
  const privateProduction = snapshot.XPAY_MYSQL_TRANSPORT === privateProductionTransport;
  const target = privateProduction && productionTarget ? Object.freeze({ ...productionTarget }) : undefined;
  const mysqlOptions = snapshot.XPAY_DB_BACKEND === 'mysql'
    ? virtualMysqlOptions(snapshot, { allowCloudrunPrivateSandbox, allowCloudrunPrivateProduction, productionTarget: target }) : undefined;
  if (privateSandbox && !mysqlOptions) throw new Error('XPAY_MYSQL_PRIVATE_SANDBOX_ONLY');
  if (privateProduction && !mysqlOptions) throw new Error('XPAY_MYSQL_PRIVATE_PRODUCTION_ONLY');
  // Credentials only contribute to an in-memory digest. Neither the digest nor
  // the captured configuration is exposed in results, errors or logs.
  const scope = crypto.createHash('sha256').update(JSON.stringify({
    env: Object.fromEntries(runtimeEnvKeys.map(key => [key, snapshot[key]])), mysqlOptions,
    accountHost: target?.accountHost,
  })).digest('hex');
  if (cached) {
    if (cached.scope !== scope) throw new Error('XPAY_RUNTIME_SCOPE_MISMATCH');
    return cached.promise;
  }
  const entry = { scope, promise: null }; cached = entry;
  entry.promise = (async () => {
    if (snapshot.RELEASE_CHANNEL !== 'wechat-mini-program' || snapshot.AUTH_MODE !== 'wechat') throw new Error('XPAY_CHANNEL_CONFIG_REQUIRED');
    const backend = snapshot.XPAY_DB_BACKEND;
    if (snapshot.DEPLOY_ENV === 'production' && backend !== 'mysql') throw new Error('XPAY_PRODUCTION_MYSQL_REQUIRED');
    if (!['0', '1'].includes(snapshot.XPAY_ENV)) throw new Error('XPAY_ENV_REQUIRED');
    const database = await openVirtualDatabase({ backend, filename: snapshot.XPAY_SQLITE_FILE,
      mysqlOptions });
    try {
      if (privateSandbox) await verifyPrivateSandboxDatabase(database);
      if (privateProduction) await verifyPrivateProductionDatabase(database, target);
      const ledger = createVirtualLedger({ database, encryptionKey: snapshot.XPAY_SESSION_ENCRYPTION_KEY });
      const env = Number(snapshot.XPAY_ENV);
      await ledger.bindEnvironment(snapshot.WECHAT_APP_ID, env);
      const adapter = createVirtualWechat({ appId: snapshot.WECHAT_APP_ID, appSecret: snapshot.WECHAT_APP_SECRET,
        offerId: snapshot.XPAY_OFFER_ID, appKey: env === 1 ? snapshot.XPAY_SANDBOX_APP_KEY : snapshot.XPAY_APP_KEY, env });
      const codec = createMessageCodec({ appId: snapshot.WECHAT_APP_ID, token: snapshot.XPAY_MESSAGE_TOKEN, aesKey: snapshot.XPAY_MESSAGE_AES_KEY });
      return { ledger, adapter, codec };
    } catch (error) { await database.close(); throw error; }
  })().catch(error => { if (cached === entry) cached = undefined; throw error; });
  return entry.promise;
}
export const virtualProducts = (env = process.env) => {
  try { return parseVirtualProducts(env.XPAY_PRODUCTS_JSON || '[]'); } catch { return []; }
};
const acceptanceChecks = Object.freeze(['mysqlRestore', 'merchantPayment', 'merchantRefund', 'crossDeviceRestore',
  'iosRefund', 'securityReview', 'dailyReconciliation']);
const maxAcceptanceBytes = 1024 * 1024;
// A hash pins the report bytes, not its environment or the truth of a check.
// Existing merchant/operational checks remain required; env1 real-money tests
// and reports without the production OfferID can never authorize env0 sales.
export function virtualAcceptanceMatches(report, { appId, env, offerId } = {}, now = Date.now()) {
  if (!report || typeof report !== 'object' || Array.isArray(report)
    || typeof appId !== 'string' || !appId || env !== '0'
    || typeof offerId !== 'string' || !offerId || offerId.trim() !== offerId
    || report.appId !== appId || report.env !== 0 || report.offerId !== offerId
    || typeof report.acceptedAt !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(report.acceptedAt)
    || !Number.isSafeInteger(now) || now < 0
    || !report.checks || typeof report.checks !== 'object' || Array.isArray(report.checks)) return false;
  const acceptedAt = Date.parse(report.acceptedAt);
  const canonicalTime = report.acceptedAt.includes('.') ? report.acceptedAt : report.acceptedAt.replace('Z', '.000Z');
  if (!Number.isFinite(acceptedAt) || new Date(acceptedAt).toISOString() !== canonicalTime
    || acceptedAt > now || now - acceptedAt >= 30 * 86400000) return false;
  return acceptanceChecks.every(key => Object.hasOwn(report.checks, key) && report.checks[key] === true);
}
export function acceptedVirtualPaymentEvidence(env = process.env, now = Date.now()) {
  let fd;
  try {
    const filename = env.XPAY_ACCEPTANCE_FILE;
    if (typeof filename !== 'string' || !path.isAbsolute(filename) || !/^[a-f0-9]{64}$/.test(env.XPAY_ACCEPTANCE_SHA256 || '')) return false;
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.size < 1 || stat.size > maxAcceptanceBytes) return false;
    fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino || before.size !== stat.size) return false;
    const buffer = Buffer.alloc(maxAcceptanceBytes + 1); let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fs.fstatSync(fd);
    if (size !== before.size || size > maxAcceptanceBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs) return false;
    const bytes = buffer.subarray(0, size);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== env.XPAY_ACCEPTANCE_SHA256) return false;
    const report = JSON.parse(bytes);
    return virtualAcceptanceMatches(report, { appId: env.WECHAT_APP_ID, env: env.XPAY_ENV, offerId: env.XPAY_OFFER_ID }, now);
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
export async function virtualReadiness({ identityReady = false, adminReady = false, runtimeOptions = {} } = {}) {
  const env = environmentSnapshot();
  const mode = env.XPAY_MODE || 'closed';
  const testUserIds = String(env.XPAY_TEST_USER_IDS || '').split(',').map(x => x.trim()).filter(Boolean);
  const blockers = []; let runtime;
  if (env.XPAY_ENABLED !== 'true') blockers.push('virtual payment disabled');
  else try { runtime = await runtimeForEnvironment(env, runtimeOptions); } catch { blockers.push('virtual payment database, migration or credentials unavailable'); }
  const operationsReady = Boolean(runtime);
  if (!['sandbox', 'merchant_test', 'live'].includes(mode)) blockers.push('sales closed');
  if (runtime && (mode === 'sandbox' ? runtime.adapter.env !== 1 : runtime.adapter.env !== 0)) blockers.push('payment environment mismatch');
  if (env.RELEASE_CHANNEL !== 'wechat-mini-program' || env.AUTH_MODE !== 'wechat') blockers.push('WeChat mini-program identity required');
  const products = virtualProducts(env);
  if (!products.length) blockers.push('reviewed catalog required');
  try {
    const rules = JSON.parse(env.XPAY_PURPOSE_RULES_JSON || '{}');
    const supported = new Set(Object.entries(rules).filter(([purpose, rule]) => rule?.reviewed === true
      && (rule.kind === 'photo' || (rule.kind === 'video' && purpose === 'video-fusion' && Array.isArray(rule.templateIds) && rule.templateIds.length > 0))).map(([, rule]) => rule.kind));
    if (products.some(product => product.components.some(part => !supported.has(part.kind)))) blockers.push('catalog rights need approved usable generation purposes');
  } catch { blockers.push('generation purpose policy invalid'); }
  if (['sandbox', 'merchant_test'].includes(mode) && !testUserIds.length) blockers.push('payment test user allowlist required');
  if (mode !== 'sandbox' && runtime?.ledger.database.backend !== 'mysql') blockers.push('real money requires transactional MySQL');
  if (['merchant_test', 'live'].includes(mode) && !identityReady) blockers.push('durable identity and recovery acceptance required');
  if (mode === 'live') {
    if (!acceptedVirtualPaymentEvidence(env)) blockers.push('pinned merchant and operational acceptance required');
    if (!adminReady) blockers.push('administrator security acceptance required');
  }
  return { ready: blockers.length === 0, operationsReady, mode, testUserIds, blockers };
}
