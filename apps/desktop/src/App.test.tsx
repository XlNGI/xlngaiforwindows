import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationInfo, LlmGenerationInfo } from '@ai-video/contracts';
import { App, mergeGenerationMessage } from './App';
import { callWorker } from './worker-client';
import { open as openDialog } from '@tauri-apps/plugin-dialog';

const windowApi = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  minimize: vi.fn().mockResolvedValue(undefined),
  onResized: vi.fn().mockResolvedValue(() => undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowApi,
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(),
}));

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
    vi.mocked(openDialog).mockResolvedValue(null);
    windowApi.isMaximized.mockResolvedValue(false);
    windowApi.onResized.mockResolvedValue(() => undefined);
  });

  it('renders the M2 workspace areas and runtime health', async () => {
    render(<App />);
    expect(screen.getByText('项目文档')).toBeInTheDocument();
    expect(screen.getByText('文档编辑器')).toBeInTheDocument();
    expect(screen.getByText('生产参数')).toBeInTheDocument();
    expect(screen.getByText('项目会话')).toBeInTheDocument();
    expect(await screen.findByText('本地服务正常')).toBeInTheDocument();
  });

  it('provides custom titlebar window controls', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '最小化窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '最大化窗口' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }));

    expect(windowApi.minimize).toHaveBeenCalledOnce();
    expect(windowApi.toggleMaximize).toHaveBeenCalledOnce();
    expect(windowApi.close).toHaveBeenCalledOnce();
  });

  it('disables project actions until an absolute path is entered', () => {
    render(<App />);
    const manager = screen.getByRole('region', { name: '项目管理' });
    expect(within(manager).getByRole('button', { name: '新建' })).toBeDisabled();
    expect(within(manager).getByRole('button', { name: '打开' })).toBeDisabled();
    expect(callWorker).not.toHaveBeenCalledWith('project.create', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith('project.open', expect.anything());
  });

  it('selects a project directory with the native folder dialog before opening', async () => {
    vi.mocked(openDialog).mockResolvedValue('D:\\Projects\\existing-project');
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: '选择项目目录' }));
    await waitFor(() =>
      expect(screen.getByLabelText('项目绝对目录')).toHaveValue(
        'D:\\Projects\\existing-project',
      ),
    );
    expect(openDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择项目目录',
    });

    const manager = screen.getByRole('region', { name: '项目管理' });
    fireEvent.click(within(manager).getByRole('button', { name: '打开' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('project.open', {
        rootPath: 'D:\\Projects\\existing-project',
      }),
    );
  });

  it('expands production UI across the central workspace when a production mode is selected', () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '文生图' }));

    expect(container.querySelector('.app-shell')).toHaveAttribute(
      'data-navigation-mode',
      'production',
    );
    expect(container.querySelector('.production-panel')).toHaveClass('expanded');

    fireEvent.click(screen.getByRole('button', { name: /项目文档/ }));
    expect(container.querySelector('.app-shell')).toHaveAttribute('data-navigation-mode', 'project');
    expect(container.querySelector('.production-panel')).not.toHaveClass('expanded');
  });

  it('offers a sample project on first use and sends the selected absolute path', async () => {
    render(<App />);
    const sampleButton = await screen.findByRole('button', { name: '创建示例项目' });
    expect(sampleButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText('项目绝对目录'), {
      target: { value: 'D:\\Projects\\sample-drama' },
    });
    fireEvent.click(sampleButton);

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('project.createSample', {
        rootPath: 'D:\\Projects\\sample-drama',
        name: '我的短剧',
      }),
    );
  });

  it('opens the settings center with restore controls when no project is open', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '设置中心' }));

    expect(await screen.findByRole('dialog', { name: '项目维护' })).toBeInTheDocument();
    expect(screen.getByText('从 SQLite 备份恢复')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '恢复并打开项目' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '供应商与模型' }));
    expect(await screen.findByRole('button', { name: /添加第一个供应商/ })).toBeInTheDocument();
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
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      }
      if (method === 'adapter.catalog') {
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      }
      if (method === 'provider.profile.list') return Promise.resolve([]);
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

  it('ignores an in-flight generation poll after switching conversations', async () => {
    const conversationA: ConversationInfo = {
      id: 'conversation-a',
      projectId: 'project',
      scopeType: 'project',
      title: '会话 A',
      createdAt: 'now',
      updatedAt: 'now',
    };
    const conversationB: ConversationInfo = {
      ...conversationA,
      id: 'conversation-b',
      title: '会话 B',
    };
    const streaming: LlmGenerationInfo = {
      generationId: 'generation-a',
      conversationId: conversationA.id,
      snapshotId: 'snapshot-a',
      status: 'streaming',
      userMessage: {
        id: 'user-a',
        conversationId: conversationA.id,
        role: 'user',
        content: '生成内容',
        status: 'complete',
        createdAt: 'now',
      },
      assistantMessage: {
        id: 'assistant-a',
        conversationId: conversationA.id,
        replyToMessageId: 'user-a',
        role: 'assistant',
        content: '旧生成增量',
        status: 'streaming',
        createdAt: 'now',
      },
      sources: [],
    };
    const cancelled: LlmGenerationInfo = {
      ...streaming,
      status: 'cancelled',
      assistantMessage: { ...streaming.assistantMessage, status: 'failed' },
      error: 'Generation was cancelled.',
    };
    let resolveStalePoll!: (value: LlmGenerationInfo) => void;
    const stalePoll = new Promise<LlmGenerationInfo>((resolve) => {
      resolveStalePoll = resolve;
    });

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
          name: 'Poll Race Project',
          rootPath: 'D:\\PollRace',
          createdAt: 'now',
          updatedAt: 'now',
          mode: 'read-write',
          schemaVersion: 5,
        });
      }
      if (
        method === 'project.recent' ||
        method === 'document.list' ||
        method === 'scene.list' ||
        method === 'asset.list' ||
        method === 'video.generate.list'
      ) {
        return Promise.resolve([]);
      }
      if (method === 'adapter.catalog') {
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      }
      if (method === 'provider.profile.list') return Promise.resolve([]);
      if (method === 'llm.status') {
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: true,
          configurationSource: 'environment',
        });
      }
      if (method === 'conversation.list') return Promise.resolve([conversationA, conversationB]);
      if (method === 'chat.message.list') {
        const conversationId = (params as { conversationId: string }).conversationId;
        return Promise.resolve({
          items:
            conversationId === conversationB.id
              ? [
                  {
                    id: 'message-b',
                    conversationId: conversationB.id,
                    role: 'assistant' as const,
                    content: '会话 B 当前消息',
                    status: 'complete' as const,
                    createdAt: 'now',
                  },
                ]
              : [],
        });
      }
      if (method === 'context.preview') {
        return Promise.resolve({
          version: 1,
          scopeType: 'project',
          scopeLabel: 'project',
          estimatedTokens: 1,
          budgetTokens: 1_000,
          sources: [],
        });
      }
      if (method === 'llm.generate') return Promise.resolve(streaming);
      if (method === 'llm.generation.get') return stalePoll;
      if (method === 'llm.generation.cancel') return Promise.resolve(cancelled);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<App />);
    const conversationSelect = await screen.findByDisplayValue('会话 A');
    fireEvent.change(screen.getByLabelText('会话消息'), { target: { value: '生成内容' } });
    fireEvent.click(screen.getByTitle('发送消息'));
    expect(await screen.findByTitle('停止生成')).toBeInTheDocument();
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'llm.generation.get'),
      ).toHaveLength(1),
    );

    fireEvent.change(conversationSelect, { target: { value: conversationB.id } });
    expect(await screen.findByText('会话 B 当前消息')).toBeInTheDocument();
    expect(screen.getByTitle('发送消息')).toBeInTheDocument();

    await act(async () => {
      resolveStalePoll(streaming);
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(screen.queryByTitle('停止生成')).not.toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'llm.generation.get'),
    ).toHaveLength(1);
  });
});
