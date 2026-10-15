# 正式图片服务独立构建包验收（2026-10-11）

这是 env=0 正式入口的本地源码构建上下文，不是已经构建的 Linux 镜像，也未部署。既有 candidate 构建器、白名单和已有候选目录保持原样。

最终新目录：`D:/JT/乐颜秀/workspace/candidate-artifacts/mini-photo-production-20261011-193857`。manifest SHA-256：`7206842d1fd9b580aa9ac897aa3891edfca671f198b4c694630b50aa0fb62e08`。实际构建后另行执行 `--verify`，再逐一与当前 46 份源码/SQL及 6 份配置重新比对 SHA-256，全部一致；52 个被记录文件合计 517689 字节（不含 manifest 自身），116 个依赖 lock 节点。没有覆盖旧制品。

## 可审核实现

- 构建器：`scripts/build-mini-photo-production.mjs`。无参数只返回 `NO_OP`；给全新绝对目录才打包，已有目录拒绝；`--verify` 只读验完整性。没有安装、Docker、云 SDK 或 SQL 执行功能。
- 独立配置：`deploy/mini-photo-production/`，Docker CMD 与 package start 都是 `photo-jobs/production-server.js`。env=0、closed；生成、任务处理、清理、对账全部 false。保留候选关闭变量仅为防误用兼容，不代表正式运行采用 env=1。
- 白名单：46 份源码/SQL + 6 份构建配置 + 1 份 manifest。复用正式入口依赖的候选纯配置/端口模块；新运行源码为 production-server/host、mini-production-service、mini-service、mini-refund-operator。仅携已单独验收的正式库 `production-schema-v1.sql` 与 DMC 专用 `production-binding-dmc-v2.sql`，均不入 Docker 运行层；不携带旧 sandbox SQL。
- 依赖：复用候选六个固定直接依赖、qs override、116 个 lock 节点，只有根包名不同；没有 npm 安装或注册表解析。完整投影与主源码 lock 逐值比对。
- 镜像：复用此前记录的官方 Node 22.23.3 Linux amd64 digest；Debian Python/Pillow/Noto CJK，非 root；构建步骤检查实际中文字体和正式入口 import-safe。Debian apt 包版本仍在真实构建时记录，不能称已完全锁定操作系统软件。

构建器先快照所有白名单字节并检查导入，再独占创建输出。文件集、每文件字节数/SHA-256、依赖锁、Docker 完整文本策略哈希、SQL 审核哈希均验证。静态导入检查针对项目现有 literal ESM 写法，并非任意 JavaScript 沙箱。manifest 哈希必须另存到可信审核记录；普通文件哈希不是签名，文件和 manifest 一同被替换时不能只信包内自述。

## 本地验证

`node --test tests/photo-production-build.test.mjs`：7/7 通过。覆盖真实源码打包及完整校验、私有文件 canary 排除、无旧 sandbox SQL、116 依赖节点与候选逐值相同、默认关闭、已有输出保护、缺失源文件、未列/计算导入、目录 junction、安装钩子、Docker 追加开放配置、额外私有文件、篡改正文/manifest、重算文件哈希后的 Docker 策略篡改、CLI 无参数与拒绝执行/部署/安装标志。

加入 DMC v2 后同批运行构建 7 项与 DMC 静态 2 项，9/9 通过。DMC 的实际 RC/MySQL 4/4 与并发反例见 `mini-production-dmc-binding-2026-10-11.md`；独立审查未发现新的确定 P1/P2。正式入口/退款最后稳定后才生成上述唯一正式制品。

同轮正式主机购买门禁独立对抗复核：全局图片 readiness=true，但 lifecycle 拒绝具体用户时，商品 available=false、购买503、上传503、订单0、providerCalls0。该场景最初实测可创建订单，现 application.catalog(userId) 与 production-host 传递同用户已修。正式数据库生成器/SQL另见 `mini-production-schema-acceptance-2026-10-11.md`（本地 MySQL 6/6）；这些证据不证明云库已经执行。

## 实际运行边界

本机无 Docker，未运行镜像、Linux npm ci 或 Linux Pillow/font 标识验收。包中无 `.env`、密钥、真实验收报告、用户媒体、数据、node_modules 或旧 index.js。

正式服务仍需在独立审核步骤配置私有文件、正式库账户/连接和正式支付密钥；其余生成与购买条件由已有服务真实动态 readiness 决定。退款运营员默认空白名单，须配置同一正式账本里已存在的微信用户；操作还需短时本人登录和原订单/金额确认。客户端不能伪造运营员身份，单个开启标志不代表实际 readiness 通过。具体字段与启动/排空见正式入口说明；打包器不声明这些外部条件已完成。

真实部署必须以最后稳定源码的新 manifest 为依据；当前候选和旧正式制品不能被原地覆盖。是否云构建、灰度、分流、执行 SQL 或开启购买均不是此本地打包命令的行为。
