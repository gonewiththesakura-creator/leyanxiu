import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { PrivateObjectStore } from "../storage.js";

class FakeOss {
  constructor() {
    this.objects = new Map();
    this.events = [];
    this.signatureOptions = [];
  }

  async put(key, body, options = {}) {
    this.events.push({ op: "put", key, options });
    this.objects.set(key, Buffer.from(body));
    return { name: key };
  }

  async putACL(key, acl) {
    this.events.push({ op: "putACL", key, acl });
    assert.equal(acl, "private");
    return {};
  }

  async get(key) {
    this.events.push({ op: "get", key });
    if (!this.objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" });
    return { content: Buffer.from(this.objects.get(key)) };
  }

  async delete(key) {
    this.events.push({ op: "delete", key });
    this.objects.delete(key);
    return {};
  }

  signatureUrl(key, options) {
    this.signatureOptions.push({ key, options });
    return `http://oss.example.test/${key}?Expires=${options.expires}&Signature=REDACTED_SECRET
  }
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-oss-index-"));
}

test("OSS object index restores from a private object and persists mutations serially", async () => {
  const root = tempRoot();
  const key = "closed-test/object-index.json";
  const client = new FakeOss();
  const existingId = "obj_existing";
  const existingRecord = {
    id: existingId,
    key: "private/obj_existing.png",
    ownerId: "user-a",
    contentType: "image/png",
    ext: ".png",
    size: 1,
    purpose: "input/test",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    deletedAt: null,
    metadata: {},
  };
  client.objects.set(key, Buffer.from(JSON.stringify({ [existingId]: existingRecord })));

  const store = new PrivateObjectStore({ backend: "oss", client, root, indexFile: path.join(root, "legacy-index.json"), indexObjectKey: key });
  assert.equal(store.ready().ready, false);
  await store.initialize();
  assert.equal(store.ready().ready, true);
  assert.equal(store.get(existingId).ownerId, "user-a");
  assert.deepEqual(store.indexPersistenceStatus(), {
    backend: "oss-private-object",
    key,
    initialized: true,
    transactionSafe: false,
    scope: "closed_test_single_instance",
    productionBlocker: "OSS JSON object index is not transaction-safe for multi-instance production; migrate the index to a transactional database or object-index service",
  });

  const [first, second] = await Promise.all([
    store.putBuffer(Buffer.from("a"), { ownerId: "user-a", ext: ".png", purpose: "input/test" }),
    store.putBuffer(Buffer.from("b"), { ownerId: "user-a", ext: ".png", purpose: "input/test" }),
  ]);
  assert.notEqual(first.id, second.id);
  assert.equal(store.listOwned("user-a").length, 3);

  const indexWrites = client.events.filter((event) => event.op === "put" && event.key === key);
  const indexAcls = client.events.filter((event) => event.op === "putACL" && event.key === key);
  assert.equal(indexWrites.length, 2);
  assert.equal(indexAcls.length, 2);
  assert.ok(indexWrites.every((event) => event.options.headers["x-oss-object-acl"] === "private"));
  assert.ok(indexAcls.every((event) => event.acl === "private"));

  await store.delete(first.id, { ownerId: "user-a", reason: "test" });
  const restarted = new PrivateObjectStore({ backend: "oss", client, root: tempRoot(), indexFile: path.join(root, "missing-local-index.json"), indexObjectKey: key });
  await restarted.initialize();
  assert.equal(restarted.get(first.id), null);
  assert.equal(restarted.listOwned("user-a").length, 2);
});

test("OSS index bootstraps once from a legacy local index when the remote key is absent", async () => {
  const root = tempRoot();
  const indexFile = path.join(root, "legacy-index.json");
  const legacy = { obj_legacy: { id: "obj_legacy", ownerId: "user-a", key: "private/obj_legacy.bin", expiresAt: new Date(Date.now() + 60_000).toISOString(), deletedAt: null } };
  fs.writeFileSync(indexFile, JSON.stringify(legacy), { mode: 0o600 });
  const client = new FakeOss();
  const store = new PrivateObjectStore({ backend: "oss", client, root, indexFile, indexObjectKey: "closed-test/object-index.json" });
  await store.initialize();
  assert.deepEqual(store.index, legacy);
  assert.deepEqual(JSON.parse(client.objects.get("closed-test/object-index.json").toString("utf8")), legacy);
  assert.equal(client.events.at(-1).op, "putACL");
});

test("file object index remains local and does not require an OSS client", async () => {
  const root = tempRoot();
  const store = new PrivateObjectStore({ backend: "file", root, indexFile: path.join(root, "index.json") });
  const record = await store.putBuffer(Buffer.from("file"), { ownerId: "user-a", ext: ".bin", purpose: "input/test" });
  assert.equal(store.indexPersistenceStatus().backend, "file");
  assert.ok(fs.existsSync(path.join(root, "index.json")));
  assert.equal((await store.read(record.id)).buffer.toString(), "file");
});

test("providerUrl returns an owned HTTPS OSS URL capped by retention and 900 seconds", async () => {
  const root = tempRoot();
  const client = new FakeOss();
  const store = new PrivateObjectStore({ backend: "oss", client, root, indexObjectKey: "closed-test/index.json" });
  await store.initialize();
  const record = await store.putBuffer(Buffer.from("provider"), { ownerId: "user-a", ext: ".bin", purpose: "input/test", retainSeconds: 120 });

  const url = await store.providerUrl(record.id, { ownerId: "user-a", ttlSeconds: 9_999 });
  assert.equal(new URL(url).protocol, "https:");
  assert.ok(client.signatureOptions.at(-1).options.expires >= 118 && client.signatureOptions.at(-1).options.expires <= 120);
  assert.equal(client.signatureOptions.at(-1).options.method, "GET");

  const capRecord = await store.putBuffer(Buffer.from("provider-cap"), { ownerId: "user-a", ext: ".bin", purpose: "input/test", retainSeconds: 3_600 });
  await store.providerUrl(capRecord.id, { ownerId: "user-a", ttlSeconds: 9_999 });
  assert.equal(client.signatureOptions.at(-1).options.expires, 900);
});

test("configured template objects are made private and exposed to providers only by short HTTPS signatures", async () => {
  const root = tempRoot();
  const client = new FakeOss();
  const store = new PrivateObjectStore({
    backend: "oss",
    client,
    root,
    bucket: "licensed-templates",
    region: "oss-cn-shanghai",
    indexObjectKey: "closed-test/index.json",
  });
  await store.initialize();
  assert.equal(typeof store.protectConfiguredOssObject, "function");
  assert.equal(typeof store.providerUrlForConfiguredOssObject, "function");

  const source = "http://licensed-templates.oss-cn-shanghai.aliyuncs.com/templates/dance.mp4";
  await store.protectConfiguredOssObject(source);
  const signed = await store.providerUrlForConfiguredOssObject(source, { ttlSeconds: 9_999 });

  assert.equal(new URL(signed).protocol, "https:");
  assert.equal(client.signatureOptions.at(-1).key, "templates/dance.mp4");
  assert.deepEqual(client.signatureOptions.at(-1).options, { method: "GET", expires: 900 });
  assert.ok(client.events.some((event) => event.op === "putACL" && event.key === "templates/dance.mp4" && event.acl === "private"));
  await assert.rejects(
    () => store.providerUrlForConfiguredOssObject("https://attacker.example/templates/dance.mp4"),
    /configured OSS bucket/,
  );
});

test("providerUrl rejects another owner and expired objects without signing", async () => {
  const root = tempRoot();
  const client = new FakeOss();
  const store = new PrivateObjectStore({ backend: "oss", client, root, indexObjectKey: "closed-test/index.json" });
  await store.initialize();
  const record = await store.putBuffer(Buffer.from("provider"), { ownerId: "user-a", ext: ".bin", purpose: "input/test" });
  const signedCount = () => client.signatureOptions.length;
  assert.equal(await store.providerUrl(record.id, { ownerId: "user-b" }), null);
  assert.equal(signedCount(), 0);
  store.index[record.id].expiresAt = new Date(Date.now() - 1_000).toISOString();
  assert.equal(await store.providerUrl(record.id, { ownerId: "user-a" }), null);
  assert.equal(signedCount(), 0);
});

test("file providerUrl falls back to the application signed URL contract", async () => {
  const root = tempRoot();
  const store = new PrivateObjectStore({ backend: "file", root, indexFile: path.join(root, "index.json") });
  const record = await store.putBuffer(Buffer.from("file-provider"), { ownerId: "user-a", ext: ".bin", purpose: "input/test" });
  const url = await store.providerUrl(record.id, { ownerId: "user-a", base: "https://app.example.test", ttlSeconds: 30 });
  const parsed = new URL(url);
  assert.equal(parsed.origin, "https://app.example.test");
  assert.match(parsed.pathname, new RegExp(`/api/objects/${record.id}`));
  assert.equal(await store.providerUrl(record.id, { ownerId: "user-b", base: "https://app.example.test" }), null);
});
