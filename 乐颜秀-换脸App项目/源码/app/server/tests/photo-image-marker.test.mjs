import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createPhotoImageMarker } from '../photo-jobs/image-marker.js';

const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
const png = execFileSync(python, ['-c', 'import sys; from PIL import Image; Image.new("RGB", (512,512), (80,100,120)).save(sys.stdout.buffer, format="PNG")']);
const sha = value => createHash('sha256').update(value).digest('hex');
const input = bytes => ({ bytes: Buffer.from(bytes || png), byteLength: (bytes || png).length, sha256: sha(bytes || png),
  contentType: 'image/png', contentId: 'synthetic_job_1', operation: 'edit', labelVersion: 'label_v1' });
const config = { python, serviceProviderCode: 'synthetic-provider-only', labelVersion: 'label_v1' };

test('real Pillow pipe marks visible pixels and exact XMP without a temporary image path', async () => {
  let invocation;
  const marker = createPhotoImageMarker({ ...config, spawnProcess: (...args) => { invocation = args; return spawn(...args); } });
  const value = input(); const pending = marker.mark(value); value.bytes.fill(0); value.contentId = 'mutated';
  const result = await pending;
  assert.equal(result.verified, true); assert.equal(result.conformanceVerified, false);
  assert.equal(result.contentId, 'synthetic_job_1'); assert.equal(result.operation, 'edit');
  assert.notEqual(result.sha256, sha(png)); assert.equal(result.sha256, sha(result.bytes));
  assert.equal(result.byteLength, result.bytes.length);
  assert.deepEqual(invocation[1].slice(1), ['--stdio', '--content-id', 'synthetic_job_1',
    '--service-provider', config.serviceProviderCode, '--operation', 'edit']);
  assert.deepEqual(invocation[2].stdio, ['pipe', 'pipe', 'pipe']); assert.equal(invocation[2].windowsHide, true);
  assert.ok(Object.keys(invocation[2].env).every(name => ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL', 'PYTHONIOENCODING'].includes(name)));
  const checked = JSON.parse(execFileSync(python, ['-c',
    'import io,json,sys,xml.etree.ElementTree as E; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); im.load(); root=E.fromstring(im.info["XML:com.adobe.xmp"]); nodes=root.findall(".//{http://www.tc260.org.cn/ns/AIGC/1.0}AIGC"); print(json.dumps({"size":im.size,"metadata":json.loads(nodes[0].text),"nodeCount":len(nodes),"operation":im.info["AI_Operation"],"changedPixels":sum(1 for p in im.convert("RGB").getdata() if p!=(80,100,120)),"topLeft":im.getpixel((0,0))}))'],
    { input: result.bytes, encoding: 'utf8' }));
  assert.deepEqual(checked.size, [512,512]); assert.equal(checked.nodeCount, 1);
  assert.equal(checked.metadata.Label, '1'); assert.equal(checked.metadata.ContentProducer, config.serviceProviderCode);
  assert.equal(checked.metadata.ProduceID, 'synthetic_job_1'); assert.equal(checked.operation, 'edit');
  assert.ok(checked.changedPixels > 500 && checked.changedPixels < 512 * 100); assert.deepEqual(checked.topLeft, [80,100,120]);
});

test('invalid identity, label version and modified bytes stop before the child starts', async () => {
  let calls = 0; const marker = createPhotoImageMarker({ ...config, spawnProcess: () => { calls++; throw new Error('should not run'); } });
  for (const changed of [{ contentId: 'unknown' }, { labelVersion: 'other' }, { operation: 'other' },
    { contentType: 'image/jpeg' }, { sha256: '0'.repeat(64) }, { byteLength: png.length + 1 }]) {
    await assert.rejects(marker.mark({ ...input(), ...changed }), /PHOTO_MARKER_INPUT_INVALID/);
  }
  assert.equal(calls, 0);
});

test('real Pillow keeps the provider lower-right pixels and XMP while adding our notice only in the lower-left', async () => {
  // A varied source and a high-contrast provider mark expose pixel damage that
  // a uniform background or a whole-file hash would fail to localize.
  const source = execFileSync(python, ['-c', [
    'import sys; from PIL import Image,ImageDraw,PngImagePlugin',
    'im=Image.new("RGB", (1024,1024)); im.putdata([((x*3+y)%256,(x+y*5)%256,(x*7+y*11)%256) for y in range(1024) for x in range(1024)])',
    'd=ImageDraw.Draw(im); d.rectangle((820,950,1010,1010),fill=(20,30,40)); d.text((838,968),"Qwen provider",fill=(255,255,255))',
    'meta=PngImagePlugin.PngInfo(); meta.add_itxt("XML:com.adobe.xmp", \'<x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:p="urn:fixture:provider"><rdf:RDF><rdf:Description p:Watermark="preserve-provider"><p:Provenance>provider-original</p:Provenance></rdf:Description></rdf:RDF></x:xmpmeta>\')',
    'im.save(sys.stdout.buffer,format="PNG",pnginfo=meta)',
  ].join('; ')]);
  const marked = await createPhotoImageMarker(config).mark(input(source));
  const inspect = bytes => JSON.parse(execFileSync(python, ['-c', [
    'import io,json,sys,hashlib,xml.etree.ElementTree as E; from PIL import Image',
    'im=Image.open(io.BytesIO(sys.stdin.buffer.read())); im.load(); x=E.fromstring(im.info["XML:com.adobe.xmp"])',
    'digest=lambda box:hashlib.sha256(im.crop(box).tobytes()).hexdigest()',
    'a=x.find(".//{http://www.tc260.org.cn/ns/AIGC/1.0}AIGC")',
    'print(json.dumps({"left":digest((0,768,512,1024)),"right":digest((512,768,1024,1024)),"upper":digest((0,0,1024,768)),"provider":x.find(".//{urn:fixture:provider}Provenance").text,"providerMark":x.find(".//{http://www.w3.org/1999/02/22-rdf-syntax-ns#}Description").get("{urn:fixture:provider}Watermark"),"aigc":None if a is None else json.loads(a.text)}))',
  ].join('; ')], { input: bytes, encoding: 'utf8' }));
  const before = inspect(source), after = inspect(marked.bytes);
  assert.equal(after.right, before.right, 'provider watermark region must be pixel-identical');
  assert.equal(after.upper, before.upper, 'all pixels above the bottom strip must be unchanged');
  assert.notEqual(after.left, before.left, 'our explicit AI notice must alter the lower-left');
  assert.equal(after.provider, before.provider); assert.equal(after.providerMark, before.providerMark);
  assert.equal(after.aigc.Label, '1'); assert.equal(after.aigc.ProduceID, 'synthetic_job_1');
  assert.equal(after.aigc.ContentProducer, config.serviceProviderCode);
});

test('visible AI notice is independent of internal job IDs while metadata preserves each exact ID', async () => {
  const marker = createPhotoImageMarker(config);
  const first = await marker.mark({ ...input(), contentId: 'first_internal_job_0123456789' });
  const second = await marker.mark({ ...input(), contentId: 'different_internal_job_9876543210' });
  const inspect = bytes => JSON.parse(execFileSync(python, ['-c',
    'import io,json,sys,hashlib,xml.etree.ElementTree as E; from PIL import Image; im=Image.open(io.BytesIO(sys.stdin.buffer.read())); im.load(); x=E.fromstring(im.info["XML:com.adobe.xmp"]); a=json.loads(x.find(".//{http://www.tc260.org.cn/ns/AIGC/1.0}AIGC").text); print(json.dumps({"pixels":hashlib.sha256(im.tobytes()).hexdigest(),"id":a["ProduceID"],"legacy":im.info["Content_ID"],"label":a["Label"]}))'],
    { input: bytes, encoding: 'utf8' }));
  const a = inspect(first.bytes), b = inspect(second.bytes);
  assert.equal(a.pixels, b.pixels);
  assert.equal(a.id, 'first_internal_job_0123456789'); assert.equal(a.legacy, a.id);
  assert.equal(b.id, 'different_internal_job_9876543210'); assert.equal(b.legacy, b.id);
  assert.equal(a.label, '1'); assert.equal(b.label, '1'); assert.notEqual(first.sha256, second.sha256);
});

test('real decoder rejects corrupt PNG and animated PNG without returning partial output', async () => {
  const marker = createPhotoImageMarker(config);
  const corrupt = Buffer.from(png); corrupt.fill(0, 64, 100);
  await assert.rejects(marker.mark(input(corrupt)), /PHOTO_MARKER_(INPUT_INVALID|UNCONFIRMED)/);
  const animated = execFileSync(python, ['-c', 'import sys; from PIL import Image; a=Image.new("RGB",(512,512),"red"); b=Image.new("RGB",(512,512),"blue"); a.save(sys.stdout.buffer, format="PNG", save_all=True, append_images=[b], duration=100, loop=0)']);
  await assert.rejects(marker.mark(input(animated)), /PHOTO_MARKER_UNCONFIRMED/);
});

test('missing configured font fails closed and suppresses Python stderr details', async () => {
  const marker = createPhotoImageMarker({ ...config, font: 'synthetic-secret-font-path-that-does-not-exist.ttf' });
  await assert.rejects(marker.mark(input()), error => {
    assert.equal(error.code, 'PHOTO_MARKER_UNCONFIRMED');
    assert.doesNotMatch(String(error), /font-path|Traceback/); return true;
  });
});

test('hung and oversized child outputs are killed once with bounded diagnostics', async () => {
  for (const oversized of [false, true]) {
    let killed = 0;
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed++; child.emit('close', 1); };
    const marker = createPhotoImageMarker({ ...config, timeoutMs: 20, spawnProcess: () => {
      if (oversized) queueMicrotask(() => child.stdout.write(Buffer.alloc(20 * 1024 * 1024 + 1)));
      return child;
    } });
    await assert.rejects(marker.mark(input()), error => error.code === (oversized ? 'PHOTO_MARKER_OUTPUT_TOO_LARGE' : 'PHOTO_MARKER_TIMEOUT'));
    assert.equal(killed, 1);
  }
});
