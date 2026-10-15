/**
 * DeepSeek（深度求索）· LLM 对话（发现页各「AI 玩法」共用）
 * 接口：OpenAI 兼容 POST https://api.deepseek.com/chat/completions
 * 模型：deepseek-chat（V 系列对话模型，价格低、中文好）
 * 鉴权：Bearer API Key（platform.deepseek.com 控制台创建）
 * 上线前由公司核验当前模型备案，并在公开处理者清单填写对应备案编号。
 */

import { fetchProviderJson } from "../provider-http.js";

const BASE = "https://api.deepseek.com";

/**
 * 非流式对话
 * @param messages [{role:"system"|"user"|"assistant", content}]
 * @returns 回复文本
 */
export async function chat(messages) {
  const r = await fetchProviderJson(`${BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      messages: messages.map((m) => ({ role: m.role, content: String(m.content).slice(0, 4000) })),
      temperature: 0.8,
      max_tokens: 2000,
      stream: false,
    }),
  }, { purpose: "DeepSeek API", timeoutMs: 60_000 });
  const body = r.body;
  if (!r.ok) {
    throw new Error(`DeepSeek API错误 ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error("DeepSeek 空响应");
  return text;
}
