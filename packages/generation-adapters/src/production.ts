import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  productionDefaultsSchema,
  validateProductionAuthoringIR,
  type AdapterDescriptor,
  type AdapterParameters,
  type ProductionAuthoringIR,
  type ProductionDefaults,
  type ProductionIssue,
} from '@ai-video/contracts';

const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateDefaults = ajv.compile(productionDefaultsSchema);

export function parseProductionDefaults(input: unknown): ProductionDefaults {
  if (!validateDefaults(input))
    throw new Error(`项目生成设置无效：${ajv.errorsText(validateDefaults.errors)}`);
  return structuredClone(input as ProductionDefaults);
}

/** Resolve story timing to a provider-supported duration without changing the authored IR. */
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

/** Compile only the authored prompt and explicit timing/provider fields. */
export function compileProductionParameters(
  input: ProductionAuthoringIR,
  adapter: AdapterDescriptor,
  options: {
    prompt?: string;
    estimatedDurationSeconds?: number;
    generation?: ProductionDefaults['generation'];
  } = {},
): { parameters: AdapterParameters; issues: ProductionIssue[]; notices: ProductionIssue[] } {
  const ir = validateProductionAuthoringIR(input);
  const issues: ProductionIssue[] = [];
  const notices: ProductionIssue[] = [];
  const parameters: AdapterParameters = {};
  const properties = adapter.parameterSchema.properties;
  const prompt = options.prompt ?? ir.prompt;

  if (properties.prompt) parameters.prompt = prompt;
  else if (properties.content) parameters.content = [{ type: 'text', text: prompt }];
  else issues.push({ code: 'NO_PROMPT_MAPPING', message: '当前模型没有已登记的提示词参数。' });

  const generation: Record<string, unknown> = { ...options.generation };
  const video = adapter.capability.endsWith('_VIDEO');
  const storyDuration = options.estimatedDurationSeconds ?? ir.timing?.estimatedDurationSeconds;
  if (
    video &&
    properties.duration &&
    storyDuration !== undefined &&
    generation.duration === undefined
  ) {
    const duration = resolveProductionDuration(adapter, storyDuration);
    if (duration === undefined)
      issues.push({
        code: 'SCENE_REQUIRES_SEGMENTS',
        message: `剧情预计${storyDuration}秒，超出当前模型单次时长能力。请按自然镜头分段制作。`,
      });
    else generation.duration = duration;
  }

  const mappings: Record<string, string> = {
    duration: 'duration',
    ratio: 'ratio',
    resolution: 'resolution',
    promptExtend: 'prompt_extend',
    watermark: 'watermark',
  };
  if (!properties.watermark && properties.aigc_watermark) mappings.watermark = 'aigc_watermark';
  if (!properties.ratio && properties.aspect_ratio) mappings.ratio = 'aspect_ratio';

  if (
    !video &&
    adapter.contractId?.startsWith('cn.qwen.qwen-image') &&
    properties.size &&
    typeof generation.ratio === 'string' &&
    generation.ratio !== 'adaptive'
  ) {
    const [widthRatio, heightRatio] = generation.ratio.split(':').map(Number);
    const resolution =
      typeof generation.resolution === 'string' ? generation.resolution.toLowerCase() : undefined;
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
      const width = Math.round(widthRatio * scale);
      const height = Math.round(heightRatio * scale);
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

  for (const [key, value] of Object.entries(generation)) {
    const field = mappings[key];
    if (!field) continue;
    const property = properties[field];
    if (!property) {
      notices.push({
        code: 'MODEL_PARAMETER_NOT_APPLIED',
        message: `当前模型不支持 Provider 参数 ${key}，本次不传入该设置。`,
      });
      continue;
    }
    const equivalents =
      key === 'resolution' && typeof value === 'string'
        ? (
            {
              '480p': ['480p', '480P'],
              '540p': ['540p', '540P'],
              '720p': ['720p', '720P'],
              '1080p': ['1080p', '1080P'],
              '2k': ['2k', '2K'],
              '4k': ['4k', '4K'],
            } as Record<string, string[]>
          )[value.toLowerCase()]
        : undefined;
    const candidate =
      equivalents?.find((entry) => property.enum?.includes(entry)) ??
      (key === 'duration' && property.type === 'string' ? String(value) : value);
    const schema = structuredClone(property);
    for (const metadata of ['title', 'description', 'default']) delete schema[metadata];
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
    if (validate(candidate)) parameters[field] = candidate as AdapterParameters[string];
    else
      issues.push({
        code: 'PARAMETER_CONFLICT',
        message: `Provider 参数 ${field} 不符合所选模型规则：${ajv.errorsText(validate.errors)}`,
      });
  }

  return { parameters, issues, notices };
}
