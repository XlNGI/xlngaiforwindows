# 一键短剧制作：代码审计与实施计划

日期：2026-10-24。范围：小说章节生成剧本资料；剧本生成媒体审核前材料。

## 审计结论

- `App.sendMessage → agent.run → prepareAgentGeneration → AgentProviderLoopService / Pi` 已是统一 Agent 入口。按钮应复用它，不添加另一套创作引擎或关键词路由。
- `document.submit_draft`、`novel.episode.submit_draft/submit_structure`、`scene.structure.stage` 已支持文档、场次、镜头 IR 与真实 ID 绑定。继续使用这些工具及其 CAS、类型、项目和幂等校验。
- 普通会话的 `library.search/read` 按需读取正文；一键入口只能提供明确选中的 ID/版本，不能把小说正文自动灌入所有会话。
- `NovelWorkspace` 有当前章节及章节多选，但原先没有制作入口；`ScriptWorkspace` 是当前项目文档编辑器。章节只保留一套选择，制作与导出使用同一已选范围，由用户点击的操作决定用途（2026-10-24 按用户修正统一）。
- `media.image.prepare/media.video.prepare` 当前在一次工具调用中等待用户选择并提交。直接循环使用会阻塞“先备齐所有表单”的目标，而且选择依赖活动生成和短期令牌。
- `MediaPreparationService.prepareSelected`、`MediaOrchestrationService.requestSubmission/confirmSubmission` 已统一执行图片/视频审核提交；配音由 `DubbingService` 执行，尚无 Agent 准备入口。
- 因此需要的是可持久化、可恢复的审核表单队列，而不是第二套生成逻辑。图片/视频表单复用现有模型参数卡及提交服务；音频表单复用现有配音服务。用户点击提交就是最终批准。

## 固定边界

- Skill 声明目标、输入、产物与可用工具；LLM 决定剧情、拆镜、节奏、时长及语义。系统只执行真实 ID、类型、版本、权限、引用、幂等与付费边界保护。
- 角色、场景、道具严格分开；不需要道具时为空。候选图不冒充选用图，按真实参考图顺序编写完整提示词。
- 依赖尚未生成的图片时保留明确的表单依赖，不编造 assetId；依赖就绪后才允许提交下游表单。缺图、失效图、跨项目引用明确报错。
- 准备表单不调用 Provider。已审核提交不再次回到 Agent 改写或二次确认。重复提交不能重复生成。
- 本地 SQLite 保存表单；GitHub 不存放项目数据。保留现有用户改动，不操作真实项目数据或付费接口进行测试。

## 分阶段计划

- [x] A：只读审计统一 Agent、IR、选择状态、媒体及音频边界。
- [x] B：声明两份可按需读取的 Skill，加入真实源对象/版本校验；两个按钮复用同一 Agent 发送链路。
- [x] C：持久化审核表单及依赖，接入同一 Agent 工具和现有媒体/配音服务，补齐可编辑队列 UI。
- [x] D：聚焦回归与仓库质量门禁，记录验证结果及实际限制。

## 验证记录

### B/C 验证记录

- `@ai-video/worker` Agent loop 新增回归：`production.skill.read`、`media.review.prepare/list` 通过统一授权链执行；准备两份表单没有创建 `generation_jobs`，也没有调用 Provider。
- `media-review-service.test.ts` 9 项通过：持久化恢复、依赖结果顺序、失效素材、CAS、源版本、审核后模型变化、并发/不确定提交、音频提交边界。列表只返回目录，完整提示词按需读取。
- Desktop `MediaReviewQueue.test.tsx` 3 项、`NovelWorkspace.test.tsx` 23 项、`ChatPanel.test.tsx` 34 项通过。
- `App.test.tsx` 89 项通过，其中两项验证两个按钮调用同一个 `agent.run`，只传源对象/版本元数据，保留未发送的输入框内容。
- 共用 `MediaPreparationService` 回归 16 项通过，覆盖图片任务保存 `sourceDocumentId`、用户删改参考图后不重新加入旧图片，完整保留最终提示词及图片顺序。
- Contracts、Persistence、Worker、Desktop 类型检查通过；新增迁移为 63，审核表单表和索引使用幂等创建。

### D 验证记录

- `pnpm test` 全仓通过，Worker 73 文件 / 979 项通过；随后改动涉及的 Agent loop、审核服务、媒体准备、官方视频及 Desktop 测试再次定向通过。最终 Agent loop 136 项、审核服务 9 项、官方视频 10 项通过。
- Persistence 全仓 20 文件 / 82 项通过；新增的 v63 迁移回滚/重复升级保护测试也已通过。旧 v62 测试恢复真实升级前状态，最终断言覆盖 v63。
- 最终 `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check` 全部通过。
- `cargo test --lib`：167 项通过，1 项既有可选公网图片下载测试跳过。构建保留现有大包大小提示与 Rust 测试 fixture 的 `unused_mut` 提示。
- 只使用临时项目、mock Provider 及本地素材；未修改真实项目数据，未调用付费 Provider。已生成前端和 Worker 构建产物，没有打包安装或替换当前运行的桌面应用。

### 2026-10-25 审核表单参考图与会话字号收尾

- [x] `media.review.prepare` 在目标为场次或镜头时读取保存的媒体绑定，将当前已选且可用的角色、场景、道具图片按稳定顺序补入审核表单；显式禁用和候选图不会进入输入，不需要道具时保持空，超过模型上限时明确阻止。
- [x] `MediaPreparationService.prepareSelected` 从最终冻结的 `inputImages` 返回 `inputAssetIds`，确保表单展示、生成快照和最终提交使用同一组参考图。
- [x] 新增真实临时项目回归：角色、场景、道具三类绑定全部进入镜头视频表单；Worker 媒体审核服务 10 项、生产媒体视图 4 项通过。
- [x] 会话与内容生产页面统一使用全局 `--ui-font-scale: 1.3`，参考图编辑器芯片不再额外缩小；会话阶段和问答表单的既有时间排序、折叠与恢复逻辑保持不变。
- [x] 最终门禁再次通过：`pnpm test`（context 8、contracts 30、llm 32、desktop 591、generation-adapters 69、persistence 84、worker 1002）、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm build`、`git diff --check`。

## 使用方式与当前范围

1. 小说页每章只有一个勾选框，制作与导出共用已选章节；全选、搜索结果全选与取消全选也作用于同一范围。点击“一键生成短剧资料”使用已勾选章节，未勾选时使用当前打开的章节；导出仍可显式切换整部小说或所选章节。未保存的当前源章节需要先保存。
2. 剧本页打开已保存的文档，点击“一键准备媒体表单”。同一 Agent 按需读取 Skill、正文和真实绑定，保存材料和审核队列。
3. 在会话中的“媒体审核表单”逐项打开和调整。缺图的表单显示依赖，先提交图片，结果落盘后再打开下游表单。点击提交直接走既有生成服务，重复提交返回同一任务。
4. 音频范围沿用现有固定音色的对白/旁白配音服务，需要已有可用音色和配音连接。音乐与独立音效合成没有新增实现。

本次未改变素材库和项目检索的既定产品要求，未引入第二套存储、检索或媒体生成引擎，因此无需修改相关产品要求的 DOCX。

## 按钮布局调整（2026-10-24）

- 小说页将标题、章节管理和导入/导出/新建操作分组；下方独立制作栏显示当前章节或已勾选章节数量，主按钮位于右侧。剧本页使用同样的制作栏展示媒体表单入口。
- 制作栏随面板宽度换行；小说面板宽度小于等于 600px 时，章节目录和编辑器上下排列。入口继续使用原有 Agent 链路、源选择及未保存/忙碌保护。
- 验证：NovelWorkspace 与 App 共 112 项测试通过；类型检查、定向 ESLint、Prettier、前端构建及 diff 检查通过。浏览器以模拟数据验证深浅主题、1000/640/360px 面板及 390px 窗口共 16 组布局，检查按钮边界、重叠、选择范围和忙碌禁用状态；未连接真实项目或 Provider。
- 修正既有付费提交测试遗漏的 `media.review.list` 空列表模拟，避免把审核队列的模拟错误误识别为提交确认卡。
- 章节选择修正：删除独立的制作／导出双勾选及双状态，每章保留一个通用勾选框；归档清理、搜索全选、已选计数共用同一状态。保留制作未勾选时使用当前章节、导出范围显式选择以及未保存正文保护。
- 修正验证：NovelWorkspace 与 App 共 113 项测试通过，覆盖同一次勾选传入制作和导出的真实章节一致、搜索全选作用于制作，以及取消选择后的未保存保护；定向 ESLint、Desktop 构建（含类型检查）通过。
