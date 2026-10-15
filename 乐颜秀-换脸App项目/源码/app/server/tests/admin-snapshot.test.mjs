import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
process.env.ADMIN_ALLOW_INSECURE_LOCAL = "true";
process.env.ADMIN_PASSWORD = "snapshot-test-password-only";
const { AdminSnapshot, registerAdminSnapshotMiddleware } = await import("../admin-snapshot.js");
const { createAdminSession, hashAdminPassword } = await import("../admin-auth.js");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lyx-snapshot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const objects = new Map();
  const client = {
    async put(key, value, options) { assert.equal(options.headers["x-oss-object-acl"], "private"); objects.set(key, Buffer.from(value)); },
    async get(key) { if (!objects.has(key)) throw Object.assign(new Error("missing"), { code: "NoSuchKey" }); return { content: objects.get(key) }; },
  };
  const create = (folder) => {
    const base = path.join(root, folder); fs.mkdirSync(base, { recursive: true });
    return new AdminSnapshot({ client, files: { "admin-console.json": path.join(base, "admin-console.json"), "admin-workflows.json": path.join(base, "admin-workflows.json") }, assetRoot: path.join(base, "assets") });
  };
  return { root, objects, client, create };
}

test("snapshot survives a new container with catalog, workflow and media, excluding secrets", async (t) => {
  const { root, objects, create } = fixture(t); const first = create("first");
  assert.equal((await first.restore()).restored, false);
  fs.writeFileSync(first.local("admin-console.json"), JSON.stringify({ revision: 3 }));
  fs.writeFileSync(first.local("admin-workflows.json"), JSON.stringify({ risks: ["tracked"] }));
  fs.writeFileSync(path.join(root, "first", ".env"), "EXCLUDED_SECRET=never-upload");
  const name = "assets/effects/uploads/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.png";
  fs.mkdirSync(path.dirname(first.local(name)), { recursive: true }); fs.writeFileSync(first.local(name), "image-test-content");
  await first.save();
  assert.ok([...objects.keys()].every((key) => key.startsWith("server/stage/admin-snapshots/")));
  assert.ok([...objects.values()].every((value) => !value.includes("never-upload")));
  const second = create("second"); assert.equal((await second.restore()).files, 3);
  assert.equal(fs.readFileSync(second.local(name), "utf8"), "image-test-content");
  assert.deepEqual(JSON.parse(fs.readFileSync(second.local("admin-console.json"))), { revision: 3 });
});

test("failed upload does not advance pointer and locks subsequent writes", async (t) => {
  const { objects, client, create } = fixture(t); const first = create("first");
  fs.writeFileSync(first.local("admin-console.json"), '{"revision":1}'); await first.save();
  const currentKey = "server/stage/admin-snapshots/current.json"; const committed = Buffer.from(objects.get(currentKey));
  fs.writeFileSync(first.local("admin-console.json"), '{"revision":2}');
  client.put = async () => { throw new Error("offline"); };
  await assert.rejects(first.save(), /offline/); assert.equal(first.failed, true);
  assert.ok(objects.get(currentKey).equals(committed));
  await assert.rejects(first.save(), /RECOVERY_REQUIRED/);
  const second = create("second"); await second.restore();
  assert.deepEqual(JSON.parse(fs.readFileSync(second.local("admin-console.json"))), { revision: 1 });
});

test("restore rejects corrupt blob and differing local state, without installing incomplete snapshot", async (t) => {
  const { objects, create } = fixture(t); const first = create("first");
  fs.writeFileSync(first.local("admin-console.json"), '{"revision":1}'); await first.save();
  const conflict = create("conflict"); fs.writeFileSync(conflict.local("admin-console.json"), '{"revision":99}');
  await assert.rejects(conflict.restore(), /LOCAL_CONFLICT/);
  const blob = [...objects.keys()].find((key) => key.includes("/blobs/")); objects.set(blob, Buffer.from("corrupt"));
  const second = create("second"); await assert.rejects(second.restore(), /BLOB_INTEGRITY/);
  assert.equal(fs.existsSync(second.local("admin-console.json")), false);
  assert.throws(() => second.local("assets/../../.env"), /INVALID_PATH/);
});

test("admin response awaits durable save and persistence failure prevents later mutations", async () => {
  let writes = 0; let saved = false;
  const snapshot = { failed: false, async save() { await Promise.resolve(); saved = true; } };
  const app = new Hono();
  registerAdminSnapshotMiddleware(app, { getSnapshot: () => snapshot, authorize: () => ({ session: { role: "owner" } }) });
  app.post("/api/admin/catalog/publish", (c) => { writes += 1; return c.json({ code: 0 }); });
  app.get("/api/catalog", (c) => c.json({ catalog: "published" }));
  app.get("/api/admin/monitoring", (c) => c.json({ diagnostic: true }));
  app.get("/effects/uploads/test.png", (c) => c.text("image"));
  for (const route of ["/api/fusion", "/api/photo/effect", "/api/video/matting", "/api/llm/chat", "/api/play/analyze"]) app.post(route, (c) => c.json({ generation: true }));
  assert.equal((await app.request("/api/catalog")).status, 200);
  assert.equal((await app.request("/api/fusion", { method: "POST" })).status, 200);
  assert.equal((await app.request("/api/admin/catalog/publish", { method: "POST" })).status, 200);
  assert.equal(saved, true);
  snapshot.save = async () => { snapshot.failed = true; throw new Error("offline"); };
  assert.equal((await app.request("/api/admin/catalog/publish", { method: "POST" })).status, 503);
  assert.equal((await app.request("/api/admin/catalog/publish", { method: "POST" })).status, 503);
  assert.equal(writes, 2);
  assert.equal((await app.request("/api/catalog")).status, 503);
  assert.equal((await app.request("/effects/uploads/test.png")).status, 503);
  for (const route of ["/api/fusion", "/api/photo/effect", "/api/video/matting", "/api/llm/chat", "/api/play/analyze"]) assert.equal((await app.request(route, { method: "POST" })).status, 503);
  assert.equal((await app.request("/api/admin/monitoring")).status, 200);
});

test("public catalog is unavailable throughout an in-flight snapshot commit", async () => {
  let releaseSave; let announceSave;
  const started = new Promise((resolve) => { announceSave = resolve; });
  const snapshot = { failed: false, async save() { announceSave(); await new Promise((resolve) => { releaseSave = resolve; }); } };
  const app = new Hono();
  registerAdminSnapshotMiddleware(app, { getSnapshot: () => snapshot, authorize: () => ({ session: { role: "owner" } }) });
  app.post("/api/admin/catalog/publish", (c) => c.json({ code: 0 }));
  app.get("/api/catalog", (c) => c.json({ catalog: "new" }));
  const pending = app.request("/api/admin/catalog/publish", { method: "POST" });
  await started;
  assert.equal((await app.request("/api/catalog")).status, 503);
  releaseSave(); assert.equal((await pending).status, 200);
  assert.equal((await app.request("/api/catalog")).status, 200);
});

test("writer waits for admitted generation across awaits and blocks new readers", async () => {
  let version = 1; let releaseReader; let enteredReader;
  const entered = new Promise((resolve) => { enteredReader = resolve; });
  const snapshot = { failed: false, async save() {} };
  const app = new Hono(); registerAdminSnapshotMiddleware(app, { getSnapshot: () => snapshot, authorize: () => ({ session: { role: "owner" } }) });
  app.post("/api/fusion", async (c) => { enteredReader(); await new Promise((resolve) => { releaseReader = resolve; }); return c.json({ usedVersion: version }); });
  app.get("/api/catalog", (c) => c.json({ version }));
  app.get("/effects/uploads/published.png", (c) => c.text("immutable published media"));
  app.post("/api/admin/catalog/publish", (c) => { version = 2; return c.json({ code: 0 }); });
  const reader = app.request("/api/fusion", { method: "POST" }); await entered;
  const writer = app.request("/api/admin/catalog/publish", { method: "POST" });
  assert.equal((await app.request("/api/catalog")).status, 503);
  assert.equal(version, 1);
  assert.equal((await app.request("/effects/uploads/published.png")).status, 200);
  releaseReader();
  assert.deepEqual(await (await reader).json(), { usedVersion: 1 });
  assert.equal((await writer).status, 200);
  assert.deepEqual(await (await app.request("/api/catalog")).json(), { version: 2 });
});

test("reader failure releases waiting writers and queued writers stay exclusive", async () => {
  let releaseReader; let enteredReader; let releaseFirstSave; let enteredSave; let writes = 0; let saves = 0;
  const readerEntered = new Promise((resolve) => { enteredReader = resolve; });
  const saveEntered = new Promise((resolve) => { enteredSave = resolve; });
  const snapshot = { failed: false, async save() { saves += 1; if (saves === 1) { enteredSave(); await new Promise((resolve) => { releaseFirstSave = resolve; }); } } };
  const app = new Hono(); app.onError((_error, c) => c.json({ error: true }, 500));
  registerAdminSnapshotMiddleware(app, { getSnapshot: () => snapshot, authorize: () => ({ session: { role: "owner" } }) });
  app.post("/api/photo/effect", async () => { enteredReader(); await new Promise((resolve) => { releaseReader = resolve; }); throw new Error("test reader failure"); });
  app.post("/api/admin/catalog/publish", (c) => { writes += 1; return c.json({ code: 0 }); });
  app.get("/api/catalog", (c) => c.json({ writes }));
  const reader = app.request("/api/photo/effect", { method: "POST" }); await readerEntered;
  const first = app.request("/api/admin/catalog/publish", { method: "POST" });
  const second = app.request("/api/admin/catalog/publish", { method: "POST" });
  releaseReader(); assert.equal((await reader).status, 500); await saveEntered;
  assert.equal(writes, 1); assert.equal((await app.request("/api/catalog")).status, 503);
  releaseFirstSave(); assert.equal((await first).status, 200); assert.equal((await second).status, 200);
  assert.equal(writes, 2); assert.equal(snapshot.writing, false); assert.equal((await app.request("/api/catalog")).status, 200);
});

test("unauthenticated, missing CSRF, unauthorized role and unknown writes never acquire writer intent", async () => {
  let releaseReader; let enterReader; let writes = 0;
  const entered = new Promise((resolve) => { enterReader = resolve; });
  const snapshot = { failed: false, async save() {} };
  const app = new Hono(); registerAdminSnapshotMiddleware(app, { getSnapshot: () => snapshot });
  app.post("/api/fusion", async (c) => { enterReader(); await new Promise((resolve) => { releaseReader = resolve; }); return c.json({ code: 0 }); });
  app.get("/api/catalog", (c) => c.json({ code: 0 }));
  app.post("/api/admin/catalog/publish", (c) => { writes += 1; return c.json({ code: 0 }); });
  const reader = app.request("/api/fusion", { method: "POST" }); await entered;
  const owner = createAdminSession({ username: "admin", role: "owner", displayName: "test" });
  const previousUsers = process.env.ADMIN_USERS_JSON;
  const passwordHash = hashAdminPassword("snapshot-test-password-only");
  process.env.ADMIN_USERS_JSON = JSON.stringify([{ username: "admin", role: "owner", passwordHash }, { username: "operator", role: "operator", passwordHash }]);
  const operator = createAdminSession({ username: "operator", role: "operator", displayName: "test" });
  try {
    for (const [route, headers, expected] of [
      ["/api/admin/catalog/publish", {}, 401],
      ["/api/admin/catalog/publish", { cookie: owner.cookie.split(";")[0] }, 403],
      ["/api/admin/catalog/publish", { cookie: operator.cookie.split(";")[0], "x-csrf-token": operator.csrfToken }, 403],
      ["/api/admin/unknown", {}, 404],
    ]) {
      // Without the fix these requests wait indefinitely behind the admitted reader.
      const response = await Promise.race([app.request(route, { method: "POST", headers }), new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("unauthorized request entered writer queue")), 1000); timer.unref(); })]);
      assert.equal(response.status, expected);
      assert.equal((await app.request("/api/catalog")).status, 200);
      assert.equal(Boolean(snapshot.writing), false);
    }
    assert.equal(writes, 0);
  } finally { releaseReader(); await reader; if (previousUsers === undefined) delete process.env.ADMIN_USERS_JSON; else process.env.ADMIN_USERS_JSON = previousUsers; }
});
