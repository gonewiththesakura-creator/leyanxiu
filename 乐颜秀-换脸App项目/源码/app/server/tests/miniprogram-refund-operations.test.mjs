import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const { createRefundOperationsClient } = createRequire(import.meta.url)('../../miniprogram/refund-operations.js');
const endpoint = { mode: 'cloud', env: 'fictional-env', service: 'fictional-service' };
const userId = 'usr_00000000-0000-4000-8000-000000000001';
const otherUser = 'usr_00000000-0000-4000-8000-000000000002';
const base = '/api/mini/operations/refunds';
const pendingKey = `lyx-refund-review-pending:${userId}`;
const refund = () => ({ id: 'a'.repeat(32), orderId: 'b'.repeat(32), amountFen: 990, createdAt: 1800000000000,
  status: 'requested', reviewable: true });
const ok = data => ({ statusCode: 200, data: { code: 0, data } });
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

function fixture({ override, storage = new Map(), operator = true } = {}) {
  const calls = [], mutations = [], navigations = [], modals = [];
  let identity = userId, row = refund();
  const wx = {
    login: options => options.success({ code: 'synthetic-code' }),
    getStorageSync: key => structuredClone(storage.get(key)),
    setStorageSync: (key, value) => storage.set(key, structuredClone(value)),
    removeStorageSync: key => storage.delete(key),
    request: () => assert.fail('no public transport fallback'),
    showModal: options => { modals.push(options); options.success({ confirm: true }); },
    navigateTo: options => navigations.push(options.url),
    cloud: { async callContainer(call) {
      calls.push(structuredClone(call));
      if (call.path.endsWith('/review')) mutations.push(structuredClone(call));
      const response = await override?.(call); if (response) return response;
      if (call.path === '/api/auth/wechat') return ok({ token: 'synthetic-token', user: { id: identity } });
      if (call.path === '/api/mini/operations/status') return ok({ operator });
      if (call.path === base) return ok([structuredClone(row)]);
      if (call.path === `${base}/${row.id}`) return ok(structuredClone(row));
      if (call.path === `${base}/${row.id}/review`) {
        assert.deepEqual(storage.get(`lyx-refund-review-pending:${identity}`), {
          refundId: row.id, orderId: row.orderId, amountFen: row.amountFen, approve: call.data.approve });
        row = { ...row, reviewable: false, status: call.data.approve ? 'processing' : 'rejected' }; return ok(structuredClone(row));
      }
      assert.fail(`unexpected synthetic path: ${call.path}`);
    } },
  };
  return { wx, client: createRefundOperationsClient(wx, endpoint), storage, calls, mutations, modals, navigations,
    switchAccount: value => { identity = value; }, changeRefund: update => { row = { ...row, ...update }; } };
}
function pageFixture(f) {
  let page;
  runInNewContext(readFileSync(new URL('../../miniprogram/pages/refund-ops/index.js', import.meta.url), 'utf8'), {
    Page: value => { page = value; }, wx: f.wx, require: () => ({ createRefundOperationsClient: () => f.client }),
    getApp: () => ({ globalData: { apiTransport: endpoint } }),
  });
  page.data = structuredClone(page.data); page.setData = value => Object.assign(page.data, value); page.onLoad(); page.onShow(); return page;
}
const selectedEvent = { currentTarget: { dataset: { id: 'a'.repeat(32) } } };
const approveEvent = { currentTarget: { dataset: { decision: 'approve' } } };

test('only exact server operator true opens the list; forged local storage and malformed truthy values do not authorize', async () => {
  for (const operator of [false, 'true', 1, null]) {
    const f = fixture({ operator, storage: new Map([['operator', true]]) });
    await assert.rejects(f.client.login(), { code: 'XPAY_REFUND_OPERATOR_FORBIDDEN' });
    assert.equal(f.client.snapshot().operator, false); assert.equal(f.calls.some(call => call.path === base), false);
    await assert.rejects(f.client.review(refund(), true, true)); assert.equal(f.mutations.length, 0);
  }
});

test('approved or rejected review freshly logs in, confirms server order and amount, persists first and submits once', async () => {
  for (const approve of [true, false]) {
    const f = fixture(); await f.client.login(); const shown = await f.client.detail(refund().id);
    const result = await f.client.review(shown, approve, true);
    assert.equal(f.calls.filter(call => call.path === '/api/auth/wechat').length, 2);
    assert.equal(f.mutations.length, 1);
    assert.deepEqual(f.mutations[0].data, { confirm: true, approve, expectedOrderId: shown.orderId, expectedAmountFen: 990 });
    assert.equal(result.status, approve ? 'processing' : 'rejected');
    assert.equal(f.client.snapshot().records[0].status, result.status); assert.equal(f.storage.has(pendingKey), false);
    if (approve) assert.match(result.statusLabel, /尚未确认到账/);
  }
});

test('missing confirmation, changed amount, changed order and already reviewed state never issue POST', async () => {
  for (const drift of [{ amountFen: 989 }, { orderId: 'c'.repeat(32) }, { status: 'processing', reviewable: false }]) {
    const f = fixture(); await f.client.login(); const shown = await f.client.detail(refund().id);
    await assert.rejects(f.client.review(shown, true, false), { code: 'REFUND_OPS_CONFIRMATION_REQUIRED' });
    f.changeRefund(drift);
    await assert.rejects(f.client.review(shown, true, true), { code: 'REFUND_OPS_CONFIRMATION_CHANGED' });
    assert.equal(f.mutations.length, 0); assert.equal(f.storage.has(pendingKey), false);
  }
});

test('failed persistent intent prevents mutation; unrelated pending orders are untouched', async () => {
  const f = fixture({ storage: new Map([['lyx-payment-pending:other', { original: true }]]) }); await f.client.login();
  f.wx.setStorageSync = () => { throw Error('synthetic storage failure'); };
  await assert.rejects(f.client.review(refund(), true, true), /storage failure/);
  assert.equal(f.mutations.length, 0); assert.deepEqual(f.storage.get('lyx-payment-pending:other'), { original: true });
});

test('one pending approval survives restart and only GET can resolve it; requested state never unlocks replay', async () => {
  const storage = new Map(); const f = fixture({ storage, override: call => {
    if (call.path.endsWith('/review')) throw Error('synthetic lost response');
  } });
  await f.client.login(); await assert.rejects(f.client.review(refund(), true, true), { code: 'REFUND_OPS_UNCONFIRMED' });
  assert.equal(f.mutations.length, 1); assert.ok(storage.get(pendingKey));
  const next = fixture({ storage }); await next.client.login();
  assert.ok(next.client.snapshot().pending); assert.equal(next.mutations.length, 0);
  await assert.rejects(next.client.review(refund(), true, true), { code: 'REFUND_OPS_UNCONFIRMED' });
  next.changeRefund({ status: 'processing', reviewable: false }); await next.client.refresh();
  assert.equal(next.client.snapshot().pending, null); assert.equal(storage.has(pendingKey), false); assert.equal(next.mutations.length, 0);
});

test('invalid or drifted recovered receipts retain the original pending intent without mutation', async () => {
  for (const update of [{ amountFen: 989 }, { orderId: 'c'.repeat(32) }, { status: 'unknown' }]) {
    const original = { refundId: refund().id, orderId: refund().orderId, amountFen: 990, approve: true };
    const f = fixture({ storage: new Map([[pendingKey, original]]) }); f.changeRefund(update);
    await assert.rejects(f.client.login()); assert.deepEqual(f.storage.get(pendingKey), original); assert.equal(f.mutations.length, 0);
  }
});

test('an ambiguous successful HTTP response is not trusted or repeated when amount or state differs', async () => {
  for (const response of [{ ...refund(), amountFen: 989, status: 'processing', reviewable: false },
    { ...refund(), status: 'succeeded', reviewable: false }, { ...refund(), id: 'c'.repeat(32), status: 'processing', reviewable: false }]) {
    const f = fixture({ override: call => call.path.endsWith('/review') ? ok(response) : undefined }); await f.client.login();
    await assert.rejects(f.client.review(refund(), true, true), { code: 'REFUND_OPS_UNCONFIRMED' });
    assert.equal(f.mutations.length, 1); assert.ok(f.storage.get(pendingKey));
  }
});

test('concurrent clicks are locked before re-login or mutation; one approval is submitted', async () => {
  const started = deferred(), release = deferred(); let wait = false;
  const f = fixture({ override: async call => { if (wait && call.path === '/api/auth/wechat') { started.resolve(); await release.promise; } } });
  await f.client.login(); wait = true; const first = f.client.review(refund(), true, true); await started.promise;
  await assert.rejects(f.client.review(refund(), false, true), { code: 'REFUND_OPS_BUSY' }); release.resolve(); await first;
  assert.equal(f.mutations.length, 1);
});

test('hiding and re-entering during fresh-login or detail lookup requires a new visible confirmation', async () => {
  for (const phase of ['login', 'detail']) {
    const started = deferred(), release = deferred(); let wait = false;
    const f = fixture({ override: async call => {
      if (wait && call.path === (phase === 'login' ? '/api/auth/wechat' : `${base}/${refund().id}`)) { started.resolve(); await release.promise; }
    } });
    await f.client.login(); wait = true; const first = f.client.review(refund(), true, true); await started.promise;
    f.client.setActive(false); f.client.setActive(true); release.resolve();
    await assert.rejects(first, { code: 'REFUND_OPS_INACTIVE' }); assert.equal(f.mutations.length, 0); assert.equal(f.storage.has(pendingKey), false);
  }
});

test('fresh login changing account never submits or reads the former operators refund under the other identity', async () => {
  const f = fixture(); await f.client.login(); const before = f.calls.length; f.switchAccount(otherUser);
  await assert.rejects(f.client.review(refund(), true, true), { code: 'XPAY_ACCOUNT_CHANGED' });
  assert.deepEqual(f.calls.slice(before).map(call => call.path), ['/api/auth/wechat']); assert.equal(f.mutations.length, 0);
});

test('page cancel, invalid decision, hidden modal and double tap do not send accidental reviews', async () => {
  for (const scenario of ['cancel', 'hidden', 'invalid']) {
    const f = fixture(); const page = pageFixture(f); await page.login(); await page.select(selectedEvent);
    f.wx.showModal = options => { if (scenario === 'hidden') { page.onHide(); page.onShow(); } options.success({ confirm: scenario !== 'cancel' }); };
    await page.review(scenario === 'invalid' ? { currentTarget: { dataset: { decision: 'typo' } } } : approveEvent);
    assert.equal(f.mutations.length, 0); assert.equal(page.data.busy, false);
  }
  const f = fixture(); const page = pageFixture(f); await page.login(); await page.select(selectedEvent);
  const started = deferred(), answer = deferred();
  f.wx.showModal = async options => { started.resolve(); await answer.promise; options.success({ confirm: true }); };
  const first = page.review(approveEvent); await started.promise; await page.review(approveEvent); answer.resolve(); await first;
  assert.equal(f.mutations.length, 1); assert.match(page.data.notice, /尚未确认到账/); assert.equal(page.data.busy, false);
});

test('page unknown mutation immediately displays persisted lock and refresh recovers without any second POST', async () => {
  const f = fixture({ override: call => { if (call.path.endsWith('/review')) throw Error('synthetic lost response'); } });
  const page = pageFixture(f); await page.login(); await page.select(selectedEvent); await page.review(approveEvent);
  assert.ok(page.data.pending); assert.match(page.data.notice, /勿重复提交/); await page.review(approveEvent); assert.equal(f.mutations.length, 1);
  f.changeRefund({ status: 'processing', reviewable: false }); await page.refresh();
  assert.equal(page.data.pending, null); assert.equal(f.mutations.length, 1); assert.match(page.data.records[0].statusLabel, /尚未确认到账/);
});

test('page drops private operator state on account switch and discards late detail after hiding', async () => {
  const f = fixture(); const page = pageFixture(f); await page.login(); await page.select(selectedEvent); f.switchAccount(otherUser);
  await page.review(approveEvent); assert.equal(page.data.operator, false); assert.equal(page.data.records.length, 0); assert.equal(page.data.selected, null);
  const started = deferred(), release = deferred(); let wait = false;
  const late = fixture({ override: async call => { if (wait && call.path === `${base}/${refund().id}`) { started.resolve(); await release.promise; } } });
  const latePage = pageFixture(late); await latePage.login(); wait = true;
  const selecting = latePage.select(selectedEvent); await started.promise; latePage.onHide(); latePage.onShow(); release.resolve(); await selecting;
  assert.equal(latePage.data.selected, null); assert.equal(latePage.data.records.length, 0);
});
