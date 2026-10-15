import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'dotenv';
import { planAccountRuntime, ACCOUNT_RUNTIME_SETTINGS } from '../deploy/update-app-account-runtime.mjs';
const original = 'DEPLOY_ENV=staging\nRELEASE_CHANNEL=android-app\nAUTH_MODE=device_key\nAPP_LOGIN_ENABLED=true\nCLOSED_TEST_MODE=true\nCLOSED_TEST_REQUIRE_INVITE=true\nPAYMENT_MODE=closed_test\nPROVIDER=mock\nOBJECT_STORAGE_BACKEND=file\nACCOUNT_OTP_SECRET=' + 'fixture-secret-'.repeat(4) + '\nSMS_DAILY_LIMIT=20\n';
const proof = { consistentBackupVerified: true };
test('runtime update preserves existing identity and SMS budget while supplying matching policies and privacy version', () => {
  const plan = planAccountRuntime(original, proof); const updated = parse(plan.text);
  for (const [k,v] of Object.entries(parse(original))) assert.equal(updated[k], v);
  for (const [k,v] of Object.entries(ACCOUNT_RUNTIME_SETTINGS)) assert.equal(updated[k], v);
  assert.equal(planAccountRuntime(plan.text, proof).changedFields.length, 0);
});
test('refuses unverified backup, unrelated changes, ambiguous config and wrong target', () => {
  for (const p of [{}, { consistentBackupVerified: false }, { ...proof, ACCOUNT_OTP_SECRET: 'new' }]) assert.throws(() => planAccountRuntime(original, p));
  for (const current of [original.replace('staging','production'), original.replace('PAYMENT_MODE=closed_test','PAYMENT_MODE=live'), original+'PROVIDER=mock\n', original.replace('CLOSED_TEST_REQUIRE_INVITE=true','CLOSED_TEST_REQUIRE_INVITE=true # comment')]) assert.throws(() => planAccountRuntime(current, proof));
});
