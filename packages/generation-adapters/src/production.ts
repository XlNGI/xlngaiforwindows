import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  productionExecuteSchema,
  productionInstructionSchema,
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
    before: instruction.continuity.before.map((f) => f.key),
    after: instruction.continuity.after.map((f) => f.key),
    locked: instruction.continuity.locked.map((f) => f.key),
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
  for (const fact of instruction.continuity.locked)
    if (
      [...instruction.continuity.before, ...instruction.continuity.after].some(
        (value) => value.key === fact.key && value.value !== fact.value,
      )
    )
      add('LOCKED_FACT_CHANGED', `锁定状态 ${fact.key} 被改变。`);
  return issues;
}

/** Only schema-declared parameters are emitted. Unsupported intent is returned as a conflict. */
export function compileProductionParameters(
  instruction: ProductionInstruction,
  adapter: AdapterDescriptor,
  names: Record<string, string> = {},
): { parameters: AdapterParameters; issues: ProductionIssue[] } {
  const issues = inspectProductionInstruction(instruction);
  const parameters: AdapterParameters = {};
  const properties = adapter.parameterSchema.properties;
  const prompt = renderProductionInstruction(instruction, names);
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
  for (const [key, value] of Object.entries(instruction.generation)) {
    const field = mappings[key]!;
    if (!properties[field])
      issues.push({
        code: 'UNSUPPORTED_PARAMETER',
        message: `当前模型不支持制作要求中的 ${key}。`,
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
    else
      issues.push({
        code: 'UNSUPPORTED_NEGATIVE_PROMPT',
        message: '当前模型没有独立的负向提示词字段，请调整制作要求。',
      });
  }
  if (adapter.capability.endsWith('_VIDEO')) {
    const audioField =
      properties.audio?.type === 'boolean'
        ? 'audio'
        : properties.generate_audio?.type === 'boolean'
          ? 'generate_audio'
          : undefined;
    const wan =
      [2, 3].includes(adapter.contractRevision ?? 0) &&
      ['cn.qwen.wan3-0-video', 'cn.qwen.wan3-0-video-prime'].includes(adapter.contractId ?? '');
    const current = [1, 2].includes(adapter.contractRevision ?? 0);
    const voice =
      wan ||
      (current &&
        [
          'cn.bytedance.seedance2-0.video',
          'cn.bytedance.seedance2-5.video',
          'cn.minimax.h3.video',
          'cn.minimax.h3-max.video',
        ].includes(adapter.contractId ?? ''));
    const dialogue = current && adapter.contractId === 'cn.qwen.wan2-7-i2v';
    const nativeOnly =
      current &&
      ['cn.minimax.h3.video', 'cn.minimax.h3-max.video'].includes(adapter.contractId ?? '');
    if (audioField) parameters[audioField] = instruction.audio.mode !== 'silent';
    else if (
      !(nativeOnly && instruction.audio.mode !== 'silent') &&
      !(dialogue && instruction.audio.mode === 'dialogue-driven') &&
      instruction.audio.mode !== 'silent'
    )
      issues.push({
        code: 'UNSUPPORTED_AUDIO',
        message: '当前模型合同未登记所需有声输出，请调整模型或声音要求。',
      });
    if (instruction.audio.mode === 'silent' && nativeOnly)
      issues.push({
        code: 'UNSUPPORTED_AUDIO',
        message: '当前模型没有登记关闭声音的方法，请调整模型或声音要求。',
      });
    if (instruction.audio.mode === 'voice-reference' && !voice)
      issues.push({
        code: 'UNSUPPORTED_VOICE_REFERENCE',
        message: '当前模型修订尚未接入角色音色参考。',
      });
    if (instruction.audio.mode === 'dialogue-driven' && !dialogue)
      issues.push({
        code: 'UNSUPPORTED_DIALOGUE_AUDIO',
        message: '当前模型修订尚未接入完整对白驱动。',
      });
  } else if (
    instruction.beats.some((beat) => beat.dialogue.length) ||
    instruction.audio.mode !== 'silent' ||
    instruction.generation.duration !== undefined
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
    if (!validate(value))
      issues.push({
        code: 'PARAMETER_CONFLICT',
        message: `${field} 不符合所选模型规则：${ajv.errorsText(validate.errors)}`,
      });
  }
  return { parameters, issues };
}
