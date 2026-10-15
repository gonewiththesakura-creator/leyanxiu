# 乐颜秀 Android 内测包（2026-09-05）

## 交付内容

- `leyanxiu-android-debug-v1.0-20260905.apk`：可直接安装的 Android 内测包。
- `leyanxiu-app-icon-source.png`：品牌图标源图。
- `SHA256SUMS`：安装包完整性校验值。
- `Android-APK-高优先级验收清单-2026-09-05.md`：66 项静态验收记录。

## 包信息

- 包名：`com.yibohuaxia.leyanxiu`
- 版本：`1.0.0`（versionCode `1`）
- Android：minSdk `24`，targetSdk `36`
- 大小：`16,788,607` bytes
- SHA-256：`000851B0D9D8C1A961B3162A38216373A976C03A4854C6B2EF4EC9A6491A2560`
- 签名：Android Debug，仅供指定人员内部测试，不可上架。

## 已验证

代码规范、TypeScript、Web 构建、APK 包名/权限、debug 签名、16 KB 对齐、品牌资源、CSP 和包内敏感信息扫描均通过。2026-09-06 强制全量重打包后，66 项 Android 内测检查结果为 `GO / 0 blocker / 2 warning`；两个 warning 均为正式隐私政策和用户协议 URL 尚未提供。

保存和分享前会用作品 `assetId` 刷新短时签名地址，并按服务端 MIME/扩展信息保存为 JPG、PNG、WebP 或视频格式。保存使用 MediaStore，图片进入系统 `Pictures/乐颜秀`，视频进入 `Movies/乐颜秀`；Android 10+ 不申请全量相册权限。生成中的 `taskId` 会持久化，进程重启后查询原任务，避免重复创建和扣费。

## 当前测试边界

本包连接 `http://REDACTED_COMPANY_INFRASTRUCTURE`。2026-09-05 最终构建后的公网健康检查仍不可达，因此登录、生成、作品列表等真实 API 尚未形成端到端验收证据。HTTP 联调只能使用无敏感、非真人测试素材；真人照片必须等 HTTPS 域名上线后再测。

当前机器没有连接 Android 真机，因此相机、系统相册、自动有声播放、保存到系统图库和系统分享面板仍需真机验收。

正式上架前还需公司 release 签名、正式 HTTPS API、HTTPS 隐私政策和用户协议。设备 P-256 密钥 challenge/verify 认证与生成任务中断恢复代码已进入本包，但仍需在正式 HTTPS 环境做真机端到端验证。
