// Keep this middleware ahead of every route, including registered admin/payment
// routes. An allowlist ensures new endpoints stay closed during account testing.
export const ACCOUNT_ONLY_MESSAGE = '当前仅开放账号测试，创作和购买暂未开放';

const READ_PATHS = new Set([
  '/', '/health', '/api/readiness', '/api/catalog', '/api/capabilities',
  '/api/features', '/api/public/compliance', '/api/auth/me',
  '/api/account/entitlements', '/api/account/login-status',
  '/api/account/payment-identity', '/api/consents',
  '/app/legal/terms.html', '/app/legal/privacy.html',
  '/api/internal/account-operations',
]);
const WRITE_PATHS = new Set([
  'POST /api/auth/device/challenge', 'POST /api/auth/device/verify',
  'POST /api/auth/logout', 'POST /api/account/login/phone/challenge',
  'POST /api/account/login/phone/verify', 'POST /api/account/login/logout',
  'POST /api/consents', 'POST /api/consents/basic/withdraw',
  'DELETE /api/account',
]);
const PUBLIC_ASSET = /^\/(?:assets|plays|templates|avatars|effects|banners)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_.-]+\.(?:js|css|woff2?|png|jpe?g|webp|svg|ico|mp4|webm|mp3|m4a|ogg)$/;

export function accountOnlyRequestAllowed(method, pathname) {
  // Do not decode or normalize potentially ambiguous paths into allowed paths.
  if (/[\\%]/.test(pathname) || pathname.includes('..')) return false;
  if (method === 'GET' || method === 'HEAD') return READ_PATHS.has(pathname) || PUBLIC_ASSET.test(pathname);
  return WRITE_PATHS.has(`${method} ${pathname}`);
}

export function accountOnlyMiddleware({ enabled = process.env.APP_ACCOUNT_ONLY === 'true' } = {}) {
  return async (c, next) => {
    if (!enabled) return next();
    const method = c.req.method === 'OPTIONS' ? c.req.header('access-control-request-method') : c.req.method;
    if (accountOnlyRequestAllowed(method, c.req.path)) return next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    return c.json({ code: 'APP_ACCOUNT_ONLY', message: ACCOUNT_ONLY_MESSAGE }, 403);
  };
}
