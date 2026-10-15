import fs from "node:fs";
import path from "node:path";
import { logSecurity, sanitizeDetails, sanitizeText, safeError } from "./security-log.js";
import { createMetricsPersistence } from "./metrics-persistence.js";

const counters = new Map();
const timings = new Map();
const alerts = [];
const HTTP_BUCKET_MS = 60_000;
const DEFAULT_RETENTION_MINUTES = 24 * 60;
const MAX_RETENTION_MINUTES = 7 * 24 * 60;
const httpBuckets = new Map();
const MAX_METRIC_KEYS = 300;
const backend = process.env.METRICS_BACKEND || "memory";
let client;
if (backend === "oss") {
  if (process.env.DEPLOY_ENV !== "staging") throw new Error("OSS metrics snapshots are staging-only");
  if (!process.env.ALIYUN_ACCESS_KEY_ID || !process.env.ALIYUN_ACCESS_KEY_SECRET || !process.env.OSS_BUCKET || !process.env.OSS_REGION) throw new Error("OSS metrics configuration missing");
  const { default: OSS } = await import("ali-oss");
  client = new OSS({ accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID, accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET, bucket: process.env.OSS_BUCKET, region: process.env.OSS_REGION, secure: true, timeout: 5000 });
}
const persistence = createMetricsPersistence({ backend, deployEnv: process.env.DEPLOY_ENV, filePath: process.env.METRICS_SNAPSHOT_PATH, client, getSnapshot: () => {
  trimHttpBuckets();
  return { version: 1, counters: [...counters], timings: [...timings], httpBuckets: [...httpBuckets], alerts: [...alerts] };
} });
const restored = await persistence.restore();
if (restored) {
  for (const [name, count] of restored.counters) counters.set(name, count);
  for (const [name, samples] of restored.timings) timings.set(name, samples);
  for (const [time, bucket] of restored.httpBuckets) httpBuckets.set(time, bucket);
  alerts.push(...restored.alerts);
}
export const flushMetrics = () => persistence.flush();
export const metricsPersistenceState = () => persistence.state();

function metricName(name, map) {
  const candidate = sanitizeText(name, 200);
  const safe = ["__proto__", "constructor", "prototype"].includes(candidate) ? "other" : candidate;
  return map.has(safe) || map.size < MAX_METRIC_KEYS - 1 ? safe : "other";
}

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function retentionMinutes() {
  return boundedInteger(process.env.METRICS_RETENTION_MINUTES, DEFAULT_RETENTION_MINUTES, 60, MAX_RETENTION_MINUTES);
}

function canonicalRoute(value) {
  const route = String(value || "unmatched").split("?", 1)[0].trim();
  if (!route || route === "*") return "unmatched";
  const normalized = route
    .split("/")
    .map((segment, index) => index === 0 && segment === "" ? "" : segment.startsWith(":") || segment === "*" ? segment : /^[A-Za-z0-9._~-]{1,80}$/.test(segment) ? segment : ":param")
    .join("/")
    .slice(0, 160);
  return normalized || "unmatched";
}

function trimHttpBuckets(now = Date.now()) {
  const oldest = now - retentionMinutes() * 60_000;
  for (const [bucketStart] of httpBuckets) {
    if (bucketStart < oldest) httpBuckets.delete(bucketStart);
  }
  while (httpBuckets.size > MAX_RETENTION_MINUTES + 2) {
    const first = httpBuckets.keys().next().value;
    if (first === undefined) break;
    httpBuckets.delete(first);
  }
}

export function increment(name, amount = 1) {
  if (!Number.isFinite(amount) || amount < 0) return;
  const key = metricName(name, counters);
  counters.set(key, Math.min(Number.MAX_SAFE_INTEGER, (counters.get(key) || 0) + amount));
  persistence.changed();
}

export function observe(name, milliseconds) {
  if (!Number.isFinite(milliseconds)) return;
  const key = metricName(name, timings);
  const list = timings.get(key) || [];
  list.push(Math.min(600_000, Math.max(0, Math.round(milliseconds))));
  if (list.length > 500) list.shift();
  timings.set(key, list);
  persistence.changed();
}

/**
 * Record an HTTP observation in bounded minute buckets. Route names must be
 * registered Hono route paths; the fallback is deliberately one bucket so a
 * user-controlled URL cannot create unbounded metric cardinality.
 */
export function observeHttp({ method, route, status, milliseconds, now = Date.now() } = {}) {
  const safeMethod = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"].includes(String(method || "").toUpperCase())
    ? String(method).toUpperCase()
    : "OTHER";
  const safeRoute = canonicalRoute(route);
  const latency = Math.max(0, Math.min(600_000, Math.round(Number(milliseconds) || 0)));
  const observedAt = Number.isFinite(Number(now)) && Number(now) >= 0 && Number(now) <= Date.now() + 60_000 ? Number(now) : Date.now();
  const numericStatus = Number(status);
  const bucketStart = Math.floor(observedAt / HTTP_BUCKET_MS) * HTTP_BUCKET_MS;
  const current = httpBuckets.get(bucketStart) || {
    timestamp: new Date(bucketStart).toISOString(),
    requests: 0,
    errors5xx: 0,
    totalLatencyMs: 0,
    routeCounts: {},
  };
  current.requests += 1;
  if (Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599) {
    increment(`http.status.${numericStatus}`);
    if (numericStatus >= 500) current.errors5xx += 1;
  }
  current.totalLatencyMs += latency;
  const requestedKey = `${safeMethod} ${safeRoute}`.slice(0, 180);
  const routeKey = Object.hasOwn(current.routeCounts, requestedKey) || Object.keys(current.routeCounts).length < MAX_METRIC_KEYS - 1 ? requestedKey : "OTHER unmatched";
  current.routeCounts[routeKey] = Math.min(1_000_000, Number(current.routeCounts[routeKey] || 0) + 1);
  httpBuckets.set(bucketStart, current);
  trimHttpBuckets(observedAt);
  increment(`http.${safeMethod}.${safeRoute}`);
  observe(`http.${safeMethod} ${safeRoute}`, latency);
}

export function alertMetric(name, details = {}) {
  const alert = { name: sanitizeText(name, 200), details: sanitizeDetails(details), createdAt: new Date().toISOString() };
  alerts.push(alert);
  if (alerts.length > 100) alerts.shift();
  persistence.changed();
  logSecurity("alert", name, alert.details);
  if (process.env.METRICS_LOG_PATH) {
    try {
      fs.mkdirSync(path.dirname(process.env.METRICS_LOG_PATH), { recursive: true });
      fs.appendFileSync(process.env.METRICS_LOG_PATH, `${JSON.stringify({ level: "alert", ...alert })}\n`, { mode: 0o600 });
    } catch (error) {
      logSecurity("alert", "metrics.log_write_failed", safeError(error));
    }
  }
  return alert;
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)];
}

export function snapshot() {
  const now = Date.now();
  trimHttpBuckets(now);
  const retention = retentionMinutes();
  const oldest = now - retention * 60_000;
  const httpSeries = [...httpBuckets.entries()]
    .filter(([bucketStart]) => bucketStart >= oldest)
    .sort(([left], [right]) => left - right)
    .map(([bucketStart, bucket]) => ({
      timestamp: new Date(bucketStart).toISOString(),
      requests: bucket.requests,
      errors5xx: bucket.errors5xx,
      avgLatencyMs: bucket.requests ? Math.round(bucket.totalLatencyMs / bucket.requests) : 0,
      routeCounts: { ...bucket.routeCounts },
    }));
  const httpRequests = httpSeries.reduce((total, point) => total + point.requests, 0);
  const http5xx = httpSeries.reduce((total, point) => total + point.errors5xx, 0);
  const httpLatencyTotal = httpSeries.reduce((total, point) => total + point.avgLatencyMs * point.requests, 0);
  return {
    counters: Object.fromEntries(counters),
    p95Ms: Object.fromEntries([...timings.entries()].map(([key, values]) => [key, percentile(values, 0.95)])),
    alerts: [...alerts],
    http: {
      source: persistence.state().backend,
      bucketSeconds: HTTP_BUCKET_MS / 1000,
      retentionMinutes: retention,
      windowStart: new Date(oldest).toISOString(),
      windowEnd: new Date(now).toISOString(),
      requests: httpRequests,
      errors5xx: http5xx,
      avgLatencyMs: httpRequests ? Math.round(httpLatencyTotal / httpRequests) : 0,
      series: httpSeries,
    },
    capturedAt: new Date().toISOString(),
    persistence: persistence.state(),
  };
}

export function resetMetricsForTests() {
  counters.clear();
  timings.clear();
  alerts.length = 0;
  httpBuckets.clear();
  persistence.changed();
}
