import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { createMessageCodec } from '../payments/virtual/wechat.js';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const file = path.join(server, '.env.mini-callback');
const appId = 'REDACTED_APP_IDENTIFIER';
try {
  if (fs.existsSync(file)) {
    const saved = dotenv.parse(fs.readFileSync(file));
    if (saved.WECHAT_APP_ID !== appId || saved.XPAY_MODE !== 'closed' || saved.XPAY_ENABLED !== 'false') throw new Error('config mismatch');
    createMessageCodec({ appId, token: saved.XPAY_MESSAGE_TOKEN, aesKey: saved.XPAY_MESSAGE_AES_KEY });
    console.log(JSON.stringify({ file, status: 'existing keys preserved', mode: 'verification-only' }));
  } else {
    const descriptor = fs.openSync(file, 'wx', 0o600);
    try {
      // Lock down the initially empty file before any key material is written.
      if (process.platform === 'win32') {
        const identity = execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
        const sid = identity.match(/S-1-5-(?:\d+-)*\d+/)?.[0];
        if (!sid) throw new Error('identity unavailable');
        execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:(F)`, '*S-1-5-18:(F)'], { stdio: 'pipe', windowsHide: true });
      }
      const values = {
        WECHAT_APP_ID: appId, XPAY_OFFER_ID: '1450662722', XPAY_MODE: 'closed', XPAY_ENABLED: 'false',
        XPAY_MESSAGE_TOKEN: crypto.randomBytes(16).toString('hex'),
        XPAY_MESSAGE_AES_KEY: crypto.randomBytes(32).toString('base64').slice(0, -1),
      };
      fs.writeFileSync(descriptor, Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
    console.log(JSON.stringify({ file, status: 'created with private permissions', mode: 'verification-only' }));
  }
} catch {
  // Never log parse errors, environment values, or the contents of the file.
  console.error('XPAY_CALLBACK_CONFIG_PREPARATION_FAILED: existing files are never overwritten'); process.exitCode = 1;
}
