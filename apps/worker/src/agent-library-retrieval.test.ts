import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LibraryReadResult, LibrarySearchResult } from '@ai-video/contracts';
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  type Context,
} from '@earendil-works/pi-ai';
import { AgentProviderLoopService } from './agent-provider-loop-service.js';
import { ContentService } from './content-service.js';
import { ContextService } from './context-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { GenerationService } from './generation-service.js';
import { NovelService } from './novel-service.js';
import { PiConversationRuntime } from './pi-conversation-runtime.js';
import { ProjectService } from './project-service.js';
import { TaskPlanService } from './task-plan-service.js';

function toolResult<T>(context: Context, toolName: string): T {
  const message = [...context.messages]
    .reverse()
    .find((item) => item.role === 'toolResult' && item.toolName === toolName);
  if (!message || message.role !== 'toolResult') {
    throw new Error(`Missing ${toolName} result in the model context.`);
  }
  expect(message.isError).toBe(false);
  const text = message.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
  return JSON.parse(text) as T;
}

describe('Agent library retrieval integration', () => {
  it('retrieves the first imported chapter and saves grounded shot prompts without a chapter selection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agent-library-retrieval-'));
    const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
    try {
      projects.create(join(directory, 'project'), 'Novel retrieval project');
      const novels = new NovelService(projects);
      const opening = '林澈提灯进入雾港，发现一封蜡封的旧信。';
      const ending = '天亮时，林澈把信交给守塔人，蓝色灯火终于熄灭。';
      const thirdChapterText = '月球空间站的机器人敲响警报，金属舱门关闭。';
      const firstChapterText = [
        opening,
        ...Array.from(
          { length: 120 },
          (_, index) =>
            `潮汐记录 ${index + 1}：林澈沿着码头逐一检查船桩，海雾遮住石阶，信封一直藏在他的外套内侧。`,
        ),
        ending,
      ].join('\n\n');
      const imported = novels.importNovel({
        chapters: [
          { title: '雾港来信', contentMarkdown: firstChapterText },
          { title: '山谷回声', contentMarkdown: '山谷的旅人听见远处钟声，继续穿过松林。' },
          { title: '空间站警报', contentMarkdown: thirdChapterText },
        ],
      });
      expect(imported.chapters.map((chapter) => chapter.displayLabel)).toEqual([
        '第 1 章',
        '第 2 章',
        '第 3 章',
      ]);
      const firstChapter = imported.chapters[0]!;
      expect(firstChapter.ragChunkCount).toBeGreaterThan(1);
      const content = new ContentService(projects);
      const conversation = content.createConversation({ scopeType: 'project' });
      const workflow = new DocumentWorkflowService(projects);
      const firstVersion = workflow.getDocument(firstChapter.documentId).currentVersion!;
      const generations = new GenerationService(
        projects,
        content,
        new ContextService(projects),
        {
          status: () => ({ key: 'unused', name: 'Unused', model: 'unused', configured: false }),
          stream: () => Promise.reject(new Error('No external requests in this test.')),
        },
        {
          selectionResolver: {
            resolveLlmSelection: () => ({
              providerProfileId: 'profile',
              providerName: 'Faux',
              modelId: 'model',
              modelName: 'Faux model',
              remoteModelId: 'faux-model',
              protocol: 'openai-responses',
              baseUrl: 'https://faux.invalid/v1',
            }),
          },
        },
      );
      const prompt = '根据小说第一章生成镜头提示词';
      const prepared = generations.prepare({
        conversationId: conversation.id,
        prompt,
        providerProfileId: 'profile',
        modelId: 'model',
      });
      const loop = new AgentProviderLoopService(projects, workflow);
      const agent = loop.prepare(prepared.stream, prompt);
      generations.configureAgentTools(prepared.stream, agent.tools);
      const initial = generations.runtime(prepared.stream);
      expect(initial.context).toContain('第 1 章 雾港来信');
      expect(initial.context).not.toContain(opening);
      expect(initial.context).not.toContain(ending);
      expect(initial.context).not.toContain(thirdChapterText);
      const snapshot = projects.access(false, (database) => {
        const row = database
          .prepare('SELECT request_snapshot_json FROM agent_tasks WHERE id = ?')
          .get(agent.taskId) as { request_snapshot_json: string };
        return JSON.parse(row.request_snapshot_json) as Record<string, unknown>;
      });
      expect(snapshot).not.toHaveProperty('selectedChapterIds');

      const faux = createFauxCore({ api: 'pi-test', provider: 'pi-test' });
      let searched: LibrarySearchResult | undefined;
      let read: LibraryReadResult | undefined;
      let writtenDocumentId: string | undefined;
      faux.setResponses([
        (context) => {
          expect(context.tools?.map((tool) => tool.name)).toContain('library.search');
          expect(context.systemPrompt).not.toContain(opening);
          return fauxAssistantMessage(
            [
              fauxToolCall(
                'library.search',
                { query: '第一章', sourceTypes: ['novel-chapter'] },
                { id: 'search-first-chapter' },
              ),
            ],
            { stopReason: 'toolUse', responseId: 'searched-first-chapter' },
          );
        },
        (context) => {
          searched = toolResult<LibrarySearchResult>(context, 'library.search');
          expect(searched.status).toBe('searched');
          expect(searched.sources[0]).toMatchObject({
            sourceId: firstChapter.id,
            versionId: firstVersion.id,
            title: '第 1 章 雾港来信',
            sourceType: 'novel-chapter',
            status: 'draft',
          });
          return fauxAssistantMessage(
            [
              fauxToolCall(
                'library.read',
                {
                  sourceHandle: searched.sources[0]!.sourceHandle,
                  readMode: 'source',
                  maxChars: 12000,
                },
                { id: 'read-first-chapter' },
              ),
            ],
            { stopReason: 'toolUse', responseId: 'read-first-chapter' },
          );
        },
        (context) => {
          read = toolResult<LibraryReadResult>(context, 'library.read');
          expect(read).toMatchObject({
            status: 'read',
            sourceId: firstChapter.id,
            versionId: firstVersion.id,
            sourceStatus: 'draft',
            readMode: 'source',
            truncated: false,
          });
          expect(read.content).toBe(firstChapterText);
          expect(read.content).toContain(ending);
          expect(read.content).not.toContain(thirdChapterText);
          expect(read.contentHash).toBe(
            createHash('sha256').update(firstChapterText, 'utf8').digest('hex'),
          );
          return fauxAssistantMessage(
            [
              fauxToolCall(
                'document.create_draft',
                {
                  title: '第一章镜头提示词',
                  documentKind: 'storyboard',
                  contentMarkdown: [
                    '# 第一章镜头提示词',
                    `来源：${read.title} [${read.citationLabel}]（草稿）`,
                    `镜头 1：${read.content.split('\n\n')[0]}`,
                    `镜头 2：${read.content.split('\n\n').at(-1)}`,
                  ].join('\n\n'),
                },
                { id: 'write-shot-prompts' },
              ),
            ],
            { stopReason: 'toolUse', responseId: 'written-shot-prompts' },
          );
        },
        (context) => {
          const result = toolResult<{ status: string; documentId: string }>(
            context,
            'document.create_draft',
          );
          expect(result.status).toBe('draft_created');
          writtenDocumentId = result.documentId;
          return fauxAssistantMessage('已根据第一章草稿保存镜头提示词，包含交信结尾。');
        },
      ]);
      const runtime = new PiConversationRuntime({
        generation: generations,
        plans: new TaskPlanService(projects),
        providerTools: loop,
        streamFn: faux.streamSimple,
        createGateway: () => {
          throw new Error('A single document task does not require a structured plan.');
        },
      });
      await runtime.start({
        ...prepared.stream,
        identity: prepared.stream,
        taskId: agent.taskId,
        mode: 'document',
        prompt,
      });
      await runtime.wait(prepared.stream.generationId);

      expect(generations.get(prepared.stream.generationId).status).toBe('complete');
      expect(faux.state.callCount).toBe(4);
      expect(searched?.sources[0]?.sourceId).toBe(firstChapter.id);
      expect(read?.content).toContain(ending);
      expect(writtenDocumentId).toBeDefined();
      const draft = workflow.getDocument(writtenDocumentId!);
      expect(draft.currentVersion).toMatchObject({
        authorType: 'agent',
        sourceTaskId: agent.taskId,
      });
      expect(draft.currentVersion?.contentMarkdown).toContain(opening);
      expect(draft.currentVersion?.contentMarkdown).toContain(ending);
      expect(draft.currentVersion?.contentMarkdown).not.toContain(thirdChapterText);
      const task = workflow.getTask({ taskId: agent.taskId });
      expect(task.documents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            documentId: draft.id,
            documentVersionId: draft.currentVersion?.id,
          }),
        ]),
      );
      expect(task.librarySources).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolName: 'library.read',
            sourceId: firstChapter.id,
            versionId: firstVersion.id,
            status: 'draft',
          }),
        ]),
      );
    } finally {
      projects.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
