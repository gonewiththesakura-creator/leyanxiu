// SYNTHETIC test-only observations and reviews. Never deploy these fixtures.
import { photoAcceptanceDigest } from '../photo-jobs/generation-acceptance.js';
import { getOriginalEffectProfile, originalEffectBinding, originalEffectIds, originalEffectsProbeVersion } from '../photo-jobs/original-effect-batch.js';
import { QWEN_PHOTO_RESULT_POLICY } from '../photo-jobs/qwen-provider.js';

export const fixtureEffects = () => originalEffectIds.map(id => {
  const p = getOriginalEffectProfile(id);
  return { id, version: p.effectVersion, provider: p.spec.provider, model: p.spec.model, purpose: p.purpose,
    parameters: structuredClone(p.spec.effectParameters), enabled: true, approved: true,
    reviewReference: 'synthetic-fixture-review', title: '仅隔离测试' };
});
export const fixtureReview = report => ({ mode: 'agent-visual', reviewedBy: 'synthetic-test-fixture',
  reviewedAt: '2026-10-15T10:00:00Z', decision: 'accepted', reference: 'synthetic-sample-only',
  scope: 'Synthetic contract test only; no real visual acceptance.', reportSha256: photoAcceptanceDigest(report),
  inputSha256: report.acceptanceBinding.normalizedSha256, outputSha256: report.outputSha256 || 'b'.repeat(64) });
export const fixtureBundle = (effects = fixtureEffects()) => {
  const entries = effects.map(effect => {
    const profile = getOriginalEffectProfile(effect.id);
    const report = { effectId: effect.id, effectVersion: effect.version, probeVersion: profile.probeVersion,
      provider: profile.spec.provider, model: profile.spec.model, specSha256: profile.specSha256,
      acceptanceBinding: originalEffectBinding(effect.id), sourceParameters: structuredClone(profile.spec),
      outputSha256: 'a'.repeat(64), resultUrlPolicy: QWEN_PHOTO_RESULT_POLICY, labelVersion: profile.probeVersion,
      moderationVersion: profile.probeVersion, moderationServices: { input: 'baselineCheck', output: 'aigcCheck' },
      executed: true, syntheticOnly: true, deployed: false, productionApproved: false, passed: true,
      cleanupPending: false, attemptedGenerationCalls: 1, attemptedGreenCalls: 2, inputAllowed: true,
      outputAllowed: true, marked: true, outputReadMatches: true, outputAbsentObserved: true, scratchAbsentObserved: 2,
      previewSaved: true, permanentErasureConfirmed: false,
      qualityAccepted: false, qualityReview: { status: 'pending-manual-review', reviewer: null, notes: null } };
    return { effectId: effect.id, effectVersion: effect.version, report, qualityReview: fixtureReview(report) };
  });
  return { kind: 'photo-effect-acceptance-bundle', schemaVersion: 1, probeVersion: originalEffectsProbeVersion,
    pipelineReport: structuredClone(entries[0].report), effects: entries };
};
