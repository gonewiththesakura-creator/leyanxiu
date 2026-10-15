# 首发自然头像的单次效果验收准备

2026-10-13 先完成下述本地准备，随后用户明确授权本次人像验收，实际执行 1 次编辑及 2 次审核，未自动重试。技术管线通过、临时对象清理观察通过，但主任务与独立子任务一致认定视觉质量失败：输出新增明显眼周及口周纹路，年龄观感漂移。该效果仍不得开售，授权额度已用完。结果见 `../evidence/mini-photo-natural-avatar-v1-2026-10-13.json`。

以下保留本次执行前的固定范围及离线验收方法。用户选择由 GPT 中转站生成虚构成人头像；输入生成与本次编辑验收分开记录，不重放以前 v4 的按次额度和日志。

## 固定范围

- 输入：工作区 `output/imagegen/fictional-adult-avatar-20261012.jpg`，768×1024 JPEG，133,268 字节，SHA-256 `56eb47602d36864b6eec9514ddb091cfa2b71309558c3e12917b3970329b947f`。
- 经项目真实归一化端口处理后的 SHA-256：`f71c5d5a76157abfc260125935667e93370235f8caf296842202bdbf825cf018`，206,503 字节 JPEG。
- 效果：`natural-avatar` / `natural-avatar-v1-20261012`；固定 `qwen-image-2.0-2026-03-03`，参数逐项匹配 `production-config/first-service-candidate-2026-10-12.json`，没有历史渐变测试的 seed42。
- 包含 provider、model、effectParameters 的完整规格 JSON SHA-256：`6d379e5fac87ab8fd387c1d5fe5f1deec8ffdbf2c28874bb4ec3f40c4330d15c`。这是完整规格摘要，不是仅参数对象的摘要。
- 输入 baselineCheck 1 次；编辑最多 1 次；标识、私有存储读回；输出 aigcCheck 1 次；保存本地结果；删除并观察本次准确对象键。任何失败或未知响应均不自动重试、不改模型、不补生另一张。
- 新独占日志：`data/photo-avatar-generation-natural-avatar-v1-20261012/intent.jsonl`；默认检查不创建它。已有目录将阻止再次执行。保留历史 v4 日志不变。
- 预览预定为 `evidence/mini-photo-natural-avatar-v1-20261012.png`。不购买、不退款、不改云配置、不开放用户生成或销售。

## 实际本地验证

`node scripts/probe-photo-avatar-natural.mjs --check` 通过，只读取固定素材和候选，实际运行图片归一化，无凭据读取、网络或云端写入。

`node --test tests/photo-avatar-probe.test.mjs` 7/7 通过：默认路径的凭据/网络拦截、素材和参数漂移、JPEG 输入及 PNG 输出精确绑定、错误后缀/错误清理引用/回执丢失、审核拒绝、持久日志失败、模型响应丢失不重试及 SDK 重试关闭。

共用有上限管线提取后，`node --test tests/photo-generation-probe.test.mjs` 原有 10/10 通过，包括旧版本禁止执行、输出写入未知、输出篡改、清理未确认和回执诊断脱敏。没有执行付费分支。

## 费用与人工验收边界

2026-10-13 查询官方价格：固定模型北京版本 0.2 元/张；baselineCheck 与 aigcCheck 基础价均 15 元/万次。因此模型及两次基础审核预计 0.203 元，另计少量 OSS 请求/流量及账号已开通的审核附加能力；不是供应商账单硬上限。

来源：[固定模型价格](https://help.aliyun.com/zh/model-studio/qwen-image-2-0)、[图片审核增强版计费](https://help.aliyun.com/zh/document_detail/467826.html)。本次已执行，独占日志已存在，不得再次执行该入口或删除日志绕过限制。

验收需并排检查输入与实际输出：单人、五官与年龄观感、头发及肩部裁切、干净背景、自然柔光、可见 AI 标识与输出可解码。输入 3:4、输出 1:1，不能忽略构图变化。程序通过不自动将 `qualityAccepted` 改为 true。

通过最多证明该虚构头像样本在固定模型和参数下的效果及适配器流程，不能代替真人身份保真、任意用户效果、Android 完整操作、云 Linux 容器输入处理、正式 env=0 交易退款或微信平台批准。
