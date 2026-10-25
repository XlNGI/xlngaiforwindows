import { describe, expect, it } from 'vitest';
import type {
  AgentTaskDetail,
  AgentTaskEventInfo,
  ChatMessageInfo,
  MediaReviewSummary,
} from '@ai-video/contracts';
import { conversationTimeline, newerAgentTaskDetail } from './conversation-timeline';

const time = (second: number) => `2026-10-24T00:00:${String(second).padStart(2, '0')}.000Z`;
const first = '先了解项目现状。';
const second = '没有已有设定，接下来整理主线。';
const final = '已完成故事设计。';
const user: ChatMessageInfo = {
  id: 'user',
  conversationId: 'conversation',
  role: 'user',
  content: '设计小说',
  status: 'complete',
  createdAt: time(0),
};
const assistant: ChatMessageInfo = {
  ...user,
  id: 'assistant',
  role: 'assistant',
  content: first + '\n\n' + second + '\n\n' + final,
  createdAt: time(1),
};
const event = (
  id: string,
  sequence: number,
  second: number,
  eventType: string,
  summary: string,
  offset?: number,
): AgentTaskEventInfo => ({
  id,
  taskId: 'task',
  sequence,
  eventType,
  summary,
  level: 'info',
  createdAt: time(second),
  ...(offset !== undefined
    ? { messageBoundary: { messageId: assistant.id, startOffset: offset } }
    : {}),
});
const stagedTask: AgentTaskDetail = {
  task: {
    id: 'task',
    projectId: 'project',
    conversationId: 'conversation',
    userMessageId: user.id,
    taskType: 'document-query',
    scopeType: 'project',
    title: '设计小说',
    status: 'completed',
    phase: 'model_running',
    rowVersion: 1,
    createdAt: time(0),
    updatedAt: time(9),
  },
  events: [
    event('first', 0, 1, 'agent.assistant.started', '助手阶段回复', 0),
    event(
      'tools-a',
      1,
      2,
      'agent.tool.started',
      '正在调用工具：project.structure.get、library.search',
    ),
    event('result-a', 2, 3, 'agent.library.completed', '检索完成，没有相关设定'),
    event('second', 3, 4, 'agent.assistant.started', '助手阶段回复', first.length + 2),
    event('tools-b', 4, 5, 'agent.tool.started', '正在调用工具：document.submit_draft'),
    event('result-b', 5, 6, 'agent.tool.succeeded', '已保存故事大纲'),
    event(
      'final',
      6,
      8,
      'agent.assistant.started',
      '助手阶段回复',
      first.length + second.length + 4,
    ),
  ],
  documents: [],
  providerSteps: [],
  researchSources: [],
};

describe('conversation timeline', () => {
  it('retains known stages when an older task snapshot arrives late', () => {
    const stale = { ...stagedTask, events: stagedTask.events.slice(0, 1) };
    expect(newerAgentTaskDetail(stagedTask, stale)).toBe(stagedTask);
    expect(newerAgentTaskDetail(stale, stagedTask)).toBe(stagedTask);
    expect(newerAgentTaskDetail(undefined, stagedTask)).toBe(stagedTask);
    const completed = { ...stagedTask, task: { ...stagedTask.task, rowVersion: 2 } };
    expect(newerAgentTaskDetail(stagedTask, completed)).toBe(completed);
  });

  it('interleaves stage text and tool batches and preserves order on completion and reload', () => {
    const taskMap = new Map([[assistant.id, stagedTask]]);
    const live = conversationTimeline([user, assistant], taskMap, assistant.id);
    const saved = conversationTimeline([user, assistant], taskMap);
    expect(
      live
        .filter((item) => item.kind !== 'tools' || item.detail.events.length)
        .map((item) => item.id),
    ).toEqual(saved.map((item) => item.id));
    expect(saved.map((item) => (item.kind === 'message' ? item.content : item.id))).toEqual([
      user.content,
      first,
      'tools:task:tools-a',
      second,
      'tools:task:tools-b',
      final,
    ]);
    expect(
      saved
        .filter((item) => item.kind === 'tools')
        .map(
          (item) => item.detail.events.filter((e) => e.eventType === 'agent.tool.started').length,
        ),
    ).toEqual([1, 1]);
    expect(
      conversationTimeline(
        [user, assistant],
        new Map([[assistant.id, structuredClone(stagedTask)]]),
      ),
    ).toEqual(saved);
  });

  it('places later user messages and review forms at creation time and keeps updated forms in place', () => {
    const laterUser = { ...user, id: 'later', content: '保留冷灰雨夜氛围', createdAt: time(7) };
    const form: MediaReviewSummary = {
      id: 'form',
      projectId: 'project',
      conversationId: 'conversation',
      taskId: 'task',
      draft: { key: 'cover', label: '场景图', kind: 'image' },
      status: 'pending',
      rowVersion: 0,
      blockers: [],
      inputAssetIds: [],
      createdAt: time(6),
    };
    const build = (value: MediaReviewSummary) =>
      conversationTimeline(
        [user, assistant, laterUser],
        new Map([[assistant.id, stagedTask]]),
        undefined,
        [value],
      );
    const items = build(form);
    expect(items.map((item) => item.id)).toEqual([
      'user',
      'first',
      'tools:task:tools-a',
      'second',
      'tools:task:tools-b',
      'form:form',
      'later',
      'final',
    ]);
    expect(build({ ...form, status: 'submitted', jobId: 'job' }).map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
  });

  it('uses event sequence when timestamps tie and only attaches live activity to the last stage', () => {
    const detail = {
      ...stagedTask,
      events: stagedTask.events
        .slice()
        .reverse()
        .map((e) => ({ ...e, createdAt: time(1) })),
    };
    const items = conversationTimeline(
      [user, assistant],
      new Map([[assistant.id, detail]]),
      assistant.id,
    );
    expect(items.filter((item) => item.kind === 'message').map((item) => item.content)).toEqual([
      user.content,
      first,
      second,
      final,
    ]);
    expect(items.filter((item) => item.kind === 'tools' && item.live)).toHaveLength(1);
    expect(
      items
        .filter((item) => item.kind === 'tools' && !item.live)
        .every((item) => item.kind === 'tools' && item.detail.task.status === 'completed'),
    ).toBe(true);
  });

  it('keeps old history intact when it has no captured stage boundaries', () => {
    const detail = { ...stagedTask, events: stagedTask.events.filter((e) => !e.messageBoundary) };
    const items = conversationTimeline([user, assistant], new Map([[assistant.id, detail]]));
    expect(items.filter((item) => item.kind === 'message').map((item) => item.content)).toEqual([
      user.content,
      assistant.content,
    ]);
  });

  it('renders durable questions between the complete tool batch and the next stage, without moving answered forms', () => {
    const question = {
      ...event('question', 4.5, 5, 'agent.user_input.requested', '确认风格'),
      userInput: {
        id: 'form',
        taskId: 'task',
        conversationId: 'conversation',
        createdAt: time(5),
        key: 'style',
        title: '确认风格',
        status: 'pending' as const,
        questions: [{ id: 'style', prompt: '画面风格', type: 'text' as const }],
      },
    };
    const detail = { ...stagedTask, events: [...stagedTask.events, question] };
    const build = () => conversationTimeline([user, assistant], new Map([[assistant.id, detail]]));
    const items = build();
    const index = items.findIndex((item) => item.kind === 'question');
    expect(items[index - 1]?.kind).toBe('tools');
    expect(items[index + 1]?.kind).toBe('message');
    const tools = items[index - 1];
    expect(
      tools?.kind === 'tools' && tools.detail.events.some((event) => event.id === 'result-b'),
    ).toBe(true);
    detail.events = detail.events.map((event) =>
      event.id === question.id
        ? {
            ...question,
            userInput: {
              ...question.userInput,
              status: 'answered',
              answers: [{ questionId: 'style', optionIds: [], text: '二维动画' }],
            },
          }
        : event,
    );
    expect(build().map((item) => item.id)).toEqual(items.map((item) => item.id));
    const legacy = { ...detail, events: detail.events.filter((event) => !event.messageBoundary) };
    expect(
      conversationTimeline([user, assistant], new Map([[assistant.id, legacy]])).filter(
        (item) => item.kind === 'question',
      ),
    ).toHaveLength(1);
  });

  it('preserves text saved before stage recording became available', () => {
    const detail = { ...stagedTask, events: stagedTask.events.slice(1) };
    const items = conversationTimeline([user, assistant], new Map([[assistant.id, detail]]));
    expect(items.filter((item) => item.kind === 'message').map((item) => item.content)).toEqual([
      user.content,
      first,
      second,
      final,
    ]);
  });
});
