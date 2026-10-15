/**
 * 三方换脸渠道对比测试脚本
 * 用途：同一条视频 + 同一张照片，分别提交到已配置密钥的渠道，
 *       轮询完成后把成片下载到本目录 compare-output/，人工对比遮挡/重影表现。
 *
 * 用法：
 *   cd server
 *   node compare-providers.js <视频URL> <照片URL> [备注名]
 * 例：
 *   node compare-providers.js https://oss.xxx/手挡脸.mp4 https://oss.xxx/自拍.jpg night-street
 *
 * 只有配了密钥的渠道会参与（.env 里有 ALIYUN / TENCENT / VOLC 对应密钥即启用）。
 * 各渠道结果 URL 有效期都短（2h~24h），脚本会自动下载存档。
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import * as aliyun from "./providers/aliyun.js";
import * as tencent from "./providers/tencent.js";
import * as volcengine from "./providers/volcengine.js";

const [videoUrl, photoUrl, tag = "test"] = process.argv.slice(2);
if (!videoUrl || !photoUrl) {
  console.error("用法: node compare-providers.js <视频URL> <照片URL> [备注名]");
  process.exit(1);
}

const channels = [];
if (process.env.ALIYUN_ACCESS_KEY_ID) channels.push(["aliyun", aliyun]);
if (process.env.TENCENT_SECRET_ID) channels.push(["tencent", tencent]);
if (process.env.VOLC_API_KEY) channels.push(["volcengine", volcengine]);

if (!channels.length) {
  console.error("没有任何已配置密钥的渠道，请先填 .env");
  process.exit(1);
}

const outDir = path.resolve("compare-output");
fs.mkdirSync(outDir, { recursive: true });

const POLL_INTERVAL = 5000;
const POLL_TIMEOUT = 5 * 60 * 1000;

async function runOne(name, provider) {
  const log = (m) => console.log(`[${name}] ${m}`);
  try {
    const { taskId } = await provider.createTask({ videoUrl, userPhotoUrl: photoUrl });
    log(`任务已提交 taskId=${taskId}`);
    const start = Date.now();
    while (Date.now() - start < POLL_TIMEOUT) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL));
      const r = await provider.queryTask(taskId);
      if (r.status === "SUCCESS") {
        log(`完成 ✔ ${r.videoUrl}`);
        const file = path.join(outDir, `${tag}-${name}.mp4`);
        const buf = Buffer.from(await (await fetch(r.videoUrl)).arrayBuffer());
        fs.writeFileSync(file, buf);
        log(`已存档 ${file}（${(buf.length / 1048576).toFixed(1)}MB）`);
        return { name, ok: true, file };
      }
      if (r.status === "FAILED") {
        log("失败 ✘（看上方错误信息）");
        return { name, ok: false };
      }
      process.stdout.write(`[${name}] 生成中...\r`);
    }
    log("超时（5分钟），任务可能仍在云端跑，可稍后用 taskId 手动查询");
    return { name, ok: false, taskId };
  } catch (e) {
    console.error(`[${name}] 出错:`, e.message);
    return { name, ok: false };
  }
}

console.log(`对比测试：${channels.map(([n]) => n).join(" / ")}`);
console.log(`视频: ${videoUrl}\n照片: ${photoUrl}\n`);

const results = await Promise.all(channels.map(([n, p]) => runOne(n, p)));

console.log("\n===== 结果汇总 =====");
for (const r of results) {
  console.log(`${r.ok ? "✔" : "✘"} ${r.name}${r.file ? " → " + r.file : ""}`);
}
console.log(`\n成片都在 ${outDir}，逐条播放到「手挡脸」时间点对比重影。`);
