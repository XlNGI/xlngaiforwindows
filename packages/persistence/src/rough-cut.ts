import type Database from 'better-sqlite3';
import type { RoughCutSequence } from '@ai-video/contracts';

interface SequenceRow {
  id: string;
  project_id: string;
  name: string;
  scene_ids_json: string;
  clips_json: string;
  row_version: number;
  created_at: string;
  updated_at: string;
}

export class RoughCutRepository {
  constructor(private readonly database: Database.Database) {}

  list(projectId: string): RoughCutSequence[] {
    return (
      this.database
        .prepare('SELECT * FROM rough_cut_sequences WHERE project_id=? ORDER BY updated_at DESC,id')
        .all(projectId) as SequenceRow[]
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      sceneIds: JSON.parse(row.scene_ids_json) as string[],
      clips: JSON.parse(row.clips_json) as RoughCutSequence['clips'],
      rowVersion: row.row_version,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  get(projectId: string, id: string): RoughCutSequence | undefined {
    return this.list(projectId).find((sequence) => sequence.id === id);
  }

  save(sequence: RoughCutSequence, expectedRowVersion: number): RoughCutSequence {
    return this.database.transaction(() => {
      const owner = this.database
        .prepare('SELECT project_id FROM rough_cut_sequences WHERE id=?')
        .get(sequence.id) as { project_id: string } | undefined;
      if (owner && owner.project_id !== sequence.projectId)
        throw new Error('粗剪序列不属于当前项目。');
      const current = this.get(sequence.projectId, sequence.id);
      if ((current?.rowVersion ?? 0) !== expectedRowVersion)
        throw new Error('粗剪序列已在其他页面更新，请重新打开；当前编辑尚未保存。');
      this.database
        .prepare(
          `INSERT INTO rough_cut_sequences
        (id,project_id,name,scene_ids_json,clips_json,row_version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        name=excluded.name,scene_ids_json=excluded.scene_ids_json,clips_json=excluded.clips_json,
        row_version=excluded.row_version,updated_at=excluded.updated_at`,
        )
        .run(
          sequence.id,
          sequence.projectId,
          sequence.name,
          JSON.stringify(sequence.sceneIds),
          JSON.stringify(sequence.clips),
          expectedRowVersion + 1,
          current?.createdAt ?? sequence.createdAt,
          sequence.updatedAt,
        );
      return this.get(sequence.projectId, sequence.id)!;
    })();
  }

  delete(projectId: string, id: string, expectedRowVersion: number): void {
    const result = this.database
      .prepare('DELETE FROM rough_cut_sequences WHERE project_id=? AND id=? AND row_version=?')
      .run(projectId, id, expectedRowVersion);
    if (!result.changes) throw new Error('粗剪序列已更新，请重新打开后再删除。');
  }
}

export function roughCutReferenceCount(
  database: Database.Database,
  projectId: string,
  assetId: string,
): number {
  return (
    database
      .prepare(
        `SELECT count(*) AS count FROM rough_cut_sequences s
    WHERE s.project_id=? AND EXISTS(SELECT 1 FROM json_each(s.clips_json) c WHERE json_extract(c.value,'$.assetId')=?)`,
      )
      .get(projectId, assetId) as { count: number }
  ).count;
}
