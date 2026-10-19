import { cp, mkdtemp, rename, rm, symlink, open, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  ProjectRuntimeInfo,
  ProjectRuntimeScope,
  WorkerMethod,
  WorkerMethodMap,
} from '@ai-video/contracts';
import { IPC_PROTOCOL_VERSION } from '@ai-video/contracts';
import {
  bindWorkerRequest,
  configurePiConversationRuntime,
  handleRequest,
  parseRequest,
} from './handler.js';
import { ProjectService } from './project-service.js';
import { RequestScheduler } from './request-scheduler.js';
import { NativeProviderBridge } from './native-provider-bridge.js';
import { AppSettingsService } from './app-settings-service.js';
import { createAppRepositories, openAppDatabase } from '@ai-video/persistence';
import { emptyModelCapabilities } from './provider-registry.js';

await vi.hoisted(async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  process.env.AI_VIDEO_APP_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'runtime-handler-settings-'),
  );
});
const bases: string[] = [];
const scope = (runtime: ProjectRuntimeInfo): ProjectRuntimeScope => ({
  projectId: runtime.project.id,
  projectSessionId: runtime.projectSessionId,
});
async function rpc<M extends WorkerMethod>(
  method: M,
  params: WorkerMethodMap[M]['params'],
  runtime?: ProjectRuntimeScope,
): Promise<WorkerMethodMap[M]['result']> {
  const response = await handleRequest({
    id: crypto.randomUUID(),
    protocolVersion: IPC_PROTOCOL_VERSION,
    method,
    params,
    ...(runtime ? { scope: runtime } : {}),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result;
}
async function fixtures() {
  const base = await mkdtemp(join(tmpdir(), 'project-runtime-integration-'));
  bases.push(base);
  const create = (name: string) => {
    const project = new ProjectService({ recentProjectsPath: join(base, 'recent.json') });
    try {
      return project.create(join(base, name), name);
    } finally {
      project.close();
    }
  };
  const a = create('A'),
    b = create('B');
  const runtimeA = await rpc('project.runtime.attach', { rootPath: a.rootPath });
  const runtimeB = await rpc('project.runtime.attach', { rootPath: b.rootPath });
  return { base, a, b, runtimeA, runtimeB };
}
afterEach(async () => {
  for (const runtime of await rpc('project.runtime.list', {}))
    await rpc('project.runtime.unload', scope(runtime));
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
});

describe('multi-project Worker routing', () => {
  it('keeps two project Pi streams isolated and cancels only the explicitly unloaded project', async () => {
    const f = await fixtures();
    const settings = new AppSettingsService();
    const profile = settings.createProfile({
      name: 'Mock OpenAI',
      category: 'llm',
      providerType: 'openai',
      accessType: 'official',
      protocol: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    });
    const model = settings.createManualModel({
      profileId: profile.id,
      remoteModelId: 'gpt-4o',
      enabled: true,
      capabilities: { ...emptyModelCapabilities(), text: true, streaming: true, tools: true },
    });
    const db = openAppDatabase(join(process.env.AI_VIDEO_APP_DATA_DIR!, 'app-settings.sqlite'));
    try {
      const repo = createAppRepositories(db);
      repo.providerProfiles.save({
        ...repo.providerProfiles.get(profile.id)!,
        enabled: true,
        connectionStatus: 'ready',
      });
    } finally {
      db.close();
      settings.close();
    }
    const streams: Array<{ id: string; epoch: string; sequence: number }> = [];
    const emit = (stream: (typeof streams)[number], event: Record<string, unknown>) =>
      bridge.handleEnvelope({
        kind: 'host.event',
        requestId: stream.id,
        sequence: stream.sequence++,
        event: { ...event, projectSessionId: stream.epoch },
      });
    const bridge = new NativeProviderBridge({
      send(envelope) {
        if (envelope.method === 'provider.stream.start') {
          const stream = {
            id: envelope.requestId,
            epoch: (envelope.params as { projectSessionId: string }).projectSessionId,
            sequence: 0,
          };
          streams.push(stream);
          emit(stream, { type: 'started' });
        } else if (envelope.method === 'provider.stream.cancel') {
          const stream = streams.find(
            (item) => item.id === (envelope.params as { streamRequestId: string }).streamRequestId,
          );
          if (stream) emit(stream, { type: 'cancelled' });
        }
        return Promise.resolve();
      },
    });
    configurePiConversationRuntime(bridge);
    const start = async (runtime: ProjectRuntimeInfo) => {
      const conversation = await rpc(
        'conversation.create',
        { scopeType: 'project' },
        scope(runtime),
      );
      const prepared = await rpc(
        'agent.run',
        {
          conversationId: conversation.id,
          prompt: `Reply for ${runtime.project.name}`,
          providerProfileId: profile.id,
          modelId: model.id,
          idempotencyKey: crypto.randomUUID(),
        },
        scope(runtime),
      );
      if (prepared.status !== 'started' || !('stream' in prepared))
        throw new Error('Agent did not start.');
      await rpc(
        'conversation.runtime.start',
        {
          ...prepared.stream,
          taskId: prepared.agentTaskId,
          mode: 'document',
          prompt: 'Reply directly.',
        },
        scope(runtime),
      );
      return { prepared, conversation };
    };
    const a = await start(f.runtimeA),
      b = await start(f.runtimeB);
    await expect.poll(() => streams.length).toBe(2);
    await rpc('project.runtime.activate', scope(f.runtimeB));
    emit(
      streams.find((item) => item.epoch === f.runtimeA.projectSessionId)!,
      { type: 'text_delta', delta: 'Only A fragment' },
    );
    await rpc('project.runtime.unload', scope(f.runtimeA));
    const streamB = streams.find((item) => item.epoch === f.runtimeB.projectSessionId)!;
    emit(streamB, { type: 'text_delta', delta: 'Only B complete' });
    emit(streamB, { type: 'complete', providerResponseId: 'b-response', finishReason: 'stop' });
    await expect
      .poll(
        async () =>
          (
            await rpc(
              'llm.generation.get',
              { generationId: b.prepared.stream.generationId },
              scope(f.runtimeB),
            )
          ).status,
      )
      .toBe('complete');
    const messages = await rpc(
      'chat.message.list',
      { conversationId: b.conversation.id },
      scope(f.runtimeB),
    );
    expect(messages.items.some((item) => item.content === 'Only B complete')).toBe(true);
    expect(messages.items.some((item) => item.content.includes('Only A fragment'))).toBe(false);
    const reopened = await rpc('project.runtime.attach', { rootPath: f.a.rootPath });
    expect(
      (
        await rpc(
          'llm.generation.get',
          { generationId: a.prepared.stream.generationId },
          scope(reopened),
        )
      ).status,
    ).toBe('cancelled');
  });
  it('binds queued commands to their original runtime even when another project becomes active', async () => {
    const f = await fixtures();
    await rpc('project.runtime.activate', scope(f.runtimeA));
    const request = bindWorkerRequest({
      id: 'queued-a',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'document.save',
      params: { kind: 'note', title: 'Only A', contentMarkdown: 'A content' },
    });
    await rpc('project.runtime.activate', scope(f.runtimeB));
    expect((await request.run()).ok).toBe(true);
    expect((await rpc('document.list', {}, scope(f.runtimeA))).map((item) => item.title)).toEqual([
      'Only A',
    ]);
    expect(await rpc('document.list', {}, scope(f.runtimeB))).toEqual([]);
    expect((await rpc('project.current', {}))?.id).toBe(f.b.id);
  });

  it('isolates project queues and rejects a queued command after unload and reopen', async () => {
    const f = await fixtures();
    const scheduler = new RequestScheduler();
    let release!: () => void;
    const blocked = scheduler.run(
      'document.save',
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      f.runtimeA.projectSessionId,
    );
    const a = bindWorkerRequest({
      id: 'a',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'document.save',
      scope: scope(f.runtimeA),
      params: { kind: 'note', title: 'stale', contentMarkdown: 'must not save' },
    });
    const queued = scheduler.run('document.save', a.run, a.queueKey);
    const b = bindWorkerRequest({
      id: 'b',
      protocolVersion: IPC_PROTOCOL_VERSION,
      method: 'document.save',
      scope: scope(f.runtimeB),
      params: { kind: 'note', title: 'B ready', contentMarkdown: 'saved' },
    });
    expect((await scheduler.run('document.save', b.run, b.queueKey)).ok).toBe(true);
    await rpc('project.runtime.unload', scope(f.runtimeA));
    const reopened = await rpc('project.runtime.attach', {
      rootPath: f.a.rootPath,
      expectedProjectId: f.a.id,
    });
    expect(reopened.projectSessionId).not.toBe(f.runtimeA.projectSessionId);
    release();
    await blocked;
    expect(await queued).toMatchObject({ ok: false, error: { code: 'STALE_SESSION' } });
    expect(await rpc('document.list', {}, scope(reopened))).toEqual([]);
    expect((await rpc('document.list', {}, scope(f.runtimeB)))[0]?.title).toBe('B ready');
  });

  it('rejects mismatched containers, links, and duplicate project identities without changing the active project', async () => {
    const f = await fixtures();
    await rpc('project.runtime.activate', scope(f.runtimeA));
    await expect(
      rpc('project.runtime.attach', { rootPath: f.b.rootPath, expectedProjectId: f.a.id }),
    ).rejects.toThrow('identity');
    const clone = join(f.base, 'A-clone');
    await cp(f.a.rootPath, clone, { recursive: true });
    await expect(rpc('project.runtime.attach', { rootPath: clone })).rejects.toThrow(
      'different container',
    );
    await symlink(f.b.rootPath, join(f.base, 'B-link'), 'junction');
    await expect(
      rpc('project.runtime.attach', { rootPath: join(f.base, 'B-link') }),
    ).rejects.toThrow('links');
    expect((await rpc('project.current', {}))?.id).toBe(f.a.id);
    expect(await rpc('project.runtime.list', {})).toHaveLength(2);
    expect(
      parseRequest({
        id: 'bad-scope',
        protocolVersion: IPC_PROTOCOL_VERSION,
        method: 'document.list',
        params: {},
        scope: {
          projectId: f.a.id,
          projectSessionId: f.runtimeA.projectSessionId,
          path: 'arbitrary',
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('guards a moved project directory while keeping another project writable', async () => {
    const f = await fixtures();
    const moved = join(f.base, 'A-moved');
    try {
      await rename(f.a.rootPath, moved);
    } catch (error) {
      // Windows denies moving a directory containing an open SQLite handle.
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM')
        throw error;
      await rpc(
        'document.save',
        { kind: 'note', title: 'B safe', contentMarkdown: 'B' },
        scope(f.runtimeB),
      );
      expect(await rpc('document.list', {}, scope(f.runtimeA))).toEqual([]);
      return;
    }
    try {
      await expect(
        rpc(
          'document.save',
          { kind: 'note', title: 'wrong', contentMarkdown: 'wrong' },
          scope(f.runtimeA),
        ),
      ).rejects.toThrow();
      await rpc(
        'document.save',
        { kind: 'note', title: 'B safe', contentMarkdown: 'B' },
        scope(f.runtimeB),
      );
    } finally {
      await rename(moved, f.a.rootPath);
    }
    expect(await rpc('document.list', {}, scope(f.runtimeA))).toEqual([]);
  });

  it('executes A and B video submissions concurrently and fences a late A response after unload', async () => {
    const f = await fixtures();
    const settings = new AppSettingsService();
    const profile = settings.createProfile({
      name: 'Mock Vidu',
      category: 'multi',
      providerType: 'vidu',
      accessType: 'official',
      protocol: 'vidu-v2',
      baseUrl: 'https://api.vidu.com',
    });
    const db = openAppDatabase(join(process.env.AI_VIDEO_APP_DATA_DIR!, 'app-settings.sqlite'));
    try {
      const repo = createAppRepositories(db);
      const saved = repo.providerProfiles.get(profile.id)!;
      repo.providerProfiles.save({ ...saved, enabled: true, connectionStatus: 'ready' });
    } finally {
      db.close();
      settings.close();
    }
    const models = await rpc('provider.model.list', { profileId: profile.id });
    const model = models.find((item) => item.remoteModelId === 'viduq3-pro')!;
    const submissions: Array<{ requestId: string; operationId: string }> = [];
    const bridge = new NativeProviderBridge({
      send(envelope) {
        if (envelope.method === 'provider.media.submit')
          submissions.push({
            requestId: envelope.requestId,
            operationId: (envelope.params as { operationId: string }).operationId,
          });
        else if (envelope.method === 'provider.media.poll')
          queueMicrotask(() =>
            bridge.handleEnvelope({
              kind: 'host.response',
              requestId: envelope.requestId,
              ok: true,
              result: { providerStatus: 200, state: 'running', providerState: 'processing' },
            }),
          );
        return Promise.resolve();
      },
    });
    configurePiConversationRuntime(bridge);
    const prepare = (runtime: ProjectRuntimeInfo) =>
      rpc(
        'video.generate.prepare',
        {
          adapterKey: 'TEXT_TO_VIDEO:vidu:viduq3-pro:v2',
          providerRegion: 'global',
          providerProfileId: profile.id,
          modelId: model.id,
          parameters: {
            prompt: 'mock',
            duration: 5,
            aspect_ratio: '16:9',
            resolution: '720p',
            audio: true,
          },
        },
        scope(runtime),
      );
    const a = await prepare(f.runtimeA),
      b = await prepare(f.runtimeB);
    const approve = async (jobId: string, runtime: ProjectRuntimeInfo) => {
      const pending = await rpc('media.generation.requestSubmission', { jobId }, scope(runtime));
      return rpc(
        'media.generation.confirmSubmission',
        { jobId, confirmationToken: pending.confirmation!.confirmationToken, approved: true },
        scope(runtime),
      );
    };
    const runA = approve(a.id, f.runtimeA).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    const runB = approve(b.id, f.runtimeB);
    await expect.poll(() => submissions.length).toBe(2);
    await rpc('project.runtime.activate', scope(f.runtimeB));
    await rpc('project.runtime.unload', scope(f.runtimeA));
    for (const submission of submissions)
      bridge.handleEnvelope({
        kind: 'host.response',
        requestId: submission.requestId,
        ok: true,
        result: { status: 200, taskId: `remote-${submission.operationId}` },
      });
    expect(await runA).toHaveProperty('error');
    expect((await runB).job).toMatchObject({ providerTaskId: `remote-${b.id}` });
    expect(
      (await rpc('video.generate.get', { jobId: b.id }, scope(f.runtimeB))).providerTaskId,
    ).toBe(`remote-${b.id}`);
    const reopened = await rpc('project.runtime.attach', { rootPath: f.a.rootPath });
    expect(
      (await rpc('video.generate.get', { jobId: a.id }, scope(reopened))).providerTaskId,
    ).toBeUndefined();
    expect((await rpc('project.current', {}))?.id).toBe(f.b.id);
  });
});

it('creates a project through the runtime control without draining an existing active project', async () => {
  const f = await fixtures();
  await rpc('project.runtime.activate', scope(f.runtimeA));
  const created = await rpc('project.runtime.create', {
    rootPath: join(f.base, 'new-project'),
    name: 'New Project',
  });
  expect((await rpc('project.runtime.list', {})).map((entry) => entry.project.id)).toEqual(
    expect.arrayContaining([f.a.id, f.b.id, created.project.id]),
  );
  const conversation = await rpc(
    'conversation.create',
    { scopeType: 'project' },
    scope(f.runtimeA),
  );
  expect(conversation.projectId).toBe(f.a.id);
  expect(await rpc('conversation.runtime.list', {}, scope(f.runtimeA))).toEqual([]);
});

it('runs two same-conversation branches concurrently while an ordered follow-up waits for its own prerequisite', async () => {
  const f = await fixtures();
  const settings = new AppSettingsService();
  const profile = settings.createProfile({
    name: 'Mock OpenAI',
    category: 'llm',
    providerType: 'openai',
    accessType: 'official',
    protocol: 'openai-responses',
    baseUrl: 'https://api.openai.com/v1',
  });
  const model = settings.createManualModel({
    profileId: profile.id,
    remoteModelId: 'gpt-4o',
    enabled: true,
    capabilities: { ...emptyModelCapabilities(), text: true, streaming: true, tools: true },
  });
  const db = openAppDatabase(join(process.env.AI_VIDEO_APP_DATA_DIR!, 'app-settings.sqlite'));
  try {
    const repo = createAppRepositories(db);
    repo.providerProfiles.save({
      ...repo.providerProfiles.get(profile.id)!,
      enabled: true,
      connectionStatus: 'ready',
    });
  } finally {
    db.close();
    settings.close();
  }
  const streams: Array<{ id: string; epoch: string; sequence: number }> = [];
  const emit = (stream: (typeof streams)[number], event: Record<string, unknown>) =>
    bridge.handleEnvelope({
      kind: 'host.event',
      requestId: stream.id,
      sequence: stream.sequence++,
      event: { ...event, projectSessionId: stream.epoch },
    });
  const bridge = new NativeProviderBridge({
    send(envelope) {
      if (envelope.method === 'provider.stream.start') {
        const stream = {
          id: envelope.requestId,
          epoch: (envelope.params as { projectSessionId: string }).projectSessionId,
          sequence: 0,
        };
        streams.push(stream);
        emit(stream, { type: 'started' });
      } else if (envelope.method === 'provider.stream.cancel') {
        const stream = streams.find(
          (item) => item.id === (envelope.params as { streamRequestId: string }).streamRequestId,
        );
        if (stream) emit(stream, { type: 'cancelled' });
      }
      return Promise.resolve();
    },
  });
  configurePiConversationRuntime(bridge);
  const start = async (
    runtime: ProjectRuntimeInfo,
    shared?: import('@ai-video/contracts').ConversationInfo,
    taskExecution: 'ordered' | 'parallel' = 'parallel',
  ) => {
    const conversation =
      shared ?? (await rpc('conversation.create', { scopeType: 'project' }, scope(runtime)));
    const prepared = await rpc(
      'agent.run',
      {
        conversationId: conversation.id,
        taskExecution,
        prompt: `Reply for ${runtime.project.name}`,
        providerProfileId: profile.id,
        modelId: model.id,
        idempotencyKey: crypto.randomUUID(),
      },
      scope(runtime),
    );
    if (prepared.status !== 'started' || !('stream' in prepared))
      throw new Error('Agent did not start.');
    await rpc(
      'conversation.runtime.start',
      {
        ...prepared.stream,
        taskId: prepared.agentTaskId,
        mode: 'document',
        prompt: 'Reply directly.',
      },
      scope(runtime),
    );
    return { prepared, conversation };
  };
  const a = await start(f.runtimeA),
    b = await start(f.runtimeA, a.conversation);
  await expect.poll(() => streams.length).toBe(2);
  const ordered = await start(f.runtimeA, a.conversation, 'ordered');
  expect(
    (
      await rpc(
        'llm.generation.get',
        { generationId: ordered.prepared.stream.generationId },
        scope(f.runtimeA),
      )
    ).status,
  ).toBe('prepared');
  expect(streams).toHaveLength(2);
  await rpc(
    'agent.generation.cancel',
    { generationId: a.prepared.stream.generationId },
    scope(f.runtimeA),
  );
  expect(
    (
      await rpc(
        'llm.generation.get',
        { generationId: b.prepared.stream.generationId },
        scope(f.runtimeA),
      )
    ).status,
  ).toBe('prepared');
  emit(streams[1]!, { type: 'text_delta', delta: 'Independent B result' });
  emit(streams[1]!, { type: 'complete', providerResponseId: 'b-complete', finishReason: 'stop' });
  await expect.poll(() => streams.length).toBe(3);
  const request = await rpc('llm.generation.runtime', ordered.prepared.stream, scope(f.runtimeA));
  expect(request.context).toContain('Independent B result');
  expect(
    (
      await rpc(
        'llm.generation.get',
        { generationId: a.prepared.stream.generationId },
        scope(f.runtimeA),
      )
    ).status,
  ).toBe('cancelled');
  const extra = await rpc(
    'conversation.runtime.supplement',
    {
      generationId: ordered.prepared.stream.generationId,
      content: 'Add a concise ending',
      idempotencyKey: 'ordered-extra',
    },
    scope(f.runtimeA),
  );
  expect(extra.conversationId).toBe(a.conversation.id);
  emit(streams[2]!, { type: 'text_delta', delta: 'Ordered first response' });
  emit(streams[2]!, {
    type: 'complete',
    providerResponseId: 'ordered-complete',
    finishReason: 'stop',
  });
  await expect.poll(() => streams.length).toBe(4);
  const supplemented = await rpc(
    'llm.generation.runtime',
    ordered.prepared.stream,
    scope(f.runtimeA),
  );
  expect(supplemented.prompt).toContain('Add a concise ending');
  expect(supplemented.context).toContain('Ordered first response');
  emit(streams[3]!, { type: 'text_delta', delta: 'Concise ending' });
  emit(streams[3]!, {
    type: 'complete',
    providerResponseId: 'supplement-complete',
    finishReason: 'stop',
  });
  await expect
    .poll(
      async () =>
        (
          await rpc(
            'llm.generation.get',
            { generationId: ordered.prepared.stream.generationId },
            scope(f.runtimeA),
          )
        ).status,
    )
    .toBe('complete');
});

it('keeps health and cancellation responsive during an actual large project export and preserves per-project file ownership', async () => {
  const f = await fixtures();
  const input = join(f.a.rootPath, 'assets', 'images', 'large.bin');
  const descriptor = await open(input, 'wx');
  try {
    const block = Buffer.alloc(1024 * 1024, 42);
    for (let i = 0; i < 64; i++) await descriptor.write(block);
  } finally {
    await descriptor.close();
  }
  const destination = join(f.base, 'large-export');
  const task = await rpc(
    'file.task.create',
    { kind: 'project-export', destinationRoot: destination, idempotencyKey: 'large-export' },
    scope(f.runtimeA),
  );
  await expect
    .poll(async () => (await rpc('file.task.get', { taskId: task.id }, scope(f.runtimeA))).status)
    .toBe('running');
  const start = performance.now();
  expect(await rpc('health', {})).toHaveProperty('pid');
  expect(performance.now() - start).toBeLessThan(500);
  const conversation = await rpc(
    'conversation.create',
    { scopeType: 'project' },
    scope(f.runtimeB),
  );
  expect(conversation.projectId).toBe(f.b.id);
  const cancelled = await rpc('file.task.cancel', { taskId: task.id }, scope(f.runtimeA));
  expect(cancelled.status).toBe('cancelled');
  expect((await readdir(f.base)).some((name) => name.startsWith('.project-export-'))).toBe(false);
  await expect(readFile(join(destination, 'project.sqlite'))).rejects.toThrow();
  await expect(rpc('file.task.get', { taskId: task.id }, scope(f.runtimeB))).rejects.toThrow(
    'not found',
  );
  const backup = await rpc(
    'file.task.create',
    { kind: 'project-backup', idempotencyKey: 'B-backup' },
    scope(f.runtimeB),
  );
  await expect
    .poll(async () => (await rpc('file.task.get', { taskId: backup.id }, scope(f.runtimeB))).status)
    .toBe('succeeded');
});

it('bounds 80 mixed business jobs and keeps every project progressing with measured health latency', async () => {
  const f = await fixtures();
  const latencies: number[] = [];
  for (let index = 0; index < 20; index++) {
    const runtime = index % 2 ? f.runtimeA : f.runtimeB;
    const scheduledAt = performance.now();
    const health = new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        void rpc('health', {}).then(() => {
          latencies.push(performance.now() - scheduledAt);
          resolve();
        }, reject);
      }, 0),
    );
    const tasks = await Promise.all(
      Array.from({ length: 4 }, (_, offset) =>
        rpc(
          'file.task.create',
          { kind: 'project-backup', idempotencyKey: 'pressure-' + index + '-' + offset },
          scope(runtime),
        ),
      ),
    );
    await health;
    await expect
      .poll(async () =>
        Promise.all(
          tasks.map((task) => rpc('file.task.get', { taskId: task.id }, scope(runtime))),
        ).then((jobs) => jobs.every((job) => job.status === 'succeeded')),
      )
      .toBe(true);
  }
  latencies.sort((a, b) => a - b);
  const stats = {
    p50: latencies[Math.floor(latencies.length * 0.5)],
    p95: latencies[Math.floor(latencies.length * 0.95)],
    max: latencies.at(-1),
  };
  expect(stats.max).toBeLessThan(500);
  expect((await rpc('file.task.list', {}, scope(f.runtimeA))).length).toBe(40);
  expect((await rpc('file.task.list', {}, scope(f.runtimeB))).length).toBe(40);
  process.stdout.write('Concurrency pressure health latency ms ' + JSON.stringify(stats) + '\n');
});
