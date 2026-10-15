import fs from "node:fs/promises";
import path from "node:path";
import { sanitizeDetails, sanitizeText } from "./security-log.js";

export const METRICS_KEY = "server/stage/metrics.json";
const MAX_BYTES = 12 * 1024 * 1024;
const MAX_KEYS = 300;
const MAX_BUCKETS = 10080;
const number = (value) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const pairs = (value, limit) => Array.isArray(value) && value.length <= limit && value.every((entry) => Array.isArray(entry) && entry.length === 2);

export function validateMetricsSnapshot(value, now = Date.now()) {
  if (value?.version !== 1 || !pairs(value.counters, MAX_KEYS) || !pairs(value.timings, MAX_KEYS) || !pairs(value.httpBuckets, MAX_BUCKETS) || !Array.isArray(value.alerts) || value.alerts.length > 100) throw new Error("Invalid metrics snapshot");
  const key = (name) => typeof name === "string" && name.length <= 200 && !["__proto__", "constructor", "prototype"].includes(name);
  if (!value.counters.every(([name, count]) => key(name) && number(count)) || !value.timings.every(([name, samples]) => key(name) && Array.isArray(samples) && samples.length <= 500 && samples.every(number))) throw new Error("Invalid metrics samples");
  for (const [timestamp, bucket] of value.httpBuckets) {
    if (!number(timestamp) || timestamp > now + 60_000 || !bucket || !number(bucket.requests) || !number(bucket.errors5xx) || bucket.errors5xx > bucket.requests || !number(bucket.totalLatencyMs) || !bucket.routeCounts || typeof bucket.routeCounts !== "object" || Object.keys(bucket.routeCounts).length > MAX_KEYS || !Object.entries(bucket.routeCounts).every(([name, count]) => key(name) && number(count))) throw new Error("Invalid metrics bucket");
  }
  if (!value.alerts.every((alert) => alert && key(alert.name) && Number.isFinite(Date.parse(alert.createdAt)) && Date.parse(alert.createdAt) <= now + 60_000)) throw new Error("Invalid metrics alert");
  return { version: 1, counters: value.counters, timings: value.timings, httpBuckets: value.httpBuckets.filter(([time]) => time >= now - MAX_BUCKETS * 60_000), alerts: value.alerts.filter((alert) => Date.parse(alert.createdAt) >= now - MAX_BUCKETS * 60_000).map((alert) => ({ name: sanitizeText(alert.name, 200), createdAt: alert.createdAt, details: sanitizeDetails(alert.details) })) };
}

export function createMetricsPersistence({ backend = "memory", deployEnv = "", filePath, client, getSnapshot, intervalMs = 10_000 } = {}) {
  if (!["memory", "file", "oss"].includes(backend)) throw new Error("Unsupported metrics backend");
  if (backend === "oss" && deployEnv !== "staging") throw new Error("OSS metrics snapshots are staging-only");
  if (backend === "file" && !filePath) throw new Error("METRICS_SNAPSHOT_PATH is required");
  let timer;
  let dirty = false;
  let initialized = false;
  let failed = false;
  let lastSavedAt = null;
  let queue = Promise.resolve();
  const state = () => ({ backend: backend === "memory" ? "process-memory" : backend, ready: initialized && !failed, durable: backend !== "memory" && initialized && !failed, degraded: failed, pending: dirty, lastSavedAt, maxUnflushedMs: backend === "memory" ? null : intervalMs, note: backend === "memory" ? "实例内存，重启丢失" : "单实例快照；正常运行最多约10秒加存储写入耗时未落盘，故障期间不保证；不支持多实例合并" });
  async function restore() {
    try {
      let content;
      if (backend === "oss") { try { content = (await client.get(METRICS_KEY)).content; } catch (error) { if (error.code !== "NoSuchKey") throw error; } }
      if (backend === "file") { try { content = await fs.readFile(filePath); } catch (error) { if (error.code !== "ENOENT") throw error; } }
      if (content && Buffer.byteLength(content) > MAX_BYTES) throw new Error("Metrics snapshot exceeds size limit");
      const result = content ? validateMetricsSnapshot(JSON.parse(content.toString())) : null;
      initialized = true;
      return result;
    } catch { failed = true; throw new Error("Metrics snapshot restore failed; refusing to overwrite existing state"); }
  }
  async function flush() {
    clearTimeout(timer); timer = undefined;
    const task = queue.then(async () => {
      if (!initialized) throw new Error("Metrics persistence is not initialized");
      if (!dirty || backend === "memory") { dirty = false; return; }
      let content;
      try {
        content = Buffer.from(JSON.stringify(validateMetricsSnapshot(getSnapshot())));
        if (content.length > MAX_BYTES) throw new Error("Metrics snapshot exceeds size limit");
      } catch { failed = true; throw new Error("Metrics snapshot validation failed"); }
      dirty = false;
      try {
        if (backend === "oss") await client.put(METRICS_KEY, content, { headers: { "x-oss-object-acl": "private", "Content-Type": "application/json" } });
        else { await fs.mkdir(path.dirname(filePath), { recursive: true }); await fs.writeFile(`${filePath}.tmp`, content, { mode: 0o600 }); await fs.rename(`${filePath}.tmp`, filePath); }
        failed = false; lastSavedAt = new Date().toISOString();
      } catch { dirty = true; failed = true; throw new Error("Metrics snapshot save failed"); }
    });
    queue = task.catch(() => {});
    return task;
  }
  function changed() {
    dirty = true;
    if (backend === "memory" || timer) return;
    timer = setTimeout(() => { timer = undefined; void flush().catch(() => {}).finally(() => { if (dirty) changed(); }); }, intervalMs);
    timer.unref?.();
  }
  return { restore, flush, changed, state, close: () => { clearTimeout(timer); timer = undefined; } };
}
