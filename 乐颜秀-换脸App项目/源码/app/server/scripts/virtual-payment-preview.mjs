// Local synthetic UI fixture only. Never imports .env or contacts WeChat / AI providers.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { openVirtualDatabase } from '../payments/virtual/database.js';
import { createVirtualLedger } from '../payments/virtual/ledger.js';
import { draftProducts } from '../payments/virtual/products.js';
import { registerVirtualPaymentRoutes } from '../payments/virtual/routes.js';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-mini-ui-'));
const database = await openVirtualDatabase({ backend: 'sqlite', filename: path.join(directory, 'preview.sqlite'), migrate: true });
const ledger = createVirtualLedger({ database, encryptionKey: crypto.randomBytes(32).toString('hex') });
await ledger.bindEnvironment('local-ui-fixture', 1);
await ledger.bindSession({ userId: 'preview-user', sessionId: 'preview-session', appId: 'local-ui-fixture', openid: 'preview-openid', sessionKey: Buffer.alloc(16, 1).toString('base64') });
for (const product of draftProducts) {
  const order = await ledger.createOrder({ userId: 'preview-user', product, appId: 'local-ui-fixture', env: 1, platform: 'android', idempotencyKey: crypto.randomUUID() });
  await ledger.settle(order.id, { order_id: order.id, wx_order_id: `fixture-${order.id}`, env_type: 2, order_fee: order.amountFen, paid_fee: order.amountFen,
    left_fee: order.amountFen, order_type: 0, status: 2, paid_time: Math.floor(Date.now() / 1000) });
  if (product.id === 'video5') await ledger.requestRefund(order.id, 'preview-user', '本地界面验收样例，不是真实订单');
}
const app = new Hono();
app.get('/api/admin/me', c => c.json({ code: 0, data: { csrfToken: 'fixture-csrf' } }));
registerVirtualPaymentRoutes(app, { ledger, adapter: () => { throw new Error('XPAY_PREVIEW_NO_NETWORK'); }, codec: () => null,
  authenticated: () => ({ auth: { userId: 'preview-user', sessionId: 'preview-session', authMethod: 'wechat' } }),
  requireAdmin: (c, { csrf }) => csrf && c.req.header('x-csrf-token') !== 'fixture-csrf' ? { response: c.json({}, 403) } : { session: { username: 'preview-admin' } },
  readiness: async () => ({ ready: false, operationsReady: false, mode: 'closed', blockers: ['本地界面验收 · 全部为模拟数据 · 不连接支付渠道'] }), products: () => draftProducts });
const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 }, info => console.log(`LOCAL_PREVIEW http://127.0.0.1:${info.port}/admin/mini-payments`));
let stopping = false;
async function close() {
  if (stopping) return; stopping = true; server.close(); await database.close();
  fs.rmSync(directory, { recursive: true, force: true }); process.exit(0);
}
process.on('SIGINT', close); process.on('SIGTERM', close);
