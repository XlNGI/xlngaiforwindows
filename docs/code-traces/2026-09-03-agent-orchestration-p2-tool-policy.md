# Agent 编排 P2 通用工具注册表与策略引擎验证记录

日期：2026-09-03  
阶段：全系统 Agent 编排 P2  
结论：完成

## 实现范围

- 新增 Worker-owned `AgentToolRegistry`，统一登记文档、小说、研究、Adapter Schema、任务计划、项目、会话、素材和设置工具；模型只能看到当前 Provider step 已签发授权句柄的工具定义。
- 每个工具统一声明 R0-R3 风险等级、确认策略、执行通道、输入 Schema 和结果 Schema。策略只能提高限制，不能把 R2/R3 降级为弱确认。
- 动态授权绑定项目、任务、generation、attempt、Provider step 和项目 session；授权句柄只保存哈希，短时有效，并通过 CAS 调用次数实现一次性或有界使用。
- `document.archive` 与 `document.restore` 的确认绑定原始工具调用、操作、目标文档、参数哈希、项目 session 和原授权；篡改、过期、拒绝和重复使用均由 Worker 判定。
- 统一策略错误合同覆盖未知工具、未授权、跨项目、授权过期/重放、参数篡改/非法、确认过期/重放和 Tool Result 红线。
- 所有模型可见 Tool Result 必须是 JSON，最大 64 KiB，单集合最多 100 项；禁止授权、凭据、Header、绝对路径、Provider 原文、Data URL 和长 Base64。文档与研究正文按 UTF-8 边界安全裁剪。
- 新增首批系统工具：`project.get_context`、`conversation.search`、`conversation.rename`、`asset.search`、`asset.update_alias`、`settings.get`。写工具只在原始用户消息明确表达对应意图时授权，实体始终限定当前项目/会话。
- `settings.get` 只返回脱敏的 Provider/模型能力摘要；研究结果不再向模型返回本地缓存路径；Provider 与领域网关均在结果回灌 Pi 前执行统一校验。
- 策略拒绝在业务事务回滚后通过独立事务写入 `agent.policy.rejected`；过期授权和确认同步持久化为 `expired`。

## 固定边界核对

| 边界 | P2 结果 |
|---|---|
| 自然语言理解与选工具 | 已选 LLM/Pi 负责；Worker 只签发满足项目、风险和明确用户意图的候选工具 |
| 权限与事实源 | Worker/当前项目 SQLite 权威；模型参数不能提供项目、会话或实体权限 |
| 执行策略 | Registry 统一声明 R0 `parallel-readonly`、R1-R3 `serial`；Worker 支持有界只读批次并拒绝包含写工具的多调用批次 |
| 普通 Provider 回调 | 保持保守串行，避免 step-local 授权刷新竞态；通用并行调度继续由后续性能门禁验证 |
| 一次性确认 | 绑定原调用、参数哈希、项目 session 和原授权；批准、拒绝、过期或重放均不可复用 |
| Tool Result | JSON、64 KiB、100 项集合、敏感字段/路径/Provider 原文/内联媒体红线在模型边界强制执行 |
| 系统设置 | 只读脱敏状态；API Key、Token、Base URL、认证和区域路由不进入 Agent 结果 |
| 素材库 | 复用既有本地优先 Service 与当前项目隔离；GitHub 不参与运行时素材或项目数据同步 |
| 媒体模型 | 本阶段未改变：图片/视频 Provider 与媒体模型仍由用户明确选择，Worker 不自动选择或替换 |

## 关键回归

- 未注册工具和错误授权句柄被拒绝。
- 旧 Provider step 的授权句柄不能重放，过期授权不能执行。
- 跨项目素材 ID 和失效项目 session 不能读取或写入。
- 确认参数哈希被篡改、确认过期、确认重复提交均被拒绝并写入审计。
- 同一只读授权支持有界批量研究调用；包含状态变更工具的批次必须单独串行执行。
- 超大文档/研究正文裁剪后仍是合法 UTF-8 且结果不超过 64 KiB。
- 设置、素材和研究结果不包含凭据、本地路径、Data URL 或 Base64 二进制。

## 自动化验证

| 命令 | 结果 |
|---|---|
| `pnpm.cmd --filter @ai-video/worker test` | Worker 36 个测试文件、328 项通过 |
| `pnpm.cmd test` | 575 项 JS/TS 测试通过：Contracts 12、Context 7、LLM 10、Generation Adapters 17、Persistence 25、Desktop 176、Worker 328 |
| `pnpm.cmd typecheck` | 8 个工作区包通过 |
| `pnpm.cmd lint` | 通过 |
| `pnpm.cmd format:check` | 通过 |
| `git diff --check` | 通过 |
| `pnpm.cmd build` | Contracts、Domain、Context、LLM、Adapters、Persistence、Worker、Desktop 全部通过 |
| `pnpm.cmd --filter @ai-video/worker validate:pi-runtime-spike` | Pi 0.84.3、12 项能力检查通过；无网络请求、无凭据载荷 |
| `pnpm.cmd --filter @ai-video/worker build:sidecar` | Windows x64 sidecar 构建通过 |
| `pnpm.cmd --filter @ai-video/worker validate:m7-sidecar` | malformed JSON 恢复、离线示例、缓存边界、诊断脱敏和完整性通过 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | Rust 71 项通过 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` | 通过 |
| `pnpm.cmd tauri:build` | Tauri Release 与 NSIS 构建通过 |

## Windows 产物

| 产物 | 大小 | SHA-256 |
|---|---:|---|
| Worker sidecar | 74,416,904 bytes | `B11912FF5EC8FD357C9FFAA2B718F55F6AA70BA47D575DD05CB72043F7EFF00C` |
| Desktop Release exe | 11,196,928 bytes | `6F95134690251F138176F64848C93878A6197FF129219F462F49284C85808D08` |
| NSIS installer | 21,629,809 bytes | `BD898D5855D1BCC495F9FA14F55D4FC620B981A312444CD8D930ECF8A31459DE` |

构建保留两个既有非阻塞警告：Vite 主 JS chunk 为 517.32 kB，超过 500 kB 提示阈值；MSVC linker 输出导入库创建信息。

## 未完成边界

- P3 尚需把媒体候选解析和 `media.image.prepare`、`media.video.prepare`、`media.task.get` 接入本注册表；用户明确选择媒体模型的既有边界保持不变。
- P4 尚未完成 `media.generation.submit`、付费 R2 确认、`submission_unknown` 和统一媒体提交状态机。
- P5 尚未把页面内视频轮询迁移到项目级后台运行时。
- 未调用真实或付费 Provider；未执行 NSIS 人工安装、覆盖升级和卸载，断网、重启、多窗口、长稳和通用只读并行性能继续归入 P7。
