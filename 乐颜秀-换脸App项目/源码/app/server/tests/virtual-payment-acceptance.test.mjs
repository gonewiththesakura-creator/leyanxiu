import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { virtualAcceptanceMatches, acceptedVirtualPaymentEvidence } from '../payments/virtual/runtime.js';

const now = Date.parse('2026-10-11T10:30:00.000Z');
const expected = { appId: 'wx0123456789abcdef', env: '0', offerId: 'synthetic-offer' };
const checks = { mysqlRestore: true, merchantPayment: true, merchantRefund: true, crossDeviceRestore: true,
  iosRefund: true, securityReview: true, dailyReconciliation: true };
const report = () => ({ appId: expected.appId, env: 0, offerId: expected.offerId, acceptedAt: new Date(now - 1000).toISOString(), checks: { ...checks } });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const androidScope = { ...expected, purchaseProfile: 'android-only-v1' };
const androidReport = () => ({ ...report(), purchaseProfile: 'android-only-v1', supportedPlatforms: ['android'],
  checks: { ...checks, iosRefund: 'not_applicable' }, appleIap: { enabled: false, source: 'wechat-mini-program-console',
    checkedAt: new Date(now - 2000).toISOString(), evidenceSha256: hash('synthetic console evidence; no actual acceptance') } });

test('merchant acceptance requires the same app, env0 and OfferID with every existing check exactly true', () => {
  assert.equal(virtualAcceptanceMatches(report(), expected, now), true);
  for (const value of [null, [], {}, { ...report(), appId: 'another-app' }, { ...report(), env: undefined },
    { ...report(), env: 1 }, { ...report(), env: '0' }, { ...report(), offerId: undefined },
    { ...report(), offerId: 'other-offer' }, { ...report(), offerId: 123 }, { ...report(), checks: null },
    { ...report(), checks: [] }, { ...report(), checks: Object.create(checks) }]) {
    assert.equal(virtualAcceptanceMatches(value, expected, now), false);
  }
  for (const key of Object.keys(checks)) for (const value of [false, undefined, 1, 'true']) {
    assert.equal(virtualAcceptanceMatches({ ...report(), checks: { ...checks, [key]: value } }, expected, now), false);
  }
  for (const scope of [{}, { ...expected, env: '1' }, { ...expected, env: 0 }, { ...expected, appId: '' },
    { ...expected, offerId: '' }, { ...expected, offerId: ' synthetic-offer' }]) {
    assert.equal(virtualAcceptanceMatches(report(), scope, now), false);
  }
});

test('acceptance requires an unambiguous valid UTC timestamp no later than now and less than 30 days old', () => {
  assert.equal(virtualAcceptanceMatches({ ...report(), acceptedAt: '2026-10-11T10:30:00Z' }, expected, now), true);
  assert.equal(virtualAcceptanceMatches({ ...report(), acceptedAt: new Date(now - 30 * 86400000 + 1).toISOString() }, expected, now), true);
  for (const acceptedAt of [undefined, null, now, '2026-10-11', '2026-10-11T10:30:00', 'not-a-date',
    '2026-02-30T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-10-11T25:00:00.000Z',
    '2026-10-11T10:30:00.000Z trailing', new Date(now + 1).toISOString(), new Date(now - 30 * 86400000).toISOString(),
    new Date(now - 31 * 86400000).toISOString()]) {
    assert.equal(virtualAcceptanceMatches({ ...report(), acceptedAt }, expected, now), false);
  }
  for (const clock of [NaN, Infinity, -1, now + 0.5]) assert.equal(virtualAcceptanceMatches(report(), expected, clock), false);
});

test('only bounded regular files with the exact SHA256 and matching env0 facts are accepted', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-payment-acceptance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'fixture-report.json');
  const env = { WECHAT_APP_ID: expected.appId, XPAY_ENV: expected.env, XPAY_OFFER_ID: expected.offerId,
    XPAY_ACCEPTANCE_FILE: file, XPAY_ACCEPTANCE_SHA256: '' };
  const save = value => { const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
    fs.writeFileSync(file, bytes); env.XPAY_ACCEPTANCE_SHA256 = hash(bytes); };
  save(report()); assert.equal(acceptedVirtualPaymentEvidence(env, now), true);
  for (const XPAY_ACCEPTANCE_SHA256 of ['', '0'.repeat(64), env.XPAY_ACCEPTANCE_SHA256.toUpperCase(), '../fixture']) {
    assert.equal(acceptedVirtualPaymentEvidence({ ...env, XPAY_ACCEPTANCE_SHA256 }, now), false);
  }
  for (const XPAY_ACCEPTANCE_FILE of [undefined, 'relative.json', directory, path.join(directory, 'absent.json')]) {
    assert.equal(acceptedVirtualPaymentEvidence({ ...env, XPAY_ACCEPTANCE_FILE }, now), false);
  }
  save({ ...report(), env: 1 }); assert.equal(acceptedVirtualPaymentEvidence(env, now), false);
  save({ ...report(), env: undefined }); assert.equal(acceptedVirtualPaymentEvidence(env, now), false);
  save({ ...report(), offerId: 'other-offer' }); assert.equal(acceptedVirtualPaymentEvidence(env, now), false);
  save('{invalid-json'); assert.equal(acceptedVirtualPaymentEvidence(env, now), false);
  save(''); assert.equal(acceptedVirtualPaymentEvidence(env, now), false);
  save(' '.repeat(1024 * 1024 + 1)); assert.equal(acceptedVirtualPaymentEvidence(env, now), false);
  save(report()); fs.appendFileSync(file, ' '); assert.equal(acceptedVirtualPaymentEvidence(env, now), false);
  save(report());
  const link = path.join(directory, 'directory-link');
  fs.symlinkSync(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(acceptedVirtualPaymentEvidence({ ...env, XPAY_ACCEPTANCE_FILE: link }, now), false);
});

test('Android-only acceptance is explicitly scoped, never invents an iOS pass, and retains all six common checks', () => {
  assert.equal(virtualAcceptanceMatches(androidReport(), androidScope, now), true);
  assert.equal(virtualAcceptanceMatches(androidReport(), expected, now), false);
  assert.equal(virtualAcceptanceMatches(report(), androidScope, now), false);
  for (const purchaseProfile of [undefined, null, 'all-platforms', 'android-only-v2', ['android-only-v1']]) {
    assert.equal(virtualAcceptanceMatches({ ...androidReport(), purchaseProfile }, androidScope, now), false);
  }
  for (const supportedPlatforms of [undefined, [], ['ios'], ['android', 'ios'], ['android', 'android'], 'android']) {
    assert.equal(virtualAcceptanceMatches({ ...androidReport(), supportedPlatforms }, androidScope, now), false);
  }
  for (const iosRefund of [undefined, false, true, null, 'true']) {
    assert.equal(virtualAcceptanceMatches({ ...androidReport(), checks: { ...checks, iosRefund } }, androidScope, now), false);
  }
  for (const key of Object.keys(checks).filter(key => key !== 'iosRefund')) for (const value of [false, undefined, 'true', 1]) {
    const changed = androidReport(); changed.checks[key] = value;
    assert.equal(virtualAcceptanceMatches(changed, androidScope, now), false, key);
  }
  for (const scope of [{ ...androidScope, purchaseProfile: 'all-platforms' }, { ...androidScope, env: '1' },
    { ...androidScope, appId: 'wx0000000000000000' }, { ...androidScope, offerId: 'other-offer' }]) {
    assert.equal(virtualAcceptanceMatches(androidReport(), scope, now), false);
  }
});

test('Android-only acceptance requires dated disabled-IAP console evidence inside the pinned report', t => {
  const facts = androidReport().appleIap;
  for (const appleIap of [undefined, {}, [], { ...facts, enabled: true }, { ...facts, enabled: 'false' },
    { ...facts, source: 'client-platform' }, { ...facts, evidenceSha256: '' }, { ...facts, evidenceSha256: 'https://private.invalid' },
    { ...facts, checkedAt: undefined }, { ...facts, checkedAt: '2026-02-30T00:00:00Z' },
    { ...facts, checkedAt: new Date(now).toISOString() },
    { ...facts, checkedAt: new Date(now - 30 * 86400000).toISOString() }]) {
    assert.equal(virtualAcceptanceMatches({ ...androidReport(), appleIap }, androidScope, now), false);
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-android-acceptance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'synthetic-only.json'), bytes = Buffer.from(JSON.stringify(androidReport()));
  fs.writeFileSync(file, bytes);
  const env = { WECHAT_APP_ID: expected.appId, XPAY_ENV: '0', XPAY_OFFER_ID: expected.offerId,
    XPAY_ACCEPTANCE_FILE: file, XPAY_ACCEPTANCE_SHA256: hash(bytes) };
  assert.equal(acceptedVirtualPaymentEvidence(env, now, { purchaseProfile: 'android-only-v1' }), true);
  assert.equal(acceptedVirtualPaymentEvidence(env, now), false);
  assert.equal(acceptedVirtualPaymentEvidence({ ...env, XPAY_ENV: '1' }, now, { purchaseProfile: 'android-only-v1' }), false);
  fs.appendFileSync(file, ' ');
  assert.equal(acceptedVirtualPaymentEvidence(env, now, { purchaseProfile: 'android-only-v1' }), false);
});
