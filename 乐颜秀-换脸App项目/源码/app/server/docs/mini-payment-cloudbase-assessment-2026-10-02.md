# 小程序虚拟支付 CloudBase 路线评估

日期：2026-10-02；2026-10-03 实证更新。范围：微信小程序云开发环境、虚拟支付云函数回调、文档数据库事务和隔离验证。本记录不是生产部署、真实支付验收或独立安全审计。

10-04 追加：已复用 SQL 账本完成独立小程序沙箱 API、同库认证会话及渠道主动查询的云托管回调适配，本地测试和部署准备见 `mini-payment-sandbox-service-2026-10-04.md`。未迁移至文档数据库、未部署业务服务、未改变现有 TLS 策略或线上回调。9-30 已有 12 表真实 MySQL 迁移实证；当前缺应用连接与事务/恢复验收。

## 结论

可以把“云托管容器 + 内置 MySQL”替换为“微信云开发云函数 + 云数据库”作为候选实现。这样避开当前微信云托管内置 MySQL 不支持 SSL 的限制，也不需要在支付回调上单独维护公网服务。

10-03 范围复核：这只是已验证可运行的候选，不是当前确定迁移方案。现有原生验收客户端使用 `wx.cloud.callContainer`，订单/身份 API 服务名尚为空；实业务仍在 Hono/SQL 后端。为了“全部在微信内”而重写 12 表账本并不能省掉支付正确性验证。先完成原生编译、当前推送用途盘点及可复用账本的实际连通评估，再以改动范围、运行成本和恢复证据决定正式存储方案。

这不是配置切换。现有账本是 SQL 模型，包含 12 张表和大量查询、锁定、批量更新；CloudBase 事务只支持云函数端的单文档 `get/update/set/remove/add`，不支持事务内 `where` 批量操作，且使用快照隔离，不能依靠它自动避免 write skew。需要新建文档仓储并把所有共享权益不变量收敛到同一用户账本文档，再逐项迁移身份、订单、权益、退款、出站任务和对账记录。

## 已核实环境

通过现有 Chrome 登录态和只读 CLI 盘点，得到以下不含密钥的结果：

- 小程序 AppID：`REDACTED_APP_IDENTIFIER`。
- 已开通云开发环境：`cloudbase-d5gffahoe587434de`，名称 `cloudbase`。
- 环境状态 `NORMAL`，来源 `miniapp`，区域 `ap-shanghai`。
- 当前套餐为 `baas_personal`（个人版），预付费，未开启自动续费。
- 关联数据库实例状态为 `RUNNING`。
- 已创建 1 个隔离验证函数 `lyx-xpay-probe-20261002`，状态 `Active`，运行时 `Nodejs18.15`，入口 `index.main`；未创建支付业务函数。
- 当前集合数量为 1：固定隔离集合 `lyx_xpay_probe_health`，客户端权限 `ADMINONLY`，清理后文档数为 0。
- 10-02 CLI 高层调用只保留请求 ID，没有拿到返回值；10-03 改用同 SDK 的同步 Invoke 合约取得完整返回并按白名单输出，解决了证据缺失问题，未输出原始日志或正文。
- 真实云端 echo：请求 `13d5bbae-f6b2-437a-be35-ef3e13e61c79`，InvokeResult=0、ErrCode=0、Probe=echo、businessAcknowledged=false。
- 真实云端数据库单条写读删：请求 `c7425baa-de1e-437e-9a55-070493d4dfb5`，InvokeResult=0、ErrCode=0，database/committed/roundTrip/removed 全为 true。初次缺集合失败后由管理端创建集合，确认管理员权限后才写入合成记录。
- 10-03 安全更新关闭合成入口：包 SHA256 `2ef7bb618bd54edb194235a24ad609c73598ee66e4c74a5abee567eecaccad76`；请求 `09205a65-8ed4-457a-bc75-18dc2da539f3` 实际返回 XPAY_PROBE_SYNTHETIC_DISABLED，未写数据库。
- Chrome 已核实当前消息推送仍由云托管 `buildtest` 接收，路径 `/api/mini/payments/notify/cloud`、JSON。未迁移至云函数。沙箱商品 photo10 为未发布的 9.9 元开发样例，线上商品列表为空。
- 资源配额接口本次未取得可用结果，不能把配额当成已确认事实。

盘点脚本只读环境元数据、函数名称和集合名称，不读取函数代码、集合内容或密钥：

`server/scripts/check-mini-cloud-development.mjs`

隔离函数由 `server/scripts/deploy-mini-payment-cloud-function-probe.mjs deploy` 创建，当前由同一脚本的 `update` 更新为四文件最小包（探针入口、锁定的 `wx-server-sdk@4.0.2` 清单、说明和审查过的消息解析模块），不含密钥、生产账本或业务集合。部署证据：函数查询返回 `Active`，运行时 `Nodejs18.15`；部署脚本的 `status/plan/logs` 操作不会修改远程资源。

## 官方能力依据

微信现行虚拟支付云函数回调文档列出发货、退款、投诉和订阅相关 `xpay_*` 事件，并说明可在云开发控制台将事件推送到云函数。普通回调需要返回 `ErrCode: 0`，失败由微信重试；iOS 退款问询还有 3 秒响应要求。

相关文档：

- https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/wechatpay/virtual-payment-callback.html
- https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/database/transaction.html
- https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/reference-sdk-api/database/Database.runTransaction.html
- https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloud/guide/database/backup.html

同类支付事件配置到云函数后，不能继续假定它同时会推送到原公众平台消息地址。云托管模式会整包接收消息并使云函数订阅不生效，切换是全局变更；同一 (MsgType, Event) 不区分沙箱和现网绑定，Env=1 只是载荷字段。因此不能称为“仅沙箱开关”。先在微信开发者工具云开发控制台盘点所有既有绑定及容器用途、准备恢复顺序，再评估切换。

当前 @wxcloud CLI 没有消息绑定接口；tcbUpdateScfConfig 只管理公网/EIP，普通 SCF trigger 也不能替代微信消息配置。微信官方维护参考明确当前入口为开发者工具 IDE 消息推送面板，尚未暴露相应 wxide CLI 工具。依据：https://github.com/TencentCloudBase/CloudBase-AI-Toolkit/blob/main/config/source/skills/miniprogram-development/references/message-push-customer-service.md 。

## 本地隔离验证

新增的隔离实验只允许沙箱环境、固定 AppID、合成用户、`lyx_xpay_probe_*` 集合前缀和服务端固定 `photo10` 商品。它拒绝生产模式、正式环境、真实用户和生产集合，不连接真实云数据库。

验证内容包括：重复渠道单只发一次权益、两个订单争抢同一渠道单只能成功一个、并发扣次数不超用、同一任务引用幂等且不能跨用户/订单复用、写失败全量回滚、退款冻结与生成竞态、未知生成保持冻结、明确失败只返还一次、退款后权益不复活、提交响应丢失不自动重试。

结果：10-02 云文档事务模型模拟 `11/11`、云函数探针 `5/5`，合计 `16/16`。10-03 新增默认禁用入口测试后，在项目 Node 22.23.1 上模拟 `11/11`、探针 `6/6`，合计 `17/17`。原支付全量回归本轮未重跑；此前系统 Node 24 的 better-sqlite3 ABI 错误不能当业务失败，也不能当全量通过。以上本地测试不是云端事务或真实资金证据。

## 10-03 安全复核边界

固定 ADMINONLY 集合及单次管理端随机记录验证可接受，已关闭合成调用入口。ToUserName、载荷 AppID、synthetic=true 不能证明调用者身份；不能向客户端开放探针。Env/AppID 可选校验与未配置的 trigger 限制不能充当鉴权。原探针同 runId 可能覆盖互删，不能拿本轮随机串行验证证明并发安全。真实支付事件继续全部返回非零，无订单/发货/退款写入路径。

管理脚本已屏蔽 SDK 原始 console 错误，错误只输出固定阶段/代码；日志查询不再输出 retMsg。prepare-db 会核实环境、数据库身份和集合权限，invoke db 在权限未证实时拒绝执行。

## 原生工具准备

10-03 已复用用户当前 Chrome 调试连接，未新开浏览器或导出登录凭据。官方下载页显示稳定版 2.02.2608080（2026-09-30），已下载至 `REDACTED_LOCAL_USER_PATH/AppData/Local/leyanxiu-toolchains/wechat-devtools-2.02.2608080/wechat_devtools_2.02.2608080_win32_x64.exe`。文件大小 190935184 字节，SHA256 `8a3255fe7626879b472dc5145e1b29d797f86d0a6bd9d775097f2ba5f9bb7467`，Authenticode 状态 Valid，签名主体 Tencent Technology (Shenzhen) Company Limited。

安装器 manifest 要求 requireAdministrator；非提升启动曾返回 Windows 原生错误 740。用户已完成安装，实际路径为 `C:/Program Files (x86)/Tencent/微信web开发者工具`。用户已开启服务端口并授权 `codex-leyanxiu`；官方 `wechatide` 接口确认登录有效，skill 版本 `0.3.11` 与工具匹配。未绕过系统权限，未索取管理员密码或读取开发者登录凭据。

原生模拟器已显示支付页、套餐规则和空订单，页面正确提示“支付服务尚未配置完成”。完整订单/身份 API 服务名仍为空，未触发真实支付。官方 WXSS 单文件诊断成功（2 个文件、3583 字符）。WXML 单文件诊断曾返回工具内部 `10040`（`ReactiveCache cleared` / `getRootFactory Not Define Env Error`）；检查发现工具有管理员权限进程，桌面点击无法生效。通过官方 `quit` 正常退出、以普通权限重开同一项目后，桌面点击恢复，`compile_wxml` 成功返回 `$gwx`、`codeLength=45701`，console `grep -i error` 无匹配行。没有修改项目源码、基础库或安全开关来绕过问题。当前支付页面的模板/样式诊断通过，但此前运行时自动化和模拟器截图接口超时未解决，仍无完整支付联调或真机证据。

本地客户端补齐首次登录失败下拉恢复、会话过期后的一次重登、并发恢复、幂等重放和账号变化保护。购买/退款最终刷新失败时停止成功提示；账号变化会清空旧账号页面数据并保留各账号待确认订单。项目 Node `22.23.1` 客户端测试 `21/21` 通过，另经独立只读复核；不改变云端支付状态。

已直接打开 IDE“云开发 → 设置 → 其他设置”。加载完成后确认全局模式为云托管，当前唯一显示的接收配置为环境 `leyanxiu-prod-d5gimob8af6a6e5c9`、路径 `/api/mini/payments/notify/cloud`、JSON；只查看并取消了配置/切换模式弹窗，未提交变更。切换说明明确云函数模式按指定消息类型路由，其他消息仍推送至服务器域名；云函数模式下的历史绑定在当前云托管模式未显示，不能称全部绑定为空。当前页的商户云调用绑定/JSAPI 权限显示管理员未授权；这是普通微信支付云调用信息，不能混作当前虚拟支付 OfferId/AppKey 能力验收。首页提示文档数据库备份/回档与日志未启用，告警群查询返回平台 system error；未购买升级或变更配置。

## 下一阶段门槛

1. echo、单条数据库往返及清理已完成；云端事务提交/冲突、并发和恢复验证仍未完成。
2. 通过微信开发者工具确认当前全局模式、所有事件绑定和函数调用权限。只有完整接收端准备好并具备回滚路径，才评估切换现有云托管推送；不把隔离探针当正式接收端。
3. 设计身份库与账本的一致恢复边界，保留现有 `userId` 到微信 `openid` 的归属，不允许新文档迁移造成权益丢失。
4. 完成云数据库备份恢复演练、并发与故障演练、财务对账和真实退款验收后，才评估替代当前 MySQL。

在这些证据完成前，收费保持关闭，当前 MySQL 数据不迁移，微信后台的正式支付回调配置不切换。当前隔离函数本身不是可收费支付服务。
