# 2026-10-19 助理回复延迟审计

本次审计读取了当前开发工作区与本机项目 SQLite，未修改应用行为、重启应用或发起真实 Provider 请求。时间统一为北京时间（UTC+8）。数据库最后一轮运行已在 15:04:23 取消；下述结论针对这些已保存的运行。

## 结论及证据边界

Agent 链路存在任务关联错误、工具参数解析丢失错误、工具生成进度不可见等问题。全量工具 Schema 和增长的历史结果也增加了模型请求负担。没有证据证明本轮数分钟的停顿主要来自 Pi 并发容量队列。

不能仅凭数据库中的 `llm_provider_steps.started_at` 计算模型或调度耗时：它在步骤还是 `prepared` 时就写入，读工具还会让多个实际模型请求复用同一步骤。这里的“首段文字”是助手可见正文，不是网络首字节或模型首个 token。

## 最近运行

项目数据库：`C:/Users/MSI/Documents/xlngts/的撒法/project.sqlite`。会话：`93582228-e997-4285-8a6e-f1d3e5d87843`。Provider / 模型：UniCompAPI / kimi-k3，协议为 Chat Completions。

最新 generation：`3d457cd6-3ad4-4a91-ac4a-4f847fcf406e`，请求为“没有生成成功吗？”。

| 事件 | 时间 | 相对创建时间 |
| --- | --- | --- |
| generation 创建 | 14:56:41.401 | 0 |
| Agent 任务、Provider 步骤准备记录创建 | 14:56:41.417 | 0.016 秒 |
| `conversation.task.route` 成功记录 | 14:57:01.806 | 20.405 秒 |
| 首段可见助手文字落库 | 14:57:24.689 | 43.288 秒 |
| 五次 `library.search` 派发记录 | 14:57:32.510—32.538 | 51.109—51.137 秒 |
| 最后一次 `library.read` 记录 | 14:57:56.978 | 75.577 秒 |
| 用户取消 | 15:04:23.083 | 461.682 秒 |

最后一次读取至取消相隔 **386.105 秒（6 分 26 秒）**。这一轮用了 12/16 次业务工具预算，没有新的库读预算错误，也没有 `scene.submit_structure` 执行记录。助手正文末尾是“参数意外为空，重新完整提交：”。当前场次与镜头尚无生成成功的证据。

上一轮“重新生成场次与镜头提示词”（`e7f4be0b-6232-4c2c-a86d-2ea86c52dc26`）持续 168.415 秒后取消，首段可见文字等待 19.117 秒，也没有场次提交记录。

13:49:13—13:53:49 的成功运行（`24c66103-3658-4428-b8f3-fe405104d7b9`）持续 276.053 秒，依次保存了六份角色／场景文档。已记录步骤的输入 token 从 21,630 增至 49,613；部分请求有较高缓存命中，不能把全部输入量都当成未缓存计算量。

## F1 · P1：无效工具 JSON 被静默替换成空对象

- 位置：[native-provider-bridge.ts](../../apps/worker/src/native-provider-bridge.ts)，`applyPiEvent` 约 440 行、`parseArguments` 约 591 行。
- `JSON.parse` 失败或解析出非对象时，桥接层返回 `{}`，继续把消息作为正常 `toolUse` 交给 Pi。原始解析错误和参数长度均丢失。
- Native 的 `SseParser::finish` 只要求工具调用 ID、名称非空，未在这个边界验证参数 JSON。`LlmStreamEvent::ToolCalls` 也没有保留原始 finish reason；[lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 约 3260 行统一发送 `finishReason: "tool_calls"`。因此原始 `length` 等截断原因不能可靠传到 Agent。
- 若 Pi Schema 验证先拒绝空对象，调用尚未到 Worker 执行业务工具的位置，数据库可能没有对应 `agent_tool_calls` 记录。这会让模型反复修复，而审计端只看见长时间没有业务提交。
- 本地无网络复现：合法 `{"resourceId":"workspace:shots","scenes":[]}` 保持原样；不完整的 `{"resourceId":"workspace:shots","scenes":[` 被转换成 `{}`，结果仍为 `stopReason: "toolUse"`，没有 `errorMessage`。
- 与本次停顿的关系：与“参数意外为空”的正文相符，但未保存那次原始参数，不能据此断定本次一定发生了 JSON 截断。
- 建议：保留 finish reason；解析失败返回明确的、有界的结构化错误，记录调用名、参数字节数、解析失败和截断状态；限制同类修复重试，不把解析失败伪装成正常空参数。

## F2 · P1：任务候选摘要丢掉真实请求，且排除失败／取消任务

- 位置：[generation-service.ts](../../apps/worker/src/generation-service.ts) 约 1083—1097 行；[agent-system-tool-service.ts](../../apps/worker/src/agent-system-tool-service.ts) 约 358—376 行。
- 候选请求直接取 `substr(messages.content,1,240)`。真实消息前面有数千字的“本会话要求约束”，实际请求位于末尾的“用户本次请求”段。不同任务的候选前 240 字实际相同，模型看不到候选的真正任务内容。
- SQL 只列出 `prepared/streaming/complete`，上一轮已取消的场次生成任务不会成为候选；`follow_up` 执行又仅接受 `complete`。
- 本次已发生错误关联：模型解释说在跟进“重新生成场次与镜头提示词”，实际 `targetGenerationId` 却是 `2b15b99b-253e-4690-bf06-bc87ac66f046`，对应最初的“我现在要制作短剧，先讨论一下大纲”。工具返回的旧摘要还说项目没有文档、场次和镜头。这会污染后续判断并增加重复检索。
- 建议：在输入时分别保存会话约束和本次请求，候选传递真实请求、状态、时间与产物摘要。允许模型识别并查询失败／取消任务的结果；是否继续执行应使用明确规则，不能把失败任务当成功依赖。继续由 LLM 判断语义关系，不增加关键词路由。

## F3 · P2：每轮全量工具 Schema 与历史结果占据大量输入

- 位置：[agent-provider-loop-service.ts](../../apps/worker/src/agent-provider-loop-service.ts) 的 `authorizationSpecsForTask`（约 4509 行）；[agent-provider-tool-gateway.ts](../../apps/worker/src/agent-provider-tool-gateway.ts) 约 88 行；[llm_stream.rs](../../apps/desktop/src-tauri/src/llm_stream.rs) 的 `build_request_body`（约 1380 行）。
- 从本轮授权 operation 匹配实际工具定义，得到 60 个工具；其原始定义 JSON 合计约 63 KB，仓库估算器估计约 15,910 token。该数值不是 Provider 实际 tokenizer 的精确计数，也不包含全部请求封装。
- 其中 `scene.submit_structure` 单独约 23.7 KB，`production.execute` 约 11.5 KB。普通查询、路由和读取阶段也携带这些 Schema。
- 本轮第一步骤 Provider 报告实际输入 21,824 token；成功运行后期为 49,613 token。`project.structure.get` 本轮返回摘要达 29,943 字符。Chat Completions continuation 会重发历史工具调用及结果，后续输入持续增长。
- 这能证明请求负担较重，不能仅凭 token 数推导具体延迟秒数。上下文面板的编译结果估算也不能代表最终带工具和 continuation 的总请求量。
- 建议：由模型选择有界工具集合并按需展开 Schema；合并重复 Schema 结构，裁剪已处理的历史工具结果，结构查询默认返回紧凑索引、按需展开。保留授权、CAS、审核及按需检索边界，不自动注入资料正文。

## F4 · P2：工具参数生成期间缺少真实流式进度

- 位置：[llm_stream.rs](../../apps/desktop/src-tauri/src/llm_stream.rs) 约 2160—2207 行、1330—1355 行；[lib.rs](../../apps/desktop/src-tauri/src/lib.rs) 约 3215—3265 行；[pi-conversation-runtime.ts](../../apps/worker/src/pi-conversation-runtime.ts) 约 246—273 行。
- Native 持续累积 `delta.tool_calls.function.arguments`，直到响应结束才发送 `ToolCalls`。随后一次性制造 `tool_call_start/delta/end`，Pi 的 `liveActions` 又要等到 `beforeToolCall` 才出现。
- 因此生成四场、十几个或二十多个镜头的详细结构化参数时，界面可能长时间没有新增正文，也没有“正在生成工具参数”的进度。业务执行不能提前开始，但进度可以提前显示。
- 建议：传递工具名、累计参数字节数、最后接收数据时间等安全进度；完整参数通过验证后才允许执行。区分模型思考、生成参数、等待网络、执行工具和等待用户确认。

## F5 · P2：计时模型无法区分调度、网络与实际模型轮次

- 位置：[agent-provider-loop-service.ts](../../apps/worker/src/agent-provider-loop-service.ts) 的 `createStep`（约 3646 行）、`startProviderStep`（约 3400 行）；[pi-conversation-runtime.ts](../../apps/worker/src/pi-conversation-runtime.ts) 约 135—136 行、316 行。
- `createStep` 在 `prepared` 状态写入 `started_at`；实际入场后的 `startProviderStep` 只改状态，不更新或另记实际开始时间。不能用“创建后 16 毫秒出现 Provider 步骤”证明容量队列只有 16 毫秒。
- 只读检索会复用授权步骤。本轮 ordinal 1 覆盖了多次模型继续与读工具，不能把它从 14:57:01 到 15:04:23 的持续时间当成单次网络请求时间。步骤的 `request_hash` 还是工具 Schema 版本哈希，不是最终请求体哈希。
- 部分库工具审计的 `started_at/completed_at` 使用执行前同一个 `now`，两者相等也不能证明真实执行耗时为零。
- Pi 容量上限为全局文本 4、同项目 2；入口先等依赖再申请容量，读取后的常规继续不会重新申请 Pi 容量。Native 默认网络准入排队超时 10 秒，但每次请求的准入等待没有独立持久化指标。
- 建议：每次实际模型请求单独记关联 ID、排队起止、依赖等待、网络准入、请求发送、响应头、首字节、首正文、参数累计、响应结束、工具执行和错误／取消。不要让授权生命周期替代请求生命周期。

## F6 · P2：Pi 的推理／输出设置没有透传到 Native 请求

- 位置：[pi-conversation-runtime.ts](../../apps/worker/src/pi-conversation-runtime.ts) 约 241 行、620—629 行、716 行；[native-provider-bridge.ts](../../apps/worker/src/native-provider-bridge.ts) 约 358—379 行；[llm_stream.rs](../../apps/desktop/src-tauri/src/llm_stream.rs) 的 `build_request_body`。
- Pi 配置 `thinkingLevel: 'off'`，模型元数据配置 `maxTokens: 16_384`，但 Native resolver 未使用传入的模型和 SimpleStreamOptions 去映射这些参数，Native 请求体也没有相应的推理控制或最大输出字段。
- 所以界面／运行时中的这些值不能证明远端实际关闭推理或应用了 16K 输出限制。没有线上的完整请求证据，不能据此断言 kimi-k3 开启了推理或将其认定为本次耗时根因。
- 建议：按真实 Provider 协议能力显式映射并验证配置，记录有效设置；不支持的设置应明确标记，不作无效承诺。

## 次要问题：相同文本快照反复同步写库

[pi-conversation-runtime.ts](../../apps/worker/src/pi-conversation-runtime.ts) 约 642—646 行对助手 `message_update/message_end` 调用 `observe`；[generation-service.ts](../../apps/worker/src/generation-service.ts) 约 513—535 行没有内容相同的提前返回，并直接同步保存消息、attempt、generation、会话与项目时间。旧流式路径已有 250 ms / 512 字符合并，Native 路径未复用。

隔离临时项目复现：100 次完全相同的 `observe` 令 generation version 从 1 增至 101，耗时约 70 ms，没有网络请求。它是确定的多余写入，但该实验不支持它解释本轮数分钟的延迟。流式中资料索引同步会走删除路径，不是每次重建整篇正文索引。

## 建议实施顺序与验证

1. 优先修 F1 参数／finish reason 错误处理，并补 F5 每次真实请求的观测。以截断 JSON、输出到上限、解析失败与取消测试验证，避免无反馈的修复循环。
2. 修 F2 候选摘要和失败任务追问；用“长会话约束 + 不同实际请求 + 上一轮取消”的回归场景验证。保留 LLM 语义判断。
3. 缩减 F3 请求负担并补 F4 参数流进度；通过相同任务的真实请求轮数、输入量、首段文字和完成耗时作前后对照，不能只比较界面体感。
4. 补齐 F6 有效模型参数传递；随后处理相同快照写入的合并。

本次验证包括真实 SQLite 只读核对、工具定义体积测量、桥接层无效 JSON 模拟、隔离项目相同快照写入实验。没有修改功能代码，因此未把之前资料读取预算修复的全量质量门禁当成本次审计的验证，也未进行付费端到端重跑。

## 2026-10-19 修复实施补充

以上保留为修复前审计。实施与验证见 [Agent 参数链路与延迟修复](../AGENT-PIPELINE-REMEDIATION-PLAN.md)。F1 已在 Native 和 Pi 桥接层拒绝无效对象 JSON/截断输出，执行前校验失败有界记录、最多连续三次，含工具加载入口；失败不会被后续 complete 事件改记成功。F2 分存真实请求与会话约束，候选包含终态，inspect 查询真实产物而不建立成功依赖。相同快照不再反复写库。

F3 普通会话由模型按需加载 Schema；默认结构查询仅返回 resourceMap，历史仅替换有后续全文的完全重复结果。在相同的 system + library + media + research 定义样本中，61 个工具 JSON（只计 name/description/parameters）为 86,196 bytes，初始五个定义为 11,507 bytes，减少 86.65%。这是离线 Schema 体积对比，不是线上 token 或耗时对比。

F4/F5 增加每请求身份和真实 Native 阶段，含网络准入、发送、响应头、首字节与参数累计；实际请求体仅记 hash/长度。取消、重启恢复、请求 ID 归属冲突及旧会话事件有隔离回归。F6 仅对已启用/验证且声明正确字段的合同传递输出上限；未知能力保留 Provider 默认，未声称远端已关闭推理。现有项目/应用并发上限与 24 轮保护保留。

真实 Provider 请求数为 0，未改写上述用户项目、安装或重启运行实例。原运行数分钟停顿的确切远端原因仍受原审计证据限制；新版日志用于下一次实测区分调度、网络与模型输出。

后续截图补修：新版首轮在 Rust host 前置白名单处以 INVALID_PARAMETERS 拒绝 inferenceSettings，约 4 ms 即失败，尚未入网；此入口在首次实施时遗漏。已补齐并共用嵌套设置验证，新增真实 Worker 信封→Rust 入口→请求体回归，两协议通过。详见修复记录末节；不能把最初分层测试通过当作已覆盖这个入口。
