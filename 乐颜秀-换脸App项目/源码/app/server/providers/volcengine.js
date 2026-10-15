/**
 * 火山引擎（字节）· AI MediaKit 视频人脸融合（备用渠道C）
 * 产品：AI MediaKit - face-swap-video（华北2北京）
 * 鉴权：Bearer API Key（控制台「API Key 管理」创建）
 * 接口：POST /api/v1/tools/face-swap-video 提交，GET /api/v1/tasks/{id} 轮询
 *
 * 官方输入规范：
 *  - 视频：mp4、≤1080P、≤10分钟；仅支持单人换脸（多人视频取最大人脸）
 *  - 照片：JPEG/PNG，256~1080px，清晰无遮挡正脸
 *  - 结果 URL 有效期 24 小时，拿到后须立即转存
 *
 * 注意：竞品「无重影」效果大概率出自字节系管线，遮挡对比测试重点看这家。
 */
import { logSecurity } from "../security-log.js";
import { fetchProviderJson } from "../provider-http.js";

const BASE = "https://mediakit.cn-beijing.volces.com";

async function req(path, options = {}) {
  const r = await fetchProviderJson(BASE + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.VOLC_API_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }, { purpose: "Volcengine MediaKit API", timeoutMs: 60_000 });
  const body = r.body;
  if (!r.ok || body.success === false) {
    throw new Error(`火山引擎API错误 ${r.status}: ${JSON.stringify(body).slice(0, 300)}`);
  }
  return body;
}

/** 创建换脸任务，返回 { taskId, model } */
export async function createTask({ videoUrl, userPhotoUrl }) {
  const body = await req("/api/v1/tools/face-swap-video", {
    method: "POST",
    body: JSON.stringify({
      video_url: videoUrl,
      face_mappings: [{ target_face_url: userPhotoUrl }],
    }),
  });
  return { taskId: body.task_id, model: "face-swap-video" };
}

/** 查询任务，返回 { status, videoUrl? } */
export async function queryTask(taskId) {
  const body = await req(`/api/v1/tasks/${encodeURIComponent(taskId)}`);
  if (body.status === "completed") {
    return { status: "SUCCESS", videoUrl: body.result?.video_url };
  }
  if (body.status === "failed" || body.status === "canceled") {
    logSecurity("warn", "provider.volcengine_fusion_failed", { status: body.status, errorCode: body.error?.code || body.code || null });
    return { status: "FAILED" };
  }
  return { status: "RUNNING" };
}
