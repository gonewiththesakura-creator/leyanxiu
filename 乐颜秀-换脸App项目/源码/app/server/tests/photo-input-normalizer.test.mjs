import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { Hono } from 'hono';
import { createPhotoInputNormalizer } from '../photo-jobs/input-normalizer.js';
import { createPhotoUploadService, createPhotoUploadWorker } from '../photo-jobs/upload-service.js';
import { registerPhotoUploadRoutes } from '../photo-jobs/upload-routes.js';
import { createPhotoImageModerator } from '../photo-jobs/moderation.js';
import { createQwenPhotoProvider, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_MODEL, QWEN_PHOTO_RESULT_HOSTS } from '../photo-jobs/qwen-provider.js';

const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
const script = fileURLToPath(new URL('../normalize-photo-input.py', import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const dataUri = (bytes, type = 'image/png') => `data:${type};base64,${bytes.toString('base64')}`;
// All fixtures contain generated shapes/noise only. No user images, credentials,
// network, dependencies installed or chargeable moderation/generation calls.
const fixtures = JSON.parse(execFileSync(python, ['-c', `
import base64,io,json,random
from PIL import Image,ImageCms,PngImagePlugin,TiffImagePlugin
def encoded(im,format,**options):
 b=io.BytesIO();im.save(b,format=format,**options);return base64.b64encode(b.getvalue()).decode()
e=Image.Exif();e[274]=6;e[271]='SYNTHETIC_CAMERA_CANARY';e[37510]=b'SYNTHETIC_COMMENT_CANARY'
e[34853]={1:'N',2:tuple(TiffImagePlugin.IFDRational(x,1) for x in (1,2,3)),3:'E',4:tuple(TiffImagePlugin.IFDRational(x,1) for x in (4,5,6))}
im=Image.new('RGB',(32,24),(10,30,60))
for x in range(16):
 for y in range(24):im.putpixel((x,y),(230,30,20))
rgba=Image.new('RGBA',(6,4),(80,100,120,64));rgba.putpixel((0,0),(10,20,30,0))
text=PngImagePlugin.PngInfo();text.add_text('XML:com.adobe.xmp','SYNTHETIC_XMP_LOCATION_CANARY');text.add_text('Comment','SYNTHETIC_TEXT_CANARY')
palette=Image.new('P',(6,4));palette.putpalette([80,100,120]+[0,0,0]*255)
animated=Image.new('RGB',(6,4),'red')
noise=Image.frombytes('RGB',(1400,1400),random.Random(17).randbytes(1400*1400*3))
gamma=PngImagePlugin.PngInfo();gamma.add(b'gAMA',(100000).to_bytes(4,'big'))
print(json.dumps({
 'jpeg':encoded(im,'JPEG',exif=e,quality=95,subsampling=0),
 'alpha':encoded(rgba,'PNG',exif=e,pnginfo=text,icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile('sRGB')).tobytes()),
 'palette':encoded(palette,'PNG',transparency=bytes([64]+[255]*255)),
 'webp':encoded(rgba,'WEBP',lossless=True,exif=e,xmp=b'SYNTHETIC_XMP_LOCATION_CANARY'),
 'plain':encoded(Image.new('RGB',(1,1),(80,100,120)),'PNG'),
 'badIcc':encoded(im,'PNG',icc_profile=b'SYNTHETIC_INVALID_ICC'),
 'cmyk':encoded(im.convert('CMYK'),'JPEG'),
 'gamma':encoded(im,'PNG',pnginfo=gamma),
 'animated':encoded(animated,'PNG',save_all=True,append_images=[Image.new('RGB',(6,4),'blue')],duration=100,loop=0),
 'expandedJpeg':encoded(noise,'JPEG',quality=60)
}))`], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }));
const fixture = name => Buffer.from(fixtures[name], 'base64');
const inspect = bytes => JSON.parse(execFileSync(python, ['-c', `
import io,json,sys
from PIL import Image
im=Image.open(io.BytesIO(sys.stdin.buffer.read()));im.load();e=im.getexif()
print(json.dumps({'format':im.format,'size':im.size,'mode':im.mode,'info':list(im.info),'exifCount':len(e),'gpsPresent':bool(e.get_ifd(34853)),'corners':[im.convert('RGBA').getpixel(p) for p in ((0,0),(im.width-1,0),(0,im.height-1),(im.width-1,im.height-1))]}))
`], { input: bytes, encoding: 'utf8' }));
function serviceFixture(inputNormalizer = createPhotoInputNormalizer({ python })) {
  const counts = { intent: 0, put: 0, confirm: 0 };
  let saved, intent;
  const repository = {
    async preflight() { return { existing: false, consentEpoch: 1 }; },
    async submitIntent(value) { counts.intent++; intent = value; return { duplicate: false, storageKey: 'synthetic-input', upload: { id: 'synthetic-upload' } }; },
    async confirmStored(_id, value) { counts.confirm++; assert.equal(value.sha256, intent.sha256); },
    async readOwned() { return { id: 'synthetic-upload', state: 'queued' }; },
    async findOwnedByKey() { return null; },
  };
  const storage = {
    async put(_key, bytes, options) { counts.put++; saved = { found: true, bytes: Buffer.from(bytes), contentType: options.contentType, byteLength: bytes.length, sha256: sha(bytes) }; },
    async read() { return saved; },
  };
  const service = createPhotoUploadService({ repository, storage, inputNormalizer });
  return { counts, repository, storage, service, saved: () => saved, intent: () => intent,
    submit: (bytes, type = 'image/png') => service.submit({ userId: 'synthetic-user', idempotencyKey: '1'.repeat(32), image: dataUri(bytes, type) }) };
}

test('real Pillow removes GPS/camera/text before intent and binds the same clean bytes through moderation and Qwen', async () => {
  const f = serviceFixture(); const original = fixture('jpeg');
  assert.equal(inspect(original).gpsPresent, true);
  await f.submit(original, 'image/jpeg');
  const source = f.saved(), view = inspect(source.bytes);
  assert.deepEqual(f.counts, { intent: 1, put: 1, confirm: 1 });
  assert.notEqual(source.sha256, sha(original)); assert.equal(f.intent().sha256, source.sha256);
  assert.equal(f.intent().byteLength, source.bytes.length); assert.equal(f.intent().contentType, 'image/jpeg');
  assert.deepEqual(view.size, [24, 32]); assert.equal(view.exifCount, 0); assert.equal(view.gpsPresent, false);
  assert.ok(view.corners[0][0] > 200 && view.corners[2][0] < 40, 'orientation is applied to pixels, not merely removed');
  assert.equal(source.bytes.includes(Buffer.from('SYNTHETIC_')), false);
  let reviewed, receipt, sent;
  const moderator = createPhotoImageModerator({ policy: { approved: true, version: 'test-policy-v1', region: 'cn-shanghai',
    services: { input: 'baselineCheck', output: 'aigcCheck' }, lowRisk: 'review', timeoutMs: 100 }, storage: {
    async put(_key, bytes) { reviewed = Buffer.from(bytes); }, async delete() {},
    signedUrl() { return 'https://synthetic.oss-cn-shanghai.aliyuncs.com/image.jpeg?Signature=REDACTED_SECRET },
  }, transport: async request => ({ statusCode: 200, body: { Code: 200, RequestId: 'synthetic-request',
    Data: { DataId: request.serviceParameters.dataId, RiskLevel: 'none', Result: [{ Label: 'nonLabel' }] } } }) });
  await createPhotoUploadWorker({ storage: f.storage, moderator, repository: {
    publishNext: async () => null, nextStaging: async () => null,
    claimNext: async () => ({ id: 'synthetic-upload', user_id: 'synthetic-user', storage_key: 'synthetic-input',
      sha256: source.sha256, byte_length: source.byteLength, content_type: source.contentType }),
    recordModerationIntent: async () => true, recordReview: async (_id, value) => { receipt = value; }, readOwned: async () => ({}),
  } }).runOnce();
  assert.deepEqual(reviewed, source.bytes); assert.equal(receipt.sha256, source.sha256); assert.equal(receipt.decision, 'allow');
  const provider = createQwenPhotoProvider({ apiKey: 'synthetic-key-only', transport: async request => {
    sent = Buffer.from(JSON.parse(request.body).input.messages[0].content[0].image.split(',')[1], 'base64');
    return { status: 200, contentType: 'application/json', bytes: Buffer.from(JSON.stringify({ request_id: 'synthetic-request',
      output: { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: [{ image: `https://${QWEN_PHOTO_RESULT_HOSTS[0]}/synthetic.png` }] } }] },
      usage: { image_count: 1, width: 1024, height: 1024 } })) };
  } });
  await provider.generate({ input: source, spec: { provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL,
    effectParameters: { prompt: 'synthetic shape', negativePrompt: '', n: 1, watermark: true, promptExtend: false, size: '1024*1024' } } });
  assert.deepEqual(sent, source.bytes); assert.equal(inspect(sent).exifCount, 0);
  const repeated = await createPhotoInputNormalizer({ python }).normalize(dataUri(original, 'image/jpeg'));
  assert.deepEqual(repeated, { bytes: source.bytes, byteLength: source.byteLength, sha256: source.sha256, contentType: source.contentType });
});

test('real ICC-to-sRGB conversion preserves alpha; PNG palette and WebP become pixel-only transparent PNG', async () => {
  for (const name of ['alpha', 'palette', 'webp']) {
    const original = fixture(name), type = name === 'webp' ? 'image/webp' : 'image/png';
    const value = await createPhotoInputNormalizer({ python }).normalize(dataUri(original, type));
    const checked = inspect(value.bytes);
    assert.equal(value.contentType, 'image/png'); assert.equal(checked.mode, 'RGBA');
    assert.deepEqual(checked.info, []); assert.equal(checked.exifCount, 0); assert.equal(checked.gpsPresent, false);
    assert.equal(value.bytes.includes(Buffer.from('SYNTHETIC_')), false);
    assert.deepEqual(checked.size, name === 'palette' ? [6, 4] : [4, 6]);
    assert.ok(checked.corners.some(pixel => pixel[3] === 64));
    if (name !== 'palette') assert.ok(checked.corners.some(pixel => pixel[3] === 0));
    for (const pixel of checked.corners.filter(value => value[3] === 64)) assert.deepEqual(pixel, [80, 100, 120, 64]);
  }
});

test('invalid, truncated, animated, unsupported color, oversized and bomb images make no intent or object writes', async t => {
  const header = (width, height) => { const bytes = fixture('plain'); bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20);
    bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29); return bytes; };
  const badCrc = fixture('plain'); badCrc[45] ^= 1;
  const cases = [
    ['crc', badCrc], ['truncated', fixture('plain').subarray(0, -10)], ['animated', fixture('animated')],
    ['invalidICC', fixture('badIcc')], ['unknownCMYK', fixture('cmyk'), 'image/jpeg'], ['nonSrgbGamma', fixture('gamma')],
    ['byteLimit', Buffer.concat([fixture('plain'), Buffer.alloc(2 * 1024 * 1024)])],
    ['sideLimit', header(8193, 1)], ['pixelBomb', header(8192, 6000)], ['decompressionBomb', header(10000, 10000)],
    ['encodedOutputLimit', fixture('expandedJpeg'), 'image/jpeg'],
  ];
  for (const [name, bytes, type = 'image/png'] of cases) await t.test(name, async () => {
    const f = serviceFixture(); await assert.rejects(f.submit(bytes, type), { code: 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE' });
    assert.deepEqual(f.counts, { intent: 0, put: 0, confirm: 0 });
  });
  for (const bytes of [header(8192, 6000), header(10000, 10000), badCrc]) {
    const result = spawnSync(python, [script, '--stdio'], { input: bytes });
    assert.equal(result.status, 2); assert.equal(result.stdout.length, 0); assert.equal(result.stderr.length, 0);
  }
});

test('a pre-normalization old intent is neither rewritten nor uploaded again', async () => {
  const raw = fixture('jpeg'); const f = serviceFixture();
  const oldObject = Buffer.from(raw), oldIntent = { sha256: sha(raw), byteLength: raw.length, contentType: 'image/jpeg' };
  f.repository.submitIntent = async clean => {
    assert.notEqual(clean.sha256, oldIntent.sha256);
    throw Object.assign(new Error('PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT'), { code: 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT' });
  };
  await assert.rejects(f.submit(raw, 'image/jpeg'), { code: 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(oldObject, raw); assert.equal(oldIntent.sha256, sha(raw)); assert.equal(f.counts.put, 0);
});

test('process environment is isolated and successful exit is required before any intent', async () => {
  let invocation;
  const normalizer = createPhotoInputNormalizer({ python, spawnProcess: (...args) => { invocation = args; return spawn(...args); } });
  await serviceFixture(normalizer).submit(fixture('plain'));
  assert.deepEqual(invocation[1].slice(1), ['--stdio']); assert.deepEqual(invocation[2].stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(invocation[2].windowsHide, true);
  assert.ok(Object.keys(invocation[2].env).every(name => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'PYTHONIOENCODING'].includes(name)));
  const unavailable = createPhotoInputNormalizer({ python: 'synthetic-nonexistent-python-program' });
  const f = serviceFixture(unavailable);
  await assert.rejects(f.submit(fixture('plain')), { code: 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE' });
  assert.deepEqual(f.counts, { intent: 0, put: 0, confirm: 0 });
});

function childFixture() {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kills = 0; child.kill = signal => { assert.equal(signal, 'SIGKILL'); child.kills++; queueMicrotask(() => child.emit('close', null)); };
  return child;
}
test('bounded timeout/stdout/stderr kill and await the child; safe errors do not expose metadata', async () => {
  for (const mode of ['timeout', 'stdout', 'stderr']) {
    let child;
    const normalizer = createPhotoInputNormalizer({ python, timeoutMs: 20, spawnProcess: () => {
      child = childFixture();
      if (mode !== 'timeout') queueMicrotask(() => child[mode].write(Buffer.alloc(mode === 'stdout' ? 2 * 1024 * 1024 + 1 : 4097, 65)));
      return child;
    } });
    const f = serviceFixture(normalizer);
    await assert.rejects(f.submit(fixture('plain')), error => {
      assert.equal(error.code, 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE');
      assert.doesNotMatch(String(error), /Traceback|SYNTHETIC_|AAAA/); return true;
    });
    assert.equal(child.kills, 1); assert.deepEqual(f.counts, { intent: 0, put: 0, confirm: 0 });
  }
});

test('one active child plus three queued inputs is the limit before parsing and queued timeouts recover capacity', async () => {
  let spawned = 0;
  const normalizer = createPhotoInputNormalizer({ python, timeoutMs: 20, spawnProcess: () => { spawned++; return childFixture(); } });
  const pending = Array.from({ length: 4 }, () => normalizer.normalize(dataUri(fixture('plain'))));
  // Invalid input would yield INVALID_REQUEST if parsing happened before admission.
  await assert.rejects(normalizer.normalize('invalid-and-must-not-be-parsed'), { code: 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE' });
  assert.equal(spawned, 1);
  assert.ok((await Promise.allSettled(pending)).every(result => result.status === 'rejected' && result.reason.code === 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE'));
  await assert.rejects(normalizer.normalize(dataUri(fixture('plain'))), { code: 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE' });
  assert.ok(spawned >= 2, 'queue and active state recover after termination');
});

test('HTTP preprocessing errors preserve recovery because a same-key caller may already have committed', async () => {
  const f = serviceFixture(createPhotoInputNormalizer({ python: 'synthetic-nonexistent-python-program' }));
  const app = new Hono(); registerPhotoUploadRoutes(app, { service: f.service,
    authenticated: async () => ({ auth: { authMethod: 'wechat', userId: 'synthetic-user' } }), readiness: async () => ({ ready: true }) });
  const response = await app.request('/api/mini/photo-uploads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '1'.repeat(32) },
    body: JSON.stringify({ image: dataUri(fixture('plain')) }) });
  assert.equal(response.status, 503); const body = await response.json();
  assert.equal(body.code, 'PHOTO_UPLOAD_PREPROCESS_UNAVAILABLE'); assert.match(body.message, /查询原上传状态/); assert.doesNotMatch(body.message, /未创建/);
  assert.deepEqual(f.counts, { intent: 0, put: 0, confirm: 0 });
  f.repository.preflight = async () => ({ existing: true });
  const existing = await app.request('/api/mini/photo-uploads', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': '1'.repeat(32) },
    body: JSON.stringify({ image: dataUri(fixture('plain')) }) });
  assert.equal(existing.status, 409); assert.equal((await existing.json()).code, 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT');
  await assert.rejects(f.submit(Buffer.from('invalid-image')), { code: 'PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT' });
  assert.deepEqual(f.counts, { intent: 0, put: 0, confirm: 0 });
});
