# 微信小程序正式图片服务：独立本地构建上下文

入口为 `node photo-jobs/production-bootstrap.js`，校验运行环境注入的原始配置后调用现有 `production-server.js`，固定支付 `env=0`，默认 `XPAY_MODE=closed`，购买、图片生成、任务处理、清理与支付对账均关闭。此目录的材料用于生成新目录；不会修改既有沙箱服务、候选制品或数据库。

`scripts/build-mini-photo-production.mjs <全新绝对目录>` 只读取明确的源码白名单与既有依赖锁，生成逐文件 SHA-256 清单。`--verify <目录>` 验证完整文件集、哈希、静态导入闭包、依赖投影与默认配置；不安装、不构建镜像、不部署、不连接数据库。无参数为 `NO_OP`。已存在的输出目录必须拒绝，不能覆盖旧制品。

包中不包含 `.env`、私有配置、实际验收证据、密码、用户媒体、数据文件、旧 `index.js` 或 `node_modules`。`candidate-server.js` 等模块只因正式入口复用其已有配置/端口构造函数而保留，Docker CMD 和 package start 均只执行正式入口。没有将旧沙箱 SQL 放入正式包。

Linux 镜像尚未构建。Dockerfile 复用已记录的官方 Node 22.23.3 Debian amd64 镜像 digest，安装 Python/Pillow/Noto CJK，并以 `node` 非 root 用户检查中文字体及 import-safe 入口。实际构建才会执行固定锁的 `npm ci --ignore-scripts`；本地打包不执行安装。基础镜像 digest 不固定 Debian apt 仓库版本，真实构建需保留 `runtime-os-packages.txt`。

实际启动前仍需独立配置正式库连接和最小权限账号、正式 AppKey、私有存储与服务端固定策略。云托管可注入 `PHOTO_PRODUCTION_CONFIG_BASE64`（原始 UTF-8 JSON 字节的标准 base64，无换行）与 `PHOTO_PRODUCTION_CONFIG_SHA256`；真实合成验收报告可选 `PHOTO_PRODUCTION_ACCEPTANCE_BASE64` / `PHOTO_PRODUCTION_ACCEPTANCE_SHA256`，必须保留原始报告字节。每份最大 64 KiB，先验证编码、UTF-8、JSON 与摘要，再生成随机进程目录中的普通文件，Linux 目录 0700、文件 0600；现有 server 仍按原 FILE+SHA 合同验证。原有 `PHOTO_PRODUCTION_CONFIG_FILE` / `PHOTO_PRODUCTION_ACCEPTANCE_FILE` 直挂方式也保留，但同一资料不得同时设置 FILE 与 BASE64（空 FILE 也算冲突）。不支持 JSON 字段或自动补造验收内容。正常排空/启动失败/可处理退出清理只删除本进程自己生成的文件，不碰用户挂载文件；强制 SIGKILL 不保证执行清理。真实启动目标仅 Linux，Windows 离线合成测试不证明 Linux 权限已验收。这些原始资料均不得打入上下文或传入 Docker build args。

正式库只允许单独审核的 `leyanxiu_xpay_production`；建表 SQL 在 `deploy/mini-payment/production-schema-v1.sql`，其跨语句事务绑定仅适用于始终同一连接。微信 DMC 已实测每语句新连接，不能运行其中第4/5阶段，须采用独立 `production-binding-dmc-v2.sql`：仅用于尚无应用授权/活动写入的静默新库，单语句自动提交后从新连接完整核对，不能以后续 ROW_COUNT 或人工 COMMIT 判断成功。两个 SQL 都只是审核材料，包构建不执行，Docker 上下文也排除 SQL。

2026-10-12 起 manifest 格式为 v2，入口与精确白名单包含 bootstrap；v1 冻结目录保持原字节、不覆盖。新 verifier 仅接受新的 v2 合同。官方 CLI 2.3.3 的 `run:deploy` 不可直接用于此目录：`--noConfirm` 会把 GRAY 强制改成 FULL，且其 `.dockerignore` 解析器会把当前 Docker 反选白名单压成空 ZIP。应在核对 manifest 后按清单显式归档，将 `.dockerignore` 原样交给真正的 Docker，再使用官方上传/GRAY 流程或控制台的手动 ZIP 上传与灰度选项。不得调用既有 env1 `deploy-mini-sandbox-cloud.mjs` 发布正式包，其发布类型固定为 FULL。

退款运营员默认白名单为空；正式运行需通过 `XPAY_REFUND_OPERATOR_USER_IDS` 指定同一正式账本里已存在的微信用户，操作时仍要本人短时有效登录并确认原订单/金额。HTTP 身份头不能指定管理员；运营员未配置、实际图片能力或支付验收未通过，均不能开放购买。正式入口、公开资料、实际 Linux 标识与依赖、同库 SQL、真机交付/退款等验收是相互独立的步骤；`manifest.json` 的完整性验证不是部署授权，也不是上线完成。审核后需在独立位置记录返回的 manifest SHA-256，防止文件与 manifest 一同被替换。
