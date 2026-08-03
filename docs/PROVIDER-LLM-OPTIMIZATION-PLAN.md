# 供应商、模型、生产导航与 LLM 优化计划

版本：1.0  
日期：2026-08-03  
状态：P0-P9 实施与代码质量门禁已完成；最新 Sidecar/NSIS 发布验证受 Vite 和 Tauri dev 两棵受权限保护的开发进程树文件锁阻塞，清理并通过发布门禁后保持计算机开机

## 1. 文档目的

本文档定义 AI 影视工作台下一阶段的专项优化方案，覆盖：

- 将“生产方式”从右侧生产参数面板迁移到左侧导航。
- 以“图片制作”和“视频制作”作为一级菜单。
- 建立应用级“供应商与模型”管理中心。
- 支持同一供应商配置多个独立连接和不同 API Key。
- 支持官方 API 与自定义供应商（中转站）。
- 保存供应商后执行连通性测试并同步模型目录。
- 重构 LLM Provider，使其支持 OpenAI Responses 与 OpenAI-compatible Chat Completions。
- 记录供应商实际返回的 Token 使用量。
- 允许用户配置模型单价并显示估算费用。
- 在不泄露凭据、不破坏项目兼容性、不扩大第一版范围的前提下，为后续 Anthropic、Gemini、Ollama、故障切换和智能路由保留扩展点。

本文档是实施和验收依据。各阶段只有在对应质量门禁通过后，才能进入下一阶段。

## 2. 当前代码基线

### 2.1 桌面端

- `apps/desktop/src/App.tsx` 同时承担项目导航、设置、主工作区和聊天面板状态，文件职责过多。
- `apps/desktop/src/ProductionPanel.tsx` 同时承担生产方式、供应商、模型、凭据、动态参数、图片生成和视频任务管理。
- 当前“生产方式”下拉框位于 `ProductionPanel`，能力状态也由该组件内部管理。
- 左侧导航当前只负责项目文档、镜头和素材库。
- 小于 660px 时左侧项目栏被隐藏，迁移生产方式后必须提供窄屏入口。
- 当前聊天界面轮询 Worker 的生成状态，没有直接消费 Tauri 原生推送的流式事件。

### 2.2 Worker

- `apps/worker/src/generation-service.ts` 持有单个 `LlmProvider`，负责上下文编译、流式生成、批量持久化、取消和重试。
- `apps/worker/src/handler.ts` 在启动时从 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL` 创建单个 OpenAI Provider。
- Worker 当前无法使用用户运行期间新增的多个供应商连接。
- 图片和视频 Adapter 目录来自静态 `@ai-video/generation-adapters`。

### 2.3 Tauri

- `apps/desktop/src-tauri/src/lib.rs` 同时负责 Worker 进程、Windows 凭据、Vidu 网络请求和任务轮询。
- 凭据目标只允许 `vidu` 和 `vidu-cn`，无法保存同一供应商的多个密钥。
- 媒体 Provider 的主机、路径和 Adapter Key 为静态白名单。
- 当前没有通用 LLM 流式网络桥。

### 2.4 持久化

- 项目数据库当前为 Schema v6。
- 项目数据库包含项目文档、会话、消息、生成草稿和媒体任务。
- 当前没有独立的应用级设置数据库。
- 供应商配置、模型目录、模型价格和跨项目用量不能写进某个项目的 `project.sqlite`。

## 3. 已确认的产品和架构决策

以下决策在第一版中固定，不在实施过程中临时变更：

1. 一个供应商连接对应一个 Base URL 和一个 API Key。
2. 同一供应商的多个密钥通过多个供应商连接实现。
3. 第一版不实现一个连接内的密钥数组、轮询或自动负载均衡。
4. 每个供应商连接使用稳定 UUID，名称只用于显示，不能作为业务主键。
5. API Key 只保存在 Windows 凭据管理器。
6. API Key 不得进入 Worker、项目 SQLite、应用设置 SQLite、日志、诊断包和测试输出。
7. 供应商、模型、定价和应用默认项属于应用级配置。
8. 项目生成历史、每次调用明细、使用量和价格快照属于项目数据。
9. 图片、视频和 LLM 共用供应商连接、凭据引用和模型目录基础结构，但使用不同执行 Connector。
10. 官方连接的 Base URL 由程序内置并锁定。
11. 自定义供应商必须选择兼容协议，仅填写 Base URL 和密钥不足以确定请求格式。
12. 第一版 LLM 协议为 OpenAI Responses 和 OpenAI-compatible Chat Completions。
13. `/models` 返回的模型不能自动视为可用，未知模型必须支持手动添加和能力分类。
14. 不自动跨供应商发送用户上下文；故障切换必须由用户显式配置。
15. Token 使用量以供应商返回值为准，不根据文本长度生成虚假的结算数据。
16. 模型价格按每 100 万 Token 配置。
17. 历史费用使用生成时的价格快照，后续修改价格不改变历史结果。
18. 不同币种分开汇总，第一版不自动获取或应用汇率。

## 4. 目标信息架构

### 4.1 左侧生产导航

```text
项目资料
├─ 项目文档
├─ 场次与镜头
├─ 角色与场景
└─ 素材库

内容生产（分组标题，不可点击）
├─ 图片制作
│  ├─ 文生图
│  └─ 参考生图
└─ 视频制作
   ├─ 文生视频
   ├─ 图生视频
   ├─ 参考生视频
   └─ 首尾帧生视频
```

“图片制作”和“视频制作”是一级菜单，“内容生产”仅作为视觉分组标题。

### 4.2 设置中心

```text
设置中心
├─ 供应商与模型
├─ 使用量与费用
└─ 项目维护
```

供应商配置不依赖当前项目，未打开项目时也必须可用。

### 4.3 供应商添加流程

官方 API：

```text
添加供应商
→ 选择“官方 API”
→ 选择供应商或区域图标
→ 填写连接名称和 API Key
→ 保存并测试
→ 获取模型
→ 启用模型并配置默认角色和单价
```

自定义供应商：

```text
添加供应商
→ 选择“自定义供应商”
→ 选择兼容协议
→ 填写连接名称、Base URL 和 API Key
→ 保存并测试
→ 尝试同步模型
→ 必要时手动添加模型 ID
```

## 5. 目标系统架构

```text
Desktop UI
├─ ProductionNavigation
├─ ProductionPanel
├─ SettingsCenter
│  ├─ ProviderConnections
│  ├─ ModelManagement
│  └─ UsageDashboard
└─ ChatPanel

Worker
├─ AppSettingsService
├─ ProviderProfileService
├─ ModelCatalogService
├─ ProductionAdapterService
├─ LlmGenerationService
└─ UsageIndexService

Persistence
├─ project.sqlite
│  ├─ 项目和内容数据
│  ├─ 会话和消息
│  ├─ 媒体生成任务
│  └─ LLM 调用明细与费用快照
└─ app-settings.sqlite
   ├─ 供应商连接
   ├─ 模型目录
   ├─ 模型单价
   ├─ 默认模型
   └─ 跨项目使用量索引

Tauri
├─ WorkerProcess
├─ CredentialStore
├─ ProviderHttpClient
├─ MediaConnector
└─ LlmConnector
```

## 6. 数据设计

### 6.1 应用级数据库

应用级数据库建议位于 Tauri 应用数据目录：

```text
%APPDATA%/AI Video Workspace/app-settings.sqlite
```

该路径由 Tauri 解析，在启动 Worker 时通过明确参数传入，不依赖当前工作目录。

### 6.2 `provider_profiles`

建议字段：

```text
id                    TEXT PRIMARY KEY
name                  TEXT NOT NULL
category              TEXT NOT NULL
provider_type         TEXT NOT NULL
access_type           TEXT NOT NULL
protocol              TEXT NOT NULL
base_url              TEXT NOT NULL
enabled               INTEGER NOT NULL
connection_status     TEXT NOT NULL
last_checked_at       TEXT
last_error_code       TEXT
last_error_message    TEXT
created_at            TEXT NOT NULL
updated_at            TEXT NOT NULL
archived_at           TEXT
```

约束：

- `id` 必须为应用生成的 UUID。
- `name` 允许重复，但同一列表中应给用户重复提示。
- 官方连接的 `base_url` 必须匹配内置供应商定义。
- `last_error_message` 必须经过脱敏和长度限制。
- 表中不存在密钥字段。

### 6.3 `provider_models`

建议字段：

```text
id                    TEXT PRIMARY KEY
provider_profile_id   TEXT NOT NULL
remote_model_id       TEXT NOT NULL
display_name          TEXT NOT NULL
capabilities_json     TEXT NOT NULL
source                TEXT NOT NULL
enabled               INTEGER NOT NULL
last_synced_at        TEXT
last_seen_at          TEXT
unavailable_at        TEXT
created_at            TEXT NOT NULL
updated_at            TEXT NOT NULL
```

唯一约束：

```text
UNIQUE(provider_profile_id, remote_model_id)
```

同步时只标记远程消失的模型不可用，不立即物理删除。

### 6.4 `model_pricing`

建议字段：

```text
provider_profile_id   TEXT NOT NULL
model_id              TEXT NOT NULL
currency              TEXT NOT NULL
unit_tokens           INTEGER NOT NULL DEFAULT 1000000
input_price           TEXT NOT NULL
cached_input_price    TEXT
output_price          TEXT NOT NULL
updated_at            TEXT NOT NULL
PRIMARY KEY(provider_profile_id, model_id)
```

价格使用十进制字符串存储，计算时使用十进制定点库或整数最小金额单位，不能直接使用二进制浮点数作为权威值。

### 6.5 `provider_defaults`

第一版角色：

```text
quality
balanced
fast
vision
embedding
```

第一版 UI 至少启用：

- 高质量创作
- 日常平衡
- 快速处理

### 6.6 项目数据库 Schema v7

新增 `llm_generation_attempts`：

```text
id
generation_id
conversation_id
assistant_message_id
provider_profile_id
provider_name_snapshot
model_id
model_name_snapshot
protocol
status
started_at
first_token_at
completed_at
input_tokens
cached_input_tokens
output_tokens
reasoning_tokens
total_tokens
raw_usage_json
pricing_snapshot_json
estimated_cost
currency
error_code
error_message
```

要求：

- 每次重试创建新的 Attempt。
- Attempt 与原始用户消息和本次助手消息明确关联。
- 供应商或模型后续被删除，历史记录仍保留显示快照。
- 失败或取消请求只要供应商返回 usage，也必须保存。
- `raw_usage_json` 只保存用量字段，不能保存请求正文、密钥或完整响应。

### 6.7 跨项目用量索引

应用数据库中的 `usage_index` 是派生缓存，不是权威业务数据：

- 以 Attempt ID 幂等更新。
- 不保存提示词和回答正文。
- 保存项目 ID、项目名称快照、供应商、模型、日期、状态、Token 和费用。
- 索引损坏时可以从最近项目数据库重新构建。

## 7. 凭据和网络安全

### 7.1 凭据目标

新凭据目标：

```text
com.ai-video.workspace:provider-profile:<UUID>
```

Tauri 在读取、写入或删除凭据前必须：

1. 校验 UUID 格式。
2. 确认连接存在。
3. 确认连接未归档。
4. 使用固定服务前缀拼接目标。
5. 不接受前端传入任意 Credential Target。

### 7.2 密钥生命周期

- 密钥只在添加或更新表单中短暂存在于 React 状态。
- 调用 Tauri 保存后立即清空输入框。
- UI 只显示“已配置/未配置”，不回显完整密钥。
- 更新密钥使用覆盖写入。
- 删除连接前提示密钥也会删除。
- 诊断导出必须继续执行凭据、Authorization、URL query 和响应正文脱敏。

### 7.3 Base URL 校验

官方连接：

- Base URL 由程序内置并锁定。
- 区域差异使用独立官方入口或受控区域字段。

自定义连接：

- 默认只允许 HTTPS。
- 禁止 URL 中的用户名和密码。
- 禁止 query 和 fragment。
- 规范化尾部斜杠。
- 禁止跨 Origin 重定向携带 Authorization。
- 保留当前禁用重定向策略，除非 Connector 明确实现安全同源重定向。
- 限制请求体、响应体、错误体和模型列表大小。

本地 Connector：

- Ollama 等本地连接后续可以单独允许 `127.0.0.1`、`localhost` 的 HTTP。
- 不因此放开所有自定义 HTTP 地址。

## 8. Connector 设计

### 8.1 基础接口

```ts
interface ProviderConnector {
  testConnection(profile: ProviderRuntimeProfile): Promise<ConnectionTestResult>;
  listModels(profile: ProviderRuntimeProfile): Promise<RemoteModelInfo[]>;
}
```

### 8.2 LLM Connector

第一版：

```text
openai-responses
openai-chat-completions
```

后续：

```text
anthropic-messages
google-generate-content
ollama
```

标准化能力：

```ts
interface LlmModelCapabilities {
  text: boolean;
  vision: boolean;
  streaming: boolean;
  reasoning: boolean;
  tools: boolean;
  structuredOutput: boolean;
  embeddings: boolean;
}
```

标准化结果：

```ts
interface NormalizedLlmResult {
  providerResponseId?: string;
  providerProfileId: string;
  modelId: string;
  content: string;
  finishReason?: string;
  usage?: NormalizedLlmUsage;
}
```

### 8.3 媒体 Connector

图片、视频继续使用各自的提交和任务状态模型：

- 图片：同步或短任务生成。
- 视频：提交、远程任务 ID、轮询、取消和恢复。
- 媒体 Adapter Schema 不与 LLM 请求 Schema 强行合并。
- 共用的只有供应商连接、凭据引用、模型目录和错误分类基础结构。

## 9. LLM 调用链重构

当前 Worker 直接持有密钥并读取 SSE。新结构中密钥不得进入 Worker，因此生成生命周期调整为：

```text
llm.generation.prepare
→ tauri.llm_stream
→ llm.generation.observe
→ llm.generation.complete
```

失败和取消：

```text
tauri.llm_stream 失败
→ llm.generation.fail

用户取消
→ Tauri Abort
→ llm.generation.cancel
```

### 9.1 `prepare`

Worker 负责：

- 校验项目、会话和写权限。
- 编译上下文。
- 保存上下文快照。
- 保存用户消息。
- 创建流式助手消息。
- 创建 Generation 和 Attempt。
- 固定供应商、模型和价格快照。
- 返回不包含密钥的标准化请求信封。

### 9.2 Tauri 流式执行

Tauri 负责：

- 根据 `providerProfileId` 解析连接。
- 读取 Windows 安全凭据。
- 构造协议请求。
- 处理首字节、空闲和总超时。
- 解析 SSE 或其他流式协议。
- 通过 Tauri Channel 向 Desktop 推送 Delta、完成、usage 和错误事件。
- 不记录请求正文、Authorization 或完整响应。

### 9.3 `observe`

Desktop 聚合增量后向 Worker 批量提交：

- 最多每 250ms 一次，或累计 512 字符时提交。
- 每次提交同时携带项目 ID、会话 ID、Generation ID 和 Attempt ID。
- 过期项目、会话或 Generation 的回调不得写入当前项目。

### 9.4 `complete` / `fail` / `cancel`

- 只有收到协议定义的成功终止事件才能完成。
- 截断流、缺少终止事件、解析失败不得降级为成功。
- 终态必须持久化完整或已接收的部分文本。
- 使用量和价格快照在终态事务中保存。
- 重试使用原始用户消息，但创建新的助手消息或明确的新 Attempt，不能覆盖旧费用。

## 10. 使用量与费用

### 10.1 标准用量字段

```ts
interface NormalizedLlmUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  totalTokens?: number;
  raw?: Record<string, unknown>;
}
```

规则：

- Token 数据必须来自供应商返回值。
- 缺少 usage 时显示“供应商未提供用量”。
- 不用上下文预算估算值代替结算使用量。
- Reasoning Token 默认仅展示；如果已经包含在 Output Token 中，不重复收费。
- Chat Completions 中转站不支持流式 usage 时，费用显示未知。
- 如果供应商直接返回费用，另存为 Provider Reported Cost，不覆盖用户单价计算值。

### 10.2 用户定价

每个模型配置：

```text
货币
输入价格 / 100万 Token
缓存输入价格 / 100万 Token
输出价格 / 100万 Token
```

缓存输入价格未填写时，默认按普通输入价格计算。

### 10.3 计算公式

```text
普通输入 Token = max(输入 Token - 缓存输入 Token, 0)

估算费用 =
普通输入 Token / 1,000,000 × 输入单价
+ 缓存输入 Token / 1,000,000 × 缓存输入单价
+ 输出 Token / 1,000,000 × 输出单价
```

### 10.4 UI 展示

消息底部：

```text
输入 12,480 · 缓存 8,000 · 输出 2,160 · 预计 ¥0.0837
```

详情展开：

- 供应商连接和模型。
- 开始时间、首字延迟和总耗时。
- Token 明细。
- 使用的价格快照。
- Provider Reported Cost（如果存在）。

使用量页面：

- 今日、本周、本月和自定义日期。
- 按供应商、模型、项目、状态汇总。
- 成功、失败、取消分别统计。
- CNY、USD 分开显示。
- 不自动获取汇率。

## 11. UI 组件计划

为了避免继续扩大 `App.tsx` 和 `ProductionPanel.tsx`，仅拆分本次会触及的职责：

```text
apps/desktop/src/
├─ components/
│  ├─ ProjectNavigation.tsx
│  ├─ ProductionNavigation.tsx
│  ├─ SettingsCenter.tsx
│  ├─ ChatPanel.tsx
│  └─ production/
│     ├─ ProviderModelSelectors.tsx
│     ├─ ParameterForm.tsx
│     ├─ GenerationActions.tsx
│     └─ VideoTaskCenter.tsx
├─ settings/
│  ├─ ProviderConnectionsView.tsx
│  ├─ ProviderEditor.tsx
│  ├─ ModelManagementView.tsx
│  └─ UsageDashboard.tsx
├─ provider-profile-client.ts
├─ llm-client.ts
└─ usage-client.ts
```

第一轮拆分保持现有 CSS 和行为，不同时引入新的样式框架。

## 12. 生产导航行为

### 12.1 状态归属

`selectedCapability` 提升到 `App`，与 `WorkspaceView` 分开：

- `WorkspaceView` 控制中央项目内容。
- `selectedCapability` 控制右侧生产参数。
- 切换生产方式不切走当前文档或镜头。

### 12.2 交互规则

- 点击一级菜单展开或收起。
- 第一次进入分类时选择第一个可用能力。
- 再次进入时恢复该分类上次使用的能力。
- 当前二级菜单和所属一级菜单都显示活动态。
- 支持键盘聚焦、Enter、Space 和 `aria-expanded`。
- 无项目时菜单可显示；生成操作仍受项目和写权限限制。

### 12.3 ProductionPanel

- 删除现有“生产方式”下拉框。
- 标题显示例如“图片制作 / 文生图”。
- 供应商选择改为供应商连接，而不是供应商品牌字符串。
- 模型只显示当前连接中支持当前能力且已启用的模型。
- 没有连接时显示“前往添加供应商”。
- 当前直接编辑密钥的区域迁移到设置中心。

### 12.4 窄屏

小于 660px 时左栏当前被隐藏，因此：

- 桌面端仅使用左侧生产菜单。
- 窄屏在参数标题提供“制作方式”按钮。
- 按钮打开紧凑抽屉或弹出菜单。
- 不恢复桌面端原有大型下拉框。

## 13. 实施阶段

## 阶段 P0：环境与基线

任务：

- [x] 确认 Node.js、pnpm、Rust、Cargo 可用。
- [x] 解决当前环境 `cargo metadata: program not found`。
- [x] 记录当前 typecheck、LLM、Worker、Desktop 和 Rust 测试基线。
- [x] 标记已有失败，避免归因到新改动。

门禁：

- Rust 单元测试可以执行。
- 当前测试基线有可复现记录。

## 阶段 P1：行为保持型组件拆分

任务：

- [x] 抽出设置中心外壳。
- [x] 抽出生产导航组件。
- [x] 抽出聊天面板。
- [x] 拆出 ProductionPanel 中本次会修改的子区域。
- [x] 保持现有 DOM 行为和测试选择器稳定。

门禁：

- App 和 ProductionPanel 现有测试通过。
- 不改变 Worker、数据库和网络接口。

## 阶段 P2：应用级配置数据库

任务：

- [x] 新增独立 App Schema 和迁移器。
- [x] 新增供应商、模型、价格、默认项 Repository。
- [x] Tauri 启动 Worker 时传入稳定 App Data 路径。
- [x] 添加 WAL、busy timeout、完整性和迁移测试。

门禁：

- 未打开项目时可读写应用设置。
- 应用设置数据库不含密钥。
- 应用数据库与项目数据库迁移互不影响。

## 阶段 P3：安全凭据与供应商 CRUD

任务：

- [x] 凭据目标切换为连接 UUID。
- [x] 实现 Profile list/get/create/update/archive/delete。
- [x] 实现 Credential status/set/delete。
- [x] 实现 UUID、连接归属和状态校验。
- [x] 将 Tauri `lib.rs` 拆出凭据和网络模块。

门禁：

- 同一供应商两个连接的密钥完全隔离。
- 删除一个连接不影响另一个。
- 密钥不出现在数据库、日志和诊断包。

## 阶段 P4：连通性测试与模型同步

任务：

- [x] 建立官方供应商定义注册表。
- [x] 建立协议 Connector 注册表。
- [x] 实现保存并测试状态机。
- [x] 实现模型同步、合并、失效标记和手动添加。
- [x] 实现错误分类：认证、限流、超时、URL、TLS、协议和服务器错误。

门禁：

- 测试失败保留配置。
- 已成功连接临时同步失败时保留旧模型。
- 未知模型不会被错误标记为支持全部能力。

## 阶段 P5：设置中心 UI

任务：

- [x] 实现供应商连接列表和详情。
- [x] 实现官方/自定义添加向导。
- [x] 实现测试、同步、停用、删除。
- [x] 实现模型启用、能力、角色和单价配置。
- [x] 实现无项目可用状态。

门禁：

- 密钥输入保存后立即清空。
- UI 不回显完整密钥。
- 连接状态和模型同步状态分开显示。

## 阶段 P6：生产导航和媒体供应商整合

任务：

- [x] 将 Capability 提升到 App。
- [x] 新增图片制作和视频制作一级菜单。
- [x] 删除右侧生产方式下拉框。
- [x] ProductionPanel 改用 Provider Profile 和启用模型。
- [x] 将区域和凭据配置迁移到供应商连接。
- [x] 增加窄屏制作方式入口。

门禁：

- 六种能力均能正确切换。
- 左侧活动项与右侧参数一致。
- 同一供应商多个连接可分别选择。
- 草稿不跨镜头、连接、模型和能力串用。

## 阶段 P7：LLM Connector 和生成生命周期

任务：

- [x] 将当前单例 Provider 改为按 Profile 和模型解析。
- [x] 实现 OpenAI Responses Connector。
- [x] 实现 OpenAI-compatible Chat Completions Connector。
- [x] 新增 prepare/observe/complete/fail 生命周期。
- [x] Tauri 使用 Channel 推送流式事件。
- [x] 保留批量持久化、取消、恢复和重试语义。

门禁：

- 密钥不进入 Worker。
- 截断流不能标记成功。
- 项目或会话切换后旧回调不能污染当前 UI 或数据库。
- 取消和重试均产生稳定终态。

## 阶段 P8：使用量、定价和费用

任务：

- [x] 项目 Schema 升级到 v7。
- [x] 解析和归一化 Responses 与 Chat Completions usage。
- [x] 实现十进制费用计算。
- [x] 保存价格快照。
- [x] 消息底部显示 Token 和估算费用。
- [x] 实现使用量与费用页面。
- [x] 建立跨项目用量索引和重建路径。

门禁：

- 修改价格不改变历史费用。
- 重试分开计费。
- 缓存 Token 不重复收费。
- 缺少 usage 时不显示虚假费用。
- 多币种不错误合并。

## 阶段 P9：迁移、兼容和发布验证

任务：

- [x] 迁移旧 `vidu` 和 `vidu-cn` 安全凭据。
- [x] 建立对应国际站和中国站连接。
- [x] 保留 OpenAI 环境变量兼容入口。
- [x] UI 标记环境变量连接为旧版配置。
- [x] 提供用户重新输入密钥并迁移到安全存储的路径。
- [x] 运行完整 typecheck、lint、tests、Rust tests 和 build。

门禁：

- 升级后原有生成能力不会无提示失效。
- 迁移失败可安全回退。
- 安装包环境中供应商、模型和用量功能可用。

## 14. 状态机

### 14.1 供应商连接

```text
draft
→ saving
→ testing
→ ready
→ sync_failed
→ disabled
→ archived

testing → auth_failed
        → network_failed
        → protocol_failed
```

连接曾经进入 `ready` 后，临时同步失败不应清空旧模型或直接变为不可用；应保存最后成功时间并标记模型目录可能过期。

### 14.2 LLM Attempt

```text
prepared
→ streaming
→ complete
→ failed
→ cancelling
→ cancelled
→ interrupted → failed/recovered
```

每个非终态都必须在取消、超时、Worker 重启、应用退出或项目切换后进入可解释终态。

## 15. 测试计划

### 15.1 单元测试

- Provider Profile UUID、CRUD 和归档。
- Windows Credential Target 拼接和校验。
- 官方 Base URL 锁定。
- 自定义 Base URL 规范化和拒绝规则。
- 模型同步新增、更新、失效和恢复。
- 未知模型能力分类。
- Responses 和 Chat Completions SSE 解析。
- 401、403、404、429、5xx、超时和截断流。
- usage 字段归一化。
- 十进制费用计算。
- 缓存 Token 处理。
- 价格快照和历史费用稳定性。
- 多币种分组。

### 15.2 Worker 测试

- App Settings 数据库与项目数据库隔离。
- Profile 和模型查询权限。
- prepare/observe/complete/fail 生命周期。
- 重复 observe 和 complete 的幂等性。
- 项目切换和会话切换隔离。
- 取消、重试和 Worker 重启恢复。
- Attempt 和消息关联。
- 用量索引幂等写入和重建。

### 15.3 Desktop 组件测试

- 官方供应商添加流程。
- 自定义供应商添加流程。
- 密钥保存后清空。
- 测试失败保留表单数据。
- 模型同步和手动模型。
- 单价输入校验。
- 左侧生产菜单切换。
- 无供应商 CTA。
- 聊天模型选择。
- 消息 Token 与费用显示。
- 390px、1280px、1440px 布局。

### 15.4 Tauri/Rust 测试

- UUID 凭据隔离。
- 不允许任意 Credential Target。
- Base URL 和 Host 校验。
- 禁止跨域重定向泄露 Authorization。
- 请求体和响应体限制。
- Tauri Channel 取消和终态。
- 流式解析器故障路径。

### 15.5 集成测试

CI 使用本地 Mock Provider，不访问真实外部服务：

- 正常模型列表。
- 不支持模型列表。
- 模型列表过大或格式异常。
- 正常流式生成。
- usage 只在结束事件返回。
- 无 usage。
- 中途断流。
- 取消后 Provider 继续发送数据。
- 连接超时和 TLS 错误。

真实 API 只进行少量人工冒烟测试，不纳入每次 CI。

## 16. 验证命令

阶段内优先运行针对性命令：

```powershell
pnpm --filter @ai-video/contracts build
pnpm --filter @ai-video/persistence test
pnpm --filter @ai-video/llm test
pnpm --filter @ai-video/worker test
pnpm --filter @ai-video/desktop test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

最终门禁：

```powershell
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
pnpm build
```

## 17. 风险与缓解措施

| 风险 | 影响 | 缓解措施 |
|---|---|---|
| 密钥从 Tauri 泄露到 Worker 或日志 | 严重安全问题 | 只传 Profile ID；Tauri 读取密钥；诊断脱敏测试 |
| App 设置库和项目库职责混淆 | 项目迁移和备份失控 | 独立数据库、独立 schema 和 Repository API |
| 动态模型无法映射生产能力 | 模型可见但不能正确调用 | 已知模型映射，未知模型人工分类 |
| 中转站只部分兼容 OpenAI | 连接测试通过但生成失败 | 协议级契约测试、手动模型和实际模型验证 |
| 流式执行从 Worker 迁出后丢失检查点 | 崩溃后内容丢失 | Desktop 批量 observe，保留 250ms/512 字符策略 |
| 重试重复计费或覆盖历史 | 费用统计错误 | 每次重试独立 Attempt 和价格快照 |
| 用户修改价格导致历史金额变化 | 财务记录不稳定 | 生成时固定价格快照 |
| 模型同步失败清空可用模型 | 瞬时网络故障导致功能中断 | 保留最后成功缓存，使用失效标记 |
| 自动故障切换泄露项目上下文 | 隐私和费用不可控 | 第一版禁止；后续必须用户显式配置 |
| Cargo 环境缺失导致 Rust 改动不可验证 | Tauri 功能无法交付 | P0 先解决 Rust/Cargo 环境 |

## 18. 第一版明确不做

- 一个连接内多个密钥的自动轮换。
- 自动跨供应商故障切换。
- 智能模型路由和自动比价。
- 自动在线汇率。
- 用户自定义任意 HTTP 路径、Header 和请求模板。
- 未知模型自动猜测全部能力。
- Anthropic、Gemini 和 Ollama 的正式实现。
- 供应商账单对账和充值余额管理。

这些功能可以在基础注册中心、Connector 和 Usage 数据稳定后单独规划。

## 19. 阶段交付原则

- 每个阶段独立提交，不将多个高风险阶段混在同一个提交中。
- 每个阶段提交必须包含实现、测试和必要文档更新。
- 不通过当前阶段门禁时，不开始依赖它的正式功能。
- 只运行与当前阶段相关的快速测试；完整测试和构建在最终门禁执行。
- 真实外部 API 验证不能被 Mock 替代，但不应成为日常 CI 的不稳定依赖。
- 所有新增错误消息必须可操作、经过脱敏并设置长度上限。

## 20. 推荐执行顺序

```text
P0 环境与基线
→ P1 组件边界
→ P2 应用配置数据库
→ P3 安全凭据和 Profile CRUD
→ P4 Connector、连通性和模型同步
→ P5 设置中心 UI
→ P6 生产导航和媒体整合
→ P7 LLM 流式执行重构
→ P8 使用量、定价和费用
→ P9 迁移、兼容和发布验证
```

该顺序优先解决数据所有权和凭据边界，再增加 UI 和动态执行能力，可最大限度减少返工和安全风险。
