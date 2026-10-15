import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startClosedClientProbe, pollClosedClientProbe, safeProbeReport, validateProbeConfig,
  parseToolEnvelope, officialCommand, runProbe, pollProbe, probeConfigFromRelease, prepareProbe } from '../scripts/probe-mini-closed-client.mjs';

const payment = createRequire(import.meta.url)('../../miniprogram/payments.js');
const config = () => ({ version: 1, target: { appId: 'REDACTED_APP_IDENTIFIER', envId: 'leyanxiu-prod-d5gimob8af6a6e5c9', serviceName: 'buildtest' },
  gray: { key: 'synthetic_gray', value: 'synthetic_not_a_real_route_123' }, nonce: 'synthetic_probe_nonce' });
const health = () => ({ ok: true, service: 'mini-photo-production', env: 0, mode: 'closed', ledgerOnlySandbox: false,
  accepting: true, payment: { prepared: true, operationsReady: true }, photo: { prepared: true, generationEnabled: false, available: false },
  productionPaymentsEnabled: false, salesEnabled: false, generationAvailable: false });
function runtime({ noModule = false, invalidHealth = false, platform = 'devtools', rejectRead = false, loseLogout = false, hostileModule = false } = {}) {
  const calls = [], fixtures = {
    '/api/catalog': { settings: { generationEnabled: false }, photoEffects: [], miniProgramCreation: { available: false, jobProtocol: 'photo-jobs-v1', uploadProtocol: 'photo-uploads-v1' } },
    '/api/public/compliance': { status: 'approved', privacyPolicyUrl: 'https://private.invalid/privacy', userAgreementUrl: 'https://private.invalid/terms', thirdPartyListUrl: 'https://private.invalid/third', supportContact: 'private@example.invalid', consentVersions: { basic: 'v1', faceProcessing: 'v1' } },
    '/api/capabilities': [{ id: 'private', ready: false }],
    '/api/mini/payments/products': { available: false, mode: 'closed', ledgerOnlySandbox: false, products: [], purchaseProfile: 'android-only-v1', supportedPlatforms: ['android'] },
    '/api/mini/payments/entitlements': { available: { photo: 0, video: 0 } },
    '/api/works': [{ assetId: 'private-asset', url: 'https://private.invalid/object' }],
    '/api/mini/payments/orders': [{ id: 'private-order', status: 'pending' }],
    '/api/mini/payments/refunds': [{ id: 'private-refund' }],
  };
  let nativeLogins = 0;
  const c = config(), app = { globalData: { creationEnabled: false, apiTransport: { mode: 'cloud', env: c.target.envId, service: c.target.serviceName } } };
  const context = vm.createContext({ setTimeout, clearTimeout, getApp: () => app,
    wx: { getAccountInfoSync: () => ({ miniProgram: { appId: c.target.appId } }), getDeviceInfo: () => ({ platform }),
      login: options => { nativeLogins++; options.success({ code: 'private-code' }); },
      cloud: { callContainer: async options => {
        calls.push(options); const route = options.path.split('?')[0];
        assert.equal(options.config.env, c.target.envId); assert.equal(options.header['X-WX-SERVICE'], c.target.serviceName);
        assert.equal(new URLSearchParams(options.path.split('?')[1]).get(c.gray.key), c.gray.value);
        if (route === '/health') return { statusCode: 200, data: { ...health(), ...(invalidHealth ? { env: 1 } : {}) } };
        if (route === '/api/auth/wechat') return { statusCode: 200, data: { code: 0, data: { token: 'private-token', user: { id: 'private-user' } } } };
        if (route === '/api/auth/logout') { if (loseLogout) throw new Error('private-token private-url'); return { statusCode: 200, data: { code: 0, data: { loggedOut: true } } }; }
        if (rejectRead && route === '/api/works') return { statusCode: 401, data: { code: 'AUTH_EXPIRED', message: 'private-user' } };
        assert.ok(Object.hasOwn(fixtures, route), 'only known list reads');
        return { statusCode: 200, data: { code: 0, data: structuredClone(fixtures[route]) } };
      } },
    },
    ...(noModule ? {} : { require: name => { assert.equal(name, 'payments.js');
      if (!hostileModule) return payment;
      return { createPaymentClient: (wxApi, endpoint) => {
        const actual = payment.createPaymentClient(wxApi, endpoint);
        return { ...actual, request: route => actual.request(route === '/api/works' ? '/api/mini/photo-jobs' : route, route === '/api/works' ? { method: 'POST', data: {} } : undefined) };
      } };
    } }),
  });
  const start = value => vm.runInContext('(' + startClosedClientProbe.toString() + ')', context)(value);
  const poll = () => JSON.parse(JSON.stringify(vm.runInContext('(' + pollClosedClientProbe.toString() + ')', context)(c.nonce)));
  return { c, calls, start, poll, nativeLogins: () => nativeLogins };
}
async function complete(r) {
  const started = r.start(r.c); assert.equal(started.started, true); assert.equal(started.pending, true);
  for (let i = 0; i < 50; i++) { const state = r.poll(); if (!state.pending) return state; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('synthetic probe never completed');
}

test('actual project payment client uses the exact gray route for health/login/all lists/logout, with no state leakage', async () => {
  const r = runtime(), report = await complete(r);
  assert.equal(report.ok, true); assert.equal(report.moduleClientUsed, true); assert.equal(report.directContractUsed, false);
  assert.equal(r.nativeLogins(), 1); assert.equal(r.calls.length, 11);
  assert.deepEqual(r.calls.filter(x => x.method === 'POST').map(x => x.path.split('?')[0]), ['/api/auth/wechat', '/api/auth/logout']);
  assert.equal(report.reads.works.count, 1); assert.equal(report.reads.orders.count, 1);
  const safe = JSON.stringify(safeProbeReport(report));
  for (const forbidden of ['private-', 'private.invalid', 'synthetic_not_a_real_route', 'private@example']) assert.equal(safe.includes(forbidden), false);
  assert.equal(r.start(r.c).alreadyStarted, true); assert.equal(r.calls.length, 11);
});
test('missing runtime require uses official wx login and the existing HTTP contract, never a SDK mock', async () => {
  const r = runtime({ noModule: true }), report = await complete(r);
  assert.equal(report.ok, true); assert.equal(report.directContractUsed, true); assert.equal(report.moduleClientUsed, false);
});
test('wrong runtime or env1/open health cannot reach login or business requests', async () => {
  for (const options of [{ platform: 'android' }, { invalidHealth: true }]) {
    const r = runtime(options), report = await complete(r);
    assert.equal(report.ok, false); assert.equal(report.loginAttempted, false); assert.equal(r.nativeLogins(), 0); assert.ok(r.calls.length <= 1);
  }
});
test('401 does not create another session; original session is logged out and read failure is not hidden', async () => {
  const r = runtime({ rejectRead: true }), report = await complete(r);
  assert.equal(report.ok, false); assert.equal(r.nativeLogins(), 1); assert.equal(report.logoutConfirmed, true);
  assert.equal(r.calls.filter(x => x.path.startsWith('/api/auth/wechat?')).length, 1);
  assert.equal(report.forbiddenRequestBlocked, true);
});
test('a changed client cannot submit images, consent or orders through the scoped facade', async () => {
  const r = runtime({ hostileModule: true }), report = await complete(r);
  assert.equal(report.ok, false); assert.equal(report.forbiddenRequestBlocked, true); assert.equal(report.logoutConfirmed, true);
  assert.equal(r.calls.some(x => x.path.startsWith('/api/mini/photo-jobs')), false);
});
test('uncertain logout stays explicitly uncertain without exposing raw transport errors', async () => {
  const r = runtime({ loseLogout: true }), report = await complete(r);
  assert.equal(report.ok, false); assert.equal(report.cleanupUnconfirmed, true); assert.equal(report.logoutConfirmed, false);
  assert.equal(JSON.stringify(report).includes('private'), false);
});
test('CLI envelope is strict and emits only allowlisted summaries', () => {
  const payload = { ok: true, tool: 'automation_evaluate', clientName: 'codex-leyanxiu', result: { success: true, result: { result: { probeVersion: 1, started: true, privateToken: 'no-leak', reads: { works: { status: 200, count: 1, url: 'no-leak' } } } } } };
  const safe = parseToolEnvelope('[wechatide] skill-call\n' + JSON.stringify(payload), 'automation_evaluate');
  assert.equal(JSON.stringify(safe).includes('no-leak'), false);
  assert.throws(() => parseToolEnvelope(JSON.stringify({ ...payload, ok: false }), 'automation_evaluate'), /PROBE_TOOL_UNCONFIRMED/);
  assert.throws(() => parseToolEnvelope('secret invalid', 'automation_evaluate'), /PROBE_TOOL_RESULT_INVALID/);
});
test('route config rejects target drift and shell-shaped parameters; official command passes arguments without shell', () => {
  const { nonce, ...value } = config(); assert.deepEqual(validateProbeConfig(value), value);
  for (const input of [{ ...value, target: { ...value.target, appId: 'wrong' } }, { ...value, gray: { key: 'q', value: '$(private)&bad' } }]) assert.throws(() => validateProbeConfig(input), /PROBE_CONFIG_INVALID/);
  const command = officialCommand('automation_evaluate', ['--fn-source', 'function(){ return "a&b"; }', '--args-file', 'D:/private args.json']);
  assert.equal(command.options.shell, undefined); assert.ok(command.args.includes('function(){ return "a&b"; }'));
  assert.ok(command.executable.endsWith('微信开发者工具.exe'));
});

function privateFixture(t) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const directory = fs.mkdtempSync(path.join(root, '.env.closed-client-probe-test-'));
  t.after(() => {
    assert.equal(path.dirname(directory), root); assert.ok(path.basename(directory).startsWith('.env.closed-client-probe-test-'));
    fs.rmSync(directory, { recursive: true });
  });
  const filename = path.join(directory, 'route.json');
  const { nonce, ...value } = config(); fs.writeFileSync(filename, JSON.stringify(value), { mode: 0o600 });
  return { filename, directory };
}
test('one-shot private run uses args files, deletes them, and cannot silently repeat a completed login', async t => {
  const fixture = privateFixture(t), calls = []; let nonce;
  const result = await runProbe(fixture.filename, { wait: async () => {}, call: async (tool, flags) => {
    calls.push(tool);
    if (tool === 'check_wechatide_status') return { versionAcceptable: true, loggedIn: true, tokenRequired: false };
    const argsFile = flags[flags.indexOf('--args-file') + 1], args = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
    if (flags[flags.indexOf('--fn-source') + 1].startsWith('function startClosedClientProbe')) {
      nonce = args[0].nonce; assert.equal(args[0].gray.value, config().gray.value);
      return { probeVersion: 1, started: true, pending: true };
    }
    assert.equal(args[0], nonce);
    return { probeVersion: 1, started: true, pending: false, completed: true, ok: true, logoutConfirmed: true };
  } });
  assert.equal(result.ok, true); assert.equal(calls.length, 3);
  assert.deepEqual(fs.readdirSync(fixture.directory).sort(), ['route.json', 'route.json.run.json']);
  assert.equal(fs.readFileSync(fixture.filename + '.run.json', 'utf8').includes(config().gray.value), false);
  await assert.rejects(() => runProbe(fixture.filename, { call: () => assert.fail('no tool after completed run') }), /PROBE_ALREADY_ATTEMPTED/);
});
test('uncertain start retains nonce for a poll-only recovery and never invokes start or login again', async t => {
  const fixture = privateFixture(t);
  await assert.rejects(() => runProbe(fixture.filename, { call: async tool => {
    if (tool === 'check_wechatide_status') return { versionAcceptable: true, loggedIn: true, tokenRequired: false };
    throw new Error('PROBE_TOOL_UNCONFIRMED');
  } }), /PROBE_TOOL_UNCONFIRMED/);
  const first = JSON.parse(fs.readFileSync(fixture.filename + '.run.json', 'utf8'));
  const recovered = await pollProbe(fixture.filename, { call: async (tool, flags) => {
    assert.equal(tool, 'automation_evaluate');
    assert.ok(flags[flags.indexOf('--fn-source') + 1].startsWith('function pollClosedClientProbe'));
    assert.deepEqual(JSON.parse(fs.readFileSync(flags[flags.indexOf('--args-file') + 1], 'utf8')), [first.nonce]);
    return { probeVersion: 1, started: true, pending: false, completed: true, ok: false, cleanupUnconfirmed: true };
  } });
  assert.equal(recovered.cleanupUnconfirmed, true);
  assert.deepEqual(fs.readdirSync(fixture.directory).sort(), ['route.json', 'route.json.run.json']);
});

function releaseFixture() {
  const record = { phase: 'submitted', taskId: 2337711, id: 'a'.repeat(24), target: { ...config().target, serverName: 'buildtest' } };
  const task = { id: 2337711, envId: config().target.envId, serverName: 'buildtest' };
  const order = { isExist: true, releaseOrderInfo: { id: 2832312, serverName: 'buildtest',
    currentVersion: { versionName: 'buildtest-013', status: 'normal' }, releaseVersion: { versionName: 'buildtest-015', status: 'normal' },
    releaseStatus: 'test', isReleasing: true, trafficType: 'URL_PARAMS', trafficTypeValues: [{ key: 'lyx_gray_probe', value: record.id }] } };
  return { record, task, order };
}
test('prepare correlates submitted refresh015 with the exact official test route and emits no route value', async () => {
  const value = releaseFixture(); let written;
  const result = await prepareProbe('private-config', { ...value, exists: () => false, write: async (_file, config) => { written = config; } });
  assert.equal(result.prepared, true); assert.equal(result.invokedRuntime, false);
  assert.equal(written.gray.value, value.record.id); assert.equal(JSON.stringify(result).includes(value.record.id), false);
  await assert.rejects(() => prepareProbe('private-config', { ...value, exists: () => true, write: () => assert.fail('must not overwrite') }), /PROBE_CONFIG_ALREADY_EXISTS/);
});
test('prepare rejects stale journals, release drift, changed/multiple/absent route values and wrong service before writes', () => {
  const changes = [v => v.record.phase = 'prepared', v => v.record.taskId++, v => v.task.id++,
    v => v.order.releaseOrderInfo.id++, v => v.order.releaseOrderInfo.currentVersion.versionName = 'buildtest-014',
    v => v.order.releaseOrderInfo.releaseVersion.versionName = 'buildtest-016', v => v.order.releaseOrderInfo.releaseVersion.status = 'building',
    v => v.order.releaseOrderInfo.releaseStatus = 'finished', v => v.order.releaseOrderInfo.isReleasing = false,
    v => v.order.releaseOrderInfo.trafficType = 'USER', v => v.order.releaseOrderInfo.trafficTypeValues = [],
    v => v.order.releaseOrderInfo.trafficTypeValues.push({ key: 'other', value: 'b'.repeat(24) }),
    v => v.order.releaseOrderInfo.trafficTypeValues[0].value = 'c'.repeat(24), v => v.task.serverName = 'leyanxiu-api',
    v => v.order.releaseOrderInfo.releaseVersion.urlParam = { key: 'lyx_gray_probe', value: 'd'.repeat(24) }];
  for (const change of changes) { const value = releaseFixture(); change(value); assert.throws(() => probeConfigFromRelease(value.record, value.order, value.task), /PROBE_(REFRESH_JOURNAL|RELEASE_ROUTE)_UNCONFIRMED/); }
});
