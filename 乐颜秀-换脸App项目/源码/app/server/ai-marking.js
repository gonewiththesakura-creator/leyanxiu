import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const python = process.env.PYTHON_PATH || (process.platform === "win32" ? "python" : "python3");
const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";

function markingFont() {
  const candidates = [
    process.env.AI_MARK_FONT,
    process.platform === "win32" ? "C:\\Windows\\Fonts\\msyh.ttc" : "",
    process.platform === "win32" ? "C:\\Windows\\Fonts\\arial.ttf" : "",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || "";
}

function ffmpegFontOption(fontFile) {
  const escaped = fontFile.replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
  return `fontfile='${escaped}':`;
}

function commandReady(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return !result.error && result.status === 0;
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(String(left)) || !/^[a-f0-9]{64}$/i.test(String(right))) return false;
  return crypto.timingSafeEqual(Buffer.from(String(left).toLowerCase()), Buffer.from(String(right).toLowerCase()));
}

export function markingConformanceStatus() {
  const reportPath = String(process.env.AI_MARKING_CONFORMANCE_REPORT || "").trim();
  const expectedSha256 = String(process.env.AI_MARKING_CONFORMANCE_REPORT_SHA256 || "").trim();
  const failed = (reason) => ({ verified: false, standard: null, testedAt: null, reportSha256: null, reason });
  if (!reportPath) return failed("AI_MARKING_CONFORMANCE_REPORT is not configured");
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256)) return failed("AI_MARKING_CONFORMANCE_REPORT_SHA256 must pin the approved report");
  try {
    const stats = fs.statSync(reportPath);
    if (!stats.isFile() || stats.size < 2 || stats.size > 1024 * 1024) return failed("AI marking conformance report must be a bounded JSON file");
    const bytes = fs.readFileSync(reportPath);
    const actualSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    if (!safeEqualHex(actualSha256, expectedSha256)) return failed("AI marking conformance report hash mismatch");
    const report = JSON.parse(bytes.toString("utf8"));
    const testedAt = Date.parse(report?.testedAt);
    const checks = report?.checks || {};
    const requiredChecks = ["visibleLabel", "implicitIdentifier", "serviceProvider", "contentId"];
    if (report?.standard !== "GB 45438-2025" || report?.result !== "pass") return failed("AI marking report does not record a passing GB 45438-2025 result");
    if (!report?.tool || String(report.tool).trim().length < 2) return failed("AI marking report must identify the verification tool");
    if (!/^[a-f0-9]{64}$/i.test(String(report?.testedArtifactSha256 || ""))) return failed("AI marking report must identify the tested artifact digest");
    if (!Number.isFinite(testedAt) || testedAt > Date.now() + 5 * 60_000) return failed("AI marking report testedAt is invalid");
    if (!requiredChecks.every((name) => checks[name] === true)) return failed("AI marking report is missing required passing checks");
    return {
      verified: true,
      standard: report.standard,
      testedAt: new Date(testedAt).toISOString(),
      reportSha256: actualSha256,
      reason: null,
    };
  } catch {
    return failed("AI marking conformance report cannot be read or parsed");
  }
}

export function markingMetadata({ contentId, provider, model, purpose = "generation", taskId = null, operation = "generate" } = {}) {
  if (!["generate", "edit"].includes(operation)) throw new Error("IMAGE_MARKING_OPERATION_INVALID");
  const conformance = markingConformanceStatus();
  return {
    aiGenerated: true,
    aiLabel: operation === "edit" ? "AI编辑" : "AI生成",
    operation,
    markingMethod: "visible-label-and-container-metadata",
    labelStandard: conformance.verified ? conformance.standard : null,
    conformanceVerified: conformance.verified,
    conformanceReportSha256: conformance.verified ? conformance.reportSha256 : null,
    contentId: contentId || null,
    serviceProviderCode: process.env.SERVICE_PROVIDER_CODE || null,
    modelFilingReference: process.env.AI_MODEL_FILING_REFERENCE || null,
    provider: provider || null,
    model: model || null,
    purpose,
    taskId,
    markedAt: new Date().toISOString(),
  };
}

export function markingReadiness({ kinds = ["image", "video"] } = {}) {
  const production = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
  const blockers = [];
  const validKinds = Array.isArray(kinds) && kinds.length > 0 && kinds.every(kind => ["image", "video"].includes(kind));
  if (!validKinds) blockers.push("AI marking kinds must explicitly contain image and/or video");
  const imageRequired = validKinds && kinds.includes("image");
  const videoRequired = validKinds && kinds.includes("video");
  const fontFile = markingFont();
  const conformance = markingConformanceStatus();
  if (production && process.env.AI_MARKING_REQUIRED !== "true") blockers.push("AI_MARKING_REQUIRED=true must be explicitly approved for production");
  if (production && !conformance.verified) blockers.push(conformance.reason);
  if (production && !validMarkingIdentifier(process.env.SERVICE_PROVIDER_CODE)) blockers.push("SERVICE_PROVIDER_CODE must identify the actual image/video service provider");
  if (production && imageRequired && !commandReady(python, ["-c", "from PIL import Image, ImageDraw, ImageFont; from PIL import features; assert features.check('webp')"])) blockers.push("Python with Pillow and WebP support is required for image AI marking");
  if (production && imageRequired && !commandReady(python, [path.join(__dirname, "mark-ai.py"), "--check-font"])) blockers.push("Image AI marking requires actual Chinese label glyphs in the configured font");
  if (production && !fontFile) blockers.push("AI_MARK_FONT or a supported system font is required for visible AI marking");
  if (production && videoRequired && fontFile && !commandReady(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=c=black:s=32x32:d=0.1", "-vf", `drawtext=${ffmpegFontOption(fontFile)}text='AI'`, "-frames:v", "1", "-f", "null", "-"])) blockers.push("FFmpeg drawtext rendering probe failed for video AI marking");
  return { ready: blockers.length === 0, required: process.env.AI_MARKING_REQUIRED === "true", kinds: validKinds ? [...new Set(kinds)] : [], conformance, blockers };
}

function validMarkingIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !["unconfigured", "unknown", "none"].includes(value.toLowerCase());
}

export async function markFile(inputPath, outputPath, { kind, contentId, label, operation = "generate", serviceProviderCode = process.env.SERVICE_PROVIDER_CODE } = {}) {
  const providerCode = serviceProviderCode;
  const conformance = markingConformanceStatus();
  if (kind === "image") {
    if (!validMarkingIdentifier(providerCode) || !validMarkingIdentifier(contentId)) throw new Error("IMAGE_MARKING_IDENTITY_REQUIRED");
    if (!["generate", "edit"].includes(operation)) throw new Error("IMAGE_MARKING_OPERATION_INVALID");
    const visibleLabel = label ?? (operation === "edit" ? "AI编辑" : "AI生成");
    const allowedLabels = operation === "edit" ? ["AI编辑", "AI生成合成"] : ["AI生成", "AI生成合成"];
    if (!allowedLabels.includes(visibleLabel)) throw new Error("IMAGE_MARKING_LABEL_REQUIRED");
    await run(python, [path.join(__dirname, "mark-ai.py"), inputPath, outputPath, "--content-id", contentId, "--label", visibleLabel, "--service-provider", providerCode, "--operation", operation], {
      maxBuffer: 4 * 1024 * 1024, timeout: 30_000, windowsHide: true,
    });
    return { outputPath, operation, explicitVisibleLabel: true, containerMetadataWritten: true, implicitFormat: "TC260-XMP-AIGC", conformanceVerified: conformance.verified };
  }
  if (kind === "video") {
    const videoProviderCode = String(providerCode || "unconfigured").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unconfigured";
    const escaped = String(contentId || "").replace(/[^A-Za-z0-9_-]/g, "_");
    const escapedLabel = String(label || "AI生成").replaceAll("\\", "\\\\").replaceAll(":", "\\:").replaceAll("'", "\\'").replaceAll("%", "\\%").slice(0, 32);
    const fontFile = markingFont();
    if (!fontFile) throw new Error("VIDEO_MARKING_FONT_NOT_CONFIGURED");
    const filter = `drawtext=${ffmpegFontOption(fontFile)}text='${escapedLabel}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.65:boxborderw=8:x=w-tw-24:y=h-th-24:enable='between(t,0,3)'`;
    await run(ffmpeg, ["-y", "-i", inputPath, "-vf", filter, "-metadata", `comment=AI_Generated=true;Service_Provider=${videoProviderCode};Content_ID=${escaped}`, "-c:v", "libx264", "-c:a", "copy", outputPath], { maxBuffer: 16 * 1024 * 1024 });
    return { outputPath, explicitVisibleLabel: true, containerMetadataWritten: true, conformanceVerified: conformance.verified };
  }
  fs.copyFileSync(inputPath, outputPath);
  return { outputPath, explicitVisibleLabel: false, containerMetadataWritten: false, conformanceVerified: false };
}
