# 小程序消息推送接入包

此包仅用于微信后台的 URL 校验、加密连通性调试及云托管路径检测，不是可收费的支付服务。
无第三方运行依赖、无数据库、无商户支付密钥，不存储订单。只应部署为独立服务，
不得覆盖原 `leyanxiu-stage` 安卓闭测服务。新增云资源产生费用前须确认预算。

## 支持与限制

- `GET /health` 明确返回 `verification-only`、`salesEnabled=false`、`businessEventsReady=false`。
- `GET /api/mini/payments/notify` 校验微信签名后原样返回 echostr。
- `POST /api/mini/payments/notify` 只接收 JSON 安全模式，校验密文签名、时间戳和 AppID。
- 只有微信 `debug_demo` 连通性事件返回 success。
- `POST /api/mini/payments/notify/cloud` 为独立云托管接收路径，只对精确的
  `{"action":"CheckContainerPath"}` 返回 success；其他消息全部 503。
- 云托管路径要求 `x-wx-sources`（文档）或 `x-wx-source`（官方示例），
  若存在 AppID 请求头必须匹配本小程序。此检查依赖微信网关，部署后须关闭 PUBLIC 入口；
  普通 HTTP 请求自行携带这些头不构成微信来源证明。该路径没有发货处理器。
- 所有付款、退款及未知业务事件返回 HTTP 503，等待微信重试；不记为已发货。
- 请求体上限 128 KiB，包含无 Content-Length 的流式请求；慢连接有超时。
- 不记录密钥、带签名的 URL、用户 OpenID 或消息正文。

## 安全配置

在主项目 server 目录运行 `node scripts/prepare-mini-callback.mjs`。
该工具生成被 Git 和原容器打包规则忽略的 `.env.mini-callback`，Windows 下在写入前
移除继承权限，只授予当前用户与 SYSTEM。重复运行保留原密钥，不自动轮换。
文件用于安全配置交接，不能上传到代码包、聊天或截图。

部署平台设置以下环境变量，值直接来自上述私有文件：

| 变量 | 用途 |
|---|---|
| WECHAT_APP_ID | 小程序 AppID |
| XPAY_MESSAGE_TOKEN | 微信 Token，与后台保持一致 |
| XPAY_MESSAGE_AES_KEY | 微信 EncodingAESKey，与后台保持一致 |
| XPAY_MODE | 必须为 closed |
| XPAY_ENABLED | 必须为 false |
| PORT | 容器监听端口，默认 3000 |

此阶段不需要 AppSecret 或沙箱/现网 AppKey；完整支付联调时再安全配置。

## 打包与部署

主项目执行 `node scripts/build-mini-callback.mjs <新的绝对输出目录>`，
输出是完整 Docker 构建上下文。只复制七个审核过的源码/说明文件，并生成 SHA-256 清单。
在这个输出目录构建镜像；不要把主项目 server 目录作为本 Dockerfile 的构建上下文。
镜像基于 Node 22.23.1，非 root 运行，使用平台 HTTPS 入口。

取得公网域名后，先运行主项目的验收工具：

`node scripts/verify-mini-callback.mjs https://实际服务域名 <私有环境文件绝对路径>`

它会实际验证地址握手、拒绝错误签名、加密调试事件及未知事件重试，
不会创建订单、调用供应商或产生真实支付。禁止使用临时隧道冒充正式支付基础设施。

若采用开发者服务器方式，微信后台设置 URL 为 `https://已备案自有域名/api/mini/payments/notify`，
填入同一份 Token、EncodingAESKey，选择 JSON、安全模式并完成微信自身验证。
本机自测或公开 health 成功不能代替微信后台显示启用成功。

本项目优先采用微信云托管直连方式，无需自有域名。在云托管“设置 → 全局设置 →
添加消息推送”选择本小程序 AppID、已有环境、独立的 buildtest 服务，
Path 为 `/api/mini/payments/notify/cloud`，模式 JSON。
此方式不填写 Token/AESKey，保留原私有配置即可；不能将默认公网域名填进 MP URL 表单。
关闭独立服务 PUBLIC 入口后，由用户在后台提交，微信真实检测通过才算完成通道配置。

## 切换完整支付服务

在发布商品或开始任何真实支付之前，必须将同一个回调 URL 指向完整支付服务，
并保持 AppID、Token、EncodingAESKey 一致。完整服务还需要支付凭据、明确迁移的
事务数据库、可恢复用户身份、商品配置，以及重复通知和退款验收。
仓库内完整支付服务复用同一个消息解析模块，成功应答只发生于业务处理成功之后。
不要只打开开关让本接入包承接付款；它有意不提供发货功能。

参考：[微信消息推送](https://developers.weixin.qq.com/miniprogram/dev/framework/server-ability/message-push.html)。
