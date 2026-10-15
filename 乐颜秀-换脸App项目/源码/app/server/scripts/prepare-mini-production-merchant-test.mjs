import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPrivateProductionMysqlTarget, builtinProductionMysql, privateProductionTransport, virtualMysqlOptions } from '../payments/virtual/mysql-transport.js';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { parseVirtualProducts } from '../payments/virtual/products.js';
import { checkedQwenPhotoApiEndpoint, QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_RESULT_POLICY } from '../photo-jobs/qwen-provider.js';
import { photoCandidatePublicProfile, photoPublicDisclosureReady } from '../photo-jobs/candidate-public.js';
import { productionClosedPolicy } from './mini-production-cloud-profile.mjs';

// This is a local, explicit-input assembler. It does not load dotenv, start a
// server, open MySQL, call a provider, or use a cloud SDK. The CLI plan is the
// default; --prepare reads a private input document and writes only a redacted
// journal. The returned variables are deliberately kept in memory for a later,
// separately authorized deployment caller.
export const merchantTestProfile = 'mini-photo-production-merchant-test-v1';
export const merchantTestPolicySha256 = 'd3e3292cf66920065afe4bdcd20885662c8e9d5d35b0d943980d2dbf583d86a1';
export const merchantTestAcceptanceSha256 = 'd0f8705c48f5d987e2e57d674370dbf0aa887f063a0483ca629aeea0492789fa';
export const merchantTestProduct = Object.freeze({ id: 'photo10', name: '图片处理10次包', amountFen: 990,
  type: 'pack', days: 365, components: Object.freeze([Object.freeze({ kind: 'photo', quantity: 10, valueFen: 990 })]) });
const appId = builtinProductionMysql.appId;
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const assembledResults = new WeakSet();
const inputKeys = ['inherited', 'policyBytes', 'acceptanceBytes', 'acceptanceSha256', 'testUserIds',
  'refundOperatorUserIds', 'publicDocuments', 'retentionSupplierPolicy', 'aiServiceDisclosures', 'pipiaReference'];
const fail = code => { throw Object.assign(new Error(`MERCHANT_TEST_${code}`), { code: `MERCHANT_TEST_${code}` }); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
function checkedObject(value, allowed, code = 'INPUT_INVALID') {
  if (!plain(value) || Reflect.ownKeys(value).some(key => !allowed.includes(key)
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value')
    || !Object.getOwnPropertyDescriptor(value, key).enumerable)) fail(code);
  return value;
}
function checkedArray(value, maximum, code) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > maximum
    || Reflect.ownKeys(value).length !== value.length + 1
    || Array.from({ length: value.length }, (_, i) => Object.getOwnPropertyDescriptor(value, String(i)))
      .some(descriptor => !descriptor || !Object.hasOwn(descriptor, 'value'))) fail(code);
  return value;
}
const ownString = (value, name, { required = true, maximum = 4096 } = {}) => {
  if (!plain(value)) fail('INPUT_INVALID');
  const descriptor = Object.getOwnPropertyDescriptor(value, name);
  if (!descriptor && !required) return undefined;
  if (!descriptor || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string'
    || !descriptor.value.trim() || descriptor.value.length > maximum || /[\u0000-\u001f\u007f\r\n]/.test(descriptor.value)) fail('INPUT_INVALID');
  return descriptor.value;
};
const ownBuffer = value => {
  if (!Buffer.isBuffer(value)) fail('INPUT_INVALID');
  return value;
};
const userId = value => typeof value === 'string' && /^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const list = (value, name) => {
  checkedArray(value, 20, name);
  if (new Set(value).size !== value.length || value.some(item => !userId(item))) fail(name);
  return [...value];
};
const safeText = (value, maximum, code = 'DISCLOSURE_REQUIRED') => {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(code);
  return value.trim();
};
function documentUrl(value) {
  const parsed = safeText(value, 2048);
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::443)?(?:[/?][^#]*)?$/.test(parsed) || /[\\<>"#?]/.test(parsed)) fail('DISCLOSURE_REQUIRED');
  const url = new URL(parsed);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('DISCLOSURE_REQUIRED');
  return parsed;
}
function disclosureFacts(value, policy) {
  checkedArray(value, 30, 'DISCLOSURE_REQUIRED');
  const facts = value.map(row => {
    checkedObject(row, ['provider', 'model', 'filingReference', 'purpose', 'region', 'capabilities'], 'DISCLOSURE_REQUIRED');
    const capabilities = row.capabilities;
    checkedArray(capabilities, 1, 'DISCLOSURE_REQUIRED');
    if (capabilities[0] !== 'photo-effect' || row.provider !== policy.provider || row.model !== policy.model) fail('DISCLOSURE_REQUIRED');
    return { provider: safeText(row.provider, 80), model: safeText(row.model, 100),
      filingReference: safeText(row.filingReference, 200), purpose: safeText(row.purpose, 500),
      region: safeText(row.region, 100), capabilities: ['photo-effect'] };
  });
  if (facts.length !== 1) fail('DISCLOSURE_REQUIRED');
  return facts;
}
function parsePinned(bytes, expected, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 65536 || hash(bytes) !== expected) fail(code);
  try {
    if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail(code);
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plain(value)) fail(code);
    return value;
  } catch { fail(code); }
}
function validateEvidence(policy, report) {
  const p = policy.policy, e = policy.approvedEffects?.[0], binding = report.acceptanceBinding;
  if (policy.version !== 1 || !plain(p) || p.approved !== true || p.serviceProviderCode !== appId
    || p.provider !== QWEN_PHOTO_PROVIDER || p.model !== QWEN_PHOTO_MODEL || p.resultUrlPolicy !== QWEN_PHOTO_RESULT_POLICY
    || p.acceptanceVersion !== 'natural-avatar-v2-20261013' || p.labelVersion !== p.acceptanceVersion
    || p.moderationVersion !== p.acceptanceVersion || p.moderationService !== 'aigcCheck'
    || !Array.isArray(policy.approvedEffects) || policy.approvedEffects.length !== 1 || !plain(e)
    || e.id !== 'natural-avatar' || e.version !== p.acceptanceVersion || e.provider !== p.provider || e.model !== p.model
    || e.purpose !== 'photo-effect:natural-avatar' || e.approved !== true || e.enabled !== true
    || policy.moderationPolicy?.version !== p.moderationVersion
    || policy.moderationPolicy?.services?.input !== 'baselineCheck' || policy.moderationPolicy?.services?.output !== 'aigcCheck'
    || report.executed !== true || report.syntheticOnly !== true || report.passed !== true || report.deployed !== false
    || report.productionApproved !== false || report.provider !== p.provider || report.model !== p.model
    || report.probeVersion !== p.acceptanceVersion || report.resultUrlPolicy !== p.resultUrlPolicy
    || report.labelVersion !== p.labelVersion || report.moderationVersion !== p.moderationVersion
    || report.moderationServices?.input !== 'baselineCheck' || report.moderationServices?.output !== p.moderationService
    || report.attemptedGenerationCalls !== 1 || report.attemptedGreenCalls !== 2 || report.cleanupPending !== false
    || report.inputAllowed !== true || report.outputAllowed !== true || report.marked !== true || report.outputReadMatches !== true
    || report.outputAbsentObserved !== true || report.scratchAbsentObserved !== 2 || report.permanentErasureConfirmed !== false
    || !plain(binding) || binding.effectId !== e.id || binding.effectVersion !== e.version) fail('EVIDENCE_INVALID');
  return { policy: p, effect: e, report, effectCount: policy.approvedEffects.length };
}
// This is deliberately the closed 015 contract, not a generic environment
// merger. A changed predecessor requires a reviewed code change, never an
// ignored field, implicit fallback, sandbox import or fresh session key.
const inheritedFixed = Object.freeze({ NODE_ENV: 'production', PORT: '3000', BIND_HOST: '0.0.0.0',
  DEBUG: '', NODE_DEBUG: '', NODE_DEBUG_NATIVE: '', NODE_EXTRA_CA_CERTS: '/app/cert/certificate.crt',
  PYTHON_PATH: '/usr/bin/python3', AI_MARK_FONT: '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', DEPLOY_ENV: 'production',
  XPAY_ENABLED: 'true', XPAY_ENV: '0', XPAY_MODE: 'closed', XPAY_DB_BACKEND: 'mysql',
  WECHAT_APP_ID: appId, XPAY_OFFER_ID: '1450662722', XPAY_MYSQL_TRANSPORT: privateProductionTransport,
  XPAY_MYSQL_HOST: builtinProductionMysql.host, XPAY_MYSQL_PORT: String(builtinProductionMysql.port),
  XPAY_MYSQL_DATABASE: builtinProductionMysql.database, XPAY_MYSQL_USER: 'lyx_xpay_prod', XPAY_MYSQL_ACCOUNT_HOST: '%',
  XPAY_MYSQL_INSTANCE_ID: builtinProductionMysql.instanceId, XPAY_CLOUD_ENV_ID: builtinProductionMysql.cloudEnvId,
  XPAY_PRODUCTS_JSON: '[]', XPAY_PURPOSE_RULES_JSON: '{}', XPAY_TEST_USER_IDS: '', XPAY_REFUND_OPERATOR_USER_IDS: '',
  XPAY_RECONCILE_ENABLED: 'false', PHOTO_PRODUCTION_GENERATION_ENABLED: 'false', PHOTO_PRODUCTION_PROCESS_ENABLED: 'false',
  PHOTO_PRODUCTION_CLEANUP_ENABLED: 'false', PHOTO_CANDIDATE_GENERATION_ENABLED: 'false',
  PHOTO_CANDIDATE_PROCESS_ENABLED: 'false', PHOTO_CANDIDATE_CLEANUP_ENABLED: 'false',
  PRIVACY_POLICY_URL: '', USER_AGREEMENT_URL: '', THIRD_PARTY_LIST_URL: '', RETENTION_SUPPLIER_POLICY: '',
  AI_SERVICE_DISCLOSURES_JSON: '[]', PIPIA_REFERENCE: '',
  PHOTO_PRODUCTION_CONFIG_SHA256: productionClosedPolicy.sha256,
  PHOTO_PRODUCTION_ACCEPTANCE_SHA256: 'f8cc698254966ab46c22ef60bbfa7c2b47cb82d5705483d45043a9f944a37dde' });
const inheritedPrivate = ['WECHAT_APP_SECRET', 'XPAY_APP_KEY', 'XPAY_MESSAGE_TOKEN', 'XPAY_MESSAGE_AES_KEY',
  'XPAY_SESSION_ENCRYPTION_KEY', 'XPAY_MYSQL_PASSWORD', 'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET',
  'DASHSCOPE_API_KEY', 'DASHSCOPE_BASE', 'OSS_BUCKET', 'OSS_REGION'];
function validateInherited(inherited) {
  checkedObject(inherited, [...Object.keys(inheritedFixed), ...inheritedPrivate, 'ALIYUN_SECURITY_TOKEN',
    'PHOTO_PRODUCTION_CONFIG_BASE64', 'PHOTO_PRODUCTION_ACCEPTANCE_BASE64'], 'INHERITED_SCOPE_INVALID');
  if (Object.entries(inheritedFixed).some(([key, value]) => inherited[key] !== value)
    || !/^[a-f0-9]{64}$/.test(inherited.XPAY_SESSION_ENCRYPTION_KEY || '')) fail('INHERITED_SCOPE_INVALID');
  for (const key of inheritedPrivate) ownString(inherited, key);
  if (Object.hasOwn(inherited, 'ALIYUN_SECURITY_TOKEN')) ownString(inherited, 'ALIYUN_SECURITY_TOKEN');
  for (const prefix of ['PHOTO_PRODUCTION_CONFIG', 'PHOTO_PRODUCTION_ACCEPTANCE']) {
    const encoded = ownString(inherited, `${prefix}_BASE64`, { maximum: 4 * Math.ceil(65536 / 3) });
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) fail('INHERITED_SCOPE_INVALID');
    parsePinned(bytes, inherited[`${prefix}_SHA256`], 'INHERITED_SCOPE_INVALID');
  }
  return inherited;
}

/** Compose the desired merchant-test environment without producing any cloud request. */
export function buildMiniProductionMerchantTestProfile(input = {}) {
  checkedObject(input, inputKeys);
  const { inherited, policyBytes, acceptanceBytes, acceptanceSha256, testUserIds, refundOperatorUserIds,
    publicDocuments, retentionSupplierPolicy, aiServiceDisclosures, pipiaReference } = input;
  validateInherited(inherited); const facts = validateEvidence(
    parsePinned(ownBuffer(policyBytes), merchantTestPolicySha256, 'POLICY_INVALID'),
    parsePinned(ownBuffer(acceptanceBytes), merchantTestAcceptanceSha256, 'ACCEPTANCE_INVALID'));
  if (acceptanceSha256 !== merchantTestAcceptanceSha256 || hash(acceptanceBytes) !== acceptanceSha256) fail('ACCEPTANCE_INVALID');
  const users = list(testUserIds, 'TEST_ALLOWLIST_REQUIRED'), operators = list(refundOperatorUserIds, 'REFUND_OPERATOR_REQUIRED');
  checkedObject(publicDocuments, ['privacyPolicyUrl', 'userAgreementUrl', 'thirdPartyListUrl'], 'DISCLOSURE_REQUIRED');
  const documents = { privacyPolicyUrl: documentUrl(publicDocuments.privacyPolicyUrl), userAgreementUrl: documentUrl(publicDocuments.userAgreementUrl), thirdPartyListUrl: documentUrl(publicDocuments.thirdPartyListUrl) };
  const retention = safeText(retentionSupplierPolicy, 500), disclosures = disclosureFacts(aiServiceDisclosures, facts.policy);
  const pipia = safeText(pipiaReference, 500);
  const products = JSON.stringify([merchantTestProduct]);
  const purposes = JSON.stringify({ 'photo-effect:natural-avatar': { kind: 'photo', reviewed: true } });
  const variables = { ...inherited, NODE_ENV: 'production', PORT: '3000', BIND_HOST: '0.0.0.0',
    DEBUG: '', NODE_DEBUG: '', NODE_DEBUG_NATIVE: '', RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', DEPLOY_ENV: 'production',
    XPAY_ENABLED: 'true', XPAY_ENV: '0', XPAY_MODE: 'merchant_test', XPAY_DB_BACKEND: 'mysql', WECHAT_APP_ID: appId,
    XPAY_OFFER_ID: '1450662722', XPAY_PRODUCTS_JSON: products, XPAY_PURPOSE_RULES_JSON: purposes,
    XPAY_TEST_USER_IDS: users.join(','), XPAY_REFUND_OPERATOR_USER_IDS: operators.join(','), XPAY_RECONCILE_ENABLED: 'true',
    PHOTO_PRODUCTION_GENERATION_ENABLED: 'true', PHOTO_PRODUCTION_PROCESS_ENABLED: 'true', PHOTO_PRODUCTION_CLEANUP_ENABLED: 'true',
    PHOTO_CANDIDATE_GENERATION_ENABLED: 'false', PHOTO_CANDIDATE_PROCESS_ENABLED: 'false', PHOTO_CANDIDATE_CLEANUP_ENABLED: 'false',
    PHOTO_PRODUCTION_CONFIG_BASE64: policyBytes.toString('base64'), PHOTO_PRODUCTION_CONFIG_SHA256: merchantTestPolicySha256,
    PHOTO_PRODUCTION_ACCEPTANCE_BASE64: acceptanceBytes.toString('base64'), PHOTO_PRODUCTION_ACCEPTANCE_SHA256: merchantTestAcceptanceSha256,
    PRIVACY_POLICY_URL: documents.privacyPolicyUrl, USER_AGREEMENT_URL: documents.userAgreementUrl,
    THIRD_PARTY_LIST_URL: documents.thirdPartyListUrl, RETENTION_SUPPLIER_POLICY: retention,
    AI_SERVICE_DISCLOSURES_JSON: JSON.stringify(disclosures), PIPIA_REFERENCE: pipia };
  if (Object.hasOwn(variables, 'XPAY_SANDBOX_APP_KEY') || variables.XPAY_SESSION_ENCRYPTION_KEY !== inherited.XPAY_SESSION_ENCRYPTION_KEY) fail('SESSION_KEY_ROTATION');
  try {
    createMessageCodec({ appId, token: variables.XPAY_MESSAGE_TOKEN, aesKey: variables.XPAY_MESSAGE_AES_KEY });
    checkedQwenPhotoApiEndpoint(variables.DASHSCOPE_BASE);
    const target = createPrivateProductionMysqlTarget({ database: variables.XPAY_MYSQL_DATABASE,
      user: variables.XPAY_MYSQL_USER, accountHost: variables.XPAY_MYSQL_ACCOUNT_HOST });
    virtualMysqlOptions(variables, { allowCloudrunPrivateProduction: true, productionTarget: target });
    parseVirtualProducts(products);
  } catch { fail('INHERITED_SCOPE_INVALID'); }
  if (variables.OSS_REGION.replace(/^oss-/, '') !== 'cn-shanghai'
    || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(variables.OSS_BUCKET)) fail('INHERITED_SCOPE_INVALID');
  if (!photoPublicDisclosureReady(photoCandidatePublicProfile({ env: variables, policy: facts.policy }))) fail('DISCLOSURE_REQUIRED');
  const result = Object.freeze({ variables: Object.freeze(variables), summary: Object.freeze({ profile: merchantTestProfile, env: 0, mode: 'merchant_test', purchaseProfile: 'android-only-v1',
    merchantSalesConfigured: true, runtimeSalesEnabled: null, realChargesPossibleAfterDeployment: true,
    generationEnabled: true, processEnabled: true, cleanupEnabled: true, reconcileEnabled: true,
    productCount: 1, effectCount: facts.effectCount, product: Object.freeze({ id: merchantTestProduct.id, amountFen: merchantTestProduct.amountFen, days: merchantTestProduct.days, photoCredits: 10 }),
    testUserCount: users.length, refundOperatorCount: operators.length, disclosureDocumentCount: 3, aiServiceDisclosureCount: disclosures.length,
    policySha256: merchantTestPolicySha256, acceptanceSha256: merchantTestAcceptanceSha256, sessionKeyReused: true,
    cloudOperationPerformed: false, deployed: false, publicTraffic: false, runtimeReadinessRequired: true }) });
  assembledResults.add(result);
  return result;
}

export function merchantTestJournal(result, { preparedAt = new Date().toISOString() } = {}) {
  if (!assembledResults.has(result)) fail('RESULT_INVALID');
  if (typeof preparedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(preparedAt)
    || !Number.isFinite(Date.parse(preparedAt)) || new Date(preparedAt).toISOString() !== preparedAt) fail('JOURNAL_INVALID');
  return { version: 1, profile: merchantTestProfile, preparedAt,
    source: { kind: 'existing-015-private-input', provided: true, sessionKeyReused: true, liveSourceVerified: false },
    scope: { env: 0, mode: 'merchant_test', purchaseProfile: 'android-only-v1' },
    policy: { sha256: result.summary.policySha256, acceptanceVersion: 'natural-avatar-v2-20261013', effectIds: ['natural-avatar'] },
    acceptance: { sha256: result.summary.acceptanceSha256, syntheticOnly: true, passed: true, generationCalls: 1, moderationCalls: 2, cleanupPending: false },
    product: result.summary.product, identities: { testUserCount: result.summary.testUserCount, refundOperatorCount: result.summary.refundOperatorCount },
    disclosures: { documentCount: result.summary.disclosureDocumentCount, aiServiceCount: result.summary.aiServiceDisclosureCount, pipiaReferenceProvided: true },
    runtime: { generationEnabled: true, processEnabled: true, cleanupEnabled: true, reconcileEnabled: true, readinessRequired: true,
      merchantSalesConfigured: true, salesEnabled: null, realChargesPossibleAfterDeployment: true },
    deployment: { uploaded: false, releaseSubmitted: false, publicTraffic: false, cloudOperationPerformed: false },
    blockers: ['formal database/schema and existing-015 runtime scope must be rechecked before application',
      'formal WeChat product and payment notification route to the same ledger must be verified; client gray-route parameters do not route payment notifications',
      'Android merchant-test purchase, delivery, callback and refund remain unperformed'] };
}

function ignored(filename) {
  try { execFileSync('git', ['check-ignore', '--quiet', '--', filename], { cwd: server, stdio: 'pipe', windowsHide: true }); return true; } catch { return false; }
}
function privateReadJson(filename) {
  if (!path.isAbsolute(filename) || !ignored(filename)) fail('PRIVATE_INPUT_REQUIRED');
  const stat = fs.lstatSync(filename); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) fail('PRIVATE_INPUT_INVALID');
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { fail('PRIVATE_INPUT_INVALID'); }
}
function pinnedFile(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) fail('DOCUMENT_FILE_INVALID');
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 65536) fail('DOCUMENT_FILE_INVALID');
  return fs.readFileSync(filename);
}
function privateWrite(filename, value) {
  if (!path.isAbsolute(filename) || !ignored(filename) || fs.existsSync(filename)) fail('JOURNAL_TARGET_INVALID');
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n'); fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
  if (hash(fs.readFileSync(filename)) !== hash(bytes)) fail('JOURNAL_WRITE_UNCONFIRMED');
}
export const plan = Object.freeze({ profile: merchantTestProfile, action: 'plan', readsPrivateFiles: false, cloudOperationPerformed: false,
  fixed: { env: 0, mode: 'merchant_test', purchaseProfile: 'android-only-v1', effect: 'natural-avatar-v2-20261013', product: 'photo10' },
  requiredInputs: ['existing-015 private variables including unchanged session key', 'testUserIds', 'refundOperatorUserIds', 'three public document URLs', 'supplier retention policy', 'provider/model disclosure facts', 'PIPIA reference'],
  writes: ['new redacted merchant-test journal only'], realChargesPossibleAfterDeployment: true,
  blockers: ['runtime readiness, formal product and callback routing verification, and Android merchant-test acceptance remain required'] });

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 0 || (args.length === 1 && args[0] === '--plan')) console.log(JSON.stringify(plan));
    else if (args.length === 3 && args[0] === '--prepare') {
      const inputFile = path.resolve(args[1]), journalFile = path.resolve(args[2]); const input = privateReadJson(inputFile);
      const cliInputKeys = inputKeys.filter(key => !['policyBytes', 'acceptanceBytes'].includes(key));
      checkedObject(input, [...cliInputKeys, 'policyFile', 'acceptanceFile']);
      const { policyFile = path.join(server, 'docs/production-config/natural-avatar-merchant-policy-2026-10-13.json'),
        acceptanceFile = path.join(server, 'evidence/mini-photo-natural-avatar-v2-runtime-2026-10-13.json'), ...values } = input;
      const result = buildMiniProductionMerchantTestProfile({ ...values, policyBytes: pinnedFile(policyFile), acceptanceBytes: pinnedFile(acceptanceFile) });
      const journal = merchantTestJournal(result); privateWrite(journalFile, journal);
      console.log(JSON.stringify({ profile: merchantTestProfile, journalWritten: true, ...journal.scope, effect: 'natural-avatar-v2-20261013', product: merchantTestProduct.id, testUserCount: journal.identities.testUserCount, refundOperatorCount: journal.identities.refundOperatorCount, cloudOperationPerformed: false, secretsLogged: false }));
    } else fail('ARGUMENT_INVALID');
  } catch (error) { console.error(/^MERCHANT_TEST_[A-Z0-9_]+$/.test(error?.code) ? error.code : 'MERCHANT_TEST_UNCONFIRMED'); process.exitCode = 1; }
}
