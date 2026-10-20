import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerGenerationMetric } from '@ai-video/contracts';
import type { LlmProvider, LlmStreamRequest } from '@ai-video/llm';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import {
  GenerationService,
  type LlmSelectionResolver,
  type LlmUsageIndexer,
} from './generation-service.js';
import { ProjectService } from './project-service.js';
import { LibrarySearchService } from './library-search-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';

const directories: string[] = [];
const projectsToClose: ProjectService[] = [];

afterEach(async () => {
  for (const service of projectsToClose.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup(
  provider: LlmProvider,
  selectionResolver?: LlmSelectionResolver,
  usageIndexer?: LlmUsageIndexer,
  generationMetricReporter?: (metric: WorkerGenerationMetric) => void,
) {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-generation-'));
  directories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projectsToClose.push(projects);
  projects.create(join(directory, 'project'), 'Generation Project');
  const projectRoot = join(directory, 'project');
  const content = new ContentService(projects);
  const conversation = content.createConversation({ scopeType: 'project' });
  return {
    content,
    conversation,
    projectRoot,
    projects,
    generations: new GenerationService(projects, content, new ContextService(projects), provider, {
      selectionResolver,
      usageIndexer,
      generationMetricReporter,
    }),
  };
}

describe('GenerationService', () => {
  it('serializes a conversation across callers without duplicating messages or snapshots', async () => {
    const stream = vi.fn(() => Promise.reject(new Error('must not start another Provider')));
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test', configured: true }),
      stream,
    };
    const selectionResolver: LlmSelectionResolver = {
      resolveLlmSelection: () => ({
        providerProfileId: 'profile',
        modelId: 'model',
        providerName: 'Test',
        modelName: 'Test',
        remoteModelId: 'test',
        protocol: 'openai-chat-completions',
        baseUrl: 'https://mock.invalid/v1',
      }),
    };
    const { projects, content, conversation, generations } = await setup(
      provider,
      selectionResolver,
    );
    const params = {
      conversationId: conversation.id,
      prompt: '修改现有设定',
      providerProfileId: 'profile',
      modelId: 'model',
      idempotencyKey: 'first',
    };
    const first = generations.prepare(params);
    expect(generations.prepare(params).generation.generationId).toBe(first.generation.generationId);
    const otherCaller = new GenerationService(
      projects,
      content,
      new ContextService(projects),
      provider,
      {
        selectionResolver,
      },
    );
    const counts = () =>
      projects.access(false, (db) => ({
        messages: db.prepare('SELECT COUNT(*) AS n FROM chat_messages').get(),
        snapshots: db.prepare('SELECT COUNT(*) AS n FROM context_snapshots').get(),
        generations: db.prepare('SELECT COUNT(*) AS n FROM llm_generations').get(),
      }));
    const before = counts();
    expect(() =>
      otherCaller.prepare({ ...params, prompt: '？', idempotencyKey: 'second' }),
    ).toThrow('上一轮仍在执行');
    expect(() => otherCaller.generate(conversation.id, '？')).toThrow('上一轮仍在执行');
    generations.observe({ ...first.stream, content: '正在读取' });
    expect(() => generations.prepare({ ...params, idempotencyKey: 'third' })).toThrow(
      '上一轮仍在执行',
    );
    expect(counts()).toEqual(before);
    expect(stream).not.toHaveBeenCalled();

    const secondConversation = content.createConversation({ scopeType: 'project' });
    expect(
      generations.prepare({
        ...params,
        conversationId: secondConversation.id,
        idempotencyKey: 'other',
      }).generation.status,
    ).toBe('prepared');
    generations.complete({ ...first.stream, content: '已完成' });
    const next = generations.prepare({ ...params, idempotencyKey: 'next' });
    expect(next.generation.status).toBe('prepared');
    await generations.cancel(next.generation.generationId);
    expect(
      generations.prepare({ ...params, idempotencyKey: 'after-cancel' }).generation.status,
    ).toBe('prepared');
  });

  it('labels the environment-variable provider as a legacy configuration source', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'OpenAI', model: 'gpt-test', configured: true }),
      stream: () => Promise.reject(new Error('not used')),
    };
    const { generations } = await setup(provider);
    expect(generations.status()).toEqual({
      provider: 'OpenAI',
      model: 'gpt-test',
      configured: true,
      configurationSource: 'environment',
    });
  });

  it('streams and persists an assistant response', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request) => {
        request.onDelta('第一段');
        request.onDelta('第二段');
        return Promise.resolve({ model: 'test-model', content: '第一段第二段', toolCalls: [] });
      },
    };
    const { content, conversation, generations } = await setup(provider);
    const started = generations.generate(conversation.id, '生成分镜');
    await expect.poll(() => generations.get(started.generationId).status).toBe('complete');
    expect(content.listMessages({ conversationId: conversation.id }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: '生成分镜' }),
        expect.objectContaining({
          role: 'assistant',
          content: '第一段第二段',
          status: 'complete',
        }),
      ]),
    );
  });

  it('persists a context manifest without full rendered text', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request) => {
        request.onDelta('第一段');
        return Promise.resolve({ model: 'test-model', content: '第一段', toolCalls: [] });
      },
    };
    const { content, conversation, generations, projects } = await setup(provider);
    const started = generations.generate(conversation.id, '生成测试');
    await expect.poll(() => generations.get(started.generationId).status).toBe('complete');
    content.listMessages({ conversationId: conversation.id });

    projects.access(false, (database, project) => {
      const row = database
        .prepare(
          `SELECT content_json FROM context_snapshots
           WHERE project_id = ? AND purpose = 'llm-generation'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(project.id) as { content_json: string };
      const manifest = JSON.parse(row.content_json) as Record<string, unknown>;
      expect(manifest).toMatchObject({ version: 1 });
      expect(Array.isArray(manifest.sources)).toBe(true);
      expect(row.content_json).not.toContain('systemInstruction');
      expect(row.content_json).not.toContain('rendered');
    });
  });

  it('reports complete generation metrics through the callback', async () => {
    const reported: WorkerGenerationMetric[] = [];
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request) => {
        request.onDelta('第一段');
        return Promise.resolve({ model: 'test-model', content: '第一段', toolCalls: [] });
      },
    };
    const { conversation, generations } = await setup(provider, undefined, undefined, (metric) =>
      reported.push(metric),
    );
    const started = generations.generate(conversation.id, '生成测试');
    await expect.poll(() => generations.get(started.generationId).status).toBe('complete');

    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({
      generationId: started.generationId,
      providerName: 'Test',
      status: 'complete',
    });
  });

  it('reconstructs a terminal generation from SQLite after a Worker restart', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request) => {
        request.onDelta('Persisted');
        return Promise.resolve({
          model: 'test-model',
          content: 'Persisted response',
          toolCalls: [],
        });
      },
    };
    const { content, conversation, generations, projectRoot, projects } = await setup(provider);
    const started = generations.generate(conversation.id, 'Restart query');
    await expect.poll(() => generations.get(started.generationId).status).toBe('complete');

    projects.close();
    projects.open(projectRoot);
    const restarted = new GenerationService(
      projects,
      content,
      new ContextService(projects),
      provider,
    );

    expect(restarted.get(started.generationId)).toMatchObject({
      generationId: started.generationId,
      status: 'complete',
      assistantMessage: { content: 'Persisted response', status: 'complete' },
    });
    await expect(restarted.cancel(started.generationId)).resolves.toMatchObject({
      status: 'complete',
    });
  });

  it('batches small deltas instead of rewriting SQLite for every increment', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request) => {
        for (let index = 0; index < 300; index += 1) request.onDelta('字');
        return Promise.resolve({ model: 'test-model', content: '字'.repeat(300), toolCalls: [] });
      },
    };
    const { conversation, generations, projects } = await setup(provider);
    const access = vi.spyOn(projects, 'access');

    const started = generations.generate(conversation.id, '批量写入');
    await expect.poll(() => generations.get(started.generationId).status).toBe('complete');

    expect(access.mock.calls.filter(([writable]) => writable)).toHaveLength(2);
    expect(generations.get(started.generationId).assistantMessage.content).toHaveLength(300);
  });

  it('rejects creating a generation for an archived conversation', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'mock', name: 'Mock', model: 'mock-model', configured: true }),
      stream: () => Promise.reject(new Error('not used')),
    };
    const { content, conversation, generations } = await setup(provider);
    content.archiveConversation({ conversationId: conversation.id });
    expect(() => generations.generate(conversation.id, 'Test archived')).toThrow(
      'Archived conversations cannot be updated.',
    );
  });

  it('cancels an active generation', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request: LlmStreamRequest) =>
        new Promise((_resolve, reject) => {
          request.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    };
    const { conversation, generations } = await setup(provider);
    const started = generations.generate(conversation.id, '停止测试');
    await generations.cancel(started.generationId);
    await expect.poll(() => generations.get(started.generationId).status).toBe('cancelled');
  });

  it('retries with the original user message without duplicating it', async () => {
    let attempt = 0;
    const prompts: string[] = [];
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request) => {
        attempt += 1;
        prompts.push(request.prompt);
        if (attempt === 1) return Promise.reject(new Error('Temporary failure'));
        request.onDelta('重试成功');
        return Promise.resolve({ model: 'test-model', content: '重试成功', toolCalls: [] });
      },
    };
    const { content, conversation, generations } = await setup(provider);
    const first = generations.generate(conversation.id, '原始请求');
    await expect.poll(() => generations.get(first.generationId).status).toBe('failed');
    content.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '不相关的后续请求',
    });

    const retried = generations.retry({ assistantMessageId: first.assistantMessage.id });
    await expect.poll(() => generations.get(retried.generationId).status).toBe('complete');
    const messages = content.listMessages({ conversationId: conversation.id }).items;
    expect(first.assistantMessage.replyToMessageId).toBe(first.userMessage.id);
    expect(prompts).toEqual(['原始请求', '原始请求']);
    expect(messages.filter((message) => message.content === '原始请求')).toHaveLength(1);
    expect(messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'assistant', content: '重试成功' })]),
    );
  });

  it('persists cancellation before the project database closes', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request: LlmStreamRequest) =>
        new Promise((_resolve, reject) => {
          request.onDelta('部分内容');
          request.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    };
    const { content, conversation, generations, projectRoot, projects } = await setup(provider);
    const started = generations.generate(conversation.id, '关闭项目');

    await generations.cancelAll();
    projects.close();
    projects.open(projectRoot);

    expect(generations.get(started.generationId).status).toBe('cancelled');
    expect(content.listMessages({ conversationId: conversation.id }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: '部分内容', status: 'failed' }),
      ]),
    );
  });

  it('bounds cancellation when a provider ignores AbortSignal', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: () => new Promise(() => undefined),
    };
    const directory = await mkdtemp(join(tmpdir(), 'ai-video-generation-timeout-'));
    directories.push(directory);
    const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    projectsToClose.push(projects);
    projects.create(join(directory, 'project'), 'Cancellation Project');
    const content = new ContentService(projects);
    const conversation = content.createConversation({ scopeType: 'project' });
    const generations = new GenerationService(
      projects,
      content,
      new ContextService(projects),
      provider,
      { cancellationTimeoutMs: 20 },
    );
    const started = generations.generate(conversation.id, '忽略取消');

    await generations.cancelAll();

    expect(generations.get(started.generationId)).toMatchObject({ status: 'cancelled' });
    expect(content.listMessages({ conversationId: conversation.id }).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: 'assistant', status: 'failed' })]),
    );
  });

  it('repairs streaming messages left by an interrupted Worker', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: () => Promise.reject(new Error('unused')),
    };
    const { content, conversation, generations } = await setup(provider);
    const user = content.saveMessage({
      conversationId: conversation.id,
      role: 'user',
      content: '中断请求',
    });
    const assistant = content.saveMessage({
      conversationId: conversation.id,
      replyToMessageId: user.id,
      role: 'assistant',
      content: '',
      status: 'streaming',
    });

    expect(generations.recoverInterrupted()).toBe(1);
    expect(
      content
        .listMessages({ conversationId: conversation.id })
        .items.find((message) => message.id === assistant.id),
    ).toMatchObject({ status: 'failed', content: '生成因 Worker 重启而中断。' });
  });

  it('prepares, observes, and completes a managed native generation without a credential', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const resolveLlmSelection = vi.fn(() => ({
      providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
      providerName: 'Local Mock',
      modelId: '123e4567-e89b-42d3-a456-426614174001',
      modelName: 'Mock Model',
      remoteModelId: 'mock-model',
      protocol: 'openai-responses' as const,
      baseUrl: 'https://mock.invalid/v1',
    }));
    const selectionResolver: LlmSelectionResolver = { resolveLlmSelection };
    const { content, conversation, generations } = await setup(provider, selectionResolver);
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Native prompt',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });
    expect(prepared.generation).toMatchObject({
      status: 'prepared',
      executionMode: 'native',
      attemptId: prepared.stream.attemptId,
    });
    const runtime = generations.runtime(prepared.stream);
    expect(runtime).toMatchObject({
      protocol: 'openai-responses' as const,
      remoteModelId: 'mock-model',
      prompt: 'Native prompt',
    });
    expect(JSON.stringify(runtime)).not.toMatch(/apiKey|credential|secret/i);

    expect(generations.observe({ ...prepared.stream, content: 'First' })).toMatchObject({
      status: 'streaming',
      assistantMessage: { content: 'First' },
    });
    expect(() =>
      generations.observe({
        ...prepared.stream,
        conversationId: 'stale-conversation',
        content: 'First stale',
      }),
    ).toThrow('Stale LLM generation callback');
    expect(
      generations.complete({
        ...prepared.stream,
        content: 'First second',
        providerResponseId: 'response-1',
        finishReason: 'completed',
      }),
    ).toMatchObject({
      status: 'complete',
      providerResponseId: 'response-1',
      assistantMessage: { content: 'First second', status: 'complete' },
    });
    expect(
      generations.observe({ ...prepared.stream, content: 'First second ignored' }),
    ).toMatchObject({ status: 'complete', assistantMessage: { content: 'First second' } });
    expect(content.listMessages({ conversationId: conversation.id }).items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', content: 'Native prompt' }),
        expect.objectContaining({ role: 'assistant', content: 'First second', status: 'complete' }),
      ]),
    );
  });

  it('tells Agent runtimes to write documents through tools instead of chat Markdown', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const { conversation, generations } = await setup(provider, {
      resolveLlmSelection: () => ({
        providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
        providerName: 'Local Mock',
        modelId: '123e4567-e89b-42d3-a456-426614174001',
        modelName: 'Mock Model',
        remoteModelId: 'mock-model',
        protocol: 'openai-responses' as const,
        baseUrl: 'https://mock.invalid/v1',
      }),
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create an outline document',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });
    generations.configureAgentTools(prepared.stream, [
      {
        name: 'document.create_draft',
        description: 'Create a draft',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
      {
        name: 'conversation.search',
        description: 'Search conversations',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
    ]);
    expect(generations.runtime(prepared.stream).systemInstruction).toContain(
      '# Agent document write policy',
    );
    expect(generations.runtime(prepared.stream).systemInstruction).toContain('不要用聊天正文代替');
    expect(generations.runtime(prepared.stream).systemInstruction).toContain(
      '按每个角色或命名组合分别提交',
    );
    expect(generations.runtime(prepared.stream).systemInstruction).toContain(
      '# Agent system tool policy',
    );
    expect(generations.runtime(prepared.stream).systemInstruction).toContain(
      '不添加 schema 未定义的定位字段',
    );
  });

  it('keeps ordinary generation context on the catalog instead of document bodies', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const { content, conversation, generations } = await setup(provider, {
      resolveLlmSelection: () => ({
        providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
        providerName: 'Local Mock',
        modelId: '123e4567-e89b-42d3-a456-426614174001',
        modelName: 'Mock Model',
        remoteModelId: 'mock-model',
        protocol: 'openai-responses' as const,
        baseUrl: 'https://mock.invalid/v1',
      }),
    });
    content.saveDocument({
      kind: 'character',
      title: '林澈',
      contentMarkdown: '这段正文不应进入普通会话。',
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '介绍角色',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
      agentMode: 'document',
      selectedChapterIds: ['selected-hint-only'],
    });
    generations.configureAgentTools(prepared.stream, [
      {
        name: 'library.search',
        description: 'Search',
        parameters: { type: 'object', additionalProperties: false, properties: {} },
      },
    ]);
    const runtime = generations.runtime(prepared.stream);
    expect(runtime.context).toContain('selected-hint-only');
    expect(runtime.context).toContain('可选 UI 目标提示');
    expect(runtime.systemInstruction).not.toContain('selected-hint-only');
    expect(runtime.systemInstruction).not.toContain('可选 UI 目标提示');
    expect(runtime.systemInstruction).toContain('工作助理');
    expect(runtime.systemInstruction).toContain('library.search');
    expect(runtime.systemInstruction).toContain('Do not repeat a successful library.search');
    expect(runtime.systemInstruction).toContain('当前项目 SQLite 资料库');
    expect(runtime.systemInstruction).toContain(
      '自主判断是否检索、查询词、来源类型及需要读取的范围',
    );
    expect(runtime.systemInstruction).toContain('推荐 sourceTypes=["novel-chapter"]');
    expect(runtime.systemInstruction).toContain(
      '必须调用 library.read 取得覆盖目标章节范围的正文证据',
    );
    expect(runtime.systemInstruction).toContain('readMode="source"');
    expect(runtime.systemInstruction).toContain('maxChars 不超过 20000');
    expect(runtime.systemInstruction).toContain('将 nextOffset 作为后续调用的 offset');
    expect(runtime.systemInstruction).toContain(
      '章节勾选只是可选快捷入口，不是 Agent 检索的前置条件',
    );
    expect(runtime.systemInstruction).toContain('未列出不代表不存在');
    expect(runtime.systemInstruction).toContain('遵守工具返回的剩余预算与硬限制');
    expect(runtime.systemInstruction).toContain('不得凭常识编造项目剧情');
    expect(runtime.systemInstruction).not.toContain('代表资料库暂无该具体记录');
    expect(runtime.systemInstruction).not.toContain('至多读取 1~2 个');
    expect(runtime.context).toContain('林澈');
    expect(runtime.context).not.toContain('这段正文不应进入普通会话');
    generations.complete({ ...prepared.stream, content: '已完成' });
    const next = generations.prepare({
      conversationId: conversation.id,
      prompt: '继续讨论角色',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
      agentMode: 'document',
      selectedChapterIds: ['another-hint'],
    });
    generations.configureAgentTools(next.stream, runtime.tools!);
    const nextRuntime = generations.runtime(next.stream);
    expect(nextRuntime.systemInstruction).toBe(runtime.systemInstruction);
    expect(nextRuntime.systemInstruction).not.toContain(prepared.stream.generationId);
    expect(nextRuntime.context).toContain(prepared.stream.generationId);
    expect(nextRuntime.context).toContain('another-hint');
    expect(nextRuntime.context.indexOf('可选 UI 目标提示')).toBeGreaterThan(
      nextRuntime.context.indexOf('当前会话最近任务'),
    );
  });

  it('ignores a delayed shorter observe snapshot instead of failing the generation', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: () => Promise.resolve({ model: 'test-model', content: '', toolCalls: [] }),
    };
    const { conversation, generations } = await setup(provider, {
      resolveLlmSelection: () => ({
        providerProfileId: 'profile-selection',
        modelId: 'model-selection',
        providerName: 'Test',
        modelName: 'test-model',
        remoteModelId: 'mock-model',
        protocol: 'openai-responses' as const,
        baseUrl: 'https://mock.invalid/v1',
      }),
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Concurrent observe',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });

    generations.observe({ ...prepared.stream, content: 'Newer tool response' });
    expect(generations.observe({ ...prepared.stream, content: 'Newer' })).toMatchObject({
      status: 'streaming',
      assistantMessage: { content: 'Newer tool response' },
    });
    expect(generations.complete({ ...prepared.stream, content: 'Newer' })).toMatchObject({
      status: 'complete',
      assistantMessage: { content: 'Newer tool response' },
    });
  });

  it('ignores a divergent observe snapshot instead of failing the generation', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: () => Promise.resolve({ model: 'test-model', content: '', toolCalls: [] }),
    };
    const { conversation, generations } = await setup(provider, {
      resolveLlmSelection: () => ({
        providerProfileId: 'profile-selection',
        modelId: 'model-selection',
        providerName: 'Test',
        modelName: 'test-model',
        remoteModelId: 'mock-model',
        protocol: 'openai-responses' as const,
        baseUrl: 'https://mock.invalid/v1',
      }),
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Divergent observe',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });

    generations.observe({ ...prepared.stream, content: 'First paragraph' });
    expect(generations.observe({ ...prepared.stream, content: 'Replaced snapshot' })).toMatchObject(
      {
        status: 'streaming',
        assistantMessage: { content: 'First paragraph' },
      },
    );
    expect(
      generations.observe({ ...prepared.stream, content: 'First paragraph continued' }),
    ).toMatchObject({
      status: 'streaming',
      assistantMessage: { content: 'First paragraph continued' },
    });
  });

  it('deduplicates native prepare requests by idempotency key', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const resolveLlmSelection = vi.fn(() => ({
      providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
      providerName: 'Local Mock',
      modelId: '123e4567-e89b-42d3-a456-426614174001',
      modelName: 'Mock Model',
      remoteModelId: 'mock-model',
      protocol: 'openai-responses' as const,
      baseUrl: 'https://mock.invalid/v1',
    }));
    const selectionResolver: LlmSelectionResolver = { resolveLlmSelection };
    const { content, conversation, generations } = await setup(provider, selectionResolver);
    const params = {
      conversationId: conversation.id,
      prompt: 'Only once',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
      idempotencyKey: '123e4567-e89b-42d3-a456-426614174099',
    };
    const first = generations.prepare(params);
    const duplicate = generations.prepare(params);

    expect(duplicate.generation.generationId).toBe(first.generation.generationId);
    expect(content.listMessages({ conversationId: conversation.id }).items).toHaveLength(2);
    generations.complete({ ...first.stream, content: 'Done' });
    expect(generations.prepare(params).generation).toMatchObject({
      generationId: first.generation.generationId,
      status: 'complete',
      assistantMessage: { content: 'Done' },
    });
    expect(resolveLlmSelection).toHaveBeenCalledTimes(1);
  });

  it('rejects callbacks from an earlier open session of the same project', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const selectionResolver: LlmSelectionResolver = {
      resolveLlmSelection: () => ({
        providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
        providerName: 'Local Mock',
        modelId: '123e4567-e89b-42d3-a456-426614174001',
        modelName: 'Mock Model',
        remoteModelId: 'mock-model',
        protocol: 'openai-responses',
        baseUrl: 'https://mock.invalid/v1',
      }),
    };
    const { conversation, generations, projectRoot, projects } = await setup(
      provider,
      selectionResolver,
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Old session',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });

    projects.close();
    projects.open(projectRoot);

    expect(() => generations.observe({ ...prepared.stream, content: 'Stale' })).toThrow(
      'Project session changed',
    );
    expect(() =>
      generations.recordProviderUsage(prepared.stream, 'stale-request', {
        inputTokens: 999,
      }),
    ).toThrow('Project session changed');
  });

  it('retains reported request totals across interruption and rejects a mismatched attempt', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'mock', name: 'Mock', model: 'mock', configured: false }),
      stream: () => Promise.reject(new Error('No external calls')),
    };
    const { projects, content, conversation, generations } = await setup(provider, {
      resolveLlmSelection: () => ({
        providerProfileId: 'profile',
        providerName: 'Mock',
        modelId: 'model',
        modelName: 'Mock',
        remoteModelId: 'mock',
        protocol: 'openai-responses',
        baseUrl: 'https://mock.invalid',
      }),
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Interrupted task',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const usage = {
      inputTokens: 100,
      cachedInputTokens: 32,
      outputTokens: 10,
      totalTokens: 110,
      providerReportedCost: { amount: '0.123456789012', currency: 'USD' },
    };
    generations.recordProviderUsage(prepared.stream, 'request-1', usage);
    generations.recordProviderUsage(prepared.stream, 'request-1', usage);
    generations.recordProviderUsage(prepared.stream, 'request-2', usage);
    expect(() =>
      generations.recordProviderUsage(
        { ...prepared.stream, attemptId: 'wrong' },
        'request-3',
        usage,
      ),
    ).toThrow('Stale LLM generation callback');
    const reloaded = new GenerationService(
      projects,
      content,
      new ContextService(projects),
      provider,
    );
    reloaded.recoverInterrupted();
    expect(reloaded.get(prepared.stream.generationId).assistantMessage.attempt).toMatchObject({
      status: 'failed',
      errorCode: 'worker-restarted',
      usage: { inputTokens: 200, cachedInputTokens: 64, outputTokens: 20, totalTokens: 220 },
      providerReportedCost: { amount: '0.246913578024', currency: 'USD' },
    });
  });

  it('cancels and retries managed generations without duplicating the user message', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const selectionResolver: LlmSelectionResolver = {
      resolveLlmSelection: () => ({
        providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
        providerName: 'Local Mock',
        modelId: '123e4567-e89b-42d3-a456-426614174001',
        modelName: 'Mock Model',
        remoteModelId: 'mock-model',
        protocol: 'openai-chat-completions',
        baseUrl: 'https://mock.invalid/v1',
      }),
    };
    const { content, conversation, generations } = await setup(provider, selectionResolver);
    const first = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Retry native prompt',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });
    generations.observe({ ...first.stream, content: 'Partial' });
    await generations.cancel(first.generation.generationId);
    expect(generations.get(first.generation.generationId)).toMatchObject({
      status: 'cancelled',
      assistantMessage: { content: 'Partial', status: 'failed' },
    });

    const retry = generations.retryPrepare({
      assistantMessageId: first.generation.assistantMessage.id,
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });
    expect(retry.stream.attemptId).not.toBe(first.stream.attemptId);
    expect(retry.generation.userMessage.id).toBe(first.generation.userMessage.id);
    expect(
      content
        .listMessages({ conversationId: conversation.id })
        .items.filter((message) => message.content === 'Retry native prompt'),
    ).toHaveLength(1);
  });

  it('persists normalized usage, pricing snapshots, and exact estimated cost', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const selectionResolver: LlmSelectionResolver = {
      resolveLlmSelection: () => ({
        providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
        providerName: 'Local Mock',
        modelId: '123e4567-e89b-42d3-a456-426614174001',
        modelName: 'Mock Model',
        remoteModelId: 'mock-model',
        protocol: 'openai-responses',
        baseUrl: 'https://mock.invalid/v1',
        pricingSnapshot: {
          currency: 'CNY',
          unitTokens: 1_000_000,
          inputPrice: '10',
          cachedInputPrice: '2.5',
          outputPrice: '30',
          configuredAt: '2026-08-03T00:00:00.000Z',
        },
      }),
    };
    const indexLlmAttempt = vi.fn();
    const { content, conversation, generations } = await setup(provider, selectionResolver, {
      indexLlmAttempt,
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Cost prompt',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });
    const completed = generations.complete({
      ...prepared.stream,
      content: 'Cost response',
      usage: {
        inputTokens: 12_480,
        cachedInputTokens: 8_000,
        outputTokens: 2_160,
        reasoningTokens: 500,
        totalTokens: 14_640,
        providerReportedCost: { amount: '0.13', currency: 'cny' },
      },
    });

    expect(completed.assistantMessage.attempt).toMatchObject({
      id: prepared.stream.attemptId,
      status: 'complete',
      usage: {
        inputTokens: 12_480,
        cachedInputTokens: 8_000,
        outputTokens: 2_160,
        reasoningTokens: 500,
        providerReportedCost: { amount: '0.13', currency: 'CNY' },
      },
      estimatedCost: '0.1296',
      currency: 'CNY',
      pricingSnapshot: { inputPrice: '10', outputPrice: '30' },
      providerReportedCost: { amount: '0.13', currency: 'CNY' },
    });
    expect(
      content
        .listMessages({ conversationId: conversation.id })
        .items.find((message) => message.id === completed.assistantMessage.id)?.attempt,
    ).toMatchObject({
      estimatedCost: '0.1296',
      currency: 'CNY',
      providerReportedCost: { amount: '0.13', currency: 'CNY' },
    });
    expect(indexLlmAttempt).toHaveBeenCalledTimes(1);
  });

  it('charges retries as independent attempts and preserves failure usage', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const selectionResolver: LlmSelectionResolver = {
      resolveLlmSelection: () => ({
        providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
        providerName: 'Local Mock',
        modelId: '123e4567-e89b-42d3-a456-426614174001',
        modelName: 'Mock Model',
        remoteModelId: 'mock-model',
        protocol: 'openai-chat-completions',
        baseUrl: 'https://mock.invalid/v1',
        pricingSnapshot: {
          currency: 'USD',
          unitTokens: 1_000_000,
          inputPrice: '10',
          outputPrice: '30',
          configuredAt: '2026-08-03T00:00:00.000Z',
        },
      }),
    };
    const { content, conversation, generations } = await setup(provider, selectionResolver);
    const first = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Retry cost prompt',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });
    generations.failNative({
      ...first.stream,
      content: 'Partial failure',
      error: 'Mock failure',
      retryable: true,
      usage: { inputTokens: 1_000_000 },
    });
    const retry = generations.retryPrepare({
      assistantMessageId: first.generation.assistantMessage.id,
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });
    generations.complete({
      ...retry.stream,
      content: 'Retry completed',
      usage: { outputTokens: 1_000_000 },
    });

    const assistantAttempts = content
      .listMessages({ conversationId: conversation.id })
      .items.filter((message) => message.role === 'assistant')
      .map((message) => message.attempt);
    expect(assistantAttempts).toHaveLength(2);
    const attemptsById = new Map(assistantAttempts.map((attempt) => [attempt?.id, attempt]));
    expect(attemptsById.get(first.stream.attemptId)).toMatchObject({
      status: 'failed',
      usage: { inputTokens: 1_000_000 },
      estimatedCost: '10',
    });
    expect(attemptsById.get(retry.stream.attemptId)).toMatchObject({
      status: 'complete',
      usage: { outputTokens: 1_000_000 },
      estimatedCost: '30',
    });
  });

  it('keeps a completed generation successful when the rebuildable usage index fails', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'legacy', name: 'Legacy', model: 'legacy', configured: false }),
      stream: () => Promise.reject(new Error('legacy provider must not run')),
    };
    const selectionResolver: LlmSelectionResolver = {
      resolveLlmSelection: () => ({
        providerProfileId: '123e4567-e89b-42d3-a456-426614174000',
        providerName: 'Local Mock',
        modelId: '123e4567-e89b-42d3-a456-426614174001',
        modelName: 'Mock Model',
        remoteModelId: 'mock-model',
        protocol: 'openai-responses',
        baseUrl: 'https://mock.invalid/v1',
      }),
    };
    const { conversation, generations } = await setup(provider, selectionResolver, {
      indexLlmAttempt: () => {
        throw new Error('Mock index failure');
      },
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Index failure prompt',
      providerProfileId: 'profile-selection',
      modelId: 'model-selection',
    });

    expect(generations.complete({ ...prepared.stream, content: 'Still complete' })).toMatchObject({
      status: 'complete',
      assistantMessage: { content: 'Still complete', status: 'complete' },
    });
  });
});

it('freezes concurrent task inputs and excludes another active branch even after it completes and is indexed', async () => {
  const provider: LlmProvider = {
    status: () => ({ key: 'mock', name: 'Mock', model: 'mock', configured: true }),
    stream: vi.fn(),
  };
  const resolver: LlmSelectionResolver = {
    resolveLlmSelection: () => ({
      providerProfileId: 'profile',
      modelId: 'model',
      providerName: 'Mock',
      modelName: 'Mock',
      remoteModelId: 'mock',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://mock.invalid/v1',
    }),
  };
  const { projects, conversation, generations } = await setup(provider, resolver);
  const params = {
    conversationId: conversation.id,
    providerProfileId: 'profile',
    modelId: 'model',
    taskExecution: 'parallel' as const,
  };
  const a = generations.prepare({ ...params, prompt: 'branch A isolated_secret' });
  generations.observe({ ...a.stream, content: 'A partial isolated_secret' });
  const b = generations.prepare({ ...params, prompt: 'Independent B input' });
  const frozenB = generations.runtime(b.stream).context;
  // Routing metadata retains the user-request preview; it is not branch
  // output evidence and comes after the frozen catalog/history context.
  expect(frozenB.split('\n\n当前会话最近任务')[0]).not.toContain('isolated_secret');
  expect(frozenB).not.toContain('A partial isolated_secret');
  expect(frozenB).toContain('用户请求="branch A isolated_secret"');
  projects.access(true, (database, project) => {
    const insert = database.prepare(
      `INSERT INTO agent_tasks(id,project_id,project_session_id,conversation_id,user_message_id,task_type,scope_type,title,request_snapshot_json,request_hash,status,created_at,updated_at)VALUES(?,?,?,?,?,'document-create','project',?,?,'hash','running','now','now')`,
    );
    insert.run(
      'parent-A',
      project.id,
      a.stream.projectSessionId,
      conversation.id,
      a.generation.userMessage.id,
      'Parent A',
      '{}',
    );
    insert.run(
      'artifact-A',
      project.id,
      a.stream.projectSessionId,
      conversation.id,
      a.generation.userMessage.id,
      'Artifact A',
      JSON.stringify({ parentTaskId: 'parent-A' }),
    );
    database
      .prepare(
        "INSERT INTO agent_task_generations(task_id,generation_id,ordinal,purpose,created_at)VALUES('parent-A',?,0,'primary','now')",
      )
      .run(a.stream.generationId);
  });
  new DocumentWorkflowService(projects).saveDraft({
    title: 'Private branch artifact',
    kind: 'note',
    contentMarkdown: 'private_artifact_secret',
    sourceTaskId: 'artifact-A',
    authorType: 'agent',
  });
  const artifactSearch = new LibrarySearchService(projects);
  expect(
    artifactSearch.search({
      taskId: 'B',
      attemptId: b.stream.attemptId,
      query: 'private_artifact_secret',
      sourceTypes: ['document'],
    }).sources,
  ).toEqual([]);

  const supplement = generations.supplement(
    a.stream.generationId,
    'A supplemental isolated_secret',
    'extra-A',
  );
  expect(generations.supplement(a.stream.generationId, supplement.content, 'extra-A').id).toBe(
    supplement.id,
  );
  expect(() =>
    generations.supplement(b.stream.generationId, supplement.content, 'extra-A'),
  ).toThrow('different input');
  generations.complete({ ...a.stream, content: 'A partial isolated_secret complete' });
  const library = new LibrarySearchService(projects);
  expect(
    library.search({
      taskId: 'B',
      attemptId: b.stream.attemptId,
      query: 'isolated_secret',
      sourceTypes: ['conversation'],
    }).sources,
  ).toEqual([]);
  expect(generations.runtime(b.stream).context).toBe(frozenB);
  expect(frozenB).not.toContain('A supplemental isolated_secret');
  expect(frozenB).not.toContain('A partial isolated_secret complete');
  const rows = projects.access(false, (db) =>
    db.prepare('SELECT * FROM generation_branches ORDER BY created_at,branch_id').all(),
  );
  expect(rows).toHaveLength(2);
  generations.complete({ ...b.stream, content: 'B finished' });
  const c = generations.prepare({ ...params, prompt: 'New baseline C' });
  expect(generations.runtime(c.stream).context).toContain('isolated_secret');
});

it('waits for an ordered task and freezes its completed result without occupying Provider execution', async () => {
  const stream = vi.fn();
  const provider: LlmProvider = {
    status: () => ({ key: 'mock', name: 'Mock', model: 'mock', configured: true }),
    stream,
  };
  const resolver: LlmSelectionResolver = {
    resolveLlmSelection: () => ({
      providerProfileId: 'profile',
      modelId: 'model',
      providerName: 'Mock',
      modelName: 'Mock',
      remoteModelId: 'mock',
      protocol: 'openai-chat-completions',
      baseUrl: 'https://mock.invalid/v1',
    }),
  };
  const { conversation, generations } = await setup(provider, resolver);
  const params = {
    conversationId: conversation.id,
    providerProfileId: 'profile',
    modelId: 'model',
    taskExecution: 'ordered' as const,
  };
  const a = generations.prepare({ ...params, prompt: 'First task' });
  const b = generations.prepare({ ...params, prompt: 'Follow up' });
  let ready = false;
  const waiting = generations.waitUntilReady(b.stream, new AbortController().signal).then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  expect(stream).not.toHaveBeenCalled();
  generations.complete({ ...a.stream, content: 'Frozen upstream result' });
  await waiting;
  expect(generations.runtime(b.stream).context).toContain('Frozen upstream result');
  generations.complete({ ...b.stream, content: 'Follow up complete' });
  const c = generations.prepare({ ...params, prompt: 'Parent to cancel' });
  const d = generations.prepare({ ...params, prompt: 'Dependent task' });
  await generations.cancel(c.stream.generationId);
  await expect(generations.waitUntilReady(d.stream, new AbortController().signal)).rejects.toThrow(
    'explicit retry',
  );
});
