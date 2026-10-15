# 乐颜秀 · 人脸融合 API 接入层

本目录是服务端接入代码。**密钥绝不能放前端**，所有 API 调用必须经过这个后端转发。

## 架构

```
小程序/App 前端
   │  POST /api/fusion { templateId, objectReference }
   ▼
server/index.js (Hono)
   │  ① 限流/鉴权/内容安全前置
   │  ② 调用云厂商创建融合任务
   ▼
providers/aliyun.js      ← 供应商适配器（价格以公司合同/控制台为准）
providers/tencent.js     ← 备用渠道B（腾讯云 vclm 视频人脸融合大模型）
providers/volcengine.js  ← 备用渠道C（火山引擎 AI MediaKit，字节系，遮挡处理重点候选）
   │
   ▼  任务异步执行（约10~60秒）
GET /api/fusion/:taskId → { status, videoUrl }（前端轮询）
```

`.env` 里 `PROVIDER=aliyun / tencent / volcengine / mock` 一键切换视频渠道；
照片换脸另由 `PHOTO_PROVIDER=viapi / bailian` 控制：viapi 是默认的精确融合，
bailian 是生成式换脸（需要供应商可访问的 HTTPS 短时对象 URL 和 `DASHSCOPE_API_KEY`）。
文本对话由 `LLM_PROVIDER=deepseek / hunyuan` 控制，避免因同时配置密钥而误路由。

任务台账由 `TASKS_BACKEND=file / oss` 显式选择，默认 `file`。
不要因为配置了阿里云业务 AK 就自动启用 OSS；只有确认 bucket 属于该账号且已授权
`oss:GetObject`、`oss:PutObject` 后，才设置 `TASKS_BACKEND=oss`。

## 三方遮挡对比测试

同一条视频 + 同一张照片跑所有已配置渠道，自动下载成片存档：

```bash
cd server
node compare-providers.js <视频URL> <照片URL> [备注名]
# 结果在 server/compare-output/，逐条播放到「手挡脸」时间点对比重影
```

## 备用渠道开通（见「渠道开通清单」，均支持个体工商户）

- 腾讯云：cloud.tencent.com → 实名认证 → 开通「大模型视频创作引擎」→ API密钥管理建 SecretId/Key
- 火山引擎：console.volcengine.com → 实名认证 → AI MediaKit 控制台创建 API Key

## 快速启动

```bash
cd server
npm install
cp .env.example .env   # 填入你的密钥
npm run dev            # 本地启动 :3000
```

封闭测试可显式使用 `PROVIDER=mock`，接口返回模拟结果；这不是生产能力证明。
生产环境必须通过 `npm run release:check` 和 `/api/readiness`，缺少公司凭据、
私有 bucket、供应商能力证据或合规材料时保持 `NO-GO`。

## 生产开通前置事项

以下事项必须由公司账号、合同、审批材料和真实验收完成，代码不会代办或伪造：

- 企业云账号、最小权限密钥、私有 bucket、历史对象盘点与删除证明。
- 微信小程序 AppID/Secret、合法域名、隐私协议/备案材料和原生包审核资料。
- 供应商服务开通、数据删除条款、内容安全能力、素材授权和真实样本验收。
- 商户支付回调签名、商品清单、退款/对账环境和生产回滚演练。

## 本地验证与发布闸门

```bash
npm test
npm run lint
npm run sbom
npm run release:check
```

`npm run release:check` 只输出提交号、服务端 hash 和阻断原因；生产发布仍需
由部署平台完成签名、分阶段发布、监控和回滚。完整 T01-T11 证据见上级
`部署/技术负责人T01-T11实施证据说明-2026-08-29.md`。
