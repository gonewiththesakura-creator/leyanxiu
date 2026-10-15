import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { createPhotoImageModerator, createGreenImageTransport, createOssModerationStorage } from '../photo-jobs/moderation.js';

// Fixed synthetic PNG. No user media, cloud credentials, network or paid API.
const png = () => Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=', 'base64');
const approved = () => ({ approved: true, version: 'test-policy-v1', region: 'cn-shanghai',
  services: { input: 'baselineCheck', output: 'aigcCheck' }, lowRisk: 'review', timeoutMs: 100 });
const reply = (request, overrides = {}) => ({ statusCode: 200, body: { Code: 200, RequestId: 'provider-request-001',
  Data: { DataId: request.serviceParameters.dataId, RiskLevel: 'none', Result: [{ Label: 'nonLabel' }], ...overrides } } });
function fixture({ policy = approved(), respond = reply, put, remove, sign } = {}) {
  const calls = [];
  const objects = new Map();
  const moderator = createPhotoImageModerator({ policy, now: () => 1791500000000,
    storage: {
      async put(key, bytes, options) { calls.push({ type: 'put', key, options }); objects.set(key, Buffer.from(bytes)); await put?.(key, bytes); },
      signedUrl(key, options) { calls.push({ type: 'sign', key, options }); return sign ? sign(key) : `https://private-example.oss-cn-shanghai.aliyuncs.com/${key}?Signature=REDACTED_SECRET },
      async delete(key) { calls.push({ type: 'delete', key }); await remove?.(key); objects.delete(key); },
    },
    transport: async request => { calls.push({ type: 'audit', request }); return respond(request); },
  });
  return { moderator, calls, objects, moderate: extra => moderator.moderate({ bytes: png(), contentType: 'image/png', direction: 'input', journal: async () => true, ...extra }) };
}

test('explicit approved server policy is mandatory; credential presence never enables moderation', () => {
  for (const policy of [undefined, {}, { ...approved(), approved: false }, { ...approved(), lowRisk: undefined },
    { ...approved(), region: 'us-west-1' }, { ...approved(), services: { input: 'aigcDetector', output: 'aigcCheck' } },
    { ...approved(), timeoutMs: 60_001 }]) {
    assert.throws(() => fixture({ policy: policy ?? {} }), /PHOTO_MODERATION/);
  }
});

test('real SDK call contract uses body, server-selected service, correct region and zero retries', async () => {
  let captured;
  const result = { statusCode: 200, body: { Code: 200 } };
  const transport = createGreenImageTransport({ region: 'cn-shanghai', client: {
    async callApi(params, request, runtime) { captured = { params, request, runtime }; return result; },
  } });
  assert.equal(await transport({ service: 'baselineCheck', serviceParameters: { imageUrl: 'https://example.test/image.png', dataId: 'a'.repeat(64) }, timeoutMs: 1000 }), result);
  assert.equal(captured.params.action, 'ImageModeration');
  assert.equal(captured.params.version, '2022-03-02');
  assert.equal(captured.params.protocol, 'HTTPS');
  assert.equal(captured.params.reqBodyType, 'formData');
  assert.equal(captured.request.query, undefined);
  assert.equal(captured.request.body.Service, 'baselineCheck');
  assert.equal(JSON.parse(captured.request.body.ServiceParameters).dataId, 'a'.repeat(64));
  assert.equal(captured.runtime.autoretry, false);
  assert.equal(captured.runtime.maxAttempts, 1);
  assert.equal(captured.runtime.readTimeout, 1000);
});

test('installed official SDK signs and serializes the real request with network replaced in memory', async () => {
  const tea = createRequire(import.meta.url)('@alicloud/tea-typescript');
  const original = tea.doAction;
  let captured;
  tea.doAction = async (request, runtime) => {
    let body = '';
    for await (const chunk of request.body) body += chunk.toString();
    captured = { request, runtime, body };
    return { statusCode: 200, headers: {}, body: Readable.from([Buffer.from(JSON.stringify({ Code: 200, RequestId: 'synthetic-sdk-response' }))]) };
  };
  try {
    const transport = createGreenImageTransport({ region: 'cn-shanghai', credential: {
      accessKeyId: 'unit-test-key-not-a-real-credential', accessKeySecret: 'unit-test-secret-not-a-real-credential',
    } });
    const response = await transport({ service: 'baselineCheck', serviceParameters: {
      imageUrl: 'https://example.test/synthetic.png?Signature=REDACTED_SECRET dataId: 'b'.repeat(64),
    }, timeoutMs: 1000 });
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.RequestId, 'synthetic-sdk-response');
    assert.equal(captured.request.protocol, 'HTTPS');
    assert.equal(captured.request.headers.host, 'green-cip.cn-shanghai.aliyuncs.com');
    assert.match(captured.request.headers.Authorization, /^ACS3-HMAC-SHA256 /);
    assert.equal(captured.request.headers['x-acs-action'], 'ImageModeration');
    assert.equal(captured.request.headers['x-acs-version'], '2022-03-02');
    const form = new URLSearchParams(captured.body);
    assert.equal(form.get('Service'), 'baselineCheck');
    assert.equal(JSON.parse(form.get('ServiceParameters')).dataId, 'b'.repeat(64));
    assert.equal(captured.runtime.retry.retryable, false);
    assert.equal(captured.runtime.retry.maxAttempts, 1);
  } finally { tea.doAction = original; }
});

test('OSS byte implementation forces immutable private scratch objects and rejects unsafe signing targets', async () => {
  const calls = [];
  const bucket = 'moderation-test';
  const key = `private/photo-moderation/${'a'.repeat(32)}.png`;
  let signed = `https://${bucket}.oss-cn-shanghai.aliyuncs.com/${key}?Signature=REDACTED_SECRET
  const storage = createOssModerationStorage({ bucket, region: 'cn-shanghai', client: {
    async put(...args) { calls.push(args); },
    signatureUrl() { return signed; },
    async delete(...args) { calls.push(args); },
  } });
  await storage.put(key, png(), { contentType: 'image/png', timeoutMs: 1000 });
  assert.equal(calls[0][2].headers['x-oss-object-acl'], 'private');
  assert.equal(calls[0][2].headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(storage.signedUrl(key, { ttlSeconds: 120 }), signed);
  await storage.delete(key, { timeoutMs: 1000 });
  await assert.rejects(storage.put('private/source.png', png(), {}), /STORAGE_KEY_INVALID/);
  signed = 'https://attacker.test/?Signature=REDACTED_SECRET
  assert.throws(() => storage.signedUrl(key, { ttlSeconds: 120 }), /STORAGE_URL_INVALID/);
});

test('byte snapshot, frozen policy and receipt bind the image, direction, service and RequestId', async () => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const policy = approved();
  const source = png();
  const digest = crypto.createHash('sha256').update(source).digest('hex');
  const f = fixture({ policy, put: () => wait });
  const pending = f.moderate({ bytes: source, service: 'aigcDetector', sha256: 'f'.repeat(64), policyVersion: 'client-fake' });
  source.fill(0); policy.services.input = 'aigcDetector'; policy.version = 'mutated';
  release();
  const result = await pending;
  assert.equal(result.decision, 'allow');
  assert.equal(result.sha256, digest);
  assert.equal(result.policyVersion, 'test-policy-v1');
  assert.equal(result.service, 'baselineCheck');
  assert.equal(result.direction, 'input');
  assert.equal(result.requestId, 'provider-request-001');
  assert.match(result.reference, /^mod_[a-f0-9]{64}$/);
  assert.equal(result.cleanupPending, false);
  assert.equal(f.objects.size, 0);
  assert.deepEqual(f.calls.map(item => item.type), ['put', 'sign', 'audit', 'delete']);
  assert.equal(f.calls[1].options.ttlSeconds, 120);
  const out = await f.moderate({ direction: 'output' });
  assert.equal(out.service, 'aigcCheck');
  assert.notEqual(out.reference, result.reference);
});

test('official risk levels map to explicit policy; Code 200 alone never permits publication', async t => {
  for (const [risk, label, expected] of [['none', 'nonLabel', 'allow'], ['low', 'ad_test', 'review'],
    ['medium', 'ad_test', 'review'], ['high', 'ad_test', 'block']]) {
    await t.test(risk, async () => {
      const f = fixture({ respond: request => reply(request, { RiskLevel: risk, Result: [{ Label: label, ...(risk !== 'none' ? { Confidence: 98.25 } : {}) }] }) });
      const result = await f.moderate();
      assert.equal(result.decision, expected);
      assert.equal(result.riskLevel, risk);
      assert.equal(f.calls.filter(item => item.type === 'audit').length, 1);
    });
  }
  const configuredLow = fixture({ policy: { ...approved(), lowRisk: 'allow' }, respond: request => reply(request, { RiskLevel: 'low', Result: [{ Label: 'ad_test', Confidence: 10 }] }) });
  assert.equal((await configuredLow.moderate()).decision, 'allow');
  const manual = fixture({ respond: request => reply(request, { ManualTaskId: 'manual-review-1' }) });
  assert.equal((await manual.moderate()).decision, 'review');
});

test('incomplete, mismatched or contradictory upstream evidence stays unconfirmed', async t => {
  const changes = [
    value => { value.statusCode = 503; }, value => { value.body.Code = 400; },
    value => { delete value.body.RequestId; }, value => { delete value.body.Data.RiskLevel; },
    value => { value.body.Data.RiskLevel = 'unknown'; }, value => { value.body.Data.DataId = 'different-image'; },
    value => { value.body.Data.Result = []; }, value => { value.body.Data.Result = [{ Label: 'nonLabel', Confidence: 101 }]; },
    value => { value.body.Data.Result = [{ Label: 'nonLabel', Confidence: '90' }]; },
    value => { value.body.Data.Result = [{ Label: 'pornographic_adultContent' }]; },
    value => { value.body.Data.Result = [{ Label: 'nonLabel', RiskLevel: 'high' }]; },
  ];
  for (const [index, change] of changes.entries()) await t.test(String(index), async () => {
    const f = fixture({ respond: request => { const value = reply(request); change(value); return value; } });
    const result = await f.moderate();
    assert.equal(result.decision, 'unconfirmed');
    assert.equal(result.reference, undefined);
    assert.equal(result.cleanupPending, false);
  });
});

test('only safe response fields escape; errors never expose URL, pixels, OCR, credentials or upstream messages', async () => {
  const secret = 'PRIVATE_VALUE_NOT_FOR_LOGS';
  const f = fixture({ respond: request => ({ ...reply(request, { Ext: { OcrResult: secret }, Result: [{ Label: 'nonLabel', Description: secret }] }), headers: { authorization: secret } }) });
  const result = await f.moderate();
  assert.equal(result.decision, 'allow');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${secret}|Signature|imageUrl|storageKey|body|headers`));
  const error = fixture({ respond: () => { throw new Error(secret); } });
  const denied = await error.moderate();
  assert.equal(denied.decision, 'unconfirmed');
  assert.doesNotMatch(JSON.stringify(denied), new RegExp(secret));
});

test('timeout is bounded, calls upstream once and never substitutes a pass or retry', async () => {
  const f = fixture({ policy: { ...approved(), timeoutMs: 15 }, respond: () => new Promise(() => {}) });
  const result = await f.moderate();
  assert.equal(result.decision, 'unconfirmed');
  assert.equal(result.code, 'PHOTO_MODERATION_TIMEOUT');
  assert.equal(f.calls.filter(item => item.type === 'audit').length, 1);
  assert.equal(f.calls.filter(item => item.type === 'delete').length, 1);
});

test('failed deletion and uncertain upload truthfully require a persistent cleanup retry', async () => {
  const failedDelete = fixture({ remove: () => { throw new Error('private diagnostic'); } });
  const result = await failedDelete.moderate();
  assert.equal(result.decision, 'allow');
  assert.equal(result.cleanupPending, true);
  assert.match(result.cleanupReference, /^[a-f0-9]{32}$/);
  assert.equal(result.cleanupExtension, 'png');
  const uncertainPut = fixture({ put: () => { throw new Error('request response lost'); } });
  const uncertain = await uncertainPut.moderate();
  assert.equal(uncertain.decision, 'unconfirmed');
  assert.equal(uncertain.cleanupPending, true);
  assert.equal(uncertainPut.calls.filter(item => item.type === 'audit').length, 0);
});

test('unsupported size, MIME and animation never upload or invoke moderation', async () => {
  const f = fixture();
  for (const extra of [{ bytes: Buffer.alloc(15) }, { bytes: Buffer.alloc(20 * 1024 * 1024 + 1) },
    { contentType: 'image/gif' }, { contentType: 'image/jpeg' }, { direction: 'client' }]) {
    await assert.rejects(f.moderate(extra), /PHOTO_MODERATION/);
  }
  const animationChunk = Buffer.alloc(12); animationChunk.write('acTL', 4, 'ascii');
  await assert.rejects(f.moderate({ bytes: Buffer.concat([png().subarray(0, 8), animationChunk, png().subarray(8)]) }), /ANIMATION_UNSUPPORTED/);
  assert.equal(f.calls.length, 0);
});

test('scratch cleanup intent must be durably acknowledged before any storage or provider operation', async () => {
  const f = fixture();
  for (const journal of [undefined, async () => false, async () => undefined,
    async () => { throw new Error('journal commit response lost'); }]) {
    await assert.rejects(f.moderate({ journal }));
    assert.equal(f.calls.length, 0);
  }
  let release;
  let intent;
  const wait = new Promise(resolve => { release = resolve; });
  const pending = f.moderate({ journal: async value => { intent = { ...value }; await wait; return true; } });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(intent.reference, /^[a-f0-9]{32}$/);
  assert.equal(intent.extension, 'png');
  assert.equal(f.calls.length, 0);
  release();
  const result = await pending;
  assert.equal(result.cleanupPending, false);
  assert.equal(result.cleanupReference, intent.reference);
  assert.equal(result.cleanupExtension, intent.extension);
  assert.equal(f.calls[0].key, `private/photo-moderation/${intent.reference}.png`);
  assert.deepEqual(f.calls.map(item => item.type), ['put', 'sign', 'audit', 'delete']);
});
