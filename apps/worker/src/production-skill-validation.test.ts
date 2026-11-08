import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentContextStore } from '@ai-video/persistence';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_AGENT_TOOL_DEFINITIONS } from './agent-tool-definitions.js';
import {
  requireScriptToMediaShotReferences,
  scriptToMediaCompletionPending,
} from './production-skill-validation.js';
import {
  assessTaskCompletion,
  assessTaskDeliverables,
  saveTaskPlan,
  assertTaskPartialAllowed,
} from './agent-task-deliverables.js';
import { taskCheckpoint } from './agent-task-checkpoints.js';
import { modelResultReceipt } from './agent-context-results.js';

const databases: Database.Database[] = [];
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function completionFixture(filename = ':memory:') {
  const db = new Database(filename);
  databases.push(db);
  db.exec(`CREATE TABLE agent_tasks(id TEXT,request_snapshot_json TEXT,status TEXT DEFAULT 'running',phase TEXT DEFAULT 'model_running');
    CREATE TABLE agent_execution_outputs(id TEXT PRIMARY KEY,project_id TEXT,task_id TEXT,plan_key TEXT,tool_name TEXT,quantity INTEGER,created_at TEXT,UNIQUE(project_id,task_id,plan_key));
    CREATE TABLE agent_execution_commits(project_id TEXT,task_id TEXT,operation_key TEXT,receipt_id TEXT,sequence INTEGER);
    CREATE TABLE agent_write_receipts(id TEXT,result_json TEXT);
    CREATE TABLE agent_task_generations(task_id TEXT,generation_id TEXT,ordinal INTEGER);
    CREATE TABLE llm_generations(id TEXT,project_id TEXT,conversation_id TEXT,status TEXT);
    INSERT INTO agent_task_generations VALUES('task','generation',1);
    INSERT INTO llm_generations VALUES('generation','project','conversation','streaming');
    CREATE TABLE agent_tool_calls(project_id TEXT,generation_id TEXT,tool_name TEXT,status TEXT,result_summary_json TEXT);
    CREATE TABLE documents(id TEXT,project_id TEXT,current_version_id TEXT,lifecycle_status TEXT,updated_at TEXT,title TEXT,kind TEXT);
    CREATE TABLE document_versions(id TEXT,document_id TEXT,content_markdown TEXT);
    CREATE TABLE scenes(id TEXT,project_id TEXT,archived_at TEXT);
    CREATE TABLE shots(id TEXT,scene_id TEXT,authoring_ir_json TEXT,updated_at TEXT,archived_at TEXT);
    CREATE TABLE agent_context_results(id TEXT PRIMARY KEY,project_id TEXT,task_id TEXT,call_id TEXT,tool_name TEXT,status TEXT,version INTEGER,content TEXT,content_hash TEXT,arguments_json TEXT,created_at TEXT,UNIQUE(project_id,task_id,call_id,content_hash));
    CREATE TABLE agent_context_tasks(project_id TEXT,task_id TEXT,state_json TEXT,runtime_json TEXT);
    CREATE TABLE agent_context_checkpoints(project_id TEXT,task_id TEXT,revision INTEGER,state_json TEXT,runtime_json TEXT);`);
  db.prepare('INSERT INTO agent_tasks(id,request_snapshot_json) VALUES (?,?)').run(
    'task',
    JSON.stringify({ productionSkillId: 'script-to-media' }),
  );
  const receipt = (tool: string, result: unknown) =>
    db
      .prepare('INSERT INTO agent_tool_calls VALUES (?,?,?,?,?)')
      .run('project', 'generation', tool, 'succeeded', JSON.stringify(result));
  const read = (
    result: unknown,
    options: { taskId?: string; status?: string; at?: string; tool?: string } = {},
  ) => {
    const saved = new AgentContextStore(db).putResult(
      'project',
      options.taskId ?? 'task',
      crypto.randomUUID(),
      options.tool ?? 'production.read',
      JSON.stringify(result),
      {},
      options.status ?? 'completed',
    );
    db.prepare('UPDATE agent_context_results SET created_at=? WHERE id=?').run(
      options.at ?? '2026-11-06T03:00:01.000Z',
      saved.id,
    );
    return saved;
  };
  const prompt = '0–3秒：人物停步，说“等一下”。3–5秒：收好信件。对白中的双引号测试："好"。';
  const ir = {
    schemaVersion: 1,
    kind: 'shot',
    prompt,
    references: { characterDocumentIds: ['character'], sceneDocumentIds: [], propDocumentIds: [] },
    timing: {
      estimatedDurationSeconds: 5,
      rationale: '对白与收信的自然速度',
      beats: [
        { kind: 'dialogue', startSeconds: 0, endSeconds: 3, description: '停步对白' },
        { kind: 'action', startSeconds: 3, endSeconds: 5, description: '收信' },
      ],
    },
  };
  const seed = () => {
    db.prepare("INSERT INTO documents VALUES (?,?,?,'active',?,?,?)").run(
      'source',
      'project',
      'source-v1',
      '2026-11-06T02:00:00.000Z',
      '原文',
      'note',
    );
    db.prepare('INSERT INTO document_versions VALUES (?,?,?)').run(
      'source-v1',
      'source',
      '人物收信后将其托付给来人。',
    );
    read(
      { sourceId: 'source', versionId: 'source-v1', content: '人物收信后将其托付给来人。' },
      { tool: 'library.read' },
    );
    db.prepare('INSERT INTO scenes VALUES (?,?,NULL)').run('scene', 'project');
    db.prepare('INSERT INTO shots VALUES (?,?,?,?,NULL)').run(
      'shot',
      'scene',
      JSON.stringify(ir),
      '2026-11-06T03:00:00.000Z',
    );
    db.prepare("INSERT INTO documents VALUES (?,?,?,'active',?,?,?)").run(
      'character',
      'project',
      'v1',
      '2026-11-06T03:00:00.000Z',
      '完整角色设定板',
      'character',
    );
    db.prepare('INSERT INTO document_versions VALUES (?,?,?)').run(
      'v1',
      'character',
      '完整角色设定板提示词正文',
    );
    receipt('scene.structure.stage', {
      status: 'scene_structure_saved',
      sceneIds: ['scene'],
      shotIds: ['shot'],
    });
  };
  const readDocument = () =>
    read(
      { sourceId: 'character', versionId: 'v1', content: '完整角色设定板提示词正文' },
      { tool: 'library.read' },
    );
  const pending = () => scriptToMediaCompletionPending(db, 'project', 'generation', 'task');
  const plan = (deliverables: unknown[]) => {
    const value = saveTaskPlan(db, 'project', 'generation', deliverables, 'task');
    receipt('conversation.task.checkpoint', value);
    return value;
  };
  const submit = (args: Record<string, unknown>) =>
    taskCheckpoint(db, 'project', args, {
      projectId: 'project',
      projectSessionId: 'session',
      conversationId: 'conversation',
      taskId: 'task',
      toolCallId: crypto.randomUUID(),
    });
  const reviewState = () =>
    pending()?.[0]?.semanticReview as {
      reviewId: string;
      ready: boolean;
      issues: Array<{ issueId: string; targetId: string; targetVersion: string }>;
      reviewScope: string[];
    };
  const evidence = [{ referenceId: 'source', quote: '人物收信后将其托付给来人。' }];
  const issue = (description = '托付动作缺失', targetId = 'shot') => ({
    targetId,
    category: 'content',
    description,
    evidence,
  });
  const record = (args: Record<string, unknown>) => {
    const result = submit({
      operation: 'review',
      reviewId: reviewState().reviewId,
      reviewedTargetIds: reviewState().reviewScope,
      ...args,
    });
    read(result, { tool: 'conversation.task.checkpoint' });
    return result;
  };
  const review = (conclusion = 'passed', issues: string[] = []) => {
    expect(reviewState().ready).toBe(true);
    return record({
      conclusion,
      issues: issues.map((description) => issue(description)),
      summary: '已比较来源、对白与动作',
      ...(conclusion === 'passed'
        ? {
            resolutions: reviewState().issues.map((i) => ({
              issueId: i.issueId,
              disposition: 'resolved',
              reason: '修订目标后重新核对原文',
              evidence: [{ referenceId: 'shot', quote: '托付信件。' }],
            })),
          }
        : {}),
    });
  };
  return {
    db,
    receipt,
    read,
    seed,
    ir,
    readDocument,
    pending,
    plan,
    review,
    submit,
    reviewState,
    evidence,
    issue,
    record,
  };
}

describe('durable task contracts', () => {
  it('rechecks persisted dialogue after approval and database reopen rather than trusting the old passed review', () => {
    const directory = mkdtempSync(join(tmpdir(), 'p22-dialogue-completion-'));
    directories.push(directory);
    const filename = join(directory, 'project.sqlite');
    const f = completionFixture(filename);
    f.seed();
    const text = '你把事故数据调进来了？';
    const source = '- 邵闻：“' + text + '”';
    f.db.prepare('INSERT INTO document_versions VALUES (?,?,?)').run('source-v2', 'source', source);
    f.db.prepare("UPDATE documents SET current_version_id='source-v2' WHERE id='source'").run();
    f.read(
      { sourceId: 'source', versionId: 'source-v2', content: source },
      { tool: 'library.read' },
    );
    const authoring = { ...f.ir, prompt: '邵闻：“' + text + '”' };
    f.db
      .prepare('UPDATE shots SET authoring_ir_json=? WHERE id=?')
      .run(JSON.stringify(authoring), 'shot');
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring });
    f.review();
    expect(assessTaskCompletion(f.db, 'project', 'generation', 'task')?.pending).toEqual([]);

    f.db
      .prepare('INSERT INTO shots VALUES (?,?,?,?,NULL)')
      .run('shot-2', 'scene', JSON.stringify(authoring), '2026-11-06T03:00:00.000Z');
    f.read({ target: { kind: 'shot', id: 'shot-2' }, authoring });
    const reopened = new Database(filename);
    databases.push(reopened);
    const pending = assessTaskCompletion(reopened, 'project', 'generation', 'task')?.pending;
    expect(pending).toMatchObject([
      {
        duplicateDialogue: [{ text, allowedOccurrences: 1, shotIds: ['shot', 'shot-2'] }],
        nextAction: { kind: 'repair_outputs', targetIds: ['shot', 'shot-2'] },
        semanticReview: { ready: false, approved: false },
      },
    ]);
    expect(() => assertTaskPartialAllowed({ pending: pending! })).toThrow('TASK_REPAIR_REQUIRED');
    expect(() =>
      taskCheckpoint(
        reopened,
        'project',
        {
          operation: 'review',
          reviewId: (pending![0]!.semanticReview as { reviewId: string }).reviewId,
          reviewedTargetIds: ['character', 'shot', 'shot-2'],
          conclusion: 'passed',
          summary: '仍然通过',
          issues: [],
        },
        {
          projectId: 'project',
          projectSessionId: 'session',
          conversationId: 'conversation',
          taskId: 'task',
          toolCallId: crypto.randomUUID(),
        },
      ),
    ).toThrow('TASK_REVIEW_NOT_READY');
  });

  it('blocks repeated source dialogue across saved shots until repaired in place', () => {
    const f = completionFixture();
    f.seed();
    f.db.exec('ALTER TABLE shots ADD COLUMN position INTEGER');
    f.db.prepare("UPDATE shots SET position=0 WHERE id='shot'").run();
    const once = '你把事故数据调进来了？';
    const twice = '会。';
    const source = '- 邵闻：“' + once + '”\n- 林澄：“' + twice + '”\n- 林澄：“' + twice + '”';
    f.db.prepare('INSERT INTO document_versions VALUES (?,?,?)').run('source-v2', 'source', source);
    f.db.prepare("UPDATE documents SET current_version_id='source-v2' WHERE id='source'").run();
    f.read(
      { sourceId: 'source', versionId: 'source-v2', content: source },
      { tool: 'library.read' },
    );
    const first = { ...f.ir, prompt: '邵闻：“' + once + '”林澄：“' + twice + '”' };
    const second = { ...f.ir, prompt: '邵闻：“' + once + '”林澄：“' + twice + '”' };
    f.db
      .prepare('UPDATE shots SET authoring_ir_json=? WHERE id=?')
      .run(JSON.stringify(first), 'shot');
    f.db
      .prepare('INSERT INTO shots VALUES (?,?,?,?,NULL,?)')
      .run('shot-2', 'scene', JSON.stringify(second), '2026-11-06T03:00:00.000Z', 1);
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: first });
    f.read({ target: { kind: 'shot', id: 'shot-2' }, authoring: second });
    expect(f.pending()?.[0]).toMatchObject({
      duplicateDialogue: [{ text: once, allowedOccurrences: 1, shotIds: ['shot', 'shot-2'] }],
      nextAction: { kind: 'repair_outputs' },
    });
    expect(f.reviewState().ready).toBe(false);
    expect(() =>
      f.submit({
        operation: 'review',
        reviewId: f.reviewState().reviewId,
        reviewedTargetIds: f.reviewState().reviewScope,
        conclusion: 'passed',
        summary: '内容通过',
        issues: [],
      }),
    ).toThrow('TASK_REVIEW_NOT_READY');

    const repaired = {
      ...second,
      prompt: '林澄继续分析并答：“' + twice + '”本镜不得重复上一镜台词：“' + once + '”',
    };
    f.db
      .prepare(
        "UPDATE shots SET authoring_ir_json=?,updated_at='2026-11-06T03:00:04.000Z' WHERE id='shot-2'",
      )
      .run(JSON.stringify(repaired));
    f.read(
      { target: { kind: 'shot', id: 'shot-2' }, authoring: repaired },
      { at: '2026-11-06T03:00:05.000Z' },
    );
    expect(f.pending()?.[0]?.duplicateDialogue).toBeUndefined();
    expect(f.reviewState().ready).toBe(true);
  });

  it('verifies reusable existing outputs without inventing a write or a creation binding', () => {
    const f = completionFixture();
    f.seed();
    const item = {
      key: 'episode',
      toolName: 'scene.update_shot_prompts',
      intent: 'reuse',
      origin: 'model_inference',
      minimumCount: 1,
      targetIds: ['shot'],
    };
    const saved = f.plan([item]);
    expect(saved.outputBindings).toEqual([]);
    expect(assessTaskDeliverables(f.db, 'project', 'generation', 'task')?.pending[0]).toMatchObject(
      { persistedCount: 1, nextAction: { kind: 'read_outputs' } },
    );
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    expect(assessTaskDeliverables(f.db, 'project', 'generation', 'task')?.pending).toEqual([]);
    f.db.prepare("UPDATE shots SET updated_at='2026-11-06T04:00:00.000Z' WHERE id='shot'").run();
    expect(assessTaskDeliverables(f.db, 'project', 'generation', 'task')?.pending).toHaveLength(1);
  });
  it('does not treat current reads as proof of a requested revision', () => {
    const f = completionFixture();
    f.seed();
    f.plan([
      {
        key: 'edit',
        toolName: 'scene.update_shot_prompts',
        intent: 'revise',
        minimumCount: 1,
        targetIds: ['shot'],
      },
    ]);
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    expect(assessTaskDeliverables(f.db, 'project', 'generation', 'task')?.pending).toHaveLength(1);
    const revised = { ...f.ir, prompt: '原位修改后的完整镜头' };
    f.db
      .prepare(
        "UPDATE shots SET authoring_ir_json=?,updated_at='2026-11-06T04:00:00.000Z' WHERE id='shot'",
      )
      .run(JSON.stringify(revised));
    f.receipt('scene.update_shot_prompts', {
      status: 'shot_prompts_saved',
      shots: [{ shotId: 'shot' }],
    });
    expect(assessTaskDeliverables(f.db, 'project', 'generation', 'task')?.pending).toHaveLength(1);
    f.read(
      { target: { kind: 'shot', id: 'shot' }, authoring: revised },
      { at: '2026-11-06T04:00:01.000Z' },
    );
    expect(assessTaskDeliverables(f.db, 'project', 'generation', 'task')?.pending).toEqual([]);
  });
  it('takes all eleven targets from the contract even if only one has been read', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    const ids = ['shot'];
    for (let n = 2; n <= 11; n++) {
      const id = `shot-${n}`;
      ids.push(id);
      f.db
        .prepare('INSERT INTO shots VALUES(?,?,?,?,NULL)')
        .run(
          id,
          'scene',
          JSON.stringify({ ...f.ir, prompt: `镜头 ${n}` }),
          '2026-11-06T03:00:00.000Z',
        );
    }
    f.db.prepare("DELETE FROM agent_tool_calls WHERE tool_name='scene.structure.stage'").run();
    f.plan([
      {
        key: 'all-shots',
        toolName: 'scene.update_shot_prompts',
        intent: 'verify',
        minimumCount: 11,
        targetIds: ids,
      },
    ]);
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    const check = f.pending()![0]!;
    expect(check.semanticReview).toMatchObject({ ready: false });
    expect((check.semanticReview as { reviewScope: string[] }).reviewScope).toEqual(
      expect.arrayContaining(ids),
    );
    expect(check.unreviewedArtifacts).toHaveLength(10);
  });
  it('allows source-based correction of model assumptions but protects user text', () => {
    const f = completionFixture();
    f.seed();
    const item = {
      key: 'model',
      toolName: 'scene.update_shot_prompts',
      origin: 'model_inference',
      minimumCount: 1,
      targetIds: ['shot'],
      requiredTexts: ['错误推断：每镜40分钟'],
    };
    f.plan([item]);
    expect(() =>
      f.plan([
        { ...item, requiredTexts: undefined, revisionReason: '原始用户没有要求逐字写入这个时长' },
      ]),
    ).not.toThrow();
    expect(
      f.db
        .prepare(
          "SELECT count(*) n FROM agent_tool_calls WHERE tool_name='conversation.task.checkpoint'",
        )
        .get(),
    ).toEqual({ n: 2 });
  });
  it('preserves user obligations and rejects dependency cycles and forged requirement sources', () => {
    const f = completionFixture();
    f.seed();
    const store = new AgentContextStore(f.db);
    f.db
      .prepare('INSERT INTO agent_context_tasks(project_id,task_id,state_json) VALUES(?,?,?)')
      .run(
        'project',
        'task',
        JSON.stringify({
          taskId: 'task',
          taskGoal: '保留对白',
          userRequirements: [{ id: 'original', text: '保留对白', source: 'user' }],
          projectConstraints: [],
          confirmedDecisions: [],
          currentStage: 'initial',
          completedSteps: [],
          pendingSteps: [],
          executionStatus: 'running',
          generatedArtifacts: [],
        }),
      );
    expect(store.loadTask('project', 'task')).toBeDefined();
    const item = {
      key: 'user',
      toolName: 'scene.update_shot_prompts',
      intent: 'verify',
      origin: 'user_requirement',
      sourceRequirementIds: ['original'],
      minimumCount: 1,
      targetIds: ['shot'],
      requiredTexts: ['保留对白'],
    };
    f.plan([item]);
    expect(() =>
      f.plan([{ ...item, requiredTexts: undefined, revisionReason: '模型想简化' }]),
    ).toThrow('Cannot weaken');
    expect(() => f.plan([{ ...item, origin: 'model_inference', revisionReason: '假设' }])).toThrow(
      'user obligations',
    );
    expect(() => f.plan([{ ...item, sourceRequirementIds: ['forged'] }])).toThrow('persisted user');
    expect(() =>
      f.plan([
        { key: 'a', toolName: 'document.submit_draft', minimumCount: 1, dependsOn: ['b'] },
        { key: 'b', toolName: 'document.submit_draft', minimumCount: 1, dependsOn: ['a'] },
      ]),
    ).toThrow('acyclic');
  });
});

describe('Worker-owned review lifecycle', () => {
  const ready = () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    return f;
  };
  it('invalidates dependent shots after a saved plan changes while retaining unrelated material coverage', () => {
    const f = ready();
    f.db
      .prepare(
        "INSERT INTO documents VALUES('plan','project','plan-v1','active','2026-11-06T02:00:00.000Z','分镜计划','plan')",
      )
      .run();
    f.db.prepare("INSERT INTO document_versions VALUES('plan-v1','plan','初版分镜')").run();
    f.receipt('document.submit_draft', {
      status: 'draft_saved',
      documentId: 'plan',
      documentVersionId: 'plan-v1',
    });
    f.read(
      { sourceId: 'plan', versionId: 'plan-v1', content: '初版分镜' },
      { tool: 'library.read' },
    );
    f.review();
    expect(f.pending()).toEqual([]);
    f.db
      .prepare(
        "UPDATE documents SET current_version_id='plan-v2',updated_at='2026-11-06T04:00:00.000Z' WHERE id='plan'",
      )
      .run();
    f.db.prepare("INSERT INTO document_versions VALUES('plan-v2','plan','修订对白顺序')").run();
    f.read(
      { sourceId: 'plan', versionId: 'plan-v2', content: '修订对白顺序' },
      { tool: 'library.read', at: '2026-11-06T04:00:01.000Z' },
    );
    expect(f.reviewState().reviewScope.sort()).toEqual(['plan', 'shot']);
    expect(f.reviewState().ready).toBe(true);
  });
  it('invalidates the changed shot and its immediate continuity neighbours only', () => {
    const f = completionFixture();
    f.seed();
    f.db.exec('ALTER TABLE shots ADD COLUMN position INTEGER NOT NULL DEFAULT 0');
    const ids = ['shot', 'shot-2', 'shot-3', 'shot-4'];
    for (let n = 1; n < ids.length; n++) {
      f.db
        .prepare('INSERT INTO shots VALUES(?,?,?,?,NULL,?)')
        .run(
          ids[n],
          'scene',
          JSON.stringify({ ...f.ir, prompt: `第${n + 1}镜内容` }),
          '2026-11-06T03:00:00.000Z',
          n,
        );
    }
    f.plan([
      {
        key: 'episode',
        toolName: 'scene.update_shot_prompts',
        intent: 'verify',
        minimumCount: ids.length,
        targetIds: ids,
      },
    ]);
    f.readDocument();
    for (const [n, id] of ids.entries())
      f.read({
        target: { kind: 'shot', id },
        authoring: n ? { ...f.ir, prompt: `第${n + 1}镜内容` } : f.ir,
      });
    f.review();
    expect(f.pending()).toEqual([]);
    const revised = { ...f.ir, prompt: '第2镜：修改人物出画方向' };
    f.db
      .prepare('UPDATE shots SET authoring_ir_json=?,updated_at=? WHERE id=?')
      .run(JSON.stringify(revised), '2026-11-06T04:00:00.000Z', 'shot-2');
    f.read(
      { target: { kind: 'shot', id: 'shot-2' }, authoring: revised },
      {
        at: '2026-11-06T04:00:01.000Z',
      },
    );
    expect(f.reviewState().ready).toBe(true);
    expect(f.reviewState().reviewScope.sort()).toEqual(['shot', 'shot-2', 'shot-3']);
  });
  it('invalidates task plan approval after a shot changes while preserving independent material', () => {
    const f = ready();
    f.db
      .prepare(
        "INSERT INTO documents VALUES('plan','project','plan-v1','active','2026-11-06T02:00:00.000Z','完整提示词','plan')",
      )
      .run();
    f.db.prepare("INSERT INTO document_versions VALUES('plan-v1','plan','旧分镜提示词')").run();
    f.receipt('document.submit_draft', {
      status: 'draft_saved',
      documentId: 'plan',
      documentVersionId: 'plan-v1',
    });
    f.read(
      { sourceId: 'plan', versionId: 'plan-v1', content: '旧分镜提示词' },
      { tool: 'library.read' },
    );
    f.review();
    expect(f.pending()).toEqual([]);
    const revised = { ...f.ir, prompt: '人物后退半步，再托付信件。' };
    f.db
      .prepare(
        "UPDATE shots SET authoring_ir_json=?,updated_at='2026-11-06T04:00:00.000Z' WHERE id='shot'",
      )
      .run(JSON.stringify(revised));
    f.read(
      { target: { kind: 'shot', id: 'shot' }, authoring: revised },
      { at: '2026-11-06T04:00:01.000Z' },
    );
    expect(f.reviewState().reviewScope.sort()).toEqual(['plan', 'shot']);
    expect(
      f.db.prepare("SELECT content_markdown FROM document_versions WHERE id='plan-v1'").get(),
    ).toEqual({ content_markdown: '旧分镜提示词' });
  });
  it('persists an opaque snapshot once and separates missing reads from content issues', () => {
    const f = completionFixture();
    f.seed();
    const initial = f.reviewState();
    expect(initial.reviewId).toBeTypeOf('string');
    expect(initial.ready).toBe(false);
    expect(() =>
      f.submit({
        operation: 'review',
        reviewId: initial.reviewId,
        conclusion: 'passed',
        summary: '核对',
        issues: [],
      }),
    ).toThrow('TASK_REVIEW_NOT_READY');
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    expect(f.reviewState().reviewId).toBe(initial.reviewId);
    expect(f.reviewState().issues).toEqual([]);
    expect(
      f.db
        .prepare(
          "SELECT count(*) n FROM agent_context_results WHERE tool_name='task.review.snapshot'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(new AgentContextStore(f.db).result('project', 'task', initial.reviewId)).toBeDefined();
  });
  it('does not clear a shot issue when another artifact changes', () => {
    const f = ready();
    f.record({ conclusion: 'needs_revision', summary: '待修订', issues: [f.issue()] });
    const issueId = f.reviewState().issues[0]!.issueId;
    f.db
      .prepare("UPDATE documents SET updated_at='2026-11-06T03:00:02.000Z' WHERE id='character'")
      .run();
    f.read(
      { sourceId: 'character', versionId: 'v1', content: '完整角色设定板提示词正文' },
      { tool: 'library.read', at: '2026-11-06T03:00:03.000Z' },
    );
    expect(f.reviewState().issues[0]!.issueId).toBe(issueId);
    expect(() => f.record({ conclusion: 'passed', summary: '核对', issues: [] })).toThrow(
      'TASK_REVIEW_UNRESOLVED',
    );
    expect(() =>
      f.record({
        conclusion: 'passed',
        summary: '核对',
        issues: [],
        resolutions: [
          { issueId, disposition: 'resolved', reason: '改过其他文档', evidence: f.evidence },
        ],
      }),
    ).toThrow('TARGET_UNCHANGED');
  });
  it('never approves targets omitted from an explicitly partial assessment', () => {
    const f = ready();
    f.record({
      reviewedTargetIds: ['shot'],
      conclusion: 'passed',
      summary: '仅核对该镜，人物资料尚未评估',
      issues: [],
    });
    expect(f.reviewState().reviewScope).toEqual(['character']);
    expect(f.pending()).not.toEqual([]);
    f.record({
      reviewedTargetIds: ['character'],
      conclusion: 'passed',
      summary: '完成剩余人物资料核对',
      issues: [],
    });
    expect(f.pending()).toEqual([]);
  });
  it('rejects implicit, duplicate, foreign and out-of-scope assessment coverage', () => {
    const f = ready();
    const args = {
      operation: 'review',
      reviewId: f.reviewState().reviewId,
      conclusion: 'passed',
      summary: '评估范围必须明确',
      issues: [],
    };
    for (const reviewedTargetIds of [undefined, [], ['shot', 'shot'], ['source'], ['other-task']])
      expect(() => f.submit({ ...args, reviewedTargetIds })).toThrow('TASK_REVIEW_SCOPE_INVALID');
    expect(() =>
      f.record({
        ...args,
        reviewedTargetIds: ['character'],
        conclusion: 'needs_revision',
        issues: [f.issue()],
      }),
    ).toThrow('TASK_REVIEW_TARGET_INVALID');
    expect(f.reviewState().reviewScope).toEqual(['character', 'shot']);
    f.record({
      reviewedTargetIds: ['shot'],
      conclusion: 'needs_revision',
      summary: '登记待复核问题',
      issues: [f.issue()],
    });
    expect(() =>
      f.record({
        reviewedTargetIds: ['character'],
        conclusion: 'passed',
        summary: '不能跨范围关闭问题',
        issues: [],
        resolutions: [
          {
            issueId: f.reviewState().issues[0]!.issueId,
            disposition: 'withdrawn',
            reason: '尚未复核该镜',
            evidence: f.evidence,
          },
        ],
      }),
    ).toThrow('TASK_REVIEW_SCOPE_INVALID');
  });
  it('preserves v2 findings and resolutions but never trusts its inferred coverage', () => {
    const f = ready();
    const event = f.submit({
      operation: 'review',
      reviewId: f.reviewState().reviewId,
      reviewedTargetIds: f.reviewState().reviewScope,
      conclusion: 'needs_revision',
      summary: '旧版仅发现一镜',
      issues: [f.issue()],
    });
    f.read(
      { ...event, protocolVersion: 2, reviewedTargetIds: undefined },
      {
        tool: 'conversation.task.checkpoint',
      },
    );
    expect(f.reviewState().issues).toHaveLength(1);
    expect(f.reviewState().reviewScope).toEqual(['character', 'shot']);
    f.record({
      reviewedTargetIds: ['shot'],
      conclusion: 'passed',
      summary: '仅撤回旧误报',
      issues: [],
      resolutions: [
        {
          issueId: f.reviewState().issues[0]!.issueId,
          disposition: 'withdrawn',
          reason: '明确重评原文',
          evidence: f.evidence,
        },
      ],
    });
    expect(f.reviewState().issues).toEqual([]);
    expect(f.reviewState().reviewScope).toEqual(['character']);
  });
  it('withdraws a documented false positive without editing business content and keeps the audit', () => {
    const f = ready();
    f.record({
      conclusion: 'needs_revision',
      summary: '待核对',
      issues: [f.issue('误将刷新版本视为正文问题')],
    });
    const issueId = f.reviewState().issues[0]!.issueId;
    const saved = f.db.prepare('SELECT authoring_ir_json FROM shots').get();
    expect(() =>
      f.record({
        conclusion: 'passed',
        summary: '撤回',
        issues: [],
        resolutions: [{ issueId, disposition: 'withdrawn', reason: '', evidence: [] }],
      }),
    ).toThrow();
    f.record({
      conclusion: 'passed',
      summary: '复核确认是流程误报',
      issues: [],
      resolutions: [
        {
          issueId,
          disposition: 'withdrawn',
          reason: '原文无该内容缺陷，版本就绪由Worker校验',
          evidence: f.evidence,
        },
      ],
    });
    expect(f.pending()).toEqual([]);
    expect(f.db.prepare('SELECT authoring_ir_json FROM shots').get()).toEqual(saved);
    expect(
      f.db
        .prepare(
          "SELECT count(*) n FROM agent_context_results WHERE json_extract(content,'$.conclusion')='needs_revision'",
        )
        .get(),
    ).toEqual({ n: 1 });
  });
  it('rejects non-content issues and foreign targets before recording findings', () => {
    const f = ready();
    for (const issue of [
      f.issue('不存在', 'elsewhere'),
      { ...f.issue(), category: 'refresh_version' },
    ]) {
      expect(() =>
        f.record({ conclusion: 'needs_revision', summary: '待修订', issues: [issue] }),
      ).toThrow();
    }
  });
  it('durably retains each evidence correction without confirming a defect or accepting empty approval', () => {
    const f = ready();
    const event = f.record({
      conclusion: 'needs_revision',
      summary: '分别核实发现，不能因为其中一条引用错误就丢弃整份报告',
      issues: [
        f.issue('角色正文待核实', 'character'),
        { ...f.issue(), evidence: [{ referenceId: 'invented-result-id', quote: '原文' }] },
      ],
    });
    expect(event).toMatchObject({
      conclusion: 'needs_revision',
      issues: [
        { evidenceStatus: 'verified' },
        {
          evidenceStatus: 'needs_correction',
          evidenceError: expect.stringContaining('referenceId') as unknown,
        },
      ],
    });
    const state = f.reviewState();
    expect(state.issues).toHaveLength(2);
    expect(() => f.record({ conclusion: 'passed', summary: '直接通过', issues: [] })).toThrow(
      'TASK_REVIEW_UNRESOLVED',
    );
    const issueId = state.issues.find((i) => i.targetId === 'shot')!.issueId;
    expect(() =>
      f.record({
        conclusion: 'needs_revision',
        summary: '不能同时更正和结案',
        issues: [{ ...f.issue(), issueId }],
        resolutions: [
          {
            issueId,
            disposition: 'withdrawn',
            reason: '矛盾的结案',
            evidence: [{ referenceId: 'shot', quote: '人物停步' }],
          },
        ],
      }),
    ).toThrow('TASK_REVIEW_ISSUE_INVALID');
    expect(() =>
      f.record({
        conclusion: 'needs_revision',
        summary: '不能改写其他发现',
        issues: [{ ...f.issue(), issueId: 'other-task-issue' }],
      }),
    ).toThrow('TASK_REVIEW_ISSUE_INVALID');
    f.record({
      conclusion: 'needs_revision',
      summary: '使用当前快照引用纠正同一发现，不新增问题',
      issues: [{ ...f.issue(), issueId }],
    });
    expect(f.reviewState().issues).toHaveLength(2);
    expect(f.reviewState().issues.find((i) => i.issueId === issueId)).toMatchObject({
      evidenceStatus: 'verified',
      evidence: f.evidence.map((e) => ({ ...e, version: 'source-v1' })),
    });
    expect(() =>
      f.record({
        conclusion: 'needs_revision',
        summary: '不能覆盖已验证发现',
        issues: [
          { ...f.issue(), issueId, evidence: [{ referenceId: 'invented-id', quote: '伪造' }] },
        ],
      }),
    ).toThrow('TASK_REVIEW_ISSUE_INVALID');
  });
  it('allows evidence-backed withdrawal of unverified findings without rewriting valid output', () => {
    const f = ready();
    const original = f.db.prepare('SELECT authoring_ir_json FROM shots').get();
    const args = {
      operation: 'review',
      reviewId: f.reviewState().reviewId,
      reviewedTargetIds: f.reviewState().reviewScope,
      conclusion: 'needs_revision',
      summary: '引用待更正',
      issues: [{ ...f.issue(), evidence: [{ referenceId: 'shot', quote: '不存在的正文' }] }],
    };
    const event = f.record(args);
    f.record(args);
    expect(f.reviewState().issues).toHaveLength(1);
    const issueId = f.reviewState().issues[0]!.issueId;
    const stored = f.read(event, { tool: 'conversation.task.checkpoint' });
    const wire = JSON.parse(modelResultReceipt(stored, 1)) as Record<string, unknown>;
    expect(wire.issues).toMatchObject([
      { issueId, evidenceStatus: 'needs_correction', evidenceError: expect.any(String) as unknown },
    ]);
    f.record({
      conclusion: 'passed',
      summary: '当前正文与原文不支持该发现',
      issues: [],
      resolutions: [
        {
          issueId,
          disposition: 'withdrawn',
          reason: '复核后确认误报',
          evidence: [{ referenceId: 'shot', quote: '人物停步' }],
        },
      ],
    });
    expect(f.pending()).toEqual([]);
    expect(f.submit(args)).toEqual(event);
    expect(f.db.prepare('SELECT authoring_ir_json FROM shots').get()).toEqual(original);
  });
  it('never confirms an unknown, cross-project, superseded or nonexistent evidence quote', () => {
    for (const referenceId of ['invented-id', 'foreign-document', 'source-v1', 'source']) {
      const f = ready();
      f.db
        .prepare(
          "INSERT INTO documents VALUES('foreign-document','other-project','foreign-v1','active','2026-11-06T03:00:00.000Z','他人资料','note')",
        )
        .run();
      f.db
        .prepare(
          "INSERT INTO document_versions VALUES('foreign-v1','foreign-document','不在当前正文中的旧句子')",
        )
        .run();
      f.db
        .prepare(
          "INSERT INTO document_versions VALUES('source-v0','source','不在当前正文中的旧句子')",
        )
        .run();
      f.record({
        conclusion: 'needs_revision',
        summary: '无效证据只形成待纠正项',
        issues: [{ ...f.issue(), evidence: [{ referenceId, quote: '不在当前正文中的旧句子' }] }],
      });
      expect(f.reviewState().issues).toMatchObject([{ evidenceStatus: 'needs_correction' }]);
      expect(() => f.record({ conclusion: 'passed', summary: '跳过', issues: [] })).toThrow(
        'UNRESOLVED',
      );
    }
  });
  it('restores pre-fix citation failures as unverified findings despite a later empty passed report', () => {
    const f = ready();
    const snapshot = f.reviewState();
    const args = {
      operation: 'review',
      reviewId: snapshot.reviewId,
      reviewedTargetIds: snapshot.reviewScope,
      conclusion: 'needs_revision',
      summary: '旧报告引用失败',
      issues: [{ ...f.issue(), evidence: [{ referenceId: 'invented-id', quote: '旧引文' }] }],
    };
    new AgentContextStore(f.db).putResult(
      'project',
      'task',
      'old-failed-review',
      'conversation.task.checkpoint',
      JSON.stringify({ error: { message: 'TASK_REVIEW_EVIDENCE_INVALID: old failure' } }),
      args,
      'failed',
    );
    f.read(
      {
        status: 'task_review_recorded',
        protocolVersion: 3,
        assessmentId: 'old-empty-pass',
        reviewId: snapshot.reviewId,
        conclusion: 'passed',
        summary: '旧实现漏审',
        issues: [],
        resolutions: [],
        reviewedTargetIds: snapshot.reviewScope,
        coverage: [],
      },
      { tool: 'conversation.task.checkpoint' },
    );
    expect(f.reviewState().issues).toMatchObject([
      { targetId: 'shot', evidenceStatus: 'needs_correction' },
    ]);
    expect(() => f.record({ conclusion: 'passed', summary: '不能跳过', issues: [] })).toThrow(
      'UNRESOLVED',
    );
    f.record({
      conclusion: 'needs_revision',
      summary: '更正当前证据',
      issues: [{ ...f.issue(), issueId: f.reviewState().issues[0]!.issueId }],
    });
    expect(f.reviewState().issues).toMatchObject([{ evidenceStatus: 'verified' }]);
  });
  it('requires explicit target repair and reviews only affected targets after a partial resolution', () => {
    const f = ready();
    f.record({
      conclusion: 'needs_revision',
      summary: '两项内容问题',
      issues: [f.issue(), f.issue('人物资料遗漏托付动作', 'character')],
    });
    const issues = f.reviewState().issues;
    f.db
      .prepare('UPDATE shots SET authoring_ir_json=?,updated_at=?')
      .run(
        JSON.stringify({ ...f.ir, prompt: f.ir.prompt + '托付信件。' }),
        '2026-11-06T03:00:02.000Z',
      );
    expect(() =>
      f.record({
        conclusion: 'needs_revision',
        summary: '已修订',
        issues: [],
        resolutions: [
          {
            issueId: issues[0]!.issueId,
            disposition: 'resolved',
            reason: '已修订托付',
            evidence: f.evidence,
          },
        ],
      }),
    ).toThrow('TASK_REVIEW_NOT_READY');
    f.read(
      { target: { kind: 'shot', id: 'shot' }, text: f.ir.prompt + '托付信件。' },
      { at: '2026-11-06T03:00:03.000Z' },
    );
    expect(() => f.record({ conclusion: 'passed', summary: '已读回', issues: [] })).toThrow(
      'TASK_REVIEW_UNRESOLVED',
    );
    f.record({
      conclusion: 'needs_revision',
      summary: '已修复镜头，人物资料仍待复核',
      issues: [],
      resolutions: [
        {
          issueId: issues[0]!.issueId,
          disposition: 'resolved',
          reason: '该镜现有托付动作并读回',
          evidence: [{ referenceId: 'shot', quote: '托付信件。' }],
        },
      ],
    });
    expect(f.reviewState().issues.map((i) => i.issueId)).toEqual([issues[1]!.issueId]);
    expect(f.reviewState().reviewScope).toEqual(['character']);
    f.record({
      conclusion: 'passed',
      summary: '角色资料不需要包含全部剧情动作',
      issues: [],
      resolutions: [
        {
          issueId: issues[1]!.issueId,
          disposition: 'withdrawn',
          reason: '将镜头剧情错误强加给角色设定板',
          evidence: f.evidence,
        },
      ],
    });
    expect(f.pending()).toEqual([]);
  });
  it('does not revive a withdrawn issue when an older assessment is replayed', () => {
    const f = ready();
    const args = {
      operation: 'review',
      reviewId: f.reviewState().reviewId,
      reviewedTargetIds: f.reviewState().reviewScope,
      conclusion: 'needs_revision',
      summary: '待复核',
      issues: [f.issue()],
    };
    const original = f.submit(args);
    f.read(original, { tool: 'conversation.task.checkpoint' });
    f.record({
      conclusion: 'passed',
      summary: '有依据撤回',
      issues: [],
      resolutions: [
        {
          issueId: f.reviewState().issues[0]!.issueId,
          disposition: 'withdrawn',
          reason: '复核确认误报',
          evidence: f.evidence,
        },
      ],
    });
    expect(f.submit(args)).toEqual(original);
    f.read(original, { tool: 'conversation.task.checkpoint' });
    expect(f.pending()).toEqual([]);
  });
  it('preserves legacy findings for explicit reassessment without trusting old global hashes', () => {
    const f = ready();
    const legacy = f.read(
      {
        status: 'task_review_recorded',
        manifestHash: 'old',
        artifactsHash: 'old',
        conclusion: 'needs_revision',
        summary: '旧记录',
        issues: ['需要刷新版本'],
      },
      { tool: 'conversation.task.checkpoint' },
    );
    expect(f.reviewState().issues[0]).toMatchObject({ legacy: true, description: '需要刷新版本' });
    f.record({ conclusion: 'needs_revision', summary: '旧问题尚待有依据重评', issues: [] });
    expect(f.reviewState().reviewScope).toEqual(['character', 'shot']);
    expect(() => f.record({ conclusion: 'passed', summary: '自动迁移', issues: [] })).toThrow(
      'TASK_REVIEW_UNRESOLVED',
    );
    f.record({
      conclusion: 'passed',
      summary: '重新核对完整当前产物，撤回旧流程误报',
      issues: [],
      resolutions: [
        {
          issueId: f.reviewState().issues[0]!.issueId,
          disposition: 'withdrawn',
          reason: '版本问题由Worker就绪检查处理，无内容缺陷',
          evidence: f.evidence,
        },
      ],
    });
    expect(f.pending()).toEqual([]);
    expect(new AgentContextStore(f.db).result('project', 'task', legacy.id)?.content).toContain(
      '需要刷新版本',
    );
  });
  it('survives SQLite reopen with the same snapshot and open issue identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p22-review-recovery-'));
    directories.push(dir);
    const filename = join(dir, 'project.sqlite'),
      f = completionFixture(filename);
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    f.record({
      conclusion: 'needs_revision',
      summary: '待复核',
      issues: [{ ...f.issue(), evidence: [{ referenceId: 'invented-id', quote: '待核实' }] }],
    });
    const before = f.reviewState();
    expect(before.issues).toMatchObject([{ evidenceStatus: 'needs_correction' }]);
    databases.splice(databases.indexOf(f.db), 1);
    f.db.close();
    const reopened = new Database(filename);
    databases.push(reopened);
    const restored = scriptToMediaCompletionPending(reopened, 'project', 'generation', 'task')![0]!
      .semanticReview;
    expect(restored).toEqual(expect.objectContaining(before));
    expect(
      new AgentContextStore(reopened).result('other-project', 'task', before.reviewId),
    ).toBeUndefined();
    expect(
      new AgentContextStore(reopened).result('project', 'other-task', before.reviewId),
    ).toBeUndefined();
  });
  it('rejects a foreign snapshot and preserves saved content and findings after a failed assessment', () => {
    const f = ready(),
      state = f.reviewState();
    const foreign = new AgentContextStore(f.db).putResult(
      'project',
      'other-task',
      'foreign',
      'task.review.snapshot',
      '{}',
    );
    expect(() =>
      f.submit({
        operation: 'review',
        reviewId: foreign.id,
        conclusion: 'passed',
        summary: '越权',
        issues: [],
      }),
    ).toThrow('TASK_REVIEW_STALE');
    const original = f.db.prepare('SELECT authoring_ir_json FROM shots').get();
    expect(() =>
      f.db.transaction(() => {
        f.record({ conclusion: 'needs_revision', summary: '事务失败', issues: [f.issue()] });
        throw new Error('simulate persistence failure');
      })(),
    ).toThrow('simulate persistence failure');
    expect(f.reviewState()).toEqual(state);
    expect(f.db.prepare('SELECT authoring_ir_json FROM shots').get()).toEqual(original);
  });
  it('keeps review actions and issueIds on externalized model receipts', () => {
    const f = ready();
    const event = f.record({
      conclusion: 'needs_revision',
      summary: '待核对',
      issues: [f.issue()],
    });
    const stored = new AgentContextStore(f.db).putResult(
      'project',
      'task',
      'review-wire',
      'conversation.task.checkpoint',
      JSON.stringify(event),
    );
    expect(JSON.parse(modelResultReceipt(stored, 1))).toMatchObject({
      externalized: true,
      reviewId: f.reviewState().reviewId,
      issues: [{ issueId: f.reviewState().issues[0]!.issueId, targetId: 'shot' }],
    });
    const page = new AgentContextStore(f.db).putResult(
      'project',
      'task',
      'state-wire',
      'conversation.task.checkpoint',
      JSON.stringify({
        status: 'task_state_read',
        pendingActions: [{ semanticReview: f.reviewState() }],
        records: ['正文'.repeat(4000)],
      }),
    );
    expect(JSON.parse(modelResultReceipt(page))).toMatchObject({
      externalized: true,
      pendingActions: [{ semanticReview: { reviewId: f.reviewState().reviewId } }],
    });
  });
});

describe('script-to-media shot contract', () => {
  it('requires all three explicit reference lists, including empty lists', () => {
    const base = { schemaVersion: 1 as const, kind: 'shot' as const, prompt: '完整镜头提示词' };
    expect(() => requireScriptToMediaShotReferences(base)).toThrow(
      /characterDocumentIds must be an array/,
    );
    expect(() =>
      requireScriptToMediaShotReferences({
        ...base,
        references: { characterDocumentIds: [], sceneDocumentIds: [], propDocumentIds: [] },
      }),
    ).not.toThrow();
    expect(() =>
      requireScriptToMediaShotReferences({
        ...base,
        references: { characterDocumentIds: [], sceneDocumentIds: [] },
      }),
    ).toThrow(/propDocumentIds must be an array/);
  });
});

describe('frozen production task completion contract', () => {
  it('returns the current review action after rejecting an obsolete snapshot', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    const current = f.pending()![0]!;
    const reviewId = (current.semanticReview as { reviewId: string }).reviewId;
    let message = '';
    try {
      taskCheckpoint(
        f.db,
        'project',
        {
          operation: 'review',
          reviewId: 'obsolete-snapshot',
          conclusion: 'passed',
          summary: '已核对',
          issues: [],
        },
        {
          projectId: 'project',
          projectSessionId: 'session',
          conversationId: 'conversation',
          taskId: 'task',
          toolCallId: 'review',
        },
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('TASK_REVIEW_STALE');
    expect(message).toContain(reviewId);
    expect(message).toContain('review_outputs');
    expect(f.pending()).toHaveLength(1);
    expect(
      f.db
        .prepare(
          "SELECT count(*) count FROM agent_context_results WHERE tool_name='conversation.task.checkpoint'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it('reconciles state actions from current reads instead of a persisted stale pending snapshot', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    f.db
      .prepare('INSERT INTO agent_context_tasks(project_id,task_id,state_json) VALUES (?,?,?)')
      .run(
        'project',
        'task',
        JSON.stringify({
          taskId: 'task',
          taskGoal: '完成镜头',
          userRequirements: [],
          projectConstraints: [],
          confirmedDecisions: [],
          currentStage: 'review',
          completedSteps: [],
          pendingSteps: [{ key: 'stale', nextAction: { kind: 'read_outputs' } }],
          executionStatus: 'running',
          generatedArtifacts: [],
        }),
      );
    vi.spyOn(AgentContextStore.prototype, 'evidence').mockReturnValue([]);
    vi.spyOn(AgentContextStore.prototype, 'resultRefs').mockReturnValue([]);
    const result = taskCheckpoint(
      f.db,
      'project',
      { operation: 'state' },
      {
        projectId: 'project',
        projectSessionId: 'session',
        conversationId: 'conversation',
        taskId: 'task',
        toolCallId: 'state',
      },
    );
    expect(result.pendingActions).toMatchObject([
      {
        key: 'skill:script-to-media:final-check',
        nextAction: { kind: 'review_outputs' },
        semanticReview: {
          ready: true,
          reviewId: f.reviewState().reviewId,
        },
      },
    ]);
    const records = result.records as Array<{ kind: string; value?: { key?: string } }>;
    expect(
      records.some((record) => record.kind === 'pending' && record.value?.key === 'stale'),
    ).toBe(false);
  });

  it('directs readback and semantic review without requesting another successful write', () => {
    const f = completionFixture();
    f.seed();
    expect(f.pending()?.[0]?.nextAction).toMatchObject({ kind: 'read_outputs' });
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    expect(f.pending()?.[0]?.nextAction).toMatchObject({
      kind: 'review_outputs',
      toolName: 'conversation.task.checkpoint',
      arguments: { operation: 'review' },
    });
    expect(f.pending()?.[0]?.instruction).not.toContain('Persist timing and beats');
    f.review();
    expect(f.pending()).toEqual([]);
  });

  it('rejects stale approval and unresolved issues at the actual checkpoint boundary', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    const identity = {
      projectId: 'project',
      projectSessionId: 'session',
      conversationId: 'conversation',
      taskId: 'task',
      toolCallId: 'review',
    };
    const reviewId = f.reviewState().reviewId;
    const args = {
      operation: 'review',
      reviewId,
      reviewedTargetIds: f.reviewState().reviewScope,
      conclusion: 'passed',
      summary: '已核对原文与产物',
      issues: [],
    };
    expect(() =>
      taskCheckpoint(f.db, 'project', { ...args, reviewId: 'obsolete' }, identity),
    ).toThrow('TASK_REVIEW_STALE');
    const rejected = taskCheckpoint(
      f.db,
      'project',
      { ...args, conclusion: 'needs_revision', issues: [f.issue('修复托付动作')] },
      identity,
    );
    f.read(rejected, { tool: 'conversation.task.checkpoint' });
    expect(() =>
      taskCheckpoint(
        f.db,
        'project',
        {
          ...args,
          reviewedTargetIds: f.reviewState().reviewScope,
        },
        identity,
      ),
    ).toThrow('TASK_REVIEW_UNRESOLVED');
    f.db
      .prepare(
        "INSERT INTO document_versions VALUES('source-v2','source','新版原文：将信件托付来人。')",
      )
      .run();
    f.db.prepare("UPDATE documents SET current_version_id='source-v2' WHERE id='source'").run();
    f.read(
      { sourceId: 'source', versionId: 'source-v2', content: '新版原文：将信件托付来人。' },
      { tool: 'library.read' },
    );
    const sourceReviewId = f.reviewState().reviewId;
    expect(() =>
      taskCheckpoint(f.db, 'project', { ...args, reviewId: sourceReviewId }, identity),
    ).toThrow('TASK_REVIEW_UNRESOLVED');
    f.db
      .prepare('UPDATE shots SET authoring_ir_json=?,updated_at=?')
      .run(
        JSON.stringify({ ...f.ir, prompt: f.ir.prompt + '托付信件。' }),
        '2026-11-06T03:00:02.000Z',
      );
    f.read(
      { target: { kind: 'shot', id: 'shot' }, text: f.ir.prompt + '托付信件。' },
      { at: '2026-11-06T03:00:03.000Z' },
    );
    const approved = taskCheckpoint(
      f.db,
      'project',
      {
        ...args,
        reviewId: f.reviewState().reviewId,
        reviewedTargetIds: f.reviewState().reviewScope,
        resolutions: [
          {
            issueId: f.reviewState().issues[0]!.issueId,
            disposition: 'resolved',
            reason: '修订托付动作并读回',
            evidence: [{ referenceId: 'shot', quote: '托付信件。' }],
          },
        ],
      },
      identity,
    );
    f.read(approved, { tool: 'conversation.task.checkpoint' });
    expect(f.pending()).toEqual([]);
  });
  it('requires complete current source pages rather than a metadata or excerpt read', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    f.db
      .prepare(
        "DELETE FROM agent_context_results WHERE json_extract(content,'$.sourceId')='source'",
      )
      .run();
    f.read(
      { sourceId: 'source', versionId: 'source-v1', content: '人物收信' },
      { tool: 'library.read' },
    );
    expect(f.pending()?.[0]?.unreadSources).toHaveLength(1);
    expect(f.pending()?.[0]?.semanticReview).toMatchObject({ ready: false });
    f.read(
      { sourceId: 'source', versionId: 'source-v1', startOffset: 0, content: '人物收信后将其' },
      { tool: 'library.read' },
    );
    f.read(
      { sourceId: 'source', versionId: 'source-v1', startOffset: 7, content: '托付给来人。' },
      { tool: 'library.read' },
    );
    expect(f.pending()?.[0]?.unreadSources).toEqual([]);
  });
  it('requires semantic review, preserves issues and invalidates approval after source/output updates', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    expect(f.pending()?.[0]?.semanticReview).toMatchObject({ ready: true });
    f.review('needs_revision', ['托付被误写为带走']);
    expect(f.pending()?.[0]?.semanticReview).toMatchObject({
      previousConclusion: 'needs_revision',
      issues: [{ targetId: 'shot', description: '托付被误写为带走' }],
    });
    const previous = f.reviewState().reviewId;
    f.db
      .prepare('UPDATE shots SET authoring_ir_json=?,updated_at=?')
      .run(
        JSON.stringify({ ...f.ir, prompt: f.ir.prompt + '托付信件。' }),
        '2026-11-06T03:00:02.000Z',
      );
    expect(f.reviewState().reviewId).not.toBe(previous);
    f.read(
      { target: { kind: 'shot', id: 'shot' }, text: f.ir.prompt + '托付信件。' },
      { at: '2026-11-06T03:00:03.000Z' },
    );
    f.review();
    expect(f.pending()).toEqual([]);
    f.db.prepare("UPDATE documents SET current_version_id='source-v2' WHERE id='source'").run();
    expect(f.pending()?.[0]?.staleSources).toHaveLength(1);
  });
  it('discovers committed episode_structure_saved outputs before any production readback', () => {
    const f = completionFixture();
    f.seed();
    f.db.prepare('DELETE FROM agent_tool_calls').run();
    f.receipt('novel.episode.submit_structure', {
      status: 'episode_structure_saved',
      sceneIds: ['scene'],
      shotIds: ['shot'],
    });
    expect(f.pending()?.[0]).toMatchObject({
      missingStructure: false,
      unreviewedArtifacts: [
        { id: 'shot', kind: 'shot' },
        { id: 'character', kind: 'document' },
      ],
    });
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, text: f.ir.prompt });
    f.review();
    expect(f.pending()).toEqual([]);
  });

  it('keeps required work pending without a model plan and leaves ordinary tasks unchanged', () => {
    const f = completionFixture();
    expect(assessTaskCompletion(f.db, 'project', 'generation', 'task')?.pending[0]).toMatchObject({
      repairRequired: true,
      missingStructure: true,
    });
    expect(f.pending()?.[0]?.instruction).toContain('not evidence of a previous run');
    f.db.prepare('UPDATE agent_tasks SET request_snapshot_json=?').run('{}');
    expect(assessTaskCompletion(f.db, 'project', 'generation', 'task')).toBeUndefined();
  });

  it('does not accept a complete model plan or a ready receipt when shot timing is absent', () => {
    const f = completionFixture();
    f.seed();
    const withoutTiming: Partial<typeof f.ir> = { ...f.ir };
    delete withoutTiming.timing;
    f.db.prepare('UPDATE shots SET authoring_ir_json=?').run(JSON.stringify(withoutTiming));
    f.receipt('conversation.task.checkpoint', {
      status: 'task_plan_saved',
      deliverables: [{ key: 'structure', toolName: 'scene.structure.stage', minimumCount: 1 }],
    });
    const progress = assessTaskCompletion(f.db, 'project', 'generation', 'task');
    expect(progress?.pending).toHaveLength(1);
    const invalidShots = progress?.pending[0]?.invalidShots as Array<{
      shotId: string;
      reason: string;
    }>;
    expect(invalidShots).toHaveLength(1);
    expect(invalidShots[0]?.shotId).toBe('shot');
    expect(invalidShots[0]?.reason).toContain('timing');
    expect(() => assertTaskPartialAllowed(progress)).toThrow('TASK_REPAIR_REQUIRED');
  });

  it('requires readback of both reused material documents and each final shot', () => {
    const f = completionFixture();
    f.seed();
    expect(f.pending()?.[0]?.unreviewedArtifacts).toEqual([
      { id: 'shot', kind: 'shot' },
      { id: 'character', kind: 'document' },
    ]);
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, text: f.ir.prompt });
    f.review();
    expect(assessTaskCompletion(f.db, 'project', 'generation', 'task')).toEqual({ pending: [] });
  });

  it('provides schema-valid readback actions for the real object types without inventing handles', () => {
    const f = completionFixture();
    f.seed();
    const actions = f.pending()?.[0]?.readbackActions as Array<{
      tool: string;
      arguments: Record<string, unknown>;
      expectedSourceId?: string;
      expectedVersionId?: string;
    }>;
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      tool: 'production.read',
      arguments: { target: { kind: 'shot', id: 'shot' }, view: 'authoring' },
    });
    expect(actions[1]).toMatchObject({
      tool: 'library.read',
      arguments: {
        artifact: { documentId: 'character', expectedVersionId: 'v1' },
        readMode: 'source',
      },
      expectedSourceId: 'character',
      expectedVersionId: 'v1',
    });
    for (const action of actions) {
      const definition = ALL_AGENT_TOOL_DEFINITIONS.find((tool) => tool.name === action.tool)!;
      expect(() => {
        validateToolArguments(definition, {
          type: 'toolCall',
          id: 'readback',
          name: action.tool,
          arguments: action.arguments,
        });
      }).not.toThrow();
    }
    expect(actions.every((action) => !('sourceHandle' in action.arguments))).toBe(true);
    expect(JSON.stringify(actions)).not.toContain('完整角色设定板提示词正文');
    // The action is navigation, not a receipt or a substitute for reading content.
    expect(f.pending()?.[0]?.unreviewedArtifacts).toHaveLength(2);
    f.readDocument();
    expect(f.pending()?.[0]?.readbackActions).toHaveLength(1);
  });

  it('rejects metadata, failed reads, another task, and save responses as readback', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, hasPrompt: true, readiness: 'ready' });
    f.read({ target: { kind: 'shot', id: 'shot' }, text: f.ir.prompt }, { status: 'failed' });
    f.read({ target: { kind: 'shot', id: 'shot' }, text: f.ir.prompt }, { taskId: 'other-task' });
    f.read(
      { target: { kind: 'shot', id: 'shot' }, text: f.ir.prompt },
      { tool: 'scene.update_shot_prompts' },
    );
    expect(f.pending()?.[0]?.unreviewedArtifacts).toEqual([{ id: 'shot', kind: 'shot' }]);
  });

  it('accepts explicitly read existing shots without requiring duplicate structure writes', () => {
    const f = completionFixture();
    f.seed();
    f.db.prepare('DELETE FROM agent_tool_calls').run();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    f.review();
    expect(f.pending()).toEqual([]);
    // Unread siblings and unrelated project structures are not auto-loaded.
    f.db
      .prepare('INSERT INTO shots VALUES (?,?,?,?,NULL)')
      .run('unrelated', 'scene', '{}', '2026-11-06T03:00:00.000Z');
    expect(f.pending()).toEqual([]);
  });

  it('reconstructs all authoring pages without mixing versions, including escaped JSON', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    const body = JSON.stringify(f.ir),
      cut = Math.floor(body.length / 2);
    const page = (offset: number, text: string, version = 'a') => ({
      target: { kind: 'shot', id: 'shot' },
      view: 'authoring',
      contentPage: { offset, text, expectedVersion: version },
    });
    f.read(page(cut, body.slice(cut), 'b'));
    f.read(page(0, body.slice(0, cut)));
    expect(f.pending()?.[0]?.unreviewedArtifacts).toHaveLength(1);
    f.read(page(cut, body.slice(cut)));
    f.review();
    expect(f.pending()).toEqual([]);
  });

  it('does not treat a prompt-bearing JSON prefix as complete authoring readback', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    const ir = { ...f.ir, prompt: '完整提示词在第一页，时长与引用在后页' };
    f.db.prepare('UPDATE shots SET authoring_ir_json=? WHERE id=?').run(JSON.stringify(ir), 'shot');
    const body = JSON.stringify(ir);
    const cut = body.indexOf(',"references"');
    const page = (offset: number, text: string) => ({
      target: { kind: 'shot', id: 'shot' },
      view: 'authoring',
      contentPage: { offset, text, format: 'json', expectedVersion: 'current-version' },
    });
    expect(cut).toBeGreaterThan(0);
    f.read(page(0, body.slice(0, cut)));
    expect(f.reviewState().ready).toBe(false);
    expect(f.pending()?.[0]?.unreviewedArtifacts).toEqual([{ id: 'shot', kind: 'shot' }]);
    f.read(page(cut + 1, body.slice(cut + 1)));
    expect(f.reviewState().ready).toBe(false);
    f.read(page(cut, body.slice(cut, cut + 1)));
    expect(f.reviewState().ready).toBe(true);
  });

  it('invalidates readback after an update and restores coverage from persisted reads', () => {
    const f = completionFixture();
    f.seed();
    f.readDocument();
    f.read({ target: { kind: 'shot', id: 'shot' }, authoring: f.ir });
    f.review();
    expect(f.pending()).toEqual([]);
    f.db.prepare('UPDATE shots SET updated_at=?').run('2026-11-06T03:00:02.000Z');
    expect(f.pending()?.[0]?.unreviewedArtifacts).toEqual([{ id: 'shot', kind: 'shot' }]);
    f.read(
      { target: { kind: 'shot', id: 'shot' }, authoring: f.ir },
      { at: '2026-11-06T03:00:03.000Z' },
    );
    f.review();
    expect(f.pending()).toEqual([]);
  });

  it('keeps staged or archived output out of completion evidence', () => {
    const f = completionFixture();
    f.receipt('scene.structure.stage', {
      status: 'scene_structure_partially_saved',
      sceneIds: [],
      shotIds: [],
      readiness: 'ready',
    });
    expect(f.pending()?.[0]?.missingStructure).toBe(true);
    f.seed();
    f.db.prepare('UPDATE scenes SET archived_at=?').run('2026-11-06T03:00:02.000Z');
    expect(f.pending()?.[0]?.missingStructure).toBe(true);
  });
});
