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
  MIGRATION_V6,
  MIGRATION_V7,
  MIGRATION_V8,
  MIGRATION_V9,
  MIGRATION_V10,
  MIGRATION_V11,
  MIGRATION_V12,
  MIGRATION_V13,
  migrateDatabase,
  openProjectDatabase,
  rewriteLegacyContextSnapshots,
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
    expect(migrateDatabase(database)).toBe(16);
    expect(checkIntegrity(database)).toMatchObject({ ok: true, schemaVersion: 16 });
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('generation_jobs') WHERE name = ?")
        .get('metadata_json'),
    ).toMatchObject({ name: 'metadata_json' });
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('conversations') WHERE name = ?")
        .get('archived_at'),
    ).toMatchObject({ name: 'archived_at' });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('llm_generation_attempts'),
    ).toMatchObject({ name: 'llm_generation_attempts' });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('llm_generations'),
    ).toMatchObject({ name: 'llm_generations' });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('agent_tasks'),
    ).toMatchObject({ name: 'agent_tasks' });
    expect(
      database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get('document_audit_events'),
    ).toMatchObject({ name: 'document_audit_events' });
    expect(
      database
        .prepare("SELECT name FROM pragma_table_info('documents') WHERE name = ?")
        .get('published_version_id'),
    ).toMatchObject({ name: 'published_version_id' });
    database.close();
  });

  it('rewrites legacy context snapshots to manifests', async () => {
    const database = await temporaryDatabase();
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Manifest', 'now', 'now');
    database
      .prepare(
        `INSERT INTO context_snapshots (id, project_id, purpose, content_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        'legacy-snapshot',
        'project',
        'llm-generation',
        JSON.stringify({
          version: 1,
          projectId: 'project',
          projectName: 'Manifest',
          scope: { type: 'project', label: '项目' },
          systemInstruction: 'secret-instruction',
          rendered: 'full-rendered-body',
          estimatedTokens: 100,
          budgetTokens: 1_000,
          sources: [
            {
              id: 'document',
              type: 'document',
              scopeType: 'project',
              label: 'Doc',
              version: 1,
              versionId: 'version-1',
              originalCharacters: 10,
              includedCharacters: 10,
              truncated: false,
              content: 'full-document-body',
            },
          ],
        }),
        'now',
      );

    expect(rewriteLegacyContextSnapshots(database)).toBe(1);
    const row = database
      .prepare('SELECT content_json FROM context_snapshots WHERE id = ?')
      .get('legacy-snapshot') as { content_json: string };
    const manifest = JSON.parse(row.content_json) as Record<string, unknown>;
    expect(manifest).toMatchObject({ version: 1, projectId: 'project' });
    expect(row.content_json).not.toContain('secret-instruction');
    expect(row.content_json).not.toContain('full-rendered-body');
    expect(row.content_json).not.toContain('full-document-body');
    expect((manifest.sources as Array<Record<string, unknown>>)[0]).toMatchObject({
      id: 'document',
      versionId: 'version-1',
    });
    database.close();
  });

  it('enforces conversation scope and chat message invariants', async () => {
    const database = await temporaryDatabase();
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Constraints', 'now', 'now');

    expect(() =>
      database
        .prepare(
          `INSERT INTO conversations
           (id, project_id, scope_type, scope_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('invalid-project', 'project', 'project', 'scene', 'Invalid', 'now', 'now'),
    ).toThrow('invalid conversation scope');
    expect(() =>
      database
        .prepare(
          `INSERT INTO conversations
           (id, project_id, scope_type, scope_id, title, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('invalid-scene', 'project', 'scene', null, 'Invalid', 'now', 'now'),
    ).toThrow('invalid conversation scope');

    database
      .prepare(
        `INSERT INTO conversations
         (id, project_id, scope_type, scope_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('conversation', 'project', 'project', null, 'Valid', 'now', 'now');
    expect(() =>
      database
        .prepare(
          `INSERT INTO chat_messages
           (id, conversation_id, role, content, status, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('invalid-message', 'conversation', 'user', 'Pending', 'streaming', 'now'),
    ).toThrow('invalid chat message state');
    database.close();
  });

  it('prevents terminal LLM and message states from returning to active states', async () => {
    const database = await temporaryDatabase();
    migrateDatabase(database);
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Transitions', 'now', 'now');
    database
      .prepare(
        `INSERT INTO conversations
         (id, project_id, scope_type, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('conversation', 'project', 'project', 'Transitions', 'now', 'now');
    database
      .prepare(
        `INSERT INTO chat_messages
         (id, conversation_id, role, content, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'user',
        'conversation',
        'user',
        'Prompt',
        'complete',
        'now',
        'assistant',
        'conversation',
        'assistant',
        'Response',
        'complete',
        'now',
      );
    database
      .prepare(
        `INSERT INTO context_snapshots (id, project_id, purpose, content_json, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('snapshot', 'project', 'llm-generation', '{}', 'now');
    database
      .prepare(
        `INSERT INTO llm_generations
         (id, project_id, project_session_id, conversation_id, context_snapshot_id,
          user_message_id, assistant_message_id, status, execution_mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'generation',
        'project',
        'session',
        'conversation',
        'snapshot',
        'user',
        'assistant',
        'complete',
        'native',
        'now',
        'now',
      );

    expect(() =>
      database
        .prepare("UPDATE llm_generations SET status = 'streaming' WHERE id = ?")
        .run('generation'),
    ).toThrow('invalid llm generation transition');
    expect(() =>
      database
        .prepare("UPDATE chat_messages SET status = 'streaming' WHERE id = ?")
        .run('assistant'),
    ).toThrow('invalid chat message transition');
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

    expect(migrateDatabase(database)).toBe(16);
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

    expect(migrateDatabase(database)).toBe(16);
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

    expect(migrateDatabase(database)).toBe(16);
    expect(database.prepare('SELECT source_url FROM assets WHERE id = ?').get('asset')).toEqual({
      source_url: 'https://cdn.example/frame.png',
    });
    expect(
      database.prepare('SELECT provider_url FROM generation_results WHERE id = ?').get('result'),
    ).toEqual({ provider_url: 'https://cdn.example/frame.png' });
    database.close();
  });

  it('upgrades v11 documents with an authoritative published version and migration publication', async () => {
    const database = await temporaryDatabase();
    for (const [version, migration] of [
      [1, MIGRATION_V1],
      [2, MIGRATION_V2],
      [3, MIGRATION_V3],
      [4, MIGRATION_V4],
      [5, MIGRATION_V5],
      [6, MIGRATION_V6],
      [7, MIGRATION_V7],
      [8, MIGRATION_V8],
      [9, MIGRATION_V9],
      [10, MIGRATION_V10],
      [11, MIGRATION_V11],
    ] as const) {
      database.exec(migration);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, `v${version}`);
    }
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Legacy project', 'now', 'now');
    database
      .prepare(
        `INSERT INTO documents
         (id, project_id, kind, title, current_version_id, scope_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('document', 'project', 'note', 'Legacy document', 'version', 'project', 'now', 'later');
    database
      .prepare(
        `INSERT INTO document_versions (id, document_id, version, content_markdown, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('version', 'document', 1, '# Legacy', 'now');

    expect(getSchemaVersion(database)).toBe(11);
    expect(migrateDatabase(database)).toBe(16);
    expect(
      database
        .prepare(
          `SELECT published_version_id, lifecycle_status, row_version
           FROM documents WHERE id = ?`,
        )
        .get('document'),
    ).toEqual({ published_version_id: 'version', lifecycle_status: 'active', row_version: 0 });
    expect(
      database
        .prepare(
          `SELECT state, title_snapshot, scope_type_snapshot, state_updated_at
           FROM document_versions WHERE id = ?`,
        )
        .get('version'),
    ).toEqual({
      state: 'published',
      title_snapshot: 'Legacy document',
      scope_type_snapshot: 'project',
      state_updated_at: 'now',
    });
    expect(
      database
        .prepare(
          `SELECT document_version_id, published_by_type
           FROM document_publications WHERE document_id = ?`,
        )
        .get('document'),
    ).toEqual({ document_version_id: 'version', published_by_type: 'migration' });
    database.close();
  });

  it('migrates v12 projects to a bounded immutable document audit trail', async () => {
    const database = await temporaryDatabase();
    for (const [version, migration] of [
      [1, MIGRATION_V1],
      [2, MIGRATION_V2],
      [3, MIGRATION_V3],
      [4, MIGRATION_V4],
      [5, MIGRATION_V5],
      [6, MIGRATION_V6],
      [7, MIGRATION_V7],
      [8, MIGRATION_V8],
      [9, MIGRATION_V9],
      [10, MIGRATION_V10],
      [11, MIGRATION_V11],
      [12, MIGRATION_V12],
    ] as const) {
      database.exec(migration);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, `v${version}`);
    }
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'Audit project', 'now', 'now');
    database
      .prepare(
        `INSERT INTO documents
         (id, project_id, kind, title, scope_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('document', 'project', 'note', 'Audit document', 'project', 'now', 'now');
    database
      .prepare(
        `INSERT INTO document_versions
         (id, document_id, version, content_markdown, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('version', 'document', 1, '# Audit', 'now');

    expect(getSchemaVersion(database)).toBe(12);
    expect(migrateDatabase(database)).toBe(16);
    expect(migrateDatabase(database)).toBe(16);
    const insert = database.prepare(
      `INSERT INTO document_audit_events
       (id, project_id, sequence, action, actor_type, actor_id, document_id,
        document_version_id, source_version_id, review_id, publication_id, task_id,
        metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      'audit-1',
      'project',
      0,
      'draft_saved',
      'user',
      'local-user',
      'document',
      'version',
      null,
      null,
      null,
      null,
      '{}',
      'later',
    );
    expect(database.prepare('SELECT action, sequence FROM document_audit_events').get()).toEqual({
      action: 'draft_saved',
      sequence: 0,
    });
    expect(() =>
      database
        .prepare('UPDATE document_audit_events SET action = ? WHERE id = ?')
        .run('published', 'audit-1'),
    ).toThrow('document audit events are immutable');
    expect(() =>
      database.prepare('DELETE FROM document_audit_events WHERE id = ?').run('audit-1'),
    ).toThrow('document audit events are immutable');
    expect(() =>
      insert.run(
        'audit-2',
        'project',
        1,
        'draft_saved',
        'user',
        'local-user',
        'document',
        'version',
        null,
        null,
        null,
        null,
        JSON.stringify({ value: 'x'.repeat(4_097) }),
        'later',
      ),
    ).toThrow();
    database.close();
  });

  it('rebuilds v13 Agent evidence without retaining tool request or result bodies', async () => {
    const database = await temporaryDatabase();
    for (const [version, migration] of [
      [1, MIGRATION_V1],
      [2, MIGRATION_V2],
      [3, MIGRATION_V3],
      [4, MIGRATION_V4],
      [5, MIGRATION_V5],
      [6, MIGRATION_V6],
      [7, MIGRATION_V7],
      [8, MIGRATION_V8],
      [9, MIGRATION_V9],
      [10, MIGRATION_V10],
      [11, MIGRATION_V11],
      [12, MIGRATION_V12],
      [13, MIGRATION_V13],
    ] as const) {
      database.exec(migration);
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, `v${version}`);
    }
    database
      .prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project', 'v13 Agent project', 'now', 'now');
    database
      .prepare(
        `INSERT INTO documents (id, project_id, kind, title, scope_type, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('document', 'project', 'note', 'Draft', 'project', 'now', 'now');
    database
      .prepare(
        `INSERT INTO agent_tasks
         (id, project_id, project_session_id, task_type, scope_type, title,
          request_snapshot_json, request_hash, status, created_at, updated_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'task',
        'project',
        'session',
        'document-create',
        'project',
        'Create draft',
        '{}',
        'request-hash',
        'waiting_review',
        'now',
        'later',
        7,
      );
    database
      .prepare(
        `INSERT INTO document_versions
         (id, document_id, version, content_markdown, state, title_snapshot, scope_type_snapshot,
          author_type, source_task_id, state_updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'version',
        'document',
        1,
        '# Secret draft',
        'draft',
        'Draft',
        'project',
        'agent',
        'task',
        'now',
        'now',
      );
    database
      .prepare(
        `INSERT INTO agent_task_document_versions
         (task_id, document_id, document_version_id, operation, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('task', 'document', 'version', 'create', 'now');
    database
      .prepare(
        `INSERT INTO agent_tool_calls
         (id, task_id, tool_name, arguments_json, arguments_hash, result_json, status,
          created_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'call',
        'task',
        'document.create',
        '{"content":"secret"}',
        'arguments-hash',
        '{"content":"secret"}',
        'succeeded',
        'now',
        2,
      );

    expect(migrateDatabase(database)).toBe(16);
    expect(
      database.prepare("SELECT row_version, phase FROM agent_tasks WHERE id = 'task'").get(),
    ).toEqual({
      row_version: 7,
      phase: 'waiting_review',
    });
    expect(
      database
        .prepare(
          "SELECT redaction_state, idempotency_key, arguments_summary_json, result_summary_json FROM agent_tool_calls WHERE id = 'call'",
        )
        .get(),
    ).toEqual({
      redaction_state: 'legacy_redacted',
      idempotency_key: 'legacy:call',
      arguments_summary_json: '{"legacy":1,"toolName":"document.create"}',
      result_summary_json: null,
    });
    expect(
      database
        .prepare(
          "SELECT document_id, document_version_id, disposition FROM agent_task_document_artifacts WHERE task_id = 'task'",
        )
        .get(),
    ).toEqual({ document_id: 'document', document_version_id: 'version', disposition: 'draft' });
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM pragma_table_info('agent_tool_calls') WHERE name IN ('arguments_json', 'result_json')",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE sql LIKE '%__v13_old_%'")
        .get(),
    ).toEqual({ count: 0 });
    expect(checkIntegrity(database)).toMatchObject({ ok: true, schemaVersion: 16 });
    database.close();
  });
});
