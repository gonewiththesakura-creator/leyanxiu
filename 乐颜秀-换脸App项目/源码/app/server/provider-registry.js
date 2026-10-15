import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const production = String(process.env.DEPLOY_ENV || process.env.NODE_ENV || "").toLowerCase() === "production";
const evidenceRoot = process.env.CAPABILITY_EVIDENCE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), "evidence", "capabilities");

function configured(name) {
  const values = {
    aliyun: Boolean(process.env.ALIYUN_ACCESS_KEY_ID && process.env.ALIYUN_ACCESS_KEY_SECRET),
    tencent: Boolean(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY),
    volcengine: Boolean(process.env.VOLC_API_KEY || process.env.ARK_API_KEY),
    dashscope: Boolean(process.env.DASHSCOPE_API_KEY),
    deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
    hunyuan: Boolean(process.env.TENCENT_SECRET_ID && process.env.TENCENT_SECRET_KEY),
    local: true,
  };
  return values[name] || false;
}

const CAPABILITIES = [
  { id: "video-fusion", route: "/api/fusion", provider: "aliyun", model: "MergeVideoModelFace/MergeVideoFace", requiredEnv: "ALIYUN_ACCESS_KEY_ID + ALIYUN_ACCESS_KEY_SECRET", evidenceFile: "video-fusion.json" },
  { id: "photo-restore", route: "/api/photo/restore", provider: "aliyun", model: "EnhanceFace + ColorizeImage", requiredEnv: "ALIYUN_ACCESS_KEY_ID + ALIYUN_ACCESS_KEY_SECRET", evidenceFile: "photo-restore.json" },
  { id: "photo-fusion", route: "/api/photo/fusion", provider: "aliyun/dashscope", model: "MergeImageFace or configured image edit model", requiredEnv: "photo template + provider credentials", evidenceFile: "photo-fusion.json" },
  { id: "idphoto", route: "/api/photo/idphoto", provider: "aliyun + local", model: "SegmentHDBody + idphoto-compose", requiredEnv: "ALIYUN_ACCESS_KEY_ID + ALIYUN_ACCESS_KEY_SECRET + Python/PIL", evidenceFile: "idphoto.json" },
  { id: "photo-age", route: "/api/photo/age", provider: "aliyun + tencent", model: "DetectFace + ChangeAgePic", requiredEnv: "ALIYUN + TENCENT credentials", evidenceFile: "photo-age.json" },
  { id: "photo-effects", route: "/api/photo/effect", provider: "volcengine/dashscope/aliyun", model: "configured effect model", requiredEnv: "effect provider credentials", evidenceFile: "photo-effects.json" },
  { id: "content-safety", route: "/api/moderation/check", provider: "configured safety policy/provider", model: "pre/post generation checks", requiredEnv: "CONTENT_POLICY_VERSION", evidenceFile: "content-safety.json" },
];

function readEvidence(fileName) {
  const file = path.isAbsolute(fileName) ? fileName : path.join(evidenceRoot, fileName);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function capabilityRegistry({ videoTemplates = 0, photoTemplates = 0 } = {}) {
  return CAPABILITIES.map((item) => {
    const evidence = readEvidence(item.evidenceFile);
    const samples = Array.isArray(evidence) ? evidence : evidence && Array.isArray(evidence.samples) ? evidence.samples : [];
    const uniqueById = new Map();
    for (const sample of samples) {
      const sampleId = String(sample?.id || sample?.sampleId || "").trim();
      if (sampleId && !uniqueById.has(sampleId)) uniqueById.set(sampleId, sample);
    }
    const uniqueSamples = [...uniqueById.values()];
    const passingSamples = uniqueSamples.filter((sample) => sample.status === "success" && sample.identityMismatch === false && sample.severeDistortion === false);
    const successful = uniqueSamples.filter((sample) => sample.status === "success").length;
    const successRate = uniqueSamples.length ? Number((successful / uniqueSamples.length * 100).toFixed(2)) : null;
    const p95Ms = evidence?.p95Ms ?? null;
    const costFen = evidence?.costFen ?? null;
    const identityMismatchCount = uniqueSamples.filter((sample) => sample.identityMismatch === true).length;
    const severeDistortionCount = uniqueSamples.filter((sample) => sample.severeDistortion === true).length;
    const completeEvidenceCount = uniqueSamples.filter((sample) => (
      ["success", "failure"].includes(sample.status)
      && typeof sample.identityMismatch === "boolean"
      && typeof sample.severeDistortion === "boolean"
    )).length;
    const meetsQuality = passingSamples.length >= 30 && completeEvidenceCount === uniqueSamples.length && identityMismatchCount === 0 && severeDistortionCount === 0;
    const configuredProvider = item.provider.includes("+") && item.provider.includes("tencent")
      ? configured("aliyun") && configured("tencent")
      : item.provider.includes("/")
        ? item.provider.split("/").some((providerName) => configured(providerName))
        : item.provider.includes("aliyun")
          ? configured("aliyun")
          : item.provider.includes("tencent")
            ? configured("tencent")
            : item.provider.includes("volcengine")
              ? configured("volcengine")
              : true;
    const templateReady = item.id === "video-fusion" ? videoTemplates > 0 : item.id === "photo-fusion" ? photoTemplates > 0 : true;
    return {
      ...item,
      configured: configuredProvider,
      templateReady,
      sampleCount: uniqueSamples.length,
      passingSampleCount: passingSamples.length,
      acceptanceTarget: 30,
      successRate,
      p95Ms: Number(p95Ms) || null,
      costFen: Number(costFen) || null,
      identityMismatchCount,
      severeDistortionCount,
      evidenceFile: item.evidenceFile,
      ready: configuredProvider && templateReady && meetsQuality,
      status: configuredProvider && templateReady && meetsQuality ? "verified" : "blocked_pending_evidence",
    };
  });
}

export function capabilityReadiness(options) {
  const entries = capabilityRegistry(options);
  const blockers = production ? entries.filter((entry) => !entry.ready).map((entry) => `${entry.id}: provider/template/30-sample evidence incomplete`) : [];
  return { ready: blockers.length === 0, entries, blockers };
}
