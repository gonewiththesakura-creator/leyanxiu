import { Hono } from 'hono';
import { readMessageJson } from './message-endpoint.js';
import { registerVirtualPaymentRoutes } from './routes.js';
import { cloudMessagePath } from './cloud-message-endpoint.js';
import { createCloudBusinessEndpoint } from './cloud-business-endpoint.js';

// Never log a fetch error/message/URL: it may contain AppSecret or the login code.
// Node fetch wraps TLS and socket failures in `cause`; retain only known enums.
const loginTransportCodes = new Map([
  ...['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID'].map(code => [code, 'tls_certificate']),
  ...['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT']
    .map(code => [code, 'timeout']),
  ...['ENOTFOUND', 'EAI_AGAIN'].map(code => [code, 'dns']),
  ...['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH'].map(code => [code, 'connection']),
]);
function loginTransportFailure(error) {
  for (let current = error, depth = 0; current && depth < 3; current = current.cause, depth++) {
    if (loginTransportCodes.has(current.code)) {
      return { reason: loginTransportCodes.get(current.code), transportCode: current.code };
    }
    if (current.name === 'TimeoutError' || current.name === 'AbortError') return { reason: 'timeout' };
  }
  return { reason: 'transport' };
}

// Shared transport only. Wrappers own the environment, sales gate, identity
// construction and privileged refund policy. No listener, migration or timer.
export function createMiniPaymentService({ ledger, identity, adapter, codec, appSecret,
  products, readiness, requireAdmin, beforeRequest = async () => {},
  errorEvent = 'virtual_payment.service_error', fetchImpl = fetch, alert = () => {}, now = Date.now }) {
  if (!ledger?.database || !identity?.authenticateBearer || !adapter?.appId || !appSecret
    || !Array.isArray(products) || typeof readiness !== 'function' || typeof requireAdmin !== 'function'
    || typeof beforeRequest !== 'function') throw new Error('XPAY_SERVICE_CONFIG_REQUIRED');
  const appId = adapter.appId;
  const app = new Hono();
  const safeAlert = (event, detail) => { try { alert(event, detail); } catch {} };
  app.use('*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await beforeRequest(c);
    await next();
  });
  app.use('/api/*', async (c, next) => {
    if (!['GET', 'HEAD'].includes(c.req.method) && (c.req.raw.body || c.req.header('content-length'))) {
      // Count actual streamed bytes, including a forged small Content-Length.
      // Rebuild the bounded JSON request before any handler can buffer it.
      const body = await readMessageJson(c.req.raw);
      const headers = new Headers(c.req.raw.headers); headers.delete('content-length');
      c.req.raw = new Request(c.req.raw.url, { method: c.req.method, headers, body: JSON.stringify(body) });
    }
    await next();
  });
  app.onError((error, c) => {
    const code = /^XPAY_[A-Z_]+$/.test(error?.message) ? error.message : 'XPAY_SERVICE_UNCONFIRMED';
    safeAlert(errorEvent, { code });
    const status = code === 'XPAY_MESSAGE_TOO_LARGE' ? 413 : code === 'XPAY_MESSAGE_INVALID' ? 400 : 503;
    return c.json({ code, message: '服务尚未确认，请稍后刷新' }, status);
  });
  let loginInFlight = 0;
  // Bounded per-process budget; do not trust caller-selected IP headers.
  // Production admission control across replicas remains a separate gate.
  let loginWindowAt = now(); let loginRequests = 0;
  app.post('/api/auth/wechat', async c => {
    const at = now();
    if (at - loginWindowAt >= 60000) { loginWindowAt = at; loginRequests = 0; }
    if (loginRequests >= 20) {
      c.header('Retry-After', '60');
      return c.json({ code: 'XPAY_LOGIN_RATE_LIMITED', message: '登录请求较多，请稍后重试' }, 429);
    }
    loginRequests++;
    const body = await readMessageJson(c.req.raw);
    if (!body || typeof body.code !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(body.code)) {
      return c.json({ code: 'XPAY_LOGIN_CODE_REQUIRED' }, 400);
    }
    if (loginInFlight >= 8) return c.json({ code: 'XPAY_LOGIN_BUSY' }, 503);
    loginInFlight++;
    try {
      // Only the official code exchange supplies identity. Never accept openid,
      // AppID, userId or session_key from the client or its request headers.
      const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
      url.search = new URLSearchParams({ appid: appId, secret: appSecret,
        js_code: body.code, grant_type: 'authorization_code' }).toString();
      let response;
      try { response = await fetchImpl(url.toString(), { redirect: 'error', signal: AbortSignal.timeout(10000) }); }
      catch (error) {
        safeAlert('virtual_payment.login_upstream_unconfirmed', loginTransportFailure(error));
        throw new Error('XPAY_LOGIN_UNCONFIRMED');
      }
      if (!response.ok) {
        safeAlert('virtual_payment.login_upstream_unconfirmed', { reason: 'http',
          status: Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : 0 });
        throw new Error('XPAY_LOGIN_UNCONFIRMED');
      }
      const verified = await response.json().catch(() => null);
      if (!verified || (verified.errcode && verified.errcode !== 0)
        || typeof verified.openid !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(verified.openid)
        || typeof verified.session_key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(verified.session_key)
        || Buffer.from(verified.session_key, 'base64').length !== 16) {
        return c.json({ code: 'XPAY_LOGIN_REJECTED', message: '微信登录未通过，请重新登录' }, 401);
      }
      const session = await identity.createLogin({ openid: verified.openid, sessionKey: verified.session_key });
      return c.json({ code: 0, data: session });
    } finally { loginInFlight--; }
  });
  const hydrate = async (c, next) => {
    c.set('miniAuth', await identity.authenticateBearer(c.req.header('authorization')));
    await next();
  };
  app.use('/api/mini/payments/*', hydrate);
  app.use('/api/account/*', hydrate);
  app.use('/api/auth/logout', hydrate);
  const authenticated = c => {
    const auth = c.get('miniAuth');
    return auth ? { auth } : { response: c.json({ code: 'AUTH_SESSION_EXPIRED', message: '请重新登录' }, 401) };
  };
  app.post('/api/auth/logout', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    await identity.logout(c.req.header('authorization'));
    return c.json({ code: 0, data: { loggedOut: true } });
  });
  app.get('/api/account/entitlements', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    return c.json({ code: 0, data: await ledger.entitlements(auth.auth.userId) });
  });
  app.post('/api/account/restore-purchases', async c => {
    const auth = authenticated(c); if (auth.response) return auth.response;
    return c.json({ code: 0, data: { entitlements: await ledger.entitlements(auth.auth.userId) } });
  });
  const payments = registerVirtualPaymentRoutes(app, { ledger, identity, adapter: () => adapter, codec: () => codec,
    authenticated, products: () => products, readiness, alert: safeAlert, requireAdmin });
  // Only authoritative channel queries can change state on this cloud path.
  const cloudCallback = createCloudBusinessEndpoint({ appId, ledger, adapter, readiness, alert: safeAlert });
  app.all(cloudMessagePath, c => cloudCallback(c.req.raw));
  return { app, payments, readiness, authenticated };
}
