import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRODUCTION = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
const DATA_DIR = process.env.ADMIN_WORKFLOW_DATA_DIR || path.join(__dirname, "data");
const STORE_FILE = process.env.ADMIN_WORKFLOW_STORE_FILE || path.join(DATA_DIR, "admin-workflows.json");
const MAX_LIST_LIMIT = 1_000;
const AUDIT_GENESIS = "GENESIS";

export const WORKFLOW_TYPES = Object.freeze([
  "capability",
  "video_template",
  "photo_effect",
  "visual_asset",
]);

export const WORKFLOW_STATUSES = Object.freeze([
  "submitted",
  "technical_review",
  "integration",
  "quality_validation",
  "ready",
  "rejected",
]);

export const WORKFLOW_RISK_LEVELS = Object.freeze(["low", "medium", "high"]);

// Rejected and ready are terminal states. A rejected idea is resubmitted as a new request
// so the old decision and its audit trail remain intact.
export const WORKFLOW_TRANSITIONS = Object.freeze({
  submitted: Object.freeze(["technical_review", "rejected"]),
  technical_review: Object.freeze(["integration", "rejected"]),
  integration: Object.freeze(["quality_validation", "rejected"]),
  quality_validation: Object.freeze(["ready", "rejected"]),
  ready: Object.freeze([]),
  rejected: Object.freeze([]),
});

const CREATE_FIELDS = new Set([
  "type",
  "name",
  "desiredOutcome",
  "businessOwner",
  "providerHint",
  "status",
  "riskLevel",
  "notes",
  "actor",
]);
const UPDATE_FIELDS = new Set([
  "name",
  "desiredOutcome",
  "businessOwner",
  "providerHint",
  "status",
  "riskLevel",
  "notes",
]);
const IMMUTABLE_FIELDS = new Set(["id", "type", "createdAt", "createdBy"]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function now() {
  return new Date().toISOString();
}

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function rejectUnknownFields(value, allowed, label, immutable = new Set()) {
  if (!isPlainObject(value)) fail("INVALID_INPUT", `${label}必须是对象`);
  for (const key of Object.keys(value)) {
    if (immutable.has(key)) fail("IMMUTABLE_FIELD", `${label}不可修改字段：${key}`);
    if (!allowed.has(key)) fail("INVALID_FIELD", `${label}包含不支持的字段：${key}`);
  }
}

function text(value, label, { min = 0, max = 2_000, optional = false, noLineBreak = false } = {}) {
  if (value == null && optional) return "";
  if (typeof value !== "string") fail("INVALID_FIELD", `${label}必须是文本`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) fail("INVALID_FIELD", `${label}需为 ${min}-${max} 个字符`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) fail("INVALID_FIELD", `${label}包含不可用控制字符`);
  if (noLineBreak && /[\r\n]/.test(normalized)) fail("INVALID_FIELD", `${label}不能换行`);
  return normalized;
}

function enumValue(value, values, label) {
  if (typeof value !== "string" || !values.includes(value)) fail("INVALID_ENUM", `${label}取值无效`);
  return value;
}

function actor(value) {
  return text(value == null ? "system" : value, "操作人", { min: 1, max: 120, noLineBreak: true });
}

function requestId(value) {
  const normalized = text(value, "需求编号", { min: 1, max: 80, noLineBreak: true });
  if (!/^req_[0-9a-f-]{36}$/i.test(normalized)) fail("INVALID_ID", "需求编号无效");
  return normalized;
}

function validateProviderHint(value) {
  const normalized = text(value, "供应商/模型提示", { max: 160, optional: true, noLineBreak: true });
  // This field is deliberately only a routing hint. Never persist credentials or bearer material.
  if (/(?:api\s*[_-]?\s*key|access\s*[_-]?\s*key|secret|token|password|credential|authorization|bearer|密钥|令牌|密码|凭据)/i.test(normalized)
    || /\b(?:sk|ak|rk)-[A-Za-z0-9_-]{12,}\b/i.test(normalized)
    || /\bAKIA[0-9A-Z]{16}\b/.test(normalized)
    || /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(normalized)) {
    fail("PROVIDER_HINT_SECRET_REJECTED", "供应商提示只能填写供应商或模型名称，不能填写密钥、令牌或凭据");
  }
  return normalized;
}

function normalizeCreate(input) {
  rejectUnknownFields(input, CREATE_FIELDS, "需求");
  const status = input.status == null ? "submitted" : enumValue(input.status, WORKFLOW_STATUSES, "状态");
  if (status !== "submitted") fail("INVALID_INITIAL_STATUS", "新需求只能从 submitted 状态开始");
  return {
    type: enumValue(input.type, WORKFLOW_TYPES, "需求类型"),
    name: text(input.name, "名称", { min: 2, max: 80, noLineBreak: true }),
    desiredOutcome: text(input.desiredOutcome, "期望结果", { min: 4, max: 2_000 }),
    businessOwner: text(input.businessOwner, "业务负责人", { min: 2, max: 80, noLineBreak: true }),
    providerHint: validateProviderHint(input.providerHint),
    status,
    riskLevel: enumValue(input.riskLevel, WORKFLOW_RISK_LEVELS, "风险等级"),
    notes: text(input.notes, "备注", { max: 2_000, optional: true }),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function auditHash(entry) {
  const { hash: _hash, ...unsigned } = entry;
  return crypto.createHash("sha256").update(canonical(unsigned)).digest("hex");
}

function verifyAuditChain(candidate) {
  let previousHash = AUDIT_GENESIS;
  for (let index = 0; index < candidate.audits.length; index += 1) {
    const entry = candidate.audits[index];
    if (!entry || entry.sequence !== index + 1 || entry.previousHash !== previousHash || entry.hash !== auditHash(entry)) {
      fail("AUDIT_INTEGRITY_FAILURE", "后台需求审计链校验失败，已拒绝加载配置");
    }
    previousHash = entry.hash;
  }
  return true;
}

function initialState() {
  return { schemaVersion: 1, requests: {}, risks: {}, audits: [] };
}

function writeState(nextState) {
  const directory = path.dirname(STORE_FILE);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "w", 0o600);
    const payload = Buffer.from(JSON.stringify(nextState));
    fs.writeFileSync(descriptor, payload);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  try {
    fs.renameSync(temporary, STORE_FILE);
    // Directory fsync is best effort because Windows does not expose it consistently.
    try {
      const directoryDescriptor = fs.openSync(directory, "r");
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } catch {
      // The file rename is still atomic on the same filesystem.
    }
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

function loadState() {
  if (!fs.existsSync(STORE_FILE)) {
    const created = initialState();
    writeState(created);
    return created;
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
  } catch {
    fail("STORE_CORRUPT", "后台需求存储文件无法解析");
  }
  if (!parsed || parsed.schemaVersion !== 1 || !isPlainObject(parsed.requests) || !Array.isArray(parsed.audits)) {
    fail("STORE_CORRUPT", "后台需求存储版本或结构不受支持");
  }
  verifyAuditChain(parsed);
  if (parsed.risks !== undefined && !isPlainObject(parsed.risks)) fail("STORE_CORRUPT", "风险记录结构无效");
  parsed.risks ||= {};
  return parsed;
}

function commit(nextState) {
  writeState(nextState);
  state = nextState;
}

function appendAudit(nextState, { action, request, actor: auditActor, changes }) {
  const entry = {
    id: id("wfa"),
    sequence: nextState.audits.length + 1,
    action,
    requestId: request.id,
    actor: auditActor,
    revision: request.revision,
    createdAt: now(),
    changes: clone(changes),
    previousHash: nextState.audits.at(-1)?.hash || AUDIT_GENESIS,
  };
  entry.hash = auditHash(entry);
  nextState.audits.push(entry);
}

function pickFields(value, fields) {
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

let state = loadState();

export const workflowStore = {
  file: STORE_FILE,

  risks(observed = []) {
    const current = new Map(observed.map((item) => [item.id, item]));
    const ids = new Set([...Object.keys(state.risks), ...current.keys()]);
    const items = [...ids].map((riskId) => {
      const live = current.get(riskId);
      const record = state.risks[riskId];
      return clone({ ...live, ...record, id: riskId, status: record?.status || "open", revision: record?.revision || 0, assignee: record?.assignee || null, notes: record?.notes || [], observedActive: Boolean(live), lastObservedAt: live?.lastSeen || record?.lastSeen || null });
    });
    return { items, audits: state.audits.filter((entry) => entry.action.startsWith("risk.")).slice(-300).reverse().map(clone) };
  },

  actOnRisk(input, observed = []) {
    rejectUnknownFields(input, new Set(["incidentId", "expectedRevision", "action", "note", "actor"]), "风险操作");
    const riskId = text(input.incidentId, "风险编号", { min: 1, max: 300, noLineBreak: true });
    const operation = enumValue(input.action, ["claim", "note", "resolve", "reopen"], "操作");
    const live = observed.find((item) => item.id === riskId);
    const existing = Object.prototype.hasOwnProperty.call(state.risks, riskId) ? state.risks[riskId] : null;
    if (!existing && !live) fail("REQUEST_NOT_FOUND", "风险事件不存在");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) fail("INVALID_REVISION", "风险版本必须为非负整数");
    if (input.expectedRevision !== (existing?.revision || 0)) fail("REVISION_CONFLICT", "风险事件已更新，请刷新后重试");
    const operator = actor(input.actor);
    const note = text(input.note, "处理说明", { min: operation === "claim" ? 0 : 2, max: 2000, optional: operation === "claim" });
    const currentStatus = existing?.status || "open";
    if ((operation === "resolve" && currentStatus === "resolved") || (operation === "reopen" && currentStatus !== "resolved") || (operation === "claim" && currentStatus === "resolved")) fail("INVALID_STATUS_TRANSITION", "当前风险状态不支持此操作");
    const createdAt = now();
    const record = {
      ...clone(existing || live), id: riskId,
      revision: (existing?.revision || 0) + 1,
      status: operation === "resolve" ? "resolved" : operation === "reopen" ? "open" : operation === "claim" ? "investigating" : currentStatus,
      assignee: operation === "claim" ? operator : existing?.assignee || null,
      notes: [...(existing?.notes || []), { action: operation, note, actor: operator, createdAt }],
      updatedAt: createdAt, updatedBy: operator,
      resolvedAt: operation === "resolve" ? createdAt : operation === "reopen" ? null : existing?.resolvedAt || null,
    };
    const nextState = clone(state);
    nextState.risks[riskId] = record;
    appendAudit(nextState, { action: `risk.${operation}`, request: record, actor: operator, changes: { before: existing ? { status: existing.status, assignee: existing.assignee } : null, after: { status: record.status, assignee: record.assignee }, note } });
    commit(nextState);
    return clone({ ...record, observedActive: Boolean(live) });
  },

  create(input = {}) {
    const normalized = normalizeCreate(input);
    const createdAt = now();
    const record = {
      id: id("req"),
      revision: 1,
      ...normalized,
      createdAt,
      updatedAt: createdAt,
      createdBy: actor(input.actor),
      updatedBy: actor(input.actor),
    };
    const nextState = clone(state);
    nextState.requests[record.id] = record;
    appendAudit(nextState, {
      action: "workflow.created",
      request: record,
      actor: record.createdBy,
      changes: { before: null, after: clone(record) },
    });
    commit(nextState);
    return clone(record);
  },

  get(idValue) {
    const normalized = requestId(idValue);
    return state.requests[normalized] ? clone(state.requests[normalized]) : null;
  },

  list({ type, status, riskLevel, limit = 200 } = {}) {
    if (type != null) enumValue(type, WORKFLOW_TYPES, "需求类型");
    if (status != null) enumValue(status, WORKFLOW_STATUSES, "状态");
    if (riskLevel != null) enumValue(riskLevel, WORKFLOW_RISK_LEVELS, "风险等级");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) fail("INVALID_LIMIT", `返回数量需为 1-${MAX_LIST_LIMIT} 的整数`);
    return Object.values(state.requests)
      .filter((item) => (type == null || item.type === type)
        && (status == null || item.status === status)
        && (riskLevel == null || item.riskLevel === riskLevel))
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt) || right.revision - left.revision)
      .slice(0, limit)
      .map(clone);
  },

  update(input, legacyPatch) {
    const options = typeof input === "string"
      ? { id: input, ...(isPlainObject(legacyPatch) ? legacyPatch : {}) }
      : input;
    if (!isPlainObject(options)) fail("INVALID_INPUT", "更新参数必须是对象");
    const allowedOptions = new Set(["id", "expectedRevision", "actor", "patch", ...UPDATE_FIELDS]);
    rejectUnknownFields(options, allowedOptions, "更新参数");
    const normalizedId = requestId(options.id);
    const current = state.requests[normalizedId];
    if (!current) fail("REQUEST_NOT_FOUND", "找不到指定需求");
    if (!Number.isSafeInteger(options.expectedRevision)) fail("INVALID_REVISION", "expectedRevision 必须是整数");
    if (options.expectedRevision !== current.revision) fail("REVISION_CONFLICT", "需求已被其他人更新，请刷新后重试", { currentRevision: current.revision });
    const patch = options.patch === undefined
      ? Object.fromEntries([...UPDATE_FIELDS].filter((field) => Object.prototype.hasOwnProperty.call(options, field)).map((field) => [field, options[field]]))
      : options.patch;
    rejectUnknownFields(patch, UPDATE_FIELDS, "需求变更", IMMUTABLE_FIELDS);
    if (!Object.keys(patch).length) fail("NO_CHANGES", "没有可保存的需求变更");

    const nextRecord = { ...current };
    if (Object.prototype.hasOwnProperty.call(patch, "name")) nextRecord.name = text(patch.name, "名称", { min: 2, max: 80, noLineBreak: true });
    if (Object.prototype.hasOwnProperty.call(patch, "desiredOutcome")) nextRecord.desiredOutcome = text(patch.desiredOutcome, "期望结果", { min: 4, max: 2_000 });
    if (Object.prototype.hasOwnProperty.call(patch, "businessOwner")) nextRecord.businessOwner = text(patch.businessOwner, "业务负责人", { min: 2, max: 80, noLineBreak: true });
    if (Object.prototype.hasOwnProperty.call(patch, "providerHint")) nextRecord.providerHint = validateProviderHint(patch.providerHint);
    if (Object.prototype.hasOwnProperty.call(patch, "riskLevel")) nextRecord.riskLevel = enumValue(patch.riskLevel, WORKFLOW_RISK_LEVELS, "风险等级");
    if (Object.prototype.hasOwnProperty.call(patch, "notes")) nextRecord.notes = text(patch.notes, "备注", { max: 2_000, optional: true });
    if (Object.prototype.hasOwnProperty.call(patch, "status")) {
      const nextStatus = enumValue(patch.status, WORKFLOW_STATUSES, "状态");
      if (nextStatus !== current.status && !WORKFLOW_TRANSITIONS[current.status].includes(nextStatus)) {
        fail("INVALID_STATUS_TRANSITION", `不允许从 ${current.status} 流转到 ${nextStatus}`, { from: current.status, to: nextStatus });
      }
      nextRecord.status = nextStatus;
    }

    const changedFields = [...UPDATE_FIELDS].filter((field) => nextRecord[field] !== current[field]);
    if (!changedFields.length) fail("NO_CHANGES", "没有实际变化");
    const updatedAt = now();
    nextRecord.revision = current.revision + 1;
    nextRecord.updatedAt = updatedAt;
    nextRecord.updatedBy = actor(options.actor);
    const nextState = clone(state);
    nextState.requests[normalizedId] = nextRecord;
    appendAudit(nextState, {
      action: "workflow.updated",
      request: nextRecord,
      actor: nextRecord.updatedBy,
      changes: {
        fields: changedFields,
        before: pickFields(current, changedFields),
        after: pickFields(nextRecord, changedFields),
      },
    });
    commit(nextState);
    return clone(nextRecord);
  },

  audits({ requestId: requestIdFilter, action, limit = 200 } = {}) {
    if (requestIdFilter != null) requestId(requestIdFilter);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) fail("INVALID_LIMIT", `返回数量需为 1-${MAX_LIST_LIMIT} 的整数`);
    return state.audits
      .filter((entry) => (!requestIdFilter || entry.requestId === requestIdFilter) && (!action || entry.action === action))
      .slice()
      .reverse()
      .slice(0, limit)
      .map(clone);
  },

  auditIntegrity() {
    verifyAuditChain(state);
    return { ok: true, entries: state.audits.length, headHash: state.audits.at(-1)?.hash || AUDIT_GENESIS };
  },

  readiness() {
    return adminWorkflowStoreReadiness();
  },
};

export function adminWorkflowStoreReadiness() {
  const blockers = PRODUCTION
    ? ["后台能力/模板接入工作流仍使用本地 JSON；生产必须迁移到具备事务、备份和访问审计的数据库"]
    : [];
  return {
    status: PRODUCTION ? "NO-GO" : "CLOSED_TEST",
    ready: blockers.length === 0,
    backend: "local-json",
    productionSupported: false,
    file: PRODUCTION ? null : STORE_FILE,
    blockers,
  };
}

export function resetWorkflowStoreForTests() {
  state = initialState();
  writeState(state);
}
