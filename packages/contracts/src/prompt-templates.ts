import { CHARACTER_SHEET_IMAGE_REQUIREMENTS } from './character-sheet.js';
import { SCENE_REFERENCE_IMAGE_REQUIREMENTS } from './scene-reference.js';
import {
  SHOT_CAMERA_LIGHTING_REQUIREMENTS,
  VIDEO_PROMPT_AUTHORING_REQUIREMENTS,
} from './video-prompt-guidance.js';

export const PROMPT_TEMPLATE_KINDS = [
  'character-image',
  'scene-image',
  'prop-image',
  'shot-image',
  'video-prompt',
] as const;
export type PromptTemplateKind = (typeof PROMPT_TEMPLATE_KINDS)[number];
export const PROMPT_PURPOSES = ['general', ...PROMPT_TEMPLATE_KINDS] as const;
export type PromptPurpose = (typeof PROMPT_PURPOSES)[number];
export function isPromptPurpose(value: unknown): value is PromptPurpose {
  return value === 'general' || isPromptTemplateKind(value);
}
export function promptPurposeForKind(kind: string): PromptPurpose | undefined {
  return (
    {
      character: 'character-image',
      location: 'scene-image',
      prop: 'prop-image',
      voice: 'general',
      plan: 'general',
      scene: 'video-prompt',
      shot: 'video-prompt',
      'shot-image': 'shot-image',
    } as Record<string, PromptPurpose>
  )[kind];
}
export type PromptTemplates = Partial<Record<PromptTemplateKind, string>>;
export const PROMPT_TEMPLATE_LABELS: Record<PromptTemplateKind | 'general', string> = {
  general: '通用会话要求',
  'character-image': '角色图片提示词',
  'scene-image': '场景图片提示词',
  'prop-image': '道具图片提示词',
  'shot-image': '镜头静态图提示词',
  'video-prompt': '镜头视频提示词',
};

/** Editable starters only. Runtime policies must not append these behind user edits. */
export const DEFAULT_PROMPT_TEMPLATES: Record<PromptTemplateKind, string> = {
  'character-image': CHARACTER_SHEET_IMAGE_REQUIREMENTS,
  'scene-image': SCENE_REFERENCE_IMAGE_REQUIREMENTS,
  'prop-image': `每件道具分别编写独立图片提示词，以物件本体为主体，按剧情依据说明外观、材质、尺寸关系与展示角度。背景简洁，不混入人物或其他道具。已有资料先核对，不为凑类型补造道具。`,
  'shot-image': `编写本镜指定瞬间的静态图片提示词，写清实际人物、动作瞬间、站位、朝向、机位、构图与光照。人物身份、环境及道具沿用实际参考；静态参考不自动成为视频首帧，不把整段动作流程写成同一画面。
${SHOT_CAMERA_LIGHTING_REQUIREMENTS}`,
  'video-prompt': VIDEO_PROMPT_AUTHORING_REQUIREMENTS,
};

export function isPromptTemplateKind(value: unknown): value is PromptTemplateKind {
  return typeof value === 'string' && PROMPT_TEMPLATE_KINDS.includes(value as PromptTemplateKind);
}

export function validatePromptTemplates(value: unknown): asserts value is PromptTemplates {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Prompt templates must be an object.');
  for (const [kind, content] of Object.entries(value))
    if (!isPromptTemplateKind(kind) || typeof content !== 'string')
      throw new Error('Prompt template kind or content is invalid.');
}

/** Selection follows explicit Agent workflow or unambiguous tool semantics, never user keywords. */
export function promptTemplateKindForTools(
  names: readonly string[],
  workflow?: string,
): PromptPurpose | undefined {
  if (isPromptPurpose(workflow)) return workflow;
  if (names.some((name) => name === 'shot.continuity.save' || name === 'shot.image.save'))
    return 'shot-image';
  if (
    names.some((name) =>
      [
        'scene.submit_structure',
        'scene.structure.stage',
        'scene.update_shot_prompts',
        'novel.episode.submit_structure',
        'media.video.prepare',
      ].includes(name),
    )
  )
    return 'video-prompt';
  return undefined;
}
