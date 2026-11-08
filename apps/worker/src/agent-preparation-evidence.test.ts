import { expect, it } from 'vitest';
import { taskEvidenceKey } from './agent-preparation-evidence.js';

it('ignores a new execution ID for the same save but recognizes new target versions', () => {
  const receipt = {
    status: 'shot_prompts_saved',
    executionId: 'a',
    shots: [{ shotId: 's', rowVersion: 2 }],
  };
  const key = taskEvidenceKey('scene.update_shot_prompts', receipt);
  expect(taskEvidenceKey('scene.update_shot_prompts', { ...receipt, executionId: 'b' })).toBe(key);
  expect(
    taskEvidenceKey('scene.update_shot_prompts', {
      ...receipt,
      shots: [{ shotId: 's', rowVersion: 3 }],
    }),
  ).not.toBe(key);
});

it('compares a loaded tool set independently of request order and loading guidance', () => {
  expect(taskEvidenceKey('tools.load', { loaded: ['b', 'a'], instructions: 'first' })).toBe(
    taskEvidenceKey('tools.load', { loaded: ['a', 'b'], newlyLoaded: [], instructions: 'reuse' }),
  );
});
