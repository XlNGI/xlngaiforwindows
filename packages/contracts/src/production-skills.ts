/** Reusable task declarations. These do not grant tools or select another Agent. */
export type ProductionSkillId = 'chapters-to-script' | 'script-to-media';

export const PRODUCTION_SKILLS = {
  'chapters-to-script': {
    title: '章节生成短剧资料',
    description: '将本次选中的小说章节改编为可编辑的短剧剧本资料、场次和镜头。',
    instructions: `目标：根据用户明确选择的小说章节，完成短剧制作所需的可编辑草稿。
输入：本次源章节真实 ID、文档 ID、版本和 draft/published 状态。目录不是正文；通过 library.search/read 按需读取覆盖所选范围的正文和相关设定。源版本发生变化时报告冲突，不用其他章节替代。
产物：剧本/本集把控文档，剧情实际需要的角色、场景和道具设定，以及场次和镜头 ProductionAuthoringIR。角色一人或一个命名群组一份文档；场景是空间环境，道具是独立物件，不需要道具时留空。剧情、拆镜数量、节奏、时长与表现方式由你根据语义设计，尊重用户明确要求，不补造源材料事实。
可用能力：project.structure.get、library.search/read、document.submit_draft、scene.submit_structure、scene.structure.stage、scene.update_shot_prompts/timings。按工具声明读取 schema，使用实际返回的文档/场次/镜头 ID 建立引用。已有产物按 ID 与当前版本修改，避免重复创建。
完成：保存各类文档、IR 和绑定为草稿，以工具成功结果核对产物位置和遗漏；保留来源标记，不自动发布，不调用任何媒体付费提交。遇到缺口准确报告已完成与未完成范围。`,
  },
  'script-to-media': {
    title: '剧本准备媒体表单',
    description: '根据选中的剧本与关联场次、镜头，备齐图片、视频及所需音频审核表单。',
    instructions: `目标：完成从所选剧本到所有媒体提交表单之前的材料准备，让用户直接调整表单并提交。
输入：真实剧本文档 ID、版本及状态。按需读取正文、相关设定、场次与镜头 IR。场次/镜头范围由你依据真实绑定和剧情判断；不要猜 UI 当前选中项，不按名称猜素材。
产物：保存可编辑的完整提示词及必要 IR/绑定，并使用 media.review.prepare 将每个需要的图片、视频、音频表单排入持久化审核队列；该工具只准备表单，不等待用户逐项审核，不提交付费任务。使用稳定 key 标识同一产物，恢复任务时先用 media.review.list 复用已有表单。
参考图：production.read target={kind:"shot",id:真实镜头ID},view="media" 返回实际选用与候选。按实际选用的图片顺序写“输入图片说明”，候选不等于选中；未看图时不编造可见细节。角色、场景、道具严格区分；不需要的道具为空。已有资产以 assetId 引用；缺少参考图时先准备对应 image 表单，再以 {reviewFormId:真实表单ID,resultIndex:0} 等显式结果引用供下游使用，不编造 assetId，不使用占位图。
提示词：把适用要求写进最终 prompt，包括输入图片说明、目标、基础设定、氛围与画质/运镜、动态流程及负面约束。时长由你根据动作、对白、节奏设计，尊重用户指定、已有时长及模型硬限制，并与 API 参数一致。一个视频可包含连续动作/多个分镜，不机械地把每段动作拆成独立生成任务。
音频：需要独立对白/旁白时准备 audio 表单，声明真实场次、可选镜头、说话角色或旁白、台词、起点和情绪。可查询 media.audio.read 查看现有配音与音色；缺音色保留待选，不捏造。没有对白/旁白需求时可无音频表单。音频制作复用配音服务，不承诺当前系统尚不支持的音乐/音效合成。
完成：核对每个镜头所需材料与表单及其依赖，报告已准备数量、缺口与阻塞。准备阶段不调用 media.generation.submit；用户点击表单提交就是最终审核，不再由 Agent 改写或二次确认。`,
  },
} as const;

export function productionSkillPrompt(
  skillId: ProductionSkillId,
  sources: Array<{ id: string; documentId: string; versionId: string; state: string }>,
): string {
  return `执行制作 Skill「${PRODUCTION_SKILLS[skillId].title}」（${skillId}）。请通过 production.skill.read 读取同一份任务声明，使用当前统一 Agent 和已有工具完成任务。\n本次明确选择的源对象/已保存版本（仅元数据，不是正文）：\n${JSON.stringify(sources)}\n先按需读取正文；不要询问用户已明确提供的选择，不自动发布文档或提交媒体生成。`;
}
