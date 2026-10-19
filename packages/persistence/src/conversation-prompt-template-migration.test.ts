import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSchemaVersion, migrateDatabase, openProjectDatabase } from './database.js';
import { CURRENT_SCHEMA_VERSION } from './schema.js';

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
      expect(() => insert.run('chat', 'a', 'x'.repeat(20_001))).toThrow();
      insert.run('chat', 'a', '');
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
});
