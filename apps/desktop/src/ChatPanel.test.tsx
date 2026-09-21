import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTaskDetail,
  AgentToolConfirmationRequest,
  ChatMessageInfo,
  ConversationInfo,
  MediaModelSelectionRequest,
  ProductionContextInfo,
} from '@ai-video/contracts';
import { ChatPanel } from './ChatPanel';

afterEach(cleanup);

describe('ChatPanel attempt metadata', () => {
  it('shows in-conversation tool calls while a task runs', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '工具进度',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const agentTask: AgentTaskDetail = {
      task: {
        id: 'task',
        projectId: 'project',
        conversationId: conversation.id,
        taskType: 'document-create',
        scopeType: 'project',
        title: '创建文档',
        status: 'running',
        phase: 'tool_validating',
        rowVersion: 1,
        createdAt: '2026-09-09T00:00:00.000Z',
        updatedAt: '2026-09-09T00:00:01.000Z',
      },
      events: [
        {
          id: 'event',
          taskId: 'task',
          sequence: 0,
          eventType: 'agent.tool.started',
          level: 'info',
          summary: '正在调用工具：document.create_draft',
          createdAt: '2026-09-09T00:00:01.000Z',
        },
      ],
      documents: [],
      providerSteps: [
        {
          id: 'step',
          generationId: 'generation',
          attemptId: 'attempt',
          ordinal: 0,
          protocol: 'openai-chat-completions',
          status: 'in_flight',
          toolCallCount: 1,
          startedAt: '2026-09-09T00:00:00.500Z',
        },
      ],
      researchSources: [],
    };
    render(
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
        agentTask={agentTask}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    const panel = screen.getByText('正在调用工具').closest('.agent-tool-timeline');
    expect(panel).toBeInTheDocument();
    expect(panel?.closest('.message-list')).not.toBeNull();
    expect(screen.getByText('document.create_draft')).toBeInTheDocument();
    expect(screen.queryByText('Agent 执行进度')).not.toBeInTheDocument();
    expect(screen.queryByText('校验工具调用')).not.toBeInTheDocument();
    expect(screen.queryByText(/Provider 步骤/)).not.toBeInTheDocument();
  });

  it('places live tool progress after the in-progress assistant message', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '工具进度',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const userMessage: ChatMessageInfo = {
      id: 'user',
      conversationId: conversation.id,
      role: 'user',
      content: '创建文档',
      status: 'complete',
      createdAt: '2026-09-09T00:00:00.000Z',
    };
    const assistantMessage: ChatMessageInfo = {
      id: 'assistant',
      conversationId: conversation.id,
      role: 'assistant',
      content: '正在处理',
      status: 'streaming',
      createdAt: '2026-09-09T00:00:01.000Z',
    };
    const agentTask: AgentTaskDetail = {
      task: {
        id: 'task',
        projectId: 'project',
        conversationId: conversation.id,
        taskType: 'document-create',
        scopeType: 'project',
        title: '创建文档',
        status: 'running',
        phase: 'tool_validating',
        rowVersion: 1,
        createdAt: '2026-09-09T00:00:00.000Z',
        updatedAt: '2026-09-09T00:00:01.000Z',
      },
      events: [
        {
          id: 'event',
          taskId: 'task',
          sequence: 0,
          eventType: 'agent.tool.started',
          level: 'info',
          summary: '正在调用工具：document.create_draft',
          createdAt: '2026-09-09T00:00:01.000Z',
        },
      ],
      documents: [],
      providerSteps: [],
      researchSources: [],
    };
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[userMessage, assistantMessage]}
        composer=""
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
          userMessage,
          assistantMessage,
          sources: [],
        }}
        agentTask={agentTask}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    const list = screen.getByText('正在调用工具').closest('.message-list');
    expect(list).not.toBeNull();
    const items = Array.from(list!.children);
    const timelineIndex = items.findIndex((node) => node.classList.contains('agent-tool-timeline'));
    const assistantIndex = items.findIndex((node) => node.classList.contains('assistant'));
    const userIndex = items.findIndex((node) => node.classList.contains('user'));
    expect(userIndex).toBeGreaterThan(-1);
    expect(assistantIndex).toBeGreaterThan(userIndex);
    expect(timelineIndex).toBeGreaterThan(assistantIndex);
  });

  it('shows live tool progress after the in-progress assistant message', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Tool chat',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const userMessage: ChatMessageInfo = {
      id: 'user',
      conversationId: conversation.id,
      role: 'user',
      content: 'Find the draft',
      status: 'complete',
      createdAt: '2026-09-09T00:00:00.000Z',
    };
    const assistantMessage: ChatMessageInfo = {
      id: 'assistant',
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '2026-09-09T00:00:01.000Z',
    };
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[userMessage, assistantMessage]}
        composer=""
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
          userMessage,
          assistantMessage,
          sources: [],
        }}
        liveAgentActions={[
          { id: 'call-search', toolName: 'library.search', status: 'running' },
        ]}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByText('library.search')).toBeInTheDocument();
    const list = screen.getByText('library.search').closest('.message-list');
    const items = Array.from(list!.children);
    const timelineIndex = items.findIndex((node) => node.classList.contains('agent-tool-timeline'));
    const assistantIndex = items.findIndex((node) => node.classList.contains('assistant'));
    expect(timelineIndex).toBeGreaterThan(assistantIndex);
  });

  it('shows a thinking placeholder while generation is running without tools yet', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Tool chat',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const userMessage: ChatMessageInfo = {
      id: 'user',
      conversationId: conversation.id,
      role: 'user',
      content: 'Hello',
      status: 'complete',
      createdAt: '2026-09-09T00:00:00.000Z',
    };
    const assistantMessage: ChatMessageInfo = {
      id: 'assistant',
      conversationId: conversation.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
      createdAt: '2026-09-09T00:00:01.000Z',
    };
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[userMessage, assistantMessage]}
        composer=""
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
          userMessage,
          assistantMessage,
          sources: [],
        }}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByText('\u6b63\u5728\u601d\u8003')).toBeInTheDocument();
  });

  it('keeps library citations expanded after the task settles', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '工具进度',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const agentTask: AgentTaskDetail = {
      task: {
        id: 'task',
        projectId: 'project',
        conversationId: conversation.id,
        taskType: 'document-query',
        scopeType: 'project',
        title: '检索资料',
        status: 'completed',
        phase: 'artifact_persisting',
        rowVersion: 2,
        createdAt: '2026-09-09T00:00:00.000Z',
        updatedAt: '2026-09-09T00:00:08.000Z',
      },
      events: [
        {
          id: 'event',
          taskId: 'task',
          sequence: 0,
          eventType: 'agent.tool.started',
          level: 'info',
          summary: '正在调用工具：library.search',
          createdAt: '2026-09-09T00:00:01.000Z',
        },
      ],
      documents: [],
      providerSteps: [],
      researchSources: [],
      librarySources: [
        {
          citationLabel: 'L2',
          title: '第 1 章',
          sourceType: 'novel-chapter',
          sourceId: 'chapter-1',
          versionId: 'version-1',
          status: 'published',
          kind: 'note',
          toolName: 'library.search',
        },
      ],
    };
    const onOpenLibrarySource = vi.fn();
    render(
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
        agentTask={agentTask}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
        onOpenLibrarySource={onOpenLibrarySource}
      />,
    );
    expect(screen.getByText('调用了工具')).toBeInTheDocument();
    expect(screen.getByText('library.search')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /L2 第 1 章/ }));
    expect(onOpenLibrarySource).toHaveBeenCalledWith(agentTask.librarySources?.[0]);
    fireEvent.click(screen.getByRole('button', { name: /调用了工具/ }));
    expect(screen.queryByText('library.search')).not.toBeInTheDocument();
  });

  it('renders Chinese action labels, rejections, and the real generation error', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '助手会话',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const userMessage: ChatMessageInfo = {
      id: 'user',
      conversationId: conversation.id,
      role: 'user',
      content: '写镜头提示词',
      status: 'complete',
      createdAt: '2026-09-09T00:00:00.000Z',
    };
    const assistantMessage: ChatMessageInfo = {
      id: 'assistant',
      conversationId: conversation.id,
      role: 'assistant',
      content: '正在检索',
      status: 'failed',
      createdAt: '2026-09-09T00:00:08.000Z',
    };
    const agentTask: AgentTaskDetail = {
      task: {
        id: 'task',
        projectId: 'project',
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        taskType: 'document-query',
        scopeType: 'project',
        title: '检索资料',
        status: 'failed',
        phase: 'recovering',
        errorMessage: 'Provider generation failed.',
        rowVersion: 2,
        createdAt: '2026-09-09T00:00:00.000Z',
        updatedAt: '2026-09-09T00:00:08.000Z',
      },
      events: [
        {
          id: 'started',
          taskId: 'task',
          sequence: 0,
          eventType: 'agent.tool.started',
          level: 'info',
          summary: '正在调用工具：library.search',
          createdAt: '2026-09-09T00:00:01.000Z',
        },
        {
          id: 'rejected',
          taskId: 'task',
          sequence: 1,
          eventType: 'agent.policy.rejected',
          level: 'warning',
          summary: 'Agent tool policy rejected the request (AGENT_TOOL_AUTHORIZATION_REPLAYED).',
          createdAt: '2026-09-09T00:00:01.050Z',
        },
      ],
      documents: [],
      providerSteps: [],
      researchSources: [],
    };
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[userMessage, assistantMessage]}
        composer=""
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
          status: 'failed',
          userMessage,
          assistantMessage,
          sources: [],
          error: 'Pi runtime exceeded the 24-turn limit.',
        }}
        agentTask={agentTask}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByText('检索项目资料')).toBeInTheDocument();
    expect(screen.getByText('同一轮重复调用，授权已失效')).toBeInTheDocument();
    expect(screen.getByText('助手连续调用工具超过 24 轮，已停止。')).toBeInTheDocument();
    expect(screen.queryByText('Provider generation failed.')).not.toBeInTheDocument();
  });

  it('keeps historical tool actions on the matching assistant message', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '助手会话',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const userMessage: ChatMessageInfo = {
      id: 'user-old',
      conversationId: conversation.id,
      role: 'user',
      content: '查看第一章',
      status: 'complete',
      createdAt: '2026-09-09T00:00:00.000Z',
    };
    const assistantMessage: ChatMessageInfo = {
      id: 'assistant-old',
      conversationId: conversation.id,
      role: 'assistant',
      content: '第一章内容如下',
      status: 'complete',
      createdAt: '2026-09-09T00:00:08.000Z',
    };
    const historicalTask: AgentTaskDetail = {
      task: {
        id: 'task-old',
        projectId: 'project',
        conversationId: conversation.id,
        userMessageId: userMessage.id,
        taskType: 'document-query',
        scopeType: 'project',
        title: '检索资料',
        status: 'completed',
        phase: 'artifact_persisting',
        rowVersion: 2,
        createdAt: '2026-09-09T00:00:00.000Z',
        updatedAt: '2026-09-09T00:00:08.000Z',
      },
      events: [
        {
          id: 'read',
          taskId: 'task-old',
          sequence: 0,
          eventType: 'agent.tool.started',
          level: 'info',
          summary: '正在调用工具：library.read',
          createdAt: '2026-09-09T00:00:01.000Z',
        },
        {
          id: 'done',
          taskId: 'task-old',
          sequence: 1,
          eventType: 'agent.library.completed',
          level: 'info',
          summary: '项目检索完成 1 次调用。',
          createdAt: '2026-09-09T00:00:02.000Z',
        },
      ],
      documents: [],
      providerSteps: [],
      researchSources: [],
    };
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[userMessage, assistantMessage]}
        composer=""
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        agentTasks={[historicalTask]}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    const timeline = screen.getByText('阅读资料正文').closest('.agent-tool-timeline');
    const list = screen.getByText('第一章内容如下').closest('.message-list');
    const items = [...(list?.children ?? [])];
    const timelineIndex = items.findIndex((node) => node.classList.contains('agent-tool-timeline'));
    const assistantIndex = items.findIndex((node) => node.classList.contains('assistant'));
    const userIndex = items.findIndex((node) => node.classList.contains('user'));
    expect(timeline).toBeInTheDocument();
    expect(userIndex).toBeGreaterThan(-1);
    expect(timelineIndex).toBeGreaterThan(userIndex);
    expect(assistantIndex).toBeGreaterThan(timelineIndex);
  });

  it('provides an attachment picker for image, video, and document files', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '浠诲姟',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const onAdd = vi.fn();
    const onSend = vi.fn();
    render(
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
        attachments={[
          { id: 'a1', name: 'reference.png', mimeType: 'image/png', size: 12, kind: 'image' },
        ]}
        onAddAttachments={onAdd}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={onSend}
      />,
    );
    expect(screen.getByRole('button', { name: '添加图片、视频或文件' })).toBeInTheDocument();
    expect(screen.getByText('reference.png')).toBeInTheDocument();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onAdd).toHaveBeenCalled();
    const composer = screen.getByRole('textbox', { name: '会话消息' });
    fireEvent.keyDown(composer, {
      key: 'Enter',
      code: 'Enter',
      nativeEvent: { isComposing: false },
    });
    expect(onSend).toHaveBeenCalled();
  });

  it('renders unified Agent model candidates as an actionable card', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const onSelect = vi.fn();
    render(
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
        agentModelSelection={{
          prompt: '生成一张角色图',
          capability: 'text',
          reason: 'agent_tools_required',
          models: [
            {
              providerProfileId: 'profile',
              providerName: '测试供应商',
              modelId: 'model',
              remoteModelId: 'agent-model',
              modelName: '测试 Agent 模型',
              capabilities: {
                text: true,
                vision: false,
                streaming: true,
                reasoning: false,
                tools: true,
                structuredOutput: false,
                embeddings: false,
                imageGeneration: false,
                videoGeneration: false,
              },
              source: 'manual',
              schemaReady: true,
            },
          ],
        }}
        onSelectAgentModel={onSelect}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByRole('dialog', { name: '选择Agent模型' })).toBeInTheDocument();
    expect(screen.getByText(/当前会话模型不支持 Agent 工具调用/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /测试 Agent 模型/ }));
    expect(onSelect).toHaveBeenCalledWith('profile', 'model');
  });

  it('explains when the current Agent model has been retired', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    render(
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
        agentModelSelection={{
          prompt: '写一份大纲',
          capability: 'text',
          reason: 'model_unavailable',
          models: [],
        }}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByText(/当前会话模型已下架或不可用/)).toBeInTheDocument();
  });

  it('keeps media model selection separate and submits validated parameters', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    };
    const request: MediaModelSelectionRequest = {
      selectionToken: 'selection-token',
      kind: 'video',
      prompt: '龙在天空翱翔',
      inputAssetIds: [],
      inputAttachmentCount: 0,
      proposedParameters: { duration: 5 },
      expiresAt: '2026-09-04T01:00:00.000Z',
      candidates: [
        {
          providerProfileId: 'media-profile',
          providerName: '媒体供应商',
          providerType: 'unicompapi',
          providerRegion: 'global',
          modelId: 'media-model',
          remoteModelId: 'video-v1',
          modelName: '视频模型 V1',
          costNotice: { required: true, summary: '提交可能产生费用' },
          adapters: [
            {
              key: 'video-adapter',
              capability: 'TEXT_TO_VIDEO',
              capabilityLabel: '文生视频',
              provider: 'unicompapi',
              providerLabel: 'UniCompAPI',
              model: 'video-v1',
              modelLabel: '视频模型 V1',
              apiVersion: 'v1',
              schemaVersion: 1,
              endpoint: '/videos',
              documentationUrl: 'https://example.com/video',
              credentialProvider: 'unicompapi',
              parameterSchema: {
                $schema: 'https://json-schema.org/draft/2020-12/schema',
                type: 'object',
                additionalProperties: false,
                required: ['prompt', 'duration'],
                properties: {
                  prompt: { type: 'string', title: '提示词' },
                  duration: { type: 'integer', title: '时长' },
                },
              },
              uiSchema: { fields: [] },
            },
          ],
        },
      ],
    };
    const onSelectMedia = vi.fn();
    const onSelectAgent = vi.fn();
    render(
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
        selectedLlmProfileId="agent-profile"
        selectedLlmModelId="agent-model"
        mediaModelSelection={request}
        onSelectMediaModel={onSelectMedia}
        onSelectAgentModel={onSelectAgent}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /视频模型 V1/ }));
    expect(screen.getByDisplayValue('龙在天空翱翔')).toBeInTheDocument();
    expect(screen.getByDisplayValue('5')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提交生成' }));
    expect(onSelectMedia).toHaveBeenCalledWith({
      providerProfileId: 'media-profile',
      modelId: 'media-model',
      adapterKey: 'video-adapter',
      parameters: { prompt: '龙在天空翱翔', duration: 5 },
    });
    expect(onSelectAgent).not.toHaveBeenCalled();
  });

  it('renders an in-session confirmation card and reports the user decision', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const confirmation: AgentToolConfirmationRequest = {
      version: 1,
      confirmationId: 'confirmation',
      confirmationToken: 'token',
      taskId: 'task',
      toolCallId: 'tool-call',
      operation: 'document.archive',
      action: 'document.archive',
      argumentsHash: 'arguments-hash',
      projectSessionId: 'project-session',
      riskLevel: 'R2',
      summary: '归档文档“旧草稿”',
      affectedEntities: [{ type: 'document', id: 'document', label: '旧草稿' }],
      documentId: 'document',
      documentTitle: '旧草稿',
      expiresAt: '2026-08-03T01:00:00.000Z',
    };
    const onConfirm = vi.fn();
    render(
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
        confirmation={confirmation}
        onConfirmAgentAction={onConfirm}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('旧草稿');
    fireEvent.click(screen.getByRole('button', { name: '批准' }));
    expect(onConfirm).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('renders a generic R3 confirmation and opens its protected UI handoff', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '设置会话',
      createdAt: '2026-09-07T00:00:00.000Z',
      updatedAt: '2026-09-07T00:00:00.000Z',
    };
    const confirmation: AgentToolConfirmationRequest = {
      version: 1,
      confirmationId: 'confirmation',
      confirmationToken: 'token',
      taskId: 'task',
      toolCallId: 'tool-call',
      operation: 'settings.propose_update',
      action: 'settings.propose_update',
      argumentsHash: 'arguments-hash',
      projectSessionId: 'project-session',
      riskLevel: 'R3',
      summary: '在受保护设置中修改“主供应商”',
      affectedEntities: [{ type: 'provider-profile', id: 'provider-profile', label: '主供应商' }],
      protectedUi: {
        page: 'providers',
        focusId: 'provider-profile',
        reason: '连接地址和凭据只能在受保护设置界面中修改。',
      },
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
    const onConfirm = vi.fn();
    const onOpenProtectedUi = vi.fn();
    render(
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
        confirmation={confirmation}
        onConfirmAgentAction={onConfirm}
        onOpenProtectedUi={onOpenProtectedUi}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('风险等级：R3');
    expect(screen.getByRole('alert')).toHaveTextContent('主供应商');
    expect(screen.getByRole('alert')).toHaveTextContent('连接地址和凭据只能');
    fireEvent.click(screen.getByRole('button', { name: '在受保护页面继续' }));
    expect(onOpenProtectedUi).toHaveBeenCalledWith(confirmation.protectedUi);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('shows a restart recovery notice for retryable Agent tasks', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const onOpenTaskLog = vi.fn();
    render(
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
        agentTask={{
          task: {
            id: 'task',
            projectId: 'project',
            conversationId: conversation.id,
            taskType: 'document-create',
            scopeType: 'project',
            title: '中断任务',
            status: 'failed',
            phase: 'recovering',
            retryable: true,
            createdAt: '2026-08-03T00:00:00.000Z',
            updatedAt: '2026-08-03T00:00:01.000Z',
            rowVersion: 1,
          },
          events: [],
          documents: [],
          providerSteps: [],
          researchSources: [],
        }}
        onOpenTaskLog={onOpenTaskLog}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByText(/上次 Agent 任务未完成/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看任务日志' }));
    expect(onOpenTaskLog).toHaveBeenCalledOnce();
  });

  it('shows persisted confirmation recovery metadata without exposing approval actions', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    render(
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
        agentTask={{
          task: {
            id: 'task',
            projectId: 'project',
            conversationId: conversation.id,
            taskType: 'document-archive',
            scopeType: 'project',
            title: '归档任务',
            status: 'failed',
            phase: 'recovering',
            retryable: true,
            createdAt: '2026-08-03T00:00:00.000Z',
            updatedAt: '2026-08-03T00:00:01.000Z',
            rowVersion: 1,
          },
          pendingConfirmation: {
            version: 1,
            confirmationId: 'confirmation',
            taskId: 'task',
            toolCallId: 'tool-call',
            operation: 'document.archive',
            action: 'document.archive',
            argumentsHash: 'arguments-hash',
            projectSessionId: 'project-session',
            riskLevel: 'R2',
            summary: '归档文档“待归档草稿”',
            affectedEntities: [{ type: 'document', id: 'document', label: '待归档草稿' }],
            documentId: 'document',
            documentTitle: '待归档草稿',
            expiresAt: '2026-08-03T01:00:00.000Z',
            status: 'expired',
          },
          events: [],
          documents: [],
          providerSteps: [],
          researchSources: [],
        }}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('待归档草稿');
    expect(screen.getByText(/确认已过期/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '批准' })).not.toBeInTheDocument();
  });

  it('renders required deliverable progress and sends the missing-item continuation', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const onContinue = vi.fn();
    render(
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
        agentTask={{
          task: {
            id: 'task',
            projectId: 'project',
            conversationId: conversation.id,
            taskType: 'document-create',
            scopeType: 'project',
            title: '短剧任务',
            status: 'waiting_review',
            phase: 'waiting_review',
            createdAt: '2026-08-03T00:00:00.000Z',
            updatedAt: '2026-08-03T00:00:01.000Z',
            rowVersion: 1,
          },
          plan: {
            id: 'plan',
            taskId: 'task',
            projectId: 'project',
            plan: {
              version: 1,
              mode: 'short-drama',
              action: 'generate',
              deliverables: [
                { kind: 'episode-outline', required: true, dependsOn: [] },
                { kind: 'shot-prompts', required: true, dependsOn: ['episode-outline'] },
              ],
              constraints: [],
            },
            trustedScope: { selectedChapterIds: [] },
            status: 'active',
            deliverables: [
              {
                id: 'd1',
                kind: 'episode-outline',
                required: true,
                dependsOn: [],
                status: 'succeeded',
              },
              {
                id: 'd2',
                kind: 'shot-prompts',
                required: true,
                dependsOn: ['episode-outline'],
                status: 'pending',
              },
            ],
            createdAt: '2026-08-03T00:00:00.000Z',
            updatedAt: '2026-08-03T00:00:01.000Z',
          },
          events: [],
          documents: [],
          providerSteps: [],
          researchSources: [],
        }}
        onContinueAgentTask={onContinue}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText(/shot-prompts/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '继续完成缺失交付物' }));
    expect(onContinue).toHaveBeenCalledOnce();
  });

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
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
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
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
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

  it('uses the unified natural-language composer without document or mode shortcuts', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Test conversation',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    render(
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
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(screen.queryByTitle('创建文档草稿')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '项目' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '场次' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '镜头' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '小说创作' })).not.toBeInTheDocument();
    expect(
      screen.getByPlaceholderText('描述你要完成的任务，需要时会检索项目里的草稿和已发布资料…'),
    ).toBeInTheDocument();
  });

  it('collapses untitled conversation chips in the library catalog', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Test conversation',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    const contextPreview: ProductionContextInfo = {
      version: 1,
      scopeType: 'project',
      scopeLabel: '项目',
      estimatedTokens: 1200,
      budgetTokens: 24000,
      sources: [],
      catalog: [
        {
          id: 'doc-1',
          sourceType: 'document',
          sourceId: 'doc-1',
          status: 'draft',
          title: '林澈',
          updatedAt: '2026-08-03T00:00:00.000Z',
        },
        {
          id: 'convo-1',
          sourceType: 'conversation',
          sourceId: 'convo-1',
          status: 'conversation',
          title: '新会话',
          updatedAt: '2026-08-03T00:00:00.000Z',
        },
        {
          id: 'convo-2',
          sourceType: 'conversation',
          sourceId: 'convo-2',
          status: 'conversation',
          title: '新会话',
          updatedAt: '2026-08-03T00:00:01.000Z',
        },
        {
          id: 'convo-3',
          sourceType: 'conversation',
          sourceId: 'convo-3',
          status: 'conversation',
          title: '角色讨论',
          updatedAt: '2026-08-03T00:00:02.000Z',
        },
      ],
    };
    render(
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
        contextPreview={contextPreview}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(screen.getByText('资料目录 3 项')).toBeInTheDocument();
    expect(screen.getByText(/林澈 · 草稿/)).toBeInTheDocument();
    expect(screen.getByText(/角色讨论 · conversation/)).toBeInTheDocument();
    expect(screen.getByText(/会话记录 2 条 · conversation/)).toBeInTheDocument();
    expect(screen.queryByText(/新会话 · conversation/)).not.toBeInTheDocument();
  });

  it('does not expose internal workflow mode labels', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Test conversation',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    };
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[conversation]}
        conversation={conversation}
        messages={[]}
        composer="生成本集的场次和镜头提示词"
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        onCollapse={vi.fn()}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    expect(screen.queryByTitle('创建文档草稿')).not.toBeInTheDocument();
    expect(screen.queryByText(/短剧创作/)).not.toBeInTheDocument();
    expect(screen.queryByText(/小说创作/)).not.toBeInTheDocument();
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
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={onOpenProviderSettings}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    expect(screen.queryByText('输入 100')).not.toBeInTheDocument();
    expect(screen.queryByText('预计 USD 0.00059')).not.toBeInTheDocument();
    expect(screen.queryByText('调用明细')).not.toBeInTheDocument();
    expect(screen.queryByText('保存为文档草稿')).not.toBeInTheDocument();
    expect(screen.queryByText('加入记忆')).not.toBeInTheDocument();
    expect(screen.queryByText('添加约束')).not.toBeInTheDocument();
    expect(screen.getByText(/旧版环境变量配置/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '迁移到供应商设置' }));
    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
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
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onArchiveConversation={onArchiveConversation}
        onRestoreConversation={onRestoreConversation}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多会话操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '归档会话' }));
    expect(onArchiveConversation).toHaveBeenCalledWith('conversation');
    fireEvent.click(screen.getByRole('button', { name: '更多会话操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '加载更多会话' }));
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
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onArchiveConversation={onArchiveConversation}
        onRestoreConversation={onRestoreConversation}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '更多会话操作' }));
    fireEvent.click(screen.getByRole('menuitem', { name: '恢复会话' }));
    expect(onRestoreConversation).toHaveBeenCalledWith('conversation');
  });

  it('surfaces the sticky chapter context and clears it on request', () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '短剧会话',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
    };
    const onClearSelectedChapters = vi.fn();
    render(
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
        selectedChapterCount={2}
        onClearSelectedChapters={onClearSelectedChapters}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );

    // Selected chapters turn every following turn into a short-drama task, so
    // the state has to stay visible after the chapter workspace is left.
    expect(screen.getByRole('status')).toHaveTextContent('下次发送将带上 2 个章节作为本集范围');
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(onClearSelectedChapters).toHaveBeenCalledOnce();
  });
  it('disables message composer and buttons when conversation is archived', () => {
    const archivedConversation: ConversationInfo = {
      id: 'archived-conv',
      projectId: 'proj',
      scopeType: 'project',
      title: '已归档会话',
      archivedAt: '2026-09-09T00:00:00.000Z',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[archivedConversation]}
        conversation={archivedConversation}
        messages={[]}
        composer=""
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    const textarea = screen.getByLabelText('会话消息');
    expect(textarea).toBeDisabled();
    expect(textarea).toHaveAttribute('placeholder', '当前会话已归档，处于只读状态');
    expect(screen.getByTitle('发送消息')).toBeDisabled();
    expect(screen.getByTitle('添加图片、视频或文件')).toBeDisabled();
  });
  it('renders load earlier messages button when canLoadEarlierMessages is true', () => {
    const testConv: ConversationInfo = {
      id: 'test-conv',
      projectId: 'proj',
      scopeType: 'project',
      title: '测试会话',
      createdAt: '2026-09-09T00:00:00.000Z',
      updatedAt: '2026-09-09T00:00:00.000Z',
    };
    const testMessage: ChatMessageInfo = {
      id: 'msg-1',
      conversationId: testConv.id,
      role: 'user',
      content: '第一条消息',
      status: 'complete',
      createdAt: '2026-09-09T00:00:00.000Z',
    };
    const onLoadEarlier = vi.fn();
    render(
      <ChatPanel
        scopeType="project"
        scopeAvailable
        writable
        conversations={[testConv]}
        conversation={testConv}
        messages={[testMessage]}
        composer=""
        statusMessage=""
        legacyLlmConfigured={false}
        llmProfiles={[]}
        llmModels={[]}
        selectedLlmProfileId=""
        selectedLlmModelId=""
        canLoadEarlierMessages
        loadingEarlierMessages={false}
        onLoadEarlierMessages={onLoadEarlier}
        onSelectConversation={vi.fn()}
        onCreateConversation={vi.fn()}
        onRetryGeneration={vi.fn()}
        onLlmProfileChange={vi.fn()}
        onLlmModelChange={vi.fn()}
        onOpenProviderSettings={vi.fn()}
        onComposerChange={vi.fn()}
        onCancelGeneration={vi.fn()}
        onSendMessage={vi.fn()}
      />,
    );
    const loadButton = screen.getByRole('button', { name: '加载更早历史消息' });
    expect(loadButton).toBeInTheDocument();
    fireEvent.click(loadButton);
    expect(onLoadEarlier).toHaveBeenCalledOnce();
  });
});
