import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import { ShotPromptService } from './shot-prompt-service.js';
import {
  AgentSystemToolService,
  type AgentAssetToolService,
  type AgentSettingsToolService,
} from './agent-system-tool-service.js';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.projects.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'shot-prompt-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  const project = projects.create(join(directory, 'project'), '提示词修订');
  const content = new ContentService(projects);
  const conversation = content.createConversation({ scopeType: 'project' });
  const identity = {
    projectId: project.id,
    projectSessionId: projects.currentSessionId()!,
    conversationId: conversation.id,
    taskId: 'prompt-task',
  };
  const actor = content.saveDocument({ kind: 'character', title: '甲', contentMarkdown: '甲' });
  const prop = content.saveDocument({ kind: 'prop', title: '钥匙', contentMarkdown: '钥匙' });
  const scene = content.saveScene({
    title: '门口',
    characterBindings: [{ characterDocumentId: actor.id, imageDisabled: true }],
  });
  const shot = content.saveShot({
    sceneId: scene.id,
    title: '开门',
    status: 'active',
    authoringIR: {
      schemaVersion: 1,
      kind: 'shot',
      prompt: '甲开门。',
      references: { characterDocumentIds: [actor.id], propDocumentIds: [prop.id] },
      timing: { estimatedDurationSeconds: 5, rationale: '开门和停顿' },
      data: { custom: ['保留原有结构'] },
    },
  });
  const tools = new AgentSystemToolService(
    projects,
    content,
    {} as AgentAssetToolService,
    {} as AgentSettingsToolService,
  );
  return {
    projects,
    project,
    content,
    identity,
    actor,
    prop,
    scene,
    shot,
    tools,
    production: new ProductionService(projects),
    service: new ShotPromptService(projects),
  };
}
const ir = (prompt = '  甲开门，逐字说“请进”。\n固定机位，无配乐。  ') => ({
  schemaVersion: 1 as const,
  kind: 'shot' as const,
  prompt,
});

describe('shot prompt revision', () => {
  it('updates the existing target verbatim, preserves optional state and compiles all requirements to the form', async () => {
    const f = await setup();
    const beforeSource = f.production.queryVersion({ kind: 'shot', id: f.shot.id });
    const args = {
      shots: [{ shotId: f.shot.id, expectedRowVersion: f.shot.rowVersion, authoringIR: ir() }],
    };
    const result = f.tools.execute('scene.update_shot_prompts', args, f.identity);
    expect(result).toMatchObject({
      status: 'shot_prompts_saved',
      changedCount: 1,
      paidRequests: 0,
    });
    expect(f.tools.execute('scene.update_shot_prompts', args, f.identity)).toEqual(result);
    const shots = f.content.listShots(f.scene.id);
    expect(shots).toHaveLength(1);
    const saved = shots[0]!;
    expect(saved).toEqual({
      ...f.shot,
      prompt: ir().prompt,
      authoringIR: { ...f.shot.authoringIR!, prompt: ir().prompt },
      rowVersion: f.shot.rowVersion + 1,
      updatedAt: saved.updatedAt,
    });
    expect(f.content.listScenes()).toEqual([f.scene]);
    expect(f.production.queryVersion({ kind: 'shot', id: saved.id })).not.toBe(beforeSource);
    const adapter = getAdapterCatalog().adapters.find(
      (a) =>
        a.contractId === 'cn.qwen.wan3-0-video' &&
        a.capability === 'TEXT_TO_VIDEO' &&
        a.provider === 'wan-video',
    )!;
    expect(
      f.production.compile({ target: { kind: 'shot', id: saved.id }, adapterKey: adapter.key })
        .parameters.prompt,
    ).toBe(ir().prompt);
    const noChange = f.service.update(
      { shots: [{ ...args.shots[0]!, expectedRowVersion: saved.rowVersion }] },
      f.identity,
    );
    expect(noChange).toMatchObject({ changedCount: 0, unchangedCount: 1 });
    expect(f.content.listShots(f.scene.id)).toEqual(shots);
    f.projects.access(false, (db) => {
      const chunks = db
        .prepare(
          "SELECT content_text FROM project_library_chunks WHERE source_type='shot' AND source_id=?",
        )
        .all(saved.id);
      expect(JSON.stringify(chunks)).toContain('固定机位，无配乐');
    });
  });

  it('merges omitted reference scopes and allows explicit clearing without touching the shared cast', async () => {
    const f = await setup();
    f.service.update(
      {
        shots: [
          {
            shotId: f.shot.id,
            expectedRowVersion: f.shot.rowVersion,
            authoringIR: { ...ir(), references: { characterDocumentIds: [] }, data: {} },
          },
        ],
      },
      f.identity,
    );
    const saved = f.content.listShots(f.scene.id)[0]!;
    expect(saved.authoringIR?.references).toEqual({
      characterDocumentIds: [],
      propDocumentIds: [f.prop.id],
    });
    expect(saved.authoringIR?.data).toEqual({});
    expect(saved.authoringIR?.timing).toEqual(f.shot.authoringIR?.timing);
    expect(f.content.listScenes()).toEqual([f.scene]);
  });

  it('rejects invalid batches, stale versions, wrong sessions and invalid project reference types atomically', async () => {
    const f = await setup();
    const entry = { shotId: f.shot.id, expectedRowVersion: f.shot.rowVersion, authoringIR: ir() };
    for (const shots of [
      [entry, entry],
      [entry, { ...entry, shotId: 'foreign-shot' }],
      [{ ...entry, expectedRowVersion: 999 }],
      [{ ...entry, authoringIR: { ...ir(), references: { characterDocumentIds: [f.prop.id] } } }],
      [{ ...entry, authoringIR: ir('界'.repeat(11000)) }],
    ])
      expect(() => f.service.update({ shots }, f.identity)).toThrow();
    for (const identity of [
      { ...f.identity, projectId: 'other' },
      { ...f.identity, projectSessionId: 'old' },
    ])
      expect(() => f.service.update({ shots: [entry] }, identity)).toThrow(/当前项目会话/);
    expect(f.content.listShots(f.scene.id)).toEqual([f.shot]);
    f.projects.access(false, (db) =>
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_write_receipts').get()).toEqual({
        n: 0,
      }),
    );
  });

  it('rolls back earlier writes, index updates, receipts and project timestamp if a later database write fails', async () => {
    const f = await setup();
    const second = f.content.saveShot({ sceneId: f.scene.id, title: '观察', prompt: '看向门外。' });
    const updatedAt = f.project.updatedAt;
    const before = f.content.listShots(f.scene.id);
    const chunksBefore = f.projects.access(false, (db) =>
      db.prepare('SELECT * FROM project_library_chunks ORDER BY id').all(),
    );
    f.projects.access(true, (db) =>
      db.exec(
        "CREATE TRIGGER fail_prompt_update BEFORE UPDATE ON shots WHEN OLD.title='观察' BEGIN SELECT RAISE(ABORT,'forced failure'); END",
      ),
    );
    expect(() =>
      f.service.update(
        {
          shots: before.map((shot) => ({
            shotId: shot.id,
            expectedRowVersion: shot.rowVersion,
            authoringIR: ir(),
          })),
        },
        f.identity,
      ),
    ).toThrow(/forced failure/);
    expect(f.content.listShots(f.scene.id)).toEqual([f.shot, second]);
    expect(f.project.updatedAt).toBe(updatedAt);
    f.projects.access(false, (db) => {
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_write_receipts').get()).toEqual({
        n: 0,
      });
      expect(db.prepare('SELECT * FROM project_library_chunks ORDER BY id').all()).toEqual(
        chunksBefore,
      );
    });
  });
});
