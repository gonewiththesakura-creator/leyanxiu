# 乐颜秀 ECS 后端部署包

- 目标：`REDACTED_COMPANY_INFRASTRUCTURE` / Ubuntu 26.04 / 2C4G / 5 Mbps
- 文件：`leyanxiu-server-staging-2026-09-04.tar.gz`
- SHA-256：`6AA9DBD879F2EE6CDED7C9795AB28FC8570782C154520373141684DB3064CA1A`
- 状态：可上传、待服务器安装确认；不包含 `.env`、AccessKey、控制台凭据、SSH 私钥、
  任务台账或历史真人测试素材。

解包：

```bash
sudo install -d -m 0750 /opt/leyanxiu/server
sudo tar -xzf leyanxiu-server-staging-2026-09-04.tar.gz -C /opt/leyanxiu/server
cd /opt/leyanxiu/server
```

随后按包内 `deploy/README.md` 执行。此次 debug APK 可显式启用纯 HTTP staging，
但只能使用非真人、非敏感测试素材。正式版本必须使用备案域名和 HTTPS。
