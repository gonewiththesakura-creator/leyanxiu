# 017 披露字段原位更新准备

本轮只进行了本地实现、离线测试与实时只读准备模拟。未保存正式私有 journal，未调用更新 API。旧 017 部署记录与所有旧 hash 锁定脚本保持不变。

## 已核实的最短路径

已安装 `@wxcloud/cloudapi 1.1.4` 导出 `tcbModifyCloudBaseRunServerVersion`。其 `dist/index.d.ts:2380` 明确接受 `envId`、`serverName`、`versionName`、可选 `envParams`；`dist/index.js:8719` 将其映射为 `ModifyCloudBaseRunServerVersion`，API version 为 `2018-06-08`。使用真实 SDK 加假传输的离线测试确认，只提供地域与上述四字段时，发出的 JSON 仅包含 `Region`、`EnvId`、`ServerName`、`VersionName`、`EnvParams`，不会补入未提供的资源、端口、备注或 `BasicModify` 参数。

腾讯云官方[操作审计接口清单](https://cloud.tencent.com/document/product/629/46720)亦列出该 Action。官方[环境变量说明](https://docs.cloudbase.net/run/deploy/configuring/environment/envs)说明环境变量绑定具体服务版本。这些证据确认接口存在和参数表达能力，不证明当前微信托管 test 版本实际接受请求、不重启容器或已应用到进程；必须以此次单次请求后的控制面和真实客户端读回确认。

CLI `service:config update` 使用另一接口 `tcbSubmitServerConfigChange`，没有 `versionName`，并返回管理任务 ID。本次不使用该服务级路径，也不使用可带流量/镜像/重建参数的 `RollUpdateCloudBaseRunServerVersion`。

## 实现与接口

新脚本：`server/scripts/update-mini-017-disclosure.mjs`。

- `plan`：纯本地、无凭据或网络读取。
- `prepare`：实时只读核对并创建独占新私有记录 `server/.env.mini-017-disclosure-update.json` 及备份。文件为 Git ignored，Windows 设置为当前账户与 SYSTEM 专有 ACL。
- `submit`：仅允许 prepared；再次精确对比快照，持久化 `update_requested` 后调用一次定向修改接口，保存回执摘要，然后只读状态查询。
- `status`：只读实时快照；报告与 before 或唯一允许 after 是否完全一致。任何非 prepared 阶段均不能再次 submit。未知结果不自动恢复、不补调其他接口、不取消发布或新建版本。

固定绑定发布单 `2856443`，task `2361455`，source `buildtest-016`，candidate `buildtest-017`，test / URL_PARAMS 单规则。准备阶段实际读取并绑定完整私有路由规则，输出不包含规则值。当前测试形态版本流量全零，脚本不将其解释为默认流量证明。

唯一变量差异为 `AI_SERVICE_DISCLOSURES_JSON`，由已固定 SHA 的新旧公开事实纯函数生成。候选 policy/acceptance pins、原 `photo10` 商品及 990 分/10 次/365 天、名单和其他变量保持不变；提交后的完整核对还要求 016 及历史版本详情、candidate 镜像/资源/端口、base、域名接入、发布单、路由和版本清单未改变。SDK 回执字符串仅保存 SHA，不作为实际应用证明。

脚本固定引用已读回的法律页证据 SHA `08612bbb3262520619555e36fa63608e4e6a44abb5f2e4cb876c71feafa9be9b` 和 017 原生只读验收证据 SHA `1c47df1b203a057c727d04ea3a66a70f86ba8569c4ddeb834947c30e03eef327`；原阶段证据不改写，新阶段使用独立记录。

## base 与后续验证

本次不更新 service base。它与版本 env 属于不同配置对象；为了当前 017 单一字段对齐，不必同时增加影响未来 deployment 的第二个写操作。状态字段 `baseIntentionallyUnchanged` 明确检查此边界。以后需要新部署时，应从已确认的 017 配置继承披露或在那次独立发布准备中显式组装新 facts，不能从旧 base 无条件覆盖回来。若平台意外同步 base，本次 `exactAfter` 为 false，必须读回核查，不能视作已完成。

执行后先等 017 normal，再用 `status` 确认唯一差异；随后按既有 URL_PARAMS 路由重新获取公开资料接口，确认三效果用途文案实际可见，并确认原商品、目录与其他事实保持原样。若 API 明确不支持该服务/版本或响应未知，不追加猜测参数、不自动改走服务级发布；保留独立请求意图后由只读现状决定下一步。当前无证据证明必须重建代码包。

验证：8 项 Node22 离线测试通过，涵盖固定路由和商品、完整配置 drift、先记录后请求、未知/回执写失败不重试、真实 SDK 假传输、只读状态及默认计划无网络。另以实际云只读快照运行 prepare 的内存写适配器通过，正式 journal 未落地。
