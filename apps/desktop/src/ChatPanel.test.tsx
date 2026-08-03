import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessageInfo, ConversationInfo } from '@ai-video/contracts';
import { ChatPanel } from './ChatPanel';

afterEach(cleanup);

describe('ChatPanel attempt metadata', () => {
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
});
