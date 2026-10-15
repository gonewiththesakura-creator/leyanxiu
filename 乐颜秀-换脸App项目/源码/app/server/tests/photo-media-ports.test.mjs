import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPhotoMediaPorts } from '../photo-jobs/media-ports.js';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { createPhotoJobContext, photoContextSchema } from '../photo-jobs/context.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAO0lEQVR4nO3RQREAMAjEwKN+6qVykF8J4cMvK+CYCXVfZ9NZXY8HBvwBMhEyETIRMhEyUcgHKU4BNULpqU8AAAAASUVORK5CYII=', 'base64');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const media = (bytes = png) => ({ bytes: Buffer.from(bytes), sha256: digest(bytes), byteLength: bytes.length, contentType: 'image/png' });
const sourceKey = `private/mini-photo-input/${'a'.repeat(32)}.png`, outputKey = `private/photo-outputs/${'b'.repeat(32)}.png`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(overrides = {}) {
  const calls = [];
  const asset = { assetId: 'input1', assetKind: 'input', kind: 'image', storageKey: sourceKey, sha256: digest(png),
    byteLength: png.length, contentType: 'image/png', expiresAt: 200000 };
  const dependencies = {
    context: { async readOwnedAsset(userId, assetId) { calls.push({ method: 'owned', userId, assetId }); return userId === 'buyer' && assetId === 'input1' ? { ...asset } : null; } },
    inputStorage: { async read(key, options) { calls.push({ method: 'input.read', key, options }); return { found: true, ...media() }; },
      signedUrl() { assert.fail('input signed URLs are forbidden'); } },
    outputStorage: { async put(key, bytes, options) { calls.push({ method: 'output.put', key, bytes, options }); return { stored: true }; },
      async read(key, options) { calls.push({ method: 'output.read', key, options }); return { found: true, ...media() }; } },
    provider: { async generate(value) { calls.push({ method: 'generate', value }); return { provider: 'fixture', model: 'fixture', requestId: 'fixture_receipt', url: 'https://fixture.invalid/result' }; },
      async readGenerated(value) { calls.push({ method: 'readGenerated', value }); return media(); } },
    marker: { async mark(value) { calls.push({ method: 'mark', value }); return { ...media(), verified: true, contentId: value.contentId, operation: value.operation, labelVersion: value.labelVersion }; } },
    moderator: { async moderate(value) { calls.push({ method: 'moderate', value }); return { decision: 'allow' }; } },
    ...overrides,
  };
  return { asset, calls, dependencies, ports: createPhotoMediaPorts(dependencies) };
}

test('owned source uses bytes, exact context metadata and a second authorization without issuing a source URL', async () => {
  const f = fixture(); const result = await f.ports.readInput({ userId: 'buyer', assetId: 'input1' });
  assert.deepEqual(result, media()); assert.deepEqual(f.calls.map(call => call.method), ['owned', 'input.read', 'owned']);
  assert.equal(f.calls[1].key, sourceKey); assert.deepEqual(f.calls[1].options, { timeoutMs: 10000 });
  assert.equal(result.storageKey, undefined); assert.equal(result.url, undefined);
});

test('output asset, display-only kind, cross-owner and invalid source prefix never reach object storage', async () => {
  for (const mutation of [{ assetKind: 'output' }, { assetKind: undefined }, { assetId: 'another' }, { byteLength: undefined },
    { storageKey: outputKey }, { storageKey: 'https://fixture.invalid/input' }, { storageKey: sourceKey.replace('private/', '../') }]) {
    const f = fixture(); Object.assign(f.asset, mutation);
    await assert.rejects(f.ports.readInput({ userId: 'buyer', assetId: 'input1' }), /INPUT_NOT_AUTHORIZED/);
    assert.equal(f.calls.some(call => call.method === 'input.read'), false);
  }
  const f = fixture();
  await assert.rejects(f.ports.readInput({ userId: 'stranger', assetId: 'input1' }), /INPUT_NOT_AUTHORIZED/);
  assert.equal(f.calls.some(call => call.method === 'input.read'), false);
});

test('input missing, changed SHA/length/MIME and false metadata cannot pass the frozen asset contract', async () => {
  const changed = Buffer.from(png); changed[40] ^= 1;
  for (const value of [{ found: false }, { found: true, ...media(changed) }, { found: true, ...media(), sha256: '0'.repeat(64) },
    { found: true, ...media(), byteLength: png.length - 1 }, { found: true, ...media(), contentType: 'image/jpeg' }]) {
    const f = fixture({ inputStorage: { read: async () => value } });
    await assert.rejects(f.ports.readInput({ userId: 'buyer', assetId: 'input1' }), /UNCONFIRMED/);
  }
});

test('late object read after withdrawal, expiry or metadata change cannot return private input bytes', async () => {
  for (const mode of ['withdraw', 'changed']) {
    const gate = deferred(), started = deferred(); let available = true;
    const f = fixture({ inputStorage: { async read() { started.resolve(); await gate.promise; return { found: true, ...media() }; } } });
    const owned = f.dependencies.context.readOwnedAsset.bind(f.dependencies.context);
    const ports = createPhotoMediaPorts({ ...f.dependencies, context: { async readOwnedAsset(...args) { return available ? owned(...args) : null; } } });
    const pending = ports.readInput({ userId: 'buyer', assetId: 'input1' }); await started.promise;
    if (mode === 'withdraw') available = false; else f.asset.expiresAt++;
    gate.resolve(); await assert.rejects(pending, /INPUT_NOT_AUTHORIZED/);
  }
});

test('generate snapshots bytes and nested server spec before provider await and preserves only one dispatch', async () => {
  const gate = deferred(); let captured, calls = 0;
  const f = fixture({ provider: { async generate(value) { calls++; await gate.promise; captured = value; return { requestId: 'original' }; }, readGenerated: async () => media() } });
  const input = media(), spec = { provider: 'fixture', effectParameters: { prompt: 'original' } };
  const pending = f.ports.generate({ input, spec }); input.bytes.fill(0); spec.effectParameters.prompt = 'mutated'; gate.resolve();
  assert.deepEqual(await pending, { requestId: 'original' }); assert.equal(calls, 1);
  assert.deepEqual(captured.input.bytes, png); assert.equal(captured.spec.effectParameters.prompt, 'original');
  assert.equal(input.bytes.equals(png), false);
});

test('generated bytes and mark receipt are normalized; wrong contentId, operation, version or proof cannot claim verified output', async () => {
  const f = fixture(); assert.deepEqual(await f.ports.readGenerated({ url: 'https://fixture.invalid/result' }), media());
  assert.deepEqual(f.calls[0].value, { url: 'https://fixture.invalid/result' });
  for (const mutation of [{ verified: false }, { verified: 'true' }, { contentId: 'other' }, { operation: 'generate' }, { labelVersion: 'other' }]) {
    const f = fixture({ marker: { mark: async value => ({ ...media(), verified: true, contentId: value.contentId, operation: value.operation, labelVersion: value.labelVersion, ...mutation }) } });
    await assert.rejects(f.ports.mark({ ...media(), contentId: 'job1', operation: 'edit', labelVersion: 'mark1' }), /MARK_UNCONFIRMED/);
  }
  const marked = await f.ports.mark({ ...media(), contentId: 'job1', operation: 'edit', labelVersion: 'mark1' });
  assert.equal(marked.verified, true); assert.equal(marked.contentId, 'job1'); assert.deepEqual(marked.bytes, png);
});

test('output adapters pass immutable key, expected SHA and bounded timeout without creating signed URLs', async () => {
  const f = fixture(); const input = Buffer.from(png);
  await f.ports.output.put({ key: outputKey, bytes: input, contentType: 'image/png' }); input.fill(0);
  assert.deepEqual(f.calls[0].bytes, png); assert.deepEqual(f.calls[0].options, { contentType: 'image/png', timeoutMs: 10000 });
  const expected = { sha256: digest(png), byteLength: png.length, contentType: 'image/png' };
  assert.deepEqual(await f.ports.output.read({ key: outputKey, expected }), { found: true, ...media() });
  assert.deepEqual(f.calls[1].options, { expected, timeoutMs: 10000 });
  const missing = fixture({ outputStorage: { put: async () => {}, read: async () => ({ found: false }) } });
  assert.deepEqual(await missing.ports.output.read({ key: outputKey, expected }), { found: false });
  const wrong = fixture({ outputStorage: { put: async () => {}, read: async () => ({ found: true, ...media(Buffer.alloc(png.length, 5)) }) } });
  await assert.rejects(wrong.ports.output.read({ key: outputKey, expected }), /OUTPUT_UNCONFIRMED/);
  await assert.rejects(f.ports.output.put({ key: sourceKey, bytes: png, contentType: 'image/png' }), /OUTPUT_INVALID/);
  await assert.rejects(f.ports.output.read({ key: outputKey, expected: {} }), /OUTPUT_INVALID/);
});

test('moderation receives copied final bytes and the same durable journal exactly once', async () => {
  const gate = deferred(); let captured;
  const f = fixture({ moderator: { async moderate(value) { await gate.promise; captured = value; return { decision: 'allow' }; } } });
  const bytes = Buffer.from(png), journal = async () => ({ recorded: true });
  const pending = f.ports.moderator.moderate({ bytes, contentType: 'image/png', direction: 'output', journal }); bytes.fill(0); gate.resolve();
  assert.deepEqual(await pending, { decision: 'allow' }); assert.deepEqual(captured.bytes, png); assert.equal(captured.journal, journal);
  await assert.rejects(f.ports.moderator.moderate({ bytes: png, contentType: 'image/png', direction: 'input', journal }), /REVIEW_INVALID/);
  await assert.rejects(f.ports.moderator.moderate({ bytes: png, contentType: 'image/png', direction: 'output' }), /REVIEW_INVALID/);
});

test('real context is the owner, kind, consent epoch and expiry authority for a storage read', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-photo-media-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'isolated.sqlite'), migrate: true });
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let stamp = 100000;
  const ledger = createVirtualLedger({ database, encryptionKey: '1'.repeat(64), now: () => stamp });
  const context = createPhotoJobContext({ ledger, now: () => stamp, policy: { basicVersion: 'basic1', faceVersion: 'face1', labelVersion: 'mark1' } });
  await database.transaction(async q => { for (const ddl of photoContextSchema('sqlite')) await q(ddl);
    for (const user of ['buyer', 'stranger']) await q('INSERT INTO vp_accounts(user_id,app_id,openid) VALUES (?,?,?)', [user, 'fixture_app', user]); });
  await context.grantBasicConsent('buyer', 'basic1'); await context.grantFaceConsent('buyer', { version: 'face1', subjectAuthorization: 'self' });
  await context.registerInput('buyer', { id: 'input1', storageKey: sourceKey, ...media(), expiresAt: stamp + 60000,
    moderation: { decision: 'allow', reference: 'fixture_receipt' } });
  const f = fixture({ context }); assert.deepEqual(await f.ports.readInput({ userId: 'buyer', assetId: 'input1' }), media());
  await assert.rejects(f.ports.readInput({ userId: 'stranger', assetId: 'input1' }), /INPUT_NOT_AUTHORIZED/);
  await context.withdrawFaceConsent('buyer'); await context.grantFaceConsent('buyer', { version: 'face1', subjectAuthorization: 'self' });
  await assert.rejects(f.ports.readInput({ userId: 'buyer', assetId: 'input1' }), /INPUT_NOT_AUTHORIZED/);
  await context.registerInput('buyer', { id: 'input2', storageKey: sourceKey.replace('a'.repeat(32), 'c'.repeat(32)), ...media(), expiresAt: stamp + 500,
    moderation: { decision: 'allow', reference: 'fixture_receipt2' } });
  stamp += 501; await assert.rejects(f.ports.readInput({ userId: 'buyer', assetId: 'input2' }), /INPUT_NOT_AUTHORIZED/);
});
