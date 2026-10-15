import { createHash } from 'node:crypto';
import { QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_RESULT_POLICY } from './qwen-provider.js';

const fail = code => Object.assign(new Error(code), { code });
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const plain = value => Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 2000
  && !/[\u0000-\u001f\u007f]/.test(value);
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const photoAcceptanceDigest = value => hash(canonical(value));
export const photoEffectSpecSha256 = effect => hash(JSON.stringify({ provider: effect.provider, model: effect.model,
  effectParameters: Object.fromEntries(['prompt', 'negativePrompt', 'size', 'n', 'watermark', 'promptExtend', 'seed']
    .filter(key => Object.hasOwn(effect.parameters || {}, key)).map(key => [key, effect.parameters[key]])) }));
const batchVersion = 'original-effects-v1-20261015';
const legacyVersion = 'natural-avatar-v2-20261013';
// Immutable probe contracts. Changing an enabled parameter requires a new
// reviewed version; renaming policy fields cannot reuse a different sample.
const fixedHashes = Object.freeze({
  'natural-avatar': '5d4de1225b011792253dedda9730eda8fba9fc495e991dbd2f9c9119ad978bd9',
  'classic-black-white': '6479aced8b0cb00fa8cf5f7fe74a69b78dd92af211cc5dd028b85d42e9e5f668',
  'new-chinese': '1830a968b9ad1627a3a45e179ff21187e10e817371d429e275789b50459acec7',
  'modern-comic': 'd4137b2586c9ffb068984bea99573705965c6d3f73b235644345dba631fcafc5',
  'gentle-watercolor': '8ac645a27dd98e60299eec5321e61415b876f6ea341857b2efe83b07d5cf874d',
});

export function requiresPhotoAcceptanceBundle(effects) {
  return !Array.isArray(effects) || effects.length > 1 || effects.some(effect => effect?.id !== 'natural-avatar');
}

export function photoTechnicalReportAccepted(report, { provider, model, probeVersion,
  resultUrlPolicy = QWEN_PHOTO_RESULT_POLICY, labelVersion = probeVersion, moderationVersion = probeVersion,
  moderationService = 'aigcCheck' }) {
  return plain(report) && report.provider === provider && report.model === model && report.probeVersion === probeVersion
    && report.resultUrlPolicy === resultUrlPolicy && report.labelVersion === labelVersion
    && report.moderationVersion === moderationVersion && report.moderationServices?.input === 'baselineCheck'
    && report.moderationServices.output === moderationService && report.executed === true
    && report.syntheticOnly === true && report.passed === true && !report.failure
    && report.inputAllowed === true && report.outputAllowed === true && report.marked === true && report.outputReadMatches === true
    && report.outputAbsentObserved === true && report.scratchAbsentObserved === 2 && report.cleanupPending === false
    && report.attemptedGenerationCalls === 1 && report.attemptedGreenCalls === 2;
}

export function photoEffectReportBound(effect, report) {
  const binding = report?.acceptanceBinding;
  if (!plain(effect) || !plain(binding) || !Object.hasOwn(fixedHashes, effect.id)) return false;
  const legacy = effect.id === 'natural-avatar', version = legacy ? legacyVersion : `${effect.id}-v1-20261015`;
  const probeVersion = legacy ? legacyVersion : batchVersion;
  if (effect.version !== version || effect.provider !== QWEN_PHOTO_PROVIDER || effect.model !== QWEN_PHOTO_MODEL
    || effect.purpose !== `photo-effect:${effect.id}` || effect.enabled !== true || effect.approved !== true
    || binding.effectId !== effect.id || binding.effectVersion !== effect.version
    || binding.specSha256 !== fixedHashes[effect.id] || !plain(effect.parameters)
    || Object.keys(effect.parameters).some(key => !['prompt', 'negativePrompt', 'size', 'n', 'watermark', 'promptExtend', 'seed'].includes(key))
    || photoEffectSpecSha256(effect) !== binding.specSha256
    || !photoTechnicalReportAccepted(report, { provider: effect.provider, model: effect.model, probeVersion })
    || report.deployed !== false || report.productionApproved !== false || report.permanentErasureConfirmed !== false
    || report.previewSaved !== true || !hex(binding.normalizedSha256) || !hex(binding.rawSha256)) return false;
  if (!legacy && (report.effectId !== effect.id || report.effectVersion !== effect.version
    || binding.probeVersion !== probeVersion || report.specSha256 !== binding.specSha256
    || !plain(report.sourceParameters) || hash(JSON.stringify(report.sourceParameters)) !== binding.specSha256
    || canonical(report.sourceParameters) !== canonical({ provider: effect.provider, model: effect.model, effectParameters: effect.parameters })
    || !hex(report.outputSha256))) return false;
  if (legacy && ((report.effectId !== undefined && report.effectId !== effect.id)
    || (report.effectVersion !== undefined && report.effectVersion !== version)
    || (report.specSha256 !== undefined && report.specSha256 !== binding.specSha256)
    || (binding.probeVersion !== undefined && binding.probeVersion !== probeVersion)
    || (report.sourceParameters !== undefined && canonical(report.sourceParameters)
      !== canonical({ provider: effect.provider, model: effect.model, effectParameters: effect.parameters })))) return false;
  return true;
}

function validReview(review, report) {
  // Visual review is a separate host-owned attestation. Keep the original
  // technical report unchanged, including its qualityAccepted:false field.
  return plain(review) && ['human', 'agent-visual'].includes(review.mode) && review.decision === 'accepted'
    && text(review.reviewedBy) && text(review.reference) && text(review.scope)
    && typeof review.reviewedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(review.reviewedAt)
    && Number.isFinite(Date.parse(review.reviewedAt)) && review.reportSha256 === photoAcceptanceDigest(report)
    && review.inputSha256 === report.acceptanceBinding.normalizedSha256 && hex(review.outputSha256)
    // Historical natural-avatar evidence has no output digest. The human
    // record must identify its retained preview through reference and digest.
    && (report.outputSha256 === undefined ? report.acceptanceBinding.effectVersion === legacyVersion
      : review.outputSha256 === report.outputSha256);
}

/** Validate pinned host-owned evidence only; this does not authenticate a
 * human, create evidence, or promote pending technical reports. The host's
 * reviewed config and pinned bundle are the trust boundary, never HTTP input.
 */
export function validatePhotoAcceptanceBundle(bundle, { effects, provider, model, pipelineVersion,
  labelVersion = pipelineVersion, moderationVersion = pipelineVersion, resultUrlPolicy = QWEN_PHOTO_RESULT_POLICY,
  moderationService = 'aigcCheck' } = {}) {
  if (!plain(bundle) || bundle.kind !== 'photo-effect-acceptance-bundle' || bundle.schemaVersion !== 1
    || bundle.probeVersion !== batchVersion || !Array.isArray(bundle.effects)
    || !Array.isArray(effects) || !effects.length || effects.length > 5
    || provider !== QWEN_PHOTO_PROVIDER || model !== QWEN_PHOTO_MODEL) throw fail('PHOTO_GENERATION_ACCEPTANCE_BUNDLE_REQUIRED');
  if (pipelineVersion !== batchVersion || labelVersion !== batchVersion || moderationVersion !== batchVersion) {
    throw fail('PHOTO_GENERATION_ACCEPTANCE_PIPELINE_INVALID');
  }
  if (effects.some(effect => effect?.enabled !== true) || new Set(effects.map(effect => effect?.id)).size !== effects.length
    || bundle.effects.length !== effects.length) throw fail('PHOTO_GENERATION_ACCEPTANCE_BUNDLE_EFFECTS_REQUIRED');
  const ids = new Set();
  for (const entry of bundle.effects) {
    const effect = effects.find(effect => effect.id === entry?.effectId);
    if (!plain(entry) || !effect || ids.has(entry.effectId) || entry.effectVersion !== effect.version) {
      throw fail('PHOTO_GENERATION_ACCEPTANCE_BUNDLE_EFFECT_MISMATCH');
    }
    if (!photoEffectReportBound(effect, entry.report) || !validReview(entry.qualityReview, entry.report)) {
      throw fail('PHOTO_GENERATION_ACCEPTANCE_BUNDLE_REPORT_INVALID');
    }
    ids.add(entry.effectId);
  }
  if (!photoTechnicalReportAccepted(bundle.pipelineReport, { provider, model, probeVersion: pipelineVersion,
    labelVersion, moderationVersion, resultUrlPolicy, moderationService })
    || !bundle.effects.some(entry => photoAcceptanceDigest(entry.report) === photoAcceptanceDigest(bundle.pipelineReport))) {
    throw fail('PHOTO_GENERATION_ACCEPTANCE_PIPELINE_INVALID');
  }
  // Keep the original schema: readiness validates it again on every use.
  return structuredClone(bundle);
}

export function photoSpecMatchesApprovedEffects(spec, effects) {
  if (!plain(spec) || !Array.isArray(effects) || !plain(spec.effectParameters)
    || !['inputAssetId', 'billingRef', 'effectId', 'effectVersion', 'purpose', 'provider', 'model']
      .every(key => typeof spec[key] === 'string' && spec[key].length > 0)
    || Object.keys(spec).some(key => !['inputAssetId', 'billingRef', 'effectId', 'effectVersion', 'purpose', 'provider', 'model', 'effectParameters'].includes(key))) return false;
  const effect = effects.find(effect => effect?.id === spec.effectId && effect.version === spec.effectVersion);
  return Boolean(effect) && effect.enabled === true && effect.approved === true
    && spec.provider === effect.provider && spec.model === effect.model && spec.purpose === effect.purpose
    && canonical(spec.effectParameters) === canonical(effect.parameters);
}
