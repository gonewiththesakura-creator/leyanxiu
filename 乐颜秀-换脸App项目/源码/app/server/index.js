/**
 * 乐颜秀 接入服务
 * 职责：限流鉴权 → 调用云厂商融合接口 → 任务轮询
 * 未配置密钥时仅允许在非生产环境使用 mock 模式联调。
 */
import "./env.js";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import lunarJs from "lunar-javascript";
import * as aliyun from "./providers/aliyun.js";
import * as tencent from "./providers/tencent.js";
import * as volcengine from "./providers/volcengine.js";
import * as viapi from "./providers/viapi.js";
import { changeAgePic } from "./providers/tencent-ft.js";
import * as seededit from "./providers/seededit.js";
import * as bailian from "./providers/bailian.js";
import * as wanx from "./providers/wanx.js";
import * as qwenImage from "./providers/qwen-image.js";
import { listPhotoEffects } from "./photo-effects.js";
import { repairOcclusion } from "./repair.js";
import { resolveVideoTemplate } from "./video-template-config.js";
import { composeMatting } from "./matting.js";
import { objectStore, storageConfig } from "./storage.js";
import { complianceStoreReadiness, flushComplianceStore, store } from "./compliance-store.js";
import { registerCompliancePersistenceMiddleware } from "./compliance-response.js";
import { registerPaymentRoutes } from './payments/routes.js';
import { billingStore as baseBillingStore, billingStoreReadiness, billingDatabase, paymentAccounts, accountRegistry } from './payments/runtime.js';
import { createAccountRetention, startAccountRetentionJob } from './accounts/retention.js';
import { createAccountSecurityLog } from './accounts/security-log.js';
import { createAccountOperationsMiddleware } from './accounts/operations.js';
import { registerAppAccountRoutes } from './accounts/routes.js';
import { createWechatLogin, wechatLoginReady } from './accounts/wechat.js';
import { accountSessionGuard } from './accounts/middleware.js';
import { accountOnlyMiddleware, ACCOUNT_ONLY_MESSAGE } from './accounts/account-only.js';
import { withVirtualBilling, mountVirtualPayments, virtualGenerationGate, miniCreationCatalog, providerUsageCount } from './payments/virtual/integration.js';
import { virtualEnabled, virtualReadiness, virtualRuntime } from './payments/virtual/runtime.js';
import { createMiniIdentity } from './payments/virtual/mini-identity.js';
import { registerPaymentAccountRoutes } from './payments/account-routes.js';
import { smsReadiness } from './payments/sms.js';
import { paymentAdapter, paymentReadiness, paymentOperationsReadiness, products as configuredPaymentProducts } from './payments/config.js';
import { fromWechatOrderId } from './payments/wechat.js';
import { registerStageDrainMiddleware, stageDrain } from "./stage-drain.js";
import { authConfig, authReadiness, createSession, createSessionForUser, realNameReadiness, requireAuth, revokeAuth, getAuth, miniIdentityMiddleware } from "./auth.js";
import { contentSafetyConfig, contentSafetyReadiness, moderate } from "./content-safety.js";
import { capabilityReadiness, capabilityRegistry } from "./provider-registry.js";
import { alertMetric, flushMetrics, observeHttp, snapshot as metricsSnapshot } from "./metrics.js";
import { runRetentionSweep, startRetentionJob } from "./retention.js";
import { markFile, markingMetadata, markingReadiness } from "./ai-marking.js";
import { requestSupplierDeletion, supplierDeletionReadiness } from "./supplier-lifecycle.js";
import { monitoringReadiness, monitoringSnapshot } from "./monitoring.js";
import { assertSafeRemoteUrl } from "./network-policy.js";
import { decodeImageDataUrl, decodeVideoDataUrl } from "./media-validation.js";
import { logSecurity, safeError } from "./security-log.js";
import { fetchRemoteBuffer } from "./remote-fetch.js";
import { adminStore, adminStoreReadiness, validateCatalog } from "./admin-store.js";
import { registerAdminMediaRoutes } from "./admin-media.js";
import { registerAdminSnapshotMiddleware } from "./admin-snapshot.js";
import { adminWorkflowStoreReadiness, workflowStore } from "./admin-workflow-store.js";
import {
  adminAuthReadiness,
  allowAdminLogin,
  authenticateAdmin,
  clearAdminCookie,
  clearAdminLoginAttempts,
  createAdminSession,
  csrfFor,
  getAdminSession,
  requireAdmin,
  revokeAdminSession,
} from "./admin-auth.js";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Solar } = lunarJs;

const PROVIDER = process.env.PROVIDER || "unconfigured";
const ALLOW_MOCK_PROVIDER = String(process.env.ALLOW_MOCK_PROVIDER || "").toLowerCase() === "true";
const PHOTO_PROVIDER = process.env.PHOTO_PROVIDER || "viapi";
const LLM_PROVIDER = process.env.LLM_PROVIDER || (process.env.DEEPSEEK_API_KEY ? "deepseek" : "hunyuan");
const DEPLOY_ENV = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "development").toLowerCase();
const PRODUCTION = DEPLOY_ENV === "production";
const FACE_CONSENT_VERSION = process.env.FACE_CONSENT_VERSION || "unapproved-local-v1";
const BASIC_CONSENT_VERSION = process.env.BASIC_CONSENT_VERSION || FACE_CONSENT_VERSION;
const PAYMENT_MODE = process.env.PAYMENT_MODE || "closed_test";
const APP_ACCOUNT_ONLY = process.env.APP_ACCOUNT_ONLY === 'true';
const PAYMENT_WEBHOOK_SECRET = process.env.PAYMENT_WEBHOOK_SECRET || "";
const INTERNAL_CRON_TOKEN = process.env.INTERNAL_CRON_TOKEN || "";
const app = new Hono();
const ACCOUNT_OPERATIONS_ENABLED = process.env.APP_ACCOUNT_OPERATIONS_ENABLED === 'true';
if (ACCOUNT_OPERATIONS_ENABLED && (DEPLOY_ENV !== 'staging' || process.env.APP_ACCOUNT_ONLY !== 'true'
  || process.env.APP_LOGIN_ENABLED !== 'true' || PAYMENT_MODE !== 'closed_test' || !billingDatabase)) {
  throw new Error('ACCOUNT_OPERATIONS_CONFIG_INVALID');
}
const accountSecurityLog = ACCOUNT_OPERATIONS_ENABLED
  ? createAccountSecurityLog({ directory: process.env.ACCOUNT_SECURITY_LOG_DIR }) : null;
if (accountSecurityLog && !(await accountSecurityLog.ready()).healthy) throw new Error('ACCOUNT_SECURITY_LOG_UNAVAILABLE');
const accountRetention = ACCOUNT_OPERATIONS_ENABLED
  ? createAccountRetention({ db: billingDatabase, store, flush: flushComplianceStore }) : null;
let accountRetentionJob;
function accountOperationsHealthy() {
  if (!ACCOUNT_OPERATIONS_ENABLED) return true;
  const state = accountRetentionJob?.status() || accountRetention.status();
  return accountSecurityLog.health().healthy && !state.lastError && !state.lastNotificationError && !state.overdue;
}
const billingStore = withVirtualBilling(baseBillingStore);
const miniIdentityEnabled = () => virtualEnabled() && authConfig().mode === 'wechat'
  && process.env.RELEASE_CHANNEL === 'wechat-mini-program';
let miniIdentityPending;
async function miniIdentityRuntime() {
  if (!miniIdentityPending) miniIdentityPending = (async () => {
    const runtime = await virtualRuntime();
    // Authentication migrations remain explicit; ordinary startup cannot DDL.
    await runtime.ledger.database.transaction(q => q('SELECT id FROM vp_auth_sessions LIMIT 1'));
    return createMiniIdentity({ database: runtime.ledger.database, appId: runtime.adapter.appId,
      bindSession: input => runtime.ledger.bindSession(input),
      ensureUser: async mapping => { store.ensureMiniUser(mapping); await flushComplianceStore(); },
      userAvailable: mapping => store.miniUserAvailable(mapping) });
  })().catch(error => { miniIdentityPending = null; throw error; });
  return miniIdentityPending;
}
function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}
const MAX_REQUEST_BYTES = boundedInteger(process.env.MAX_REQUEST_BYTES, 20 * 1024 * 1024, 1024, 32 * 1024 * 1024);
const MAX_VIDEO_REQUEST_BYTES = boundedInteger(process.env.MAX_VIDEO_REQUEST_BYTES, 150 * 1024 * 1024, 1024, 160 * 1024 * 1024);
const CORS_ORIGINS = String(process.env.CORS_ORIGIN || "*").split(",").map((origin) => origin.trim()).filter(Boolean);
app.use("*", cors({
  origin: (origin) => CORS_ORIGINS.includes("*") || CORS_ORIGINS.includes(origin) ? origin || "*" : "",
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "Idempotency-Key", "X-Request-Id", "X-Closed-Test-Invite", "X-CSRF-Token"],
  exposeHeaders: ["X-Request-Id", "Content-Range", "Accept-Ranges"],
  maxAge: 600,
}));
app.use('*', createAccountOperationsMiddleware({ enabled: ACCOUNT_OPERATIONS_ENABLED, log: accountSecurityLog, ready: accountOperationsHealthy }));
app.use('*', accountOnlyMiddleware({ enabled: APP_ACCOUNT_ONLY }));
const regularBodyLimit = bodyLimit({ maxSize: MAX_REQUEST_BYTES, onError: (c) => c.json({ code: "REQUEST_TOO_LARGE", message: "请求内容超过大小限制" }, 413) });
const videoBodyLimit = bodyLimit({ maxSize: MAX_VIDEO_REQUEST_BYTES, onError: (c) => c.json({ code: "REQUEST_TOO_LARGE", message: "视频请求超过大小限制" }, 413) });
app.use("*", async (c, next) => {
  const limit = c.req.path === "/api/upload/video" ? MAX_VIDEO_REQUEST_BYTES : MAX_REQUEST_BYTES;
  const contentLength = c.req.header("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > limit)) {
    return c.json({ code: "REQUEST_TOO_LARGE", message: "请求内容超过大小限制" }, 413);
  }
  return c.req.path === "/api/upload/video" ? videoBodyLimit(c, next) : regularBodyLimit(c, next);
});
app.use("*", async (c, next) => {
  const started = Date.now();
  const suppliedRequestId = c.req.header("x-request-id") || "";
  const requestId = /^[A-Za-z0-9:_-]{1,128}$/.test(suppliedRequestId) ? suppliedRequestId : `req_${crypto.randomUUID()}`;
  c.set("requestId", requestId);
  let failed = false;
  try {
    await next();
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    const route = c.req.routePath || "unmatched";
    if (!stageDrain.draining) observeHttp({ method: c.req.method, route, status: failed ? 500 : (c.res.status || 500), milliseconds: Date.now() - started });
    c.header("x-request-id", requestId);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("X-DNS-Prefetch-Control", "off");
    c.header("X-Permitted-Cross-Domain-Policies", "none");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    c.header("Content-Security-Policy", "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; connect-src 'self' https:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (PRODUCTION) c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "no-store");
  }
});

/* 静态资源：优先服务 React 构建产物，未构建时回退旧联调页资源。 */
import { serveStatic } from "@hono/node-server/serve-static";
const WEB_ROOT = fs.existsSync(path.join(__dirname, "web", "index.html")) ? path.join(__dirname, "web") : __dirname;
registerStageDrainMiddleware(app, { enabled: DEPLOY_ENV === 'staging', authorized: internalOnly, flush: async () => { await flushComplianceStore(); await flushMetrics(); } });
registerCompliancePersistenceMiddleware(app, { readiness: complianceStoreReadiness, flush: flushComplianceStore });
app.use('/api/*', miniIdentityMiddleware({ enabled: miniIdentityEnabled, identity: miniIdentityRuntime }));
registerAdminSnapshotMiddleware(app);
registerAdminMediaRoutes(app, { catalogStore: adminStore, audit: (entry) => store.recordAudit(entry) });
const enforcePublishedAssetIntegrity = async (c, next) => {
  const integrity = adminStore.verifyPublishedAsset(c.req.path);
  if (!integrity.valid) {
    logSecurity("error", "catalog.published_asset_integrity_failed", { path: c.req.path, reason: integrity.reason });
    return c.json({ code: "PUBLISHED_ASSET_INTEGRITY_FAILED", message: "已发布素材完整性校验失败，已停止提供该素材" }, 503);
  }
  await next();
};
app.use("/plays/*", enforcePublishedAssetIntegrity);
app.use("/templates/*", enforcePublishedAssetIntegrity);
app.use("/avatars/*", enforcePublishedAssetIntegrity);
app.use("/effects/*", enforcePublishedAssetIntegrity);
app.use("/banners/*", enforcePublishedAssetIntegrity);
app.use("/assets/*", serveStatic({ root: WEB_ROOT }));
app.use("/plays/*", serveStatic({ root: WEB_ROOT }));
app.use("/templates/*", serveStatic({ root: WEB_ROOT }));
app.use("/avatars/*", serveStatic({ root: WEB_ROOT }));
app.use("/effects/*", serveStatic({ root: WEB_ROOT }));
app.use("/banners/*", serveStatic({ root: WEB_ROOT }));
app.use('/app/legal/*', serveStatic({ root: WEB_ROOT }));

/* ---------- 模板表（阿里用预入库 TemplateId；腾讯/火山直接传模板视频 URL） ----------
 * maskKey 非空即启用「遮挡回贴」修复：模板入库时跑 precompute-mask.py 生成，
 * 上传到 OSS（私有），出片后自动用 ffmpeg maskedmerge 修复手挡脸重影。 */
const TEMPLATES = {
  jinqu:      { name: "经典歌曲", aliyunTemplateId: process.env.TPL_JINQU || "",       videoUrl: process.env.TPL_JINQU_URL || "",      maskKey: process.env.TPL_JINQU_MASK || "" },
  street:     { name: "夜景唱歌", aliyunTemplateId: process.env.TPL_STREET || "",      videoUrl: process.env.TPL_STREET_URL || "",     maskKey: process.env.TPL_STREET_MASK || "" },
  dance:      { name: "轻松跳舞", aliyunTemplateId: process.env.TPL_DANCE || "",       videoUrl: process.env.TPL_DANCE_URL || "",      maskKey: process.env.TPL_DANCE_MASK || "" },
  quote:      { name: "暖心语录", aliyunTemplateId: process.env.TPL_QUOTE || "",       videoUrl: process.env.TPL_QUOTE_URL || "",      maskKey: process.env.TPL_QUOTE_MASK || "" },
};

const readyVideoTemplates = Object.entries(TEMPLATES).filter(([, value]) => value.aliyunTemplateId || value.videoUrl);

/* ---------- 照片换脸模板表（合照模板，阿里 AddFaceImageTemplate 入库后的 TemplateId） ---------- */
const PHOTO_TEMPLATES = {
  heying1: { name: "合照模板1", imageTemplateId: process.env.PTPL_HEYING1 || "", imgUrl: process.env.PTPL_HEYING1_IMG || "" },
  heying2: { name: "合照模板2", imageTemplateId: process.env.PTPL_HEYING2 || "", imgUrl: process.env.PTPL_HEYING2_IMG || "" },
};

/* ---------- 视频抠像换背景模板表 ---------- */
const MATTING_BGS = {
  sky:    { name: "蓝天白云", bgUrl: process.env.MTBG_SKY || "" },
  studio: { name: "影棚光效", bgUrl: process.env.MTBG_STUDIO || "" },
};

const WORK_DIR = process.env.REPAIR_WORK_DIR || (process.platform === "win32" ? "C:\\leyanxiu-repair" : "/tmp/leyanxiu");
fs.mkdirSync(WORK_DIR, { recursive: true });

async function fetchToLocal(url, localName) {
  const p = path.join(WORK_DIR, localName);
  const buffer = await fetchRemoteBuffer(url, { purpose: "合成素材" });
  fs.writeFileSync(p, buffer, { mode: 0o600 });
  return p;
}

/* ---------- 任务台账：taskId → 元数据（可插拔：云数据库/本地文件，见 tasks-store.js） ---------- */
import { initTasks, saveTask, taskStoreStatus } from "./tasks-store.js";
const START_REQUESTED = process.env.START_SERVER !== "false" && process.env.NODE_ENV !== "test";
// Restore the private OSS index before readiness is evaluated or any route is
// served. A failed restore rejects module startup and keeps the service closed.
if (!APP_ACCOUNT_ONLY) await objectStore.initialize();
if (!APP_ACCOUNT_ONLY && objectStore.backend === "oss") {
  await Promise.all(readyVideoTemplates
    .filter(([, template]) => template.videoUrl)
    .map(([, template]) => objectStore.protectConfiguredOssObject(template.videoUrl)));
}
const startupReadiness = PRODUCTION && START_REQUESTED ? await launchReadiness() : null;
const startupBlocked = Boolean(startupReadiness && !startupReadiness.publicLaunchAllowed);
const tasks = startupBlocked || APP_ACCOUNT_ONLY ? {} : await initTasks();
const retentionTimer = startupBlocked || APP_ACCOUNT_ONLY ? null : startRetentionJob();
if (accountRetention && START_REQUESTED && !startupBlocked) {
  const mode = process.env.ACCOUNT_RETENTION_MODE || 'dry-run';
  if (!['dry-run', 'apply'].includes(mode)) throw new Error('ACCOUNT_RETENTION_MODE_INVALID');
  accountRetentionJob = startAccountRetentionJob(accountRetention, {
    apply: mode === 'apply',
    onResult: async report => {
      const written = await accountSecurityLog.record({ event: 'retention.sweep', result: report.mode === 'apply' ? 'success' : 'dry_run' });
      if (!written.ok) throw new Error('ACCOUNT_SECURITY_LOG_UNAVAILABLE');
      const pruned = await accountSecurityLog.prune({ apply: report.mode === 'apply' });
      if (!pruned.ok) throw new Error('ACCOUNT_SECURITY_LOG_UNAVAILABLE');
    },
    onError: async () => {
      await accountSecurityLog.record({ event: 'retention.sweep', result: 'failed', reason: 'cleanup_failed' });
      logSecurity('error', 'account.retention_failed', { code: 'ACCOUNT_RETENTION_FAILED' });
    },
  });
  await accountRetentionJob.ready;
  if (!accountOperationsHealthy()) {
    await accountRetentionJob.stop();
    await accountSecurityLog.close();
    throw new Error('ACCOUNT_OPERATIONS_START_FAILED');
  }
}

/* ---------- 修复结果缓存：taskId → Promise<{videoUrl}> ---------- */
const repairs = new Map();
const fusionOutputs = new Map();

function configuredPublicBase() {
  const value = String(process.env.PUBLIC_BASE_URL || "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) return null;
    if (PRODUCTION && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function requestBase(c) {
  const configured = configuredPublicBase();
  if (configured) return configured;
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    const proto = String(c.req.header("x-forwarded-proto") || "").split(",")[0].trim().toLowerCase();
    const host = String(c.req.header("x-forwarded-host") || "").split(",")[0].trim();
    try {
      const parsed = new URL(`${proto}://${host}`);
      if (["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password) return parsed.origin;
    } catch {}
  }
  try { return new URL(c.req.url).origin; } catch { return `http://127.0.0.1:${process.env.PORT || 3000}`; }
}

function clientAddress(c) {
  const candidates = [];
  if (process.env.TRUST_PROXY_HEADERS === "true") {
    candidates.push(c.req.header("x-real-ip"));
    candidates.push(String(c.req.header("x-forwarded-for") || "").split(",")[0].trim());
  }
  candidates.push(c.env?.incoming?.socket?.remoteAddress, c.env?.server?.incoming?.socket?.remoteAddress);
  for (const candidate of candidates) {
    const normalized = String(candidate || "").replace(/^::ffff:/i, "");
    if (net.isIP(normalized)) return normalized;
  }
  return "unavailable";
}

function privacyFingerprint(c) {
  const secret = process.env.AUTH_SESSION_SECRET || process.env.OBJECT_SIGNING_SECRET || "local-evidence-only";
  const material = `${clientAddress(c)}\n${String(c.req.header("user-agent") || "").slice(0, 256)}`;
  return crypto.createHmac("sha256", secret).update(material).digest("hex");
}

function requestId(c) {
  return c.get("requestId") || `req_${crypto.randomUUID()}`;
}

function authenticated(c) {
  return requireAuth(c);
}

function authUserId(c) {
  return c.get("auth")?.userId;
}

function consentVersion(consentType) {
  return consentType === "face_processing" ? FACE_CONSENT_VERSION : BASIC_CONSENT_VERSION;
}

function consentError(c, consentType = "face_processing") {
  return c.json({ code: "CONSENT_REQUIRED", message: "请先阅读并单独同意相关数据处理说明", consentType, version: consentVersion(consentType) }, 403);
}

function requireFaceConsent(c, userId) {
  if (process.env.CONSENT_ENFORCE === "false") return null;
  if (!store.hasActiveConsent(userId, "basic", BASIC_CONSENT_VERSION)) return consentError(c, "basic");
  return store.hasActiveConsent(userId, "face_processing", FACE_CONSENT_VERSION) ? null : consentError(c, "face_processing");
}

function consentDescriptor(consentType) {
  const suppliers = [...new Set(publicComplianceConfig().aiServices.map((item) => item.provider))];
  const descriptors = {
    basic: { purpose: "账号、会话、安全审计与产品服务运行", dataTypes: ["account-id", "session-security", "service-audit"], suppliers: [] },
    face_processing: { purpose: "用户主动发起的人脸图像或视频生成", dataTypes: ["face-image", "uploaded-media", "generated-media"], suppliers },
    content_rights: { purpose: "确认上传素材权利来源与人物授权", dataTypes: ["rights-assertion", "uploaded-media"], suppliers: [] },
    marketing: { purpose: "用户可选的营销信息接收", dataTypes: ["contact-preference"], suppliers: [] },
  };
  return descriptors[consentType];
}

function requireInputObject(c, reference, userId) {
  try {
    return objectStore.assertOwnedReference(reference, userId);
  } catch (error) {
    const code = error.message === "OBJECT_NOT_OWNED" ? "OBJECT_NOT_OWNED" : "INVALID_OBJECT_REFERENCE";
    return { error: c.json({ code, message: "只能使用当前账号已上传且仍有效的照片" }, code === "OBJECT_NOT_OWNED" ? 403 : 400) };
  }
}

function moderationFor(c, userId, { text = "", metadata = {}, direction = "input", taskId, assetId } = {}) {
  const result = moderate({ text, metadata, direction });
  const record = store.recordModeration({ userId, taskId, assetId, direction, ...result });
  if (result.decision === "block") return { ...result, record };
  return { ...result, record };
}

async function providerBudgetGate(c, userId) {
  const now = Date.now();
  const globalDailyLimit = boundedInteger(process.env.PROVIDER_DAILY_CALL_LIMIT, 500, 1, 1_000_000);
  const userDailyLimit = boundedInteger(process.env.USER_DAILY_GENERATION_LIMIT, 30, 1, 100_000);
  const since24Hours = new Date(now - 86_400_000).toISOString();
  const [globalUsage, userUsage] = await Promise.all([
    providerUsageCount({ compliance: store, billing: billingStore, since: since24Hours }),
    providerUsageCount({ compliance: store, billing: billingStore, since: since24Hours, userId }),
  ]);
  if (globalUsage >= globalDailyLimit || userUsage >= userDailyLimit) {
    alertMetric("provider.budget_circuit_open", { globalUsage, globalDailyLimit, userUsage, userDailyLimit });
    return { error: c.json({ code: "PROVIDER_BUDGET_LIMIT", message: "今日生成服务额度已用完，请稍后再试" }, 429) };
  }
  return { ok: true };
}

async function reserveCreation(c, userId, referenceId, purpose) {
  const budget = await providerBudgetGate(c, userId);
  if (budget.error) return budget;
  if (!PRODUCTION && String(process.env.CLOSED_TEST_MODE || "true") === "true") {
    const dailyLimit = boundedInteger(process.env.CLOSED_TEST_DAILY_GENERATION_LIMIT, 20, 0, 1_000_000);
    const dayStart = new Date();
    dayStart.setUTCHours(0, 0, 0, 0);
    const usedToday = await billingStore.countGenerationReservationsSince(dayStart.toISOString());
    if (dailyLimit === 0 || usedToday >= dailyLimit) {
      alertMetric("closed_test.daily_generation_limit", { dailyLimit, usedToday });
      return {
        error: c.json({
          code: "CLOSED_TEST_DAILY_LIMIT",
          message: "今日公测生成额度已用完，请联系测试负责人",
        }, 429),
      };
    }
  }
  const result = await billingStore.reserveCreation(userId, referenceId, purpose);
  if (!result.ok) return { error: c.json({ code: "INSUFFICIENT_ENTITLEMENT", message: "可用制作次数不足" }, 402) };
  if (result.duplicate) return { error: c.json({ code: "DUPLICATE_GENERATION_REQUEST", message: "该制作请求已受理，请勿重复提交" }, 409) };
  return result;
}

async function recordNonGenerationProviderCall(c, userId, purpose) {
  const budget = await providerBudgetGate(c, userId);
  if (budget.error) return budget;
  store.recordProviderUsage({
    userId,
    purpose,
    referenceId: `${purpose}:${crypto.randomUUID()}`,
  });
  return { ok: true };
}

function outputMetadata({ provider, model, purpose, taskId, contentId }) {
  return markingMetadata({ provider, model, purpose, taskId, contentId: contentId || `lyx_${crypto.randomUUID()}` });
}

async function persistLocalResult(localPath, { ownerId, purpose, kind, provider, model, taskId, base }) {
  const ext = kind === "video" ? ".mp4" : path.extname(localPath) || ".jpg";
  const imageType = { ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".jpeg": "image/jpeg" }[ext.toLowerCase()] || "image/jpeg";
  const contentId = `lyx_${crypto.randomUUID()}`;
  const markedPath = path.join(WORK_DIR, `marked-${contentId}${ext}`);
  try {
    await markFile(localPath, markedPath, { kind, contentId, label: "AI生成" });
    const asset = await objectStore.putFile(markedPath, {
      ownerId,
      contentType: kind === "video" ? "video/mp4" : imageType,
      ext,
      purpose,
      metadata: outputMetadata({ provider, model, purpose, taskId: taskId || null, contentId }),
      retainSeconds: Number(process.env.OUTPUT_RETENTION_SECONDS || 86_400),
    });
    return { assetId: asset.id, url: await objectStore.signedUrl(asset.id, { ownerId, base }), metadata: asset.metadata };
  } finally {
    fs.rmSync(markedPath, { force: true });
  }
}

async function persistProviderResult(tmpUrl, options) {
  const kind = options.kind || "image";
  const ext = kind === "video" ? ".mp4" : ".jpg";
  const localPath = path.join(WORK_DIR, `provider-${crypto.randomUUID()}${ext}`);
  try {
    const buffer = await fetchRemoteBuffer(tmpUrl, { purpose: "供应商生成结果" });
    fs.writeFileSync(localPath, buffer, { mode: 0o600 });
    return await persistLocalResult(localPath, { ...options, kind });
  } finally {
    fs.rmSync(localPath, { force: true });
  }
}

async function persistGenerationOutput(c, options) {
  const stored = await persistProviderResult(options.tmpUrl, options);
  const moderation = moderationFor(c, options.ownerId, {
    direction: "output",
    taskId: options.taskId,
    assetId: stored.assetId,
    metadata: stored.metadata,
  });
  if (moderation.decision !== "allow") {
    await objectStore.delete(stored.assetId, { ownerId: options.ownerId, reason: "moderation_hold" });
    const error = new Error(moderation.decision === "block" ? "OUTPUT_CONTENT_BLOCKED" : "OUTPUT_REVIEW_REQUIRED");
    error.moderation = moderation;
    throw error;
  }
  if (options.billingRef) await billingStore.confirmCreation(options.ownerId, options.billingRef, options.billingPurpose || options.purpose);
  return { ...stored, moderation };
}

async function persistLocalGenerationOutput(c, localPath, options) {
  const stored = await persistLocalResult(localPath, options);
  const moderation = moderationFor(c, options.ownerId, {
    direction: "output",
    taskId: options.taskId,
    assetId: stored.assetId,
    metadata: stored.metadata,
  });
  if (moderation.decision !== "allow") {
    await objectStore.delete(stored.assetId, { ownerId: options.ownerId, reason: "moderation_hold" });
    const error = new Error(moderation.decision === "block" ? "OUTPUT_CONTENT_BLOCKED" : "OUTPUT_REVIEW_REQUIRED");
    error.moderation = moderation;
    throw error;
  }
  if (options.billingRef) await billingStore.confirmCreation(options.ownerId, options.billingRef, options.billingPurpose || options.purpose);
  return { ...stored, moderation };
}

async function updateTask(taskId, patch) {
  if (!tasks[taskId]) return;
  tasks[taskId] = { ...tasks[taskId], ...patch, updatedAt: Date.now() };
  await saveTask(taskId, tasks[taskId], tasks);
}

async function scrubTasksForUser(userId, reason) {
  let count = 0;
  for (const [taskId, task] of Object.entries(tasks)) {
    if (task.ownerId !== userId) continue;
    tasks[taskId] = {
      ...task,
      status: "DELETED",
      inputObjectId: null,
      outputObjectId: null,
      videoUrl: null,
      bgUrl: null,
      deletedAt: new Date().toISOString(),
      deletionReason: reason,
    };
    fusionOutputs.delete(taskId);
    repairs.delete(taskId);
    mattings.delete(taskId);
    count += 1;
  }
  if (count) await saveTask("bulk-erasure", null, tasks);
  return count;
}

function constantTimeToken(expected, actual) {
  if (!expected || !actual) return false;
  const left = Buffer.from(String(expected));
  const right = Buffer.from(String(actual));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function internalOnly(c) {
  if (!INTERNAL_CRON_TOKEN) return c.json({ code: "INTERNAL_TOKEN_NOT_CONFIGURED", message: "内部作业令牌尚未配置" }, 503);
  if (!constantTimeToken(INTERNAL_CRON_TOKEN, c.req.header("x-internal-token"))) return c.json({ code: "FORBIDDEN", message: "无权访问内部接口" }, 403);
  return null;
}

function validClientId(value) {
  const text = String(value || "").trim();
  return text && text.length <= 128 && /^[A-Za-z0-9:_-]+$/.test(text) ? text : null;
}

function closedTestAdmission(c, body = {}) {
  const closedTest = !PRODUCTION && String(process.env.CLOSED_TEST_MODE || "true") === "true";
  if (!closedTest || process.env.CLOSED_TEST_REQUIRE_INVITE !== "true") return { ok: true, closedTest };
  const supplied = c.req.header("x-closed-test-invite") || body.inviteCode;
  return { ok: constantTimeToken(process.env.CLOSED_TEST_INVITE_SECRET, supplied), closedTest };
}

function parseP256PublicKey(value) {
  const encoded = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{80,256}$/.test(encoded)) throw new Error("INVALID_DEVICE_PUBLIC_KEY");
  const der = Buffer.from(encoded, "base64url");
  if (der.toString("base64url") !== encoded) throw new Error("INVALID_DEVICE_PUBLIC_KEY");
  let key;
  try {
    key = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("INVALID_DEVICE_PUBLIC_KEY");
  }
  const curve = key.asymmetricKeyDetails?.namedCurve;
  if (key.asymmetricKeyType !== "ec" || !["prime256v1", "P-256"].includes(curve)) throw new Error("INVALID_DEVICE_PUBLIC_KEY");
  const canonicalDer = key.export({ format: "der", type: "spki" });
  if (!Buffer.from(canonicalDer).equals(der)) throw new Error("INVALID_DEVICE_PUBLIC_KEY");
  return { key, encoded, fingerprint: crypto.createHash("sha256").update(der).digest("hex") };
}

function decodeDeviceSignature(value) {
  const encoded = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{80,120}$/.test(encoded)) throw new Error("INVALID_DEVICE_SIGNATURE");
  const signature = Buffer.from(encoded, "base64url");
  if (signature.toString("base64url") !== encoded || signature.length < 64 || signature.length > 80) throw new Error("INVALID_DEVICE_SIGNATURE");
  return signature;
}

async function prepareGeneration(c, { inputUrl, purpose, text = "", metadata = {} } = {}) {
  const result = authenticated(c);
  if (result.response) return { response: result.response };
  const runtimeCatalog = adminStore.publicCatalog();
  if (!runtimeCatalog.settings.generationEnabled) {
    return { response: c.json({ code: "GENERATION_PAUSED", message: runtimeCatalog.settings.maintenanceNotice || "创作服务维护中，请稍后再试" }, 503) };
  }
  const userId = result.auth.userId;
  const virtualGate = await virtualGenerationGate(userId, purpose, metadata);
  if (virtualGate) return { response: c.json({ code: virtualGate, message: '当前套餐未包含这项创作，请选择已标明适用的效果' }, 402) };
  if (PRODUCTION && !generationDisclosureReady(purpose)) {
    return { response: c.json({ code: "COMPLIANCE_DISCLOSURE_REQUIRED", message: "该功能的处理者与保存期限尚未完成公开披露" }, 503) };
  }
  const consentResponse = requireFaceConsent(c, userId);
  if (consentResponse) return { response: consentResponse };
  const input = requireInputObject(c, inputUrl, userId);
  if (input.error) return { response: input.error };
  const providerInputUrl = await objectStore.providerUrl(input.id, { ownerId: userId, base: requestBase(c) });
  if (!providerInputUrl) return { response: c.json({ code: "OBJECT_EXPIRED", message: "输入对象已过保存期，请重新上传" }, 410) };
  const moderation = moderationFor(c, userId, { text, metadata, direction: "input", assetId: input.id });
  if (moderation.decision !== "allow") {
    return {
      response: c.json({
        code: moderation.decision === "block" ? "CONTENT_BLOCKED" : "CONTENT_REVIEW_REQUIRED",
        message: moderation.reason || "内容需要人工审核后才能继续",
        moderationId: moderation.record.id,
      }, moderation.decision === "block" ? 422 : 202),
    };
  }
  const suppliedIdempotencyKey = String(c.req.header("idempotency-key") || "").trim();
  if (suppliedIdempotencyKey && !/^[A-Za-z0-9:_-]{8,128}$/.test(suppliedIdempotencyKey)) {
    return { response: c.json({ code: "INVALID_IDEMPOTENCY_KEY", message: "幂等键格式无效" }, 400) };
  }
  const operationKey = suppliedIdempotencyKey || `srv_${crypto.randomUUID()}`;
  const billingRef = crypto.createHmac("sha256", process.env.AUTH_SESSION_SECRET || "closed-test-idempotency")
    .update(`${userId}\n${purpose || "generation"}\n${operationKey}`)
    .digest("hex");
  const billing = await reserveCreation(c, userId, billingRef, purpose);
  if (billing.error) return { response: billing.error };
  // Never incur a supplier charge before the reservation and consent ledger
  // are recoverable after a container replacement.
  try { await flushComplianceStore(); }
  catch (error) {
    // No supplier request has started; release a committed PostgreSQL reservation.
    await billingStore.refundCreation(userId,billingRef,'consent_persistence_failed');
    throw error;
  }
  return { auth: result.auth, userId, input, inputUrl: providerInputUrl, moderation, billingRef, purpose };
}

async function refundPrepared(prepared, reason) {
  if (prepared?.billingRef) await billingStore.refundCreation(prepared.userId, prepared.billingRef, reason);
}

function licensedTemplate(templateId) {
  if (!PRODUCTION) return true;
  return String(process.env.LICENSED_ASSET_IDS || "").split(",").map((value) => value.trim()).includes(templateId);
}

/* ================= 身份、同意、权利与私有对象接口 ================= */
if(accountRegistry) app.use('/api/*',accountSessionGuard({registry:accountRegistry,getAuth}));
app.post("/api/auth/session", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":auth", 10)) return c.json({ code: 429, message: "登录请求太频繁，请稍后再试" }, 429);
  if (PRODUCTION || authConfig().mode !== "anonymous") return c.json({ code: "AUTH_PROVIDER_REQUIRED", message: "当前环境禁止匿名身份，请使用指定登录方式" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const admission = closedTestAdmission(c, body);
  if (!admission.ok) return c.json({ code: "INVITE_REQUIRED", message: "当前为定向测试，请输入有效邀请码" }, 403);
  const closedTest = admission.closedTest;
  const clientId = validClientId(body.clientId) || `browser_${crypto.randomUUID()}`;
  const channel = ["h5", "wechat", "app"].includes(body.channel) ? body.channel : "h5";
  const subject = `anonymous:${channel}:${clientId}`;
  const existingUser = store.findUserBySubject(subject);
  const maxUsers = boundedInteger(process.env.CLOSED_TEST_MAX_USERS, 500, 1, 1_000_000);
  if (closedTest && !existingUser && store.activeUserCount() >= maxUsers) {
    return c.json({ code: "CLOSED_TEST_FULL", message: "测试名额已满" }, 403);
  }
  const session = createSession({ subject, channel, authMethod: "anonymous" });
  store.recordAudit({ userId: session.user.id, action: "auth.session_created", resourceType: "session", resourceId: session.user.id, details: { channel, authMethod: "anonymous" } });
  return c.json({ code: 0, data: { ...session, clientId, closedTestOnly: true } });
});

app.post("/api/auth/device/challenge", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(`${ip}:device-challenge`, 10)) return c.json({ code: 429, message: "设备认证请求太频繁，请稍后再试" }, 429);
  if (PRODUCTION && authConfig().mode !== "device_key") return c.json({ code: "AUTH_PROVIDER_REQUIRED", message: "当前渠道未启用设备密钥认证" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const admission = closedTestAdmission(c, body);
  if (!admission.ok) return c.json({ code: "INVITE_REQUIRED", message: "当前为定向测试，请输入有效邀请码" }, 403);
  if (body.algorithm !== "ES256") return c.json({ code: "INVALID_DEVICE_KEY", message: "仅支持 P-256/ES256 设备密钥" }, 400);
  let parsed;
  try {
    parsed = parseP256PublicKey(body.publicKeySpki);
  } catch {
    return c.json({ code: "INVALID_DEVICE_KEY", message: "设备公钥无效" }, 400);
  }
  const ttlSeconds = boundedInteger(process.env.AUTH_CHALLENGE_TTL_SECONDS, 120, 30, 300);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  const nonce = crypto.randomBytes(32).toString("base64url");
  const challengeId = `dch_${crypto.randomUUID()}`;
  const challenge = `leyanxiu.device-auth.v1|${challengeId}|${nonce}|${expiresAt}|${parsed.fingerprint}`;
  try {
    const saved = store.createAuthChallenge({
      challengeId,
      publicKeySpki: parsed.encoded,
      keyFingerprint: parsed.fingerprint,
      challengeDigest: crypto.createHash("sha256").update(challenge).digest("hex"),
      expiresAt,
      channel: "android",
    });
    return c.json({ code: 0, data: { challengeId: saved.id, challenge, expiresAt, algorithm: "ES256" } });
  } catch (error) {
    logSecurity("error", "auth.device_challenge_failed", safeError(error));
    return c.json({ code: "AUTH_TEMPORARILY_UNAVAILABLE", message: "设备认证暂不可用" }, 503);
  }
});

app.post("/api/auth/device/verify", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(`${ip}:device-verify`, 20)) return c.json({ code: 429, message: "设备认证请求太频繁，请稍后再试" }, 429);
  if (PRODUCTION && authConfig().mode !== "device_key") return c.json({ code: "AUTH_PROVIDER_REQUIRED", message: "当前渠道未启用设备密钥认证" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const admission = closedTestAdmission(c, body);
  if (!admission.ok) return c.json({ code: "INVITE_REQUIRED", message: "当前为定向测试，请输入有效邀请码" }, 403);
  const challengeId = String(body.challengeId || "");
  if (!/^dch_[0-9a-f-]{36}$/i.test(challengeId) || body.algorithm !== "ES256") return c.json({ code: "INVALID_DEVICE_PROOF", message: "设备证明格式无效" }, 400);
  let parsed;
  let signature;
  try {
    parsed = parseP256PublicKey(body.publicKeySpki);
    signature = decodeDeviceSignature(body.signature);
  } catch {
    return c.json({ code: "INVALID_DEVICE_PROOF", message: "设备证明格式无效" }, 400);
  }
  const challenge = String(body.challenge || "");
  if (Buffer.byteLength(challenge, "utf8") < 16 || Buffer.byteLength(challenge, "utf8") > 4096) return c.json({ code: "INVALID_DEVICE_PROOF", message: "认证挑战无效" }, 400);
  const consumed = store.consumeAuthChallenge({
    challengeId,
    publicKeySpki: parsed.encoded,
    challengeDigest: crypto.createHash("sha256").update(challenge).digest("hex"),
  });
  if (!consumed.ok) {
    const status = consumed.error === "AUTH_CHALLENGE_REPLAYED" ? 409 : consumed.error === "AUTH_CHALLENGE_EXPIRED" ? 410 : 400;
    return c.json({ code: consumed.error, message: "认证挑战无效、已过期或已使用" }, status);
  }
  let verified = false;
  try { verified = crypto.verify("sha256", Buffer.from(challenge, "utf8"), parsed.key, signature); } catch { verified = false; }
  if (!verified) {
    logSecurity("warn", "auth.device_signature_rejected", { keyFingerprint: parsed.fingerprint, requestId: requestId(c) });
    return c.json({ code: "INVALID_DEVICE_SIGNATURE", message: "设备签名验证失败" }, 401);
  }
  const subject = `device-key:sha256:${parsed.fingerprint}`;
  if(accountRegistry && process.env.RELEASE_CHANNEL==='android-app') {
    const deviceSubject=`app-device:v2:${parsed.fingerprint}`;
    const existingDevice=store.findUserBySubject(deviceSubject);
    if(admission.closedTest && !existingDevice && store.activeUserCount()>=boundedInteger(process.env.CLOSED_TEST_MAX_USERS,500,1,1_000_000)) return c.json({code:'CLOSED_TEST_FULL',message:'测试名额已满'},403);
    const device=existingDevice || store.createOrGetUser({subject:deviceSubject,channel:'android',authMethod:'device_bootstrap'});
    const binding=await accountRegistry.device(device.id);
    const user=store.getUser(binding.userId);
    if(!user || user.status!=='active') return c.json({code:'ACCOUNT_UNAVAILABLE',message:'账号不可用，请联系客服'},403);
    const session=createSessionForUser(binding.userId,{...binding,authMethod:binding.deviceVersion?'account-device':'device_bootstrap'});
    await flushComplianceStore();
    return c.json({code:0,data:session});
  }
  const existingUser = store.findUserBySubject(subject);
  const maxUsers = boundedInteger(process.env.CLOSED_TEST_MAX_USERS, 500, 1, 1_000_000);
  if (admission.closedTest && !existingUser && store.activeUserCount() >= maxUsers) return c.json({ code: "CLOSED_TEST_FULL", message: "测试名额已满" }, 403);
  const accountId = existingUser && paymentAccounts ? await paymentAccounts.deviceAccount(existingUser.id) : existingUser?.id;
  if (accountId === null) return c.json({ code:'ACCOUNT_RECOVERY_REQUIRED',message:'请先通过手机号找回账号' },403);
  const session = accountId && accountId !== existingUser?.id ? createSessionForUser(accountId, {channel:'android',authMethod:'device_key'})
    : createSession({ subject, channel: "android", authMethod: "device_key", grantTrial: admission.closedTest });
  store.recordAudit({ userId: session.user.id, action: "auth.device_key_login", resourceType: "session", resourceId: session.user.id, details: { channel: "android", keyFingerprint: parsed.fingerprint } });
  return c.json({ code: 0, data: session });
});

app.post("/api/auth/wechat", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":auth", 10)) return c.json({ code: 429, message: "登录请求太频繁，请稍后再试" }, 429);
  if (authConfig().mode !== "wechat") return c.json({ code: "AUTH_PROVIDER_REQUIRED", message: "当前渠道未启用微信登录" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code || "").trim();
  if (!code || code.length > 512) return c.json({ code: "INVALID_CODE", message: "缺少微信登录 code" }, 400);
  if (!process.env.WECHAT_APP_ID || !process.env.WECHAT_APP_SECRET) {
    return c.json({ code: "AUTH_PROVIDER_NOT_CONFIGURED", message: "微信 AppID/Secret 尚未由公司配置，当前仅可封闭测试" }, 503);
  }
  try {
    const query = new URLSearchParams({ appid: process.env.WECHAT_APP_ID, secret: process.env.WECHAT_APP_SECRET, js_code: code, grant_type: "authorization_code" });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), boundedInteger(process.env.AUTH_PROVIDER_TIMEOUT_MS, 10_000, 1_000, 30_000));
    const response = await fetch(`${process.env.WECHAT_AUTH_BASE || "https://api.weixin.qq.com/sns/jscode2session"}?${query}`, { signal: controller.signal, redirect: "error" }).finally(() => clearTimeout(timer));
    const result = await response.json();
    if (!response.ok || result.errcode || !result.openid) throw new Error('WECHAT_LOGIN_FAILED');
    const session = miniIdentityEnabled()
      ? await (await miniIdentityRuntime()).createLogin({ openid: result.openid, sessionKey: result.session_key })
      : createSession({ subject: `wechat:${result.openid}`, channel: "wechat", authMethod: "wechat", grantTrial: false });
    store.recordAudit({ userId: session.user.id, action: "auth.wechat_login", resourceType: "session", resourceId: session.user.id, details: { channel: "wechat" } });
    return c.json({ code: 0, data: session });
  } catch (error) {
    if (['XPAY_IDENTITY_CONFLICT', 'XPAY_LEGACY_IDENTITY_REVIEW_REQUIRED', 'XPAY_ACCOUNT_UNAVAILABLE'].includes(error?.message)) {
      return c.json({ code: error.message, message: '账号暂不可用，请联系客服核对；原账号数据未变更' }, 409);
    }
    logSecurity("error", "auth.wechat_failed", safeError(error));
    return c.json({ code: "AUTH_PROVIDER_ERROR", message: "微信登录暂不可用" }, 503);
  }
});

app.get("/api/auth/me", (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: { user: result.auth.user, expiresAt: result.auth.expiresAt, authMethod: result.auth.authMethod } });
});

app.post("/api/auth/logout", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  if(accountRegistry && result.auth.deviceId) await accountRegistry.logout(result.auth);
  if (c.get('miniIdentitySelected')) await (await miniIdentityRuntime()).logout(c.req.header('authorization'));
  else revokeAuth(result.auth, "logout");
  await flushComplianceStore();
  return c.json({ code: 0, data: { loggedOut: true } });
});

app.get("/api/account/entitlements", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: await billingStore.entitlements(result.auth.userId) });
});

registerPaymentAccountRoutes(app, { accounts:paymentAccounts, authenticated, sessionForUser:createSessionForUser, flush:flushComplianceStore, clientAddress, smsReady:smsReadiness,registry:accountRegistry,wechatReady:wechatLoginReady });
registerAppAccountRoutes(app,{registry:accountRegistry,otp:paymentAccounts,authenticated,sessionForUser:createSessionForUser,flush:flushComplianceStore,users:store,clientAddress,smsReady:smsReadiness,
  wechatReady:wechatLoginReady,appId:()=>process.env.WECHAT_LOGIN_APP_ID,rateLimit,
  wechatExchange:code=>createWechatLogin({appId:process.env.WECHAT_LOGIN_APP_ID,secret:process.env.WECHAT_LOGIN_APP_SECRET})(code)});
const paymentService = registerPaymentRoutes(app, { store: billingStore, authenticated, requireAdmin, adapter: paymentAdapter, readiness: async () => paymentReadiness(await billingStoreReadiness()), operationsReadiness: async () => paymentOperationsReadiness(await billingStoreReadiness()), products: configuredPaymentProducts, flush: flushComplianceStore, orderIdFromTrade: fromWechatOrderId, accountReady:async userId => Boolean(accountRegistry ? (await accountRegistry.status(userId)).loggedIn : paymentAccounts && (await paymentAccounts.status(userId)).bound), alert: alertMetric });
if (!APP_ACCOUNT_ONLY && START_REQUESTED && process.env.PAYMENT_RECONCILE_ENABLED === 'true') {
  const timer = setInterval(() => { void paymentService.reconcilePending().catch(() => alertMetric('payment.reconciliation_failed', {})); }, 60_000);
  timer.unref();
}
if (!APP_ACCOUNT_ONLY && START_REQUESTED && process.env.PAYMENT_BILL_RECONCILE_ENABLED === 'true') {
  const timer=setInterval(()=>{
    const beijing=new Date(Date.now()+8*3600000);
    if(beijing.getUTCHours()<10) return;
    const yesterday=new Date(beijing.getTime()-86400000).toISOString().slice(0,10);
    void (async()=>{
      const reports=billingStore.listReconciliations ? await billingStore.listReconciliations() : [];
      if(!reports.some(report=>report.date===yesterday && report.ok)) await paymentService.reconcileDaily(yesterday);
    })().catch(()=>alertMetric('payment.daily_bill_unconfirmed',{}));
  },3600000);
  timer.unref();
}

const virtualPaymentService = mountVirtualPayments(app, { authenticated, requireAdmin, alert: alertMetric,
  operationalReadiness: async () => ({ identityReady: complianceStoreReadiness().productionSupported === true, adminReady: adminAuthReadiness().ready }) });
if (!APP_ACCOUNT_ONLY && START_REQUESTED && process.env.XPAY_RECONCILE_ENABLED === 'true') {
  const timer = setInterval(() => { void virtualPaymentService.reconcile().catch(() => alertMetric('virtual_payment.reconciliation_failed', {})); }, 60_000);
  timer.unref();
}

app.post("/api/payments/webhook/:provider", async (c) => {
  if (billingStore.backend === 'postgres' || PAYMENT_MODE === 'live' || PRODUCTION || process.env.NODE_ENV !== 'test') return c.json({ code: 'LEGACY_PAYMENT_DISABLED' }, 410);
  if (!PAYMENT_WEBHOOK_SECRET) return c.json({ code: "PAYMENT_WEBHOOK_NOT_CONFIGURED", message: "支付回调密钥尚未配置" }, 503);
  const raw = await c.req.text();
  const timestamp = c.req.header("x-payment-timestamp") || "";
  const nowSeconds = Math.floor(Date.now() / 1000);
  const maxAge = boundedInteger(process.env.PAYMENT_WEBHOOK_MAX_AGE_SECONDS, 300, 30, 3600);
  if (!/^\d{10}$/.test(timestamp) || Math.abs(nowSeconds - Number(timestamp)) > maxAge) {
    return c.json({ code: "STALE_PAYMENT_EVENT", message: "支付回调时间戳无效或已过期" }, 401);
  }
  const signature = c.req.header("x-payment-signature") || "";
  const expected = crypto.createHmac("sha256", PAYMENT_WEBHOOK_SECRET).update(`${timestamp}.${raw}`).digest("hex");
  if (!constantTimeToken(expected, signature)) return c.json({ code: "INVALID_PAYMENT_SIGNATURE", message: "支付回调签名无效" }, 401);
  const providerName = c.req.param("provider");
  if (process.env.PAYMENT_PROVIDER && providerName !== process.env.PAYMENT_PROVIDER) return c.json({ code: "INVALID_PAYMENT_PROVIDER", message: "支付渠道不匹配" }, 400);
  let body;
  try { body = JSON.parse(raw); } catch { return c.json({ code: "INVALID_PAYMENT_EVENT", message: "支付回调格式无效" }, 400); }
  const status = body.status === "success" ? "paid" : body.status;
  const eventId = String(body.eventId || "");
  const orderId = String(body.orderId || "");
  const tradeId = String(body.tradeId || "");
  if (!/^[A-Za-z0-9:_-]{1,128}$/.test(eventId) || !/^ord_[0-9a-f-]{36}$/i.test(orderId) || !/^[A-Za-z0-9:._-]{1,128}$/.test(tradeId) || !["paid", "refunded"].includes(status)) return c.json({ code: "INVALID_PAYMENT_EVENT", message: "支付事件字段无效" }, 400);
  const outcome = store.applyPaymentEvent({ eventId, orderId, status, providerTradeId: tradeId, rawDigest: crypto.createHash("sha256").update(raw).digest("hex") });
  if (outcome.error) {
    const missing = outcome.error === "ORDER_NOT_FOUND";
    return c.json({ code: outcome.error, message: missing ? "订单不存在" : "支付事件与已有状态冲突" }, missing ? 404 : 409);
  }
  return c.json({ code: 0, data: { accepted: true, duplicate: outcome.duplicate, order: outcome.order } });
});

app.post("/api/account/restore-purchases", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: { entitlements: await billingStore.entitlements(result.auth.userId), source: "server_ledger" } });
});

app.get("/api/consents", (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: { current: { basic: BASIC_CONSENT_VERSION, face_processing: FACE_CONSENT_VERSION }, entries: store.listConsents(result.auth.userId) } });
});

app.post("/api/consents", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  const consentType = String(body.consentType || "");
  if (APP_ACCOUNT_ONLY && consentType !== 'basic') return c.json({ code: 'APP_ACCOUNT_ONLY', message: ACCOUNT_ONLY_MESSAGE }, 403);
  const allowed = new Set(["basic", "face_processing", "content_rights", "marketing"]);
  if (!allowed.has(consentType) || body.action !== "granted") return c.json({ code: "INVALID_CONSENT", message: "同意类型或动作无效" }, 400);
  const subjectAuthorization = String(body.subjectAuthorization || "");
  if (consentType === "face_processing" && !["self", "authorized"].includes(subjectAuthorization)) return c.json({ code: "SUBJECT_AUTHORIZATION_REQUIRED", message: "请确认照片为本人或已获得使用授权" }, 400);
  if (consentType === "face_processing" && !store.hasActiveConsent(result.auth.userId, "basic", BASIC_CONSENT_VERSION)) return consentError(c, "basic");
  const expectedVersion = consentType === "face_processing" ? FACE_CONSENT_VERSION : BASIC_CONSENT_VERSION;
  const version = String(body.version || expectedVersion);
  if (version !== expectedVersion) return c.json({ code: "STALE_CONSENT_VERSION", message: "同意文本版本已更新，请重新阅读" }, 409);
  const descriptor = consentDescriptor(consentType);
  const noticeDigest = consentType === "face_processing" ? process.env.FACE_CONSENT_NOTICE_SHA256 : process.env.BASIC_CONSENT_NOTICE_SHA256;
  const entry = store.recordConsent({
    userId: result.auth.userId,
    consentType,
    version,
    action: "granted",
    purpose: descriptor.purpose,
    dataTypes: descriptor.dataTypes,
    suppliers: descriptor.suppliers,
    evidence: { requestId: requestId(c), channel: result.auth.channel, authMethod: result.auth.authMethod, subjectAuthorization: consentType === "face_processing" ? subjectAuthorization : null, noticeSha256: noticeDigest || null, networkFingerprint: privacyFingerprint(c) },
  });
  return c.json({ code: 0, data: entry });
});

app.post("/api/consents/:type/withdraw", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  const consentType = c.req.param("type");
  if (!["basic", "face_processing", "content_rights", "marketing"].includes(consentType)) return c.json({ code: "INVALID_CONSENT", message: "同意类型无效" }, 400);
  const expectedVersion = consentType === "face_processing" ? FACE_CONSENT_VERSION : BASIC_CONSENT_VERSION;
  const entry = store.recordConsent({ userId: result.auth.userId, consentType, version: expectedVersion, action: "withdrawn", purpose: "用户撤回授权", dataTypes: [], suppliers: [], evidence: { requestId: requestId(c) } });
  store.recordAudit({ userId: result.auth.userId, action: "consent.withdrawn", resourceType: "consent", resourceId: entry.id, consentType });
  await flushComplianceStore();
  if (consentType === "face_processing") {
    try {
      const deleted = await objectStore.deleteOwned(result.auth.userId, "consent_withdrawal", { beforeDelete: requestSupplierDeletion });
      const scrubbedTasks = await scrubTasksForUser(result.auth.userId, "consent_withdrawal");
      const supplierPending = deleted.filter((item) => item.supplierDeletion && item.supplierDeletion.status !== "confirmed");
      return c.json({
        code: supplierPending.length ? "ERASURE_PARTIAL" : 0,
        data: { consent: entry, deletionScheduled: supplierPending.length > 0, deleted: deleted.length, supplierPending, scrubbedTasks },
      }, supplierPending.length ? 202 : 200);
    } catch (error) {
      alertMetric("consent.withdrawal_delete_failed", { userId: result.auth.userId, error: safeError(error) });
      store.recordAudit({ userId: result.auth.userId, action: "consent.withdrawal_delete_failed", resourceType: "consent", resourceId: entry.id, details: { error: safeError(error) } });
      return c.json({ code: "DELETE_PENDING", message: "授权已撤回，关联数据删除仍在重试队列中" }, 503);
    }
  }
  return c.json({ code: 0, data: { consent: entry, deletionScheduled: false } });
});

function requestedByteRange(header, size) {
  if (!header) return { full: true };
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2]) || !Number.isInteger(size) || size < 1) return { invalid: true };
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength < 1) return { invalid: true };
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) return { invalid: true };
  return { start, end: Math.min(end, size - 1) };
}

app.get("/api/objects/:objectId", async (c) => {
  const objectId = c.req.param("objectId");
  const record = objectStore.verifyDownload(objectId, c.req.query("token"));
  if (!record) return c.json({ code: "OBJECT_NOT_FOUND", message: "对象不存在、已过期或签名无效" }, 403);
  const range = requestedByteRange(c.req.header("range"), Number(record.size));
  c.header("Accept-Ranges", "bytes");
  if (range.invalid) {
    c.header("Content-Range", `bytes */${record.size}`);
    return c.body(null, 416);
  }
  const loaded = range.full
    ? await objectStore.read(objectId)
    : await objectStore.readRange(objectId, range.start, range.end);
  if (!loaded) return c.json({ code: "OBJECT_NOT_FOUND", message: "对象不存在" }, 404);
  c.header("Content-Type", record.contentType);
  c.header("Content-Length", String(loaded.buffer.length));
  c.header("Cache-Control", "private, no-store");
  if (!range.full) {
    c.header("Content-Range", `bytes ${range.start}-${range.end}/${record.size}`);
    return c.body(new Uint8Array(loaded.buffer), 206);
  }
  return c.body(new Uint8Array(loaded.buffer), 200);
});

app.get("/api/assets/:assetId/url", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  const assetId = c.req.param("assetId");
  const record = objectStore.get(assetId);
  if (!record || record.ownerId !== result.auth.userId) return c.json({ code: "FORBIDDEN", message: "无权访问该作品" }, 403);
  const url = await objectStore.signedUrl(assetId, { ownerId: result.auth.userId, base: requestBase(c) });
  return c.json({
    code: 0,
    data: {
      assetId,
      url,
      expiresAt: record.expiresAt,
      contentType: record.contentType,
      ext: record.ext,
      metadata: record.metadata,
    },
  });
});

app.delete("/api/assets/:assetId", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  const assetId = c.req.param("assetId");
  try {
    const record = objectStore.get(assetId);
    if (!record || record.ownerId !== result.auth.userId) return c.json({ code: "FORBIDDEN", message: "无权删除该作品" }, 403);
    const supplierDeletion = await requestSupplierDeletion(record);
    const deleted = { ...(await objectStore.delete(assetId, { ownerId: result.auth.userId, reason: "user_request" })), supplierDeletion };
    const pending = supplierDeletion.status !== "confirmed";
    store.recordAudit({ userId: result.auth.userId, action: pending ? "asset.deleted_supplier_pending" : "asset.deleted", resourceType: "object", resourceId: assetId, details: deleted });
    return c.json({ code: pending ? "ERASURE_PARTIAL" : 0, data: deleted }, pending ? 202 : 200);
  } catch (error) {
    if (error.message === "OBJECT_NOT_OWNED") return c.json({ code: "FORBIDDEN", message: "无权删除该作品" }, 403);
    return c.json({ code: "DELETE_FAILED", message: "作品删除失败，已记录待处理" }, 503);
  }
});

app.get("/api/works", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  const works = [];
  for (const record of objectStore.listOwned(result.auth.userId).filter((item) => item.purpose.startsWith("output") || item.purpose.startsWith("features"))) {
    works.push({ assetId: record.id, createdAt: record.createdAt, expiresAt: record.expiresAt, kind: record.contentType.startsWith("video/") ? "video" : "image", url: await objectStore.signedUrl(record.id, { ownerId: result.auth.userId, base: requestBase(c) }), metadata: record.metadata });
  }
  return c.json({ code: 0, data: works });
});

app.delete("/api/account", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  // This isolated test must not initiate provider requests for historical media.
  if (APP_ACCOUNT_ONLY && (objectStore.backend !== 'file' || Object.values(objectStore.index).some(item => item.ownerId === result.auth.userId && !item.deletedAt))) {
    return c.json({ code: 'ACCOUNT_DATA_REVIEW_REQUIRED', message: '此账号含历史作品，请联系客服处理注销' }, 409);
  }
  let deleted;
  try {
    deleted = await objectStore.deleteOwned(result.auth.userId, "account_deleted", { beforeDelete: requestSupplierDeletion });
  } catch (error) {
    alertMetric("account.erasure_failed", { userId: result.auth.userId, error: safeError(error) });
    store.recordAudit({ userId: result.auth.userId, action: "account.erasure_failed", resourceType: "user", resourceId: result.auth.userId, details: { error: safeError(error) } });
    return c.json({ code: "ERASURE_FAILED", message: "账号删除暂未完成，请稍后重试" }, 503);
  }
  const failures = deleted.filter((item) => !item.deleted && !item.missing);
  const supplierPending = deleted.filter((item) => item.supplierDeletion && item.supplierDeletion.status !== "confirmed");
  const scrubbedTasks = await scrubTasksForUser(result.auth.userId, "account_deleted");
  if(accountRegistry) await accountRegistry.deleteIdentity(result.auth.userId,async()=>{
    store.markUserDeleted(result.auth.userId);
    await flushComplianceStore();
  });
  else {
    store.markUserDeleted(result.auth.userId);
    if (c.get('miniIdentitySelected')) {
      await flushComplianceStore();
      await (await miniIdentityRuntime()).revokeUserSessions(result.auth.userId);
    }
  }
  store.recordAudit({ userId: result.auth.userId, action: "account.erasure_requested", resourceType: "user", resourceId: result.auth.userId, details: { deleted: deleted.length, failures: failures.length, supplierPending: supplierPending.length, scrubbedTasks } });
  const partial = failures.length > 0 || supplierPending.length > 0;
  return c.json({ code: partial ? "ERASURE_PARTIAL" : 0, data: { deleted: deleted.length, failures, supplierPending, scrubbedTasks } }, failures.length ? 503 : supplierPending.length ? 202 : 200);
});

app.post("/api/internal/retention/sweep", async (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  try {
    return c.json({ code: 0, data: await runRetentionSweep() });
  } catch (error) {
    alertMetric("retention.sweep_failed", { error: safeError(error) });
    return c.json({ code: "RETENTION_FAILED", message: "保存期清理失败" }, 503);
  }
});

app.post("/api/reports", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(`${ip}:report`, 5)) return c.json({ code: "REPORT_RATE_LIMITED", message: "提交过于频繁，请稍后再试" }, 429);
  const result = authenticated(c);
  if (result.response) return result.response;
  if (!rateLimit(`${result.auth.userId}:report-user`, 10)) return c.json({ code: "REPORT_RATE_LIMITED", message: "提交过于频繁，请稍后再试" }, 429);
  const body = await c.req.json().catch(() => ({}));
  const category = String(body.category || "").trim();
  const description = String(body.description || "").trim();
  const contact = String(body.contact || "").trim();
  const assetId = body.assetId == null || body.assetId === "" ? null : String(body.assetId).trim();
  const templateId = body.templateId == null || body.templateId === "" ? null : String(body.templateId).trim();
  const categories = new Set(["likeness", "minor", "rights", "ai_label", "harmful", "other"]);
  if (!categories.has(category)) return c.json({ code: "INVALID_REPORT_CATEGORY", message: "举报类型无效" }, 400);
  if (description.length < 10 || description.length > 2_000) return c.json({ code: "INVALID_REPORT_DESCRIPTION", message: "问题说明需为10至2000个字符" }, 400);
  if (contact.length > 200) return c.json({ code: "INVALID_REPORT_CONTACT", message: "联系方式不能超过200个字符" }, 400);
  if (assetId && !/^obj_[0-9a-f-]{36}$/i.test(assetId)) return c.json({ code: "INVALID_REPORT_ASSET", message: "关联作品编号无效" }, 400);
  if (templateId && !/^[A-Za-z0-9:_-]{1,80}$/.test(templateId)) return c.json({ code: "INVALID_REPORT_TEMPLATE", message: "关联模板编号无效" }, 400);
  if (assetId) {
    try { objectStore.assertOwnedReference(assetId, result.auth.userId); }
    catch (error) {
      const status = error?.message === "OBJECT_NOT_OWNED" ? 403 : 400;
      return c.json({ code: "INVALID_REPORT_ASSET", message: "关联作品不存在或无权访问" }, status);
    }
  }
  try {
    const report = store.createReport({
      userId: result.auth.userId,
      category,
      description,
      contact,
      assetId,
      templateId,
      evidence: { requestId: requestId(c), channel: result.auth.channel, networkFingerprint: privacyFingerprint(c) },
    });
    return c.json({ code: 0, data: { ticketId: report.id, status: report.status, createdAt: report.createdAt } }, 202);
  } catch (error) {
    logSecurity("error", "report.store_failed", safeError(error));
    return c.json({ code: "REPORT_STORAGE_UNAVAILABLE", message: "投诉举报暂时无法提交，请联系公开支持渠道" }, 503);
  }
});

app.get("/api/ops/metrics", (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  return c.json({ code: 0, data: metricsSnapshot() });
});

app.get("/api/internal/reconciliation", (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  return c.json({ code: 0, data: store.reconcileEntitlements() });
});

app.get("/api/internal/audits", (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  const limit = Number(c.req.query("limit") || 200);
  return c.json({ code: 0, data: store.listAudits({ limit }) });
});

app.get("/api/internal/reports", (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  const status = String(c.req.query("status") || "").trim() || undefined;
  const limit = boundedInteger(c.req.query("limit"), 200, 1, 1_000);
  return c.json({ code: 0, data: store.listReports({ status, limit }) });
});

app.get("/api/internal/supplier-deletions", (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  return c.json({ code: 0, data: store.listSupplierDeletions() });
});

app.get("/api/internal/monitoring", (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  return c.json({ code: 0, data: monitoringSnapshot() });
});

app.post("/api/internal/alert-drill", (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  const alert = alertMetric("alert.drill", { requestId: requestId(c), message: "manual monitoring drill" });
  return c.json({ code: 0, data: { deliveredToLog: true, alert } });
});

/* ---------- 进程内限流：只接受规范化来源地址，并限制键数量防止内存耗尽。 ---------- */
const rateMap = new Map();
let rateOperations = 0;
function rateLimit(key, max = 3) {
  const now = Date.now();
  rateOperations += 1;
  if (rateOperations % 256 === 0) {
    for (const [candidate, timestamps] of rateMap) {
      const active = timestamps.filter((time) => now - time < 60_000);
      if (active.length) rateMap.set(candidate, active);
      else rateMap.delete(candidate);
    }
  }
  if (!rateMap.has(key) && rateMap.size >= boundedInteger(process.env.RATE_LIMIT_MAX_KEYS, 10_000, 100, 100_000)) return false;
  const rec = rateMap.get(key) || [];
  const recent = rec.filter((t) => now - t < 60_000);
  const safeMax = boundedInteger(max, 3, 1, 10_000);
  if (recent.length >= safeMax) return false;
  recent.push(now);
  rateMap.set(key, recent);
  return true;
}

/* ---------- Mock 渠道（演示模式） ---------- */
const mockTasks = new Map();
const mock = {
  async createTask() {
    const taskId = `mock-${crypto.randomUUID()}`;
    mockTasks.set(taskId, Date.now());
    return { taskId, model: "mock-video-fusion" };
  },
  async queryTask(taskId) {
    const start = mockTasks.get(taskId);
    if (!start) return { status: "FAILED" };
    // 模拟约15秒生成
    return Date.now() - start > 15_000
      ? { status: "SUCCESS", videoUrl: "/mock/result.mp4" }
      : { status: "RUNNING" };
  },
};

function provider() {
  if (PROVIDER === "aliyun" && process.env.ALIYUN_ACCESS_KEY_ID) return aliyun;
  if (PROVIDER === "tencent" && process.env.TENCENT_SECRET_ID) return tencent;
  if (PROVIDER === "volcengine" && process.env.VOLC_API_KEY) return volcengine;
  if (PROVIDER === "mock" && !PRODUCTION && ALLOW_MOCK_PROVIDER) return mock;
  const error = new Error("PROVIDER_NOT_CONFIGURED");
  error.code = "PROVIDER_NOT_CONFIGURED";
  throw error;
}

/* ---------- 接口 ---------- */

// 创建换脸任务
app.post("/api/fusion", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":feat", 20)) {
    return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  }

  const { templateId, userPhotoUrl } = await c.req.json().catch(() => ({}));
  const tpl = resolveVideoTemplate(templateId, adminStore.publicCatalog(), TEMPLATES, requestBase(c));
  if (!tpl || !userPhotoUrl) {
    return c.json({ code: 400, message: "参数错误" }, 400);
  }
  if (!adminStore.publicCatalog().templates.some((item) => item.id === templateId && item.enabled)) {
    return c.json({ code: "TEMPLATE_DISABLED", message: "该视频模板已暂停使用" }, 404);
  }
  if (!tpl.aliyunTemplateId && !tpl.videoUrl) {
    return c.json({ code: 503, message: "该视频模板暂未配置" }, 503);
  }
  if (!tpl.managed && !licensedTemplate(templateId)) {
    return c.json({ code: 503, message: "该模板尚未完成授权登记" }, 503);
  }

  const prepared = await prepareGeneration(c, { inputUrl: userPhotoUrl, purpose: "video-fusion", metadata: { templateId } });
  if (prepared.response) return prepared.response;

  try {
    const p = provider();
    const providerVideoUrl = PROVIDER === "aliyun" && tpl.aliyunTemplateId
      ? undefined
      : PROVIDER === "mock"
        ? tpl.videoUrl
        : tpl.managed ? tpl.videoUrl : await objectStore.providerUrlForConfiguredOssObject(tpl.videoUrl, { ttlSeconds: 900 });
    const { taskId, model } = await p.createTask({
      templateId: tpl.aliyunTemplateId || undefined,
      videoUrl: providerVideoUrl,
      userPhotoUrl: prepared.inputUrl,
    });
    tasks[taskId] = {
      type: "fusion",
      ownerId: prepared.userId,
      templateId,
      templateSnapshot: tpl,
      inputObjectId: prepared.input.id,
      billingRef: prepared.billingRef,
      purpose: prepared.purpose,
      provider: PROVIDER,
      model: model || null,
      status: "QUEUED",
      createdAt: Date.now(),
    };
    await saveTask(taskId, tasks[taskId], tasks);
    return c.json({ code: 0, data: { taskId, provider: PROVIDER, model: model || null } });
  } catch (e) {
    await refundPrepared(prepared, "task_create_failed");
    logSecurity("error", "fusion.create_failed", { requestId: requestId(c), error: safeError(e) });
    return c.json({ code: 500, message: "生成服务繁忙，请稍后再试" }, 500);
  }
});

// 轮询任务状态
app.get("/api/fusion/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const authResult = authenticated(c);
  if (authResult.response) return authResult.response;
  const meta = tasks[taskId];
  if (!meta || meta.type !== "fusion") return c.json({ code: 404, message: "任务不存在" }, 404);
  if (meta.ownerId !== authResult.auth.userId) return c.json({ code: "FORBIDDEN", message: "无权查询该任务" }, 403);
  if (meta.outputObjectId) {
    const existing = objectStore.get(meta.outputObjectId);
    if (!existing) return c.json({ code: 410, message: "作品已过保存期" }, 410);
    await billingStore.confirmCreation(meta.ownerId, meta.billingRef, meta.purpose || "video-fusion");
    return c.json({
      code: 0,
      data: {
        status: "SUCCESS",
        assetId: existing.id,
        videoUrl: await objectStore.signedUrl(existing.id, { ownerId: meta.ownerId, base: requestBase(c) }),
        stored: true,
        metadata: existing.metadata,
      },
    });
  }
  try {
    const p = provider();
    const r = await p.queryTask(taskId);
    if (r.status === "FAILED") {
      await updateTask(taskId, { status: "FAILED", failedAt: Date.now() });
      await refundPrepared({ userId: meta.ownerId, billingRef: meta.billingRef }, "provider_failed");
      return c.json({ code: 0, data: r });
    }
    if (r.status !== "SUCCESS") {
      return c.json({ code: 0, data: r });
    }
    if (!r.videoUrl) throw new Error("供应商未返回结果视频");

    // 换脸成功 → 若该模板配置了遮挡 mask，自动做「遮挡回贴」修复
    const tpl = meta.templateSnapshot || TEMPLATES[meta.templateId];
    if (!tpl || !tpl.maskKey || !tpl.videoUrl) {
      if (!fusionOutputs.has(taskId)) {
          fusionOutputs.set(
          taskId,
          persistGenerationOutput(c, {
            tmpUrl: r.videoUrl,
            ownerId: meta.ownerId,
            billingRef: meta.billingRef,
            purpose: "output/video-fusion",
            kind: "video",
            provider: meta.provider,
            model: meta.model || null,
            taskId,
            base: requestBase(c),
          })
            .catch((error) => {
              fusionOutputs.delete(taskId);
              throw error;
            }),
        );
      }
      const stored = await Promise.race([
        fusionOutputs.get(taskId).then((value) => ({ value })),
        new Promise((resolve) => setTimeout(() => resolve(null), 25_000)),
      ]);
      if (!stored) return c.json({ code: 0, data: { status: "RUNNING", storing: true } });
      await updateTask(taskId, { status: "SUCCESS", outputObjectId: stored.value.assetId, completedAt: Date.now() });
      return c.json({ code: 0, data: { status: "SUCCESS", videoUrl: stored.value.url, assetId: stored.value.assetId, stored: true, metadata: stored.value.metadata } });
    }
    if (!repairs.has(taskId)) {
      const repairTemplateUrl = PROVIDER === "mock"
        ? tpl.videoUrl
        : await objectStore.providerUrlForConfiguredOssObject(tpl.videoUrl, { ttlSeconds: 900 });
      repairs.set(
        taskId,
        repairOcclusion({
          taskId,
          swapUrl: r.videoUrl,
          videoUrl: repairTemplateUrl,
          maskKey: tpl.maskKey,
          ownerId: meta.ownerId,
          base: requestBase(c),
          provider: meta.provider,
          providerModel: meta.model,
        }).catch((e) => {
            logSecurity("error", "fusion.occlusion_repair_failed", { taskId, error: safeError(e) });
            throw e;
          })
      );
    }
    const done = await Promise.race([
      repairs.get(taskId).then((v) => ({ v })),
      new Promise((s) => setTimeout(() => s(null), 25_000)),
    ]);
    if (!done) {
      // 修复中（1080p 约 0.5x 时长），前端继续轮询
      return c.json({ code: 0, data: { status: "RUNNING", repairing: true } });
    }
    await updateTask(taskId, { status: "SUCCESS", outputObjectId: done.v.assetId, completedAt: Date.now() });
    await billingStore.confirmCreation(meta.ownerId, meta.billingRef, meta.purpose || "video-fusion");
    return c.json({ code: 0, data: { status: "SUCCESS", videoUrl: done.v.url, assetId: done.v.assetId, repaired: true, metadata: done.v.metadata } });
  } catch (e) {
    await updateTask(taskId, { status: "FAILED", failedAt: Date.now(), failureCode: safeError(e).code || "GENERATION_FAILED" }).catch((saveError) => {
      logSecurity("error", "fusion.failure_state_persist_failed", { taskId, error: safeError(saveError) });
    });
    await refundPrepared({ userId: meta.ownerId, billingRef: meta.billingRef }, "generation_failed");
    logSecurity("error", "fusion.query_failed", { taskId, error: safeError(e) });
    if (["OUTPUT_CONTENT_BLOCKED", "OUTPUT_REVIEW_REQUIRED"].includes(e.message)) {
      return c.json({ code: e.message, message: "生成结果未通过内容安全检查" }, 422);
    }
    return c.json({ code: 500, message: "查询失败" }, 500);
  }
});

async function billingReadiness() {
  if (virtualEnabled()) return virtualReadiness({ identityReady: complianceStoreReadiness().productionSupported === true, adminReady: adminAuthReadiness().ready });
  return paymentReadiness(await billingStoreReadiness());
}

function approvedPublicUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function approvedPublicOrigin(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname && url.pathname !== "/")) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function publicComplianceConfig() {
  let aiServices = [];
  const allowedCapabilities = new Set(["video-fusion", "photo-restore", "photo-fusion", "idphoto", "photo-age", "photo-effect", "photo-anime", "photo-bg", "video-matting", "llm-chat", "play-analyze"]);
  try {
    const parsed = JSON.parse(process.env.AI_SERVICE_DISCLOSURES_JSON || "[]");
    if (Array.isArray(parsed)) {
      aiServices = parsed.map((item) => ({
        provider: String(item?.provider || "").trim(),
        model: String(item?.model || "").trim(),
        filingReference: String(item?.filingReference || "").trim(),
        purpose: String(item?.purpose || "").trim(),
        region: String(item?.region || "").trim(),
        capabilities: Array.isArray(item?.capabilities)
          ? [...new Set(item.capabilities.map((value) => String(value || "").trim()).filter((value) => allowedCapabilities.has(value)))]
          : [],
      })).filter((item) => item.provider && item.model && item.filingReference && item.purpose && item.region && item.capabilities.length > 0);
    }
  } catch {
    aiServices = [];
  }
  const data = {
    operatorName: String(process.env.OPERATOR_NAME || "").trim() || null,
    appRecordNumber: String(process.env.APP_RECORD_NO || "").trim() || null,
    icpFilingNumber: String(process.env.ICP_RECORD_NO || "").trim() || null,
    privacyPolicyUrl: approvedPublicUrl(process.env.PRIVACY_POLICY_URL),
    userAgreementUrl: approvedPublicUrl(process.env.USER_AGREEMENT_URL),
    thirdPartyListUrl: approvedPublicUrl(process.env.THIRD_PARTY_LIST_URL),
    supportContact: String(process.env.SUPPORT_CONTACT || "").trim() || null,
    pipiaReference: String(process.env.PIPIA_REFERENCE || "").trim() || null,
    consentVersions: { basic: BASIC_CONSENT_VERSION, faceProcessing: FACE_CONSENT_VERSION },
    retention: process.env.RETENTION_SUPPLIER_POLICY ? {
      sourceHours: Number((boundedInteger(process.env.INPUT_RETENTION_SECONDS, 86_400, 60, 31_536_000) / 3600).toFixed(2)),
      resultHours: Number((boundedInteger(process.env.OUTPUT_RETENTION_SECONDS, 86_400, 60, 31_536_000) / 3600).toFixed(2)),
      reportSensitiveDays: boundedInteger(process.env.REPORT_RETENTION_DAYS, 180, 1, 3650),
      supplierPolicy: String(process.env.RETENTION_SUPPLIER_POLICY).slice(0, 500),
    } : null,
    aiServices,
  };
  const missing = [];
  if (!data.privacyPolicyUrl) missing.push("PRIVACY_POLICY_URL must be an approved HTTPS document");
  if (!data.userAgreementUrl) missing.push("USER_AGREEMENT_URL must be an approved HTTPS document");
  if (!data.thirdPartyListUrl) missing.push("THIRD_PARTY_LIST_URL must be an approved HTTPS document");
  if (!data.supportContact) missing.push("SUPPORT_CONTACT must identify the company support channel");
  if (!data.pipiaReference) missing.push("PIPIA_REFERENCE must identify the approved personal information impact assessment");
  if (!data.operatorName) missing.push("OPERATOR_NAME must identify the legal service operator");
  const releaseChannel = String(process.env.RELEASE_CHANNEL || "wechat-mini-program").toLowerCase();
  if (PRODUCTION && releaseChannel === "android-app" && !data.appRecordNumber) missing.push("APP_RECORD_NO must identify the Android app filing");
  if (PRODUCTION && releaseChannel === "android-app" && !data.icpFilingNumber) missing.push("ICP_RECORD_NO must identify the Android API domain filing");
  if (!data.retention) missing.push("RETENTION_SUPPLIER_POLICY and bounded retention periods are required");
  if (data.aiServices.length === 0) missing.push("AI_SERVICE_DISCLOSURES_JSON must publish the approved provider/model/filing facts");
  for (const capability of ["video-fusion", "photo-restore", "photo-age", "photo-effect", "photo-anime", "photo-bg"]) {
    if (!data.aiServices.some((item) => item.capabilities.includes(capability))) missing.push(`AI service disclosure is missing capability: ${capability}`);
  }
  return { ...data, status: missing.length ? "pending_company_approval" : "approved", blockers: PRODUCTION ? missing : [] };
}

function generationDisclosureReady(purpose) {
  const capability = String(purpose || "")
    .replace(/^photo-effect:.+$/, "photo-effect")
    .replace(/^photo-anime:.+$/, "photo-anime")
    .replace(/^photo-bg:.+$/, "photo-bg");
  const compliance = publicComplianceConfig();
  return compliance.status === "approved" && compliance.aiServices.some((service) => service.capabilities.includes(capability));
}

function licenseReadiness() {
  const configuredIds = String(process.env.LICENSED_ASSET_IDS || "").split(",").map((idValue) => idValue.trim()).filter(Boolean);
  const blockers = PRODUCTION && configuredIds.length === 0 ? ["LICENSED_ASSET_IDS must be supplied from the company asset authorization ledger"] : [];
  return { ready: blockers.length === 0, licensedAssetIds: configuredIds, blockers };
}

function taskStorageReadiness() {
  const status = taskStoreStatus();
  const blockers = [...status.blockers];
  if (PRODUCTION && status.requestedBackend !== "oss") blockers.push("TASKS_BACKEND=oss is required for production task persistence");
  return { ...status, ready: blockers.length === 0, blockers };
}

async function launchReadiness() {
  const releaseChannel = String(process.env.RELEASE_CHANNEL || "wechat-mini-program").toLowerCase();
  const storage = storageConfig();
  const statuses = {
    auth: authReadiness(),
    realName: realNameReadiness(),
    storage,
    contentSafety: contentSafetyReadiness(),
    aiMarking: markingReadiness(),
    billing: await billingReadiness(),
    licenses: licenseReadiness(),
    supplierDeletion: supplierDeletionReadiness(),
    monitoring: monitoringReadiness(),
    publicCompliance: publicComplianceConfig(),
    tasks: taskStorageReadiness(),
    complianceLedger: complianceStoreReadiness(),
    adminAuth: adminAuthReadiness(),
    adminConfig: adminStoreReadiness(),
    adminWorkflows: adminWorkflowStoreReadiness(),
    capabilities: capabilityReadiness({
      videoTemplates: readyVideoTemplates.length,
      photoTemplates: Object.values(PHOTO_TEMPLATES).filter((v) => v.imageTemplateId || v.imgUrl).length,
    }),
  };
  const blockers = Object.values(statuses).flatMap((status) => [
    ...(status.blockers || []),
    ...(status.readiness?.blockers || []),
  ]);
  if (PRODUCTION && storage.backend === "file") blockers.push("OBJECT_STORAGE_BACKEND=oss is required for production persistence");
  if (PRODUCTION && storage.objectIndex?.transactionSafe === false) blockers.push(storage.objectIndex.productionBlocker || "object index persistence is not transaction-safe for production");
  if (PRODUCTION && !storage.signingSecretConfigured) blockers.push("OBJECT_SIGNING_SECRET or AUTH_SESSION_SECRET is required for signed objects");
  if (PRODUCTION && !configuredPublicBase()) blockers.push("PUBLIC_BASE_URL must be an origin-only HTTPS URL so providers can fetch signed input objects");
  const corsOrigin = String(process.env.CORS_ORIGIN || "");
  if (PRODUCTION && (!corsOrigin || corsOrigin === "*" || corsOrigin.split(",").some((origin) => !approvedPublicOrigin(origin)))) blockers.push("CORS_ORIGIN must be an explicit HTTPS origin allowlist in production");
  if (PRODUCTION && !String(process.env.OUTBOUND_HOST_ALLOWLIST || "").trim()) blockers.push("OUTBOUND_HOST_ALLOWLIST must list the reviewed supplier and object-storage hostnames");
  if (PRODUCTION && String(process.env.REPORT_DATA_ENCRYPTION_KEY || "").length < 32) blockers.push("REPORT_DATA_ENCRYPTION_KEY must be a separate 32+ character production secret");
  if (PRODUCTION && (!Number.isSafeInteger(Number(process.env.REPORT_RETENTION_DAYS)) || Number(process.env.REPORT_RETENTION_DAYS) < 1 || Number(process.env.REPORT_RETENTION_DAYS) > 3650)) blockers.push("REPORT_RETENTION_DAYS must explicitly be between 1 and 3650 in production");
  if (PRODUCTION && !/^[a-f0-9]{64}$/i.test(String(process.env.BASIC_CONSENT_NOTICE_SHA256 || ""))) blockers.push("BASIC_CONSENT_NOTICE_SHA256 must pin the approved basic-consent notice");
  if (PRODUCTION && !/^[a-f0-9]{64}$/i.test(String(process.env.FACE_CONSENT_NOTICE_SHA256 || ""))) blockers.push("FACE_CONSENT_NOTICE_SHA256 must pin the approved face-processing notice");
  if (PRODUCTION && !Number.isSafeInteger(Number(process.env.PROVIDER_DAILY_CALL_LIMIT)) || PRODUCTION && Number(process.env.PROVIDER_DAILY_CALL_LIMIT) < 1) blockers.push("PROVIDER_DAILY_CALL_LIMIT must be an explicit positive production budget");
  if (PRODUCTION && !Number.isSafeInteger(Number(process.env.USER_DAILY_GENERATION_LIMIT)) || PRODUCTION && Number(process.env.USER_DAILY_GENERATION_LIMIT) < 1) blockers.push("USER_DAILY_GENERATION_LIMIT must be an explicit positive per-user production budget");
  if (PRODUCTION && !process.env.RETENTION_SUPPLIER_POLICY) blockers.push("RETENTION_SUPPLIER_POLICY must document provider copy deletion capability");
  if (PRODUCTION && !process.env.SERVICE_PROVIDER_CODE) blockers.push("SERVICE_PROVIDER_CODE must be supplied for implicit AI metadata");
  if (PRODUCTION && !process.env.AI_MODEL_FILING_REFERENCE) blockers.push("AI_MODEL_FILING_REFERENCE must identify the public model/service filing record");
  if (PRODUCTION && releaseChannel === "wechat-mini-program" && !process.env.MINIPROGRAM_APPID) blockers.push("MINIPROGRAM_APPID is a company credential required for the formal mini-program package");
  if (PRODUCTION && releaseChannel === "wechat-mini-program" && !process.env.MINIPROGRAM_RECORD_NO) blockers.push("MINIPROGRAM_RECORD_NO is required for the formal mini-program package");
  if (PRODUCTION && releaseChannel === "android-app" && !process.env.APP_PACKAGE_NAME) blockers.push("APP_PACKAGE_NAME is required for the Android release");
  if (PRODUCTION && releaseChannel === "android-app" && !process.env.APP_RECORD_NO) blockers.push("APP_RECORD_NO is required for the Android release");
  if (PRODUCTION && releaseChannel === "android-app" && !process.env.ICP_RECORD_NO) blockers.push("ICP_RECORD_NO is required for the Android API domain");
  if (PRODUCTION && PAYMENT_MODE === "live" && process.env.PAYMENT_ADAPTER_VERIFIED !== "true") blockers.push("PAYMENT_ADAPTER_VERIFIED=true requires signed sandbox callback and reconciliation evidence");
  return {
    status: PRODUCTION ? (blockers.length ? "NO-GO" : "GO") : "CLOSED_TEST",
    publicLaunchAllowed: PRODUCTION && blockers.length === 0,
    environment: DEPLOY_ENV,
    blockers: [...new Set(blockers)],
    checks: statuses,
    checkedAt: new Date().toISOString(),
  };
}

app.get("/health", (c) => c.json({
  ok: accountOperationsHealthy(),
  status: accountOperationsHealthy() ? "live" : "degraded",
  version: "2026-09-14-admin-console-r2",
}, accountOperationsHealthy() ? 200 : 503));

app.get('/api/internal/account-operations', c => {
  const denied = internalOnly(c);
  if (denied) return denied;
  return c.json({ code: 0, data: { enabled: ACCOUNT_OPERATIONS_ENABLED,
    log: accountSecurityLog?.health() || null, retention: accountRetentionJob?.status() || accountRetention?.status() || null } });
});

app.get("/api/catalog", (c) => {
  const catalog = adminStore.publicCatalog();
  let purposeRules;
  try { purposeRules = JSON.parse(process.env.XPAY_PURPOSE_RULES_JSON || '{}'); } catch { purposeRules = {}; }
  const photoCapability = capabilityRegistry().find(item => item.id === 'photo-effects');
  return c.json({
    code: 0,
    data: {
      ...catalog,
      ...(APP_ACCOUNT_ONLY ? { settings: { ...catalog.settings, generationEnabled: false, captionEnabled: false, maintenanceNotice: ACCOUNT_ONLY_MESSAGE } } : {}),
      miniProgramCreation: miniCreationCatalog({ catalog,
        enabled: virtualEnabled() && process.env.RELEASE_CHANNEL === 'wechat-mini-program' && authConfig().mode === 'wechat',
        capabilityReady: photoCapability?.ready === true,
        disclosureReady: generationDisclosureReady('photo-effect'), purposeRules }),
      templates: catalog.templates.filter((item) => item.enabled),
      photoCategories: catalog.photoCategories.filter((item) => item.enabled),
      photoEffects: catalog.photoEffects.filter((item) => item.enabled).map(({ prompt: _prompt, ...item }) => item),
    },
  });
});

function adminApiError(c, error) {
  const code = String(error?.code || "ADMIN_OPERATION_FAILED");
  const status = code === "REVISION_CONFLICT" || code === "NO_CHANGES" || code === "ASSET_CHANGED" || code === "UNSEALED_RELEASE" ? 409
    : code === "RELEASE_NOT_FOUND" || code === "REQUEST_NOT_FOUND" ? 404
      : code === "INVALID_CATALOG" || code === "LOW_CONTRAST" || code.startsWith("INVALID_") || code === "IMMUTABLE_FIELD" || code === "PROVIDER_HINT_SECRET_REJECTED" ? 400
        : 500;
  if (status === 500) logSecurity("error", "admin.operation_failed", safeError(error));
  return c.json({ code, message: status === 500 ? "后台操作失败，请稍后重试" : error.message, details: error?.details || undefined }, status);
}

app.post("/api/admin/session", async (c) => {
  const fingerprint = clientAddress(c);
  if (!allowAdminLogin(fingerprint)) return c.json({ code: "ADMIN_LOGIN_RATE_LIMITED", message: "登录尝试过多，请 15 分钟后再试" }, 429);
  const authReadiness = adminAuthReadiness();
  if (!authReadiness.configuredUsers || !authReadiness.sessionSigningReady) return c.json({ code: "ADMIN_NOT_CONFIGURED", message: "管理员认证尚未安全配置" }, 503);
  const origin = String(c.req.header("origin") || "").trim();
  if (origin && origin !== requestBase(c)) return c.json({ code: "ADMIN_LOGIN_ORIGIN_REJECTED", message: "登录请求来源无效" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const user = authenticateAdmin(body.username, body.password);
  if (!user) {
    logSecurity("warn", "admin.login_rejected", { requestId: requestId(c), source: fingerprint });
    return c.json({ code: "ADMIN_LOGIN_FAILED", message: "账号或密码错误" }, 401);
  }
  clearAdminLoginAttempts(fingerprint);
  const session = createAdminSession(user);
  c.header("Set-Cookie", session.cookie);
  store.recordAudit({ action: "admin.login", resourceType: "admin_session", resourceId: user.username, reviewerId: user.username, details: { role: user.role } });
  return c.json({ code: 0, data: { user: session.user, csrfToken: session.csrfToken, expiresAt: session.expiresAt } });
});

app.get("/api/admin/me", (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: { user: result.session, csrfToken: csrfFor(result.session) } });
});

app.post("/api/admin/logout", (c) => {
  const result = requireAdmin(c, { csrf: true });
  if (result.response) return result.response;
  revokeAdminSession(result.session);
  c.header("Set-Cookie", clearAdminCookie());
  store.recordAudit({ action: "admin.logout", resourceType: "admin_session", resourceId: result.session.username, reviewerId: result.session.username });
  return c.json({ code: 0, data: { loggedOut: true } });
});

app.get("/api/admin/dashboard", (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  const compliance = store.snapshot();
  const monitor = monitoringSnapshot();
  const analytics = store.generationAnalytics();
  const capabilities = capabilityRegistry({
    videoTemplates: readyVideoTemplates.length,
    photoTemplates: Object.values(PHOTO_TEMPLATES).filter((value) => value.imageTemplateId || value.imgUrl).length,
  });
  const reports = store.listReports({ limit: 1000 });
  const moderation = store.listModeration({ limit: 1000 });
  return c.json({ code: 0, data: {
    catalog: adminStore.summary(),
    service: {
      status: monitor.status,
      http5xx: monitor.http5xxRecent,
      http5xxTotal: monitor.http5xx,
      http5xxRate: monitor.http5xxRate,
      requests: monitor.recentRequests,
      avgLatencyMs: monitor.http?.avgLatencyMs ?? 0,
      capturedAt: monitor.capturedAt,
      alerts: monitor.alerts.slice(-12).reverse(),
      slowRoutes: monitor.slowRoutes,
      series: monitor.series,
      incidents: monitor.incidents,
      playbooks: monitor.playbooks,
      readiness: monitor.readiness,
    },
    analytics,
    usage: {
      users: compliance.users.filter((user) => user.status === "active").length,
      orders: compliance.orderCount,
      ledgerEntries: compliance.ledgerCount,
      reportsOpen: reports.filter((report) => !["resolved", "rejected"].includes(report.status)).length,
      moderationReview: moderation.filter((item) => item.decision === "review").length,
      supplierDeletionPending: store.listSupplierDeletions().filter((item) => item.status !== "confirmed").length,
    },
    capabilities,
    environment: { deploy: DEPLOY_ENV, provider: PROVIDER, photoProvider: PHOTO_PROVIDER, releaseChannel: String(process.env.RELEASE_CHANNEL || "wechat-mini-program") },
  } });
});

app.get("/api/admin/monitoring", (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: { service: monitoringSnapshot(), analytics: store.generationAnalytics() } });
});

app.get("/api/admin/analytics", (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: store.generationAnalytics() });
});

app.get("/api/admin/catalog", (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: adminStore.workspace() });
});

app.post("/api/admin/catalog/validate", async (c) => {
  const result = requireAdmin(c, { csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  try {
    const catalog = validateCatalog(body.catalog);
    return c.json({ code: 0, data: {
      valid: true,
      catalogHash: crypto.createHash("sha256").update(JSON.stringify(catalog)).digest("hex"),
    } });
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.get("/api/admin/workflows", (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  try {
    const type = String(c.req.query("type") || "").trim() || undefined;
    const status = String(c.req.query("status") || "").trim() || undefined;
    const riskLevel = String(c.req.query("riskLevel") || "").trim() || undefined;
    return c.json({ code: 0, data: workflowStore.list({ type, status, riskLevel, limit: boundedInteger(c.req.query("limit"), 300, 1, 1000) }) });
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.post("/api/admin/workflows", async (c) => {
  const result = requireAdmin(c, { roles: ["owner", "operator"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ code: 0, data: workflowStore.create({ ...body, actor: result.session.username }) }, 201);
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.patch("/api/admin/workflows/:workflowId", async (c) => {
  const result = requireAdmin(c, { roles: ["owner", "operator", "reviewer"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  const patch = body.patch && typeof body.patch === "object" && !Array.isArray(body.patch) ? body.patch : {};
  const changesStatus = Object.prototype.hasOwnProperty.call(patch, "status");
  if (changesStatus && !["owner", "reviewer"].includes(result.session.role)) return c.json({ code: "ADMIN_FORBIDDEN", message: "仅审核角色可以推进或驳回接入流程" }, 403);
  if (!changesStatus && !["owner", "operator"].includes(result.session.role)) return c.json({ code: "ADMIN_FORBIDDEN", message: "当前账号不能修改接入需求内容" }, 403);
  try {
    return c.json({ code: 0, data: workflowStore.update({
      id: c.req.param("workflowId"),
      expectedRevision: body.expectedRevision,
      actor: result.session.username,
      patch,
    }) });
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.get("/api/admin/workflow-audits", (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  try {
    const workflowId = String(c.req.query("workflowId") || "").trim() || undefined;
    return c.json({ code: 0, data: workflowStore.audits({ requestId: workflowId, limit: boundedInteger(c.req.query("limit"), 300, 1, 1000) }) });
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.get("/api/admin/risks", (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  try {
    return c.json({ code: 0, data: workflowStore.risks(monitoringSnapshot().incidents) });
  } catch (error) { return adminApiError(c, error); }
});

app.post("/api/admin/risks/actions", async (c) => {
  const result = requireAdmin(c, { roles: ["owner", "operator", "reviewer"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  if (["resolve", "reopen"].includes(body.action) && !["owner", "reviewer"].includes(result.session.role)) return c.json({ code: "ADMIN_FORBIDDEN", message: "仅审核角色可以解决或重新打开风险" }, 403);
  try {
    return c.json({ code: 0, data: workflowStore.actOnRisk({ ...body, actor: result.session.username }, monitoringSnapshot().incidents) });
  } catch (error) { return adminApiError(c, error); }
});

app.put("/api/admin/catalog/draft", async (c) => {
  const result = requireAdmin(c, { roles: ["owner", "operator"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ code: 0, data: adminStore.updateDraft({ catalog: body.catalog, expectedRevision: body.expectedRevision, actor: result.session.username, note: body.note }) });
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.post("/api/admin/catalog/publish", async (c) => {
  const result = requireAdmin(c, { roles: ["owner", "reviewer"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  const workspace = adminStore.workspace();
  if ((PRODUCTION || process.env.ADMIN_REQUIRE_DUAL_APPROVAL === "true") && workspace.draft.updatedBy === result.session.username) {
    return c.json({ code: "INDEPENDENT_APPROVAL_REQUIRED", message: "生产发布必须由另一名审核人批准" }, 403);
  }
  try {
    return c.json({ code: 0, data: adminStore.publish({ expectedRevision: body.expectedRevision, actor: result.session.username, note: body.note }) });
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.post("/api/admin/catalog/rollback", async (c) => {
  const result = requireAdmin(c, { roles: ["owner", "reviewer"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  try {
    return c.json({ code: 0, data: adminStore.rollback({ releaseId: String(body.releaseId || ""), actor: result.session.username, note: body.note }) });
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.post("/api/admin/emergency-pause", async (c) => {
  const result = requireAdmin(c, { roles: ["owner"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  try {
    alertMetric("admin.emergency_pause", { actor: result.session.username, reason: String(body.reason || "").slice(0, 120) });
    return c.json({ code: 0, data: adminStore.emergencyPause({ actor: result.session.username, reason: body.reason }) });
  } catch (error) {
    return adminApiError(c, error);
  }
});

app.get("/api/admin/reports", (c) => {
  const result = requireAdmin(c, { roles: ["owner", "reviewer"] });
  if (result.response) return result.response;
  const status = String(c.req.query("status") || "").trim() || undefined;
  return c.json({ code: 0, data: store.listReports({ status, limit: boundedInteger(c.req.query("limit"), 200, 1, 1000) }) });
});

app.patch("/api/admin/reports/:reportId", async (c) => {
  const result = requireAdmin(c, { roles: ["owner", "reviewer"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  const updated = store.updateReport(c.req.param("reportId"), { status: body.status, reviewerId: result.session.username, note: body.note });
  return updated ? c.json({ code: 0, data: updated }) : c.json({ code: "INVALID_REPORT_UPDATE", message: "举报不存在或状态无效" }, 400);
});

app.get("/api/admin/moderation", (c) => {
  const result = requireAdmin(c, { roles: ["owner", "reviewer"] });
  if (result.response) return result.response;
  const decision = String(c.req.query("decision") || "").trim() || undefined;
  return c.json({ code: 0, data: store.listModeration({ decision, limit: boundedInteger(c.req.query("limit"), 200, 1, 1000) }) });
});

app.post("/api/admin/moderation/:moderationId/decision", async (c) => {
  const result = requireAdmin(c, { roles: ["owner", "reviewer"], csrf: true });
  if (result.response) return result.response;
  const body = await c.req.json().catch(() => ({}));
  const updated = store.decideModeration(c.req.param("moderationId"), { decision: body.decision, reviewerId: result.session.username, reason: String(body.reason || "").slice(0, 500) });
  return updated ? c.json({ code: 0, data: updated }) : c.json({ code: "INVALID_MODERATION_DECISION", message: "审核记录不存在或处置无效" }, 400);
});

app.get("/api/admin/audits", (c) => {
  const result = requireAdmin(c, { roles: ["owner", "reviewer", "auditor"] });
  if (result.response) return result.response;
  const limit = boundedInteger(c.req.query("limit"), 200, 1, 1000);
  return c.json({ code: 0, data: { admin: adminStore.audits(limit), business: store.listAudits({ limit }).reverse() } });
});

app.get("/api/admin/readiness", async (c) => {
  const result = requireAdmin(c);
  if (result.response) return result.response;
  return c.json({ code: 0, data: await launchReadiness() });
});

app.get("/api/readiness", async (c) => {
  if (PRODUCTION) {
    const denied = internalOnly(c);
    if (denied) return denied;
  }
  return c.json({ code: 0, data: await launchReadiness() });
});

app.get("/api/public/compliance", (c) => {
  const { blockers: _blockers, ...publicData } = publicComplianceConfig();
  return c.json({ code: 0, data: publicData });
});

app.get("/api/capabilities", (c) => c.json({
  code: 0,
  accountOnly: APP_ACCOUNT_ONLY,
  data: capabilityRegistry({
    videoTemplates: readyVideoTemplates.length,
    photoTemplates: Object.values(PHOTO_TEMPLATES).filter((v) => v.imageTemplateId || v.imgUrl).length,
  }).map(item => APP_ACCOUNT_ONLY ? { ...item, ready: false } : item),
}));

/* ================= 聚合 AI 功能（2026-08-03 新增） =================
 * 1. POST /api/photo/restore  老照片修复（人脸增强 + 可选上色）—— 阿里 viapi
 * 2. POST /api/photo/fusion   照片换脸（模板合照）—— 阿里 viapi
 * 3. POST /api/photo/idphoto  证件照（抠图 + 换底/尺寸/排版）—— 阿里 viapi + 本地合成
 * 4. POST /api/photo/age      减龄/变老 —— 腾讯 ft（阿里检测人脸框）
 * 5. POST /api/video/matting  视频抠像换背景（异步）—— 阿里 videoseg + 本地合成
 * 所有供应商返回的临时 URL 一律转存私有对象存储后返回短时签名链接。 */

// 功能清单（前端首页菜单用）
app.get("/api/features", (c) => c.json({
  code: 0,
  data: [
    { key: "video-fusion", name: "视频换脸", ready: readyVideoTemplates.length > 0, templates: readyVideoTemplates.map(([id, value]) => ({ id, name: value.name })) },
    { key: "photo-restore", name: "老照片修复", ready: true },
    { key: "photo-fusion", name: "照片换脸", ready: Object.values(PHOTO_TEMPLATES).some((v) => v.imageTemplateId || v.imgUrl), templates: Object.entries(PHOTO_TEMPLATES).filter(([, v]) => v.imageTemplateId || v.imgUrl).map(([k, v]) => ({ id: k, name: v.name, imgUrl: v.imgUrl || null })) },
    { key: "idphoto", name: "证件照", ready: true, bgs: ["white", "red", "blue"], sizes: ["1寸", "2寸", "小2寸"] },
    { key: "photo-age", name: "减龄/变老", ready: true },
    { key: "photo-effects", name: "一键照片效果", ready: seededit.available() || qwenImage.available() || wanx.available(), count: listPhotoEffects().length },
    { key: "photo-anime", name: "艺术画像", ready: true, styles: Object.entries(ANIME_STYLES).map(([id, value]) => ({ id, name: value.name })) },
    { key: "photo-bg", name: "旅行换景", ready: true, bgs: Object.entries(PHOTO_BGS).map(([id, value]) => ({ id, name: value.name })) },
    { key: "video-matting", name: "视频抠像换背景", ready: true, bgs: Object.entries(MATTING_BGS).filter(([, v]) => v.bgUrl).map(([k, v]) => ({ id: k, name: v.name })) },
  ].map(item => APP_ACCOUNT_ONLY ? { ...item, ready: false } : item),
}));

/* ================= 内容安全、申诉与紧急下架 ================= */
app.post("/api/moderation/check", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  if (contentSafetyConfig().mode !== "local_rules") return c.json({ code: "CONTENT_SAFETY_NOT_CONFIGURED", message: "外部内容安全供应商尚未完成能力接入" }, 503);
  const body = await c.req.json().catch(() => ({}));
  const direction = ["input", "output"].includes(body.direction) ? body.direction : "input";
  let assetId = body.assetId ? String(body.assetId) : null;
  if (body.objectReference) {
    const object = requireInputObject(c, body.objectReference, result.auth.userId);
    if (object.error) return object.error;
    assetId = object.id;
  } else if (assetId) {
    const object = requireInputObject(c, assetId, result.auth.userId);
    if (object.error) return object.error;
    assetId = object.id;
  }
  const moderation = moderationFor(c, result.auth.userId, {
    text: String(body.text || "").slice(0, 4000),
    metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
    direction,
    assetId,
    taskId: body.taskId ? String(body.taskId) : undefined,
  });
  return c.json({ code: 0, data: moderation });
});

app.get("/api/moderation/:moderationId", (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  const item = store.getModeration(c.req.param("moderationId"));
  if (!item) return c.json({ code: "NOT_FOUND", message: "审核记录不存在" }, 404);
  if (item.userId !== result.auth.userId) return c.json({ code: "FORBIDDEN", message: "无权查看该审核记录" }, 403);
  return c.json({ code: 0, data: item });
});

app.post("/api/moderation/:moderationId/appeal", async (c) => {
  const result = authenticated(c);
  if (result.response) return result.response;
  const item = store.getModeration(c.req.param("moderationId"));
  if (!item) return c.json({ code: "NOT_FOUND", message: "审核记录不存在" }, 404);
  if (item.userId !== result.auth.userId) return c.json({ code: "FORBIDDEN", message: "无权申诉该审核记录" }, 403);
  const body = await c.req.json().catch(() => ({}));
  store.recordAudit({ userId: result.auth.userId, action: "moderation.appeal_submitted", resourceType: "moderation", resourceId: item.id, details: { reason: String(body.reason || "").slice(0, 500) } });
  return c.json({ code: 0, data: { moderationId: item.id, status: "queued_for_manual_review" } }, 202);
});

app.post("/api/internal/moderation/:moderationId/decision", async (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const item = store.getModeration(c.req.param("moderationId"));
  if (!item) return c.json({ code: "NOT_FOUND", message: "审核记录不存在" }, 404);
  const updated = store.decideModeration(item.id, { decision: body.decision, reviewerId: String(body.reviewerId || "internal"), reason: String(body.reason || "").slice(0, 500) });
  return c.json({ code: 0, data: updated });
});

app.post("/api/internal/takedown", async (c) => {
  const denied = internalOnly(c);
  if (denied) return denied;
  const body = await c.req.json().catch(() => ({}));
  const assetId = String(body.assetId || "");
  if (!assetId) return c.json({ code: "INVALID_ASSET", message: "缺少作品 ID" }, 400);
  try {
    const deleted = await objectStore.delete(assetId, { reason: "emergency_takedown" });
    store.recordAudit({ action: "asset.emergency_takedown", resourceType: "object", resourceId: assetId, details: { reason: String(body.reason || "").slice(0, 500), deleted } });
    return c.json({ code: 0, data: deleted });
  } catch (error) {
    alertMetric("takedown.failed", { assetId, error: safeError(error) });
    return c.json({ code: "TAKEDOWN_FAILED", message: "紧急下架失败" }, 503);
  }
});

/* ---- 一键照片效果：专用能力独立调用；生成式效果使用已验收的新模型。 ---- */
app.post("/api/photo/effect", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":effect", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const { imageUrl, effectId } = await c.req.json().catch(() => ({}));
  const effect = adminStore.executionPhotoEffect(String(effectId || ""));
  if (!imageUrl || !effect) return c.json({ code: 400, message: "请选择有效的照片效果" }, 400);
  if (!adminStore.publicCatalog().photoEffects.some((item) => item.id === effect.id && item.enabled)) {
    return c.json({ code: "EFFECT_DISABLED", message: "该图片效果已暂停使用" }, 404);
  }
  const prepared = await prepareGeneration(c, { inputUrl: imageUrl, purpose: `photo-effect:${effect.id}`, text: effect.prompt || "", metadata: { effectId: effect.id } });
  if (prepared.response) return prepared.response;

  try {
    let tmpUrl;
    let usedProvider;
    let providerMeta = {};

    if (effect.type === "age") {
      const rect = await viapi.detectFaceRect(prepared.inputUrl);
      if (!rect) {
        await refundPrepared(prepared, "face_not_detected");
        return c.json({ code: 400, message: "未检测到人脸，请换一张正脸清晰照片" }, 400);
      }
      tmpUrl = await changeAgePic({ imageUrl: prepared.inputUrl, age: effect.age, faceRect: rect });
      usedProvider = "tencent-ft";
    } else if (effect.type === "enhance") {
      tmpUrl = await viapi.enhanceFace(prepared.inputUrl);
      usedProvider = "aliyun-viapi";
    } else if (effect.type === "colorize") {
      tmpUrl = await viapi.colorizeImage(prepared.inputUrl);
      usedProvider = "aliyun-viapi";
    } else if (effect.type === "wanx") {
      let result;
      if (wanx.available()) {
        result = await wanx.editImage({
          imageUrl: prepared.inputUrl,
          prompt: effect.prompt,
          functionName: effect.functionName,
        });
        tmpUrl = result.url;
        usedProvider = "aliyun-wanx2.1";
        providerMeta = { taskId: result.taskId, requestId: result.requestId, usage: result.usage };
      } else {
        await refundPrepared(prepared, "provider_not_configured");
        return c.json({ code: 503, message: "高清放大服务尚未配置" }, 503);
      }
    } else if (effect.type === "generative") {
      let seedError;
      if (seededit.available()) {
        try {
          tmpUrl = await seededit.editImage({ imageUrl: prepared.inputUrl, prompt: effect.prompt });
          usedProvider = "volc-seedream-4.0";
        } catch (error) {
          seedError = error;
          logSecurity("warn", "photo_effect.primary_failed_using_fallback", { effectId: effect.id, error: safeError(error) });
        }
      }
    if (!tmpUrl && qwenImage.available()) {
        const result = await qwenImage.editImage({ imageUrl: prepared.inputUrl, prompt: effect.prompt });
        tmpUrl = result.url;
        usedProvider = `aliyun-${result.model}`;
        providerMeta = { requestId: result.requestId, usage: result.usage };
      }
    if (!tmpUrl) {
        if (seedError) throw seedError;
        await refundPrepared(prepared, "provider_not_configured");
      return c.json({ code: 503, message: "AI 图片编辑服务尚未配置" }, 503);
    }
    } else {
      await refundPrepared(prepared, "effect_not_supported");
      return c.json({ code: 400, message: "这个照片效果已停止使用" }, 400);
    }

    const out = await persistGenerationOutput(c, {
      tmpUrl,
      ownerId: prepared.userId,
      billingRef: prepared.billingRef,
      purpose: `output/photo-effect/${effect.id}`,
      kind: "image",
      provider: usedProvider,
      model: providerMeta.model || null,
      base: requestBase(c),
    });
    return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, effectId: effect.id, provider: usedProvider, metadata: out.metadata, ...providerMeta } });
  } catch (error) {
    await refundPrepared(prepared, "generation_failed");
    logSecurity("error", "photo_effect.generate_failed", { effectId: effect.id, requestId: requestId(c), error: safeError(error) });
    const message = String(error?.message || "");
    if (message.includes("not authorized") || message.includes("AuthFailure") || message.includes("未配置")) {
      return c.json({ code: 503, message: "该效果正在开通中，请稍后再试" }, 503);
    }
    return c.json({ code: 500, message: "照片生成服务繁忙，请稍后再试" }, 500);
  }
});

/* ---- 1. 老照片修复 ---- */
app.post("/api/photo/restore", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":feat", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const { imageUrl, colorize } = await c.req.json().catch(() => ({}));
  if (!imageUrl) return c.json({ code: 400, message: "参数错误" }, 400);
  const prepared = await prepareGeneration(c, { inputUrl: imageUrl, purpose: "photo-restore", metadata: { colorize: Boolean(colorize) } });
  if (prepared.response) return prepared.response;
  let failureStage = "provider_enhance_face";
  try {
    let url = await viapi.enhanceFace(prepared.inputUrl);
    if (!url) {
      const error = new Error("Aliyun EnhanceFace returned no image URL");
      error.code = "ALIYUN_RESULT_IMAGE_URL_MISSING";
      throw error;
    }
    if (colorize) {
      failureStage = "provider_colorize_image";
      url = await viapi.colorizeImage(url); // 先增强后上色，串行管线
    }
    failureStage = "persist_and_mark_output";
    const out = await persistGenerationOutput(c, {
      tmpUrl: url,
      ownerId: prepared.userId,
      billingRef: prepared.billingRef,
      purpose: "output/photo-restore",
      kind: "image",
      provider: "aliyun-viapi",
      model: colorize ? "EnhanceFace+ColorizeImage" : "EnhanceFace",
      base: requestBase(c),
    });
    return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, metadata: out.metadata } });
  } catch (e) {
    await refundPrepared(prepared, "generation_failed");
    logSecurity("error", "photo_restore.failed", { requestId: requestId(c), error: safeError(e) });
    const error = safeError(e);
    return c.json({
      code: 500,
      message: "修复服务繁忙，请稍后再试",
      ...(!PRODUCTION ? {
        diagnostic: {
          requestId: requestId(c),
          failureStage,
          errorCode: error.code,
          status: error.status,
        },
      } : {}),
    }, 500);
  }
});

/* ---- 2. 照片换脸（模板合照）---- */
app.post("/api/photo/fusion", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":feat", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const { templateId, userPhotoUrl } = await c.req.json().catch(() => ({}));
  const tpl = PHOTO_TEMPLATES[templateId];
  if ((!tpl?.imageTemplateId && !(PHOTO_PROVIDER === "bailian" && tpl?.imgUrl)) || !userPhotoUrl) {
    return c.json({ code: 400, message: "参数错误" }, 400);
  }
  if (!licensedTemplate(templateId)) return c.json({ code: 503, message: "该模板尚未完成授权登记" }, 503);
  const prepared = await prepareGeneration(c, { inputUrl: userPhotoUrl, purpose: "photo-fusion", metadata: { templateId } });
  if (prepared.response) return prepared.response;
  try {
    // 百炼为生成式照片换脸；模板地址来自已登记的公司模板清单。
    if (PHOTO_PROVIDER === "bailian" && bailian.available() && tpl.imgUrl) {
      const result = await bailian.faceSwap({ userPhoto: prepared.inputUrl, template: tpl.imgUrl });
      const out = await persistGenerationOutput(c, {
        tmpUrl: result.url,
        ownerId: prepared.userId,
        billingRef: prepared.billingRef,
        purpose: "output/photo-fusion",
        kind: "image",
        provider: "bailian",
        model: result.model || null,
        base: requestBase(c),
      });
      return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, provider: "bailian", requestId: result.requestId, usage: result.usage, metadata: out.metadata } });
    }
    const url = await viapi.mergeImageFace({ templateId: tpl.imageTemplateId, imageUrl: prepared.inputUrl });
    const out = await persistGenerationOutput(c, {
      tmpUrl: url,
      ownerId: prepared.userId,
      billingRef: prepared.billingRef,
      purpose: "output/photo-fusion",
      kind: "image",
      provider: "aliyun-viapi",
      model: "MergeImageFace",
      base: requestBase(c),
    });
    return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, metadata: out.metadata } });
  } catch (e) {
    await refundPrepared(prepared, "generation_failed");
    logSecurity("error", "photo_fusion.failed", { requestId: requestId(c), error: safeError(e) });
    return c.json({ code: 500, message: "生成服务繁忙，请稍后再试" }, 500);
  }
});

/* ---- 3. 证件照（换底/尺寸/排版）---- */
app.post("/api/photo/idphoto", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":feat", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const { imageUrl, bg = "white", size = "1寸", layout6 = false } = await c.req.json().catch(() => ({}));
  if (!imageUrl || !["white", "red", "blue"].includes(bg) || !["1寸", "2寸", "小2寸"].includes(size)) {
    return c.json({ code: 400, message: "参数错误" }, 400);
  }
  const prepared = await prepareGeneration(c, { inputUrl: imageUrl, purpose: "idphoto", metadata: { background: bg, size, layout6: Boolean(layout6) } });
  if (prepared.response) return prepared.response;
  let alphaPath;
  let outPath;
  try {
    // 抠图 → 下载 alpha PNG → 本地合成 → 上传
    const alphaTmp = await viapi.segmentHDBody(prepared.inputUrl);
    const id = crypto.randomUUID();
    alphaPath = await fetchToLocal(alphaTmp, `idphoto-alpha-${id}.png`);
    outPath = path.join(WORK_DIR, `idphoto-${id}.jpg`);
    const args = ["idphoto-compose.py", alphaPath, outPath, "--bg", bg, "--size", size];
    if (layout6) args.push("--layout6");
    await run(process.env.PYTHON_PATH || "python", args, { cwd: __dirname });
    const out = await persistLocalGenerationOutput(c, outPath, {
      ownerId: prepared.userId,
      billingRef: prepared.billingRef,
      purpose: "output/idphoto",
      kind: "image",
      provider: "aliyun-viapi+local",
      model: "SegmentHDBody+idphoto-compose",
      taskId: null,
      base: requestBase(c),
    });
    return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, metadata: out.metadata } });
  } catch (e) {
    await refundPrepared(prepared, "generation_failed");
    logSecurity("error", "idphoto.failed", { requestId: requestId(c), error: safeError(e) });
    return c.json({ code: 500, message: "生成服务繁忙，请稍后再试" }, 500);
  } finally {
    if (alphaPath) fs.rmSync(alphaPath, { force: true });
    if (outPath) fs.rmSync(outPath, { force: true });
  }
});

/* ---- 4. 减龄/变老 ---- */
app.post("/api/photo/age", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":feat", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const { imageUrl, age } = await c.req.json().catch(() => ({}));
  const ageNum = Number(age);
  if (!imageUrl || !Number.isInteger(ageNum) || ageNum < 1 || ageNum > 120) {
    return c.json({ code: 400, message: "参数错误（age 须为 1-120 的整数）" }, 400);
  }
  const prepared = await prepareGeneration(c, { inputUrl: imageUrl, purpose: "photo-age", metadata: { targetAge: ageNum } });
  if (prepared.response) return prepared.response;
  try {
    const rect = await viapi.detectFaceRect(prepared.inputUrl);
    if (!rect) {
      await refundPrepared(prepared, "face_not_detected");
      return c.json({ code: 400, message: "未检测到人脸，请换一张正脸清晰照片" }, 400);
    }
    const url = await changeAgePic({ imageUrl: prepared.inputUrl, age: ageNum, faceRect: rect });
    const out = await persistGenerationOutput(c, {
      tmpUrl: url,
      ownerId: prepared.userId,
      billingRef: prepared.billingRef,
      purpose: "output/photo-age",
      kind: "image",
      provider: "tencent-ft",
      model: "ChangeAgePic",
      base: requestBase(c),
    });
    return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, metadata: out.metadata } });
  } catch (e) {
    await refundPrepared(prepared, "generation_failed");
    logSecurity("error", "photo_age.failed", { requestId: requestId(c), error: safeError(e) });
    const msg = String(e?.message || "");
    if (msg.includes("开通") || msg.includes("计费") || msg.includes("AuthFailure")) {
      return c.json({ code: 503, message: "年龄变换服务开通中，请稍后再试" }, 503);
    }
    return c.json({ code: 500, message: "生成服务繁忙，请稍后再试" }, 500);
  }
});

/* ---- 4b. 人物动漫化 / 素描 ---- */
/* ---- 4b. 漫画脸 / 风格重绘（优先方舟生成式，未配置则回退老接口） ---- */
const ANIME_STYLES = {
  anime:      { name: "日系动漫", prompt: "把这张照片变成精美的日系动漫风格插画，保持人物的五官特征、发型和姿势不变，肤色自然通透，画质细腻，动漫海报质感" },
  comic:      { name: "漫画风格", prompt: "把这张照片转化为精致现代漫画风格，严格保留人物身份、五官、脸型、肤色、发型和姿势，使用清晰自然的线条、克制高级的配色和电影感光影，保持成年人的真实年龄与成熟气质，不要儿童化，不要夸张大眼，不添加文字" },
  cartoon3d:  { name: "3D 卡通",  prompt: "把这张照片变成 3D 卡通动画风格（类似皮克斯动画电影质感），保持人物五官特征和姿势不变，材质细腻，光影柔和" },
  watercolor: { name: "水彩画",   prompt: "把这张照片变成清新水彩画风格，保持人物五官特征和姿势不变，色彩通透，笔触自然，像画师手绘的作品" },
  sketch:     { name: "素描画像", prompt: "把这张照片变成铅笔素描画像，保持人物五官特征和姿势不变，线条细腻有明暗层次，像专业画家的速写作品" },
  portrait:   { name: "AI头像",    prompt: "把这张照片制作成高级自然的个人头像和专业棚拍肖像，严格保留人物身份、五官、脸型、肤色、发型和真实年龄，采用干净中性背景、柔和专业布光和头肩构图，保留真实皮肤纹理，不过度磨皮，不添加文字" },
};

app.post("/api/photo/anime", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":feat", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const { imageUrl, style = "anime" } = await c.req.json().catch(() => ({}));
  const st = ANIME_STYLES[style];
  if (!imageUrl || !st) return c.json({ code: 400, message: "参数错误" }, 400);
  const prepared = await prepareGeneration(c, { inputUrl: imageUrl, purpose: `photo-anime:${style}`, text: st.prompt, metadata: { style } });
  if (prepared.response) return prepared.response;
  try {
    if (seededit.available()) {
      const tmp = await seededit.editImage({ imageUrl: prepared.inputUrl, prompt: st.prompt });
      const out = await persistGenerationOutput(c, {
        tmpUrl: tmp,
        ownerId: prepared.userId,
        billingRef: prepared.billingRef,
        purpose: "output/photo-anime",
        kind: "image",
        provider: "volc-seedream-4.0",
        model: "Seedream",
        base: requestBase(c),
      });
      return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, metadata: out.metadata } });
    }
    // 回退：老接口仅支持 anime / sketch
    if (style !== "anime" && style !== "sketch") {
      await refundPrepared(prepared, "style_not_supported");
      return c.json({ code: 503, message: "该风格正在升级中，请先试试日系动漫" }, 503);
    }
    const url = style === "anime" ? await viapi.generateAnime(prepared.inputUrl) : await viapi.generateSketch(prepared.inputUrl);
    const out = await persistGenerationOutput(c, {
      tmpUrl: url,
      ownerId: prepared.userId,
      billingRef: prepared.billingRef,
      purpose: "output/photo-anime",
      kind: "image",
      provider: "aliyun-viapi",
      model: style === "anime" ? "GenerateHumanAnimeStyle" : "GenerateHumanSketchStyle",
      base: requestBase(c),
    });
    return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, metadata: out.metadata } });
  } catch (e) {
    await refundPrepared(prepared, "generation_failed");
    logSecurity("error", "photo_anime.failed", { requestId: requestId(c), error: safeError(e) });
    const msg = String(e?.message || "");
    if (msg.includes("开通") || msg.includes("AuthFailure") || msg.includes("not authorized")) {
      return c.json({ code: 503, message: "该功能开通中，请稍后再试" }, 503);
    }
    return c.json({ code: 500, message: "生成服务繁忙，请稍后再试" }, 500);
  }
});

/* ---- 4c. 照片换背景（优先方舟生成式重绘：人物光影自然融入场景；未配置则回退抠图合成） ---- */
const PHOTO_BGS = {
  greatwall: { name: "万里长城", file: "assets/bg-greatwall.jpg",
    prompt: "把照片的背景替换成万里长城的实景，保持人物完全不变，人物边缘自然，光线、色调与长城场景协调融合，像实地拍摄的纪念照" },
  westlake:  { name: "西湖美景", file: "assets/bg-westlake.jpg",
    prompt: "把照片的背景替换成杭州西湖的实景（湖水、垂柳、远山、游船），保持人物完全不变，光线自然融合，像实地拍摄的纪念照" },
  beach:     { name: "三亚海滩", file: "assets/bg-beach.jpg",
    prompt: "把照片的背景替换成三亚海滩的实景（蓝天、白云、沙滩、椰子树），保持人物完全不变，光线自然融合，像实地拍摄的纪念照" },
};

app.post("/api/photo/photobg", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":feat", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const { imageUrl, bgId, customPrompt } = await c.req.json().catch(() => ({}));
  const bg = PHOTO_BGS[bgId];
  if (!imageUrl || (!bg && bgId !== "custom")) return c.json({ code: 400, message: "参数错误" }, 400);
  const customText = String(customPrompt || "").replace(/[\\"']/g, "").trim().slice(0, 60);
  if (bgId === "custom" && !customText) return c.json({ code: 400, message: "请先描述想去的地方" }, 400);
  const prepared = await prepareGeneration(c, { inputUrl: imageUrl, purpose: `photo-bg:${bgId}`, text: customText, metadata: { backgroundId: bgId } });
  if (prepared.response) return prepared.response;
  let alphaPath;
  let outPath;
  try {
    if (seededit.available()) {
      let prompt;
      if (bgId === "custom") {
        prompt = `把照片的背景替换成「${customText}」的实景，保持人物完全不变，人物边缘自然，光线、色调与新场景协调融合，像实地拍摄的纪念照`;
      } else {
        prompt = bg.prompt;
      }
      const tmp = await seededit.editImage({ imageUrl: prepared.inputUrl, prompt });
      const out = await persistGenerationOutput(c, {
        tmpUrl: tmp,
        ownerId: prepared.userId,
        billingRef: prepared.billingRef,
        purpose: "output/photo-bg",
        kind: "image",
        provider: "volc-seedream-4.0",
        model: "Seedream",
        base: requestBase(c),
      });
      return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, metadata: out.metadata } });
    }
    if (bgId === "custom") {
      await refundPrepared(prepared, "provider_not_configured");
      return c.json({ code: 503, message: "自定义场景正在升级中，请先选下方景点" }, 503);
    }
    // 回退：抠人像 + 本地合成
    const alphaTmp = await viapi.segmentHDBody(prepared.inputUrl);
    const id = crypto.randomUUID();
    alphaPath = await fetchToLocal(alphaTmp, `photobg-alpha-${id}.png`);
    outPath = path.join(WORK_DIR, `photobg-${id}.jpg`);
    await run(process.env.PYTHON_PATH || "python", ["photo-bg-compose.py", alphaPath, path.join(__dirname, bg.file), outPath], { cwd: __dirname });
    const out = await persistLocalGenerationOutput(c, outPath, {
      ownerId: prepared.userId,
      billingRef: prepared.billingRef,
      purpose: "output/photo-bg",
      kind: "image",
      provider: "aliyun-viapi+local",
      model: "SegmentHDBody+photo-bg-compose",
      base: requestBase(c),
    });
    return c.json({ code: 0, data: { url: out.url, assetId: out.assetId, metadata: out.metadata } });
  } catch (e) {
    await refundPrepared(prepared, "generation_failed");
    logSecurity("error", "photo_background.failed", { requestId: requestId(c), error: safeError(e) });
    return c.json({ code: 500, message: "生成服务繁忙，请稍后再试" }, 500);
  } finally {
    if (alphaPath) fs.rmSync(alphaPath, { force: true });
    if (outPath) fs.rmSync(outPath, { force: true });
  }
});

/* ---- 6. LLM 对话（发现页各玩法共用；优先 DeepSeek，未配置则尝试混元） ---- */
import * as hunyuan from "./providers/hunyuan.js";
import * as deepseek from "./providers/deepseek.js";
const llm = LLM_PROVIDER === "hunyuan" ? hunyuan : deepseek;
const LLM_SCENES = {
  blessing:  "你是一位深受中老年用户喜爱的祝福语写作助手。用户会告诉你节日或场合（如春节、生日、寿宴、重阳节、搬家、添孙等），你要写出3条不同风格的祝福语：一条传统喜庆、一条温馨感人、一条幽默轻松。每条50-100字，用词吉祥得体，适合发到家族微信群。",
  moments:   "你是一位朋友圈文案高手，专门为中老年用户写朋友圈配文。根据用户描述的照片内容或心情，写3条文案：一条诗意、一条接地气、一条带热门话题感。每条不超过80字，可适当用 emoji。",
  share_caption: "你是乐颜秀的成片分享文案助手。用户会提供作品类型、希望的文案感觉和作品内容。严格只输出四部分且不要增加候选版本：1. 朋友圈版一条，自然真诚；2. 视频号版一条，简洁有画面感；3. 亲友群版一条，亲切不营销；4. 三个简短话题标签。每条不超过70字，最多使用2个恰当的emoji，不写夸张流量话术，不虚构人物地点，不出现AI换脸字样。",
  health:    "你是一位亲切的养生顾问，用通俗易懂的语言为中老年朋友解答健康养生问题，包括饮食、运动、作息、常见慢性病的日常调理。回答实用具体，分点列出，最后提醒『具体诊疗请遵医嘱』。不推荐任何药品和保健品。",
  recipe:    "你是一位家常菜大厨。用户告诉你想吃的菜或手上的食材，你给出详细做法：用料用量、步骤分点、关键技巧。语言亲切，像跟邻居聊天。优先推荐适合中老年人口味和健康的做法。",
  travel:    "你是一位贴心的旅游规划师，专门为中老年人规划旅行。给出行程节奏舒缓、交通便利、适合拍照的景点建议，注明注意事项（如台阶多不多、厕所是否方便、最佳游览时间）。",
  naming:    "你是一位起名大师，精通诗词典籍和姓名文化。用户会说明给谁起名（如孙子孙女、宠物、微信群、店铺）以及姓氏或偏好，你给出5个名字，每个附上出处和寓意解释。",
  couplet:   "你是一位对联创作高手。根据用户给的场合（春节、寿宴、乔迁、开业等）创作3副对联，上联下联对仗工整，附横批，并简单解释含义。",
  dream:     "你是一位温和的解梦助手，结合民俗文化和心理学常识，用轻松正面的方式为用户解读梦境。只作娱乐参考，末尾提醒不必当真、保持好心情最重要。",
  poem:      "你是一位诗词爱好者，既会赏析经典诗词，也会按用户需求创作通俗易懂的格律诗、打油诗。用户给出主题后，创作一首并逐句解释。",
  life:      "你是一位生活妙招达人，分享厨房清洁、衣物护理、省钱窍门、手机使用技巧等实用小知识。回答分点、具体、马上能用。",
  chat:      "你是一位温暖耐心的聊天伙伴，陪中老年用户唠家常。语言亲切接地气，多倾听多回应，适当讲些有趣的小事逗用户开心。",
  future_wife: "你是一位轻松有趣的缘分名字测试助手。根据用户提供的姓名、生日和自我描述，生成3个『未来老婆名字彩蛋』，每个包含名字、缘分关键词、可能相遇的生活场景和一句温暖建议。必须明确这是基于文字联想的娱乐测试，不能声称能真实预测婚姻或具体个人。语气浪漫但不油腻，不制造焦虑。",
  wealth: "你是一位娱乐向财运测试助手。根据用户信息给出今日财运氛围、容易遇到的机会、需要留意的消费习惯和一个可执行的存钱小建议。不要推荐股票、基金、彩票、虚拟货币或任何具体投资，不承诺发财，不诱导消费。结尾明确『仅供娱乐，不构成投资建议』。",
  wuxing: "你是一位传统文化五行解读助手。服务端会提供由历法库计算的公历、农历、八字、五行和纳音数据。只能基于这些数据做通俗解释，不得篡改计算结果。说明五行出现次数只是一种民俗观察，不能直接等同于命运好坏。输出五行概览、性格联想、生活配色/环境建议和一句提醒，并明确仅供传统文化娱乐参考。",
  daily_fortune: "你是一位今日运势娱乐解读助手。服务端会提供当天的农历、宜、忌和财神方位。结合用户描述，给出今日关键词、事业/家庭/心情三个维度、一个宜做的小事和一个避坑提醒。不要作医疗、法律、投资或灾祸预测，不使用恐吓语气，明确仅供娱乐。",
  character_fortune: "你是一位传统测字文化解读助手。用户会输入一个汉字。请从字形结构、字义联想和积极心理暗示三个角度展开，给出事业、人缘、心境三个小结和一句行动建议。不得声称能预测灾祸、寿命或确定未来，明确这是汉字文化娱乐解读。",
};

const PLAY_SCENES = new Set(Object.keys(LLM_SCENES));

function parseSolarDate(dateText, timeText = "12:00") {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateText || ""));
  const tm = /^(\d{2}):(\d{2})$/.exec(String(timeText || "12:00"));
  if (!dm || !tm) throw new Error("日期或时间格式不正确");
  const [year, month, day, hour, minute] = [dm[1], dm[2], dm[3], tm[1], tm[2]].map(Number);
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) {
    throw new Error("日期或时间超出可计算范围");
  }
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error("请输入有效日期");
  }
  return Solar.fromYmdHms(year, month, day, hour, minute, 0).getLunar();
}

function shanghaiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function buildPlayFacts(scene, profile = {}) {
  if (scene !== "wuxing" && scene !== "daily_fortune") return null;
  const date = scene === "daily_fortune" ? (profile.date || shanghaiToday()) : profile.birthDate;
  if (!date) throw new Error("请填写出生日期");
  const lunar = parseSolarDate(date, scene === "wuxing" ? profile.birthTime : "12:00");
  const common = {
    solarDate: date,
    lunarDate: lunar.toString(),
    zodiac: lunar.getYearShengXiao(),
  };
  if (scene === "daily_fortune") {
    return {
      ...common,
      yi: lunar.getDayYi().slice(0, 8),
      ji: lunar.getDayJi().slice(0, 8),
      wealthDirection: lunar.getPositionCaiDesc(),
    };
  }
  return {
    ...common,
    birthTime: profile.birthTime || "12:00",
    bazi: lunar.getBaZi(),
    wuxing: lunar.getBaZiWuXing(),
    nayin: lunar.getBaZiNaYin(),
  };
}

app.post("/api/llm/chat", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":llm", 30)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const authResult = authenticated(c);
  if (authResult.response) return authResult.response;
  const { scene, messages } = await c.req.json().catch(() => ({}));
  const sys = LLM_SCENES[scene];
  if (!sys || !Array.isArray(messages) || !messages.length) return c.json({ code: 400, message: "参数错误" }, 400);
  const history = messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && m.content).slice(-10);
  const moderation = moderationFor(c, authResult.auth.userId, { text: history.map((m) => m.content).join("\n"), direction: "input", metadata: { scene } });
  if (moderation.decision !== "allow") return c.json({ code: "CONTENT_BLOCKED", message: "输入内容未通过内容安全检查", moderationId: moderation.record.id }, 422);
  const budget = await recordNonGenerationProviderCall(c, authResult.auth.userId, "llm-chat");
  if (budget.error) return budget.error;
  await flushComplianceStore();
  try {
    const reply = await llm.chat([{ role: "system", content: sys }, ...history]);
    return c.json({ code: 0, data: { reply } });
  } catch (e) {
    logSecurity("error", "llm.chat_failed", { requestId: requestId(c), error: safeError(e) });
    return c.json({ code: 500, message: "AI 助手繁忙，请稍后再试" }, 500);
  }
});

app.post("/api/play/analyze", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":play", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const authResult = authenticated(c);
  if (authResult.response) return authResult.response;
  const body = await c.req.json().catch(() => ({}));
  const scene = String(body.scene || "");
  const input = String(body.input || "").trim().slice(0, 1200);
  const profile = body.profile && typeof body.profile === "object" ? body.profile : {};
  const hasProfile = Object.values(profile).some((value) => String(value || "").trim());
  if (!PLAY_SCENES.has(scene) || (!input && !hasProfile && scene !== "daily_fortune")) {
    return c.json({ code: 400, message: "请补充测试信息" }, 400);
  }
  const moderation = moderationFor(c, authResult.auth.userId, { text: input, direction: "input", metadata: { scene, profile } });
  if (moderation.decision !== "allow") return c.json({ code: "CONTENT_BLOCKED", message: "输入内容未通过内容安全检查", moderationId: moderation.record.id }, 422);
  let facts = null;
  try {
    facts = buildPlayFacts(scene, profile);
  } catch (error) {
    return c.json({ code: 400, message: error.message || "资料格式不正确" }, 400);
  }

  const budget = await recordNonGenerationProviderCall(c, authResult.auth.userId, "play-analyze");
  if (budget.error) return budget.error;
  await flushComplianceStore();

  const userContent = [
    profile.name ? `用户称呼：${String(profile.name).slice(0, 30)}` : "",
    profile.birthDate ? `出生日期：${String(profile.birthDate).slice(0, 10)}` : "",
    profile.birthTime ? `出生时间：${String(profile.birthTime).slice(0, 5)}` : "",
    input ? `用户补充：${input}` : "用户没有补充描述",
    facts ? `历法库计算结果（不得修改）：${JSON.stringify(facts)}` : "",
  ].filter(Boolean).join("\n");

  try {
    const reply = await llm.chat([
      { role: "system", content: LLM_SCENES[scene] },
      { role: "user", content: userContent },
    ]);
    return c.json({ code: 0, data: { reply, facts, provider: LLM_PROVIDER } });
  } catch (error) {
    logSecurity("error", "play.analyze_failed", { requestId: requestId(c), error: safeError(error) });
    return c.json({ code: 500, message: "玩法服务繁忙，请稍后再试" }, 500);
  }
});

/* ---- 5. 视频抠像换背景（异步）---- */
const mattings = new Map(); // taskId → Promise<{videoUrl}>

app.post("/api/video/matting", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":feat", 20)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const { videoUrl, bgId, bgUrl: customBg } = await c.req.json().catch(() => ({}));
  if (!videoUrl || (!bgId && !customBg)) return c.json({ code: 400, message: "参数错误" }, 400);
  const prepared = await prepareGeneration(c, { inputUrl: videoUrl, purpose: "video-matting", metadata: { backgroundId: bgId || "custom" } });
  if (prepared.response) return prepared.response;
  let bgUrl = MATTING_BGS[bgId]?.bgUrl;
  let bgObjectId = null;
  if (customBg) {
    const background = requireInputObject(c, customBg, prepared.userId);
    if (background.error) {
      await refundPrepared(prepared, "background_not_owned");
      return background.error;
    }
    bgUrl = await objectStore.signedUrl(background.id, { ownerId: prepared.userId, base: requestBase(c) });
    bgObjectId = background.id;
  }
  if (!bgUrl) {
    await refundPrepared(prepared, "background_not_configured");
    return c.json({ code: 400, message: "背景素材尚未配置" }, 400);
  }
  try {
    const { taskId, model } = await viapi.segmentVideoBody(prepared.inputUrl);
    tasks[taskId] = {
      type: "matting",
      ownerId: prepared.userId,
      inputObjectId: prepared.input.id,
      backgroundObjectId: bgObjectId,
      videoUrl: prepared.inputUrl,
      bgUrl,
      billingRef: prepared.billingRef,
      purpose: prepared.purpose,
      provider: "aliyun-viapi",
      model: model || null,
      status: "QUEUED",
      createdAt: Date.now(),
    };
    await saveTask(taskId, tasks[taskId], tasks);
    return c.json({ code: 0, data: { taskId, provider: "aliyun-viapi", model: model || null } });
  } catch (e) {
    await refundPrepared(prepared, "task_create_failed");
    logSecurity("error", "video_matting.create_failed", { requestId: requestId(c), error: safeError(e) });
    return c.json({ code: 500, message: "生成服务繁忙，请稍后再试" }, 500);
  }
});

app.get("/api/video/matting/:taskId", async (c) => {
  const taskId = c.req.param("taskId");
  const authResult = authenticated(c);
  if (authResult.response) return authResult.response;
  const meta = tasks[taskId];
  if (!meta || meta.type !== "matting") return c.json({ code: 404, message: "任务不存在" }, 404);
  if (meta.ownerId !== authResult.auth.userId) return c.json({ code: "FORBIDDEN", message: "无权查询该任务" }, 403);
  if (meta.outputObjectId) {
    const existing = objectStore.get(meta.outputObjectId);
    if (!existing) return c.json({ code: 410, message: "作品已过保存期" }, 410);
    await billingStore.confirmCreation(meta.ownerId, meta.billingRef, meta.purpose || "video-matting");
    return c.json({ code: 0, data: { status: "SUCCESS", assetId: existing.id, videoUrl: await objectStore.signedUrl(existing.id, { ownerId: meta.ownerId, base: requestBase(c) }), composed: true, metadata: existing.metadata } });
  }
  try {
    const r = await viapi.queryMattingTask(taskId);
    if (r.status === "FAILED") {
      await updateTask(taskId, { status: "FAILED", failedAt: Date.now() });
      await refundPrepared({ userId: meta.ownerId, billingRef: meta.billingRef }, "provider_failed");
      return c.json({ code: 0, data: r });
    }
    if (r.status !== "SUCCESS") return c.json({ code: 0, data: r });
    if (!r.videoUrl) throw new Error("供应商未返回抠像结果");
    // 抠像完成 → maskedmerge 合成到新背景
    if (!mattings.has(taskId)) {
      mattings.set(
        taskId,
        composeMatting({ taskId, maskUrl: r.videoUrl, videoUrl: meta.videoUrl, bgUrl: meta.bgUrl, ownerId: meta.ownerId, base: requestBase(c), provider: meta.provider, providerModel: meta.model })
          .catch((e) => {
            logSecurity("error", "video_matting.compose_failed", { taskId, error: safeError(e) });
            throw e;
          })
      );
    }
    const done = await Promise.race([
      mattings.get(taskId).then((v) => ({ v })),
      new Promise((s) => setTimeout(() => s(null), 25_000)),
    ]);
    if (!done) return c.json({ code: 0, data: { status: "RUNNING", composing: true } });
    await updateTask(taskId, { status: "SUCCESS", outputObjectId: done.v.assetId, completedAt: Date.now() });
    await billingStore.confirmCreation(meta.ownerId, meta.billingRef, meta.purpose || "video-matting");
    return c.json({ code: 0, data: { status: "SUCCESS", videoUrl: done.v.url, assetId: done.v.assetId, composed: true, metadata: done.v.metadata } });
  } catch (e) {
    await updateTask(taskId, { status: "FAILED", failedAt: Date.now(), failureCode: safeError(e).code || "GENERATION_FAILED" }).catch((saveError) => {
      logSecurity("error", "video_matting.failure_state_persist_failed", { taskId, error: safeError(saveError) });
    });
    await refundPrepared({ userId: meta.ownerId, billingRef: meta.billingRef }, "generation_failed");
    logSecurity("error", "video_matting.query_failed", { taskId, error: safeError(e) });
    return c.json({ code: 500, message: "查询失败" }, 500);
  }
});

/* ---- 图片输入上传：对象默认私有，后续处理只接受当前用户的对象引用 ---- */
app.post("/api/upload", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":up", 30)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const authResult = authenticated(c);
  if (authResult.response) return authResult.response;
  const consentResponse = requireFaceConsent(c, authResult.auth.userId);
  if (consentResponse) return consentResponse;
  const { image } = await c.req.json().catch(() => ({}));
  let decoded;
  try {
    decoded = decodeImageDataUrl(image);
  } catch (error) {
    const tooLarge = ["MEDIA_TOO_LARGE", "IMAGE_DIMENSIONS_TOO_LARGE"].includes(error?.code);
    return c.json({ code: error?.code || "INVALID_IMAGE", message: tooLarge ? "图片文件或像素尺寸超过限制" : "图片内容无效或与声明类型不一致" }, tooLarge ? 413 : 400);
  }
  if (PRODUCTION && !contentSafetyReadiness().ready) return c.json({ code: "CONTENT_SAFETY_NOT_READY", message: "图片安全审核服务暂不可用" }, 503);
  const mediaDigest = crypto.createHash("sha256").update(decoded.buffer).digest("hex");
  const moderation = moderationFor(c, authResult.auth.userId, { direction: "input", metadata: { contentType: decoded.mime, width: decoded.width, height: decoded.height, mediaDigest } });
  if (moderation.decision !== "allow") return c.json({ code: "CONTENT_REVIEW_REQUIRED", message: "图片需要人工审核后才能使用", moderationId: moderation.record.id }, 422);
  const consent = store.activeConsent(authResult.auth.userId, "face_processing", FACE_CONSENT_VERSION);
  try {
    const asset = await objectStore.putBuffer(decoded.buffer, {
      ownerId: authResult.auth.userId,
      contentType: decoded.mime,
      ext: decoded.ext,
      purpose: "input/face-image",
      metadata: { consentVersion: FACE_CONSENT_VERSION, consentRecordId: consent?.id || null, moderationId: moderation.record.id, mediaDigest, width: decoded.width, height: decoded.height, mediaVerified: true },
      retainSeconds: Number(process.env.INPUT_RETENTION_SECONDS || 86_400),
    });
    const url = await objectStore.signedUrl(asset.id, { ownerId: authResult.auth.userId, base: requestBase(c) });
    return c.json({ code: 0, data: { assetId: asset.id, url, expiresAt: asset.expiresAt, metadata: asset.metadata } });
  } catch (error) {
    logSecurity("error", "upload.image_failed", { requestId: requestId(c), error: safeError(error) });
    return c.json({ code: "UPLOAD_FAILED", message: "图片暂时无法保存" }, 503);
  }
});

app.post("/api/upload/video", async (c) => {
  const ip = clientAddress(c);
  if (!rateLimit(ip + ":video-up", 10)) return c.json({ code: 429, message: "操作太频繁，请稍后再试" }, 429);
  const authResult = authenticated(c);
  if (authResult.response) return authResult.response;
  const consentResponse = requireFaceConsent(c, authResult.auth.userId);
  if (consentResponse) return consentResponse;
  const { video } = await c.req.json().catch(() => ({}));
  let decoded;
  try {
    decoded = decodeVideoDataUrl(video);
  } catch (error) {
    const tooLarge = error?.code === "MEDIA_TOO_LARGE";
    return c.json({ code: error?.code || "INVALID_VIDEO", message: tooLarge ? "视频超过大小限制" : "视频内容无效或与声明类型不一致" }, tooLarge ? 413 : 400);
  }
  if (PRODUCTION && !contentSafetyReadiness().ready) return c.json({ code: "CONTENT_SAFETY_NOT_READY", message: "视频安全审核服务暂不可用" }, 503);
  const mediaDigest = crypto.createHash("sha256").update(decoded.buffer).digest("hex");
  const moderation = moderationFor(c, authResult.auth.userId, { direction: "input", metadata: { contentType: decoded.mime, container: decoded.container, mediaDigest } });
  if (moderation.decision !== "allow") return c.json({ code: "CONTENT_REVIEW_REQUIRED", message: "视频需要人工审核后才能使用", moderationId: moderation.record.id }, 422);
  const consent = store.activeConsent(authResult.auth.userId, "face_processing", FACE_CONSENT_VERSION);
  try {
    const asset = await objectStore.putBuffer(decoded.buffer, {
      ownerId: authResult.auth.userId,
      contentType: decoded.mime,
      ext: decoded.ext,
      purpose: "input/video",
      metadata: { consentVersion: FACE_CONSENT_VERSION, consentRecordId: consent?.id || null, moderationId: moderation.record.id, mediaDigest, container: decoded.container, mediaVerified: true },
      retainSeconds: Number(process.env.INPUT_RETENTION_SECONDS || 86_400),
    });
    const url = await objectStore.signedUrl(asset.id, { ownerId: authResult.auth.userId, base: requestBase(c) });
    return c.json({ code: 0, data: { assetId: asset.id, url, expiresAt: asset.expiresAt, metadata: asset.metadata } });
  } catch (error) {
    logSecurity("error", "upload.video_failed", { requestId: requestId(c), error: safeError(error) });
    return c.json({ code: "UPLOAD_FAILED", message: "视频暂时无法保存" }, 503);
  }
});

/* ---- 网页版测试页：有 React 构建产物时优先使用。 ---- */
const pagePath = fs.existsSync(path.join(__dirname, "web", "index.html"))
  ? path.join(__dirname, "web", "index.html")
  : path.join(__dirname, "testpage.html");
const TEST_PAGE = fs.readFileSync(pagePath, "utf8");

app.get("/", (c) => c.html(TEST_PAGE));
app.get("/admin", (c) => c.html(TEST_PAGE));
app.get("/admin/", (c) => c.redirect("/admin", 308));

export { app, launchReadiness, provider };

if (START_REQUESTED) {
  if (startupBlocked) {
    logSecurity("error", "startup.blocked", { blockers: startupReadiness.blockers });
    process.exitCode = 1;
  } else {
    const port = Number(process.env.PORT || 80);
    const server = serve({ fetch: app.fetch, port, ...(process.env.BIND_HOST ? { hostname: process.env.BIND_HOST } : {}) });
    let stopping = false;
    const shutdown = async () => {
      if (stopping) return;
      stopping = true;
      server.close();
      const timeout = setTimeout(() => process.exit(1), 65000);
      timeout.unref();
      try {
        await accountRetentionJob?.stop();
        await stageDrain.begin(async () => { await flushComplianceStore(); await flushMetrics(); });
        await accountSecurityLog?.close();
        process.exit(0);
      }
      catch { process.exit(1); }
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    console.log(`✔ 乐颜秀接入服务已启动 :${port}（渠道：${PROVIDER}）`);
  }
}
