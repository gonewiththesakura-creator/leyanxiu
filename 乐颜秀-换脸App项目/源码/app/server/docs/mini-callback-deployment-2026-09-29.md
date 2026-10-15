# 微信消息推送部署记录 — 2026-09-29

## 本轮进展

### 最新进展：云托管直连 007 已部署，用户确认微信后台提交成功

用户首次提交弹窗显示“请求超时，请确认服务在运行状态后重试”。只读核查发现：
007 为 normal、100% 流量，currentReplicas=1，实例 Running，实际容器端口 3000；
服务 minNum=0、maxNum=1，PUBLIC 仍关闭。未调整实例数量、重新部署或修改接收逻辑。
用户保持原字段重试后，于本对话明确回复“提交成功”。据此记录微信后台配置检测已通过，
证据类型为用户操作结果确认，尚无代理读取已保存配置或真实业务推送日志的证据。
首次超时根因未确认，不能断言冷启动或鉴权失败。诊断脚本已增加 --runtime 只读状态检查。

用户只有微信小程序，已找到“云托管 → 设置 → 全局设置 → 添加消息推送”。
无需购买自有域名；下面自有域名方案不是必需步骤。官方消息推送文档支持云托管直接接收，
JSON 配置检测请求为 `{"action":"CheckContainerPath"}`。

已新增独立路径 `/api/mini/payments/notify/cloud`，仅对精确检测请求返回 success。
要求微信来源头，并检查存在的 AppID 头；付款、退款、调试事件和其他消息全部返回 503。
该路径没有任何记账/发货入口，不将公网加密路径改成免验签路径。

`buildtest-007` 构建、发布任务 finished，服务 normal、流量 100%，旧 006 保留。
没有改动 `leyanxiu-stage` 或 `leyanxiu-api`，没有创建数据库、购买资源或开通收费。
七文件代码包为 `output/mini-callback-cloudpush-20260929.zip`，SHA-256：
`e62c581cb2e81a3b2cd01bc5f7b647149b2cab847bcb351f9e3c7ff0471eb0a5`。

安全验证发现：公网调用可伪造来源头，让精确 CheckContainerPath 探针返回 success。
因此不能用来源头本身证明可信；本包不处理业务，未发生错误发货。
已关闭 buildtest 的 PUBLIC 入口，云端 AccessTypes 只剩 MINIAPP。
实际再次请求 `/health` 和携带伪造来源头的云托管回调路径，均被网关以 HTTP 403 拒绝。
正式发货实现前仍须验证完整微信来源边界（包括小程序调用/资源复用等），不能仅凭请求头发货。

验证证据：
- 本地回调测试 4/4 通过，含原加密路径、云托管检测、错误来源/AppID、混入事件、超限请求及拒绝后的连接处理。
- 服务端语法检查 147 文件通过。
- 本轮全量回归有 1 项后台工作流临时文件 rename 的 Windows EPERM；其测试文件随后独立重跑 5/5 通过。没有改动工作流代码，不称首次全量全绿。
- 007 公网关闭前，旧 URL 验签、错误签名拒绝、加密 debug、未知事件 503 均通过；来源头伪造检查失败促成上述公网关闭。
- 公网关闭后运行 `scripts/verify-mini-callback.mjs <默认HTTPS域名> --private` 核验网关封闭。

用户弹窗应填写：

| 字段 | 值 |
|---|---|
| AppID | REDACTED_APP_IDENTIFIER |
| 环境 ID | leyanxiu-prod-d5gimob8af6a6e5c9 |
| 服务名称 | buildtest（不是默认选中的 leyanxiu-stage） |
| Path | /api/mini/payments/notify/cloud |
| 推送模式 | JSON |

微信后台配置检测已由用户重试并确认提交成功；这不代表真实付款/退款事件处理通过。
支付凭据、完整账本部署及真实付款/退款验收仍未完成；商品保持未发布。

### 历史阻碍：默认域名被微信后台拒绝（已选云托管直连方案）

用户 2026-09-29 提交消息推送配置时，微信后台显示：
“云托管域名仅用作测试使用，不可用在正式环境下，请修改。”
此前公网握手与密文测试通过，不代表该默认域名可登记为正式消息推送地址。
原先直接要求用户填写默认域名的指导不成立，应以本节为准。

只读运行 `scripts/check-mini-cloud-access.mjs --domains`，确认当前环境
`leyanxiu-prod-d5gimob8af6a6e5c9` 的自定义域名列表为空。
尚未绑定域名、改动 DNS、申请证书或启用微信消息推送。
若采用公网开发者服务器方式，需要确定用户可管理、已备案且用于本项目的域名，再配置独立子域名、
HTTPS 证书和云托管服务绑定，验证新地址后由微信后台完成接入验证。
不能从公司邮箱域名推定域名管理权或备案状态；小程序已备案也不代表所选域名已备案。
现有 Token、EncodingAESKey、安全模式及 JSON 配置保持不变。

### 已完成的部署

用户补齐 CLI 密钥后，真实认证成功，环境确认为 `leyanxiu-prod-d5gimob8af6a6e5c9`。
只读查到三个服务：`leyanxiu-stage`（011 版承载 100% 流量）、`leyanxiu-api`
（039 版承载 100% 流量）、`buildtest`（001—005 均构建/部署失败，流量均为零）。
复用没有可用业务版本、没有环境变量的 `buildtest` 承载独立消息验证服务。
不创建新环境、数据库或新的云服务，不更改另外两个业务服务。

`buildtest-006` 已完成云端 Docker 构建、镜像推送和发布，状态 normal、承载 100% 流量，
任务 CreateVersion / ReleaseVersion 均 finished。部署包哈希与下述记录一致。
公网访问已启用（PUBLIC + MINIAPP）。配置为 0.25 核 / 0.5 GiB、最少 0、最多 1 实例。
原服务配置备份保存在被 Git 忽略的 `server/data/mini-callback-before-deploy.json`。
发布脚本 `scripts/deploy-mini-callback-cloud.mjs` 仅允许预定服务和已校验的代码包，
遇到正在使用的版本或不属于本接入包的环境变量会拒绝发布。

云托管按用量计费，复用服务不等于免费。官方刊例价下此规格持续运行的 CPU 与内存合计约
0.02975 元/小时，另计构建、公网流量等；按需缩容到零可减少空闲运行费用。
这不是账单上限或最终价格承诺，不创建数据库、购买套餐或执行真实支付。
价格依据：[微信云托管说明](https://cloud.tencent.com/document/product/876/113602)。

### 已验证的公网结果

仅供测试的回调 URL（微信后台已拒绝登记为正式地址）：`https://buildtest-292172-5-1463758271.sh.run.tcloudbase.com/api/mini/payments/notify`

`scripts/verify-mini-callback.mjs` 对实际 HTTPS 域名完成以下检查：

- health 返回 verification-only，salesEnabled=false，businessEventsReady=false。
- 使用私有 Token 计算合法 URL 签名，服务器原样返回 echostr。
- 错误签名返回 401。
- JSON 安全模式加密 debug_demo 返回 success。
- 加密未知事件返回 503，未误报业务处理成功。

该工具从本机发起验证，不冒充微信服务器；微信后台自身的“提交/启用”尚未完成。
当前浏览器工具无法连接；待正式域名配置并验证后，再填入以下配置：

| 后台字段 | 值或来源 |
|---|---|
| URL | 待确认的自有 HTTPS 域名，加 `/api/mini/payments/notify`；禁止使用上述默认测试域名 |
| Token | 私有文件 `.env.mini-callback` 中 XPAY_MESSAGE_TOKEN 的值 |
| EncodingAESKey | 同文件 XPAY_MESSAGE_AES_KEY 的值 |
| 加密方式 | 安全模式 |
| 数据格式 | JSON |

只复制等号右侧的值；不要重新随机生成密钥，也不要填云托管 CLI 密钥或支付 AppKey。
商品保持未发布，接入验证服务在完整账本部署之前拒绝所有业务事件。

## 本地准备记录

- 根据用户后台信息确认 AppID 为 `REDACTED_APP_IDENTIFIER`，OfferId 为 `1450662722`；小程序工程已替换游客 AppID。
- 用户已在微信后台创建 `photo10`，9.90 元，状态未发布。未更改微信商品或收费开关。
- URL 校验已与完整支付数据库初始化分离；同一份消息解析代码用于完整服务及独立接入服务。
- 独立接入服务能验证微信签名和 JSON 安全模式调试事件，不开放下单；所有业务事件返回 503 等待重试。
- 128 KiB 流式请求限制、错误签名拒绝、跨 AppID 拒绝、慢连接超时及无敏感正文日志。
- 本机生成私有 `.env.mini-callback`，保留重复运行时的密钥；文件 ACL 仅当前用户和 SYSTEM，无继承权限。
- 已生成无密钥部署包：`app/output/mini-callback-20260929.zip`。
- 微信云托管 CLI 2.3.3 已安装在 `%LOCALAPPDATA%/leyanxiu-toolchains/wxcloud-cli`，未改动项目依赖。
- 准备 `.env.mini-cloud` 私有填写文件及只读云环境检查脚本；CLI 密钥不通过进程参数或聊天传递。

## 上一轮本地验证记录（本轮线上结果见文首）

- 服务端完整回归 148/148，通过；当次语法检查 140 个文件通过。之后补充的云环境检查脚本另行语法检查。
- 构建包内六个文件 SHA-256 与清单一致；使用实际私有推送配置进行本机 URL 握手和加密 debug 调试成功。
- 部署包 SHA-256：`5d5c53687bb3cbabede7c572636d05189ef99543311eae9567c0b4e624e0d7a0`。
- 本机没有 Docker，因此未声称容器构建成功；原生 Node 运行通过不代替云端镜像构建验收。
- 尚未上传或部署此包，微信后台未填写或启用消息推送，未发生真实支付。
- 独立接入包只解决微信地址和加密通道验证，不等于完整支付系统交付。真实商品发布前必须切换完整账本服务。

## 上一轮阻碍（其中 CLI 访问本轮已解除）

1. 内置浏览器工具返回 `unsupported Codex auth method: apikey`，无法接管用户已登录的微信页面。
2. 现有腾讯云 API 凭据查询历史 CloudBase 环境及服务均返回 `ResourceNotFound`，不能据此判定环境不存在或云服务已下线。
3. 当前机器没有 `.wxcloudconfig` 登录状态，也没有微信云托管 CLI 密钥；通用腾讯云 SecretKey 不等于微信云托管 CLI 密钥。
4. 公开闭测服务健康检查仍可访问，但支付回调返回 404。没有覆写此服务或更改原业务配置。

## 上一轮接手动作（CLI 访问现已完成）

打开微信云托管控制台的“设置 → CLI 密钥”。优先使用已有可用的专用 CLI 密钥；
没有时由管理员扫码生成一把专用于这台开发机的密钥，不要重置其他人正在使用的密钥。
将其粘贴到本机 `app/server/.env.mini-cloud` 的 `WXCLOUD_PRIVATE_KEY=` 后并保存。
不要发到聊天，不要截图包含密钥的页面；这里需要的不是虚拟支付 AppKey 或小程序 AppSecret。

保存后执行 `node scripts/check-mini-cloud-access.mjs` 只读确认环境；
优先复用已有适合的独立服务。若必须新增产生费用的资源，先给出具体规格和预算供用户确认。
不能直接调用安卓闭测部署脚本，它会更改共享登录/生成/账本配置。

## 获得访问后的实施顺序

1. 只读核对目标环境、服务、现有配置及费用；准备可回退版本。
2. 将无密钥代码包部署至确认的小程序独立服务，将私有推送配置注入环境变量。
3. 获取实际 HTTPS 域名，执行 `scripts/verify-mini-callback.mjs` 检查握手、验签、密文及未知事件重试。
4. 微信后台填写同一 URL、Token、EncodingAESKey，选择 JSON、安全模式并验证启用。
5. 再处理完整服务数据库、支付凭据、身份恢复和沙箱联调；本包没有资格承接真实收费。

官方依据：[微信云托管 CLI](https://developers.weixin.qq.com/miniprogram/dev/wxcloudrun/src/guide/cli/)，
[微信消息推送](https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html)。
