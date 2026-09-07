# Agent 编排 P4 付费媒体提交与统一状态机验证记录

日期：2026-09-07  
阶段：全系统 Agent 编排 P4  
结论：完成；P5-P7 未完成，整机发布保持 `HOLD`

## 实现范围

- 新增 Worker-owned `MediaOrchestrationService`，作为制作面板、统一 Agent 工具与 Native Provider 之间唯一的付费媒体提交边界。
- `media.generation.submit` 与 `media.task.cancel` 接入统一 Registry/Policy；Agent 只能提交当前项目、当前任务和当前 step 已授权的媒体草稿。
- 每次 Provider 提交先生成 R2 确认。确认展示 Provider、模型、Adapter、冻结草稿版本、参数摘要、费用提示和有效期；SQLite 只保存 token 哈希，明文 token 仅在当前 Worker 会话内用于同请求幂等重放。
- 确认时重新校验冻结的 Provider profile/type/base URL 类别/region、模型 ID/remote model、Adapter key/capability/schema version、参数 Schema和受控输入引用；任何漂移都在写入 `submitting` 和 Native 请求前拒绝。
- Native one-shot host request 支持图片/视频提交与视频取消。凭据、认证头、绝对输入路径和 Provider 原始正文不进入 Worker/Pi Tool Result。
- Schema v37 为 generation job 增加权威媒体状态、提交幂等键、确认哈希/session/消费时间和 attempt；确认消费、状态事件与 project touch 在同一 SQLite 事务内完成。
- `draft -> awaiting_confirmation -> submitting -> polling/downloading/validating/committing -> terminal` 状态链显式支持 `submission_unknown`；终态由 SQLite trigger 保证不可回退。
- 历史 v36 `pending/running` 任务保守迁移为 `submission_unknown`，不自动重试可能已被 Provider 接收的请求；已明确保存为 P4 `draft` 的任务在普通重启后保持草稿。
- Worker 重启将未消费确认恢复为 `draft`，将已确认但中断的 `submitting` 恢复为 `submission_unknown`；两者均不会自动发起付费请求。
- Native `INVALID_PARAMETERS`/`METHOD_NOT_FOUND` 映射为明确失败；`INVALID_ENVELOPE`、`INTERNAL_ERROR`、传输中断和无法证明未送达的错误映射为 `submission_unknown`。
- 取消始终停止本地状态和轮询，并明确返回 `not_submitted`、`cancelled`、`unsupported`、`rejected` 或 `unknown`。后三种结果在制作面板提示 Provider 任务可能继续，Agent Tool Result 只返回有界取消事实。
- 受控临时媒体输入在提交、取消和已知/未知失败后清理；项目 SQLite、任务快照、日志和 Agent 结果不持久化 Data URL/Base64。

## 固定边界核对

| 边界 | P4 结果 |
| --- | --- |
| 付费确认 | 每个 Provider 提交分别确认；确认绑定 job、project session、冻结快照和一次性 token |
| 重复请求 | 同 Worker 会话重放确认请求返回同一内存 token；重复确认被拒绝，Native 最多调用一次 |
| 不确定提交 | 明确进入 `submission_unknown`，不自动重试，不伪造 task ID 或失败 |
| Provider task ID | 视频 task ID 与 `polling` 状态原子绑定；无 task ID 的成功响应立即明确失败 |
| 历史数据 | v36 迁移保留 task snapshot；可能已提交的 legacy pending/running 不回填为可重试 draft |
| 快照漂移 | Provider、模型、Adapter 或 Schema 变化时保持 `awaiting_confirmation`，Native 零调用 |
| 本地优先 | GitHub 只管理源码和评审；运行时项目、素材、任务与受控输入仍保存在本地 |
| 素材入库 | 仅 Provider 成功、文件落盘和校验完成后登记本地素材；P4 不改变素材库产品规则 |

## 关键回归

- 确认前、拒绝确认、伪造/过期/跨 session token、配置漂移和缺失快照均不会请求 Native。
- 重复 `requestSubmission` 返回同一确认 token；重复 `confirmSubmission` 不重复提交或扣费。
- Provider HTTP 明确拒绝、Native 明确参数错误、响应丢失和无法分类的内部错误按已知/未知语义分流。
- `awaiting_confirmation`、`submitting`、`submission_unknown`、历史任务和已从当前 Adapter 目录移除的任务仍可查询正确 kind/状态。
- v36→v37 迁移覆盖字段、状态回填、快照保留、幂等唯一索引、终态 trigger 和完整性检查。
- Desktop 确认框与会话确认卡展示草稿版本和参数；远端取消不支持、拒绝或未知时不再只显示“取消成功”。
- Agent Tool Result 不包含 Provider task ID、明文确认 token、绝对路径、Data URL、Base64 或 Provider 原始响应。

## 自动化验证

| 命令 | 结果 |
| --- | --- |
| `pnpm.cmd install --frozen-lockfile` | workspace 锁文件可复现安装 |
| `pnpm.cmd test` | 全仓 614 项 JS/TS 通过：Contracts 12、Context 7、LLM 10、Generation Adapters 17、Persistence 27、Desktop 180、Worker 361 |
| `pnpm.cmd typecheck` | 8 个 workspace package 通过 |
| `pnpm.cmd lint` | ESLint 通过 |
| `pnpm.cmd format:check` | Prettier 通过 |
| `pnpm.cmd build` | Contracts、Domain、Context、LLM、Adapters、Persistence、Worker、Desktop 生产构建通过 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` | 通过 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | Rust 72 项通过 |
| `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` | 通过 |
| `pnpm.cmd worker:sidecar` | Windows x64 sidecar 构建通过 |
| `pnpm.cmd --filter @ai-video/worker validate:pi-runtime-spike` | Pi 0.84.3 的 12 项检查通过；20 次 faux Provider 调用，零网络、零凭据载荷 |
| `pnpm.cmd --filter @ai-video/worker validate:m7-sidecar` | malformed JSON 恢复、离线示例项目、缓存边界、诊断脱敏和 SQLite 完整性通过 |
| `pnpm.cmd tauri:build` | Tauri Release 与 x64 NSIS 构建通过 |
| `pnpm.cmd audit --audit-level=high` | `No known vulnerabilities found` |
| `pnpm.cmd audit --prod --audit-level=high` | `No known vulnerabilities found` |
| `pnpm.cmd license:check` | 33 个生产依赖许可证检查通过 |
| `pnpm.cmd sbom:generate` | CycloneDX `sbom.json` 已更新并格式化 |
| `git diff --check` | 通过 |

首次全依赖审计发现 `fast-uri <3.1.6`、`js-yaml <4.3.1` 和 `nanoid <3.3.18` 的 2026 年高危公告；使用 workspace 精确 override 更新到同主版本补丁并刷新 lockfile 后，完整与 production-only 审计均无已知漏洞。

## Windows 产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| Worker sidecar | 74,561,992 bytes | `0216E491B697827D04E55E9EBE6E52ED8ED02271892DBD1D6AEE797D8A290E1C` |
| Desktop Release exe | 11,259,392 bytes | `6D01D9CFC6427C39FA8FACF53D23A79391717CE2C9584F6C155DDB29C0BA5678` |
| NSIS installer | 21,698,077 bytes | `948FB81E914D0A094E9402147CCBF0F9BB8307704290CE43697F27326779C323` |

构建保留两个既有非阻塞警告：Vite 主 JS chunk 为 523.30 kB，超过 500 kB 提示阈值；MSVC linker 输出导入库创建信息。

## 未完成边界

- 未调用真实或付费 UniCompAPI、Vidu 国际站、Vidu 中国站；自动化只使用 faux/mock Provider。
- 未执行 Windows NSIS 人工安装、覆盖升级、卸载、签名、真实断网/休眠、多窗口、慢首 Token 或 24 小时长稳验收。
- P5 尚未把页面内视频轮询迁移到项目级 `ProjectTaskRuntime`；停留其他页面时的持续轮询与统一任务订阅仍未完成。
- P6 全系统工具覆盖和重复入口清理、P7 真实 Provider 与发布验收仍未完成。
- 素材库计划 P5 的完成仅代表素材库自身来源联动、缩略图、完整性和备份恢复范围，不代表整机发布通过。

因此全系统 Agent 编排阶段状态为 P0-P4 完成、P5-P7 未完成，整机发布继续保持 `HOLD`。
