import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import OSS from "ali-oss";
import { fileURLToPath } from "node:url";
import { fetchRemoteBuffer } from "./remote-fetch.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SIGNING_SECRET = "closed-test-object-signing-secret-change-before-production-2026";
const SIGNING_SECRET = process.env.OBJECT_SIGNING_SECRET || process.env.AUTH_SESSION_SECRET || DEFAULT_SIGNING_SECRET;
const DEFAULT_TTL_SECONDS = Math.max(60, Number(process.env.OBJECT_URL_TTL_SECONDS || 300));

function id() {
  return `obj_${crypto.randomUUID()}`;
}

function extension(value = "") {
  const cleaned = String(value).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const normalized = cleaned.startsWith(".") ? cleaned : `.${cleaned}`;
  if (/^\.(jpg|jpeg|png|webp|mp4|mov|webm)$/.test(normalized)) return normalized;
  return ".bin";
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sign(body) {
  return crypto.createHmac("sha256", SIGNING_SECRET).update(body).digest("base64url");
}

function tokenFor(objectId, expiresAt) {
  const body = Buffer.from(JSON.stringify({ v: 1, oid: objectId, exp: Math.floor(expiresAt / 1000) })).toString("base64url");
  return `${body}.${sign(body)}`;
}

function verifyToken(objectId, token) {
  if (!token || typeof token !== "string") return false;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;
  const body = token.slice(0, separator);
  if (!safeEqual(sign(body), token.slice(separator + 1))) return false;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return payload.v === 1 && payload.oid === objectId && Number.isInteger(payload.exp) && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function readIndex(indexFile) {
  if (!fs.existsSync(indexFile)) return {};
  const parsed = JSON.parse(fs.readFileSync(indexFile, "utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeIndex(indexFile, index) {
  const temp = `${indexFile}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(index), { mode: 0o600 });
  fs.renameSync(temp, indexFile);
}

function baseUrl(value) {
  return String(value || process.env.PUBLIC_BASE_URL || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

function bucketAuditReadiness() {
  const production = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
  if (!production) return { ready: true, report: null, blockers: [] };
  const reportFile = process.env.PRIVATE_BUCKET_AUDIT_REPORT;
  if (!reportFile || !fs.existsSync(reportFile)) return { ready: false, report: reportFile || null, blockers: ["PRIVATE_BUCKET_AUDIT_REPORT must be generated and show a zero-public-object audit"] };
  try {
    const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));
    const blockers = [];
    if (report.status !== "verified") blockers.push("private bucket audit report is not verified");
    if (report.publicObjectCount !== 0) blockers.push("private bucket audit found public objects; migrate or delete them before launch");
    return { ready: blockers.length === 0, report: { status: report.status, publicObjectCount: report.publicObjectCount, checkedAt: report.checkedAt }, blockers };
  } catch {
    return { ready: false, report: reportFile, blockers: ["PRIVATE_BUCKET_AUDIT_REPORT is not valid JSON"] };
  }
}

export class PrivateObjectStore {
  constructor({
    backend = process.env.OBJECT_STORAGE_BACKEND || "file",
    root = process.env.PRIVATE_OBJECT_DIR || path.join(__dirname, "private-objects"),
    indexFile = process.env.OBJECT_INDEX_FILE || path.join(root, "object-index.json"),
    prefix = process.env.OBJECT_PREFIX || "private",
    ttlSeconds = DEFAULT_TTL_SECONDS,
    client = null,
    indexObjectKey = process.env.OBJECT_INDEX_OSS_KEY || "server/private-object-index.json",
    bucket = process.env.OSS_BUCKET || "",
    region = process.env.OSS_REGION || "",
  } = {}) {
    this.backend = backend;
    this.root = path.resolve(root);
    this.indexFile = path.resolve(indexFile);
    this.prefix = prefix.replace(/^\/+|\/+$/g, "") || "private";
    this.ttlSeconds = ttlSeconds;
    this.indexObjectKey = String(indexObjectKey).replace(/^\/+/, "");
    this.bucket = String(bucket).trim();
    this.region = String(region).trim();
    this.protectedConfiguredKeys = new Set();
    // The file backend keeps its historical local index. OSS uses the private
    // object below as the authoritative index and only uses the local file as
    // a one-time migration source when that object does not exist.
    if (this.backend === "file") fs.mkdirSync(this.root, { recursive: true });
    this.index = this.backend === "file" ? readIndex(this.indexFile) : {};
    this.client = client;
    this.initialized = this.backend !== "oss";
    this.initializationError = null;
    this.initializationPromise = null;
    this.mutationQueue = Promise.resolve();
  }

  _ossConfigBlockers() {
    const blockers = [];
    if (this.backend !== "oss") blockers.push(`unsupported OBJECT_STORAGE_BACKEND=${this.backend}`);
    if (this.backend === "oss" && !this.client && (!process.env.ALIYUN_ACCESS_KEY_ID || !process.env.ALIYUN_ACCESS_KEY_SECRET)) blockers.push("OSS credentials are not configured");
    if (this.backend === "oss" && !this.client && (!process.env.OSS_BUCKET || !process.env.OSS_REGION)) blockers.push("OSS_BUCKET and OSS_REGION are required");
    return { ready: blockers.length === 0, backend: this.backend, blockers };
  }

  ready() {
    if (this.backend === "file") return { ready: true, backend: this.backend, blockers: [] };
    const status = this._ossConfigBlockers();
    if (this.backend === "oss" && !this.initialized && !this.initializationError) status.blockers.push("OSS object index has not been initialized");
    if (this.initializationError) status.blockers.push("OSS object index initialization failed");
    return { ...status, ready: status.blockers.length === 0 };
  }

  indexPersistenceStatus() {
    if (this.backend === "file") {
      return { backend: "file", key: this.indexFile, initialized: true, transactionSafe: true, scope: "single_process" };
    }
    if (this.backend === "oss") {
      return {
        backend: "oss-private-object",
        key: this.indexObjectKey,
        initialized: this.initialized,
        transactionSafe: false,
        scope: "closed_test_single_instance",
        productionBlocker: "OSS JSON object index is not transaction-safe for multi-instance production; migrate the index to a transactional database or object-index service",
      };
    }
    return { backend: this.backend, initialized: this.initialized, transactionSafe: false, scope: "unsupported" };
  }

  async initialize() {
    if (this.backend !== "oss" || this.initialized) return this.indexPersistenceStatus();
    if (!this.initializationPromise) {
      this.initializationPromise = this._initializeOssIndex()
        .then(() => {
          this.initialized = true;
          return this.indexPersistenceStatus();
        })
        .catch((error) => {
          this.initializationError = error;
          throw error;
        });
    }
    return this.initializationPromise;
  }

  async _initializeOssIndex() {
    const config = this._ossConfigBlockers();
    if (!config.ready) throw new Error(config.blockers.join("; "));
    try {
      const response = await this.oss().get(this.indexObjectKey);
      const parsed = JSON.parse(Buffer.from(response.content || response).toString("utf8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OSS object index must be a JSON object");
      this.index = parsed;
    } catch (error) {
      if (!this._isNotFound(error)) throw error;
      // A newly enabled OSS backend can bootstrap from the old local index
      // once. Do not silently overwrite an existing remote index.
      this.index = readIndex(this.indexFile);
      if (Object.keys(this.index).length > 0) await this._writeOssIndex(this.index);
    }
  }

  _isNotFound(error) {
    return error?.code === "NoSuchKey" || error?.status === 404 || error?.statusCode === 404 || error?.statusCode === "404";
  }

  async _writeOssIndex(index) {
    const body = Buffer.from(JSON.stringify(index));
    const client = this.oss();
    await client.put(this.indexObjectKey, body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, max-age=0, no-store",
        "x-oss-object-acl": "private",
      },
    });
    await client.putACL(this.indexObjectKey, "private");
  }

  persistIndex() {
    if (this.backend === "file") {
      writeIndex(this.indexFile, this.index);
      return Promise.resolve();
    }
    if (this.backend !== "oss") return Promise.reject(new Error(`unsupported OBJECT_STORAGE_BACKEND=${this.backend}`));
    const snapshot = { ...this.index };
    // Each mutation takes this queue before changing the in-memory index, so
    // this queue also documents and enforces the single-instance contract.
    return this._writeOssIndex(snapshot);
  }

  withMutation(operation) {
    const run = this.mutationQueue.catch(() => {}).then(operation);
    this.mutationQueue = run.catch(() => {});
    return run;
  }

  oss() {
    if (!this.client) {
      const status = this._ossConfigBlockers();
      if (!status.ready) throw new Error(status.blockers.join("; "));
      this.client = new OSS({
        accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
        accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
        bucket: this.bucket,
        region: this.region,
        secure: true,
      });
    }
    return this.client;
  }

  async putBuffer(buffer, { ownerId, contentType = "application/octet-stream", ext = ".bin", purpose = "unknown", metadata = {}, retainSeconds = this.ttlSeconds } = {}) {
    if (!ownerId) throw new Error("所有对象必须绑定 ownerId");
    await this.initialize();
    return this.withMutation(async () => {
      const objectId = id();
      const normalizedExt = extension(ext);
      const createdAt = Date.now();
      const expiresAt = createdAt + Math.max(60, Number(retainSeconds)) * 1000;
      const key = `${this.prefix}/${objectId}${normalizedExt}`;
      const record = {
        id: objectId,
        key,
        ownerId,
        contentType,
        ext: normalizedExt,
        size: buffer.length,
        purpose,
        createdAt: new Date(createdAt).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
        deletedAt: null,
        metadata: { ...metadata },
      };

      if (this.backend === "oss") {
        await this.oss().put(key, buffer, { headers: { "Content-Type": contentType, "Cache-Control": "private, max-age=0, no-store" } });
        try {
          await this.oss().putACL(key, "private");
        } catch (error) {
          await this.oss().delete(key).catch(() => {});
          throw error;
        }
      } else if (this.backend === "file") {
        const filePath = path.join(this.root, `${objectId}${normalizedExt}`);
        const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        fs.writeFileSync(temporary, buffer, { mode: 0o600 });
        fs.renameSync(temporary, filePath);
      } else {
        throw new Error(`unsupported OBJECT_STORAGE_BACKEND=${this.backend}`);
      }

      this.index[objectId] = record;
      try {
        await this.persistIndex();
      } catch (error) {
        delete this.index[objectId];
        if (this.backend === "oss") await this.oss().delete(key).catch(() => {});
        else fs.rmSync(path.join(this.root, `${objectId}${normalizedExt}`), { force: true });
        throw error;
      }
      return { ...record };
    });
  }

  async putFile(filePath, options = {}) {
    const buffer = fs.readFileSync(filePath);
    return this.putBuffer(buffer, options);
  }

  async putFromUrl(url, options = {}) {
    const buffer = await fetchRemoteBuffer(url, { purpose: "供应商结果", timeoutMs: process.env.OBJECT_FETCH_TIMEOUT_MS });
    return this.putBuffer(buffer, options);
  }

  get(objectId) {
    const record = this.index[objectId];
    return record && !record.deletedAt && Date.parse(record.expiresAt) > Date.now() ? { ...record } : null;
  }

  async read(objectId) {
    await this.initialize();
    const record = this.get(objectId);
    if (!record) return null;
    if (this.backend === "oss") {
      const response = await this.oss().get(record.key);
      return { record, buffer: Buffer.from(response.content) };
    }
    const filePath = path.join(this.root, `${record.id}${record.ext}`);
    if (!fs.existsSync(filePath)) return null;
    return { record, buffer: fs.readFileSync(filePath) };
  }

  async readRange(objectId, start, end) {
    await this.initialize();
    const record = this.get(objectId);
    if (!record) return null;
    const first = Number(start);
    const last = Number(end);
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= record.size) {
      throw new Error("INVALID_OBJECT_RANGE");
    }
    if (this.backend === "oss") {
      const response = await this.oss().get(record.key, { headers: { Range: `bytes=${first}-${last}` } });
      return { record, buffer: Buffer.from(response.content) };
    }
    const filePath = path.join(this.root, `${record.id}${record.ext}`);
    if (!fs.existsSync(filePath)) return null;
    const length = last - first + 1;
    const buffer = Buffer.allocUnsafe(length);
    const descriptor = fs.openSync(filePath, "r");
    try {
      const bytesRead = fs.readSync(descriptor, buffer, 0, length, first);
      if (bytesRead !== length) throw new Error("OBJECT_RANGE_READ_INCOMPLETE");
    } finally {
      fs.closeSync(descriptor);
    }
    return { record, buffer };
  }

  async signedUrl(objectId, { ownerId, base, ttlSeconds = this.ttlSeconds } = {}) {
    const record = this.get(objectId);
    if (!record || (ownerId && record.ownerId !== ownerId)) return null;
    const remaining = Math.max(1, Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1000));
    const ttl = Math.min(Math.max(1, Number(ttlSeconds)), remaining);
    // Keep one application-level contract for file and OSS backends. The bucket
    // remains private; providers receive a short-lived signed application URL.
    return `${baseUrl(base)}/api/objects/${encodeURIComponent(objectId)}?token=REDACTED_SECRET Date.now() + ttl * 1000))}`;
  }

  async providerUrl(objectId, { ownerId, base, ttlSeconds = 900 } = {}) {
    const record = this.get(objectId);
    if (!record || !ownerId || record.ownerId !== ownerId) return null;
    const remaining = Math.floor((Date.parse(record.expiresAt) - Date.now()) / 1000);
    if (remaining < 1) return null;
    const requested = Number(ttlSeconds);
    const ttl = Math.min(900, Math.max(1, Number.isFinite(requested) ? requested : 900), remaining);
    if (this.backend === "oss") {
      const signed = this.oss().signatureUrl(record.key, { method: "GET", expires: ttl });
      const parsed = new URL(String(signed));
      parsed.protocol = "https:";
      return parsed.toString();
    }
    if (this.backend === "file") return this.signedUrl(objectId, { ownerId, base, ttlSeconds: ttl });
    return null;
  }

  configuredOssObjectKey(sourceUrl) {
    if (this.backend !== "oss" || !this.bucket || !this.region) {
      throw new Error("configured OSS bucket is unavailable");
    }
    let parsed;
    try {
      parsed = new URL(String(sourceUrl || ""));
    } catch {
      throw new Error("configured OSS bucket URL is invalid");
    }
    const expectedHost = `${this.bucket}.${this.region}.aliyuncs.com`.toLowerCase();
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.hostname.toLowerCase() !== expectedHost || parsed.port || parsed.username || parsed.password) {
      throw new Error("template URL must belong to the configured OSS bucket");
    }
    if (parsed.search || parsed.hash) throw new Error("configured OSS bucket URL must be canonical");
    let key;
    try {
      key = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
    } catch {
      throw new Error("configured OSS bucket object key is invalid");
    }
    if (!key || key.includes("\0") || key.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("configured OSS bucket object key is invalid");
    }
    return key;
  }

  async protectConfiguredOssObject(sourceUrl) {
    await this.initialize();
    const key = this.configuredOssObjectKey(sourceUrl);
    if (!this.protectedConfiguredKeys.has(key)) {
      await this.oss().putACL(key, "private");
      this.protectedConfiguredKeys.add(key);
    }
    return key;
  }

  async providerUrlForConfiguredOssObject(sourceUrl, { ttlSeconds = 900 } = {}) {
    const key = await this.protectConfiguredOssObject(sourceUrl);
    const requested = Number(ttlSeconds);
    const ttl = Math.min(900, Math.max(1, Number.isFinite(requested) ? requested : 900));
    const signed = this.oss().signatureUrl(key, { method: "GET", expires: ttl });
    const parsed = new URL(String(signed));
    parsed.protocol = "https:";
    return parsed.toString();
  }

  verifyDownload(objectId, token) {
    const record = this.get(objectId);
    if (!record || Date.parse(record.expiresAt) <= Date.now()) return null;
    return verifyToken(objectId, token) ? { ...record } : null;
  }

  assertOwnedReference(reference, ownerId) {
    const value = String(reference || "");
    if (/^obj_[0-9a-f-]{36}$/i.test(value)) {
      const record = this.get(value);
      if (!record || record.ownerId !== ownerId) throw new Error("OBJECT_NOT_OWNED");
      return record;
    }
    let parsed;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error("INVALID_OBJECT_REFERENCE");
    }
    const match = /^\/api\/objects\/(obj_[0-9a-f-]{36})$/i.exec(parsed.pathname);
    if (!match) throw new Error("EXTERNAL_OBJECT_REFERENCE_NOT_ALLOWED");
    const record = this.get(match[1]);
    if (!record || record.ownerId !== ownerId || !verifyToken(record.id, parsed.searchParams.get("token"))) throw new Error("OBJECT_NOT_OWNED");
    return record;
  }

  async delete(objectId, { ownerId, reason = "user_request" } = {}) {
    await this.initialize();
    return this.withMutation(async () => {
      const record = this.index[objectId];
      if (!record || record.deletedAt) return { deleted: false, missing: true };
      if (ownerId && record.ownerId !== ownerId) throw new Error("OBJECT_NOT_OWNED");
      if (this.backend === "oss") await this.oss().delete(record.key);
      else fs.rmSync(path.join(this.root, `${record.id}${record.ext}`), { force: true });
      record.deletedAt = new Date().toISOString();
      record.deleteReason = reason;
      this.index[objectId] = record;
      await this.persistIndex();
      return { deleted: true, objectId, reason };
    });
  }

  listOwned(ownerId) {
    return Object.values(this.index).filter((record) => record.ownerId === ownerId && !record.deletedAt && Date.parse(record.expiresAt) > Date.now()).map((record) => ({ ...record }));
  }

  async deleteOwned(ownerId, reason = "account_deleted", { beforeDelete } = {}) {
    const records = Object.values(this.index).filter((record) => record.ownerId === ownerId && !record.deletedAt);
    const results = [];
    for (const record of records) {
      const supplierDeletion = beforeDelete ? await beforeDelete(record) : null;
      results.push({ ...(await this.delete(record.id, { ownerId, reason })), supplierDeletion });
    }
    return results;
  }

  async sweep(now = Date.now(), { beforeDelete } = {}) {
    const expired = Object.values(this.index).filter((record) => !record.deletedAt && Date.parse(record.expiresAt) <= now);
    const deleted = [];
    const failures = [];
    const supplierPending = [];
    for (const record of expired) {
      try {
        const supplierDeletion = beforeDelete ? await beforeDelete(record) : null;
        await this.delete(record.id, { reason: "retention_expired" });
        deleted.push(record.id);
        if (supplierDeletion && supplierDeletion.status !== "confirmed") {
          supplierPending.push({ objectId: record.id, provider: supplierDeletion.provider, status: supplierDeletion.status });
        }
      } catch (error) {
        failures.push({ objectId: record.id, message: error.message });
      }
    }
    return { scanned: Object.keys(this.index).length, expired: expired.length, deleted, failures, supplierPending };
  }
}

export const objectStore = new PrivateObjectStore();

export function storageConfig() {
  const bucketAudit = bucketAuditReadiness();
  const backendStatus = objectStore.ready();
  return {
    backend: objectStore.backend,
    ttlSeconds: objectStore.ttlSeconds,
    objectIndex: objectStore.indexPersistenceStatus(),
    readiness: { ...backendStatus, blockers: [...backendStatus.blockers, ...bucketAudit.blockers] },
    bucketAudit,
    signingSecretConfigured: Boolean(process.env.OBJECT_SIGNING_SECRET || process.env.AUTH_SESSION_SECRET),
  };
}
