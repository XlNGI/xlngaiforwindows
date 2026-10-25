# Agent 生成表单审核后直接提交

日期：2026-10-23

## 审计结论与确认决策

原链路中，Agent 调用 `media.image.prepare` / `media.video.prepare` 后展示模型和参数表单。用户点击“提交生成”，Desktop 将选择传回 Worker，但 `selectMedia` 只冻结本地草稿并返回 `prepared`，没有调用现有提交服务。需要 Agent 再调用 `media.generation.submit`，才会出现第二次费用确认。因此按钮语义和实际执行不一致。

用户确认：生成表单本身就是审核界面，点击“提交生成”即授权使用当次审核的模型和参数提交。不得以表单草稿结束，不得再要求第二次确认，也不依赖 LLM 追加提交工具调用。

## 实施清单

- [x] 审计表单、Worker 选择解析、Native/Pi 入口和唯一付费提交边界。
- [x] 表单直接调用现有 `MediaOrchestrationService.requestSubmission` / `confirmSubmission`；内部一次性凭证由本次审核决定消费，不再展示另一个确认框。
- [x] 在一个同步 SQLite 事务中冻结参数、创建任务、执行准入并消费 selection token，提交事务之后才等待 Provider。准入失败回滚任务；取消和校验失败直接进入 `rejected`，不破坏现有终态转换约束。
- [x] 保留原提交服务的快照校验、项目 session、一次性凭证、任务幂等键和未知提交状态处理。
- [x] Native Worker handler 和 Pi 工具网关等待异步结果，返回实际 `polling` / `succeeded` / `failed` / `submission_unknown` 等状态。
- [x] 表单点击后禁用重复提交；新 selection token 使用独立组件实例；提示文本明确直接生成及费用含义。
- [x] Native `agent.generation.selectMedia` 使用现有付费请求的 12 分钟 IPC 等待上限，覆盖同步图片推理，不影响 Pi 的即时 UI 决定解析。
- [x] 更新工具声明和会话工作流说明，描述审核表单的真实执行语义。
- [x] 增加真实本地 SQLite、真实准备/提交服务与模拟 Native Provider 的回归用例。
- [x] 完成最终质量检查并记录结果；全仓格式检查的既有问题见验证记录。

## 验证覆盖

- 用户修改后的提示词进入 Provider 参数，表单消费后只有一个任务和一个 Provider 请求。
- Provider 尚未响应时并发重放同一个 selection token，第二次请求被拒绝。
- 表单取消、非法参数、跨会话/过期 token、提交准入失败时不请求 Provider；准入失败不残留任务。
- Provider 响应丢失时返回 `submission_unknown`，不自动重试。
- 图片成功和明确拒绝、视频进入轮询，均不返回第二个审核请求。
- 提交异常返回已持久化的真实任务状态和错误，不把仍在等待或提交中的任务伪报为已失败。
- 付费请求期间切换项目或重新打开同一项目，旧任务不在新 session 创建续跑步骤或任务。
- Pi 等待异步提交结果后继续，不再弹出第二个付费表单。
- 非本次表单审核产生的已有草稿，仍通过同一个提交服务取得必要的用户授权。

## 验证记录

- 聚焦生成表单回归：12 项通过。
- Worker 全量：71 个文件、959 项通过；补充异常与重开 session 用例后，最终重跑编排、Pi 网关和付费服务相关 4 个文件，203 项通过。
- Desktop 全量：58 个文件、532 项通过。
- `pnpm.cmd typecheck`：8 个 workspace package 通过；最终 Worker 构建再次完成类型检查。
- `pnpm.cmd lint`：全仓 ESLint 通过。
- `pnpm.cmd build`：生产构建通过；最后的 Worker 保护逻辑修改后再次构建 Worker 通过。
- Rust IPC 等待上限回归：1 项通过。
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check`、`git diff --check`：通过。
- 本次修改的 TypeScript/TSX 文件 Prettier 检查通过。
- `pnpm.cmd format:check`：全仓检查未通过，仅报告本轮未改动的 `apps/desktop/src/App.test.tsx`；保留该文件原有改动，没有为通过检查而格式化无关内容。

## 范围

本次修复表单审核与提交的执行关系，不新增付费传输通路，也不根据提示词正文推断文档目标或业务结构。提示词按用户审核后的参数冻结，沿现有适配器和 API Schema 校验路径提交。

“分镜说明”如何纳入唯一制作提示词、Agent 提示词文档如何显式保存及关联，是此前讨论的独立问题，本次没有隐式迁移这些数据。验证全部使用临时项目和模拟 Provider，未提交真实付费请求，未修改用户实际项目数据，未自动提交历史草稿。
