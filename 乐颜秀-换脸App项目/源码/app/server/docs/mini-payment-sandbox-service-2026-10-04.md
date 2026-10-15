# 小程序支付独立沙箱服务交付与下一步

日期：2026-10-04。范围是独立支付验收服务的本地实现、专项复核和构建；不是正式收费或完整产品上线。

## 路线与实际进度

保留原 SQL 账本，不为“全部在微信内”重写 12 表业务。新增一个轻量 Hono 服务，把小程序登录、订单、权益恢复和微信适配装配起来，不依赖旧 Android App 主服务、文件身份快照或 AI 供应商配置。

10-04 通过已有官方云托管凭证只读核实：目标环境仍是 `leyanxiu-prod-d5gimob8af6a6e5c9`，MySQL 8.0 实例自动暂停、公网关闭；`buildtest-007` 100% 流量，仍是 MINIAPP-only 验证接收器。旧 stage 和 api 服务未修改。当前开发者工具云开发设置仍显示云托管 JSON 接收路径 `/api/mini/payments/notify/cloud`，未提交配置变更。

AppSecret 经微信 stable_token 接口本轮验证有效；沙箱 AppKey 只证实存在，未通过真实支付验证。未保存 access_token，未强制刷新，未发起支付。私有支付配置仍为 disabled/closed/sandbox；MySQL 运行密码与 CA 为空。

9-30 已有真实迁移记录：12 表、8 索引、6 CHECK、schema v1；不能再写成“从未迁移”。新增认证会话表 `vp_auth_sessions` 的增量 SQL 仅在本地准备，尚未在真实 MySQL 执行。

## 新服务的安全边界

- 入口仅允许 XPAY_ENV=1、closed/sandbox、MySQL，拒绝 merchant_test/live、旧 Android 配置及 SQLite 部署。
- 微信身份仅取自服务端官方 code exchange；忽略客户端的 openid/userId/session_key。已有 vp_accounts 的 userId 原样复用；不自动合并旧 compliance 身份。
- 认证 token 为随机值，仅摘要入库、固定 24 小时；每次认证查数据库。支付 session_key 单独加密且有效期 10 分钟。原用户映射与会话同库恢复，跨实例注销测试通过。
- API 实际流式请求体限制 128KB，伪报小 Content-Length 仍拒绝；登录每实例 20 次/分钟、最多 8 次同时换码。正式多实例限流不是本轮已验收项。
- 云托管消息正文和来源头不证明资金事实。发货先主动查单；退款必须是已有审核记录且主动查退款的 ID、环境、金额、状态与渠道号全部一致。退款事务内再次检查审核状态，防止查询期间退款已转异常态却被继续记为成功。
- HTTP ACK 只在账本提交/确认后返回 ErrCode=0；它不证明微信已收到，发货 outbox 保留给主动 notify_provide_goods 补偿。开启 XPAY_RECONCILE_ENABLED 后每 30 秒运行已有幂等补偿，停机先等待当前任务。
- iOS 问询、渠道主动部分退款、异常退款终结及未知事件继续非零错误并告警。服务没有管理员认证/审批入口，不会自动审核退款；生成 API 不包含在此包内。

来源核查：[微信官方云托管模板](https://github.com/WeixinCloud/wxcloudrun-express/blob/main/db.js)、[腾讯数据通信安全](https://intl.cloud.tencent.com/zh/document/product/236/49778)、[虚拟支付文档](https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html)、[容器内微信信息](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/weixin/)。官方模板支持普通私网数据库接法，但不能据此声称私网已加密；callContainer 也携带来源头，因此不能把来源头存在当官方支付鉴权。

## 验证与包

最终支付、回调、客户端、身份、服务、补偿审核和 TLS 回归 82/82 通过，包含云回调、实际请求体限制和退款竞态。新增 4 项补偿任务回归：退款已异常、渠道查询期间转异常、首次退款提交查询期间转异常、正常已审核退款恰好成功一次。原定时补偿仅排除成功/驳回状态，会继续处理异常退款；现在渠道调用前复核审核人/状态/归属，退款落账事务再次要求有效审核。它不宣称外部渠道调用与数据库能组成同一原子事务。

本地使用项目 Node 22.23.1、隔离 SQLite 和微信测试桩；不代表真实 MySQL 并发、恢复、微信真机或真实退款验收。

构建器 `scripts/build-mini-payment-sandbox.mjs` 使用 20 文件白名单，排除 .env、媒体、App bootstrap、业务状态和凭据。仅含固定版本 Hono、Node HTTP 适配、mysql2；lockfile 有 integrity。最新交付目录为 `D:/JT/乐颜秀/workspace/乐颜秀-换脸App项目/源码/app/output/mini-payment-sandbox-20261004-r3`，r1/r2 保留为历史包，不再作为部署候选。r3 离线 npm ci 成功安装 14 个依赖，实际 Hono 为 4.13.7；20 文件 SHA256 和大小全部匹配。本地真实 HTTP 健康检查返回 200/closed/realMoneyAllowed=false，未登录查单返回 401，未知云消息返回 503/ErrCode=1。HTTP 检查的数据库和身份是内存测试替身；无外部调用。没有 Docker 构建或云部署证据。

新版包业务模块与实际 Hono 4.13.7 另运行既有服务行为测试 7/7 通过，覆盖跨设备身份、关闭购买、未授权及伪造回调、请求体限制与登录限频。只有 SQLite 测试适配器由主服务依赖提供；部署包没有加入 SQLite。该 7 项是上述服务行为的新版依赖复验，不能叠加宣称不同的 89 项用例。

依赖复核发现 Hono 4.13.5 命中 GHSA-hxh3-vqpv-xpqv，已最小升级至 4.13.7，其余 13 个精确版本不变；当前入口未发现该 JSX/SSR 漏洞的使用路径。Node 的 npm audit 仍报证书主机名不匹配，未关闭验证或更改全局配置。改用 PowerShell 默认 TLS 访问官方 npm/OSV，官方 tarball 与 registry SHA512 核对后加入缓存，离线生成锁文件。2026-10-04 12:00:17 UTC，锁内全部 14 个精确版本在 npm bulk 返回空对象、OSV 返回 14 个无后续分页的空结果。这只说明当前公开漏洞库无匹配，不代表完整服务、基础镜像或生产系统已通过独立安全审查。锁文件 SHA256：`10d3255d14c893def93655799c0200b0d99048b0e36e752822556dcf261530fa`。

## 下一步具体方案

本轮接续后采用统一的正式接入方向：保留 SQL 账本和微信云托管，通过服务级 VPC 接入支持 TLS 的 MySQL，先盘点可复用实例，再评估是否确有新增费用。微信现行文档明确服务级 VPC 无需先购买旧资源互联包；不再把购买互联包列为必经步骤。TLS 是本项目对支付/身份传输作出的工程选择，未查得它是微信小程序统一上线强制要求。前述仅沙箱明文例外没有执行，账号 SSL 与应用校验保持原样。

具体环境、网络、接入步骤和剩余阻塞见 `mini-payment-production-route-2026-10-04.md`。沙箱与正式收费必须使用不同逻辑库和运行账号；不要求因此购买两套数据库实例。原库已有迁移不能当作新实例完成迁移；新认证表也仍待真实执行。客户端、回调和正式收费开关只有在对应环境验收后才切换。

必须保持的上线门槛：真实数据库及恢复证据、实际商品/成本/退款规则、iOS/Android 真机、渠道退款与账单核销、管理员安全、完整生成链路及原项目合规发布要求。独立沙箱服务完成不代表整个产品可上线。
