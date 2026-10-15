# 照片存储桶配置只读核查

2026-10-12 12:23:48（北京时间）。使用现有 `server/.env` 所指定的唯一 OSS 桶，服务凭据只在内存中；未查询其他账号/桶。此前 10 月 9 日证据已证明桶 ACL 非 private 和一个合成私有对象的隔离/删除，本次补查原未确认的版本、复制及当前生命周期，未重复对象验收。

执行入口 `scripts/inspect-mini-photo-bucket-config.mjs --run`，恰好六个配置 GET：GetBucketInfo、GetBucketVersioning、GetBucketReplication、GetBucketLifecycle、GetBucketPolicy、GetBucketPublicAccessBlock。SDK wrapper 只允许指定桶及这六个 GET 子资源，各最多一次，`retryMax=0`。未列举对象、读取媒体、上传、删除、修改云配置或调用模型/审核。输出按固定字段投影，不带桶名、账户、目标复制桶、对象键、policy 原文、URL、密钥或 SDK 异常正文。已完成语法检查、默认无调用 plan 检查，以及生命周期额外过滤器/公开 principal/私有字段 canary 的离线投影检查。

报告：`../evidence/mini-photo-bucket-config-2026-10-12.json`；SHA-256 `a72ec785975a5b6b7d1fa966d007e8ee26b8b3e0758a46b374183454995cc9f`。报告存在时脚本拒绝重复 `--run`。

| 项目 | 当前配置读取结果 | 结论边界 |
| --- | --- | --- |
| 地域 | 与配置相符（上海） | 未检查厂商每个内部副本的物理位置。 |
| 桶 ACL | public-read，非 public-read-write | 不能称“整个桶私有”；也不能直接推断每个显式 private 对象公开。 |
| Bucket Public Access Block | 未启用 | 全局、访问点等上层/其他层级未核查；有效匿名访问仍以精确对象测试为准。 |
| Bucket Policy | 未配置 | 不代表 RAM/账号策略不存在；没有打印或修改任何访问策略。 |
| 版本控制 | 未启用（不是 Suspended） | 只证明当前桶配置，不证明无外部备份或历史复制。 |
| 复制 | 无复制规则；bucket info 也显示 CRR 关闭 | 不证明过去目标桶中的副本已删，也不包括独立备份产品。 |
| 生命周期 | 0 条规则 | 三个受控前缀均无配置层自动到期/非当前版本删除兜底。 |
| 冗余 | LRS | 服务内部冗余不是应用可枚举的复制规则，未核查内部销毁细节。 |
| 桶级访问日志/默认加密 | 未配置 | 不等同于所有日志关闭或每个对象均未加密。 |

三个受控前缀为 `private/mini-photo-input/`、`private/photo-outputs/`、`private/photo-moderation/`。24 小时策略目前来自应用的访问/清理实现；本桶没有自动生命周期来使它自然成立。正式启用图片前仍需证明持续 worker、到期/撤回路径、失败重试及精确对象删除观察，不能把本报告写成删除验收。

最小后续是继续现有逐对象 private 和受控签名，核验正式实际对象与清理机制。混合资源桶不应直接整桶改 ACL/Block Public Access 造成现有公开素材断链；如要添加前缀级兜底生命周期，应先确定适用对象、保留期及迟到写入/清理责任，不在本次只读核查中自动执行。PIPIA 的“上海私有桶”已更正为“上海桶内受控前缀”。

接口和语义依据：[GetBucketInfo](https://www.alibabacloud.com/help/en/oss/developer-reference/getbucketinfo)、[版本状态](https://www.alibabacloud.com/help/en/oss/developer-reference/getbucketversioning)、[复制规则及未配置错误](https://www.alibabacloud.com/help/en/oss/developer-reference/getbucketreplication)、[Public Access Block](https://www.alibabacloud.com/help/en/oss/developer-reference/getbucketpublicaccessblock)、[生命周期与非当前版本](https://www.alibabacloud.com/help/zh/oss/user-guide/configuration-elements)。
