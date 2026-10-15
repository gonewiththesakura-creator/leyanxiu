import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assembleMiniMultiEffectMerchantCandidate, multiEffectMerchantCandidateRecord } from '../scripts/prepare-mini-multieffect-merchant-candidate.mjs';
import { fixtureEffects, fixtureBundle, fixtureReview } from './photo-acceptance-fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = value => Buffer.from(JSON.stringify(value));
const legacyPolicy = JSON.parse(fs.readFileSync(new URL('../docs/production-config/natural-avatar-merchant-policy-2026-10-13.json', import.meta.url)));
const legacyReport = JSON.parse(fs.readFileSync(new URL('../evidence/mini-photo-natural-avatar-v2-runtime-2026-10-13.json', import.meta.url)));
const script = fileURLToPath(new URL('../scripts/prepare-mini-multieffect-merchant-candidate.mjs', import.meta.url));

function fixture() {
  // All variables and new effect reviews are synthetic. The real legacy
  // report stays byte-for-byte unchanged; this fixture is never a candidate.
  const effects = fixtureEffects().filter(effect => ['modern-comic', 'gentle-watercolor'].includes(effect.id));
  const policy = structuredClone(legacyPolicy), version = 'original-effects-v1-20261015';
  Object.assign(policy.policy, { acceptanceVersion: version, labelVersion: version, moderationVersion: version,
    reviewReference: 'synthetic-multieffect-policy' });
  policy.moderationPolicy.version = version;
  policy.approvedEffects.push(...effects);
  const bundle = fixtureBundle(effects);
  bundle.effects.unshift({ effectId: 'natural-avatar', effectVersion: legacyPolicy.approvedEffects[0].version,
    report: structuredClone(legacyReport), qualityReview: fixtureReview(legacyReport) });
  const oldPolicyBytes = bytes(legacyPolicy), oldAcceptanceBytes = bytes(legacyReport);
  const inherited = {
    NODE_ENV: 'production', RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat', DEPLOY_ENV: 'production',
    XPAY_ENV: '0', XPAY_MODE: 'merchant_test', XPAY_ENABLED: 'true', XPAY_DB_BACKEND: 'mysql',
    WECHAT_APP_ID: 'REDACTED_APP_IDENTIFIER', XPAY_SESSION_ENCRYPTION_KEY: '1'.repeat(64),
    XPAY_TEST_USER_IDS: 'usr_11111111-1111-1111-1111-111111111111',
    XPAY_REFUND_OPERATOR_USER_IDS: 'usr_22222222-2222-2222-2222-222222222222',
    XPAY_PRODUCTS_JSON: '[{"id":"synthetic-product-preserve-exact-text"}]', XPAY_APP_KEY: 'synthetic-secret-not-for-output',
    XPAY_PURPOSE_RULES_JSON: JSON.stringify({ 'photo-effect:natural-avatar': { kind: 'photo', reviewed: true },
      'video-effect:existing': { kind: 'video', reviewed: false } }),
    PHOTO_PRODUCTION_CONFIG_BASE64: oldPolicyBytes.toString('base64'), PHOTO_PRODUCTION_CONFIG_SHA256: hash(oldPolicyBytes),
    PHOTO_PRODUCTION_ACCEPTANCE_BASE64: oldAcceptanceBytes.toString('base64'), PHOTO_PRODUCTION_ACCEPTANCE_SHA256: hash(oldAcceptanceBytes),
    PHOTO_PRODUCTION_GENERATION_ENABLED: 'true', PHOTO_PRODUCTION_PROCESS_ENABLED: 'true', PHOTO_PRODUCTION_CLEANUP_ENABLED: 'true',
    XPAY_RECONCILE_ENABLED: 'true', PRIVATE_URL_SENTINEL: 'https://private.invalid/?Signature=REDACTED_SECRET
  };
  const policyBytes = bytes(policy), acceptanceBytes = bytes(bundle);
  return { policy, bundle, inherited, input: { current: { version: 'buildtest-016', variables: inherited },
    policyBytes, policySha256: hash(policyBytes), acceptanceBytes, acceptanceSha256: hash(acceptanceBytes) } };
}
function mutatePinned(f, part, mutate) {
  mutate(f[part]); const key = part === 'policy' ? 'policy' : 'acceptance', value = bytes(f[part]);
  f.input[`${key}Bytes`] = value; f.input[`${key}Sha256`] = hash(value);
}

test('default plan reads no private environment files, has no network and preselects no effects', () => {
  const program = `import fs from 'node:fs';import http from 'node:http';import https from 'node:https';
const read=fs.readFileSync;fs.readFileSync=function(p,...args){if(/(?:^|[\\\\/])\\.env(?:[.\\\\/]|$)/.test(String(p)))throw Error('CREDENTIAL_READ');return read.call(this,p,...args)};
globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};http.request=https.request=http.get=https.get=()=>{throw Error('NETWORK_FORBIDDEN')};
process.argv=[process.execPath,${JSON.stringify(script)},'--plan'];await import(${JSON.stringify(new URL('../scripts/prepare-mini-multieffect-merchant-candidate.mjs', import.meta.url).href)});`;
  const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' }));
  assert.equal(report.dryRun, true); assert.equal(report.currentVersionRequired, 'buildtest-016');
  assert.equal(report.networkCalls, 0); assert.equal(report.readsEnvironmentFiles, false);
  assert.equal(report.acceptedEffectsPreselected, false); assert.equal(report.deployed, false);
});

test('three reviewed effects assemble narrowly from 016 without changing any merchant scope, secret or current variable', () => {
  const f = fixture(), before = structuredClone(f.inherited);
  const result = assembleMiniMultiEffectMerchantCandidate(f.input), record = multiEffectMerchantCandidateRecord(result);
  assert.deepEqual(record.effectIds, ['natural-avatar', 'modern-comic', 'gentle-watercolor']);
  assert.equal(record.dryRun, true); assert.equal(record.cloudOperationPerformed, false); assert.equal(record.deployed, false);
  assert.equal(record.liveSourceVerified, false); assert.equal(record.privateVariablesPersisted, false);
  assert.deepEqual(f.inherited, before, 'caller variables never change');
  for (const [key, value] of Object.entries(before)) {
    if (!record.allowedVariableChanges.includes(key)) assert.equal(result.variables[key], value, key);
  }
  const purposes = JSON.parse(result.variables.XPAY_PURPOSE_RULES_JSON);
  assert.deepEqual(purposes['photo-effect:natural-avatar'], { kind: 'photo', reviewed: true });
  assert.deepEqual(purposes['video-effect:existing'], { kind: 'video', reviewed: false });
  assert.deepEqual(purposes['photo-effect:modern-comic'], { kind: 'photo', reviewed: true });
  assert.equal(purposes['photo-effect:classic-black-white'], undefined);
  assert.equal(purposes['photo-effect:new-chinese'], undefined);
  assert.doesNotMatch(JSON.stringify(record), /synthetic-secret|Signature|private\.invalid|usr_/);
  assert.equal(result.variables.XPAY_SESSION_ENCRYPTION_KEY, before.XPAY_SESSION_ENCRYPTION_KEY);
});

test('015, sandbox, public sales, missing allowlists and debug are rejected before assembly', () => {
  for (const mutate of [f => { f.input.current.version = 'buildtest-015'; },
    f => { f.inherited.XPAY_ENV = '1'; }, f => { f.inherited.XPAY_MODE = 'public'; },
    f => { f.inherited.XPAY_MODE = 'closed'; }, f => { f.inherited.XPAY_TEST_USER_IDS = ''; },
    f => { f.inherited.XPAY_TEST_USER_IDS = '*'; }, f => { f.inherited.XPAY_TEST_USER_IDS += ',*'; },
    f => { f.inherited.XPAY_REFUND_OPERATOR_USER_IDS = ''; }, f => { f.inherited.DEBUG = '*'; }]) {
    const f = fixture(); mutate(f);
    assert.throws(() => assembleMiniMultiEffectMerchantCandidate(f.input), /MULTIEFFECT_CANDIDATE_CURRENT_/);
  }
});

test('pending, missing, added, failed, param-drifted and unbound effect evidence cannot enable a purpose', () => {
  for (const mutate of [b => { b.effects[1].qualityReview.decision = 'pending'; }, b => { b.effects.pop(); },
    b => { b.effects[1].report.passed = false; }, b => { b.effects[1].qualityReview.outputSha256 = 'f'.repeat(64); },
    b => { b.effects.push(b.effects[0]); }]) {
    const f = fixture(); mutatePinned(f, 'bundle', mutate);
    assert.throws(() => assembleMiniMultiEffectMerchantCandidate(f.input), /MULTIEFFECT_CANDIDATE_ACCEPTANCE_INVALID/);
  }
  const f = fixture(); mutatePinned(f, 'policy', p => { p.approvedEffects[1].parameters.seed = 42; });
  assert.throws(() => assembleMiniMultiEffectMerchantCandidate(f.input), /MULTIEFFECT_CANDIDATE_ACCEPTANCE_INVALID/);
});

test('unrelated policy mutation and digest drift fail closed, and only real assembled objects produce records', () => {
  const f = fixture(); mutatePinned(f, 'policy', p => { p.policy.maxDailyUploads = 100000; });
  assert.throws(() => assembleMiniMultiEffectMerchantCandidate(f.input), /POLICY_UNRELATED_CHANGE/);
  const badDigest = fixture(); badDigest.input.policySha256 = '0'.repeat(64);
  assert.throws(() => assembleMiniMultiEffectMerchantCandidate(badDigest.input), /POLICY_PIN_INVALID/);
  assert.throws(() => multiEffectMerchantCandidateRecord({ summary: { deployed: true } }), /RESULT_INVALID/);
  const avatarRemoved = fixture(); mutatePinned(avatarRemoved, 'policy', p => { p.approvedEffects.shift(); });
  assert.throws(() => assembleMiniMultiEffectMerchantCandidate(avatarRemoved.input), /CURRENT_AVATAR_CHANGED/);
});

test('CLI refuses .env input paths without reading credentials and emits safe fixed error', () => {
  try { execFileSync(process.execPath, [script, '--assemble', fileURLToPath(new URL('../.env', import.meta.url))], { encoding: 'utf8', stdio: 'pipe' }); assert.fail('must reject'); }
  catch (error) {
    assert.equal(error.status, 1); assert.equal(error.stdout, '');
    assert.equal(error.stderr.trim(), 'MULTIEFFECT_CANDIDATE_EXPLICIT_NON_ENV_FILE_REQUIRED');
  }
});

test('explicit CLI assembly reads only supplied documents and prints no inherited values or private URLs', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-multieffect-dryrun-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = fixture(), inputFile = path.join(directory, 'explicit-input.json');
  const policyFile = path.join(directory, 'policy.json'), acceptanceFile = path.join(directory, 'bundle.json');
  fs.writeFileSync(policyFile, f.input.policyBytes); fs.writeFileSync(acceptanceFile, f.input.acceptanceBytes);
  fs.writeFileSync(inputFile, JSON.stringify({ current: f.input.current, policyFile, acceptanceFile,
    policySha256: f.input.policySha256, acceptanceSha256: f.input.acceptanceSha256 }));
  const program = `import fs from 'node:fs';import http from 'node:http';import https from 'node:https';
const read=fs.readFileSync;fs.readFileSync=function(p,...args){if(/(?:^|[\\\\/])\\.env(?:[.\\\\/]|$)/.test(String(p)))throw Error('CREDENTIAL_READ');return read.call(this,p,...args)};
fs.writeFileSync=fs.appendFileSync=fs.mkdirSync=()=>{throw Error('WRITE_FORBIDDEN')};
globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};http.request=https.request=http.get=https.get=()=>{throw Error('NETWORK_FORBIDDEN')};
process.argv=[process.execPath,${JSON.stringify(script)},'--assemble',${JSON.stringify(inputFile)}];await import(${JSON.stringify(new URL('../scripts/prepare-mini-multieffect-merchant-candidate.mjs', import.meta.url).href)});`;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8' });
  const record = JSON.parse(stdout);
  assert.equal(record.dryRun, true); assert.equal(record.networkCalls, 0); assert.equal(record.privateVariablesPersisted, false);
  assert.deepEqual(record.effectIds, ['natural-avatar', 'modern-comic', 'gentle-watercolor']);
  assert.doesNotMatch(stdout, /synthetic-secret|Signature|private\.invalid|usr_|synthetic-product|111111111111111111/);
});
