import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { getSchemaVersion, migrateDatabase, openProjectDatabase } from './database.js';

it('upgrades v56 authorization quotas atomically while preserving audits and other tool limits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'library-authorization-migration-'));
  const db = openProjectDatabase(join(directory, 'project.sqlite'));
  try {
    migrateDatabase(db);
    // Restore the actual v56 table constraint before populating the legacy fixture.
    const { sql } = db
      .prepare("SELECT sql FROM sqlite_master WHERE name = 'agent_tool_authorizations'")
      .get() as { sql: string };
    const objects = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE tbl_name = 'agent_tool_authorizations' AND type IN ('index', 'trigger') AND sql IS NOT NULL",
      )
      .all() as Array<{ sql: string }>;
    db.pragma('foreign_keys = OFF');
    db.exec('DROP TABLE agent_tool_authorizations');
    db.exec(
      sql.replace(
        "CHECK (max_call_uses BETWEEN 1 AND CASE WHEN allowed_operation = 'library.read' THEN 16 ELSE 8 END)",
        'CHECK (max_call_uses BETWEEN 1 AND 8)',
      ),
    );
    for (const object of objects) db.exec(object.sql);
    db.pragma('foreign_keys = ON');
    db.exec(`
      DELETE FROM schema_migrations WHERE version >= 57;
      INSERT INTO projects(id,name,created_at,updated_at) VALUES('p','Legacy','now','now');
      INSERT INTO conversations(id,project_id,scope_type,title,created_at,updated_at) VALUES('c','p','project','Sources','now','now');
      INSERT INTO chat_messages(id,conversation_id,role,content,status,created_at) VALUES('u','c','user','Read sources','complete','now'),('a','c','assistant','','streaming','now');
      INSERT INTO context_snapshots(id,project_id,purpose,content_json,created_at) VALUES('snapshot','p','llm-generation','{}','now');
      INSERT INTO llm_generations(id,project_id,project_session_id,conversation_id,context_snapshot_id,user_message_id,assistant_message_id,status,execution_mode,created_at,updated_at) VALUES('g','p','session','c','snapshot','u','a','streaming','native','now','now');
      INSERT INTO llm_generation_attempts(id,generation_id,conversation_id,user_message_id,assistant_message_id,context_snapshot_id,provider_name_snapshot,model_name_snapshot,protocol,status,started_at) VALUES('attempt','g','c','u','a','snapshot','Provider','Model','openai-responses','streaming','now');
      INSERT INTO agent_tasks(id,project_id,project_session_id,conversation_id,task_type,scope_type,title,request_snapshot_json,request_hash,status,created_at,updated_at,phase,tool_call_count) VALUES('task','p','session','c','document-query','project','Read sources','{}','hash','running','now','now','model_running',6);
      INSERT INTO agent_task_generations(task_id,generation_id,ordinal,purpose,created_at) VALUES('task','g',0,'primary','now');
      INSERT INTO llm_provider_steps(id,project_id,generation_id,attempt_id,ordinal,protocol,status,request_hash,started_at) VALUES('step','p','g','attempt',0,'openai-responses','in_flight','hash','now');
      INSERT INTO agent_tool_authorizations(id,project_id,task_id,generation_id,attempt_id,provider_step_id,project_session_id,allowed_operation,policy_version,tool_schema_version,authorization_handle_hash,status,max_call_uses,used_call_count,expires_at,created_at)
        VALUES('read','p','task','g','attempt','step','session','library.read','v2','v2','handle','issued',6,6,'later','now');
      INSERT INTO agent_tool_calls(id,project_id,task_id,generation_id,attempt_id,authorization_id,provider_step_id,provider_call_id,tool_ordinal,tool_name,normalized_arguments_hash,arguments_summary_json,status,created_at,redaction_state)
        VALUES('call','p','task','g','attempt','read','step','provider-call',0,'library.read','hash','{}','succeeded','now','native');
      CREATE TRIGGER fail_v57 BEFORE INSERT ON schema_migrations WHEN NEW.version=57 BEGIN SELECT RAISE(ABORT,'v57 failure'); END;
    `);
    const snapshot = () => ({
      authorizations: db.prepare('SELECT * FROM agent_tool_authorizations').all(),
      calls: db.prepare('SELECT * FROM agent_tool_calls').all(),
      tasks: db.prepare('SELECT * FROM agent_tasks').all(),
    });
    const before = snapshot();
    expect(() => migrateDatabase(db)).toThrow('v57 failure');
    expect(getSchemaVersion(db)).toBe(56);
    expect(snapshot()).toEqual(before);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(db.pragma('legacy_alter_table', { simple: true })).toBe(0);
    const setQuota = db.prepare(
      "UPDATE agent_tool_authorizations SET allowed_operation = ?, max_call_uses = ? WHERE id = 'read'",
    );
    expect(() => setQuota.run('library.read', 16)).toThrow();
    db.exec('DROP TRIGGER fail_v57');
    expect(migrateDatabase(db)).toBe(58);
    expect(snapshot()).toEqual(before);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE sql LIKE '%__v56_old_authorizations%'")
        .all(),
    ).toEqual([]);
    expect(() => setQuota.run('library.read', 16)).not.toThrow();
    expect(() => setQuota.run('library.read', 17)).toThrow();
    expect(() => setQuota.run('library.search', 9)).toThrow();
    expect(() => setQuota.run('document.create_draft', 9)).toThrow();
    expect(() =>
      db
        .prepare("UPDATE agent_tool_authorizations SET used_call_count = 17 WHERE id = 'read'")
        .run(),
    ).toThrow();
    expect(() =>
      db.prepare("DELETE FROM agent_tool_authorizations WHERE id = 'read'").run(),
    ).toThrow('FOREIGN KEY');
    expect(() =>
      db.exec(
        `INSERT INTO agent_tool_authorizations SELECT 'foreign', project_id, task_id, generation_id, attempt_id, provider_step_id, 'wrong-session', allowed_operation, target_document_id, scope_type, scope_id, base_version_id, expected_document_row_version, policy_version, tool_schema_version, authorization_handle_hash, status, max_call_uses, used_call_count, expires_at, revoked_at, row_version, created_at FROM agent_tool_authorizations WHERE id='read'`,
      ),
    ).toThrow('does not match');
    expect(migrateDatabase(db)).toBe(58);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
