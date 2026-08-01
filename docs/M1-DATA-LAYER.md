# M1 项目数据层

版本：1  
日期：2026-08-01

## 项目容器

```text
project-root/
|- project.sqlite
|- assets/
|  |- images/
|  |- videos/
|  `- audio/
|- cache/
|- exports/
`- backups/
```

Worker 是数据库唯一写入者。项目以 `.ai-video.lock` 获取独占写锁；检测到同一项目已有活动写入者时，第二个 Worker 以 SQLite 只读模式打开。失效进程留下的锁在校验 PID 后清理。关闭项目时先执行 WAL checkpoint，再关闭数据库并释放锁。

所有资产路径必须是相对于项目根目录的路径。规范化后的路径必须仍位于项目目录内；绝对路径和 `..` 越界路径均拒绝。

## Schema v1

本节记录 M1 完成时的 Schema v1 基线。M3 Schema v2 为正式文档增加作用域字段，风险加固阶段的 Schema v3 为助手消息增加原始用户消息引用；迁移规则见 [M3 上下文与 LLM](M3-CONTEXT-LLM.md)。

Schema v1 包含：

- `schema_migrations`、`projects`
- `documents`、`document_versions`
- `scenes`、`shots`
- `conversations`、`chat_messages`
- `memories`、`constraints`
- `assets`
- `generation_drafts`、`generation_jobs`、`generation_results`
- `context_snapshots`

数据库启用 `foreign_keys = ON`、WAL、`busy_timeout = 5000` 和 `synchronous = NORMAL`。迁移与复合业务写入使用事务；不可变版本和请求快照只允许插入新记录。

## 生命周期

- 创建：创建固定目录、获取写锁、事务化迁移并写入项目元数据。
- 打开：校验数据库；获得写锁时迁移到当前版本，否则只读打开。
- 新版本：数据库版本高于应用支持版本时释放写锁并只读打开。
- 关闭：checkpoint、关闭数据库、校验 token 后删除锁。
- 备份：checkpoint 后调用 SQLite backup API，默认写入 `backups/`。
- 恢复：复制备份到空目录，先只读执行完整性检查，再按正常流程打开。
- 导出：将一致性数据库副本及 `assets/`、`exports/` 复制到项目外空目录。

## Repository 边界

`packages/persistence` 提供 Project、Document、Conversation、Memory、Constraint、Asset 和 Job Repository。业务层依赖接口，不拼接 SQL；Document、Conversation、Memory、Constraint、Asset 和 Job 已实现按项目保存、读取与列表查询，后续里程碑在这些边界上扩展具体用例。

## IPC v1

项目方法：

```text
project.create
project.open
project.close
project.current
project.recent
project.integrity
project.backup
project.export
project.restore
```

所有请求继续使用 IPC v1 信封与统一错误结构，备份和导出等异步操作通过同一 Worker 串行执行。
