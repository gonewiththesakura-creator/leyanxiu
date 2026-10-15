import { readMessageJson } from './message-endpoint.js';

export const cloudMessagePath = '/api/mini/payments/notify/cloud';

// Verification-only, deliberately not a fulfillment adapter. Deploy behind the
// WeChat cloud gateway with PUBLIC access closed. Headers alone are not proof
// of origin on a directly exposed HTTP server. The documentation uses the plural
// x-wx-sources; the official WeixinCloud Node example uses x-wx-source.
export function createCloudVerificationEndpoint({ appId, alert = () => {} }) {
  if (!appId) throw new Error('XPAY_CLOUD_APPID_REQUIRED');
  return async request => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const reject = (code, status) => {
      try { alert('virtual_payment.cloud_callback_rejected', { code }); } catch { /* No payload logging. */ }
      return Response.json({ code }, { status, headers });
    };
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { ...headers, Allow: 'POST' } });
    if (!request.headers.get('x-wx-source')?.trim() && !request.headers.get('x-wx-sources')?.trim()) return reject('XPAY_CLOUD_SOURCE_REQUIRED', 401);
    for (const key of ['x-wx-appid', 'x-wx-from-appid']) {
      const value = request.headers.get(key);
      if (value !== null && value !== appId) return reject('XPAY_MESSAGE_APPID', 401);
    }
    try {
      const message = await readMessageJson(request);
      if (!message || typeof message !== 'object' || Array.isArray(message)) return reject('XPAY_MESSAGE_INVALID', 400);
      // Exact probe only: never acknowledge an event with a probe field added.
      if (message.action === 'CheckContainerPath' && Object.keys(message).length === 1) {
        return new Response('success', { headers });
      }
      // No debug shortcut, no database or grant function, and no success for
      // payment/refund/unknown events until the full transactional service exists.
      return reject('XPAY_NOT_READY', 503);
    } catch (error) {
      return reject(error.message === 'XPAY_MESSAGE_TOO_LARGE' ? 'XPAY_MESSAGE_TOO_LARGE' : 'XPAY_MESSAGE_INVALID',
        error.message === 'XPAY_MESSAGE_TOO_LARGE' ? 413 : 400);
    }
  };
}
