import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  ProductionInstruction,
  ProductionTarget,
  ProductionSource,
} from '@ai-video/contracts';
import { getAdapterCatalog } from '@ai-video/generation-adapters';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';
import { ProductionService } from './production-service.js';
import {
  AgentSystemToolService,
  type AgentAssetToolService,
  type AgentSettingsToolService,
} from './agent-system-tool-service.js';
import { validateSessionRequestParams } from './request-validation.js';
import { VideoGenerationService } from './video-generation-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';

const fixtures: Array<{ projects: ProjectService; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.projects.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'production-execution-'));
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  fixtures.push({ projects, directory });
  const project = projects.create(join(directory, 'project'), '制作清单');
  const content = new ContentService(projects);
  const actor = content.saveDocument({
    kind: 'character',
    title: '林澈',
    contentMarkdown: '角色设定',
  });
  const setting = content.saveDocument({
    kind: 'scene',
    title: '车站',
    contentMarkdown: '场景设定',
  });
  const scene = content.saveScene({
    title: '雨夜',
    sceneDocumentId: setting.id,
    characterBindings: [{ characterDocumentId: actor.id }],
  });
  const shot = content.saveShot({ sceneId: scene.id, title: '入场' });
  return {
    projects,
    project,
    content,
    actor,
    setting,
    scene,
    shot,
    service: new ProductionService(projects),
  };
}
function instruction(patch: Partial<ProductionInstruction> = {}): ProductionInstruction {
  return {
    version: 1,
    summary: '雨中的车站',
    subjects: [],
    visual: {},
    beats: [],
    audio: { mode: 'silent' },
    generation: {},
    resources: [],
    continuity: { predecessors: [], before: [], after: [], locked: [], constraints: [] },
    ...patch,
  };
}
function operation(target: ProductionTarget, expectedRowVersion: number, spec = instruction()) {
  return { action: 'set_prompt', target, expectedRowVersion, instruction: spec };
}
const wan = () =>
  getAdapterCatalog().adapters.find(
    (a) =>
      a.contractId === 'cn.qwen.wan3-0-video' &&
      a.capability === 'TEXT_TO_VIDEO' &&
      a.provider === 'wan-video',
  )!;

describe('production execution in the project store', () => {
  it('atomically projects both pages, persists history across reopen, and replays only identical keys', async () => {
    const f = await setup();
    const list = {
      executionKey: 'all-pages',
      operations: [
        operation({ kind: 'scene', id: f.scene.id }, f.scene.rowVersion),
        operation({ kind: 'character', id: f.actor.id }, f.actor.rowVersion),
        operation({ kind: 'setting', id: f.setting.id }, f.setting.rowVersion),
        operation(
          { kind: 'shot', id: f.shot.id },
          f.shot.rowVersion,
          instruction({ visual: { environment: '雨'.repeat(3000) } }),
        ),
      ],
    };
    const result = f.service.execute(list);
    expect(result).toMatchObject({ status: 'applied', paidRequests: 0 });
    expect(f.service.execute(list)).toEqual(result);
    expect(() => f.service.execute({ ...list, operations: list.operations.slice(1) })).toThrow(
      '执行键',
    );
    expect(f.content.getDocument(f.actor.id).currentVersion?.state).toBe('draft');
    expect(f.content.getDocument(f.actor.id).currentVersion?.contentMarkdown).toContain(
      '雨中的车站',
    );
    expect(f.content.listScenes()[0]?.videoPrompt).toContain('雨中的车站');
    expect(f.service.read({ kind: 'scene', id: f.scene.id }).issues).toEqual([]);
    expect(f.content.listShots(f.scene.id)[0]?.prompt?.length).toBeGreaterThan(3000);
    const source = f.service.read({ kind: 'shot', id: f.shot.id }).source;
    expect(
      f.projects.access(false, (db) =>
        db.prepare('SELECT count(*) AS count FROM generation_jobs').get(),
      ),
    ).toEqual({ count: 0 });
    f.projects.close();
    f.projects.open(f.project.rootPath);
    expect(f.service.read({ kind: 'shot', id: f.shot.id }).source).toEqual(source);
    expect(f.service.execute(list)).toEqual(result);
    f.content.saveDocument({
      documentId: f.actor.id,
      kind: 'character',
      title: f.actor.title,
      contentMarkdown: '角色造型已修改',
    });
    expect(
      f.service.read({ kind: 'scene', id: f.scene.id }).issues.map((issue) => issue.code),
    ).toContain('STALE_INSTRUCTION');
  });
  it('rolls back all operations on stale versions, duplicate targets, invalid references and late write failure', async () => {
    const f = await setup();
    const target = { kind: 'scene' as const, id: f.scene.id };
    const op = operation(target, f.scene.rowVersion);
    expect(() =>
      f.service.execute({
        executionKey: 'cas',
        operations: [op, operation({ kind: 'shot', id: f.shot.id }, 99)],
      }),
    ).toThrow('已被修改');
    expect(() => f.service.execute({ executionKey: 'duplicate', operations: [op, op] })).toThrow(
      '重复',
    );
    expect(() =>
      f.service.execute({
        executionKey: 'references',
        operations: [
          { ...op, instruction: instruction({ subjects: [{ documentId: 'other-project' }] }) },
        ],
      }),
    ).toThrow();
    expect(() =>
      f.service.execute({
        executionKey: 'late',
        operations: [
          op,
          operation(
            { kind: 'shot', id: f.shot.id },
            f.shot.rowVersion,
            instruction({
              visual: Object.fromEntries(
                ['environment', 'composition', 'lighting', 'style', 'palette', 'lens'].map((k) => [
                  k,
                  '雨'.repeat(4000),
                ]),
              ),
            }),
          ),
        ],
      }),
    ).toThrow('20000');
    expect(f.content.listScenes()[0]?.rowVersion).toBe(f.scene.rowVersion);
    expect(
      f.projects.access(false, (db) =>
        db.prepare('SELECT count(*) AS count FROM production_execution_lists').get(),
      ),
    ).toEqual({ count: 0 });
    expect(() =>
      f.service.execute({
        executionKey: 'missing',
        operations: [operation({ kind: 'scene', id: 'foreign' }, 0)],
      }),
    ).toThrow();
  });
  it('combines predecessor states, inherits locks transitively and rejects cycles or ambiguous branch states', async () => {
    const f = await setup();
    const a = { kind: 'scene' as const, id: f.scene.id };
    const b = { kind: 'shot' as const, id: f.shot.id };
    const third = f.content.saveShot({ sceneId: f.scene.id, title: '后续' });
    const c = { kind: 'shot' as const, id: third.id };
    const continuity = (patch: Partial<ProductionInstruction['continuity']>) => ({
      predecessors: [],
      before: [],
      after: [],
      locked: [],
      constraints: [],
      ...patch,
    });
    f.service.execute({
      executionKey: 'graph',
      operations: [
        operation(
          a,
          f.scene.rowVersion,
          instruction({
            continuity: continuity({
              after: [{ key: 'door', value: 'open' }],
              locked: [{ key: 'coat', value: 'blue' }],
            }),
          }),
        ),
        operation(
          b,
          f.shot.rowVersion,
          instruction({ continuity: continuity({ after: [{ key: 'weather', value: 'rain' }] }) }),
        ),
        operation(
          c,
          third.rowVersion,
          instruction({
            continuity: continuity({
              predecessors: [a, b],
              before: [
                { key: 'door', value: 'open' },
                { key: 'weather', value: 'rain' },
              ],
            }),
          }),
        ),
      ],
    });
    expect(f.service.read(c).issues).toEqual([]);
    expect(() =>
      f.service.execute({
        executionKey: 'changed-canonical-dependency',
        operations: [
          operation(
            { kind: 'character', id: f.actor.id },
            f.actor.rowVersion,
            instruction({ summary: '角色的新设定' }),
          ),
          operation(c, f.service.read(c).rowVersion, f.service.read(c).instruction),
        ],
      }),
    ).toThrow('角色/场景资料');
    expect(f.content.getDocument(f.actor.id).currentVersion?.contentMarkdown).toBe('角色设定');
    const fourth = f.content.saveShot({ sceneId: f.scene.id, title: '破坏锁定' });
    expect(() =>
      f.service.execute({
        executionKey: 'lock',
        operations: [
          operation(
            { kind: 'shot', id: fourth.id },
            fourth.rowVersion,
            instruction({
              continuity: continuity({ predecessors: [c], after: [{ key: 'coat', value: 'red' }] }),
            }),
          ),
        ],
      }),
    ).toThrow('锁定');
    expect(() =>
      f.service.execute({
        executionKey: 'cycle',
        operations: [
          operation(
            a,
            f.service.read(a).rowVersion,
            instruction({ continuity: continuity({ predecessors: [c] }) }),
          ),
        ],
      }),
    ).toThrow('循环');
    expect(() =>
      f.service.execute({
        executionKey: 'branch',
        operations: [
          operation(
            b,
            f.service.read(b).rowVersion,
            instruction({ continuity: continuity({ after: [{ key: 'door', value: 'closed' }] }) }),
          ),
          operation(c, f.service.read(c).rowVersion, f.service.read(c).instruction),
        ],
      }),
    ).toThrow('冲突');
    f.content.saveScene({
      sceneId: f.scene.id,
      title: f.scene.title,
      videoPrompt: '人工改写',
      expectedRowVersion: f.service.read(a).rowVersion,
    });
    expect(f.service.read(c).issues.map((i) => i.code)).toContain('STALE_INSTRUCTION');
  });
  it('invalidates effective input changes, ignores unused images, and guards prepare without any paid request', async () => {
    const f = await setup();
    const target = { kind: 'scene' as const, id: f.scene.id };
    f.service.execute({
      executionKey: 'first',
      operations: [operation(target, f.scene.rowVersion)],
    });
    const original = f.service.read(target).source!;
    const addImage = async (id: string) => {
      await writeFile(join(f.project.rootPath, `assets/images/${id}.png`), 'fixture');
      f.projects.access(true, (db, p) => {
        db.prepare(
          "INSERT INTO assets(id,project_id,kind,relative_path,content_hash,size_bytes,created_at) VALUES(?,?,'character',?,?,7,?)",
        ).run(id, p.id, `assets/images/${id}.png`, 'a'.repeat(64), id);
        db.prepare(
          "INSERT INTO generation_jobs(id,project_id,adapter_key,status,request_json,task_snapshot_json,created_at,updated_at) VALUES(?,?,'fixture','succeeded','{}',?,'now','now')",
        ).run(`job-${id}`, p.id, JSON.stringify({ sourceDocumentId: f.actor.id }));
        db.prepare(
          "INSERT INTO generation_results(id,job_id,asset_id,created_at) VALUES(?,?,?,'now')",
        ).run(`result-${id}`, `job-${id}`, id);
      });
    };
    await addImage('first');
    expect(f.service.read(target).source?.token).not.toBe(original.token);
    const selected = f.service.read(target).source!;
    await addImage('second');
    expect(f.service.read(target).source?.token).toBe(selected.token);
    f.service.execute({
      executionKey: 'required-input',
      operations: [
        operation(
          target,
          f.service.read(target).rowVersion,
          instruction({
            resources: [
              {
                kind: 'character-image',
                documentId: f.actor.id,
                required: true,
                purpose: '保持角色外观',
              },
            ],
          }),
        ),
      ],
    });
    const requiredSource = f.service.read(target).source!;
    expect(() =>
      f.service.assertSource(requiredSource, target, wan().key, {
        parameters: { prompt: 'project-asset://first' },
      }),
    ).toThrow('提交参数缺少');
    expect(() =>
      f.service.assertSource(requiredSource, target, wan().key, {
        parameters: { media: [{ type: 'reference_image', url: 'project-asset://first' }] },
      }),
    ).not.toThrow();
    f.service.execute({
      executionKey: 'optional-again',
      operations: [operation(target, f.service.read(target).rowVersion)],
    });
    const currentSource = f.service.read(target).source!;
    const videos = new VideoGenerationService(f.projects);
    const params = {
      adapterKey: wan().key,
      sceneId: f.scene.id,
      parameters: {
        prompt: '用户确认的文字',
        duration: 5,
        resolution: '720P',
        ratio: '16:9',
        audio: false,
      },
      providerRegion: 'cn' as const,
    };
    expect(() => videos.prepare(params)).toThrow('制作来源');
    expect(() => videos.prepare({ ...params, productionSource: original })).toThrow('制作来源');
    const prepared = videos.prepare({ ...params, productionSource: currentSource });
    const snapshot = f.projects.access(false, (db) =>
      db.prepare('SELECT task_snapshot_json FROM generation_jobs WHERE id=?').get(prepared.id),
    ) as { task_snapshot_json: string };
    expect(
      (JSON.parse(snapshot.task_snapshot_json) as { productionSource: ProductionSource })
        .productionSource,
    ).toEqual(currentSource);
    f.content.saveScene({
      sceneId: f.scene.id,
      title: f.scene.title,
      characterBindings: [{ characterDocumentId: f.actor.id, imageDisabled: true }],
      expectedRowVersion: f.service.read(target).rowVersion,
    });
    expect(() => f.service.assertSource(currentSource, target, wan().key)).toThrow('制作来源');
    expect(
      (JSON.parse(snapshot.task_snapshot_json) as { productionSource: ProductionSource })
        .productionSource,
    ).toEqual(currentSource);
  });
  it('validates RPC source shape and refuses execution without a current Agent call', async () => {
    const f = await setup();
    const target = { kind: 'scene' as const, id: f.scene.id };
    expect(() => validateSessionRequestParams('production.read', { target })).not.toThrow();
    expect(() =>
      validateSessionRequestParams('production.compile', {
        target,
        adapterKey: wan().key,
        paid: true,
      }),
    ).toThrow();
    const params = {
      adapterKey: wan().key,
      parameters: {},
      providerProfileId: 'p',
      modelId: 'm',
      providerRegion: 'cn',
      productionSource: { target, instructionId: 'i', revision: 1, token: 'pretend' },
    };
    expect(() => validateSessionRequestParams('video.generate.prepare', params)).toThrow();
    const conversation = f.content.createConversation({ scopeType: 'project', title: '制作' });
    const tools = new AgentSystemToolService(
      f.projects,
      f.content,
      {} as AgentAssetToolService,
      {} as AgentSettingsToolService,
    );
    const identity = {
      projectId: f.project.id,
      projectSessionId: f.projects.currentSessionId()!,
      conversationId: conversation.id,
    };
    expect(tools.execute('production.read', { target }, identity)).toMatchObject({
      target,
      rowVersion: f.scene.rowVersion,
    });
    expect(() =>
      tools.execute(
        'production.execute',
        { executionKey: 'not-running', operations: [operation(target, f.scene.rowVersion)] },
        identity,
      ),
    ).toThrow('正在执行');
    f.projects.access(true, (db, p) => {
      db.prepare(
        `INSERT INTO agent_tasks(id,project_id,project_session_id,conversation_id,task_type,scope_type,title,request_snapshot_json,request_hash,status,created_at,started_at,updated_at,phase,row_version,tool_call_limit) VALUES('task',?,?,?,'document-create','project','制作清单','{}','hash','running','now','now','now','model_running',0,16)`,
      ).run(p.id, identity.projectSessionId, conversation.id);
      db.prepare(
        `INSERT INTO agent_tool_calls(id,project_id,task_id,tool_name,arguments_summary_json,normalized_arguments_hash,status,created_at,idempotency_key,redaction_state) VALUES('call',?,'task','production.execute','{}','hash','executing','now','call-key','native')`,
      ).run(p.id);
    });
    expect(
      tools.execute(
        'production.execute',
        {
          executionKey: 'gateway',
          operations: [
            operation(target, f.scene.rowVersion),
            operation({ kind: 'character', id: f.actor.id }, f.actor.rowVersion),
            operation({ kind: 'setting', id: f.setting.id }, f.setting.rowVersion),
          ],
        },
        { ...identity, taskId: 'task', toolCallId: 'call' },
      ),
    ).toMatchObject({ status: 'applied' });
    const workflow = new DocumentWorkflowService(f.projects);
    const parent = workflow.getTask({ taskId: 'task' });
    expect(parent.documents).toHaveLength(2);
    const sourceTaskId = f.content.getDocument(f.actor.id).currentVersion?.sourceTaskId;
    expect(sourceTaskId).not.toBe('task');
    expect(workflow.getTask({ taskId: sourceTaskId! }).task.status).toBe('waiting_review');
    expect(workflow.getTask({ taskId: 'task' }).productionUpdated).toBeUndefined();
    f.projects.access(true, (db) =>
      db.prepare("UPDATE agent_tool_calls SET status='succeeded' WHERE id='call'").run(),
    );
    expect(workflow.getTask({ taskId: 'task' }).productionUpdated).toBe(true);
  });
});
