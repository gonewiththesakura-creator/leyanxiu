import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { createAccountOperationsMiddleware } from '../accounts/operations.js';

test('a failed preflight log prevents the SMS side effect', async () => {
  let sent = 0;
  const app = new Hono();
  app.use('*', createAccountOperationsMiddleware({ enabled: true, log: { record: async () => { throw new Error('private-error'); }, health: () => ({ healthy: false }) } }));
  app.post('/api/account/login/phone/challenge', c => { sent++; return c.json({ ok: true }); });
  const result = await app.request('/api/account/login/phone/challenge', { method: 'POST' });
  assert.equal(result.status, 503); assert.equal(sent, 0);
  assert.ok(!(await result.text()).includes('private-error'));
});

test('an overdue cleanup job prevents new SMS before any side effect', async () => {
  let sent = 0;
  const app = new Hono();
  app.use('*', createAccountOperationsMiddleware({ enabled: true, ready: () => false, log: { record: async () => ({ ok: true }), health: () => ({ healthy: true }) } }));
  app.post('/api/account/login/phone/challenge', c => { sent++; return c.json({ ok: true }); });
  assert.equal((await app.request('/api/account/login/phone/challenge', { method: 'POST' })).status, 503);
  assert.equal(sent, 0);
});

test('outer CORS lets the Android WebView read fail-closed responses', async () => {
  const app = new Hono();
  app.use('*', cors({ origin: 'https://localhost' }));
  app.use('*', createAccountOperationsMiddleware({ enabled: true, ready: () => false }));
  app.post('/api/account/login/phone/challenge', c => c.json({ unexpected: true }));
  const result = await app.request('/api/account/login/phone/challenge', { method: 'POST', headers: { origin: 'https://localhost' } });
  assert.equal(result.status, 503);
  assert.equal(result.headers.get('access-control-allow-origin'), 'https://localhost');
});

test('account operations log fixed outcomes without body, query, token or forged request id', async () => {
  const records = [];
  const app = new Hono();
  app.use('*', createAccountOperationsMiddleware({ enabled: true, log: { record: async e => { records.push(e); return { ok: true }; }, health: () => ({ healthy: true }) } }));
  app.post('/api/account/login/phone/verify', c => c.json({ code: 'OTP_INVALID' }, 400));
  const result = await app.request('/api/account/login/phone/verify?code=secret', { method: 'POST', headers: { Authorization: 'Bearer private-token', 'x-request-id': 'caller-secret' }, body: '{"phone":"13800000000","code":"123456"}' });
  assert.equal(result.status, 400);
  assert.deepEqual(records.map(x => x.result), ['attempt', 'denied']);
  assert.equal(records[0].requestId, records[1].requestId);
  assert.match(records[0].requestId, /^req_[a-f0-9-]{36}$/);
  for (const value of ['secret', 'private-token', '13800000000', '123456']) assert.ok(!JSON.stringify(records).includes(value));
});

test('public reads work and rejected API paths are recorded without the attacker path', async () => {
  const records = [];
  const app = new Hono();
  app.use('*', createAccountOperationsMiddleware({ enabled: true, log: { record: async e => { records.push(e); return { ok: true }; }, health: () => ({ healthy: true }) } }));
  app.get('/health', c => c.json({ ok: true }));
  app.get('/api/catalog', c => c.json({ ok: true }));
  assert.equal((await app.request('/health')).status, 200);
  assert.equal((await app.request('/api/catalog')).status, 200);
  assert.equal(records.length, 0);
  assert.equal((await app.request('/api/attacker-private-name')).status, 404);
  assert.equal(records[0].event, 'request.denied');
  assert.ok(!JSON.stringify(records).includes('attacker-private-name'));
});
