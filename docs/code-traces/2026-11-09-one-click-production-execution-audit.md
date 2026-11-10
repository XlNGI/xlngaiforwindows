# 剧本页一键生成制作资料：执行审计与功能复验

日期：2026-11-09。审计对象：任务 `4b089522-8131-4d8c-8aac-19c6739199e3`，以及截图中的事后诊断任务 `6985579f-413b-46cb-988e-0e22c274cfd6`。所有展示时间均为北京时间。

## 结论

这次任务没有完成。主要故障是计划更新和验收协议的错误恢复不能收敛，无进展监督又被细碎的参数差异绕过。截图将主要原因归为“范围大、分段写入”，没有覆盖后半程事实，不能作为本次故障的完整解释。单个失败样本不能估计功能的正常平均耗时。

只新增审计与验证记录；没有实施业务源码修复。项目数据库使用只读连接，并通过 SQLite backup API 冻结一致性副本，避免直接复制数据库时遗漏 WAL。脱敏证据见同目录 `2026-11-09-one-click-production-execution-evidence.json`；没有导出用户正文、模型端点、认证信息或完整运行配置。

项目目录仍名为“符合人体认同感”，`projects.name` 的实际显示名称是“夫是德国”，项目 ID 为 `17c07931-d9dc-43e4-b8ca-12a59e7a1f46`。截图与本次任务属于同一项目，不应因目录名称不同而误判为另一个项目。

## 真实执行结果

| 项目 | 只读记录 |
| --- | --- |
| 开始／结束 | 15:01:22 → 16:20:38，约 79.26 分钟 |
| 最终状态 | `cancelled`；错误 `Provider generation cancelled.` |
| 模型请求 | 211 轮；用 `metadata_json.requestKind=model` 过滤后的账本也为 211 条 |
| 累计 Token | 输入 23,503,337、输出 184,917；累计输入含缓存与多轮重复，不能当作单轮上下文或据此直接计算费用 |
| 业务工具调用 | 184 次，其中 47 次失败 |
| 已保存产物 | 4 场、13 镜；15:34:44 已有完整结构保存回执，最后正文写入 15:49:14 |
| 验收 | 16:18:03 有一条被接收的 `needs_revision` 记录，覆盖为 0，唯一问题的证据状态为 `needs_correction`；没有通过的镜头验收 |
| 尚未完成 | 镜头逐项验收、角色／场景／道具资料生成与验收、逐镜绑定及最终验收 |

最后正文写入至取消约 31 分钟。`readyToSubmit=true` 只证明可以提交审查，不能说“验收已通过”。被接收的 `needs_revision` 事件也不能当作完成；它的疑似问题证据尚未有效，不能据此断言正文存在已确认的语义缺陷。审计复放还确认这条零覆盖、未关闭问题的事件不会被 `isWorkBoundary` 当成有效进展。

取消记录没有充分说明触发者。应用启动时间与取消接近，仅是相关现象，不能据此断言手动取消、超时或重启造成取消。

## 审计发现

### P1：相同阻塞被参数差异拆散，长期无进展仍继续请求模型

位置：`apps/worker/src/agent-context-budget.ts:668`，参数归一入口 `:744` 和 `:771`。

失败指纹包含完整归一化参数和错误对象。checkpoint 仅归一少数说明字段，交付列表、意图组合、目标列表、评估内容等变化仍会产生新组。新证据还会清空失败计数。模型只要不断改动无关参数，就可能反复撞同一个业务保护，始终达不到同组四次的停止条件。

本轮直接加载当前 TypeScript 源码，将 19 次真实“用户义务保护”失败及原参数离线重放，故意排除中间成功调用：19 次被分成 18 组，最大组 2 次，未触发停止。正向控制将同一失败原样重复四次，会触发 `AGENT_TOOL_FAILURE_STALLED`。因此不是停止函数完全失效，而是失败归组不能覆盖现场的修参变体。该实验隔离验证指纹碎片化，不声称完整重演了所有运行时监督状态。

修复方向：以任务、稳定目标／计划 key、业务错误类别和真正错误字段监督重试；无关描述和其他条目变化不应重置同一阻塞。只将持久化版本改变、新有效验收覆盖、问题关闭或与阻塞有关的新证据视作恢复依据。保留合理纠错与长任务空间，不设置总调用／总轮数硬上限。

### P1：计划保护指错字段，通用建议又诱导更改受保护的创建意图

位置：`apps/worker/src/agent-task-deliverables.ts:333`；通用提示 `:1043`。

已有四场计划来自用户要求，意图为 `create`。后续调用将部分意图改为 `reuse` 或 `revise`，仍保留 `origin=user_requirement` 及要求来源 ID，却统一返回 `deliverables[n].origin: confirmed user obligations ... cannot be removed`。现场共有 19 次这一类失败；不能把它们全部描述成“删掉 origin”或全部描述成 reuse。

使用首个失败的真实参数在只读副本上调用当前 `saveTaskPlan`，再次得到同一 origin 报错，而输入改变的是 intent。另一方面，通用 `planRevision` 建议“Existing valid work may use intent=reuse/verify”，没有针对已注册的用户创建义务说明限制。这会把“产物已经保存但尚未完成绑定”的状态误导成“需要改变原计划意图”。

`persistedCount=1`、`savedCount=0` 在此并非内容丢失：初建镜头按阶段要求引用为空，而最终 `requireReferences=true` 仍未满足。阶段门禁已经把它指向镜头审查；剩余数量为 0 不等于完整交付完成。

修复方向：返回实际冲突字段、原值和提交值，明确保留原 `create` 义务，关联真实目标与保存事实，按阶段继续验收与绑定。不能通过放宽保护或删除绑定义务来清空待办。

### P1：验收参数校验把多类错误压成同一句话，批次重交不断放大

位置：`apps/worker/src/agent-task-review.ts:610` 至 `:633`；过期快照保护 `:442`。

`requirementId`、逐字要求引用、被审目标范围、verdict 的错误被统一返回为 `TASK_REVIEW_REQUIREMENTS_INVALID`，未指出 assessment 索引、字段及冲突值。11 次真实失败中，按源码判定顺序定位到的首项无效字段为：9 次 `requirementQuote`、2 次 `targetId`。出现了改写的要求原句、把 Skill／源稿内容当成 original 要求、混拼 UUID 和范围外目标；另有过期 reviewId 等独立错误。

最后一次失败携带 47 条 assessment，第 3 条（索引 2）仍是要求引用不属于对应原要求，整批被拒。事实不是“检索一直拿不到源稿”，而是已进入可提交阶段后仍不能生成有效的验收请求。

修复方向：提供结构化的逐字段定位和可用真实 ID／要求定位信息；允许模型按小批目标提交，复用已验证的候选片段，但不能自动改写语义结论、伪造证据或跳过逐项要求。保留过期快照、项目、版本、证据及覆盖保护。

### P2：事后诊断只有历史保存片段，没有当前阻塞摘要，模型又提前结束分页

位置：`apps/worker/src/agent-system-tool-service.ts:614`；`apps/worker/src/agent-saved-production-receipts.ts:51`；调用声明 `apps/worker/src/agent-tool-definitions.ts:898`。

诊断选中的 generation 正是本次 79 分钟任务，不是另一条约 31 分钟的旧任务。`conversation.task.route(decision=inspect)` 返回了正确取消状态和保存历史，但没有任务起止时间、当前阶段、最后一次实质进展、失败分类／最近失败、验收覆盖等摘要。保存回执默认从最早一页开始，历史记录不可替代当前状态。

这份结果共 15,302 字符，被外置到 Result Store。模型只读取 `[0,4096)` 和 `[4096,8192)`，第二页仍明确返回 `nextOffset=8192`，却直接结束回复。该截断位置停在 15:31 左右的早期回执；后面的四场完成回执、最新保存与后半程阻塞未被完整读到。此外，回执本身还有第二层 `receiptOffset=20` 分页，当前源码实际可读到 22 条保存历史。工具已有继续分页说明，模型未遵守；应同时改善摘要，避免必须读完冗长早期回执才能回答当前进度。

截图的“约30分钟、只到第二场、至少还需4次写入”和“主要因为制作范围较大”不能代表真实终态。它关于尚未完成资料、绑定，以及无法确认取消触发者的表述则与证据相容。

修复方向：inspect 先提供可校验的 task ID、起止／耗时、当前持久化数量、验收覆盖、最新进展、阻塞及分页完整性；历史回执按需展开。资料／输出列表为空也不能误说“没有实际保存”：场镜产物不一定登记在文档输出列表中。

## 功能复验范围

审计完成后运行了当前源码的聚焦功能回归及界面入口测试，结果如下。既有测试通过仅能证明其覆盖的流程，不等于现场模型任务完成或提示词质量通过。

重点包括：同一 Agent 入口及源版本、初建空引用、镜头与资料阶段门禁、逐项审查与失效、分批绑定、恢复／幂等、失败监督和保存历史分页。只使用隔离临时项目与模拟 Provider；不操作真实项目写入、不重启应用、不生成媒体、不调用供应商。

特别检查到：`agent-pipeline-remediation.test.ts:592` 的两协议完整阶段测试，在其成功路径提交 `passed` 时没有携带现场所需的 `requirementAssessments`。其他单测覆盖了要求矩阵，但不能把这个简单集成样本的通过解释为“实际8547字会话约束的验收链已跑通”。现场重放与正常路径测试需分别报告。

### 本轮实际验证结果

共 **432 项通过，0 项失败，0 项跳过**。机器可读记录见同目录 `2026-11-09-one-click-production-execution-verification.json`，包含受审源码 SHA-256、各文件测试数及限制。测试针对当前带有既有修改的工作区，不能与旧提交、旧构建或已安装应用混为一谈。

| 测试文件／样本 | 通过数量 | 验证范围 |
| --- | --- | --- |
| `agent-pipeline-remediation.test.ts` | 113 | 两协议工具边界、保存恢复、幂等、分阶段资料与绑定、取消保护 |
| `production-skill-validation.test.ts` | 53 | 逐项要求、精确正文证据、部分验收、过期状态、问题闭环及阶段失效 |
| `agent-task-deliverables.test.ts` | 50 | 产物分配、创建／复用／修改、保护既有要求、原位修正 |
| `agent-context-budget.test.ts` | 81 | 失败监督、真实进展识别、读回循环和上下文恢复 |
| `agent-saved-production-receipts.test.ts` | 1 | 保存历史分页、失败／跨项目过滤、元数据边界 |
| Desktop `App.test.tsx` | 107 | 剧本按钮复用统一 Agent、源对象／版本、会话及其他入口回归 |
| Desktop `ScriptWorkspace.test.tsx` | 2 | 剧本工作区入口 |
| Desktop `ProductionPanel.scene-bindings.test.tsx` | 23 | 场镜绑定 UI 与保存契约 |
| 补充的带要求矩阵完整阶段样本 | 2 | 两协议各一项，原始要求和会话约束 ID 均非空；完整走通镜头 → 三类资料 → 绑定后最终验收 |

补充样本使用一场两镜及三份资料。原始要求与会话约束均明确要求正文包含“庭院清晨”，逐目标对实际 `prompt`／`contentMarkdown` 提供精确证据。每次审查先验证缺少要求矩阵的 `passed` 会被拒，再提交包含两个真实要求 ID、逐字引用和正文证据的 assessment；最终绑定审查通过。它证明契约可用，但没有重演现场全部 8547 字约束或验证模型能自主构造正确请求。

补充测试临时生成在 `apps/worker/src/one-click-audit-requirements.generated.test.ts` 以复用现有测试夹具，完成后已清理；生成器、完整样本及 Vitest 原始报告保留在 `C:/Users/MSI/AppData/Local/Temp/p22-agent-task-tracking-20261109/`。未改动业务源码和既有测试文件。

执行命令：

```powershell
pnpm --filter @ai-video/worker exec vitest run src/agent-pipeline-remediation.test.ts src/production-skill-validation.test.ts src/agent-task-deliverables.test.ts src/agent-context-budget.test.ts src/agent-saved-production-receipts.test.ts --maxWorkers=2 --minWorkers=1 --testTimeout=15000 --reporter=json --outputFile=C:/Users/MSI/AppData/Local/Temp/p22-agent-task-tracking-20261109/worker-tests.json
pnpm --filter @ai-video/desktop exec vitest run src/App.test.tsx src/ScriptWorkspace.test.tsx src/ProductionPanel.scene-bindings.test.tsx --maxWorkers=1 --minWorkers=1 --reporter=json --outputFile=C:/Users/MSI/AppData/Local/Temp/p22-agent-task-tracking-20261109/desktop-tests.json
node C:/Users/MSI/AppData/Local/Temp/p22-agent-task-tracking-20261109/build-requirement-test.mjs
pnpm --filter @ai-video/worker exec vitest run src/one-click-audit-requirements.generated.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=15000 --reporter=json --outputFile=C:/Users/MSI/AppData/Local/Temp/p22-agent-task-tracking-20261109/requirement-tests.json
```

### 验收判断和下一步

正常参数下，隔离功能链可完成；带要求矩阵的契约也可走通。真实失败参数的源码重放仍确认监督与诊断缺陷，因此不能宣布“一键生成功能已修好”。本轮未实施修复，也未重启／重装运行实例。

优先处理同类阻塞监督、字段级修参反馈、创建义务与保存事实的提示一致性，再修正 inspect 摘要与分页判断。随后用隔离真实模型样本复验自主执行、提示词内容达标和耗时。当前测试没有调用供应商、没有修改用户项目、没有生成媒体；不能据模拟测试耗时推算实际生成应当需要几分钟，也不能以测试全绿替代真实任务验收。
