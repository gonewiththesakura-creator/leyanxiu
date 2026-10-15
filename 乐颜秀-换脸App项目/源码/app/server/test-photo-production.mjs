import fs from "node:fs/promises";
import path from "node:path";

const publicRoot = process.env.PUBLIC_TEST_URL || "https://leyanxiu-api-292172-5-1463758271.sh.run.tcloudbase.com";
const outputDir = path.resolve("../output/photo-production-r18");
const portraitInput = path.resolve("../public/avatars/sample-woman-openai-r2.webp");
const restoreInput = path.resolve("../output/photo-production-r18/input-restore.jpg");
const grayscaleInput = path.resolve("../output/photo-production-r18/input-gray.jpg");
const generativeIds = [
  "hong-kong-90s",
  "vintage-80s",
  "classic-black-white",
  "song-portrait",
  "dunhuang",
  "new-chinese",
  "gentle-watercolor",
  "classic-oil",
  "pencil-sketch",
];
const dedicatedCases = [
  { effectId: "face-enhance", inputFile: restoreInput },
  { effectId: "natural-color", inputFile: grayscaleInput },
  { effectId: "super-resolution", inputFile: portraitInput },
];

async function uploadInput(inputFile = portraitInput) {
  const source = await fs.readFile(inputFile);
  const extension = path.extname(inputFile).toLowerCase();
  const mime = extension === ".webp" ? "image/webp" : extension === ".png" ? "image/png" : "image/jpeg";
  const response = await fetch(`${publicRoot}/api/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: `data:${mime};base64,${source.toString("base64")}` }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code !== 0 || !body.data?.url) throw new Error(`上传失败: ${JSON.stringify(body)}`);
  return body.data.url;
}

async function runAge(imageUrl, age = 70) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${publicRoot}/api/photo/age`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl, age }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0 || !body.data?.url) throw new Error(body.message || JSON.stringify(body));
    await saveRemote(body.data.url, `age-${age}`);
    return { effectId: `age-${age}`, ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    return { effectId: `age-${age}`, ok: false, ms: Date.now() - startedAt, error: String(error?.message || error).slice(0, 300) };
  }
}

async function saveRemote(url, id) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`下载失败 ${response.status}`);
  await fs.writeFile(path.join(outputDir, `${id}.png`), Buffer.from(await response.arrayBuffer()));
}

async function runEffect(imageUrl, effectId) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${publicRoot}/api/photo/effect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ imageUrl, effectId }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.code !== 0 || !body.data?.url) throw new Error(body.message || JSON.stringify(body));
    await saveRemote(body.data.url, effectId);
    return { effectId, ok: true, ms: Date.now() - startedAt, provider: body.data.provider };
  } catch (error) {
    return { effectId, ok: false, ms: Date.now() - startedAt, error: String(error?.message || error).slice(0, 300) };
  }
}

await fs.mkdir(outputDir, { recursive: true });
const summary = [];
const isDedicated = process.argv.includes("--dedicated");
if (isDedicated) {
  for (const item of dedicatedCases) {
    const imageUrl = await uploadInput(item.inputFile);
    summary.push(await runEffect(imageUrl, item.effectId));
  }
  const portraitUrl = await uploadInput(portraitInput);
  summary.push(await runAge(portraitUrl));
} else {
  const imageUrl = await uploadInput();
  for (const effectId of generativeIds) summary.push(await runEffect(imageUrl, effectId));
}
await fs.writeFile(path.join(outputDir, isDedicated ? "dedicated-summary.json" : "generative-summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
