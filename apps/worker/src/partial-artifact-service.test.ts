import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { GenerationService, type LlmSelectionResolver } from './generation-service.js';
import { AgentProviderLoopService } from './agent-provider-loop-service.js';
import { NovelService } from './novel-service.js';
import { PartialArtifactService } from './partial-artifact-service.js';
import { ProjectService } from './project-service.js';
import type { LlmProvider } from '@ai-video/llm';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-partial-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  project.create(join(directory, 'project'), '雾港纪事');
  const content = new ContentService(project);
  const conversation = content.createConversation({ scopeType: 'project' });
  const provider: LlmProvider = {
    status: () => ({ key: 'mock', name: 'Mock', model: 'mock', configured: false }),
    stream: () => Promise.reject(new Error('not used')),
  };
  const selection: LlmSelectionResolver = {
    resolveLlmSelection: () => ({
      providerProfileId: 'profile',
      providerName: 'Mock',
      modelId: 'model',
      modelName: 'Mock',
      remoteModelId: 'mock',
      protocol: 'openai-responses',
      baseUrl: 'https://mock.invalid',
    }),
  };
  const generations = new GenerationService(
    project,
    content,
    new ContextService(project),
    provider,
    { selectionResolver: selection },
  );
  const workflow = new DocumentWorkflowService(project);
  const novel = new NovelService(project);
  const chapter = novel.saveChapter({ title: '雨夜来客' });
  const prepared = generations.prepare({
    conversationId: conversation.id,
    prompt: '续写',
    providerProfileId: 'profile',
    modelId: 'model',
  });
  const loop = new AgentProviderLoopService(project, workflow);
  const agent = loop.prepare(
    prepared.stream,
    '续写',
    '续写',
    { operation: 'novel.chapter.submit_draft', documentId: chapter.documentId },
    'project_only',
  );
  const projectId = project.access(false, (_database, current) => current.id);
  project.access(true, (database) => {
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO agent_task_targets (task_id, project_id, target_kind, chapter_id, document_id, action, created_placeholder, created_at)
       VALUES (?, ?, 'novel-chapter', ?, ?, 'continue_chapter', 0, ?)`,
      )
      .run(agent.taskId, projectId, chapter.id, chapter.documentId, now);
  });
  return {
    project,
    generations,
    prepared,
    agent,
    chapter,
    partials: new PartialArtifactService(project, workflow),
  };
}

describe('PartialArtifactService', () => {
  it('recovers persisted novel text before restart terminalization and remains idempotent', async () => {
    const { generations, prepared, partials } = await setup();
    const content = 'Worker 重启前已经持久化的章节正文。';
    generations.observe({ ...prepared.stream, content });

    expect(partials.recoverInterrupted()).toBe(1);
    expect(partials.list()).toEqual([
      expect.objectContaining({
        targetKind: 'chapter',
        contentLength: Buffer.byteLength(content, 'utf8'),
        status: 'recoverable',
      }),
    ]);
    expect(partials.recoverInterrupted()).toBe(0);
  });

  it('captures bounded validated text for an interrupted novel task', async () => {
    const { prepared, partials } = await setup();
    const captured = partials.captureInterrupted(prepared.stream, '中断前正文');
    expect(captured).toMatchObject({
      targetKind: 'chapter',
      contentLength: Buffer.byteLength('中断前正文', 'utf8'),
      status: 'recoverable',
      rowVersion: 0,
    });
    expect(partials.list()).toHaveLength(1);
    expect(partials.captureInterrupted(prepared.stream, '')).toBeUndefined();
  });

  it('deduplicates repeated interruption capture and records a redacted task event', async () => {
    const { project, prepared, agent, partials } = await setup();
    const content = 'recoverable content must not appear in audit text';
    const first = partials.captureInterrupted(prepared.stream, content);
    const repeated = partials.captureInterrupted(prepared.stream, content);

    expect(first?.id).toBe(repeated?.id);
    expect(partials.list()).toHaveLength(1);
    const events = project.access(
      false,
      (database) =>
        database
          .prepare(
            'SELECT event_type, summary FROM agent_task_events WHERE task_id = ? ORDER BY sequence DESC',
          )
          .all(agent.taskId) as Array<{ event_type: string; summary: string }>,
    );
    expect(events).toContainEqual(
      expect.objectContaining({ event_type: 'agent.partial.captured' }),
    );
    expect(events.map((event) => event.summary).join('\n')).not.toContain(content);
  });

  it('recovers one interrupted chapter fragment into a user draft and wins CAS once', async () => {
    const { project, prepared, agent, chapter, partials } = await setup();
    const content = '恢复后的章节正文。';
    project.access(true, (database) => {
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO agent_partial_artifacts
         (id, project_id, task_id, generation_id, attempt_id, provider_step_id, source_ordinal,
          target_kind, chapter_id, document_id, content_text, content_hash, content_length, format,
          status, expires_at, created_at, updated_at)
         SELECT ?, tasks.project_id, ?, ?, ?, steps.id, 0, 'chapter', ?, ?, ?, sha256(?), length(CAST(? AS BLOB)),
                'validated-text', 'recoverable', ?, ?, ?
         FROM llm_provider_steps steps INNER JOIN agent_tasks tasks ON tasks.id = ?
         WHERE steps.generation_id = ? AND steps.attempt_id = ? LIMIT 1`,
        )
        .run(
          'partial-1',
          agent.taskId,
          prepared.stream.generationId,
          prepared.stream.attemptId,
          chapter.id,
          chapter.documentId,
          content,
          content,
          content,
          new Date(Date.now() + 86_400_000).toISOString(),
          now,
          now,
          agent.taskId,
          prepared.stream.generationId,
          prepared.stream.attemptId,
        );
    });
    const recovered = partials.recover({
      artifactId: 'partial-1',
      expectedRowVersion: 0,
      expectedDocumentRowVersion: 0,
    });
    expect(recovered.currentVersion?.contentMarkdown).toBe(content);
    const recoveredRow = project.access(
      false,
      (database) =>
        database
          .prepare(
            `SELECT status, content_text, content_hash, content_length, recovered_document_version_id
             FROM agent_partial_artifacts WHERE id = ?`,
          )
          .get('partial-1') as {
          status: string;
          content_text: string;
          content_hash: string;
          content_length: number;
          recovered_document_version_id: string | null;
        },
    );
    expect(recoveredRow).toMatchObject({
      status: 'recovered',
      content_text: '[removed]',
      content_length: Buffer.byteLength(content, 'utf8'),
    });
    expect(recoveredRow.content_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      partials.recover({
        artifactId: 'partial-1',
        expectedRowVersion: 0,
        expectedDocumentRowVersion: 1,
      }),
    ).toThrow('UNAVAILABLE');
  });

  it('records expiry as a task event without exposing partial content', async () => {
    const { project, prepared, agent, chapter, partials } = await setup();
    const now = new Date().toISOString();
    project.access(true, (database) => {
      database
        .prepare(
          `INSERT INTO agent_partial_artifacts
         (id, project_id, task_id, generation_id, attempt_id, provider_step_id, source_ordinal,
          target_kind, chapter_id, document_id, content_text, content_hash, content_length, format,
          status, expires_at, created_at, updated_at)
         SELECT ?, tasks.project_id, ?, ?, ?, steps.id, 0, 'chapter', ?, ?, ?, sha256(?), length(CAST(? AS BLOB)),
                'validated-text', 'recoverable', ?, ?, ?
         FROM llm_provider_steps steps INNER JOIN agent_tasks tasks ON tasks.id = ?
         WHERE steps.generation_id = ? AND steps.attempt_id = ? LIMIT 1`,
        )
        .run(
          'partial-audit',
          agent.taskId,
          prepared.stream.generationId,
          prepared.stream.attemptId,
          chapter.id,
          chapter.documentId,
          'audit-content',
          'audit-content',
          'audit-content',
          new Date(Date.now() - 1_000).toISOString(),
          now,
          now,
          agent.taskId,
          prepared.stream.generationId,
          prepared.stream.attemptId,
        );
    });
    expect(partials.expire()).toBe(1);
    const expiredEvents = project.access(
      false,
      (database) =>
        database
          .prepare(
            `SELECT event_type, summary, payload_json FROM agent_task_events WHERE task_id = ? ORDER BY sequence DESC LIMIT 1`,
          )
          .get(agent.taskId) as {
          event_type: string;
          summary: string;
          payload_json: string | null;
        },
    );
    expect(expiredEvents).toMatchObject({ event_type: 'agent.partial.expired' });
    expect(expiredEvents.summary).not.toContain('audit-content');

    const listed = partials.list({ includeTerminal: true });
    expect(listed.find((item) => item.id === 'partial-audit')?.status).toBe('expired');
    const expiredRow = project.access(
      false,
      (database) =>
        database
          .prepare(
            'SELECT content_text, content_hash, content_length FROM agent_partial_artifacts WHERE id = ?',
          )
          .get('partial-audit') as {
          content_text: string;
          content_hash: string;
          content_length: number;
        },
    );
    expect(expiredRow).toMatchObject({
      content_text: '[removed]',
      content_length: Buffer.byteLength('audit-content', 'utf8'),
    });
    expect(expiredRow.content_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      partials.recover({
        artifactId: 'partial-audit',
        expectedRowVersion: 0,
        expectedDocumentRowVersion: 0,
      }),
    ).toThrow('UNAVAILABLE');
    expect(
      project.access(
        false,
        (database) =>
          (
            database
              .prepare('SELECT COUNT(*) AS count FROM document_versions WHERE document_id = ?')
              .get(chapter.documentId) as { count: number }
          ).count,
      ),
    ).toBe(0);
  });

  it('scrubs discarded content while retaining its hash and byte-count audit facts', async () => {
    const { project, prepared, partials } = await setup();
    const content = '用户决定丢弃的未完成正文';
    const captured = partials.captureInterrupted(prepared.stream, content);
    expect(captured).toBeDefined();

    const discarded = partials.discard({
      artifactId: captured!.id,
      expectedRowVersion: captured!.rowVersion,
    });
    expect(discarded).toMatchObject({ status: 'discarded', rowVersion: 1 });
    const discardedRow = project.access(
      false,
      (database) =>
        database
          .prepare(
            'SELECT content_text, content_hash, content_length FROM agent_partial_artifacts WHERE id = ?',
          )
          .get(captured!.id) as {
          content_text: string;
          content_hash: string;
          content_length: number;
        },
    );
    expect(discardedRow).toMatchObject({
      content_text: '[removed]',
      content_length: Buffer.byteLength(content, 'utf8'),
    });
    expect(discardedRow.content_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(() =>
      partials.discard({ artifactId: captured!.id, expectedRowVersion: captured!.rowVersion }),
    ).toThrow('UNAVAILABLE');
  });
});
