import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runPhotoGenerationProbe, generationProbeInput, generationProbeSpec, generationProbeModels, validateGenerationProbePredecessors } from '../scripts/probe-photo-generation-synthetic.mjs';
import { createQwenPhotoProvider, QWEN_PHOTO_MODEL, QWEN_PHOTO_RESULT_HOSTS } from '../photo-jobs/qwen-provider.js';
import { createPhotoImageMarker } from '../photo-jobs/image-marker.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const source = generationProbeInput();
const media = bytes => ({ bytes, sha256: hash(bytes), byteLength: bytes.length, contentType: 'image/png' });
function fixture(probeVersion = 'synthetic-generation-v4') {
  const events = [], counts = { green: 0, generation: 0, put: 0, delete: 0, preview: 0 }, objects = new Map();
  const ports = {
    probeVersion,
    journal: async value => { events.push(structuredClone(value)); return true; },
    provider: createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: async request => {
      if (request.method === 'GET') return { status: 200, contentType: 'image/png', bytes: source };
      counts.generation++; assert.equal(events.at(-1).phase, 'generation_attempt_intent');
      assert.equal(JSON.parse(request.body).model, 'qwen-image-2.0-2026-03-03');
      assert.deepEqual(JSON.parse(request.body).parameters, { n: 1, watermark: true, prompt_extend: false, size: '1024*1024', negative_prompt: generationProbeSpec.effectParameters.negativePrompt, seed: 42 });
      return { status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ request_id: 'fixture_request',
        output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: `https://${QWEN_PHOTO_RESULT_HOSTS[0]}/fixture.png?Signature=REDACTED_SECRET }] } }] },
        usage: { image_count: 1, width: 1024, height: 1024 } })) };
    } }),
    marker: createPhotoImageMarker({ serviceProviderCode: 'synthetic-probe', labelVersion: probeVersion }),
    moderator: { async moderate({ bytes, direction, journal }) {
      counts.green++; const reference = counts.green.toString(16).padStart(32, '0');
      await journal({ reference, extension: 'png' });
      if (direction === 'output') assert.notEqual(hash(bytes), hash(source));
      return { provider: 'aliyun-green', policyVersion: probeVersion, service: direction === 'input' ? 'baselineCheck' : 'aigcCheck',
        direction, ...media(bytes), decision: 'allow', cleanupPending: false, cleanupReference: reference };
    } },
    outputStorage: {
      async inspect(key) { return { found: objects.has(key) }; },
      async put(key, bytes) { assert.equal(events.at(-1).phase, 'output_put_intent'); counts.put++; objects.set(key, Buffer.from(bytes)); return {}; },
      async read(key) { return { found: true, ...media(objects.get(key)) }; },
      async delete(key) { assert.equal(events.at(-1).phase, 'output_delete_intent'); counts.delete++; objects.delete(key); return { acknowledged: true, absentObserved: true, versionMarkerObserved: false }; },
    },
    scratchInspector: async () => ({ found: false }),
    savePreview: async bytes => { counts.preview++; assert.notEqual(hash(bytes), hash(source)); },
  };
  return { ports, events, counts, objects };
}

test('default CLI neither loads credentials nor sends a request', () => {
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/probe-photo-generation-synthetic.mjs', import.meta.url))], { encoding: 'utf8' }));
  assert.equal(result.executed, false); assert.equal(result.maximumGenerationCalls, 1); assert.equal(result.maximumGreenCalls, 2);
  assert.equal(result.model, QWEN_PHOTO_MODEL);
});
test('actual Qwen adapter and Pillow marker compose into one bounded probe and sanitized report', async () => {
  const f = fixture(); const result = await runPhotoGenerationProbe(f.ports);
  assert.equal(result.passed, true); assert.equal(result.productionApproved, false); assert.equal(result.deployed, false);
  assert.equal(result.scratchAbsentObserved, 2); assert.deepEqual(f.counts, { green: 2, generation: 1, put: 1, delete: 1, preview: 1 });
  assert.equal(f.objects.size, 0); assert.doesNotMatch(JSON.stringify(result), /Signature|fixture_request|private\/|https:|bytes/);
});
test('the separately scoped model probe uses v4 and cannot replay historical model runs', async () => {
  const f = fixture('synthetic-generation-v4');
  const result = await runPhotoGenerationProbe(f.ports);
  assert.equal(result.passed, true); assert.equal(f.counts.generation, 1); assert.equal(f.counts.green, 2);
  assert.equal(result.probeVersion, 'synthetic-generation-v4');
  assert.equal(result.model, 'qwen-image-2.0-2026-03-03');
  for (const v of ['synthetic-generation-v1', 'synthetic-generation-v2', 'synthetic-generation-v3']) {
    assert.equal(generationProbeModels[v], 'qwen-image-edit-plus-2025-12-15');
    const retired = fixture(v);
    await assert.rejects(runPhotoGenerationProbe(retired.ports), /PROBE_VERSION_RETIRED/);
    assert.equal(retired.events.length, 0); assert.equal(retired.counts.generation, 0);
  }
  for (const flag of ['--execute', '--execute-v2', '--execute-workspace-v3']) {
    const retired = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/probe-photo-generation-synthetic.mjs', import.meta.url)), flag], { encoding: 'utf8' }));
    assert.equal(retired.executed, false); assert.equal(retired.reason, 'RETIRED_PROBE_NOT_EXECUTABLE');
  }
  const unsupported = fixture('synthetic-generation-v5');
  await assert.rejects(runPhotoGenerationProbe(unsupported.ports), /PROBE_VERSION_INVALID/);
  assert.equal(unsupported.events.length, 0); assert.equal(unsupported.counts.generation, 0);
});

test('prepared model probe binds all three historical models and rejects incomplete or uncertain cleanup', () => {
  const history = version => [{ phase: 'probe_started' }, { phase: 'generation_attempt_intent', model: generationProbeModels[version] },
    { phase: 'probe_finished', report: { probeVersion: version, model: generationProbeModels[version], attemptedGenerationCalls: 1, passed: false, cleanupPending: false } }];
  const valid = Object.fromEntries(['synthetic-generation-v1', 'synthetic-generation-v2', 'synthetic-generation-v3'].map(v => [v, history(v)]));
  assert.equal(validateGenerationProbePredecessors('synthetic-generation-v4', valid), true);
  const legacy = structuredClone(valid); delete legacy['synthetic-generation-v1'].at(-1).report.probeVersion;
  delete legacy['synthetic-generation-v1'].at(-1).report.model;
  assert.equal(validateGenerationProbePredecessors('synthetic-generation-v4', legacy), true);
  for (const mutate of [h => delete h['synthetic-generation-v1'], h => h['synthetic-generation-v2'].pop(),
    h => { h['synthetic-generation-v2'].at(-1).report.cleanupPending = true; },
    h => { h['synthetic-generation-v1'].at(-1).report.passed = true; },
    h => { delete h['synthetic-generation-v2'].at(-1).report.probeVersion; },
    h => h['synthetic-generation-v2'].unshift({ phase: 'generation_attempt_intent' }),
    h => { h['synthetic-generation-v3'][1].model = 'qwen-image-2.0-2026-03-03'; },
    h => { h['synthetic-generation-v3'].at(-1).report.model = 'qwen-image-2.0-2026-03-03'; },
    h => { delete h['synthetic-generation-v3'].at(-1).report.model; },
    h => { h['synthetic-generation-v2'].at(-1).report.probeVersion = 'synthetic-generation-v1'; }]) {
    const damaged = structuredClone(valid); mutate(damaged);
    assert.throws(() => validateGenerationProbePredecessors('synthetic-generation-v4', damaged), /PROBE_PRIOR_EVIDENCE_REQUIRED/);
  }
  assert.throws(() => validateGenerationProbePredecessors('synthetic-generation-v5', valid), /PROBE_VERSION_INVALID/);
});
test('an unconfirmed input review never generates, retries or claims cleanup complete on a single absent observation', async () => {
  const f = fixture(); f.ports.moderator.moderate = async ({ journal }) => {
    f.counts.green++; await journal({ reference: 'a'.repeat(32), extension: 'png' }); return { decision: 'unconfirmed', cleanupPending: true };
  };
  const result = await runPhotoGenerationProbe(f.ports);
  assert.equal(result.passed, false); assert.equal(result.cleanupPending, true); assert.equal(result.scratchAbsentObserved, 1);
  assert.equal(f.counts.generation, 0); assert.equal(f.counts.green, 1);
});
test('a lost generation response stops after the sole intended request', async () => {
  const f = fixture(); f.ports.provider.generate = async () => { f.counts.generation++; throw new Error('secret upstream response'); };
  const result = await runPhotoGenerationProbe(f.ports);
  assert.equal(result.failureStage, 'generation'); assert.equal(f.counts.generation, 1); assert.equal(f.counts.green, 1);
  assert.equal(result.passed, false); assert.doesNotMatch(JSON.stringify(result), /secret/);
});
test('a rejected provider response records only a bounded diagnostic without changing retry policy', async () => {
  const f = fixture();
  f.ports.provider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: async () => {
    f.counts.generation++;
    return { status: 401, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({
      code: 'InvalidApiKey', request_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      message: 'secret body https://private.invalid/?Signature=REDACTED_SECRET
    })) };
  } });
  const result = await runPhotoGenerationProbe(f.ports);
  assert.equal(result.passed, false); assert.equal(f.counts.generation, 1); assert.equal(f.counts.green, 1);
  assert.equal(result.diagnostic?.httpStatus, 401); assert.equal(result.diagnostic?.outcome, 'unknown');
  assert.equal(result.diagnostic?.retryAllowed, false);
  assert.deepEqual(f.events.at(-1).report.diagnostic, result.diagnostic);
  assert.doesNotMatch(JSON.stringify(result), /secret|Signature|private.invalid|synthetic-key/);
});
test('a failed journal prevents the billable generation call', async () => {
  const f = fixture(); f.ports.journal = async entry => entry.phase !== 'generation_attempt_intent';
  const result = await runPhotoGenerationProbe(f.ports);
  assert.equal(result.passed, false); assert.equal(f.counts.generation, 0);
});
test('an output PUT response loss does not repeat PUT and keeps late-write cleanup responsibility', async () => {
  const f = fixture(); f.ports.outputStorage.put = async () => { f.counts.put++; throw new Error('timeout'); };
  const result = await runPhotoGenerationProbe(f.ports);
  assert.equal(result.passed, false); assert.equal(result.outputAbsentObserved, true); assert.equal(result.cleanupPending, true);
  assert.equal(f.counts.put, 1); assert.equal(f.counts.delete, 1); assert.equal(f.counts.green, 1);
});
test('changed output bytes and delete uncertainty never produce a passing probe or a preview', async () => {
  const f = fixture(); f.ports.outputStorage.read = async () => ({ found: true, ...media(source) });
  f.ports.outputStorage.delete = async () => ({ acknowledged: false, absentObserved: false });
  const result = await runPhotoGenerationProbe(f.ports);
  assert.equal(result.passed, false); assert.equal(result.cleanupPending, true); assert.equal(f.counts.preview, 0); assert.equal(f.counts.green, 1);
});
