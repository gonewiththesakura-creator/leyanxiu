# 输入归一化补丁正式闭售制品

2026-10-12。初始封装只生成及校验本地构建上下文；下节另记随后真实云端构建和闭售客户端验证。冻结 014 及其私有发布 journal 均保持原样，不能将后续 015 的验收归入旧 014。

制品目录：`D:/JT/乐颜秀/workspace/candidate-artifacts/mini-photo-production-20261012-input-clean`。

- manifest SHA-256：`347f8f8ec7889d1cc19adb1c256857780c9e2fa6fbf61e348b84d6e8efa539ed`。
- 清单包含 55 个文件，共 544334 bytes；另有 manifest 自身。构建及独立 `--verify` 均成功。
- 默认 env=0、closed；购买、生成、任务处理、清理、对账均关闭；不含私有配置。
- 014 原 manifest SHA-256 仍为 `7e3a92b6a0a792e9e29a04d4f2180cc5e7546fc9a8493d2b9bdaac6d457e10b6`；其全部 53 个清单文件重新逐字节摘要核对，无不匹配。

相对 014 新增 `normalize-photo-input.py`、`photo-jobs/input-normalizer.js`。修改 `.dockerignore`、`Dockerfile` 及 `photo-jobs/` 下的 `application.js`、`candidate-server.js`、`production-bootstrap.js`、`production-server.js`、`upload-repository.js`、`upload-routes.js`、`upload-service.js`。没有删除原清单文件。

除照片输入归一化及其运行接线外，本包也包含已审查的独立 `XPAY_ACCEPTANCE_BASE64/SHA256` 原始报告物化支持。该支持不生成验收结论、不更改支付证据校验器，也不开放购买。

## 后续实际部署与闭售客户端验证

本制品已由独立刷新流程构建为 `buildtest-015`。官方发布任务 2337711 的构建步骤完成，新发布单 2832312 关联 CurrentVersion=buildtest-013、ReleaseVersion=buildtest-015；精确 URL 参数测试配置已保存并经只读准备器核对。没有点击“灰度上线”，默认仍是 013 的 env=1 closed。015 的 env=0 closed 配置沿用 014，包括既有会话加密密钥；灰度值与完整配置只保存在限权私有 journal。

2026-10-12 12:12:09（北京时间），官方微信开发者工具通过项目实际 `payments.js` 客户端完成闭售探针。所有调用统一经过私有参数路由：health 确认 env=0 closed 后，进行一次真实微信身份登录，读取目录、公开资料、能力、商品、权益、作品、订单、退款八项，再确认退出。共 11 次业务 HTTP 调用，均符合固定请求范围；health 与八项读取均为 HTTP 200。本次身份的作品、订单和退款各返回 0，不代表全库没有其他记录。

公开资料返回联系人及同意版本存在，但文档地址未齐、披露未齐；目录和商品为空、全部能力关闭。这是预期闭售结果，不能据此开放购买。探针没有提交同意、上传照片、生成、内容审核、支付或退款；没有使用真人照片或新增模型/审核计费调用，没有改云配置、上传小程序或发布。登录确实创建了真实身份会话，已确认登出，不能表述为远端零状态变化。

脱敏证据：`../evidence/mini-production-closed-client-2026-10-12.json`；SHA-256 `7a8657410005cb01df7837a0e37db8af139736683d06215e46df6c92db5b3191`。证据的 `result` 与限权运行日志经过 `safeProbeReport` 后的允许字段逐项一致，不含身份、令牌、私有 URL、灰度参数或策略正文。探针不能证明上传、生成、签名下载、支付回调或正式交易链路；不能重跑已有一次性 journal 来制造第二次验收。

## 可重复的完整性核验

从 `server` 目录执行：

```powershell
node scripts/build-mini-photo-production.mjs --verify 'D:\JT\乐颜秀\workspace\candidate-artifacts\mini-photo-production-20261012-input-clean'
```

返回 manifest 摘要必须与上文一致。该命令只验证文件集、摘要、构建策略及导入/依赖闭包；不是 Linux 构建或云端验收。不要用此新版 verifier 强行解释旧 014 的旧 Docker 策略；本次旧包保护使用其原 manifest 和逐文件摘要核对。

## 构建策略与后续边界

补丁已进入新云版本 015，不能通过环境变量使 014 获得新源码。Docker 使用现有固定 Node 22.23.3 amd64 基础镜像，现有 Python/Pillow/Noto CJK 软件包，新增 `normalize-photo-input.py --check` 自检；不新增 npm 依赖。Debian 软件包版本在构建时记录，镜像 digest 不锁定 apt 仓库版本。

先前 Windows 离线测试不证明 Linux 的 256MiB 子进程地址空间限制、8秒 CPU 限制或 0.5GiB 容器总峰值。新镜像必须至少核实归一化自检、运行账号、实际依赖/字体及闭售 health。复杂图片和并发的容器资源验证须在开放图片上传前完成，无需为此调用模型或 Green。

`deploy-mini-production-gray.mjs` 固定了原 013 前继、task 2313130 和首次部署 journal；它不是通用二次发布器。014 发布单已取消，015 由 `refresh-mini-production-closed.mjs` 的独立限权 journal 提交；细节见 `mini-production-refresh015-plan-2026-10-12.md`。不得删除 journal、重用 `prepare`、放宽前继/比例校验或把“灰度上线”当作单纯测试配置。下一次更新仍须记录实际制品和发布单身份，延续已有正式账本会话加密密钥。

本次不重跑已经通过的 211 项组合回归及独立 147 项复审（覆盖有重叠）。后续只针对新构建环境、发布器改动或新失败增加必要验证。小程序资料提交、正式商品、正式 env0 购买—交付—退款、真实效果与平台审核仍是独立门槛，本制品不证明它们完成。
