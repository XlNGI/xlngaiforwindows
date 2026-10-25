import { describe, expect, it } from 'vitest';
import { validateProductionAuthoringIR, validateProjectContentIR } from './project-ir.js';

describe('project content IR', () => {
  it('accepts open-ended JSON fields while enforcing the document kind envelope', () => {
    const value = {
      schemaVersion: 1,
      kind: 'prop',
      data: {
        silhouette: '细长剑匣',
        dimensions: { length: 80, unit: 'cm' },
        details: ['铁锈', '旧布缠柄'],
      },
    };

    expect(validateProjectContentIR(value, 'prop')).toEqual(value);
    expect(() => validateProjectContentIR(value, 'character')).toThrow(/must match document kind/);
    expect(() => validateProjectContentIR({ ...value, extra: true })).toThrow(/unsupported field/);
  });

  it('rejects non-JSON values, excessive nesting and oversized payloads', () => {
    expect(() =>
      validateProjectContentIR({ schemaVersion: 1, kind: 'scene', data: { invalid: NaN } }),
    ).toThrow(/JSON values/);
    expect(() =>
      validateProjectContentIR({
        schemaVersion: 1,
        kind: 'scene',
        data: { text: '界'.repeat(20_000) },
      }),
    ).toThrow(/32768 bytes/);

    let nested: Record<string, unknown> = {};
    const data: Record<string, unknown> = nested;
    for (let depth = 0; depth < 30; depth += 1) {
      nested.child = {};
      nested = nested.child as Record<string, unknown>;
    }
    expect(() => validateProjectContentIR({ schemaVersion: 1, kind: 'character', data })).toThrow(
      /complexity limits/,
    );
  });
});

describe('production authoring IR', () => {
  it('accepts scene prompts and rejects legacy prompt-scope fields', () => {
    const base = { schemaVersion: 1, kind: 'scene', prompt: '  完整场次\n镜头甲，镜头乙。  ' };
    expect(validateProductionAuthoringIR(base)).toEqual(base);
    for (const invalid of [
      { ...base, promptScope: 'complete' },
      { ...base, sharedPrompt: '室内清晨。' },
    ])
      expect(() => validateProductionAuthoringIR(invalid)).toThrow(/unsupported field/);
    expect(() => validateProductionAuthoringIR({ ...base, prompt: '界'.repeat(11000) })).toThrow(
      /32768 bytes/,
    );
  });
  it('validates optional runtime timing without requiring legacy creative fields', () => {
    const base = { schemaVersion: 1, kind: 'shot', prompt: '门缓缓打开。' };
    expect(
      validateProductionAuthoringIR({
        ...base,
        timing: { estimatedDurationSeconds: 4.5, rationale: '开门和停顿' },
      }).timing?.estimatedDurationSeconds,
    ).toBe(4.5);
    for (const seconds of [0, -1, 3601, NaN, Infinity, '5', null])
      expect(() =>
        validateProductionAuthoringIR({
          ...base,
          timing: { estimatedDurationSeconds: seconds, rationale: '开门' },
        }),
      ).toThrow(/estimatedDurationSeconds/);
    expect(() =>
      validateProductionAuthoringIR({
        ...base,
        timing: { estimatedDurationSeconds: 5, rationale: ' ' },
      }),
    ).toThrow(/rationale/);
    expect(() =>
      validateProductionAuthoringIR({
        ...base,
        timing: { estimatedDurationSeconds: 5, rationale: '开门', duration: 5 },
      }),
    ).toThrow(/unsupported field/);
  });

  it('accepts an Agent-authored prompt, project IDs and arbitrary creative data', () => {
    const value = {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '固定机位，门口雾气渐浓。',
      references: { characterDocumentIds: ['character-1'], propDocumentIds: ['prop-1'] },
      data: { blocking: [{ subjectId: 'character-1', mark: '炉边' }], uncertainty: null },
    };
    expect(validateProductionAuthoringIR(value, 'shot')).toEqual(value);
  });

  it('rejects mismatched kind, duplicate IDs, invalid JSON and prompt overflow', () => {
    const base = { schemaVersion: 1, kind: 'scene', prompt: '场次提示词' };
    expect(() => validateProductionAuthoringIR(base, 'shot')).toThrow(/must be "shot"/);
    expect(() =>
      validateProductionAuthoringIR({
        ...base,
        references: { propDocumentIds: ['prop-1', 'prop-1'] },
      }),
    ).toThrow(/unique project IDs/);
    expect(() => validateProductionAuthoringIR({ ...base, data: { invalid: Infinity } })).toThrow(
      /JSON values/,
    );
    expect(() => validateProductionAuthoringIR({ ...base, prompt: '太长'.repeat(10_001) })).toThrow(
      /between 1 and 20000 characters/,
    );
  });
});
