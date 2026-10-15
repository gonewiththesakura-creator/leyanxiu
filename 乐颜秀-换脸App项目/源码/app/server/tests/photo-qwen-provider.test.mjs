import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Duplex, PassThrough } from 'node:stream';
import https from 'node:https';
import net from 'node:net';
import { deflateSync, crc32 } from 'node:zlib';
import { createPhotoHttpsTransport, createQwenPhotoProvider, QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER,
  QWEN_PHOTO_RESULT_HOSTS, QWEN_PHOTO_RESULT_POLICY, checkedQwenPhotoResultUrl, checkedQwenPhotoApiEndpoint,
  getPhotoProviderDiagnostic } from '../photo-jobs/qwen-provider.js';

const sha = b => createHash('sha256').update(b).digest('hex');
function png512() {
  const chunk = (kind, body) => { const type = Buffer.from(kind); const n = Buffer.alloc(4); n.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, body]))); return Buffer.concat([n, type, body, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(512); header.writeUInt32BE(512, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.alloc(512 * (512 * 3 + 1)))), chunk('IEND', Buffer.alloc(0))]);
}
const png = png512();
const input = () => ({ bytes: Buffer.from(png), contentType: 'image/png', byteLength: png.length, sha256: sha(png) });
const spec = () => ({ provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL,
  effectParameters: { prompt: '自然增强照片，保持原始内容。', negativePrompt: '变形，多余内容', n: 1,
    watermark: true, promptExtend: false, size: '1024*1024', seed: 42 } });
const resultUrl = `https://${QWEN_PHOTO_RESULT_HOSTS[0]}/synthetic.png?Expires=2000000000&Signature=REDACTED_SECRET
const receipt = () => ({ request_id: 'synthetic_request_1', output: { choices: [{ finish_reason: 'stop',
  message: { role: 'assistant', content: [{ image: resultUrl }] } }] }, usage: { image_count: 1, width: 1024, height: 1024 } });
const response = obj => ({ status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify(obj)) });
function fixture(transport) { const calls = []; return { calls, provider: createQwenPhotoProvider({ apiKey: 'synthetic-key-only',
  transport: async request => { calls.push(request); return transport ? transport(request) : response(receipt()); } }) }; }

test('fixed model, one image and verified source bytes are submitted without a public input URL', async () => {
  assert.equal(QWEN_PHOTO_MODEL, 'qwen-image-2.0-2026-03-03');
  const f = fixture(); const request = { input: input(), spec: spec() };
  const pending = f.provider.generate(request); request.input.bytes.fill(0); request.spec.effectParameters.prompt = 'mutated';
  const result = await pending;
  assert.equal(f.calls.length, 1); const payload = JSON.parse(f.calls[0].body);
  assert.equal(payload.model, QWEN_PHOTO_MODEL); assert.equal(payload.parameters.n, 1);
  assert.equal(payload.parameters.watermark, true); assert.equal(payload.parameters.prompt_extend, false);
  assert.equal(payload.input.messages[0].content[1].text, spec().effectParameters.prompt);
  assert.equal(payload.input.messages[0].content[0].image, `data:image/png;base64,${png.toString('base64')}`);
  assert.deepEqual(f.calls[0].allowedHosts, ['dashscope.aliyuncs.com']);
  assert.deepEqual(result, { provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, requestId: 'synthetic_request_1', url: resultUrl });
});

test('official HTTP and SDK success example shapes pass without treating nullable outer aliases as failure', async () => {
  // Independently transcribed success shapes from the HTTP response and Python
  // response examples, checked 2026-10-10; values identify synthetic fixtures.
  // https://help.aliyun.com/zh/model-studio/qwen-image-edit-api
  // These are NOT captured account responses and establish no live acceptance.
  const examples = [{
    output: { choices: [{ finish_reason: 'stop', message: {
      content: [{ image: 'https://dashscope-result-sz.oss-cn-shenzhen.aliyuncs.com/synthetic.png?Expires=2000000000' }],
      role: 'assistant',
    } }] },
    usage: { height: 2048, image_count: 1, width: 2048 },
    request_id: '11111111-2222-4333-8444-555555555555',
  }, {
    status_code: 200, request_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', code: '', message: '',
    output: { text: null, finish_reason: null, choices: [{ finish_reason: 'stop', message: {
      role: 'assistant', content: [{ image: 'https://dashscope-result-hz.oss-cn-hangzhou.aliyuncs.com/synthetic.png?Expires=2000000000' }],
    } }], audio: null },
    usage: { input_tokens: 0, output_tokens: 0, characters: 0, height: 2048, image_count: 1, width: 2048 },
  }];
  for (const example of examples) {
    const calls = [];
    const provider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: async request => {
      calls.push(request); return { status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify(example)) };
    } });
    const result = await provider.generate({ input: input(), spec: spec() });
    assert.equal(calls.length, 1);
    assert.deepEqual(result, { provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL,
      requestId: example.request_id, url: example.output.choices[0].message.content[0].image });
  }
});

test('server-owned Beijing host, SDK base and full endpoint normalize to the single generation API', async () => {
  const apiPath = '/api/v1/services/aigc/multimodal-generation/generation';
  for (const hostname of ['dashscope.aliyuncs.com', 'synthetic-workspace.cn-beijing.maas.aliyuncs.com']) {
    for (const scheme of ['', 'https://']) for (const suffix of ['', '/', '/api/v1', '/api/v1/', apiPath, `${apiPath}/`]) {
      const calls = [];
      const provider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', baseUrl: `${scheme}${hostname}${suffix}`,
        transport: async request => { calls.push(request); return response(receipt()); } });
      await provider.generate({ input: input(), spec: spec() });
      assert.equal(calls.length, 1); assert.equal(calls[0].url, `https://${hostname}${apiPath}`);
      assert.deepEqual(calls[0].allowedHosts, [hostname]);
      assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-key-only');
    }
  }
  assert.equal(checkedQwenPhotoApiEndpoint().hostname, 'dashscope.aliyuncs.com');
});

test('foreign regions, impersonation and URL parser normalization cannot redirect the API credential', () => {
  const host = 'synthetic-workspace.cn-beijing.maas.aliyuncs.com';
  const rejected = ['', null, ` https://${host}`, `https://${host}\n`, `https://${host}/api/\tv1`,
    `http://${host}`, `HTTPS://${host}`, `//${host}`, `https://${host}:443`, `https://${host}:444`,
    `https://REDACTED_USER:REDACTED_PASSWORD@${host}`, `https://${host}.`, `https://${host}.evil.invalid`,
    'https://synthetic-workspace.evil.cn-beijing.maas.aliyuncs.com', 'https://synthetic-workspace-cn-beijing.maas.aliyuncs.com',
    'https://dashscope-intl.aliyuncs.com', 'https://customer.oss-cn-beijing.aliyuncs.com', 'https://127.0.0.1',
    `https://%73${host.slice(1)}`, `https://${host.replaceAll('.', '。')}`, `https://${host}\\@evil.invalid`,
    `https://${host}?token=REDACTED_SECRET `https://${host}#fragment`, `https://${host}/wrong/../api/v1`,
    `https://${host}/%2e/api/v1`, `https://${host}/api//v1`, `https://${host}/compatible-mode/v1`,
    `https://${host}/api/v1/services/aigc/multimodal-generation/generation/other`,
    `https://${'x'.repeat(64)}.cn-beijing.maas.aliyuncs.com`,
    ...['cn-hongkong', 'ap-southeast-1', 'us-east-1', 'eu-central-1', 'ap-northeast-1', 'cn-shanghai'].map(region =>
      `https://synthetic-workspace.${region}.maas.aliyuncs.com`),
  ];
  let calls = 0;
  for (const baseUrl of rejected) {
    assert.throws(() => createQwenPhotoProvider({ apiKey: 'synthetic-key-only', baseUrl,
      transport: async () => { calls++; } }), error => {
      assert.equal(error.code, 'PHOTO_PROVIDER_ENDPOINT_REJECTED');
      assert.equal(String(error), 'Error: PHOTO_PROVIDER_ENDPOINT_REJECTED'); return true;
    });
  }
  for (const apiKey of ['synthetic\u0000key', 'synthetic\r\nkey', 'synthetic key', 'synthetic-密钥']) {
    assert.throws(() => createQwenPhotoProvider({ apiKey }), /CONFIG_REQUIRED/);
  }
  assert.equal(calls, 0);
});

test('endpoint stays in the server closure, client fields cannot redirect it, and download never receives the key', async () => {
  const calls = [];
  const options = { apiKey: 'synthetic-workspace-key', baseUrl: 'synthetic-workspace.cn-beijing.maas.aliyuncs.com',
    transport: async request => { calls.push(request); return request.method === 'GET'
      ? { status: 200, contentType: 'image/png', bytes: png } : response(receipt()); } };
  const provider = createQwenPhotoProvider(options);
  options.baseUrl = 'https://evil.invalid'; options.apiKey = 'mutated-client-key';
  await provider.generate({ input: { ...input(), endpoint: 'https://evil.invalid' },
    spec: { ...spec(), endpoint: 'https://evil.invalid', baseUrl: 'https://evil.invalid' },
    baseUrl: 'https://evil.invalid', apiKey: 'mutated-client-key' });
  await provider.readGenerated({ url: resultUrl, baseUrl: 'https://evil.invalid', apiKey: 'mutated-client-key' });
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).hostname, 'synthetic-workspace.cn-beijing.maas.aliyuncs.com');
  assert.equal(calls[0].headers.Authorization, 'Bearer synthetic-workspace-key');
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.deepEqual(calls[1].allowedHosts, [new URL(resultUrl).hostname]);
});

test('workspace 404 InvalidParameter retains bounded diagnostic and never falls back or retries', async () => {
  const f = wire({ status: 404, chunks: [Buffer.from(JSON.stringify({ code: 'InvalidParameter',
    request_id: '11111111-2222-4333-8444-555555555555', message: 'private request body and endpoint' }))] });
  const provider = createQwenPhotoProvider({ apiKey: 'synthetic-workspace-key',
    baseUrl: 'synthetic-workspace.cn-beijing.maas.aliyuncs.com/api/v1', transport: f.transport });
  await assert.rejects(provider.generate({ input: input(), spec: spec() }), error => {
    assert.deepEqual(getPhotoProviderDiagnostic(error), { version: 1, operation: 'generate', stage: 'response_body',
      httpStatus: 404, providerCode: 'InvalidParameter', requestId: '11111111-2222-4333-8444-555555555555',
      outcome: 'unknown', retryAllowed: false });
    assert.doesNotMatch(JSON.stringify(error), /private|synthetic-workspace|aliyuncs/); return true;
  });
  assert.equal(f.calls.length, 1); assert.equal(f.lookupCount(), 1);
  assert.equal(new URL(f.calls[0].url).hostname, 'synthetic-workspace.cn-beijing.maas.aliyuncs.com');
});

test('unapproved models, parameters and changed source bytes stop before any API attempt', async () => {
  const f = fixture();
  for (const model of ['qwen-image-edit-plus-2025-12-15', 'qwen-image-2.0', 'qwen-image-2.0-pro-2026-06-22', 'qwen-image-3.0-pro']) {
    await assert.rejects(f.provider.generate({ input: input(), spec: { ...spec(), model } }), /SPEC_REJECTED/);
  }
  for (const modify of [s => { s.provider = 'other'; },
    s => { s.effectParameters.n = 2; }, s => { s.effectParameters.watermark = false; },
    s => { s.effectParameters.promptExtend = true; }, s => { s.effectParameters.endpoint = 'https://evil.invalid'; },
    s => { s.effectParameters.seed = -1; }]) {
    const s = spec(); modify(s); await assert.rejects(f.provider.generate({ input: input(), spec: s }), /SPEC_REJECTED/);
  }
  const wrong = input(); wrong.bytes[50] ^= 1;
  await assert.rejects(f.provider.generate({ input: wrong, spec: spec() }), /INPUT_REJECTED/);
  await assert.rejects(f.provider.generate({ input: { ...input(), contentType: 'image/jpeg' }, spec: spec() }), /INPUT_REJECTED/);
  assert.equal(f.calls.length, 0);
});

test('failure, timeout and malformed receipts never trigger a second paid request or leak upstream details', async () => {
  for (const value of [undefined, { request_id: 'synthetic_request_1', code: 'InvalidKey', message: 'private upstream data' },
    { ...receipt(), request_id: null }, { ...receipt(), usage: { image_count: 2, width: 1024, height: 1024 } },
    { ...receipt(), output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [
      { image: resultUrl }, { image: resultUrl }] } }] } }]) {
    const f = fixture(() => value ? response(value) : Promise.reject(new Error('secret token and private URL')));
    await assert.rejects(f.provider.generate({ input: input(), spec: spec() }), error => {
      assert.match(error.code, /PHOTO_PROVIDER_(OUTCOME|RESPONSE)_UNCONFIRMED/);
      assert.doesNotMatch(String(error), /secret|token|private/); return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('unexpected result hosts, redirects, credentials or schemes are not fetched', async () => {
  for (const url of ['http://' + QWEN_PHOTO_RESULT_HOSTS[0] + '/x.png', 'https://127.0.0.1/x.png',
    'https://customer-bucket.oss-cn-shanghai.aliyuncs.com/x.png', resultUrl + '#fragment',
    'https://REDACTED_USER:REDACTED_PASSWORD@' + QWEN_PHOTO_RESULT_HOSTS[0] + '/x.png', 'https://' + QWEN_PHOTO_RESULT_HOSTS[0] + '.evil.invalid/x.png']) {
    const f = fixture(); await assert.rejects(f.provider.readGenerated({ url }), /URL_REJECTED/); assert.equal(f.calls.length, 0);
    const bad = receipt(); bad.output.choices[0].message.content[0].image = url;
    const p = fixture(() => response(bad)); await assert.rejects(p.provider.generate({ input: input(), spec: spec() }), /URL_REJECTED/);
    assert.equal(p.calls.length, 1);
  }
});

test('download uses no API credential and binds bytes; MIME and size mismatches fail', async () => {
  const f = fixture(() => ({ status: 200, contentType: 'image/png', bytes: Buffer.from(png) }));
  const output = await f.provider.readGenerated({ url: resultUrl }); assert.equal(output.sha256, sha(png));
  assert.deepEqual(output.bytes, png); assert.equal(f.calls[0].headers.Authorization, undefined);
  for (const bad of [{ status: 302, contentType: 'image/png', bytes: png },
    { status: 200, contentType: 'text/html', bytes: png },
    { status: 200, contentType: 'image/png', bytes: Buffer.alloc(200) }]) {
    const f = fixture(() => bad); await assert.rejects(f.provider.readGenerated({ url: resultUrl }), /OUTPUT_UNCONFIRMED/);
  }
});

function wire({ status = 200, headers = {}, chunks = [Buffer.from('synthetic response')], addresses,
  hold = false, declaredLength, resolve } = {}) {
  const calls = []; let lookupCount = 0;
  const transport = createPhotoHttpsTransport({
    resolve: resolve || (async () => { lookupCount++; return addresses || [{ address: '8.8.8.8', family: 4 }]; }),
    request: (url, options, callback) => {
      const req = new EventEmitter(); req.destroy = () => {}; req.end = body => {
        calls.push({ url: url.toString(), options, body });
        if (hold) return;
        queueMicrotask(() => { const res = new PassThrough(); res.statusCode = status;
          res.headers = { 'content-type': 'application/json', ...headers,
            ...(declaredLength !== undefined ? { 'content-length': String(declaredLength) } : {}) };
          callback(res); for (const c of chunks) res.write(c); res.end(); });
      }; return req;
    },
  });
  const send = extra => transport({ url: 'https://dashscope.aliyuncs.com/test', allowedHosts: ['dashscope.aliyuncs.com'],
    timeoutMs: 100, maxBytes: 100, ...extra });
  return { transport, calls, send, lookupCount: () => lookupCount };
}

test('HTTPS transport pins a single public DNS resolution and retains certificate/host verification', async () => {
  const f = wire(); const response = await f.send(); assert.equal(response.bytes.toString(), 'synthetic response');
  assert.equal(f.lookupCount(), 1); assert.equal(f.calls.length, 1);
  const options = f.calls[0].options; assert.equal(options.rejectUnauthorized, true);
  assert.equal(options.servername, 'dashscope.aliyuncs.com'); assert.equal(options.agent, false);
  const values = await new Promise(resolve => options.lookup('dashscope.aliyuncs.com', {}, (...args) => resolve(args)));
  assert.deepEqual(values, [null, '8.8.8.8', 4]);
});

test('HTTPS transport exposes only a bounded actual X-Request-Id response header', async () => {
  for (const id of ['20261015ABCDEF0123456789', 'a'.repeat(128), 'supplier-id_123.4:trace']) {
    const f = wire({ headers: { 'x-request-id': id, 'x-client-request-id': 'client-id', 'x-tt-logid': 'other-service',
      'set-cookie': 'private-cookie', authorization: 'private-credential' } });
    const value = await f.send();
    assert.equal(value.serverRequestId, id);
    assert.deepEqual(Object.keys(value).sort(), ['bytes', 'contentType', 'serverRequestId', 'status']);
    assert.doesNotMatch(JSON.stringify(value), /private-cookie|private-credential|client-id|other-service/);
  }
  for (const id of [undefined, null, 123, ['a', 'b'], '', 'a'.repeat(129), ' id', 'id ', 'id\n', 'id\r\nx-other: value',
    '中文', 'a,b', 'a/b', 'https://private.test']) {
    const f = wire({ headers: { 'x-request-id': id, 'x-client-request-id': 'must-not-substitute', 'x-tt-logid': 'must-not-substitute' } });
    const value = await f.send({ headers: { 'x-request-id': 'outgoing-is-not-a-response-id' } });
    assert.equal(Object.hasOwn(value, 'serverRequestId'), false);
    assert.deepEqual(Object.keys(value).sort(), ['bytes', 'contentType', 'status']);
  }
});

test('header ID never replaces Qwen body request_id or turns an HTTP failure into a receipt', async () => {
  const f = fixture(() => ({ ...response(receipt()), serverRequestId: 'different-server-header-id' }));
  assert.equal((await f.provider.generate({ input: input(), spec: spec() })).requestId, receipt().request_id);
  const missing = receipt(); delete missing.request_id;
  const noBodyId = fixture(() => ({ ...response(missing), serverRequestId: 'not-a-body-id' }));
  await assert.rejects(noBodyId.provider.generate({ input: input(), spec: spec() }), /RESPONSE_UNCONFIRMED/);
  const failed = wire({ status: 503, headers: { 'x-request-id': 'not-a-success-receipt' }, chunks: [Buffer.from('{}')] });
  await assert.rejects(failed.send(), error => {
    assert.equal(Object.hasOwn(error, 'serverRequestId'), false);
    assert.doesNotMatch(JSON.stringify(error), /not-a-success-receipt/); return true;
  });
});

test('actual Node HTTPS serializes the workspace POST correctly with an in-memory socket and no network', async t => {
  const hostname = 'synthetic-workspace.cn-beijing.maas.aliyuncs.com';
  const pathname = '/api/v1/services/aigc/multimodal-generation/generation';
  const body = Buffer.from(JSON.stringify({ synthetic: '仅用于本地传输验证' }));
  let written = Buffer.alloc(0), capturedOptions, socketCreations = 0, resolutions = 0, answered = false;
  // Keep https.request and Node's HTTP serializer real. Replace only its socket
  // factory, and reject any accidental attempt to establish a real connection.
  // Node's test runner isolates this file; mocks are restored after this test.
  t.mock.method(net.Socket.prototype, 'connect', () => { throw new Error('TEST_NETWORK_FORBIDDEN'); });
  t.mock.method(https.Agent.prototype, 'createConnection', function (options) {
    socketCreations++; capturedOptions = options;
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) {
      written = Buffer.concat([written, Buffer.from(chunk)]); callback();
      const separator = written.indexOf('\r\n\r\n');
      if (!answered && separator >= 0 && written.length >= separator + 4 + body.length) {
        answered = true;
        queueMicrotask(() => this.push('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'));
      }
    } });
    socket.setNoDelay = () => socket; socket.setKeepAlive = () => socket; socket.setTimeout = () => socket;
    return socket;
  });
  const transport = createPhotoHttpsTransport({ resolve: async (host, options) => {
    resolutions++; assert.equal(host, hostname); assert.deepEqual(options, { all: true, family: 4, verbatim: true });
    return [{ address: '8.8.8.8', family: 4 }];
  } });
  const result = await transport({ url: `https://${hostname}${pathname}`, allowedHosts: [hostname], method: 'POST', body,
    headers: { Authorization: 'Bearer synthetic-key-only', 'Content-Type': 'application/json' }, timeoutMs: 1000, maxBytes: 1024 });
  const separator = written.indexOf('\r\n\r\n');
  const [requestLine, ...headerLines] = written.subarray(0, separator).toString().split('\r\n');
  const headers = Object.fromEntries(headerLines.map(line => {
    const colon = line.indexOf(':'); return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
  }));
  assert.equal(requestLine, `POST ${pathname} HTTP/1.1`);
  assert.equal(headers.host, hostname); assert.equal(headers['content-type'], 'application/json');
  assert.equal(headers.authorization, 'Bearer synthetic-key-only'); assert.equal(headers['accept-encoding'], 'identity');
  assert.equal(headers['content-length'], String(body.length)); assert.equal(headers['transfer-encoding'], undefined);
  assert.deepEqual(written.subarray(separator + 4), body);
  assert.equal(capturedOptions.host, hostname); assert.equal(capturedOptions.servername, hostname);
  assert.equal(capturedOptions.port, 443); assert.equal(capturedOptions.rejectUnauthorized, true);
  assert.equal(capturedOptions.family, 4); assert.equal(socketCreations, 1); assert.equal(resolutions, 1);
  for (const all of [false, true]) {
    const values = await new Promise(resolve => capturedOptions.lookup(hostname, { all }, (...args) => resolve(args)));
    assert.deepEqual(values, all ? [null, [{ address: '8.8.8.8', family: 4 }]] : [null, '8.8.8.8', 4]);
  }
  assert.equal(result.status, 200); assert.equal(result.bytes.toString(), '{}');
});

test('private, mixed and unsupported DNS destinations fail before a socket is created', async () => {
  for (const address of ['PRIVATE_IP', '127.0.0.1', '169.254.169.254', 'PRIVATE_IP', 'PRIVATE_IP', '100.64.0.1',
    '198.18.0.1', '203.0.113.1', '224.0.0.1', '::1']) {
    const f = wire({ addresses: [{ address: '8.8.8.8', family: 4 }, { address, family: address === '::1' ? 6 : 4 }] });
    await assert.rejects(f.send(), /DNS_REJECTED/); assert.equal(f.calls.length, 0);
  }
});

test('redirects, encoding and unbounded/truncated bodies fail without following another URL', async () => {
  for (const config of [{ status: 302, headers: { location: 'http://127.0.0.1/' } },
    { headers: { 'content-encoding': 'gzip' } }, { declaredLength: 101 },
    { chunks: [Buffer.alloc(60), Buffer.alloc(60)] }, { declaredLength: 99 }]) {
    const f = wire(config); await assert.rejects(f.send(), /PHOTO_PROVIDER_/); assert.equal(f.calls.length, 1);
  }
});

test('total deadline covers DNS and socket hangs without retrying', async () => {
  const f = wire({ hold: true }); await assert.rejects(f.send({ timeoutMs: 15 }), /TIMEOUT/); assert.equal(f.calls.length, 1);
  let release; const g = wire({ resolve: () => new Promise(resolve => { release = resolve; }) });
  await assert.rejects(g.send({ timeoutMs: 15 }), /TIMEOUT/);
  release([{ address: '8.8.8.8', family: 4 }]); await new Promise(resolve => setImmediate(resolve));
  assert.equal(g.calls.length, 0);
});

const diagnosticId = '649b2bbc-c541-9e16-9845-db7fe4fe5b2d';
test('bounded non-200 JSON preserves only official code and UUID without enabling any retry', async () => {
  for (const [status, code] of [[401, 'InvalidApiKey'], [403, 'AccessDenied.Unpurchased'], [429, 'Throttling.AllocationQuota'],
    [500, 'InternalError'], [503, 'ServiceUnavailable']]) {
    const bytes = Buffer.from(JSON.stringify({ code, request_id: diagnosticId, message: 'private prompt synthetic-key-only',
      url: resultUrl, input: { image: input().bytes.toString('base64') }, nested: { code: 'other private data' } }));
    const f = wire({ status, chunks: [bytes], declaredLength: bytes.length });
    const provider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: f.transport });
    await assert.rejects(provider.generate({ input: input(), spec: spec() }), error => {
      assert.equal(error.code, 'PHOTO_PROVIDER_OUTCOME_UNCONFIRMED');
      assert.deepEqual(getPhotoProviderDiagnostic(error), { version: 1, operation: 'generate', stage: 'response_body',
        httpStatus: status, providerCode: code, requestId: diagnosticId, outcome: 'unknown', retryAllowed: false });
      assert.deepEqual(Object.keys(error).sort(), ['code', 'diagnostic']);
      assert.doesNotMatch(JSON.stringify(error), /private|synthetic-key|Expires|Signature|image|prompt|nested/);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('fixed provider messages yield only finite reported classes and never permit replay', async () => {
  for (const [message, providerMessageClass] of [
    ['Model not exist.', 'model_not_found'], ['Model can not be found.', 'model_not_found'],
    ['WorkSpace can not be found.', 'workspace_not_found'], ['Request path not found.', 'request_path_not_found'],
  ]) {
    const f = wire({ status: 404, chunks: [Buffer.from(JSON.stringify({ code: 'InvalidParameter', message,
      request_id: diagnosticId, private: 'synthetic-key-only', url: resultUrl }))] });
    const provider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: f.transport });
    await assert.rejects(provider.generate({ input: input(), spec: spec() }), error => {
      assert.deepEqual(getPhotoProviderDiagnostic(error), { version: 1, operation: 'generate', stage: 'response_body',
        httpStatus: 404, providerCode: 'InvalidParameter', providerMessageClass, requestId: diagnosticId,
        outcome: 'unknown', retryAllowed: false });
      assert.equal(JSON.stringify(error).includes(message), false);
      assert.doesNotMatch(JSON.stringify(error), /synthetic-key|https:|Signature|"message":|"private":/);
      return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('message classification requires the complete exact string and a verified bounded JSON body', async () => {
  for (const message of [' Model not exist.', 'Model not exist.\n', 'model not exist.',
    'Model not exist. synthetic-key-only', 'Request path not found. https://private.invalid',
    'The model synthetic-private-model does not exist.', { toString: 'Model not exist.' },
    ['Model not exist.'], null]) {
    const f = wire({ status: 404, chunks: [Buffer.from(JSON.stringify({ message,
      providerMessageClass: 'model_not_found' }))] });
    await assert.rejects(f.send({ maxBytes: 16384 }), error => {
      const d = getPhotoProviderDiagnostic(error); assert.equal(d.providerMessageClass, undefined);
      assert.equal(d.outcome, 'unknown'); assert.equal(d.retryAllowed, false);
      assert.doesNotMatch(JSON.stringify(error), /synthetic-key|private|Model not exist|https:|"message":/); return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const bytes = Buffer.from(JSON.stringify({ message: 'Request path not found.' }));
  for (const headers of [{ 'content-type': 'text/html' }, { 'content-encoding': 'gzip' }]) {
    const f = wire({ status: 404, headers, chunks: [bytes] });
    await assert.rejects(f.send(), error => {
      assert.deepEqual(getPhotoProviderDiagnostic(error), { version: 1, operation: 'transport', stage: 'response_headers',
        httpStatus: 404, outcome: 'unknown', retryAllowed: false }); return true;
    });
    assert.equal(f.calls.length, 1);
  }
  const d = getPhotoProviderDiagnostic({ diagnostic: { version: 1, operation: 'generate', stage: 'response_body',
    providerMessageClass: 'private diagnostic', message: 'Model not exist.', outcome: 'not_started', retryAllowed: true } });
  assert.deepEqual(d, { version: 1, operation: 'generate', stage: 'response_body', outcome: 'unknown', retryAllowed: false });
});

test('unknown codes, unsafe request IDs and extra diagnostic fields cannot be copied into operational evidence', async () => {
  for (const value of [
    { code: 'private_account_1234', request_id: 'synthetic-key-only', message: resultUrl },
    { code: 'InvalidApiKey https://private.invalid', request_id: resultUrl },
    { code: 'AccessDenied', request_id: `${diagnosticId}\nprivate` },
    { error: { code: 'InvalidApiKey' }, request_id: { secret: 'synthetic-key-only' } },
    [{ code: 'InvalidApiKey', request_id: diagnosticId }],
  ]) {
    const f = wire({ status: 401, chunks: [Buffer.from(JSON.stringify(value))] });
    await assert.rejects(f.send({ maxBytes: 16384 }), error => {
      const d = getPhotoProviderDiagnostic(error); assert.equal(d.httpStatus, 401);
      assert.equal(d.requestId, undefined); assert.equal(d.providerCode, value.code === 'AccessDenied' ? 'AccessDenied' : undefined);
      assert.doesNotMatch(JSON.stringify(d), /private|synthetic-key|https|message|secret/); return true;
    });
    assert.equal(f.calls.length, 1);
  }
  assert.equal(getPhotoProviderDiagnostic(new Error('private upstream text')), null);
  assert.deepEqual(getPhotoProviderDiagnostic({ diagnostic: { version: 1, operation: 'generate', stage: 'transport',
    httpStatus: '401', providerCode: 'arbitrary', requestId: 'not-a-uuid', body: 'private', prompt: 'private',
    outcome: 'not_started', retryAllowed: true } }), {
    version: 1, operation: 'generate', stage: 'transport', outcome: 'unknown', retryAllowed: false,
  });
  let reads = 0;
  const changing = { version: 1, operation: 'generate', stage: 'transport',
    get requestId() { return ++reads === 1 ? diagnosticId : 'private-secret'; } };
  assert.equal(getPhotoProviderDiagnostic({ diagnostic: changing }).requestId, diagnosticId);
  assert.equal(reads, 1);
  assert.equal(getPhotoProviderDiagnostic({ get diagnostic() { throw new Error('private getter'); } }), null);
});

test('non-JSON, invalid, compressed, truncated or oversized failures retain status but no body or unverified fields', async () => {
  const body = Buffer.from(JSON.stringify({ code: 'InvalidApiKey', request_id: diagnosticId, message: 'private content' }));
  const configurations = [
    { headers: { 'content-type': 'text/html' }, chunks: [body] },
    { headers: { 'content-encoding': 'gzip' }, chunks: [body] },
    { chunks: [Buffer.from('private invalid JSON')] },
    { chunks: [Buffer.concat([Buffer.from('{"code":"InvalidApiKey","message":"'), Buffer.from([255]), Buffer.from('"}')])] },
    { chunks: [body], declaredLength: body.length + 1 },
    { chunks: [body], declaredLength: 16385 },
    { chunks: [Buffer.alloc(8192), Buffer.alloc(8193)] },
  ];
  for (const config of configurations) {
    const f = wire({ status: 503, ...config });
    await assert.rejects(f.send({ maxBytes: 1024 * 1024 }), error => {
      const d = getPhotoProviderDiagnostic(error); assert.equal(d.httpStatus, 503);
      assert.equal(d.providerCode, undefined); assert.equal(d.requestId, undefined); assert.equal(d.retryAllowed, false);
      assert.doesNotMatch(JSON.stringify(error), /private|InvalidApiKey|649b2bbc|"body":|"message":/); return true;
    });
    assert.equal(f.calls.length, 1);
  }
});

test('diagnostics distinguish malformed 200, rejected result URL and post-dispatch timeout without replay', async () => {
  const malformed = fixture(() => ({ status: 200, contentType: 'application/json', bytes: Buffer.from('private not JSON') }));
  await assert.rejects(malformed.provider.generate({ input: input(), spec: spec() }), error => {
    assert.equal(getPhotoProviderDiagnostic(error).stage, 'response_json'); assert.equal(getPhotoProviderDiagnostic(error).httpStatus, 200); return true;
  });
  const wrongUrl = receipt(); wrongUrl.request_id = diagnosticId; wrongUrl.output.choices[0].message.content[0].image = 'https://private.invalid/x?key=secret';
  const rejected = fixture(() => response(wrongUrl));
  await assert.rejects(rejected.provider.generate({ input: input(), spec: spec() }), error => {
    assert.deepEqual(getPhotoProviderDiagnostic(error), { version: 1, operation: 'generate', stage: 'result_url',
      httpStatus: 200, requestId: diagnosticId, outcome: 'unknown', retryAllowed: false });
    assert.doesNotMatch(JSON.stringify(error), /private|secret|https/); return true;
  });
  const f = wire({ hold: true }); const provider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: f.transport, timeoutMs: 15 });
  await assert.rejects(provider.generate({ input: input(), spec: spec() }), error => {
    assert.deepEqual(getPhotoProviderDiagnostic(error), { version: 1, operation: 'generate', stage: 'request', outcome: 'unknown', retryAllowed: false }); return true;
  });
  assert.equal(f.calls.length, 1); assert.equal(malformed.calls.length, 1); assert.equal(rejected.calls.length, 1);
});

test('download diagnostics never carry the signed source URL or credentials', async () => {
  const f = wire({ status: 403, headers: { 'content-type': 'application/xml' }, chunks: [Buffer.from(resultUrl)] });
  const provider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: f.transport });
  await assert.rejects(provider.readGenerated({ url: resultUrl }), error => {
    assert.deepEqual(getPhotoProviderDiagnostic(error), { version: 1, operation: 'download', stage: 'response_headers',
      httpStatus: 403, outcome: 'unknown', retryAllowed: false });
    assert.doesNotMatch(JSON.stringify(error), /Signature|Expires|synthetic-key|https/); return true;
  });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options.headers.Authorization, undefined);
});

test('documented dynamic result host forms pass the API receipt and pin downloads to one exact host', async () => {
  assert.equal(QWEN_PHOTO_RESULT_POLICY, 'qwen-dashscope-result-url-v1');
  for (const host of [...QWEN_PHOTO_RESULT_HOSTS, 'dashscope-a717.oss-accelerate.aliyuncs.com',
    'dashscope-66f3.oss-cn-beijing.aliyuncs.com', 'dashscope-7c2c.oss-cn-hangzhou.aliyuncs.com',
    `dashscope-${'a'.repeat(53)}.oss-cn-shanghai.aliyuncs.com`]) {
    const url = `https://${host}/synthetic.png?Expires=2000000000&Signature=REDACTED_SECRET
    const value = receipt(); value.output.choices[0].message.content[0].image = url;
    const f = fixture(request => request.method === 'POST' ? response(value)
      : { status: 200, contentType: 'image/png', bytes: png });
    const saved = await f.provider.generate({ input: input(), spec: spec() });
    const output = await f.provider.readGenerated(saved);
    assert.equal(saved.url, url); assert.equal(output.sha256, sha(png));
    assert.deepEqual(f.calls.map(call => call.method), ['POST', 'GET']);
    assert.deepEqual(f.calls[1].allowedHosts, [host]);
    assert.equal(f.calls[1].headers.Authorization, undefined);
    assert.equal(checkedQwenPhotoResultUrl(url).hostname, host);
  }
});

test('dynamic host policy rejects lookalikes, ordinary customer OSS and non-public endpoint spellings before downloading', async () => {
  const urls = [
    'https://customer-bucket.oss-cn-beijing.aliyuncs.com/x.png',
    'https://dashscope-attacker.evil.invalid/x.png',
    'https://dashscope-attacker.oss-cn-beijing.aliyuncs.com.evil.invalid/x.png',
    'https://dashscope-attacker.evil.oss-cn-beijing.aliyuncs.com/x.png',
    'https://evil-dashscope-a717.oss-cn-beijing.aliyuncs.com/x.png',
    'https://dashscope-.oss-cn-beijing.aliyuncs.com/x.png',
    'https://dashscope-a717-.oss-cn-beijing.aliyuncs.com/x.png',
    `https://dashscope-${'a'.repeat(54)}.oss-cn-beijing.aliyuncs.com/x.png`,
    'https://dashscope-a717.oss-cn-beijing-internal.aliyuncs.com/x.png',
    'https://dashscope-a717.oss-cn-internal.aliyuncs.com/x.png',
    'https://dashscope-a717.oss-accelerate-internal.aliyuncs.com/x.png',
    'https://dashscope-a717.oss-accelerate.dualstack.aliyuncs.com/x.png',
    'https://dashscope-a717.oss-website-cn-beijing.aliyuncs.com/x.png',
    'https://dashscope-a717.oss-us-west-1.aliyuncs.com/x.png',
    'https://dashscope-a717.oss-cn-beijing.aliyuncs.com./x.png',
    'https://dashscope-a717.oss-cn-beijing.aliyuncs.com:443/x.png',
    'https://dashscope-a717.oss-cn-beijing.aliyuncs.com:444/x.png',
    'https://dashscope-a717.oss-cn-beijing.aliyuncs.com@127.0.0.1/x.png',
    'https://REDACTED_USER:REDACTED_PASSWORD@dashscope-a717.oss-cn-beijing.aliyuncs.com/x.png',
    'https://%64ashscope-a717.oss-cn-beijing.aliyuncs.com/x.png',
    'https://dashscope-a717。oss-cn-beijing.aliyuncs.com/x.png',
    'https://dashscope-a717.oss-cn-beijing.aliyuncs.com\\@evil.invalid/x.png',
    'https://dashscope-a717.oss-cn-beijing.aliyuncs.com/x.png#fragment',
    'http://dashscope-a717.oss-cn-beijing.aliyuncs.com/x.png',
    'https://127.0.0.1/x.png',
  ];
  for (const url of urls) {
    assert.throws(() => checkedQwenPhotoResultUrl(url), /URL_REJECTED/);
    const f = fixture();
    await assert.rejects(f.provider.readGenerated({ url }), /URL_REJECTED/);
    assert.equal(f.calls.length, 0);
    const value = receipt(); value.output.choices[0].message.content[0].image = url;
    const p = fixture(() => response(value));
    await assert.rejects(p.provider.generate({ input: input(), spec: spec() }), /URL_REJECTED/);
    assert.equal(p.calls.length, 1);
  }
});

test('an allowed-looking dynamic host still cannot reach private DNS or follow a redirect', async () => {
  const url = 'https://dashscope-a717.oss-accelerate.aliyuncs.com/synthetic.png';
  const f = wire({ addresses: [{ address: '169.254.169.254', family: 4 }] });
  const privateProvider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: f.transport });
  await assert.rejects(privateProvider.readGenerated({ url }), error => {
    assert.equal(getPhotoProviderDiagnostic(error).stage, 'dns'); return true;
  });
  assert.equal(f.calls.length, 0); assert.equal(f.lookupCount(), 1);
  const g = wire({ status: 302, headers: { 'content-type': 'image/png',
    location: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/other.png' } });
  const redirected = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: g.transport });
  await assert.rejects(redirected.readGenerated({ url }), error => {
    assert.equal(getPhotoProviderDiagnostic(error).httpStatus, 302); return true;
  });
  assert.equal(g.calls.length, 1); assert.equal(g.lookupCount(), 1);
  assert.equal(g.calls[0].options.servername, new URL(url).hostname);
  assert.equal(g.calls[0].options.rejectUnauthorized, true);
  const pin = await new Promise(resolve => g.calls[0].options.lookup(new URL(url).hostname, {}, (...args) => resolve(args)));
  assert.deepEqual(pin, [null, '8.8.8.8', 4]);
});
