import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CompliancePersistence, COMPLIANCE_OSS_KEY, validateComplianceBytes, initializeCompliancePersistence } from "../compliance-persistence.js";

const ledger = (revision) => Buffer.from(JSON.stringify({ schemaVersion: 1, users: { person: { id: "person", revision } }, sessions: {}, ledger: [{ revision }] }));
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyx-compliance-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const objects = new Map(); const writes = [];
  const client = {
    async get(key) { if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" }); return { content: objects.get(key) }; },
    async put(key, bytes, options) { assert.equal(key, COMPLIANCE_OSS_KEY); assert.equal(options.headers["x-oss-object-acl"], "private"); await Promise.resolve(); objects.set(key, Buffer.from(bytes)); writes.push(JSON.parse(bytes).users.person.revision); },
  };
  return { dir, client, objects, writes, create: (name) => new CompliancePersistence({ client, file: path.join(dir, name) }) };
}

test("private ordered snapshots survive a new container and migrate local first-start baseline", async (t) => {
  const f = setup(t); const first = f.create("first.json");
  fs.writeFileSync(first.file, ledger(1)); await first.restore();
  first.enqueue(ledger(2)); first.enqueue(ledger(3)); await first.flush();
  assert.deepEqual(f.writes, [1, 2, 3]);
  const next = f.create("next.json"); await next.restore();
  assert.equal(JSON.parse(fs.readFileSync(next.file)).users.person.revision, 3);
  assert.equal(next.readiness().durable, true);
  assert.equal(next.readiness().productionSupported, false);
});

test("failed remote write locks queued and future writes, and flush rejects without unhandled rejection", async (t) => {
  const f = setup(t); const store = f.create("failure.json");
  store.enqueue(ledger(1)); await store.flush();
  f.client.put = async () => { throw new Error("offline"); };
  store.enqueue(ledger(2)); store.enqueue(ledger(3));
  await assert.rejects(store.flush(), { code: "COMPLIANCE_PERSISTENCE_UNAVAILABLE" });
  assert.throws(() => store.enqueue(ledger(4)), { code: "COMPLIANCE_PERSISTENCE_UNAVAILABLE" });
  assert.equal(JSON.parse(f.objects.get(COMPLIANCE_OSS_KEY)).users.person.revision, 1);
  assert.equal(store.readiness().ready, false);
});

test("restore fails closed on connection errors or corrupt remote data even with a local ledger", async (t) => {
  const f = setup(t); const store = f.create("local.json"); fs.writeFileSync(store.file, ledger(7));
  f.client.get = async () => { throw new Error("offline"); };
  await assert.rejects(store.restore(), /offline/);
  assert.equal(store.failed, true);
  const other = f.create("corrupt.json"); f.client.get = async () => ({ content: Buffer.from('{"schemaVersion":1,"users":[],"sessions":{},"ledger":[]}') });
  await assert.rejects(other.restore(), /INVALID_SCHEMA/);
  assert.equal(fs.existsSync(other.file), false);
  assert.throws(() => validateComplianceBytes(Buffer.alloc(33 * 1024 * 1024)), /INVALID_SIZE/);
});

test("default file mode cannot accidentally use available cloud credentials", async () => {
  const prior = process.env.COMPLIANCE_BACKEND; delete process.env.COMPLIANCE_BACKEND;
  try { assert.equal(await initializeCompliancePersistence("unused"), null); }
  finally { if (prior !== undefined) process.env.COMPLIANCE_BACKEND = prior; }
});

test("flush waits for snapshots enqueued while a previous remote write is in progress", async (t) => {
  const f = setup(t); const store = f.create("concurrent.json");
  const put = f.client.put; let release; let started;
  const entered = new Promise((resolve) => { started = resolve; });
  f.client.put = async (...args) => { if (!release) { started(); await new Promise((resolve) => { release = resolve; }); } return put(...args); };
  store.enqueue(ledger(1)); const flushing = store.flush(); await entered;
  store.enqueue(ledger(2)); release(); await flushing;
  assert.deepEqual(f.writes, [1, 2]);
  assert.equal(store.readiness().pending, 0);
});
