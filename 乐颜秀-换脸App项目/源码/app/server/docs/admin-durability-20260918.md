# 后台闭测数据持久化修复计划

目标：容器替换后，管理员配置、用户账号与次数账本、调用趋势、风险处理记录、已保存监控窗口仍可恢复；保存失败不返回成功。

范围依据：用户已确认后台制作、真实统计、监控与多代理协作。本项是现有闭测功能缺陷修复；生产事务数据库、多实例计费和外部告警渠道不以单实例快照代替。

## 设计

沿用现有阿里云私有 OSS，分别保存管理配置、业务账本和监控快照。业务账本在模块初始化时恢复；每次本地变更排入串行远端提交队列，响应前等待提交，生成预占次数提交成功后才允许调用供应商。远端失败锁定业务写入并显式返回 503，禁止退回空账本。监控按有限窗口、脱敏内容保存，恢复时保留真实时间戳；不得把重启解释为故障消失。

## 并行任务与接口

- [ ] 业务账本：修改 `compliance-store.js`，新增独立持久化模块及测试。提供 `flushComplianceStore()` 与 `complianceStoreReadiness()`；`COMPLIANCE_BACKEND=oss` 仅允许 staging，固定 `server/stage/compliance.json`，私有 ACL，文件模式继续支持隔离测试。持久化必须串行、启动校验、失败关闭；不上传环境变量、明文令牌或密钥。存量 session 存储沿用既有摘要形式。
- [ ] 监控：修改 `metrics.js`、`monitoring.js`，新增快照模块及测试。提供 `flushMetrics()`、持久化状态；`METRICS_BACKEND=oss` 仅允许 staging，固定 `server/stage/metrics.json`。保留有界计数、采样、分钟桶和脱敏告警，定时合并保存，启动恢复。无 HTTP 请求也须保存内部告警；关闭服务前 flush。保存失败在监控显示降级，不能报就绪。
- [ ] 根任务集成：在 API 中间件中检查账本状态，并等待所有账本变更持久化后发出响应；`prepareGeneration` 预占后先 flush。更新 stage 部署环境。补充不调用付费模型的真实账号/同意/次数跨部署验收脚本。
- [ ] 独立复核：检测并发覆盖、失败假成功、无凭据测试意外访问真实 OSS、未知管理写路由导致阻塞、凭据泄露、跨环境写入。仅对变更相关风险补测。
- [ ] 发布验收：完整服务端测试和语法检查后部署；原目录 v2、同哈希素材、账户身份/同意/次数与累计指标在新容器启动后保持；固定 APK 不因服务器专用修改重编。

## 验收断言

```js
assert.equal(restored.user.id, original.user.id);
assert.equal(restored.trialRemaining, original.trialRemaining);
assert.deepEqual(restored.analytics, original.analytics);
assert.equal(failedCommitResponse.status, 503);
assert.equal(providerCallsAfterFailedReservation, 0);
assert.ok(restoredMetrics.http.requests >= savedMetrics.http.requests);
assert.ok(restoredAlerts.some(a => a.name === originalAlert.name));
```

不编造已丢失的历史记录；新持久化从启用时起建立可恢复基线。所有测试使用隔离目录及假 OSS 客户端；只有明确 stage 黑盒验收读写现有测试服务。

## 执行结果（2026-09-18）

业务账本、监控、API 提交屏障与受控部署排空已实现。72 项完整服务端测试通过，前端 lint/build 通过。第 010 版启用持久化并创建验收基线，第 011 版受控排空后重部署，原会话、账户 ID、3 次额度、同意记录及历史操作指标恢复通过；目录 v2 和素材哈希保持一致。证据在 `../../output/audit/stage-durability-verify-20260918.json`。

未验证或不适用的边界：公网未制造付费消费/退款来构建统计曲线；相应账本恢复与统计口径使用隔离自动化验证。监控仍是单实例快照，不是多实例集中监控；外部值班通知与生产数据库未完成。
