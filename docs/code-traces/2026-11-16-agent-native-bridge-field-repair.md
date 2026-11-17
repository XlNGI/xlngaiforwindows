# Agent Native 参数边界漏接修复

用户现场：2026-11-16 安装执行优化包后，发送“写短剧剧本”或后续消息，任务立即失败，报 `Native Provider params contain an unknown field`。该错误在请求模型之前发生。

## 根因与修复范围

上一轮 L2 增加了 `toolCallMode`，Worker 合同、发送桥和 Rust `LlmRuntimeRequest` 均已接入，但 `lib.rs` 的 `validate_provider_stream_params` 外层白名单遗漏该字段。本次补齐白名单，外层和 Runtime 共用严格字符串及枚举反序列化校验；只允许 `single` / `parallel-readonly`。字段缺省继续使用旧 execution lane 行为；显式 null、未知字符串及其他类型均拒绝。特别拒绝 Serde 默认可能接受的 `{"single":null}` / `{"parallel-readonly":null}` 对象形式，保持与 Worker 字符串合同一致。

没有放开任意字段，也没有关闭空转保护。该修复不改任务内容、项目库、用户约束或会话记录。原失败任务不会因打包而自动继续。

## 边界与故障矩阵

| 输入／阶段 | 必须结果 | 覆盖 |
| --- | --- | --- |
| 两协议 single，工具声明支持只读并行 | HTTP 请求 `parallel_tool_calls: false` | 合同及真实路由本地 HTTP |
| 两协议 parallel-readonly，工具声明无并行 lane | HTTP 请求 `parallel_tool_calls: true` | 合同及真实路由本地 HTTP |
| 字段缺省，旧只读／写工具 | 分别沿用 true / false | 合同及真实路由本地 HTTP |
| 字段为 null、布尔、数字、数组、对象、未知枚举 | `INVALID_PARAMETERS`，不注册活动流、不读取凭据、不调用 HTTP | 路由拒绝测试及 Runtime 反序列化 |
| 合法 mode 附加未知字段、顶层／嵌套凭据 | 继续拒绝，返回错误不回显凭据 | 原有合同及新增路由拒绝测试 |
| 请求通过并完成 | 原 session、requestId、事件递增 sequence 和成功终态保持 | 真实路由及 Sidecar 消息管道 |
| 模型外部请求体 | 仅出现供应商 `parallel_tool_calls`，不出现内部 mode / lane | 实际本地 HTTP 捕获 |

Native 路由的活动流注册、取消、可用状态和清理逻辑不变。新增可注入的流执行函数用于边界回归；生产入口固定使用原 `native_provider_stream`、Windows 凭据读取与 HTTPS。测试只替换内存中的虚构凭据和 loopback HTTP 许可，不写 Windows 凭据，不访问外部模型，不覆盖用户实例。

## 上次验证覆盖的缺口

上次 Rust 阶段测试只调用内部请求体构建；Sidecar 完整制作链使用脚本 Native host。它们没有覆盖桌面 `lib.rs` 的外层字段白名单，不能视作真实桌面 Native 桥的端到端通过。

新增测试通过已编译的实际 Worker `NativeProviderBridge` 生成消息，再经过相同 Native 路由、外层校验、Runtime 解析、WinHTTP、本地 SSE 和实际子进程消息管道。两协议分别覆盖四种模式组合，另有非法值和凭据在执行前被拒绝的验证。

## 本次验证

- 修复前 `cargo test --lib native_provider_host_contract_ -- --nocapture`：新增合法 mode 测试准确复现现场错误；非法 mode 测试也失败，4 项旧测试通过、2 项新测试失败。日志 `%TEMP%/agent-native-bridge-red-20261116.log`。
- 首次修复后 `cargo test --lib native_provider_host_ -- --nocapture`：8 项通过，包括两协议八组真实 Native 路由→本地 HTTP 完整流。日志 `%TEMP%/agent-native-bridge-focused-20261116.log`。
- `pnpm --filter @ai-video/worker exec vitest run src/native-provider-bridge.test.ts --maxWorkers=2 --minWorkers=1`：75 项通过。
- 首轮完整 Rust：222 项通过、1 项新测试失败、8 项按原配置忽略。原因是 Windows 接受的 socket 继承模拟监听器的非阻塞模式，模拟服务器在请求尚未到齐时读到 `WouldBlock`；测试夹具显式切回阻塞并设置读写期限后修复。不将此轮计作全量通过，日志 `%TEMP%/agent-native-bridge-rust-20261116.log`。
- 修正模拟服务器后的 `cargo test --lib`：223 项通过、0 项失败、8 项按原配置忽略，耗时 32.50 秒。日志 `%TEMP%/agent-native-bridge-rust-final-20261116.log`。
- 打包复核追加对象形式枚举测试，先复现默认 Serde 接受对象的合同差异（`agent-native-bridge-enum-red-20261116.log`），再改为共用严格字符串解析；首个构建不交付，以最终冻结源码重新构建。
- 最终严格字符串解析冻结后 `cargo test --lib`：223 项通过、0 项失败、8 项按原配置忽略，耗时 32.54 秒。日志 `%TEMP%/agent-native-bridge-rust-frozen-20261116.log`。`cargo fmt --check`、`cargo check` 再次通过（`agent-native-bridge-rust-check-final-20261116.log`）。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check`、`cargo fmt --check`、`cargo check`：通过。没有修改 TypeScript 行为，本次没有将上一轮全仓 2,872 项测试冒称为重新执行；本次 Worker 聚焦回归为上述 75 项。
- 最终构建的 Sidecar：单项目兼容、多项目隔离、两协议制作链及独立重开读回、丢失应答重放、多段提交全部通过；虚构 Native host，真实模型和媒体请求均为零。日志 `%TEMP%/agent-native-bridge-sidecar-{single,multi,bundle}-frozen-20261116.log`；本次没有把脚本 host 的通过当作真实桌面 Native 边界证据，后者由上述 Native→本地 HTTP 测试单独验证。
- `pnpm tauri:build`：最终冻结源码构建退出 0，包括包编译、Worker Sidecar、桌面前端、Rust Release 和 NSIS；日志 `%TEMP%/agent-native-bridge-package-frozen-20261116.log`。生成后复核两份 Native 源码摘要与冻结时一致，Sidecar 摘要与验证报告一致。

最终 Sidecar SHA-256：`D3DCCB2CDF90542E14D3B722C9778ACAA523F23A5733C37BAF458BE5DB71AD83`，与完整制作链报告中的摘要一致。

## 替代交付包

`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup-agent-native-bridge-fix-20261116.exe`，77,282,691 字节。

- 安装包 SHA-256：`2376FB302F87A99BD2DD68E6F71FA27E818142C5584D533F6EEAB2F77ED4C289`。
- 桌面 EXE SHA-256：`1EFA4B45F1E3847F166E98B7AD796B2CD0ADB5E47FF287134F50FB5FA951EB29`。

旧 `agent-execution-fix-20261116` 包保留用于追踪，不应继续安装；本次新包名称为 `agent-native-bridge-fix-20261116`。没有安装、关闭或重启用户正在运行的实例，也没有操作现场项目任务。安装新包后需重新发送失败的请求。

此记录只验证本次参数边界修复，不将本地模拟接口当成真实 Provider 成功调用。
