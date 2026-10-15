/**
 * 阿里云百炼 · Model Studio / DashScope（生成式图像，换脸主渠道迁移目标）
 *
 * 背景（2026-08-13）：原换脸走 viapi（视觉智能开放平台）MergeImageFace/MergeVideoFace，
 * 阿里客服反馈 viapi 产品线开不了技术服务合作协议，需切到「百炼」产品线。
 * 百炼鉴权用 API Key（sk-xxx，Bearer），与 viapi 的 RAM AK/SK 完全不同。
 *
 * 能力映射：
 *  - 照片换脸（模板合照）→ qwen-image-edit 多图融合：图1=用户照片，图2=模板合照，
 *    提示词令模型把图2的人脸换成图1，生成式重绘（观感更像 AI 写真，非严格五官贴合）。
 *  - 文生图 / AI 写真        → qwen-image / qwen-image-edit 文生图。
 *  - 动漫化 / 换背景         → qwen-image-edit 指令式编辑（对应 viapi 的 GenerateHumanAnimeStyle 等）。
 *
 * 端点（华北2 北京）：
 *  - 通用：POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
 *  - 业务空间专属（推荐，更稳）：POST https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/...
 * 鉴权头：Authorization: Bearer $DASHSCOPE_API_KEY
 *
 * 结果：返回 dashscope-result 的 OSS 临时 URL（带 Expires，有时效），调用方须立刻转存自家 OSS。
 */
import { fetchProviderJson } from "../provider-http.js";

const BASE = process.env.DASHSCOPE_BASE
  || "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const MODEL = process.env.BAILIAN_MODEL || "qwen-image-2.0-pro";

export function available() {
  return !!process.env.DASHSCOPE_API_KEY;
}

/**
 * 多模态图像生成/编辑（同步）。images 为公开 URL 或 data:base64 数组；text 为指令。
 * @param {string[]} images 输入图（URL 或 data:image/...;base64,...），换脸时 [用户照片, 模板]
 * @param {string} text     提示词指令
 * @param {object} opts     { model, size, n } 覆盖默认
 * @returns {{url:string, requestId:string, usage:object}} 结果图临时 URL + request_id + usage
 */
export async function generate({ images = [], text, model = MODEL, size, n = 1 } = {}) {
  const content = [
    ...images.map((img) => ({ image: String(img).replace(/^http:\/\//, "https://") })),
  ];
  if (text) content.push({ text });

  const payload = { model, input: { messages: [{ role: "user", content }] } };
  if (size) payload.parameters = { size };
  if (n > 1) payload.parameters = { ...(payload.parameters || {}), n };

  const response = await fetchProviderJson(BASE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  }, { purpose: "DashScope Bailian API", timeoutMs: 180_000 });
  const body = response.body;
  if (!response.ok) {
    throw new Error(`百炼图像生成错误 ${response.status}: ${JSON.stringify(body).slice(0, 400)}`);
  }

  const choice = body?.output?.choices?.[0];
  const img = choice?.message?.content?.find((c) => c.image)?.image;
  if (!img) throw new Error(`百炼返回异常: ${JSON.stringify(body).slice(0, 400)}`);
  return {
    url: img,
    requestId: body.request_id || body.requestId || null,
    usage: body.usage || null,
  };
}

/**
 * 照片换脸（模板合照）。userPhoto=用户正脸照，template=模板合照。
 * 提示词固定为「替换人脸，保持构图/姿态/服装/背景不变」的生成式换脸指令。
 */
export async function faceSwap({ userPhoto, template, model = MODEL }) {
  return generate({
    images: [userPhoto, template],
    text: "把第二张照片中的人物脸部替换成第一张照片中人物的脸，五官、脸型、肤色严格取自第一张，"
      + "保持第二张照片的整体构图、人物姿态、服装、发型、背景和光线完全不变，"
      + "融合自然、无拼接痕迹，像同一个人拍摄的合影，高清写实。",
    model,
  });
}

/** 指令式图像编辑（动漫化/换背景/风格迁移等），单图 + 提示词 */
export async function editImage({ imageUrl, prompt, model = MODEL }) {
  return generate({ images: [imageUrl], text: prompt, model });
}
