# 原生小程序照片上传的持久协议（2026-10-09）

当前是本地候选实现，没有挂载到 `server/index.js`，没有云数据库迁移、OSS 写入或真实内容审核验收。新增表只存元数据，不存原始人脸照片、base64、私有 URL 或密钥；照片字节沿用私有 OSS。

## HTTP 合同

| 方法和路径 | 请求 | 成功响应 |
| --- | --- | --- |
| `POST /api/mini/photo-uploads` | 微信登录身份；`Idempotency-Key` 为 32 位小写 hex；JSON 仅 `{ image }`，规范 PNG/JPEG/WebP data URL，解码后最多 2 MiB | 新请求 202，重复请求 200；`{code:0,data:{upload,duplicate}}` |
| `GET /api/mini/photo-uploads/by-key/:key` | 原上传键，同一登录账号 | `{code:0,data:{upload}}`；不存在为 `null` |
| `GET /api/mini/photo-uploads/:id` | `upload_` 加 32 位小写 hex | 同上；不是本人或不存在返回 404 |

`upload` 仅包含 `id,state,createdAt,updatedAt`，只有 `ready` 增加 `assetId`。不返回 storage key、照片摘要、审核供应商响应或审核临时对象地址。

状态为 `staging → queued → claimed → reviewed → ready`；其他状态为 `rejected/review/unknown/cancelled`。`staging` 仅代表意图已经保存；不能解释为照片已经保存或审核通过。`reviewed` 已有审核回执，仍需数据库事务登记输入资产。`review/unknown/claimed` 不得自动重审；不得以“查询不到”推断先前请求没提交。

客户端必须在上传 POST **之前**持久化账号绑定的上传键。网络错误、未知提交、`by-key:null` 保留原键，只查询恢复。`ready` 后才使用独立的制作键提交原有 photo-jobs 协议；上传协议不创建第二份权益账本，也不扣制作次数。

明确未创建的新请求拒绝码：`PHOTO_UPLOAD_INVALID_REQUEST`（400/413）、`PHOTO_UPLOAD_NOT_AUTHORIZED`（403）、`XPAY_WECHAT_LOGIN_REQUIRED`（401）、`PHOTO_UPLOAD_BUDGET_LIMIT`（429）、`PHOTO_UPLOAD_NOT_AVAILABLE`（503）。`PHOTO_UPLOAD_IDEMPOTENCY_CONFLICT`（409）说明原键内容冲突，应锁住核对。其他故障统一 `PHOTO_UPLOAD_UNCONFIRMED`（503），不能自动换键重试。

## 持久边界

1. `submitIntent` 在同一 `vp_accounts` 用户锁下冻结 user/key/SHA-256/字节长度/MIME/同意版本和 epoch/审核版本与服务/期限/私有对象 key，提交 `staging` 元数据。
2. 只有首次成功收到意图提交结果的调用者可进行一次 OSS PUT。固定独立前缀、私有 ACL、禁止覆盖、无 SDK 重试。PUT 或提交响应丢失后，原键不得自动再 PUT。
3. 私有 OSS HEAD 限定长度及类型，再认证 GET 实际字节核对 SHA/长度/MIME，确认后才能 `queued`。源对象不存在或读取未知时仍 `staging`。HTTP 不调用 Green，存储阶段超时可先返回 202 staging。
4. worker 原子提交 `attempts=1/claimed` 后才能审核。再次读取并核对源照片；随后审核适配器必须在其临时 OSS PUT 前调用 `recordModerationIntent`，同库持久记录临时 key 的 reference/extension 和删除待处理标志。已登记过审核意图不能再登记并重新调用。
5. 回执必须绑定原 SHA、长度、input 方向、冻结审核政策与服务，以及持久临时对象 reference。未知响应或提交故障不自动重审。匹配 reference 的审核回执可记录当时的删除响应，但不关闭独立删除 journal 的后续复查责任；丢回包、进程崩溃仍保留原对象 key。
6. `reviewed → ready` 与 `mini_photo_assets` 输入登记在同一事务内，重新核对账号、同意 epoch、版本和期限。撤回、禁用、政策更新、源照片到期或删除后不会恢复可用资产。正在执行的审核可以收尾，但不能发布撤回后的输入。

这是上传审核预算，不是生成次数或支付预算：构造仓库必须明确提供 `maxDailyUploads` 和 `maxDailyUploadsPerUser`。首次上传意图占用当日预算，遗失 PUT、废弃上传和未知结果不自动返还这个预算；重复键不重复占用。数据库的 UTC 日界计算只作技术限流窗口，不当作用户套餐日期。

## 装配入口和剩余边界

- 显式执行 `photo-jobs/upload-schema.sql`，必须与既有 `vp_accounts`、`mini_photo_accounts`、`mini_photo_assets` 使用同一个 `ledger.database`。`photoUploadSchema` 不会自行执行迁移。
- 构造 `createPhotoUploadRepository({database:ledger.database,policy})`、`createPhotoUploadOssStorage(...)`、`createPhotoUploadService(...)`，再显式 `registerPhotoUploadRoutes`。不要将政策、审核批准或回执接受为客户端字段。
- 构造 `createPhotoUploadWorker({repository,storage,moderator})` 后由服务进程显式调度 `runOnce`、关闭时 `drain`。未提供默认定时器、租约回收或第二次审核。开始 drain 后不开始新 claim，已领取工作最多收尾一次。
- `cleanupCandidates()` 保留内部责任查询；新增 `upload-cleanup.js` 提供显式调度的删除执行器，`mini_photo_upload_cleanup` 保存删除尝试和复查证据，细节见下节。模块导入不会启动它，尚未在云端装配或验证真实删除。
- HTTP readiness 必须同时覆盖真实私有存储、worker 调度、明确审核政策/预算及清理责任；不能只因模块存在就设置 ready。状态查询应在关闭新上传后仍开放。
- 本轮使用真实本地 SQLite 文件测试，并替换 OSS/Green 网络端口；没有真实云审核。随后使用独立便携 MySQL 8.0.46 完成下述新上传表专项验证；不复用原 photo-jobs 的验收来代替新表证据。

验证命令：`node --test tests/photo-upload-cleanup.test.mjs tests/photo-upload.test.mjs tests/photo-moderation.test.mjs`。本轮清理 20 项、上传 43 项、审核适配 27 项，共 90/90 通过。覆盖同键并发、丢提交/PUT/审核回执、重开数据库、审核前 journal、撤回/过期/删除、发布回滚、错误回执、独立预算、drain、Hono 隔离与默认 OSS SDK 端口参数。

## 删除执行器与可持久复查证据

新增表 `mini_photo_upload_cleanup` 与原上传表处于同一 `ledger.database`。每个上传、每类对象（source/moderation）最多一行，存储 key 唯一，不建立新权益账本。显式迁移 `upload-schema.sql` 会包含该候选表；已有环境不会因导入 JS 自动变更。

`prepareCleanup` 用 SQL 筛出尚未登记删除 journal 且满足条件的候选，每轮最多 100 个上传；该发现读先提交，再对候选按用户顺序加锁、重新核实条件、登记责任。已经存在 journal 的对象由 `next_at` 独立推进，不再锁全体历史账号。106 条本地样本验证了首轮 100 条、下一轮 6 条（含晚加入且随后撤回的记录）、第三轮 0 条，无需用户轮询。

- source 仅在原期限到期、账号禁用、同意撤回/epoch 改变或对应资产明确删除/撤销时清理。审核失败、未知结果或审核政策换版本本身不会提前删除尚未到期的来源照片。
- moderation 临时对象在审核已收尾、授权失效或配置的在途保护窗口结束后可清理。正常 `claimed` 审核在窗口内不会被清理；保护窗口最少 5 分钟，实际值必须由装配配置明确提供。窗口结束只是允许清理与继续复查，不代表迟到 PUT 不可能发生，也不允许重新审核。
- 每次 DELETE 前，`claimCleanup` 提交新的 operation token、尝试数、开始时间和下一次恢复时间。提交回包丢失时，不发送 DELETE；进程重启后只可重做幂等删除，不重传照片、不调用审核。
- DELETE 后执行认证 HEAD，并持久保存独立的删除响应状态与对象观察状态。迟到旧 token 回执不能覆盖较新的结果。

| journal 状态 | 证据含义 | 后续动作 |
| --- | --- | --- |
| pending | 已登记责任，尚无本次删除尝试 | 等待调度 |
| observing | 已提交删除尝试，IO/回执可能在途或丢失 | 保护时间后可重新删除并检查 |
| absent_observed | 本次 DELETE 已确认响应，随后 HEAD 未发现对象 | 到 `next_at` 再次复查；不表示永久擦除 |
| present | 本次检查仍发现对象，可能是迟到 PUT | 按失败重试间隔再次删除 |
| unknown | 删除响应或 HEAD 不确定；即使 HEAD 暂时 404，丢失的 DELETE 响应仍独立记录未知 | 保留责任并恢复检查 |

`createPhotoCleanupOssStorage({kind,...})` 每个实例只允许一个固定私有前缀，提供单对象 DELETE/HEAD，不提供 list、PUT、任意 URL 或递归删除。源与审核对象可分别使用明确配置的存储端口。`createPhotoUploadCleanupWorker({repository,sourceStorage,moderationStorage,policy})` 每次 `runOnce` 最多处理一个到期对象，`drain` 停止新领取；已有删除操作可收尾。

装配必须明确给出 IO 超时、失败重试间隔、正常复查间隔和审核在途保护窗口，并配置调度频率、OSS 请求预算与告警。此模块**不会自动开启无限复查**，也不承诺未来请求零成本。当前保守策略不提供“永久完成”关闭接口；只要被持续调度，即使若干次观察不存在后又出现迟到 PUT，原 key 仍会被再次删除。

尚未证明或覆盖：真实云端授权和删除、对象历史版本/备份/供应商内部副本的擦除、跨存储桶配置正确性、实际调度持续运行和运营成本。要缩短或结束长期复查，必须另有可验证的写入停止及保留策略证据；不能仅依据 DELETE 成功或 HEAD 404 清空责任。元数据 journal 的保留与归档策略也需装配前明确。

## 真实 MySQL 上传专项验证

显式运行器：`tests/photo-upload-mysql-isolated.mjs`。只复用先前校验过的 Oracle/MySQL 8.0.46 Windows ZIP，不读取 `.env`、不注册系统服务、不改 PATH。每次创建全新系统临时目录和数据库，仅绑定 `127.0.0.1`，测试后停止本轮 mysqld，不递归删除任何目录。

2026-10-09 的 5/5 项通过，记录见 `server/evidence/mini-photo-upload-mysql-2026-10-09.json`：

- 新上传表在 InnoDB/utf8mb4_bin/Dynamic 下创建成功；5 项 CHECK 实际强制执行，账号外键有效，5 项唯一索引覆盖任务 ID、用户+幂等键、源对象 key、输入资产 ID、审核临时对象 reference。
- 两个不同账号、两个连接池以屏障同时读到最后一个全局上传预算，仅一个意图成功；另一个收到明确预算拒绝，没有额外上传或审核。
- 六个独立连接池并发同键、领取、登记审核意图和发布，仅一个意图、一个 claim、一个审核临时对象登记和一个输入资产。没有创建任何权益预占。
- 输入资产插入与 ready 更新之间强制失败，事务整体回滚；已有审核回执可恢复登记，不再审核。
- 撤回同意与发布并发后，原输入不可读，上传状态取消，删除责任仍可查询。

观察到 16 次 MySQL 1213 死锁，均由既有最多 3 次事务重试恢复；claim 的重试耗尽数为 0。此结论针对本轮受控竞态，不保证生产永不出现重试耗尽。该运行仍使用合成照片元数据和本地构造审核回执，不进行 OSS/Green 网络调用。临时实例退出及端口监听数 0 已另行检查；新 datadir 留存供复核，未删除历史证据。

随后通过同一运行器的 `--cleanup-only` 模式，在另一个全新 MySQL datadir 验证清理 3/3 项：新清理表的 6 项 CHECK 和唯一键；六个独立连接池仅领取一个删除尝试，观察不存在后仍持久安排复查；删除意图回滚及旧 token 迟到不能覆盖较新 unknown 结果。记录见 `server/evidence/mini-photo-upload-cleanup-mysql-2026-10-09.json`。观察 5 次死锁均重试恢复，清理 claim 重试耗尽数为 0。实例已退出，9130 端口监听数 0；未连接云存储、未删除任何真实照片。
