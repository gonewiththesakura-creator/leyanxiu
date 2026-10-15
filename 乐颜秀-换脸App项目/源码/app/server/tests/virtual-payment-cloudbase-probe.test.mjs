import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createCloudbaseProbe, cloudbaseProbeAppId, cloudbaseProbePrefix } from '../payments/virtual/cloudbase-probe.js';

const copy = value => structuredClone(value);
const reference = value => crypto.createHash('sha256').update(value).digest('hex');

// A local MVCC simulator, not CloudBase evidence. The SDK subset intentionally has no where/count methods.
function simulatedDatabase() {
  const documents = new Map();
  const stats = { starts: 0, commits: 0, rollbacks: 0, conflicts: 0, maxOperations: 0 };
  let failCollection; let loseNextCommitResponse = false;
  return {
    stats,
    failNextWrite(collection) { failCollection = collection; },
    loseNextCommitResponse() { loseNextCommitResponse = true; },
    records(collection) { return [...documents.entries()].filter(([key]) => key.startsWith(`${collection}/`)).map(([, row]) => copy(row.value)); },
    async startTransaction() {
      stats.starts++;
      const snapshot = new Map([...documents.entries()].map(([key, row]) => [key, copy(row)]));
      const reads = new Map(); const writes = new Map(); let closed = false; let operations = 0;
      const operation = () => {
        assert.equal(closed, false);
        assert.ok(++operations <= 100, 'document-only probe exceeds CloudBase transaction operation limit');
        stats.maxOperations = Math.max(stats.maxOperations, operations);
      };
      return {
        collection(name) {
          assert.ok(name.startsWith(cloudbaseProbePrefix), 'production collection touched');
          return {
            doc(id) {
              const key = `${name}/${id}`;
              return {
                async get() {
                  operation(); reads.set(key, snapshot.get(key)?.version || 0);
                  const value = writes.has(key) ? writes.get(key) : snapshot.get(key)?.value;
                  return { data: value ? { ...copy(value), _id: id } : null };
                },
                async set(options) {
                  operation(); reads.set(key, snapshot.get(key)?.version || 0);
                  assert.deepEqual(Object.keys(options), ['data'], 'wx-server-sdk requires the data wrapper');
                  if (failCollection === name) { failCollection = null; throw new Error('SIMULATED_WRITE_FAILURE'); }
                  writes.set(key, copy(options.data));
                  return { updated: 1 };
                },
              };
            },
          };
        },
        async commit() {
          operation();
          for (const [key, version] of reads) {
            if ((documents.get(key)?.version || 0) !== version) {
              stats.conflicts++;
              const error = new Error('simulated conflict'); error.code = 'TRANSACTION_CONFLICT'; throw error;
            }
          }
          // Checking versions and applying writes happen without yielding, as one simulated atomic commit.
          for (const [key, value] of writes) documents.set(key, { value: copy(value), version: (documents.get(key)?.version || 0) + 1 });
          closed = true; stats.commits++;
          if (loseNextCommitResponse) {
            loseNextCommitResponse = false;
            const error = new Error('SIMULATED_COMMIT_RESPONSE_LOST'); error.code = 'NETWORK_TIMEOUT'; throw error;
          }
          return {};
        },
        async rollback() { stats.rollbacks++; closed = true; writes.clear(); return {}; },
      };
    },
  };
}

const config = { runId: 'abcdef123456', appId: cloudbaseProbeAppId, env: 1, mode: 'probe', synthetic: true };
async function setup() {
  const database = simulatedDatabase(); const now = 1790841600000;
  const probe = createCloudbaseProbe({ ...config, database, now: () => now });
  await probe.initialize(); await probe.createAccount('probe_user_buyer'); await probe.createAccount('probe_user_other');
  const order = (key = 'probe_order_number_1', userId = 'probe_user_buyer') => probe.createOrder({ userId, idempotencyKey: key });
  const remote = local => ({ order_id: local.id, env_type: 2, order_fee: 990, paid_fee: 990,
    order_type: 0, status: 2, wx_order_id: `probe_trade_${local.id}`, paid_time: Math.floor(now / 1000), left_fee: 990 });
  const paid = async key => { const local = await order(key); await probe.settle(local.id, remote(local)); return local; };
  return { database, probe, order, remote, paid, now };
}

test('CloudBase experiment rejects live, wrong app, real identities and production collections', async () => {
  const database = simulatedDatabase();
  for (const overrides of [{ env: 0 }, { mode: 'live' }, { synthetic: false }, { appId: 'another-app' },
    { collectionPrefix: 'vp_' }, { deployment: 'production' }]) {
    assert.throws(() => createCloudbaseProbe({ ...config, database, ...overrides }), /ISOLATION_REQUIRED/);
  }
  const probe = createCloudbaseProbe({ ...config, database });
  assert.throws(() => probe.createAccount('real-user'), /USER_REQUIRED/);
  await assert.rejects(probe.createAccount('probe_user_buyer'), /BINDING_REQUIRED/);
});

test('document MVCC: concurrent settlements grant once and a trade cannot pay two merchant orders', async () => {
  const f = await setup(); const local = await f.order();
  await Promise.all(Array.from({ length: 20 }, () => f.probe.settle(local.id, f.remote(local))));
  const state = await f.probe.state(local.id, 'probe_user_buyer');
  assert.equal(state.bucket.quantity, 10); assert.equal(state.bucket.remaining, 10);
  assert.equal(f.database.records(f.probe.collections.audit).filter(row => row.action === 'payment.granted').length, 1);
  assert.ok(f.database.stats.conflicts > 0, 'concurrency must exercise conflict retry');
  const other = await f.order('probe_second_order_key');
  await assert.rejects(f.probe.settle(other.id, { ...f.remote(other), wx_order_id: f.remote(local).wx_order_id }), /TRADE_CONFLICT/);
  assert.equal((await f.probe.state(other.id, 'probe_user_buyer')).order.status, 'pending');
  assert.equal((await f.probe.state(other.id, 'probe_user_buyer')).bucket, null);
});

test('document MVCC: a write failure rolls back all order, bucket, trade and event writes', async () => {
  const f = await setup(); const local = await f.order();
  const accounts = f.database.records(f.probe.collections.accounts);
  f.database.failNextWrite(f.probe.collections.audit);
  await assert.rejects(f.probe.settle(local.id, f.remote(local)), /SIMULATED_WRITE_FAILURE/);
  assert.equal((await f.probe.state(local.id, 'probe_user_buyer')).order.status, 'pending');
  assert.equal(f.database.records(f.probe.collections.buckets).length, 0);
  assert.equal(f.database.records(f.probe.collections.trades).length, 0);
  assert.equal(f.database.records(f.probe.collections.events).length, 0);
  assert.deepEqual(f.database.records(f.probe.collections.accounts), accounts);
  await assert.rejects(f.probe.settle(local.id, { ...f.remote(local), paid_fee: 1 }), /ORDER_MISMATCH/);
  await f.probe.settle(local.id, f.remote(local));
});

test('document MVCC: two users racing the same channel trade can grant only one order', async () => {
  const f = await setup(); const buyer = await f.order(); const other = await f.order('probe_other_user_order', 'probe_user_other');
  const attempts = await Promise.allSettled([f.probe.settle(buyer.id, f.remote(buyer)),
    f.probe.settle(other.id, { ...f.remote(other), wx_order_id: f.remote(buyer).wx_order_id })]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(attempts.find(result => result.status === 'rejected').reason.message, /TRADE_CONFLICT/);
  const states = [await f.probe.state(buyer.id, 'probe_user_buyer'), await f.probe.state(other.id, 'probe_user_other')];
  assert.equal(states.filter(state => state.order.status === 'paid').length, 1);
  assert.equal(states.reduce((sum, state) => sum + (state.bucket?.remaining || 0), 0), 10);
  assert.equal(f.database.records(f.probe.collections.trades).length, 1);
  assert.ok(f.database.stats.conflicts > 0, 'trade document must conflict across different account documents');
});

test('document MVCC: simultaneous generation never overspends and reservations are owned and idempotent', async () => {
  const f = await setup(); const local = await f.paid();
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) => f.probe.reserve('probe_user_buyer', local.id, reference(`task-${i}`))));
  assert.equal(results.filter(result => result.ok).length, 10);
  const held = (await f.probe.state(local.id, 'probe_user_buyer')).bucket;
  assert.deepEqual([held.remaining, held.reserved, held.frozen], [0, 10, 0]);
  const reservation = f.database.records(f.probe.collections.reservations)[0];
  const task = Array.from({ length: 25 }, (_, i) => reference(`task-${i}`)).find(ref =>
    f.database.records(f.probe.collections.audit).some(row => row.action === 'creation.reserved' && row.reference === ref));
  assert.equal(reservation.orderId, local.id);
  assert.deepEqual(await f.probe.reserve('probe_user_buyer', local.id, task), { ok: true, duplicate: true });
  await assert.rejects(f.probe.reserve('probe_user_other', local.id, task), /OWNERSHIP_REQUIRED/);
  await assert.rejects(f.probe.finish('probe_user_other', task, 'failed'), /OWNERSHIP_REQUIRED/);
  await assert.rejects(f.probe.state(local.id, 'probe_user_other'), /OWNERSHIP_REQUIRED/);
});

test('document MVCC: simultaneous identical references reserve once and cannot refer to another order', async () => {
  const f = await setup(); const local = await f.paid(); const task = reference('one-shared-task');
  const attempts = await Promise.all(Array.from({ length: 20 }, () => f.probe.reserve('probe_user_buyer', local.id, task)));
  assert.equal(attempts.filter(result => result.ok && !result.duplicate).length, 1);
  assert.deepEqual([(await f.probe.state(local.id, 'probe_user_buyer')).bucket.remaining,
    (await f.probe.state(local.id, 'probe_user_buyer')).bucket.reserved], [9, 1]);
  const other = await f.paid('probe_another_paid_order');
  await assert.rejects(f.probe.reserve('probe_user_buyer', other.id, task), /RESERVATION_CONFLICT/);
});

test('document MVCC: caller snapshots cannot mutate the fixed server-owned product', async () => {
  const f = await setup(); const local = await f.order(); local.product.amountFen = 1; local.product.components[0].quantity = 999;
  const next = await f.order('probe_immutable_price_key');
  assert.equal(next.amountFen, 990); assert.equal(next.product.amountFen, 990); assert.equal(next.product.components[0].quantity, 10);
  assert.throws(() => f.probe.state(next.id), /USER_REQUIRED/);
});

test('document MVCC: refund freeze racing generation yields either frozen rights or one hold', async () => {
  const f = await setup(); const local = await f.paid();
  const [refund, reserve] = await Promise.allSettled([
    f.probe.requestRefund(local.id, 'probe_user_buyer'),
    f.probe.reserve('probe_user_buyer', local.id, reference('racing-task')),
  ]);
  assert.equal(reserve.status, 'fulfilled');
  const state = await f.probe.state(local.id, 'probe_user_buyer');
  if (refund.status === 'fulfilled') {
    assert.equal(state.order.status, 'refund_pending'); assert.equal(reserve.value.ok, false);
    assert.deepEqual([state.bucket.remaining, state.bucket.reserved, state.bucket.frozen], [0, 0, 10]);
  } else {
    assert.match(refund.reason.message, /GENERATION_PENDING/); assert.equal(reserve.value.ok, true);
    assert.deepEqual([state.bucket.remaining, state.bucket.reserved, state.bucket.frozen], [9, 1, 0]);
  }
  assert.ok(f.database.stats.conflicts > 0);
});

test('document MVCC: unknown generation stays held, definite failure returns once, refunded rights never revive', async () => {
  const f = await setup(); const local = await f.paid(); const task = reference('unknown-task');
  await f.probe.reserve('probe_user_buyer', local.id, task);
  await f.probe.finish('probe_user_buyer', task, 'unknown');
  assert.equal((await f.probe.state(local.id, 'probe_user_buyer')).bucket.reserved, 1);
  await assert.rejects(f.probe.requestRefund(local.id, 'probe_user_buyer'), /GENERATION_PENDING/);
  await f.probe.finish('probe_user_buyer', task, 'failed');
  assert.equal(await f.probe.finish('probe_user_buyer', task, 'failed'), false);
  assert.equal((await f.probe.state(local.id, 'probe_user_buyer')).bucket.remaining, 10);
  const other = reference('refund-overtakes-generation');
  await f.probe.reserve('probe_user_buyer', local.id, other); await f.probe.finish('probe_user_buyer', other, 'unknown');
  await f.probe.applyFullRefund(local.id, 'probe_user_buyer', 'probe_refund_channel_full_1');
  assert.equal((await f.probe.state(local.id, 'probe_user_buyer')).bucket.reserved, 1);
  await f.probe.finish('probe_user_buyer', other, 'failed');
  await f.probe.applyFullRefund(local.id, 'probe_user_buyer', 'probe_refund_channel_full_1');
  const state = await f.probe.state(local.id, 'probe_user_buyer');
  assert.equal(state.order.refundedFen, 990); assert.deepEqual([state.bucket.remaining, state.bucket.reserved, state.bucket.frozen], [0, 0, 0]);
  assert.equal((await f.probe.reserve('probe_user_buyer', local.id, reference('after-refund'))).ok, false);
});

test('document MVCC: a lost commit response is not retried, later idempotent settlement recovers it', async () => {
  const f = await setup(); const local = await f.order(); const starts = f.database.stats.starts;
  f.database.loseNextCommitResponse();
  await assert.rejects(f.probe.settle(local.id, f.remote(local)), /COMMIT_RESPONSE_LOST/);
  assert.equal(f.database.stats.starts - starts, 1, 'an ambiguous commit must never auto-retry');
  assert.equal((await f.probe.state(local.id, 'probe_user_buyer')).order.status, 'paid');
  await f.probe.settle(local.id, f.remote(local));
  assert.equal((await f.probe.state(local.id, 'probe_user_buyer')).bucket.remaining, 10);
  assert.equal(f.database.records(f.probe.collections.audit).filter(row => row.action === 'payment.granted').length, 1);
  assert.ok(f.database.stats.maxOperations < 100);
});

test('document MVCC: another probe instance reads committed rights without changing production runtime', async () => {
  const f = await setup(); const local = await f.paid();
  const restored = createCloudbaseProbe({ ...config, database: f.database, now: () => f.now });
  await restored.initialize();
  assert.equal((await restored.state(local.id, 'probe_user_buyer')).bucket.remaining, 10);
  const otherRun = createCloudbaseProbe({ ...config, runId: '123456abcdef', database: f.database, now: () => f.now });
  await otherRun.initialize();
  await assert.rejects(otherRun.state(local.id, 'probe_user_buyer'), /ORDER_NOT_FOUND/);
});
