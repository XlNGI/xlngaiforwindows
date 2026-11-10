import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { AgentTaskDetail, ChatMessageInfo, ConversationInfo } from '@ai-video/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';

afterEach(cleanup);

it('shows bundle counts and click duration without treating saved drafts as verified', () => {
  const detail = task('bundle', 'u1');
  detail.deliveryReview = {
    state: 'pending',
    pendingTargetIds: [],
    issueCount: 0,
    bundle: {
      businessSaved: true,
      readbackVerified: false,
      counts: { character: 2, scene: 1, prop: 1, voice: 2, shot: 1, storyScene: 1 },
      requestedAt: '2026-11-09T00:00:00.000Z',
      taskCreatedAt: '2026-11-09T00:00:05.000Z',
      elapsedMs: 65000,
      preparationMs: 5000,
    },
  };
  render(
    <ChatPanel
      {...props({
        messages: [message('u1', 'user'), message('a1', 'assistant', 'u1')],
        agentTasks: [detail],
      })}
    />,
  );
  fireEvent.click(screen.getByText(/查看交付与质量/));
  expect(screen.getByText(/草稿已保存/)).toHaveTextContent('待读回核对');
  expect(screen.getByText(/草稿已保存/)).toHaveTextContent('点击后耗时 1 分 5 秒');
  expect(screen.getByText(/草稿已保存/)).toHaveTextContent('音色样本 2');
  expect(screen.getByText(/草稿已保存/)).toHaveTextContent('启动准备 5.0 秒');
});

it('opens a scoped delivery and shows the cited original requirement without treating an unconfirmed issue as verified', () => {
  const detail = task('quality', 'u1');
  detail.task.status = 'completed';
  detail.documents = [
    { documentId: 'doc', documentVersionId: 'v2', operation: 'create', createdAt: 'now' },
  ];
  const target = {
    id: 'doc',
    kind: 'document' as const,
    title: '第一章',
    version: 'v2',
    state: 'needs_revision' as const,
  };
  detail.deliveryReview = {
    state: 'needs_revision',
    pendingTargetIds: ['doc'],
    issueCount: 1,
    targets: [target],
    requirements: [{ id: 'requirement', text: '必须保留原对白及说话顺序。' }],
    issues: [
      {
        id: 'issue',
        targetId: 'doc',
        targetVersion: 'v1',
        description: '对白顺序待核实',
        evidenceStatus: 'needs_correction',
        requirementIds: ['requirement'],
      },
    ],
  };
  const onOpenReviewTarget = vi.fn();
  render(
    <ChatPanel
      {...props({
        messages: [message('u1', 'user'), message('a1', 'assistant', 'u1')],
        agentTasks: [detail],
        onOpenReviewTarget,
      })}
    />,
  );
  fireEvent.click(screen.getByText(/查看交付与质量/));
  fireEvent.click(screen.getByRole('button', { name: '打开当前正文' }));
  expect(onOpenReviewTarget).toHaveBeenCalledWith('project', target);
  fireEvent.click(screen.getByRole('button', { name: '查看对应原始要求' }));
  expect(screen.getByText('必须保留原对白及说话顺序。')).toBeVisible();
  expect(screen.getByText(/待核实问题（证据需更正）/)).toBeVisible();
  expect(screen.getByText(/问题来自较早版本/)).toBeVisible();
});

it('shows saved content separately from verified content, and waiting tasks do not appear to generate', () => {
  const detail = task('saved', 'u1');
  detail.task.status = 'completed';
  detail.documents = [
    { documentId: 'doc', documentVersionId: 'v1', operation: 'create', createdAt: 'now' },
  ];
  const state = props({
    messages: [message('u1', 'user'), message('a1', 'assistant', 'u1')],
    agentTasks: [detail],
  });
  const view = render(<ChatPanel {...state} />);
  expect(screen.getByText('a1').closest('article')).toHaveTextContent('已保存 · 内容未核验');
  detail.deliveryReview = { state: 'verified', pendingTargetIds: [], issueCount: 0 };
  view.rerender(<ChatPanel {...state} />);
  expect(screen.getByText('a1').closest('article')).toHaveTextContent('已保存 · 内容已核验');
  detail.task.status = 'waiting_review';
  view.rerender(<ChatPanel {...state} agentTask={detail} />);
  expect(screen.getAllByText('等待用户操作').length).toBeGreaterThan(0);
  expect(screen.queryByText('正在调用工具')).not.toBeInTheDocument();
});

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
  it.each([false, true])(
    'hides stale completion feedback while a restored task is running (concurrent: %s)',
    (allowConcurrentTasks) => {
      const state = props({
        agentTask: task('first', 'user1'),
        statusMessage: '生成完成',
        allowConcurrentTasks,
      });
      const view = render(<ChatPanel {...state} />);
      expect(screen.getByText('正在调用工具')).toBeInTheDocument();
      expect(screen.queryByText('生成完成')).not.toBeInTheDocument();

      view.rerender(<ChatPanel {...state} statusMessage="生成状态读取失败" />);
      expect(screen.getByText('生成状态读取失败')).toBeInTheDocument();

      const completed = task('first', 'user1');
      completed.task.status = 'completed';
      view.rerender(<ChatPanel {...state} agentTask={completed} />);
      expect(screen.queryByText('生成完成')).not.toBeInTheDocument();
    },
  );

  it('attaches cancelled, partial and read-only outcomes to their own replies, never a global completion', () => {
    const stopped = task('stopped', 'u1');
    stopped.task.status = 'cancelled';
    const partial = task('partial', 'u2');
    partial.task.status = 'completed';
    partial.task.completionState = 'partial';
    partial.task.outcome = 'read-only';
    partial.task.errorMessage = '缺少可写目标';
    const answered = task('answered', 'u3');
    answered.task.status = 'completed';
    answered.task.outcome = 'read-only';
    render(
      <ChatPanel
        {...props({
          messages: [
            message('u1', 'user'),
            message('a1', 'assistant', 'u1'),
            message('u2', 'user'),
            message('a2', 'assistant', 'u2'),
            message('u3', 'user'),
            message('a3', 'assistant', 'u3'),
          ],
          agentTasks: [stopped, partial, answered],
          statusMessage: '生成完成',
        })}
      />,
    );
    expect(screen.getByText('a1').closest('article')).toHaveTextContent('任务已停止');
    expect(screen.getByText('a2').closest('article')).toHaveTextContent('未完成 · 未执行保存');
    expect(screen.getByText('a2').closest('article')).toHaveTextContent('缺少可写目标');
    expect(screen.getByText('a3').closest('article')).toHaveTextContent('回复结束');
    expect(screen.getByText('a1').closest('article')).not.toHaveTextContent('回复结束');
    expect(screen.queryByText('生成完成')).not.toBeInTheDocument();
  });

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
