# Agent 重复状态与准备循环终止审计

日期：2026-11-13。

用户最终确认的错误是 `AGENT_PREPARATION_STALLED`，不是截图 90.png 中的 `AGENT_TOOL_FAILURE_STALLED`。本轮先审计聊天重复展示，再按补充信息检查执行器的准备循环监督。没有重发用户任务、调用真实供应商、删除历史记录或修改用户项目数据。

## 结论与证据边界

“每次追问建立新任务，所以重复都正常”的解释不能解释本错误。准备循环监督读取同一 `task_id` 的真实工具结果，与聊天渲染次数、不同历史任务的条数分别计数。

确认一处可以误触发该错误的执行缺陷，另确认两处展示缺陷，均已补修。只读检索本机最近项目未找到这次 `AGENT_PREPARATION_STALLED` 的任务记录，因此以下是源码机制及离线复现结论，不能替代该次现场任务的原始工具流水，也不能据此断言项目所有正文无重复。

## P1：新结果页没有清除准备循环计数

位置：`apps/worker/src/agent-context-budget.ts`，`assertNoReadLoop` 的 `task_result_read` 分支。

`conversation.task.checkpoint(operation=result)` 用于显式读取 Result Store 中的完整结果或候选参数。原实现识别了新的 `resultId/contentHash/offset/endOffset`，但仅更新发现集合和相关失败计数，没有清除 `preparationCounts`。因此下面的序列仍会在第四次加载处抛出 `AGENT_PREPARATION_STALLED`：

1. 读取完整结果的第 1 页，再加载所需工具。
2. 读取第 2 页，再加载相同工具。
3. 读取第 3 页，再加载相同工具。
4. 读取第 4 页，再加载相同工具。

这期间已经取得新的读取证据，不能视为完全没有进展。回归在修复前稳定失败；相同页重读、空页、失败页三个反例仍正常终止。

补修只在首次成功读取一个新且非空的结果范围时清除准备计数。四次空转停止阈值不变；未改变写入、权限、CAS、业务完成判定，也没有把读取标记为保存成功。

双协议 ContextManager 集成验证使用真实 Result Store 分页，连续读六个不同页，并在每轮重建 Manager。新页允许继续；随后反复读取相同页再重复加载，仍按原阈值停止。没有扩大正文自动注入、检索范围或附件索引。

## P2：重试状态被挂到原回复和重试回复两处

位置：`apps/desktop/src/ChatPanel.tsx` 的 `agentTaskForAssistantMessage`；`apps/worker/src/document-workflow-service.ts` 的 `getTask`。

重试保留原 `user_message_id`，但生成新的助手消息和执行任务。原 UI 在缺少阶段边界时按该用户消息选择最新任务，可能把重试任务的工具状态同时挂在旧失败回复和新回复下面，造成真实的重复显示，并掩盖原任务失败状态。

修复前两个回归分别覆盖重试有／无阶段边界，都出现两份相同检索状态。Worker 现在从持久化 generation 关联返回 `assistantMessageIds`，UI 优先按真实助手消息归属匹配。旧数据只在归属无歧义时回退，不凭“最新更新时间”把同一状态复制到多个重试回复。真实 Worker 回归验证共用用户消息的两个任务仍各自返回自己的助手消息 ID。

## P2：旧分页响应混入新任务列表

位置：`apps/desktop/src/TaskLogView.tsx`。

加载下一页期间切换项目或筛选，旧请求返回后仍追加到新列表。修复前两种切换场景均复现。现在刷新、切换和卸载使旧请求失效，旧结果、错误、游标及 loading 收尾不能覆盖当前列表；分页入口同时阻止尚未完成的重复请求。

## 验证

- 修复前：聊天重试归属 2 个用例失败；旧分页 2 个用例失败；新结果页被误判的用例失败，3 个空转反例通过。
- 修复后专项：Worker 的 ContextManager、ContextBudget、任务修复、技能读取及 Pi Runtime 共 5 文件 172 项通过；两协议均覆盖。
- Worker 最终全量：`pnpm --filter @ai-video/worker exec vitest run --testTimeout=15000 --maxWorkers=4 --minWorkers=1 --reporter=dot`，100 文件 1,595 项全部通过，288.51 秒。包含真实服务的重试消息归属回归。
- Desktop 最终全量：95 文件 871 项全部通过，108.83 秒。之后仅调整异步测试的 `act` 写法以通过 Lint，任务日志文件再测 18 项全部通过；专项和全量范围重叠，不相加。
- 全仓 `pnpm typecheck`、`pnpm lint` 和 `pnpm build` 通过。构建仍提示现有 Vite chunk 超过 500 kB；本轮没有调整拆包。
- 本轮改动文件的 Prettier 校验及 `git diff --check` 通过；没有为其他工作区改动批量改写格式。

全量日志：工作区根目录 `.codex-repeat-worker-final.log`、`.codex-repeat-desktop-final.log`、`.codex-repeat-typecheck-final.log`、`.codex-repeat-lint-final.log`、`.codex-repeat-build.log`。这些日志仅作本机核对，不含真实供应商验收结论。

本轮是既有合同缺陷修复，没有新的产品决策，不需要更改产品 DOCX。源码修复不代表用户已安装新版，也不代表原失败任务已经恢复。

## 用户请求打包后的交付

2026-11-13 16:17（Asia/Shanghai），`pnpm tauri:build` 成功，重新构建 Worker sidecar、前端与 Rust release，并生成 Windows x64 NSIS 安装包：

- 路径：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`。
- 大小：77,295,588 字节（73.71 MiB）。
- SHA256：`628DC79F7CE694E181507BC8D83DE5B7675FDA0AD63F46ECE009991A13501A98`。
- 新 sidecar 与安装包构建目录中 `ai-video-worker.exe` 的 SHA256 一致：`BF15DE9C5C0BFA940D69063EE5676D5A964877FBC297F6780204B8B6FC6B5A35`。
- 新 sidecar 运行 `validate-project-runtimes.mjs` 和 `--single-project` 均通过，覆盖项目创建、保存、重开、项目作用域与旧 session 拒绝，以及单项目兼容入口。验证仅操作隔离临时项目，未调用真实供应商。

打包日志：工作区根目录 `.codex-repeat-installer-build.log`。没有安装、覆盖用户运行实例或重发原失败任务；现场任务的唯一根因仍需其原始工具流水核对。
