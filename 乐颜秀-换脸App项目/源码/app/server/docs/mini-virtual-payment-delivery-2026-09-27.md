# 微信小程序虚拟支付本地交付记录

日期：2026-09-27。状态：本地实现和隔离测试完成；未部署、未开真实收款、未完成商户验收。线上原状态未修改。

## 代码范围

- `payments/virtual/`：微信虚拟支付 `/xpay` 适配器、JSON 安全模式通知、MySQL/SQLite 关系表、订单快照、权益批次、退款、事务发货队列、查单对账、运营后台。
- `../miniprogram/`：原生小程序支付验收页面及客户端。仅支付模块，不含完整创作客户端；AppID 和 HTTPS 域名仍待公司配置。
- `index.js`：接入微信登录的短期加密 session_key、按 `(appid, openid)` 建立身份、分流生成任务权益、挂载小程序支付路由及补偿任务。
- `scripts/virtual-payment-migrate.mjs`：只建 `vp_` 表，不搬旧账、不修改旧 JSON/SQLite/Android 账本。
- 新增生产依赖 `mysql2@3.24.4`。本轮也发现 App 专属对话正在同一工作区构建 Android PostgreSQL 账本；其文件及依赖保留，不视为本轮小程序交付。两条支付渠道未合并账户或余额。

## 已实现行为

下单只接收商品 ID，价格/次数/期限由服务器已审核目录决定。订单保存完整商品及组件金额快照；每次购买必须确认当前规则版本。示例定价不是线上商品，默认目录为空。

支付使用 `wx.requestVirtualPayment`，不调用普通 JSAPI/APIv3 作为小程序虚拟商品收费通道。客户端回调不发权益；服务端验签/解密通知并向微信查单，核对 app 绑定、环境、订单、金额、渠道单号，再同一事务记录事件、发权益、写发货队列。通知重复、查询与通知竞争不重复发货。

图片/视频额度分开，按有效期先后消耗。会员续期排在已有会员结束后，不提前开放下一期次数。权益按订单归属冻结和撤销。生成先冻结，成功扣除，确定失败返还；跨过有效期后失败给予 7 天补偿。网络超时/提交丢失保留冻结，后台凭供应商结果人工核实，不自动再生成。标准视频只允许在服务端显式审核的固定模板中使用，不默认放行任意上传视频或昂贵特效。

退款按购买时组件金额及未使用比例计算，会员再取剩余时间比例的较低值。申请只冻结原订单，管理员需现有 owner 会话和 CSRF 审核；批准后写任务，再向渠道提交。请求成功不等于退款到账。未知结果不换退款单号、不自动重发；回调或查单确认成功后撤销该订单剩余权益。Apple 退款由用户向 Apple 申请，支持全额渠道退款通知，包括退款先于发货通知的情况。渠道主动部分退款暂要求人工核对分摊并保持告警，不能宣称全自动支持。

沙箱/正式数据库绑定 AppID 和环境，不允许切换后混用测试权益。MySQL 采用 InnoDB、SERIALIZABLE 事务、账户行锁、唯一订单/流水/事件及发货任务约束；仅对明确死锁回滚作有限重试。生产 TLS 必须校验证书。SQLite 仅用于本地/沙箱验证，不能解锁真实收款。

登录密钥服务端 AES-256-GCM 加密、绑定账号和会话、10 分钟过期；重新微信登录使旧支付会话失效，旧会话仍能查已有订单。旧版 `wechat:openid` 账号不会静默合并或丢弃，检测到时返回需核对迁移。Android 手机号/设备身份不会凭昵称等信息与微信账号合并。

对账分两层：待确认订单/退款补偿；已支付订单分页与微信查单比对原金额、剩余可退金额和状态并保存差异报告。另提供普通日账单/Apple 月账单请求。查单返回的渠道手续费与结算状态单独记录，缺失即未知；没有把查单对账当银行到账或财务收入确认。渠道账单文件解析及与银行流水自动核销尚未验收，需要真实商户样本确定格式。

## 操作入口

用户 API 前缀：`/api/mini/payments`，包括 `products`、`orders`、`orders/:id`、`entitlements`、`refunds`、`orders/:id/refund`、`notify`。

管理员登录现有后台后访问 `/admin/mini-payments`。可查看订单/退款/审计，审核原路退款，补偿查单，分页核对已支付单，获取渠道账单，处理有供应商证据的制作未知结果。异常核实需要证据文本并记录操作人。生产仍受现有管理员 MFA/跨实例会话等上线阻断项约束，没有伪造通过标志。

## 安装与数据库迁移

使用项目 Node 22。执行前按用途选取隔离配置文件，使用 `DOTENV_CONFIG_PATH` 指向它；不要直接复用真实 `.env` 测试。配置示例在 `payments/virtual/.env.example`，不要把填好密钥的配置提交或发到聊天中。

```powershell
# 在 server 目录；实际路径由部署者提供
$env:DOTENV_CONFIG_PATH = '隔离配置文件的绝对路径'
node scripts/virtual-payment-migrate.mjs --apply
```

正式库需 MySQL 8+、独立数据库用户与权限、可信 CA、备份和恢复演练。迁移账号可拥有建表权限；运行账号仅对 `vp_` 表所需查询/写入权限。备份范围须同时覆盖合规身份库、`vp_` 账本和加密密钥备份；仅恢复一个库不足以证明可找回权益。

`XPAY_ENABLED=false` / `XPAY_MODE=closed` 为默认。`sandbox` 必须 env=1；`merchant_test` 必须 env=0、MySQL、明确测试用户白名单和已验收身份持久化；`live` 另需固定 SHA256 的验收报告、管理员安全门槛。关闭销售时保留已配置的查询/退款/通知能力；如需停止新销售，设置 MODE=closed，不要删除旧密钥或切换数据库环境。

2026-10-11 补充当前验收绑定要求：报告必须有与配置完全一致的 `appId`、`offerId`，数值 `env: 0`，以及明确 UTC ISO 格式的 `acceptedAt`（不得在未来，距今严格少于 30 天）。`checks` 中的 `mysqlRestore`、`merchantPayment`、`merchantRefund`、`crossDeviceRestore`、`iosRefund`、`securityReview`、`dailyReconciliation` 全为经证据支持的 true。文件路径与摘要通过 `XPAY_ACCEPTANCE_FILE` / `XPAY_ACCEPTANCE_SHA256` 指定，文件须是最多 1 MiB 的普通文件，逐次校验原始字节 SHA256。env1 实际付款退款记录、缺少环境或 OfferID 的旧报告均不能开启 env0 正式销售；不得修改历史记录来补齐这些字段，也不得先改 true 再补验收。

## 本轮验证

- 最后一轮完整服务端回归通过 143/143 项；其中小程序定向测试为 23/23 通过。完整回归覆盖了共享工作区 App 对话已写入的测试，不能把全部新增测试归为本轮小程序工作。
- 最后一轮完整服务端语法检查通过 133 文件；原生页面脚本另行语法检查通过。
- 生产依赖 `npm audit --omit=dev`：0 漏洞（本次查询结果，不代表独立渗透审计）。
- 隔离主服务测试实际走 Hono 登录→下单→服务端查单→发权益→第二设备登录→找回订单；所有微信网络均为测试桩，无真实扣款。
- 后台页面通过本机浏览器检查，显示模拟套餐、退款、订单与审计；本地预览仅绑定 127.0.0.1，已停止。未将模拟页面当真实收款证据。
- 使用 Node `REDACTED_LOCAL_USER_PATH\AppData\Local\leyanxiu-toolchains\node-v22.23.1-win-x64\node.exe`；测试显式指定现有 FFmpeg。系统 Node 24 与原有 better-sqlite3 编译版本不一致，不能直接用它执行现有 SQLite 测试。

## 尚未完成，正式收费前必须补齐

1. 公司小程序/AppID、虚拟支付进件、OfferId、两套 AppKey、商品发布、JSON 安全推送与 HTTPS 域名白名单；不要求把密钥发到聊天中。
2. MySQL 实例上实际执行迁移、并发/死锁及故障恢复测试、身份库一致恢复、备份恢复演练。本轮没有 MySQL 服务，SQLite 测试不代替 MySQL 证据。
3. 微信开发者工具原生编译，以及 Android/iOS 真机完整支付/取消/重复通知/退款/换设备验收。iOS 无沙箱；明确金额上限后由真实账号验收。
4. 实际商品与成本、适用照片效果、15 秒以内视频模板清单及退款文本最终审核。当前价格仅样例，会员本地无限工具和永久买断没有擅自上架。
5. 自动财务账单核销、渠道主动部分退款分摊、投诉和风险事件工作流、退款异常终结处理的真实样本验收；当前不支持的事件返回可重试错误并告警，不能当已处理。
6. 管理员 MFA、正式身份高可用/恢复、独立安全审查和项目原有合规发布门槛。不能仅因为付款代码测试通过就宣布整个产品可上线。

## 官方协议依据

- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
- https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html
- https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html
- https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_query_order
- https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_refund_order
- https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_notify_provide_goods

以上于本次读取官方文档后实现，仍须商户协议和真机验证。
