import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const { prepareLocalPhoto, inputLimit, outputLimit } = createRequire(import.meta.url)('../../miniprogram/photo-input.js');
const original = '/fictional/original.jpg';
const photo = (size = 1000, width = 400, height = 500, type = 'jpeg') => ({ size, width, height, type });
function fixture(input = photo(), outputs = []) {
  const calls = [], files = new Map([[original, input]]);
  const fs = {
    getFileInfo(options) { calls.push(['size', options.filePath]); options.success({ size: files.get(options.filePath)?.size }); },
    readFile(options) { calls.push(['read', options.filePath]); options.success({ data: Buffer.alloc(files.get(options.filePath).size).toString('base64') }); },
  };
  const wx = {
    getFileSystemManager: () => fs,
    getImageInfo(options) { calls.push(['info', options.src]); options.success(files.get(options.src)); },
    compressImage(options) { const index = calls.filter(c => c[0] === 'compress').length; calls.push(['compress', options]);
      const next = outputs[index]; if (next instanceof Error) return options.fail(next);
      const path = `/fictional/compressed-${index}.jpg`; files.set(path, next || photo()); options.success({ tempFilePath: path }); },
    uploadFile() { assert.fail('local preparation must not upload'); }, request() { assert.fail('local preparation must not request'); },
    setStorageSync() { assert.fail('local photo cannot be persisted'); }, saveFile() { assert.fail('temporary photo cannot be persisted'); },
  };
  return { wx, fs, files, calls, selected: { tempFilePath: original, size: input.size },
    run(options) { return prepareLocalPhoto(wx, this.selected, options); } };
}
test('compliant small input stays byte-for-byte in local memory, with measured size and final size reread', async () => {
  const f = fixture(photo(1024, 3000, 2000, 'png')), result = await f.run();
  assert.equal(result.path, original); assert.equal(result.compressionAttempts, 0);
  assert.equal(Buffer.from(result.dataUrl.split(',')[1], 'base64').length, 1024);
  assert.equal(result.dataUrl.startsWith('data:image/png;base64,'), true);
  assert.deepEqual(f.calls.map(c => c[0]), ['size', 'info', 'read', 'size']);
});
test('20MB phone original is resized locally; actual compressed type/dimensions/bytes bind returned payload', async () => {
  const f = fixture(photo(inputLimit, 8064, 6048), [photo(200000, 2000, 1500, 'jpeg')]);
  const result = await f.run();
  assert.equal(result.width, 2000); assert.equal(result.height, 1500); assert.equal(result.bytes, 200000);
  assert.equal(result.compressionAttempts, 1); assert.equal(result.path, '/fictional/compressed-0.jpg');
  const options = f.calls.find(c => c[0] === 'compress')[1];
  assert.equal(options.src, original); assert.equal(options.compressedWidth, 2000); assert.equal(options.compressedHeight, 1500); assert.equal(options.quality, 85);
  assert.ok(f.calls.some(c => c[0] === 'info' && c[1] === result.path));
});
test('at most two attempts use original and progressively smaller output, without trusting compress success', async () => {
  const f = fixture(photo(5000000, 4000, 3000), [photo(outputLimit + 1, 2000, 1500), photo(outputLimit, 1600, 1200)]);
  const result = await f.run(); assert.equal(result.compressionAttempts, 2);
  const attempts = f.calls.filter(c => c[0] === 'compress').map(c => c[1]);
  assert.deepEqual(attempts.map(o => [o.src, o.compressedWidth, o.quality]), [[original, 2000, 85], [original, 1600, 65]]);
  const tooBig = fixture(photo(5000000), [photo(outputLimit + 1), photo(outputLimit + 1)]);
  await assert.rejects(tooBig.run(), /2MB/); assert.equal(tooBig.calls.filter(c => c[0] === 'compress').length, 2);
  assert.equal(tooBig.calls.some(c => c[0] === 'read'), false);
});
test('original and actual sizes, shortest side, formats and local-only paths fail closed', async () => {
  for (const input of [photo(inputLimit + 1), photo(0), photo(1, 255, 1000), photo(1, 400, NaN), photo(1, 400, 500, 'gif')]) {
    const f = fixture(input); await assert.rejects(f.run()); assert.equal(f.calls.some(c => c[0] === 'compress' || c[0] === 'read'), false);
  }
  const larger = fixture(photo(inputLimit + 1)); larger.selected.size = 1;
  await assert.rejects(larger.run(), /20MB/);
  for (const path of ['https://example.invalid/image.jpg', 'cloud://private/photo', '//example.invalid/photo', 'data:image/png;base64,AA==']) {
    const f = fixture(); f.selected.tempFilePath = path; await assert.rejects(f.run()); assert.equal(f.calls.length, 0);
  }
});
test('oversized pixels are normalized even below 2MB; ignored resize, tiny output and unsupported type rejected', async () => {
  const f = fixture(photo(1024, 10000, 6000), [photo(1000, 2000, 1200)]);
  assert.equal((await f.run()).compressionAttempts, 1);
  for (const output of [photo(1000, 9000, 6000), photo(1000, 255, 500), photo(1000, 400, 500, 'gif')]) {
    const f = fixture(photo(3000000), [output, output]); await assert.rejects(f.run());
    assert.equal(f.calls.some(c => c[0] === 'read'), false);
  }
});
test('compression errors never auto-retry and absent API cannot silently pass an oversized original', async () => {
  const f = fixture(photo(3000000), [new Error('fixture compressor failure')]);
  await assert.rejects(f.run(), /fixture/); assert.equal(f.calls.filter(c => c[0] === 'compress').length, 1);
  const absent = fixture(photo(3000000)); delete absent.wx.compressImage;
  await assert.rejects(absent.run(), /更新微信/);
});
test('second quality attempt keeps the 256px short side and DevTools temporary URLs remain local', async () => {
  const f = fixture(photo(3000000, 4000, 512), [photo(outputLimit + 1, 2000, 256), photo(1000, 2000, 256)]);
  const result = await f.run(); assert.equal(result.height, 256); assert.equal(result.compressionAttempts, 2);
  assert.equal(f.calls.filter(c => c[0] === 'compress')[1][1].compressedHeight, 256);
  const local = fixture(); local.files.set('http://tmp/picked.jpg', photo()); local.selected.tempFilePath = 'http://tmp/picked.jpg';
  assert.equal((await local.run()).path, 'http://tmp/picked.jpg');
});
test('base64 malformed, truncated, inflated and file changed after reading are rejected', async () => {
  for (const encoded of ['AAAA', 'AA=A', 'aGVsbG8=\n', '!!!!', '=AAA']) {
    const f = fixture(photo(5)); f.fs.readFile = o => o.success({ data: encoded }); await assert.rejects(f.run(), /读取/);
  }
  const f = fixture(photo(5)); let sizes = 0;
  f.fs.getFileInfo = o => o.success({ size: ++sizes === 1 ? 5 : 6 });
  await assert.rejects(f.run(), /已变化/);
});
test('cancellation after every async boundary prevents later local effects and returning photo data', async () => {
  // Includes first/second compressed-file inspection and final bytes reread.
  const baseline = fixture(photo(3000000), [photo(outputLimit + 1, 2000, 1500), photo(5, 1600, 1200)]);
  await baseline.run();
  for (let stopAt = 1; stopAt <= baseline.calls.length; stopAt++) {
    const f = fixture(photo(3000000), [photo(outputLimit + 1, 2000, 1500), photo(5, 1600, 1200)]);
    let current = true, seen = 0;
    for (const [owner, method] of [[f.fs, 'getFileInfo'], [f.fs, 'readFile'], [f.wx, 'getImageInfo'], [f.wx, 'compressImage']]) {
      const implementation = owner[method]; owner[method] = options => implementation({ ...options, success(value) { if (++seen === stopAt) current = false; options.success(value); } });
    }
    await assert.rejects(f.run({ isCurrent: () => current }), /取消/);
    assert.equal(seen, stopAt);
  }
});

const pageSource = readFileSync(new URL('../../miniprogram/pages/create/index.js', import.meta.url), 'utf8');
function pageFixture(f) {
  let page; const wx = { ...f.wx, chooseMedia: o => o.success({ tempFiles: [f.selected] }), showToast: () => {}, ...f.pageWx };
  runInNewContext(pageSource, { wx, Page: value => { page = value; }, require: name => name === '../../photo-input'
    ? { prepareLocalPhoto } : { createCreationClient: () => ({}) }, setTimeout, clearTimeout });
  page.data = structuredClone(page.data); page.setData = patch => Object.assign(page.data, patch);
  page.client = {}; page.visible = true; page.viewRevision = 0; page.readAccessReady = true;
  page.nativePrivacy = async () => {};
  return { page, wx };
}
test('page accepts normalized 20MB selection, preserves chosen effect and resets independent authorization', async () => {
  const f = fixture(photo(inputLimit, 4000, 3000), [photo(10, 2000, 1500)]), { page, wx } = pageFixture(f);
  let picker; wx.chooseMedia = options => { picker = options; options.success({ tempFiles: [f.selected] }); };
  page.data.effectId = 'modern-comic'; page.data.basicAgreed = true; page.data.faceAgreed = true; page.data.subjectAuthorization = 'self';
  await page.selectPhoto({ currentTarget: { dataset: { source: 'camera' } } });
  assert.deepEqual(Array.from(picker.sizeType), ['original']); assert.deepEqual(Array.from(picker.sourceType), ['camera']);
  assert.equal(page.data.effectId, 'modern-comic'); assert.equal(page.data.selectedPhoto, '/fictional/compressed-0.jpg');
  assert.equal(page.photoData.startsWith('data:image/jpeg;base64,'), true);
  assert.equal(page.data.basicAgreed, false); assert.equal(page.data.faceAgreed, false); assert.equal(page.data.subjectAuthorization, '');
  assert.equal(page.data.selecting, false);
});
test('late compression cannot refill after hide-show, account change, client replacement or unload', async () => {
  for (const reason of ['hide-show', 'account', 'client', 'unload']) {
    const f = fixture(photo(3000000)); let release, reached;
    const started = new Promise(resolve => { reached = resolve; });
    f.wx.compressImage = options => { reached(); release = () => { f.files.set('/fictional/out.jpg', photo(10)); options.success({ tempFilePath: '/fictional/out.jpg' }); }; };
    const { page } = pageFixture(f); const selecting = page.selectPhoto(); await started;
    if (reason === 'hide-show') { page.onHide(); page.visible = true; }
    if (reason === 'account') page.showError({ code: 'XPAY_ACCOUNT_CHANGED' });
    if (reason === 'client') page.client = {};
    if (reason === 'unload') page.onUnload();
    release(); await selecting;
    assert.equal(page.data.selectedPhoto, '', reason); assert.ok(!page.photoData, reason);
    assert.equal(page.data.basicAgreed, false, reason); assert.equal(page.data.faceAgreed, false, reason);
    assert.equal(f.calls.some(c => c[0] === 'read'), false, reason);
  }
});
test('cancelled picker preserves only the original photo authorization and never starts processing', async () => {
  const f = fixture(), { page, wx } = pageFixture(f);
  page.photoData = 'original-in-memory'; page.data.selectedPhoto = '/fictional/previous.jpg';
  page.data.basicAgreed = true; page.data.faceAgreed = true; page.data.subjectAuthorization = 'self';
  wx.chooseMedia = o => o.fail({ errMsg: 'chooseMedia:fail cancel' });
  wx.showToast = () => assert.fail('cancellation must stay quiet');
  await page.selectPhoto();
  assert.equal(page.photoData, 'original-in-memory'); assert.equal(page.data.selectedPhoto, '/fictional/previous.jpg');
  assert.equal(page.data.basicAgreed, true); assert.equal(page.data.faceAgreed, true);
  assert.equal(page.data.subjectAuthorization, 'self'); assert.equal(page.data.selecting, false); assert.equal(f.calls.length, 0);
});
test('a changed client while awaiting native privacy never opens the picker', async () => {
  const f = fixture(), { page, wx } = pageFixture(f); let release;
  page.nativePrivacy = () => new Promise(resolve => { release = resolve; });
  wx.chooseMedia = () => assert.fail('stale selection must not open picker');
  const operation = page.selectPhoto(); page.client = {}; release(); await operation;
  assert.equal(f.calls.length, 0); assert.equal(page.data.selectedPhoto, '');
});
