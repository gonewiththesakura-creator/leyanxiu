# 图片候选制品清单与锁定方案（2026-10-10）

本文件是本地构建计划，不是可运行镜像、部署申请或正式上线证明。没有安装依赖、下载镜像、调用供应商、读取 `.env`、上传制品或改动现有支付构建。当前只新增 `scripts/plan-mini-photo-candidate.mjs` 与局部测试，真实 `candidate-server.js` 入口和装配仍须完成及独立验收；脚本即使发现入口已存在也始终报告 `deployable:false`。

## 直接依赖：全部复用现有锁定版本

| 包 | 固定版本 | 实际使用 |
| --- | --- | --- |
| `@hono/node-server` | `1.19.17` | 新宿主 HTTP 监听，入口待装配 |
| `hono` | `4.13.7` | 图片与现有支付路由、流大小限制 |
| `mysql2` | `3.24.4` | 唯一 canonical MySQL 账本与任务事务 |
| `ali-oss` | `6.23.0` | 私有输入、审核暂存、输出字节端口 |
| `@alicloud/openapi-client` | `0.4.15` | 现有 Green 官方 OpenAPI 签名/传输 |
| `@alicloud/tea-util` | `1.4.9` | 官方 SDK RuntimeOptions，禁重试 |

Qwen 使用 Node 内置 HTTPS/DNS/crypto，不需要额外 SDK。`image-marker.js` 经管道调用真实 `mark-ai.py`，不导入旧 `ai-marking.js` 或其视频 readiness；后者不是候选启动依赖。`media-validation.js` 中虽保留共用的视频识别函数，但不引入 FFmpeg、视频路由或模型。

现有 `server/package-lock.json` 为 npm v3；六项依赖递归包含 dependencies、optionalDependencies 和 peerDependencies 后，当前闭包为 **116 个锁定包**，无需新增 registry 解析。保留锁内原位置及整条记录，包括嵌套的 `httpx/kitx` 类型依赖，不能按包名合并不同版本。闭包没有缺失依赖、安装脚本或原生 addon。保留 `qs:6.16.0` override；原项目的 uuid override 不在这个闭包，无需额外引入 uuid。

离线投影只是锁定方案，**不是 `npm ci` 已通过**。未来候选 `package.json` 使用以上六项精确版本和 qs override，候选 lock 根记录同步名字、版本和 dependencies，其余包记录直接复制当前 lock 的闭包；记录原 lock 与投影 SHA-256。随后在隔离 Linux 构建中验证 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`、依赖树及启动。当前脚本只在内存计算投影与摘要，不写 package/lock、不执行 npm。

不能复制整个 server package/lock 后依赖 `--omit=dev` 来精简：原 package 的短信、人脸人体、腾讯视频、旧支付、PostgreSQL、日历和 SQLite 都是 production dependencies，仍会被安装。也不能使用支付小包的三依赖 lock 冒充已覆盖 OSS/Green。

## 明确源码白名单

候选列表定义在 `scripts/plan-mini-photo-candidate.mjs` 的 `candidateSourceFiles`；只读校验每项字节数和 SHA-256，任何新增 import 超出列表均要求修改清单后审核。不是递归复制目录。

```text
photo-jobs/
  candidate-server.js          # 真实启动入口，待完成并验收
  candidate-host.js            # 外层路由与持久身份组合
  generation-lifecycle.js      # 同库生命周期与清理组合
  application.js
  context.js
  repository.js
  routes.js
  worker.js
  native-routes.js
  upload-repository.js
  upload-storage.js
  upload-service.js
  upload-routes.js
  upload-cleanup.js
  moderation.js
  output-storage.js
  media-ports.js
  qwen-provider.js
  image-marker.js
  generation-repository.js
  generation-pipeline.js
  generation-cleanup.js
payments/virtual/
  database.js
  ledger.js
  reservation-transactions.js
  wechat.js
  runtime.js
  mysql-transport.js
  products.js
  routes.js
  reconciliation.js
  message-endpoint.js
  cloud-message-endpoint.js
  cloud-business-endpoint.js
  mini-identity.js
  mini-sandbox-service.js
media-validation.js
mark-ai.py
```

共享 `database.js` 保留原 SQLite lazy import，但 MySQL 候选不安装 `better-sqlite3`。未来入口须在创建 runtime 前强制 `XPAY_DB_BACKEND=mysql`，并通过拒绝 SQLite 配置的真实入口测试；静态脚本不能证明这条分支不可达。

共享 `routes.js` 仍含管理员页面读取代码，但 `mini-sandbox-service.js` 的 `requireAdmin` 恒返回 403，读取发生在授权之后。新宿主继续此合同，候选可以不带 `admin.html/admin.js`；必须验证对应路由为 403，不能另行开放管理员认证再漏带页面。现有 `mini-sandbox-server.js` 不打包，避免误启旧入口。旧 App `index.js/bootstrap.js`、旧 JSON store、Android 身份与第三方 provider 目录不进入清单。

DDL 随候选审查清单提供，但不得在进程启动时自动执行：

```text
deploy/mini-payment/sandbox-schema-v1.sql       # canonical vp_* 基线，只作核对
deploy/mini-payment/mini-identity-schema-v1.sql # 既有持久微信身份
deploy/mini-payment/photo-jobs-schema-v1.sql
photo-jobs/context-schema.sql
photo-jobs/upload-schema.sql
photo-jobs/generation-schema.sql
```

当前白名单总计 44 项（38 个源码文件、6 个 SQL），缺少的候选入口会明确列出。SQL 可以在未来制品的 `migration/` 单独保存，运行镜像无需 COPY；旧数据库已有内容不能按基线清空/重建。真正迁移依据现状逐项核查，不能把 `IF NOT EXISTS` 当作自动补列。

## 最小 Linux 镜像合同，尚未生成 Dockerfile

基线复用 Node **22** 的 Debian bookworm slim 系列；实际构建前固定经核实的 Node 精确版本与 image digest，并记录系统依赖版本。当前没有查询或拉取 Docker 镜像，不虚构 digest。

最小系统依赖为 `ca-certificates`、`python3`、`python3-pil`、`fonts-noto-cjk`。不需要 FFmpeg、JDK、Android、GPU、Node 原生编译工具或额外图片生成 SDK。Pillow 来自 Debian 软件包可复用旧镜像的安装方式，但 apt 源本身会变化；要么固定快照/版本，要么记录实际镜像 digest 与 `dpkg-query` 结果，不能只凭浮动 tag 宣称可重现。最终还须实际验证已安装 Pillow 支持本项目的 PNG/XMP 标识流程，当前 Windows 验收不能替代 Linux 验收。

启动文件只允许未来真实 `photo-jobs/candidate-server.js`。以非 root 的 node 用户运行；明确 `PYTHON_PATH=/usr/bin/python3` 与中文字体 `/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc`。构建/启动检查包含 `python3 mark-ai.py --check-font` 以及无个人信息合成 PNG 经 `image-marker.js` stdio 写入、读回 AIGC 元数据和目视中文标识。不能把旧视频依赖检查作为图片 readiness，也不能因为跳过 FFmpeg 就开放视频。

保留云托管 sidecar CA 的 Node 信任扩展与 TLS 主机名验证。密钥、数据库 CA、私有批准配置和验收引用通过宿主运行配置/受控挂载提供，绝不进镜像层、build arg、源码包或构建日志。

未来目录 `deploy/mini-photo-candidate/` 可包含 Dockerfile、精确 package/lock、README。未来独立 builder 采用此白名单，先读完并验证全部文件，再创建全新输出目录；目标已存在拒绝。manifest 至少记录候选 scope/version、entry、源 lock/projection 摘要、每个实际归档文件的大小/hash、runtime 版本证据，以及 `env:1`、`sandboxMayCharge:true`、`productionPaymentsEnabled:false`、初始 `purchaseEnabled:false/generationEnabled:false/process:false`。配置默认关闭须由启动测试验证，manifest 声明不能替代运行验证。

任何部署仍需独立受控方案，旧 `build-mini-payment-sandbox.mjs` / `deploy-mini-sandbox-cloud.mjs` 及既有 manifest 完全不改。不得把图片包伪装为原支付 sandbox-only 包。

## 本地只读使用与当前验收边界

```powershell
node scripts/plan-mini-photo-candidate.mjs
node --test tests/photo-candidate-plan.test.mjs
```

脚本没有执行/安装/输出目录参数，传入 `--execute` 等参数直接拒绝。只读取白名单源码和当前 lock；不导入候选业务模块、不启动 HTTP/worker、不解析 `.env`、不读取本机凭证、不请求网络，也不改当前锁文件。未知 import、非普通文件/链接、缺少既有源码、未审版本、安装脚本和新 registry 来源会停止计划。

该扫描只覆盖当前代码的 literal ESM import 形式，不是通用 JS 沙箱或“任意源码绝无 IO”的证明。下一步仍需候选入口/闭售配置/同库装配/排空测试、隔离 Linux npm 安装与 Pillow/font 验收、镜像内容检查、默认零供应商调用，以及部署前独立审核。当前真实图片交付未完成；本清单不会把任何缺口改成通过。
