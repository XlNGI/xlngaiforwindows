import { describe, expect, it } from 'vitest';
import {
  productionImageReference,
  renderProductionInstruction,
  type ProductionInstruction,
} from '@ai-video/contracts';
import { getAdapterCatalog } from './index.js';
import {
  compileProductionParameters,
  inspectProductionInstruction,
  parseProductionExecution,
  inspectProductionTargetInstruction,
  resolveProductionDuration,
} from './production.js';

function instruction(): ProductionInstruction {
  return {
    version: 1,
    summary: '林澈走进雨夜的车站。',
    subjects: [{ documentId: 'actor', wardrobe: '蓝色外套' }],
    visual: { lighting: '冷色顶光', composition: '人物位于画面左侧' },
    beats: [
      {
        id: 'enter',
        startSeconds: 0,
        endSeconds: 5,
        action: '走近车门',
        characterDocumentIds: ['actor'],
        camera: { framing: '中景', movement: '缓慢跟拍' },
        dialogue: [],
      },
    ],
    audio: { mode: 'silent' },
    generation: { duration: 5, ratio: '16:9' },
    resources: [],
    continuity: {
      predecessors: [],
      before: [{ key: 'door', value: 'closed' }],
      after: [{ key: 'door', value: 'open' }],
      locked: [{ key: 'coat', value: 'blue' }],
      constraints: ['保持雨夜'],
    },
  };
}
const adapter = (id: string, capability = 'REFERENCE_TO_VIDEO') =>
  getAdapterCatalog().adapters.find(
    (a) => a.contractId === id && a.capability === capability && a.provider !== 'unicompapi',
  )!;

describe('structured production compiler', () => {
  it.each(getAdapterCatalog().adapters)(
    'projects shared preferences onto $key without inventing required parameters',
    (model) => {
      const spec = instruction();
      spec.generation = {
        duration: 5,
        ratio: '16:9',
        resolution: '1080p',
        seed: 7,
        promptExtend: false,
        watermark: false,
      };
      const result = compileProductionParameters(spec, model);
      expect(
        Object.keys(result.parameters).every((field) =>
          Object.hasOwn(model.parameterSchema.properties, field),
        ),
        model.key,
      ).toBe(true);
      expect(
        result.issues.some((issue) =>
          ['UNSUPPORTED_PARAMETER', 'UNSUPPORTED_AUDIO'].includes(issue.code),
        ),
        model.key,
      ).toBe(false);
      expect(result.parameters).not.toHaveProperty('promptExtend');
    },
  );
  it('uses model defaults when audio has not been explicitly selected', () => {
    const spec = instruction();
    spec.audio = { mode: 'auto' };
    for (const model of [
      adapter('cn.qwen.wan3-0-video'),
      adapter('cn.bytedance.seedance2-0.video'),
    ]) {
      const result = compileProductionParameters(spec, model);
      expect(result.issues).toEqual([]);
      expect(result.parameters).not.toHaveProperty('audio');
      expect(result.parameters).not.toHaveProperty('generate_audio');
      expect(JSON.stringify(result.parameters)).not.toContain('无声音');
    }
  });
  it('keeps an image-driven model usable when it cannot accept a separate ratio or audio switch', () => {
    const model = getAdapterCatalog().adapters.find(
      (a) => a.contractId === 'cn.happyhorse.1.1.i2v',
    )!;
    const spec = instruction();
    spec.audio = { mode: 'native', ambience: '雨声与风声' };
    spec.generation = { ratio: '9:16', seed: -1, promptExtend: true };
    spec.timing = { estimatedDurationSeconds: 8, rationale: '人物观察和停顿' };
    const before = structuredClone(spec);
    const result = compileProductionParameters(spec, model);
    expect(result.issues).toEqual([]);
    expect(result.parameters.duration).toBe(8);
    expect(result.parameters.prompt).toContain('雨声与风声');
    expect(result.parameters).not.toHaveProperty('ratio');
    expect(result.parameters).not.toHaveProperty('seed');
    expect(result.parameters).not.toHaveProperty('audio');
    expect(result.notices.map((n) => n.code)).toContain('MODEL_PARAMETER_NOT_APPLIED');
    expect(spec).toEqual(before);
  });
  it('does not require duration on a video editing schema and retains the authored timing', () => {
    const model = getAdapterCatalog().adapters.find(
      (a) => a.contractId === 'cn.happyhorse.1.0.video-edit',
    )!;
    const spec = instruction();
    spec.timing = { estimatedDurationSeconds: 36, rationale: '保留原视频节奏' };
    const result = compileProductionParameters(spec, model);
    expect(result.issues).toEqual([]);
    expect(result.parameters).not.toHaveProperty('duration');
    expect(result.parameters.prompt).toContain('36秒');
    expect(result.notices.some((n) => n.message.includes('请求时长'))).toBe(true);
  });
  it('uses declared audio input variants rather than model names and still blocks missing input capabilities', () => {
    const spec = instruction();
    spec.audio = { mode: 'voice-reference' };
    const model = adapter('cn.qwen.wan3-0-video');
    expect(
      compileProductionParameters(spec, {
        ...model,
        contractId: 'another-model',
        contractRevision: 99,
      }).issues,
    ).toEqual([]);
    const blocked = {
      ...model,
      parameterSchema: {
        ...model.parameterSchema,
        properties: {
          ...model.parameterSchema.properties,
          media: {
            type: 'array' as const,
            title: '仅图片',
            items: {
              type: 'object',
              properties: { type: { const: 'reference_image' } },
              not: { properties: { type: { const: 'reference_audio' } } },
            },
          },
        },
      },
    };
    expect(compileProductionParameters(spec, blocked).issues.map((i) => i.code)).toContain(
      'UNSUPPORTED_VOICE_REFERENCE',
    );
    spec.audio = { mode: 'native' };
    spec.resources = [
      { kind: 'voice-reference', documentId: 'actor', required: true, purpose: '指定音色' },
    ];
    expect(compileProductionParameters(spec, blocked).issues.map((i) => i.code)).toContain(
      'UNSUPPORTED_VOICE_REFERENCE',
    );
    spec.resources = [];
    spec.audio = { mode: 'dialogue-driven' };
    expect(compileProductionParameters(spec, blocked).issues.map((i) => i.code)).toContain(
      'UNSUPPORTED_DIALOGUE_AUDIO',
    );
  });
  it('keeps story time, detailed style and narrative pacing independent of model duration', () => {
    const spec: ProductionInstruction = {
      ...instruction(),
      version: 2,
      narrative: { purpose: '发现线索', emotionalProgression: '疑惑转为警觉' },
      storyTime: { era: '现代', season: '深秋', timeOfDay: '傍晚' },
      location: { description: '车站候车厅', weather: '雨后' },
      style: { medium: '二维动画', technique: '赛璐璐', linework: '细线' },
      timing: { estimatedDurationSeconds: 5.2, rationale: '完成开门与观察反应' },
      generation: { ratio: '16:9' },
      camera: { framing: '中景' },
      stillFrame: '开门前停下的瞬间',
    };
    const model = {
      ...adapter('cn.qwen.wan3-0-video'),
      parameterSchema: {
        ...adapter('cn.qwen.wan3-0-video').parameterSchema,
        properties: {
          ...adapter('cn.qwen.wan3-0-video').parameterSchema.properties,
          duration: { type: 'integer' as const, title: '时长', enum: [5, 10] },
        },
      },
    };
    const result = compileProductionParameters(spec, model);
    expect(result.issues).toEqual([]);
    expect(result.parameters.duration).toBe(10);
    expect(spec.timing?.estimatedDurationSeconds).toBe(5.2);
    expect(spec.generation.duration).toBeUndefined();
    expect(result.parameters.prompt).toContain('深秋');
    expect(result.parameters.prompt).toContain('赛璐璐');
    expect(resolveProductionDuration(model, 23)).toBeUndefined();
    const limited = compileProductionParameters(
      spec,
      model,
      {},
      { estimatedDurationSeconds: 23, prompt: '全部分镜原文' },
    );
    expect(limited.parameters.prompt).toBe('全部分镜原文');
    expect(limited.issues.map((issue) => issue.code)).toContain('SCENE_REQUIRES_SEGMENTS');
  });
  it('requires story context for detailed scenes and content-derived timing for each new shot', () => {
    const spec = { ...instruction(), version: 2 as const, narrative: { purpose: '发现线索' } };
    expect(inspectProductionTargetInstruction(spec, 'scene').map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['MISSING_STORY_TIME', 'MISSING_LOCATION', 'MISSING_STYLE']),
    );
    expect(inspectProductionTargetInstruction(spec, 'shot').map((issue) => issue.code)).toContain(
      'MISSING_SHOT_TIMING',
    );
    expect(inspectProductionTargetInstruction(instruction(), 'scene')).toEqual([]);
  });
  it('renders one still frame from a detailed shot and maps Qwen image geometry without video actions or audio', () => {
    const spec: ProductionInstruction = {
      ...instruction(),
      version: 2,
      narrative: { purpose: '观察线索' },
      stillFrame: '林澈在开门前停下',
      timing: { estimatedDurationSeconds: 5.2, rationale: '完成观察与反应' },
      generation: { ratio: '9:16', resolution: '1080p' },
      audio: { mode: 'native' },
      beats: [
        {
          id: 'line',
          action: '开门后说话',
          characterDocumentIds: ['actor'],
          dialogue: [{ characterDocumentId: 'actor', text: '终于到了' }],
        },
      ],
    };
    const model = getAdapterCatalog().adapters.find(
      (item) =>
        item.contractId === 'cn.qwen.qwen-image-3-0-pro' && item.capability === 'TEXT_TO_IMAGE',
    )!;
    const result = compileProductionParameters(spec, model);
    expect(result.issues).toEqual([]);
    expect(result.parameters.size).toBe('1080x1920');
    expect(result.parameters).not.toHaveProperty('duration');
    expect(result.parameters.prompt).toContain('开门前停下');
    expect(result.parameters.prompt).not.toContain('终于到了');
    expect(result.parameters.prompt).not.toContain('无声音');
    expect(result.parameters.prompt).not.toContain('结束状态');
  });
  it('renders creative intent and explicit states, maps the actual Wan and Seedance schemas', () => {
    const spec = instruction();
    const wan = compileProductionParameters(spec, adapter('cn.qwen.wan3-0-video'), {
      actor: '林澈',
    });
    expect(wan.issues).toEqual([]);
    expect(wan.parameters).toMatchObject({ duration: 5, ratio: '16:9', audio: false });
    expect(wan.parameters.prompt).toContain('人物「林澈」：外观与服装：蓝色外套');
    expect(wan.parameters.prompt).toContain('结束状态：door=open');
    expect(wan.parameters.prompt).toContain('保持不变：coat=blue');
    spec.generation.resolution = '720p';
    expect(
      compileProductionParameters(spec, adapter('cn.qwen.wan3-0-video')).parameters.resolution,
    ).toBe('720P');
    const seedance = compileProductionParameters(spec, adapter('cn.bytedance.seedance2-0.video'));
    expect(seedance.issues).toEqual([]);
    expect(seedance.parameters.content).toEqual([
      { type: 'text', text: renderProductionInstruction(spec) },
    ]);
    expect(seedance.parameters.generate_audio).toBe(false);
    expect(seedance.parameters.resolution).toBe('720p');
    expect(seedance.parameters).not.toHaveProperty('prompt');
  });
  it('binds reference dialect to a known contract revision, with independent image indices', () => {
    expect(productionImageReference(adapter('cn.qwen.wan3-0-video'), 2)).toBe('图 2');
    expect(productionImageReference(adapter('cn.bytedance.seedance2-0.video'), 2)).toBe('图片2');
    expect(
      productionImageReference({ contractId: 'cn.qwen.wan3-0-video', contractRevision: 1 }, 2),
    ).toBeUndefined();
    expect(
      productionImageReference({ contractId: 'cn.qwen.wan3-0-video', contractRevision: 99 }, 2),
    ).toBeUndefined();
  });
  it.each([true, false])(
    'adapts optional prompt expansion to each model without changing the authored instruction (enabled=%s)',
    (enabled) => {
      const spec = instruction();
      spec.generation.promptExtend = enabled;
      const before = structuredClone(spec);
      const happyhorse = getAdapterCatalog().adapters.find(
        (model) => model.contractId === 'cn.happyhorse.1.1.r2v' && model.provider === 'unicompapi',
      )!;
      for (const model of [happyhorse, adapter('cn.bytedance.seedance2-0.video')]) {
        expect(model.parameterSchema.properties).not.toHaveProperty('prompt_extend');
        const result = compileProductionParameters(spec, model);
        expect(result.issues).toEqual([]);
        expect(result.parameters).not.toHaveProperty('prompt_extend');
        expect(result.parameters).not.toHaveProperty('promptExtend');
        expect(result.parameters.duration).toBe(5);
        expect(result.parameters.prompt ?? result.parameters.content).toEqual(
          model.parameterSchema.properties.prompt
            ? renderProductionInstruction(spec)
            : [{ type: 'text', text: renderProductionInstruction(spec) }],
        );
      }
      const wan = compileProductionParameters(spec, adapter('cn.qwen.wan3-0-video'));
      expect(wan.issues).toEqual([]);
      expect(wan.parameters.prompt_extend).toBe(enabled);
      expect(spec).toEqual(before);
    },
  );
  it('reports unsupported intent and schema conflicts without silently dropping it', () => {
    const spec = instruction();
    spec.visual.negative = '模糊';
    spec.generation.duration = 600;
    spec.generation.seed = 7;
    const result = compileProductionParameters(spec, adapter('cn.bytedance.seedance2-0.video'));
    expect(result.issues.map((i) => i.code)).toEqual(['PARAMETER_CONFLICT']);
    expect(result.notices.map((i) => i.code)).toEqual(
      expect.arrayContaining(['MODEL_PARAMETER_NOT_APPLIED', 'NEGATIVE_IN_PROMPT']),
    );
    expect(JSON.stringify(result.parameters.content)).toContain('避免模糊');
    spec.audio.mode = 'dialogue-driven';
    expect(
      compileProductionParameters(spec, adapter('cn.qwen.wan3-0-video')).issues.map((i) => i.code),
    ).toContain('UNSUPPORTED_DIALOGUE_AUDIO');
    spec.audio.mode = 'voice-reference';
    const legacyWan = getAdapterCatalog().adapters.find(
      (a) => a.contractId === 'cn.qwen.wan3-0-video' && a.provider === 'unicompapi',
    )!;
    expect(compileProductionParameters(spec, legacyWan).issues.map((i) => i.code)).toContain(
      'UNSUPPORTED_VOICE_REFERENCE',
    );
  });
  it('rejects undeclared speakers, overlap, locked changes, unknown fields and false runtime states', () => {
    const spec = instruction();
    spec.beats[0]!.dialogue = [{ characterDocumentId: 'invented', text: '你好' }];
    spec.beats.push({ ...spec.beats[0]!, id: 'second', startSeconds: 4, endSeconds: 8 });
    spec.continuity.after.push({ key: 'coat', value: 'red' });
    expect(inspectProductionInstruction(spec).map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'UNBOUND_SPEAKER',
        'INVALID_TIMELINE',
        'SILENT_DIALOGUE',
        'DURATION_CONFLICT',
        'LOCKED_FACT_CHANGED',
      ]),
    );
    const list = {
      executionKey: 'e1',
      operations: [
        {
          action: 'set_prompt',
          target: { kind: 'scene', id: 'scene' },
          expectedRowVersion: 1,
          instruction: instruction(),
        },
      ],
    };
    expect(parseProductionExecution(list)).toEqual(list);
    expect(() => parseProductionExecution({ ...list, status: 'succeeded' })).toThrow('无效');
    expect(() =>
      parseProductionExecution({
        ...list,
        operations: [{ ...list.operations[0], instruction: { ...instruction(), vendor: 'guess' } }],
      }),
    ).toThrow('无效');
  });
});
