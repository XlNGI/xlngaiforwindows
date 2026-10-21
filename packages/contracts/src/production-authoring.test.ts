import { expect, it } from 'vitest';
import {
  normalizeProductionAuthoringArguments,
  normalizeProductionAuthoringInstruction,
} from './production-authoring.js';

it('omits empty optional descriptions without changing required values, IDs, unknown fields or source input', () => {
  const input = {
    summary: '',
    storyTime: { timeOfDay: '', date: '  ', era: '架空' },
    subjects: [{ documentId: '', position: '', action: '连续敲击两次' }],
    beats: [{ action: '', dialogue: [{ characterDocumentId: '', text: '', emotion: '' }] }],
    unknown: '',
    generation: { resolution: '' },
  };
  const value = normalizeProductionAuthoringInstruction(input);
  expect(value).toEqual({
    summary: '',
    storyTime: { timeOfDay: '', era: '架空' },
    subjects: [{ documentId: '', action: '连续敲击两次' }],
    beats: [{ action: '', dialogue: [{ characterDocumentId: '', text: '' }] }],
    unknown: '',
    generation: { resolution: '' },
  });
  expect(input.storyTime.date).toBe('  ');
});

it('normalizes only known authoring instruction locations, retaining final form and all other arguments', () => {
  const instruction = { storyTime: { timeOfDay: '夜', date: '' } };
  const args = { scene: { instruction }, shots: [{ instruction }], expectedRowVersion: 0 };
  expect(normalizeProductionAuthoringArguments('scene.structure.stage', args)).toEqual({
    scene: { instruction: { storyTime: { timeOfDay: '夜' } } },
    shots: [{ instruction: { storyTime: { timeOfDay: '夜' } } }],
    expectedRowVersion: 0,
  });
  expect(normalizeProductionAuthoringArguments('media.video.prepare', args)).toEqual(args);
});
