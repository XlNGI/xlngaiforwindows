# 剧本一键生成整套提示词与绑定：代码审计

日期：2026-11-09。范围：用户已确认的新业务流程的静态审计与实施规划。**本轮没有修改功能源码，没有运行应用或供应商请求，没有操作真实项目。新业务尚未实现或通过真实闭环。**

审计工作区 HEAD 为 `5ced12067bddd1e7478c4c5d89a676bebdf90f88`，已有大量未提交修改。本报告针对当时工作区内容，不把它等同于该提交或用户当前运行的安装包。41 个源文件的 SHA-256、行数和检索锚点见[机器证据](./2026-11-09-one-click-bundle-audit-evidence.json)。

## 1. 目标与结论

点击剧本页“一键生成”后，交付镜头、场景、道具、角色和音色样本的提示词，以及它们之间的绑定。音色样本在这里指**音色描述与试音文本**，不代表生成或导入实际音频。场镜结构、自然时长、声音用途与必要辅助文档也须符合本次源稿和用户要求。

建议继续复用统一 Agent、ContextManager、Result Store、任务状态和本地 SQLite，把现有“逐镜保存并验收 → 创建资料并验收 → 再写绑定”调整为“联合生成候选 → 程序校验 → 集中语义核验 → 局部修复 → 统一提交 → 独立读回”。小样本可一次创作，大样本必须按实际输入、输出和载荷预算分包。

**当前代码无法直接保证这一新闭环。**主要阻塞是旧阶段门禁、尚无整包临时引用合同、缺少音色文字对象，以及现有保存通道不能原子提交所有内容和关系。仅放宽某个门禁、增大上下文或增加并发均不足以落地。

## 2. 当前真实证据的边界

此前完整要求的两次真实运行结果如下，引用已有冻结证据，本轮没有重新执行：

| 样本 | 终态耗时                | 真实保存   | 制作资料／绑定 | 最终结论                      |
| ---- | ----------------------- | ---------- | -------------- | ----------------------------- |
| A    | 72 分 02.326 秒，216 轮 | 4 场 8 镜  | 0／0           | 失败；终态有效覆盖仅 1 个目标 |
| B    | 23 分 45.848 秒，82 轮  | 4 场 12 镜 | 0／0           | 失败；无被接受的目标验收      |

两者都因 `403 insufficient_user_quota` 终止，但终止前已存在正文要求遗漏和大量验收往返，不能把所有问题归因于余额。两次运行有重叠、产物规模不同且均未完成，不能据此宣称提速。首包平均约 9–10 秒、完整轮次约 17–20 秒也不是“读完一场”的纯推理耗时；应用无法从这些计时中分离供应商排队、传输与模型阅读。

详见[真实闭环与耗时验收](./2026-11-09-one-click-real-closed-loop.md)。旧方案的离线测试与构建通过不证明新流程已实现，也不证明最新补修已在真实模型或已安装应用中生效。

## 3. 可复用的已有能力

| 能力               | 代码入口                                                                                                                                                                        | 可复用边界                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 同一按钮与会话入口 | [App.tsx](../../apps/desktop/src/App.tsx#L3528)、[agent-generation-preparation.ts](../../apps/worker/src/agent-generation-preparation.ts#L12)                                   | 保留所选源对象、当前模型、Native 路径和取消机制，不新增创作引擎                |
| 不可变候选全文     | [agent-context-store.ts](../../packages/persistence/src/agent-context-store.ts#L254)                                                                                            | Result Store 已有结果全文和 hash，可承载候选；业务实体尚未保存时必须明确标识   |
| 文档与场镜 IR 保存 | [content-service.ts](../../apps/worker/src/content-service.ts#L148)、[document-workflow-service.ts](../../apps/worker/src/document-workflow-service.ts)                         | 复用版本、IR、CAS 和业务约束；需抽取可参加同一外层事务的领域保存原语           |
| 审查与义务状态     | [agent-task-review.ts](../../apps/worker/src/agent-task-review.ts#L12)                                                                                                          | 扩展同一机制识别候选 key／版本／hash，不另建质量状态库                         |
| 只读并发与账本     | [agent-provider-tool-gateway.ts](../../apps/worker/src/agent-provider-tool-gateway.ts#L347)、[provider-request-ledger.ts](../../apps/worker/src/provider-request-ledger.ts#L52) | 已有最多四路独立只读；已有请求用量与耗时基础，不等于多路模型创作               |
| 场次制作投影       | [production-service.ts](../../apps/worker/src/production-service.ts#L333)                                                                                                       | 已有整场正文优先、否则有序镜头投影；不能违背用户明确要求完整另存整场正文的要求 |

## 4. 主要发现

优先级：P1 表示实现新业务前必须解决的合同或一致性阻塞；P2 表示需随流程一并处理的展示、恢复和测量问题。以下是产品流程问题，不是已验证的安全漏洞结论。

### A1 · P1：旧阶段门禁分散在多条执行路径

- [production-skills.ts:25](../../packages/contracts/src/production-skills.ts#L25) 明确要求严格两阶段，首次镜头引用为空；[production-skill-service.ts:13](../../apps/worker/src/production-skill-service.ts#L13) 的当前 Skill revision 为 7。
- [agent-draft-submission-service.ts:58](../../apps/worker/src/agent-draft-submission-service.ts#L58) 在镜头未全部通过时阻止资料创建／修改，返回 `SCRIPT_TO_MEDIA_SHOTS_NOT_ACCEPTED`。
- [shot-prompt-service.ts:62](../../apps/worker/src/shot-prompt-service.ts#L62) 在资料未全部通过时阻止写绑定，返回 `SCRIPT_TO_MEDIA_MATERIALS_NOT_ACCEPTED`。
- [scene-structure-submission-service.ts:412](../../apps/worker/src/scene-structure-submission-service.ts#L412)、[agent-provider-loop-service.ts:2712](../../apps/worker/src/agent-provider-loop-service.ts#L2712) 调用初始引用为空的检查。
- [production-skill-validation.ts:31](../../apps/worker/src/production-skill-validation.ts#L31) 同时承载初建、阶段审查和最终完成检查。

影响：仅改变 Skill 文本会让模型按新业务提交、工具按旧业务拒绝，重新产生修参循环。必须版本化调整入口声明、授权和所有相关写入／验收／完成路径；存量运行任务保留旧语义，不隐式迁移。

### A2 · P1：持久 IR 只接受真实 ID，缺少包内引用解析

[project-ir.ts:19](../../packages/contracts/src/project-ir.ts#L19) 的 `ProductionIRReferences` 仅有三类真实文档 ID；[project-ir-validation.ts:5](../../apps/worker/src/project-ir-validation.ts#L5) 继续验证活动项目和资料类型。

影响：同一次生成中，尚未保存的角色、场景、道具不能被镜头用真实 ID 引用。模型编 UUID、按名字自动绑定、先写空引用再补都不能代替新闭环。候选需引入明确区分 `localKey` 与 `existingId` 的类型，在事务内预分配 ID 并统一解析；持久对象不允许残留临时 key。同名对象不自动合并。

### A3 · P1：实际音色音频已有，音色样本提示词合同尚缺

- [index.ts:962](../../packages/contracts/src/index.ts#L962) 的文档类型与 [project-ir.ts:6](../../packages/contracts/src/project-ir.ts#L6) 的资料 IR 没有 `voice`。
- [voice-reference.ts:1](../../packages/contracts/src/voice-reference.ts#L1) 表示实际 `audioId` 和声音版本；[voice-reference-repository.ts:23](../../packages/persistence/src/voice-reference-repository.ts#L23) 联查真实音频表。
- [VoiceReferencePanel.tsx:87](../../apps/desktop/src/dubbing/VoiceReferencePanel.tsx#L87) 的入口也是导入实际本地音频。
- [production-service.ts:259](../../apps/worker/src/production-service.ts#L259) 会直接消费资料正文用于生图，把音色说明混入角色生图正文可能污染实际输入。

建议：在现有制作文档体系中增加独立、可版本化的音色文字对象，含声音描述和独立试音文本；关联角色与说话者，且不冒充 `audioId` 或 Provider 音色配置。实际音频仍使用现有独立音频库。本建议需要在第一实施阶段固定具体合同，尚未实现。

### A4 · P1：可见人物引用不能代替说话者／音色关系

[project-ir.ts:19](../../packages/contracts/src/project-ir.ts#L19) 的角色引用用于实际出镜人物；[dubbing.ts:13](../../packages/contracts/src/dubbing.ts#L13) 已区分角色和旁白，[dubbing.ts:125](../../packages/contracts/src/dubbing.ts#L125) 有台词与起点；[production-service.ts:418](../../apps/worker/src/production-service.ts#L418) 仍从视觉角色和既有场次配置组织声音。

影响：画外客服、旁白需要音色，但不应因此成为画面参考人物；无对白的可见人物也不一定需要音色。应增加强类型的角色默认音色、镜头／台词说话者和音色文字引用，声音关系独立于视觉引用。`data.audioPlan` 可继续描述策略，不能让任意 JSON 中的 ID 自动成为有效关系。

### A5 · P1：现有场镜暂存会逐场提前提交

[scene-structure-submission-service.ts:454](../../apps/worker/src/scene-structure-submission-service.ts#L454) 每次最多提交一个完整场次；后续失败不回滚已提交场次。[agent-draft-submission-service.ts:46](../../apps/worker/src/agent-draft-submission-service.ts#L46) 以单文档为单位保存。

影响：这些接口可支持旧流程，但不能直接用作“全部候选通过后统一保存”的候选暂存区。新候选应先持久到同一 Result Store，全部核验后在短事务内提交业务实体；任何 LLM、网络或等待都不得处于该事务内。

### A6 · P1：ChangeSet 不能直接提交完整制作包

[index.ts:2052](../../packages/contracts/src/index.ts#L2052) 的 `AgentChangeSetItemDraft` 缺少资料 `contentIR`、音色关系和跨类型新对象引用。[change-set-service.ts:257](../../apps/worker/src/change-set-service.ts#L257) 虽支持所选条目的原子应用，但其 [applyDocument:809](../../apps/worker/src/change-set-service.ts#L809) 没有保存 `content_ir_json`，且在应用时才生成新 ID。

影响：直接塞入 ChangeSet 会丢 IR 或无法正确解析关系。应复用并抽取领域保存原语，在同一 Runtime 内增加有界的整包提交编排；如选择扩展 ChangeSet，须先完整补齐合同和事务测试。不能复制第二套 SQL 保存实现。

### A7 · P1：一次性请求受输出与多层字节上限约束

- [project-ir.ts:153](../../packages/contracts/src/project-ir.ts#L153)：单 IR 上限 32 KiB，创作 `prompt` 上限 20,000 字符。
- [index.ts:2632](../../packages/contracts/src/index.ts#L2632)、[worker/index.ts:145](../../apps/worker/src/index.ts#L145)：普通 Sidecar 信封限制 2 MiB。
- [lib.rs:65](../../apps/desktop/src-tauri/src/lib.rs#L65)：普通信封 2 MiB 与模型请求信封 64 MiB 是不同边界，不能用后者替代前者。
- [agent-context-budget.ts:13](../../apps/worker/src/agent-context-budget.ts#L13)、[agent-context-manager.ts:1172](../../apps/worker/src/agent-context-manager.ts#L1172)：已有输出预留，但没有新整包产物清单的输出估算；回退配置也不能证明供应商实际支持对应上下文。

影响：整套输入能放进窗口，不代表全部正文、IR 和引用能在一次输出中完整返回。应同时检查模型实际输出配置、预计输出 Token、每个 IR 字节和工具／传输载荷。截断只能视为候选不完整，按缺失对象继续；不得把残缺 JSON 当成成功。单个最终 IR 超限不能靠分包绕过，也不能由程序静默摘要或裁剪正文。

### A8 · P1：当前语义审查依赖已经保存的对象

[production-skill-validation.ts:123](../../apps/worker/src/production-skill-validation.ts#L123) 通过已保存实体、回执和读回构建审查；[agent-task-review.ts:12](../../apps/worker/src/agent-task-review.ts#L12) 已有 manifest、要求评估和版本化审查状态。

影响：新流程必须让同一审查机制支持候选 key、候选版本、全文 hash、引用依赖和原始要求覆盖。另一次 LLM 轮次应集中核验整包，不能由生成轮自报通过。对问题对象修复后，仅撤销受影响的审查覆盖；无关对象的有效覆盖保留。另一轮审查也可能漏判，因此不能省略程序校验及最终保存后独立读回。

### A9 · P1／P2：完成、检查和界面必须消费同一份真实回执

- [agent-provider-loop-service.ts:4244](../../apps/worker/src/agent-provider-loop-service.ts#L4244) 负责完成评估；现有流程可以出现任务终止为 `completed` 但 `completion_state=partial`，不能据单一状态展示业务成功。
- [agent-task-inspection.ts:79](../../apps/worker/src/agent-task-inspection.ts#L79)、[document-workflow-service.ts:2004](../../apps/worker/src/document-workflow-service.ts#L2004) 仍依赖旧保存与最终检查路径。
- [App.tsx:438](../../apps/desktop/src/App.tsx#L438)、[project-resource-map.ts:73](../../apps/worker/src/project-resource-map.ts#L73) 只有既有三类制作资料目录。

影响：新增音色对象、候选、提交和读回状态后，检查工具、交付反馈、产物数量、编辑入口、资源刷新与恢复都要贯通。候选保存不等于业务保存，可提交验收不等于通过，包提交成功不等于最终读回一致。必须保护未保存编辑、发布状态、人工锁定、媒体选择／禁用，以及项目切换和取消语义。

## 5. 时长与并发判断

现有证据显示大量时间用于连续模型轮次和验收往返，并未证明 SQLite 保存需要多线程。新流程首先减少“保存一项 → 再叫一次模型 → 修参数 → 全量失效重验”的往返，再测量同质量、同范围的完整交付。

首版保留最多四路独立只读；候选分包默认串行，业务写入统一提交。暂不引入多 Agent 或并行创作。后续只有在共享资料定义稳定、冲突与成本可控、真实账本证明收益时，再另行评估独立场次创作并发。

不提供未经完成样本验证的一般耗时或 SLA。记录点击、源读取、请求发出、首包、末包、候选就绪、结构检查、语义核验、修复、提交、独立读回、界面可见和最终完成；将完整交付时间与首稿、轮数、Token 增长、修参耗时分开。

## 6. 实施衔接与本轮验证

顺序实施、具体合同、事务和读回要求、故障注入、真实闭环验收及耗时账本见[整包实施计划](../ONE-CLICK-PRODUCTION-BUNDLE-IMPLEMENTATION-PLAN.md)。旧方案与真实失败证据保留，不把旧计划的已完成勾选转移成新方案的实施完成。

本轮验证仅包括源文件指纹复核、文档格式、相对链接与行锚点、`git diff --check`。未运行新的功能测试或供应商调用。41 个源文件指纹的复核和文档检查结果记录在[规划验证记录](./2026-11-09-one-click-bundle-planning-verification.json)。

素材库图片／视频规则、独立音频库、项目检索和本地优先架构均沿用既定要求；本轮未修改素材库产品规则，无需同步其 DOCX。
