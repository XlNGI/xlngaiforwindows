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
import { validatePromptBindings, validateProductionTiming } from '@ai-video/contracts';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { validatePromptBindingReferences } from './prompt-binding-validation.js';
import { rebuildLibraryChunksForChangeSet } from '@ai-video/persistence';
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
  sample_text: string | null;
  shot_prompt: string | null;
  prompt_bindings_json: string | null;
  timing_json: string | null;
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
    sampleText: row.sample_text ?? undefined,
    shotStatus: row.shot_status ?? undefined,
    prompt: row.shot_prompt ?? undefined,
    ...(row.prompt_bindings_json
      ? { bindings: validatePromptBindings(JSON.parse(row.prompt_bindings_json)) }
      : {}),
    ...(row.timing_json ? { timing: validateProductionTiming(JSON.parse(row.timing_json)) } : {}),
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
  /** Save generated content immediately, retaining the change set as an audit record. */
  saveDraft(params: AgentChangeSetCreateParams): AgentChangeSetInfo {
    return this.projects.access(true, (database) =>
      database.transaction(() => {
        const created = this.create(params);
        const saved = this.apply({
          changeSetId: created.id,
          expectedRowVersion: created.rowVersion,
        });
        if (saved.status !== 'applied')
          throw new Error('DRAFT_SAVE_CONFLICT: 内容已变更，请读取最新版本后重试。');
        return saved;
      })(),
    );
  }
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
        const insert = database.prepare(`INSERT INTO agent_change_set_items
           (id, change_set_id, project_id, ordinal, entity_type, action, target_id,
            parent_scene_id, parent_item_id, title, shot_status, document_kind,
            content_markdown, shot_prompt, scope_type, scope_id, expected_row_version,
            expected_current_version_id,
            sample_text, prompt_bindings_json, timing_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`);
        params.items.forEach((candidate, ordinal) => {
          const item = this.validateDraft(candidate, ordinal, params.items);
          if (item.bindings) validatePromptBindingReferences(database, project.id, item.bindings);
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
            item.prompt ?? null,
            item.scopeType ?? null,
            item.scopeId ?? null,
            item.expectedRowVersion ?? null,
            item.expectedCurrentVersionId ?? null,
            item.sampleText ?? null,
            item.bindings ? JSON.stringify(item.bindings) : null,
            item.timing ? JSON.stringify(item.timing) : null,
            now,
            now,
          );
        });
        rebuildLibraryChunksForChangeSet(database, project.id, id, now);
        return this.getInTransaction(database, project.id, id);
      })(),
    );
  }
  get(changeSetId: string): AgentChangeSetInfo {
    return this.projects.access(false, (database, project) =>
      this.getInTransaction(database, project.id, changeSetId),
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
        const oldUpdatedAt = project.updatedAt;
        try {
          database.transaction(() => {
            for (const item of selected) {
              const appliedEntityId = this.applyItem(database, project.id, item);
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
          project.updatedAt = oldUpdatedAt;
          if (!(error instanceof ChangeSetConflict)) throw error;
          const mark =
            database.prepare(`UPDATE agent_change_set_items SET status = 'conflicted', error_code = ?, updated_at = ?
             WHERE id = ? AND status = 'pending'`);
          for (const item of selected) mark.run(error.message, now, item.id);
          database
            .prepare(
              `UPDATE agent_change_sets SET status = 'conflicted', completed_at = ?, updated_at = ?,
               row_version = row_version + 1 WHERE id = ? AND row_version = ?`,
            )
            .run(now, now, set.id, set.row_version);
          rebuildLibraryChunksForChangeSet(database, project.id, set.id, now);
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
        rebuildLibraryChunksForChangeSet(database, project.id, set.id, now);
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
        const reject =
          database.prepare(`UPDATE agent_change_set_items SET status = 'rejected', updated_at = ?
           WHERE id = ? AND status = 'pending'`);
        for (const item of selected) reject.run(now, item.id);
        const pending = this.pendingCount(database, set.id);
        const applied = (
          database
            .prepare(
              "SELECT COUNT(*) AS count FROM agent_change_set_items WHERE change_set_id = ? AND status = 'applied'",
            )
            .get(set.id) as {
            count: number;
          }
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
        rebuildLibraryChunksForChangeSet(database, project.id, set.id, now);
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
    if (item.bindings) validatePromptBindings(item.bindings);
    if (item.timing) validateProductionTiming(item.timing);
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
      if (item.prompt !== undefined) {
        throw new Error('Document proposals cannot include a shot prompt.');
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
    if (item.prompt !== undefined) requiredText(item.prompt, 'Shot prompt', 20000);
    return item;
  }
  private applyItem(database: Database.Database, projectId: string, item: ItemRow): string {
    const payload = itemInfo(item);
    try {
      if (item.entity_type === 'document') {
        return new DocumentWorkflowService(this.projects).saveDraft({
          ...(item.action === 'update'
            ? {
                documentId: item.target_id!,
                expectedDocumentRowVersion: item.expected_row_version!,
                baseVersionId: item.expected_current_version_id!,
              }
            : {}),
          kind: payload.documentKind!,
          title: item.title,
          contentMarkdown: item.content_markdown!,
          scopeType: payload.scopeType,
          scopeId: payload.scopeId,
          sampleText: payload.sampleText,
          authorType: 'agent',
          ...(payload.bindings ? { bindings: payload.bindings } : {}),
        }).id;
      }
      const content = new ContentService(this.projects);
      const fields = {
        title: item.title,
        ...(payload.prompt !== undefined ? { prompt: payload.prompt } : {}),
        ...(payload.bindings ? { bindings: payload.bindings } : {}),
        ...(payload.timing ? { timing: payload.timing } : {}),
      };
      if (item.entity_type === 'scene')
        return content.saveScene({
          ...fields,
          ...(item.action === 'update'
            ? { sceneId: item.target_id!, expectedRowVersion: item.expected_row_version! }
            : {}),
        }).id;
      const sceneId =
        item.action === 'create'
          ? (item.parent_scene_id ?? this.appliedParentScene(database, item))
          : (
              database
                .prepare(
                  'SELECT s.scene_id FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=?',
                )
                .get(item.target_id, projectId) as { scene_id: string } | undefined
            )?.scene_id;
      if (!sceneId) throw new Error('CHANGE_SET_PARENT_SCENE_CONFLICT');
      return content.saveShot({
        ...fields,
        sceneId,
        status: payload.shotStatus,
        ...(item.action === 'update'
          ? { shotId: item.target_id!, expectedRowVersion: item.expected_row_version! }
          : {}),
      }).id;
    } catch (error) {
      throw new ChangeSetConflict(error instanceof Error ? error.message : 'CHANGE_SET_CONFLICT');
    }
  }
  private appliedParentScene(database: Database.Database, item: ItemRow): string {
    const parent = database
      .prepare(
        `SELECT applied_entity_id FROM agent_change_set_items
         WHERE id = (SELECT parent_item_id FROM agent_change_set_items WHERE id = ?)
           AND change_set_id = ? AND status = 'applied'`,
      )
      .get(item.id, item.change_set_id) as
      | {
          applied_entity_id: string | null;
        }
      | undefined;
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
        .get(changeSetId) as {
        count: number;
      }
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
