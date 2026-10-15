# 乐颜秀 Android APK 高优先级验收清单

> 审核日期：2026-09-05  
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
| 保存/分享 | MediaStore 保存系统图库、Android Sharesheet、FileProvider 缓存分享 | 静态通过；图片进入 `Pictures/乐颜秀`，视频进入 `Movies/乐颜秀` |
| 返回键 | 系统 Back 先让分享层/设置层消费，再回上一业务页，根页才退出 | 静态通过 |
| 生命周期 | 切后台暂停媒体；持久化生成 `taskId`，重启后查询原任务 | 静态通过；待系统杀进程真机验证 |
| 状态栏/安全区 | 深色状态栏、非覆盖 WebView、`viewport-fit=cover`、底部安全区 | 静态通过，待打孔屏/手势导航真机验证 |
| 视频兼容 | 活跃预览为 fast-start H.264/AAC；私有对象接口支持 Range/206/416 | 自动检查通过 |
| 错误态 | 断网提示和 React 顶层恢复页 | 通过 |
| 本地数据安全 | Android backup 关闭；FileProvider 未暴露整个外部存储 | 通过 |
| 品牌资源 | 自定义乐颜秀图标、adaptive/round/monochrome 图层及竖屏启动图 | 通过静态与资源目检；待真机检查各桌面遮罩 |

## 二、测试 APK 交付线

### 2026-09-05 产物复核记录

- 产物：`android/app/build/outputs/apk/debug/app-debug.apk`，16,788,607 bytes；最后全量重建时间 2026-09-06 03:21:29；SHA-256 `000851B0D9D8C1A961B3162A38216373A976C03A4854C6B2EF4EC9A6491A2560`。
- `aapt`：包名 `com.yibohuaxia.leyanxiu`；`versionCode=1`、`versionName=1.0.0`；`sdkVersion=24`、`targetSdkVersion=36`；应用名“乐颜秀”。
- 权限：`INTERNET`、`CAMERA`，以及 Android 7-9 兼容所需的 `READ_EXTERNAL_STORAGE(maxSdk=28)`、`WRITE_EXTERNAL_STORAGE(maxSdk=28)`；未发现录音、定位、联系人、媒体全库或 all-files 权限。
- `apksigner`：APK Signature Scheme v2 验证通过；证书为 Android Debug，仅限封闭测试。
- `zipalign -c -P 16 -v 4`：通过。
- 包内 `assets/public/index.html` 与同步资产一致，CSP 的 `connect-src`、`img-src`、`media-src` 均覆盖 debug API origin，未发现未替换 token。
- 自动脚本（含本轮对保存/分享、设备身份、release 签名和网络边界的对抗式检查）：`node scripts/android-release-check.mjs` 最终输出 `GO / 0 blockers / 2 warnings / 66 checks`。两个 warning 是正式隐私政策和用户协议 URL 尚未提供。脚本的 GO 只代表 debug 工程和 APK 静态可安装性，不代表后端端到端可用。
- 工程质量：`npm run lint` 与 `npx tsc -b --pretty false` 均通过。
- 运行环境：本机 `adb devices` 无在线设备，因此尚无真机安装、相机授权、系统分享、返回键、退后台和自动播放声音的运行证据。
- 联调环境：`http://REDACTED_COMPANY_INFRASTRUCTURE/health` 在本轮检查中 10 秒超时；在该地址恢复前，不能宣称图片/视频生成和保存分享链路已通过。旧 CloudBase 地址虽返回 200，但不应未经确认直接替换 APK 的测试 API。

以下是本轮必须关闭的阻断项：

| 编号 | 当前状态 | 问题与原因 | 完成标准 |
|---|---|---|---|
| T0-01 | 已关闭 | debug APK 已构建并完成产物级检查 | 2026-09-06 强制全量重编译成功；APK 16,788,607 bytes；66 项自动检查无 BLOCK；包名、版本、SDK、签名、16 KB page alignment 和包内资源均通过 |
| T0-02 | 已关闭 | CSP 已修复并进入最终 APK；图片与视频结果的 API 来源均获允许 | `APK-012`、`NET-007` 通过；包内入口无未替换 token |
| T0-03 | 待运行验证 | 当前电脑 `adb devices` 没有在线设备，尚不能证明 APK 能安装、首启和调用系统能力 | 至少一台 Android 13+ 真机或模拟器完成安装、冷启动、拒绝/允许权限、退后台/回前台、系统返回键测试 |
| T0-04 | 阻断，待服务器上线 | APK 默认测试 API `http://REDACTED_COMPANY_INFRASTRUCTURE` 当前健康检查超时；只证明代码存在不代表公网端口、CORS、资源 Range 和生成接口可用 | 公网 `/health` 可达后，从 APK 内完成一次相册图片生成和一次视频生成，成片可播放、拖动、保存及分享；失败不扣重复次数 |
| T0-05 | 待配置 | 封闭测试模式会给新客户端发试用次数，仅靠 IP 限速不能阻止重置客户端 ID 或换 IP 消耗付费 AI | 公网 API 增加测试邀请码/账号白名单或网关访问控制，并配置供应商日预算、总熔断和费用告警；公开下载前先压低测试额度 |
| T0-06 | 已关闭 | 原生与 H5 现在按服务端 `ext`、Content-Type、data URI 或受信 URL 后缀推导图片/视频扩展名 | 最终 APK 已重建，`SHARE-006` 通过；待真机分别验证 PNG/WebP/JPEG |
| T0-07 | 已关闭 | 结果状态保留 `assetId`，保存与分享前调用 `/api/assets/:assetId/url` 刷新 signed URL，并使用返回的 Content-Type/ext | 最终 APK 已重建，`SHARE-007` 通过；待真机验证旧链接过期后的保存/分享 |

允许延后到正式版、但测试说明中必须披露：

- 隐私政策和用户协议链接未配置时，包内会明确显示“内部测试包”；不得公开分发。
- Android 可能拦截首次有声自动播放。当前策略是尝试有声播放，失败则静音继续并显示开声按钮；不能承诺所有设备打开就自动出声。
- 生成任务 ID 已持久化并支持启动恢复；仍需真机模拟系统杀进程，确认恢复原任务且不会重复扣费。
- “保存到相册”已改为 MediaStore；仍需在 Android 10/13/15 真机确认图库立即可见、重复文件名和低空间错误态。
- Android 7-9 的相册权限行为尚未真机验证；若保留 `minSdk 24`，需做兼容测试或缩小支持范围。

## 三、正式上架阻断项

结构验证命令输出 `GO / 0 blockers / 3 warnings / 66 checks`，证明 R8、资源压缩、APK/AAB、Manifest 和包内资源可以完成 release 构建；该包使用 `.invalid` 占位地址且未签名，禁止分发。按真正发布模式复核输出 `NO-GO / 4 blockers / 0 warnings / 66 checks`：缺公司 release 签名、正式 HTTPS API、正式隐私政策 URL、正式用户协议 URL。

| 编号 | 责任方 | 阻断项 | 为什么 | 完成标准 |
|---|---|---|---|---|
| F0-01 | 公司 + 技术 | 正式 HTTPS 域名、证书和生产 API 尚未定版 | release 已主动拒绝纯 HTTP/IP；当前公网 IP 只能用于 debug | 公司提供已备案域名；技术配置 HTTPS、`PUBLIC_BASE_URL`、精确 CORS，并用正式域名重建 |
| F0-02 | 技术 | Android 设备身份需正式环境验收 | P-256 Android Keystore、challenge/verify 和 `AUTH_MODE=device_key` 代码已完成，但尚无正式 HTTPS 真机证据 | 在正式环境启用 `RELEASE_CHANNEL=android-app`、`AUTH_MODE=device_key`，验证 challenge 过期、单次消费、重放拒绝和卸载重装身份变化 |
| F0-03 | 公司 | 隐私政策、用户协议未提供正式 HTTPS 页面 | 首启只有文案而无可访问的批准文件，不能作为公开版 | 法务/公司定稿并发布，提供稳定 HTTPS URL |
| F0-04 | 公司 + 技术 | 动态处理者披露机制已完成，正式供应商资料仍需配置 | 页面已按服务端返回的处理者和服务逐项显示；正式环境仍必须提供真实法定名称、目的、数据、地域和期限 | 公司确认生产供应商清单；技术配置后核对页面展示与服务端实际路由记录一致 |
| F0-05 | 公司 + 技术 | 正式签名体系未建立 | 当前 release 输出 unsigned APK；无公司密钥不能升级同一应用 | 公司创建并离线保管 keystore；技术通过安全环境变量/CI 签名，产出可验证签名的 APK/AAB；不得提交密钥或密码 |
| F0-06 | 技术 | 已关闭，待真机验证 | 已持久化 `taskId`、模板和创建时间，重启后查询原任务，不重新创建 | 用系统“结束进程”覆盖成功、失败、超时三种任务状态并确认不重复扣费 |
| F0-07 | 公司 | 包名和版本策略未冻结 | 上架后改包名等同新 App，用户不能原位升级 | 书面确认 `com.yibohuaxia.leyanxiu`、首发 `versionCode/versionName` 和后续递增负责人 |

正式公测前还应完成，但不阻挡本轮内部 APK：

- 真机验证生成中的 `taskId` 恢复：进程重启后继续查询而不是重新创建任务。
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
$env:ANDROID_VERSION_CODE = "<递增整数>"
$env:ANDROID_VERSION_NAME = "<对外版本号>"
$env:ANDROID_RELEASE_STORE_FILE = "<源码目录外的公司密钥路径>"
$env:ANDROID_RELEASE_STORE_PASSWORD = "<安全注入>"
$env:ANDROID_RELEASE_KEY_ALIAS = "<公司别名>"
$env:ANDROID_RELEASE_KEY_PASSWORD = "<安全注入>"
.\android\build-release.ps1 -Artifact Both -RequireSigning
node scripts/android-release-check.mjs --release `
  --api-base=$env:VITE_API_BASE `
  --privacy-url=$env:VITE_PRIVACY_POLICY_URL `
  --agreement-url=$env:VITE_USER_AGREEMENT_URL
```

脚本输出 `NO-GO` 时不得把对应 APK 标记为可交付或可发布。自动检查只能验证工程和构建产物，不能代替真机操作、签名验真、法律文本和应用市场审核。
