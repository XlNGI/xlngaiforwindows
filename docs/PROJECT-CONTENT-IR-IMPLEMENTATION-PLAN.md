# 项目内容 IR 统一中间层实施计划

日期：2026-10-21  
状态：原 P0–P4 已实施；ProductionInstruction 单路径收敛 P5–P9 已完成  
范围：项目资料（角色、场景资料、道具）、短剧场次与镜头、Agent 检索／写入、制作表单与媒体生成读取。

## 1. 审计结论

当前代码里有两种“结构”，但没有一套完整的项目内容 IR：

| 层 | 当前实现 | 边界 |
|---|---|---|
| 项目导航结构 | `ProjectStructureSnapshot`、`ProjectResourceMap`、`project_structure_nodes` | 从项目 SQLite 生成有界目录，提供 ID、标题、类型、层级、路径、版本和场镜数量；不保存语义内容，也不读 Markdown 正文。 |
| 文档结构索引 | `parseProjectStructure` 及 `project_structure_nodes` | 只按 Markdown 标题语法提取树和正文偏移，供浏览／检索定位；不会推断角色、场景、道具或绑定关系。 |
| 项目资料正文 | `documents` + `document_versions.content_markdown` | 按版本保存 Markdown；`DocumentKind` 有角色、场景，没有道具类型，也没有结构化内容 IR。 |
| 场次／镜头 | `scenes.video_prompt`、`shots.prompt`、场景角色／素材绑定 | 有提示词文本和部分关系 ID，但没有统一的 Agent 撰写 IR；制作指令另外保存。 |
| 制作指令 | `ProductionAuthoringIR` 与历史 `ProductionInstruction` 并存 | IR 已用于新工具，但旧指令仍可通过 `production.execute` 写入，并被读取、连续性检查、提示词渲染、时长更新和 Provider 编译消费，形成两套业务路径；本计划 P5–P8 收敛为 IR 唯一路径。 |

数据链路核实：

1. 普通会话上下文只提供有界资料目录／结构元数据，不自动注入项目正文；模型通过 `library.search` 获取任务内句柄，再通过 `library.read` 按需读取当前项目资料。
2. `library.read(readMode="source")` 按检索结果锁定的文档版本读取完整 Markdown 分页；目前没有可返回的内容 IR。
3. `document.submit_draft` 经过 Worker 校验、版本 CAS、文档工作流和 SQLite 事务保存版本；恢复版本会以新草稿版本写入。草稿和正式版本位于同一文档／版本表。
4. `scene.submit_structure` / `scene.structure.stage` 最终进入 `ChangeSetService`。新格式保存至 `scenes.authoring_ir_json` / `shots.authoring_ir_json`，但提交合同仍允许旧指令，变更集也暂存两种格式。
5. 制作表单经 `ProductionService.read` 读取当前提示词、场次／镜头和绑定；目前还会读取 `production_instruction_versions` 并执行旧指令图检查、渲染与回退。适配器也同时接受旧创作结构和 Provider 参数。

单路径收敛审计确认：旧 `ProductionInstruction` 不只是存档类型，仍有可执行写入入口和多个运行时消费点；`production_instruction_versions` 是旧业务数据，`production_execution_lists` 则被镜头提示词／时长 IR 写入借作幂等回执。后者必须拆出独立回执存储，不能因退役旧指令而丢掉重放保护。

结论：现有项目结构是导航 IR／元数据投影，不是角色、场景、道具内容 IR。当前最明显的职责倒置发生在场镜 Agent 写入：工具指导 Agent 填齐一组预设语义字段，而 Worker 负责渲染最终提示词；这与已确认的 Agent 规划、选字段、读资料和组合提示词的分工不符。

## 2. 已确认目标与合同

- 统一 IR 是 Agent 与应用之间可持久化、可版本定位的合同层；它不是自动注入上下文的机制。
- Agent 自己理解文本、规划、决定是否调用检索／其他工具、选择相关 IR 字段并组合面向生成的提示词。系统提示只解释 IR 边界、可用工具和安全规则，不规定语义选择清单。
- 角色资料、场景资料、道具资料均有独立的内容 IR，并与各自的文档版本共同保存。IR 的顶层格式、实体种类和 JSON 安全边界由应用校验；内容字段保持开放，不强制创作模型填写固定模板。
- 场次／镜头各有制作 IR，IR 保存 Agent 已组合的提示词、Agent 选择的真实资料 ID，以及可选的开放扩展数据。引用只用项目内 ID；不新增复杂绑定图。镜头 IR 可引用角色、场景资料、道具。
- 应用负责格式／大小／类型校验、引用 ID 的项目与实体类型校验、写入顺序、CAS、授权、调度、表单字段映射及运行安全；不按名称推断绑定，不替 Agent 选字段或重写提示词。
- 现有 `ProjectStructureSnapshot` / `ProjectResourceMap` 继续承担元数据导航；项目正文和 IR 仍仅按 Agent 明确需要读取时返回，保持草稿／正式标记、来源版本、任务范围和当前项目隔离。
- 项目资料 Markdown 与版本 IR 继续按需读取。ProductionInstruction v1/v2 仅作为迁移输入和不可执行历史归档，不保留写入、读取或生成业务逻辑；历史场次／镜头提示词原文迁入最小 ProductionAuthoringIR，已有绑定不变。

## 3. 目标数据模型

### 3.1 项目资料 IR

为 `character`、`scene`、`prop` 文档版本保存带版本号的开放合同：

```ts
interface ProjectContentIR {
  schemaVersion: 1;
  kind: 'character' | 'scene' | 'prop';
  data: Record<string, JsonValue>;
}
```

`data` 可以按具体资料选择结构字段，也能保留 Agent 认为有用的扩展；应用不为创作内容枚举必填字段。`kind` 必须与文档类型一致。Markdown 保持人类可读正文和兼容内容，不把 IR 渲染回正文。

### 3.2 场次／镜头制作 IR

```ts
interface ProductionAuthoringIR {
  schemaVersion: 1;
  kind: 'scene' | 'shot';
  prompt: string;
  references?: {
    characterDocumentIds?: string[];
    sceneDocumentIds?: string[];
    propDocumentIds?: string[];
  };
  timing?: { estimatedDurationSeconds: number; rationale: string };
  data?: Record<string, JsonValue>;
}
```

这是模型输出的创作结果，不是应用运行状态。提示词由 Agent 负责组合；`data` 允许保留站位、对白、动作节拍等 Agent 自主组织的信息。ID 是普通引用，不形成绑定图。Worker 只验证引用确实属于当前项目且文档种类有效，并对现有场次更新执行 CAS。

可选 `timing` 是面向制作时间线／生成表单的数值映射：时长由 Agent 根据内容决定，必须大于 0 且不超过 3600 秒，并附简短依据；它不要求补齐旧 v2 创作字段。`data.timing` 仍是开放描述数据，不作为运行时长。

## 4. 实施阶段

### P0：统一合同与文档

- [x] 完成本轮调用链与现状审计。
- [x] 固定导航结构、项目内容 IR、场镜制作 IR 的边界及 Agent／应用职责。
- [x] 增加本计划和检索计划的衔接说明；标明旧顺序创作设计中“系统渲染提示词”的内容由本合同取代。

### P1：Contracts 与本地持久化

- [x] 定义 JSON 值、开放项目内容 IR、场次／镜头制作 IR 和边界校验。
- [x] Schema v60 为 `document_versions` 增加可空 `content_ir_json`，为场次／镜头和变更集项目增加可空制作 IR JSON；既有行保持为空。
- [x] 打通文档版本写入、读取、恢复和 Agent 草稿保存，保证 IR 与 Markdown 处于同一事务、同一版本。
- [x] 为 `prop` 增加文档类型与角色／场景资料一致的项目页面归属和类型校验。
- [x] 覆盖旧库迁移、失败原子回滚、CAS、JSON 合同和恢复保留测试。

### P2：按需读取与 Agent 写入

- [x] `library.read` 只在模型显式读到锁定文档版本时返回同版本 `contentIR`；普通上下文／结构目录不带 IR 正文。
- [x] Agent 文档写入工具接受内容 IR 并声明清楚其开放扩展边界。
- [x] 场次／镜头工具支持 Agent 直接提交 `ProductionAuthoringIR`；引用校验只验证 ID 所属项目、类型和生命周期。
- [x] `scene.structure.stage`、普通场镜写入、审计／变更集及现有 CAS 更新都保留完整 IR。
- [x] 工具说明不再要求读取指定数量或指定字段、不再要求 `production.defaults.get`，不再强制 Agent 先填 `ProductionInstruction v2`；工具选择和资料读取由模型根据 IR 与用户任务决定。

### P3：表单／生成消费与兼容

- [x] 新 IR 保存的提示词原文直接进入场景／镜头，确定性包装只做表单需要的标题／镜头边界和参数映射，不做语义合并／重写。
- [x] 媒体准备与表单读取新 IR 的提示词和 ID 引用；已存在的 Provider 参数合同不被 IR 改写。
- [x] 旧 v1/v2 指令继续按既有 renderer 读取；旧文本无 IR 时仍然可用。
- [x] `ProductionService.read` 向授权调用方返回持久化 IR 和对应提示词；手工改提示词会原子清除过期 IR，写入 API 接受匹配的新 IR，避免静默分叉。
- [x] 覆盖新 IR 原文不变、项目引用校验、更新 CAS、旧格式兼容和生成输入映射测试。

### P4：验证与收尾

- [x] 跑合同／迁移／Worker／生成适配器／Desktop 定向测试。
- [x] 跑全仓测试、typecheck、lint、format check、`git diff --check` 和仓库要求的最终构建门禁。
- [x] 把每阶段实际完成内容和验证结果记录到本清单；未完成或因环境未运行的门禁明确标记。

验证记录（2026-10-21）：`pnpm test` 全仓 925 项通过；`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check` 和 `git diff --check` 全部通过。构建仅报告 Vite 主 JS 包超过 500 kB 的体积提示。

## 5. 风险与验证重点

2026-10-22 补充修复：P3 首次实施只保存并返回了制作 IR，缺少引用到真实场次绑定与制作输入的完整映射。现补齐普通保存／变更集／分批提交中的角色与场景绑定、单镜及分段角色范围、场景／独立道具图片解析和来源检查。Schema v61 使用一次性标记，在可写打开时修复已有有效 IR 的空关系，不从旧正文推断关系；已有人工作用的绑定和后续主动解除绑定保持。详见素材库实施计划 10.12 的清单与验证记录。本次不改变已确认产品规则。

补充验收：全仓测试 1762 项通过，最终制作／绑定定向 38 项通过；生产构建、类型、Lint、格式及 diff 检查通过。真实项目副本的 4 场／15 镜升级后关系补齐，IR 与提示词不变，二次打开不重复改写。运行中的旧 Worker 需重启应用后加载本次构建，重新打开可写项目时执行一次性兼容修复。

- `content_ir_json` 必须锁定到不可变文档版本；不能从当前文档状态误配另一个版本的 IR。
- 旧场次镜头可能有提示词、角色绑定或结构化指令；迁移以已保存的提示词列为准，只搬运显式有效的镜头时长，不从旧结构推断创作语义或关系。
- 场景资料文档 `scene` 与剧情发生单元 `scenes` 是不同实体，IR 及引用 API 必须明确区分。
- `prop` 文档类型不能误入小说章节／约束或场次 IR 校验；道具只通过真实文档 ID 引用。
- 搜索索引仍以现有可检索正文／元数据为基础；不可因为增加 IR 而把整库 IR 自动塞入上下文或未经选择就扩大搜索结果。

## 6. 验收标准

Agent 能通过现有按需检索读取指定角色／场景／道具资料的 Markdown 和该精确版本 IR，自主决定所需字段和工具，再提交包含提示词、可选开放数据与真实 ID 引用的场次／镜头 IR。应用能验证格式、项目范围、文档类型、授权和 CAS，按本地 SQLite 事务保存；制作表单只消费 IR 的 `prompt`／`timing` 与独立 Provider 参数。历史场次提示词原文得到保留，ProductionInstruction 只留不可执行归档，运行时不存在第二套旧指令写入、渲染或生成逻辑。

## 7. 镜头时长局部更新修复（2026-10-22）

会话日志暴露三个缺口：新 IR 没有被消费的时长字段；Agent 为保留正文和绑定反复读取完整 IR，混淆新旧格式并耗尽预算；普通场次提交中的 `shots` 始终创建新镜头，不能用于修改已有镜头时长。

- [x] 新 IR 增加可选 `timing`，按统一的数值／依据边界校验；不从提示词或开放数据推断秒数。
- [x] `scene.update_shot_timings` 一次更新 1–100 个已有镜头，逐镜 CAS、当前项目/session 隔离、批次原子事务和任务内幂等回执；只改时长和版本。
- [x] 新 IR 保留原始 prompt、references、data；旧指令只追加 timing 版本，保留已有过期来源检查；纯文本镜头保留正文并保存最小 IR。不重建角色／场景绑定，不新增镜头或改变顺序。
- [x] `scene.read` 结构视图增加逐镜格式与时长元数据；Native／Pi 指导明确新 IR 与旧指令的差异，时长修改无须重传完整 IR 或再次确认。
- [x] 单镜、完整场次、连续分镜段及生成表单消费该时长；保存产生现有界面刷新事件。失败提交仍阻止误报完成，成功保存不再标记为只读任务。
- [x] 定向验证覆盖 4 场／15 镜、正文与绑定不变、无重复镜头、重放／无变化、混合新旧格式、无效参数、CAS、跨项目/session、持久化失败回滚、时间线、分段和模型参数。
- [x] 完成本次全仓测试、构建、类型、Lint、格式与 diff 门禁并记录结果。

定向记录：制作／查询／时间线／时长更新 43 项通过，Agent Loop／Gateway／Pi Runtime 157 项通过，IR 合同 5 项通过。模拟 Provider 回归验证两种协议的实际授权／执行／失败重试／完成判断，未调用付费模型。测试夹具的 79 秒为合成估值，不写入用户真实项目。

最终验收：`pnpm test` 全仓 1774 项通过；`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check` 通过。构建仅保留既有 Vite 主 JS 包超过 500 kB 的提示。重启当前调试应用后加载新 Worker，再由会话对实际镜头估时／保存；本次代码修复不会自动采用日志里的未保存估值。

## 8. 提示词约束执行修复（2026-10-22）

本轮审计确认，工作流指导里的旧审核／付费边界、创作字段自主措辞、历史模板和 IR 编译范围会互相干扰，且已有镜头没有新 IR 提示词局部修改通道。此修复不建立固定创作 schema，也不让 Worker 解释或重写开放 IR。

- [x] 统一默认系统指令、制作工作流和工具合同：当前请求及明确修正优先；应用字段开放不取消本轮用户要求；草稿直接本地保存，付费提交按实际 Worker 确认流程。
- [x] `ProductionAuthoringIR.prompt` 明确为唯一生成正文；所有适用的视觉、动作、对白、音频、镜头和负面要求必须由 Agent 写入 prompt，`data` 只作补充，不参与运行时渲染。
- [x] 区分场次共享设定与完整交付正文。完整场次正文整场只消费一次；分段只继承可复用设定并拼接被选镜头，避免重复和越界动作。
- [x] 历史消息按角色、时间和消息 ID 编译为证据；用户消息中旧模板只从本次历史上下文副本剥离，数据库原消息保持不变。当前模板仍由会话编辑器显式对比／载入，保存过的模板不会被代码默认值静默覆盖。
- [x] 添加 `scene.update_shot_prompts`：对已有镜头以当前 ID／行版本原子更新提示词，保留省略的引用、时长、数据及其他对象状态；不创建镜头，不请求付费模型。
- [x] 修正文档化的字符和 IR UTF-8 字节上限、已有场次不能借新建镜头字段追加内容等工作流提示；工具加载预算继续在既有 128 KiB 限制内。
- [x] 定向回归覆盖当前／历史模板边界、完整正文原样进入制作表单、整场／分段范围、镜头提示词 CAS／幂等与回滚、两种 Agent 工具协议的写入与失败完成门禁。
- [x] 全仓测试通过（1,807 项），`pnpm build`、`pnpm typecheck`、`pnpm format:check`、`git diff --check` 通过；本次改动文件 ESLint 通过。
- [ ] 全仓 `pnpm lint`：被工作开始后出现的未跟踪文件 `apps/desktop/src/qwen-image-production.test.tsx:128` 一条 `@typescript-eslint/no-unsafe-assignment` 阻塞；保留该并行工作文件未作修改。

最终验证：`pnpm test` 按工作区顺序运行，1,807 项通过；`pnpm build` 成功，Vite 只提示主 JS 包超过 500 kB；全仓类型和格式检查以及差异空白检查通过。未调用真实或付费模型，也未修改用户项目数据。测试证明最终制作正文、工具合同和本地保存链路符合预期，不代表所有模型在所有任务中的自然语言遵循率得到保证；需重启桌面应用使新 Worker 指令生效。

## 9. ProductionInstruction 单路径收敛（2026-10-23）

用户确认：模型依据语义表达意图，应用只声明 IR 合同并按返回的 JSON 执行；冲突由 schema/API 校验和系统保护机制处理。不得让 ProductionInstruction 与 ProductionAuthoringIR 两套制作业务逻辑并存。本节取代 P3 中“旧 v1/v2 继续按 renderer 读取”的兼容决定。

### 审计记录

- 旧写入口：`production.execute` 在 Agent 工具、系统工具路由、请求校验及 `ProductionService.execute` 中仍可写入 v1/v2；`scene.submit_structure`、`scene.structure.stage`、`novel.episode.submit_structure` 与 `ChangeSetService` 也仍接受旧 `instruction`。
- 旧运行时读取：`ProductionService.latest` 从 `production_instruction_versions` 读最新版本；`read`、`readForAgent`、`queryVersion`、`compile`、提交前校验和 `inspectGraph` 消费旧对象，执行继承、来源过期检查、资源/连续性校验及旧文本回退。
- 其他旧消费者：`scene-production.ts` 继承和渲染旧字段；镜头时长与提示词服务会读旧版本、向旧版本追加时长；场景结构解析仍可规范化旧 schema。
- Adapter/UI：`packages/generation-adapters/src/production.ts` 同时做旧创作语义验证、文本渲染和 Provider 参数映射；`ProductionPanel`、`use-production-instructions`、项目默认值界面仍暴露旧状态或 style/visual 默认值。
- 持久化：数据库 schema v61 已有 `scenes.authoring_ir_json`、`shots.authoring_ir_json` 及变更集 IR 列；现有 `scenes.video_prompt`、`shots.prompt` 是已保存提示词。旧指令和执行记录分别位于 `production_instruction_versions`、`production_execution_lists`。
- 保护边界：`production_execution_lists` 仍承担 `scene.update_shot_prompts` 和 `scene.update_shot_timings` 的任务幂等；退役旧 instruction 执行不能删除这项保护。`ProductionDefaults` 混有创作 style/visual 与 provider generation 参数，需只保留后者。

### 固定迁移规则

- `ProductionAuthoringIR` 是唯一场次／镜头创作合同。新写入要求 IR；`prompt` 是唯一创作正文，`references` 和 `timing` 是明确的应用映射字段，`data` 保持开放且不被解释或渲染。
- 迁移已有提示词时，以 `scenes.video_prompt`、`shots.prompt` 已保存原文为准，逐字装入最小 IR。只有旧镜头指令中显式存在且符合当前边界的 `timing.estimatedDurationSeconds` 可迁入；不迁移／解释其他旧字段，不从文案推测时长或引用。
- 提示词列仅作与 `authoring_ir_json.prompt` 同事务更新的关系型投影；IR 是唯一权威来源。读路径不再回退到旧 instruction，也不从提示词列恢复新 IR。
- 旧 instruction 历史及其 execution receipt 保留在 archive 表中，不提供 Worker API、Agent 工具、生成读取或其他业务查询。升级时把未完成 staging/change-set 中已有最终 prompt 转成 IR 后清空旧可执行字段。
- 镜头提示词／时长写操作改用专用任务回执表保存幂等键、请求哈希和结果。Provider adapter 只接收 IR 正文／显式 timing 与 provider 参数，不解析 `data` 或创作字段。
- 项目默认值只保存 ratio、resolution、promptExtend、watermark 等 Provider 参数；style/visual 创作设置由 Agent 写入 prompt。

### 实施阶段

#### P5：审计与方案

- [x] 核实 Agent/API、Worker、变更集、adapter、UI、schema 的旧路径和幂等依赖。
- [x] 固定 IR 唯一路径、历史数据迁移／归档规则、Provider 边界和验收标准。

#### P6：Contracts 与 Agent 写入面

- [x] Agent 场镜工具、请求 schema、scene/episode/staging 只接受 ProductionAuthoringIR；手工文本及变更集在入口统一为同一 IR，删除 `production.execute` 及旧规范化逻辑。
- [x] 删除旧 renderer、旧创作校验／continuity schema 和旧 `ProductionInstruction` 运行时类型；保留 Provider 参数映射。
- [x] 更新工作流指导、查询输出和完成判断，不再提及或尝试调用旧格式。

#### P7：Worker 读取、编辑与生成

- [x] `ProductionService.read`、`readForAgent`、`queryVersion`、`compile` 和提交校验只从 IR 取提示词／时长／引用；移除旧 instruction 图、stale、inheritance、render 和 fallback。
- [x] Scene submit、shot prompt/timing updates 和 staged submit 使用一份 IR；时长更新保留 IR 的 prompt/references/data 并执行 CAS。
- [x] Adapter 与 Desktop 表单按 IR prompt/timing 编译；Provider 参数默认值与模型 form overrides 独立。
- [x] 删除 UI 和业务逻辑对旧 instruction 的呈现、修复提示及资源语义依赖。

#### P8：SQLite 迁移与历史保护

- [x] Schema v62 将旧指令和执行历史重命名为 archive；增加专用 Agent write receipt 表并迁移仍需幂等的镜头写入回执。
- [x] 幂等迁移把已有 scene/shot prompt 逐字写入缺失 IR，只搬运显式有效的 shot timing；迁移待处理 staged 数据后清空旧执行字段。
- [x] 保留场次/镜头 ID、版本、顺序、角色/素材绑定和所有已保存 prompt；迁移具备事务回滚且重复执行不改变已完成数据。

#### P9：验收与收尾

- [x] 定向覆盖 IR 提交、CAS、引用校验、生成参数映射、旧库迁移／回滚、提示词原文、显式时长、幂等重放及无旧工具注册。
- [x] 运行全仓测试、构建、typecheck、lint、format check、`git diff --check` 和桌面/Worker 必要门禁。
- [x] 记录每阶段实际结果，并确认应用路径中除 archive migration 之外不再有 ProductionInstruction 运行时引用。

P6–P8 验证记录（2026-10-23）：数据库完整测试 82 项通过；Worker 内容／变更集／IPC／Agent 流程定向 94 项通过，制作与查询定向另验证整场正文只使用一次、分段不混入整场剧情、引用失效、来源 token 失效、缺省与显式空角色范围。Native/Pi 两种协议的 24 请求预算、无变化写入、任务回执重放和输出修复均通过。运行时旧工具、旧类型、旧 renderer 和 archive 表消费搜索结果为空；旧表名只存在于历史 schema 与 v62 归档迁移。

收尾行为：

- 人工文本编辑与变更集文本编辑进入同一 IR，保留未修改的 references/timing/data，prompt 与投影同事务保存原文；IR 为空时读取不从投影列恢复正文。
- 整场优先原样消费场次 IR.prompt 一次；缺少场次 IR 才按顺序连接镜头 IR.prompt。分段只连接选中镜头的完整 prompt 和本段时长；开放 data 不提供共享正文。时长缺失时不生成可能漏镜头的自动分段。
- 人工视频衔接提示词保存到同一镜头 IR，并原子更新镜头及选帧版本；videoPrompt 仅为 IR 的读取投影。新机位首帧图提示词属于不同图像任务，保留独立可编辑草稿。
- 编译表单与付费确认后的参数快照分工明确：重新编译校验当前 token，已确认表单保留冻结内容；仍验证实际目标、项目素材和人工选帧。音色／对白在最终准备时按实际表单及 ID 映射一次，避免重复加入音频。
- v62 将没有最终 prompt 的旧 staged instruction 归档并标为待重新撰写，不渲染旧摘要；迁移保留 ID、行版本、顺序、绑定和原始提示词，提供原子回滚与重复执行保护。

P9 最终验收（2026-10-23）：固定代码后的 `pnpm test` 全仓 1,702 项通过（context 8、contracts 30、LLM 32、Desktop 532、generation-adapters 67、persistence 82、Worker 951）。`pnpm build`、`pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`git diff --check`、`cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml`、`pnpm worker:sidecar` 均通过。最新独立 Worker 的 M7 离线诊断与完整性验证通过；`validate-llm-intent-sidecar.mjs` 语法检查及 8 组离线流程通过，覆盖两种协议、两个运行入口及有／无意图提示，Provider 请求数为 0。构建仅保留既有 Vite 包体提示和 Tauri 无关未使用变量提示。

实际业务数据未被本轮验证修改，迁移在临时数据库／项目中验证；未调用真实或付费生成模型。运行中的应用需加载本次构建的新 Worker 后使用新合同；本轮未安装覆盖用户应用。
