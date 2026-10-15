# 小程序虚拟支付 CloudBase 云函数沙箱探针

此目录是独立的、无业务发货的 CloudBase 云函数 bundle。它只用于确认云函数消息推送能够到达，并保留真实支付回调的重试语义：

- 核对配置的小程序原始 ID；携带 AppID、环境或已配置触发来源时核对其值。这些字段检查不能替代平台鉴权。
- 精确的 `action: probe_echo`（兼容 `CheckContainerPath`）探针返回 `{ ErrCode: 0, ErrMsg: "success" }`。
- `action: probe_db` 只在固定的 `lyx_xpay_probe_health` 集合写入、读取并删除一条合成记录，用于确认当前云函数环境的数据库往返；不会查询或迁移任何业务集合。
- 合成 echo、数据库和兼容探针默认关闭，只有显式设置 `XPAY_PROBE_SYNTHETIC_ENABLED=true` 才可调用；当前远程部署已关闭。不能向客户端开放此开关。
- `xpay_*` 支付、退款、投诉和订阅事件全部返回非零错误，绝不创建订单、记账、发货、退款或修改现有数据库。
- 不依赖 MySQL、CloudRun、AppSecret、AppKey、Token/AES 或生产账本；云函数入口只用 `wx-server-sdk` 的 `DYNAMIC_CURRENT_ENV` 初始化当前 CloudBase 环境，供 `probe_db` 使用。
- `index.js` 是 CommonJS 云函数入口，`package.json` 锁定 `wx-server-sdk`；其余 `.mjs` 文件由构建脚本从现有 `server/payments/virtual` 审核源码复制生成。

云函数自身的可调用权限仍须在 CloudBase/微信开发者工具中限制为消息推送触发；代码中的原始 ID、AppID、环境和触发来源校验不能替代平台权限。探针部署完成并观察到真实沙箱事件前，不得切换正式回调或打开收费。

环境变量：

| 变量 | 用途 |
|---|---|
| `WECHAT_APP_ID` | 小程序 AppID |
| `WECHAT_MINIPROGRAM_ORIGINAL_ID` | 小程序原始 ID，供直接回调来源校验 |
| `XPAY_MODE` | 必须为 `closed` |
| `XPAY_ENABLED` | 必须为 `false` |
| `XPAY_PROBE_ENV` | 必须为 `1`（仅沙箱） |
| `XPAY_PROBE_TRIGGER` | 可选，限制 `context.triggerSource` 等触发字段 |
| `XPAY_PROBE_SYNTHETIC_ENABLED` | 默认关闭；临时管理端测试才允许显式 `true` |

这不是正式支付处理器，也不是生产部署证明。旧的 HTTP/AES 消息推送和 CloudRun 接收器保持在原项目中，不会被此函数包覆盖。
