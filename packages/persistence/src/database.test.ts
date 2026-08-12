import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkIntegrity,
  getSchemaVersion,
  MIGRATION_V1,
  MIGRATION_V2,
  MIGRATION_V3,
  MIGRATION_V4,
  MIGRATION_V5,
  migrateDatabase,
  openProjectDatabase,
} from './index.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function temporaryDatabase() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-persistence-'));
  temporaryDirectories.push(directory);
  return openProjectDatabase(join(directory, 'project.sqlite'));
}

describe('project database', () => {
  it('migrates an empty database to the current schema', async () => {
    const database = await temporaryDatabase();
    expect(getSchemaVersion(database)).toBe(0);
    expect(migrateDatabase(database)).toBe(10);
    expect(checkIntegrity(database)).toMatchObject({ ok: true, schemaVersion: 10 });
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('generation_jobs') WHERE name = ?")
        .get('metadata_json'),
    ).toMatchObject({ name: 'metadata_json' });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('llm_generation_attempts'),
    ).toMatchObject({ name: 'llm_generation_attempts' });
    database.close();
  });

  it('rolls back a partially failed business transaction', async () => {
    const database = await temporaryDatabase();
    migrateDatabase(database);
    const insertProject = database.prepare(
      'INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)',
    );
    expect(() =>
      database.transaction(() => {
        insertProject.run('one', 'One', 'now', 'now');
        insertProject.run('one', 'Duplicate', 'now', 'now');
      })(),
    ).toThrow();
    const row = database.prepare('SELECT COUNT(*) AS count FROM projects').get() as {
      count: number;
    };
    expect(row.count).toBe(0);
    database.close();
  });

  it('enforces foreign keys', async () => {
    const database = await temporaryDatabase();
    migrateDatabase(database);
    expect(() =>
      database
        .prepare(
          'INSERT INTO documents (id, project_id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('doc', 'missing', 'outline', 'Outline', 'now', 'now'),
    ).toThrow();
    database.close();
  });

  it('migrates an existing v1 project and preserves its documents', async () => {
    const database = await temporaryDatabase();
    database.exec(MIGRATION_V1);
    database
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)')
      .run('now');
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Legacy', 'now', 'now');
    database
      .prepare(
        'INSERT INTO documents (id, project_id, kind, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('document', 'project', 'outline', 'Legacy Outline', 'now', 'now');

    expect(migrateDatabase(database)).toBe(10);
    expect(
      database.prepare('SELECT title, scope_type FROM documents WHERE id = ?').get('document'),
    ).toMatchObject({ title: 'Legacy Outline', scope_type: 'project' });
    database.close();
  });

  it('migrates v2 chat messages and adds a durable reply association', async () => {
    const database = await temporaryDatabase();
    database.exec(MIGRATION_V1);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)').run('v1');
    database.exec(MIGRATION_V2);
    database.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)').run('v2');
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'V2 Project', 'now', 'now');
    database
      .prepare(
        'INSERT INTO conversations (id, project_id, scope_type, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('conversation', 'project', 'project', 'Chat', 'now', 'now');
    database
      .prepare(
        'INSERT INTO chat_messages (id, conversation_id, role, content, status, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('assistant', 'conversation', 'assistant', 'Legacy reply', 'complete', 'now');

    expect(migrateDatabase(database)).toBe(10);
    expect(
      database
        .prepare('SELECT content, reply_to_message_id FROM chat_messages WHERE id = ?')
        .get('assistant'),
    ).toMatchObject({ content: 'Legacy reply', reply_to_message_id: null });
    database.close();
  });

  it('removes signed query parameters from URL fields when migrating v5 projects', async () => {
    const database = await temporaryDatabase();
    for (const [version, migration] of [
      [1, MIGRATION_V1],
      [2, MIGRATION_V2],
      [3, MIGRATION_V3],
      [4, MIGRATION_V4],
      [5, MIGRATION_V5],
    ] as const) {
      database.exec(migration);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, `v${version}`);
    }
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Signed URL Project', 'now', 'now');
    database
      .prepare(
        `INSERT INTO assets
         (id, project_id, kind, relative_path, content_hash, size_bytes, source_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'asset',
        'project',
        'generated-image',
        'assets/images/frame.png',
        'hash',
        1,
        'https://cdn.example/frame.png?X-Amz-Signature=asset-secret#fragment',
        'now',
      );
    database
      .prepare(
        `INSERT INTO generation_jobs
         (id, project_id, adapter_key, status, request_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('job', 'project', 'TEXT_TO_IMAGE:test:model:v1', 'succeeded', '{}', 'now', 'now');
    database
      .prepare(
        `INSERT INTO generation_results (id, job_id, asset_id, provider_url, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'result',
        'job',
        'asset',
        'https://cdn.example/frame.png?X-Amz-Signature=result-secret#fragment',
        'now',
      );

    expect(migrateDatabase(database)).toBe(10);
    expect(database.prepare('SELECT source_url FROM assets WHERE id = ?').get('asset')).toEqual({
      source_url: 'https://cdn.example/frame.png',
    });
    expect(
      database.prepare('SELECT provider_url FROM generation_results WHERE id = ?').get('result'),
    ).toEqual({ provider_url: 'https://cdn.example/frame.png' });
    database.close();
  });
});
