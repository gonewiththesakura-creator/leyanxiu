# 上线闸门与运行契约

## 生产必须成立的条件

- 微信小程序生产使用 `AUTH_MODE=wechat`；Android 使用 `AUTH_MODE=device_key` 做不可伪造的设备持有证明。`device_key` 不是实名核验，当前真实姓名认证供应商适配器和逐用户绑定尚未实现，因此深度合成公开上线仍为 `NO-GO`。
- `OBJECT_STORAGE_BACKEND=oss` 指向已核验的私有 bucket；`storage:audit` 生成的 `PRIVATE_BUCKET_AUDIT_REPORT` 状态为 `verified` 且 `publicObjectCount=0`。
- 供应商输入和输出只接受当前用户的对象引用或服务端生成的短时 URL。对象默认 24 小时保存，签名 URL 默认 5 分钟。
- `RETENTION_SUPPLIER_POLICY` 和 `SUPPLIER_DELETION_CAPABILITIES_JSON` 记录每个供应商副本的删除能力；缺少合同/端点会告警并保留失败记录。
- `CONTENT_POLICY_VERSION`、`FACE_CONSENT_VERSION`、`BASIC_CONSENT_VERSION` 使用公司审批版本；生产不能只依赖本地规则审核。
- 生成图片/视频当前写入可见“AI生成”与普通容器元数据，但代码不把“已写入元数据”表述成国标合规。生产还必须提供并锁定 `AI_MARKING_CONFORMANCE_REPORT` 与 SHA-256；报告需证明 `GB 45438-2025` 的显式标识、隐式标识、服务提供者和内容编号检查均通过。
- `PAYMENT_MODE=live` 时必须配置真实商户回调签名、商品清单、幂等和对账；`closed_test` 不提供收费入口。
- 能力清单中每个核心能力须有至少 30 条真实、去重且全部通过的样本。代码从逐条样本重算质量结果，不接受汇总字段覆盖失败样本；清单缺失或供应商/模板未准备时保持 `blocked_pending_evidence`。
- 投诉举报使用 `POST /api/reports`，正文和联系方式单独加密，普通审计日志只留摘要；`REPORT_RETENTION_DAYS` 到期后清除敏感正文但保留最小工单状态。
- 任务台账仅支持 `file` 和 `oss`；生产必须使用 `oss`，微信云数据库遗留分支及其高危依赖已移除。
- 身份、会话、同意、投诉与审计支持 `COMPLIANCE_BACKEND=sqlite` 事务存储；未配置时仍使用 JSON/OSS 单实例快照，后者不满足生产条件。SQLite 是否可生产使用还需通过持久性与恢复证据校验。
- App 手机号账号和套餐账本使用独立 `BILLING_BACKEND=postgres`；支持月卡、次数包、退款与对账，但代码实现或隔离 PGlite 测试不等于线上 PostgreSQL 恢复、短信送达及真实商户验收。切换账本禁止自动迁移或合并旧财务数据；生产闸门逐项验收。

## 运行接口

- 用户：`/api/auth/*`、`/api/consents`、`/api/assets/*`、`/api/account`、`/api/works`、`POST /api/reports`。
- 运营内部：`/api/internal/retention/sweep`、`/api/internal/reconciliation`、`/api/internal/audits`、`/api/internal/supplier-deletions`、`/api/internal/monitoring`、`/api/internal/alert-drill`，均要求 `x-internal-token`。
- `/health` 表示服务与已启用运维能力的当前状态，不代表短信已经送达或支付已经验收；`/api/readiness` 表示配置闸门状态，`CLOSED_TEST` 和 `NO-GO` 不能作为上线通过证明。

## 故障处理

供应商创建失败或输出审核失败会退回制作次数一次并写入账本；删除失败写入告警和审计记录，由定时清理重试。发布使用 `npm run release:check` 输出提交号和 server SHA-256；本工作区含未提交交付，Git tag 本身不是完整发布依据。回滚应使用已核实的发布包、配置边界及匹配数据库备份；不得用历史 Git HEAD 覆盖当前源码。应用不在运行时自动改写生产配置。

账号旧备份还需防止恢复已注销身份和旧凭据。`scripts/check-app-account-restore.mjs --plan` 可查看新增离线检查入口；独立注销记录尚未接入线上，本项只能在隔离副本演练，缺少独立当前清单或覆盖起点即拒绝。即使本项通过，结果也保持 `reopenAllowed:false`，不替代整体恢复验收。

依赖审计使用 npm 官方 registry 执行 `npm audit --omit=dev --audit-level=high`。`npm run sbom` 从锁文件生成生产依赖清单，便于公司复核发布构成。
