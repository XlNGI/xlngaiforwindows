# 提示词约束执行审计

日期：2026-10-22。范围：当前工作区源码，包含审计开始前已有的未提交修改。

用户反馈：生成的提示词没有按要求制作，约束被无视。本次只审计、复现和记录问题，不修改运行时行为或已确认的产品要求。

## 结论

代码中存在会让约束相互竞争、内容在交付时遗漏、以及错误结果被当作成功保存的具体缺口。没有证据表明会话约束在发送入口被普遍漏传；也不能仅凭静态代码确定用户某一次模型输出的唯一原因。

最值得先处理的是：旧系统指令与当前操作合同冲突；工具指导没有区分“应用不强制创作字段”与“用户指定的字段必须满足”；`data` 中的创作内容不进入生成提示词；完整场次正文与逐镜正文重复组装；旧会话约束进入系统上下文且没有明确的失效边界。

## 实际调用链

1. `apps/desktop/src/use-conversation-prompt-template.ts:98`：发送前等待模板加载，保存当前编辑，取得本次实际模板。
2. `apps/desktop/src/conversation-prompt-template.ts:66`、`apps/desktop/src/App.tsx:2698`：将模板和请求组合为同一个用户输入，分别带“本会话要求约束”和“用户本次请求”标记。
3. `apps/worker/src/generation-service.ts:1020`、`:1161`：编译资料目录和会话历史，保存完整用户消息；另外保存 `user_request`、`session_constraints`。
4. `packages/context/src/index.ts:92`：提供默认系统指令。
5. `apps/worker/src/generation-service.ts:501`、`apps/worker/src/pi-conversation-runtime.ts:288`：根据初始工具附加检索／系统政策。普通 Pi 会话先提供核心工具，其他工具按需加载。
6. `apps/worker/src/pi-conversation-runtime.ts:956`、`:960`：追加统一 Agent 指令，将编译上下文拼入系统提示中的 `[FROZEN PROJECT CONTEXT]`。
7. `apps/worker/src/agent-provider-tool-gateway.ts:245`：`tools.load` 返回相应工作流指导；制作工具描述还附加 `PRODUCTION_AUTHORING_GUIDANCE`。
8. Agent 生成 `ProductionAuthoringIR` 或兼容旧指令，Worker 校验并保存；`ProductionService.read/compile` 将正文交给制作表单及生成适配器。

因此，本次用户约束处于用户消息中，系统提示、历史上下文和工具指导则同时影响模型。`session_constraints` 已持久化，但当前没有用它与最终提示词逐条核对的独立验收过程。

## 主要发现

### F1 · P1：系统提示仍包含与当前流程冲突的旧规则

位置：`packages/context/src/index.ts:95`、`:99`；`apps/worker/src/agent-tool-definitions.ts:674`；`apps/desktop/src/conversation-prompt-template.ts:61`。

默认系统指令写着：

> 用 scene.submit_structure 保存待审核方案，批准后进入目录。
>
> 不要替用户填写或提交生产 API 参数。

当前工具却说明场次／镜头直接保存为可编辑草稿，`resourceMap` 也说明无需用户确认。用户模板明确要求根据制作范围填写生成方式、画幅、分辨率、时长及音频等字段，实际付费提交另行确认。

前一条会让模型误以为保存草稿也必须等批准；后一条将“本地准备表单”和“向供应商提交付费请求”一并禁止。系统级规则可能压过用户的填表要求。临时项目实际编译结果确认这两句仍存在，不是仅留在文档里的旧文字。

修复方向：统一草稿保存、准备表单、选择模型和付费提交的边界；保留 Worker 实际需要的确认，不用笼统系统禁令覆盖已授权的本地准备。

### F2 · P1：创作内容可以完整保存在 data，却完全不进入有效提示词

位置：`apps/worker/src/production-authoring-guidance.ts:5`、`:9`；`apps/worker/src/agent-workflow-guidance.ts:23`；`apps/worker/src/production-service.ts:599`、`:835`。

指导告诉模型额外创作字段放入 `authoringIR.data`，但有效提示词只消费 `authoringIR.prompt`。应用按既定职责不会将开放 `data` 渲染成自然语言。这一合同本身合理，缺口在于指导没有明确说明：用户要求影响生成画面的内容，即使已放入 `data`，仍必须在最终 `prompt` 中表达。

临时项目复现输入：

```json
{
  "schemaVersion": 1,
  "kind": "shot",
  "prompt": "甲走向门口。",
  "data": {
    "audio": "甲逐字说：请开门。",
    "camera": "固定机位，无运镜。"
  }
}
```

保存成功后，读取的有效提示词只有“甲走向门口。”。`data` 中的对白和无运镜要求均仍在数据库，但不在 `compiledPrompt`。这会表现为模型好像记录了要求，实际制作时要求却没有生效。

修复方向：明确 `prompt` 是生成时消费的创作正文；`data` 是补充结构。由 Agent 在提交前将本次适用要求落实到 `prompt`，保持开放 IR，不恢复由 Worker 选字段／重写提示词的旧设计。

### F3 · P1：完整场次要求与编译器重复拼接，分段会带入其他镜头动作

位置：`apps/desktop/src/conversation-prompt-template.ts:60`；`apps/worker/src/production-service.ts:721`、`:735`；`apps/worker/src/scene-production.ts:198`。

模板要求场次提示词包含所有镜头的完整正文。编译器却将场次 `authoringIR.prompt` 一律视为共享文本，再追加当前镜头的全部正文；分段时也原样保留这份场次正文。

临时项目按照模板保存：场次正文包含“镜头一：甲走向门口；镜头二：乙关窗”，两个镜头分别保存各自动作。

实测：

- 整场编译中，“甲走向门口”出现两次。
- 仅指定镜头一的分段中，仍包含镜头二的“乙关窗”。

这直接违背只制作本段镜头的范围要求，也可能让已修订镜头与场次里旧副本的动作同时存在。

修复方向：明确可用于继承的共享设定与整场完整交付文本各自的合同；完整场次／分段不能都无条件使用同一段包含全部动作的正文。不宜靠关键词删除用户正文，也不能只添加一句“忽略其他镜头”掩盖仍存在的动作要求。现有新旧 IR 兼容及用户可编辑原则需要保留。

### F4 · P1：旧模板随历史进入系统上下文，当前约束没有清楚的覆盖边界

位置：`apps/worker/src/context-service.ts:84`；`apps/worker/src/pi-conversation-runtime.ts:960`；`packages/persistence/src/task-history.ts:24`。

历史消息直接以 `user: ...` / `assistant: ...` 字符串拼接，其中包含每轮完整的旧模板；最近最多 12 条完整消息被编入上下文。Pi 再把它们合入系统提示。虽然外层标记是项目上下文，历史消息没有恢复成独立的原生 user/assistant 消息，也没有专门标记旧模板已经失效。

临时项目保存了一条带“旧约束：必须有背景音乐”的旧请求；下一次上下文编译仍包含这条旧约束。当前新模板则位于新的用户输入中。代码缺少明确规则说明：当前请求和当前模板优先，旧请求中的约束只解释历史行为。

这是可验证的上下文组织问题；模型会否实际优先旧规则，仍需要失败轮次的请求与响应证据。不能把“进入系统提示中的引用文本”直接等同于“模型一定把它当系统命令”。

修复方向：保留对话历史的来源与角色边界，标记历史要求的适用轮次，明确当前约束和当前用户修正的优先关系，避免把旧模板反复当作当前有效要求提供。

### F5 · P2：工具指导强调没有必填创作字段，却没有明确保留用户的交付要求

位置：`apps/worker/src/production-authoring-guidance.ts:3`；`apps/worker/src/agent-workflow-guidance.ts:23`；`apps/worker/src/agent-tool-definitions.ts:291`。

多处指导强调“no required ... field checklist”“no mandatory creative schema”“You decide ... which fields to use”。这是“不由应用固定创作 schema”的已确认边界，并不意味着用户指定的对白、时间、站位、风格等可以不做。

但当前指导没有明确区分这两层含义，也没有交付前按当前用户要求核对遗漏的工具级说明。模板虽有自检条款，模型仍会同时看到较晚返回、措辞很强的字段自主权说明。

这是指令歧义风险，不是已证明模型必然忽略约束的证据。修复应澄清“应用不额外强制语义字段；本次用户明确要求仍须落实”，不要通过新增固定系统创作模板破坏开放 IR 决策。

## 其他已核实缺口

| 项目 | 证据与影响 | 优先级 |
| --- | --- | --- |
| 已有会话持续使用旧模板 | `use-conversation-prompt-template.ts:74` 仅在没有保存记录时使用代码默认模板；保存过的会话继续原文。修改默认模板不能修复这些会话。需显式提示可比较更新，并保护用户编辑，不能静默覆盖。 | P2 |
| 字符限制与真实字节限制不一致 | 工具 schema 允许 prompt 最多 20,000 字符，`project-ir.ts:72` 又限制整个 IR 最多 32 KiB。实测 11,000 个普通汉字（33,000 字节）即失败，尚未计算字段、references 和 data。错误不会静默裁剪，但可能引发模型反复压缩或修复输出。 | P2 |
| 已有镜头正文缺少等价的新 IR 编辑通道 | `scene.submit_structure` 不接受逐镜 shotId/CAS 更新；`episode-structure.ts:157` 还禁止已有场次带非空 shots。新 IR 指导说修改既有 ID，但 `production.execute` 只接收旧 ProductionInstruction；`scene.update_shot_timings` 只改时长。普通会话要原样保留新 IR 修改镜头正文，当前工具链不完整。 | P2 |
| 保存成功没有验证语义要求全部满足 | `validateProductionAuthoringIR` 校验形状、大小、类型、引用；保存后的 readiness 关注制作状态，不能判断用户自然语言要求是否遗漏。现有 `inspectProductionPrompt` 的少量提醒主要消费旧指令字段，新开放 data 不自动获得同样检查。成功保存不能代表已按要求验收。 | P2 |

已有镜头编辑的临时复现返回：`Episode scene 0 shots must contain between one and 30 items.`。实际输入只有一个镜头，但由于包含已有 sceneId 被拒绝，错误文案也没有说明真正限制。

## 已排查的发送环节

- 前端发送会等待模板加载／保存，模板保存失败会阻止发送。
- 当前模板和请求按同一规则组合；所查参数继续流程没有重复追加模板。
- 重试使用原轮次保存的完整请求，不会自动换成后来修改的模板；排查时应区分“重试旧任务”和“按新约束发新请求”。
- 当前用户输入不会被 `AgentContextBudget` 主动截断；它优先整理有版本定位的旧读取结果，超预算时失败。
- 普通项目文档、生产约束和正文没有被改成整库自动注入。本次审计不建议恢复该行为。

这些结论限定于已检查入口和测试范围，不代表已验证所有 Provider 的实际长输出行为。

## 验证

共 92 项已有定向测试通过：

| 范围 | 数量 |
| --- | --- |
| Desktop 模板正文／模板加载保存 | 6 |
| Desktop 请求组合／附件参数继续入口 | 3 |
| Worker 制作服务／场次编译／文档类型／Gateway／Pi Runtime | 75 |
| Context 编译 | 8 |

另通过一次独立脚本调用真实本地服务，在自动清理的临时项目 SQLite 中验证：正文重复、分段越界、data 未进入有效提示词、旧模板保留、编译结果仍包含旧系统指令、中文字节上限、已有镜头新 IR 编辑被拒绝。未修改真实项目，未请求付费模型。

未改动产品源码，因此本次未运行全仓最终门禁；上述测试不等同于实际模型对自然语言约束的遵循率评测。后续修复应增加针对最终有效 prompt、当前／历史约束边界和存量会话模板行为的回归，再运行适用的仓库质量门禁。

## 建议处理顺序

1. 统一默认系统指令与当前草稿／制作流程，明确当前用户要求的优先关系及历史要求的轮次边界。
2. 明确开放 IR 与用户交付要求的区别，要求所有影响生成的约束进入 Agent 撰写的最终 prompt。
3. 修复完整场次、共享设定和分段编译合同，并验证单镜／整场／分段实际传给制作表单的正文。
4. 补齐已有镜头正文的新 IR 局部修改通道，对齐字节限制说明和存量模板更新方式。
5. 增加按本次要求核对交付的回归；保留非阻断创作提醒、用户可编辑、本地优先、按需检索和开放 IR 的既定产品边界。

## 修复记录（2026-10-22）

上述问题已按既有 IR／检索合同修复，产品职责边界保持不变：Worker 校验结构、项目范围、引用类型、授权和 CAS；Agent 解释创作要求并撰写最后的生成正文。

- 系统提示和制作工作流去除互相冲突的“等待审核”和笼统禁止准备制作参数的规则，明确当前请求、当前会话要求及本轮修正的优先关系。保存草稿可立即编辑；实际付费提交仍服从 Worker 的确认流程。
- 指导明确 `authoringIR.prompt` 才是生成实际消费的正文。用户要求的创作内容必须写进 prompt，开放 `data` 不会被 Worker 渲染或自动并入。工具说明不再用“无必需语义字段清单”措辞削弱该规则。
- 新增场次 `promptScope` / `sharedPrompt` 合同。完整场次正文不会再重复拼入每个镜头或泄漏到其他镜头分段；既有 IR 未指定 scope 时仍按原共享文本兼容。
- 历史记录恢复角色／消息 ID／时间边界，并从编译上下文副本中剥离历史用户消息附带的旧模板；存档消息本身未改写。存量会话模板新增“查看最新版”和显式载入入口，保留保存过的用户文本。
- 新增 `scene.update_shot_prompts`，对已有镜头按 ID／行版本原子编辑开放 IR，处理冲突时不重建镜头；同时校正字节限制和场次追加工具的说明。
- 按工作区顺序运行 `pnpm test`：1,807 项通过；`pnpm build`、`pnpm typecheck`、`pnpm format:check`、`git diff --check` 通过。本次修改文件 ESLint 通过。全仓 `pnpm lint` 仍有一条并行桌面测试错误：`apps/desktop/src/qwen-image-production.test.tsx:128` 的 `no-unsafe-assignment`。未修改该未跟踪文件。
- 未调用真实／付费模型，未修改用户项目数据库。回归验证应用编译正文、工具加载和保存行为，不替代真实 Provider 对自然语言约束的统计性评估。重新启动桌面应用后，新 Worker 才会提供更新后的上下文及工具说明。
