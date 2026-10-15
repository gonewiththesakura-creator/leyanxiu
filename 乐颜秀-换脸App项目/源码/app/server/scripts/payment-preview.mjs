// Isolated, local-only UI acceptance fixture. Never uses merchant credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lyx-payment-preview-'));
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: path.join(root, 'no-env'), START_SERVER: 'false', NODE_ENV: 'test', DEPLOY_ENV: 'test',
  COMPLIANCE_BACKEND: 'sqlite', COMPLIANCE_SQLITE_FILE: path.join(root, 'ledger.db'),
  ADMIN_STORE_FILE: path.join(root, 'admin.json'), ADMIN_WORKFLOW_STORE_FILE: path.join(root, 'workflow.json'),
  TASKS_BACKEND: 'file', TASKS_FILE: path.join(root, 'tasks.json'), PRIVATE_OBJECT_DIR: path.join(root, 'objects'), OBJECT_INDEX_FILE: path.join(root, 'objects.json'),
  OBJECT_SIGNING_SECRET: 'local-preview-signing-secret-32-characters', AUTH_SESSION_SECRET: 'local-preview-auth-secret-32-characters',
  ADMIN_ALLOW_INSECURE_LOCAL: 'true', ADMIN_USERNAME: 'payment-preview', ADMIN_PASSWORD: 'Local-preview-only-2026', ADMIN_COOKIE_SECURE: 'false',
  PAYMENT_MODE: 'closed_test', PAYMENT_PROVIDER: '', WECHAT_PAY_PRIVATE_KEY_FILE: '', WECHAT_PAY_PLATFORM_KEYS_FILE: '',
  METRICS_BACKEND: 'memory', ADMIN_SNAPSHOT_BACKEND: 'file', PROVIDER: 'unconfigured', CLOSED_TEST_MODE: 'false',
  PUBLIC_BASE_URL: 'http://127.0.0.1:3199',
});
const { app } = await import('../index.js');
serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 19878 });
console.log('Isolated payment UI fixture: http://127.0.0.1:19878/admin (no real payments)');
