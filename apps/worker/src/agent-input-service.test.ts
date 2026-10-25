import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentInputDraft } from '@ai-video/contracts';
import { AgentInputService } from './agent-input-service.js';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { GenerationService } from './generation-service.js';
import { ProjectService } from './project-service.js';
import { validateSessionRequestParams } from './request-validation.js';

const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((close) => close()),
);
const draft: AgentInputDraft = {
  key: 'direction',
  title: '确认创作方向',
  questions: [
    {
      id: 'style',
      prompt: '画面风格',
      type: 'single',
      options: [
        { id: 'animation', label: '二维动画' },
        { id: 'film', label: '电影写实' },
      ],
    },
    {
      id: 'focus',
      prompt: '重点内容',
      type: 'multiple',
      required: false,
      options: [
        { id: 'action', label: '动作' },
        { id: 'emotion', label: '情绪' },
      ],
    },
    { id: 'notes', prompt: '剧情补充', type: 'text', required: false },
  ],
};
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'agent-input-'));
  const projects = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
  const project = projects.create(join(root, 'project'), 'Questions');
  cleanups.push(() => {
    projects.close();
    rmSync(root, { recursive: true, force: true });
  });
  const content = new ContentService(projects);
  const conversation = content.createConversation({ scopeType: 'project' });
  const user = content.saveMessage({
    conversationId: conversation.id,
    role: 'user',
    content: '设计短剧',
  });
  const assistant = content.saveMessage({
    conversationId: conversation.id,
    replyToMessageId: user.id,
    role: 'assistant',
    content: '请先确认方向。',
  });
  const workflow = new DocumentWorkflowService(projects);
  const { task } = workflow.createDocumentDraftFromMessage({ messageId: assistant.id });
  const identity = {
    projectId: project.id,
    projectSessionId: projects.currentSessionId()!,
    conversationId: conversation.id,
    taskId: task.id,
  };
  const service = new AgentInputService(projects);
  return { projects, content, workflow, conversation, service, identity };
}
const answers = [
  { questionId: 'style', optionIds: ['animation'], text: '冷灰雨夜' },
  { questionId: 'focus', optionIds: ['emotion', 'action'] },
  { questionId: 'notes', optionIds: [], text: '  顾清影先出场  ' },
];
describe('Agent question forms', () => {
  it('persists requests and answers in task events, restores them and deduplicates retries', () => {
    const { service, workflow, identity } = fixture();
    const form = service.prepare(draft, identity);
    expect(
      service.prepare({ questions: draft.questions, title: draft.title, key: draft.key }, identity),
    ).toEqual(form);
    expect(() => service.prepare({ ...draft, title: 'changed' }, identity)).toThrow(/different/);
    const submission = { taskId: identity.taskId, formId: form.id, answers };
    const saved = service.submit(submission);
    expect(saved.form.status).toBe('answered');
    expect(saved.form.answers?.[1]?.optionIds).toEqual(['action', 'emotion']);
    expect(saved.form.answers?.[2]?.text).toBe('顾清影先出场');
    expect(saved.prompt).toContain('二维动画；冷灰雨夜');
    expect(saved.idempotencyKey).toBe(`question-answer:${form.id}`);
    expect(service.submit(submission)).toEqual(saved);
    const restored = workflow.getTask({ taskId: identity.taskId });
    expect(restored.events.find((event) => event.userInput)?.userInput).toEqual(saved.form);
    expect(
      workflow
        .getTaskEvents({ taskId: identity.taskId, afterSequence: -1, limit: 100 })
        .events.find((event) => event.userInput)?.userInput,
    ).toEqual(saved.form);
    expect(
      restored.events.filter((event) => event.eventType === 'agent.user_input.answered'),
    ).toHaveLength(1);
    expect(() =>
      service.submit({
        ...submission,
        answers: answers.map((answer) => ({ ...answer, text: 'changed' })),
      }),
    ).toThrow(/already been answered/);
  });
  it('validates required fields, known choices, cardinality, duplicate answers and text bounds', () => {
    const { service, identity } = fixture();
    const form = service.prepare(draft, identity);
    for (const invalid of [
      [],
      [...answers, answers[0]],
      answers.map((answer) => ({ ...answer, questionId: 'style' })),
      [{ questionId: 'style', optionIds: [] }, ...answers.slice(1)],
      [{ questionId: 'style', optionIds: ['missing'] }, ...answers.slice(1)],
      [{ questionId: 'style', optionIds: ['animation', 'film'] }, ...answers.slice(1)],
      [{ questionId: 'style', optionIds: ['animation', 'animation'] }, ...answers.slice(1)],
      [{ questionId: 'style', optionIds: [], text: 'x'.repeat(4001) }, ...answers.slice(1)],
      [...answers.slice(0, 2), { questionId: 'notes', optionIds: ['animation'] }],
      [null, ...answers.slice(1)],
    ])
      expect(() =>
        service.submit({ taskId: identity.taskId, formId: form.id, answers: invalid as never }),
      ).toThrow();
    expect(service.get(identity.taskId, form.id).status).toBe('pending');
    expect(
      service.submit({
        taskId: identity.taskId,
        formId: form.id,
        answers: [{ questionId: 'style', optionIds: [], text: '水墨' }, ...answers.slice(1)],
      }).prompt,
    ).toContain('水墨');
  });
  it('rejects invalid declarations and enforces task/project/conversation scope', () => {
    const { service, content, identity } = fixture();
    for (const invalid of [
      { ...draft, extra: true },
      { ...draft, questions: [] },
      { ...draft, questions: [draft.questions[0], draft.questions[0]] },
      { ...draft, questions: [{ id: 'q', prompt: 'choose', type: 'single' }] },
      { ...draft, questions: [{ ...draft.questions[0], type: 'text' }] },
      {
        ...draft,
        questions: [
          {
            ...draft.questions[0],
            options: [
              { id: 'a', label: 'A' },
              { id: 'a', label: 'B' },
            ],
          },
        ],
      },
      { ...draft, title: ' ' },
    ])
      expect(() => service.prepare(invalid, identity)).toThrow();
    const other = content.createConversation({ scopeType: 'project' });
    expect(() => service.prepare(draft, { ...identity, conversationId: other.id })).toThrow(
      /conversation/,
    );
    expect(() => service.prepare(draft, { ...identity, projectId: 'other' })).toThrow(/project/);
    expect(() => service.prepare(draft, { ...identity, taskId: undefined })).toThrow(/task/);
    const form = service.prepare(draft, identity);
    expect(() => service.get('other-task', form.id)).toThrow();
    expect(() => service.get(identity.taskId, 'other-form')).toThrow();
  });
  it('links ordinary generation preparation by the stable answer key without calling a Provider', () => {
    const { service, projects, content, conversation, identity } = fixture();
    const form = service.prepare(draft, identity);
    const result = service.submit({ taskId: identity.taskId, formId: form.id, answers });
    const generations = new GenerationService(
      projects,
      content,
      new ContextService(projects),
      {
        status: () => ({ key: 'mock', name: 'Mock', model: 'mock', configured: false }),
        stream: () => Promise.reject(new Error('No Provider calls allowed')),
      },
      {
        selectionResolver: {
          resolveLlmSelection: () => ({
            providerProfileId: 'profile',
            providerName: 'Mock',
            modelId: 'model',
            modelName: 'Mock',
            remoteModelId: 'mock',
            protocol: 'openai-chat-completions',
            baseUrl: 'https://mock.invalid',
          }),
        },
      },
    );
    const params = {
      conversationId: conversation.id,
      prompt: result.prompt,
      idempotencyKey: result.idempotencyKey,
      providerProfileId: 'profile',
      modelId: 'model',
    };
    const prepared = generations.prepare(params);
    expect(generations.prepare(params).generation.generationId).toBe(
      prepared.generation.generationId,
    );
    expect(service.get(identity.taskId, form.id).continuationGenerationId).toBe(
      prepared.generation.generationId,
    );
  });
  it('accepts the initial -1 event cursor at the RPC boundary and rejects earlier cursors', () => {
    expect(() =>
      validateSessionRequestParams('agent.task.events', {
        taskId: 'task',
        afterSequence: -1,
        limit: 100,
      }),
    ).not.toThrow();
    expect(() =>
      validateSessionRequestParams('agent.task.events', { taskId: 'task', afterSequence: -2 }),
    ).toThrow();
    expect(() =>
      validateSessionRequestParams('agent.input.submit', {
        taskId: 'task',
        formId: 'form',
        answers: [],
        prompt: 'forged',
      }),
    ).toThrow();
  });
});
