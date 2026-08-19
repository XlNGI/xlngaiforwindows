# 工程质量门禁

版本：5  
日期：2026-08-03

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
- 对象存储签名 URL 的查询参数和 fragment 视为临时凭据，不得进入 SQLite、备份或导出；旧项目必须通过前向迁移清理。
- 素材文件与 SQLite 记录的创建、删除必须具备补偿回滚；任一侧失败不得留下孤儿文件或丢失仍被数据库引用的文件。
- 浏览器开发 HTTP Worker 只接受受信任的本地 Origin、JSON Content-Type 和当前进程随机令牌；发布版标准输入输出 IPC 不受该开发入口影响。

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
| Native 研究桥缺少或令牌错误 | Worker 研究 fail-closed；不回退到 Worker 直接外网请求 |
| Native 研究请求取消或 Worker 崩溃 | 当前桥请求不得产生草稿或伪造成功；恢复语义需在任务日志中明确为失败/重试 |
| 中文上下文接近预算 | 中文保守估算与裁剪共用规则，不绕过 token 门禁 |
| 同模型存在多个 API Version | UI 使用完整 adapter key，解析显式携带版本 |
| 快速切换项目/场次/镜头/会话 | 过期请求结果和错误不得覆盖当前选择 |
| 视频任务提交后应用退出 | 已持久化的 `providerTaskId`、适配器和区域可恢复查询，不重新提交计费任务 |
| 视频多任务同时轮询 | 每个任务只有一个调度项，全局请求间隔和并发数有界 |
| 视频查询返回 429/5xx 或断网 | 保持可恢复状态并退避重试，达到持久化总期限后写入超时终态 |
| 视频 Provider 报成功但无视频输出 | 写入失败终态，不把输入图或封面图登记为视频 |
| 视频下载超过 Worker IPC 的 30 秒期限 | Provider 成功先持久化为 `downloading` 并释放 IPC，后台下载完成后由本地状态刷新进入终态 |
| 视频下载中取消、关闭或切换项目 | 删除临时文件，旧项目回调不得登记资产或覆盖新项目界面 |
| 视频任务取消 | 先稳定写入本地取消并停止轮询；远端取消失败不得恢复本地任务 |
| 诊断导出遇到敏感文本或超大事件 | 密钥、请求正文、URL 和绝对项目路径必须脱敏；单条事件和报告总大小有界 |
| 诊断导出写入失败或目标已存在 | 不覆盖既有目录，清理本次临时目录，不留下半成品 |
| 缓存中存在符号链接、联接或目录循环 | 只处理当前项目 `cache/`，不跟随链接，不触及素材、导出、备份或数据库 |
| 只读项目请求清理缓存 | 明确拒绝清理；缓存检查和诊断导出仍可用 |
| 示例项目目标非空或事务失败 | 不删除既有内容；回滚数据库并仅清理本次新建容器 |
| 媒体写入时磁盘余量不足或文件超限 | 在登记素材前拒绝，清理临时文件，不产生成功结果 |
| 最近项目记录不可写 | 项目仍成功创建/打开且数据库连接可用；最近列表作为非关键元数据降级失败 |
| 图片 Provider 返回签名 URL | 下载使用完整 URL；SQLite、备份和导出只保留去查询参数和 fragment 的 URL |
| 图片文件已落盘但 SQLite 登记失败 | 删除最终文件并把活动任务写入失败终态；不得留下孤儿素材 |
| 删除素材时 SQLite 事务失败 | 从项目缓存 tombstone 恢复原文件，数据库记录和文件保持一致 |
| 视频响应缺少或少报 Content-Length | 按实际流入数据块持续检查磁盘余量，写盘前拒绝并清理临时文件 |
| 切换会话后旧生成查询回包 | 同时校验项目、会话、生成 ID 和请求版本，不更新状态或重启轮询 |
| 恶意网页向开发 Worker 发送 POST | Origin、Content-Type 或随机会话令牌任一不匹配即拒绝，不进入 RPC 处理 |
| Worker 收到损坏 JSON | 返回有界协议错误并继续处理后续请求 |
| 新安装包覆盖安装或卸载 | 外部项目 ID、内容摘要和完整性保持不变，卸载不得删除用户项目 |

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
| 视频任务 ID、区域和轮询状态原子持久化 | Worker Video Generation / SQLite | attach-idempotency/restart-recovery |
| 视频轮询去重、限流和退避 | Desktop Video Polling Scheduler | deduplicate/backoff/deadline/dispose |
| 视频 Provider 终态不可误判 | Worker Video Generation | active/failure/success-without-output/input-not-output |
| 视频下载和资产提交受项目会话隔离 | Worker Video Generation / Asset Repository | cancel-during-download/atomic-result/signed-url-exclusion |
| 视频长下载不占用 Worker IPC | Worker Video Generation / Desktop Polling Scheduler | pending-download-return/local-download-refresh/restart-temp-cleanup |
| 视频暂停、继续、超时和取消幂等 | Worker Video Generation | pause-resume/timeout/terminal-cancel |
| 视频适配器与原生端点精确匹配 | Adapter Registry / Tauri Provider Bridge | text/image/reference/start-end schemas/exact-path/task-id-rejection |
| 视频重启恢复不重新提交 | Desktop Production Panel / Polling Scheduler | restored-polling-without-submit |
| 诊断输出脱敏、有界且原子发布 | Worker Maintenance Service | redaction/size-bound/existing-target/temp-cleanup |
| 缓存维护受项目边界和链接隔离 | Worker Maintenance Service | nested-files/symlink-junction/read-only |
| 示例项目原子初始化 | Worker Sample Project Service | seeded-content/non-empty/rollback |
| 媒体写入受磁盘余量和体积上限保护 | Worker Image/Video Generation | low-space/image-limit/video-limit |
| 签名 URL 不得持久化或继续存在于旧项目 | Worker Image Generation / SQLite Migration | signed-download-sanitization/v5-url-scrub/backup-byte-exclusion |
| 最近项目历史失败不得破坏项目会话 | Worker Project Service | recent-write-failure-create-open-integrity |
| 素材文件和数据库删除保持一致 | Worker Image Generation / SQLite | delete-trigger-tombstone-restore |
| 图片最终文件和任务提交保持一致 | Worker Image Generation / SQLite | insert-trigger-file-rollback/failed-terminal-state |
| 分块视频下载不能绕过磁盘预留 | Worker Video Generation | no-content-length-stream-capacity |
| LLM 轮询回包必须属于当前选择 | Desktop Workspace | in-flight-generation-switch |
| 浏览器开发 Worker 只接受本次可信会话 | Worker HTTP / Vite Proxy | origin/content-type/token unit-and-live-server |
| 损坏 JSON 不终止 Worker | Worker IPC Handler / Packaged Sidecar | parser-recovery/subsequent-health |
| 安装升级不得损坏外部项目 | NSIS / SQLite | clean-install/overwrite-digest/integrity/uninstall-preservation |

后续里程碑必须在本表中追加不变量，不得删除历史条目来规避门禁。

## 6. 本轮复验状态

2026-08-03 历史自动化与外部条件复验：

- `pnpm test`：22 个实际测试文件、146 个测试通过。
- `pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`：通过。
- `pnpm worker:sidecar` 与 M7 Sidecar 生命周期验证：通过。
- `cargo fmt --check`、`cargo check`、`cargo test`：通过，12 个 Rust 测试通过。
- `pnpm tauri:build`：通过，生成 20,275,869 字节的 x64 NSIS 安装包；SHA-256 为 `1DC290F9FCDD9773B275026D24C662EC5C7E6CE929005FF9506844B29474A7C8`。
- M7 对抗性复验修复：签名 URL 持久化及旧库清理、最近项目僵尸会话、素材删除数据丢失、图片提交孤儿文件、分块视频磁盘预留、LLM 过期回包和开发 HTTP Worker 信任边界均有失败注入或真实本地服务器回归测试；SQLite 当前 Schema 为 v11。
- Release 同目录冒烟：通过；桌面程序实际拉起安装后名称 `ai-video-worker.exe`，并在启动 health/SQLite 检查期间保持 Worker 存活。
- Vidu 官方失败响应：通过；向固定官方端点发送无效测试令牌得到 HTTP `403`，未创建任务或消耗额度。
- 干净安装门禁：`scripts/validate-nsis-install.ps1` 已接入 Windows CI，使用唯一临时安装目录，覆盖静默安装、启动、Worker 存活、窗口关闭、Worker 无残留和卸载后二进制清理；本机完整执行通过，fail-fast GitHub Windows runner run `30720119063` 通过且无错误注解（包括该安装生命周期步骤）。
- M5 生图失败路径：安全传输失败显式落为 `failed`，关闭/切换落为 `cancelled`，Worker 重启将遗留活动任务恢复为 `failed`；下载结束后复验项目会话和任务状态。自动化 UI/SQLite 复测未发现 `running` 遗留、结果记录或素材半成品。
- M6 生视频自动门禁：Provider 任务 ID/区域持久化、退避轮询、`downloading` 后台传输、重启恢复、暂停/继续/取消/超时、临时文件清理、素材登记和本地打开均通过本地自动化、干净 NSIS 生命周期及 Hosted Windows CI run `30740465271`。人工反馈新增的 URL/本地图片混合输入已通过格式、签名、体积、取消、首尾顺序、Base64 不落库、原生请求上限、实际 React 布局和 Hosted Windows CI run `30742683334`；真实 Vidu 参考生视频成功路径已于后续人工验证通过。
- M6 生产方式补全：目录独立显示文生图、参考生图、文生视频、图生视频、参考生视频和首尾帧生视频；新增文生视频固定端点/字段白名单，并保留旧视频任务键的恢复兼容。真实参考生视频已在国内站完成 18 次轮询、MP4 下载和素材登记；新增模式的本地代码、Rust 与 sidecar 门禁通过，Hosted Windows 和真实文生/图生/首尾帧请求待验证。
- M7 本地维护门禁：诊断脱敏和 256 KiB 报告上限、缓存路径/链接隔离、只读清理拒绝、示例项目事务回滚、16 MiB 磁盘余量、25 MiB 图片和 512 MiB 视频上限、损坏 JSON 恢复均通过单元和打包 Sidecar 验证；Sidecar 创建 5 份示例文档并完成 SQLite 完整性检查。
- M7 发布生命周期：本机及 Hosted Windows CI run `30754118267` 的干净 NSIS 安装验证通过；同一安装包覆盖基线保持项目 ID、文档摘要、SQLite 完整性，并确认卸载后外部项目仍存在。该结果不替代上一正式版本到当前版本的真实跨版本升级。
- M7 视觉门禁：项目维护对话框在 1280x720 和 390x844 视口均未发现越界、文本/控件溢出或交互控件重叠。
- M7 签名门禁：当前安装包 Authenticode 状态为 `NotSigned`，`scripts/validate-windows-signature.ps1` 按预期拒绝；正式证书签名和时间戳仍是发布阻断项。
- Git 审计基线：仓库已初始化，忽略规则与敏感内容审计通过；`main` 基线使用 GitHub 公开身份与 noreply 邮箱提交。
- 当前硬化候选的本机干净 NSIS 安装和同包覆盖生命周期通过；覆盖前后项目 ID、文档摘要、SQLite 完整性和卸载后外部项目保留均通过。
- 当前硬化提交 `a8ddaa261c117b32d6f60fdafad2df45da97260d` 的 GitHub Hosted Windows CI run `30757944779` 通过，`validate` job 的 22 个步骤全部成功，包括 146 项测试、M7 Sidecar、Tauri/NSIS、干净安装和覆盖安装保留验证。
- 本轮 M7 未验证：真实 OpenAI/Vidu 发布候选成功请求、正式签名、上一正式版本升级、干净 Windows 虚拟机、断网/联网切换和真实系统休眠恢复。既有 M6 真实参考生视频证据不替代当前发布候选验证。
- UniCompAPI 自动门禁：官方单卡片、搜索式平铺模型列表、未知模型默认关闭、精确能力合同、聊天/图片/编辑/视频固定路由、Bearer 原生桥、鉴权视频下载、Base64 脱敏和 Vidu 回归均有自动测试。模型同步到启用再到原生路由的 Worker/Rust 集成测试通过；真实 UniCompAPI 凭据与额度请求尚未执行，状态保持 `HOLD`。
- UniCompAPI Vidu 兼容视频请求体：2026-08-12 新增 `viduq3` 参考生视频和 `viduq3-pro` 首尾帧生视频目录项；两者复用 Vidu 官方 Schema，经 `/v1/videos` 发送时保留 `images` 数组、首尾顺序和已声明字段。generation-adapters 16 项、ProductionPanel 23 项、Rust 40 项测试及相关 TypeScript 类型检查通过；真实 UniCompAPI 额度请求尚未执行，状态保持 `HOLD`。
- 积分定价与参考生视频扩展：2026-08-19 完成 A1/A2 定价/用量回归、A3 sidecar ABI 硬门禁和 `viduq3-ad`、`viduq3-mix`、`viduq3-turbo`、`viduq2-pro` 扩展。配置工厂、Worker 内置模型补种、Rust 精确模型注入和视频任务白名单均已同步；mix 在 TypeScript Schema 与 Rust 字段白名单双侧拒绝 `off_peak`。generation-adapters 17 项、Worker 21 文件/172 项、Rust 49 项、sidecar build 与 M7 SQLite lifecycle 验证均通过；真实 Vidu/UniCompAPI 额度成功请求仍为 `HOLD`。
- Agent 研究取消与普通文档意图：2026-08-19 Worker 研究请求已带请求 ID，Native bridge 提供 `/research/cancel`、进程级取消注册表和 WinHTTP 分段取消检查；普通聊天仅对明确文档动作升级 Agent，目标操作必须绑定当前文档，否定表达/无目标请求零写入。Worker 198 项、Desktop 111 项、Rust 55 项、全仓测试/类型/lint/format/build 通过；Worker 崩溃后研究恢复、真实研究冒烟、安装包和 Windows 实机取消演练仍未验证。
- 发布升级门禁硬化：`validate-nsis-upgrade.ps1` 现在默认拒绝相同内容的“上一版本”安装包；同包覆盖只能显式使用 `-AllowSameInstallerBaseline`，CI 未配置 `PREVIOUS_INSTALLER_PATH` 时记录 HOLD，不再把覆盖测试当作跨版本升级证据。
- Markdown 文档导入：2026-08-13 新增项目文档工具栏一键导入；只接受用户明确选择的 UTF-8 `.md`/`.markdown` 文件，原生读取边界限制为 5 MiB，并覆盖 BOM、非法扩展、非法编码和超限拒绝。导入内容通过既有 `document.save` 创建“创作笔记”正式版本，可进入后续 LLM 上下文；Desktop 63 项、Worker 117 项、Rust 41 项测试，以及全仓类型检查、Lint、Prettier、Rust fmt/check 和桌面生产构建通过，1280×720 与 390×844 工具栏无越界或水平溢出。
- 素材类型下拉筛选：2026-08-13 将“全部素材 / 图片 / 视频”三段按钮合并为单选下拉菜单，保留 `all/image/video` 查询合同及与素材组、日期、排序的组合筛选；真实项目 9/6/3 项切换正确，1440×900、1280×720 与 390×844 无越界、重叠或水平溢出。
- UniCompAPI 发布候选本机门禁：2026-08-11 重新打包 Worker Sidecar、M7 Sidecar 生命周期、Tauri Release、NSIS 和临时目录干净安装均通过；候选安装包为 `20,551,685` 字节，SHA-256 `C47BAF6404964609583D20ACF532A5D24CE326C2FA629D16350D2A99C739156D`。安装包仍为 `NotSigned`，本次结果不替代 Hosted Windows、正式签名或真实 UniCompAPI 请求。

2026-08-16 文档工作流审计复验：

- Schema v13 `document_audit_events` 已接入项目迁移；Persistence 18 项、Worker 131 项、Desktop 88 项测试通过。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`cargo fmt --check` 和 Rust 41 项测试通过。
- 审计记录覆盖草稿保存/恢复、审核提交/退回/拒绝和发布；审计事件有界且不可更新/删除。Windows 独立窗口实机、迁移备份恢复演练和正式签名仍是人工发布门禁。

因此本轮已知代码级 `P1/P2` 已清零，当前硬化提交的本地与 Hosted Windows 自动门禁均通过。最终里程碑签收保持 `HOLD`，未验证项完成前不得标记为完整发布验证。

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
