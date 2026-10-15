/**
 * 阿里云 · 视觉智能开放平台 viapi 聚合层（主渠道）
 * 覆盖聚合 App 首发的 5 个功能中走阿里的 4 个：
 *
 *  1. 老照片修复：facebody EnhanceFace（人脸修复增强，同步）
 *                 + imageenhan ColorizeImage（黑白上色，同步，可选）
 *  2. 照片换脸（模板合照）：facebody AddFaceImageTemplate 建模板（一次性）
 *                 + MergeImageFace 融合（同步）
 *  3. 证件照：imageseg SegmentHDBody（高清人体分割，同步，返回 alpha PNG）
 *                 换底/裁剪/排版由本地 idphoto-compose.py 完成
 *  4. 视频抠像换背景：videoseg SegmentVideoBody（异步，GetAsyncJobResult 轮询）
 *                 返回抠像视频后本地 ffmpeg 叠加到背景模板
 * （第 5 项「减龄/变老」阿里没有生成能力，走腾讯 ft，见 tencent-ft.js）
 *
 * 注意：viapi 各产品线的返回结果 URL 仅 30 分钟有效，
 *       所有结果必须立刻下载转存自家私有对象存储并通过短时 URL 返回。
 * 各产品线需在 viapi 控制台单独「开通能力」（免费开通、按量计费）：
 * 人脸人体 facebody / 图像生产 imageenhan / 分割抠图 imageseg / 视频分割 videoseg。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { rpc } from "./aliyun.js";
import { objectStore } from "../storage.js";
import { markFile, markingMetadata } from "../ai-marking.js";
import { fetchRemoteBuffer } from "../remote-fetch.js";

const EP_FACEBODY = "facebody.cn-shanghai.aliyuncs.com";    // 2019-12-30
const EP_IMAGEENHAN = "imageenhan.cn-shanghai.aliyuncs.com"; // 2019-09-30
const EP_IMAGESEG = "imageseg.cn-shanghai.aliyuncs.com";     // 2019-12-30
const EP_VIDEOSEG = "videoseg.cn-shanghai.aliyuncs.com";     // 2020-03-20
export const VIDEO_MATTING_MODEL = "SegmentVideoBody";

// 工作目录（英文路径，避免 Windows 中文路径坑；容器里用 /tmp）
const WORK_DIR = process.env.REPAIR_WORK_DIR || (process.platform === "win32" ? "C:\\leyanxiu-repair" : "/tmp/leyanxiu");
fs.mkdirSync(path.join(WORK_DIR, "viapi"), { recursive: true });

/** 公开 URL 下载到本地 */
async function fetchToLocal(url, localName) {
  const p = path.join(WORK_DIR, "viapi", localName);
  const buffer = await fetchRemoteBuffer(url, { purpose: "阿里云视觉结果" });
  fs.writeFileSync(p, buffer, { mode: 0o600 });
  return p;
}

/**
 * viapi 返回的临时 URL 转存私有对象存储，返回短时 URL。
 * 不做转存的话 30 分钟后链接失效。业务路由优先使用 index.js 的
 * ownerId 版本；这个兼容函数保留给离线诊断脚本，默认归属 system。
 */
export async function persistResult(tmpUrl, key, { ownerId = "system", base } = {}) {
  const safeKey = crypto.createHash("sha256").update(String(key)).digest("hex");
  const local = await fetchToLocal(tmpUrl, safeKey);
  const ext = path.extname(key) || ".bin";
  const kind = [".mp4", ".mov", ".webm"].includes(ext.toLowerCase()) ? "video" : "image";
  const contentId = `lyx_${crypto.randomUUID()}`;
  const marked = path.join(WORK_DIR, "viapi", `marked-${crypto.randomUUID()}${ext}`);
  try {
    await markFile(local, marked, { kind, contentId, label: "AI生成" });
    const asset = await objectStore.putFile(marked, {
      ownerId,
      contentType: kind === "video" ? "video/mp4" : "image/jpeg",
      ext,
      purpose: "diagnostic/provider-result",
      metadata: markingMetadata({ contentId, provider: "aliyun-viapi", model: "diagnostic-provider-result", purpose: "diagnostic/provider-result" }),
      retainSeconds: Number(process.env.OUTPUT_RETENTION_SECONDS || 86_400),
    });
    return objectStore.signedUrl(asset.id, { ownerId, base });
  } finally {
    fs.rmSync(local, { force: true });
    fs.rmSync(marked, { force: true });
  }
}

/* ================= 1. 老照片修复 ================= */

/** 人脸修复增强（同步）。要求 ≤3MB、最长边≤2047、人脸≥64px；不支持划痕破损修复 */
export async function enhanceFace(imageUrl) {
  const r = await rpc("EnhanceFace", { ImageURL: imageUrl }, EP_FACEBODY, "2019-12-30");
  return r.Data?.ImageURL;
}

/** 黑白照片上色（同步）。≤10MB、边长<3000 */
export async function colorizeImage(imageUrl) {
  const r = await rpc("ColorizeImage", { ImageURL: imageUrl }, EP_IMAGEENHAN, "2019-09-30");
  return r.Data?.ImageURL;
}

/* ================= 2. 照片换脸（模板合照） ================= */

/** 照片模板入库（一次性，存下 TemplateId）。imageUrl 为模板合照公开 URL */
export async function addImageTemplate(imageUrl) {
  const r = await rpc("AddFaceImageTemplate", { ImageURL: imageUrl }, EP_FACEBODY, "2019-12-30");
  return r.Data?.TemplateId;
}

/**
 * 照片融合（同步）。
 * ModelVersion: v1（自然）/ v2（脸型适配更佳）
 * 返回融合后临时 URL，调用方须 persistResult 转存。
 */
export async function mergeImageFace({ templateId, imageUrl, modelVersion = "v2" }) {
  const r = await rpc("MergeImageFace", {
    TemplateId: templateId,
    ImageURL: imageUrl,
    ModelVersion: modelVersion,
    AddWatermark: true,
    WatermarkType: "CN", // 强制中文可见水印；最终合规性仍由独立检测报告验证
  }, EP_FACEBODY, "2019-12-30");
  return r.Data?.ImageURL;
}

/* ================= 3. 证件照 ================= */

/**
 * 高清人体分割（同步）。返回 4 通道 alpha PNG 临时 URL（须转存）。
 * ≤40MB、≤6000px。
 */
export async function segmentHDBody(imageUrl) {
  const r = await rpc("SegmentHDBody", { ImageURL: imageUrl }, EP_IMAGESEG, "2019-12-30");
  return r.Data?.ImageURL;
}

/* ================= 4. 视频抠像换背景 ================= */

/** 提交人体视频抠像任务（异步），返回 { taskId }（taskId 即 RequestId） */
export async function segmentVideoBody(videoUrl) {
  const r = await rpc("SegmentVideoBody", { VideoUrl: videoUrl }, EP_VIDEOSEG, "2020-03-20");
  return { taskId: r.RequestId, model: VIDEO_MATTING_MODEL };
}

/** 轮询抠像任务，返回 { status, videoUrl? }（SUCCESS 时 videoUrl 为临时 URL 须转存） */
export async function queryMattingTask(taskId) {
  const q = await rpc("GetAsyncJobResult", { JobId: taskId }, EP_VIDEOSEG, "2020-03-20");
  const st = q.Data?.Status;
  if (st === "PROCESS_SUCCESS") {
    const result = JSON.parse(q.Data.Result);
    return { status: "SUCCESS", videoUrl: result.videoUrl || result.VideoUrl };
  }
  if (st === "PROCESS_FAILED") return { status: "FAILED" };
  return { status: "RUNNING" };
}

/* ================= 人脸检测（腾讯减龄/变老取 FaceRect 用） ================= */

/** 人脸检测，返回最大人脸的框 {X,Y,Width,Height}（像素）。取不到返回 null */
export async function detectFaceRect(imageUrl) {
  const r = await rpc("DetectFace", { ImageURL: imageUrl }, EP_FACEBODY, "2019-12-30");
  // 实测返回：Data.FaceRectangles 为扁平数组 [x1,y1,w1,h1, x2,y2,w2,h2, ...]
  const arr = r.Data?.FaceRectangles || [];
  if (arr.length < 4) return null;
  let best = null;
  for (let i = 0; i + 3 < arr.length; i += 4) {
    const [X, Y, Width, Height] = arr.slice(i, i + 4);
    if (!best || Width * Height > best.Width * best.Height) best = { X, Y, Width, Height };
  }
  return best && {
    X: Math.round(best.X), Y: Math.round(best.Y),
    Width: Math.round(best.Width), Height: Math.round(best.Height),
  };
}

/* ================= 5. 人物动漫化 / 素描 ================= */

/** 人物动漫化（同步）。返回结果临时 URL，调用方须 persistResult 转存 */
export async function generateAnime(imageUrl) {
  const r = await rpc("GenerateHumanAnimeStyle", { ImageURL: imageUrl }, EP_FACEBODY, "2019-12-30");
  return r.Data?.ImageURL;
}

/** 人像素描风格化（同步）。返回结果临时 URL，调用方须 persistResult 转存 */
export async function generateSketch(imageUrl) {
  const r = await rpc("GenerateHumanSketchStyle", { ImageURL: imageUrl }, EP_FACEBODY, "2019-12-30");
  return r.Data?.ImageURL;
}
