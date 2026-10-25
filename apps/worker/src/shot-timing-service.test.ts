import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ShotInfo } from '@ai-video/contracts';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import {
  AgentSystemToolService,
  type AgentAssetToolService,
  type AgentSettingsToolService,
} from './agent-system-tool-service.js';
import { ShotTimingService } from './shot-timing-service.js';
import { unifiedAgentToolRegistry } from './agent-tool-registry.js';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    f.projects.close();
    await rm(f.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'shot-timing-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  const project = projects.create(join(directory, 'project'), '时长更新');
  const content = new ContentService(projects);
  const conversation = content.createConversation({ scopeType: 'project', title: '会话' });
  const identity = {
    projectId: project.id,
    projectSessionId: projects.currentSessionId()!,
    conversationId: conversation.id,
    taskId: 'timing-task',
  };
  const tools = new AgentSystemToolService(
    projects,
    content,
    {} as AgentAssetToolService,
    {} as AgentSettingsToolService,
  );
  const production = new ProductionService(projects);
  const scene = content.saveScene({ title: '测试场次' });
  return {
    projects,
    project,
    content,
    identity,
    tools,
    production,
    scene,
    service: new ShotTimingService(projects),
  };
}
const update = (shot: ShotInfo, seconds = 5) => ({
  shotId: shot.id,
  expectedRowVersion: shot.rowVersion,
  estimatedDurationSeconds: seconds,
  rationale: '动作和反应所需时长',
});
describe('shot timing patch', () => {
  it('saves 15 existing shots after four structure reads, preserving every prompt, binding and open field', async () => {
    const f = await setup();
    const actor = f.content.saveDocument({
      kind: 'character',
      title: '司机',
      contentMarkdown: '司机',
    });
    const setting = f.content.saveDocument({
      kind: 'scene',
      title: '车站',
      contentMarkdown: '车站',
    });
    const prop = f.content.saveDocument({ kind: 'prop', title: '车票', contentMarkdown: '车票' });
    const durations = [5, 4, 4, 5, 6, 7, 5, 5, 5, 8, 5, 5, 4, 6, 5];
    const scenes = [
      f.scene,
      ...Array.from({ length: 3 }, (_, i) => f.content.saveScene({ title: `场次 ${i + 2}` })),
    ].map((scene) =>
      f.content.saveScene({
        sceneId: scene.id,
        title: scene.title,
        expectedRowVersion: scene.rowVersion,
        sceneDocumentId: setting.id,
        characterBindings: [
          { characterDocumentId: actor.id, imageDisabled: true, voiceDisabled: true },
        ],
      }),
    );
    const shots = scenes.flatMap((scene, i) =>
      Array.from({ length: i === 3 ? 3 : 4 }, (_, j) =>
        f.content.saveShot({
          sceneId: scene.id,
          title: `镜头 ${i}-${j}`,
          status: 'active',
          authoringIR: {
            schemaVersion: 1,
            kind: 'shot',
            prompt: `  动作 ${i}-${j}，保留“引号”。\n人物停顿。  `,
            references: {
              characterDocumentIds: [actor.id],
              sceneDocumentIds: [setting.id],
              propDocumentIds: [prop.id],
            },
            data: { camera: { custom: '固定机位' }, timing: { arbitrary: '不作为运行时长' } },
          },
        }),
      ),
    );
    const before = f.content.listScenes();
    const sourceBefore = f.production.queryVersion({ kind: 'shot', id: shots[0]!.id });
    expect(
      f.production.read({ kind: 'scene', id: scenes[0]!.id }).estimatedDurationSeconds,
    ).toBeUndefined();
    for (const scene of scenes) {
      const structure = f.tools.execute('scene.read', { sceneId: scene.id }, f.identity);
      expect(structure.complete).toBe(true);
      const metadata = structure.shots as Array<{
        id: string;
        rowVersion: number;
        contentFormat: string;
      }>;
      expect(
        metadata.map(({ id, rowVersion, contentFormat }) => ({ id, rowVersion, contentFormat })),
      ).toEqual(
        shots
          .filter((shot) => shot.sceneId === scene.id)
          .map((shot) => ({
            id: shot.id,
            rowVersion: shot.rowVersion,
            contentFormat: 'authoring-ir-v1',
          })),
      );
      expect(JSON.stringify(structure)).not.toContain('固定机位');
    }
    const args = { shots: shots.map((shot, i) => update(shot, durations[i])) };
    const result = f.tools.execute('scene.update_shot_timings', args, f.identity);
    expect(result).toMatchObject({
      status: 'shot_timings_saved',
      changedCount: 15,
      paidRequests: 0,
    });
    unifiedAgentToolRegistry.serializeResult(result);
    expect(f.tools.execute('scene.update_shot_timings', args, f.identity)).toEqual(result);
    expect(f.content.listScenes()).toEqual(before);
    const saved = scenes.flatMap((scene) => f.content.listShots(scene.id));
    expect(saved).toHaveLength(15);
    saved.forEach((shot, i) => {
      const original = shots[i]!;
      expect(shot.updatedAt).toBeTruthy();
      expect({ ...shot, updatedAt: original.updatedAt }).toEqual({
        ...original,
        rowVersion: original.rowVersion + 1,
        authoringIR: {
          ...original.authoringIR!,
          timing: {
            estimatedDurationSeconds: durations[i],
            rationale: args.shots[i]!.rationale,
          },
        },
      });
    });
    const totals = scenes.map(
      (scene) => f.production.read({ kind: 'scene', id: scene.id }).estimatedDurationSeconds!,
    );
    expect(totals).toEqual([18, 23, 23, 15]);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(79);
    const single = f.production.read({ kind: 'shot', id: shots[0]!.id });
    expect(single.estimatedDurationSeconds).toBe(5);
    expect(f.production.queryVersion({ kind: 'shot', id: shots[0]!.id })).not.toBe(sourceBefore);
    expect(single.compiledPrompt).toBe(shots[0]!.prompt);
    const timeline = f.production.read({ kind: 'scene', id: scenes[0]!.id }).timeline!;
    expect(timeline.map(({ startSeconds, endSeconds }) => [startSeconds, endSeconds])).toEqual([
      [0, 5],
      [5, 9],
      [9, 13],
      [13, 18],
    ]);
    const subset = f.production.read(
      { kind: 'scene', id: scenes[0]!.id },
      shots.slice(1, 3).map((shot) => shot.id),
    );
    expect(subset.estimatedDurationSeconds).toBe(8);
    expect(subset.timeline![0]!.startSeconds).toBe(0);
    const after = f.tools.execute('scene.read', { sceneId: scenes[0]!.id }, f.identity);
    expect((after.shots as Array<Record<string, unknown>>)[0]).toMatchObject({
      timing: { estimatedDurationSeconds: 5 },
      rowVersion: shots[0]!.rowVersion + 1,
    });
  });

  it('maps saved IR duration to the video form and segment planner without changing text', async () => {
    const f = await setup();
    const shots = [0, 1, 2].map((i) =>
      f.content.saveShot({
        sceneId: f.scene.id,
        title: `镜头${i}`,
        authoringIR: { schemaVersion: 1, kind: 'shot', prompt: `动作${i}` },
      }),
    );
    f.service.update({ shots: shots.map((shot) => update(shot, 8)) }, f.identity);
    const adapter = getAdapterCatalog().adapters.find(
      (a) =>
        a.contractId === 'cn.qwen.wan3-0-video' &&
        a.capability === 'TEXT_TO_VIDEO' &&
        a.provider === 'wan-video',
    )!;
    const single = f.production.compile({
      target: { kind: 'shot', id: shots[0]!.id },
      adapterKey: adapter.key,
    });
    expect(single.parameters.duration).toBe(8);
    expect(single.estimatedDurationSeconds).toBe(8);
    const whole = f.production.compile({
      target: { kind: 'scene', id: f.scene.id },
      adapterKey: adapter.key,
    });
    expect(whole.estimatedDurationSeconds).toBe(24);
    expect(whole.segments!.flatMap((segment) => segment.shotIds)).toEqual(
      shots.map((shot) => shot.id),
    );
  });

  it('preserves manually authored IR when updating only timing', async () => {
    const f = await setup();
    const shot = f.content.saveShot({
      sceneId: f.scene.id,
      title: 'manual shot',
      prompt: 'Look down the corridor.',
    });
    f.service.update({ shots: [update(shot, 6.5)] }, f.identity);
    const saved = f.content.listShots(f.scene.id)[0]!;
    expect(saved.prompt).toBe(shot.prompt);
    expect(saved.authoringIR).toMatchObject({
      prompt: shot.prompt,
      timing: { estimatedDurationSeconds: 6.5 },
    });
    const result = f.service.update({ shots: [update(saved, 6.5)] }, f.identity);
    expect(result).toMatchObject({ changedCount: 0, unchangedCount: 1 });
    expect(f.content.listShots(f.scene.id)).toEqual([saved]);
  });

  it('rejects invalid durations, unknown fields, repeated IDs and stale CAS without partial writes', async () => {
    const f = await setup();
    const a = f.content.saveShot({ sceneId: f.scene.id, title: 'A', prompt: '动作A' });
    const b = f.content.saveShot({ sceneId: f.scene.id, title: 'B', prompt: '动作B' });
    for (const seconds of [0, -1, Infinity, 3601, '5', null])
      expect(() =>
        f.service.update(
          { shots: [update(a), { ...update(b), estimatedDurationSeconds: seconds }] },
          f.identity,
        ),
      ).toThrow(/estimatedDurationSeconds/);
    expect(() => f.service.update({ shots: [update(a), update(a)] }, f.identity)).toThrow(/重复/);
    expect(() =>
      f.service.update(
        { shots: [update(a), { ...update(b), expectedRowVersion: b.rowVersion + 1 }] },
        f.identity,
      ),
    ).toThrow(/ROW_VERSION_CONFLICT/);
    expect(() =>
      f.service.update({ shots: [{ ...update(a), prompt: '覆盖正文' }] }, f.identity),
    ).toThrow(/不支持/);
    expect(() =>
      f.service.update(
        { shots: [update(a), { ...update(b), shotId: 'not-in-project' }] },
        f.identity,
      ),
    ).toThrow(/当前项目/);
    expect(() =>
      f.tools.execute(
        'scene.update_shot_timings',
        { shots: [update(a)] },
        { ...f.identity, projectId: 'other' },
      ),
    ).toThrow(/PROJECT_SCOPE/);
    expect(() =>
      f.tools.execute(
        'scene.update_shot_timings',
        { shots: [update(a)] },
        { ...f.identity, projectSessionId: 'old' },
      ),
    ).toThrow(/PROJECT_SCOPE/);
    expect(f.content.listShots(f.scene.id)).toEqual([a, b]);
    expect(
      f.projects.access(false, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM agent_write_receipts').get(),
      ),
    ).toEqual({ n: 0 });
  });

  it('rolls back all updates and the execution receipt when persistence fails mid-batch', async () => {
    const f = await setup();
    const shots = [0, 1].map((i) =>
      f.content.saveShot({ sceneId: f.scene.id, title: `镜头${i}`, prompt: `动作${i}` }),
    );
    f.projects.access(true, (db) =>
      db.exec(
        "CREATE TRIGGER reject_second_timing BEFORE UPDATE ON shots WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'fixture timing failure'); END",
      ),
    );
    expect(() =>
      f.service.update({ shots: shots.map((shot) => update(shot)) }, f.identity),
    ).toThrow(/fixture timing failure/);
    expect(f.content.listShots(f.scene.id)).toEqual(shots);
    expect(
      f.projects.access(false, (db) =>
        db.prepare('SELECT COUNT(*) AS n FROM agent_write_receipts').get(),
      ),
    ).toEqual({ n: 0 });
  });
});
