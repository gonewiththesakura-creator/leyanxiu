import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { photoCandidatePublicProfile, registerPhotoCandidatePublicRoutes } from '../photo-jobs/candidate-public.js';

const disclosed = () => ({
  env: { PRIVACY_POLICY_URL: 'https://example.com/privacy', USER_AGREEMENT_URL: 'https://example.com/terms',
    THIRD_PARTY_LIST_URL: 'https://example.com/processors', PIPIA_REFERENCE: 'internal-fixture-assessment',
    RETENTION_SUPPLIER_POLICY: '仅用于隔离测试的处理方保存和删除说明。',
    AI_SERVICE_DISCLOSURES_JSON: JSON.stringify([{ provider: 'fixture-provider', model: 'fixture-model',
      filingReference: '仅测试的公开登记编号', purpose: '仅测试的图片处理', region: '仅测试的境内地域',
      capabilities: ['photo-effect', 'video-fusion'], secret: 'internal-fixture-secret' }]) },
  policy: { provider: 'fixture-provider', model: 'fixture-model', basicVersion: 'fixture_basic', faceVersion: 'fixture_face',
    sourceRetentionMs: 12 * 3600000, resultRetentionMs: 48 * 3600000, reviewReference: 'internal-fixture-review' },
});

test('public facts are optional and only owner-confirmed contact is supplied by default', () => {
  const profile = photoCandidatePublicProfile();
  assert.equal(profile.status, 'pending_company_approval'); assert.equal(profile.supportContact, 'REDACTED_COMPANY_CONTACT_EMAIL');
  assert.equal(profile.operatorName, 'REDACTED_COMPANY_NAME'); assert.deepEqual(profile.aiServices, []);
  assert.equal(profile.retention, null); assert.equal(profile.privacyPolicyUrl, null);
  const complete = photoCandidatePublicProfile({ env: { PRIVACY_POLICY_URL: 'https://example.com/privacy',
    USER_AGREEMENT_URL: 'https://example.com/terms', THIRD_PARTY_LIST_URL: 'https://example.com/third-party',
    AI_SERVICE_DISCLOSURES_JSON: '[{"status":"approved"}]', SUPPORT_CONTACT: 'unapproved@example.com', SECRET: 'private-value' },
  policy: { approved: true, basicVersion: 'basic_v1', faceVersion: 'face_v1', reviewReference: 'private-review' } });
  assert.equal(complete.status, 'pending_company_approval'); assert.deepEqual(complete.aiServices, []);
  assert.equal(complete.privacyPolicyUrl, 'https://example.com/privacy'); assert.equal(complete.supportContact, profile.supportContact);
  assert.deepEqual(complete.consentVersions, { basic: 'basic_v1', faceProcessing: 'face_v1' });
  assert.ok(!JSON.stringify(complete).includes('private-'));
});

test('public document projection rejects private, credentialed, malformed and non-HTTPS destinations', () => {
  for (const value of ['http://example.com/p', 'https://127.0.0.1/p', 'https://localhost/p', 'https://a.internal/p',
    'https://REDACTED_USER:REDACTED_PASSWORD@example.com/p', 'https://example.com:8443/p', 'https://example.com/#part',
    'https://example.com\\@internal/p', ' https://example.com/p', 'https://example.com/p\n',
    'https://example.com/p?Signature=REDACTED_SECRET 'https://example.com/p?token=REDACTED_SECRET
    'https://EXAMPLE.com/privacy', 'https://example.com/x/../privacy', 'https://example.com:443/privacy']) {
    assert.equal(photoCandidatePublicProfile({ env: { PRIVACY_POLICY_URL: value } }).privacyPolicyUrl, null, value);
  }
});

test('complete existing disclosures project only the current photo model and actual policy retention', () => {
  const input = disclosed(), profile = photoCandidatePublicProfile(input);
  assert.equal(profile.status, 'approved');
  assert.deepEqual(profile.retention, { sourceHours: 12, resultHours: 48, supplierPolicy: input.env.RETENTION_SUPPLIER_POLICY });
  assert.deepEqual(profile.aiServices[0].capabilities, ['photo-effect']);
  assert.equal(profile.aiServices[0].model, input.policy.model); assert.equal(profile.aiServices[0].filingReference, '仅测试的公开登记编号');
  assert.ok(!JSON.stringify(profile).includes('internal-fixture-'));
  assert.ok(Object.isFrozen(profile) && Object.isFrozen(profile.retention) && Object.isFrozen(profile.aiServices)
    && Object.isFrozen(profile.aiServices[0]) && Object.isFrozen(profile.aiServices[0].capabilities));
  input.policy.sourceRetentionMs = 3600000;
  input.env.RETENTION_SUPPLIER_POLICY = 'changed';
  assert.equal(profile.retention.sourceHours, 12);
});

test('missing or malformed facts and other-model disclosures stay pending without invented defaults', () => {
  for (const mutate of [input => { delete input.env.PIPIA_REFERENCE; }, input => { input.env.PIPIA_REFERENCE = '\n'; },
    input => { delete input.env.RETENTION_SUPPLIER_POLICY; }, input => { delete input.env.PRIVACY_POLICY_URL; },
    input => { delete input.policy.sourceRetentionMs; }, input => { input.policy.resultRetentionMs = '86400000'; },
    input => { input.policy.sourceRetentionMs = 31 * 86400000; }, input => { input.policy.basicVersion = ''; },
    input => { input.env.AI_SERVICE_DISCLOSURES_JSON = '{invalid'; }, input => { input.env.AI_SERVICE_DISCLOSURES_JSON = '{}'; },
    input => { input.policy.model = 'different-model'; }, input => { input.policy.provider = 'different-provider'; },
    input => { const rows = JSON.parse(input.env.AI_SERVICE_DISCLOSURES_JSON); rows[0].capabilities = ['video-fusion']; input.env.AI_SERVICE_DISCLOSURES_JSON = JSON.stringify(rows); },
    input => { const rows = JSON.parse(input.env.AI_SERVICE_DISCLOSURES_JSON); rows[0].filingReference = ''; input.env.AI_SERVICE_DISCLOSURES_JSON = JSON.stringify(rows); },
    input => { const rows = JSON.parse(input.env.AI_SERVICE_DISCLOSURES_JSON); rows[0].purpose = 'unsafe\ntext'; input.env.AI_SERVICE_DISCLOSURES_JSON = JSON.stringify(rows); }]) {
    const input = disclosed(); mutate(input); assert.equal(photoCandidatePublicProfile(input).status, 'pending_company_approval');
  }
  const input = disclosed(); delete input.env.RETENTION_SUPPLIER_POLICY;
  assert.equal(photoCandidatePublicProfile(input).retention, null);
  input.env.AI_SERVICE_DISCLOSURES_JSON = JSON.stringify([{ provider: 'unrelated', model: 'unrelated', capabilities: ['photo-effect'] }]);
  assert.deepEqual(photoCandidatePublicProfile(input).aiServices, []);
});

test('configured disclosures are identical for all visitors but never turn technical readiness into verified quality', async () => {
  const profile = photoCandidatePublicProfile(disclosed());
  const app = new Hono(); let authenticateCalls = 0;
  registerPhotoCandidatePublicRoutes(app, { profile,
    catalog: async () => ({ settings: { generationEnabled: true }, miniProgramCreation: { available: true } }),
    authenticated: async () => { authenticateCalls++; throw new Error('must not authenticate public reads'); } });
  for (const token of [null, 'user-one', 'user-two']) {
    const options = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;
    const response = await (await app.request('/api/public/compliance', options)).json();
    assert.deepEqual(response.data, profile);
    const capability = await (await app.request('/api/capabilities', options)).json();
    assert.equal(capability.data[0].ready, false); assert.notEqual(capability.data[0].status, 'verified');
    assert.equal(capability.data[0].status, 'blocked_pending_evidence');
    assert.ok(!JSON.stringify(response).includes('internal-fixture-'));
  }
  assert.equal(authenticateCalls, 0);
  const copiedApp = new Hono();
  registerPhotoCandidatePublicRoutes(copiedApp, { profile: structuredClone(profile), catalog: async () => ({}), authenticated: async () => ({}) });
  assert.equal((await (await copiedApp.request('/api/public/compliance')).json()).data.status, 'pending_company_approval');
});

test('route boundary strips injected approval and private configuration and never turns runtime readiness into formal verification', async () => {
  let ready = true, checks = 0, authenticated = 0;
  const app = new Hono();
  registerPhotoCandidatePublicRoutes(app, { profile: { status: 'approved', testUserIds: ['private-user'], bucket: 'private-bucket',
    aiServices: [{ provider: 'private-provider' }], consentVersions: { basic: 'basic_v1', faceProcessing: 'face_v1' } },
  catalog: async () => { checks++; if (!ready) throw new Error('private-error'); return { settings: { generationEnabled: true }, miniProgramCreation: { available: true } }; },
  authenticated: async () => { authenticated++; return { auth: { userId: 'local-only' } }; } });
  const profile = await (await app.request('/api/public/compliance')).json();
  assert.equal(profile.data.status, 'pending_company_approval'); assert.ok(!JSON.stringify(profile).includes('private-'));
  for (const state of [true, false]) { ready = state;
    const response = await (await app.request('/api/capabilities')).json(); assert.equal(response.data[0].ready, false);
    assert.equal(response.data[0].status, state ? 'blocked_pending_disclosure' : 'blocked_pending_evidence');
  }
  assert.equal(checks, 2); assert.equal(authenticated, 0);
  const rejected = await app.request('/api/reports', { method: 'POST', body: '{invalid unread JSON' });
  assert.equal(rejected.status, 503); const result = await rejected.json();
  assert.equal(result.code, 'REPORT_SUBMISSION_DISABLED'); assert.equal(result.data, undefined); assert.equal(authenticated, 1);
  assert.ok(!JSON.stringify(result).includes('rpt_'));
});
