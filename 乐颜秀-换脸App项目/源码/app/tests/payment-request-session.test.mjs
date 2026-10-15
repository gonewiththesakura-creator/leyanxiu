import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Exercise the actual payment client, replacing only its native/API boundaries.
// No server environment, browser session, SMS or payment network is loaded.
const source = fs.readFileSync(new URL('../src/lib/payments.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
} });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function client({ ok = true } = {}) {
  let generation = 1;
  const body = deferred();
  const readingBody = deferred();
  const requests = [];
  const apiBoundary = {
    getAccountSessionGeneration: () => generation,
    apiFetch: async (url, init) => {
      requests.push({ url, init });
      // apiFetch has already checked the current token when response headers
      // return. Reading a streamed JSON body is a later asynchronous boundary.
      return { ok, json: () => { readingBody.resolve(); return body.promise; } };
    },
  };
  const exports = {};
  const wrapper = vm.runInNewContext(`(function(exports, require) { ${outputText}\n})`, {}, { filename: 'payment-client-under-test.cjs' });
  wrapper(exports, name => {
    if (name === './api') return apiBoundary;
    if (name === '@capacitor/core') return {
      Capacitor: { getPlatform: () => 'web', isPluginAvailable: () => false },
      registerPlugin: () => ({ pay: () => { throw new Error('Native payment is forbidden in this fixture'); } }),
    };
    throw new Error(`Unexpected dependency: ${name}`);
  });
  return { api: exports, requests, body, readingBody, switchSession() { generation++; } };
}

test('an account change after headers but before create-order JSON rejects the old order result', async () => {
  const fixture = client();
  const pending = fixture.api.createPaymentOrder('monthly', 'account-A-retry');
  const rejected = assert.rejects(pending, /账号已切换/);
  await fixture.readingBody.promise;
  fixture.switchSession();
  fixture.body.resolve({ code: 0, data: { order: { id: 'order-A', productId: 'monthly', status: 'pending' }, paymentRequired: true, payment: { prepayid: 'prepay-A' } } });
  await rejected;
  assert.equal(fixture.requests.length, 1, 'changing accounts must not retry a write under the new session');
  assert.equal(JSON.parse(fixture.requests[0].init.body).idempotencyKey, 'account-A-retry');
});

test('old history, identity and refund responses cannot be adopted after switching sessions', async t => {
  for (const [name, request, data] of [
    ['orders', api => api.paymentOrders(), [{ id: 'order-A' }]],
    ['identity', api => api.paymentIdentity(), { userId: 'A', bound: true }],
    ['single order', api => api.paymentOrder('order-A'), { id: 'order-A', status: 'paid' }],
    ['refund quote', api => api.paymentRefundQuote('order-A'), { amountFen: 990, credits: 10 }],
    ['refund list', api => api.paymentRefunds(), [{ id: 'refund-A' }]],
    ['close', api => api.closePaymentOrder('order-A'), { order: { id: 'order-A', status: 'closed' } }],
    ['refund request', api => api.requestPaymentRefund('order-A', 'fixture only', 990), { refund: { id: 'refund-A' } }],
  ]) await t.test(name, async () => {
    const fixture = client();
    const pending = request(fixture.api);
    const rejected = assert.rejects(pending, /账号已切换/);
    await fixture.readingBody.promise;
    fixture.switchSession();
    fixture.body.resolve({ code: 0, data });
    await rejected;
    assert.equal(fixture.requests.length, 1);
  });
});

test('switching away and back still invalidates an older request even for the same account', async () => {
  const fixture = client();
  const pending = fixture.api.paymentOrder('order-A');
  const rejected = assert.rejects(pending, /账号已切换/);
  await fixture.readingBody.promise;
  fixture.switchSession(); fixture.switchSession();
  fixture.body.resolve({ code: 0, data: { id: 'order-A', status: 'paid' } });
  await rejected;
});

test('unchanged session preserves the order response and existing server error messages', async () => {
  const success = client();
  const pending = success.api.createPaymentOrder('monthly', 'unchanged-session-key');
  await success.readingBody.promise;
  success.body.resolve({ code: 0, data: { order: { id: 'order-A', status: 'paid' }, paymentRequired: false } });
  const result = await pending;
  assert.equal(result.order.id, 'order-A');
  assert.equal(result.paymentRequired, false);
  const failure = client({ ok: false });
  const failed = failure.api.paymentOrder('order-A');
  const rejected = assert.rejects(failed, /订单确认处理中/);
  await failure.readingBody.promise;
  failure.body.resolve({ code: 'PAYMENT_QUERY_FAILED', message: '订单确认处理中' });
  await rejected;
});
