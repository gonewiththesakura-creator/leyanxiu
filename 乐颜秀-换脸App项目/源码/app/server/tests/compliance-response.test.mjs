import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { registerCompliancePersistenceMiddleware } from '../compliance-response.js';

test('successful and error API replies await ledger persistence, including GET task polls', async () => {
  let commits = 0;
  const app = new Hono();
  registerCompliancePersistenceMiddleware(app, { readiness: () => ({ ready: true }), flush: async () => { await Promise.resolve(); commits += 1; } });
  app.get('/api/fusion/task', c => c.json({ code: 0 }));
  app.post('/api/create', c => c.json({ code: 'FAILED' }, 422));
  assert.equal((await app.request('/api/fusion/task')).status, 200);
  assert.equal(commits, 1);
  assert.equal((await app.request('/api/create', { method: 'POST' })).status, 422);
  assert.equal(commits, 2);
});

test('failed ledger commit replaces success and removes unconfirmed session cookie', async () => {
  const app = new Hono();
  registerCompliancePersistenceMiddleware(app, { readiness: () => ({ ready: true }), flush: async () => { throw new Error('secret storage diagnostic'); } });
  app.post('/api/auth/session', c => { c.header('Set-Cookie', 'test=unconfirmed'); return c.json({ token: 'must-not-escape' }); });
  const res = await app.request('/api/auth/session', { method: 'POST' });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.deepEqual(await res.json(), { code: 'COMPLIANCE_PERSISTENCE_UNAVAILABLE', message: '账户数据保存异常，请稍后重试' });
});

test('unhealthy ledger blocks business access while authenticated diagnostics remain reachable', async () => {
  let writes = 0;
  const app = new Hono();
  registerCompliancePersistenceMiddleware(app, { readiness: () => ({ ready: false }), flush: async () => { throw new Error('offline'); } });
  app.get('/api/account/entitlements', c => { writes += 1; return c.json({}); });
  app.get('/api/admin/readiness', c => c.json({ diagnostic: true }));
  app.get('/api/catalog', c => c.json({ templates: [] }));
  assert.equal((await app.request('/api/account/entitlements')).status, 503);
  assert.equal(writes, 0);
  assert.equal((await app.request('/api/admin/readiness')).status, 200);
  assert.equal((await app.request('/api/catalog')).status, 200);
});
