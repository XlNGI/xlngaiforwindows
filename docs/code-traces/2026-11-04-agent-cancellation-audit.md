# Agent 取消链路代码审计（2026-11-04）

范围：围绕任务 `1d2d0729-789e-4aa5-b2b5-d10a6ecc0a9c` 检查 Desktop → Worker → Pi → Native Provider 的取消、终态和日志链路。本轮只审计，未修改业务代码，未重放历史任务，未发起真实供应商请求，未写入用户项目数据库。

## 结论

确认 3 个独立缺陷。取消来源仍不能从历史记录还原；不能将下列可复现代码问题直接认定为该历史任务被取消的触发原因。

### F1 / P1：`llm.generation.cancel` 只改终态，没有停止 Pi 模型请求

- 位置：`apps/worker/src/handler.ts:2745`，`apps/worker/src/generation-service.ts:684`。
- 该 RPC 调用 `generationService.cancel()` 和 `terminateGeneration()`。对于 native generation，前者只保存取消状态，后者撤销工具授权、更新任务与请求账本；两者都不调用 `piConversationRuntime.cancel()`。
- 相比之下，`agent.generation.cancel` 在 `handler.ts:2532` 会调用 Pi 的取消入口，并通过 Agent 的 AbortSignal 向 Native 发出 `provider.stream.cancel`。
- 可复现条件：启动一个 Worker/Pi 拥有的请求后，单独调用 `llm.generation.cancel`。这也是 Desktop 在 `App.tsx:3517` 的取消入口；通常前置 `run.cancel()` 会先执行另一个 RPC，但观察连接丢失、本地 run 丢失或前置取消失败时，不能依赖客户端拼接来弥补服务器取消语义。
- 离线 SQLite + 模拟 Native stream 的实测结果：

| RPC | generation | task | runtime.active | provider.stream.cancel 次数 |
|---|---|---|---|---:|
| `llm.generation.cancel` | cancelled | cancelled | **true** | **0** |
| `agent.generation.cancel`（对照） | cancelled | cancelled | false | 1 |

- 影响：界面和数据库已经停止，实际网络流和执行槽仍在等待。后续工具调用有终态/授权校验，不据此宣称取消后仍能成功写入业务数据；供应商费用也不能根据本地 cancelled 或零 token 推断为零。
- 建议：将停止 runtime、持久化终态、撤销授权和部分产物处理收敛到 Worker 的统一幂等取消操作；两个公开 RPC 均使用它。增加“没有 Desktop run 句柄时取消运行中请求”的集成测试。

### F2 / P2：取消事件被错误记录为 `INVALID_PROVIDER_RESPONSE`

- 位置：`apps/worker/src/native-provider-bridge.ts:442`，特别是 `:449` 的兜底错误码。
- `applyPiEvent()` 将合法的 `cancelled` 事件变为 Pi 的 `aborted` 终态，随后观察回调遇到任何非 `failed` 事件时都记录 `INVALID_PROVIDER_RESPONSE`，没有区分 `cancelled`。
- 两种协议 `openai-responses` 和 `openai-chat-completions` 均已离线复现：stage 是 `cancelled`，metadata.errorCode 却是 `INVALID_PROVIDER_RESPONSE`。
- 该历史任务的请求账本正好存在这一组合，因此它不是供应商返回格式错误的证据。
- 建议：合法取消使用 `CANCELLED` 或省略错误码；仅本地验证实际拒绝的输出使用格式错误码。保留来源和原始错误种类，避免取消清理覆盖先前失败原因。

### F3 / P2：有计划的任务卡片忽略 status，取消和失败仍显示“执行中”

- 位置：`apps/desktop/src/ChatPanel.tsx:919`。
- 只判断 `phase === 'waiting_review'`，其余一律显示“执行中”；没有判断 `task.status`。
- Worker 的终止逻辑在 `apps/worker/src/agent-provider-loop-service.ts:4091` 将取消和失败任务都写为 `phase='recovering'`。这是流程阶段字段，不能作为当前仍在工作的证据。
- 使用实际组件离线渲染 `status=cancelled/failed, phase=recovering`，两个终态均显示“短剧任务 · 执行中”。
- 建议：任务卡片首先按 status 显示取消、失败、完成等终态，仅运行中任务使用 phase 描述；核对主窗口和分离窗口是否共用同一状态映射。
- 适用边界：此卡片要求任务带 `plan`。被查询的历史任务属于普通 document-query，本项不作为它被取消的原因。

## 历史证据与审计限制

- 目标任务对应请求“什么情况？”，模型 `UniCompAPI / glm-5.2`。
- 北京时间 2026-11-04 00:31:12.459 创建，00:31:25.236 取消，约 12.8 秒。
- 一次模型请求；收到 headers、first_byte、thinking 进度，记录 receivedBytes=440；无正文、无工具调用、无压缩。
- 任务事件只记录 system actor、通用的 `Provider generation cancelled.`，payload 为空；取消参数也只有 generationId，没有记录点击停止、项目卸载或其他调用来源。
- 因而本次代码审计能证明取消处理和显示存在缺陷，仍不能证明历史任务由哪个动作取消。需要在真正的取消入口补充可信的结构化来源，不能事后补造历史发起方。

## 离线验证

- 临时回归探针：Worker 4 项（一个正常取消对照通过，3 项揭示缺陷）；Desktop 2 项（两项揭示缺陷）。失败是探针对正确行为的断言失败，不是修复后测试结果。
- 探针源码与结构化观察已保存到 `C:/Users/MSI/AppData/Local/Temp/agent-cancel-audit-20261104/`。原工作区临时测试已移出，避免把预期失败用例留进常规测试套件。
- 源码复现方法：将 `worker-audit-cancellation.test.ts` 复制为 `apps/worker/audit-cancellation.test.ts`，在 Worker 目录运行 `pnpm exec vitest run audit-cancellation.test.ts --maxWorkers=1 --minWorkers=1 --testTimeout=15000`；Desktop 对应复制为 `apps/desktop/audit-cancellation.test.tsx` 并运行该文件。测试使用独立临时项目和模拟 Native transport。
- 原有相关测试基线：Worker 的 `native-provider-bridge.test.ts`、`pi-conversation-runtime.test.ts`、`project-runtime-integration.test.ts` 共 83 项通过；Desktop 的 `llm-client.test.ts`、`ChatPanel.test.tsx` 共 61 项通过；合计 144 项通过。现有测试没有阻止上述缺陷。
- 原始日志：`%TEMP%/agent-cancel-audit-worker.log`、`%TEMP%/agent-cancel-audit-desktop.log`、`%TEMP%/agent-cancel-audit-worker-baseline.log`、`%TEMP%/agent-cancel-audit-desktop-baseline.log`。
