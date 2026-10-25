# 当前后端代码与纯 Rust 迁移审计

日期：2026-10-23（Asia/Shanghai）  
范围：当前工作区的后端边界、IPC、项目运行实例、持久化、Agent、任务执行及迁移可行性。  
性质：审计与建议；没有修改运行时代码，没有开始迁移，没有改变既定产品规则。

## 1. 结论

当前架构可以迁移到纯 Rust 后端，但还不能把当前实现视为已经冻结的等价迁移基线。需要先明确 IPC 契约与项目所有权，修正已复现的传输问题，再逐模块迁移。

本次确认四项问题：

| 编号 | 级别 | 问题 | 验证方式 |
| --- | --- | --- | --- |
| A1 | P1 | Worker 请求的同步管道写入不受请求超时保护 | 当前代码检查 + 独立 Rust 管道复现 |
| A2 | P2 | 原生 LLM/兼容 Agent 的反向 RPC 没有携带项目 scope | 当前调用链检查 + 真实 Worker handler 离线复现 |
| A3 | P2 | 两个 WorkerMethodMap 方法不能通过真实 IPC 入口 | TypeScript 类型集合对比 + parseRequest 复现 |
| A4 | P2 | IPC 写请求等待队列没有数量上限、等待期限及排队取消接口 | 当前实现检查 + 10,000 请求离线排队复现 |

级别定义：P1 应优先修复；P2 应在迁移基线冻结前处理或明确约束。没有把迁移复杂度、文件大小或未运行的发布验证直接计为产品缺陷。

## 2. 审计基线和边界

- Git HEAD：a71ba2cea2c82bde53be28e89679f95ff289bca3。
- 审计对象包含已有的未提交修改与未跟踪源码。审计中后端关键文件保持相同哈希，但前端有并行修改，不能用 HEAD 的测试状态代替工作区状态。
- 一次状态采样记录 146 项工作区变更（110 项已跟踪变更，36 项未跟踪项）；该数字是执行时点采样，不是干净提交的说明。
- 本机验证环境：Windows、Node v26.5.0、pnpm 11.9.0、Cargo 1.97.1。
- 没有读取真实项目内容或 Provider 凭据。复现使用临时目录、内存 SQLite、伪模型配置及本地子进程；没有发送真实模型生成请求。
- 已检查仓库 AGENTS.md、素材库两份 Markdown 计划、项目检索计划、并发实施计划和质量门禁中的相关规则。本文不改变这些计划的已确认要求，也不勾选任何实施阶段完成项。

### 2.1 规模与边界

物理行统计包括空行、注释、类型定义和迁移源码；TS 排除独立 .test. 文件；Rust 统计包含文件内测试模块。不能把这些数字直接换算为工期或生产代码量。

| 模块 | 源文件数 | 物理行数 | 当前职责 |
| --- | --- | --- | --- |
| apps/worker/src | 86 | 54,027 | 业务服务、Agent、调度、IPC、媒体归档 |
| packages/persistence/src | 37 | 14,082 | SQLite Schema、迁移、Repository、检索索引 |
| packages/contracts/src | 17 | 5,953 | 前后端 IPC 类型与共享模型合同 |
| packages/domain/src | 1 | 1,202 | 领域定义 |
| packages/context/src | 1 | 283 | 上下文与摘要计算 |
| packages/llm/src | 2 | 735 | TS LLM Provider 和开发/兼容路径 |
| packages/generation-adapters/src | 4 | 1,722 | 生成适配器、参数校验与转换 |
| apps/desktop/src-tauri/src | 13 | 18,550 | 原生凭据、HTTP/SSE、模型合同校验、网络准入、进程桥 |

本次范围内 TS 合计 78,004 行。Worker 有 55 个文件导入 Node 内置模块；33 个文件包含 better-sqlite3 引用或 .database( 调用；Worker 中 .prepare( 文本出现 605 次，Persistence 中出现 378 次。这些是耦合扫描指标，不代表独立连接或独立 SQL 的数量。

大型文件包括 lib.rs 5,998 行、agent-provider-loop-service.ts 5,885 行、contracts/index.ts 4,505 行、llm_stream.rs 4,050 行、repositories.ts 3,782 行、handler.ts 3,177 行。迁移应按职责拆分，避免把这些文件逐行翻译为同样集中的 Rust 模块。

### 2.2 真实运行链路

1. React 经 worker-client.ts / worker-scope.ts 调用 Tauri worker_request，项目请求可携带项目 ID 与 session ID。
2. Tauri WorkerProcess 通过 JSONL 启动和调用 Node Worker；发布版另行打包 Node 与 better-sqlite3 原生模块。
3. Worker 的 ProjectRuntimeRegistry 管理多个项目服务实例；AppSettingsService、ExecutionPool 与 TaskCapacity 在进程内共享。
4. 新建普通 Agent 任务固定选择 Pi。PiConversationRuntime 管理模型轮次、工具执行与确认；AgentProviderLoopService 保留业务授权、任务步骤、幂等和持久化规则。
5. Provider 凭据与主要生产网络请求已在 Rust 原生层。Pi 经 NativeProviderBridge 请求原生层，接收规范化流事件。
6. 仍有普通原生 LLM 流和兼容 Native Agent 路径。ShotContinuityPanel 的提示词生成功能使用普通原生流，不能把所有 llm_stream.rs 路径当作已经退役。

关键代码：[服务装配](../../apps/worker/src/handler.ts#L798)、[项目绑定](../../apps/worker/src/handler.ts#L1367)、[Pi 选择规则](../../apps/worker/src/conversation-runtime.ts#L58)、[Pi 循环](../../apps/worker/src/pi-conversation-runtime.ts#L326)、[前端流分支](../../apps/desktop/src/llm-client.ts#L431)。

## 3. 已确认问题

### A1：P1，Worker 请求超时没有覆盖管道写入

位置：lib.rs 的 request_with_timeout 在 2382 行先调用 write_sidecar_value，2383 行才调用 recv_timeout。write_sidecar_value 在 2435–2440 行等待普通 Mutex 并同步执行 ChildStdin.write_all / flush。

触发条件：Worker 停止读取 stdin，且请求体大于剩余管道容量。即使请求符合 2 MiB 限制，调用线程仍可在进入 recv_timeout 之前阻塞；等待同一 writer 锁的其他请求也受影响。

影响：现有“超时后返回并在下次请求重建 Worker”的恢复路径不能保证覆盖此故障。该结论不是已经观察到真实用户卡死的声明。

验证：独立 Rust 程序复现当前同步写入与后续响应等待的先后关系。子进程为不读取 stdin 的 Node 定时器进程，写入 1 MiB；假定响应超时为 50 ms，310 ms 后写入仍未返回，响应超时尚未有机会开始。看门狗杀死测试子进程后，阻塞写入才结束。

现有 worker_request_timeout_is_bounded 测试使用 process.stdin.resume()，只覆盖“已经成功写入但没有回复”，不覆盖“不读取 stdin”。本次 Rust 测试整体通过与该缺陷并不矛盾。

建议：从请求入队开始建立绝对期限；管道写入使用有界队列和独立写入所有者，超时能够使进程失效并唤醒相关等待者。单纯提前创建计时器或调整 recv_timeout 位置，无法中断同线程的阻塞 write_all。

证据：[请求期限](../../apps/desktop/src-tauri/src/lib.rs#L2357)、[同步写入](../../apps/desktop/src-tauri/src/lib.rs#L2425)、[现有测试](../../apps/desktop/src-tauri/src/lib.rs#L5629)。

### A2：P2，原生反向 RPC 缺少项目 scope

位置：llm_stream.rs 的 worker_call（826–840 行）和 resolve_runtime（1097–1106 行）只发送 id、protocolVersion、method、params，没有顶层 scope；handler.ts 1377 行在没有 scope 时选择当前激活项目。

触发条件：在项目 A 准备原生 LLM generation 后，激活项目 B，再从原生路径读取 A 的 runtime 或继续执行需要 Worker 的回调。params 内虽然包含 projectId / projectSessionId，但请求服务实例已在入口按当前激活项目绑定。

验证：用真实 handler 在临时目录创建 A、B；伪造的 LLM selection 只用于离线 prepare，不发送网络请求。A 的同一 generation identity 在激活 B 后：

- 原生风格、无顶层 scope：ok=false，Native LLM generation was not found.
- 加上 A 的顶层 scope：ok=true。

影响范围：原生 LLM 和兼容 Native Agent 调用链。普通 Pi 的前端观察与原生 Provider 桥有不同链路，本结论不等于所有 Pi 会话都会跨项目失败。当前身份复验会拒绝错误目标，复现没有观察到跨项目写入。

建议：所有项目级原生反向 RPC 从任务身份构建顶层 scope；同步检查关闭/退出收尾 RPC。补充 A 后台运行、B 前台激活的真实 Native→Worker 集成验证，不能只测试前端 scoped client。

证据：[反向调用](../../apps/desktop/src-tauri/src/llm_stream.rs#L826)、[runtime 解析](../../apps/desktop/src-tauri/src/llm_stream.rs#L1097)、[入口绑定](../../apps/worker/src/handler.ts#L1377)、[实际原生流入口](../../apps/desktop/src/ShotContinuityPanel.tsx#L141)。

### A3：P2，公开 IPC 类型与入口白名单漂移

位置：contracts/index.ts 的 WorkerMethodMap 声明 project.structure.get（3963 行）和 novel.structure.get（4090 行），handler.ts 的 methods 白名单没有这两项。

验证：使用 TypeScript 类型检查器展开 WorkerMethod 联合类型，共 249 项；对比 handler methods 数组为 247 项，差集恰为上述两项。把符合协议的请求交给当前 parseRequest，二者都返回 METHOD_NOT_FOUND。

影响：调用方可以通过 TypeScript 编译，却在真正 IPC 入口失败；Rust 迁移若仅以 WorkerMethodMap 为可执行接口清单，会得到错误的兼容基线。

范围澄清：AgentSystemToolService 在 207–210 行直接实现同名 Agent 工具。因此这里证明的是 IPC 契约与入口不一致，不是 Agent 内部结构查询完全不可用。

建议：确认两项方法是否属于公开 IPC。应公开则补齐入口、校验和分发；仅供 Agent 则从公开 WorkerMethodMap 分离。增加类型合同、入口白名单和分发器的集合一致性门禁；只把字符串加进白名单不足以完成修复。

证据：[项目结构合同](../../packages/contracts/src/index.ts#L3963)、[小说结构合同](../../packages/contracts/src/index.ts#L4090)、[入口拒绝](../../apps/worker/src/handler.ts#L1173)、[内部工具分发](../../apps/worker/src/agent-system-tool-service.ts#L207)。

### A4：P2，IPC 串行等待队列没有准入上限

位置：RequestScheduler.run 把后续写请求串到 mutationQueues 中保存的 Promise 尾部；没有入队数量限制、排队期限或排队 AbortSignal。bindWorkerRequest 在排队前 retain 项目服务，直到 run 完成才 release。

验证：阻塞一个 chat.message.save 的模拟执行，同一 queueKey 随后提交 10,000 项请求；全部被接受，释放前只有首项开始，释放后 10,001 项全部执行。复现使用无副作用函数，不调用数据库或 Provider，也不作为性能基准。

影响：业务执行池中的容量限制不能覆盖 IPC 入口的等待对象。异步串行请求长时间占用队列时，调用方可持续堆积请求和项目引用。

已有保护应保留：ExecutionPool 有全局 128 / 每 owner 32 的队列限制；视频任务也有独立任务上限。此问题仅指外层 RequestScheduler，不能据此声称整个任务系统没有限流。

建议：在绑定与入队边界增加全局、每项目上限以及等待期限；明确拒绝错误；排队取消须同步释放 retain。迁移到 Rust 时用有界消息通道表达该所有权，并继续保留既有任务池的阶段容量和公平性规则。

证据：[等待队列](../../apps/worker/src/request-scheduler.ts#L125)、[项目引用](../../apps/worker/src/handler.ts#L1382)、[已有执行池上限](../../apps/worker/src/execution-pool.ts#L69)。

## 4. 迁移时必须保留的现有机制

### 4.1 数据层超出 CRUD

本次在内存 SQLite 运行当前迁移，项目库到 v62，应用库到 v9，两者 integrity_check 均为 ok。排除 sqlite_ 前缀对象后：

| 数据库 | 表 | 显式索引 | 触发器 |
| --- | --- | --- | --- |
| 项目库 v62 | 101 | 103 | 123 |
| 应用库 v9 | 11 | 8 | 0 |

表数包含 FTS 辅助表、历史归档表等物理对象，不能解释为 101 个业务实体。触发器承担版本、不可变快照、所有权和任务状态约束，不能在迁移时只复制表结构。

需要验证的等价性包括：

- 两套独立的迁移记录，WAL、外键、busy_timeout 与连接关闭顺序。
- 每个项目的可写进程锁、进程身份与陈旧锁处理；多项目并发不放开同项目多写者。
- 注册的 sha256 SQL 函数、JSON 校验、FTS5 trigram 探测、索引触发器与中文回退检索。
- 含应用逻辑的数据回填和归档迁移。v60–v62 不只是独立 SQL 文件，不能仅抄最新 CREATE TABLE。
- 文档版本、CAS、草稿/发布指针、幂等回执、任务 dispatch 与远端 ID。
- 文件暂存、最终发布、数据库登记和失败补偿；复制 SQLite 文件也需要沿用现有快照/备份流程。
- JS JSON.stringify 参与请求哈希、快照和回执计算的调用点；为跨语言实现建立固定输入/字节/哈希样本，明确缺失字段、null、对象键顺序和数字表示。

证据：[数据库初始化](../../packages/persistence/src/database.ts#L75)、[项目迁移](../../packages/persistence/src/database.ts#L124)、[FTS 初始化](../../packages/persistence/src/project-library-chunks.ts#L180)、[最新数据迁移](../../packages/persistence/src/migration-v62.ts#L1)。

### 4.2 Agent 不等于一段工具循环

Pi 依赖在 Worker 包中锁定为 0.84.3。完全移除 Node 必须替换这部分 JS 运行时依赖；现有 Rust HTTP/SSE 不能独自替代完整 Agent 行为。

应独立保留并验证：并行工具执行与业务资源互斥、工具按需加载、请求总预算、工具输出修复上限、steering 补充、确认令牌、取消、任务计划、部分产物和恢复策略。当前 AgentProviderLoopService 中的数据库事务、步骤授权和幂等规则比 Pi 适配层更大。

先做离线 Rust Agent 验证有价值，但验证通过只证明核心机制可实现，不代表文档、制作、检索和媒体任务已经完成业务等价迁移。

### 4.3 可以继续利用的 Rust 和共享资产

- credential_store、provider_http、llm_stream、request_guard、official_video、dubbing_provider 已有实际原生实现与测试。
- 原生网络层包含准入、取消、端点限制、SSE 终态和结果外部化规则，迁移初期宜延续这些行为。
- 官方图片、视频、音频合同与模型绑定已有共享 JSON；Rust model_contract.rs 通过 include_str! 读取，同一份数据可以继续使用。
- FFmpeg 是现有媒体工具链的一部分；移除 Node Worker 不要求同时重写编解码，也不要求移除前端构建阶段的 Node/pnpm。

### 4.4 产品边界

继续保留资料正文按需 search/read、草稿与 published 来源标记、聊天附件不自动入检索库、当前项目 SQLite 存储、用户付费确认、素材成功落盘后入库，以及音频与图片/视频素材的既有边界。本文没有为迁移授权修改任何一项规则。

## 5. 验证记录

| 命令/检查 | 结果 |
| --- | --- |
| pnpm build | 首次通过；前端入口 JS 约 1,122.59 kB，Vite 提示大 chunk；不是本次后端正确性失败。其后的新增前端测试不在这次构建时点内 |
| pnpm typecheck | 首次通过；后续复核因新增 ChatPanel.prompt-references.test.tsx:20 的测试参数缺少 providerProfileId、modelId、affectsCost 失败（TS2739） |
| cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml --lib --offline | 167 通过，1 忽略；5 项 unused_mut 警告 |
| Worker 独立全量测试 | 71 文件、962 项通过 |
| Persistence 独立全量测试 | 20 文件、82 项通过 |
| Generation adapters 独立全量测试 | 5 文件、67 项通过 |
| Context / Contracts / LLM | 根测试流程中分别 8 / 30 / 32 项通过；Domain 没有独立测试文件 |
| Desktop 全量测试 | 独立复核 60 文件、555 项通过；运行于 19:18:11，包含审计期间新增的提示词引用测试 |
| IPC 同步写入复现 | 确认 A1 的阻塞次序；没有调用外部服务 |
| Native 项目 scope 复现 | 无 scope 失败，相同身份带 A scope 成功；没有调用外部服务 |
| WorkerMethod 集合与 parseRequest | 确认 249 / 247 差异及两个 METHOD_NOT_FOUND |
| RequestScheduler 排队复现 | 确认 10,000 项额外请求无入队拒绝，释放后全部执行 |
| pnpm lint | 最近一次执行失败：ProductionPanel.scene-bindings.test.tsx:820 有 1 项 no-unnecessary-type-assertion；之前出现的若干新编辑器错误已被并行修改 |
| pnpm format:check | 最近一次执行失败：11 个前端脚本/源码/测试文件存在格式问题；审计报告自身单独按 Prettier 格式化并复核 |

第一次 pnpm test 在 Desktop 的旧 textarea 断言处失败：提示词编辑器已改为 contenteditable，测试仍调用 toHaveValue。之后同一测试文件被并行修改为文本断言，本次针对 ProductionPanel.test.tsx 重跑 46 项全部通过。本审计没有修改该测试，也不把已经消失的首次失败当作当前未修复缺陷。

上述检查按命令执行时点记录。19:21（+08:00）复核时前端仍在并行修改，故不能声称存在覆盖最终所有修改的一次全仓绿色门禁；测试通过也不代表新增测试已经通过 TypeScript 类型检查。后端 A1–A4 的证据文件哈希在审计过程中保持一致。

测试日志存放于当前 Windows 临时目录的 xlngai-rust-audit-20261023 子目录。未运行 NSIS 安装升级、真实 Provider/计费调用、安装包体积和内存性能基准，也没有重新执行生产依赖漏洞、SBOM 和许可证全套发布门禁。本次测试结果不能替代正式发布签收。

## 6. 建议的迁移顺序

1. 固定当前 IR 改造后的业务基线，修复 A1–A3、补齐外层队列约束；对 RPC、项目 scope、状态机与数据回执建立可复用样本。
2. 提取与 Tauri UI 解耦的 Rust 协议/领域/存储接口；最小 Rust Worker 先兼容现有 JSONL，再做 Agent 闭环验证。不要同时改变前端通信方式和数据库格式。
3. 迁移两套 SQLite 迁移器、项目锁、版本与 Repository。新旧写入行为只能在独立数据库副本中对比；同一项目明确只有一个写入所有者。
4. 迁移项目、文档、检索、素材及 IR 业务，逐条验证 CAS、历史版本和文件补偿。
5. 迁移后台任务与 Agent 完整运行时，验证多项目、并行工具、确认、取消、未知计费提交和重启恢复。
6. 等价验证通过后移除 Node Worker、better-sqlite3 原生模块和 pkg 打包链，执行原发布门禁；是否把 Rust Worker 合并进 Tauri 主进程另行决策。

## 7. 后端证据指纹

以下 SHA-256 是审计时点的文件内容指纹，用于区分后续修改：

| 文件 | SHA-256 |
| --- | --- |
| apps/worker/src/handler.ts | 2e16ac5d326558568e6d3b3b147b09febf98f7df72700522b4926164d5480533 |
| apps/desktop/src-tauri/src/lib.rs | b764a92274e7e12ce801f144c0e273f3d082a41a774f7e2d860101547d446b54 |
| apps/desktop/src-tauri/src/llm_stream.rs | 2336686c1cbd13d27d6420138fb18d03d47317b8965b1a173274c5bc23435162 |
| apps/worker/src/agent-provider-loop-service.ts | 39fdd1293477641e0f8778ccaf11b61c75336bacc8381f21cf9e2ae875c93797 |
| apps/worker/src/pi-conversation-runtime.ts | 21129d80997ce9bd72cf741a58d0f004aacda46350802ac0419ba5aee4098958 |
| apps/worker/src/request-scheduler.ts | ab77cfebe0ebc4463bd253628a1cf489310019d7902a57dbbd78d2fd8982e4d9 |
| packages/contracts/src/index.ts | 76301eb1070c43fe0e2d5810743012ef37e6a503ccb48f31b86d30e3e38f6c97 |
| packages/persistence/src/schema.ts | c7c8f6601ab4d70cb6b5a5ea44b102d007946bd025481babe48d389b375da79d |
| packages/persistence/src/app-schema.ts | 32579cb03d97dcd934be9a93f6102d6a6573c6bb11b32709d22da72b4f383c02 |
