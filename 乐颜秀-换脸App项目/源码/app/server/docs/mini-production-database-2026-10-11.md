# 正式账本云端初始化验收（2026-10-11）

已通过现有 Chrome 中的微信云托管入口，在原 MySQL 实例建立独立逻辑库 `leyanxiu_xpay_production`，并从新连接确认唯一绑定为本小程序、env=0。随后创建正式专用账号并核实最小权限。没有购买新实例，没有复制、修改或清空沙箱库。尚未接入服务或开放购买。

执行前，既有实例手动快照 `10935107` 已成功；这不是恢复演练。首次只执行经过独立复审的 schema 第 2 阶段 34 条语句，全部成功：23 表、36 个强制 CHECK、12 个同库外键、21 张空业务表、schema=1。23 个列结构只读查询及完整预检通过。

实测 DMC 每条语句使用不同物理连接，默认 READ-COMMITTED、autocommit=1。因此未执行原 schema 第 4 阶段的跨语句事务，而使用独立审查并在隔离 MySQL 实测的 `production-binding-dmc-v2.sql`。执行前只读核对：非系统账号只有 root 与沙箱账号；沙箱账号仅获沙箱库 SELECT/INSERT/UPDATE/DELETE，无正式库权限；活动事务为 0，其他可见 root 连接为 Sleep，未部署任何连接该新库的服务。

唯一绑定 INSERT 执行一次，其自身结果明确“成功，影响行数：1 行”。随后新连接读取 vp_environment 仅有 id=1、AppID=REDACTED_APP_IDENTIFIER、env=0；完整 `production_initialization_verified=1`。此处不是用跨连接 ROW_COUNT 推断，也没有补发 COMMIT 或重试 INSERT。

该初始化依赖新库维护静默；单语句 NOT EXISTS 不阻止其他管理员并发写业务表。此限制及本地并发反例见 `mini-production-dmc-binding-2026-10-11.md`。绑定和新连接复核完成之前没有授予正式应用账号权限。

## 绑定后的正式专用账号

通过官方云托管密码框创建 `lyx_xpay_prod`@`%`。该界面要求至少一个全局权限且没有 USAGE 选项，因此只临时选择不授予表访问的 SHOW DATABASES；从未用新账号建立连接，随后立即 REVOKE 并通过 SHOW GRANTS 确认只剩 USAGE。再次核对新账号连接数为 0、partial_revokes=0，再授予正式库 SELECT/INSERT/UPDATE/DELETE。

最终 SHOW GRANTS 只有 USAGE 与 `leyanxiu\_xpay\_production`.* 的上述四项权限。每个下划线均转义为字面量，无 DDL、GRANT OPTION、角色或其他库权限；原沙箱账号仍只有原沙箱库四项权限。没有执行 FLUSH PRIVILEGES、重置 root/沙箱密码或开启数据库外网。

密码由本机加密随机数产生，独占保存于忽略文件 `.env.mini-production-db`；写入前已移除继承 ACL，仅本机当前用户与 SYSTEM 可访问。密码仅填入官方密码框，不进入 SQL、文档或工具输出。准备器 `scripts/prepare-mini-production-db-credential.mjs --check` 已复读校验，重复检查不会覆盖现有值。

这是账号存在和权限验收，不是密码连接/云服务验收。实际服务尚未使用该账号；首次部署仍须用受保护凭据校验实际登录、CURRENT_USER、正式库与 env0 绑定。不能以 root 或沙箱账号代替。

机器可读摘要：`evidence/mini-production-database-2026-10-11.json`。它是对实际 UI 回执的脱敏记录，不是数据库签名证明。原始 SQL 与旧制品保留；不要重复执行 CREATE 或绑定脚本。后续连接检查只读核对既有绑定即可。
