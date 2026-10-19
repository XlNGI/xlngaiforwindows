# 视频模型官方制作指南与当前代码对照

核查日期：2026-10-18。范围：官方制作/提示词指南、相关官方 API 文档，以及当前工作区源码。本文件是研究与优化建议，不是已实施能力清单；本次未修改业务代码，未调用计费生成。

## 1. 结论

当前项目已经有结构化创作指令、素材用途、模型 Schema、渠道绑定及来源复验，但尚未形成从视觉设计、生成段规划到成片采用的完整制作流程。优先优化的是模型与任务对应的提示词编译、连续动作分段、空间构图依据和前后段衔接。

官方指南并不支持一种适用于所有模型的固定策略：Kling 3.0、万相 3.0、Seedance 的指南明确给出多镜头组织方式；Runway 的指南同时强调简单动作、逐步迭代及末帧续接。模型接受长提示词，不等于能可靠执行任意数量的切镜和动作。

JSON Schema 描述字段、取值、数量和组合是否合法，不能单独表达模型的叙事可靠性、切镜偏好、空间保持程度。制作策略需要有来源和具体修订的合同语义；渠道是否支持输入上传继续归 Binding。策略元数据不能作为所有 API 都必须携带的新参数。

## 2. 实际读取的官方依据

| 模型或工具 | 官方页面中的具体指导 | 对本项目的含义 |
| --- | --- | --- |
| 万相 3.0 | 官方 Prompt 指南区分主体、运动、风格、音频、故事板、关键帧、编辑和延长；多镜头按总体描述、参考素材、分镜顺序及时间段组织。多主体示例明确要求上一镜结束姿势与下一镜起始姿势衔接，站位、重心和受力方向延续。 | 可以采用明确的多镜头生成段；需要角色与空间锁定、分镜时间轴，不能只有整场摘要。 |
| Seedance 2.0/2.5 | 2.0 Prompt 指南把复杂视频组织成时间线故事板，分别描述人物、地点、动作及摄影机；官方使用指南区分主体、动作/运镜、风格、音色与音频内容的参考用途。严格首尾帧应使用 first_frame/last_frame，提示词里的首尾帧描述仅是间接控制。2.5 指南建议线稿故事板，并警示时间段内内容过多会导致过度切镜或剧情遗漏。 | 参考素材需要标明具体用途；分段必须考虑动作密度。扩展、编辑、严格首尾帧应采用不同任务规则。 |
| MiniMax H3 | 官方用法区分文生、首尾帧、多模态参考。亮点示例分别指定人物、场景、资产、品牌图，以及“图 1 为分镜/节奏、图 2 为固定人物”的用途。Context-IR 返回增强提示词，不直接生成视频。 | 保留素材用途并让提示词引用对应对象；提示词增强应是可检查的独立步骤，不能自动代替视频生成或改写已确认剧情。 |
| Vidu Q3/Q4 | 官方参考生视频区分普通图片与 Subjects；Subjects 用名称指代。首尾帧接口明确第一张是开始、第二张是结束；Q4 文档声明参考声音和多机位一致性。 | 把角色身份与临时画面输入分开；主体注册、首尾帧、音频要按具体合同和渠道支持情况启用。Q4 存在官方文档不代表当前渠道已接通。 |
| HappyHorse | 官方参考生视频要求按 media 顺序用 [Image 1] 等指代，并说明具体对象；seed 只提升可复现性，官方明确不保证完全一致。 | 编号绑定要跟随实际提交顺序；不能把 seed 作为位置、人物或跨镜连续性的保证。 |
| Kling 3.0/Omni | 官方用户指南有 Multi-Shot/Custom Multi-Shot，可控制镜头时长、景别、角度、内容和运镜；Element Library 通过多视角图像或视频建立可复用主体，并可为角色绑定声音。 | 连续段可以使用原生多镜头方式；角色主体能力与原生镜头字段应登记为具体合同语义，不能只拼成长 prompt。用户界面功能不能未经 API 核查就视为当前渠道能力。 |
| Runway | 当前 Image to Video 指南说明输入图承担主体、构图、光线和风格，提示词聚焦运动；给出最后一帧作为下一段输入、剪辑时去掉共有帧的流程。References 文档可用草图、位置框和视线标记控制图像构图。Gen-4 指南明确偏好正向描述，避免否定提示词和过度复杂的多重变化。 | 先准备确认过的构图画面，再描述动作；将身份参考与空间构图参考分开。否定约束不能统一照搬到所有模型。 |

### 官方链接

1. 万相：[3.0 Prompt 指南](https://help.aliyun.com/zh/model-studio/wan3-video-generation-prompt-guide)、[通用视频 Prompt 指南](https://help.aliyun.com/zh/model-studio/text-to-video-prompt)、[3.0 API](https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference)。
2. Seedance：[2.0 Prompt 指南](https://docs.byteplus.com/en/docs/modelark/seedance-2-0-prompt-guide)、[2.5 Prompt 指南](https://docs.byteplus.com/en/docs/modelark/seedance-2-5-prompt-guide)、[2.0 使用指南](https://docs.byteplus.com/en/docs/modelark/seedance-2-0)。BytePlus 与火山引擎的地区、具体远程模型及修订需要分别核对，不能直接互换。
3. MiniMax：[视频生成](https://platform.minimax.cn/docs/guides/video-generation)、[H3 亮点与提示词示例](https://platform.minimax.cn/docs/guides/video-prompt)。
4. Vidu：[Q3 参考生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/reference-to-video)、[Q3 首尾帧](https://platform.vidu.com/docs/api-reference/video-models/vidu-q3/start-end-to-video)、[Q4 参考生视频](https://platform.vidu.com/docs/api-reference/video-models/vidu-q4-preview/reference-to-video)。
5. HappyHorse：[参考生视频 API](https://help.aliyun.com/zh/model-studio/happyhorse-reference-to-video-api-reference)。
6. Kling：[3.0 用户指南](https://kling.ai/quickstart/klingai-video-3-model-user-guide)、[3.0 Omni 用户指南](https://kling.ai/quickstart/klingai-video-3-omni-model-user-guide)、[Element Library](https://kling.ai/quickstart/klingai-element-library-3-user-guide)。
7. Runway：[当前图生视频指南](https://help.runwayml.com/hc/en-us/articles/48324313115155-Image-to-Video-Prompting-Guide)、[Gen-4 指南](https://help.runwayml.com/hc/en-us/articles/39789879462419-Gen-4-Video-Prompting-Guide)、[References](https://help.runwayml.com/hc/en-us/articles/40042718905875-Creating-with-Gen-4-Image-References)、[构图草图用例](https://help.runwayml.com/hc/en-us/articles/41170686463635-Advanced-References-Use-Cases)。网页被拦截时通过同站公开 Help Center JSON 接口读取正文；Gen-4.5 图生指南与 Gen-4 的具体建议分别注明，未混用为相同版本能力。

访问边界：也尝试读取 Sora 的官方 OpenAI 文档（developers.openai.com 与 platform.openai.com），返回 403；Veo 的 Google 官方指南域名连接超时。本次不把这两者的未读取内容作为依据，不用第三方转载代替官方结论。

## 3. 对当前代码的具体优化建议

### P0：按模型和生成方式编译提示词

位置：`packages/contracts/src/production.ts` 的 `renderProductionInstruction`，`packages/generation-adapters/src/production.ts` 的 `compileProductionParameters`。

目前主要区分“生图片”和“生视频”，文生视频、首帧动画、参考视频、编辑与延长仍使用接近同一份文本。整套叙事目的、风格、人物外观、相机、节拍和前后状态往往重复出现。

建议保留完整业务指令作为可编辑来源，但按任务编译：

- 文生视频：主体、空间、动作、摄影机、风格及必要声音。
- 首帧生视频：以确认画面为视觉依据，重点输出动作、方向、运镜、节奏及必要对白；不重复改写既定人物和构图。
- 参考生视频：先说明每个参考对象的身份和用途，再描述场景关系及动作，区分身份图与故事板。
- 原生多镜头：输出模型支持的镜头结构或清晰的分镜时间段；不支持结构字段时只使用官方认可的文本方式。
- 视频编辑/延长：明确原片、保持项、改变项、起止位置及新增内容；不按从零生视频重述全部剧情。

当前渲染相机使用 `Object.values`，字段名会丢失。应保留“景别、角度、运动方向、起始构图、结束构图、轴线”等语义标签。静态画面编译虽然去掉了动作节拍，仍需检查相机运动、结束构图等动态信息是否残留。

当前统一把负向内容拼为“避免……”也应改成模型规则：万相允许负向清单；Runway Gen-4 官方偏好正向状态表达，例如把“不要移动镜头”写成“固定机位”。无法等价转写的要求应保留供检查，不静默丢弃。

### P0：把“按时长装入”升级为生成段规划

位置：`apps/worker/src/scene-production.ts:168` 的 `planProductionSegments`。

当前贪心合并相邻镜头，只要 `duration` 字段可以容纳就继续合并。没有判断该模型是否适合多镜头、切镜数量、动作密度、连续表演或说话轮次，也没有在规划时联合检查分辨率和输入组合条件。

建议增加合同级制作说明：是否支持单镜/多镜、是否有原生镜头结构、可用衔接方式、参考语义、提示词风格及证据来源。它们是内部元数据，不能变成所有供应商请求的必填参数。

规划输入应包含“不可中断的动作/对白、允许切点、景别变化、机位、声音方式、参考资产”和实际模型约束。输出可以是单镜、同场多镜段、首尾帧过渡或原视频延长。超过容量时优先在自然动作或对白边界分段，不能纯按总秒数打包。剧情结构保持原样，生成段只是执行安排。

### P0：空间关系需要可检查的画面依据

位置：`ProductionInstruction.location.layout`、`subjects[].position/gaze`、`camera.axis` 及 `continuity.before/after/locked`。

现在多数空间信息是自由文本，状态检查主要比较 key/value 是否相等，不能从这些文字确定机位投影或检查成片里的位置。

建议将场次空间作为共享数据：固定地标、角色朝向、相对距离、行动路线、道具持有关系、机位及人物轴线。区分场景中的位置与画面左右；由机位推导构图说明。先生成并确认一张全景站位图，再准备各生成段的构图图；俯视示意/线稿作为制作依据，不假定所有视频模型都能直接执行坐标。

这属于依据官方参考图/草图用法提出的工程设计，不是官方承诺“文字坐标能保证成片位置”。角色完整设定板继续保留，不自动裁切替换；新增构图画面用于表达站位与机位。

### P1：将参考用途细分为制作语义

位置：`packages/contracts/src/production-inputs.ts`、`ProductionInputImage` 及 `ProductionInstruction.resources`。

当前已保留角色、场景和首尾帧，但输入图片用途尚未清楚区分风格、空间布局、故事板和关键帧；参考视频也需要区分身份、动作、运镜、节奏与待编辑原片。

建议内部保留这些用途，投影时按当前合同使用具体字段或明确的提示词引用。不要制造通用 API 字段，也不把“支持参考图”解释为“严格控制首帧”。严格首尾帧采用相应输入语义，普通参考仅承担软约束。

### P1：补齐前段采用到后段准备的流程

位置：`apps/desktop/src/ShotWorkspace.tsx` 当前业务槽位为角色、场景和首帧；`apps/worker/src/video-generation-service.ts` 管任务与产物，制作链尚未形成视频 take 的采用与后续衔接流程。

建议顺序：生成候选 → 检查并采用 → 确认结束状态 → 提取最后一个可用画面或选取原视频 → 准备下一生成段 → 检查剪辑点。

- 同机位连续动作：模型支持时使用原视频延长，或采用确认末帧作为下一首帧；末帧续接无法单独保证运动速度、相机运动和声音连续。
- 换机位/正反打：根据结束状态准备新构图，不把上一镜原画面硬作另一角度首帧。
- 首尾帧过渡：先检查两个画面的主体、空间与动作能否在请求时长内自然连接。
- 前段未采用、素材被替换或状态变化时，后段准备结果应明确失效；沿用已有来源令牌保护。

### P1：声音需要单独规划，不能用枚举级别替代

位置：`scene-production.ts` 当前对 auto/silent/native/voice-reference/dialogue-driven 按数组顺序选择整段“更高”模式。

这些方式不是能力等级。例如，一个镜头原生声音、一个镜头需要录音，不能只取 dialogue-driven 就认为整段都能使用同一录音。建议按实际声音需求和模型支持组合决定合并或拆段；对白文字、音色参考、完整录音、环境声和音乐分别表达。

选定整场对白录音后，制作子段需要对应的音频时间范围；目前看到的是场次整段录音绑定，尚未形成按生成段自动准备对应音频切片的流程。对话连续性也需要音色、情绪、语速、停顿和环境底噪保持，而非每镜重新随意生成。

### P2：用实际生成结果补上验收

已有自动化能验证 Schema、任务生命周期、素材归属、参数与来源；这些不等于验证模型的切镜和位置遵循。

建议建立少量真实样片用例：单人移动、双人对话、交接道具、绕行遮挡、正反打、跨段续接。人工检查身份、站位、视线、持物手、轴线、动作完成度、对白、剪辑点和声音。后续可用视觉模型辅助标出问题，但采用仍由用户确认，不能将生成成功或自动评分直接视为剧情事实。

## 4. 渡口场次的建议制作组织

以下为工程建议示例，不是必须新增的一层故事结构。

1. 共享设定：渡口地标、人物站位与朝向、摄影机所处岸侧、画风、光线和道具；保留已确认角色设定板。
2. 生成段 A：人物独立与望向来路。准备构图图，连续动作简单，优先保持单镜。
3. 生成段 B：来人进入、双方对视及对白。支持多镜头的模型可以在同一次请求内组织建立关系、人物反应与近景，时长由台词和动作推导。
4. 生成段 C：交手和退场。依据确认的 B 段结束站位设计动作；需要连续运动时准备对应视频参考或衔接画面，超限在可剪辑动作节点分段。
5. 每段先采用后衔接，剪辑与声音统一处理。不要仅因生成段到达模型时长上限就强行切开尚未完成的动作。

建议落地顺序：模型/任务提示词编译 → 生成段规划 → 站位与关键构图 → 采用及前后段衔接 → 音轨与成片验收。项目资料、索引和媒体继续保存在本地；官方文档能力、已登记合同能力和当前渠道可执行能力分别核对。
