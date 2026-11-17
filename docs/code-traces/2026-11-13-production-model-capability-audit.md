# 生产面板按模型能力显示连接审计

日期：2026-11-13，时区 Asia/Shanghai。范围：生产连接与模型能力筛选审计、修复及验证，未修改用户配置。下述发现与复算记录描述修复前行为；修复结果见文末。

## 结论

截图中的 `ergou-gpt-chat` 确实不应出现在文生图连接列表。它的已启用模型没有图片生成能力。问题发生在生产面板构造连接候选集合时：以连接类别、协议、供应商类型和全局适配器存在性代替该连接下的实际可用模型能力。

模型下拉框有能力过滤，但连接下拉框没有利用过滤后的模型集合；因此会出现「连接可选，点进去却没有兼容模型」。这影响图片、视频和音频模式。

上一轮 GPT 参考生图补修解决了缺少编辑适配器和传输路径的问题，但沿用了此连接筛选逻辑；新增测试未覆盖同时存在纯聊天连接和图片连接的排除场景，验收不完整。

## 本地配置证据

只读查询 `app-settings.sqlite` 的连接和模型元数据，未读取凭据或修改数据库。以下均是未归档、启用且 ready 的连接，只统计已启用且未 unavailable 的模型：

| 连接 | 连接 category | 已启用模型实际能力 | 文生图应显示 |
| --- | --- | --- | --- |
| `ergou-gpt-chat` | `multi` | 仅 1 个 `gpt-5.6-terra`；text、vision 等为 true，imageGeneration、imageEditing、videoGeneration 均为 false | 否 |
| `gpt-image` | `llm` | 3 个已启用 GPT Image 模型，imageGeneration、imageEditing 均为 true | 是 |
| 万相视频（百炼官方） | `multi` | 3 个已启用视频模型，imageGeneration、imageEditing 均为 false | 否 |

`vision` 表示图像理解，不能作为图片生成能力。连接的 `llm`、`multi` 类别也不能代替模型能力：`gpt-image` 虽归在 `llm`，仍应按其明确配置的图片能力显示。

## 发现一：连接候选没有检查该连接下的可用模型

位置：`apps/desktop/src/ProductionPanel.tsx:834`，优先级 P2。

- `customMediaAdapterAvailable` 只问全局目录是否存在当前模式的 custom 适配器。只要存在一个通用生图或视频适配器，所有符合类别/协议的自定义连接都会通过；不检查各连接实际有哪些模型。
- `officialMediaProfile` 直接放行 Wan、Seedance、MiniMax Video 等供应商类型，后续 `category === 'multi'` 又绕过当前制作模式的分类判断。于是仅有视频模型的万相连接也进入图片、音频列表。
- `provider.model.list` 直到连接选中后才调用（第 915 行），`modelOptions` 才按模型能力与适配器绑定过滤（第 1068 行）。`eligibleProfiles` 既没有所有连接的模型数据，也不依赖兼容模型结果，无法正确实现按能力显示。
- 第 901 行还会优先恢复这个过宽集合里的历史连接，或选择第一个连接；当它没有兼容模型时，不会自动退回真正可执行的连接。

### 复算结果

执行当前文件中原样提取的 `eligibleProfiles`、`modelOptions` 表达式，输入只读设置快照和当前构建的适配器目录。以下连接被显示，但各自的 `modelOptions` 数量为 0：

| 当前模式 | 错误显示的无兼容模型连接 |
| --- | --- |
| 文生图 | `ergou-gpt-chat`、万相视频 |
| 参考生图 | `ergou-gpt-chat`、万相视频 |
| 文生视频 | `ergou-gpt-chat`、`gpt-image` |
| 音频生成 | UniCompAPI、万相视频 |

`gpt-image` 在文生图、参考生图均得到 3 个兼容模型，符合其明确配置的能力。

日志：`.codex-production-capability-audit.log`。这验证的是原有筛选表达式和已存元数据，不冒充安装版完整 UI 或真实 Provider 调用测试。官方模型读取时还可能执行合同元数据归一化，但不影响上述纯聊天/仅视频连接的反例。

## 发现二：准备和最终提交的能力门槛不一致

位置：`apps/worker/src/handler.ts:267` 与 `apps/worker/src/media-preparation-service.ts:1033`，优先级 P2。

`resolveMediaSelectionForRequest` 对全部参考生图使用 `imageEditing || imageGeneration`；而生产面板和 `modelSupportsMediaAdapter` 对通用 OpenAI Images 编辑适配器要求 `imageEditing === true`。

用同一份模型快照在内存中设置 `imageGeneration=true, imageEditing=false`，执行现有函数：参考生图的直接请求选择校验通过，共享的提交能力校验返回 false。调用链中 `image.generate.prepare` 使用前者，`MediaOrchestrationService` 最终提交复核使用后者，因此可能先准备出不能提交的草稿。

日志：`.codex-media-capability-consistency-audit.log`。该复现没有创建任务或修改用户模型，也没有发送网络请求。最终提交仍会拒绝不匹配模型，不能据此声称纯聊天模型已被发往付费图片接口。

## 来源与测试遗漏

Git 历史显示，过宽的 custom/official 连接筛选出现在 `5ced120`（2026-11-09）。上一轮工作区补修改了官方 OpenAI 的可见分支并新增参考生图适配器，保留了这套筛选；新增适配器也让此前被隐藏的问题扩展到了参考生图模式。

`ProductionPanel.openai-images.test.tsx` 只提供一个可执行连接，检查连接内部的模型过滤。原有多连接测试关注独立选择和不同供应商适配器隔离。它们没有断言「纯聊天连接/只有停用模型的连接/只有视频模型的连接应从图片模式隐藏」，因此此前相关回归通过不能证明连接列表正确。

## 修正原则与验收要求

应先构建当前模式的可执行模型候选，再从候选反推出供应商连接。每个候选同时满足：连接启用且 ready、路由可执行、模型启用且可用、模型具有当前模式要求的能力、适配器/合同绑定有效、Schema 允许执行。连接至少有一个这样的模型才显示。

模型能力决定任务资格；类别、连接名称、协议兼容或全局存在一个适配器都不能单独授予任务能力。保留真正的协议/认证/执行路由限制，统一 UI、Agent 候选、直接准备和最终提交的资格判断，避免继续复制几套不同的业务条件。参考生图仍需尊重已确认的模型合同及输入模式语义，不能用统一名称正则替代合同能力。

后续实现至少验证：

- 纯聊天连接在图片/视频模式隐藏；视觉理解能力不授予生成能力。
- `gpt-image` 按明确模型能力显示，不因连接 category 为 `llm` 被隐藏。
- 仅视频连接在图片/音频模式隐藏；一个连接内混合能力模型分别按模式显示。
- 无模型、全部停用、全部不可用、无适配器或合同不可执行的连接隐藏。
- 能力或启用状态变化后，连接、模型、历史选择一起更新；没有兼容模型时进入明确空态。
- 草稿准备与最终提交对同一模型给出一致判定，仍在提交时重新检查最新状态。

上述审计阶段仅记录原因；用户确认修复后，按下述范围完成实现。未改变产品合同、素材库或项目检索行为。

## 修复记录

- [x] 生产面板在加载设置时读取所有连接的模型，按当前模式计算兼容模型，再只显示至少有一个兼容模型的连接。连接和模型下拉框使用同一份候选结果。
- [x] 保留连接启用、ready、协议执行路由、模型启用与可用状态、适配器绑定等限制。模型能力决定任务资格，官方连接不再因 category 与当前模式不一致而错误隐藏或放行。
- [x] `gpt-image` 的 category 为 `llm` 时仍显示其生图模型；纯聊天、只有视觉理解、仅视频、无模型、模型全部停用或不可用、适配器不匹配的连接从图片模式隐藏。
- [x] 统一 `modelSupportsGenerationAdapter`，供前端、Agent 媒体适配器匹配、直接准备和最终提交的能力复核共用。通用 OpenAI Images 参考生图明确要求 `imageEditing`，不再仅凭 `imageGeneration` 准备不可提交的草稿；其他已确认参考生图合同保留原有能力语义。
- [x] 设置刷新时原子更新连接和模型快照；模型读取失败仅排除对应连接，过期异步结果不覆盖新设置。历史选择失效时回退到兼容连接，没有候选时显示“没有可用连接”。
- [x] 补充多连接、多模式、混合能力、设置刷新、历史选择失效、读取失败与异步竞态的 UI 回归。Worker 通过隔离的测试设置和临时项目验证：只有生成能力的模型无法准备通用参考生图；补齐编辑能力后可准备本地任务。测试未调用付费生成接口。

此次共享的是模型能力规则与适配器绑定规则；各执行入口仍保留其参数、Schema、凭据与任务状态校验，没有新增 Schema 状态接口。

## 修复验证

2026-11-13 本轮验证通过：

- Contracts：6 个测试文件、49 项通过。
- Generation adapters：6 个测试文件、83 项通过。
- Desktop：全部 8 个 `ProductionPanel` 测试文件及 `qwen-image-production`，9 个文件、98 项通过。
- Worker：`handler`、`media-preparation-service`、`media-orchestration-service`、`image-generation-service`，4 个文件、143 项通过。
- 全仓 `pnpm typecheck`、`pnpm lint` 通过；本次修改的 TypeScript 文件 Prettier 检查及 `git diff --check` 通过。

共 373 项测试。相关本地日志：`.codex-capability-fix-contracts.log`、`.codex-capability-fix-adapters.log`、`.codex-capability-fix-desktop.log`、`.codex-capability-fix-worker.log`、`.codex-capability-fix-typecheck.log`、`.codex-capability-fix-lint.log`。

这验证了代码及隔离环境中的 UI/IPC 行为；未安装、重启用户应用，也未向真实 Provider 提交生成请求。

## 安装包

`pnpm tauri:build` 成功，重新构建了 Worker sidecar、前端及 Windows 原生程序。安装包包含本次能力筛选修复及此前 GPT 参考生图、Agent 工具传输名称修复。

- 路径：`apps/desktop/src-tauri/target/release/bundle/nsis/unicomp_0.1.0_x64-setup.exe`
- 文件时间：2026-11-13 20:48:21（Asia/Shanghai）
- 大小：77,272,340 字节
- SHA256：`361C70A97B68099791D8AB5E2CD26247723F89C198372DF03C1EE5131D8357DA`
- 构建日志：`.codex-capability-fix-installer-build.log`
