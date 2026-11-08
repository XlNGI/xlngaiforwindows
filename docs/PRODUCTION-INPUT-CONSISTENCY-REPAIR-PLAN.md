# 制作输入一致性审计与修复计划

日期：2026-11-02。按用户要求先审计、再设计、然后依序实施。本计划修复既有确认规则的实现缺口，不修改素材库入库、引用快照、本地存储或提交前人工编辑的产品规则。

## 审计结论

1. `ShotWorkspace.shotReferenceImageSelections` 先加入角色、场景，再按 assetId 去重加入首帧。同一图片兼作角色／场景与首帧时，显式首帧用途丢失，而 App 仍根据原 firstFrameAssetId 选择图生视频，产生模式与输入冲突。
2. `ProductionPanel` 的显式填充与适配器解析均存在吞掉首帧投影错误的 catch；模式切换期间显式填充还可能遇到尚未切换的旧适配器。失败后默认参数不能无提示地充当成功填表。
3. 场景复合图已有共享提示词：主全景、关键特写、默认一张。Desktop 会附加提示，但旧参数记忆可能带入多图数量；Agent 常规媒体准备和延后审核入口缺少统一归一化，同一任务可用不同 key 为同一场景拆出多个审核表单。
4. 图片、视频共用“生产参数”标题，镜头“填充本镜画面表单”没有明确说明是图片。用户截图确认处于生图模式；Seedance 2.0／2.5 的文生视频适配与本机启用状态均通过此前只读核查，不为本次误认改写模型适配。
5. 既有失败任务截图缺少具体 Provider 错误，不能将历史生成失败归因于上述缺陷。本次改善填充错误可见性，不猜测或重试历史付费任务。

## 设计

- 镜头绑定保留原语义；有序输入快照中显式首帧优先于同图的普通角色／场景用途，图片不重复上传，模式根据同一份归一化输入决定。
- 显式填充只使用当前模式、当前已解析适配器；失败显示具体原因并阻止带着失败填充结果生成。切换模型或人工修改图片参数可重新恢复，填充后人工编辑不被源绑定重新覆盖。
- 场景生图的自动准备阶段统一补充复合画布要求，并将默认输出数设为 1；用户在审核／制作表单明确修改数量后保留其最终参数。不可把通用最终提交路径改成无条件覆写人工参数。
- 同一 Agent 任务、同一源场景文档只允许一个有效场景图审核意图；重复请求复用／更新原表单，取消后可以重新准备，不同任务和不同场景互不影响。旧即时选模入口同样检查同任务已有的场景准备。
- 表单顶部显示当前制作模式，镜头填充按钮明确区分“图片”与“视频”。

## 顺序与完成条件

- [x] A0 只读审计：核对绑定、模式、投影、Agent 即时准备／延后审核、共享场景规则及既有验证；保留工作区原有改动的文件副本作为本次差异基线。
- [x] A1 首帧与填充：修复用途归一化、同源模式派生、旧适配器竞态和静默失败；定向测试覆盖撞图、显式填充失败和模型切换。
- [x] A2 场景准备：统一 Desktop／Agent 场景提示与默认数量，防止同任务拆分场景图表单；验证人工数量覆盖、取消重建、不同源／任务隔离。
- [x] A3 模式反馈：当前模式可见，入口文案明确；验证生图、视频及模式切换。
- [ ] A4 最终检查：相关定向测试、全仓测试、类型、Lint、格式、生产构建及 diff 检查；逐项记录真实结果与既有失败，不将模拟验证当作真实付费画质或 Tauri 实机验收。

## 验证与限制

使用隔离临时项目、模拟媒体 Provider 和组件测试；不写入用户真实项目或设置数据库，不发起付费请求，不替换正在运行的应用。构图内容仍需真实样图验收。既有产品要求未变化，因此不重新改写素材库方案的 DOCX 产品正文；本次实现和验证记录在本计划、镜头衔接计划、场景图要求及素材库实施记录中。

## 实施记录

- A1：同图去重保留显式首帧用途，App 使用同一输入快照选择模式；显式填充等待当前适配器解析完成，错误可见且阻止生成。人工修正输入或切换模型可以恢复，不在最终提交时恢复旧绑定。新增回归覆盖撞图、错误拦截、人工恢复与异步模式切换。
- A2：共享准备策略补充主全景／关键特写构图；Desktop 默认及生产编译初值均设一张，Worker 只向支持数量参数的适配器传递默认 `n=1`。最终审核参数保持优先。审核表单按任务与场景复用，任务命名空间隔离同名 key；旧选模入口和新审核入口互相检查已有意图。取消后可重建，未绑定任务的兼容入口只合并当前待审核意图。
- A3：表单显示当前制作模式；镜头按钮明确为“填充本镜图片表单”／“填充本镜视频表单”。衔接面板的静态参考图工作流保持图片生成。
- 阶段定向验证：Desktop 六个相关文件 201 项通过；Worker 四个相关文件 190 项通过；Contracts 输入与场景规则 11 项、Seedance 两个版本适配 2 项通过。随后补充“无数量参数”回归和生产编译默认数量覆盖，并进入最终复验。
- 本次功能源码与新增回归的定向 ESLint 通过。最终复验时，场景准备／审核 34 项、表单输入一致性 3 项再次通过。

## 最终验证结果

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 2,064 项通过、2 项失败，共 2,066 项。context 8、contracts 43、LLM 32、Desktop 698、adapters 75、persistence 87 全部通过；Worker 1,121 通过、2 失败。 |
| 失败基线复验 | `agent-pipeline-remediation.test.ts` 的双协议旧资料压缩用例均报 `CONTEXT_BUDGET_EXCEEDED`：估算 28,001 Token，预算 28,000。单独运行同样失败；以审计时保存的 `agent-provider-loop-service.ts` 副本替代测试加载后，仍以相同原因失败。未修改检索或上下文预算代码，也未放宽测试阈值。 |
| `pnpm typecheck`、`pnpm build` | 全部通过。构建完成不代表替换或重启了用户正在运行的应用。 |
| 定向 ESLint | 本次功能源码和新增／扩展回归文件通过；`App.test.tsx` 仅更新按钮文案，保留其原有 3 项类型断言错误。 |
| `pnpm lint` | 14 项范围外既有错误：4 个忽略目录中的 UI 夹具无法被项目服务解析，另 10 项位于 App 测试、音频测试、绑定摘要、配音测试、项目测试、请求校验及场次结构提交。 |
| `pnpm format:check` | 8 个范围外既有文件不符：`media-confirmation.tsx`、`SceneCastEditor.tsx`、`SceneShotDirectory.tsx`、`context-service.ts`、`domain-tool-gateway.ts`、`dubbing-service.test.ts`、`dubbing-service.ts`、`project-library-query.ts`。本次变更文件及记录的定向 Prettier 检查通过。 |
| `git diff --check` | 通过。 |

A1–A3 实施完成；A4 的检查均已执行，但全仓测试、Lint 和格式门禁仍未全部通过，因此保留未勾选，不声明仓库整体质量门禁完成。基线复验通过临时 Vite 加载覆盖使用审计副本，没有回滚或覆盖工作区文件。没有新增 Rust 改动，不把本次生产构建视为 Windows 安装包或 Tauri 实机验收；未发起付费生图／视频请求，真实构图和历史失败任务原因仍需各自的出图或 Provider 错误证据。

日志保存在 `C:/Users/MSI/AppData/Local/Temp/`：`production-consistency-all-tests.log`、`production-consistency-worker-final.log`、`production-consistency-typecheck-final.log`、`production-consistency-build.log`、`production-consistency-focused-lint-final.log`、`production-consistency-lint-final.log`、`production-consistency-format-final.log`、`production-consistency-diff-check.log`、`production-consistency-budget-recheck.log`、`production-consistency-budget-baseline.log`。审计副本及 SHA256 清单位于 `production-consistency-audit-DgBTjv`。

## 视频填表按钮补充审计与实施计划

用户反馈按钮仍失效后，补充完整 App 和异步组件回归。已在修改功能源码前复现两个缺陷：

1. 衔接首帧保存在独立关系中；普通 `referenceBindings` 回写会重置本地 `refs.firstFrameAssetId`。预览使用有效衔接绑定，而按钮启用条件与填表解析使用本地 refs，导致“已绑定首帧但按钮变灰”，有其他参考图时还会漏传首帧。
2. 自动解析角色默认图后，`persist` 更新本地 refs，进而修改派生的 characters。旧异步范围标记包含 characters，将本次解析误判为用户切换绑定；最终填充回调被静默丢弃。延迟保存回归已复现回调次数为 0。

按以下顺序补修，不改变已确认产品规则：

- [x] B0 补充审计：首帧绑定回写、默认角色图延迟保存均有失败回归；完整 App 已验证 Seedance 正式参数定义的参考／首帧入口。
- [x] B1 统一有效引用：预览、按钮、解析及填表均以当前衔接用途叠加普通绑定；准备与最终填充使用同一份完整用途快照。
- [x] B2 修正异步边界：引用范围从原始 IR 与普通文档绑定派生；用实际源变化、人工选择变化识别失效，允许本次默认图解析和保存回写，保留切项目／镜头、改变引用和衔接时的丢弃保护。
- [x] B3 验证与记录：定向回归、Desktop 测试、类型、构建及变更文件静态检查。沿用 A4 已记录的全仓范围外失败，不声称真实项目或已运行安装包完成验收。

补修验证：Desktop 全部 78 个测试文件、708 项测试通过。新增完整 App 回归使用 Seedance 2.0 的正式参数定义，检查普通参考图／首帧两种入口的制作模式、视频正文、图片用途与生产编译输入快照；组件回归覆盖普通绑定刷新后首帧仍可填充、直接提供／异步读取 IR 下的默认角色图保存回写，以及填充期间切换项目、镜头、普通参考图或正文时丢弃旧结果。原有延迟适配器和人工修正输入回归随全量 Desktop 测试通过。

Desktop `typecheck`、生产构建、本次三个源码／测试文件的 ESLint、Prettier 与 diff 检查通过。全量 Desktop 验证后仅移除了集成测试中多余的 `act` 包装，其两种用途再次复验通过。未修改 Worker、Contracts 或 Rust，未重启现有应用或写入真实项目、设置数据库，未提交付费生成。该补修不改变产品规则，无须改写 DOCX 产品正文；A4 的范围外全仓失败记录仍然有效。

日志位于 `C:/Users/MSI/AppData/Local/Temp/`：`shot-fill-refresh-repro.log`、`shot-fill-save-repro.log` 保留修复前失败；`shot-fill-focused-final.log`、`shot-fill-desktop-final.log`、`shot-fill-app-final.log`、`shot-fill-typecheck.log`、`shot-fill-build.log`、`shot-fill-eslint.log`、`shot-fill-format.log`、`shot-fill-diff-check.log` 记录修复后验证。功能源码补修前副本保存在 `shot-fill-audit-88ec1837/ShotWorkspace.tsx`。

## 三图填充丢失补充审计与计划

用户新截图显示角色、场景、显式首帧共三张绑定图，填表后仅剩首帧。此前 B 阶段将仅保留首帧当作正确验收结果，验收目标有误：按钮可用并不等于绑定完整。

根因：App 遇到首帧选择图生视频，共享 `seedProductionInputs` 随后将全部输入过滤为首帧／尾帧。Seedance 正式参数定义确实禁止严格首尾帧与多模态参考混用，但不能因此静默删图或改变用途。此修复沿用衔接计划既有“不兼容时提示更换用途或模型，普通参考不宣称锁定首帧”的要求。

- [x] C0 审计：确认三张输入到投影前完整、投影时被过滤；核对正式 Seedance 2.0／2.5 参数互斥规则，修正此前验收目标。
- [x] C1 投影与回归：完整保留有用途的输入，显式首帧保留原位置和用途；无用途的旧 URL 输入继续按模式映射。使用截图一致的三张图回归，禁止放宽正式参数定义。
- [x] C2 明确选择：表单展示全部图片及冲突说明，冲突期间禁止提交／保存。提供“全部作为参考图”（不锁定首帧）与“仅使用首帧”（明确移除其余参考素材），选择是可编辑表单的修改，不回写镜头绑定。
- [x] C3 一致性：模式文字和自动图片说明按当前实际用途更新；手动移除、改用途及编译刷新以当前表单为准，不恢复源绑定。验证两种选择后的正式参数校验与实际提交参数。
- [x] C4 验证：Contracts／适配器／Worker 定向回归、Desktop 全量、类型与构建及变更文件静态检查。完整记录未通过项，不将模拟 Provider 验证等同于真实出片。

实施说明：互斥规则从当前模型参数定义的必需 `allOf` 条件读取，不按供应商名称猜测，也不把可选联合分支的限制视为全局禁令。不声明互斥的模型继续允许混合输入，最终仍按正式参数定义校验。单图 URL 模型完整保留待处理列表，明确选择首帧时按源首帧素材定位，避免把排在前面的角色板当作首帧。

冲突提示会滚入视野，防止旧滚动位置隐藏说明。选作参考后，原首帧图片标注为“开场构图参考（不锁定首帧）”；手动删除生成的图片说明后，编译刷新不再重新附加该说明。Worker 编译保留完整图片和源快照，同时返回用途冲突；最终提交仍使用表单参数。

### C 阶段验证记录

| 检查 | 结果 |
| --- | --- |
| 修复前复现 | 完整 App 三图用例收到 `['first_frame']`，而正确用途列表应为两张 `reference_image` 加一张 `first_frame`。修复后同一用例保留三张，显示冲突并禁止提交。 |
| 正式模型与表单 | Seedance 2.0／2.5 两种明确选择均通过正式参数校验；另覆盖 Wan／MiniMax 互斥规则、单图模型明确选取排在第三位的首帧，以及允许混用的参数定义。Desktop 验证选择、删图、人工改文案、编译刷新及实际 prepare 参数，包含编译器仍返回旧“仅首帧”结果的情形。费用确认均拒绝，不提交付费请求。 |
| 全仓测试 | `pnpm test`：2,084 项通过、2 项失败。context 8、contracts 44、LLM 32、Desktop 712、adapters 79、persistence 87 全部通过；Worker 1,122 通过、2 失败。失败仍为 A4 已复验的双协议 `CONTEXT_BUDGET_EXCEEDED`，28,001 对 28,000；不修改上下文或检索实现。 |
| 最后定向复验 | Contracts 44、adapters 79、Worker 制作编译 9 项通过；Desktop 五个相关文件 84 项通过，覆盖最后的联合分支规则和旧编译结果模拟。 |
| 类型与构建 | 全仓 `pnpm typecheck`、`pnpm build` 通过。保留 Vite 已有的主包体积提示；不代表替换了正在运行的 Tauri 实例或重打安装包。 |
| 静态检查 | 本次变更文件的 ESLint、Prettier 与 `git diff --check` 通过。全仓 Lint 仍为前述 14 项范围外错误，格式仍为前述 8 个范围外文件。 |
| 开发服务 | 只读检查 `127.0.0.1:1420/src/ProductionPanel.tsx` 已提供新的用途选择和冲突检查，并引用当前 Contracts 构建。未在用户真实项目内点击提交或声称当前 Tauri 窗口已完成实机验收。 |

C0–C4 已完成本次修复及验证工作；A4、R5／Q4 的整体门禁和实机限制继续保留。此次修复落实既有用途兼容和最终表单优先规则，没有修改已确认产品要求，因此不改写素材库 DOCX 产品正文。

日志目录仍为 `C:/Users/MSI/AppData/Local/Temp/`：`shot-fill-three-images-repro.log` 记录修复前复现；`shot-fill-three-images-all-tests.log`、`shot-fill-three-images-contracts-final.log`、`shot-fill-three-images-adapters-final.log`、`shot-fill-three-images-worker-final.log`、`shot-fill-three-images-desktop-final.log`、`shot-fill-three-images-typecheck.log`、`shot-fill-three-images-build.log`、`shot-fill-three-images-eslint.log`、`shot-fill-three-images-format-final.log`、`shot-fill-three-images-lint-all.log`、`shot-fill-three-images-format-all.log`、`shot-fill-three-images-diff-check.log` 保存结果。本次投影、参数定义读取、表单和 App 回归的修改前副本位于 `shot-fill-images-audit-78beffdb`。

## 提交按钮禁用反馈补充审计与计划

新截图显示表单底部“保存草稿”和“提交视频任务”均禁用，但没有就地解释。代码确认图片用途冲突、填充失败、表单未准备完成等状态会同时禁用两者；用途冲突处理入口与填充错误仅位于表单上方，滚到底部后不可见，草稿按钮提示也没有覆盖这些实际条件。截图本身不能区分具体拦截项；当前窗口两次只读捕获均超时，未把推测当作实机结论。

- [x] D0 审计：核对两类按钮全部禁用条件、顶部提示和底部布局，保存修改前副本。
- [x] D1 回归：复现底部缺少禁用原因和用途处理入口；覆盖填充错误、模型切换等待和编译等待后的恢复。
- [x] D2 实施：禁用状态与说明共用判定，按钮关联实际原因；底部可直接明确选择参考图或首帧，沿用完整输入和最终表单优先规则。
- [x] D3 验证：定向及 Desktop 测试、类型、构建与静态检查，记录实际结果和范围外既有失败。

本次只改表单反馈与处理入口，不修改模型互斥限制、镜头绑定或真实项目数据，不提交付费生成，不替换正在运行的应用。

### D 阶段实施与验证记录

- 草稿与提交按钮的禁用布尔值改为从同一份原因文字派生，覆盖只读、处理中、表单准备、填充错误、用途冲突、模型切换、连接／模型缺失、音频来源缺失及制作编译等待。按钮通过 `aria-describedby` 关联旁边的实际原因；编译等待只禁用提交，仍可保存当前草稿。
- 顶部与底部复用同一份用途冲突说明和处理动作。底部保留全部图片数量、参考图不锁定首帧及仅用首帧会移除其余素材的说明；处理后两处提示同步消失，人工选择仍只修改当前表单。
- 修改前新增回归有 7 项失败、1 项通过，失败直接指向缺少底部区域或按钮描述；修复后 8 项通过，涵盖 Seedance 2.0／2.5 的两种底部选择，以及填充错误、模型切换和编译完成后的恢复。
- Desktop 全部 79 个文件、713 项测试通过；全仓 `pnpm typecheck`、`pnpm build` 通过。变更源码与测试的 ESLint、变更源码／测试／样式的 Prettier 通过。全仓格式检查仍为此前 8 个范围外文件；不修改无关代码。
- 清理隔离验证页面后重新执行全仓 Lint，仍为此前 14 项范围外错误；结果见 `production-actions-lint-final.log`。本次仅修改桌面表单反馈，未重复后端测试；此前全仓测试的两项预算失败仍按 C 阶段记录保留，不声明整体门禁通过。
- 浏览器隔离验证复用实际 `ProductionPanel`、正式 Seedance 2.0 参数定义及真实样式，使用模拟 IPC 和独立端口／存储。滚到底部可同时看到实际原因、完整输入说明和两个选择；分别点击底部“全部作为参考图”与“仅使用首帧”后，两类按钮均启用，模式分别显示参考生视频／图生视频。未点击生成。临时页面与服务已清理，脚本副本留在审计目录。
- 开发服务 `127.0.0.1:1420` 返回的表单源码包含新的底部拦截说明与无障碍关联。当前 Tauri 窗口两次捕获均超时，此项仅证明源码已提供，不声称真实项目窗口完成验收。

审计副本：`C:/Users/MSI/AppData/Local/Temp/production-actions-audit-b2e11c90/`。日志：`production-actions-repro.log`、`production-actions-focused.log`、`production-actions-desktop.log`、`production-actions-typecheck.log`、`production-actions-build.log`、`production-actions-eslint.log`、`production-actions-format.log`、`production-actions-format-all.log`、`production-actions-lint-final.log`，均位于上述 Temp 目录。隔离页面的冲突与两种恢复截图位于 `C:/Users/MSI/.codex/visualizations/2026/11/02/01a19b38-3357-7a33-8c8b-beef26c552c2/production-actions-*.jpg`。本次没有修改已确认产品要求，DOCX 产品正文无需变更；A4 的既有全仓失败及实机验收限制继续保留。

## 表单提示词局部编辑被恢复补修

日期：2026-11-04。用户截图中四图参考生视频表单的“输入图片说明”难以修改。修复前使用 Seedance 2.0／2.5 正式参数定义复现：保留段落标记，只将第一张图的用途改成手写说明，两项回归均收到原自动说明。

根因：结构化 `content` 同时存放文字和图片，`updateParameter` 将所有 content 修改都当作图片输入变化，只要“输入图片说明”标记还在就重新生成整段。此前只保护整段删除，未保护段内改字、删行或删除标签。另有状态更新函数内修改 refs、编辑覆盖记录和本地记忆的副作用；React 重算更新时可能把已生成的新说明和旧输入再次比较，不能据此判定人工编辑。

- [x] E0 审计与备份：核对提示词编辑器、结构化表单、回填、编译刷新、保存和提交；新增双版本回归在修复前失败。
- [x] E1 修复：按规范化后的文字识别实际人工编辑，不将别名转标签计为改文案；任何手动文字修改后保留当前说明，只有未手改时图片输入变化才更新自动说明。参数计算和编辑记录在事件中完成，以同一份新参数更新表单和本地记忆，避免更新函数重算副作用。
- [x] E2 回归：双版本覆盖局部改写、退格删除单个图片标签、撤销、删行、默认值触发的旧编译刷新、保存草稿及实际 prepare 参数；删除正文标签仍保留四张输入图，显式重新填充恢复新的自动说明。既有两种用途选择继续验证编号、数量与开场参考语义。
- [x] E3 验证：Desktop 全量、全仓类型与生产构建、变更文件 ESLint／Prettier 和差异检查通过；全仓 Lint／格式已执行，既有范围外失败按下文保留。

本次落实既有“最终表单人工编辑优先”和“删除正文标签只删除该处引用”的规则，不改变素材绑定、模型参数限制、Worker 或存储规则，无确认产品需求变化，DOCX 产品正文无需改写。验证使用模拟 IPC，不操作用户真实项目或提交付费生成。修改前源码、既有回归和本计划副本位于 `C:/Users/MSI/AppData/Local/Temp/production-prompt-edit-audit-6178e677/`。

E 阶段最终验证：Desktop 全部 83 个文件、753 项测试通过；全仓 `pnpm typecheck`、`pnpm build` 通过，构建仅保留已有的 Vite chunk 大小警告。本次源码和回归的 ESLint、Prettier、`git diff --check` 通过。全仓 `pnpm lint` 仍为相同的 14 个范围外错误，`pnpm format:check` 仍为相同的 8 个范围外文件，未将本次通过记为全仓门禁全部通过。仅修改 Desktop 表单状态和回归，未重复无改动的后端全量测试；未改写 `PromptReferenceEditor`、模型参数定义或实际项目。

开发服务只读核对 `http://127.0.0.1:1420/src/ProductionPanel.tsx` 已返回本次的文字编辑保护、规范化比较及事件快照更新。未在用户真实窗口内点击保存或提交，未手动重启应用或打包安装新的桌面程序，不将源码已提供视为真实项目实机验收。

日志位于 `C:/Users/MSI/AppData/Local/Temp/`：`production-prompt-edit-repro.log` 记录修复前双版本失败；`production-prompt-edit-focused.log`、`production-prompt-edit-desktop.log`、`production-prompt-edit-typecheck.log`、`production-prompt-edit-build.log`、`production-prompt-edit-eslint.log`、`production-prompt-edit-lint-all.log`、`production-prompt-edit-format-all.log` 保存最终结果。E0–E3 完成本次修复及检查，既有发布验收限制保持可见。
