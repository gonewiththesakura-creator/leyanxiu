# 乐颜秀原版小程序业务契约与后续接线

2026-10-14，本文件记录本地原版适配的实现边界，不代表上传、提审、发布或全量收费已完成。

目标保持原版黑底粉色的推荐、视频玩法、精选、百变图片、我的五栏目及原有素材。验收页只能作为业务组件来源，不能替代原产品。浏览范围与已验证交付范围必须分开表达；未接通的创作功能仍是待完成工作，不能通过隐藏功能宣布整个产品完工。

## 已落地的最小契约

`miniprogram/business-adapters.js` 不创建新的支付或作业客户端，不发送请求，也不写存储。

| 行为 | 事实来源 | 禁止的推断 |
| --- | --- | --- |
| 浏览模板和效果 | 原版 catalog 与打包公开素材 | 有预览图不代表能制作 |
| 制作某个效果 | `creationClient.refresh()` 的已核验 snapshot，同一效果的 included/available，随后 `generate()` 再检查服务端当前状态 | 任一效果可用不代表全部效果可用 |
| 发起购买 | 既有 `payments.js` 当前服务端产品、平台范围、规则版本和明确金额确认 | 卡片、预览或制作失败不能自动触发支付 |
| 支付到账 | 服务端查询同一订单后的状态与权益 | 微信客户端返回 success 不代表到账 |
| 制作交付 | 持久作业 succeeded，同一 assetId 的私有地址及可访问作品记录 | queued、result_ready、HTTP 202 不代表已交付 |
| 退款/删除/注销 | 对应服务端回执；部分清理和人工申请须如实表达 | 提交成功不代表到账或所有副本已删除 |

当前实际策略文件 `docs/production-config/natural-avatar-merchant-policy-2026-10-13.json` 的效果 **id 为 natural-avatar**；`natural-avatar-v2-20261013` 是独立的 version。适配器唯一绑定是原版 `natural-avatar → natural-avatar`。测试直接读取该策略检查 ID，防止把验收版本误作效果 ID。未知 ID、服务端 ID 冒充本地 ID、重复冲突项、非布尔可用标志全部关闭制作。原版卡片不会自动变成自然头像。

`pages/create` 的 URL effectId 是明确选择：服务端不再提供这个 ID 时保持不可用，不能改选第一个可用效果。`view=works/privacy` 仅映射到两个固定页面锚点。实际提交仍通过原有账号隔离、持久幂等、独立照片授权和查询恢复链路。

只浏览/核验页面使用 `client.setActive(false)`。这是必要边界：既有 `creationClient.refresh()` 会恢复已授权的待处理上传，在 active 状态下可能继续原制作任务；照片列表及我的页面不能把“查询”误作继续制作。进入创作页才按原任务协议继续恢复。

## 其余效果的最短复用路线

当前图片队列已经可接收多个 approvedEffects；`application.js`、`context.js`、`repository.js` 负责白名单、效果版本固定、权益预占和持久任务；`generation-pipeline.js` 已处理单次调用、结果私有化、AI 标识、输出审核和清理。不应为每张效果卡再建一条 HTTP 同步付费调用链。

| 原版剩余效果 | 现有实现可复用处 | 当前缺口与下一步 |
| --- | --- | --- |
| 九十年代港风、八十年代留影、经典黑白照、宋韵雅集、敦煌飞天、新中式肖像、海派旗袍、现代漫画像、温润水彩像、经典油画肖像、铅笔素描像、破损旧照修复（12项） | `photo-effects.js` 的固定效果定义；`photo-jobs/qwen-provider.js` 与持久生成管线 | 可逐项建立服务端固定参数/版本，接入同一图片队列，核验实际效果、模型/审核费用和交付，再扩大 approvedEffects 与逐项客户端绑定。旧 prompt 不是已验证效果承诺，不能直接复制自然头像验收证据到其他效果。 |
| 年龄变化 | `index.js` 的 `/api/photo/effect` age 分支；`providers/viapi.js` 检测；`providers/tencent-ft.js` | 原型已有检测和年龄模型调用；当前生命周期只接受固定 Qwen provider/model，不能仅改 effect ID。需明确原产品年龄选择规格、持久化两个供应商步骤并补相应审批/审核/成本证据。 |
| 老照片清晰修复、黑白照片上色 | `providers/viapi.js` 的 enhanceFace/colorizeImage；`index.js` 同名分支 | 可复用供应商功能，需把调用包装成可审计的队列端口，补输出类型、私有存储、标识及审核契约；不得绕过当前生命周期的模型限制。 |
| 高清放大 | `providers/wanx.js` 的 editImage/super_resolution；`photo-effects.js` | 原路径为异步供应商任务。需持久保存供应商 taskId 后只查询恢复，不能把超时作为再次提交许可；补尺寸/存储上限和费用验收。 |
| 经典歌曲 jinqu、夜景唱歌 street、轻松跳舞 dance、暖心语录 quote（4视频） | `video-template-config.js`；`index.js` `/api/fusion`、查询、持久任务与输出处理；主要供应商实现为 `providers/aliyun.js`，另有 `providers/tencent.js` | 复用原模板和供应商调用，不另造视频内容。旧入口先提交供应商再保存任务，中间故障存在重提风险；需补提交意图与供应商任务恢复、视频审核与标识、权益规则、保存/删除及实际交付。street 为约25秒，不可盲套另一供应商20秒限制。现有图片管线限定 image/*，不能直接当作视频管线。 |

当前原生宿主明确拦截旧 `/api/photo/effect`、`/api/fusion` 等写入口为 `PHOTO_NATIVE_ASYNC_REQUIRED`。这些拦截不在本次 UI 恢复中撤销。图片生命周期的验收证据当前绑定自然头像；增加效果必须补对应证据，而不是更改 ready=true 或添加客户端虚构价格。

## 本轮对抗验证

新增 `tests/miniprogram-business-adapters.test.mjs` 12项：错误映射、未知/原型键、相互冲突的可用性、全部视频只预览、陈旧可用性、双击制作、未知结果重试、双击支付、账号切换、URL效果不替换、效果停用、固定页面锚点。调用真实原生 clients 配内存 wx 传输，不接触外网、供应商、云数据库或真实资金。

独立对抗审查又确认并修复了三个页面问题：`view=works/privacy` 原来仍会恢复制作、`onShow` 可越过初次隐私等待、隐藏期间的异步授权/照片读取/刷新可写回旧状态。现在两种管理入口固定只读，账号读取等待平台隐私授权；隐藏使旧回调失效并清除页面私有素材。使用真实 creation client 验证只读恢复不会发起 job POST，同时覆盖四个照片异步阶段及新旧刷新竞态。

套餐页亦统一接入原生隐私门：拒绝时零登录、零订单读取；晚到授权、登录、列表及退款响应不能写回新页面；离页后才完成的付款/退款确认不提交。已有确定支付保留原客户端的持久待核协议，不能误当取消交易。独立只读复审确认上述问题关闭。

既有 creation、payment、service、refund-operations 加新 adapter 五套测试，共191项通过。两处原测试夹具补齐已核验 effectAvailable 状态，保留新入口检查。原生视频另有独立缓存/生命周期回归。官方模拟器与真实手机、用户本人支付/交付/退款、平台提审状态分开验收。

## 接通顺序与实际阻碍

第一批接经典黑白、新中式、现代漫画、水彩，复用现有固定 Qwen 图片队列。生产准备脚本 `scripts/prepare-mini-production-merchant-test.mjs` 当前只接受 natural-avatar，套餐适用效果也只登记该项；必须扩展为逐效果清单与对应验收记录，不能只改客户端卡片。之后接同供应商其他固定图片效果，再接需要不同供应商步骤的年龄/清晰/上色/放大。视频先经典歌曲，再暖心语录、跳舞、夜景唱歌；全部原目录保留。这是接线顺序，不是用户批准缩减产品范围。
