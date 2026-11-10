/** Task declarations; all prompts are ordinary editable text. */
export type ProductionSkillId = 'chapters-to-script' | 'script-to-media';
export const PRODUCTION_BUNDLE_SKILL_REVISION = 33;
export const PRODUCTION_BUNDLE_SKILL = {
  title: '剧本生成制作资料',
  description: '联合生成提示词与绑定，经结构校验后统一保存为可编辑草稿。',
  instructions: `目标：把完整所选剧本制作成可编辑草稿，包括所需角色、地点、独立道具、音色资料及全部场次和镜头。所有对象可联合创作和绑定。提示词是普通文本，唯一IR只记录绑定；尚无图片或音频不妨碍创建并绑定提示词资料。不发布、不生成媒体、不建媒体表单、不请求逐项确认。源稿中旧的“本阶段尚不制作”只描述源稿历史状态，不能缩减本任务。
先阅读完整本次要求、已确认决定与所选源正文。本任务工具已直接提供，当前声明保留在taskState.activeSkills，不重复加载或重读；按当前pendingSteps.nextAction继续，不因原请求再次出现而重新开始。production.bundle begin登记estimatedOutputTokens并冻结来源，同时登记整包交付，无需再调用checkpoint plan；source分页读取到结束，contentMarkdown标记后是原始正文，复用资料用真实documentId/versionId登记reused后读全文，已选源稿不用再登记reused。目录不是正文，不声称看过未实际读取的文字或图片。项目资料按需检索，本地SQLite保存索引，聊天附件不自动入库。先在内部核对从开头到结尾的全部事件、逐句原文、所有实际使用的独立道具、声音身份及稳定key，再提交，不能只完成开场就封包。先完成所需资料，再按源顺序完成各镜全文，最后整理各场全文；场次可以晚于引用它的镜头提交，但封包前必须齐全。
通过production.bundle.submit提交，每项完整普通文本都放prompt；格式为{partKey,expectedRevision,prompts:[{localKey,kind,title,prompt,bindings?,sampleText?,sceneKey?,timing?,existing?}],complete?}。kind为character/location/prop/voice/plan/scene/shot：location是地点图片资料，scene是剧情场次；shot必须有sceneKey，指向本包实际提交的场次。动作、对白、节拍、运镜均写普通正文，不另拆内容IR。sampleText仅用于voice，是可编辑试音文本；timing仅用于scene/shot，使用estimatedDurationSeconds及可选locked。不要提交旧documents/scenes/shots、contentMarkdown或嵌套镜头。用户要求另存的分析、分镜表可建plan，不能代替实际产物。
唯一IR是bindings={schemaVersion:1,characterDocumentIds?,sceneDocumentIds?,propDocumentIds?,voiceDocumentId?,voiceBindings?}。每个镜头必须显式提供三个视觉数组characterDocumentIds、sceneDocumentIds、propDocumentIds；按实际出镜和使用关系填引用，只有确实没有该类对象时才填[]。引用严格为{localKey}或{existingId}，existingId只能指向已经读取并登记复用的真实对象。角色默认音色用voiceDocumentId；voiceBindings每项为{characterDocumentId?,voiceDocumentId}，纯画外声音只绑音色，不为此虚构视觉角色。正文提及姓名不会建立关系，资料绑定不代表已有媒体文件。existing只用于修改业务库已保存记录及其真实CAS；新建和候选返修省略existing，按原localKey和整包expectedRevision替换，candidate:与hash都不是业务ID。
按完整对象分包，长正文每批宜1至3项；每个分包使用稳定partKey和当前expectedRevision。单包256KiB、总包8MiB、最多1000对象。任何提交被拒则整批均未保存，不能把失败参数当候选。参数错误使用preparedArguments显式patch原字段，保留正文、partKey和CAS；CAS已过期时用当前revision新建明确分包。不要用反复check代替创作。
创作品质：遵循本次要求的正文组织和细节密度，不能用压缩剧情梗概代替可直接制作的视听正文。先按源稿核对事件先后、因果和全部关键原句，再写镜头。每句对白只在实际位置出现，标明说话者及画外用途，不移位、重复或补全截断台词。动态流程逐句分配足以听清的朗读时间、应答间隔、反应、核验和移动，再确定timing；按字数实际估算，每句都须放进足够长的具体节拍，不能只加长镜头总时长，不能只写“自然语速”却给不够时间。没有固定镜头秒数上限。保持源稿已知时间、空间、外观和道具状态，未知事实省略，不编造确认设定或用反应表情代替需要交代的情节。用户要求完整场次正文时，先完成各镜正文，再将所属每镜全文原样按顺序放入scene.prompt各一次，加整场设定；摘要不能代替全文。镜头返修后同步该场正文。
资料提示词遵循本次适用图片版式：完整角色设定板包括主全身立绘、全身五视图、头部六角度、服饰拆解、材质色卡与表情分区，未知外观和无依据能力省略；地点复合图为单画布n=1、主全景与少量真实对应环境局部，透视光线一致、无标题边框，不夹入手机等剧情道具特写、不合并无依据地点；剧情实际使用的独立道具分别写以本体为主体的图片提示词并绑定。音色描述和试音文本分开保存。各类提示词不能只写剧情用途说明。
所有提示词和每个shot.sceneKey都已提交后，在最后一次submit附complete=true。complete表示整份所选剧本已经提交，不是单批结束。Worker自动执行结构校验，通过后在一个事务中统一保存并立即独立读回。结构校验只检查清单、对象类型、关系引用、项目/版本/CAS、时长数据格式和持久化一致性，不判断剧情、对白、画面或提示词质量；模型不得为触发保存而调用语义审查。
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
