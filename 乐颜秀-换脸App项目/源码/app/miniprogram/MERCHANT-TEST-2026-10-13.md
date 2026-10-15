# 原生小程序商测待验客户端 · 2026-10-13

本次本地候选已开启 `creationEnabled`，保留原有 AppID、云环境、`buildtest` 服务、金额及默认路由，没有加入灰度参数。服务端仍决定允许名单、图片能力、授权和购买是否可用。默认入口仍为图片制作页。

本目录尚未上传或发布。本地编译成功不代表默认 `buildtest` 已切到 env=0 商测候选；正式商品、通知回调与客户端请求必须命中同一正式账本，随后才进行已安排的 Android 购买、交付与退款验收。客户端 URL 灰度参数不会替微信通知选择版本。

## 已完成的本地核对

- `app.json` 保留 `__usePrivacyCheck__: true`；`project.config.json` 保留 `urlCheck: true`、`compileType: miniprogram`。
- 制作/支付/退款运营客户端相关 Node 测试共 133/133 通过。独立身份探测的 4/4 测试通过。
- 四页 WXML 经本机官方 `wcc.exe` 编译通过；四页 WXSS 经官方 `wcsc.exe -lc` 编译通过。10 个 JavaScript 文件通过语法检查。
- 官方工具接口已登录且可连接。单文件 WXSS 诊断成功；单文件 WXML 接口曾超时，以上直接调用同一安装包官方编译器的成功结果是本次模板编译证据。
- 使用显式复制的隔离工程从退款运营页启动并取得官方模拟器截图；没有改变本目录页面顺序。服务帮助页会自动登录，不能作为无业务请求的启动页。
- 隔离工程仅执行一次目标 env=0 健康核对、微信登录、目标正式身份核对和退出。两个角色分别明确写入新的 ignored/ACL 私有文件；未保存 token 或 OpenID。没有支付、生成、上传或发布调用。

## 照片与购买所需声明

客户端选择相册照片（`chooseMedia` 仅 `image`、`album`）、本地读取/预览、将本人结果保存到相册。选图及保存前执行微信隐私检查；上传还需本次人脸处理单独同意及本人/已获授权声明。图片不长期保存在客户端本地存储。

登录使用微信 code 与服务端会话，购买使用服务端签名及 Android 原生虚拟支付。iOS、Windows 和未知平台不开放新购买。订单、权益、退款及客服所需信息仍按现有实现处理。帮助页只有用户主动复制时写剪贴板。无客户端相机拍摄、麦克风、定位、通讯录或手机号能力，不应为本次候选增加这些权限声明。

微信平台隐私条目需与实际的照片选择/相册写入、订单、操作日志、账号标识/会话、终端类型及主动复制功能一致。2026-10-13 官方模拟器 `getPrivacySetting` 返回合同名且 `openPrivacyContract` 回调成功；截图未取得协议正文。这不能证明后台新草稿内容或审批状态。实际结果下载还需匹配微信 downloadFile 域名白名单，保持 URL 校验开启。

## 官方编译与下一条命令

以下 PowerShell 命令使用已安装的官方工具。静态编译不会请求云端业务：

```powershell
$miniProject = 'D:/JT/乐颜秀/workspace/乐颜秀-换脸App项目/源码/app/miniprogram'
$wxCompiler = 'C:/Program Files (x86)/Tencent/微信web开发者工具/resources/app.asar.unpacked/node_modules/wcc-exec'
Push-Location -LiteralPath $miniProject
try {
  & "$wxCompiler/wcc.exe" pages/create/index.wxml pages/payments/index.wxml pages/service/index.wxml pages/refund-ops/index.wxml | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'WXML compile failed' }
  & "$wxCompiler/wcsc.exe" -lc pages/create/index.wxss pages/payments/index.wxss pages/service/index.wxss pages/refund-ops/index.wxss | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'WXSS compile failed' }
} finally { Pop-Location }
```

如需继续只读观察本次已打开且不会自动登录的隔离模拟器，下一条命令为：

```powershell
$wxCli = 'C:/Program Files (x86)/Tencent/微信web开发者工具/wechatide.cmd'
$identityProject = 'D:/JT/乐颜秀/workspace/乐颜秀-换脸App项目/源码/app/output/mini-native-identity-runtime-20261013'
& $wxCli -c codex-leyanxiu automation_runtime_info --project $identityProject --action currentPage
```

隔离工程只用于身份核对，不是上传目录。确认默认服务已具备目标商测路由后，可从本目录进行官方原生预览/实机验收。用户已授权完整上线执行；上传由主任务在后端就绪后执行。以下命令已用官方 `upload --help` 核实参数，本次客户端准备工作未执行上传：

```powershell
$wxCli = 'C:/Program Files (x86)/Tencent/微信web开发者工具/wechatide.cmd'
$miniProject = 'D:/JT/乐颜秀/workspace/乐颜秀-换脸App项目/源码/app/miniprogram'
& $wxCli -c codex-leyanxiu upload --project $miniProject --upload-version 0.1.13 --desc 'env0 Android 商测待验；buildtest 路由须核验'
```

上述上传不会自行完成微信审核或公开发布。内测先完成同账本的实际购买、图片交付、退款与身份/权限检查；公开运营另需核实平台审核与发布状态，不能以本地候选或内测结果代替。

身份探测已完成，不要重跑 `--run`。新脚本 `server/scripts/probe-mini-merchant-identity.mjs` 默认只输出 plan；若未来一次探测的官方接口响应不明，`--poll` 只查询对应 attempt，不重新登录。身份和路由私文件不随客户端包交付。

## 新商测候选只读核对

`server/scripts/probe-mini-merchant-readonly.mjs` 已准备，默认只输出 plan，不读私有文件、不调用云端。运行前由主任务配置新发布单的真实 URL 灰度条件并读回，再传入新的 ignored/ACL 路由文件；不得复用旧 015 路由。工程继续使用不会自动登录的身份隔离副本，默认客户端路由不变。

运行参数依次为新路由私文件、已验证 env0 身份私文件、新结果私文件、隔离工程绝对路径。新 probe 使用独立 nonce、attempt 和运行时槽位，不重放旧 journal：

```text
node server/scripts/probe-mini-merchant-readonly.mjs --plan
node server/scripts/probe-mini-merchant-readonly.mjs --run <新路由私文件绝对路径> <env0身份私文件绝对路径> <新结果私文件绝对路径> <隔离工程绝对路径>
node server/scripts/probe-mini-merchant-readonly.mjs --poll <本次结果私文件绝对路径>
```

固定顺序为 env0/merchant_test 健康核对、一次微信登录、核对已验证 UUID、并发读取商品/效果/能力/权益/订单/退款/公开披露，最后退出；最多 10 次 cloud 调用。唯一商品应为 `photo10`、990 分、10 次图片、365 天，唯一效果应为“自然 AI 头像”。报告只含状态、布尔值和计数，不输出 UUID、订单内容、OpenID、token 或灰度参数。

该探测不点击购买、不创建订单/退款、不上传图片、不写同意、不生成图片。报告通过只证明这些原生只读合同与当时的服务端开关一致，不能替代 Android 真机购买、实际制作或通知回调验收。调用结果不明时只用同一次 `--poll` 查询，不能重新 `--run`。

2026-10-13 实际执行结果：主任务先读回确认 016 发布单真实灰度条件，再由官方原生运行时完成 10 次 cloud 调用，`ok=true` 且退出确认。健康状态为 env=0 / merchant_test，销售和生成开关均可用；登录身份与此前正式身份一致且通过测试用户门禁。唯一商品、唯一效果、能力协议和公开披露字段全部符合预期；订单及退款各 0 条。没有支付、上传、生成或同意写入。结果保存在 ignored/ACL 私有文件 `server/.env.mini-merchant-readonly-20261013.json`，该次已完成，不可重跑。默认路由、通知回调、实际支付和图片交付仍需各自验证。
