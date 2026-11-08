import type Database from 'better-sqlite3';

/** Install the database boundary for published-document immutability. */
export function applyMigrationV72(database: Database.Database): void {
  database.exec(`
    DROP TRIGGER IF EXISTS document_audit_unpublish_user_only;
    DROP TRIGGER IF EXISTS document_audit_published_read_only_insert;
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
    DROP TRIGGER IF EXISTS document_publication_immutable_update;
    DROP TRIGGER IF EXISTS document_publication_immutable_delete;
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
    CREATE TABLE document_audit_events_v72 (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL CHECK (sequence >= 0),
      action TEXT NOT NULL CHECK (action IN (
        'draft_saved', 'draft_restored', 'review_submitted',
        'review_changes_requested', 'review_rejected', 'published',
        'document_archived', 'document_unarchived', 'unpublished'
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
    INSERT INTO document_audit_events_v72 SELECT * FROM document_audit_events;
    DROP TABLE document_audit_events;
    ALTER TABLE document_audit_events_v72 RENAME TO document_audit_events;
  `);

  for (const { sql } of schemaObjects) database.exec(sql);

  database.exec(`
    CREATE TRIGGER document_audit_unpublish_user_only
    BEFORE INSERT ON document_audit_events
    WHEN NEW.action = 'unpublished'
      AND (document_mutation_allowed(NEW.document_id, 'unpublish') != 1
        OR NEW.actor_type != 'user' OR NOT EXISTS (
        SELECT 1 FROM documents
        WHERE documents.id = NEW.document_id
          AND documents.project_id = NEW.project_id
          AND documents.published_version_id = NEW.document_version_id
          AND json_type(NEW.metadata_json, '$.draftVersionId') = 'text'
      ))
    BEGIN
      SELECT RAISE(ABORT, 'unpublish audit requires the current published version and a user actor');
    END;

    CREATE TRIGGER document_audit_published_read_only_insert
    BEFORE INSERT ON document_audit_events
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE id = NEW.document_id AND published_version_id IS NOT NULL
    )
      AND NOT (
        (NEW.action = 'unpublished'
          AND document_mutation_allowed(NEW.document_id, 'unpublish') = 1
          AND NEW.actor_type = 'user'
          AND NEW.document_version_id = (
            SELECT published_version_id FROM documents WHERE id = NEW.document_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM document_audit_events existing
            WHERE existing.action = 'unpublished'
              AND existing.document_id = NEW.document_id
              AND existing.document_version_id = NEW.document_version_id
          )
          AND json_type(NEW.metadata_json, '$.draftVersionId') = 'text')
        OR
        (NEW.action = 'published'
          AND NEW.actor_type = 'user'
          AND NEW.document_version_id = (
            SELECT published_version_id FROM documents WHERE id = NEW.document_id
          )
          AND EXISTS (
            SELECT 1 FROM document_publications
            WHERE id = NEW.publication_id
              AND document_id = NEW.document_id
              AND document_version_id = NEW.document_version_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM document_audit_events existing
            WHERE existing.action = 'published'
              AND existing.publication_id = NEW.publication_id
          ))
      )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_publication_immutable_update
    BEFORE UPDATE ON document_publications
    BEGIN
      SELECT RAISE(ABORT, 'document publications are immutable');
    END;

    CREATE TRIGGER document_publication_immutable_delete
    BEFORE DELETE ON document_publications
    BEGIN
      SELECT RAISE(ABORT, 'document publications are immutable');
    END;

    DROP TRIGGER IF EXISTS novel_chapter_published_version_requires_publication;
    CREATE TRIGGER novel_chapter_published_version_requires_publication
    BEFORE UPDATE OF published_version_id ON documents
    WHEN NEW.published_version_id IS NOT NULL
      AND NEW.published_version_id IS NOT OLD.published_version_id
      AND EXISTS (SELECT 1 FROM novel_chapters WHERE document_id = NEW.id)
      AND NOT EXISTS (
        SELECT 1 FROM document_publications
        WHERE document_id = NEW.id AND document_version_id = NEW.published_version_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'novel chapter publication requires a publication snapshot');
    END;

    CREATE TRIGGER documents_published_read_only_update
    BEFORE UPDATE ON documents
    WHEN OLD.published_version_id IS NOT NULL
      AND NOT (
        document_mutation_allowed(OLD.id, 'unpublish') = 1
        AND NEW.id IS OLD.id
        AND NEW.project_id IS OLD.project_id
        AND NEW.kind IS OLD.kind
        AND NEW.title IS OLD.title
        AND NEW.scope_type IS OLD.scope_type
        AND NEW.scope_id IS OLD.scope_id
        AND NEW.lifecycle_status IS OLD.lifecycle_status
        AND NEW.created_at IS OLD.created_at
        AND NEW.published_version_id IS NULL
        AND NEW.current_version_id IS NOT OLD.current_version_id
        AND NEW.row_version = OLD.row_version + 1
        AND EXISTS (
          SELECT 1 FROM document_audit_events
          WHERE action = 'unpublished'
            AND actor_type = 'user'
            AND document_id = OLD.id
            AND document_version_id = OLD.published_version_id
            AND json_extract(metadata_json, '$.draftVersionId') = NEW.current_version_id
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER documents_published_read_only_delete
    BEFORE DELETE ON documents
    WHEN OLD.published_version_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER documents_published_read_only_insert
    BEFORE INSERT ON documents
    WHEN NEW.published_version_id IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'published document must be published by the document workflow');
    END;

    CREATE TRIGGER documents_publish_pointer_requires_publication
    BEFORE UPDATE OF published_version_id ON documents
    WHEN NEW.published_version_id IS NOT NULL
      AND NEW.published_version_id IS NOT OLD.published_version_id
      AND NOT EXISTS (
        SELECT 1 FROM document_publications publications
        INNER JOIN document_versions versions
          ON versions.id = publications.document_version_id
        WHERE publications.document_id = NEW.id
          AND publications.project_id = NEW.project_id
          AND publications.document_version_id = NEW.published_version_id
          AND versions.state = 'published'
      )
    BEGIN
      SELECT RAISE(ABORT, 'document publication record is required');
    END;

    CREATE TRIGGER document_versions_published_read_only_insert
    BEFORE INSERT ON document_versions
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = NEW.document_id
        AND documents.published_version_id IS NOT NULL
    )
      AND NOT (
        document_mutation_allowed(NEW.document_id, 'unpublish') = 1
        AND NEW.state = 'draft'
        AND EXISTS (
          SELECT 1 FROM documents
          INNER JOIN document_audit_events audit
            ON audit.document_id = documents.id
          WHERE documents.id = NEW.document_id
            AND documents.published_version_id = audit.document_version_id
            AND audit.action = 'unpublished'
            AND audit.actor_type = 'user'
            AND json_extract(audit.metadata_json, '$.draftVersionId') = NEW.id
            AND NEW.base_version_id IS NULL
            AND NEW.content_markdown = (
              SELECT published.content_markdown FROM documents
              INNER JOIN document_versions published
                ON published.id = documents.published_version_id
              WHERE documents.id = NEW.document_id
            )
            AND NEW.content_ir_json IS (
              SELECT published.content_ir_json FROM documents
              INNER JOIN document_versions published
                ON published.id = documents.published_version_id
              WHERE documents.id = NEW.document_id
            )
            AND NEW.title_snapshot IS coalesce((
              SELECT published.title_snapshot FROM documents
              INNER JOIN document_versions published
                ON published.id = documents.published_version_id
              WHERE documents.id = NEW.document_id
            ), (SELECT title FROM documents WHERE id = NEW.document_id))
            AND NEW.scope_type_snapshot IS coalesce((
              SELECT published.scope_type_snapshot FROM documents
              INNER JOIN document_versions published
                ON published.id = documents.published_version_id
              WHERE documents.id = NEW.document_id
            ), (SELECT scope_type FROM documents WHERE id = NEW.document_id))
            AND NEW.scope_id_snapshot IS coalesce((
              SELECT published.scope_id_snapshot FROM documents
              INNER JOIN document_versions published
                ON published.id = documents.published_version_id
              WHERE documents.id = NEW.document_id
            ), (SELECT scope_id FROM documents WHERE id = NEW.document_id))
            AND NEW.author_type = 'user'
        )
      )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_versions_published_read_only_update
    BEFORE UPDATE ON document_versions
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id IN (OLD.document_id, NEW.document_id)
        AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_versions_published_read_only_delete
    BEFORE DELETE ON document_versions
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = OLD.document_id
        AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_bindings_published_read_only_insert
    BEFORE INSERT ON document_bindings
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = NEW.document_id
        AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_bindings_published_read_only_update
    BEFORE UPDATE ON document_bindings
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id IN (OLD.document_id, NEW.document_id)
        AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_bindings_published_read_only_delete
    BEFORE DELETE ON document_bindings
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = OLD.document_id
        AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_reviews_published_read_only_insert
    BEFORE INSERT ON document_reviews
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = NEW.document_id
        AND documents.published_version_id IS NOT NULL
    )

    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_reviews_published_read_only_update
    BEFORE UPDATE ON document_reviews
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id IN (OLD.document_id, NEW.document_id)
        AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_reviews_published_read_only_delete
    BEFORE DELETE ON document_reviews
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = OLD.document_id AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_publications_published_read_only_insert
    BEFORE INSERT ON document_publications
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = NEW.document_id AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_version_research_sources_published_read_only_insert
    BEFORE INSERT ON document_version_research_sources
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = NEW.document_id AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_version_research_sources_published_read_only_update
    BEFORE UPDATE ON document_version_research_sources
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id IN (OLD.document_id, NEW.document_id)
        AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER document_version_research_sources_published_read_only_delete
    BEFORE DELETE ON document_version_research_sources
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = OLD.document_id AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER novel_chapters_published_read_only_insert
    BEFORE INSERT ON novel_chapters
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = NEW.document_id AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER novel_chapters_published_read_only_update
    BEFORE UPDATE ON novel_chapters
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id IN (OLD.document_id, NEW.document_id)
        AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;

    CREATE TRIGGER novel_chapters_published_read_only_delete
    BEFORE DELETE ON novel_chapters
    WHEN EXISTS (
      SELECT 1 FROM documents
      WHERE documents.id = OLD.document_id AND documents.published_version_id IS NOT NULL
    )
    BEGIN
      SELECT RAISE(ABORT, 'published document is read-only');
    END;
  `);
}
