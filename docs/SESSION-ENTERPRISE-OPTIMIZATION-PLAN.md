# 会话功能企业级优化实施计划

版本：0.2

日期：2026-08-15

状态：实施中

## 1. 计划目的

本计划针对项目、场次、镜头三级会话，以及会话消息、上下文编译、LLM 生成和项目切换之间的支撑链路，补齐企业级应用所需的可靠性、可恢复性、可观测性和可维护性。

当前实现已经具备以下基础能力：

- 三级会话作用域和项目归属校验；
- 会话消息持久化、分页和流式状态；
- LLM 生成、取消、失败和重试；
- 上下文来源追踪和生成快照；
- 项目读写锁、只读降级和 Worker 重启修复；
- Worker、Desktop、Persistence 和 Context 的自动化测试。

本计划不改变“本地优先、项目数据保存在本地 SQLite、GitHub 只管理代码和评审”的总体架构。

## 2. 当前基线和主要问题

代码审查重点：

| 问题 | 现状 | 影响 |
|---|---|---|
| IPC 参数校验 | `handler.ts` 对大量参数使用类型断言 | 非法请求可能进入业务层，错误码不稳定 |
| 生成状态 | generation 运行态主要保存在内存 `Map` | Worker 重启后无法按 generation ID 查询完整状态 |
| 项目会话身份 | 异步回写主要校验 `projectId` | 关闭后重新打开同一项目时缺少 session epoch 隔离 |
| 请求并发 | Worker 使用全局串行队列 | 备份、下载等长任务会阻塞聊天和会话请求 |
| 数据库约束 | 会话作用域和消息状态约束不完整 | 业务规则无法由数据库最终兜底 |
| 会话排序 | 会话列表只按 `created_at` 排序 | 同时间戳顺序不稳定，默认会话可能不是最近使用会话 |
| 错误治理 | 部分普通异常统一映射为 `INTERNAL_ERROR` | 前端无法稳定判断重试、刷新或用户输入错误 |
| 数据治理 | 上下文快照缺少保留和清理策略 | 项目内容可能长期累积，增加隐私和存储风险 |
| 可观测性 | 主要保留有限的内存诊断事件 | 无法定位请求耗时、队列拥塞和 Provider 性能问题 |
| 工程维护 | `App.tsx`、`handler.ts` 过大，领域状态类型偏宽 | 变更风险和回归成本持续上升 |

相关代码入口：

- [apps/worker/src/handler.ts](../apps/worker/src/handler.ts)
- [apps/worker/src/generation-service.ts](../apps/worker/src/generation-service.ts)
- [apps/worker/src/content-service.ts](../apps/worker/src/content-service.ts)
- [apps/worker/src/index.ts](../apps/worker/src/index.ts)
- [packages/persistence/src/schema.ts](../packages/persistence/src/schema.ts)
- [apps/desktop/src/App.tsx](../apps/desktop/src/App.tsx)

## 3. 目标架构原则

### 3.1 业务不变量

1. 所有会话、消息、生成、上下文快照必须归属明确的项目。
2. 所有异步回写必须同时校验项目会话身份、项目 ID、会话 ID 和业务任务 ID。
3. 终态只能由合法状态转换进入，重复终态请求必须幂等。
4. 普通聊天消息不能隐式修改正式文档、记忆或生产约束。
5. Provider 未返回协议定义的成功终止事件时，不得标记生成成功。
6. 约束不能因 token 预算、摘要或排序被静默丢失。
7. 所有外部输入必须先通过运行时 Schema 校验，再进入领域服务。
8. 诊断、日志、快照和导出内容不得包含凭据、签名 URL 或未受控的大块敏感数据。

### 3.2 生成状态机

```text
prepared -> streaming -> complete
                    -> failed
                    -> cancelled

prepared/streaming -> interrupted -> failed
```

约束：

- `complete`、`failed`、`cancelled`、`interrupted` 为终态；
- 终态不可被重新改写为活动态；
- `complete` 只能在收到协议成功终止事件后进入；
- 重试创建新的 generation/attempt，但复用原始 user message；
- 同一幂等键的重复请求返回第一次请求的结果，不重复写入消息或调用 Provider。

### 3.3 项目会话身份

运行时新增不可复用的 `projectSessionId` 或 `sessionEpoch`。所有长生命周期对象携带：

```text
projectSessionId
projectId
conversationId
generationId
attemptId
```

`projectId` 表示项目实体，`projectSessionId` 表示一次打开项目的运行时会话。关闭并重新打开同一项目后，二者必须不同。

## 4. 实施阶段总览

| 阶段 | 目标 | 优先级 | 进入条件 | 退出门禁 |
|---|---|---:|---|---|
| P0 | 固化契约、错误和不变量 | P0 | 计划审核通过 | Schema、错误码、状态矩阵评审通过 |
| P1 | IPC 运行时校验和输入边界 | P0 | P0 完成 | 非法请求无法进入 Service，契约测试通过 |
| P2 | 持久化 generation 和幂等状态机 | P0 | P1 完成 | 重启、重复回调、取消和重试测试通过 |
| P3 | 项目 session epoch 和并发模型 | P0 | P2 完成 | 旧回调无法污染新会话，长任务不阻塞普通 IPC |
| P4 | 数据库约束、会话管理和上下文治理 | P1 | P3 完成 | 迁移、排序、分页、清理和恢复验证通过 |
| P5 | 可观测性、测试和桌面端拆分 | P1 | P4 完成 | 质量门禁和回归证据齐全 |
| P6 | 企业级维护和发布治理 | P2 | P5 完成 | 文档、依赖、签名、备份和发布检查通过 |

阶段必须按顺序推进。除 P0 方案验证外，不提前把后续阶段的临时代码并入主流程。

## 5. P0：固化契约、错误和不变量

### 5.1 工作项

- 建立 `docs/adr/` 下的会话状态机、项目会话身份和幂等策略 ADR；
- 确定消息、generation、attempt 的状态转换矩阵；
- 确定所有文本字段的长度上限、分页上限和快照大小上限；
- 定义稳定错误码、用户可见消息、重试策略和内部诊断信息的分层；
- 确定新增 IPC 字段：`projectSessionId`、`idempotencyKey`、`version`；
- 明确会话管理范围：重命名、归档、软删除、搜索和分页是否进入本轮。

### 5.2 产物

- 本文档审核版；
- 状态转换矩阵；
- IPC 错误码表；
- 输入限制表；
- 数据迁移和回滚方案；
- ADR 至少三份：状态机、session epoch、幂等。

### 5.3 验收标准

- 每个状态均有合法前置状态、触发操作、持久化位置和终态；
- 每个错误码均有客户端行为定义；
- 不存在“先实现、后补状态机”的未定义路径；
- 产品范围和暂不实现项获得审核确认。

## 6. P1：IPC 运行时 Schema 和输入边界

### 6.1 实施内容

建议在 `packages/contracts` 增加运行时 Schema 层，例如：

```text
packages/contracts/src/runtime/
  conversation-schemas.ts
  message-schemas.ts
  generation-schemas.ts
  worker-request-schemas.ts
```

为以下方法优先增加 Schema：

- `conversation.list`
- `conversation.create`
- `chat.message.list`
- `chat.message.save`
- `chat.message.toDocument`
- `chat.message.toMemory`
- `chat.message.toConstraint`
- `context.preview`
- `llm.generation.prepare`
- `llm.generation.runtime`
- `llm.generation.observe`
- `llm.generation.complete`
- `llm.generation.fail`
- `llm.generation.cancel`
- `llm.generation.retry`

### 6.2 规则

- 拒绝未知字段；
- 对 UUID、scope、状态、角色和枚举做严格校验；
- 对消息、prompt、错误文本设置长度上限；
- 限制分页 `limit` 和 cursor 大小；
- 拒绝 NaN、Infinity、负 token、异常时间格式；
- 错误统一返回 `INVALID_REQUEST` 或 `INVALID_PARAMETERS`；
- Schema 校验结果不得将原始凭据或超长内容写入诊断日志。

### 6.3 测试

- 每个会话 IPC 方法至少包含一组合法参数和一组非法参数测试；
- 超长消息、未知字段、非法枚举、错误 UUID、缺失 scopeId；
- malformed JSON 后 Worker 仍可处理下一条请求；
- HTTP 和 stdio 两种入口使用同一套校验逻辑。

## 7. P2：持久化 generation 和幂等状态机

### 7.1 数据库设计

新增数据库迁移，建议增加 `llm_generations` 主表：

```text
llm_generations
  generation_id PRIMARY KEY
  project_id
  project_session_id
  conversation_id
  snapshot_id
  user_message_id
  assistant_message_id
  status
  execution_mode
  retry_of_generation_id
  idempotency_key
  error_code
  error_message
  created_at
  updated_at
  version
```

现有 `llm_generation_attempts` 保留为一次 Provider 尝试的明细表，并通过外键关联 generation。

迁移要求：

1. 先创建新表和索引；
2. 从已有 attempts 和 chat messages 回填 generation；
3. 对无法完整回填的记录写入明确的 `interrupted` 或 `failed` 状态；
4. 在事务中完成约束和版本登记；
5. 迁移前自动备份，失败时保持原数据库可打开；
6. 提供迁移后完整性检查和回滚验证。

### 7.2 代码结构

新增独立的 `GenerationStateMachine`，负责：

- 校验状态转换；
- 生成版本号；
- 条件更新；
- 幂等响应；
- 恢复中断状态；
- 生成查询和重试关联。

`GenerationService` 负责业务编排，不再以进程内 `Map` 作为唯一事实来源。

### 7.3 幂等规则

- `prepare`、`retryPrepare` 接受客户端幂等键；
- 同一 generation 的 `complete/fail/cancel` 重复调用返回已有终态；
- 不同 attempt 的回调必须校验 attempt ID；
- 旧版本内容、旧版本状态和非单调流内容必须拒绝；
- 重试不得重复插入原始 user message。

### 7.4 验收测试

- Worker 重启后可通过 `llm.generation.get` 获取终态；
- 完成事件重复发送不重复计费、不重复写入；
- 失败后重复取消不改变终态；
- 旧 attempt 的完成回调不能覆盖新 attempt；
- 数据库写入成功但 UI 回包丢失时可安全重试；
- 生成状态与 assistant message 状态始终一致。

## 8. P3：项目 session epoch 和并发模型

### 8.1 session epoch

在 `ProjectService` 中为每次 `create/open` 生成新的运行时 session ID，并在 `close` 时使其失效。

必须纳入校验的路径：

- LLM native stream 回调；
- legacy LLM 轮询；
- 项目切换、关闭和恢复；
- 图片和视频后台下载；
- 上下文快照和摘要缓存写入；
- Desktop 的 generation polling 和消息合并。

### 8.2 并发模型

移除“所有请求共享一个全局串行队列”的模型，改为：

- 轻量读请求并发执行；
- 同一项目的数据库写入由项目级写锁保护；
- Provider 请求、备份、导出和媒体下载进入后台任务池；
- 每类任务配置并发上限、超时、取消和重试策略；
- IPC 请求只等待短事务，不等待大文件下载；
- 所有后台任务有持久化任务 ID 和状态查询入口。

### 8.3 验收测试

- 图片下载期间会话列表和消息加载仍可响应；
- 备份期间 LLM 取消不会无限等待；
- 关闭项目后旧回调无法写入重新打开的同一项目；
- 快速切换项目、场次、镜头和会话时，过期结果不会覆盖当前 UI；
- 并发请求下数据库不出现锁错误、丢更新或跨项目写入。

## 9. P4：数据库约束、会话管理和上下文治理

### 9.1 数据库约束

- 为会话作用域增加 `CHECK` 约束；
- 对 `project` 会话禁止非空 `scope_id`；
- 对 `scene/shot` 会话要求非空 `scope_id`；
- 对消息角色和状态增加组合约束；
- 对 generation、attempt、message 增加必要的唯一索引；
- 所有更新增加版本号或条件更新；
- 对外键、项目归属和回复关系增加完整性测试。

### 9.2 会话管理能力

建议补齐以下 IPC：

- `conversation.update`：重命名、标题更新；
- `conversation.archive`：软归档；
- `conversation.delete`：软删除并保留恢复能力；
- `conversation.search` 或扩展 `conversation.list`：关键字、时间和状态筛选；
- `conversation.list`：游标分页和明确排序规则。

默认排序建议：

```sql
ORDER BY updated_at DESC, id DESC
```

### 9.3 上下文快照治理

- 区分摘要缓存和生成快照；
- 生成快照记录来源版本、generation ID 和创建原因；
- 增加按项目清理、按时间清理和数量上限；
- 诊断导出默认不包含完整上下文正文；
- 对敏感项目提供清理前确认和可恢复备份；
- 明确快照是否进入项目导出、备份和恢复范围。

## 10. P5：错误、可观测性和测试体系

### 10.1 错误治理

建立统一错误对象：

```text
code
message
retryable
requestId
operation
details
```

对外消息和内部诊断消息分离。内部消息可以包含堆栈和 Provider 细节，但不得返回凭据、绝对路径、签名 URL 或完整请求正文。

### 10.2 可观测性

至少记录以下指标：

- IPC 请求总数、失败数和耗时；
- 请求队列长度和等待耗时；
- 会话加载耗时；
- generation 首 Token 延迟和总耗时；
- Provider 错误、取消、重试和超时数量；
- token 使用量和估算成本；
- 数据库事务失败和迁移失败；
- 后台下载失败、恢复和清理结果。

每条记录必须可通过 `requestId`、`generationId`、`attemptId` 和 `projectSessionId` 关联。

### 10.3 测试门禁

新增测试层：

1. 单元测试：状态机、Schema、错误映射、排序和数据治理规则；
2. 契约测试：IPC 合法/非法参数、协议版本和错误响应；
3. 持久化测试：迁移、回滚、重启恢复、CAS 和完整性；
4. 并发测试：重复回调、跨会话回调、队列压力和取消竞争；
5. 集成测试：Desktop-Worker-SQLite 端到端会话流程；
6. 压力测试：长消息、大上下文、多会话和后台任务并发；
7. 安全测试：凭据、签名 URL、路径和诊断输出脱敏。

建议在 CI 增加覆盖率阈值，并对 P0 模块设置更高阈值。覆盖率不能替代失败路径测试，必须保留状态矩阵对应的场景用例。

## 11. P6：可维护性和发布治理

### 11.1 前端和 Worker 拆分

将 `App.tsx` 拆为：

- `useProjectSession`；
- `useConversationSession`；
- `useLlmGeneration`；
- `useContextPreview`；
- `useProviderSelection`；
- `ConversationWorkspace`。

将 `handler.ts` 拆为按领域的 command handler，并统一使用已解析的 DTO，不在业务分支中继续使用 `as unknown as`。

### 11.2 类型和工程约束

- 将 domain 层的 `scopeType: string`、`status: string` 改为受限联合类型；
- 注入 Clock、ID Generator 和随机数源，提升测试确定性；
- 增加依赖漏洞扫描、许可证检查和 SBOM；
- 增加 Windows 签名、升级、回滚和干净安装门禁；
- 统一代码、Schema、迁移版本和文档版本号；
- 增加 API/IPC 兼容矩阵，明确旧 Desktop 与新 Worker 的行为。

### 11.3 文档同步

当前代码 Schema 版本为 v15（包含 generation、Agent 文档工作流、不可变文档审计和会话归档），而部分质量文档仍记录为旧版本。实施过程中必须同步：

- `README.md`；
- `docs/M2-DOCUMENTS-CONVERSATIONS.md`；
- `docs/M3-CONTEXT-LLM.md`；
- `docs/QUALITY-GATES.md`；
- 数据库迁移说明；
- 发布验证记录。

## 12. 里程碑验收清单

### P0/P1

- [x] 状态机和错误码完成评审；
- [x] 所有会话和生成 IPC 接入运行时 Schema；
- [x] 非法参数不会进入 Service；
- [x] 消息和 prompt 有明确大小上限；
- [x] 错误码、可重试性和用户提示一致。

### P2/P3

- [x] generation 主表和迁移完成；
- [x] Worker 重启后 generation 可查询；
- [x] 重复终态请求幂等；
- [ ] 项目 session epoch 已纳入所有异步回写；
- [x] 全局请求队列已替换为分层并发模型；
- [x] 长任务不阻塞会话读写。

### P4/P5

- [x] 数据库不变量由 Schema 和 Service 双重保证；
- [x] 会话排序、搜索、归档、恢复和游标分页完成；软删除由归档/恢复承载；
- [~] 上下文快照保留、清理和新快照 manifest 化已完成；备份边界待补；
- [x] 请求、队列等待、生成指标、耗时、成功/失败、首 Token 和 Provider 分类可查询；
- [x] 重启、并发、重复请求和恶意输入测试通过。

### P6

- [ ] Desktop 和 Worker 模块完成合理拆分；
- [ ] 领域状态类型完成收紧；
- [ ] CI 覆盖率、安全扫描、SBOM 和许可证检查接入；
- [ ] 文档、迁移版本和发布验证记录同步；
- [ ] Windows 签名、升级和回滚门禁通过。

### 12.1 实施记录（2026-08-15）

本轮已完成：

- 会话、消息、上下文和 LLM IPC 的未知字段、枚举、分页、token、文本长度和 usage 边界校验；
- 稳定 Worker 错误码、`retryable` 与 `operation` 字段，以及 Desktop 结构化错误保留；
- Schema v11 `llm_generations` 主表、历史 attempt 回填、幂等索引、CAS 版本更新和终态不可逆触发器；
- generation 创建、流式观察、完成、失败、取消和 Worker 重启恢复的同事务持久化；
- Worker 重启后的 `llm.generation.get` 重建，以及首次生成和重试的幂等键去重；
- 每次项目打开生成新的 `projectSessionId`，LLM 原生回调同时校验项目、会话、generation、attempt 和项目会话；
- 会话列表按 `updated_at DESC, id DESC` 确定性排序；
- Worker 请求分层调度：查询并发、长任务不占短写队列、短写操作串行；
- IPC 请求方法、请求 ID、结果和耗时进入有界脱敏诊断事件。

聚焦验证：

- Persistence：15 项通过；
- Worker：124 项通过；
- Desktop：63 项通过；
- Rust：41 项通过；
- Contracts、Domain、Persistence、Worker 和 Desktop 类型检查通过。

仍未完成：

- 图片、视频、备份、导出等全部异步回写统一采用 `projectSessionId`；
- 会话列表游标分页和软删除；会话重命名、归档、恢复和关键字搜索已完成；
- 上下文快照保留、清理和导出策略；
- generation 首 Token、队列等待、Provider 分类等完整指标体系；
- Desktop/Worker 大模块拆分、CI 安全/SBOM/许可证检查和 Windows 正式签名升级门禁。

### 12.2 实施记录（2026-08-16）

本轮已完成：

- Schema v15 为 `conversations` 增加 `archived_at`，新库和 v14 升级路径均验证；
- `conversation.update`、`conversation.archive`、`conversation.restore` IPC 及运行时校验；
- `conversation.list` 支持 `includeArchived` 和 `query` 关键字筛选；
- `conversation.list` 返回 `{ items, nextCursor }`，支持 `limit` 和 `cursor` 游标分页；
- `maintenance.contextSnapshots.cleanup` 按保留期清理未被 generation、attempt、task、document version 引用的旧快照；
- 新 generation 快照只保存 `ProductionContextManifest`，不再复制完整 `systemInstruction`、拼接正文或来源内容；
- `maintenance.metrics` 返回请求总数、成功/失败、耗时和按操作统计，并保留关联 requestId；
- `maintenance.metrics` 增加 generation 首 Token、总耗时、成功/失败/取消和 Provider 分类统计；
- `RequestScheduler` 上报串行请求队列等待，`maintenance.metrics` 返回队列样本、总等待和最慢等待；
- Worker 侧重命名、归档、恢复和项目归属校验，归档会话禁止重命名，恢复保持幂等；
- Desktop 会话栏增加归档筛选、重命名、归档、恢复和加载更多入口；项目维护页增加运行指标摘要；
- 持久化、Worker、Desktop 测试和 `pnpm typecheck`、`pnpm lint`、`pnpm format:check` 全部通过。

聚焦验证：

- Persistence：20 项通过；
- Worker：133 项通过；
- Desktop：88 项通过；
- 全仓类型检查、Lint 和格式检查通过。

仍未完成：

- 软删除与恢复由归档状态承载；会话列表游标分页已完成；
- 上下文快照清理前确认、备份边界和 legacy 正文迁移；
- 图片、视频、备份、导出等全部异步回写统一采用 `projectSessionId`；
- 请求队列等待、generation 首 Token 和 Provider 分类指标已加入；
- Desktop/Worker 大模块拆分、CI 安全/SBOM/许可证检查和 Windows 正式签名升级门禁。

## 13. 暂不纳入本轮范围

除非审核时明确调整，本轮暂不实现：

- 云端多租户和团队协作权限；
- 服务端会话同步；
- 会话内容全文搜索服务；
- 多用户审计平台；
- LLM 业务之外的生产参数自动填充；
- 全量 UI 视觉重构。

如果未来要支持团队共享或服务端部署，需要另立安全设计，加入用户、租户、角色、ACL、审计和服务端数据库，不能仅依赖当前本地项目锁。

## 14. 审核时需要确认的决策

1. 是否同意将持久化 generation 主表作为长期架构，而不是继续扩展内存 `Map`？
2. 是否同意所有异步任务统一携带 `projectSessionId`？
3. 是否同意 IPC 请求拒绝未知字段并强制执行文本大小上限？
4. 是否同意将备份、导出和媒体下载从同步 IPC 调用改为后台任务？
5. 会话重命名、归档、软删除、搜索和分页是否进入本轮？
6. 上下文快照默认保留多久，是否进入项目备份和导出？
7. 当前产品是否继续保持本地单用户定位，还是需要启动多用户/团队权限设计？

## 15. 完成定义

本计划只有在以下条件全部满足后，才可标记为完成：

- P0/P1 问题清零；
- 所有数据库迁移具备备份、回滚和完整性验证；
- 状态机、幂等、项目会话隔离和错误契约有自动化测试；
- 长任务不会阻塞普通会话操作；
- 诊断输出和快照满足脱敏、大小和保留策略；
- `pnpm test`、`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 全部通过；
- Windows 原生构建、安装、升级、回滚和签名门禁通过；
- 代码、Schema、文档和验证记录保持同步；
- 审核中确认的产品边界没有未记录的临时实现。
