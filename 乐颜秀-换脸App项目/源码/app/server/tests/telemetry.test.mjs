import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-telemetry-"));
const complianceFile = path.join(tempRoot, "compliance.json");
const adminFile = path.join(tempRoot, "admin-console.json");
const now = new Date().toISOString();

process.env.NODE_ENV = "test";
process.env.DEPLOY_ENV = "test";
process.env.CLOSED_TEST_MODE = "true";
process.env.COMPLIANCE_STORE_FILE = complianceFile;
process.env.ADMIN_STORE_FILE = adminFile;
process.env.START_SERVER = "false";
process.env.ADMIN_USERNAME = "telemetry-admin";
process.env.ADMIN_PASSWORD = "Telemetry-Admin-2026!";
process.env.ADMIN_SESSION_SECRET = "telemetry-test-session-secret-2026-09-13-strong";
process.env.METRICS_RETENTION_MINUTES = "60";
process.env.ALERT_HTTP_5XX_MIN_REQUESTS = "2";
process.env.ALERT_HTTP_5XX_RATE = "0.4";
process.env.ALERT_P95_MS = "50";

function hashAdminPassword(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

process.env.ADMIN_USERS_JSON = JSON.stringify([{
  username: "telemetry-admin",
  displayName: "Telemetry Test Admin",
  role: "owner",
  passwordHash: hashAdminPassword(process.env.ADMIN_PASSWORD),
}]);

// This fixture represents a pre-admin-console ledger: generation entries had
// no purpose or status fields. The analytics code must keep them visible.
fs.writeFileSync(complianceFile, JSON.stringify({
  schemaVersion: 1,
  users: { user_legacy: { id: "user_legacy", status: "active" } },
  entitlements: { user_legacy: { trialRemaining: 4, purchasedRemaining: 0, updatedAt: now } },
  ledger: [{ id: "led_legacy", userId: "user_legacy", type: "consume", amount: -1, unit: "creation", reason: "generation", referenceId: "legacy-generation", createdAt: now }],
  usageEvents: [],
}), { mode: 0o600 });

const { resetMetricsForTests, observeHttp, alertMetric, snapshot } = await import("../metrics.js");
const { monitoringSnapshot } = await import("../monitoring.js");
const { store } = await import("../compliance-store.js");
const { app } = await import("../index.js");

test("HTTP telemetry is bounded, route-labelled and produces threshold incidents", () => {
  resetMetricsForTests();
  observeHttp({ method: "GET", route: "/api/items/:id", status: 200, milliseconds: 20 });
  observeHttp({ method: "GET", route: "/api/items/:id", status: 500, milliseconds: 120 });
  alertMetric("provider.budget_circuit_open", { token: "should-not-leak", globalUsage: 5 });

  const raw = snapshot();
  assert.equal(raw.http.requests, 2);
  assert.equal(raw.http.errors5xx, 1);
  assert.equal(raw.http.series.length, 1);
  assert.equal(raw.http.series[0].routeCounts["GET /api/items/:id"], 2);
  assert.equal(raw.alerts[0].details.token, "[REDACTED]");

  const monitor = monitoringSnapshot();
  assert.equal(monitor.status, "ALERT");
  assert.ok(monitor.incidents.some((item) => item.key === "http.5xx-rate" && item.severity === "high"));
  assert.ok(monitor.incidents.some((item) => item.key === "provider.budget_circuit_open" && item.severity === "high"));
  assert.ok(monitor.incidents.some((item) => item.key === "http.slow:GET /api/items/:id"));
  assert.ok(monitor.playbooks.every((item) => item.isPlan === true && item.status === "预案"));
});

test("generation analytics preserves legacy rows and separates success, refund and pending", () => {
  const success = store.confirmCreation("user_legacy", "legacy-generation");
  assert.equal(success, true);

  store.reserveCreation("user_legacy", "photo-effect-1", "photo-effect:portrait");
  store.confirmCreation("user_legacy", "photo-effect-1", "photo-effect:portrait");
  store.reserveCreation("user_legacy", "video-fusion-1", "video-fusion");
  store.refundCreation("user_legacy", "video-fusion-1", "provider_failed");
  store.reserveCreation("user_legacy", "photo-bg-1", "photo-bg:westlake");

  const analytics = store.generationAnalytics({ days: 7, now: Date.now() });
  const seven = analytics.windows["7"];
  assert.equal(seven.calls, 4);
  assert.equal(seven.successes, 2);
  assert.equal(seven.refunds, 1);
  assert.equal(seven.pending, 1);
  assert.equal(seven.daily.length, 7);
  assert.ok(seven.byPurpose.some((item) => item.purpose === "unknown" && item.successes === 1));
  assert.ok(seven.byPurpose.some((item) => item.purpose === "video-fusion" && item.refunds === 1));
  assert.ok(seven.byPurpose.some((item) => item.purpose === "photo-effect:portrait" && item.successes === 1));
  assert.ok(seven.byPurpose.some((item) => item.purpose === "photo-bg:westlake" && item.pending === 1));
  assert.equal(seven.byPurpose.find((item) => item.purpose === "photo-effect:portrait").successRate, 1);
  assert.equal(seven.byPurpose.find((item) => item.purpose === "video-fusion").successRate, 0);
  assert.equal(seven.byPurpose.find((item) => item.purpose === "photo-bg:westlake").successRate, 0);
  assert.equal(analytics.windows["30"].calls, 4);
});

test("admin dashboard exposes real analytics and monitoring structures", async () => {
  const sessionResponse = await app.request("/api/admin/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "telemetry-admin", password: process.env.ADMIN_PASSWORD }),
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();
  const cookie = String(sessionResponse.headers.get("set-cookie") || "").split(";", 1)[0];
  const dashboardResponse = await app.request("/api/admin/dashboard", { headers: { Cookie: cookie } });
  assert.equal(dashboardResponse.status, 200);
  const dashboard = await dashboardResponse.json();
  assert.ok(dashboard.data.analytics.windows["7"]);
  assert.ok(Array.isArray(dashboard.data.analytics.windows["7"].daily));
  assert.ok(Array.isArray(dashboard.data.service.series));
  assert.ok(Array.isArray(dashboard.data.service.incidents));
  assert.ok(dashboard.data.service.playbooks.every((item) => item.isPlan === true));

  const monitoringResponse = await app.request("/api/admin/monitoring", { headers: { Cookie: cookie } });
  assert.equal(monitoringResponse.status, 200);
  const monitoring = await monitoringResponse.json();
  assert.ok(monitoring.data.service.readiness);
  assert.ok(monitoring.data.analytics.windows["30"]);
  assert.ok(session.data.csrfToken);
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
