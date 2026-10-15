# 原生图片候选宿主本地合同（2026-10-10）

本轮只新增可注入的组合模块与离线测试。没有读取私有配置、执行云 SQL、部署、开启购买、监听端口、启动定时器或调用真实支付/图片/审核供应商。原 `index.js`、支付 server、构建白名单和部署脚本未改；不代表现网已具备图片服务。

## 调用接口

`createPhotoCandidateHost({ ledger, adapter, codec, appSecret, products, testUserIds, photoApplicationFactory, generationEnabled = false, purchaseEnabled = false, fetchImpl, alert, now })`。

依赖由未来的候选启动入口显式传入。宿主内复用现有 `createMiniIdentity`，仅在 `ledger.database` 上构造一次，并把同一对象交给 `createMiniSandboxService` 与图片认证端口。身份读取已有 `vp_auth_sessions` 和 `vp_accounts`；不迁移、不建立第二账号或权益体系。`photoApplicationFactory({ledger,authenticated,channel,generationEnabled})` 必须将这些端口交给现有 `createPhotoApplication`，其 `context.database` 必须与账本对象严格一致。此工厂是可信服务端装配代码，不是用户插件。身份可恢复与退款查询不要求当前图片同意。

宿主强制 `adapter.env === 1`、购买开关严格为 `false`，不能传 `true`。准备及 HTTP/显式调度前复查现有数据库环境行匹配 AppID/env=1；不自动绑定或修改环境。env=1 可能发生真实资金变化，闭售只禁止新购，不阻断已有订单查询、退款申请或明确调用的对账。

宿主 `generationEnabled:false` 还在图片子路由之前直接阻止上传/任务两个 POST，避免工厂误忽略开关。返回专用 `PHOTO_CANDIDATE_GENERATION_CLOSED`，不声称原键“确定未开始”；客户端保留原键，通过 GET 恢复。原任务可能在关闭前已提交，不能复用会清除客户端 pending 的 `NOT_AVAILABLE` 错误。

返回 `{app,database,identity,photo,health,prepare,runOnce,reconcileOnce,drain}`，没有 `listen`、定时器或数据库 `close`。

- `prepare()` 显式核验现有支付/身份表及环境后调用图片 `prepare()`。后者会登记已批准的效果清单，因此整个准备过程不是纯只读；不会执行 DDL 或收费调用。返回 `paymentPrepared/photoPrepared/prepared`，图片准备失败保留已验证的支付操作；整体 `prepared` 为 false。
- `runOnce({process:false,cleanup:false})` 不自动运行。图片处理还受宿主 `generationEnabled`、应用和 generation lifecycle 的 readiness 共同约束；显式清理独立于处理开关。生产装配不能用测试中的恒真 readiness；实测证据、标识运行时及内部测试账号门禁由 `generation-lifecycle` 和已批准 policy 提供。
- `reconcileOnce()` 仅供调用方显式调度、合并并发调用。它可能向微信查单、发货或提交已审批退款，不是无副作用健康检查。宿主不会自动调用它，也没有对应公开 HTTP 触发入口。
- `drain()` 立即拒绝新业务 HTTP 并停止图片 claim，等待在途 HTTP、上传 PUT/SQL 回执、图片生命周期及已经开始的支付对账。返回 `databaseClosed:false`；调用方先停止监听/调度，等待 drain 成功，最后关闭唯一数据库。排空失败返回固定错误，不把未知状态说成完成。

## 路由和状态

外层只设置安全头、环境/准备门禁和候选 health/catalog，不预读所有 body。图片应用先挂载，原支付服务后挂载；上传仍限制 2,800,100 字节 JSON/解码 2 MiB，支付流仍限制 128 KiB，同意和任务仍限制 1 KiB。旧图片/上传/视频/账号删除入口由图片应用拒绝，不载入旧 `index.js`。

`/health` 报告候选 scope、固定闭售、支付操作准备、图片准备和实际可用性；图片 `prepared:true` 不代表 `available:true`，也不代表供应商或生产上线验收通过。目录必须同时有 `photo-uploads-v1` 和 `photo-jobs-v1`。关闭图片时，已准备应用的旧上传/任务、撤回、删除和同一身份的支付记录仍可查询。

本轮原样复用的 `/api/mini/payments/products` 仍返回旧支付服务的 `ledgerOnlySandbox:true`；购买保持关闭。这不是候选图片运行时的可用性证明，未来实际开放图片之前还需明确调整该产品视图及客户端对应文案，避免支付页继续声称“图片服务未开放”。本轮没有修改既有支付协议或用此字段打开任何能力。

后续补齐了 `/api/public/compliance` 和 `/api/capabilities` 的只读关闭状态，使原生客户端 refresh 不再因缺路由失败。公开资料固定 pending，能力不伪造 verified；内部合成验收和 policy.approved 不等于正式公开事实获批。`POST /api/reports` 认证后明确 503 `REPORT_SUBMISSION_DISABLED`，不受理、不写正文或假工单；公开邮箱 fallback 仍可使用。正式协议、供应商披露和持久投诉闭环尚未完成，此模块不代替真实供应商交付、用户图片/真机验收和正式平台审核。

## 本地验收

`tests/photo-candidate-host.test.mjs` 使用真实 Hono、隔离 SQLite、现有持久微信身份/支付服务/图片应用；仅登录渠道、图片/审核/存储端口为合成替身。覆盖同一稳定用户与 bearer、注销登录后的即时失效、客户端伪造身份拒绝、请求大小隔离、闭售旧记录/退款申请/撤回、跨用户拒绝、env=0/第二数据库拒绝、缺表不迁移、readiness 不被准备成功替代、在途登录/上传/对账排空和旧入口隔离。大图片测试只是有界持久上传合同，不作为实际解码、审核或交付证明。

本地测试通过数量以本轮命令结果为准；无真实用户、资金、供应商调用和云环境变更。
