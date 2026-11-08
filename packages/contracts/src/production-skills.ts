import {
  SHOT_PLANNING_REQUIREMENTS,
  SHOT_TIMING_REQUIREMENTS,
  SHOT_GENERATION_PLANNING_REQUIREMENTS,
  SHOT_CAMERA_LIGHTING_REQUIREMENTS,
} from './video-prompt-guidance.js';

/** Reusable task declarations. These do not grant tools or select another Agent. */
export type ProductionSkillId = 'chapters-to-script' | 'script-to-media';

export const PRODUCTION_SKILLS = {
  'chapters-to-script': {
    title: '章节生成剧本',
    description: '将本次选中的小说章节改编为可编辑的短剧剧本，不生成媒体制作资料。',
    instructions: `目标：根据用户明确选择的小说章节，完成短剧剧本草稿。
输入：本次源章节真实 ID、文档 ID、版本和 draft/published 状态。目录不是正文；通过 library.search/read 按需读取覆盖所选范围的正文和相关设定。遵循当前会话中与本次改编直接相关的用户约束，以及项目中检索到的已保存约束。源版本发生变化时报告冲突，不用其他章节替代。
产物：剧本/本集把控文档，保留章节来源、改编范围、剧情、对白、场次意图和制作约束。此阶段不创建角色、场景、道具、场次、镜头、媒体审核表单或任何媒体任务。
可用能力：project.structure.get、library.search/read、document.submit_draft。剧本/本集把控使用现有 documentKind="plan"，新建目的地为目录中的 workspace:documents；计划交付的 documentKind 同样为 plan。targetIds 仅填写已有输出文档 ID，新建时先省略，不能填写源章节 ID。按工具声明读取 schema，使用真实源版本建立来源标记。已有剧本文档按实际 ID 与当前版本修改，避免重复创建。
完成：保存剧本文档草稿并核对来源和遗漏；不自动发布，不调用媒体审核表单或任何媒体提交。遇到缺口准确报告已完成与未完成范围。`,
  },
  'script-to-media': {
    title: '剧本生成制作资料',
    description:
      '根据选中的剧本直接生成可编辑制作资料草稿、镜头提示词和逐镜引用关系；不创建媒体审核表单或调用图片、视频、音频生成 Provider。',
    instructions: `目标：根据所选剧本直接生成可编辑的角色、场景、道具、场次、镜头、提示词和绑定关系草稿。
输入：真实剧本文档 ID、版本及状态。按需读取正文、相关设定、场次与镜头 IR。遵循当前会话中与本次制作直接相关的用户约束，以及项目中检索到的已保存约束；不要把不相关聊天历史当作制作要求。场次/镜头范围由你依据真实绑定和剧情判断；不要猜 UI 当前选中项，不按名称猜素材。
交付核验：读取源稿后，在 conversation.task.checkpoint operation=plan 的场次/镜头交付项 requiredTexts 中逐句登记本集必须保留的全部原对白，以及用户明确要求逐字保留的文字；无对白时省略。逐字项只复制源稿中的原句，不自行拼入说话者标签、引号或格式；说话者、语气与顺序在读回时另外核验，避免将格式差异误判为原句缺失。不要只登记数量和引用。该清单跨压缩和重启保留，不能删除或缩减；Worker 对当前已保存的逐镜 prompt 正文逐项检查，audioPlan、备注、结构 ready 或最终回复不能替代正文。数量或工具细化时更新原交付项的稳定 key，不把同一批工作另登记为独立义务。完成前读取已保存正文，按源稿核对说话者、顺序、连续性与自然时长；遗漏时按当前真实 ID/CAS 修正既有镜头，不重建已完成资料。按本次用户适用要求复核每份角色设定板、场景图、道具图提示词及镜头正文；用户要求的分区、镜内相对时间、起止状态等必须写入各自完整正文，不能仅用通用角色摘要或 timing/data 替代。
产物顺序：先提取并复用或创建剧情实际需要的角色、场景和道具文档；每份角色、场景、道具资料都必须通过 document.submit_draft 写入完整、可直接用于生图的最终提示词正文 contentMarkdown，不能只写标题、摘要或 contentIR.data；再根据剧本生成场次、镜头及完整提示词；随后逐镜填写 authoringIR.references 中完整的 characterDocumentIds、sceneDocumentIds、propDocumentIds，并保存连续性与音频计划。场次页的绑定关系是这些镜头引用的汇总，不设置场次级媒体绑定。所有产物直接保存为可编辑草稿；完成后任务结束，不等待审核或用户确认。
辅助交付：用户要求另存剧情分析、分镜表或完整提示词文档时，用 documentKind="plan"、workspace:documents 保存，并纳入同一任务的交付与读回审查；保留用户指定的先后顺序。这些辅助文档不能代替真实场次/镜头或 character/scene/prop 制作资料，也不能作为对应类型的镜头引用。
调用边界：本按钮使用当前对话 LLM 编写草稿，但本任务不得准备或提交图片、视频、音频生成，也不得创建媒体审核表单或请求用户确认。不要调用任何 media.* 工具、conversation.ask 或 conversation.task.route。遇到资料缺口时继续完成可确定的制作资料，并在草稿或最终结果中列出缺口；不要把缺图、待选模型或待审核媒体表单作为阻塞。
结构生成：角色、场景、道具不能只从镜头文字反推完整设定。已有资料优先作为权威来源，剧本负责本集新增或状态变化；每个镜头的完整提示词与三类真实文档 ID 引用列表必须相互一致；没有对应对象时明确写 []。同一场次中的镜头可以绑定不同角色、地点和道具。不要把场次名当作场景资料，也不要把父场次引用继承给镜头。若尚无结构，优先使用 scene.structure.stage 的 begin/put_scene/put_shots 逐场持久保存，按回执继续剩余场次；避免把全剧本的长正文装进一次巨型调用。scene.submit_structure 仍支持直接提交及已有场次更新；若已有结构，按真实 ID 和行版本更新，不重复创建。
${SHOT_PLANNING_REQUIREMENTS}
${SHOT_GENERATION_PLANNING_REQUIREMENTS}
${SHOT_CAMERA_LIGHTING_REQUIREMENTS}
${SHOT_TIMING_REQUIREMENTS}
连续性：对每个非首镜判断相邻镜头关系，必要时在 authoringIR.data.continuityPlan 记录建议及需保持的可见状态；计划不代表已有视频帧或已确认绑定。用户在镜头页面人工选帧后，使用 shot.continuity.read 查看实际画面、当前镜头及用户目标；目标时刻或构图不清楚时澄清。通过 shot.continuity.save 保存独立的静态参考图提示词，不覆盖视频正文，不预设换机位或首帧。用户在正常表单生成图片并绑定为普通参考图或显式首帧，再通过原有填充制作本镜头；不另做衔接视频。
参考图：production.read target={kind:"shot",id:真实镜头ID},view="media" 返回该镜头实际选用与候选。每个引用对象都要用类型、名称和真实文档 ID 清楚确认；随后按实际选用的图片顺序写“输入图片说明”，候选不等于选中；未看图时不编造可见细节。角色、场景、道具严格区分；不需要的道具为空。已有资产以 assetId 引用；缺少参考图时不创建表单、不调用生图、不编造 assetId 或占位图，并在草稿中记录参考图缺口。
提示词：把适用要求写进最终 prompt，包括输入图片说明、目标、基础设定、氛围与画质/运镜、动态流程及负面约束。内容时长由你根据动作、对白、节奏设计，尊重用户指定及已有锁定时长，与镜头 timing 和 beats 一致；模型请求时长单独适配，不拉伸动作。一个视频可包含连续动作/多个分镜，不机械地把每段动作拆成独立生成任务。
音频：逐镜识别可见对白、画外音和无对白镜头，并在 authoringIR.data.audioPlan 记录 voice_reference_video、dialogue_driven_video、external_tts_lipsync 或 audio_mix_only 及选择理由。需要独立对白/旁白时，在镜头 audioPlan 或可编辑文字草稿中记录真实场次、镜头、说话角色或旁白、台词、估计起点和情绪；不要创建音频表单或调用音频服务。不捏造 profile ID。没有对白/旁白需求时保留空计划。音频制作复用配音服务，不承诺当前系统尚不支持的音乐/音效合成。
完成：核对角色/场景/道具、场次/镜头、绑定、连续性和音频计划，保存全部可确定的草稿并报告数量与缺口。任务启动时的制作要求独立于模型登记的计划持续有效；未登记的必要工作也不能遗漏。结束前逐一读回当前保存的镜头正文和所引用的制作资料正文（production.read/library.read/document.read；按版本续读全部页面），不要只看目录、保存回执或ready。镜头必须保存自然时长及beats，并将相应相对时间流程写进prompt。缺道具、对白重复、引用错配或正文未核验时继续修正既有ID，不以“下一步再检查”结束。读取成功只说明取得正文，仍须你按源稿与用户要求作语义核对；修改后重读该对象即可，不重读全部源资料或已核验且未变的其他产物。不要创建媒体表单、发起媒体生成请求、要求用户审核或等待用户确认；不要自动发布文档。`,
  },
} as const;

export function productionSkillPrompt(
  skillId: ProductionSkillId,
  sources: Array<{
    id: string;
    documentId: string;
    title: string;
    kind: string;
    versionId: string;
    state: string;
  }>,
): string {
  return `执行制作 Skill「${PRODUCTION_SKILLS[skillId].title}」（${skillId}）。请通过 production.skill.read 读取同一份任务声明，使用当前统一 Agent 和已有工具完成任务。\n本次明确选择的源对象（以真实文档 ID、标题、类型和已保存版本为准；以下仅元数据，不是正文）：\n${JSON.stringify(sources)}\n先按需读取这些源对象的正文；不要询问用户已明确提供的选择，不自动发布文档或提交媒体生成。${skillId === 'script-to-media' ? '再为每个镜头明确列出引用对象的类型、标题和真实文档 ID。本按钮直接保存可编辑制作资料草稿与镜头绑定；只使用当前对话 LLM 编写草稿，不调用图片、视频或音频生成 API，不创建媒体审核表单，不请求用户确认或审核。' : '仅保存剧本/本集把控草稿：document.submit_draft，documentKind="plan"，新建目的地 workspace:documents；不创建场次、镜头或制作资料。'}`;
}
