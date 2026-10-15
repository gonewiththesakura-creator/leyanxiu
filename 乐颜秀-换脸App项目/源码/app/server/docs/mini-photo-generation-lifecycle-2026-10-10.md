# 图片生成生命周期装配（2026-10-10）

本地新增 `photo-jobs/generation-lifecycle.js`，供 `createPhotoApplication` 的 `runProviderFactory({context})` 显式调用。没有部署、迁移、真实供应商/OSS/Green 调用或读取密钥。已有 repository/pipeline/media-ports/cleanup 继续承担持久意图、当前授权、对象完整性与发布前复核；本模块只装配这些端口。

## 接口

```js
createPhotoGenerationLifecycle({
  context,
  policy,
  media: { inputStorage, outputStorage, provider, marker, moderator, storageTimeoutMs },
  cleanup: { moderationStorage, policy: cleanupTiming },
  inspectPrerequisites,
  authorizeUser,
  generationEnabled: false,
  now,
})
```

返回 `{database, runProvider, prepare, readiness, runCleanupOnce, drain}`，`database` 严格为传入 `context.database`。内部仓库和清理仓库均从这个 context 创建；没有第二数据库参数或第二权益账本。源/输出/审核对象端口须使用已存在的私有存储适配器，输出写入和输出清理由同一个 outputStorage 承担。

`policy` 包括既有 generation policy，另要求 `approved:true`、原本的效果/政策 `reviewReference`、实际 `serviceProviderCode` 与 `acceptanceVersion`。固定图片编辑供应商/模型为适配器导出的 `QWEN_PHOTO_PROVIDER` / `QWEN_PHOTO_MODEL`，结果 URL 规则使用同模块导出的 `QWEN_PHOTO_RESULT_POLICY`，`operation='edit'`。这些是服务器已审核配置；不是新造认证或独立审批流程。构造时深拷贝并冻结，客户端不能传入。

## prepare 与 readiness 不是同一件事

`prepare()` 以同数据库事务执行显式 `SELECT ... LIMIT 0`，核验 generation 三表及其依赖的 vp/context/jobs 列，绝不执行 CREATE/ALTER/数据迁移。缺列/表抛 `PHOTO_GENERATION_LIFECYCLE_SCHEMA_REQUIRED`；宿主应保留既有支付操作并关闭图片。

schema 和清理端口完整后返回：

```text
{ prepared: true, markerReady, acceptanceReady, blockers }
```

标识工具故障或实测证据缺失仍明确返回 false/blockers，生成保持关闭；但 `runCleanupOnce()` 可以继续履行已存在对象的清理责任。不能因为 Pillow 故障或供应商验收失败就停掉删除。

`readiness()` 不带用户时只报告全局生成条件，不代表任何用户得到授权。有 `userId` 时还须 `authorizeUser({userId,policy}) === true`。`runProvider` 必须有用户 ID，重新调用此检查后才进入已有 pipeline；pipeline 仍会在同 vp 用户锁下核对当前同意、输入归属/期限、原预占及支付来源。移除白名单或退款/撤回不能通过目录 ready 绕过。宿主的原任务查询、撤回和支付恢复不应使用这个生成授权 gate。

`generationEnabled` 默认 false，只控制新生成入场。它不启动任何计时器或队列，也不打开购买。宿主只有显式调用 application 的处理循环才可能派发；`runCleanupOnce()` 同样必须由宿主明确调度，但不依赖新生成开关或已通过供应商验收。

## 只读检查端口

`inspectPrerequisites({policy})` 必须来自可信服务器装配，只读取实际标识运行环境和已有实测证据；不能接 HTTP/小程序输入，不能在这里试调付费 API 或自动补一轮验收。一个 `{ready:true}` 不会被接受。

当前返回合同为：

```text
{
  marker: {
    ready, python, pillow, chineseFont, // 四项必须为 true
    labelVersion, operation, serviceProviderCode
  },
  providerEvidence: {
    provider, model, version, resultUrlPolicy,
    labelVersion, moderationVersion, moderationService,
    report // 来自实际 runPhotoGenerationProbe 的最终报告
  }
}
```

marker 字段必须对应将由当前 marker 使用的 Python、Pillow、真实中文字体及实际运营者标识，不能因为开发环境的宽松默认值而填 true。检查端口自身不是标识合规认证；本模块也没有生成第三方合规结论。

`providerEvidence.version` 对应 `policy.acceptanceVersion`。除外层匹配外，**report 内部也必须匹配**实际的 `provider/model/probeVersion/resultUrlPolicy/labelVersion/moderationVersion`，以及 `moderationServices.input='baselineCheck'`、`moderationServices.output=policy.moderationService`。不能用外层 wrapper 的新版本说明去包装一份旧模型/旧策略报告。

报告同时要求 `executed/syntheticOnly/passed/inputAllowed/outputAllowed/marked/outputReadMatches/outputAbsentObserved` 为 true、`scratchAbsentObserved` 严格等于数字 `2`、`cleanupPending=false`、无 failure，且 `attemptedGenerationCalls=1`、`attemptedGreenCalls=2`。两份 scratch 缺失观察必须来自 report 自身，分别对应输入和输出审核临时对象；字段缺失、其他数量或字符串 `"2"` 均拒绝，且不将缺失观察当作永久删除证明。仅 HTTP 200、生成 1 图或密钥已配置不够；本轮首次探针只有渠道生成成功、未完成最终交付，不能满足此门槛。不重写旧探针记录来补新字段，后续实测只能引用其自己的真实报告。

检查端口应读取经过来源核实的当前报告及摘要；返回的 JavaScript 对象自身不证明测试真实发生。宿主可按工具/字体/报告内容摘要缓存实际只读检查结果，文件摘要改变即失效；不必在每个 readiness 请求都 spawn Python，也不能捏造检查时间或跨配置复用旧通过值。本模块每次 readiness 都重新询问这个端口，不缓存“曾经可用”作为永久事实。

## 排空与清理

`drain()` 先拒绝新 runProvider 和清理领取，然后等待已入场生成、准备、只读检查/账号 gate、清理运行，以及清理超时后仍在途的原始存储 promise。它不关闭数据库；宿主必须在 application/lifecycle 和支付对账全部排空后关闭唯一 DB。

原始存储 promise 永不结束时，drain 也不能诚实报告已结束。真实适配器必须实施有界网络超时/连接关闭；宿主可以有进程终止期限，但强杀后的持久状态仍为待核查，不转成“完成”、新生成或自动返次。

一次 DELETE/HEAD 缺失仍只是一条缺失观察。晚到 PUT 和版本副本问题由既有持久清理策略与部署运维承担；本模块不报告永久删除，也不在清理时触发生成、审核或权益返还。

## 验证与未完成项

`node --test tests/photo-generation-lifecycle.test.mjs`：16/16 本地通过。使用真实隔离 SQLite、canonical ledger 和 context，外部媒体/供应商/检查证据全部为合成端口。覆盖默认关闭/零外部动作、只读准备/缺 DDL、实际检查字段、报告内部版本、scratch 缺失观察数量/类型与外层伪补证据拒绝、全局与用户授权、一次生成发布/扣次、撤回竞态、配置冻结、生成和准备排空、只读检查排空、标识缺失仍清理，以及清理超时后的迟到 promise。

未替代的工作：可信真实 inspector 的宿主实现、实际镜像中的 Python/字体检查、完整真实生成交付验收、云端显式迁移与部署。测试中的合成通过报告只用于验证 gate 的判断，不得进入候选运行配置。
