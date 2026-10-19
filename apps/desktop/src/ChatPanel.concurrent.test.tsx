import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import type { LlmGenerationInfo } from '@ai-video/contracts';
import { ChatPanel } from './ChatPanel';
afterEach(cleanup);

it('leaves task relationship routing to the Agent while preserving run selection and cancellation', () => {
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
  const b = {
    ...a,
    generationId: 'B',
    userMessage: { ...a.userMessage, id: 'input-B', content: 'Task B' },
  };
  const send = vi.fn(),
    cancel = vi.fn(),
    select = vi.fn();
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
    runningGenerations: [a, b],
    onSendMessage: send,
    onCancelGeneration: cancel,
    onSelectGeneration: select,
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
  expect(screen.getByText('执行方式由 Agent 根据当前消息和活动任务自动判断')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Task B ·/ }));
  expect(select).toHaveBeenCalledWith('B');
  fireEvent.click(screen.getByTitle('停止生成'));
  expect(cancel).toHaveBeenCalledOnce();
});
