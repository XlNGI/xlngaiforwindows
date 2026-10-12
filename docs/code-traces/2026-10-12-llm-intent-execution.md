# LLM 语义判断与结构化执行验证

日期：2026-10-12（北京时间）

用户要求：普通提示词的语义交给 LLM，不能在请求发送前由 Desktop/Worker 关键词规则判死；保留真实结构化执行保护。

## 根因与改变

此前普通提示词进入 `inferNovelWritingIntentFromPrompt`、Worker 目标解析与 `pendingReason`，章节和锁在请求前产生。`enforceExplicitUserIntent`、`hasSystemReadIntent`、`hasSystemOperationIntent`、普通文档完成检查和 Pi 通用计划选择又依赖提示词正则。多章请求只取得一个冻结目标时，第一章提交后相同授权已消费，后续调用产生 `AGENT_TOOL_AUTHORIZATION_REPLAYED`。已调查的 14:31 会话中确认表为空，模型的“再次授权”描述没有真实 Worker 确认请求作依据。

现在：

- Desktop 原始会话统一交给文本工具模型，移除活动关键词分流、前端拆章及自动拼接项目文档正文。
- `agent.run` / `agent.generation.prepare` 普通入口不再提前运行小说语义解析。快捷动作的结构化提示进入模型上下文，不在请求前创建章节。
- 普通 Pi 不增加分类/计划 Provider 轮次。模型在正常轮次决定回答、澄清、检索或执行工具。
- 工具由服务可用性、结构化设置及预算决定。提示词关键词不决定工具可见性。
- 新工具 `document.submit_draft` / `novel.chapter.write_draft` 的每次成功提交创建独立产物任务。父会话任务可继续，子任务各自持有一个主要产物和审核状态；章节子任务持有独立锁。
- 查询不会提前完成父会话。模型下一步可使用 Worker 刷新的步骤授权继续写入多个产物。
- Worker 注入执行任务/调用身份，模型参数不能覆盖身份。执行仍检查项目/session/会话、实际目标 ID、生命周期、CAS、审核锁、幂等和预算；写入事务失败时无子任务/章节占位残留。
- 新文档类型和小说参考绑定来自结构化字段；引用证据沿用父会话实际检索来源。任务详情聚合实际子产物，Desktop 按真实章节 ID 定位最后提交的章节。
- 删除、归档、发布、付费提交和受保护设置等既有真实确认流程保留。

## 验证

- 全量 `pnpm test` 通过：Worker 552；Desktop 298；其他工作区包同样通过，详见 `.llm-intent-tests.log`。
- `pnpm typecheck` 通过。
- 最后对可选章节提示与父任务结果状态的调整再次通过 Worker 类型检查、相关 127 项回归、变更文件 lint/format。
- 全仓 Prettier 和 `git diff --check` 通过。
- `cargo test`：129 通过，1 忽略。
- 变更文件 ESLint 通过。全仓 ESLint 仍有既存 `.m2-ui-novel-open-goal/validate.cjs` 的 9 个 `no-undef`；未改动该忽略目录的历史验证脚本。
- 新回归验证两种协议的真实 Pi 工具循环：查询 → 第四章 → 第五章 → 正常结束；2 个独立待审核任务、2 个章节锁、0 次确认。
- 错误 ID、真实跨项目 ID、归档目标、错误 CAS、重复章节审核锁、旧步骤 handle、任务调用配额均被校验，未产生非法产物。
- 多普通文档、参考文档的结构化绑定、已有普通文档版本修订有独立产物记录。讨论/否定/无关键词的原始提示词均可进入模型轮次，不产生预建章节。
- `node apps/worker/scripts/validate-llm-intent-sidecar.mjs`：最终安装包使用的生产 Worker 8 组用例通过（2 协议 × 2 入口 × 有/无 hint）；先查询再连续提交、错误写入回滚、待审核草稿按需检索、无正文自动注入、无二次确认。最终报告：`C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-7IDf6E/report.json`，日志 `.llm-intent-final-sidecar.log`。

## 边界

测试模型由本地 faux 响应驱动，sidecar 用例显式模拟结构化 Tool Call；没有真实付费 Provider 请求，没有修改用户项目数据库，没有安装或重启用户应用。自动化验证证明调用链与执行保护可工作，不保证所有真实模型对所有提示词都作出正确语义判断。草稿审核保留。

旧辅助函数和显式结构化任务兼容路径保留；它们不参与普通会话的语义路由。此次未引入数据迁移。

## 本地构建产物

`pnpm tauri:build` 最终构建成功，日志 `.llm-intent-final-build.log`。

- 安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`
- 时间：2026-10-12 17:34:16（北京时间）；大小：22,328,813 字节。
- SHA-256：`284F4A12C67F9159FF0E4F8A327174416B541DE134AE68AB19E13010A5F674E7`
- 包内 Worker 构建源：`apps/desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe`
- Worker 时间：2026-10-12 17:33:04；大小：75,023,200 字节。
- Worker SHA-256：`F7C5B3D514E50AD858300362082F932AE8BC35D7B42C0C91CD5DC9528DB9CDB3`

这是本地测试安装包；没有代用户安装，没有启动真实 Provider 验证。早先 15:04 等构建的哈希不适用于本包。
