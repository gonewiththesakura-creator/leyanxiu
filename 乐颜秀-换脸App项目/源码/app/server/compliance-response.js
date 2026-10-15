// Keep read-only recovery diagnostics available without exposing uncommitted
// account state. Route authentication/authorization remains in each handler.
export function registerCompliancePersistenceMiddleware(app, { readiness, flush }) {
  app.use('/api/*', async (c, next) => {
    const diagnostic = ['GET', 'HEAD'].includes(c.req.method) && (
      c.req.path.startsWith('/api/admin/') ||
      ['/api/catalog', '/api/readiness', '/api/features', '/api/capabilities', '/api/public/compliance'].includes(c.req.path)
    );
    const unavailable = () => c.json({ code: 'COMPLIANCE_PERSISTENCE_UNAVAILABLE', message: '账户数据保存异常，请稍后重试' }, 503);
    if (!readiness().ready && !diagnostic) return unavailable();
    await next();
    if (diagnostic) return;
    try { await flush(); }
    catch {
      c.header('Set-Cookie', undefined);
      c.res = unavailable();
    }
  });
}
