# Agent 编排 P1 统一会话 Pi Runtime 验证记录

日期：2026-09-03  
阶段：全系统 Agent 编排 P1  
结论：完成

## 实现范围

- 所有普通问答、文档、研究、小说和短剧会话默认由 Worker-owned `PiConversationRuntime` 执行；`AI_VIDEO_PI_CONVERSATION_RUNTIME=false/0` 保留开发期 `native-agent` 回退。
- 新增 `AgentProviderToolGateway`，把 Pi 单工具回调适配到既有 Worker 授权、确认、事务、幂等和审计服务；授权句柄不进入模型参数或 Tool Result。
- 非短剧会话复用现有 `AgentProviderLoopService` 动态工具授权，短剧继续使用 plan-first、deliverable 依赖和完整性门禁。
- 新增 `conversation.runtime.get` 与 `conversation.runtime.confirm`，Desktop 可展示 Worker 生成的确认请求并把批准或拒绝结果返回挂起的 Pi 工具调用。
- 会话 Agent 模型统一要求 `text=true`、`streaming=true`、`tools=true`；无效历史选择不静默替换，用户必须明确选择支持工具调用的模型。
- Desktop 与 Worker 使用共享的 `inferUnifiedAgentCapabilityHint`。该结果只用于 UI/离线提示，LLM/Pi 负责自然语言理解和工具选择，Worker 策略仍是业务权威。
- `agent.run` 不再在进入 Pi 前执行图片/视频准备。明确媒体请求会进入统一 Agent；图片/视频 Provider 和媒体模型仍必须由用户在后续媒体流程中明确选择，Worker 不自动选择或替换。
- 普通无工具问答可正常收敛为只读完成；Schema 待确认状态不会被最终说明轮覆盖；确认超时时间受 Node 定时器上限保护。

## 固定边界核对

| 边界 | P1 结果 |
|---|---|
| Runtime owner | Worker；React 仅启动、观察和确认 |
| Provider owner | Tauri Rust；凭据不进入 Node/Pi |
| 运行时事实源 | 当前项目 SQLite；未引入 Pi session backend |
| 自然语言理解 | 由已选 LLM/Pi 完成；正则仅提供非权威 hint |
| 工具执行 | Worker 校验授权、项目范围、状态机和事务后执行 |
| Agent 模型 | 用户在会话选择一次；不支持 tools 时明确要求重新选择 |
| 媒体模型 | 与 Agent LLM 分离；用户明确选择 Provider/媒体模型 |
| 高风险确认 | Worker 创建确认，Pi 挂起，Desktop 回传一次决定 |
| 短剧完整性 | 继续执行 plan-first、依赖图和 package complete 门禁 |

## 自动化验证

| 命令 | 结果 |
|---|---|
| `pnpm.cmd --filter @ai-video/contracts test` | 12 项通过 |
| Worker P1 聚焦测试 | 76 项通过：Router、Pi、工具网关、Provider loop、Handler |
| Desktop P1 聚焦测试 | 50 项通过：App、ChatPanel、LLM client |
| `pnpm.cmd test` | 554 项 JS/TS 测试通过：Contracts 12、Context 7、LLM 10、Generation Adapters 17、Persistence 25、Desktop 176、Worker 307 |
| `pnpm.cmd -r typecheck` | 8 个工作区包通过 |
| `pnpm.cmd lint` | 通过 |
| `pnpm.cmd format:check` | 通过 |
| `git diff --check` | 通过 |
| `pnpm.cmd build` | Contracts、Domain、Context、LLM、Adapters、Persistence、Worker、Desktop 全部通过 |
| `pnpm.cmd --filter @ai-video/worker validate:pi-runtime-spike` | Pi 0.84.3、12 项能力检查通过；无网络请求、无凭据载荷 |
| `pnpm.cmd worker:sidecar` | Windows x64 sidecar 构建通过 |
| `pnpm.cmd --filter @ai-video/worker validate:m7-sidecar` | malformed JSON 恢复、离线示例、缓存边界、诊断脱敏和完整性通过 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | Rust 71 项通过 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` | 通过 |
| `pnpm.cmd tauri:build` | Tauri Release 与 NSIS 构建通过 |

## Windows 产物

| 产物 | 大小 | SHA-256 |
|---|---:|---|
| Worker sidecar | 74,365,280 bytes | `5D86128197C9D72BC3D226C14901A7E47A9CA956686615B1643FFC6E6CE89BA4` |
| Desktop Release exe | 11,196,928 bytes | `65E1ED981E67055F77B320CC7C2D49DD18A46612F6C7FF0EB7A5AB5D751846CD` |
| NSIS installer | 21,623,058 bytes | `360BE3FE21438B2D6578388BD98B90D886515D0812BA2B104043DBCA5D565259` |

构建保留两个既有非阻塞警告：Vite 主 JS chunk 为 517.32 kB，超过 500 kB 提示阈值；MSVC linker 输出导入库创建信息。

## 未完成边界

- P2 尚未把 P0 冻结的通用 Registry、R0-R3 策略、统一错误和 Tool Result 红线全部接入生产工具路径。
- P3/P4 尚未完成独立 `media.*` 工具、付费提交一次性授权和 `submission_unknown` 生产状态机。
- P5 尚未把页面内视频轮询迁移到项目级后台运行时；项目切换、重启、断网、慢首 Token 和长时间任务仍需专项验证。
- 未调用真实或付费 Provider；未执行 NSIS 人工安装、覆盖升级和卸载，这些继续归入 P7。
