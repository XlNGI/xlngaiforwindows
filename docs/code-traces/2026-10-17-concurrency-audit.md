# 全系统并发代码审计

日期：2026-10-17。范围：当前工作区代码，包含审计开始前已有的未提交修改。用户要求先审计，不实施并发改造。

## 结论

当前系统已经具备部分并发基础：Worker IPC 可以接收多个请求，Pi 与 Native Bridge 按 ID 管理多项运行，视频后台轮询已有并发上限，网络层已有全局及服务限流。主要缺口在前端运行所有权、任务级调度与现有工具授权的串行约束。

审计复现了两处现存竞态：项目导出与素材删除不一致、图片迟到结果更新其他项目的界面。应先修复这两处，再放开同会话及批量并发。下面将现存缺陷和并发改造前置条件分别记录，避免把有意设置的保护误判为缺陷。

本轮只新增审计记录；临时复现测试已移除，业务源码与现有测试未改动。

## 1. 当前执行模型

| 链路 | 已核实的行为 | 判断 |
| --- | --- | --- |
| Worker IPC | `index.ts` 收到每行后独立异步分发；`RequestScheduler` 将白名单查询、后台请求直接执行，其他方法进入同一 `mutationQueue` | 已有异步并发；没有统一的任务池容量及队列状态 |
| 文本生成 | `GenerationService` 用 Map 管理生成；创建记录的事务拒绝同项目、同会话第二轮 `prepared/streaming`，不同会话可准备生成 | 后端容器支持多项生成，同会话互斥是明确保护 |
| Pi Runtime | `active`、确认、媒体选择和提交确认均按 generation ID 保存；普通会话的 `toolExecution` 是 `sequential` | 后端实例具备按生成隔离的基础，普通会话工具仍串行 |
| 桌面会话 | 一份 generation、一份 native run、一份任务轮询 owner；切换会话取消旧生成 | 尚不支持后台保留多个会话运行 |
| 视频任务 | Worker 持有多任务；轮询并发 2、最小全局间隔 500 ms；按项目 session 隔离迟到结果 | 可复用已有实现，不能把整个媒体链路视为串行 |
| 图片任务 | Worker 可接收不同任务；单次多图下载逐张等待；制作面板一份 busy/job/preview | 后端与界面能力不一致，单面板仍被整段生成占用 |
| 配音、口型、合成 | 整个 DubbingService 共用 `executionTail`；单场多个口型片段也逐一等待 | 存在实际的全局串行瓶颈 |
| 小说批量 | `runNovelChapterBatch` 串行等待每章完成，但仓库引用只来自它自己的测试 | 该函数不是当前正式入口；修改它不能实现产品并发 |
| 网络准入 | Rust 默认全局 8、同 origin 3、排队 10 秒；开发传输另有进程内 NetworkAdmission | 已有限流，但网络准入不等于持久化业务任务调度 |
| SQLite、检索 | 一个 Worker 持有项目连接；检索和大量持久化调用是同步代码 | Promise 并发不会使同线程同步 SQLite 查询获得 CPU 并行 |

主要定位：`apps/worker/src/index.ts:87`、`request-scheduler.ts:82`、`generation-service.ts:708`、`pi-conversation-runtime.ts:92`、`project-task-runtime.ts:14`、`apps/desktop/src-tauri/src/request_guard.rs:32`。

## 2. 已复现的现存缺陷

### F1 · P1：项目导出可返回成功，但缺少数据库仍引用的素材

定位：`apps/worker/src/project-service.ts:355`，特别是 371 行完成数据库备份后、374 行复制素材目录之间。实际入口为 `worker-commands.ts:144`；`project.export` 在 RequestScheduler 中属于后台方法，不阻止其他写入。

触发过程：

1. 启动项目导出，SQLite 快照包含一个正常图片素材。
2. 数据库快照完成、导出复制素材前，调用实际的 `ImageGenerationService.deleteAsset`。
3. 删除操作把图片移至 `cache/deleted-assets`，更新运行中数据库；已导出的快照仍将该素材标为未删除。
4. 导出继续复制 `assets`、`exports` 并返回成功。快照引用的图片已经移走，而其回收站文件不在此次复制范围内。

隔离测试在真实 SQLite 备份完成处设置异步屏障，使用真实素材软删除 API，确认导出库中 `deleted_at = null`、对应素材文件不存在，且源项目回收站文件仍在。测试通过，复现成功。测试中的屏障只控制时序，不替换备份或素材删除实现。

影响：导出包可能不可完整恢复。原项目没有因此丢失该回收站文件；问题发生在导出包的一致性。

建议：为导出定义数据库与文件的一致性视图，并在取得该视图期间保护文件移动/删除；采用冻结的素材清单、文件保留或快照机制，导出完成前检查引用文件和哈希。长文件复制移出主线程，不能简单持有写事务等待复制。

### F2 · P1：图片迟到结果会更新切换后的项目界面

定位：`apps/desktop/src/ProductionPanel.tsx:1058`、1099 行、1110 行及 1143 行。`generateImage` 在多个 await 后直接更新 preview、发布素材选择、更新成功消息并清空共享 job/busy，没有校验原项目、目标或提交身份。

触发过程：旧项目图片已完成或即将收到成功响应时切换项目，旧 Promise 随后完成。即使 Worker 已经阻止跨项目落库，前端仍可能消费已生成、延迟交付的旧响应。

隔离 UI 测试批准图片请求、挂起模拟响应，然后将同一面板从 `project/old-shot` 切换至 `next-project/new-shot`，最后交付旧项目成功响应。实际观察到 `onAssetsChanged([], 'asset-generated')` 和“图片已保存到本地素材库。”出现在当前界面。测试通过，复现成功。

影响：旧任务的素材选择、成功提示和 busy 状态进入新上下文。本次没有证据表明发生了跨项目数据库写入。

建议：所有提交捕获 project session、目标和 submission ID；每次异步返回以及 finally 更新前核验所属任务。视频路径虽已有部分 project ID 检查，仍需统一覆盖结果、错误和收尾；仅 project ID 也不能区分同一项目关闭后重新打开的新 session。

## 3. 放开并发前必须处理的约束

### B1 · P1：桌面端运行、轮询及确认状态仍为单实例

定位：`App.tsx:757`、799、1249、1270、1322、1550、1753、2372；`ChatPanel.tsx:285`。

- `nativeRunIsCurrent` 同时要求匹配唯一 native run 和当前选中的会话。直接启动第二个 run，会使旧 run 的回调被当作过期结果。
- `startAgentTaskEventPolling` 先停止上一项轮询；一个任务结束时也会停止共享轮询。
- `cancelGenerationForConversation` 和会话切换 effect 主动取消旧会话任务。
- 开始、结束和取消生成都会处理共享确认 resolver；新确认会把旧确认解析为 false/undefined。放开并发后，任务之间可能互相取消确认。
- `sendMessage`、ChatPanel 和后端事务均有单会话活动生成限制。它们是同一保护链，需要协调替换，不能只删除某一个判断。

改造要求：按 generation/task ID 管理运行集合、消息归属、观察器和终态；确认请求排队并绑定 task ID 与 token；选中会话只改变呈现。任务级停止不能清空其他运行的连接、输入或确认。

### B2 · P1：工具串行与 step 授权生命周期绑定

定位：`pi-conversation-runtime.ts:170`；`agent-provider-tool-gateway.ts:145`、178、214；`agent-provider-loop-service.ts:681`、860、1423、1907、3895、3907。

普通会话即使把只读工具声明为 parallel，仍受 Agent 全局 sequential 设置约束。已安装 Pi 的 `agent-loop.js:289` 确认：全局 sequential 或任意工具 sequential 会让该批次串行。

写入路径还有更深的约束：每个 Provider step 只允许一次主要文档、媒体准备或媒体提交调用；工具网关共享当前 definitions，执行结果会整体替换它；写操作完成会关闭旧 step 并创建下一 step，授权 handle 绑定 step。

因此，直接把所有工具改成 parallel 会使并发调用使用旧 step handle 或相互覆盖 definitions。此处为源码推导的改造风险，没有通过关闭保护实际执行写入。

改造要求：先开放相互独立的只读调用；跨任务采用独立授权。需要并行写入时，先明确每次调用/子任务的授权、目标与资源冲突范围，保留额度预留、调用去重、版本 CAS、审核和发布边界。

### B3 · P2：请求调度尚不是任务级有界调度

定位：`request-scheduler.ts:82`、103、117；`pi-conversation-runtime.ts:102`、285；`handler.ts:1810`。

后台方法直接运行，普通方法进入一个 Promise 尾链，没有任务容量、资源 key、公平排队或可查询的等待项。Pi 的 active Map 记录运行，也没有在该入口实施统一项目任务容量。网络层的 8/3 限制只保护实际外部请求，不能管理长时间等待确认、远端处理或本地计算的业务任务。

兼容的 `agent.generation.executeTools` IPC 未列入后台方法；旧调用路径若执行外网 research 并等待网络，会占住 mutationQueue。当前主要 Pi 路径直接调用工具服务，因此不能把这个兼容路径问题泛化成“所有 Pi 检索阻塞全局队列”。

改造要求：复用现有网络准入，在它上层增加持久化业务任务队列；分别计算运行任务和瞬时请求额度，超额任务可排队、取消、恢复。统一设置入口，不将各层额度简单相加。

### B4 · P2：小说批量函数没有接入当前入口，也没有章节任务依赖调度

定位：`apps/desktop/src/novel-chapter-batch.ts:9`、19、52；`apps/worker/src/handler.ts:1659`；`task-plan-service.ts:301`。

仓库全文引用检查显示 `runNovelChapterBatch` 只由自己的测试使用。当前 `agent.run` 进入统一 document/System Agent 工作流，由模型调用小说写入工具，不能以该辅助函数的测试作为产品批量执行已接通的证据。

现有 TaskPlanService 有依赖检查和步骤 CAS，可复用其规则，但它不能直接等同于跨多轮章节生成的队列。连续章节是否依赖前章、独立章节是否共享同一版大纲，必须成为明确的任务输入。

改造要求：从实际入口接通章节子任务；每章独立 identity、结果、取消和失败状态；按依赖释放任务，保留同章保护与保存版本校验。

### B5 · P2：配音整条链路串行，图片多结果下载也串行

定位：`dubbing-service.ts:254`、1079、1083、1112、1227、1239；`image-generation-service.ts:197`；`ProductionPanel.tsx:385`、402。

`executionTail` 包住配音任务的整个执行，包括远端请求和口型轮询。一个慢口型任务会让其他场次的配音/合成排在后面；同场多个片段也逐一等待。

单次多图结果逐张下载；制作面板持有一份 busy 和 job ID，图片完整执行期间按钮被锁。视频则在提交成功后进入 Worker 多任务轮询，现有行为不同。

改造要求：按网络生成、远端轮询、下载、本地 FFmpeg 分配有界容量；独立片段并发完成后按时间顺序合成。保持结果原子入库、文件补偿、冻结输入和不重复付费规则。

### B6 · P2：同步工作与上下文读取仍需单独设计

定位：`project-service.ts:323`、374；`library-search-service.ts:62`、181；`context-service.ts:71`。

- `cpSync`、同步 SQLite 与检索都在同一 Node Worker 线程。调度器允许异步请求并发，不会让这些同步工作并行；大项目复制期间仍会阻塞事件循环。
- 上下文编译直接取最近 12 条消息拼接内容，没有并行分支或消息截止点语义。放开同会话生成前，需要明确新任务是否可读取其他任务的未完成输出。

改造要求：按性能证据移出长文件处理或重计算，保留单写者和短事务；每项运行冻结自己的消息边界与所用资源版本。继续遵守按需检索，不自动注入章节或资料全文；检索句柄仍限定 task/attempt。

## 4. 可以直接保留的基础

- GenerationService 的幂等与持久化记录、按 generation ID 的运行集合。
- Pi 的 active/confirmation/media-selection Map，以及 Native Bridge 按 request ID 分流和序号检查。
- 文档基础版本与 rowVersion CAS、工具额度的事务预留、Provider call 去重和审核边界。
- 视频轮询的并发限制、退避、单任务去重、项目 session 检查；尤其迟到旧请求不会释放新 session 额度。
- Rust Request Guard 与开发 NetworkAdmission。两者属于不同传输路径，不能视作自动共享同一个跨进程预算。
- 现有 TaskPlanService 的依赖检查，可作为更大任务调度的组成部分。

## 5. 验证记录与边界

现有聚焦测试共 405 项通过，按文件串行运行，以避免机器负载造成计时测试误报：

| 范围 | 文件数 | 通过项 |
| --- | --- | --- |
| RequestScheduler、GenerationService、视频后台运行、Native Bridge、Pi、工具网关、配音服务 | 7 | 114 |
| App、ProductionPanel、llm-client、ChatPanel 进度、小说批量辅助函数 | 5 | 145 |
| AgentProviderLoop、媒体提交、项目检索 | 3 | 146 |

另有 2 项临时诊断测试分别成功复现 F1/F2，断言的是已观测到的缺陷行为，不代表修复通过。复现文件执行后已删除，不改变仓库原有测试集合。

运行命令：

```powershell
pnpm.cmd --filter @ai-video/worker exec vitest run src/request-scheduler.test.ts src/generation-service.test.ts src/project-task-runtime.test.ts src/native-provider-bridge.test.ts src/pi-conversation-runtime.test.ts src/agent-provider-tool-gateway.test.ts src/dubbing-service.test.ts --fileParallelism=false
pnpm.cmd --filter @ai-video/desktop exec vitest run src/App.test.tsx src/ProductionPanel.test.tsx src/novel-chapter-batch.test.ts src/llm-client.test.ts src/ChatPanel.progress.test.tsx --fileParallelism=false
pnpm.cmd --filter @ai-video/worker exec vitest run src/agent-provider-loop-service.test.ts src/media-orchestration-service.test.ts src/library-search-service.test.ts --fileParallelism=false
```

所有复现使用临时项目/模拟 Provider；配音已有测试使用本地媒体夹具。没有调用真实付费 Provider，没有修改用户项目，没有执行安装包或 Windows 原生界面的人工并发验收。本轮是审计，未宣称并发改造已完成，也未运行全仓发布门禁。

## 6. 建议的实施依赖顺序

1. 修复 F1/F2，先稳定导出一致性与异步结果归属。
2. 冻结任务身份、容量、资源冲突、依赖和取消语义，复用既有日志与持久化设施。
3. 改造前端多任务集合、后台观察和确认队列，再协调替换同会话单轮保护。
4. 开放独立只读工具并发，保持 step 授权及写入保护，随后接入独立资源的子任务。
5. 接通真实小说批量入口，拆分配音与媒体各阶段容量。
6. 验证交错输出、同资源冲突、队列取消、超额限流、项目切换、重启恢复和提交不确定状态，再执行全仓质量门禁。

以上为审计建议，尚未实施；涉及现有确认规则变化时，应先更新对应实施计划及已有 DOCX，而不能直接删除保护。
