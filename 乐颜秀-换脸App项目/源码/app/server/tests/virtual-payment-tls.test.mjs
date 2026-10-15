import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { createPool } from 'mysql2/promise';
import { virtualMysqlOptions } from '../payments/virtual/runtime.js';

const config = {
  XPAY_MYSQL_HOST: 'payments.example.invalid', XPAY_MYSQL_USER: 'sandbox',
  XPAY_MYSQL_PASSWORD: 'test-only', XPAY_MYSQL_DATABASE: 'sandbox',
};

test('missing CA cannot fall back to plaintext in sandbox, merchant test or live', () => {
  for (const DEPLOY_ENV of [undefined, 'test', 'staging', 'production']) {
    for (const XPAY_MODE of ['closed', 'sandbox', 'merchant_test', 'live']) {
      assert.throws(() => virtualMysqlOptions({ ...config, DEPLOY_ENV, XPAY_MODE }), /XPAY_MYSQL_TLS_REQUIRED/);
      assert.throws(() => virtualMysqlOptions({ ...config, DEPLOY_ENV, XPAY_MODE, XPAY_MYSQL_CA_FILE: ' ' }), /XPAY_MYSQL_TLS_REQUIRED/);
    }
  }
});

test('missing certificate file fails before a MySQL connection can be created', () => {
  assert.throws(() => virtualMysqlOptions({ ...config, XPAY_MYSQL_CA_FILE: path.join(os.tmpdir(), `absent-ca-${process.pid}-${Date.now()}.pem`) }), /ENOENT/);
});

test('mysql2 receives certificate chain and identity verification without downgrade options', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-mini-tls-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const certificate = path.join(directory, 'ca.pem');
  fs.writeFileSync(certificate, tls.rootCertificates[0]);
  const options = virtualMysqlOptions({ ...config, XPAY_MYSQL_CA_FILE: certificate });
  const pool = createPool(options); // Lazy pool: this test never contacts a database.
  t.after(() => pool.end());
  const actual = pool.pool.config.connectionConfig.ssl;
  assert.equal(actual.ca, tls.rootCertificates[0]);
  assert.equal(actual.rejectUnauthorized, true);
  assert.equal(actual.verifyIdentity, true);
  assert.equal(actual.minVersion, 'TLSv1.2');
  assert.doesNotThrow(() => tls.createSecureContext(actual));
});
