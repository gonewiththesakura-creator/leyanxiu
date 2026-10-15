/**
 * 火山方舟 · 豆包图像编辑（Seedream / SeedEdit，生成式）
 * 鉴权：方舟控制台「API Key 管理」创建的 API Key（不是火山引擎 AK/SK）
 * 接口：POST /api/v3/images/generations（同步返回结果图 URL，需及时转存）
 *
 * 用于：漫画脸多风格、照片换背景（指令式重绘，人物与场景光影自然融合）。
 * 上线前仍须核验当前模型备案、商用条款和处理者披露材料。
 */
import { fetchProviderJson } from "../provider-http.js";

const BASE = process.env.ARK_BASE || "https://ark.cn-beijing.volces.com/api/v3";
const MODEL = process.env.SEEDEDIT_MODEL || "doubao-seedream-4-0-250828";
const SIZE = process.env.SEEDEDIT_SIZE || "2k";

export function available() {
  return !!process.env.ARK_API_KEY;
}

/** 指令式图像编辑，返回临时图片 URL（24h 有效，调用方须转存） */
export async function editImage({ imageUrl, prompt }) {
  const httpsUrl = String(imageUrl).replace(/^http:\/\//, "https://");
  const response = await fetchProviderJson(`${BASE}/images/generations`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.ARK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      image: httpsUrl,
      response_format: "url",
      size: SIZE,
      watermark: true,
    }),
  }, { purpose: "Volcengine Ark Image API", timeoutMs: 120_000 });
  const body = response.body;
  if (!response.ok) {
    throw new Error(`方舟图像编辑错误 ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const url = body?.data?.[0]?.url;
  if (!url) throw new Error(`方舟返回异常: ${JSON.stringify(body).slice(0, 300)}`);
  return url;
}
