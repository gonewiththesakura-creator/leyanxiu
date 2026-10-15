# 图片候选启动入口（2026-10-10）

`photo-jobs/candidate-server.js` 是独立的真实入口，启动命令为 `node photo-jobs/candidate-server.js`。导入此模块不读取配置、不启动数据库/HTTP/定时器、不调用供应商；没有导入旧 `index.js`、bootstrap 或 dotenv。它不是正式 env=0 生产收费入口。

启动只允许微信小程序、微信认证、`XPAY_ENABLED=true`、`XPAY_MODE=closed`、`XPAY_ENV=1`、`XPAY_DB_BACKEND=mysql`。沿用现有 `virtualRuntime`、私网目标检查、持久微信身份和 canonical ledger；只建立一个运行时和数据库，拒绝 SQLite 或错误 AppID/env。现有私网传输例外没有扩大。未开启新购，但既有查单、退款、授权回调保持原服务合同。

新增操作开关 `PHOTO_CANDIDATE_GENERATION_ENABLED`、`PHOTO_CANDIDATE_PROCESS_ENABLED`、`PHOTO_CANDIDATE_CLEANUP_ENABLED` 及既有 `XPAY_RECONCILE_ENABLED` 均默认 false，值只能为字符串 true/false。处理开启必须同时显式开启生成；生成还要求既有测试账号白名单。真正提交的 readiness 同时检查 process、cleanup、白名单、同库 schema、真实 marker 和实测报告。生成或上传未知结果保持既有单次持久意图，不自动重发。

## 受控配置

`PHOTO_CANDIDATE_CONFIG_FILE` 为绝对路径，`PHOTO_CANDIDATE_CONFIG_SHA256` 固定其实际内容。JSON 顶层只允许 `version:1`、`policy`、`approvedEffects`、`moderationPolicy`、`cleanupPolicy`。这份文件来自已经审核的实际产品配置，不包含密钥，不生成假批准样本。

- policy 固定真实小程序 AppID 为 `serviceProviderCode`、固定 Qwen 模型/结果 URL 策略、edit 操作、实际协议/标识/审核版本、保留时间、上传上限及审核引用。
- moderationPolicy 固定输入 baselineCheck、输出 aigcCheck、lowRisk=review；地域须与现有 OSS 同域。
- approvedEffects 是服务端固定效果、单张参数和已有审查引用；空列表可以启动关闭状态。`application.prepare()` 会写入配置中的效果，因此整个 prepare 并非只读；没有自动 DDL。
- cleanupPolicy 固定已有删除/观察间隔与迟到写入宽限。清理调度独立于生成，不把 404 当永久删除。

输入审核与输出审核使用同一 moderator，但 application 的输入 policy 投影为 baselineCheck，generation lifecycle 使用 aigcCheck。两个仍共享同一个 context、身份、账本、协议版本与保留规则。避免把输入 baselineCheck 的真实回执误当输出审核服务。

实际凭据继续从现有环境变量注入。`DASHSCOPE_BASE` 原值传给经过验证的 Qwen endpoint，未设置时保留适配器默认值；显式空、空白/控制字符、非北京地域不会被 trim 或隐式回退。任何非空 `DEBUG`、`NODE_DEBUG`、`NODE_DEBUG_NATIVE` 在 SDK/运行时构造前拒绝，防止依赖库旁路打印带签名 URL 或请求凭据。没有把 secret、URL、图片、原始错误消息写入日志。

`PHOTO_CANDIDATE_ACCEPTANCE_FILE` 与 `PHOTO_CANDIDATE_ACCEPTANCE_SHA256` 是可选的固定原始探针报告文件及摘要。缺失、失败或摘要不符只会关闭生成，不阻止关闭状态的支付服务和已具备 schema 的清理准备。文件必须是 `runPhotoGenerationProbe` 真实返回的平面 report；不是包装文档，也不能拿 HTTP 200 元数据替代完整成品验收。

`PYTHON_PATH`、`AI_MARK_FONT` 使用实际绝对路径。可信 inspector 执行现有 `mark-ai.py --check-font`（无输入图片、无供应商调用），检查当前 Python/Pillow/中文字体，子进程仅收到允许的系统变量和字体配置，不继承密钥。工具文件身份变化会触发重新检查；固定报告摘要每次读取复核。不生成标识合规认证。

## 监听和退出

默认端口 3000、监听 0.0.0.0；可设置 `PORT` 与受限 `BIND_HOST`。监听前先准备同库服务，图片 schema/工具/报告缺失时不谎报图片可用。HTTP 超时为 15 秒；图片任务本身后台持久执行。

显式启用后的循环使用一次完成再排下一次的定时器，本进程不会重叠领取。默认间隔 30 秒，可用 `PHOTO_CANDIDATE_INTERVAL_MS` 指定 1–300 秒；图片失败不会抑制已有支付对账。所有开关 false 时不建定时器、不自动上传/审核/生成或删除。

SIGTERM/SIGINT 先停止新 HTTP/worker 入场、停止循环，然后排空宿主、当前对账和原始 SDK promise（包括审核超时之后仍可能完成的 scratch PUT），最后关闭唯一数据库。不能因上层超时就先关数据库并丢失迟到回执。进程强杀仍需按持久记录核查，入口不声称强杀完成或永久删除。

## 原生页面的公开接口

候选提供 `/api/public/compliance` 和 `/api/capabilities`，使创作页、服务与帮助页可以读取实际关闭状态。仅固定公开用户已经确认的公司与客服邮箱；`PRIVACY_POLICY_URL`、`USER_AGREEMENT_URL`、`THIRD_PARTY_LIST_URL` 为可选的既有公开文档配置，只接受规范公共 HTTPS 静态网址，拒绝 query、fragment、凭据和私网地址。不新增批准变量，不修改 policy JSON；未提供正式供应商和留存声明时保持 `pending_company_approval`。内部 policy.approved、合成探针通过不能将公开能力标为正式 verified，候选公开 capability 继续 ready=false。

`POST /api/reports` 校验已有登录后明确返回 503 `REPORT_SUBMISSION_DISABLED`，不读取/保存正文、不生成工单、不发送外部消息。原生服务端口识别该确定未受理码：保留先前有效回执，若无先前回执仅移除本次临时 pending；既存未知申请仍先阻止再次提交，不清除其他账号、支付或制作记录。公开邮箱始终可复制联系。这不等于持久投诉系统或正式账号注销已经交付。

## 本地验证

`node --test tests/photo-candidate-server.test.mjs`：12/12 通过。包含真实本机 HTTP 监听与关闭默认值、无图像验收/缺图片 DDL 仍保留关闭支付运行、错误配置在端口/运行时之前零调用、原始探针摘要与字段不伪补、SDK 端口仅构造、实际 Windows Python/Pillow/中文字体检查、同一身份/context 的输入 baselineCheck 持久记录与输出 aigcCheck 分离，以及 SIGTERM 等待迟到端口后才关闭数据库。

HTTP 测试采用明确注入的 MySQL 接口形状、实际隔离 SQLite 执行 SQL；不冒充真实 MySQL、Linux 镜像或云端验收。所有供应商/OSS/Green 调用为零，没有运行云 SQL、迁移、部署或重试真实生成。还需完成最终候选包安装/镜像验收、实际 MySQL 启动、真实图片交付和部署后的关闭状态核验。

公开接口额外验收包括原生 creation/service 客户端经真实本机 HTTP 刷新、匿名/两用户相同公开响应、内部配置不泄露、文档签名/query URL 拒绝、模拟技术能力已就绪仍不伪造公开 verified，以及确定未受理反馈/注销申请不返回虚假回执。
