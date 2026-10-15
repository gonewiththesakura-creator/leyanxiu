import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('Supply a new absolute output directory');
// Deliberate allowlist: no .env, App bootstrap, state, user media or secrets.
const files = {
  'deploy/mini-payment-sandbox/Dockerfile': 'Dockerfile',
  'deploy/mini-payment-sandbox/package.json': 'package.json',
  'deploy/mini-payment-sandbox/package-lock.json': 'package-lock.json',
  'deploy/mini-payment-sandbox/README.md': 'README.md',
  'deploy/mini-payment/mini-identity-schema-v1.sql': 'migration/mini-identity-schema-v1.sql',
};
for (const name of ['database.js', 'ledger.js', 'reservation-transactions.js', 'wechat.js', 'runtime.js', 'mysql-transport.js', 'products.js', 'routes.js',
  'reconciliation.js', 'message-endpoint.js', 'cloud-message-endpoint.js', 'cloud-business-endpoint.js', 'mini-identity.js',
  'mini-sandbox-service.js', 'mini-sandbox-server.js', 'admin.html', 'admin.js']) {
  files['payments/virtual/' + name] = 'payments/virtual/' + name;
}
// Read every input before creating a partial directory on a missing input.
const inputs = Object.entries(files).map(([source, destination]) => ({ destination, bytes: fs.readFileSync(path.join(server, source)) }));
const manifest = [];
for (const { destination, bytes } of inputs) {
  const target = path.join(output, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes, { flag: 'wx' });
  manifest.push({ path: destination, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
// env=1 restricts the payment environment; it does not guarantee fictitious funds.
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ version: 2, scope: 'sandbox-only',
  env: 1, productionPaymentsEnabled: false, sandboxMayCharge: true, files: manifest }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, manifestVersion: 2, scope: 'sandbox-only', files: manifest.length,
  includesPrivateConfig: false, deployed: false, env: 1, productionPaymentsEnabled: false, sandboxMayCharge: true }));
