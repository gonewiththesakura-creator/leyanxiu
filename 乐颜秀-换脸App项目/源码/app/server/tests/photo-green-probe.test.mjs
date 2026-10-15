import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSyntheticProbe, syntheticPng } from '../scripts/probe-photo-green-synthetic.mjs';

function fixture({ failJournal, respond, failDelete = false } = {}) {
  const calls = []; const records = []; const objects = new Map();
  const run = () => runSyntheticProbe({ region: 'cn-shanghai', timeoutMs: 20,
    journal: async entry => { records.push(entry); calls.push('journal:' + entry.phase);
      if (entry.phase === failJournal) throw new Error('synthetic private journal failure'); return true; },
    storage: {
      async put(key, bytes) { calls.push('put'); assert.ok(records.some(entry => entry.phase === 'scratch_intent' && entry.key === key)); objects.set(key, bytes); },
      signedUrl() { calls.push('sign'); return 'https://synthetic.invalid/private.png?Signature=REDACTED_SECRET },
      async delete(key) { calls.push('delete'); if (failDelete) throw new Error('synthetic cleanup timeout'); objects.delete(key); },
    },
    transport: async request => { calls.push('green:' + request.service);
      assert.equal(calls.at(-2), 'journal:provider_attempt_intent');
      return respond ? respond(request) : { statusCode: 200, body: { Code: 200, RequestId: 'private-fixture-request-id',
        Data: { DataId: request.serviceParameters.dataId, RiskLevel: 'none', Result: [{ Label: 'nonLabel' }] } } }; },
  });
  return { calls, records, objects, run };
}

test('default CLI performs no probe; explicit core binds one synthetic PNG to exactly two different services', async () => {
  const stdout = execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/probe-photo-green-synthetic.mjs', import.meta.url))], { encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).executed, false);
  const f = fixture(); const report = await f.run();
  assert.equal(report.passed, true); assert.equal(report.attemptedGreenCalls, 2); assert.equal(report.productionApproved, false);
  assert.deepEqual(f.calls.filter(value => value.startsWith('green:')), ['green:baselineCheck', 'green:aigcCheck']);
  assert.equal(f.records.filter(record => record.phase === 'scratch_intent').length, 2);
  assert.equal(f.objects.size, 0);
  const summaries = f.records.filter(record => record.phase === 'receipt').map(record => record.receipt);
  assert.equal(summaries[0].sha256, summaries[1].sha256); assert.equal(summaries[0].byteLength, syntheticPng.length);
  const output = JSON.stringify(report);
  for (const secret of ['private-fixture-request-id', 'Signature', 'private/photo-moderation/', 'mod_', 'secret-fixture']) assert.equal(output.includes(secret), false);
});

test('failed scratch journal causes zero PUT/Green; failed paid-request journal causes no Green and one cleanup', async () => {
  for (const phase of ['scratch_intent', 'provider_attempt_intent']) {
    const f = fixture({ failJournal: phase }); const report = await f.run();
    assert.equal(report.passed, false); assert.equal(report.attemptedGreenCalls, 0);
    assert.equal(f.calls.some(value => value.startsWith('green:')), false);
    assert.equal(f.calls.filter(value => value === 'put').length, phase === 'scratch_intent' ? 0 : 1);
    assert.equal(f.objects.size, 0);
  }
});

test('unknown paid timeout remains one attempt, no second service or automatic retry', async () => {
  const f = fixture({ respond: () => new Promise(() => {}) }); const report = await f.run();
  assert.equal(report.attemptedGreenCalls, 1); assert.equal(report.passed, false);
  assert.equal(report.results[0].decision, 'unconfirmed'); assert.equal(report.results.length, 1);
  assert.equal(f.calls.filter(value => value === 'put').length, 1);
  assert.equal(f.calls.filter(value => value.startsWith('green:')).length, 1);
  assert.equal(f.objects.size, 0);
});

test('cleanup uncertainty and HTTP200 business failure leave durable evidence and stop output probe', async () => {
  for (const options of [{ failDelete: true }, { respond: () => ({ statusCode: 200, body: { Code: 400 } }) }, { failJournal: 'receipt' }]) {
    const f = fixture(options); const report = await f.run();
    assert.equal(report.passed, false); assert.equal(report.attemptedGreenCalls, 1); assert.equal(report.results.length, 1);
    assert.equal(f.records.some(record => record.phase === 'scratch_intent'), true);
    assert.equal(f.records.some(record => record.phase === 'provider_attempt_intent'), true);
    if (options.failDelete) { assert.equal(report.results[0].cleanupPending, true); assert.equal(f.objects.size, 1); }
  }
});
