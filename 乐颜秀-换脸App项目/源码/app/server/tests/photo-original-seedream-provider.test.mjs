import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync, crc32 } from 'node:zlib';
import { PHOTO_EFFECTS } from '../photo-effects.js';
import { createOriginalSeedreamPhotoAdapter, originalSeedreamEffectParameters,
  ORIGINAL_SEEDREAM_EFFECT_IDS, ORIGINAL_SEEDREAM_MODEL, ORIGINAL_SEEDREAM_PROVIDER } from '../photo-jobs/original-seedream-provider.js';

// Entirely synthetic: transports never access network.
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function pngImage(width = 512, height = 512) {
  const chunk = (kind, body) => {
    const type = Buffer.from(kind), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(body.length); crc.writeUInt32BE(crc32(Buffer.concat([type, body])));
    return Buffer.concat([length, type, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 0;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (width + 1)))), chunk('IEND', Buffer.alloc(0))]);
}
const png = pngImage();
const input = (bytes = png) => ({ bytes: Buffer.from(bytes), byteLength: bytes.length, contentType: 'image/png', sha256: sha(bytes) });
const spec = (effectId = 'classic-black-white') => ({ inputAssetId: 'owned_input_1', effectId,
  effectVersion: 'offline-original-fixture-v1', purpose: `photo-effect:${effectId}`,
  provider: ORIGINAL_SEEDREAM_PROVIDER, model: ORIGINAL_SEEDREAM_MODEL,
  effectParameters: originalSeedreamEffectParameters(effectId) });
const sourceData = `data:image/png;base64,${png.toString('base64')}`;
const resultUrl = 'https://result.example.test/temporary/output.png?Signature=REDACTED_SECRET
const response = (value = { data: [{ url: resultUrl }] }) => ({ status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify(value)) });
function fixture({ transport, ...config } = {}) {
  const calls = [];
  const adapter = createOriginalSeedreamPhotoAdapter({ apiKey: 'fixture-private-key',
    resultHosts: ['result.example.test'],
    transport: async request => { calls.push(request); return transport ? transport(request) : response(); }, ...config });
  return { adapter, calls };
}

test('all 13 original prompts and legacy model parameters use verified data URI bytes without a source issuer', async () => {
  const expectedIds = ['hong-kong-90s', 'vintage-80s', 'classic-black-white', 'song-portrait', 'dunhuang',
    'new-chinese', 'cheongsam', 'natural-avatar', 'modern-comic', 'gentle-watercolor', 'classic-oil', 'pencil-sketch', 'scratch-repair'];
  assert.deepEqual(ORIGINAL_SEEDREAM_EFFECT_IDS, expectedIds);
  for (const id of expectedIds) {
    const f = fixture(); const result = await f.adapter.generate({ input: input(), spec: spec(id) });
    assert.equal(f.calls.length, 1);
    const request = f.calls[0];
    assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/v3/images/generations');
    assert.equal(request.method, 'POST'); assert.equal(request.timeoutMs, 120_000);
    assert.deepEqual(request.allowedHosts, ['ark.cn-beijing.volces.com']);
    assert.deepEqual(JSON.parse(request.body), { model: 'doubao-seedream-4-0-250828', prompt: PHOTO_EFFECTS[id].prompt,
      image: sourceData, response_format: 'url', size: '2k', watermark: true });
    assert.deepEqual(result, { provider: ORIGINAL_SEEDREAM_PROVIDER, model: ORIGINAL_SEEDREAM_MODEL,
      url: resultUrl, responseFingerprint: sha(response().bytes), receiptIncomplete: true,
      integrationGap: 'supplier-request-id-unconfirmed' });
    assert.equal(Object.hasOwn(result, 'requestId'), false);
    assert.equal(Object.hasOwn(result, 'providerRequestId'), false);
  }
});

test('dedicated functions, aliases and arbitrary prompts cannot become generative effects', async () => {
  for (const id of ['age-change', 'face-enhance', 'natural-color', 'super-resolution', 'old-photo-restore', '__proto__', 'unknown']) {
    assert.equal(originalSeedreamEffectParameters(id), null);
    const f = fixture(); await assert.rejects(f.adapter.generate({ input: input(), spec: spec(id) }), { code: 'PHOTO_SEEDREAM_SPEC_REJECTED' });
    assert.equal(f.calls.length, 0);
  }
  const changed = originalSeedreamEffectParameters('natural-avatar'); changed.prompt = 'replacement';
  assert.equal(originalSeedreamEffectParameters('natural-avatar').prompt, PHOTO_EFFECTS['natural-avatar'].prompt);
});

test('provider/model/effect binding and unsupported parameter drift fail before dispatch', async () => {
  for (const mutate of [s => { s.provider = 'aliyun-qwen-image'; }, s => { s.model = 'other-model'; },
    s => { s.purpose = 'photo-effect:modern-comic'; }, s => { delete s.effectVersion; }, s => { delete s.inputAssetId; },
    s => { s.effectParameters.prompt += 'rewrite'; }, s => { s.effectParameters.size = '4k'; },
    s => { s.effectParameters.watermark = false; }, s => { s.effectParameters.responseFormat = 'b64_json'; },
    s => { s.effectParameters.n = 2; }, s => { s.effectParameters.seed = 42; }, s => { delete s.effectParameters.prompt; }]) {
    const f = fixture(), s = spec(); mutate(s);
    await assert.rejects(f.adapter.generate({ input: input(), spec: s }), { code: 'PHOTO_SEEDREAM_SPEC_REJECTED' });
    assert.equal(f.calls.length, 0);
  }
});

test('input bytes, hash and MIME are checked before dispatch', async () => {
  for (const mutate of [i => { i.sha256 = '0'.repeat(64); }, i => { i.byteLength++; },
    i => { i.contentType = 'image/jpeg'; }, i => { i.bytes[0] = 0; i.sha256 = sha(i.bytes); },
    i => { i.bytes = Buffer.alloc(2 * 1024 * 1024 + 1); i.byteLength = i.bytes.length; i.sha256 = sha(i.bytes); }]) {
    const f = fixture(), i = input(); mutate(i);
    await assert.rejects(f.adapter.generate({ input: i, spec: spec() }), { code: 'PHOTO_SEEDREAM_IMAGE_REJECTED' });
    assert.equal(f.calls.length, 0);
  }
});

test('official 36M-pixel, minimum side and aspect-ratio boundaries are enforced before dispatch', async () => {
  for (const [width, height, accepted] of [[6000, 6000, true], [6001, 6000, false],
    [15, 15, true], [14, 15, false], [15, 14, false],
    [1024, 64, true], [64, 1024, true], [1025, 64, false], [64, 1025, false]]) {
    const f = fixture(); const generating = f.adapter.generate({ input: input(pngImage(width, height)), spec: spec() });
    if (accepted) { await generating; assert.equal(f.calls.length, 1); }
    else { await assert.rejects(generating, { code: 'PHOTO_SEEDREAM_IMAGE_REJECTED' }); assert.equal(f.calls.length, 0); }
  }
});

test('input/spec/config mutation while transport waits cannot change the dispatched image or prompt', async () => {
  let release;
  const resultHosts = ['result.example.test'];
  const f = fixture({ resultHosts, transport: () => new Promise(resolve => {
    release = () => resolve(response());
  }) });
  const i = input(), s = spec(); const generating = f.adapter.generate({ input: i, spec: s });
  i.bytes.fill(0); s.effectId = 'age-change'; s.effectParameters.prompt = 'mutated'; resultHosts[0] = 'other.test';
  release(); await generating;
  assert.equal(JSON.parse(f.calls[0].body).prompt, PHOTO_EFFECTS['classic-black-white'].prompt);
  assert.equal(JSON.parse(f.calls[0].body).image, sourceData);
});

test('transport error and ambiguous/multiple/failed responses never retry, fallback or leak raw errors', async () => {
  const outputs = [() => { throw new Error('secret token and private URL'); },
    () => ({ ...response(), status: 429 }), () => ({ ...response(), contentType: 'text/html' }),
    () => ({ ...response(), bytes: Buffer.from('{') }), () => response({ data: [] }),
    () => response({ data: [{ url: resultUrl }, { url: resultUrl }] }),
    () => response({ error: { message: 'private' }, data: [{ url: resultUrl }] }),
    () => response({ data: [{ error: {}, url: resultUrl }] }),
    () => response({ model: 'other-model', data: [{ url: resultUrl }] }),
    () => response({ data: [{ b64_json: 'not-a-url' }] })];
  for (const transport of outputs) {
    const f = fixture({ transport });
    await assert.rejects(f.adapter.generate({ input: input(), spec: spec() }), error => {
      assert.equal(error.outcome, 'unknown'); assert.equal(error.retryAllowed, false);
      assert.match(error.message, /^PHOTO_SEEDREAM_(OUTCOME|RESPONSE)_UNCONFIRMED$/);
      assert.equal(error.cause, undefined); return true;
    });
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'POST');
  }
});

test('exact result-host policy rejects parser tricks and arbitrary destinations without any download', async () => {
  for (const url of ['http://result.example.test/image.png', 'https://127.0.0.1/image.png', 'https://result.example.test.evil.test/a',
    'https://result.example.test:443/a', 'https://user@result.example.test/a', 'https://%72esult.example.test/a',
    'https://result.example.test./a', 'https://result。example.test/a', 'https://result.example.test/a#fragment',
    'https://result.example.test/a\n', 'https://result.example.test\\@other.test/a']) {
    const f = fixture({ transport: () => response({ data: [{ url }] }) });
    await assert.rejects(f.adapter.generate({ input: input(), spec: spec() }), { code: 'PHOTO_SEEDREAM_RESPONSE_UNCONFIRMED' });
    assert.equal(f.calls.length, 1);
    await assert.rejects(f.adapter.readGenerated({ url }), { code: 'PHOTO_SEEDREAM_URL_REJECTED' });
    assert.equal(f.calls.length, 1);
  }
});

test('result download preserves actual image MIME, bounded bytes and hash and sends no API authorization', async () => {
  const f = fixture({ transport: () => ({ status: 200, contentType: 'image/png', bytes: png }) });
  const result = await f.adapter.readGenerated({ url: resultUrl });
  assert.deepEqual(result, input()); assert.notEqual(result.bytes, png);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'GET');
  assert.deepEqual(f.calls[0].allowedHosts, ['result.example.test']);
  assert.equal(f.calls[0].headers.Authorization, undefined); assert.equal(f.calls[0].maxBytes, 20 * 1024 * 1024);
  for (const transport of [() => ({ status: 302, contentType: 'image/png', bytes: png }),
    () => ({ status: 200, contentType: 'image/jpeg', bytes: png }),
    () => ({ status: 200, contentType: 'image/png', bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }),
    () => { throw new Error('private URL'); }]) {
    const broken = fixture({ transport });
    await assert.rejects(broken.adapter.readGenerated({ url: resultUrl }), { code: 'PHOTO_SEEDREAM_OUTPUT_UNCONFIRMED', retryAllowed: false });
    assert.equal(broken.calls.length, 1);
  }
});

test('credentials and exact result host policies must be explicitly supplied; construction is inert', () => {
  assert.throws(() => createOriginalSeedreamPhotoAdapter({ resultHosts: ['result.example.test'] }), { code: 'PHOTO_SEEDREAM_CONFIG_REQUIRED' });
  for (const config of [{ apiKey: '' }, { resultHosts: [] },
    { resultHosts: ['*.example.test'] }, { resultHosts: ['127.0.0.1'] }, { resultHosts: ['result.example.test', 'result.example.test'] },
    { resultHosts: ['result.example.test:443'] }, { timeoutMs: 120_001 }]) assert.throws(() => fixture(config), /PHOTO_SEEDREAM_/);
  const f = fixture(); assert.equal(f.calls.length, 0);
});

test('only a valid server-header receipt supplies requestId; body/client/log IDs and hashes never substitute', async () => {
  const serverRequestId = '20261015ABCDEF0123456789';
  const body = { data: [{ url: resultUrl }], request_id: 'body-not-trusted' };
  const valid = fixture({ transport: () => ({ ...response(body), serverRequestId }) });
  const result = await valid.adapter.generate({ input: input(), spec: spec() });
  assert.equal(result.requestId, serverRequestId); assert.equal(result.requestIdSource, 'response-header:x-request-id');
  assert.equal(Object.hasOwn(result, 'receiptIncomplete'), false); assert.equal(result.responseFingerprint, sha(response(body).bytes));
  for (const id of [undefined, null, '', 123, ['duplicate', 'headers'], 'bad id', 'value\r\ninjected', 'x'.repeat(129), 'a,b']) {
    const f = fixture({ transport: () => ({ ...response(body), serverRequestId: id,
      clientRequestId: 'client-not-server', logId: 'unrelated-service', requestId: 'injected-top-level' }) });
    const value = await f.adapter.generate({ input: input(), spec: spec() });
    assert.equal(Object.hasOwn(value, 'requestId'), false); assert.equal(Object.hasOwn(value, 'requestIdSource'), false);
    assert.equal(value.receiptIncomplete, true); assert.equal(value.integrationGap, 'supplier-request-id-unconfirmed');
    assert.equal(f.calls.length, 1);
  }
});

test('a maximum 2 MiB valid PNG fits the existing 3 MiB transport body bound after base64 encoding', async () => {
  // Add a legal ancillary text chunk before IEND; do not allocate huge raster data.
  const padding = Buffer.alloc(2 * 1024 * 1024 - png.length - 12, 97); padding[8] = 0;
  const length = Buffer.alloc(4), crc = Buffer.alloc(4), type = Buffer.from('tEXt');
  length.writeUInt32BE(padding.length); crc.writeUInt32BE(crc32(Buffer.concat([type, padding])));
  const bytes = Buffer.concat([png.subarray(0, -12), length, type, padding, crc, png.subarray(-12)]);
  assert.equal(bytes.length, 2 * 1024 * 1024);
  const f = fixture(); await f.adapter.generate({ input: input(bytes), spec: spec() });
  assert.ok(f.calls[0].body.length < 3 * 1024 * 1024);
  const encoded = JSON.parse(f.calls[0].body).image;
  assert.deepEqual(Buffer.from(encoded.split(',')[1], 'base64'), bytes);
});
