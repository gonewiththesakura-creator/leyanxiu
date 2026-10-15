/**
 * 阿里云万相 2.1 图片编辑。
 * 使用价格较低的 wanx2.1-imageedit，提交异步任务后轮询结果。
 */
import { fetchProviderJson } from "../provider-http.js";

const MODEL = process.env.WANX_IMAGE_MODEL || "wanx2.1-imageedit";

function apiRoot() {
  const configured = process.env.DASHSCOPE_BASE || "https://dashscope.aliyuncs.com";
  return configured.split("/api/v1/")[0].replace(/\/$/, "");
}

export function available() {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readJson(response, action) {
  if (!response.ok) {
    throw new Error(`${action} ${response.status}: ${JSON.stringify(response.body).slice(0, 500)}`);
  }
  return response.body;
}

export async function editImage({
  imageUrl,
  prompt,
  functionName = "description_edit",
  parameters = {},
  timeoutMs = 180_000,
} = {}) {
  if (!available()) throw new Error("未配置 DASHSCOPE_API_KEY");
  if (!imageUrl) throw new Error("缺少待编辑图片");

  const root = apiRoot();
  const created = await fetchProviderJson(`${root}/api/v1/services/aigc/image2image/image-synthesis`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      "Content-Type": "application/json",
      "X-DashScope-Async": "enable",
    },
    body: JSON.stringify({
      model: MODEL,
      input: {
        function: functionName,
        prompt: prompt || "自然增强照片，保持人物身份和原始构图",
        base_image_url: String(imageUrl).replace(/^http:\/\//, "https://"),
      },
      parameters: { n: 1, ...parameters },
    }),
  }, { purpose: "DashScope Wanx task creation", timeoutMs: 60_000 }).then((response) => readJson(response, "万相任务创建失败"));

  const taskId = created?.output?.task_id;
  if (!taskId) throw new Error(`万相未返回 task_id: ${JSON.stringify(created).slice(0, 500)}`);

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await wait(1600);
    const result = await fetchProviderJson(`${root}/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}` },
    }, { purpose: "DashScope Wanx task query", timeoutMs: 30_000 }).then((response) => readJson(response, "万相任务查询失败"));
    const status = result?.output?.task_status;
    if (status === "SUCCEEDED") {
      const url = result?.output?.results?.[0]?.url;
      if (!url) throw new Error(`万相成功但未返回图片: ${JSON.stringify(result).slice(0, 500)}`);
      return { url, taskId, requestId: result.request_id || null, usage: result.usage || null };
    }
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      throw new Error(`万相任务失败: ${result?.output?.message || status}`);
    }
  }
  throw new Error(`万相任务超时: ${taskId}`);
}
