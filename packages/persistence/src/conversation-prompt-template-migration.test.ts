import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSchemaVersion, migrateDatabase, openProjectDatabase } from './database.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';
import { MIGRATION_V55 } from './migration-v55.js';

describe('conversation prompt template migration', () => {
  it('creates a project-scoped template table and rolls back v55 atomically', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'conversation-prompt-template-'));
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    try {
      migrateDatabase(database);
      expect(getSchemaVersion(database)).toBe(CURRENT_SCHEMA_VERSION);
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='conversation_prompt_templates'",
          )
          .get(),
      ).toBeTruthy();
      database.exec(`
        INSERT INTO projects(id,name,created_at,updated_at) VALUES('a','A','now','now'),('b','B','now','now');
        INSERT INTO conversations(id,project_id,scope_type,title,created_at,updated_at) VALUES('chat','a','project','Chat','now','now');
      `);
      const insert = database.prepare(`INSERT INTO conversation_prompt_templates
        (conversation_id,project_id,content,row_version,created_at,updated_at) VALUES(?,?,?,1,'now','now')`);
      expect(() => insert.run('chat', 'b', 'foreign')).toThrow('project mismatch');
      insert.run('chat', 'a', 'x'.repeat(100_001));
      expect(() =>
        database.prepare('UPDATE conversation_prompt_templates SET project_id=?').run('b'),
      ).toThrow('project mismatch');
      database.prepare('DELETE FROM conversations WHERE id=?').run('chat');
      expect(database.prepare('SELECT * FROM conversation_prompt_templates').all()).toEqual([]);
      database.exec(
        `DROP INDEX IF EXISTS idx_conversation_prompt_templates_project;
         DROP TRIGGER IF EXISTS conversation_prompt_templates_project_insert;
         DROP TRIGGER IF EXISTS conversation_prompt_templates_project_update;
         DROP TABLE conversation_prompt_templates;
         DELETE FROM schema_migrations WHERE version >= 55;
         CREATE TABLE conversation_prompt_templates (conflict TEXT);`,
      );
      expect(() => migrateDatabase(database)).toThrow();
      expect(getSchemaVersion(database)).toBe(54);
      expect(
        database
          .prepare("SELECT sql FROM sqlite_master WHERE name='conversation_prompt_templates'")
          .get(),
      ).toEqual({ sql: 'CREATE TABLE conversation_prompt_templates (conflict TEXT)' });
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('upgrades v72 templates without changing content or versions and rolls back a failed v73', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'conversation-prompt-unbounded-'));
    const database = openProjectDatabase(join(directory, 'project.sqlite'));
    try {
      migrateDatabase(database);
      database.exec(`DROP TABLE conversation_prompt_templates;
        DELETE FROM schema_migrations WHERE version > 72;`);
      database.exec(MIGRATION_V55);
      database.exec(`INSERT INTO projects(id,name,created_at,updated_at) VALUES('a','A','before','before'),('b','B','before','before');
        INSERT INTO conversations(id,project_id,scope_type,title,created_at,updated_at) VALUES('chat','a','project','Chat','before','before');
        INSERT INTO conversation_prompt_templates VALUES('chat','a','完整约束',7,'created','updated');`);
      const original = database.prepare('SELECT * FROM conversation_prompt_templates').get();
      // Fail after rebuilding the table to verify both schema and contents roll back.
      database.exec(`CREATE TRIGGER fail_template_upgrade BEFORE INSERT ON schema_migrations
        WHEN NEW.version=73 BEGIN SELECT RAISE(ABORT,'injected v73 failure'); END;`);
      expect(() => migrateDatabase(database)).toThrow();
      expect(getSchemaVersion(database)).toBe(72);
      expect(database.prepare('SELECT * FROM conversation_prompt_templates').get()).toEqual(
        original,
      );
      expect(() =>
        database
          .prepare('UPDATE conversation_prompt_templates SET content=?')
          .run('x'.repeat(20_001)),
      ).toThrow();
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='conversation_prompt_templates_unbounded'",
          )
          .get(),
      ).toBeUndefined();
      database.exec('DROP TRIGGER fail_template_upgrade');
      expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
      expect(migrateDatabase(database)).toBe(CURRENT_SCHEMA_VERSION);
      expect(database.prepare('SELECT * FROM conversation_prompt_templates').get()).toEqual(
        original,
      );
      const complete = '原始要求不截断'.repeat(20_000);
      database.prepare('UPDATE conversation_prompt_templates SET content=?').run(complete);
      expect(database.prepare('SELECT content FROM conversation_prompt_templates').get()).toEqual({
        content: complete,
      });
      expect(() =>
        database.prepare("UPDATE conversation_prompt_templates SET project_id='b'").run(),
      ).toThrow('project mismatch');
      expect(() =>
        database.prepare('UPDATE conversation_prompt_templates SET row_version=-1').run(),
      ).toThrow();
      expect(database.pragma('foreign_key_check')).toEqual([]);
      database.prepare("DELETE FROM conversations WHERE id='chat'").run();
      expect(database.prepare('SELECT * FROM conversation_prompt_templates').all()).toEqual([]);
    } finally {
      database.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
