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
  [...container.querySelector('.message-list')!.children].map((item) =>
    item.classList.contains('agent-tool-timeline') ? 'tools' : item.textContent,
  );

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
  expect(screen.getByText('project.structure.get')).toBeInTheDocument();
  expect(screen.getByText('library.search')).toBeInTheDocument();
  expect(screen.getByText('没有检索到已有设定。')).toBeInTheDocument();
  const before = order(mounted.container).filter((item) => item !== 'tools');
  mounted.rerender(<ChatPanel {...base} />);
  expect(order(mounted.container).filter((item) => item !== 'tools')).toEqual(before);
  mounted.unmount();
  const restored = render(<ChatPanel {...base} />);
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
