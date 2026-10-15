# 小程序沙箱支付准备 — 2026-09-29

> 2026-09-30 更新：真实云 MySQL 的 12 张表、8 个索引、6 个 CHECK 约束及版本 1 已执行并复核。
> 详见 `mini-payment-mysql-migration-2026-09-30.md`。以下为 09-29 历史准备记录，
> 其中“迁移未执行”的状态已被上述实证更新；应用连接和业务恢复验收仍未完成。

## 当前事实

- 用户已确认云托管消息推送提交成功；接收服务 buildtest-007 仍为 verification-only，不处理订单发货。
- 用户在控制台开通数据库后，通过微信云托管 CLI 确认 MySQL 8.0 已存在，外网关闭、自动暂停开启。
  初次检查状态 pause；本轮调用恢复接口后再次确认 running、内网地址已分配。
  初次查询时仅有 root 账户。用户随后在 SQL 管理界面创建了独立沙箱库和专用运行账户；支付表迁移尚未确认执行。
  云端算力区间返回 minCpu=0.25、maxCpu=16，不能将初始系统表存储费当数据库总预算。
- 本机未发现 MySQL/MariaDB 服务或 mysql/mysqld/docker 命令；本轮没有实际 MySQL 迁移和恢复证据。
- 用户已将 AppSecret 与沙箱 AppKey 保存至 `.env.mini-payment`。AppSecret 经微信官方
  `/cgi-bin/stable_token`（force_refresh=false）验证成功；只在内存检查返回值，不持久化或输出 token。
- 沙箱 AppKey 已保存，但尚未完成真实沙箱签名/交易验证。现网 AppKey 本阶段未要求提供。
- 支付 MySQL 主机、账户、密码、CA 仍未配置。验证期间没有创建订单、请求退款或打开收费开关。

## 本轮准备

- `scripts/prepare-mini-payment.mjs` 创建本机 `.env.mini-payment`，写入密钥前先收紧权限。
  Windows ACL 仅当前用户和 SYSTEM；Git 已确认忽略该文件。
- AppID/OfferId 使用用户已确认值；保留原 Token/AESKey；首次生成独立的会话加密及认证密钥。
  重复运行不覆盖配置，不轮换已有密钥，不上传、不调用支付接口。
- 默认 XPAY_ENABLED=false、XPAY_MODE=closed、XPAY_ENV=1、backend=mysql、生产 TLS 必需。
  正式 AppKey 本阶段不要求提供。文件不是完整生产服务配置，不能直接拿它启动共享业务服务。
- 用户只需先填写 WECHAT_APP_SECRET 与 XPAY_SANDBOX_APP_KEY，保存至本机文件。
  密钥不发聊天，不重置其他服务正在使用的密钥。填写存在不代表真实微信凭据已校验通过。
- 原生小程序改为支持 wx.cloud.callContainer，保留显式 HTTPS 方式；云请求失败不会切公网。
  云环境已填，完整订单服务名留空，避免将 buildtest 验证服务当作可下单服务。
- 6/6 客户端测试通过：服务端价格与签名、身份 token、幂等键、支付结果以服务端为准、
  云请求超时保留待确认单、无公网降级。未代替微信开发者工具编译或真机验收。

## 数据库开通前的具体方案

优先在现有上海云托管环境内使用托管 MySQL，独立沙箱库 `leyanxiu_xpay_sandbox`，
确认支持 MySQL 8、InnoDB、TLS 证书校验；运行账户限定此库，迁移权限与日常运行权限分开。
沙箱使用按量和自动暂停；公网入口保持关闭。自动暂停适用于联调，不能直接作为正式支付可用性方案。
开通已由用户在控制台完成。仍需核对 TLS 能力与费用设置，不能为通过测试去关闭 TLS 校验或借用 App 账本。

官方刊例页列出数据库算力 0.342 元/CCU·小时、存储 0.00485 元/GB·小时；
数据库暂停不等于存储免费，实际规格与报价以开通页面为准。数据库已开通并进行过唤醒，会按平台规则计费。
来源：https://cloud.tencent.com/document/product/876/113602

## 之后的执行顺序

1. 用户本机安全保存 AppSecret、沙箱 AppKey；后端校验渠道凭据，不返回值。
2. 核对并确认数据库开通规格和费用，建立独立库/账户；在实际 MySQL 上执行迁移、并发/死锁及备份恢复验收。
3. 接入完整订单、持久身份及补偿服务；云托管业务事件不能仅凭可伪造来源头直接发货，需完成可信边界与渠道查单验证。
4. 沙箱商品只使用已创建但未发布的 photo10，价格与后台一致；身份、规则与用途配置完成前不放开下单。
5. 微信开发者工具编译、Android 真机沙箱支付/取消/重复通知/退款/换设备；iOS 另行真实小额授权验收。

用户随后提供数据库管理首页截图，实例 ID 为 cynosdbmysql-7jg96bj6，显示 MySQL 8.0、运行中，
确认已进入 SQL 管理界面。此前登录错误的具体原因未确认，不归因于密码或远程登录限制。
用户提供 CREATE DATABASE 执行成功及 information_schema 查询结果截图，确认
`leyanxiu_xpay_sandbox` 存在，字符集 utf8mb4、排序规则 utf8mb4_bin。
这仅证明建库成功，不证明支付表迁移、应用连接或事务验收完成。
用户提供 SQL 结果截图：`lyx_xpay_sandbox`@`%` 账户只有 USAGE 和支付沙箱库的
SELECT、INSERT、UPDATE、DELETE。partial_revokes=0，库级授权对库名下划线做了转义。
ALTER USER REQUIRE SSL 的执行成功已有截图，但尚无应用 TLS 连接及证书校验证据。
此前截图暴露过用户输入的密码，已要求重置；未收到明确的重置完成证据，不能记录为已轮换。
`deploy/mini-payment/sandbox-schema-v1.sql` 已准备，12 个表定义及 8 个索引与当前源码逐项核对一致。
这是空库首次迁移文件，需使用管理员会话；遇错停止，不盲目重复运行。尚未取得实际执行结果。
TLS 证书和应用连接配置仍待完成；沙箱 AppKey 的渠道有效性留待后续真实沙箱验证。
不是要求用户另外建设网站或购买域名。凭据检查工具为 `scripts/check-mini-payment-credentials.mjs`，
只输出布尔状态和渠道错误码，不能把上游响应或 access_token 打印到日志。
