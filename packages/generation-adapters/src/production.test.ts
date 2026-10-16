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
  it('renders creative intent and explicit states, maps the actual Wan and Seedance schemas', () => {
    const spec = instruction();
    const wan = compileProductionParameters(spec, adapter('cn.qwen.wan3-0-video'), {
      actor: '林澈',
    });
    expect(wan.issues).toEqual([]);
    expect(wan.parameters).toMatchObject({ duration: 5, ratio: '16:9', audio: false });
    expect(wan.parameters.prompt).toContain('林澈，蓝色外套');
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
  it('reports unsupported intent and schema conflicts without silently dropping it', () => {
    const spec = instruction();
    spec.visual.negative = '模糊';
    spec.generation.duration = 600;
    spec.generation.seed = 7;
    const result = compileProductionParameters(spec, adapter('cn.bytedance.seedance2-0.video'));
    expect(result.issues.map((i) => i.code)).toEqual(
      expect.arrayContaining([
        'UNSUPPORTED_PARAMETER',
        'UNSUPPORTED_NEGATIVE_PROMPT',
        'PARAMETER_CONFLICT',
      ]),
    );
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
