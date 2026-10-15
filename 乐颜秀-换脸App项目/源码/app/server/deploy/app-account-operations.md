# App 账号闭测日志与运维准备

状态：本地准备，尚未部署；本文不表示已创建定时任务、启用日志、执行备份或清理。适用于独立阿里云 App 账号服务。现有 `server/security-log.js` 保持原样；`accounts/security-log.js` 是独立的持久账号安全日志。

## 集成接口

```js
import { createAccountSecurityLog, createSecurityRequestId } from '../accounts/security-log.js';
const accountLog = createAccountSecurityLog({ directory: configuredPrivateDirectory });
const readiness = await accountLog.ready();
const requestId = createSecurityRequestId(); // 服务端生成，不使用用户提交的 header。
const saved = await accountLog.record({
  event: 'phone.verify', result: 'attempt', reason: 'none',
  accountId: authenticatedInternalUserId, requestId,
});
// saved.ok=false 时拒绝业务副作用并返回503，同时进入运维告警/健康失败路径。
// attempt持久化成功才执行短信/登录等业务，再写 success / denied / failed 结果。
const health = accountLog.health();
await accountLog.flush();
// 正常停机：先停止接受业务请求，等待在途请求，再 close。
await accountLog.close();
```

构造函数不读 `.env`，不设置默认落盘目录。未配置时健康为失败，`record` 返回 `LOG_NOT_CONFIGURED`。集成者按受控环境选择路径，例如 `/var/lib/leyanxiu-app-account/security-logs`，但仅提供该字符串不会安装或配置服务。

每条记录只接受模块导出的事件/结果/原因枚举，以及 `usr_<UUID>` 内部 `accountId`、`deviceId`，服务端生成的 `req_<UUID>` 请求关联和数值 HTTP 状态码。未认证请求可以省略账号 ID。手机号、验证码、令牌、密钥、原始异常、请求体、原始 URL/查询串、IP、User-Agent 都不属于字段白名单；不要先把它们拼进枚举或 ID。记录时间由日志模块生成。字段 getter 不会执行，非法枚举和 ID 返回固定错误；健康中不提供日志正文或异常信息。

`health()` 返回配置/就绪/关闭状态、健康布尔值、成功写入/失败/无效/丢弃/排队数量、最近成功与失败时间、固定错误码和最小保存月数。统计从当前进程启动累计，不代表全盘历史总数。完整结果仅给受保护的内部运维端点；公开健康接口只暴露是否健康。调用方必须检查 `record()` 的结果；写满、配额用尽、权限错误、队列溢出、非法调用均不能当作成功。应暂停新的登录测试并通知运维处理，不能为恢复绿色状态删除未到期日志。

## 权限、完整性和保存期

- 日志专属目录须由服务用户 `leyanxiu-app` 拥有、权限 `0700`；文件为同用户 `0600`。应位于 systemd 已允许写入的 `/var/lib/leyanxiu-app-account` 下。拒绝符号链接、不安全权限和硬链接；不要复用 Web 静态目录或普通临时公共目录。
- 一个目录只允许一个进程实例写入。初始化取得独占锁，同一实例内部异步写入严格串行，每条完整 JSON 行写入并同步文件后才返回成功；新增分片还同步目录元数据。正常关闭释放自己持有 inode 的锁。Linux 锁记录 PID、`/proc/<pid>/stat` 的启动计数和系统 `boot_id`：确认原 PID 已退出、boot_id 已变化或 PID 的启动身份明确变化后才尝试接管，活跃原进程拒绝。接管再次核对 inode/身份，并以临时硬链接避免两个接管者同时删除替换锁。身份不完整、`/proc` 不可读、inode 变化或回收过程中中断留下额外硬链接时拒绝自动抢占，由运维确认处理；绝不能仅按锁的年龄删除。Windows 本地测试注入进程身份与目录同步适配器，尚不能替代 Linux 的真实 crash/restart 验收。
- 按 UTC 日期产生 NDJSON 分片。跨日只切换文件，不根据文件大小、数量或总容量删除历史。部署前估算容量并设置磁盘/配额告警；需要扩容时增加存储或迁移到受控存储，不能缩短仍有效的保存期。
- 至少保存六个日历月，按 UTC 月历计算，月末取目标月最后一天；边界所在日整体保留。`await accountLog.prune()` 默认只列到期分片，不删除；明确批准清理后才调用 `prune({ apply: true })`。事故、争议或依法延长时配置 `retentionHold: true`，到期分片也不删除。禁止对日志目录另配按体积或十四天清理的 logrotate/定时任务。
- 磁盘写满或部分写失败后，本实例停止后续追加并暴露失败。若某分片尾部不是完整换行，新实例拒绝追加；须保留原件、确定影响范围后进行审计修复，不能静默截掉记录。目录锁不是多机分布式锁，此模块不支持多个节点共同写 NFS/对象存储。
- 本模块没有创建后台清理任务，也没有安装故障告警。上线前须由集成与运维验证实际落盘、权限、磁盘空间、健康告警、停机锁释放与跨日分片；本地测试通过不等于这些运行条件已完成。

## 最小 Nginx 安全事件记录建议

以下只是待审核配置片段，未写入线上 Nginx。`map` 与 `log_format` 放在 `http` 上下文，`access_log` 在对应 App `server` 中引用。只记录状态、固定枚举方法与 Nginx 生成的请求关联，不使用 `$request`、`$request_uri`、`$uri`、`$args`、IP、Cookie、Authorization 或请求体。自定义 HTTP 方法归为 `OTHER`，避免原样记录攻击者的任意方法字符串。账号应用另记录服务器时间和事件类别。

```nginx
map $request_method $app_account_method {
  default OTHER;
  GET GET;
  HEAD HEAD;
  POST POST;
  PUT PUT;
  PATCH PATCH;
  DELETE DELETE;
  OPTIONS OPTIONS;
}
log_format app_account_security escape=json
  '{"status":$status,"method":"$app_account_method","request_id":"$request_id"}';
access_log /var/log/leyanxiu-app-account/security.ndjson app_account_security;
```

该日志与应用日志分别管理权限和容量。按日期轮替时保留原分片，至少保存六个月；不要用按数量/大小覆盖的循环日志。对 Nginx 产生的请求 ID 和应用的 `req_<UUID>` 应使用明确的服务器端关联机制，不能直接接受客户端传入的关联 header；现有模块只接受后者，以上片段本身尚未建立两者映射。关闭普通访问日志不等于已经具备必要的网络运行和安全审计。Nginx error log 也须另审查内容，避免 URI/参数泄漏；本方案不能代替真实运行检查。

## 清理、备份与恢复顺序

账号数据清理期限按《App账号闭测数据清理与功能限制方案》执行；日志保存和备份轮替是两套规则。清理作业先输出只读计数、范围与超期情况，再在一致性备份及恢复校验通过后执行已批准的清理。作业停机、超时或写入失败必须进入健康告警，不能继续宣称五分钟处理期限正常。

1. 日常备份目标是每日一致性加密备份、异机保存、滚动十四天。至少在 PostgreSQL 账库与 SQLite 身份库共同停止写入的边界备份；不能在活跃 WAL 数据库运行时只复制单个 `.db` 文件。现有 `backup-app-account.sh` 会停止服务、读取真实库及私有配置，仅作历史工具参考，不可用它来“查看是否准备好”。
2. 新备份通过校验和、隔离恢复、关键账号/账本状态比对后，才允许淘汰超出备份窗口的旧包。备份密钥独立保管；日志目录即便随某次备份打包，也必须另有至少六个月的保存副本，不能因十四天备份轮替丢失更早安全记录。
3. 为防止旧备份恢复已注销账号，保留覆盖全部可恢复备份窗口的注销清单与注销时间/稳定内部账号 ID。该清单应有独立的持久化与访问控制，并与财务保留义务分开；仅靠日志中出现 `account.deleted` 不能替代强制恢复门禁。
4. 恢复必须先在隔离环境完成，不发短信、不开放业务、不调用模型/支付。从独立保留的最新注销清单重新应用备份时点之后的注销，将对应会话、设备映射、验证码验证值和授权挑战全部失效，保留防刷计数，不重建账户、不合并套餐或改动财务账本。
5. 验证已注销账号无法恢复、旧令牌/验证码不能使用、最新撤回状态仍有效、套餐归属未变化、两个数据库处于同一恢复边界。注销清单缺失或重放失败时保持服务关闭。只有通过这些校验，才可执行获准的恢复切换。

当前日志模块不会读取/导出/恢复业务数据库，也没有实现独立注销清单或自动备份轮替；这些恢复条件必须由账号清理实现和运维验收分别证明。
