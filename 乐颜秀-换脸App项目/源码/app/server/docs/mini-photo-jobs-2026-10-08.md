# 小程序首发图片服务：持久异步任务基础

更新日期：2026-10-09。任务仓库和 worker 现已补齐 `photo-jobs/context.js` 的同库授权、私有对象元数据和作品事务端口，复用虚拟支付账本的 `reserveInTransaction` / `finishInTransaction`，没有第二本权益账。该模块的测试为本地隔离验证，没有执行云端 SQL、真实图片或供应商请求。HTTP / 原生客户端装配与云端部署状态由主线执行记录单独报告。

导入模块不会建表、起定时器或消费任务。候选 SQL 为 `deploy/mini-payment/photo-jobs-schema-v1.sql` 和 `photo-jobs/context-schema.sql`；后者也可由 `photoContextSchema('mysql')` 获取，两份表达的一致性有本地测试，均须显式审核迁移。

## 已核对的现有缺口

本轮开始时，`miniprogram/creation.js` 仍等待同步 `/api/photo/effect`；现在已改成快速提交持久任务和查询恢复。后端旧 `prepareGeneration` 能建立计费引用，但未冻结幂等键对应的输入、效果与供应商请求；`tasks-store.js` 为整本 file/OSS 快照，不能做跨实例原子领取。`index.js` 的旧 generative 分支允许供应商异常后换供应商，不能直接复用为新任务的未知结果恢复策略。新路由及上下文仍须与真实媒体端口同源装配，尚未部署。

## 任务约定

仓库 `photo-jobs/repository.js` 复用现有 `transaction(query)` 数据库适配器，不另购队列。用户和幂等键唯一，用户和账单引用也唯一。输入对象 ID、效果 ID 和版本、完整服务端效果参数、用途、供应商、模型、账单引用组成规范化快照及 SHA-256；相同键不同快照拒绝。读任务只返回归属用户的任务状态，成功后才返回输出对象 ID，不暴露供应商 URL、领取凭据、原始输入或内部账单引用。

状态为 `queued → claimed → result_ready → succeeded`。领取先持久提交，再向供应商请求；一次任务最多领取一次。数据库只接受 `attempt` 0 或 1，没有过期租约、自动重派或供应商 fallback。领取后进程退出、网络超时、结果写入不确定时，保留 `claimed` 或 `unknown`，不会擅自返次。查状态不调用供应商。已持久化 `result_ready` 的任务可以只恢复发布事务，不重复生成。

仓库需要四个强制注入的事务端口，均须返回 `true` 确认成功。`createPhotoJobContext` 已提供以下具体实现；通用仓库仍允许隔离测试注入端口：

| 端口 | 必须兑现的合同 |
|---|---|
| authorize | 在当前同一事务内读并锁定账号有效状态、最新同意/授权、输入归属/保存期及冻结效果可用性；提交、派发、发布三阶段复核。发布时还须核验输出审核/AI 标识和归属。 |
| reserve | 在同一事务内预占一次权益，绑定用户、用途和账单引用；任务 INSERT 失败预占也回滚。 |
| settle | `succeeded` 确认消耗；`not_started` 只用于尚未领取/调用供应商的取消，安全释放预占。未知、已处理但撤回授权的任务不自动返次。 |
| publish | 在同一事务内将持久且私有的输出对象登记为该用户作品；失败连同计费与任务状态回滚。 |

以上端口仅使用传入的 query，不得做 HTTP/供应商调用，也不得调用另开事务的账本 public API。现有 MySQL 适配器会重试明确回滚的死锁，端口因此必须限于可回滚的数据库工作。`context` 强制使用 `ledger.database`，预占与完成调用同一账本的事务方法。派发和发布还在账号锁下检查预占记录、来源次数桶和原支付订单仍有效，阻止渠道强制退款后继续生成或发布。原有文件/OSS JSON 合规和对象索引仍不能冒充这套同库元数据，装配时必须明确采用哪个数据源。

`mini_photo_accounts` 记录账号停用、当前同意版本和撤回代数；`mini_photo_effects` 冻结审核版本、单供应商/模型/参数；`mini_photo_assets` 记录私有对象 key、归属、摘要、期限、审核和 AI 标识凭证；`mini_photo_works` 仅在发布事务写入。授权、撤回、删除都先锁同一 `vp_accounts` 用户。撤回提高代数并立即令旧素材不可读取；再次同意不会让旧输入或作品复活。关键同意/撤回/删除动作写入既有 `vp_audit`。

`photo-jobs/worker.js` 的 runProvider 接收冻结快照，必须选择该单一供应商/模型，并只提交一次；输入链接在执行时按用户对象生成。输出先存私有持久对象，完成内容审核与 AI 标识后返回 assetId（及可选 providerRef）；不得先在作品列表或公网发布。结果字段在验证前同步读取一次并冻结局部值，后续调用方突变或 getter 变化不能绕过校验。

`drain()` 停止发出新领取请求并等待在途任务，同时返回持久状态计数。若在等待已保存结果的发布恢复时开始排空，恢复完成后不得再发领取请求。排空前已经发出的领取请求计入在途：即使其响应在排空后才返回，仍完成该任务唯一一次供应商调用、结果记录和发布，并由 drain 等待收尾；不能丢弃已持久领取的任务或把它重新入队。容器被强杀后保留领取状态供核查，不能因此假定供应商没收费。

## 接入与验收界限

接入顺序：按下述接口装配同一 MySQL 与现有供应商/私有字节存储；审核备份及候选迁移；POST 提交快速返回任务号，并提供以用户幂等键查回的入口；小程序持久记录任务并只轮询归属状态；将 worker 与服务部署排空绑定；最后在明确首发效果、真实材料授权、成本限制下进行受控供应商验收。`claimed/unknown/blocked` 仍需要带证据的人工核对和账单处理工作流，当前模块没有“超时重试并返次”捷径。安全自动返次只发生在没有派发的取消；沿用原账本规则，若原付费次数桶已过期，产生原规则的七天补偿；若渠道已退款，不恢复权益。

## 同库装配接口

`createPhotoJobContext({ ledger, policy: { basicVersion, faceVersion, labelVersion, sourceRetentionMs?, resultRetentionMs? }, now? })` 返回 `repository`、事务 `ports`、`database` 以及以下服务端方法。版本和保留期取真实、已公开的当前规则，不能为了让测试通过而填示例审核状态。

| 方法 | 合同 |
|---|---|
| `grantBasicConsent(userId, version)` / `grantFaceConsent(userId, { version, subjectAuthorization })` | 必须由真实用户分别确认后调用；面部授权仅接受 `self` / `authorized`，拒绝陈旧版本。 |
| `readConsents(userId)` | 返回 `current.basic/face_processing` 和当前两项授权布尔值。 |
| `withdrawFaceConsent(userId)` / `disableAccount(userId)` | 立即在数据库内禁止旧对象读取和后续发布；不宣称 OSS 或供应商副本已物理删除。 |
| `putEffect({id,version,provider,model,purpose,parameters,enabled,reviewReference})` | 仅服务端管理入口；同一版本内容不可改写，`purpose` 必须等于 `photo-effect:<id>`，启用新版本会禁用该效果其他版本。 |
| `submission({userId,idempotencyKey,inputAssetId,effectId})` | 先按用户和旧键恢复冻结 spec；旧键换输入/效果会拒绝。不存在键时从服务端启用效果生成 spec 和稳定账单引用，然后交 `repository.submit`。 |
| `repository.submit(spec)` | 返回 `{job,duplicate}`；重复不预占、不调用模型。任务公共字段为 `{id,state,createdAt,updatedAt,assetId?}`，仅成功状态包含 assetId。 |
| `repository.findOwnedByKey(userId,key)` / `readOwned(userId,id)` | 归属任务或 null，不调用供应商。即使效果更新/禁用、同意撤回，原键也可恢复原任务状态；不代表原作品仍可访问。 |
| `registerInput(userId,asset)` / `registerOutput(userId,jobId,asset)` | 服务端确认私有字节、审核和标识后登记。输出必须属于已领取任务，且当前授权仍有效；先暂存，不能提前加入作品列表。 |
| `readOwnedAsset(userId,assetId)` | 内部返回归属元数据、storageKey、sha256，只有当前有效的输入或已发布作品可见；路由应将 key 换成短时链接，禁止把内部对象直接 JSON 发给客户端。 |
| `listWorks(userId)` | 返回当前授权下尚未过期的已发布作品元数据，不含私有 key。 |
| `deleteAsset(userId,assetId)` | 同库立即失效，内部返回待物理删除的 key；未知/他人对象返回 null。 |

素材登记 `asset` 为 `{id,storageKey,sha256,byteLength,contentType,expiresAt,moderation:{decision:'allow',reference},labelVersion?}`。`storageKey` 必须是私有相对 key，不接受 URL、路径穿越；输入上限 2 MB，输出上限 20 MB。输出另须匹配当前 `labelVersion`。这些审核字段是可信服务端审核器的结果，不能让客户端声明通过。当前本地测试使用合成元数据，未证明真实图像内容审核或标识质量。

私有字节上传与元数据事务之间仍可能出现孤立对象，装配层需可追踪清理；撤回/删除后的短时签名 URL 和供应商副本清理也要独立验收。`readOwnedAsset` 只在数据库读取时验证当前授权，并不能撤销已经发出的存储签名 URL。现有供应商适配可复用，但必须核对运行模型等于冻结模型，不复用自动 fallback。现有 `persistGenerationOutput` 同时写旧对象索引和结算，不能原样作为新 worker 的暂存端口。

本地测试包括临时 SQLite 文件的通用仓库端口，以及真实 `context` + 既有虚拟支付账本事务方法。六个独立 worker 线程各开一个数据库连接，同时提交相同键并争抢领取/发布，最终仅一个预占、一次假供应商调用、一件作品和一次消耗。SQLite 本身不能证明 MySQL 跨连接锁行为；下述便携 MySQL 验证单独补齐这一点。实际供应商交付质量、微信接口时限、云端迁移/备份恢复与最终客户端流程仍须单独验收。

交叉审查发现并修复两处异步边界问题：等待发布恢复期间启动排空后仍领取新任务；结果等待数据库事务期间可被调用方突变。新增可控 Promise/事务测试先复现失败，再修复，并保留排空前在途领取请求正常收尾的测试。

2026-10-09 运行 Node 22 的 `node --test tests/photo-jobs.test.mjs`，53/53 通过。除原先 26 项通用仓库测试，还覆盖真实账本预占/返还/结算、发布扣次同事务回滚与新连接恢复、当前同意与输出标识拒绝、撤回后再授权不复活旧图、来源订单退款阻断派发/发布、过期补偿、旧键恢复、支持实际带点号模型名以及独立线程/连接竞争。该记录是本地隔离测试结果，不是云端或商户验收。

## 2026-10-09 真实 MySQL 隔离验收

本机没有现成 MySQL 服务、客户端或容器运行时。本轮从 [MySQL 官方 CDN](https://cdn.mysql.com/Downloads/MySQL-8.0/mysql-8.0.46-winx64.zip) 取得 Windows 8.0.46 ZIP，大小 248009349 字节；本地 MD5 与同来源 `.zip.md5` 公布值 `003f527d5df61b663ff191038cd676bd` 一致。采用官方免安装 ZIP 形式，未注册服务、修改 PATH、安装软件或连接云数据库。

可复用入口为 `tests/photo-jobs-mysql-isolated.mjs`，刻意不命名为 `.test.mjs`，默认测试不会起数据库。它只接受操作系统临时目录下 `lyx-photo-mysql-*` 专属目录，核对下载包摘要，每次创建独立 datadir 与随机测试库，随机凭据只保留在进程内。服务只绑定 `127.0.0.1` 随机端口且关闭 MySQL X；应用连接仅持有隔离库 CRUD 权限。运行示例：`node tests/photo-jobs-mysql-isolated.mjs <包含官方ZIP及解压目录的本轮临时目录>`。该脚本不会读取 `.env`，不会调用微信、真实供应商或用户图片，也不会迁移既有库。

最终 8 项真实 MySQL 检查全部通过：

- 依次应用支付基础、context、任务候选 DDL：17 张 InnoDB / Dynamic / utf8mb4_bin 表，13 个生效 CHECK；真实外键拒绝未知账号，非法 env 触发 CHECK；任务索引为 `(state,created_at,id)`。
- 六个独立连接池并发提交、领取、发布，最终只有一次预占、一次假供应商调用、一件作品和一次消耗。
- 同步屏障强制六条连接都读到同键不存在，再一起提交；另分别强制六条连接都读到同一个 queued / result_ready 任务，再争抢领取和发布。仍仅一个提交者、一个领取者及一个发布者。
- 发布/消耗后、提交前注入错误，作品登记、资产状态、预占结算和任务状态一起回滚；重试仅恢复发布。
- 用实际 `ledger.createOrder`、`settle` 和 `applyRefund` 完成合成订单状态迁移；退款先于派发时零供应商调用、权益不恢复；退款与发布竞争按共同用户锁串行，本轮结果为 blocked。
- 撤回授权与发布竞争后，旧作品和私有对象不可读。
- 实际关闭并重启同一 mysqld/datadir：已领取任务保留 claimed，不重新领取；result_ready 只恢复发布。

受控竞争实际观察到 25 次 InnoDB 死锁错误，均由既有仅重试明确回滚事务的机制解决；没有放宽事务隔离级别或增加自动模型重试。这证明本轮受测竞争下没有重复预占或发布，不代表任意负载都不会耗尽现有三次重试。耗尽或提交响应不明时，客户端仍应保留原幂等键查询。

结果记录在本轮临时目录 `REDACTED_LOCAL_USER_PATH\AppData\Local\Temp\lyx-photo-mysql-20261009-6f5d34b2\mysql-photo-acceptance.json`。结束后已正常 SHUTDOWN，并独立确认 mysqld 进程数量和测试端口监听数量均为 0。随后仓库/context 与 HTTP/原生客户端联合回归 58/58 通过。以上是本机真实 MySQL 与合成模型/支付数据的验证，不是线上数据库迁移、真实图片制作或新一轮扣款/退款验收。
