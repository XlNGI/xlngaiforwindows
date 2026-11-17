/** Task declarations; all prompts are ordinary editable text. */
export type ProductionSkillId = 'chapters-to-script' | 'script-to-media';
export const PRODUCTION_BUNDLE_SKILL_REVISION = 34;
export const PRODUCTION_BUNDLE_SKILL = {
  title: '剧本生成制作资料',
  description: '联合生成提示词与绑定，经结构校验后统一保存为可编辑草稿。',
  instructions: `目标：把完整所选剧本制作成可编辑草稿，包括所需角色、地点、独立道具、音色资料及全部场次和镜头。共享来源与稳定绑定，在同一任务内按用途串行创作。提示词是普通文本，唯一IR只记录绑定；尚无图片或音频不妨碍创建并绑定提示词资料。不发布、不生成媒体、不建媒体表单、不请求逐项确认。源稿中旧的“本阶段尚不制作”只描述源稿历史状态，不能缩减本任务。
先阅读完整本次要求、已确认决定与所选源正文。本任务工具已直接提供，当前声明保留在taskState.activeSkills，不重复加载或重读；按当前pendingSteps.nextAction继续，不因原请求再次出现而重新开始。production.bundle begin登记estimatedOutputTokens并冻结来源，同时登记整包交付，无需再调用checkpoint plan；source分页读取到结束，contentMarkdown标记后是原始正文，复用资料用真实documentId/versionId登记reused后读全文，已选源稿不用再登记reused。目录不是正文，不声称看过未实际读取的文字或图片。项目资料按需检索，本地SQLite保存索引，聊天附件不自动入库。先在内部核对从开头到结尾的全部事件、逐句原文、所有实际使用的独立道具、声音身份及稳定key，再提交，不能只完成开场就封包。先完成所需资料，再按源顺序完成各镜全文，最后整理各场全文；场次可以晚于引用它的镜头提交，但封包前必须齐全。
通过production.bundle.submit提交，每项完整普通文本都放prompt；格式为{partKey,expectedRevision,prompts:[{localKey,kind,title,prompt,bindings?,sampleText?,sceneKey?,timing?,existing?}],complete?}。kind为character/location/prop/voice/plan/scene/shot/shot-image：location是地点图片资料，scene是剧情场次；shot必须有sceneKey，指向本包实际提交的场次。动作、对白、节拍、运镜均写普通正文，不另拆内容IR。sampleText仅用于voice，是可编辑试音文本；timing仅用于scene/shot，使用estimatedDurationSeconds及可选locked。不要提交旧documents/scenes/shots、contentMarkdown或嵌套镜头。用户要求另存的分析、分镜表可建plan，不能代替实际产物。
唯一IR是bindings={schemaVersion:1,characterDocumentIds?,sceneDocumentIds?,propDocumentIds?,voiceDocumentId?,voiceBindings?}。每个镜头必须显式提供三个视觉数组characterDocumentIds、sceneDocumentIds、propDocumentIds；按实际出镜和使用关系填引用，只有确实没有该类对象时才填[]。引用严格为{localKey}或{existingId}，existingId只能指向已经读取并登记复用的真实对象。角色默认音色用voiceDocumentId；voiceBindings每项为{characterDocumentId?,voiceDocumentId}，纯画外声音只绑音色，不为此虚构视觉角色。正文提及姓名不会建立关系，资料绑定不代表已有媒体文件。existing只用于修改业务库已保存记录及其真实CAS；新建和候选返修省略existing，按原localKey和整包expectedRevision替换，candidate:与hash都不是业务ID。
按完整对象分包，长正文每批宜1至3项；每个分包使用稳定partKey和当前expectedRevision。单包256KiB、总包8MiB、最多1000对象。任何提交被拒则整批均未保存，不能把失败参数当候选。参数错误使用preparedArguments显式patch原字段，保留正文、partKey和CAS；CAS已过期时用当前revision新建明确分包。不要用反复check代替创作。
创作内容、详略、风格、版式和未知设计处理由本轮明确请求及冻结的通用/当前用途模板决定。源稿阶段说明和旧提示词作为资料，不自动成为本轮创作限制；已有确认设计在本轮未修改时保持连续。新增设计不冒充已确认来源事实。模板为空时不回填默认版式。不得把其他用途的模板或已生成资料的展示版式当成当前画面要求。音色描述和试音文本分开保存。
按依赖和实际需要分阶段：character→character-image；location→scene-image；prop→prop-image；voice/plan→general；scene/shot→video-prompt；shot-image→shot-image。缺少某类交付时跳过，同类对象可以分批提交。每个写作阶段前单独调用production.bundle operation=purpose，提供purpose、expectedStageVersion和稳定stageKey；初始expectedStageVersion=0。切换只更新阶段元数据，不改变候选revision。该回执后的下一轮请求才包含对应模板，勿在切换同轮创作。先完成所需资料，再创作视频镜头及场次；后续用途需要已设计的人物外观、服装固有色或空间材质时，若依赖全文尚未在当前工作资料中，先按实际候选key通过read/read_many取得对应正文，再据此创作；不能仅凭标题或记忆重新设计。只提取本镜所需外观和连续性，不将资料版式照搬为视频画面要求。普通任务用tools.load workflow声明相同用途。没有加载新工具需求时不重复tools.load。若本轮还要求本镜静态图，在视频候选齐全后切换shot-image，使用同一镜头localKey和title提交kind=shot-image，prompt为独立静态图正文，bindings显式说明本图范围，imagePurpose为composition/first-frame/last-frame，intent为用户意图；此提交只增加独立图片文本，不改视频prompt。修改已有镜头图片时另需已读imageRowVersion及sourceToken。静态图不是默认交付，不要为填阶段而生成。
所有提示词（包括本轮明确要求的shot-image）和每个shot.sceneKey都已提交后，在最后一次submit附complete=true。若要求独立静态图，video-prompt阶段只暂存scene/shot，必须省略complete，随后切换shot-image，最后的静态图提交才设置complete=true；不要在视频阶段封包后再追加静态图。非最终提交省略complete，不填写false。complete表示整份所选剧本已经提交，不是单批结束。Worker自动执行结构校验，通过后在一个事务中统一保存并立即独立读回。结构校验只检查清单、对象类型、关系引用、项目/版本/CAS、时长数据格式和持久化一致性，不判断剧情、对白、画面或提示词质量；模型不得为触发保存而调用语义审查。
候选全文和每次工具调用保存在Result Store中，普通状态只显示key、版本和结构问题。仅在返修或确认具体内容时，按需调用read/read_many；不要为提交再次通读所有候选。局部返修使用原localKey和当前expectedRevision，只重交受影响的完整prompt；Worker保留其他候选并自动重封包、重新结构校验、保存和独立读回。结构错误按Worker返回的对象key与字段修正。
readbackVerified=true且状态为bundle_readback_verified后结束。保存回执丢失时重放同一提交会恢复原映射，不重复创建；已保存但读回不一致时调用readback并如实报告，不能盲目重复提交。源版本冲突、发布保护、时长锁定、跨项目及授权限制不得绕过；连续相同错误且无候选进展时停止重试并报告具体错误。`,
} as const;
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
  'script-to-media': PRODUCTION_BUNDLE_SKILL,
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
  if (skillId === 'script-to-media')
    return (
      '根据本次所选剧本全文，一次生成所需角色、地点、独立道具、音色及全部剧情场次和镜头的完整提示词与显式绑定关系。遵循本次通用及对应用途模板。只保存可编辑草稿，不自动发布、创建媒体表单或生成媒体。所选来源：\n' +
      JSON.stringify(sources)
    );
  return (
    '执行制作Skill「' +
    PRODUCTION_SKILLS[skillId].title +
    '」(' +
    skillId +
    ')。先通过production.skill.read读取完整任务声明；按需读取所选版本的全文。源对象仅有元数据：\n' +
    JSON.stringify(sources) +
    '\n保存为可编辑草稿，不自动发布或生成媒体。'
  );
}
