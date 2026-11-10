import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectAgentTask } from './agent-task-inspection.js';

const completion = vi.hoisted(() => vi.fn());
vi.mock('./production-skill-validation.js', () => ({ scriptToMediaCompletionPending: completion }));
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  completion.mockReset();
});

function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  db.exec(`CREATE TABLE agent_tasks(id TEXT,project_id TEXT,status TEXT,phase TEXT,created_at TEXT,completed_at TEXT,error_code TEXT,error_message TEXT,turn_count INTEGER,input_tokens INTEGER,output_tokens INTEGER,request_snapshot_json TEXT);
    INSERT INTO agent_tasks VALUES('task','project','cancelled','cancelled','2026-11-09T07:01:22.000Z','2026-11-09T08:20:37.816Z',NULL,NULL,211,1000000,10000,'{}');
    CREATE TABLE agent_task_generations(task_id TEXT,generation_id TEXT,ordinal INTEGER);
    INSERT INTO agent_task_generations VALUES('task','old-generation',1),('task','latest-generation',2);
    CREATE TABLE agent_tool_calls(project_id TEXT,task_id TEXT,tool_name TEXT,status TEXT,error_code TEXT,error_message TEXT,result_summary_json TEXT,created_at TEXT,completed_at TEXT);
    CREATE TABLE scenes(id TEXT,project_id TEXT,archived_at TEXT);
    CREATE TABLE shots(id TEXT,scene_id TEXT,archived_at TEXT);
    CREATE TABLE documents(id TEXT,project_id TEXT,kind TEXT,lifecycle_status TEXT);`);
  const call = (result: unknown, at = '2026-11-09T07:49:14.000Z', task = 'task') =>
    db
      .prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,NULL,NULL,?,?,?)')
      .run('project', task, 'scene.submit_structure', 'succeeded', JSON.stringify(result), at, at);
  for (let i = 0; i < 4; i++)
    db.prepare('INSERT INTO scenes VALUES(?,?,NULL)').run(`scene-${i}`, 'project');
  for (let i = 0; i < 13; i++)
    db.prepare('INSERT INTO shots VALUES(?,?,NULL)').run(`shot-${i}`, `scene-${i % 4}`);
  db.exec(
    "INSERT INTO scenes VALUES('unrelated','project',NULL),('foreign','other',NULL); INSERT INTO shots VALUES('unrelated-shot','unrelated',NULL),('foreign-shot','foreign',NULL); INSERT INTO documents VALUES('foreign-doc','other','character','active')",
  );
  call({ status: 'scene_structure_saved', sceneIds: ['scene-0', 'scene-1', 'scene-2', 'scene-3'] });
  call(
    {
      status: 'scene_structure_saved',
      sceneIds: ['scene-0'],
      execution: { replayed: true, effect: 'none' },
    },
    '2026-11-09T08:15:00.000Z',
  );
  call(
    { status: 'scene_structure_saved', sceneIds: ['unrelated'] },
    '2026-11-09T08:18:00.000Z',
    'other-task',
  );
  call({ status: 'draft_saved', documentId: 'foreign-doc' }, '2026-11-09T07:40:00.000Z');
  db.prepare('INSERT INTO agent_tool_calls VALUES(?,?,?,?,?,?,?,?,?)').run(
    'project',
    'task',
    'conversation.task.checkpoint',
    'failed',
    'TOOL_FAILED',
    'TASK_REVIEW_REQUIREMENTS_INVALID: exact quote required',
    null,
    '2026-11-09T08:18:00.000Z',
    '2026-11-09T08:18:00.000Z',
  );
  completion.mockReturnValue([
    {
      nextAction: {
        kind: 'repair_outputs',
        obligations: [{ missingTexts: ['正文'.repeat(10000)] }],
      },
      semanticReview: {
        ready: true,
        approved: false,
        references: Array.from({ length: 17 }, (_, i) => ({
          id: String(i),
          kind: i < 4 ? 'scene' : 'shot',
        })),
        reviewScope: Array.from({ length: 17 }, (_, i) => String(i)),
        issues: [],
      },
    },
  ]);
  return db;
}

it('summarizes the same whole task before history pagination and distinguishes saved/ready from accepted', () => {
  const db = fixture(),
    before = db.prepare('SELECT total_changes() n').get();
  const summary = inspectAgentTask(db, 'project', 'old-generation');
  expect(summary).toMatchObject({
    available: true,
    taskId: 'task',
    status: 'cancelled',
    elapsedMs: 4755816,
    saved: { scenes: 4, shots: 13, materialDocuments: {}, lastSavedAt: '2026-11-09T07:49:14.000Z' },
    review: {
      available: true,
      readyToSubmit: true,
      approved: false,
      currentTargetCount: 17,
      acceptedTargetCount: 0,
      pendingTargetCount: 17,
    },
    calls: { total: 4, failed: 1, failureCategories: { TASK_REVIEW_REQUIREMENTS_INVALID: 1 } },
    usage: { turns: 211 },
  });
  expect(completion).toHaveBeenCalledWith(db, 'project', 'latest-generation', 'task');
  expect(JSON.stringify(summary)).not.toContain('正文');
  expect(db.prepare('SELECT total_changes() n').get()).toEqual(before);
});

it('reports unavailable review facts explicitly without inventing approval or hiding saved content', () => {
  const db = fixture();
  completion.mockImplementation(() => {
    throw new Error('REVIEW_SNAPSHOT_UNAVAILABLE');
  });
  expect(inspectAgentTask(db, 'project', 'latest-generation')).toMatchObject({
    saved: { scenes: 4, shots: 13 },
    review: { available: false, reason: 'REVIEW_SNAPSHOT_UNAVAILABLE' },
  });
  expect(inspectAgentTask(db, 'other', 'latest-generation')).toMatchObject({ available: false });
  expect(inspectAgentTask(db, 'project', 'missing')).toMatchObject({ available: false });
});
