# Agent 与小说章节写入架构重构实施计划

> 2026-10-12 用户决策更新：普通会话的语义、否定、目标与步骤拆解由正常 LLM 轮次判断，Desktop/Worker 不按提示词关键词预建目标、阻断请求或限制工具。以下旧 Intent Resolver/pending intent/前端分章规则对普通会话不再适用。Worker 保留结构化参数、真实 ID、CAS、审核锁、幂等、预算和真实高风险/付费确认。当前实现与验证见 [LLM 语义判断与结构化执行](./LLM-INTENT-EXECUTION-PLAN.md)。


版本：1.0  
日期：2026-10-10  
状态：实施中  
范围：Desktop、Worker、Contracts、Persistence、Context、Pi Runtime

## 1. 目标

本计划解决统一会话 Agent 在小说章节、项目文档和按需检索之间的路由漂移问题。目标是让一次用户请求从意图解析到业务结果始终使用同一份可信任务定义：

```text
用户消息
  -> Worker 意图解析
  -> 持久化 Intent
  -> 类型确定的 Agent Task
  -> 冻结 Tool Manifest
  -> 唯一 Agent Runtime
  -> Worker Domain Command
  -> 事务化产物提交
  -> 事件驱动的任务终态
```

本次重构必须保证：

- “生成/续写/重写小说章节”只能写入 `novel_chapters` 及其关联文档版本。
- 小说章节任务必须授权 `novel.chapter.submit_draft`，不得退回 `document.create_draft`。
- 普通项目文档任务不得伪装成小说章节任务。
- Agent 的自然语言完成说明不能替代 Worker 的持久化结果。
- Worker 重启、Provider 中断、取消和重复请求不会把小说任务降级成普通文档任务。
- `library.search/read` 继续按需工作；普通会话不自动注入小说正文、草稿或章节全文。
- 检索结果按来源对象和版本去重，并保留 `draft/published` 状态。
- Desktop 只提供用户消息和明确页面上下文；Worker 持有业务意图、目标、权限和完成条件的最终解释权。

## 2. 当前问题基线

2026-10-10 对实际项目 SQLite 的审计记录：

- 一次任务已经创建 `novel-chapter` 目标，但 Provider 只获得 `project.get_context`、`library.search` 和 `library.read`，没有获得 `novel.chapter.submit_draft`，最终以 `AGENT_CHAPTER_NOT_WRITTEN` 失败。
- 下一次同类请求退回 `agentMode=document` 和 `document.create_draft`，把第一章正文保存成 `outline` 文档。
- Worker 重启将运行中的 Agent 标记为 interrupted，恢复后没有沿用原始业务目标。
- 同一个小说大纲的 `library.search` 返回 14 个重复来源切片，增加了模型歧义和检索预算消耗。
- Desktop、Handler、AgentOrchestrationService、AgentProviderLoopService 和 Pi Runtime 各自保留部分意图和路由逻辑，存在多个事实源。

## 3. 冻结的不变量

### 3.1 意图与任务

- 一个用户请求只能创建一个主 Intent 和一个主 Agent Task；重复请求必须通过幂等键复用或明确创建新任务。
- Intent 必须记录 `operation`、`targetKind`、`targetId`、`projectSessionId`、来源消息、解析版本和确认状态。
- `novel-chapter`、`novel-reference`、`document`、`media-task` 是互斥目标类型。
- Intent 未达到唯一目标和副作用策略要求时，只能返回 `pending_intent`，不得创建业务占位、Agent Task 或写入授权。

### 3.2 工具授权

- Tool Manifest 在任务启动时按目标类型冻结，并与 Provider step 一起持久化。
- `novel-chapter` 任务必须包含 `library.search`、`library.read` 和 `novel.chapter.submit_draft`，不得包含 `document.create_draft`。
- `document.create_draft` 不得写入小说章节正文；`documentKind=outline/scene/note` 不能替代章节实体。
- 模型不能提交项目 ID、任务 ID、章节 ID、文档 ID、版本 ID、状态、路径或权限字段；这些字段由 Worker 从 Intent 注入。

### 3.3 完成与恢复

- 章节任务只有在目标章节产生符合约束的工作版本后才能进入 `waiting_review`。
- Tool call 成功只代表 Domain Command 成功，不代表整个任务完成；任务终态由产物和任务状态共同决定。
- Worker 重启后恢复同一 Task、Intent、目标和 Tool Manifest；不得根据最新自然语言重新分类。
- 取消或失败时，没有正式工作版本的 `reserved` 章节必须归档；已有工作版本必须保留并进入审核或恢复路径。

### 3.4 检索

- 同一项目、来源类型、来源 ID、版本 ID只返回一个最佳命中来源；切片位置作为命中元数据保留。
- 检索结果必须标记 `draft`、`published` 或其他来源状态。
- 检索只读，不会自动创建文档、章节或任务。

## 4. 实施阶段

### P0：基线与观测

- [x] 保存现有架构审计结论、真实 SQLite 日志证据和失败任务样本。
- [ ] 增加统一任务/工具/产物状态的诊断查询。
- [ ] 记录当前未提交工作区边界，避免将无关 UI 改动混入重构。

完成标准：可以从一个任务 ID 查询 Intent、目标、授权工具、工具调用、产物和最终状态。

### P1：单一 Intent Resolver

- [x] 在 Worker 建立版本化 `AgentIntent` 解析结果。
- [x] 将 Desktop 的小说正则识别降级为页面提示，不再作为业务真相。
- [x] 将 Handler 的自然语言兜底解析收敛到 Worker Resolver。
- [x] 明确区分小说大纲、小说资料、小说章节正文和普通项目文档。
- [x] 不明确或目标不唯一时只产生 `pending_intent`。

完成标准：同一原始请求在 `agent.run` 和 `agent.generation.prepare` 中得到相同的 Intent；普通“生成小说大纲”不会创建章节任务。Worker 兜底和章节编排回归已通过。

### P2：冻结 Task 与 Tool Manifest

- [x] 为 Agent Task 持久化 Tool Manifest 和主操作；目标类型仍通过已有 `agent_task_targets` 与请求快照关联。
- [ ] 统一 `agent.run` 与 `agent.generation.prepare` 的任务创建入口。
- [x] 根据目标类型生成最小工具集合。
- [x] 章节任务的主授权必须是 `novel.chapter.submit_draft`；章节任务不会把通用文档创建作为主操作。
- [x] Provider step 恢复时只使用持久化授权清单，不重新授权主操作；工具清单快照用于审计和漂移检测。

完成标准：章节任务的模型可见工具清单包含章节提交工具，且不包含通用文档创建工具；重启后清单不变。

### P3：强类型 Domain Command 与完成判定

- [ ] 将章节提交收敛为唯一 Worker Domain Command。
- [ ] 将章节正文、章节标题、版本 CAS、任务目标校验放入同一事务。
- [x] 章节写入成功后任务立即进入 `waiting_review`；Provider 文本不能单独把章节任务标为完成。
- [ ] 错误文档 fallback 改为显式失败，不再静默保存为 outline/note/scene。

完成标准：章节提交成功后才进入 `waiting_review`；章节工具未执行时任务必然失败或等待，不会成功结束。

### P4：唯一 Agent Runtime

- [x] 明确 Pi Runtime 为生产唯一运行时。
- [x] 旧 Native Agent 循环保留为兼容接口；新任务不会再由环境变量切回旧运行时。
- [ ] 统一取消、重启恢复、Provider step、工具结果和终态事件。
- [x] 新任务的运行时选择不再依赖 `agentMode`；`agentMode` 只保留在历史请求快照中。

完成标准：普通项目、小说、文档、研究和媒体请求均从同一 Runtime 进入；任务恢复不改变目标类型和授权。

### P5：检索去重与来源稳定性

- [x] 按来源对象和版本去重搜索结果。
- [x] 同一来源保留最高分切片和稳定的 `chunkOrdinal/startOffset/endOffset`。
- [x] 重复来源、草稿/正式版本并存和章节定位回归测试已存在并通过。

完成标准：一个大纲不会返回 14 个相同来源；章节检索仍能正确命中并读取正文。

### P6：旧数据迁移与人工恢复

- [x] 对历史 `document.kind=outline` 但标题呈章节形态的记录只做诊断标记，不自动改变用户数据。
- [ ] 对无版本的 `reserved` 章节保持归档状态，提供可审计恢复入口。
- [ ] 对错误完成的旧 Agent Task 保留历史状态，新增纠正事件，不覆盖原始审计。
- [x] 增加只读项目级诊断脚本，展示可疑章节文档、孤儿章节、未完成任务和重复来源；不自动修改项目数据。

完成标准：旧项目可打开，历史记录不丢失，用户能明确看到哪些内容是文档草稿、哪些是小说章节。

### P7：质量门禁与验收

- [x] Worker 章节端到端测试：自然语言请求、Intent、Task、Tool Manifest、章节版本、waiting_review。
- [ ] Worker 重启、取消、Provider 中断和重复请求测试。
- [ ] Desktop 小说页选择章节、生成本章、错误提示和结果回跳测试。
- [x] 全仓 `pnpm test`、`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`。
- [ ] 真实开发环境重启 Worker 后复验一次章节写入。

完成标准：所有阶段不变量有自动化证据；真实 Provider 未验证时继续保持发布 `HOLD`。

## 5. 验收场景

1. “生成小说第一章草稿”且当前没有章节：创建 `reserved` 章节任务，模型获得 `novel.chapter.submit_draft`，成功后生成章节工作版本。
2. “续写第一章”：唯一目标锁定当前章节，冻结基础版本，生成新工作版本。
3. “生成小说大纲”：创建 `novel-reference`/outline 文档，不创建章节。
4. “保存刚才的正文”：只有当前会话存在唯一可恢复正文且用户目标明确时才进入章节写入；否则澄清。
5. Worker 在模型调用中重启：恢复原 Task 和 Tool Manifest，不转为 document task。
6. 搜索大纲：结果按来源版本去重，草稿状态明确显示。

P6 诊断命令：

```powershell
node scripts/inspect-agent-project.mjs "C:\path\to\project.sqlite"
```

该命令只读数据库，输出完整性、文档、章节、可疑章节文档、孤儿占位、Agent Task、工具调用和重复来源。

## 6. 质量门禁记录

| 日期 | 阶段 | 验证 | 结果 |
|---|---|---|---|
| 2026-10-10 | 审计 | 两份项目 SQLite、会话消息、Agent Task、Tool Call、文档和章节表 | 已确认小说任务缺少章节工具、普通文档误写和 Worker 重启中断 |
| 2026-10-10 | P2/P5 | Worker 构建；章节 Agent 定向测试；全仓 `pnpm test`、`pnpm build`、`pnpm lint`、`pnpm format:check`、`git diff --check` | Tool Manifest 冻结、章节主操作约束、检索去重和章节读取回归通过；P2/P5 仍有后续 Runtime/迁移工作 |
| 2026-10-10 | P3 | 章节 Provider loop 定向测试：章节正文提交后任务状态为 `waiting_review`，缺少章节提交时拒绝终态完成 | 通过 |
| 2026-10-10 | P1/P2/P3/P5/P7 | Worker 506 项、Desktop 269 项及其他 workspace 测试通过；`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check` 通过 | 代码门禁通过；Worker 重启后的真实桌面写入仍待人工复验 |
| 2026-10-10 | P4 | Pi Runtime 选择测试、Pi 对话测试和 Worker/桌面构建通过；旧运行时环境变量不再切换新任务的生产 Runtime | 通过；旧 Native 接口保留兼容，恢复与取消的真实重启演练待人工复验 |

## 7. 设计决策

- 运行时资料继续保存在项目 SQLite；GitHub 只管理代码和审查。
- 普通会话不会自动注入小说正文；小说章节通过 `library.search/read` 按需获取。
- 章节提交、文档草稿、发布和归档继续使用不可变版本、CAS 和事务。
- 现有错误数据保留并可诊断，不做无提示破坏性修复。
