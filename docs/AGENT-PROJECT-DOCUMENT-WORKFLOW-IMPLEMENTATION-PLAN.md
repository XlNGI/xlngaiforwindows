# Agent 项目文档生成、审核与任务日志实施计划

版本：1.2  
日期：2026-08-19  
状态：实施中（v14 核心闭环和 UniCompAPI 桌面 Native 两轮工具验收已完成；P3.2 Worker 主动研究、Schema v18 配额治理、Schema v19 缓存索引/引用关联、来源 UI、用户可见研究模式、Fake-IP DNS 兼容、“UniCompAPI + 真实研究 + 自动打开草稿”桌面链路和 Native 研究网络桥基础实现已完成；Worker 到 Native 的请求 ID/取消注册表/WinHTTP 分段取消已完成；崩溃后 in-flight 恢复、真实研究冒烟和安装包链路待完成）  
适用范围：Desktop、Worker、Contracts、Domain、Persistence、Context、LLM Provider

> 本文档是 Agent 项目资料生成工作流的实施依据和执行记录。已完成项必须附验证证据；未完成项保留明确边界，不得以 UI 已接入代替后端能力。

## 1. 执行状态

- [x] P0 业务合同、术语和状态机评审
- [~] P1 Agent 任务、事件和工具调用持久化（v12-v14 基线已完成；`document.create_draft` 的真实 Provider step、授权、工具调用和 continuation 已闭合，其他文档工具待扩展）
- [x] P2 文档工作版本与权威版本模型
- [~] P3 Agent 工具协议和安全执行网关（`document.create_draft/list/read/update_draft/archive/restore` 均已具备工具定义下发、step-local 不透明授权、受限执行与结果回传；archive/restore 通过一次性确认记录和 Desktop 本地确认续执行。恢复、取消与延迟工具回调已覆盖，P3.1 本地路由门禁、UniCompAPI 协议适配和桌面 Native 草稿两轮工具验收已落地，仍待更广泛的故障注入、取消/重启恢复实机演练和其他第三方路由兼容性验证）
  - [~] P3.1 Provider 工具路由兼容性（官方 OpenAI Responses 与 UniCompAPI Chat Completions 精确路由的模型能力/transport 双重门禁、工具循环适配、真实协议冒烟和桌面 Native Agent 草稿链路已完成；取消/重启恢复、安装包链路及其他第三方适配器仍待完成）
- [~] P3.2 Agent 主动外部研究（`researchMode`、Bing HTML Research Adapter、受控 `research.search/fetch`、并行只读工具循环、项目本地正文缓存、Schema v17 来源事实、Schema v18 工具配额、Schema v19 缓存索引/TTL/容量治理/采用状态/草稿引用关联、来源 UI、用户可见模式选择、UniCompAPI 桌面真实研究起草链路和 Native 研究网络桥基础实现已落地；Worker 无桥时 fail-closed，并有 Native 令牌/公网 URL/响应上限回归；Worker 到 Native 的请求 ID/取消注册表/WinHTTP 分段取消已落地；崩溃后 in-flight 恢复、真实研究冒烟和安装包链路待完成）
- [~] P4 会话触发文档草稿与编辑器审核闭环（显式 Agent 创建、终态刷新和新草稿自动打开已完成；普通聊天已支持保守的创建/读取/更新/归档/恢复意图识别、唯一目标绑定和无目标阻断；更完整的持久化 pending intent、其他文档入口和端到端 Provider 验收待完成）
- [~] P5 审核、发布、上下文治理和冲突处理（核心闭环和文档工作流审计完成，差异视图和动态模型预算待实现）
- [x] P6 统一任务日志页面与来源定位（聚合列表、Agent 详情、事件时间线、文档产物、Provider step 详情、筛选、游标分页、自动刷新、来源会话跳转和图片/视频完整详情已完成；2026-08-19 验证：Contracts build、Worker/Desktop typecheck、Worker 194 tests、Desktop 108 tests 通过）
- [~] P7 场次/镜头结构化提案扩展（Worker change set/CAS/事务应用、结构化差异 UI 和关联文档原子变更已完成；真实 Windows 人工验收和安装包链路待完成）
- [~] P8 性能、安全、迁移和发布门禁（自动化质量门禁通过，Windows 多窗口实机和恢复演练待完成）

## 2. 计划目的

将当前“LLM 输出文本，用户手动点击保存为文档”的流程升级为企业级 Agent 工作流：

```text
用户请求
  -> 创建 Agent 任务
  -> 冻结项目权威上下文
  -> 判断是否需要外部研究
  -> 必要时执行受控搜索、网页读取和来源快照
  -> LLM 通过受限工具生成文档草稿
  -> Worker 校验并持久化草稿
  -> 编辑器自动打开草稿
  -> 用户审阅、修改和提交审核
  -> 用户显式发布为权威版本
  -> 后续 LLM 只读取已发布版本
```

目标是同时满足：

- LLM 可以主动生成相关项目资料；
- 当项目资料不足或请求依赖外部事实时，LLM 可以主动检索、读取并引用外部来源；
- LLM 不能绕过用户直接修改权威资料；
- 生成结果可以在独立编辑器窗口中继续修改；
- 每次生成、工具调用、审核和发布都有可追溯记录；
- Worker 重启、项目切换、重复请求、并发编辑和失败重试不会污染项目数据；
- 任务日志能够统一展示 Agent 任务、图片任务和视频任务；
- 继续遵守本地优先和项目 SQLite 数据边界。

## 3. 已确认的产品决策

以下决策由本轮讨论确认，实施过程中不得临时改变：

| 决策 | 结论 |
|---|---|
| 文档保存介质 | 文档、草稿、版本、审核记录和任务数据保存在项目根目录的 `project.sqlite`；不以独立 `.md` 文件作为运行时权威源 |
| 文档生命周期 | 所有新建、导入、手工编辑和 Agent 生成的文档都采用“保存草稿 -> 显式发布”；只有发布版本进入默认 LLM 权威上下文 |
| 首期产物基数 | 创建/更新类 Agent 任务只允许一个主要文档产物；查询、归档和恢复任务使用操作结果，不伪造文档产物；多文档请求拆分为多个有父子/批次关联的任务 |
| Agent 权限 | Agent 可在显式用户意图、唯一目标和可信执行信封约束下执行有界 `list/read/create/update/archive/restore`；永远不能提交审核、发布或 purge |
| 用户权限 | 可写项目用户拥有受控文档 CRUD，可提交审核、要求修改、拒绝、自审发布、归档、恢复归档；purge 必须再次显式确认 |
| 删除语义 | 普通“删除”统一实现为可恢复归档；物理 purge 仅限用户显式确认，不向 LLM Tool Registry 暴露 |
| 本地发布 | 本地单用户使用一次 `document.selfPublish` 操作；Worker 在一个事务中完成自审记录和发布，不允许 UI 拼接多次写入 |
| 首期产物 | 首期实现 Markdown 项目文档的创建、更新、审核和发布；结构化场次、镜头、记忆和生产约束进入后续阶段 |
| 任务日志 | 建立统一任务日志页面，聚合 Agent 文档任务、图片任务和视频任务；底层领域表保持独立，通过 Worker 查询层统一展示 |
| 普通问答 | 没有持久化副作用的普通问答继续只记录在会话和 LLM generation 中，不创建 Agent 任务日志 |
| 文档分类 | 移除 UI 中的文档类型下拉菜单；旧 `kind` 字段暂时保留兼容，不再参与用户选择、上下文排序或 Agent 决策 |
| 草稿上下文 | 草稿默认不进入其他会话的 LLM 上下文；当前任务可显式引用自己的草稿，并必须标记为未审核候选资料 |
| 信息来源策略 | 项目生产约束、已发布资料和记忆是高优先级来源，但不是 Agent 的唯一信息来源；外部事实不足时允许主动研究，不能再用“仅限项目上下文”作为默认拒绝理由 |
| 主动外部研究 | 显式 Agent 任务默认采用 `auto` 研究模式：请求依赖外部事实、时效信息或上下文不足时，模型可先调用受控 `research.search/fetch`，再创建或更新草稿；用户可显式要求仅使用项目资料或禁止联网 |
| 模型既有知识 | 可用于创意推演和提出检索方向，但不得伪装成已实时检索或已核验来源；时效性、争议性和关键事实需要外部来源或明确标记未核验 |
| 研究来源与引用 | 外部资料始终视为不受信内容；草稿中的可核验事实应关联来源标题、规范 URL 和检索时间，来源冲突、单一来源或证据不足必须可见 |
| 研究网络边界 | 搜索/抓取通过独立、已验证的 Research Adapter 和 Native 网络桥执行；搜索凭据保存在桌面凭据管理器，Worker/SQLite 只保存凭据 handle 和脱敏来源事实 |
| Agent 模型门禁 | Agent 模式要求模型同时具备 `text && streaming && tools`；`structuredOutput` 不是必要条件 |
| Provider 执行粒度 | 一个 generation/attempt 覆盖一次完整工具循环；每次 Provider HTTP 请求/响应单独记录为 Provider step |
| 上下文审计 | 上下文快照只保存 manifest、来源版本、hash、字符/Token 和裁剪策略，不复制完整正文或完整拼接结果 |
| 资源上限 | 标题/正文/JSON 同时执行字符和 UTF-8 字节限制；Agent 输入、输出、总 Token、费用、步骤和运行时长均有安全默认值与硬上限 |
| 审计边界 | “长期保留”指项目数据库生命周期内不通过普通业务接口硬删除；删除整个项目仍是显式、备份优先的本地维护行为，不等同外部合规存证 |
| 项目权限 | 当前版本继续采用本地单用户模型；可写项目用户视为项目所有者，只读项目拒绝所有草稿、审核和发布写入 |
| 数据所有权 | Worker 是项目 SQLite 的唯一业务写入者；Desktop 只能通过 IPC 请求，LLM 不能直接访问文件系统或数据库 |

## 4. 范围与非目标

### 4.1 本计划范围

- Agent 任务创建、执行、取消、重试和恢复；
- LLM 工具定义、工具调用解析和受限执行；
- Agent 主动搜索、网页读取、来源快照、引用和研究过程展示；
- Markdown 文档草稿、版本、审核、发布和冲突处理；
- 文档生成结果与会话、generation、上下文快照的关联；
- 会话任务卡和统一任务日志页面；
- 文档在应用内工作区和 Tauri 独立窗口中的单一编辑状态；
- 后续结构化场次/镜头提案的扩展边界；
- 迁移、审计、脱敏、并发、恢复和质量门禁。

### 4.2 明确不在首期实现

- LLM 自动发布、覆盖或删除正式资料；
- LLM 直接写入任意项目路径、任意 Markdown 文件或任意 SQLite 表；
- 首期自动创建正式场次、镜头、记忆或生产约束；
- 多用户、团队协作、远程同步、租户权限和服务端审计平台；
- 使用 GitHub 作为项目运行时数据同步或资料存储；
- 通过解析普通回答中的特殊 Markdown/JSON 约定来模拟工具调用；
- 将完整上下文、凭据、签名 URL 或完整 Provider 原始响应写入任务日志。
- 向模型提供任意浏览器控制、任意 URL 请求、任意内网访问或通用命令执行能力；
- 把模型参数知识描述成实时搜索结果，或在没有来源证据时伪造引用。

## 5. 当前代码与数据基线

| 领域 | 当前实现 | 本计划影响 |
|---|---|---|
| 会话 | `apps/desktop/src/App.tsx`、`ChatPanel.tsx` 管理项目/场次/镜头会话 | 会话请求可创建 Agent 任务，但普通问答路径保持兼容 |
| LLM generation | `apps/worker/src/generation-service.ts`、`llm_generations`、`llm_generation_attempts` 已支持幂等、CAS、重启恢复 | 保留 generation/attempt 作为完整逻辑执行单元，v14 增加 Provider step 表表达一次工具循环内的多次请求 |
| 上下文 | `ContextService` 已读取文档 `published_version_id`、记忆、约束和相关会话；v13 仍会把完整编译结果写入快照 | v14 改为 manifest-only，补充显式草稿引用、动态模型预算和 legacy 正文清理 |
| 文档 | Schema v13 已有 `current_version_id` 工作指针、`published_version_id` 权威指针、不可变版本和文档工作流审计 | 继续补齐差异、放弃和多候选分支能力 |
| 文档提升 | `chat.message.toDocument` 直接创建正式文档 | 改为创建 Agent 草稿或进入显式草稿流程；旧 IPC 保留兼容窗口 |
| 场次/镜头 | `scenes`、`shots` 可由界面直接保存，没有 Agent 提案和 CAS | 首期不由 Agent 直接写入；后续通过 change set 原子应用 |
| 任务 | `generation_jobs` 主要服务图片/视频，`generation_drafts` 服务镜头参数 | 不复用为 Agent 文档任务；统一任务日志通过投影查询聚合 |
| Provider | 模型目录已声明 `text`、`streaming`、`tools`、`structuredOutput`，但真实 Provider tool loop 和逐 step 事实记录尚未完成 | Agent 门禁使用 `text && streaming && tools`；新增工具循环、Provider step、usage 汇总和恢复 |
| 外部研究 | Worker 已接入 `bing-html-public-v1`、`research.search/fetch`、来源事实、缓存和 Native 研究桥客户端；UniCompAPI 只承担 LLM function calling，不提供托管网页搜索 | 正式桌面 Worker 通过一次性 loopback Native 桥执行公开 HTTPS 研究；无桥时 fail-closed；仍需补齐请求取消贯穿、崩溃后 in-flight 恢复、真实研究和安装包验收 |
| 工作区 | 文档/会话可停靠、浮动并分离为 Tauri 窗口 | Worker 保持唯一持久化写入者；独立文档窗口由主窗口按文档实体维护临时编辑缓冲，并通过版本 CAS 写入 |
| 持久化 | 项目根目录包含 `project.sqlite`、`assets/`、`exports/`、`backups/` | 文档/任务仍进 SQLite；媒体实体文件仍保存在 `assets/` |

关键基线文件：

- [apps/worker/src/content-service.ts](../apps/worker/src/content-service.ts)
- [apps/worker/src/context-service.ts](../apps/worker/src/context-service.ts)
- [apps/worker/src/generation-service.ts](../apps/worker/src/generation-service.ts)
- [apps/worker/src/handler.ts](../apps/worker/src/handler.ts)
- [packages/persistence/src/schema.ts](../packages/persistence/src/schema.ts)
- [packages/persistence/src/repositories.ts](../packages/persistence/src/repositories.ts)
- [packages/contracts/src/index.ts](../packages/contracts/src/index.ts)
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)
- [apps/desktop/src/ChatPanel.tsx](../apps/desktop/src/ChatPanel.tsx)
- [apps/desktop/src/workspace/WorkspaceSurface.tsx](../apps/desktop/src/workspace/WorkspaceSurface.tsx)

## 6. 术语与权威数据模型

| 术语 | 定义 | 是否默认进入 LLM 上下文 |
|---|---|---:|
| 权威资料 | 用户已发布、版本化、可作为项目事实依据的文档版本 | 是 |
| 工作版本 | 当前编辑器正在编辑的版本，可能尚未审核 | 否 |
| 草稿 | Agent 或用户创建、尚未发布的工作版本 | 否 |
| 项目记忆 | 用户确认保存的背景信息或偏好，可信度低于权威资料 | 是 |
| 生产约束 | 用户确认的必须遵守的规则，优先级最高 | 是 |
| 会话记录 | 当前项目/场次/镜头会话的临时交流内容 | 按作用域和预算选择 |
| Agent 任务 | 一次有明确目标、可能产生持久化产物的业务执行 | 否，任务日志不是资料 |
| generation/attempt | 一次从首个 Provider 请求到最终回答结束的完整工具循环；重试保留独立 attempt 证据 | 否，作为上下文/费用/状态证据 |
| Provider step | generation/attempt 内的一次 Provider HTTP 请求与响应，例如初始请求或工具结果回传后的续写 | 否，作为协议、用量和恢复证据 |
| 工具调用 | LLM 请求某个受限业务操作的结构化调用 | 否，作为任务事件和审计证据 |

权威关系必须由数据字段表达，不能依赖文件名、目录名或自然语言约定：

```text
documents.published_version_id
        ↓
document_versions.state = published
        ↓
ContextService 默认读取该版本
```

`documents.current_version_id` 重新定义为“当前工作版本指针”，不再代表权威版本。只有 `published_version_id` 可以作为默认项目事实进入 LLM 上下文。

## 7. 业务角色与权限边界

### 7.1 CRUD 与工作流权限矩阵

| 操作 | 可写项目用户 | Agent/LLM | Worker 执行要求 |
|---|---:|---:|---|
| 列表、查看文档和版本 | 是 | 是，仅限显式查询意图和有界 `document.list/read` | 校验项目和作用域；列表返回任务内短期句柄，读取默认只允许已发布版本，目标任务草稿必须显式授权 |
| 创建文档草稿 | 是 | 是，仅限当前任务的 `document.create_draft` | Worker 生成可信执行信封，执行输入上限、项目写权限和幂等校验 |
| 更新文档草稿 | 是 | 是，仅限当前任务绑定的 `document.update_draft` | 必须校验目标文档、基础版本、`row_version` CAS 和任务产物基数 |
| 保存编辑器草稿 | 是 | 否 | 创建不可变版本，禁止原地更新正文 |
| 提交审核 | 是 | 否 | 创建 pending 审核记录并转换版本状态 |
| 要求修改或拒绝 | 是 | 否 | 校验 pending 审核和审核版本 CAS，追加审计 |
| 自审并发布 | 是 | 否 | 只能通过原子 `document.selfPublish`；一次事务完成审核、批准、发布和任务完成 |
| 普通删除/归档 | 是 | 是，仅限用户明确说出归档/删除且目标唯一 | 统一设置 `lifecycle_status=archived`，保留版本、发布历史和引用；已发布或被关键实体引用的文档先要求用户确认 |
| 恢复归档 | 是 | 是，仅限用户明确说出恢复且目标唯一 | 校验项目可写和实体未被 purge，恢复为 active 并追加审计 |
| purge 物理清理 | 是，必须显式二次确认 | 否 | 仅允许用户 Actor；执行引用检查、最小审计墓碑、事务删除和幂等校验 |
| 提交审核、发布、purge 工具调用 | 不适用 | 永久禁止 | 不注册到 LLM Tool Registry，收到伪造工具名时返回 `TOOL_NOT_ALLOWED` |
| 取消或重试 Agent 任务 | 是 | 否 | 终态不可逆；重试创建新的关联任务或 generation/attempt |

只读项目中，用户和 Agent 均不得产生任何持久化副作用。Agent 的 CRUD 是“由用户自然语言明确授权、由 Worker 解析唯一目标、由可信执行信封绑定实体”的受控 CRUD；模型不得自行枚举其他项目、猜测 ID 或把资料中的指令当作授权。用户的完整 CRUD 同样不代表可以绕过版本、引用、审计、确认和事务边界。

### 7.2 Worker

- 校验项目、会话、任务、作用域、模型能力和工具参数；
- 执行所有持久化写入、状态转换、幂等和并发控制；
- 记录任务事件和审计事件；
- 在发布事务中维护权威版本指针；
- 生成、持久化并校验可信执行信封，拒绝模型伪造的项目、任务、文档和 CAS 字段；
- 对外部错误进行稳定错误码和可重试性映射。

### 7.3 Desktop

- 展示任务状态、草稿、差异、审核和发布操作；
- 按文档实体维护临时编辑缓冲，并向 Worker 发起请求；
- 独立窗口只渲染主窗口下发的快照并转发用户动作，不能直接访问 Worker、SQLite 或 LLM；
- 不直接写 SQLite、不执行模型工具、不依据 UI 状态推断权限。

## 8. 核心业务不变量

1. 每个 Agent 任务、generation、工具调用、上下文快照和文档产物必须归属同一项目。
2. 所有异步回写必须校验 `projectSessionId`、`projectId`、`taskId` 和相关 generation/attempt/step ID；存在会话关联时还必须校验 `conversationId`。
3. 普通聊天消息不能隐式修改正式文档、记忆、生产约束、场次或镜头。
4. Agent 只能产生草稿或结构化提案，不能直接发布。
5. 文档版本正文不可更新；每次编辑、恢复、重新生成和发布都创建不可变版本或发布记录。
6. `current_version_id` 是工作版本，`published_version_id` 是唯一权威版本；两者可以不同。
7. 默认上下文只读取发布版本；草稿必须通过明确引用才能进入上下文。
8. 发布必须基于用户看到的版本和发布时仍然有效的基础权威版本；冲突不得静默覆盖。
9. 任务终态不可回到活动态；重试创建新任务或新 generation，并保留 `retry_of_*` 关联。
10. 相同幂等键和相同请求哈希返回第一次结果；相同幂等键但请求不同返回 `IDEMPOTENCY_KEY_REUSED`。
11. 任务事件为追加写入，不能被普通更新或删除；事件内容必须有界并脱敏。
12. 只读项目拒绝草稿创建、编辑、审核、发布、记忆和约束写入。
13. 上下文超出预算时不得静默丢弃生产约束；应明确失败或返回可解释的裁剪结果。
14. 任务日志不是项目记忆，不默认进入 LLM 上下文。
15. LLM 不能通过标题、Markdown 标签或文件名改变资料权威等级。
16. 首期一个创建/更新类 Agent 任务最多产生一个主要文档；查询、归档和恢复任务不得伪造产物，多文档需求必须拆为多个关联任务。
17. 公开 Tool Schema 只接受模型能够提供的内容或有界查询参数；可信 ID、作用域、目标文档、基础版本、CAS 和幂等数据只能来自 Worker 生成的可信执行信封。
18. Agent 仅在显式用户意图和唯一可信目标下拥有 `list/read/create/update/archive/restore` 权限；永远没有提交审核、发布或 purge 权限。
19. 普通删除必须可恢复；purge 必须由用户显式确认、通过引用检查并保留不含正文的最小审计墓碑。
20. 上下文快照只保存可复核 manifest；完整正文、完整拼接上下文和完整工具定义不得作为新的快照内容写入。
21. 工具调用必须先校验可信执行信封、任务/step 归属和工具白名单，再严格解析、规范化并计算参数 hash，最后才允许按任务作用域去重。
22. 取消与工具写入以同一数据库事务中的任务 `row_version` CAS 为线性化点；取消先提交则工具零写入，工具先提交则保留已提交事实和草稿。
23. 正文只执行 UTF-8、控制字符和长度校验；不得使用会改写创作内容的 NFKC 等兼容性规范化。标题和标识符最多执行一次 NFC 规范化，并在规范化后计算 hash。
24. 任务、generation、attempt、Provider step、工具调用和任务事件在项目数据库生命周期内只允许逻辑归档，不允许普通业务接口硬删除审计证据。

## 9. 端到端业务流程

### 9.1 用户发起任务

用户在项目、场次或镜头会话中明确提出“创建/更新项目文档”等请求。系统先保存用户消息，再使用幂等键创建 Agent 任务。

任务创建时记录：

- 项目、项目运行会话和会话作用域；
- 原始用户消息 ID；
- 任务类型和目标作用域；
- 请求正文的有界快照与哈希；
- Provider、模型选择和能力快照；
- 创建时间和幂等键。

创建 Agent 任务前必须验证所选模型具备 `text && streaming && tools`。`structuredOutput` 可以作为 Provider 优化能力，但不得成为 Agent 模式的硬门禁。普通问题、改写、解释和头脑风暴不自动创建任务；用户明确要求查找、读取、生成、修改、归档或恢复项目资料时，才进入对应的有界 Agent 操作。

### 9.2 冻结上下文

Worker 首先从当前项目读取已发布权威资料、生产约束、项目记忆和相关会话，并根据项目/场次/镜头作用域和预算编译基础上下文。基础上下文是任务的优先证据，不再是唯一允许的信息来源。P3.2 启用后，Agent 可在同一 attempt 内通过受控研究工具追加外部来源；这些来源进入独立、追加式 research manifest，不能回写或冒充任务开始前冻结的项目上下文。

上下文 manifest 必须在 Agent generation 开始前落盘，至少包括：

- 来源 ID、类型、作用域；
- 文档版本 ID、发布版本 ID、内容 hash；
- 原始字符数、实际纳入字符数、估算 Token；
- 摘要、裁剪、排除原因和优先级策略；
- 上下文编译器版本、策略版本和预算参数；
- 任务 ID、generation ID、attempt ID 和创建时间。

manifest 不保存完整来源正文、完整 `systemInstruction`、完整上下文拼接结果或完整工具定义。Provider 请求正文由运行时按 manifest 和不可变来源版本重新构造；无法重新构造时必须明确标记为不可恢复，而不是把正文复制进审计表。

当前任务若需要参考自己的草稿，必须通过显式 `includeDraftIds` 引用，并在上下文中标记“未审核候选资料”，不能伪装为权威资料。

外部研究来源必须记录来源 ID、规范 URL/URL hash、标题、站点、检索/抓取时间、内容 hash、字符/Token 数、采用或排除原因、关联 search/fetch call 和引用标签。规范 URL 不保留凭据、签名参数或非必要跟踪参数；完整网页正文不进入任务事件、Provider step 或通用工具调用摘要。

### 9.3 LLM 生成和工具调用

Agent 先判断用户请求是否需要持久化副作用：

- 不需要：继续普通 LLM generation；
- 需要项目内资料：默认由 Worker 在模型调用前解析目标并编译上下文；只有用户明确要求浏览/搜索项目文档时才开放有界 `document.list/read`；
- 需要外部资料：当用户明确要求检索、请求依赖时效/事实核验，或模型判断基础上下文明显不足时，在 `auto` 研究模式下开放有界 `research.search/fetch`；用户选择“仅项目资料/禁止联网”时不得调用；
- 需要创建文档：调用 `document.create_draft`；
- 需要更新文档：调用 `document.update_draft`；目标文档和基础版本来自 Worker 可信执行信封，不由模型提供；
- 需要归档或恢复：只有原始用户消息明确表达该动作且 Worker 已解析唯一目标时，才开放 `document.archive/restore`；已发布或被关键实体引用的文档先返回确认要求；
- 需要多个文档：编排层拆分为多个带共同 `batchId`/父任务关联的 Agent 任务，每个任务只生成一个主要文档。

一次 generation/attempt 是完整工具循环：初始 Provider 请求、零到多轮只读研究工具、一次受控文档副作用、工具结果回传以及最终自然语言回答都属于同一 attempt；每次 Provider HTTP 请求/响应单独写入递增 ordinal 的 Provider step。研究调用和文档写调用不得在模型尚未看到研究结果的同一 step 混合执行；step usage 按请求保存，attempt usage 保存所有 step 的校验后汇总。

工具网关在 Worker 中执行，不允许模型直接调用数据库或文件系统。Worker 在发送工具定义前先持久化 step-local 的可信预授权，Native Runtime 仅持有不透明授权 handle；收到 Provider function call 后才派生含 call ID/ordinal 的可信调用信封。模型参数不能覆盖其中任何字段。创建/更新工具成功且唯一主要产物已建立后，任务进入 `waiting_review`；只读查询任务直接完成，归档/恢复任务在事务提交后进入对应完成 outcome。

创建/更新任务的完成逻辑必须以任务自己的唯一主要产物为准。首期禁止同一创建/更新任务绑定多个主要文档，避免当前类似 `completeSourceTask()` 的逻辑在任一产物发布后直接完成整个多产物任务；查询、归档和恢复任务按操作结果完成，不要求主要产物。历史异常数据若存在多个产物，必须进入维护报告，不能自动猜测任务结果。

### 9.4 编辑器审核

Desktop 收到草稿产物后自动打开文档编辑器：

- 显示草稿状态、生成来源和基础权威版本；
- 支持正文、标题和作用域编辑；
- 支持查看与基础版本的差异；
- 保存时携带 `baseVersionId` 和 `expectedDocumentRowVersion`；
- 同一文档只存在一个主窗口管理的编辑缓冲；不同文档的独立窗口按实体隔离，不能相互覆盖；
- 关闭窗口不删除草稿，不取消 Agent 任务，不丢失未保存状态。

### 9.5 本地单用户自审发布

审核中的版本在主编辑器和独立窗口中只读，仅允许“要求修改”“拒绝并结束”或“发布”；用户修改必须先要求修改。

用户点击“发布”调用 `document.selfPublish`。Worker 必须在一个数据库事务中完成：

1. 校验项目仍可写；
2. 校验调用 Actor 是用户，且草稿、文档和项目一致；若草稿由 Agent 生成，再校验可空的 `source_task_id` 所指任务、generation、主要产物和项目一致；手工草稿允许没有任务关联；
3. 校验 `expectedDocumentRowVersion`、草稿 `state_version` 和基础权威版本 CAS；
4. 创建 status=`pending` 的自审 `document_reviews` 记录；
5. 立即由同一用户将该审核记录更新为 `approved`，追加 `self_reviewed` 审计；
6. 创建不可变 `document_publications` 记录；
7. 更新 `documents.published_version_id`、工作指针和必要的行版本；
8. 将候选版本转换为 `published`，写入 `self_published`/`published` 审计和（存在来源任务时）任务事件；
9. 仅当存在来源任务时校验该任务只有一个主要产物且其当前 `document_version_id` 等于候选版本，并在同一 CAS 事务将 artifact `disposition=published`，再将任务标记为 `completed + outcome=published`；手工草稿不创建伪任务、不更新任务状态，但仍必须写审核、publication 和审计事实。

任何一步失败必须全部回滚，不能留下已批准但未发布、已发布但任务未完成或权威指针已变化但审计缺失的中间状态。发布后下一次 LLM 上下文编译才会读取该版本；失败时草稿保留并进入冲突处理界面。

### 9.6 拒绝、修改和重试

- 用户选择“要求修改”：审核记录和版本进入 `changes_requested`，任务保持 `waiting_review`，用户编辑后创建新草稿版本并重新提交；
- 用户选择“拒绝并结束”：保留草稿、任务事件和审核记录，版本进入 `rejected`，任务进入 `completed + outcome=rejected`；
- 用户选择“放弃”：草稿标记为 `discarded`，任务进入 `completed + outcome=discarded`；
- Provider 失败：任务进入 `failed`，保留 generation 失败原因和已接收文本；
- Provider 失败但已成功保存可编辑草稿：草稿保留，任务进入 `waiting_review` 并追加警告事件。

### 9.7 归档、恢复和 purge

- 用户可从 UI 直接调用归档/恢复；Agent 只能在原始用户消息明确授权、目标唯一且可信执行信封绑定目标时调用 `document.archive/restore`；
- `document.archive` 设置文档生命周期为 archived、记录 Actor 和时间、追加 `archived` 审计；文档和全部版本仍可查询与恢复，但默认列表和 LLM 上下文排除；
- `document.restore` 校验项目可写、文档仍存在且当前为 archived，恢复 active 并追加 `archive_restored` 审计；
- 已发布或被小说章节、短剧实体、change set 等关键实体引用的文档归档前必须返回 `DOCUMENT_ARCHIVE_CONFIRMATION_REQUIRED`，由用户确认后重新执行，模型不能代替确认；
- 用户调用 `document.purge`：必须携带 UI 生成且仅一次有效的显式确认凭据，并再次校验用户 Actor、项目可写、文档 archived、没有受保护发布/任务/导出引用；
- 已发布文档默认禁止 purge。只有未来明确维护策略允许且所有引用均可安全处理时才能放开；
- purge 事务先写不含正文的最小审计墓碑，再删除允许删除的版本和文档，追加/固化 `purged` 证据；失败全部回滚；
- purge、提交审核和发布永远不注册为 LLM 工具；未获得显式意图授权的 archive/restore 请求按越权事件拒绝。

## 10. 状态机

### 10.1 Agent 任务

```text
queued -> running -> waiting_review -> completed
   |         |             |
   |         |             +-> completed  (发布、拒绝或放弃)
   |         +-----------> completed  (查询、归档或恢复成功)
   |         +-> failed
   |         +-> cancelled
   +-> cancelled
```

约束：

- `queued`、`running`、`waiting_review` 为活动状态；
- `completed`、`failed`、`cancelled` 为终态；
- 终态不可恢复为活动态；重试创建新任务；
- 审核拒绝不是系统失败，使用 `completed + outcome=rejected`；
- 要求修改继续保持 `waiting_review` 并创建新草稿版本；重新生成创建新任务，不允许任务回到 `running`；
- 创建/更新任务完成生成但没有预期文档产物时使用 `EXPECTED_ARTIFACT_MISSING` 进入 `failed`；查询、归档和恢复任务不适用该错误；
- 取消和工具事务都以 `agent_tasks.row_version` 条件更新为线性化点，只有一个操作能够从同一活动版本成功提交。

任务主 `status` 仍保持粗粒度；需要用户确认时保持活动任务状态并将 `phase` 设为 `waiting_confirmation`，对应确认记录决定继续、拒绝或过期，不把等待确认误记为完成或普通审核等待。

### 10.2 文档版本

```text
draft -> in_review -> published
                   -> changes_requested -> draft (新修订)
                   -> rejected (终态)

draft/changes_requested -> superseded
draft/changes_requested -> discarded
```

历史发布版本保持不可变。当前是否为权威版本由 `documents.published_version_id` 决定，不由单个版本的自然语言标题决定。

### 10.3 工具调用

```text
received -> validated -> executing -> succeeded
                     |   |          -> failed
                     |   +---------> cancelled
                     +-> awaiting_confirmation -> executing -> succeeded | failed | cancelled
```

解析失败、参数不合法、任务状态不允许或幂等键冲突都必须在工具执行前拒绝。`awaiting_confirmation` 不执行副作用、不消耗执行配额；确认事务只对已存在的 Provider call 签发 replacement authorization 并恢复同一 call 的状态，原始 call ID 既不会绕过 scoped 去重，也不会被替换成 Desktop 伪造的 ID。

### 10.4 Provider step

```text
prepared -> in_flight -> complete
                    -> failed
                    -> interrupted
```

同一 attempt 的 step ordinal 从 0 递增且唯一。只有前一步完整持久化并确认需要续写后才能创建下一步；Worker/Native Runtime 中断后，以最后一个持久化 step、工具调用状态和 Provider continuation ID 决定继续或终止，不能重复执行已成功工具。

### 10.5 文档生命周期

```text
active -> archived -> active
   |
   +-> purged（仅用户显式确认且通过保护性引用检查）
```

归档不改变历史版本状态和发布历史。purge 是受控物理清理，不是可由 Agent 触发的普通状态转换；默认禁止清理已有发布记录的文档。

## 11. 目标架构与职责

```text
ConversationPanel / TaskCard / DocumentEditor
              │ IPC contracts
              ▼
AgentTaskService ── DocumentDraftService ── ReviewService
       │                    │                    │
       ├─ ToolGateway       ├─ ContextService     ├─ Audit/Event log
       └─ GenerationService└─ Persistence         └─ Publish transaction
              │                    │
              └──────── project.sqlite ────────┘
```

### 11.1 AgentTaskService

负责任务创建、幂等、状态转换、重试、取消、任务与 generation 关联以及任务产物查询。不负责生成 Markdown 的具体内容。

### 11.2 ToolGateway

负责工具白名单、JSON Schema 校验、任务范围校验、权限校验、调用幂等、执行超时和结果脱敏。不得提供任意文件路径写入工具。固定执行顺序为：

1. 校验当前 Native Runtime 的不透明预授权 handle、项目运行会话、task/generation/attempt/provider-step 归属、授权 hash、状态和过期时间；Provider call ID/ordinal 只能来自该 step 的协议解析；
2. 验证工具已被当前 AgentIntent 和预授权白名单授权，未知工具先记录安全拒绝；
3. 严格解析 JSON、拒绝未知字段和任何可信字段名；
4. 标题/标识符执行一次 NFC，正文只做 UTF-8、控制字符和长度校验，再计算规范参数 hash；
5. 预查询 `(task_id, attempt_id, provider_step_id, provider_call_id)` 只作快速路径提示；真正的去重必须在同一 SQLite 写事务内以唯一约束原子 `INSERT`，唯一冲突后重读首次记录。同 hash 返回首次结果且不重复领取配额，不同 hash 稳定返回 `IDEMPOTENCY_KEY_REUSED`，不得把裸 SQLite UNIQUE 错误暴露给调用方；
6. 在同一写事务内原子领取预授权调用额度、预留任务/step 工具配额，并再次 CAS 校验任务 `row_version`、活动状态、项目可写、目标归属和基础版本；只有成功插入/认领本次 tool call 后才能执行领域副作用；
7. 写入 `validated -> executing`，用 savepoint 包住领域写入；业务失败时回滚 savepoint，仅回滚领域变更，再在外层事务提交 `failed` 工具事实和已消耗的配额。若连接/事务本身失败，使用独立有界失败记录事务重试落证，不能把已领取的调用伪装成未发生；成功则同事务提交领域终态和 tool-call 终态；
8. 返回脱敏、大小受限的结果，不返回不必要的正文。

`executeConfirmedCall` 不是第二个公开调用入口：它只由 `agent.task.confirm` 的 Worker 事务以内调用，只接受 confirmation ID 和数据库中原始 `awaiting_confirmation` Provider call；它跳过“新 call 的 INSERT”，但必须再次校验 replacement authorization、原始规范参数 hash、scoped identity、任务 CAS、目标版本和配额后，按照 confirmation 的无正文 descriptor 执行第 7 步。Desktop、模型和 Native Runtime 都不能向它传入或替换 call ID、ordinal、authorization、目标或参数。

取消也通过第 6 步使用的任务 CAS 竞争：取消先提交时工具不得写入；工具先提交时取消响应必须承认已提交产物并保留草稿或归档/恢复结果。

### 11.3 DocumentDraftService

负责创建工作版本、编辑保存、版本差异、基础版本冲突和草稿状态。不负责决定模型该写什么。

### 11.4 ReviewService

负责审核请求、用户决定、发布事务、发布历史和审计事件。不允许被模型调用。

### 11.5 ContextService

负责选择已发布权威资料、约束、记忆和会话，生成可复核的不可变上下文 manifest，并在运行时重建 Provider 输入。默认排除草稿、归档文档和任务日志，不把完整正文复制到审计快照。

### 11.6 TaskLogQueryService

提供统一任务日志查询 DTO，将 `agent_tasks`、`llm_generations`、图片任务和视频任务映射为统一展示模型。首期不合并底层领域表，不复制任务数据。

### 11.7 ProviderLoopService

负责以 generation/attempt 为完整工具循环边界，创建和恢复 Provider steps、签发/撤销 step-local 预授权、在收到 Provider call 后派生可信调用信封、汇总 step usage、处理 continuation ID，并保证工具结果回传不会重复执行已成功副作用。

## 12. 数据模型：v13 真实快照与 v14 增量

当前代码常量 `CURRENT_SCHEMA_VERSION` 为 13。以下 12.1 和 12.2 只描述仓库当前真实事实；12.3 起才是待实施的 v14 增量。不得把 v14 目标字段写成 v13 已存在字段，也不得重复执行 v12/v13 已完成迁移。

### 12.1 Schema v13：Agent 任务事实

`agent_tasks` 当前真实字段和约束：

```text
agent_tasks
- id TEXT PRIMARY KEY
- project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
- project_session_id TEXT NOT NULL
- conversation_id TEXT NULL REFERENCES conversations(id) ON DELETE SET NULL
- user_message_id TEXT NULL REFERENCES chat_messages(id) ON DELETE SET NULL
- task_type TEXT NOT NULL CHECK ('document-create' | 'document-update')
- scope_type TEXT NOT NULL CHECK ('project' | 'scene' | 'shot')
- scope_id TEXT NULL
- title TEXT NOT NULL
- request_snapshot_json TEXT NOT NULL JSON
- request_hash TEXT NOT NULL
- context_snapshot_id TEXT NULL REFERENCES context_snapshots(id) ON DELETE SET NULL
- status TEXT NOT NULL CHECK ('queued' | 'running' | 'waiting_review' | 'completed' | 'failed' | 'cancelled')
- outcome TEXT NULL CHECK ('published' | 'rejected' | 'discarded')
- retry_of_task_id TEXT NULL REFERENCES agent_tasks(id) ON DELETE SET NULL
- idempotency_key TEXT NULL
- error_code/error_message/retryable
- created_at/started_at/updated_at/completed_at
- version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0)
```

`conversation_id` 和 `user_message_id` 在 v13 中允许为空，用于兼容迁移或非会话入口；业务 Service 对标准会话创建流程仍要求两者存在。非空幂等键受 `UNIQUE(project_id, idempotency_key)` 部分索引保护。

```text
agent_task_generations
- task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE
- generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE CASCADE
- ordinal INTEGER NOT NULL
- purpose TEXT NOT NULL
- created_at TEXT NOT NULL
- PRIMARY KEY(task_id, generation_id)
- UNIQUE(task_id, ordinal)
- UNIQUE(generation_id)
```

```text
agent_task_events
- id TEXT PRIMARY KEY
- task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE
- project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
- sequence INTEGER NOT NULL
- event_type TEXT NOT NULL
- level TEXT NOT NULL CHECK ('info' | 'warning' | 'error')
- actor_type TEXT NULL
- actor_id TEXT NULL
- summary TEXT NOT NULL
- payload_json TEXT NULL JSON
- dedupe_key TEXT NULL
- created_at TEXT NOT NULL
- UNIQUE(task_id, sequence)
```

v13 的 `actor_type` 目前可空；v14 Service 必须停止新增空 Actor，后续表重建时再收紧 Schema。当前任务事件只有禁止 UPDATE 的触发器，`task_id/project_id` 仍是 `ON DELETE CASCADE`，因此尚不具备“长期保留”的外键保证；v14 才会重建为 `RESTRICT`。正文不得复制到 `payload_json`。

```text
agent_tool_calls
- id TEXT PRIMARY KEY
- task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE
- generation_id TEXT NULL REFERENCES llm_generations(id) ON DELETE SET NULL
- attempt_id TEXT NULL REFERENCES llm_generation_attempts(id) ON DELETE SET NULL
- provider_call_id TEXT NULL
- tool_name TEXT NOT NULL
- arguments_json TEXT NOT NULL JSON
- arguments_hash TEXT NOT NULL
- result_json TEXT NULL JSON
- status TEXT NOT NULL CHECK ('received' | 'validated' | 'executing' | 'succeeded' | 'failed' | 'cancelled')
- idempotency_key/error_code/error_message
- created_at/started_at/completed_at
- version INTEGER NOT NULL DEFAULT 0
```

同一任务内非空 `provider_call_id` 和非空 `idempotency_key` 分别有唯一索引。重复调用只有在参数 hash 一致时才能返回首次结果；hash 不同返回 `IDEMPOTENCY_KEY_REUSED`。

这是 v13 真实但不符合目标隐私边界的存储：`arguments_json` 和 `result_json` 允许包含工具原始 JSON，可能含 `contentMarkdown` 或 `document.read` 正文；v13 也尚无 `awaiting_confirmation`。v14 必须在重建时将其替换为脱敏摘要字段、增加确认等待状态并清理旧正文，不能把现有行为误称为已脱敏。

### 12.2 Schema v13：文档工作流事实

`documents` 当前已有 `current_version_id`、`scope_type/scope_id`，v12 新增 `published_version_id`、`lifecycle_status` 和 `row_version`。v13 **没有** `archived_at`、归档 Actor 或归档原因字段。

`document_versions` 当前由基础字段 `id/document_id/version/content_markdown/created_at` 加下列工作流字段组成：

```text
state TEXT NOT NULL DEFAULT 'published'
base_version_id TEXT NULL
title_snapshot TEXT NULL
scope_type_snapshot TEXT NULL
scope_id_snapshot TEXT NULL
author_type TEXT NOT NULL DEFAULT 'user'
author_id TEXT NULL
source_task_id TEXT NULL
source_message_id TEXT NULL
context_snapshot_id TEXT NULL
content_hash TEXT NULL
state_updated_at TEXT NULL
state_version INTEGER NOT NULL DEFAULT 0
```

其中 `title_snapshot`、`scope_type_snapshot` 和 `content_hash` 在当前 Schema 仍可空；v14 写路径必须要求新记录非空，并先清理/报告历史空值，再考虑表重建收紧。v13 没有 `change_summary` 字段。

```text
document_reviews
- requested_by_type TEXT NOT NULL
- requested_by_id TEXT NULL
- decided_by_type TEXT NULL
- decided_by_id TEXT NULL
- review version INTEGER NOT NULL DEFAULT 0
- UNIQUE(document_version_id)
```

审核表还包含项目、文档、版本、可空任务、状态、时间和评论字段。字段名不是 `requested_by`/`decided_by`。

```text
document_publications
- review_id TEXT NULL REFERENCES document_reviews(id) ON DELETE SET NULL
- published_by_type TEXT NOT NULL
- published_by_id TEXT NULL
- UNIQUE(document_id, publication_no)
- UNIQUE(document_version_id)
```

发布表还包含项目、文档、发布版本、前一版本、任务和发布时间。v13 的 `review_id` 当前可空，以兼容迁移生成的发布记录。

```text
agent_task_document_versions
- task_id
- document_id
- document_version_id
- operation CHECK ('create' | 'update' | 'regenerate')
- created_at
- PRIMARY KEY(task_id, document_version_id, operation)
```

首期 Service 在此现有表之上强制“创建/更新任务一主要文档”不变量；查询、归档和恢复任务保存操作结果但不创建伪产物。该表是 v13 的多版本历史关联，`regenerate` 可保留同一任务的多条版本事实；v14 不能将它静默删除或当作第二个主要产物来源，具体迁移、只读历史和主产物投影规则见 12.3。后续场次、镜头和记忆扩展时增加领域专用关联表或受 Schema 约束的 change set，不使用无外键的任意 `artifact_type + artifact_id` 代替事实关联。

Schema v13 的 `document_audit_events.action` 目前只允许：

```text
draft_saved
draft_restored
review_submitted
review_changes_requested
review_rejected
published
```

其 `document_version_id` 当前非空，文档和版本外键会影响 purge 设计。审计记录由触发器禁止 UPDATE/DELETE，metadata JSON 上限为 4096 字符，不保存 Markdown 正文或审核评论。

`context_snapshots` 仍只有 `id/project_id/purpose/content_json/created_at`。当前代码会把完整编译上下文写入 `content_json`；这是 v13 现状，不是后续允许继续使用的审计标准。

### 12.3 Schema v14：任务、工具和 Provider step 增量

v14 先重建 `agent_tasks` 的受限枚举并统一并发字段。v13 已存在的 `agent_tasks.version` 是当前唯一的任务 CAS 计数器；迁移必须将其原值无损回填为唯一的 `row_version`，同步所有 Repository、Domain、Contracts 和 Worker 条件更新，并删除物理列 `version`。此规则只作用于 task：`agent_tool_calls.version` 可继续作为调用记录自身的乐观并发字段，但绝不能参与任务取消/工具提交的线性化。v14 后不得同时维护两个任务 CAS 计数器：

```text
task_type:
  document-create | document-update | document-query | document-archive | document-restore
outcome:
  published | rejected | discarded | read-only | archived | restored
phase TEXT NOT NULL DEFAULT 'queued'
  CHECK (phase IN ('queued', 'intent_resolving', 'context_compiling',
    'model_running', 'tool_validating', 'waiting_confirmation',
    'artifact_persisting', 'waiting_review', 'recovering'))
row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0)
tool_call_limit INTEGER NOT NULL DEFAULT 8
  CHECK (tool_call_limit BETWEEN 1 AND 16)
tool_call_count INTEGER NOT NULL DEFAULT 0
  CHECK (tool_call_count BETWEEN 0 AND tool_call_limit)
lifecycle_status TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_status IN ('active', 'archived'))
archived_at TEXT NULL
```

创建/更新任务才要求一个主要文档产物；查询、归档和恢复任务通过 outcome 完成。取消和工具提交都必须对 `row_version` 做条件更新。任务只允许逻辑归档，普通业务接口不得 DELETE。

v14 新增一次性用户确认事实表，避免把确认状态藏在 UI 或普通消息中：

```text
agent_task_confirmations
- id TEXT PRIMARY KEY
- project_id/task_id/generation_id/attempt_id TEXT NOT NULL
- original_tool_call_id TEXT NOT NULL REFERENCES agent_tool_calls(id) ON DELETE RESTRICT
- action TEXT NOT NULL
- target_document_id TEXT NULL REFERENCES documents(id) ON DELETE RESTRICT
- target_version_id TEXT NULL REFERENCES document_versions(id) ON DELETE RESTRICT
- expected_document_row_version INTEGER NULL
- normalized_arguments_hash TEXT NOT NULL
- continuation_descriptor_json TEXT NOT NULL JSON
- token_hash TEXT NOT NULL
- continuation_authorization_id TEXT NULL REFERENCES agent_tool_authorizations(id) ON DELETE RESTRICT
- status TEXT NOT NULL CHECK ('pending' | 'rejected' | 'expired' | 'consumed')
- expires_at TEXT NOT NULL
- approved_by_type/approved_by_id TEXT NULL
- approved_at/consumed_at TEXT NULL
- created_at TEXT NOT NULL
- UNIQUE INDEX idx_agent_task_confirmation_pending
  (task_id) WHERE status = 'pending'
- UNIQUE INDEX idx_agent_task_confirmation_continuation
  (continuation_authorization_id) WHERE continuation_authorization_id IS NOT NULL
```

触发器校验所有 ID 属于同一项目、原始 tool call 与 task/step 一致，且 token 只保存 hash；`continuation_descriptor_json` 是受版本化 Schema 限制的无正文对象，只允许 operation、可信目标/基础版本、CAS、策略版本和可选的有界 reason code，禁止 Markdown、完整参数或 Provider 正文；`continuation_authorization_id` 只能在 `consumed` 时非空并且必须绑定原始 call 的 Provider step/task/目标，其他状态必须为 NULL。进入确认等待时，Worker 将 task `phase=waiting_confirmation`、原始 tool call 标为 `awaiting_confirmation`，不执行领域副作用、不消耗执行工具配额；UI 只能调用 `agent.task.confirm`/`agent.task.reject`，不能直接调用文档归档 primitive。`agent.task.confirm` 在一个 Worker 事务中以 confirmation `status='pending'`、task `row_version`、目标当前版本和未过期为条件，**唯一一次**原子领取并消费 token，签发一次性 replacement authorization（绑定原始已持久化 Provider step、同一 task/目标）并写入 `continuation_authorization_id`，随后把**同一条**原始 tool call 从 `awaiting_confirmation` 原子转换为 `executing`，领取执行配额并由 ToolGateway 的内部 `executeConfirmedCall` 仅按该 descriptor 执行。它不创建第二条 `agent_tool_calls`、不伪造 Provider call ID/ordinal、也不把 Desktop 请求写入 manual 路径；Provider 路径始终使用原始 scoped call ID。业务失败时 savepoint 回滚领域变更，但 token、失败工具事实和已领取配额一起提交；用户必须发起新的确认请求，不能重放旧 token。确认重放只读取已消费 confirmation 或原始 call 的稳定终态；中断恢复只继续该原始 call 并从 descriptor 重建受限动作。确认失败、拒绝或过期只结束任务，不写归档事实。这样确认后的执行仍经过同一白名单、授权、配额、CAS、savepoint 和审计链路，且不会复用已过期 handle。

v14 新增明确的文档任务主要产物投影表；它与 v13 已存在的多版本历史关联 `agent_task_document_versions` 分工，不形成第二个可写事实源：

```text
agent_task_document_artifacts
- id TEXT PRIMARY KEY
- project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT
- task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT
- document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT
- document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT
- artifact_role TEXT NOT NULL CHECK ('primary')
- disposition TEXT NOT NULL CHECK ('draft' | 'published' | 'rejected' | 'discarded')
- row_version INTEGER NOT NULL DEFAULT 0 CHECK (row_version >= 0)
- created_at TEXT NOT NULL
- updated_at TEXT NOT NULL
- UNIQUE(task_id, artifact_role)
```

触发器校验 project/task/document/version 一致；只有 `document-create/document-update` 允许插入一条 primary artifact。查询、归档和恢复任务不写该表。

主要产物是可变投影，不是固定指向第一版草稿的历史记录。每次用户基于该 primary 草稿保存新版本时，DocumentWorkflowService 必须在同一事务以 artifact 当前 `document_version_id`、文档 `row_version` 和新版本 `base_version_id` 为条件 CAS 更新投影到新 draft，并保持旧版本仅存于 `agent_task_document_versions` 历史；`changes_requested` 后的修订也遵循同一规则。`document.selfPublish` 以当前投影版本为输入，在同一事务将 `disposition` 更新为 `published`；用户拒绝、放弃草稿分别以版本状态和 artifact 行 CAS 更新为 `rejected`、`discarded`。已发布/拒绝/放弃后的 artifact 不可被旧窗口或旧任务写回覆盖；若用户明确从历史版本另建手工草稿，其 `source_task_id=NULL`，不改写原任务 artifact。所有投影变化追加任务/文档审计，且 `updated_at` 与 CAS 版本同步更新。

`agent_task_document_artifacts` 是 v14 后唯一的“当前主要产物”读取投影，不取代 v13 `agent_task_document_versions` 的不可变版本历史。迁移保留并重建旧历史表为 `ON DELETE RESTRICT`，并将其写入口关闭；按同一 task 的 `created_at, document_version_id` 稳定排序，在所有候选均指向同一个 document、版本仍属于该 document、且版本的 `source_task_id` 等于 task 时，把最后一条记录投影为唯一 `primary`。旧 `create/update/regenerate` 行仍只通过 `agent.task.artifactHistory` 审计读取，不参与默认任务卡、上下文或主要产物判断。候选为空、候选跨多个 document、版本关系不一致或无唯一最后项时不猜测 primary：迁移写 `task_artifact_projection_invalid` 维护报告，任务默认不显示主要产物，直到用户维护动作修复。Repository/UI 只能以新表读取主要产物，历史视图明确标记为 legacy evidence，避免两个可写事实源。

每次 Provider step 在 HTTP 请求前都要持久化一组不可变的工具预授权。预授权绑定可信任务、attempt、step、项目会话、操作和目标，不包含尚未出现的 Provider call ID：

```text
agent_tool_authorizations
- id TEXT PRIMARY KEY
- project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT
- task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT
- generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE RESTRICT
- attempt_id TEXT NOT NULL
- provider_step_id TEXT NOT NULL REFERENCES llm_provider_steps(id) ON DELETE RESTRICT
- project_session_id TEXT NOT NULL
- allowed_operation TEXT NOT NULL  -- versioned ToolRegistry operation name
- target_document_id TEXT NULL REFERENCES documents(id) ON DELETE RESTRICT
- scope_type/scope_id TEXT NULL
- base_version_id TEXT NULL REFERENCES document_versions(id) ON DELETE RESTRICT
- expected_document_row_version INTEGER NULL
- policy_version/tool_schema_version TEXT NOT NULL
- authorization_handle_hash TEXT NOT NULL
- status TEXT NOT NULL CHECK ('issued' | 'revoked' | 'expired')
- max_call_uses INTEGER NOT NULL CHECK (max_call_uses BETWEEN 1 AND 8)
- used_call_count INTEGER NOT NULL DEFAULT 0
  CHECK (used_call_count BETWEEN 0 AND max_call_uses)
- expires_at TEXT NOT NULL
- revoked_at TEXT NULL
- row_version INTEGER NOT NULL DEFAULT 0
- created_at TEXT NOT NULL
```

触发器校验 project/task/generation/attempt/step/document/version 和作用域完全一致；`target_document_id` 只允许通用 update/archive/restore，create/list/read 使用受限 scope 或 Worker 生成的任务内句柄。`allowed_operation` 不由模型或 Desktop 提供，而是由版本化 ToolRegistry 在授权创建和调用执行两次校验；未知、未注册或与 `tool_schema_version` 不匹配的 operation 一律拒绝。这样 v16 可在不重建 v14 预授权表的前提下，让小说工具从 `agent_task_targets` 的具体 FK 获取可信 chapter/document 目标。Worker 只把高熵不透明 authorization handle 交给当前 Native Runtime，数据库仅保存其 hash；模型永远看不到 handle、authorization ID、确认 token 或可信目标。Runtime 在本地为每个可见工具选择未用完的预授权。预授权只能绑定它创建时指定的 Provider step，状态只能从 `issued` 到 `revoked/expired`；每次接受调用把 `used_call_count` 递增，达到 `max_call_uses` 即耗尽；取消、任务终态、项目会话变化和恢复时的归属不匹配都会撤销或过期它。ToolGateway 通过 handle hash、`status='issued'`、`used_call_count < max_call_uses`、未过期和相同 `row_version` 条件更新原子领取一次调用额度。确认 token 只存于 `agent_task_confirmations`，只在 `agent.task.confirm` 的事务中领取一次；它不属于 authorization，也不会在后续归档写入时再次消费。重放到其他 step、call 或 task 必须失败。

v14 重建 `agent_tool_calls`。它保留调用状态和可审计关联，但删除会持久化正文的 `arguments_json/result_json` 写法，改为：

```text
- project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT
- authorization_id TEXT NULL REFERENCES agent_tool_authorizations(id) ON DELETE RESTRICT
- provider_step_id TEXT NULL REFERENCES llm_provider_steps(id) ON DELETE RESTRICT
- tool_ordinal INTEGER NULL CHECK (tool_ordinal IS NULL OR tool_ordinal >= 0)
- status TEXT NOT NULL CHECK ('received' | 'validated' | 'awaiting_confirmation' | 'executing' | 'succeeded' | 'failed' | 'cancelled')
- normalized_arguments_hash TEXT NOT NULL
- arguments_summary_json TEXT NOT NULL JSON
- content_hash TEXT NULL
- content_length INTEGER NULL CHECK (content_length IS NULL OR content_length >= 0)
- result_summary_json TEXT NULL JSON
- result_document_id TEXT NULL REFERENCES documents(id) ON DELETE RESTRICT
- result_document_version_id TEXT NULL REFERENCES document_versions(id) ON DELETE RESTRICT
- redaction_state TEXT NOT NULL CHECK ('native' | 'legacy_redacted')
- UNIQUE(provider_step_id, tool_ordinal)
- UNIQUE(id, project_id)  -- 供领域 partial/artifact 使用同项目复合 FK
- UNIQUE INDEX idx_agent_tool_calls_provider_scope
  (task_id, attempt_id, provider_step_id, provider_call_id)
  WHERE provider_call_id IS NOT NULL AND provider_step_id IS NOT NULL
- UNIQUE INDEX idx_agent_tool_calls_manual_idempotency
  (task_id, idempotency_key)
  WHERE provider_step_id IS NULL AND idempotency_key IS NOT NULL
```

`agent_tool_calls` 还必须有互斥的路径约束，不能依赖含 `NULL` 的 UNIQUE 索引兜底：real Provider 路径要求 `generation_id`、`attempt_id`、`provider_step_id`、`authorization_id`、`provider_call_id`、`tool_ordinal` 全非空且 `idempotency_key IS NULL`；manual 路径要求这六个 Provider 字段全为空、`idempotency_key` 非空且 `redaction_state='native'`；legacy 路径要求 `provider_step_id`、`authorization_id`、`provider_call_id`、`tool_ordinal` 全为空、`idempotency_key` 非空且 `redaction_state='legacy_redacted'`，其 `generation_id/attempt_id` 要么同时为空，要么通过复合 FK 指向同一历史 attempt。任一路径都不得混合字段。迁移、新建和更新均在同一 CHECK/触发器下校验，避免伪造 Provider 调用或把手工调用纳入 Provider 去重域。

v14 的状态触发器明确允许 `validated -> awaiting_confirmation -> executing | failed | cancelled`，确认只恢复原 call；`awaiting_confirmation`、`executing` 和所有终态均禁止通过普通 Desktop/Repository 更新绕过 Worker CAS。

v14 在重建中删除旧 `idx_agent_tool_calls_provider(task_id, provider_call_id)` 和旧 `idx_agent_tool_calls_idempotency(task_id, idempotency_key)`，用上表的 real-Provider 四元组部分唯一索引和 manual/legacy 二元组部分唯一索引替代；不能依赖含 `NULL` 的复合 `UNIQUE`。Repository 的 Provider 重放查询也必须使用 `(task_id, attempt_id, provider_step_id, provider_call_id)`，而不是旧的 task/call 二元组。legacy/manual 工具调用允许 `provider_step_id=NULL` 且无 authorization，并使用 task-scoped `idempotency_key`；真实 Provider 工具调用的 step、authorization 和 ordinal 必须非空且 `idempotency_key=NULL`。触发器校验 tool call 的 generation/attempt 与 provider step 完全一致，authorization 属于同一 project/task/generation/attempt/step，结果 document/version 相互对应，且 generation 已通过 `agent_task_generations` 绑定当前 task。

`arguments_summary_json` 和 `result_summary_json` 只能保存枚举、字段名、ID、状态、hash、长度、有限搜索计数和稳定错误码，严格拒绝 `contentMarkdown`、`content`、`text`、完整 `document.read` 结果、完整 prompt、完整 Provider response 或可逆正文编码。工具的规范化原始参数和 continuation 所需短期正文只存在 Native Runtime 的受限内存；恢复时从已持久化的 document/version 或重新授权读取重建，不能从任务日志取回正文。迁移将每条 v13 原始参数/结果转换为 `legacy_redacted` 摘要，只保留已有/重算 hash、长度、tool 名、状态和有界错误；原始 JSON 不复制到新表。迁移前备份受现有本地备份策略保护，v14 后公开 Repository/UI API 只返回脱敏 DTO。

为保证长期任务证据不被单表清理级联删除，v14 将 `agent_tasks.project_id` 以及 `agent_task_generations`、`agent_task_events`、`agent_tool_calls`、`agent_task_confirmations` 的 project/task/generation 外键重建为 `ON DELETE RESTRICT`，并让新的 `agent_task_document_artifacts` 使用 RESTRICT 外键；应用只提供任务逻辑归档。删除整个本地项目属于项目级显式维护和备份流程，不通过删除单条项目/任务记录实现。

v14 新增每次 Provider 请求/响应的事实表：

```text
llm_provider_steps
- id TEXT PRIMARY KEY
- project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT
- generation_id TEXT NOT NULL REFERENCES llm_generations(id) ON DELETE RESTRICT
- attempt_id TEXT NOT NULL
- ordinal INTEGER NOT NULL CHECK (ordinal >= 0)
- protocol TEXT NOT NULL
- provider_response_id TEXT NULL
- status TEXT NOT NULL CHECK ('prepared' | 'in_flight' | 'complete' | 'failed' | 'interrupted')
- tool_call_count INTEGER NOT NULL DEFAULT 0
  CHECK (tool_call_count BETWEEN 0 AND 8)
- finish_reason TEXT NULL
- input_tokens INTEGER NULL
- cached_input_tokens INTEGER NULL
- output_tokens INTEGER NULL
- reasoning_tokens INTEGER NULL
- total_tokens INTEGER NULL
- provider_reported_cost TEXT NULL
- currency TEXT NULL
- continuation_manifest_json TEXT NULL JSON
- request_hash TEXT NOT NULL
- response_hash TEXT NULL
- started_at TEXT NOT NULL
- completed_at TEXT NULL
- error_code TEXT NULL
- error_message TEXT NULL
- UNIQUE(attempt_id, ordinal)
- UNIQUE(id, project_id)  -- 供领域 partial/artifact 使用同项目复合 FK
- FOREIGN KEY(attempt_id, generation_id)
    REFERENCES llm_generation_attempts(id, generation_id) ON DELETE RESTRICT
```

约束：

- v14 为 `llm_generation_attempts(id, generation_id)` 建立唯一索引，复合 FK 保证 attempt 必须属于同一 generation；
- `project_id` 是为领域复合 FK 增加的受控冗余字段；插入、迁移和更新时必须由 generation/task 反查并由触发器校验，`UNIQUE(id, project_id)` 只用于被引用，不能由调用方自行填写；
- generation/attempt 是完整 tool loop，step 是其中一次 Provider HTTP 请求/响应；
- step 不保存完整上下文、完整工具参数正文、完整工具定义或 Provider 原始响应，只保存协议事实、hash、continuation manifest、usage 和有界错误；
- step usage 逐条保存，attempt 的 Token 和费用字段保存所有 complete step 的汇总；汇总前校验 Provider total 与分项一致性并记录差异；
- `continuation_manifest_json` 只保存继续请求所需的有界 Provider ID、前序 step/tool call ID 和策略版本，不保存正文；
- Worker/Native Runtime 中断后根据最后一个 step 和工具调用终态恢复，绝不能再次执行已经 `succeeded` 的工具副作用。

工具配额的计数单位是“通过可信信封、白名单、Schema 和 scoped 去重后首次接受的 Provider function call”。ToolGateway 在同一个 SQLite 写事务内，以任务当前 `row_version`、任务未终态、`agent_tasks.tool_call_count < tool_call_limit` 和 `llm_provider_steps.tool_call_count < stepLimit` 为条件，先预留两个计数并将 task `row_version` 递增，再允许进入工具业务写入；任一条件失败时不得执行副作用。首次接受但业务处理失败的调用仍计入配额并写入失败事实；相同 scoped call ID 且参数 hash 相同的重放只返回首次结果，不重复消耗配额；参数 hash 不同、Schema 不合法或未通过白名单的调用不消耗执行配额。v14 基线的默认 `stepLimit=4`、硬上限 8，任务 `tool_call_limit` 默认 8、硬上限 16；当前 Schema v18 的任务配额调整见 12.8。取消与配额预留竞争同一 task CAS，取消先赢时不预留也不写业务数据；配额或 CAS 失败后 Runtime 不得继续执行未获预留的并列调用。

### 12.4 Schema v14：归档、恢复、purge 和审计增量

`documents` 增加：

```text
archived_at TEXT NULL
archived_by_id TEXT NULL
archive_reason TEXT NULL  -- 有界，不保存正文
```

`lifecycle_status` 继续使用现有 `active | archived`。恢复归档时清空归档字段并增加 `row_version`；归档和恢复都执行 CAS。

`document_audit_events` 通过 v14 表重建同时解决动作扩展和 purge 后审计保留：

```text
document_id TEXT NULL REFERENCES documents(id) ON DELETE SET NULL
document_id_snapshot TEXT NOT NULL
document_version_id TEXT NULL REFERENCES document_versions(id) ON DELETE SET NULL
document_version_id_snapshot TEXT NOT NULL

action 增加：
archived
archive_restored
purged
self_reviewed
self_published
draft_discarded（若实现放弃草稿）
document_imported
draft_exported
partial_artifact_recovered（小说 v17 仅记录 partial ID hash、原任务 ID 和用户 Actor）
binding_changed
scope_changed
security_denied
```

迁移时把 v13 的 live ID 回填到 snapshot ID。非 purge 动作插入时，触发器仍要求 live ID、snapshot ID、项目和版本完全匹配；purge 事务先追加 Actor 为用户的 `purged` 行，再删除文档和版本，`ON DELETE SET NULL` 只清空 live FK，snapshot ID 和有界 metadata 继续作为最小审计墓碑保留。

`security_denied` 只保存 reason code、工具/策略版本、可信信封 hash 和目标类型，不保存恶意正文或完整参数。导入、草稿导出、binding/作用域变化必须记录前后 ID/hash 和用户或任务 Actor。

墓碑 metadata 只保存 reason code、引用检查计数/ID hash、版本数量、是否曾发布、幂等键和时间，不保存标题正文、版本正文、审核评论或完整上下文。默认策略为文档存在 publication 时拒绝 purge；未来若通过单独维护 ADR 放开，必须先解决 publication、task、export、backup 和外部引用。

### 12.5 Schema v14：上下文 manifest 兼容治理

v14 起，`context_snapshots.content_json` 只允许写入带 `schemaVersion` 的 `ContextSnapshotManifestV2`：来源 ID/版本/hash、字符数、Token、裁剪/摘要策略、预算和编译器版本。禁止新增完整正文、完整渲染上下文、完整系统提示或完整工具定义。

现有 v13 快照兼容处理：

1. 迁移工具扫描 legacy `content_json`，在事务和备份保护下提取可保留 manifest；
2. 对可重建来源计算 hash、版本和计数后原位替换为 manifest，不改变被 generation/attempt/task 引用的 snapshot ID；
3. 无法完整还原 manifest 的旧记录写入 `legacyRedacted=true`、可用 hash/计数和清理时间，不复制旧正文；
4. 被引用快照不得直接删除，以免当前外键级联删除 generation attempt；只清理/重写其内容；
5. 未被引用的 summary cache 可按项目维护策略淘汰，清理动作记录数量和时间，不记录正文。

### 12.6 v14 迁移顺序

当前 `migrateDatabase` 在 `foreign_keys=ON` 下为每个版本使用事务包装；v14 不是可以直接 `DROP/ALTER` 父表的普通 SQL 字符串。必须增加专用 `runV14Rebuild` 路径，采用 SQLite 官方 12-step table-rebuild 策略：迁移连接在 `BEGIN IMMEDIATE` 前完成 checkpoint，并仅在没有活动事务且独占迁移锁已取得时临时执行 `PRAGMA foreign_keys=OFF`；事务内只构建和切换影子表，提交前/重新开启 FK 后各执行完整性检查；不得在普通事务中执行无效的 `PRAGMA foreign_keys=OFF`，也不得让任何影子表状态对其他连接可见。任一步失败都回滚、恢复 FK 设置并保留旧 schema 可打开。

swap 前必须先从 `sqlite_master` 计算受重建父表影响的完整入站 FK 闭包，不能只列直接子表。对 `agent_tasks` 至少包括自引用 retry、`agent_task_generations`、`agent_task_events`、`agent_tool_calls`、`agent_task_document_versions`、`agent_tool_authorizations`、`agent_task_confirmations`、`agent_task_document_artifacts`、`document_versions.source_task_id`、`document_reviews.task_id`、`document_publications.task_id` 和 `document_audit_events.task_id`；文档/版本父表的 reviews、publications、audits、artifacts、targets 和其他入站 FK 同样纳入影子重建或重新创建。提交前后扫描 `sqlite_master.sql`，不得有任一 FK、trigger、view 或 index 仍指向 `__v13_old_*`。

1. 迁移前 checkpoint、备份、`quick_check` 和 `foreign_key_check`；备份包含可能含旧工具正文的 v13 表，只能由本地维护流程访问；
2. 在影子命名空间创建最终版 `agent_tasks`、`agent_task_generations`、`agent_task_events`、`agent_task_document_versions`、`llm_provider_steps`、`agent_tool_authorizations`、`agent_tool_calls`、`agent_task_confirmations`、`agent_task_document_artifacts` 和所需文档/审计表，不先删除任何 v13 表；`agent_task_confirmations` 必须在 `agent_tool_calls` 之后建立其 FK、pending 唯一索引和不可变触发器；
3. 按依赖顺序复制并转换数据：为 attempts 建立复合唯一索引和 Provider steps；把每条 v13 task `version` 原值写入唯一 `row_version`，增加 task/outcome、逻辑归档和工具配额；旧 history 按 12.3 规则投影 primary，初始化 artifact `row_version=0`，异常 task 写维护报告而不猜测；所有 v13 工具记录一律进入 `legacy_redacted` 路径：确定性写入 `idempotency_key='legacy:' || old.id`，清空旧 `provider_call_id/provider_step_id/authorization_id/tool_ordinal`，把旧 Provider/幂等标识仅以 hash/长度写入摘要，`generation_id/attempt_id` 仅在两者构成有效历史复合关联时保留；这样覆盖 provider/idempotency 都为空、仅一项存在或两项同时存在的旧组合，且不把无 step/auth 的旧 call 冒充 real Provider call；v14 新增的 confirmation 表对既有任务初始化为空，不能从普通消息猜测 pending confirmation；Provider step/tool call 写入 `project_id` 并生成同项目复合唯一键；
4. 在影子表上校验行数、hash、同项目/同 generation/attempt/step/document/version 复合归属、CAS token 不重置、工具去重索引、confirmation 外键/状态/过期约束和所有触发器前置条件；校验失败立即回滚；
5. 依照 SQLite 12-step 的依赖顺序重命名旧子表和父表为受保护的 `__v13_old_*`，将完整入站 FK 闭包的影子表切换到正式名称，再重建全部索引、触发器和视图；删除两个旧 Provider/idempotency partial index，建立 v14 Provider 四元组和 manual/legacy 二元组索引；confirmation 表随 tool-call 依赖一起 swap；对每个受影响父表扫描 `sqlite_master` 确认没有对象仍引用旧表，旧表只有在该扫描和 `foreign_key_check` 通过时才允许清理；
6. 增加文档归档字段并回填 active/archived 一致性；重建文档审计表，增加 snapshot ID、将 live FK 改为可空 `ON DELETE SET NULL`、扩展动作，并保留 v13 全部历史行；
7. 部署 manifest-only 双写/读取兼容，再执行 legacy 快照清理；
8. 提交前运行 `quick_check`、`foreign_key_check`、影子/正式表行数对账、`sqlite_master` 旧表引用扫描和脱敏泄漏扫描；提交后立即恢复 `foreign_keys=ON`，再次运行同样检查；
9. 更新 Repository、Domain、Contracts、Worker 和 Native Runtime，最后切换 Desktop；发布前禁止旧 Repository 读取原始工具载荷或使用 `agent_tasks.version`；
10. 验证新库直建、v13 -> v14、重复迁移、故障回滚、旧任务 CAS token 保持、旧索引不存在、v13 tool call 的 provider/idempotency 四种空值组合均得到唯一 `legacy:<id>` 键且不残留 Provider 身份、工具正文不残留、artifact 历史/异常报告、confirmation pending/过期/confirm/reject CAS 竞态、复合 FK mismatch、取消/提交竞态和旧项目恢复；
11. 不重复安排或重新执行 v12/v13 的 Agent、双指针、审核、发布和基础审计迁移。

### 12.7 P3.2 外部研究来源增量（Schema v17/v19 与来源展示已落地，端到端门禁待补）

P3.2 不修改既有 v14 工具事实的正文脱敏规则。当前已经从 Schema v16 迁移到 v17，并新增研究来源事实，避免把网页正文塞入 `agent_tool_calls`、`llm_provider_steps` 或 `context_snapshots`：

- 新增 `agent_research_sources`，至少关联 `project_id/task_id/generation_id/attempt_id/provider_step_id/tool_call_id`，保存来源 ID、规范 URL、URL hash、站点、标题、可选发布时间、检索/抓取时间、内容 hash、字符/Token 数、引用标签、采用/排除状态和稳定错误码；
- 搜索 query 的长期事实默认只保存 hash、长度、语言/时间范围和结果计数；不得复制完整项目上下文、凭据、Cookie、请求头或含敏感参数的 URL；
- 为当前 attempt 的网页正文建立项目本地 `cache/research/{contentHash}.txt` 受限缓存，文件只含经过正文提取、字符集规范化和提示注入隔离的文本；缓存不是权威资料，不提交 GitHub，可按 TTL/容量清理；
- 缓存索引保存 `content_hash/cache_relative_path/byte_count/expires_at`，路径必须由 Worker/Native 固定生成并验证在项目 `cache/research` 内，模型不能提供路径；
- 研究来源通过 `source_task_id` 和引用标签与最终文档版本关联；文档正文保留人类可读引用，任务日志只展示来源元数据和有界摘要；
- 迁移不回填或伪造旧任务的研究来源；v17 只影响启用 P3.2 后的新任务，旧 generation、文档和任务保持可读；
- 项目备份默认包含研究来源元数据和最终文档，不要求包含可重建的研究缓存；恢复正在运行的任务时缓存缺失必须明确重新检索或终止，不得伪称已恢复相同网页内容。

v17 门禁：新库直建、v16 -> v17、重复迁移、完整复合 FK、跨项目拒绝、URL/凭据脱敏、缓存路径边界、TTL/容量清理、缺失缓存恢复、研究来源与文档引用一致性以及旧任务零回填通过。

当前实现边界（2026-08-19）：`agent_research_sources`、v16 -> v17 -> v19 迁移、同项目/attempt/Provider step/tool call 归属触发器、URL/handle/content hash、站点、标题、检索时间、字符数、截断、缓存相对路径、稳定任务级引用标签、采用/排除原因、缓存 `byte_count/expires_at` 索引、TTL/容量清理、缺失缓存标记、草稿版本引用关联、任务详情来源 UI 和用户可见 `auto/project_only/network_disabled` 模式选择已落地；Worker 在项目打开/恢复时自动执行缓存治理，研究缓存清空会同步将来源标记为缺失。搜索 query 只以 hash 和有界摘要进入工具事实，网页正文只写入 `cache/research/{contentHash}.txt`。Native 研究桥已由 Desktop 创建一次性 loopback 端点和进程级令牌，Worker 只通过该桥提交公开 HTTPS GET；Native 层独立校验主机、DNS、公网地址、重定向禁用、MIME 请求白名单和响应体上限，无桥时 Worker fail-closed。Worker 到 Native 的请求 ID、取消 endpoint、取消注册表和 WinHTTP 分段取消已完成；崩溃后 in-flight 恢复、真实研究/安装包链路仍未完成，因此 P3.2 总门禁仍未完成。

### 12.8 P3.2 工具配额增量（Schema v18 已落地）

P3.2 首个真实桌面样本暴露了 v14-v17 配额缺陷：Agent task 默认最多 8 次工具调用，而完整研究任务需要多轮 search、fetch、一次文档写入和最终回复；模型即使已经取得有效来源，也可能在创建草稿前耗尽整任务额度。Schema v18 只重建 `agent_tasks`，把新任务默认额度调整为 16、数据库硬上限调整为 32，并保留 v17 任务的全部列值、现有 `tool_call_limit/tool_call_count`、自引用、入站外键、索引和触发器，不伪造或重置历史任务计数。

当前 Worker 配额行为：

- 显式 Agent 新任务写入 `tool_call_limit=16`，数据库仍强制 `1..32` 且 `tool_call_count <= tool_call_limit`；
- 每个任务最多执行 3 次 `research.search` 和 8 次 `research.fetch`，同时始终为目标 `document.*` 操作预留 1 次整任务额度；
- 单个 Provider step 仍最多接受 8 个并行只读研究调用；每个调用按 ordinal 独立记账，不把单步并行上限误当成整任务额度；
- 某类研究额度耗尽后，下一 step 不再下发该研究工具；同一并行批次中超出剩余额度的调用写入受控 `RESEARCH_BUDGET_EXCEEDED` 结果并继续 continuation，不使整个任务失败，也不挤占预留的文档操作；
- 成功抓取结果提示模型优先使用现有证据进入草稿创建，避免在证据足够后无界继续检索。

v18 门禁：新库直建、v17 -> v18、重复迁移、任务数据/复合外键/索引/触发器保持、默认值与硬上限、多个 search、并行 fetch、受控额度耗尽和额度耗尽后仍能创建唯一草稿均已通过自动化。动态项目级配额配置、累计网络时间/Token/费用联动仍按后续资源治理实施。

## 13. Agent 工具与 IPC 合同

### 13.1 LLM 工具

首期开放以下受控业务工具：

```text
document.list
document.read
research.search       -- P3.2 Worker 功能切片已实现
research.fetch        -- P3.2 Worker 功能切片已实现
document.create_draft
document.update_draft
document.archive
document.restore
```

默认优先由 Worker 在 Provider 调用前解析并注入所需项目文档；只有用户明确要求浏览或搜索项目资料时才开放 `document.list/read`。P3.2 启用后，显式 Agent 任务默认使用 `researchMode=auto`：需要时开放只读 `research.search/fetch`，用户显式选择 `project_only` 或 `network_disabled` 时不注册研究工具。公开参数按工具分离：

```text
document.list:
  query?         -- 有界搜索文本
  role?          -- 固定枚举
  limit?         -- 1..20，默认 10

document.read:
  documentHandle -- list 返回的任务内短期不透明句柄
  version?       -- published（默认）| working（仅目标任务显式授权）

research.search:
  query          -- 有界检索词；不得包含完整项目上下文或凭据
  language?      -- 受支持语言枚举
  recencyDays?   -- 1..3650；省略表示不限定时间
  limit?         -- 1..10，默认 5

research.fetch:
  sourceHandle   -- search 结果或 Worker 对用户显式 URL 预校验后签发的任务内短期不透明句柄
  maxChars?      -- 1..100000，默认 50000；仍受 Provider/来源硬上限约束

document.create_draft / document.update_draft:
  title
  contentMarkdown
  changeSummary? -- 可选、有界说明

document.archive / document.restore:
  reason?        -- 可选、有界；目标和动作授权来自可信执行信封
```

Schema 必须设置 `additionalProperties=false`，同时按字符数和 UTF-8 字节数校验标题、正文、查询和说明。`documentHandle` 与 `sourceHandle` 只能在当前 task/attempt 内使用并绑定已校验资源，不是数据库 ID；`research.fetch` 不接受模型直接提供任意 URL、文件路径、请求头、Cookie 或网络选项。用户消息中显式给出的 URL 先由 Worker/Native 经过与搜索结果相同的 URL 安全校验，再签发 `sourceHandle`。公开参数中严禁出现 `projectId`、`projectSessionId`、`conversationId`、`taskId`、`generationId`、`attemptId`、目标文档 ID、作用域、基础版本、CAS 行版本、幂等键或凭据 handle。

研究工具使用与文档变更分离的只读授权类型。Worker 可以在同一个 Provider step 中并行执行多个已预授权的 `research.search/fetch`，但每个结果都要独立计数、落研究来源事实并按 Provider call ordinal 回传；文档变更必须在模型收到研究结果后的后续 step 中串行执行，同一 step 最多一个文档写调用，且整个任务仍只能有一个主要文档产物。任何研究调用失败、取消或超限都不能触发尚未授权的补偿写入。

`research.search` 结果只返回有界的 `sourceHandle/title/site/canonicalUrl/publishedAt?/snippet/retrievedAt`；`research.fetch` 结果只返回同一来源元数据、`contentHash`、有界正文、截断状态和提取器版本。工具结果不得包含搜索凭据、请求头、Cookie、原始 HTML、脚本、远程媒体、重定向链中的敏感参数或 Provider 原始响应。

Worker 把可信执行上下文拆为两个时点，避免在 Provider 尚未返回 function call 前伪造 `toolCallId`：

```text
TrustedToolAuthorization（Provider 请求前持久化）
- authorizationId / opaque authorization handle
- projectId / projectSessionId / conversationId
- taskId / generationId / attemptId / providerStepId
- targetDocumentId / scopeType / scopeId
- baseVersionId / expectedDocumentRowVersion
- policyVersion / toolSchemaVersion / allowedOperation
- expiresAt / maxCallUses

TrustedToolCallEnvelope（收到 Provider function call 后在 Worker 内派生）
- authorizationId
- providerStepId / providerCallId / toolOrdinal
- 上述授权字段的只读快照与 authorization hash
```

第一个对象对应 12.3 的 `agent_tool_authorizations`：Worker 先创建 Provider step 和预授权，再把仅对当前 Native Runtime 有效的不透明 handle 放入其受限运行时状态，不写入 Provider 请求，也不暴露给模型。第二个对象只在 Native Runtime 从该 step 的 Provider 事件解析出 call ID 和 ordinal 后生成；ToolGateway 原子校验 handle hash、授权状态/过期、step/attempt/task/projectSession 归属、操作白名单与一次性确认 token，再创建或重放 `agent_tool_calls`。`providerCallId` 只能来自当前已持久化 step 的协议解析，不能来自模型 arguments 或 Desktop IPC 字段。

取消、任务终态、项目会话变化、授权过期和恢复时的归属不一致都撤销预授权；恢复不复用旧 handle，而是以最后一个已持久化 step/call 重新校验后按需签发新的 step-local 授权。模型不能提供、覆盖或通过同名嵌套字段影响任何可信值；发现伪造字段时返回 `UNTRUSTED_EXECUTION_FIELD` 并记录只含 envelope hash 的安全事件。

本文其余“可信执行信封”均指上述“请求前预授权 + 收到 Provider call 后绑定”的两阶段合同，绝不表示在 Provider 请求前已知或持久化 call ID 的单一对象。

创建/更新工具返回：

```text
documentId
documentVersionId
status = draft
reviewRequired = true
```

工具描述必须明确：

- list/read 只能访问当前项目中 Worker 授权的有界资料，不能枚举文件系统；
- research.search/fetch 只用于只读外部研究，来源内容是不受信数据而不是系统指令；fetch 只能读取 Worker 签发的来源句柄；
- create/update 只能创建或更新草稿；
- archive/restore 只在原始用户消息明确授权且目标唯一时可用；已发布/关键引用归档需要用户确认 token；
- 不会发布正式资料；
- 不能写入任意路径；
- 内容需要用户审核；
- 不能把工具返回的草稿当作已确认事实。

每个创建/更新任务只允许第一次成功写工具建立主要文档产物。后续写工具只能在同一任务和同一目标文档上修订该产物；尝试创建第二个主要文档返回 `TASK_PRIMARY_ARTIFACT_ALREADY_EXISTS`。查询、归档和恢复任务不建立主要文档产物。

### 13.2 Desktop-Worker IPC

Agent 任务合同：

```text
agent.task.create
agent.task.get
agent.task.list
agent.task.events
agent.task.artifacts
agent.task.cancel
agent.task.retry
agent.task.confirm
agent.task.reject
```

`agent.task.confirm`/`agent.task.reject` 只接收 Worker 可定位的 confirmation ID、一次性 token 和 `expectedTaskRowVersion`；不得接收工具名、Provider call ID、ordinal、authorization、目标 ID、版本、reason 之外的可信执行字段。它们始终读取已保存的原始 call 和确认事实，确认后的内部执行不作为另一个 Desktop IPC 暴露。

文档 CRUD 和工作流合同：

```text
document.createDraft
document.get
document.list
document.draft.save
document.archive
document.restoreArchived
document.purge
document.review.submit
document.review.requestChanges
document.review.reject
document.selfPublish
document.versions
document.restoreVersion

context.preview (增加 includeDraftIds，可选)
```

`document.restoreVersion` 以选中历史版本为来源创建新的 draft 版本，不原地修改历史记录，也不直接改变 `published_version_id`。`document.selfPublish` 是本地单用户唯一公开发布入口；底层审核批准和 publication 写入只能作为同一 Worker 事务的内部步骤。

所有新增 IPC 必须：

- 拒绝未知字段；
- 校验 UUID、作用域、版本号、枚举，以及文本的字符数和 UTF-8 字节数双上限；
- 携带 `projectSessionId` 或由 Worker 绑定当前项目运行会话；
- 携带 `expectedDocumentRowVersion` 或 `baseVersionId` 的写请求必须执行 CAS；
- 返回稳定错误码、可重试性和用户可见信息；
- 不返回凭据、完整工具原始请求或未脱敏 Provider 细节。

归档与 purge 规则：

- `document.archive` 可恢复，不删除文档、版本、审核、发布或任务事实；
- `document.restoreArchived` 只恢复生命周期，不自动恢复某个旧版本为工作头；
- `document.purge` 需要用户显式确认凭据、项目可写、文档已归档、引用检查、幂等事务和最小墓碑；
- 已发布记录默认不能 purge，除非未来维护 ADR 明确允许并提供完整引用迁移；
- `document.archive/restore` 仅在显式 AgentIntent、唯一目标和可信执行信封满足时临时加入 LLM Tool Registry；需要确认时先进入 `waiting_confirmation`，只能由 `agent.task.confirm/reject` 经 Worker 消费一次 token；`document.purge`、审核和 `document.selfPublish` 永不向 LLM 暴露。

现有 `document.save` 和 `chat.message.toDocument` 保留一个兼容周期：

- 旧调用自动创建草稿，不再直接改变 `published_version_id`；
- Desktop 改用新的草稿/审核/发布合同；
- 兼容期结束后移除直接正式写入语义，并同步更新 M2、M3 和启动文档。

### 13.3 不支持工具模型的行为

Agent 模式模型门禁为 `text && streaming && tools`。缺少任意一项时：

1. 普通文本生成仍可用；
2. 普通聊天中的回答仍允许用户执行“创建草稿”显式提升操作；
3. 需要自动产生草稿的 Agent 创作模式不得启动，UI 必须提示用户选择同时支持文本、流式和 tools 的模型；
4. Worker 只能在用户显式提升普通回答时以消息内容创建草稿，并继续经过编辑器审核；
5. 不解析模型输出中的伪工具标签、Markdown 指令或 JSON 约定；
6. 不得把 Agent 创作任务静默降级为普通文本回答或手工保存流程。

`structuredOutput` 不参与该门禁。Provider 若支持，可用于其他 JSON 响应优化，但不能替代 tools，也不能作为拒绝一个具备 `text && streaming && tools` 模型的理由。

### 13.4 安全默认资源上限

集中配置必须同时提供安全默认值和不可被普通项目设置突破的硬上限：

| 资源 | 安全默认值 | 硬上限 |
|---|---:|---:|
| 标题 | 200 Unicode 标量值 / 800 UTF-8 字节 | 相同 |
| 文档正文 | 200,000 Unicode 标量值 / 1 MiB UTF-8 | 相同 |
| 单工具聚合 JSON | 4 MiB，独立于单个 SSE 事件缓冲 | 4 MiB |
| 单 step 输入 Token | `min(96,000, 模型窗口的 70%)` | `min(256,000, 模型声明窗口减安全余量)` |
| 单 step 输出 Token | `min(16,384, 模型最大输出)` | `min(65,536, 模型最大输出)` |
| 单任务累计 Token | 256,000 | 512,000 |
| 单任务估算费用 | 2 USD 或项目配置的等值币种 | 10 USD 或管理员级配置 |
| Provider steps / Schema 修复 | 8 / 2 | 16 / 2 |
| 单 Provider step 工具调用 | 4 | 8 |
| 单 Agent task 工具调用 | 16 | 32 |
| `research.search` 调用 / task | 3 | 6 |
| `research.fetch` 调用 / task | 8 | 16 |
| 搜索结果 / call | 5 | 10 |
| 提取正文 / source | 100,000 Unicode 标量值 | 500,000 Unicode 标量值 / 2 MiB UTF-8 |
| 研究网络累计等待 / task | 120 秒 | 300 秒 |
| 单任务运行时长 | 10 分钟 | 30 分钟 |

价格未知时不能伪造费用估算，必须以 Token 硬上限继续保护并标记 `costUnavailable=true`。研究工具的专用额度同时计入 Provider step、任务工具调用、Token 和总运行时长；单项额度较高不放宽任何聚合硬上限。超限分别返回 `AGENT_INPUT_TOKEN_LIMIT`、`AGENT_OUTPUT_TOKEN_LIMIT`、`AGENT_TOTAL_TOKEN_LIMIT`、`AGENT_COST_LIMIT`、`TOOL_ARGUMENT_BYTES_EXCEEDED`、`TOOL_CALL_LIMIT_EXCEEDED` 或 `RESEARCH_BUDGET_EXCEEDED`；不得截断后继续执行写入工具。

## 14. LLM 上下文规则与 Token 预算

### 14.1 来源优先级

```text
生产约束
> 已发布权威资料
> 项目记忆
> 已核验外部研究来源
> 相关会话
> 模型既有知识（仅用于创意和检索方向，不作为实时来源）
> 未审核草稿（仅显式引用）
```

文档不再通过标题包含“大纲/计划”来决定权威优先级。优先级由来源类型、发布状态、作用域、显式关联和相关性决定。外部来源不能覆盖项目生产约束；同一事实发生冲突时必须保留各来源及冲突状态，不得仅按搜索排名静默选择。模型既有知识可以帮助构思和选择检索词，但时效、争议或关键事实没有来源证据时必须标记为未核验。

### 14.2 作用域

- 项目会话：项目级已发布资料；
- 场次会话：项目级资料 + 当前场次已发布资料；
- 镜头会话：项目级资料 + 所属场次资料 + 当前镜头资料；
- 其他场次和镜头不进入上下文；
- 草稿只有在当前任务显式引用时进入，并标记为候选资料；
- 外部研究来源只进入产生它的 task/attempt 的追加式 research manifest；发布前不会自动变成项目记忆或权威资料。

### 14.3 预算

上下文预算必须根据所选模型的真实上下文窗口动态计算：

```text
可用资料预算 =
模型上下文上限
- 系统指令
- 用户请求
- 工具定义和工具结果
- 预计输出 Token
- 安全余量
```

实施要求：

- 模型目录增加上下文窗口和最大输出 Token 能力；
- 生产约束不得因预算被静默裁剪；
- 长文档可生成确定性摘要，但快照只记录原始/摘要版本 ID、hash、字符/Token 数和摘要策略，不复制原始或实际发送正文；
- 工具调用参数和结果也占用预算，需要纳入估算；
- 外部研究单独预留搜索摘要、抓取正文和引用元数据预算；超预算时优先减少结果数、排除低相关来源或使用确定性提取摘要，不得裁剪生产约束或隐藏来源冲突；
- 预算不足时返回 `CONTEXT_BUDGET_EXCEEDED`，不创建半完成正式资料；
- 任务页展示来源数量、估算 Token、裁剪状态和模型窗口。

### 14.4 上下文审计 manifest

每个 generation/attempt 使用的 manifest 至少能够回答：读取了哪些来源及版本、哪些被排除、每项 hash 是否一致、原始和纳入字符/Token 数、采用了什么摘要/裁剪策略、使用哪个编译器/策略版本以及预算如何分配。

manifest 不能回答项目正文或完整网页正文本身；项目正文仍从文档版本、记忆、约束和会话事实表按权限读取，外部正文从受限研究缓存按 content hash 读取。research manifest 追加记录检索/抓取调用、来源元数据、采用/排除原因、引用标签、内容 hash、提取/截断状态和预算，不改变任务开始前的基础上下文快照。Provider 请求 hash、工具 Schema hash 和系统指令模板版本可以进入 manifest，但完整请求、完整工具定义和渲染后的上下文不得进入。v14 起新增写入必须通过正文泄漏检测，legacy v13 快照按 12.5 的兼容策略清理。

## 15. 编辑器、浮窗和并发编辑

Worker 是唯一持久化写入者。主窗口按 `projectId + documentId + windowLabel` 管理独立窗口的临时编辑缓冲；同一文档只允许一个系统窗口，不同文档可并行打开。子窗口只渲染快照并转发动作，不能直接写 SQLite。

快照与动作必须携带项目、实体、稳定窗口标签和递增序号；子窗口丢弃旧序号或实体不一致的快照，主窗口拒绝未注册、跨项目或跨实体动作。主界面切换当前文档时，只同步同一实体的窗口，不得覆盖其他已打开文档的正文。

保存请求必须包含：

```text
documentId
baseVersionId
expectedDocumentRowVersion
title
scope
contentMarkdown
```

并发规则：

- 版本指针 CAS 成功：创建新工作版本；
- CAS 失败：返回 `DOCUMENT_EDIT_CONFLICT`，保留双方版本；
- UI 显示差异，用户选择重新加载、覆盖或合并；
- 禁止使用“读取最大版本号 + 1”作为唯一并发控制；
- 自动保存失败不得把当前 UI 标记为已保存；
- 独立窗口关闭不删除草稿、不取消 Agent 任务。

发布冲突规则：

```text
candidate.base_version_id != documents.published_version_id
    -> DOCUMENT_BASE_CONFLICT
    -> 打开差异比较
    -> 用户合并或基于最新权威版本重新生成
```

## 16. 任务日志页面

### 16.1 统一展示模型

任务日志页面由 `TaskLogQueryService` 生成统一 DTO，不要求底层任务表合并：

```text
TaskLogItem
- id
- projectId
- category: agent | image | video
- title
- status
- outcome
- scopeLabel
- sourceConversationId?
- sourceDocumentId?
- sourceShotId?
- modelLabel?
- startedAt
- updatedAt
- completedAt?
- error?
- artifactCount
- providerStepCount?
- usageSummary?  -- input/output/reasoning/total Token 和费用摘要
```

映射规则：

- Agent 任务读取 `agent_tasks`；
- LLM generation 作为 Agent 任务的明细步骤，不单独重复显示为任务；
- 图片和视频读取现有 `generation_jobs` 及其结果；
- 普通会话 generation 没有关联 Agent 任务时不进入任务列表，但仍可从会话查看；
- 失败任务保留，不能进入素材库成功结果。

### 16.2 页面功能

- 按类别、状态、作用域、时间、关键词筛选；
- 展示任务状态时间线和错误原因；
- 默认展示使用的模型、耗时和 Token/费用摘要，Provider step、原始 usage 差异和费用明细按需展开；
- 展示读取的上下文来源版本；
- 从 Agent 任务打开文档草稿或正式版本；
- 从图片/视频任务打开素材和来源镜头；
- 支持取消、重试、继续审核和查看差异；
- 任务详情支持跳转到原始会话；
- 所有操作保持项目隔离和只读模式边界。

### 16.3 任务事件

建议事件类型：

```text
agent.task.created
agent.task.started
agent.context.snapshotted
agent.generation.started
agent.provider_step.started
agent.provider_step.completed
agent.provider_step.failed
agent.generation.completed
agent.tool.requested
agent.tool.validated
agent.tool.executed
document.draft.created
document.draft.revision_created
document.draft.ready_for_review
document.review.requested
document.review.changes_requested
document.draft.rejected
document.archived
document.archive_restored
document.purged
document.self_reviewed
document.publish.conflicted
document.published
agent.task.completed
agent.task.failed
agent.task.cancelled
```

事件 `summary` 面向用户；详细 `payload_json` 仅保存必要的有界字段。完整 Markdown 正文通过文档版本查询，不重复写入事件。

## 17. 错误与故障恢复矩阵

| 场景 | 处理 | 用户行为 | 是否产生正式资料 |
|---|---|---|---:|
| 项目只读 | 拒绝任务创建/草稿写入，返回 `PROJECT_READ_ONLY` | 切换可写项目或仅查看 | 否 |
| 普通聊天模型不支持工具 | 普通文本回答，显示能力提示 | 用户可显式从回复创建草稿 | 否，除非审核发布 |
| Agent 创作模型不支持工具 | 创建 generation 前返回 `MODEL_TOOLS_REQUIRED` | 选择支持 tools 的模型 | 否 |
| 工具 JSON 无效 | `TOOL_SCHEMA_INVALID`，不执行 | 修改请求或重试 | 否 |
| 工具作用域越权 | `SCOPE_MISMATCH`，记录安全事件 | 重新选择作用域 | 否 |
| 模型伪造可信 ID/CAS 字段 | `UNTRUSTED_EXECUTION_FIELD`，工具不执行并记录安全事件 | 检查 Provider/提示词或重试 | 否 |
| Agent 未经明确意图请求归档/恢复 | `TOOL_NOT_ALLOWED`，记录安全拒绝 | 由用户明确说出目标和动作 | 否 |
| 归档已发布或关键引用文档 | `DOCUMENT_ARCHIVE_CONFIRMATION_REQUIRED` | 用户确认影响后重试 | 否 |
| 幂等键重复且参数相同 | 返回第一次任务和产物 | 继续查看 | 不重复 |
| 幂等键重复但参数不同 | `IDEMPOTENCY_KEY_REUSED` | 使用新幂等键 | 否 |
| LLM 失败且无草稿 | 任务 `failed`，保留 generation 证据 | 重试任务 | 否 |
| LLM 失败但草稿已落盘 | 任务 `waiting_review`，追加 warning | 审阅草稿或重新生成 | 否 |
| 编辑 CAS 冲突 | `DOCUMENT_EDIT_CONFLICT` | 查看差异并合并 | 不覆盖 |
| 发布基础版本冲突 | `DOCUMENT_BASE_CONFLICT` | 基于最新权威版本合并 | 不覆盖 |
| Worker 重启 | 重建任务和 generation 状态，活动任务转 `failed` 或恢复策略指定状态 | 查看任务日志并重试 | 不产生隐式发布 |
| 独立窗口关闭 | 仅关闭视图，业务状态继续 | 重新打开或附加 | 不改变 |
| 上下文超预算 | `CONTEXT_BUDGET_EXCEEDED`，约束不丢失 | 缩小范围或提高预算 | 否 |
| 任务需要联网但无已验证 Research Adapter | `RESEARCH_PROVIDER_REQUIRED`，不把模型记忆伪装为搜索 | 配置并验证研究服务，或显式改为仅项目资料 | 否 |
| 外部搜索失败或暂时不可用 | `RESEARCH_SEARCH_FAILED`，保留已完成研究事实并标记可重试性 | 重试、缩小查询或改为仅项目资料 | 否 |
| 来源 URL、重定向或解析地址越过网络边界 | `RESEARCH_FETCH_BLOCKED`，不发起/继续请求并记录脱敏安全事件 | 更换公开来源 | 否 |
| 来源正文超过提取硬上限 | `RESEARCH_SOURCE_TOO_LARGE`，不把截断内容伪装为完整来源 | 选择更小页面或允许明确标记的有界摘要 | 否 |
| 搜索/抓取次数、网络时间或研究正文超预算 | `RESEARCH_BUDGET_EXCEEDED`，停止新增研究调用 | 缩小范围后重试 | 否 |
| 外部来源互相冲突或证据不足 | 保留来源与冲突状态；关键事实标记未核验，必要时停止创建事实型草稿 | 补充来源或接受带证据状态的草稿 | 否，除非后续审核发布 |
| 数据库事务失败 | 全部回滚，记录可重试错误 | 重试 | 不产生半条记录 |
| selfPublish 任一步失败 | 审核、批准、publication、指针、任务和审计全部回滚 | 解决冲突后重试 | 否 |
| purge 存在受保护引用 | `DOCUMENT_PURGE_BLOCKED`，不删除任何记录 | 查看引用或保留归档 | 否 |
| 工具调用超时 | 任务进入 `failed` 或可恢复状态 | 重试，不重复执行已成功调用 | 依据已提交产物 |
| 取消与工具提交并发 | 以 task `row_version` CAS 决定唯一赢家 | 查看取消结果或已提交产物 | 不产生半提交 |
| Token/费用/工具 JSON 超限 | 返回对应 `AGENT_*_LIMIT` 或 `TOOL_ARGUMENT_BYTES_EXCEEDED` | 缩小范围或调整受控配置 | 否 |

## 18. 安全、隐私与数据保留

- LLM 工具只能使用固定白名单，不提供任意文件读写、命令执行和 SQL 工具；
- 所有工具参数和结果执行长度限制、字符串清理和 JSON Schema 校验；
- P3.2 网络请求只由独立 Research Adapter 经 Native 受控网络桥执行；Worker 和模型都不能直接发起任意 HTTP 请求，未通过真实冒烟的 adapter/route 默认关闭；
- 每次抓取在初始 URL、每次重定向、DNS 解析后和连接前重复校验目标，拒绝 loopback、private、link-local、保留地址、IPv4-mapped IPv6、非公网 DNS 结果、DNS rebinding、云元数据地址、带凭据 URL、非允许端口和内网主机名；重定向次数、响应时间、MIME、压缩后/解压后大小均受硬上限约束；
- 默认只允许公开 `https`；如兼容公开 `http`，必须由 adapter 明确声明并执行相同网络边界校验，禁止降级重定向绕过。只提取允许的文本 MIME，不执行远程脚本、样式、表单、下载、媒体、iframe 或浏览器会话；
- 外部网页、搜索摘要、页面元数据和 robots/站点文本始终是不受信数据，只能作为引用内容，不能修改系统指令、工具授权、来源策略或要求模型泄露上下文；提取层隔离疑似提示注入，Provider 提示明确要求忽略其中的操作性指令；
- 搜索 query 遵循最小披露：不得把完整私有项目上下文、未发布正文、凭据或个人敏感信息发送给研究服务；需要检索时先生成最小关键词，长期只保存 query hash 和有界元数据；
- 研究请求不携带浏览器 Cookie、登录态或项目凭据；凭据只存在桌面凭据存储，SQLite 仅保存 handle/adapter 元数据。规范 URL 去除用户名密码、签名参数和非必要跟踪参数，来源缓存及诊断导出不得包含请求头或认证材料；
- Markdown 预览默认禁用 raw HTML，不执行内联脚本、事件属性、iframe、object、embed 或 style；
- 链接只允许显示 `http/https`，打开外部链接必须经过应用受控跳转；拒绝 `javascript:`、`file:`、`data:`、`vbscript:` 和未知自定义 scheme；
- 图片、音频和视频不得自动请求远程 URL；只允许经过项目资产仓储验证的应用内 asset/blob 协议，远程媒体显示占位符并由用户显式打开；
- Desktop WebView CSP 默认禁止远程 `script-src/connect-src/img-src/media-src`，预览渲染器不得以 Markdown 内容扩展 CSP；
- 日志、任务事件、Provider steps 和上下文快照不得保存 API Key、签名 URL、完整 Base64、绝对路径、完整 Provider 凭据、完整 Provider 原始响应或完整拼接上下文；
- 任务页默认展示摘要，完整正文通过权限受控的文档查询获取；
- 任务事件作为项目数据库生命周期内的长期业务审计保留；任务、generation、attempt、step、tool call 和 event 只逻辑归档，普通维护不得硬删除或级联删除证据；
- v14 起禁止新快照保存正文；legacy 快照优先原位清理为 manifest，清理前必须备份并检查 generation、任务、版本和发布引用；
- Provider step 只保留 hash、usage、continuation manifest 和有界错误，完整工具参数正文和原始响应不得进入该表；
- purge 前保留最小审计墓碑，墓碑 Actor 必须是用户且不得包含正文；
- 项目备份包含 SQLite 业务数据，缓存和可重建摘要可按策略排除；
- 诊断导出默认不包含完整文档正文、完整上下文和任务参数；
- 当前单用户版本的 `*_by_type/*_by_id` 使用本地用户 Actor，但字段保留未来 principal ID 扩展空间。

## 19. 分阶段实施计划

### P0：冻结业务合同、ADR 和迁移边界

目标：在编码前锁定术语、状态、发布规则、错误码、输入上限和兼容策略。

工作项：

- 建立 Agent 任务状态机、文档双指针、幂等、工具安全和发布冲突 ADR；
- 冻结 Agent 模型门禁为 `text && streaming && tools`，`structuredOutput` 非必要；
- 冻结公开 Tool Schema 与可信执行信封边界，模型不得提供可信 ID、作用域和 CAS；
- 冻结创建/更新任务一主要产物、显式意图下的 Agent `list/read/create/update/archive/restore`、用户 purge 和原子 selfPublish；
- 冻结 generation/attempt 为完整工具循环、Provider step 为单次请求响应；
- 冻结文本、JSON、工具参数、Token、费用、事件和 manifest 的安全默认值与硬上限；
- 冻结任务事件长期保留、上下文 manifest 项目维护清理和 legacy 正文清理规则；
- 确定普通问答与持久化 Agent 任务的识别规则；
- 明确 `kind` 兼容期和移除时间；
- 更新 M2、M3、PROJECT-STARTUP 文档中的旧“直接保存正式文档”描述。

产物：

- 本文档审核版；
- ADR：Agent 任务状态机、文档发布模型、工具调用安全、幂等策略；
- 错误码表、输入限制表、状态转换矩阵；
- Schema v13 真实快照和 v14 delta：Provider steps、归档字段、审计动作、purge 墓碑和 manifest 兼容治理。

退出门禁：所有状态都有合法前置、触发、持久化位置、终态和用户行为；第 23 节无待决策项；无“先实现后补状态”的路径。

### P1：Agent 任务、事件和工具调用持久化

目标：建立任务事实源，不改变当前普通 LLM 生成行为。

工作项：

- Schema v12 已新增 `agent_tasks`、`agent_task_generations`、`agent_tool_calls`、`agent_task_events`；本阶段以回归和恢复验证为主，不重复迁移；
- `packages/persistence/src/database.ts` 增加专用 `runV14Rebuild`，不把父子表重建塞进普通 `database.transaction`/单条 migration string；`packages/persistence/src/schema.ts` 提供影子表、复制、swap、索引/触发器重建定义；
- Schema v14 重建 task type/outcome CHECK，将 v13 `version` 无损迁移为唯一 task `row_version`，增加逻辑归档和任务证据 RESTRICT 外键；
- 持久化任务/Provider step 工具调用计数和上限；在工具副作用前用任务 CAS 原子预留配额，重放不重复计数；
- Schema v14 新增 `agent_task_document_artifacts`，用具体 document/version FK 表达唯一 primary artifact，并将 `agent_task_document_versions` 保留为只读 legacy 历史证据和确定性迁移投影来源；
- Schema v14 新增 `llm_provider_steps` 及 attempt/generation 复合 FK，每个 generation/attempt 保存完整工具循环，每个 step 保存一次 Provider 请求响应的协议、hash、usage 和恢复信息；
- Schema v14 新增 step-local `agent_tool_authorizations`；重建 `agent_tool_calls`，以预授权/step/ordinal 和 scoped Provider call 关联替代旧二元去重，并用严格摘要字段替换会持久化正文的原始参数/结果 JSON；
- Schema v14 新增 `agent_task_confirmations`，将高影响 Agent 操作的 `waiting_confirmation`、token 消费、确认/拒绝和重新授权持久化；Provider/manual 路径互斥约束与事务内唯一冲突重读必须在工具副作用前生效；
- Domain、Repository、Contracts 增加限定类型；
- Worker 增加任务创建、查询、状态转换、事件追加、幂等和重启恢复；
- 将任务与现有 `llm_generations` 通过关联表连接；
- 新增运行时 Schema 和稳定错误码；
- attempt Token/费用由 complete steps 汇总，保存 Provider 报告值与校验差异；
- 只读、项目会话和跨项目校验覆盖所有入口。

测试门禁：v13 -> v14 迁移、新库创建、旧任务 `version` 到唯一 `row_version` 无损回填、完整入站 FK 闭包 swap 与 `sqlite_master` 不残留 `__v13_old_*` 引用、primary artifact FK/唯一性/legacy 历史投影、草稿修订/changes-requested/publish/reject/discard 的 artifact CAS 投影、Provider step ordinal/复合 FK/usage 汇总、预授权 handle 过期/撤销/跨 step 重放、confirmation pending/confirm/reject/过期/双窗口 CAS、token 单次消费与无正文 descriptor、确认后仅恢复原 Provider call 且不创建伪 call、旧 tool-call index 删除、Provider/manual 互斥路径、原子插入冲突重读、正文脱敏迁移、每 step/每任务工具调用配额、同 step 并列调用计数竞争、重放不重复计数、tool call 与 task/step mismatch 拒绝、取消/工具提交 CAS 竞态、UI/Worker 中断恢复、重复幂等、终态不可逆、事件追加约束、跨项目拒绝和只读拒绝通过。

### P2：文档工作版本与权威版本模型

目标：在不污染 LLM 上下文的前提下支持草稿保存和版本审阅。

工作项：

- Schema v12 已增加文档双指针、版本状态、基础版本、来源字段、审核和发布表；Schema v13 已补充文档工作流审计；后续差异/分支字段从 v14 起规划；
- v12 迁移已将旧文档回填 `published_version_id=current_version_id`；
- `document.save` 改为工作版本保存或进入兼容适配层；
- 实现 `document.createDraft/get/list`、`document.draft.save`、`document.versions/restoreVersion` 和审核合同；
- 增加 CAS、版本哈希、标题/作用域快照和冲突错误；
- ContextService 改为读取 `published_version_id`；
- 删除标题启发式优先级；
- 移除 Desktop 文档类型下拉，旧 `kind` 仅内部兼容。

测试门禁：旧项目无损迁移、草稿不进入上下文、发布后可读取、版本恢复不覆盖、并发保存冲突、发布基础版本冲突和文档审计通过。

### P3：Agent 工具协议和安全执行网关

目标：让模型通过结构化工具完成受控文档查、增、改、归档和恢复，且不能发布或 purge。

工作项：

- 扩展 `packages/llm` 和 Tauri Responses/Chat Completions 适配，支持工具声明、工具调用事件和工具结果回传（当前尚未完成真实 Provider tool loop）；
- 对没有工具能力的 Provider 保留纯文本路径；
- Agent 模式只允许 `text && streaming && tools` 模型，`structuredOutput` 不作为门禁；
- 实现有界 `document.list/read`、只含创作内容的 `document.create_draft/update_draft`，以及仅在显式意图下开放的 `document.archive/restore` Schema；
- Worker 在 Provider 请求前持久化 step-local TrustedToolAuthorization，绑定任务、generation、attempt、项目会话、目标文档、作用域、基础版本、CAS、允许操作和过期时间；收到 Provider call 后才派生绑定 call ID/ordinal 的 TrustedToolCallEnvelope。授权 handle 只在当前 Native Runtime 中可见；归档确认 token 只在 `agent.task.confirm` 的事务中单次消费，确认续执行只读取无正文 descriptor；
- 实现完整 Provider tool loop、逐 step 持久化、continuation 恢复和工具结果回传；
- 严格执行“step-local 预授权/白名单 -> JSON 解析/一次规范化 -> 参数 hash -> 作用域去重 -> 事务内授权额度、配额和状态/CAS -> 写入”的顺序；
- 对调用、参数哈希、安全拒绝、执行结果和错误写入 `agent_tool_calls`/审计事件；长期记录只保存严格摘要、hash、长度、ID 和稳定错误码，原始正文仅存在于文档版本或短期受限内存；
- 工具结果不得直接改变发布指针。

测试门禁：list/read 句柄越权、预授权 handle 伪造/过期/撤销/跨 step 重放、archive/restore 显式意图与确认 token 单次消费、purge/发布拒绝、未知工具、额外字段、伪造可信 ID/CAS、创建/更新一任务一主要产物、同 call ID 同/不同 hash、每 step/任务配额与并列调用预留、取消竞态、工具超时、Provider step 续写/恢复、不支持 tools、恶意路径/SQL/HTML 输入、工具正文脱敏和工具结果重放通过。

#### P3.1：Provider 工具路由兼容性

目标：在不改变既有 Agent 任务、文档、普通聊天和已验证 Responses 路径的前提下，按 Provider 路由验证并逐项开放第三方模型的完整工具循环。

当前状态（2026-08-18）：代码门禁、本地自动化、UniCompAPI Chat Completions 协议冒烟和更新后桌面 Native Agent 文档草稿两轮工具链路均已完成。Worker 仅允许已登记且通过 transport 验证的 OpenAI Responses 或 UniCompAPI `gpt-5.6-sol` 路由进入 Agent tool loop，并在创建 generation、任务、文档和 Provider step 前分别校验模型 `text && streaming && tools` 与已验证 transport route；Native Runtime 对不匹配协议的 continuation 防御性拒绝。P3.1 仍保持进行中，原因是取消、重启恢复、安装包链路、真实 OpenAI Responses 冒烟和其他第三方路由尚未完成同等级验收。

工作项：

- 将“模型可调用 function”与“当前 Provider 路由可执行完整 tool loop”视为两个独立门禁：前者来自受控模型能力目录，后者由协议适配器、endpoint 和真实冒烟证据共同决定；不得仅因模型名称或文本能力推断可用。
- Worker 启动 Agent 时同时要求 `text && streaming && tools` 和 transport `toolLoop` 能力；任何一项缺失都稳定拒绝 Agent 请求，并保留普通聊天的纯文本路径，不得将显式草稿请求静默降级为普通聊天。
- 为每个可开放路由登记精确的 Provider profile、协议、endpoint、模型 allowlist、工具调用格式、工具结果续写格式和验证日期；默认关闭，只有通过端到端冒烟和回归后才开放。
- 当前 OpenAI Responses 路径是已验证基线。UniCompAPI 已登记精确路由 `unicompapi-chat-completions-gpt-5.6-sol-v1`：`https://unicompapi.com/v1`、`openai-chat-completions`、模型 `gpt-5.6-sol`；其他 UniCompAPI 模型仍不得进入 Agent allowlist。
- UniCompAPI Chat Completions 已单独实现并测试工具定义下发、`tool_calls` 分片聚合、`tool` 结果消息续写、usage 归一化和并行调用顺序保持；点号工具名在 Provider wire 层编码为 `__dot__` 并在 Native 执行前还原，continuation 重建时再次编码；不得复用 Responses 的 `function_call_output` 请求结构。桌面 Native 已验证两个 Provider step、调用 ID、usage 和草稿持久化，取消和重启不重放仍需独立实机验收。
- 不新增或回填既有 `agent_tasks`、Provider steps、授权、文档或项目数据库记录；新路由只影响新建 Agent generation 的选择门禁。关闭 allowlist 后，已完成任务保持可读，未启动任务明确拒绝。

验收门禁：已验证 Responses 路径回归成功；未列入 allowlist 的 UniCompAPI 模型被 Worker 拒绝且无任务/文档/Provider step 副作用；每个新路由都有真实 Provider 冒烟记录，覆盖工具定义、一次 function call、工具结果续写、两个以上 Provider step、usage、取消和重启后的不重放；普通聊天在所有拒绝路径中仍不创建 Agent 任务。

当前验收边界：官方 Responses 路由回归、UniCompAPI `gpt-5.6-sol` Chat Completions 真实协议冒烟、Worker/Native 路由门禁自动化和更新后桌面 Native Agent 文档草稿两轮工具链路通过；真实 OpenAI Responses 冒烟、安装包 Native 链路、取消/重启恢复人工演练及其他第三方路由仍未完成。精确 UniCompAPI 路由已开放给 Agent allowlist，但不得据此将整个 P3.1 标记为完成。

#### P3.2：Agent 主动外部研究与来源引用

目标：把项目上下文从“唯一允许来源”调整为“优先证据”，使显式 Agent 在资料不足、请求依赖时效信息或需要事实核验时，能够自主搜索、读取和引用外部来源，再创建可审核草稿。

当前状态（2026-08-19）：P3.2 仍在进行中。Contracts/Desktop/Worker 已贯通 `researchMode=auto|project_only|network_disabled`，用户可在主窗口和独立会话窗口选择并持久化模式；Worker 已注册 `research.search/fetch`，使用 `bing-html-public-v1` 完成搜索、任务/attempt 绑定的不透明来源句柄、受控 HTTPS 抓取、正文提取、内容 hash、项目本地缓存、并行只读工具调用和后续文档写入隔离。Schema v19 已持久化稳定 `R1..Rn` 引用、版本来源关联、缓存索引与 TTL/容量/缺失治理；任务详情可展示脱敏来源元数据、采用状态、截断和缓存状态。Schema v18 的工具预算与 Fake-IP DoH 防护保持有效。Bing 真实搜索/抓取冒烟和“UniCompAPI LLM transport + Bing 真实研究 + 单一草稿 + 编辑器自动打开”的桌面 Native 人工验收均已通过。Worker 到 Native 的请求 ID/取消注册表/WinHTTP 分段取消已加入并通过 Rust/Worker 回归；UniCompAPI 仍只承担 LLM function-calling transport，不等于托管网页搜索。崩溃后 in-flight 恢复、真实研究/安装包链路尚未完成，因此 P3.2 不得标记完成。

工作项按以下顺序实施：

##### P3.2a：研究合同、Provider 抽象和提示策略

状态：部分完成。研究模式合同、严格工具 Schema、只读授权、研究系统提示和用户模式选择已实现；独立 registry、凭据型 adapter 与完整稳定错误合同仍待补齐。

- 在 Contracts/Domain 定义 `researchMode=auto|project_only|network_disabled`、Research Adapter 能力、来源 DTO、稳定错误码、预算和 research manifest；显式 Agent 默认 `auto`，用户限制优先于模型判断；
- 在 Worker 增加独立 Research Provider registry，adapter 以精确 provider/profile/endpoint/能力/验证日期登记，凭据仅通过桌面凭据 handle 解析；
- 更新系统提示：先使用项目高优先级资料，再判断是否需要外部研究；外部内容是不受信数据，模型知识不能冒充实时检索，关键外部事实必须携带来源标签；
- 冻结 `research.search/fetch` 严格 Schema、只读授权、URL/网络边界、查询最小披露和资源硬上限。

##### P3.2b：只读搜索/抓取循环和 v17 证据

状态：Worker 功能切片和桌面真实闭环完成，Native 研究桥基础实现已完成。Bing HTML adapter、安全抓取、正文缓存、v17 来源事实、v18 默认 16/硬上限 32 的任务配额、search 3/fetch 8 专用预算、文档操作预留、单 step 最多 8 个并行只读调用、受控预算耗尽、研究/文档混合 step 拒绝和 search -> fetch -> draft 自动化已实现；v19 已补齐缓存 TTL/容量/缺失治理。Native 桥令牌、公开 URL/DNS/MIME/响应上限和无桥 fail-closed 已有回归，取消/重启恢复完整语义仍待补齐。

- 实现 Native 受控网络桥和至少一个具体 Research Adapter；搜索返回不透明 `sourceHandle`，抓取仅接受搜索结果或 Worker 对用户显式 URL 校验后签发的 handle；Native 桥已提供一次性 loopback 端点和进程级令牌，正式 Worker 无桥时拒绝联网；
- 实现搜索、重定向/DNS/SSRF 校验、正文提取、规范 URL、内容 hash、短期本地缓存和 `agent_research_sources` v17 持久化；
- 扩展 Provider loop，允许多个并行只读研究 call，按 ordinal 独立记账和回传；研究结果到达前禁止执行文档写工具；
- 取消、超时、Worker 重启或缓存缺失时不得重复文档副作用，也不得把旧内容宣称为本次重新验证结果。

##### P3.2c：来源感知起草、引用和界面

状态：部分完成。跨 search/fetch step 稳定且唯一的 `R1..Rn` 引用合同、草稿版本来源关联、未知引用副作用前拒绝和任务详情来源 UI 已完成；编辑器级来源面板以及缺失/冲突引用提示仍待完成。

- 将采用的来源按独立 research manifest 注入后续模型 step，要求事实型内容使用稳定引用标签，并在草稿版本上关联来源；
- 在 Agent 任务详情展示研究状态、来源标题/站点/检索时间、采用/排除原因、截断和冲突/证据不足状态；不展示搜索凭据、原始 HTML 或完整私有 query；
- 编辑器展示可点击来源列表和缺失/冲突引用提示；新草稿仍沿用终态刷新与自动打开逻辑，不因研究步骤改变主要文档唯一性；
- 支持用户显式“仅项目资料/禁止联网”，并在任务详情中显示实际采用的研究模式。

##### P3.2d：恢复、安全和真实 Provider 验收

状态：部分完成。单元/集成测试已覆盖私网阻断、task/attempt 句柄隔离、受限正文、并行搜索、并行抓取、受控预算耗尽、研究后单一草稿、Fake-IP 二次公网解析、Native 桥令牌/公网 URL/响应上限和无桥 fail-closed；真实 Bing 搜索/抓取冒烟和 UniCompAPI 桌面 Native 完整研究起草链路已通过。通用 DNS rebinding、压缩炸弹、敏感 query、Native 请求取消贯穿、崩溃后 in-flight 恢复、缓存丢失和安装包链路仍待验收。

桌面人工验收证据：任务 `cfdd4547-456a-433b-907b-e86b904cf674` 使用 `UniCompAPI / gpt-5.6-sol`，按 3 个 Provider 研究 step 完成 3 次 search、2 次 fetch，随后成功执行 `document.create_draft` 并以 final stop 结束，共使用 6/16 次工具额度；只产生一个文档 `ffe1cdba-58f1-4ef5-abe6-bc5a7d5ab157`，标题为 `P3.2 真实研究验收-联网成功`、正文 879 字符，包含两个实际抓取 URL，任务状态为 `waiting_review`，Desktop 自动在编辑器中打开该草稿。全过程未输出桌面端凭据或网页正文。

- 完成 SSRF、DNS rebinding、重定向、超大/压缩炸弹、非文本 MIME、提示注入、隐私 query、缓存越界和凭据泄漏测试；
- 完成取消、超时、断流、重启、缓存丢失、重复 call 和并行研究顺序恢复，不重复搜索计数或文档写入；
- 对选定 Research Adapter 执行脱敏真实冒烟，覆盖搜索、抓取、无结果、无效凭据、被阻断 URL、限流、超时和来源引用一致性；记录环境、adapter 版本、响应事实和未验证边界；
- 只有契约、自动化、安全测试和真实冒烟全部通过的精确 adapter route 才能进入 allowlist；关闭 route 后既有来源事实保持可读，新任务明确失败或按用户选择使用 `project_only`，不能静默用模型记忆替代。

验收门禁：基础项目上下文冻结不变；`auto` 模式可完成“项目资料 -> 搜索 -> 并行抓取 -> 来源结果回传 -> 单一草稿写入 -> 最终回复”的多 step 闭环；`project_only/network_disabled` 零网络请求；引用能定位同 attempt 的来源事实；来源冲突和证据不足可见；SSRF/提示注入/敏感 query 被副作用前拒绝；取消和重启不重复文档写入；具体 Research Adapter 的脱敏真实冒烟通过。

### P4：会话触发文档草稿和编辑器闭环

目标：用户在会话中要求生成项目文档后，系统自动创建草稿并打开编辑器。

工作项：

- 已增加用户显式“创建文档草稿”入口并完成真实 Provider tool loop；自动意图识别仍待实现；
- 生成开始时保存任务、上下文 manifest、generation、attempt 和用户消息关联；
- 工具成功后创建唯一主要文档工作版本和任务产物；多文档请求拆成关联任务；
- 会话显示任务卡：执行中、待审核、失败、已发布；
- Agent 进入终态后刷新文档列表，检测新增文档 ID 并自动在编辑器中打开草稿；支持标题、正文、作用域编辑；
- 同一文档的应用内浮窗和独立窗口共享一条 Worker 保存链路；不同文档的独立窗口按实体隔离；
- 关闭、重载、Worker 重启和项目切换不丢草稿。

测试门禁：项目/场次/镜头会话触发、草稿自动打开、浮窗/独立窗口互斥状态、关闭窗口、刷新恢复、任务卡和源会话定位通过。

### P5：审核、发布、上下文和冲突治理

目标：建立正式资料发布闭环，保证 LLM 只读取权威版本。

工作项：

- 增加编辑器差异视图和审核操作；
- 已实现保存草稿、提交审核、要求修改（`changes_requested`）和基础发布；v14 将公开发布入口收敛为原子 `document.selfPublish`；
- selfPublish 在单一事务创建 pending 自审、批准、publication、权威指针、版本状态、任务结果和有序审计；
- 实现 UI 与受控 Agent 共用的 `document.archive/restoreArchived`，以及仅用户显式确认的 `document.purge`；已发布/关键引用归档先要求用户确认，默认禁止 purge 已发布文档；
- 文档保存、恢复、审核、selfPublish、归档、恢复归档和 purge 写入独立有界审计；purge 另保留最小墓碑；
- 发布前执行基础版本冲突检查；
- `context.preview` 展示权威来源、草稿引用和预算，但持久化只保存 manifest；
- 动态计算模型上下文预算，预留工具和输出 Token；
- 任务失败、部分草稿、重复发布和发布冲突有稳定 UI 行为。

测试门禁：selfPublish 每一步故障注入和全事务回滚、审阅拒绝不算系统失败、基础版本冲突、archive/restore/purge 权限与引用约束、权威上下文隔离、manifest 正文泄漏检测、Token 预算、生产约束完整性和失败恢复通过。

### P6：统一任务日志页面

目标：提供可查询、可定位、可恢复的任务中心。

工作项：

- Worker 增加统一任务查询 DTO 和分页/筛选合同；
- `task.log.list` 已支持 `kind/status/cursor` 分页并返回 `nextCursor`，Desktop 已增加类型/状态筛选和加载更多；
- Desktop 任务日志每 30 秒静默自动刷新，不打断当前详情；
- 聚合 Agent、图片和视频任务，不改变各领域底层状态机；
- Desktop 已新增任务日志工作区并复用现有工作区框架；Agent 任务详情支持状态、错误、事件时间线和文档产物，图片/视频条目显示基础来源；独立任务日志窗口入口尚未完成；
- 模型、Token、费用摘要已默认展示；Provider step 详情按需展开；上下文来源、来源跳转和图片/视频完整详情仍待补齐；
- Agent 文档任务可打开草稿/正式文档和来源会话；
- 图片/视频任务可查看完整任务详情、请求参数摘要和落盘产物；
- 支持取消、重试、继续审核和冲突处理；
- 任务日志与素材库双向定位，不把失败任务写入素材库。

测试门禁：多类别统一排序、筛选分页、项目隔离、任务/素材双向定位、重启恢复、空状态、长列表性能和窗口布局通过。

### P7：结构化场次/镜头提案扩展

目标：在文档工作流稳定后，让 Agent 生成场次和镜头提案，但仍不能直接改正式记录。

工作项：

- 为 `scenes`、`shots` 增加版本/CAS；
- 新增 `agent_change_sets`、`agent_change_set_items`；
- 支持 `scene.create`、`shot.create`、`scene.update`、`shot.update` 提案；
- 在编辑器中展示结构化差异和批量批准；
- 用户批准后在一个事务中应用场次、镜头和关联文档变更；
- 失败、部分批准和重新生成保留原提案，不污染正式表。

2026-08-19 实施记录：Schema v26 为 `scenes`、`shots` 增加 `row_version`，新增带项目/任务边界和父项约束的 `agent_change_sets`、`agent_change_set_items`；Schema v27 扩展 `agent_change_set_items` 的 `document` 类型和文档 create/update 提案字段。Worker 暴露 `agent.changeSet.create/list/apply/reject`，支持 scene/shot/document create/update、父级场次提案依赖、选定 item 部分应用/拒绝、文档与场次/镜头在同一 SQLite 事务中原子应用、文档 row-version/current-version CAS 冲突整批回滚和冲突标记；Desktop `shots` 工作区新增结构化差异审阅面板，可逐 item 勾选批准/拒绝并显示冲突。Persistence 22 项、Worker 211 项、Desktop 116 项、全仓 `pnpm.cmd test`、`pnpm.cmd typecheck`、`pnpm.cmd lint`、`pnpm.cmd format:check`、`pnpm.cmd build`、`git diff --check` 通过。真实 Windows 多窗口并发、跨场次人工验收和安装包链路仍保持 HOLD。

退出门禁：跨场次误写、镜头顺序冲突、批量事务回滚、部分批准、并发编辑和场次/镜头上下文隔离测试通过。

### P8：性能、安全、迁移和发布硬化

目标：达到可发布的企业级质量门槛。

工作项：

- 上下文来源索引和任务日志分页索引；
- 大文档摘要缓存、工具结果大小限制、任务事件长期保留和上下文 manifest 项目维护清理；
- Provider 能力、上下文窗口、输出预算和工具兼容矩阵；
- Agent 最大运行时长、并发、Token 和费用硬上限；文本字符数和 UTF-8 字节双限制；
- legacy `context_snapshots.content_json` 正文清理、正文泄漏扫描和 Provider step 脱敏；
- archive/restore/purge 引用检查、最小墓碑和已发布文档保护策略；
- 迁移前自动备份、`quick_check`、`foreign_key_check` 和恢复演练；
- 诊断、任务日志、导出和备份脱敏；
- CI 覆盖率、依赖漏洞、SBOM、许可证和 Windows 构建门禁；
- 更新帮助文档、发布检查清单和回滚说明。

退出门禁：全量质量门禁、迁移恢复、Worker 重启、项目切换、并发、恶意输入和 Windows 实机验收全部通过。

## 20. 测试与验证计划

### 20.1 单元测试

- Agent 任务状态机和终态转换；
- 创建/更新任务一主要产物、查询/归档/恢复零伪产物和多文档任务拆分；
- 文档版本状态、双指针、archive/restore 和 selfPublish 事务；
- 公开工具 Schema、`text && streaming && tools` 门禁、step-local 预授权/调用信封、参数清理和工具调用配额；
- Agent 伪造项目/任务/文档/作用域/基础版本/CAS/幂等字段的拒绝；
- 预授权 handle 生命周期、确认 token 单次消费、scoped call ID、参数哈希和重复工具调用；
- 上下文发布版本选择、显式草稿引用和预算；
- 上下文 manifest hash/Token/裁剪信息和正文泄漏检测；
- Research Adapter 能力/路由门禁、`auto|project_only|network_disabled` 模式和 `research.search/fetch` 严格 Schema；
- 搜索/抓取额度、`sourceHandle` 归属、规范 URL、来源 hash、引用标签以及来源冲突/证据不足映射；
- Provider step 状态、ordinal、continuation 和 attempt usage 汇总；
- 错误码、retryable 和用户行为映射；
- 任务事件序列、去重和脱敏。

### 20.2 持久化与迁移测试

- v11 -> v12 -> v13 -> v14 顺序迁移、重复迁移和新库直建；v13 task `version` 无损回填为唯一 `row_version`；
- v14 `runV14Rebuild` 在 FK 开关、影子表复制、依赖顺序 swap、提交前/提交后 `foreign_key_check` 任一步失败时回滚，且不留下影子表或关闭的 FK；
- 旧文档权威版本回填；
- Provider step/预授权/tool-call 复合外键、唯一 ordinal、usage 汇总和中断记录；
- 旧 Provider/idempotency partial index 删除和新 Provider 四元组/manual 二元组索引；
- `agent_task_document_versions` legacy history 保留、primary artifact 确定性投影和异常维护报告；
- 旧 `arguments_json/result_json` 正文清理为不可逆摘要，迁移后数据库和公开 DTO 无正文残留；
- 发布历史、扩展审计动作、purge 墓碑和外键完整性；
- legacy context snapshot 原位清理为 manifest，且不级联删除 generation/attempt；
- 迁移失败回滚与备份恢复；
- 只读项目和项目边界；
- 并发版本写入、CAS、冲突和事务回滚；
- archive/restore 幂等、purge 用户 Actor、显式确认和受保护引用阻断。
- v16 -> v17、新库直建和重复迁移；`agent_research_sources` 复合外键、跨项目拒绝、旧任务零回填、缓存索引和来源/文档引用一致性；
- 研究 URL/凭据脱敏、缓存路径边界、TTL/容量清理、缺失缓存恢复以及备份排除可重建正文。

### 20.3 集成测试

- 用户请求 -> Agent 任务 -> generation/attempt -> Provider step-local 预授权 -> 工具调用 -> 草稿 -> selfPublish；
- `auto` 研究模式执行“冻结项目上下文 -> 搜索 -> 并行抓取 -> 来源结果回传 -> 后续 step 单一文档写入 -> 最终回复”，研究和写入不在同一前置 step 混合；
- `project_only/network_disabled` 零网络请求；无已验证 Research Adapter 时稳定返回 `RESEARCH_PROVIDER_REQUIRED`，不静默退化为模型记忆；
- 真实 Research Adapter 搜索/抓取、多来源冲突、无结果、限流、超时、取消和重启恢复；已成功文档写入不重放；
- 多文档请求拆为多个关联任务，每个任务只产生一个主要文档；
- Provider 满足/不满足 `text && streaming && tools` 两条路径，`structuredOutput` 差异不影响门禁；
- Worker 或 UI 在任意 Provider step 中断时恢复，已成功工具不重复执行，旧预授权 handle 不复用；
- 预授权/确认 token 伪造、过期、撤销、跨 step 重放和工具调用配额全部在副作用前拒绝；
- selfPublish 在审核、批准、publication、指针、任务和审计各步骤故障注入后全部回滚；
- archive -> restore 和 archive -> purge 完整路径，已发布/被引用文档 purge 被阻断；
- 项目切换后旧回调、旧窗口和旧工具结果被拒绝；
- SSRF、DNS rebinding、重定向到私网/云元数据、非文本/超大响应、提示注入、敏感 query 和凭据泄漏在网络或文档副作用前被拒绝；
- 草稿引用与 `agent_research_sources` 一致，失效、冲突、截断和证据不足状态在任务日志和编辑器中可见；
- 任务日志从 Agent、图片和视频任务统一查询；
- 任务日志与文档、素材、会话双向定位。

### 20.4 Desktop 测试

- 任务卡加载、状态变化、失败和重试；
- 文档草稿自动打开、编辑、保存、差异、selfPublish、拒绝、归档和恢复；
- 研究模式选择、研究进度、来源列表/打开、引用缺失与冲突提示；
- 浮窗、停靠、独立窗口单一状态；
- 多窗口并发编辑和冲突提示；
- 只读项目禁用所有写入按钮；
- purge 必须显示不可误触的二次确认和引用阻断结果，且 UI 不向 Agent 暴露入口；
- 任务日志过滤、分页、长列表和窄屏布局。

### 20.5 质量命令

实现阶段每个阶段至少运行相关聚焦测试，最终门禁：

```powershell
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm build
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

真实模型调用、Provider 网络、Windows 独立窗口和安装包验证必须明确记录环境、是否使用 Mock、结果和未验证边界。
P3.2 还必须记录具体 Research Adapter、endpoint/profile、凭据来源（只记录 handle 类型，不记录 secret）、真实搜索/抓取样本、网络安全拒绝和引用一致性；未选择或未验证 adapter 时不得把合成测试写成真实联网验收。

## 21. 迁移、备份、发布与回滚

1. 迁移前对项目数据库执行 checkpoint 和备份；
2. 备份后执行 `quick_check` 和 `foreign_key_check`；
3. v14 按第 12.6 节顺序创建 Provider step/预授权、无损迁移 task CAS、保留任务产物历史并重建脱敏 tool-call 证据，再切换 Repository 读取逻辑；
4. 回填旧文档时把有效 `current_version_id` 设置为 `published_version_id`；
5. 回填失败的文档不得自动猜测权威版本，进入维护报告；
6. legacy 上下文正文按 12.5 原位清理为 manifest；被引用快照不直接删除；
7. 迁移失败保持原数据库可打开，不尝试部分降级；
8. 新版应用发布前通过旧项目打开、编辑、备份、导出和恢复验收；
9. 旧应用不能打开新 Schema 时必须显示明确版本错误并以只读/升级提示退出；
10. 回滚应用使用升级前备份，不执行逆向破坏性迁移；
11. 发布时同步更新代码、Schema、Contracts、帮助文档、M2/M3 和本计划验证记录。

## 22. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 草稿误进入上下文 | LLM 把未审核内容当成事实 | `published_version_id` 独立指针，ContextService 默认拒绝草稿 |
| Agent 工具越权或伪造可信字段 | 直接修改其他项目/文档或绕过 CAS | 公开 Schema 不含可信字段；Worker step-local 预授权、调用信封、白名单、项目边界和伪造字段拒绝 |
| 多窗口覆盖 | 用户修改丢失 | `baseVersionId` + `row_version` CAS + 差异处理 |
| 创建/更新任务绑定多个主要产物 | 任一文档发布后错误完成整个任务 | 创建/更新任务一主要文档；查询/归档/恢复无主要产物，多文档拆分关联任务 |
| 任务、attempt 和 Provider step 混淆 | 状态、费用和恢复点难以追踪 | 任务为业务聚合，generation/attempt 为完整工具循环，step 为单次请求响应 |
| 预授权被重放或在取消后继续使用 | 未授权副作用或错误恢复 | step-local 不透明 handle、过期/撤销、确认 token 单次消费、scoped call ID 和任务 CAS |
| 工具事实表复制正文 | 隐私泄露、数据库膨胀 | v14 重建为严格摘要；原始参数/结果不迁移，运行时正文仅短期持有 |
| 任务日志重复或膨胀 | 查询慢、隐私风险 | 事件有界、摘要化、去重和保留策略；正文单独查询 |
| 统一任务表过度耦合 | 图片/视频/Agent 领域互相影响 | 保留领域表，统一 Query DTO，不强行合表 |
| 工具能力在不同 Provider 不一致 | 同一请求行为不一致 | Agent 固定 `text && streaming && tools` 门禁；不支持时拒绝 Agent 模式，普通聊天仍可纯文本 |
| 把 LLM function calling 误当成网页搜索 | Agent 声称已研究但没有外部来源 | Research Adapter 与 LLM Provider 分离登记和门禁；无已验证 adapter 返回 `RESEARCH_PROVIDER_REQUIRED` |
| 外部页面利用 SSRF、重定向或 DNS rebinding | 访问内网、云元数据或本机服务 | Native 网络桥逐跳/逐解析校验公网目标、受限端口/MIME/大小/时间，私网和元数据地址硬拒绝 |
| 网页提示注入影响工具授权 | 泄露项目资料、改变来源策略或触发写入 | 外部内容按不受信数据隔离；只读研究授权与文档写授权分步；系统提示、Schema 和 ToolGateway 不接受网页指令改写 |
| 搜索 query 泄露私有项目内容 | 第三方研究服务获得未发布资料 | 最小关键词生成、完整上下文禁止发送、query 长期只存 hash/有界元数据、凭据只在桌面存储 |
| 来源不可靠、冲突或引用漂移 | 草稿事实不可验证或误导用户 | 来源元数据/内容 hash/检索时间快照、冲突与截断可见、关键事实引用校验、模型知识不得冒充来源 |
| 研究循环消耗失控 | 成本、时延和上下文膨胀 | 搜索/抓取/网络时间/正文专用额度同时计入 task、step、Token 和总运行时硬上限 |
| 上下文超限 | Provider 拒绝或回答空间不足 | 动态预算、模型窗口、输出预留、约束硬门禁 |
| 上下文审计复制正文 | SQLite 膨胀和敏感内容扩散 | manifest-only、新写入泄漏检测、legacy 原位清理和引用保护 |
| selfPublish 非原子 | 审核、权威指针、任务和审计状态分裂 | 单 Worker 事务、CAS、故障注入和全回滚测试 |
| purge 误删历史或被 Agent 触发 | 资料和审计不可恢复 | 用户显式确认、默认保护已发布文档、引用检查、最小墓碑且不注册 LLM 工具 |
| 迁移旧文档误判 | 原有资料权威状态丢失 | 回填当前版本为权威；异常记录维护报告，不自动猜测 |
| 普通聊天产生隐式副作用 | 用户失去控制 | 只有明确任务意图和工具调用才能产生草稿 |

## 23. 实施细节决策

以下结论于 2026-08-16 和 2026-08-18 固定，当前没有待决策项：

| 主题 | 固定结论 |
|---|---|
| 事件与上下文保留 | Agent 任务事件长期保留；上下文只保留 manifest，并按项目维护策略清理/压缩；引用中的 snapshot ID 不直接删除 |
| 文档工作分支 | 首期同一文档只允许一个当前工作分支；并行候选版本留到后续 ADR |
| 任务资源上限 | Agent 必须有可配置的最大运行时长、项目/Provider 并发、输入/输出/总 Token、费用和每 step/任务工具调用硬上限；超过上限稳定失败，不无限续写 |
| 资源限制 | 使用第 13.4 节固定的字符、UTF-8、4 MiB JSON、Token、费用、step、工具调用和运行时长默认值/硬上限，并进入集中配置和契约测试 |
| 任务日志默认信息 | 默认展示模型、耗时、Token 和费用摘要；Provider step、原始 usage 差异和费用明细按需展开 |
| Agent 模型能力 | 固定为 `text && streaming && tools`；`structuredOutput` 非必要 |
| 工具信任边界 | 公开 Schema 只含创作内容，全部 ID、作用域、基础版本、CAS 和幂等信息来自 Worker 可信执行信封 |
| 任务产物 | 创建/更新任务一主要文档；查询、归档、恢复任务无伪产物；多文档请求拆分为关联任务 |
| 文档删除 | 普通删除为可恢复归档；purge 只允许用户显式确认，默认保护已发布文档且不向 LLM 暴露 |
| 本地发布 | 用户一次操作触发原子 selfPublish；Worker 同事务完成自审、批准、publication、指针、任务和审计 |
| Provider 事实粒度 | generation/attempt 为完整工具循环，step 为单次 Provider 请求响应，usage 按 step 保存并向 attempt 汇总 |
| Agent 信息来源 | 项目生产约束、已发布资料和记忆是优先证据而非唯一来源；显式 Agent 默认 `auto` 研究，用户可强制 `project_only` 或 `network_disabled` |
| 外部研究边界 | `research.search/fetch` 是独立只读工具；研究结果必须先回传给模型，后续 step 才能串行执行文档写入；模型既有知识不等于实时来源 |
| Research Provider | 与 LLM Provider 分离登记精确 adapter route；凭据只存桌面凭据管理器，未通过真实安全冒烟的 route 默认关闭 |
| 研究证据 | v17 保存来源元数据、hash、检索时间、采用/排除和引用关系；完整提取正文只进入本地有界 TTL 缓存，不进入 GitHub 或通用任务日志 |
| 研究安全与额度 | 逐跳 SSRF/DNS/重定向校验、提示注入隔离、query 最小披露；使用第 13.4 节专用搜索/抓取/正文/网络时间额度并同时受聚合硬上限约束 |
| Markdown 导出 | 默认导出已发布版本；草稿仅在用户显式选择时导出并清晰标记 `.draft` |

若未来修改任一固定结论，必须先更新 ADR、本文档、Contracts 和迁移影响，不得以未记录的临时行为进入生产。

## 24. 验收矩阵

| 能力 | 通过标准 | 证据 |
|---|---|---|
| 文档草稿 | LLM 请求可创建草稿，编辑器可打开和保存 | Worker/Contracts/Desktop 测试 |
| 单一主要产物 | 一个任务不能绑定第二个主要文档，多文档请求形成多个关联任务 | Service/Repository 集成测试 |
| 权威隔离 | 未发布草稿不会进入默认上下文 | ContextService 集成测试 |
| 上下文审计 | 新快照只有 manifest，无完整正文/拼接结果/工具定义；legacy 清理不破坏引用 | 泄漏扫描/迁移测试 |
| 审核发布 | selfPublish 原子创建自审、批准、publication、权威指针、任务和审计 | Persistence 故障注入事务测试 |
| 文档生命周期 | archive 可恢复；purge 仅限用户显式确认且受发布/引用保护 | Worker/Persistence 权限与引用测试 |
| 冲突控制 | 多窗口和基础版本冲突不静默覆盖 | CAS/桌面冲突测试 |
| Agent 工具 | 公开 Schema 无可信字段；未知工具、伪造 ID/CAS、越权参数和重复调用均被拒绝或幂等 | ToolGateway 契约测试 |
| 模型门禁 | 仅 `text && streaming && tools` 可启动 Agent；`structuredOutput` 不影响结果 | Provider 能力矩阵测试 |
| Provider 循环 | 完整 tool loop 可跨多个 step 执行/恢复，step usage 正确汇总且副作用不重放 | ProviderLoop 集成测试 |
| 主动外部研究 | `auto` 可在项目资料不足时自主搜索/抓取后创建单一草稿；`project_only/network_disabled` 零网络请求 | Research Adapter/ProviderLoop/Desktop 集成测试 |
| 研究来源与引用 | 来源标题、规范 URL、检索时间、content hash、引用和冲突/截断状态一致且可定位 | v17 Repository、引用校验和 UI 测试 |
| 研究网络安全 | SSRF、私网/元数据、DNS rebinding、危险重定向、超大/非文本响应、提示注入和敏感 query 被拒绝 | Native 安全测试和真实 adapter 负向冒烟 |
| 研究恢复 | 取消、超时、断流、Worker 重启和缓存缺失不重复文档写入，也不伪称旧来源已重新核验 | 故障注入和恢复集成测试 |
| 任务状态 | 重启、失败、取消、拒绝和重试状态可恢复 | 状态机/恢复测试 |
| 任务日志 | Agent、图片、视频任务可统一筛选和定位 | Query/UI 集成测试 |
| 作用域 | 项目、场次、镜头资料不会跨范围泄漏 | Context/Worker 测试 |
| 安全 | 日志、steps、manifest、墓碑和导出不含凭据、正文副本或完整敏感内容 | 脱敏、泄漏和恶意输入测试 |
| 兼容 | v11 -> v14 升级后文档、generation、attempt 和审计不丢失 | 迁移、备份、恢复测试 |
| 工作区 | 同一文档的窗口共用 Worker 保存链路，跨文档窗口不会互相覆盖 | Desktop/Tauri 人工验收 |
| 发布质量 | 全量 TS、Rust、构建、格式和安装门禁通过 | CI/发布检查清单 |

## 25. 完成定义

本计划只有在以下条件全部满足后才能标记为完成：

- 所有已确认产品决策已落入 Contracts、Schema、Service 和 UI 行为；
- Agent 不能直接发布、修改权威版本或 purge；归档/恢复只有在显式用户意图、唯一目标、必要确认和可信执行信封下执行；
- 一个 Agent 任务只有一个主要文档，多文档请求由关联任务承载；
- 文档草稿、版本、审核、原子 selfPublish、归档、恢复和受控 purge 形成闭环；
- 任务、generation/attempt、Provider step、工具调用和产物可通过 ID 互相定位；
- Provider step usage 能正确汇总到 attempt，Worker/Native Runtime 中断不会重放已成功工具；
- P3.2 的 `auto/project_only/network_disabled`、Research Adapter、`research.search/fetch`、v17 来源证据、引用 UI 和安全网络桥全部实现并通过真实 adapter 冒烟；
- Agent 能在项目资料不足时主动研究，但不能把模型记忆、搜索摘要或提示注入内容伪装为已核验事实；
- 统一任务日志可展示 Agent、图片和视频任务，并支持来源双向定位；
- Worker 重启、项目切换、独立窗口、重复请求、并发编辑和失败重试有测试证据；
- SQLite 迁移、备份、恢复和外键完整性通过；
- 普通会话不会产生隐式业务副作用；
- 上下文只新增 manifest，legacy 正文完成兼容清理；预算、生产约束、敏感数据和事件保留策略通过评审；
- Schema v14 迁移、purge 墓碑、扩展审计动作和 selfPublish 故障注入通过；
- 第 23 节无未冻结决策，后续变更均有 ADR；
- `pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 和 Rust 门禁全部通过；
- M2、M3、PROJECT-STARTUP、QUALITY-GATES 和本计划的行为描述保持同步；
- 实施记录写明每个阶段的完成时间、验证命令、测试结果和未验证边界。

## 26. 实施与验证记录

| 日期 | 阶段 | 结果 | 验证证据 | 备注 |
|---|---|---|---|---|
| 2026-08-19 | P3.2 用户可见研究模式与桌面窗口同步 | ChatPanel 增加 `auto/project_only/network_disabled` 选择器，当前选择按本地 LLM 选择偏好保存；Agent 草稿请求使用用户选择，主窗口与独立会话窗口通过快照/动作协议同步，运行中的 generation 禁止切换模式 | `pnpm.cmd --filter @ai-video/contracts build`、`pnpm.cmd --filter @ai-video/desktop typecheck`、Desktop ChatPanel/DetachedPanel 聚焦测试（3 个文件/7 项）通过；Desktop 全量测试 18 个文件/101 项通过 | Native 网络桥和取消/重启完整实机语义仍未完成；模式选择只影响显式 Agent 草稿任务，普通问答保持无副作用 |
| 2026-08-19 | P3.2 研究来源 UI 与任务详情关联 | `agent.task.get` 按项目/任务返回来源元数据和缓存状态；Desktop 任务详情展示引用标签、标题、规范 URL、站点、抓取时间、采用状态、截断和缓存缺失/过期提示；正文、缓存路径、凭据和原始响应不进入公开 DTO | `pnpm.cmd --filter @ai-video/contracts build`、`pnpm.cmd --filter @ai-video/worker test`（21 个文件/172 项）、`pnpm.cmd --filter @ai-video/worker typecheck`、`pnpm.cmd --filter @ai-video/desktop exec vitest run src/TaskLogView.test.tsx`（8 项）、`pnpm.cmd --filter @ai-video/desktop typecheck`、Desktop 全量测试（18 文件/101 项）通过；`git diff --check` 通过 | P3.2 仍待 Native 网络桥、取消/重启恢复完整实机语义和安装包链路；DOCX 渲染仍受环境缺少 LibreOffice 限制 |
| 2026-08-19 | P3.2 Native 研究网络桥基础切片 | Desktop 为每个 Worker 进程创建一次性 loopback Native bridge 和随机能力令牌；Worker 正式研究客户端只通过桥提交公开 HTTPS GET，无桥时 fail-closed；Native 独立执行主机/DNS/公网地址、HTTPS、重定向禁用、MIME 请求白名单和响应体上限，桥不接收 Provider 凭据 | `pnpm.cmd test`（Worker 194、Desktop 108、Persistence 22 及其余 workspace 通过）、`pnpm.cmd typecheck`、`pnpm.cmd build`、`pnpm.cmd lint`、`pnpm.cmd format:check`、`git diff --check`、`cargo fmt --check`、Rust 55 项通过；新增 Native 令牌/URL/公网边界/无桥 fail-closed 回归 | P3.2 仍待 Native 请求取消贯穿、Worker 崩溃后 in-flight 研究恢复、通用 DNS rebinding/压缩炸弹/敏感 query 验收、真实研究冒烟和安装包链路；不得据此标记总项完成 |
| 2026-08-18 | 计划 v1.1 / P3.2 配额与桌面真实研究验收 | 修复 v14-v17 默认 8 次工具额度会在研究后阻断草稿创建的问题；Schema v18 将新任务默认额度调整为 16、数据库硬上限调整为 32 并保留 v17 数据/FK/索引/触发器；新增 search 3 次、fetch 8 次、预留 1 次文档操作、动态移除耗尽工具和并行超额调用的受控 `RESEARCH_BUDGET_EXCEEDED`；仅对 `198.18.0.0/15` Fake-IP 执行固定 HTTPS DoH 二次公网解析 | 全量：`pnpm test`（Worker 170、Desktop 99、Persistence 22、LLM 10、Context 7、Contracts 2、Generation Adapters 16）、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、Rust 49 项和 `cargo fmt --check` 全部通过。桌面真实样本任务 `cfdd4547-456a-433b-907b-e86b904cf674` 使用 `UniCompAPI / gpt-5.6-sol`，按 3 search -> 2 fetch -> 1 draft -> final stop 完成，工具计数 6/16；唯一草稿 `ffe1cdba-58f1-4ef5-abe6-bc5a7d5ab157` 标题为 `P3.2 真实研究验收-联网成功`、正文 879 字符，包含两个真实抓取 URL 并自动在编辑器打开；未输出凭据或网页正文 | P3.2 保持进行中：来源 UI、稳定引用/引用校验、用户可见研究模式、Native 网络桥、缓存 TTL/容量治理、取消/重启/缓存丢失恢复和安装包链路仍待完成 |
| 2026-08-18 | 计划 v1.0 / P3.2 Worker 主动研究功能切片 | 新增 `researchMode` 合同、Desktop `auto` 请求、`bing-html-public-v1`、`research.search/fetch`、任务/attempt 来源句柄、受控 HTTPS 抓取、正文提取、项目本地缓存、最多 8 个并行只读调用、研究/文档 step 隔离和 Schema v17 `agent_research_sources`；研究结果可在后续 step 驱动单一草稿写入 | 自动化：Worker 167 项、Persistence 22 项、Desktop 99 项及其余 workspace 测试通过；`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、Rust 49 项和 `cargo fmt --check` 通过。脱敏真实网络冒烟：Bing 返回 5 个结果；前两个来源被安全策略以受控错误阻断，第三个 `www.hanyuguoxue.com` 抓取成功，正文 4860 字符、未截断、content hash 已生成；未输出网页正文或凭据 | P3.2 保持进行中：DuckDuckGo 在当前环境因连接超时/DNS 异常未启用；来源 UI/引用校验、用户可见模式选择、Native 网络桥、缓存治理、取消/重启恢复和 UniCompAPI 桌面真实研究起草链路仍待完成 |
| 2026-08-18 | 计划 v0.9 / P3.2 主动外部研究 | 固定“项目上下文优先但非唯一”的产品合同；新增 `auto/project_only/network_disabled`、独立 Research Adapter、`research.search/fetch`、v17 来源事实、本地 TTL 缓存、来源引用/UI、安全网络边界和 P3.2a-d 实施顺序 | Markdown/DOCX 同步；版本、阶段、工具、Schema、缓存、安全、测试、验收和表格结构校验见本轮执行结果 | 本项只更新计划；尚未选择/验证 Research Adapter，未实现搜索路由、研究工具、v17 迁移或来源 UI，P3.2 保持未开始 |
| 2026-08-18 | P4 Agent 草稿终态刷新与自动打开 | Agent 进入终态后刷新 `document.list`，比较任务前后文档 ID，并通过统一 `openDocumentById` 链路自动打开新草稿；失败刷新保持原错误语义 | Desktop 99 项、Desktop typecheck、根 lint/format、生产 build 和 `git diff --check` 已通过；`App.test.tsx` 覆盖新增草稿自动打开 | P4 仍待自动意图识别及其他文档操作入口；本项不代表 P4 全部完成 |
| 2026-08-18 | P3.1 UniCompAPI 桌面 Native Agent 验收 | 修复并验证 Chat Completions Native 兼容边界：wire 工具名点号使用 `__dot__` 可逆映射；`providerResponseId` 和 `authorizationHandle` 保持 camelCase 契约；缺失顶层响应 ID 时以首个 call ID 生成有界 continuation identity；每个 Provider step 使用独立 Tauri Channel，并仅在 Native `invoke` 返回后启动 Channel 投递宽限，避免把 Provider 推理时间误判为事件丢失 | 使用桌面端已保存凭据和 `UniCompAPI / gpt-5.6-sol` 在隔离项目执行真实草稿请求，未读取或输出 API Key。最终样本恰好生成 1 个 draft，标题 `UniComp Native 最终样本`、正文与请求一致；两个 `openai-chat-completions` step 均为 `complete`：step 0 `finish_reason=tool_calls`、1 个 `document.create_draft` 调用、usage 212/64/276；step 1 `finish_reason=stop`、usage 262/87/349；Provider response ID、call ID、continuation manifest 和工具成功状态均持久化。重载后 UI 显示文档数 1 和“生成完成” | 定向 Rust `llm_stream` 16 项、Desktop 99 项通过；全量 `pnpm test`（Worker 161、Desktop 99、Persistence 22、LLM 10、Context 7、Contracts 2、Generation Adapters 16）、Rust 49 项、`cargo fmt --check`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 和 `pnpm build` 通过；Markdown/DOCX 已同步，DOCX 结构与固定 DXA 表格几何校验通过。取消、重启恢复、真实 OpenAI Responses 和安装包 Native 链路仍未验收，P3.1 保持进行中 |
| 2026-08-18 | P3.1 UniCompAPI Chat Completions 适配 | 精确开放 `unicompapi-chat-completions-gpt-5.6-sol-v1`（`https://unicompapi.com/v1`、模型 `gpt-5.6-sol`）；完成非流式两轮工具续写、流式 SSE `tool_calls` 分片聚合、并行双工具、`tool` 结果回传、usage/finish_reason/tool_call_id 归一化；Responses `previous_response_id` 明确拒绝，避免错误复用协议 | 脱敏真实冒烟：`/v1/models` 成功返回 32 个模型并包含目标模型；非流式工具两轮成功；流式工具调用收到完整 `[DONE]`；并行调用得到 2 个独立 call ID；无效 Token 返回 401；不存在模型返回 503；Responses `previous_response_id` 返回 400（仅支持 Responses WebSocket v2）。合成工具仅使用 `echo_probe`、`lookup_alpha`、`lookup_beta`，未调用真实业务工具或暴露凭据 | 协议适配和真实 Provider 验证完成；桌面 Native Agent 文档草稿链路已由同日后续验收记录完成，取消、重启恢复、真实 OpenAI Responses 和安装包验收仍待完成，P3.1 保持进行中 |
| 2026-08-18 | P3.1 Provider 工具路由运行时门禁 | Worker 增加模型能力与已验证 transport route 双重门禁，开放官方 OpenAI Responses 和已验证 UniCompAPI Chat Completions allowlist；拒绝发生在 generation、任务、文档和 Provider step 持久化前；Native Runtime 对不匹配协议的工具 continuation 防御性拒绝，避免显式 Agent 请求静默降级 | 定向：Worker `provider-registry`、`handler` 和 Rust `llm_stream` 适配测试通过；全量：`pnpm test`（Worker 161、Desktop 98、Persistence 22、LLM 10、Context 7、Contracts 2、Generation Adapters 16）、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、Rust 47 项和 `cargo fmt --check` 通过 | 协议层和路由门禁已完成；桌面 Native Agent 文档草稿链路已由同日后续验收记录完成。P3.1 仍待安装包链路、取消/重启恢复、真实 OpenAI Responses 和其他第三方路由验收。 |
| 2026-08-16 | P1 / P3 基础合同 | Provider step、step-local authorization Repository 已接入；LLM Responses 适配器可解析 function-call 事件 | `pnpm --filter @ai-video/persistence test`（19 项）、`pnpm --filter @ai-video/llm test`（10 项）、相关 typecheck 通过 | 当前只完成事实持久化和事件解析；Native Runtime 的可信信封、工具执行、结果回传和确认续执行仍未开放 |
| 2026-08-17 | P3/P4 真实工具链 | 用户确认真实 Provider 工具调用链路已验证正常 | 用户人工验证 | 真实链路冒烟证据与任务记录待补充到验收表 |
| 2026-08-17 | P1/P3 验收审计 | 未通过真实 Provider 工具循环门禁；保留上一行人工验证记录，但不得据此勾选阶段完成 | `pnpm.cmd --filter @ai-video/llm test`（10 项）、`pnpm.cmd --filter @ai-video/worker test`（143 项）、`cargo test llm_stream`（8 项）通过；代码审计确认 `LlmGenerationRuntimeRequest`、Native `LlmRuntimeRequest` 和请求体均未携带工具定义，`LlmStreamEvent`/SSE 解析仅处理文本 delta，且不存在 ToolGateway/ProviderLoopService 调用路径 | 下一步必须实现“工具定义下发 -> step-local 预授权 -> 受限执行 -> 工具结果回传 -> 续写”的可重复端到端测试；在此之前 P1/P3 保持进行中 |
| 2026-08-17 | P1/P3 核心工具循环 | `document.create_draft` 纵向闭环完成：显式 Agent IPC 创建任务与 Provider step；Worker 签发只对 Native 可见的不透明授权 handle；Native 下发工具定义但不向 Provider 泄露 handle；function call 经白名单、严格参数和配额校验后原子写入草稿与主要产物；工具结果通过 `function_call_output` 续写；两个 step 的 usage 与 continuation manifest 持久化 | Worker 19 个测试文件/145 项、Desktop 17 个测试文件/95 项、Rust 43 项及 `pnpm typecheck`、Lint、格式、生产构建全部通过；新增伪造 handle、额外字段、副作用前拒绝、Native 请求脱敏、Desktop 双流续写测试 | P1/P3 保持进行中；此后续记录补齐剩余文档工具和确认续执行。 |
| 2026-08-17 | P3 文档工具扩展 | `document.list/read/update_draft/archive/restore` 已加入显式 Agent 意图和单工具 step-local 授权；更新的目标文档、基础版本和 CAS 由 Worker 冻结；读取正文只经短期 continuation 返回而不写入工具证据或 manifest；归档/恢复先进入 `waiting_confirmation`，一次性 token 确认后才领取调用配额、执行生命周期变更并创建续写 step | `agent-provider-loop-service.test.ts` 覆盖读取正文脱敏、受信目标/CAS 更新、确认单次消费、过期和跨 step 旧 handle 拒绝 | P3 仍待 Worker 中断恢复、取消与工具提交竞争、完整确认 UI 和更广泛的配额/重放故障注入验收。 |
| 2026-08-17 | P3 取消、恢复与确认闭环 | `llm.generation.cancel/fail` 终态会撤销 Agent 授权、终止未完成 Provider step/confirmation，并拒绝迟到工具回调；项目恢复时清理仍在运行但 generation 已中断的任务。Desktop 在高影响工具调用后调用本地确认，再使用一次性 token 续写同一 Provider loop | Worker Agent loop 8 项测试覆盖取消先提交零写入、授权撤销和恢复清理；Desktop `llm-client` 4 项测试覆盖确认后的同一 loop 续写 | P3 继续保留进行中，待完整 Provider 人工演练、并发故障注入与最终恢复验收。 |
| 2026-08-16 | P1 / v14 Schema | 完成持久化基础 | `pnpm --filter @ai-video/persistence test`（19 项）、`pnpm --filter @ai-video/worker test`（131 项）、`pnpm --filter @ai-video/desktop test`（88 项）及 `pnpm typecheck` 通过 | `runV14Rebuild` 重建完整入站 FK 闭包；任务 `version` 无损迁移为 `row_version`；旧工具正文转为 `legacy_redacted` 摘要；现有回答转草稿链路写入 primary artifact。Provider 请求循环、预授权签发和确认消费仍待 P3 实现 |
| 2026-08-16 | 计划 v0.6 | 实现级复审修订 | 统一确认 token 的唯一消费点和无正文 continuation descriptor；补齐 primary artifact 生命周期、legacy tool-call 确定性迁移、完整入站 FK swap、v13 状态事实与 partial 恢复审计动作；最终格式、链接和结构校验见本轮执行结果 | 本项只修订计划，v14 及后续代码仍待实施 |
| 2026-08-16 | 计划 v0.5 | 最终交叉审阅修订 | 固化 `agent_task_confirmations` 的 v14 影子迁移、Provider/manual 互斥调用路径、原子去重冲突重读、手工草稿 selfPublish、同项目 step/call 复合键和小说 partial 恢复不变量；最终格式、链接和结构校验见本轮执行结果 | 本项只修订计划，v14 及后续代码仍待实施 |
| 2026-08-16 | 计划 v0.4 | 交叉审阅修订 | 增加工具调用的任务/step 配额、持久化计数、CAS 预留和重放计数合同；最终格式、链接和一致性验证待本轮记录 | 本项只修订计划，v14 代码仍待实施 |
| 2026-08-16 | 计划 v0.3 | 最终安全合同补强 | 受控 Agent CRUD、去重顺序、取消 CAS、复合 FK、证据保留、Markdown 网络隔离和资源硬上限已写入；最终格式/链接验证见本轮执行结果 | 本项只修订计划，v14 代码仍待实施 |
| 2026-08-16 | 计划 v0.2 | 合同校准完成 | 真实 Schema v13 对照；Prettier check、`git diff --check`、旧冲突 `rg` 和 Markdown 围栏检查通过 | 本项仅更新实施计划；v14 Schema、Provider loop、可信信封、selfPublish 和归档/purge 代码仍待按阶段实施 |
| 2026-08-16 | P0 | 完成 | 已冻结模型门禁、公开 Schema/可信信封、受控 Agent CRUD、任务产物基数、用户 purge、selfPublish、Provider step、资源上限和 manifest-only 决策 | 当前没有待决策项；多用户权限和结构化场次/镜头仍属后续范围 |
| 2026-08-16 | P1/P2 | 基线完成 | Schema v12；Persistence 基础迁移与 Worker 工作流/上下文测试通过；CAS、幂等、发布历史和双指针已验证 | v13 审计迁移单独记录；v14 Provider steps、归档元数据和 purge 墓碑待实施 |
| 2026-08-16 | P5/P8 | 审计与迁移完成 | Schema v13 `document_audit_events`；Persistence 审计 repository/不可变与有界字段测试；Worker 手工/Agent 保存、恢复、审核、拒绝和发布动作序列测试 | 审计仅覆盖文档工作流动作；任务事件、完整正文和评论保持独立 |
| 2026-08-16 | P4/P5 | 基础闭环完成 | Desktop 17 个测试文件/88 项；Worker 18 个测试文件/131 项；草稿、提交审核、要求修改、发布、文档独立窗口实体隔离和权威上下文隔离通过 | 自动意图触发、真实 Provider tool loop、差异视图、放弃操作和动态模型预算尚未完成 |
| 2026-08-16 | P6 | 详情闭环部分完成 | `task.log.list` 聚合 Agent/图片/视频任务；Agent 详情展示错误、事件时间线和文档产物；任务日志空态、刷新和详情 UI 已验证 | 来源跳转、筛选分页、自动刷新、模型/Token/费用和图片/视频完整详情待补 |
| 2026-08-16 | P6 | 筛选分页完成 | `task.log.list` 支持 `kind/status/cursor` 分页并返回 `nextCursor`；Desktop 增加类型/状态筛选和加载更多；Worker 140 项、Desktop 90 项测试通过 | 来源跳转、自动刷新、模型/Token/费用和图片/视频完整详情待补 |
| 2026-08-16 | P6 | 摘要展示完成 | Agent 任务和任务日志带出最新 attempt 的 Provider、模型、输入/输出 Token 和费用摘要；Desktop 详情面板展示 | Provider step 详情、来源跳转、自动刷新和图片/视频完整详情待补 |
| 2026-08-16 | P6 | 自动刷新完成 | Desktop 任务日志打开项目后每 30 秒自动刷新，筛选和分页状态保留 | 来源跳转、图片/视频完整详情和 Provider step 详情待补 |
| 2026-08-16 | P6 | 来源跳转完成 | Agent 文档详情增加“打开文档”，跳转到文档工作区并加载版本历史 | 来源会话跳转、图片/视频完整详情和 Provider step 详情待补 |
| 2026-08-17 | P6 | 任务日志闭环完成 | Agent 详情可打开来源会话；图片/视频详情读取 `image.generate.get`/`video.generate.get` 并展示状态、请求摘要、Provider 任务和落盘产物 | Provider step 详情和素材/镜头直接跳转待补 |
| 2026-08-16 | P8 | 自动门禁完成 | `pnpm test`（Desktop 88、Worker 131、Persistence 18）、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、Rust 41 项测试和 `cargo fmt --check` 全部通过 | Windows 独立窗口实机、端口冲突恢复、迁移备份恢复演练未在本轮自动化验证 |
| 2026-08-17 | P4 显式草稿入口与 Agent IPC 边界 | 会话输入区新增“创建文档草稿”显式图标，仅在可写会话且存在输入时可用；点击后固定发起 `agent.generation.prepare`、`agentMode=document` 和 `document.create_draft` 意图。Agent 准备、工具执行、确认和 Provider step 已纳入 IPC 参数白名单，拒绝伪造授权字段和未声明参数 | Desktop `App`/`ChatPanel` 15 项定向测试覆盖显式入口、固定意图和只读禁用；Worker `handler`/Agent loop 23 项定向测试覆盖未信任字段拒绝；全量 `pnpm test`（Desktop 98、Worker 152）、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、Rust 43 项及 `cargo fmt --check` 通过 | P4 继续进行中：尚未提供 update/read/archive/restore 的目标选择入口，且普通聊天仍按产品决策保持无副作用；P3 仍待真实 Provider 人工演练和更广泛故障注入。 |
| 2026-08-17 | P3.1 Provider 工具路由兼容性计划 | 将模型 function calling 与 transport tool loop 分离为双重门禁；新增 OpenAI Responses 基线、UniCompAPI Chat Completions 默认不开放、allowlist、无静默降级、逐路由真实 Provider 验收和无数据回填要求 | 计划合同复核；本项在该记录时尚未实施运行时代码或真实 Provider 冒烟 | 历史计划记录；UniCompAPI 目标模型、endpoint、适配器和桌面 Native 验收已由 2026-08-18 后续记录完成，P3.1 剩余边界以最新记录为准。 |
| 2026-08-17 | P3.1 计划文档同步 | Markdown 计划升级至 v0.7，并生成同内容的 `AGENT-PROJECT-DOCUMENT-WORKFLOW-IMPLEMENTATION-PLAN.docx`；DOCX 结构校验通过（段落、表格、样式、固定表格宽度和 P3.1 文本存在） | 使用 bundled Python/`python-docx` 生成；LibreOffice/soffice 不在当前 Windows 环境，未完成 PNG 渲染视觉 QA | 历史同步记录；P3.1 的运行时代码、Provider 冒烟、UniCompAPI 适配器和桌面 Native 验收已由 2026-08-18 后续记录完成。 |
| 2026-08-19 | P3.2 Native 研究取消贯穿 | Worker 研究请求携带请求 ID；AbortSignal 触发 Native `/research/cancel`，桥维护进程级取消注册表并将取消标记传入 WinHTTP 分段读取；取消后不写入研究缓存或草稿 | Worker 26 个测试文件/198 项、Desktop 20 个测试文件/111 项、Worker/Desktop typecheck、Rust 55 项、`cargo fmt --check`、`git diff --check` 通过 | Worker 崩溃后 in-flight 恢复、真实研究冒烟、安装包链路和 Windows 实机取消演练仍待完成 |
| 2026-08-19 | P4 普通聊天文档意图切片 | Chat 模式仅对明确的创建/读取/更新/归档/恢复表达升级 Agent；目标文档操作必须绑定当前唯一文档，缺少目标只提示且零写入；否定表达和普通问答保持原聊天路径 | 新增 `inferDocumentIntent` 3 项回归；Desktop 全量 20 个测试文件/111 项和 typecheck 通过 | 持久化 pending intent、更多目标选择入口和真实 Provider 端到端验收仍待完成 |
| 2026-08-19 | P7 场次/镜头/关联文档原子 change set | Schema v26 增加 scene/shot `row_version` 与项目/任务隔离的 change set 表；Schema v27 增加 `document` item 及文档 create/update 提案字段；Worker 在单一 SQLite 事务中应用场次、镜头和关联文档变更，文档 CAS 冲突整批回滚并保留冲突状态；Desktop `shots` 工作区保留 item 级差异审阅、批准/拒绝和冲突提示。Persistence 22 项、Worker 211 项、Desktop 116 项，且全仓 `pnpm.cmd test`、`pnpm.cmd typecheck`、`pnpm.cmd lint`、`pnpm.cmd format:check`、`pnpm.cmd build`、`git diff --check` 通过 | 真实 Windows 多窗口并发、跨场次人工验收和安装包链路仍待完成；P7 保持进行中 |
