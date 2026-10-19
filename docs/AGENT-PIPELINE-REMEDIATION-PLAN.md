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
