import { expect, it } from 'vitest';
import {
  projectTaskPending,
  savedArtifactReceipt,
  projectTaskStateResult,
  modelResultReceipt,
  projectBundleReadResult,
} from './agent-context-results.js';
import type { StoredToolResult } from '@ai-video/persistence';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';
import { BUNDLE_PROMPT_READ_VIEW } from './production-bundle-schema.js';

it('projects retained batch pages once, preserves evicted pages and suppresses superseded candidate text', () => {
  const page = (localKey: string, hash: string, text: string) => ({
    status: 'bundle_candidate_read',
    localKey,
    hash,
    view: BUNDLE_PROMPT_READ_VIEW,
    contentPage: { offset: 0, text, totalCharacters: text.length },
  });
  const included = page('hero', 'v1', '已读且当前的角色正文'),
    evicted = page('room', 'v1', '超出工作集但仍当前的地点正文'),
    superseded = page('phone', 'v1', '旧版道具正文不能当作当前内容');
  const result: StoredToolResult = {
    id: 'batch',
    callId: 'read',
    toolName: 'production.bundle',
    status: 'completed',
    content: JSON.stringify({
      status: 'bundle_candidates_read',
      reads: [included, evicted, superseded],
      remaining: [{ localKey: 'next', offset: 100 }],
    }),
    contentHash: 'batch-hash',
    arguments: {},
    version: 1,
  };
  const current = new Map([
    ['hero', 'v1'],
    ['room', 'v1'],
    ['phone', 'v2'],
  ]);
  const projected = projectBundleReadResult(result, current, [included])!;
  expect(projected).not.toContain(included.contentPage.text);
  expect(projected).toContain(evicted.contentPage.text);
  expect(projected).not.toContain(superseded.contentPage.text);
  expect(JSON.parse(projected)).toMatchObject({
    reads: [
      { status: 'candidate_page_included', localKey: 'hero' },
      evicted,
      { status: 'candidate_page_superseded', localKey: 'phone' },
    ],
    remaining: [{ localKey: 'next', offset: 100 }],
  });
  expect(result.content).toContain(superseded.contentPage.text);
  // A different range of the same candidate cannot stand in for the requested page.
  const single = { ...result, content: JSON.stringify(included) };
  expect(
    projectBundleReadResult(single, current, [
      { ...included, contentPage: { ...included.contentPage, offset: 1 } },
    ]),
  ).toBe(single.content);
  expect(projectBundleReadResult({ ...result, status: 'failed' }, current, [])).toBeUndefined();
  expect(projectBundleReadResult({ ...result, content: 'opaque' }, current, [])).toBeUndefined();
  const oldView = { ...included, view: undefined };
  const oldResult = { ...result, content: JSON.stringify(oldView) };
  expect(projectBundleReadResult(oldResult, current, [])).not.toContain(included.contentPage.text);
  expect(oldResult.content).toContain(included.contentPage.text);
  unifiedAgentToolRegistry.assertResultText(projected);
});

it('delivers a requested immutable result range directly instead of externalizing it recursively', () => {
  const content = JSON.stringify({
    status: 'task_result_read',
    resultId: 'original',
    offset: 16000,
    endOffset: 32000,
    totalCharacters: 50000,
    nextOffset: 32000,
    content: '原始要求与审查正文'.repeat(1500),
  });
  const result: StoredToolResult = {
    id: 'range',
    callId: 'read',
    toolName: 'conversation.task.checkpoint',
    status: 'completed',
    content,
    contentHash: 'hash',
    arguments: {},
    version: 1,
  };
  expect(content.length).toBeGreaterThan(6000);
  expect(modelResultReceipt(result)).toBe(content);
  unifiedAgentToolRegistry.assertResultText(modelResultReceipt(result));
});

it.each(['bundle_source_read', 'bundle_candidate_read', 'bundle_candidates_read'])(
  'delivers already bounded %s pages and continuation cursors without a second layer of result paging',
  (status) => {
    const page = {
      status,
      contentPage: { text: '普通提示词'.repeat(1500), offset: 0, nextOffset: 7500 },
      remaining: [{ localKey: 'next', offset: 7500 }],
    };
    const result: StoredToolResult = {
      id: 'page',
      callId: 'read',
      toolName: 'production.bundle',
      status: 'completed',
      content: JSON.stringify(page),
      contentHash: 'hash',
      arguments: {},
      version: 1,
    };
    expect(result.content.length).toBeGreaterThan(6000);
    expect(modelResultReceipt(result)).toBe(result.content);
    unifiedAgentToolRegistry.assertResultText(modelResultReceipt(result));
    expect(JSON.parse(modelResultReceipt({ ...result, toolName: 'other.tool' }))).toMatchObject({
      externalized: true,
    });
    expect(
      JSON.parse(
        modelResultReceipt({
          ...result,
          content: JSON.stringify({ ...page, contentPage: { text: '中'.repeat(17000) } }),
        }),
      ),
    ).toMatchObject({ externalized: true });
    expect(() =>
      modelResultReceipt({ ...result, content: JSON.stringify({ ...page, apiKey: 'forbidden' }) }),
    ).toThrow('FORBIDDEN');
  },
);

it('externalizes short results with oversized nested collections without discarding the immutable body', () => {
  const content = JSON.stringify({
    status: 'task_state_read',
    pendingActions: [{ missing: Array.from({ length: 101 }, (_, i) => i) }],
  });
  expect(content.length).toBeLessThan(6000);
  const result: StoredToolResult = {
    id: 'full',
    callId: 'call',
    toolName: 'runtime.task.state',
    status: 'completed',
    content,
    contentHash: 'hash',
    arguments: {},
    version: 1,
  };
  const receipt = modelResultReceipt(result);
  unifiedAgentToolRegistry.assertResultText(receipt);
  expect(JSON.parse(receipt)).toMatchObject({
    externalized: true,
    externalizedFields: ['pendingActions'],
    read: { resultId: 'full', expectedHash: 'hash' },
  });
  expect(result.content).toBe(content);
  expect(() =>
    modelResultReceipt({
      ...result,
      content: JSON.stringify({ invalid: { apiKey: 'sensitive' } }),
    }),
  ).toThrow('FORBIDDEN');
});

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
