/**
 * viapi / tencent-ft 五个新功能真实调用验证脚本（一次性，验完即弃）
 * 用法: node test-viapi.js [enhance|colorize|idseg|age|matting|phototpl|all]
 */
import "dotenv/config";
import * as viapi from "./providers/viapi.js";
import { changeAgePic } from "./providers/tencent-ft.js";

const PHOTO = "http://leyanxiu-face-2026.oss-cn-shanghai.aliyuncs.com/test/compare/photo1.png";
const VIDEO = "http://leyanxiu-face-2026.oss-cn-shanghai.aliyuncs.com/test/compare/occlusion-street.mp4";

const which = process.argv[2] || "all";
const run = (name) => which === "all" || which === name;

async function main() {
  if (run("enhance")) {
    console.log("\n=== 1a 老照片修复 EnhanceFace ===");
    try {
      const url = await viapi.enhanceFace(PHOTO);
      console.log("OK 临时URL:", url?.slice(0, 90));
      const perm = await viapi.persistResult(url, "test/features/restore-enhance.jpg");
      console.log("已转存:", perm);
    } catch (e) { console.error("FAIL:", e.message?.slice(0, 300)); }
  }

  if (run("colorize")) {
    console.log("\n=== 1b 黑白上色 ColorizeImage ===");
    try {
      const url = await viapi.colorizeImage(PHOTO);
      console.log("OK 临时URL:", url?.slice(0, 90));
      const perm = await viapi.persistResult(url, "test/features/restore-colorize.jpg");
      console.log("已转存:", perm);
    } catch (e) { console.error("FAIL:", e.message?.slice(0, 300)); }
  }

  if (run("idseg")) {
    console.log("\n=== 3 证件照抠图 SegmentHDBody ===");
    try {
      const url = await viapi.segmentHDBody(PHOTO);
      console.log("OK 临时URL:", url?.slice(0, 90));
      const perm = await viapi.persistResult(url, "test/features/idphoto-alpha.png");
      console.log("已转存:", perm);
    } catch (e) { console.error("FAIL:", e.message?.slice(0, 300)); }
  }

  if (run("age")) {
    console.log("\n=== 5 减龄/变老：阿里 DetectFace + 腾讯 ChangeAgePic ===");
    try {
      const rect = await viapi.detectFaceRect(PHOTO);
      console.log("人脸框:", JSON.stringify(rect));
      if (rect) {
        const url = await changeAgePic({ imageUrl: PHOTO, age: 60, faceRect: rect });
        console.log("OK 临时URL:", url?.slice(0, 90));
        const perm = await viapi.persistResult(url, "test/features/age-60.jpg");
        console.log("已转存:", perm);
      }
    } catch (e) { console.error("FAIL:", e.message?.slice(0, 300)); }
  }

  if (run("matting")) {
    console.log("\n=== 4 视频抠像 SegmentVideoBody（异步，仅提交+查一次） ===");
    try {
      const { taskId } = await viapi.segmentVideoBody(VIDEO);
      console.log("taskId:", taskId);
      await new Promise((s) => setTimeout(s, 15_000));
      const r = await viapi.queryMattingTask(taskId);
      console.log("状态:", JSON.stringify(r).slice(0, 200));
      if (r.status === "SUCCESS") {
        const perm = await viapi.persistResult(r.videoUrl, "test/features/matting-test.mp4");
        console.log("已转存:", perm);
      }
    } catch (e) { console.error("FAIL:", e.message?.slice(0, 300)); }
  }

  if (run("phototpl")) {
    console.log("\n=== 2 照片模板入库 AddFaceImageTemplate + MergeImageFace ===");
    try {
      const tplId = await viapi.addImageTemplate(PHOTO);
      console.log("TemplateId:", tplId);
      const url = await viapi.mergeImageFace({ templateId: tplId, imageUrl: PHOTO });
      console.log("OK 临时URL:", url?.slice(0, 90));
      const perm = await viapi.persistResult(url, "test/features/photofusion-test.jpg");
      console.log("已转存:", perm);
    } catch (e) { console.error("FAIL:", e.message?.slice(0, 300)); }
  }
}

main().catch((e) => { console.error("脚本异常:", e); process.exit(1); });
