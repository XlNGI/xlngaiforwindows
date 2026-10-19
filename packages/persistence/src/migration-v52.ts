/** Chapter batches reference existing Agent/generation owners; no duplicate business terminal state. */
export const MIGRATION_V52 = `
CREATE TABLE IF NOT EXISTS novel_task_batches (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  parent_task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  execution_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(project_id,parent_task_id,execution_key)
);
CREATE TABLE IF NOT EXISTS novel_batch_children (
  batch_id TEXT NOT NULL REFERENCES novel_task_batches(id),
  child_key TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  task_id TEXT NOT NULL UNIQUE REFERENCES agent_tasks(id),
  generation_id TEXT NOT NULL UNIQUE REFERENCES llm_generations(id),
  chapter_id TEXT NOT NULL REFERENCES novel_chapters(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  base_version_id TEXT REFERENCES document_versions(id),
  expected_document_row_version INTEGER NOT NULL,
  conflict_artifact_id TEXT REFERENCES agent_partial_artifacts(id),
  PRIMARY KEY(batch_id,child_key), UNIQUE(batch_id,ordinal), UNIQUE(batch_id,chapter_id)
);
CREATE TABLE IF NOT EXISTS novel_batch_dependencies (
  batch_id TEXT NOT NULL,
  child_key TEXT NOT NULL,
  upstream_key TEXT NOT NULL,
  milestone TEXT NOT NULL CHECK(milestone IN ('draft','published')),
  frozen_version_id TEXT REFERENCES document_versions(id),
  PRIMARY KEY(batch_id,child_key,upstream_key), CHECK(child_key<>upstream_key),
  FOREIGN KEY(batch_id,child_key) REFERENCES novel_batch_children(batch_id,child_key),
  FOREIGN KEY(batch_id,upstream_key) REFERENCES novel_batch_children(batch_id,child_key)
);
CREATE TABLE IF NOT EXISTS novel_batch_sources (
  batch_id TEXT NOT NULL REFERENCES novel_task_batches(id),
  task_id TEXT NOT NULL REFERENCES agent_tasks(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  version_id TEXT NOT NULL REFERENCES document_versions(id),
  milestone TEXT NOT NULL CHECK(milestone IN ('draft','published')),
  PRIMARY KEY(task_id,version_id)
);
CREATE TRIGGER IF NOT EXISTS novel_batches_validate_parent BEFORE INSERT ON novel_task_batches
WHEN NOT EXISTS(SELECT 1 FROM agent_tasks WHERE id=NEW.parent_task_id AND project_id=NEW.project_id)
BEGIN SELECT RAISE(ABORT,'batch parent must belong to project'); END;
CREATE TRIGGER IF NOT EXISTS novel_batches_validate_child BEFORE INSERT ON novel_batch_children
WHEN NOT EXISTS(
  SELECT 1 FROM novel_task_batches batch JOIN agent_tasks task ON task.project_id=batch.project_id
  JOIN agent_task_generations link ON link.task_id=task.id
  JOIN llm_generations generation ON generation.id=link.generation_id AND generation.project_id=batch.project_id
  JOIN novel_chapters chapter ON chapter.project_id=batch.project_id AND chapter.document_id=NEW.document_id
  JOIN agent_task_targets target ON target.task_id=task.id AND target.chapter_id=chapter.id AND target.document_id=chapter.document_id
  WHERE batch.id=NEW.batch_id AND task.id=NEW.task_id AND generation.id=NEW.generation_id AND chapter.id=NEW.chapter_id)
BEGIN SELECT RAISE(ABORT,'batch child must match project and trusted target'); END;
CREATE TRIGGER IF NOT EXISTS novel_batches_validate_dependency BEFORE INSERT ON novel_batch_dependencies
WHEN NOT EXISTS(SELECT 1 FROM novel_batch_children child JOIN novel_batch_children upstream ON upstream.batch_id=child.batch_id
  WHERE child.batch_id=NEW.batch_id AND child.child_key=NEW.child_key AND upstream.child_key=NEW.upstream_key AND upstream.ordinal<child.ordinal)
BEGIN SELECT RAISE(ABORT,'batch dependencies must refer to earlier children'); END;
CREATE TRIGGER IF NOT EXISTS novel_batches_dependency_immutable BEFORE UPDATE OF batch_id,child_key,upstream_key,milestone ON novel_batch_dependencies
BEGIN SELECT RAISE(ABORT,'batch dependency is immutable'); END;
CREATE TRIGGER IF NOT EXISTS novel_batches_validate_source BEFORE INSERT ON novel_batch_sources
WHEN NOT EXISTS(SELECT 1 FROM novel_task_batches batch JOIN novel_batch_children child ON child.batch_id=batch.id AND child.task_id=NEW.task_id
  JOIN documents document ON document.id=NEW.document_id AND document.project_id=batch.project_id
  JOIN document_versions version ON version.id=NEW.version_id AND version.document_id=document.id WHERE batch.id=NEW.batch_id)
BEGIN SELECT RAISE(ABORT,'batch source must belong to child project and document'); END;
`;
