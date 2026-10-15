import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { accountEvidence, databaseEvidence, merchantEvidence } from '../payments/evidence.js';
import { smsReadiness } from '../payments/sms.js';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(serverRoot, "..");
const blockers = [];
const env = (name) => String(process.env[name] || "");
const production = [env("DEPLOY_ENV"), env("NODE_ENV")].map((value) => value.toLowerCase()).includes("production");

function approvedHttpsUrl(value, { originOnly = false } = {}) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
    if (originOnly && (url.search || (url.pathname && url.pathname !== "/"))) return false;
    return true;
  } catch {
    return false;
  }
}

function trackedFiles() {
  try {
    return execFileSync("git", ["ls-files"], { cwd: repoRoot, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

function releaseFiles() {
  try {
    return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: repoRoot, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    return trackedFiles();
  }
}

function workingTreeStatus() {
  try {
    return execFileSync("git", ["status", "--porcelain=v1"], { cwd: repoRoot, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  } catch {
    return ["git status unavailable"];
  }
}

const tracked = trackedFiles();
const sourceFiles = releaseFiles();
const dirtyEntries = workingTreeStatus();
for (const file of sourceFiles) {
  if (/^(?:server\/)?\.env(?:\.|$)/i.test(file) && !file.endsWith(".env.example")) blockers.push(`secret-like environment file is tracked: ${file}`);
}
const secretPatterns = [
  ["private-key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["aliyun-access-key", /\bLTAI[A-Za-z0-9]{12,}\b/],
  ["openai-style-key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["aws-access-key", /\bAKIA[A-Z0-9]{16}\b/],
];
for (const file of sourceFiles.filter((item) => /^server\/.*\.(?:js|mjs|json|md|html|py|ya?ml|toml|sh|ps1)$/i.test(item) && !item.startsWith("server/web/"))) {
  const full = path.join(repoRoot, file);
  if (!fs.existsSync(full) || fs.statSync(full).size > 5 * 1024 * 1024) continue;
  const content = fs.readFileSync(full, "utf8");
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(content)) blockers.push(`possible hard-coded ${label} in ${file}`);
  }
}

if (production) {
  const releaseChannel = env("RELEASE_CHANNEL") || "wechat-mini-program";
  if (dirtyEntries.length) blockers.push("working tree must be clean and committed before production release");
  if (releaseChannel === "wechat-mini-program" && env("AUTH_MODE") !== "wechat") blockers.push("AUTH_MODE=wechat is required for mini-program production");
  if (releaseChannel === "android-app" && env("AUTH_MODE") !== "device_key") blockers.push("AUTH_MODE=device_key is required for Android production");
  if (["", "none", "not_configured", "device_key"].includes(env("REAL_NAME_AUTH_MODE").toLowerCase())) blockers.push("real-name identity verification is required independently of device_key");
  if (!env("REAL_NAME_AUTH_PROVIDER")) blockers.push("REAL_NAME_AUTH_PROVIDER must identify the contracted verifier");
  if (env("REAL_NAME_AUTH_VERIFIED") !== "true") blockers.push("REAL_NAME_AUTH_VERIFIED=true requires completed provider acceptance evidence");
  blockers.push("real-name verification adapter and per-user verification binding are not implemented");
  if (!["wechat-mini-program", "android-app"].includes(releaseChannel)) blockers.push(`unsupported production RELEASE_CHANNEL=${releaseChannel}`);
  if (env("AUTH_SESSION_SECRET").length < 32) blockers.push("AUTH_SESSION_SECRET must be at least 32 characters");
  if (env("OBJECT_STORAGE_BACKEND") !== "oss") blockers.push("OBJECT_STORAGE_BACKEND=oss is required in production");
  if (env("TASKS_BACKEND") !== "oss") blockers.push("TASKS_BACKEND=oss is required for production task persistence");
  blockers.push("durable transactional compliance ledger and tested backup/restore are not implemented; local JSON is closed-test only");
  try {
    const publicBase = new URL(env("PUBLIC_BASE_URL"));
    if (publicBase.protocol !== "https:" || publicBase.username || publicBase.password || publicBase.search || publicBase.hash || (publicBase.pathname && publicBase.pathname !== "/")) throw new Error("invalid");
  } catch {
    blockers.push("PUBLIC_BASE_URL must be an origin-only HTTPS URL in production");
  }
  if (!env("CORS_ORIGIN") || env("CORS_ORIGIN") === "*" || env("CORS_ORIGIN").split(",").some((origin) => !approvedHttpsUrl(origin.trim(), { originOnly: true }))) blockers.push("CORS_ORIGIN must be an explicit HTTPS origin allowlist in production");
  if (!env("OUTBOUND_HOST_ALLOWLIST")) blockers.push("OUTBOUND_HOST_ALLOWLIST must list reviewed supplier and storage hosts");
  if (env("REPORT_DATA_ENCRYPTION_KEY").length < 32) blockers.push("REPORT_DATA_ENCRYPTION_KEY must be a separate 32+ character secret");
  if (!Number.isSafeInteger(Number(env("REPORT_RETENTION_DAYS"))) || Number(env("REPORT_RETENTION_DAYS")) < 1 || Number(env("REPORT_RETENTION_DAYS")) > 3650) blockers.push("REPORT_RETENTION_DAYS must explicitly be between 1 and 3650");
  if (!/^[a-f0-9]{64}$/i.test(env("BASIC_CONSENT_NOTICE_SHA256"))) blockers.push("BASIC_CONSENT_NOTICE_SHA256 must pin the approved notice");
  if (!/^[a-f0-9]{64}$/i.test(env("FACE_CONSENT_NOTICE_SHA256"))) blockers.push("FACE_CONSENT_NOTICE_SHA256 must pin the approved face-processing notice");
  if (!Number.isSafeInteger(Number(env("PROVIDER_DAILY_CALL_LIMIT"))) || Number(env("PROVIDER_DAILY_CALL_LIMIT")) < 1) blockers.push("PROVIDER_DAILY_CALL_LIMIT must be an explicit positive budget");
  if (!Number.isSafeInteger(Number(env("USER_DAILY_GENERATION_LIMIT"))) || Number(env("USER_DAILY_GENERATION_LIMIT")) < 1) blockers.push("USER_DAILY_GENERATION_LIMIT must be an explicit positive per-user budget");
  if (env("CONTENT_POLICY_VERSION").startsWith("unapproved-") || !env("CONTENT_POLICY_VERSION")) blockers.push("approved CONTENT_POLICY_VERSION is required");
  if (env("CONTENT_SAFETY_MODE") === "local_rules") blockers.push("production image/video content safety provider is required");
  else blockers.push("external content safety adapter is not implemented; credentials alone are insufficient");
  if (env("AI_MARKING_REQUIRED") !== "true") blockers.push("AI_MARKING_REQUIRED=true is required in production");
  const markingReportPath = env("AI_MARKING_CONFORMANCE_REPORT");
  const markingReportPin = env("AI_MARKING_CONFORMANCE_REPORT_SHA256");
  if (!markingReportPath || !fs.existsSync(markingReportPath)) {
    blockers.push("AI_MARKING_CONFORMANCE_REPORT must reference an actual GB 45438-2025 verification report");
  } else {
    try {
      const reportBytes = fs.readFileSync(markingReportPath);
      const reportSha256 = crypto.createHash("sha256").update(reportBytes).digest("hex");
      const report = JSON.parse(reportBytes.toString("utf8"));
      const requiredChecks = ["visibleLabel", "implicitIdentifier", "serviceProvider", "contentId"];
      if (!/^[a-f0-9]{64}$/i.test(markingReportPin) || reportSha256 !== markingReportPin.toLowerCase()) blockers.push("AI marking conformance report hash is not pinned or does not match");
      if (report?.standard !== "GB 45438-2025" || report?.result !== "pass" || !report?.tool || !/^[a-f0-9]{64}$/i.test(String(report?.testedArtifactSha256 || "")) || !Number.isFinite(Date.parse(report?.testedAt)) || !requiredChecks.every((name) => report?.checks?.[name] === true)) {
        blockers.push("AI marking conformance report is not a complete passing verification result");
      }
    } catch {
      blockers.push("AI marking conformance report cannot be read or parsed");
    }
  }
  if (!env("SERVICE_PROVIDER_CODE")) blockers.push("SERVICE_PROVIDER_CODE is required in production");
  if (!env("AI_MODEL_FILING_REFERENCE")) blockers.push("AI_MODEL_FILING_REFERENCE is required in production");
  if (!env("LICENSED_ASSET_IDS")) blockers.push("LICENSED_ASSET_IDS is required in production");
  if (releaseChannel === "wechat-mini-program" && (!env("MINIPROGRAM_APPID") || !env("MINIPROGRAM_RECORD_NO"))) blockers.push("mini-program AppID and record number are required for production");
  if (releaseChannel === "android-app" && !env("APP_PACKAGE_NAME")) blockers.push("APP_PACKAGE_NAME is required for Android production");
  if (releaseChannel === "android-app" && !env("APP_RECORD_NO")) blockers.push("APP_RECORD_NO is required for Android production");
  if (releaseChannel === "android-app" && !env("ICP_RECORD_NO")) blockers.push("ICP_RECORD_NO is required for the Android API domain");
  if (env('PAYMENT_MODE') === 'live' && releaseChannel === 'android-app') {
    if (env('PAYMENT_PROVIDER') !== 'wechat-app' || env('BILLING_BACKEND') !== 'postgres') blockers.push('App live payment requires wechat-app and PostgreSQL billing');
    if (!databaseEvidence() || !merchantEvidence()) blockers.push('pinned App database and real merchant acceptance reports are required');
    if (!smsReadiness() || env('ACCOUNT_RECOVERY_VERIFIED') !== 'true') blockers.push('phone recovery configuration and acceptance required');
    if(env('APP_LOGIN_ENABLED')!=='true' || !accountEvidence()) blockers.push('unified App login and pinned real-device acceptance required');
    if (env('PAYMENT_RECONCILE_ENABLED') !== 'true' || env('PAYMENT_BILL_RECONCILE_ENABLED') !== 'true') blockers.push('App payment reconciliation jobs must be enabled');
  }
  if (!env("RETENTION_SUPPLIER_POLICY")) blockers.push("supplier retention/deletion policy is required");
  if (!approvedHttpsUrl(env("PRIVACY_POLICY_URL"))) blockers.push("approved HTTPS privacy policy URL is required");
  if (!approvedHttpsUrl(env("USER_AGREEMENT_URL"))) blockers.push("approved HTTPS user agreement URL is required");
  if (!approvedHttpsUrl(env("THIRD_PARTY_LIST_URL"))) blockers.push("approved HTTPS third-party list URL is required");
  if (!env("SUPPORT_CONTACT")) blockers.push("company support contact is required");
  if (!env("PIPIA_REFERENCE")) blockers.push("approved PIPIA reference is required");
  if (!env("OPERATOR_NAME")) blockers.push("legal OPERATOR_NAME is required for public disclosure");
  try {
    const disclosures = JSON.parse(env("AI_SERVICE_DISCLOSURES_JSON") || "[]");
    const required = ["video-fusion", "photo-restore", "photo-age", "photo-effect", "photo-anime", "photo-bg"];
    if (!Array.isArray(disclosures) || !disclosures.every((item) => item?.provider && item?.model && item?.filingReference && item?.purpose && item?.region && Array.isArray(item?.capabilities))) {
      blockers.push("every AI service disclosure requires provider/model/filingReference/purpose/region/capabilities");
    } else {
      for (const capability of required) {
        if (!disclosures.some((item) => item.capabilities.includes(capability))) blockers.push(`AI service disclosure is missing capability: ${capability}`);
      }
    }
  } catch {
    blockers.push("AI_SERVICE_DISCLOSURES_JSON must be valid JSON");
  }
  if (env("PAYMENT_MODE") === "live" && env("PAYMENT_ADAPTER_VERIFIED") !== "true") blockers.push("PAYMENT_ADAPTER_VERIFIED=true requires signed sandbox callback and reconciliation evidence");
  if (env("VITE_USE_MOCK") === "true") blockers.push("VITE_USE_MOCK must not be enabled in a production build");
}

const commit = (() => {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(); } catch { return "unavailable"; }
})();
const hash = crypto.createHash("sha256");
const hashedFiles = sourceFiles.filter((item) => item.startsWith("server/") && !/(^|\/)(?:node_modules|data|private-objects|output)(?:\/|$)/.test(item) && !/(^|\/)\.env(?:\.|$)/i.test(item)).sort();
for (const file of hashedFiles) {
  const full = path.join(repoRoot, file);
  if (fs.existsSync(full) && fs.statSync(full).isFile()) hash.update(file).update(fs.readFileSync(full));
}
const evidence = {
  releaseTag: env("RELEASE_TAG") || "unreleased-local",
  commit,
  serverSha256: hash.digest("hex"),
  sourceFileCount: hashedFiles.length,
  workingTreeDirty: dirtyEntries.length > 0,
  environment: env("DEPLOY_ENV") || env("NODE_ENV") || "development",
  publicLaunchAllowed: blockers.length === 0 && production,
  blockers,
  checkedAt: new Date().toISOString(),
};
console.log(JSON.stringify(evidence, null, 2));
if (production && blockers.length) process.exitCode = 1;
