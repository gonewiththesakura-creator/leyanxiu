import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { originalEffectIds, originalEffectsProbeVersion, getOriginalEffectProfile } from '../photo-jobs/original-effect-batch.js';
import { generationProbeInput } from '../scripts/probe-photo-generation-synthetic.mjs';
import { prepareFixedOriginalEffectProbe, originalEffectProbePlan, runPreparedOriginalEffectProbe, validateOriginalEffectPredecessors } from '../scripts/probe-original-photo-effects.mjs';

const script = fileURLToPath(new URL('../scripts/probe-original-photo-effects.mjs', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const prepared = await prepareFixedOriginalEffectProbe(originalEffectIds[0]);
const generated = generationProbeInput();
const media = bytes => ({ bytes, byteLength: bytes.length, contentType: 'image/png', sha256: sha(bytes) });

test('default plan is local only, fixed order and four plus eight budget', () => {
  const report = JSON.parse(execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8' }));
  assert.equal(report.executed, false); assert.equal(report.probeVersion, originalEffectsProbeVersion);
  assert.deepEqual(report.fixedOrder, [...originalEffectIds]); assert.equal(report.maximumGenerationCalls, 4);
  assert.equal(report.maximumGreenCalls, 8); assert.equal(report.thisInvocationNetworkCalls, 0);
  assert.equal(report.stopOnFirstFailure, true);
  assert.ok(report.effects.every(effect => effect.qualityAccepted === false && effect.grantsExecutionAuthority === false));
});

test('missing local normalizer dependency fails execution before credentials, journal or network and emits only safe CLI output', () => {
  const program = `import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https';
let forbiddenCalls=0; const read=fs.readFileSync; fs.readFileSync=function(p,...args){if(/(?:^|[\\\\/])\\.env(?:[.\\\\/]|$)/.test(String(p))){forbiddenCalls++;throw Error('CREDENTIAL_READ_MUST_NOT_HAPPEN')};return read.call(this,p,...args)};
fs.mkdirSync=()=>{forbiddenCalls++;throw Error('JOURNAL_CLAIM_MUST_NOT_HAPPEN')};
globalThis.fetch=()=>{forbiddenCalls++;throw Error('NETWORK_MUST_NOT_HAPPEN')};http.request=https.request=http.get=https.get=()=>{forbiddenCalls++;throw Error('NETWORK_MUST_NOT_HAPPEN')};
process.env.PYTHON_PATH='missing-normalizer-executable-for-offline-adversarial-test';
process.argv=[process.execPath,${JSON.stringify(script)},'--execute-original-effects-v1','classic-black-white'];
await import(${JSON.stringify(new URL('../scripts/probe-original-photo-effects.mjs', import.meta.url).href)});
if(forbiddenCalls!==0)throw Error('FORBIDDEN_CALL_OBSERVED');`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', program], { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 1); assert.equal(result.stderr, '');
  const report = JSON.parse(result.stdout);
  assert.equal(report.qualityAccepted, false); assert.equal(report.effectId, 'classic-black-white');
  assert.equal(report.reason, 'STOP_AND_CHECK_PRIVATE_JOURNAL_DO_NOT_REPEAT');
  assert.doesNotMatch(result.stdout, /CREDENTIAL_READ|NETWORK_MUST|JOURNAL_CLAIM|https?:|Signature|secret|missing-normalizer/);
});

test('each profile is bound to original source prompt, model and independent spec hash', () => {
  const hashes = new Set();
  for (const id of originalEffectIds) {
    const profile = getOriginalEffectProfile(id); hashes.add(profile.specSha256);
    assert.equal(profile.effectVersion, `${id}-v1-20261015`);
    assert.equal(profile.spec.model, 'qwen-image-2.0-2026-03-03');
    assert.equal(profile.spec.effectParameters.prompt, getOriginalEffectProfile(id).spec.effectParameters.prompt);
  }
  assert.equal(hashes.size, 4);
});

function fixture(value = prepared) {
  const events = [], objects = new Map(), green = new Set();
  return { events, ports: {
    provider: { generate: async () => ({ url: 'https://dashscope-result.example/fixture.png' }), readGenerated: async () => media(generated) },
    marker: { mark: async input => ({ ...input, verified: true, conformanceVerified: false }) },
    moderator: { moderate: async ({ bytes, contentType, direction, journal }) => {
      const extension = contentType === 'image/jpeg' ? 'jpg' : 'png', reference = (green.size + 1).toString(16).padStart(32, '0');
      green.add(direction); await journal({ reference, extension });
      return { provider: 'aliyun-green', policyVersion: originalEffectsProbeVersion, direction,
        service: direction === 'input' ? 'baselineCheck' : 'aigcCheck', sha256: sha(bytes), byteLength: bytes.length,
        decision: 'allow', cleanupPending: false, cleanupReference: reference, cleanupExtension: extension };
    } },
    journal: async entry => { events.push(entry); return true; },
    outputStorage: { inspect: async key => ({ found: objects.has(key) }), put: async (key, bytes) => { objects.set(key, bytes); return {}; },
      read: async key => ({ found: true, ...media(objects.get(key)) }), delete: async key => { objects.delete(key); return { acknowledged: true, absentObserved: true, versionMarkerObserved: false }; } },
    scratchInspector: async () => ({ found: false }), savePreview: async () => {},
  } };
}

test('bounded adapter report binds effect and output hash while leaving quality pending', async () => {
  const f = fixture(); const report = await runPreparedOriginalEffectProbe(prepared, f.ports);
  assert.equal(report.passed, true); assert.equal(report.effectId, originalEffectIds[0]);
  assert.equal(report.effectVersion, 'classic-black-white-v1-20261015'); assert.match(report.outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(report.qualityAccepted, false); assert.equal(report.qualityReview.status, 'pending-visual-review');
  assert.equal(report.manualCropAndQualityReviewRequired, false);
  assert.equal(report.attemptedGenerationCalls, 1); assert.equal(report.attemptedGreenCalls, 2);
  assert.equal(report.cleanupPending, false); assert.doesNotMatch(JSON.stringify(report), /fixture\.png|fixture_request/);
  assert.doesNotMatch(JSON.stringify(f.events), /https:\/\/|fixture\.png/);
});

test('tampering source/spec or predecessor report stops before any paid call', async () => {
  const changed = { ...prepared, spec: structuredClone(prepared.spec) }; changed.spec.effectParameters.prompt += ' drift';
  await assert.rejects(runPreparedOriginalEffectProbe(changed, {}), /ORIGINAL_EFFECT_PREPARED_MISMATCH/);
  assert.throws(() => validateOriginalEffectPredecessors('new-chinese', { [originalEffectIds[0]]: [] }), /ORIGINAL_EFFECT_PREDECESSOR_UNCONFIRMED/);
  const plan = originalEffectProbePlan(prepared); assert.equal(plan.grantsExecutionAuthority, false);
  assert.equal(plan.paymentsAttempted, 0);
});

test('uncertain generation runs once, leaks no error and blocks later effects', async () => {
  const f = fixture(); let calls = 0;
  f.ports.provider.generate = async () => { calls++; throw Error('private https://secret.invalid/?Signature=REDACTED_SECRET };
  const report = await runPreparedOriginalEffectProbe(prepared, f.ports);
  assert.equal(calls, 1); assert.equal(report.attemptedGenerationCalls, 1); assert.equal(report.attemptedGreenCalls, 1);
  assert.equal(report.passed, false); assert.equal(report.outputSha256, null); assert.equal(report.failureStage, 'generation');
  assert.doesNotMatch(JSON.stringify(report), /secret|Signature|https:\/\//);
  assert.throws(() => validateOriginalEffectPredecessors('new-chinese', { 'classic-black-white': f.events }), /ORIGINAL_EFFECT_PREDECESSOR_UNCONFIRMED/);
});

test('successful exact predecessor is accepted while modified identity, model or binding fails', async () => {
  const f = fixture(); await runPreparedOriginalEffectProbe(prepared, f.ports);
  assert.equal(validateOriginalEffectPredecessors('new-chinese', { 'classic-black-white': f.events }), true);
  for (const change of [r => { r.effectId = 'other'; }, r => { r.model += '-latest'; },
    r => { r.acceptanceBinding.rawSha256 = '0'.repeat(64); }, r => { r.cleanupPending = true; },
    r => { r.attemptedGenerationCalls = 2; }, r => { r.qualityAccepted = true; }]) {
    const entries = structuredClone(f.events); change(entries.at(-1).report);
    assert.throws(() => validateOriginalEffectPredecessors('new-chinese', { 'classic-black-white': entries }), /ORIGINAL_EFFECT_PREDECESSOR_UNCONFIRMED/);
  }
});
