import { expect, it } from 'vitest';
import {
  projectTaskPending,
  savedArtifactReceipt,
  projectTaskStateResult,
} from './agent-context-results.js';
import type { StoredToolResult } from '@ai-video/persistence';

it('projects duplicate contract fields and saved metadata without modifying durable task data', () => {
  const contract = {
    key: 'shots',
    requiredTexts: ['用户对白'.repeat(2000)],
    minimumCount: 6,
    criteria: [{ type: 'duration', seconds: 60 }],
  };
  const pending = [
    {
      ...contract,
      remainingCount: 2,
      nextAction: { kind: 'continue_outputs' },
      constraint: '必须保持蓝衣',
    },
  ];
  const before = JSON.stringify({ contract, pending });
  const view = projectTaskPending(pending, [contract]);
  expect(view).toEqual([
    {
      key: 'shots',
      remainingCount: 2,
      nextAction: { kind: 'continue_outputs' },
      constraint: '必须保持蓝衣',
    },
  ]);
  expect(JSON.stringify({ contract, pending })).toBe(before);
  const content = JSON.stringify({
    status: 'scene_structure_saved',
    sceneIds: ['scene'],
    prompt: '完整正文'.repeat(3000),
    execution: { effect: 'created' },
  });
  const result: StoredToolResult = {
    id: 'result',
    callId: 'call',
    toolName: 'scene.submit_structure',
    status: 'completed',
    content,
    contentHash: 'hash',
    arguments: {},
    version: 1,
  };
  expect(savedArtifactReceipt(result)).toEqual({
    status: 'scene_structure_saved',
    sceneIds: ['scene'],
    execution: { effect: 'created' },
  });
  expect(result.content).toBe(content);
  expect(JSON.stringify(savedArtifactReceipt(result)).length).toBeLessThan(content.length / 10);
});

it('uses the current task projection in historical state results while preserving archived requirements', () => {
  const content = JSON.stringify({
    status: 'task_state_read',
    taskGoal: '当前任务',
    pendingActions: [{ old: true }],
    records: [
      { kind: 'pending', value: '历史状态' },
      { kind: 'userRequirement', text: '较早仍有效的要求' },
    ],
  });
  const result: StoredToolResult = {
    id: 'state',
    callId: 'call',
    toolName: 'conversation.task.checkpoint',
    status: 'completed',
    content,
    contentHash: 'hash',
    arguments: { operation: 'state' },
    version: 1,
  };
  const view = JSON.parse(projectTaskStateResult(result, '当前任务', [])) as Record<
    string,
    unknown
  >;
  expect(view.pendingActionsReference).toBe('taskState.pendingSteps');
  expect(view.records).toEqual([{ kind: 'userRequirement', text: '较早仍有效的要求' }]);
  expect(result.content).toBe(content);
});
