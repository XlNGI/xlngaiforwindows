# Agent Context Management Architecture Refactoring

状态：四阶段主体及后续统一执行/长任务生命周期 P0–P5 已实施，当前专项验收记录见[生命周期交付记录](./code-traces/2026-11-06-agent-execution-lifecycle-delivery.md)。此前短章节文档任务通过；长输入第22轮持续重复复核被停止，完整业务未通过。后续空项目严格制作任务1,042秒自然失败，产物与重启恢复保留，但审查反复使用错误版本标识，没有成功提交review。上次同构建真实复验保存1场6镜/60秒、重启恢复、两次审查落库，20分钟测试截止取消，未自然完成且存在内容差异。本轮已实施Worker持久reviewId快照、系统就绪／内容缺陷分离、按目标issueId闭环和误报撤回，移除旧全局hash裁决。冻结v2供应商运行1,010.22秒自然完成且重启恢复／问题闭环通过，但独立内容一致性不通过，并暴露隐式全量审查覆盖。终态后已实施v3明确reviewedTargetIds、部分评估及旧覆盖保守迁移；220项专项通过，最终门禁见交付记录第10节，v3未再次付费验收。义务来源类型和取消状态投影仍待完善，不宣称任意长任务或长输入验收完成。适用范围与未实现项见第9节。开始日期：2026-11-05；更新：2026-11-06。

本文记录代码、测试和业务验证的不同完成程度，不把设计或模拟调用当作真实供应商验收。

## 1. 阶段一：架构复核与根因

复核了 `agent-task-context.ts`（原阶段实现）、`pi-conversation-runtime.ts`、`agent-provider-loop-service.ts`、`agent-task-checkpoints.ts`、`agent-context-budget.ts`、`app-settings-service.ts`、`agent-policy-instructions.ts`、`agent-provider-tool-gateway.ts`、`task-history.ts`、Rust `llm_stream.rs` 及其调用方。

原真实链路：ContextService 冻结目录/近期会话 → GenerationService 选择模型 → PiConversationRuntime / 阶段状态投影 → AgentContextBudget → Native bridge → Rust 最终协议组装 → 供应商。工具由原 Registry/权限/参数验证/业务事务执行。

现场只读审计对象：项目 `发生的哥特人/project.sqlite`，generation `bf789b79-3fc4-4ffc-bcb2-81b8e05e7cb2`，task `de04573a-cdca-4c4a-a4af-b567b9e9ae3e`。未修改该项目业务数据。

| 已核实现场 | 结果与含义 |
| --- | --- |
| 模型记录/业务调用 | 17 次模型记录、12 次业务调用；前 16 次已发送，第 17 次在本地拦截 |
| 失败请求 | 必需上下文 59,243 > 自适应上限 58,752；未知模型回退 64,000，初始预算 44,800 |
| 交接前后 | 输入从首次 17,250 增至交接后 50,470；System 从 4,984 增至约 29,154 |
| 交接收益 | 离线预测释放 40,063，实际只减少 94；计算对象不同 |
| 本地与供应商 | 一次本地 51,323、供应商 72,852；本地估算不代表供应商计费或真实窗口 |

分别确认的根因：

1. 阶段交接把完整原文和中间资料搬进 System，清空历史并未清空请求中的正文。
2. `workingEvidence` / `protectedEvidence` 重复正文，缺少统一版本退休；更新后的旧正文仍可能被保护。
3. 用原始历史大小预测收益，没有计入交接后实际注入和最终协议开销。
4. 完整工具结果混入模型历史；审计摘要无法恢复完整结果、失败提交参数和未保存正文。
5. 模型合同、输入/输出预留、最终 Rust JSON 统计缺少统一边界；未知能力被固定初始比例掩盖。
6. 通用文档工具带入不相关的角色/场景图片、视频策略。
7. Pi 内存承担任务进度；Worker 恢复不能重建完整工作集，较早要求只靠近期会话。
8. 真实验收另外发现：历史被编码成普通 user JSON 会诱发重复路由；无效占位调用参数会被模型模仿；导航协议 `version:1` 被误当资料版本；分页结果又被外置会产生引用套引用。
9. 多份同类无目标 ID 的交付项曾可被同一文档回执重复满足。现为独立输出分配，并保留显式 targetIds 验证。
10. 长输入复验确认了独立的执行状态问题：有待办时仍写入 deliverablesVerified=true；模型自己的错误数量/类型又不能在目标尚未全部创建时纠正。两者会把错误计划固化并误导完成判断。
11. 原生双协议回归确认：自动续接指令进入 Pi user 队列后，被 ContextManager 的 user 过滤丢弃；Pi 的 prepareNextTurn 只更新当前循环上下文，没有同步 agent.state.tools，continue() 重开循环时又退回初始可执行工具，出现“请求有 Schema、执行报 Tool not found”。两项均属于执行链路缺陷，不能通过调整 Token 数字修复。

复用 ContextService、AgentContextBudget、模型合同注册、工具 Registry、项目 SQLite、保存回执、CAS 与 Pi 调度。原阶段双份正文 Map 已退出生产链路；没有另起一个 Agent Runtime。旧审计与文档保留。

## 2. 已实现的整体架构

```text
用户要求/补充 ──→ Task State（项目 SQLite）
                          │
原工具授权/执行/业务事务 ──→ Result Store（完整结果、完整参数、哈希、版本）
                          │
                          └──→ Evidence（来源、版本、范围、用途、有效状态；引用结果）
                                            │
                 ContextManager ←───────────┘
                    │  当前要求/持久状态/有效资料引用/必要最近工具轮次/已加载工具策略
                    ↓
                 ContextBudget（模型能力、输入、输出、安全空间）
                    ↓
                 Native Bridge → Rust 最终协议计量/已知能力边界校验 → 供应商
                    ↑                                      │
                    └────────── 真实 usage 独立记账 ─────────┘
```

三层分别存储、分别恢复。System 保留系统/权限/当前工具策略，不复制阶段完整资料。普通会话继续仅自动获得目录元数据；小说、文档、项目约束正文按需读取。草稿/正式、附件不自动入索引、本地 SQLite 的既定规则不变。

### Task State

`AgentContextManager` 管理持久化 taskGoal、原始要求、每条用户补充、明确决策来源、约束引用、阶段、已完成调用、待办、产物引用、检查点和恢复状态。原始要求不因压缩而截断。只有显式成功 follow_up 路由才能继承同项目同会话已完成任务的要求/决策，防止把无关旧任务约束混入新任务。

`decision` 操作必须逐字引用持久用户要求；assistant 工作笔记明确标为历史说明，不能自行提升为用户确认。待办通过统一 `assessTaskCompletion` 合并原交付计划的成功回执/当前产物核验与冻结制作任务的独立完成要求；旧 checkpoint 的 remainingWork 标为历史描述。partial 与 completed 分开保存。

自动校验要求的续接指令另存 recoveryState.executionDirective，来源为 runtime-continuation，不进入用户要求或确认决策；下一次请求投影它，收到完整模型响应后确认清除。发送失败或 Worker 重启前未确认的指令仍可恢复。校验存在待办时 deliverablesVerified=false；只有当前持久产物满足计划才能为 true。模型可使用同 key 和 revisionReason 纠正自己的计数/类型，未来目标 ID 不必提前存在；已确认目标、逐字要求和引用义务不能借此删除。修订计划本身不计完成。

### Working Data / Evidence Store

完整工作数据复用项目 SQLite，使用 `AgentContextStore`。Evidence 正文通过 resultId 引用，只保存 sourceKey/sourceVersion/rangeKey/purpose/hash/status。相同来源/版本/范围去重，旧版转 superseded，成功编辑对应目标后旧证据转 retired。历史仍能按 ID 查询。

导航使用真实 resourceMap.revision，而非协议 version。compact/full/分页共用来源、各自范围。重启时再次观察历史写入，只退休该写入之前读到的数据，不能撤掉之后刷新出的新证据。相同版本某一范围更新不影响其他范围；已退休版本不能因旧历史重放重新激活。

### Result Store

完整结果和完整调用参数在工具事务/边界持久化；审计记录继续只负责审计。大结果返回 resultId/version/hash/状态/摘要/关键字段，小结果可直接 inline。大型提交参数投影为可读引用，小参数保留合法原值，避免模型模仿无效占位参数。

`conversation.task.checkpoint operation=result` 支持 `resultView=content|arguments`、UTF-16 offset、1–16,384 字符分页和 expectedHash；参数视图独立校验哈希。工具结果读取受项目/会话/任务范围限制。显式 result 范围页直接进入当前工作集，不再二次外置；state 记录页若超过现有工具传输上限，则先完整持久化为不可变快照，再返回同一范围读取协议。跨任务回读保留 targetGenerationId，不截断原要求。正式草稿保存在原 documents/document_versions，失败候选全文也能从完整参数恢复。

### ContextManager / 压缩

每轮由统一入口观察结果、保存状态、选择有效证据引用、投影必要历史、加载已授权工具策略、预算并诊断。最多选最近 8 个完整成对的工具轮次；已知能力不足或供应商明确报告超限时继续减少，不因为未知能力回退估算而持续丢弃工作集。Pi 工作内存最多保留 32 条投影消息，原始 assistant/工具数据已保存。显式激活的 Skill 声明保存为版本化 Evidence，跨压缩/重启投影一次，不搬入 System；当前用户原文与状态读取中的相同要求使用引用去重，完整原文仍在存储中。

重建历史使用原生 assistant/tool（Chat）或 function_call/function_call_output（Responses），不把执行日志伪装成新用户指令，不依赖供应商不透明历史链。完整结果外置、重复/失效证据排除、状态保留，压缩不等同普通聊天摘要。

工具仍通过原 Registry、authorizationHandle、参数校验和业务权限执行；ContextManager 不能授权。tools.load 仅增加缺失能力或切换 workflow；文档工具仅在明确 workflow 时引入相关图片/视频策略，重复策略块去重。

用户以真实来源ID/完整标题明确选中、并已通过工具读取的有效资料，以及已读取的约束，进入独立taskState.workingData投影。小结果正文跨近期历史滚动和重启保留一次，历史对应回执改为指向该投影；大结果仍为分页引用。未选中的项目正文不自动加入，旧版本被替代后不继续投影，System不复制正文。Task State的savedArtifacts另附精简保存回执、标题、文档类型和真实ID，正文仍在完整Result/业务文档库。

2026-11-06 现场复验补修：移除 tools.load 的单次6工具、累计16工具及128 KiB固定配额；授权目录、唯一名称校验和原权限不变，所选Schema由统一上下文管理器计量与按模型处理。短小失败回执直接提供错误，不为查看校验错误再要求result读取。交付计划的工具枚举与运行时共用定义，支持已有scene.structure.stage / scene.submit_structure / novel.episode.submit_structure；结构交付项按实际保存的场次计数，可验证每镜真实引用。暂存、检查点和冲突回执不能充当已保存产物，重复ID及不同结构工具的同一场次不能重复满足无目标交付项。结构工具属于同一交付语义族，同key可更换具体执行工具而不削弱数量或引用要求；恢复后换key重复登记同类同数量的无目标义务会明确拒绝。targetIds仅接受当前项目实际存在的同类型活动输出；历史workspace:shots等页面定位仅在内存移除错误定位，原审计与交付义务保持。

### 模型能力 / 预算 / 计量

统一 `ModelCapabilities` 区分 contextWindow / maxInputTokens / maxOutputTokens / tokenizer / supportsCompaction / capabilitySource。模型级手动能力与供应商模型隔离，模型同步保留手动值；设置页支持修改与恢复自动。来源记录为 provider / model_registry / manual_config / fallback。

未知模型采用用户指定的规划默认 512,000（2026-11-07 从 64,000 调整；可通过 `AGENT_UNKNOWN_MODEL_CONTEXT_WINDOW` 配置，非法值退回默认），记录为 fallback / advisory_fallback，**它不代表供应商真实硬边界，不能仅凭启发式估算拒发或压低本次输出额度**。provider / model_registry / manual_config 的已知能力继续校验独立输入、输出与窗口限制；未知能力交由供应商最终校验，明确超限时才有界恢复，不擅自推断 1M。Rust 模型发现保留明确的 context_window/context_length/contextLimits 及独立输入输出元数据，经原设置服务按模型同步；缺失信息不推断，手动覆盖优先，普通能力勾选不会伪造能力来源。每次模型切换重新解析能力和请求预算。输入预算由窗口、独立输入限制、输出预留、安全余量共同决定，不再固定 44,800。任务执行计数、费用记账和供应商额度状态与窗口预算保持独立；每请求保存模型和价格快照，跨模型/重启汇总实际 usage，缺失部分标 partial/unknown。

TS 记录本地分段估算：system、tools、history、toolResults、taskState、用户输入、目录及其他注入。Rust 在最终 JSON 组装后计量两种协议，记录字节数、System、Schema、消息、图片、输出预留及能力来源；已知 encoding 可用 o200k/cl100k，否则采用保守 heuristic。**这些都标为本地估算，供应商 usage 单独保存，不冒充实际输入/输出。**

用量页面对advisory_fallback显示“模型能力未知／规划参考（不作为请求硬限制）”，不再显示成已经超出真实输入上限或缺口；历史曾执行回退限制的记录保留其历史含义。页面分别展示请求组装估算、最终协议分段估算和供应商报告用量，避免再次把估算参考误读为模型能力。

### 检查点、交接与恢复

每个工具边界保存 runtime/message 投影和状态检查点。重启后读取持久任务，重新授权当前项目会话，恢复所选模型、待处理模型切换、usage 和工具集，以成功回执补齐快照缺失结果，再动态组装请求。最近视觉工作集独立存储和恢复。

阶段交接保存产物、状态、引用和简短工作说明；不再把完整资料搬入 System。收益以重建后的实际请求构成为准。已知能力下 Rust 可调整本次输出空间，保留原请求和最终额度，绝不改写输入或模型能力。明确超限最多两次收缩/重建，相同拒绝请求不重发；成功后解除单请求恢复压力，不能把整个后续任务永久压成一条历史。失败保留原始数据及检查点。只识别明确上下文错误代码；429、余额/权限、网络错误不触发上下文恢复。

后续生命周期实施将核心文档/场镜写入统一到 Worker 业务身份与提交事务，保存回执/CAS 继续校验修订；模型调用ID及标题不作为输出身份。状态不明的付费或外部调用返回 interrupted_execution，必须核查，不能自动重放。不是所有注册工具都已具备语义重放合同，范围见生命周期交付记录。

## 3. 数据迁移与兼容性

- Schema 74 → 75：事务式新增 agent_context_tasks/results/evidence/checkpoints/diagnostics 五表及索引。旧 documents、document_versions、agent_tool_calls 不删除、不改写。项目打开继续使用已有迁移前备份机制。
- 后续 Schema 75 → 76：统一输出身份、提交事实和资源变化序号增量迁移，保留原有全文、审计及检查点；旧入口绑定按可信事实兼容读取。具体表、恢复/回滚边界见生命周期交付记录，不删除或自动猜测历史产物。
- 历史状态 JSON 新字段均可选；旧审计保留。只有审计摘要、没有原始完整结果的旧任务无法凭空恢复正文，不能虚构迁移成功；新任务获得完整存储和恢复能力。
- 模型 capabilities_json 加可选 contextLimits，不更改其他模型配置；旧值走明确来源回退。
- 原 checkpoint save/read/plan/partial 接口兼容，新增 state/result/decision 和可选读取字段。内部 contextTurns 是可选协议字段；原 continuation 用于旧兼容路径，禁止同时传两种历史。
- 不自动清理新旧工作数据或历史版本。长期存储保留/归档策略仍需后续产品约定。
- 回滚旧应用前应恢复对应迁移前备份，不能让旧 schema 的应用直接修改新数据库。

## 4. 实施清单

- [x] 阶段一：真实调用链、现场根因、复用边界、迁移风险复核。
- [x] 阶段二：Task State、Evidence / Result Store、版本生命周期、完整结果与失败参数、范围读取及校验；逐阶段测试。
- [x] 阶段三：统一动态组装、去重、按需策略、能力与预算、最终协议计量、诊断和有界压缩；逐阶段测试。
- [x] 阶段四代码：持久检查点、真实 Worker 重启、上下文重建、保存回执恢复、业务幂等保护、跨阶段执行。
- [x] 阶段四短章节验证：当时构建真实供应商重启任务通过；当时全仓 test / build / typecheck / lint / format:check 通过，Rust 196项通过。仅代表当时版本与短输入范围。
- [ ] 长输入现场复验：完整 9,068 字请求（含 8,547 字约束）、原项目隔离备份、全部制作草稿与逐镜绑定、保存后强制终止 Worker 并恢复。第22轮已保留全部资料并停止；未能自主完成，业务验收未通过，详见第11节。

## 5. 核心 18 项验收矩阵

| # | 项目 | 已实现 / 测试证据 | 真实供应商范围 |
| --- | --- | --- | --- |
| 1 | 64K 硬边界 | TS ContextManager/Budget + Rust final_wire_enforces_each_model_window | 真实任务未触碰供应商硬上限 |
| 2 | 128K 可超过 64K | TS / Rust 窗口测试 | 未付费跑大输入 |
| 3 | 1M 可超过 64K | TS / Rust 窗口测试 | 未付费跑百万窗口 |
| 4 | 清历史不无故膨胀 | history clearing System 稳定、正文不搬 System | 真实任务跨 checkpoint / Worker 重启 |
| 5 | Evidence 不重复 | 同来源同范围重复调用只投影一次 | 整集资料按需读取 |
| 6 | 不注入过期版本 | v1→v2、3次导航revision、full/compact、重启重放测试 | 第四轮定位导航问题，第五轮修复后通过 |
| 7 | 大结果不反复携带 | Result 外置及多次 snapshot/原生历史测试 | 真实供应商使用引用和分页 |
| 8 | ID 完整读取 | 多页拼接精确等于原文；失败参数独立哈希 | checkpoint result 真实调用 |
| 9 | 压缩状态不丢 | 原始要求/重复补充/决策/已保存产物测试 | 第五轮保持蓝衣、对白、6镜60秒 |
| 10 | Worker 重启恢复 | Store reopen、snapshot 缺口协调、Generation 恢复 | 第五轮直接 kill Node 后同 generation 完成 |
| 11 | 模型切换重新预算 | 64K↔1M、独立输入输出、每请求模型价格测试 | 当前真实验收单模型 |
| 12 | 交接不复制大正文 | System 稳定、30镜跨阶段原文引用测试 | 第五轮交接后继续并保存三份文档 |
| 13 | 最终协议计量 | Chat/Responses JSON + encoding/heuristic + Schema/图片测试 | Native HTTP 最终请求诊断 |
| 14 | 工具策略按需 | document / character-image / scene-image / video policy 测试 | 真实文档任务加载/执行有效 |
| 15 | 压缩失败数据保留 | 不可容纳输入仍有完整 result/runtime/checkpoint | 不刻意制造供应商收费失败 |
| 16 | 超限有界恢复 | 两次恢复上限；只认明确错误代码 | 未强制压到真实硬上限 |
| 17 | 模型失败产物保留 | 双协议已保存镜头 + 最后请求失败回读 SQLite | 真 kill 后分析 ID/版本不变 |
| 18 | 不误判限流/余额/网络 | bridge 错误分类、HTTP429、超时、权限/余额测试 | 不人为耗尽真实余额或限流 |

## 6. 真实业务验证记录

使用隔离复制设置及临时项目，凭证留在 Windows 原安全边界；不修改用户原项目，不提交图片/视频或联网研究。真实链路包含 Rust HTTP、真实供应商模型、Node Worker、实际工具和 SQLite。模型为已配置 `gpt-5.6-terra`，Chat Completions 协议。

业务：读取《雨夜重逢》小说、人物、场景；分析→6镜分镜→逐镜完整视频提示词→核对→保存三份 plan 草稿。要求林澈蓝衣、原对白“我回来了。”“我一直在等你。”、禁止新增人物、60秒、一次用户启动。分析保存后强制 kill Node Worker，再打开同项目自动恢复。

第五轮：**真实通过**，Rust opt-in 测试 1 passed，384.14秒，32次请求。三份文档各1个版本、各保存一次；分析 ID 跨重启不变；library.read 共3次、search3次、目录1次。正文另行核对六镜时长 10+10+8+12+10+10=60，蓝衣及两句原对白均保留。调用存在额外回执核查，未把这等同于最优效率。usage 覆盖 partial，未把缺失 usage 当零。

证据目录：`C:/Users/MSI/AppData/Local/Temp/p22-context-real-OJSzsp`，包含 live-report、三份正式保存的文档导出及 acceptance-summary.json。临时目录不作为长期业务存储；完整产物同时存在该隔离项目 SQLite 中。

此前第1–4轮分别暴露重复路由/加载、无效参数模仿、分页外置、导航版本判定；第四轮只保存两份文档，明确判失败，没有把 generation complete 当业务通过。

第六轮：**真实通过**，257.55秒、21次请求，3次来源读取、3次文档成功保存，任务状态 completed、pendingSteps 为零。20次请求有供应商 usage，重启中断请求缺失 usage，覆盖明确标 partial。TS 本地估算 9,880–25,127，Rust 最终结构估算 15,147–42,377，供应商已报告实际输入 15,962–38,999；三种数值分别记录，不相互冒充。证据目录 `C:/Users/MSI/AppData/Local/Temp/p22-context-real-final-uJ6w1s`。

最终构建第七轮：**真实通过**，440.48秒、29次请求；直接终止Node Worker后恢复同一generation。3次来源正文读取、4次搜索、4次目录读取；3次保存被参数/CAS验证拒绝，修正后3份文档各成功保存一次，各仅1个版本，没有重复创建。另1次checkpoint调用失败后有界修正。最终Task State为completed、待办为零；27次请求有真实usage，整体覆盖partial。强化验收同时检查三份持久文档、6个镜头编号、60秒、蓝衣、原对白和非partial结束。人工另核对分镜与完整提示词一致为8+10+8+12+12+10=60秒。没有要求用户点击继续；没有重新读取全部小说/人物/场景。

最终证据目录：`C:/Users/MSI/AppData/Local/Temp/p22-context-verified-zY9l17`，含实际项目SQLite、live-report.json、三份保存文档导出和acceptance-summary.json。真实验收并非零错误路径：参数拒绝均未执行写入，已保存结果跨重启保持，模型自行修正后完成。

## 7. 历史测试记录（本轮最新记录见第11节）

- 初次全量 Worker：88文件 / 1,329测试通过；Desktop：89文件 / 807测试通过。
- 生命周期修复：ContextManager / pipeline / deliverables 3文件 / 104通过；包括两协议30镜、多次交接、CAS冲突、失败候选恢复、partial状态。
- 最后投影/统计回归：4文件 / 174通过。
- Persistence 完整结果/证据更新/恢复/哈希/隔离：6项通过。
- Native bridge：60项通过；Rust全量：196 passed / 2 ignored（真实验收 opt-in 单独运行）。
- 同类交付项独立输出：7项通过。
- 最终全仓 `pnpm test` 通过：Context 8、Contracts 48、LLM 32、Generation Adapters 80、Persistence 95、Desktop 807、Worker 1,331，共2,401项；Domain无测试。`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check`及`cargo fmt --check`通过。Rust最终全量196 passed / 2 ignored；被忽略的真实供应商专项已另外显式运行通过。
- 主要日志位于系统Temp：p22-context-workspace-final.log、p22-context-build-final.log、p22-context-typecheck-final.log、p22-context-lint-final.log、p22-context-format-final.log、p22-context-rust-final.log、p22-context-verified.log。构建保留原有大chunk提示，Rust保留5处unused_mut警告，均非失败。

## 8. 本任务核心文件清单

工作区已有大量其他修改；下列仅列本专项核心实现及其回归，不把其他业务变更归入本次。

| 范围 | 文件 |
| --- | --- |
| 持久化 | packages/persistence/src/agent-context-store.ts、agent-context-store.test.ts、migration-v75.ts、database.ts、schema.ts、index.ts |
| 状态/动态组装 | apps/worker/src/agent-context-manager.ts、agent-context-manager.test.ts、agent-context-results.ts、context-service.ts |
| 预算/模型能力 | apps/worker/src/model-context-policy.ts、agent-context-budget.ts/.test.ts、app-settings-service.ts/.test.ts、provider-registry.ts、generation-service.ts/.test.ts |
| 调度/恢复 | apps/worker/src/pi-conversation-runtime.ts、handler.ts、partial-artifact-service.ts |
| 工具/交接/完整结果 | apps/worker/src/agent-provider-loop-service.ts、agent-provider-tool-gateway.ts、agent-task-checkpoints.ts、agent-task-checkpoint-schema.ts、agent-tool-definitions.ts、agent-task-deliverables.ts/.test.ts、production-skill-validation.ts/.test.ts |
| 策略 | apps/worker/src/agent-policy-instructions.ts/.test.ts、agent-workflow-guidance.ts |
| 协议 | packages/contracts/src/index.ts、apps/worker/src/native-provider-bridge.ts/.test.ts、apps/desktop/src-tauri/src/llm_stream.rs、llm_context_meter.rs、lib.rs、Cargo.toml/Cargo.lock |
| 设置 UI | apps/desktop/src/settings/ModelManagementView.tsx、ModelManagementView.context.test.tsx |
| 用量诊断 UI | apps/desktop/src/settings/UsageDashboard.tsx、UsageDashboard.test.tsx |
| 业务回归 | apps/worker/src/agent-pipeline-remediation.test.ts、agent-library-retrieval.test.ts、novel-batch-integration.test.ts、project-runtime-integration.test.ts |
| 真实验收 | apps/desktop/src-tauri/src/context_e2e.rs |
| 迁移/要求记录 | docs/PROJECT-LIBRARY-RETRIEVAL-IMPLEMENTATION-PLAN.md、本文件 |

## 9. 剩余边界与未实现项

1. 不能承诺任意外部系统的 exactly-once。成功事务回执/CAS 可防本地重复；响应丢失且外部状态未知时必须核查，不能无条件重试。
2. 必需用户原文自身超过真实窗口时只能有界失败并保留数据，不能通过删除要求保证无限输入。
3. 未知 tokenizer 仍是 heuristic；即使已知 encoding，也不能等同供应商隐藏开销和图片计费。provider usage 独立显示。
4. supportsCompaction 为能力元数据，尚未调用供应商专有压缩 API；当前实现采用本地持久化投影和动态重建。
5. 已知旧版本可阻止回滚；从未观察过的 opaque 版本 ID 不能凭 ID 猜时间先后。外部更新需通过最新读取发现。
6. 旧审计缺失的全文无法凭空迁移。新存储目前不自动做历史垃圾回收，磁盘随长期任务增长。
7. 真实供应商验证仅一个文本模型/协议；短章节整集任务通过，长输入完整业务复验未通过。两协议30镜模拟业务、128K/1M预算测试不等于所有供应商/超长小说/百万真实输入验收。
8. 本次未新增可配置的任务总调用次数/总费用硬上限；现有分支对历史任务固定配额只记账而不终止。已保留独立调用/Token/费用统计、供应商额度分类及原授权调用限制，不能把模型上下文预算冒称任务费用控制。
9. 没有擅自重启用户桌面应用或安装构建；源码/构建/隔离运行通过，不代表已打开的旧桌面进程已加载新 Rust 和 Worker。
10. 逐字义务的来源、资料优先级和修订权限尚未完整建模。仅凭某份计划缺句不能安全撤销来自另一份小说的对白要求；相关自动撤销实验已撤回，当前仍保护既有 requiredTexts，不能把此问题称为已解决。
11. 长任务产物的自然语速、逐角色参考板、正文与时长节拍一致性、入画角色引用及源稿冲突说明尚未通过真实语义验收。数据持久化、恢复或机械检查通过不能替代这些验收。

## 10. 短章节版本交付状态对照（长输入验收未完成）

| 交付项 | 已实现 | 已测试 | 已验证 | 尚未实现 / 边界 |
| --- | --- | --- | --- | --- |
| 1 原架构问题/根因 | 已形成代码链路和现场复现 | 旧交接收益/新回归 | 原项目日志与SQLite只读核实 | 不把全部问题归为单一阈值 |
| 2 整体架构 | 三层分离接入生产handler | 双协议集成 | 隔离真实供应商链路 | 非所有供应商组合 |
| 3 Task State | 项目持久化要求/决策/进度/引用 | 状态恢复、补充、partial、回执核验 | 真重启保留原任务 | 外部无限任务不可保证 |
| 4 Evidence Store | 去重/版本/范围/退休/来源 | 更新与重启重放 | 真实导航revision修复验收 | 未见opaque版本不可猜先后 |
| 5 Result Store | 完整结果和参数/分页/hash | 精确回读/失败参数/隔离 | 真实result工具调用 | 旧摘要缺失正文无法补造 |
| 6 Context Manager | 统一组装/引用/原生工具历史/按需策略 | 多轮/清历史/大结果/图片恢复 | 一次启动三文档任务 | 非任意语义相关性检索引擎 |
| 7 Token Budget | 模型能力/独立输入输出/最终Rust估算 | 64K/128K/1M/切换/计费 | 真实最终协议诊断 | encoding估算不是provider usage；无真1M实测 |
| 8 压缩与恢复 | 外置/投影/检查点/两次恢复上限 | 失败不丢资料、只认超限码 | 真kill Worker后恢复 | 未接provider专有压缩API |
| 9 阶段交接 | 保存状态/产物/引用，移除正文搬System | 30镜两协议跨阶段 | 整集任务含checkpoint | 普通聊天摘要不是正式产物 |
| 10 文件清单 | 第8节列核心文件 | 门禁覆盖 | 已核对工作区范围 | 不把原有其他dirty改动算本专项 |
| 11 数据迁移 | v75加表/旧接口可选字段 | 幂等迁移/旧审计保留/reopen | 隔离项目实际迁移 | 不自动破坏或清理旧数据 |
| 12 测试结果 | 第7节记录 | 单元/集成/全仓/Rust | 全仓与Rust门禁通过 | 未运行项明确说明 |
| 13 真实业务 | Rust opt-in真实供应商测试 | 实际Node终止与重启 | 第五/六/最终第七轮通过 | 不把mock或UI测试冒充真实业务 |
| 14 风险/未完 | 第9节逐项列明 | 对已知失败有回归 | 记录真实验证范围 | 活动桌面进程未部署，长期存储GC未实现 |

## 11. 2026-11-06 长输入现场复验

原始完整请求9068字符，其中会话约束8547字符；使用原项目和应用设置的只读SQLite backup建立隔离副本。原项目业务数据不修改。原配置模型gpt-5.6-terra，Chat Completions协议。网关模型发现实际只返回ID，没有真实窗口，故继续明确标记fallback，不能声称发现1M能力。

已核实：本地Rust启发式估算55327时供应商实际输入40631；后续59290曾被fallback本地拒绝。改为advisory后，供应商实际接受81557输入Token，证明固定64K不是这个网关模型的已核实硬边界；这也不构成推断其最大窗口的依据。

- 隔离副本p22-context-lifecycle-buPG4o：失败。45条请求记录、35次已计量工具调用，未保存业务产物；交付计划枚举不支持实际场次创建工具，模型切换工具名后反复读取，最终AGENT_REPEATED_READ_STALLED。已补充Schema/运行时一致性、真实保存/部分保存/未保存、重复回执及引用类型回归。
- 隔离副本p22-context-lifecycle-jWeb64：失败，277秒。两次合法7工具加载因固定6工具限制被拒；最终供应商HTTP502，未误判为上下文超限。保留完整结果、原始参数和检查点。未完成首份产物保存，未发生强制重启验收。
- 隔离副本p22-context-lifecycle-KJ82IV：保存3份角色后真实终止并恢复Worker；之后发现同一交付计划被换key累加，停止隔离验收，证据保留。已加重登记回归：已有无targetId的同类同数量交付项必须复用稳定key；同次声明的独立交付项仍支持，新增独立工作需指定不同目标。恢复后保存回执直接包含真实ID，减少不必要的结果回读。
- 隔离副本p22-context-lifecycle-diXDoQ：保存10份制作资料并完成真实Worker重启；但反复重读源文，且道具草稿出现源计划没有的钱箱暗格等事实偏差，明确判定未通过，停止隔离测试并保留数据。修复选中源资料跨历史滚动的投影与保存产物定位；不以增加预算继续该失败测试。
- 隔离副本p22-context-lifecycle-AdoZoL：同一generation跨两次Worker中断恢复，保存4份角色、4份场景和四场16镜；恢复时正确识别已经保存的一场，仅继续未完成场次。全部要求与已保存ID持续存在，最后pending为零。请求账本69条（含中断/未完成记录）、任务计量66次模型请求与57次工具调用，64条请求具有供应商usage。原项目旧场次已归档，默认结构目录不显示该场次是正确行为，新建活动四场不构成重复。**完整业务未通过**：必要道具没有独立保存，propDocumentIds全部为空。旧验收仅检查引用数组存在，虽然Rust测试返回通过，也不能据此认定业务通过。另查明验收prepare漏传真实按钮使用的productionSkillId，因此此前范围不能代表完整按钮链路。
- 隔离副本p22-context-lifecycle-ukVebf：保持原9068字请求和原项目只读备份，补齐productionSkillId=script-to-media。完成9份制作资料（4角色、2场景、3道具）、四场12镜和真实绑定，跨两次Worker中断恢复，原要求完整、待办为零，各资料仅1版。**完整业务失败**：漏掉“桥边有人。”“那是明日的事。”两句原对白，模型将structure readiness=ready误当成语义核验完成；最终回复还误报8份资料（实际9份）。强断言返回失败，不能用generation complete或pending零冒充通过。请求账本76条、71条有供应商usage，实际输入22877–90848；没有fallback本地硬拦。证据保留在该副本business-audit.json与business-output-review.json。

本轮补修：复用现有交付计划增加可选requiredTexts，持久保存模型从原始要求/已读源稿提取的逐字清单；按当前实际Markdown或逐镜prompt核对，audioPlan、备注和回复不能替代，缺项进入pending并触发原自动续接。旧计划兼容，已登记的清单不能缩减。script-to-media声明升为revision 2，要求登记全部原对白并读回正文检查说话者、顺序、连续性和时长。另修复部分场次尚未落盘的暂存回执被误列为generatedArtifacts；完整暂存结果仍持久化。隔离长任务验收总时限改为可配置测试时限，超时不发送业务取消，能继续同一generation，避免测试脚本用20分钟总预算打断仍在推进的任务。

- 隔离副本p22-context-lifecycle-G7j58A：985秒，9份资料、四场10镜、真实Worker重启后原要求与15句清单完整。核验正确发现缺少“我不拿你的东西。”，但模型误用partial宣称“正在修正”，使原机制关闭工具并提前结束；**业务验收失败**。保留全部数据；不以承诺继续或partial替代交付。账本70条，67条有usage，供应商实际输入22984–79548。
- 补修partial边界：带逐字义务的任务，普通遗漏不能充当阻塞原因，必须加载读取/编辑工具修正；真正非重试工具失败可通过同任务blockedByCallId核实，旧接口与没有逐字义务的旧计划保持兼容。专项186项通过。生成指引优先逐场暂存保存，完整参数和所有已保存资料继续保留。
- 隔离副本p22-context-lifecycle-KxDXzo：1269秒，同一任务完成Worker重启，账本111条、110条有usage；最终仍有逐字义务未满足，并触发AGENT_TASK_CONTINUATION_STALLED，业务失败。不能继续标为“复验中”。

### 归档导航与预算归因复核

隔离副本p22-context-lifecycle-LLD0UM的最终报告为47条请求记录、46条有供应商usage，实际输入23078–80983 Token；第47次已发送，最终失败为Windows响应头错误12152，未发生本地上下文拒发。早先运行中截取的42条统计不是最终记录。

本轮直接核实一个独立循环原因：ProjectStructureCompiler的场次、镜头、素材计数没有遵循includeArchived，而资源目录已经过滤归档条目。源备份有1个已归档场次及16镜、0个活动场次。摘要却向模型声称有1场16镜，模型连续尝试定位不能编辑的活动节点。现已让默认统计排除归档场次、父场次归档的镜头、单独归档镜头和已删除素材；显式includeArchived保留历史可见性。没有删除任何历史数据，不涉及Schema迁移。回归同时检查统计与资源目录一致。

compactionCount=38不能解释成预算触发了38次：ContextManager固定近期工具轮次投影也累计该字段。未知能力当前是advisory_fallback，不能据该数字认定64K回退制造了这次循环。固定近期投影仍需通过来源、任务状态和完整结果恢复保障连续性，当前日志计数不能独立证明语义资料是否丢失。

同轮已为project.structure.get补齐workspace/kind枚举，让模型请求参数与服务端一致；为尚未输出、无HTTP状态、明确WINHTTP_RESPONSE_HEADERS的可重试传输错误接入现有有界重试，不将其归为上下文超限。相关ContextManager、预算、Native bridge、结构目录179项定向测试通过；场次生命周期相关16项通过。完整9068字隔离副本p22-context-lifecycle-u7Msdw最终失败，详见下文，不能以已保存角色草稿或重启成功认定整集业务通过。

u7Msdw又发现执行计划的独立问题：模型将预计16镜登记成至少16场，将角色/场景/道具混合参考误登记为必须额外保存plan。旧机制禁止下调模型估计或纠正类型，使错误声明成为无法修订的硬义务。现保留原Task State用户要求与逐字清单，允许同key通过revisionReason及真实targetIds修正模型自己的数量/文档类型；仍禁止移除已确认目标、逐字义务和引用要求，仍必须有当前任务成功写入回执。历史审计保持不可变，未迁移或覆写历史计划。Schema与待办回执明确scenes/documents/shots计数单位。132项专项通过，覆盖修订后无写入仍待办、真实保存后完成、原始审计保留、引用/对白/目标不可借修订删除及混合资料类型纠正。该隔离任务保存7份资料、前两场8镜后再次中断测试进程并加载新Worker，从原generation/检查点续接，以验证旧错误计划兼容修复；不能把分段前后版本记录当作一次全程不变构建验收。

前一构建验证：Rust全量201 passed / 4 ignored；场次交付专项39通过，ContextManager/工具网关/原生双协议续接专项74通过，选中源资料/恢复计划专项37通过；Desktop两个异步等待边界修复后25通过。当时全仓pnpm test通过2419项（Worker1348、Desktop808、Persistence95、GenerationAdapters80、Contracts48、LLM32、Context8），typecheck、lint、build、format:check、git diff --check及cargo fmt --check通过。新增用量页面测试确认未知能力的规划值不显示成真实硬上限。后续执行链路补修的最新门禁另列下文，不得将中间构建、旧弱断言或短章节通过记录当作最新完整长任务通过。

### 执行链路补修与再次复验

- u7Msdw最终结果：失败，AGENT_TASK_CONTINUATION_STALLED。账本66条模型请求、57次已计量业务调用，保存7份资料、四场16镜。缺少原对白“我不拿你的东西。”；混合资料误登记为plan、预计16镜误登记为16场的义务没有真正修正。人工复核还发现蒙面人缺独立角色与绑定、跨场动作/对白重演、部分时长不足，因此绝不能认定业务通过。第66次Rust本地估算约92453，最近供应商实际输入包括84575；请求已经发送，失败不是本地64K拦截。完整结果、参数、业务导出和检查点仍在该隔离副本中。
- 纠错补修：移除“纠正数量前必须已有全部目标ID”的前置条件，保留原目标、引用和逐字义务；pending给出同任务当前有效但类型不符的资料ID，以及已存场次ID。修正deliverablesVerified的语义，明确待办修复行动。
- 续接补修：先在Native桥接的Responses/Chat双协议回归中复现内部指令丢失，再单独持久化并投影executionDirective；继而复现continue后Tool not found，同步Pi的可执行工具和系统指令状态。针对性用例从失败变为通过，验证收到续接指令、真正保存一份草稿、只保存一次、后续清除旧指令。另测未确认指令重启恢复，不将其当用户要求。
- 暂存回执保持setupSaved兼容，增加setupStaged和saved，说明仅真实sceneId/saved代表场次落库，readiness只核验结构。新增测试验证暂存期间没有场次、保存后真实ID存在。真实业务断言补查源稿全部入画角色（含蒙面人）的独立资料和实际绑定，不再只检查引用数组存在。
- p22-context-lifecycle-GduoCM：在发现可执行工具状态问题后停止的中间构建验证，保留副本和verification-stopped.json。不是完整通过或最终版本验收，不以其中间产物替代新验证。
- p22-context-lifecycle-LanmYe：**完整业务失败**。使用新的原项目只读backup，9068字符与原prompt SHA256完全一致，开启script-to-media真实按钮链路，全程同一Worker构建，974.15秒、69条模型请求记录、58次已计量工具调用，实际供应商输入23362–75691，没有本地预算拒发。保存5份资料、四场10镜，真正终止并恢复Worker，原始要求完整、资料各1版。系统最终completed且pending为零，仍不能验收：钱箱和凭据没有独立道具资料、全部propDocumentIds为空；十镜均缺timing/beats与正文相对时间；“不是来抢钱的。”重复；阿诚入画镜头漏其引用；钱箱位置跨场回退；“先让人看看伤。”对白顺序错误；双蒙面人组合资料缺独立核验。最终回复承认尚未读回全部镜头。原始完整结果、业务产物、机械导出与人工审计保留在该副本。
- 上一构建门禁：ContextManager、交付、pipeline、Pi运行时、provider loop共5文件311项通过。全仓pnpm test共2440项通过（Worker1369、Desktop808、Persistence95、GenerationAdapters80、Contracts48、LLM32、Context8）；Rust全量201 passed / 4 ignored。pnpm build、typecheck、lint、format:check、git diff --check及cargo fmt --check通过。日志为系统Temp中的p22-context-{focused,workspace,rust,build,typecheck,lint,format}-15.log；保留原有大chunk提示和Rust unused_mut警告。该记录早于以下完成校验修改，不代表新代码全部门禁通过。

### 冻结任务完成要求补修

LanmYe暴露独立根因：旧完成判断只核对模型自行登记的交付计划；未登记的任务要求被绕过。现复用原交付评估，新增统一assessTaskCompletion入口，供ContextManager、provider loop最终完成和partial检查共用。冻结script-to-media任务必须有实际活动镜头，三类引用明确、自然时长与非空beats，并在本任务内读回当前保存的镜头及制作资料完整正文；没有模型plan也必须执行。普通会话不强制这些制作要求。Skill声明revision升为4，明确逐镜语义核对、修改后只重读变更对象，不重复读取全部源资料。

核验依据持久化成功写入回执、项目当前记录与完整Result Store。允许显式读取/更新已有镜头，不强迫重建结构；不扫描无关项目正文。正文读回排除元数据、ready、保存回执、失败和其他任务结果；支持版本隔离的字符分页/authoring JSON重组，产物更新使旧读回失效。需要修复时保持同任务续接，普通遗漏不能借partial退出，真实不可重试工具失败仍可按原blockedByCallId核实。

实现边界：读回证明取得当前正文，不证明语义正确；机器检查timing/beats也不证明说话者、顺序、入画引用或动作连续性正确。这些仍须真实业务逐镜审计。不能把新增校验或专项测试当作整集验收通过。当前专项已覆盖无plan、普通任务、缺时长、复用资料、完整读回、异任务/失败/元数据排除、分页/JSON转义/版本、更新失效及暂存/归档；最新全量门禁与下一轮真实结果完成后另记。

- p22-context-lifecycle-PmDUDi：失败，143.83秒、22条模型请求记录，未保存业务产物、未执行Worker强制重启。最终为Windows 12029请求发送失败，不是本地上下文拒发。已保存完整结果和检查点。另查初始待办措辞错误地将“尚无产物”描述成修复旧镜头，模型反复寻找并不存在的旧输出；现以实际currentShots区分创建/修复，不把缺结构误述为已有历史。状态投影的原始要求保留归档ID/hash，取消诱导重复回读相同要求的动作入口；完整存储不改动。
- 网络恢复复用原生桥已有两次上限的传输重试：Rust标记WINHTTP_REQUEST_SEND，只有retryable、无HTTP拒绝且尚未收到文字/思考/工具参数/usage时才重试。限流、余额、权限和不明确错误仍不触发上下文恢复；收到任何输出后不重放。真实本地连接拒绝Rust专项1项通过；ContextManager、完成要求及Native bridge共101项通过，日志p22-context-focused-17.log和p22-context-rust-send-17.log。没有调整窗口或Token阈值。
- p22-context-lifecycle-5N1V3a（第17轮）：**完整业务失败**，1377秒、128条模型请求记录、127条供应商usage，实际输入23725–107395 Token。真实终止并恢复同一任务Worker，原始9068字符要求完整，保存10份资料（各1版）、四场10镜，最终AGENT_REPEATED_READ_STALLED，没有本地64K拒发。机械导出与人工复核分开：镜头4-1、4-2漏入画角色引用，3-2漏退场蒙面人引用；阿诚报姓名在3-2与4-1重复，部分正文相对时间和beats不一致，9份制作资料未完整读回。钱箱在源剧本中已存在“先放檐下、后从车板滚落”的冲突，不能把沿用冲突写成确定连续性；双蒙面人组合资料是否满足逐角色参考仍待核实。小说中的“先让人看看伤。”在选中剧本中只间接描述，不将机械字符串缺项直接升级为用户逐字义务。完整数据、失败参数和检查点保留，没有重置失败状态制造恢复成功。

### 第17轮完成判定与IR兼容性根因补修

复核确认三个独立执行契约错误，均不靠调整预算解决。第一，镜头通过scene.structure.stage等结构工具真实保存后，完成判断却只认scene.update_shot_prompts/scene.update_shot_timings回执，错误报告10镜savedCount=0及全部对白缺失，诱发不必要重读和重写。现按成功结构回执的shotIds、sceneIds与当前项目活动产物核对prompt/timing，仍验证引用及timing，不接受暂存、失败、异任务或无关场次回执。第二，新场次显式authoringIR附带兼容characterDocumentIds时，被旧ChangeSet三字段绑定协议拒绝；现只让省略显式IR的旧binding-only编辑进入该兼容路径，既有项目/类型/权限校验保留。第三，minimumCount大于部分已知targetIds时，原判断将后续成功产物排除；现已知目标必须满足，其余名额从同类当前成功回执补足，不能替代缺失明确目标或重复分配独立产物。

自动读回检查明确标注为运行时检查，不能登记成额外交付文档。三文件专项123项通过，包含先复现失败再修复的结构保存、IR兼容和部分目标回归；完整门禁及下一轮真实业务结果另行记录。上述兼容修复不改Schema、不删除或覆写历史审计，也不能视为第17轮业务通过。

全量回归补充发现，绕开旧绑定协议不能丢弃显式兼容绑定。原两协议场次提交测试分别暴露sceneDocumentId丢失和已有场次characterDocumentIds未更新，已补充先失败的stage/submit回归。现将兼容ID归一到同一authoringIR引用路径：显式现代IR引用优先，省略的scope由已校验兼容字段补齐；旧binding-only编辑可覆盖继承scope；逐镜引用不继承全场cast。显式空引用保持为空。14项定向测试通过。第18轮全程使用其启动时固定构建，结束后已复核哈希；这些后续源码修正没有经过该轮真实验证。

### 第18轮结果与大型状态读取补修

- p22-context-lifecycle-rSG1es：**完整业务失败**，1411.90秒、127条模型请求记录，其中126条有供应商usage，实际输入23753–91636 Token。真实终止并恢复同一任务Worker，原始9068字符要求完整，保存9份资料（各1版）、四场7镜；当前全部镜头有timing/beats，选中剧本的机械对白缺失/重复均为零。仍有6份资料未完整读回，时长、连续性、入画引用和双人物组合设定板存在语义问题，不能验收。完整结果、失败调用参数、检查点、机械导出与人工business-review.json均保留。启动时324份JS/Rust哈希复核全部一致，本轮后续源码修复没有混入该运行。
- 直接故障由两项独立缺陷叠加：operation=state固定按记录数分页，同时返回完整taskGoal和原始要求，整页超过工具协议65536字节；其失败纯文本随后被projectTaskStateResult直接JSON.parse，导致任务崩溃。现复用AgentContextStore完整保存大型状态页，再返回resultId/hash及范围读取契约；小状态页兼容旧结构，失败/非JSON/非状态回执原样保留，避免二次解析掩盖原始错误。未提高任何传输或Token阈值，也没有删除用户要求。
- 另一执行契约缺陷：完成待办混合提供镜头/制作资料ID，模型将文档ID传给production.read。现保留原unreviewedArtifacts结构，追加按对象类型生成的readbackActions：镜头用production.read，制作资料用真实标题和类型library.search，核对返回的ID/版本后使用真实sourceHandle分页读取。只提供元数据动作，不注入正文、不伪造句柄、不绕权限。读回继续只证明正文可得，不证明语义正确。
- 先失败后修复的状态超限/错误投影回归已通过；ContextManager、交付、制作资料验证和pipeline共4文件163项通过，包含完整要求分页还原、较早要求不丢失及同会话旧任务范围读取。最新全仓门禁与第19轮真实业务结果将单独记录。新增实现复用v75数据表，无Schema变更、不清理旧数据；历史failed任务保持failed，不重置状态冒充恢复成功。

### 第19轮构建自动化门禁

2026-11-06：全仓 `pnpm test` 通过2,469项：Worker1,398（88文件）、Desktop808、Persistence95、GenerationAdapters80、Contracts48、LLM32、Context8。Rust全量202 passed / 4 ignored；被忽略的真实供应商测试另行显式运行。`pnpm build`、`pnpm typecheck`、修正测试类型标注后的 `pnpm lint`、`pnpm format:check`、`cargo fmt --check` 和 `git diff --check` 通过。仅测试标注调整后另行Worker build通过，再记录第19轮启动构建哈希（324份JS/Rust），真实验收期间不替换构建。保留原有大chunk提示、React act测试环境提示及Rust unused_mut警告，没有将其记录为失败。

日志位于系统Temp：p22-context-{focused,workspace,build,typecheck,format,rust}-19.log、p22-context-lint-19-corrected.log、p22-context-worker-build-19.log。第19轮使用新的原项目只读backup（p22-context-lifecycle-wHBeZs），原始请求SHA256保持ff094a1162e1406ab4455d4335504c19770e1c60f749bb67e9c791f28165dd59。该轮因已确认业务缺陷停止，结果如下；自动化门禁不能代替整集业务验收。

第19轮：**完整业务失败，审阅者停止隔离测试**。最后运行快照1842秒、194条模型请求记录、192条有供应商usage，实际输入23823–94034 Token；已真实终止并恢复同一任务Worker，9068字符原要求仍完整。停止时保存12份资料、三场8镜，尚有场次与读回待办。已确认同正文角色重复建档，以及首场混入后场交涉对白、后场再次生成相同内容。尚未完成的场次不作为最终漏对白证据。只停止本次隔离测试及其Worker，没有写入业务取消、failed或completed状态；原运行状态仍为streaming，不能视为终态成功或终态失败。原项目未改、完整资料和检查点保留。停止后重新导出并写入business-review.json，324份启动JS/Rust哈希全部一致，源码后续修复未混入本轮。双蒙面人组合设定板仍需语义审查；钱箱源稿位置冲突不能擅自补造转移过程。

### 第19轮现场继续复核与执行一致性补修

第19轮冻结构建的真实调用确认三项独立问题，均未修改Token、窗口或传输阈值：

1. 同一父任务为沈砚舟先后新建两份同标题、同正文的角色文档，正文SHA256均为858ea2118da66e27f8e48ddbdbb576bbcc90d13f6041b784f2a0b92b3e0767af；第二次仅增加contentIR来源元数据。模型已读过首份资料，所以不能归因为首回执丢失。AgentDraftSubmissionService原幂等键只覆盖调用ID。现沿用业务事务查询同父任务、目的页/绑定/作用域、类型、标题及当前完整正文完全相同的活动草稿；IR也一致时返回真实当前ID/版本和reused=true，不创建子任务、文档或版本。IR不同则返回真实目标及CAS更新参数，候选完整参数仍存Result Store；不自动覆写或丢弃新元数据。不同父任务、不同正文或标题、显式更新及其CAS仍保持独立。仅作用于本任务精确重复，不按全项目标题合并，不处理/删除历史重复数据。
2. 项目shortDrama.enabled按是否已有场次计数，却被模型误当为禁止写入；scene.submit_structure的resourceId原Schema接受任意字符串，而业务层只接受workspace:shots。模型猜造shortDrama:episode:1后反复查找不存在的episode资源。现Schema与现有执行层一致，明确目标为workspace:shots、空项目可写第一场、episodeTitle只是名称，无新增启用步骤。两协议集成验证enabled=false时真实保存一场一镜，猜造目标在参数验证时拒绝。原权限、项目范围和版本校验不变。
3. 交付校验把整集requiredTexts尚未覆盖的文本一律描述为必须编辑已保存产物，即使四场只保存一场。真实运行中模型因此反复修改首场。现pending按当前保存数量明确remainingCount和nextAction：continue_outputs先继续尚未完成的产物；review_outputs在数量齐全后核对相关现有正文。逐字义务、原目标和最终完整性检查不放宽，不要求把后续对白塞回前一场。ContextManager与partial错误使用同一行动语义。新回归覆盖一场到四场的推进，结尾文本最终仍需实际保存。

配套修复：复用保存回执不代表发生写入，ContextManager不再因此退休已经读回的有效正文或导航；该行为已有先失败后修复的回归。上述修复在第19轮执行期间只修改源码并运行测试，不覆盖该轮冻结构建。两协议重复提交6项、空项目与证据回归3项、场次推进1项均通过；合并专项5文件202项通过，typecheck和lint通过，日志p22-context-focused-20.log、p22-context-typecheck-20.log、p22-context-lint-20.log。最新完整门禁和后续真实验证单独记录，不能据此宣布长任务验收通过。

兼容方案：沿用v75和原documents/document_versions，未改表、未删除历史、未绕权限。复用回执仅增加可选reused字段；元数据冲突通过原工具错误协议返回，使用原显式documentId/CAS修订。新Schema约束与原业务层已接受的唯一场次目的地一致；旧的合法workspace:shots调用无需迁移。

### 第20轮供应商错误与重试分类补修

第20轮隔离副本p22-context-lifecycle-tVcl0t：**完整业务失败**，121.61秒、24条模型请求记录、23条有供应商usage，实际输入23864–67004 Token。首份产物保存前供应商返回HTTP 520，未执行Worker重启注入；不能据此验证本轮保存幂等、恢复或语义质量。原始要求、完整结果、失败状态与检查点保留，没有重置failed。停止后机械导出及business-review.json已保存，324份JS/Rust构建哈希全部一致。该错误准确分类为PROVIDER_FAILED，没有触发上下文压缩或本地64K拒发。

另确认一处重试分类不一致：Rust对HTTP 5xx标记retryable，桥接层却只接受500/502/503/504，网关520/524/529无法使用现有传输恢复。现桥接层统一遵循明确HTTP 5xx及原retryable标记，仍只在尚未接收文字、思考、工具参数或usage时生效，最多两次重试，每次独立授权/记账。不重放已完成工具，不增加上下文预算，不把5xx改成超限错误。新回归先复现520/524/529/599四项失败，随后补齐同工具上下文、两次上限、输出后禁止重试及retryable=false边界。

本轮首次全仓命令在一项制作面板更新提示测试失败后停止；该文件和全桌面组复跑均通过（808项）。独立Worker全量为1407通过/1失败：旧额度回归以两次完全相同新建草稿断言生成两份文档，与本次精确幂等的预期冲突。现将该用例第二次提交改为独立标题/正文，继续验证跨旧额度执行与旧授权句柄拒绝；精确重复不建档由专用双协议回归验证。不得将首次命令记为全量通过。修订后的全仓门禁及下一轮真实验证另记。

### 第21轮门禁与真实验证（失败，资料保留）

修订后重新执行完整`pnpm test`，全部2488项通过：Worker1417（88文件）、Desktop808、Persistence95、GenerationAdapters80、Contracts48、LLM32、Context8。桥接/执行专项2文件231项通过，含HTTP 520有界重试和原额度/权限用例。`pnpm typecheck`、`pnpm lint`和`pnpm format:check`通过；Rust未改，沿用本轮已执行的202 passed / 4 ignored。日志：p22-context-workspace-21.log、p22-context-gateway-after.log、p22-context-{typecheck,lint,format}-21.log。上一完整build通过后，针对桥接修改另行Worker build通过；最终完整build会在冻结验收结束后执行，不在真实运行中替换构建。

第21轮使用新的只读backup副本p22-context-lifecycle-aQkyAC，原请求SHA256不变，启动时记录324份JS/Rust哈希。保持原模型、协议和productionSkillId=script-to-media；已实际终止并恢复同一任务Worker。最终708秒、63条模型请求记录、62条有供应商usage，实际输入23871–86330 Token。以AGENT_TASK_CONTINUATION_STALLED失败结束，原failed状态保留。9份资料各1版、4场8镜均已保存，未发布、未重复创建，9068字符原要求跨重启完整保留；这不等于业务通过。

语义核对确认：后三场6镜引用数组全部为空。模型先把角色ID中469a抄成4697，校验正确拒绝；随后误判为草稿不支持引用，绕开了自己的必需引用要求。所有预期原对白在镜头正文中各出现一次，但多处时间安排不足以自然说完；两名蒙面人共用一张组合设定板且缺少适用分区，也不能满足单角色完整板要求。钱箱“先置檐下、后从车板滚落”的源稿冲突未另行列明，不能把没有编造转移解释当作已经处理冲突。business-output-review.json只负责机械导出，business-review.json另行记录失败和语义依据。324份构建哈希全部一致，未在运行中覆盖构建；完整资料、失败参数、检查点及原项目均保留。

### 第21轮完成检查反馈补修

真实失败另外确认了代码问题：交付检查把“已保存但引用不合格”的场次从保存数量及正文覆盖中一起排除。四场实际已落库，pending仍报savedCount=1、continue_outputs及已经存在的对白缺项，没有具体待修镜头，误导模型继续新建而非原地修复。这与Token上限无关。

沿用原交付检查与ContextManager，分离持久化事实和验证结果：兼容保留savedCount的校验通过含义，新增persistedCount；remainingCount按真实已保存输出计算。只有成功回执与当前项目活动对象可建立持久化事实，暂存、失败回执、归档或其他项目不能算入。已经存在但引用不合格的输出进入repairOutputs，携带真实shotId、归属outputId及production.read参数；全部目标存在时nextAction=repair_outputs，使用当前CAS通过scene.update_shot_prompts原地修复，保存ID、正文、时长和源顺序保持。正文覆盖独立于引用合格与否计算，不再把已有对白误报为缺失。独立交付项仍只分配一次输出，引用义务和最终校验不放宽。

引用验证错误新增具体references字段和准确查找路径，明确active draft/published制作资料都有效、工作区位置不代表文档类型、documentId不同于versionId或带前缀的资源ID。拒绝写入时不自动猜换ID、不删除引用、不重新创建资料，不改变原权限、类型、项目及小说资料边界。

新增场次/镜头回归先复现4项失败，修复后ContextManager、pipeline、deliverables和引用验证4文件172项通过，日志p22-context-repair-before-22.log及p22-context-repair-after-22.log。新增引用校验回归覆盖草稿、抄错ID、版本ID、带前缀ID、跨项目、错误类型、归档与小说资料；场次回归覆盖三种结构工具、正确计算真实已存数量、正文覆盖不误报，以及只修现有镜头即可满足原义务。未改Token、上下文窗口、传输阈值或v75表结构，无历史数据迁移或删除。最终门禁与下一轮真实结果另记，不能把这些回归当作长任务语义通过。

### 整集结构保存回执协议补修

复核发现另一处可复现的不一致：`novel.episode.submit_structure` 实际返回 `episode_structure_saved`，而交付计数、已创建镜头识别和制作技能完成检查只接受 `scene_structure_saved` / `scene_structure_partially_saved`。已保存整集可能因此被误判为缺少场次、提示词或时长；即使未读回，也应先识别实际保存的镜头并提示读回，而不是要求重新生成。

在现有 `agent-saved-production-receipts.ts` 增加统一的明确状态判断，由两处完成检查复用；不以任意 `_saved` 后缀猜测成功。仍须成功审计回执、当前项目活动对象和正文/引用/时长核验，暂存及 readiness 不算已完成。两个回归先复现失败，修复后交付检查、制作技能检查、保存回执、ContextManager 和引用校验5文件86项通过。日志：p22-context-receipt-before-22.log、p22-context-receipt-after-22.log。无需变更表结构或迁移历史数据。

此补修在第22轮真实验收冻结构建启动后实施，只改源码并运行测试，没有覆盖正在执行的JS/Rust构建。第22轮不能作为本补修分支的真实供应商验证；该轮使用 `scene.structure.stage`，其验证范围另行记录。最终构建与全仓门禁在验收结束后记录。

### 第22轮计划重新登记的进度倒退补修

本轮冻结运行直接复现：约677秒时全部产物已保存并读回，pending为空；模型随后以两个新key把六份资料、四个场次重新登记为带targetIds的汇总。原计划六项资料和结构仍然存在，但其产物被新汇总保留，约726秒时原七项重新变成savedCount=0，已有对白也误报缺失。这是计划更新改变产物分配造成的倒退，与Token限制无关。模型后来逐项补齐旧key的共享targetIds才重新清空待办，期间产生额外读回。

现将交付分配计算提取为同模块内部纯评估入口，登记计划与完成检查共用它。新计划持久化前对比原有未绑定条目的实际分配；新增或更改显式目标组不能夺走原条目已经保存的进度。冲突整次拒绝，返回原稳定key和明确修复方法：原key绑定实际ID；有意共享时在同一次更新中为各原条目明确共享targetIds。独立产物、显式共享、同key的数量/类型纠正仍保留，不替模型合并语义不同的义务。

文档与场次两个回归先复现失败，再通过；连同ContextManager、制作技能、pipeline和引用验证5文件186项通过，日志p22-context-allocation-before-22.log、p22-context-allocation-after-22.log。另对本轮SQLite只读切分真实登记回执前后审计，重新计算确认pending由0倒退为7；将相同登记交给修复后的源码会在保存前明确拒绝。证据在隔离副本allocation-regression-check.json；未重放工具、未改任务状态，不冒称实时模型复验。typecheck与lint通过，日志p22-context-{typecheck,lint}-allocation-22.log。本补修同样没有覆盖第22轮冻结构建。仍沿用v75，不改历史计划审计、不删除产物；旧的重叠计划保留诊断与显式原key修复途径，不擅自替用户判断不同计划项是否同义。

### 第22轮阶段回执引用歧义补修

停止后的独立只读复核还发现，遗留计划可能已经含有相互重叠的目标组。虽然后续新增/变更目标会被拒绝，未绑定的旧条目仍会把 `allocatedElsewhere` 中已保存的输出误描述成 `continue_outputs`，再次诱导业务写入。现新增 `repair_plan` 下一动作：先在原key上为有意共享的真实ID补绑定，保留逐字文本、引用和独立义务；重新评估后再读改或继续真正未完成的输出。没有自动合并或弱化历史计划。

同一真实待办还含有“先让人看看伤。”。选定剧本计划将其写作叙述，已读小说中却确有该句对白；当前持久计划的逐字义务来源和优先级尚未充分建模。此前尝试按选定计划缺句自动撤销 requiredTexts，但只读核验发现会误删有小说来源的要求，实验已撤回，未构建、部署或写入真实任务数据库。当前仍保留原逐字保护和人工可审查的来源差异；需另行设计带来源、版本与用户确认状态的义务修订机制，不能把该差异称为已修复。

双路径（制作资料文档和镜头正文）回归验证：已保存对象确被另一显式目标占用时先要求修复计划；共享ID补齐后只余尚未满足的文本；修正内容后无需创建第二份业务对象即可完成。既有无冲突的未绑定独立输出仍继续生成。回归先失败再通过，`agent-task-deliverables`、ContextManager、制作技能、pipeline和引用校验5文件188项通过，日志p22-context-plan-action-before-22.log、p22-context-plan-action-after-22.log。最新真实任务最终计划以只读数据库重算会返回repair_plan，原任务和要求没有改动，证据plan-action-regression-after.json；这只是源码对真实数据的离线判断，不是模型执行或业务验收。

真实调用反复声称“镜头绑定为空”，但最终六个镜头的 `shot.authoringIR.references` 均有有效的角色、场景和道具引用。复核发现 `scene.structure.stage` 回执仍暴露旧场次头的 `bindings.characterDocumentIds=[]`。这是历史暂存头信息，不是当前镜头引用；即使模型读回了镜头正文，也可能把该空字段误读为镜头仍未绑定。

现复用原阶段服务，现代IR回执移除歧义的旧 `bindings`，标注 `referenceScope=shot.authoringIR.references` 和 `sourcesScope=staged-scene-header`，说明通过真实shotId与production.read取得当前IR/CAS。仅pre-IR历史阶段保留旧bindings兼容读取。不复制每镜完整引用、不扩展正文、不改权限、参数校验或保存协议。真实工具集成回归先复现失败，随后相关5文件338项通过；日志p22-context-binding-receipt-before-22.log、p22-context-binding-receipt-after-22.log。该补修不在第22轮冻结构建中，不能据该轮宣布修复后真实验证通过。

### 第22轮真实长任务结果（未通过，人工停止且保留运行态）

隔离副本p22-context-lifecycle-WWKmme，原始9068字符请求SHA256保持ff094a1162e1406ab4455d4335504c19770e1c60f749bb67e9c791f28165dd59。使用原模型gpt-5.6-terra、Chat Completions、productionSkillId=script-to-media；已真实终止并恢复同一任务Worker。最后快照1451秒、164条模型请求记录，其中162条有供应商usage，实际输入23905–98868 Token。六份资料各一版本、未发布，4场6镜已保存，其中4镜各原地修订一次，无重复创建场次/镜头。原始要求跨重启完整保留。

因超过150次请求仍在重复复核，审阅者只终止身份已核实的隔离测试进程及其Node Worker，避免继续付费循环。没有写入业务canceled/failed/completed；保留generation的streaming及任务运行态，因此不是自然终态。最后有1项计划待办，包含既有产物分配冲突以及一条不同于本次源对白机械清单的文本；不能将此直接认定为正式产物全部缺失。测试会话exit1来自人工终止，不能冒称供应商或业务自然失败。原项目和桌面进程未改动，全部正文、参数、审计与检查点保留。

独立人工语义审查仍未通过：镜头3-2在5–9秒安排三句对白、递水和听者反应，时间结构合法但自然语速不足；双蒙面人仍共用组合板，缺适用材质色卡和表情分区；钱箱“先放檐下、后从车尾滚落”的源稿冲突未单列来源说明；镜头3-2允许蒙面人远景入画但仅引用沈砚舟/阿诚；末镜仍为rowVersion0，timing有9秒节拍而实际prompt无相对秒流程，并演出了源稿只交代托付的带箱离开。模型声称准备修复不等于实际保存。预期原对白各出现一次、无漏无重复、六镜都有timing与有效非空引用，只是机械检查通过，不能覆盖以上语义缺陷。

停止后已保存business-output-review.json、business-outputs.json、独立business-review.json和verification-stopped.json。重建之前核对启动时325份JS/Rust哈希，全部一致，结果在verification-build-check.json。整集保存回执、计划分配保护、阶段引用歧义三项后续源码补修均未混入该轮；只读allocation-regression-check.json也不能冒充真实模型复验。没有修改Token、上下文窗口或传输阈值，没有Schema迁移或历史删除。

第22轮后源码最终门禁：完整 `pnpm build` 通过；全仓 `pnpm test` 通过2,503项（Worker1,432、Desktop808、Persistence95、Generation Adapters80、Contracts48、LLM32、Context8）；`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 与 `git diff --check` 通过。Rust本轮末尾源码未改，沿用此前全量202 passed / 4 ignored。日志位于系统Temp：p22-context-build-22-verified.log、p22-context-workspace-22-final.log、p22-context-{typecheck,lint,format}-22-final.log。Rust此次不重跑；构建的Vite bundle size提示不是失败。门禁通过表示源码和自动回归通过，不改变第22轮真实业务未自主结束且语义审查不通过的结论。长输入真实验收清单继续未勾选。

2026-11-06 后续核验：逐字义务来源自动撤销实验已完整撤回。撤回后的交付检查、ContextManager、制作技能、pipeline和引用校验5文件188项通过；全仓 typecheck、lint、format:check 及 git diff --check 再次通过。将三份受实验影响的 TypeScript 源码（含测试）以内存编译方式与上述已验证构建比较，除 source map 注释外输出完全一致；没有重写构建或运行时数据。因此沿用该构建的2,503项全仓证据，不将实验版本的190项专项通过冒充最终门禁。核验日志：p22-context-rollback-focused-22.log、p22-context-rollback-{typecheck,lint,format}-22.log；构建一致性证据：p22-context-rollback-build-equivalence-22.json。未启动新的付费长任务，最新补修仍无修复后的真实供应商业务通过结论。

### 上一构建自动化门禁（第17轮，长输入业务结论另计）

2026-11-06：全仓 `pnpm test` 通过2,449项：Worker1,378、Desktop808、Persistence95、GenerationAdapters80、Contracts48、LLM32、Context8。Rust全量202 passed / 4 ignored；4项显式真实供应商验收不随普通单元门禁运行。Rust请求发送失败专项1项、ContextManager/完成要求/Native bridge专项101项通过。`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 通过。日志为系统Temp中的p22-context-{workspace,rust,focused,typecheck,lint,format}-17.log（个别门禁使用同构建前一轮文件名，见实际日志）。这些结果不代表长输入业务已通过；全量build将在当前隔离任务结束后执行，避免验收过程中替换Worker构建。
