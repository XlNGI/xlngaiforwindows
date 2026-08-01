# M2 项目文档与会话

版本：1  
日期：2026-08-01

## 正式文档

正式文档支持项目大纲、项目计划、角色设定、场景设定、分镜文档和创作笔记。`documents` 保存文档身份与当前版本指针，`document_versions` 保存不可变 Markdown 内容。

M3 Schema v2 已为正式文档增加项目、场次和镜头作用域；Schema v1 文档迁移后保持项目作用域。

- 每次保存都插入一个新版本。
- 文档元数据、版本记录和当前版本指针在同一事务内提交。
- 恢复历史版本不会覆盖记录，而是复制历史内容并创建一个新版本。
- 普通聊天消息不会自动修改文档。
- 只有用户执行“保存为文档”操作时，会话内容才进入正式资料。

## 场次与镜头

场次属于项目，镜头属于场次。位置按创建顺序递增，场次和镜头的归属在 Worker 中校验。当前 M2 提供创建、列表和状态存储；后续生产阶段在镜头边界上增加参数草稿、生成任务和资产关联。

## 三级会话

会话作用域分为：

- `project`：整个项目。
- `scene`：指定场次。
- `shot`：指定镜头。

场次与镜头会话必须提供有效 `scopeId`。消息按 `created_at + id` 稳定排序并使用游标分页。相同消息 ID 可以从 `streaming` 更新为 `complete` 或 `failed`，用于 M3 流式 LLM 接入。

会话消息可以通过明确操作保存为项目文档、项目记忆或生产约束。三种操作均独立执行，不会隐式联动。

## IPC v1

```text
document.list
document.get
document.save
document.versions
document.restore
scene.list
scene.save
shot.list
shot.save
conversation.list
conversation.create
chat.message.list
chat.message.save
chat.message.toDocument
chat.message.toMemory
chat.message.toConstraint
```

项目以只读模式打开时，列表与读取请求可用，所有保存、恢复和内容提升请求均拒绝。

## 工作台

左侧项目树展示正式文档、场次和镜头；中间区域提供 Markdown 文档编辑、版本列表和镜头工作区；右侧会话栏可在项目、场次和镜头作用域间切换。生产参数栏继续保留，等待 M4 适配器 Schema 接入。
