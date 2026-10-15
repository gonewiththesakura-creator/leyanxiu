// Shared by the payment service and the standalone, verification-only receiver.
// URL verification needs the message keys, not the payment database or AppKey.
export const virtualMessagePath = '/api/mini/payments/notify';
const maxBytes = 128 * 1024;
const authenticationErrors = new Set(['XPAY_MESSAGE_SIGNATURE', 'XPAY_MESSAGE_EXPIRED', 'XPAY_MESSAGE_APPID']);

export async function readMessageJson(request) {
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new Error('XPAY_MESSAGE_TOO_LARGE');
  if (!request.body) throw new Error('XPAY_MESSAGE_INVALID');
  const reader = request.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); throw new Error('XPAY_MESSAGE_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('XPAY_MESSAGE_INVALID'); }
  } finally { reader.releaseLock(); }
}

export function createVirtualMessageEndpoint({ codec, handleEvent, alert = () => {} }) {
  return async request => {
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };
    const json = (body, status) => Response.json(body, { status, headers });
    let authenticated = false;
    try {
      if (!['GET', 'POST'].includes(request.method)) return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET, POST' } });
      const params = new URL(request.url).searchParams;
      if (Array.from(params.keys()).some(key => params.getAll(key).length !== 1)) throw new Error('XPAY_MESSAGE_INVALID');
      const query = Object.fromEntries(params); const current = codec();
      if (request.method === 'GET') return new Response(current.verifyUrl(query), { headers: { ...headers, 'Content-Type': 'text/plain; charset=utf-8' } });
      const message = current.decode(await readMessageJson(request), query);
      authenticated = true;
      // This event is the official connectivity probe; it must never grant rights.
      if (message?.Event === 'debug_demo') return new Response('success', { headers });
      if (!handleEvent) throw new Error('XPAY_NOT_READY');
      const reply = await handleEvent(message, query);
      return reply === undefined ? new Response('success', { headers }) : json(reply, 200);
    } catch (error) {
      const code = /^XPAY_[A-Z_]+$/.test(error?.message) ? error.message : 'XPAY_UNCONFIRMED';
      // An authenticated business event is never acknowledged before it commits.
      const status = authenticated ? 503 : code === 'XPAY_MESSAGE_TOO_LARGE' ? 413
        : authenticationErrors.has(code) ? 401 : ['XPAY_MESSAGE_INVALID', 'XPAY_MESSAGE_PADDING'].includes(code) ? 400 : 503;
      try { alert('virtual_payment.callback_error', { code, authenticated }); } catch { /* Logging must not change acknowledgement. */ }
      return json({ code }, status);
    }
  };
}
