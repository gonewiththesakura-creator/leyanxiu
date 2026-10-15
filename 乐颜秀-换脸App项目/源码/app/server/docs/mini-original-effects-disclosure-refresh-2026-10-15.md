# 三效果披露受控刷新准备

状态：本地实现与离线验证完成；本脚本尚未创建正式记录、读取凭据、调用云端或发布页面。现有法律源文件、历史法律发布脚本和记录、017 发布 journal、policy、原版商品配置均未修改。

## 固定材料

- 候选目录：`output/original-effects-20261015/legal-candidate`。
- 新法律包 SHA-256：`5fd1a881060a0b1c5279e4c48cd40f6ff179dfbc27f9db8250fa4ab110723a0f`，16198 字节。
- 旧法律包 SHA-256：`628354a2f04d593b23f988410cc371d7a1171e7d04ce19c256fc7a471a34b226`。
- 新公开事实：`server/docs/production-config/original-effects-public-facts-2026-10-15.json`，SHA-256 `82206d8ef6dd1e4995224a878100a5ff0df99015df3d1aba0a88175da7ce7dce`。
- 实际变更只有 `terms.html` 的两段效果范围文案；新文件 12392 字节，SHA-256 `33bdca5764f0e637d43b7e4fb7b8400fe477b1812f96207b90e25b8d9ce5ea19`。
- 隐私与服务提供方页面字节不变。脚本固定校验全部三页、既有 Nginx site/snippet；不改 Nginx 配置、不 reload、不碰 Node 或数据库。

## 操作接口与边界

运行 `server/scripts/deploy-mini-original-effects-legal.mjs plan` 仅检查本地材料并输出固定计划。

后续动作均要求 `--sha256 5fd1a881060a0b1c5279e4c48cd40f6ff179dfbc27f9db8250fa4ab110723a0f`：

1. `prepare`：纯本地，独占创建 `output/mini-original-effects-legal/<SHA>/operation.json` 与包。旧记录不复用；已有或半成品目录拒绝覆盖。
2. `upload`：在新记录保存意图并创建不可复用标记，然后通过既有 ECS `SendFile` 上传固定包到新文件名。禁止覆盖远端文件。
3. `status`：只使用已知调用 ID 查询 `DescribeSendFileResults` 或 `DescribeInvocationResults`；匹配实例、目标文件、成功状态和结果哈希。不会自动重发写操作。
4. 上传确认后 `refresh`：先保存意图，再通过既有 `RunCommand` 执行固定事务。检查旧三页和 Nginx 哈希，独占建备份目录，保存旧 terms，原子替换 terms；错误时仅在当前页仍为已知旧/新哈希的情况下恢复旧页。
5. `inspect`：单独发送只读文件核查命令，随后 `status` 查询其结果。未知 upload/refresh 结果仅走此路径，不重复写请求。检查不会写远端恢复回执或删除证据。

任一超时或未知请求都保留 journal 与 started 标记。不得通过删除标记、改 phase 或改旧脚本来重复操作。状态回执不证明公网实际内容，发布后仍须分别 GET 三个既有 HTTPS 文档 URL，核对 200、内容字节/SHA、HTTPS 与页面内容，保存新的非敏感证据记录。

## 后端事实的准确衔接

新模块导出的 `prepareOriginalEffectsFacts(variables)` 为纯内存组装：验证本地新旧事实固定 SHA，要求传入配置中三个公开 URL、供应商留存说明、PIPIA 和旧披露均精确匹配旧事实，且仍为 env0 / merchant_test。唯一允许变更为 `AI_SERVICE_DISCLOSURES_JSON`，内容仅扩展供应商用途中的已开放效果名称。原有 `XPAY_PRODUCTS_JSON`、价格、权益数、有效期、商品 ID、密钥、用户白名单、退款白名单、policy 和验收 pins 全部原样保留；结果 summary 不包含变量值。

该函数不是云更新器，不会编辑当前 017、现有 journal 或任何线上 base。实际采用时必须：

1. 先完成上述法律页发布和 HTTP 哈希读回。
2. 重新只读获取当前候选版本和服务 base 的完整配置、发布单与流量状态；在新私有记录中绑定其快照、代码包、法律 HTTP 证据和 facts SHA。当前仍有测试发布单时不得绕过其状态去重放旧部署器或创建竞争发布。
3. 将 pure helper 的唯一变量差异交给另行审核的窄范围候选部署流程；其余配置逐项相等。需要 CloudBase 版本配置生效，不能只改本地 JSON 或仅更新 base 后声称现有版本已更新。不猜测在位版本更新/提升接口。
4. 新候选出现后，用真实版本详情核对 `AI_SERVICE_DISCLOSURES_JSON` 和其他变量不变；再在定向测试路由中读取公开资料接口与制作页并核对三效果、原版商品、协议链接和用途披露。仍不能用控制面 normal 代替实际路由、支付、交付或退款验收。

上述云动作和真实 HTTP/小程序读回本轮均未执行。测试在 Windows 临时目录运行生成的 Python 事务，保留实际替换/回滚/哈希判断；Unix 所有者、权限及目录 fsync 使用测试适配器，因此线上 Linux 文件权限检查仍须实际通过。
