// CommonJS entrypoint for a CloudBase Node.js cloud function.
// The real handler is lazy-loaded so this bundle has no wx-server-sdk or
// business-ledger dependency. It is intentionally verification-only.
let handler;
function eventFromInvocation(event, context) {
  if (event && typeof event === 'object' && Object.keys(event).length > 0) return event;
  const raw = context?.clientContext;
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 2048) return event;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.synthetic === true ? parsed : event;
  } catch {
    return event;
  }
}
exports.main = async (event, context) => {
  if (!handler) {
    const { createCloudbaseFunctionProbe } = await import('./cloudbase-function-probe.mjs');
    // CloudBase provides wx-server-sdk in the function runtime after the
    // function package installs it. DYNAMIC_CURRENT_ENV prevents an accidental
    // write to a hard-coded environment. The probe never reads business data.
    let cloud;
    try {
      cloud = require('wx-server-sdk');
      cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
    } catch {
      throw new Error('XPAY_PROBE_WX_SERVER_SDK_REQUIRED');
    }
    handler = createCloudbaseFunctionProbe({ database: cloud.database() });
  }
  const result = await handler(eventFromInvocation(event, context), context);
  console.log(JSON.stringify({ probe: 'verification-only', errCode: result?.ErrCode, errMsg: result?.ErrMsg, businessAcknowledged: false }));
  return result;
};
