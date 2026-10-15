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
import { photoGenerationSchema } from '../photo-jobs/generation-repository.js';
import { createPhotoGenerationLifecycle } from '../photo-jobs/generation-lifecycle.js';
import { QWEN_PHOTO_PROVIDER, QWEN_PHOTO_MODEL, QWEN_PHOTO_RESULT_POLICY, QWEN_PHOTO_RESULT_HOSTS } from '../photo-jobs/qwen-provider.js';
import { fixtureEffects, fixtureBundle } from './photo-acceptance-fixture.mjs';

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+XAZkAAAAASUVORK5CYII=', 'base64');
const sha = value => createHash('sha256').update(value).digest('hex');
const image = value => ({ bytes: Buffer.from(value), byteLength: value.length, sha256: sha(value), contentType: 'image/png' });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const turn = () => new Promise(resolve => setImmediate(resolve));
const naturalEffect = JSON.parse(fs.readFileSync(new URL('../docs/production-config/natural-avatar-merchant-policy-2026-10-13.json', import.meta.url))).approvedEffects[0];
// Every external port and evidence object below is SYNTHETIC. This suite proves
// orchestration/SQL contracts, never actual provider acceptance or AI marking.
const policy = { approved: true, reviewReference: 'fixture_effect_review', acceptanceVersion: naturalEffect.version,
  serviceProviderCode: 'fixture_operator', provider: QWEN_PHOTO_PROVIDER, model: QWEN_PHOTO_MODEL,
  resultUrlPolicy: QWEN_PHOTO_RESULT_POLICY, sourceHosts: [...QWEN_PHOTO_RESULT_HOSTS], operation: 'edit',
  basicVersion: 'basic_v1', faceVersion: 'face_v1', labelVersion: naturalEffect.version,
  moderationVersion: naturalEffect.version, moderationService: 'aigcCheck', sourceRetentionMs: 86400000, resultRetentionMs: 86400000 };
const evidence = () => ({ marker: { ready: true, python: true, pillow: true, chineseFont: true,
  labelVersion: policy.labelVersion, operation: 'edit', serviceProviderCode: policy.serviceProviderCode },
  providerEvidence: { provider: policy.provider, model: policy.model, version: policy.acceptanceVersion,
    resultUrlPolicy: policy.resultUrlPolicy, labelVersion: policy.labelVersion, moderationVersion: policy.moderationVersion,
    moderationService: policy.moderationService, report: { provider: policy.provider, model: policy.model,
      probeVersion: policy.acceptanceVersion, resultUrlPolicy: policy.resultUrlPolicy, labelVersion: policy.labelVersion,
      moderationVersion: policy.moderationVersion, moderationServices: { input: 'baselineCheck', output: policy.moderationService },
      executed: true, syntheticOnly: true, passed: true, deployed: false, productionApproved: false,
      permanentErasureConfirmed: false, previewSaved: true,
      acceptanceBinding: { effectId: naturalEffect.id, effectVersion: naturalEffect.version,
        specSha256: '5d4de1225b011792253dedda9730eda8fba9fc495e991dbd2f9c9119ad978bd9',
        normalizedSha256: 'a'.repeat(64), rawSha256: 'b'.repeat(64) },
      inputAllowed: true, outputAllowed: true, marked: true, outputReadMatches: true, outputAbsentObserved: true,
      scratchAbsentObserved: 2, cleanupPending: false, attemptedGenerationCalls: 1, attemptedGreenCalls: 2 } } });

async function fixture(t, { enabled = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-generation-lifecycle-'));
  const original = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'fixture.sqlite'), migrate: true });
  const sql = [], lives = []; const database = { backend: original.backend,
    transaction: callback => original.transaction(q => callback((statement, values) => { sql.push(statement); return q(statement, values); })) };
  t.after(async () => { for (const life of lives) await life.drain(); await original.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const rows = (statement, values) => database.transaction(q => q(statement, values));
  await database.transaction(async q => { for (const statement of photoContextSchema('sqlite')) await q(statement);
    await q(photoJobsSchema('sqlite')); for (const statement of photoGenerationSchema('sqlite')) await q(statement); });
  let clock = 1800000000000; const now = () => clock;
  const ledger = createVirtualLedger({ database, encryptionKey: '7'.repeat(64), now });
  await ledger.bindEnvironment('fixture_app', 1);
  await ledger.bindSession({ userId: 'owner', sessionId: 'session_owner', appId: 'fixture_app', openid: 'fixture_openid', sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const order = await ledger.createOrder({ userId: 'owner', product: draftProducts[0], idempotencyKey: 'fixture_funding', appId: 'fixture_app', env: 1, platform: 'android' });
  await ledger.settle(order.id, { order_id: order.id, env_type: 2, order_fee: order.amountFen, paid_fee: order.amountFen,
    status: 2, order_type: 0, wx_order_id: `wx_${order.id}`, paid_time: Math.floor(now() / 1000), refund_fee: 0, left_fee: order.amountFen });
  const context = createPhotoJobContext({ ledger, policy, now });
  await context.grantBasicConsent('owner', policy.basicVersion);
  await context.grantFaceConsent('owner', { version: policy.faceVersion, subjectAuthorization: 'self' });
  const inputKey = `private/mini-photo-input/${'1'.repeat(32)}.png`;
  await context.registerInput('owner', { id: 'input_1', storageKey: inputKey, ...image(bytes), expiresAt: now() + 86400000,
    moderation: { decision: 'allow', reference: 'fixture_input_review' } });
  await context.putEffect(naturalEffect);
  await context.repository.submit(await context.submission({ userId: 'owner', idempotencyKey: 'fixture_generation', inputAssetId: 'input_1', effectId: naturalEffect.id }));
  const claim = await context.repository.claimNext();
  const objects = new Map([[inputKey, Buffer.from(bytes)]]), calls = { provider: 0, read: 0, put: 0, mark: 0, review: 0, delete: 0, inspect: 0, checks: 0, auth: [] };
  let inspection = evidence();
  const output = {
    async put(key, value) { calls.put++; assert.equal(objects.has(key), false); objects.set(key, Buffer.from(value)); },
    async read(key) { calls.read++; return objects.has(key) ? { found: true, ...image(objects.get(key)) } : { found: false }; },
    async delete(key) { calls.delete++; objects.delete(key); return { acknowledged: true }; },
    async inspect(key) { calls.inspect++; return { found: objects.has(key) }; },
  };
  const settings = { context, policy: structuredClone(policy), approvedEffects: [structuredClone(naturalEffect)], generationEnabled: enabled, now,
    media: { inputStorage: { read: async key => ({ found: true, ...image(objects.get(key)) }) }, outputStorage: output,
      provider: { async generate() { calls.provider++; return { provider: policy.provider, model: policy.model, requestId: 'fixture_request_1',
        url: 'https://dashscope-fixture.oss-cn-beijing.aliyuncs.com/result.png' }; }, async readGenerated() { return image(bytes); } },
      marker: { async mark(input) { calls.mark++; return { ...image(bytes), contentId: input.contentId, operation: input.operation, labelVersion: input.labelVersion, verified: true }; } },
      moderator: { async moderate(input) { calls.review++; assert.equal(await input.journal({ reference: 'a'.repeat(32), extension: 'png' }), true);
        return { provider: 'aliyun-green', policyVersion: policy.moderationVersion, service: policy.moderationService, direction: 'output',
          sha256: sha(input.bytes), byteLength: input.bytes.length, decision: 'allow', reference: `mod_${'1'.repeat(64)}`,
          requestId: 'fixture_green_1', cleanupReference: 'a'.repeat(32), cleanupExtension: 'png', cleanupPending: false }; } } },
    cleanup: { moderationStorage: output, policy: { timeoutMs: 20, retryAfterMs: 1000, recheckAfterMs: 5000, inFlightGraceMs: 300000 } },
    inspectPrerequisites: async () => { calls.checks++; return inspection; },
    authorizeUser: async ({ userId }) => { calls.auth.push(userId); return userId === 'owner'; },
  };
  const create = changes => { const life = createPhotoGenerationLifecycle({ ...settings, ...changes }); lives.push(life); return life; };
  const life = create();
  return { life, create, settings, database, context, ledger, claim, rows, sql, calls, objects, output,
    input: { jobId: claim.id, userId: 'owner', spec: claim.spec },
    setInspection: value => { inspection = value; }, advance: ms => { clock += ms; } };
}

test('construction and default-closed prepare do no external work or SQL mutations and share the canonical DB', async t => {
  const f = await fixture(t); const before = f.sql.length;
  const life = f.create(); assert.equal(f.sql.length, before); assert.equal(life.database, f.database);
  f.sql.length = 0; assert.equal((await life.prepare()).prepared, true);
  assert.ok(f.sql.length >= 13); assert.ok(f.sql.every(statement => /^SELECT /i.test(statement)));
  assert.equal((await life.readiness()).ready, false);
  await assert.rejects(life.runProvider(f.input), /NOT_AVAILABLE/);
  assert.equal(f.calls.provider + f.calls.put + f.calls.review + f.calls.mark + f.calls.delete, 0);
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_generation'))[0].n, 0);
});

test('missing DDL fails prepare without creating any table or enabling processing', async t => {
  const f = await fixture(t, { enabled: true }); await f.rows('DROP TABLE mini_photo_generation_operations'); f.sql.length = 0;
  await assert.rejects(f.life.prepare(), /SCHEMA_REQUIRED/);
  assert.ok(f.sql.every(statement => /^SELECT /i.test(statement)));
  assert.equal((await f.life.readiness()).ready, false);
  assert.equal((await f.rows("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='mini_photo_generation_operations'"))[0].n, 0);
});

test('a bare ready flag and wrong marker prerequisites keep generation closed without hiding cleanup readiness', async t => {
  const f = await fixture(t, { enabled: true });
  for (const value of [{ ready: true }, { ...evidence(), marker: { ...evidence().marker, pillow: false } },
    { ...evidence(), marker: { ...evidence().marker, chineseFont: false } },
    { ...evidence(), marker: { ...evidence().marker, labelVersion: 'other' } },
    { ...evidence(), marker: { ...evidence().marker, serviceProviderCode: 'other' } }]) {
    f.setInspection(value); const state = await f.life.prepare();
    assert.equal(state.prepared, true); assert.equal(state.markerReady, false); assert.equal(state.acceptanceReady, false);
    assert.deepEqual(state.blockers, ['PHOTO_GENERATION_MARKER_NOT_READY']);
    assert.equal((await f.life.readiness()).ready, false);
  }
  assert.equal(f.calls.provider, 0);
});

test('global ready does not authorize a user and runProvider cannot omit user identity', async t => {
  const f = await fixture(t, { enabled: true }); await f.life.prepare();
  assert.equal((await f.life.readiness()).ready, true); assert.deepEqual(f.calls.auth, []);
  assert.equal((await f.life.readiness('owner')).ready, true); assert.equal((await f.life.readiness('other')).ready, false);
  await assert.rejects(f.life.runProvider({ ...f.input, userId: undefined }), /USER_NOT_ALLOWED/);
  await assert.rejects(f.life.runProvider({ ...f.input, userId: 'other' }), /NOT_AVAILABLE/);
  assert.equal(f.calls.provider, 0); assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_generation'))[0].n, 0);
});

test('only matching completed real-probe contract permits ready; HTTP200 or configured credentials alone do not', async t => {
  const f = await fixture(t, { enabled: true }); await f.life.prepare();
  const changes = [value => { delete value.providerEvidence; },
    value => { value.providerEvidence.report = { passed: true, httpStatus: 200, imageCount: 1 }; },
    value => { value.providerEvidence.model = 'other'; }, value => { value.providerEvidence.version = 'previous_probe'; },
    value => { value.providerEvidence.model = 'qwen-image-edit-plus-2025-12-15';
      value.providerEvidence.report.model = 'qwen-image-edit-plus-2025-12-15'; },
    value => { value.providerEvidence.resultUrlPolicy = 'previous_policy'; },
    value => { value.providerEvidence.labelVersion = 'old_label'; },
    value => { value.providerEvidence.moderationVersion = 'old_review'; },
    value => { value.providerEvidence.report.model = 'other'; }, value => { value.providerEvidence.report.probeVersion = 'previous_probe'; },
    value => { value.providerEvidence.report.resultUrlPolicy = 'previous_policy'; },
    value => { value.providerEvidence.report.labelVersion = 'old_label'; },
    value => { value.providerEvidence.report.moderationVersion = 'old_review'; },
    value => { value.providerEvidence.report.moderationServices.output = 'baselineCheck'; },
    value => { value.providerEvidence.report.passed = false; }, value => { value.providerEvidence.report.cleanupPending = true; },
    value => { value.providerEvidence.report.outputAllowed = false; }];
  for (const change of changes) { const value = evidence(); change(value); f.setInspection(value);
    assert.equal((await f.life.readiness()).ready, false); await assert.rejects(f.life.runProvider(f.input), /NOT_AVAILABLE/); }
  assert.equal(f.calls.provider, 0); assert.equal(f.calls.review, 0);
});

test('acceptance requires exactly two scratch absence observations from the report, without coercion', async t => {
  const f = await fixture(t, { enabled: true });
  for (const count of [undefined, 0, 1, 3, '2']) {
    const value = evidence();
    // An outer wrapper cannot supply evidence missing from the probe report.
    value.providerEvidence.scratchAbsentObserved = 2;
    if (count === undefined) delete value.providerEvidence.report.scratchAbsentObserved;
    else value.providerEvidence.report.scratchAbsentObserved = count;
    f.setInspection(value);
    const prepared = await f.life.prepare();
    assert.equal(prepared.prepared, true); assert.equal(prepared.markerReady, true);
    assert.equal(prepared.acceptanceReady, false);
    const state = await f.life.readiness('owner');
    assert.equal(state.ready, false);
    assert.deepEqual(state.blockers, ['PHOTO_GENERATION_ACCEPTANCE_REQUIRED']);
    await assert.rejects(f.life.runProvider(f.input), /NOT_AVAILABLE/);
  }
  assert.equal(f.calls.provider + f.calls.review + f.calls.put + f.calls.mark, 0);
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_generation'))[0].n, 0);
  f.setInspection(evidence());
  assert.equal((await f.life.prepare()).acceptanceReady, true);
  assert.equal((await f.life.readiness('owner')).ready, true);
});

test('explicitly enabled lifecycle reuses the real context/ledger pipeline and publishes once', async t => {
  const f = await fixture(t, { enabled: true }); await f.life.prepare();
  const result = await f.life.runProvider(f.input); await f.context.repository.recordResult(f.claim.id, f.claim.claim_token, result);
  assert.equal((await f.context.repository.publishNext()).state, 'succeeded');
  assert.deepEqual(await f.life.runProvider(f.input), result);
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.review, 1); assert.equal(f.calls.put, 1);
  assert.equal((await f.rows('SELECT status FROM vp_reservations'))[0].status, 'consumed');
});

test('caller policy mutation cannot replace the frozen reviewed model or result policy', async t => {
  const f = await fixture(t, { enabled: true });
  f.settings.policy.model = 'unreviewed'; f.settings.policy.resultUrlPolicy = 'new_unreviewed';
  await f.life.prepare(); assert.equal((await f.life.readiness('owner')).ready, true);
  await f.life.runProvider(f.input); assert.equal(f.calls.provider, 1);
  assert.throws(() => f.create(), /POLICY_REQUIRED/);
});

test('consent withdrawal during permission await is rechecked by the canonical context before generation', async t => {
  const f = await fixture(t, { enabled: true }); const gate = deferred(), entered = deferred();
  const life = f.create({ authorizeUser: async () => { entered.resolve(); await gate.promise; return true; } }); await life.prepare();
  const pending = life.runProvider(f.input); await entered.promise;
  await f.context.withdrawFaceConsent('owner'); gate.resolve();
  await assert.rejects(pending, /NOT_AUTHORIZED/); assert.equal(f.calls.provider, 0);
});

test('drain waits for admitted generation, rejects new work and leaves DB open', async t => {
  const f = await fixture(t, { enabled: true }); const gate = deferred(), entered = deferred();
  const provider = f.settings.media.provider;
  const life = f.create({ media: { ...f.settings.media, provider: { ...provider, async generate(input) {
    entered.resolve(); await gate.promise; return provider.generate(input); } } } });
  await life.prepare(); const work = life.runProvider(f.input); await entered.promise;
  let ended = false; const draining = life.drain().then(result => { ended = true; return result; }); await turn();
  assert.equal(ended, false); await assert.rejects(life.runProvider(f.input), /DRAINING/);
  assert.equal(await life.runCleanupOnce(), null); gate.resolve(); await work;
  assert.deepEqual(await draining, { accepting: false, active: 0, databaseClosed: false });
  assert.equal((await f.rows('SELECT registered FROM mini_photo_generation'))[0].registered, 1);
  assert.equal((await life.readiness()).ready, false); assert.equal(f.calls.provider, 1);
});

test('drain during the read-only preparation prevents a late ready transition', async t => {
  const f = await fixture(t); const gate = deferred(), entered = deferred();
  const life = f.create({ inspectPrerequisites: async () => { entered.resolve(); await gate.promise; return evidence(); } });
  const preparation = life.prepare(); const rejected = assert.rejects(preparation, /DRAINING/); await entered.promise;
  let ended = false; const draining = life.drain().then(() => { ended = true; }); await turn(); assert.equal(ended, false);
  gate.resolve(); await rejected; await draining; assert.equal((await life.readiness()).ready, false);
});

test('cleanup remains available with generation disabled and failed acceptance evidence', async t => {
  const f = await fixture(t, { enabled: true }); await f.life.prepare(); await f.life.runProvider(f.input); await f.life.drain();
  await f.context.withdrawFaceConsent('owner');
  const value = evidence(); value.providerEvidence.report.passed = false; f.setInspection(value);
  const closed = f.create({ generationEnabled: false }); await closed.prepare();
  assert.equal((await closed.readiness()).ready, false);
  await closed.runCleanupOnce(); await closed.runCleanupOnce();
  assert.equal(f.calls.provider, 1); assert.equal(f.calls.review, 1); assert.equal(f.calls.delete, 2);
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_generation_cleanup'))[0].n, 2);
});

test('missing marker after a restart still permits deletion of already-revoked private outputs', async t => {
  const f = await fixture(t, { enabled: true }); await f.life.prepare(); await f.life.runProvider(f.input); await f.life.drain();
  await f.context.withdrawFaceConsent('owner'); f.setInspection({ marker: { ready: false } });
  const restarted = f.create(); const prepared = await restarted.prepare();
  assert.equal(prepared.prepared, true); assert.equal(prepared.markerReady, false);
  assert.equal((await restarted.readiness()).ready, false);
  await restarted.runCleanupOnce(); await restarted.runCleanupOnce();
  assert.equal(f.calls.delete, 2); assert.equal(f.calls.provider, 1);
});

test('drain includes a direct readiness inspector and does not start user authorization after draining begins', async t => {
  const f = await fixture(t, { enabled: true }); const gate = deferred(), entered = deferred(); let slow = false;
  const life = f.create({ inspectPrerequisites: async () => { if (slow) { entered.resolve(); await gate.promise; } return evidence(); } });
  await life.prepare(); slow = true; const read = life.readiness('owner'); await entered.promise;
  let ended = false; const drain = life.drain().then(() => { ended = true; }); await turn(); assert.equal(ended, false);
  gate.resolve(); assert.equal((await read).ready, false); await drain; assert.deepEqual(f.calls.auth, []);
});

test('cleanup timeout persists unknown but drain still waits for its late storage promise', async t => {
  const f = await fixture(t, { enabled: true }); await f.life.prepare(); await f.life.runProvider(f.input); await f.life.drain();
  await f.context.withdrawFaceConsent('owner'); const gate = deferred(), entered = deferred();
  const storage = { ...f.output, async delete(key) { entered.resolve(); await gate.promise; return f.output.delete(key); } };
  const life = f.create({ generationEnabled: false, media: { ...f.settings.media, outputStorage: storage },
    cleanup: { ...f.settings.cleanup, moderationStorage: storage } }); await life.prepare();
  const cleaning = life.runCleanupOnce(); assert.equal(life.runCleanupOnce(), cleaning, 'one local cleanup run at a time');
  await entered.promise; const result = await cleaning;
  assert.equal(result.acknowledged, false); assert.equal(result.permanentErasureConfirmed, false);
  let ended = false; const draining = life.drain().then(value => { ended = true; return value; }); await turn(); assert.equal(ended, false);
  gate.resolve(); assert.equal((await draining).databaseClosed, false);
  assert.equal((await f.rows('SELECT delete_status FROM mini_photo_generation_cleanup WHERE kind = ?', [result.kind]))[0].delete_status, 'unknown');
});

test('late read-only check errors fail closed without returning raw provider or credential details', async t => {
  const f = await fixture(t, { enabled: true }); let bad = false;
  const life = f.create({ inspectPrerequisites: async () => { if (bad) throw new Error('https://private.example/?secret=secret'); return evidence(); } });
  await life.prepare(); bad = true; const status = await life.readiness('owner'); assert.equal(status.ready, false);
  assert.doesNotMatch(JSON.stringify(status), /private|secret|https/); await assert.rejects(life.runProvider(f.input), /NOT_AVAILABLE/);
  assert.equal(f.calls.provider, 0);
});

test('multi-effect lifecycle revalidates the original bundle and rejects a database effect outside the pinned policy', async t => {
  const f = await fixture(t, { enabled: true }), effects = fixtureEffects(), bundle = fixtureBundle(effects);
  const p = { ...policy, acceptanceVersion: bundle.probeVersion, labelVersion: bundle.probeVersion, moderationVersion: bundle.probeVersion };
  const inspection = { marker: { ...evidence().marker, labelVersion: p.labelVersion }, providerEvidence: {
    provider: p.provider, model: p.model, version: p.acceptanceVersion, resultUrlPolicy: p.resultUrlPolicy,
    labelVersion: p.labelVersion, moderationVersion: p.moderationVersion, moderationService: p.moderationService,
    report: bundle.pipelineReport, acceptanceBundle: bundle } };
  const life = f.create({ policy: p, approvedEffects: effects }); f.setInspection(inspection);
  assert.equal((await life.prepare()).acceptanceReady, true);
  assert.equal((await life.readiness('owner')).ready, true);
  // Both mutable caller policy data and the persisted natural-avatar fixture are
  // outside the copied accepted set. Neither can authorize provider execution.
  effects.splice(0, effects.length);
  assert.equal((await life.readiness('owner')).ready, true);
  await assert.rejects(life.runProvider(f.input), /EFFECT_NOT_ACCEPTED/);
  const changed = structuredClone(inspection); changed.providerEvidence.acceptanceBundle.effects.pop(); f.setInspection(changed);
  assert.equal((await life.readiness('owner')).ready, false);
  await assert.rejects(life.runProvider(f.input), /NOT_AVAILABLE/);
  f.setInspection({ ...inspection, providerEvidence: { ...inspection.providerEvidence, acceptanceBundle: undefined } });
  assert.equal((await life.readiness('owner')).ready, false);
  assert.equal(f.calls.provider, 0); assert.equal(f.calls.review, 0);
});

test('omitting the approved effect list cannot fall back to unbound provider dispatch', async t => {
  const f = await fixture(t, { enabled: true }), life = f.create({ approvedEffects: undefined });
  await life.prepare();
  await assert.rejects(life.runProvider(f.input), /EFFECT_NOT_ACCEPTED/);
  assert.equal(f.calls.provider, 0);
});

test('withdrawn evidence during input read prevents the late provider call and preserves a non-retriable unknown reservation', async t => {
  const f = await fixture(t, { enabled: true }), original = f.settings.media.inputStorage;
  const life = f.create({ media: { ...f.settings.media, inputStorage: { async read(...args) {
    const result = await original.read(...args); const changed = evidence();
    changed.providerEvidence.report.passed = false; f.setInspection(changed); return result;
  } } } });
  await life.prepare();
  await assert.rejects(life.runProvider(f.input), /PROVIDER_UNCONFIRMED/);
  assert.equal(f.calls.provider, 0);
  assert.equal((await f.rows("SELECT state FROM mini_photo_generation_operations WHERE step = 'generate'"))[0].state, 'unknown');
  await f.context.repository.recordUnknown(f.claim.id, f.claim.claim_token);
  assert.equal((await f.rows('SELECT state FROM mini_photo_jobs'))[0].state, 'unknown');
  assert.equal((await f.rows('SELECT status FROM vp_reservations'))[0].status, 'reserved');
  assert.equal(await f.context.repository.claimNext(), null);
  f.setInspection(evidence());
  await assert.rejects(life.runProvider(f.input), /PROVIDER_UNCONFIRMED/);
  assert.equal(f.calls.provider, 0, 'restored evidence cannot retry a journaled generate attempt');
});

test('refund before dispatch revokes paid source authorization without provider work or credit release', async t => {
  const f = await fixture(t, { enabled: true }); await f.life.prepare();
  await f.rows("UPDATE vp_orders SET status = 'refunded'");
  await assert.rejects(f.life.runProvider(f.input), /NOT_AUTHORIZED/);
  assert.equal(f.calls.provider, 0);
  assert.equal((await f.rows('SELECT status FROM vp_reservations'))[0].status, 'reserved');
  assert.equal((await f.rows('SELECT COUNT(*) AS n FROM mini_photo_generation'))[0].n, 0);
});

test('refund during final evidence recheck is reauthorized before the provider call', async t => {
  const f = await fixture(t, { enabled: true }); let checks = 0;
  const life = f.create({ inspectPrerequisites: async () => {
    checks++;
    if (checks === 3) await f.rows("UPDATE vp_orders SET status = 'refunded'");
    return evidence();
  } });
  await life.prepare();
  await assert.rejects(life.runProvider(f.input), /PROVIDER_UNCONFIRMED/);
  assert.equal(checks, 3); assert.equal(f.calls.provider, 0);
  assert.equal((await f.rows('SELECT status FROM vp_reservations'))[0].status, 'reserved');
  assert.equal((await f.rows("SELECT state FROM mini_photo_generation_operations WHERE step = 'generate'"))[0].state, 'unknown');
});
