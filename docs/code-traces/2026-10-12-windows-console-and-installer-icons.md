# Windows 控制台窗口与安装包图标修复

日期：2026-10-12

## 问题与修改

- 旧安装版主程序的 PE Subsystem 为 `3`（Windows Console），启动时会显示黑色控制台窗口。
- `apps/desktop/src-tauri/src/main.rs` 为正式构建设置 `windows_subsystem = "windows"`；开发构建保留调试控制台。
- `WorkerProcess::spawn_command` 在 Windows 使用 `CREATE_NO_WINDOW`，保留标准输入、输出、错误管道以及原有 IPC 通信。
- `tauri.conf.json` 明确指定应用、NSIS 安装器和卸载程序使用现有 `icons/icon.ico`，统一为 unicomp 的 U 标志。

## 验证

- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`：129 项通过，1 项忽略；包含 Worker 通信、超时、标准错误排空和 SQLite 往返测试。
- `pnpm.cmd lint`：通过。
- `pnpm.cmd exec prettier --check apps/desktop/src-tauri/tauri.conf.json`：通过。
- `pnpm.cmd tauri:build`：通过，生成 Windows x64 NSIS 安装包。
- 正式版 PE Subsystem 为 `2`（Windows GUI）；实际启动后的主窗口标题为 `unicomp`，随包 Worker 正常启动并存活。
- 使用 Windows API 核对控制台窗口：主程序 `AttachConsole` 返回 `ERROR_INVALID_HANDLE`；Worker 的 `GetConsoleWindow` 为 `0`，没有控制台窗口。Worker 的内部控制台对象仍可能允许附加，因此不能仅凭 `AttachConsole` 成功判定黑框存在。
- 主窗口正常关闭后，主程序和 Worker 均退出。
- 从最终安装包和主程序提取图标，像素与现有品牌 ICO 一致。
- `cargo fmt --check` 未通过：`lib.rs` 原有多处格式差异仍存在；本次未对无关代码进行批量格式化。

本次启动验证使用构建出的正式版程序，没有执行安装或卸载已有应用。

## 产物

- 路径：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`
- 大小：22,360,598 字节。
- SHA-256：`E49A049202C9375AE2D05D962FF255FF50A00BA40D72FB9F1A7D780238A2BC01`
