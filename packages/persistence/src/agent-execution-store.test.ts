import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrationV76 } from './migration-v76.js';
import { AgentExecutionStore } from './agent-execution-store.js';

function open(path = ':memory:') {
  const db = new Database(path);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY);
    INSERT OR IGNORE INTO projects VALUES('p');
    CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,project_id TEXT,body TEXT);
    CREATE TABLE IF NOT EXISTS scenes(id TEXT PRIMARY KEY,project_id TEXT);
    CREATE TABLE IF NOT EXISTS shots(id TEXT PRIMARY KEY,scene_id TEXT);
    CREATE TABLE IF NOT EXISTS agent_write_receipts(id TEXT PRIMARY KEY,project_id TEXT,execution_key TEXT,request_hash TEXT,request_json TEXT,result_json TEXT,created_at TEXT,UNIQUE(project_id,execution_key));`);
  applyMigrationV76(db);
  return db;
}
const identity = { projectId: 'p', taskId: 't', operationKey: 'output:1', toolName: 'write' };
const serialize = (v: unknown) => JSON.stringify(v);

describe('shared business commit boundary', () => {
  it('keeps a stable output across calls and database reopen, returning the actual saved result on conflict', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-execution-'));
    let db = open(join(dir, 'p.sqlite'));
    try {
      let store = new AgentExecutionStore(db);
      const output = store.registerOutput('p', 't', 'characters', 'write', 2);
      const first = JSON.parse(
        store.execute(
          identity,
          { body: 'original' },
          () => {
            db.prepare('INSERT INTO documents VALUES(?,?,?)').run('doc', 'p', 'original');
            return { status: 'draft_saved', documentId: 'doc' };
          },
          serialize,
        ),
      ) as { execution: { effect: string } };
      expect(first.execution.effect).toBe('created');
      db.close();
      db = open(join(dir, 'p.sqlite'));
      store = new AgentExecutionStore(db);
      expect(store.registerOutput('p', 't', 'characters', 'write', 3)).toBe(output);
      const replay = JSON.parse(
        store.execute(
          identity,
          { body: 'original' },
          () => {
            throw new Error('must not execute');
          },
          serialize,
        ),
      ) as { execution: { replayed: boolean; effect: string; instruction: string } };
      expect(replay.execution).toMatchObject({
        replayed: true,
        effect: 'created',
        receiptScope: 'historical_commit',
      });
      expect(replay.execution.instruction).toContain('not current resource state');
      const conflict: unknown = JSON.parse(
        store.execute(
          identity,
          { body: 'changed' },
          () => {
            throw new Error('must not execute');
          },
          serialize,
        ),
      );
      expect(conflict).toMatchObject({
        status: 'rejected',
        execution: { effect: 'conflict' },
        savedResult: { documentId: 'doc' },
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM documents').get()).toEqual({ n: 1 });
    } finally {
      db.close();
      rmSync(dir, { recursive: true });
    }
  });
  it('rolls back the artifact, facts and binding when result validation fails after the write', () => {
    const db = open(),
      store = new AgentExecutionStore(db);
    expect(() =>
      store.execute(
        identity,
        {},
        () => {
          db.prepare('INSERT INTO documents VALUES(?,?,?)').run('doc', 'p', 'body');
          return { invalid: true };
        },
        () => {
          throw new Error('result invalid');
        },
      ),
    ).toThrow('result invalid');
    for (const table of [
      'documents',
      'agent_resource_changes',
      'agent_write_receipts',
      'agent_execution_commits',
      'agent_execution_scope',
    ])
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    db.close();
  });
  it('does not claim progress for a no-op, and isolates task/project identity', () => {
    const db = open(),
      store = new AgentExecutionStore(db);
    const value = JSON.parse(
      store.execute(identity, {}, () => ({ status: 'saved' }), serialize),
    ) as { execution: { effect: string } };
    expect(value.execution.effect).toBe('unchanged');
    expect(
      store.output('p', 'other-task', store.registerOutput('p', 't', 'key', 'write', 1)),
    ).toBeUndefined();
    db.close();
  });
  it('adopts an implicit commit into only one planned output and protects consumed slots', () => {
    const db = open(),
      store = new AgentExecutionStore(db);
    const implicit = 'output:implicit:write';
    store.execute(
      { ...identity, operationKey: implicit },
      {},
      () => {
        db.prepare('INSERT INTO documents VALUES(?,?,?)').run('doc', 'p', 'body');
        return { status: 'saved', documentId: 'doc' };
      },
      serialize,
    );
    const first = store.registerOutput('p', 't', 'first', 'write', 2);
    const second = store.registerOutput('p', 't', 'second', 'write', 1);
    expect(store.outputOperation('p', 't', second, 0, implicit)).toBe(`output:${second}:0`);
    store.adoptAllocatedOutput('p', 't', first, ['doc']);
    expect(store.outputOperation('p', 't', first, 0, implicit)).toBe(implicit);
    expect(store.outputOperation('p', 't', second, 0, implicit)).toBe(`output:${second}:0`);
    expect(store.outputOperation('p', 't', first, 0, implicit)).toBe(implicit);
    const extra = `output:${first}:1`;
    store.execute(
      { ...identity, operationKey: extra },
      {},
      () => {
        db.prepare('INSERT INTO documents VALUES(?,?,?)').run('extra', 'p', 'body');
        return { status: 'saved', documentId: 'extra' };
      },
      serialize,
    );
    expect(() => store.registerOutput('p', 't', 'first', 'different-tool', 2)).toThrow(
      'OUTPUT_IDENTITY_CONFLICT',
    );
    expect(() => store.registerOutput('p', 't', 'first', 'write', 1)).toThrow(
      'OUTPUT_ALREADY_COMMITTED',
    );
    db.close();
  });
});
