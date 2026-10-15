import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import * as qwenImage from "./providers/qwen-image.js";
import * as seededit from "./providers/seededit.js";

const outputDir = path.resolve("../output/photo-eval-r17");
const publicRoot = process.env.PUBLIC_TEST_URL || "https://leyanxiu-api-292172-5-1463758271.sh.run.tcloudbase.com";
const providers = new Set(process.argv.slice(2));
const shouldRun = (name) => providers.size === 0 || providers.has(name);

const cases = [
  {
    id: "natural-avatar",
    inputFile: "../public/avatars/sample-woman-openai-r2.webp",
    prompt: "基于输入照片制作自然、真实、适合社交头像的专业人像。严格保留同一个人的五官、脸型、肤色、真实年龄、发型和神态，只优化自然光线、背景洁净度和成像质感。正面构图，不磨皮过度，不改变年龄，不添加文字。",
  },
  {
    id: "old-photo-restore",
    inputFile: "../public/templates/restore-openai-r2.webp",
    prompt: "修复这张旧照片：去除划痕、折痕、污渍和偏色，降低噪点，恢复自然清晰度与真实肤色。严格保持人物身份、五官、脸型、发型、服装、姿势和背景不变，不美化成另一个人，不改变年龄，不添加文字。",
  },
  {
    id: "cheongsam",
    inputFile: "../public/avatars/sample-woman-openai-r2.webp",
    prompt: "以输入照片为唯一人物参考，严格保留同一个人的身份、五官、脸型、肤色、真实年龄和神态。制作海派旗袍复古写真，端庄得体，老上海室内光影，真实摄影质感，不添加文字。",
  },
  {
    id: "modern-comic",
    inputFile: "../public/avatars/sample-woman-openai-r2.webp",
    prompt: "以输入照片为唯一人物参考，严格保留同一个人的身份、五官、脸型、真实年龄和神态。转换为现代精致漫画肖像，线条明快、配色克制，不夸张大眼，不幼态化，不添加文字。",
  },
];

async function uploadInput(inputFile) {
  const data = await fs.readFile(path.resolve(inputFile));
  const extension = path.extname(inputFile).slice(1) || "png";
  const mime = extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`;
  const response = await fetch(`${publicRoot}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: `data:${mime};base64,${data.toString("base64")}` }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0 || !body.data?.url) {
    throw new Error(`测试图片上传失败 ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body.data.url;
}

async function saveRemote(url, filename) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}`);
  await fs.writeFile(path.join(outputDir, filename), Buffer.from(await response.arrayBuffer()));
}

async function run() {
  await fs.mkdir(outputDir, { recursive: true });
  const summary = [];
  for (const item of cases) {
    const imageUrl = await uploadInput(item.inputFile);
    const request = { imageUrl, prompt: item.prompt };
    if (shouldRun("qwen") && qwenImage.available()) {
      const startedAt = Date.now();
      try {
        const result = await qwenImage.editImage(request);
        await saveRemote(result.url, `${item.id}-qwen.png`);
        summary.push({ case: item.id, provider: result.model, ok: true, ms: Date.now() - startedAt, requestId: result.requestId });
      } catch (error) {
        summary.push({ case: item.id, provider: qwenImage.modelName(), ok: false, ms: Date.now() - startedAt, error: String(error?.message || error).slice(0, 300) });
      }
    }

    if (shouldRun("seedream") && seededit.available()) {
      const startedAt = Date.now();
      try {
        const url = await seededit.editImage(request);
        await saveRemote(url, `${item.id}-seedream.png`);
        summary.push({ case: item.id, provider: process.env.SEEDEDIT_MODEL || "seedream", ok: true, ms: Date.now() - startedAt });
      } catch (error) {
        summary.push({ case: item.id, provider: process.env.SEEDEDIT_MODEL || "seedream", ok: false, ms: Date.now() - startedAt, error: String(error?.message || error).slice(0, 300) });
      }
    }
  }
  await fs.writeFile(path.join(outputDir, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

await run();
