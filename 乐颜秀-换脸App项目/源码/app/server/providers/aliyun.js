/**
 * 阿里云 · 视频人脸融合（主渠道，已真实调通 2026-07-28）
 * 产品：视觉智能开放平台-视频生产 videoenhan（华东2上海）
 * 计费：按输出时长约1元/分钟（15秒模板 ≈ 0.25元/条）
 * 输出：左下角自动带「视频由AI生成」可见水印；最终合规性由独立检测报告验证
 *
 * 两个模式：
 *  A. 通用模式 MergeVideoFace：视频URL+用户照片URL直接换（测试/临时模板用）
 *  B. 模板模式 AddFaceVideoTemplate + MergeVideoModelFace：模板预入库，
 *     效率更高、支持多人视频选脸（正式产品用）
 * 均为异步任务：提交后拿 RequestId 作为 JobId，用 GetAsyncJobResult 轮询。
 */
import * as OpenApi from "@alicloud/openapi-client";
import * as $Util from "@alicloud/tea-util";

const clients = new Map();
function boundedTimeout(value, fallback, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= maximum ? parsed : fallback;
}

function getClient(endpoint = "videoenhan.cn-shanghai.aliyuncs.com") {
  if (clients.has(endpoint)) return clients.get(endpoint);
  const c = new OpenApi.default.default(new OpenApi.default.Config({
    accessKeyId: process.env.ALIYUN_ACCESS_KEY_ID,
    accessKeySecret: process.env.ALIYUN_ACCESS_KEY_SECRET,
    endpoint,
  }));
  clients.set(endpoint, c);
  return c;
}

/**
 * 通用 RPC 调用（视觉智能开放平台 viapi 各产品线共用一套签名方式）
 * @param endpoint 产品线域名，如 facebody.cn-shanghai.aliyuncs.com
 * @param version  API 版本，如 2019-12-30
 * @param action   接口名
 * @param query    请求参数
 */
export async function rpc(action, query, endpoint = "videoenhan.cn-shanghai.aliyuncs.com", version = "2020-03-20") {
  const params = new OpenApi.default.Params({
    action, version, protocol: "HTTPS",
    method: "POST", authType: "AK", style: "RPC",
    pathname: "/", reqBodyType: "formData", bodyType: "json",
  });
  const runtime = new $Util.default.RuntimeOptions({
    autoretry: false,
    connectTimeout: boundedTimeout(process.env.ALIYUN_CONNECT_TIMEOUT_MS, 10_000, 60_000),
    readTimeout: boundedTimeout(process.env.ALIYUN_READ_TIMEOUT_MS, 60_000, 300_000),
  });
  return (await getClient(endpoint).callApi(params, new OpenApi.default.OpenApiRequest({ query }), runtime)).body;
}

/** 模板入库（正式模板一次性执行，存下 TemplateId） */
export async function addTemplate(videoUrl, scene = "single") {
  const r = await rpc("AddFaceVideoTemplate", { VideoURL: videoUrl, VideoScene: scene });
  return r.Data?.TemplateId;
}

export function videoFusionModel({ templateId } = {}) {
  return templateId ? "MergeVideoModelFace" : "MergeVideoFace";
}

/** 创建换脸任务，返回 { taskId, model }（taskId 即 RequestId） */
export async function createTask({ templateId, videoUrl, userPhotoUrl }) {
  const model = videoFusionModel({ templateId, videoUrl });
  let r;
  if (templateId) {
    r = await rpc("MergeVideoModelFace", { TemplateId: templateId, FaceImageURL: userPhotoUrl, WatermarkType: "CN" });
  } else {
    r = await rpc("MergeVideoFace", { VideoURL: videoUrl, ReferenceURL: userPhotoUrl, WatermarkType: "CN" });
  }
  return { taskId: r.RequestId, model };
}

function readFirstString(source, keys) {
  if (!source || typeof source !== "object") return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function parseResultPayload(value) {
  if (value && typeof value === "object") return value;
  if (typeof value !== "string" || !value.trim()) return {};

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    const wrapped = new Error("阿里云任务结果 Result 不是有效 JSON", { cause: error });
    wrapped.code = "ALIYUN_RESULT_INVALID_JSON";
    throw wrapped;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    const error = new Error("阿里云任务结果 Result 不是对象");
    error.code = "ALIYUN_RESULT_INVALID_PAYLOAD";
    throw error;
  }
  return parsed;
}

/**
 * 解析 VIAPI GetAsyncJobResult 响应。
 * 官方文档中的 Data.Result 是 JSON 字符串，且视频字段使用 VideoUrl；
 * 不同产品/历史响应也会出现 VideoURL、videoUrl 或 video_url，因此统一兼容。
 * 失败状态保留供应商错误码/消息，供上层审计和用户态错误映射使用。
 */
export function parseAsyncJobResultResponse(response) {
  const data = response?.Data && typeof response.Data === "object" ? response.Data : {};
  const providerStatus = readFirstString(data, ["Status", "status"]).toUpperCase();
  const providerMessage = readFirstString(data, ["Message", "message", "ErrorMessage", "errorMessage"])
    || readFirstString(response, ["Message", "message", "ErrorMessage", "errorMessage"]);
  const providerCode = readFirstString(data, ["Code", "code", "ErrorCode", "errorCode"])
    || readFirstString(response, ["Code", "code", "ErrorCode", "errorCode"]);

  if (providerStatus === "PROCESS_SUCCESS") {
    const result = parseResultPayload(data.Result ?? data.result);
    const videoUrl = readFirstString(result, ["VideoURL", "VideoUrl", "videoUrl", "video_url"]);
    if (!videoUrl) {
      const error = new Error("阿里云任务已成功但未返回结果视频 URL");
      error.code = "ALIYUN_RESULT_VIDEO_URL_MISSING";
      error.providerStatus = providerStatus;
      throw error;
    }
    return { status: "SUCCESS", videoUrl };
  }

  if (providerStatus === "PROCESS_FAILED") {
    return {
      status: "FAILED",
      ...(providerCode ? { providerCode } : {}),
      ...(providerMessage ? { providerMessage } : {}),
    };
  }

  return { status: "RUNNING" };
}

/** 查询任务，返回 { status, videoUrl? } */
export async function queryTask(taskId) {
  const q = await rpc("GetAsyncJobResult", { JobId: taskId });
  return parseAsyncJobResultResponse(q);
}
