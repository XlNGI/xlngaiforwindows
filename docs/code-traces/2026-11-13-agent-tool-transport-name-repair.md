# Agent 工具传输名称不一致补修

日期：2026-11-13，时区 Asia/Shanghai。

## 现场证据

本轮只读核对截图中项目的本地 SQLite，找到任务 `8f07ab83-08b3-44b4-a689-fbdb069d9946`，终态为 `failed`，错误码为 `AGENT_TOOL_FAILURE_STALLED`。本次情况与同日另一份准备循环审计不同，实际失败原因来自工具名称解析。

- 17:59:33 建立任务。
- 18:02:26，`agent_context_results` 记录 `tools.load` 成功，加载文档写入、场镜结构及相关工具。
- 18:03:18 至 18:04:35，记录 10 次 `tools__load` 失败，结果均为 `Tool tools__load not found`。修改加载列表或 reset 参数没有解决名称问题。
- 同任务还记录 4 次 `library__search` 和 1 次 `project__structure__get` 失败；对应点号名称的检索与导航调用能够成功。
- 任务最终没有执行文档或场镜写入，不能把模型输出的执行计划或“将要保存”视为交付成功。此前已存脚本和大纲是独立保存结果，不属于这次失败调用新增的交付。

`tools.load` 已成功一次，因此不能把现场解释成所有写入 Schema 都未加载，或单纯归因于循环保护误报。停止保护最终截住了重复失败，放宽停止阈值不会修复工具不存在。

## 源码原因与修复边界

`apps/desktop/src-tauri/src/llm_stream.rs` 将 Chat Completions 函数名的点号编码成 `__dot__`，返回时还原该编码。实际到达执行器的 `tools__load`、`library__search` 等双下划线名称没有被还原，Pi 因而按不存在的函数报错。原始网络响应未持久化，本轮依据工具流水和 Native 请求进度中的名称判断，不将其扩展为对第三方服务内部行为的结论。

本次补修：

1. 在 Chat Completions 请求中列出本次函数的规范名与传输名，说明函数调用使用 Schema 名称，参数里的 `names`、`toolName` 等仍使用规范名称。目录枚举、用户正文、工具参数与历史结果不改写。
2. Native 发出完整调用事件、查找授权句柄之前，仅将能唯一匹配**本次请求已提供工具**的双下划线别名还原。规范名称直接保留；未知、未加载和歧义名称不获得授权句柄。没有新增工具授权或自动业务重试。
3. Responses 保持原来的名称合同；Worker 的参数校验、项目范围、CAS、幂等、执行预算、重复失败停止及完成判定继续生效。

本轮没有改变项目资料检索、上下文正文注入、素材库或已确认产品决策，无需同步产品 DOCX。

## 实施与验证

- [x] N1 现场只读审计：确认成功加载及后续别名失败，不重发原任务。
- [x] N2 修复前复现：新增两项 Rust 回归均失败，分别证明请求缺少名称说明和双下划线调用未还原。
- [x] N3 补修与专项：Native 流协议专项 54 项通过。
- [x] N4 最终验证：`cargo test --lib` 214 项通过、8 项既有忽略；Worker 四文件 153 项通过；`cargo check`、`cargo fmt --check` 通过。保留既有 Rust unused 警告，不批量改写其他工作区文件。
- [x] N5 `pnpm tauri:build` 成功，重建 Worker sidecar、前端及 Rust release，生成 Windows x64 NSIS 安装包。Markdown 的 Prettier 校验及 `git diff --check` 通过。

回归使用本地 HTTP/SSE 服务，覆盖加载器、读取、写入和多段命名空间，检查规范名、未加载工具、别名冲突、授权句柄及原始参数字节。两协议分别验证，Responses 不启用兼容别名。测试不调用真实模型或付费接口，不修改用户项目。

本轮源码修复不等于已安装新版，也不等于现场失败任务已经完成。

本机验证日志：`.codex-tool-name-before.log`、`.codex-tool-name-rust-focused.log`、`.codex-tool-name-rust-all.log`、`.codex-tool-name-worker.log`、`.codex-tool-name-cargo-check.log`。专项 54 项属于 Rust 库测试的子集，不重复计数。

## 安装包

2026-11-13 18:54:37 生成：

- 路径：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`。
- 大小：77,282,725 字节。
- SHA256：`CF49D222F20D6EA642EE9436909D2705CFCF46FBDBB60D33F642C85CF108A97A`。
- Native 应用 SHA256：`4CBB5E766597521904555F3D47A52CF0CC52778E2B98359DB04FEBC0329BF6AD`。
- 构建日志：`.codex-tool-name-installer-build.log`。

安装包包含当前工作区已有改动；本轮新增源码变更限定在 `llm_stream.rs`，另附本审计。未安装、重启应用或重跑原任务；真实 Provider 上的完整业务交付仍需在新版运行时验证。
