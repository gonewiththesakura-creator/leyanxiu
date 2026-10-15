import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { builtinProductionMysql } from '../payments/virtual/mysql-transport.js';
import { buildMiniProductionMerchantTestProfile, merchantTestAcceptanceSha256, merchantTestPolicySha256, merchantTestProfile, merchantTestJournal } from '../scripts/prepare-mini-production-merchant-test.mjs';
import { buildMiniProductionCloudProfile, productionClosedPolicy } from '../scripts/mini-production-cloud-profile.mjs';
import { materializePhotoProductionFiles } from '../photo-jobs/production-bootstrap.js';
import { photoProductionConfig } from '../photo-jobs/production-server.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(server, relative));
const appId = builtinProductionMysql.appId;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const allowed = 'usr_00000000-0000-0000-0000-000000000001';
const operator = 'usr_00000000-0000-0000-0000-000000000002';
function input() {
  const inherited = buildMiniProductionCloudProfile({
    payment: { WECHAT_APP_ID: appId, XPAY_OFFER_ID: '1450662722', XPAY_SANDBOX_APP_KEY: 'synthetic-sandbox-key',
      XPAY_SESSION_ENCRYPTION_KEY: '1'.repeat(64), WECHAT_APP_SECRET: 'synthetic-app-secret',
      XPAY_MESSAGE_TOKEN: 'synthetic-message-token', XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 3).toString('base64').slice(0, -1) },
    production: { WECHAT_APP_ID: appId, XPAY_OFFER_ID: '1450662722', XPAY_ENV: '0', XPAY_APP_KEY: 'synthetic-production-key' },
    database: { XPAY_MYSQL_DATABASE: builtinProductionMysql.database, XPAY_MYSQL_USER: 'lyx_xpay_prod',
      XPAY_MYSQL_ACCOUNT_HOST: '%', XPAY_MYSQL_PASSWORD: 'synthetic-db-password' },
    media: { ALIYUN_ACCESS_KEY_ID: 'synthetic-ak', ALIYUN_ACCESS_KEY_SECRET: 'synthetic-secret',
      DASHSCOPE_API_KEY: 'synthetic-dashscope', DASHSCOPE_BASE: 'https://dashscope.aliyuncs.com',
      OSS_BUCKET: 'synthetic-private-bucket', OSS_REGION: 'oss-cn-shanghai' },
    sessionEncryptionKey: 'a'.repeat(64), policyBytes: read(productionClosedPolicy.relativePath),
    acceptanceBytes: read('evidence/mini-photo-synthetic-generation-v4.json'),
    acceptanceSha256: 'f8cc698254966ab46c22ef60bbfa7c2b47cb82d5705483d45043a9f944a37dde',
  }).variables;
  return {
    inherited: { ...inherited },
    testUserIds: [allowed], refundOperatorUserIds: [operator],
    publicDocuments: { privacyPolicyUrl: 'https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/privacy.html', userAgreementUrl: 'https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/terms.html', thirdPartyListUrl: 'https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/third-parties.html' },
    retentionSupplierPolicy: '本方原图与结果最长在线24小时，到期或撤回后撤销访问并安排清理。',
    aiServiceDisclosures: [{ provider: 'aliyun-qwen-image', model: 'qwen-image-2.0-2026-03-03', filingReference: 'synthetic-filing-reference', purpose: 'photo-effect:natural-avatar', region: 'cn-shanghai', capabilities: ['photo-effect'] }],
    pipiaReference: 'synthetic-fixture-assessment-not-a-company-approval',
    policyBytes: read('docs/production-config/natural-avatar-merchant-policy-2026-10-13.json'),
    acceptanceBytes: read('evidence/mini-photo-natural-avatar-v2-runtime-2026-10-13.json'), acceptanceSha256: merchantTestAcceptanceSha256,
  };
}

test('merchant-test assembler fixes env/product/purpose and reuses the inherited session key', () => {
  const value = input(), before = structuredClone(value), result = buildMiniProductionMerchantTestProfile(value);
  assert.deepEqual(structuredClone(value), before);
  assert.equal(result.summary.profile, merchantTestProfile); assert.equal(result.summary.env, 0); assert.equal(result.summary.mode, 'merchant_test');
  assert.equal(result.summary.merchantSalesConfigured, true); assert.equal(result.summary.runtimeSalesEnabled, null);
  assert.equal(result.summary.realChargesPossibleAfterDeployment, true); assert.equal(result.summary.runtimeReadinessRequired, true);
  assert.equal(result.variables.XPAY_MODE, 'merchant_test'); assert.equal(result.variables.XPAY_ENV, '0');
  assert.equal(result.variables.XPAY_SESSION_ENCRYPTION_KEY, value.inherited.XPAY_SESSION_ENCRYPTION_KEY);
  assert.equal(result.variables.XPAY_SANDBOX_APP_KEY, undefined); assert.equal(JSON.parse(result.variables.XPAY_PRODUCTS_JSON)[0].amountFen, 990);
  assert.deepEqual(JSON.parse(result.variables.XPAY_PURPOSE_RULES_JSON), { 'photo-effect:natural-avatar': { kind: 'photo', reviewed: true } });
  assert.equal(result.variables.PHOTO_PRODUCTION_CONFIG_SHA256, merchantTestPolicySha256); assert.equal(result.variables.PHOTO_PRODUCTION_ACCEPTANCE_SHA256, merchantTestAcceptanceSha256);
  assert.equal(result.summary.testUserCount, 1); assert.equal(result.summary.refundOperatorCount, 1);
  assert.equal(result.summary.effectCount, 1);
  assert.deepEqual(JSON.parse(result.variables.XPAY_PRODUCTS_JSON), [{ id: 'photo10', name: '图片处理10次包', amountFen: 990,
    type: 'pack', days: 365, components: [{ kind: 'photo', quantity: 10, valueFen: 990 }] }]);
  for (const key of ['XPAY_SESSION_ENCRYPTION_KEY', 'XPAY_APP_KEY', 'XPAY_MYSQL_PASSWORD', 'XPAY_MYSQL_DATABASE',
    'XPAY_MYSQL_HOST', 'XPAY_MYSQL_USER', 'XPAY_MESSAGE_TOKEN', 'XPAY_MESSAGE_AES_KEY', 'WECHAT_APP_SECRET',
    'ALIYUN_ACCESS_KEY_ID', 'ALIYUN_ACCESS_KEY_SECRET', 'DASHSCOPE_API_KEY', 'NODE_EXTRA_CA_CERTS', 'PYTHON_PATH', 'AI_MARK_FONT']) {
    assert.equal(result.variables[key], value.inherited[key], key);
  }
  assert.equal(result.variables.XPAY_TEST_USER_IDS, allowed);
  assert.equal(result.variables.XPAY_REFUND_OPERATOR_USER_IDS, operator);
  assert.equal(Object.isFrozen(result.summary.product), true);
});

test('assembler fails closed for missing real identity/disclosure, policy drift, or session rotation', () => {
  const base = input();
  assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, testUserIds: [] }), /MERCHANT_TEST_TEST_ALLOWLIST_REQUIRED/);
  assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, refundOperatorUserIds: [] }), /MERCHANT_TEST_REFUND_OPERATOR_REQUIRED/);
  assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, pipiaReference: '' }), /MERCHANT_TEST_DISCLOSURE_REQUIRED/);
  assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, publicDocuments: { ...base.publicDocuments, privacyPolicyUrl: 'http://example.com' } }), /MERCHANT_TEST_DISCLOSURE_REQUIRED/);
  assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, acceptanceSha256: '0'.repeat(64) }), /MERCHANT_TEST_ACCEPTANCE_INVALID/);
  assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, sessionEncryptionKey: 'c'.repeat(64) }), /MERCHANT_TEST_INPUT_INVALID/);
  assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, inherited: { ...base.inherited, XPAY_SANDBOX_APP_KEY: 'unexpected' } }), /MERCHANT_TEST_INHERITED_SCOPE_INVALID/);
});

test('journal is redacted and does not contain identity, credential, URL or disclosure values', () => {
  const value = input(), result = buildMiniProductionMerchantTestProfile(value);
  const journal = merchantTestJournal(result, { preparedAt: '2026-10-13T00:00:00.000Z', inputPath: 'D:\\private\\input.json' });
  const text = JSON.stringify(journal);
  assert.equal(journal.deployment.cloudOperationPerformed, false); assert.equal(journal.product.id, 'photo10');
  for (const secret of [value.inherited.XPAY_SESSION_ENCRYPTION_KEY, value.inherited.XPAY_MYSQL_PASSWORD, value.inherited.WECHAT_APP_SECRET, allowed, operator, ...Object.values(value.publicDocuments)]) assert.equal(text.includes(secret), false);
  assert.equal(journal.source.liveSourceVerified, false);
  assert.throws(() => merchantTestJournal({ ...result, summary: { ...result.summary, product: { secret: 'must-not-serialize' } } }), /MERCHANT_TEST_RESULT_INVALID/);
  assert.throws(() => merchantTestJournal(result, { preparedAt: '2026-02-30T00:00:00.000Z' }), /MERCHANT_TEST_JOURNAL_INVALID/);
});

test('default CLI is plan-only and does not read a private input or call cloud', () => {
  const file = path.join(server, 'scripts/prepare-mini-production-merchant-test.mjs');
  const run = spawnSync(process.execPath, [file], { cwd: server, encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0); const output = JSON.parse(run.stdout); assert.equal(output.action, 'plan');
  assert.equal(output.readsPrivateFiles, false); assert.equal(output.cloudOperationPerformed, false); assert.equal(run.stderr, '');
  const explicit = spawnSync(process.execPath, [file, '--plan'], { cwd: server, encoding: 'utf8', env: {
    PATH: process.env.PATH, XPAY_ENV: '1', XPAY_MODE: 'live', XPAY_SESSION_ENCRYPTION_KEY: 'sentinel-must-not-print',
    DOTENV_CONFIG_PATH: 'nonexistent-private-file' } });
  assert.equal(explicit.status, 0); assert.deepEqual(JSON.parse(explicit.stdout), output); assert.equal(explicit.stderr, '');
  const invalid = spawnSync(process.execPath, [file, '--deploy', 'sentinel-must-not-print'], { cwd: server, encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr.trim(), 'MERCHANT_TEST_ARGUMENT_INVALID');
});

test('every inherited 015 field is required and unknown environment or broadening attempts are rejected', () => {
  const base = input();
  for (const key of Object.keys(base.inherited)) {
    const inherited = { ...base.inherited }; delete inherited[key];
    assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, inherited }), /^Error: MERCHANT_TEST_/, key);
  }
  for (const [key, bad] of Object.entries({ XPAY_ENV: '1', XPAY_MODE: 'live', AUTH_MODE: 'anonymous', DEPLOY_ENV: 'development',
    XPAY_DB_BACKEND: 'sqlite', WECHAT_APP_ID: 'wx0000000000000000', XPAY_OFFER_ID: 'wrong-offer',
    XPAY_MYSQL_DATABASE: 'leyanxiu_xpay_sandbox', XPAY_MYSQL_USER: 'lyx_xpay_sandbox', XPAY_MYSQL_PORT: 3306,
    XPAY_MYSQL_ACCOUNT_HOST: '127.0.0.1', XPAY_SESSION_ENCRYPTION_KEY: '', XPAY_MESSAGE_AES_KEY: 'invalid-key',
    OSS_REGION: 'oss-cn-beijing', OSS_BUCKET: 'invalid.bucket', DASHSCOPE_BASE: 'https://invalid.example',
    DEBUG: '*', NODE_TLS_REJECT_UNAUTHORIZED: '0', NODE_OPTIONS: '--require=bad', XPAY_ACCEPTANCE_FILE: '/forged',
    PHOTO_PRODUCTION_CONFIG_FILE: '/conflict', PHOTO_PRODUCTION_ACCEPTANCE_FILE: '/conflict',
    XPAY_SANDBOX_APP_KEY: 'sandbox-key', UNKNOWN_SECRET: 'must-never-print', PHOTO_PRODUCTION_PROCESS_ENABLED: 'true' })) {
    assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, inherited: { ...base.inherited, [key]: bad } }), /^Error: MERCHANT_TEST_/, key);
  }
  const result = buildMiniProductionMerchantTestProfile({ ...base, inherited: { ...base.inherited, ALIYUN_SECURITY_TOKEN: 'synthetic-sts' } });
  assert.equal(result.variables.ALIYUN_SECURITY_TOKEN, 'synthetic-sts');
});

test('exact raw evidence and predecessor bytes are pinned; rehashed altered or stale reports cannot authorize v2', () => {
  const base = input();
  assert.equal(digest(base.policyBytes), merchantTestPolicySha256);
  assert.equal(digest(base.acceptanceBytes), merchantTestAcceptanceSha256);
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(base.acceptanceBytes), productionApproved: true }));
  for (const change of [
    { policyBytes: Buffer.concat([base.policyBytes, Buffer.from(' ')]) },
    { acceptanceBytes: changed, acceptanceSha256: digest(changed) },
    { acceptanceBytes: read('evidence/mini-photo-synthetic-generation-v4.json'), acceptanceSha256: base.inherited.PHOTO_PRODUCTION_ACCEPTANCE_SHA256 },
    { acceptanceBytes: Buffer.from(JSON.stringify({ passed: true })) },
    { inherited: { ...base.inherited, PHOTO_PRODUCTION_ACCEPTANCE_BASE64: changed.toString('base64'), PHOTO_PRODUCTION_ACCEPTANCE_SHA256: digest(changed) } },
    { inherited: { ...base.inherited, PHOTO_PRODUCTION_CONFIG_BASE64: base.inherited.PHOTO_PRODUCTION_CONFIG_BASE64 + '\n' } },
  ]) assert.throws(() => buildMiniProductionMerchantTestProfile({ ...base, ...change }), /^Error: MERCHANT_TEST_/);
});

test('identity lists stay independent and reject missing, duplicate, wildcard, sparse or accessor inputs', () => {
  for (const field of ['testUserIds', 'refundOperatorUserIds']) {
    for (const values of [undefined, [], [allowed, allowed], ['*'], ['openid-not-a-ledger-user'], Array(1), [allowed + ' ']]) {
      assert.throws(() => buildMiniProductionMerchantTestProfile({ ...input(), [field]: values }), /^Error: MERCHANT_TEST_/);
    }
    let called = false; const values = [allowed];
    Object.defineProperty(values, '0', { get() { called = true; return allowed; } });
    assert.throws(() => buildMiniProductionMerchantTestProfile({ ...input(), [field]: values }), /^Error: MERCHANT_TEST_/);
    assert.equal(called, false);
  }
  // An operator is not silently admitted to generation/purchase; identical
  // lists are allowed only when the caller explicitly supplies both roles.
  const result = buildMiniProductionMerchantTestProfile({ ...input(), refundOperatorUserIds: [allowed] });
  assert.equal(result.variables.XPAY_REFUND_OPERATOR_USER_IDS, allowed);
});

test('unknown, hidden and accessor fields cannot override credentials or fabricate public facts', () => {
  const scenarios = [
    value => { value.sessionEncryptionKey = 'unexpected'; },
    value => { value.inherited[Symbol('hidden')] = 'unexpected'; },
    value => { Object.defineProperty(value.inherited, 'ALIYUN_ACCESS_KEY_SECRET', { value: 'synthetic-secret', enumerable: false }); },
    value => { value.publicDocuments.approved = true; },
    value => { value.aiServiceDisclosures[0].verified = true; },
    value => { value.aiServiceDisclosures = Array(1); },
    value => { value.aiServiceDisclosures[0].capabilities = Array(1); },
    value => { value.aiServiceDisclosures[0].model = 'unrelated-model'; },
    value => { value.publicDocuments.privacyPolicyUrl = 'https://localhost/privacy'; },
    value => { value.publicDocuments.privacyPolicyUrl = 'https://internal.lan/privacy'; },
    value => { value.publicDocuments.privacyPolicyUrl = 'https://example.com/private?token=REDACTED_SECRET },
  ];
  for (const change of scenarios) { const value = input(); change(value); assert.throws(() => buildMiniProductionMerchantTestProfile(value), /^Error: MERCHANT_TEST_/); }
  for (const target of ['top', 'inherited', 'documents', 'disclosures']) {
    let called = false; const value = input();
    const [object, key] = target === 'top' ? [value, 'inherited'] : target === 'inherited' ? [value.inherited, 'WECHAT_APP_SECRET']
      : target === 'documents' ? [value.publicDocuments, 'privacyPolicyUrl'] : [value.aiServiceDisclosures[0], 'purpose'];
    Object.defineProperty(object, key, { get() { called = true; return 'must-not-read'; }, enumerable: true });
    assert.throws(() => buildMiniProductionMerchantTestProfile(value), /^Error: MERCHANT_TEST_/); assert.equal(called, false);
  }
});

test('merchant profile survives existing bootstrap and production config without SDK, SQL or server startup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-merchant-profile-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const value = input(), result = buildMiniProductionMerchantTestProfile(value);
  const prepared = materializePhotoProductionFiles({ env: result.variables, temporaryRoot: directory });
  try {
    const config = photoProductionConfig({ ...result.variables, ...prepared.paths });
    assert.equal(config.env, 0); assert.equal(config.mode, 'merchant_test'); assert.equal(config.purchaseProfile, 'android-only-v1');
    assert.deepEqual(config.testUserIds, [allowed]); assert.deepEqual(config.refundOperatorUserIds, [operator]);
    assert.equal(config.publicProfile.status, 'approved'); assert.equal(config.approvedEffects.length, 1);
    assert.equal(config.approvedEffects[0].version, 'natural-avatar-v2-20261013');
    assert.equal(config.products.length, 1); assert.equal(config.products[0].id, 'photo10');
    for (const key of ['generationEnabled', 'processEnabled', 'cleanupEnabled', 'reconcileEnabled']) assert.equal(config[key], true);
    assert.deepEqual(fs.readFileSync(prepared.paths.PHOTO_PRODUCTION_CONFIG_FILE), value.policyBytes);
    assert.deepEqual(fs.readFileSync(prepared.paths.PHOTO_PRODUCTION_ACCEPTANCE_FILE), value.acceptanceBytes);
    assert.equal(result.summary.cloudOperationPerformed, false); assert.equal(result.summary.deployed, false);
  } finally { prepared.cleanup(); }
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('explicit CLI prepare writes only a redacted journal and never overwrites existing files or accepts unknown inputs', t => {
  // The repository ignores *.local; all credentials and identities here are
  // synthetic. Create a unique isolated directory, never use a real .env.
  const directory = path.join(server, `merchant-profile-test-${randomUUID()}.local`);
  fs.mkdirSync(directory);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { policyBytes: _policy, acceptanceBytes: _report, ...values } = input();
  const file = path.join(server, 'scripts/prepare-mini-production-merchant-test.mjs');
  const inputFile = path.join(directory, 'input.json'), journalFile = path.join(directory, 'journal.json');
  const run = (...args) => spawnSync(process.execPath, [file, ...args], { cwd: server, encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } });
  fs.writeFileSync(inputFile, JSON.stringify(values), { flag: 'wx' });
  const prepared = run('--prepare', inputFile, journalFile);
  assert.equal(prepared.status, 0, prepared.stderr); assert.equal(prepared.stderr, '');
  assert.equal(JSON.parse(prepared.stdout).journalWritten, true);
  const journalBytes = fs.readFileSync(journalFile), journal = JSON.parse(journalBytes);
  assert.equal(journal.deployment.cloudOperationPerformed, false); assert.equal(journal.deployment.releaseSubmitted, false);
  assert.equal(journal.identities.testUserCount, 1); assert.equal(journal.source.liveSourceVerified, false);
  const outputs = prepared.stdout + journalBytes.toString();
  for (const secret of [allowed, operator, ...Object.values(values.publicDocuments), values.pipiaReference,
    values.inherited.XPAY_SESSION_ENCRYPTION_KEY, values.inherited.XPAY_MYSQL_PASSWORD, values.inherited.WECHAT_APP_SECRET]) {
    assert.equal(outputs.includes(secret), false);
  }
  const again = run('--prepare', inputFile, journalFile);
  assert.equal(again.status, 1); assert.equal(again.stdout, '');
  assert.equal(again.stderr.trim(), 'MERCHANT_TEST_JOURNAL_TARGET_INVALID');
  assert.deepEqual(fs.readFileSync(journalFile), journalBytes);
  const invalidFile = path.join(directory, 'invalid.json'), untouched = path.join(directory, 'must-not-exist.json');
  fs.writeFileSync(invalidFile, JSON.stringify({ ...values, sessionEncryptionKey: 'do-not-print-or-use' }), { flag: 'wx' });
  const invalid = run('--prepare', invalidFile, untouched);
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, ''); assert.equal(invalid.stderr.trim(), 'MERCHANT_TEST_INPUT_INVALID');
  assert.equal(fs.existsSync(untouched), false);
  assert.deepEqual(fs.readdirSync(directory).sort(), ['input.json', 'invalid.json', 'journal.json']);
});
