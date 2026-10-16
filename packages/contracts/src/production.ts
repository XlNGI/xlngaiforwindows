import type { AdapterParameters, SceneInfo, SceneMediaResolveResult } from './index.js';

export interface ProductionTarget {
  kind: 'character' | 'setting' | 'scene' | 'shot';
  id: string;
}

export interface ProductionFact {
  key: string;
  value: string;
}

/** Creative content is provider independent. Runtime state never comes from the model. */
export interface ProductionInstruction {
  version: 1;
  summary: string;
  subjects: Array<{
    documentId: string;
    description?: string;
    wardrobe?: string;
    position?: string;
  }>;
  visual: {
    environment?: string;
    composition?: string;
    lighting?: string;
    style?: string;
    palette?: string;
    lens?: string;
    negative?: string;
  };
  beats: Array<{
    id: string;
    startSeconds?: number;
    endSeconds?: number;
    action: string;
    characterDocumentIds: string[];
    camera?: { framing?: string; angle?: string; movement?: string; focus?: string };
    dialogue: Array<{
      characterDocumentId: string;
      text: string;
      emotion?: string;
      delivery?: string;
    }>;
  }>;
  audio: {
    mode: 'silent' | 'native' | 'voice-reference' | 'dialogue-driven';
    ambience?: string;
    music?: string;
    effects?: string;
  };
  generation: {
    duration?: number;
    ratio?: string;
    resolution?: string;
    seed?: number;
    promptExtend?: boolean;
    watermark?: boolean;
  };
  resources: Array<{
    kind:
      | 'character-image'
      | 'setting-image'
      | 'voice-reference'
      | 'dialogue-audio'
      | 'prop-image'
      | 'reference-video';
    documentId?: string;
    assetId?: string;
    required: boolean;
    purpose: string;
  }>;
  continuity: {
    predecessors: ProductionTarget[];
    before: ProductionFact[];
    after: ProductionFact[];
    locked: ProductionFact[];
    constraints: string[];
  };
}

export interface ProductionExecuteParams {
  executionKey: string;
  operations: Array<{
    action: 'set_prompt';
    target: ProductionTarget;
    expectedRowVersion: number;
    instruction: ProductionInstruction;
  }>;
}

export interface ProductionIssue {
  code: string;
  message: string;
}

export interface ProductionSource {
  target: ProductionTarget;
  instructionId: string;
  revision: number;
  token: string;
}

export interface ProductionReadResult {
  target: ProductionTarget;
  rowVersion: number;
  instruction?: ProductionInstruction;
  source?: ProductionSource;
  issues: ProductionIssue[];
}

export interface ProductionCompileParams {
  target: ProductionTarget;
  adapterKey: string;
  expectedToken?: string;
}

export interface ProductionCompileResult extends ProductionReadResult {
  parameters: AdapterParameters;
  sceneInputs?: {
    scene: SceneInfo;
    media: SceneMediaResolveResult;
    characterNames: Record<string, string>;
  };
}

const text = { type: 'string', minLength: 1, maxLength: 4000 };
const id = { type: 'string', minLength: 1, maxLength: 200 };
const strings = { type: 'array', maxItems: 50, uniqueItems: true, items: text };
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required,
});
const array = (items: unknown, maxItems = 50) => ({ type: 'array', maxItems, items });
const facts = array(object({ key: id, value: text }, ['key', 'value']));
export const productionTargetSchema = object(
  { kind: { type: 'string', enum: ['character', 'setting', 'scene', 'shot'] }, id },
  ['kind', 'id'],
);

export const productionInstructionSchema = object(
  {
    version: { type: 'integer', const: 1 },
    summary: text,
    subjects: array(
      object({ documentId: id, description: text, wardrobe: text, position: text }, ['documentId']),
      30,
    ),
    visual: object(
      Object.fromEntries(
        ['environment', 'composition', 'lighting', 'style', 'palette', 'lens', 'negative'].map(
          (key) => [key, text],
        ),
      ),
    ),
    beats: array(
      object(
        {
          id,
          startSeconds: { type: 'number', minimum: 0, maximum: 600 },
          endSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 600 },
          action: text,
          characterDocumentIds: { ...strings, items: id, maxItems: 30 },
          camera: object(
            Object.fromEntries(['framing', 'angle', 'movement', 'focus'].map((key) => [key, text])),
          ),
          dialogue: array(
            object({ characterDocumentId: id, text, emotion: text, delivery: text }, [
              'characterDocumentId',
              'text',
            ]),
            30,
          ),
        },
        ['id', 'action', 'characterDocumentIds', 'dialogue'],
      ),
      30,
    ),
    audio: object(
      {
        mode: { type: 'string', enum: ['silent', 'native', 'voice-reference', 'dialogue-driven'] },
        ambience: text,
        music: text,
        effects: text,
      },
      ['mode'],
    ),
    generation: object({
      duration: { type: 'integer', minimum: 1, maximum: 600 },
      ratio: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'] },
      resolution: { type: 'string', minLength: 1, maxLength: 40 },
      seed: { type: 'integer', minimum: -1, maximum: 2147483647 },
      promptExtend: { type: 'boolean' },
      watermark: { type: 'boolean' },
    }),
    resources: array(
      object(
        {
          kind: {
            type: 'string',
            enum: [
              'character-image',
              'setting-image',
              'voice-reference',
              'dialogue-audio',
              'prop-image',
              'reference-video',
            ],
          },
          documentId: id,
          assetId: id,
          required: { type: 'boolean' },
          purpose: text,
        },
        ['kind', 'required', 'purpose'],
      ),
    ),
    continuity: object(
      {
        predecessors: array(productionTargetSchema, 30),
        before: facts,
        after: facts,
        locked: facts,
        constraints: strings,
      },
      ['predecessors', 'before', 'after', 'locked', 'constraints'],
    ),
  },
  [
    'version',
    'summary',
    'subjects',
    'visual',
    'beats',
    'audio',
    'generation',
    'resources',
    'continuity',
  ],
);

export const productionExecuteSchema = object(
  {
    executionKey: { type: 'string', minLength: 1, maxLength: 120 },
    operations: {
      ...array(
        object(
          {
            action: { type: 'string', const: 'set_prompt' },
            target: productionTargetSchema,
            expectedRowVersion: { type: 'integer', minimum: 0 },
            instruction: productionInstructionSchema,
          },
          ['action', 'target', 'expectedRowVersion', 'instruction'],
        ),
        30,
      ),
      minItems: 1,
    },
  },
  ['executionKey', 'operations'],
);

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

/** Render authoring text without provider-specific numbering or hidden JSON. */
export function renderProductionInstruction(
  instruction: ProductionInstruction,
  names: Record<string, string> = {},
): string {
  const name = (documentId: string) => names[documentId] ?? '角色';
  return [
    instruction.summary,
    ...instruction.subjects.map((subject) =>
      [name(subject.documentId), subject.description, subject.wardrobe, subject.position]
        .filter(Boolean)
        .join('，'),
    ),
    ...Object.entries(instruction.visual)
      .filter(([key]) => key !== 'negative')
      .map(([, value]) => value),
    ...instruction.beats.map((beat) =>
      [
        beat.startSeconds === undefined ? undefined : `${beat.startSeconds}—${beat.endSeconds}秒`,
        beat.action,
        ...Object.values(beat.camera ?? {}),
        ...beat.dialogue.map(
          (line) =>
            `${name(line.characterDocumentId)}${[line.emotion, line.delivery].filter(Boolean).join('，')}说：“${line.text}”`,
        ),
      ]
        .filter(Boolean)
        .join('。'),
    ),
    instruction.audio.mode === 'silent'
      ? '无声音。'
      : [instruction.audio.ambience, instruction.audio.music, instruction.audio.effects]
          .filter(Boolean)
          .join('。'),
    ...instruction.continuity.before.map((fact) => `开始状态：${fact.key}=${fact.value}`),
    ...instruction.continuity.after.map((fact) => `结束状态：${fact.key}=${fact.value}`),
    ...instruction.continuity.locked.map((fact) => `保持不变：${fact.key}=${fact.value}`),
    ...instruction.continuity.constraints,
  ]
    .filter(Boolean)
    .join('\n');
}
