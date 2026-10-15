import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-admin-"));
const ownerPassword = "Owner-Test-2026!";
const operatorPassword = "Operator-Test-2026!";

function passwordHash(password) {
  const salt = crypto.randomBytes(16);
  const digest = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

process.env.START_SERVER = "false";
process.env.NODE_ENV = "test";
process.env.DEPLOY_ENV = "test";
process.env.ADMIN_STORE_FILE = path.join(tempRoot, "admin-console.json");
process.env.ADMIN_WORKFLOW_STORE_FILE = path.join(tempRoot, "admin-workflows.json");
process.env.COMPLIANCE_STORE_FILE = path.join(tempRoot, "compliance.json");
process.env.TASKS_FILE = path.join(tempRoot, "tasks.json");
process.env.TASKS_BACKEND = "file";
process.env.PRIVATE_OBJECT_DIR = path.join(tempRoot, "objects");
process.env.OBJECT_INDEX_FILE = path.join(tempRoot, "objects", "index.json");
process.env.ADMIN_SESSION_SECRET = "test-admin-session-secret-at-least-32-characters";
process.env.ADMIN_USERS_JSON = JSON.stringify([
  { username: "owner-test", displayName: "验收负责人", role: "owner", passwordHash: passwordHash(ownerPassword) },
  { username: "operator-test", displayName: "内容运营", role: "operator", passwordHash: passwordHash(operatorPassword) },
]);

const [{ app }, { corruptPublishedAssetSealForTests, markReleaseUnsealedForTests, migrateAdminStateIntegrityForTests, resetAdminStoreForTests }, { resetWorkflowStoreForTests }] = await Promise.all([
  import("../index.js"),
  import("../admin-store.js"),
  import("../admin-workflow-store.js"),
]);

async function request(url, options = {}) {
  const response = await app.request(url, options);
  const raw = await response.text();
  let body;
  try { body = JSON.parse(raw); } catch { body = raw; }
  return { response, body };
}

function jsonOptions(body, { method = "POST", cookie, csrf } = {}) {
  return {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-CSRF-Token": csrf } : {}),
    },
    body: JSON.stringify(body ?? {}),
  };
}

async function login(username, password) {
  const result = await request("/api/admin/session", jsonOptions({ username, password }));
  return {
    ...result,
    cookie: String(result.response.headers.get("set-cookie") || "").split(";", 1)[0],
    csrf: result.body?.data?.csrfToken,
  };
}

test("admin console protects, validates, publishes and rolls back catalog changes", async () => {
  resetAdminStoreForTests();

  const anonymous = await request("/api/admin/catalog");
  assert.equal(anonymous.response.status, 401);

  const rejected = await login("owner-test", "incorrect-password");
  assert.equal(rejected.response.status, 401);

  const owner = await login("owner-test", ownerPassword);
  assert.equal(owner.response.status, 200);
  assert.equal(owner.body.data.user.role, "owner");
  assert.match(owner.response.headers.get("set-cookie") || "", /HttpOnly/);
  assert.match(owner.response.headers.get("set-cookie") || "", /SameSite=Strict/);

  const operator = await login("operator-test", operatorPassword);
  assert.equal(operator.response.status, 200);
  const operatorPublish = await request("/api/admin/catalog/publish", jsonOptions(
    { expectedRevision: 1, note: "运营越权发布验证" },
    { cookie: operator.cookie, csrf: operator.csrf },
  ));
  assert.equal(operatorPublish.response.status, 403);
  assert.equal(operatorPublish.body.code, "ADMIN_FORBIDDEN");

  const workspace = await request("/api/admin/catalog", { headers: { Cookie: owner.cookie } });
  assert.equal(workspace.response.status, 200);
  assert.deepEqual(workspace.body.data.published.catalog, workspace.body.data.draft.catalog);
  const initialRelease = workspace.body.data.releases.find((release) => release.action === "seed");
  const changedCatalog = structuredClone(workspace.body.data.draft.catalog);
  changedCatalog.settings.productName = "乐颜秀验收版";
  changedCatalog.templates[0].enabled = false;
  changedCatalog.photoCategories[0].enabled = false;

  const validated = await request("/api/admin/catalog/validate", jsonOptions(
    { catalog: changedCatalog },
    { cookie: operator.cookie, csrf: operator.csrf },
  ));
  assert.equal(validated.response.status, 200);
  assert.equal(validated.body.data.valid, true);
  assert.match(validated.body.data.catalogHash, /^[a-f0-9]{64}$/);

  const unsafePreview = structuredClone(changedCatalog);
  unsafePreview.templates[0].cover = "https://example.com/tracking.webp";
  const blockedPreview = await request("/api/admin/catalog/validate", jsonOptions(
    { catalog: unsafePreview },
    { cookie: operator.cookie, csrf: operator.csrf },
  ));
  assert.equal(blockedPreview.response.status, 400);
  assert.equal(blockedPreview.body.code, "INVALID_CATALOG");
  for (const unsafePath of ["/api/admin/catalog.jpg", "/templates/%2e%2e/api/catalog.jpg", "/templates/cover.webp?token=REDACTED_SECRET"]) {
    const unsafeSameOrigin = structuredClone(changedCatalog);
    unsafeSameOrigin.templates[0].cover = unsafePath;
    const rejectedPath = await request("/api/admin/catalog/validate", jsonOptions(
      { catalog: unsafeSameOrigin },
      { cookie: operator.cookie, csrf: operator.csrf },
    ));
    assert.equal(rejectedPath.response.status, 400, unsafePath);
    assert.equal(rejectedPath.body.code, "INVALID_CATALOG", unsafePath);
  }
  const unchangedAfterValidation = await request("/api/admin/catalog", { headers: { Cookie: owner.cookie } });
  assert.equal(unchangedAfterValidation.body.data.draft.revision, workspace.body.data.draft.revision);

  const noCsrf = await request("/api/admin/catalog/draft", jsonOptions(
    { catalog: changedCatalog, expectedRevision: workspace.body.data.draft.revision, note: "缺少校验令牌" },
    { method: "PUT", cookie: owner.cookie },
  ));
  assert.equal(noCsrf.response.status, 403);
  assert.equal(noCsrf.body.code, "ADMIN_CSRF_REJECTED");

  const lowContrast = structuredClone(changedCatalog);
  lowContrast.theme.text = lowContrast.theme.background;
  const invalid = await request("/api/admin/catalog/draft", jsonOptions(
    { catalog: lowContrast, expectedRevision: workspace.body.data.draft.revision, note: "低对比度拦截验证" },
    { method: "PUT", cookie: owner.cookie, csrf: owner.csrf },
  ));
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.code, "LOW_CONTRAST");

  const missingAsset = structuredClone(changedCatalog);
  missingAsset.templates[0].cover = "/templates/not-in-the-library.webp";
  const missing = await request("/api/admin/catalog/draft", jsonOptions(
    { catalog: missingAsset, expectedRevision: workspace.body.data.draft.revision, note: "缺失素材拦截验证" },
    { method: "PUT", cookie: owner.cookie, csrf: owner.csrf },
  ));
  assert.equal(missing.response.status, 400);
  assert.equal(missing.body.code, "INVALID_CATALOG");

  const saved = await request("/api/admin/catalog/draft", jsonOptions(
    { catalog: changedCatalog, expectedRevision: workspace.body.data.draft.revision, note: "自动化草稿验收" },
    { method: "PUT", cookie: owner.cookie, csrf: owner.csrf },
  ));
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.data.dirty, true);

  const beforePublish = await request("/api/catalog");
  assert.notEqual(beforePublish.body.data.settings.productName, "乐颜秀验收版");

  const published = await request("/api/admin/catalog/publish", jsonOptions(
    { expectedRevision: saved.body.data.draft.revision, note: "自动化发布流程验收" },
    { cookie: owner.cookie, csrf: owner.csrf },
  ));
  assert.equal(published.response.status, 200);
  assert.equal(published.body.data.published.version, 2);
  const afterPublish = await request("/api/catalog");
  assert.equal(afterPublish.body.data.settings.productName, "乐颜秀验收版");
  assert.equal(afterPublish.body.data.templates.some((item) => item.id === changedCatalog.templates[0].id), false);
  assert.equal(afterPublish.body.data.photoCategories.some((item) => item.id === changedCatalog.photoCategories[0].id), false);
  assert.equal(afterPublish.body.data.photoEffects.some((item) => item.categoryId === changedCatalog.photoCategories[0].id), false);
  assert.equal(published.body.data.published.catalog.templates.some((item) => item.id === changedCatalog.templates[0].id), true);

  const rolledBack = await request("/api/admin/catalog/rollback", jsonOptions(
    { releaseId: initialRelease.id, note: "自动化回滚流程验收" },
    { cookie: owner.cookie, csrf: owner.csrf },
  ));
  assert.equal(rolledBack.response.status, 200);
  assert.equal(rolledBack.body.data.published.version, 3);
  const afterRollback = await request("/api/catalog");
  assert.equal(afterRollback.body.data.settings.productName, "乐颜秀");

  markReleaseUnsealedForTests(published.body.data.published.releaseId);
  const unsealedRollback = await request("/api/admin/catalog/rollback", jsonOptions(
    { releaseId: published.body.data.published.releaseId, note: "未封印历史版本回滚验证" },
    { cookie: owner.cookie, csrf: owner.csrf },
  ));
  assert.equal(unsealedRollback.response.status, 409);
  assert.equal(unsealedRollback.body.code, "UNSEALED_RELEASE");

  const audits = await request("/api/admin/audits?limit=20", { headers: { Cookie: owner.cookie } });
  assert.equal(audits.response.status, 200);
  assert.ok(audits.body.data.admin.some((entry) => entry.action === "catalog.published"));
  assert.ok(audits.body.data.admin.some((entry) => entry.action === "catalog.rolled_back"));

  const loggedOut = await request("/api/admin/logout", jsonOptions({}, { cookie: owner.cookie, csrf: owner.csrf }));
  assert.equal(loggedOut.response.status, 200);
  const replayedSession = await request("/api/admin/catalog", { headers: { Cookie: owner.cookie } });
  assert.equal(replayedSession.response.status, 401);

  const malformedCookie = await request("/api/admin/me", { headers: { Cookie: "ly_admin_session=%" } });
  assert.equal(malformedCookie.response.status, 401);
});

test("legacy catalogs are sealed once while unknown historical releases stay blocked", () => {
  resetAdminStoreForTests();
  const legacy = JSON.parse(fs.readFileSync(process.env.ADMIN_STORE_FILE, "utf8"));
  const oldRelease = structuredClone(legacy.releases[0]);
  oldRelease.id = "rel_legacy_without_evidence";
  oldRelease.version = 0;
  for (const entry of [legacy.draft, legacy.published, legacy.releases[0], oldRelease]) {
    delete entry.catalogHash;
    delete entry.assetManifest;
    delete entry.integrityStatus;
    delete entry.integritySealedAt;
  }
  legacy.releases.unshift(oldRelease);

  const migrated = migrateAdminStateIntegrityForTests(legacy);
  assert.equal(migrated.draft.integrityStatus, "sealed");
  assert.match(migrated.draft.catalogHash, /^[a-f0-9]{64}$/);
  assert.equal(migrated.published.integrityStatus, "sealed");
  assert.equal(migrated.releases.find((release) => release.id === migrated.published.releaseId).integrityStatus, "sealed");
  assert.equal(migrated.releases.find((release) => release.id === oldRelease.id).integrityStatus, "legacy-unsealed");
});

test("published static assets fail closed when their sealed bytes change", async () => {
  resetAdminStoreForTests();
  const catalog = await request("/api/catalog");
  const cover = catalog.body.data.templates[0].cover;
  const baseline = await request(cover);
  assert.equal(baseline.response.status, 200);

  corruptPublishedAssetSealForTests(cover);
  const blocked = await request(cover);
  assert.equal(blocked.response.status, 503);
  assert.equal(blocked.body.code, "PUBLISHED_ASSET_INTEGRITY_FAILED");
  resetAdminStoreForTests();
});

test("admin capability intake enforces roles, revisions and ordered review", async () => {
  resetWorkflowStoreForTests();
  const owner = await login("owner-test", ownerPassword);
  const operator = await login("operator-test", operatorPassword);

  const created = await request("/api/admin/workflows", jsonOptions({
    type: "video_template",
    name: "新舞蹈风格",
    desiredOutcome: "用户选择照片后生成已验收的舞蹈短视频",
    businessOwner: "内容运营",
    providerHint: "待技术评审",
    riskLevel: "medium",
    notes: "需要版权凭证和三十份独立样本",
  }, { cookie: operator.cookie, csrf: operator.csrf }));
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, "submitted");

  const operatorEscalation = await request(`/api/admin/workflows/${created.body.data.id}`, jsonOptions({
    expectedRevision: created.body.data.revision,
    patch: { status: "technical_review" },
  }, { method: "PATCH", cookie: operator.cookie, csrf: operator.csrf }));
  assert.equal(operatorEscalation.response.status, 403);

  const skippedGate = await request(`/api/admin/workflows/${created.body.data.id}`, jsonOptions({
    expectedRevision: created.body.data.revision,
    patch: { status: "ready" },
  }, { method: "PATCH", cookie: owner.cookie, csrf: owner.csrf }));
  assert.equal(skippedGate.response.status, 400);
  assert.equal(skippedGate.body.code, "INVALID_STATUS_TRANSITION");

  const reviewed = await request(`/api/admin/workflows/${created.body.data.id}`, jsonOptions({
    expectedRevision: created.body.data.revision,
    patch: { status: "technical_review" },
  }, { method: "PATCH", cookie: owner.cookie, csrf: owner.csrf }));
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.data.revision, 2);

  const stale = await request(`/api/admin/workflows/${created.body.data.id}`, jsonOptions({
    expectedRevision: 1,
    patch: { notes: "过期修改" },
  }, { method: "PATCH", cookie: operator.cookie, csrf: operator.csrf }));
  assert.equal(stale.response.status, 409);

  const list = await request("/api/admin/workflows?type=video_template", { headers: { Cookie: owner.cookie } });
  assert.equal(list.response.status, 200);
  assert.equal(list.body.data[0].status, "technical_review");
  const audits = await request(`/api/admin/workflow-audits?workflowId=${encodeURIComponent(created.body.data.id)}`, { headers: { Cookie: owner.cookie } });
  assert.equal(audits.response.status, 200);
  assert.equal(audits.body.data.length, 2);
});

test("risk handling requires authentication, CSRF, role and current revision", async () => {
  resetWorkflowStoreForTests();
  const { alertMetric } = await import("../metrics.js");
  alertMetric("alert.drill", {});
  const anonymous = await request("/api/admin/risks");
  assert.equal(anonymous.response.status, 401);
  const owner = await login("owner-test", ownerPassword);
  const operator = await login("operator-test", operatorPassword);
  const list = await request("/api/admin/risks", { headers: { Cookie: owner.cookie } });
  const item = list.body.data.items.find((entry) => entry.id === "incident:alert-drill");
  assert.equal(item.revision, 0);
  const payload = { incidentId: item.id, expectedRevision: 0, action: "claim", note: "核对演练回执", actor: "forged-owner" };
  const noCsrf = await request("/api/admin/risks/actions", jsonOptions(payload, { cookie: operator.cookie }));
  assert.equal(noCsrf.response.status, 403);
  const claim = await request("/api/admin/risks/actions", jsonOptions(payload, operator));
  assert.equal(claim.response.status, 200);
  assert.equal(claim.body.data.assignee, "operator-test");
  const resolvePayload = { incidentId: item.id, expectedRevision: 1, action: "resolve", note: "演练链路已核对" };
  const forbidden = await request("/api/admin/risks/actions", jsonOptions(resolvePayload, operator));
  assert.equal(forbidden.response.status, 403);
  const resolved = await request("/api/admin/risks/actions", jsonOptions(resolvePayload, owner));
  assert.equal(resolved.response.status, 200);
  assert.equal(resolved.body.data.status, "resolved");
  const stale = await request("/api/admin/risks/actions", jsonOptions(resolvePayload, owner));
  assert.equal(stale.response.status, 409);
  const audit = await request("/api/admin/risks", { headers: { Cookie: owner.cookie } });
  assert.equal(audit.body.data.audits.length, 2);
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});
