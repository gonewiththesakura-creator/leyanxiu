# 校验与还原完整归档

需要 Python 3.9 或以上，无需安装第三方包。假设当前目录包含 `full-backup/`。

仅校验所有分卷与唯一对象（不写还原文件）：

```powershell
python full-backup/restore_full_backup.py --backup full-backup --verify-only
```

还原到明确指定的新空目录：

```powershell
python full-backup/restore_full_backup.py --backup full-backup --destination D:\RestoredProjects\leyanxiu-archive
```

支持 `manifest.json` 或 `manifest.json.gz`，二者只能存在一个。工具先验证全部分卷 SHA-256、ZIP 成员、唯一对象大小与 SHA-256，再写出文件；重复内容按清单恢复全部原路径。仅 `status=excluded` 或 `excluded_*` 且无对象的记录跳过，其他缺失对象报错。

目标必须是不存在或空目录，不能与备份目录包含彼此；拒绝绝对路径、`..`、反斜杠、Windows 保留名、大小写/规范化路径碰撞、文件/目录碰撞、符号链接和 Windows reparse point。不覆盖任何现有文件。校验/还原期间不要让其他进程修改备份或目标目录。中途磁盘错误可能留下部分文件；工具不会自动删除它们，应另选新空目录重试。

输出 JSON 中 `verified=true` 表示校验成功；`restored=true` 才表示已还原。失败退出码为 1。清单和分卷应来自可信来源：文件自身的 SHA-256 不能证明发布者身份。脱敏文件是归档副本，不是原始私有文件；`.sanitized.zip` 和缺少私有配置的工程不可直接当作生产部署包。
