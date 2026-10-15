# 微信小程序首发契约

更新：2026-10-09。当前原生微信小程序源码在 `app/miniprogram`，已有图片创作和套餐订单页面。历史 React/Vite H5 不是本次首发交付物。AppID 和云托管环境已配置；仍须把本地实现、已部署服务、真实交易、真实图片交付和微信审核发布分别验收。

已实现的原生流程及当前接口合同：

1. 调用微信登录获取临时 `code`，服务端调用 `/api/auth/wechat` 换取用户会话，不把 `appSecret` 放入客户端。
2. 图片首发只开放已经实测的单项效果。`/api/catalog` 返回 `miniProgramCreation={available,jobProtocol:'photo-jobs-v1',uploadProtocol:'photo-uploads-v1',photoEffectIds}`，并与公开说明、实际能力、账本用途和服务端冻结效果一致。任何一项缺失均不开放制作；旧同步服务不能添加字段就冒充异步接通。
3. 相册选图前由微信确认隐私指引；照片仅在当前页内存预览。点击制作时分别记录当前版本的基础同意和人脸处理授权：`POST /api/consents`。客户端在 `POST /api/mini/photo-uploads {image:dataURL}` 前保存账号专属上传键与独立生成键；上传返回持久记录，只有后台审核 `ready` 才返回输入 `assetId`。staging 不表示字节已保存，queued 不表示已审核。丢响应通过原上传 ID 或 `/by-key/:key` 查询，查无记录也不重传。素材归属、审核凭证及私有字节由服务端校验，客户端不能声明审核通过。
4. `POST /api/mini/photo-jobs {inputAssetId,effectId}` 携带 32 位小写十六进制 `Idempotency-Key`。新任务返回 `202 {code:0,data:{job,duplicate:false}}`；已接受的同键同输入请求恢复原任务，返回 200。提交请求内不执行生成；同库原子预占一次权益并记录任务。
5. 按用户查询 `GET /api/mini/photo-jobs/:id`，丢失提交响应时通过 `/api/mini/photo-jobs/by-key/:key` 找回。页面仅在前台有限轮询；重进、刷新不会再次生成。不存在、断网、通用 503 或未知状态不代表没有扣次，也不解除原制作记录。
6. 只有 `succeeded` 才返回输出 `assetId`，再请求 `/api/assets/:id/url` 获取本人短时链接。响应素材 ID 必须匹配原任务。作品记录与权益核销在同一事务提交；不根据客户端成功提示发货或加减余额。
7. 已实现作品查询、相册保存、`DELETE /api/assets/:id` 和 `/api/consents/face_processing/withdraw` 的客户端处理；待删除的供应商副本明确显示部分完成。原生服务页可显示、复制公开客服邮箱并提交投诉或注销申请；注销申请不是删除完成，不调用未接新上下文的旧 `/api/account`。

`photo-jobs/routes.js` 已通过真实仓库、共享账本的本地 HTTP 集成测试；`photo-jobs/context.js` 已提供同库同意、对象元数据与作品端口。**目前没有把这套创作上下文装入线上支付沙箱，也没有接通真实图片审核、私有字节清理及真实模型验收。** 原生制作开关继续关闭。当前线上支付版本 `buildtest-013` 为 env=1，购买已关闭。

2026-10-09 已完成 Android env=1 的 9.90 元实际购买、发货和全额原路退款，用户确认到账；不据此声称 env=0、iOS 或图片成品交付已验收。记录见 `mini-payment-acceptance-2026-10-09.md`。

正式上线复用已有主体、AppID、云托管和数据库，核实真实备案/类目/隐私及虚拟支付状态。云调用和下载域名要求分别核对，不要求 Android 签名包，也不把购买新 TLS 数据库列为必经步骤。图片真实闭环、env=0 隔离装配与正式商品、平台资料、提审发布的剩余事项见 `mini-launch-readiness-2026-10-09.md`。
