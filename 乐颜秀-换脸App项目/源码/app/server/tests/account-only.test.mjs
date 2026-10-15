import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { accountOnlyMiddleware, accountOnlyRequestAllowed } from '../accounts/account-only.js';
import { registerAppAccountRoutes } from '../accounts/routes.js';

const blockedRoutes = [
  ['POST', '/api/upload'], ['POST', '/api/upload/video'],
  ['POST', '/api/fusion'], ['GET', '/api/fusion/old-task'],
  ['POST', '/api/photo/restore'], ['POST', '/api/photo/fusion'], ['POST', '/api/photo/idphoto'],
  ['POST', '/api/photo/age'], ['POST', '/api/photo/anime'], ['POST', '/api/photo/photobg'], ['POST', '/api/photo/effect'],
  ['POST', '/api/llm/chat'], ['POST', '/api/play/analyze'],
  ['POST', '/api/video/matting'], ['GET', '/api/video/matting/old-task'],
  ['GET', '/api/works'], ['GET', '/api/objects/private'], ['GET', '/api/assets/private/url'], ['DELETE', '/api/assets/private'],
  ['POST', '/api/orders'], ['GET', '/api/orders'], ['POST', '/api/payments/webhook/wechat'],
  ['POST', '/api/payments/wechat/notify'], ['POST', '/api/account/restore-purchases'],
  ['POST', '/api/admin/media'], ['GET', '/api/admin/media'], ['POST', '/api/admin/session'],
  ['PUT', '/api/admin/catalog/draft'], ['POST', '/api/admin/catalog/publish'],
  ['POST', '/api/admin/workflows'], ['PATCH', '/api/admin/workflows/example'],
  ['POST', '/api/internal/retention/sweep'], ['POST', '/api/reports'], ['POST', '/api/moderation/check'],
  ['POST', '/api/auth/wechat'], ['POST', '/api/auth/session'],
  ['POST', '/api/account/login/wechat/start'], ['POST', '/api/account/login/wechat/verify'],
  ['POST', '/api/account/phone/challenge'], ['POST', '/api/account/phone/verify'],
  ['POST', '/api/consents/face_processing/withdraw'],
  ['GET', '/admin'], ['POST', '/api/catalog'], ['GET', '/api/new-future-endpoint'],
];

test('account test allowlist is exact by method and rejects encoded or future paths', () => {
  for (const [method, url] of blockedRoutes) assert.equal(accountOnlyRequestAllowed(method, url), false, `${method} ${url}`);
  for (const url of ['/health', '/api/catalog', '/templates/classic-song-openai-r2.webp', '/assets/index-a.js', '/app/legal/terms.html', '/app/legal/privacy.html']) {
    assert.equal(accountOnlyRequestAllowed('GET', url), true, url);
    assert.equal(accountOnlyRequestAllowed('HEAD', url), true, url);
  }
  for (const url of ['/api/account/login/phone/verify/extra', '/api/account/login/phone/%76erify', '/assets/../private.png', '/assets/a%2fb.js', '/assets/a.json', '/api/catalog/']) {
    assert.equal(accountOnlyRequestAllowed('GET', url), false, url);
    assert.equal(accountOnlyRequestAllowed('POST', url), false, url);
  }
});

test('middleware rejects before the next handler and checks preflight target methods; normal mode passes through', async () => {
  const app = new Hono(); let executions = 0;
  app.use('*', accountOnlyMiddleware({ enabled: true }));
  app.all('*', c => { executions++; return c.json({ ok: true }); });
  assert.equal((await app.request('/api/upload', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } })).status, 403);
  assert.equal(executions, 0);
  assert.equal((await app.request('/api/account/login/phone/challenge', { method: 'OPTIONS', headers: { 'Access-Control-Request-Method': 'POST' } })).status, 200);
  assert.equal(executions, 1);
  const normal = new Hono(); normal.use('*', accountOnlyMiddleware({ enabled: false }));
  normal.post('/api/upload', c => c.json({ originalRoute: true }));
  assert.deepEqual(await (await normal.request('/api/upload', { method: 'POST' })).json(), { originalRoute: true });
});

test('phone login and logout handlers remain reachable behind the gate with no WeChat exchange', async () => {
  const app = new Hono(); const calls = [];
  app.use('*', accountOnlyMiddleware({ enabled: true }));
  registerAppAccountRoutes(app, {
    registry: { status: async () => ({ loggedIn: true }), logout: async () => calls.push('logout') },
    otp: { challenge: async () => { calls.push('sms-stub'); return { challengeId: 'challenge' }; }, verify: async () => ({ userId: 'u', deviceId: 'd', deviceVersion: 1 }) },
    authenticated: () => ({ auth: { userId: 'u', deviceId: 'd' } }),
    sessionForUser: () => ({ token: 'test-token' }), flush: async () => calls.push('flush'),
    users: { revokeUserSessions: () => calls.push('revoke') }, clientAddress: () => '127.0.0.1',
    smsReady: () => true, wechatReady: () => true, appId: () => 'test-only', rateLimit: () => true,
    wechatExchange: async () => { calls.push('wechat'); throw new Error('must not run'); },
  });
  const body = { phone: '13800000101', termsVersion: 'account-v1', challengeId: 'challenge', code: '123456' };
  for (const route of ['/api/account/login/phone/challenge', '/api/account/login/phone/verify', '/api/account/login/logout']) {
    assert.equal((await app.request(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status, 200, route);
  }
  assert.equal((await app.request('/api/account/login-status')).status, 200);
  assert.equal((await app.request('/api/account/login/wechat/verify', { method: 'POST', body: '{}' })).status, 403);
  assert.deepEqual(calls, ['sms-stub', 'flush', 'logout', 'revoke', 'flush']);
});

test('real server blocks media/payment/admin before body parsing, storage, audit, metrics or provider effects', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-account-only-'));
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: path.join(temporary, 'does-not-exist.env'), START_SERVER: 'false', NODE_ENV: 'test', DEPLOY_ENV: 'test',
    APP_ACCOUNT_ONLY: 'true', APP_LOGIN_ENABLED: 'false', BILLING_BACKEND: 'legacy', XPAY_MODE: 'disabled',
    PROVIDER: 'mock', ALLOW_MOCK_PROVIDER: 'true', AUTH_MODE: 'device_key', RELEASE_CHANNEL: 'android-app',
    PAYMENT_MODE: 'closed_test', CLOSED_TEST_MODE: 'true', CLOSED_TEST_CREDITS: '3', CLOSED_TEST_REQUIRE_INVITE: 'true',
    CLOSED_TEST_INVITE_SECRET: 'isolated-account-only-invite', AUTH_SESSION_SECRET: 'isolated-session-secret-not-a-real-credential',
    OBJECT_SIGNING_SECRET: 'isolated-object-secret-not-a-real-credential', BASIC_CONSENT_VERSION: '2026-10-09-account',
    TASKS_BACKEND: 'file', TASKS_FILE: path.join(temporary, 'tasks.json'), DATA_DIR: temporary,
    COMPLIANCE_BACKEND: 'file', COMPLIANCE_STORE_FILE: path.join(temporary, 'compliance.json'),
    OBJECT_STORAGE_BACKEND: 'file', PRIVATE_OBJECT_DIR: path.join(temporary, 'objects'), OBJECT_INDEX_FILE: path.join(temporary, 'objects', 'index.json'),
    ADMIN_DATA_DIR: temporary, ADMIN_STORE_FILE: path.join(temporary, 'admin.json'),
    ADMIN_WORKFLOW_DATA_DIR: temporary, ADMIN_WORKFLOW_STORE_FILE: path.join(temporary, 'workflows.json'),
    ADMIN_SNAPSHOT_BACKEND: 'local', METRICS_BACKEND: 'memory', SECURITY_LOG_PATH: path.join(temporary, 'security.jsonl'),
    METRICS_LOG_PATH: path.join(temporary, 'metrics.jsonl'),
    REPAIR_WORK_DIR: path.join(temporary, 'repair'), FFMPEG_PATH: path.join(temporary, 'execution-forbidden-ffmpeg'),
  });
  let networkRequests = 0; const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { networkRequests++; throw new Error('Isolated test forbids network requests'); };
  t.after(() => { globalThis.fetch = originalFetch; fs.rmSync(temporary, { recursive: true, force: true }); });
  const [{ app }, { store }, metrics] = await Promise.all([import('../index.js'), import('../compliance-store.js'), import('../metrics.js')]);
  const key = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeySpki = key.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const headers = { 'Content-Type': 'application/json', 'X-Closed-Test-Invite': process.env.CLOSED_TEST_INVITE_SECRET };
  const challengeResponse = await app.request('/api/auth/device/challenge', { method: 'POST', headers, body: JSON.stringify({ algorithm: 'ES256', publicKeySpki }) });
  assert.equal(challengeResponse.status, 200);
  const challenge = (await challengeResponse.json()).data;
  const signature = crypto.sign('sha256', Buffer.from(challenge.challenge), key.privateKey).toString('base64url');
  const verifiedResponse = await app.request('/api/auth/device/verify', { method: 'POST', headers, body: JSON.stringify({ ...challenge, algorithm: 'ES256', publicKeySpki, signature }) });
  assert.equal(verifiedResponse.status, 200);
  const session = (await verifiedResponse.json()).data;
  headers.Authorization = `Bearer ${session.token}`;
  const entitlements = await (await app.request('/api/account/entitlements', { headers })).json();
  assert.equal(entitlements.data.totalRemaining, 3, 'nonzero credits must not bypass the gate');
  const snapshot = () => {
    const current = metrics.snapshot();
    return { store: store.snapshot(), metrics: { counters: current.counters, p95Ms: current.p95Ms, alerts: current.alerts, httpSeries: current.http.series },
      files: fs.readdirSync(temporary, { recursive: true }).filter(name => fs.statSync(path.join(temporary, name)).isFile()).sort().map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(temporary, name))).digest('hex')]) };
  };
  const before = JSON.stringify(snapshot());
  for (const [method, url] of blockedRoutes) {
    const response = await app.request(url, { method, headers: { ...headers, 'Content-Length': '999999999' }, ...(['GET', 'HEAD'].includes(method) ? {} : { body: '{invalid-json' }) });
    assert.equal(response.status, 403, `${method} ${url}`);
    assert.equal((await response.json()).code, 'APP_ACCOUNT_ONLY', url);
  }
  assert.equal(JSON.stringify(snapshot()), before, 'denied calls must not alter any persisted or in-memory state');
  assert.equal(networkRequests, 0);
  for (const url of ['/health', '/api/catalog', '/api/capabilities', '/api/features', '/api/public/compliance', '/api/auth/me']) {
    const response = await app.request(url, { headers }); assert.equal(response.status, 200, url);
    const result = await response.json();
    if (url === '/api/catalog') assert.equal(result.data.settings.generationEnabled, false);
    if (url === '/api/features' || url === '/api/capabilities') assert.ok(result.data.every(item => item.ready === false));
  }
  const granted = await app.request('/api/consents', { method: 'POST', headers, body: JSON.stringify({ consentType: 'basic', action: 'granted', version: '2026-10-09-account' }) });
  assert.equal(granted.status, 200);
  const rejected = await app.request('/api/consents', { method: 'POST', headers, body: JSON.stringify({ consentType: 'face_processing', action: 'granted', subjectAuthorization: 'self' }) });
  assert.equal(rejected.status, 403);
  assert.equal(store.listConsents(session.user.id).length, 1);
  const deleted = await app.request('/api/account', { method: 'DELETE', headers });
  assert.equal(deleted.status, 200, 'account deletion remains usable');
  assert.equal(store.getUser(session.user.id), null);
  assert.equal(store.snapshot().users.find(user => user.id === session.user.id).status, 'deleted');
  assert.equal(networkRequests, 0);
});
