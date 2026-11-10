import { expect, it } from 'vitest';
import type { Context } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { assertNoReadLoop, type ReadLoopSupervision } from './agent-context-budget.js';
import { modelResultReceipt } from './agent-context-results.js';

function exchange(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  result: unknown,
  isError = false,
): Context['messages'] {
  return [
    fauxAssistantMessage([fauxToolCall(tool, args, { id })], { stopReason: 'toolUse' }),
    {
      role: 'toolResult',
      toolName: tool,
      toolCallId: id,
      isError,
      timestamp: 1,
      content: [
        { type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) },
      ],
    },
  ];
}
const checkpoint = 'conversation.task.checkpoint';
const planFailure = (i: number, legacy = false) =>
  exchange(
    `plan-${i}`,
    checkpoint,
    {
      operation: 'plan',
      deliverables: [
        ...(i % 2 ? [{ key: 'unrelated', description: `变化${i}` }] : []),
        {
          key: 'shots',
          intent: i % 2 ? 'reuse' : 'revise',
          targetIds: ['scene'],
          description: `已保存${i}`,
        },
      ],
      revisionReason: `第${i}次修改`,
    },
    legacy
      ? `deliverables[${i % 2}].origin: confirmed user obligations and their requirement sources cannot be removed.`
      : {
          error: {
            message: `conflict ${i}`,
            repair: {
              kind: 'plan',
              code: 'TASK_PLAN_USER_OBLIGATION',
              field: 'intent',
              planKey: 'shots',
              index: i % 2,
              received: i % 2 ? 'reuse' : 'revise',
            },
          },
        },
    true,
  );

it.each([false, true])(
  'groups changed/reordered plan failures by the protected key (legacy=%s)',
  (legacy) => {
    const messages = [0, 1, 2].flatMap((i) => planFailure(i, legacy));
    expect(() => assertNoReadLoop({ messages })).not.toThrow();
    expect(() => assertNoReadLoop({ messages: [...messages, ...planFailure(3, legacy)] })).toThrow(
      'AGENT_TOOL_FAILURE_STALLED',
    );
  },
);

it('unrelated discovery and successful plan prose changes do not forgive a known obligation failure', () => {
  const messages = [0, 1, 2, 3].flatMap((i) => [
    ...planFailure(i),
    ...exchange(
      `nav-${i}`,
      'project.structure.get',
      {},
      { status: 'read', resources: [{ id: `unrelated-${i}` }] },
    ),
    ...exchange(
      `saved-${i}`,
      checkpoint,
      { operation: 'plan', deliverables: [{ key: 'shots', description: `说明${i}` }] },
      { status: 'task_plan_saved', contractHash: `new-${i}`, deliverables: [{ key: 'shots' }] },
    ),
  ]);
  expect(() => assertNoReadLoop({ messages })).toThrow('AGENT_TOOL_FAILURE_STALLED');
});

it('preserves scoped supervision across serialization and new user instructions allow another repair', () => {
  let state: ReadLoopSupervision = {};
  for (const i of [0, 1, 2]) {
    assertNoReadLoop({ messages: planFailure(i) }, state);
    state = JSON.parse(JSON.stringify(state)) as ReadLoopSupervision;
  }
  expect(JSON.stringify(state)).not.toContain('shots');
  const before = structuredClone(state);
  expect(() => assertNoReadLoop({ messages: planFailure(3) }, state)).toThrow(
    'AGENT_TOOL_FAILURE_STALLED',
  );
  expect(() =>
    assertNoReadLoop(
      {
        messages: [
          { role: 'user', content: '按已保存目标继续验收', timestamp: 2 },
          ...planFailure(4),
        ],
      },
      before,
    ),
  ).not.toThrow();
});

it('only fresh related evidence or accepted coverage resets a scoped review failure', () => {
  const fail = (i: number) =>
    exchange(
      `bad-${i}`,
      checkpoint,
      {
        operation: 'review',
        reviewId: 'snapshot',
        requirementAssessments: [{ targetId: 'shot', requirementQuote: `错误${i}` }],
      },
      {
        error: {
          repair: {
            kind: 'review',
            code: 'TASK_REVIEW_REQUIREMENTS_INVALID',
            field: 'requirementQuote',
            targetId: 'shot',
            requirementId: 'original',
            reviewId: 'snapshot',
          },
        },
      },
      true,
    );
  const read = (offset: number) =>
    exchange(
      `read-${offset}`,
      checkpoint,
      { operation: 'result', resultId: 'snapshot' },
      {
        status: 'task_result_read',
        resultId: 'snapshot',
        contentHash: 'immutable',
        offset,
        endOffset: offset + 100,
      },
    );
  const first = [...[0, 1, 2].flatMap(fail), ...read(0), ...[3, 4, 5].flatMap(fail)];
  expect(() => assertNoReadLoop({ messages: first })).not.toThrow();
  expect(() => assertNoReadLoop({ messages: [...first, ...read(0), ...fail(6)] })).toThrow(
    'AGENT_TOOL_FAILURE_STALLED',
  );
  expect(() => assertNoReadLoop({ messages: [...first, ...read(100), ...fail(6)] })).not.toThrow();
  const review = (id: string) =>
    exchange(
      'partial',
      checkpoint,
      { operation: 'review', reviewedTargetIds: ['shot', id], reviewId: 'snapshot' },
      {
        status: 'task_review_recorded',
        protocolVersion: 5,
        conclusion: 'partial',
        rejectedTargetIds: ['shot'],
        coverage: [{ id, key: 'v2', dependencyHash: 'd2' }],
      },
    );
  expect(() =>
    assertNoReadLoop({ messages: [...first, ...review('other-shot'), ...fail(6)] }),
  ).toThrow('AGENT_TOOL_FAILURE_STALLED');
  expect(() =>
    assertNoReadLoop({ messages: [...first, ...review('shot'), ...fail(6)] }),
  ).not.toThrow();
});

it('related saved versions permit repair while independent targets have no total-call cutoff', () => {
  const messages = [0, 1, 2].flatMap((i) => planFailure(i));
  messages.push(
    ...exchange(
      'saved',
      'scene.submit_structure',
      {},
      {
        status: 'scene_structure_saved',
        sceneIds: ['scene'],
        execution: { effect: 'updated', receiptId: 'new' },
      },
    ),
  );
  expect(() => assertNoReadLoop({ messages: [...messages, ...planFailure(3)] })).not.toThrow();
  const independent = Array.from({ length: 60 }, (_, i) =>
    exchange(
      `independent-${i}`,
      checkpoint,
      { operation: 'plan' },
      {
        error: {
          repair: {
            kind: 'plan',
            code: 'TASK_PLAN_USER_OBLIGATION',
            field: 'intent',
            planKey: `key-${i}`,
          },
        },
      },
      true,
    ),
  ).flat();
  expect(() => assertNoReadLoop({ messages: independent })).not.toThrow();
});

it('keeps partial review repairs and current inspection facts inline when history is externalized', () => {
  const inspectionSummary = {
    taskId: 'same-task',
    elapsedMs: 4756000,
    saved: { scenes: 4, shots: 13 },
    review: { readyToSubmit: true, approved: false },
  };
  const assessmentErrors = [{ repair: { field: 'requirementQuote', targetId: 'shot', index: 1 } }];
  const historyPage = { offset: 0, nextOffset: 20, complete: false };
  const content = JSON.stringify({
    status: 'inspected',
    inspectionSummary,
    assessmentErrors,
    rejectedTargetIds: ['shot'],
    historyPage,
    history: '正文'.repeat(10000),
  });
  const receipt = JSON.parse(
    modelResultReceipt({
      id: 'result',
      callId: 'call',
      toolName: 'conversation.task.route',
      status: 'completed',
      content,
      contentHash: 'hash',
      arguments: {},
      version: 1,
    }),
  ) as Record<string, unknown>;
  expect(receipt).toMatchObject({
    inspectionSummary,
    assessmentErrors,
    rejectedTargetIds: ['shot'],
    historyPage,
  });
  expect(JSON.stringify(receipt)).not.toContain('正文');
});
