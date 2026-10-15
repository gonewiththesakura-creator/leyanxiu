import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Credential check only. No order, refund, database write, or token persistence.
// Never print an upstream response: errors can contain credentials or tokens.
const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let phase = 'local-config';
try {
  const env = dotenv.parse(fs.readFileSync(path.join(server, '.env.mini-payment')));
  if (env.WECHAT_APP_ID !== 'REDACTED_APP_IDENTIFIER' || env.XPAY_OFFER_ID !== '1450662722'
    || env.XPAY_ENV !== '1' || env.XPAY_MODE !== 'closed' || env.XPAY_ENABLED !== 'false') throw new Error('config mismatch');
  if (!env.WECHAT_APP_SECRET?.trim() || !env.XPAY_SANDBOX_APP_KEY?.trim()) throw new Error('missing credentials');
  phase = 'wechat-stable-token';
  const response = await fetch('https://api.weixin.qq.com/cgi-bin/stable_token', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ grant_type: 'client_credential', appid: env.WECHAT_APP_ID, secret: env.WECHAT_APP_SECRET, force_refresh: false }),
  });
  if (!response.ok) {
    console.log(JSON.stringify({ appSecretVerified: false, phase, httpStatus: response.status, sandboxKeyPresent: true, sandboxKeyVerified: false }));
    process.exitCode = 1;
  } else {
    const data = await response.json();
    const verified = typeof data.access_token === 'string' && data.access_token.length > 0
      && Number.isFinite(data.expires_in) && data.expires_in >= 120 && (!data.errcode || data.errcode === 0);
    const providerCode = Number.isInteger(data.errcode) ? data.errcode : null;
    console.log(JSON.stringify({ appSecretVerified: verified, providerCode, sandboxKeyPresent: true, sandboxKeyVerified: false,
      tokenPersisted: false, forceRefresh: false, paymentRequested: false, salesEnabled: false }));
    if (!verified) process.exitCode = 1;
  }
} catch {
  console.error(JSON.stringify({ code: 'XPAY_CREDENTIAL_CHECK_UNCONFIRMED', phase, secretsLogged: false }));
  process.exitCode = 1;
}
