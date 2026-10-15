# 闭售候选刷新准备

2026-10-12。此文件记录闭售候选刷新及其分层验收结果，不是开放购买或公开发布证明。

## 起点与官方接口

官方已安装 `@wxcloud/cli 2.3.3` 及其 `@wxcloud/cloudapi` 提供 `DescribeWxCloudBaseRunReleaseOrder`、`CancelWxCloudBaseRunReleaseOrder`、`OperateServerManage` 和 `SubmitServerRelease`。`SubmitServerRelease` 的包部署参数包含 `deployType: package`、`releaseType: GRAY`、包名/包版本、Dockerfile 和端口。刷新脚本只使用最后一种写接口和上传授权/上传，不调用取消、全量上线、流量更新或基础配置更新接口。

主任务在现有微信云托管控制台点击“取消发布”时，平台直接执行取消，没有二次确认。随后本子任务通过官方只读接口独立确认：发布单 2830122，CurrentVersion=buildtest-013、ReleaseVersion=buildtest-014、ReleaseStatus=cancel、IsReleasing=false；任务 2335630 stopped。新日志如实从取消后的状态开始，不补造取消前意图。

旧 `deploy-mini-production-gray.mjs`、原 `.env.mini-production-gray.json` 和其备份保持原样；原 014 制品不修改。新脚本使用单独且限权、Git 忽略的 `.env.mini-production-refresh015.json` 及其备份，并绑定旧日志与备份的哈希和完整内容。

## 新制品与准备结果

- 固定目录：`candidate-artifacts/mini-photo-production-20261012-input-clean`。
- manifest SHA-256：`347f8f8ec7889d1cc19adb1c256857780c9e2fa6fbf61e348b84d6e8efa539ed`。
- 明确清单 ZIP：183635 bytes，SHA-256 `d690eec3d5f5e9a700ba6e0ba6b7254f656b6808a2d0e4cdcfe37babea097485`。
- prepare 已完成：operation `08b7b6ba566abc1acc43e7ea`，phase prepared；随后实际提交任务为 `2337711`，关联发布单 `2832312`。控制面回读为 ReleaseVersion=`buildtest-015`、CurrentVersion=`buildtest-013`，发布单为 GRAY/test，URL_PARAMS 配置已保存并与刷新 journal 关联。不能把任务的短暂 running 阶段当成未部署，也不能把 test/GRAY 当成已公开灰度。

配置完整沿用 014 的正式 env=0、closed 环境，包括现有 session key；不创建新 key、不更新 base、不扩大资源。013 仍独立绑定 env=1 closed 的原始配置。

## 分层实测结果

控制面和运行面必须分开记录：默认 013 的闭售入口实测 health HTTP 200；015 的私有 URL 参数路由在官方微信开发者工具中通过项目实际客户端完成一次 health、登录、八项只读查询、退出，共 11 次业务调用。health 与八项查询均 HTTP 200，运行时确认 env=0、closed，登录及退出均确认，作品/订单/退款返回数量均为 0。脱敏逐字段证据见 `../evidence/mini-production-closed-client-2026-10-12.json`。

上述只读探针没有提交同意、上传、生成、审核、支付、退款，没有真人照片或新增计费调用，没有变更云配置、上传小程序或推广流量。它证明 015 的闭售客户端连接和只读协议，不证明图片效果、签名下载、支付回调、正式订单、真实人像或审核发布。URL 参数不会自动传给微信支付回调，正式开放前仍需让客户端、任务、账本和回调指向同一正式路由。

## 保护条件

1. 发布前重新核对取消发布单、任务、完整版本清单、013/014 明确版本详情与 base；两次核对之间发生任何已纳入配置的变化就停止。
2. 版本清单 FlowRatio 全 0 是已观察到的平台表示，不能据此解释百分比；用发布单的明确前继/候选、取消状态和固定版本详情保护刷新。
3. 服务域名 `AccessTypes` 与 base `openAccessTypes` 必须严格为 MINIAPP。官方 CLI 的 `service/create.js` 即使不开公网也固定传 `IsPublic:true`，同时以 `OpenAccessTypes` 控制入口；`service/list.js` 同样以 `AccessTypes.includes('PUBLIC')` 显示公网状态。因此版本详情里的 `IsPublic:true` 不独立作为公网开放结论，但它仍被保存和逐值比较，不可发生漂移。
4. 主任务同期只读实查：控制台公网访问未勾选；无凭据 GET `/health` 和 GET `/api/mini/payments/notify/cloud` 均为 HTTP 403。此处只保存状态，不保存私有域名、URL 测试参数、响应正文或环境变量。URL 参数仅用于本次私有灰度入口，不能成为回调认证或正式客户端配置。
5. 每次远端写入之前先将请求意图持久化。上传授权、上传或提交响应不确定时，日志停在对应 requested 阶段，重跑 submit 会拒绝，不自动重试；须只读核对再决定恢复。
6. 状态读取明确区分候选配置验证、发布单关联、灰度测试状态；不以任务或配置验证自称 Linux 启动、业务路由或付费验收已通过。

## 验证

`node --test tests/refresh-mini-production-closed.test.mjs`：11/11 通过。覆盖取消未完成、发布单或任务混淆、013/014 环境/镜像/资源/入口变化、竞争版本、包/旧日志修改、日志写失败、超时后不重试、恶意上传 URL、上传后状态漂移以及发布单关联反例。测试仅合成数据，不调用云端写接口。

官方参考：[查询服务版本详情](https://cloud.tencent.com/document/product/876/49739)、[操作发布单](https://cloud.tencent.cn/document/api/1243/75873)。后者是 tcbr 公开合同；没有将其枚举未经核实套到旧 tcb 取消接口。
