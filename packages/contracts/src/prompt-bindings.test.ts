import { describe, expect, it } from 'vitest';
import {
  validatePromptBindings,
  validatePromptRecord,
  validateProductionTiming,
} from './prompt-bindings.js';
import { validateProductionBundlePart } from './production-bundle.js';

describe('plain prompts and one binding contract', () => {
  it('keeps text verbatim and requires no creative template', () => {
    const prompt = '  一个固定机位。\n保留原文。  ';
    expect(validatePromptRecord({ prompt })).toEqual({ prompt });
    expect(validateProductionTiming({ estimatedDurationSeconds: 3.5 })).toEqual({
      estimatedDurationSeconds: 3.5,
    });
  });
  it('expresses empty scopes, default voices and offscreen voice relations with IDs', () => {
    const bindings = {
      schemaVersion: 1,
      characterDocumentIds: [],
      sceneDocumentIds: ['location'],
      propDocumentIds: [],
      voiceDocumentId: 'voice',
      voiceBindings: [{ characterDocumentId: 'offscreen', voiceDocumentId: 'voice' }],
    };
    expect(validatePromptBindings(bindings)).toEqual(bindings);
    expect(validatePromptBindings(bindings)).not.toBe(bindings);
  });
  it.each([
    { schemaVersion: 1, prompt: 'not a relationship' },
    { schemaVersion: 1, kind: 'character', data: {} },
    { schemaVersion: 1, timing: { estimatedDurationSeconds: 3 } },
    { schemaVersion: 1, characterDocumentIds: ['x', 'x'] },
    { schemaVersion: 1, characterDocumentIds: [''] },
    { schemaVersion: 1, voiceBindings: [{ voiceDocumentId: 'v' }, { voiceDocumentId: 'v' }] },
  ])('rejects non-binding data and invalid IDs: %j', (value) =>
    expect(() => validatePromptBindings(value)).toThrow(),
  );
  it('uses the same binding shape for candidate keys and saved IDs', () => {
    const part = {
      documents: [
        { localKey: 'c', kind: 'character', title: '角色', contentMarkdown: '普通提示词' },
      ],
      scenes: [{ localKey: 's', title: '场次', prompt: '整场提示词' }],
      shots: [
        {
          localKey: 'x',
          sceneKey: 's',
          title: '镜头',
          prompt: '  完整原文\n',
          bindings: {
            schemaVersion: 1,
            characterDocumentIds: [{ localKey: 'c' }],
            sceneDocumentIds: [],
            propDocumentIds: [],
          },
        },
      ],
    };
    expect(validateProductionBundlePart(part)).toEqual(part);
    expect(() =>
      validateProductionBundlePart({ ...part, shots: [{ ...part.shots[0], authoringIR: {} }] }),
    ).toThrow('unsupported');
  });
});
