# Agent 编排 P5 项目级后台任务运行时验证记录

日期：2026-09-07  
阶段：全系统 Agent 编排 P5  
结论：完成；P6-P7 未完成，整机发布保持 `HOLD`

## 实现范围

- 新增 Worker-owned `ProjectTaskRuntime`。当前项目以 `projectSessionId` 为运行边界，在项目打开期间独立于 React 页面轮询已持久化的视频任务；项目关闭、切换或应用退出时停止本地调度，项目重开后从 SQLite 任务快照恢复。
- 调度器统一限制最多 2 个并发 Provider 请求和 500 ms 全局请求间隔；临时失败使用最高 30 秒的指数退避与 25% 抖动，Provider `Retry-After` 独立限制在 30 分钟内。
- 所有异步结果在写回前复核当前项目 session 和被调度 job；旧项目迟到响应不能观察新项目任务，也不能释放新 session 的并发预算。
- 新增 Native `provider.media.poll`。Native 读取 Credential Manager 中的 Provider profile，完成 Provider 状态查询，并把结果规范化为 `queued/running/succeeded/failed/cancelled`、有界 progress/cost/error、`retryAfterMs` 和受控临时文件元数据。
- UniCompAPI 成功任务通过鉴权 `/content` 下载；Vidu 国际站/中国站的签名 HTTPS 输出在 Native 内完成公网 DNS 校验、禁重定向和 512 MiB 上限下载。Worker 不接收 Provider 原始正文、认证头或签名 URL。
- 规范化成功输出支持 MP4/WebM；Worker 只接受 Native 临时目录内的受控路径，复核声明大小、实际大小、文件签名和内容哈希后原子移动到项目素材目录，并在 SQLite 事务中登记 generation result 和素材。
- 新增 revisioned `project.task.subscribe`。App 是唯一 Desktop 订阅 owner，将相同任务快照分发给会话状态、制作面板、任务日志和素材库；成功终态触发素材刷新，任务日志在忙碌期间不会丢失 revision。
- 删除 React-owned `VideoPollingScheduler` 及其页面生命周期测试；制作面板只提交、暂停、继续、取消和展示 Worker 快照，不直接查询 Provider。
- App 统一发送视频终态系统通知；无通知权限或系统通知失败时，任务日志仍是持久通知面。

## 固定边界核对

| 边界 | P5 结果 |
| --- | --- |
| Runtime owner | Worker 持有项目级调度；React 页面卸载不停止任务 |
| Provider owner | Tauri Native 持有凭据、认证请求、签名 URL 和远端下载 |
| 事实源 | 当前项目 SQLite 的 generation job/result/asset 仍是唯一运行时事实源 |
| 项目隔离 | 每次请求携带并复核 `projectSessionId`；旧 session 响应在写回前丢弃 |
| 网络节流 | 2 并发、500 ms 全局间隔、指数退避、抖动和有界 `Retry-After` |
| 成功输出 | Native 只返回受控 MP4/WebM 临时文件；Worker 校验后原子落盘、事务入库 |
| 重复完成 | 已终态 job 不再调度；同一任务只保留一个 result 和一个素材记录 |
| 本地优先 | GitHub 只管理源码与评审，不承担项目任务、素材或项目数据同步 |
| 素材库规则 | 仅成功下载、校验并落盘的结果进入素材库；未改变已确认产品规则，无需修改素材库 DOCX |

## 关键回归

- 没有制作面板或素材库页面 owner 时，已提交视频任务仍由 Worker 轮询并发布 revisioned 快照。
- 多任务遵守全局间隔和并发上限；429/5xx 与传输错误按退避重试，`Retry-After` 可超过普通 30 秒退避但不超过 30 分钟。
- Native 返回未知字段、原始 Provider body、缺失成功输出、非法 cost/output/error 或状态不匹配时 fail closed，不形成无限轮询。
- 项目切换后的迟到 Native 响应不会调用 `observe`；旧 session 请求完成不会减少新 session 的活动请求计数。
- 关闭并重开项目后继续持久化 Provider task，不重新提交付费请求。
- UniCompAPI MP4 与 Vidu WebM 受控文件均可成功落盘并幂等入库；临时文件消费后删除。
- 暂停、取消和终态任务从调度集合移除；继续操作重新进入调度。
- Native 成功规范化不泄漏 Provider 原始正文、request ID 或签名 URL；失败诊断移除 URL 和凭据片段。
- Native 公网地址过滤拒绝 `0/8`、`192.88.99/24`、`240/4`、IPv4-mapped IPv6、6to4、文档与保留 IPv6 范围，避免签名输出下载绕过 SSRF 边界。
- Desktop 单订阅 owner 只在 revision 变化时更新快照；活动任务 1 秒刷新、空闲 5 秒刷新；任务日志忙碌时保留待处理 revision。

## 自动化验证

| 命令 | 结果 |
| --- | --- |
| `pnpm.cmd test` | 全仓 620 项 JS/TS 通过：Contracts 12、Context 7、LLM 10、Generation Adapters 17、Persistence 27、Desktop 175、Worker 372 |
| `pnpm.cmd typecheck` | 8 个 workspace package 通过 |
| `pnpm.cmd lint` | ESLint 通过 |
| `pnpm.cmd format:check` | Prettier 通过 |
| `pnpm.cmd build` | Contracts、Domain、Context、LLM、Adapters、Persistence、Worker、Desktop 生产构建通过 |
| `cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check` | 通过 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | Rust 79 项通过 |
| `cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml` | 通过 |
| `pnpm.cmd worker:sidecar` | Windows x64 sidecar 构建通过 |
| `pnpm.cmd --filter @ai-video/worker validate:pi-runtime-spike` | Pi 0.84.3 的 12 项检查通过；20 次 faux Provider 调用，零网络、零凭据载荷 |
| `pnpm.cmd --filter @ai-video/worker validate:m7-sidecar` | malformed JSON 恢复、离线示例项目、缓存边界、诊断脱敏和 SQLite 完整性通过 |
| `pnpm.cmd tauri:build` | Tauri Release 与 x64 NSIS 构建通过 |
| `pnpm.cmd audit --audit-level=high` | `No known vulnerabilities found` |
| `pnpm.cmd audit --prod --audit-level=high` | `No known vulnerabilities found` |
| `pnpm.cmd license:check` | 33 个生产依赖许可证检查通过 |
| `pnpm.cmd sbom:generate` | CycloneDX `sbom.json` 已更新 |
| `git diff --check` | 通过 |

## Windows 产物

| 产物 | 大小 | SHA-256 |
| --- | ---: | --- |
| Worker sidecar | 74,581,776 bytes | `8486024CB4C1ECCF7CC46BFD0FA5415143736C1ABDC723119D6AE60F434A23DE` |
| Desktop Release exe | 11,311,616 bytes | `051F7537D2EF81F7D606730E46A3B54CE05705A45E6C7E958B008BF267F13E44` |
| NSIS installer | 21,722,279 bytes | `AE7B85B3254E340DE175B695DDB0E4D1DC80F59F01E1A8D2DD2F49FBC162C44E` |
| CycloneDX SBOM | 805,214 bytes | `99054FEC861F07236E54F568088B76D6E905EB8341FF0454358BAE57033C324F` |

构建保留两个非阻塞警告：Vite 主 JS chunk 为 519.78 kB，超过 500 kB 提示阈值；MSVC linker 输出导入库创建信息。Node/Vitest 还会提示未提供 `--localstorage-file`，不影响 jsdom 测试结果。

## 未完成边界

- 未调用真实或付费 UniCompAPI、Vidu 国际站、Vidu 中国站；自动化只使用 faux/mock Provider 和本地固定文件。
- 未执行 Windows NSIS 人工安装、覆盖升级、卸载、签名验收。
- 未执行真实断网、休眠、多窗口、慢首 Token 或 24 小时长稳观察。
- Pi 历史实施计划 P5/P6 的 RAG 只读工具、完整事件映射、独立 conversation runtime 推送订阅及其全部退出门禁尚未完成。
- 全系统 Agent 编排 P6 的完整工具覆盖与重复入口清理、P7 的真实 Provider/Windows 人工验收和发布签收仍未完成。

因此全系统 Agent 编排阶段状态为 P0-P5 完成、P6-P7 未完成，整机发布继续保持 `HOLD`。
