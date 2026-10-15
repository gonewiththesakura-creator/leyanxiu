import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDefaultAnonymousProbe, pollDefaultAnonymousProbe, safeDefaultReport } from '../scripts/probe-mini-018-default-readonly.mjs';
import { createCloudBusinessEndpoint } from '../payments/virtual/cloud-business-endpoint.js';
const config = { nonce: 'test', target: { appId: 'synthetic-app', envId: 'synthetic-env', serviceName: 'buildtest' } };
const canary = 'SYNTHETIC_SECRET_NEVER_PRINT';
const callbackEndpoint = createCloudBusinessEndpoint({ appId: 'synthetic-app',
  ledger: new Proxy({}, { get() { assert.fail('GET must not access the ledger'); } }),
  adapter: { appId: 'synthetic-app', env: 0, query() { assert.fail('GET must not query payment provider'); } },
  readiness() { assert.fail('GET must not access readiness'); }, alert() { assert.fail('GET must not emit business alerts'); } });
// Use the production handler response, including its actual WeChat ACK field names.
const callbackResponse = await callbackEndpoint(new Request('https://synthetic.invalid/api/mini/payments/notify/cloud'));
const actualCallback = { status: callbackResponse.status, data: await callbackResponse.json() };
function fixture({ mutate = () => {}, connected = false, pageClient, failRoute } = {}) {
  const bodies = {
    '/health': { ok: true, service: 'mini-photo-production', env: 0, mode: 'merchant_test', ledgerOnlySandbox: false,
      accepting: true, payment: { prepared: true, operationsReady: true }, photo: { prepared: true, generationEnabled: true, available: true },
      salesEnabled: true, productionPaymentsEnabled: true, generationAvailable: true },
    '/api/mini/payments/notify/cloud': structuredClone(actualCallback.data),
    '/api/mini/payments/products': { code: 0, data: { mode: 'merchant_test', ledgerOnlySandbox: false, available: false, products: [] } },
    '/api/catalog': { code: 0, data: { settings: { generationEnabled: false }, photoEffects: [], miniProgramCreation: { available: false, photoEffectIds: [] } } },
    '/api/capabilities': { code: 0, data: [{ id: 'photo-effects', ready: false }] },
  };
  mutate(bodies); const calls = [];
  const context = vm.createContext({ setTimeout, clearTimeout,
    getApp: () => ({ globalData: { creationEnabled: true, apiTransport: { mode: 'cloud', env: config.target.envId, service: 'buildtest' } } }),
    getCurrentPages: () => [{ route: 'pages/mine/index', data: { connected }, client: pageClient }],
    wx: { getAccountInfoSync: () => ({ miniProgram: { appId: config.target.appId } }), getDeviceInfo: () => ({ platform: 'devtools' }),
      login: () => assert.fail('Anonymous probe must never log in'), cloud: { callContainer: async options => {
        calls.push(options); assert.equal(options.method, 'GET'); assert.equal(options.path.includes('?'), false);
        assert.deepEqual(Object.keys(options.header), ['X-WX-SERVICE']); assert.equal(options.config.env, config.target.envId);
        assert.ok(Object.hasOwn(bodies, options.path)); if (options.path === failRoute) throw Error(canary);
        return { statusCode: options.path.includes('/notify/') ? actualCallback.status : 200, data: bodies[options.path] };
      } } },
  });
  return { calls, start: () => vm.runInContext('(' + startDefaultAnonymousProbe.toString() + ')', context)(config),
    poll: () => JSON.parse(JSON.stringify(vm.runInContext('(' + pollDefaultAnonymousProbe.toString() + ')', context)(config.nonce))) };
}
async function finish(f) {
  f.start(); for (let i = 0; i < 40; i++) { const value = f.poll(); if (!value.pending) return safeDefaultReport(value); await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('not finished');
}
test('original anonymous default probe makes exactly five GETs including callback405 and never authenticates', async () => {
  assert.equal(actualCallback.status, 405);
  assert.deepEqual(actualCallback.data, { ErrCode: 1, ErrMsg: 'XPAY_METHOD_INVALID' });
  const f = fixture(), report = await finish(f);
  assert.equal(report.ok, true); assert.equal(report.calls, 5); assert.equal(report.reads.callback.status, 405);
  assert.equal(report.reads.callback.ok, true); assert.equal(report.loginAttempted, false);
  assert.equal(f.start().alreadyStarted, true); assert.equal(f.calls.length, 5);
  assert.doesNotMatch(JSON.stringify(report), /SYNTHETIC_SECRET|token|Authorization/);
});
test('anonymous boundary drift, active page client or transport failure fail closed without retry', async () => {
  for (const options of [{ connected: true }, { pageClient: {} }, { failRoute: '/health' },
    { mutate: b => { b['/health'].env = 1; } }, { mutate: b => { b['/api/mini/payments/notify/cloud'].ErrMsg = 'OK'; } },
    { mutate: b => { b['/api/mini/payments/notify/cloud'] = { code: 1, message: 'XPAY_METHOD_INVALID' }; } },
    { mutate: b => { b['/api/mini/payments/products'].data.products = [{ id: 'photo10' }]; } },
    { mutate: b => { b['/api/catalog'].data.photoEffects = [{ id: 'modern-comic' }]; } },
    { mutate: b => { b['/api/capabilities'].data[0].ready = true; } }]) {
    const f = fixture(options), report = await finish(f); assert.equal(report.ok, false); assert.ok(f.calls.length <= 5);
    assert.equal(new Set(f.calls.map(call => call.path)).size, f.calls.length);
    assert.doesNotMatch(JSON.stringify(report), new RegExp(canary));
  }
});
test('new CLI is inert without private reads and exposes no tool or transport diagnostics', () => {
  const script = fileURLToPath(new URL('../scripts/probe-mini-018-default-readonly.mjs', import.meta.url));
  for (const args of [[], ['--plan']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); const plan = JSON.parse(result.stdout);
    assert.equal(plan.planOnly, true); assert.equal(plan.privateFilesRead, false); assert.equal(plan.cloudOperationPerformed, false);
    assert.equal(plan.grayParameterUsed, false); assert.equal(result.stderr, '');
  }
});
