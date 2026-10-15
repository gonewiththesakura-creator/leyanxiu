/**
 * Alibaba Model Studio Qwen Image 3.0 instruction-based image editing.
 * This replaces the legacy Wanx 2.1 description-edit path for generative effects.
 */
import { fetchProviderJson } from "../provider-http.js";

const MODEL = process.env.PHOTO_EDIT_MODEL || "qwen-image-3.0-pro";

function apiBase() {
  const configured = process.env.DASHSCOPE_BASE || "https://dashscope.aliyuncs.com";
  const normalized = configured.split("/api/v1/")[0].split("/compatible-mode/v1")[0];
  const url = new URL(normalized);
  const path = url.pathname
    .replace(/\/compatible-mode\/v1\/?$/, "")
    .replace(/\/api\/v1\/?$/, "")
    .replace(/\/$/, "");
  return `${url.origin}${path}/api/v1`;
}

export function available() {
  return Boolean(process.env.DASHSCOPE_API_KEY);
}

export function modelName() {
  return MODEL;
}

export async function editImage({ imageUrl, prompt, timeoutMs = 180_000 } = {}) {
  if (!available()) throw new Error("未配置 DASHSCOPE_API_KEY");
  if (!imageUrl) throw new Error("缺少待编辑图片");

  const response = await fetchProviderJson(`${apiBase()}/services/aigc/multimodal-generation/generation`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      input: {
        messages: [{
          role: "user",
          content: [
            { image: String(imageUrl).replace(/^http:\/\//, "https://") },
            { text: prompt || "自然增强照片，严格保持人物身份、年龄和原始构图" },
          ],
        }],
      },
      parameters: {
        n: 1,
        prompt_extend: true,
        negative_prompt: "身份变化，脸型变化，年龄变化，性别变化，多余人物，多余手指，五官畸形，模糊，文字，标志，边框",
        watermark: true,
      },
    }),
  }, { purpose: "DashScope Qwen Image API", timeoutMs });
  const body = response.body;
  if (!response.ok) {
    throw new Error(`千问图片编辑错误 ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  }

  const content = body?.output?.choices?.[0]?.message?.content || [];
  const url = content.find((item) => item?.image)?.image;
  if (!url) throw new Error(`千问图片编辑未返回图片: ${JSON.stringify(body).slice(0, 500)}`);
  return {
    url,
    model: MODEL,
    requestId: body.request_id || null,
    usage: body.usage || null,
  };
}
