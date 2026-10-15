# 乐颜秀 Android 正式发布手册

## 结论

工程已具备可重复构建 release APK/AAB 的机制，但“能构建”不等于“可上架”。公开发布必须同时满足：公司正式 HTTPS 域名、已发布的隐私政策和用户协议、实际 AI 处理者披露、Android 设备身份后端 challenge/verify、公司保管的签名密钥、应用商店主体和 Data Safety 表单。

测试用 `-VerificationOnly` 会写入不可路由的 `.invalid` 地址，只用于验证编译、压缩、Manifest 和包结构，绝对不能交付用户或上传商店。

## 正式构建

在 PowerShell 中设置以下环境变量，不要写入 `.env`、Gradle 文件、聊天记录或仓库：

```powershell
$env:VITE_API_BASE = "https://api.<company-domain>"
$env:VITE_PRIVACY_POLICY_URL = "https://<company-domain>/privacy"
$env:VITE_USER_AGREEMENT_URL = "https://<company-domain>/terms"
$env:ANDROID_VERSION_CODE = "2"
$env:ANDROID_VERSION_NAME = "1.0.1"
$env:ANDROID_RELEASE_STORE_FILE = "D:\secure\leyanxiu-upload.jks"
$env:ANDROID_RELEASE_STORE_PASSWORD = "<secret>"
$env:ANDROID_RELEASE_KEY_ALIAS = "<alias>"
$env:ANDROID_RELEASE_KEY_PASSWORD = "<secret>"
.\android\build-release.ps1 -Artifact Both -RequireSigning
```

输出为 `android/app/build/outputs/apk/release/app-release.apk` 和 `android/app/build/outputs/bundle/release/app-release.aab`。上架优先使用 AAB。`versionCode` 每次发布必须递增；同一包名后续更新必须继续使用同一公司签名。密钥文件必须位于源码目录之外，并由公司双人备份。

仅验证本地 release 工程：

```powershell
$env:ANDROID_VERSION_CODE = "1"
$env:ANDROID_VERSION_NAME = "1.0.0"
.\android\build-release.ps1 -Artifact Both -VerificationOnly
```

仅结构验证审计（允许未签名和 `.invalid` 占位地址，但会保留 warning）：

```powershell
node scripts/android-release-check.mjs --release --verification-only --api-base=https://api.leyanxiu.invalid --privacy-url=https://legal.leyanxiu.invalid/privacy --agreement-url=https://legal.leyanxiu.invalid/terms
```

正式发布审计：

```powershell
node scripts/android-release-check.mjs --release --api-base=https://api.<company-domain> --privacy-url=https://<company-domain>/privacy --agreement-url=https://<company-domain>/terms
```

## 权限与 Data Safety

| 能力 | Android 权限/机制 | 触发时机 | Data Safety 要点 |
| --- | --- | --- | --- |
| 联网浏览和生成 | `INTERNET` | 同意首次隐私提示后 | 申报设备匿名标识、操作数据、用户主动上传内容 |
| 拍照 | `CAMERA` | 用户点击“拍照” | 仅用户主动触发；照片会提交服务端/AI 处理者 |
| 相册选图 | Android 10-15 系统选择器；7-9 `READ_EXTERNAL_STORAGE` | 用户点击“相册” | 不申请 Android 13+ 全量照片读取 |
| 保存作品 | Android 10-15 MediaStore；7-9 `WRITE_EXTERNAL_STORAGE` | 用户点击“保存” | 仅写入本次生成的图片/视频，不读取全库 |
| 设备身份 | Android Keystore P-256 | 接受隐私提示后、登录绑定时 | 私钥不可导出；公开 SPKI 和挑战签名用于防重放绑定 |

当前 Manifest 不包含位置、通讯录、麦克风、广告 ID、全部文件、Android 13+ 全量相册权限。`READ/WRITE_EXTERNAL_STORAGE` 均限制到 API 28（Android 9）。

公司填写商店 Data Safety 时必须根据生产真实链路确认：照片、人脸影像、生成结果、匿名账号标识、诊断/操作日志是否收集；是否传给云存储和每一家 AI 模型提供方；处理目的、保存期限、删除路径、传输加密、账号注销。客户端代码无法代替公司作出这些事实承诺。

## Android 7-15 媒体行为

- Android 10-15：选图走系统 Picker，不读取整个相册；保存走 MediaStore，图片进入 `Pictures/乐颜秀`，视频进入 `Movies/乐颜秀`。
- Android 7-9：首次选图/保存可能出现旧存储权限提示；拒绝后仍应允许继续浏览，保存时显示明确错误。
- 临时下载只在应用缓存内，MediaStore 发布成功或失败后都会尝试清理。
- 必须用 Android 7/9/10/13/15 真机各验证一次：相册、相机、PNG/JPEG/WebP、MP4、拒绝权限、重复文件名、低空间、保存后图库可见。

## 设备身份协议

TypeScript 导出：`getNativeDevicePublicKey()` 返回 `{ algorithm: "ES256", keyId, publicKeySpki }`；`signNativeDeviceChallenge(challenge)` 返回 `{ algorithm: "ES256", keyId, signature, encoding: "base64url-der" }`。

`publicKeySpki` 是 P-256 SubjectPublicKeyInfo DER 的无填充 base64url；签名内容是 challenge 的 UTF-8 字节，签名算法 `SHA256withECDSA`，签名值是 ASN.1 DER 的无填充 base64url。服务端必须生成高熵、短时、单次 challenge，绑定 channel/app、会话和公钥，并在成功后立即作废，防止重放。卸载应用会丢失设备密钥和匿名身份，产品必须接受该行为。

## WebView 与声音

release Manifest 和网络策略禁止 HTTP；MainActivity 在非 debuggable 包中显式关闭 WebView 调试并设置 `MIXED_CONTENT_NEVER_ALLOW`。debug 例外仅允许指定测试 IP。

MainActivity 已设置 `setMediaPlaybackRequiresUserGesture(false)`，提高模板进入后自动有声播放的成功率。但 Android 系统、WebView 媒体策略、静音/勿扰、蓝牙切换和用户设置都可能阻止有声自动播放，因此产品必须保留静音自动播和“打开声音”按钮兜底，不能承诺 100% 自动有声。

## 仍需外部输入

1. 公司批准且公开可访问的 API HTTPS 域名、隐私政策 URL、用户协议 URL、第三方信息共享清单 URL。
2. 每一家真实 AI/存储服务商的法定名称、处理目的、数据项、处理地域、保存期限和备案/算法信息。
3. 公司生成并保管的 upload keystore、alias 和密码；本工程不会生成或提交真实密钥。
4. 商店应用名称、图标、截图、版本号、支持邮箱、主体证明和 Data Safety 最终答案。
5. 生产环境启用并验证 `RELEASE_CHANNEL=android-app`、`AUTH_MODE=device_key`，确认 challenge 单次消费、过期和重放拒绝；客户端与服务端协议代码均已具备。
6. HTTPS 真机环境与 Android 7/9/10/13/15 设备测试。

## 发布阻断规则

以下任一成立都必须停止公开发布：release 含 HTTP/测试 IP；WebView 可调试；混合内容开启；AAB 使用 debug 签名或无公司签名；协议链接缺失；第三方处理者仍是占位文案；设备 challenge 可复用；生成任务恢复会重复扣费；真机无法从图库看到保存结果。
