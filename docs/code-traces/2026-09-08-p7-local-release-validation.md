# P7 本地发布验收记录

日期：2026-09-08  
结论：本地可执行发布门禁通过；P7 仍不能签收，发布保持 `HOLD`

## 已通过

- `pnpm.cmd install --frozen-lockfile`：通过。
- `node scripts/align-native-node-runtime.mjs`：通过，Native `better-sqlite3` 预编译绑定可用。
- `pnpm.cmd format:check`：通过。
- `pnpm.cmd lint`：通过。
- `pnpm.cmd typecheck`：通过。
- `pnpm.cmd test`：通过；Worker 391 项、Persistence 28 项、Desktop 176 项及其余 workspace 测试通过。
- `pnpm.cmd worker:sidecar`：通过。
- `pnpm.cmd --filter @ai-video/worker validate:m7-sidecar`：通过；损坏 JSON 恢复、离线示例、5 份资料、缓存边界、诊断脱敏和完整性均确认。
- `pnpm.cmd tauri:build`：通过；生成 `apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`，构建产物约 20.7 MB。
- `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml -- --check`、`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`、`cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：通过，Rust 测试 79 项通过。
- `pnpm.cmd audit --prod --audit-level=high`：通过，无已知高危生产依赖。
- `pnpm.cmd license:check`：通过，33 个包通过许可检查。
- `git diff --check`：通过。
- `scripts/validate-nsis-install.ps1`：通过；干净安装、桌面启动、Worker 启动、启动检查、优雅关闭、Worker 退出和卸载清理均通过。

## 未通过或待外部条件

- `scripts/validate-windows-signature.ps1`：失败，安装包状态为 `NotSigned`；当前构建未使用正式 Authenticode 证书。
- `scripts/validate-nsis-upgrade.ps1`：未执行；当前环境没有可确认的上一正式版本安装包，不能用同包或 512 字节占位包替代真实升级基线。
- 干净 Windows VM、SmartScreen/Defender、断网/休眠/长稳、多窗口和完整人工产品验收：未执行。
- OpenAI、UniCompAPI、Vidu 国际站/中国站真实成功请求：未执行；当前环境未提供受控发布凭据。

上述未完成项属于 P7 真实环境和发布签收边界，不能由本地 Mock、自动化测试或同包覆盖替代。
