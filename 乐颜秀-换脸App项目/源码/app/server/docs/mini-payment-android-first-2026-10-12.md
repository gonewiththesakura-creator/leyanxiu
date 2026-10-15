# 正式小程序 Android 首发购买范围

本次仅本地实现与隔离测试，未发布、未开售、未生成真实验收报告，也未进行新的微信或供应商请求。历史制品、历史报告及沙箱服务源码保持原样。

正式入口固定使用代码常量 `android-only-v1`，经 production config → host → payment service → routes 传递；正式聚合 readiness 必须返回同一范围。没有客户端或环境变量能够把它扩展成其他终端。商品接口仅公开该范围和 `supportedPlatforms: ['android']`，不公开验收材料。

原生客户端在正式 env0 购买前检查实际设备及当前服务器商品范围。iOS、Windows、Harmony、开发者工具及未知设备不能新建付款意图；其页面仍可查询旧订单、已购权益和退款状态。不支持的页面隐藏新购商品、价格及确认购买规则，不引导到其他平台付款。Android 已持久化的待确认订单优先查原单，闭售不要求重建订单。

服务端在产生新订单或签名前拒绝非 Android 声明；这不是设备认证。`body.platform` 由客户端提供，微信支付签名中没有“仅 Android”字段。实际 Apple 支付渠道必须保持在正确 AppID/OfferID 的微信后台关闭，并在部署与验收时核实。官方来源：

- https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/business-capabilities/virtual-payment.html
- https://developers.weixin.qq.com/miniprogram/dev/api/payment/wx.requestVirtualPayment.html

新正式支付验收报告仍须通过原文件边界、精确 SHA-256、AppID、数字 env0、OfferID 和 30 天有效期检查。除此之外必须明确：

| 字段 | 必须满足 |
| --- | --- |
| `purchaseProfile` | `android-only-v1` |
| `supportedPlatforms` | 仅 `['android']` |
| `checks.iosRefund` | 字符串 `not_applicable`，不能填 `true` 冒充完成 |
| 其余六项 `checks` | `mysqlRestore`、`merchantPayment`、`merchantRefund`、`crossDeviceRestore`、`securityReview`、`dailyReconciliation` 全部为实际验收后的布尔 `true` |
| `appleIap.enabled` | 布尔 `false` |
| `appleIap.source` | `wechat-mini-program-console` |
| `appleIap.checkedAt` | 明确 UTC ISO 时间，不晚于报告时间，距当前不足 30 天 |
| `appleIap.evidenceSha256` | 已保全控制台核验材料的 SHA-256；不能使用本地测试占位值 |

摘要与结构仅绑定材料，不证明其中结论真实。代码不主动取得或伪造 IAP 状态；实际核验材料和六项正式运营验收由上线流程保全。现有 env1 真钱联调不能替代 env0 验收。将来启用 iOS 需重新设计明确范围和完成 Apple 验收，不能套用本报告。

旧 runtime 调用未选择此范围时保留原七项全 `true` 的要求，不接受范围较窄的报告。旧沙箱路由没有新范围，行为不变。查询、退款审核、渠道回调和清理不套新购终端门禁；已有 Apple 订单继续按实际渠道恢复权益及提示 Apple 退款，不能因停止新购丢弃既有付款事实。

本地联合验收 112/112：`virtual-payment-acceptance`、`virtual-payment-runtime-scope`、`mini-production-service`、`mini-refund-operator`、`photo-production-host`、`photo-production-server`、`virtual-payment-client`、`mini-sandbox-service`。含不支持终端零新单/零签名、伪范围不能扩权、同 App/env0/Offer/范围报告绑定、IAP 证据缺失和漂移拒绝、既有查询/权益/退款可用、历史 Apple 订单保留，以及旧沙箱回归。测试媒体、身份与验收材料均为本地合成，不代表实际商户或设备验收。
