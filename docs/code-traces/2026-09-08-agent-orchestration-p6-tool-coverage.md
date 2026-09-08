# Agent 编排 P6 全系统工具覆盖验证证据

日期：2026-09-08  
阶段：全系统 Agent 编排 P6  
结论：P6 自动化实现与质量门禁通过；P7 发布验收继续保持 `HOLD`。

## 实现范围

- Worker 统一 Agent tool registry/policy 覆盖项目、会话、文档、小说、短剧、素材、模型/Schema、设置和维护工具，并按 R0-R3 执行项目/会话隔离、一次性确认、参数哈希和拒绝审计。
- 生产入口与 Agent 调用共用 Worker service；需要 secret、凭据、连接地址或其他敏感设置的操作交接到受保护 UI/Native 边界。
- `ConversationTaskPlanV2` 支持结构化 operation、依赖图、环检测、重复 operation 拒绝、就绪状态刷新和有界 follow-up；只有成功的 Worker Tool Result 才能完成交付物。
- Provider、region、remote model、adapter 和 schema 选择在任务创建时冻结并保留 provenance；项目 Schema v38 迁移兼容既有任务与会话数据。
- Desktop、Worker、Provider bridge 和 Pi runtime 已完成接线，媒体后台任务继续由项目级 Runtime 负责。

## 可复核命令

以下命令于本轮在 Windows PowerShell 中执行并返回退出码 0：

```powershell
pnpm.cmd test
pnpm.cmd typecheck
pnpm.cmd lint
pnpm.cmd format:check
pnpm.cmd build
pnpm.cmd worker:sidecar
pnpm.cmd audit --prod --audit-level=high
pnpm.cmd license:check
pnpm.cmd sbom:generate
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
git diff --check
```

聚焦回归结果：Worker 391 项、Persistence 28 项、Desktop 176 项通过；Pi runtime、任务计划、工具网关、Schema v38 迁移和项目隔离回归均通过。SBOM 由本轮命令重新生成，供应链门禁无高危生产依赖。

## 未完成边界

P7 仍未完成真实 Provider 成功请求、正式 Authenticode 签名、上一正式版本跨版本升级、干净 Windows 虚拟机、断网/休眠/长稳和完整人工产品验收。因此本证据不能将发布状态从 `HOLD` 改为 `PASS`，也不把 mock、同包覆盖或本地构建当作上述证据。
