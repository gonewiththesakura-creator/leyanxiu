import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { draftProducts } from '../payments/virtual/products.js';
import { createPhotoJobRepository, photoJobsSchema } from '../photo-jobs/repository.js';

const DAY = 86400000;
const reference = value => crypto.createHash('sha256').update(value).digest('hex');
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-reservation-tx-'));
  const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'ledger.sqlite'), migrate: true });
  t.after(async () => { await database.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  let now = 1800000000000;
  const ledger = createVirtualLedger({ database, encryptionKey: 'a'.repeat(64), now: () => now });
  await ledger.bindEnvironment('wx-transaction-test', 1);
  await ledger.bindSession({ userId: 'buyer', sessionId: 'session', appId: 'wx-transaction-test', openid: 'test-buyer', sessionKey: Buffer.alloc(16, 7).toString('base64') });
  const initial = await ledger.createOrder({ userId: 'buyer', product: draftProducts[0], idempotencyKey: 'payment-key', appId: 'wx-transaction-test', env: 1, platform: 'android' });
  const order = await ledger.settle(initial.id, { order_id: initial.id, env_type: 2, order_type: 0, status: 2,
    order_fee: 990, paid_fee: 990, left_fee: 990, refund_fee: 0, wx_order_id: 'test-payment-receipt', paid_time: now / 1000 });
  await database.transaction(async q => {
    await q(photoJobsSchema('sqlite'));
    await q('CREATE TABLE test_published_works (id TEXT PRIMARY KEY, asset_id TEXT NOT NULL)');
  });
  const ports = {
    authorize: async () => true,
    reserve: async ({ query, job }) => {
      const result = await ledger.reserveInTransaction(query, { userId: job.user_id, reference: job.billing_ref, purpose: job.spec.purpose, kind: 'photo' });
      return result.ok && !result.duplicate;
    },
    settle: ({ query, job, outcome }) => ledger.finishInTransaction(query, { userId: job.user_id, reference: job.billing_ref, outcome: outcome === 'succeeded' ? 'success' : 'failed' }),
    publish: async ({ query, job, assetId }) => { await query('INSERT INTO test_published_works VALUES (?,?)', [job.id, assetId]); return true; },
  };
  const repo = createPhotoJobRepository({ database, ...ports, now: () => now });
  const input = key => ({ userId: 'buyer', idempotencyKey: `create-${key}`, inputAssetId: 'input-owned', effectId: 'effect-one',
    effectVersion: 'v1', purpose: 'photo-effect:effect-one', billingRef: reference(key), provider: 'approved-provider', model: 'reviewed-model' });
  const reserve = ref => database.transaction(q => ledger.reserveInTransaction(q, { userId: 'buyer', reference: ref, purpose: 'photo-effect:effect-one', kind: 'photo' }));
  const finish = (ref, outcome) => database.transaction(q => ledger.finishInTransaction(q, { userId: 'buyer', reference: ref, outcome }));
  return { database, ledger, repo, order, input, reserve, finish, now: () => now, advance: amount => { now += amount; } };
}

test('real photo job insertion and the canonical virtual reservation commit or roll back together', async t => {
  const f = await fixture(t);
  await f.database.transaction(q => q("CREATE TRIGGER reject_job BEFORE INSERT ON mini_photo_jobs BEGIN SELECT RAISE(ABORT, 'injected job failure'); END"));
  await assert.rejects(f.repo.submit(f.input('atomic-submit')), /injected job failure/);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 10);
  assert.deepEqual(await f.database.transaction(q => q('SELECT * FROM vp_reservations')), []);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'creation.reserved').length, 0);
  await f.database.transaction(q => q('DROP TRIGGER reject_job'));
  const first = await f.repo.submit(f.input('atomic-submit'));
  assert.equal(first.duplicate, false);
  assert.equal((await f.repo.submit(f.input('atomic-submit'))).job.id, first.job.id);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 9);
  assert.equal((await f.ledger.entitlements('buyer')).buckets[0].reserved, 1);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'creation.reserved').length, 1);
});

test('failed photo publication rolls back the work, debit and audit while preserving its recorded result for retry', async t => {
  const f = await fixture(t); const created = await f.repo.submit(f.input('atomic-publish'));
  const claim = await f.repo.claimNext(); await f.repo.recordResult(claim.id, claim.claim_token, { assetId: 'private-result', providerRef: 'provider-result' });
  await f.database.transaction(q => q("CREATE TRIGGER reject_publish BEFORE UPDATE ON mini_photo_jobs WHEN NEW.state = 'succeeded' BEGIN SELECT RAISE(ABORT, 'injected publish failure'); END"));
  await assert.rejects(f.repo.publishNext(), /injected publish failure/);
  assert.equal((await f.repo.readOwned('buyer', created.job.id)).state, 'result_ready');
  assert.deepEqual(await f.database.transaction(q => q('SELECT * FROM test_published_works')), []);
  assert.equal((await f.ledger.entitlements('buyer')).buckets[0].reserved, 1);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'creation.success').length, 0);
  await f.database.transaction(q => q('DROP TRIGGER reject_publish'));
  assert.equal((await f.repo.publishNext()).state, 'succeeded');
  assert.equal(await f.repo.publishNext(), null);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 9);
  assert.equal((await f.ledger.entitlements('buyer')).buckets[0].reserved, 0);
  assert.equal((await f.ledger.auditLog()).filter(row => row.action === 'creation.success').length, 1);
});

test('transaction ports keep uncertain work held and forced refunds cannot recreate its credits', async t => {
  const f = await fixture(t); const ref = reference('unknown');
  await f.reserve(ref); await f.finish(ref, 'unknown');
  await assert.rejects(f.ledger.requestRefund(f.order.id, 'buyer'), /XPAY_REFUND_GENERATION_PENDING/);
  assert.deepEqual(await f.reserve(ref), { ok: true, duplicate: true });
  assert.equal((await f.ledger.entitlements('buyer')).buckets[0].reserved, 1);
  await f.ledger.applyRefund({ MchOrderId: f.order.id, OpenId: f.order.openid, WxOrderId: f.order.providerId,
    WxRefundId: 'forced-refund', MchRefundId: 'channel-refund', RefundFee: 990, RetCode: 0 });
  assert.equal(await f.finish(ref, 'failed'), true);
  assert.equal(await f.finish(ref, 'failed'), false);
  const rights = await f.ledger.entitlements('buyer');
  assert.equal(rights.available.photo, 0); assert.equal(rights.buckets[0].reserved, 0);
  assert.equal(rights.buckets.some(bucket => bucket.id.startsWith('comp:')), false);
});

test('expired failed work receives one seven-day zero-value compensation through the same transaction port', async t => {
  const f = await fixture(t); const ref = reference('expired'); await f.reserve(ref);
  f.advance(366 * DAY);
  assert.equal(await f.finish(ref, 'failed'), true); assert.equal(await f.finish(ref, 'failed'), false);
  const rights = await f.ledger.entitlements('buyer'); const compensations = rights.buckets.filter(bucket => bucket.id.startsWith('comp:'));
  assert.equal(rights.available.photo, 1); assert.equal(compensations.length, 1);
  assert.equal(compensations[0].starts_at, f.now()); assert.equal(compensations[0].expires_at, f.now() + 7 * DAY);
  assert.equal((await f.database.transaction(q => q('SELECT value_fen FROM vp_buckets WHERE id = ?', [`comp:${ref}`])))[0].value_fen, 0);
});

test('refund and photo admission serialize on one account without spending frozen credits', async t => {
  for (const refundFirst of [false, true]) await t.test(refundFirst ? 'refund wins' : 'reservation wins', async child => {
    const f = await fixture(child); const ref = reference('compete');
    const operations = refundFirst ? [() => f.ledger.requestRefund(f.order.id, 'buyer'), () => f.reserve(ref)]
      : [() => f.reserve(ref), () => f.ledger.requestRefund(f.order.id, 'buyer')];
    const results = await Promise.allSettled(operations.map(run => run()));
    const rights = await f.ledger.entitlements('buyer');
    if (refundFirst) {
      assert.equal(results[0].status, 'fulfilled'); assert.deepEqual(results[1].value, { ok: false, duplicate: false });
      assert.equal(rights.buckets[0].frozen, 10); assert.equal(rights.buckets[0].reserved, 0);
    } else {
      assert.deepEqual(results[0].value, { ok: true, duplicate: false }); assert.equal(results[1].status, 'rejected');
      assert.match(results[1].reason.message, /XPAY_REFUND_GENERATION_PENDING/);
      assert.equal(rights.buckets[0].reserved, 1); assert.equal(rights.buckets[0].frozen, 0);
    }
  });
});

test('transaction ports enforce the same daily budget as the existing ledger API', async t => {
  const previous = process.env.USER_DAILY_GENERATION_LIMIT; process.env.USER_DAILY_GENERATION_LIMIT = '2';
  t.after(() => { if (previous === undefined) delete process.env.USER_DAILY_GENERATION_LIMIT; else process.env.USER_DAILY_GENERATION_LIMIT = previous; });
  const f = await fixture(t);
  await f.ledger.reserve('buyer', reference('budget-public'), 'photo-effect:effect-one', 'photo');
  await f.reserve(reference('budget-transaction'));
  await assert.rejects(f.reserve(reference('over-budget')), /XPAY_PROVIDER_BUDGET_LIMIT/);
  assert.equal((await f.ledger.entitlements('buyer')).available.photo, 8);
  assert.equal((await f.ledger.entitlements('buyer')).buckets[0].reserved, 2);
});
