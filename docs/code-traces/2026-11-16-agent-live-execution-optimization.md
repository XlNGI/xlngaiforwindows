# 当前 Agent 执行优化验证

后续现场发现：本轮旧安装包遗漏 `lib.rs` Native 外层白名单的 `toolCallMode`，导致请求模型前即失败。下文历史通过结果未覆盖这一真实桌面入口；旧 Sidecar 检查使用脚本 Native host，不能证明桌面桥端到端可用。修复、补测和替代安装包见[Native 边界修复记录](./2026-11-16-agent-native-bridge-field-repair.md)。

依据：[现场审计](./2026-11-15-agent-live-execution-audit.md)、[实施计划](../AGENT-LIVE-EXECUTION-OPTIMIZATION-PLAN.md)。用户已授权开始优化及打包。本轮仅改源码和临时验证项目，没有继续或更改现场任务。

## 实现与不变量

| 问题 | 实现 | 回归证据 |
| --- | --- | --- |
| 未核验就询问下一步 | `AgentInputDraft.purpose` 区分澄清和下一步；`AgentInputService` 在创建/返回表单前调用原有交付评估；无目的的旧表单在仅剩保存后核验时也被拦截 | 两协议修改保存→提问被拒且不生成表单→明确澄清可用→当前版本读回→下一步允许 |
| 写入批次违约后重复发送正文 | ContextManager 按当前待办设置 `toolCallMode`，经 Native bridge 传到 Rust 两协议的 `parallel_tool_calls`；只读批次提示最多八项；Gateway 整批拒绝时保留最多八份同任务候选 | 两协议 Native 故意忽略 single、整批零写入、再通过候选逐份保存，共两份文档；候选重启、作用域、schema/CAS 回归 |
| 多份同类产出撞隐式身份 | 状态投影持久 `outputId/planKey/quantity/committedIndices`，创建参数说明只携带稳定的槽位声明；多输出计划未提供身份时返回合法槽位；旧隐式重试保留 | 两协议两份独立创建、原槽位原样重放；先保存后登记计划的旧隐式回执仍可采用；保存进度变化或重复投影不改变 Schema，避免无谓破坏供应商工具缓存；旧 CAS 回归 |
| 长正文导致每轮整理、卸载工具 | 软目标基于不可释放正文、用户要求、状态和近期历史的基线；历史采用 16k/8k 增量阈值及持久归档边界；工具仅在实际容量压力下延期；近期错误保留历史标记 | ContextManager 61 项，包括两协议连续 20 轮最多整理三次、全部已读正文/错误/工具保留、重启边界一致、真正超限仍拒绝 |

权限、CAS、幂等、项目/任务隔离和空转保护仍由原 Worker 机制执行。候选不是保存回执，不会自动执行；复用仍重新校验全部参数。没有新增数据库迁移或索引，也没有注入未读正文或把聊天附件自动入库。

## 本轮门禁

- `pnpm typecheck`：通过。
- `pnpm lint`：初次发现新增说明字段的 `no-base-to-string`，改为明确的 string 类型检查后通过。
- `pnpm format:check`、`git diff --check`：通过。
- `cargo fmt --check`、`cargo check`：通过。
- `cargo test --lib`：219 项通过，8 项按原配置忽略；两协议阶段字段反序列化测试细化后单独复验通过。
- `pnpm build`：通过。
- 全仓回归共 2,872 项通过：`pnpm test` 的其他包/应用 1,254 项通过；Worker 首轮 1,616 项通过、1 项失败（运行期间补入完整制作包旧表单回归，不把该轮视为全仓通过）。同文件另起进程完整 4 项通过；源码冻结后另起 `pnpm --filter @ai-video/worker exec vitest run --testTimeout=15000 --maxWorkers=2 --minWorkers=1`，最终 101 文件 / 1,618 项全部通过，退出 0，耗时 380.14 秒。
- `pnpm tauri:build`：冻结源码最终构建退出 0；NSIS 已另存为 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup-agent-execution-fix-20261116.exe`，77,293,016 字节。安装包 SHA-256：`7A67C4FCC22C71F680B0C72413E34C3BB2181EEB42D4B8ED16E535B8577639A5`。
- 新 Sidecar 单项目兼容、多项目隔离：均通过。
- 新 Sidecar 两协议完整制作链、独立重开读回、丢失应答重放及多段提交：通过，真实 Provider 请求和媒体任务均为零。

最终冻结源码的 Sidecar SHA-256：`F9A8B6D7FEEA2F035DB39CB5B76C4014084928BEBE37EB0CAEC853346D5C0EDB`。上述单项目、多项目与两协议制作链已针对该摘要重新验证通过。

原始日志保存在 `%TEMP%`：`agent-live-tests-20261116.log`、`agent-live-worker-final-20261116.log`、`agent-live-types-final-20261116.log`、`agent-live-lint-frozen-20261116.log`、`agent-live-format-frozen-20261116.log`、`agent-live-rust-20261116.log`、`agent-live-rust-check-20261116.log`、`agent-live-rust-phase-20261116.log`、`agent-live-build-20261116.log`、`agent-live-package-frozen-20261116.log` 和 `agent-live-sidecar-*-frozen-20261116.log`。

自动化仅证明脚本控制的工具流程、持久化和协议行为，不能替代真实模型的语义质量、轮数或耗时比较。没有安装覆盖或重启用户当前实例；当前现场任务不会因源码打包而自动修复。新包运行后的同模型实测仍待用户验收。
