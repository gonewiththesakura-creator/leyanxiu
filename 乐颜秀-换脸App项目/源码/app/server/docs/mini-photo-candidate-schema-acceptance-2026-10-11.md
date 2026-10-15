# 候选图片同库 DDL 与备份恢复本地验收（2026-10-11）

本轮只读审计与本机隔离验收，不连接云数据库、不执行真实库 SQL、不调用支付或图片供应商。Docker、Podman 均不在本机，WSL 报告未安装，因此没有声称 Linux 镜像通过。

## 工具和边界

使用此前已核验的 MySQL 8.0.46 Windows 便携 ZIP，仅在新随机 datadir、127.0.0.1 随机端口和三个随机测试库中运行。脚本固定只接受该便携包路径和当前候选包 manifest：

```powershell
node tests/photo-candidate-schema-mysql-isolated.mjs REDACTED_LOCAL_USER_PATH\AppData\Local\Temp\lyx-photo-mysql-20261009-6f5d34b2
```

脚本文件：`tests/photo-candidate-schema-mysql-isolated.mjs`。无参数只输出 `NO_OP`；不读取 `.env`，只使用进程内随机密码；实例退出后确认端口关闭。最新临时报告为 `REDACTED_LOCAL_USER_PATH\AppData\Local\Temp\lyx-photo-schema-2tAlZN\schema-acceptance.json`，该路径是本机复核证据，不是线上状态。

## 结果

- 当前候选 manifest `e99b22faf1c7a6bf91941504b1eef096f1d3fcce61ff85125679e0deb680890a` 已独立验证。
- 在既有支付 13 张表的全新空库上，按 context、job、upload、generation 四份候选 DDL 创建 10 张图片表；共 29 个生效 CHECK、11 个外键，均为 InnoDB、Dynamic、utf8mb4_bin。
- 迁移角色只持有目标库 `CREATE, INDEX, REFERENCES`；运行角色只有目标库 `SELECT, INSERT, UPDATE, DELETE`，无法 `CREATE TABLE` 或 `ALTER TABLE`；错误外键和 CHECK 均按预期拒绝。
- 构造了同库身份、订单、余额、预占、退款、审计、上传、作品、生成及清理的合成元数据，表计数为 23；没有真实用户、图片、密钥或供应商数据。
- 用只读账号 `mysqldump --single-transaction --quick --skip-lock-tables --no-tablespaces --skip-triggers` 生成逻辑备份，恢复到另一全新库后，23 张表的行数、行哈希、列元数据和规范化 DDL 一致，源库保持不变。备份 27,879 字节，SHA-256 `4d01d5b06e6491bc03decb82f9b6f46e5de46979f82e1527ffec0aa8e7734efa`。

最终四项全部通过。此前五次本地脚本调试未完成全套：受限账号的缺失父记录错误为 1216（不是有详细信息的 1452）；mysqldump 恢复后 SHOW CREATE 为每个文本列补显式 `CHARACTER SET utf8mb4`，不能直接用原字符串比较。本脚本现在接受两个明确外键错误码，并单独比较真实列类型/默认值/字符集/排序规则，只规范化等价的显式 utf8mb4 拼写；没有删除结构或数据断言。所有临时实例均已关闭，历史调试目录留存，没有覆盖证据。

## 迁移执行边界

这些 SQL 是显式迁移资料，不应由 JavaScript import、服务启动或 Docker build 自动执行。正式操作应先做目标库/版本/表结构只读核对，再由短时迁移账号按依赖顺序执行：既有支付基础 → `mini_photo_accounts/effects/assets/works` → `mini_photo_jobs` → upload 表 → generation 表；逐句记录成功与失败，任何错误停止，不盲目重复整份脚本。

`CREATE TABLE IF NOT EXISTS` 成功只表示语句没有新建冲突表，不能证明旧表字段、CHECK、外键或排序规则兼容；同名索引重放也会返回冲突，必须先查询实际索引定义。MySQL DDL 会隐式提交，不能把整份建表脚本包进事务后依赖 `ROLLBACK` 撤销；因此正式回滚应采用预先备份、逐项反向变更方案或恢复到独立验证过的备份，禁止现场 `DROP`/重建业务表。

四份图片 SQL 的唯一写操作是十条建表和一条建索引，不改既有 vp 表或数据。代码回退以重新关闭图片入口/处理并排空为先；保留新增表、已提交意图及清理责任，不能为了回退旧代码而删除 unknown/claimed/退款/清理记录。仅仅停 worker 不履行已有照片的删除责任，需要保留具备相应 schema 的清理执行路径。

| 顺序 | 审核文件 | 新表 |
| --- | --- | --- |
| 1 | `photo-jobs/context-schema.sql` | accounts、effects、assets、works（均带 `mini_photo_` 前缀） |
| 2 | `deploy/mini-payment/photo-jobs-schema-v1.sql` | jobs，及 `mini_photo_jobs_pending(state,created_at,id)` 索引 |
| 3 | `photo-jobs/upload-schema.sql` | uploads、upload_cleanup |
| 4 | `photo-jobs/generation-schema.sql` | generation、generation_operations、generation_cleanup |

准备在云 DMC 逐项执行时，先只读核对 `DATABASE()`、`@@version`、`vp_schema` 唯一 version=1、`vp_environment` 唯一 id=1/正确 AppID/env=1；核对既有 `vp_auth_sessions`，并对已存在图片表获取 `SHOW CREATE TABLE`。`information_schema.TABLES/COLUMNS/STATISTICS/TABLE_CONSTRAINTS/KEY_COLUMN_USAGE/CHECK_CONSTRAINTS` 必须与上表四文件比较，包括全部列、默认值、索引顺序、同库外键、生效 CHECK 和 utf8mb4_bin。`prepare()` 的 `SELECT ... LIMIT 0` 仅证明显式字段存在，不替代这项完整结构比较。先完成私有全库备份及恢复验证，再执行实际缺失且已审核的增量；此文档没有执行这些云操作。

备份账号按 MySQL 官方 `mysqldump` 最小要求配置：目标表 `SELECT`，必要时 `SHOW VIEW`/`TRIGGER`；本候选命令使用 `--no-tablespaces`，避免额外 `PROCESS` 需求。生产备份前需根据实例 GTID、视图/触发器和平台权限另行确认，不能把本机逻辑恢复等同于云端灾备演练。

生产必须备份同一时间点的整套身份、账本、照片及清理表，不能只导出十张新增表；数据库备份不包含 OSS 照片字节、供应商内部数据或解密会话所需的应用密钥。备份期间禁止并行 DDL，运行账号不应获得备份或建表管理权限；真实凭据用受控挂载/工具交互输入，不能放命令行、构建参数或公开日志。本脚本的进程环境密码仅用于新创建的临时合成账号，不是生产凭据传递范式。

目标库名含下划线；在数据库级授权前核对 `@@GLOBAL.partial_revokes`，值为 0 时应把库名中的 `_` 作为字面字符正确转义，防止授权匹配其他库。不能仅因用了反引号就认为下划线已失去通配含义，也不应为了授权临时修改全实例 `partial_revokes`。核对实际 `SHOW GRANTS` 和连接测试。本地随机测试库名只含字母数字，不替代真实库名的授权审查。见 [MySQL 部分撤销与授权模式](https://dev.mysql.com/doc/refman/8.0/en/partial-revokes.html)。

官方依据：[DDL 隐式提交](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html)、[CREATE TABLE](https://dev.mysql.com/doc/refman/8.0/en/create-table.html)、[mysqldump 权限与一致性要求](https://dev.mysql.com/doc/refman/8.0/en/mysqldump.html)。

## 仍需真实完成

云端目标库的当前结构、迁移权限、备份保存与恢复证据，以及候选连接实证均未在本轮执行或复核；应以主线最新实际证据为准，不能从本地成功推断完成。Linux 镜像构建与运行验收仍缺。本轮固定候选保持 env=1、闭售，图片生成/处理/清理/对账均关闭。

无 Docker 的本机不新增系统安装绕路；可使用已有获准的 Linux amd64 构建环境，对已验摘要的独立候选目录执行包内 README 给出的 Docker 构建步骤，保留最终镜像摘要、系统包版本、干净 npm ci 与 Noto/Pillow/非 root 启动证据。没有可用且已授权的构建环境时，这项就是实际阻碍，不能以 Windows 测试或 Registry digest 查询替代。构建失败不应自动切换镜像标签或取消字体/TLS/权限检查。

0900 候选内容未改。本轮过程中另一个代理修改了工作区 Qwen 安全诊断字段；该变化不在此固定包内，也不改变十表 DDL，本报告不能作为更新后源码已入包的证明。若主线采用该修改，须另建新候选目录和摘要，保留 0900 历史包。
