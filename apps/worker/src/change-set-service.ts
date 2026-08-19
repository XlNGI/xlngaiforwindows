import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AgentChangeSetApplyParams,
  AgentChangeSetCreateParams,
  AgentChangeSetInfo,
  AgentChangeSetItemDraft,
  AgentChangeSetItemInfo,
  AgentChangeSetListParams,
  AgentChangeSetRejectParams,
} from '@ai-video/contracts';
import { ProjectService } from './project-service.js';

type ChangeSetRow = {
  id: string;
  project_id: string;
  task_id: string | null;
  title: string;
  status: AgentChangeSetInfo['status'];
  row_version: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

type ItemRow = {
  id: string;
  change_set_id: string;
  ordinal: number;
  entity_type: AgentChangeSetItemInfo['entityType'];
  action: AgentChangeSetItemInfo['action'];
  target_id: string | null;
  parent_scene_id: string | null;
  parent_item_ordinal: number | null;
  title: string;
  shot_status: string | null;
  document_kind: AgentChangeSetItemInfo['documentKind'] | null;
  content_markdown: string | null;
  scope_type: AgentChangeSetItemInfo['scopeType'] | null;
  scope_id: string | null;
  expected_row_version: number | null;
  expected_current_version_id: string | null;
  status: AgentChangeSetItemInfo['status'];
  applied_entity_id: string | null;
  error_code: string | null;
};

class ChangeSetConflict extends Error {}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.normalize('NFC').trim();
  if (!normalized || normalized.length > maximum) {
    throw new Error(`${label} must contain between 1 and ${maximum} characters.`);
  }
  return normalized;
}

function itemInfo(row: ItemRow): AgentChangeSetItemInfo {
  return {
    id: row.id,
    ordinal: row.ordinal,
    entityType: row.entity_type,
    action: row.action,
    targetId: row.target_id ?? undefined,
    parentSceneId: row.parent_scene_id ?? undefined,
    parentItemOrdinal: row.parent_item_ordinal ?? undefined,
    title: row.title,
    shotStatus: row.shot_status ?? undefined,
    documentKind: row.document_kind ?? undefined,
    contentMarkdown: row.content_markdown ?? undefined,
    scopeType: row.scope_type ?? undefined,
    scopeId: row.scope_id ?? undefined,
    expectedRowVersion: row.expected_row_version ?? undefined,
    expectedCurrentVersionId: row.expected_current_version_id ?? undefined,
    status: row.status,
    appliedEntityId: row.applied_entity_id ?? undefined,
    errorCode: row.error_code ?? undefined,
  };
}

export class ChangeSetService {
  constructor(private readonly projects: ProjectService) {}

  create(params: AgentChangeSetCreateParams): AgentChangeSetInfo {
    if (params.items.length < 1 || params.items.length > 100) {
      throw new Error('A change set must contain between 1 and 100 items.');
    }
    const title = requiredText(params.title, 'Change set title', 200);
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const id = randomUUID();
        const now = new Date().toISOString();
        database
          .prepare(
            `INSERT INTO agent_change_sets
             (id, project_id, task_id, title, status, row_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'proposed', 0, ?, ?)`,
          )
          .run(id, project.id, params.taskId ?? null, title, now, now);
        const itemIds = params.items.map(() => randomUUID());
        const insert = database.prepare(
          `INSERT INTO agent_change_set_items
           (id, change_set_id, project_id, ordinal, entity_type, action, target_id,
            parent_scene_id, parent_item_id, title, shot_status, document_kind,
            content_markdown, scope_type, scope_id, expected_row_version,
            expected_current_version_id,
            status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        );
        params.items.forEach((candidate, ordinal) => {
          const item = this.validateDraft(candidate, ordinal, params.items);
          insert.run(
            itemIds[ordinal],
            id,
            project.id,
            ordinal,
            item.entityType,
            item.action,
            item.targetId ?? null,
            item.parentSceneId ?? null,
            item.parentItemOrdinal === undefined ? null : itemIds[item.parentItemOrdinal],
            item.title,
            item.shotStatus ?? null,
            item.documentKind ?? null,
            item.contentMarkdown ?? null,
            item.scopeType ?? null,
            item.scopeId ?? null,
            item.expectedRowVersion ?? null,
            item.expectedCurrentVersionId ?? null,
            now,
            now,
          );
        });
        return this.getInTransaction(database, project.id, id);
      })(),
    );
  }

  list(params: AgentChangeSetListParams = {}): AgentChangeSetInfo[] {
    return this.projects.access(false, (database, project) => {
      const rows = database
        .prepare(
          `SELECT * FROM agent_change_sets WHERE project_id = ?
           ${params.includeTerminal ? '' : "AND status IN ('proposed', 'partially_applied')"}
           ORDER BY created_at DESC, id DESC`,
        )
        .all(project.id) as ChangeSetRow[];
      return rows.map((row) => this.toInfo(database, row));
    });
  }

  apply(params: AgentChangeSetApplyParams): AgentChangeSetInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const set = this.requireMutableSet(
          database,
          project.id,
          params.changeSetId,
          params.expectedRowVersion,
        );
        const selected = this.selectPendingItems(database, set.id, params.itemIds);
        const now = new Date().toISOString();
        try {
          database.transaction(() => {
            for (const item of selected) {
              const appliedEntityId = this.applyItem(database, project.id, item, now);
              database
                .prepare(
                  `UPDATE agent_change_set_items
                   SET status = 'applied', applied_entity_id = ?, error_code = NULL, updated_at = ?
                   WHERE id = ? AND status = 'pending'`,
                )
                .run(appliedEntityId, now, item.id);
            }
          })();
        } catch (error) {
          if (!(error instanceof ChangeSetConflict)) throw error;
          const mark = database.prepare(
            `UPDATE agent_change_set_items SET status = 'conflicted', error_code = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`,
          );
          for (const item of selected) mark.run(error.message, now, item.id);
          database
            .prepare(
              `UPDATE agent_change_sets SET status = 'conflicted', completed_at = ?, updated_at = ?,
               row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
            )
            .run(now, now, set.id, set.row_version);
          return this.getInTransaction(database, project.id, set.id);
        }
        const pending = this.pendingCount(database, set.id);
        database
          .prepare(
            `UPDATE agent_change_sets SET status = ?, completed_at = ?, updated_at = ?,
             row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
          )
          .run(
            pending === 0 ? 'applied' : 'partially_applied',
            pending === 0 ? now : null,
            now,
            set.id,
            set.row_version,
          );
        return this.getInTransaction(database, project.id, set.id);
      })(),
    );
  }

  reject(params: AgentChangeSetRejectParams): AgentChangeSetInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const set = this.requireMutableSet(
          database,
          project.id,
          params.changeSetId,
          params.expectedRowVersion,
        );
        const selected = this.selectPendingItems(database, set.id, params.itemIds);
        const now = new Date().toISOString();
        const reject = database.prepare(
          `UPDATE agent_change_set_items SET status = 'rejected', updated_at = ?
           WHERE id = ? AND status = 'pending'`,
        );
        for (const item of selected) reject.run(now, item.id);
        const pending = this.pendingCount(database, set.id);
        const applied = (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM agent_change_set_items WHERE change_set_id = ? AND status = 'applied'",
            )
            .get(set.id) as { count: number }
        ).count;
        database
          .prepare(
            `UPDATE agent_change_sets SET status = ?, completed_at = ?, updated_at = ?,
             row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
          )
          .run(
            pending > 0 || applied > 0 ? 'partially_applied' : 'rejected',
            pending === 0 ? now : null,
            now,
            set.id,
            set.row_version,
          );
        return this.getInTransaction(database, project.id, set.id);
      })(),
    );
  }

  private validateDraft(
    candidate: AgentChangeSetItemDraft,
    ordinal: number,
    all: AgentChangeSetItemDraft[],
  ): AgentChangeSetItemDraft {
    const item = { ...candidate, title: requiredText(candidate.title, 'Item title', 200) };
    if (item.action === 'create') {
      if (item.targetId || item.expectedRowVersion !== undefined) {
        throw new Error('Create proposals cannot include a target or expected row version.');
      }
    } else if (!item.targetId || item.expectedRowVersion === undefined) {
      throw new Error('Update proposals require a target and expected row version.');
    }
    if (item.entityType === 'document') {
      if (!item.documentKind || item.contentMarkdown === undefined) {
        throw new Error('Document proposals require a kind and contentMarkdown.');
      }
      if (item.parentSceneId || item.parentItemOrdinal !== undefined || item.shotStatus) {
        throw new Error('Document proposals cannot include scene or shot parent fields.');
      }
      if (item.scopeType === 'project' && item.scopeId) {
        throw new Error('Project documents cannot include a scope ID.');
      }
      if (item.scopeType && item.scopeType !== 'project' && !item.scopeId) {
        throw new Error('Scene and shot documents require a scope ID.');
      }
      if (item.action === 'update' && !item.expectedCurrentVersionId) {
        throw new Error('Document updates require expectedCurrentVersionId.');
      }
      return item;
    }
    if (
      item.documentKind ||
      item.contentMarkdown !== undefined ||
      item.scopeType ||
      item.scopeId ||
      item.expectedCurrentVersionId
    ) {
      throw new Error('Scene and shot proposals cannot include document fields.');
    }
    if (item.entityType === 'scene') {
      if (item.parentSceneId || item.parentItemOrdinal !== undefined || item.shotStatus) {
        throw new Error('Scene proposals cannot include shot parent or status fields.');
      }
    } else if (item.action === 'create') {
      const parentCount =
        Number(Boolean(item.parentSceneId)) + Number(item.parentItemOrdinal !== undefined);
      if (parentCount !== 1) throw new Error('Shot creation requires exactly one scene parent.');
      if (item.parentItemOrdinal !== undefined) {
        const parent = all[item.parentItemOrdinal];
        if (
          item.parentItemOrdinal >= ordinal ||
          parent?.entityType !== 'scene' ||
          parent.action !== 'create'
        ) {
          throw new Error('Shot parent proposal must be an earlier scene creation item.');
        }
      }
    } else if (item.parentSceneId || item.parentItemOrdinal !== undefined) {
      throw new Error('Shot updates derive their scene from the target.');
    }
    if (item.shotStatus !== undefined)
      item.shotStatus = requiredText(item.shotStatus, 'Shot status', 80);
    return item;
  }

  private applyItem(
    database: Database.Database,
    projectId: string,
    item: ItemRow,
    now: string,
  ): string {
    if (item.entity_type === 'document') {
      return this.applyDocument(database, projectId, item, now);
    }
    if (item.entity_type === 'scene' && item.action === 'create') {
      const id = randomUUID();
      const position = (
        database
          .prepare(
            'SELECT COALESCE(MAX(position), -1) + 1 AS value FROM scenes WHERE project_id = ?',
          )
          .get(projectId) as { value: number }
      ).value;
      database
        .prepare(
          `INSERT INTO scenes (id, project_id, title, position, created_at, updated_at, row_version)
           VALUES (?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(id, projectId, item.title, position, now, now);
      return id;
    }
    if (item.entity_type === 'scene') {
      const result = database
        .prepare(
          `UPDATE scenes SET title = ?, updated_at = ?, row_version = row_version + 1
           WHERE id = ? AND project_id = ? AND row_version = ?`,
        )
        .run(item.title, now, item.target_id, projectId, item.expected_row_version);
      if (result.changes !== 1) throw new ChangeSetConflict('SCENE_ROW_VERSION_CONFLICT');
      return item.target_id!;
    }
    if (item.action === 'create') {
      const sceneId = item.parent_scene_id ?? this.appliedParentScene(database, item);
      const scene = database
        .prepare('SELECT id FROM scenes WHERE id = ? AND project_id = ?')
        .get(sceneId, projectId);
      if (!scene) throw new ChangeSetConflict('CHANGE_SET_PARENT_SCENE_CONFLICT');
      const id = randomUUID();
      const position = (
        database
          .prepare('SELECT COALESCE(MAX(position), -1) + 1 AS value FROM shots WHERE scene_id = ?')
          .get(sceneId) as { value: number }
      ).value;
      database
        .prepare(
          `INSERT INTO shots
           (id, scene_id, title, position, status, created_at, updated_at, row_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(id, sceneId, item.title, position, item.shot_status ?? 'draft', now, now);
      return id;
    }
    const result = database
      .prepare(
        `UPDATE shots SET title = ?, status = COALESCE(?, status), updated_at = ?,
           row_version = row_version + 1
         WHERE id = ? AND row_version = ? AND scene_id IN (
           SELECT id FROM scenes WHERE project_id = ?
         )`,
      )
      .run(item.title, item.shot_status, now, item.target_id, item.expected_row_version, projectId);
    if (result.changes !== 1) throw new ChangeSetConflict('SHOT_ROW_VERSION_CONFLICT');
    return item.target_id!;
  }

  private applyDocument(
    database: Database.Database,
    projectId: string,
    item: ItemRow,
    now: string,
  ): string {
    const existing = item.target_id
      ? (database
          .prepare('SELECT * FROM documents WHERE id = ? AND project_id = ?')
          .get(item.target_id, projectId) as
          | {
              id: string;
              row_version: number;
              current_version_id: string | null;
              published_version_id: string | null;
              kind: string;
              scope_type: string;
              scope_id: string | null;
              base_version_id?: string | null;
            }
          | undefined)
      : undefined;
    if (item.action === 'update') {
      if (!existing || existing.row_version !== item.expected_row_version) {
        throw new ChangeSetConflict('DOCUMENT_ROW_VERSION_CONFLICT');
      }
      if (existing.current_version_id !== item.expected_current_version_id) {
        throw new ChangeSetConflict('DOCUMENT_CURRENT_VERSION_CONFLICT');
      }
    } else if (existing) {
      throw new ChangeSetConflict('DOCUMENT_CREATE_TARGET_CONFLICT');
    }

    const documentId = existing?.id ?? randomUUID();
    const versionId = randomUUID();
    const scopeType = item.scope_type ?? existing?.scope_type ?? 'project';
    const scopeId = scopeType === 'project' ? null : (item.scope_id ?? existing?.scope_id ?? null);
    const documentKind = item.document_kind ?? existing?.kind ?? 'note';
    const versionNumber = (
      database
        .prepare(
          'SELECT COALESCE(MAX(version), 0) + 1 AS value FROM document_versions WHERE document_id = ?',
        )
        .get(documentId) as { value: number }
    ).value;
    const current = existing?.current_version_id
      ? (database
          .prepare('SELECT state, base_version_id FROM document_versions WHERE id = ?')
          .get(existing.current_version_id) as
          { state: string; base_version_id: string | null } | undefined)
      : undefined;
    if (current && ['draft', 'changes_requested'].includes(current.state)) {
      database
        .prepare(
          `UPDATE document_versions SET state = 'superseded', state_updated_at = ?, state_version = state_version + 1
           WHERE id = ? AND state IN ('draft', 'changes_requested')`,
        )
        .run(now, existing!.current_version_id);
    }
    if (!existing) {
      database
        .prepare(
          `INSERT INTO documents
           (id, project_id, kind, title, scope_type, scope_id, current_version_id,
            published_version_id, lifecycle_status, row_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'active', 1, ?, ?)`,
        )
        .run(
          documentId,
          projectId,
          documentKind,
          item.title,
          scopeType,
          scopeId,
          versionId,
          now,
          now,
        );
    }
    database
      .prepare(
        `INSERT INTO document_versions
         (id, document_id, version, content_markdown, created_at, state, base_version_id,
          title_snapshot, scope_type_snapshot, scope_id_snapshot, author_type, author_id,
          content_hash, state_updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, 'agent', 'agent', sha256(?), ?)`,
      )
      .run(
        versionId,
        documentId,
        versionNumber,
        item.content_markdown,
        now,
        current?.base_version_id ?? existing?.published_version_id ?? null,
        item.title,
        scopeType,
        scopeId,
        item.content_markdown,
        now,
      );
    if (existing) {
      const result = database
        .prepare(
          `UPDATE documents
           SET kind = ?, title = ?, scope_type = ?, scope_id = ?, current_version_id = ?,
               updated_at = ?, row_version = row_version + 1
           WHERE id = ? AND project_id = ? AND row_version = ?`,
        )
        .run(
          documentKind,
          item.title,
          scopeType,
          scopeId,
          versionId,
          now,
          documentId,
          projectId,
          item.expected_row_version,
        );
      if (result.changes !== 1) throw new ChangeSetConflict('DOCUMENT_ROW_VERSION_CONFLICT');
    }
    return documentId;
  }

  private appliedParentScene(database: Database.Database, item: ItemRow): string {
    const parent = database
      .prepare(
        `SELECT applied_entity_id FROM agent_change_set_items
         WHERE id = (SELECT parent_item_id FROM agent_change_set_items WHERE id = ?)
           AND change_set_id = ? AND status = 'applied'`,
      )
      .get(item.id, item.change_set_id) as { applied_entity_id: string | null } | undefined;
    if (!parent?.applied_entity_id) {
      throw new ChangeSetConflict('CHANGE_SET_PARENT_ITEM_NOT_APPLIED');
    }
    return parent.applied_entity_id;
  }

  private requireMutableSet(
    database: Database.Database,
    projectId: string,
    id: string,
    expectedRowVersion: number,
  ): ChangeSetRow {
    const row = database
      .prepare(
        `SELECT * FROM agent_change_sets WHERE id = ? AND project_id = ?
         AND status IN ('proposed', 'partially_applied')`,
      )
      .get(id, projectId) as ChangeSetRow | undefined;
    if (!row) throw new Error('Change set is not available for review.');
    if (row.row_version !== expectedRowVersion) throw new Error('CHANGE_SET_ROW_VERSION_CONFLICT');
    return row;
  }

  private selectPendingItems(
    database: Database.Database,
    changeSetId: string,
    itemIds?: string[],
  ): ItemRow[] {
    const rows = this.itemRows(database, changeSetId).filter((item) => item.status === 'pending');
    if (!itemIds) {
      if (rows.length === 0) throw new Error('Change set has no pending items.');
      return rows;
    }
    const requested = new Set(itemIds);
    if (requested.size !== itemIds.length || requested.size === 0) {
      throw new Error('itemIds must contain unique pending item IDs.');
    }
    const selected = rows.filter((item) => requested.has(item.id));
    if (selected.length !== requested.size)
      throw new Error('A selected change-set item is unavailable.');
    return selected;
  }

  private pendingCount(database: Database.Database, changeSetId: string): number {
    return (
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_change_set_items WHERE change_set_id = ? AND status = 'pending'",
        )
        .get(changeSetId) as { count: number }
    ).count;
  }

  private getInTransaction(
    database: Database.Database,
    projectId: string,
    id: string,
  ): AgentChangeSetInfo {
    const row = database
      .prepare('SELECT * FROM agent_change_sets WHERE id = ? AND project_id = ?')
      .get(id, projectId) as ChangeSetRow | undefined;
    if (!row) throw new Error('Change set was not found.');
    return this.toInfo(database, row);
  }

  private toInfo(database: Database.Database, row: ChangeSetRow): AgentChangeSetInfo {
    return {
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id ?? undefined,
      title: row.title,
      status: row.status,
      rowVersion: row.row_version,
      items: this.itemRows(database, row.id).map(itemInfo),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? undefined,
    };
  }

  private itemRows(database: Database.Database, changeSetId: string): ItemRow[] {
    return database
      .prepare(
        `SELECT items.*, parent.ordinal AS parent_item_ordinal
         FROM agent_change_set_items items
         LEFT JOIN agent_change_set_items parent ON parent.id = items.parent_item_id
         WHERE items.change_set_id = ? ORDER BY items.ordinal`,
      )
      .all(changeSetId) as ItemRow[];
  }
}
