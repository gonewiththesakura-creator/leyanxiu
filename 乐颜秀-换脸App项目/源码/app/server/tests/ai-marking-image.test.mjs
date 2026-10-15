import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-image-aigc-'));
const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
const env = { ...process.env, PYTHON_PATH: python, DEPLOY_ENV: 'development', NODE_ENV: 'test',
  SERVICE_PROVIDER_CODE: 'synthetic-test-operator', AI_MARKING_CONFORMANCE_REPORT: '', AI_MARKING_CONFORMANCE_REPORT_SHA256: '' };
const source = path.join(temp, 'source.png');
execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB", (640, 480), (80,100,140)).save(sys.argv[1])', source], { windowsHide: true });

function node(script, overrides = {}) {
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env: { ...env, ...overrides }, encoding: 'utf8', windowsHide: true,
  }).trim());
}

function mark(input, output, options) {
  return node(`import {markFile} from './ai-marking.js'; console.log(JSON.stringify(await markFile(${JSON.stringify(input)},${JSON.stringify(output)},${JSON.stringify(options)})));`);
}

// Independent container readers: do not use the production writer or search
// arbitrary file text, which could mistake a sidecar/comment for real metadata.
function xmpFromFile(file) {
  const bytes = fs.readFileSync(file);
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const size = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
      const data = bytes.subarray(offset + 8, offset + 8 + size); offset += 12 + size;
      if (type !== 'iTXt' || data.toString('ascii', 0, data.indexOf(0)) !== 'XML:com.adobe.xmp') continue;
      const keywordEnd = data.indexOf(0), languageEnd = data.indexOf(0, keywordEnd + 3), translatedEnd = data.indexOf(0, languageEnd + 1);
      assert.equal(data[keywordEnd + 1], 0, 'XMP iTXt must be uncompressed');
      return data.subarray(translatedEnd + 1).toString('utf8');
    }
  } else if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      assert.equal(bytes[offset], 0xff);
      const marker = bytes[offset + 1]; if (marker === 0xda || marker === 0xd9) break;
      const size = bytes.readUInt16BE(offset + 2), data = bytes.subarray(offset + 4, offset + 2 + size); offset += 2 + size;
      const prefix = Buffer.from('http://ns.adobe.com/xap/1.0/\0');
      if (marker === 0xe1 && data.subarray(0, prefix.length).equals(prefix)) return data.subarray(prefix.length).toString('utf8');
    }
  } else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const size = bytes.readUInt32LE(offset + 4), type = bytes.toString('ascii', offset, offset + 4);
      if (type === 'XMP ') return bytes.toString('utf8', offset + 8, offset + 8 + size);
      offset += 8 + size + size % 2;
    }
  }
  assert.fail('No XMP metadata in the real image container');
}

function inspectPixels(file) {
  return JSON.parse(execFileSync(python, ['-c', `from PIL import Image
import json,sys
im=Image.open(sys.argv[1]); im.load(); rgb=im.convert('RGB')
changed=sum(1 for y in range(380,480) for x in range(640) if max(abs(a-b) for a,b in zip(rgb.getpixel((x,y)),(80,100,140)))>40)
legacy=im.info.get('AI_Generated') or im.getexif().get(0x9286,b'').decode('utf-8')
print(json.dumps({'format':im.format,'size':im.size,'changed':changed,'legacy':legacy,'upper':rgb.getpixel((20,20))}))`, file], { encoding: 'utf8', windowsHide: true }));
}

for (const [ext, format] of [['png', 'PNG'], ['jpg', 'JPEG'], ['webp', 'WEBP']]) {
  for (const operation of ['generate', 'edit']) test(`${format} ${operation}: actual image contains readable AIGC provenance and a visible label`, () => {
    const contentId = `fixture-${ext}-${operation}`, output = path.join(temp, `${contentId}.${ext}`);
    const result = mark(source, output, { kind: 'image', contentId, operation });
    assert.equal(result.conformanceVerified, false, 'writing metadata must not fabricate a passing report');
    assert.equal(result.operation, operation);
    const xmp = xmpFromFile(output);
    assert.match(xmp, /xmlns:TC260="http:\/\/www.tc260.org.cn\/ns\/AIGC\/1.0"/);
    const entries = [...xmp.matchAll(/<TC260:AIGC>(.*?)<\/TC260:AIGC>/gs)];
    assert.equal(entries.length, 1);
    assert.deepEqual(JSON.parse(entries[0][1]), {
      Label: '1', ContentProducer: 'synthetic-test-operator', ProduceID: contentId, ReservedCode1: '',
      ContentPropagator: 'synthetic-test-operator', PropagateID: contentId, ReservedCode2: '',
    });
    const pixels = inspectPixels(output);
    assert.equal(pixels.format, format); assert.deepEqual(pixels.size, [640, 480]);
    assert.ok(pixels.changed > 500, 'visible label must alter the actual image pixels');
    assert.ok(pixels.upper.every((v, i) => Math.abs(v - [80, 100, 140][i]) < 10));
    assert.match(pixels.legacy, /true/);
  });
}

test('editing updates only TC260 AIGC and preserves other source XMP properties', () => {
  const input = path.join(temp, 'previous.png'), output = path.join(temp, 'updated.jpg');
  const xmp = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:TC260="http://www.tc260.org.cn/ns/AIGC/1.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><TC260:AIGC>{"Label":"1","ProduceID":"old-id"}</TC260:AIGC><TC260:Other>keep-other</TC260:Other><dc:rights>synthetic-owner</dc:rights></rdf:Description></rdf:RDF></x:xmpmeta>';
  execFileSync(python, ['-c', 'from PIL import Image,PngImagePlugin; import sys; p=PngImagePlugin.PngInfo(); p.add_itxt("XML:com.adobe.xmp",sys.argv[2]); Image.new("RGB",(640,480),(80,100,140)).save(sys.argv[1],pnginfo=p)', input, xmp], { windowsHide: true });
  mark(input, output, { kind: 'image', operation: 'edit', contentId: 'replacement-content' });
  const written = xmpFromFile(output);
  assert.match(written, /keep-other/); assert.match(written, /synthetic-owner/);
  assert.doesNotMatch(written, /old-id/); assert.match(written, /replacement-content/);
  assert.equal([...written.matchAll(/<TC260:AIGC>/g)].length, 1);
});

test('missing or placeholder provenance, unknown operations and blank labels fail without output', () => {
  for (const bad of [{ contentId: '' }, { serviceProviderCode: 'unconfigured' }, { serviceProviderCode: 'A B' }, { contentId: 'unknown' }, { operation: 'restore' }, { label: '' }, { label: '普通照片' }, { operation: 'edit', label: 'AI生成' }]) {
    const output = path.join(temp, 'rejected.png');
    const options = { kind: 'image', contentId: 'reject-fixture', ...bad };
    const failure = node(`import {markFile} from './ai-marking.js'; try { await markFile(${JSON.stringify(source)},${JSON.stringify(output)},${JSON.stringify(options)}); console.log('{}'); } catch(e) { console.log(JSON.stringify({code:e.message})); }`);
    assert.match(failure.code, /IMAGE_MARKING_/); assert.equal(fs.existsSync(output), false);
  }
});

test('multiple JPEG XMP packets cannot be silently hidden by a decoder info field', () => {
  const first = path.join(temp, 'one-packet.jpg'), input = path.join(temp, 'two-packets.jpg'), output = path.join(temp, 'two-packet-output.jpg');
  mark(source, first, { kind: 'image', contentId: 'first-identity' });
  const jpeg = fs.readFileSync(first), length = jpeg.readUInt16BE(4), segment = jpeg.subarray(2, 4 + length);
  assert.equal(segment[1], 0xe1);
  fs.writeFileSync(input, Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]));
  const result = node(`import {markFile} from './ai-marking.js'; try { await markFile(${JSON.stringify(input)},${JSON.stringify(output)},{kind:'image',contentId:'second-identity'}); console.log('{}'); } catch(e) { console.log(JSON.stringify({failed:true})); }`);
  assert.equal(result.failed, true); assert.equal(fs.existsSync(output), false);
});

test('EXIF-rotated portraits are oriented before drawing and do not rotate the visible label sideways', () => {
  const input = path.join(temp, 'portrait-oriented.jpg'), output = path.join(temp, 'portrait-marked.webp');
  execFileSync(python, ['-c', 'from PIL import Image; import sys; im=Image.new("RGB",(640,480),(80,100,140)); exif=im.getexif(); exif[0x0112]=6; im.save(sys.argv[1],exif=exif)', input], { windowsHide: true });
  mark(input, output, { kind: 'image', operation: 'edit', contentId: 'oriented-image' });
  const viewed = JSON.parse(execFileSync(python, ['-c', `from PIL import Image
import json,sys
im=Image.open(sys.argv[1]); rgb=im.convert('RGB')
changed=sum(1 for y in range(540,640) for x in range(480) if max(abs(a-b) for a,b in zip(rgb.getpixel((x,y)),(80,100,140)))>40)
print(json.dumps({'size':im.size,'orientation':im.getexif().get(0x0112),'changed':changed}))`, output], { encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(viewed.size, [480, 640]); assert.equal(viewed.orientation, null); assert.ok(viewed.changed > 500);
  assert.match(xmpFromFile(output), /oriented-image/);
});

test('unsafe source XMP and unsupported output formats cannot produce a claimed marked image', () => {
  const input = path.join(temp, 'unsafe.png'), output = path.join(temp, 'unsafe-output.png');
  execFileSync(python, ['-c', 'from PIL import Image,PngImagePlugin; import sys; p=PngImagePlugin.PngInfo(); p.add_itxt("XML:com.adobe.xmp", "<!DOCTYPE x [<!ENTITY hidden \'unsafe\'>]><x>&hidden;</x>"); Image.new("RGB",(640,480),(80,100,140)).save(sys.argv[1],pnginfo=p)', input], { windowsHide: true });
  for (const [src, dest] of [[input, output], [source, path.join(temp, 'not-an-image.bin')]]) {
    const failure = node(`import {markFile} from './ai-marking.js'; try { await markFile(${JSON.stringify(src)},${JSON.stringify(dest)},{kind:'image',contentId:'unsafe-fixture'}); console.log('{}'); } catch(e) { console.log(JSON.stringify({failed:true})); }`);
    assert.equal(failure.failed, true); assert.equal(fs.existsSync(dest), false);
  }
});

test('UTF-16 and UTF-32 source XMP cannot bypass the DTD rejection with NUL-separated bytes', () => {
  const xmp = '<?xml version="1.0" encoding="UTF-16"?><!DOCTYPE x [<!ENTITY marker "SHOULD_NOT_EXPAND">]><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:rights>&marker;</dc:rights></rdf:Description></rdf:RDF></x:xmpmeta>';
  for (const encoding of ['utf-16', 'utf-16-le', 'utf-32', 'utf-32-le']) {
    const input = path.join(temp, `unsafe-${encoding}.webp`), output = path.join(temp, `rejected-${encoding}.png`);
    execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB",(640,480),(80,100,140)).save(sys.argv[1],xmp=sys.argv[2].encode(sys.argv[3]))', input, xmp, encoding], { windowsHide: true });
    const result = node(`import {markFile} from './ai-marking.js'; try { await markFile(${JSON.stringify(input)},${JSON.stringify(output)},{kind:'image',contentId:'encoding-fixture'}); console.log('{}'); } catch(e) { console.log(JSON.stringify({failed:true})); }`);
    assert.equal(result.failed, true, encoding); assert.equal(fs.existsSync(output), false);
  }
});

test('tiny images fail closed rather than claiming a label drawn outside their pixels', () => {
  for (const [width, height] of [[1, 1], [127, 480], [640, 127]]) {
    const input = path.join(temp, `small-${width}-${height}.png`), output = path.join(temp, `small-${width}-${height}-marked.png`);
    execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB",(int(sys.argv[2]),int(sys.argv[3])),(80,100,140)).save(sys.argv[1])', input, String(width), String(height)], { windowsHide: true });
    const result = node(`import {markFile} from './ai-marking.js'; try { await markFile(${JSON.stringify(input)},${JSON.stringify(output)},{kind:'image',contentId:'tiny-fixture'}); console.log('{}'); } catch(e) { console.log(JSON.stringify({failed:true})); }`);
    assert.equal(result.failed, true); assert.equal(fs.existsSync(output), false);
  }
});

test('a minimum-size image retains a fully visible label and keeps a long content ID in XMP', () => {
  const input = path.join(temp, 'minimum.png'), output = path.join(temp, 'minimum-marked.png');
  const contentId = 'x'.repeat(128);
  execFileSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB",(128,128),(80,100,140)).save(sys.argv[1])', input], { windowsHide: true });
  assert.equal(mark(input, output, { kind: 'image', contentId, label: 'AI生成合成' }).explicitVisibleLabel, true);
  assert.match(xmpFromFile(output), new RegExp(contentId));
  const pixels = JSON.parse(execFileSync(python, ['-c', `from PIL import Image
import json,sys
im=Image.open(sys.argv[1]).convert('RGB')
white=[(x,y) for y in range(im.height) for x in range(im.width) if min(im.getpixel((x,y)))>220]
print(json.dumps({'size':im.size,'white':len(white),'bounds':[min(x for x,y in white),min(y for x,y in white),max(x for x,y in white),max(y for x,y in white)]}))`, output], { encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(pixels.size, [128, 128]); assert.ok(pixels.white > 100);
  assert.ok(pixels.bounds[0] > 0 && pixels.bounds[1] > 0 && pixels.bounds[2] < 127 && pixels.bounds[3] < 127);
});

test('invalid or Latin-only configured fonts fail rendering and the production image readiness probe', () => {
  const latin = ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'].find(file => fs.existsSync(file));
  const fonts = [path.join(temp, 'missing-font.ttf'), ...(latin ? [latin] : [])];
  for (const [index, font] of fonts.entries()) {
    const output = path.join(temp, `bad-font-${index}.png`);
    const result = node(`import {markFile,markingReadiness} from './ai-marking.js'; let rejected=false; try { await markFile(${JSON.stringify(source)},${JSON.stringify(output)},{kind:'image',operation:'edit',contentId:'font-fixture'}); } catch { rejected=true; } console.log(JSON.stringify({rejected,status:markingReadiness({kinds:['image']})}));`, {
      AI_MARK_FONT: font, DEPLOY_ENV: 'production', AI_MARKING_REQUIRED: 'true',
    });
    assert.equal(result.rejected, true); assert.equal(fs.existsSync(output), false);
    assert.equal(result.status.ready, false); assert.ok(result.status.blockers.some(item => /Chinese label glyphs/.test(item)));
  }
});

test('image-only readiness skips FFmpeg while default/video still probe it and never invent conformance', () => {
  const statuses = node(`import {markingReadiness} from './ai-marking.js'; console.log(JSON.stringify({image:markingReadiness({kinds:['image']}),video:markingReadiness({kinds:['video']}),all:markingReadiness(),invalid:markingReadiness({kinds:[]})}));`, {
    DEPLOY_ENV: 'production', AI_MARKING_REQUIRED: 'true', FFMPEG_PATH: path.join(temp, 'missing-ffmpeg'),
  });
  assert.equal(statuses.image.ready, false);
  assert.ok(statuses.image.blockers.some(item => /REPORT/.test(item)));
  assert.ok(!statuses.image.blockers.some(item => /FFmpeg/.test(item)));
  for (const status of [statuses.video, statuses.all]) assert.ok(status.blockers.some(item => /FFmpeg/.test(item)));
  assert.ok(statuses.invalid.blockers.some(item => /kinds/.test(item)));
});

test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
