import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildMiniProductionCloudProfile, productionClosedPolicy } from '../scripts/mini-production-cloud-profile.mjs';
import { builtinProductionMysql } from '../payments/virtual/mysql-transport.js';
import { materializePhotoProductionFiles } from '../photo-jobs/production-bootstrap.js';
import { photoProductionConfig } from '../photo-jobs/production-server.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const policyPath = path.join(server, productionClosedPolicy.relativePath);
const policyBytes = fs.readFileSync(policyPath);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const appId = builtinProductionMysql.appId;

function sources() {
  return {
    payment: { WECHAT_APP_ID: appId, XPAY_OFFER_ID: '1450662722', XPAY_SANDBOX_APP_KEY: 'synthetic-sandbox-key',
      XPAY_SESSION_ENCRYPTION_KEY: '1'.repeat(64), WECHAT_APP_SECRET: 'synthetic-app-secret',
      XPAY_MESSAGE_TOKEN: 'synthetic-message-token', XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 3).toString('base64').slice(0, -1) },
    production: { WECHAT_APP_ID: appId, XPAY_OFFER_ID: '1450662722', XPAY_ENV: '0', XPAY_APP_KEY: 'synthetic-production-key' },
    database: { XPAY_MYSQL_DATABASE: builtinProductionMysql.database, XPAY_MYSQL_USER: 'lyx_xpay_prod',
      XPAY_MYSQL_ACCOUNT_HOST: '%', XPAY_MYSQL_PASSWORD: 'synthetic-database-password' },
    media: { ALIYUN_ACCESS_KEY_ID: 'synthetic-ak', ALIYUN_ACCESS_KEY_SECRET: 'synthetic-secret',
      DASHSCOPE_API_KEY: 'synthetic-dashscope-key', DASHSCOPE_BASE: 'https://demo.cn-beijing.maas.aliyuncs.com',
      OSS_BUCKET: 'synthetic-private-bucket', OSS_REGION: 'oss-cn-shanghai' },
    sessionEncryptionKey: '2'.repeat(64), policyBytes,
  };
}

test('pure profile composes closed env0 variables and returns only a safe summary', () => {
  const input = sources(), before = { ...structuredClone(input), policyBytes: Buffer.from(input.policyBytes) };
  const result = buildMiniProductionCloudProfile(input);
  assert.deepEqual(input, before);
  assert.equal(result.summary.profile, 'mini-photo-production-closed-v1');
  assert.equal(result.summary.env, 0); assert.equal(result.summary.mode, 'closed');
  assert.equal(result.summary.purchaseProfile, 'android-only-v1');
  assert.equal(result.summary.salesEnabled, false); assert.equal(result.summary.generationEnabled, false);
  assert.equal(result.summary.processEnabled, false); assert.equal(result.summary.cleanupEnabled, false);
  assert.equal(result.summary.reconcileEnabled, false); assert.equal(result.summary.productCount, 0);
  assert.equal(result.summary.effectCount, 0); assert.equal(result.summary.publicDisclosureStatus, 'pending_company_approval');
  assert.equal(result.summary.independentSessionKey, true); assert.equal(result.summary.sandboxKeyIncluded, false);
  assert.equal(result.summary.cloudOperationPerformed, false);
  assert.equal(result.variables.XPAY_MODE, 'closed'); assert.equal(result.variables.XPAY_ENV, '0');
  assert.equal(result.variables.XPAY_PRODUCTS_JSON, '[]'); assert.equal(result.variables.XPAY_PURPOSE_RULES_JSON, '{}');
  assert.equal(result.variables.XPAY_RECONCILE_ENABLED, 'false');
  assert.equal(result.variables.XPAY_APP_KEY, input.production.XPAY_APP_KEY);
  assert.equal(result.variables.XPAY_SESSION_ENCRYPTION_KEY, input.sessionEncryptionKey);
  assert.equal(result.variables.XPAY_SANDBOX_APP_KEY, undefined);
  assert.equal(result.variables.PHOTO_PRODUCTION_CONFIG_SHA256, digest(policyBytes));
  assert.equal(Object.isFrozen(result.variables), true); assert.equal(Object.isFrozen(result.summary), true);
});

test('source extras cannot inject open switches, files, debug, public claims or sandbox credentials into the profile', () => {
  const input = sources();
  const poison = { XPAY_MODE: 'live', XPAY_ENV: '1', XPAY_APP_KEY: 'wrong-source-key', XPAY_PRODUCTS_JSON: '[{"id":"forged"}]',
    XPAY_RECONCILE_ENABLED: 'true', PHOTO_PRODUCTION_GENERATION_ENABLED: 'true', PHOTO_PRODUCTION_PROCESS_ENABLED: 'true',
    PHOTO_PRODUCTION_CLEANUP_ENABLED: 'true', DEBUG: '*', NODE_TLS_REJECT_UNAUTHORIZED: '0',
    PHOTO_PRODUCTION_CONFIG_FILE: '/private/existing.json', PHOTO_PRODUCTION_ACCEPTANCE_FILE: '/private/forged.json',
    PRIVACY_POLICY_URL: 'https://forged.invalid', AI_SERVICE_DISCLOSURES_JSON: '[{"verified":true}]', UNRELATED_SECRET: 'must-never-copy' };
  for (const name of ['payment', 'media']) Object.assign(input[name], poison);
  const result = buildMiniProductionCloudProfile(input), vars = result.variables;
  assert.equal(vars.XPAY_MODE, 'closed'); assert.equal(vars.XPAY_ENV, '0'); assert.equal(vars.XPAY_APP_KEY, 'synthetic-production-key');
  assert.equal(vars.XPAY_PRODUCTS_JSON, '[]'); assert.equal(vars.DEBUG, ''); assert.equal(vars.PRIVACY_POLICY_URL, '');
  assert.equal(vars.AI_SERVICE_DISCLOSURES_JSON, '[]');
  for (const key of ['XPAY_RECONCILE_ENABLED', 'PHOTO_PRODUCTION_GENERATION_ENABLED', 'PHOTO_PRODUCTION_PROCESS_ENABLED', 'PHOTO_PRODUCTION_CLEANUP_ENABLED']) assert.equal(vars[key], 'false');
  for (const key of ['XPAY_SANDBOX_APP_KEY', 'NODE_TLS_REJECT_UNAUTHORIZED', 'PHOTO_PRODUCTION_CONFIG_FILE',
    'PHOTO_PRODUCTION_ACCEPTANCE_FILE', 'UNRELATED_SECRET']) assert.equal(Object.hasOwn(vars, key), false);
  const summary = JSON.stringify(result.summary);
  for (const value of [input.payment.WECHAT_APP_ID, input.media.OSS_BUCKET, input.media.DASHSCOPE_BASE,
    input.payment.WECHAT_APP_SECRET, input.production.XPAY_APP_KEY, input.database.XPAY_MYSQL_PASSWORD, input.sessionEncryptionKey]) {
    assert.equal(summary.includes(value), false);
  }
});

test('assembled exact policy survives bootstrap materialization and production config validation without SDK/startup', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-production-profile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const input = sources(), result = buildMiniProductionCloudProfile(input);
  const prepared = materializePhotoProductionFiles({ env: result.variables, temporaryRoot: root });
  try {
    const config = photoProductionConfig({ ...result.variables, ...prepared.paths });
    assert.equal(config.env, 0); assert.equal(config.mode, 'closed'); assert.equal(config.purchaseProfile, 'android-only-v1');
    assert.equal(config.generationEnabled, false); assert.equal(config.processEnabled, false);
    assert.equal(config.cleanupEnabled, false); assert.equal(config.reconcileEnabled, false);
    assert.equal(config.products.length, 0); assert.equal(config.approvedEffects.length, 0);
    assert.equal(config.publicProfile.status, 'pending_company_approval'); assert.equal(config.acceptanceFile, null);
    assert.deepEqual(fs.readFileSync(prepared.paths.PHOTO_PRODUCTION_CONFIG_FILE), policyBytes);
  } finally { prepared.cleanup(); }
  assert.equal(fs.readdirSync(root).length, 0);
});

test('optional v4 provider evidence is accepted only as exact bytes and fixed model facts, never generated by this module', () => {
  const input = sources();
  const report = { probeVersion: 'synthetic-generation-v4', provider: 'aliyun-qwen-image', model: 'qwen-image-2.0-2026-03-03',
    resultUrlPolicy: 'qwen-dashscope-result-url-v1', labelVersion: 'synthetic-generation-v4', moderationVersion: 'synthetic-generation-v4',
    moderationServices: { input: 'baselineCheck', output: 'aigcCheck' }, executed: true, syntheticOnly: true, passed: true,
    inputAllowed: true, outputAllowed: true, marked: true, outputReadMatches: true, outputAbsentObserved: true,
    scratchAbsentObserved: 2, cleanupPending: false, attemptedGenerationCalls: 1, attemptedGreenCalls: 2 };
  const bytes = Buffer.from(JSON.stringify(report)), result = buildMiniProductionCloudProfile({ ...input, acceptanceBytes: bytes, acceptanceSha256: digest(bytes) });
  assert.equal(result.summary.providerEvidenceIncluded, true); assert.equal(result.variables.PHOTO_PRODUCTION_ACCEPTANCE_BASE64, bytes.toString('base64'));
  for (const mutate of [
    value => ({ ...value, model: 'qwen-image-edit-plus-2025-12-15' }),
    value => ({ ...value, attemptedGenerationCalls: 2 }),
    value => ({ ...value, cleanupPending: true }),
    value => ({ ...value, scratchAbsentObserved: 1 }),
  ]) {
    const changed = Buffer.from(JSON.stringify(mutate(report)));
    assert.throws(() => buildMiniProductionCloudProfile({ ...input, acceptanceBytes: changed, acceptanceSha256: digest(changed) }), /ACCEPTANCE_INVALID/);
  }
  assert.throws(() => buildMiniProductionCloudProfile({ ...input, acceptanceBytes: bytes, acceptanceSha256: '0'.repeat(64) }), /DOCUMENT_INVALID/);
});

test('source scope, independent key, policy digest, endpoint and storage mismatches fail closed before SDK/network', () => {
  const base = sources();
  const cases = [
    ['app', { payment: { ...base.payment, WECHAT_APP_ID: 'wx0000000000000000' } }],
    ['offer', { payment: { ...base.payment, XPAY_OFFER_ID: 'different-offer' } }],
    ['production-key', { production: { ...base.production, XPAY_APP_KEY: base.payment.XPAY_SANDBOX_APP_KEY } }],
    ['session', { sessionEncryptionKey: base.payment.XPAY_SESSION_ENCRYPTION_KEY }],
    ['db-user', { database: { ...base.database, XPAY_MYSQL_USER: 'lyx_xpay_sandbox' } }],
    ['policy', { policyBytes: Buffer.from('{}') }],
    ['endpoint', { media: { ...base.media, DASHSCOPE_BASE: 'https://dashscope.aliyuncs.com.evil.invalid' } }],
    ['region', { media: { ...base.media, OSS_REGION: 'oss-cn-beijing' } }],
    ['bucket', { media: { ...base.media, OSS_BUCKET: 'bad.bucket' } }],
  ];
  for (const [name, change] of cases) assert.throws(() => buildMiniProductionCloudProfile({ ...base, ...change }), error => {
    assert.match(error.message, /^PRODUCTION_CLOUD_PROFILE_/); assert.ok(!error.message.includes(name)); return true;
  });
});

test('CLI is a no-op and does not read private files or call cloud', () => {
  const node = process.execPath, file = path.join(server, 'scripts/mini-production-cloud-profile.mjs');
  const run = spawnSync(node, [file], { encoding: 'utf8', env: { PATH: process.env.PATH } });
  assert.equal(run.status, 0); assert.deepEqual(JSON.parse(run.stdout), { profile: 'mini-photo-production-closed-v1', action: 'no-op', requiresExplicitInputs: true, privateFilesRead: false, cloudOperationPerformed: false });
  assert.equal(run.stderr, '');
});
