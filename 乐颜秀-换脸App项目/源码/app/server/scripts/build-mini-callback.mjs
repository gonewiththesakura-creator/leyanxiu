import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = process.argv[2];
if (!output || !path.isAbsolute(output) || fs.existsSync(output)) throw new Error('Supply a new absolute output directory');
// Explicit allowlist: no .env, credentials, business state, web bundle, or native dependencies.
const files = {
  'deploy/mini-callback/Dockerfile': 'Dockerfile',
  'deploy/mini-callback/package.json': 'package.json',
  'deploy/mini-callback/README.md': 'README.md',
  'payments/virtual/callback-server.js': 'payments/virtual/callback-server.js',
  'payments/virtual/message-endpoint.js': 'payments/virtual/message-endpoint.js',
  'payments/virtual/cloud-message-endpoint.js': 'payments/virtual/cloud-message-endpoint.js',
  'payments/virtual/wechat.js': 'payments/virtual/wechat.js',
};
const manifest = [];
for (const [source, destination] of Object.entries(files)) {
  const bytes = fs.readFileSync(path.join(server, source)); const target = path.join(output, destination);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes, { flag: 'wx' });
  manifest.push({ path: destination, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
}
fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({ mode: 'verification-only', files: manifest }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ output, files: manifest.length, mode: 'verification-only', containsSecrets: false }));
