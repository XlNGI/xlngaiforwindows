import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  IPC_PROTOCOL_VERSION,
  type NativeProviderStreamStartParams,
  type ProjectRuntimeInfo,
  type WorkerMethod,
  type WorkerMethodMap,
} from '@ai-video/contracts';
import { createAppRepositories, openAppDatabase, openProjectDatabase } from '@ai-video/persistence';
import { configurePiConversationRuntime, handleRequest } from './handler.js';
import { AppSettingsService } from './app-settings-service.js';
import { NativeProviderBridge } from './native-provider-bridge.js';
import { emptyModelCapabilities } from './provider-registry.js';

await vi.hoisted(async () => {
  const fs = await import('node:fs'),
    os = await import('node:os'),
    path = await import('node:path');
  process.env.AI_VIDEO_APP_DATA_DIR = fs.mkdtempSync(
    path.join(os.tmpdir(), 'novel-batch-settings-'),
  );
});
const roots: string[] = [];
const scope = (runtime: ProjectRuntimeInfo) => ({
  projectId: runtime.project.id,
  projectSessionId: runtime.projectSessionId,
});
async function rpc<M extends WorkerMethod>(
  method: M,
  params: WorkerMethodMap[M]['params'],
  runtime?: ProjectRuntimeInfo,
): Promise<WorkerMethodMap[M]['result']> {
  const response = await handleRequest({
    id: crypto.randomUUID(),
    protocolVersion: IPC_PROTOCOL_VERSION,
    method,
    params,
    ...(runtime ? { scope: scope(runtime) } : {}),
  });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result;
}
afterEach(async () => {
  for (const runtime of await rpc('project.runtime.list', {}))
    await rpc('project.runtime.unload', scope(runtime));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'novel-batch-'));
  roots.push(root);
  const streams: Array<{ id: string; sequence: number; params: NativeProviderStreamStartParams }> =
    [];
  const emit = (stream: (typeof streams)[number], event: Record<string, unknown>) =>
    bridge.handleEnvelope({
      kind: 'host.event',
      requestId: stream.id,
      sequence: stream.sequence++,
      event: { ...event, projectSessionId: stream.params.projectSessionId },
    });
  const bridge = new NativeProviderBridge({
    send(envelope) {
      if (envelope.method === 'provider.stream.start') {
        const stream = {
          id: envelope.requestId,
          sequence: 0,
          params: envelope.params as NativeProviderStreamStartParams,
        };
        streams.push(stream);
        emit(stream, { type: 'started' });
      }
      if (envelope.method === 'provider.stream.cancel') {
        const stream = streams.find(
          (item) => item.id === (envelope.params as { streamRequestId: string }).streamRequestId,
        );
        if (stream) emit(stream, { type: 'cancelled' });
      }
      return Promise.resolve();
    },
  });
  configurePiConversationRuntime(bridge);
  const runtime = await rpc('project.runtime.create', {
    rootPath: join(root, 'project'),
    name: 'Novel batch',
  });
  const settings = new AppSettingsService();
  const profile = settings.createProfile({
    name: 'Mock chapter LLM',
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
  const appDb = openAppDatabase(join(process.env.AI_VIDEO_APP_DATA_DIR!, 'app-settings.sqlite'));
  try {
    const repositories = createAppRepositories(appDb);
    repositories.providerProfiles.save({
      ...repositories.providerProfiles.get(profile.id)!,
      enabled: true,
      connectionStatus: 'ready',
    });
  } finally {
    appDb.close();
    settings.close();
  }
  const conversation = await rpc('conversation.create', { scopeType: 'project' }, runtime);
  const parent = await rpc(
    'agent.run',
    {
      conversationId: conversation.id,
      prompt: '按明确清单并发创作章节草稿',
      providerProfileId: profile.id,
      modelId: model.id,
      idempotencyKey: crypto.randomUUID(),
    },
    runtime,
  );
  if (parent.status !== 'started' || !('stream' in parent))
    throw new Error('Parent was not prepared.');
  await rpc(
    'conversation.runtime.start',
    {
      ...parent.stream,
      taskId: parent.agentTaskId,
      mode: 'document',
      prompt: '按清单并发创作章节',
    },
    runtime,
  );
  await expect.poll(() => streams.length).toBe(1);
  const text = (stream: (typeof streams)[number], value: string) => {
    emit(stream, { type: 'text_delta', delta: value });
    emit(stream, {
      type: 'complete',
      providerResponseId: `response-${stream.id}`,
      finishReason: 'stop',
    });
  };
  const tool = (
    stream: (typeof streams)[number],
    name: string,
    args: Record<string, unknown>,
    id: string = crypto.randomUUID(),
  ) => {
    emit(stream, { type: 'tool_call_start', callId: id, name });
    emit(stream, {
      type: 'tool_call_end',
      call: { id, name, argumentsJson: JSON.stringify(args) },
    });
    emit(stream, {
      type: 'complete',
      providerResponseId: `response-${stream.id}`,
      finishReason: 'tool_calls',
    });
  };
  const latest = (id: string) => streams.filter((item) => item.params.generationId === id).at(-1)!;
  const load = async (generationId: string, names: string[]) => {
    const before = latest(generationId);
    tool(before, 'tools.load', { names });
    await expect.poll(() => latest(generationId).id !== before.id).toBe(true);
    expect(latest(generationId).params.tools?.map((definition) => definition.name)).toEqual(
      expect.arrayContaining(names),
    );
  };
  await load(parent.stream.generationId, ['novel.chapter.batch.submit']);
  const submit = async (args: Record<string, unknown>) => {
    tool(latest(parent.stream.generationId), 'novel.chapter.batch.submit', args, 'batch-submit');
    await expect
      .poll(
        () =>
          streams.filter((item) => item.params.generationId === parent.stream.generationId).length,
      )
      .toBe(3);
    const detail = await rpc('agent.task.get', { taskId: parent.agentTaskId }, runtime);
    if (!detail.chapterBatch)
      throw new Error(JSON.stringify(latest(parent.stream.generationId).params.continuation));
    return rpc('novel.batch.get', { batchId: detail.chapterBatch.batchId }, runtime);
  };
  return { root, runtime, parent, streams, emit, text, tool, latest, load, submit };
}

it('dispatches real novel child tools concurrently, gates draft/published dependencies, and pins explicitly read source versions', async () => {
  const f = await fixture();
  const outline = await rpc(
    'document.draft.save',
    {
      kind: 'outline',
      title: 'Frozen outline',
      contentMarkdown: 'Original outline body',
      authorType: 'user',
    },
    f.runtime,
  );
  const manifest = {
    resourceId: 'workspace:novel',
    executionKey: 'four-chapters',
    references: [
      { documentId: outline.id, versionId: outline.currentVersionId, milestone: 'draft' },
    ],
    chapters: [
      { key: 'a', title: 'A', prompt: 'Write A', action: 'create_chapter' },
      { key: 'b', title: 'B', prompt: 'Write B independently', action: 'create_chapter' },
      {
        key: 'c',
        title: 'C',
        prompt: 'Use A draft explicitly',
        action: 'create_chapter',
        dependsOn: [{ key: 'a', milestone: 'draft' }],
      },
      {
        key: 'd',
        title: 'D',
        prompt: 'Use published A only',
        action: 'create_chapter',
        dependsOn: [{ key: 'a', milestone: 'published' }],
      },
    ],
  };
  const batch = await f.submit(manifest);
  f.tool(
    f.latest(f.parent.stream.generationId),
    'novel.chapter.batch.submit',
    manifest,
    'batch-replay',
  );
  await expect
    .poll(
      () =>
        f.streams.filter((stream) => stream.params.generationId === f.parent.stream.generationId)
          .length,
    )
    .toBe(4);
  expect(
    (await rpc('novel.batch.get', { batchId: batch.batchId }, f.runtime)).children.map(
      (child) => child.taskId,
    ),
  ).toEqual(batch.children.map((child) => child.taskId));
  f.text(f.latest(f.parent.stream.generationId), '四项章节任务已接纳，尚待生成与审核。');
  const [a, b, c, d] = batch.children;
  await expect
    .poll(
      () =>
        new Set(
          f.streams
            .filter((stream) => stream.params.generationId !== f.parent.stream.generationId)
            .map((stream) => stream.params.generationId),
        ).size,
    )
    .toBe(2);
  expect(
    f.streams.some(
      (stream) =>
        stream.params.generationId === c!.generationId ||
        stream.params.generationId === d!.generationId,
    ),
  ).toBe(false);
  expect(f.latest(a!.generationId).params.systemInstruction).not.toContain('Original outline body');
  await rpc(
    'document.draft.save',
    {
      documentId: outline.id,
      title: outline.title,
      kind: outline.kind,
      contentMarkdown: 'Changed outline body',
      expectedDocumentRowVersion: outline.rowVersion,
    },
    f.runtime,
  );
  await f.load(a!.generationId, ['novel.chapter.batch.source.read', 'novel.chapter.submit_draft']);
  f.tool(f.latest(a!.generationId), 'novel.chapter.batch.source.read', {
    versionId: outline.currentVersionId,
  });
  await expect
    .poll(() => f.streams.filter((stream) => stream.params.generationId === a!.generationId).length)
    .toBe(3);
  expect(JSON.stringify(f.latest(a!.generationId).params.continuation)).toContain(
    'Original outline body',
  );
  expect(JSON.stringify(f.latest(a!.generationId).params.continuation)).not.toContain(
    'Changed outline body',
  );
  f.tool(f.latest(a!.generationId), 'novel.chapter.submit_draft', {
    title: 'A',
    contentMarkdown: 'Complete chapter A draft',
  });
  await expect
    .poll(() => f.streams.filter((stream) => stream.params.generationId === a!.generationId).length)
    .toBe(4);
  f.text(f.latest(a!.generationId), 'A draft saved for review.');
  await expect
    .poll(() => f.streams.some((stream) => stream.params.generationId === c!.generationId))
    .toBe(true);
  expect(f.streams.some((stream) => stream.params.generationId === d!.generationId)).toBe(false);
  const produced = await rpc('novel.batch.get', { batchId: batch.batchId }, f.runtime);
  expect(produced.children[2]!.dependsOn[0]!.versionId).toBe(
    produced.children[0]!.documentVersionId,
  );
  const chapterA = await rpc('document.get', { documentId: a!.documentId }, f.runtime);
  await rpc(
    'document.selfPublish',
    {
      documentId: chapterA.id,
      documentVersionId: chapterA.currentVersionId!,
      expectedDocumentRowVersion: chapterA.rowVersion,
      expectedPublishedVersionId: chapterA.publishedVersionId,
    },
    f.runtime,
  );
  await rpc('agent.generation.cancel', { generationId: b!.generationId }, f.runtime);
  await expect
    .poll(() => f.streams.some((stream) => stream.params.generationId === d!.generationId))
    .toBe(true);
  const published = await rpc('novel.batch.get', { batchId: batch.batchId }, f.runtime);
  expect(published.children[3]!.dependsOn[0]!.versionId).toBe(chapterA.currentVersionId);
  const cancelled = await rpc('novel.batch.cancel', { batchId: batch.batchId }, f.runtime);
  expect(cancelled.children[0]!.documentVersionId).toBe(chapterA.currentVersionId);
  expect(
    (await rpc('document.get', { documentId: a!.documentId }, f.runtime)).currentVersion
      ?.contentMarkdown,
  ).toBe('Complete chapter A draft');
  const chapters = await rpc('novel.chapter.list', { includeArchived: true }, f.runtime);
  expect(
    chapters
      .filter((chapter) => chapter.id !== a!.chapterId)
      .every((chapter) => chapter.lifecycleStatus === 'archived'),
  ).toBe(true);
});

it('preserves a full conflict candidate and rejects another active task for the same chapter', async () => {
  const f = await fixture();
  const chapter = await rpc('novel.chapter.save', { title: 'Existing' }, f.runtime);
  const original = await rpc(
    'document.draft.save',
    {
      documentId: chapter.documentId,
      title: 'Existing',
      contentMarkdown: 'Original body',
      expectedDocumentRowVersion: chapter.documentRowVersion,
    },
    f.runtime,
  );
  const batch = await f.submit({
    resourceId: 'workspace:novel',
    executionKey: 'rewrite',
    chapters: [
      {
        key: 'rewrite',
        title: chapter.title,
        prompt: 'Rewrite this chapter',
        action: 'rewrite_chapter',
        chapterId: chapter.id,
        expectedChapterRowVersion: chapter.rowVersion,
        expectedDocumentRowVersion: original.rowVersion,
        baseVersionId: original.currentVersionId,
      },
    ],
  });
  f.text(f.latest(f.parent.stream.generationId), 'Rewrite task accepted.');
  const child = batch.children[0]!;
  await expect
    .poll(() => f.streams.some((stream) => stream.params.generationId === child.generationId))
    .toBe(true);
  const current = await rpc('document.get', { documentId: chapter.documentId }, f.runtime);
  await rpc(
    'document.draft.save',
    {
      documentId: current.id,
      title: current.title,
      kind: current.kind,
      contentMarkdown: 'Manual edited body',
      expectedDocumentRowVersion: current.rowVersion,
    },
    f.runtime,
  );
  await f.load(child.generationId, ['novel.chapter.submit_draft']);
  f.tool(f.latest(child.generationId), 'novel.chapter.submit_draft', {
    title: 'Existing',
    contentMarkdown: 'Complete generated conflict candidate',
  });
  await expect
    .poll(
      async () =>
        (await rpc('novel.batch.get', { batchId: batch.batchId }, f.runtime)).children[0]!.status,
    )
    .toBe('conflict');
  expect(
    (await rpc('document.get', { documentId: chapter.documentId }, f.runtime)).currentVersion
      ?.contentMarkdown,
  ).toBe('Manual edited body');
  const partials = await rpc('agent.partial.list', { includeTerminal: false }, f.runtime);
  expect(
    partials.some((partial) => partial.taskId === child.taskId && partial.status === 'recoverable'),
  ).toBe(true);
  const db = openProjectDatabase(join(f.runtime.project.rootPath, 'project.sqlite'), {
    readonly: true,
  });
  try {
    expect(
      db
        .prepare('SELECT content_text FROM agent_partial_artifacts WHERE task_id=?')
        .get(child.taskId),
    ).toEqual({ content_text: 'Complete generated conflict candidate' });
    expect(
      db.prepare('SELECT task_id FROM novel_chapter_task_locks WHERE chapter_id=?').get(chapter.id),
    ).toEqual({ task_id: child.taskId });
  } finally {
    db.close();
  }
  const freshChapter = (await rpc('novel.chapter.list', {}, f.runtime)).find(
    (item) => item.id === chapter.id,
  )!;
  const freshDocument = await rpc('document.get', { documentId: chapter.documentId }, f.runtime);
  const selected = f.streams[0]!.params;
  const another = await rpc(
    'agent.run',
    {
      conversationId: f.parent.stream.conversationId,
      prompt: 'Try another task for the same chapter',
      providerProfileId: selected.providerProfileId,
      modelId: selected.modelId,
      taskExecution: 'parallel',
    },
    f.runtime,
  );
  if (another.status !== 'started' || !('stream' in another))
    throw new Error('Second parent did not prepare.');
  await rpc(
    'conversation.runtime.start',
    { ...another.stream, taskId: another.agentTaskId, mode: 'document', prompt: 'Try same target' },
    f.runtime,
  );
  await expect
    .poll(() =>
      f.streams.some((stream) => stream.params.generationId === another.stream.generationId),
    )
    .toBe(true);
  await f.load(another.stream.generationId, ['novel.chapter.batch.submit']);
  f.tool(f.latest(another.stream.generationId), 'novel.chapter.batch.submit', {
    resourceId: 'workspace:novel',
    executionKey: 'same-chapter',
    chapters: [
      {
        key: 'again',
        title: chapter.title,
        prompt: 'Another rewrite',
        action: 'rewrite_chapter',
        chapterId: chapter.id,
        expectedChapterRowVersion: freshChapter.rowVersion,
        expectedDocumentRowVersion: freshDocument.rowVersion,
        baseVersionId: freshDocument.currentVersionId,
      },
    ],
  });
  await expect
    .poll(
      () =>
        f.streams.filter((stream) => stream.params.generationId === another.stream.generationId)
          .length,
    )
    .toBe(3);
  expect(JSON.stringify(f.latest(another.stream.generationId).params.continuation)).toContain(
    'active writing task',
  );
  expect(
    (await rpc('agent.task.get', { taskId: another.agentTaskId }, f.runtime)).chapterBatch,
  ).toBeUndefined();
});

it('rejects cyclic or forward chapter manifests at the real tool entry without allocating placeholders', async () => {
  const f = await fixture();
  f.tool(f.latest(f.parent.stream.generationId), 'novel.chapter.batch.submit', {
    resourceId: 'workspace:novel',
    executionKey: 'invalid',
    chapters: [
      {
        key: 'a',
        title: 'A',
        prompt: 'A',
        action: 'create_chapter',
        dependsOn: [{ key: 'b', milestone: 'draft' }],
      },
      { key: 'b', title: 'B', prompt: 'B', action: 'create_chapter' },
    ],
  });
  await expect
    .poll(
      () =>
        f.streams.filter((stream) => stream.params.generationId === f.parent.stream.generationId)
          .length,
    )
    .toBe(3);
  expect(JSON.stringify(f.latest(f.parent.stream.generationId).params.continuation)).toContain(
    'earlier chapter',
  );
  expect(await rpc('novel.chapter.list', { includeArchived: true }, f.runtime)).toEqual([]);
  expect(
    (await rpc('agent.task.get', { taskId: f.parent.agentTaskId }, f.runtime)).chapterBatch,
  ).toBeUndefined();
  expect(
    f.streams.every((stream) => stream.params.generationId === f.parent.stream.generationId),
  ).toBe(true);
});
