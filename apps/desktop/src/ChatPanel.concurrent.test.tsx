import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { LlmGenerationInfo } from '@ai-video/contracts';
import { ChatPanel } from './ChatPanel';
afterEach(cleanup);

it('allows sending and cancellation during concurrent generation without composer task controls', () => {
  const a: LlmGenerationInfo = {
    generationId: 'A',
    conversationId: 'chat',
    snapshotId: 'snapshot',
    status: 'streaming',
    executionMode: 'native',
    userMessage: {
      id: 'input-A',
      conversationId: 'chat',
      role: 'user',
      content: 'Task A',
      status: 'complete',
      createdAt: 'now',
    },
    assistantMessage: {
      id: 'output-A',
      conversationId: 'chat',
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: 'now',
    },
    sources: [],
  };
  const send = vi.fn(),
    cancel = vi.fn();
  const conversation = {
    id: 'chat',
    projectId: 'project',
    scopeType: 'project' as const,
    title: 'Chat',
    createdAt: 'now',
    updatedAt: 'now',
  };
  const props: ComponentProps<typeof ChatPanel> = {
    scopeType: 'project',
    scopeAvailable: true,
    writable: true,
    conversation,
    conversations: [conversation],
    messages: [],
    composer: 'next input',
    statusMessage: '',
    legacyLlmConfigured: false,
    llmProfiles: [],
    llmModels: [],
    selectedLlmProfileId: '',
    selectedLlmModelId: '',
    generation: a,
    allowConcurrentTasks: true,
    onSendMessage: send,
    onCancelGeneration: cancel,
    onComposerChange: vi.fn(),
    onCreateConversation: vi.fn(),
    onSelectConversation: vi.fn(),
    onRetryGeneration: vi.fn(),
    onLlmProfileChange: vi.fn(),
    onLlmModelChange: vi.fn(),
    onOpenProviderSettings: vi.fn(),
  };
  render(<ChatPanel {...props} />);
  fireEvent.click(screen.getByTitle('发送消息'));
  expect(send).toHaveBeenLastCalledWith();
  expect(
    screen.queryByText('执行方式由 Agent 根据当前消息和活动任务自动判断'),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('当前会话运行任务')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTitle('停止生成'));
  expect(cancel).toHaveBeenCalledOnce();
});
