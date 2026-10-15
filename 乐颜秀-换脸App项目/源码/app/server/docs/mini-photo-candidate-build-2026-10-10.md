# 原生图片候选本地制品（2026-10-10）

已生成独立构建上下文；没有镜像构建、npm 安装、云 SQL、供应商请求、上传或部署。旧支付 builder/deployer 未修改，当前线上支付状态不变。

`1557` 制品已冻结留存，不再作为下一步候选：创作页初始化的 `Promise.all` 还需要公开资料和能力接口，旧制品对此返回 404。两项客户端合同已补齐并复审，替代制品于 2026-10-11 在新目录生成；见 [新版制品记录](mini-photo-candidate-build-2026-10-11.md)。旧目录及摘要未覆盖。

## 旧制品留存记录

- 目录：`D:\JT\乐颜秀\workspace\candidate-artifacts\mini-photo-candidate-20261010-1557`。
- manifest SHA-256：`e42cf4231c7c1ce30fccb254c032f1fe0095beda253a1783f8a6602a2e31ff8c`。
- 50 个明列文件加 `manifest.json`；文件内容总计 436,329 字节，不含 manifest。
- 原构建后独立 `--verify` 通过，并比较当时 44 项源码/SQL 的 SHA-256，与制品一致；这不是当前源码一致性证明。
- 入口 SHA-256：`82e0d882a3721ef9f0dc2664ac18d3a9abde12594c2f6f5bfa1c315cf9dd87ab`。
- Dockerfile SHA-256：`e7181a2e6530ebcb89727829d13fbd8a6ce8ecb62e7769489b3a6685a17210c5`。

这是已保存的本地版本。后续源码变化须重新生成新目录并记录新摘要，不覆盖此目录；旧摘要不能作为新源码的通过证据。制品哈希校验不等于数字签名、部署许可或容器运行证明。

## 可复用脚本

新增 `scripts/build-mini-photo-candidate.mjs`，复用只读 planner 的源码白名单、依赖递归投影和 literal import 扫描。先读完全部输入并完成验证，才以 exclusive mkdir 创建全新绝对输出目录；缺项、已有目录、链接源文件、越出白名单的 import、当前 lock 与固定 lock 不一致均拒绝。不执行 npm、Docker、云 API 或候选启动入口。

```powershell
node scripts/build-mini-photo-candidate.mjs <新的绝对目录>
node scripts/build-mini-photo-candidate.mjs --verify <已有候选目录>
```

只接受这两种本地操作；`--execute/--deploy/--install` 均拒绝。`--verify` 对实际文件集合、路径、普通文件、每项大小/hash、manifest scope、关闭门禁、精确 package/lock、Docker 策略及 literal imports 再核验；多出 `.env` 等任意文件也拒绝。不会把任意 JavaScript 静态扫描当成通用沙箱。

`deploy/mini-photo-candidate/` 包含精简 Dockerfile、六项精确直接依赖、从现有 v3 lock 投影的 116 个包、默认拒绝的 `.dockerignore`、镜像查询记录与 README。源码包不含私有配置、证据、用户数据、node_modules、旧 index 或旧支付启动入口。六份 SQL 是审查资料，不进入运行镜像、不自动执行。

## 镜像与默认运行边界

官方 Docker Registry 的 manifest/config 只读查询确认 `node:22-bookworm-slim` 的 amd64 config 对应 Node 22.23.3；Dockerfile 固定 manifest digest `sha256:efd0ab5780c2d9ab1f0f869571a00d5edb17793bff4cce4a2792e3eb0ffc7562`。仅查清单及配置，没有拉取镜像层。具体引用和查询时间见制品 `runtime-image.json`。

Dockerfile 设置非 root `node`、Python/Pillow/Noto CJK，构建时禁用 npm 安装脚本，执行实际字体检查、入口语法检查和无配置 import 检查。默认 env=1、购买/生成/处理/清理/对账全部关闭，`DEBUG/NODE_DEBUG/NODE_DEBUG_NATIVE` 默认空；若运行配置显式传非空，入口仍拒绝，不会通过 shell 隐藏它。保留 sidecar CA，未关闭 TLS 证书或主机名检查。

本机没有 Docker。`imageBuilt/linuxNpmCiVerified/linuxMarkerVerified/deployable` 明确为 false。Debian apt 版本未固定快照，未来实际构建会记录系统包版本，仍需保留最终镜像摘要和 Linux 运行验收。本地 Node/Windows Pillow 成功不替代这一步。

运行配置接口见 [候选启动入口](mini-photo-candidate-server-2026-10-10.md) 与包内 README：真实 policy/效果/凭据/验收报告受控挂载；不生成虚构批准清单或证据。不在本轮写入真实环境，也不覆盖现支付部署来源。

## 本地验证与剩余工作

初版 builder 八项 + planner 三项组合 **11/11** 通过；补 Docker DEBUG 默认和禁止追加开启的用例后，builder 八项再跑 **8/8**。覆盖已有输出保留、缺入口不生成半包、源链接拒绝、私有 canary 不入包、未知 import、锁漂移/安装脚本、Docker 追加 root/开放开关/全目录 COPY/DEBUG、文件 hash/manifest/额外文件及 CLI 限制。生成的实际制品另经独立校验及源码比较通过。

实际 Linux 镜像安装/启动、同库增量、受控真实配置、真实图片交付与真机验收、公开服务资料/可靠申请回执、正式商品及平台审批仍不由此构建证明。当前候选可以审查，不能直接视为正式运营版本。
