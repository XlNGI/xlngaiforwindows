import type Database from 'better-sqlite3';

export function applyMigrationV71(database: Database.Database): void {
  // A database can have the physical schema ahead of schema_migrations when a
  // previous migration was interrupted. Remove the v72 audit-dependent guard
  // before rebuilding the audit table so v71 remains retryable.
  database.exec(`
    DROP TRIGGER IF EXISTS document_audit_unpublish_user_only;
    DROP TRIGGER IF EXISTS documents_published_read_only_update;
    DROP TRIGGER IF EXISTS documents_published_read_only_insert;
    DROP TRIGGER IF EXISTS documents_publish_pointer_requires_publication;
    DROP TRIGGER IF EXISTS document_versions_published_read_only_insert;
    DROP TRIGGER IF EXISTS document_versions_published_read_only_update;
    DROP TRIGGER IF EXISTS document_versions_published_read_only_delete;
    DROP TRIGGER IF EXISTS document_bindings_published_read_only_insert;
    DROP TRIGGER IF EXISTS document_bindings_published_read_only_update;
    DROP TRIGGER IF EXISTS document_bindings_published_read_only_delete;
    DROP TRIGGER IF EXISTS document_reviews_published_read_only_insert;
    DROP TRIGGER IF EXISTS document_reviews_published_read_only_update;
    DROP TRIGGER IF EXISTS document_reviews_published_read_only_delete;
    DROP TRIGGER IF EXISTS document_publications_published_read_only_insert;
    DROP TRIGGER IF EXISTS document_publications_immutable_delete;
    DROP TRIGGER IF EXISTS document_version_research_sources_published_read_only_insert;
    DROP TRIGGER IF EXISTS document_version_research_sources_published_read_only_update;
    DROP TRIGGER IF EXISTS document_version_research_sources_published_read_only_delete;
    DROP TRIGGER IF EXISTS novel_chapters_published_read_only_insert;
    DROP TRIGGER IF EXISTS novel_chapters_published_read_only_update;
    DROP TRIGGER IF EXISTS novel_chapters_published_read_only_delete;
    DROP TRIGGER IF EXISTS documents_published_read_only_delete;
  `);
  const schemaObjects = database
    .prepare(
      `SELECT sql FROM sqlite_master
       WHERE tbl_name = 'document_audit_events'
         AND type IN ('index', 'trigger') AND sql IS NOT NULL
       ORDER BY type, name`,
    )
    .all() as Array<{ sql: string }>;

  database.exec(`
    CREATE TABLE document_audit_events_v71 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      action TEXT NOT NULL CHECK (action IN (
        'draft_saved', 'draft_restored', 'review_submitted',
        'review_changes_requested', 'review_rejected', 'published',
        'document_archived', 'document_unarchived'
      )),
      actor_type TEXT NOT NULL CHECK (
        actor_type IN ('user', 'agent', 'system', 'import', 'migration')
      ),
      actor_id TEXT CHECK (actor_id IS NULL OR length(actor_id) <= 256),
      document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      document_version_id TEXT NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
      source_version_id TEXT REFERENCES document_versions(id) ON DELETE SET NULL,
      review_id TEXT REFERENCES document_reviews(id) ON DELETE SET NULL,
      publication_id TEXT REFERENCES document_publications(id) ON DELETE SET NULL,
      task_id TEXT REFERENCES agent_tasks(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
        CHECK (
          json_valid(metadata_json)
          AND json_type(metadata_json) = 'object'
          AND length(metadata_json) <= 4096
        ),
      created_at TEXT NOT NULL,
      UNIQUE(project_id, sequence)
    );
    INSERT INTO document_audit_events_v71 SELECT * FROM document_audit_events;
    DROP TABLE document_audit_events;
    ALTER TABLE document_audit_events_v71 RENAME TO document_audit_events;
  `);

  for (const { sql } of schemaObjects) database.exec(sql);
}
