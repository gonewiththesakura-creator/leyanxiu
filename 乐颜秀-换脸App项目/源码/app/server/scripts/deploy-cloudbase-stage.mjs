import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashAdminPassword } from "../admin-auth.js";
import { redactDeploymentDiagnostics, sanitizedChildEnv, spawnWithJsonStdin } from "./secure-child.js";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const secureRunner = path.join(serverDir, "scripts", "wxcloud-deploy-runner.mjs");
const envFile = path.join(serverDir, ".env");
const stageSecretsFile = path.join(serverDir, ".env.stage.secrets");
const cloudEnvId = "leyanxiu-prod-d5gimob8af6a6e5c9";
const serviceName = "leyanxiu-stage";
const publicBase = "REDACTED_COMPANY_CLOUD_ENDPOINT";

function readEnv(file) {
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match || line.trimStart().startsWith("#")) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (value) values[match[1]] = value;
  }
  return values;
}

function required(name, minimum = 1) {
  const value = String(process.env[name] || "");
  if (value.length < minimum) throw new Error(`${name} must be supplied to the deploy process`);
  return value;
}

function randomSecret() {
  return crypto.randomBytes(48).toString("base64url");
}

function loadOrCreateStageSecrets() {
  const existing = fs.existsSync(stageSecretsFile) ? readEnv(stageSecretsFile) : {};
  const secrets = {
    AUTH_SESSION_SECRET: existing.AUTH_SESSION_SECRET || randomSecret(),
    OBJECT_SIGNING_SECRET: existing.OBJECT_SIGNING_SECRET || randomSecret(),
    ADMIN_SESSION_SECRET: existing.ADMIN_SESSION_SECRET || randomSecret(),
    REPORT_DATA_ENCRYPTION_KEY: existing.REPORT_DATA_ENCRYPTION_KEY || randomSecret(),
    INTERNAL_CRON_TOKEN: existing.INTERNAL_CRON_TOKEN || randomSecret(),
  };
  if (!fs.existsSync(stageSecretsFile)) {
    const serialized = Object.entries(secrets).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
    fs.writeFileSync(stageSecretsFile, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
  }
  return secrets;
}

function httpsUrl(value, name) {
  const parsed = new URL(value);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${name} must be HTTP(S)`);
  parsed.protocol = "https:";
  return parsed.toString();
}

if (!fs.existsSync(envFile)) throw new Error("server/.env is required for the controlled staging deploy");
for (const requiredPath of ["Dockerfile", "package.json", "package-lock.json", "bootstrap.js", "web/index.html"]) {
  if (!fs.existsSync(path.join(serverDir, requiredPath))) throw new Error(`deployment source is missing ${requiredPath}`);
}
const dockerIgnore = fs.readFileSync(path.join(serverDir, ".dockerignore"), "utf8");
if (/^\s*!/m.test(dockerIgnore)) {
  throw new Error("wxcloud packaging does not safely support negated .dockerignore rules");
}
const local = readEnv(envFile);
const stageSecrets = loadOrCreateStageSecrets();
for (const key of [
  "ALIYUN_ACCESS_KEY_ID",
  "ALIYUN_ACCESS_KEY_SECRET",
  "OSS_BUCKET",
  "OSS_REGION",
  "DEEPSEEK_API_KEY",
  "TPL_JINQU_URL",
  "TPL_DANCE_URL",
  "TPL_QUOTE_URL",
]) {
  if (!local[key]) throw new Error(`${key} is not configured in server/.env`);
}

const ownerPassword = required("LEYANXIU_STAGE_OWNER_PASSWORD", 12);
const reviewerPassword = required("LEYANXIU_STAGE_REVIEWER_PASSWORD", 12);
const inviteSecret = required("LEYANXIU_STAGE_INVITE_SECRET", 16);
const adminUsers = [
  { username: "stage-owner", displayName: "闭测负责人", role: "owner", passwordHash: hashAdminPassword(ownerPassword), enabled: true },
  { username: "stage-review", displayName: "独立审核人", role: "reviewer", passwordHash: hashAdminPassword(reviewerPassword), enabled: true },
];

const providerKeys = [
  "ALIYUN_ACCESS_KEY_ID",
  "ALIYUN_ACCESS_KEY_SECRET",
  "ALIYUN_ENDPOINT",
  "TENCENT_SECRET_ID",
  "TENCENT_SECRET_KEY",
  "TENCENT_REGION",
  "VOLC_API_KEY",
  "ARK_API_KEY",
  "DASHSCOPE_API_KEY",
  "DASHSCOPE_BASE",
  "DEEPSEEK_API_KEY",
  "SEEDEDIT_MODEL",
  "TPL_JINQU_URL",
  "TPL_STREET_URL",
  "TPL_DANCE_URL",
  "TPL_QUOTE_URL",
  "TPL_STREET_MASK",
  "OSS_BUCKET",
  "OSS_REGION",
];
const providerEnv = Object.fromEntries(providerKeys.filter((key) => local[key]).map((key) => [key, local[key]]));
for (const key of ["TPL_JINQU_URL", "TPL_STREET_URL", "TPL_DANCE_URL", "TPL_QUOTE_URL"]) {
  if (providerEnv[key]) providerEnv[key] = httpsUrl(providerEnv[key], key);
}

const env = {
  ...providerEnv,
  DEPLOY_ENV: "staging",
  RELEASE_CHANNEL: "android-app",
  APP_PACKAGE_NAME: "com.yibohuaxia.leyanxiu",
  PROVIDER: "aliyun",
  PHOTO_PROVIDER: "viapi",
  LLM_PROVIDER: "deepseek",
  // Browser testing uses an invite-gated anonymous session; the native client
  // still selects the P-256 device challenge flow on its own.
  AUTH_MODE: "anonymous",
  AUTH_SESSION_SECRET: stageSecrets.AUTH_SESSION_SECRET,
  AUTH_SESSION_TTL_SECONDS: "86400",
  AUTH_CHALLENGE_TTL_SECONDS: "120",
  CLOSED_TEST_MODE: "true",
  CLOSED_TEST_CREDITS: "3",
  CLOSED_TEST_DAILY_GENERATION_LIMIT: "10",
  CLOSED_TEST_REQUIRE_INVITE: "true",
  CLOSED_TEST_INVITE_SECRET: inviteSecret,
  CLOSED_TEST_MAX_USERS: "20",
  PROVIDER_DAILY_CALL_LIMIT: "10",
  USER_DAILY_GENERATION_LIMIT: "3",
  PAYMENT_MODE: "closed_test",
  TASKS_BACKEND: "oss",
  TASKS_OSS_KEY: "server/stage/tasks.json",
  OBJECT_STORAGE_BACKEND: "oss",
  OBJECT_PREFIX: "stage/private",
  OBJECT_INDEX_OSS_KEY: "server/stage/private-object-index.json",
  OBJECT_SIGNING_SECRET: stageSecrets.OBJECT_SIGNING_SECRET,
  OBJECT_URL_TTL_SECONDS: "900",
  INPUT_RETENTION_SECONDS: "86400",
  OUTPUT_RETENTION_SECONDS: "86400",
  DATA_DIR: "/var/lib/leyanxiu/data",
  COMPLIANCE_STORE_FILE: "/var/lib/leyanxiu/data/compliance.json",
  COMPLIANCE_BACKEND: "oss",
  PRIVATE_OBJECT_DIR: "/var/lib/leyanxiu/private-objects",
  OBJECT_INDEX_FILE: "/var/lib/leyanxiu/data/object-index.json",
  ADMIN_DATA_DIR: "/var/lib/leyanxiu/data",
  ADMIN_SNAPSHOT_BACKEND: "oss",
  ADMIN_STORE_FILE: "/var/lib/leyanxiu/data/admin-console.json",
  ADMIN_WORKFLOW_DATA_DIR: "/var/lib/leyanxiu/data",
  ADMIN_WORKFLOW_STORE_FILE: "/var/lib/leyanxiu/data/admin-workflows.json",
  CAPABILITY_EVIDENCE_DIR: "/var/lib/leyanxiu/reports/capabilities",
  METRICS_LOG_PATH: "/var/lib/leyanxiu/data/metrics.ndjson",
  METRICS_BACKEND: "oss",
  REPAIR_WORK_DIR: "/tmp/leyanxiu",
  PUBLIC_BASE_URL: publicBase,
  CORS_ORIGIN: `https://localhost,${publicBase}`,
  TRUST_PROXY_HEADERS: "true",
  FACE_CONSENT_VERSION: "closed-test-android-2026-09-15-v1",
  BASIC_CONSENT_VERSION: "closed-test-android-2026-09-15-v1",
  CONTENT_POLICY_VERSION: "closed-test-policy-2026-09-15-v1",
  CONTENT_SAFETY_MODE: "local_rules",
  AI_MARKING_REQUIRED: "true",
  SERVICE_PROVIDER_CODE: "yibohuaxia-controlled-stage",
  ADMIN_SESSION_SECRET: stageSecrets.ADMIN_SESSION_SECRET,
  ADMIN_SESSION_TTL_SECONDS: "14400",
  ADMIN_COOKIE_SECURE: "true",
  ADMIN_REQUIRE_DUAL_APPROVAL: "true",
  ADMIN_USERS_JSON: JSON.stringify(adminUsers),
  ADMIN_ALLOW_INSECURE_LOCAL: "false",
  REPORT_DATA_ENCRYPTION_KEY: stageSecrets.REPORT_DATA_ENCRYPTION_KEY,
  REPORT_RETENTION_DAYS: "30",
  INTERNAL_CRON_TOKEN: stageSecrets.INTERNAL_CRON_TOKEN,
  MONITORING_MODE: "local_log",
  ALERT_P95_MS: "15000",
  MAX_REQUEST_BYTES: "20971520",
  MAX_VIDEO_REQUEST_BYTES: "157286400",
  MAX_OBJECT_BYTES: "104857600",
  MAX_IMAGE_BYTES: "10485760",
  MAX_VIDEO_BYTES: "104857600",
};

const wxcloudBin = path.join(
  String(process.env.APPDATA || ""),
  "kimi-desktop",
  "daimon-share",
  "daimon",
  "npm-global",
  "node_modules",
  "@wxcloud",
  "cli",
  "bin",
  "run",
);
if (!fs.existsSync(wxcloudBin)) throw new Error("wxcloud CLI entry point was not found");

const args = [
  "run:deploy",
  serverDir,
  "--targetDir=.",
  `--envId=${cloudEnvId}`,
  `--serviceName=${serviceName}`,
  "--region=ap-shanghai",
  "--dockerfile=Dockerfile",
  "--containerPort=3000",
  `--envParamsJson=${JSON.stringify(env)}`,
  "--releaseType=FULL",
  "--remark=20260918 controlled-stage durable-admin-ledger-monitoring",
  "--noConfirm",
];

console.log(`Deploying ${serviceName}: ${Object.keys(env).length} reviewed environment keys; secret values are not logged.`);
async function deploymentControl(action) {
  const response = await fetch(`${publicBase}/api/internal/deployment-drain`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Internal-Token': stageSecrets.INTERNAL_CRON_TOKEN },
    body: JSON.stringify({ action }), signal: AbortSignal.timeout(60000),
  });
  if (response.status === 404 && action === 'drain' && process.env.LEYANXIU_STAGE_BOOTSTRAP_DRAIN === 'true') {
    console.log('First installation of drain endpoint; legacy service has no durable business ledger.');
    return false;
  }
  if (!response.ok) throw new Error(`Stage deployment ${action} rejected (${response.status})`);
  const result = await response.json();
  if (action === 'drain' && !result.data?.ready) throw new Error('Stage drain has not completed');
  return true;
}
const drained = await deploymentControl('drain');
if (drained) console.log('Stage requests drained and ledgers flushed before container replacement.');
const child = spawnWithJsonStdin(
  process.execPath,
  [secureRunner],
  { wxcloudBin, args: args.slice(1) },
  {
    cwd: serverDir,
    env: sanitizedChildEnv(process.env),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);
let stdout = "";
let stderr = "";
let spawnError;
child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
child.on("error", (error) => { spawnError = error; });
child.on("close", async (code) => {
  if (code === 0) {
    console.log(`Deployment completed for ${publicBase}`);
    return;
  }
  const secrets = [
    ownerPassword,
    reviewerPassword,
    inviteSecret,
    ...adminUsers.map((user) => user.passwordHash),
    ...Object.values(providerEnv),
    ...Object.values(stageSecrets),
    ...Object.values(env).filter((value) => typeof value === "string" && value.length >= 32),
  ];
  const diagnostic = spawnError ? `${spawnError.message}\n${stdout}\n${stderr}` : `${stdout}\n${stderr}`;
  const redacted = redactDeploymentDiagnostics(diagnostic, secrets);
  console.error(redacted || `wxcloud deployment failed with exit code ${code}`);
  if (drained) {
    try { await deploymentControl('resume'); console.log('Existing stage service resumed after failed deployment.'); }
    catch { console.error('Stage remains drained: restore persistence and explicitly resume before accepting traffic.'); }
  }
  process.exitCode = code || 1;
});
