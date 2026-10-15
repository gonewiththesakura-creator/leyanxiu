import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { accountLiveVerificationPlan, verifyAccountLiveFlow, safeLiveVerificationResult, buildAccountLiveVerifyCommand, runAccountLiveVerification, SAFE_PUBLIC_REQUESTS } from '../scripts/verify-app-account-live.mjs';

const time = Date.now();
const env = { CLOSED_TEST_INVITE_SECRET: 'fixture-only-invite', BASIC_CONSENT_VERSION: '2026-10-09-account' };
const userId = `usr_${crypto.randomUUID()}`;
const token = 'fixture-only-secret-session-token'.repeat(3);
const json = (data, status = 200) => Response.json(data, { status });
const operation = written => ({ enabled: true, log: { healthy: true, written, writeFailures: 0, invalidEvents: 0, droppedEvents: 0 },
  retention: { overdue: false, stopped: false, lastError: null, lastNotificationError: null,
    lastAppliedAt: time, lastReport: { mode: 'apply', checkedAt: time, invalidSessionTimes: 0 } } });

function fixture({ smsAvailable = true, failRoute, wrongGateReason = false, auditFailure = false, staleBefore = false } = {}) {
  const calls = [];
  let operations = 0;
  let loggedOut = false;
  let publicKey;
  let proof;
  let consent;
  return {
    calls,
    now: () => time,
    async readOperations() {
      const value = operation(operations++ === 0 ? 1 : 15);
      if (staleBefore && operations === 1) value.retention.lastAppliedAt = time - 600_001;
      if (auditFailure && operations > 1) value.log.writeFailures = 1;
      return value;
    },
    async fetchImpl(url, options) {
      assert.equal(new URL(url).origin, 'https://REDACTED_COMPANY_INFRASTRUCTURE');
      assert.equal(options.redirect, 'error');
      const route = new URL(url).pathname;
      const signature = `${options.method} ${route}`;
      assert.ok(SAFE_PUBLIC_REQUESTS.includes(signature));
      calls.push(signature);
      if (route === failRoute) throw new Error(`PRIVATE_FAILURE_${token}_${env.CLOSED_TEST_INVITE_SECRET}`);
      const body = options.body === undefined ? undefined : JSON.parse(options.body);
      if (route === '/health') return json({ ok: true });
      if (route === '/api/internal/account-operations') { assert.equal(options.headers['x-internal-token'], undefined); return new Response('', { status: 404 }); }
      if (route.startsWith('/app/legal/')) return new Response('<html><a href="mailto:REDACTED_COMPANY_CONTACT_EMAIL">联系</a></html>');
      if (route === '/api/auth/device/challenge') {
        assert.equal(options.headers['x-closed-test-invite'], env.CLOSED_TEST_INVITE_SECRET);
        assert.equal(body.algorithm, 'ES256');
        publicKey = crypto.createPublicKey({ key: Buffer.from(body.publicKeySpki, 'base64url'), format: 'der', type: 'spki' });
        assert.equal(publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
        proof = { challengeId: `dch_${crypto.randomUUID()}`, challenge: 'fixture-only-proof-'.repeat(3), algorithm: 'ES256' };
        return json({ code: 0, data: proof });
      }
      if (route === '/api/auth/device/verify') {
        assert.equal(options.headers['x-closed-test-invite'], env.CLOSED_TEST_INVITE_SECRET);
        assert.equal(body.challengeId, proof.challengeId);
        assert.equal(crypto.verify('sha256', Buffer.from(proof.challenge), publicKey, Buffer.from(body.signature, 'base64url')), true);
        return json({ code: 0, data: { token, user: { id: userId, authMethod: 'device_bootstrap' } } });
      }
      assert.equal(options.headers.authorization, `Bearer ${token}`);
      if (route === '/api/auth/me') return loggedOut ? json({ code: 'AUTH_REQUIRED' }, 401) : json({ code: 0, data: { authMethod: 'device_bootstrap' } });
      if (route === '/api/consents' && options.method === 'POST') {
        assert.deepEqual(body, { consentType: 'basic', action: 'granted', version: '2026-10-09-account' });
        consent = { ...body, userId, id: 'fixture-only-consent' };
        return json({ code: 0, data: consent });
      }
      if (route === '/api/consents') return json({ code: 0, data: { entries: [consent] } });
      if (route === '/api/account/login-status') return json({ code: 0, data: { userId, loginEnabled: true, loggedIn: false, bound: false, maskedPhone: null, wechatLinked: false, available: smsAvailable, wechatAvailable: false } });
      if (route === '/api/account/entitlements') return json({ code: 0, data: { totalRemaining: 0 } });
      if (route === '/api/upload' || route === '/api/orders') { assert.deepEqual(body, {}); return json({ code: wrongGateReason ? 'LOGIN_REQUIRED' : 'APP_ACCOUNT_ONLY' }, 403); }
      if (route === '/api/auth/logout') { assert.deepEqual(body, {}); loggedOut = true; return json({ code: 0, data: { loggedOut: true } }); }
      throw new Error('UNEXPECTED_REQUEST');
    },
  };
}

test('default CLI plan imports no credential reader and performs no file/network I/O', () => {
  assert.equal(accountLiveVerificationPlan().readsLocalEnv, false);
  const url = new URL('../scripts/verify-app-account-live.mjs', import.meta.url);
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs';
    fs.readFileSync=()=>{throw new Error('FILE_READ_FORBIDDEN');};
    globalThis.fetch=()=>{throw new Error('NETWORK_FORBIDDEN');};
    process.argv=[process.execPath,${JSON.stringify(fileURLToPath(url))}];
    await import(${JSON.stringify(url.href)});
  `], { encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.code, 'APP_ACCOUNT_LIVE_VERIFY_PLAN');
  assert.equal(result.readsLocalEnv, false);
  assert.equal(result.sendsRemoteCommand, false);
});

test('P256 HTTPS flow checks consent, guest balance, gates and revokes its own token; SMS availability is only a boolean', async () => {
  for (const smsAvailable of [true, false]) {
    const f = fixture({ smsAvailable });
    const result = await verifyAccountLiveFlow({ env, ...f });
    assert.equal(result.code, 'APP_ACCOUNT_LIVE_VERIFY_PASS');
    assert.equal(result.smsAvailable, smsAvailable);
    assert.equal(result.oldTokenRejected, true);
    assert.equal(result.auditAdvanced, true);
    assert.equal(f.calls.filter(call => call === 'POST /api/auth/device/challenge').length, 1);
    assert.equal(f.calls.filter(call => call === 'POST /api/auth/device/verify').length, 1);
    assert.equal(f.calls.filter(call => call === 'POST /api/auth/logout').length, 1);
    assert.ok(f.calls.every(call => SAFE_PUBLIC_REQUESTS.includes(call)));
    const output = JSON.stringify(result);
    for (const privateValue of [token, env.CLOSED_TEST_INVITE_SECRET, userId, 'fixture-only-proof']) assert.equal(output.includes(privateValue), false);
    assert.ok(Object.entries(result).every(([key, value]) => key === 'code' || typeof value === 'boolean'));
  }
});

test('failed checks still attempt logout, preserve audits, and cannot misread LOGIN_REQUIRED as account-only rejection', async () => {
  for (const options of [{ failRoute: '/api/account/login-status' }, { wrongGateReason: true }, { auditFailure: true }]) {
    const f = fixture(options);
    const result = await verifyAccountLiveFlow({ env, ...f });
    assert.equal(result.code, 'APP_ACCOUNT_LIVE_VERIFY_FAILED');
    assert.equal(result.logoutVerified, true);
    assert.equal(result.oldTokenRejected, true);
    assert.ok(f.calls.includes('POST /api/auth/logout'));
    assert.equal(JSON.stringify(result).includes('PRIVATE_FAILURE'), false);
  }
});

test('stale operations stop the flow before a guest or any public request is created', async () => {
  const f = fixture({ staleBefore: true });
  const result = await verifyAccountLiveFlow({ env, ...f });
  assert.equal(result.code, 'APP_ACCOUNT_LIVE_VERIFY_FAILED');
  assert.equal(result.recentApplyBefore, false);
  assert.deepEqual(f.calls, []);
});

test('remote command contains only allowed API paths and its embedded JS passes syntax checking without execution', () => {
  const command = buildAccountLiveVerifyCommand();
  for (const path of ['/api/account/login/phone/challenge', '/api/account/login/phone/verify', '/api/account/login/wechat', '/api/payments/', '/api/fusion']) assert.equal(command.includes(path), false);
  assert.equal(command.includes('DELETE'), false);
  assert.equal(command.includes('fs.writeFile'), false);
  assert.equal(command.includes('APP_ACCOUNT_ONLY'), true);
  assert.equal(command.includes('APP_ACCOUNT_OPERATIONS_ENABLED'), true);
  assert.equal(command.includes('APP_UPDATE_ACTIVATED '), true);
  const embedded = command.split("<<'ACCOUNT_VERIFY_JS' >&3 2>/dev/null\n")[1].split('\nACCOUNT_VERIFY_JS')[0];
  execFileSync(process.execPath, ['--input-type=module', '--check'], { input: embedded, encoding: 'utf8' });
});

test('ECS runner submits once and polls without returning raw output, IDs or provider errors', async () => {
  const f = fixture();
  const flow = await verifyAccountLiveFlow({ env, ...f });
  const result = { ...flow, newReleaseActive: true, accountOnlyEnabled: true, operationsEnabled: true, closedTestOnly: true };
  let submitted = 0, queried = 0;
  const actual = await runAccountLiveVerification({ delay: async () => {}, async requestImpl(action, params) {
    if (action === 'RunCommand') {
      submitted++;
      assert.equal(params.KeepCommand, 'false');
      assert.equal(params.Type, 'RunShellScript');
      assert.equal(params.ContentEncoding, 'Base64');
      assert.equal(Buffer.from(params.CommandContent, 'base64').toString(), buildAccountLiveVerifyCommand());
      return { InvokeId: 't-fixtureOnly' };
    }
    assert.equal(action, 'DescribeInvocationResults');
    assert.equal(params.ContentEncoding, 'PlainText');
    queried++;
    return { Invocation: { InvocationResults: { InvocationResult: [{ InstanceId: params.InstanceId,
      InvocationStatus: queried === 1 ? 'Running' : 'Success', ExitCode: 0, Output: queried === 1 ? '' : JSON.stringify(result) }] } } };
  } });
  assert.equal(submitted, 1);
  assert.equal(queried, 2);
  assert.deepEqual(actual, result);
  assert.equal(JSON.stringify(actual).includes('t-fixtureOnly'), false);
  await assert.rejects(runAccountLiveVerification({ requestImpl: async () => { throw new Error(`CREDENTIAL_${token}`); } }), /^Error: APP_ACCOUNT_LIVE_VERIFY_FAILED$/);
});

test('remote output parsing rejects extra secrets, multiple lines, inconsistent OTP comparisons and incomplete pass reports', async () => {
  const flow = await verifyAccountLiveFlow({ env, ...fixture() });
  const result = { ...flow, newReleaseActive: true, accountOnlyEnabled: true, operationsEnabled: true, closedTestOnly: true };
  assert.deepEqual(safeLiveVerificationResult(JSON.stringify(result)), result);
  assert.throws(() => safeLiveVerificationResult(JSON.stringify({ ...result, token })));
  assert.throws(() => safeLiveVerificationResult(JSON.stringify(result) + '\nPRIVATE_SECRET'));
  assert.throws(() => safeLiveVerificationResult(JSON.stringify({ ...result, otpSecretComparisonAvailable: true, otpSecretContinuityVerified: false })));
  assert.throws(() => safeLiveVerificationResult(JSON.stringify({ ...result, uploadRejected: false })));
});
