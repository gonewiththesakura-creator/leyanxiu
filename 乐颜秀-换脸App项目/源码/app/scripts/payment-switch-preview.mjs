// Isolated UI fixture: fake accounts, in-memory orders and a simulated native
// payment plugin. Never imports server config, credentials or a payment SDK.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const products = [{ id: 'fixture-pack', name: '次数包（本地示例）', amountFen: 990, credits: 10, type: 'credits' },
  { id: 'fixture-month', name: '30 天套餐（本地示例）', amountFen: 4990, credits: 60, type: 'monthly', durationDays: 30 }];
const orders = [], requests = [];
let server;
async function middleware(req, res, next) {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    return res.end(await server.transformIndexHtml(req.url, '<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"/><title>账号切换与待确认订单本地验证</title></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/payment-switch.tsx"></script></body></html>'));
  }
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/fixture/metrics') return next();
  const owner = req.headers.authorization === 'Bearer fixture-B' ? 'fixture-B' : 'fixture-A';
  const chunks = []; for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  let data, code = 0;
  requests.push({ path: url.pathname, owner, method: req.method });
  if (url.pathname === '/fixture/metrics') data = { requests, orders };
  else if (url.pathname === '/api/auth/session') data = { token: 'fixture-A' };
  else if (url.pathname === '/api/products') data = { available: true, mode: 'live', products };
  else if (url.pathname === '/api/account/payment-identity') data = { userId: owner, available: false, bound: true, maskedPhone: owner === 'fixture-A' ? '138****0001' : '138****0002', loginEnabled: true, loggedIn: true };
  else if (url.pathname === '/api/refunds') data = [];
  else if (url.pathname === '/api/account/entitlements') data = { totalRemaining: 0 };
  else if (url.pathname === '/api/orders' && req.method === 'GET') data = orders.filter(order => order.owner === owner);
  else if (url.pathname === '/api/orders' && req.method === 'POST') {
    const product = products.find(item => item.id === body.productId);
    let order = orders.find(item => item.owner === owner && item.key === body.idempotencyKey);
    if (!order) {
      order = { id: `${owner}-order-${orders.length + 1}`, owner, key: body.idempotencyKey, productId: product.id, productSnapshot: product, amountFen: product.amountFen, credits: product.credits, status: 'pending', createdAt: new Date().toISOString() };
      orders.push(order);
    }
    data = { order, paymentRequired: true, payment: { fixtureOnly: true } };
  } else if (url.pathname.startsWith('/api/orders/')) {
    const id = url.pathname.split('/')[3];
    const order = orders.find(item => item.id === id && item.owner === owner);
    if (!order) { code = 'FIXTURE_FOREIGN_ORDER'; res.statusCode = 404; }
    else if (url.pathname.endsWith('/close')) { order.status = 'closed'; data = { order }; }
    else data = order;
  } else { code = 'FIXTURE_UNSUPPORTED'; res.statusCode = 404; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ code, data }));
}
server = await createServer({ root, configFile: false, envFile: false, plugins: [react(), { name: 'switch-fixture', configureServer(instance) { instance.middlewares.use(middleware); } }],
  resolve: { alias: [{ find: /^@\/lib\/payments$/, replacement: path.join(root, 'scripts/fixtures/payment-native.ts') }, { find: '@', replacement: path.join(root, 'src') }] },
  define: { 'import.meta.env.VITE_API_BASE': '""', 'import.meta.env.VITE_USE_MOCK': '"false"', 'import.meta.env.VITE_APP_ACCOUNT_ONLY': '"false"', 'import.meta.env.VITE_CLOSED_TEST_INVITE_REQUIRED': '"false"' },
  server: { host: '127.0.0.1', port: 5199, strictPort: true } });
await server.listen();
console.log('Isolated payment switch UI: http://127.0.0.1:5199/ (no real payment, SMS or user data)');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await server.close(); process.exit(0); });
