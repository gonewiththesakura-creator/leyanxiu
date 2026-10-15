import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { avatarProbeIdentity, avatarProbeSpec, avatarProbeVersion, avatarProbeV2Version, avatarProbePlan, prepareAvatarProbe, prepareFixedAvatarProbe,
  runPreparedAvatarProbe, validateAvatarCandidate, singleUseGreenTransport, avatarOssOptions } from '../scripts/probe-photo-avatar-natural.mjs';
import { generationProbeInput } from '../scripts/probe-photo-generation-synthetic.mjs';
import { createQwenPhotoProvider, QWEN_PHOTO_RESULT_HOSTS } from '../photo-jobs/qwen-provider.js';
import { createPhotoImageMarker } from '../photo-jobs/image-marker.js';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const prepared = await prepareFixedAvatarProbe();
const candidate = JSON.parse(fs.readFileSync(new URL('../docs/production-config/first-service-candidate-2026-10-12.json', import.meta.url)));
const raw = fs.readFileSync('D:/JT/乐颜秀/workspace/output/imagegen/fictional-adult-avatar-20261012.jpg');
const generated = generationProbeInput();
const media = bytes => ({ bytes, sha256: sha(bytes), byteLength: bytes.length, contentType: 'image/png' });
function fixture(value = prepared) {
  const spec = value.spec, version = value.binding.effectVersion;
  const counts = { generation: 0, green: 0, put: 0, delete: 0, preview: 0 }, events = [], objects = new Map(), scratch = [];
  const ports = {
    provider: createQwenPhotoProvider({ apiKey: 'synthetic-key', transport: async request => {
      if (request.method === 'GET') return { status: 200, contentType: 'image/png', bytes: generated };
      counts.generation++;
      assert.equal(events.at(-1).phase, 'generation_attempt_intent');
      const body = JSON.parse(request.body);
      assert.equal(body.model, spec.model);
      assert.deepEqual(body.parameters, { n: 1, watermark: true, prompt_extend: false, size: '1024*1024', negative_prompt: spec.effectParameters.negativePrompt });
      assert.ok(body.input.messages[0].content[0].image.startsWith('data:image/jpeg;base64,'));
      assert.equal(sha(Buffer.from(body.input.messages[0].content[0].image.split(',')[1], 'base64')), avatarProbeIdentity.normalizedSha256);
      assert.equal(body.input.messages[0].content[1].text, spec.effectParameters.prompt);
      return { status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ request_id: 'fixture_request',
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: `https://${QWEN_PHOTO_RESULT_HOSTS[0]}/fixture.png` }] } }] },
        usage: { image_count: 1, width: 1024, height: 1024 } })) };
    } }),
    marker: createPhotoImageMarker({ serviceProviderCode: 'synthetic-only', labelVersion: version }),
    moderator: { async moderate({ bytes, contentType, direction, journal }) {
      counts.green++;
      const reference = counts.green.toString(16).padStart(32, '0'), extension = direction === 'input' ? 'jpg' : 'png';
      assert.equal(contentType, direction === 'input' ? 'image/jpeg' : 'image/png');
      await journal({ reference, extension });
      scratch.push(`private/photo-moderation/${reference}.${extension}`);
      return { provider: 'aliyun-green', policyVersion: version, direction,
        service: direction === 'input' ? 'baselineCheck' : 'aigcCheck', sha256: sha(bytes), byteLength: bytes.length,
        decision: 'allow', cleanupPending: false, cleanupReference: reference, cleanupExtension: extension };
    } },
    journal: async entry => { events.push(structuredClone(entry)); return true; },
    outputStorage: {
      inspect: async key => ({ found: objects.has(key) }),
      put: async (key, bytes) => { counts.put++; objects.set(key, bytes); return {}; },
      read: async key => ({ found: true, ...media(objects.get(key)) }),
      delete: async key => { counts.delete++; objects.delete(key); return { acknowledged: true, absentObserved: true, versionMarkerObserved: false }; },
    },
    scratchInspector: async key => { assert.ok(scratch.includes(key)); return { found: false }; },
    savePreview: async () => { counts.preview++; },
  };
  return { counts, events, objects, scratch, ports };
}

test('default CLI checks only local material with credentials and network explicitly trapped', () => {
  const script = fileURLToPath(new URL('../scripts/probe-photo-avatar-natural.mjs', import.meta.url));
  const source = `import fs from 'node:fs'; import http from 'node:http'; import https from 'node:https';
const read=fs.readFileSync; fs.readFileSync=function(p,...args){if(/(?:^|[\\\\/])\\.env(?:[.\\\\/]|$)/.test(String(p)))throw Error('CREDENTIAL_READ');return read.call(this,p,...args)};
globalThis.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};http.request=https.request=http.get=https.get=()=>{throw Error('NETWORK_FORBIDDEN')};
process.argv=[process.execPath,${JSON.stringify(script)},'--check'];await import(${JSON.stringify(new URL('../scripts/probe-photo-avatar-natural.mjs', import.meta.url).href)});`;
  const report = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8' }));
  assert.equal(report.executed, false); assert.equal(report.localChecksPassed, true);
  assert.equal(report.thisInvocationNetworkCalls, 0); assert.equal(report.grantsExecutionAuthority, false);
  assert.equal(report.authorizationSource, 'active-user-session');
  assert.equal(report.manualCropAndQualityReviewRequired, true);
});
test('fixed candidate and exact source hash reject model, prompt, seed, input and normalizer drift before any operation', async () => {
  for (const change of [c => { c.effect.model = 'qwen-image-2.0'; }, c => { c.effect.parameters.seed = 42; },
    c => { c.effect.parameters.prompt += ' changed'; }, c => { c.selectedAcceptanceInput.sha256 = '0'.repeat(64); }]) {
    const copy = structuredClone(candidate); change(copy); assert.throws(() => validateAvatarCandidate(copy));
  }
  let normalized = 0;
  const altered = Buffer.from(raw); altered[100] ^= 1;
  await assert.rejects(prepareAvatarProbe({ candidate, rawBytes: altered, normalizer: { normalize: async () => { normalized++; } } }), /AVATAR_IMAGE_MISMATCH/);
  assert.equal(normalized, 0);
  await assert.rejects(prepareAvatarProbe({ candidate, rawBytes: raw, normalizer: { normalize: async () => ({ ...prepared.source, contentType: 'image/png' }) } }), /AVATAR_IMAGE_MISMATCH/);
  const wrong = structuredClone(prepared); wrong.source.bytes = Buffer.from(prepared.source.bytes); wrong.spec.effectParameters.seed = 42;
  await assert.rejects(runPreparedAvatarProbe(wrong, {}), /AVATAR_PREPARED_BINDING_MISMATCH/);
});
test('one actual adapter flow carries JPEG and natural-avatar parameters, marks PNG and checks both exact scratch keys', async () => {
  const f = fixture(); const result = await runPreparedAvatarProbe(prepared, f.ports);
  assert.equal(result.passed, true); assert.equal(result.productionApproved, false);
  assert.deepEqual(f.counts, { generation: 1, green: 2, put: 1, delete: 1, preview: 1 });
  assert.ok(f.scratch[0].endsWith('.jpg')); assert.ok(f.scratch[1].endsWith('.png'));
  assert.equal(f.objects.size, 0); assert.equal(result.scratchAbsentObserved, 2);
  assert.doesNotMatch(JSON.stringify(result), /https:|Signature|synthetic-key|private\//);
});
test('wrong scratch suffix, foreign cleanup receipt and lost receipt cannot report cleanup success or call generation', async () => {
  for (const mode of ['suffix', 'reference', 'lost']) {
    const f = fixture(), original = f.ports.moderator.moderate;
    f.ports.moderator.moderate = async value => {
      if (mode === 'suffix') { f.counts.green++; await value.journal({ reference: 'a'.repeat(32), extension: 'png' }); }
      const receipt = await original(value);
      if (mode === 'lost') throw new Error('response lost');
      return { ...receipt, cleanupReference: 'b'.repeat(32) };
    };
    const result = await runPreparedAvatarProbe(prepared, f.ports);
    assert.equal(result.passed, false); assert.equal(result.cleanupPending, true);
    assert.equal(f.counts.generation, 0); assert.equal(f.counts.preview, 0);
  }
});
test('a rejected review or failed durable intent never creates a model request', async () => {
  for (const mode of ['review', 'journal']) {
    const f = fixture();
    if (mode === 'review') { const original = f.ports.moderator.moderate; f.ports.moderator.moderate = async value => ({ ...await original(value), decision: 'block' }); }
    else f.ports.journal = async entry => entry.phase !== 'generation_attempt_intent';
    const result = await runPreparedAvatarProbe(prepared, f.ports);
    assert.equal(result.passed, false); assert.equal(f.counts.generation, 0);
  }
});
test('lost model response has one attempt, no retry, no output and no raw diagnostic leak', async () => {
  const f = fixture(); f.ports.provider.generate = async () => { f.counts.generation++; throw Error('private upstream https://secret.invalid'); };
  const result = await runPreparedAvatarProbe(prepared, f.ports);
  assert.equal(result.failureStage, 'generation'); assert.equal(result.passed, false);
  assert.deepEqual(f.counts, { generation: 1, green: 1, put: 0, delete: 0, preview: 0 });
  assert.doesNotMatch(JSON.stringify(result), /secret.invalid|private upstream/);
});
test('single-use moderation transport counts uncertain attempts and disables OSS retries', async () => {
  let calls = 0; const transport = singleUseGreenTransport(async () => { calls++; throw Error('uncertain'); });
  await assert.rejects(transport({ service: 'baselineCheck' }), /uncertain/);
  await assert.rejects(transport({ service: 'baselineCheck' }), /AVATAR_CALL_LIMIT/);
  await assert.rejects(transport({ service: 'unapproved' }), /AVATAR_CALL_LIMIT/);
  assert.equal(calls, 1); assert.equal(avatarOssOptions({}).retryMax, 0); assert.equal(avatarOssOptions({}).secure, true);
});

test('v2 preserves input and model, binds its own limited prompt and never reuses the completed v1 evidence path', async () => {
  const v2 = await prepareFixedAvatarProbe(avatarProbeV2Version);
  assert.deepEqual(v2.source, prepared.source); assert.equal(v2.spec.model, avatarProbeSpec.model);
  assert.notEqual(v2.binding.specSha256, prepared.binding.specSha256);
  assert.equal(v2.binding.specSha256, '5d4de1225b011792253dedda9730eda8fba9fc495e991dbd2f9c9119ad978bd9');
  const plan = avatarProbePlan(v2), oldPlan = avatarProbePlan(prepared);
  assert.notEqual(plan.journal, oldPlan.journal); assert.notEqual(plan.preview, oldPlan.preview);
  assert.equal(plan.grantsExecutionAuthority, false); assert.equal(plan.executed, false);
  const f = fixture(v2); const result = await runPreparedAvatarProbe(v2, f.ports);
  assert.equal(result.passed, true); assert.equal(result.probeVersion, avatarProbeV2Version);
  assert.deepEqual(f.counts, { generation: 1, green: 2, put: 1, delete: 1, preview: 1 });
  const mismatched = { ...v2, binding: { ...v2.binding, effectVersion: avatarProbeVersion } };
  await assert.rejects(runPreparedAvatarProbe(mismatched, {}), /AVATAR_PREPARED_BINDING_MISMATCH/);
  await assert.rejects(prepareFixedAvatarProbe('unapproved-v3'), /AVATAR_VERSION_INVALID/);
});
