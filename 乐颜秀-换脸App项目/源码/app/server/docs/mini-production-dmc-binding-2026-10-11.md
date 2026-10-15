# DMC 每语句新连接下的正式库绑定

根代理在云 DMC 实际确认：相邻两条 SQL 的 CONNECTION_ID 不同，连接变量不保留；autocommit=1、隔离级别 READ-COMMITTED。因此不能执行原 `production-schema-v1.sql` 第 4/5 阶段的跨语句事务，也不能用下一条 `ROW_COUNT()` 推断上一条 INSERT 的影响行数。

本次原 schema SQL 保留不变。DMC 使用独立 `deploy/mini-payment/production-binding-dmc-v2.sql`，SHA-256 为 `343235708607bf342a954b7055f0b9ef233edc0b5028c65c2a706bd4a6240d91`。生成器为 `scripts/generate-mini-production-dmc-binding.mjs`，无参数 NO_OP，`--check` 只比对本地字节，不连接数据库。

这是一条完整的 INSERT SELECT：固定正式库、AppID、env=0；同语句检查当前 DATABASE、autocommit=1、隔离级别 RC/RR/SERIALIZABLE、精确 23 表名/引擎/字符集、无触发器/事件、schema=1、36 条 enforced CHECK、12 个同库外键、env 为空和全部 21 张业务表为空。不包含密码、授权、DDL、USE、SET、START、COMMIT 或自动重试。成功影响一行即已原子自动提交；不存在后续人工 COMMIT。

## 执行前必须已有的事实

只适用于刚完成建表、尚未接入任何应用的静默新库。应由现有管理员只读核对已知应用账号的 SHOW GRANTS、当前服务配置和部署状态，确认没有可用的正式库应用账号/连接，也没有其他管理员/root 写入或 DDL；维持此状态直到后置核对完成。`ready_to_bind=1` 本身不能证明这个权限和运维前提，SQL 也不能自证不存在其他 root 会话的未来写入。

保持 DMC 当前选库为 `leyanxiu_xpay_production`。可从 `productionDmcBindingPlan().preflight` 取得只读预检 SQL，必须显示 selected_database 正确、autocommit=1、已知隔离级别、ready_to_bind=1。然后只执行 v2 文件中的唯一 INSERT SELECT，要求该 INSERT 自己的执行结果影响行数=1。

若影响 0 行、报错或返回未知：停止，不盲重放、不改绑定、不清表。从新连接执行原 schema 的两条 postflight（或 `productionDmcBindingPlan().postflight`）：先读 vp_environment 必须仅有指定 AppID/env=0 的 id=1，再完整检查 production_initialization_verified=1。任何不一致保留现场处理；不要假称可用 ROLLBACK 撤回已自动提交的绑定。

## 本地验证及真实限制

隔离 MySQL 8.0.46、全新 localhost 数据目录、合成凭据，未读取 `.env` 或执行云 SQL。默认 RC/autocommit=1，实际运行 `tests/mini-production-dmc-mysql-isolated.mjs` 4/4 通过；静态合同 `tests/mini-production-dmc-binding.test.mjs` 2/2 通过。

- 错误选库、autocommit=0、READ-UNCOMMITTED 拒绝绑定。
- 非空审计/效果表、既有 env1/env0/其他 AppID 绑定、额外表、未强制执行的 CHECK 拒绝绑定且不替换既有数据。
- 受控并发反例：另一个本地事务暂时阻挡目标 INSERT 时，其他管理员仍能写入业务表；原语句之后可能提交绑定，fresh postflight 会检测到业务非空并返回 0。因此外部维护隔离是必需前提，不能称 SQL 阻止任意并发写入。
- 在无人写入的全新本地库，唯一 INSERT 影响一行且自动提交；新连接看到准确 env0 绑定和完整 postflight=1；重复原语句影响 0，不覆盖。

验收报告：`REDACTED_LOCAL_USER_PATH/AppData/Local/Temp/lyx-production-dmc-PjhnYc/acceptance.json`，passed=true、stopped=true、portClosed=true、cloudSqlExecuted=false。

之前尝试证明 RR/autocommit 下全部 NOT EXISTS 子查询会锁住来源表，该断言实际失败：第三连接可写 vp_audit。失败报告保留于 `REDACTED_LOCAL_USER_PATH/AppData/Local/Temp/lyx-production-dmc-xP5T5G/acceptance.json`；未把它改写成通过，v1 DMC SQL保留作为未采用的 RR 限制版本。v2 不依赖该错误假设，不更改全局隔离、不创建过程或额外网关。

本地证据仅支持这个受限的单语句初始化路径，不表示云端已经完成绑定、应用已授权或服务已上线。
