# 章节剧本契约与交接死锁修复

现场依据：[2026-11-05 审计](./code-traces/2026-11-05-chapters-to-script-checkpoint-deadlock.md)。落实既有文档类型、按需检索与同任务连续执行要求，不新增文档领域类型，不改变 DOCX 产品要求。

按顺序实施，只有实际验证后勾选：

- [x] D1 统一剧本保存、计划与验收契约：使用现有 `plan` 类型和 `document.submit_draft`；字段组合与错误指向明确；新增回归先确认失败。
- [x] D2 强制交接只在有新的成功证据且可节省上下文时触发；允许明确 partial 出口；失败不能产生交接进展或解除交付验收。
- [x] D3 检测同一工具目标/错误状态无进展重试，保留参数修正、新目标/版本、用户补充与真实进展的机会；无任务总轮数限制。
- [x] D4 双协议离线流程验证短章节读取、真实 SQLite 剧本草稿回执、失败后修正/退出及不重复写入；执行全仓质量门禁并记录通过项与范围外阻塞。

验证仅使用模拟模型与临时项目，不重放用户任务、不调用付费 Provider、不写用户项目、不重启当前应用。交接必须继续保留用户输入、未完成正文、来源版本、约束与 CAS。

## 实施与定向验证

2026-11-05：D1 新增测试首先复现 `storyboard` 计划被拒、章节技能未声明合法剧本类型；D2 新测试确认原实现缺少可交接证据判断；D3 新测试确认原实现不检测重复失败。随后实施修复：

- 领域 `DOCUMENT_KINDS` 由类型定义、保存 schema、保存服务与交付计划共同使用。章节技能明确保存 `plan` 至 `workspace:documents`，移除当前不可用的旧提交工具；章节任务不再附加逐镜制作要求。新文档计划的 targetIds 不使用源章节 ID。历史 `script` 计划在读取时按既有 `plan` 合同解释，审计不改写，原数量和目标义务不降低。
- checkpoint schema 限制每种 operation 的字段；plan 限制 documentKind/requireReferences 与工具名组合；Worker 返回具体字段路径。Pi 校验只检查选中的 operation，错误不混入其他分支，也不回显正文。
- Worker 和运行时共用成功证据判断，排除加载、路由、交接与失败；已交接的相同版本/范围证据不能再次触发强制交接。上下文实际无法容纳且无合法交接时明确失败，不制造进展。partial 由真实 Worker 回执解除强制交接，最终解释不再携带全部工具 schema，保留正文、用户要求与失败证据。
- 同一工具目标与错误状态四次无进展后，在下一次模型请求发送前停止；错误签名仅在内存计算哈希，包含真实目标、版本和结构修正字段。checkpoint 的说明文字只比较字段存在性、类型和长度有效状态，改写 remainingWork/workingNotes/reason/description 不能伪装成修复；业务正文仍按完整参数区分。新用户输入、新读取证据或成功保存重置失败计数；工具加载/交接不重置。更正参数不受统一校验次数上限阻止。

Native/Pi + 真实临时 SQLite 的 12 组新增/调整流程通过：Responses 与 Chat Completions 分别覆盖修正后真实保存一份 plan 草稿、失败后 partial、强制交接下 partial、相同 schema/业务错误重复停止；另保留多次更正参数的机会。六组章节流程均只读源章节一次，保持原 draft 正文；保存成功须有任务文档回执，partial 保留欠交付且没有伪造草稿。压力用例按实际请求预算断言进入初始输入预算的 90% 以上，未 mock 预算。

末轮补充先确认“缺 workingNotes、反复改写 remainingWork”回归失败，再修复签名。双协议 schema 与业务错误用例均改为每轮改写说明，仍在第五次错误重试前停止且保留已保存草稿；新增五组检查确保补齐字段、修正超长笔记、切换目标、更新版本和修正业务正文仍能继续。Pi 连续四次校验修正使用实际缺字段/空数组/类型/枚举修正，不依赖虚构 repairAttempt 字段。

## 最终门禁

2026-11-05 执行结果：

- 全仓 `pnpm typecheck`、`pnpm build` 通过，Vite 仅有 chunk 体积提示。末轮 Worker 类型检查、构建、18 个 TypeScript 文件定向 ESLint、全部本次修改文件 Prettier 与 `git diff --check` 均通过；差异检查仅有范围外文件的既有换行提示。
- 最终 Worker 定向 5 文件 198 项全部通过，覆盖上下文预算、阶段交接、交付验收、工具网关与完整流水线。上一轮全量 Worker 88 文件 1304 项中 1303 项通过，仅上述新加的改写说明回归失败；修复后该项与另外五项新增检查在最终定向运行中通过。其余 83 文件 1111 项沿用全量结果，不将分次复验写成一次全绿。
- 其他包：Contracts 48、Context 8、LLM 32、generation-adapters 80、Persistence 89 项通过；Domain 无测试。
- 全仓 `pnpm test` 在 Desktop 805/806 项处停止：`App.test.tsx` 仍查找“项目执行记录”，当前界面已为“任务日志”。本次未更改该断言或界面。随后独立执行其余后端包，结果如上。
- 全仓 `pnpm lint` 剩 22 个本次未涉及问题：`.m2-ui-*` 临时 UI 夹具的环境/项目解析、`shot-binding-summary.ts` 多余断言、`project-service.test.ts` 不安全访问、`request-validation.ts` case 声明、`scene-structure-submission-service.ts` unknown 插值。
- 全仓 `pnpm format:check` 剩 5 个本次未改文件：Desktop 的 `media-confirmation.tsx`、`SceneCastEditor.tsx`；Worker 的 `context-service.ts`、`domain-tool-gateway.ts`；Persistence 的 `project-library-query.ts`。未作范围外格式化。

日志位于本机临时目录：`p22-checkpoint-repair-tests.log`、`p22-checkpoint-repair-remaining-tests.log`、`p22-checkpoint-repair-final-focused.log`、`p22-checkpoint-repair-typecheck.log`、`p22-checkpoint-repair-build.log`、`p22-checkpoint-repair-lint.log`、`p22-checkpoint-repair-format.log`。重复定向运行不累计为新增测试数。

当前修改仅源码与本地构建产物，未替换已安装应用或重启运行实例；真实模型语义行为仍须在新版运行时复测。未调用付费 Provider、重放历史任务或修改用户项目；历史任务仍是失败状态，不将本次离线通过解释为历史产物已补齐。

## 20:16–20:28 新任务补修

现场与运行版本证据见 [新建剧本失败及稿件交接审计](./code-traces/2026-11-05-rejected-script-handoff.md)。此前源码修复不等于当前应用已经加载；原有 D1–D4 结果不能作为新任务成功的证据。

- [x] D5 先复现失败提交的原创正文／IR 在交接后丢失；在当前任务内存保留被拒绝的本地草稿参数与错误，交接直接提供完整稿件。已在当前阶段历史中的调用不重复放入交接信封；空正文／漏正文的错误修复不能覆盖完整稿件；其他目标保存不能清除此稿；同一目标实际保存后清理。不会自动重放写入，也不扩大审计正文存储。
- [x] D6 对齐新建／更新契约：新建文档完全省略 documentId、expectedDocumentRowVersion、baseVersionId，包括 null；更新必须有目标 ID 与目标 CAS，不能设置新建 bindingRole。contentIR 仅用于 character／scene／prop，剧本结构写在 contentMarkdown；不新增 plan IR 类型、不静默丢弃创作内容，原权限及 CAS 校验继续执行。
- [x] D7 Responses 与 Chat Completions 分别验证“拒绝新建参数 → 交接仍含完整原稿与 IR → 修正后仅保存一份原剧本”，不翻页扫描审计。32k 窗口压力回归继续保留失败正文，压力来自可释放的过程历史，不通过丢弃未保存稿件、调大窗口或 mock 预算通过。
- [x] D8 完成 Worker 全量回归并复核构建产物；分别记录源码验证、运行版本和真实任务结果，不把重新构建当作旧进程已更新。
- [ ] D9 当前桌面应用重新加载新版 Worker 并核验进程；已提出重启当前编辑窗口的确认，等待用户选择。当前历史失败任务不自动重放。

D5／D6 的首轮新增回归均先确认失败再修复。补修最终定向 5 文件 203 项通过；随后一次 Worker 全量运行 88 文件 1314 项全部通过（257.44 秒），类型检查、构建、8 文件定向 ESLint、Prettier 和 `git diff --check` 通过。全仓其余门禁沿用前述执行结果及范围外阻塞，不将 Worker 全量通过写成全仓通过。

已核查 recent-projects 中十个项目：没有运行／排队中的 Agent、LLM、媒体生成、配音或文件任务。当前 Worker 仍是 18:55 启动的旧进程；构建产物已包含 pendingWrites 和新建／更新 schema。应用重启会关闭当前编辑窗口，故在激活前询问用户，尚未收到选择；未通过杀 Worker 来丢失其项目会话状态。

补修日志：本机临时目录 `p22-pending-draft-focused-final.log`、`p22-pending-draft-worker-all.log`、`p22-pending-draft-typecheck.log`、`p22-pending-draft-build.log`、`p22-pending-draft-lint.log`、`p22-pending-draft-format.log`。未调用付费 Provider、重放任务或写入用户项目。
