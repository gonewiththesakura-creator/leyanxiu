import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPhotoOutputOssStorage } from '../photo-jobs/output-storage.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAO0lEQVR4nO3RQREAMAjEwKN+6qVykF8J4cMvK+CYCXVfZ9NZXY8HBvwBMhEyETIRMhEyETIRMhEyUcgHKU4BNULpqU8AAAAASUVORK5CYII=', 'base64');
const key = 'private/photo-outputs/' + 'a'.repeat(32) + '.png';
const stamp = 1_791_540_000_000;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expected = () => ({ sha256: sha(png), byteLength: png.length, contentType: 'image/png' });
const baseHeaders = () => ({ 'content-length': String(png.length), 'content-type': 'image/png', 'x-oss-meta-sha256': sha(png), etag: '"synthetic-etag"' });
const absent = () => Object.assign(new Error('private upstream details must not escape'), { code: 'NoSuchKey', status: 404 });
function fixture({ head, get, put, remove, sign, clock = stamp } = {}) {
  const calls = []; let deleted = false;
  const client = {
    async put(objectKey, bytes, options) { calls.push({ action: 'put', key: objectKey, bytes, options });
      return put ? put(bytes) : { res: { status: 200, headers: {} } }; },
    async head(objectKey, options) { calls.push({ action: 'head', key: objectKey, options });
      if (head) return head(); if (deleted) throw absent(); return { res: { status: 200, headers: baseHeaders() } }; },
    async get(objectKey, options) { calls.push({ action: 'get', key: objectKey, options });
      return get ? get() : { content: Buffer.from(png), res: { status: 206, headers: { ...baseHeaders(), 'content-range': `bytes 0-${png.length - 1}/${png.length}` } } }; },
    signatureUrl(objectKey, options) { calls.push({ action: 'sign', key: objectKey, options });
      return sign ? sign(objectKey, options) : `https://fixture-private.oss-cn-shanghai.aliyuncs.com/${objectKey}?Expires=${Math.round(clock / 1000) + options.expires}&Signature=REDACTED_SECRET },
    async delete(objectKey, options) { calls.push({ action: 'delete', key: objectKey, options }); deleted = true;
      return remove ? remove() : { res: { status: 204, headers: {} } }; },
  };
  return { calls, storage: createPhotoOutputOssStorage({ client, bucket: 'fixture-private', region: 'cn-shanghai', now: () => clock }) };
}

test('private immutable PUT snapshots bytes, authenticated read binds actual bytes to frozen DB evidence', async () => {
  let release; const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ put: async () => { await held; return { res: { status: 200, headers: {} } }; } });
  const source = Buffer.from(png);
  const pending = f.storage.put(key, source, { contentType: 'image/png', timeoutMs: 100 });
  source.fill(0); release();
  assert.deepEqual(await pending, { ...expected(), versionHeaderPresent: false });
  assert.deepEqual(f.calls[0].bytes, png);
  assert.equal(f.calls[0].options.headers['x-oss-object-acl'], 'private');
  assert.equal(f.calls[0].options.headers['x-oss-forbid-overwrite'], 'true');
  assert.equal(f.calls[0].options.headers['x-oss-meta-sha256'], sha(png));
  const result = await f.storage.read(key, { expected: expected(), timeoutMs: 100 });
  assert.equal(result.sha256, sha(png)); assert.deepEqual(result.bytes, png);
  assert.equal(f.calls.at(-1).options.headers['If-Match'], '"synthetic-etag"');
  assert.equal(f.calls.at(-1).options.headers.Range, `bytes=0-${png.length - 1}`);
  const deletion = await f.storage.delete(key, { timeoutMs: 100 });
  assert.equal(deletion.acknowledged, true); assert.equal(deletion.absentObserved, true);
  assert.equal(deletion.historyErasureVerified, false); assert.equal(deletion.lateWritesExcluded, false);
  assert.deepEqual(f.calls.slice(-2).map(call => call.action), ['delete', 'head']);
});

test('URL/cross-prefix keys, oversize bytes and MIME mismatches fail before any request', async () => {
  const f = fixture();
  for (const invalid of ['https://example.invalid/' + key, key.replace('photo-outputs', 'mini-photo-input'), key.replace('/' + 'a'.repeat(32), '/../' + 'a'.repeat(32)), key + '?versionId=other']) {
    await assert.rejects(f.storage.put(invalid, png, { contentType: 'image/png' }), /KEY_INVALID/);
    await assert.rejects(f.storage.read(invalid, { expected: expected() }), /KEY_INVALID/);
    await assert.rejects(f.storage.delete(invalid), /KEY_INVALID/);
    assert.throws(() => f.storage.signedUrl(invalid, { maxExpiresAt: stamp + 60000 }), /KEY_INVALID/);
  }
  await assert.rejects(f.storage.put(key, Buffer.alloc(20 * 1024 * 1024 + 1), { contentType: 'image/png' }), /IMAGE_INVALID/);
  await assert.rejects(f.storage.put(key, png, { contentType: 'image/jpeg' }), /IMAGE_INVALID/);
  await assert.rejects(f.storage.put(key, Buffer.alloc(100), { contentType: 'image/png' }), /IMAGE_INVALID/);
  await assert.rejects(f.storage.read(key), /EXPECTED_REQUIRED/);
  assert.equal(f.calls.length, 0);
});

test('unchanged forged metadata cannot mask changed bytes, ETag race, partial object, or wrong MIME', async () => {
  const changed = Buffer.from(png); changed[40] ^= 1;
  for (const override of [
    { content: changed, res: { status: 200, headers: baseHeaders() } },
    { content: png, res: { status: 200, headers: { ...baseHeaders(), etag: '"different"' } } },
    { content: png, res: { status: 206, headers: { ...baseHeaders(), 'content-range': `bytes 0-${png.length - 1}/${png.length + 1}` } } },
    { content: png, res: { status: 200, headers: { ...baseHeaders(), 'content-type': 'image/jpeg' } } },
  ]) {
    const f = fixture({ get: () => override });
    await assert.rejects(f.storage.read(key, { expected: expected() }), /READ_UNCONFIRMED/);
    assert.equal(f.calls.filter(call => call.action === 'get').length, 1);
  }
  const oversize = fixture({ head: () => ({ res: { status: 200, headers: { ...baseHeaders(), 'content-length': String(20 * 1024 * 1024 + 1) } } }) });
  await assert.rejects(oversize.storage.read(key, { expected: expected() }), /READ_UNCONFIRMED/);
  assert.equal(oversize.calls.filter(call => call.action === 'get').length, 0);
});

test('signed GET returns actual bounded expiry, rejects foreign hosts/paths and overlong deadlines', () => {
  const f = fixture(); const signed = f.storage.signedUrl(key, { maxExpiresAt: stamp + 21500 });
  assert.equal(signed.expiresAt, stamp + 21000); assert.equal(f.calls[0].options.expires, 21);
  assert.throws(() => f.storage.signedUrl(key, { ttlSeconds: 61, maxExpiresAt: stamp + 90000 }), /SIGNING_INVALID/);
  assert.throws(() => f.storage.signedUrl(key, { maxExpiresAt: stamp + 999 }), /EXPIRED/);
  const rounded = fixture({ clock: stamp + 750 });
  assert.equal(rounded.storage.signedUrl(key, { maxExpiresAt: stamp + 60750 }).expiresAt, stamp + 60000);
  assert.equal(rounded.calls[0].options.expires, 59);
  for (const url of [`http://fixture-private.oss-cn-shanghai.aliyuncs.com/${key}?Expires=1791540060`,
    `https://other.oss-cn-shanghai.aliyuncs.com/${key}?Expires=1791540060`,
    `https://fixture-private.oss-cn-shanghai.aliyuncs.com/private/other.png?Expires=1791540060`,
    `https://fixture-private.oss-cn-shanghai.aliyuncs.com/${key}?Expires=1791540061`,
    `https://fixture-private.oss-cn-shanghai.aliyuncs.com/${key}?Expires=1791540060&Expires=1791540001`]) {
    assert.throws(() => fixture({ sign: () => url }).storage.signedUrl(key, { maxExpiresAt: stamp + 60000 }), /SIGNING_UNCONFIRMED/);
  }
  // Actual installed SDK signing is local: synthetic credentials, no request.
  const installed = createPhotoOutputOssStorage({ bucket: 'fixture-private', region: 'cn-shanghai',
    credential: { accessKeyId: 'synthetic-key-id', accessKeySecret: 'synthetic-key-secret' } });
  const maximum = Date.now() + 60000;
  const actual = installed.signedUrl(key, { maxExpiresAt: maximum });
  assert.equal(Number(new URL(actual.url).searchParams.get('Expires')) * 1000, actual.expiresAt);
  assert.ok(actual.expiresAt > Date.now() && actual.expiresAt <= maximum);
});

test('delete timeout or versioned deletion cannot become historical erasure; only exact authenticated NoSuchKey proves absence observation', async () => {
  const uncertain = fixture({ remove: () => { throw new Error('private service URL'); } });
  const status = await uncertain.storage.delete(key);
  assert.equal(status.acknowledged, false); assert.equal(status.absentObserved, true); assert.equal(status.historyErasureVerified, false);
  assert.equal(uncertain.calls.filter(call => call.action === 'delete').length, 1);
  const versioned = fixture({ remove: () => ({ res: { status: 204, headers: { 'x-oss-delete-marker': 'true' } } }) });
  assert.equal((await versioned.storage.delete(key)).versionMarkerObserved, true);
  const arbitrary404 = fixture({ head: () => { throw Object.assign(new Error('raw secret detail'), { status: 404 }); } });
  await assert.rejects(arbitrary404.storage.read(key, { expected: expected() }), error => error.message === 'PHOTO_OUTPUT_STORAGE_READ_UNCONFIRMED');
  const unknown = await arbitrary404.storage.delete(key); assert.equal(unknown.observation, 'unknown');
  const missing = fixture({ head: () => { throw absent(); } }); assert.deepEqual(await missing.storage.read(key, { expected: expected() }), { found: false });
});
