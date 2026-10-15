/** Cast identity is independent of image availability; all media stay project-local. */
export const MIGRATION_V46 = `
CREATE TABLE IF NOT EXISTS scene_character_bindings (
  scene_id TEXT NOT NULL REFERENCES scenes(id) ON DELETE CASCADE,
  character_document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE RESTRICT,
  image_asset_id TEXT REFERENCES assets(id) ON DELETE RESTRICT,
  voice_reference_version_id TEXT REFERENCES character_voice_reference_versions(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position >= 0),
  PRIMARY KEY(scene_id, character_document_id)
);
CREATE INDEX IF NOT EXISTS scene_characters_image ON scene_character_bindings(image_asset_id);
CREATE TRIGGER IF NOT EXISTS scene_character_insert_valid BEFORE INSERT ON scene_character_bindings
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM scenes s JOIN documents d ON d.id=NEW.character_document_id
    WHERE s.id=NEW.scene_id AND d.project_id=s.project_id AND d.kind='character' AND d.lifecycle_status='active'
      AND NOT EXISTS(SELECT 1 FROM document_bindings WHERE document_id=d.id AND domain_scope='novel' AND status<>'archived')
  ) THEN RAISE(ABORT,'Invalid scene character') END;
  SELECT CASE WHEN NEW.image_asset_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM scenes s JOIN assets a ON a.project_id=s.project_id
    WHERE s.id=NEW.scene_id AND a.id=NEW.image_asset_id AND a.deleted_at IS NULL AND a.kind NOT LIKE '%video%'
  ) THEN RAISE(ABORT,'Invalid scene character image') END;
  SELECT CASE WHEN NEW.voice_reference_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM character_voice_reference_versions v
    JOIN character_voice_references r ON r.id=v.reference_id
    JOIN audio_files a ON a.id=v.audio_id JOIN scenes s ON s.project_id=v.project_id
    WHERE s.id=NEW.scene_id AND v.id=NEW.voice_reference_version_id
      AND r.character_document_id=NEW.character_document_id AND a.project_id=s.project_id AND a.deleted_at IS NULL
  ) THEN RAISE(ABORT,'Invalid scene character voice') END;
END;
CREATE TRIGGER IF NOT EXISTS scene_character_immutable BEFORE UPDATE ON scene_character_bindings
BEGIN SELECT RAISE(ABORT,'Replace scene character bindings atomically'); END;
CREATE TRIGGER IF NOT EXISTS scene_dialogue_insert_valid BEFORE INSERT ON scenes WHEN NEW.dialogue_audio_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM audio_files WHERE id=NEW.dialogue_audio_id AND project_id=NEW.project_id AND deleted_at IS NULL AND kind<>'reference')
  THEN RAISE(ABORT,'Invalid scene dialogue audio') END;
END;
CREATE TRIGGER IF NOT EXISTS scene_dialogue_update_valid BEFORE UPDATE OF dialogue_audio_id ON scenes WHEN NEW.dialogue_audio_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM audio_files WHERE id=NEW.dialogue_audio_id AND project_id=NEW.project_id AND deleted_at IS NULL AND kind<>'reference')
  THEN RAISE(ABORT,'Invalid scene dialogue audio') END;
END;
INSERT OR IGNORE INTO scene_character_bindings(scene_id,character_document_id,image_asset_id,voice_reference_version_id,position)
SELECT s.id,d.id,a.id,r.current_version_id,CAST(j.key AS INTEGER)
FROM scenes s,json_each(s.material_bindings_json) j
JOIN documents d ON d.id=json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.sourceDocumentId') AND d.project_id=s.project_id AND d.kind='character' AND d.lifecycle_status='active'
LEFT JOIN assets a ON a.id=json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.assetId') AND a.project_id=s.project_id AND a.deleted_at IS NULL AND a.kind NOT LIKE '%video%'
LEFT JOIN character_voice_references r ON r.project_id=s.project_id AND r.character_document_id=d.id
WHERE json_extract(CASE WHEN j.type='object' THEN j.value ELSE '{}' END,'$.role')='character'
  AND NOT EXISTS(SELECT 1 FROM document_bindings WHERE document_id=d.id AND domain_scope='novel' AND status<>'archived');
INSERT OR IGNORE INTO scene_character_bindings(scene_id,character_document_id,position)
SELECT c.scene_id,c.character_document_id,1000+MIN(c.position) FROM dubbing_cues c
JOIN documents d ON d.id=c.character_document_id AND d.project_id=c.project_id AND d.kind='character' AND d.lifecycle_status='active'
WHERE c.deleted_at IS NULL AND c.speaker_kind='character'
  AND NOT EXISTS(SELECT 1 FROM document_bindings WHERE document_id=d.id AND domain_scope='novel' AND status<>'archived')
GROUP BY c.scene_id,c.character_document_id;
`;
