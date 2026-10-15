import test from 'node:test';
import assert from 'node:assert/strict';
import { createCloudbaseFunctionProbe, cloudbaseProbeEvents } from '../payments/virtual/cloudbase-function-probe.js';

const env = {
  WECHAT_APP_ID: 'wx-probe-app',
  WECHAT_MINIPROGRAM_ORIGINAL_ID: 'gh_probe_original',
  XPAY_MODE: 'closed',
  XPAY_ENABLED: 'false',
  XPAY_PROBE_ENV: '1',
  XPAY_PROBE_TRIGGER: 'wechat-message-push',
  XPAY_PROBE_SYNTHETIC_ENABLED: 'true',
};
const context = { triggerSource: 'wechat-message-push', appId: env.WECHAT_APP_ID };

function fakeDatabase() {
  const rows = new Map();
  return {
    rows,
    collection(name) {
      return { doc(id) {
        const key = `${name}/${id}`;
        return {
          async set({ data }) { rows.set(key, structuredClone(data)); return { _id: id }; },
          async get() { return { data: rows.has(key) ? structuredClone(rows.get(key)) : null }; },
          async remove() { rows.delete(key); return { stats: { removed: 1 } }; },
        };
      } };
    },
  };
}

test('direct CloudBase probe accepts only the configured source and exact echo action', async () => {
  const alerts = [];
  const main = createCloudbaseFunctionProbe({ env, alert: (event, details) => alerts.push({ event, details }) });
  const result = await main({ action: 'CheckContainerPath', ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID }, context);
  assert.deepEqual(result, { ErrCode: 0, ErrMsg: 'success', Probe: 'verification-only', evidence: { synthetic: true, businessAcknowledged: false } });
  assert.deepEqual(alerts, []);
});

test('direct CloudBase probe rejects wrong source, app, environment and trigger without accepting business events', async () => {
  const alerts = [];
  const main = createCloudbaseFunctionProbe({ env, alert: (event, details) => alerts.push({ event, details }) });
  for (const event of [
    { action: 'CheckContainerPath', ToUserName: 'gh_other' },
    { action: 'CheckContainerPath', ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID, AppId: 'wx_other' },
    { action: 'CheckContainerPath', ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID, Env: 0 },
  ]) {
    const result = await main(event, context);
    assert.equal(result.ErrCode, 1);
    assert.match(result.ErrMsg, /^XPAY_PROBE_/);
  }
  const wrongTrigger = await main({ action: 'CheckContainerPath', ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID }, { ...context, triggerSource: 'client-call' });
  assert.deepEqual(wrongTrigger, { ErrCode: 1, ErrMsg: 'XPAY_PROBE_TRIGGER_MISMATCH', evidence: { synthetic: true, businessAcknowledged: false } });
  for (const Event of cloudbaseProbeEvents) {
    const result = await main({ ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID, MsgType: 'event', Event, Env: 1, OpenId: 'user-secret', OutTradeNo: 'order-secret' }, context);
    assert.equal(result.ErrCode, 1);
    assert.equal(result.ErrMsg, 'XPAY_PROBE_NOT_READY');
  }
  const unknown = await main({ ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID, MsgType: 'event', Event: 'unrecognised_event', Env: 1 }, context);
  assert.deepEqual(unknown, { ErrCode: 1, ErrMsg: 'XPAY_PROBE_EVENT_NOT_ALLOWED', evidence: { synthetic: true, businessAcknowledged: false } });
  assert.ok(alerts.length >= cloudbaseProbeEvents.length);
  assert.ok(!JSON.stringify(alerts).includes('user-secret'));
  assert.ok(!JSON.stringify(alerts).includes('order-secret'));
});

test('direct CloudBase probe rejects extra fields attached to an echo action', async () => {
  const main = createCloudbaseFunctionProbe({ env });
  const result = await main({ action: 'CheckContainerPath', ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID, Event: 'xpay_goods_deliver_notify' }, context);
  assert.equal(result.ErrCode, 1);
  assert.equal(result.ErrMsg, 'XPAY_PROBE_NOT_READY');
});

test('synthetic echo and database probes return structured evidence and clean up the fixed probe document', async () => {
  const database = fakeDatabase();
  const main = createCloudbaseFunctionProbe({ env, database });
  const echo = await main({ action: 'probe_echo', synthetic: true, Env: 1, ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID }, context);
  assert.deepEqual(echo, { ErrCode: 0, ErrMsg: 'success', Probe: 'echo', evidence: { synthetic: true, businessAcknowledged: false } });
  const db = await main({ action: 'probe_db', synthetic: true, Env: 1, ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID, runId: 'abcdef123456' }, context);
  assert.equal(db.ErrCode, 0);
  assert.equal(db.Probe, 'database');
  assert.deepEqual(db.evidence, { synthetic: true, database: true, committed: true, roundTrip: true, removed: true, collection: 'lyx_xpay_probe_health' });
  assert.equal(database.rows.size, 0);
  const missing = await createCloudbaseFunctionProbe({ env })({ action: 'probe_db', synthetic: true, ToUserName: env.WECHAT_MINIPROGRAM_ORIGINAL_ID }, context);
  assert.equal(missing.ErrMsg, 'XPAY_PROBE_DB_UNAVAILABLE');
});

test('source probe refuses non-closed startup without requiring wx-server-sdk', () => {
  assert.throws(() => createCloudbaseFunctionProbe({ env: { ...env, XPAY_MODE: 'live' } }), /CLOSED_SALES/);
  assert.throws(() => createCloudbaseFunctionProbe({ env: { ...env, XPAY_ENABLED: 'true' } }), /CLOSED_SALES/);
  assert.throws(() => createCloudbaseFunctionProbe({ env: { ...env, XPAY_PROBE_ENV: '0' } }), /SANDBOX_REQUIRED/);
});

test('synthetic probes are disabled by default and cannot access the database', async () => {
  let accesses = 0;
  const { XPAY_PROBE_SYNTHETIC_ENABLED, ...closedEnv } = env;
  const main = createCloudbaseFunctionProbe({ env: closedEnv,
    database: { collection() { accesses++; throw new Error('unexpected database access'); } } });
  for (const action of ['probe_echo', 'probe_db', 'CheckContainerPath']) {
    const result = await main({ action, synthetic: true, ToUserName: closedEnv.WECHAT_MINIPROGRAM_ORIGINAL_ID,
      Env: 1, runId: 'abcdef123456' }, context);
    assert.equal(result.ErrCode, 1);
    assert.equal(result.ErrMsg, 'XPAY_PROBE_SYNTHETIC_DISABLED');
    assert.equal(result.evidence.businessAcknowledged, false);
  }
  assert.equal(accesses, 0);
});
