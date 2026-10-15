import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { validatePhotoAcceptanceBundle } from '../photo-jobs/generation-acceptance.js';
import { QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_RESULT_POLICY } from '../photo-jobs/qwen-provider.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const fail = suffix => { throw Object.assign(new Error(`MULTIEFFECT_CANDIDATE_${suffix}`), { code: `MULTIEFFECT_CANDIDATE_${suffix}` }); };
const plain = value => Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const userAllowlist = value => typeof value === 'string' && value.split(',').length <= 20
  && value.split(',').every(id => /^usr_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id.trim()))
  && new Set(value.split(',').map(id => id.trim())).size === value.split(',').length;
const changedKeys = Object.freeze(['PHOTO_PRODUCTION_CONFIG_BASE64', 'PHOTO_PRODUCTION_CONFIG_SHA256',
  'PHOTO_PRODUCTION_ACCEPTANCE_BASE64', 'PHOTO_PRODUCTION_ACCEPTANCE_SHA256', 'XPAY_PURPOSE_RULES_JSON']);
const knownResults = new WeakSet();
export const multiEffectCandidatePlan = Object.freeze({
  kind: 'local-merchant-test-multieffect-candidate-plan', dryRun: true,
  currentVersionRequired: 'buildtest-016', readsEnvironmentFiles: false, writesPrivateVariables: false,
  networkCalls: 0, cloudOperationPerformed: false, deployed: false, acceptedEffectsPreselected: false,
  requiredInputs: ['explicit current 016 variables', 'pinned approved policy bytes', 'pinned per-effect acceptance bundle bytes'],
  allowedVariableChanges: changedKeys,
});

function objectWithKeys(value, allowed, code) {
  if (!plain(value) || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.includes(key)
    || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
    || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) fail(code);
}
function parsePinned(bytes, expected, code) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 2 || bytes.length > 65536 || !hashValue(expected) || sha(bytes) !== expected
    || bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) fail(code);
  try { const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!plain(value)) fail(code); return value; } catch { fail(code); }
}
function decodePinned(env, prefix) {
  const encoded = env[`${prefix}_BASE64`];
  if (typeof encoded !== 'string' || encoded.length > 4 * Math.ceil(65536 / 3)) fail('CURRENT_PIN_INVALID');
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) fail('CURRENT_PIN_INVALID');
  return parsePinned(bytes, env[`${prefix}_SHA256`], 'CURRENT_PIN_INVALID');
}
function currentVariables(current) {
  objectWithKeys(current, ['version', 'variables'], 'CURRENT_REQUIRED');
  if (current.version !== 'buildtest-016' || !plain(current.variables)) fail('CURRENT_016_REQUIRED');
  const variables = {};
  for (const key of Reflect.ownKeys(current.variables)) {
    const descriptor = Object.getOwnPropertyDescriptor(current.variables, key);
    if (typeof key !== 'string' || !/^[A-Z][A-Z0-9_]{0,100}$/.test(key) || !descriptor?.enumerable
      || !Object.hasOwn(descriptor, 'value') || typeof descriptor.value !== 'string') fail('CURRENT_VARIABLES_INVALID');
    variables[key] = descriptor.value;
  }
  if (variables.XPAY_ENV !== '0' || variables.XPAY_MODE !== 'merchant_test'
    || variables.AUTH_MODE !== 'wechat' || variables.DEPLOY_ENV !== 'production'
    || variables.NODE_ENV !== 'production' || variables.RELEASE_CHANNEL !== 'wechat-mini-program'
    || variables.XPAY_DB_BACKEND !== 'mysql' || variables.XPAY_ENABLED !== 'true'
    || variables.XPAY_RECONCILE_ENABLED !== 'true'
    || !userAllowlist(variables.XPAY_TEST_USER_IDS) || !userAllowlist(variables.XPAY_REFUND_OPERATOR_USER_IDS)
    || !/^[a-f0-9]{64}$/i.test(variables.XPAY_SESSION_ENCRYPTION_KEY || '')
    || ['DEBUG', 'NODE_DEBUG', 'NODE_DEBUG_NATIVE'].some(key => variables[key])) fail('CURRENT_SCOPE_INVALID');
  decodePinned(variables, 'PHOTO_PRODUCTION_ACCEPTANCE');
  return variables;
}

function validatePolicy(policy, currentPolicy, env) {
  objectWithKeys(policy, ['version', 'policy', 'approvedEffects', 'moderationPolicy', 'cleanupPolicy'], 'POLICY_INVALID');
  if (policy.version !== 1 || !plain(policy.policy) || policy.policy.approved !== true
    || policy.policy.serviceProviderCode !== env.WECHAT_APP_ID || policy.policy.provider !== QWEN_PHOTO_PROVIDER
    || policy.policy.model !== QWEN_PHOTO_MODEL || policy.policy.resultUrlPolicy !== QWEN_PHOTO_RESULT_POLICY
    || policy.policy.operation !== 'edit' || policy.policy.moderationService !== 'aigcCheck'
    || policy.policy.acceptanceVersion !== 'original-effects-v1-20261015'
    || policy.policy.labelVersion !== policy.policy.acceptanceVersion
    || policy.policy.moderationVersion !== policy.policy.acceptanceVersion
    || !Array.isArray(policy.approvedEffects) || !policy.approvedEffects.length || policy.approvedEffects.length > 5
    || !plain(policy.moderationPolicy) || policy.moderationPolicy.approved !== true
    || policy.moderationPolicy.version !== policy.policy.moderationVersion
    || policy.moderationPolicy.services?.input !== 'baselineCheck'
    || policy.moderationPolicy.services?.output !== 'aigcCheck') fail('POLICY_INVALID');
  const fixedPolicy = p => Object.fromEntries(Object.entries(p || {}).filter(([key]) =>
    !['reviewReference', 'acceptanceVersion', 'labelVersion', 'moderationVersion'].includes(key)));
  const fixedModeration = p => Object.fromEntries(Object.entries(p || {}).filter(([key]) => key !== 'version'));
  if (!isDeepStrictEqual(fixedPolicy(policy.policy), fixedPolicy(currentPolicy.policy))
    || !isDeepStrictEqual(fixedModeration(policy.moderationPolicy), fixedModeration(currentPolicy.moderationPolicy))
    || !isDeepStrictEqual(policy.cleanupPolicy, currentPolicy.cleanupPolicy)) fail('POLICY_UNRELATED_CHANGE');
  const legacy = currentPolicy.approvedEffects?.find(effect => effect?.id === 'natural-avatar');
  const retained = policy.approvedEffects.find(effect => effect?.id === 'natural-avatar');
  if (!legacy || !retained || !isDeepStrictEqual(legacy, retained)) fail('CURRENT_AVATAR_CHANGED');
}

/** Pure, explicit-input assembly from the current 016 merchant scope. No env,
 * filesystem, database, provider, deployment or build access occurs here.
 * Acceptance attests only the provided fixed samples; it is never fabricated.
 * Secrets and inherited scope remain in the returned variables in memory only.
 */
export function assembleMiniMultiEffectMerchantCandidate(input) {
  objectWithKeys(input, ['current', 'policyBytes', 'policySha256', 'acceptanceBytes', 'acceptanceSha256'], 'INPUT_INVALID');
  const inherited = currentVariables(input.current);
  const priorPolicy = decodePinned(inherited, 'PHOTO_PRODUCTION_CONFIG');
  const policy = parsePinned(input.policyBytes, input.policySha256, 'POLICY_PIN_INVALID');
  const acceptance = parsePinned(input.acceptanceBytes, input.acceptanceSha256, 'ACCEPTANCE_PIN_INVALID');
  validatePolicy(policy, priorPolicy, inherited);
  const p = policy.policy;
  try { validatePhotoAcceptanceBundle(acceptance, { effects: policy.approvedEffects, provider: p.provider, model: p.model,
    pipelineVersion: p.acceptanceVersion, labelVersion: p.labelVersion, moderationVersion: p.moderationVersion,
    resultUrlPolicy: p.resultUrlPolicy, moderationService: p.moderationService }); }
  catch { fail('ACCEPTANCE_INVALID'); }
  let priorPurposes;
  try { priorPurposes = JSON.parse(inherited.XPAY_PURPOSE_RULES_JSON); } catch { fail('CURRENT_PURPOSES_INVALID'); }
  if (!plain(priorPurposes)) fail('CURRENT_PURPOSES_INVALID');
  const purposes = Object.fromEntries(Object.entries(priorPurposes).filter(([purpose]) => !purpose.startsWith('photo-effect:')));
  for (const effect of policy.approvedEffects) {
    const existing = priorPurposes[effect.purpose];
    if (existing !== undefined && (!plain(existing) || existing.kind !== 'photo' || existing.reviewed !== true)) fail('CURRENT_PURPOSES_INVALID');
    purposes[effect.purpose] = existing === undefined ? { kind: 'photo', reviewed: true } : structuredClone(existing);
  }
  const variables = { ...inherited,
    PHOTO_PRODUCTION_CONFIG_BASE64: input.policyBytes.toString('base64'), PHOTO_PRODUCTION_CONFIG_SHA256: input.policySha256,
    PHOTO_PRODUCTION_ACCEPTANCE_BASE64: input.acceptanceBytes.toString('base64'), PHOTO_PRODUCTION_ACCEPTANCE_SHA256: input.acceptanceSha256,
    XPAY_PURPOSE_RULES_JSON: JSON.stringify(purposes) };
  if (Object.keys(inherited).some(key => !changedKeys.includes(key) && variables[key] !== inherited[key])
    || Object.keys(variables).some(key => !Object.hasOwn(inherited, key) && !changedKeys.includes(key))) fail('UNRELATED_VARIABLE_CHANGE');
  const result = Object.freeze({ variables: Object.freeze(variables), summary: Object.freeze({
    kind: 'local-merchant-test-multieffect-candidate', schemaVersion: 1, dryRun: true,
    currentVersion: input.current.version, currentScopeReused: true, liveSourceVerified: false,
    env: 0, mode: 'merchant_test', policySha256: input.policySha256, acceptanceSha256: input.acceptanceSha256,
    effectIds: Object.freeze(policy.approvedEffects.map(effect => effect.id)),
    photoPurposeIds: Object.freeze(policy.approvedEffects.map(effect => effect.purpose)),
    retainedNonPhotoPurposeCount: Object.keys(purposes).length - policy.approvedEffects.length,
    retainedMerchantAllowlists: true, retainedSessionKey: true,
    retainedPrivateVariables: true, allowedVariableChanges: changedKeys,
    networkCalls: 0, cloudOperationPerformed: false, deployed: false, privateVariablesPersisted: false,
    runtimeReadinessVerified: false, realDeliveryVerified: false,
  }) });
  knownResults.add(result); return result;
}

export function multiEffectMerchantCandidateRecord(result) {
  if (!knownResults.has(result)) fail('RESULT_INVALID');
  return structuredClone(result.summary);
}

function localDocument(filename) {
  if (typeof filename !== 'string' || !path.isAbsolute(filename)
    || filename.split(/[\\/]/).some(part => /^\.env(?:\.|$)/i.test(part))) fail('EXPLICIT_NON_ENV_FILE_REQUIRED');
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > 1024 * 1024) fail('LOCAL_FILE_INVALID');
  return fs.readFileSync(filename);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (!args.length || (args.length === 1 && args[0] === '--plan')) console.log(JSON.stringify(multiEffectCandidatePlan));
    else if (args.length === 2 && args[0] === '--assemble') {
      const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(localDocument(args[1])));
      objectWithKeys(document, ['current', 'policyFile', 'policySha256', 'acceptanceFile', 'acceptanceSha256'], 'INPUT_INVALID');
      const result = assembleMiniMultiEffectMerchantCandidate({ current: document.current,
        policyBytes: localDocument(document.policyFile), policySha256: document.policySha256,
        acceptanceBytes: localDocument(document.acceptanceFile), acceptanceSha256: document.acceptanceSha256 });
      console.log(JSON.stringify(multiEffectMerchantCandidateRecord(result)));
    } else fail('ARGUMENT_INVALID');
  } catch (error) {
    console.error(/^MULTIEFFECT_CANDIDATE_[A-Z_]+$/.test(error?.code || '') ? error.code : 'MULTIEFFECT_CANDIDATE_UNCONFIRMED');
    process.exitCode = 1;
  }
}
