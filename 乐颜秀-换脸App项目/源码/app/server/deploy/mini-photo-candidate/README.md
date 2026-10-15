# 乐颜秀原生图片候选：本地构建上下文

这是独立图片候选制品，不是已部署镜像，也不是原支付 `sandbox-only` 包。固定 env=1，购买关闭；图片生成、处理、清理、支付对账的调度默认全部关闭。env=1 可能涉及真实资金，不能当作无真实扣款环境。

源码来自 `scripts/plan-mini-photo-candidate.mjs` 的显式白名单；依赖 lock 从已有 server lock 离线投影，六个直接依赖、116 个传递包，无安装/版本解析。每次构建要求已保存的 lock 与当前投影完全一致；变化须先审核。`manifest.json` 覆盖每个制品文件的实际字节和 SHA-256，可用独立 builder 的 `--verify` 校验。

## 构建边界

仅在支持 Docker 的受控 Linux amd64 环境，对已审核的独立目录执行 `docker build --platform linux/amd64 -t leyanxiu-mini-photo-candidate:review .`。这是供后续人工审核的命令，本轮未执行。它将访问官方 Debian/npm 仓库；没有云部署操作。

Node 基础镜像固定到官方 Registry 核实的 amd64 digest，config 中 Node 版本为 22.23.3，见 `runtime-image.json`。构建期安装 Python/Pillow/Noto CJK，记录 `runtime-os-packages.txt`，并以非 root node 用户执行字体、入口语法和无配置导入检查。构建期 `npm ci` 禁止安装脚本；没有 FFmpeg/视频/Android/SQLite 依赖。

本机无 Docker，尚未实际验证 Linux npm ci、Pillow 字体、容器启动或镜像行为。apt 仓库没有固定快照，本文件不承诺 OS 层逐字可重现。后续实际构建必须保留最终镜像摘要与上述系统包版本，不能把本地上下文哈希当作镜像摘要。

## 运行入口与外部配置

唯一入口是 `node photo-jobs/candidate-server.js`。构造依赖复用现有 canonical MySQL、身份与账本，不允许 SQLite/env=0/旧 App 入口，也不自动执行 SQL。源码包里的 SQL 仅供逐项审查，不进入运行镜像；既有库不可清空或重建。

运行前必须提供真实受控的 `PHOTO_CANDIDATE_CONFIG_FILE` 与 `PHOTO_CANDIDATE_CONFIG_SHA256`，配置合同为 `{version:1,policy,approvedEffects,moderationPolicy,cleanupPolicy}`，以最终入口的校验和配套说明为准。没有随包提供虚构批准清单、公司标识或备案事实。真实验收证据通过 `PHOTO_CANDIDATE_ACCEPTANCE_FILE` 与 `PHOTO_CANDIDATE_ACCEPTANCE_SHA256` 独立挂载；缺证据只能闭合生成门禁。

AppSecret、AppKey、数据库、OSS/Green/Qwen 凭据沿用入口支持的安全运行配置，不能放在此目录、镜像层、build args 或构建日志。保留 sidecar 的 `NODE_EXTRA_CA_CERTS=/app/cert/certificate.crt`，不关闭证书链/主机名校验。`PYTHON_PATH` 与 `AI_MARK_FONT` 已固定为 Linux 容器内路径。

镜像的 `DEBUG`、`NODE_DEBUG`、`NODE_DEBUG_NATIVE` 默认空值；若运行环境显式覆盖为非空，入口仍拒绝启动。没有 shell wrapper 清空变量来掩盖错误配置，也不通过调试日志核对真实请求或凭据。

此包不提供可直接用于生产的 `.env`、私有凭据、用户数据或证据样本。启动时仍需要准确的同库增量迁移、账户最小权限、有效挂载和真实准备检查。当前 `PHOTO_CANDIDATE_CLEANUP_ENABLED=false` 只是初始闭合状态，不履行持续删除责任；接受真实图片前必须明确并审核清理调度、预算、退出排空与待处理告警。

## 尚未完成

- 在 Linux amd64 完成干净依赖安装、实际字体/标识、默认零付费调用及非 root 启动验收。
- 对照真实数据库状态审查和执行必要增量，不以 `IF NOT EXISTS` 冒充补列完成。
- 完成真实供应商交付、私有下载、同意撤回/清理及真机闭环；真实调用需各自明确授权。
- 补公开服务资料和可靠客服申请回执，再按平台资料、商品、支付环境和审核要求推进正式运营。

现支付 builder/deployer 不接受该 scope；本轮没有创建图片部署器、改云端版本或开启收费。
