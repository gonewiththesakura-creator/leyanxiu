/**
 * 腾讯云 · 视频人脸融合大模型（备用渠道B）
 * 产品：腾讯云大模型视频创作引擎 vclm（广州）
 * 接口：SubmitVideoFaceFusionJob / DescribeVideoFaceFusionJob（API 2024-05-23）
 * 输出：右下角自带「AI生成」可见标识（LogoAdd=1）；最终合规性由独立检测报告验证
 *
 * 官方输入规范（模板选品直接沿用）：
 *  - 视频 ≤20秒、≤1G、fps≤25、mp4；脸部遮挡面积≤50%、不要完全遮挡五官
 *  - 用户照片：正脸、清晰、无遮挡，人脸框≥68px
 * 视频须先过内容审核再提交（官方要求）。
 *
 * 任务为异步：Submit 拿 JobId，Describe 轮询直到 DONE / FAIL。
 */
import { vclm } from "tencentcloud-sdk-nodejs-vclm";
import { logSecurity } from "../security-log.js";

let client = null;
function getClient() {
  if (client) return client;
  client = new vclm.v20240523.Client({
    credential: {
      secretId: process.env.TENCENT_SECRET_ID,
      secretKey: process.env.TENCENT_SECRET_KEY,
    },
    region: process.env.TENCENT_REGION || "ap-guangzhou",
    profile: { httpProfile: { endpoint: "vclm.tencentcloudapi.com" } },
  });
  return client;
}

/** 创建换脸任务，返回 { taskId, model }（taskId 即 JobId，24小时有效） */
export async function createTask({ videoUrl, userPhotoUrl }) {
  const r = await getClient().SubmitVideoFaceFusionJob({
    VideoUrl: videoUrl,
    // 模板人脸位置：不指定图片时默认取视频中最大人脸，TemplateFaceID "0"
    TemplateInfos: [{ TemplateFaceID: "0" }],
    MergeInfos: [{ TemplateFaceID: "0", MergeFaceImage: { Url: userPhotoUrl } }],
    LogoAdd: 1, // 强制带「AI生成」可见标识；不能单独视为国标合规证明
  });
  return { taskId: r.JobId, model: "SubmitVideoFaceFusionJob" };
}

/** 查询任务，返回 { status, videoUrl? } */
export async function queryTask(taskId) {
  const r = await getClient().DescribeVideoFaceFusionJob({ JobId: taskId });
  if (r.Status === "DONE") return { status: "SUCCESS", videoUrl: r.ResultVideoUrl };
  if (r.Status === "FAIL") {
    logSecurity("warn", "provider.tencent_fusion_failed", { errorCode: r.ErrorCode || null });
    return { status: "FAILED" };
  }
  return { status: "RUNNING" }; // WAIT / RUN
}
