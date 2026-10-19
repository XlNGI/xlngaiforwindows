import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { AgentTaskDetail, ChatMessageInfo, ConversationInfo } from '@ai-video/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';

afterEach(cleanup);

const conversation: ConversationInfo = {
  id: 'conversation',
  projectId: 'project',
  scopeType: 'project',
  title: '清风',
  createdAt: 'now',
  updatedAt: 'now',
};
const message = (
  id: string,
  role: 'user' | 'assistant',
  replyToMessageId?: string,
): ChatMessageInfo => ({
  id,
  conversationId: conversation.id,
  role,
  content: id,
  status: 'complete',
  createdAt: 'now',
  replyToMessageId,
});
function task(id: string, userMessageId: string, toolName = 'library.search'): AgentTaskDetail {
  return {
    task: {
      id,
      projectId: 'project',
      conversationId: conversation.id,
      userMessageId,
      taskType: 'document-query',
      scopeType: 'project',
      title: id,
      status: 'running',
      phase: 'tool_validating',
      rowVersion: 1,
      createdAt: 'now',
      updatedAt: 'now',
    },
    events: [
      {
        id: `${id}-start`,
        taskId: id,
        sequence: 0,
        eventType: 'agent.tool.started',
        level: 'info',
        summary: `正在调用工具：${toolName}`,
        createdAt: 'now',
      },
    ],
    documents: [],
    providerSteps: [],
    researchSources: [],
  };
}
function props(
  overrides: Partial<ComponentProps<typeof ChatPanel>> = {},
): ComponentProps<typeof ChatPanel> {
  return {
    scopeType: 'project',
    scopeAvailable: true,
    writable: true,
    conversations: [conversation],
    conversation,
    messages: [],
    composer: '？',
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
    ...overrides,
  };
}

describe('ChatPanel conversation progress', () => {
  it('blocks a second send when a running task was restored without a generation snapshot', () => {
    const state = props({ agentTask: task('first', 'user1') });
    render(<ChatPanel {...state} />);
    const send = screen.getByTitle('上一轮仍在执行');
    expect(send).toBeDisabled();
    fireEvent.click(send);
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(state.onSendMessage).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('？');
  });

  it('uses replyToMessageId to attach interleaved historical task timelines', () => {
    const first = task('first', 'user1', 'library.search');
    const second = task('second', 'user2', 'project.structure.get');
    first.task.status = 'completed';
    second.task.status = 'completed';
    render(
      <ChatPanel
        {...props({
          messages: [
            message('user1', 'user'),
            message('user2', 'user'),
            message('reply1', 'assistant', 'user1'),
            message('reply2', 'assistant', 'user2'),
          ],
          agentTasks: [first, second],
        })}
      />,
    );
    const firstTimeline = screen.getByText('reply1').closest('article')?.previousElementSibling;
    const secondTimeline = screen.getByText('reply2').closest('article')?.previousElementSibling;
    expect(firstTimeline).toHaveTextContent('library.search');
    expect(firstTimeline).not.toHaveTextContent('project.structure.get');
    expect(secondTimeline).toHaveTextContent('project.structure.get');
  });

  it('settles the timeline and allows the next message when the generation has completed', () => {
    const user = message('user1', 'user');
    const assistant = message('reply1', 'assistant', user.id);
    render(
      <ChatPanel
        {...props({
          messages: [user, assistant],
          agentTask: task('first', user.id),
          generation: {
            generationId: 'generation',
            conversationId: conversation.id,
            snapshotId: 'snapshot',
            status: 'complete',
            userMessage: user,
            assistantMessage: assistant,
            sources: [],
          },
        })}
      />,
    );
    expect(screen.getByText('调用了工具').closest('section')).toHaveAttribute(
      'data-state',
      'settled',
    );
    expect(document.querySelector('[data-status="running"]')).toBeNull();
    expect(screen.getByTitle('发送消息')).toBeEnabled();
  });

  it('distinguishes waiting for the model from an executing tool', () => {
    const user = message('user1', 'user');
    const assistant = { ...message('reply1', 'assistant', user.id), status: 'streaming' as const };
    const detail = task('first', user.id);
    detail.events.push({
      id: 'done',
      taskId: detail.task.id,
      sequence: 1,
      eventType: 'agent.library.completed',
      level: 'info',
      summary: '项目检索完成',
      createdAt: 'now',
    });
    render(
      <ChatPanel
        {...props({
          messages: [user, assistant],
          agentTask: detail,
          generation: {
            generationId: 'generation',
            conversationId: conversation.id,
            snapshotId: 'snapshot',
            status: 'streaming',
            userMessage: user,
            assistantMessage: assistant,
            sources: [],
          },
        })}
      />,
    );
    expect(screen.getByText('等待助手回复')).toBeInTheDocument();
    expect(screen.queryByText('正在调用工具')).not.toBeInTheDocument();
    expect(screen.getByTitle('停止生成')).toBeEnabled();
  });
});
