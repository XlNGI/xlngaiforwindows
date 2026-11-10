import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentContextStore, type AgentTaskState } from './agent-context-store.js';
import { applyMigrationV75 } from './migration-v75.js';
function database(path = ':memory:') {
  const db = new Database(path);
  db.exec(
    "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO projects VALUES('p');",
  );
  applyMigrationV75(db);
  return db;
}
const state: AgentTaskState = {
  taskId: 't',
  taskGoal: '完成整集',
  userRequirements: [{ id: 'u', text: '逐镜保留对白', source: 'user' }],
  projectConstraints: [],
  confirmedDecisions: [],
  currentStage: 'shots',
  completedSteps: ['read'],
  pendingSteps: ['write'],
  executionStatus: 'running',
  generatedArtifacts: [],
};
describe('durable Agent working data', () => {
  it('discovers damaged current slots through a coherent checkpoint without reviving terminal tasks', () => {
    const db = database(),
      store = new AgentContextStore(db);
    try {
      for (const taskId of ['damaged', 'healthy', 'cancelled', 'runtime-damaged']) {
        store.saveTask(
          'p',
          taskId,
          'c',
          { ...state, taskId },
          { runtime: { modelId: 'm' }, messages: [{ checkpoint: taskId }] },
        );
        store.checkpoint('p', taskId, 'valid');
      }
      db.prepare('UPDATE agent_context_tasks SET state_json=? WHERE task_id=?').run(
        '{}',
        'damaged',
      );
      store.saveTask('p', 'cancelled', 'c', {
        ...state,
        taskId: 'cancelled',
        executionStatus: 'cancelled',
      });
      store.saveTask(
        'p',
        'runtime-damaged',
        'c',
        {
          ...state,
          taskId: 'runtime-damaged',
          currentStage: 'unpaired',
          userRequirements: [{ id: 'new', text: '新要求', source: 'user' }],
        },
        {},
      );
      expect(
        store
          .recoverable('p')
          .map((r) => r.taskId)
          .sort(),
      ).toEqual(['damaged', 'healthy', 'runtime-damaged']);
      const snapshot = store.loadSnapshot<{
        messages: unknown[];
      }>('p', 'runtime-damaged');
      expect(snapshot?.state.currentStage).toBe('shots');
      expect(snapshot?.state.userRequirements[0]?.text).toBe('新要求');
      expect(snapshot?.runtime?.messages).toEqual([{ checkpoint: 'runtime-damaged' }]);
      expect(store.loadTask('p', 'cancelled')?.executionStatus).toBe('cancelled');
    } finally {
      db.close();
    }
  });
  it('deduplicates checkpoint blobs and falls back across damaged snapshots without deleting originals', () => {
    const db = database(),
      store = new AgentContextStore(db);
    const runtime = {
      runtime: { modelId: 'm', systemInstruction: '大系统'.repeat(20000) },
      messages: [{ role: 'assistant', content: [] }],
      mode: 'conversation',
    };
    store.saveTask('p', 'g', 'c', state, runtime);
    store.checkpoint('p', 't', 'first');
    for (let i = 0; i < 5; i++) {
      store.saveTask(
        'p',
        'g',
        'c',
        { ...state, currentStage: `step-${i}` },
        { ...runtime, messages: [{ role: 'assistant', content: [], timestamp: i }] },
      );
      store.checkpoint('p', 't', `step-${i}`);
    }
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_context_results WHERE tool_name='runtime.checkpoint.config'",
        )
        .get(),
    ).toEqual({ n: 1 });
    const before = (
      db.prepare('SELECT COUNT(*) AS n FROM agent_context_checkpoints').get() as {
        n: number;
      }
    ).n;
    store.checkpoint('p', 't', 'duplicate');
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM agent_context_checkpoints').get() as {
          n: number;
        }
      ).n,
    ).toBe(before);
    db.exec(`UPDATE agent_context_tasks SET state_json='{}',runtime_json='{}';
      UPDATE agent_context_checkpoints SET state_json='{}',runtime_json='{}' WHERE rowid=(SELECT MAX(rowid) FROM agent_context_checkpoints);`);
    expect(store.loadTask('p', 't')?.currentStage).toBe('step-3');
    db.prepare('UPDATE agent_context_tasks SET state_json=?').run(
      JSON.stringify({ taskId: 't', userRequirements: [], pendingSteps: [] }),
    );
    expect(store.loadTask('p', 't')?.currentStage).toBe('step-3');
    expect(store.loadRuntime('p', 't')).toMatchObject({
      runtime: { modelId: 'm' },
      messages: [{ timestamp: 3 }],
    });
    expect(
      (
        db.prepare('SELECT COUNT(*) AS n FROM agent_context_checkpoints').get() as {
          n: number;
        }
      ).n,
    ).toBe(before);
    db.close();
  });
  it('migrates idempotently without modifying legacy audit records', () => {
    const db = database();
    db.exec(
      'CREATE TABLE agent_tool_calls(id TEXT,result_summary_json TEXT); INSERT INTO agent_tool_calls VALUES(\'legacy\',\'{"status":"read"}\');',
    );
    applyMigrationV75(db);
    expect(db.prepare('SELECT * FROM agent_tool_calls').all()).toEqual([
      { id: 'legacy', result_summary_json: '{"status":"read"}' },
    ]);
    db.close();
  });
  it('persists complete data, exact drafts, checkpoints and task state across database reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-context-'));
    const path = join(dir, 'project.sqlite');
    let db = database(path);
    try {
      let store = new AgentContextStore(db);
      const content = JSON.stringify({
        content: '完整小说'.repeat(30000),
        bindings: { exact: '手写' },
      });
      const result = store.putResult('p', 't', 'call', 'library.read', content, {
        unsavedDraft: '不能丢',
      });
      store.saveTask('p', 'g', 'c', state, { messages: ['original'], runtime: { modelId: 'm' } });
      store.checkpoint('p', 't', 'cp');
      db.close();
      db = database(path);
      store = new AgentContextStore(db);
      expect(store.loadTask('p', 't')).toEqual(state);
      expect(store.loadRuntime('p', 't')).toEqual({
        messages: ['original'],
        runtime: { modelId: 'm' },
      });
      let text = '',
        offset: number | null = 0;
      while (offset !== null) {
        const page = store.readResult('p', 't', result.id, offset, 4096, result.contentHash);
        text += page.content;
        offset = page.nextOffset;
      }
      expect(text).toBe(content);
      expect(store.result('p', 't', result.id)?.arguments).toEqual({ unsavedDraft: '不能丢' });
      expect(store.recoverable('p')).toHaveLength(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_context_checkpoints').get()).toEqual({
        n: 1,
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true });
    }
  });
  it('reads original failed parameters independently of error content, enforcing view hash and scope', () => {
    const db = database(),
      store = new AgentContextStore(db);
    const args = { body: '完整失败草稿'.repeat(2000) };
    const result = store.putResult(
      'p',
      't',
      'failed',
      'document.submit_draft',
      'invalid structure',
      args,
      'failed',
    );
    const first = store.readResult('p', 't', result.id, 0, 4096, undefined, 'arguments');
    expect(first.contentHash).not.toBe(result.contentHash);
    expect(() =>
      store.readResult('p', 't', result.id, 0, 4096, result.contentHash, 'arguments'),
    ).toThrow('CONTEXT_RESULT_VERSION_CONFLICT');
    expect(() =>
      store.readResult('p', 'other', result.id, 0, 4096, undefined, 'arguments'),
    ).toThrow('outside');
    let text = '',
      offset: number | null = 0;
    while (offset !== null) {
      const page = store.readResult(
        'p',
        't',
        result.id,
        offset,
        4096,
        first.contentHash,
        'arguments',
      );
      text += page.content;
      offset = page.nextOffset;
    }
    expect(JSON.parse(text)).toEqual(args);
    db.close();
  });
  it('keeps one active evidence per source/version/range and retains historical pages', () => {
    const db = database();
    const store = new AgentContextStore(db);
    const put = (call: string, version: string, range: string) => {
      const r = store.putResult(
        'p',
        't',
        call,
        'library.read',
        JSON.stringify({ version, range, body: '正文' }),
      );
      return store.putEvidence('p', 't', r, {
        key: 'document:a',
        version,
        range,
        type: 'document',
        purpose: 'constraint',
      });
    };
    const first = put('one', 'v1', '0:10');
    put('same', 'v1', '0:10');
    expect(store.evidence('p', 't')).toHaveLength(1);
    put('page', 'v1', '10:20');
    expect(store.evidence('p', 't')).toHaveLength(2);
    put('next', 'v2', '0:10');
    expect(store.evidence('p', 't').map((e) => e.sourceVersion)).toEqual(['v2']);
    put('old-unseen-range', 'v1', '20:30');
    expect(store.evidence('p', 't').map((e) => e.sourceVersion)).toEqual(['v2']);
    expect(store.evidence('p', 't', true)).toHaveLength(4);
    expect(store.result('p', 't', first.resultId)).toBeDefined();
    db.close();
  });
  it('enforces task isolation, content hashes and range boundaries', () => {
    const db = database();
    const store = new AgentContextStore(db);
    const r = store.putResult('p', 't', 'c', 'read', '完整结果');
    expect(() => store.readResult('p', 'other', r.id)).toThrow('outside');
    expect(() => store.readResult('p', 't', r.id, 0, 4096, 'wrong')).toThrow('VERSION_CONFLICT');
    expect(() => store.readResult('p', 't', r.id, -1)).toThrow('range');
    db.prepare('UPDATE agent_context_results SET content=? WHERE id=?').run('损坏', r.id);
    expect(() => store.readResult('p', 't', r.id)).toThrow('INTEGRITY_FAILED');
    db.close();
  });
  it('keeps same-version refreshed pages active and retires only evidence preceding a write', () => {
    const db = database(),
      store = new AgentContextStore(db);
    const put = (call: string, version: string, range: string, content: string) => {
      const result = store.putResult('p', 't', call, 'library.read', content);
      store.putEvidence('p', 't', result, {
        key: 'document:a:',
        version,
        range,
        type: 'document',
        purpose: 'working-data',
      });
      return result;
    };
    const old = put('old', 'v1', '0:10', '旧范围');
    put('refresh', 'v1', '0:10', '当前范围');
    put('page', 'v1', '10:20', '下一页');
    expect(store.evidence('p', 't')).toHaveLength(2);
    const write = store.putResult('p', 't', 'write', 'document.submit_draft', 'saved');
    store.retireEvidence('p', 't', ['document:a:'], write.id);
    expect(store.evidence('p', 't')).toEqual([]);
    const current = put('new', 'v2', '0:10', '保存后重新读取');
    // Recovery reobserves an earlier write. It must not invalidate a newer read.
    store.retireEvidence('p', 't', ['document:a:'], write.id);
    expect(store.evidence('p', 't').map((r) => r.resultId)).toEqual([current.id]);
    expect(store.result('p', 't', old.id)?.content).toBe('旧范围');
    db.close();
  });
});
