import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  CharacterVoiceReferenceInfo,
  CharacterVoiceReferenceSaveParams,
} from '@ai-video/contracts';

export class VoiceReferenceRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly projectId: string,
  ) {}
  forCharacters(characterIds: string[], versionIds: string[] = []): CharacterVoiceReferenceInfo[] {
    if (!characterIds.length) return [];
    return this.database
      .prepare(
        `
      SELECT r.id,r.project_id AS projectId,r.character_document_id AS characterDocumentId,d.title AS characterName,
        v.id AS versionId,v.revision,r.row_version AS rowVersion,a.id AS audioId,a.name AS audioName,
        a.duration_ms AS durationMs,a.size_bytes AS sizeBytes,a.mime
      FROM character_voice_references r JOIN character_voice_reference_versions v ON v.reference_id=r.id AND v.project_id=r.project_id
      JOIN documents d ON d.id=r.character_document_id AND d.project_id=r.project_id
      JOIN audio_files a ON a.id=v.audio_id AND a.project_id=r.project_id
      WHERE r.project_id=? AND r.character_document_id IN (${characterIds.map(() => '?').join(',')})
        AND a.deleted_at IS NULL AND (v.id=r.current_version_id ${versionIds.length ? `OR v.id IN (${versionIds.map(() => '?').join(',')})` : ''})
      ORDER BY v.revision DESC,v.id
    `,
      )
      .all(this.projectId, ...characterIds, ...versionIds) as CharacterVoiceReferenceInfo[];
  }
  list(): CharacterVoiceReferenceInfo[] {
    return this.database
      .prepare(
        `SELECT r.id,r.project_id AS projectId,r.character_document_id AS characterDocumentId,d.title AS characterName,v.id AS versionId,v.revision,r.row_version AS rowVersion,a.id AS audioId,a.name AS audioName,a.duration_ms AS durationMs,a.size_bytes AS sizeBytes,a.mime
      FROM character_voice_references r JOIN character_voice_reference_versions v ON v.id=r.current_version_id JOIN documents d ON d.id=r.character_document_id JOIN audio_files a ON a.id=v.audio_id
      WHERE r.project_id=? AND d.project_id=r.project_id AND d.lifecycle_status='active' AND a.deleted_at IS NULL ORDER BY r.created_at,r.id`,
      )
      .all(this.projectId) as CharacterVoiceReferenceInfo[];
  }
  save(input: CharacterVoiceReferenceSaveParams): CharacterVoiceReferenceInfo {
    return this.database.transaction(() => {
      const character = this.database
        .prepare(
          "SELECT 1 FROM documents WHERE id=? AND project_id=? AND kind='character' AND lifecycle_status='active'",
        )
        .get(input.characterDocumentId, this.projectId);
      if (!character) throw new Error('角色不属于当前项目，或已归档。');
      const existing = this.list().find(
        (value) => value.characterDocumentId === input.characterDocumentId,
      );
      if ((existing?.rowVersion ?? 0) !== (input.expectedRowVersion ?? 0))
        throw new Error('角色声音样本已变化，请刷新后保存。');
      const now = new Date().toISOString();
      const id = existing?.id ?? randomUUID();
      if (!existing)
        this.database
          .prepare(
            'INSERT INTO character_voice_references(id,project_id,character_document_id,created_at,updated_at) VALUES(?,?,?,?,?)',
          )
          .run(id, this.projectId, input.characterDocumentId, now, now);
      const versionId = randomUUID();
      this.database
        .prepare(
          'INSERT INTO character_voice_reference_versions(id,reference_id,project_id,revision,audio_id,created_at) VALUES(?,?,?,?,?,?)',
        )
        .run(versionId, id, this.projectId, (existing?.revision ?? 0) + 1, input.audioId, now);
      this.database
        .prepare(
          'UPDATE character_voice_references SET current_version_id=?,row_version=row_version+?,updated_at=? WHERE id=?',
        )
        .run(versionId, existing ? 1 : 0, now, id);
      return this.list().find((value) => value.id === id)!;
    })();
  }
}
