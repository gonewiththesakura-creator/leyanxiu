import { serve } from '@hono/node-server';
import { virtualRuntime, virtualProducts } from './runtime.js';
import { createMiniIdentity } from './mini-identity.js';
import { createMiniSandboxService, miniSandboxConfig } from './mini-sandbox-service.js';

// Intentionally does not load .env, the old bootstrap or App compliance data.
// Host-supplied configuration must explicitly select this isolated sandbox.
let runtime;
let timer; let sweeping; let stopping = false;
try {
  const config = miniSandboxConfig(process.env);
  runtime = await virtualRuntime({ allowCloudrunPrivateSandbox: true });
  await runtime.ledger.database.transaction(q => q('SELECT id FROM vp_auth_sessions LIMIT 1'));
  const identity = createMiniIdentity({ database: runtime.ledger.database, appId: runtime.adapter.appId,
    bindSession: input => runtime.ledger.bindSession(input) });
  const { app, payments } = createMiniSandboxService({ ...config, ...runtime, identity,
    appSecret: process.env.WECHAT_APP_SECRET, products: virtualProducts(),
    alert: (event, detail) => console.error(JSON.stringify({ event, ...detail })) });
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('XPAY_SANDBOX_PORT_INVALID');
  const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' });
  server.on('error', () => { console.error('XPAY_SANDBOX_LISTEN_FAILED'); process.exitCode = 1; });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.setTimeout(15000, socket => socket.destroy());
  if (process.env.XPAY_RECONCILE_ENABLED === 'true') {
    timer = setInterval(() => {
      if (stopping || sweeping) return;
      sweeping = payments.reconcile().catch(() => {
        console.error('XPAY_SANDBOX_RECONCILIATION_UNCONFIRMED');
      }).finally(() => { sweeping = null; });
    }, 30000);
  }
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    stopping = true; clearInterval(timer);
    server.close(async () => {
      await sweeping;
      await runtime.ledger.database.close().catch(() => { process.exitCode = 1; });
    });
    server.closeIdleConnections();
  });
  console.log(JSON.stringify({ service: 'mini-payment-sandbox', mode: process.env.XPAY_MODE,
    env: 1, productionPaymentsEnabled: false, sandboxMayCharge: true,
    databaseTransport: process.env.XPAY_MYSQL_TRANSPORT || 'tls' }));
} catch (error) {
  stopping = true; clearInterval(timer);
  await runtime?.ledger.database.close().catch(() => {});
  console.error(/^XPAY_[A-Z_]+$/.test(error?.message) ? error.message : 'XPAY_SANDBOX_STARTUP_UNCONFIRMED');
  process.exitCode = 1;
}
