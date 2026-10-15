# 原生图片候选宿主：最小装配设计（2026-10-10）

状态：`candidate-host.js` 和 `generation-lifecycle.js` 已实现并完成本地离线针对性测试，分别见[候选宿主合同与验收](mini-photo-candidate-host-2026-10-10.md)、[生成生命周期合同与验收](mini-photo-generation-lifecycle-2026-10-10.md)。`candidate-server.js`、候选镜像/构建包、真实配置和部署尚未完成。本地装配及结果 URL 契约修复未读取私有配置、连接云数据库、执行供应商请求、创建云资源或重试真实生成。

主线最新证据见 `../evidence/mini-photo-generation-synthetic-2026-10-10.json`：2026-10-10 11:31:06 唯一真实合成请求的渠道记录为 HTTP 200、1 图、6.74 秒，已确认供应商生成成功；本地仍未接受交付回执，没有取回生成图片。因当次未开启推理日志，当前证据无法恢复响应正文或结果 URL，具体被本地拒绝的字段也无法追溯；最终账单金额尚未核实。输入 Green 已通过，审核临时对象已观察到不存在，不代表历史版本或供应商生成副本永久删除。保留这次原记录，不自动重试。此前本地 MySQL/合成适配测试不能替代真实交付验收。

## 结论

可继续使用当前微信云托管、同一 canonical ledger 和持久微信身份，增加独立的图片候选入口。最短路径是**新的薄宿主组合现有 `createMiniSandboxService` 与 `createPhotoApplication`**，而非导入庞大的 `index.js`，也不需要新数据库、新消息队列或新云平台。

旧支付入口、构建白名单、Dockerfile 和部署脚本保持原合同。新的候选包先关闭购买、图片新提交和后台收费调用；只有本地装配验证完成后才准备单独可审查的部署变更。这个 env=1 候选不是正式 env=0 收费运营版本，env=1 也不承诺不扣真实资金。

## 已核实的装配限制

| 现有部分 | 代码事实 | 新宿主应做的最小工作 |
| --- | --- | --- |
| `payments/virtual/mini-sandbox-server.js` | 一个 runtime、identity、service；无图片 worker、排空或依赖检查 | 新入口自行装配生命周期，不直接启动/导入原入口 |
| `mini-sandbox-service.js` | 全 `/api/*` 非 GET 请求经 `readMessageJson` 限为 128 KiB | 图片路由挂在独立外层 Hono 中并先匹配；保留支付自身上限 |
| 同一 service 的身份中间件 | 只 hydrate 支付、账户和 logout 路径 | 图片 `authenticated(c)` 直接 await 同一个 identity 的 `authenticateBearer`；不相信客户端用户 ID 或云入口头 |
| `photo-jobs/upload-routes.js` | JSON 流上限 2,800,100 字节，解码图片最大 2 MiB | 不把整个服务的 JSON 限制扩大；同意和任务请求仍为 1 KiB |
| `photo-jobs/application.js` | 需要同库 generation lifecycle、源/审核/输出清理、明确效果与 readiness | 新增一个实际生命周期装配模块；不能把测试中的恒真 readiness 复制到宿主 |
| 支付包 `/health` | 固定表示 ledger-only sandbox、generation=false | 外层提供新的候选宿主 health，分开报告支付操作、图片准备、图片开放；不可沿用错误 scope |
| `build-mini-payment-sandbox.mjs` / `deploy-mini-sandbox-cloud.mjs` | 固定文件集合和 sandbox-only manifest、固定来源版本核验 | 新建候选构建方案；不能把图片文件偷偷塞进旧包或绕过旧 manifest 校验 |
| 原 Docker/package | 仅 Hono/MySQL；无 Python、Pillow、中文字体或图片模块 | 候选镜像显式增加经验证的图片依赖，旧镜像不改 |
| `/api/public/compliance`、`/api/reports` | 只存在于旧 `index.js`，投诉依赖旧 store/对象归属合同 | 候选需独立小范围装配；当前只能诚实使用已有公开客服 fallback，不能宣称投诉已入库 |

本轮做了纯内存诊断：真实 `createMiniSandboxService` 作为后挂子应用，前挂图片模拟路由能接受 200,000 字符 JSON；落入支付子应用的同尺寸请求仍返回 413；旧 health 仍显示 generation=false。3/3 检查通过，网络/SQL/文件写入为 0。此诊断只证明路由先后和 body-limit 隔离，不是新宿主已完成。

## 建议的新文件与启动合同

文件落实状态：

- `photo-jobs/candidate-host.js`：已实现可注入的 Hono 组合工厂，不读环境、不监听、不起定时器。宿主内复用现有 `createMiniIdentity` 在唯一账本数据库上构造同一身份对象，并将认证端口交给图片应用工厂。
- `photo-jobs/candidate-server.js`：尚未实现的唯一启动入口；未来解析严格候选配置，创建一个 runtime 并交给薄宿主，负责监听、显式调度和最终数据库关闭。
- `photo-jobs/generation-lifecycle.js`：已实现，复用已有 repository/pipeline/media-ports/cleanup，提供 application 需要的同库生命周期及默认关闭的 readiness。
- `deploy/mini-photo-candidate/{Dockerfile,package.json,package-lock.json,README.md}` 与独立构建脚本：尚未创建，需显式文件清单与摘要，先仅准备可审查的本地产物。

构造依赖关系：

```text
一个 virtualRuntime → 一个 ledger.database + ledger + 微信支付 adapter/codec
                         ├─ 一个 createMiniIdentity
                         ├─ createMiniSandboxService（购买关闭，支付操作合同不变）
                         └─ createPhotoApplication
                              ├─ consent / upload / task / works：同库 context
                              ├─ canonical reserveInTransaction / finishInTransaction
                              └─ generation lifecycle + 已有 OSS / Qwen / marker / Green
```

外层路由顺序固定为：安全响应头/有限错误处理 → 候选 health → 真实公开服务资料（若已准备）→ photo application → 原 sandbox service。外层不再读全部 `/api` body。图片 handler 不调用 `next()` 到支付子应用；未知路径不转发旧 `index.js`。

图片认证端口返回现有 `{ auth }` 或 `{ response: 401 }`，完全使用同一持久 bearer；支付子应用继续保留自己的 hydrate。禁用图片或撤回人脸同意不得使账号无法查支付、申请退款或恢复原任务。不可把“已有当前人脸同意”作为全局登录条件。

`runProviderFactory({context})` 必须返回：

```text
{
  database: context.database,
  runProvider({jobId,userId,spec}),
  prepare(), readiness(userId), runCleanupOnce(), drain()
}
```

其中 `runProvider` 组合现有生成 repository、pipeline 和 media-ports；输入是同意/归属/摘要核验后的私有真实 bytes，Qwen 直接使用 bytes，不签发源图公开 URL。输出使用固定私有前缀，标识后最终字节才交 Green；登记结果后仍由既有任务仓库在同一账户锁内检查支付、同意、资产期限并发布。

实际需要补的生命周期行为：

- `prepare()` 检查必需表列、配置、图片解码/标识运行环境与清理端口；不自动运行 DDL，不通过试调用收费模型证明 readiness。
- `readiness(userId)` 分离已具备的事实和操作开关。没有真实生成可确认回执时保持 false；密钥存在不等于供应商验收通过。
- application 的 `ready()` 也会不带 userId 用于目录和 worker 调度；全局检查不得误当成某账号已授权。白名单在有 userId 的提交入口及生成入场处检查，原任务查询/撤回/退款不因白名单移除被阻断。
- 默认两个独立开关 `generationEnabled=false` 与 `process=false`；只有两者明确开放且全部 gate 通过才领取上传审核/生成任务。清理开关及频率独立，不因闭售停掉已承担的清理责任。
- 仅在后续明确启动的非重叠定时循环中调用 `application.runOnce({process,cleanup})`，不公开 HTTP worker 触发入口。多实例正确性仍由数据库原子 claim/唯一意图保证，不能只靠进程变量。
- pipeline 的未知收费步骤永不自动重发。受控恢复只接受原任务/意图，读取已有回执和对象；没有生成回执时不自动补生成、不自动返次。

结果 URL 策略已经最小同步：`generation-repository.js` 与 Qwen 适配器共用 `checkedQwenPhotoResultUrl()`；新候选显式选择适配器导出的 `QWEN_PHOTO_RESULT_POLICY`（值为 `qwen-dashscope-result-url-v1`），写入 `policy.resultUrlPolicy`，且 provider/model 必须是固定 Qwen 组合。只在此版本下接受该函数校验的动态 DashScope OSS 结果地址；普通客户桶、冒充后缀、内网域名等仍拒绝，地址结构本身不证明桶归属，回执必须来自服务端固定供应商调用。

未带 `resultUrlPolicy` 的旧任务保留 `sourceHosts` 精确域名语义及原 policy 编码；新规则不能重解释旧记录或重跑旧未知任务。入库与数据库回执恢复读取都校验同一规则。小修后 generation 专项 41/41 通过，其中新增 6 项覆盖动态域名跨独立 SQLite 连接恢复、单次生成/审核/权益消耗、冒充域名、错误 provider/model、未知策略版本、旧策略不变与伪造已存回执；均为本地合成依赖，无真实请求。这证明兼容修复的离线行为，不能证明该缺陷就是首次探针拒绝的具体原因。

## 同库 DDL 与权限

继续使用已经绑定 AppID/env 的 `ledger.database`，不创建第二账户映射、订单库或权益计算。当前新增图片候选共 10 张表：

1. 已存在 canonical `vp_*` 与 `vp_auth_sessions`，只核验，不重建或清空。
2. `deploy/mini-payment/photo-jobs-schema-v1.sql`：`mini_photo_jobs` 与 pending 索引。
3. `photo-jobs/context-schema.sql`：accounts/effects/assets/works 四表。
4. `photo-jobs/upload-schema.sql`：uploads/upload_cleanup 两表。
5. `photo-jobs/generation-schema.sql`：generation/operations/cleanup 三表，按文件中顺序。

明确迁移之前需记录现有表/列/索引并备份；已有 `CREATE TABLE IF NOT EXISTS` 不会给旧表补列，pending 索引也不能盲目重复 CREATE。由有 DDL 权限的受控迁移身份执行，服务账户维持同库 CRUD。启动只检查 schema；`application.prepare()` 目前还会调用 `context.putEffect()` 写入已批准效果，故不能把整个 prepare 称作只读，效果 manifest 与批准引用必须先固定。

当前 `cloudrun_builtin_private` 是严格绑定现有 env=1、指定数据库/账户/实例的显式例外；代码明确拒绝将其用于 env=0。候选不放宽这个边界。正式收费版本须另行明确并审查生产数据库传输/支付环境政策，不能通过改一个 XPAY_ENV 把沙箱账本当成生产库，也不能在本次设计中宣称已经选定或买好新资源。

## 最小镜像与运行边界

依赖取已装配模块实际 imports：Hono、node-server、mysql2、ali-oss、阿里云 OpenAPI/Tea runtime，以及 Node 自带模块；MySQL 部署不安装仅测试使用的 SQLite 驱动。另需固定 Python/Pillow 与可渲染中文 AI 标识的字体，打包 `mark-ai.py`、`media-validation.js` 及图片模块依赖。首发不需要 FFmpeg、视频、Android 账号、旧 JSON store、管理员页面或其他供应商 SDK 的完整业务栈。

显式 allowlist 构建，不复制 `.env`、私有探针日志、历史图片、旧数据库、`node_modules` 或真实用户数据；锁文件和 manifest 摘要覆盖具体候选。原支付模块按原字节复用，不修改旧 manifest 的 scope/文件清单来容纳新功能。图片宿主不替换微信推送映射、现有服务版本或部署来源记录，部署仍属于后续独立变更。

退出顺序：先停止 HTTP 接入和定时调度，立即让 application 停止新 claim；等待在途 HTTP、迟到 PUT 回执写库、当前 generation、上传及输出清理 drain、支付 reconciliation 完成，最后关闭唯一 DB。容器强杀仍可能留下 `claimed/unknown`，重启只恢复其持久状态，不能变成新提交。

清理会有后续 HEAD/DELETE 成本与保留责任，必须给出部署频率/预算和待处理告警；一次 DELETE/404 不证明迟到 PUT、版本副本或供应商副本永不再出现。health 或客户端不能因此报告“永久删除已完成”。

## 进入真实图片验收前的最小补齐项

1. 候选宿主和 generation lifecycle 已按以上边界实现并分别通过离线针对性测试；新购、图片调用初始关闭。真实启动入口、配置、镜像及两者在未来候选包中的最终组合仍待完成。
2. 补精简的真实服务资料接口与可靠投诉/注销申请回执方案。可暂保留公开邮箱，但不能把旧内存/JSON store 接过来后声称跨实例可靠；服务信息缺失时不能伪造 approved、协议 URL、第三方清单或期限。
3. 固定同库迁移清单、候选镜像、效果/预算/保留/标识政策、关闭恢复方案；仅准备可审查产物，不在此步做云 SQL 或部署。
4. 已通过渠道只读记录确认首次生成成功，但其 URL 当前不可恢复；保留 v1 原证据与未交付状态。另一次真实合成验收必须使用独立版本、独立授权及明确次数/成本上限，不能借兼容修复自动重试旧任务。最终标识/审核/私有交付仍未完成前，图片开关保持关闭。

本地候选宿主应新增的针对性验收：真实 mini identity 登录产生的同一 userId 被图片与账本共用；图片上传 body cap 与支付 cap 隔离；env=0/误库/第二 DB/假 readiness 拒绝；闭售保留原单与原任务查询；退款/撤回后不派发或不发布；输出 PUT 丢回包重启仅读恢复；SIGTERM 不先关数据库；缺 Pillow/字体/任何 DDL 时不开图片；投诉返回未知不能当收到。已有模块单测和本机 MySQL 并发证据可复用，不需要重复模拟真实费用成功。

这份设计解决的是下一候选运行入口的复用与审查范围。首次请求已确认渠道生成成功，但未恢复结果 URL、未完成本地交付，具体本地拒绝字段仍不确定；本文件和 URL 契约修复均未改变当前线上支付或图片可用状态。
