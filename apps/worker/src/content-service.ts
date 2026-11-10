import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  ChatMessageInfo,
  ChatMessageListParams,
  ChatMessagePage,
  ChatMessageSaveParams,
  ConstraintInfo,
  ConversationArchiveParams,
  ConversationCreateParams,
  ConversationInfo,
  ConversationModelPreferenceGetParams,
  ConversationModelPreferenceInfo,
  ConversationModelPreferenceSetParams,
  ConversationModelPreferenceClearParams,
  ConversationPromptTemplateInfo,
  ConversationPromptTemplateSaveParams,
  ConversationListParams,
  ConversationPage,
  ConversationRestoreParams,
  ConversationScopeType,
  ConversationUpdateParams,
  DocumentDetail,
  DocumentKind,
  DocumentRestoreParams,
  DocumentSaveParams,
  DocumentSummary,
  DocumentVersionInfo,
  LlmAttemptInfo,
  LlmPricingSnapshotInfo,
  NormalizedLlmUsage,
  MessageConstraintParams,
  MessageDocumentParams,
  ProductionLifecycleParams,
  SceneInfo,
  SceneCharacterBindingInfo,
  SceneMaterialBindingInfo,
  SceneSaveParams,
  ShotInfo,
  ShotReferenceBindingInfo,
  ShotReferenceBindingResult,
  ShotReferenceBindingSaveParams,
  ShotSaveParams,
  ShotStoryboardSaveParams,
} from '@ai-video/contracts';
import { validatePromptBindings, validateProductionTiming } from '@ai-video/contracts';
import { validatePromptBindingReferences } from './prompt-binding-validation.js';
import type {
  ConversationModelPreferenceRecord,
  ConversationRecord,
  LlmGenerationAttemptRecord,
  ShotRecord,
} from '@ai-video/domain';
import {
  createRepositories,
  SceneCharacterRepository,
  rebuildLibraryChunksForRecord,
  syncLibraryChunksForChatMessage,
} from '@ai-video/persistence';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';
import { validateProductionImageBinding } from './scene-cast-binding.js';
import { resolvePromptSceneBindings } from './prompt-binding-media.js';
const documentKinds = new Set<DocumentKind>([
  'outline',
  'plan',
  'constraint',
  'character',
  'scene',
  'prop',
  'voice',
  'storyboard',
  'note',
]);
const scopeTypes = new Set<ConversationScopeType>(['project', 'scene', 'shot']);
function required(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}
function parseShotReferenceBindings(value?: string | null): ShotReferenceBindingInfo | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}
function shotReferenceBindingsTableExists(database: Database.Database): boolean {
  return Boolean(
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='shot_reference_bindings'")
      .get(),
  );
}
const sceneMaterialRoles = new Set<SceneMaterialBindingInfo['role']>([
  'character',
  'scene',
  'prop',
  'other',
]);
function asConversation(record: ConversationRecord): ConversationInfo {
  if (!scopeTypes.has(record.scopeType)) {
    throw new Error(`Unsupported conversation scope: ${record.scopeType}`);
  }
  return record;
}
function sliceConversationPage(
  items: ConversationInfo[],
  start: number,
  limit: number,
): ConversationPage {
  const page = items.slice(start, start + limit);
  return {
    items: page,
    nextCursor: items.length > start + limit ? page.at(-1)?.id : undefined,
  };
}
export class ContentService {
  private readonly workflow: DocumentWorkflowService;
  constructor(private readonly projects: ProjectService) {
    this.workflow = new DocumentWorkflowService(projects);
  }
  listDocuments(): DocumentSummary[] {
    return this.workflow.listDocuments();
  }
  getDocument(documentId: string): DocumentDetail {
    return this.workflow.getDocument(documentId);
  }
  saveDocument(params: DocumentSaveParams): DocumentDetail {
    if (params.kind && !documentKinds.has(params.kind))
      throw new Error('Document kind is invalid.');
    const existing = params.documentId ? this.workflow.getDocument(params.documentId) : undefined;
    return this.workflow.saveDraft({
      ...params,
      kind: params.kind ?? existing?.kind ?? 'note',
      expectedDocumentRowVersion: params.expectedDocumentRowVersion ?? existing?.rowVersion,
    });
  }
  listDocumentVersions(documentId: string): DocumentVersionInfo[] {
    return this.workflow.listVersions(documentId);
  }
  restoreDocument(params: DocumentRestoreParams): DocumentDetail {
    return this.workflow.restoreDocument(params);
  }
  listScenes(includeArchived = false): SceneInfo[] {
    return this.projects.access(false, (database, project) =>
      createRepositories(database)
        .scenes.listByProject(project.id, includeArchived)
        .map((scene) =>
          this.toSceneInfo(scene, new SceneCharacterRepository(database).list(scene.id)),
        ),
    );
  }
  changeProductionLifecycle(params: ProductionLifecycleParams): SceneInfo | ShotInfo {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const isScene = params.target.kind === 'scene';
        const shot = isScene ? undefined : repositories.shots.get(params.target.id);
        const scene = repositories.scenes.get(isScene ? params.target.id : (shot?.sceneId ?? ''));
        if (!scene || scene.projectId !== project.id || (!isScene && !shot))
          throw new Error('场次或镜头不存在于当前项目。');
        const target = isScene ? scene : shot!;
        if (target.rowVersion !== params.expectedRowVersion)
          throw new Error('内容已变化，请刷新目录后重试。');
        if (Boolean(target.archivedAt) === params.archived)
          throw new Error(params.archived ? '内容已归档。' : '内容已恢复。');
        if (!isScene && scene.archivedAt) throw new Error('请先恢复所属场次。');
        if (params.archived) {
          const shots = isScene ? repositories.shots.listByScene(scene.id, true) : [shot!];
          if (
            shots.some(
              (item) =>
                item.documentId && repositories.documents.get(item.documentId)?.publishedVersionId,
            )
          )
            throw new Error('包含已发布的分镜文档，请先取消发布后再归档或删除。');
        }
        const now = new Date().toISOString();
        const table = isScene ? 'scenes' : 'shots';
        const result = database
          .prepare(
            `UPDATE ${table} SET archived_at=?, updated_at=?, row_version=row_version+1 WHERE id=? AND row_version=?`,
          )
          .run(params.archived ? now : null, now, target.id, params.expectedRowVersion);
        if (result.changes !== 1) throw new Error('内容已变化，请刷新目录后重试。');
        database
          .prepare(
            `INSERT INTO production_lifecycle_events
        (id,project_id,target_kind,target_id,action,previous_row_version,created_at) VALUES(?,?,?,?,?,?,?)`,
          )
          .run(
            randomUUID(),
            project.id,
            params.target.kind,
            target.id,
            params.archived ? 'archive' : 'restore',
            target.rowVersion,
            now,
          );
        repositories.projects.touch(now);
        project.updatedAt = now;
        return isScene
          ? this.toSceneInfo(
              repositories.scenes.get(target.id)!,
              new SceneCharacterRepository(database).list(target.id),
            )
          : this.toShotInfo(
              repositories.shots.get(target.id)!,
              this.readShotReferenceBindings(database, project.id, target.id),
            );
      })(),
    );
  }
  saveScene(params: SceneSaveParams, allocation?: { newId: string }): SceneInfo {
    const title = required(params.title, 'Scene title');
    return this.projects.access(true, (db, project) =>
      db.transaction(() => {
        const repos = createRepositories(db),
          cast = new SceneCharacterRepository(db);
        const current = params.sceneId ? repos.scenes.get(params.sceneId) : undefined;
        if (params.sceneId && (!current || current.projectId !== project.id))
          throw new Error('Scene was not found.');
        if (current?.archivedAt) throw new Error('场次已归档，请先恢复。');
        if (current && current.rowVersion !== params.expectedRowVersion)
          throw new Error('SCENE_ROW_VERSION_CONFLICT');
        let bindings =
          params.bindings === undefined
            ? current?.bindingsJson
              ? validatePromptBindings(JSON.parse(current.bindingsJson))
              : undefined
            : params.bindings === null
              ? undefined
              : validatePromptBindings(params.bindings);
        const requestedLocations =
          params.sceneDocumentIds === undefined
            ? params.sceneDocumentId === undefined
              ? undefined
              : params.sceneDocumentId
                ? [params.sceneDocumentId]
                : []
            : (params.sceneDocumentIds ?? []);
        if (requestedLocations !== undefined)
          bindings = { schemaVersion: 1, ...bindings, sceneDocumentIds: requestedLocations };
        if (params.characterBindings !== undefined)
          bindings = {
            schemaVersion: 1,
            ...bindings,
            characterDocumentIds: params.characterBindings.map((item) => item.characterDocumentId),
          };
        if (bindings) validatePromptBindingReferences(db, project.id, bindings);
        const prompt = params.prompt ?? current?.prompt;
        if (prompt !== undefined && prompt.length > 20000)
          throw new Error('Scene prompt must be at most 20000 characters.');
        const timing =
          params.timing === undefined
            ? current?.timingJson
              ? validateProductionTiming(JSON.parse(current.timingJson))
              : undefined
            : validateProductionTiming(params.timing);
        const previousCast = current ? cast.list(current.id) : [];
        const materialBindings =
          params.materialBindings === undefined
            ? this.parseSceneMaterialBindings(current?.materialBindingsJson)
            : this.validateSceneMaterialBindings(db, project.id, params.materialBindings);
        const projected = resolvePromptSceneBindings(
          db,
          project.id,
          current?.id ?? '',
          bindings ?? { schemaVersion: 1 },
          { characterBindings: previousCast, materialBindings },
        );
        const characters = params.characterBindings ?? projected.characterBindings;
        if (
          characters.length > 30 ||
          new Set(characters.map((c) => c.characterDocumentId)).size !== characters.length
        )
          throw new Error('场次最多绑定 30 位不重复的角色。');
        for (const item of characters)
          if (item.imageAssetId)
            validateProductionImageBinding(
              db,
              project.id,
              item.imageAssetId,
              item.characterDocumentId,
              'character',
            );
        if (current && params.characterBindings !== undefined) {
          const speakers = db
            .prepare(
              "SELECT DISTINCT character_document_id AS id FROM dubbing_cues WHERE scene_id=? AND deleted_at IS NULL AND speaker_kind='character'",
            )
            .all(current.id) as Array<{ id: string }>;
          if (
            speakers.some(
              (speaker) => !characters.some((c) => c.characterDocumentId === speaker.id),
            )
          )
            throw new Error('角色仍有本场台词，请先移除或更改对应台词。');
        }
        const now = new Date().toISOString(),
          id = current?.id ?? allocation?.newId ?? randomUUID();
        repos.scenes.save({
          id,
          projectId: project.id,
          title,
          prompt,
          bindingsJson: bindings ? JSON.stringify(bindings) : undefined,
          timingJson: timing ? JSON.stringify(timing) : undefined,
          sceneDocumentId: projected.sceneDocumentId,
          materialBindingsJson: JSON.stringify(projected.materialBindings),
          dialogueAudioId:
            params.dialogueAudioId === undefined
              ? current?.dialogueAudioId
              : (params.dialogueAudioId ?? undefined),
          position:
            current?.position ??
            (repos.scenes.listByProject(project.id, true).at(-1)?.position ?? -1) + 1,
          rowVersion: current?.rowVersion ?? 0,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        });
        cast.replace(id, characters);
        rebuildLibraryChunksForRecord(
          db,
          project.id,
          {
            sourceType: 'scene',
            sourceId: id,
            status: 'active',
            title,
            content: title,
            scopeType: 'scene',
            scopeId: id,
          },
          now,
        );
        repos.projects.touch(now);
        project.updatedAt = now;
        return this.toSceneInfo(repos.scenes.get(id)!, cast.list(id));
      })(),
    );
  }
  private toSceneInfo(
    record: import('@ai-video/domain').SceneRecord,
    characterBindings: SceneCharacterBindingInfo[] = [],
  ): SceneInfo {
    const bindings = record.bindingsJson
      ? validatePromptBindings(JSON.parse(record.bindingsJson))
      : undefined;
    const sceneDocumentIds =
      bindings?.sceneDocumentIds ?? (record.sceneDocumentId ? [record.sceneDocumentId] : []);
    return {
      id: record.id,
      projectId: record.projectId,
      title: record.title,
      prompt: record.prompt,
      bindings,
      timing: record.timingJson
        ? validateProductionTiming(JSON.parse(record.timingJson))
        : undefined,
      sceneDocumentId: sceneDocumentIds.length === 1 ? sceneDocumentIds[0] : undefined,
      sceneDocumentIds,
      materialBindings: this.parseSceneMaterialBindings(record.materialBindingsJson),
      characterBindings,
      dialogueAudioId: record.dialogueAudioId,
      archivedAt: record.archivedAt,
      position: record.position,
      rowVersion: record.rowVersion,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  private parseSceneMaterialBindings(value?: string): SceneMaterialBindingInfo[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is SceneMaterialBindingInfo => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const candidate = item as Record<string, unknown>;
        return (
          typeof candidate.id === 'string' &&
          typeof candidate.label === 'string' &&
          typeof candidate.assetId === 'string' &&
          (candidate.source === 'auto' || candidate.source === 'manual') &&
          sceneMaterialRoles.has(candidate.role as SceneMaterialBindingInfo['role'])
        );
      });
    } catch {
      return [];
    }
  }
  private validateSceneMaterialBindings(
    database: Database.Database,
    projectId: string,
    bindings: SceneMaterialBindingInfo[],
  ): SceneMaterialBindingInfo[] {
    if (bindings.length > 30) throw new Error('A scene may bind at most 30 materials.');
    const ids = new Set<string>();
    return bindings.map((binding) => {
      if (!sceneMaterialRoles.has(binding.role)) throw new Error('Scene material role is invalid.');
      const label = required(binding.label, 'Scene material label');
      const assetId = required(binding.assetId, 'Scene material asset ID');
      if (ids.has(binding.id)) throw new Error('Scene material IDs must be unique.');
      ids.add(binding.id);
      const asset = createRepositories(database).assets.get(assetId);
      if (!asset || asset.projectId !== projectId || asset.deletedAt) {
        throw new Error('Scene material asset was not found.');
      }
      if (binding.role === 'scene' || binding.role === 'prop' || binding.role === 'character') {
        if (!binding.sourceDocumentId) throw new Error('角色、场景和道具参考图必须声明来源文档。');
        validateProductionImageBinding(
          database,
          projectId,
          assetId,
          binding.sourceDocumentId,
          binding.role,
        );
      } else if (binding.sourceDocumentId) {
        const document = createRepositories(database).documents.get(binding.sourceDocumentId);
        if (!document || document.projectId !== projectId)
          throw new Error('Scene material source document was not found.');
      }
      return {
        id: required(binding.id, 'Scene material ID'),
        role: binding.role,
        label,
        assetId,
        ...(binding.sourceDocumentId ? { sourceDocumentId: binding.sourceDocumentId } : {}),
        source: binding.source,
      };
    });
  }
  listShots(sceneId: string, includeArchived = false): ShotInfo[] {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const scene = repositories.scenes.get(sceneId);
      if (!scene || scene.projectId !== project.id) throw new Error('Scene was not found.');
      return repositories.shots
        .listByScene(sceneId, includeArchived)
        .map((record) =>
          this.toShotInfo(record, this.readShotReferenceBindings(database, project.id, record.id)),
        );
    });
  }
  getShotReferenceBindings(shotId: string): ShotReferenceBindingResult {
    return this.projects.access(false, (database, project) => {
      const shot = database
        .prepare(
          'SELECT id FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE s.id=? AND c.project_id=?',
        )
        .get(shotId, project.id);
      if (!shot) throw new Error('Shot was not found.');
      return {
        shotId,
        referenceBindings: this.readShotReferenceBindings(database, project.id, shotId),
      };
    });
  }
  saveShotReferenceBindings(params: ShotReferenceBindingSaveParams): ShotReferenceBindingResult {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        if (!shotReferenceBindingsTableExists(database))
          throw new Error('镜头参考图存储尚未迁移，请重启项目后重试。');
        const shot = database
          .prepare(
            `SELECT s.id,s.scene_id,s.bindings_json AS shotIR,
                    c.scene_document_id AS sceneDocumentId,c.bindings_json AS sceneIR
             FROM shots s JOIN scenes c ON c.id=s.scene_id
             WHERE s.id=? AND c.project_id=?`,
          )
          .get(params.shotId, project.id) as
          | {
              id: string;
              scene_id: string;
              shotIR: string | null;
              sceneDocumentId: string | null;
              sceneIR: string | null;
            }
          | undefined;
        if (!shot) throw new Error('Shot was not found.');
        const repos = createRepositories(database);
        if (
          repos.shots.get(params.shotId)?.archivedAt ||
          repos.scenes.get(shot.scene_id)?.archivedAt
        )
          throw new Error('场次或镜头已归档，请先恢复。');
        const bindings = params.referenceBindings ?? undefined;
        if (bindings) this.validateShotReferenceBindings(database, project.id, shot, bindings);
        if (bindings) {
          database
            .prepare(
              `INSERT INTO shot_reference_bindings(shot_id,project_id,bindings_json,updated_at)
               VALUES(?,?,?,?)
               ON CONFLICT(shot_id) DO UPDATE SET
                 project_id=excluded.project_id,bindings_json=excluded.bindings_json,
                 updated_at=excluded.updated_at`,
            )
            .run(params.shotId, project.id, JSON.stringify(bindings), new Date().toISOString());
        } else {
          database
            .prepare('DELETE FROM shot_reference_bindings WHERE shot_id=? AND project_id=?')
            .run(params.shotId, project.id);
        }
        return { shotId: params.shotId, referenceBindings: bindings };
      })(),
    );
  }
  private readShotReferenceBindings(
    database: Database.Database,
    projectId: string,
    shotId: string,
  ): ShotReferenceBindingInfo | undefined {
    if (!shotReferenceBindingsTableExists(database)) return undefined;
    const row = database
      .prepare('SELECT bindings_json FROM shot_reference_bindings WHERE shot_id=? AND project_id=?')
      .get(shotId, projectId) as
      | {
          bindings_json: string;
        }
      | undefined;
    return parseShotReferenceBindings(row?.bindings_json);
  }
  private validateShotReferenceBindings(
    database: Database.Database,
    projectId: string,
    shot: {
      scene_id: string;
      shotIR: string | null;
    },
    bindings: ShotReferenceBindingInfo,
  ): void {
    const shotIR = shot.shotIR ? validatePromptBindings(JSON.parse(shot.shotIR)) : undefined;
    const castIds = new Set(
      shotIR?.characterDocumentIds ??
        (bindings.characterBindings ?? []).map((item) => item.characterDocumentId),
    );
    const sceneIds = new Set([
      ...(shotIR?.sceneDocumentIds ??
        (bindings.sceneBindings ?? []).map((item) => item.sourceDocumentId)),
    ]);
    const characterAssets = [
      ...(bindings.characterAssetIds ?? []),
      ...(bindings.characterAssetId ? [bindings.characterAssetId] : []),
    ];
    const sceneAssets = [
      ...(bindings.sceneAssetIds ?? []),
      ...(bindings.sceneAssetId ? [bindings.sceneAssetId] : []),
    ];
    for (const binding of bindings.characterBindings ?? []) {
      if (!castIds.has(binding.characterDocumentId))
        throw new Error('镜头角色参考图与当前镜头绑定的角色不匹配。');
      this.validateShotReferenceAsset(
        database,
        projectId,
        binding.assetId,
        new Set([binding.characterDocumentId]),
      );
    }
    for (const binding of bindings.sceneBindings ?? []) {
      if (!sceneIds.has(binding.sourceDocumentId))
        throw new Error('镜头场景参考图与当前镜头绑定的场景不匹配。');
      this.validateShotReferenceAsset(
        database,
        projectId,
        binding.assetId,
        new Set([binding.sourceDocumentId]),
      );
    }
    for (const assetId of characterAssets)
      this.validateShotReferenceAsset(database, projectId, assetId, castIds);
    for (const assetId of sceneAssets)
      this.validateShotReferenceAsset(database, projectId, assetId, sceneIds);
    if (bindings.firstFrameAssetId)
      this.validateShotReferenceAsset(database, projectId, bindings.firstFrameAssetId, new Set());
  }
  private validateShotReferenceAsset(
    database: Database.Database,
    projectId: string,
    assetId: string,
    allowedDocuments: Set<string>,
  ): void {
    const asset = database
      .prepare(
        `SELECT id FROM assets
         WHERE id=? AND project_id=? AND deleted_at IS NULL AND lower(kind) NOT LIKE '%video%'`,
      )
      .get(assetId, projectId);
    if (!asset) throw new Error('镜头参考图不是当前项目中的有效图片。');
    if (!allowedDocuments.size) return;
    const sources = database
      .prepare(
        `SELECT DISTINCT json_extract(j.task_snapshot_json,'$.sourceDocumentId') AS sourceDocumentId
         FROM generation_results r
         JOIN generation_jobs j ON j.id=r.job_id AND j.project_id=?
         WHERE r.asset_id=? AND json_extract(j.task_snapshot_json,'$.sourceDocumentId') IS NOT NULL`,
      )
      .all(projectId, assetId) as Array<{
      sourceDocumentId: string | null;
    }>;
    const knownSources = sources
      .map((row) => row.sourceDocumentId)
      .filter((id): id is string => Boolean(id));
    if (knownSources.length && !knownSources.some((id) => allowedDocuments.has(id)))
      throw new Error('镜头参考图与当前镜头绑定的角色或场景不匹配。');
  }
  saveShot(params: ShotSaveParams, allocation?: { newId: string }): ShotInfo {
    const title = required(params.title, 'Shot title');
    if (params.prompt !== undefined && params.prompt.length > 20000)
      throw new Error('Shot prompt must be at most 20000 characters.');
    return this.projects.access(true, (db, project) =>
      db.transaction(() => {
        const repos = createRepositories(db),
          scene = repos.scenes.get(params.sceneId);
        if (!scene || scene.projectId !== project.id) throw new Error('Scene was not found.');
        const current = params.shotId ? repos.shots.get(params.shotId) : undefined;
        if (params.shotId && (!current || current.sceneId !== scene.id))
          throw new Error('Shot was not found.');
        if (scene.archivedAt || current?.archivedAt)
          throw new Error('场次或镜头已归档，请先恢复。');
        if (current && current.rowVersion !== params.expectedRowVersion)
          throw new Error('SHOT_ROW_VERSION_CONFLICT');
        const bindings =
          params.bindings === undefined
            ? current?.bindingsJson
              ? validatePromptBindings(JSON.parse(current.bindingsJson))
              : undefined
            : params.bindings === null
              ? undefined
              : validatePromptBindings(params.bindings);
        if (bindings) validatePromptBindingReferences(db, project.id, bindings);
        const timing =
          params.timing === undefined
            ? current?.timingJson
              ? validateProductionTiming(JSON.parse(current.timingJson))
              : undefined
            : validateProductionTiming(params.timing);
        if (params.documentId) {
          const document = repos.documents.get(params.documentId),
            owner = repos.shots.findByDocumentId(params.documentId);
          if (!document || document.projectId !== project.id || (owner && owner.id !== current?.id))
            throw new Error('Shot document was not found or is already attached.');
        }
        const now = new Date().toISOString(),
          id = current?.id ?? allocation?.newId ?? randomUUID();
        const record: ShotRecord = {
          id,
          sceneId: scene.id,
          title,
          prompt: params.prompt ?? current?.prompt,
          bindingsJson: bindings ? JSON.stringify(bindings) : undefined,
          timingJson: timing ? JSON.stringify(timing) : undefined,
          position:
            current?.position ??
            (repos.shots.listByScene(scene.id, true).at(-1)?.position ?? -1) + 1,
          status: params.status ?? current?.status ?? 'draft',
          documentId: params.documentId ?? current?.documentId,
          rowVersion: current?.rowVersion ?? 0,
          createdAt: current?.createdAt ?? now,
          updatedAt: now,
        };
        repos.shots.save(record);
        if (params.referenceBindings !== undefined)
          this.saveShotReferenceBindings({
            shotId: id,
            referenceBindings: params.referenceBindings,
          });
        rebuildLibraryChunksForRecord(
          db,
          project.id,
          {
            sourceType: 'shot',
            sourceId: id,
            documentId: record.documentId,
            status: record.status,
            title,
            content: [title, record.prompt].filter(Boolean).join('\n'),
            scopeType: 'shot',
            scopeId: id,
          },
          now,
        );
        repos.projects.touch(now);
        project.updatedAt = now;
        return this.toShotInfo(
          repos.shots.get(id)!,
          this.readShotReferenceBindings(db, project.id, id),
        );
      })(),
    );
  }
  private toShotInfo(record: ShotRecord, referenceBindings?: ShotReferenceBindingInfo): ShotInfo {
    return {
      id: record.id,
      sceneId: record.sceneId,
      title: record.title,
      position: record.position,
      status: record.status,
      documentId: record.documentId,
      archivedAt: record.archivedAt,
      prompt: record.prompt,
      bindings: record.bindingsJson
        ? validatePromptBindings(JSON.parse(record.bindingsJson))
        : undefined,
      timing: record.timingJson
        ? validateProductionTiming(JSON.parse(record.timingJson))
        : undefined,
      referenceBindings,
      rowVersion: record.rowVersion,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }
  saveShotStoryboard(params: ShotStoryboardSaveParams): DocumentDetail {
    const title = required(params.title, 'Storyboard title');
    const resolved = this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const shot = repositories.shots.get(params.shotId);
      if (!shot) throw new Error('Shot was not found.');
      const scene = repositories.scenes.get(shot.sceneId);
      if (!scene || scene.projectId !== project.id) throw new Error('Shot was not found.');
      if (scene.archivedAt || shot.archivedAt) throw new Error('场次或镜头已归档，请先恢复。');
      const document = shot.documentId ? repositories.documents.get(shot.documentId) : undefined;
      return {
        shotId: shot.id,
        documentId: shot.documentId,
        documentRowVersion: document?.rowVersion,
      };
    });
    const document = resolved.documentId
      ? this.workflow.saveDraft({
          documentId: resolved.documentId,
          kind: 'storyboard',
          title,
          contentMarkdown: params.contentMarkdown,
          scopeType: 'shot',
          scopeId: resolved.shotId,
          expectedDocumentRowVersion: resolved.documentRowVersion,
          authorType: 'user',
        })
      : this.workflow.saveDraft({
          kind: 'storyboard',
          title,
          contentMarkdown: params.contentMarkdown,
          scopeType: 'shot',
          scopeId: resolved.shotId,
          authorType: 'user',
        });
    if (!resolved.documentId) {
      this.projects.access(true, (database) => {
        const repositories = createRepositories(database);
        const shot = repositories.shots.get(resolved.shotId);
        if (!shot || shot.documentId) return;
        repositories.shots.save({ ...shot, documentId: document.id });
        repositories.projects.touch(new Date().toISOString());
      });
    }
    return document;
  }
  listConstraints(): ConstraintInfo[] {
    return this.projects.access(false, (database, project) =>
      createRepositories(database)
        .constraints.listByProject(project.id)
        .map((record) => ({
          id: record.id,
          projectId: record.projectId,
          scopeType: record.scopeType as ConstraintInfo['scopeType'],
          scopeId: record.scopeId,
          kind: record.kind,
          content: record.content,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
        })),
    );
  }
  listConversations(params: ConversationListParams): ConversationPage {
    const query = params.query?.trim().toLocaleLowerCase();
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
    return this.projects.access(false, (database, project) => {
      const repo = createRepositories(database).conversations;
      // If there is an in-memory query filter, use project-wide query; otherwise use keyset pagination directly
      if (query) {
        const conversations = repo
          .listByProject(project.id)
          .map(asConversation)
          .filter(
            (conversation) =>
              (!params.scopeType || conversation.scopeType === params.scopeType) &&
              (params.scopeId === undefined || conversation.scopeId === params.scopeId) &&
              (params.includeArchived || !conversation.archivedAt) &&
              conversation.title.toLocaleLowerCase().includes(query),
          );
        if (params.cursor !== undefined) {
          const cursorIndex = conversations.findIndex((item) => item.id === params.cursor);
          if (cursorIndex < 0) return { items: [], nextCursor: undefined };
          return sliceConversationPage(conversations, cursorIndex + 1, limit);
        }
        return sliceConversationPage(conversations, 0, limit);
      }
      const paged = repo.listPageByProject(project.id, {
        limit: limit + 1,
        cursor: params.cursor,
        scopeType: params.scopeType,
        scopeId: params.scopeId,
        includeArchived: params.includeArchived,
      });
      const hasMore = paged.length > limit;
      const items = paged.slice(0, limit).map(asConversation);
      return {
        items,
        nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
      };
    });
  }
  createConversation(params: ConversationCreateParams): ConversationInfo {
    if (!scopeTypes.has(params.scopeType)) throw new Error('Conversation scope is invalid.');
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      this.assertScope(repositories, project.id, params.scopeType, params.scopeId);
      const now = new Date().toISOString();
      const record: ConversationInfo = {
        id: randomUUID(),
        projectId: project.id,
        scopeType: params.scopeType,
        scopeId: params.scopeType === 'project' ? undefined : params.scopeId,
        title: params.title?.trim() || '新会话',
        createdAt: now,
        updatedAt: now,
      };
      repositories.conversations.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return record;
    });
  }
  updateConversation(params: ConversationUpdateParams): ConversationInfo {
    const title = required(params.title, 'Conversation title');
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const existing = repositories.conversations.get(params.conversationId);
      if (!existing || existing.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      if (existing.archivedAt) throw new Error('Archived conversations cannot be renamed.');
      const now = new Date().toISOString();
      const record: ConversationRecord = { ...existing, title, updatedAt: now };
      repositories.conversations.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return asConversation(record);
    });
  }
  archiveConversation(params: ConversationArchiveParams): ConversationInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const existing = repositories.conversations.get(params.conversationId);
      if (!existing || existing.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      if (existing.archivedAt) return asConversation(existing);
      const now = new Date().toISOString();
      const record: ConversationRecord = { ...existing, archivedAt: now, updatedAt: now };
      repositories.conversations.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return asConversation(record);
    });
  }
  restoreConversation(params: ConversationRestoreParams): ConversationInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const existing = repositories.conversations.get(params.conversationId);
      if (!existing || existing.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      if (!existing.archivedAt) return asConversation(existing);
      const now = new Date().toISOString();
      const record: ConversationRecord = { ...existing, archivedAt: undefined, updatedAt: now };
      repositories.conversations.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return asConversation(record);
    });
  }
  getConversationModelPreference(
    params: ConversationModelPreferenceGetParams,
  ): ConversationModelPreferenceInfo | null {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(params.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      return (
        repositories.conversationModelPreferences.get(params.conversationId, params.capability) ??
        null
      );
    });
  }
  listConversationModelPreferences(conversationId: string): ConversationModelPreferenceInfo[] {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      return repositories.conversationModelPreferences.listByConversation(conversationId);
    });
  }
  setConversationModelPreference(
    params: ConversationModelPreferenceSetParams,
  ): ConversationModelPreferenceInfo {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(params.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      if (conversation.archivedAt) throw new Error('Archived conversations cannot be updated.');
      const providerProfileId = required(params.providerProfileId, 'Provider profile ID');
      const modelId = required(params.modelId, 'Model ID');
      const now = new Date().toISOString();
      const record: ConversationModelPreferenceRecord = {
        conversationId: conversation.id,
        capability: params.capability,
        providerProfileId,
        modelId,
        confirmedAt: now,
        updatedAt: now,
      };
      repositories.conversationModelPreferences.save(record);
      repositories.projects.touch(now);
      return record;
    });
  }
  clearConversationModelPreference(params: ConversationModelPreferenceClearParams): {
    cleared: boolean;
  } {
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(params.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      if (conversation.archivedAt) throw new Error('Archived conversations cannot be updated.');
      const existed = repositories.conversationModelPreferences.get(
        conversation.id,
        params.capability,
      );
      repositories.conversationModelPreferences.delete(conversation.id, params.capability);
      if (existed) repositories.projects.touch(new Date().toISOString());
      return { cleared: Boolean(existed) };
    });
  }
  getConversationPromptTemplate(conversationId: string): ConversationPromptTemplateInfo {
    return this.projects.access(false, (database, project) => {
      const conversation = createRepositories(database).conversations.get(conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      const row = database
        .prepare(
          `SELECT conversation_id, content, row_version, created_at, updated_at
           FROM conversation_prompt_templates WHERE conversation_id = ?`,
        )
        .get(conversationId) as
        | {
            conversation_id: string;
            content: string;
            row_version: number;
            created_at: string;
            updated_at: string;
          }
        | undefined;
      return row
        ? {
            conversationId: row.conversation_id,
            content: row.content,
            rowVersion: row.row_version,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
          }
        : { conversationId, content: '', rowVersion: 0 };
    });
  }
  saveConversationPromptTemplate(
    params: ConversationPromptTemplateSaveParams,
  ): ConversationPromptTemplateInfo {
    if (typeof params.content !== 'string') {
      throw new Error('Conversation prompt template must be a string.');
    }
    if (!Number.isInteger(params.expectedRowVersion) || params.expectedRowVersion < 0) {
      throw new Error('Conversation prompt template row version is invalid.');
    }
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const repositories = createRepositories(database);
        const conversation = repositories.conversations.get(params.conversationId);
        if (!conversation || conversation.projectId !== project.id) {
          throw new Error('Conversation was not found.');
        }
        if (conversation.archivedAt) throw new Error('Archived conversations cannot be updated.');
        const existing = database
          .prepare(
            `SELECT conversation_id, content, row_version, created_at, updated_at
             FROM conversation_prompt_templates WHERE conversation_id = ?`,
          )
          .get(conversation.id) as
          | {
              conversation_id: string;
              content: string;
              row_version: number;
              created_at: string;
              updated_at: string;
            }
          | undefined;
        const currentVersion = existing?.row_version ?? 0;
        if (currentVersion !== params.expectedRowVersion) {
          throw new Error('CONVERSATION_PROMPT_TEMPLATE_ROW_VERSION_CONFLICT');
        }
        const now = new Date().toISOString();
        const nextVersion = currentVersion + 1;
        if (existing) {
          const result = database
            .prepare(
              `UPDATE conversation_prompt_templates
               SET content = ?, row_version = ?, updated_at = ?
               WHERE conversation_id = ? AND project_id = ? AND row_version = ?`,
            )
            .run(
              params.content,
              nextVersion,
              now,
              conversation.id,
              project.id,
              params.expectedRowVersion,
            );
          if (result.changes !== 1)
            throw new Error('CONVERSATION_PROMPT_TEMPLATE_ROW_VERSION_CONFLICT');
        } else {
          database
            .prepare(
              `INSERT INTO conversation_prompt_templates
               (conversation_id, project_id, content, row_version, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
            )
            .run(conversation.id, project.id, params.content, nextVersion, now, now);
        }
        repositories.conversations.save({ ...conversation, updatedAt: now });
        repositories.projects.touch(now);
        project.updatedAt = now;
        return {
          conversationId: conversation.id,
          content: params.content,
          rowVersion: nextVersion,
          createdAt: existing?.created_at ?? now,
          updatedAt: now,
        };
      })(),
    );
  }
  listMessages(params: ChatMessageListParams): ChatMessagePage {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(params.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      const limit = Math.min(Math.max(params.limit ?? 50, 1), 100);
      const descending = repositories.chatMessages.listPage(
        conversation.id,
        limit + 1,
        params.before,
      );
      const hasMore = descending.length > limit;
      const items = descending
        .slice(0, limit)
        .reverse()
        .map((message) => {
          const attempt = repositories.llmGenerationAttempts.getByAssistantMessage(message.id);
          return attempt ? { ...message, attempt: toAttemptInfo(attempt) } : message;
        });
      return { items, nextCursor: hasMore ? items[0]?.id : undefined };
    });
  }
  saveMessage(params: ChatMessageSaveParams): ChatMessageInfo {
    if (!params.content.trim() && params.status !== 'streaming') {
      throw new Error('Message content is required.');
    }
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(params.conversationId);
      if (!conversation || conversation.projectId !== project.id) {
        throw new Error('Conversation was not found.');
      }
      if (conversation.archivedAt) {
        throw new Error('Archived conversations cannot be updated.');
      }
      const existing = params.messageId
        ? repositories.chatMessages.get(params.messageId)
        : undefined;
      if (params.messageId && (!existing || existing.conversationId !== conversation.id)) {
        throw new Error('Message was not found.');
      }
      const replyToMessageId = params.replyToMessageId ?? existing?.replyToMessageId;
      const replyToMessage = replyToMessageId
        ? repositories.chatMessages.get(replyToMessageId)
        : undefined;
      if (
        replyToMessageId &&
        (!replyToMessage ||
          replyToMessage.conversationId !== conversation.id ||
          replyToMessage.role !== 'user')
      ) {
        throw new Error('Reply target must be a user message in the same conversation.');
      }
      const now = new Date().toISOString();
      const record: ChatMessageInfo = {
        id: existing?.id ?? randomUUID(),
        conversationId: conversation.id,
        replyToMessageId,
        role: existing?.role ?? params.role,
        content: params.content,
        status: params.status ?? 'complete',
        createdAt: existing?.createdAt ?? now,
      };
      repositories.chatMessages.save(record);
      syncLibraryChunksForChatMessage(database, project.id, record, conversation, now);
      repositories.conversations.save({ ...conversation, updatedAt: now });
      repositories.projects.touch(now);
      project.updatedAt = now;
      return record;
    });
  }
  messageToDocument(params: MessageDocumentParams): DocumentDetail {
    return this.workflow.createDocumentDraftFromMessage({
      messageId: params.messageId,
      title: params.title,
    }).document;
  }
  messageToMemory(messageId: string): {
    id: string;
  } {
    const content = this.getMessageContent(messageId);
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const now = new Date().toISOString();
      const id = randomUUID();
      repositories.memories.save({
        id,
        projectId: project.id,
        scopeType: 'project',
        content,
        createdAt: now,
        updatedAt: now,
      });
      rebuildLibraryChunksForRecord(
        database,
        project.id,
        {
          sourceType: 'memory',
          sourceId: id,
          status: 'memory',
          scopeType: 'project',
          title: '项目记忆',
          content,
        },
        now,
      );
      repositories.projects.touch(now);
      project.updatedAt = now;
      return { id };
    });
  }
  messageToConstraint(params: MessageConstraintParams): {
    id: string;
  } {
    const content = this.getMessageContent(params.messageId);
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const now = new Date().toISOString();
      const id = randomUUID();
      repositories.constraints.save({
        id,
        projectId: project.id,
        scopeType: 'project',
        kind: params.kind?.trim() || 'production',
        content,
        createdAt: now,
        updatedAt: now,
      });
      rebuildLibraryChunksForRecord(
        database,
        project.id,
        {
          sourceType: 'constraint',
          sourceId: id,
          status: 'constraint',
          kind: params.kind?.trim() || 'production',
          scopeType: 'project',
          title: `生产约束：${params.kind?.trim() || 'production'}`,
          content,
        },
        now,
      );
      repositories.projects.touch(now);
      project.updatedAt = now;
      return { id };
    });
  }
  private getMessageContent(messageId: string): string {
    return this.getMessageContext(messageId).content;
  }
  private getMessageContext(messageId: string): {
    content: string;
    conversation: ConversationRecord;
  } {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const message = repositories.chatMessages.get(messageId);
      const conversation = message
        ? repositories.conversations.get(message.conversationId)
        : undefined;
      if (!message || conversation?.projectId !== project.id)
        throw new Error('Message was not found.');
      return { content: message.content, conversation };
    });
  }
  private assertScope(
    repositories: ReturnType<typeof createRepositories>,
    projectId: string,
    scopeType: ConversationScopeType,
    scopeId?: string,
  ): void {
    if (scopeType === 'project') return;
    if (!scopeId) throw new Error('scopeId is required for scene and shot conversations.');
    if (scopeType === 'scene') {
      const scene = repositories.scenes.get(scopeId);
      if (!scene || scene.projectId !== projectId) throw new Error('Scene was not found.');
      return;
    }
    const shot = repositories.shots.get(scopeId);
    const scene = shot ? repositories.scenes.get(shot.sceneId) : undefined;
    if (!shot || scene?.projectId !== projectId) throw new Error('Shot was not found.');
  }
}
function toAttemptInfo(attempt: LlmGenerationAttemptRecord): LlmAttemptInfo {
  let persistedUsage: NormalizedLlmUsage | undefined;
  if (attempt.rawUsageJson) {
    try {
      persistedUsage = JSON.parse(attempt.rawUsageJson) as NormalizedLlmUsage;
    } catch {
      persistedUsage = undefined;
    }
  }
  const usage =
    attempt.inputTokens !== undefined ||
    attempt.cachedInputTokens !== undefined ||
    attempt.outputTokens !== undefined ||
    attempt.reasoningTokens !== undefined ||
    attempt.totalTokens !== undefined ||
    persistedUsage?.providerReportedCost !== undefined
      ? {
          inputTokens: attempt.inputTokens,
          cachedInputTokens: attempt.cachedInputTokens,
          outputTokens: attempt.outputTokens,
          reasoningTokens: attempt.reasoningTokens,
          totalTokens: attempt.totalTokens,
          providerReportedCost: persistedUsage?.providerReportedCost,
        }
      : undefined;
  let pricingSnapshot: LlmPricingSnapshotInfo | undefined;
  if (attempt.pricingSnapshotJson) {
    try {
      pricingSnapshot = JSON.parse(attempt.pricingSnapshotJson) as LlmPricingSnapshotInfo;
    } catch {
      pricingSnapshot = undefined;
    }
  }
  return {
    id: attempt.id,
    generationId: attempt.generationId,
    providerProfileId: attempt.providerProfileId,
    providerName: attempt.providerNameSnapshot,
    modelId: attempt.modelId,
    modelName: attempt.modelNameSnapshot,
    protocol: attempt.protocol,
    status: attempt.status,
    startedAt: attempt.startedAt,
    firstTokenAt: attempt.firstTokenAt,
    completedAt: attempt.completedAt,
    providerResponseId: attempt.providerResponseId,
    finishReason: attempt.finishReason,
    usage,
    pricingSnapshot,
    estimatedCost: attempt.estimatedCost,
    currency: attempt.currency,
    providerReportedCost: usage?.providerReportedCost,
    errorCode: attempt.errorCode,
    errorMessage: attempt.errorMessage,
  };
}
