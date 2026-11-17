# 技能声明读取循环：代码审计

日期：2026-11-13。范围：截图 90.png 所示 `script-to-media` revision 33 的技能读取、结果存储、请求投影、回读入口与循环监督。此次仅审计，未修改业务实现、产品要求或运行实例。

## 结论

确认一个直接相关的请求投影缺陷，以及一个使现有回归漏检的测试断言问题。能解释截图中“声明已激活，但没有实际读到”的现象；未读取截图对应任务的真实调用日志，因此不将它等同于该任务四次失败的完整根因。

## P1：首次显式读取成功，声明正文却在交给模型之前被替换

位置：`apps/worker/src/agent-context-manager.ts:1131`。相关位置：同文件 `:455`、`:899`、`:1211`；`apps/worker/src/pi-conversation-runtime.ts:1049`。

1. `production.skill.read` 返回完整声明，并在 Result Store 成功持久化。
2. `observe` 随即把这个结果登记为活动的 skill Evidence。
3. 准备模型下一次请求时，只要结果 ID 属于 `activeSkills`，就无条件返回 `active_skill_reference`，没有区分“刚刚显式请求的读取结果”和“已经交付、可以整理的旧结果”。
4. `activeSkills` 仅包含 `evidenceId/resultId/skillId/revision/read`，没有 `instructions`。正文并未出现在其他请求字段中。
5. 此时 `production.skill.read` 也被从请求工具列表移除。模型必须额外调用 `conversation.task.checkpoint(operation=result)` 才能拿到第一次请求读取的正文。

离线复现使用现有 `productionBundleFixture`、真实 Worker 工具执行、`AgentContextManager.prepare`，分别检查 `openai-responses` 与 `openai-chat-completions` 两条协议请求投影。结果一致：

```json
{
  "declarationCharacters": 3033,
  "originalResultHasInstructions": true,
  "nextOutput": {
    "status": "active_skill_reference",
    "resultId": "<实际持久化结果ID>",
    "instruction": "The declaration remains in Result Store. Read it only when required."
  },
  "firstInstructionPresent": false,
  "skillReadAvailable": false,
  "checkpointAvailable": true
}
```

3033 是序列化声明的 UTF-16 字符数，不是 Token 数或中文字数。该结果本来小于默认 6000 字符内联阈值；这里不是体积超限导致的必要归档。

正向对照：随后对原结果执行 `conversation.task.checkpoint`，参数为 `{operation:"result",resultId:<原结果ID>,resultLimit:16384}`。两个协议均返回 `task_result_read`，`nextOffset=null`，解析其 `content` 后的 `instructions` 与原声明完全一致。确认底层保存和回读入口正常，不能据此声称所有声明读取都不可恢复。

建议：保证本轮显式读取的声明正文在模型下一次请求中实际出现；仅对已经交付的旧副本去重。活动状态的说明必须与请求实际携带的正文一致，工具收起不能替代首次交付。可保留现有 Result Store、按需回读及项目正文不自动注入的边界。

## P2：保留技能的测试实际断言了“正文出现零次”

位置：`apps/worker/src/agent-context-manager.test.ts:731`。辅助覆盖：`apps/worker/src/production-bundle-state.test.ts:120`。

名为 `keeps an explicitly read skill once after clearing history, compaction and restart` 的测试使用：

```ts
expect(JSON.stringify(request).split(declaration.instructions.split('。')[0]!)).toHaveLength(1);
```

`split(片段).length === 1` 表示该片段出现零次，一次应为 2。这个断言既没有证明首次读取能实际交付正文，也没有证明“只出现一次”。后续断言主要证明原始结果仍在存储、状态带有引用，不能替代模型请求内容验证。

建议：分别覆盖首次读取的正文交付、旧副本去重、清空历史/重启后的有效恢复，以及结果回读。明确区分存储成功与模型实际收到。

## 验证

既有聚焦回归命令：

```powershell
pnpm --filter @ai-video/worker exec vitest run src/agent-context-manager.test.ts src/agent-context-results.test.ts src/agent-context-budget.test.ts src/agent-task-repair.test.ts src/production-bundle-state.test.ts --maxWorkers=2 --minWorkers=1
```

结果：5 文件、159 项通过。

临时审计用例在两种协议下执行完整技能读取，并在第一次模型请求投影上断言 `nextOutput.instructions === full.instructions`；两个用例均失败，实际值为 `undefined`。同一用例中的完整结果回读正向对照均通过。临时用例验证后移除，没有把预期失败测试留在常规测试目录。

本轮没有修复实现，未执行全仓发布质量门禁，未调用真实模型、重放用户任务或修改用户项目数据。四次相同失败的停止规则有既有回归覆盖；本次未发现应取消或提高该阈值的证据。截图中具体失败的工具名称、原始错误与参数仍需对应任务日志确认。

## 审计后的补修

后续用户要求修复。实现沿用本任务已激活的 Evidence：在 `taskState.activeSkills` 中提供完整 `instructions`、标题、描述与内容哈希，历史技能回执明确指向这份正文。该投影独立于近期工具历史，所以首次读取、历史清空及 Worker 重建后都可用。去重限定为技能读取工具及活动声明的相同内容哈希，兼容不同调用 ID 重复读取的旧历史；新版本只保留活动正文。原始结果不变；未激活技能与未读取项目正文仍不自动加入。没有修改失败循环阈值、业务权限、数据库 Schema 或生产技能 revision。

先新增双协议真实 Worker 工具执行回归，确认修复前两项均因缺少 `activeSkills.instructions` 失败，再修改实现使其通过。回归验证完整声明逐字相等、普通请求中只出现一次、原始历史副本去重、恢复快照／空历史重启、结果全文回读及继续 `production.bundle begin`。原有保留声明测试纠正“零次”断言，扩展覆盖 `script-to-media` 与 `chapters-to-script` 的新版本替换。

追加不同调用 ID 重读的反例：仅按 resultId 去重时两个协议均错误出现两份声明，出现一次的断言失败。改为活动声明内容哈希去重后复验，原始两次结果及显式范围回读继续保留。

聚焦回归命令：

```powershell
pnpm --filter @ai-video/worker exec vitest run src/agent-skill-context.test.ts src/agent-context-manager.test.ts src/agent-context-results.test.ts src/agent-context-budget.test.ts src/agent-task-repair.test.ts src/production-bundle-state.test.ts --maxWorkers=2 --minWorkers=1 --reporter=dot
```

结果：6 文件、162 项通过。追加不同调用 ID 的去重补修后，对受影响的三个文件再次执行，66 项通过。

门禁过程：首轮 `pnpm test` 在执行过程中追加了去重反例及补修，该轮两个新用例仍表现为补修前的重复正文，Worker 记录 1 文件失败／99 文件通过，2 项失败／1586 项通过。不能将该命令记为全仓通过；最终代码另启进程重跑 Worker 全量，结果在下文补记。首轮其他工作区已通过：Context 8、Contracts 49、LLM 32、Desktop 863、Generation Adapters 81、Persistence 102，Domain 无测试文件。

最终代码的 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build` 及 `git diff --check` 已通过。首轮 Lint 的新测试 JSON 解析类型错误已纠正，最终 Lint 通过；构建只有 Vite 现有大包体积提示。已核对编译后的 `apps/worker/dist/agent-context-manager.js` 含完整声明投影与内容哈希去重。

最终 Worker 全量重跑命令：

```powershell
pnpm --filter @ai-video/worker exec vitest run --testTimeout=15000 --maxWorkers=4 --minWorkers=1 --reporter=dot
```

结果：100 文件、1588 项全部通过，用时 193.14 秒；结合其他工作区已通过的 1135 项，所有工作区合计 2723 项通过。这里分别记录首轮失败和最终全量复跑，不宣称首轮 `pnpm test` 成功。原始门禁日志保留在工作区 `.codex-skill-fix-*.log`（Git 忽略文件）。源码 SHA-256 为 `6E46CB64D7F81D7C084153461EFB551868D44838A6F49666AF1C59A95A5096D7`，编译后 Worker 模块 SHA-256 为 `FC84179C22FAA2730A33EE695D2CD8AC238FF0F8D9C48E27C7F56197D3BD9E13`。

真实模型及截图任务续跑未执行，未安装或替换正在运行的应用／Worker。此次是既有合同实现修复，没有需同步 DOCX 的产品决策变更。
