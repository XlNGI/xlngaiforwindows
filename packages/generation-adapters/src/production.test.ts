import { describe, expect, it } from 'vitest';
import type { ProductionAuthoringIR } from '@ai-video/contracts';
import { getAdapterCatalog } from './index.js';
import { compileProductionParameters, parseProductionDefaults } from './production.js';

const adapter = (contractId = 'cn.qwen.wan3-0-video') =>
  getAdapterCatalog().adapters.find(
    (value) =>
      value.contractId === contractId &&
      value.capability === 'TEXT_TO_VIDEO' &&
      value.provider !== 'unicompapi',
  )!;

describe('IR to Provider parameter mapping', () => {
  it.each(['cn.qwen.wan3-0-video', 'cn.bytedance.seedance2-0.video', 'cn.minimax.h3.video'])(
    'preserves authored text and ignores open data for %s',
    (contractId) => {
      const ir: ProductionAuthoringIR = {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '  冷雨中转身。\n保留同期声。  ',
        data: { prompt: '禁止替换正文', generation: { duration: 999 }, style: '不要渲染' },
      };
      const before = structuredClone(ir);
      const descriptor = adapter(contractId);
      const compiled = compileProductionParameters(ir, descriptor);
      const text = descriptor.parameterSchema.properties.prompt
        ? compiled.parameters.prompt
        : (compiled.parameters.content as Array<{ type: string; text?: string }>).find(
            (item) => item.type === 'text',
          )?.text;
      expect(text).toBe(ir.prompt);
      expect(compiled.parameters).not.toHaveProperty('duration');
      expect(JSON.stringify(compiled.parameters)).not.toContain('不要渲染');
      expect(ir).toEqual(before);
    },
  );

  it('reports unsupported explicit duration without rewriting the story or changing saved timing', () => {
    const ir: ProductionAuthoringIR = {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '完整剧情保持原样',
      timing: { estimatedDurationSeconds: 3600, rationale: '完整演出时长' },
    };
    const result = compileProductionParameters(ir, adapter());
    expect(result.issues).toMatchObject([{ code: 'SCENE_REQUIRES_SEGMENTS' }]);
    expect(result.parameters.prompt).toBe(ir.prompt);
    expect(result.parameters).not.toHaveProperty('duration');
    expect(ir.timing?.estimatedDurationSeconds).toBe(3600);
  });

  it('validates Provider defaults independently of creative data', () => {
    expect(() => parseProductionDefaults({ style: { medium: '写实' } })).toThrow('无效');
    expect(() => parseProductionDefaults({ generation: { duration: 5 } })).toThrow('无效');
    const ir: ProductionAuthoringIR = { schemaVersion: 1, kind: 'scene', prompt: '原文' };
    const result = compileProductionParameters(ir, adapter(), {
      generation: { ratio: 'invalid-ratio' },
    });
    expect(result.issues).toMatchObject([{ code: 'PARAMETER_CONFLICT' }]);
    expect(result.parameters.prompt).toBe('原文');
    expect(result.parameters).not.toHaveProperty('ratio');
  });
});
