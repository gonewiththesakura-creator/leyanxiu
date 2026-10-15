/**
 * 腾讯云 · 混元大模型 hunyuan（LLM 对话，发现页各「AI 玩法」共用）
 * 模型：hunyuan-lite（免费档），适合祝福语/文案/养生/起名等轻量场景。
 * 入参：scene 对应的 system 提示词在 index.js 侧维护（防篡改），这里只做转发。
 */
import { hunyuan } from "tencentcloud-sdk-nodejs-hunyuan";

let client = null;
function getClient() {
  if (client) return client;
  client = new hunyuan.v20230901.Client({
    credential: {
      secretId: process.env.TENCENT_SECRET_ID,
      secretKey: process.env.TENCENT_SECRET_KEY,
    },
    region: "ap-beijing",
    profile: { httpProfile: { endpoint: "hunyuan.tencentcloudapi.com" } },
  });
  return client;
}

/**
 * 非流式对话
 * @param messages [{role:"system"|"user"|"assistant", content}]
 * @returns 回复文本
 */
export async function chat(messages) {
  const r = await getClient().ChatCompletions({
    Model: "hunyuan-lite",
    Messages: messages.map((m) => ({ Role: m.role, Content: String(m.content).slice(0, 4000) })),
    Stream: false,
    Temperature: 0.8,
  });
  const choice = r?.Choices?.[0];
  const text = choice?.Message?.Content;
  if (!text) throw new Error(r?.ErrorMsg || "LLM 空响应");
  return text;
}
