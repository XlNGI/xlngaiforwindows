import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterDescriptor,
  AgentTaskDetail,
  ConversationInfo,
  LlmGenerationInfo,
} from '@ai-video/contracts';
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
    expect(inferAgentCapability('帮我生成龙在天空翱翔的视频')).toBe('video');
    expect(inferAgentCapability('生成一张角色图')).toBe('image');
    expect(inferAgentCapability('能直接帮我生成角色三视图吗？')).toBe('image');
    expect(inferAgentCapability('生成角色三视图提示词')).toBe('document');
  });
});

describe('resolveAgentRunModelSelection', () => {
  const agentModel = { providerProfileId: 'agent-profile', modelId: 'agent-model' };
  const rememberedAgentModel = {
    providerProfileId: 'remembered-profile',
    modelId: 'remembered-model',
  };

  it('uses the selected conversation Agent model for every capability hint', () => {
    expect(resolveAgentRunModelSelection('video', undefined, undefined, agentModel)).toEqual(
      agentModel,
    );
    expect(resolveAgentRunModelSelection('image', undefined, undefined, agentModel)).toEqual(
      agentModel,
    );
  });

  it('prefers an explicit Agent selection and otherwise restores the conversation preference', () => {
    expect(
      resolveAgentRunModelSelection('video', rememberedAgentModel, undefined, agentModel),
    ).toEqual(rememberedAgentModel);
    expect(resolveAgentRunModelSelection('image', undefined, rememberedAgentModel)).toEqual(
      rememberedAgentModel,
    );
  });

  it('does not let an older remembered preference replace the active Agent model', () => {
    expect(resolveAgentRunModelSelection('text', undefined, undefined, agentModel)).toEqual(
      agentModel,
    );
    expect(
      resolveAgentRunModelSelection('text', undefined, rememberedAgentModel, agentModel),
    ).toEqual(agentModel);
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
  /** Model/provider selects live behind the collapsed summary row. */
  function selectLlm(profileId: string, modelId: string): void {
    fireEvent.click(screen.getByRole('button', { name: '模型与供应商设置' }));
    fireEvent.change(screen.getByLabelText('LLM 供应商连接'), { target: { value: profileId } });
    fireEvent.change(screen.getByLabelText('LLM 模型'), { target: { value: modelId } });
  }

  function mockComposerSend(
    sendMethod: 'agent.run' | 'llm.generate' | 'chat.message.save',
    response: Promise<unknown>,
  ) {
    const baselineWorker = vi.mocked(callWorker).getMockImplementation()!;
    const conversation: ConversationInfo = {
      id: 'composer-conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '输入草稿',
      createdAt: 'now',
      updatedAt: 'now',
    };
    const profile = {
      id: 'composer-profile',
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
      id: 'composer-model',
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
    vi.mocked(callWorker).mockImplementation(((method: string, params: unknown) => {
      if (method === sendMethod) return response;
      if (method === 'project.current')
        return Promise.resolve({
          id: 'project',
          name: 'Composer Project',
          rootPath: 'D:\\Composer',
          createdAt: 'now',
          updatedAt: 'now',
          mode: 'read-write',
          schemaVersion: 5,
        });
      if (
        [
          'document.list',
          'scene.list',
          'constraint.list',
          'asset.list',
          'video.generate.list',
          'novel.chapter.list',
          'characterVoice.list',
        ].includes(method)
      )
        return Promise.resolve([]);
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'GPT Test',
          configured: sendMethod !== 'chat.message.save',
          configurationSource: sendMethod === 'agent.run' ? 'managed' : 'environment',
        });
      if (method === 'provider.profile.list')
        return Promise.resolve(sendMethod === 'agent.run' ? [profile] : []);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'conversation.list') return Promise.resolve({ items: [conversation] });
      if (method === 'chat.message.list') return Promise.resolve({ items: [] });
      if (method === 'context.preview')
        return Promise.resolve({
          version: 1,
          scopeType: 'project',
          scopeLabel: 'project',
          estimatedTokens: 1,
          budgetTokens: 1_000,
          sources: [],
        });
      return baselineWorker(method as never, params as never);
    }) as typeof callWorker);
    const generation: LlmGenerationInfo = {
      generationId: 'composer-generation',
      conversationId: conversation.id,
      snapshotId: 'composer-snapshot',
      status: 'complete',
      userMessage: {
        id: 'composer-user',
        conversationId: conversation.id,
        role: 'user',
        content: '发送中的原始草稿',
        status: 'complete',
        createdAt: 'now',
      },
      assistantMessage: {
        id: 'composer-assistant',
        conversationId: conversation.id,
        role: 'assistant',
        content: '已接受请求',
        status: 'complete',
        createdAt: 'now',
      },
      sources: [],
    };
    return sendMethod === 'chat.message.save'
      ? generation.userMessage
      : sendMethod === 'llm.generate'
        ? generation
        : {
            status: 'started',
            capability: 'text',
            generation,
            stream: { projectId: conversation.projectId },
          };
  }

  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    window.localStorage.clear();
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
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  });

  it.each([
    ['agent.run', false],
    ['agent.run', true],
    ['llm.generate', false],
    ['llm.generate', true],
    ['chat.message.save', false],
    ['chat.message.save', true],
  ] as const)(
    'preserves the composer after delayed %s failure (new draft: %s)',
    async (method, edit) => {
      let rejectRequest!: (reason: Error) => void;
      const response = new Promise<unknown>((_resolve, reject) => {
        rejectRequest = reject;
      });
      mockComposerSend(method, response);
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      if (method === 'agent.run') selectLlm('composer-profile', 'composer-model');
      const composer = screen.getByRole('textbox', { name: '会话消息' });
      fireEvent.change(composer, { target: { value: '发送中的原始草稿' } });
      fireEvent.click(screen.getByTitle('发送消息'));
      await waitFor(() => expect(callWorker).toHaveBeenCalledWith(method, expect.anything()));
      expect(composer).toHaveValue('发送中的原始草稿');
      fireEvent.click(screen.getByTitle('发送消息'));
      expect(vi.mocked(callWorker).mock.calls.filter(([name]) => name === method)).toHaveLength(1);
      if (edit) fireEvent.change(composer, { target: { value: '等待期间编辑的新草稿' } });

      await act(async () => {
        rejectRequest(new Error('请求暂时不可用'));
        await response.catch(() => undefined);
      });

      expect(await screen.findByText('请求暂时不可用')).toBeInTheDocument();
      expect(composer).toHaveValue(edit ? '等待期间编辑的新草稿' : '发送中的原始草稿');
    },
  );

  it.each([
    ['agent.run', false],
    ['agent.run', true],
    ['llm.generate', false],
    ['llm.generate', true],
    ['chat.message.save', false],
    ['chat.message.save', true],
  ] as const)(
    'clears only the accepted draft after delayed %s success (new draft: %s)',
    async (method, edit) => {
      let resolveRequest!: (value: unknown) => void;
      const response = new Promise<unknown>((resolve) => {
        resolveRequest = resolve;
      });
      const accepted = mockComposerSend(method, response);
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      if (method === 'agent.run') selectLlm('composer-profile', 'composer-model');
      const composer = screen.getByRole('textbox', { name: '会话消息' });
      fireEvent.change(composer, { target: { value: '发送中的原始草稿' } });
      fireEvent.click(screen.getByTitle('发送消息'));
      await waitFor(() => expect(callWorker).toHaveBeenCalledWith(method, expect.anything()));
      expect(composer).toHaveValue('发送中的原始草稿');
      if (edit) fireEvent.change(composer, { target: { value: '等待期间编辑的新草稿' } });

      await act(async () => {
        resolveRequest(accepted);
        await response;
      });

      await waitFor(() => expect(composer).toHaveValue(edit ? '等待期间编辑的新草稿' : ''));
      expect(screen.getByText('发送中的原始草稿')).toBeInTheDocument();
    },
  );

  it.each([false, true])(
    'clears only the original draft after submitting attachment parameters (new draft: %s)',
    async (edit) => {
      let resolveRequest!: (value: unknown) => void;
      const response = new Promise<unknown>((resolve) => {
        resolveRequest = resolve;
      });
      const accepted = mockComposerSend('agent.run', response);
      const baselineWorker = vi.mocked(callWorker).getMockImplementation()!;
      let runs = 0;
      const adapter: AdapterDescriptor = {
        key: 'TEXT_TO_IMAGE:test:v1',
        capability: 'TEXT_TO_IMAGE',
        capabilityLabel: '文生图',
        provider: 'test',
        providerLabel: 'Test',
        model: 'test',
        modelLabel: 'Test',
        apiVersion: 'v1',
        schemaVersion: 1,
        endpoint: 'https://example.com/generate',
        documentationUrl: 'https://example.com/docs',
        credentialProvider: 'test',
        parameterSchema: {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          type: 'object',
          additionalProperties: false,
          required: [],
          properties: {},
        },
        uiSchema: { fields: [] },
      };
      vi.mocked(callWorker).mockImplementation(((method: string, params: unknown) => {
        if (method === 'agent.run' && ++runs === 1)
          return Promise.resolve({
            status: 'needs_parameters',
            capability: 'image',
            providerProfileId: 'composer-profile',
            modelId: 'composer-model',
            modelName: 'Test Image',
            adapters: [adapter],
            affectsCost: false,
          });
        return baselineWorker(method as never, params as never);
      }) as typeof callWorker);
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      selectLlm('composer-profile', 'composer-model');
      const composer = screen.getByRole('textbox', { name: '会话消息' });
      fireEvent.change(composer, { target: { value: '发送中的原始草稿' } });
      fireEvent.change(document.querySelector('input[type="file"]')!, {
        target: { files: [new File(['reference'], '参考资料.bin')] },
      });
      await screen.findByText('参考资料.bin');
      fireEvent.click(screen.getByTitle('发送消息'));
      const parameters = await screen.findByRole('dialog', { name: '补充生成参数' });
      expect(composer).toHaveValue('发送中的原始草稿');
      fireEvent.click(within(parameters).getByRole('button', { name: '提交生成' }));
      await waitFor(() => expect(runs).toBe(2));
      const submitted = vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) => method === 'agent.run');
      expect(submitted[1]?.[1]).toHaveProperty('prompt');
      expect((submitted[1]?.[1] as { prompt: string }).prompt).toContain('[附件：参考资料.bin]');
      if (edit) fireEvent.change(composer, { target: { value: '等待期间编辑的新草稿' } });
      await act(async () => {
        resolveRequest(accepted);
        await response;
      });
      await waitFor(() => expect(composer).toHaveValue(edit ? '等待期间编辑的新草稿' : ''));
    },
  );

  it('renders the M2 workspace areas and runtime health', async () => {
    const { container } = render(<App />);
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    expect(within(projectNav).getByText('剧本')).toBeInTheDocument();
    expect(within(projectNav).getByText('角色与场景')).toBeInTheDocument();
    expect(within(projectNav).getByText('小说')).toBeInTheDocument();
    expect(screen.getByText('剧本编辑器')).toBeInTheDocument();
    expect(container.querySelector('[data-pane-id="editor"]')).toHaveTextContent('剧本');
    expect(container.querySelector('[data-pane-id="conversation"]')).toHaveTextContent('会话');
    expect(screen.getAllByText('项目 AI 助手').length).toBeGreaterThan(0);
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

  it('toggles the conversation window from the topbar', () => {
    const { container } = render(<App />);
    const topbarActions = container.querySelector('.topbar-actions');
    expect(topbarActions).not.toBeNull();
    const toggle = within(topbarActions as HTMLElement).getByRole('button', { name: '收起会话' });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('.workspace-conversation-page')).toBeInTheDocument();

    fireEvent.click(toggle);

    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
    expect(container.querySelector('.floating-window-conversation')).not.toBeInTheDocument();
    expect(
      within(topbarActions as HTMLElement).getByRole('button', { name: '打开会话' }),
    ).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(within(topbarActions as HTMLElement).getByRole('button', { name: '打开会话' }));

    expect(container.querySelector('.workspace-conversation-page')).toBeInTheDocument();
    expect(
      within(topbarActions as HTMLElement).getByRole('button', { name: '收起会话' }),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it.each([
    {
      nav: /^剧本/,
      heading: '剧本编辑器',
      close: '关闭文档面板',
    },
    {
      nav: /^角色与场景/,
      heading: '角色与场景',
      close: '关闭文档面板',
    },
    {
      nav: '小说',
      heading: '小说工作区',
      close: '关闭小说',
    },
    {
      nav: /场次与镜头/,
      heading: '镜头工作区',
      close: '关闭场次与镜头',
    },
    {
      nav: '任务日志',
      heading: '项目执行记录',
      close: '关闭任务日志',
    },
  ])(
    'closes the $heading page and reopens it from project navigation',
    ({ nav, heading, close }) => {
      const { container } = render(<App />);
      const projectNav = screen.getByRole('navigation', { name: '项目导航' });
      fireEvent.click(within(projectNav).getByRole('button', { name: nav }));
      const editorPage = () => container.querySelector('.workspace-editor-page');
      expect(editorPage()).toBeInTheDocument();
      expect(editorPage()).toHaveTextContent(heading);

      fireEvent.click(screen.getByLabelText(close));

      expect(editorPage()).not.toBeInTheDocument();
      expect(container.querySelector('.workspace-conversation-page')).toBeInTheDocument();

      fireEvent.click(within(projectNav).getByRole('button', { name: nav }));

      expect(editorPage()).toBeInTheDocument();
      expect(editorPage()).toHaveTextContent(heading);
    },
  );

  it('closes and reopens the asset library without replacing the project page', () => {
    const { container } = render(<App />);
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    const openAssets = () =>
      fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    const editorPage = container.querySelector('.workspace-editor-page');

    openAssets();

    expect(container.querySelector('.workspace-assets-page')).toHaveTextContent('请打开一个项目');
    expect(container.querySelector('.workspace-editor-page')).toBe(editorPage);
    expect(editorPage).toHaveTextContent('剧本编辑器');
    fireEvent.click(screen.getByLabelText('关闭素材库'));

    expect(container.querySelector('.workspace-assets-page')).not.toBeInTheDocument();
    expect(container.querySelector('.workspace-editor-page')).toBe(editorPage);
    expect(editorPage).toBeVisible();

    openAssets();

    expect(container.querySelector('.workspace-assets-page')).toBeVisible();
    expect(container.querySelector('.workspace-editor-page')).toBe(editorPage);
  });

  it.each(['小说', '剧本', '角色与场景', '场次与镜头', '任务日志'])(
    'keeps the asset library open beside the %s project page',
    (page) => {
      const { container } = render(<App />);
      const projectNav = screen.getByRole('navigation', { name: '项目导航' });
      const openPage = () =>
        fireEvent.click(within(projectNav).getByRole('button', { name: new RegExp(`^${page}`) }));

      openPage();
      const editorPage = container.querySelector('.workspace-editor-page');
      fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));

      expect(container.querySelector('.workspace-assets-page')).toBeVisible();
      expect(container.querySelector('.workspace-editor-page')).toBe(editorPage);
      expect(container.querySelector('[data-pane-id="editor"]')).toHaveTextContent(page);

      fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
      openPage();

      expect(container.querySelector('.workspace-assets-page')).toBeVisible();
      expect(container.querySelector('[data-pane-id="editor"]')).toHaveTextContent(page);
    },
  );

  it('clears asset filters and old assets when another project is opened', async () => {
    const baselineWorker = vi.mocked(callWorker).getMockImplementation()!;
    const firstProject = {
      id: 'asset-project-a',
      name: 'Asset Project A',
      rootPath: 'D:\\AssetProjectA',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 42,
    };
    const secondProject = {
      ...firstProject,
      id: 'asset-project-b',
      name: 'Asset Project B',
      rootPath: 'D:\\AssetProjectB',
    };
    let currentProject = firstProject;
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'project.current') return Promise.resolve(currentProject);
      if (method === 'project.open') {
        currentProject = secondProject;
        return Promise.resolve(currentProject);
      }
      if (method === 'asset.list')
        return Promise.resolve([
          {
            id: `${currentProject.id}-asset`,
            projectId: currentProject.id,
            kind: 'generated-image',
            alias: currentProject.id === firstProject.id ? '项目一素材' : '项目二素材',
            relativePath: 'assets/image.png',
            contentHash: currentProject.id,
            sizeBytes: 10,
            createdAt: '2026-10-13T00:00:00.000Z',
            tags: [],
          },
        ]);
      if (method === 'asset.mediaSource') return Promise.reject(new Error('No fixture media'));
      if (method === 'conversation.list' || method === 'task.log.list')
        return Promise.resolve({ items: [] });
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      if (
        [
          'project.recent',
          'document.list',
          'scene.list',
          'constraint.list',
          'tag.list',
          'assetGroup.list',
          'provider.profile.list',
          'characterVoice.list',
          'video.generate.list',
          'novel.chapter.list',
          'novel.volume.list',
        ].includes(method)
      )
        return Promise.resolve([]);
      return baselineWorker(method, params);
    });

    const { container } = render(<App />);
    await screen.findAllByText(firstProject.name);
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    expect(await screen.findByRole('option', { name: /项目一素材/ })).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('搜索别名、文件名或标签'), {
      target: { value: '项目一素材' },
    });
    fireEvent.change(screen.getByLabelText('素材类型'), { target: { value: 'image' } });
    vi.mocked(openDialog).mockResolvedValue(secondProject.rootPath);

    fireEvent.click(screen.getByTitle('打开项目'));
    await screen.findAllByText(secondProject.name);
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));

    await waitFor(() =>
      expect(screen.getByPlaceholderText('搜索别名、文件名或标签')).toHaveValue(''),
    );
    expect(screen.getByLabelText('素材类型')).toHaveValue('all');
    expect(await screen.findByRole('option', { name: /项目二素材/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /项目一素材/ })).not.toBeInTheDocument();
    expect(container.querySelector('.workspace-editor-page')).toBeVisible();
  });

  it('opens an auto-hidden conversation as a floating window from the topbar', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '文生图' }));

    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
    expect(container.querySelector('.floating-window-conversation')).not.toBeInTheDocument();
    const toggle = within(container.querySelector('.topbar-actions') as HTMLElement).getByRole(
      'button',
      { name: '打开会话' },
    );
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(container.querySelector('.floating-window-conversation')).toBeInTheDocument();
    expect(
      within(container.querySelector('.topbar-actions') as HTMLElement).getByRole('button', {
        name: '收起会话',
      }),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(
      within(container.querySelector('.topbar-actions') as HTMLElement).getByRole('button', {
        name: '收起会话',
      }),
    );
    expect(container.querySelector('.floating-window-conversation')).not.toBeInTheDocument();

    fireEvent.click(
      within(container.querySelector('.topbar-actions') as HTMLElement).getByRole('button', {
        name: '打开会话',
      }),
    );
    expect(container.querySelector('.floating-window-conversation')).toBeInTheDocument();
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
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
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

  it('keeps production open while switching the adjacent project page', () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: '文生图' }));
    fireEvent.click(
      within(screen.getByRole('navigation', { name: '项目导航' })).getByRole('button', {
        name: '小说',
      }),
    );

    expect(container.querySelector('.workspace-production-page')).toBeVisible();
    expect(container.querySelector('.workspace-editor-page')).toBeVisible();
    expect(container.querySelector('.app-shell')).toHaveAttribute(
      'data-navigation-mode',
      'production',
    );
  });

  it.each(['小说', '剧本', '角色与场景', '场次与镜头', '任务日志'])(
    'keeps the %s page out of image and video production',
    (page) => {
      window.localStorage.removeItem('ai-video.production-capability');
      const { container } = render(<App />);
      const projectNav = screen.getByRole('navigation', { name: '项目导航' });
      fireEvent.click(within(projectNav).getByRole('button', { name: new RegExp(`^${page}`) }));
      expect(container.querySelector('.workspace-editor-page')).toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: '文生图' }));
      expect(container.querySelector('.workspace-editor-page')).toBeVisible();
      expect(container.querySelector('[data-pane-id="editor"]')).toBeInTheDocument();
      expect(container.querySelector('.workspace-production-page')).toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: '视频制作' }));
      fireEvent.click(screen.getByRole('button', { name: '文生视频' }));
      expect(container.querySelector('.workspace-editor-page')).toBeVisible();

      fireEvent.click(screen.getByRole('button', { name: '关闭生产参数' }));
      expect(container.querySelector('.workspace-editor-page')).toBeVisible();
      expect(container.querySelector('[data-pane-id="editor"]')).toHaveTextContent(page);
    },
  );

  it('keeps the asset library and project page open beside production', () => {
    const { container } = render(<App />);
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    fireEvent.click(screen.getByRole('button', { name: '文生图' }));

    expect(container.querySelector('.workspace-assets-page')).toBeVisible();
    expect(container.querySelector('.workspace-editor-page')).toBeVisible();
    expect(container.querySelector('[data-pane-id="editor"]')).toHaveTextContent('剧本');
    expect(container.querySelector('.workspace-production-page')).toBeVisible();

    fireEvent.click(within(projectNav).getByRole('button', { name: /^角色与场景/ }));

    expect(container.querySelector('.workspace-assets-page')).toBeVisible();
    expect(container.querySelector('[data-pane-id="editor"]')).toHaveTextContent('角色与场景');
    expect(container.querySelector('.workspace-production-page')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '关闭生产参数' }));

    expect(container.querySelector('.workspace-assets-page')).toBeVisible();
    expect(container.querySelector('[data-pane-id="editor"]')).toHaveTextContent('角色与场景');
    expect(container.querySelector('.workspace-production-page')).not.toBeInTheDocument();
  });

  it('opens a chapter artifact from the task log in the novel page', async () => {
    const baselineWorker = vi.mocked(callWorker).getMockImplementation()!;
    const chapter = {
      id: 'chapter-1',
      projectId: 'project',
      documentId: 'chapter-document',
      title: '小说专属章节',
      position: 0,
      displayLabel: '第一章',
      lifecycleStatus: 'active' as const,
      documentRowVersion: 0,
      ragChunkCount: 1,
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const task = {
      id: 'chapter-task',
      projectId: 'project',
      conversationId: 'conversation',
      userMessageId: 'message',
      taskType: 'document-create' as const,
      scopeType: 'project' as const,
      title: '生成小说章节',
      status: 'completed' as const,
      phase: 'waiting_review' as const,
      rowVersion: 1,
      createdAt: 'now',
      updatedAt: 'now',
    };
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'project.current')
        return Promise.resolve({
          id: 'project',
          name: 'Page Boundary Project',
          rootPath: 'D:\\PageBoundary',
          mode: 'read-write',
          schemaVersion: 38,
          createdAt: 'now',
          updatedAt: 'now',
        });
      if (method === 'conversation.list' || method === 'task.log.list')
        return Promise.resolve({
          items:
            method === 'task.log.list'
              ? [{ ...task, kind: 'agent-document', sourceId: task.id }]
              : [],
        });
      if (method === 'agent.task.get')
        return Promise.resolve({
          task,
          documents: [
            {
              documentId: chapter.documentId,
              documentVersionId: 'chapter-version',
              operation: 'create',
              createdAt: 'now',
            },
          ],
          events: [],
          providerSteps: [],
          researchSources: [],
        } satisfies AgentTaskDetail);
      if (method === 'novel.chapter.list') return Promise.resolve([chapter]);
      // Old lists/caches can still contain a chapter as an ordinary note.
      if (method === 'document.list')
        return Promise.resolve([
          {
            id: chapter.documentId,
            projectId: 'project',
            kind: 'note',
            title: chapter.title,
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (method === 'document.get')
        return Promise.resolve({
          id: chapter.documentId,
          projectId: 'project',
          kind: 'note',
          title: chapter.title,
          scopeType: 'project',
          lifecycleStatus: 'active',
          rowVersion: 0,
          currentVersionId: 'chapter-version',
          createdAt: 'now',
          updatedAt: 'now',
          currentVersion: {
            id: 'chapter-version',
            documentId: chapter.documentId,
            version: 1,
            contentMarkdown: '仅属于小说页面的正文',
            state: 'draft',
            authorType: 'agent',
            createdAt: 'now',
          },
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({ providers: [], capabilities: [], adapters: [] });
      if (
        [
          'document.list',
          'scene.list',
          'asset.list',
          'constraint.list',
          'provider.profile.list',
          'characterVoice.list',
          'novel.volume.list',
          'agent.partial.list',
        ].includes(method)
      )
        return Promise.resolve([]);
      return baselineWorker(method, params);
    });

    render(<App />);
    await screen.findAllByText('Page Boundary Project');
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    fireEvent.click(within(projectNav).getByRole('button', { name: '任务日志' }));
    fireEvent.click(await screen.findByRole('button', { name: /生成小说章节/ }));
    fireEvent.click(await screen.findByRole('button', { name: '打开文档' }));
    expect(await screen.findByLabelText('章节内容')).toHaveValue('仅属于小说页面的正文');
    expect(screen.queryByLabelText('文档内容')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '在文档工作区打开' })).not.toBeInTheDocument();
    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    expect(screen.queryByDisplayValue('仅属于小说页面的正文')).not.toBeInTheDocument();
    expect(screen.queryByText(chapter.title)).not.toBeInTheDocument();
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

  it('keeps the conversation workspace on the project scope', async () => {
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
      if (method === 'characterVoice.list') return Promise.resolve([]);
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
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    render(<App />);
    await waitFor(() => expect(callWorker).toHaveBeenCalledWith('shot.list', { sceneId: 'scene' }));

    await act(async () => {
      resolveProjectConversations([projectConversation]);
      await Promise.resolve();
    });

    expect(await screen.findByText('过期项目消息')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: '旧项目会话' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '场次会话' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '场次' })).not.toBeInTheDocument();
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
      if (method === 'characterVoice.list') return Promise.resolve([]);
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
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
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

  it.each([
    ['帮我生成一个小说', 'selected'],
    ['帮我生成一个小说', 'novel-reference'],
    ['帮我生成一个小说', 'updated-novel-reference'],
    ['帮我生成一个小说', 'novel-reference-after-chapter'],
    ['生成场次与镜头', 'scene-proposal'],
    ['生成场次与镜头', 'scene-proposal-open-page'],
    ['续写小说下一章', 'selected'],
    ['现在生成小说第一章', 'selected'],
    ['现在生成小说第一章', 'conversation-preference'],
    ['现在生成小说第一章', 'missing_model'],
    ['现在生成小说第一章', 'model_unavailable'],
    ['现在生成小说第一章', 'novel-possessive'],
  ])('sends %s (%s)', async (firstPrompt, batchModelState) => {
    window.localStorage.clear();
    const batchPrompt =
      batchModelState === 'novel-possessive' ? '生成小说的第四章和第五章' : '生成第四章和第五章';
    const isChapter = firstPrompt === '现在生成小说第一章';
    const isSceneProposal = batchModelState.startsWith('scene-proposal');
    let sceneProposalApplied = false;
    let sceneProposalGenerated = false;
    let sceneBoundDocumentId: string | null = 'document-created-by-agent';
    let sceneBindingRowVersion = 0;
    const sceneProposal = {
      id: 'generated-proposal',
      projectId: 'project',
      taskId: 'agent-task',
      title: '生成的场次方案',
      status: 'proposed' as const,
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
      items: [
        {
          id: 'proposal-scene',
          ordinal: 0,
          entityType: 'scene' as const,
          action: 'create' as const,
          title: '生成的庭院',
          sceneDocumentId: 'document-created-by-agent',
          status: 'pending' as const,
        },
        {
          id: 'proposal-shot',
          ordinal: 1,
          entityType: 'shot' as const,
          action: 'create' as const,
          title: '庭院远景',
          prompt: '清晨的庭院镜头提示词',
          parentItemOrdinal: 0,
          status: 'pending' as const,
        },
      ],
    };
    const isNovelReference = [
      'novel-reference',
      'updated-novel-reference',
      'novel-reference-after-chapter',
    ].includes(batchModelState);
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
      runtimeMode: 'document',
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
      kind: isNovelReference
        ? ('outline' as const)
        : isSceneProposal
          ? ('scene' as const)
          : ('character' as const),
      ...(isNovelReference
        ? { domainScope: 'novel' as const, bindingRole: 'work-outline' as const }
        : {}),
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
    const chapter = {
      id: 'generated-chapter',
      projectId: 'project',
      documentId: createdDocument.id,
      title: createdDocument.title,
      position: 0,
      displayLabel: '第一章',
      lifecycleStatus: 'active' as const,
      documentRowVersion: 1,
      ragChunkCount: 1,
      rowVersion: 1,
      createdAt: 'now',
      updatedAt: 'now',
    };

    vi.mocked(callWorker).mockImplementation((method, params) => {
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
        return Promise.resolve(
          documentListCalls === 1 && batchModelState !== 'updated-novel-reference'
            ? []
            : isNovelReference
              ? [
                  {
                    ...createdDocument,
                    id: 'other-task-document',
                    title: '其他任务的剧本',
                    domainScope: undefined,
                    bindingRole: undefined,
                  },
                  createdDocument,
                ]
              : [createdDocument],
        );
      }
      if (method === 'document.get') return Promise.resolve(createdDocumentDetail);
      if (method === 'document.versions')
        return Promise.resolve([createdDocumentDetail.currentVersion]);
      if (method === 'agent.task.get' && isSceneProposal) {
        sceneProposalGenerated = true;
        return Promise.resolve({
          task: {
            id: 'agent-task',
            projectId: 'project',
            taskType: 'document-query',
            title: firstPrompt,
            scopeType: 'project',
            status: 'completed',
            phase: 'model_running',
            rowVersion: 1,
            createdAt: 'now',
            updatedAt: 'now',
          },
          documents: [],
          changeSets: [
            {
              changeSetId: sceneProposal.id,
              title: sceneProposal.title,
              status: 'proposed',
              createdAt: 'now',
            },
          ],
          events: [],
          providerSteps: [],
          researchSources: [],
        } satisfies AgentTaskDetail);
      }
      if (method === 'agent.changeSet.list' && isSceneProposal)
        return Promise.resolve(
          sceneProposalGenerated
            ? [
                {
                  ...sceneProposal,
                  id: 'unrelated-proposal',
                  taskId: 'another-task',
                  title: '其他任务方案',
                },
                sceneProposal,
              ]
            : [],
        );
      if (method === 'agent.changeSet.apply' && isSceneProposal) {
        sceneProposalApplied = true;
        return Promise.resolve({
          ...sceneProposal,
          status: 'applied',
          rowVersion: 1,
          items: sceneProposal.items.map((item) => ({
            ...item,
            status: 'applied',
            appliedEntityId: item.entityType === 'scene' ? 'applied-scene' : 'applied-shot',
          })),
        });
      }
      if (method === 'scene.list' && isSceneProposal)
        return Promise.resolve(
          sceneProposalApplied
            ? [
                {
                  id: 'applied-scene',
                  projectId: 'project',
                  title: '生成的庭院',
                  sceneDocumentId: sceneBoundDocumentId ?? undefined,
                  videoPrompt: '司机转身，他没有开口。',
                  position: 0,
                  rowVersion: 0,
                  createdAt: 'now',
                  updatedAt: 'now',
                },
              ]
            : [],
        );
      if (method === 'shot.list' && isSceneProposal)
        return Promise.resolve([
          {
            id: 'applied-shot',
            sceneId: 'applied-scene',
            title: '庭院远景',
            prompt: '清晨的庭院镜头提示词',
            position: 0,
            status: 'draft',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (method === 'scene.save' && isSceneProposal) {
        sceneBoundDocumentId = (params as { sceneDocumentId: string | null }).sceneDocumentId;
        sceneBindingRowVersion += 1;
        return Promise.resolve({
          id: 'applied-scene',
          projectId: 'project',
          title: '生成的庭院',
          position: 0,
          rowVersion: sceneBindingRowVersion,
          sceneDocumentId: sceneBoundDocumentId ?? undefined,
          createdAt: 'now',
          updatedAt: 'now',
        });
      }
      if (method === 'agent.task.get' && isNovelReference)
        return Promise.resolve({
          ...(batchModelState === 'novel-reference-after-chapter'
            ? {
                target: {
                  targetKind: 'novel-chapter' as const,
                  action: 'create_chapter' as const,
                  chapterId: 'earlier-chapter',
                  documentId: 'earlier-chapter-document',
                  documentVersionId: 'earlier-version',
                },
              }
            : {}),
          task: {
            id: prepared.agentTaskId,
            projectId: 'project',
            conversationId: conversation.id,
            taskType: 'document-create',
            scopeType: 'project',
            title: firstPrompt,
            status: 'completed',
            phase: 'waiting_review',
            rowVersion: 1,
            createdAt: 'now',
            updatedAt: 'now',
          },
          documents: [
            ...(batchModelState === 'novel-reference-after-chapter'
              ? [
                  {
                    documentId: 'earlier-chapter-document',
                    documentVersionId: 'earlier-version',
                    operation: 'create' as const,
                    createdAt: 'before',
                  },
                ]
              : []),
            {
              documentId: createdDocument.id,
              documentVersionId: createdDocument.currentVersionId,
              operation: batchModelState === 'updated-novel-reference' ? 'update' : 'create',
              createdAt: 'now',
            },
          ],
          events: [],
          providerSteps: [],
          researchSources: [],
        } satisfies AgentTaskDetail);
      if (method === 'agent.task.get' && !isChapter) return Promise.resolve(null);
      if (method === 'agent.task.get' && isChapter)
        return Promise.resolve({
          task: {
            id: prepared.agentTaskId,
            projectId: 'project',
            conversationId: conversation.id,
            taskType: 'document-update',
            scopeType: 'project',
            title: firstPrompt,
            status: 'waiting_review',
            phase: 'waiting_review',
            rowVersion: 1,
            createdAt: 'now',
            updatedAt: 'now',
          },
          target: {
            targetKind: 'novel-chapter',
            action: 'create_chapter',
            chapterId: chapter.id,
            documentId: chapter.documentId,
            documentVersionId: createdDocument.currentVersionId,
          },
          documents: [
            {
              documentId: chapter.documentId,
              documentVersionId: createdDocument.currentVersionId,
              operation: 'create',
              createdAt: 'now',
            },
          ],
          events: [],
          providerSteps: [],
          researchSources: [],
        } satisfies AgentTaskDetail);
      if (method === 'novel.chapter.list') return Promise.resolve(isChapter ? [chapter] : []);
      if (method === 'novel.volume.list' || method === 'agent.partial.list')
        return Promise.resolve([]);
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
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'conversation.list') return Promise.resolve({ items: [conversation] });
      if (method === 'chat.message.list') return Promise.resolve({ items: [] });
      if (method === 'chat.message.save')
        return Promise.resolve({
          id: 'batch-original',
          conversationId: conversation.id,
          role: 'user' as const,
          content: (params as { content: string }).content,
          status: 'complete' as const,
          createdAt: 'now',
        });
      if (method === 'llm.generation.get') return Promise.resolve(prepared.generation);
      if (method === 'context.preview')
        return Promise.resolve({
          version: 1,
          scopeType: 'project' as const,
          scopeLabel: 'project',
          estimatedTokens: 1,
          budgetTokens: 1_000,
          sources: [],
        });
      if (method === 'conversation.modelPreference.set')
        return Promise.resolve({
          conversationId: conversation.id,
          capability: 'text' as const,
          providerProfileId: profile.id,
          modelId: model.id,
          confirmedAt: 'now',
          updatedAt: 'now',
        });
      if (method === 'agent.run' && (params as { prompt?: string }).prompt === '续写小说下一章') {
        return Promise.resolve({
          status: 'pending_intent' as const,
          capability: 'novel' as const,
          pendingIntent: {
            id: 'pending-intent',
            projectId: 'project',
            conversationId: conversation.id,
            requestedAction: 'continue_chapter' as const,
            reasonCode: 'TARGET_REQUIRED' as const,
            status: 'pending' as const,
            expiresAt: 'later',
            createdAt: 'now',
            updatedAt: 'now',
          },
        });
      }
      if (method === 'agent.run') {
        const run = params as { providerProfileId?: string; modelId?: string };
        if (!run.modelId && ['missing_model', 'model_unavailable'].includes(batchModelState))
          return Promise.resolve({
            status: 'needs_model_selection' as const,
            capability: 'text' as const,
            reason: batchModelState as 'missing_model' | 'model_unavailable',
            models: [
              {
                providerProfileId: profile.id,
                providerName: profile.name,
                modelId: model.id,
                remoteModelId: model.remoteModelId,
                modelName: model.displayName,
                capabilities: model.capabilities,
                source: model.source,
                schemaReady: true,
              },
            ],
          });
        return Promise.resolve({
          status: 'started' as const,
          capability: 'text' as const,
          ...prepared,
        });
      }
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });

    render(<App />);
    await screen.findByDisplayValue('Project conversation');
    if (batchModelState === 'scene-proposal-open-page') {
      fireEvent.click(
        screen
          .getAllByRole('button', { name: /^场次与镜头/ })
          .find((item) => item.classList.contains('nav-item'))!,
      );
      await waitFor(() =>
        expect(callWorker).toHaveBeenCalledWith('agent.changeSet.list', { includeTerminal: false }),
      );
    }
    selectLlm(profile.id, model.id);
    fireEvent.change(screen.getByLabelText('会话消息'), {
      target: { value: firstPrompt },
    });
    fireEvent.click(screen.getByTitle('发送消息'));

    const needsClarification = firstPrompt === '续写小说下一章';
    if (needsClarification) {
      expect(
        await screen.findByText('请补充要操作的小说章节或新章节标题，助手会继续当前任务。'),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('会话消息')).toHaveValue(firstPrompt);

      fireEvent.change(screen.getByLabelText('会话消息'), {
        target: { value: 'Draft a project brief' },
      });
      fireEvent.click(screen.getByTitle('发送消息'));
    }

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'agent.run',
        expect.objectContaining({
          conversationId: conversation.id,
          prompt: needsClarification ? 'Draft a project brief' : firstPrompt,
          capability: 'text',
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          idempotencyKey: expect.stringMatching(/^desktop-run:/),
          providerProfileId: profile.id,
          modelId: model.id,
          researchMode: 'auto',
        }),
      ),
    );
    if (!needsClarification) {
      const run = vi.mocked(callWorker).mock.calls.find(([method]) => method === 'agent.run');
      expect(run?.[1]).not.toHaveProperty('novelIntent');
      await waitFor(() => expect(screen.getByLabelText('会话消息')).toHaveValue(''));
      expect(
        screen.queryByText('请补充要操作的小说章节或新章节标题，助手会继续当前任务。'),
      ).not.toBeInTheDocument();
    }
    if (isSceneProposal) {
      const proposalButton = await screen.findByRole('button', { name: /生成的场次方案/ });
      expect(proposalButton).toHaveAttribute('aria-expanded', 'true');
      expect(
        screen
          .getAllByRole('button', { name: /^场次与镜头/ })
          .find((item) => item.classList.contains('nav-item')),
      ).toHaveClass('active');
      expect(screen.getByRole('button', { name: /其他任务方案/ })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      fireEvent.click(screen.getByRole('button', { name: '批准并写入目录' }));
      expect(await screen.findByRole('button', { name: '生成的庭院' })).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: '庭院远景' })).toBeInTheDocument();
      expect(await screen.findByDisplayValue('清晨的庭院镜头提示词')).toBeInTheDocument();
      expect(screen.getByLabelText('场次完整视频提示词')).toHaveValue('司机转身，他没有开口。');
      expect(callWorker).toHaveBeenCalledWith('shot.list', { sceneId: 'applied-scene' });
      expect(screen.getByLabelText('场次绑定场景')).toHaveValue(createdDocument.id);
      expect(screen.getByText(`绑定场景：${createdDocument.title}`)).toBeInTheDocument();
      fireEvent.change(screen.getByLabelText('场次绑定场景'), { target: { value: '' } });
      await waitFor(() => expect(screen.getByLabelText('场次绑定场景')).toHaveValue(''));
      expect(callWorker).toHaveBeenCalledWith('scene.save', {
        sceneId: 'applied-scene',
        title: '生成的庭院',
        sceneDocumentId: null,
        expectedRowVersion: 0,
      });
      fireEvent.change(screen.getByLabelText('场次绑定场景'), {
        target: { value: createdDocument.id },
      });
      await waitFor(() =>
        expect(screen.getByLabelText('场次绑定场景')).toHaveValue(createdDocument.id),
      );
      expect(callWorker).toHaveBeenCalledWith('scene.save', {
        sceneId: 'applied-scene',
        title: '生成的庭院',
        sceneDocumentId: createdDocument.id,
        expectedRowVersion: 1,
      });
      fireEvent.change(screen.getByLabelText('场次完整视频提示词'), {
        target: { value: '司机走进屋内，他坐下。' },
      });
      fireEvent.click(
        within(screen.getByLabelText('场次完整视频提示词').closest('section')!).getByRole(
          'button',
          { name: '保存提示词' },
        ),
      );
      await waitFor(() =>
        expect(callWorker).toHaveBeenCalledWith(
          'agent.run',
          expect.objectContaining({
            prompt: expect.stringContaining('司机走进屋内，他坐下。') as unknown,
          }),
        ),
      );
      const bindingRun = vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) => method === 'agent.run')
        .at(-1)?.[1] as unknown;
      expect(bindingRun).toMatchObject({
        prompt: expect.stringContaining('scene.submit_structure') as unknown,
      });
      expect(bindingRun).toMatchObject({
        prompt: expect.stringContaining('"sceneId":"applied-scene"') as unknown,
      });
      expect(bindingRun).toMatchObject({
        prompt: expect.stringContaining('"expectedRowVersion":2') as unknown,
      });
      expect(
        vi
          .mocked(callWorker)
          .mock.calls.some(
            ([method, params]) =>
              method === 'scene.save' &&
              (params as { videoPrompt?: string }).videoPrompt === '司机走进屋内，他坐下。',
          ),
      ).toBe(false);
      return;
    }
    if (isNovelReference) {
      expect(await screen.findByDisplayValue(createdDocument.title)).toBeInTheDocument();
      expect(await screen.findByDisplayValue('Agent 桌面人工测试成功')).toBeInTheDocument();
      expect(
        screen
          .getAllByRole('button', { name: /^小说/ })
          .find((item) => item.classList.contains('nav-item')),
      ).toHaveClass('active');
      expect(callWorker).toHaveBeenCalledWith('document.get', { documentId: createdDocument.id });
      expect(
        vi
          .mocked(callWorker)
          .mock.calls.some(
            ([method, params]) =>
              method === 'document.get' &&
              (params as { documentId: string }).documentId === 'other-task-document',
          ),
      ).toBe(false);
      return;
    }
    if (isChapter) {
      expect(await screen.findByLabelText('章节内容')).toHaveValue('Agent 桌面人工测试成功');
      expect(screen.queryByLabelText('文档内容')).not.toBeInTheDocument();
      expect(callWorker).toHaveBeenCalledWith('agent.task.get', { taskId: prepared.agentTaskId });
      fireEvent.change(screen.getByLabelText('会话消息'), { target: { value: batchPrompt } });
      const batchCallStart = vi.mocked(callWorker).mock.calls.length;
      fireEvent.click(screen.getByTitle('发送消息'));
      await waitFor(() =>
        expect(callWorker).toHaveBeenCalledWith(
          'agent.run',
          expect.objectContaining({ prompt: batchPrompt, capability: 'text' }),
        ),
      );
      const batchCalls = vi.mocked(callWorker).mock.calls.slice(batchCallStart);
      expect(batchCalls.filter(([method]) => method === 'agent.run')).toHaveLength(1);
      expect(batchCalls.filter(([method]) => method === 'chat.message.save')).toHaveLength(0);
      const run = batchCalls.find(([method]) => method === 'agent.run');
      expect(run?.[1]).not.toHaveProperty('novelIntent');
      return;
    }
    expect((await screen.findAllByText(createdDocument.title)).length).toBeGreaterThan(0);
    expect(await screen.findByDisplayValue(createdDocument.title)).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Agent 桌面人工测试成功')).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: '文档类型筛选' })).getByRole('button', {
        name: '角色',
      }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'document.list'),
    ).toHaveLength(2);
  });

  it('splits script documents from character and scene prompts', async () => {
    vi.mocked(callWorker).mockImplementation((method: string, params: unknown) => {
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
      if (method === 'document.get') {
        const isCharacter = (params as { documentId: string }).documentId === 'd-character';
        const id = isCharacter ? 'd-character' : 'd-outline';
        return Promise.resolve({
          id,
          projectId: 'project',
          kind: isCharacter ? 'character' : 'outline',
          title: isCharacter ? '角色设定' : '项目大纲',
          scopeType: 'project',
          lifecycleStatus: 'active',
          rowVersion: 0,
          currentVersionId: `${id}-v1`,
          createdAt: 'now',
          updatedAt: 'now',
          currentVersion: {
            id: `${id}-v1`,
            documentId: id,
            version: 1,
            contentMarkdown: isCharacter ? '角色专属正文' : '剧本专属正文',
            state: 'draft',
            authorType: 'user',
            createdAt: 'now',
          },
        });
      }
      if (method === 'document.versions') return Promise.resolve([]);
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
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'agent.changeSet.list') return Promise.resolve([]);
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'tag.list' || method === 'assetGroup.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    render(<App />);
    expect(await screen.findByText('项目大纲')).toBeInTheDocument();
    expect(screen.getByText('项目计划')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '项目文档' })).toBeInTheDocument();
    expect(screen.queryByText(/不会发给生图或生视频/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成角色图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成本镜画面' })).not.toBeInTheDocument();
    const scriptKind = screen.getByLabelText('文档类型');
    expect(within(scriptKind).getByRole('option', { name: '大纲' })).toBeInTheDocument();
    expect(within(scriptKind).getByRole('option', { name: '计划' })).toBeInTheDocument();
    expect(within(scriptKind).getByRole('option', { name: '笔记' })).toBeInTheDocument();
    expect(within(scriptKind).queryByRole('option', { name: '角色' })).not.toBeInTheDocument();
    expect(within(scriptKind).queryByRole('option', { name: '场景' })).not.toBeInTheDocument();
    expect(screen.queryByText('角色设定')).not.toBeInTheDocument();
    expect(screen.queryByText('场景设定')).not.toBeInTheDocument();
    expect(screen.queryByText('小说章节一')).not.toBeInTheDocument();
    expect(screen.queryByText('第一集分镜')).not.toBeInTheDocument();
    expect(screen.getByText('所有镜头保持冷色调')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^角色与场景/ }));
    expect(screen.getByText('角色设定')).toBeInTheDocument();
    expect(screen.getByText('场景设定')).toBeInTheDocument();
    expect(screen.queryByText('项目大纲')).not.toBeInTheDocument();
    expect(screen.queryByText('约束条件')).not.toBeInTheDocument();
    expect(screen.queryByText('所有镜头保持冷色调')).not.toBeInTheDocument();

    const filters = screen.getByRole('group', { name: '文档类型筛选' });
    expect(within(filters).getByRole('button', { name: '全部' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    fireEvent.click(within(filters).getByRole('button', { name: '角色' }));
    expect(screen.getByText('角色设定')).toBeInTheDocument();
    expect(screen.queryByText('场景设定')).not.toBeInTheDocument();

    fireEvent.click(within(filters).getByRole('button', { name: '场景' }));
    expect(screen.getByText('场景设定')).toBeInTheDocument();
    expect(screen.queryByText('角色设定')).not.toBeInTheDocument();

    fireEvent.click(within(filters).getByRole('button', { name: '全部' }));
    expect(screen.getByText('角色设定')).toBeInTheDocument();
    expect(screen.getByText('场景设定')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /角色设定/ }));
    expect(await screen.findByDisplayValue('角色专属正文')).toBeInTheDocument();
    fireEvent.change(screen.getByDisplayValue('角色专属正文'), {
      target: { value: '未保存的角色修改' },
    });
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    expect(screen.getByDisplayValue('未保存的角色修改')).toBeVisible();
    fireEvent.click(screen.getByLabelText('关闭素材库'));
    expect(screen.getByDisplayValue('未保存的角色修改')).toBeVisible();
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    expect(screen.getByDisplayValue('未保存的角色修改')).toBeVisible();
    fireEvent.change(screen.getByPlaceholderText('搜索别名、文件名或标签'), {
      target: { value: '夜景素材' },
    });

    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    expect(screen.queryByText('角色设定')).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('未保存的角色修改')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索别名、文件名或标签')).toHaveValue('夜景素材');
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '文档在独立窗口打开' })).not.toBeInTheDocument();

    fireEvent.click(within(projectNav).getByRole('button', { name: /^角色与场景/ }));
    expect(screen.getByDisplayValue('未保存的角色修改')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索别名、文件名或标签')).toHaveValue('夜景素材');

    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    fireEvent.click(screen.getByRole('button', { name: /项目大纲/ }));
    expect(await screen.findByDisplayValue('剧本专属正文')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('文档内容'), {
      target: { value: '未保存的剧本修改' },
    });
    fireEvent.click(screen.getByLabelText('关闭素材库'));
    expect(screen.getByLabelText('文档内容')).toHaveValue('未保存的剧本修改');
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    expect(screen.getByLabelText('文档内容')).toHaveValue('未保存的剧本修改');
    fireEvent.click(within(projectNav).getByRole('button', { name: /^角色与场景/ }));
    expect(screen.queryByDisplayValue('未保存的剧本修改')).not.toBeInTheDocument();
    expect(screen.queryByText('项目大纲')).not.toBeInTheDocument();
  });

  it('publishes an edited document in one action without a separate review step', async () => {
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
          name: 'Publish Project',
          rootPath: 'D:\\Publish',
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
        ]);
      if (method === 'document.get')
        return Promise.resolve({
          id: 'd-outline',
          projectId: 'project',
          kind: 'outline',
          title: '项目大纲',
          scopeType: 'project',
          lifecycleStatus: 'active',
          rowVersion: 0,
          currentVersionId: 'v-1',
          currentVersion: {
            id: 'v-1',
            documentId: 'd-outline',
            version: 1,
            state: 'draft',
            contentMarkdown: '# 大纲',
            authorType: 'user',
            createdAt: 'now',
          },
          createdAt: 'now',
          updatedAt: 'now',
        });
      if (method === 'document.versions') return Promise.resolve([]);
      if (method === 'document.draft.save')
        return Promise.resolve({
          id: 'd-outline',
          projectId: 'project',
          kind: 'outline',
          title: '项目大纲',
          scopeType: 'project',
          lifecycleStatus: 'active',
          rowVersion: 1,
          currentVersionId: 'v-2',
          publishedVersionId: undefined,
          currentVersion: {
            id: 'v-2',
            documentId: 'd-outline',
            version: 2,
            state: 'draft',
            contentMarkdown: '# 大纲 v2',
            authorType: 'user',
            createdAt: 'now',
          },
          createdAt: 'now',
          updatedAt: 'now',
        });
      if (method === 'document.selfPublish')
        return Promise.resolve({
          document: {
            id: 'd-outline',
            projectId: 'project',
            kind: 'outline',
            title: '项目大纲',
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 2,
            currentVersionId: 'v-2',
            publishedVersionId: 'v-2',
            currentVersion: {
              id: 'v-2',
              documentId: 'd-outline',
              version: 2,
              state: 'published',
              contentMarkdown: '# 大纲 v2',
              authorType: 'user',
              createdAt: 'now',
            },
            createdAt: 'now',
            updatedAt: 'now',
          },
          publication: {
            id: 'publication',
            documentId: 'd-outline',
            documentVersionId: 'v-2',
            publicationNo: 1,
            publishedAt: 'now',
          },
        });
      if (method === 'scene.list') return Promise.resolve([]);
      if (method === 'asset.list') return Promise.resolve([]);
      if (method === 'constraint.list') return Promise.resolve([]);
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'agent.changeSet.list') return Promise.resolve([]);
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method + ' ' + JSON.stringify(params));
    });
    render(<App />);
    fireEvent.click(await screen.findByText('项目大纲'));
    const editor = await screen.findByLabelText('文档内容');
    fireEvent.change(editor, { target: { value: '# 大纲 v2' } });

    // One click both saves the edit and publishes it as the authority version.
    fireEvent.click(screen.getByRole('button', { name: '保存并发布' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('document.selfPublish', {
        documentId: 'd-outline',
        documentVersionId: 'v-2',
        expectedDocumentRowVersion: 1,
        expectedPublishedVersionId: undefined,
      }),
    );
    expect(callWorker).not.toHaveBeenCalledWith('document.review.submit', expect.anything());
    expect(await screen.findByText('已发布权威版本 v1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '提交审核' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeInTheDocument();
  });

  it('keeps an opened document listed when it does not match the active kind filter', async () => {
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
        ]);
      if (method === 'document.get')
        return Promise.resolve({
          id: 'd-character',
          projectId: 'project',
          kind: 'character',
          title: '角色设定',
          scopeType: 'project',
          lifecycleStatus: 'active',
          rowVersion: 0,
          createdAt: 'now',
          updatedAt: 'now',
          currentVersion: {
            id: 'v-1',
            version: 1,
            state: 'draft',
            contentMarkdown: '# 角色设定',
            createdAt: 'now',
          },
          currentVersionId: 'v-1',
        });
      if (method === 'document.versions') return Promise.resolve([]);
      if (method === 'scene.list') return Promise.resolve([]);
      if (method === 'asset.list') return Promise.resolve([]);
      if (method === 'constraint.list') return Promise.resolve([]);
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'agent.changeSet.list') return Promise.resolve([]);
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /^角色与场景/ }));
    fireEvent.click(await screen.findByText('角色设定'));
    await waitFor(() => expect(screen.getByDisplayValue('角色设定')).toBeInTheDocument());

    const filters = screen.getByRole('group', { name: '文档类型筛选' });
    fireEvent.click(within(filters).getByRole('button', { name: '场景' }));

    const directory = screen.getByRole('complementary', { name: '项目文档目录' });
    expect(within(directory).queryByText('项目大纲')).not.toBeInTheDocument();
    expect(within(directory).getByText('角色设定')).toBeInTheDocument();
  });

  it('opens character prompts in a prompt-and-gallery workspace and seeds image production', async () => {
    const project = {
      id: 'project',
      name: 'Filter Project',
      rootPath: 'D:\\Filter',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 4,
    };
    const character = {
      id: 'd-character',
      projectId: 'project',
      kind: 'character' as const,
      title: '角色设定',
      scopeType: 'project' as const,
      lifecycleStatus: 'active' as const,
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
      currentVersion: {
        id: 'v-1',
        version: 1,
        state: 'draft' as const,
        contentMarkdown: '林澈，灯塔守望员',
        createdAt: 'now',
      },
      currentVersionId: 'v-1',
    };
    const imageAdapter: AdapterDescriptor = {
      key: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      capability: 'TEXT_TO_IMAGE' as const,
      capabilityLabel: '文生图',
      provider: 'vidu',
      providerLabel: 'Vidu',
      model: 'viduq2',
      modelLabel: 'Vidu Q2',
      apiVersion: 'v2',
      schemaVersion: 1,
      endpoint: 'https://api.vidu.com/ent/v2/text2image',
      documentationUrl: 'https://platform.vidu.com/docs',
      credentialProvider: 'vidu',
      parameterSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema' as const,
        type: 'object' as const,
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', title: '画面提示词', minLength: 1 },
        },
      },
      uiSchema: {
        fields: [
          { key: 'prompt', control: 'textarea' as const, group: 'basic' as const, order: 10 },
        ],
      },
    };
    const profile = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Vidu',
      category: 'image' as const,
      providerType: 'vidu' as const,
      accessType: 'official' as const,
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.cn',
      enabled: true,
      connectionStatus: 'ready' as const,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const model = {
      id: '21111111-1111-4111-8111-111111111111',
      providerProfileId: profile.id,
      remoteModelId: 'viduq2',
      displayName: 'Vidu Q2',
      capabilities: {
        text: false,
        vision: false,
        streaming: false,
        reasoning: false,
        tools: false,
        structuredOutput: false,
        embeddings: false,
        imageGeneration: true,
        videoGeneration: false,
      },
      source: 'built-in' as const,
      enabled: true,
      createdAt: 'now',
      updatedAt: 'now',
    };
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
      if (method === 'project.current') return Promise.resolve(project);
      if (method === 'project.recent') return Promise.resolve([]);
      if (method === 'document.list') return Promise.resolve([character]);
      if (method === 'document.get') return Promise.resolve(character);
      if (method === 'document.versions') return Promise.resolve([]);
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
        return Promise.resolve({
          capabilities: [{ key: 'TEXT_TO_IMAGE' as const, label: '文生图' }],
          providers: [{ key: 'vidu', label: 'Vidu' }],
          adapters: [imageAdapter],
        });
      if (method === 'adapter.resolve') return Promise.resolve(imageAdapter);
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'agent.changeSet.list') return Promise.resolve([]);
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /^角色与场景/ }));
    fireEvent.click(await screen.findByText('角色设定'));
    expect(await screen.findByRole('heading', { name: '提示词' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '已生成图片' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成角色图' })).toBeInTheDocument();
    expect(screen.queryByText('约束条件')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '生成角色图' }));
    await waitFor(() =>
      expect(container.querySelector('.app-shell')).toHaveAttribute(
        'data-navigation-mode',
        'production',
      ),
    );
    expect(await screen.findByLabelText(/画面提示词/)).toHaveValue('林澈，灯塔守望员');
    expect(screen.getByLabelText('保存为')).toHaveValue('character');
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
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([]);
      if (method === 'video.generate.list') return Promise.resolve([]);
      if (method === 'agent.changeSet.list') return Promise.resolve([]);
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /场次与镜头/ }));
    fireEvent.click(await screen.findByRole('button', { name: /镜头一/ }));
    expect(await screen.findByRole('heading', { name: '镜头提示词' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '参考图' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '分镜说明' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成本镜画面' })).toBeInTheDocument();
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

  it('seeds shot prompt into image production from the shot workspace', async () => {
    const project = {
      id: 'project',
      name: 'Shot Project',
      rootPath: 'D:\\Shots',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 4,
    };
    const imageAdapter: AdapterDescriptor = {
      key: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      capability: 'TEXT_TO_IMAGE',
      capabilityLabel: '文生图',
      provider: 'vidu',
      providerLabel: 'Vidu',
      model: 'viduq2',
      modelLabel: 'Vidu Q2',
      apiVersion: 'v2',
      schemaVersion: 1,
      endpoint: 'https://api.vidu.com/ent/v2/text2image',
      documentationUrl: 'https://platform.vidu.com/docs',
      credentialProvider: 'vidu',
      parameterSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', title: '画面提示词', minLength: 1 },
        },
      },
      uiSchema: {
        fields: [{ key: 'prompt', control: 'textarea', group: 'basic', order: 10 }],
      },
    };
    const profile = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Vidu',
      category: 'image' as const,
      providerType: 'vidu' as const,
      accessType: 'official' as const,
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.cn',
      enabled: true,
      connectionStatus: 'ready' as const,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const model = {
      id: '21111111-1111-4111-8111-111111111111',
      providerProfileId: profile.id,
      remoteModelId: 'viduq2',
      displayName: 'Vidu Q2',
      capabilities: {
        text: false,
        vision: false,
        streaming: false,
        reasoning: false,
        tools: false,
        structuredOutput: false,
        embeddings: false,
        imageGeneration: true,
        videoGeneration: false,
      },
      source: 'built-in' as const,
      enabled: true,
      createdAt: 'now',
      updatedAt: 'now',
    };
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
      if (method === 'project.current') return Promise.resolve(project);
      if (method === 'project.recent' || method === 'document.list' || method === 'constraint.list')
        return Promise.resolve([]);
      if (method === 'asset.list') return Promise.resolve([]);
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
      if (method === 'shot.list' || method === 'shot.save')
        return Promise.resolve(
          method === 'shot.list'
            ? [
                {
                  id: 'shot',
                  sceneId: 'scene',
                  title: '镜头一',
                  position: 0,
                  status: 'draft',
                  prompt: '雨夜里林澈回头',
                  rowVersion: 0,
                  createdAt: 'now',
                  updatedAt: 'now',
                },
              ]
            : {
                id: 'shot',
                sceneId: 'scene',
                title: '镜头一',
                position: 0,
                status: 'draft',
                prompt: '雨夜里林澈回头',
                rowVersion: 1,
                createdAt: 'now',
                updatedAt: 'now',
              },
        );
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({
          capabilities: [{ key: 'TEXT_TO_IMAGE' as const, label: '文生图' }],
          providers: [{ key: 'vidu', label: 'Vidu' }],
          adapters: [imageAdapter],
        });
      if (method === 'adapter.resolve') return Promise.resolve(imageAdapter);
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'video.generate.list' || method === 'agent.changeSet.list')
        return Promise.resolve([]);
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /场次与镜头/ }));
    fireEvent.click(await screen.findByRole('button', { name: /镜头一/ }));
    expect(await screen.findByRole('textbox', { name: '镜头提示词' })).toHaveValue(
      '雨夜里林澈回头',
    );
    fireEvent.click(screen.getByRole('button', { name: '生成本镜画面' }));
    await waitFor(() =>
      expect(container.querySelector('.app-shell')).toHaveAttribute(
        'data-navigation-mode',
        'production',
      ),
    );
    expect(await screen.findByLabelText(/画面提示词/)).toHaveValue('雨夜里林澈回头');
    expect(screen.getByLabelText('保存为')).toHaveValue('first-frame');
  });

  it('resolves mentioned character assets into reference-to-image production', async () => {
    const project = {
      id: 'project',
      name: 'Shot Project',
      rootPath: 'D:\\Shots',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 4,
    };
    const character = {
      id: 'character-doc',
      projectId: 'project',
      kind: 'character' as const,
      title: '林澈',
      scopeType: 'project' as const,
      lifecycleStatus: 'active' as const,
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const characterAsset = {
      id: 'character-asset',
      projectId: 'project',
      kind: 'character',
      relativePath: 'assets/images/lin.png',
      contentHash: 'hash',
      sizeBytes: 2048,
      createdAt: 'now',
    };
    const imageAdapter: AdapterDescriptor = {
      key: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
      capability: 'TEXT_TO_IMAGE',
      capabilityLabel: '文生图',
      provider: 'vidu',
      providerLabel: 'Vidu',
      model: 'viduq2',
      modelLabel: 'Vidu Q2',
      apiVersion: 'v2',
      schemaVersion: 1,
      endpoint: 'https://api.vidu.com/ent/v2/text2image',
      documentationUrl: 'https://platform.vidu.com/docs',
      credentialProvider: 'vidu',
      parameterSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        required: ['prompt'],
        properties: {
          prompt: { type: 'string', title: '画面提示词', minLength: 1 },
        },
      },
      uiSchema: {
        fields: [{ key: 'prompt', control: 'textarea', group: 'basic', order: 10 }],
      },
    };
    const referenceAdapter: AdapterDescriptor = {
      ...imageAdapter,
      key: 'REFERENCE_TO_IMAGE:vidu:viduq2:v2',
      capability: 'REFERENCE_TO_IMAGE',
      capabilityLabel: '参考生图',
      endpoint: 'https://api.vidu.com/ent/v2/reference2image',
      parameterSchema: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        additionalProperties: false,
        required: ['images', 'prompt'],
        properties: {
          images: {
            type: 'array',
            title: '参考图片',
            minItems: 1,
            maxItems: 7,
            items: { type: 'string', format: 'uri' },
          },
          prompt: { type: 'string', title: '画面提示词', minLength: 1 },
        },
      },
      uiSchema: {
        fields: [
          { key: 'images', control: 'url-list', group: 'basic', order: 10 },
          { key: 'prompt', control: 'textarea', group: 'basic', order: 20 },
        ],
      },
    };
    const profile = {
      id: '11111111-1111-4111-8111-111111111111',
      name: 'Vidu',
      category: 'image' as const,
      providerType: 'vidu' as const,
      accessType: 'official' as const,
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.cn',
      enabled: true,
      connectionStatus: 'ready' as const,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const model = {
      id: '21111111-1111-4111-8111-111111111111',
      providerProfileId: profile.id,
      remoteModelId: 'viduq2',
      displayName: 'Vidu Q2',
      capabilities: {
        text: false,
        vision: false,
        streaming: false,
        reasoning: false,
        tools: false,
        structuredOutput: false,
        embeddings: false,
        imageGeneration: true,
        videoGeneration: false,
      },
      source: 'built-in' as const,
      enabled: true,
      createdAt: 'now',
      updatedAt: 'now',
    };
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
      if (method === 'project.current') return Promise.resolve(project);
      if (method === 'project.recent' || method === 'constraint.list') return Promise.resolve([]);
      if (method === 'document.list') return Promise.resolve([character]);
      if (method === 'asset.list') {
        const sourceDocumentId = (params as { sourceDocumentId?: string } | undefined)
          ?.sourceDocumentId;
        if (!sourceDocumentId || sourceDocumentId === character.id) {
          return Promise.resolve([characterAsset]);
        }
        return Promise.resolve([]);
      }
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
      if (method === 'shot.list' || method === 'shot.save')
        return Promise.resolve(
          method === 'shot.list'
            ? [
                {
                  id: 'shot',
                  sceneId: 'scene',
                  title: '镜头一',
                  position: 0,
                  status: 'draft',
                  prompt: '[角色:林澈] 雨夜里回头',
                  rowVersion: 0,
                  createdAt: 'now',
                  updatedAt: 'now',
                },
              ]
            : {
                id: 'shot',
                sceneId: 'scene',
                title: '镜头一',
                position: 0,
                status: 'draft',
                prompt: '[角色:林澈] 雨夜里回头',
                rowVersion: 1,
                createdAt: 'now',
                updatedAt: 'now',
              },
        );
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({
          capabilities: [
            { key: 'TEXT_TO_IMAGE' as const, label: '文生图' },
            { key: 'REFERENCE_TO_IMAGE' as const, label: '参考生图' },
          ],
          providers: [{ key: 'vidu', label: 'Vidu' }],
          adapters: [imageAdapter, referenceAdapter],
        });
      if (method === 'adapter.resolve') {
        const capability = (params as { capability?: string } | undefined)?.capability;
        return Promise.resolve(
          capability === 'REFERENCE_TO_IMAGE' ? referenceAdapter : imageAdapter,
        );
      }
      if (method === 'generation.draft.get') return Promise.resolve(null);
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'video.generate.list' || method === 'agent.changeSet.list')
        return Promise.resolve([]);
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole('button', { name: /场次与镜头/ }));
    fireEvent.click(await screen.findByRole('button', { name: /镜头一/ }));
    expect(await screen.findByRole('textbox', { name: '镜头提示词' })).toHaveValue(
      '[角色:林澈] 雨夜里回头',
    );
    fireEvent.click(screen.getByRole('button', { name: '生成本镜画面' }));
    await waitFor(() =>
      expect(container.querySelector('.app-shell')).toHaveAttribute(
        'data-navigation-mode',
        'production',
      ),
    );
    expect(await screen.findByLabelText(/画面提示词/)).toHaveValue('[角色:林澈] 雨夜里回头');
    expect(screen.getByLabelText('保存为')).toHaveValue('first-frame');
    expect(screen.queryByText('素材库图片')).not.toBeInTheDocument();
  });

  it('reviews a direct paid image submission on the shared confirmation card', async () => {
    const conversation: ConversationInfo = {
      id: 'conversation',
      projectId: 'project',
      scopeType: 'project',
      title: '付费提交',
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
    const imageJob = {
      id: 'media-job',
      adapterKey: 'TEXT_TO_IMAGE:test:model:v2',
      status: 'pending' as const,
      request: {},
      results: [],
      createdAt: 'now',
      updatedAt: 'now',
    };
    const confirmation = {
      confirmationToken: 'media-token',
      jobId: imageJob.id,
      kind: 'image' as const,
      draftVersion: 3,
      providerName: '媒体供应商',
      modelName: '图片模型',
      adapterKey: imageJob.adapterKey,
      parameterSummary: [{ key: 'prompt', value: '雨夜的城市街道' }],
      costNotice: { required: true as const, summary: '本次提交可能产生费用。' },
      expiresAt: '2999-01-01T00:00:00.000Z',
    };
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
          name: 'Paid Project',
          rootPath: 'D:\\Paid',
          createdAt: 'now',
          updatedAt: 'now',
          mode: 'read-write',
          schemaVersion: 4,
        });
      if (
        method === 'project.recent' ||
        method === 'document.list' ||
        method === 'scene.list' ||
        method === 'asset.list' ||
        method === 'video.generate.list'
      )
        return Promise.resolve([]);
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'GPT Test',
          configured: true,
          configurationSource: 'managed',
        });
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'characterVoice.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'conversation.list') return Promise.resolve({ items: [conversation] });
      if (method === 'chat.message.list') return Promise.resolve({ items: [] });
      if (method === 'context.preview')
        return Promise.resolve({
          version: 1,
          scopeType: 'project',
          scopeLabel: 'project',
          estimatedTokens: 1,
          budgetTokens: 1_000,
          sources: [],
        });
      if (method === 'agent.run')
        return Promise.resolve({
          status: 'image_prepared' as const,
          capability: 'image' as const,
          job: imageJob,
        });
      if (method === 'media.generation.requestSubmission')
        return Promise.resolve({
          kind: 'image' as const,
          job: { ...imageJob, mediaState: 'awaiting_confirmation' as const },
          confirmation,
        });
      if (method === 'media.generation.confirmSubmission')
        return Promise.resolve({ kind: 'image' as const, job: imageJob });
      if (method === 'media.task.cancel')
        return Promise.resolve({
          kind: 'image' as const,
          job: { ...imageJob, status: 'cancelled' as const },
        });
      if (method === 'conversation.modelPreference.set')
        return Promise.resolve({
          conversationId: conversation.id,
          capability: 'text' as const,
          providerProfileId: profile.id,
          modelId: model.id,
          confirmedAt: 'now',
          updatedAt: 'now',
        });
      if (method === 'novel.chapter.list') return Promise.resolve([]);
      if (method === 'production.compile' || method === 'production.read')
        return Promise.resolve({
          target: { kind: 'scene' as const, id: 'legacy' },
          rowVersion: 1,
          parameters: {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    render(<App />);
    await screen.findByDisplayValue('付费提交');
    selectLlm(profile.id, model.id);
    fireEvent.change(screen.getByLabelText('会话消息'), {
      target: { value: '生成一张角色图' },
    });
    fireEvent.click(screen.getByTitle('发送消息'));

    // The frozen draft is shown before the paid Provider call.
    const card = await screen.findByRole('alert');
    expect(card).toHaveTextContent('媒体供应商 / 图片模型');
    expect(card).toHaveTextContent('草稿版本 v3');
    expect(card).toHaveTextContent('雨夜的城市街道');
    expect(card).toHaveTextContent('本次提交可能产生费用。');
    expect(callWorker).not.toHaveBeenCalledWith(
      'media.generation.confirmSubmission',
      expect.anything(),
    );

    fireEvent.click(screen.getByRole('button', { name: '拒绝' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('media.task.cancel', { jobId: imageJob.id }),
    );
    expect(screen.getByRole('textbox', { name: '会话消息' })).toHaveValue('生成一张角色图');
    expect(callWorker).not.toHaveBeenCalledWith(
      'media.generation.confirmSubmission',
      expect.anything(),
    );
  });
});
