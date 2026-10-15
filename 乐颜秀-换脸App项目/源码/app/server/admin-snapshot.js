import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import OSS from "ali-oss";
import { ADMIN_ASSET_ROOT } from "./admin-media-paths.js";
import { requireAdmin } from "./admin-auth.js";

const PREFIX = "server/stage/admin-snapshots/";
const FILE = /^(admin-console\.json|admin-workflows\.json|assets\/effects\/uploads\/[0-9a-f-]{36}\.(png|jpg|webp|mp4|webm)(\.json)?)$/;
const hash = (data) => crypto.createHash("sha256").update(data).digest("hex");
const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.ADMIN_DATA_DIR || path.join(here, "data");
const defaults = {
  "admin-console.json": process.env.ADMIN_STORE_FILE || path.join(dataDir, "admin-console.json"),
  "admin-workflows.json": process.env.ADMIN_WORKFLOW_STORE_FILE || path.join(process.env.ADMIN_WORKFLOW_DATA_DIR || path.join(here, "data"), "admin-workflows.json"),
};
const privateHeaders = { "x-oss-object-acl": "private" };

export class AdminSnapshot {
  constructor({ client, files = defaults, assetRoot = ADMIN_ASSET_ROOT }) {
    this.client = client; this.files = files; this.assetRoot = assetRoot;
    this.known = new Set(); this.failed = false; this.lastSavedAt = null;
  }
  local(name) {
    if (!FILE.test(name)) throw new Error("ADMIN_SNAPSHOT_INVALID_PATH");
    return name.startsWith("assets/") ? path.join(this.assetRoot, name.slice(7)) : this.files[name];
  }
  inventory() {
    const names = Object.keys(this.files).filter((name) => fs.existsSync(this.local(name)));
    const directory = path.join(this.assetRoot, "effects", "uploads");
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
      const relative = `assets/effects/uploads/${name}`;
      if (FILE.test(relative)) names.push(relative);
    }
    return names.sort();
  }
  async get(key) { return Buffer.from((await this.client.get(`${PREFIX}${key}`)).content); }
  async put(key, bytes) { await this.client.put(`${PREFIX}${key}`, bytes, { headers: privateHeaders }); }
  async save() {
    if (this.failed) throw new Error("ADMIN_SNAPSHOT_RECOVERY_REQUIRED");
    try {
      const entries = [];
      for (const name of this.inventory()) {
        const file = this.local(name);
        if (fs.lstatSync(file).isSymbolicLink()) throw new Error("ADMIN_SNAPSHOT_SYMLINK_REJECTED");
        const bytes = fs.readFileSync(file);
        const sha256 = hash(bytes);
        if (!this.known.has(sha256)) { await this.put(`blobs/${sha256}`, bytes); this.known.add(sha256); }
        entries.push({ name, sha256, size: bytes.length });
      }
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      const manifest = Buffer.from(JSON.stringify({ version: 1, id, createdAt, entries }));
      await this.put(`manifests/${id}.json`, manifest);
      // Publishing this one small pointer is the commit point; incomplete uploads remain unreachable.
      await this.put("current.json", Buffer.from(JSON.stringify({ id, sha256: hash(manifest) })));
      this.lastSavedAt = createdAt;
    } catch (error) { this.failed = true; throw error; }
  }
  async restore() {
    const pending = [];
    try {
      let pointerBytes;
      try { pointerBytes = await this.get("current.json"); }
      catch (error) { if (error.code === "NoSuchKey") return { restored: false, reason: "first-start" }; throw error; }
      if (pointerBytes.length > 1024) throw new Error("ADMIN_SNAPSHOT_INVALID_POINTER");
      const pointer = JSON.parse(pointerBytes);
      if (!/^[0-9a-f-]{36}$/.test(pointer.id) || !/^[0-9a-f]{64}$/.test(pointer.sha256)) throw new Error("ADMIN_SNAPSHOT_INVALID_POINTER");
      const bytes = await this.get(`manifests/${pointer.id}.json`);
      if (bytes.length > 2 * 1024 * 1024 || hash(bytes) !== pointer.sha256) throw new Error("ADMIN_SNAPSHOT_MANIFEST_INTEGRITY");
      const manifest = JSON.parse(bytes);
      if (manifest.version !== 1 || manifest.id !== pointer.id || !Array.isArray(manifest.entries) || manifest.entries.length > 10000) throw new Error("ADMIN_SNAPSHOT_INVALID_MANIFEST");
      const names = new Set(); let total = 0;
      for (const entry of manifest.entries) {
        if (!FILE.test(entry.name) || names.has(entry.name) || !/^[0-9a-f]{64}$/.test(entry.sha256) || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 32 * 1024 * 1024) throw new Error("ADMIN_SNAPSHOT_INVALID_ENTRY");
        names.add(entry.name); total += entry.size;
        if (total > 600 * 1024 * 1024) throw new Error("ADMIN_SNAPSHOT_SIZE_LIMIT");
      }
      for (const name of this.inventory()) if (!names.has(name)) throw new Error("ADMIN_SNAPSHOT_LOCAL_CONFLICT");
      for (const entry of manifest.entries) {
        const destination = this.local(entry.name);
        if (fs.existsSync(destination)) {
          if (fs.lstatSync(destination).isSymbolicLink() || hash(fs.readFileSync(destination)) !== entry.sha256) throw new Error("ADMIN_SNAPSHOT_LOCAL_CONFLICT");
          this.known.add(entry.sha256); continue;
        }
        const content = await this.get(`blobs/${entry.sha256}`);
        if (content.length !== entry.size || hash(content) !== entry.sha256) throw new Error("ADMIN_SNAPSHOT_BLOB_INTEGRITY");
        if (entry.name.endsWith(".json")) JSON.parse(content.toString("utf8"));
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        const temporary = `${destination}.${crypto.randomUUID()}.restore`;
        fs.writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
        pending.push({ temporary, destination }); this.known.add(entry.sha256);
      }
      for (const item of pending) fs.renameSync(item.temporary, item.destination);
      this.lastSavedAt = manifest.createdAt;
      return { restored: true, files: manifest.entries.length };
    } catch (error) { this.failed = true; throw error; }
    finally { for (const item of pending) fs.rmSync(item.temporary, { force: true }); }
  }
}

let instance;
export function adminSnapshot() {
  if (process.env.ADMIN_SNAPSHOT_BACKEND !== "oss") return null;
  if (process.env.DEPLOY_ENV !== "staging") throw new Error("ADMIN_SNAPSHOT_ONLY_SUPPORTED_FOR_SINGLE_INSTANCE_STAGING");
  if (!instance) {
    for (const key of ["ALIYUN_ACCESS_KEY_ID", "ALIYUN_ACCESS_KEY_SECRET", "OSS_BUCKET", "OSS_REGION"]) if (!process.env[key]) throw new Error("ADMIN_SNAPSHOT_OSS_NOT_CONFIGURED");
    instance = new AdminSnapshot({ client: new OSS({ secure: true, accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, region: process.env.OSS_REGION, timeout: 60000 }) });
  }
  return instance;
}

const ADMIN_WRITE_POLICIES = [
  ["POST", /^\/api\/admin\/(media|workflows)$/, ["owner", "operator"]],
  ["PATCH", /^\/api\/admin\/workflows\/[^/]+$/, ["owner", "operator", "reviewer"]],
  ["POST", /^\/api\/admin\/risks\/actions$/, ["owner", "operator", "reviewer"]],
  ["PUT", /^\/api\/admin\/catalog\/draft$/, ["owner", "operator"]],
  ["POST", /^\/api\/admin\/catalog\/(publish|rollback)$/, ["owner", "reviewer"]],
  ["POST", /^\/api\/admin\/emergency-pause$/, ["owner"]],
  ["PATCH", /^\/api\/admin\/reports\/[^/]+$/, ["owner", "reviewer"]],
  ["POST", /^\/api\/admin\/moderation\/[^/]+\/decision$/, ["owner", "reviewer"]],
];

export function registerAdminSnapshotMiddleware(app, { getSnapshot = adminSnapshot, authorize = requireAdmin } = {}) {
  let chain = Promise.resolve();
  let readers = 0;
  let pendingWriters = 0;
  const drainWaiters = new Set();
  // Published in-memory state changes before disk/OSS persistence completes. Do not
  // expose it while the commit is pending, or after a failed commit.
  app.use("*", async (c, next) => {
    const immutableMediaRead = ["GET", "HEAD"].includes(c.req.method) && c.req.path.startsWith("/effects/uploads/");
    const dependsOnCatalog = ["/api/catalog", "/api/features", "/api/capabilities"].includes(c.req.path)
      || c.req.path.startsWith("/effects/uploads/")
      || (c.req.method === "POST" && /^\/api\/(fusion(?:\/|$)|photo\/|video\/|llm\/|play\/)/.test(c.req.path));
    if (dependsOnCatalog) {
      const snapshot = getSnapshot();
      if (snapshot?.failed || snapshot?.writing || (snapshot && pendingWriters > 0 && !immutableMediaRead)) return c.json({ code: "ADMIN_PERSISTENCE_UNAVAILABLE", message: "服务配置正在恢复，请稍后重试" }, 503);
      if (snapshot) {
        // Hold the barrier across every await in the handler: it may read the
        // catalog again after validation, moderation, or provider preparation.
        readers += 1;
        try { return await next(); }
        finally {
          readers -= 1;
          if (readers === 0) { for (const resolve of drainWaiters) resolve(); drainWaiters.clear(); }
        }
      }
    }
    return next();
  });
  app.use("/api/admin/*", async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method) || ["/api/admin/session", "/api/admin/logout", "/api/admin/catalog/validate"].includes(c.req.path)) return next();
    const snapshot = getSnapshot();
    if (!snapshot) return next();
    const policy = ADMIN_WRITE_POLICIES.find(([method, route]) => method === c.req.method && route.test(c.req.path));
    if (!policy) return next();
    const auth = authorize(c, { roles: policy[2], csrf: true });
    if (auth.response) return auth.response;
    // Declare writer intent before yielding. Queued writers prevent new readers
    // from entering, while existing readers finish against the committed state.
    pendingWriters += 1;
    let release; const previous = chain; chain = new Promise((resolve) => { release = resolve; });
    await previous;
    try {
      if (snapshot.failed) return c.json({ code: "ADMIN_PERSISTENCE_UNAVAILABLE", message: "管理数据持久化异常，已暂停修改，请联系运维恢复" }, 503);
      while (readers > 0) await new Promise((resolve) => drainWaiters.add(resolve));
      snapshot.writing = true;
      await next();
      if (c.res.status >= 200 && c.res.status < 300) {
        try { await snapshot.save(); }
        catch { c.res = c.json({ code: "ADMIN_PERSISTENCE_UNAVAILABLE", message: "持久化失败，本次操作未获确认；已暂停修改，请联系运维恢复" }, 503); return; }
      }
    } finally { pendingWriters -= 1; snapshot.writing = false; release(); }
  });
}
