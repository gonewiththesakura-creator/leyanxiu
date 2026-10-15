import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leyanxiu-admin-workflow-"));
process.env.DEPLOY_ENV = "test";
process.env.NODE_ENV = "test";
process.env.ADMIN_WORKFLOW_STORE_FILE = path.join(tempRoot, "admin-workflows.json");

const { workflowStore, adminWorkflowStoreReadiness } = await import("../admin-workflow-store.js");

function request(overrides = {}) {
  return {
    type: "capability",
    name: "新图片能力",
    desiredOutcome: "让用户可以一键获得可预览、可分享的图片效果",
    businessOwner: "产品负责人",
    providerHint: "阿里云百炼 / qwen-image",
    riskLevel: "medium",
    notes: "先做小流量质量验证",
    actor: "需求提交人",
    ...overrides,
  };
}

test("workflow store validates create fields and stays closed-test only", () => {
  assert.equal(adminWorkflowStoreReadiness().status, "CLOSED_TEST");
  assert.equal(adminWorkflowStoreReadiness().backend, "local-json");
  assert.equal(adminWorkflowStoreReadiness().productionSupported, false);

  const item = workflowStore.create(request());
  assert.match(item.id, /^req_[0-9a-f-]{36}$/i);
  assert.equal(item.status, "submitted");
  assert.equal(item.revision, 1);
  assert.equal(workflowStore.list({ type: "capability" }).length, 1);
  assert.equal(JSON.parse(fs.readFileSync(process.env.ADMIN_WORKFLOW_STORE_FILE, "utf8")).requests[item.id].id, item.id);
  assert.equal(fs.readdirSync(tempRoot).some((name) => name.endsWith(".tmp")), false);

  assert.throws(() => workflowStore.create(request({ type: "unknown" })), (error) => error.code === "INVALID_ENUM");
  assert.throws(() => workflowStore.create(request({ status: "ready" })), (error) => error.code === "INVALID_INITIAL_STATUS");
  assert.throws(() => workflowStore.create(request({ providerHint: "provider api_key=secret-value" })), (error) => error.code === "PROVIDER_HINT_SECRET_REJECTED");
  assert.throws(() => workflowStore.create(request({ desiredOutcome: "短" })), (error) => error.code === "INVALID_FIELD");
});

test("workflow store enforces the one-way status state machine", () => {
  const item = workflowStore.create(request({ type: "video_template", name: "新视频模板" }));
  assert.throws(() => workflowStore.update({ id: item.id, expectedRevision: 1, patch: { status: "ready" } }), (error) => error.code === "INVALID_STATUS_TRANSITION");

  const reviewed = workflowStore.update({ id: item.id, expectedRevision: 1, patch: { status: "technical_review" }, actor: "技术评审" });
  const integrated = workflowStore.update({ id: item.id, expectedRevision: reviewed.revision, patch: { status: "integration" }, actor: "研发" });
  const validating = workflowStore.update({ id: item.id, expectedRevision: integrated.revision, patch: { status: "quality_validation" }, actor: "测试" });
  const ready = workflowStore.update({ id: item.id, expectedRevision: validating.revision, patch: { status: "ready" }, actor: "验收人" });
  assert.equal(ready.status, "ready");
  assert.throws(() => workflowStore.update({ id: item.id, expectedRevision: ready.revision, patch: { status: "technical_review" } }), (error) => error.code === "INVALID_STATUS_TRANSITION");

  const rejected = workflowStore.create(request({ type: "photo_effect", name: "待评估效果", riskLevel: "high" }));
  const rejectedResult = workflowStore.update({ id: rejected.id, expectedRevision: 1, patch: { status: "rejected", notes: "授权风险未解决" }, actor: "审核人" });
  assert.equal(rejectedResult.status, "rejected");
  assert.throws(() => workflowStore.update({ id: rejected.id, expectedRevision: rejectedResult.revision, patch: { status: "submitted" } }), (error) => error.code === "INVALID_STATUS_TRANSITION");
});

test("workflow store detects stale revisions and exposes append-only audit history", () => {
  const item = workflowStore.create(request({ type: "visual_asset", name: "后台贴图资产" }));
  const updated = workflowStore.update({ id: item.id, expectedRevision: 1, patch: { notes: "补充版权凭证后进入技术评审" }, actor: "运营" });
  assert.equal(updated.revision, 2);
  assert.throws(() => workflowStore.update({ id: item.id, expectedRevision: 1, patch: { notes: "过期写入" } }), (error) => error.code === "REVISION_CONFLICT");
  assert.throws(() => workflowStore.update({ id: item.id, expectedRevision: 2, patch: { type: "capability" } }), (error) => error.code === "IMMUTABLE_FIELD");

  const audits = workflowStore.audits({ requestId: item.id, limit: 20 });
  assert.equal(audits.length, 2);
  assert.equal(audits[0].action, "workflow.updated");
  assert.equal(audits[1].action, "workflow.created");
  assert.notEqual(audits[0].hash, audits[1].hash);
  assert.equal(workflowStore.auditIntegrity().ok, true);

  audits[0].changes.after.notes = "客户端篡改尝试";
  assert.notEqual(workflowStore.audits({ requestId: item.id })[0].changes.after.notes, "客户端篡改尝试");
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test("risk actions persist ownership, resolution, notes and immutable audit history", async () => {
  const observed = [{ id: "incident:http.slow:/api/create", title: "慢接口", severity: "high", impact: "制作等待", action: "检查下游", prevention: "设置超时", firstSeen: new Date().toISOString() }];
  const initial = workflowStore.risks(observed).items[0];
  assert.equal(initial.revision, 0);
  const claimed = workflowStore.actOnRisk({ incidentId: initial.id, expectedRevision: 0, action: "claim", note: "开始排查", actor: "operator" }, observed);
  assert.equal(claimed.assignee, "operator");
  assert.equal(claimed.status, "investigating");
  assert.throws(() => workflowStore.actOnRisk({ incidentId: initial.id, expectedRevision: 0, action: "resolve", note: "过期操作", actor: "reviewer" }, observed), { code: "REVISION_CONFLICT" });
  assert.throws(() => workflowStore.actOnRisk({ incidentId: initial.id, expectedRevision: 1, action: "resolve", note: "", actor: "reviewer" }, observed), { code: "INVALID_FIELD" });
  const resolved = workflowStore.actOnRisk({ incidentId: initial.id, expectedRevision: 1, action: "resolve", note: "根因已修复，延迟恢复", actor: "reviewer" }, observed);
  assert.equal(resolved.status, "resolved");
  const detached = workflowStore.risks([]).items[0];
  assert.equal(detached.observedActive, false);
  assert.equal(detached.status, "resolved");
  const reopened = workflowStore.actOnRisk({ incidentId: initial.id, expectedRevision: 2, action: "reopen", note: "发现同类问题，重新检查", actor: "reviewer" }, []);
  assert.equal(reopened.status, "open");
  const noted = workflowStore.actOnRisk({ incidentId: initial.id, expectedRevision: 3, action: "note", note: "保存排查过程", actor: "operator" }, []);
  assert.equal(noted.notes.length, 4);
  assert.equal(workflowStore.risks([]).audits.length, 4);
  assert.equal(workflowStore.auditIntegrity().ok, true);
  assert.equal(JSON.parse(fs.readFileSync(workflowStore.file, "utf8")).risks[initial.id].revision, 4);
  const reloaded = await import(`../admin-workflow-store.js?risk-reload=${Date.now()}`);
  assert.equal(reloaded.workflowStore.risks([]).items[0].revision, 4);
  assert.equal(reloaded.workflowStore.risks([]).audits.length, 4);
  assert.throws(() => workflowStore.actOnRisk({ incidentId: "fake", expectedRevision: 0, action: "claim", actor: "operator" }, []), { code: "REQUEST_NOT_FOUND" });
});

test("legacy workflow files without risk records load without losing their audit chain", async () => {
  const existing = JSON.parse(fs.readFileSync(workflowStore.file, "utf8"));
  delete existing.risks;
  fs.writeFileSync(workflowStore.file, JSON.stringify(existing));
  const legacy = await import(`../admin-workflow-store.js?legacy-risk=${Date.now()}`);
  assert.deepEqual(legacy.workflowStore.risks([]).items, []);
  assert.equal(legacy.workflowStore.auditIntegrity().ok, true);
});
