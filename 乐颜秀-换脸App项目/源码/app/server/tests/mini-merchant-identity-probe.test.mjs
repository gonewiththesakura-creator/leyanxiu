import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { startMerchantIdentityProbe, pollMerchantIdentityProbe, privateIdentityRecord } from '../scripts/probe-mini-merchant-identity.mjs';

const userId = 'usr_00000000-0000-0000-0000-000000000001';
const config = { nonce: 'synthetic', target: { appId: 'wx0000000000000000', envId: 'synthetic-env', serviceName: 'buildtest' }, gray: { key: 'test', value: 'synthetic-route' } };
function fixture({ env = 0, page = 'pages/refund-ops/index', logout = true, malformed = false } = {}) {
  const calls = []; let nativeCalls = 0;
  const context = vm.createContext({ setTimeout, clearTimeout,
    getApp: () => ({ globalData: { apiTransport: { mode: 'cloud', env: config.target.envId, service: 'buildtest' } } }),
    getCurrentPages: () => [{ route: page }],
    wx: { getAccountInfoSync: () => ({ miniProgram: { appId: config.target.appId } }), getDeviceInfo: () => ({ platform: 'devtools' }),
      login: options => { nativeCalls++; options.success({ code: 'synthetic-code' }); },
      cloud: { callContainer: async options => {
        calls.push(options);
        assert.equal(new URLSearchParams(options.path.split('?')[1]).get(config.gray.key), config.gray.value);
        const route = options.path.split('?')[0];
        if (route === '/health') return { statusCode: 200, data: { ok: true, service: 'mini-photo-production', env, mode: 'closed', ledgerOnlySandbox: false,
          accepting: true, payment: { prepared: true, operationsReady: true }, photo: { prepared: true, generationEnabled: false, available: false },
          productionPaymentsEnabled: false, salesEnabled: false, generationAvailable: false } };
        if (route === '/api/auth/wechat') return { statusCode: 200, data: { code: 0, data: { token: 'synthetic-token', user: { id: malformed ? 'wrong' : userId }, openid: 'synthetic-openid' } } };
        if (route === '/api/auth/logout') { if (!logout) throw new Error('synthetic-token'); return { statusCode: 200, data: { code: 0, data: { loggedOut: true } } }; }
        assert.fail('No other operation is allowed');
      } },
    },
  });
  return { calls, nativeCalls: () => nativeCalls,
    start: () => vm.runInContext('(' + startMerchantIdentityProbe.toString() + ')', context)(config),
    poll: () => JSON.parse(JSON.stringify(vm.runInContext('(' + pollMerchantIdentityProbe.toString() + ')', context)(config.nonce))) };
}
async function finish(f) {
  f.start();
  for (let i = 0; i < 30; i++) { const value = f.poll(); if (!value.pending) return value; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Synthetic probe did not finish');
}
test('env0 identity uses only exact-route health, one login and logout; stored record contains no credential or openid', async () => {
  const f = fixture(), result = await finish(f);
  assert.equal(result.ok, true); assert.equal(f.nativeCalls(), 1);
  assert.deepEqual(f.calls.map(x => x.path.split('?')[0]), ['/health', '/api/auth/wechat', '/api/auth/logout']);
  const record = privateIdentityRecord(result, { sameAccountRefundOperator: true });
  assert.deepEqual(record.testUserIds, [userId]); assert.deepEqual(record.refundOperatorUserIds, [userId]);
  assert.equal(record.env, 0); assert.equal(record.logoutConfirmed, true);
  assert.doesNotMatch(JSON.stringify(record), /synthetic-token|synthetic-openid|synthetic-code|synthetic-route/);
  assert.equal(f.start().alreadyStarted, true); assert.equal(f.calls.length, 3);
});
test('env1 health and a page that can auto-login are rejected before wx.login', async () => {
  for (const options of [{ env: 1 }, { page: 'pages/service/index' }]) {
    const f = fixture(options), result = await finish(f);
    assert.equal(result.ok, false); assert.equal(f.nativeCalls(), 0); assert.ok(f.calls.length <= 1);
    assert.equal(result.privateUserId, undefined);
  }
});
test('failed logout and malformed UUID cannot produce an identity record or leak credentials', async () => {
  for (const options of [{ logout: false }, { malformed: true }]) {
    const f = fixture(options), result = await finish(f);
    assert.equal(result.ok, false); assert.equal(result.privateUserId, undefined);
    assert.doesNotMatch(JSON.stringify(result), /synthetic-token|synthetic-openid|synthetic-code|synthetic-route/);
    assert.throws(() => privateIdentityRecord(result, { sameAccountRefundOperator: true }), /IDENTITY_RESULT_INVALID/);
  }
});
test('same-account refund role requires explicit authorization and unverified response cannot become a private record', async () => {
  const result = await finish(fixture());
  assert.throws(() => privateIdentityRecord(result), /IDENTITY_RESULT_INVALID/);
  assert.throws(() => privateIdentityRecord({ ...result, healthEnv0Closed: false }, { sameAccountRefundOperator: true }), /IDENTITY_RESULT_INVALID/);
});
