# 乐颜秀 Android 内测包

这是 `v1.0` 的 Android **debug 内测包**，用于在真实 Android 手机上验收相册、相机、视频预览/声音、生成、保存和系统分享流程。它不是应用商店发布包。

## 文件

- `leyanxiu-android-debug-v1.0-20260904.apk`：可安装测试包（17,993,232 bytes）
- `leyanxiu-app-icon-source.png`：本包使用的品牌图标源图
- `SHA256SUMS`：APK 完整性校验

## 包信息

- applicationId：`com.yibohuaxia.leyanxiu`
- versionName / versionCode：`1.0 / 1`
- minSdk / targetSdk：`24 / 36`
- 签名：Android debug keystore，仅限内测
- 构建：`npm run android:apk:debug`

## 测试边界

本包的测试 API 是 `http://REDACTED_COMPANY_INFRASTRUCTURE`，仅用于短时连通性和无敏感测试数据。请不要上传真实人脸或其他敏感照片；正式版本必须切换到公司批准的 HTTPS 域名。当前服务器公网健康检查若未就绪，生成/轮询会显示失败或离线状态，这是环境问题，不代表 APK 安装失败。

首次打开会先显示隐私确认，拒绝前不会请求网络、创建会话或读取照片。原生保存位置为系统“文档/乐颜秀”，不是系统图库；分享使用 Android 系统分享面板。保存或分享前会凭作品 `assetId` 刷新短时签名链接，并根据服务端 `Content-Type`/扩展信息保存为正确的 JPG、PNG、WebP 或视频格式。视频会尝试自动播放声音，若 Android 或系统策略阻止，会显示静音播放和声音控制作为兜底。

## 仍不能用于上架的事项

1. 需要公司发布 HTTPS 隐私政策和用户协议，并在 release 构建时传入链接。
2. 人脸处理授权文案必须替换为实际第三方处理者的法定名称、目的、数据类型、地域和留存期限，并由服务端记录实际路由厂商。
3. 生产环境 Android 登录适配器尚未完成；当前后端要求微信身份时，本包只能做封闭内测。
4. 生成任务的进程被系统杀死后恢复仍需持久化 taskId。
5. 应用商店版必须使用公司保管的 release keystore，不能沿用 debug 签名。

## 校验

在 PowerShell 中执行：

```powershell
Get-FileHash .\leyanxiu-android-debug-v1.0-20260904.apk -Algorithm SHA256
```

应得到 `4F0E791F30B9AA0C96EDEBB302E86D060D6DA7BC0916306423889D4CDF6CBCAF`。
