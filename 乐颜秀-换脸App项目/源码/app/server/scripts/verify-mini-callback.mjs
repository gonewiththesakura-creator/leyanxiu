import fs from 'node:fs';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { virtualMessagePath } from '../payments/virtual/message-endpoint.js';
import { cloudMessagePath } from '../payments/virtual/cloud-message-endpoint.js';

// Explicit arguments only: this command never auto-loads production .env.
const [originInput, envFile] = process.argv.slice(2);
let phase = 'config';
try {
  const origin = new URL(originInput);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('HTTPS origin required');
  if (envFile === '--private') {
    phase = 'private-access';
    const blocked = [];
    for (const route of ['/health', cloudMessagePath]) {
      const options = route === '/health' ? {} : { method: 'POST', headers: {
        'Content-Type': 'application/json', 'x-wx-source': 'forged-public-source', 'x-wx-sources': 'forged-public-source',
      }, body: JSON.stringify({ action: 'CheckContainerPath' }) };
      const response = await fetch(new URL(route, origin), { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
      await response.arrayBuffer();
      if (response.status !== 403) throw new Error('public access not closed');
      blocked.push({ route, status: response.status });
    }
    console.log(JSON.stringify({ checks: { publicAccessClosed: true }, blocked, wechatConsoleCheck: 'pending', paymentAccepted: false }));
    process.exit(0);
  }
  const env = dotenv.parse(fs.readFileSync(envFile));
  const codec = createMessageCodec({ appId: env.WECHAT_APP_ID, token: env.XPAY_MESSAGE_TOKEN, aesKey: env.XPAY_MESSAGE_AES_KEY });
  const call = (url, options = {}) => fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  phase = 'health';
  const health = await call(new URL('/health', origin)); const info = await health.json();
  if (!health.ok || info.service !== 'mini-payment-callback' || info.mode !== 'verification-only' || info.salesEnabled !== false || info.businessEventsReady !== false) throw new Error('wrong service');
  const url = new URL(virtualMessagePath, origin);
  const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = crypto.randomBytes(12).toString('hex');
  const echo = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHash('sha1').update([env.XPAY_MESSAGE_TOKEN, timestamp, nonce].sort().join('')).digest('hex');
  url.search = new URLSearchParams({ timestamp, nonce, signature, echostr: echo }).toString();
  phase = 'url-signature';
  const verified = await call(url);
  if (verified.status !== 200 || await verified.text() !== echo) throw new Error('verification failed');
  url.searchParams.set('signature', '0'.repeat(40));
  phase = 'bad-signature';
  if ((await call(url)).status !== 401) throw new Error('bad signature accepted');
  const probe = async event => {
    const body = codec.encode({ MsgType: 'event', Event: event }); const target = new URL(virtualMessagePath, origin);
    target.search = new URLSearchParams({ timestamp: String(body.TimeStamp), nonce: body.Nonce, msg_signature: body.MsgSignature, encrypt_type: 'aes' }).toString();
    return call(target, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Encrypt: body.Encrypt }) });
  };
  phase = 'encrypted-debug';
  const debug = await probe('debug_demo');
  if (debug.status !== 200 || await debug.text() !== 'success') throw new Error('encrypted probe failed');
  phase = 'unknown-event';
  if ((await probe('preflight_noop')).status !== 503) throw new Error('unhandled event acknowledged');
  phase = 'cloud-version';
  if (info.cloudPushPath !== cloudMessagePath) throw new Error('cloud push version not deployed');
  const cloudProbe = extra => call(new URL(cloudMessagePath, origin), {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...extra }, body: JSON.stringify({ action: 'CheckContainerPath' }),
  });
  phase = 'cloud-missing-source';
  if ((await cloudProbe({})).status !== 401) throw new Error('missing source accepted');
  phase = 'cloud-public-spoof';
  const forged = await cloudProbe({ 'x-wx-source': 'forged-public-source', 'x-wx-sources': 'forged-public-source', 'x-wx-appid': env.WECHAT_APP_ID });
  if (forged.status !== 401) throw new Error('public source header spoof not rejected');
  console.log(JSON.stringify({ origin: origin.origin, checks: { urlSignature: true, rejectsBadSignature: true, encryptedDebug: true, unknownEventRetries: true,
    cloudPushVersion: true, rejectsMissingCloudSource: true, rejectsPublicHeaderSpoof: true }, mode: 'verification-only', paymentAccepted: false, wechatConsoleCheck: 'pending' }));
} catch {
  console.error(JSON.stringify({ code: 'XPAY_CALLBACK_VERIFICATION_FAILED', phase })); process.exitCode = 1;
}
