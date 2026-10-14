/** Local role voice samples remain in the dedicated audio store. */
export const MIGRATION_V45 = `
CREATE TABLE IF NOT EXISTS character_voice_references (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_document_id TEXT NOT NULL,
  current_version_id TEXT,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version>0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id,character_document_id)
);
CREATE TABLE IF NOT EXISTS character_voice_reference_versions (
  id TEXT PRIMARY KEY,
  reference_id TEXT NOT NULL REFERENCES character_voice_references(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision>0),
  audio_id TEXT NOT NULL REFERENCES audio_files(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  UNIQUE(reference_id,revision)
);
CREATE TRIGGER IF NOT EXISTS voice_reference_role_insert BEFORE INSERT ON character_voice_references
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM documents WHERE id=NEW.character_document_id AND project_id=NEW.project_id AND kind='character' AND lifecycle_status='active') THEN RAISE(ABORT,'Invalid role voice reference') END;
END;
CREATE TRIGGER IF NOT EXISTS voice_reference_version_insert BEFORE INSERT ON character_voice_reference_versions
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM character_voice_references WHERE id=NEW.reference_id AND project_id=NEW.project_id) OR NOT EXISTS(SELECT 1 FROM audio_files WHERE id=NEW.audio_id AND project_id=NEW.project_id AND deleted_at IS NULL AND kind='reference') THEN RAISE(ABORT,'Invalid reference voice audio') END;
END;
CREATE TRIGGER IF NOT EXISTS voice_reference_versions_immutable BEFORE UPDATE ON character_voice_reference_versions
BEGIN SELECT RAISE(ABORT,'Voice reference versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS voice_reference_current_version BEFORE UPDATE OF current_version_id ON character_voice_references
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM character_voice_reference_versions WHERE id=NEW.current_version_id AND reference_id=NEW.id AND project_id=NEW.project_id) THEN RAISE(ABORT,'Invalid current voice reference version') END;
END;
CREATE TABLE IF NOT EXISTS video_input_audio_references (
  job_id TEXT NOT NULL REFERENCES generation_jobs(id) ON DELETE CASCADE,
  audio_id TEXT NOT NULL REFERENCES audio_files(id) ON DELETE RESTRICT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY(job_id,audio_id)
);
CREATE TRIGGER IF NOT EXISTS video_input_audio_scope BEFORE INSERT ON video_input_audio_references
BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM generation_jobs WHERE id=NEW.job_id AND project_id=NEW.project_id) OR NOT EXISTS(SELECT 1 FROM audio_files WHERE id=NEW.audio_id AND project_id=NEW.project_id AND deleted_at IS NULL) THEN RAISE(ABORT,'Invalid video audio input scope') END;
END;
`;
