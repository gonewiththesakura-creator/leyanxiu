/**
 * 腾讯云 · 人像变换 ft（人脸年龄变化：减龄 / 变老）
 * 背景：阿里云没有年龄「生成」能力（只有年龄检测），
 *       此功能走腾讯 ft ChangeAgePic（API 2020-03-04，北京）。
 * 计费：按调用次数，限 20 次/秒。
 * 入参：Url 或 Image(base64) + AgeInfos（目标年龄 + 人脸框 FaceRect）
 * 返回：RspImgType=url 时为临时 URL（1 小时有效），须转存自家 OSS。
 *
 * FaceRect 获取：先用阿里 facebody DetectFace（viapi.detectFaceRect），
 * 取不到再降级本地 MediaPipe（暂略，直接报错提示用户换正脸照）。
 */
import { ft } from "tencentcloud-sdk-nodejs-ft";

let client = null;
function getClient() {
  if (client) return client;
  client = new ft.v20200304.Client({
    credential: {
      secretId: process.env.TENCENT_SECRET_ID,
      secretKey: process.env.TENCENT_SECRET_KEY,
    },
    region: "ap-beijing",
    profile: { httpProfile: { endpoint: "ft.tencentcloudapi.com" } },
  });
  return client;
}

/**
 * 人脸年龄变化（同步）
 * @param imageUrl 用户照片公开 URL
 * @param age      目标年龄（1-120）
 * @param faceRect {X,Y,Width,Height} 像素坐标人脸框（最大人脸）
 * @returns 结果临时 URL（1小时有效，调用方须转存）
 */
export async function changeAgePic({ imageUrl, age, faceRect }) {
  const r = await getClient().ChangeAgePic({
    Url: imageUrl,
    AgeInfos: [{ Age: Number(age), FaceRect: faceRect }],
    RspImgType: "url",
  });
  // 实测返回字段为 ResultUrl（RspImgType=url 时 ResultImage 为空）
  return r.ResultUrl || r.ResultImage;
}
