import test from "node:test";
import assert from "node:assert/strict";
import { createMetricsPersistence, METRICS_KEY, validateMetricsSnapshot } from "../metrics-persistence.js";

function fixture() {
  const time = Math.floor((Date.now() - 120_000) / 60_000) * 60_000;
  return { version: 1, counters: [["http.requests", 8]], timings: [["http.GET /api/test", [20, 45]]], httpBuckets: [[time, { requests: 8, errors5xx: 1, totalLatencyMs: 240, routeCounts: { "GET /api/test": 8 } }]], alerts: [{ name: "supplier.failed", createdAt: new Date(time).toISOString(), details: { token: "do-not-save", status: 503 } }] };
}
function fakeOss(initial) {
  let content = initial && Buffer.from(JSON.stringify(initial));
  const writes = [];
  return { writes, fail: false, async get(key) { assert.equal(key, METRICS_KEY); if (!content) throw Object.assign(new Error("missing"), { code: "NoSuchKey" }); return { content }; }, async put(key, data, options) { if (this.fail) throw new Error("simulated failure"); content = Buffer.from(data); writes.push({ key, data: JSON.parse(data), options }); } };
}
test("private OSS snapshots restore real timestamps and sanitized alerts", async () => {
  const original = fixture(); const client = fakeOss(original);
  const store = createMetricsPersistence({ backend: "oss", deployEnv: "staging", client, getSnapshot: () => original });
  const restored = await store.restore();
  assert.equal(restored.httpBuckets[0][0], original.httpBuckets[0][0]);
  assert.equal(restored.alerts[0].createdAt, original.alerts[0].createdAt);
  assert.equal(restored.alerts[0].details.token, "[REDACTED]");
  store.changed(); await store.flush(); store.close();
  assert.equal(client.writes[0].options.headers["x-oss-object-acl"], "private");
  assert.equal(client.writes[0].data.alerts[0].details.token, "[REDACTED]");
  assert.equal(store.state().durable, true);
});
test("internal mutation persists without HTTP traffic and reports failed saves", async () => {
  const client = fakeOss(); const data = fixture();
  const store = createMetricsPersistence({ backend: "oss", deployEnv: "staging", client, getSnapshot: () => data, intervalMs: 10 });
  await store.restore(); store.changed();
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(client.writes.length, 1);
  client.fail = true; store.changed(); await assert.rejects(store.flush(), /save failed/);
  assert.equal(store.state().ready, false); assert.equal(store.state().degraded, true); assert.equal(store.state().pending, true);
  client.fail = false; await store.flush(); store.close(); assert.equal(store.state().ready, true);
});
test("invalid or oversized snapshots fail closed, no overwrite or cross-environment OSS", async () => {
  assert.throws(() => createMetricsPersistence({ backend: "oss", deployEnv: "production" }), /staging-only/);
  for (const invalid of [{}, { ...fixture(), counters: Array.from({ length: 301 }, (_, i) => [`n${i}`, 1]) }, { ...fixture(), timings: [["x", [NaN]]] }]) assert.throws(() => validateMetricsSnapshot(invalid));
  const client = fakeOss({ invalid: true });
  const store = createMetricsPersistence({ backend: "oss", deployEnv: "staging", client, getSnapshot: fixture });
  await assert.rejects(store.restore(), /restore failed/); store.changed(); await assert.rejects(store.flush(), /not initialized/); store.close(); assert.equal(client.writes.length, 0);
  const huge = createMetricsPersistence({ backend: "oss", deployEnv: "staging", client: { get: async () => ({ content: Buffer.alloc(12 * 1024 * 1024 + 1) }) }, getSnapshot: fixture });
  await assert.rejects(huge.restore(), /restore failed/);
});
test("writes serialize and changes during save remain pending for next flush", async () => {
  const client = fakeOss(); const data = fixture(); let release; const originalPut = client.put.bind(client); let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  client.put = async (...args) => { started(); await new Promise((resolve) => { release = resolve; }); await originalPut(...args); };
  const store = createMetricsPersistence({ backend: "oss", deployEnv: "staging", client, getSnapshot: () => data }); await store.restore(); store.changed(); const writing = store.flush(); await startedPromise;
  data.counters[0][1] = 9; store.changed(); release(); await writing;
  assert.equal(client.writes[0].data.counters[0][1], 8); assert.equal(store.state().pending, true);
  client.put = originalPut; await store.flush(); store.close(); assert.equal(client.writes[1].data.counters[0][1], 9);
});
