import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const base = String(process.env.LEYANXIU_STAGE_BASE || "").replace(/\/$/, "");
const invite = String(process.env.LEYANXIU_STAGE_INVITE_SECRET || "");
const inputPath = path.resolve(process.argv[2] || "../public/avatars/sample-woman-openai-r2.webp");
const outputPath = path.resolve(process.argv[3] || "../output/stage-e2e-final.mp4");
const evidencePath = outputPath.replace(/\.[^.]+$/, ".json");

if (!base.startsWith("https://")) throw new Error("LEYANXIU_STAGE_BASE must be an HTTPS origin");
if (invite.length < 16) throw new Error("LEYANXIU_STAGE_INVITE_SECRET is required");
if (!fs.existsSync(inputPath)) throw new Error(`test portrait does not exist: ${inputPath}`);

let token = "";
let resultUrl = "";
let taskId = "";
let assetId = "";
let accountDeletionStatus = null;
let postDeleteAssetStatus = null;

function requestHeaders(extra = {}) {
  return {
    "X-Closed-Test-Invite": invite,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

async function apiRequest(route, { method = "GET", body, allowError = false } = {}) {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: requestHeaders(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!allowError && (!response.ok || payload.code !== 0)) {
    throw new Error(`${route} failed (${response.status}/${payload.code ?? "unknown"}): ${payload.message || "no message"}`);
  }
  return { response, payload };
}

function imageDataUrl(file) {
  const extension = path.extname(file).toLowerCase();
  const mime = extension === ".webp" ? "image/webp" : extension === ".png" ? "image/png" : "image/jpeg";
  return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
}

const startedAt = new Date().toISOString();
const startedMs = Date.now();
const observedStatuses = [];
let evidence;
let runError;

try {
  const session = await apiRequest("/api/auth/session", {
    method: "POST",
    body: { clientId: `stage-e2e-${crypto.randomUUID()}`, channel: "h5" },
  });
  token = String(session.payload.data?.token || "");
  if (!token) throw new Error("stage session did not return a token");

  await apiRequest("/api/consents", {
    method: "POST",
    body: { consentType: "basic", action: "granted" },
  });
  await apiRequest("/api/consents", {
    method: "POST",
    body: { consentType: "face_processing", action: "granted", subjectAuthorization: "self" },
  });

  const upload = await apiRequest("/api/upload", {
    method: "POST",
    body: { image: imageDataUrl(inputPath) },
  });
  const userPhotoUrl = String(upload.payload.data?.url || "");
  if (!userPhotoUrl) throw new Error("stage upload did not return a private photo URL");

  const fusion = await apiRequest("/api/fusion", {
    method: "POST",
    body: { templateId: "jinqu", userPhotoUrl },
  });
  taskId = String(fusion.payload.data?.taskId || "");
  const submittedProvider = String(fusion.payload.data?.provider || "");
  const submittedModel = String(fusion.payload.data?.model || "");
  if (!taskId || submittedProvider !== "aliyun" || submittedModel !== "MergeVideoFace") {
    throw new Error(`unexpected fusion submission metadata: ${submittedProvider}/${submittedModel || "missing-model"}`);
  }

  const deadline = Date.now() + 360_000;
  let completed;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const polled = await apiRequest(`/api/fusion/${encodeURIComponent(taskId)}`);
    const data = polled.payload.data || {};
    const status = String(data.status || "UNKNOWN");
    if (observedStatuses.at(-1) !== status) observedStatuses.push(status);
    if (status === "FAILED") throw new Error("Aliyun video fusion returned FAILED");
    if (status === "SUCCESS") {
      completed = data;
      break;
    }
  }
  if (!completed) throw new Error("stage fusion timed out after 360 seconds");

  resultUrl = String(completed.videoUrl || "");
  assetId = String(completed.assetId || "");
  if (!resultUrl || !assetId || completed.stored !== true) throw new Error("completed fusion was not persisted as a private asset");
  if (completed.metadata?.provider !== "aliyun" || completed.metadata?.model !== "MergeVideoFace") {
    throw new Error(`persisted metadata is incomplete: ${completed.metadata?.provider || "missing-provider"}/${completed.metadata?.model || "missing-model"}`);
  }

  const media = await fetch(resultUrl);
  if (!media.ok) throw new Error(`generated video download failed with ${media.status}`);
  const bytes = Buffer.from(await media.arrayBuffer());
  if (bytes.length < 1024 || !String(media.headers.get("content-type") || "").startsWith("video/")) {
    throw new Error("generated asset is not a valid downloadable video response");
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, bytes);

  evidence = {
    verdict: "PASS",
    startedAt,
    completedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedMs) / 1000),
    provider: submittedProvider,
    model: submittedModel,
    taskId,
    assetId,
    observedStatuses,
    outputBytes: bytes.length,
    outputPath,
    privateTemplateInput: true,
    outputMetadata: {
      provider: completed.metadata.provider,
      model: completed.metadata.model,
    },
  };
} catch (error) {
  runError = error;
  evidence = {
    verdict: "FAIL",
    startedAt,
    failedAt: new Date().toISOString(),
    durationSeconds: Math.round((Date.now() - startedMs) / 1000),
    taskId: taskId || null,
    assetId: assetId || null,
    observedStatuses,
    error: error instanceof Error ? error.message : String(error),
  };
} finally {
  if (token) {
    try {
      const deleted = await apiRequest("/api/account", { method: "DELETE", allowError: true });
      accountDeletionStatus = { http: deleted.response.status, code: deleted.payload.code };
    } catch (error) {
      accountDeletionStatus = { error: error instanceof Error ? error.message : String(error) };
    }
  }
  if (resultUrl) {
    try {
      postDeleteAssetStatus = (await fetch(resultUrl)).status;
    } catch {
      postDeleteAssetStatus = "network-error";
    }
  }
}

evidence.cleanup = { accountDeletionStatus, postDeleteAssetStatus };
fs.writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence));
if (runError) throw runError;
