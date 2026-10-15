# 原生成式图片适配器：本地复用与官方接口依据

日期：2026-10-15。本说明对应尚未接入 production 的 `photo-jobs/original-seedream-provider.js`。没有调用图像生成服务、修改云配置、开放效果或收费。13 个原生成式效果的定义来自 `server/photo-effects.js`，不包含年龄变化、清晰增强、上色和高清放大的专用处理器。效果目录定义不是质量验收或开放许可。

## 直接使用已验证图片 bytes

官方[图像生成 API](https://docs.volcengine.com/docs/ark/image-generation-api?lang=zh) 的 `image` 参数明确支持 URL 和 `data:image/<小写格式>;base64,<内容>`，并列出 Seedream 4.0 的参考图支持。因此原 `providers/seededit.js` 使用 URL 只是旧封装选择，不应据此要求当前链路新增签名源图 URL 发行器。

本地适配器将当前任务传入且校验过类型、长度、SHA-256 的图片 bytes 直接编码进 `image`。没有源图 URL、额外上传、URL resolver 或 sourceHosts 配置。保留原 13 个 ID、提示词、模型默认值 `doubao-seedream-4-0-250828`、旧 `size: "2k"`、`response_format: "url"` 和 `watermark: true`；不在此次传输调整中偷换模型或效果参数。当前官方尺寸文档使用 `2K` 拼写；本轮沿用原已实现请求值 `2k`，是否需规范化应由后续新版本的真实请求验收明确，不能默改现有历史报告。

官方单张参考图边界为 ≤30 MB、≤3600 万像素、宽高均大于 14、宽高比在 `[1/16,16]`。适配器保留更窄的本地 2 MiB、8192 最大边和 PNG/JPEG/WebP 输入限制，并加入上述像素、最小边和比例校验。2 MiB 图片经 Base64 编码和 JSON 包装后仍在共享传输的 3 MiB 请求体上限内。下载仍仅允许显式配置的精确 resultHosts，不能从返回 URL 自动扩大允许范围。

## 请求 ID 的真实来源

官方 Ark Python SDK 源码明确区分：

- [`_constants.py`](https://github.com/volcengine/volcengine-python-sdk/blob/master/volcenginesdkarkruntime/_constants.py#L15)：`CLIENT_REQUEST_HEADER = "X-Client-Request-Id"`，`SERVER_REQUEST_HEADER = "X-Request-Id"`。
- [`_base_client.py`](https://github.com/volcengine/volcengine-python-sdk/blob/master/volcenginesdkarkruntime/_base_client.py#L184)：客户端在发送前自行生成 `X-Client-Request-Id`。
- [`_response.py`](https://github.com/volcengine/volcengine-python-sdk/blob/master/volcenginesdkarkruntime/_response.py#L263)：SDK 响应 `request_id` 读取 CLIENT header，解析后赋给模型 `_request_id`，不能据此称为服务端生成 ID。
- [`images/images.py`](https://github.com/volcengine/volcengine-python-sdk/blob/master/volcenginesdkarkruntime/resources/images/images.py#L118)：实际图像请求为 `/images/generations`，普通返回经共享响应解析。此类没有 `.with_raw_response` 属性，不能臆造该调用。

共享 Node HTTPS 传输仅从真实响应头 `x-request-id` 投影可选 `serverRequestId`，要求单个字符串、1–128 个字符且匹配 `[A-Za-z0-9][A-Za-z0-9_.:-]*`。数组、重复头合并值、空白、控制字符、超长或其他不支持字符不被保存。绝不返回全部 headers；不回退到 body 字段、`x-client-request-id`、其他服务的 `x-tt-logid` 或本地 hash。

新适配器收到合法 `serverRequestId` 才输出 `requestId` 和 `requestIdSource: "response-header:x-request-id"`。缺失或不合法时不造 ID，而返回 `receiptIncomplete: true`、`integrationGap: "supplier-request-id-unconfirmed"`。`responseFingerprint` 始终只是独立响应体摘要。官方图像页未保证每次响应一定带该头，实际可用性仍待获授权的真实验收确认。

Qwen 继续从其原有正文 `request_id` 读取请求 ID；本轮新增可选传输字段不会替代或放宽该校验。

## 保持未接通边界

适配器只实现一次生成 POST 和受限结果读取，不自动重试、切供应商或把未知结果认定为明确失败。默认 SDK 自带重试行为并未引入；仍复用现有固定 DNS/TLS、无重定向、限时限长传输。上层仍必须提供账号/资产归属、同意状态、逐效果参数和版本验收、唯一 dispatch 记录及未知任务恢复。

模块未加入候选/正式构建清单，未改变当前 Qwen-only candidate/lifecycle，也未修改商品、用户白名单、公开协议或质量报告。实际缺少供应商 ID 的回执不能通过现有仓库；获得合法 ID 也不等于完成整个生命周期接入，更不等于线上开放。所有本轮测试使用合成图片和离线传输夹具。
