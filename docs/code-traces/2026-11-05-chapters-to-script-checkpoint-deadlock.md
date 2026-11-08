# 章节生成剧本任务：参数契约冲突与强制交接死循环

日期：2026-11-05。用户要求查看当前 Agent 工具执行日志并解释反复打转原因。本次为只读现场审计和离线契约验证；未修改生产代码或用户项目数据，未调用供应商、重放任务或重启应用。

## 当前现场

- 项目：供奉的是；通过应用 recent-projects.json 定位项目，以 better-sqlite3 的 readonly/fileMustExist 模式读取。
- 任务：`c9063e00-2984-42c7-8f71-ed2ac08d1dc9`。
- Generation：`7bdc47c8-88a3-4a3a-96f9-83f3b24b380e`。
- 请求：对明确选择的《第一章 潮路》执行 chapters-to-script，生成并保存可编辑剧本草稿。
- 时间：19:05:56–19:15:55（UTC+8），约 9 分 59 秒；最终 failed，错误为 `AGENT_TASK_CONTINUATION_STALLED`，附带强制交接说明。
- 36 次模型请求，另有一条非模型的调度记录；累计记录 input_tokens=1,956,611、output_tokens=23,379，包含重复发送及缓存输入，不据此推算费用。
- 22 条真实工具审计；`document.submit_draft` 的唯一一次尝试在调用前 schema 校验失败，故不产生业务工具审计。成功文档保存 0 次，任务文档产物 0 条。

| 模型返回的工具名 | 次数 | 现场结果 |
| --- | ---: | --- |
| conversation.task.checkpoint | 20 | 真实执行 13 次：保存交接 3、读取交接 1、计划失败 6、无进展交接失败 3；另 4 次 schema 校验失败，其余调用未进入执行审计 |
| tools.load | 4 | 加载/复用工具，未保存业务产物 |
| project.structure.get | 3 | 成功 2 次，分页缺 expectedRevision 失败 1 次 |
| library.search | 3 | 查询源章节、约束与小说大纲 |
| library.read | 1 | 源章节完整读取 1 次，1604 字符，未截断 |
| production.skill.read | 1 | 取得 chapters-to-script 声明 |
| conversation.task.route | 1 | 路由成功 |
| document.submit_draft | 1 | documentKind 枚举不合法，调用前被拒绝 |
| 无工具的文本结束 | 2 | 强制交接尚未解除，触发续执行，最后因无进展失败 |

本轮与下午旧任务不同：源正文没有反复读取；主要轮次耗在计划校验、阶段交接与参数修复。不能用旧的 76 次请求/16 镜现场替代这次证据。

## 已确认原因

### 1. 剧本文档的计划契约与保存契约不一致

`agent-tool-definitions.ts` 的 checkpoint deliverables.documentKind 包含 `script`，`agent-task-deliverables.ts` 也接受并按真实文档 kind 验收；但 document.submit_draft 的 schema 与 `agent-draft-submission-service.ts` 的 KINDS 都不包含 script。

现场在 19:14:41 拒绝唯一一次文档提交，错误明确指向 documentKind 枚举。助手最终回复与交接记录均表示提交的是 script；原始参数正文未持久化，不能声称审计库保留了完整提交内容。当前数据库没有新剧本及保存回执。

production-skills.ts 的 chapters-to-script 声明还列出 novel.episode.submit_draft；它属于旧文档工具，不在当前 System Agent 清单，本轮 toolManifest 中也没有它。模型因此无法按声明切到该工具完成保存。

离线调用真实 schema/validator 和 saveTaskPlan 验证：script 计划不带 requireReferences 时被接受；同一 script 类型提交文档被拒绝。仅绕过提交 schema 仍会被业务 KINDS 拒绝；只改一处枚举不能完成修复，必须统一实际领域类型、计划验收、保存与目录显示语义。

### 2. 计划 schema 与执行校验存在未表达的字段组合规则，错误不能指导修正

模型看到的 schema 允许任意 deliverable 带 requireReferences。Worker 实际只允许该字段用于 scene.update_shot_prompts；即使 false，给 document.submit_draft 也会拒绝，统一报 `Invalid or duplicate deliverable fields.`。

第一份交接笔记自述使用了 document.submit_draft、script、requireReferences=true；离线用这一组合通过真实 schema 后，被真实 saveTaskPlan 拒绝，移除 requireReferences 则通过。现场 6 次计划执行失败均只有同一笼统错误，原始 deliverables 参数未记录，不能确认每一次都由同一字段导致，也不能把助手关于“script 计划不被接受”的说明当作 Worker 事实。

另有 4 次 save schema 校验失败：首次 remainingWork 超过 6000 字符且缺 workingNotes，之后连续缺 workingNotes。anyOf 的错误同时列出其他分支的缺字段和常量不匹配，进一步增加修复负担。

### 3. 强制交接与禁止无进展交接形成互相无法满足的规则

`pi-conversation-runtime.ts` 在上下文压力触发后设置 stages.required，只向供应商提供 checkpoint，并在 beforeToolCall 中只允许 operation=save；其他工具、plan、partial、read 都会被阻止。beforeComplete 也拒绝结束，要求继续交接。

`agent-task-checkpoints.ts` 同时要求 save 相比上次交接有新的成功证据；失败的计划和文档提交不算新证据。没有新证据时返回 TASK_CHECKPOINT_NO_PROGRESS。失败的 save 不生成新 checkpoint，`AgentTaskContext` 只有接收到新的成功 checkpoint 才清除 required。

因此 19:14:41 文档校验失败后：运行时要求只能交接 → 交接因没有新证据被拒绝 → 不能修正文档提交、不能声明 partial、不能正常结束 → 再交接。19:14:57、19:15:24、19:15:48 三次拒绝后，文本结束两次触发 continuation，最终报 AGENT_TASK_CONTINUATION_STALLED。

离线内存 SQLite 调用真实 taskCheckpoint 复现“已有相同证据时 save 被拒绝”；源码中的 required 清除条件与现场最后连续只有一个工具可用的请求元数据相符。该探针不是完整供应商或完整运行时重放。

### 4. 输入负担与保护缺口放大问题

系统区应用估算从首轮 3,637 Token 增长到末轮 23,066 Token，用户输入约 8,286 Token；源章节仅 1604 字符。首个交接发生在读取源正文之前，后续再交接两次。AgentTaskContext 将导航、工具政策、错误及工作证据放入后续 systemPrompt；不能把 messages 清空等同于总输入变小。现场未保存完整请求正文，无法精确拆分系统区增长中各类内容的占比。

现有 assertNoReadLoop 主要识别成功的重复加载、导航和相同正文读取；会跳过失败结果，且未将 checkpoint 校验失败纳入准备循环。此次正文只读一次，不会触发重复正文保护。最后的 continuation 防护只能在模型尝试结束后停止任务，无法在前面的重复参数修复时及时改变状态。

## 建议修复顺序

1. 统一 chapters-to-script 的真实保存类型和工具清单；计划 schema、业务服务、交付验收与项目目录共用同一契约，不让模型猜 script/plan/note 或使用不可用的旧工具。
2. 将 deliverable 字段组合规则准确表达在 schema 中，返回具体字段路径和允许组合；save 的错误只报告对应 operation 的问题。覆盖 schema 接受但执行拒绝的回归。
3. 在设置强制交接前检查是否存在新的可交接证据；无新证据且业务写入失败时提供修正或 partial/失败出口，避免只剩一个必定被拒绝的操作。保留原权限/CAS、同任务连续性及用户输入。
4. 降低与当前剧本任务无关的加载政策及重复交接开销；按实际发送内容核算预算。识别同一错误和状态的无进展重试，不能靠增加轮数上限掩盖。
5. 用本次任务形状验证“读取一次短章节 → 登记一份剧本 → 保存/校验失败 → 修正或准确退出”；成功必须有真实草稿回执，失败必须保留未保存状态及明确原因。

本报告不表示已实施上述修复。之前的离线重复准备修复没有覆盖这次“保存类型冲突 + 失败后强制交接”的组合路径。

后续用户明确要求修复，实施及验证另见[章节剧本与交接死锁修复计划](../AGENT-CHECKPOINT-DEADLOCK-REPAIR-PLAN.md)。本报告保留原审计时点的事实，不将修复后的离线测试当作历史任务成功或真实供应商复测。

## 验证与证据保留

- 原始只读抽取：`C:/Users/MSI/AppData/Local/Temp/p22-agent-loop-audit-ucVTjy/raw-report.json`，含本次 task/generation、工具审计、事件和请求元数据。
- 真实 schema/计划契约探针：同目录 `contract-probes.json`，验证上述接受/拒绝结果，未写项目。
- 内存 SQLite 交接探针：同目录 `handoff-probe.json`；没有供应商请求或用户项目写入。
- 本次只新增此审计 Markdown，未执行生产行为修复或全仓质量门禁。
