/**
 * 遮挡回贴修复模块（出片后处理）
 * 背景：阿里/腾讯/火山的视频换脸都会把融合脸贴在「原本挡在脸前的手」上面，
 * 三家官方均确认不支持遮挡保持（2026-08-03 工单回复）。
 * 解法：模板入库时预计算手部遮挡 mask（precompute-mask.py，一次性、CPU），
 *       出片时用 ffmpeg maskedmerge 把原模板的手部像素合成回换脸结果。
 *
 * 合成耗时约为视频时长的 0.5x（1080p CPU），全程无 ML、无 GPU。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import OSS from "ali-oss";
import crypto from "node:crypto";
import { objectStore } from "./storage.js";
import { markFile, markingMetadata } from "./ai-marking.js";
import { fetchRemoteBuffer } from "./remote-fetch.js";

const run = promisify(execFile);

// 工作目录用纯英文路径（ffmpeg/mediapipe 在 Windows 下对中文路径支持差；容器里用 /tmp）
const WORK_DIR = process.env.REPAIR_WORK_DIR || (process.platform === "win32" ? "C:\\leyanxiu-repair" : "/tmp/leyanxiu");
fs.mkdirSync(WORK_DIR, { recursive: true });

// ffmpeg 解析顺序：环境变量 > Windows 工作目录副本 > 系统 PATH（Docker 镜像用 apt 装的）
let FFMPEG = process.env.FFMPEG_PATH || "";
if (!FFMPEG) {
  const safe = path.join(WORK_DIR, "ffmpeg.exe");
  if (process.platform === "win32" && fs.existsSync(safe)) {
    FFMPEG = safe;
  } else if (process.platform !== "win32") {
    FFMPEG = "ffmpeg";
  } else {
    throw new Error(`找不到 ffmpeg：请设置 FFMPEG_PATH 或把 ffmpeg.exe 放到 ${WORK_DIR}`);
  }
}

function ossClient() {
  return new OSS({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
    bucket: process.env.OSS_BUCKET || "leyanxiu-face-2026",
    region: process.env.OSS_REGION || "oss-cn-shanghai",
  });
}

/** 公开 URL 下载到本地缓存（按文件名去重） */
async function fetchToLocal(url, localName) {
  const p = path.join(WORK_DIR, localName);
  if (fs.existsSync(p)) return p;
  const buffer = await fetchRemoteBuffer(url, { purpose: "视频遮挡修复素材" });
  fs.writeFileSync(p, buffer, { mode: 0o600 });
  return p;
}

/** OSS 私有对象下载到本地缓存 */
async function ossToLocal(key, localName) {
  const p = path.join(WORK_DIR, localName);
  if (fs.existsSync(p)) return p;
  await ossClient().get(key, p);
  return p;
}

/**
 * 修复一条换脸成片。
 * @param taskId   任务ID（也用作输出文件名）
 * @param swapUrl  云厂商返回的换脸结果视频 URL
 * @param videoUrl 模板原视频公开 URL
 * @param maskKey  遮挡 mask 在 OSS 中的 key（私有）
 * @returns 修复后视频的私有对象和短时 URL
 */
export function occlusionTraceMetadata({ contentId, provider, providerModel, taskId }) {
  return {
    ...markingMetadata({
      contentId,
      provider,
      model: providerModel || null,
      purpose: "video-fusion-repaired",
      taskId,
    }),
    postProcessingModel: "occlusion-mask-merge",
  };
}

export async function repairOcclusion({ taskId, swapUrl, videoUrl, maskKey, ownerId, base, provider = "aliyun", providerModel = null }) {
  const taskFileId = crypto.createHash("sha256").update(String(taskId)).digest("hex").slice(0, 32);
  const templateFileId = crypto.createHash("sha256").update(String(videoUrl)).digest("hex").slice(0, 32);
  const maskFileId = crypto.createHash("sha256").update(String(maskKey)).digest("hex").slice(0, 32);
  const [swapPath, tplPath, maskPath] = await Promise.all([
    fetchToLocal(swapUrl, `swap-${taskFileId}.mp4`),
    fetchToLocal(videoUrl, `tpl-${templateFileId}.mp4`),
    ossToLocal(maskKey, `mask-${maskFileId}.bin`),
  ]);

  const outPath = path.join(WORK_DIR, `fixed-${taskFileId}.mp4`);
  const contentId = `lyx_${crypto.randomUUID()}`;
  const markedPath = path.join(WORK_DIR, `marked-fixed-${taskFileId}.mp4`);
  try {
    await run(FFMPEG, [
      "-y",
      "-i", swapPath,
      "-i", tplPath,
      "-i", maskPath,
      // maskedmerge 对 yuv420p 的 mask 会按半分辨率色度插值导致偏色，
      // 统一转平面RGB(gbrp)+灰度mask 再合成
      "-filter_complex", "[0:v]format=gbrp[a];[1:v]format=gbrp[b];[2:v]format=gray[m];[a][b][m]maskedmerge,format=yuv420p[out]",
      "-map", "[out]",
      "-map", "0:a?",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
      "-c:a", "aac",
      outPath,
    ], { maxBuffer: 16 * 1024 * 1024 });
    await markFile(outPath, markedPath, { kind: "video", contentId, label: "AI生成" });
    const asset = await objectStore.putFile(markedPath, {
      ownerId,
      contentType: "video/mp4",
      ext: ".mp4",
      purpose: "output/video-fusion-repaired",
      metadata: occlusionTraceMetadata({
        contentId,
        provider,
        providerModel,
        taskId,
      }),
      retainSeconds: Number(process.env.OUTPUT_RETENTION_SECONDS || 86_400),
    });
    return { assetId: asset.id, url: await objectStore.signedUrl(asset.id, { ownerId, base }), metadata: asset.metadata };
  } finally {
    // 清理大文件，保留模板和 mask 缓存
    for (const f of [swapPath, outPath, markedPath]) fs.rmSync(f, { force: true });
  }
}
