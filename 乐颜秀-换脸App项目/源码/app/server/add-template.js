/**
 * 模板入库预处理：下载模板视频 → 预计算手部遮挡 mask → 上传 OSS（私有）
 * 用法: node add-template.js <templateId> <模板视频URL>
 * 完成后把打印出的两行配置写进 .env，该模板即自动启用遮挡修复。
 *
 * 依赖：managed python（mediapipe/opencv）、模型在 REDACTED_LOCAL_USER_PATH\.leyanxiu\hand_landmarker.task
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import OSS from "ali-oss";

const run = promisify(execFile);
const [templateId, videoUrl] = process.argv.slice(2);
if (!templateId || !videoUrl) {
  console.error("用法: node add-template.js <templateId> <模板视频URL>");
  process.exit(1);
}

const WORK = process.env.REPAIR_WORK_DIR || "C:\\leyanxiu-repair";
fs.mkdirSync(WORK, { recursive: true });

const tplPath = path.join(WORK, `newtpl-${templateId}.mp4`);
const maskPath = path.join(WORK, `newmask-${templateId}.mp4`);

console.log("1/3 下载模板视频...");
const res = await fetch(videoUrl);
if (!res.ok) throw new Error(`下载失败 ${res.status}`);
fs.writeFileSync(tplPath, Buffer.from(await res.arrayBuffer()));

console.log("2/3 预计算遮挡 mask（CPU，约与视频等长）...");
await run("python", [path.join(process.cwd(), "precompute-mask.py"), tplPath, maskPath], {
  maxBuffer: 16 * 1024 * 1024,
});

console.log("3/3 上传 mask 到 OSS（私有）...");
const client = new OSS({
  accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
  accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET || "leyanxiu-face-2026",
  region: process.env.OSS_REGION || "oss-cn-shanghai",
});
const maskKey = `masks/${templateId}.mp4`;
await client.put(maskKey, maskPath);

fs.rmSync(tplPath, { force: true });
fs.rmSync(maskPath, { force: true });

const KEY = templateId.toUpperCase();
console.log(`\n✔ 完成。把这两行写进 server/.env：`);
console.log(`TPL_${KEY}_URL=${videoUrl}`);
console.log(`TPL_${KEY}_MASK=${maskKey}`);
