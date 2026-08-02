import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationInfo, LlmGenerationInfo } from '@ai-video/contracts';
import { App, mergeGenerationMessage } from './App';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({
  callWorker: vi.fn((method: string) =>
    Promise.resolve(
      method === 'health'
        ? {
            protocolVersion: 1,
            workerVersion: '0.1.0',
            nodeVersion: 'v22.0.0',
            platform: 'win32',
            arch: 'x64',
            pid: 123,
          }
        : method === 'sqlite.probe'
          ? {
              databasePath: 'probe.sqlite',
              sqliteVersion: '3.50.0',
              journalMode: 'wal',
              writeVerified: true,
            }
          : method === 'project.recent'
            ? []
            : null,
    ),
  ),
}));

describe('App', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders the M2 workspace areas and runtime health', async () => {
    render(<App />);
    expect(screen.getByText('项目文档')).toBeInTheDocument();
    expect(screen.getByText('文档编辑器')).toBeInTheDocument();
    expect(screen.getByText('生产参数')).toBeInTheDocument();
    expect(screen.getByText('项目会话')).toBeInTheDocument();
    expect(await screen.findByText('本地服务正常')).toBeInTheDocument();
  });

  it('disables project actions until an absolute path is entered', () => {
    render(<App />);
    const manager = screen.getByRole('region', { name: '项目管理' });
    expect(within(manager).getByRole('button', { name: '新建' })).toBeDisabled();
    expect(within(manager).getByRole('button', { name: '打开' })).toBeDisabled();
    expect(callWorker).not.toHaveBeenCalledWith('project.create', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith('project.open', expect.anything());
  });

  it('does not merge a streaming message into another conversation', () => {
    const messages = [
      {
        id: 'current',
        conversationId: 'conversation-b',
        role: 'user' as const,
        content: 'Current conversation',
        status: 'complete' as const,
        createdAt: 'now',
      },
    ];
    const generation: LlmGenerationInfo = {
      generationId: 'generation',
      conversationId: 'conversation-a',
      snapshotId: 'snapshot',
      status: 'streaming',
      userMessage: {
        id: 'user-a',
        conversationId: 'conversation-a',
        role: 'user',
        content: 'Prompt',
        status: 'complete',
        createdAt: 'now',
      },
      assistantMessage: {
        id: 'assistant-a',
        conversationId: 'conversation-a',
        replyToMessageId: 'user-a',
        role: 'assistant',
        content: 'Delta',
        status: 'streaming',
        createdAt: 'now',
      },
      sources: [],
    };

    expect(mergeGenerationMessage(messages, 'conversation-b', generation)).toBe(messages);
  });

  it('ignores a stale conversation load after switching scope', async () => {
    let resolveProjectConversations!: (value: ConversationInfo[]) => void;
    const projectConversations = new Promise<ConversationInfo[]>((resolve) => {
      resolveProjectConversations = resolve;
    });
    const sceneConversation: ConversationInfo = {
      id: 'scene-conversation',
      projectId: 'project',
      scopeType: 'scene',
      scopeId: 'scene',
      title: '场次会话',
      createdAt: 'now',
      updatedAt: 'now',
    };
    const projectConversation: ConversationInfo = {
      ...sceneConversation,
      id: 'project-conversation',
      scopeType: 'project',
      scopeId: undefined,
      title: '旧项目会话',
    };
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'health') {
        return Promise.resolve({
          protocolVersion: 1,
          workerVersion: '0.1.0',
          nodeVersion: 'v22.0.0',
          platform: 'win32',
          arch: 'x64',
          pid: 123,
        });
      }
      if (method === 'sqlite.probe') {
        return Promise.resolve({
          databasePath: 'probe.sqlite',
          sqliteVersion: '3.50.0',
          journalMode: 'wal',
          writeVerified: true,
        });
      }
      if (method === 'project.current') {
        return Promise.resolve({
          id: 'project',
          name: 'Race Project',
          rootPath: 'D:\\Race',
          createdAt: 'now',
          updatedAt: 'now',
          mode: 'read-write',
          schemaVersion: 4,
        });
      }
      if (method === 'project.recent' || method === 'document.list' || method === 'asset.list')
        return Promise.resolve([]);
      if (method === 'scene.list') {
        return Promise.resolve([
          {
            id: 'scene',
            projectId: 'project',
            title: '场次一',
            position: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      }
      if (method === 'shot.list') return Promise.resolve([]);
      if (method === 'llm.status') {
        return Promise.resolve({ provider: 'OpenAI', model: 'test', configured: false });
      }
      if (method === 'adapter.catalog') {
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      }
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'conversation.list') {
        return (params as { scopeType: string }).scopeType === 'project'
          ? projectConversations
          : Promise.resolve([sceneConversation]);
      }
      if (method === 'chat.message.list') {
        const conversationId = (params as { conversationId: string }).conversationId;
        return Promise.resolve({
          items: [
            {
              id: `${conversationId}-message`,
              conversationId,
              role: 'assistant',
              content: conversationId === sceneConversation.id ? '当前场次消息' : '过期项目消息',
              status: 'complete',
              createdAt: 'now',
            },
          ],
        });
      }
      if (method === 'context.preview') {
        const conversationId = (params as { conversationId: string }).conversationId;
        return Promise.resolve({
          version: 1,
          scopeType: conversationId === sceneConversation.id ? 'scene' : 'project',
          scopeId: conversationId === sceneConversation.id ? 'scene' : undefined,
          scopeLabel: 'scope',
          estimatedTokens: 1,
          budgetTokens: 1_000,
          sources: [],
        });
      }
      throw new Error(`Unexpected method ${method}`);
    });
    render(<App />);
    await waitFor(() => expect(callWorker).toHaveBeenCalledWith('shot.list', { sceneId: 'scene' }));

    fireEvent.click(screen.getByRole('button', { name: '场次' }));
    expect(await screen.findByText('当前场次消息')).toBeInTheDocument();

    await act(async () => {
      resolveProjectConversations([projectConversation]);
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByText('过期项目消息')).not.toBeInTheDocument());
    expect(screen.queryByRole('option', { name: '旧项目会话' })).not.toBeInTheDocument();
    expect(screen.getByRole('option', { name: '场次会话' })).toBeInTheDocument();
  });
});
