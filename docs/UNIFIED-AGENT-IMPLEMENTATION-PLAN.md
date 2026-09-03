# 统一 Agent 体验实施计划

版本：1.0  
日期：2026-08-31  
最近同步：2026-09-03  
状态：实施中（媒体模型选择与任务快照核心已完成；统一 Runtime、后台任务收口和发布验收待完成）  
适用范围：Desktop、Worker、Contracts、Domain、Persistence、Generation Adapters、Provider Native Bridge

## 1. 文档目的

本计划将产品目标、已确认的交互决策、技术实现边界、实施阶段和验收标准集中到一个文档中，作为后续统一 Agent 开发的单一事实来源。

统一 Agent 的目标是让用户直接输入自然语言目标，由系统自动判断能力并执行。用户不需要先选择“聊天、文档、小说、短剧、图片或视频”等功能；只有当任务确实需要模型或参数选择时，系统才在当前上下文中询问并继续执行。

## 2. 已确认的产品决策

| 主题 | 决策 |
|---|---|
| 主入口 | 普通用户只使用统一自然语言输入框，不先选择功能 |
| 能力识别 | Agent 根据用户语义判断文本、研究、文档、图片、视频等能力 |
| 模型候选 | 同时展示多个供应商的可用模型，并显示供应商、模型和能力信息 |
| 参数来源 | 参数 schema 来自官方适配器、手工配置或同步后的能力目录 |
| 未确认 schema | 新模型或未确认参数必须提示用户补充；未确认参数不能直接提交 Provider |
| Agent 会话模型 | 用户在会话中选择支持 Tool Call 的 LLM；会话期间不因生图或生视频再次替换 |
| 媒体生成模型 | 生图/生视频的 Provider 和具体模型由用户在任务需要时明确选择；Worker 只筛选、校验和冻结，不得自动替换 |
| 费用 | 图片/视频任务先提示可能产生费用，不计算不确定的具体金额 |
| 草稿 | 每次生成创建新的草稿或任务，不覆盖已有草稿；用户自行修改、删除和发布 |
| Agent 修改 schema | 用户可在会话中要求 Agent 查询、补充、修改模型参数 schema，并可二次增删改查 |
| 高风险变更 | 删除字段、改变必填性、改变互斥/依赖关系或影响已有任务的结构变更需要用户确认 |
| 权限边界 | Agent 不能修改凭据、认证方式、Provider Base URL 或其他连接安全配置 |
| 作用域 | schema 默认修改当前项目；只有用户明确要求“全局”时才修改全局目录 |
| 任务快照 | 已创建任务必须冻结模型、适配器、schema 版本和参数快照 |
| 本地优先 | 项目数据和运行时模型/schema 配置保存在本地；GitHub 只用于源代码和评审 |

## 3. 目标用户流程

```text
用户输入自然语言目标
        |
        v
统一 Agent 判断任务能力
        |
        +--> 文本/文档/研究：按会话模型偏好直接执行
        |
        +--> 图片/视频：查询兼容的媒体模型候选
        |          |
        |          +--> 用户已明确选择的媒体偏好：由 Desktop 显式带入本次请求
        |          |
        |          +--> 没有可用的明确选择：展示跨供应商模型卡片并等待用户选择
        |                         |
        |                         v
        |                 展示适配器和动态参数表单
        |                         |
        |                         +--> schema 缺失：提示用户补充或让 Agent 更新
        |                         |
        |                         v
        |                 Worker 校验参数和权限
        |                         |
        |                         v
        |                 创建新的本地任务/草稿
        |                         |
        |                         v
        |                 提交 Provider 并记录状态
        |                         |
        |                         v
        |                 图片写入素材库 / 视频进入轮询
```

## 4. 当前已完成基线

### 4.1 Contracts

- [x] 新增 `UnifiedAgentCapability`、`UnifiedAgentModelCandidate`。
- [x] 新增 `UnifiedAgentRunParams` 和 `UnifiedAgentRunResult`。
- [x] 增加 `agent.run` Worker 方法合同。
- [x] 统一请求支持模型、适配器、参数、镜头、视频区域和素材类型字段。
- [x] 参数属性支持必填、默认值、枚举、范围、费用影响、覆盖风险、互斥和依赖元数据。

### 4.2 Worker

- [x] `agent.run` 统一路由。
- [x] 按能力过滤启用且可用的跨供应商模型。
- [x] 图片/视频返回适配器和参数 schema。
- [x] Worker 对模型、适配器和参数进行二次校验。
- [x] 文本任务接入现有 Agent tool loop。
- [x] 图片任务调用 `ImageGenerationService.prepare`。
- [x] 视频任务调用 `VideoGenerationService.prepare`。
- [x] IPC 严格拒绝未知字段和非法枚举。

### 4.3 Desktop

- [x] 普通会话优先使用 `agent.run`。
- [x] 支持跨供应商模型选择卡片。
- [x] 支持动态参数表单，字段标记必填项。
- [x] 支持字符串、数字、布尔、枚举和数组参数。
- [x] 参数提交前进行前端校验，Worker 再次校验。
- [x] 图片任务通过 Native Provider 通道提交并写回素材库。
- [x] 视频任务通过 Native Provider 通道提交并绑定轮询任务。
- [x] 会话 Agent LLM 选择与图片/视频媒体模型选择分离。
- [x] 已明确选择的媒体 Provider/模型按会话和能力记忆，由 Desktop 显式带入后由 Worker 校验；Worker 不从 Agent LLM 或持久化记录自动推导媒体模型。
- [x] 失败时将图片/视频任务标记为终止，避免悬挂状态。

### 4.4 验证基线

- [x] Desktop 测试通过：174 tests。
- [x] Worker 测试通过：294 tests。
- [x] Contracts、Desktop、Worker TypeScript 检查通过。
- [x] ESLint、Prettier、`git diff --check` 通过。

## 5. 待完成阶段

### 阶段 A：模型和 schema 能力目录

目标：让 Agent 能在会话中查询、补充、修改模型和参数 schema。

任务：

- [x] 定义模型/schema 查询合同，包括来源、版本、状态、更新时间和确认状态。
- [x] 支持官方适配器、手工配置和同步目录三种来源的只读标识；手工写入能力待后续阶段实现。
- [x] 支持创建手工模型记录，不修改 Provider 凭据。
- [x] 支持更新模型能力标记，但禁止越权修改连接配置。
- [x] 支持新增、修改、停用和恢复参数 schema。
- [x] 为 schema 变更记录操作者、会话、原因、旧值、新值和时间。
- [x] 为高风险变更生成差异预览和确认请求。
- [x] 提供回滚到上一 schema 版本的接口。
- [x] 未确认 schema 在统一查询结果中明确标记，统一 Agent 生成仍拒绝缺失 schema。

阶段 A 只读子阶段已完成：新增 `model.catalog.list`、`model.catalog.get` 和 `adapter.schema.get` IPC 查询，返回模型能力、来源、schema 状态、适配器和必填字段；普通会话支持通过自然语言查询模型/schema 摘要。写入、审计和回滚仍属于阶段 A 后续子阶段。

阶段 A 写入基础设施已开始：应用数据库 schema v4 新增 `adapter_schemas` 和 `adapter_schema_audits` 表及仓储层，已覆盖 schema 状态、来源、版本、变更前后 JSON 和操作者信息；面向 Agent 的提议、确认和回滚 IPC 仍待下一步接入。

建议接口：

```text
model.catalog.list
model.catalog.get
model.catalog.createManual
model.catalog.updateCapabilities
model.catalog.disable
model.catalog.restore
adapter.schema.get
adapter.schema.propose
adapter.schema.confirm
adapter.schema.rollback
adapter.schema.audit.list
```

安全约束：

- Agent 工具不能读取或写入 API key、密钥、认证头和完整 Base URL 凭据。
- Agent 只能修改模型能力和参数 schema 白名单字段。
- 高风险 schema 修改必须先返回差异，等待用户确认。
- 默认作用域为当前项目，不能通过模型参数伪造全局作用域。

### 阶段 B：会话模型偏好持久化

目标：把当前 Desktop 内存中的模型选择升级为可恢复、可审计的会话级偏好。

任务：

- [x] 增加 conversation model preferences 数据结构。
- [x] 按 `text/image/video/document/novel/short-drama/research/asset` 能力保存 Provider profile、模型和确认时间。
- [x] 切换会话时隔离偏好，不能串用其他会话的选择。
- [x] 模型失效时不静默替换，重新展示候选模型。
- [x] 用户明确说“换模型”时清除或更新对应能力偏好。
- [ ] 为已创建任务保存使用的偏好来源和确认记录。

### 阶段 C：任务快照和生命周期

目标：保证 Provider 任务在后续 schema 更新后仍可重放、审计和恢复。

任务：

- [x] 在图片/视频任务中冻结已知的模型 ID、远程模型 ID、适配器 key。
- [x] 冻结 schema 版本和来源，并保留适配器 key 以便重建 schema。
- [x] 冻结经过脱敏/资源引用处理后的参数快照。
- [x] 记录费用提示状态，但不伪造费用金额。
- [x] 记录任务创建会话、原始 prompt 和费用提示确认状态。
- [x] Worker 重启后根据快照识别并恢复任务，不重新读取最新 schema 覆盖历史参数。
- [x] 对 Provider submit、poll、download、complete 分别记录可追踪事件。

### 阶段 D：Agent schema 管理工具接入

目标：用户可以直接在会话中命令 Agent 维护模型参数。

示例：

```text
“查看当前视频模型支持哪些参数。”
“把这个新模型添加到当前供应商，参数按官方文档填写。”
“把 duration 改成必填，并告诉我会影响哪些任务。”
“删除旧的 resolution 参数。”
“撤销刚才的 schema 修改。”
```

任务：

- [x] 将只读 `adapter.schema.get` 查询工具加入受控 Agent tool registry。
- [x] Schema 查询类操作默认自动执行；写入和高风险变更仍需后续确认流程。
- [x] Schema 提议工具 `adapter.schema.propose` 已接入受控循环；提议经过字段/连接边界校验并记录差异审计，保持待确认状态。
- [x] 会话确认卡片支持确认提议，或在存在上一已确认版本时拒绝并回滚；两种操作都会刷新任务状态和 Schema 目录。
- [x] 新增只读 `adapter.schema.audit.list` 工具；会话可按自然语言查询 Schema 版本、操作人、原因和时间线。
- [x] 低风险新增参数和 UI 提示变更可自动确认保存并记录审计；参数结构变化仍要求确认。
- [ ] 删除字段、改变必填、改变互斥/依赖关系必须请求确认。
- [ ] Agent 不能把未确认的 schema 直接用于生成。
- [ ] UI 展示变更差异、来源、版本和待确认状态。
- [ ] 支持用户二次查询、修改、删除和回滚。

### 阶段 E：统一任务状态和用户反馈

目标：让普通用户只看到任务进度和下一步，不需要理解底层 Provider 接口。

任务：

- [ ] 统一展示模型选择、参数补充、确认、提交、轮询、完成和失败状态。
- [ ] 错误信息转换为用户可理解的中文提示，同时保留技术错误码供日志查看。
- [x] 图片生成完成后直接显示素材入口。
- [x] 视频生成中显示轮询状态、预计等待说明和取消入口。
- [x] Provider 不支持某字段时，提示检查必填项、修改 schema 或更换模型。
- [ ] 普通入口隐藏旧的功能模式选择器，高级设置保留兼容入口。

## 6. 数据和权限边界

### 6.1 数据分层

```text
全局应用数据库
  - Provider profile（连接配置和凭据引用）
  - Provider model（模型目录和能力）
  - schema source/version/audit（模型参数能力目录）

项目 SQLite
  - conversation
  - conversation model preference
  - generation draft
  - image/video generation job
  - task snapshot
  - audit/event
```

### 6.2 禁止 Agent 修改的内容

- API key、token、secret、认证头。
- Provider Base URL、区域路由和认证方式，除非用户通过受保护的设置界面明确修改。
- 任意项目文件路径、任意 SQLite 表和任意未授权资源。
- 已发布正式内容、其他项目数据和全局配置（除非具有明确的受控全局操作合同）。

### 6.3 必须经过 Worker 的内容

- 所有 schema 变更。
- 所有 Provider 提交和任务创建。
- 所有模型能力判断和适配器匹配。
- 所有草稿、素材、任务状态和审计记录写入。

## 7. 失败和恢复策略

| 场景 | 行为 |
|---|---|
| 没有可用模型 | 展示空状态和供应商设置入口，不静默切换 |
| 模型失效 | 标记原选择失效，重新展示候选列表 |
| schema 缺失 | 允许查看和补充，不允许直接提交 Provider |
| 参数缺失 | 显示必填字段并保留用户原 prompt |
| 参数互斥 | 阻止提交，显示冲突字段和修改建议 |
| Provider 提交失败 | 任务标记失败，保留错误码和可重试信息 |
| Worker 重启 | 使用任务快照恢复，不读取新 schema 改写历史请求 |
| 用户切换项目 | 取消或隔离旧项目的进行中操作，禁止跨项目写入 |
| schema 高风险变更 | 展示差异，等待用户确认 |
| 草稿重复创建 | 创建新记录，不覆盖历史草稿 |

## 8. 验收标准

### 用户体验

- [ ] 用户只输入自然语言即可完成文本、文档、研究、图片和视频任务。
- [ ] 只有真正需要模型或参数时才询问，询问后可以继续原任务。
- [ ] 同一会话不会反复询问同一能力的模型。
- [ ] 用户明确要求换模型时可以重新选择。
- [ ] 图片/视频参数表单明确显示必填项、描述和费用提示。
- [ ] 草稿和任务不会覆盖已有内容。

### 安全和正确性

- [ ] Agent 无法越权修改凭据和 Provider 连接配置。
- [ ] 未确认 schema 无法提交 Provider。
- [ ] 所有 schema 变更可审计、可查看差异、可回滚。
- [ ] 所有任务冻结模型、schema 和参数快照。
- [ ] Worker 重启、项目切换和重复请求不会产生跨项目污染。

### 工程质量

- [ ] Contracts build 通过。
- [ ] Desktop typecheck 和测试通过。
- [ ] Worker typecheck 和测试通过。
- [ ] 全仓测试通过。
- [ ] ESLint、Prettier、`git diff --check` 通过。
- [ ] 新增每个 IPC 方法都有正常、拒绝未知字段和越权场景测试。

## 9. 实施顺序

按以下顺序执行，不跳过前置阶段：

1. 模型/schema 数据合同和只读查询。
2. schema 版本、来源、确认状态和审计存储。
3. 低风险 schema 修改和高风险差异确认。
4. 会话模型偏好持久化。
5. 任务快照冻结和恢复。
6. Agent schema 管理工具接入。
7. 统一状态 UI、错误处理和旧入口降级。
8. 全量测试、迁移验证和发布验收。

## 10. 当前状态与下一步

阶段 A 的查询、提议、确认、审计和回滚、阶段 B 的项目级会话模型偏好基础能力，以及阶段 C 的图片/视频任务快照和生命周期事件已经接通。当前还需要：

1. 为已创建任务补齐模型偏好来源和用户确认记录的完整 provenance；
2. 收口统一任务状态、错误提示和媒体结果入口，并将媒体提交/轮询逐步迁移到项目级后台运行时；
3. 将所有项目会话统一接入 Pi Runtime，保留开发期 Legacy 回退开关；
4. 完成真实 Provider、Windows 重启/断网、多窗口、性能和发布门禁验收。
## 11. Latest implementation status (2026-09-03)

- [x] Added `adapter.schema.propose`, `adapter.schema.confirm`, `adapter.schema.rollback`, and `adapter.schema.audit.list` contracts and IPC routes.
- [x] Added descriptor validation, required-field checks, HTTPS endpoint checks, and malformed-schema protection.
- [x] Proposals persist as `needs_confirmation`; only confirmed descriptors load into the runtime adapter registry.
- [x] Added schema audits with actor, conversation, reason, before/after JSON, and version.
- [x] Added rollback to a previously confirmed version and runtime refresh after confirmation/rollback.
- [x] Added focused AppSettingsService lifecycle coverage; Worker suite passes (283 tests).
- [x] Agent tool-loop commands for schema maintenance are available through the controlled schema proposal/confirmation routes; conversation preference persistence is now project-local and Worker-backed.
- [x] Read-only `adapter.schema.get` is available in the controlled Agent tool loop with explicit authorization, bounded arguments, audit records, and a `schema-query` task type.
- [ ] Agent tool-loop commands for conversational schema writes and full task lifecycle provenance remain subsequent phases.
- [x] Project schema v32 adds conversation-scoped model preferences with isolated get/set/clear IPC, migration coverage, and Agent fallback lookup.
- [x] Project schema v33 adds immutable `generation_jobs.task_snapshot_json`; image/video preparation stores capability, adapter, schema version/source, model identity when available, and sanitized parameters.
- [x] Media task snapshots now also retain the originating conversation ID, original prompt, and whether the cost notice was acknowledged; snapshot updates are rejected after creation.
- [x] Project schema v34 adds immutable `generation_job_events`; image/video jobs record prepare, submit, poll, download, complete, and fail lifecycle facts with bounded summaries and project-scope checks.
- [x] Project schema v35 adds the read-only `schema-query` Agent task type used by the controlled adapter Schema tool loop, with migration coverage preserving existing task records and lifecycle triggers.
- [x] Added project-scoped, bounded `generation.job.events.list` pagination; Worker restart recovery now records explicit poll/fail lifecycle facts for media jobs.
- [x] Task Log media details now load and render the persisted Provider lifecycle timeline, including restart recovery facts.
- [x] Added shared Desktop media status/error feedback: Production and Task Log use the same Chinese progress vocabulary, while Task Log retains expandable failure kinds and technical details.
- [x] Video tasks now show state-specific waiting guidance without inventing a completion time; completed tasks expose a primary `查看素材` action plus playback/file-location actions.
- [x] Invalid/unsupported Provider parameter responses now preserve their bounded technical detail but guide users to fix required fields, update the model Schema, or switch models.
- [x] Added unified chat attachment input for local images, videos, and common document files, including picker, drag/drop, paste, removable chips, previews, size limits, text extraction for plain-text files, and automatic image reference injection into media adapter parameters.
- [x] Replaced the label-based picker with a real disabled-aware button so Tauri/WebView file selection is triggered reliably; arbitrary file types are now selectable and attachment-only messages can be sent with Enter.
- [x] Distinguished media generation requests from media analysis/prompt-rewrite requests; a video attachment no longer forces the Agent into the video-generation model route.
- [x] Routed image attachments through the native OpenAI Responses/Chat Completions multimodal content format so visual analysis receives image bytes instead of only the filename.
- [x] Automatically downscaled/compressed oversized image attachments before sidecar transport, avoiding `dataUrl exceeds the maximum length` failures while retaining the original local preview.
- [x] Updated the root development startup command to rebuild the Worker before Tauri launches its debug sidecar, preventing stale capability catalogs from masking newly supported models.
- [x] Disabled provider-side parallel tool calls for Agent runs because document mutations use single-use authorizations and must be committed one at a time.
- [x] Routed direct image-generation language such as “直接生成角色三视图” to the image-model flow while keeping “生成角色三视图提示词” as a document task.
- [x] Carry the selected/latest character or scene prompt document into direct image-generation parameters, preserving project context while respecting the adapter's 5,000-character prompt limit.
- [x] Replace full video data URLs in Agent analysis requests with bounded first-frame image previews plus video metadata, avoiding the 2 MiB sidecar startup failure while providing a useful visual reference.
- [x] Match image/video reference attachments to reference-capable media adapters instead of incorrectly requiring generic vision; `qwen-image-edit-2509` is now offered for “生成三视图” with an uploaded image.
- [x] Added regression coverage for reference-image generation, text-to-image exclusion when a reference is present, and vision requirements for image-understanding tasks; Worker suite passes (283 tests).
- [x] When a video is used as a reference for image generation, the extracted bounded first-frame preview is automatically injected into the adapter `images` field; Desktop suite passes (167 tests).
- [x] Reference images are prefilled in the parameter form before validation, so required `images` fields no longer block submission when the source is an uploaded image or video.
- [x] Media parameter submissions no longer resend the same large local data URL as both Agent attachment and adapter parameter, preventing duplicate payloads from exceeding the 2 MiB sidecar limit.
- [x] De-duplicated prefilled and automatically injected reference images so clicking “提交生成” sends each local image only once.
- [x] Hardened UniCompAPI Qwen image-edit Data URL handling by trimming surrounding whitespace and accepting case variations in the Data URL header before provider submission.
- [x] Canonicalized image Data URLs in the Desktop submission path, removing embedded whitespace and rejecting malformed image sources before they reach the native Provider bridge.
- [x] Preserved runtime image parameters separately from redacted SQLite job snapshots; local reference Data URLs are now available for the immediate Provider submission without persisting image bytes in project data.
- [x] Desktop restores the project session automatically when the Worker sidecar restarts, preventing stale UI state from producing `No project is open.` during Agent/media submissions.
- [x] Media model selection boundary verified: `agent.run` returns `needs_model_selection` when an image/video request has no explicit Provider/model, and direct image/video preparation rejects missing or partial selections; Worker never falls back to Agent or persisted media defaults (Worker 294 tests, Desktop 174 tests, Worker typecheck).
