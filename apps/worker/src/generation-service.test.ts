import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider, LlmStreamRequest } from '@ai-video/llm';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import {
  GenerationService,
  type LlmSelectionResolver,
  type LlmUsageIndexer,
} from './generation-service.js';
import { ProjectService } from './project-service.js';

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
    }),
  };
}

describe('GenerationService', () => {
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
        return Promise.resolve({ model: 'test-model', content: '第一段第二段' });
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

  it('reconstructs a terminal generation from SQLite after a Worker restart', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request) => {
        request.onDelta('Persisted');
        return Promise.resolve({ model: 'test-model', content: 'Persisted response' });
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
        return Promise.resolve({ model: 'test-model', content: '字'.repeat(300) });
      },
    };
    const { conversation, generations, projects } = await setup(provider);
    const access = vi.spyOn(projects, 'access');

    const started = generations.generate(conversation.id, '批量写入');
    await expect.poll(() => generations.get(started.generationId).status).toBe('complete');

    expect(access.mock.calls.filter(([writable]) => writable)).toHaveLength(2);
    expect(generations.get(started.generationId).assistantMessage.content).toHaveLength(300);
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
        return Promise.resolve({ model: 'test-model', content: '重试成功' });
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
