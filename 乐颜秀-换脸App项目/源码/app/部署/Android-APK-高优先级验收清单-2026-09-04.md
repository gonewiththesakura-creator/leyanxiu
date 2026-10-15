# 乐颜秀 Android APK 高优先级验收清单

> 审核日期：2026-09-04  
> 范围：React/Vite 前端、Capacitor Android 工程、Hono API 的移动端边界  
> 结论：**安装包文件已可交付；端到端封闭测试仍有条件；正式上架为 NO-GO。** 当前 debug APK 可以交给指定测试人员安装，但在真机接入和公网 API 恢复前，不应宣称功能链路已验收，也不得公开分发。

## 一、已经落地并通过静态审核

| 能力 | 当前实现 | 审核结论 |
|---|---|---|
| Android 工程 | Capacitor 8，包名 `com.yibohuaxia.leyanxiu`，应用名“乐颜秀”，竖屏 | 通过；包名仍需公司书面确认后冻结 |
| API 基址 | debug 使用公网测试 API；release 构建强制显式 HTTPS，拒绝本机/私网地址 | 通过 |
| 环境隔离 | release 禁止明文；HTTP 和 mixed content 只在 debug source set 开启 | 通过 |
| App 渠道 | APK 会话传 `channel=app`，不再冒充 H5 | 通过 |
| 隐私前置 | 首启先展示同意/不同意；同意前不创建服务端会话 | 通过内部测试线 |
| 人脸授权 | 上传前有单独勾选、用途、数据类型、24 小时清理及本人/已授权确认，并写入服务端授权记录 | 通过内部测试线；正式版仍缺实际供应商名称 |
| 选图/拍照 | Android 原生相册和相机入口，原图会压到最长边 2000px 再上传 | 静态通过，待真机权限和大图验证 |
| 保存/分享 | 原生文件写入、Android Sharesheet、FileProvider 缓存分享 | 静态通过；当前保存位置是“文档/乐颜秀”，不是系统相册 |
| 返回键 | 系统 Back 先让分享层/设置层消费，再回上一业务页，根页才退出 | 静态通过 |
| 生命周期 | 切后台暂停所有视频，避免后台继续出声 | 通过；长任务进程恢复仍可优化 |
| 状态栏/安全区 | 深色状态栏、非覆盖 WebView、`viewport-fit=cover`、底部安全区 | 静态通过，待打孔屏/手势导航真机验证 |
| 视频兼容 | 活跃预览为 fast-start H.264/AAC；私有对象接口支持 Range/206/416 | 自动检查通过 |
| 错误态 | 断网提示和 React 顶层恢复页 | 通过 |
| 本地数据安全 | Android backup 关闭；FileProvider 未暴露整个外部存储 | 通过 |
| 品牌资源 | 自定义乐颜秀图标、adaptive/round/monochrome 图层及竖屏启动图 | 通过静态与资源目检；待真机检查各桌面遮罩 |

## 二、测试 APK 交付线

### 2026-09-04 产物复核记录

- 产物：`android/app/build/outputs/apk/debug/app-debug.apk`，17,993,232 bytes；最后构建时间 2026-09-05 03:38:15；SHA-256 `4F0E791F30B9AA0C96EDEBB302E86D060D6DA7BC0916306423889D4CDF6CBCAF`。
- `aapt`：包名 `com.yibohuaxia.leyanxiu`；`versionCode=1`、`versionName=1.0`；`sdkVersion=24`、`targetSdkVersion=36`；应用名“乐颜秀”。
- 权限：`INTERNET`、`CAMERA`，以及 Android 10 及以下兼容所需的 `READ_EXTERNAL_STORAGE(maxSdk=29)`、`WRITE_EXTERNAL_STORAGE(maxSdk=29)`；未发现录音、定位、联系人、媒体全库或 all-files 权限。
- `apksigner`：APK Signature Scheme v2 验证通过；证书为 Android Debug，仅限封闭测试。
- `zipalign -c -P 16 -v 4`：通过。
- 包内 `assets/public/index.html` 与同步资产一致，CSP 的 `connect-src`、`img-src`、`media-src` 均覆盖 debug API origin，未发现未替换 token。
- 自动脚本（含本轮对保存/分享边界的对抗式检查）：`node scripts/android-release-check.mjs` 最终输出 `GO / 0 blockers / 5 warnings / 58 checks`。结果文件类型推导与短期签名链接续期缺口已经修复并进入最终 APK。脚本的 GO 只代表工程和 APK 静态可安装性，不代表后端端到端可用。
- 工程质量：`npm run lint` 与 `npx tsc -b --pretty false` 均通过。
- 运行环境：本机 `adb devices` 无在线设备，因此尚无真机安装、相机授权、系统分享、返回键、退后台和自动播放声音的运行证据。
- 联调环境：`http://REDACTED_COMPANY_INFRASTRUCTURE/health` 在本轮检查中 10 秒超时；在该地址恢复前，不能宣称图片/视频生成和保存分享链路已通过。旧 CloudBase 地址虽返回 200，但不应未经确认直接替换 APK 的测试 API。

以下是本轮必须关闭的阻断项：

| 编号 | 当前状态 | 问题与原因 | 完成标准 |
|---|---|---|---|
| T0-01 | 已关闭 | debug APK 已构建并完成产物级检查 | `npm run android:apk:debug` 成功；APK 17,993,232 bytes；58 项自动检查无 BLOCK；包名、版本、SDK、签名、16 KB page alignment 和包内资源均通过 |
| T0-02 | 已关闭 | CSP 已修复并进入最终 APK；图片与视频结果的 API 来源均获允许 | `APK-012`、`NET-007` 通过；包内入口无未替换 token |
| T0-03 | 待运行验证 | 当前电脑 `adb devices` 没有在线设备，尚不能证明 APK 能安装、首启和调用系统能力 | 至少一台 Android 13+ 真机或模拟器完成安装、冷启动、拒绝/允许权限、退后台/回前台、系统返回键测试 |
| T0-04 | 阻断，待服务器上线 | APK 默认测试 API `http://REDACTED_COMPANY_INFRASTRUCTURE` 当前健康检查超时；只证明代码存在不代表公网端口、CORS、资源 Range 和生成接口可用 | 公网 `/health` 可达后，从 APK 内完成一次相册图片生成和一次视频生成，成片可播放、拖动、保存及分享；失败不扣重复次数 |
| T0-05 | 待配置 | 封闭测试模式会给新客户端发试用次数，仅靠 IP 限速不能阻止重置客户端 ID 或换 IP 消耗付费 AI | 公网 API 增加测试邀请码/账号白名单或网关访问控制，并配置供应商日预算、总熔断和费用告警；公开下载前先压低测试额度 |
| T0-06 | 已关闭 | 原生与 H5 现在按服务端 `ext`、Content-Type、data URI 或受信 URL 后缀推导图片/视频扩展名 | 最终 APK 已重建，`SHARE-006` 通过；待真机分别验证 PNG/WebP/JPEG |
| T0-07 | 已关闭 | 结果状态保留 `assetId`，保存与分享前调用 `/api/assets/:assetId/url` 刷新 signed URL，并使用返回的 Content-Type/ext | 最终 APK 已重建，`SHARE-007` 通过；待真机验证旧链接过期后的保存/分享 |

允许延后到正式版、但测试说明中必须披露：

- 隐私政策和用户协议链接未配置时，包内会明确显示“内部测试包”；不得公开分发。
- Android 可能拦截首次有声自动播放。当前策略是尝试有声播放，失败则静音继续并显示开声按钮；不能承诺所有设备打开就自动出声。
- 生成任务 ID 目前未持久化。系统杀进程后用户需要到“我的作品”确认结果，没有精确恢复到生成页。
- 当前“保存”落到 `文档/乐颜秀`。若产品文案要写“保存到相册”，必须改用 MediaStore 并重新验收。
- Android 7-9 的相册权限行为尚未真机验证；若保留 `minSdk 24`，需做兼容测试或缩小支持范围。

## 三、正式上架阻断项

`node scripts/android-release-check.mjs --release` 当前输出 `NO-GO / 11 blockers / 0 warnings / 58 checks`。其中部分阻断由当前包本来就是 HTTP 测试 API + Android Debug 证书导致；这不是给 debug 包改名可以解决的，必须按下表准备正式域名、法律文本、身份方案和公司签名后重新构建 release。

| 编号 | 责任方 | 阻断项 | 为什么 | 完成标准 |
|---|---|---|---|---|
| F0-01 | 公司 + 技术 | 正式 HTTPS 域名、证书和生产 API 尚未定版 | release 已主动拒绝纯 HTTP/IP；当前公网 IP 只能用于 debug | 公司提供已备案域名；技术配置 HTTPS、`PUBLIC_BASE_URL`、精确 CORS，并用正式域名重建 |
| F0-02 | 公司 + 技术 | App 身份流程与服务端 `AUTH_MODE=wechat` 不匹配 | APK 当前只有匿名 session；生产策略会返回 403 | 决定正式身份方案并实现，例如经批准的微信开放平台移动应用 OAuth；或正式批准匿名账户策略并修改服务端生产门禁 |
| F0-03 | 公司 | 隐私政策、用户协议未提供正式 HTTPS 页面 | 首启只有文案而无可访问的批准文件，不能作为公开版 | 法务/公司定稿并发布，提供稳定 HTTPS URL |
| F0-04 | 公司 + 技术 | 人脸处理授权仍使用“页面披露的影像服务商”等泛称 | 用户和审计记录无法知道实际第三方处理者；路由供应商还可能变化 | 页面展示实际处理者法定名称、目的、数据、地域、期限；服务端记录实际路由供应商，不能信任客户端泛称 |
| F0-05 | 公司 + 技术 | 正式签名体系未建立 | 当前 release 输出 unsigned APK；无公司密钥不能升级同一应用 | 公司创建并离线保管 keystore；技术通过安全环境变量/CI 签名，产出可验证签名的 APK/AAB；不得提交密钥或密码 |
| F0-06 | 技术 | 生成中任务未持久化恢复 | Android 在后台可杀死 WebView 进程；重开后若再次创建任务，可能重复扣费且用户找不到原进度 | 持久化 `taskId`、模板和返回页；重启后查询原任务，成功则进入结果页，失败明确提示且不重复创建 |
| F0-07 | 公司 | 包名和版本策略未冻结 | 上架后改包名等同新 App，用户不能原位升级 | 书面确认 `com.yibohuaxia.leyanxiu`、首发 `versionCode/versionName` 和后续递增负责人 |

正式公测前还应完成，但不阻挡本轮内部 APK：

- 持久化生成中的 `taskId`、模板和返回页，进程重启后继续查询而不是重新创建任务。
- 增加至少 Android 10、13、15 三档真机矩阵，覆盖 48MP JPEG/HEIC、拒绝/永久拒绝权限、低内存、来电、锁屏、弱网、401/403/413/429/500/503、签名 URL 过期。
- 确认正式包无 `debuggable`、无 WebView 调试、无 debug cleartext 配置、无测试 API 字符串，并验证覆盖升级和卸载重装身份隔离。
- 由公司确认发布商店所需的隐私清单、第三方 SDK 清单、算法/深度合成标识及内容安全材料；本技术清单不替代商店或监管审核。

## 四、自动验收命令

内部测试包：

```powershell
npm run android:apk:debug
node scripts/android-release-check.mjs
```

正式包必须使用公司批准的真实值，不能用示例域名：

```powershell
$env:VITE_API_BASE = "https://<正式API域名>"
$env:VITE_PRIVACY_POLICY_URL = "https://<正式政策地址>"
$env:VITE_USER_AGREEMENT_URL = "https://<正式协议地址>"
npm run android:apk:release
node scripts/android-release-check.mjs --release `
  --api-base=$env:VITE_API_BASE `
  --privacy-url=$env:VITE_PRIVACY_POLICY_URL `
  --agreement-url=$env:VITE_USER_AGREEMENT_URL
```

脚本输出 `NO-GO` 时不得把对应 APK 标记为可交付或可发布。自动检查只能验证工程和构建产物，不能代替真机操作、签名验真、法律文本和应用市场审核。
