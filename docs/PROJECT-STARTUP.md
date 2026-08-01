pn# 项目启动文档

版本：0.2  
日期：2026-08-01  
状态：已确认，可进入工程实施

## 1. 产品定位

本项目是一款本地 Windows AI 短剧生产工作台。它不是自动替用户完成全部生成的流水线，也不是简单的 Chat 加 API 外壳。

LLM 承担导演和创作助手职责：围绕用户确认的大纲、项目计划、项目记忆、角色场景设定和生产约束，按当前场次或镜头生成分镜、提示词、表演说明和生产建议。用户保留模型选择、参数编辑、素材选择、任务提交和结果验收权。

## 2. MVP 目标

1. 创建和打开本地短剧项目。
2. 在项目会话中创作或导入剧情，并生成大纲、项目计划、角色、场景和分镜内容。
3. 将用户确认的会话产物显式保存为版本化项目文档或项目记忆。
4. 按项目、场次、镜头作用域组装 LLM 上下文。
5. 用户选择生产方式、供应商和模型后，由适配器动态显示对应参数 UI。
6. 用户复制和修改 LLM 产出的提示词，自行填写并提交模型参数。
7. 支持同步生图、异步参考生视频和首尾帧生视频。
8. 本地保存素材、请求快照、任务状态和结果，并在应用重启后恢复轮询。

## 3. MVP 非目标

- 不让 LLM 自动填写或自动提交厂商 API 表单。
- 不根据普通聊天内容自动修改正式项目文档。
- 不建设云端账户、多人协作或跨设备同步。
- 不部署公网回调服务。
- 不在第一版实现复杂剪辑、口型、数字人、配音和音乐工作站。
- 不引入需要用户安装或运维的 PostgreSQL、MySQL、Redis、消息队列或向量数据库。
- 不在第一版运行本地 PyTorch、ComfyUI 或计算机视觉模型。

## 4. 核心用户流程

```text
创建或导入剧情
-> 与 LLM 讨论并生成大纲/项目计划
-> 用户确认并保存项目文档
-> 生成角色、场景、分场和分镜
-> 进入当前场次或镜头会话
-> LLM 基于正式项目上下文生成生产内容
-> 用户选择生产方式、供应商和模型
-> 系统锁定适配器并显示参数 Schema
-> 用户复制、修改提示词并填写参数
-> 提交生成任务
-> 同步接收结果或本地轮询异步任务
-> 用户审核、保留、重试或更换生产方式
```

## 5. UI 信息架构

桌面端采用四栏工作台：

1. 项目导航：大纲、计划、角色、场景、镜头和资产。
2. 主工作区：当前场次、镜头、素材和生成结果。
3. 生产参数：生产方式、厂商、模型和适配器动态表单。
4. 项目会话：独立 Chat、当前引用范围和 LLM 创作产物。

四栏应支持调整宽度和折叠。窄屏时，参数和会话区域移动到主工作区下方。整体采用紧凑、安静的影视制作工具风格，避免营销页面和卡片堆叠。

## 6. 技术架构

```text
Tauri Desktop Host
|- React + TypeScript UI
|- Tauri Commands
|  |- 文件和目录权限
|  |- Windows 凭据管理
|  `- Node Worker 生命周期
`- Node.js/TypeScript Worker
   |- Conversation Service
   |- Context Compiler
   |- LLM Provider Adapters
   |- Generation Adapter Registry
   |- Local Job Poller
   |- SQLite Repositories
   `- Local Asset Storage
```

技术选型：

- Tauri 2、React、TypeScript、Vite。
- Node.js 当前 LTS 版本的本地 Worker。
- 内置 SQLite；数据库只由 Node Worker 访问，UI 和 Tauri Host 不直接读写。
- 默认使用 `better-sqlite3`，随 Windows 安装包预编译并分发，不依赖用户本机环境。
- JSON Schema + Ajv 负责适配器表单和请求校验。
- Zustand 管理 UI 会话状态，TanStack Query 管理 Worker 请求和任务状态。
- SQLite 保存结构化数据、文本和任务状态；本地目录保存媒体、缓存、导出和备份。
- API Key 由 Windows Credential Manager 或 DPAPI 保存。

## 7. 代码模块

```text
apps/
|- desktop/                 # Tauri + React
`- worker/                  # Node.js 本地 Worker

packages/
|- domain/                  # Project、Scene、Shot、Asset 等领域类型
|- contracts/               # IPC DTO、JSON Schema、错误码
|- persistence/             # SQLite Repository、迁移、备份
|- context/                 # 上下文组装与预算控制
|- llm/                     # LLM 供应商抽象
|- generation-adapters/     # 生图/生视频适配器
`- job-runner/              # 提交、轮询、恢复、取消
```

业务层只依赖 Repository 和 Adapter 接口，不直接依赖文件路径或厂商 SDK。

## 8. 本地项目格式与数据库

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

SQLite 保存项目、文档版本、Chat、记忆、约束、镜头、资产元数据、参数草稿、任务状态、生成结果和上下文快照。图片、视频、音频等大型二进制文件只保存在 `assets/`，数据库保存相对路径、Hash、类型、大小和来源。

数据库维护 `schema_version`，应用打开项目时先执行完整性检查和逐版本迁移。未知的新版本只能只读打开。所有写操作由 Node Worker 单进程串行管理，并使用事务保证文档版本、任务状态和资产关系一致。

关键数据库设置：

```text
WAL mode
foreign_keys = ON
busy_timeout
事务化业务写入
关闭/备份前 checkpoint
```

项目导出时使用 SQLite backup API 生成一致性副本，再与 `assets/` 一起打包。用户不需要安装或配置任何数据库服务。

### 8.1 核心数据表

```text
schema_migrations          数据库版本和迁移记录
projects                   项目元数据
documents                  大纲、计划、角色、场景等文档身份
document_versions          不可变文档版本和 Markdown 内容
scenes                     场次结构和顺序
shots                      镜头结构、顺序和当前状态
conversations              项目/场次/镜头会话
chat_messages              原始对话、流式状态和错误状态
memories                   用户确认的项目事实
constraints                有作用域的生产约束
assets                     媒体元数据、相对路径、Hash 和来源
generation_drafts          用户按镜头和适配器保存的参数草稿
generation_jobs            厂商任务、轮询状态和错误信息
generation_results         生成结果和资产关联
context_snapshots          LLM 或生产任务使用的上下文快照
```

`document_versions`、`context_snapshots` 和已提交任务的请求快照不可原地修改。用户修改内容时创建新版本，以保证历史任务可以解释和复现。

### 8.2 存储边界

```text
SQLite
|- 结构化关系
|- Markdown/文本内容
|- 状态与版本
|- 请求参数和上下文快照
`- 媒体相对路径与 Hash

文件系统
|- 图片、视频、音频
|- 缩略图和可删除缓存
|- 用户导出文件
`- SQLite 一致性备份

Windows Credential Manager / DPAPI
`- LLM 与模型供应商 API Key
```

数据库不得保存 API Key，大型媒体不得保存为 SQLite BLOB。

## 9. LLM 与上下文边界

LLM 每次只接收当前任务所需内容：

```text
系统角色与创作规则
+ 当前项目大纲
+ 当前项目计划
+ 相关项目记忆和生产约束
+ 当前场次/镜头文档
+ 当前镜头涉及的角色和场景
+ 最近相关对话
+ 用户本次请求
```

普通会话输出只保存在对话历史中。只有用户点击“保存为大纲”“保存为角色设定”“保存为分镜”或“添加到项目记忆”时，才创建正式文档版本。

上下文必须显示来源和版本。生成任务提交时保存不可变上下文快照，但不会自动把 LLM 内容写入适配器表单。

## 10. 生产能力和适配器

适配器选择键：

```text
capability + provider + model + apiVersion
```

第一批能力：

```text
TEXT_TO_IMAGE
REFERENCE_TO_IMAGE
IMAGE_TO_VIDEO
START_END_TO_VIDEO
REFERENCE_TO_VIDEO
```

适配器负责：

- 描述模型能力和素材要求。
- 返回参数 JSON Schema 和 UI Schema。
- 校验字段范围与字段组合。
- 将用户表单转换为厂商请求。
- 提交、查询、取消和规范化任务状态。

适配器不负责解释剧情，也不读取完整项目会话。

## 11. 本地任务执行

同步生图请求直接等待响应并保存结果。异步视频请求执行以下流程：

```text
创建 job 文件
-> 提交厂商 API
-> 保存 providerTaskId
-> 按厂商规则轮询
-> 原子更新 job 状态
-> 通过本地事件通知 React
-> 成功后保存远程结果引用或下载本地资产
```

应用关闭时不继续轮询。重新打开项目后查询 SQLite 中的未完成任务并恢复轮询。纯本地版本不设置厂商 `callback_url`。

## 12. 安全与可靠性

- API Key 不进入项目目录、日志、上下文和错误报告。
- 只允许适配器访问对应供应商凭据。
- 下载媒体时限制协议、文件类型、大小和目标目录。
- 所有项目路径经过规范化并限制在用户选择的项目根目录内。
- Worker 是 SQLite 唯一写入者，UI 只能通过 IPC 调用应用服务。
- 数据库迁移、备份和恢复必须在事务与完整性检查保护下执行。
- 日志默认脱敏请求头、Token、Base64 和签名 URL。
- 所有任务保存适配器版本、参数快照和原始供应商任务 ID。

## 13. 已知问题与默认决策

当前不存在阻止启动开发的问题，但实施时必须验证以下风险：

1. Tauri 打包 Node Worker：默认采用 sidecar，并在 M0 验证 Windows 安装包、升级和崩溃恢复。
2. SQLite 并发：MVP 只允许一个 Worker 写入项目；第二个应用实例以只读方式打开。
3. 大型资产：默认存本地项目目录；远程 URL 仅作为来源，用户可选择下载归档。
4. 厂商文档变化：适配器固定 `apiVersion` 和 `schemaVersion`，升级时保留旧任务解释能力。
5. Q3-Drama 能力差异：只开放官方文档明确支持的生产方式和参数组合。
6. 应用关闭期间无法实时通知：重新打开后恢复轮询并补发本地完成通知。

## 14. MVP 完成标准

- 一个新用户可以创建项目、生成并保存大纲、建立镜头、获得提示词、选择模型并完成一次生图和一次异步生视频。
- 应用重启后项目文档、Chat、素材和生成任务保持完整。
- 切换模型或生产方式会切换适配器表单，不丢失原会话产物。
- 错误 API Key、超时、限流、失败任务和损坏文件都有明确错误提示和恢复路径。
- 项目通过内置备份/导出功能复制到另一台机器后可以正常打开，API Key 除外。
