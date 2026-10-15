// Integration has no environment/file side effects; the server supplies the logger.
import crypto from 'node:crypto';

const EVENTS = new Map([
  ['POST /api/auth/device/challenge', 'device.challenge'],
  ['POST /api/auth/device/verify', 'device.verify'],
  ['POST /api/account/login/phone/challenge', 'phone.challenge'],
  ['POST /api/account/login/phone/verify', 'phone.verify'],
  ['POST /api/account/login/logout', 'account.logout'],
  ['POST /api/auth/logout', 'account.logout'],
  ['DELETE /api/account', 'account.deleted'],
]);

export function createAccountOperationsMiddleware({ log, enabled = false, ready = () => true }) {
  return async (c, next) => {
    if (!enabled || !c.req.path.startsWith('/api/')) return next();
    const event = EVENTS.get(`${c.req.method} ${c.req.path}`);
    const id = `req_${crypto.randomUUID()}`;
    c.set('accountSecurityRequestId', id);
    const unavailable = () => c.json({ code: 'ACCOUNT_OPERATIONS_UNAVAILABLE', message: '账号服务暂不可用，请稍后重试' }, 503);
    const record = async entry => {
      const result = await log.record({ ...entry, requestId: id });
      if (result?.ok === false || !log.health().healthy) throw new Error('SECURITY_LOG_UNAVAILABLE');
    };
    if (event) {
      // No token, request body, user-supplied header, query or raw error reaches the logger.
      try { if (!ready()) return unavailable(); await record({ event, result: 'attempt' }); } catch { return unavailable(); }
    }
    try { await next(); }
    catch {
      try { await record({ event: event || 'request.denied', result: 'failed', reason: 'unavailable', statusCode: 500 }); } catch { /* fail closed below */ }
      return unavailable();
    }
    const status = c.res.status;
    if (!event && status < 400) return;
    const result = status === 429 ? 'rate_limited' : status >= 500 ? 'failed' : status >= 400 ? 'denied' : 'success';
    try {
      await record({ event: event || (status === 429 ? 'request.rate_limited' : 'request.denied'), result,
        reason: status === 429 ? 'rate_limit' : status >= 500 ? 'unavailable' : status >= 400 ? 'invalid_request' : 'none',
        statusCode: status, accountId: c.get('auth')?.userId, deviceId: c.get('auth')?.deviceId });
    } catch { return unavailable(); }
  };
}
