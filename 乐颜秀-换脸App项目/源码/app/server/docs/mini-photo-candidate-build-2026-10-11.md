# 原生图片候选替代制品（2026-10-11）

本轮仅收尾本地打包。先确认中断前没有生成新版，随后新建独立目录；没有 npm 安装、镜像构建、云 SQL、供应商调用、上传或部署。

## 当前候选

- 目录：`D:\JT\乐颜秀\workspace\candidate-artifacts\mini-photo-candidate-20261011-0900`。
- manifest：上述目录下的 `manifest.json`。
- manifest SHA-256：`e99b22faf1c7a6bf91941504b1eef096f1d3fcce61ff85125679e0deb680890a`。
- 51 个明列文件加 manifest；51 项文件内容共 440,374 字节。
- 独立进程 `--verify` 通过，当前 45 项源码/SQL 再比较 SHA-256，无不一致项。
- 入口 SHA-256：`88dd8f331dd8a96aa8ab78c674cfdaa5005b974d0aab1c374bed62d44a3a51d3`。
- 公开模块 SHA-256：`07a5d5bf237644b5eb8639fef664259f0488ee716889e6b5f3768e572b1c0249`。

## 替换原因与范围

旧 `mini-photo-candidate-20261010-1557` 对创作页初始化所需的 `/api/public/compliance` 和 `/api/capabilities` 返回 404，导致 `Promise.all` 失败。新包收录 `photo-jobs/candidate-public.js`，以及与它接线的 `candidate-host.js`、`candidate-server.js`。公开资料仍按实际缺项标记 pending，能力不开启；`/api/reports` 明确返回未受理，不假称产生客服回执。

与旧包逐项比较，源码仅上述三项新增或变化。Qwen 适配器字节未变，SHA-256 为 `cb287a3df48413bc52556629c1f56a53cdf35cc08dc35ca00fa7afee3b45d756`；直接依赖 package 和投影 lock 均与旧包相同，仍为六项精确直接依赖、116 个锁定包。Docker 策略及默认关闭门禁未改变。

旧目录完整保留，旧 manifest 摘要仍为 `e42cf4231c7c1ce30fccb254c032f1fe0095beda253a1783f8a6602a2e31ff8c`。旧包作为历史留存，新包作为后续审核候选，不能混用摘要。

## 验收与边界

本代理在最终源码上重新运行 builder 八项和 planner 三项，共 **11/11** 通过，随后对真实新包执行独立 `--verify` 和源码比对。主线交接另确认公开模块/宿主/服务客户端独立 **40/40**、入口相关 **110/110**；这些属于主线及入口代理的本地验收，不冒充本代理重复执行。

包内 env=1、mode=closed；购买、生成、处理、清理、对账、正式支付均关闭。没有 `.env`、私有凭据、用户数据或私有验收证据。`deployable/imageBuilt/linuxNpmCiVerified/linuxMarkerVerified` 仍为 false。

尚需实际 Linux 镜像安装与运行验收、真实受控配置和同库增量，以及真实图片交付、真机和正式运营资料验收。当前哈希证明文件完整性，不是运行证明或部署许可；本轮未修改任何功能或现支付部署脚本。
