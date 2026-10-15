import crypto from 'node:crypto';

// Direct CloudBase message-push probe only. It is deliberately separate from
// the legacy HTTP/AES receiver and never imports payment credentials or SQL.
export const cloudbaseProbeEvents = Object.freeze([
  'xpay_goods_deliver_notify',
  'xpay_coin_pay_notify',
  'xpay_complaint_notify',
  'xpay_subscribe_signing_result_notify',
  'xpay_subscribe_pay_fail_notify',
  'xpay_subscribe_ios_refund_query_notify',
  'xpay_refund_notify',
]);
export const cloudbaseProbeCollection = 'lyx_xpay_probe_health';

const asString = value => typeof value === 'string' ? value.trim() : '';
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const reject = (code, extra = {}) => ({ ErrCode: 1, ErrMsg: code, ...extra });

function configFrom(env) {
  const appId = asString(env.WECHAT_APP_ID);
  const originalId = asString(env.WECHAT_MINIPROGRAM_ORIGINAL_ID);
  if (!appId || !originalId) throw new Error('XPAY_PROBE_CONFIG_REQUIRED');
  if (asString(env.XPAY_MODE) !== 'closed' || asString(env.XPAY_ENABLED) === 'true') {
    throw new Error('XPAY_PROBE_REQUIRES_CLOSED_SALES');
  }
  const probeEnv = Number(env.XPAY_PROBE_ENV ?? 1);
  if (probeEnv !== 1) throw new Error('XPAY_PROBE_SANDBOX_REQUIRED');
  return Object.freeze({ appId, originalId, probeEnv, trigger: asString(env.XPAY_PROBE_TRIGGER),
    syntheticEnabled: asString(env.XPAY_PROBE_SYNTHETIC_ENABLED) === 'true' });
}

function contextValue(context, ...keys) {
  for (const key of keys) {
    const value = context?.[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function assertDirectSource(event, context, config) {
  if (event.ToUserName !== config.originalId) throw new Error('XPAY_PROBE_SOURCE_MISMATCH');
  const appId = event.AppId ?? event.AppID ?? event.appid
    ?? contextValue(context, 'appId', 'AppId', 'WX_APPID', 'wxAppId');
  if (appId !== undefined && appId !== config.appId) throw new Error('XPAY_PROBE_APPID_MISMATCH');
  if (config.trigger) {
    const trigger = contextValue(context, 'triggerSource', 'triggerType', 'source');
    if (trigger !== config.trigger) throw new Error('XPAY_PROBE_TRIGGER_MISMATCH');
  }
  if (event.Env !== undefined && event.Env !== config.probeEnv) throw new Error('XPAY_PROBE_ENV_MISMATCH');
}

async function databaseProbe(database, event, config, alert) {
  if (!database?.collection) return reject('XPAY_PROBE_DB_UNAVAILABLE', {
    evidence: { synthetic: true, database: false, committed: false },
  });
  const runId = asString(event.runId) || crypto.randomBytes(6).toString('hex');
  if (!/^[a-f0-9]{12}$/.test(runId)) return reject('XPAY_PROBE_RUN_ID_INVALID');
  const documentId = `run_${runId}`;
  const record = { synthetic: true, appId: config.appId, env: config.probeEnv, runId, kind: 'cloudbase_probe' };
  let document;
  try {
    document = database.collection(cloudbaseProbeCollection).doc(documentId);
    await document.set({ data: record });
    const result = await document.get();
    if (!isRecord(result?.data) || result.data.synthetic !== true || result.data.runId !== runId
      || result.data.appId !== config.appId || result.data.env !== config.probeEnv) {
      throw new Error('XPAY_PROBE_DB_ROUNDTRIP_MISMATCH');
    }
    await document.remove();
    return { ErrCode: 0, ErrMsg: 'success', Probe: 'database', evidence: {
      synthetic: true, database: true, committed: true, roundTrip: true, removed: true, collection: cloudbaseProbeCollection,
    } };
  } catch (error) {
    try { await document?.remove?.(); } catch { /* cleanup is best effort */ }
    try { alert('virtual_payment.cloud_function_probe_db_failed', {
      code: error?.message === 'XPAY_PROBE_DB_ROUNDTRIP_MISMATCH' ? error.message : 'XPAY_PROBE_DB_UNCONFIRMED',
    }); } catch { /* no payload logging */ }
    return reject(error?.message === 'XPAY_PROBE_DB_ROUNDTRIP_MISMATCH' ? error.message : 'XPAY_PROBE_DB_UNCONFIRMED', {
      evidence: { synthetic: true, database: true, committed: false, collection: cloudbaseProbeCollection },
    });
  }
}

export function createCloudbaseFunctionProbe({ env = process.env, alert = () => {}, database } = {}) {
  const config = configFrom(env);
  return async function main(event, context) {
    if (!isRecord(event)) return reject('XPAY_PROBE_EVENT_INVALID');
    try {
      assertDirectSource(event, context, config);
      const eventType = asString(event.Event);
      const sourceKeys = new Set(['action', 'ToUserName', 'AppId', 'AppID', 'appid', 'Env', 'runId', 'synthetic']);
      const allowedProbe = Object.keys(event).every(key => sourceKeys.has(key));
      if (allowedProbe && !eventType && ['probe_echo', 'CheckContainerPath', 'probe_db'].includes(event.action)
        && !config.syntheticEnabled) {
        return reject('XPAY_PROBE_SYNTHETIC_DISABLED', { evidence: { synthetic: true, businessAcknowledged: false } });
      }
      if (allowedProbe && !eventType && event.action === 'probe_echo' && event.synthetic === true) {
        return { ErrCode: 0, ErrMsg: 'success', Probe: 'echo', evidence: { synthetic: true, businessAcknowledged: false } };
      }
      if (allowedProbe && !eventType && event.action === 'CheckContainerPath') {
        return { ErrCode: 0, ErrMsg: 'success', Probe: 'verification-only', evidence: { synthetic: true, businessAcknowledged: false } };
      }
      if (allowedProbe && !eventType && event.action === 'probe_db' && event.synthetic === true) {
        return databaseProbe(database, event, config, alert);
      }
      const code = eventType.startsWith('xpay_') ? 'XPAY_PROBE_NOT_READY' : 'XPAY_PROBE_EVENT_NOT_ALLOWED';
      try { alert('virtual_payment.cloud_function_probe_rejected', { code, eventType: eventType || 'unknown' }); } catch { /* no payload logging */ }
      return reject(code, { evidence: { synthetic: true, businessAcknowledged: false } });
    } catch (error) {
      const code = /^XPAY_[A-Z0-9_]+$/.test(error?.message) ? error.message : 'XPAY_PROBE_SOURCE_REJECTED';
      try { alert('virtual_payment.cloud_function_probe_rejected', { code, eventType: asString(event.Event) || 'unknown' }); } catch { /* no payload logging */ }
      return reject(code, { evidence: { synthetic: true, businessAcknowledged: false } });
    }
  };
}
