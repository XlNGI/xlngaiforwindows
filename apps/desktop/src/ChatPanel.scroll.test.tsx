import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import type { ConversationInfo, LlmGenerationInfo } from '@ai-video/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatPanel } from './ChatPanel';

const conversation: ConversationInfo = {
  id: 'chat',
  projectId: 'project',
  scopeType: 'project',
  title: 'Chat',
  createdAt: 'now',
  updatedAt: 'now',
};

function props(
  content = 'Initial reply',
  status: LlmGenerationInfo['status'] = 'streaming',
  selectedConversation = conversation,
): ComponentProps<typeof ChatPanel> {
  const generation: LlmGenerationInfo = {
    generationId: 'generation',
    conversationId: selectedConversation.id,
    snapshotId: 'snapshot',
    status,
    userMessage: {
      id: 'user',
      conversationId: selectedConversation.id,
      role: 'user',
      content: 'Earlier request',
      status: 'complete',
      createdAt: 'now',
    },
    assistantMessage: {
      id: 'assistant',
      conversationId: selectedConversation.id,
      role: 'assistant',
      content,
      status: status === 'streaming' ? 'streaming' : 'complete',
      createdAt: 'now',
    },
    sources: [],
  };
  return {
    scopeType: 'project',
    scopeAvailable: true,
    writable: true,
    conversations: [selectedConversation],
    conversation: selectedConversation,
    messages: [generation.userMessage, generation.assistantMessage],
    composer: '',
    statusMessage: '',
    legacyLlmConfigured: false,
    llmProfiles: [],
    llmModels: [],
    selectedLlmProfileId: '',
    selectedLlmModelId: '',
    generation,
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

let contentHeight: number;

beforeEach(() => {
  vi.useFakeTimers();
  contentHeight = 1200;
  const positions = new WeakMap<Element, number>();
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('message-list') ? contentHeight : 0;
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return this.classList.contains('message-list') ? 400 : 0;
  });
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) {
    return positions.get(this) ?? 0;
  });
  // jsdom has no layout; reproduce the browser's clamping at the scroll boundary.
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (
    this: Element,
    value: number,
  ) {
    positions.set(this, Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight)));
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function messageList(): HTMLDivElement {
  return screen.getByText('Earlier request').closest<HTMLDivElement>('.message-list')!;
}

async function flushReply() {
  await act(() => vi.advanceTimersByTime(40));
}

describe('ChatPanel message scrolling', () => {
  it('follows rendered reply chunks while the user stays at the bottom', async () => {
    const { rerender } = render(<ChatPanel {...props()} />);
    const list = messageList();
    expect(list.scrollTop).toBe(800);

    contentHeight = 1700;
    rerender(<ChatPanel {...props('Longer reply')} />);
    await flushReply();

    expect(screen.getByText('Longer reply')).toBeInTheDocument();
    expect(list.scrollTop).toBe(1300);
  });

  it('preserves the reading position through streamed text and tool updates', async () => {
    const { rerender } = render(<ChatPanel {...props()} />);
    const list = messageList();
    list.scrollTop = 250;
    fireEvent.scroll(list);

    contentHeight = 1700;
    rerender(<ChatPanel {...props('More streamed text')} />);
    expect(list.scrollTop).toBe(250);
    await flushReply();
    expect(screen.getByText('More streamed text')).toBeInTheDocument();
    expect(list.scrollTop).toBe(250);

    contentHeight = 1900;
    rerender(
      <ChatPanel
        {...props('More streamed text')}
        liveAgentActions={[{ id: 'search', toolName: 'library.search', status: 'running' }]}
      />,
    );
    await flushReply();
    expect(screen.getByText('library.search')).toBeInTheDocument();
    expect(list.scrollTop).toBe(250);
  });

  it('resumes following when the user scrolls back to the bottom', async () => {
    const { rerender } = render(<ChatPanel {...props()} />);
    const list = messageList();
    list.scrollTop = 0;
    fireEvent.scroll(list);
    list.scrollTop = list.scrollHeight - list.clientHeight;
    fireEvent.scroll(list);

    contentHeight = 1800;
    rerender(<ChatPanel {...props('Next chunk')} />);
    await flushReply();

    expect(list.scrollTop).toBe(1400);
  });

  it.each(['complete', 'failed', 'cancelled'] as const)(
    'keeps the reading position when generation becomes %s',
    async (status) => {
      const { rerender } = render(<ChatPanel {...props()} />);
      const list = messageList();
      list.scrollTop = 250;
      fireEvent.scroll(list);

      contentHeight = 1700;
      rerender(<ChatPanel {...props('Final reply', status)} />);
      await flushReply();

      expect(screen.getByText('Final reply')).toBeInTheDocument();
      expect(list.scrollTop).toBe(250);
    },
  );

  it('starts following the newly selected conversation after browsing history', async () => {
    const { rerender } = render(<ChatPanel {...props()} />);
    const list = messageList();
    list.scrollTop = 250;
    fireEvent.scroll(list);
    const otherConversation = { ...conversation, id: 'other', title: 'Other chat' };

    contentHeight = 1500;
    rerender(
      <ChatPanel
        {...props('Other reply', 'streaming', otherConversation)}
        conversations={[conversation, otherConversation]}
      />,
    );
    await flushReply();

    expect(list.scrollTop).toBe(1100);
  });
});
