import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageInfo, ConversationInfo } from '@ai-video/contracts';
import { ChatPanel } from './ChatPanel';

afterEach(cleanup);

describe('ChatPanel attempt metadata', () => {
  it('submits with Enter and keeps Shift+Enter for a newline', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const onSendMessage = vi.fn();
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[]}
        composer="继续写下去"
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        onScopeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onPromoteMessage={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={onSendMessage}
      />,
    );

    const composer = screen.getByLabelText('会话消息');
    fireEvent.keyDown(composer, { key: 'Enter' });
    expect(onSendMessage).toHaveBeenCalledOnce();

    fireEvent.keyDown(composer, { key: 'Enter', shiftKey: true });
    expect(onSendMessage).toHaveBeenCalledOnce();
  });

  it('does not submit with Enter while generation is active', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const onSendMessage = vi.fn();
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[]}
        composer="继续写下去"
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        generation={{
          generationId: 'generation',
          conversationId: conversation.id,
          snapshotId: 'snapshot',
          status: 'streaming',
          userMessage: {
            id: 'user',
            conversationId: conversation.id,
            role: 'user',
            content: '之前的消息',
            status: 'complete',
            createdAt: '2026-08-03T00:00:00.000Z',
          },
          assistantMessage: {
            id: 'assistant',
            conversationId: conversation.id,
            role: 'assistant',
            content: '生成中',
            status: 'streaming',
            createdAt: '2026-08-03T00:00:00.000Z',
          },
          sources: [],
        }}
        onScopeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onPromoteMessage={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={onSendMessage}
      />,
    );

    fireEvent.keyDown(screen.getByLabelText('会话消息'), { key: 'Enter' });
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it('exposes an explicit document draft action only for a writable message', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Test conversation',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const onCreateDocumentDraft = vi.fn();
    const { rerender } = render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[]}
        composer="Draft a project brief"
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        onCollapse={vi.fn()}
        onScopeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onPromoteMessage={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
        onCreateDocumentDraft={onCreateDocumentDraft}
      />,
    );

    fireEvent.click(screen.getByTitle('创建文档草稿'));
    expect(onCreateDocumentDraft).toHaveBeenCalledOnce();

    rerender(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable={false}
        conversations={[conversation]}
        conversation={conversation}
        messages={[]}
        composer="Draft a project brief"
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        onCollapse={vi.fn()}
        onScopeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onPromoteMessage={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
        onCreateDocumentDraft={onCreateDocumentDraft}
      />,
    );

    expect(screen.getByTitle('创建文档草稿')).toBeDisabled();
  });

  it('shows provider usage, snapshot cost, latency details, and missing usage', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const messages: ChatMessageInfo[] = [
      {
        id: 'assistant-priced',
        conversationId: conversation.id,
        role: 'assistant',
        content: '有用量',
        status: 'complete',
        createdAt: '2026-08-03T00:00:02.000Z',
        attempt: {
          id: 'attempt-priced',
          generationId: 'generation-priced',
          providerName: 'OpenAI A',
          modelName: 'GPT A',
          protocol: 'openai-responses',
          status: 'complete',
          startedAt: '2026-08-03T00:00:00.000Z',
          firstTokenAt: '2026-08-03T00:00:00.250Z',
          completedAt: '2026-08-03T00:00:02.000Z',
          usage: {
            inputTokens: 100,
            cachedInputTokens: 20,
            outputTokens: 50,
            providerReportedCost: { amount: '0.00061', currency: 'USD' },
          },
          pricingSnapshot: {
            currency: 'USD',
            unitTokens: 1_000_000,
            inputPrice: '1',
            cachedInputPrice: '0.5',
            outputPrice: '10',
            configuredAt: '2026-08-03T00:00:00.000Z',
          },
          estimatedCost: '0.00059',
          currency: 'USD',
          providerReportedCost: { amount: '0.00061', currency: 'USD' },
        },
      },
      {
        id: 'assistant-unpriced',
        conversationId: conversation.id,
        role: 'assistant',
        content: '无用量',
        status: 'complete',
        createdAt: '2026-08-03T00:01:00.000Z',
        attempt: {
          id: 'attempt-unpriced',
          generationId: 'generation-unpriced',
          providerName: 'Relay',
          modelName: 'Relay Model',
          protocol: 'openai-chat-completions',
          status: 'complete',
          startedAt: '2026-08-03T00:00:59.000Z',
          completedAt: '2026-08-03T00:01:00.000Z',
        },
      },
    ];

    const onOpenProviderSettings = vi.fn();
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={messages}
        composer=""
        statusMessage=""
        llmStatus={{
          provider: 'Legacy',
          model: 'legacy',
          configured: true,
          configurationSource: 'environment',
        }}
        legacyLlmConfigured
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        onCollapse={vi.fn()}
        onScopeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onPromoteMessage={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={onOpenProviderSettings}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(screen.getByText('输入 100')).toBeInTheDocument();
    expect(screen.getByText('预计 USD 0.00059')).toBeInTheDocument();
    expect(screen.getByText('供应商未提供用量')).toBeInTheDocument();
    expect(screen.getByText(/旧版环境变量配置/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '迁移到供应商设置' }));
    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getAllByText('调用明细')[0]!);
    expect(screen.getByText('250 ms')).toBeInTheDocument();
    expect(screen.getByText(/USD 输入 1/)).toBeInTheDocument();
    expect(screen.getByText('USD 0.00061')).toBeInTheDocument();
  });

  it('calls archive and restore callbacks for the selected conversation', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const onArchiveConversation = vi.fn();
    const onRestoreConversation = vi.fn();
    const onLoadMoreConversations = vi.fn();
    const view = render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[]}
        composer=""
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        showArchivedConversations
        onShowArchivedConversationsChange={vi.fn()}
        canLoadMoreConversations
        onLoadMoreConversations={onLoadMoreConversations}
        onScopeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onArchiveConversation={onArchiveConversation}
        onRestoreConversation={onRestoreConversation}
        onPromoteMessage={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '归档会话' }));
    expect(onArchiveConversation).toHaveBeenCalledWith('conversation');
    fireEvent.click(screen.getByRole('button', { name: '加载更多会话' }));
    expect(onLoadMoreConversations).toHaveBeenCalledTimes(1);

    const archived: ConversationInfo = { ...conversation, archivedAt: '2026-08-16T00:00:00.000Z' };
    view.rerender(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[archived]}
        conversation={archived}
        messages={[]}
        composer=""
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        showArchivedConversations
        onShowArchivedConversationsChange={vi.fn()}
        onScopeChange={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onArchiveConversation={onArchiveConversation}
        onRestoreConversation={onRestoreConversation}
        onPromoteMessage={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '恢复会话' }));
    expect(onRestoreConversation).toHaveBeenCalledWith('conversation');
  });
});
