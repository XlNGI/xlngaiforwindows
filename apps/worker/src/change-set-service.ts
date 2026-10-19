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
  SceneMaterialBindingInfo,
} from '@ai-video/contracts';
import {
  renderProductionInstruction,
  type ProductionInstruction,
  type ProductionExecuteParams,
} from '@ai-video/contracts';
import { inspectProductionTargetInstruction } from '@ai-video/generation-adapters';
import { ProductionService } from './production-service.js';
import { rebuildLibraryChunksForChangeSet, SceneCharacterRepository } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';
import { requireProductionSceneDocument } from './scene-document-binding.js';
import {
  requireProductionCharacters,
  resolvedCast,
  productionReferenceImage,
} from './scene-cast-binding.js';

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
  scene_document_id: string | null;
  scene_bindings_json: string | null;
  shot_prompt: string | null;
  production_instruction_json: string | null;
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
    sceneDocumentId: row.scene_document_id ?? undefined,
    ...(row.scene_bindings_json
      ? (JSON.parse(row.scene_bindings_json) as Pick<
          AgentChangeSetItemDraft,
          'sceneDocumentId' | 'videoPrompt' | 'characterDocumentIds'
        >)
      : {}),
    shotStatus: row.shot_status ?? undefined,
    prompt: row.shot_prompt ?? undefined,
    instruction: row.production_instruction_json
      ? (JSON.parse(row.production_instruction_json) as ProductionInstruction)
      : undefined,
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
            content_markdown, shot_prompt, scope_type, scope_id, expected_row_version,
            expected_current_version_id,
            scene_document_id, scene_bindings_json, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        );
        params.items.forEach((candidate, ordinal) => {
          const item = this.validateDraft(candidate, ordinal, params.items);
          if (item.instruction) {
            requireProductionCharacters(
              database,
              project.id,
              item.instruction.subjects.map((subject) => subject.documentId),
            );
            for (const resource of item.instruction.resources) {
              if (
                resource.documentId &&
                !database
                  .prepare(
                    "SELECT 1 FROM documents WHERE id=? AND project_id=? AND lifecycle_status='active'",
                  )
                  .get(resource.documentId, project.id)
              )
                throw new Error('制作资源引用了无效的项目文档。');
              if (
                resource.assetId &&
                !database
                  .prepare(
                    'SELECT 1 FROM assets WHERE id=? AND project_id=? AND deleted_at IS NULL',
                  )
                  .get(resource.assetId, project.id)
              )
                throw new Error('制作资源引用了无效的项目素材。');
            }
            const names = Object.fromEntries(
              (
                database
                  .prepare('SELECT id,title FROM documents WHERE project_id=?')
                  .all(project.id) as Array<{ id: string; title: string }>
              ).map((doc) => [doc.id, doc.title]),
            );
            const prompt = requiredText(
              renderProductionInstruction(item.instruction, names),
              'Structured prompt',
              20000,
            );
            const supplied = item.entityType === 'scene' ? item.videoPrompt : item.prompt;
            if (
              supplied !== undefined &&
              !prompt.includes(supplied.trim()) &&
              !renderProductionInstruction(item.instruction).includes(supplied.trim())
            )
              throw new Error(
                'PROMPT_INSTRUCTION_CONFLICT: 正文与结构化指令不一致，请只提交结构或执行保留原文的绑定修改。',
              );
            if (item.entityType === 'scene') item.videoPrompt = prompt;
            else item.prompt = prompt;
          }
          if (item.sceneDocumentId)
            requireProductionSceneDocument(database, project.id, item.sceneDocumentId);
          if (item.characterDocumentIds !== undefined) {
            requireProductionCharacters(database, project.id, item.characterDocumentIds);
            if (item.targetId) {
              const target = database
                .prepare('SELECT row_version FROM scenes WHERE id=? AND project_id=?')
                .get(item.targetId, project.id) as { row_version: number } | undefined;
              if (!target || target.row_version !== item.expectedRowVersion)
                throw new Error('SCENE_ROW_VERSION_CONFLICT');
            }
          }
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
            item.sceneDocumentId ?? null,
            item.characterDocumentIds === undefined
              ? null
              : JSON.stringify({
                  sceneDocumentId: item.sceneDocumentId,
                  videoPrompt: item.videoPrompt,
                  characterDocumentIds: item.characterDocumentIds,
                }),
            now,
            now,
          );
          if (item.instruction)
            database
              .prepare(
                'INSERT INTO production_change_set_instructions(item_id,project_id,instruction_json) VALUES(?,?,?)',
              )
              .run(itemIds[ordinal], project.id, JSON.stringify(item.instruction));
        });
        rebuildLibraryChunksForChangeSet(database, project.id, id, now);
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
            const operations: ProductionExecuteParams['operations'] = [];
            for (const item of selected) {
              const appliedEntityId = this.applyItem(database, project.id, item, now);
              database
                .prepare(
                  `UPDATE agent_change_set_items
                   SET status = 'applied', applied_entity_id = ?, error_code = NULL, updated_at = ?
                   WHERE id = ? AND status = 'pending'`,
                )
                .run(appliedEntityId, now, item.id);
              if (item.production_instruction_json) {
                const kind = item.entity_type === 'scene' ? 'scene' : 'shot';
                const row = database
                  .prepare(
                    `SELECT row_version FROM ${kind === 'scene' ? 'scenes' : 'shots'} WHERE id=?`,
                  )
                  .get(appliedEntityId) as { row_version: number };
                operations.push({
                  action: 'set_prompt',
                  target: { kind, id: appliedEntityId },
                  expectedRowVersion: row.row_version,
                  instruction: JSON.parse(
                    item.production_instruction_json,
                  ) as ProductionInstruction,
                });
              }
            }
            for (let index = 0; index < operations.length; index += 30)
              new ProductionService(this.projects).execute({
                executionKey: `change-set:${set.id}:${set.row_version}:${index}`,
                operations: operations.slice(index, index + 30),
              });
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
    if (item.instruction) {
      if (!['scene', 'shot'].includes(item.entityType))
        throw new Error('Only scenes and shots accept production instructions.');
      const issues = inspectProductionTargetInstruction(item.instruction, item.entityType);
      if (issues.length) throw new Error(issues.map((issue) => issue.message).join('\n'));
      if (Buffer.byteLength(JSON.stringify(item.instruction)) > 512 * 1024)
        throw new Error('制作指令超过512 KiB。');
    }
    if (item.sceneDocumentId !== undefined) {
      if (item.entityType !== 'scene')
        throw new Error('Only scene proposals can bind scene documents.');
      if (item.sceneDocumentId !== null)
        item.sceneDocumentId = requiredText(item.sceneDocumentId, 'Scene document ID', 200);
    }
    if (item.videoPrompt !== undefined || item.characterDocumentIds !== undefined) {
      if (
        item.entityType !== 'scene' ||
        item.sceneDocumentId === undefined ||
        !Array.isArray(item.characterDocumentIds) ||
        typeof item.videoPrompt !== 'string'
      )
        throw new Error(
          'Scene bindings require videoPrompt, sceneDocumentId and characterDocumentIds together.',
        );
      item.videoPrompt = requiredText(item.videoPrompt, 'Scene video prompt', 20000);
    }
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
      if (
        item.parentSceneId ||
        item.parentItemOrdinal !== undefined ||
        item.shotStatus ||
        item.prompt !== undefined
      ) {
        throw new Error('Scene proposals cannot include shot parent, status or prompt fields.');
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
    if (item.prompt !== undefined) item.prompt = requiredText(item.prompt, 'Shot prompt', 20000);
    return item;
  }

  private applyItem(
    database: Database.Database,
    projectId: string,
    item: ItemRow,
    now: string,
  ): string {
    const bindings = item.scene_bindings_json
      ? (JSON.parse(item.scene_bindings_json) as {
          sceneDocumentId: string | null;
          videoPrompt: string;
          characterDocumentIds: string[];
        })
      : undefined;
    if (bindings) {
      try {
        requireProductionCharacters(database, projectId, bindings.characterDocumentIds);
      } catch {
        throw new ChangeSetConflict('SCENE_CHARACTER_CONFLICT');
      }
    }
    if (item.scene_document_id) {
      try {
        requireProductionSceneDocument(database, projectId, item.scene_document_id);
      } catch {
        throw new ChangeSetConflict('SCENE_DOCUMENT_CONFLICT');
      }
    }
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
          `INSERT INTO scenes (id, project_id, title, position, created_at, updated_at, row_version, scene_document_id)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run(id, projectId, item.title, position, now, now, item.scene_document_id);
      if (bindings) this.applySceneBindings(database, projectId, id, bindings);
      return id;
    }
    if (item.entity_type === 'scene') {
      const result = database
        .prepare(
          `UPDATE scenes SET title = ?, updated_at = ?, row_version = row_version + 1,
           scene_document_id = COALESCE(?, scene_document_id)
           WHERE id = ? AND project_id = ? AND row_version = ?`,
        )
        .run(
          item.title,
          now,
          item.scene_document_id,
          item.target_id,
          projectId,
          item.expected_row_version,
        );
      if (result.changes !== 1) throw new ChangeSetConflict('SCENE_ROW_VERSION_CONFLICT');
      if (bindings) this.applySceneBindings(database, projectId, item.target_id!, bindings);
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
           (id, scene_id, title, position, status, prompt, created_at, updated_at, row_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
        )
        .run(
          id,
          sceneId,
          item.title,
          position,
          item.shot_status ?? 'draft',
          item.shot_prompt ?? null,
          now,
          now,
        );
      return id;
    }
    const result = database
      .prepare(
        `UPDATE shots SET title = ?, status = COALESCE(?, status),
           prompt = COALESCE(?, prompt), updated_at = ?,
           row_version = row_version + 1
         WHERE id = ? AND row_version = ? AND scene_id IN (
           SELECT id FROM scenes WHERE project_id = ?
         )`,
      )
      .run(
        item.title,
        item.shot_status,
        item.shot_prompt,
        now,
        item.target_id,
        item.expected_row_version,
        projectId,
      );
    if (result.changes !== 1) throw new ChangeSetConflict('SHOT_ROW_VERSION_CONFLICT');
    return item.target_id!;
  }

  private applySceneBindings(
    database: Database.Database,
    projectId: string,
    sceneId: string,
    bindings: {
      sceneDocumentId: string | null;
      videoPrompt: string;
      characterDocumentIds: string[];
    },
  ): void {
    try {
      const cast = resolvedCast(database, projectId, sceneId, bindings.characterDocumentIds);
      const scene = database
        .prepare('SELECT material_bindings_json FROM scenes WHERE id=? AND project_id=?')
        .get(sceneId, projectId) as { material_bindings_json: string };
      const previous = JSON.parse(scene.material_bindings_json) as SceneMaterialBindingInfo[];
      const materials = previous.filter(
        (item) =>
          item.role !== 'scene' ||
          item.source !== 'auto' ||
          item.sourceDocumentId === bindings.sceneDocumentId,
      );
      if (bindings.sceneDocumentId && !materials.some((item) => item.role === 'scene')) {
        const image = productionReferenceImage(database, projectId, bindings.sceneDocumentId);
        const doc = database
          .prepare('SELECT title FROM documents WHERE id=?')
          .get(bindings.sceneDocumentId) as { title: string };
        if (image)
          materials.push({
            id: `scene:${bindings.sceneDocumentId}`,
            role: 'scene',
            label: doc.title,
            assetId: image.id,
            sourceDocumentId: bindings.sceneDocumentId,
            source: 'auto',
          });
      }
      database
        .prepare(
          'UPDATE scenes SET video_prompt=?,scene_document_id=?,material_bindings_json=? WHERE id=? AND project_id=?',
        )
        .run(
          bindings.videoPrompt,
          bindings.sceneDocumentId,
          JSON.stringify(materials),
          sceneId,
          projectId,
        );
      new SceneCharacterRepository(database).replace(sceneId, cast);
    } catch (error) {
      throw new ChangeSetConflict(
        error instanceof Error ? error.message : 'SCENE_BINDING_CONFLICT',
      );
    }
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
        `SELECT items.*, parent.ordinal AS parent_item_ordinal, instruction.instruction_json AS production_instruction_json
         FROM agent_change_set_items items
         LEFT JOIN agent_change_set_items parent ON parent.id = items.parent_item_id
         LEFT JOIN production_change_set_instructions instruction ON instruction.item_id = items.id AND instruction.project_id = items.project_id
         WHERE items.change_set_id = ? ORDER BY items.ordinal`,
      )
      .all(changeSetId) as ItemRow[];
  }
}
