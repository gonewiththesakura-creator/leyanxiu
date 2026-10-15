import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinProductionMysql, createPrivateProductionMysqlTarget, privateProductionTransport,
  virtualMysqlOptions } from '../payments/virtual/mysql-transport.js';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { checkedQwenPhotoApiEndpoint, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_MODEL,
  QWEN_PHOTO_RESULT_POLICY } from '../photo-jobs/qwen-provider.js';

export const productionCloudProfile = 'mini-photo-production-closed-v1';
export const productionClosedPolicy = Object.freeze({ relativePath: 'docs/production-config/closed-policy-2026-10-12.json',
  sha256: '00dbed925ad25c1ce0318e135924f847060684392f136b2422efceb8b83c5a17' });
const fail = suffix => { throw Object.assign(new Error(`PRODUCTION_CLOUD_PROFILE_${suffix}`), { code: `PRODUCTION_CLOUD_PROFILE_${suffix}` }); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function field(source, name, required = true) {
  if (!plain(source)) fail('SOURCE_INVALID');
  const descriptor = Object.getOwnPropertyDescriptor(source, name);
  if (!descriptor && !required) return undefined;
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
    || !descriptor.value.trim() || descriptor.value.length > 4096 || /[\u0000\r\n]/.test(descriptor.value)) fail('SOURCE_INVALID');
  return descriptor.value;
}
function jsonBytes(bytes, expectedHash) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 65536
    || !/^[a-f0-9]{64}$/.test(expectedHash || '') || hash(bytes) !== expectedHash) fail('DOCUMENT_INVALID');
  try {
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail('DOCUMENT_INVALID');
    const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plain(parsed)) fail('DOCUMENT_INVALID');
    return parsed;
  } catch { fail('DOCUMENT_INVALID'); }
}

/** Pure selection only. Caller explicitly reads/parses the four named private
 * sources, generates a fresh session key ONCE and durably journals it BEFORE
 * deployment. Never print/serialize the returned variables outside that
 * private journal or the intended cloud configuration request. This module
 * neither generates/rotates credentials nor reads files or starts SDKs.
 */
export function buildMiniProductionCloudProfile({ payment, production, database, media,
  sessionEncryptionKey, policyBytes, acceptanceBytes, acceptanceSha256 } = {}) {
  for (const source of [payment, production, database, media]) if (!plain(source)) fail('SOURCE_INVALID');
  const appId = field(payment, 'WECHAT_APP_ID'), offerId = field(payment, 'XPAY_OFFER_ID');
  if (appId !== builtinProductionMysql.appId || offerId !== '1450662722') fail('PAYMENT_SCOPE_INVALID');
  for (const [name, expected] of [['WECHAT_APP_ID', appId], ['XPAY_OFFER_ID', offerId], ['XPAY_ENV', '0']]) {
    const value = field(production, name, false); if (value !== undefined && value !== expected) fail('PAYMENT_SCOPE_INVALID');
  }
  const appKey = field(production, 'XPAY_APP_KEY'), sandboxKey = field(payment, 'XPAY_SANDBOX_APP_KEY');
  if (appKey === sandboxKey) fail('PRODUCTION_KEY_REQUIRED');
  const oldSessionKey = field(payment, 'XPAY_SESSION_ENCRYPTION_KEY');
  if (!/^[a-f0-9]{64}$/i.test(oldSessionKey) || !/^[a-f0-9]{64}$/.test(sessionEncryptionKey || '')
    || sessionEncryptionKey.toLowerCase() === oldSessionKey.toLowerCase()) fail('INDEPENDENT_SESSION_KEY_REQUIRED');
  let target;
  try {
    target = createPrivateProductionMysqlTarget({ database: field(database, 'XPAY_MYSQL_DATABASE'),
      user: field(database, 'XPAY_MYSQL_USER'), accountHost: field(database, 'XPAY_MYSQL_ACCOUNT_HOST') });
  } catch { fail('DATABASE_SCOPE_INVALID'); }
  // Only the reviewed dedicated allocation. The general target helper remains
  // reusable; this one deployment profile is intentionally narrower.
  if (target.user !== 'lyx_xpay_prod' || target.accountHost !== '%') fail('DATABASE_SCOPE_INVALID');
  const policy = jsonBytes(policyBytes, productionClosedPolicy.sha256);
  if (policy.policy?.serviceProviderCode !== appId || policy.policy?.acceptanceVersion !== 'synthetic-generation-v4'
    || !Array.isArray(policy.approvedEffects) || policy.approvedEffects.length !== 0) fail('DOCUMENT_INVALID');
  const optional = {};
  if (acceptanceBytes !== undefined || acceptanceSha256 !== undefined) {
    const report = jsonBytes(acceptanceBytes, acceptanceSha256);
    if (report.probeVersion !== 'synthetic-generation-v4' || report.provider !== QWEN_PHOTO_PROVIDER
      || report.model !== QWEN_PHOTO_MODEL || report.resultUrlPolicy !== QWEN_PHOTO_RESULT_POLICY
      || report.labelVersion !== 'synthetic-generation-v4' || report.moderationVersion !== 'synthetic-generation-v4'
      || report.executed !== true || report.syntheticOnly !== true || report.passed !== true || report.failure
      || report.inputAllowed !== true || report.outputAllowed !== true || report.marked !== true
      || report.outputReadMatches !== true || report.outputAbsentObserved !== true || report.scratchAbsentObserved !== 2
      || report.cleanupPending !== false || report.attemptedGenerationCalls !== 1 || report.attemptedGreenCalls !== 2
      || report.moderationServices?.input !== 'baselineCheck' || report.moderationServices?.output !== 'aigcCheck') fail('ACCEPTANCE_INVALID');
    optional.PHOTO_PRODUCTION_ACCEPTANCE_BASE64 = acceptanceBytes.toString('base64');
    optional.PHOTO_PRODUCTION_ACCEPTANCE_SHA256 = acceptanceSha256;
  }
  const variables = {
    NODE_ENV: 'production', PORT: '3000', BIND_HOST: '0.0.0.0',
    DEBUG: '', NODE_DEBUG: '', NODE_DEBUG_NATIVE: '', NODE_EXTRA_CA_CERTS: '/app/cert/certificate.crt',
    PYTHON_PATH: '/usr/bin/python3', AI_MARK_FONT: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', DEPLOY_ENV: 'production',
    XPAY_ENABLED: 'true', XPAY_ENV: '0', XPAY_MODE: 'closed', XPAY_DB_BACKEND: 'mysql',
    WECHAT_APP_ID: appId, WECHAT_APP_SECRET: field(payment, 'WECHAT_APP_SECRET'), XPAY_OFFER_ID: offerId,
    XPAY_APP_KEY: appKey, XPAY_MESSAGE_TOKEN: field(payment, 'XPAY_MESSAGE_TOKEN'),
    XPAY_MESSAGE_AES_KEY: field(payment, 'XPAY_MESSAGE_AES_KEY'), XPAY_SESSION_ENCRYPTION_KEY: sessionEncryptionKey,
    XPAY_MYSQL_TRANSPORT: privateProductionTransport, XPAY_MYSQL_HOST: target.host, XPAY_MYSQL_PORT: String(target.port),
    XPAY_MYSQL_DATABASE: target.database, XPAY_MYSQL_USER: target.user, XPAY_MYSQL_ACCOUNT_HOST: target.accountHost,
    XPAY_MYSQL_PASSWORD: field(database, 'XPAY_MYSQL_PASSWORD'),
    XPAY_MYSQL_INSTANCE_ID: target.instanceId, XPAY_CLOUD_ENV_ID: target.cloudEnvId,
    XPAY_PRODUCTS_JSON: '[]', XPAY_PURPOSE_RULES_JSON: '{}', XPAY_TEST_USER_IDS: '', XPAY_REFUND_OPERATOR_USER_IDS: '',
    XPAY_RECONCILE_ENABLED: 'false', PHOTO_PRODUCTION_GENERATION_ENABLED: 'false',
    PHOTO_PRODUCTION_PROCESS_ENABLED: 'false', PHOTO_PRODUCTION_CLEANUP_ENABLED: 'false',
    PHOTO_CANDIDATE_GENERATION_ENABLED: 'false', PHOTO_CANDIDATE_PROCESS_ENABLED: 'false', PHOTO_CANDIDATE_CLEANUP_ENABLED: 'false',
    PHOTO_PRODUCTION_CONFIG_BASE64: policyBytes.toString('base64'), PHOTO_PRODUCTION_CONFIG_SHA256: productionClosedPolicy.sha256,
    ALIYUN_ACCESS_KEY_ID: field(media, 'ALIYUN_ACCESS_KEY_ID'), ALIYUN_ACCESS_KEY_SECRET: field(media, 'ALIYUN_ACCESS_KEY_SECRET'),
    DASHSCOPE_API_KEY: field(media, 'DASHSCOPE_API_KEY'), DASHSCOPE_BASE: field(media, 'DASHSCOPE_BASE'),
    OSS_BUCKET: field(media, 'OSS_BUCKET'), OSS_REGION: field(media, 'OSS_REGION'),
    PRIVACY_POLICY_URL: '', USER_AGREEMENT_URL: '', THIRD_PARTY_LIST_URL: '', RETENTION_SUPPLIER_POLICY: '',
    AI_SERVICE_DISCLOSURES_JSON: '[]', PIPIA_REFERENCE: '', ...optional,
  };
  const securityToken = field(media, 'ALIYUN_SECURITY_TOKEN', false);
  if (securityToken !== undefined) variables.ALIYUN_SECURITY_TOKEN = securityToken;
  try {
    createMessageCodec({ appId, token: variables.XPAY_MESSAGE_TOKEN, aesKey: variables.XPAY_MESSAGE_AES_KEY });
    checkedQwenPhotoApiEndpoint(variables.DASHSCOPE_BASE);
    virtualMysqlOptions(variables, { allowCloudrunPrivateProduction: true, productionTarget: target });
  } catch { fail('CONFIGURATION_INVALID'); }
  if (variables.OSS_REGION.replace(/^oss-/, '') !== policy.moderationPolicy.region
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(variables.OSS_BUCKET)) fail('STORAGE_SCOPE_INVALID');
  return Object.freeze({ variables: Object.freeze(variables), summary: Object.freeze({ profile: productionCloudProfile,
    env: 0, mode: 'closed', purchaseProfile: 'android-only-v1', salesEnabled: false, generationEnabled: false,
    processEnabled: false, cleanupEnabled: false, reconcileEnabled: false, productCount: 0, effectCount: 0,
    publicDisclosureStatus: 'pending_company_approval', independentSessionKey: true, sandboxKeyIncluded: false,
    exactPolicyBytes: true, providerEvidenceIncluded: acceptanceBytes !== undefined, cloudOperationPerformed: false }) });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // No CLI option reads credentials, generates keys, submits or writes files.
  console.log(JSON.stringify({ profile: productionCloudProfile, action: 'no-op', requiresExplicitInputs: true,
    privateFilesRead: false, cloudOperationPerformed: false }));
}
