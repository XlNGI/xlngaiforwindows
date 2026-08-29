import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChangeSetService } from './change-set-service.js';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { DomainToolGateway } from './domain-tool-gateway.js';
import { ProjectService } from './project-service.js';
import { TaskPlanService } from './task-plan-service.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-pi-gateway-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  project.create(join(directory, 'project'), 'Pi Gateway Project');
  const conversation = new ContentService(project).createConversation({
    scopeType: 'project',
    title: '短剧',
  });
  const ids = project.access(true, (database, current) => {
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO documents
      (id, project_id, kind, title, scope_type, lifecycle_status, row_version, created_at, updated_at)
      VALUES ('chapter-document', ?, 'note', '第一章', 'project', 'active', 0, ?, ?)`,
      )
      .run(current.id, now, now);
    database
      .prepare(
        `INSERT INTO novel_chapters
      (id, project_id, document_id, position, display_label, lifecycle_status, row_version, created_at, updated_at)
      VALUES ('chapter-1', ?, 'chapter-document', 0, '第一章', 'active', 0, ?, ?)`,
      )
      .run(current.id, now, now);
    database
      .prepare(
        `INSERT INTO agent_tasks
      (id, project_id, project_session_id, conversation_id, task_type, scope_type, title,
       request_snapshot_json, request_hash, status, created_at, started_at, updated_at, phase, row_version, tool_call_limit)
      VALUES ('task-1', ?, ?, ?, 'document-create', 'project', '短剧任务', ?, 'hash', 'running', ?, ?, ?, 'model_running', 0, 16)`,
      )
      .run(
        current.id,
        project.currentSessionId(),
        conversation.id,
        JSON.stringify({
          agentMode: 'short-drama',
          selectedChapterIds: ['chapter-1'],
          targetPlatform: 'seedance',
        }),
        now,
        now,
        now,
      );
    return {
      projectId: current.id,
      projectSessionId: project.currentSessionId()!,
      conversationId: conversation.id,
    };
  });
  return { project, ...ids };
}

const plan = {
  version: 1,
  mode: 'short-drama' as const,
  action: 'generate' as const,
  targetPlatform: 'seedance' as const,
  deliverables: [
    { kind: 'episode-outline' as const, required: true, dependsOn: [] },
    { kind: 'character-prompts' as const, required: true, dependsOn: [] },
    {
      kind: 'scene-shot-structure' as const,
      required: true,
      dependsOn: ['episode-outline' as const, 'character-prompts' as const],
    },
    { kind: 'shot-prompts' as const, required: true, dependsOn: ['scene-shot-structure' as const] },
  ],
  constraints: [],
};

describe('DomainToolGateway', () => {
  it('creates multiple reviewable documents and a change set under one task', async () => {
    const { project, projectId, projectSessionId, conversationId } = await setup();
    const plans = new TaskPlanService(project);
    plans.submitPlanOnly({ taskId: 'task-1', candidate: plan, idempotencyKey: 'pi-plan-task-1' });
    const gateway = new DomainToolGateway(
      project,
      plans,
      new DocumentWorkflowService(project),
      new ChangeSetService(project),
      {
        taskId: 'task-1',
        projectId,
        projectSessionId,
        conversationId,
        generationId: 'generation-1',
      },
    );

    const outline = gateway
      .tools(plans.availableToolGrants('task-1'))
      .find((tool) => tool.name === 'novel.episode.submit_draft')!;
    await outline.execute('call-outline', { title: '第 1 集大纲', contentMarkdown: '# 大纲' });
    const character = gateway
      .tools(plans.availableToolGrants('task-1'))
      .find((tool) => tool.name === 'document.create_draft')!;
    await character.execute('call-character', {
      title: '角色提示词',
      contentMarkdown: '# 角色',
      documentKind: 'character',
    });
    const structure = gateway
      .tools(plans.availableToolGrants('task-1'))
      .find((tool) => tool.name === 'novel.episode.submit_structure')!;
    await structure.execute('call-structure', {
      episodeTitle: '第 1 集',
      scenes: [{ title: '旧码头', shots: [{ title: '远景', prompt: '海雾中的旧码头。' }] }],
    });

    const rows = project.access(false, (database) => ({
      links: database
        .prepare('SELECT COUNT(*) AS count FROM agent_task_document_versions WHERE task_id = ?')
        .get('task-1') as { count: number },
      calls: database
        .prepare(
          'SELECT status, tool_name FROM agent_tool_calls WHERE task_id = ? ORDER BY created_at',
        )
        .all('task-1') as Array<{ status: string; tool_name: string }>,
      changeSets: database
        .prepare('SELECT COUNT(*) AS count FROM agent_change_sets WHERE task_id = ?')
        .get('task-1') as { count: number },
    }));
    expect(rows.links.count).toBe(2);
    expect(rows.changeSets.count).toBe(1);
    expect(rows.calls).toEqual([
      { status: 'succeeded', tool_name: 'novel.episode.submit_draft' },
      { status: 'succeeded', tool_name: 'document.create_draft' },
      { status: 'succeeded', tool_name: 'novel.episode.submit_structure' },
    ]);
    await expect(
      outline.execute('call-outline', { title: '第 1 集大纲', contentMarkdown: '# 大纲' }),
    ).rejects.toThrow(/already completed/);
    expect(
      project.access(
        false,
        (database) =>
          (
            database
              .prepare(
                "SELECT status FROM agent_tool_calls WHERE idempotency_key LIKE '%call-outline'",
              )
              .get() as { status: string }
          ).status,
      ),
    ).toBe('succeeded');
  });

  it('rejects malformed structure before creating a change set', async () => {
    const { project, projectId, projectSessionId, conversationId } = await setup();
    const plans = new TaskPlanService(project);
    plans.submitPlanOnly({ taskId: 'task-1', candidate: plan });
    const gateway = new DomainToolGateway(
      project,
      plans,
      new DocumentWorkflowService(project),
      new ChangeSetService(project),
      {
        taskId: 'task-1',
        projectId,
        projectSessionId,
        conversationId,
      },
    );
    const structure = gateway
      .tools(plans.availableToolGrants('task-1'))
      .find((tool) => tool.name === 'novel.episode.submit_draft')!;
    await expect(
      structure.execute('bad-call', { title: 'x', contentMarkdown: 'x'.repeat(1_000_001) }),
    ).rejects.toThrow(/contentMarkdown/);
    expect(
      project.access(
        false,
        (database) =>
          (
            database.prepare('SELECT COUNT(*) AS count FROM agent_change_sets').get() as {
              count: number;
            }
          ).count,
      ),
    ).toBe(0);
  });
});
