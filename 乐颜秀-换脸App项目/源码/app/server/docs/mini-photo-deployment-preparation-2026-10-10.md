# 原生小程序图片部署准备审计（2026-10-10）

本次仅核对本地源码、Docker 和部署脚本；未读取私有配置值，未部署、购买资源或执行云端 SQL。图片模块本地装配和真实供应商探针是不同验收项；本文不把任一项当作上线完成。

## 打包与镜像的实际范围

| 入口 | 当前事实 | 本轮结论 |
| --- | --- | --- |
| `scripts/build-mini-payment-sandbox.mjs:10` | 固定白名单仅包含支付沙箱及身份迁移文件，没有 `photo-jobs`、`mark-ai.py` | 保持不变；不能用来发布图片服务 |
| `scripts/deploy-mini-sandbox-cloud.mjs:43`、`:115` | 校验完全相同的支付文件清单、manifest scope 和 env=1 | 不扩大旧 manifest 或固定来源链；图片候选需独立制品范围 |
| `deploy/mini-payment-sandbox/Dockerfile:1` | Node 22，仅 CA、支付依赖和 `payments` 目录；启动 mini-sandbox-server | 保留当前 buildtest 行为 |
| `Dockerfile:7`、`:16` | 完整镜像已安装 `python3-pil`、`fonts-noto-cjk`、`fonts-dejavu-core`，`COPY . .` 包含新 JS/Python/SQL | 源码不会因未提交 Git 而被 Docker COPY 忽略；仍需实际候选镜像验证 |
| `.dockerignore` | 排除 `.env*`、数据、私有对象、测试等；未排除 `photo-jobs` 或 `mark-ai.py` | 新模块可进入完整构建上下文；本次未调用上传工具确认归档 |
| `scripts/deploy-cloudbase-stage.mjs:120`、`:204` | 固定 Android staging 配置与完整服务上传 | 不直接复用其配置部署微信原生图片 |
| `scripts/prepare-app-ecs.mjs:19` | 旧账号包只递归 accounts/payments/providers 的 JS/JSON | 不包含本轮图片/Python，且属于旧 Android 路径，保持不动 |

不存在 `requirements.txt`；完整镜像使用 apt 的 Pillow，当前代码不需要再增加 pip 安装。`mark-ai.py:29` 已选择 Linux Noto CJK 的默认实际路径，`:47` 的 `--check-font` 会检查目标中文字形，不只是检查文件存在。本轮已在完整 Docker 的 COPY 后增加 `RUN python3 mark-ai.py --check-font`，构建期即拒绝缺失 PIL/字形的镜像。本机 `python mark-ai.py --check-font` 退出 0，但当前没有可调用的 Docker，**没有容器构建或 Linux Pillow/字体已通过的证据**。完整 Docker 当前 Node 20，而本轮实际测试是 Node 22，候选应明确选择并验证同一运行时；这不构成声称 Node 20 已失败的证据。

`photo-jobs/moderation.js` 直接导入 `@alicloud/tea-util`，原先仅由传递依赖提供。本轮已在根 `package.json` 与 lock 的根 dependencies 中固定现存 1.4.9；没有改动任何已解析包版本、integrity 或安装脚本。去除本轮新增行后，三个修改文件的规范化 SHA 与修改前一致，证明没有夹带其他修改。直接依赖导入与 moderation 模块导入通过；未执行 npm 安装。无需增加新的审核 SDK 或重复实现现有适配器。

## 现有 index 的接线位置与冲突

目前 `index.js` 没有创建、挂载或调度 `createPhotoApplication`。应新增显式关闭为默认的图片运行配置，只有 `RELEASE_CHANNEL=wechat-mini-program`、微信身份、同一个 canonical ledger 及明确选择图片模式时才构造。

1. 身份：复用 `index.js:118` 的 miniIdentityRuntime 和 `:188` 的 miniIdentityMiddleware。`:786` 的微信登录已生成稳定 userId 并与同一本账本绑定；图片模块只使用 `authenticated(c)` 的 userId，不能再造一套账号或从客户端接受 owner。
2. 挂载：在身份 middleware 之后、`:887` 的旧 `/api/consents` 之前挂 application；这样新 consents/catalog/works/asset 路由及旧写入口拒绝优先匹配。现有虚拟支付挂载仍由 `:844` 的 payment service 负责，图片应用不修改销售状态。
3. 启动：`:249` 的旧 objectStore 初始化、`:259` 的旧 tasks 初始化与 retention timer，以及 `:1496` 的全能力 launchReadiness 仍针对旧图片/视频/JSON 索引。只插入新 router 仍可能被这些旧依赖挡住。选择新图片模式后，需以新同库 context/上传/生成/清理及真实政策为准检查其所用能力，不能要求为未开放的视频能力补齐供应商资料。旧渠道保持原逻辑。
4. 目录：新应用已有 `photo-uploads-v1` 与 `photo-jobs-v1`，批准效果来自服务器冻结清单。不能让 `:1570` 的旧 admin catalog 后续覆盖它，不能通过伪造 reviewed/approved 值满足真实审核要求。
5. 调度：应用只提供显式 `runOnce({process,cleanup})`，不自行启动 timer。宿主在 prepare 成功且实际服务启动后使用一个有界串行调度器，避免 setInterval 重叠执行；制作关闭时仍可进行既有清理。未明确开启 worker 时不得产生 provider/Green 调用。
6. 停机：`:2750` 的 shutdown 先关闭 HTTP，停止调度新轮次，再等待 application.drain，最后 flush 和关闭共享数据库。当前 shutdown 65 秒强退、`deploy/compose.yml:43` 的 30 秒 stop_grace_period 均短于 Qwen 单次上限 180 秒及后续审核。真实部署须有明确平台退出窗口；如无法完整等待，原步骤转未知并凭持久 receipt 恢复，不能重新生成。不能宣称仅 HTTP drain 已覆盖后台图片和清理。

`stage-drain.js` 的内部部署 drain 目前只覆盖 HTTP 和旧 flush。新模式也要停止后台调度并排空图片生命周期；application.drain 是终止操作，旧 endpoint 的 resume 不会自动恢复它。最小做法是把该候选的 drain 定义为等待进程替换，或显式重建新的已核验 lifecycle，而非悄然将已 drained 对象当作恢复成功。

## 最小应改文件

- 新增 `photo-jobs/runtime.js`：纯装配入口，传入同库 ledger、固定批准效果/版本/期限、现有存储/供应商/标识/审核和清理端口；生成与自动调度默认关闭。复用已存在 application/media/pipeline，不重写任务系统。
- 修改 `index.js`：上述身份之后挂载、原生新模式启动门禁、显式串行调度和退出接线；由于涉及旧启动副作用与 readiness，多处修改应先独立审查，而不是只加一个 import 即发布。
- 修改候选 Docker/package/lock：包含本轮 `photo-jobs/*.js`、所引用 media-validation、`mark-ai.py` 及实际依赖，保留 Linux PIL/CJK，增加构建期字形检查。完整 Docker 本身不缺这些源文件；支付沙箱 Docker 不动。
- 新增独立图片候选构建 manifest/本地核验入口：精确列入图片、支付与身份所需文件和全部显式迁移 SQL，不复制 `.env`、用户图片或本地数据库。以当前部署为来源核验升级/回滚，但不绕开现支付沙箱 manifest 校验。
- 增加宿主启动/关闭集成测试：模式关闭零 SQL/零供应商调用、旧渠道不变、双协议、同库身份、worker 串行、信号排空/未知恢复。现有 application 26 项可复用，无需重写客户端用例。

本轮完成审计和上述直接依赖、Docker 字形检查两项可逆修复；不修改大型 index、现有部署脚本或当前生产制品。模型合成探针可独立继续，无需等待宿主装配。

## 仍需真实确认的边界

`payments/virtual/runtime.js:15` 的普通入口不接受私网沙箱例外；`mysql-transport.js:28` 又把该例外严格限定为固定现存目标、env=1 和 closed/sandbox。因此当前 buildtest 私网配置不能直接搬到完整 index，更不能只改 env=0。后续数据库传输选择须单独明确：这里是当前实现的门禁，**不是把 TLS 当作微信平台强制要求，也不意味着本轮应购买新数据库**。同样，现存 env=1 账本不能直接重标为正式账本。

新增 DDL、真实镜像、平台实际停机窗口、正式身份/数据库连接、批准效果和协议资料、真实供应商与审核计费合同，均未通过本文的只读审计获得完成状态。已经通过的是本地模块合同及替身网络下的完整链路；云端与正式发布保持原状。

主线保留四个阶段：真实 adapter 合成探针 → 受控图片宿主/制品及同库增量 → 真机用户图片与付费交付 → 正式资料、商品和提审。本文不展开新平台或新数据库选型。
