# 微信小程序支付沙箱 MySQL 迁移实证 — 2026-09-30

## 范围与结果

通过用户现有 Chrome 的腾讯云 DMC 管理会话执行，未开启外网、未启用收费、未发布商品。
目标实例 `cynosdbmysql-7jg96bj6`，目标库 `leyanxiu_xpay_sandbox`。
预检查返回 MySQL `8.0.30-cynos-3.1.19.002`、管理账号 `root@%`；开始迁移前表数量为 0。

已逐条执行 `deploy/mini-payment/sandbox-schema-v1.sql` 中的 12 条建表、8 条建索引和版本记录插入。
所有成功均由 DMC 执行结果核对；索引连接超时后先查询实际存在状态，再补齐缺失项，没有盲目重复执行整份迁移。

| 复核项 | 实际结果 |
| --- | --- |
| 当前数据库 | leyanxiu_xpay_sandbox |
| 表数量 | 12 |
| InnoDB 且 utf8mb4_bin 的表 | 12 |
| 8 个指定业务索引的存在数量 | 8 |
| ENFORCED=YES 的 CHECK 约束 | 6 |
| vp_schema 最大版本 | 1 |
| lyx_xpay_sandbox 的 ssl_type | ANY（要求加密连接） |
| lyx_xpay_sandbox 的 account_locked | N |

## 中途故障与恢复

创建 `vp_reservations_user` 时 DMC 报 ETIMEDOUT，随后的只读查询亦超时。
云托管官方 CLI 查询显示实例状态为 pause。调用既有实例的恢复接口后，状态变为 running；
公网仍关闭、自动暂停设置保持开启，未修改算力规格。
旧 DMC 会话恢复后仍连接超时，通过云托管入口重新建立 DMC 会话后查询恢复。
只读查询确认当时 vp_reservations 只有 PRIMARY 和 vp_reservations_time，随后补建
vp_reservations_user、vp_outbox_due、vp_audit_time，并插入版本 1。
这只是本次暂停和管理连接恢复的观察，不是业务故障恢复或备份恢复验收。

## 仍未完成

### SSL 管理入口排查

微信云托管 MySQL 基础信息页未显示 SSL 开关，展开参数列表只有 character_set_server、event_scheduler、lower_case_table_names、sql_mode。
现有腾讯云登录会话下，普通 TDSQL-C 控制台上海地域未列出集群；CloudBase 控制台只列出另一云开发环境，未显示目标微信托管环境。
已安装官方 @wxcloud/cloudapi 的数据库管理接口声明中未发现数据库 SSL 开关或 CA 下载接口。
后续工单 202609301555 的工程师于 21:15:51 明确回复微信云托管 MySQL 不支持开启 SSL 加密认证，故当前实例存在平台能力阻塞。
未新购数据库、未修改网络或降低 TLS 安全要求。支持请求见 `mini-payment-mysql-ssl-support-draft-2026-09-30.md`，已追问支持 TLS 的私网替代方案及成本。

- 应用 MySQL TLS 连接及证书/主机名校验。`.env.mini-payment` 已填入已核实的内网主机和运行账号，密码与 CA 文件仍为空。
- 实例实查 `have_ssl=DISABLED`、`require_secure_transport=OFF`，运行账号要求 SSL，因此目前不能完成应用加密连接。独立 TDSQL-C 的[设置 SSL 加密](https://cloud.tencent.com/document/product/1003/109673)文档不能直接套用到该微信托管内置实例；须取得官方确认的替代架构，不能取消账号 SSL 要求绕过。
- 数据库运行账号密码此前出现在截图中，尚无可靠的轮换完成证据；不要复用聊天或旧截图中的值。
- 运行账号连接验证、并发竞争、死锁重试、事务故障恢复、身份库一致恢复、备份恢复演练。
- 微信真机支付、取消、重复通知、退款、换设备及财务核销验收。

本地收费配置仍为 XPAY_ENABLED=false、XPAY_MODE=closed、XPAY_ENV=1。
迁移完成仅代表真实沙箱库结构就绪，不代表整个支付系统或产品可正式上线。
