import test from 'node:test';
import assert from 'node:assert/strict';
import { Hono } from 'hono';
import { OperationDrain, registerStageDrainMiddleware } from '../stage-drain.js';

test('drain waits in-flight operation, refuses new work, flushes and resumes', async () => {
  const drain = new OperationDrain();
  let release; let flushed = false;
  const old = drain.run(() => new Promise(resolve => { release = resolve; }));
  const pending = drain.begin(async () => { flushed = true; });
  await assert.rejects(drain.run(() => {}), { code: 'STAGE_DRAINING' });
  assert.equal(flushed, false);
  release(); await old; await pending;
  assert.equal(flushed, true);
  assert.equal(drain.status().ready, true);
  drain.resume();
  assert.equal(await drain.run(() => 4), 4);
});
test('exceptions release requests and failed flush keeps service drained', async () => {
  const drain = new OperationDrain();
  await assert.rejects(drain.run(() => { throw new Error('handler'); }));
  assert.equal(drain.active, 0);
  await assert.rejects(drain.begin(() => { throw new Error('storage'); }));
  assert.equal(drain.draining, true);
  drain.resume();
  assert.equal(await drain.run(() => 1), 1);
});
test('unauthorized drain never changes state and control endpoint avoids self-deadlock', async () => {
  const app = new Hono(); const drain = new OperationDrain();
  registerStageDrainMiddleware(app, { enabled: true, drain, flush: async () => {}, authorized: c => c.req.header('x-test') === 'allowed' ? null : c.json({}, 403) });
  app.get('/api/catalog', c => c.json({}));
  const body = JSON.stringify({ action: 'drain' });
  assert.equal((await app.request('/api/internal/deployment-drain', { method: 'POST', body })).status, 403);
  assert.equal(drain.draining, false);
  assert.equal((await app.request('/api/internal/deployment-drain', { method: 'POST', body, headers: { 'x-test': 'allowed' } })).status, 200);
  assert.equal((await app.request('/api/catalog')).status, 503);
  assert.equal((await app.request('/api/internal/deployment-drain', { headers: { 'x-test': 'allowed' } })).status, 200);
});
