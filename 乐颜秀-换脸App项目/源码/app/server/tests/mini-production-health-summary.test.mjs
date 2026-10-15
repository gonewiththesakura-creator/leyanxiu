import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeMiniProductionHealth } from '../scripts/mini-production-health-summary.mjs';

const response = () => ({ statusCode: 200, data: { ok: true, service: 'mini-photo-production', env: 0,
  mode: 'closed', accepting: true, productionPaymentsEnabled: false, salesEnabled: false, ledgerOnlySandbox: false,
  payment: { prepared: true, operationsReady: true }, photo: { prepared: true, generationEnabled: false, available: false },
  generationAvailable: false } });

test('closed health projection accepts the exact existing contract and emits only booleans', () => {
  for (const text of [false, true]) {
    const value = response(); value.data.ignoredSecret = 'must-not-leak';
    if (text) value.data = JSON.stringify(value.data);
    const result = summarizeMiniProductionHealth(value);
    assert.equal(result.closedHostHealthy, true);
    assert.equal(Object.values(result).every(item => typeof item === 'boolean'), true);
    assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
    assert.equal(Object.isFrozen(result), true);
  }
});

test('old sandbox, unprepared schema, open capability, bad scope and HTTP errors cannot pass', () => {
  const mutations = [
    value => { value.data.service = 'mini-payment-sandbox'; }, value => { value.data.env = 1; },
    value => { value.data.mode = 'merchant_test'; }, value => { value.data.ledgerOnlySandbox = true; },
    value => { value.data.payment.prepared = false; }, value => { value.data.payment.operationsReady = false; },
    value => { value.data.photo.prepared = false; }, value => { value.data.accepting = false; },
    value => { value.data.productionPaymentsEnabled = true; }, value => { value.data.salesEnabled = true; },
    value => { value.data.generationAvailable = true; }, value => { value.data.photo.available = true; },
    value => { value.data.photo.generationEnabled = true; }, value => { value.data.ok = false; },
    value => { value.statusCode = 503; }, value => { value.data.env = '0'; },
    value => { delete value.data.photo.prepared; },
  ];
  for (const mutate of mutations) {
    const value = response(); mutate(value);
    assert.equal(summarizeMiniProductionHealth(value).closedHostHealthy, false);
  }
});

test('unknown/oversized/malformed responses and getters never leak or become healthy', () => {
  let getterCalls = 0;
  const getter = { get data() { getterCalls++; throw new Error('must-not-leak'); }, statusCode: 200 };
  for (const value of [null, {}, [], getter, { statusCode: 200, data: '<html>private</html>' },
    { statusCode: 200, data: ' '.repeat(16385) + '{}' },
    { statusCode: 200, data: { ...response().data, get photo() { getterCalls++; throw new Error('must-not-leak'); } } }]) {
    const result = summarizeMiniProductionHealth(value);
    assert.equal(result.closedHostHealthy, false);
    assert.equal(Object.values(result).every(item => typeof item === 'boolean'), true);
    assert.equal(JSON.stringify(result).includes('private'), false);
  }
  assert.equal(getterCalls, 0);
});
