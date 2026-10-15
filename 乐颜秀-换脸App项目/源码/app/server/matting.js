/**
 * 视频抠像换背景 · 出片后处理
 * videoseg SegmentVideoBody 返回的是「白底人体剪影 mask 视频」（无 alpha 的 h264），
 * 用 ffmpeg maskedmerge 把人从原视频抠出叠到新背景上：
 *   输出 = 原视频人物(mask=白) + 新背景(mask=黑)
 * 背景支持图片（-loop 1 拉满时长）或视频（-shortest 截齐）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { objectStore } from "./storage.js";
import { markFile, markingMetadata } from "./ai-marking.js";
import { fetchRemoteBuffer } from "./remote-fetch.js";

const run = promisify(execFile);
const WORK_DIR = process.env.REPAIR_WORK_DIR || (process.platform === "win32" ? "C:\\leyanxiu-repair" : "/tmp/leyanxiu");
fs.mkdirSync(WORK_DIR, { recursive: true });

// ffmpeg：环境变量 > Windows 工作目录副本 > 系统 PATH（Docker 镜像用 apt 装的）
const FFMPEG = process.env.FFMPEG_PATH
  || (process.platform === "win32" ? path.join(WORK_DIR, "ffmpeg.exe") : "ffmpeg");

async function fetchToLocal(url, localName) {
  const p = path.join(WORK_DIR, localName);
  if (fs.existsSync(p)) return p;
  const buffer = await fetchRemoteBuffer(url, { purpose: "视频抠像合成素材" });
  fs.writeFileSync(p, buffer, { mode: 0o600 });
  return p;
}

/**
 * 抠像换背景合成
 * @param taskId   任务ID（输出文件名）
 * @param maskUrl  videoseg 返回的 mask 视频临时 URL
 * @param videoUrl 原视频公开 URL
 * @param bgUrl    新背景（图片或视频）公开 URL
 * @returns 合成后视频的私有对象和短时 URL
 */
export function mattingTraceMetadata({ contentId, provider, providerModel, taskId }) {
  return {
    ...markingMetadata({
      contentId,
      provider,
      model: providerModel || null,
      purpose: "video-matting",
      taskId,
    }),
    postProcessingModel: "maskedmerge",
  };
}

export async function composeMatting({ taskId, maskUrl, videoUrl, bgUrl, ownerId, base, provider = "aliyun-viapi", providerModel = null }) {
  const taskFileId = crypto.createHash("sha256").update(String(taskId)).digest("hex").slice(0, 32);
  const originalFileId = crypto.createHash("sha256").update(String(videoUrl)).digest("hex").slice(0, 32);
  const backgroundFileId = crypto.createHash("sha256").update(String(bgUrl)).digest("hex").slice(0, 32);
  const [maskPath, origPath, bgPath] = await Promise.all([
    fetchToLocal(maskUrl, `mtmask-${taskFileId}.mp4`),
    fetchToLocal(videoUrl, `mtorig-${originalFileId}.mp4`),
    fetchToLocal(bgUrl, `mtbg-${backgroundFileId}${/\.(mp4|mov|webm)(?:$|[?#])/i.test(bgUrl) ? ".mp4" : ".png"}`),
  ]);

  const isBgVideo = /\.(mp4|mov|webm)$/i.test(bgPath);
  const outPath = path.join(WORK_DIR, `matting-${taskFileId}.mp4`);
  const contentId = `lyx_${crypto.randomUUID()}`;
  const markedPath = path.join(WORK_DIR, `marked-matting-${taskFileId}.mp4`);

  const args = ["-y"];
  if (isBgVideo) {
    args.push("-i", bgPath);
  } else {
    args.push("-loop", "1", "-i", bgPath);
  }
  args.push(
    "-i", origPath,
    "-i", maskPath,
    "-filter_complex",
    // maskedmerge 对 yuv420p 的 mask 会按半分辨率色度插值导致「半透明鬼影」，
    // 必须统一转成平面RGB(gbrp)+灰度mask 再合成；背景拉齐原视频尺寸
    "[1:v]scale=trunc(iw/2)*2:trunc(ih/2)*2[fg0];[0:v][fg0]scale2ref[bgs][fg1];" +
    "[bgs]format=gbrp[bg];[fg1]format=gbrp[fg];[2:v]format=gray[m];" +
    "[bg][fg][m]maskedmerge,format=yuv420p[out]",
    "-map", "[out]",
    "-map", "1:a?",
    "-shortest",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20",
    "-c:a", "aac",
    outPath,
  );
  try {
    await run(FFMPEG, args, { maxBuffer: 16 * 1024 * 1024 });
    await markFile(outPath, markedPath, { kind: "video", contentId, label: "AI生成" });
    const asset = await objectStore.putFile(markedPath, {
      ownerId,
      contentType: "video/mp4",
      ext: ".mp4",
      purpose: "output/video-matting",
      metadata: mattingTraceMetadata({
        contentId,
        provider,
        providerModel,
        taskId,
      }),
      retainSeconds: Number(process.env.OUTPUT_RETENTION_SECONDS || 86_400),
    });
    return { assetId: asset.id, url: await objectStore.signedUrl(asset.id, { ownerId, base }), metadata: asset.metadata };
  } finally {
    for (const f of [maskPath, outPath, markedPath]) fs.rmSync(f, { force: true });
  }
}
