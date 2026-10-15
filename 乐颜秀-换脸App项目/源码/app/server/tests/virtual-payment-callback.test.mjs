import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Hono } from 'hono';
import { createMessageCodec } from '../payments/virtual/wechat.js';
import { createCallbackServer } from '../payments/virtual/callback-server.js';
import { createVirtualMessageEndpoint, virtualMessagePath } from '../payments/virtual/message-endpoint.js';
import { registerVirtualPaymentRoutes } from '../payments/virtual/routes.js';
import { cloudMessagePath } from '../payments/virtual/cloud-message-endpoint.js';

const env = { WECHAT_APP_ID: 'wx-callback-test', XPAY_MESSAGE_TOKEN: 'test-callback-token', XPAY_MESSAGE_AES_KEY: Buffer.alloc(32, 11).toString('base64').slice(0, -1), XPAY_MODE: 'closed', XPAY_ENABLED: 'false' };
const codec = createMessageCodec({ appId: env.WECHAT_APP_ID, token: env.XPAY_MESSAGE_TOKEN, aesKey: env.XPAY_MESSAGE_AES_KEY });
function verification(origin = 'http://localhost') {
  const url = new URL(virtualMessagePath, origin); const timestamp = String(Math.floor(Date.now() / 1000)); const nonce = 'test-nonce';
  url.search = new URLSearchParams({ timestamp, nonce, echostr: 'wechat-echo', signature: crypto.createHash('sha1').update([env.XPAY_MESSAGE_TOKEN, timestamp, nonce].sort().join('')).digest('hex') });
  return url;
}
function encrypted(event, origin = 'http://localhost', overrideCodec = codec) {
  const message = overrideCodec.encode({ Event: event, MsgType: 'event' }); const url = new URL(virtualMessagePath, origin);
  url.search = new URLSearchParams({ timestamp: String(message.TimeStamp), nonce: message.Nonce, msg_signature: message.MsgSignature, encrypt_type: 'aes' });
  return new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ Encrypt: message.Encrypt }) });
}

test('standalone HTTP callback verifies URL and encrypted debug while refusing every business event', async t => {
  const logs = []; const server = createCallbackServer({ env, alert: (event, details) => logs.push({ event, details }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${origin}/health`)).json();
  assert.equal(health.mode, 'verification-only'); assert.equal(health.businessEventsReady, false); assert.equal(health.salesEnabled, false);
  const valid = await fetch(verification(origin)); assert.equal(valid.status, 200); assert.equal(await valid.text(), 'wechat-echo');
  const invalid = verification(origin); invalid.searchParams.set('signature', '0'.repeat(40));
  assert.equal((await fetch(invalid)).status, 401);
  const debug = await fetch(encrypted('debug_demo', origin)); assert.equal(debug.status, 200); assert.equal(await debug.text(), 'success');
  for (const event of ['xpay_goods_deliver_notify', 'xpay_refund_notify', 'xpay_subscribe_ios_refund_query_notify', 'unknown']) {
    const result = await fetch(encrypted(event, origin)); assert.equal(result.status, 503); assert.equal((await result.json()).code, 'XPAY_NOT_READY');
  }
  assert.equal((await fetch(`${origin}/api/mini/payments/orders`, { method: 'POST' })).status, 404);
  assert.ok(!JSON.stringify(logs).includes(env.XPAY_MESSAGE_TOKEN)); assert.ok(!JSON.stringify(logs).includes('Encrypt'));
});

test('callback rejects bad config, tampering, wrong AppID, oversized streams and duplicate query arguments', async () => {
  assert.throws(() => createCallbackServer({ env: { ...env, XPAY_MODE: 'live' } }), /CLOSED_SALES/);
  assert.throws(() => createCallbackServer({ env: { ...env, XPAY_ENABLED: 'true' } }), /CLOSED_SALES/);
  assert.throws(() => createCallbackServer({ env: { ...env, XPAY_MESSAGE_AES_KEY: '' } }), /CONFIG/);
  const endpoint = createVirtualMessageEndpoint({ codec: () => codec });
  const wrong = createMessageCodec({ appId: 'wrong-app', token: env.XPAY_MESSAGE_TOKEN, aesKey: env.XPAY_MESSAGE_AES_KEY });
  assert.equal((await endpoint(encrypted('debug_demo', 'http://localhost', wrong))).status, 401);
  const tampered = encrypted('debug_demo'); const body = await tampered.json(); body.Encrypt = body.Encrypt.slice(1);
  assert.equal((await endpoint(new Request(tampered.url, { method: 'POST', body: JSON.stringify(body) }))).status, 401);
  const oversized = new Request('http://localhost' + virtualMessagePath, { method: 'POST', body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(131073)); c.close(); } }), duplex: 'half' });
  assert.equal((await endpoint(oversized)).status, 413);
  const url = verification(); url.searchParams.append('nonce', 'second');
  assert.equal((await endpoint(new Request(url))).status, 400);
  assert.equal((await endpoint(new Request('http://localhost' + virtualMessagePath, { method: 'DELETE' }))).status, 405);
});

test('full payment route verifies messages without DB, retries on DB outage and never acknowledges failed fulfillment', async () => {
  const app = new Hono(); let ready = false; let checks = 0; let events = 0;
  registerVirtualPaymentRoutes(app, {
    codec: () => codec, adapter: () => ({}), products: () => [],
    ledger: { order: async () => { events++; throw new Error('database connection lost'); } },
    readiness: async () => { checks++; return { operationsReady: ready, ready: false }; },
    authenticated: c => ({ response: c.json({}, 401) }), requireAdmin: c => ({ response: c.json({}, 403) }),
  });
  const echo = await app.request(new Request(verification())); assert.equal(echo.status, 200); assert.equal(await echo.text(), 'wechat-echo');
  assert.equal((await app.request(encrypted('debug_demo'))).status, 200); assert.equal(checks, 0);
  assert.equal((await app.request(encrypted('xpay_goods_deliver_notify'))).status, 503); assert.equal(events, 0);
  ready = true;
  assert.equal((await app.request(encrypted('xpay_goods_deliver_notify'))).status, 503); assert.equal(events, 1);
});

test('cloud HTTP receiver only acknowledges exact platform probe and keeps all business events retryable', async t => {
  const logs = []; const server = createCallbackServer({ env, alert: (event, details) => logs.push({ event, details }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, headers = { 'x-wx-sources': 'test-gateway' }) => fetch(origin + cloudMessagePath,
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  for (const sourceHeader of ['x-wx-sources', 'x-wx-source']) {
    const result = await post({ action: 'CheckContainerPath' }, { [sourceHeader]: 'test-gateway', 'x-wx-appid': env.WECHAT_APP_ID });
    assert.equal(result.status, 200); assert.equal(await result.text(), 'success');
  }
  assert.equal((await post({ action: 'CheckContainerPath' }, {})).status, 401);
  for (const appHeader of ['x-wx-appid', 'x-wx-from-appid']) {
    assert.equal((await post({ action: 'CheckContainerPath' }, { 'x-wx-source': 'test-gateway', [appHeader]: 'wrong-app' })).status, 401);
  }
  for (const event of ['debug_demo', 'xpay_goods_deliver_notify', 'xpay_refund_notify', 'unknown']) {
    const result = await post({ Event: event, action: 'CheckContainerPath', OpenId: 'private-user' });
    assert.equal(result.status, 503); assert.equal((await result.json()).code, 'XPAY_NOT_READY');
  }
  for (const body of [null, [], 'CheckContainerPath']) assert.equal((await post(body)).status, 400);
  assert.equal((await post({ padding: 'a'.repeat(131073) })).status, 413);
  const malformed = await fetch(origin + cloudMessagePath, { method: 'POST', headers: { 'x-wx-source': 'test-gateway' }, body: '{bad' });
  assert.equal(malformed.status, 400);
  assert.equal((await fetch(origin + cloudMessagePath)).status, 405);
  assert.equal((await fetch(origin + virtualMessagePath, { method: 'POST', body: JSON.stringify({ action: 'CheckContainerPath' }) })).status, 401);
  const health = await (await fetch(origin + '/health')).json();
  assert.equal(health.cloudPushPath, cloudMessagePath); assert.equal(health.salesEnabled, false);
  assert.ok(!JSON.stringify(logs).includes('private-user'));
});
