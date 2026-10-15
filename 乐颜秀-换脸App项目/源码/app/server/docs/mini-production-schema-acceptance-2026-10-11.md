# 正式逻辑库初始化：本地准备与验收

目标是现有 MySQL 实例内全新的 `leyanxiu_xpay_production`，固定 AppID `REDACTED_APP_IDENTIFIER`、支付环境 `env=0`。本轮没有执行云 SQL，没有修改沙箱库，没有创建真实账号、密码或授权，没有开购或启动生成。

## 生成物

- [production-schema-v1.sql](../deploy/mini-payment/production-schema-v1.sql)：SHA-256 `6a8c2b685d9931017411fb438733e9ec01232347114de39ef673d943f9ef973e`。
- [纯本地生成器](../scripts/generate-mini-production-schema.mjs)：直接复用支付、身份和照片模块的 MySQL schema 导出。支付索引只解析 canonical `database.js` 的固定字面量数组，不执行源码字符串，不复用旧沙箱 SQL。
- `node scripts/generate-mini-production-schema.mjs --check` 核对产物和当前源码一致；无参数只报告 NO_OP；`--write` 只新建固定 SQL 路径，路径已存在即拒绝覆盖。没有数据库客户端、密钥加载或云调用。

最终结构为 12 张支付表、1 张登录身份表、10 张照片表，共 23 张表。所有 CREATE、FK REFERENCES、独立索引与数据语句显式限定新生产库，避免控制台当前选中的其他库影响目标。没有 `IF NOT EXISTS`、`INSERT IGNORE`、UPsert、DROP、ALTER、用户或权限语句。21 张业务表初始均为空；只写 `vp_schema(version=1)` 和审核后单独绑定的 `vp_environment`。

## 云执行的必要停止点

不要整份 SQL 一次运行。保持服务未连接新库，禁止控制台“出错继续”或 mysql `--force`。DDL 自动提交，外层 ROLLBACK 无法撤销已经完成的建库、建表与索引。

1. **核对实例与备份。** 主线报告云快照 `backup10935107` / 任务 `17507506` 在 2026-10-11 18:15（上海时区）成功。这是云步骤前提记录，不是本代理重新查到的状态，也没有该云快照恢复通过的证据。确认正是目标现有实例、MySQL 支持生效 CHECK（8.0.16 起）且备份仍可用。
2. **只读 preflight。** 必须返回 `READY_NEW_DATABASE`、目标库不存在、目标表零条。已有同名库即停，即使看似空库也不复用这份全新库流程。账号权限可见性不足不能把查不到当不存在。
3. **严格 DDL。** 分阶段创建新库、23 表、9 个独立索引和 schema 版本。任何错误立即停止，保留现场且不绑定；不自动删库、修补或重跑。每个 MySQL DDL 自身提交，不能靠回滚假称整体可逆。
4. **只读绑定前核对。** 全部 23 表的实际列读取必须成功；核对表、引擎、字符集、约束清单；21 个业务表行数全部 0；`ready_to_bind=1`。不接受仅 accounts/orders 为 0 的判断。非空效果表也阻止新库初始化绑定。
5. **单连接绑定事务。** `USE` 固定生产库；SERIALIZABLE 事务中的单条条件 INSERT 再核对表集、无触发器/事件、schema=1、环境未绑定和所有业务表为空。只插固定 AppID/env0，任何已有绑定均不替换。必须返回 `inserted_binding_rows=1`。
6. **只读 postflight 后手动 COMMIT。** 同一连接 `production_initialization_verified=1` 后才执行 SQL 中注释列出的 `COMMIT;`，再用新连接重复 postflight。任何异常、0 行或响应未知都不能盲目重试；先保持新服务断开并查清。失败时 ROLLBACK 仅撤销尚未提交的绑定，DDL 仍保留。

SQL 不证明备份可恢复、不证明是正确云实例，也不自动验证当前账号是否能看见所有元数据；这些需执行人单独确认。不能通过应用启动的自动绑定替代上面的步骤。服务账号随后只授新库所需权限，属于单独可审核操作；数据库名含下划线，授权语句应按服务器 `partial_revokes` 设置处理字面库名，不能未经核对使用通配授权。

## 已完成的本地验收

`tests/mini-production-schema.test.mjs`：**3/3** 通过，验证当前导出一致、固定目标/无危险语句、完整21表绑定门禁。

`tests/mini-production-schema-mysql-isolated.mjs`：现有受检便携 MySQL **8.0.46**，新随机临时 datadir、随机 localhost 端口、仅合成凭据；**6/6** 通过：

- 23 表均 InnoDB / Dynamic / utf8mb4_bin；36 个 CHECK 生效、12 个 FK 全部留在新库。
- 库、表、索引重放分别报错；缺表不能绑定。
- 不依赖 accounts 的孤立审计行、效果行、schema 版本漂移、额外表均阻止绑定。
- env1、其他 AppID、已经正确的 env0 绑定都不会被替换；回滚后的未绑定状态确为空。
- 绑定事务期间并发连接向业务表 INSERT 遇锁等待超时；提交后另一连接核实固定 AppID/env0，重复绑定插入0行。
- 单独合成 sandbox 原有表与行保持不变；另用合成表实证 DDL 在 ROLLBACK 后仍存在。

完整报告：`REDACTED_LOCAL_USER_PATH/AppData/Local/Temp/lyx-production-schema-fPELpn/acceptance.json`。`passed=true`、`stopped=true`、`portClosed=true`。这是本机 MySQL 语义验收，不代替云实例执行结果。此前同实例类型的合成本地 23 表 dump/restore 验收见 [候选 schema 验收](mini-photo-candidate-schema-acceptance-2026-10-11.md)，也不代替真实云快照恢复。

官方边界：[MySQL 隐式提交](https://dev.mysql.com/doc/refman/8.0/en/implicit-commit.html)、[CHECK 约束](https://dev.mysql.com/doc/refman/8.0/en/create-table-check-constraints.html)、[INSERT SELECT](https://dev.mysql.com/doc/refman/8.0/en/insert-select.html)。
