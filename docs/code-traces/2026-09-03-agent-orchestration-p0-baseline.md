# Agent 编排 P0 合同与回归基线

- 日期：2026-09-03
- 仓库：`E:\xlngai\xlngaiforwindows`
- 基线提交：`main @ 3604e61`
- 环境：Node `v26.5.0`、pnpm `11.9.0`、rustc/cargo `1.97.1`
- 状态：P0 完成

## 目标与边界

本记录对应 `AGENT-SYSTEM-ORCHESTRATION-OPTIMIZATION-PLAN.md` 的 P0。P0 只冻结跨阶段合同、建立已知故障回归并采集当前发布基线，不提前实现 P1 的统一会话切换、P2/P4 的生产策略接线或 P5 的后台任务迁移。

架构评审结论：继续复用当前项目 SQLite、`agent_tasks`、`agent_tool_calls`、`generation_jobs` 和事件表作为唯一事实源；没有新增 Runtime 数据库、凭据存储或素材同步路径。Provider secret 仍只由 Tauri Native 持有；GitHub 仍只管理源代码和评审，不参与运行时素材库或项目数据同步。

## 冻结合同

| 合同 | 冻结内容 | 后续接线阶段 |
|---|---|---|
| `AgentToolRegistryV1` | task/project session 作用域、版本化工具元数据、风险、确认策略、只读并行/写入串行通道 | P2 |
| R0-R3 | R0 自动只读；R1 明确用户指令下本地可逆；R2 每次确认；R3 强确认或受保护 UI | P2/P6 |
| 确认与授权 | `taskId + toolCallId + operation + argumentsHash + projectSessionId`，短期、一次性 | P2/P4 |
| Tool Result | JSON 64 KiB、摘要 2,048 字符、集合 100 项；禁止授权、secret、凭据、绝对路径、Provider 原文、Base64/Data URL | P2 |
| 媒体草稿 | 冻结 Provider Profile/type/region、模型、远程模型、Adapter/Schema 版本、参数和受控输入引用 | P3/P4 |
| 媒体状态机 | `draft -> awaiting_confirmation -> submitting -> ... -> succeeded/failed`，显式包含 `submission_unknown`，终态无回退 | P4/P5 |
| Provider 规范化 | `queued/running/succeeded/failed/cancelled` 与显式 `remote_url/authenticated_content/native_temporary_file` 输出 | P5 |

这些是版本化共享合同，不代表现有专用实现已经完成迁移。现有文档工具授权继续复用，P2 在通用 Registry 下收口，不能并存第二套权威策略。

## 故障链路回归

| 链路 | 测试与结果 | 当前结论 |
|---|---|---|
| “帮我生成龙在天空翱翔的视频” | `App.test.tsx`、`handler.test.ts` | 首次测试复现 Worker 返回 `text`；修正规则后 Desktop/Worker 均返回 `video` |
| 媒体区域冻结 | `video-generation-service.test.ts` | `providerProfileId + providerRegion + modelId` 写入不可变 `task_snapshot_json` |
| 页面卸载后轮询 | `video-polling-scheduler.test.ts` | 特征测试确认当前页面 owner dispose 后忽略在途结果；缺陷稳定可复现，P5 迁移到 `ProjectTaskRuntime` 后反转验收 |
| Provider 提交异常 | `ProductionPanel.test.tsx` | Promise 抛错后调用 `video.generate.fail`，任务进入 `failed`，不显示已提交/轮询状态 |

聚焦验证：Contracts 5 项、Worker 路由/视频 48 项、Desktop 会话/制作面板/轮询 58 项全部通过。

## 全仓质量基线

| 命令 | 结果 | 耗时 |
|---|---|---:|
| `pnpm.cmd test` | 534 项 JS/TS 测试通过：Contracts 5、Context 7、LLM 10、Generation Adapters 17、Persistence 25、Desktop 175、Worker 295 | 23.905 s |
| `pnpm.cmd typecheck` | 8 个工作区包通过 | 9.033 s |
| `pnpm.cmd lint` | ESLint 通过 | 21.172 s |
| `pnpm.cmd format:check` | Prettier 通过 | 6.510 s |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 71 项 Rust 测试通过 | 6.405 s |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` | 通过 | - |
| `git diff --check` | 通过 | - |

首次全仓测试在 Worker 33 个文件并行执行时有 4 个正常用例耗时约 5.8-6.0 秒，超过 Vitest 默认 5 秒；这些文件聚焦运行约 0.2-2.2 秒且断言通过。Worker 标准命令已显式设置 15 秒单测上限，复跑全仓全部通过，保留了挂死检测并消除 Windows 文件系统/SQLite 并发造成的门禁抖动。

## Windows 构建与启动基线

| 项目 | 结果 |
|---|---|
| Worker sidecar build | 通过，16.953 s；最终 exe 74,355,904 bytes |
| Sidecar health 启动 | 构建后首次 695 ms；最终 Release 产物 5 次为 158/136/136/139/134 ms，中位数 136 ms、平均 141 ms |
| Sidecar M7 smoke | 通过，5.755 s；畸形 JSON 恢复、离线示例项目、缓存边界、诊断脱敏和完整性均通过 |
| Tauri Release + NSIS | 通过，106.767 s；安装包 21,617,914 bytes |
| Desktop Release exe | 11,196,928 bytes |

最终产物 SHA-256：

- sidecar：`B127A78C750C93109E1C3F311E4DB62F9C306797AD0E344C89448E911A8ABA73`
- Desktop exe：`06DDEC193DD30115F559878D5DC3BAFD0F79B890A3BE4805E5E4EF4693129B86`
- NSIS：`79E193D14A5A095DBCF36EE0BF5D5604B54311814FA1A997E74496675E04699F`

构建有两个非阻塞警告：Vite 主 JS chunk 为 516.78 kB，超过 500 kB 提示阈值；MSVC linker 输出导入库创建信息。两者均未导致构建或测试失败，前者纳入后续性能/拆包评估。

## 未验证边界

- 未调用任何真实或付费 Provider。
- 未执行 NSIS 的人工安装、覆盖升级、卸载和旧项目迁移；这些属于 P7。
- 页面卸载后视频持续运行尚未实现；当前回归用于锁定 P5 的迁移目标。
- `submission_unknown`、通用 Registry enforcement 和 R2/R3 参数哈希授权仅完成合同冻结，生产接线分别属于 P2/P4。
- 未进行 24 小时轮询、真实断网/重启、多窗口和慢首 Token 验收。

## 下一步

按总方案进入 P1：统一项目会话到 Pi `ConversationAgentRuntime`，移除仅 `short-drama` 的实现限制，验证会话模型 `tools=true`，并保留开发期 Legacy 回退开关。
