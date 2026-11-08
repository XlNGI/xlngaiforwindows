# 镜头之间人工选帧与参考图衔接实施计划

日期：2026-10-18。按 C0 → C1 → C2 → C3 → C4 实施。

2026-11-04 用户修订：镜头衔接扩展为项目全部素材与显式本地文件、多视频批量抽帧及图片多选，上一镜头仅作快捷推荐，首镜及纯图片也可使用。本次规则优先于下方历史单视频与 4 帧限制；新绑定保存真实多来源，旧绑定兼容。顺序实施及验证见 [多来源与批量参考计划](./SHOT-CONTINUITY-MULTI-SOURCE-PLAN.md)。

2026-11-04 会话审计后用户确认优化：`shot.continuity.read` 默认只返回元数据，Agent 显式 `includeImages=true` 才发送实际像素；从视觉证据创作仍须先明确读取像素。用户选帧、绑定、来源令牌、CAS 和视觉能力校验不变；阶段及验证见 [会话优化计划](./AGENT-SESSION-OPTIMIZATION-PLAN.md)。

## 已确认目标

- 人工选择上一镜头已成功落盘的视频、播放时间点和要保留的画面；系统不自动挑选或采用末帧。
- 选帧确认后，LLM 才根据所选画面、下一镜头内容、衔接方式和人工约束生成提示词。提示词可人工修改，采用前不覆盖镜头原稿。
- 2026-11-02 用户最终确认：镜头页面用于检查内容和绑定。人工选帧后，用户向现有 Agent 表达参考图生成目标；Agent 按需读取当前镜头、实际选帧及已绑定图片，目标不明确时澄清，编写并保存可编辑的静态图片提示词。
- 图片可以表现本镜头开头或中间时刻；不预设换机位或首帧。复用正常生图表单，用户确认图片后绑定为普通参考图或显式首帧，再用原有填充按钮制作本镜头视频。图片提示词与视频提示词分开保存；取消独立衔接视频及后续视频提示词流程。
- 多张选帧用于理解动作与空间关系，其中一张由人工明确指定为衔接基准；不会把全部选帧自动塞进所有视频接口。
- 首帧约束下一视频的起点，不宣称保证全段不漂移或恢复单张图片未提供的速度、三维空间。

## 业务边界与所有权

上一镜头按同场次的镜头顺序确定；视频必须真实关联该镜头，不能将未成功任务、其他项目或其他镜头的视频当作来源。人工选择该视频并确认选帧，表示本次采用它作为衔接来源，不全局采用该镜头的所有结果。

预览抽帧仅为临时文件，完成读取即清理，不进入素材库。人工确认的原尺寸图片通过本地抽帧任务成功落盘后，登记独立图片素材及来源任务；不修改源视频。关系、选帧时间、源哈希、生成意图、图片提示词与最终图片用途保存在当前项目 SQLite，并有版本冲突检查。原有角色完整设定板保持外观参考用途。

LLM 使用用户选择的、已声明视觉能力的连接/模型，沿用已有生成、取消和使用记录，不新增供应商必填字段。源画面、镜头内容或人工约束变化后，旧提示词不可无提示地继续采用。生成图片/视频继续在现有制作表单选择模型、审核参数并确认费用；本功能不自动发起媒体生成。

## 顺序清单

- [x] C0 基线与合同：审计现有 FFmpeg、镜头素材、首帧映射、LLM 和来源检查；冻结合同与失败矩阵。
- [x] C1 本地选帧：有界精确时间抽帧、原尺寸保存、项目/来源/文件验证、临时文件清理与事务补偿。
- [x] C2 项目持久化及制作关联：迁移、CAS、显式图片用途绑定、跨入口编译与填充来源复验（提交按最终 API 参数校验）。
- [x] C3 人工工作流及 LLM：播放定位、人工添加/移除候选帧及指定基准、确认后生成和编辑提示词、复用生图/视频入口、切换目标隔离。
- [x] C4 验证：真实本地视频抽帧、迁移/失败回滚/过期来源/不支持模型/UI 回归；全仓测试、类型、Lint、格式及构建。

## 失败矩阵与验收

| 情况 | 必须行为 |
| --- | --- |
| 第一镜头或上一镜头无视频 | 明确空态，不伪造来源 |
| 时间越界、重复或超过 4 帧 | 拒绝；不截断、不自动选择 |
| 删除/替换源文件、镜头排序变化、项目关闭 | 拒绝旧来源；不更新其他目标 |
| FFmpeg 不可用、取消、空间不足、事务失败 | 错误可见；清理半成品，不覆盖源文件 |
| 两个窗口同时确认或更新 | CAS 拒绝旧版本 |
| 尚未确认选帧 | 不调用 LLM |
| LLM 无视觉能力、失败或取消 | 明确失败；保留已选画面和人工文本 |
| LLM 完成时选帧/剧情已改变 | 不自动采用旧输出 |
| 尚未绑定新图片 | 可以制作参考图；本镜头仍按实际已有参考及模型能力填表，不强制新首帧 |
| 图片用途与模型不兼容 | 填充时提示更换用途或模型；普通参考图不宣称锁定视频起始构图 |

自动化验证使用临时项目、本地合成视频及模拟 Provider；真实付费样片、视觉连贯质量和已安装应用验收独立记录。

## 原 C0 至 C4 阶段历史证据

以下为 2026-10-18 实现的验证记录，工作流以文末 2026-11-02 修订为准。

- C0：复用 `FfmpegRuntime`、既有本地素材与来源任务、`GenerationService`、`ProductionService` 和严格首帧投影器；新增字段仅用于内部业务合同，不作为通用 Provider 参数。
- C1：真实本地 H.264 视频验证人工时间点抽帧；原尺寸 PNG 解码后的像素摘要与源视频对应画面相同。预览无入库、越界/错误镜头/源文件变化拒绝、取消与事务失败清理均有测试。
- C2：项目 Schema v56；v55 迁移故障回滚及重试、项目隔离、CAS、清除后的旧版本拒绝、关闭重开保持绑定通过。实际公共 IPC 路由覆盖选帧、确认和保存提示词。制作编译、来源变化及实际提交缺少首帧有回归覆盖。
- C3：组件覆盖人工选视频、添加候选、显式指定基准、确认后 LLM、人工修改再制作、换机位等待新首帧、过期 LLM 结果丢弃、只读与无视觉模型。旧制作草稿不能覆盖新确认的提示词和输入；本次表单人工编辑及其他偏好保留。
- Markdown 与两份既有素材库 DOCX 的新增规则已同步，逐段内容、ZIP 和 OOXML 检查通过。两份 DOCX 均尝试 `render_docx.py`；运行时缺少 `soffice.exe`，未生成页面 PNG，版式复核仍待验收，不计为已完成。

## 最终验证（2026-10-18）

| 检查 | 结果 |
| --- | --- |
| 全仓按包串行测试 | 1,559 项通过：context 8、contracts 24、LLM 32、Desktop 478、adapters 139、persistence 73、Worker 805 |
| TypeScript 类型检查 | `pnpm typecheck` 通过 |
| Lint、格式及补丁 | `pnpm lint`、`pnpm format:check`、`git diff --check` 通过 |
| 生产构建 | `pnpm build` 通过；保留既有 Vite 包体提示 |
| 本地视频及 IPC | 实际 FFmpeg 解码、像素摘要、原尺寸保存、临时文件清理、提交后读取失败不删除已提交图片、公共 RPC 路由通过 |
| 浏览器 UI | Windows Edge，实际组件与本地视频、模拟 RPC，在 1280×900 与 390×900 下人工选择 1.000s、指定基准和确认通过；无横向溢出及页面错误；修复候选图撑出预览容器后复核 |

日志：`.shot-continuity-tests-final.log`、`.shot-continuity-typecheck.log`、`.shot-continuity-lint.log`、`.shot-continuity-format.log`、`.shot-continuity-build.log`。浏览器脚本、报告及截图位于本机临时目录 `C:/Users/10698/AppData/Local/Temp/shot-continuity-ui-20261018/`。

本次未修改原生 Rust 源码，未重打或安装 Windows 安装包。LLM 和媒体 Provider 使用模拟验证，未调用真实付费模型；真实画面连贯、角色站位及换机位质量仍需用户样片验收。所有测试使用隔离临时项目，保留实施前的工作区改动，不修改用户项目。

## 2026-11-02 工作流修订

- [x] R1 合同与服务：SQLite JSON 增量字段记录普通参考图和用途，兼容旧首帧；保留项目隔离、来源校验与 CAS。
- [x] R2 Agent：按需读取实际图片及镜头资料，保存用户意图和图片提示词；用户不清楚目标时通过现有输入表单澄清，图片提示词不得覆盖镜头视频正文。
- [x] R3 镜头页面：人工选帧、可编辑要求、交给 Agent、手填提示词、正常生图填充、图片预览与用途绑定；删除独立衔接视频入口。
- [x] R4 填充：普通参考图和显式首帧均进入正常本镜头表单，源抽帧仅用于参考图制作；提交只按最终 API Schema 校验。
- [ ] R5 定向回归、类型、构建、质量门禁与 Markdown/DOCX 同步；记录既有失败及真实付费样片未验收项。

本次状态为：未选帧 → 人工确认选帧 → 用户表达目标／Agent 澄清 → 保存图片提示词 → 正常生图表单 → 人工绑定图片用途 → 原有填充制作本镜头。意图、提示词与图片关系属于当前项目和镜头，存储于项目 SQLite；Agent 会话只保留沟通过程。读取图片为有界按需操作，不自动注入普通会话，不将图片像素写入工具审计摘要。重新确认选帧使旧版本失效；迟到写入、跨项目、删除或缺失素材均拒绝。用途切换、取消绑定和清除均使用 CAS；填充后人工编辑不受原绑定约束。

### 本次实现与验证证据

- 服务 14 项定向测试覆盖真实 FFmpeg 选帧、旧绑定兼容、普通参考图／首帧切换与取消、来源变化、CAS 和意图／提示词事务回滚。选帧不会自动成为视频输入；用户仍可明确选择现有图片作为最终参考。
- 复用统一 Agent 的工具授权与会话澄清：`shot.continuity.read` 返回画面顺序与实际图片，`shot.continuity.save` 带版本和来源令牌写入。两协议均验证图片经过 Pi 续接和原生请求体发送；Chat 历史重放与 Responses 上下文整理后的新链保留图片，预算不将 Base64 当作正文计数。审计结果不含像素编码。
- 镜头页面及工作区 32 项测试覆盖人工确认、保存要求后交给 Agent、手填提示词、生图填充、Agent 保存后刷新、保留未保存编辑及图片用途绑定。视频填充继续使用镜头视频正文，普通参考图／首帧按用途映射，不附带全部源抽帧。

| 检查 | 2026-11-02 结果 |
| --- | --- |
| 全仓测试 | `pnpm test`：2,011 项通过；context 8、contracts 42、LLM 32、Desktop 675、adapters 75、persistence 87、Worker 1,092。此前首轮仅有两项新续接测试夹具漏载工具；补齐 `tools.load` 后，定向 73 项及本轮全仓均通过 |
| 类型与生产构建 | `pnpm typecheck`、`pnpm build` 通过；保留既有 Vite 主包体积提示 |
| 原生验证 | `cargo test --lib`：177 通过、1 项既有忽略；`cargo fmt --check` 通过 |
| 相关源码检查 | 定向 ESLint、Prettier 与 `git diff --check` 通过；`request-validation.ts` 的既有 `no-case-declarations` 错误计入下行全仓记录 |
| 全仓 Lint | 10 项既有错误：`App.test.tsx` 3 项、`ProductionPanel.audio.test.tsx` 2 项，以及 `shot-binding-summary.ts`、`dubbing-service.test.ts`、`project-service.test.ts`、`request-validation.ts`、`scene-structure-submission-service.ts` 各 1 项；没有为本功能改写这些其他工作 |
| 全仓格式 | 10 个范围外文件不符合格式：`AssistantReply.test.tsx`、`AssistantReply.tsx`、`media-confirmation.tsx`、`SceneCastEditor.tsx`、`SceneShotDirectory.tsx`、`context-service.ts`、`domain-tool-gateway.ts`、`dubbing-service.test.ts`、`dubbing-service.ts`、`project-library-query.ts` |
| 文档同步 | 两份素材库 Markdown 的本节与各自 DOCX 的 3／4 个完整段落一致；ZIP 完整性及各 15 个 XML 部件解析通过 |
| DOCX 版式 | 两份均调用随附 `render_docx.py`，因缺少 LibreOffice `soffice.exe` 未生成页面 PNG；版式未验收 |

日志：`.continuity-reference-all-tests-final.log`、`.continuity-reference-runtime-final.log`、`.continuity-reference-typecheck-final.log`、`.continuity-reference-build.log`、`.continuity-reference-rust.log`、`.continuity-reference-focused-lint-final.log`、`.continuity-reference-focused-format-final.log`、`.continuity-reference-lint-final.log`、`.continuity-reference-format-final.log` 及两份 `.continuity-reference-docx-*.log`。

本次修改了原生图片工具结果转发，须重新构建应用后使用；未重打或安装 Windows 安装包，未替换运行中的实例。未调用真实付费模型、未修改用户项目数据库；真实生成质量与 Windows 应用内操作仍待样片及实机验收。R1–R4 功能已完成，R5 因上述全仓门禁及 DOCX 版式问题保持未完成。

## 2026-11-02 抽帧清晰度修复

- [x] Q1 审计：候选预览固定缩至 640 像素并在放大时复用，确认后默认显示 320 像素缩略图；Agent 看图也固定缩至 640 像素。原尺寸 PNG 保存链路未缩放，生图引用原素材。
- [x] Q2 修复：候选帧改为最长边 2560 的高质量 4:4:4 JPEG，经 RGB 转换保持与原 PNG 一致的色彩转换；超过 1 MiB 才缩小。确认帧及选用图在衔接面板直接加载原图；图片放大使用 scale-down，避免强行放大低分辨率输入。Agent 看图最长边 2048，按图片数分配 899000 字节编码前预算，总 Base64 仍不超过 1200000 字符。临时文件、取消、空间与项目边界继续校验。
- [x] Q3 定向验证及内容同步：27 项 Worker 和 40 项 Desktop 回归通过；横竖 1080p 候选保留源尺寸且 PSNR 超过 38 dB，保存 PNG 解码后与源视频对应帧 RGB 像素摘要完全一致。自适应体积测试、临时文件清理、原图加载及用途填充通过；类型检查、生产构建、变更源码 ESLint、Prettier 与 diff 检查通过。两份 Markdown 与对应 DOCX 本节 3／4 段内容同步，ZIP/XML 有效。
- [ ] Q4 整体验收：全仓测试和质量门禁记录如下；DOCX 随附渲染器仍缺少 `soffice.exe`，无法完成页面验收。全仓既有 Lint 和格式问题保持可见，不因定向通过而声明整体门禁完成。

本次没有改变源视频或已保存帧，不通过锐化、插值放大或模型重绘伪造细节。已有确认 PNG 在重新加载后可直接查看原图；旧候选帧需要重新添加以读取新的高清预览。

相同 1920×1080 本地合成视频的画质对照：旧 640 像素 JPEG 在还原到源尺寸后 PSNR 约 27.25 dB，新高清预览约 47.03 dB；该指标只说明测试画面的编码保真度，不替代真实视频质量验收。已查看源图、旧图及新图的等尺寸细节对照，细纹和时间码不再因固定 640 像素缩放丢失。对照 PNG 位于本机临时目录 `C:/Users/MSI/AppData/Local/Temp/frame-quality-20261102/quality-comparison.png`。

本次代码未新增 Rust 改动；既有原生测试复验 177 通过、1 项忽略。全仓 `pnpm lint` 仍有前述 10 项范围外错误，`pnpm format:check` 当前有 8 个范围外文件不符：`media-confirmation.tsx`、`SceneCastEditor.tsx`、`SceneShotDirectory.tsx`、`context-service.ts`、`domain-tool-gateway.ts`、`dubbing-service.test.ts`、`dubbing-service.ts`、`project-library-query.ts`。两份 DOCX 已重新尝试渲染，因相同运行时缺失而未生成页面；未声明版式通过。

最终全仓 `pnpm test` 2,014 项通过：context 8、contracts 42、LLM 32、Desktop 675、adapters 75、persistence 87、Worker 1,095。所有抽帧及图片预览新增回归包含在本轮测试内，Q4 仅保留上述范围外 Lint／格式及 DOCX 版式验收限制。

日志：`.frame-quality-worker-final.log`、`.frame-quality-desktop.log`、`.frame-quality-typecheck.log`、`.frame-quality-build.log`、`.frame-quality-eslint.log`、`.frame-quality-all-tests.log`、`.frame-quality-rust.log`、`.frame-quality-lint.log`、`.frame-quality-format.log` 及 `.frame-quality-docx-*.log`。没有调用付费模型、修改真实项目或替换正在运行的应用；需重新构建并运行修复版本后观察效果。

2026-11-02 首帧填充补充：同一张图片同时绑定为角色／场景参考与本镜首帧时，实际输入快照优先保留显式首帧用途，原语义绑定不变；图片去重后不重复上传，视频模式由该快照派生。显式填充等待当前适配器解析完成，错误会显示并阻止生成，人工修正图片输入后可继续，最终提交不恢复旧绑定。镜头按钮明确区分图片与视频，衔接面板继续先制作静态参考图。撞图、填充错误、人工恢复与异步模式切换的回归及最终门禁见 [制作输入一致性修复计划](./PRODUCTION-INPUT-CONSISTENCY-REPAIR-PLAN.md)；R5／Q4 的既有整体验收限制保留。

2026-11-03 镜头提示词变更后的选帧确认及填表阻断修复，见 [镜头改词后视频填充修复](./SHOT-CONTINUITY-REFILL-REPAIR-PLAN.md)。旧选帧不静默沿用；仅目标镜头版本变化、素材来源仍有效时允许用户明确确认沿用。
