# 正式闭售云托管启动适配

2026-10-12。本轮只有本地代码、合成配置测试和打包合同变更，没有云端配置、构建、发布、SQL、供应商或支付调用。旧 `mini-photo-production-20261011-193857` 原样保留，其 manifest SHA-256 为 `7206842d1fd9b580aa9ac897aa3891edfca671f198b4c694630b50aa0fb62e08`。

## 新启动合同

新包入口 `photo-jobs/production-bootstrap.js` 只解决微信云托管已有环境变量接口与现有正式入口 FILE+SHA 校验之间的接合。它不改变 `production-server.js` 的 env=0、正式数据库、AppKey、策略、支付门禁、worker 和退出合同，不读 `.env`、不迁移数据库、不制造通过报告。

每份资料选择一种来源：

| 资料 | 云托管环境变量来源 | 现有文件挂载来源 | 公用摘要 |
| --- | --- | --- | --- |
| 策略（必需） | `PHOTO_PRODUCTION_CONFIG_BASE64` | `PHOTO_PRODUCTION_CONFIG_FILE` | `PHOTO_PRODUCTION_CONFIG_SHA256` |
| 图片验收报告（可缺失，能力继续关闭） | `PHOTO_PRODUCTION_ACCEPTANCE_BASE64` | `PHOTO_PRODUCTION_ACCEPTANCE_FILE` | `PHOTO_PRODUCTION_ACCEPTANCE_SHA256` |
| 正式支付验收报告（可缺失，仍由现有 live 门禁判定） | `XPAY_ACCEPTANCE_BASE64` | `XPAY_ACCEPTANCE_FILE` | `XPAY_ACCEPTANCE_SHA256` |

BASE64 是原始 UTF-8 JSON 字节的标准编码，不换行、不重新序列化。每份 2–65536 字节；摘要是这些原始字节的 64 位小写 SHA-256。同份资料如果 FILE 与 BASE64 同时存在，包括空 FILE，立即拒绝；不提供另一个 JSON 输入变体。不会因为声明 `passed` 或 `approved` 就跳过现有业务校验。验收报告保持原 v4 字节，绝不用于填充正式 env=0 支付验收。

所提供的 inline 资料全部通过编码、UTF-8、JSON 对象与摘要检查后，才生成随机进程目录。图片报告与支付报告分别写入 `acceptance.json`、`xpay-acceptance.json`，不互相替代。Linux 目录 0700、文件 0600、当前 UID、普通单链接文件均核对；排除符号链接。只将生成的 FILE 路径装配到同一 `process.env` 对象，满足 canonical payment runtime 的现有要求。运行失败、可处理退出或正常 shutdown 后，只按原目录/文件身份清理自己创建的文件，不递归删除，不触碰外部挂载文件；服务排空完成之前保持文件可用。SIGKILL 等强制终止不能保证运行清理钩子。

支付 BASE64 支持是本次对 canonical 源码的追加修改，未修改已冻结或部署的 `buildtest-014` 制品。它只保留既有报告的原始字节和摘要；正式支付报告仍由 `acceptedVirtualPaymentEvidence` 核对 env0、AppID、OfferID、购买平台范围、时间与必要检查。没有生成付款结果、填入任何通过检查、开放 live 或改动闭售配置脚本。

新 Docker CMD 和 package start 均执行 bootstrap。构建时以非 root `node` 运行字体检查、无配置 import，以及合成 `{}` 的真实临时文件权限/删除检查；不启动 server、SDK 或数据库。实际生产启动目标仅 Linux；Windows 用注入的离线端口测试生命周期，不能当作 Linux UID/模式或镜像构建通过。

正式 manifest 更新为 v2，精确源码/SQL 47 文件加 6 项包装文件；锁仍为原投影的 116 依赖，没有新增依赖或安装步骤。新 verifier 只接受新 v2 合同。已有 v1 制品原字节保留，不通过添加文件或改 manifest 覆盖旧包。

## 已核实的官方灰度通路

本机 `@wxcloud/cli` 2.3.3 位于 `REDACTED_LOCAL_USER_PATH/AppData/Local/leyanxiu-toolchains/wxcloud-cli/node_modules/@wxcloud/cli`。只读核查发现两处直接运行 CLI 的确定风险：

1. `lib/commands/run/deploy.js:66` 写明 `flags.noConfirm ? 'FULL' : flags.releaseType`。`--noConfirm --releaseType GRAY` 实际仍是 FULL。另一个 `lib/commands/deploy/index.js:171` 也固定 FULL。
2. `lib/functions/getDockerIgnore.js` 的 `gitignore-globs` 与 `lib/utils/zip.js` 的 archive glob 不保留 Docker 反选规则。对旧 193857 制品按其真实实现做内存归档得到 0 文件、22 字节 ZIP。按已验证 manifest 明确逐项 append 则为 53 文件、173086 字节（含 manifest），低于官方 2 MiB 上限；此测试没有写 ZIP 或上传。新包必须按其新 manifest 重新归档，不能复用旧 ZIP 摘要。

最小可复用通路是：校验正式 manifest → 明确清单 ZIP → 官方 `DescribeCloudBaseBuildService` → PUT 包 → `CloudAPI.tcbSubmitServerRelease`，请求参数固定为下列结构，由主线填入已实查目标、官方上传回执和本次标识；这里没有实际调用：

```js
{
  region: 'ap-shanghai',
  wxAppId: verifiedTarget.appId,
  envId: verifiedTarget.envId,
  serverName: verifiedTarget.serverName,
  deployType: 'package',
  releaseType: 'GRAY',
  hasDockerfile: true,
  buildDir: '.',
  dockerfile: 'Dockerfile',
  port: 3000,
  packageName: upload.PackageName,
  packageVersion: upload.PackageVersion,
  versionRemark: reviewedOperationId,
  operatorRemark: reviewedOperationId
}
```

实际 SDK 映射见相邻 `@wxcloud/cloudapi/dist/index.js:11314`：`releaseType` 原样送到 `ReleaseType`，返回 `taskId`。之后用 `tcbDescribeServerManageTask({region,envId,serverName,taskId})` 跟踪此单，核对服务/版本/GRAY/步骤；响应不明先查原任务，不重复提交。`getDeployResult.js` 在 detach/缺版本时可提前返回，因此 CLI 的“部署完成”文本不能代替构建/运行验收。

旧 `scripts/deploy-mini-sandbox-cloud.mjs:432` 固定 FULL 且绑定 env=1/buildtest，不能改命令参数拿来发布正式包；其明确清单归档、受限上传、静默处理 SDK 输出的局部实现可复用，不复用其目标/发布门禁。也不要传 CLI `--envParams*`，该 CLI 会打印完整服务参数。正式配置只在主线受控流程中注入，不写入包、build args、终端或说明文档。

[微信官方部署发布文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/service/online.html) 已于本日 HTTPS 只读核实：非首次发布勾选灰度才进入 OpenID/URL 定向测试；首次发布直接上线。因此目标必须先核实为已有正常版本的服务，不能把新服务首次发布称作零流量。构建完成后停在测试步骤、不调整现网流量，检查 Linux/Pillow/字体、非 root 文件、正式库连接、health env0/closed、购买及生成均 false，再由主线决定后续操作。

[服务设置文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/guide/service/pipeline.html) 说明构建后的版本配置冻结；后续更改服务配置不会更改历史版本，控制台修改现网服务配置会使用原代码重新发布新版本。这不能与下面两个 API 混为同一个动作。

本机官方 CLI 的 `run/deploy.js:168–179` 先读取基本配置，再调用 `tcbUpdateServerBaseConfig`；同文件 `219–227` 明确先保存参数、再上传包、最后 `SubmitServerRelease`。相比之下，`service/config.js:85` 的独立配置变更调用 `tcbSubmitServerConfigChange`。相邻官方 SDK `cloudapi/dist/index.js:11353` 的 Update 返回空结果；`:11566` 的 Submit 返回发布 `TaskId`。[腾讯云官方权限接口表](https://cloud.tencent.com/document/product/598/76364) 将后者明确称为“更新配置并使用最新镜像发布”。这些证据支持将 Update 用于准备下次发布，不能用 Submit 或控制台保存来代替。SDK 客户端本身不是后端无副作用的绝对证明，实际执行仍需紧接只读验证。

主线受控执行时应：

1. 固定已有服务、当前全部版本、发布任务、当前在服版本配置指纹及流量；读取基本配置以逐值保留 CPU、内存、最小/最大实例数和访问权限。当前主线提供的目标为 `buildtest-013`、env=1/closed、100% 流量、0–1 实例、0.25 CPU/0.5 GiB、私有 MINIAPP；这些是执行前必须重新核实的状态，不是脚本可跳过的常量。
2. 调一次 `tcbUpdateServerBaseConfig`，只保存本次审核过的正式 env=0/closed 参数，其他字段原值保留。随后立即读取：在服版本、版本数量、发布任务、013 配置指纹与流量应全部不变，只有基本配置对应本次审核增量。失败、超时、新版本/任务或其他漂移均先查现状，不盲目重发或继续提交候选。
3. 通过上一步后才上传明确清单 ZIP 并 `SubmitServerRelease`，固定 GRAY。跟踪返回的唯一任务直至测试阶段；旧版本保持 100% 现网流量，候选不得自动推全量。正式 env=0 与旧 env=1 回调仍须分别验明定向请求目标，不把 GRAY 当作已完成切换。

现有 SDK 的 `tcbUpdateServerBaseConfig` 只暴露 envParams 等基本字段，没有这里可直接使用的私有 JSON 文件挂载参数，因此使用环境变量适配，无需为了配置文件新增 NFS、实例或数据库。

本机 SDK 的 SubmitServerRelease 未提供 build-only 参数，本轮不把 GRAY 当作仅构建。[官方价格](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/Billing/price.html) 现列构建 0.05 元/分钟，实例存在还会产生 CPU/内存用量；灰度 0% 现网流量不等于零费用。本轮没有提交任何会计费的构建或云端写入。

## 私有灰度 health 的最短验收

官方发布页明确测试阶段可用 OpenID 白名单或 URL 参数。设置测试规则需要点击“更新测试配置”，属于一次控制面写入；不是查询任务状态就自动建立。若已经有准确的当前发布单测试规则，直接复用它。若没有，主线可在当前发布单设置一个精确 URL key/value（不使用宽泛 Glob），保留旧版本现网 100%，不要点击“灰度上线”。URL 参数只是版本路由规则，不代替私有服务的微信访问身份；选择 URL 定向可让同一测试者不带参数时仍核验旧版本。

[官方小程序调用文档](https://developers.weixin.qq.com/miniprogram/dev/wxcloudservice/wxcloudrun/src/development/call/mini.html) 明确支持私有服务通过 `wx.cloud.callContainer`、`path` 中的参数、`X-WX-SERVICE` 指定服务，且超时上限 15 秒。已有 `wx.cloud.init()` 的本小程序开发者工具或真机中，使用下列结构进行一次 GET；不登录业务、不提交图片、不支付、不调用提供商：

```js
const response = await wx.cloud.callContainer({
  config: { env: verifiedEnvironmentId },
  path: '/health?' + encodeURIComponent(existingTestKey) + '=' + encodeURIComponent(existingExactTestValue),
  method: 'GET',
  header: { 'X-WX-SERVICE': verifiedServiceName },
  timeout: 15000,
});
// 不打印 response、header、callID、测试参数或控制面原对象。
// 仅将 response.statusCode/data 交给布尔白名单投影或等价原位校验。
```

若当前发布单采用 OpenID 白名单，路径为 `/health`，只能使用已在该发布单白名单内的微信调用身份；应用自行生成的 `usr_*` 不是 OpenID，不能混用。进入“灰度上线”阶段后测试规则失效，不能将测试阶段结果套用于后续新阶段。

新增 `scripts/mini-production-health-summary.mjs` 导出 `summarizeMiniProductionHealth(response)`，仅投影 `wx.cloud.callContainer` 的结果为布尔值，无文件/环境变量读取、SDK、网络或 CLI 动作。`closedHostHealthy=true` 必须同时满足 HTTP 200、正式 service/env0/closed、正确账本准备状态、图片表已准备、接收请求、购买与生成均关闭。旧 env1、缺表、任一开放状态、503、错误/过大 JSON 均不能通过；输出不带原始地址、身份、错误或秘密。该布尔值不证明具体云版本、Docker 层或流量份额，因此仍须将控制面当前任务的候选版本/测试规则与前后流量独立核对。3 项离线测试通过。

当前本机 `@wxcloud/cli`、`@wxcloud/core` 和 `@wxcloud/cloudapi` 中未找到 `TestWxCloudRunEnv` 的实现或参数合同，官方公开页面精确搜索也未取得对应说明。本轮不猜测其 `VersionName` 或认证字段，不把可能只探测默认在服版本的工具当作灰度验收。已验证的 `callContainer` 路径足以保留私有 MINIAPP 访问方式。

## 闭售启动不隐式建表/收费的代码证据

- `payments/virtual/runtime.js:55–65` 调 `openVirtualDatabase` 未传 `migrate`，`database.js:35` 默认 false。正式连接先经 `mysql-transport.js:107–124` 的 SELECT-only 校验，要求正确数据库/专用账号和已存在的唯一 env0 绑定；不存在绑定时在 ledger 绑定前拒绝。已有正确绑定下 `ledger.js:46–52` 只查原记录，不插入。
- `photo-jobs/production-host.js` 的 `prepare()` 全部是现有表/列 SELECT；`application.js:134–147` 与 `generation-lifecycle.js:113` 同样只查已有结构。`application.js:149` 在非空批准效果清单时会执行 `context.putEffect` 登记，所以不能笼统称任意配置启动只读。本次固定 closed-policy 的 `approvedEffects=[]`，该写入循环为空；不需 CREATE/ALTER 权限。
- `candidate-server.js:171–193` 只构造 SDK/端口，`createPhotoCandidateInspector` 只运行本地 `mark-ai.py --check-font` 和读取固定摘要验收文件。生命周期 prepare 不调用 `generate`、`moderate`、OSS PUT 或删除。
- `production-server.js` 仅在 process/cleanup/reconcile 任一显式 true 时安排定时器。当前全 false，不安排定时器、不进行模型/Green/对账。HTTP GET health 只查范围/准备状态，新购和图片提交继续关闭。

已存在实际本地 HTTP 启动测试 `tests/photo-production-server.test.mjs:159` 验证准备及 health 所有 SQL 均 SELECT、定时器 0、provider/moderation/storage 调用 0。该 fixture 使用隔离 SQLite 实际事务并注入 MySQL 连接身份观察；它证明本地调用行为，不替代本次 Linux 云容器或正式账号连接验收。最新 bootstrap/build/server 联合 26/26 通过，未运行镜像构建。
