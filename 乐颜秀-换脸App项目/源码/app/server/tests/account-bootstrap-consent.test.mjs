import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { PGlite } from '@electric-sql/pglite';
import { Pool } from 'pg';
import { BILLING_SCHEMA } from '../payments/database.js';
import { accountSessionGuard } from '../accounts/middleware.js';

test('bootstrap consent exception is account-test-only and exact by method and path', async () => {
  for (const accountOnly of [true, false]) {
    const app = new Hono();
    app.use('*', accountSessionGuard({ accountOnly, registry: { validSession: async () => true }, getAuth: () => ({ authMethod: 'device_bootstrap' }) }));
    app.all('*', c => c.json({ reached: true }));
    for (const pathname of ['/api/consents', '/api/consents/basic/withdraw']) {
      assert.equal((await app.request(pathname, { method: 'POST' })).status, accountOnly ? 200 : 403);
    }
    for (const [method, pathname] of [
      ['PUT', '/api/consents'], ['DELETE', '/api/consents'], ['POST', '/api/consents/'],
      ['POST', '/api/consents/basic/withdraw/extra'], ['POST', '/api/consents/face_processing/withdraw'],
      ['POST', '/api/consents/marketing/withdraw'], ['POST', '/api/upload'], ['DELETE', '/api/account'],
    ]) assert.equal((await app.request(pathname, { method })).status, 403, `${accountOnly}: ${method} ${pathname}`);
  }
});

test('real P-256 device bootstrap can grant/withdraw basic consent and reach phone login with PostgreSQL registry', async t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-bootstrap-consent-'));
  const pg = new PGlite(); await pg.exec(BILLING_SCHEMA);
  // Exercise the real server runtime/registry through the pg Pool boundary. All
  // SQL runs in this isolated PGlite instance; no listening DB or cloud is used.
  const originalQuery = Pool.prototype.query; const originalConnect = Pool.prototype.connect;
  Pool.prototype.query = function (sql, args) { return pg.query(sql, args); };
  Pool.prototype.connect = async function () { return { query: (sql, args) => pg.query(sql, args), release() {} }; };
  const originalFetch = globalThis.fetch; let externalRequests = 0;
  globalThis.fetch = async () => { externalRequests++; throw new Error('External network forbidden in account fixture'); };
  t.after(async () => {
    Pool.prototype.query = originalQuery; Pool.prototype.connect = originalConnect; globalThis.fetch = originalFetch;
    await pg.close(); fs.rmSync(temporary, { recursive: true, force: true });
  });
  Object.assign(process.env, {
    DOTENV_CONFIG_PATH: path.join(temporary, 'does-not-exist.env'), START_SERVER: 'false', NODE_ENV: 'test', DEPLOY_ENV: 'test',
    APP_ACCOUNT_ONLY: 'true', APP_ACCOUNT_OPERATIONS_ENABLED: 'false', APP_LOGIN_ENABLED: 'true',
    BILLING_BACKEND: 'postgres', BILLING_DATABASE_URL: 'postgres://isolated:isolated@127.0.0.1:1/test', XPAY_MODE: 'disabled',
    PROVIDER: 'mock', ALLOW_MOCK_PROVIDER: 'true', AUTH_MODE: 'device_key', RELEASE_CHANNEL: 'android-app',
    ACCOUNT_OTP_SECRET: 'isolated-otp-secret-not-a-real-credential', SMS_PROVIDER: 'unset',
    PAYMENT_MODE: 'closed_test', CLOSED_TEST_MODE: 'true', CLOSED_TEST_CREDITS: '0', CLOSED_TEST_REQUIRE_INVITE: 'true',
    CLOSED_TEST_INVITE_SECRET: 'isolated-bootstrap-invite', AUTH_SESSION_SECRET: 'isolated-session-secret-not-a-real-credential',
    OBJECT_SIGNING_SECRET: 'isolated-object-secret-not-a-real-credential', BASIC_CONSENT_VERSION: '2026-10-09-account',
    TASKS_BACKEND: 'file', TASKS_FILE: path.join(temporary, 'tasks.json'), DATA_DIR: temporary,
    COMPLIANCE_BACKEND: 'file', COMPLIANCE_STORE_FILE: path.join(temporary, 'compliance.json'),
    OBJECT_STORAGE_BACKEND: 'file', PRIVATE_OBJECT_DIR: path.join(temporary, 'objects'), OBJECT_INDEX_FILE: path.join(temporary, 'objects', 'index.json'),
    ADMIN_DATA_DIR: temporary, ADMIN_STORE_FILE: path.join(temporary, 'admin.json'),
    ADMIN_WORKFLOW_DATA_DIR: temporary, ADMIN_WORKFLOW_STORE_FILE: path.join(temporary, 'workflows.json'),
    ADMIN_SNAPSHOT_BACKEND: 'local', METRICS_BACKEND: 'memory', SECURITY_LOG_PATH: path.join(temporary, 'security.jsonl'),
    METRICS_LOG_PATH: path.join(temporary, 'metrics.jsonl'), REPAIR_WORK_DIR: path.join(temporary, 'repair'),
    FFMPEG_PATH: path.join(temporary, 'execution-forbidden-ffmpeg'),
  });
  const { app } = await import('../index.js');
  const { accountRegistry, billingDatabase } = await import('../payments/runtime.js');
  const { store } = await import('../compliance-store.js');
  const { getAuth, requireAuth, createSessionForUser } = await import('../auth.js');
  const { createPaymentAccounts } = await import('../payments/accounts.js');
  const { registerAppAccountRoutes } = await import('../accounts/routes.js');
  const { accountOnlyMiddleware } = await import('../accounts/account-only.js');
  const keys = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const publicKeySpki = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64url');
  const headers = { 'Content-Type': 'application/json', 'X-Closed-Test-Invite': process.env.CLOSED_TEST_INVITE_SECRET };
  const request = (route, body, method = 'POST') => app.request(route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const challengeResponse = await request('/api/auth/device/challenge', { algorithm: 'ES256', publicKeySpki });
  assert.equal(challengeResponse.status, 200);
  const challenge = (await challengeResponse.json()).data;
  const signature = crypto.sign('sha256', Buffer.from(challenge.challenge), keys.privateKey).toString('base64url');
  const deviceResponse = await request('/api/auth/device/verify', { ...challenge, algorithm: 'ES256', publicKeySpki, signature });
  assert.equal(deviceResponse.status, 200);
  const device = (await deviceResponse.json()).data;
  headers.Authorization = `Bearer ${device.token}`;
  const me = await (await request('/api/auth/me', undefined, 'GET')).json();
  assert.equal(me.data.authMethod, 'device_bootstrap');
  const consent = { consentType: 'basic', action: 'granted', version: '2026-10-09-account' };
  assert.equal((await request('/api/consents', consent)).status, 200);
  assert.equal(store.listConsents(device.user.id).length, 1);
  for (const consentType of ['face_processing', 'marketing', 'content_rights']) {
    const response = await request('/api/consents', { ...consent, consentType, subjectAuthorization: 'self' });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, 'APP_ACCOUNT_ONLY');
  }
  const withdrawal = await request('/api/consents/basic/withdraw', {});
  assert.equal(withdrawal.status, 200);
  assert.equal((await withdrawal.json()).data.deletionScheduled, false);
  assert.equal((await request('/api/consents', consent)).status, 200);
  assert.equal(store.listConsents(device.user.id).length, 3, 'only basic grant, withdrawal, re-grant are persisted');
  assert.equal((await request('/api/consents/face_processing/withdraw', {})).status, 403);
  assert.equal((await request('/api/upload', {})).status, 403);
  assert.equal(externalRequests, 0);

  // Continue with the production phone routes and registry, replacing only the
  // external SMS delivery boundary with an in-memory stub. Same signed token.
  const sent = [];
  const otp = createPaymentAccounts(billingDatabase, { secret: process.env.ACCOUNT_OTP_SECRET,
    sendSms: async (phone, code) => sent.push({ phone, code }), resolveLogin: (...args) => accountRegistry.phoneLogin(...args) });
  const phoneApp = new Hono();
  phoneApp.use('*', accountOnlyMiddleware({ enabled: true }));
  phoneApp.use('*', accountSessionGuard({ registry: accountRegistry, getAuth, accountOnly: true }));
  registerAppAccountRoutes(phoneApp, { registry: accountRegistry, otp, authenticated: requireAuth,
    sessionForUser: createSessionForUser, flush: async () => {}, users: store, clientAddress: () => '127.0.0.1',
    smsReady: () => true, wechatReady: () => false, rateLimit: () => true,
    appId: () => '', wechatExchange: async () => { throw new Error('must not call WeChat'); } });
  const phoneRequest = (route, body) => phoneApp.request(route, { method: 'POST', headers, body: JSON.stringify(body) });
  const sms = await phoneRequest('/api/account/login/phone/challenge', { phone: '13800000191', termsVersion: 'account-v1' });
  assert.equal(sms.status, 200);
  const smsChallenge = (await sms.json()).data;
  assert.equal(sent.length, 1);
  const login = await phoneRequest('/api/account/login/phone/verify', { ...smsChallenge, code: sent[0].code, termsVersion: 'account-v1' });
  assert.equal(login.status, 200);
  const account = (await login.json()).data;
  assert.notEqual(account.user.id, device.user.id);
  assert.equal((await accountRegistry.status(account.user.id)).loggedIn, true);
  assert.equal(externalRequests, 0);
});
