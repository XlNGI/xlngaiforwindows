# 新建项目目录选择闪退：审计与隔离修复

## 故障边界

用户确认触发步骤为「点击新建，选择目录后软件崩溃」。`App.selectProjectDirectory(false)` 在目录选择返回后只更新路径；用户点击「创建项目」才执行 `project.runtime.create`。因此不能把这次反馈直接归因于 SQLite v78 迁移。

本机 Windows Application 事件没有找到对应的 fault 记录；找到的两条 11 月 12 日 AppHang 属于另一个工作目录的开发程序，不能用于证明本故障根因。隔离标识的桌面版本启动成功且进程响应正常，但 computer-use 获取窗口图像连续返回 `FrameArrived timed out: timed out waiting on channel` 和 `window capture timed out: timed out waiting on channel`，未完成真实选择目录复现。具体异常模块或用户机器的 Shell 扩展仍未确认。

## 已修复的故障传播

旧路径通过 `@tauri-apps/plugin-dialog.open` 在桌面主进程内运行 Windows 原生目录选择器。原生访问违规或进程级终止不属于 JavaScript Promise rejection，前端的 `try/catch` 不能保住进程。

新增 `project_directory_pick` 命令，在 Windows 上以当前可执行文件的 `--project-directory-picker` 模式启动专用子进程。该模式在 Tauri 初始化前返回，只运行同步原生目录选择器，不启动 WebView、Worker 或项目数据库，不使用额外下载的软件或脚本。

主进程异步等待子进程，并校验退出状态、JSON 返回值和本地绝对目录。子进程异常时显示可重试或手动输入目录的错误，恢复父窗口可交互状态；取消选择保留输入。保留请求窗口作为弹窗 owner，防止重复打开。项目打开和新建两条目录选择入口共用该实现。非目录文件导入入口保持原实现。

这是针对已确认触发步骤的进程隔离修复；不是对用户机器具体崩溃模块的根因确认。仍需用新安装包在原故障机器完成选择目录复验。如果系统目录选择器本身仍异常，可直接输入项目绝对目录继续创建。

## 验证

- Worker 创建/运行时测试：2 文件，28 项通过。
- Desktop 完整回归：95 文件，867 项通过，包含目录选择失败后重试、取消保留输入、重复点击保护和新建后的初始会话。
- Rust 原生完整回归：212 项通过，8 项忽略；新增子进程异常退出的宿主存活测试，以及 Unicode 目录、取消、无效输出和路径检查。
- 实际打包 Worker：中文含空格目录创建、初始会话、数据库完整性、关闭重开和新 session 全部通过，schemaVersion=78。
- 全仓类型检查、Lint、格式检查和 `git diff --check` 通过；Rust 格式检查通过。最后一次测试代码类型修正后，受影响的 5 项 App 焦点用例再次通过。
- `pnpm tauri:build` 成功，生成包含新目录选择命令和重新构建 Worker 的 Windows 安装包。

安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`（2026-11-13 13:51，77,273,699 字节）。SHA256：`57E03BC405876BB36105DB55705D6C18BD3612C4BA648F3C2AA16302A45015FB`。没有安装或替换用户正在运行的应用。

未修改素材库产品要求、检索策略或项目数据库格式；保留工作区原有其他功能修改。
