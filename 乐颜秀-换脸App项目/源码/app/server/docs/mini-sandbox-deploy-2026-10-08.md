# 现有 buildtest 的受控沙箱部署

`scripts/deploy-mini-sandbox-cloud.mjs` 管理既有独立支付沙箱 API 的固定受控发布。默认 `status` 与各 `plan` 动作只读；不创建服务、不执行 SQL、不重置密码、不修改消息推送或客户端，不使用旧 App 配置。仅接受既有微信环境、AppID、私网数据库及专用账号；所有版本固定 `env=1`，旧 `deploy/upgrade` 保持 `closed`，新增固定 009 来源的 `deploy-next` 可显式选择白名单沙箱联调。入口仍为 MINIAPP，公网保持关闭，容量沿用 `min=0/max=1`。

部署前由 DMC 核实实际备份、13 表结构、环境绑定、账号最小权限及私网连接策略。控制面数据库预检不是 SQL 登录或结构验收。凭据在本机 `.env.mini-payment`、`.env.mini-cloud`；本地 `XPAY_ENABLED=false` 保留，仅在上传云端的内存白名单中设为 true 以初始化 API。商品、用途与补偿调度均保持关闭。秘密不进入代码包、命令参数或输出。

在 server 目录使用项目 Node 22：

```powershell
node scripts/deploy-mini-sandbox-cloud.mjs status
node scripts/deploy-mini-sandbox-cloud.mjs plan --bundle 'D:/JT/乐颜秀/workspace/乐颜秀-换脸App项目/源码/app/output/mini-payment-sandbox-20261008-r6'
```

只有 `planReady=true` 后才根据本次输出的真实 `manifestSha256` 和 `expectedVersion` 执行；不能照抄旧版本编号或示例散列：

```powershell
node scripts/deploy-mini-sandbox-cloud.mjs deploy --bundle '<本次候选绝对目录>' --manifest-sha256 '<本次核验的64位SHA256>' --expected-version '<本次当前buildtest版本>'
node scripts/deploy-mini-sandbox-cloud.mjs status
node scripts/deploy-mini-sandbox-cloud.mjs verify-public
```

打包仅取固定 21 个清单文件及 manifest，并对内存中的原始字节核验；候选目录中即便存在 node_modules 或额外文件，也不会进入 ZIP。部署不修改本地候选。发布采用官方 SDK 的 taskId，`submitted=true` 只代表提交得到确认。状态检查按同一 taskId 核对任务及版本、配置、流量和入口；它不会补写本地记录。`controlPlaneDeploymentVerified=true` 仍不等于微信私有入口、数据库登录或支付验收完成。

`verify-public` 只访问控制面返回的本服务域名，确认 `/health` 及模拟的云回调请求均由公网入口拒绝（403）。它不把 403 当作应用健康，始终保留 `privateHealthVerified=false` 和 `databaseLoginVerified=false`。私有健康需微信开发者工具或真机通过 `wx.cloud.callContainer` 验证：`/health` 应为 `mini-payment-sandbox/closed/realMoneyAllowed=false`，产品 `available=false`，未登录权益接口 401，管理员接口 403；真实登录、权益读写和订单验收另行进行。

`plan` 与 `deploy` 的就绪判断也执行上述两条公网拒绝检查，不能只凭配置中的 MINIAPP 声明通过。部署在修改基础配置后、提交发布前分别复查；任何非 403、网络超时或入口漂移都会停止后续操作。实际 API 允许基础配置 `port=0` 且省略 `publicAccess`，但必须同时有两个 MINIAPP 入口声明、活跃版本 `containerPort=3000` 和真实公网拒绝证据。基础配置的 SDK 身份字段原样保留。

私有 `.env.mini-sandbox-deploy.backup.json` 保存不可覆盖的部署前完整配置；`.env.mini-sandbox-deploy.pending.json` 保存状态；两者均检查 Git 忽略、在写入秘密前设置 Windows ACL 并 fsync。独占 `.env.mini-sandbox-deploy.lock` 防止同时执行写入；进程崩溃遗留的锁需要核实后处理，不自动删除旧锁。

## buildtest-008 的一次修复升级

`plan-upgrade` 和 `upgrade` 仅接受已经确认完成的操作 `cae5e3f718c02708f500b31f`、任务 `2306400`、版本 `buildtest-008`。这是对该版本的一次受控修复，不是通用连续部署入口。先使用 `plan-upgrade --bundle '<候选目录>' --manifest-sha256 '<本次哈希>' --expected-version buildtest-008` 核对；只有其 `planReady=true`，才以相同参数执行 `upgrade`。

升级要求原 pending 为 `submitted`，同一任务已完成且无失败步骤，活跃版本独占流量，remark、全部基础配置、原版本集合、数据库私网状态均相符；新白名单环境变量必须与上次逐值相同，候选清单哈希必须不同。打包后再次只读核对原任务与配置，并复验两条公网 403。升级不提交基础配置修改，不更换密钥；只上传新代码包并发布。升级后的 rollback 回到 `buildtest-008`。

只有这些证据全部通过，才在独占锁内归档原记录。原 backup 与 pending 完整内容合并到 ACL 私有 `.env.mini-sandbox-deploy.confirmed-<原操作ID>.json`，先写临时文件并 fsync，再原子 rename 发布，已有归档绝不覆盖。替换固定 backup/pending 前先持久化 `.env.mini-sandbox-deploy.archive-intent.json`；新记录、旧归档全部复核后才删除 intent。中间任何失败或进程崩溃均保留 intent，后续命令返回 `ARCHIVE_REQUIRES_REVIEW`，不会继续上传、重发发布或再次归档。两份固定文件不能一起原子替换，因此 intent 是必须保留的中断标记；禁止手工删除它来绕过核验。该情形需核对 intent 中的散列、归档及两份现存记录后单独恢复，本脚本没有自动恢复或自动重试入口。

每次改配置、申请上传、上传、发布或回滚前先保存 requested 状态。响应未知、未返回有效 taskId 或确认记录保存失败时停止。重复 `deploy` 不会重发请求，也不会覆盖快照。不得删除 pending/backup 来强行重试；应先通过只读状态核对实际结果，再审阅恢复步骤。一个快照只用于一次受控升级。

可运行 `node scripts/deploy-mini-sandbox-cloud.mjs reconcile` 取得只读核对报告。它比较当前配置、活跃版本、版本集合及最近任务与记录，始终不写本地状态、不调用云端变更、不归档记录，也不允许自动重试。超时后某次读取恰好与旧配置相同，不能证明原请求以后不会生效；因此 `observationIsFinalRequestOutcome` 和 `archivalAuthorized` 固定为 false。恢复判断需要结合该请求的最终服务端结果，不能仅把记录改名后重新部署。

需要回退时执行：

```powershell
node scripts/deploy-mini-sandbox-cloud.mjs rollback
node scripts/deploy-mini-sandbox-cloud.mjs status
node scripts/deploy-mini-sandbox-cloud.mjs rollback
```

首次 rollback 在确认发布任务结束后提交旧版本回退并保存回滚 taskId；后续相同命令只查询该任务，确认旧版本恢复后再恢复原基础配置。若构建明确失败且旧版本仍独占流量，则直接恢复配置，不提交旧版到旧版回滚。回滚或配置恢复响应未知时不重复请求；已观察到配置恢复时可仅完成本地确认。不会删表、恢复数据库旧快照、重置账号或开放公网。旧配置回退不代表数据库数据回退。

仅本地隔离测试：`node --test tests/mini-sandbox-deploy.test.mjs`。测试使用虚构配置和云 API 替身；ZIP 与 ACL/文件状态检查在专用临时目录中运行，不连接实际云服务。

## 已确认 buildtest-009 的后续候选

`plan-next/deploy-next` 仅接受原操作 `4144dccb93cb1fee6beb7527`、任务 `2306735`、版本 `buildtest-009` 以及已经记录的 r7 manifest。来源必须是原 008 修复升级链，原 pending 仍为 `submitted`，同一最终任务、版本、remark、全部实际配置与原版本集合重新核验通过；不接受其他服务或通用连续升级。旧记录和旧命令仍可读取，不删除 pending，也不为结果未知的请求开重试口。

`scripts/mini-sandbox-next-profile.mjs` 提供两个固定 profile：

- `closed`（默认）：只更新代码，全部环境变量保持逐值相同，不提交基础配置修改。
- `sandbox-ledger`：仅改变 `XPAY_MODE`、`XPAY_PRODUCTS_JSON`、`XPAY_TEST_USER_IDS`、`XPAY_RECONCILE_ENABLED`。固定 `photo10`、990 分、10 次图片权益、365 天；白名单从本机私有 `.env.mini-payment` 的 `XPAY_TEST_USER_IDS` 加载，要求 1–20 个不同的稳定 `usr_UUID`；启用沙箱补偿调度。用途规则仍为 `{}`，图片生成保持关闭。目录状态必须由操作者另在微信后台核对；计划输出明确保留 `platformCatalogVerified=false`，不冒充平台验收。

本机 `.env.mini-payment` 自身仍保持 `XPAY_ENABLED=false/XPAY_MODE=closed/XPAY_ENV=1`。profile 不会回写它，不复制正式 AppKey、其他服务密钥、任意商品或用途设置。输出只包含测试人数、四个变更键名、固定商品摘要，绝不包含用户 ID 或密钥值。

```powershell
node scripts/deploy-mini-sandbox-cloud.mjs plan-next --bundle '<候选绝对目录>' --manifest-sha256 '<本次64位SHA256>' --expected-version buildtest-009 --profile sandbox-ledger
```

审核精确候选、平台开发商品和本机白名单后，使用相同参数把动作改成 `deploy-next`。该写入动作复用原有独占锁、ACL、fsync、原子归档与 intent 中断保护。打包后再次核实 009 源与公网 403，再归档完整旧 pending/backup；需要配置变化时，先持久化 `configure_requested` 才调用配置接口。每个未知响应均留下请求阶段，禁止重复归档或提交。确认上传和发布仍按原流程完成，rollback 恢复到 009 的代码及原 closed 配置，数据库不回退。

这两个 profile 的代码和隔离测试完成，不代表已运行真实 plan、发布新版本、真实渠道沙箱验收或开放正式收款。
