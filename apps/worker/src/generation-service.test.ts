import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LlmProvider, LlmStreamRequest } from '@ai-video/llm';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { GenerationService } from './generation-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const projectsToClose: ProjectService[] = [];

afterEach(async () => {
  for (const service of projectsToClose.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup(provider: LlmProvider) {
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
    generations: new GenerationService(projects, content, new ContextService(projects), provider),
  };
}

describe('GenerationService', () => {
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

  it('batches small deltas instead of rewriting SQLite for every increment', async () => {
    const provider: LlmProvider = {
      status: () => ({ key: 'test', name: 'Test', model: 'test-model', configured: true }),
      stream: (request) => {
        for (let index = 0; index < 300; index += 1) request.onDelta('字');
        return Promise.resolve({ model: 'test-model', content: '字'.repeat(300) });
      },
    };
    const { content, conversation, generations } = await setup(provider);
    const save = vi.spyOn(content, 'saveMessage');

    const started = generations.generate(conversation.id, '批量写入');
    await expect.poll(() => generations.get(started.generationId).status).toBe('complete');

    expect(save).toHaveBeenCalledTimes(3);
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
});
