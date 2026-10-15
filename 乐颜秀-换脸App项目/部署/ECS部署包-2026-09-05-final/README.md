# 乐颜秀 ECS 内测部署包（2026-09-05 final）

- 目标环境：Ubuntu 26.04，2 vCPU / 4 GiB，公网 IP `REDACTED_COMPANY_INFRASTRUCTURE`。
- 部署包：`leyanxiu-server-staging-2026-09-05-final.tar.gz`
- SHA-256：`602CD2A359B3C87A0E16EC6B9563D83253988218730A77C7E6F7B6CAF306F55F`
- 生产依赖审计：前端与服务端均为 `0` 个已知漏洞（npm 官方 registry，2026-09-05 检查）。
- 包内包含最新服务端、部署脚本和 Android 同源 Web 构建；不包含 `.env`、云 AccessKey、控制台密码、SSH 私钥、任务台账、历史照片或生成结果。

解包：

```bash
sudo install -d -m 0750 /opt/leyanxiu/server
sudo tar -xzf leyanxiu-server-staging-2026-09-05-final.tar.gz -C /opt/leyanxiu/server
cd /opt/leyanxiu/server
```

后续按包内 `deploy/README.md` 执行。服务端已加入内测全站每日生成上限；作品链接刷新接口返回 MIME/扩展信息；任务台账只允许本地单实例或阿里 OSS，生产强制 OSS。

未配置 HTTPS 前，只允许用非真人、非敏感样本做短时联调。服务器安装 Docker/Nginx、开放端口和上传环境密钥属于外部状态变更，必须在明确确认部署后执行。
