# 2026-10-09 单笔支付与原路退款验收

本轮结论：Android单测试账号的一笔9.90元实际付款、10次权益入账、重复查询不重复发放、发货确认、原单全额退款及权益归零已完成；用户确认退款到账。现已恢复closed，buildtest-013正常承载全部流量，查询与对账保留。正式上线和图片交付仍未验收。

用户明确资金已准备并要求继续；沿用已核对的开发版 photo10，标价990分、10次图片权益、365天。此次仅验证一笔购买及未使用全额原路退款；沙箱可能发生真实扣款，手机客户端最终支付确认由用户完成。图片生成仍关闭，不发布正式商品、不切env0、不增加云资源。

## 起点复核

- 服务固定buildtest-011，任务2308642已完成，100%流量，mode=closed。
- 现有Chrome仍登录乐颜秀，开发商品photo10价格9.9、未发布；现网商品为空。
- 官方开发者工具已授权、未过期；实际运行时android，requestVirtualPayment支持。
- 两笔已有990分订单逐单查询均closed；权益及退款均0。当前手机pending只有原幂等键、没有orderId；保留原键，不人为清除后新建以绕过未知结果。
- 云调用保留`/cgi-bin/stable_token`和`/xpay/query_order`，按本轮验收需求补充`/xpay/notify_provide_goods`和`/xpay/refund_order`，保存后逐项读取确认。权限存在不等于这些接口实际调用成功。

## 付款前发现和修复

官方query_order文档当日读取确认：退款状态5是商户侧扣款完成，8才是用户侧收款完成。旧代码把5、8都当最终退款成功；已修复渠道补查及云消息验证，只在8且环境、单号、类型、金额和凭证匹配时完成。5持续processing、保留冻结和同退款号补查。已有安全模式验签退款成功通知继续按官方RetCode=0处理，不伪造通知或数据库终态。

新测试先在旧实现复现失败，修复后相关61项通过。此项是本地测试，仍需本轮实际渠道验收；此前文档矩阵中的“5/8均完成”已过时。

另补修只读对账报告：退款状态5不得报告matched，8才匹配；部分退款后原支付单仍2/3/4且余额准确的既有分支保留。真实本地账本全额/部分退款回归等48项通过，不改变退款或权益。后续部署使用包含此补修的r2候选。

客户端金额确认已绑定服务端订单和原始签名参数，任何金额、商品、环境、数量、币种或单号差异均保留原单并阻止唤起支付；不改写签名。支付测试56/56、创作客户端18/18通过，独立交叉复审无阻断问题。原生支付永不回调仍是已知限制，本轮通过原订单独立查单恢复，不把调试接口超时判成失败或自动再付款。

## 待完成的实际验收

付款前真机重新配对后，实际平台android；支付客户端buy参数数量为3，运行代码包含XPAY_PAYMENT_CONFIRMATION_MISMATCH校验。云库通过微信云托管入口恢复登录并只读查询，订单只有closed两笔，退款和outbox均无记录，客户端权益0，与服务端状态一致。候选r1已构建（21文件+manifest），清单SHA256 `ee820e821c66ca4fa0a18b2202a70cd0c228320d8816892a8283b3e812dac7be`。首次部署预检因版本列表分页不全被阻止，未提交云端变更；正在修复只读分页而非放宽版本一致性校验。

1. 受控发布固定011后续版本，仅恢复MODE=sandbox，保留env1、单测试账号、既定商品、对账和私有入口；候选必须包含上述修复。
2. 真机加载已修客户端，明确990分及可能实际扣款；只发起一笔，所有网络不确定只查原单。
3. 官方查单支付及金额/环境匹配，权益只增加10次；重复查询和页面恢复不重复入账；发货任务完成另取证。
4. 本人申请该笔全额退款，明确确认后只提交一次；状态5不显示完成，状态8确认990分退款及权益撤回，原路到账由用户核对。
5. 服务关闭新购并保留查询/对账，核对最终版本、公网403、订单数和权益；不删除账本。

正式上线、图片交付、正式支付商品与平台提审不由本次沙箱验收自动推出。

## 部署预检补充

真实云接口三个Offset返回同样最近10条、TotalCount=10；腾讯云官方TCB说明每服务默认仅保留最新10版本并自动清理旧版本。部署工具据此以TotalCount核实完整性，并仅允许最旧、非活动的已知版本退出；来源与回滚版本、中间版本不能缺失。保留原始journal与未知写请求锁，不按轮次硬编码消失的版本号。本地14项及独立13项相关测试通过。

最终r2候选包含退款终态、对账报告修复，manifest SHA256 `7aa8264ea7cdf34cc23e732b9b426a0bef65f36ad5061d1e2ffe281e8bbed59f`。真实plan-resume全部通过，数据库预检正常；环境差异仅XPAY_MODE，单测试账号、photo10/990分/10次/365天保持，env1、制作关闭。

发布操作`b707bdfac74401f7d1ed0183`、任务`2312831`已确认finished；`buildtest-012`normal/100%，控制面完成校验，011保留。原011完整记录已归档，未手工清理journal。两条公网探针均403。以上尚不代替真实付款/退款验收。

实际Android更新运行确认：clientGuard=true，商品photo10/990，available=true，旧订单2/权益0。真实callContainer `/health`返回200，mode=sandbox、env1、productionPaymentsEnabled=false、sandboxMayCharge=true、generationAvailable=false、cloudCallbackMode=query-authoritative。已点击页面测试购买一次打开金额确认，正在等待用户在微信完成原生付款确认，不以自动化调用成功视为支付成功。

## 本次真实付款证据

用户回复“支付成功”后，真实客户端经服务端查单确认新订单`f24aef6aa93f4abcac498f95a5305102` paid，photo10、990分、android、refundedFen=0；原有两笔继续closed。权益图片10/视频0，唯一权益批次remaining10/reserved0/frozen0。再次查询仍只有10次，未重复入账。DMC只读聚合同时确认paid1、closed2、deliver outbox done1，退款0。这里的发货为虚拟次数权益确认，不代表尚未开放的图片生成验收。准备全额原路退款。

已通过实际客户端本人退款API，为同一订单提交990分未使用全额退款（先核对无既有退款），退款号`1adec03a83b94d7f8606c84ee3ba1616`。requested阶段可用图片0、remaining0/reserved0/frozen10；随后确认该原退款一次，状态processing。尚未把申请/确认当渠道退款完成，继续读取同一退款与发货任务，不重建退款号。

后续真实服务端查询：原订单refunded、amountFen990、refundedFen990；唯一退款succeeded、amountFen990；图片/视频可用均0，唯一批次remaining0/reserved0/frozen0。DMC只读任务结果为deliver done/attempts1、refund done/attempts2；后者按部署代码第一次发起退款、之后仅查询原退款号，不等于两次退款提交。用户随后明确回复“已确认退款到账”。本轮已取得客户端购买、服务端权威确认、权益入账、防重复、发货、全额退款、权益撤回及用户原路到账证据。

同r2清单执行plan-close全部通过，差异仅XPAY_MODE；已提交deploy-close，保留原商品/白名单/env1/对账与查询，待确认新版本及真机闭售。

## 闭售收尾

闭售操作`fbb62692d545aa6278ad46e9`、任务`2313130`finished；`buildtest-013`normal/100%，012为上一版本；清单与012相同，仅MODE改为closed。独立运行时callContainer健康200、mode=closed、env1、productionPaymentsEnabled=false、generationAvailable=false；商品available=false。此次收尾读取时官方工具platform=devtools，应与前述Android实际付款验收区分。历史订单仍可查：refunded1/closed2，原退款990分成功，权益remaining/reserved/frozen均0。部署后的公网health和cloud通知路径均403。

下一阶段直接聚焦图片服务真实交付与失败恢复、env0正式支付商品/配置/账本隔离，以及小程序正式版本与平台审核资料；不以这笔env1成功替代上述验收。

来源：[微信查询订单](https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_query_order)、[退款接口](https://developers.weixin.qq.com/miniprogram/dev/server/API/VirtualPayment/api_refund_order)。

版本保留依据：[腾讯云TCB官方功能说明](https://developer.cloud.tencent.com/article/1949490)。
