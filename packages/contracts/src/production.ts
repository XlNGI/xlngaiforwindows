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
  /** Stable state for comparison; key/value remain human-readable descriptions. */
  comparison?: { entity: ProductionTarget; attribute: string; state: string };
}

/** Creative content is provider independent. Runtime state never comes from the model. */
export interface ProductionInstruction {
  version: 1 | 2;
  summary: string;
  /** Authoring uncertainties shown for review, never sent as visual instructions. */
  reviewNotes?: string[];
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
  /** Optional for Agent calls: Worker derives a stable key from the task and payload. */
  executionKey?: string;
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

interface ProductionSourceTarget {
  target: ProductionTarget;
  /** A contiguous production unit; the narrative scene itself stays intact. */
  shotIds?: string[];
  inputImages?: ProductionImageSelection[];
}

export interface ProductionInstructionSource extends ProductionSourceTarget {
  mode?: 'instruction';
  instructionId: string;
  revision: number;
  token: string;
}

/** The submitted form is authoritative; instruction metadata is provenance only. */
export interface ProductionFormSource extends ProductionSourceTarget {
  mode: 'form';
  instructionId?: string;
  revision?: number;
  token?: string;
}

export type ProductionSource = ProductionInstructionSource | ProductionFormSource;

export interface ProductionReadResult {
  target: ProductionTarget;
  rowVersion: number;
  instruction?: ProductionInstruction;
  source?: ProductionInstructionSource;
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
const textFields = (keys: string[], required: string[] = []) =>
  object(Object.fromEntries(keys.map((key) => [key, text])), required);
export const productionTargetSchema = object(
  { kind: { type: 'string', enum: ['character', 'setting', 'scene', 'shot'] }, id },
  ['kind', 'id'],
);
const facts = array(
  object(
    {
      key: id,
      value: text,
      comparison: {
        ...object({ entity: productionTargetSchema, attribute: id, state: id }, [
          'entity',
          'attribute',
          'state',
        ]),
        description:
          '可比较事实：entity 必须引用已保存的真实对象；attribute 和 state 使用前镜相同的稳定值，key/value 可补充动作说明。道具没有独立对象时引用所属场次，attribute 明确道具和属性。无法确认时省略 comparison 并报告待核实，不编造状态或 ID。',
      },
    },
    ['key', 'value'],
  ),
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
    reviewNotes: {
      ...strings,
      description:
        '资料之间存在无法确定的冲突或动作/对白归属不明时，逐项说明原文与待核实点。只作可编辑提醒，不擅自补造事实或台词，不写入画面描述。',
    },
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
    stillFrame: {
      ...text,
      description:
        '本镜单幅关键画面，说明人物位置、动作与构图；人物服装、发型沿用已确认设定或对应参考图，不因夜景、打斗或整体色调重设计。',
    },
    transition: object({
      entry: text,
      exit: text,
      overlapSeconds: { type: 'number', minimum: 0, maximum: 60 },
    }),
    subjects: array(
      object(
        {
          documentId: id,
          description: {
            ...text,
            description:
              '本镜人物身份及必要特征。沿用实际读取的角色设定与所选参考图；不能把创作补写的造型声称为“按角色设定板”，不整段复述设定板。',
          },
          wardrobe: {
            ...text,
            description:
              '仅填写已有资料确认的服装款式、材质与固有色，或用户/原文明确要求的本场换装。默认沿用对应角色参考图；未知则省略，不因冷峻、夜景或画面色调改成黑衣。',
          },
          position: {
            ...text,
            description:
              '本镜画面中的前中后景、左右、朝向、与门/工作台的关系及可通行路线；区分初始站位和后续移动，不仅填写地点名称。',
          },
          appearance: {
            ...text,
            description:
              '沿用已确认的人物外观和身体特征，不根据本镜情绪或类型擅自添加疤痕、布带、残缺等设定；未知细节省略。',
          },
          hairMakeup: {
            ...text,
            description:
              '发型、发色、发饰与妆容沿用已确认设定或所选参考图；只有用户/原文明确建立变化时才改动，不能为打斗自行改扎高马尾。',
          },
          expression: text,
          gaze: text,
          action: {
            ...text,
            description:
              '本镜可见动作概述；关键动作先后、停顿和反应放入 beats。行动符合已确认的视力、断肢、跛足及持物手设定；不凭身份标签自动补造动作。',
          },
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
  ['operations'],
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

export {
  renderProductionInstruction,
  renderProductionNegative,
  productionCharacterIds,
  inspectProductionPrompt,
} from './production-prompt.js';
