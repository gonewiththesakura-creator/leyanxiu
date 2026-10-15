import http from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { createMessageCodec } from './wechat.js';
import { createVirtualMessageEndpoint, virtualMessagePath } from './message-endpoint.js';
import { createCloudVerificationEndpoint, cloudMessagePath } from './cloud-message-endpoint.js';

// A stateless onboarding receiver. It cannot sell, deliver, refund, or store orders.
// Replace it with the full payment service at the same URL before payment testing.
export function createCallbackServer({ env = process.env, alert = () => {} } = {}) {
  if (env.XPAY_ENABLED === 'true' || (env.XPAY_MODE && env.XPAY_MODE !== 'closed')) throw new Error('XPAY_CALLBACK_REQUIRES_CLOSED_SALES');
  const codec = createMessageCodec({ appId: env.WECHAT_APP_ID, token: env.XPAY_MESSAGE_TOKEN, aesKey: env.XPAY_MESSAGE_AES_KEY });
  const endpoint = createVirtualMessageEndpoint({ codec: () => codec, alert });
  const cloudEndpoint = createCloudVerificationEndpoint({ appId: env.WECHAT_APP_ID, alert });
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true, service: 'mini-payment-callback', mode: 'verification-only', salesEnabled: false, businessEventsReady: false, cloudPushPath: cloudMessagePath })); return;
      }
      if (![virtualMessagePath, cloudMessagePath].includes(url.pathname)) { res.writeHead(404); res.end(); return; }
      const request = new Request(url, { method: req.method, headers: req.headers,
        ...(!['GET', 'HEAD'].includes(req.method) ? { body: Readable.toWeb(req), duplex: 'half' } : {}) });
      const response = await (url.pathname === cloudMessagePath ? cloudEndpoint : endpoint)(request);
      const responseHeaders = Object.fromEntries(response.headers);
      // Do not reuse sockets with an unread body after an early authentication
      // or size rejection. Draining an unbounded attacker body is unnecessary.
      if (request.body && !req.readableEnded) responseHeaders.Connection = 'close';
      res.writeHead(response.status, responseHeaders);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      if (!res.headersSent) res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"code":"XPAY_MESSAGE_INVALID"}');
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
  server.setTimeout(15000, socket => socket.destroy());
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const port = Number(process.env.PORT || 3000);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('XPAY_CALLBACK_PORT_INVALID');
    const server = createCallbackServer({ alert: (event, details) => console.error(JSON.stringify({ event, ...details })) });
    server.on('error', () => { console.error('XPAY_CALLBACK_LISTEN_FAILED'); process.exitCode = 1; });
    server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'mini-payment-callback', port, mode: 'verification-only' })));
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { server.close(); server.closeIdleConnections(); });
  } catch { console.error('XPAY_CALLBACK_STARTUP_CONFIG_REQUIRED'); process.exitCode = 1; }
}
