# Agent 任务关系自动路由

日期：2026-10-17。

## 行为变化

发送界面不再让用户选择“有序跟进、并行新任务、补充指定任务”。用户消息原样进入 Agent；Worker 只在创建生成时登记一个尚未绑定业务依赖的运行。系统提示只提供同一会话活动任务的有限摘要，LLM 通过 `conversation.task.route` 决定：

- `independent`：当前请求独立执行，清除当前生成的临时依赖。
- `follow_up`：只允许引用已完成的同会话生成，冻结其摘要并记录依赖。
- `supplement`：把模型整理后的补充内容写入目标生成的补充队列。

没有活动任务时模型无需调用路由工具。活动目标尚未完成时，`follow_up` 会被 Worker 拒绝并要求模型重新选择；Worker 不在模型判断前阻塞当前轮次。

## 执行边界

任务容量、Pi 文本执行池、Provider 工具授权、项目/session/CAS、审核和付费确认仍由 Worker 强制执行。模型可以选择关系，不能伪造 generationId、跨项目引用或绕过审批。`prepared` 在界面显示为“等待 Agent 调度”，说明运行还未取得文本执行资格。

工具调用重放先按当前 task/attempt/provider step/call ID 返回已经持久化的结果，再校验授权，避免 Provider 重试同一个工具调用被误报为授权重放。工具授权有效期从 5 分钟延长为 30 分钟，仍保持单次/单步/项目 session 限制。

## 依据

采用主流 Agent 的 routing / orchestrator-workers 思路：路由由 LLM 基于输入和活动任务上下文动态决定，代码只负责边界、执行和资源调度。参考：[Anthropic Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) 与 [LangGraph Workflows and agents](https://docs.langchain.com/oss/python/langgraph/workflows-agents)。

验证：新增路由服务、生成服务、Provider 工具重放和 Desktop 自动发送回归通过；最终全仓 `pnpm.cmd test` 为 1,432 项通过，`typecheck`、`lint`、`format:check`、`build` 和 `git diff --check` 通过。构建仍保留既有 Vite 大包体提示；未调用真实付费 Provider。
