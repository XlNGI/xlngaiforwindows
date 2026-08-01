# 工程质量门禁

版本：4  
日期：2026-08-02

本规范适用于 M3 及后续所有里程碑。计划中的功能条目只有在其不变量、失败路径和验证证据同时完成后才可标记为完成。

## 1. 必需设计产物

每个包含持久化、异步任务或外部 API 的功能在编码前必须定义：

1. 领域不变量：任何执行顺序下都必须成立的规则。
2. 状态机：允许的状态、转换发起者、持久化位置和终止状态。
3. 所有权：数据属于哪个项目、会话、镜头、任务和请求。
4. 故障矩阵：关闭、切换、取消、超时、断网、崩溃、重启和重复调用的行为。
5. 契约：Schema、IPC 和外部响应的合法及失败形态。
6. 追踪表：每条不变量对应的实现模块、自动化测试和人工验证证据。

只有正常路径、没有上述产物的功能不得进入实现完成状态。

## 2. 通用不变量

- 项目会话令牌变化后，旧异步任务不得写入当前项目。
- 关闭数据库前必须停止或隔离所有数据库使用者。
- 业务关联必须使用持久化 ID，不得通过时间戳、随机 ID 排序或界面位置推断。
- 每个异步任务必须进入 `complete`、`failed` 或 `cancelled` 终态；进程重启后不得永久保留活动状态。
- 外部 API 只有收到协议定义的成功终止事件才算成功；失败、未完成和截断响应不得降级为成功。
- 生产约束不得因预算、摘要或排序而静默丢失。
- 流式界面更新必须同时匹配项目 ID、会话 ID 和任务 ID。
- 重试必须幂等地复用原始输入，不得重复写入输入消息或选择相邻但无关的数据。
- 凭据不得进入数据库、快照、日志、测试输出或错误详情。

## 3. 异步状态机门禁

```text
created -> streaming -> complete
                    -> failed
                    -> cancelling -> cancelled
                    -> interrupted -> failed/recovered
```

每个状态转换必须具备至少一个自动化测试。项目关闭和切换必须等待活动任务进入终态，或通过持久化会话令牌保证后续回调无法写入任何新会话。

## 4. 故障场景基线

| 场景 | 必须满足的结果 |
|---|---|
| 流式生成时关闭项目 | 任务先取消并落盘终态，再关闭数据库 |
| 流式生成时打开其他项目 | 旧任务不读取或写入新项目 |
| Worker 在流式写入时退出 | 下次打开项目时修复遗留 `streaming` 状态 |
| 两条消息时间戳相同 | 顺序稳定，重试仍定位准确 |
| Provider 返回失败或未完成事件 | 任务标记失败并保留可重试信息 |
| SSE 在终止事件前断开 | 不得标记完成 |
| 约束总量超过上下文预算 | 明确拒绝请求，不发送缺少约束的上下文 |
| 生成时切换会话 | 旧会话增量不进入当前会话界面 |
| 相同取消/重试请求重复执行 | 状态一致且不重复写入业务输入 |
| 能力/供应商/模型无法唯一解析 | 明确失败，不回退到相邻模型或旧 Schema |
| 参数包含未知字段或凭据 | Schema 拒绝，项目数据库和日志中不出现凭据 |
| 时长、分辨率或素材数量组合无效 | Worker 复验失败，不保存草稿或创建任务 |
| 切换适配器 | 只显示新 Schema 字段，并按镜头和适配器键读取独立草稿 |
| Windows 安全存储不可用 | 明确失败，不创建项目文件或明文后备存储 |
| 两个进程同时争用无锁项目 | 只有一个可写，其余稳定降级只读，不返回 `EEXIST` |
| 损坏备份恢复失败 | 关闭探针、保留数据库错误并清理失败目录 |
| Provider 不返回首字节或流中途停顿 | 在首字节/空闲/总时限后失败，不永久保持 `streaming` |
| Provider 忽略 Abort | 关闭和切换在固定时限内完成，旧回调不能再写数据库 |
| Worker stderr 持续输出 | 后台排空且有界保留，不阻塞 stdout 响应 |
| Worker 请求无响应 | IPC 超时，终止并在下次请求重建 Worker |
| 中文上下文接近预算 | 中文保守估算与裁剪共用规则，不绕过 token 门禁 |
| 同模型存在多个 API Version | UI 使用完整 adapter key，解析显式携带版本 |
| 快速切换项目/场次/镜头/会话 | 过期请求结果和错误不得覆盖当前选择 |

## 5. 需求追踪

| 不变量 | 负责模块 | 必需测试 |
|---|---|---|
| 项目关闭后禁止生成回写 | Worker Generation/Project Service | close-during-stream |
| 回复稳定关联原始提问 | Schema/Chat Repository | same-timestamp-retry |
| 重启修复流式遗留状态 | Chat Repository/Generation Service | interrupted-recovery |
| Provider 失败不算成功 | LLM Provider | failed/incomplete/truncated-stream |
| 生产约束不可静默丢失 | ProductionContext | constraints-over-budget |
| 流式状态不可跨会话显示 | Desktop Chat | switch-conversation-during-stream |
| 适配器选择必须唯一且不可回退 | Adapter Registry | unique-resolution/unsupported-selection |
| 未声明字段和凭据不可进入草稿 | Adapter Schema/Worker Draft Service | additional-properties/credential-exclusion |
| 模型能力组合必须在 Worker 复验 | Adapter Registry | duration-resolution/reference-count |
| 草稿不得跨镜头或跨项目 | Worker Draft Service/SQLite | shot-adapter-ownership |
| 凭据只进入 Windows 安全存储 | Tauri Credential Commands | provider-allowlist/native-status |
| 多进程只允许一个写者 | Worker Project Service | multi-process-lock-race |
| 损坏恢复不泄漏连接 | Worker Project/Persistence | corrupt-restore-cleanup |
| LLM 网络等待有界 | LLM Provider/Generation Service | headers/first-byte/idle/cancel-timeout |
| Worker IPC 等待有界且 stderr 不死锁 | Tauri Worker Process | stderr-pressure/request-timeout |
| 中文预算不得低估 | ProductionContext | conservative-chinese-budget |
| 凭据只向指定适配器使用 | Tauri Native Provider Bridge | exact-adapter/field-and-endpoint-rejection |
| 流增量写入有界 | Worker Generation Service | batched-delta-persistence |
| 过期 UI 请求不得回写 | Desktop Workspace | stale-conversation-load |

后续里程碑必须在本表中追加不变量，不得删除历史条目来规避门禁。

## 6. 本轮复验状态

2026-08-02 自动化与外部条件复验：

- `pnpm test`：13 个测试文件、65 个测试通过。
- `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`：通过。
- `pnpm worker:sidecar` 与 M4 Sidecar 生命周期验证：通过。
- `cargo fmt --check`、`cargo check --offline`、`cargo test --offline`：通过，7 个 Rust 测试通过。
- `pnpm tauri:build`：通过，生成 20,201,254 字节的 x64 NSIS 安装包；SHA-256 为 `2461E07956CA1328DC5DA1DD02C065CA2A4B8FB4A319DECFA2CF4D9CADE9F3AA`。
- Release 同目录冒烟：通过；桌面程序实际拉起安装后名称 `ai-video-worker.exe`，并在启动 health/SQLite 检查期间保持 Worker 存活。
- Vidu 官方失败响应：通过；向固定官方端点发送无效测试令牌得到 HTTP `403`，未创建任务或消耗额度。
- 干净安装门禁：已增加 `scripts/validate-nsis-install.ps1` 并接入 Windows CI，覆盖静默安装、启动、Worker 存活、窗口关闭、Worker 无残留和卸载后二进制清理；尚待首次远程 runner 执行。
- Git 审计基线：仓库已初始化，忽略规则与敏感内容审计通过；`main` 基线使用 GitHub 公开身份与 noreply 邮箱提交。
- 未验证：NSIS 干净 Windows runner、真实 OpenAI 模型请求、带真实凭据的 Vidu 成功请求。当前环境未配置 Provider 凭据，且 OpenAI 443 连接超时。

因此已知代码级 `P1/P2` 为零；最终里程碑签收保持 `HOLD`，未验证项完成前不得标记为完整发布验证。

## 7. 签收规则

- `P0`、`P1` 已知问题必须清零。
- `P2` 问题必须记录接受原因、影响范围、负责人和计划修复里程碑。
- 单元、契约、集成和原生端检查全部通过。
- 外部 Provider 至少通过官方失败响应样本；真实网络验证未执行时必须明确标记为未验证。
- 文档中的“完成”只能引用当次可重复执行的命令或测试证据。
- Mock 验证不得替代真实安装、进程重启、文件锁和外部网络验证。

## 8. 实施顺序

```text
功能目标
-> 不变量与非目标
-> 状态机和所有权
-> 故障矩阵
-> Schema/IPC/Provider 契约
-> 风险测试
-> 实现
-> 对抗性代码审查
-> 全量门禁
-> 真实环境验证
-> 里程碑签收
```
