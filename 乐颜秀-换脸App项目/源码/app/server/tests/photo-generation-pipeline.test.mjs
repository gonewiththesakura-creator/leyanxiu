import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { draftProducts } from '../payments/virtual/products.js';
import { createPhotoJobContext, photoContextSchema } from '../photo-jobs/context.js';
import { photoJobsSchema } from '../photo-jobs/repository.js';
import { createPhotoJobWorker } from '../photo-jobs/worker.js';
import { createPhotoGenerationRepository, photoGenerationSchema } from '../photo-jobs/generation-repository.js';
import { createPhotoGenerationPipeline } from '../photo-jobs/generation-pipeline.js';
import { listPhotoGenerationCleanup, createPhotoGenerationCleanupRepository, createPhotoGenerationCleanupWorker } from '../photo-jobs/generation-cleanup.js';
import { createPhotoOutputOssStorage } from '../photo-jobs/output-storage.js';
import { checkedQwenPhotoResultUrl, QWEN_PHOTO_MODEL, QWEN_PHOTO_PROVIDER, QWEN_PHOTO_RESULT_HOSTS, QWEN_PHOTO_RESULT_POLICY } from '../photo-jobs/qwen-provider.js';

const raw = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XAZkAAAAASUVORK5CYII=', 'base64');
// Synthetic byte fixtures only. Actual marking and Green adapters have separate
// format tests; these tests prove SQL/call-order binding, not AI label validity.
const marked = Buffer.concat([raw, Buffer.from('synthetic-marked-output')]);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const media = bytes => ({ bytes: Buffer.from(bytes), contentType: 'image/png', byteLength: bytes.length, sha256: sha(bytes) });
const policy = { basicVersion: 'basic_v1', faceVersion: 'face_v1', labelVersion: 'label_v1',
  provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL, operation: 'edit',
  moderationVersion: 'review_v1', moderationService: 'aigcCheck', sourceHosts: ['result.example.test'],
  sourceRetentionMs: 86400000, resultRetentionMs: 86400000 };
const qwenResultPolicy = { ...policy, sourceHosts: [...QWEN_PHOTO_RESULT_HOSTS], resultUrlPolicy: QWEN_PHOTO_RESULT_POLICY };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function fixture(t, { claim = true, generationPolicy = policy } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-generation-isolated-'));
  const filename = path.join(directory, 'fixture.sqlite');
  const database = await openVirtualDatabase({ backend: 'sqlite', filename, migrate: true });
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let stamp = 1800000000000; const now = () => stamp;
  const rows = (sql, args = []) => database.transaction(q => q(sql, args));
  await database.transaction(async q => {
    for (const sql of photoContextSchema('sqlite')) await q(sql);
    await q(photoJobsSchema('sqlite'));
    for (const sql of photoGenerationSchema('sqlite')) await q(sql);
  });
  const ledger = createVirtualLedger({ database, encryptionKey: '7'.repeat(64), now });
  const appId = 'wx-fixture-photo'; await ledger.bindEnvironment(appId, 1);
  for (const userId of ['owner', 'other']) await ledger.bindSession({ userId, sessionId: `session_${userId}`, appId,
    openid: `openid_${userId}`, sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const order = await ledger.createOrder({ userId: 'owner', product: draftProducts[0], idempotencyKey: 'funded_generation', appId, env: 1, platform: 'android' });
  await ledger.settle(order.id, { order_id: order.id, env_type: 2, order_fee: order.amountFen, paid_fee: order.amountFen,
    status: 2, order_type: 0, wx_order_id: `wx_${order.id}`, paid_time: Math.floor(now() / 1000), refund_fee: 0, left_fee: order.amountFen });
  const context = createPhotoJobContext({ ledger, policy, now });
  await context.grantBasicConsent('owner', policy.basicVersion);
  await context.grantFaceConsent('owner', { version: policy.faceVersion, subjectAuthorization: 'self' });
  await context.registerInput('owner', { id: 'input_source', storageKey: 'private/source/fixture.png', ...media(raw),
    expiresAt: now() + 86400000, moderation: { decision: 'allow', reference: 'fixture_input_approval' } });
  await context.putEffect({ id: 'repair', version: 'v1', provider: policy.provider, model: policy.model,
    purpose: 'photo-effect:repair', parameters: { prompt: 'synthetic approved effect', n: 1 }, enabled: true, reviewReference: 'fixture_effect_review' });
  const spec = await context.submission({ userId: 'owner', idempotencyKey: 'generation_request_0001', inputAssetId: 'input_source', effectId: 'repair' });
  const { job } = await context.repository.submit(spec);
  const claimed = claim ? await context.repository.claimNext() : null;
  const repository = createPhotoGenerationRepository({ context, policy: generationPolicy, now });
  const counts = { input: 0, generate: 0, download: 0, mark: 0, put: 0, read: 0, review: 0 };
  const objects = new Map();
  const checkIntent = async step => {
    const operation = (await rows('SELECT * FROM mini_photo_generation_operations WHERE job_id = ? AND step = ?', [job.id, step]))[0];
    assert.equal(operation?.state, 'started', `durable ${step} intent precedes call`);
  };
  const ports = {
    async readInput({ userId, assetId }) { await checkIntent('input_read'); counts.input++;
      assert.equal(userId, 'owner'); assert.equal(assetId, 'input_source'); return media(raw); },
    async generate({ input, spec: frozen, ...extra }) { await checkIntent('generate'); counts.generate++;
      assert.deepEqual(extra, {}); assert.deepEqual(input, media(raw)); assert.equal(frozen.provider, policy.provider);
      return { provider: policy.provider, model: policy.model, requestId: 'provider_request_1', url: 'https://result.example.test/result.png?signature=REDACTED_SECRET }; },
    async readGenerated({ url }) { await checkIntent('result_read'); counts.download++;
      assert.equal(new URL(url).hostname, 'result.example.test'); return media(raw); },
    async mark({ contentId, operation, labelVersion }) { await checkIntent('mark'); counts.mark++;
      return { ...media(marked), contentId, operation, labelVersion, verified: true }; },
    output: {
      async put({ key, bytes, contentType }) { await checkIntent('output_put'); counts.put++;
        assert.equal(objects.has(key), false); assert.equal(contentType, 'image/png'); objects.set(key, Buffer.from(bytes)); },
      async read({ key, expected }) { await checkIntent('output_read'); counts.read++;
        assert.deepEqual(expected, { sha256: sha(marked), byteLength: marked.length, contentType: 'image/png' });
        return objects.has(key) ? media(objects.get(key)) : { found: false }; },
    },
    moderator: { async moderate({ bytes, contentType, direction, journal }) {
      await checkIntent('moderate');
      assert.equal(await journal({ reference: 'a'.repeat(32), extension: 'png' }), true);
      const durable = (await rows('SELECT moderation_reference FROM mini_photo_generation WHERE job_id = ?', [job.id]))[0];
      assert.equal(durable.moderation_reference, 'a'.repeat(32)); counts.review++;
      assert.deepEqual(bytes, marked); assert.equal(contentType, 'image/png'); assert.equal(direction, 'output');
      return { provider: 'aliyun-green', policyVersion: policy.moderationVersion, service: policy.moderationService,
        direction, sha256: sha(bytes), byteLength: bytes.length, decision: 'allow', reference: `mod_${'1'.repeat(64)}`,
        requestId: 'green_request_1', cleanupReference: 'a'.repeat(32), cleanupExtension: 'png', cleanupPending: false };
    } },
  };
  const pipeline = overrides => createPhotoGenerationPipeline({ repository, context, ports, ...overrides });
  const input = { jobId: job.id, userId: 'owner', spec: claimed?.spec };
  const refund = () => ledger.applyRefund({ MchOrderId: order.id, OpenId: 'openid_owner', WxOrderId: `wx_${order.id}`,
    WxRefundId: `wx_refund_${order.id}`, MchRefundId: `external_${order.id}`, RefundFee: order.amountFen, RetCode: 0 });
  return { database, filename, context, repository, ledger, job, claimed, input, rows, now, ports, pipeline, counts, objects, refund,
    advance: ms => { stamp += ms; }, reservation: async () => (await rows('SELECT status FROM vp_reservations'))[0].status };
}

test('explicit MySQL DDL matches code, contains metadata only, and does not migrate on import', () => {
  const ddl = fs.readFileSync(new URL('../photo-jobs/generation-schema.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').trim().replace(/;$/, '');
  const normalize = s => s.replace(/\s+/g, ' ').replace(/\s*\)/g, ')').trim();
  assert.equal(normalize(ddl), normalize(photoGenerationSchema('mysql').join('; ')));
  assert.doesNotMatch(ddl, /\bBLOB\b|image_base64|raw_bytes/);
});

test('actual canonical ledger → one generation → final marked byte review → owner work and one consumption', async t => {
  const f = await fixture(t, { claim: false });
  const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: f.pipeline().runProvider });
  const result = await worker.runOnce(); assert.equal(result.state, 'succeeded');
  assert.equal(await f.reservation(), 'consumed'); assert.equal((await f.context.listWorks('owner')).length, 1);
  assert.equal((await f.context.listWorks('other')).length, 0);
  const publicResult = await f.context.repository.readOwned('owner', f.job.id);
  assert.doesNotMatch(JSON.stringify(publicResult), /https:|private\/|signature|provider_request/);
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 1);
  await worker.runOnce(); assert.equal(f.counts.generate, 1);
});

test('same durable generation returns an existing registered asset without repeated paid calls', async t => {
  const f = await fixture(t); const first = await f.pipeline().runProvider(f.input);
  const second = await f.pipeline().runProvider(f.input); assert.deepEqual(second, first);
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.review, 1); assert.equal(f.counts.put, 1);
  assert.equal((await f.rows('SELECT * FROM mini_photo_generation')).length, 1);
  assert.equal(await f.reservation(), 'reserved', 'only old publish path settles rights');
});

test('two independently constructed pipelines race but no generation, PUT or review is dispatched twice', async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.pipeline().runProvider(f.input), f.pipeline().runProvider(f.input)]);
  assert.ok(results.some(item => item.status === 'fulfilled'));
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 1);
});

test('lost generation response keeps a durable unknown and never generates again after reconstruction', async t => {
  const f = await fixture(t); const generate = f.ports.generate;
  f.ports.generate = async args => { await generate(args); throw new Error('synthetic timeout'); };
  await assert.rejects(f.pipeline().runProvider(f.input), /PROVIDER_UNCONFIRMED/);
  const repository = createPhotoGenerationRepository({ context: f.context, policy, now: f.now });
  await assert.rejects(f.pipeline({ repository }).runProvider(f.input), /PROVIDER_UNCONFIRMED/);
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.download, 0); assert.equal(await f.reservation(), 'reserved');
  assert.deepEqual((await repository.operations(f.job.id, 'owner')).find(x => x.step === 'generate'), { step: 'generate', state: 'unknown', attempts: 1 });
});

test('worker records unknown without refund and duplicate workers do not retry the provider', async t => {
  const f = await fixture(t, { claim: false }); const generate = f.ports.generate;
  f.ports.generate = async args => { await generate(args); throw new Error('timeout'); };
  const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: f.pipeline().runProvider });
  assert.equal((await worker.runOnce()).state, 'unknown'); await worker.runOnce();
  assert.equal(f.counts.generate, 1); assert.equal(await f.reservation(), 'reserved');
});

test('receipt committed but response lost is recovered without generation replay or receipt regression', async t => {
  const f = await fixture(t); const repository = { ...f.repository, async saveProviderReceipt(...args) {
    await f.repository.saveProviderReceipt(...args); throw new Error('lost commit reply');
  } };
  await assert.rejects(f.pipeline({ repository }).runProvider(f.input));
  assert.equal((await f.repository.operations(f.job.id, 'owner')).find(x => x.step === 'generate').state, 'succeeded');
  await f.pipeline().runProvider(f.input); assert.equal(f.counts.generate, 1); assert.equal(f.counts.review, 1);
});

test('foreign URL or model receipts cannot be downloaded and cannot trigger replacement generation', async t => {
  for (const change of [{ url: 'https://127.0.0.1/private' }, { url: 'https://result.example.test.attacker.test/result.png' },
    { model: 'different-model' }, { requestId: 'https://private-secret' }]) {
    const f = await fixture(t); const generate = f.ports.generate;
    f.ports.generate = async args => ({ ...await generate(args), ...change });
    await assert.rejects(f.pipeline().runProvider(f.input)); await assert.rejects(f.pipeline().runProvider(f.input));
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.download, 0); assert.equal(f.counts.put, 0);
  }
});

test('versioned Qwen dynamic receipts persist and recover on an independent DB connection without another generation', async t => {
  for (const host of ['dashscope-synthetic-123.oss-accelerate.aliyuncs.com',
    'dashscope-synthetic-a.oss-cn-beijing.aliyuncs.com', 'dashscope-synthetic-b.oss-cn-hangzhou.aliyuncs.com']) {
    const f = await fixture(t, { generationPolicy: qwenResultPolicy });
    const url = `https://${host}/result.png?signature=REDACTED_SECRET
    const generate = f.ports.generate, mark = f.ports.mark;
    f.ports.generate = async args => ({ ...await generate(args), url });
    f.ports.readGenerated = async value => { f.counts.download++;
      assert.equal(value.url, url); assert.equal(checkedQwenPhotoResultUrl(value.url).hostname, host); return media(raw); };
    f.ports.mark = async () => { throw new Error('synthetic restart before marking'); };
    await assert.rejects(f.pipeline().runProvider(f.input));
    const saved = (await f.rows('SELECT provider_receipt,policy FROM mini_photo_generation'))[0];
    assert.equal(JSON.parse(saved.provider_receipt).resultUrl, url);
    assert.equal(JSON.parse(saved.policy).resultUrlPolicy, QWEN_PHOTO_RESULT_POLICY);
    f.ports.mark = mark;
    const database = await openVirtualDatabase({ backend: 'sqlite', filename: f.filename });
    try {
      const context = createPhotoJobContext({ ledger: createVirtualLedger({ database, encryptionKey: '7'.repeat(64), now: f.now }), policy, now: f.now });
      const repository = createPhotoGenerationRepository({ context, policy: qwenResultPolicy, now: f.now });
      assert.equal((await repository.read(f.job.id, 'owner')).providerReceipt.resultUrl, url);
      const result = await createPhotoGenerationPipeline({ repository, context, ports: f.ports }).runProvider(f.input);
      await context.repository.recordResult(f.job.id, f.claimed.claim_token, result);
      assert.equal((await context.repository.publishNext()).state, 'succeeded');
      assert.doesNotMatch(JSON.stringify(await context.repository.readOwned('owner', f.job.id)), /https:|signature|provider_request/);
    } finally { await database.close(); }
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 1);
    assert.equal(await f.reservation(), 'consumed');
  }
});

test('Qwen versioned policy rejects lookalike/internal/customer hosts even if sourceHosts includes them', async t => {
  for (const url of ['https://dashscope-synthetic.oss-cn-beijing.aliyuncs.com.attacker.test/result.png',
    'https://customer-bucket.oss-cn-beijing.aliyuncs.com/result.png',
    'https://dashscope-synthetic.oss-cn-beijing-internal.aliyuncs.com/result.png',
    'https://dashscope-synthetic.oss-cn-internal.aliyuncs.com/result.png',
    'https://dashscope-synthetic.oss-accelerate.aliyuncs.com:443/result.png',
    'https://dashscope-synthetic.oss-accelerate.aliyuncs.com@attacker.test/result.png',
    'https://%64ashscope-synthetic.oss-accelerate.aliyuncs.com/result.png']) {
    const f = await fixture(t, { generationPolicy: { ...qwenResultPolicy, sourceHosts: [new URL(url).hostname] } });
    const generate = f.ports.generate;
    f.ports.generate = async args => ({ ...await generate(args), url });
    await assert.rejects(f.pipeline().runProvider(f.input), /PROVIDER_UNCONFIRMED/);
    await assert.rejects(f.pipeline().runProvider(f.input), /PROVIDER_UNCONFIRMED/);
    assert.equal((await f.rows('SELECT provider_receipt FROM mini_photo_generation'))[0].provider_receipt, null);
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.download, 0); assert.equal(f.counts.put, 0); assert.equal(f.counts.review, 0);
    assert.equal(await f.reservation(), 'reserved');
  }
});

test('Qwen dynamic result policy requires the exact provider, model and supported policy version', async t => {
  const f = await fixture(t);
  for (const change of [{ provider: 'other-provider' }, { model: 'different-model' }, { model: 'qwen-image-edit-plus-2025-12-15' },
    { resultUrlPolicy: `${QWEN_PHOTO_RESULT_POLICY}-unreviewed` }, { resultUrlPolicy: null }]) {
    assert.throws(() => createPhotoGenerationRepository({ context: f.context, policy: { ...qwenResultPolicy, ...change }, now: f.now }), /POLICY_REQUIRED/);
  }
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_generation'))[0].n, 0);
  assert.equal(f.counts.generate, 0);
});

test('dynamic URL syntax never substitutes for the fixed provider/model receipt identity', async t => {
  for (const change of [{ provider: `${QWEN_PHOTO_PROVIDER}-other` }, { model: `${QWEN_PHOTO_MODEL}-other` },
    { model: 'qwen-image-edit-plus-2025-12-15' }]) {
    const f = await fixture(t, { generationPolicy: qwenResultPolicy }); const generate = f.ports.generate;
    f.ports.generate = async args => ({ ...await generate(args), url: 'https://dashscope-synthetic.oss-accelerate.aliyuncs.com/result.png', ...change });
    await assert.rejects(f.pipeline().runProvider(f.input), /PROVIDER_UNCONFIRMED/);
    assert.equal((await f.rows('SELECT provider_receipt FROM mini_photo_generation'))[0].provider_receipt, null);
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.download, 0);
  }
});

test('legacy exact-host unknown records retain the old policy bytes and cannot be widened on reconstruction', async t => {
  const f = await fixture(t); const generate = f.ports.generate;
  f.ports.generate = async args => ({ ...await generate(args), url: 'https://dashscope-synthetic.oss-accelerate.aliyuncs.com/result.png' });
  await assert.rejects(f.pipeline().runProvider(f.input), /PROVIDER_UNCONFIRMED/);
  const before = (await f.rows('SELECT policy,provider_receipt FROM mini_photo_generation'))[0];
  assert.equal(Object.hasOwn(JSON.parse(before.policy), 'resultUrlPolicy'), false);
  assert.equal(before.provider_receipt, null);
  const widened = createPhotoGenerationRepository({ context: f.context, policy: { ...policy, resultUrlPolicy: QWEN_PHOTO_RESULT_POLICY }, now: f.now });
  await assert.rejects(widened.read(f.job.id, 'owner'), /POLICY_CONFLICT/);
  await assert.rejects(f.pipeline({ repository: widened }).runProvider(f.input), /POLICY_CONFLICT/);
  await assert.rejects(f.pipeline().runProvider(f.input), /PROVIDER_UNCONFIRMED/);
  assert.deepEqual((await f.rows('SELECT policy,provider_receipt FROM mini_photo_generation'))[0], before);
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.download, 0); assert.equal(await f.reservation(), 'reserved');
});

test('a forged stored receipt is rejected again before any recovery download under either policy', async t => {
  for (const generationPolicy of [policy, qwenResultPolicy]) {
    const f = await fixture(t, { generationPolicy }); const generate = f.ports.generate;
    const url = generationPolicy.resultUrlPolicy ? 'https://dashscope-synthetic.oss-cn-beijing.aliyuncs.com/result.png' : 'https://result.example.test/result.png';
    f.ports.generate = async args => ({ ...await generate(args), url });
    f.ports.readGenerated = async () => { f.counts.download++; return media(raw); };
    f.ports.mark = async () => { throw new Error('local interruption'); };
    await assert.rejects(f.pipeline().runProvider(f.input));
    const original = (await f.rows('SELECT provider_receipt FROM mini_photo_generation'))[0];
    const altered = { ...JSON.parse(original.provider_receipt), resultUrl: 'https://dashscope-synthetic.oss-cn-beijing.aliyuncs.com.attacker.test/result.png' };
    await f.rows('UPDATE mini_photo_generation SET provider_receipt = ? WHERE job_id = ?', [JSON.stringify(altered), f.job.id]);
    const repository = createPhotoGenerationRepository({ context: f.context, policy: generationPolicy, now: f.now });
    await assert.rejects(repository.read(f.job.id, 'owner'), /RECEIPT_INVALID/);
    await assert.rejects(f.pipeline({ repository }).runProvider(f.input), /RECEIPT_INVALID/);
    assert.equal(f.counts.generate, 1); assert.equal(f.counts.download, 1); assert.equal(f.counts.put, 0); assert.equal(f.counts.review, 0);
  }
});

test('mark failure resumes from a persisted provider receipt without another generation', async t => {
  const f = await fixture(t); const mark = f.ports.mark; let first = true;
  f.ports.mark = async args => { if (first) { first = false; throw new Error('local marker unavailable'); } return mark(args); };
  await assert.rejects(f.pipeline().runProvider(f.input)); await f.pipeline().runProvider(f.input);
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.download, 2); assert.equal(f.counts.put, 1);
});

test('lost output PUT response only performs authenticated read; missing object never permits another PUT', async t => {
  for (const store of [true, false]) {
    const f = await fixture(t); const put = f.ports.output.put;
    f.ports.output.put = async args => { if (store) await put(args); else f.counts.put++; throw new Error('lost PUT'); };
    await assert.rejects(f.pipeline().runProvider(f.input), /OUTPUT_UNCONFIRMED/);
    if (store) await f.pipeline().runProvider(f.input);
    else { await assert.rejects(f.pipeline().runProvider(f.input)); await assert.rejects(f.pipeline().runProvider(f.input)); }
    assert.equal(f.counts.put, 1); assert.equal(f.counts.generate, 1); assert.equal(f.counts.review, store ? 1 : 0);
  }
});

test('stored byte hash mismatch blocks moderation even when PUT replied successfully', async t => {
  const f = await fixture(t); const put = f.ports.output.put;
  f.ports.output.put = async args => { await put(args); f.objects.set(args.key, raw); };
  await assert.rejects(f.pipeline().runProvider(f.input), /OUTPUT_UNCONFIRMED/);
  assert.equal(f.counts.review, 0); assert.equal((await f.rows("SELECT * FROM mini_photo_assets WHERE kind='output'")).length, 0);
});

test('a lost or mismatched final-byte review is never automatically purchased again', async t => {
  for (const change of [null, { sha256: sha(raw) }, { direction: 'input' }, { policyVersion: 'old' }, { service: 'baselineCheck' },
    { cleanupReference: 'b'.repeat(32) }, { decision: 'unconfirmed' }]) {
    const f = await fixture(t); const moderate = f.ports.moderator.moderate;
    f.ports.moderator.moderate = async args => { const receipt = await moderate(args); if (!change) throw new Error('lost Green reply'); return { ...receipt, ...change }; };
    await assert.rejects(f.pipeline().runProvider(f.input)); await assert.rejects(f.pipeline().runProvider(f.input));
    assert.equal(f.counts.review, 1); assert.equal(f.counts.generate, 1); assert.equal(await f.reservation(), 'reserved');
    const row = await f.repository.read(f.job.id, 'owner'); assert.equal(row.moderation_cleanup_pending, 1); assert.equal(row.moderation_reference, 'a'.repeat(32));
  }
});

test('persisted block/review verdict never registers a work or compensates unknown rights', async t => {
  for (const decision of ['block', 'review']) {
    const f = await fixture(t); const moderate = f.ports.moderator.moderate;
    f.ports.moderator.moderate = async args => ({ ...await moderate(args), decision });
    await assert.rejects(f.pipeline().runProvider(f.input), /REVIEW_BLOCKED/);
    await assert.rejects(f.pipeline().runProvider(f.input), /REVIEW_BLOCKED/);
    assert.equal(f.counts.review, 1); assert.equal((await f.context.listWorks('owner')).length, 0); assert.equal(await f.reservation(), 'reserved');
  }
});

test('lost successful review commit response is recoverable without repeating Green', async t => {
  const f = await fixture(t); const repository = { ...f.repository, async saveReview(...args) {
    await f.repository.saveReview(...args); throw new Error('lost database reply');
  } };
  await assert.rejects(f.pipeline({ repository }).runProvider(f.input)); await f.pipeline().runProvider(f.input);
  assert.equal(f.counts.review, 1); assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 1);
});

test('withdrawal or channel refund between claim and dispatch prevents the external generation', async t => {
  for (const action of ['withdraw', 'refund']) {
    const f = await fixture(t);
    if (action === 'withdraw') await f.context.withdrawFaceConsent('owner'); else await f.refund();
    await assert.rejects(f.pipeline().runProvider(f.input), /NOT_AUTHORIZED/);
    assert.equal(f.counts.generate, 0); assert.equal(f.counts.input, 0);
  }
});

test('refund after input read is rechecked at generation intent; no paid call starts', async t => {
  const f = await fixture(t); const read = f.ports.readInput;
  f.ports.readInput = async args => { const value = await read(args); await f.refund(); return value; };
  await assert.rejects(f.pipeline().runProvider(f.input)); assert.equal(f.counts.generate, 0);
});

test('withdrawal while generation is in flight retains its private receipt but forbids download, review and publication', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); const generate = f.ports.generate;
  f.ports.generate = async args => { const result = await generate(args); entered.resolve(); await release.promise; return result; };
  const pending = f.pipeline().runProvider(f.input); await entered.promise; await f.context.withdrawFaceConsent('owner'); release.resolve();
  await assert.rejects(pending); assert.ok((await f.repository.read(f.job.id, 'owner')).providerReceipt);
  assert.equal(f.counts.download, 0); assert.equal(f.counts.review, 0); assert.equal((await f.context.listWorks('owner')).length, 0);
});

test('withdrawal before moderation scratch journal prevents its PUT and Green side effects', async t => {
  const f = await fixture(t); const moderate = f.ports.moderator.moderate;
  f.ports.moderator.moderate = async args => { await f.context.withdrawFaceConsent('owner'); return moderate(args); };
  await assert.rejects(f.pipeline().runProvider(f.input)); assert.equal(f.counts.review, 0);
  assert.equal((await f.repository.read(f.job.id, 'owner')).moderation_reference, null);
});

test('channel refund after final review forbids output registration and does not restore spent rights', async t => {
  const f = await fixture(t); const moderate = f.ports.moderator.moderate;
  f.ports.moderator.moderate = async args => { const result = await moderate(args); await f.refund(); return result; };
  await assert.rejects(f.pipeline().runProvider(f.input)); assert.equal((await f.rows("SELECT * FROM mini_photo_assets WHERE kind='output'")).length, 0);
  assert.equal((await f.context.listWorks('owner')).length, 0); assert.equal((await f.rows('SELECT remaining FROM vp_buckets'))[0].remaining, 0);
});

test('lost register reply retries only idempotent asset registration and retains one output', async t => {
  const f = await fixture(t); let first = true;
  const context = { ...f.context, async registerOutput(...args) { const result = await f.context.registerOutput(...args);
    if (first) { first = false; throw new Error('lost registration reply'); } return result; } };
  await assert.rejects(f.pipeline({ context }).runProvider(f.input)); await f.pipeline().runProvider(f.input);
  assert.equal((await f.rows("SELECT * FROM mini_photo_assets WHERE kind='output'")).length, 1);
  assert.equal(f.counts.review, 1); assert.equal(f.counts.generate, 1);
});

test('complete registered output can recover original unknown claim into DB-only publication exactly once', async t => {
  const f = await fixture(t); await f.pipeline().runProvider(f.input);
  await f.context.repository.recordUnknown(f.job.id, f.claimed.claim_token);
  assert.equal((await f.repository.recordRecoveredResult(f.job.id, 'owner')).state, 'result_ready');
  assert.equal((await f.context.repository.publishNext()).state, 'succeeded');
  assert.equal((await f.repository.recordRecoveredResult(f.job.id, 'owner')).state, 'succeeded');
  assert.equal(await f.reservation(), 'consumed'); assert.equal((await f.context.listWorks('owner')).length, 1);
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.review, 1);
  assert.equal((await f.rows('SELECT claim_token,attempt FROM mini_photo_jobs'))[0].claim_token, f.claimed.claim_token);
});

test('complete-output recovery still rejects refund/revocation and cannot expose another owner asset', async t => {
  for (const action of ['refund', 'withdraw']) {
    const f = await fixture(t); await f.pipeline().runProvider(f.input);
    await f.context.repository.recordUnknown(f.job.id, f.claimed.claim_token);
    await assert.rejects(f.repository.recordRecoveredResult(f.job.id, 'other'), /JOB_REQUIRED/);
    if (action === 'refund') await f.refund(); else await f.context.withdrawFaceConsent('owner');
    await assert.rejects(f.repository.recordRecoveredResult(f.job.id, 'owner'), /NOT_AUTHORIZED/);
    assert.equal((await f.context.listWorks('owner')).length, 0);
  }
});

test('partial unknown cannot use completion recovery or reset the original claim', async t => {
  const f = await fixture(t); f.ports.generate = async () => { throw new Error('unknown'); };
  await assert.rejects(f.pipeline().runProvider(f.input)); await f.context.repository.recordUnknown(f.job.id, f.claimed.claim_token);
  await assert.rejects(f.repository.recordRecoveredResult(f.job.id, 'owner'), /RECOVERY_NOT_READY/);
  assert.equal((await f.context.repository.readOwned('owner', f.job.id)).state, 'unknown'); assert.equal(await f.reservation(), 'reserved');
});

test('cleanup exposes only private internal object responsibility and never declares permanent erasure', async t => {
  const f = await fixture(t); await f.pipeline().runProvider(f.input);
  const before = await listPhotoGenerationCleanup({ database: f.database, now: f.now, inFlightGraceMs: 300000 });
  assert.equal(before.items.length, 1); assert.equal(before.items[0].kind, 'moderation');
  await f.context.withdrawFaceConsent('owner');
  const after = await listPhotoGenerationCleanup({ database: f.database, now: f.now, inFlightGraceMs: 300000 });
  assert.deepEqual(after.items.map(x => x.kind).sort(), ['moderation', 'output']);
  assert.ok(after.items.every(x => x.deletionPending === true));
  assert.doesNotMatch(JSON.stringify(after), /https:|signature|permanentErasureConfirmed.*true/);
});

test('input deletion without an epoch change still discovers its private output for cleanup', async t => {
  const f = await fixture(t); await f.pipeline().runProvider(f.input);
  const epoch = (await f.rows('SELECT consent_epoch FROM mini_photo_accounts'))[0].consent_epoch;
  await f.context.deleteAsset('owner', 'input_source');
  assert.equal((await f.rows('SELECT consent_epoch FROM mini_photo_accounts'))[0].consent_epoch, epoch);
  const result = await listPhotoGenerationCleanup({ database: f.database, now: f.now, inFlightGraceMs: 300000 });
  assert.ok(result.items.some(item => item.kind === 'output'));
});

test('cleanup discovery advances across more than 100 private responsibilities without an unbounded scan', async t => {
  const f = await fixture(t); await f.repository.open(f.input);
  const original = await f.repository.read(f.job.id, 'owner');
  await f.rows('DELETE FROM mini_photo_generation WHERE job_id = ?', [f.job.id]);
  await f.database.transaction(async q => {
    const job = (await q('SELECT * FROM mini_photo_jobs WHERE id = ?', [f.job.id]))[0];
    for (let index = 0; index < 105; index++) {
      const id = `photo_fixture_${String(index).padStart(4, '0')}`;
      await q(`INSERT INTO mini_photo_jobs(id,user_id,idem,spec,spec_hash,billing_ref,state,claim_token,attempt,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?, ?,1,?,?)`, [id, 'owner', id, job.spec, job.spec_hash, id, 'unknown', job.claim_token, f.now(), f.now()]);
      await q(`INSERT INTO mini_photo_generation(job_id,user_id,spec_hash,policy,asset_id,output_key,expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [id, 'owner', job.spec_hash, JSON.stringify(original.policy), `asset_${index}`,
        `private/photo-outputs/${index.toString(16).padStart(32, '0')}.png`, f.now() - 1, f.now(), f.now()]);
    }
  });
  const first = await listPhotoGenerationCleanup({ database: f.database, now: f.now, inFlightGraceMs: 300000 });
  assert.equal(first.items.length, 100); assert.ok(first.nextCursor);
  const second = await listPhotoGenerationCleanup({ database: f.database, now: f.now, inFlightGraceMs: 300000, afterJobId: first.nextCursor });
  assert.equal(second.items.length, 5); assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.jobId)).size, 105);
});

test('a second independent SQLite connection recovers persisted provider state without another generation', async t => {
  const f = await fixture(t); const mark = f.ports.mark;
  f.ports.mark = async () => { throw new Error('local marker stopped'); };
  await assert.rejects(f.pipeline().runProvider(f.input)); f.ports.mark = mark;
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: f.filename });
  try {
    const context = createPhotoJobContext({ ledger: createVirtualLedger({ database, encryptionKey: '7'.repeat(64), now: f.now }), policy, now: f.now });
    const repository = createPhotoGenerationRepository({ context, policy, now: f.now });
    await createPhotoGenerationPipeline({ repository, context, ports: f.ports }).runProvider(f.input);
  } finally { await database.close(); }
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.review, 1);
});

test('original worker unknown after lost PUT recovers from bytes, one review and controlled registration without resetting claim', async t => {
  const f = await fixture(t, { claim: false }); const put = f.ports.output.put;
  f.ports.output.put = async args => { await put(args); throw new Error('lost PUT response'); };
  const worker = createPhotoJobWorker({ repository: f.context.repository, runProvider: f.pipeline().runProvider });
  assert.equal((await worker.runOnce()).state, 'unknown');
  const original = (await f.rows('SELECT * FROM mini_photo_jobs'))[0];
  await f.pipeline().runProvider({ ...f.input, spec: JSON.parse(original.spec) });
  assert.equal((await f.context.repository.readOwned('owner', f.job.id)).state, 'unknown');
  await f.repository.recordRecoveredResult(f.job.id, 'owner');
  assert.equal((await worker.runOnce()).state, 'succeeded');
  assert.equal((await f.rows('SELECT claim_token FROM mini_photo_jobs'))[0].claim_token, original.claim_token);
  assert.equal(f.counts.put, 1); assert.equal(f.counts.generate, 1); assert.equal(f.counts.review, 1);
  assert.equal(await f.reservation(), 'consumed');
});

function cleanupFixture(f) {
  const objects = new Map(); const calls = [];
  const repository = createPhotoGenerationCleanupRepository({ context: f.context, now: f.now });
  const settings = { timeoutMs: 20, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000, claimHoldMs: 1040 };
  const storage = {
    async delete(storageKey) {
      const records = await repository.cleanupJournal(f.job.id);
      assert.ok(records.some(row => row.storage_key === storageKey && row.state === 'observing' && row.operation_token), 'delete intent committed before IO');
      calls.push(storageKey); objects.delete(storageKey); return { acknowledged: true };
    },
    async inspect(storageKey) { return { found: objects.has(storageKey) }; },
  };
  const worker = overrides => createPhotoGenerationCleanupWorker({ repository, outputStorage: storage, moderationStorage: storage, policy: settings, ...overrides });
  return { repository, settings, storage, worker, objects, calls };
}

test('real OSS adapter accepts generated immutable key, verifies output and cleans only exact eligible keys (mock SDK)', async t => {
  const f = await fixture(t); const objects = new Map(), calls = [];
  const missing = () => Object.assign(new Error('synthetic absence'), { code: 'NoSuchKey', status: 404 });
  const headers = item => ({ 'content-type': item.contentType, 'content-length': String(item.bytes.length),
    'x-oss-meta-sha256': sha(item.bytes), etag: '"fixture-etag"' });
  const storage = createPhotoOutputOssStorage({ bucket: 'fixture-private', region: 'cn-shanghai', now: f.now, client: {
    async put(key, bytes, options) { calls.push('put'); assert.match(key, /^private\/photo-outputs\/[a-f0-9]{32}\.png$/);
      assert.equal(options.headers['x-oss-forbid-overwrite'], 'true'); assert.equal(options.headers['x-oss-object-acl'], 'private');
      assert.equal(objects.has(key), false); objects.set(key, { bytes: Buffer.from(bytes), contentType: options.headers['Content-Type'] }); return { res: { status: 200 } }; },
    async head(key) { const item = objects.get(key); if (!item) throw missing(); return { res: { status: 200, headers: headers(item) } }; },
    async get(key) { calls.push('get'); const item = objects.get(key); if (!item) throw missing(); return { content: Buffer.from(item.bytes), res: { status: 200, headers: headers(item) } }; },
    async delete(key) { const journal = (await f.rows('SELECT * FROM mini_photo_generation_cleanup WHERE storage_key = ?', [key]))[0];
      assert.equal(journal.state, 'observing'); calls.push('delete'); objects.delete(key); return { res: { status: 204, headers: {} } }; },
  } });
  f.ports.output = { put: ({ key, bytes, contentType }) => storage.put(key, bytes, { contentType, timeoutMs: 100 }),
    read: ({ key, expected }) => storage.read(key, { expected, timeoutMs: 100 }) };
  await f.pipeline().runProvider(f.input); assert.deepEqual(calls, ['put', 'get']);
  const c = cleanupFixture(f); await f.context.deleteAsset('owner', 'input_source');
  const worker = c.worker({ outputStorage: storage });
  await worker.runOnce(); await worker.runOnce();
  assert.equal(objects.size, 0); assert.equal(calls.filter(x => x === 'delete').length, 1);
  const output = (await c.repository.cleanupJournal(f.job.id)).find(x => x.kind === 'output');
  assert.equal(output.state, 'absent_observed'); assert.equal(output.absent_observations, 1); assert.ok(output.next_at > f.now());
});

test('cleanup preserves usable output, then withdrawal admits only one concurrent deletion per responsibility', async t => {
  const f = await fixture(t); await f.pipeline().runProvider(f.input); const c = cleanupFixture(f);
  const generation = await f.repository.read(f.job.id, 'owner'); c.objects.set(generation.output_key, marked);
  await c.worker().runOnce(); assert.equal(c.calls.length, 1); assert.match(c.calls[0], /photo-moderation/);
  assert.equal(c.objects.has(generation.output_key), true);
  await f.context.withdrawFaceConsent('owner');
  await Promise.all(Array.from({ length: 12 }, () => c.worker().runOnce()));
  assert.equal(c.calls.filter(key => key === generation.output_key).length, 1);
  assert.equal(c.objects.has(generation.output_key), false); assert.equal(f.counts.generate, 1);
});

test('delete response loss retains unknown and a scheduled retry, never an erasure claim', async t => {
  const f = await fixture(t); await f.pipeline().runProvider(f.input); const c = cleanupFixture(f);
  const storage = { ...c.storage, async delete(key) { await c.storage.delete(key); throw new Error('lost delete response'); } };
  const result = await c.worker({ moderationStorage: storage }).runOnce();
  assert.equal(result.acknowledged, false); assert.equal(result.observation, 'absent'); assert.equal(result.permanentErasureConfirmed, false);
  assert.equal((await c.repository.cleanupJournal(f.job.id))[0].state, 'unknown');
  f.advance(1000); await c.worker().runOnce();
  const row = (await c.repository.cleanupJournal(f.job.id))[0]; assert.equal(row.state, 'absent_observed'); assert.equal(row.attempts, 2);
});

test('DELETE then absent HEAD cannot hide a late output PUT; durable recheck removes it without regeneration', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); const put = f.ports.output.put;
  f.ports.output.put = async args => { entered.resolve(); await release.promise; await put(args); };
  const pending = f.pipeline().runProvider(f.input); await entered.promise;
  const c = cleanupFixture(f); c.objects = f.objects;
  const storage = { async delete(key) { c.calls.push(key); f.objects.delete(key); return { acknowledged: true }; },
    async inspect(key) { return { found: f.objects.has(key) }; } };
  await f.context.withdrawFaceConsent('owner');
  const worker = c.worker({ outputStorage: storage });
  const first = await worker.runOnce(); assert.equal(first.observation, 'absent'); assert.equal(first.permanentErasureConfirmed, false);
  release.resolve(); await assert.rejects(pending); assert.equal(f.objects.size, 1);
  f.advance(5000); const second = await worker.runOnce();
  assert.equal(second.observation, 'absent'); assert.equal(f.objects.size, 0); assert.equal(c.calls.length, 2);
  assert.equal((await c.repository.cleanupJournal(f.job.id))[0].absent_observations, 2);
  assert.equal(f.counts.generate, 1); assert.equal(f.counts.put, 1); assert.equal(f.counts.review, 0);
});

test('cleanup process reconstruction resumes committed delete intent; a stale observation cannot replace a newer claim', async t => {
  const f = await fixture(t); await f.pipeline().runProvider(f.input); const c = cleanupFixture(f);
  await c.repository.prepareCleanup(c.settings); const old = await c.repository.claimCleanup(c.settings);
  assert.ok(old); assert.equal(c.calls.length, 0);
  f.advance(c.settings.claimHoldMs);
  const reconstructed = createPhotoGenerationCleanupRepository({ context: f.context, now: f.now });
  const current = await reconstructed.claimCleanup(c.settings); assert.notEqual(current.operationToken, old.operationToken);
  assert.equal(await reconstructed.recordCleanupObservation(old, { acknowledged: true, observation: 'absent' }, c.settings), false);
  assert.equal(await reconstructed.recordCleanupObservation(current, { acknowledged: false, observation: 'unknown' }, c.settings), true);
  f.advance(1000); await c.worker({ repository: reconstructed }).runOnce(); assert.equal(c.calls.length, 1);
  assert.equal((await reconstructed.cleanupJournal(f.job.id))[0].attempts, 3);
});

test('an in-flight moderation scratch is not deleted before its receipt or grace period', async t => {
  const f = await fixture(t); const entered = deferred(), release = deferred(); const moderate = f.ports.moderator.moderate;
  f.ports.moderator.moderate = async args => { const result = await moderate(args); entered.resolve(); await release.promise; return result; };
  const pending = f.pipeline().runProvider(f.input); await entered.promise;
  const c = cleanupFixture(f); assert.equal(await c.worker().runOnce(), null);
  release.resolve(); await pending; assert.equal((await c.worker().runOnce()).kind, 'moderation');
});

test('cleanup discovery commits only 100 new jobs per run and eventually includes later jobs without user polling', async t => {
  const f = await fixture(t); await f.repository.open(f.input); const original = await f.repository.read(f.job.id, 'owner');
  await f.rows('DELETE FROM mini_photo_generation WHERE job_id = ?', [f.job.id]);
  await f.database.transaction(async q => {
    const job = (await q('SELECT * FROM mini_photo_jobs WHERE id = ?', [f.job.id]))[0];
    for (let n = 0; n < 102; n++) {
      const id = `photo_cleanup_${n}`;
      await q(`INSERT INTO mini_photo_jobs(id,user_id,idem,spec,spec_hash,billing_ref,state,claim_token,attempt,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?, ?,1,?,?)`, [id, 'owner', id, job.spec, job.spec_hash, id, 'unknown', job.claim_token, f.now(), f.now()]);
      await q(`INSERT INTO mini_photo_generation(job_id,user_id,spec_hash,policy,asset_id,output_key,expires_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)`, [id, 'owner', job.spec_hash, JSON.stringify(original.policy), `asset_${n}`,
        `private/photo-outputs/${n.toString(16).padStart(32, '0')}.png`, f.now() - 1, f.now(), f.now()]);
    }
  });
  const c = cleanupFixture(f); assert.equal(await c.repository.prepareCleanup(c.settings), 100);
  assert.equal(await c.repository.prepareCleanup(c.settings), 2); assert.equal(await c.repository.prepareCleanup(c.settings), 0);
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_generation_cleanup'))[0].n, 102);
});
