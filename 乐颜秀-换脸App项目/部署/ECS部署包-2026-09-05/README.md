# 乐颜秀 ECS 内测部署包（2026-09-05）

- 目标环境：Ubuntu 26.04，2 vCPU / 4 GiB，公网 IP `REDACTED_COMPANY_INFRASTRUCTURE`。
- 部署包：`leyanxiu-server-staging-2026-09-05.tar.gz`
- SHA-256：`EA724F02B1DEBCFA525AEB8235D9BDB44345BF042F132C3F308DF0BEF1CB2F3F`
- 包内包含最新服务端、部署脚本和本次 Web 构建；不包含 `.env`、云 AccessKey、控制台密码、SSH 私钥、任务台账、历史照片或生成结果。

解包：

```bash
sudo install -d -m 0750 /opt/leyanxiu/server
sudo tar -xzf leyanxiu-server-staging-2026-09-05.tar.gz -C /opt/leyanxiu/server
cd /opt/leyanxiu/server
```

后续按包内 `deploy/README.md` 执行。服务端已经加入内测全站每日生成上限，作品链接刷新接口会返回 MIME/扩展信息。未配置 HTTPS 前，只允许用非真人、非敏感样本做短时联调。

服务器安装 Docker/Nginx、开放端口以及上传环境密钥属于外部状态变更；必须在明确确认部署后执行。
