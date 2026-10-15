# 自然 AI 头像 v2：本地商测策略候选

本目录同名 JSON 是可供现有原生微信小程序后端装配的严格策略文件，尚未部署，不会自行启用云端、生成、购买、清理任务或对账。仅配置唯一效果 `natural-avatar` / `natural-avatar-v2-20261013`。`approved` / `enabled` 表示本候选内部策略与效果选择，不表示微信审核、监管批准、公司个人信息保护影响评估签字、实际用户同意或公开销售获准。

## 固定输入与证据

效果参数逐项复用 [v2 参数候选](natural-avatar-revision-v2-2026-10-13.json)，标题和副标题复用 [原首发商品](first-service-candidate-2026-10-12.json) 的“自然 AI 头像、人物细节可能改变”表述。没有替换模型、添加 seed、放宽审核或引入其他效果。原图及结果各保留 24 小时；每日上传上限全局 20、每用户 5；清理超时、重试间隔、复查间隔和在途宽限全部与 [原闭售策略](closed-policy-2026-10-12.json) 相同。基本同意和人脸处理同意版本继续沿用原策略；本文件不创建或追认任何用户同意记录。

完整真实技术报告为 [mini-photo-natural-avatar-v2-runtime-2026-10-13.json](../../evidence/mini-photo-natural-avatar-v2-runtime-2026-10-13.json)，SHA-256：`d0f8705c48f5d987e2e57d674370dbf0aa887f063a0483ca629aeea0492789fa`。其对象与本次独占日志最后一次 `probe_finished.report` 一致。报告中的 `probeVersion`、`labelVersion`、`moderationVersion` 均为 `natural-avatar-v2-20261013`，`resultUrlPolicy` 为 `qwen-dashscope-result-url-v1`，与候选策略匹配。实际为 1 次固定模型编辑、2 次审核、结果回读一致及本次对象清理观察通过；没有微信交易。

`natural-avatar-v2-sample-review-20261013` 指 [独立样本审阅](../../evidence/mini-photo-natural-avatar-v2-2026-10-13.json) 中主任务、`closed_gray_refresh` 和 `release_client_readiness` 对同一虚构成人输入与实际输出的审阅。对原承诺可记为单一样本通过：自然柔光、简洁背景和方形头像构图有可见效果，无 v1 程度的明显老化或畸变；轻度皮肤、细节及轮廓变化仍存在。**内部提示词的“只改背景、人物不变”目标未通过，不得对外据此宣传。** v1 失败证据保留；此结果不证明真人身份保真、总体成功率、Android 交付或公开销售就绪。策略 `reviewReference` 指本说明的配置审阅，不是备案或审批编号。

技术报告与视觉审阅职责不同：运行时应绑定前述完整报告及其准确 SHA，不能把视觉摘要加工成通过报告。完整规格 SHA-256 为 `5d4de1225b011792253dedda9730eda8fba9fc495e991dbd2f9c9119ad978bd9`，输入 SHA-256 为 `56eb47602d36864b6eec9514ddb091cfa2b71309558c3e12917b3970329b947f`。清理观察不等于供应商历史副本永久删除。

## 商测装配还需完成的四项

1. **绑定候选与真实资料。** 现有 `PHOTO_PRODUCTION_CONFIG_FILE` / `PHOTO_PRODUCTION_CONFIG_SHA256` 应指向同名 JSON 的部署路径与实际字节摘要；`PHOTO_PRODUCTION_ACCEPTANCE_FILE` / `PHOTO_PRODUCTION_ACCEPTANCE_SHA256` 绑定上述完整技术报告。若使用既有 BASE64 装配入口，应与 FILE 方式互斥，不能拼接两份策略。把已发布的 `https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/privacy.html`、`https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/terms.html`、`https://REDACTED_COMPANY_INFRASTRUCTURE/mini/legal/third-parties.html` 分别填入现有三项公开文档字段；这些页面已发布，不能再列为“尚未发布”。运行配置仍需落实 `RETENTION_SUPPLIER_POLICY`、包含本 provider/model 的 `AI_SERVICE_DISCLOSURES_JSON`（`filingReference`、`purpose`、`region`、`capabilities: ["photo-effect"]`）及真实 `PIPIA_REFERENCE`。供应商事实可复用 [设置核验](../mini-photo-provider-settings-2026-10-12.md)，备案依据不得虚构为固定快照专属批准。[PIPIA 草稿](../mini-photo-pipia-2026-10-12.md) 的公司责任人审阅与剩余风险决定尚不能用本候选的 `approved` 代替。
2. **将现有正式链路限制到真实测试身份。** 复用现有微信 AppID、正式账本、凭据与会话密钥；不新建支付架构、不复制沙箱余额、不在本文放入凭据或用户标识。按已有配置合同装配 `XPAY_ENV=0`、`XPAY_MODE=merchant_test`、真实 `XPAY_TEST_USER_IDS` 和 `XPAY_REFUND_OPERATOR_USER_IDS`；仅用于允许名单验收。开启生成时须同时有既有 process/cleanup 调度和对账，不能只改一个能力标记。公开用户仍关闭，不能把 `merchant_test` 描述成不会扣款的沙箱。
3. **核对同一商品和回调目的地。** 现有 `photo10` 候选为 990 分、10 次、365 天、非自动续费；正式微信道具应与之逐项一致，目的规则限定 `photo-effect:natural-avatar` → `photo`。还需实证正式订单回调与同一账本相连。URL 参数灰度只影响携带参数的请求，微信支付通知不会自动携带客户端灰度参数；不能只凭客户端路由成功就开始真实付款。上述策略 JSON 不含商品价格、支付开关或路由变更。
4. **发布本地修复后完成原生客户端一条闭环。** 将已验证的按用户 capabilities/catalog 门禁及标识避让修复纳入新候选包，并核对包中字体、归一化与标识运行环境。云端既有闭售探针不等于该新包已发布。再按允许名单验证微信登录、必要授权、上传、制作、可见标识、交付扣次、保存、作品删除/到期清理，以及同一正式订单的剩余权益退款；以实际状态验收，不补造成功记录。无需为重复证明同一虚构样本的像素完全不变再引入供应商或额外架构。

这四项是候选装配与商测缺口，不是追加采购清单。公开收费还须依据实际微信审核、已配置资料和正式闭环结果决定；本说明没有更新 PIPIA 批准状态或云端开关。

## 离线校验范围

仅调用 `photoCandidateConfig` 的纯配置校验：传入显式的 synthetic 固定环境对象、闭售模式、全部任务开关关闭、合成密钥占位及本候选实际 SHA。该函数不读取 dotenv、不连接 MySQL、不启动服务或 SDK、不调用模型、审核和支付。占位只用于离线语法及绑定验证，不进入部署配置，也不构成真实身份或合规事实。

额外逐项比较：唯一效果与 v2 参数一致；技术报告与独占日志最终 report 对象一致；规格哈希与报告绑定一致；保留时长、上传限额和清理配置与原闭售策略一致；版本、provider/model 与实际报告一致。缺少真实公开资料时，离线结果应保持 `pending_company_approval`、购买与生成关闭，不能为了使状态通过而编造披露。

2026-10-13 实际执行上述离线校验通过；另确认错误文件摘要会被 `PHOTO_CANDIDATE_PINNED_FILE_MISMATCH` 拒绝。实际结果为 1 个效果、公开资料状态 `pending_company_approval`、购买/生成/process/cleanup/reconcile 均关闭。未读取 `.env` 或调用外部业务。策略 JSON SHA-256：`d3e3292cf66920065afe4bdcd20885662c8e9d5d35b0d943980d2dbf583d86a1`。这是配置结构与来源绑定的离线验收，不是部署、真实客户端或正式商户验收。
