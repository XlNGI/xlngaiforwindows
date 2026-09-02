import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationInfo, LlmGenerationInfo } from '@ai-video/contracts';
import {
  App,
  buildAgentAttachments,
  collectReferenceImageInputs,
  composeImageGenerationPrompt,
  inferAgentCapability,
  mergeGenerationMessage,
  normalizeImageDataUrl,
  resolveAgentRunModelSelection,
} from './App';
import { callWorker } from './worker-client';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readMarkdownDocument } from './markdown-import-client';

const windowApi = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  minimize: vi.fn().mockResolvedValue(undefined),
  onResized: vi.fn().mockResolvedValue(() => undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
}));

describe('inferAgentCapability', () => {
  it('treats prompt rewriting about video as a text Agent task', () => {
    expect(inferAgentCapability('把这个视频改写为 AI 视频生成提示词')).toBe('document');
    expect(inferAgentCapability('分析附件中的运镜并总结')).toBe('document');
  });

  it('reserves media capabilities for explicit generation actions', () => {
    expect(inferAgentCapability('生成一个视频')).toBe('video');
    expect(inferAgentCapability('生成一张角色图')).toBe('image');
    expect(inferAgentCapability('能直接帮我生成角色三视图吗？')).toBe('image');
    expect(inferAgentCapability('生成角色三视图提示词')).toBe('document');
  });
});

describe('resolveAgentRunModelSelection', () => {
  const agentModel = { providerProfileId: 'agent-profile', modelId: 'agent-model' };
  const mediaModel = { providerProfileId: 'media-profile', modelId: 'media-model' };

  it('does not use the selected Agent model for media generation', () => {
    expect(
      resolveAgentRunModelSelection('video', undefined, undefined, agentModel),
    ).toBeUndefined();
    expect(
      resolveAgentRunModelSelection('image', undefined, undefined, agentModel),
    ).toBeUndefined();
  });

  it('uses an explicitly selected or remembered media model', () => {
    expect(resolveAgentRunModelSelection('video', mediaModel, undefined, agentModel)).toEqual(
      mediaModel,
    );
    expect(resolveAgentRunModelSelection('image', undefined, mediaModel, agentModel)).toEqual(
      mediaModel,
    );
  });

  it('uses the selected Agent model for non-media work', () => {
    expect(resolveAgentRunModelSelection('text', undefined, undefined, agentModel)).toEqual(
      agentModel,
    );
    expect(resolveAgentRunModelSelection('text', undefined, mediaModel, agentModel)).toEqual(
      agentModel,
    );
  });
});

describe('composeImageGenerationPrompt', () => {
  it('carries the generated prompt document into direct image requests', () => {
    const result = composeImageGenerationPrompt('直接生成角色三视图', {
      title: '角色三视图提示词',
      content: '正面、左侧面、背面并列展示；服装和发型保持一致。',
    });
    expect(result).toContain('直接生成角色三视图');
    expect(result).toContain('角色三视图提示词');
    expect(result).toContain('服装和发型保持一致');
  });

  it('keeps adapter prompts within the provider schema limit', () => {
    const result = composeImageGenerationPrompt('生成角色图', {
      title: '长文档',
      content: 'x'.repeat(10_000),
    });
    expect(result.length).toBeLessThanOrEqual(5_000);
  });
});

describe('buildAgentAttachments', () => {
  it('sends a bounded video first frame instead of the full video data URL', () => {
    const attachments = buildAgentAttachments([
      {
        id: 'video-1',
        name: 'result.mp4',
        mimeType: 'video/mp4',
        size: 8_000_000,
        kind: 'video',
        dataUrl: `data:video/mp4;base64,${'x'.repeat(3_000_000)}`,
        previewDataUrl: 'data:image/jpeg;base64,preview',
      },
    ]);
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).not.toHaveProperty('dataUrl');
    expect(attachments[1]).toMatchObject({
      mimeType: 'image/jpeg',
      dataUrl: 'data:image/jpeg;base64,preview',
    });
  });
});

describe('collectReferenceImageInputs', () => {
  it('uses uploaded images and video first-frame previews for image adapters', () => {
    expect(
      collectReferenceImageInputs([
        {
          id: 'image-1',
          name: 'character.png',
          mimeType: 'image/png',
          size: 100,
          kind: 'image',
          dataUrl: 'data:image/png;base64,image',
        },
        {
          id: 'video-1',
          name: 'result.mp4',
          mimeType: 'video/mp4',
          size: 200,
          kind: 'video',
          dataUrl: 'data:video/mp4;base64,video',
          previewDataUrl: 'data:image/jpeg;base64,preview',
        },
      ]),
    ).toEqual(['data:image/png;base64,image', 'data:image/jpeg;base64,preview']);
  });
});

describe('normalizeImageDataUrl', () => {
  it('normalizes headers and removes whitespace from base64 payloads', () => {
    expect(normalizeImageDataUrl(' DATA:IMAGE/PNG;BASE64, iVBORw0KGgo=\n ')).toBe(
      'data:image/png;base64,iVBORw0KGgo=',
    );
  });

  it('rejects non-image or malformed data URLs', () => {
    expect(normalizeImageDataUrl('https://example.com/image.png')).toBeUndefined();
    expect(normalizeImageDataUrl('data:image/png;base64,not valid!')).toBeUndefined();
  });
});

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => windowApi,
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => undefined),
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

vi.mock('./markdown-import-client', () => ({
  readMarkdownDocument: vi.fn(),
}));

describe('App', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.mocked(callWorker).mockImplementation((method: string) =>
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
    );
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
    vi.mocked(openDialog).mockResolvedValue(null);
    windowApi.isMaximized.mockResolvedValue(false);
    windowApi.onResized.mockResolvedValue(() => undefined);
  });

  it('renders the M2 workspace areas and runtime health', async () => {
    render(<App />);
    expect(screen.getByText('项目文档')).toBeInTheDocument();
    expect(screen.getByText('文档编辑器')).toBeInTheDocument();
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
      expect(screen.getByLabelText('项目绝对目录')).toHaveValue('D:\\Projects\\existing-project'),
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

  it('imports a selected Markdown file as a versioned project document', async () => {
    const project = {
      id: 'project',
      name: 'Imported Novel',
      rootPath: 'D:\\Projects\\imported-novel',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 7,
    };
    const saved = {
      id: 'document-imported',
      projectId: project.id,
      kind: 'note' as const,
      title: '第一章',
      scopeType: 'project' as const,
      currentVersionId: 'version-1',
      publishedVersionId: undefined,
      lifecycleStatus: 'active' as const,
      rowVersion: 1,
      createdAt: 'now',
      updatedAt: 'now',
      currentVersion: {
        id: 'version-1',
        documentId: 'document-imported',
        version: 1,
        contentMarkdown: '# 第一章\n\n故事开始。',
        state: 'draft' as const,
        authorType: 'import' as const,
        createdAt: 'now',
      },
    };
    vi.mocked(openDialog).mockResolvedValue('D:\\Novels\\第一章.md');
    vi.mocked(readMarkdownDocument).mockResolvedValue({
      title: '第一章',
      contentMarkdown: '# 第一章\n\n故事开始。',
    });
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'health')
        return Promise.resolve({
          protocolVersion: 1,
          workerVersion: '0.1.0',
          nodeVersion: 'v22.0.0',
          platform: 'win32',
          arch: 'x64',
          pid: 123,
        });
      if (method === 'sqlite.probe')
        return Promise.resolve({
          databasePath: 'probe.sqlite',
          sqliteVersion: '3.50.0',
          journalMode: 'wal',
          writeVerified: true,
        });
      if (method === 'project.current') return Promise.resolve(project);
      if (method === 'conversation.list') return Promise.resolve({ items: [] });
      if (
        method === 'project.recent' ||
        method === 'document.list' ||
        method === 'scene.list' ||
        method === 'asset.list' ||
        method === 'video.generate.list' ||
        method === 'provider.profile.list'
      )
        return Promise.resolve([]);
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'document.draft.save') return Promise.resolve(saved);
      if (method === 'document.versions') return Promise.resolve([saved.currentVersion]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '导入 Markdown' }));

    await waitFor(() =>
      expect(openDialog).toHaveBeenCalledWith({
        directory: false,
        multiple: false,
        title: '导入 Markdown 文档',
        filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
      }),
    );
    expect(readMarkdownDocument).toHaveBeenCalledWith('D:\\Novels\\第一章.md');
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('document.draft.save', {
        title: '第一章',
        contentMarkdown: '# 第一章\n\n故事开始。',
        authorType: 'import',
      }),
    );
    expect(await screen.findByDisplayValue('第一章')).toBeInTheDocument();
    expect(screen.getByLabelText('文档内容')).toHaveValue('# 第一章\n\n故事开始。');
    expect(screen.getByText('已导入为草稿 第一章 · 版本 v1')).toBeInTheDocument();
  });

  it('expands production UI across the central workspace when a production mode is selected', () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '文生图' }));

    expect(container.querySelector('.app-shell')).toHaveAttribute(
      'data-navigation-mode',
      'production',
    );
    expect(container.querySelector('.production-panel')).toHaveClass('expanded');

    fireEvent.click(screen.getByRole('button', { name: '关闭生产参数' }));
    expect(container.querySelector('.app-shell')).toHaveAttribute(
      'data-navigation-mode',
      'project',
    );
    expect(container.querySelector('.production-panel')).not.toBeInTheDocument();
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
      if (
        method === 'project.recent' ||
        method === 'document.list' ||
        method === 'asset.list' ||
        method === 'constraint.list'
      )
        return Promise.resolve([]);
      if (method === 'scene.list') {
        return Promise.resolve([
          {
            id: 'scene',
            projectId: 'project',
            title: '场次一',
            position: 0,
            rowVersion: 0,
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
          ? projectConversations.then((items) => ({ items }))
          : Promise.resolve({ items: [sceneConversation] });
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
      if (method === 'conversation.list')
        return Promise.resolve({ items: [conversationA, conversationB] });
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

  it('starts an explicit document draft agent and refreshes documents when it completes', async () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: 'Project conversation',
      createdAt: 'now',
      updatedAt: 'now',
    };
    const profile = {
      id: 'profile',
      name: 'OpenAI',
      category: 'llm' as const,
      providerType: 'openai',
      accessType: 'official' as const,
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      enabled: true,
      connectionStatus: 'ready' as const,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const model = {
      id: 'model',
      providerProfileId: profile.id,
      remoteModelId: 'gpt-test',
      displayName: 'GPT Test',
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
      source: 'manual' as const,
      enabled: true,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const prepared = {
      agentTaskId: 'agent-task',
      stream: {
        generationId: 'generation',
        attemptId: 'attempt',
        projectId: 'project',
        projectSessionId: 'session',
        conversationId: conversation.id,
      },
      generation: {
        generationId: 'generation',
        attemptId: 'attempt',
        projectId: 'project',
        projectSessionId: 'session',
        conversationId: conversation.id,
        snapshotId: 'snapshot',
        status: 'complete' as const,
        userMessage: {
          id: 'user',
          conversationId: conversation.id,
          role: 'user' as const,
          content: 'Draft a project brief',
          status: 'complete' as const,
          createdAt: 'now',
        },
        assistantMessage: {
          id: 'assistant',
          conversationId: conversation.id,
          replyToMessageId: 'user',
          role: 'assistant' as const,
          content: '',
          status: 'complete' as const,
          createdAt: 'now',
        },
        sources: [],
      },
    };
    const createdDocument = {
      id: 'document-created-by-agent',
      projectId: 'project',
      kind: 'note' as const,
      title: 'Agent 人工验收样本',
      scopeType: 'project' as const,
      currentVersionId: 'version-created-by-agent',
      publishedVersionId: undefined,
      lifecycleStatus: 'active' as const,
      rowVersion: 1,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const createdDocumentDetail = {
      ...createdDocument,
      currentVersion: {
        id: 'version-created-by-agent',
        documentId: createdDocument.id,
        version: 1,
        contentMarkdown: 'Agent 桌面人工测试成功',
        state: 'draft' as const,
        authorType: 'agent' as const,
        sourceTaskId: 'agent-task',
        createdAt: 'now',
      },
    };
    let documentListCalls = 0;

    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'health')
        return Promise.resolve({
          protocolVersion: 1,
          workerVersion: '0.1.0',
          nodeVersion: 'v22.0.0',
          platform: 'win32',
          arch: 'x64',
          pid: 123,
        });
      if (method === 'sqlite.probe')
        return Promise.resolve({
          databasePath: 'probe.sqlite',
          sqliteVersion: '3.50.0',
          journalMode: 'wal',
          writeVerified: true,
        });
      if (method === 'project.current')
        return Promise.resolve({
          id: 'project',
          name: 'Agent Project',
          rootPath: 'D:\\AgentProject',
          createdAt: 'now',
          updatedAt: 'now',
          mode: 'read-write' as const,
          schemaVersion: 14,
        });
      if (method === 'document.list') {
        documentListCalls += 1;
        return Promise.resolve(documentListCalls === 1 ? [] : [createdDocument]);
      }
      if (method === 'document.get') return Promise.resolve(createdDocumentDetail);
      if (method === 'document.versions')
        return Promise.resolve([createdDocumentDetail.currentVersion]);
      if (method === 'project.recent' || method === 'scene.list') return Promise.resolve([]);
      if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'GPT Test',
          configured: true,
          configurationSource: 'managed' as const,
        });
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'conversation.list') return Promise.resolve({ items: [conversation] });
      if (method === 'chat.message.list') return Promise.resolve({ items: [] });
      if (method === 'context.preview')
        return Promise.resolve({
          version: 1,
          scopeType: 'project' as const,
          scopeLabel: 'project',
          estimatedTokens: 1,
          budgetTokens: 1_000,
          sources: [],
        });
      if (method === 'agent.generation.prepare') return Promise.resolve(prepared);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<App />);
    await screen.findByDisplayValue('Project conversation');
    fireEvent.change(screen.getByLabelText('会话消息'), {
      target: { value: 'Draft a project brief' },
    });
    fireEvent.click(screen.getByTitle('创建文档草稿'));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('agent.generation.prepare', {
        conversationId: conversation.id,
        prompt: 'Draft a project brief',
        providerProfileId: profile.id,
        modelId: model.id,
        agentMode: 'document',
        researchMode: 'auto',
        documentIntent: { operation: 'document.create_draft' },
      }),
    );
    expect((await screen.findAllByText(createdDocument.title)).length).toBeGreaterThan(0);
    expect(await screen.findByDisplayValue(createdDocument.title)).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Agent 桌面人工测试成功')).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'document.list'),
    ).toHaveLength(2);
  });

  it('shows only outline/plan documents plus constraints on the project documents page', async () => {
    vi.mocked(callWorker).mockImplementation((method: string) => {
      if (method === 'health')
        return Promise.resolve({
          protocolVersion: 1,
          workerVersion: '0.1.0',
          nodeVersion: 'v22.0.0',
          platform: 'win32',
          arch: 'x64',
          pid: 123,
        });
      if (method === 'sqlite.probe')
        return Promise.resolve({
          databasePath: 'probe.sqlite',
          sqliteVersion: '3.50.0',
          journalMode: 'wal',
          writeVerified: true,
        });
      if (method === 'project.current')
        return Promise.resolve({
          id: 'project',
          name: 'Filter Project',
          rootPath: 'D:\\Filter',
          createdAt: 'now',
          updatedAt: 'now',
          mode: 'read-write',
          schemaVersion: 4,
        });
      if (method === 'project.recent') return Promise.resolve([]);
      if (method === 'document.list')
        return Promise.resolve([
          {
            id: 'd-outline',
            projectId: 'project',
            kind: 'outline',
            title: '项目大纲',
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
          {
            id: 'd-plan',
            projectId: 'project',
            kind: 'plan',
            title: '项目计划',
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
          {
            id: 'd-note',
            projectId: 'project',
            kind: 'note',
            title: '小说章节一',
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
          {
            id: 'd-character',
            projectId: 'project',
            kind: 'character',
            title: '角色设定',
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
          {
            id: 'd-scene',
            projectId: 'project',
            kind: 'scene',
            title: '场景设定',
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
          {
            id: 'd-storyboard',
            projectId: 'project',
            kind: 'storyboard',
            title: '第一集分镜',
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (method === 'scene.list') return Promise.resolve([]);
      if (method === 'asset.list') return Promise.resolve([]);
      if (method === 'constraint.list')
        return Promise.resolve([
          {
            id: 'c-1',
            projectId: 'project',
            scopeType: 'project',
            kind: 'production',
            content: '所有镜头保持冷色调',
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'provider.profile.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'agent.changeSet.list') return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    render(<App />);
    expect(await screen.findByText('项目大纲')).toBeInTheDocument();
    expect(screen.getByText('项目计划')).toBeInTheDocument();
    expect(screen.queryByText('小说章节一')).not.toBeInTheDocument();
    expect(screen.queryByText('角色设定')).not.toBeInTheDocument();
    expect(screen.queryByText('场景设定')).not.toBeInTheDocument();
    expect(screen.queryByText('第一集分镜')).not.toBeInTheDocument();
    expect(screen.getByText('所有镜头保持冷色调')).toBeInTheDocument();
  });

  it('shows and saves the shot storyboard document in the shot workspace', async () => {
    vi.mocked(callWorker).mockImplementation((method: string, params?: unknown) => {
      if (method === 'health')
        return Promise.resolve({
          protocolVersion: 1,
          workerVersion: '0.1.0',
          nodeVersion: 'v22.0.0',
          platform: 'win32',
          arch: 'x64',
          pid: 123,
        });
      if (method === 'sqlite.probe')
        return Promise.resolve({
          databasePath: 'probe.sqlite',
          sqliteVersion: '3.50.0',
          journalMode: 'wal',
          writeVerified: true,
        });
      if (method === 'project.current')
        return Promise.resolve({
          id: 'project',
          name: 'Storyboard Project',
          rootPath: 'D:\\Storyboard',
          createdAt: 'now',
          updatedAt: 'now',
          mode: 'read-write',
          schemaVersion: 4,
        });
      if (
        method === 'project.recent' ||
        method === 'document.list' ||
        method === 'asset.list' ||
        method === 'constraint.list'
      )
        return Promise.resolve([]);
      if (method === 'scene.list')
        return Promise.resolve([
          {
            id: 'scene',
            projectId: 'project',
            title: '场次一',
            position: 0,
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (method === 'shot.list')
        return Promise.resolve([
          {
            id: 'shot',
            sceneId: 'scene',
            title: '镜头一',
            position: 0,
            status: 'draft',
            documentId: 'sb-1',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (method === 'document.get')
        return Promise.resolve({
          id: 'sb-1',
          projectId: 'project',
          kind: 'storyboard',
          title: '镜头一分镜',
          scopeType: 'shot',
          scopeId: 'shot',
          lifecycleStatus: 'active',
          rowVersion: 0,
          currentVersionId: 'v1',
          currentVersion: {
            id: 'v1',
            documentId: 'sb-1',
            version: 1,
            contentMarkdown: '# 分镜\n\n1. 远景。',
            state: 'draft',
            authorType: 'user',
            createdAt: 'now',
          },
          createdAt: 'now',
          updatedAt: 'now',
        });
      if (method === 'shot.storyboard.save') {
        const title = (params as { title: string }).title;
        const contentMarkdown = (params as { contentMarkdown: string }).contentMarkdown;
        return Promise.resolve({
          id: 'sb-1',
          projectId: 'project',
          kind: 'storyboard',
          title,
          scopeType: 'shot',
          scopeId: 'shot',
          lifecycleStatus: 'active',
          rowVersion: 1,
          currentVersionId: 'v2',
          currentVersion: {
            id: 'v2',
            documentId: 'sb-1',
            version: 2,
            contentMarkdown,
            state: 'draft',
            authorType: 'user',
            createdAt: 'now',
          },
          createdAt: 'now',
          updatedAt: 'now',
        });
      }
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'provider.profile.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'agent.changeSet.list') return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /场次与镜头/ }));
    fireEvent.click(await screen.findByRole('button', { name: /镜头一/ }));
    expect(await screen.findByLabelText('分镜标题')).toHaveValue('镜头一分镜');
    expect(screen.getByLabelText('分镜内容')).toHaveValue('# 分镜\n\n1. 远景。');

    fireEvent.change(screen.getByLabelText('分镜内容'), {
      target: { value: '# 分镜\n\n2. 中景。' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存分镜/ }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('shot.storyboard.save', {
        shotId: 'shot',
        title: '镜头一分镜',
        contentMarkdown: '# 分镜\n\n2. 中景。',
      }),
    );
  });
});
