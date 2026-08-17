import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProvider } from '@ai-video/llm';
import { AgentProviderLoopService } from './agent-provider-loop-service.js';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { GenerationService, type LlmSelectionResolver } from './generation-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'agent-provider-loop-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  project.create(join(directory, 'project'), 'Agent Tool Project');
  const content = new ContentService(project);
  const conversation = content.createConversation({ scopeType: 'project' });
  const provider: LlmProvider = {
    status: () => ({ key: 'unused', name: 'Unused', model: 'unused', configured: false }),
    stream: () => Promise.reject(new Error('native provider is used for this test')),
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
  const generations = new GenerationService(
    project,
    content,
    new ContextService(project),
    provider,
    { selectionResolver },
  );
  const workflow = new DocumentWorkflowService(project);
  const loop = new AgentProviderLoopService(project, workflow);
  return { conversation, generations, loop, project, workflow };
}

describe('AgentProviderLoopService', () => {
  it('persists authorization, executes a restricted draft tool, and prepares continuation', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a production brief.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a production brief.', 'Production brief');
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(generations.runtime(prepared.stream).tools?.[0]?.name).toBe('document.create_draft');
    loop.startProviderStep(prepared.stream);

    const executed = loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_tool',
      calls: [
        {
          id: 'call_1',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Production brief',
            contentMarkdown: '# Production brief\n\nApproved facts only.',
          }),
        },
      ],
      usage: { inputTokens: 8, outputTokens: 2, totalTokens: 10 },
    });
    generations.configureAgentTools(prepared.stream, [], executed.continuation);
    expect(generations.runtime(prepared.stream).continuation).toEqual(
      expect.objectContaining({ previousResponseId: 'resp_tool' }),
    );
    loop.startProviderStep(prepared.stream);

    loop.completeProviderStep({
      ...prepared.stream,
      providerResponseId: 'resp_final',
      finishReason: 'completed',
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
    });

    project.access(false, (database) => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM llm_provider_steps').get()).toEqual({
        count: 2,
      });
      expect(
        database
          .prepare(
            `SELECT status, tool_call_count, total_tokens,
                    continuation_manifest_json IS NOT NULL AS has_continuation
             FROM llm_provider_steps ORDER BY ordinal`,
          )
          .all(),
      ).toEqual([
        { status: 'complete', tool_call_count: 1, total_tokens: 10, has_continuation: 1 },
        { status: 'complete', tool_call_count: 0, total_tokens: 14, has_continuation: 0 },
      ]);
      expect(database.prepare('SELECT status FROM agent_tool_calls').get()).toEqual({
        status: 'succeeded',
      });
      expect(database.prepare('SELECT status, phase FROM agent_tasks').get()).toEqual({
        status: 'waiting_review',
        phase: 'waiting_review',
      });
      expect(
        database
          .prepare(
            `SELECT versions.content_markdown, versions.source_task_id
             FROM document_versions versions
             INNER JOIN agent_task_document_artifacts artifacts
               ON artifacts.document_version_id = versions.id`,
          )
          .get(),
      ).toMatchObject({
        content_markdown: '# Production brief\n\nApproved facts only.',
        source_task_id: agent.taskId,
      });
    });
  });

  it('rejects extra tool fields before consuming authorization or writing a document', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a draft.');

    expect(() =>
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'resp_tool',
        calls: [
          {
            id: 'call_1',
            name: 'document.create_draft',
            authorizationHandle: agent.tools[0]?.authorizationHandle,
            argumentsJson: JSON.stringify({
              title: 'Draft',
              contentMarkdown: '# Draft',
              projectId: 'forged-project',
            }),
          },
        ],
      }),
    ).toThrow('unsupported fields');

    expect(() =>
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'resp_tool',
        calls: [
          {
            id: 'call_2',
            name: 'document.create_draft',
            authorizationHandle: 'forged-handle',
            argumentsJson: JSON.stringify({ title: 'Draft', contentMarkdown: '# Draft' }),
          },
        ],
      }),
    ).toThrow('not authorized');

    project.access(false, (database) => {
      expect(
        database.prepare('SELECT used_call_count FROM agent_tool_authorizations').get(),
      ).toEqual({
        used_call_count: 0,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({
        count: 0,
      });
      expect(database.prepare('SELECT COUNT(*) AS count FROM agent_tool_calls').get()).toEqual({
        count: 0,
      });
    });
  });

  it('reads only the Worker-authorized document without persisting its body as evidence', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const document = workflow.saveDraft({
      title: 'Authorized',
      contentMarkdown: '# Internal body',
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Read the selected document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Read the selected document.', undefined, {
      operation: 'document.read',
      documentId: document.id,
    });

    const result = loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_read',
      calls: [
        {
          id: 'call_read',
          name: 'document.read',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('# Internal body');
    project.access(false, (database) => {
      const row = database
        .prepare(
          'SELECT result_summary_json, continuation_manifest_json FROM agent_tool_calls, llm_provider_steps WHERE agent_tool_calls.provider_step_id = llm_provider_steps.id',
        )
        .get() as { result_summary_json: string; continuation_manifest_json: string };
      expect(row.result_summary_json).not.toContain('Internal body');
      expect(row.continuation_manifest_json).not.toContain('Internal body');
    });
  });

  it('updates only the frozen document target and base version', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const target = workflow.saveDraft({ title: 'Target', contentMarkdown: '# Before' });
    const other = workflow.saveDraft({ title: 'Other', contentMarkdown: '# Other' });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Update the selected document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Update the selected document.', undefined, {
      operation: 'document.update_draft',
      documentId: target.id,
    });
    const result = loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_update',
      calls: [
        {
          id: 'call_update',
          name: 'document.update_draft',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: JSON.stringify({ title: 'Target revised', contentMarkdown: '# After' }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('draft_updated');
    expect(workflow.getDocument(target.id).currentVersion?.contentMarkdown).toBe('# After');
    expect(workflow.getDocument(other.id).currentVersion?.contentMarkdown).toBe('# Other');
    project.access(false, (database) => {
      expect(
        database.prepare('SELECT target_document_id FROM agent_tool_authorizations').get(),
      ).toEqual({
        target_document_id: target.id,
      });
    });
  });

  it('requires one-time confirmation before archiving a document', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const document = workflow.saveDraft({ title: 'Archive me', contentMarkdown: '# Draft' });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Archive the selected document.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Archive the selected document.', undefined, {
      operation: 'document.archive',
      documentId: document.id,
    });
    const pending = loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_archive',
      calls: [
        {
          id: 'call_archive',
          name: 'document.archive',
          authorizationHandle: agent.tools[0]?.authorizationHandle,
          argumentsJson: '{}',
        },
      ],
    });
    expect(pending.confirmation?.documentId).toBe(document.id);
    expect(workflow.getDocument(document.id).lifecycleStatus).toBe('active');
    const confirmed = loop.confirmTool({
      ...prepared.stream,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(confirmed.continuation?.outputs[0]?.output).toContain('archived');
    expect(workflow.getDocument(document.id).lifecycleStatus).toBe('archived');
    expect(() =>
      loop.confirmTool({
        ...prepared.stream,
        confirmationToken: pending.confirmation!.confirmationToken,
        approved: true,
      }),
    ).toThrow('invalid, expired, or already consumed');
    project.access(false, (database) => {
      expect(database.prepare('SELECT status FROM agent_tool_calls').get()).toEqual({
        status: 'succeeded',
      });
    });
  });

  it('rejects expired and revoked step-local handles before any side effect', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const first = loop.prepare(prepared.stream, 'Create a draft.');
    project.access(true, (database) => {
      database
        .prepare("UPDATE agent_tool_authorizations SET expires_at = '2000-01-01T00:00:00.000Z'")
        .run();
    });
    expect(() =>
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'expired',
        calls: [
          {
            id: 'expired_call',
            name: 'document.create_draft',
            authorizationHandle: first.tools[0]?.authorizationHandle,
            argumentsJson: JSON.stringify({ title: 'Nope', contentMarkdown: '# Nope' }),
          },
        ],
      }),
    ).toThrow('not authorized');

    const second = loop.prepare(prepared.stream, 'Create a draft.');
    expect(() =>
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'revoked',
        calls: [
          {
            id: 'revoked_call',
            name: 'document.create_draft',
            authorizationHandle: first.tools[0]?.authorizationHandle,
            argumentsJson: JSON.stringify({ title: 'Nope', contentMarkdown: '# Nope' }),
          },
        ],
      }),
    ).toThrow('not authorized');
    expect(second.tools[0]?.authorizationHandle).not.toBe(first.tools[0]?.authorizationHandle);
    project.access(false, (database) => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({
        count: 0,
      });
    });
  });

  it('blocks a late tool callback after cancellation and revokes its execution envelope', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a draft.');
    await generations.cancel(prepared.stream.generationId);

    expect(() =>
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'late-response',
        calls: [
          {
            id: 'late-call',
            name: 'document.create_draft',
            authorizationHandle: agent.tools[0]?.authorizationHandle,
            argumentsJson: JSON.stringify({ title: 'Late', contentMarkdown: '# Late' }),
          },
        ],
      }),
    ).toThrow('no longer active');

    expect(loop.terminateGeneration(prepared.stream.generationId, 'cancelled')).toBe(1);
    project.access(false, (database) => {
      expect(database.prepare('SELECT COUNT(*) AS count FROM documents').get()).toEqual({
        count: 0,
      });
      expect(database.prepare('SELECT status FROM agent_tasks').get()).toEqual({
        status: 'cancelled',
      });
      expect(database.prepare('SELECT status FROM agent_tool_authorizations').get()).toEqual({
        status: 'revoked',
      });
      expect(database.prepare('SELECT status FROM llm_provider_steps').get()).toEqual({
        status: 'interrupted',
      });
    });
  });

  it('cleans up interrupted Agent runtime records after Worker recovery', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    loop.prepare(prepared.stream, 'Create a draft.');
    expect(generations.recoverInterrupted()).toBe(1);
    expect(loop.recoverInterrupted()).toBe(1);
    project.access(false, (database) => {
      expect(database.prepare('SELECT status, error_code FROM agent_tasks').get()).toEqual({
        status: 'failed',
        error_code: 'failed',
      });
      expect(database.prepare('SELECT status FROM agent_tool_authorizations').get()).toEqual({
        status: 'revoked',
      });
    });
  });
});
