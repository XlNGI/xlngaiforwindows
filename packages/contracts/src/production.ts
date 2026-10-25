import type { AdapterParameters, SceneInfo, SceneMediaResolveResult } from './index.js';
import type { ProductionAuthoringIR } from './project-ir.js';

export interface ProductionTarget {
  kind: 'character' | 'setting' | 'scene' | 'shot';
  id: string;
}

export interface ProductionIssue {
  code: string;
  message: string;
  target?: ProductionTarget;
  targetTitle?: string;
}

/** Preserve the business purpose until the selected model assigns an input role. */
export interface ProductionInputImage {
  url: string;
  role?: 'reference' | 'character' | 'scene' | 'first-frame' | 'last-frame';
  label?: string;
}

export interface ProductionImageSelection {
  assetId: string;
  role: NonNullable<ProductionInputImage['role']>;
  label?: string;
}

export interface ProductionFormSource {
  mode: 'form';
  target: ProductionTarget;
  token: string;
  shotIds?: string[];
  inputImages?: ProductionImageSelection[];
}

export type ProductionSource = ProductionFormSource;

export interface ProductionReadResult {
  target: ProductionTarget;
  rowVersion: number;
  authoringIR?: ProductionAuthoringIR;
  promptSource?: 'authoring-ir' | 'saved-prompt';
  issues: ProductionIssue[];
  notices?: ProductionIssue[];
  compiledPrompt?: string;
  timeline?: ProductionTimelineEntry[];
  estimatedDurationSeconds?: number;
}

export interface ProductionTimelineEntry {
  shotId: string;
  title: string;
  startSeconds?: number;
  endSeconds?: number;
  estimatedDurationSeconds?: number;
  prompt: string;
}

export interface ProductionSegment {
  shotIds: string[];
  estimatedDurationSeconds: number;
  requestedDurationSeconds?: number;
  needsShotRevision?: boolean;
}

export interface ProductionCompileParams {
  target: ProductionTarget;
  adapterKey: string;
  expectedToken?: string;
  shotIds?: string[];
  inputImages?: ProductionImageSelection[];
}

export interface ProductionCompileResult extends ProductionReadResult {
  parameters: AdapterParameters;
  source?: ProductionSource;
  requestedDurationSeconds?: number;
  segments?: ProductionSegment[];
  continuity?: import('./shot-continuity.js').ShotContinuityState;
  sceneInputs?: {
    scene: SceneInfo;
    media: SceneMediaResolveResult;
    characterNames: Record<string, string>;
  };
}

/** Project defaults are provider parameters only; creative intent belongs in prompt. */
export interface ProductionDefaults {
  generation?: {
    ratio?: string;
    resolution?: string;
    promptExtend?: boolean;
    watermark?: boolean;
  };
}

export interface ProductionDefaultsInfo {
  rowVersion: number;
  settings: ProductionDefaults;
}

const id = { type: 'string', minLength: 1, maxLength: 200 };
export const productionTargetSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'id'],
  properties: {
    kind: { type: 'string', enum: ['character', 'setting', 'scene', 'shot'] },
    id,
  },
};

export const productionDefaultsSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    generation: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ratio: { type: 'string', minLength: 1, maxLength: 40 },
        resolution: { type: 'string', minLength: 1, maxLength: 40 },
        promptExtend: { type: 'boolean' },
        watermark: { type: 'boolean' },
      },
    },
  },
};

export function productionImageReference(
  adapter: { contractId?: string; contractRevision?: number; capability?: string },
  index: number,
): string | undefined {
  const contract = adapter.contractId;
  if (contract === 'cn.qwen.wan2-7-i2v' && [1, 2].includes(adapter.contractRevision ?? 0))
    return index === 1 ? '首帧图' : index === 2 ? '尾帧图' : undefined;
  if (
    adapter.capability === 'START_END_TO_VIDEO' &&
    [1, 2, 3].includes(adapter.contractRevision ?? 0)
  )
    return index === 1 ? '首帧图' : index === 2 ? '尾帧图' : undefined;
  if (
    [2, 3].includes(adapter.contractRevision ?? 0) &&
    ['cn.qwen.wan3-0-video', 'cn.qwen.wan3-0-video-prime'].includes(contract ?? '')
  )
    return `图 ${index}`;
  if (
    [1, 2].includes(adapter.contractRevision ?? 0) &&
    [
      'cn.bytedance.seedance2-0.video',
      'cn.bytedance.seedance2-5.video',
      'cn.minimax.h3.video',
      'cn.minimax.h3-max.video',
    ].includes(contract ?? '')
  )
    return `图片${index}`;
  if (adapter.contractRevision === 1 && contract === 'cn.vidu.q4-preview.reference-video')
    return `@${index}`;
  if (
    adapter.contractRevision === 1 &&
    ['cn.happyhorse.1.0.r2v', 'cn.happyhorse.1.1.r2v'].includes(contract ?? '')
  )
    return `[image ${index}]`;
  return undefined;
}
