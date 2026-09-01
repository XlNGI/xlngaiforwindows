import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmProvider } from '@ai-video/llm';
import { AgentProviderLoopService } from './agent-provider-loop-service.js';
import { ChangeSetService } from './change-set-service.js';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { GenerationService, type LlmSelectionResolver } from './generation-service.js';
import { ProjectService } from './project-service.js';
import { ResearchService } from './research-service.js';
import { NovelContextService } from './novel-context-service.js';
import { NovelService } from './novel-service.js';
import { getAdapter } from '@ai-video/generation-adapters';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup(
  protocol: 'openai-responses' | 'openai-chat-completions' = 'openai-responses',
  research?: ResearchService,
) {
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
      protocol,
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
  const loop = new AgentProviderLoopService(project, workflow, research);
  return { conversation, generations, loop, project, workflow };
}

describe('AgentProviderLoopService', () => {
  it('queries an adapter schema through a separately authorized read-only tool step', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const descriptor = getAdapter('TEXT_TO_IMAGE:vidu:viduq2:v2');
    if (!descriptor) throw new Error('Expected the Vidu Q2 adapter fixture.');
    const loop = new AgentProviderLoopService(project, workflow, undefined, undefined, {
      get: (adapterKey) => (adapterKey === descriptor.key ? descriptor : null),
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '查看图片模型支持哪些参数',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '查看图片模型支持哪些参数',
      '查询 Schema',
      { operation: 'adapter.schema.get' },
      'network_disabled',
    );
    expect(agent.tools.map((tool) => tool.name)).toEqual(['adapter.schema.get']);
    loop.startProviderStep(prepared.stream);
    const tool = agent.tools[0]!;
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_schema',
      calls: [
        {
          id: 'call_schema',
          name: 'adapter.schema.get',
          authorizationHandle: tool.authorizationHandle,
          argumentsJson: JSON.stringify({ adapterKey: descriptor.key }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(descriptor.key);
    const returned = JSON.parse(result.continuation!.outputs[0]!.output) as {
      descriptor?: Record<string, unknown>;
    };
    expect(returned.descriptor).not.toHaveProperty('endpoint');
    expect(returned.descriptor).not.toHaveProperty('credentialProvider');
    const persisted = project.access(
      false,
      (database) =>
        database
          .prepare(
            `SELECT tool_name, status, arguments_summary_json FROM agent_tool_calls
           WHERE task_id = ? ORDER BY created_at`,
          )
          .all(agent.taskId) as Array<{
          tool_name: string;
          status: string;
          arguments_summary_json: string;
        }>,
    );
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({ tool_name: 'adapter.schema.get', status: 'succeeded' });
    expect(persisted[0]?.arguments_summary_json).toContain(descriptor.key);
    expect(
      project.access(false, (database) =>
        database
          .prepare('SELECT status, outcome, task_type FROM agent_tasks WHERE id = ?')
          .get(agent.taskId),
      ),
    ).toEqual({ status: 'completed', outcome: 'read-only', task_type: 'schema-query' });
  });

  it('records a schema proposal and leaves the task waiting for explicit confirmation', async () => {
    const { conversation, generations, project, workflow } = await setup();
    const descriptor = getAdapter('TEXT_TO_IMAGE:vidu:viduq2:v2');
    if (!descriptor) throw new Error('Expected the Vidu Q2 adapter fixture.');
    let proposed = false;
    const loop = new AgentProviderLoopService(
      project,
      workflow,
      undefined,
      undefined,
      {
        get: () => descriptor,
      },
      {
        propose: ({ adapterKey, descriptor: next, reason, conversationId }) => {
          proposed =
            adapterKey === descriptor.key &&
            next.key === descriptor.key &&
            conversationId === conversation.id;
          return {
            status: 'proposed',
            adapterKey,
            version: 2,
            requiresConfirmation: true,
            diff: [reason ?? 'parameter changed'],
          };
        },
        listAudits: (adapterKey) => [
          {
            id: 'audit-1',
            adapterKey,
            version: 1,
            action: 'confirmed',
            actorType: 'user',
            reason: 'initial',
            createdAt: '2026-09-02T00:00:00.000Z',
          },
        ],
      },
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '修改图片模型参数 Schema',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '修改图片模型参数 Schema',
      '提议 Schema 修改',
      { operation: 'adapter.schema.propose' },
      'network_disabled',
    );
    expect(agent.tools.map((tool) => tool.name)).toEqual(['adapter.schema.propose']);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_schema_propose',
      calls: [
        {
          id: 'call_schema_propose',
          name: 'adapter.schema.propose',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            adapterKey: descriptor.key,
            descriptor,
            reason: '补充默认值',
          }),
        },
      ],
    });
    expect(proposed).toBe(true);
    expect(result.continuation?.outputs[0]?.output).toContain('requiresUserConfirmation');
    expect(
      project.access(false, (database) =>
        database.prepare('SELECT status, phase FROM agent_tasks WHERE id = ?').get(agent.taskId),
      ),
    ).toEqual({ status: 'running', phase: 'waiting_confirmation' });
    expect(workflow.getTask({ taskId: agent.taskId }).pendingSchemaConfirmation).toMatchObject({
      action: 'adapter.schema.propose',
      adapterKey: descriptor.key,
      version: 2,
      status: 'pending',
    });
  });

  it('freezes the trusted target platform with a short-drama task snapshot', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成 AI 漫剧提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成 AI 漫剧提示词',
      'Seedance 漫剧',
      { operation: 'novel.episode.submit_draft' },
      'project_only',
      undefined,
      ['chapter-1'],
      'seedance',
    );
    const snapshot = project.access(false, (database) => {
      const row = database
        .prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id = ?')
        .get(agent.taskId) as { request_snapshot_json: string };
      return JSON.parse(row.request_snapshot_json) as Record<string, unknown>;
    });
    expect(snapshot).toMatchObject({
      agentMode: 'short-drama',
      selectedChapterIds: ['chapter-1'],
      targetPlatform: 'seedance',
    });
  });

  it('authorizes the novel chapter draft tool only for an exact chapter document target', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const novel = new NovelService(project);
    const chapter = novel.saveChapter({ title: '雾港来客' });
    const seeded = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: '旧稿。',
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '续写当前章节',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '续写当前章节',
      '续写',
      { operation: 'novel.chapter.submit_draft', documentId: chapter.documentId },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual(['novel.chapter.submit_draft']);
    loop.startProviderStep(prepared.stream);
    const tool = agent.tools[0]!;
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_novel',
      calls: [
        {
          id: 'call_novel',
          name: 'novel.chapter.submit_draft',
          authorizationHandle: tool.authorizationHandle,
          argumentsJson: JSON.stringify({ title: '雾港来客', contentMarkdown: '新稿。' }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('novel_draft_submitted');
    expect(workflow.getDocument(chapter.documentId).currentVersion?.contentMarkdown).toBe('新稿。');
    expect(seeded.currentVersion?.contentMarkdown).toBe('旧稿。');
  });

  it('creates an adaptation proposal from a published chapter without creating drama structure', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const novel = new NovelService(project);
    const chapter = novel.saveChapter({ title: 'Published chapter' });
    const draft = workflow.saveDraft({
      documentId: chapter.documentId,
      title: chapter.title,
      contentMarkdown: 'Published source content',
      expectedDocumentRowVersion: chapter.documentRowVersion,
    });
    workflow.submitReview({
      documentId: chapter.documentId,
      documentVersionId: draft.currentVersion!.id,
      expectedDocumentRowVersion: draft.rowVersion,
    });
    workflow.publish({
      documentId: chapter.documentId,
      documentVersionId: draft.currentVersion!.id,
      expectedDocumentRowVersion: draft.rowVersion + 1,
    });
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create an adaptation proposal',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      'Create an adaptation proposal',
      'Adaptation proposal',
      { operation: 'novel.adaptation.submit_proposal', documentId: chapter.documentId },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual(['novel.adaptation.submit_proposal']);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_adaptation',
      calls: [
        {
          id: 'call_adaptation',
          name: 'novel.adaptation.submit_proposal',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Adaptation proposal',
            contentMarkdown: 'Scene candidates and character beats.',
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('adaptation_proposal_submitted');
    const stored = project.access(false, (database) => ({
      proposal: database.prepare('SELECT * FROM novel_adaptation_proposals').get() as Record<
        string,
        unknown
      >,
      binding: database
        .prepare(
          "SELECT role, domain_scope FROM document_bindings WHERE role = 'adaptation-proposal'",
        )
        .get() as Record<string, unknown>,
      scenes: database.prepare('SELECT COUNT(*) AS count FROM scenes').get() as { count: number },
      shots: database.prepare('SELECT COUNT(*) AS count FROM shots').get() as { count: number },
    }));
    expect(stored.proposal.source_chapter_id).toBe(chapter.id);
    expect(typeof stored.proposal.adaptation_task_id).toBe('string');
    expect(stored.binding).toEqual({ role: 'adaptation-proposal', domain_scope: 'short-drama' });
    expect(stored.scenes.count).toBe(0);
    expect(stored.shots.count).toBe(0);
  });

  it('searches and fetches external evidence before creating one document draft', async () => {
    const research = new ResearchService({
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      fetch: (input) =>
        Promise.resolve(
          requestUrl(input).startsWith('https://search.test/')
            ? new Response(
                JSON.stringify({
                  Heading: 'Verified biography',
                  AbstractURL: 'https://source.test/biography',
                  AbstractText: 'A public biographical source.',
                }),
                { headers: { 'content-type': 'application/json' } },
              )
            : new Response('<main><h1>Biography</h1><p>Verified external facts.</p></main>', {
                headers: { 'content-type': 'text/html' },
              }),
        ),
    });
    const { conversation, generations, loop, project, workflow } = await setup(
      'openai-responses',
      research,
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a sourced biography.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a sourced biography.');
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'research.search',
      'research.fetch',
    ]);
    expect(generations.runtime(prepared.stream).systemInstruction).toContain(
      '# Agent external research policy',
    );
    loop.startProviderStep(prepared.stream);

    const searchTool = agent.tools.find((tool) => tool.name === 'research.search')!;
    const searched = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_search',
      calls: [
        {
          id: 'call_search',
          name: 'research.search',
          authorizationHandle: searchTool.authorizationHandle,
          argumentsJson: JSON.stringify({ query: 'verified biography', limit: 3 }),
        },
      ],
    });
    const searchOutput = JSON.parse(searched.continuation!.outputs[0]!.output) as {
      sources: Array<{ sourceHandle: string }>;
    };
    expect(searchOutput.sources).toHaveLength(1);
    generations.configureAgentTools(prepared.stream, searched.tools ?? [], searched.continuation);
    loop.startProviderStep(prepared.stream);

    const fetchTool = searched.tools?.find((tool) => tool.name === 'research.fetch');
    const fetched = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_fetch',
      calls: [
        {
          id: 'call_fetch',
          name: 'research.fetch',
          authorizationHandle: fetchTool?.authorizationHandle,
          argumentsJson: JSON.stringify({
            sourceHandle: searchOutput.sources[0]!.sourceHandle,
          }),
        },
      ],
    });
    expect(fetched.continuation?.outputs[0]?.output).toContain('Verified external facts.');
    expect(fetched.continuation?.outputs[0]?.output).toContain('untrusted evidence');
    expect(fetched.continuation?.outputs[0]?.output).toContain('R2');
    generations.configureAgentTools(prepared.stream, fetched.tools ?? [], fetched.continuation);
    loop.startProviderStep(prepared.stream);

    const createTool = fetched.tools?.find((tool) => tool.name === 'document.create_draft');
    await expect(
      loop.executeTools({
        ...prepared.stream,
        providerResponseId: 'resp_draft_invalid',
        calls: [
          {
            id: 'call_draft_invalid',
            name: 'document.create_draft',
            authorizationHandle: createTool?.authorizationHandle,
            argumentsJson: JSON.stringify({
              title: 'Invalid sourced biography',
              contentMarkdown: '# Invalid\n\nUnknown source [R99]',
            }),
          },
        ],
      }),
    ).rejects.toThrow('RESEARCH_CITATION_INVALID');
    const drafted = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_draft',
      calls: [
        {
          id: 'call_draft',
          name: 'document.create_draft',
          authorizationHandle: createTool?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Sourced biography',
            contentMarkdown:
              '# Sourced biography\n\nVerified external facts. [R2]\n\nSources: https://source.test/biography',
          }),
        },
      ],
    });
    expect(drafted.continuation?.outputs[0]?.output).toContain('draft_created');
    loop.startProviderStep(prepared.stream);
    loop.completeProviderStep({
      ...prepared.stream,
      providerResponseId: 'resp_final',
      finishReason: 'completed',
    });

    expect(workflow.listDocuments()).toHaveLength(1);
    project.access(false, (database) => {
      expect(
        database
          .prepare('SELECT status, COUNT(*) AS count FROM agent_research_sources GROUP BY status')
          .all(),
      ).toEqual([
        { status: 'fetched', count: 1 },
        { status: 'searched', count: 1 },
      ]);
      expect(
        database
          .prepare(
            `SELECT adoption_status, adoption_reason, citation_label
             FROM agent_research_sources WHERE status = 'fetched'`,
          )
          .get(),
      ).toMatchObject({ adoption_status: 'adopted', citation_label: 'R2' });
      expect(
        database
          .prepare(
            `SELECT citation_label FROM document_version_research_sources
             WHERE document_version_id = (SELECT current_version_id FROM documents LIMIT 1)`,
          )
          .get(),
      ).toEqual({ citation_label: 'R2' });
      const cache = database
        .prepare('SELECT byte_count, status FROM agent_research_cache')
        .get() as { byte_count: number; status: string };
      expect(cache.status).toBe('present');
      expect(cache.byte_count).toBeGreaterThan(0);
      const summaries = database
        .prepare(
          `SELECT arguments_summary_json, result_summary_json FROM agent_tool_calls
           WHERE tool_name LIKE 'research.%' ORDER BY tool_ordinal`,
        )
        .all() as Array<{ arguments_summary_json: string; result_summary_json: string }>;
      expect(JSON.stringify(summaries)).not.toContain('verified biography');
      expect(JSON.stringify(summaries)).not.toContain('Verified external facts.');
    });
  });

  it('executes parallel read-only searches under one step authorization', async () => {
    const research = new ResearchService({
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      fetch: (input) => {
        const query = new URL(requestUrl(input)).searchParams.get('q') ?? 'source';
        return Promise.resolve(
          new Response(
            JSON.stringify({
              Heading: query,
              AbstractURL: `https://source.test/${encodeURIComponent(query)}`,
              AbstractText: `Result for ${query}`,
            }),
            { headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    const { conversation, generations, loop, project } = await setup(
      'openai-chat-completions',
      research,
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Compare two factual sources.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Compare two factual sources.');
    const searchTool = agent.tools.find((tool) => tool.name === 'research.search')!;
    loop.startProviderStep(prepared.stream);

    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'chatcmpl_parallel_search',
      calls: ['alpha', 'beta'].map((query, index) => ({
        id: `call_search_${index}`,
        name: 'research.search',
        authorizationHandle: searchTool.authorizationHandle,
        argumentsJson: JSON.stringify({ query }),
      })),
    });

    expect(result.continuation?.outputs).toHaveLength(2);
    expect(result.tools?.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'research.search',
      'research.fetch',
    ]);
    project.access(false, (database) => {
      expect(
        database
          .prepare(
            `SELECT used_call_count FROM agent_tool_authorizations
             WHERE provider_step_id = (SELECT id FROM llm_provider_steps WHERE ordinal = 0)
               AND allowed_operation = 'research.search'`,
          )
          .get(),
      ).toEqual({ used_call_count: 2 });
      expect(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_tool_calls WHERE tool_name = 'research.search'",
          )
          .get(),
      ).toEqual({ count: 2 });
    });
  });

  it('preserves the document call after research budget exhaustion', async () => {
    const research = new ResearchService({
      searchEndpoint: 'https://search.test/',
      lookup: () => Promise.resolve([{ address: '93.184.216.34', family: 4 }]),
      fetch: (input) => {
        const url = new URL(requestUrl(input));
        if (url.hostname === 'search.test') {
          const query = url.searchParams.get('q') ?? 'source';
          return Promise.resolve(
            new Response(
              JSON.stringify({
                Results: Array.from({ length: 3 }, (_, index) => ({
                  FirstURL: `https://source.test/${encodeURIComponent(query)}/${index}`,
                  Text: `${query} source ${index}`,
                })),
              }),
              { headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(
          new Response(`<main><p>Fetched evidence from ${url.pathname}.</p></main>`, {
            headers: { 'content-type': 'text/html' },
          }),
        );
      },
    });
    const { conversation, generations, loop, project, workflow } = await setup(
      'openai-chat-completions',
      research,
    );
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Research several sources and create one cited draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Research several sources and create one draft.');
    expect(
      project.access(false, (database) =>
        database
          .prepare('SELECT tool_call_limit, tool_call_count FROM agent_tasks WHERE id = ?')
          .get(agent.taskId),
      ),
    ).toEqual({ tool_call_limit: 16, tool_call_count: 0 });

    loop.startProviderStep(prepared.stream);
    const searchTool = agent.tools.find((tool) => tool.name === 'research.search')!;
    const searched = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_search_budget',
      calls: ['alpha evidence', 'beta evidence', 'gamma evidence'].map((query, index) => ({
        id: `call_search_budget_${index}`,
        name: 'research.search',
        authorizationHandle: searchTool.authorizationHandle,
        argumentsJson: JSON.stringify({ query, limit: 3 }),
      })),
    });
    const sourceHandles = searched.continuation!.outputs.flatMap((output) => {
      const parsed = JSON.parse(output.output) as {
        sources: Array<{ sourceHandle: string }>;
      };
      return parsed.sources.map((source) => source.sourceHandle);
    });
    expect(sourceHandles).toHaveLength(9);
    expect(searched.tools?.map((tool) => tool.name)).toEqual([
      'document.create_draft',
      'research.fetch',
    ]);

    loop.startProviderStep(prepared.stream);
    const firstFetchTool = searched.tools?.find((tool) => tool.name === 'research.fetch');
    const firstFetch = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_fetch_budget_1',
      calls: sourceHandles.slice(0, 2).map((sourceHandle, index) => ({
        id: `call_fetch_budget_first_${index}`,
        name: 'research.fetch',
        authorizationHandle: firstFetchTool?.authorizationHandle,
        argumentsJson: JSON.stringify({ sourceHandle }),
      })),
    });
    expect(firstFetch.continuation?.outputs).toHaveLength(2);
    expect(firstFetch.continuation?.outputs[0]?.output).toContain('Prefer creating');

    loop.startProviderStep(prepared.stream);
    const finalFetchTool = firstFetch.tools?.find((tool) => tool.name === 'research.fetch');
    const exhausted = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_fetch_budget_2',
      calls: Array.from({ length: 8 }, (_, index) => ({
        id: `call_fetch_budget_final_${index}`,
        name: 'research.fetch',
        authorizationHandle: finalFetchTool?.authorizationHandle,
        argumentsJson: JSON.stringify({
          sourceHandle: sourceHandles[(index + 2) % sourceHandles.length],
        }),
      })),
    });
    const finalFetchOutputs = exhausted.continuation!.outputs.map((output) => {
      return JSON.parse(output.output) as { status: string; errorCode?: string };
    });
    expect(finalFetchOutputs.filter((output) => output.status === 'fetched')).toHaveLength(6);
    expect(
      finalFetchOutputs.filter(
        (output) => output.status === 'failed' && output.errorCode === 'RESEARCH_BUDGET_EXCEEDED',
      ),
    ).toHaveLength(2);
    expect(exhausted.tools?.map((tool) => tool.name)).toEqual(['document.create_draft']);

    loop.startProviderStep(prepared.stream);
    const createTool = exhausted.tools?.[0];
    const drafted = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_draft_after_budget',
      calls: [
        {
          id: 'call_draft_after_budget',
          name: 'document.create_draft',
          authorizationHandle: createTool?.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: 'Research budget draft',
            contentMarkdown:
              '# Research budget draft\n\nFetched evidence.\n\nSource: https://source.test/alpha%20evidence/0',
          }),
        },
      ],
    });
    expect(drafted.continuation?.outputs[0]?.output).toContain('draft_created');
    loop.startProviderStep(prepared.stream);
    loop.completeProviderStep({
      ...prepared.stream,
      providerResponseId: 'resp_final_after_budget',
      finishReason: 'completed',
    });

    const documents = workflow.listDocuments();
    expect(documents).toHaveLength(1);
    expect(workflow.getDocument(documents[0]!.id).currentVersion?.contentMarkdown).toContain(
      'https://source.test/',
    );
    project.access(false, (database) => {
      expect(
        database
          .prepare('SELECT status, phase, tool_call_limit, tool_call_count FROM agent_tasks')
          .get(),
      ).toEqual({
        status: 'waiting_review',
        phase: 'waiting_review',
        tool_call_limit: 16,
        tool_call_count: 12,
      });
      expect(
        database
          .prepare(
            `SELECT tool_name, error_code FROM agent_tool_calls
             ORDER BY provider_step_id, tool_ordinal`,
          )
          .all()
          .filter((row) => (row as { error_code: string | null }).error_code),
      ).toEqual([
        { tool_name: 'research.fetch', error_code: 'RESEARCH_BUDGET_EXCEEDED' },
        { tool_name: 'research.fetch', error_code: 'RESEARCH_BUDGET_EXCEEDED' },
      ]);
    });
  });

  it('does not authorize research tools in project-only mode', async () => {
    const { conversation, generations, loop } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Use project evidence only.',
      providerProfileId: 'profile',
      modelId: 'model',
    });

    const agent = loop.prepare(
      prepared.stream,
      'Use project evidence only.',
      undefined,
      { operation: 'document.create_draft' },
      'project_only',
    );

    expect(agent.tools.map((tool) => tool.name)).toEqual(['document.create_draft']);
  });

  it('persists authorization, executes a restricted draft tool, and prepares continuation', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
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

    const executed = await loop.executeTools({
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
      expect.objectContaining({
        protocol: 'openai-responses',
        previousResponseId: 'resp_tool',
      }),
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
    expect(workflow.getTask({ taskId: agent.taskId }).providerSteps).toEqual([
      expect.objectContaining({
        ordinal: 0,
        protocol: 'openai-responses',
        status: 'complete',
        toolCallCount: 1,
        finishReason: 'tool_calls',
        totalTokens: 10,
      }),
      expect.objectContaining({
        ordinal: 1,
        protocol: 'openai-responses',
        status: 'complete',
        toolCallCount: 0,
        finishReason: 'completed',
        totalTokens: 14,
      }),
    ]);
  });

  it('prepares a Chat Completions tool-message continuation without the authorization handle', async () => {
    const { conversation, generations, loop } = await setup('openai-chat-completions');
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a production brief.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(prepared.stream, 'Create a production brief.', 'Production brief');
    const call = {
      id: 'call_chat_1',
      name: 'document.create_draft',
      authorizationHandle: agent.tools[0]?.authorizationHandle,
      argumentsJson: JSON.stringify({
        title: 'Production brief',
        contentMarkdown: '# Production brief',
      }),
    };
    const executed = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'chatcmpl_tool',
      calls: [call],
    });

    expect(executed.continuation).toEqual({
      protocol: 'openai-chat-completions',
      providerResponseId: 'chatcmpl_tool',
      calls: [
        {
          id: call.id,
          name: call.name,
          argumentsJson: call.argumentsJson,
        },
      ],
      outputs: [
        expect.objectContaining({
          callId: call.id,
        }),
      ],
    });
    expect(JSON.stringify(executed.continuation)).not.toContain(
      agent.tools[0]?.authorizationHandle,
    );
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

    const corrected = await loop.executeTools({
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
    });
    expect(corrected.continuation?.outputs[0]?.output).toContain('unsupported fields');

    await expect(
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
    ).rejects.toThrow('not authorized');

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

    const result = await loop.executeTools({
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
    const result = await loop.executeTools({
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
    const pending = await loop.executeTools({
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
    expect(workflow.getTask({ taskId: agent.taskId }).pendingConfirmation).toMatchObject({
      action: 'document.archive',
      documentId: document.id,
      documentTitle: 'Archive me',
      status: 'pending',
    });
    expect(workflow.getDocument(document.id).lifecycleStatus).toBe('active');
    const confirmed = loop.confirmTool({
      ...prepared.stream,
      confirmationToken: pending.confirmation!.confirmationToken,
      approved: true,
    });
    expect(confirmed.continuation?.outputs[0]?.output).toContain('archived');
    expect(confirmed.tools?.map((tool) => tool.name)).toEqual(['document.archive']);
    expect(workflow.getDocument(document.id).lifecycleStatus).toBe('archived');
    expect(workflow.getTask({ taskId: agent.taskId }).pendingConfirmation).toBeUndefined();
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
    await expect(
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
    ).rejects.toThrow('not authorized');

    const second = loop.prepare(prepared.stream, 'Create a draft.');
    await expect(
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
    ).rejects.toThrow('not authorized');
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

    await expect(
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
    ).rejects.toThrow('no longer active');

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

  it('creates an episode overview draft with a short-drama screenplay binding', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '把前三章做成一集，生成本集整体把控',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '把前三章做成一集，生成本集整体把控',
      '第1集整体把控',
      { operation: 'novel.episode.submit_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual(['novel.episode.submit_draft']);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_episode_draft',
      calls: [
        {
          id: 'call_episode_draft',
          name: 'novel.episode.submit_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: '第1集 · 第一卷 第1–3章 整体把控',
            contentMarkdown: '# 第1集整体把控\n\n- 集范围：第一卷 第1–3章',
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('episode_draft_submitted');
    const parsed = JSON.parse(result.continuation!.outputs[0]!.output) as { documentId: string };
    const document = workflow.getDocument(parsed.documentId);
    expect(document.kind).toBe('plan');
    expect(document.title).toContain('第1集');
    const novel = new NovelService(project);
    expect(novel.listBindings()).toMatchObject([
      { documentId: parsed.documentId, role: 'screenplay', domainScope: 'short-drama' },
    ]);
  });

  it('turns an episode structure into a reviewable change set with shot prompts', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const character = workflow.saveDraft({
      kind: 'character',
      title: '角色提示词',
      contentMarkdown: '# 林澈\n24 岁，灯塔守望员。',
    });
    workflow.submitReview({
      documentId: character.id,
      documentVersionId: character.currentVersion!.id,
      expectedDocumentRowVersion: character.rowVersion,
    });
    workflow.publish({
      documentId: character.id,
      documentVersionId: character.currentVersion!.id,
      expectedDocumentRowVersion: character.rowVersion + 1,
    });
    const sceneDoc = workflow.saveDraft({
      kind: 'scene',
      title: '场景提示词',
      contentMarkdown: '# 旧码头\n海雾低垂的旧码头。',
    });
    workflow.submitReview({
      documentId: sceneDoc.id,
      documentVersionId: sceneDoc.currentVersion!.id,
      expectedDocumentRowVersion: sceneDoc.rowVersion,
    });
    workflow.publish({
      documentId: sceneDoc.id,
      documentVersionId: sceneDoc.currentVersion!.id,
      expectedDocumentRowVersion: sceneDoc.rowVersion + 1,
    });

    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成本集的场次和镜头提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成本集的场次和镜头提示词',
      '第1集场次与镜头',
      { operation: 'novel.episode.submit_structure' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    expect(agent.tools.map((tool) => tool.name)).toEqual(['novel.episode.submit_structure']);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_structure',
      calls: [
        {
          id: 'call_structure',
          name: 'novel.episode.submit_structure',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            episodeTitle: '第1集 · 来信',
            scenes: [
              {
                title: '旧码头 · 台风前夜',
                shots: [
                  {
                    title: '海雾中的码头',
                    prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。',
                  },
                ],
              },
            ],
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'episode_structure_change_set_created',
    );
    const changeSets = new ChangeSetService(project);
    const proposed = changeSets.list({ includeTerminal: false });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.items).toMatchObject([
      { entityType: 'scene', title: '旧码头 · 台风前夜' },
      {
        entityType: 'shot',
        title: '海雾中的码头',
        prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。',
      },
    ]);
    const applied = changeSets.apply({
      changeSetId: proposed[0]!.id,
      expectedRowVersion: proposed[0]!.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const content = new ContentService(project);
    const scene = content.listScenes()[0]!;
    expect(content.listShots(scene.id)).toMatchObject([
      { title: '海雾中的码头', prompt: '[场景:旧码头] 全景，[角色:林澈] 站在码头上。' },
    ]);
  });

  it('feeds an unpublished character reference back to the model for correction', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成场次镜头',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成场次镜头',
      '第1集',
      { operation: 'novel.episode.submit_structure' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_structure_bad',
      calls: [
        {
          id: 'call_structure_bad',
          name: 'novel.episode.submit_structure',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            episodeTitle: '第1集',
            scenes: [
              {
                title: '场次 01',
                shots: [{ title: '镜头 01', prompt: '[角色:不存在的人物] 出现在画面中。' }],
              },
            ],
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'references unknown character "不存在的人物"',
    );
    expect(new ChangeSetService(project).list({ includeTerminal: false })).toHaveLength(0);
  });

  it('feeds malformed tool arguments back to the model for correction', async () => {
    const { conversation, generations, loop } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      'Create a draft.',
      'Draft',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_bad_json',
      calls: [
        {
          id: 'call_bad_json',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: '{"title": "Draft", "contentMarkdown": "未闭合',
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'Tool arguments are not valid JSON for document.create_draft',
    );
    expect(result.continuation?.outputs[0]?.output).toContain('请修正后重新提交');
  });

  it('keeps malformed arguments out of the chat-completions continuation for self-correction', async () => {
    const { conversation, generations, loop } = await setup('openai-chat-completions');
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: 'Create a draft.',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      'Create a draft.',
      'Draft',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_bad_json_chat',
      calls: [
        {
          id: 'call_bad_json_chat',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: '{"title": "Draft", "contentMarkdown": "未闭合',
        },
      ],
    });
    expect(result.continuation?.protocol).toBe('openai-chat-completions');
    const continuation = result.continuation as Extract<
      typeof result.continuation,
      { protocol: 'openai-chat-completions' }
    >;
    expect(continuation.calls[0]).toMatchObject({
      id: 'call_bad_json_chat',
      name: 'document.create_draft',
      argumentsJson: '{}',
    });
    expect(continuation.outputs[0]?.output).toContain('Tool arguments are not valid JSON');
  });

  it('feeds malformed episode structure arguments back without creating a change set', async () => {
    const { conversation, generations, loop, project } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成场次镜头',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成场次镜头',
      '第1集',
      { operation: 'novel.episode.submit_structure' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_structure_bad_json',
      calls: [
        {
          id: 'call_structure_bad_json',
          name: 'novel.episode.submit_structure',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: '{"episodeTitle": "第1集", "scenes": [',
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'Tool arguments are not valid JSON for novel.episode.submit_structure',
    );
    expect(new ChangeSetService(project).list({ includeTerminal: false })).toHaveLength(0);
  });

  it('lands the full episode flow: publish chapters and scene prompts, then generate and approve scenes/shots', async () => {
    const { conversation, generations, loop, project, workflow } = await setup();
    const content = new ContentService(project);
    const novel = new NovelService(project);
    const context = new NovelContextService(project);

    const publishDocument = (documentId: string) => {
      const current = workflow.getDocument(documentId);
      workflow.submitReview({
        documentId,
        expectedDocumentRowVersion: current.rowVersion,
      });
      const reviewed = workflow.getDocument(documentId);
      workflow.publish({
        documentId,
        expectedDocumentRowVersion: reviewed.rowVersion,
        expectedPublishedVersionId: reviewed.publishedVersionId,
      });
    };

    // 1. Upload and publish chapters.
    const chapters: string[] = [];
    for (const title of ['第一章', '第二章', '第三章']) {
      const chapter = novel.saveChapter({ title });
      const draft = workflow.saveDraft({
        documentId: chapter.documentId,
        title: chapter.title,
        contentMarkdown: `${title}正文，白家三房的日常。`,
        expectedDocumentRowVersion: chapter.documentRowVersion,
      });
      publishDocument(draft.id);
      chapters.push(chapter.id);
    }

    // 2. Publish a scene prompt document WITHOUT a document_bindings row.
    const scenePrompt = workflow.saveDraft({
      kind: 'scene',
      title: '本集场景提示词',
      contentMarkdown: '# 白家三房\n堂屋与两侧小房，年代农家。\n\n# 白家正屋\n待客与吃饭的主屋。',
    });
    publishDocument(scenePrompt.id);

    // 3. Short-drama context must expose the published scene prompt to the model.
    const compiled = context.compileShortDrama(conversation.id, undefined, chapters);
    expect(compiled.rendered).toContain('场景提示词：本集场景提示词');
    expect(compiled.rendered).toContain('# 白家三房');
    expect(compiled.rendered).toContain('# 白家正屋');

    // 4. Generate an episode structure that references the published scene names.
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '生成本集的场次和镜头提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '生成本集的场次和镜头提示词',
      '第1集',
      { operation: 'novel.episode.submit_structure' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_episode_flow',
      calls: [
        {
          id: 'call_episode_flow',
          name: 'novel.episode.submit_structure',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            episodeTitle: '第1集',
            scenes: [
              {
                title: '白家三房 · 午后',
                shots: [
                  {
                    title: '屋檐下全景',
                    prompt: '[场景:白家三房] 屋檐下全景，白小弟在学医。',
                  },
                ],
              },
            ],
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain(
      'episode_structure_change_set_created',
    );

    // 5. Approve the change set; prompts must land on shots.
    const changeSets = new ChangeSetService(project);
    const proposed = changeSets.list({ includeTerminal: false });
    expect(proposed).toHaveLength(1);
    const applied = changeSets.apply({
      changeSetId: proposed[0]!.id,
      expectedRowVersion: proposed[0]!.rowVersion,
    });
    expect(applied.status).toBe('applied');
    const scene = content.listScenes()[0]!;
    expect(content.listShots(scene.id)).toMatchObject([
      { title: '屋檐下全景', prompt: '[场景:白家三房] 屋檐下全景，白小弟在学医。' },
    ]);
  });

  it('creates character and scene documents through document.create_draft documentKind', async () => {
    const { conversation, generations, loop, workflow } = await setup();
    const prepared = generations.prepare({
      conversationId: conversation.id,
      prompt: '把前三章的人物做成提示词',
      providerProfileId: 'profile',
      modelId: 'model',
    });
    const agent = loop.prepare(
      prepared.stream,
      '把前三章的人物做成提示词',
      '角色提示词',
      { operation: 'document.create_draft' },
      'project_only',
    );
    generations.configureAgentTools(prepared.stream, agent.tools);
    loop.startProviderStep(prepared.stream);
    const result = await loop.executeTools({
      ...prepared.stream,
      providerResponseId: 'resp_char_draft',
      calls: [
        {
          id: 'call_char_draft',
          name: 'document.create_draft',
          authorizationHandle: agent.tools[0]!.authorizationHandle,
          argumentsJson: JSON.stringify({
            title: '前三章人物提示词',
            contentMarkdown: '# 林澈\n灯塔守望员。',
            documentKind: 'character',
          }),
        },
      ],
    });
    expect(result.continuation?.outputs[0]?.output).toContain('draft_created');
    const parsed = JSON.parse(result.continuation!.outputs[0]!.output) as { documentId: string };
    expect(workflow.getDocument(parsed.documentId).kind).toBe('character');
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

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}
