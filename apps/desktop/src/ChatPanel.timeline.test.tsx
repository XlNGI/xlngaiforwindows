import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { AgentTaskDetail, ChatMessageInfo, MediaReviewSummary } from '@ai-video/contracts';
import { ChatPanel } from './ChatPanel';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const at = (second: number) => `2026-10-24T00:00:0${second}.000Z`;
const parts = [
  '我先检查项目结构和已有设定。',
  '没有相关设定，接下来准备创作资料。',
  '所需材料已准备完成。',
];
const user: ChatMessageInfo = {
  id: 'user',
  conversationId: 'conversation',
  role: 'user',
  content: '帮我设计一部玄幻小说',
  status: 'complete',
  createdAt: at(0),
};
const assistant: ChatMessageInfo = {
  ...user,
  id: 'assistant',
  role: 'assistant',
  content: parts.join('\n\n'),
  createdAt: at(1),
};
const detail: AgentTaskDetail = {
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
    createdAt: at(0),
    updatedAt: at(8),
  },
  events: [
    {
      eventType: 'agent.assistant.started',
      summary: '阶段回复',
      messageBoundary: { messageId: assistant.id, startOffset: 0 },
    },
    {
      eventType: 'agent.tool.started',
      summary: '正在调用工具：project.structure.get、library.search',
    },
    { eventType: 'agent.library.completed', summary: '没有检索到已有设定。' },
    {
      eventType: 'agent.assistant.started',
      summary: '阶段回复',
      messageBoundary: { messageId: assistant.id, startOffset: parts[0]!.length + 2 },
    },
    { eventType: 'agent.tool.started', summary: '正在调用工具：media.review.prepare' },
    { eventType: 'agent.tool.succeeded', summary: '已保存角色图片审核表单。' },
    {
      eventType: 'agent.assistant.started',
      summary: '阶段回复',
      messageBoundary: {
        messageId: assistant.id,
        startOffset: parts[0]!.length + parts[1]!.length + 4,
      },
    },
  ].map((event, sequence) => ({
    ...event,
    id: `event-${sequence}`,
    taskId: 'task',
    sequence,
    level: 'info',
    createdAt: at(sequence + 1),
  })),
  documents: [],
  providerSteps: [],
  researchSources: [],
};
function props(): ComponentProps<typeof ChatPanel> {
  const conversation = {
    id: 'conversation',
    projectId: 'project',
    scopeType: 'project' as const,
    title: '设计小说',
    createdAt: at(0),
    updatedAt: at(8),
  };
  return {
    scopeType: 'project',
    scopeAvailable: true,
    writable: true,
    conversations: [conversation],
    conversation,
    messages: [user, assistant],
    agentTasks: [detail],
    composer: '',
    statusMessage: '',
    legacyLlmConfigured: false,
    llmProfiles: [],
    llmModels: [],
    selectedLlmProfileId: '',
    selectedLlmModelId: '',
    onSelectConversation: vi.fn(),
    onCreateConversation: vi.fn(),
    onRetryGeneration: vi.fn(),
    onLlmProfileChange: vi.fn(),
    onLlmModelChange: vi.fn(),
    onOpenProviderSettings: vi.fn(),
    onComposerChange: vi.fn(),
    onCancelGeneration: vi.fn(),
    onSendMessage: vi.fn(),
  };
}
const order = (container: HTMLElement) =>
  [...container.querySelector('.message-list')!.children]
    .filter((item) => !item.classList.contains('conversation-process-heading'))
    .map((item) => {
      const content = item.classList.contains('conversation-process-item')
        ? item.firstElementChild!
        : item;
      if (content.classList.contains('agent-tool-timeline')) return 'tools';
      const reply = content.cloneNode(true) as HTMLElement;
      reply.querySelector('.chat-task-result')?.remove();
      return reply.textContent;
    });

const expandProcess = () => fireEvent.click(screen.getByRole('button', { name: /^用时 / }));

it('shows automatic recovery before expanding details and keeps the task running', () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const task = {
    ...detail,
    task: { ...detail.task, status: 'running' as const },
    events: detail.events.slice(0, 3),
  };
  render(
    <ChatPanel
      {...props()}
      messages={[user, { ...assistant, content: parts[0]! }]}
      agentTasks={[task]}
      generation={{
        generationId: 'generation',
        conversationId: 'conversation',
        snapshotId: 'snapshot',
        status: 'streaming',
        userMessage: user,
        assistantMessage: assistant,
        sources: [],
      }}
      liveAgentActions={[
        { id: 'failed-request', toolName: 'model.request', phase: 'failed', status: 'failed' },
        { id: 'retry', toolName: 'model.request', phase: 'retry_wait', status: 'running' },
      ]}
    />,
  );
  expect(screen.getByRole('button', { name: '模型服务暂时异常，正在准备重试' })).toBeVisible();
  expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled();
  expect(screen.queryByText(/本次任务未完成/)).not.toBeInTheDocument();
});

it('translates an older standalone HTTP failure and retains its retry control', () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const base = props();
  const rawError = 'Provider HTTP 500 (bad_response_status_code): Service Error';
  render(
    <ChatPanel
      {...base}
      agentTasks={[]}
      messages={[user, { ...assistant, status: 'failed', content: rawError }]}
      llmStatus={{
        configured: true,
        provider: 'test',
        model: 'test',
        configurationSource: 'managed',
      }}
    />,
  );
  expect(screen.getByText(/模型服务暂时异常（HTTP 500）/)).toBeVisible();
  expect(screen.getByText(rawError).closest('details')).not.toHaveAttribute('open');
  fireEvent.click(screen.getByRole('button', { name: '重试' }));
  expect(base.onRetryGeneration).toHaveBeenCalledWith(assistant.id);
});

it.each([false, true])(
  'explains an explicit provider balance failure for standalone and Agent messages, agent=%s',
  (agent) => {
    vi.mocked(callWorker).mockResolvedValue([] as never);
    const error = 'Provider HTTP 401 (bad_response_status_code): insufficient balance';
    const failedAssistant = { ...assistant, status: 'failed' as const, content: error };
    const failedTask = {
      ...detail,
      task: { ...detail.task, status: 'failed' as const, errorMessage: error },
      events: [],
    };
    render(
      <ChatPanel
        {...props()}
        messages={[user, failedAssistant]}
        agentTasks={agent ? [failedTask] : []}
      />,
    );
    expect(screen.getAllByText(/模型服务余额或额度不足/)).toHaveLength(1);
    expect(screen.queryByText(/请检查供应商密钥和模型权限/)).not.toBeInTheDocument();
    expect(screen.getByText(error).closest('details')).not.toHaveAttribute('open');
  },
);

it.each([
  ['Provider HTTP 403: INSUFFICIENT CREDITS', '模型服务余额或额度不足'],
  ['Provider HTTP 403: 账户余额不足', '模型服务余额或额度不足'],
  ['Provider HTTP 429 (insufficient_quota): quota exceeded', '模型服务余额或额度不足'],
  ['Provider HTTP 401: Invalid API key provided', '请检查供应商密钥和模型权限'],
  ['Provider HTTP 403: Model access denied', '请检查供应商密钥和模型权限'],
  ['Provider HTTP 429: Rate limit exceeded', '模型服务请求过多或额度不足'],
  ['Provider HTTP 500: Service Error', '模型服务暂时异常（HTTP 500）'],
])('keeps provider failure guidance specific: %s', (error, expected) => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  render(
    <ChatPanel
      {...props()}
      messages={[user, { ...assistant, status: 'failed', content: error }]}
      agentTasks={[]}
    />,
  );
  expect(screen.getByText(expected, { exact: false })).toBeVisible();
  expect(screen.getByText(error).closest('details')).not.toHaveAttribute('open');
});

it.each([false, true])(
  'shows a single Chinese failure with collapsed diagnostics, boundaries=%s',
  (boundaries) => {
    vi.mocked(callWorker).mockResolvedValue([] as never);
    const error = 'Provider HTTP 500 (bad_response_status_code): Service Error';
    const failedAssistant = { ...assistant, status: 'failed' as const, content: error };
    const failedTask = {
      ...detail,
      task: { ...detail.task, status: 'failed' as const, errorMessage: error },
      events: boundaries
        ? detail.events.slice(0, 3)
        : detail.events.filter((event) => !event.messageBoundary),
    };
    const mounted = render(
      <ChatPanel {...props()} messages={[user, failedAssistant]} agentTasks={[failedTask]} />,
    );
    expect(screen.getAllByText(/模型服务暂时异常（HTTP 500）/)).toHaveLength(1);
    expect(screen.getAllByText(error)).toHaveLength(1);
    const diagnostics = screen.getByText(error).closest('details');
    expect(diagnostics).not.toHaveAttribute('open');
    expect(diagnostics?.querySelector('summary')).toHaveTextContent('技术详情');
    expect(mounted.container.querySelectorAll('article.assistant')).toHaveLength(0);
    expect(screen.getByText('查看项目结构')).toBeVisible();
  },
);

it('preserves actual progress and separate failures from earlier turns', () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const error = 'Provider HTTP 500 (bad_response_status_code): Service Error';
  const failed = { ...assistant, status: 'failed' as const, content: parts[0]! };
  const task = {
    ...detail,
    task: { ...detail.task, status: 'failed' as const, errorMessage: error },
    events: detail.events.slice(0, 3),
  };
  const secondUser = { ...user, id: 'user-2', createdAt: '2026-10-24T00:01:00.000Z' };
  const secondAssistant = {
    ...failed,
    id: 'assistant-2',
    content: error,
    createdAt: '2026-10-24T00:01:01.000Z',
  };
  const secondTask = {
    ...task,
    task: { ...task.task, id: 'task-2', userMessageId: secondUser.id },
    events: [],
  };
  render(
    <ChatPanel
      {...props()}
      messages={[user, failed, secondUser, secondAssistant]}
      agentTasks={[task, secondTask]}
    />,
  );
  expect(screen.getByText(parts[0]!)).toBeVisible();
  expect(screen.getAllByText(/模型服务暂时异常（HTTP 500）/)).toHaveLength(2);
  expect(screen.getAllByText(error)).toHaveLength(2);
});

it('renders stage text around tool groups, keeps groups expandable, and preserves order after completion and remount', async () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const base = props();
  const mounted = render(
    <ChatPanel
      {...base}
      liveAgentActions={[
        { id: 'finished-search', toolName: 'library.search', status: 'succeeded' },
      ]}
      generation={{
        generationId: 'generation',
        conversationId: 'conversation',
        snapshotId: 'snapshot',
        status: 'streaming',
        userMessage: user,
        assistantMessage: assistant,
        sources: [],
      }}
    />,
  );
  expect(screen.getAllByRole('button', { name: '已调用 2 个工具' })).toHaveLength(1);
  expect(screen.queryByText('project.structure.get')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '已调用 2 个工具' }));
  expect(screen.getByText('查看项目结构')).toBeVisible();
  expect(screen.getByText('检索项目资料')).toBeVisible();
  expect(screen.getByText('project.structure.get')).toBeInTheDocument();
  expect(screen.getByText('project.structure.get')).not.toBeVisible();
  expect(screen.getByText('library.search')).toBeInTheDocument();
  expect(screen.getByText('没有检索到已有设定。')).toBeInTheDocument();
  const before = order(mounted.container).filter((item) => item !== 'tools');
  mounted.rerender(<ChatPanel {...base} />);
  expect(screen.getByText(parts[0]!)).not.toBeVisible();
  expect(screen.getByText(parts[1]!)).not.toBeVisible();
  expect(screen.getByText(parts[2]!)).toBeVisible();
  expect(screen.getByRole('button', { name: '用时 8秒' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expandProcess();
  expect(screen.getByText(parts[0]!)).toBeVisible();
  expect(screen.getByText(parts[1]!)).toBeVisible();
  expect(order(mounted.container).filter((item) => item !== 'tools')).toEqual(before);
  mounted.unmount();
  const restored = render(<ChatPanel {...base} />);
  expect(screen.getByText(parts[0]!)).not.toBeVisible();
  expect(screen.getByRole('button', { name: '用时 8秒' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expandProcess();
  const content = order(restored.container);
  expect(content).toHaveLength(6);
  expect(content[0]).toContain(user.content);
  expect(content[1]).toContain(parts[0]);
  expect(content[2]).toBe('tools');
  expect(content[3]).toContain(parts[1]);
  expect(content[4]).toBe('tools');
  expect(content[5]).toContain(parts[2]);
  await waitFor(() =>
    expect(callWorker).toHaveBeenCalledWith('media.review.list', {
      conversationId: 'conversation',
    }),
  );
});

it('expands each completed turn independently and keeps both final replies visible', () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const later = (value: string) => value.replace('T00:00:', 'T00:01:');
  const secondUser = { ...user, id: 'user-2', createdAt: later(user.createdAt) };
  const secondParts = ['我会继续补充角色。', '已补充主角设定。'];
  const secondAssistant = {
    ...assistant,
    id: 'assistant-2',
    content: secondParts.join('\n\n'),
    createdAt: later(assistant.createdAt),
  };
  const secondTask = {
    ...detail,
    task: {
      ...detail.task,
      id: 'task-2',
      userMessageId: secondUser.id,
      createdAt: later(detail.task.createdAt),
      updatedAt: later(detail.task.updatedAt),
    },
    events: detail.events.slice(0, 4).map((event) => ({
      ...event,
      id: `${event.id}-2`,
      taskId: 'task-2',
      createdAt: later(event.createdAt),
      messageBoundary: event.messageBoundary
        ? {
            messageId: secondAssistant.id,
            startOffset: event.messageBoundary.startOffset ? secondParts[0]!.length + 2 : 0,
          }
        : undefined,
    })),
  };
  render(
    <ChatPanel
      {...props()}
      messages={[user, assistant, secondUser, secondAssistant]}
      agentTasks={[detail, secondTask]}
    />,
  );
  const toggles = screen.getAllByRole('button', { name: '用时 8秒' });
  expect(toggles).toHaveLength(2);
  expect(screen.getByText(parts[0]!)).not.toBeVisible();
  expect(screen.getByText(secondParts[0]!)).not.toBeVisible();
  fireEvent.click(toggles[0]!);
  expect(screen.getByText(parts[0]!)).toBeVisible();
  expect(screen.getByText(secondParts[0]!)).not.toBeVisible();
  fireEvent.click(toggles[1]!);
  fireEvent.click(toggles[0]!);
  expect(screen.getByText(parts[0]!)).not.toBeVisible();
  expect(screen.getByText(secondParts[0]!)).toBeVisible();
  expect(screen.getByText(parts[2]!)).toBeVisible();
  expect(screen.getByText(secondParts[1]!)).toBeVisible();
});

it('retains descriptive completion receipts while translating tool identifiers', () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const summary = '已完成：读取现有设定，确认尚无角色资料。';
  const task = {
    ...detail,
    events: detail.events.map((event) =>
      event.eventType === 'agent.library.completed'
        ? { ...event, eventType: 'agent.tool.succeeded', summary }
        : event,
    ),
  };
  render(<ChatPanel {...props()} agentTasks={[task]} />);
  expandProcess();
  fireEvent.click(screen.getByRole('button', { name: '已调用 2 个工具' }));
  expect(screen.getByText(summary)).toBeInTheDocument();
});

it('inserts saved review forms between their preparation stage and the next reply', async () => {
  const form: MediaReviewSummary = {
    id: 'form',
    projectId: 'project',
    conversationId: 'conversation',
    taskId: 'task',
    draft: { key: 'character', label: '顾清影角色图', kind: 'image' },
    status: 'pending',
    rowVersion: 1,
    blockers: [],
    inputAssetIds: [],
    createdAt: at(6),
  };
  vi.mocked(callWorker).mockResolvedValue([form] as never);
  const mounted = render(<ChatPanel {...props()} />);
  const card = await screen.findByRole('region', { name: '媒体审核表单：顾清影角色图' });
  expect(card.closest('.message-list')).not.toBeNull();
  const items = [...mounted.container.querySelector('.message-list')!.children];
  const index = items.indexOf(card);
  expect(index).toBeGreaterThan(items.findIndex((item) => item.textContent?.includes(parts[1]!)));
  expect(index).toBeLessThan(items.findIndex((item) => item.textContent?.includes(parts[2]!)));
});

it('uses recorded message boundaries when the parent user message is outside the loaded page', () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const mounted = render(<ChatPanel {...props()} messages={[assistant]} />);
  expect(order(mounted.container)).toEqual([parts[0], 'tools', parts[1], 'tools', parts[2]]);
  expect(screen.queryByText('助手', { exact: true })).not.toBeInTheDocument();
});

it('does not replace saved stages with an older active task snapshot', () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const stale = { ...detail, events: detail.events.filter((event) => !event.messageBoundary) };
  const mounted = render(<ChatPanel {...props()} agentTask={stale} />);
  expect(order(mounted.container)).toEqual([
    expect.stringContaining(user.content),
    parts[0],
    'tools',
    parts[1],
    'tools',
    parts[2],
  ]);
});

it('keeps the running stage compact instead of opening a separate full tool list', () => {
  vi.mocked(callWorker).mockResolvedValue([] as never);
  const base = props();
  const streaming = { ...assistant, content: parts[0]!, status: 'streaming' as const };
  const task = {
    ...detail,
    task: { ...detail.task, status: 'running' as const },
    events: detail.events.slice(0, 2),
  };
  const mounted = render(
    <ChatPanel
      {...base}
      messages={[user, streaming]}
      agentTasks={[task]}
      agentTask={task}
      generation={{
        generationId: 'generation',
        conversationId: 'conversation',
        snapshotId: 'snapshot',
        status: 'streaming',
        userMessage: user,
        assistantMessage: streaming,
        sources: [],
      }}
    />,
  );
  const toggle = screen.getByRole('button', { name: '正在调用工具' });
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(order(mounted.container)).toEqual([
    expect.stringContaining(user.content),
    parts[0],
    'tools',
  ]);
  expect(screen.queryByText('project.structure.get')).not.toBeInTheDocument();
  fireEvent.click(toggle);
  expect(screen.getByText('project.structure.get')).toBeInTheDocument();
  expect(screen.getByText('library.search')).toBeInTheDocument();
});

it('keeps the first explanation above a legacy question form on render and reload', async () => {
  const introduction = '当前小说工作区是空的。先确认几个创作方向：';
  const form = {
    id: 'starting-point',
    taskId: 'task',
    conversationId: 'conversation',
    key: 'starting-point',
    title: '新小说创作起点',
    status: 'pending' as const,
    createdAt: at(4),
    questions: [{ id: 'direction', prompt: '先从哪里开始？', type: 'text' as const }],
  };
  const task: AgentTaskDetail = {
    ...detail,
    events: [
      {
        id: 'ask',
        sequence: 0,
        eventType: 'agent.tool.started',
        summary: '正在调用工具：conversation.ask',
        createdAt: at(3),
      },
      {
        id: 'question',
        sequence: 1,
        eventType: 'agent.user_input.requested',
        summary: form.title,
        userInput: form,
        createdAt: at(4),
      },
      {
        id: 'receipt',
        sequence: 2,
        eventType: 'agent.tool.succeeded',
        summary: '已完成：conversation.ask',
        createdAt: at(3),
      },
      {
        id: 'introduction',
        sequence: 3,
        eventType: 'agent.assistant.started',
        summary: '阶段回复',
        messageBoundary: { messageId: assistant.id, startOffset: 0 },
        createdAt: at(5),
      },
    ].map((event) => ({ ...event, taskId: 'task', level: 'info' })),
  };
  vi.mocked(callWorker).mockImplementation((method) =>
    Promise.resolve(method === 'agent.input.get' ? form : []),
  );
  const base = {
    ...props(),
    agentTasks: [task],
    messages: [user, { ...assistant, content: introduction }],
  };
  const mounted = render(<ChatPanel {...base} />);
  const check = async (container: HTMLElement) => {
    await screen.findByRole('form', { name: form.title });
    const items = [...container.querySelector('.message-list')!.children];
    expect(items.findIndex((item) => item.textContent?.includes(introduction))).toBeLessThan(
      items.findIndex((item) => item.classList.contains('agent-question-form')),
    );
  };
  await check(mounted.container);
  fireEvent.click(screen.getByRole('button', { name: '已调用 1 个工具' }));
  expect(screen.getByText('准备问答表单')).toBeVisible();
  expect(screen.getByText('conversation.ask')).not.toBeVisible();
  expect(screen.getByText('已完成：准备问答表单')).toBeInTheDocument();
  expect(screen.queryByText('已完成：conversation.ask')).not.toBeInTheDocument();
  mounted.unmount();
  const restored = render(<ChatPanel {...base} />);
  await check(restored.container);
});
