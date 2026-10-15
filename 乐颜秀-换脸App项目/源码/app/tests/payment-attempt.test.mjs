import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/payment-attempt.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
const { loadPaymentAttempt, savePaymentAttempt } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
function storage() {
  const data = new Map();
  return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}
const attempt = { productId: 'monthly', key: 'retry-A', orderId: 'order-A' };

test('returning to A resumes A, B cannot inherit or clear its retry, and an old unowned cache is ignored', () => {
  const store = storage();
  store.setItem('lyx_payment_attempt_v1', JSON.stringify(attempt));
  assert.equal(loadPaymentAttempt('B', store), null);
  savePaymentAttempt('A', attempt, store);
  assert.equal(loadPaymentAttempt('B', store), null);
  savePaymentAttempt('B', { productId: 'pack', key: 'retry-B' }, store);
  savePaymentAttempt('B', null, store);
  assert.deepEqual(loadPaymentAttempt('A', store), attempt);
  assert.equal(loadPaymentAttempt('B', store), null);
});

test('mismatched owner, malformed JSON, empty IDs and unsupported versions cannot start a retry', () => {
  const store = storage();
  for (const value of ['{', JSON.stringify({ version: 1, userId: 'A', attempt }),
    JSON.stringify({ version: 2, userId: 'B', attempt }),
    JSON.stringify({ version: 2, userId: 'A', attempt: { ...attempt, orderId: {} } })]) {
    store.setItem('lyx_payment_attempt_v2:A', value);
    assert.equal(loadPaymentAttempt('A', store), null);
  }
  assert.throws(() => loadPaymentAttempt('', store), /账号尚未确认/);
  assert.throws(() => savePaymentAttempt('A', { ...attempt, key: '' }, store), /购买进度无效/);
});

test('storage denial is explicit so a new order cannot silently lose its idempotency key', () => {
  const denied = () => { throw new Error('private implementation details'); };
  const store = { getItem: denied, setItem: denied, removeItem: denied };
  for (const action of [() => loadPaymentAttempt('A', store), () => savePaymentAttempt('A', attempt, store), () => savePaymentAttempt('A', null, store)]) {
    assert.throws(action, error => error.message.includes('无法保存购买进度') && !error.message.includes('private'));
  }
});
