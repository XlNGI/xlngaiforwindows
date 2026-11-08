# Agent 检索与目录上下文体积修复

日期：2026-11-03。用户确认实施，不做用户输入字数或 Token 限制，不截断用户原文及会话要求。移除原有主请求 10 万字、会话要求和单条补充 2 万字、补充累计字数与条数上限，以及用户聊天消息保存上限。

## 设计与顺序

截图对应任务 `171f71b8-0ed9-4553-864a-c4403ed2d837`：用户请求 63 字，会话约束 6,836 字。失败请求估算系统 7,806、工具 6,390、用户输入 6,596、历史 26,110、其他 594，共 47,496 Token。窗口为 64,000 保守回退；最后 project.structure.get 返回 72 项元数据，续轮增加约 8,700 Token，没有发生整理。失败请求未发送供应商。

1. 结构工具默认小页返回，按 workspace、kind、parentId、query 筛选；筛选在分页之前，能够定位旧预览边界之外的资源。续页保留完整项目 revision，改变后明确拒绝，按实际返回条数推进 nextOffset。只限制单个工具结果大小。
2. 旧 library.search 可省略非约束摘要，保留句柄、来源、版本、草稿/正式状态和范围；使用省略内容前重新 read。旧项目目录用无损列/行表示消除字段名重复，保留真实 ID、父子关系与行版本。保留最近两份结果、错误、约束、用户消息、补充及图片。
3. 每次请求自动整理可以安全重读的旧证据及已保存进度，无任务级整理次数上限。请求余量不足时自适应缩小本次输出预留，并同步实际 Provider 参数；不放大未知模型窗口。不足以容纳必要上下文时明确报告物理窗口不足，完整输入和保存进度保留，不要求用户删减输入。
4. 两协议验证结构配对、Responses 新链重建、图片恢复、补充和当前版本 CAS；运行聚焦与最终门禁并记录结果。

输入长度校验改为保留字符串类型与必填校验；会话要求保留版本冲突和项目隔离，补充保留幂等、顺序与活动任务检查。传输信封和模型实际上下文窗口仍按真实容量处理，不伪造无限容量。

项目 schema v73 重建会话要求表，移除 SQLite 原有 20,000 字 CHECK；完整复制旧内容、版本和时间，恢复项目隔离触发器、索引及级联删除。测试覆盖 v72 升级、幂等、失败事务回滚与长文本保存。原迁移不改写，新版本按标准项目升级流程生效。

项目正文仍按需读取，草稿/正式同库且显式标记，附件不自动入检索库，索引保留在本地 SQLite。不修改真实项目/设置数据库，不重发历史任务、不调用真实 Provider、不手动重启应用。

## 检查清单

- [x] R0 审计、修改前备份与设计。
- [x] R1 先新增分页/筛选/版本冲突、双协议历史整理及输出适配失败回归。修改前 6 项失败、21 项通过，日志 `C:/Users/MSI/AppData/Local/Temp/agent-context-size-repro.log`。
- [x] R2 实现工具返回收缩，验证旧边界外定位、字节边界和 CAS。3 项资源分页测试通过；两协议真实系统工具→Pi→Native 模拟 Provider 测试逐页取得同一场次 25 镜，跨越旧 20 项边界，保持原始请求及所有真实 ID/行版本。
- [x] R3 实现安全整理与输出适配，验证长任务自动续接、用户要求和图片完整保留。预算 29 项通过（包含非约束搜索摘要、目录无损解码、最近结果/错误/约束保护）；两协议长输入＋三图 Native/Pi 测试通过，实际输出参数与预算诊断一致。不增加输入限制，不缩小未知窗口的协议余量，不伪造模型容量。
- [x] R4 聚焦与全仓 test/typecheck/lint/format/build、生产 Worker 构建已执行并记录实际结果与生效条件；lint/format 的既有失败保留在下方，不宣称全仓门禁全绿。

单个资源的定位数据若独自超过目标页字节数，保留完整定位而单独返回，不截断字段或让 nextOffset 停滞。结构工具分页之前筛选，默认目标为 20 项/8,000 字节。历史整理不改变实际数据库、审计历史或用户原文。

## 只读体积对照

对截图项目的当前资源执行只读编译，未重发失败任务。旧默认目录返回 72 项，约 29,739 字节、7,849 Token；新默认页实际返回 17 项，信封约 8,201 字节、2,182 Token，目录 Token 估计减少约 72%。显式筛选 `kind=scene` 后为 2 项、约 1,058 字节、278 Token。分页仍能继续取得剩余资源，原始 ID、父子关系、版本和 CAS 不丢失。以上是目录结果的估计值，不代表整个请求固定减少相同比例。

目录工具描述也保持紧凑，参数范围由 Worker 严格校验，避免工具 Schema 本身抵消分页节省。两协议旧长资料集成回归验证可重读正文整理及续接；Responses 测试同时读取整理后重建的新链证据，覆盖原 continuation 被移除的路径。

## 验证记录（2026-11-03）

- 全仓测试覆盖合计 2,126 项通过：Context 8、Contracts 44、LLM 32、Desktop 715、Generation Adapters 79、Persistence 88、Worker 1,160；Domain 无测试文件并正常退出。全仓首次最终运行仅两处旧输入上限断言失败，按用户确认更新为长输入接受后重跑 Worker 全量，81 个文件、1,160 项全部通过；未更改其他包或再次改动生产代码。日志分别为 `agent-context-size-verified-all-tests.log` 与 `agent-context-size-verified-worker-tests.log`。
- 输入回归覆盖 8 个聊天入口，超过旧字数上限的原文完整通过，非字符串仍拒绝。服务层保存 100,001 字会话要求；补充覆盖长主请求、长补充及超过原 32 条的队列，幂等重试不重复写入、按原序一次消费。用户消息保存覆盖超过原 100 万字上限。
- v73 迁移覆盖 v72 旧内容、版本和时间不变，长文本完整往返，项目隔离、负版本拒绝、级联删除、外键检查、重复升级与建表后失败的事务回滚。
- 全仓 `pnpm typecheck`、`pnpm build` 通过；最后两处测试断言更新后再次执行 Worker typecheck 通过。构建只有既有前端大 chunk 提示。
- 全仓 `pnpm lint` 实际失败 14 项，`pnpm format:check` 实际失败 8 个文件，均为修改前既有问题；没有将它们记为通过。所改文件的聚焦 ESLint 通过（`request-validation.ts` 保留修改前已有的 case 声明错误）；所改文件 Prettier 检查和 `git diff --check` 通过。
- 验证日志保存在 `C:/Users/MSI/AppData/Local/Temp/`：`agent-context-size-verified-typecheck.log`、`agent-context-size-verified-worker-typecheck.log`、`agent-context-size-verified-build.log`、`agent-context-size-verified-eslint-focused.log`、`agent-context-size-final-lint.log`、`agent-context-size-final-format.log`。

## 构建与生效条件

生产 Worker 已重建为 `apps/desktop/src-tauri/binaries/ai-video-worker-x86_64-pc-windows-msvc.exe`，SHA256 为 `3F30BA5B46DD0F33EB0D4A74F461AEE6E64AD26EE58974347B544DD31FE2EC63`。`validate-llm-intent-sidecar.mjs` 的两协议 × 两入口 × 有无提示共 8 组合通过，真实 Provider 请求为 0。报告：`C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-fyQ3Q4/report.json`。

当前开发环境由既有 Vite/Tauri 监听流程加载新构建，不手动重启或重放旧任务；以实际完成重载为生效条件。已安装的发行版需要包含该 Worker、前端及 v73 迁移的新版本安装包；本次未打安装包。项目会话要求表通过正常项目升级流程迁移，本次未直接操作真实项目数据库。传输信封仍受现有 2 MiB 技术容量约束，模型窗口以已核实配置或保守回退为准；应用不再增加聊天输入字数或累计补充上限。

## 未声明输出参数的续轮补修（2026-11-03）

真实失败 generation `2be3c7cf-6c5d-4d9a-bc00-007f0b074a56`：用户输入 2 字、当前约束 0 字；系统 7,885、工具 6,401、历史 36,404，加协议开销共 51,502 Token。已整理 2 次。选中模型没有合同和窗口声明，使用 64,000 保守回退；`inferenceSettings` 缺省导致旧适配分支不执行，仍为输出预留 16,000，输入预算停留在 44,800。最后请求在本地准备时失败，未发送 Provider。

补修仅在整理后需要腾出输出空间、且尚有至少 2,048 Token 输出余量时启用：已声明参数继续优先；未声明时，按用户选择的 OpenAI 兼容传输协议使用标准字段，Chat 为 `max_tokens`，Responses 为 `max_output_tokens`。这是显式的本次输出上限，不是模型官方最大能力声明；保留 `reasoning=provider_default`，窗口来源仍是 fallback，不自动绑定 GLM 合同或修改模型配置。新请求预算与实际 Native 参数一致；无法容纳必要输入与最小输出时仍明确结束，输入不截断。余量足够的请求继续沿用供应商默认输出。

51,502 Token 的原规模在 64,000 回退窗口内应显式预留 9,298 输出 Token，并保留 3,200 协议空间；不再仅因缺少模型合同而停在 44,800 输入预算。Responses 重建后的最终信封仍再次计算并同步实际输出参数。标准字段的实际渠道兼容性不以离线测试冒充真实 Provider 验收。

- [x] F0 只读审计、修改前备份和设计。副本：`C:/Users/MSI/AppData/Local/Temp/agent-context-output-fallback-20261103/`。
- [x] F1 失败回归：双协议精确 51,502 Token、未声明输出参数及 Native/Pi 三图路径共 4 项失败，原未超预算路径 2 项通过；日志 `agent-context-output-fallback-repro.log`。
- [x] F2 实施协议输出兜底。预算 33 项与 Native/Pi 20 项通过，覆盖双协议精确 51,502 Token、三图、未声明设置、三种已声明字段优先、Responses 重建后参数同步、余量足够时仍用默认值及最小输出空间不足时保留输入并拒绝。Rust Native 请求信封与实际 JSON 参数合同 4 项通过；不修改 Native 协议。
- [x] F3 全仓测试、类型与构建通过，生产 Worker 重建、离线验证和当前开发实例生效已核对；既有 lint/format 失败继续如实记录。

F3 验证结果：

- `pnpm test` 全仓 2,132 项全部通过：Context 8、Contracts 44、LLM 32、Desktop 715、Generation Adapters 79、Persistence 88、Worker 1,166；Domain 无测试并正常退出。本轮无需分段补跑或修改旧预期。Native 专项另外 4 项通过。
- `pnpm typecheck`、`pnpm build`、本次 3 个 TypeScript 文件 ESLint、本次 6 个文件 Prettier 及 `git diff --check` 通过。全仓 lint 仍为 14 项既有失败、format 仍为 8 个既有文件；没有扩大本次修复去更改其他工作。
- `pnpm worker:sidecar` 成功，新生产 Worker SHA256：`33CF5780EB506CBCD38F0D32D56EC424D459982BCA7AAB0191520949914DEC7E`。两协议 × 两入口 × 有无提示共 8 个生产离线组合通过，报告 `C:/Users/MSI/AppData/Local/Temp/unicomp-llm-intent-l2hCDV/report.json`，`providerRequests=0`。原规模精确预算和 Native/Pi 模型路径由前述模拟集成覆盖，不把直接工具验证冒充模型行为。
- 最新预算模块构建于 09:02:47 UTC；现有 Tauri 监听自动启动 Desktop PID 94900（17:02:59 本地时间）、Worker PID 5612（17:02:59），运行 `node dist/index.js`，晚于构建时间。当前开发实例已加载补修；未手动重启、未重发历史任务、未直接修改真实项目/设置数据库。本次未生成安装包。
- 脱敏审计：`C:/Users/MSI/AppData/Local/Temp/agent-context-output-fallback-20261103/audit.json`。日志在同一 Temp 下，前缀 `agent-context-output-fallback-`：`repro.log`、`focused.log`、`budget-final.log`、`all-tests.log`、`typecheck-all.log`、`native-contract.log`、`eslint.log`、`format-focused.log`、`lint.log`、`format.log`、`build.log`、`sidecar.log`、`sidecar-verify.log`。
