import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  productionExecuteSchema,
  productionInstructionSchema,
  productionDefaultsSchema,
  sceneProductionInstructionSchema,
  shotProductionInstructionSchema,
  productionAudioSupport,
  productionFactKey,
  applyProductionFacts,
  emptyProductionFacts,
  type ProductionDefaults,
  renderProductionInstruction,
  type ProductionInstruction,
  type ProductionIssue,
  type ProductionExecuteParams,
  type AdapterDescriptor,
  type AdapterParameters,
} from '@ai-video/contracts';

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validateList = ajv.compile(productionExecuteSchema);
const validateInstruction = ajv.compile(productionInstructionSchema);
const validateDefaults = ajv.compile(productionDefaultsSchema);
const validateScene = ajv.compile(sceneProductionInstructionSchema);
const validateShot = ajv.compile(shotProductionInstructionSchema);
export function parseProductionDefaults(input: unknown): ProductionDefaults {
  if (!validateDefaults(input))
    throw new Error(`项目视觉设置无效：${ajv.errorsText(validateDefaults.errors)}`);
  return structuredClone(input as ProductionDefaults);
}

export function parseProductionExecution(input: unknown): ProductionExecuteParams {
  if (!validateList(input))
    throw new Error(`制作执行清单无效：${ajv.errorsText(validateList.errors)}`);
  for (const operation of (input as unknown as ProductionExecuteParams).operations) {
    const issues = inspectProductionInstruction(operation.instruction);
    if (issues.length) throw new Error(issues.map((issue) => issue.message).join('\n'));
  }
  return structuredClone(input as unknown as ProductionExecuteParams);
}

export function inspectProductionInstruction(input: unknown): ProductionIssue[] {
  if (!validateInstruction(input))
    return [{ code: 'INVALID_INSTRUCTION', message: ajv.errorsText(validateInstruction.errors) }];
  const instruction = input as unknown as ProductionInstruction;
  const issues: ProductionIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  if (!instruction.summary.trim()) add('EMPTY_SUMMARY', '制作摘要不能为空。');
  if (instruction.version === 2 && !instruction.narrative?.purpose.trim())
    add('MISSING_NARRATIVE', '详细制作指令必须说明叙事目的，先按剧情编排再估算时长。');
  if (
    instruction.audio.mode === 'silent' &&
    [instruction.audio.ambience, instruction.audio.music, instruction.audio.effects].some(Boolean)
  )
    add('SILENT_AUDIO_CONFLICT', '无声模式不能同时要求环境声、音乐或音效。');
  const predecessors = instruction.continuity.predecessors.map(
    (target) => `${target.kind}:${target.id}`,
  );
  if (new Set(predecessors).size !== predecessors.length)
    add('DUPLICATE_DEPENDENCY', '连续性前置对象不能重复。');
  for (const resource of instruction.resources) {
    if (['character-image', 'voice-reference'].includes(resource.kind) && !resource.documentId)
      add('MISSING_RESOURCE_DOCUMENT', '角色图片或音色需求必须指向真实角色文档。');
  }
  for (const [name, values] of Object.entries({
    subjects: instruction.subjects.map((s) => s.documentId),
    beats: instruction.beats.map((b) => b.id),
    before: instruction.continuity.before.map(productionFactKey),
    after: instruction.continuity.after.map(productionFactKey),
    locked: instruction.continuity.locked.map(productionFactKey),
  }))
    if (new Set(values).size !== values.length) add('DUPLICATE_KEY', `${name} 存在重复标识。`);
  let end = 0;
  for (const beat of instruction.beats) {
    if (
      (beat.startSeconds === undefined) !== (beat.endSeconds === undefined) ||
      (beat.startSeconds !== undefined &&
        (beat.startSeconds < end || beat.endSeconds! <= beat.startSeconds))
    )
      add('INVALID_TIMELINE', `节拍 ${beat.id} 的时间范围重叠或无效。`);
    if (beat.endSeconds !== undefined) end = beat.endSeconds;
    if (
      beat.characterDocumentIds.some(
        (id) => !instruction.subjects.some((s) => s.documentId === id),
      ) ||
      beat.dialogue.some((line) => !beat.characterDocumentIds.includes(line.characterDocumentId))
    )
      add('UNBOUND_SPEAKER', `节拍 ${beat.id} 的出场角色或说话人没有声明。`);
    if (instruction.audio.mode === 'silent' && beat.dialogue.length)
      add('SILENT_DIALOGUE', '无声模式不能包含对白。');
  }
  if (instruction.generation.duration !== undefined && end > instruction.generation.duration)
    add('DURATION_CONFLICT', '节拍结束时间超过要求的视频时长。');
  if (instruction.timing && end > instruction.timing.estimatedDurationSeconds)
    add('DURATION_CONFLICT', '镜头内动作节拍超过剧情预计时长。');
  issues.push(
    ...applyProductionFacts(emptyProductionFacts(), {
      ...instruction.continuity,
      before: [],
      after: [...instruction.continuity.before, ...instruction.continuity.after],
    }),
  );
  return issues;
}

export function inspectProductionTargetInstruction(
  instruction: ProductionInstruction,
  kind: string,
): ProductionIssue[] {
  const issues = inspectProductionInstruction(instruction);
  if (issues.length || instruction.version !== 2) return issues;
  const validate = kind === 'scene' ? validateScene : kind === 'shot' ? validateShot : undefined;
  if (validate && !validate(instruction))
    issues.push({ code: 'INVALID_INSTRUCTION', message: ajv.errorsText(validate.errors) });
  if (kind === 'scene') {
    if (!instruction.storyTime?.timeOfDay.trim())
      issues.push({ code: 'MISSING_STORY_TIME', message: '场次必须明确故事时段（日夜时间）。' });
    if (!instruction.location?.description.trim())
      issues.push({ code: 'MISSING_LOCATION', message: '场次必须明确地点环境。' });
    if (
      !instruction.visual.style?.trim() &&
      !Object.values(instruction.style ?? {}).some((value) => value.trim())
    )
      issues.push({ code: 'MISSING_STYLE', message: '场次必须明确视觉风格或采用的项目风格。' });
  }
  if (kind === 'shot') {
    if (!instruction.timing)
      issues.push({
        code: 'MISSING_SHOT_TIMING',
        message: '分镜必须包含根据剧情推导的预计时长和节奏依据。',
      });
    if (!instruction.beats.length)
      issues.push({ code: 'MISSING_SHOT_ACTION', message: '分镜必须描述实际动作或反应。' });
    if (!instruction.camera?.framing && !instruction.beats.some((beat) => beat.camera?.framing))
      issues.push({ code: 'MISSING_SHOT_FRAMING', message: '分镜必须明确景别。' });
  }
  return issues;
}

/** Provider padding is separate from authored story duration. */
export function resolveProductionDuration(
  adapter: AdapterDescriptor,
  seconds: number,
): number | undefined {
  const schema = adapter.parameterSchema.properties.duration;
  if (!schema || !Number.isFinite(seconds) || seconds <= 0) return undefined;
  const property = structuredClone(schema);
  for (const key of ['title', 'description', 'default']) delete property[key];
  const validate = new Ajv2020({ strict: false }).compile(property);
  const choices = schema.enum
    ? schema.enum
        .map(Number)
        .filter((value) => Number.isFinite(value) && value >= seconds)
        .sort((a, b) => a - b)
    : Array.from(
        {
          length: Math.max(
            0,
            Math.min(Number(schema.maximum ?? 3600), 3600) - Math.ceil(seconds) + 1,
          ),
        },
        (_, index) => Math.ceil(seconds) + index,
      );
  return choices.find((value) => validate(schema.type === 'string' ? String(value) : value));
}

/** Only schema-declared parameters are emitted. Unsupported intent is returned as a conflict. */
export function compileProductionParameters(
  instruction: ProductionInstruction,
  adapter: AdapterDescriptor,
  names: Record<string, string> = {},
  options: { prompt?: string; estimatedDurationSeconds?: number } = {},
): { parameters: AdapterParameters; issues: ProductionIssue[]; notices: ProductionIssue[] } {
  const issues = inspectProductionInstruction(instruction);
  const notices: ProductionIssue[] = [];
  const parameters: AdapterParameters = {};
  const properties = adapter.parameterSchema.properties;
  const video = adapter.capability.endsWith('_VIDEO');
  const still = !video && instruction.version === 2;
  let prompt =
    options.prompt ??
    renderProductionInstruction(
      still
        ? {
            ...instruction,
            summary: instruction.stillFrame ?? instruction.summary,
            beats: [],
            audio: { mode: 'silent' },
            timing: undefined,
            stillFrame: undefined,
            transition: undefined,
            subjects: instruction.subjects.map((subject) => ({
              ...subject,
              action: undefined,
              endState: undefined,
            })),
            continuity: { ...instruction.continuity, after: [] },
          }
        : instruction,
      names,
      { includeAudio: !still },
    );
  if (instruction.visual.negative && !properties.negative_prompt) {
    prompt += `\n画面约束：避免${instruction.visual.negative}`;
    notices.push({
      code: 'NEGATIVE_IN_PROMPT',
      message: '当前模型没有独立的负向提示词参数，已将画面约束保留在提示词中。',
    });
  }
  if (properties.prompt) parameters.prompt = prompt;
  else if (properties.content) parameters.content = [{ type: 'text', text: prompt }];
  else issues.push({ code: 'NO_PROMPT_MAPPING', message: '当前模型尚未登记结构化提示词映射。' });
  const mappings: Record<string, string> = {
    duration: 'duration',
    ratio: 'ratio',
    resolution: 'resolution',
    seed: 'seed',
    promptExtend: 'prompt_extend',
    watermark: 'watermark',
  };
  if (!properties.watermark && properties.aigc_watermark) mappings.watermark = 'aigc_watermark';
  // These are explicit equivalents in current contracts; no seconds/size/name guessing.
  if (!properties.ratio && properties.aspect_ratio) mappings.ratio = 'aspect_ratio';
  const generation = { ...instruction.generation };
  if (still) delete generation.duration;
  // Qwen's registered image contracts express output geometry as size, not video resolution.
  if (
    !video &&
    adapter.contractId?.startsWith('cn.qwen.qwen-image') &&
    properties.size &&
    generation.ratio &&
    generation.ratio !== 'adaptive'
  ) {
    const [widthRatio, heightRatio] = generation.ratio.split(':').map(Number);
    const resolution = generation.resolution?.toLowerCase();
    const shortEdge = resolution === '720p' ? 720 : resolution === '1080p' ? 1080 : undefined;
    const longEdge =
      resolution === '2k'
        ? 2048
        : resolution === '4k'
          ? 4096
          : resolution === undefined
            ? 1024
            : undefined;
    if (widthRatio && heightRatio && (shortEdge || longEdge)) {
      const scale = shortEdge
        ? shortEdge / Math.min(widthRatio, heightRatio)
        : longEdge! / Math.max(widthRatio, heightRatio);
      const width = Math.round(widthRatio * scale),
        height = Math.round(heightRatio * scale);
      parameters.size = `${width}x${height}`;
      if (width * height < 512 * 512 || width * height > 2048 * 2048)
        issues.push({
          code: 'IMAGE_SIZE_CONFLICT',
          message: '所需画幅与分辨率超出千问图像合同的像素范围，请调整图像输出规格。',
        });
      delete generation.ratio;
      delete generation.resolution;
    }
  }
  const storyDuration =
    options.estimatedDurationSeconds ?? instruction.timing?.estimatedDurationSeconds;
  if (video && properties.duration && storyDuration !== undefined) {
    if (generation.duration !== undefined && generation.duration < storyDuration)
      issues.push({
        code: 'STORY_DURATION_CONFLICT',
        message: '请求时长短于剧情预计时长，请调整制作安排；不能为模型上限压缩剧情。',
      });
    if (generation.duration === undefined) {
      const duration = resolveProductionDuration(adapter, storyDuration);
      if (duration === undefined)
        issues.push({
          code: 'SCENE_REQUIRES_SEGMENTS',
          message: `剧情预计${storyDuration}秒，超出当前模型单次时长能力。请按自然镜头分段制作，保留完整剧情。`,
        });
      else generation.duration = duration;
    }
  }
  for (const [key, value] of Object.entries(generation)) {
    const field = mappings[key]!;
    const labels: Record<string, string> = {
      duration: '请求时长',
      ratio: '画幅比例',
      resolution: '分辨率',
      seed: '随机种子',
      promptExtend: '提示词扩写',
      watermark: '水印',
    };
    if (!properties[field])
      notices.push({
        code: 'MODEL_PARAMETER_NOT_APPLIED',
        message: `当前模型没有${labels[key] ?? key}参数，本次不传入该设置；原制作偏好已保留。`,
      });
    else {
      const schema = properties[field];
      const resolutions: Record<string, string[]> = {
        '480p': ['480p', '480P'],
        '540p': ['540p', '540P'],
        '720p': ['720p', '720P'],
        '1080p': ['1080p', '1080P'],
        '2k': ['2k', '2K'],
        '4k': ['4k', '4K'],
      };
      const equivalents =
        key === 'resolution' && typeof value === 'string'
          ? resolutions[value.toLowerCase()]
          : undefined;
      parameters[field] =
        equivalents?.find((candidate) => schema.enum?.includes(candidate)) ??
        (key === 'duration' && schema.type === 'string' ? String(value) : value);
    }
  }
  if (instruction.visual.negative) {
    if (properties.negative_prompt) parameters.negative_prompt = instruction.visual.negative;
  }
  if (adapter.capability.endsWith('_VIDEO')) {
    const {
      outputField: audioField,
      voiceReference: voice,
      dialogueDriven: dialogue,
    } = productionAudioSupport(adapter);
    const needsVoice =
      instruction.audio.mode === 'voice-reference' ||
      instruction.resources.some((r) => r.required && r.kind === 'voice-reference');
    const needsDialogue =
      instruction.audio.mode === 'dialogue-driven' ||
      instruction.resources.some((r) => r.required && r.kind === 'dialogue-audio');
    if (audioField && instruction.audio.mode !== 'auto')
      parameters[audioField] = instruction.audio.mode !== 'silent';
    else if (audioField && (needsVoice || needsDialogue)) parameters[audioField] = true;
    else if (instruction.audio.mode === 'silent' || instruction.audio.mode === 'native')
      notices.push({
        code: 'AUDIO_IN_PROMPT',
        message: '当前模型未提供独立的声音开关；声音要求保留在提示词中，是否满足需检查成片。',
      });
    if (needsVoice && !voice)
      issues.push({
        code: 'UNSUPPORTED_VOICE_REFERENCE',
        message: '当前模型修订尚未接入角色音色参考。',
      });
    if (needsDialogue && !dialogue)
      issues.push({
        code: 'UNSUPPORTED_DIALOGUE_AUDIO',
        message: '当前模型修订尚未接入完整对白驱动。',
      });
  } else if (
    !still &&
    (instruction.beats.some((beat) => beat.dialogue.length) ||
      !['auto', 'silent'].includes(instruction.audio.mode) ||
      instruction.generation.duration !== undefined)
  ) {
    issues.push({
      code: 'IMAGE_VIDEO_INTENT',
      message: '图片制作指令不能包含视频时长、对白或声音要求。',
    });
  }
  for (const [field, value] of Object.entries(parameters)) {
    const property = structuredClone(properties[field]!);
    for (const metadata of ['title', 'description', 'default']) delete property[metadata];
    // UI annotations are not JSON Schema validation keywords.
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(property);
    if (!validate(value)) {
      if (
        ['duration', 'prompt', 'content', 'negative_prompt', 'audio', 'generate_audio'].includes(
          field,
        )
      )
        issues.push({
          code: 'PARAMETER_CONFLICT',
          message: `${field} 不符合所选模型规则：${ajv.errorsText(validate.errors)}`,
        });
      else {
        delete parameters[field];
        notices.push({
          code: 'MODEL_PARAMETER_NOT_APPLIED',
          message: `${properties[field]!.title ?? field}的制作偏好不符合当前模型范围，本次使用模型表单设置。`,
        });
      }
    }
  }
  return { parameters, issues, notices };
}
