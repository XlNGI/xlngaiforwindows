import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterDescriptor,
  AgentTaskDetail,
  AgentInputForm,
  ConversationInfo,
  LlmGenerationInfo,
} from '@ai-video/contracts';
import {
  App,
  buildAgentAttachments,
  collectReferenceImageInputs,
  composeConversationPrompt,
  composeImageGenerationPrompt,
  inferAgentCapability,
  mergeGenerationMessage,
  normalizeImageDataUrl,
  resolveAgentRunModelSelection,
} from './App';
import { callWorker } from './worker-client';
import { selectWorkerScope } from './worker-scope';
import * as llmClient from './llm-client';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readMarkdownDocument } from './markdown-import-client';
const windowApi = vi.hoisted(() => ({
  close: vi.fn().mockResolvedValue(undefined),
  isMaximized: vi.fn().mockResolvedValue(false),
  minimize: vi.fn().mockResolvedValue(undefined),
  onResized: vi.fn().mockResolvedValue(() => undefined),
  toggleMaximize: vi.fn().mockResolvedValue(undefined),
}));
describe('composeConversationPrompt', () => {
  it('attaches the editable conversation contract once and preserves an empty template', () => {
    expect(composeConversationPrompt('写一场雨夜追逐', '固定 1990 年代、冷色胶片风格')).toBe(
      '【本会话要求约束】\n固定 1990 年代、冷色胶片风格\n\n【用户本次请求】\n写一场雨夜追逐',
    );
    expect(composeConversationPrompt('  写一场戏  ', '  ')).toBe('  写一场戏  ');
  });
});
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
  it('passes the Agent-authored request through without composing a UI prompt', () => {
    const result = composeImageGenerationPrompt('  直接生成角色三视图  ', {
      title: '角色三视图提示词',
      content: '正面、左侧面、背面并列展示；服装和发型保持一致。',
    });
    expect(result).toBe('直接生成角色三视图');
    expect(result).not.toContain('角色三视图提示词');
    expect(result).not.toContain('服装和发型保持一致');
  });
  it('does not truncate an authored request in the UI bridge', () => {
    const result = composeImageGenerationPrompt('生成角色图', {
      title: '长文档',
      content: 'x'.repeat(10000),
    });
    expect(result).toBe('生成角色图');
  });
});
describe('buildAgentAttachments', () => {
  it('uses the encoded image type after compression while preserving the original display name', () => {
    expect(
      buildAgentAttachments([
        {
          id: 'compressed',
          name: 'reference.png',
          mimeType: 'image/png',
          size: 2358559,
          kind: 'image',
          dataUrl: 'data:image/jpeg;base64,/9j/',
        },
      ]),
    ).toEqual([
      { name: 'reference.png', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,/9j/' },
    ]);
  });
  it('sends a bounded video first frame instead of the full video data URL', () => {
    const attachments = buildAgentAttachments([
      {
        id: 'video-1',
        name: 'result.mp4',
        mimeType: 'video/mp4',
        size: 8000000,
        kind: 'video',
        dataUrl: `data:video/mp4;base64,${'x'.repeat(3000000)}`,
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
  async function renderProjectWorkspace() {
    const project = {
      id: 'workspace-project',
      name: 'Workspace Project',
      rootPath: 'D:\\Projects\\workspace-project',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 1 as const,
    };
    const runtime = {
      project,
      projectSessionId: 'workspace-session',
      active: true,
      state: 'ready' as const,
    };
    const emptyListMethods = [
      'document.list',
      'scene.list',
      'constraint.list',
      'asset.list',
      'video.generate.list',
      'novel.chapter.list',
      'novel.volume.list',
      'characterVoice.list',
      'provider.profile.list',
      'provider.model.list',
      'agent.changeSet.list',
      'agent.task.list',
      'conversation.runtime.list',
    ];
    const baselineWorker = vi.mocked(callWorker).getMockImplementation()!;
    vi.mocked(callWorker).mockImplementation((method: string, params: unknown, scope: unknown) => {
      if (method === 'project.current') return Promise.resolve(project);
      if (method === 'project.runtime.list') return Promise.resolve([runtime]);
      if (method === 'project.recent') return Promise.resolve([]);
      if (method === 'conversation.list' || method === 'task.log.list')
        return Promise.resolve({ items: [] });
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (emptyListMethods.includes(method)) return Promise.resolve([]);
      return baselineWorker(method as never, params as never, scope as never);
    });
    const rendered = render(<App />);
    await waitFor(() =>
      expect(
        within(screen.getByRole('navigation', { name: '项目导航' })).getByRole('button', {
          name: /^剧本/,
        }),
      ).toBeEnabled(),
    );
    return rendered;
  }
  it('archives the current scene, closes its dirty shot editor, and restores saved content', async () => {
    await renderProjectWorkspace();
    const baseline = vi.mocked(callWorker).getMockImplementation()!;
    const sceneInfo = {
      id: 'lifecycle-scene',
      projectId: 'workspace-project',
      title: '可恢复场次',
      prompt: '保存的场次正文',
      position: 0,
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const shotInfo = {
      id: 'lifecycle-shot',
      sceneId: sceneInfo.id,
      title: '可恢复镜头',
      prompt: '保存的镜头正文',
      position: 0,
      status: 'draft',
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    };
    let archived = false;
    let version = 0;
    vi.mocked(callWorker).mockImplementation((method: string, params: unknown, scope: unknown) => {
      if (method === 'scene.list')
        return Promise.resolve(
          archived &&
            !(
              params as {
                includeArchived?: boolean;
              }
            ).includeArchived
            ? []
            : [{ ...sceneInfo, rowVersion: version, archivedAt: archived ? 'now' : undefined }],
        );
      if (method === 'shot.list')
        return Promise.resolve(
          archived &&
            !(
              params as {
                includeArchived?: boolean;
              }
            ).includeArchived
            ? []
            : [shotInfo],
        );
      if (method === 'production.lifecycle.change') {
        archived = (
          params as {
            archived: boolean;
          }
        ).archived;
        version += 1;
        return Promise.resolve({
          ...sceneInfo,
          rowVersion: version,
          archivedAt: archived ? 'now' : undefined,
        });
      }
      return baseline(method as never, params as never, scope as never);
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('production-source-updated', { detail: { authoring: true } }),
      );
    });
    await clickProjectNavigationItem(/场次与镜头/);
    fireEvent.click(await screen.findByRole('button', { name: sceneInfo.title }));
    fireEvent.click(await screen.findByRole('button', { name: shotInfo.title }));
    fireEvent.click(await screen.findByRole('region', { name: '镜头提示词预览' }));
    fireEvent.change(await screen.findByRole('textbox', { name: '镜头提示词' }), {
      target: { value: '未保存修改' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: `选择场次 ${sceneInfo.title}` }));
    fireEvent.click(screen.getByRole('button', { name: '归档所选' }));
    const dialog = screen.getByRole('dialog', { name: '归档所选草稿？' });
    expect(dialog).toHaveTextContent('未保存的更改将被放弃');
    fireEvent.click(within(dialog).getByRole('button', { name: '确认归档' }));
    await waitFor(() =>
      expect(screen.queryByRole('textbox', { name: '镜头提示词' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: sceneInfo.title })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '已归档 / 已删除' }));
    fireEvent.click(await screen.findByRole('button', { name: `恢复场次 ${sceneInfo.title}` }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: `恢复场次 ${sceneInfo.title}` }),
      ).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: '返回草稿' }));
    fireEvent.click(await screen.findByRole('button', { name: sceneInfo.title }));
    fireEvent.click(await screen.findByRole('button', { name: shotInfo.title }));
    expect(await screen.findByRole('region', { name: '镜头提示词预览' })).toHaveTextContent(
      '保存的镜头正文',
    );
    expect(callWorker).toHaveBeenCalledWith(
      'production.lifecycle.change',
      {
        target: { kind: 'scene', id: sceneInfo.id },
        expectedRowVersion: 0,
        archived: true,
      },
      expect.objectContaining({ projectId: 'workspace-project' }),
    );
  });
  it('archives a shot immediately after creating its first storyboard with the refreshed version', async () => {
    await renderProjectWorkspace();
    const baseline = vi.mocked(callWorker).getMockImplementation()!;
    const sceneInfo = {
      id: 'storyboard-scene',
      projectId: 'workspace-project',
      title: '分镜场次',
      position: 0,
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const shotInfo = {
      id: 'storyboard-shot',
      sceneId: sceneInfo.id,
      title: '新建分镜的镜头',
      position: 0,
      status: 'draft',
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const storyboard = {
      id: 'first-storyboard',
      projectId: sceneInfo.projectId,
      kind: 'storyboard',
      title: '新分镜',
      lifecycleStatus: 'active',
      rowVersion: 0,
      currentVersion: { contentMarkdown: '已保存的分镜内容', state: 'draft' },
    };
    let saved = false;
    let archived = false;
    vi.mocked(callWorker).mockImplementation((method: string, params: unknown, scope: unknown) => {
      if (method === 'scene.list') return Promise.resolve([sceneInfo]);
      if (method === 'shot.list')
        return Promise.resolve(
          archived
            ? []
            : [
                {
                  ...shotInfo,
                  rowVersion: saved ? 1 : 0,
                  documentId: saved ? storyboard.id : undefined,
                },
              ],
        );
      if (method === 'shot.storyboard.save') {
        saved = true;
        return Promise.resolve(storyboard);
      }
      if (method === 'document.get') return Promise.resolve(storyboard);
      if (method === 'production.lifecycle.change') {
        if (
          (
            params as {
              expectedRowVersion: number;
            }
          ).expectedRowVersion !== 1
        )
          return Promise.reject(new Error('镜头已变化，请刷新后重试'));
        archived = true;
        return Promise.resolve({ ...shotInfo, rowVersion: 2, archivedAt: 'now' });
      }
      return baseline(method as never, params as never, scope as never);
    });
    act(() => {
      window.dispatchEvent(
        new CustomEvent('production-source-updated', { detail: { authoring: true } }),
      );
    });
    await clickProjectNavigationItem(/场次与镜头/);
    fireEvent.click(await screen.findByRole('button', { name: sceneInfo.title }));
    fireEvent.click(await screen.findByRole('button', { name: shotInfo.title }));
    fireEvent.click(screen.getByText('分镜说明 · 可选'));
    fireEvent.change(screen.getByLabelText('分镜标题'), { target: { value: storyboard.title } });
    fireEvent.click(screen.getByRole('region', { name: '分镜内容预览' }));
    fireEvent.change(screen.getByLabelText('分镜内容'), {
      target: { value: storyboard.currentVersion.contentMarkdown },
    });
    fireEvent.click(screen.getByRole('button', { name: '新建分镜' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存分镜' })).toBeEnabled());
    const checkbox = screen.getByRole('checkbox', { name: `选择镜头 ${shotInfo.title}` });
    await waitFor(() => expect(checkbox).toBeEnabled());
    fireEvent.click(checkbox);
    fireEvent.click(screen.getByRole('button', { name: '归档所选' }));
    fireEvent.click(
      within(screen.getByRole('dialog', { name: '归档所选草稿？' })).getByRole('button', {
        name: '确认归档',
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: shotInfo.title })).not.toBeInTheDocument(),
    );
    expect(callWorker).toHaveBeenCalledWith(
      'production.lifecycle.change',
      { target: { kind: 'shot', id: shotInfo.id }, expectedRowVersion: 1, archived: true },
      expect.objectContaining({ projectId: sceneInfo.projectId }),
    );
  });
  async function clickProjectNavigationItem(name: RegExp) {
    const findItem = () =>
      within(screen.getByRole('navigation', { name: '项目导航' })).getByRole('button', {
        name,
      });
    await waitFor(() => expect(findItem()).toBeEnabled());
    fireEvent.click(findItem());
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
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
          budgetTokens: 1000,
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
            stream: {
              projectId: conversation.projectId,
              conversationId: conversation.id,
              generationId: generation.generationId,
              projectSessionId: 'session',
              attemptId: 'attempt',
            },
          };
  }
  beforeEach(() => {
    cleanup();
    selectWorkerScope(undefined);
    vi.clearAllMocks();
    window.localStorage.clear();
    window.sessionStorage.clear();
    vi.mocked(callWorker).mockImplementation((method: string) =>
      Promise.resolve(
        method === 'conversation.promptTemplate.get'
          ? { conversationId: 'conversation', content: '', rowVersion: 1 }
          : method === 'health'
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
  describe('generation status feedback', () => {
    it('refreshes committed documents and production while an Agent task is still running', async () => {
      const accepted = mockComposerSend('agent.run', Promise.resolve(null));
      if (!('generation' in accepted)) throw new Error('prepared fixture');
      const active = {
        ...accepted,
        agentTaskId: 'audit-live-task',
        runtimeOwner: 'pi',
        generation: {
          ...accepted.generation,
          status: 'streaming' as const,
          executionMode: 'native' as const,
        },
      };
      const baseline = vi.mocked(callWorker).getMockImplementation()!;
      let polls = 0;
      const detail = {
        task: {
          id: 'audit-live-task',
          projectId: 'project',
          conversationId: 'composer-conversation',
          taskType: 'document-create',
          status: 'running',
          phase: 'model_running',
          title: 'Audit live save',
          createdAt: 'now',
          updatedAt: 'now',
          rowVersion: 0,
        },
        documents: [],
        events: [],
        providerSteps: [],
        researchSources: [],
        productionUpdated: true,
        resourceChanges: { sequence: 0, documentSequence: 0, productionSequence: 0 },
      };
      vi.mocked(callWorker).mockImplementation(((
        method: string,
        params: unknown,
        scope: unknown,
      ) => {
        if (method === 'agent.run') return Promise.resolve(active);
        if (method === 'agent.task.events') {
          polls++;
          return Promise.resolve({
            task: detail.task,
            events: [
              {
                sequence: 1,
                level: 'info',
                summary: 'Saved scene',
                eventType: 'agent.tool.succeeded',
              },
            ],
            nextSequence: 1,
          });
        }
        if (method === 'agent.task.get') return Promise.resolve(detail);
        return baseline(method as never, params as never, scope as never);
      }) as typeof callWorker);
      let callbacks!: Parameters<typeof llmClient.streamPreparedLlmGeneration>[1];
      let finish!: () => void;
      vi.spyOn(llmClient, 'streamPreparedLlmGeneration').mockImplementation(
        (prepared, observer) => {
          callbacks = observer;
          return {
            identity: prepared.stream,
            completion: new Promise<void>((resolve) => {
              finish = resolve;
            }),
            cancel: vi.fn().mockResolvedValue(undefined),
            detach: vi.fn(),
          };
        },
      );
      const dispatched = vi.spyOn(window, 'dispatchEvent');
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      selectLlm('composer-profile', 'composer-model');
      fireEvent.change(screen.getByRole('textbox', { name: '会话消息' }), {
        target: { value: '生成完整分镜' },
      });
      fireEvent.click(screen.getByTitle('发送消息'));
      await screen.findByTitle('停止生成');
      await waitFor(() => expect(polls).toBeGreaterThanOrEqual(1));
      const sceneReads = () =>
        vi.mocked(callWorker).mock.calls.filter(([m]) => m === 'scene.list').length;
      const initial = sceneReads();
      detail.resourceChanges = { sequence: 2, documentSequence: 1, productionSequence: 2 };
      act(() => {
        callbacks.onLiveActions?.([
          { id: 'saved-call', toolName: 'scene.structure.stage', status: 'succeeded' },
        ]);
        callbacks.onState({
          ...active.generation,
          assistantMessage: {
            ...active.generation.assistantMessage,
            content: '第一场已经保存',
            status: 'streaming',
          },
        });
      });
      await waitFor(() => expect(polls).toBeGreaterThanOrEqual(2));
      expect(sceneReads()).toBeGreaterThan(initial);
      expect(
        dispatched.mock.calls.filter(([event]) => event.type === 'production-source-updated'),
      ).toHaveLength(0);
      act(() => {
        callbacks.onState({
          ...active.generation,
          status: 'complete',
          assistantMessage: { ...active.generation.assistantMessage, status: 'complete' },
        });
        finish();
      });
      await waitFor(() =>
        expect(
          dispatched.mock.calls.filter(([event]) => event.type === 'production-source-updated'),
        ).toHaveLength(1),
      );
      dispatched.mockRestore();
    });
    afterEach(() => {
      cleanup();
      if (vi.isMockFunction(llmClient.streamPreparedLlmGeneration))
        vi.mocked(llmClient.streamPreparedLlmGeneration).mockRestore();
    });
    it('keeps polling a prepared generation without announcing completion', async () => {
      const completed = mockComposerSend(
        'llm.generate',
        Promise.resolve(null),
      ) as LlmGenerationInfo;
      const baseline = vi.mocked(callWorker).getMockImplementation()!;
      let polls = 0;
      let finish!: (value: LlmGenerationInfo) => void;
      const finalPoll = new Promise<LlmGenerationInfo>((resolve) => {
        finish = resolve;
      });
      vi.mocked(callWorker).mockImplementation((rpc: string, params: unknown) => {
        if (rpc === 'llm.generate') return Promise.resolve({ ...completed, status: 'streaming' });
        if (rpc === 'llm.generation.get')
          return ++polls === 1 ? Promise.resolve({ ...completed, status: 'prepared' }) : finalPoll;
        return baseline(rpc as never, params as never);
      });
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      fireEvent.change(screen.getByRole('textbox', { name: '会话消息' }), {
        target: { value: '生成内容' },
      });
      fireEvent.click(screen.getByTitle('发送消息'));
      await waitFor(() => expect(polls).toBe(2));
      expect(screen.getByTitle('停止生成')).toBeInTheDocument();
      expect(screen.queryByText('生成完成')).not.toBeInTheDocument();
      await act(async () => {
        finish(completed);
        await finalPoll;
      });
      expect(await screen.findByText('回复结束')).toBeInTheDocument();
      expect(screen.getByText('回复结束').closest('article')).toBeInTheDocument();
      expect(screen.queryByText('生成完成')).not.toBeInTheDocument();
    });
    it.each(['agent.run', 'llm.generate'] as const)(
      'clears the previous completion while the next %s request is pending and running',
      async (method) => {
        const accepted = mockComposerSend(method, Promise.resolve(null));
        const completed = (
          'generation' in accepted ? accepted.generation : accepted
        ) as LlmGenerationInfo;
        const active: LlmGenerationInfo = {
          ...completed,
          generationId: 'next-generation',
          status: 'streaming',
          ...(method === 'agent.run' ? { executionMode: 'native' as const } : {}),
          userMessage: { ...completed.userMessage, id: 'next-user', content: '继续完善' },
          assistantMessage: {
            ...completed.assistantMessage,
            id: 'next-assistant',
            replyToMessageId: 'next-user',
            content: '',
            status: 'streaming',
          },
        };
        let resolveNext!: (value: unknown) => void;
        const nextRequest = new Promise<unknown>((resolve) => {
          resolveNext = resolve;
        });
        const baseline = vi.mocked(callWorker).getMockImplementation()!;
        let requests = 0;
        vi.mocked(callWorker).mockImplementation(((rpc: string, params: unknown) => {
          if (rpc === method) {
            if (++requests > 1) return nextRequest;
            return Promise.resolve(
              method === 'agent.run' ? accepted : { ...completed, status: 'streaming' },
            );
          }
          if (rpc === 'llm.generation.get')
            return Promise.resolve(requests > 1 ? active : completed);
          return baseline(rpc as never, params as never);
        }) as typeof callWorker);
        vi.spyOn(llmClient, 'streamPreparedLlmGeneration').mockImplementation((prepared) => ({
          identity: prepared.stream,
          completion: new Promise<void>(() => {}),
          cancel: vi.fn().mockResolvedValue(undefined),
          detach: vi.fn(),
        }));
        render(<App />);
        await screen.findByDisplayValue('输入草稿');
        if (method === 'agent.run') selectLlm('composer-profile', 'composer-model');
        const composer = screen.getByRole('textbox', { name: '会话消息' });
        fireEvent.change(composer, { target: { value: '第一次请求' } });
        fireEvent.click(screen.getByTitle('发送消息'));
        await screen.findByText('回复结束');
        fireEvent.change(composer, { target: { value: '继续完善' } });
        fireEvent.click(screen.getByTitle('发送消息'));
        await waitFor(() => expect(requests).toBe(2));
        expect(screen.queryByText(/^生成(?:已)?完成$/)).not.toBeInTheDocument();
        await act(async () => {
          resolveNext(
            method === 'agent.run'
              ? {
                  ...accepted,
                  generation: active,
                  stream: {
                    ...('stream' in accepted ? accepted.stream : {}),
                    generationId: active.generationId,
                  },
                }
              : active,
          );
          await nextRequest;
        });
        expect(await screen.findByTitle('停止生成')).toBeInTheDocument();
        expect(screen.queryByText(/^生成(?:已)?完成$/)).not.toBeInTheDocument();
      },
    );
    it.each([
      ['complete', '回复结束'],
      ['failed', '生成失败'],
      ['cancelled', '生成已停止'],
    ] as const)('reports %s from the actual stream terminal state', async (status, feedback) => {
      const accepted = mockComposerSend('agent.run', Promise.resolve(null));
      if (!('generation' in accepted)) throw new Error('Expected a prepared generation');
      const active = {
        ...accepted,
        generation: {
          ...accepted.generation,
          status: 'streaming' as const,
          executionMode: 'native' as const,
        },
      };
      const baseline = vi.mocked(callWorker).getMockImplementation()!;
      vi.mocked(callWorker).mockImplementation((rpc: string, params: unknown) =>
        rpc === 'agent.run' ? Promise.resolve(active) : baseline(rpc as never, params as never),
      );
      let callbacks!: Parameters<typeof llmClient.streamPreparedLlmGeneration>[1];
      let finish!: () => void;
      vi.spyOn(llmClient, 'streamPreparedLlmGeneration').mockImplementation(
        (prepared, observer) => {
          callbacks = observer;
          return {
            identity: prepared.stream,
            completion: new Promise<void>((resolve) => {
              finish = resolve;
            }),
            cancel: vi.fn().mockResolvedValue(undefined),
            detach: vi.fn(),
          };
        },
      );
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      selectLlm('composer-profile', 'composer-model');
      fireEvent.change(screen.getByRole('textbox', { name: '会话消息' }), {
        target: { value: '生成内容' },
      });
      fireEvent.click(screen.getByTitle('发送消息'));
      await screen.findByTitle('停止生成');
      await act(async () => {
        callbacks.onState({
          ...active.generation,
          status,
          assistantMessage: {
            ...active.generation.assistantMessage,
            status: status === 'complete' ? 'complete' : 'failed',
          },
        });
        finish();
        await Promise.resolve();
      });
      expect(await screen.findAllByText(feedback)).not.toHaveLength(0);
      expect(screen.queryByTitle('停止生成')).not.toBeInTheDocument();
      if (status !== 'complete') expect(screen.queryByText('生成完成')).not.toBeInTheDocument();
    });
  });
  it('turns library drops into real attachments while keeping the composer and discards additions after unmounting', async () => {
    mockComposerSend('agent.run', Promise.resolve(null));
    const baseline = vi.mocked(callWorker).getMockImplementation()!;
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: 'image',
          path: 'D:/assets/reference.png',
          contentType: 'image/png',
        });
      return baseline(method, params);
    });
    const originalFetch = globalThis.fetch;
    delete (
      window as unknown as {
        __TAURI_INTERNALS__?: unknown;
      }
    ).__TAURI_INTERNALS__;
    const readFile = vi.spyOn(FileReader.prototype, 'readAsDataURL');
    const mediaFetch = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    globalThis.fetch = mediaFetch;
    try {
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      const composer = screen.getByRole('textbox', { name: '会话消息' });
      fireEvent.change(composer, { target: { value: '分析这张图' } });
      const raw = JSON.stringify({
        version: 1,
        projectId: 'project',
        assets: [{ id: 'image', kind: 'scene' }],
      });
      fireEvent.drop(composer, {
        dataTransfer: { getData: (type: string) => (type === 'text/plain' ? raw : ''), files: [] },
      });
      const chip = await screen.findByLabelText('已添加附件');
      expect(within(chip).getByText('reference.png')).toBeInTheDocument();
      expect(chip.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AQID');
      expect(composer).toHaveValue('分析这张图');
      expect(callWorker).not.toHaveBeenCalledWith('agent.run', expect.anything());
      expect(callWorker).not.toHaveBeenCalledWith('document.draft.save', expect.anything());
      fireEvent.click(screen.getByLabelText('移除 reference.png'));
      let finish!: (response: Response) => void;
      mediaFetch.mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      );
      fireEvent.drop(composer, { dataTransfer: { getData: () => raw, files: [] } });
      await waitFor(() => expect(mediaFetch).toHaveBeenCalledTimes(2));
      expect(screen.getByTitle('正在读取附件')).toBeDisabled();
      // Unmounting a project view must not commit an async attachment result.
      cleanup();
      act(() => {
        finish(new Response(new Uint8Array([1, 2, 3])));
      });
      expect(screen.queryByLabelText('已添加附件')).not.toBeInTheDocument();
      expect(readFile).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
      readFile.mockRestore();
    }
  });
  it('sends a large PNG compressed to JPEG with consistent attachment metadata', async () => {
    mockComposerSend('agent.run', Promise.resolve(null));
    const image = document.createElement('img');
    Object.defineProperties(image, {
      naturalWidth: { value: 2560 },
      naturalHeight: { value: 1440 },
      src: {
        set() {
          queueMicrotask(() => image.dispatchEvent(new Event('load')));
        },
      },
    });
    const jpeg = 'data:image/jpeg;base64,/9j/';
    const imageConstructor = vi.spyOn(window, 'Image').mockImplementation(function () {
      return image;
    });
    const drawImage = vi.fn();
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    const toDataURL = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(jpeg);
    try {
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      selectLlm('composer-profile', 'composer-model');
      const file = new File([new Uint8Array(2358559)], 'reference.png', { type: 'image/png' });
      fireEvent.change(document.querySelector('input[type="file"]')!, {
        target: { files: [file] },
      });
      const chip = await screen.findByLabelText('已添加附件');
      expect(chip.querySelector('img')).toHaveAttribute('src', jpeg);
      fireEvent.click(screen.getByTitle('发送消息'));
      await waitFor(() =>
        expect(callWorker).toHaveBeenCalledWith(
          'agent.run',
          expect.objectContaining({
            attachments: [{ name: 'reference.png', mimeType: 'image/jpeg', dataUrl: jpeg }],
          }),
        ),
      );
      expect(drawImage).toHaveBeenCalledOnce();
      expect(toDataURL).toHaveBeenCalledWith('image/jpeg', 0.86);
    } finally {
      imageConstructor.mockRestore();
      getContext.mockRestore();
      toDataURL.mockRestore();
    }
  });
  it('continues question forms through ordinary agent.run with a stable key and preserves the composer and attachments', async () => {
    const accepted = mockComposerSend('agent.run', Promise.resolve(null));
    const baseline = vi.mocked(callWorker).getMockImplementation()!;
    let form: AgentInputForm = {
      id: 'question-form',
      taskId: 'question-task',
      conversationId: 'composer-conversation',
      createdAt: '2026-10-24T00:00:02Z',
      key: 'style',
      title: '确认风格',
      status: 'pending',
      questions: [{ id: 'style', prompt: '希望的风格', type: 'text' }],
    };
    const user = {
      id: 'question-user',
      conversationId: form.conversationId,
      role: 'user' as const,
      content: '设计短剧',
      status: 'complete' as const,
      createdAt: '2026-10-24T00:00:00Z',
    };
    const assistant = {
      ...user,
      id: 'question-assistant',
      replyToMessageId: user.id,
      role: 'assistant' as const,
      content: '请确认创作方向。',
      createdAt: '2026-10-24T00:00:01Z',
    };
    const detail: AgentTaskDetail = {
      task: {
        id: form.taskId,
        projectId: 'project',
        conversationId: form.conversationId,
        userMessageId: user.id,
        title: '设计短剧',
        taskType: 'document-query',
        scopeType: 'project',
        status: 'completed',
        phase: 'model_running',
        rowVersion: 1,
        createdAt: user.createdAt,
        updatedAt: form.createdAt,
      },
      events: [
        {
          id: form.id,
          taskId: form.taskId,
          sequence: 0,
          eventType: 'agent.user_input.requested',
          summary: form.title,
          level: 'info',
          createdAt: form.createdAt,
          userInput: form,
        },
      ],
      documents: [],
      providerSteps: [],
      researchSources: [],
    };
    vi.mocked(callWorker).mockImplementation(((
      method: string,
      params: {
        answers?: AgentInputForm['answers'];
      },
    ) => {
      if (method === 'agent.run') {
        form = { ...form, continuationGenerationId: 'composer-generation' };
        return Promise.resolve(accepted);
      }
      if (method === 'agent.task.list') return Promise.resolve([detail.task]);
      if (method === 'agent.task.get') return Promise.resolve(detail);
      if (method === 'chat.message.list') return Promise.resolve({ items: [user, assistant] });
      if (method === 'agent.input.get') return Promise.resolve(form);
      if (method === 'agent.input.submit') {
        form = { ...form, status: 'answered', answers: params.answers };
        return Promise.resolve({
          form,
          prompt: '我已回答：二维动画',
          idempotencyKey: 'question-answer:question-form',
        });
      }
      return baseline(method as never, params as never);
    }) as typeof callWorker);
    const mounted = render(<App />);
    await screen.findByDisplayValue('输入草稿');
    selectLlm('composer-profile', 'composer-model');
    const composer = screen.getByRole('textbox', { name: '会话消息' });
    fireEvent.change(composer, { target: { value: '暂不发送的想法' } });
    fireEvent.change(mounted.container.querySelector('input[type="file"]')!, {
      target: { files: [new File(['笔记'], '笔记.txt', { type: 'text/plain' })] },
    });
    await screen.findByText('笔记.txt');
    fireEvent.change(await screen.findByLabelText('希望的风格：补充回答'), {
      target: { value: '二维动画' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.run'),
      ).toHaveLength(1),
    );
    const params = vi.mocked(callWorker).mock.calls.find(([method]) => method === 'agent.run')![1];
    expect(params).toMatchObject({
      conversationId: 'composer-conversation',
      capability: 'text',
      idempotencyKey: 'question-answer:question-form',
      prompt: '我已回答：二维动画',
    });
    expect(params).not.toHaveProperty('attachments');
    expect(composer).toHaveValue('暂不发送的想法');
    expect(screen.getByText('笔记.txt')).toBeInTheDocument();
  });
  it.each(['chapters-to-script', 'script-to-media'] as const)(
    'launches %s through the same Agent with saved source metadata and preserves the composer',
    async (skillId) => {
      const accepted = mockComposerSend('agent.run', Promise.resolve(null));
      const baseline = vi.mocked(callWorker).getMockImplementation()!;
      const source = {
        id: 'production-source',
        projectId: 'project',
        kind: skillId === 'chapters-to-script' ? 'note' : 'outline',
        title: '制作源资料',
        scopeType: 'project',
        lifecycleStatus: 'active',
        rowVersion: 1,
        currentVersionId: 'source-version',
        createdAt: 'now',
        updatedAt: 'now',
        currentVersion: {
          id: 'source-version',
          documentId: 'production-source',
          version: 1,
          contentMarkdown: '正文必须通过 Agent 按需读取',
          state: 'draft',
          authorType: 'user',
          createdAt: 'now',
        },
      };
      vi.mocked(callWorker).mockImplementation(((method: string, params: unknown) => {
        if (method === 'agent.run') return Promise.resolve(accepted);
        if (method === 'document.list')
          return Promise.resolve(skillId === 'script-to-media' ? [source] : []);
        if (method === 'document.get') return Promise.resolve(source);
        if (method === 'document.versions') return Promise.resolve([]);
        if (method === 'novel.volume.list') return Promise.resolve([]);
        if (method === 'novel.chapter.list')
          return Promise.resolve(
            skillId === 'chapters-to-script'
              ? [
                  {
                    id: 'selected-chapter',
                    projectId: 'project',
                    documentId: source.id,
                    title: source.title,
                    position: 0,
                    displayLabel: '第1章',
                    lifecycleStatus: 'active',
                    documentRowVersion: 1,
                    ragChunkCount: 1,
                    rowVersion: 1,
                    createdAt: 'now',
                    updatedAt: 'now',
                  },
                ]
              : [],
          );
        return baseline(method as never, params as never);
      }) as typeof callWorker);
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      selectLlm('composer-profile', 'composer-model');
      const composer = screen.getByRole('textbox', { name: '会话消息' });
      fireEvent.change(composer, { target: { value: '另外一条未发送的想法' } });
      const nav = screen.getByRole('navigation', { name: '项目导航' });
      fireEvent.click(
        within(nav).getByRole('button', {
          name: skillId === 'chapters-to-script' ? /^小说/ : /^剧本/,
        }),
      );
      if (skillId === 'script-to-media')
        fireEvent.click(await screen.findByRole('button', { name: '打开文档 制作源资料' }));
      const button = await screen.findByRole('button', {
        name: skillId === 'chapters-to-script' ? /一键生成剧本/ : '一键生成制作资料',
      });
      await waitFor(() => expect(button).toBeEnabled());
      fireEvent.click(button);
      await waitFor(() =>
        expect(
          vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.run'),
        ).toHaveLength(1),
      );
      const params = vi
        .mocked(callWorker)
        .mock.calls.find(([method]) => method === 'agent.run')![1] as {
        prompt: string;
        capability: string;
        productionSkillId?: string;
      };
      expect(params.capability).toBe('text');
      expect(params.productionSkillId).toBe(skillId);
      expect(params.prompt).toContain(skillId);
      expect(params.prompt).toContain('source-version');
      expect(params.prompt).toContain(source.id);
      expect(params.prompt).not.toContain(source.currentVersion.contentMarkdown);
      expect(
        vi
          .mocked(callWorker)
          .mock.calls.filter(([method]) =>
            [
              'media.review.prepare',
              'media.image.prepare',
              'media.video.prepare',
              'media.review.submit',
              'media.generation.submit',
              'dubbing.job.submit',
            ].includes(method),
          ),
      ).toHaveLength(0);
      await waitFor(() => expect(composer).toHaveValue('另外一条未发送的想法'));
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
        schemaVersion: 1 as const,
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
        if (method === 'conversation.promptTemplate.get')
          return Promise.resolve({
            conversationId: 'conversation',
            content: '固定清晨与冷色风格',
            rowVersion: 1,
          });
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
      for (const [, params] of submitted) {
        const prompt = (
          params as {
            prompt: string;
          }
        ).prompt;
        expect(prompt.split('【本会话要求约束】')).toHaveLength(2);
        expect(prompt.split('[附件：参考资料.bin]')).toHaveLength(2);
        expect(prompt).toContain('固定清晨与冷色风格');
      }
      if (edit) fireEvent.change(composer, { target: { value: '等待期间编辑的新草稿' } });
      await act(async () => {
        resolveRequest(accepted);
        await response;
      });
      await waitFor(() => expect(composer).toHaveValue(edit ? '等待期间编辑的新草稿' : ''));
    },
  );
  it.each(['agent.run', 'llm.generate', 'chat.message.save'] as const)(
    'saves the latest editable requirements before %s receives the composed prompt',
    async (method) => {
      const accepted = mockComposerSend(method, Promise.resolve(null));
      const baseline = vi.mocked(callWorker).getMockImplementation()!;
      vi.mocked(callWorker).mockImplementation((rpc: string, params: unknown) => {
        if (rpc === 'conversation.promptTemplate.get')
          return Promise.resolve({
            conversationId: 'composer-conversation',
            content: '旧要求',
            rowVersion: 4,
          });
        if (rpc === 'conversation.promptTemplate.save')
          return Promise.resolve({
            conversationId: 'composer-conversation',
            content: '清晨、冷色风格；逐镜写明时间',
            rowVersion: 5,
          });
        if (rpc === method) return Promise.resolve(accepted);
        return baseline(rpc as never, params as never);
      });
      render(<App />);
      await screen.findByDisplayValue('输入草稿');
      if (method === 'agent.run') selectLlm('composer-profile', 'composer-model');
      fireEvent.click(screen.getByText('本会话要求约束'));
      await waitFor(() => expect(screen.getByLabelText('本会话要求约束')).toHaveValue('旧要求'));
      fireEvent.change(screen.getByLabelText('本会话要求约束'), {
        target: { value: '清晨、冷色风格；逐镜写明时间' },
      });
      fireEvent.change(screen.getByRole('textbox', { name: '会话消息' }), {
        target: { value: '编排第一场' },
      });
      fireEvent.click(screen.getByTitle('发送消息'));
      await waitFor(() =>
        expect(callWorker).toHaveBeenCalledWith(
          method,
          expect.objectContaining({
            [method === 'chat.message.save' ? 'content' : 'prompt']:
              '【本会话要求约束】\n清晨、冷色风格；逐镜写明时间\n\n【用户本次请求】\n编排第一场',
          }),
        ),
      );
      const methods = vi.mocked(callWorker).mock.calls.map(([rpc]) => rpc);
      expect(methods.indexOf('conversation.promptTemplate.save')).toBeLessThan(
        methods.indexOf(method),
      );
      expect(callWorker).toHaveBeenCalledWith('conversation.promptTemplate.save', {
        conversationId: 'composer-conversation',
        content: '清晨、冷色风格；逐镜写明时间',
        expectedRowVersion: 4,
      });
    },
  );
  it('renders the M2 workspace areas and runtime health', async () => {
    const { container } = await renderProjectWorkspace();
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
  it('toggles the conversation window from the topbar', async () => {
    const { container } = await renderProjectWorkspace();
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
      heading: '场次与镜头',
      close: '关闭场次与镜头',
    },
    {
      nav: '任务日志',
      heading: '任务日志',
      close: '关闭任务日志',
    },
  ])(
    'closes the $heading page and reopens it from project navigation',
    async ({ nav, heading, close }) => {
      const { container } = await renderProjectWorkspace();
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
  it('closes and reopens the asset library without replacing the project page', async () => {
    const { container } = await renderProjectWorkspace();
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    const openAssets = () =>
      fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    const editorPage = container.querySelector('.workspace-editor-page');
    openAssets();
    expect(container.querySelector('.workspace-assets-page')).toBeVisible();
    expect(container.querySelector('.workspace-assets-page')).not.toHaveTextContent(
      '请打开一个项目',
    );
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
    async (page) => {
      const { container } = await renderProjectWorkspace();
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list')
        return Promise.resolve([
          { project: currentProject, projectSessionId: 'session-b', active: true, state: 'ready' },
        ]);
      if (method === 'conversation.runtime.list') return Promise.resolve([]);
      if (method === 'project.current') return Promise.resolve(currentProject);
      if (method === 'project.runtime.attach' || method === 'project.runtime.activate') {
        currentProject = secondProject;
        return Promise.resolve({
          project: currentProject,
          projectSessionId: 'session-b',
          active: true,
          state: 'ready',
        });
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
    const topbar = container.querySelector('.topbar') as HTMLElement;
    fireEvent.click(within(topbar).getByRole('button', { name: '选择项目' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /浏览项目目录/ }));
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
  it('keeps conversation docked beside assets and production and reopens it from the topbar', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1100 });
    const { container } = await renderProjectWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '文生图' }));
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    expect(container.querySelector('.workspace-assets-page')).toBeVisible();
    expect(container.querySelector('.workspace-conversation-page')).toBeVisible();
    expect(container.querySelector('.floating-window-conversation')).not.toBeInTheDocument();
    const toggle = within(container.querySelector('.topbar-actions') as HTMLElement).getByRole(
      'button',
      { name: '收起会话' },
    );
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
    expect(
      within(container.querySelector('.topbar-actions') as HTMLElement).getByRole('button', {
        name: '打开会话',
      }),
    ).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(
      within(container.querySelector('.topbar-actions') as HTMLElement).getByRole('button', {
        name: '打开会话',
      }),
    );
    expect(container.querySelector('.workspace-conversation-page')).toBeVisible();
    expect(container.querySelector('.workspace-assets-page')).toBeVisible();
    fireEvent.click(
      within(container.querySelector('.topbar-actions') as HTMLElement).getByRole('button', {
        name: '收起会话',
      }),
    );
    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
    expect(container.querySelector('.workspace-assets-page')).toBeVisible();
  });
  it('shows the project startup layout and validates the create form before creating', async () => {
    const { container } = render(<App />);
    const startup = await screen.findByRole('region', { name: '项目启动页' });
    expect(container.querySelector('.app-shell')).toHaveAttribute('data-startup', 'true');
    expect(container.querySelector('.app-shell')).toHaveAttribute('data-theme', 'light');
    expect(
      within(screen.getByRole('navigation', { name: '项目导航' })).getByRole('button', {
        name: '小说',
      }),
    ).toBeDisabled();
    expect(screen.queryByRole('region', { name: '项目 AI 助手' })).not.toBeInTheDocument();
    expect(screen.queryByText('待命')).not.toBeInTheDocument();
    expect(container.querySelector('.workspace-conversation-page')).not.toBeInTheDocument();
    fireEvent.click(within(startup).getByRole('button', { name: '新建项目' }));
    expect(screen.getByRole('dialog', { name: '新建项目' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建项目' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('项目绝对目录'), {
      target: { value: 'D:\\Projects\\new-project' },
    });
    expect(screen.getByRole('button', { name: '创建项目' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog', { name: '新建项目' })).not.toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('project.create', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith('project.runtime.attach', expect.anything());
  });
  it('filters recent projects and exposes them from the project picker', async () => {
    const baselineWorker = vi.mocked(callWorker).getMockImplementation()!;
    const recentProjects = [
      {
        name: '雾港来信',
        rootPath: 'D:\\Projects\\fog-letter',
        lastOpenedAt: '2026-10-30T06:32:00.000Z',
      },
      {
        name: '夏日放映室',
        rootPath: 'D:\\Projects\\summer-screening',
        lastOpenedAt: '2026-10-29T11:08:00.000Z',
      },
    ];
    vi.mocked(callWorker).mockImplementation((method, params) =>
      method === 'project.recent'
        ? Promise.resolve(recentProjects)
        : baselineWorker(method, params),
    );
    render(<App />);
    expect(await screen.findByRole('button', { name: '雾港来信' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: '搜索最近项目' }), {
      target: { value: '夏日' },
    });
    expect(screen.getByRole('button', { name: '夏日放映室' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '雾港来信' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选择项目' }));
    expect(screen.getByRole('menuitem', { name: /雾港来信/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /浏览项目目录/ })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /新建项目/ })).toBeInTheDocument();
  });
  it('renames the open project from the project menu', async () => {
    const baselineWorker = vi.mocked(callWorker).getMockImplementation()!;
    let currentProject = {
      id: 'rename-project',
      name: '修改前名称',
      rootPath: 'D:\\Projects\\rename-project',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 7,
    };
    let recentProjects = [
      { name: currentProject.name, rootPath: currentProject.rootPath, lastOpenedAt: 'now' },
    ];
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'project.current') return Promise.resolve(currentProject);
      if (method === 'project.runtime.list')
        return Promise.resolve([
          {
            project: currentProject,
            projectSessionId: 'rename-session',
            active: true,
            state: 'ready',
          },
        ]);
      if (method === 'project.recent') return Promise.resolve(recentProjects);
      if (method === 'project.rename') {
        currentProject = {
          ...currentProject,
          name: (
            params as {
              name: string;
            }
          ).name,
        };
        recentProjects = recentProjects.map((recent) => ({ ...recent, name: currentProject.name }));
        return Promise.resolve(currentProject);
      }
      if (method === 'conversation.runtime.list') return Promise.resolve([]);
      if (
        [
          'document.list',
          'scene.list',
          'constraint.list',
          'asset.list',
          'novel.chapter.list',
          'characterVoice.list',
        ].includes(method)
      )
        return Promise.resolve([]);
      return baselineWorker(method, params);
    });
    const { container } = render(<App />);
    await screen.findAllByText('修改前名称');
    expect(document.querySelector('.app-shell')).not.toHaveAttribute('data-theme');
    expect(screen.queryByRole('region', { name: '项目管理' })).not.toBeInTheDocument();
    const topbar = container.querySelector('.topbar') as HTMLElement;
    fireEvent.click(within(topbar).getByRole('button', { name: '选择项目' }));
    expect(screen.getByRole('menuitem', { name: '完整性检查' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '备份项目' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '关闭项目' })).toBeInTheDocument();
    expect(within(topbar).queryByTitle('打开项目')).not.toBeInTheDocument();
    expect(within(topbar).queryByTitle('新建项目')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: '修改项目名称' }));
    fireEvent.change(screen.getByRole('textbox', { name: '项目名称' }), {
      target: { value: '修改后名称' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    expect(await screen.findAllByText('修改后名称')).not.toHaveLength(0);
    expect(screen.queryByRole('dialog', { name: '修改项目名称' })).not.toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.some(
        ([method, params]) =>
          method === 'project.rename' &&
          (
            params as {
              name?: string;
            }
          ).name === '修改后名称',
      ),
    ).toBe(true);
  });
  it('selects a project directory with the native folder dialog before opening', async () => {
    vi.mocked(openDialog).mockResolvedValue('D:\\Projects\\existing-project');
    const { container } = render(<App />);
    const topbar = container.querySelector('.topbar') as HTMLElement;
    fireEvent.click(within(topbar).getByRole('button', { name: '选择项目' }));
    fireEvent.click(screen.getByRole('menuitem', { name: /浏览项目目录/ }));
    expect(openDialog).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择要打开的项目目录',
    });
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('project.runtime.attach', {
        rootPath: 'D:\\Projects\\existing-project',
      }),
    );
  });
  it('creates and opens one initial conversation for a newly created project', async () => {
    const project = {
      id: 'new-project',
      name: 'New Project',
      rootPath: 'D:\\Projects\\new-project',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 1 as const,
    };
    const runtime = {
      project,
      projectSessionId: 'new-project-session',
      active: true,
      state: 'ready' as const,
    };
    const conversation: ConversationInfo = {
      id: 'new-project-conversation',
      projectId: project.id,
      scopeType: 'project',
      title: '新会话',
      createdAt: 'now',
      updatedAt: 'now',
    };
    vi.mocked(callWorker).mockImplementation((method: string) => {
      if (method === 'project.current') return Promise.resolve(null);
      if (method === 'project.recent') return Promise.resolve([]);
      if (method === 'project.runtime.create') return Promise.resolve(runtime);
      if (method === 'project.runtime.list') return Promise.resolve([runtime]);
      if (method === 'conversation.create') return Promise.resolve(conversation);
      if (method === 'conversation.list') return Promise.resolve({ items: [conversation] });
      if (method === 'chat.message.list') return Promise.resolve({ items: [] });
      if (method === 'context.preview')
        return Promise.resolve({
          version: 1,
          scopeType: 'project',
          scopeLabel: project.name,
          estimatedTokens: 0,
          budgetTokens: 1000,
          sources: [],
        });
      if (method === 'conversation.runtime.list' || method === 'agent.task.list')
        return Promise.resolve([]);
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
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
      if (
        [
          'document.list',
          'scene.list',
          'constraint.list',
          'asset.list',
          'video.generate.list',
          'novel.chapter.list',
          'novel.volume.list',
          'characterVoice.list',
          'provider.profile.list',
        ].includes(method)
      )
        return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<App />);
    const startup = screen.getByRole('region', { name: '项目启动页' });
    fireEvent.click(within(startup).getByRole('button', { name: '新建项目' }));
    const dialog = screen.getByRole('dialog', { name: '新建项目' });
    fireEvent.change(within(dialog).getByLabelText('项目名称'), {
      target: { value: project.name },
    });
    fireEvent.change(within(dialog).getByLabelText('项目绝对目录'), {
      target: { value: project.rootPath },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: '创建项目' }));
    expect(await screen.findByDisplayValue('新会话')).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'conversation.create'),
    ).toHaveLength(1);
    expect(
      vi.mocked(callWorker).mock.calls.find(([method]) => method === 'conversation.create')?.[1],
    ).toEqual({ scopeType: 'project' });
  });
  it('opens an existing project with its existing conversation and creates no new one', async () => {
    const project = {
      id: 'existing-project',
      name: 'Existing Project',
      rootPath: 'D:\\Projects\\existing-project',
      createdAt: 'now',
      updatedAt: 'now',
      mode: 'read-write' as const,
      schemaVersion: 1 as const,
    };
    const runtime = {
      project,
      projectSessionId: 'existing-project-session',
      active: true,
      state: 'ready' as const,
    };
    const recent = {
      name: project.name,
      rootPath: project.rootPath,
      lastOpenedAt: '2026-10-29T00:00:00.000Z',
    };
    const conversation: ConversationInfo = {
      id: 'existing-project-conversation',
      projectId: project.id,
      scopeType: 'project',
      title: 'Existing Conversation',
      createdAt: 'now',
      updatedAt: 'now',
    };
    vi.mocked(callWorker).mockImplementation((method: string) => {
      if (method === 'project.current') return Promise.resolve(null);
      if (method === 'project.recent') return Promise.resolve([recent]);
      if (method === 'project.runtime.attach' || method === 'project.runtime.activate')
        return Promise.resolve(runtime);
      if (method === 'project.runtime.list') return Promise.resolve([runtime]);
      if (method === 'conversation.list') return Promise.resolve({ items: [conversation] });
      if (method === 'chat.message.list') return Promise.resolve({ items: [] });
      if (method === 'context.preview')
        return Promise.resolve({
          version: 1,
          scopeType: 'project',
          scopeLabel: project.name,
          estimatedTokens: 0,
          budgetTokens: 1000,
          sources: [],
        });
      if (method === 'conversation.runtime.list' || method === 'agent.task.list')
        return Promise.resolve([]);
      if (method === 'adapter.catalog')
        return Promise.resolve({ capabilities: [], providers: [], adapters: [] });
      if (method === 'llm.status')
        return Promise.resolve({
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        });
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
      if (
        [
          'document.list',
          'scene.list',
          'constraint.list',
          'asset.list',
          'video.generate.list',
          'novel.chapter.list',
          'novel.volume.list',
          'characterVoice.list',
          'provider.profile.list',
        ].includes(method)
      )
        return Promise.resolve([]);
      return Promise.resolve(null);
    });
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: '打开项目：Existing Project' }));
    expect(await screen.findByDisplayValue('Existing Conversation')).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.some(([method]) => method === 'conversation.create'),
    ).toBe(false);
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '导入 Markdown' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '导入 Markdown' }));
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
    const importedPreview = await screen.findByRole('region', { name: '文档内容预览' });
    expect(importedPreview).toHaveTextContent('故事开始。');
    fireEvent.click(importedPreview);
    expect(await screen.findByLabelText('文档内容')).toHaveValue('# 第一章\n\n故事开始。');
    expect(screen.getByText('已导入为草稿 第一章 · 版本 v1')).toBeInTheDocument();
  });
  it('expands production UI across the central workspace when a production mode is selected', async () => {
    const { container } = await renderProjectWorkspace();
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
  it('keeps production open while switching the adjacent project page', async () => {
    const { container } = await renderProjectWorkspace();
    fireEvent.click(screen.getByRole('button', { name: '文生图' }));
    fireEvent.click(
      within(screen.getByRole('navigation', { name: '项目导航' })).getByRole('button', {
        name: /^小说/,
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
    async (page) => {
      window.localStorage.removeItem('ai-video.production-capability');
      const { container } = await renderProjectWorkspace();
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
  it('keeps the asset library and project page open beside production', async () => {
    const { container } = await renderProjectWorkspace();
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
    expect(await screen.findByRole('region', { name: '章节内容预览' })).toHaveTextContent(
      '仅属于小说页面的正文',
    );
    expect(screen.queryByLabelText('文档内容')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '在文档工作区打开' })).not.toBeInTheDocument();
    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    expect(screen.queryByDisplayValue('仅属于小说页面的正文')).not.toBeInTheDocument();
    expect(screen.queryByText(chapter.title)).not.toBeInTheDocument();
  });
  it('offers a sample project on first use and sends the selected absolute path', async () => {
    render(<App />);
    const startup = await screen.findByRole('region', { name: '项目启动页' });
    await screen.findByText('暂无最近项目');
    fireEvent.click(within(startup).getByRole('button', { name: '新建项目' }));
    const sampleButton = await screen.findByRole('button', { name: '创建示例项目' });
    expect(sampleButton).toBeDisabled();
    fireEvent.change(screen.getByLabelText('项目绝对目录'), {
      target: { value: 'D:\\Projects\\sample-drama' },
    });
    fireEvent.click(sampleButton);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('project.runtime.createSample', {
        rootPath: 'D:\\Projects\\sample-drama',
        name: '我的短剧',
      }),
    );
  });
  it('keeps observing the running parent when a newer document is waiting for review', async () => {
    mockComposerSend('chat.message.save', Promise.resolve(null));
    const baselineWorker = vi.mocked(callWorker).getMockImplementation()!;
    const active: AgentTaskDetail = {
      task: {
        id: 'active-parent',
        projectId: 'project',
        conversationId: 'composer-conversation',
        userMessageId: 'original-user',
        taskType: 'document-query',
        scopeType: 'project',
        title: '正在修订',
        status: 'running',
        phase: 'model_running',
        rowVersion: 1,
        createdAt: '2026-10-16T12:40:00Z',
        updatedAt: '2026-10-16T12:40:01Z',
      },
      events: [],
      documents: [],
      providerSteps: [],
      researchSources: [],
    };
    const review: AgentTaskDetail = {
      ...active,
      task: {
        ...active.task,
        id: 'newer-review',
        status: 'waiting_review',
        phase: 'waiting_review',
        updatedAt: '2026-10-16T12:40:02Z',
      },
    };
    let finished = false;
    let resolveEvents!: (result: unknown) => void;
    const events = new Promise<unknown>((resolve) => {
      resolveEvents = resolve;
    });
    vi.mocked(callWorker).mockImplementation(((
      method: string,
      params: {
        taskId?: string;
      },
    ) => {
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'agent.task.list') return Promise.resolve([review.task, active.task]);
      if (method === 'agent.task.get')
        return Promise.resolve(
          params.taskId === review.task.id
            ? review
            : { ...active, task: { ...active.task, status: finished ? 'completed' : 'running' } },
        );
      if (method === 'agent.task.events') return events;
      return baselineWorker(method as never, params as never);
    }) as typeof callWorker);
    render(<App />);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'agent.task.events',
        expect.objectContaining({ taskId: active.task.id }),
      ),
    );
    fireEvent.change(screen.getByRole('textbox', { name: '会话消息' }), {
      target: { value: '？' },
    });
    expect(screen.getByTitle('上一轮仍在执行')).toBeDisabled();
    await act(async () => {
      finished = true;
      resolveEvents({ task: { ...active.task, status: 'completed' }, events: [], nextSequence: 0 });
      await events;
    });
    await waitFor(() => expect(screen.getByTitle('发送消息')).toBeEnabled());
    expect(screen.getByRole('textbox', { name: '会话消息' })).toHaveValue('？');
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
        return (
          params as {
            scopeType: string;
          }
        ).scopeType === 'project'
          ? projectConversations.then((items) => ({ items }))
          : Promise.resolve({ items: [sceneConversation] });
      }
      if (method === 'chat.message.list') {
        const conversationId = (
          params as {
            conversationId: string;
          }
        ).conversationId;
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
        const conversationId = (
          params as {
            conversationId: string;
          }
        ).conversationId;
        return Promise.resolve({
          version: 1,
          scopeType: conversationId === sceneConversation.id ? 'scene' : 'project',
          scopeId: conversationId === sceneConversation.id ? 'scene' : undefined,
          scopeLabel: 'scope',
          estimatedTokens: 1,
          budgetTokens: 1000,
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
        const conversationId = (
          params as {
            conversationId: string;
          }
        ).conversationId;
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
          budgetTokens: 1000,
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
    let sceneProposalGenerated = false;
    let sceneRowVersion = 0;
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
              status: 'applied',
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
          (
            params as {
              includeTerminal?: boolean;
            }
          ).includeTerminal && sceneProposalGenerated
            ? [
                {
                  ...sceneProposal,
                  status: 'applied',
                  items: sceneProposal.items.map((item) => ({
                    ...item,
                    status: 'applied',
                    appliedEntityId: item.entityType === 'scene' ? 'applied-scene' : 'applied-shot',
                  })),
                },
              ]
            : [],
        );
      if (method === 'scene.list' && isSceneProposal)
        return Promise.resolve(
          sceneProposalGenerated
            ? [
                {
                  id: 'applied-scene',
                  projectId: 'project',
                  title: '生成的庭院',
                  prompt: '司机转身，他没有开口。',
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

            ...{
              prompt: '清晨的庭院镜头提示词',
              bindings: {
                schemaVersion: 1 as const,
                ...{
                  characterDocumentIds: [],
                  sceneDocumentIds: [createdDocument.id],
                  propDocumentIds: [],
                },
              },
            },
            position: 0,
            status: 'draft',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ]);
      if (method === 'scene.save' && isSceneProposal) {
        const prompt = (
          params as {
            prompt?: string;
          }
        ).prompt;
        sceneRowVersion += 1;
        return Promise.resolve({
          id: 'applied-scene',
          projectId: 'project',
          title: '生成的庭院',
          position: 0,
          rowVersion: sceneRowVersion,
          ...(prompt ? { prompt } : {}),
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
          content: (
            params as {
              content: string;
            }
          ).content,
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
          budgetTokens: 1000,
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
      if (
        method === 'agent.run' &&
        (
          params as {
            prompt?: string;
          }
        ).prompt === '续写小说下一章'
      ) {
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
        const run = params as {
          providerProfileId?: string;
          modelId?: string;
        };
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
      expect(screen.queryByRole('button', { name: '批准并写入目录' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('场次与镜头待审核方案')).not.toBeInTheDocument();
      expect(await screen.findByRole('button', { name: '生成的庭院' })).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: '庭院远景' })).toBeInTheDocument();
      expect(await screen.findByText('清晨的庭院镜头提示词')).toBeInTheDocument();
      expect(callWorker).not.toHaveBeenCalledWith('agent.changeSet.apply', expect.anything());
      expect(screen.queryByLabelText('场次完整视频提示词')).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: '生成的庭院' }));
      expect(
        await screen.findByRole('region', { name: '场次完整视频提示词预览' }),
      ).toHaveTextContent('司机转身，他没有开口。');
      expect(screen.queryByLabelText('镜头提示词')).not.toBeInTheDocument();
      expect(
        within(screen.getByLabelText('场次与镜头目录')).queryByLabelText('场次绑定场景'),
      ).not.toBeInTheDocument();
      expect(callWorker).toHaveBeenCalledWith('shot.list', { sceneId: 'applied-scene' });
      const bindingSummary = screen.getByLabelText('镜头绑定汇总');
      expect(within(bindingSummary).getByText(createdDocument.title)).toBeInTheDocument();
      expect(within(bindingSummary).getByText('庭院远景')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('region', { name: '场次完整视频提示词预览' }));
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
          'scene.save',
          expect.objectContaining({
            sceneId: 'applied-scene',
            prompt: '司机走进屋内，他坐下。',
            expectedRowVersion: 0,
          }),
        ),
      );
      expect(
        vi.mocked(callWorker).mock.calls.some(
          ([method, params]) =>
            method === 'scene.save' &&
            (
              params as {
                sceneDocumentIds?: string[];
              }
            ).sceneDocumentIds !== undefined,
        ),
      ).toBe(false);
      return;
    }
    if (isNovelReference) {
      expect(await screen.findByRole('region', { name: '小说资料内容预览' })).toHaveTextContent(
        'Agent 桌面人工测试成功',
      );
      expect(
        screen.getByRole('button', {
          name: `编辑小说资料标题 ${createdDocument.title}`,
        }),
      ).toBeInTheDocument();
      expect(
        screen
          .getAllByRole('button', { name: /^小说/ })
          .find((item) => item.classList.contains('nav-item')),
      ).toHaveClass('active');
      expect(callWorker).toHaveBeenCalledWith('document.get', { documentId: createdDocument.id });
      expect(
        vi.mocked(callWorker).mock.calls.some(
          ([method, params]) =>
            method === 'document.get' &&
            (
              params as {
                documentId: string;
              }
            ).documentId === 'other-task-document',
        ),
      ).toBe(false);
      return;
    }
    if (isChapter) {
      expect(await screen.findByRole('region', { name: '章节内容预览' })).toHaveTextContent(
        'Agent 桌面人工测试成功',
      );
      expect(screen.queryByLabelText('文档内容')).not.toBeInTheDocument();
      expect(callWorker).toHaveBeenCalledWith(
        'agent.task.get',
        { taskId: prepared.agentTaskId },
        { projectId: 'project', projectSessionId: 'session' },
      );
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
      await act(async () => {
        await Promise.resolve();
      });
      await waitFor(() => expect(screen.getByLabelText('会话消息')).toHaveValue(''));
      expect(screen.getByRole('region', { name: '章节内容预览' })).toHaveTextContent(
        'Agent 桌面人工测试成功',
      );
      return;
    }
    expect((await screen.findAllByText(createdDocument.title)).length).toBeGreaterThan(0);
    expect(
      await screen.findByRole('button', {
        name: `编辑文档标题 ${createdDocument.title}`,
      }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: '提示词预览' })).toHaveTextContent(
      'Agent 桌面人工测试成功',
    );
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
    const archivedOutlineSummary = {
      id: 'd-outline',
      projectId: 'project',
      kind: 'outline' as const,
      title: '项目大纲',
      scopeType: 'project' as const,
      lifecycleStatus: 'archived' as const,
      rowVersion: 1,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const archivedOutlineDetail = {
      ...archivedOutlineSummary,
      currentVersionId: 'd-outline-v1',
      currentVersion: {
        id: 'd-outline-v1',
        documentId: 'd-outline',
        version: 1,
        contentMarkdown: '剧本专属正文',
        state: 'draft' as const,
        authorType: 'user' as const,
        createdAt: 'now',
      },
    };
    let outlineArchived = false;
    vi.mocked(callWorker).mockImplementation((method: string, params: unknown) => {
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
      if (method === 'document.archived.list')
        return Promise.resolve(outlineArchived ? [archivedOutlineSummary] : []);
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
            id: 'd-constraint',
            projectId: 'project',
            kind: 'constraint',
            title: '剧情约束',
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
        const isCharacter =
          (
            params as {
              documentId: string;
            }
          ).documentId === 'd-character';
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
      if (method === 'document.archive') {
        outlineArchived = true;
        return Promise.resolve(archivedOutlineDetail);
      }
      if (method === 'document.unarchive') {
        outlineArchived = false;
        return Promise.resolve({ ...archivedOutlineDetail, lifecycleStatus: 'active' as const });
      }
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
    expect(screen.getByText('剧情约束')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '项目文档' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '剧本编辑器' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '一键生成制作资料' })).toHaveClass(
      'production-generate-button',
      'primary',
    );
    expect(screen.getByRole('button', { name: '新建' })).toHaveClass('secondary');
    expect(screen.getByRole('button', { name: '保存并发布' })).toHaveClass('secondary');
    expect(screen.getByRole('region', { name: '文档内容预览' })).toBeInTheDocument();
    expect(screen.queryByLabelText('文档类型')).not.toBeInTheDocument();
    expect(screen.queryByText(/不会发给生图或生视频/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成角色图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '填充本镜图片表单' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('文档类型')).not.toBeInTheDocument();
    expect(screen.queryByText('角色设定')).not.toBeInTheDocument();
    expect(screen.queryByText('场景设定')).not.toBeInTheDocument();
    expect(screen.queryByText('小说章节一')).not.toBeInTheDocument();
    expect(screen.queryByText('第一集分镜')).not.toBeInTheDocument();
    expect(screen.getByText('所有镜头保持冷色调')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^角色与场景/ }));
    expect(screen.getByText('角色设定')).toBeInTheDocument();
    expect(screen.getByText('场景设定')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('选择文档 角色设定'));
    fireEvent.click(screen.getByLabelText('选择文档 场景设定'));
    expect(screen.getByText('已选 2 项')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
    expect(screen.queryByText('项目大纲')).not.toBeInTheDocument();
    expect(screen.queryByText('生产约束记录')).not.toBeInTheDocument();
    expect(screen.queryByText('所有镜头保持冷色调')).not.toBeInTheDocument();
    const projectNav = screen.getByRole('navigation', { name: '项目导航' });
    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    const scriptFilters = screen.getByRole('group', { name: '文档类型筛选' });
    expect(within(scriptFilters).getByRole('button', { name: '全部' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    fireEvent.click(within(scriptFilters).getByRole('button', { name: '约束' }));
    expect(screen.getByText('剧情约束')).toBeInTheDocument();
    expect(screen.queryByText('项目计划')).not.toBeInTheDocument();
    fireEvent.click(within(scriptFilters).getByRole('button', { name: '全部' }));
    fireEvent.click(within(projectNav).getByRole('button', { name: /^角色与场景/ }));
    const filters = screen.getByRole('group', { name: '文档类型筛选' });
    fireEvent.click(within(filters).getByRole('button', { name: '角色' }));
    expect(screen.getByText('角色设定')).toBeInTheDocument();
    expect(screen.queryByText('场景设定')).not.toBeInTheDocument();
    fireEvent.click(within(filters).getByRole('button', { name: '场景' }));
    expect(screen.getByText('场景设定')).toBeInTheDocument();
    expect(screen.queryByText('角色设定')).not.toBeInTheDocument();
    fireEvent.click(within(filters).getByRole('button', { name: '全部' }));
    expect(screen.getByText('角色设定')).toBeInTheDocument();
    expect(screen.getByText('场景设定')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开文档 角色设定' }));
    expect(await screen.findByRole('region', { name: '提示词预览' })).toHaveTextContent(
      '角色专属正文',
    );
    expect(screen.queryByLabelText('标题')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '编辑文档标题 角色设定' }));
    const characterTitleInput = screen.getByRole('textbox', { name: '文档标题' });
    fireEvent.change(characterTitleInput, { target: { value: '临时角色名' } });
    fireEvent.keyDown(characterTitleInput, { key: 'Escape' });
    expect(screen.getByRole('button', { name: '编辑文档标题 角色设定' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('region', { name: '提示词预览' }));
    fireEvent.change(screen.getByLabelText('提示词'), {
      target: { value: '未保存的角色修改' },
    });
    fireEvent.blur(screen.getByLabelText('提示词'));
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent(
      '未保存的角色修改',
    );
    fireEvent.click(screen.getByLabelText('关闭素材库'));
    expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent(
      '未保存的角色修改',
    );
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent(
      '未保存的角色修改',
    );
    fireEvent.change(screen.getByPlaceholderText('搜索别名、文件名或标签'), {
      target: { value: '夜景素材' },
    });
    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    expect(screen.queryByText('角色设定')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '提示词预览' })).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('搜索别名、文件名或标签')).toHaveValue('夜景素材');
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: '文档在独立窗口打开' })).not.toBeInTheDocument();
    fireEvent.click(within(projectNav).getByRole('button', { name: /^角色与场景/ }));
    expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent(
      '未保存的角色修改',
    );
    expect(screen.getByPlaceholderText('搜索别名、文件名或标签')).toHaveValue('夜景素材');
    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    fireEvent.click(screen.getByRole('button', { name: /项目大纲/ }));
    expect(await screen.findByRole('region', { name: '文档内容预览' })).toHaveTextContent(
      '剧本专属正文',
    );
    expect(screen.getByRole('heading', { name: '项目大纲' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '剧本' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('region', { name: '文档内容预览' }));
    expect(await screen.findByDisplayValue('剧本专属正文')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('文档内容'), {
      target: { value: '未保存的剧本修改' },
    });
    fireEvent.blur(screen.getByLabelText('文档内容'));
    expect(screen.getByRole('region', { name: '文档内容预览' })).toHaveTextContent(
      '未保存的剧本修改',
    );
    fireEvent.click(screen.getByLabelText('关闭素材库'));
    expect(screen.getByRole('region', { name: '文档内容预览' })).toHaveTextContent(
      '未保存的剧本修改',
    );
    expect(screen.queryByLabelText('文档内容')).not.toBeInTheDocument();
    fireEvent.click(within(projectNav).getByRole('button', { name: /^素材库/ }));
    expect(screen.getByRole('region', { name: '文档内容预览' })).toHaveTextContent(
      '未保存的剧本修改',
    );
    fireEvent.click(within(projectNav).getByRole('button', { name: /^角色与场景/ }));
    expect(screen.queryByDisplayValue('未保存的剧本修改')).not.toBeInTheDocument();
    expect(screen.queryByText('项目大纲')).not.toBeInTheDocument();
    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    const documentDirectory = screen.getByRole('complementary', { name: '项目文档目录' });
    expect(within(documentDirectory).queryByText('文档', { exact: true })).not.toBeInTheDocument();
    expect(
      within(documentDirectory).queryByRole('button', { name: /新建/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(documentDirectory).getByRole('button', { name: '编辑文档标题 项目大纲' }),
    );
    const titleInput = screen.getByRole('textbox', { name: '文档标题' });
    fireEvent.change(titleInput, { target: { value: '临时标题' } });
    expect(titleInput).toHaveValue('临时标题');
    fireEvent.keyDown(titleInput, { key: 'Escape' });
    expect(screen.getByRole('button', { name: /编辑文档标题 项目大纲/ })).toBeInTheDocument();
    expect(await screen.findByRole('region', { name: '文档内容预览' })).toHaveTextContent(
      '未保存的剧本修改',
    );
    fireEvent.mouseEnter(screen.getByRole('button', { name: '编辑文档标题 项目大纲' }));
    fireEvent.click(screen.getByRole('button', { name: '归档文档“项目大纲”' }));
    const confirmation = screen.getByRole('dialog', { name: '归档文档？' });
    fireEvent.click(within(confirmation).getByRole('button', { name: '放弃更改并归档' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('document.archive', {
        documentId: 'd-outline',
        expectedDocumentRowVersion: 0,
      }),
    );
    fireEvent.click(within(projectNav).getByRole('button', { name: /^剧本/ }));
    const lifecycleFilters = screen.getByRole('group', { name: '文档生命周期筛选' });
    fireEvent.click(within(lifecycleFilters).getByRole('button', { name: '已归档' }));
    expect(screen.getByText('项目大纲')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '恢复文档“项目大纲”' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('document.unarchive', {
        documentId: 'd-outline',
        expectedDocumentRowVersion: archivedOutlineSummary.rowVersion,
      }),
    );
    expect(await screen.findByRole('region', { name: '文档内容预览' })).toBeInTheDocument();
    fireEvent.click(
      within(screen.getByRole('group', { name: '文档类型筛选' })).getByRole('button', {
        name: '大纲',
      }),
    );
    fireEvent.click(screen.getByLabelText('选择文档 项目大纲'));
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
    expect(screen.getByRole('dialog', { name: '删除所选草稿？' })).toHaveTextContent('项目大纲');
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'document.archive'),
      ).toHaveLength(2),
    );
  });
  it('publishes an edited document in one action without a separate review step', async () => {
    vi.mocked(callWorker).mockImplementation((method: string, params?: unknown) => {
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
    fireEvent.click(await screen.findByRole('button', { name: '打开文档 项目大纲' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '保存并发布' })).toBeEnabled());
    fireEvent.click(await screen.findByRole('region', { name: '文档内容预览' }));
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
  it.each(['character', 'scene'] as const)(
    'strictly filters the directory while preserving the opened %s editor',
    async (kind) => {
      const title = kind === 'scene' ? '场景板·屋外雨坪' : '角色设定';
      vi.mocked(callWorker).mockImplementation((method: string) => {
        if (method === 'conversation.promptTemplate.get')
          return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
        if (method === 'project.runtime.list')
          return Promise.resolve([
            {
              project: {
                id: 'project',
                name: 'Filter Project',
                rootPath: 'D:\\Filter',
                createdAt: 'now',
                updatedAt: 'now',
                mode: 'read-write',
                schemaVersion: 4,
              },
              projectSessionId: 'filter-project-session',
              active: true,
              state: 'ready',
            },
          ]);
        if (method === 'conversation.runtime.list') return Promise.resolve([]);
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
              kind,
              title,
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
            kind,
            title,
            scopeType: 'project',
            lifecycleStatus: 'active',
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
            currentVersion: {
              id: 'v-1',
              version: 1,
              state: 'draft',
              contentMarkdown: `# ${title}`,
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
      await screen.findByText('项目大纲');
      fireEvent.click(screen.getByRole('button', { name: /^角色与场景/ }));
      fireEvent.click(
        await screen.findByRole('button', {
          name: new RegExp(`^(打开文档|编辑文档标题) ${title}$`),
        }),
      );
      const preview = await screen.findByRole('region', { name: '提示词预览' });
      fireEvent.click(preview);
      fireEvent.change(screen.getByLabelText('提示词'), {
        target: { value: '尚未保存的编辑内容' },
      });
      fireEvent.blur(screen.getByLabelText('提示词'));
      const filters = screen.getByRole('group', { name: '文档类型筛选' });
      const directory = screen.getByRole('complementary', { name: '项目文档目录' });
      for (const label of ['道具', kind === 'scene' ? '角色' : '场景']) {
        fireEvent.click(within(filters).getByRole('button', { name: label }));
        expect(within(directory).queryByText('项目大纲')).not.toBeInTheDocument();
        expect(within(directory).queryByText(title)).not.toBeInTheDocument();
        expect(within(directory).getByText(`暂无${label}类型文档`)).toBeInTheDocument();
        expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent(
          '尚未保存的编辑内容',
        );
      }
      fireEvent.click(within(filters).getByRole('button', { name: '全部' }));
      expect(within(directory).getByText(title)).toBeInTheDocument();
      expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent(
        '尚未保存的编辑内容',
      );
    },
  );
  it.each([
    ['character', false],
    ['scene', false],
    ['scene', true],
    ['prop', false],
  ] as const)(
    'opens %s prompts and seeds image production (reference=%s)',
    async (kind, useReference) => {
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
        id: `d-${kind}`,
        projectId: 'project',
        kind,
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
          bindings:
            kind === 'character'
              ? { schemaVersion: 1 as const, voiceDocumentId: 'voice-prompt' }
              : undefined,
          createdAt: 'now',
        },
        currentVersionId: 'v-1',
      };
      const voicePromptDocument = {
        ...character,
        id: 'voice-prompt',
        kind: 'voice' as const,
        title: '林澈音色',
        currentVersion: {
          ...character.currentVersion,
          contentMarkdown: '低沉清晰，语速平稳。',
          sampleText: '灯塔还亮着。',
          bindings: undefined,
        },
      };
      const imageAdapter: AdapterDescriptor = {
        key: `${useReference ? 'REFERENCE_TO_IMAGE' : 'TEXT_TO_IMAGE'}:vidu:viduq2:v2`,
        capability: useReference ? 'REFERENCE_TO_IMAGE' : 'TEXT_TO_IMAGE',
        capabilityLabel: '文生图',
        provider: 'vidu',
        providerLabel: 'Vidu',
        model: 'viduq2',
        modelLabel: 'Vidu Q2',
        apiVersion: 'v2',
        schemaVersion: 1 as const,
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
            ...(useReference
              ? {
                  images: {
                    type: 'array' as const,
                    title: '参考图',
                    items: { type: 'string' as const },
                    maxItems: 7,
                  },
                }
              : {}),
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
      const generatedCharacterAsset = {
        id: 'generated-character',
        projectId: project.id,
        kind: 'character',
        relativePath: 'assets/generated-character.png',
        contentHash: 'generated-hash',
        sizeBytes: 1024,
        createdAt: 'now',
      };
      const generatedCharacterJob = {
        id: 'character-image-job',
        adapterKey: imageAdapter.key,
        status: 'pending' as const,
        request: { prompt: '林澈，灯塔守望员' },
        results: [],
        createdAt: 'now',
        updatedAt: 'now',
      };
      let hasGeneratedCharacterAsset = false;
      vi.mocked(callWorker).mockImplementation((method: string, params?: unknown) => {
        if (method === 'conversation.promptTemplate.get')
          return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
        if (method === 'conversation.runtime.list') return Promise.resolve([]);
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
        if (method === 'project.runtime.list')
          return Promise.resolve([
            { project, projectSessionId: 'image-production-session', active: true, state: 'ready' },
          ]);
        if (method === 'document.list')
          return Promise.resolve(
            kind === 'character' ? [character, voicePromptDocument] : [character],
          );
        if (method === 'document.get')
          return Promise.resolve(
            (params as { documentId: string }).documentId === 'voice-prompt'
              ? voicePromptDocument
              : character,
          );
        if (method === 'document.versions') return Promise.resolve([]);
        if (method === 'scene.list')
          return Promise.resolve([
            {
              id: 'bound-scene',
              projectId: 'project',
              title: '第1场 · 灯塔',
              position: 0,
              rowVersion: 1,
              createdAt: 'now',
              updatedAt: 'now',
              characterBindings: [{ characterDocumentId: character.id }],
            },
            {
              id: 'unbound-scene',
              projectId: 'project',
              title: '未关联的场次',
              position: 1,
              rowVersion: 1,
              createdAt: 'now',
              updatedAt: 'now',
              characterBindings: [{ characterDocumentId: 'same-name-other-id' }],
            },
          ]);
        if (method === 'asset.list') {
          if (
            hasGeneratedCharacterAsset &&
            (
              params as
                | {
                    sourceDocumentId?: string;
                  }
                | undefined
            )?.sourceDocumentId === character.id
          )
            return Promise.resolve([generatedCharacterAsset]);
          return Promise.resolve(
            useReference
              ? [
                  {
                    id: 'scene-master',
                    projectId: project.id,
                    kind: 'scene',
                    alias: '庭院主图',
                    relativePath: 'assets/images/courtyard.png',
                    contentHash: 'hash',
                    sizeBytes: 1024,
                    createdAt: 'now',
                  },
                ]
              : hasGeneratedCharacterAsset
                ? [generatedCharacterAsset]
                : [],
          );
        }
        if (method === 'shot.list') return Promise.resolve([]);
        if (method === 'asset.mediaSource' || method === 'asset.thumbnail')
          return Promise.resolve({
            assetId: 'scene-master',
            path: 'D:/Filter/assets/images/courtyard.png',
            contentType: 'image/png',
          });
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
            capabilities: [{ key: imageAdapter.capability, label: imageAdapter.capabilityLabel }],
            providers: [{ key: 'vidu', label: 'Vidu' }],
            adapters: [imageAdapter],
          });
        if (method === 'adapter.resolve') return Promise.resolve(imageAdapter);
        if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
        if (method === 'image.generate.prepare') return Promise.resolve(generatedCharacterJob);
        if (method === 'media.generation.requestSubmission')
          return Promise.resolve({
            kind: 'image',
            job: generatedCharacterJob,
            confirmation: {
              confirmationToken: 'character-image-confirmation',
              jobId: 'character-image-job',
              kind: 'image',
              draftVersion: 1,
              providerName: 'Vidu',
              modelName: 'Vidu Q2',
              adapterKey: imageAdapter.key,
              parameterSummary: [{ key: 'prompt', value: '林澈，灯塔守望员' }],
              costNotice: { required: true, summary: '本次提交可能产生费用。' },
              expiresAt: '2999-01-01T00:00:00.000Z',
            },
          });
        if (method === 'media.generation.confirmSubmission') {
          hasGeneratedCharacterAsset = true;
          return Promise.resolve({
            kind: 'image',
            job: {
              ...generatedCharacterJob,
              status: 'succeeded',
              results: [
                {
                  id: 'character-image-result',
                  jobId: generatedCharacterJob.id,
                  asset: generatedCharacterAsset,
                  createdAt: 'now',
                },
              ],
            },
          });
        }
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
      await waitFor(() =>
        expect(screen.getByRole('button', { name: /^角色与场景/ })).toBeEnabled(),
      );
      fireEvent.click(screen.getByRole('button', { name: /^角色与场景/ }));
      fireEvent.click(
        await screen.findByRole('button', {
          name: /^(打开文档|编辑文档标题) 角色设定$/,
        }),
      );
      expect(screen.getByRole('button', { name: '角色与场景' })).toBeInTheDocument();
      expect(
        screen.queryByRole('heading', {
          name:
            kind === 'prop' ? '道具资料' : kind === 'scene' ? '场景生图提示词' : '角色生图提示词',
        }),
      ).not.toBeInTheDocument();
      await screen.findByRole('region', { name: '提示词预览' });
      if (kind === 'character') {
        const voicePrompt = screen.getByRole('region', { name: '角色音色提示词' });
        expect(
          await within(voicePrompt).findByRole('region', { name: '音色描述预览' }),
        ).toHaveTextContent('低沉清晰，语速平稳。');
        expect(within(voicePrompt).getByRole('region', { name: '试音文本预览' })).toHaveTextContent(
          '灯塔还亮着。',
        );
        fireEvent.click(within(voicePrompt).getByRole('button', { name: '生成音色' }));
        const designPanel = await screen.findByRole('region', { name: '按提示词设计新音色' });
        expect(container.querySelector('.app-shell')).toHaveAttribute(
          'data-navigation-mode',
          'production',
        );
        expect(designPanel.closest('.workspace-production-page')).not.toBeNull();
        expect(voicePrompt).not.toContainElement(designPanel);
        expect(await within(designPanel).findByText('低沉清晰，语速平稳。')).toBeInTheDocument();
        expect(within(designPanel).getByText('角色：角色设定')).toBeInTheDocument();
        expect(within(designPanel).getByRole('button', { name: '确认生成新音色' })).toBeDisabled();
        expect(
          vi
            .mocked(callWorker)
            .mock.calls.some(([method]) => method === 'characterVoiceDesign.prepare'),
        ).toBe(false);
        const audioGroup = screen.getByRole('button', { name: '音频制作' });
        if (audioGroup.getAttribute('aria-expanded') !== 'true') fireEvent.click(audioGroup);
        fireEvent.click(screen.getByRole('button', { name: '音频生成' }));
        expect(
          screen.queryByRole('region', { name: '按提示词设计新音色' }),
        ).not.toBeInTheDocument();
        expect(container.querySelector('.production-panel')).not.toBeNull();
        expect(container.querySelector('.app-shell')).toHaveAttribute(
          'data-navigation-mode',
          'production',
        );
        fireEvent.click(within(voicePrompt).getByRole('button', { name: '生成音色' }));
        const reopenedPanel = await screen.findByRole('region', { name: '按提示词设计新音色' });
        fireEvent.click(within(reopenedPanel).getByRole('button', { name: '关闭音色生成' }));
        expect(
          screen.queryByRole('region', { name: '按提示词设计新音色' }),
        ).not.toBeInTheDocument();
        expect(container.querySelector('.app-shell')).toHaveAttribute(
          'data-navigation-mode',
          'project',
        );
        expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent(
          '林澈，灯塔守望员',
        );
        const sceneBindings = screen.getByRole('region', { name: '场次绑定' });
        expect(
          within(sceneBindings).getByRole('button', { name: '第1场 · 灯塔' }),
        ).toBeInTheDocument();
        expect(
          within(sceneBindings).queryByRole('button', { name: '未关联的场次' }),
        ).not.toBeInTheDocument();
      } else {
        expect(screen.queryByText('角色声音')).not.toBeInTheDocument();
      }
      expect(screen.getByRole('heading', { name: '已生成图片' })).toBeInTheDocument();
      const generateLabel =
        kind === 'prop' ? '生成道具图' : kind === 'scene' ? '生成场景图' : '生成角色图';
      expect(screen.getByRole('button', { name: generateLabel })).toHaveClass(
        'production-generate-button',
        'primary',
      );
      expect(screen.queryByLabelText('文档类型')).not.toBeInTheDocument();
      expect(screen.queryByText('约束条件')).not.toBeInTheDocument();
      if (kind === 'scene') {
        if (useReference) {
          await screen.findByRole('option', { name: '庭院主图' });
          fireEvent.change(screen.getByLabelText('场景一致性参考图'), {
            target: { value: 'scene-master' },
          });
        }
      }
      fireEvent.click(screen.getByRole('button', { name: generateLabel }));
      await waitFor(() =>
        expect(container.querySelector('.app-shell')).toHaveAttribute(
          'data-navigation-mode',
          'production',
        ),
      );
      const imagePrompt = await screen.findByLabelText(/画面提示词/);
      if (kind === 'character') {
        expect(imagePrompt).toHaveValue('林澈，灯塔守望员');
        expect((imagePrompt as HTMLTextAreaElement).value).not.toContain('全身五视图');
        expect((imagePrompt as HTMLTextAreaElement).value).not.toContain('头部六角度');
      } else if (kind === 'scene') {
        const promptText =
          imagePrompt instanceof HTMLTextAreaElement
            ? imagePrompt.value
            : (imagePrompt.textContent ?? '');
        expect(promptText).toContain('林澈，灯塔守望员');
        expect(promptText).toContain('一张复合参考图');
        expect(promptText).toContain('主图是占画面主要面积');
        expect(promptText).toContain('关键局部特写');
        expect(promptText).toContain('n=1');
        expect(promptText).not.toContain('第 5/6 张');
        if (useReference) {
          await waitFor(() =>
            expect(callWorker).toHaveBeenCalledWith(
              'production.compile',
              expect.objectContaining({
                inputImages: [{ assetId: 'scene-master', role: 'reference' }],
              }),
              expect.objectContaining({ projectId: project.id }),
            ),
          );
        }
      } else {
        expect(imagePrompt).toHaveValue('林澈，灯塔守望员');
      }
      expect(screen.getByLabelText('保存为')).toHaveValue(kind);
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ sourceDocumentId: character.id }),
        expect.objectContaining({ projectId: project.id }),
      );
      if (kind === 'character') {
        fireEvent.change(imagePrompt, { target: { value: '临时修改的画面提示词' } });
        const generateImageButton = screen.getByRole('button', { name: '生成图片' });
        await waitFor(() => expect(generateImageButton).toBeEnabled());
        fireEvent.click(generateImageButton);
        expect(await screen.findByRole('button', { name: '批准' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: '批准' }));
        expect(await screen.findByText('图片已保存到本地素材库。')).toBeInTheDocument();
        await waitFor(() => expect(screen.getByText('1 张')).toBeInTheDocument());
        expect(callWorker).toHaveBeenCalledWith(
          'image.generate.prepare',
          expect.objectContaining({ sourceDocumentId: character.id, assetKind: 'character' }),
          expect.objectContaining({ projectId: project.id }),
        );
        expect(callWorker).toHaveBeenCalledWith(
          'media.generation.confirmSubmission',
          expect.objectContaining({
            confirmationToken: 'character-image-confirmation',
            approved: true,
          }),
          expect.objectContaining({ projectId: project.id }),
        );
        fireEvent.click(screen.getByRole('button', { name: '关闭生产参数' }));
        await waitFor(() =>
          expect(container.querySelector('.app-shell')).toHaveAttribute(
            'data-navigation-mode',
            'project',
          ),
        );
        fireEvent.click(screen.getByRole('button', { name: '生成角色图' }));
        await waitFor(() =>
          expect(screen.getByLabelText(/画面提示词/)).toHaveValue('林澈，灯塔守望员'),
        );
        expect(screen.getByLabelText(/画面提示词/)).not.toHaveValue('临时修改的画面提示词');
      }
    },
  );
  it('shows and saves the shot storyboard document in the shot workspace', async () => {
    vi.mocked(callWorker).mockImplementation((method: string, params?: unknown) => {
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
        const title = (
          params as {
            title: string;
          }
        ).title;
        const contentMarkdown = (
          params as {
            contentMarkdown: string;
          }
        ).contentMarkdown;
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
    await clickProjectNavigationItem(/场次与镜头/);
    fireEvent.click(await screen.findByRole('button', { name: /镜头一/ }));
    expect(await screen.findByRole('heading', { name: '镜头提示词' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '本镜角色绑定' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '修复绑定' })).toBeInTheDocument();
    fireEvent.click(screen.getByText('分镜说明 · 已保存'));
    expect(screen.getByRole('heading', { name: '分镜说明' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '填充本镜图片表单' })).toBeInTheDocument();
    expect(await screen.findByLabelText('分镜标题')).toHaveValue('镜头一分镜');
    fireEvent.click(await screen.findByRole('region', { name: '分镜内容预览' }));
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
    const compilePrompt: {
      value?: string;
    } = {};
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
      schemaVersion: 1 as const,
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
    vi.mocked(callWorker).mockImplementation((method: string, params?: unknown) => {
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
      if (method === 'shot.references.save')
        return Promise.resolve({
          shotId: 'shot',
          referenceBindings:
            (
              params as {
                referenceBindings?: import('@ai-video/contracts').ShotReferenceBindingInfo | null;
              }
            ).referenceBindings ?? undefined,
        });
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
          parameters: compilePrompt.value ? { prompt: compilePrompt.value } : {},
          issues: [],
        });
      if (method === 'characterVoiceReference.list' || method === 'audio.list')
        return Promise.resolve([]);
      throw new Error('Unexpected method ' + method);
    });
    const { container } = render(<App />);
    await clickProjectNavigationItem(/场次与镜头/);
    fireEvent.click(await screen.findByRole('button', { name: /镜头一/ }));
    fireEvent.click(await screen.findByRole('region', { name: '镜头提示词预览' }));
    expect(await screen.findByRole('textbox', { name: '镜头提示词' })).toHaveValue(
      '雨夜里林澈回头',
    );
    fireEvent.click(screen.getByRole('button', { name: '填充本镜图片表单' }));
    await waitFor(() =>
      expect(container.querySelector('.app-shell')).toHaveAttribute(
        'data-navigation-mode',
        'production',
      ),
    );
    const productionPrompt = await screen.findByLabelText(/画面提示词/);
    expect(productionPrompt).toHaveValue('雨夜里林澈回头');
    fireEvent.change(productionPrompt, { target: { value: '右侧临时编辑' } });
    compilePrompt.value = '编译器返回旧提示词';
    fireEvent.click(screen.getByRole('button', { name: '填充本镜图片表单' }));
    await waitFor(() => expect(productionPrompt).toHaveValue('雨夜里林澈回头'));
    expect(screen.getByLabelText('保存为')).toHaveValue('first-frame');
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) =>
          ['media.review.submit', 'media.generation.submit', 'dubbing.job.submit'].includes(method),
        ),
    ).toHaveLength(0);
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
      schemaVersion: 1 as const,
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
        const sourceDocumentId = (
          params as
            | {
                sourceDocumentId?: string;
              }
            | undefined
        )?.sourceDocumentId;
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
      if (method === 'shot.references.save')
        return Promise.resolve({
          shotId: 'shot',
          referenceBindings:
            (
              params as {
                referenceBindings?: import('@ai-video/contracts').ShotReferenceBindingInfo | null;
              }
            ).referenceBindings ?? undefined,
        });
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
        const capability = (
          params as
            | {
                capability?: string;
              }
            | undefined
        )?.capability;
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
    await clickProjectNavigationItem(/场次与镜头/);
    fireEvent.click(await screen.findByRole('button', { name: /镜头一/ }));
    fireEvent.click(await screen.findByRole('region', { name: '镜头提示词预览' }));
    expect(await screen.findByRole('textbox', { name: '镜头提示词' })).toHaveValue(
      '[角色:林澈] 雨夜里回头',
    );
    fireEvent.click(screen.getByRole('button', { name: '填充本镜图片表单' }));
    await waitFor(() =>
      expect(container.querySelector('.app-shell')).toHaveAttribute(
        'data-navigation-mode',
        'production',
      ),
    );
    expect(await screen.findByLabelText(/画面提示词/)).toHaveValue('[角色:林澈] 雨夜里回头');
    expect(screen.getByLabelText('保存为')).toHaveValue('first-frame');
    expect(screen.queryByText('素材库图片')).not.toBeInTheDocument();
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) =>
          ['media.review.submit', 'media.generation.submit', 'dubbing.job.submit'].includes(method),
        ),
    ).toHaveLength(0);
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
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.runtime.list' || method === 'conversation.runtime.list')
        return Promise.resolve([]);
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
          budgetTokens: 1000,
          sources: [],
        });
      if (method === 'agent.run')
        return Promise.resolve({
          status: 'image_prepared' as const,
          capability: 'image' as const,
          job: imageJob,
        });
      if (method === 'media.review.list') return Promise.resolve([]);
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
      expect(callWorker).toHaveBeenCalledWith(
        'media.task.cancel',
        { jobId: imageJob.id },
        { projectId: 'project', projectSessionId: 'image-production-session' },
      ),
    );
    expect(screen.getByRole('textbox', { name: '会话消息' })).toHaveValue('生成一张角色图');
    expect(callWorker).not.toHaveBeenCalledWith(
      'media.generation.confirmSubmission',
      expect.anything(),
    );
  });
  it('restores this window project after reload even when another window changed the Worker active project', async () => {
    const projectA = {
      id: 'window-A',
      name: 'Window A Project',
      rootPath: 'D:\\WindowA',
      mode: 'read-write' as const,
      schemaVersion: 53,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const projectB = {
      ...projectA,
      id: 'window-B',
      name: 'Window B Project',
      rootPath: 'D:\\WindowB',
    };
    window.sessionStorage.setItem(
      'ai-video.project-view',
      JSON.stringify({ projectId: projectA.id, rootPath: projectA.rootPath }),
    );
    const baseline = vi.mocked(callWorker).getMockImplementation()!;
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'conversation.promptTemplate.get')
        return Promise.resolve({ conversationId: 'conversation', content: '', rowVersion: 1 });
      if (method === 'project.current') return Promise.resolve(projectB);
      if (method === 'project.runtime.attach')
        return Promise.resolve({
          project: projectA,
          projectSessionId: 'A-epoch',
          active: false,
          state: 'ready',
        });
      if (method === 'project.runtime.list')
        return Promise.resolve([
          { project: projectA, projectSessionId: 'A-epoch', active: false, state: 'ready' },
          { project: projectB, projectSessionId: 'B-epoch', active: true, state: 'ready' },
        ]);
      if (method === 'conversation.list') return Promise.resolve({ items: [] });
      if (
        [
          'document.list',
          'scene.list',
          'asset.list',
          'constraint.list',
          'provider.profile.list',
          'conversation.runtime.list',
        ].includes(method)
      )
        return Promise.resolve([]);
      return baseline(method, params);
    });
    render(<App />);
    await screen.findAllByText(projectA.name);
    expect(screen.queryByText(projectB.name)).not.toBeInTheDocument();
    expect(callWorker).toHaveBeenCalledWith('project.runtime.attach', {
      rootPath: projectA.rootPath,
      expectedProjectId: projectA.id,
    });
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.some(
          ([method]) => method === 'project.runtime.unload' || method === 'project.close',
        ),
    ).toBe(false);
  });
});
