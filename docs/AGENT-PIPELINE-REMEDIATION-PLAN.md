# Agent 参数链路与延迟修复

依据 2026-10-19 的回复延迟及场次结构化链路两份审计。保持按需检索、LLM 语义路由、本地 SQLite、真实 ID、CAS、审核及现有并发限额。

## 不变量与所有权

- 不完整 JSON、非对象参数、截断及失败终止不得执行业务工具；错误不回显正文。
- 参数校验在执行前有界失败并留下任务所属项目的审计记录；重复失败有独立上限。
- 新建与绑定更新分别验证；结构和正文不得静默相互覆盖，旧版已存指令继续可读。
- 分段创作属于当前项目的提案，只有最终完整提案可审核；批准前不写入场次与镜头。
- 每次模型请求独立关联 generation/attempt/project/session，进度只含阶段、工具名、字节数与时间；禁止持久化请求正文、凭据。
- 候选任务显示真实请求与终态；失败/取消可以引用，不能充当成功依赖。
- 工具按模型选择加载，授权仍由 Worker 独立验证；原始请求、生产约束不因裁剪丢失。

## 状态与失败矩阵

请求：queued → admitted → sent → headers → receiving → complete/failed/cancelled。参数生成进度不代表执行；工具校验失败不改变业务状态。提案：staging → finalized；同键同内容幂等，不同内容冲突，重开可继续。

| 场景 | 行为 |
| --- | --- |
| JSON 损坏/输出到限额/协议未完成 | 明确失败，保留有界原因和参数长度，零业务执行 |
| Schema 缺字段 | 返回路径和原因，记录拒绝；达到修复上限终止 |
| 关闭/切换/取消/迟到事件 | 原身份检查，落盘终态，不写入新项目 |
| 同键重复提交/进程重开 | 复用已存分段，最终合并一次提案 |
| 容量/渲染长度超限/正文冲突 | 提前拒绝并指出路径，不部分写入 |
| 旧项目迁移 | 原子迁移；未完请求恢复为失败，现有正文不改写 |

## 实施与验证清单

- [x] P1：Native/桥接参数及结束原因；有界校验、审计与修复上限。
- [x] P2：统一场次入口、正文冲突、绑定保留、总容量与分段提案。
- [x] P3：任务请求/终态关联；重复快照与写入合并。
- [x] P4：模型选择工具加载、紧凑结构与历史结果控制。
- [x] P5：每请求观测、参数流进度与有效推理/输出设置。
- [x] P6：回归、全量质量门禁及证据。

追踪：P1 对应两报告 F1 与结构 F2；P2 对应结构 F3/F4/F5；P3 对应延迟 F2 与快照问题；P4 对应延迟 F3；P5 对应延迟 F4/F5/F6 与结构 F6。各阶段完成后在本文件记录实际运行的验证，真实 Provider 验收另列，不将离线测试称为线上耗时改善。

## 实施证据

P1：Native 验证 JSON 对象和结束原因，桥接不再以空对象吞掉解析错误。Pi 执行前错误去除参数回显，最多 1,600 字符，连续三次校验失败终止；普通、计划及工具加载入口使用相同边界。审计仅记操作、参数字节数和有界原因。Native 桥接 33 项及 Rust LLM 38 项聚焦回归通过；SQLite/Pi 集成验证业务执行为零、审计三条且无正文泄漏。

P2：模型工具与 Worker 共用场次/镜头结构合同；保留旧 v1 读取。已有场次按真实 ID/CAS 做绑定更新，缺省正文取当前版本；冲突的结构和手写文本明确拒绝。预检总场镜条目 100、单项渲染 20,000 字符。`scene.structure.stage` 持久化共享场次与每批最多四镜，支持列出/读取缺项、同键幂等、版本冲突、取消后重开项目续写、一次生成待审核提案。批准前零场次/镜头写入，批准后验证真实父子 ID。分段任务使用已有硬上限 32 次工具调用，普通默认仍为 16；过大任务下轮续写，不改变 24 轮保护。

P3：分开保存真实请求与会话约束；旧数据兼容解析固定 UI 包装。候选包含真实请求、状态、创建时间与提案数量；`inspect` 查询失败/取消产物，不建立成功依赖。仅成功任务允许 follow_up，终态任务不接受 supplement。100 次相同观察不增加 generation version，流式增量复用 250 ms / 512 字符合并，终态完整保存。

P4：普通会话固定保留路由、目录和检索；模型从有界目录选择最多六个工具加载 Schema，Worker 授权仍独立复验。计划执行保留冻结 grant。结构目录默认 resourceMap，显式 full 才展开；历史仅合并超过 2,000 字符且完全相同、后续仍有全文的结果，不裁剪唯一约束或正文。网关覆盖初始 Schema 小于全量的 60%、无越权加载；章节并发及 search→read→写草稿集成已按真实加载流程通过。

P5：Schema v58 独立记录每次请求的 generation/attempt/project/session 身份、排队/发送/响应头/首字节/首文本/参数进度及终态。最终 Native 请求体只存 SHA-256 和字节数。请求 ID 冲突、取消后的迟到事件、旧项目会话均有隔离测试；参数校验失败不得记录为请求成功。工具审计按实际执行采样起止时间，重复进度 500 ms 合并。输出上限只使用已启用/验证合同声明的协议字段及数值约束，未知能力保留 Provider 默认，reasoning 明示 provider_default，不将 Pi thinkingLevel=off 当成远端已关闭推理。桥接、设置和请求归属回归通过。

迁移：v58 故障注入验证新表/新列整体回滚、旧项目记录保留、重试与重复迁移稳定。新增自动化均使用隔离临时项目；未改写用户运行时项目。

协议依据：[Responses create](https://developers.openai.com/api/reference/resources/responses/methods/create)、[Chat Completions create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)。字段名称不作为第三方模型已支持该能力的证据，仍以所选合同声明为准。

## 最终验证（2026-10-19）

- `pnpm test`：1,592 项通过。Context 8、Contracts 24、LLM 32、Desktop 489、Generation Adapters 139、Persistence 75、Worker 825；无未处理拒绝。桌面章节发送回归等待刷新完成，避免测试结束后异步回调使用下一用例的 mock。
- `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check`：通过。Vite 仅保留既有主包超过 500 kB 的体积提示。
- `cargo fmt --check`、`cargo check`、`cargo test`：通过；Rust 160 项通过、1 项既有忽略，保留既有 unused_variables 警告。
- `pnpm worker:sidecar`：通过；`node apps/worker/scripts/validate-llm-intent-sidecar.mjs` 八组通过（两协议 × 两入口 × 有/无 UI hint）。直接调用授权工具验证真实本地提案、审核、场景文档绑定及场镜父子关系，不模拟线上耗时。报告：`C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-RKmkhL/report.json`。Worker SHA-256：`54C8C2BC0C66B18AD147D16E4AF1D452D6FE55532E6FA2A9A8E497450CA41C51`。
- 工具体积实测：相同 system/library/media/research 样本，共 61 工具，移除授权字段后定义 JSON 为 86,196 bytes；初始路由/结构/检索/加载五定义为 11,507 bytes，减少 86.65%。只比较 Schema 字节，不包括完整系统提示、历史及 Provider 封装，不宣称 token 或秒数变化。

本轮没有真实 Provider 请求、没有安装或重启用户运行实例。已构建生产 Worker；真实 Provider 对完整长方案的成功率、首字节、首正文与完成耗时，需要在新版运行时按新增请求日志测量。审计中的历史事实保持原样，实施补充链接到本记录；不将离线验证冒充线上改善。

## 2026-10-19 Native 入口遗漏补修

用户新版截图暴露 `Native Provider params contain an unknown field`。只读核对项目“很难改变风格”的 generation `9aa72c06-489c-4985-825f-fa0ad64409b1`：09:28:17.171 UTC dispatching，09:28:17.175 failed，错误码 INVALID_PARAMETERS，实际设置 maxOutputTokens=16384 / max_tokens / provider_default；没有 native_queued 或 sent 阶段。原因是 Worker 和 llm_stream.rs 已支持 inferenceSettings，但 lib.rs 的 provider.stream.start 前置白名单漏加该字段，请求尚未到网络阶段即被拒绝。此前 1,592 项与 Rust 160 项通过的记录真实，但测试未覆盖这一跨语言入口，不能据此称完整 Native 链路已验证。

- [x] lib.rs 允许 inferenceSettings；嵌套结构仍严格拒绝未知字段、缺项、错误类型、非正/超限值和协议错配，不放松敏感数据检查。
- [x] 入口校验与请求体构建共用同一设置验证逻辑，避免重复规则再次漂移。
- [x] 新增实际 Worker NativeProviderBridge/createPiStreamFunction 信封 → Rust 前置校验 → 真实请求体构建回归，覆盖 Responses 与 Chat Completions；直接合同覆盖 max_output_tokens/max_tokens/max_completion_tokens、未提供设置的旧请求和非法设置。

修改 Rust 源码后，用户已运行的 Tauri 开发模式监视器自动编译并重启了桌面进程；未手动终止进程或操作用户项目。未自动重发失败任务，未进行真实 Provider 调用。

补修验证：Rust 全量 163 项通过、1 项既有忽略；其中 Native host 合同 4 项含真实 Worker 跨语言信封。Worker 桥接 33 项通过，cargo fmt/check 及 git diff --check 通过。此前生产 sidecar 八组验证止于 Worker 工具调用，没有经过 Rust host 入口；本次新增测试明确覆盖该遗漏边界。

## 2026-10-20 会话参数失败恢复

用户确认实施只读诊断后的方案：严格拒绝损坏参数，增加有上限的自动修正、场次分段恢复和明确的保存状态。现场任务 `73009096-455f-4b4a-abf2-695963e5e2ee` 的 8 次资料/配置调用成功；最后 18,610 bytes 参数在 Native JSON 对象校验失败，未创建场次、镜头或方案。结束原因是 tool_calls，不能认定为 token 限额截断。历史原始参数未保存，不能确定模型、转发或拼接哪一处损坏。

### 不变量、状态和所有权

- 恢复属于原 generation/attempt/project/session/conversation；保留原请求、约束、成功工具结果和真实 ID，不创建第二条用户消息或重复任务。每次实际 Native 请求仍独立审计，失败请求保持 failed。
- 仅已明确声明“该响应没有工具执行”的 JSON 对象错误和 length/max_tokens/max_output_tokens 终止允许恢复。单个 generation 合计最多两次自动修正；既有 Schema 修复次数、24 轮和业务调用上限继续生效。不自动修复网络中断、鉴权、内容过滤、未知失败或业务写入失败。
- 状态为原任务 running → 参数拒绝/审计 → repairing_tool_output → running → complete/failed/cancelled。最终重复失败用 TOOL_OUTPUT_REPAIR_LIMIT 结束；关闭/切换/取消后不发起恢复请求。崩溃/重开仍由现有 generation 终态恢复处理，分段数据按原会话保留。
- 场次失败只加载 Worker 已授权的 scene.structure.stage；先查现有分段，再按最新 stageId/rowVersion 续写。新创作建议每批一到两镜；已有场次修订保留 sceneId/CAS，仍可加载原更新入口，不能改成新建。
- 保持 2026-10-19 已确认的自动保存要求（见 PRODUCTION-EXECUTION-IMPLEMENTATION-PLAN.md）：完整结构经原服务校验后直接写可编辑草稿，无需新增审核。只有真实 scene_structure_saved 返回才记录保存成功；暂存分段不等于完整场次已保存。
- Native 只增加 JSON 错误类别和行列号，不记录或回显失败参数正文。UI 以真实 read 引用判断“资料已读取”，不把请求结束误作读取成功；明确显示自动修正、保存成功、失败提交未执行及已有草稿/分段保留。

### 顺序清单与验证追踪

- [x] R1 参数恢复与分段续写：两协议 Native → Pi → 真实 SQLite 集成验证，第一次整包损坏、第二次分段参数损坏后恢复，只读取一次资料、保存一次场次/镜头和审计方案；错误正文不进入审计。重复 JSON/输出限额失败最多三次请求，网络/鉴权/过滤/旧会话错误不自动重试；取消边界零新增请求。已有场次绑定修订恢复后保留原 ID 和提示词。
- [x] R2 结果反馈：区分修正进行中、已读取资料、场次保存和未执行的失败提交，保留已保存草稿提示；Native 诊断只有类别/行列。恢复集成 18 项、运行时 13 项、桥接 33 项、网关 14 项以及 Desktop 会话 33 项全部通过；覆盖保存后继续失败、缺少读取证据时不声称已读、恢复期间可取消。
- [x] R3 最终门禁：全仓 1,626 项通过（Context 8、Contracts 24、LLM 32、Generation Adapters 139、Persistence 75、Desktop 510、Worker 838）。typecheck、lint、format:check、build、Rust fmt/check/test、git diff --check 通过；Rust 163 项通过、1 项既有忽略。只保留既有 Rust 未用变量和 Vite 主包超过 500 kB 提示。

已重建生产 Worker；`validate-llm-intent-sidecar.mjs` 八种组合通过，两协议各覆盖两入口与有/无 UI hint，真实本地保存/场镜父子关系及绑定正确，providerRequests=0。报告：`C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-pr93HK/report.json`。这组打包验证直接调用 Worker 工具，参数损坏后的 Native/Pi 恢复由上述两协议集成与 Rust 解析测试覆盖，不把直接工具调用当作真实模型输出验收。未手动重启用户正在运行的开发版；重新打开开发版后加载新 Worker。

所有集成模型响应均为模拟；未重发用户失败任务、未请求真实 Provider、未更改用户运行时项目。真实模型生成成功率与耗时仍需新版运行时实测。

## 2026-10-20 结构关系与完成状态补修

现场 generation `c7a8d357-61f7-413c-b6e0-dacee5918508` 与此前 JSON 损坏不同：参数可解析，但依次遇到 stillFrame 缺失、重复提示词与 instruction 冲突，以及角色/场景资料被放入连续性前置依赖；16 次额度耗尽、无新增场次，任务仍 completed/read-only。此前恢复只覆盖解析失败，无法解决这些契约和业务关系问题。

- [x] 场次/镜头前置关系仅接收真实场次/镜头；资料使用现有引用字段。新创作只提交 instruction，工具 Schema 与 Worker 同时拒绝重复正文；已有场次更新保留真实 ID/CAS。
- [x] 草稿保存与制作就绪分开；跨对象连续性问题随草稿保存并返回有界摘要，生成前仍拦截。结构、ID、CAS、循环及容量错误继续拒绝，事务保持原子性。
- [x] Gateway 将业务 rejected 结果作为 Pi 工具错误，计入有界修复；新创作出错后加载已授权分段工具，已有场次修订保持原入口。额度耗尽不能正常结束。失败事件不再记工具成功；有未解决的场次/制作写入失败或未完成分段时禁止 completed/read-only。
- [x] 两协议覆盖修复成功及 Schema/业务/分段未完成后的真实失败终态；跨分段状态、重开草稿及生成拦截通过。最终全仓 1,643 项、Rust 163 项（1 项既有忽略）与类型/静态/格式/构建门禁通过，生产 Worker 重建及打包八组合通过；未调用真实 Provider。

实现顺序、规则与详细验证见 [制作执行实施计划](./PRODUCTION-EXECUTION-IMPLEMENTATION-PLAN.md#2026-10-20-创作契约与草稿制作就绪状态)。当前为开发阶段，不为测试资料新增复杂迁移；本次复用项目 SQLite 的现有 JSON 存储，无需清库。打包报告：`C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-sgmUiI/report.json`。

## 2026-10-20 连续读取授权与制作修订预算

现场 generation `beeab9da-afda-47dc-9c4b-679d21c7e557` 出现七次读取授权重放拒绝，最后一次 Provider 连接失败（Windows 12029）。读取授权固定一次、只读步骤却不结束，重新加载 Schema 不能续发授权。失败前两份角色草稿已保存，相关场镜指令仍是旧版。

- [x] A1：系统只读工具每响应最多八次授权；Pi 冻结同组授权，全部工具完成后由 Worker 结束旧步骤、核验只读调用并签发下一步授权。跨项目、TTL、旧步骤重放、写工具单次使用及任务总额度继续校验；耗尽或过期的授权不再返回。工具加载不签发权限。
- [x] A2：实际执行 scene.read / production.read / production.execute 时，将默认 16 次的制作任务提升到已有 32 次硬上限；显式更小额度不变。仍保留 24 轮保护、检索独立上限和超额失败，不根据用户文本关键词扩权。模型指令说明批量读取、最多 30 操作的制作清单、保留手工修改与断点续作。
- [x] A3：两协议 Native 桥接 → Pi → Worker → 隔离 SQLite 覆盖同工具八次并行读取后继续七次读取、19 次业务调用及原对象批量更新，六次模拟模型响应完成，无新增付费任务。直接 Worker 回归保留过期、旧句柄、跨项目、保护操作和额度拦截；聚焦四文件 183 项通过。
- [x] A4：全仓门禁、生产 Worker 重建和打包离线验证。`pnpm test` 全仓 1,650 项通过（Context 8、Contracts 24、LLM 32、Generation Adapters 139、Persistence 75、Desktop 513、Worker 859）；typecheck、lint、format:check、build、git diff --check 通过。Rust fmt/check/test 通过，163 项通过、1 项既有忽略；仅保留既有 Rust 未用变量及 Vite 主包体积提示。

生产 Worker 已重建，SHA-256：`5C7F70B5E37269F449D6D063F7DBF8DD4FA2EC2716204EB6567D11E938C468E8`。`validate-llm-intent-sidecar.mjs` 八种组合通过（两协议 × 两入口 × 有/无 UI hint），验证真实本地保存、场镜父子关系及资料绑定，providerRequests=0。报告：`C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-x6nrOD/report.json`。打包验证直接调用 Worker 工具；跨响应读取授权和 19 次业务调用由 A3 的两协议模拟 Native/Pi 与真实 SQLite 集成覆盖，不将离线结果当作真实模型成功率验证。

本轮未重发用户失败任务、未调用真实 Provider、未更改运行时项目资料，也未手动重启用户开发实例；重新打开开发版后加载新版 Worker。制作指令过期提示及修订入口见 [制作执行实施计划](./PRODUCTION-EXECUTION-IMPLEMENTATION-PLAN.md#2026-10-20-资料变更后的制作指令修订入口)。

不自动重试网络错误、不清空项目、不重发失败的真实任务。Windows 12029 的实际代理／网络／服务入口原因仍需运行环境证据，不能以本地测试通过代替网络已恢复。

## 2026-10-21 缓存前缀与整任务用量统计

只读诊断 generation `451db9f6-577a-4419-a380-966c817b338c`：四次不同响应的 input/cached 分别为 9,150/2,048、16,196/2,048、17,563/15,360、22,647/17,408；合计 65,556/36,864，缓存占输入的 56.2%。业务步骤中同一响应可重复出现，工具加载响应又可能没有业务步骤，不能按步骤直接求和。原任务和全局用量索引只保存最后一次响应。动态任务列表位于固定策略之前、工具加载后追加策略，也会改变可复用前缀。

- [x] C1 固定规则前缀：动态任务候选与可选 UI 目标提示移到冻结目录／会话上下文之后；首个请求前按已授权工具建立策略，Schema 继续由模型按需加载，Worker 授权校验不变。不自动注入资料正文，不调整已确认的检索规则。
- [x] C2 整任务统计：在实际 Native 请求边界按独立 requestId 接收 Provider 用量快照。同请求重复快照不重复累加，部分字段更新保留此前字段；工具加载、只读、多工具响应、输出修正及失败前已报告用量统一累计。每次更新立即保存 attempt，取消中的迟到用量保留取消状态并更新索引；项目／会话／attempt 身份继续隔离。Provider 未报告用量时保持未知，不用 Pi 默认零值冒充报告。不改写历史记录，不保存请求正文或 Provider 原始用量载荷。
- [x] C3 聚焦验证：三文件 71 项通过。两协议的 24 请求集成合计 51,600 input / 2,760 cached，覆盖工具加载与输出修正；首次修正前的 22 次系统提示逐字一致。桥接覆盖成功／失败／取消／缺失报告、重复和部分快照、无 responseId，以及同响应两个工具只累计一次；任务、SQLite 消息及用量索引一致。重开恢复保留已报告用量和精确十进制费用。
- [x] C4 全仓质量门禁：`pnpm test` 1,696 项通过（Context 8、Contracts 39、LLM 32、Desktop 518、Generation Adapters 139、Persistence 75、Worker 885）；`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check` 通过。只保留既有 Vite 主包超过 500 kB 提示。此次无 Rust 修改。

生产 Worker 已重建，SHA-256：`6C7DA3ED5C3135C4EADCA6785617635316EF5715E8420AB34E54E530E192BAFB`。打包离线验证八组通过（两协议 × 两入口 × 有／无 UI hint），`providerRequests=0`；报告：`C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-gyRa8Q/report.json`。未手动重启用户应用；重开后加载新版 Worker。

实际缓存是否命中仍取决于后续请求的完整前缀、Provider 缓存策略及路由；离线验证只能证明请求组织与统计正确，不能证明线上命中率提升。本轮不进行真实 Provider 调用或重发用户任务。Windows 12152 流读取失败属于另一问题，本次不宣称已修复。
