# 乐颜秀 Android 公测后端部署

> 2026-09-30 最新状态：独立 App 使用本 ECS，域名 `REDACTED_COMPANY_INFRASTRUCTURE`。账号测试 API 为 `leyanxiu-app-account`，监听 `127.0.0.1:3300`，使用 PostgreSQL + SQLite；Nginx HTTPS 已启用，Let's Encrypt 证书及自动续期演练通过，公网账号接口烟测与 MuMu HTTPS 拒绝路径通过。短信/微信/真实支付未开通。当前实际部署是 systemd 服务，不是下文历史 Docker 方案。详见 `../../部署/App阿里云账号测试环境-2026-09-30.md`。下文是历史步骤，不得覆盖新服务、配置、证书或备份；旧匿名模式不是新版账号方案。

目标主机：阿里云 ECS `REDACTED_COMPANY_INFRASTRUCTURE`，2 vCPU / 4 GiB / 5 Mbps。容器只监听宿主机
`127.0.0.1:3000`，公网流量必须经过 Nginx HTTPS。

## 当前结论

- 该 ECS 规格足够运行 API、鉴权、任务轮询和轻量 ffmpeg/Pillow 后处理；AI 推理由云厂商承担。
- 2026-09-04 的只读探测结果：`22/tcp` 可达，`80/tcp`、`443/tcp` 不可达。
- 本机没有发现截图所示 `lyx` 私钥，因此尚未登录或更改服务器。
- Android 首轮公网测试使用 `DEPLOY_ENV=staging`、`AUTH_MODE=anonymous`、
  `PAYMENT_MODE=closed_test`。这只是受控测试，不是生产上线。
- 闭测环境必须设置 `CLOSED_TEST_DAILY_GENERATION_LIMIT`。它按 UTC 自然日限制全站
  生成预约总量，不能通过重装应用或更换匿名 ID 绕过；达到上限后接口返回 429，避免
  公网下载包被滥用产生无上限的供应商费用。
- Android 正式身份适配器尚未实现。`DEPLOY_ENV=production` 会被发布闸门明确阻断，
  不能把匿名测试会话当作正式账号体系。

## 公司/管理员先提供

1. 一个已实名、完成所需备案并解析到 `REDACTED_COMPANY_INFRASTRUCTURE` 的 API 子域名，例如
   `api.example.com`，以及申请证书使用的邮箱。
2. ECS 登录用户名和 `lyx` 密钥对的私钥文件。不要发送阿里云控制台密码；若私钥已丢失，
   在控制台创建新密钥对、绑定实例并按阿里云提示重启。私钥只保存在授权技术人员设备。
3. 安全组删除 `3389/tcp`；`22/tcp` 只允许技术人员固定公网 IP；开放
   `80/tcp`、`443/tcp` 到公网。不要开放 `3000`、`8787` 或数据库端口。
4. 为服务创建独立 RAM 用户/角色和最小权限密钥。不要把主账号、控制台密码或
   AccessKey 写入仓库、APK、镜像、聊天或部署包。

已在聊天中出现过的控制台密码应立即修改，并启用 MFA、登录保护和操作审计。

## 首次安装

将 `server` 目录安全传到 `/opt/leyanxiu/server` 后，在 ECS 执行：

```bash
cd /opt/leyanxiu/server
sudo bash deploy/install-host.sh
sudo install -m 600 deploy/server.staging.env.example /etc/leyanxiu/server.env
sudoedit /etc/leyanxiu/server.env
```

分别生成三个不同的随机密钥，不要复用：

```bash
openssl rand -base64 48
```

另外生成后台管理员的 scrypt 密码摘要，环境文件中只填写摘要，不填写明文密码：

```bash
cd /opt/leyanxiu/server
npm run admin:hash-password -- '<由公司密码管理器生成的独立强密码>'
```

后台目录、能力接入工作流和验收证据必须写入宿主机挂载卷。模板已将
`ADMIN_*_STORE_FILE` 指向 `/var/lib/leyanxiu/data`，并将
`CAPABILITY_EVIDENCE_DIR` 指向 `/var/lib/leyanxiu/reports/capabilities`；不要删除这些配置，
否则只读容器无法初始化后台，且能力证据不会进入上线闸门。

模板暂时把 `PUBLIC_BASE_URL` 设为 `http://REDACTED_COMPANY_INFRASTRUCTURE`，只供 debug APK 使用假图
验证连通性。APK 的 Capacitor origin 为 `https://localhost`，所以保留
`CORS_ORIGIN=https://localhost`。
首次使用真实供应商时应把 `CLOSED_TEST_CREDITS` 调低到实际测试所需，并把
`CLOSED_TEST_DAILY_GENERATION_LIMIT` 设为团队可接受的每日最大成本对应次数。
正式 Android applicationId 已约定为 `com.yibohuaxia.leyanxiu`；如最终改包名，服务端
`APP_PACKAGE_NAME`、App 备案和签名材料必须同步修改。

## HTTPS 与部署

此次 debug APK 若必须先通过公网 IP 联调，只能使用非真人、非敏感测试素材，并显式启用
临时 HTTP 配置：

```bash
sudo env ALLOW_INSECURE_HTTP_STAGING=yes bash deploy/configure-http-staging.sh
sudo bash deploy/deploy.sh staging-ip-debug-1
curl http://REDACTED_COMPANY_INFRASTRUCTURE/health
```

此入口无传输加密，不得测试真人照片、真实账号、支付或生产密钥。完成连通性验证后立即
切换下述 HTTPS 配置；正式 APK 已强制 HTTPS，生产闸门也不接受 HTTP。

构建出的测试 APK 使用不可变版本名发布，Nginx 以正确 APK MIME、附件下载和 `no-store`
响应提供链接：

```bash
sudo bash deploy/publish-apk.sh /tmp/leyanxiu-debug.apk debug-20260904-1 http://REDACTED_COMPANY_INFRASTRUCTURE
# 输出形如：http://REDACTED_COMPANY_INFRASTRUCTURE/downloads/leyanxiu-debug-20260904-1.apk
```

每个 APK 同时生成 SHA-256；发布前在构建机完成签名校验，用户下载后可核对哈希。正式包应
改用 HTTPS 域名作为第三个参数，不覆盖旧版本文件，便于明确回退版本。

确认域名已解析且安全组 80/443 已开放后：

```bash
sudo bash deploy/configure-https.sh api.example.com ops@example.com
sudoedit /etc/leyanxiu/server.env  # 将 PUBLIC_BASE_URL 改为 https://api.example.com
sudo bash deploy/deploy.sh staging-20260904-1
sudo bash deploy/verify.sh api.example.com
```

证书由 Certbot 自动续期。用 `systemctl list-timers | grep certbot` 验证续期任务。

## 接入真实 AI/OSS

先用 `PROVIDER=mock` 验证 APK 网络、登录、上传和视频 Range 播放。随后只在
`/etc/leyanxiu/server.env` 填写 RAM AccessKey、私有 OSS bucket 和模板 ID/URL，改为：

```dotenv
PROVIDER=aliyun
TASKS_BACKEND=oss
OBJECT_STORAGE_BACKEND=oss
OSS_REGION=oss-cn-shanghai
```

执行私有桶审计并保存报告，再重新部署：

```bash
cd /opt/leyanxiu/server
sudo docker compose -f deploy/compose.yml run --rm api npm run storage:audit
sudo bash deploy/deploy.sh staging-real-api-1
```

凭据存在不等于能力合格。每项功能仍需以不同用户照片做真实测试，核对供应商费用、
输入输出删除周期、AI 标识和失败退款。

## 备份与恢复

合规台账和 OSS 对象索引仍在 ECS 持久卷，至少每天备份一次：

```bash
sudo bash deploy/backup.sh
```

把 `/var/backups/leyanxiu` 再同步到独立、加密的备份位置。单机本地备份不能应对整盘故障。
公测阶段只运行一个 API 容器；当前 JSON 合规台账不支持多实例并发写。

## 正式生产仍需完成

- Android 正式登录/token 方案及账号找回、封禁、注销闭环。
- App 备案号、API 域名 ICP 备案号、正式包名和公司批准的协议/隐私材料。
- 已核验的私有 OSS、最小权限 RAM、内容安全服务、供应商删除能力及真实样本证据。
- 生产监控告警、异机备份恢复演练、依赖高危漏洞处理和正式支付签名/对账（若收费）。

以上条件满足后，才可将 `DEPLOY_ENV` 改为 `production` 并运行
`npm run release:check`。闸门有阻断项时不得公开发布。
