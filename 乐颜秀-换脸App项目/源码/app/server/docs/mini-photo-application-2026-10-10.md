# 原生小程序图片模块装配（2026-10-10）

## 用途

`photo-jobs/application.js` 是一个显式依赖注入组合器，用于把同一个微信原生渠道的登录身份、虚拟支付账本、图片上传审核、图片制作任务、私有作品访问和清理端口组合到同一进程。它不读取环境变量，不迁移数据库，不启动定时器，不自动调用供应商，也不改变已部署的闭售服务。

## 装配顺序

宿主必须先在同一个 `ledger.database` 上显式执行既有 `photoContextSchema`、`photoJobsSchema`、`photoUploadSchema`、`photoUploadCleanupSchema` 和 `photoGenerationSchema`（生成、步骤日志、生成清理三表），然后构造 `createPhotoApplication({ channel: 'wechat-mini-program', ledger, authenticated, policy, approvedEffects, uploadStorage, moderator, mediaUrl, readiness, ... })`。

`prepare()` 只读核验这些表和字段，并调用生成生命周期的 `prepare()`，明确返回 `{ prepared: true }` 后才把上层提供的、带 `approved: true`、`reviewReference`、固定 provider/model/parameters 的效果写入 `mini_photo_effects`。没有批准清单、表结构、私有存储、审核端口或上传及生成清理端口时，目录保持不可用。`generationEnabled: true` 仍必须同时通过宿主 `readiness` 和生成生命周期 `readiness`；prepare 成功不自动打开制作。它不把本地 fixture、供应商凭据或审核响应变成合规证明。

`mount(app)` 只挂原生图片路由和两个协议：`photo-uploads-v1`、`photo-jobs-v1`。原生目录不会打开支付销售；现有支付产品、订单、查询和退款路由仍由宿主单独管理。模块对旧 `/api/photo/*` 已有制作入口、`/api/fusion`、`/api/video/matting`、`/api/upload`、`/api/upload/video`、旧审核和文字供应商入口，以及 `DELETE /api/account` 返回受控拒绝，防止绕过新上下文。测试从实际 index 路由声明提取这些入口并验证旧处理函数没有执行。宿主实际挂载时必须把该组合器路由放在旧同名路由之前。

## 调度边界

`runOnce({ process: true })` 才会串行执行一轮上传审核和任务发布，`runOnce({ cleanup: true })` 才会各执行一轮上传及生成清理；清理不要求新增制作门禁仍开放。构造和 `prepare` 不会启动后台工作。宿主须先停止接收新 HTTP，再调用 `drain()`；它停止新上传/制作受理和后台领取，等待已接收的工作和上传端口完成，再排空生成生命周期，但不关闭宿主共享数据库。已存在请求的查询和隐私撤回路由本身仍可调用，因此不可用 drain 代替宿主 HTTP 停机。数据库关闭必须由宿主在 drain 完成后负责。

生成流水线通过 `runProviderFactory({ context })` 注入，避免第二个 context 或第二本权益账本。开启制作时 factory 必须同步返回完整对象：

```js
{
  database: context.database,
  runProvider: pipeline.runProvider,
  prepare: async () => ({ prepared: true }), // 上层依赖检查；不得在此自动迁移
  readiness: async userId => ({ ready: /* 真实运行条件 */ false }),
  runCleanupOnce: () => generationCleanup.runOnce(),
  drain: () => generationCleanup.drain()
}
```

`pipeline` 可直接复用 `createPhotoGenerationRepository`、`createPhotoGenerationPipeline` 及 `createPhotoMediaPorts`；`generationCleanup` 复用 `createPhotoGenerationCleanupRepository` 和 `createPhotoGenerationCleanupWorker`。media ports 通过 context 在读取原图前后检查资产归属、实际 input 类型、当前同意版本和有效期；按私有对象键读字节及实际 SHA/长度/类型，不给原图签发 URL。输出统一 `private/photo-outputs/<32hex>.png`，审核绑定完成标识后的实际字节；下载 URL 在 native routes 鉴权后才签发且最长 60 秒。

构造完成仅代表端口齐全。本地测试不能证明真实供应商、真实对象存储权限、审核政策或微信平台审批已完成；本文件也不宣称已修改云端、生产数据库或发布服务。

## 本地验收

`tests/photo-application.test.mjs` 使用真实 Hono、SQLite、同一 ledger database 和原生客户端合同，覆盖渠道隔离、默认关闭制作、显式迁移门禁、批准效果冻结、双协议、同库上传/任务/权益、旧入口拒绝、并发 runOnce、延迟上传确认、drain 和持久清理观察。另串接实际 generation pipeline、media ports、Qwen adapter、Pillow stdio 标识、Green adapter、输入/输出 OSS adapter；只替换网络/OSS SDK，使用本地合成 512×512 PNG。验收最终 XMP 的任务编号与业务提供者、最终审核 SHA、私有下载授权、一次消费、删除后的受控清理，以及供应商已接收但回复丢失时不重复 POST。`tests/photo-media-ports.test.mjs` 独立验证读取期间撤回、资产类型和字节证据、不可变快照与端口边界。两文件合计 26/26 通过；没有云端、支付或供应商请求。
