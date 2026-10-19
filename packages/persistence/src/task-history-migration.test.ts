import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  checkIntegrity,
  getSchemaVersion,
  migrateDatabase,
  openProjectDatabase,
} from './database.js';

it('upgrades v50 atomically, keeps equal-time input order stable and does not reassign sequences on updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'task-history-migration-'));
  const database = openProjectDatabase(join(root, 'project.sqlite'));
  try {
    migrateDatabase(database);
    database.exec(`DROP TABLE generation_supplements; DROP TABLE generation_branches;
      DROP TRIGGER conversation_message_sequence_insert; DROP TABLE conversation_message_sequences;
      DELETE FROM schema_migrations WHERE version>=51;
      INSERT INTO projects(id,name,created_at,updated_at) VALUES('project','Project','now','now');
      INSERT INTO conversations(id,project_id,scope_type,title,created_at,updated_at) VALUES('chat','project','project','Chat','now','now');
      INSERT INTO chat_messages(id,conversation_id,role,content,status,created_at) VALUES('b','chat','user','B','complete','now'),('a','chat','user','A','complete','now');
      CREATE TRIGGER fail_v51 BEFORE INSERT ON schema_migrations WHEN NEW.version=51 BEGIN SELECT RAISE(ABORT,'v51 failure'); END;`);
    expect(() => migrateDatabase(database)).toThrow('v51 failure');
    expect(getSchemaVersion(database)).toBe(50);
    expect(
      database.prepare("SELECT 1 FROM sqlite_master WHERE name='generation_branches'").get(),
    ).toBeUndefined();
    database.exec('DROP TRIGGER fail_v51');
    expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
    const before = database
      .prepare('SELECT * FROM conversation_message_sequences ORDER BY sequence')
      .all();
    expect(before).toEqual([
      { sequence: 1, message_id: 'a' },
      { sequence: 2, message_id: 'b' },
    ]);
    database.exec("UPDATE chat_messages SET content='edited' WHERE id='a'");
    migrateDatabase(database);
    expect(
      database.prepare('SELECT * FROM conversation_message_sequences ORDER BY sequence').all(),
    ).toEqual(before);
    expect(checkIntegrity(database).ok).toBe(true);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
