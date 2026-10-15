# 原 App 能力恢复核对（2026-10-15）

本记录来自当前源码和本地历史产物的只读核对。未读取 `.env`，未调用云配置、供应商、支付或 IDE；不能据此认定当前供应商凭据、授权模板、部署状态或效果质量已经验收。

## 结论与证据边界

原 App 的百变图片有 17 个效果，视频有 4 个玩法，均存在真实后端执行路径。当前小程序仅接入固定 Qwen 图片链路的自然 AI 头像、现代漫画像、温润水彩像；3 个效果不等于完整原产品。其余 14 个图片效果和 4 个视频创作不是简单开关问题，不能以 `false -> true` 或放宽验收规则代替接入。

本地找到 15 个精确效果 ID 的历史成功摘要及非空 PNG，另有 `age-70` 年龄变体，以及相关的 `old-photo-restore` 修复成品。摘要记录供应商和成功状态，但没有当前逐效果参数哈希、完整调用回执和当前质量复审绑定；历史成功不能直接授权当前版本上线。

原前端仅在显式 `VITE_USE_MOCK=true` 时调用 `compositeFace`；该模式的图片和视频入口都返回静态合成图。默认真实请求失败不会自动降级为演示。另有 `VITE_APP_ACCOUNT_ONLY` 账号模式限制。未读取实际构建环境，不能把演示或账号模式当作当前线上配置。

## 原处理结构

- 入口：`src/views/Custom.tsx`、`src/data/effects.ts`、`src/data/templates.ts`。
- 上传、年龄选择、生成和结果：`src/views/Flow.tsx`；分发：`src/lib/api.ts` 的 `generateCreation` / `generateFusion`。
- 图片定义：`server/photo-effects.js`。13 个生成式提示词效果，另有年龄变化、清晰增强、上色、高清放大 4 个专用分支。
- 原图片路由：`server/index.js` 的 `/api/photo/effect`、`/api/photo/age`；已发布启用效果由 `server/admin-store.js` 解析。
- 原视频路由：`server/index.js` 的 `/api/fusion` 及任务查询；模板解析为 `server/video-template-config.js`。

下表中的 G 表示原生成式分支：Seedream 图片编辑优先，异常时尝试旧 Qwen 编辑。这个历史 fallback 行为不应直接复制到新持久任务链路：首次调用结果未知时不能自动再次付费生成。

## 17 个图片效果逐项映射

| 原入口 / ID | 原执行器 | 历史本地证据 | 当前小程序缺口与复用路径 |
|---|---|---|---|
| 年龄变化 / age-change | `/api/photo/age`，阿里 DetectFace 后腾讯 ChangeAgePic | R18 `age-70.png` 与摘要；不是同 ID 的当前验收 | 未接入年龄参数及专用执行器。复用检测和变龄模块，恢复年龄选择，绑定实际目标年龄 |
| 九十年代港风 / hong-kong-90s | G | R18 同 ID 成功摘要和 PNG | 未开放；复用原提示词与 Seedream 适配器 |
| 八十年代留影 / vintage-80s | G | R18 同 ID 成功摘要和 PNG | 同上 |
| 经典黑白照 / classic-black-white | G | R18 同 ID 成功摘要和 PNG | 本次 Qwen 技术通过但视觉增龄被拒绝；应比较原 Seedream 路线，不能复用被拒绝报告放行 |
| 宋韵雅集 / song-portrait | G | R18 同 ID 成功摘要和 PNG | 未开放；复用原提示词与 Seedream 适配器 |
| 敦煌飞天 / dunhuang | G | R18 同 ID 成功摘要和 PNG | 同上 |
| 新中式肖像 / new-chinese | G | R18 同 ID 成功摘要和 PNG | 本次 Qwen 技术通过但视觉增龄被拒绝；优先比较原路线 |
| 海派旗袍 / cheongsam | G | R17 同 ID 成功摘要和 PNG | 未开放；复用原提示词与 Seedream 适配器 |
| 自然 AI 头像 / natural-avatar | G | R17 同 ID 成功摘要和 PNG；另有当前 v2 独立证据 | 当前 v2 主要柔化背景并保留原人物服装，比原专业头像/头肩构图更窄；保留历史版本，完整能力需独立新版本 |
| 现代漫画像 / modern-comic | G | R17 同 ID 成功摘要和 PNG | 当前 Qwen 版已接入，不等于原 Seedream 版；保留当前绑定，比较原成品后决定是否恢复供应商 |
| 温润水彩像 / gentle-watercolor | G | R18 同 ID 成功摘要和 PNG | 同上 |
| 经典油画肖像 / classic-oil | G | R18 同 ID 成功摘要和 PNG | 未开放；复用原提示词与 Seedream 适配器 |
| 铅笔素描像 / pencil-sketch | G | R18 同 ID 成功摘要和 PNG | 同上 |
| 老照片清晰修复 / face-enhance | 阿里 EnhanceFace | R18 同 ID 成功摘要和 PNG | 未接入；复用 VIAPI。EnhanceFace 不等于划痕破损修复 |
| 黑白照片上色 / natural-color | 阿里 ColorizeImage | R18 同 ID 成功摘要和 PNG | 未接入；复用 VIAPI |
| 高清放大 / super-resolution | 万相异步编辑，function=super_resolution | R18 同 ID 成功摘要和 PNG | 未接入；复用提交/查询函数及专用功能参数 |
| 破损旧照修复 / scratch-repair | G，专用划痕/折痕/污渍修复提示词 | R17 有相关 old-photo-restore 成品，但不能确认为同 ID、同提示词证据 | 复用修复提示词与编辑模型，补精确版本证据；不能以 EnhanceFace 冒充 |

历史目录均相对项目根目录：

- `output/photo-eval-r17/summary.json`：natural-avatar、cheongsam、modern-comic、old-photo-restore，记录 `doubao-seedream-4-0-250828`。
- `output/photo-production-r18/generative-summary.json`：9 个生成式效果，记录 `volc-seedream-4.0`。
- `output/photo-production-r18/dedicated-summary.json`：face-enhance、natural-color、super-resolution、age-70。age-70 项未记录 provider 字段，不能补写为已证明的供应商回执。
- 同目录存在对应非空 PNG。部分 Qwen PNG 没有该摘要对应条目，不能因为文件存在就添加成功结论。

## 4 个视频玩法逐项映射

| 原入口 / ID | 原执行器与模板 | 历史证据及限制 | 当前缺口 / 最短复用 |
|---|---|---|---|
| 经典歌曲 / jinqu | `/api/fusion`，独立模板 ID 或 URL，可选遮挡 mask | 有预览资产；本轮未找到同 ID 完整生成验收记录 | 目前仅预览；复用原供应商提交/轮询和模板解析，补原生视频任务、存储与结果页 |
| 夜景唱歌 / street | 同接口，夜景模板 | 描述约 25 秒；原腾讯适配器注释限定 ≤20 秒，不能无条件切腾讯 | 同上，并校验真实模板时长与供应商限制 |
| 轻松跳舞 / dance | 同接口，舞蹈模板 | 有预览资产；本轮未找到同 ID 完整生成验收记录 | 同上 |
| 暖心语录 / quote | 同接口，语录模板 | 存在 `output/r12-quote-fusion-e2e.mp4`，3,855,697 字节；文件自身不能证明当前模板和供应商配置 | 同上，复核历史任务与模板绑定 |

四个玩法共享视频人脸融合，不是四套独立唱歌、跳舞或文本转语音生成模型。默认预览视频不会自动成为生成模板；真实生成需要已配置模板 ID/URL、发布状态和授权条件。

`server/providers/aliyun.js` 实现 MergeVideoFace / MergeVideoModelFace 与 GetAsyncJobResult；`tencent.js` 实现 SubmitVideoFaceFusionJob / DescribeVideoFaceFusionJob；`volcengine.js` 有 HTTP 提交/查询封装。本轮只确认代码实现，没有核实第三方当前接口可用性。

原视频结果流程还有任务持久化、输出审核、标记、存储、失败退款，以及可选 FFmpeg 遮挡回贴。它们可以复用，但必须与当前原生身份、权益预留和未知任务恢复衔接，不能只接一个生成 POST。

## 当前生产小程序为何不能直接开启

1. `miniprogram/business-adapters.js` 固定映射 3 个图片 ID，4 个视频均只预览；目录资产齐全不等于执行已接入。
2. `miniprogram/creation.js` 当前提交图片资产 ID 和效果 ID，没有年龄参数、视频模板或视频结果协议。
3. `server/photo-jobs/candidate-server.js` 只实例化当前 Qwen provider；`generation-lifecycle.js` 校验固定供应商和模型，`generation-pipeline.js` 是图片链路。
4. `server/scripts/build-mini-photo-production.mjs` 的封闭清单没有旧 `server/index.js` 和 Seedream、VIAPI、腾讯年龄、万相、视频供应商模块。需要有目的地扩展依赖及构建，而非仅修改配置。
5. `server/docs/production-config/original-effects-merchant-policy-2026-10-15.json` 与逐效果验收 bundle 仅允许 3 项。不能将单项通过报告用于其他效果，也不能改原始报告的 `passed` 或质量结果。

本次 4 个新效果测试的技术/视觉证据见 `server/evidence/mini-photo-original-effects-visual-review-2026-10-15.json`：经典黑白照、新中式被拒绝；漫画和水彩被接受。该审核范围为单个虚构成年人样本，由 agent 视觉复核，不是人工认证或广泛人群验证。

原 `server/provider-registry.js` 另有 30 个去重样本的历史 capability gate。本地默认 `server/evidence/capabilities` 只找到说明文件；这不代表从未真实运行，也不证明其他挂载路径缺少证据，更不应擅自变成此次恢复的新审批门槛。

## 最短原能力复用路径

1. 复核上述历史成品和调用实现，优先复用已存在的 Seedream 提示词链路与专用模型；按真实供应商结果协议建立适配器、参数版本和逐效果证据，不把所有功能改写成普通 Qwen 提示词。
2. 保留当前账号隔离、权益预留、幂等键、未知任务不重放、输出审核/标记/私有存储及退款机制。只扩展必要执行器与输入参数；不要把旧 monolith 整体接到当前账本。
3. 年龄变化恢复目标年龄选择（原 UI 提供 20/40/60/80，原后端接受整数 1–120），实际可开放范围由新参数契约明确，不能只用固定 60 岁效果顶替。
4. 视频复用原模板/供应商/查询/后处理模块，增加原生持久任务和视频结果展示；核实实际模板授权、时长及供应商限制后分别验收四项。
5. 统一完整目录、制作、生成、结果、购买返回旅程。原 `Custom` 黑粉目录与旧 `Flow` 浅灰蓝色制作页本就存在样式分裂；复刻旧制作页不能满足用户要求的完整原版黑粉体验。

以上为实施依据，不授权云写、收费调用或发布。本轮产品纠偏已暂停购买测试和提审；最终恢复应按完整能力及实际界面验收，不能以三项小范围商测替代原产品交付。
