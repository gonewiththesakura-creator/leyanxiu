# 原生小程序图片生成持久流水线（2026-10-10）

本文件记录本地候选实现。它没有部署、迁移云数据库、调用真实生成模型、Green 或 OSS，也没有开启销售。付款和权益继续使用同一个 `vp_*` 账本；这里不创建第二账本。

## 同库持久合同

在 `vp_*`、`mini_photo_jobs` 和图片 context 表之后，显式执行 `generation-schema.sql` 的三张表：

- `mini_photo_generation`：冻结任务/政策、私有输出对象键、最终标识字节证据、供应商及审核回执、清理责任。
- `mini_photo_generation_operations`：每一步的开始意图、一次调用令牌、结果状态和次数。
- `mini_photo_generation_cleanup`：删除意图、令牌、DELETE 回执、HEAD 观察、后续复查时间。

`photoGenerationSchema(dialect)` 与候选 MySQL SQL 内容和顺序有本地对齐测试。模块导入、工厂构造均不自动迁移、请求网络或启动定时器。图片字节始终留在对象存储；SQL 没有照片 BLOB。

`createPhotoGenerationRepository({context,policy,now})` 强制使用 `context.database`。外部调用意图先在该库持久化，再由事务外端口执行。事务只做数据库操作，允许数据库适配器对已明确回滚的 MySQL 死锁重试。每一步重新按 `vp_accounts` 用户锁检查现有 context 的账号、当前同意/授权、输入归属/期限/epoch、冻结效果和真实订单/预占权益。

政策参数：

```js
{
  provider: 'aliyun-qwen-image',
  model: 'qwen-image-edit-plus-2025-12-15',
  operation: 'edit',
  labelVersion,
  moderationVersion,
  moderationService: 'aigcCheck',
  sourceHosts: [/* 精确审核过的供应商结果主机 */],
  resultRetentionMs
}
```

版本、主机、保留期必须由服务端已批准的配置提供；不接受小程序客户端指定供应商、模型、提示词、审核策略或回执。`sourceHosts` 在这里指供应商**结果**主机。原图经服务端认证读取、核对 DB SHA/MIME 后直接以私有字节传供应商，不生成原图公开链接。

## 流水线端口

`createPhotoGenerationPipeline({repository,context,ports}).runProvider({jobId,userId,spec})` 可接既有 worker。`spec` 必须与 `mini_photo_jobs` 冻结内容完全一致。

| 端口 | 输入及输出 |
| --- | --- |
| `readInput` | `{userId,assetId}` → 媒体证据；必须认证读取私有输入 |
| `generate` | `{input:媒体证据,spec}` → `{provider,model,requestId,url}`；单供应商、单张、单次请求 |
| `readGenerated` | `{url}` → 媒体证据；限定精确 HTTPS 主机、大小、超时，拒绝重定向及私网 |
| `mark` | `{...媒体证据,contentId:jobId,operation,labelVersion}` → 最终媒体证据加 `{verified:true,contentId,operation,labelVersion}` |
| `output.put` | `{key,bytes,contentType}`；私有、不可覆盖、无自动重试 |
| `output.read` | `{key,expected:{sha256,byteLength,contentType}}` → 已认证实际字节及证据，或 `{found:false}` |
| `moderator.moderate` | `{bytes,contentType,direction:'output',journal}` → 现有 Green 适配器回执 |

媒体证据是 `{bytes:Buffer,contentType,byteLength,sha256}`。流水线复制并重新计算实际 bytes 的 SHA/长度；输入上限 2 MiB，输出上限 20 MiB。当前最终发布格式收敛为 PNG。实际解码、显式/隐式 AI 标识真实性由 marking 端口完成，单元夹具中的模拟 `verified` 不能证明真实标识有效。

输出键严格为 `private/photo-outputs/<32hex>.png`，匹配现有 `createPhotoOutputOssStorage`；不得放宽该适配器前缀。桥接方式：

```js
output: {
  put: ({key, bytes, contentType}) => outputStorage.put(key, bytes, {contentType}),
  read: ({key, expected}) => outputStorage.read(key, {expected})
}
```

每个端口应自带有界超时。流水线不在超时后释放、重新生成或退款；已在途请求可能完成，数据库意图必须保留。默认组装不得给 SDK 打开重试。

## 恢复与发布

`generate`、输出 `PUT`、最终 Green 审核各只有一个持久意图。已有意图即使处于 `started/unknown`，也不能重新发该操作。未知供应商结果、校验失败回执、未知 Green 回执不会被认作失败而自动返次。

已保存生成回执后，可重做限定读取和本地标识；已保存标识 SHA 后重做标识必须产生相同最终字节。输出 PUT 回复丢失只允许认证 GET 并核对原键的 SHA/长度/MIME；查不到对象仍然未知，不允许重复 PUT。最终 Green 只审核读回的最终标识字节；回执绑定政策版本、service、`output` 方向、SHA、长度及同次 scratch journal。未知/不匹配审核不重审，`block/review` 不发布。

每个审核 scratch 的 `private/photo-moderation/<32hex>.png` 删除责任在其 PUT **之前**通过 `journal` 写入 SQL。只有数据库提交且返回 `true` 后，适配器才可写临时对象；提交回复丢失不授权外部写入。

正常路径：登记 `context.registerOutput` → 返回 `{assetId,providerRef}` → 既有 worker 的 `recordResult` → 既有 `publishNext`。供应商 URL、私有存储键、凭证和审核原始详情不进入用户任务响应。

恢复路径保留原来的 `claim_token` 和 `attempt=1`。根维护的 context 已允许 `claimed/unknown` 的原尝试在重新检查全部权限后登记输出。`runProvider` 从可验证检查点继续，不会回到第二次生成。完成登记后由内部操作者显式调用：

```js
await generationRepository.recordRecoveredResult(jobId, userId);
await context.repository.publishNext();
```

该恢复口只接受已登记、允许审核、同归属/同 SHA/同存储键的输出，并在同库锁下重新进行 `publish` 授权。它不把未知任务改回 queued/claimed，也不换 claim，不新增预占。退款、撤回、删除及到期仍阻止发布。`result_ready` 可由现有 worker 完成纯数据库发布。没有自动扫描未知任务、自动申领新尝试或自动补偿的后台程序。

## 删除执行与真实含义

工厂：

```js
const cleanupRepository = createPhotoGenerationCleanupRepository({context, now});
const cleanupWorker = createPhotoGenerationCleanupWorker({
  repository: cleanupRepository, outputStorage, moderationStorage,
  policy: {timeoutMs, retryAfterMs, recheckAfterMs, inFlightGraceMs}
});
await cleanupWorker.runOnce(); // 显式调度，一次至多删除一个对象
await cleanupWorker.drain();
```

storage 使用 `delete(key,{timeoutMs})` → `{acknowledged}`、`inspect(key,{timeoutMs})` → `{found:true|false}`。只接受严格固定输出/审核前缀；不删除输入对象（输入归既有上传清理器负责）。

仍可使用且未到期的输出不删除。输出到期、撤回/删除、失效 epoch、账号失效或来源订单已退款后可发现清理责任。审核 scratch 在回执已持久化或至少 5 分钟的在途保护窗后可清理。

发现每次最多 100 个未登记责任的任务；发现事务结束后逐个用户锁重新核实。已有 journal 从 `next_at` 调度，不会每次锁全部用户。DELETE 之前先提交 `observing` 令牌，崩溃重启后只重试删除；旧令牌的迟到观察不能覆盖新记录。DELETE/HEAD 超时或 403 保留 unknown，不能当作不存在。

一次或多次 DELETE + HEAD 不存在，均仅记录当次 `absent_observed`，保留未来复查责任。延迟 PUT 仍可能出现，本地测试证明后续复查会再次删除该固定对象。**没有“永久擦除”完成态**，对象版本、备份、供应商保存与依法保留的业务元数据仍须按真实平台能力及保留政策处理。复查频率、成本、最长在途窗口和部署调度必须明确配置，代码没有自动无限轮询，也不承诺零成本。

## 本轮验收与边界

`node --test tests/photo-generation-pipeline.test.mjs`：本地 35/35 通过。测试使用真实 SQLite 持久事务、真实 canonical ledger 的建单/结算/渠道退款，外部端口为合成夹具。覆盖一次生成、并发、独立连接恢复、事务回复丢失、输出 PUT/Green 回复丢失、最终字节审核绑定、退款/撤回竞态、原 unknown claim 的受控恢复、真实 OSS 适配器 + mock SDK、清理前写意图、迟到 PUT、删除回复丢失、旧令牌、102 条分批发现。

独立 agent 用 `tests/photo-generation-mysql-isolated.mjs` 在本机全新隔离 MySQL 8.0.46 上完成 7/7 验收：3 张新表的 InnoDB/二进制排序/FK/11 项 CHECK/CRUD 运行角色，4 个独立池唯一完整生成，未知不重发，真实 mysqld 重启后原 claim 恢复，真实账本渠道退款拦截，跨池清理令牌竞争及迟到 PUT 再删除。观察到 6 次 InnoDB 死锁，未产生重复预占、生成、PUT 或审核。报告记录 `providerCallsAreFake=true`、外部供应商/OSS 请求为 0、`serverStopped=true`、`portClosed=true`；本地监听仅 127.0.0.1:55730，现已关闭。

原始报告：`REDACTED_LOCAL_USER_PATH/AppData/Local/Temp/lyx-photo-generation-mysql-sG1Uz0/generation-mysql-acceptance.json`。不删除隔离目录中的证据，不复用或覆盖 datadir。

以上证明本地候选事务与适配合同，不能证明真实模型生成质量、真实输出标识、审核连通性、线上 lifecycle 调度、保留策略、应用资质或商户运营验收已经完成。本轮没有调用远端供应商、云 SQL 或真实收费。
