import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { main, paymentWithPassword, validatePasswordResetScope } from '../scripts/reset-mini-sandbox-password.mjs';
import { builtinSandboxMysql as target } from '../payments/virtual/mysql-transport.js';
import dotenv from 'dotenv';

const password = `Aa1!${Buffer.alloc(32, 8).toString('base64url')}`;
function fixture() {
  const payment = { WECHAT_APP_ID: target.appId, RELEASE_CHANNEL: 'wechat-mini-program', AUTH_MODE: 'wechat',
    XPAY_ENV: '1', XPAY_MODE: 'closed', XPAY_ENABLED: 'false', XPAY_DB_BACKEND: 'mysql',
    XPAY_CLOUD_ENV_ID: target.cloudEnvId, XPAY_MYSQL_INSTANCE_ID: target.instanceId,
    XPAY_MYSQL_HOST: target.host, XPAY_MYSQL_PORT: String(target.port), XPAY_MYSQL_USER: target.user,
    XPAY_MYSQL_DATABASE: target.database, XPAY_MYSQL_PASSWORD: 'fictional-original-password',
    UNRELATED_SECRET: 'fictional-preserved-secret' };
  const cloud = { WXCLOUD_APP_ID: target.appId, WXCLOUD_PRIVATE_KEY: 'fictional-private-api-key' };
  const originalPayment = Object.entries(payment).map(([key, value]) => `${key}=${value}`).join('\r\n') + '\r\n';
  const inventory = { environmentConfirmed: true,
    detail: { dbClusterId: target.instanceId, netInfo: { privateNetAddress: `${target.host}:${target.port}`, pubNetAddress: null },
      dbInfo: { status: 'running', isOpenPubNetAccess: false } },
    accounts: { clusterStatus: 'running', accounts: [{ accountName: target.user, host: '%' }] } };
  const events = [];
  const state = { pending: null, config: originalPayment, resetCalls: 0, generated: 0, failSave: false, failUpdate: false,
    failPhase: null, resetFails: false, failPromote: false, reply: {} };
  const files = {
    readConfiguration: () => ({ originalPayment: state.config, payment: dotenv.parse(state.config), cloud }),
    readPending: () => structuredClone(state.pending),
    createPending(record) {
      events.push('save'); if (state.failSave) throw new Error('disk failure with fictional-secret');
      assert.equal(state.pending, null); state.pending = structuredClone(record);
    },
    updatePending(record, before) {
      events.push(record.phase);
      if (state.failUpdate || state.failPhase === record.phase) throw new Error('fsync failure with fictional-secret');
      assert.deepEqual(before, state.pending); state.pending = structuredClone(record);
    },
    promote(record) {
      events.push('promote'); if (state.failPromote) throw new Error('promotion failure');
      assert.equal(state.pending.phase, 'confirmed'); state.config = paymentWithPassword(record.originalPayment, record.password);
    },
  };
  const options = { files, withCloud: async (config, operation) => {
    assert.deepEqual(config, cloud);
    return operation({ inspect: async () => { events.push('inspect'); return inventory; }, reset: async value => {
      state.resetCalls++; events.push('reset'); assert.equal(value, password);
      assert.equal(state.pending.phase, 'request_started'); assert.equal(state.config, originalPayment);
      if (state.resetFails) throw new Error('Timeout request body: fictional-private-api-key');
      return state.reply;
    } });
  }, generatePassword: () => { state.generated++; return password; }, now: () => '2026-10-07T00:00:00.000Z' };
  return { payment, cloud, originalPayment, inventory, state, events, options };
}

test('default dry run inspects the exact account without generating, saving, or resetting a password', async () => {
  const f = fixture(); const report = await main(f.options);
  assert.equal(report.ok, true); assert.equal(report.mode, 'dry-run'); assert.equal(report.resetWouldBeAllowed, true);
  assert.equal(f.state.resetCalls, 0); assert.equal(f.state.generated, 0); assert.equal(f.state.pending, null);
  assert.deepEqual(f.events, ['inspect']); assert.equal(report.sqlLoginVerified, false);
  assert.equal(report.sslChanged, false); assert.equal(report.permissionsChanged, false); assert.equal(report.deployed, false);
});

test('wrong local app, environment, instance, address, database, account/root, or live mode cannot call cloud', async () => {
  for (const [field, value] of [['WECHAT_APP_ID', 'wx_other'], ['XPAY_CLOUD_ENV_ID', 'other'],
    ['XPAY_MYSQL_INSTANCE_ID', 'other'], ['XPAY_MYSQL_HOST', 'PRIVATE_IP'], ['XPAY_MYSQL_PORT', '3307'],
    ['XPAY_MYSQL_DATABASE', 'production'], ['XPAY_MYSQL_USER', 'root'], ['XPAY_MYSQL_USER', 'other'],
    ['XPAY_ENV', '0'], ['XPAY_MODE', 'production'], ['XPAY_ENABLED', 'true']]) {
    const f = fixture(); f.state.config = f.state.config.replace(`${field}=${f.payment[field]}`, `${field}=${value}`);
    f.options.withCloud = async () => assert.fail('cloud must not be called');
    const report = await main({ ...f.options, mode: 'apply' });
    assert.equal(report.failureCode, 'LOCAL_CONFIGURATION_INVALID'); assert.equal(f.state.resetCalls, 0);
  }
});

test('wrong control-plane target, public access, missing or wrong-host account, and paused instances refuse resets', async () => {
  for (const change of [
    f => { f.inventory.environmentConfirmed = false; }, f => { f.inventory.detail.dbClusterId = 'other'; },
    f => { f.inventory.detail.netInfo.privateNetAddress = 'PRIVATE_IP:3306'; },
    f => { f.inventory.detail.dbInfo.isOpenPubNetAccess = true; },
    f => { f.inventory.detail.dbInfo.isOpenPubNetAccess = 'false'; },
    f => { delete f.inventory.detail.netInfo.pubNetAddress; }, f => { f.inventory.detail.netInfo.pubNetAddress = '203.0.113.1:3306'; },
    f => { f.inventory.accounts.accounts = [{ accountName: 'root', host: '%' }]; },
    f => { f.inventory.accounts.accounts = 'unknown'; },
    f => { f.inventory.accounts.accounts[0].host = 'localhost'; }, f => { f.inventory.accounts.accounts.push({ accountName: target.user, host: '%' }); },
    f => { f.inventory.detail.dbInfo.status = 'pause'; }, f => { f.inventory.accounts.clusterStatus = 'unknown'; },
  ]) {
    const f = fixture(); change(f);
    assert.equal(validatePasswordResetScope(f).passed, false);
    const report = await main({ ...f.options, mode: 'apply' });
    assert.equal(report.failureCode, 'CONTROL_PLANE_SCOPE_MISMATCH');
    assert.equal(f.state.resetCalls, 0); assert.equal(f.state.generated, 0); assert.equal(f.state.pending, null);
  }
});

test('saving pending or request-start evidence must succeed before any remote password write', async () => {
  for (const field of ['failSave', 'failUpdate']) {
    const f = fixture(); f.state[field] = true;
    const report = await main({ ...f.options, mode: 'apply' });
    assert.equal(report.ok, false); assert.equal(f.state.resetCalls, 0); assert.equal(f.state.config, f.originalPayment);
  }
});

test('success saves the original password/config before reset and promotes only after confirmed response is saved', async () => {
  const f = fixture(); const report = await main({ ...f.options, mode: 'apply' });
  assert.equal(report.ok, true); assert.equal(report.remoteResetConfirmed, true); assert.equal(report.localConfigPromoted, true);
  assert.deepEqual(f.events, ['inspect', 'save', 'request_started', 'reset', 'confirmed', 'promote', 'promoted']);
  assert.equal(f.state.pending.originalPayment, f.originalPayment); assert.equal(f.state.pending.password, password);
  assert.equal(dotenv.parse(f.state.config).XPAY_MYSQL_PASSWORD, password);
  assert.equal(dotenv.parse(f.state.config).UNRELATED_SECRET, f.payment.UNRELATED_SECRET);
  const json = JSON.stringify(report);
  for (const secret of [password, f.payment.XPAY_MYSQL_PASSWORD, f.payment.UNRELATED_SECRET, f.cloud.WXCLOUD_PRIVATE_KEY]) {
    assert.equal(json.includes(secret), false);
  }
});

test('timeout retains the same pending password and old env; another apply never randomly rotates or retries', async () => {
  const f = fixture(); f.state.resetFails = true;
  const report = await main({ ...f.options, mode: 'apply' });
  assert.equal(report.failureCode, 'REMOTE_RESET_UNCONFIRMED'); assert.equal(report.changedRemoteState, 'unconfirmed');
  assert.equal(f.state.pending.phase, 'request_started'); assert.equal(f.state.pending.password, password);
  assert.equal(f.state.config, f.originalPayment); assert.equal(f.state.resetCalls, 1); assert.equal(f.state.generated, 1);
  const second = await main({ ...f.options, mode: 'apply' });
  assert.equal(second.failureCode, 'PENDING_REQUIRES_REVIEW'); assert.equal(f.state.resetCalls, 1); assert.equal(f.state.generated, 1);
  assert.equal(JSON.stringify(report).includes('fictional-private-api-key'), false);
});

test('unexpected resolved SDK results remain uncertain without promotion', async () => {
  for (const reply of [undefined, null, false, [], { error: 'fictional-secret' }]) {
    const f = fixture(); f.state.reply = reply;
    const report = await main({ ...f.options, mode: 'apply' });
    assert.equal(report.failureCode, 'REMOTE_RESET_UNCONFIRMED'); assert.equal(f.state.pending.phase, 'request_started');
    assert.equal(f.state.config, f.originalPayment);
  }
});

test('confirmed remote reset with failed local promotion recovers without another reset', async () => {
  const f = fixture(); f.state.failPromote = true;
  const first = await main({ ...f.options, mode: 'apply' });
  assert.equal(first.failureCode, 'PROMOTION_FAILED'); assert.equal(f.state.pending.phase, 'confirmed');
  assert.equal(f.state.config, f.originalPayment); f.state.failPromote = false;
  const second = await main({ ...f.options, mode: 'apply' });
  assert.equal(second.ok, true); assert.equal(f.state.resetCalls, 1); assert.equal(f.state.generated, 1);
});

test('failure to persist a successful remote acknowledgement keeps old env and refuses a second reset', async () => {
  const f = fixture(); f.state.failPhase = 'confirmed';
  const report = await main({ ...f.options, mode: 'apply' });
  assert.equal(report.failureCode, 'CONFIRMATION_NOT_SAVED'); assert.equal(report.remoteResetConfirmed, true);
  assert.equal(f.state.pending.phase, 'request_started'); assert.equal(f.state.config, f.originalPayment);
  f.state.failPhase = null;
  assert.equal((await main({ ...f.options, mode: 'apply' })).failureCode, 'PENDING_REQUIRES_REVIEW');
  assert.equal(f.state.resetCalls, 1); assert.equal(f.state.generated, 1);
});

test('existing pending in dry run is inspected but neither changed nor replayed', async () => {
  const f = fixture(); f.state.resetFails = true;
  await main({ ...f.options, mode: 'apply' });
  const pending = structuredClone(f.state.pending), events = f.events.length;
  const report = await main(f.options);
  assert.equal(report.ok, true); assert.equal(report.resetWouldBeAllowed, false);
  assert.deepEqual(f.state.pending, pending); assert.deepEqual(f.events.slice(events), ['inspect']);
  assert.equal(f.state.resetCalls, 1); assert.equal(f.state.generated, 1);
});

test('already promoted state never repeats reset and detects later local configuration changes', async () => {
  const f = fixture(); await main({ ...f.options, mode: 'apply' });
  assert.equal((await main({ ...f.options, mode: 'apply' })).alreadyPromoted, true);
  f.state.config += 'CHANGED_LOCAL_FIELD=afterwards\n';
  assert.equal((await main({ ...f.options, mode: 'apply' })).failureCode, 'PAYMENT_CONFIG_CHANGED');
  assert.equal(f.state.resetCalls, 1); assert.equal(f.state.generated, 1);
});

test('malformed pending or invalid mode refuses all cloud access', async () => {
  const f = fixture(); f.state.pending = { version: 1, target: { ...target, user: 'root' }, accountHost: '%',
    phase: 'confirmed', password, originalPayment: f.originalPayment,
    originalPaymentDigest: crypto.createHash('sha256').update(f.originalPayment).digest('hex') };
  f.options.withCloud = async () => assert.fail('cloud must not be called');
  assert.equal((await main({ ...f.options, mode: 'apply' })).failureCode, 'PENDING_INVALID');
  assert.equal((await main({ ...f.options, mode: 'unexpected' })).failureCode, 'MODE_INVALID');
});

test('duplicate or unsafe multiline password assignments cannot silently overwrite unrelated configuration', () => {
  const f = fixture();
  assert.throws(() => paymentWithPassword(f.originalPayment + 'XPAY_MYSQL_PASSWORD=duplicate\n', password), /LOCAL_CONFIGURATION_INVALID/);
  assert.throws(() => paymentWithPassword(f.originalPayment, 'unsafe\nvalue'), /PENDING_INVALID/);
});
