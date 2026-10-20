import type { AdapterParameters, SceneInfo, SceneMediaResolveResult } from './index.js';

export interface ProductionTarget {
  kind: 'character' | 'setting' | 'scene' | 'shot';
  id: string;
}

/** Story order relates scene/shot occurrences, never reusable reference documents. */
export type ProductionPredecessor = ProductionTarget & { kind: 'scene' | 'shot' };

export interface ProductionFact {
  key: string;
  value: string;
}

/** Creative content is provider independent. Runtime state never comes from the model. */
export interface ProductionInstruction {
  version: 1 | 2;
  summary: string;
  narrative?: { purpose: string; conflict?: string; emotionalProgression?: string };
  storyTime?: {
    era?: string;
    season?: string;
    storyDay?: string;
    date?: string;
    timeOfDay: string;
    clockTime?: string;
  };
  location?: {
    description: string;
    interiorExterior?: string;
    area?: string;
    weather?: string;
    geography?: string;
    layout?: string;
    state?: string;
  };
  style?: {
    medium?: string;
    technique?: string;
    realism?: string;
    proportions?: string;
    linework?: string;
    materials?: string;
    palette?: string;
    contrast?: string;
    texture?: string;
    referenceDescription?: string;
  };
  camera?: {
    framing?: string;
    angle?: string;
    composition?: string;
    lens?: string;
    depthOfField?: string;
    focus?: string;
    movement?: string;
    speed?: string;
    amplitude?: string;
    startFrame?: string;
    endFrame?: string;
    axis?: string;
  };
  lightingDesign?: {
    source?: string;
    direction?: string;
    quality?: string;
    colorTemperature?: string;
    fill?: string;
    rim?: string;
    practicals?: string;
  };
  /** Authored from story needs, never stretched to fit a provider duration. */
  timing?: { estimatedDurationSeconds: number; rationale: string };
  stillFrame?: string;
  transition?: { entry?: string; exit?: string; overlapSeconds?: number };
  subjects: Array<{
    documentId: string;
    description?: string;
    wardrobe?: string;
    position?: string;
    appearance?: string;
    hairMakeup?: string;
    expression?: string;
    gaze?: string;
    action?: string;
    props?: string;
    initialState?: string;
    endState?: string;
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
    mode: 'auto' | 'silent' | 'native' | 'voice-reference' | 'dialogue-driven';
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
      | 'style-image'
      | 'reference-video';
    documentId?: string;
    assetId?: string;
    required: boolean;
    purpose: string;
  }>;
  continuity: {
    predecessors: ProductionPredecessor[];
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
  target?: ProductionTarget;
  targetTitle?: string;
  changedReferences?: Array<{ target: ProductionTarget; title: string }>;
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

export interface ProductionSource {
  target: ProductionTarget;
  instructionId: string;
  revision: number;
  token: string;
  /** A contiguous production unit; the narrative scene itself stays intact. */
  shotIds?: string[];
  inputImages?: ProductionImageSelection[];
}

export interface ProductionReadResult {
  target: ProductionTarget;
  rowVersion: number;
  instruction?: ProductionInstruction;
  source?: ProductionSource;
  issues: ProductionIssue[];
  /** Model-specific preferences that were adapted; never block submission. */
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
  /** Local workflow provenance; never a Provider parameter. */
  continuity?: import('./shot-continuity.js').ShotContinuityState;
  parameters: AdapterParameters;
  requestedDurationSeconds?: number;
  segments?: ProductionSegment[];
  sceneInputs?: {
    scene: SceneInfo;
    media: SceneMediaResolveResult;
    characterNames: Record<string, string>;
  };
}

export interface ProductionDefaults {
  style?: ProductionInstruction['style'];
  visual?: ProductionInstruction['visual'];
  generation?: Pick<
    ProductionInstruction['generation'],
    'ratio' | 'resolution' | 'promptExtend' | 'watermark'
  >;
}
export interface ProductionDefaultsInfo {
  rowVersion: number;
  settings: ProductionDefaults;
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
const textFields = (keys: string[], required: string[] = []) =>
  object(Object.fromEntries(keys.map((key) => [key, text])), required);
export const productionTargetSchema = object(
  { kind: { type: 'string', enum: ['character', 'setting', 'scene', 'shot'] }, id },
  ['kind', 'id'],
);

const productionPredecessorSchema = {
  ...object({ kind: { type: 'string', enum: ['scene', 'shot'] }, id }, ['kind', 'id']),
  description:
    '剧情上承接的已保存场次或镜头。角色和场景设定是资料引用，不是前置剧情；通过 subjects、sceneDocumentId、characterDocumentIds 引用。首场、独立创作或没有真实前镜 ID 时使用空数组，不编造依赖。',
};

export const productionInstructionSchema = object(
  {
    version: { type: 'integer', enum: [1, 2] },
    summary: text,
    narrative: textFields(['purpose', 'conflict', 'emotionalProgression'], ['purpose']),
    storyTime: textFields(
      ['era', 'season', 'storyDay', 'date', 'timeOfDay', 'clockTime'],
      ['timeOfDay'],
    ),
    location: textFields(
      ['description', 'interiorExterior', 'area', 'weather', 'geography', 'layout', 'state'],
      ['description'],
    ),
    style: textFields([
      'medium',
      'technique',
      'realism',
      'proportions',
      'linework',
      'materials',
      'palette',
      'contrast',
      'texture',
      'referenceDescription',
    ]),
    camera: textFields([
      'framing',
      'angle',
      'composition',
      'lens',
      'depthOfField',
      'focus',
      'movement',
      'speed',
      'amplitude',
      'startFrame',
      'endFrame',
      'axis',
    ]),
    lightingDesign: textFields([
      'source',
      'direction',
      'quality',
      'colorTemperature',
      'fill',
      'rim',
      'practicals',
    ]),
    timing: object(
      {
        estimatedDurationSeconds: { type: 'number', exclusiveMinimum: 0, maximum: 3600 },
        rationale: text,
      },
      ['estimatedDurationSeconds', 'rationale'],
    ),
    stillFrame: text,
    transition: object({
      entry: text,
      exit: text,
      overlapSeconds: { type: 'number', minimum: 0, maximum: 60 },
    }),
    subjects: array(
      object(
        {
          documentId: id,
          description: text,
          wardrobe: text,
          position: text,
          appearance: text,
          hairMakeup: text,
          expression: text,
          gaze: text,
          action: text,
          props: text,
          initialState: text,
          endState: text,
        },
        ['documentId'],
      ),
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
        mode: {
          type: 'string',
          enum: ['auto', 'silent', 'native', 'voice-reference', 'dialogue-driven'],
          description:
            'auto 沿用所选模型默认声音设置；silent 明确无声；native 由模型生成声音。对白文字不等于录音驱动，只有明确使用角色声音样本时选择 voice-reference，明确使用完整对白录音时选择 dialogue-driven。',
        },
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
              'style-image',
              'reference-video',
            ],
          },
          documentId: id,
          assetId: id,
          required: {
            type: 'boolean',
            description:
              '仅对用户明确选用且本次制作不可替换的素材设为 true。出现对白不代表必须提供对白录音；未选用录音时不得自动将其标记为必需素材。',
          },
          purpose: text,
        },
        ['kind', 'required', 'purpose'],
      ),
    ),
    continuity: object(
      {
        predecessors: array(productionPredecessorSchema, 30),
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

/** New authoring calls use the detailed version; saved v1 data stays readable. */
export const detailedProductionInstructionSchema = {
  ...productionInstructionSchema,
  required: [...productionInstructionSchema.required, 'narrative'],
  properties: { ...productionInstructionSchema.properties, version: { type: 'integer', const: 2 } },
};

/** Shared by model tools and Worker authoring validation; saved v1 remains readable. */
export const sceneProductionInstructionSchema = {
  ...detailedProductionInstructionSchema,
  required: [...detailedProductionInstructionSchema.required, 'storyTime', 'location'],
  anyOf: [
    { required: ['style'], properties: { style: { type: 'object', minProperties: 1 } } },
    {
      required: ['visual'],
      properties: {
        visual: { type: 'object', required: ['style'], properties: { style: { type: 'string' } } },
      },
    },
  ],
};

export const shotProductionInstructionSchema = {
  ...detailedProductionInstructionSchema,
  required: [...detailedProductionInstructionSchema.required, 'timing', 'stillFrame'],
  properties: {
    ...detailedProductionInstructionSchema.properties,
    beats: {
      ...(productionInstructionSchema.properties.beats as Record<string, unknown>),
      minItems: 1,
    },
  },
};

export const productionDefaultsSchema = object({
  style: productionInstructionSchema.properties.style,
  visual: productionInstructionSchema.properties.visual,
  generation: object({
    ratio: { type: 'string', enum: ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16', 'adaptive'] },
    resolution: text,
    promptExtend: { type: 'boolean' },
    watermark: { type: 'boolean' },
  }),
});

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
  options: { includeAudio?: boolean } = {},
): string {
  const name = (documentId: string) => names[documentId] ?? '角色';
  return [
    instruction.summary,
    instruction.narrative
      ? `叙事目的：${instruction.narrative.purpose}${instruction.narrative.conflict ? `；冲突：${instruction.narrative.conflict}` : ''}${instruction.narrative.emotionalProgression ? `；情绪变化：${instruction.narrative.emotionalProgression}` : ''}`
      : undefined,
    instruction.storyTime
      ? `故事时间：${Object.values(instruction.storyTime).filter(Boolean).join('，')}`
      : undefined,
    instruction.location
      ? `地点环境：${Object.values(instruction.location).filter(Boolean).join('，')}`
      : undefined,
    Object.values(instruction.style ?? {}).some(Boolean)
      ? `视觉风格：${Object.values(instruction.style!).filter(Boolean).join('，')}`
      : undefined,
    instruction.timing
      ? `剧情预计时长：${instruction.timing.estimatedDurationSeconds}秒；节奏依据：${instruction.timing.rationale}`
      : undefined,
    instruction.stillFrame ? `画面定格：${instruction.stillFrame}` : undefined,
    ...instruction.subjects.map((subject) =>
      [
        name(subject.documentId),
        subject.description,
        subject.appearance,
        subject.wardrobe,
        subject.hairMakeup,
        subject.position,
        subject.expression,
        subject.gaze,
        subject.action,
        subject.props,
        subject.initialState,
        subject.endState,
      ]
        .filter(Boolean)
        .join('，'),
    ),
    ...Object.entries(instruction.visual)
      .filter(([key]) => key !== 'negative')
      .map(([, value]) => value),
    Object.values(instruction.camera ?? {}).some(Boolean)
      ? `镜头设计：${Object.values(instruction.camera!).filter(Boolean).join('，')}`
      : undefined,
    Object.values(instruction.lightingDesign ?? {}).some(Boolean)
      ? `灯光设计：${Object.values(instruction.lightingDesign!).filter(Boolean).join('，')}`
      : undefined,
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
    options.includeAudio === false
      ? undefined
      : instruction.audio.mode === 'silent'
        ? '无声音。'
        : [instruction.audio.ambience, instruction.audio.music, instruction.audio.effects]
            .filter(Boolean)
            .join('。'),
    ...instruction.continuity.before.map((fact) => `开始状态：${fact.key}=${fact.value}`),
    ...instruction.continuity.after.map((fact) => `结束状态：${fact.key}=${fact.value}`),
    ...instruction.continuity.locked.map((fact) => `保持不变：${fact.key}=${fact.value}`),
    ...instruction.continuity.constraints,
    instruction.transition?.entry ? `入镜衔接：${instruction.transition.entry}` : undefined,
    instruction.transition?.exit ? `出镜衔接：${instruction.transition.exit}` : undefined,
  ]
    .filter(Boolean)
    .join('\n');
}
