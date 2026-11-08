# 2026-11-08：现场上下文传输失败及长任务续跑

## 现场与根因

用户截图报 `Invalid context turns.`。真实项目只读备份：`C:/Users/MSI/Desktop/xlng/4141/project.sqlite`；任务 `03bc74d2-1cf2-4587-b7c9-fe8175ade22f`，Generation `955b917d-8063-449d-b5bc-2a66b4b136c0`。

03:00:09 UTC 的失败请求有 17 轮工具历史。本地估算 68,885 Token，Native 反馈校准规划 113,814，没有容量缺口；请求尚未到达供应商。ContextManager 已按模型容量选择历史，但 TypeScript NativeProviderBridge 和 Rust llm_stream 两端仍独立硬限 16 轮。因此有效上下文在传输边界被拒绝。运行构建也含此限制，不能归因于用户没安装新版。

现场模型能力来源为 fallback，512,000 只是用户此前指定的规划参考，不是已经核实的供应商真实窗口。本轮未改窗口、预算阈值或停止保护。

## 已实施

| 调整 | 代码 | 验证状态 |
| --- | --- | --- |
| 删除两端固定 16 轮门槛；继续验证数组、唯一调用 ID、工具配对、continuation 互斥、64 MiB 传输上限和最终协议容量 | `native-provider-bridge.ts`、Rust `llm_stream.rs` | 双协议 17／40 轮及真实容量拒绝回归通过；第一次真实续跑 17 轮成功发送 |
| 单镜头读取版本不再包含所有兄弟镜头的正文；仍包含本镜头、父场次、引用资料、默认设置；场次级读取仍跟踪全部子镜头 | `production-service.ts` | 先失败后通过：修改 A 不淘汰 B 的分页和工作资料；修改 B 自身／父场次／引用／默认设置仍使版本失效 |
| 最新 Task State 放在历史工具结果之后，通过既有 `userMessages` 传输；无历史时随原始请求；仅改本轮投影，不向持久化历史累积快照 | `agent-context-manager.ts` | 双协议、连续 prepare、检查点恢复、历史清空与 Token 分类和计数总和回归通过 |
| 对已保存但缺少必要正文的交付项，返回原义务 key、可用修复工具和真实目标 ID，明确无需重新登记创建计划 | `agent-task-deliverables.ts` | 结构工具三种变体、整组正文覆盖与双协议授权工具链通过；原计划防弱化、CAS、统一幂等仍生效 |
| 真实任务恢复验收使用显式隔离 fixture 与冻结 Worker／Native 宿主，核对原文和已有产物 ID | Rust `context_e2e.rs` | 真实验证结果分次记录在下方，不能将测试入口本身视为业务通过 |

读取版本与语义审查依赖是两个职责。`agent-task-review.ts` 的目标／前置资料／连续性依赖图未放宽；业务保存仍使用原 CAS、权限和统一幂等执行。工具结果仍回传 Agent，完整原文和工具结果仍在本地 Result Store，可按 ID／范围读取。

## 第一次真实续跑：仅修传输限制

隔离目录：`C:/Users/MSI/AppData/Local/Temp/p22-context-turns-20261108-juJqmf`。

冻结 Worker、Native 宿主和源文件 SHA-256 见目录内 `frozen-build.json`。原项目只读备份；仅隔离副本恢复 task／generation／attempt／assistant message 为中断状态，原终态触发器在同一事务恢复。第一次 fixture 漏恢复 assistant message，9 秒失败；修正 fixture 后重建副本再续跑，保留两次日志。

实际续跑 664 秒：原 `Invalid context turns` 不再出现；新增 ledger 79 条，其中 78 条有发送记录和供应商 usage，另 1 条是控制记录。供应商实际输入 8,291,234 Token、输出 20,891 Token，不能将 79 条 ledger 都称为模型请求。

结果：**业务未通过**。任务因 `AGENT_TASK_CONTINUATION_STALLED` 停止。最后三句对白缺失，镜头 3／4 有重复对白。9 份文档、10 个镜头的 ID 与基线一致，未重复创建；831 条完整 Result 的 SHA-256 全部匹配。核验见 `independent-final-verification.json` 和 `verified-final-prompts.md`。

Agent 最后声称“Worker 拒绝当前读取”，但实际工具存在成功读取回执，不能将模型解释直接当作故障事实。续跑进一步暴露的版本失效范围已用测试复现并修复；旧历史位于最新状态之后的问题也已修正。其对整集成功率的影响必须以第二次真实结果为准。

## 第二次真实续跑：版本范围与状态时序

隔离目录：`C:/Users/MSI/AppData/Local/Temp/p22-context-state-20261108-6eGWcp`。从现场备份重建，不覆盖第一次失败。初次 fixture 缺少 bindings 依赖，0.22 秒内失败，尚未发出供应商请求；补齐隔离冻结构建的 bindings 和 file-uri-to-path 后再运行，失败日志保留。

实际续跑 377.58 秒，新增 ledger 21 条，其中 20 条有发送记录、19 条有供应商 usage；实际输入 1,866,117 Token、输出 16,285 Token。最终为 `LLM response stream could not be read (Windows error 12152)`，属于供应商／网络流读取失败，不能归因于上下文超限。

结果：**业务未通过**。没有修改已有镜头，主要在反复变更创建计划并被原合同保护拒绝。仍缺“不是失踪。”及最后三句，镜头 3／4 存在四句重复对白。9 份文档、10 个镜头 ID 一致，427 条完整 Result 的 SHA-256 全部匹配。该次运行不能证明状态时序修复已经保证业务成功。

进一步核实：编辑工具并不要求先把 scene 创建义务改为 shot 修订义务；但缺失正文时旧完成检查只返回 `review_outputs`，缺少当前工具和真实目标。已修改统一交付检查返回 `repair_outputs`、`obligationKey`、`planChangeRequired=false`、适当工具和已有目标 ID。未放宽计划变更限制，也未让各工具自行判断是否重复创建。状态精简回执沿用既有 nextAction 投影，无需新增服务。

新增双协议集成回归通过真实授权工具入口完成：创建场次→检查缺句及修复动作→尝试削弱计划被拒绝→读取镜头当前版本→原位修正文→重复调用回放原回执→原创建义务通过。全程仅一次成功登记计划，不新增场次／镜头。

## 第三次真实续跑：缺句已补齐，内容仍未通过

隔离目录：`C:/Users/MSI/AppData/Local/Temp/p22-context-actions-20261108-Vj0wZT`。从第二次失败库只读备份继续；目录内 project.sqlite 保存本次输入基线，replay-project 是本次工作库。冻结清单包含交付检查改动，Native 生产传输与已测宿主相同。

约 462 秒后 Agent 和任务状态均报告完成。新增 ledger 39 条，38 条实际发送且有 usage；供应商实际输入 4,089,080、输出 17,973 Token。两处镜头原位修订补齐了四句遗漏对白，但镜头 3／4 仍重复四句对白；饮料在镜 3 已放桌角、镜 4 又拿在手中。**实际业务验收失败，不能把 Agent completed 当作成功。** 独立核对全部 SQLite 文档和镜头 ID 与本次输入基线相同，9 份文档／10 镜头未重复创建；692 条完整 Result 的内容 hash 全部匹配。

Native 宿主返回 exit 101：fixture 把全部 9 份存储文档与 document.list 的 8 份页面文档直接比较，其中一份小说章节按既有接口规则排除。这是验收 fixture 的范围错误，不是丢失文档；后续 fixture 分别保存全部 ID 与页面列表 ID，独立核验仍对照完整 SQLite。修正 fixture 不改变本次真实内容失败的结论。

新增已确认根因：Agent 提交过五项 needs_revision 发现，但引用的是不存在的 UUID，精确引用校验合法拒绝后，整份报告被回滚。随后空 passed 没有待处理 issueId 可以阻止它通过。不得为此接受伪造 ID 或取消精确引用验证。

## 审查发现生命周期补修

复用 agent-task-review 与完整 Result Store，不新增审查服务和数据表。v4 审查事件对已通过当前目标／范围／内容类别校验的发现逐项校验证据；引用错误保存为 evidenceStatus=needs_correction 的待核实项，并返回具体错误与 issueId。它不构成已确认内容缺陷，也不要求为了通过而编辑正文。同批合法发现正常保存。空 passed 不能清除任何待处理发现。

纠正证据时在 issues 中携带相同 issueId；仅允许纠正同一目标的待核实项，不能覆盖已确认发现。误报用既有 withdrawn、理由与当前有效证据显式撤回，无需修改有效正文；resolved 仍要求目标版本变化并完整读回。跨任务快照、过期快照、非法目标、系统未就绪、无效类别和不相关的结案证据仍拒绝。

兼容旧数据：按任务重放历史时，将旧 TASK_REVIEW_EVIDENCE_INVALID 失败回执的原始参数与该任务的原快照投影为待核实发现。只处理有合法目标、范围及内容类别的结构化报告，不把普通失败转成内容问题；不改写旧结果，不自动重开终态任务，不信任旧空报告对疑点的覆盖。纠正、撤回与幂等重放使用同一 issueId；完整证据始终留在原 Result Store。

先运行新回归确认旧实现 3 项失败，再实施。随后 5 个文件 333 项通过，涵盖双协议授权业务工具入口、错误引用后空 passed 拦截、合法纠正／撤回、SQLite 重开、旧失败报告恢复、外置回执、部分覆盖和完整结果保留。最终门禁与实际续跑另记，不能由这些自动测试推断业务完成。

第四次隔离续跑：`C:/Users/MSI/AppData/Local/Temp/p22-review-recovery-20261108-PYaNhs`。从第三次工作库只读备份继续，保留全部已保存产物和失败记录；冻结新 Worker、Native 测试宿主及源文件 hash。虽然 Agent 和任务都报告 completed，独立核验仍发现镜头 3／4 重复 10 句对白。该次业务验收失败，不能用任务状态覆盖内容核验结论；副本、日志与失败产物均保留。

第五次隔离续跑：`C:/Users/MSI/AppData/Local/Temp/p22-dialogue-repair-20261108-BjP7cq`。从第四次失败副本继续，保留原失败数据与所有已生成产物。独立核验确认 23 句原文对白各只属于一个镜头，缺失对白 0，待办步骤 0；9 份文档及 10 个镜头 ID 与输入基线相同；1,109 条完整工具结果均可读取且 SHA-256 无失败。**本次隔离业务验收通过。** 验收产物仅在临时副本，不修改原项目数据库，也不清除原任务的失败记录。

## 测试与工程边界

- 第一阶段：Worker 聚焦 199 项、Rust 库 205 项、全仓 2,596 项及 typecheck／lint／format／build 通过。
- 增量修复：7 个 Worker 文件 210 项通过；Rust 传输模块 52 项通过；四个相关 Worker 文件 342 项及新授权工具链 2 项通过。新时序使旧 mock 中的 prompt-only 读取失效，已修改为读取完整请求中的实际 userMessages，不把这些回归失败当成无关错误。
- 审查生命周期补修前，分包验证 Worker 93 文件／1,528 项、Desktop 90 文件／804 项，以及其他包共 269 项通过，合计 2,601 项；typecheck、lint、format:check、build 通过。Rust 库 205 通过／2 ignored／4 filtered，传输模块 52 项通过。补修后门禁另记。
- 本轮最终复测：上下文管理、Native 桥接、交付合同、Provider 执行循环和持久化业务验收 5 个 Worker 测试文件共 394 项通过；Worker typecheck 通过。源码桥接仅保留 `contextTurns` 数组结构校验，没有固定轮数长度上限。完整 Tauri 安装包构建成功，SHA-256 见上方；构建有非阻断 Rust unused 警告。
- 正文仍按需读取，不把整库或聊天附件加入检索；原用户要求、完整结果、正式产物与旧版本不删除。
- Worker sidecar、Tauri release 主程序和 Windows NSIS 安装包均构建成功。安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，SHA-256 `B048D27AB0479B9C91C248FE9F4547CF5BD4A5117C867C8474A12CE15054A0C1`。没有安装或替换用户当前实例。原项目中既有的 `Invalid context turns` 失败记录仍保留；新构建不会自动回写或清除历史记录。
- 无 Schema 迁移。单镜头读取哈希依赖缩小时，旧哈希可能保守失效一次，需要按需重新读取；历史 Result 仍可查询，不伪造其版本。场次、资料文档和默认设置的原有依赖继续有效。
- 没有重写 Runtime、取消语义审查、放宽写入 CAS 或替换用户安装实例。工作区含大量此前修改，本记录仅归属上述文件的本次变更。

## 本次文件范围

生产代码：`apps/worker/src/native-provider-bridge.ts`、`production-service.ts`、`agent-context-manager.ts`、`agent-task-deliverables.ts`、`agent-task-review.ts`、`agent-task-checkpoint-schema.ts`、`agent-context-results.ts`、`agent-context-budget.ts`、`production-skill-validation.ts`、`apps/desktop/src-tauri/src/llm_stream.rs`。

验证：`agent-context-manager.test.ts`、`agent-production-query-service.test.ts`、`agent-task-deliverables.test.ts`、`agent-pipeline-remediation.test.ts`、`agent-provider-loop-service.test.ts`、`project-runtime-integration.test.ts`、`production-skill-validation.test.ts`、`agent-context-budget.test.ts`、`agent-provider-tool-gateway.test.ts`、`test-fixtures/native-request-text.ts`、Rust `context_e2e.rs`。另有本计划、实施记录及检索主计划验证条目；其余既有工作区改动不算入本次修复。
