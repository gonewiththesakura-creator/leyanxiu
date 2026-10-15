import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'leyanxiu-paid-'));
process.env.COMPLIANCE_STORE_FILE = path.join(root, 'ledger.json');
process.env.DEPLOY_ENV = 'test';
process.env.CLOSED_TEST_MODE = 'true';
const { store } = await import('../compliance-store.js');

test('public access rejects trial grants and ignores historical trial balance', () => {
  const user = store.createOrGetUser({ subject: 'paid-policy-user' });
  assert.equal(store.grantTrial(user.id, 3), true);
  process.env.CLOSED_TEST_MODE = 'false';
  try {
    assert.equal(store.grantTrial(user.id, 2, 'another-grant'), false);
    assert.equal(store.entitlements(user.id).totalRemaining, 0);
    assert.equal(store.reserveCreation(user.id, 'unpaid-task').ok, false);
  } finally {
    process.env.CLOSED_TEST_MODE = 'true';
  }
  assert.equal(store.entitlements(user.id).totalRemaining, 3);
});

test('production forbids trial credits even with an accidental test flag', () => {
  process.env.DEPLOY_ENV = 'production';
  try {
    const user = store.createOrGetUser({ subject: 'production-user' });
    assert.equal(store.grantTrial(user.id, 3), false);
    assert.equal(store.entitlements(user.id).totalRemaining, 0);
  } finally {
    process.env.DEPLOY_ENV = 'test';
  }
});
