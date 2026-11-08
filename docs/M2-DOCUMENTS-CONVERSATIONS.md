# M2 项目文档与会话

版本：1  
日期：2026-08-01

## 正式文档

正式文档以 Markdown 项目资料形式保存，运行时权威内容位于项目根目录的 `project.sqlite`，不依赖独立 `.md` 文件。`kind` 保留项目大纲、项目计划、剧情约束文档、角色设定、场景设定、分镜文档和创作笔记等值：文档工作区列表按它筛选，短剧上下文按 `character`/`scene` 取用已发布的角色与场景提示词。`constraint` 文档用于约束剧情、人物行为和情节连续性；它与专用的生产约束记录，以及右侧“本会话要求约束”（仅作用于当前轮生成提示词）是不同来源。`kind` 用于项目文档内部分类，不授予文档生产约束权限，也不会把当轮会话要求保存进项目文档。普通项目文档按来源类型、状态、作用域和相关性检索。`documents.current_version_id` 保存当前工作版本指针，`documents.published_version_id` 保存默认权威版本指针，`document_versions` 保存不可变 Markdown 内容。

M3 Schema v2 已为正式文档增加项目、场次和镜头作用域；Schema v1 文档迁移后保持项目作用域。

- 每次保存都插入一个新工作版本。
- 文档元数据、版本记录和当前工作版本指针在同一事务内提交；发布事务才更新权威版本指针。
- 恢复历史版本不会覆盖记录，而是复制历史内容并创建一个新版本。
- 普通聊天消息不会自动修改文档。
- 会话“保存为文档”只创建可审阅草稿；只有用户显式发布后，内容才进入正式资料。工具栏的“保存并发布”把草稿保存与发布合并为一次用户操作，Worker 仍在一个事务内创建并批准审核记录（`mode: 'self_publish'`），因此审核留痕与冲突校验不变。
- 文档工具栏支持一次选择并导入 UTF-8 编码的 `.md` 或 `.markdown` 文件。导入标题取文件名，正文保持 Markdown，并创建可审阅的导入草稿；导入后即可被 `library.search` 按草稿命中，只有用户显式发布后才成为正式资料。单文件上限为 5 MiB，不支持的扩展名、目录、非 UTF-8 内容和超限文件由 Tauri 原生边界拒绝。

文档工作区把大纲（`outline`）、计划（`plan`）、剧情约束（`constraint`）和角色与场景（`character`/`scene`）合并为一个列表，并提供类型筛选和类型标签；新建文档沿用当前筛选类型，已打开的文档即使不匹配筛选也保持可见。左侧“约束”筛选展示剧情约束文档，左侧下方的“生产约束记录”仍展示专用制作约束实体，两者不互相转换。右侧会话中的“本会话要求约束”只作为当前请求的提示词要求，不自动保存为剧情约束文档。其余类型仍按领域隔离：作为 `note` 落库的小说章节在小说工作区、`storyboard` 文档挂在具体镜头下，均不进入文档工作区列表。Agent 创建草稿时应写入 `documentKind`；若模型省略，Worker 会按标题/正文推断大纲、计划、剧情约束、角色或场景，使草稿出现在对应筛选页，并在生成结束后自动打开。

## 场次与镜头

场次属于项目，镜头属于场次。位置按创建顺序递增，场次和镜头的归属在 Worker 中校验。每个镜头可关联一份分镜文档（`shots.document_id`，由 `shot.storyboard.save` 在事务中创建/更新 `storyboard` 文档并建立关联）；镜头工作区提供分镜标题与 Markdown 内容编辑。后续生产阶段在镜头边界上增加参数草稿、生成任务和资产关联。

## 三级会话

会话作用域分为：

- `project`：整个项目。
- `scene`：指定场次。
- `shot`：指定镜头。

场次与镜头会话必须提供有效 `scopeId`。消息按 `created_at + id` 稳定排序并使用游标分页；会话列表按 `updated_at DESC, id DESC` 展示最近活动。相同消息 ID 可以从 `streaming` 更新为 `complete` 或 `failed`，终态不可回退为活动态。

会话消息可以通过明确操作保存为项目文档、项目记忆或生产约束。三种操作均独立执行，不会隐式联动。

## IPC v1

```text
document.list
document.get
document.save
document.draft.save
document.versions
document.restore
document.review.submit
document.review.requestChanges
document.review.reject
document.publish
document.selfPublish
agent.task.createDocumentDraft
agent.task.list
agent.task.get
task.log.list
scene.list
scene.save
shot.list
shot.save
shot.storyboard.save
constraint.list
conversation.list
conversation.create
chat.message.list
chat.message.save
chat.message.toDocument
chat.message.toMemory
chat.message.toConstraint
```

项目以只读模式打开时，列表与读取请求可用，所有保存、恢复、审核、发布和内容提升请求均拒绝。

## 工作台

左侧项目树展示正式文档、场次和镜头；中间区域提供 Markdown 文档编辑、版本列表和镜头工作区；右侧会话栏可在项目、场次和镜头作用域间切换。生产参数栏继续保留，等待 M4 适配器 Schema 接入。
