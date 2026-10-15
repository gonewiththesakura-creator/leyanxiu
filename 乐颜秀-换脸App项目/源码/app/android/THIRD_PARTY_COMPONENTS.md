# Android 第三方组件清单

本清单基于本地依赖和 `releaseRuntimeClasspath`，用于上架材料准备；生产部署前应重新生成依赖树和 SBOM。

| 组件 | 用途 | 涉及数据/权限 | 是否主动联网 |
| --- | --- | --- | --- |
| Capacitor Android/Core 8.5.1 | WebView 容器与 JS/原生桥 | 应用页面、桥调用 | 否，由业务请求决定 |
| Capacitor App 8.1.1 | 返回键、前后台事件 | 应用状态 | 否 |
| Capacitor Browser 8.0.4 | 打开 HTTPS 协议和合规页面 | 目标 URL | 浏览器自行联网 |
| Capacitor Camera 8.2.4 | 系统相机/照片选择 | 用户主动选择的照片；CAMERA，Android 7-9 旧存储权限 | 否 |
| Capacitor File Transfer 2.0.5 | 下载用户作品到应用缓存 | 作品 URL 和文件 | 是，连接公司 API/对象地址 |
| Capacitor Filesystem 8.1.3 | 临时文件和分享缓存 | 应用私有文件 | 否 |
| Capacitor Share 8.0.1 | Android Sharesheet | 用户选择分享的作品和文字 | 本插件不直接上传，目标应用可能联网 |
| Capacitor Keyboard 8.0.5 | 键盘布局 | 无业务数据 | 否 |
| Capacitor Status Bar 8.0.3 | 状态栏外观 | 无 | 否 |
| AndroidX AppCompat/Core/CoordinatorLayout | Android UI/兼容层 | 无业务数据 | 否 |
| 微信 OpenSDK 6.8.40 | 微信登录授权及微信 APP 支付桥接 | 调用时检查微信安装状态；授权状态与结果、支付请求参数；具体处理需结合微信公开政策复核 | 由触发的微信授权/收银台流程决定；账号闭测不开放微信登录或支付 |
| 自有 GalleryMediaStorePlugin | 保存到系统图库 | 用户生成的图片/视频；Android 7-9 WRITE | 否 |
| 自有 DeviceIdentityPlugin | 设备持有证明及账号设备识别 | P-256 公钥、服务端 challenge 的签名；私钥不可导出 | 否，由业务 API 上传公钥/签名 |

2026-10-09 源码复核补充：`app/build.gradle` 已包含微信 OpenSDK，之前清单漏列不表示 APK 未集成。`WechatLoginPlugin.start` 只在 AppID/state 有效时进入授权；`WechatPayPlugin.status` 会在业务调用时检查安装状态，`pay` 校验支付参数后拉起收银台。本次是依赖及桥接源码核对，没有重新运行完整依赖树或证明 SDK 的全部内部数据行为；正式开放前仍须更新公开第三方信息清单并作运行时验证。

未发现 Firebase、Google Analytics、广告 SDK、推送 SDK、定位 SDK、通讯录 SDK、设备指纹 SDK 或 Google Advertising ID 依赖。顶层 Gradle 中未使用的 Google Services 插件依赖已移除。

真实 AI 模型提供商和 OSS/CDN 属于服务端数据处理者，不会自动出现在 APK 依赖树中，必须按生产路由另列在《第三方信息共享清单》和隐私政策内。

复核命令：

```powershell
cd android
.\gradlew.bat :app:dependencies --configuration releaseRuntimeClasspath --no-daemon
```
