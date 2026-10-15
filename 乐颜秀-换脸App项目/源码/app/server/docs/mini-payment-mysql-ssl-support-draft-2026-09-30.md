# 微信云托管 MySQL SSL 支持请求草稿

状态：已于 2026-09-30 21:09（北京时间）提交到腾讯云官方工单，编号 `202609301555`，工程师 21:10 回复正在查看。
链接：https://console.cloud.tencent.com/workorder/detail?ticketId=202609301555
提交内容不含密码、AppKey、AppSecret、CLI 密钥或客户订单数据。联系人由用户直接在官方页面补充，不记录在本文。
提交时出现安灯服务相关角色授权，选择取消后仍成功建单；未点击同意扩大云资源访问权限。

## 官方回复与追问

2026-09-30 21:15:51，腾讯云工程师明确回复：“微信云托管的mysql不支持开启ssl加密认证”。当前内置实例无法沿原先开启 SSL 的步骤继续；未取得 CA。

21:17:21 已在同一工单追问并核验送达：

- 当前环境能否私网接入独立且支持 TLS 的 TDSQL-C/MySQL，具体产品和网络关联限制。
- 是否支持保留数据转换为支持 TLS 的实例形态。
- 官方文档、最小规格/计费入口、所需权限、VPC/网络组件、CA 和证书匹配连接主机名。
- 明确只咨询，不授权购买、迁移、重建、开启公网或修改实例。

以下为已提交原文。

## 标题

微信云托管内置 MySQL 实例如何开启 TLS 并下载 CA 证书

## 正文

我们正在为乐颜秀微信小程序配置虚拟支付沙箱数据库，尚未开放收费。

- 小程序 AppID：REDACTED_APP_IDENTIFIER
- 微信云托管环境：leyanxiu-prod-d5gimob8af6a6e5c9
- 地域：上海
- 数据库实例：cynosdbmysql-7jg96bj6
- 实际 SELECT VERSION()：8.0.30-cynos-3.1.19.002
- 内网地址：REDACTED_PRIVATE_NETWORK_ADDRESS:3306；外网访问关闭
- 沙箱业务库：leyanxiu_xpay_sandbox

实际查询返回 have_ssl=DISABLED、require_secure_transport=OFF、tls_version=TLSv1.2,TLSv1.3。
应用运行账号要求 SSL（mysql.user.ssl_type=ANY）。我们需要应用通过 TLS 连接并验证证书，不希望取消账号 SSL 要求。

微信云托管的 MySQL 页面未显示 SSL 开关或 CA 下载入口；可编辑参数仅显示 character_set_server、event_scheduler、lower_case_table_names、sql_mode。
同一浏览器已有腾讯云登录态，普通 TDSQL-C 控制台上海地域未列出该实例。
已阅读 https://cloud.tencent.com/document/product/1003/109673 ，但该文档的“集群管理 → 数据安全 → SSL”入口在本实例管理页面不可见。

请确认：

1. 微信云托管内置的这台 MySQL 实例是否支持 TLS，如何开启及下载对应 CA？
2. 若需平台操作或专用授权，请提供具体流程；请先确认影响，不要直接重建、迁移或修改计费规格。
3. 开启操作是否会重启实例、是否产生新增费用，自动暂停恢复后是否仍支持强制 TLS 连接？
4. 如需校验服务端身份，客户端应使用哪个与证书匹配的连接主机名？
5. 如当前形态确实不支持 TLS，请明确受支持的替代方案及网络、费用影响，供我们评估后决定。

我们可以提供脱敏查询结果，不提供密码或任何应用密钥。
