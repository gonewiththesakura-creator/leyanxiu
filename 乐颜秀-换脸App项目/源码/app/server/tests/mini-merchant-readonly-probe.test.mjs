import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { startMerchantReadonlyProbe, pollMerchantReadonlyProbe, safeMerchantReadonlyReport, merchantProbeIdentity,
  merchantReadonlyPlan, threeEffectsMerchantProfile, threeEffectsMerchantRouteFilename,
  runMerchantReadonlyProbe, default018MerchantProfile } from '../scripts/probe-mini-merchant-readonly.mjs';
import { threeEffectsMerchantReadonlyPlan, runThreeEffectsMerchantReadonlyProbe } from '../scripts/probe-mini-three-effects-merchant-readonly.mjs';
import { fallbackMerchantProfile, fallbackPublicFacts } from '../scripts/mini-disclosure-fallback-probe-route.mjs';
import { fallbackMerchantReadonlyPlan, runFallbackMerchantReadonlyProbe } from '../scripts/probe-mini-disclosure-fallback-readonly.mjs';

const userId = 'usr_00000000-0000-0000-0000-000000000001';
const canary = 'SYNTHETIC_PRIVATE_DO_NOT_PRINT';
const config = { nonce: 'new-synthetic-nonce', expectedUserId: userId,
  target: { appId: 'wx0000000000000000', envId: 'synthetic-env', serviceName: 'buildtest' }, gray: { key: 'test', value: canary } };
const bodies = () => ({
  '/health': { ok: true, service: 'mini-photo-production', env: 0, mode: 'merchant_test', ledgerOnlySandbox: false,
    accepting: true, payment: { prepared: true, operationsReady: true }, photo: { prepared: true, generationEnabled: true, available: true },
    productionPaymentsEnabled: true, salesEnabled: true, generationAvailable: true },
  '/api/auth/wechat': { token: canary, openid: canary, user: { id: userId } },
  '/api/auth/logout': { loggedOut: true },
  '/api/mini/payments/products': { available: true, mode: 'merchant_test', ledgerOnlySandbox: false, autoRenew: false,
    purchaseProfile: 'android-only-v1', supportedPlatforms: ['android'], rulesVersion: 'mini-pay-v1-20260927',
    products: [{ id: 'photo10', name: '图片处理10次包', type: 'pack', amountFen: 990, days: 365,
      components: [{ kind: 'photo', quantity: 10, valueFen: 990 }] }] },
  '/api/catalog': { settings: { generationEnabled: true },
    miniProgramCreation: { available: true, jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1', photoEffectIds: ['natural-avatar'] },
    photoEffects: [{ id: 'natural-avatar', title: '自然 AI 头像', enabled: true }] },
  '/api/capabilities': [{ id: 'photo-effects', route: '/api/mini/photo-jobs', ready: true, status: 'verified' }],
  '/api/mini/payments/entitlements': { available: { photo: 0, video: 0 }, buckets: [{ id: canary }] },
  '/api/mini/payments/orders': [{ id: canary }],
  '/api/mini/payments/refunds': [{ id: canary }],
  '/api/public/compliance': { status: 'approved', operatorName: 'synthetic company', supportContact: 'synthetic@example.invalid',
    privacyPolicyUrl: 'https://example.invalid/privacy', userAgreementUrl: 'https://example.invalid/terms', thirdPartyListUrl: 'https://example.invalid/providers',
    consentVersions: { basic: 'mini-photo-basic-closed-20261012', faceProcessing: 'mini-photo-face-closed-20261012' },
    retention: { sourceHours: 24, resultHours: 24, supplierPolicy: 'synthetic disclosure' },
    aiServices: [{ provider: 'aliyun-qwen-image', model: 'qwen-image-2.0-2026-03-03', purpose: '提供自然 AI 头像图片处理',
      region: 'cn-shanghai', filingReference: 'synthetic-reference', capabilities: ['photo-effect'] }] },
});
function fixture({ mutate = () => {}, page = 'pages/refund-ops/index', creationEnabled = true, failRoute, profile, expectedPublicFacts, pageClient, connected = false } = {}) {
  const values = bodies(), calls = []; let nativeCalls = 0; mutate(values);
  const context = vm.createContext({ setTimeout, clearTimeout,
    getApp: () => ({ globalData: { creationEnabled, apiTransport: { mode: 'cloud', env: config.target.envId, service: 'buildtest' } } }),
    getCurrentPages: () => [{ route: page, data: { connected }, client: pageClient }],
    wx: { getAccountInfoSync: () => ({ miniProgram: { appId: config.target.appId } }), getDeviceInfo: () => ({ platform: 'devtools' }),
      login: options => { nativeCalls++; options.success({ code: 'synthetic-code' }); },
      cloud: { callContainer: async options => {
        calls.push(options); const [route, query] = options.path.split('?');
        if (profile === default018MerchantProfile) assert.equal(query, undefined);
        else assert.equal(new URLSearchParams(query).get(config.gray.key), config.gray.value);
        assert.equal(options.config.env, config.target.envId); assert.equal(options.header['X-WX-SERVICE'], 'buildtest');
        assert.equal(options.method, ['/api/auth/wechat', '/api/auth/logout'].includes(route) ? 'POST' : 'GET');
        assert.ok(Object.hasOwn(values, route), 'Never create order, refund, consent, media or job');
        if (route === failRoute) throw new Error(canary);
        return { statusCode: 200, data: route === '/health' ? values[route] : { code: 0, data: values[route] } };
      } },
    },
  });
  return { calls, nativeCalls: () => nativeCalls,
    start: (selectedProfile = profile) => vm.runInContext('(' + startMerchantReadonlyProbe.toString() + ')', context)({ ...config, expectedPublicFacts, ...(selectedProfile ? { profile: selectedProfile } : {}) }),
    legacyPoll: () => JSON.parse(JSON.stringify(vm.runInContext('(' + pollMerchantReadonlyProbe.toString() + ')', context)(config.nonce))),
    poll: (nonce = config.nonce, selectedProfile = profile) => JSON.parse(JSON.stringify(vm.runInContext('(' + pollMerchantReadonlyProbe.toString() + ')', context)(nonce, selectedProfile))) };
}
async function finish(f) {
  f.start();
  for (let i = 0; i < 40; i++) { const result = f.poll(); if (!result.pending) return result; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Synthetic probe did not finish');
}
test('one new native merchant probe verifies same user, exact product/effect and gates with only ten cloud requests', async () => {
  const f = fixture(), value = await finish(f), result = safeMerchantReadonlyReport(value);
  assert.equal(result.ok, true); assert.equal(result.calls, 10); assert.equal(f.nativeCalls(), 1);
  assert.equal(result.identityMatched, true); assert.equal(result.testUserAdmissionConfirmed, true);
  assert.equal(result.generationGatesConfirmed, true); assert.equal(result.logoutConfirmed, true);
  assert.equal(result.reads.products.exactProduct, true); assert.equal(result.reads.catalog.exactEffect, true);
  assert.equal(result.reads.entitlements.validCounts, true, 'Zero balance does not block a read-only readiness check');
  assert.equal(f.calls[0].path.split('?')[0], '/health');
  assert.equal(f.calls.at(-1).path.split('?')[0], '/api/auth/logout');
  assert.equal(f.start().alreadyStarted, true); assert.equal(f.calls.length, 10);
  assert.equal(f.poll('another-nonce').started, false);
  assert.doesNotMatch(JSON.stringify(value), new RegExp(canary + '|' + userId + '|synthetic-code'));
  assert.deepEqual([result.paymentCalled, result.uploadCalled, result.generationCalled], [false, false, false]);
});
test('old env1, old closed release and unsafe auto-login page stop before native login', async () => {
  for (const options of [{ mutate: b => { b['/health'].env = 1; } }, { mutate: b => { b['/health'].mode = 'closed'; } },
    { page: 'pages/service/index' }, { creationEnabled: false }]) {
    const f = fixture(options), result = await finish(f);
    assert.equal(result.ok, false); assert.equal(f.nativeCalls(), 0); assert.ok(f.calls.length <= 1);
  }
});
test('different account is logged out without product, media or payment reads', async () => {
  const f = fixture({ mutate: b => { b['/api/auth/wechat'].user.id = 'usr_00000000-0000-0000-0000-000000000002'; } });
  const result = await finish(f);
  assert.equal(result.failure, 'identity_mismatch'); assert.equal(result.logoutConfirmed, true); assert.equal(result.identityMatched, false);
  assert.deepEqual(f.calls.map(x => x.path.split('?')[0]), ['/health', '/api/auth/wechat', '/api/auth/logout']);
});
test('current public facts use the disclosed Chinese purpose and region, not the internal entitlement key', async () => {
  const facts = JSON.parse(fs.readFileSync(new URL('../docs/production-config/natural-avatar-merchant-public-facts-2026-10-13.json', import.meta.url), 'utf8'));
  const f = fixture({ mutate: b => {
    Object.assign(b['/api/public/compliance'], facts.publicDocuments, { aiServices: facts.aiServiceDisclosures });
    b['/api/public/compliance'].retention.supplierPolicy = facts.retentionSupplierPolicy;
  } });
  const result = await finish(f);
  assert.equal(result.ok, true); assert.equal(result.reads.compliance.providerMatches, true);
});
test('price, count, duration, extra effects, readiness or incomplete disclosure fail without any paid operation', async () => {
  const changes = [b => { b['/api/mini/payments/products'].products[0].amountFen = 991; },
    b => { b['/api/mini/payments/products'].products[0].components[0].quantity = 11; },
    b => { b['/api/mini/payments/products'].products[0].days = 30; },
    b => { b['/api/mini/payments/products'].products = []; },
    b => { b['/api/catalog'].photoEffects.push({ id: 'other', enabled: true }); },
    b => { b['/api/catalog'].miniProgramCreation.available = false; },
    b => { b['/api/capabilities'][0].ready = false; },
    b => { b['/api/public/compliance'].retention = null; },
    b => { b['/health'].salesEnabled = false; }];
  for (const mutate of changes) {
    const f = fixture({ mutate }), result = await finish(f);
    assert.equal(result.ok, false); assert.equal(result.failure, 'gates_unconfirmed');
    assert.equal(result.logoutConfirmed, true); assert.equal(result.calls, 10); assert.equal(f.nativeCalls(), 1);
  }
});
test('read failure still logs out; logout failure is never reported as pass or retried', async () => {
  for (const failRoute of ['/api/mini/payments/orders', '/api/auth/logout']) {
    const f = fixture({ failRoute }), result = await finish(f);
    assert.equal(result.ok, false); assert.equal(f.nativeCalls(), 1); assert.equal(result.calls, 10);
    assert.equal(result.logoutConfirmed, failRoute !== '/api/auth/logout');
    assert.equal(result.cleanupUnconfirmed, failRoute === '/api/auth/logout');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(canary));
  }
});
test('private identity provenance requires env0 verified identity and explicitly assigned two roles', () => {
  const record = { version: 1, purpose: 'mini-env0-merchant-identities', source: 'official-devtools-env0-closed-login', env: 0,
    env0Verified: true, logoutConfirmed: true, sameAccountRefundOperatorExplicitlyAuthorized: true,
    testUserIds: [userId], refundOperatorUserIds: [userId] };
  assert.equal(merchantProbeIdentity(record), userId);
  for (const change of [{ env: 1 }, { env0Verified: false }, { logoutConfirmed: false }, { refundOperatorUserIds: [] },
    { sameAccountRefundOperatorExplicitlyAuthorized: false }, { source: 'old-sandbox' }]) {
    assert.throws(() => merchantProbeIdentity({ ...record, ...change }), /MERCHANT_PROBE_IDENTITY_UNCONFIRMED/);
  }
});
test('output projection drops private/unknown payloads and default command is an inert plan', () => {
  const safe = safeMerchantReadonlyReport({ merchantReadProbeVersion: 1, privateUserId: userId, token: canary,
    failure: canary, reads: { products: { count: 1, raw: canary, product: { secret: canary } }, secret: canary } });
  assert.doesNotMatch(JSON.stringify(safe), new RegExp(canary + '|' + userId));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/probe-mini-merchant-readonly.mjs', import.meta.url))],
    { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), merchantReadonlyPlan);
  assert.equal(merchantReadonlyPlan.privateFilesRead, false); assert.equal(merchantReadonlyPlan.cloudOperationPerformed, false);
});

const threeCatalog = values => {
  values['/api/catalog'].photoEffects = [
    { id: 'natural-avatar', title: '自然 AI 头像', enabled: true },
    { id: 'modern-comic', title: '现代漫画', enabled: true },
    { id: 'gentle-watercolor', title: '温柔水彩', enabled: true },
  ];
  values['/api/catalog'].miniProgramCreation.photoEffectIds = ['natural-avatar', 'modern-comic', 'gentle-watercolor'];
};
test('fixed three-effects profile performs only the existing ten auth/read/logout calls and has an independent slot', async () => {
  const f = fixture({ profile: threeEffectsMerchantProfile, mutate: threeCatalog });
  assert.equal(f.legacyPoll().started, false);
  const result = safeMerchantReadonlyReport(await finish(f));
  assert.equal(result.ok, true); assert.equal(result.profile, threeEffectsMerchantProfile);
  assert.equal(result.reads.catalog.count, 3); assert.equal(result.reads.catalog.exactEffect, true);
  assert.equal(result.reads.catalog.declaredEffect, true); assert.equal(result.reads.catalog.available, true);
  assert.equal(result.calls, 10); assert.equal(f.nativeCalls(), 1); assert.equal(result.logoutConfirmed, true);
  assert.deepEqual([result.paymentCalled, result.uploadCalled, result.generationCalled, result.consentWriteCalled], [false, false, false, false]);
  assert.deepEqual(f.calls.filter(call => call.method !== 'GET').map(call => call.path.split('?')[0]), ['/api/auth/wechat', '/api/auth/logout']);
  assert.equal(f.start().alreadyStarted, true);
  assert.equal(f.poll(config.nonce, 'three-effects-v1-20261015').ok, true);
  // The legacy slot is still untouched by this profile, even after completion.
  assert.equal(f.legacyPoll().started, false);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(canary + '|' + userId));
});

test('three-effects catalog rejects duplicate, unknown, missing, disabled and unavailable IDs and declarations', async () => {
  const changes = [
    c => { c.photoEffects[2] = { ...c.photoEffects[1] }; },
    c => { c.photoEffects[2].id = 'unknown-effect'; },
    c => { c.photoEffects.pop(); },
    c => { c.photoEffects.push({ id: 'classic-black-white', enabled: true }); },
    c => { c.photoEffects[1].enabled = false; },
    c => { c.photoEffects[1].available = false; },
    c => { c.photoEffects[1].included = false; },
    c => { c.miniProgramCreation.photoEffectIds[2] = 'modern-comic'; },
    c => { c.miniProgramCreation.photoEffectIds[2] = 'unknown-effect'; },
    c => { c.miniProgramCreation.available = false; },
    c => { c.settings.generationEnabled = false; },
  ];
  for (const change of changes) {
    const f = fixture({ profile: threeEffectsMerchantProfile, mutate: b => { threeCatalog(b); change(b['/api/catalog']); } });
    const result = await finish(f);
    assert.equal(result.ok, false); assert.equal(result.failure, 'gates_unconfirmed');
    assert.equal(result.logoutConfirmed, true); assert.equal(result.calls, 10);
    assert.equal(result.consentWriteCalled, false);
  }
});

test('profiles cannot silently accept one another catalog or caller-defined effect lists', async () => {
  for (const options of [{ profile: threeEffectsMerchantProfile }, { mutate: threeCatalog }]) {
    const result = await finish(fixture(options));
    assert.equal(result.ok, false); assert.equal(result.reads.catalog.exactEffect, false);
    assert.equal(result.logoutConfirmed, true);
  }
  const f = fixture();
  assert.throws(() => f.start('arbitrary-profile'), /MERCHANT_PROBE_PROFILE_INVALID/);
  assert.throws(() => f.poll(config.nonce, 'arbitrary-profile'), /MERCHANT_PROBE_PROFILE_INVALID/);
  assert.equal(f.calls.length, 0); assert.equal(f.nativeCalls(), 0);
});

test('three-effects CLI is inert and wrong route/profile fails before opening any private input', async () => {
  const command = fileURLToPath(new URL('../scripts/probe-mini-three-effects-merchant-readonly.mjs', import.meta.url));
  for (const args of [[], ['--plan']]) {
    const result = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), threeEffectsMerchantReadonlyPlan);
    assert.equal(result.stderr, ''); assert.doesNotMatch(result.stdout, new RegExp(canary));
  }
  assert.equal(threeEffectsMerchantReadonlyPlan.privateFilesRead, false);
  assert.equal(threeEffectsMerchantReadonlyPlan.cloudOperationPerformed, false);
  assert.equal(threeEffectsMerchantReadonlyPlan.requiredRouteFilename, threeEffectsMerchantRouteFilename);
  await assert.rejects(runThreeEffectsMerchantReadonlyProbe({ routeFile: 'definitely-not-present-old-route.json' }), /MERCHANT_PROBE_NEW_ROUTE_REQUIRED/);
  await assert.rejects(runMerchantReadonlyProbe({ profile: 'unknown-profile' }), /MERCHANT_PROBE_PROFILE_INVALID/);
  const rejected = spawnSync(process.execPath, [command, '--run', 'old-route.json', 'missing-identity', 'missing-output', '.'], { encoding: 'utf8', windowsHide: true });
  assert.equal(rejected.status, 1); assert.equal(rejected.stdout, ''); assert.match(rejected.stderr, /^MERCHANT_PROBE_NEW_ROUTE_REQUIRED\s*$/);
});

const fallbackFacts = fallbackPublicFacts();
const fallbackBodies = values => {
  threeCatalog(values);
  Object.assign(values['/api/public/compliance'], fallbackFacts);
  values['/api/public/compliance'].retention.supplierPolicy = fallbackFacts.retentionSupplierPolicy;
  // Ensure mutations below never alter the trusted expected facts.
  values['/api/public/compliance'].aiServices = structuredClone(fallbackFacts.aiServices);
};
test('fallback serialized profile has an independent slot, exact published facts and ten calls only', async () => {
  const f = fixture({ profile: fallbackMerchantProfile, mutate: fallbackBodies, expectedPublicFacts: fallbackFacts });
  const report = safeMerchantReadonlyReport(await finish(f));
  assert.equal(report.profile, fallbackMerchantProfile); assert.equal(report.ok, true); assert.equal(report.calls, 10);
  assert.equal(report.reads.compliance.factsExactlyMatch, true); assert.equal(report.logoutConfirmed, true);
  assert.equal(f.legacyPoll().started, false); assert.equal(f.poll(config.nonce, threeEffectsMerchantProfile).started, false);
  assert.equal(f.start().alreadyStarted, true); assert.equal(f.calls.length, 10);
  assert.deepEqual([report.paymentCalled, report.uploadCalled, report.generationCalled, report.consentWriteCalled], [false, false, false, false]);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(canary + '|' + userId + '|purpose|supplierPolicy|example.invalid'));
});
test('fallback rejects stale or merely nonempty disclosures, duplicate IDs and changed commercial contract with logout', async () => {
  for (const change of [
    b => { b['/api/public/compliance'].aiServices[0].purpose = '只允许自然 AI 头像'; },
    b => { b['/api/public/compliance'].privacyPolicyUrl += '?other=1'; },
    b => { b['/api/public/compliance'].supportContact = 'other@example.invalid'; },
    b => { b['/api/public/compliance'].retention.supplierPolicy += ' '; },
    b => { b['/api/public/compliance'].aiServices[0].region += ' '; },
    b => { b['/api/public/compliance'].aiServices[0].filingReference += ' '; },
    b => { b['/api/public/compliance'].aiServices[0].capabilities.push('video'); },
    b => { b['/api/catalog'].photoEffects[2] = { ...b['/api/catalog'].photoEffects[1] }; },
    b => { b['/api/catalog'].photoEffects[2].id = 'unknown'; },
    b => { b['/api/catalog'].photoEffects[2].available = false; },
    b => { b['/api/mini/payments/products'].products[0].amountFen = 991; },
    b => { b['/api/mini/payments/products'].products[0].components[0].quantity = 11; },
    b => { b['/api/mini/payments/products'].products[0].days = 366; },
  ]) {
    const f = fixture({ profile: fallbackMerchantProfile, expectedPublicFacts: fallbackFacts,
      mutate: b => { fallbackBodies(b); change(b); } });
    const report = await finish(f);
    assert.equal(report.ok, false); assert.equal(report.logoutConfirmed, true); assert.equal(report.calls, 10);
    assert.equal(report.failure, 'gates_unconfirmed');
  }
  const missing = await finish(fixture({ profile: fallbackMerchantProfile, mutate: fallbackBodies }));
  assert.equal(missing.ok, false); assert.equal(missing.reads.compliance.factsExactlyMatch, false);
});
test('fallback default and plan are inert; old route is rejected before private input or official runtime', async () => {
  const command = fileURLToPath(new URL('../scripts/probe-mini-disclosure-fallback-readonly.mjs', import.meta.url));
  for (const args of [[], ['--plan']]) {
    const result = spawnSync(process.execPath, [command, ...args], { encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr); assert.deepEqual(JSON.parse(result.stdout), fallbackMerchantReadonlyPlan);
    assert.equal(result.stderr, '');
  }
  await assert.rejects(runFallbackMerchantReadonlyProbe({ routeFile: '.env.mini-merchant-three-effects-probe-20261015.json' }), /MERCHANT_PROBE_NEW_ROUTE_REQUIRED/);
});
test('default allowlisted profile reuses ten read contracts with no gray and requires disconnected original mine page', async () => {
  const options = { profile: default018MerchantProfile, page: 'pages/mine/index', expectedPublicFacts: fallbackFacts, mutate: fallbackBodies };
  const f = fixture(options), report = safeMerchantReadonlyReport(await finish(f));
  assert.equal(report.ok, true); assert.equal(report.profile, default018MerchantProfile); assert.equal(report.calls, 10);
  assert.equal(report.reads.compliance.factsExactlyMatch, true); assert.equal(report.logoutConfirmed, true);
  assert.equal(f.legacyPoll().started, false); assert.equal(f.poll(config.nonce, threeEffectsMerchantProfile).started, false);
  assert.equal(f.poll(config.nonce, fallbackMerchantProfile).started, false);
  assert.equal(f.calls.every(call => !call.path.includes('?') && !call.path.includes(config.gray.value)), true);
  for (const extra of [{ page: 'pages/refund-ops/index' }, { connected: true }, { pageClient: {} }]) {
    const stopped = fixture({ ...options, ...extra });
    assert.equal((await finish(stopped)).ok, false); assert.equal(stopped.calls.length, 0); assert.equal(stopped.nativeCalls(), 0);
  }
});
