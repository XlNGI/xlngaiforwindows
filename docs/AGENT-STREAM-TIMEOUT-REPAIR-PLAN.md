# Agent 流式超时修复

日期：2026-11-03。

## 证据与边界

只读检查 generation `4f6c7034-0183-4743-80e9-e5b0846b19af`：前两次模型请求成功，分别加载工具和读取镜头衔接资料；第三次在收到响应头后 300 秒失败。第三次上下文估计 35,143 Token，包含三图的请求信封约 1.05 MB，没有触发上下文预算错误。请求记录有 thinking，没有 visible_text、tool_arguments、usage 或 complete。累计收到 3,315,017 字节是 SSE 网络流量，不等于正文或 Token；旧记录只有首次事件时间，无法证明最后有效进展时间，也无法判定是否重复思考。

修改前副本：`C:/Users/MSI/AppData/Local/Temp/agent-stream-progress-20261103/llm_stream.rs`。工作区已有其他改动，以此副本为本次基线。

## 实施顺序

1. 先验证正常 Agent 流会被旧 300 秒总截止终止。
2. Agent 改为有效模型输出的 240 秒空闲超时，加 20 分钟总时长兜底。普通聊天保留 120 秒总上限。正文、思考、工具调用信息增长才更新进展；心跳、空 delta、未知事件、重复 usage 不更新。20 分钟低于既有 30 分钟工具授权有效期，给传输准备和工具验证保留余量。
3. 使用独立截止监视线程，在剩余空闲/总时间耗尽时关闭当前 WinHTTP 请求，避免同步读取阻塞穿过截止时间。正常结束或错误时停止并 join 线程，之后才允许当前 cancellation scope 被下一步复用；截止关闭不修改用户取消标记。保留取消、协议成功要求、部分输出和已有禁止收到输出后自动重试的规则。
4. 错误报告累计 SSE 事件、正文/思考字节、工具参数字节及空闲时长，仅统计不保存正文或凭据。使用虚拟时刻覆盖 300 秒后仍有进展、心跳空转、总上限和边界；使用本地 HTTP 模拟 Provider 验证协议结束、取消及截断。

不增加输入限制，不截断输入，不更改供应商默认思考参数，不改真实项目/设置数据库，不调用真实 Provider，不重放失败任务、不手动重启应用。

## 检查清单

- [x] T0 只读审计、修改前副本与方案。
- [x] T1 旧行为失败回归。原 300 秒截止用例实际失败，日志 `C:/Users/MSI/AppData/Local/Temp/agent-stream-progress-repro.log`。
- [x] T2 进展超时、诊断与聚焦验证。流相关 50 项通过；包含双协议虚拟 1,000 秒进展与 1,200 秒总上限，以及真实本地 HTTP 的静默/心跳空闲超时、持续思考总超时、思考后工具完成和阻塞读取取消。
- [x] T3 原生及全仓完整测试、格式/构建和实际生效核对已完成；既有 lint/format 失败如实保留。

## 验证记录

中间回归发现仅在 request handle 上调用 `WinHttpSetTimeouts` 无法及时终止已经阻塞的 chunked 读取：250 ms 模拟空闲期限在 4 秒服务端关闭时才返回。改用独立截止监视后，同样的本地 Provider 用例在 2 秒断言内完成；流相关整套 50 项通过，日志 `C:/Users/MSI/AppData/Local/Temp/agent-stream-progress-focused.log`。不将前一种实现记为完成。

统计只计算已解析并发出的正文/思考字节及当前工具信息；SSE 心跳计入事件数但不续期。它不把重复思考文本推断为非法，也不根据字节数生成结算 Token。持续空转的模型输出仍由 20 分钟总上限终止。

最终验证：

- Native `cargo test`：189 项通过、1 项既有 ignored。流相关 50 项通过；修改前全套为 180 项，新增 10 项回归。`agent-stream-progress-native-all.log` 保存完整输出。
- `pnpm typecheck`、`pnpm build`、`cargo build --lib`、全 Rust `cargo fmt -- --check`、修改文件 Rust 格式、本文 Prettier 和 `git diff --check` 通过。构建保留既有前端 chunk 提示及无关原生 unused/linker 警告。
- 全仓 lint 仍为 14 项既有错误，format 为 8 个既有文件差异，与前一轮上下文修复一致；未修改无关文件来掩盖失败。日志：`agent-stream-progress-lint.log`、`agent-stream-progress-format.log`。
- 脱敏请求审计保存在 `C:/Users/MSI/AppData/Local/Temp/agent-stream-progress-20261103/audit.json`，仅含时间、大小、估算和供应商 usage/错误；不保存用户正文、图片、工具返回或凭据。
- `pnpm test` 全仓 2,132 项全部通过：Context 8、Contracts 44、LLM 32、Desktop 715、Generation Adapters 79、Persistence 88、Worker 1,166；Domain 无测试并正常退出。现有 Native/Pi 测试继续覆盖收到思考/正文/参数/usage 后不自动重放，长输入和图片完整保留。日志 `agent-stream-progress-tests.log`。
- `llm_stream.rs` 最后修改时间 10:04:37 UTC，既有 Tauri 监听构建的 `target/debug/ai-video-desktop.exe` 为 10:04:43 UTC；当前 Desktop PID 77504 于 18:04:43 本地启动，Worker PID 111492 是其子进程，于 18:04:44 启动。当前开发实例已加载本次 Native 修复，没有手动重启。原生可执行文件 SHA256：`B88554E6180AF6506ACF37BF6B1533AFAE6DE8C1B2D3BAC4866CD4004E0A8E27`。
- 本轮仅修改 `llm_stream.rs` 和本文；没有 Worker 生产逻辑或数据库迁移变更，不需要重建 Worker sidecar。本次未生成发行安装包，已安装的发行版须包含这次 Native 构建才生效。真实 Provider 请求为 0，失败任务未重放。

其余日志位于 `C:/Users/MSI/AppData/Local/Temp/`，前缀 `agent-stream-progress-`：`typecheck.log`、`build.log`、`native-build.log`、`rustfmt-all.log`。离线回归不能证明远端模型下一次一定完成，也不能把 EOF 或超时当作协议成功。
