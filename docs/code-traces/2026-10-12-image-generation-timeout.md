# 2026-10-12 图片生成超时诊断与修复

## 现象与证据

用户截图中的 `qwen-image-3.0` 图片任务没有生成预览，任务日志仍显示“执行中”。只读检查截图对应项目的 SQLite 记录后，确认：

- 适配器为 `TEXT_TO_IMAGE:unicompapi:cn.qwen.qwen-image-3-0:contract-1`。
- 本地时间 09:53:14.621 开始提交，09:53:44.849 记录响应超时，间隔约 30 秒。
- 旧字段 `status` 为 `running`，实际提交状态 `media_state` 为 `submission_unknown`。
- 错误明确表示 Provider 响应未收到，因此不能据此确认远端生成失败或未扣费。

诊断过程中没有修改用户项目数据库、访问凭据内容、自动重提任务或发起真实付费生成请求。

## 原因

`provider_http.rs` 对 WinHTTP 接收响应统一设置 30 秒超时。UniCompAPI 的 `POST /v1/images/generations` 同步等待图片推理完成，耗时超过 30 秒时，本地先终止等待，随后将任务置为 `submission_unknown`。

另有三处配套问题：

1. Worker 到 Native 的桥接默认期限为 120 秒，即使单独延长 HTTP 等待，较慢图片仍会被桥接层提前中断。
2. 确认提交在 Worker 串行修改队列内等待远端响应，期间阻塞本地写入和取消操作。
3. 任务日志优先显示旧 `status`，没有呈现 `media_state`；原类型判断还会把 Vidu 图片误判为视频。

## 修复

- 仅为 UniCompAPI 同步图片生成 POST 设置 300 秒接收超时；模型查询、视频提交和轮询维持 30 秒。超时入口仍使用既有请求准入与熔断控制。
- 图片提交使用 600 秒 Native 桥接期限，覆盖请求准入、连接、推理和结果传输；Desktop 到 Worker 既有等待期限为 720 秒。
- 确认提交改为后台调度，确认令牌仍在等待前同步消费一次。本地写入、取消与任务查看可继续执行。
- 延迟到达的超时错误不得覆盖已完成的本地取消状态。
- 日志列表、筛选和详情使用实际提交状态，显示“提交结果未知”；提示先在 Provider 后台核对，保持不自动重试的语义。
- 按适配器能力前缀区分图片与视频，纠正 Vidu 图片分类。

## 验证

已完成：

- Windows Native 本地 HTTP 服务延迟 32 秒后返回，修复后的请求成功收到响应，覆盖原 30 秒截止点。
- 使用真实 `NativeProviderBridge` 与虚拟计时，180 秒后的图片响应仍能处理，覆盖默认 120 秒期限。
- 提交等待期间本地写入、取消和日志查询可执行；取消后到达的超时不会将任务改为结果未知。
- 日志列表及详情显示“提交结果未知”，按该状态筛选正确，Vidu 图片分类正确。
- Worker 全量 46 个文件、526 个测试通过；调整桥接回归测试后，3 个相关文件、34 个测试再次通过。
- Desktop 全量 30 个文件、273 个测试通过。
- Rust lib 全量 122 个测试通过，含 32 秒延迟回归；最后收窄 `lib.rs` 改动后，超时路由测试再次通过。
- 全工作区 `typecheck`、`build`、`format:check`，修改的 TS/TSX 文件 ESLint、`cargo check`、`provider_http.rs` 的 Rust 格式检查和 `git diff --check` 通过。

已有质量门禁问题：全仓 ESLint 被本地临时目录 `.m2-ui-novel-open-goal/validate.cjs` 的 9 处 `no-undef` 阻断；全仓 `cargo fmt --check` 被 `lib.rs` 的既有格式问题阻断；`cargo check` 保留既有 unused-variable 警告。本次没有修改无关临时文件或批量重排历史代码。

## 继续诊断：上游正常返回后仍然无法生成预览

用户确认上游已正常返回后，再次只读检查最新任务：本地时间 10:48:03.477 提交，10:49:08.612 报错，已超过原 30 秒超时。此次错误为：

```text
Submission status is unknown: Signed URLs cannot cross the Native Provider boundary.
```

这证明第二个断点位于接收响应的桥接校验。上游图片 URL 带临时签名；Native 之前仅将 Base64/Data URL 转为本地文件，远程 URL 仍原样跨 IPC。Worker 的敏感数据校验因此拒绝响应，图片服务尚未开始读取图片或保存预览。上一轮超时诊断和修复没有覆盖这条成功返回路径。

随后用户再次生成，最新任务（本地时间 11:23:52.430 创建、11:23:54.001 确认提交，11:25:04.671 结束）错误变为：

```text
Submission status is unknown: Hostname is outside the public network boundary
```

这次已经进入 Native 下载阶段，但本机 Clash Verge 的 TUN/fake-IP DNS 将 Provider 图片域名解析为 `198.18.x.x`（配置中的 fake-ip 网段为 `198.18.0.1/16`）。严格公网地址检查把代理的虚拟解析地址误判为不安全，因此没有真正发出图片下载请求。

本轮补齐处理：

- Native 下载远程图片 URL，完整保留下载所需的签名查询参数；下载时不附带 Provider API 凭据。
- 使用既有公网 HTTPS 校验，每次重定向重新校验目标，最多 5 次重定向；图片接收等待为 60 秒。
- 图片校验沿用 PNG/JPEG/WebP 类型和签名、每张 25 MiB、最多 4 张的限制；失败时清理已下载的部分文件。
- 返回值规范为本地临时图片文件路径和类型，避免原始响应其他字段回显签名 URL 导致整个响应再次被拒。
- Worker 沿用现有本地文件读取、预览和素材保存流程；保留桥接敏感数据校验。
- Provider 结果域名允许经过本机代理解析到 `198.18.0.0/15` fake-IP；仍拒绝直接 IP、局域网、回环、链路本地和混合不安全解析。研究请求继续使用严格公网地址检查，视频远程下载也保持严格检查。
- HTTP 已成功但本地下载/保存失败时，任务现在标记为已失败并提示“已收到生成结果”，不再误报为“提交结果未知”，也不会自动重提。

补充验证：Native 本地 HTTP 成功返回带签名链接的 JSON 后，下载接口接收完整链接，桥接结果仅包含本地文件；真实 `NativeProviderBridge` 收到本地文件后，图片任务成功、素材入库且预览返回。使用当前机器的 Clash fake-IP DNS，通过真实公网静态 PNG 下载验证，Native 成功接收并校验 12,746 字节；再经真实桥接和 Worker 完成预览及素材文件保存。覆盖签名参数和重定向处理、非法目标、无效图片及部分文件清理。

本轮最终 Rust lib 全量 127 个测试通过，1 个需显式启用公网请求的 smoke 测试默认忽略，且该 smoke 已另行执行通过；Worker 相关 3 个文件、66 个测试通过；Desktop 反馈和任务日志测试 19 个通过；全工作区 typecheck、修改测试 ESLint、Prettier、Native cargo check 和 diff check 通过。

## 生效与限制

`pnpm.cmd tauri:build` 已成功构建 Native、Worker sidecar、前端和 NSIS 安装包：

- 桌面程序：`apps/desktop/src-tauri/target/release/ai-video-desktop.exe`。
- 安装包：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`。

开发监视器曾在 11:53:26 自动重建并重启修复后的程序。额外尝试的 `tauri build --debug --no-bundle` 因该进程占用调试 EXE 而未完成，未强制结束它。最终检查时桌面进程已经退出，调试程序更新时间为 2026-10-12 11:55:16，正式程序和安装包更新时间为 11:56:28；正式版本和安装包独立构建成功。下次启动将使用对应的新产物。没有手动强制结束用户应用或自动提交新生成任务。上述产物构建成功不代表真实 Provider 付费请求已经验证。

既有结果未知任务的原始返回内容没有留存，无法仅通过改代码恢复当时的签名图片链接。应先核对 Provider 后台的生成记录与扣费情况，再决定是否重试。本次没有发起真实付费生成请求，也没有修改用户的失败任务记录。
