import { randomUUID } from 'node:crypto';
import { AgentInputService } from './agent-input-service.js';
import type Database from 'better-sqlite3';
import type {
  AgentProtectedUiHandoff,
  AssetGroupInfo,
  AssetInfo,
  AssetListParams,
  AssetTagInfo,
  CacheClearResult,
  CacheInspectionResult,
  ConversationInfo,
  ContextSnapshotCleanupResult,
  MediaTaskSummary,
  NovelChapterArchiveParams,
  NovelChapterInfo,
  NovelChapterListParams,
  NovelChapterMetadataUpdateParams,
  NovelChapterRestoreParams,
  ProviderModelInfo,
  ProviderProfileInfo,
  ProjectStructureSnapshot,
  ResearchCacheCleanupResult,
  WorkerMetricsSnapshot,
} from '@ai-video/contracts';
import type { SystemAgentToolOperation } from './agent-tool-definitions.js';
import { AgentToolPolicyError, unifiedAgentToolRegistry } from './agent-tool-registry.js';
import { ContentService } from './content-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';
import { ProjectStructureCompiler } from './structure-compiler.js';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import { AgentDraftSubmissionService } from './agent-draft-submission-service.js';
import { compileProjectResourceMap } from './project-resource-map.js';
import { SceneStructureSubmissionService } from './scene-structure-submission-service.js';
import { splitConversationRequest } from './conversation-request.js';
import { ProductionService } from './production-service.js';
import { AgentProductionQueryService } from './agent-production-query-service.js';
import { ShotTimingService } from './shot-timing-service.js';
import { ShotPromptService } from './shot-prompt-service.js';
import { describeProductionAsset, readAssetProvenance } from './production-media-view.js';
import type { ProductionTarget } from '@ai-video/contracts';
import type { NovelBatchService } from './novel-batch-service.js';
import { readProductionSkill } from './production-skill-service.js';
import type { MediaReviewService } from './media-review-service.js';

export interface AgentAssetToolService {
  listAssets(params: AssetListParams): AssetInfo[];
  getAssetInfo(assetId: string): AssetInfo;
  updateAssetAlias(params: { assetId: string; alias: string }): AssetInfo;
  listTags(keyword?: string): AssetTagInfo[];
  createTag(name: string): AssetTagInfo;
  updateTag(tagId: string, name: string): AssetTagInfo;
  deleteTag(tagId: string): { deleted: true };
  changeAssetTags(assetIds: string[], tagIds: string[], operation: 'add' | 'remove'): AssetInfo[];
  listGroups(keyword?: string): AssetGroupInfo[];
  createGroup(name: string, tagIds: string[], assetIds: string[]): AssetGroupInfo;
  updateGroup(groupId: string, name: string, tagIds: string[], assetIds: string[]): AssetGroupInfo;
  deleteGroup(groupId: string): { deleted: true };
  resolveGroup(groupId: string): AssetInfo[];
  deleteAsset(assetId: string, confirm?: boolean): { deleted: true; referenceCount: number };
  restoreAsset(assetId: string): AssetInfo;
}

export interface AgentSettingsToolService {
  listProfiles(includeArchived?: boolean): ProviderProfileInfo[];
  listModels(profileId: string): ProviderModelInfo[];
}

export interface AgentMediaTaskService {
  getTask(taskId: string): MediaTaskSummary;
}

export interface AgentNovelToolService {
  listChapters(params?: NovelChapterListParams): NovelChapterInfo[];
  updateChapterMetadata(params: NovelChapterMetadataUpdateParams): NovelChapterInfo;
  archiveChapter(params: NovelChapterArchiveParams): NovelChapterInfo;
  restoreChapter(params: NovelChapterRestoreParams): NovelChapterInfo;
}

export interface AgentMaintenanceToolService {
  getMetrics(): WorkerMetricsSnapshot;
  inspectCache(): CacheInspectionResult;
  clearCache(): CacheClearResult;
  cleanupResearchCache(maxBytes?: number): ResearchCacheCleanupResult;
  cleanupContextSnapshots(params?: { olderThanDays?: number }): ContextSnapshotCleanupResult;
}

export interface AgentSystemToolConfirmationPreview {
  summary: string;
  affectedEntities: Array<{ type: string; id: string; label?: string }>;
  executionArguments: Record<string, unknown>;
  protectedUi?: AgentProtectedUiHandoff;
}

export interface AgentSystemToolIdentity {
  projectId: string;
  projectSessionId: string;
  conversationId: string;
  /** Worker-injected execution identity; never accepted in model arguments. */
  taskId?: string;
  toolCallId?: string;
}

/** Executes bounded system tools through the same services used by the Desktop UI. */
export class AgentSystemToolService {
  private readonly productionQueries: AgentProductionQueryService;
  constructor(
    private readonly projects: ProjectService,
    private readonly content: ContentService,
    private readonly assets: AgentAssetToolService,
    private readonly settings: AgentSettingsToolService,
    private readonly mediaTasks?: AgentMediaTaskService,
    private readonly documents?: DocumentWorkflowService,
    private readonly maintenance?: AgentMaintenanceToolService,
    private readonly structureCompiler?: ProjectStructureCompiler,
    private readonly novels?: AgentNovelToolService,
    private readonly batches?: Pick<NovelBatchService, 'submit' | 'get' | 'readSource'>,
    private readonly mediaReviews?: MediaReviewService,
  ) {
    this.productionQueries = new AgentProductionQueryService(new ProductionService(projects));
  }

  availableOperations(): SystemAgentToolOperation[] {
    return SYSTEM_AGENT_TOOLS.map((tool) => tool.name as SystemAgentToolOperation).filter(
      (name) => {
        if (name.startsWith('media.review.') || name === 'media.audio.read')
          return Boolean(this.mediaReviews);
        if (name.startsWith('novel.chapter.batch.')) return Boolean(this.batches);
        if (name === 'project.structure.get' || name === 'novel.structure.get')
          return !!this.structureCompiler;
        if (
          name === 'novel.chapter.list' ||
          name === 'novel.chapter.update_metadata' ||
          name === 'novel.chapter.archive' ||
          name === 'novel.chapter.restore'
        )
          return !!this.novels;
        if (
          name === 'document.submit_draft' ||
          name === 'novel.chapter.write_draft' ||
          name === 'document.publish'
        )
          return !!this.documents;
        if (name.startsWith('maintenance.')) return !!this.maintenance;
        if (name === 'media.task.get') return !!this.mediaTasks;
        return true;
      },
    );
  }

  execute(
    operation: SystemAgentToolOperation,
    rawArguments: unknown,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    this.assertIdentity(identity);
    const args = requireArguments(rawArguments);
    switch (operation) {
      case 'conversation.ask': {
        const form = new AgentInputService(this.projects).prepare(args, identity);
        return {
          formId: form.id,
          title: form.title,
          status: form.status,
          questionCount: form.questions.length,
          presentation: 'conversation-form',
          awaitingUserAnswer: form.status === 'pending',
        };
      }
      case 'media.review.prepare': {
        if (!this.mediaReviews) throw unavailable('Media review');
        const form = this.mediaReviews.prepare(args, identity);
        return { form: this.reviewSummary(form) };
      }
      case 'media.review.list':
        rejectUnknown(args, ['offset', 'limit']);
        if (!this.mediaReviews) throw unavailable('Media review');
        {
          const forms = this.mediaReviews.list(identity.conversationId);
          const offset = optionalInteger(args.offset, 'offset', 0, 1_000_000) ?? 0;
          const limit = optionalInteger(args.limit, 'limit', 1, 50) ?? 20;
          const nextOffset = offset + limit < forms.length ? offset + limit : undefined;
          return {
            forms: forms.slice(offset, offset + limit).map((form) => this.reviewSummary(form)),
            total: forms.length,
            nextOffset,
            truncated: nextOffset !== undefined,
          };
        }
      case 'media.review.read': {
        rejectUnknown(args, ['formId']);
        if (!this.mediaReviews) throw unavailable('Media review');
        const form = this.mediaReviews.get(requiredString(args.formId, 'formId', 200));
        if (form.conversationId !== identity.conversationId) throw projectScopeError('review form');
        return { form: { ...this.reviewSummary(form), draft: form.draft } };
      }
      case 'media.audio.read':
        rejectUnknown(args, ['sceneId']);
        if (!this.mediaReviews) throw unavailable('Media review');
        return { audio: this.mediaReviews.readAudio(requiredString(args.sceneId, 'sceneId', 200)) };
      case 'production.skill.read':
        return readProductionSkill(args);
      case 'conversation.task.route':
        return this.routeConversationTask(args, identity);
      case 'novel.chapter.batch.submit':
        if (!this.batches) throw unavailable('Chapter batches');
        return this.batches.submit(args, identity);
      case 'novel.chapter.batch.source.read':
        if (!this.batches) throw unavailable('Chapter batch sources');
        return this.batches.readSource(args, identity);
      case 'novel.chapter.batch.get':
        if (!this.batches) throw unavailable('Chapter batches');
        rejectUnknown(args, ['batchId']);
        return { ...this.batches.get(requiredString(args.batchId, 'batchId', 128)) };
      case 'production.defaults.get':
        rejectUnknown(args, []);
        return new ProductionService(this.projects).getDefaults() as unknown as Record<
          string,
          unknown
        >;
      case 'production.read':
        rejectUnknown(args, ['target', 'view', 'offset', 'limit', 'expectedVersion', 'ifVersion']);
        return this.productionQueries.read(
          args.target as ProductionTarget,
          args,
          identity,
          'authoring',
        );
      case 'scene.read': {
        rejectUnknown(args, ['sceneId', 'view', 'offset', 'limit', 'expectedVersion', 'ifVersion']);
        const sceneId = requiredString(args.sceneId, 'sceneId', 200);
        const scene = this.content.listScenes().find((item) => item.id === sceneId);
        if (!scene) throw new Error('Scene was not found in the current project.');
        return this.productionQueries.read(
          { kind: 'scene', id: sceneId },
          args,
          identity,
          'structure',
        );
      }
      case 'scene.submit_structure':
        return new SceneStructureSubmissionService(this.projects).submit(args, identity);
      case 'scene.update_shot_timings':
        return new ShotTimingService(this.projects).update(args, identity);
      case 'scene.update_shot_prompts':
        return new ShotPromptService(this.projects).update(args, identity);
      case 'scene.structure.stage':
        return new SceneStructureSubmissionService(this.projects).stage(args, identity);
      case 'document.submit_draft':
      case 'novel.chapter.write_draft':
        if (!this.documents) throw unavailable('Draft submission');
        return new AgentDraftSubmissionService(this.projects, this.documents).submit(
          operation,
          args,
          identity,
        );
      case 'project.get_context':
        rejectUnknown(args, []);
        return this.projectContext();
      case 'project.structure.get':
        return this.projectStructure(args);
      case 'novel.structure.get':
        return this.novelStructure(args);
      case 'novel.chapter.list':
        return this.listNovelChapters(args);
      case 'novel.chapter.update_metadata': {
        rejectUnknown(args, [
          'chapterId',
          'expectedChapterRowVersion',
          'expectedDocumentRowVersion',
          'title',
          'displayLabel',
        ]);
        if (!this.novels) throw unavailable('Novel chapter metadata');
        const chapter = this.novels.updateChapterMetadata({
          chapterId: requiredString(args.chapterId, 'chapterId', 200),
          expectedChapterRowVersion: requiredInteger(
            args.expectedChapterRowVersion,
            'expectedChapterRowVersion',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          expectedDocumentRowVersion: requiredInteger(
            args.expectedDocumentRowVersion,
            'expectedDocumentRowVersion',
            0,
            Number.MAX_SAFE_INTEGER,
          ),
          ...(args.title !== undefined ? { title: requiredString(args.title, 'title', 200) } : {}),
          ...(args.displayLabel !== undefined
            ? { displayLabel: requiredString(args.displayLabel, 'displayLabel', 80) }
            : {}),
        });
        return {
          status: 'chapter_metadata_saved',
          chapterId: chapter.id,
          documentId: chapter.documentId,
          chapter: toNovelChapterSummary(chapter),
          locator: { workspace: 'novel', chapterId: chapter.id, documentId: chapter.documentId },
        };
      }
      case 'project.integrity.check':
        rejectUnknown(args, []);
        return this.projectIntegrity();
      case 'conversation.search':
        return this.searchConversations(args);
      case 'conversation.create':
        return this.createConversation(args);
      case 'conversation.rename':
        return this.renameConversation(args, identity.conversationId);
      case 'asset.search':
        return this.searchAssets(args);
      case 'asset.get':
        return this.getAsset(args);
      case 'asset.update_alias':
        return this.updateAssetAlias(args);
      case 'asset.update_tags':
        return this.updateAssetTags(args);
      case 'tag.list':
        return this.listTags(args);
      case 'tag.create':
        return this.createTag(args);
      case 'tag.update':
        return this.updateTag(args);
      case 'assetGroup.list':
        return this.listGroups(args);
      case 'assetGroup.create':
        return this.createGroup(args);
      case 'assetGroup.update':
        return this.updateGroup(args);
      case 'assetGroup.resolve':
        return this.resolveGroup(args);
      case 'settings.get':
        return this.settingsSummary(args);
      case 'maintenance.status':
        return this.maintenanceStatus(args);
      case 'media.task.get':
        return this.mediaTask(args);
      case 'project.backup.prepare':
      case 'project.export.prepare':
      case 'project.restore.prepare':
      case 'conversation.archive':
      case 'conversation.restore':
      case 'novel.chapter.archive':
      case 'novel.chapter.restore':
      case 'document.publish':
      case 'asset.move_to_trash':
      case 'asset.restore':
      case 'asset.purge':
      case 'tag.delete':
      case 'assetGroup.delete':
      case 'settings.propose_update':
      case 'settings.apply_update':
      case 'maintenance.clear_cache':
      case 'maintenance.cleanup_research_cache':
      case 'maintenance.cleanup_context_snapshots':
      case 'maintenance.diagnostics.prepare':
        throw new AgentToolPolicyError(
          'AGENT_TOOL_UNAUTHORIZED',
          `Tool ${operation} must use the Worker confirmation workflow.`,
        );
    }
  }

  private reviewSummary(form: import('@ai-video/contracts').MediaReviewSummary) {
    // Provider sees only bounded metadata; UI model catalog and tokens stay local.
    return {
      id: form.id,
      key: form.draft.key,
      label: form.draft.label,
      kind: form.draft.kind,
      status: form.status,
      rowVersion: form.rowVersion,
      jobId: form.jobId,
      blockers: form.blockers,
      shotId: form.draft.shotId,
      sceneId: form.draft.sceneId,
      sourceDocumentId: form.draft.sourceDocumentId,
      inputReferences: form.draft.inputReferences,
    };
  }

  private routeConversationTask(
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    rejectUnknown(args, ['decision', 'targetGenerationId', 'content', 'rationale']);
    const decision = requiredString(args.decision, 'decision', 32) as
      'independent' | 'follow_up' | 'supplement' | 'inspect';
    if (!new Set(['independent', 'follow_up', 'supplement', 'inspect']).has(decision))
      throw new Error('Invalid task route decision.');
    const targetGenerationId =
      args.targetGenerationId === undefined
        ? undefined
        : requiredString(args.targetGenerationId, 'targetGenerationId', 128);
    const rationale = requiredString(args.rationale, 'rationale', 1000);
    const content =
      args.content === undefined ? undefined : requiredString(args.content, 'content', 10000);
    if (decision !== 'independent' && !targetGenerationId)
      throw new Error('A follow-up or supplement decision requires targetGenerationId.');
    if (decision === 'supplement' && !content)
      throw new Error('A supplement decision requires content.');
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        if (!identity.taskId) throw new Error('Task routing requires an active Agent task.');
        const current = database
          .prepare(
            `SELECT generations.id,generations.status,generations.conversation_id,
                branches.execution,branches.dependency_generation_id
           FROM agent_task_generations links
           JOIN llm_generations generations ON generations.id=links.generation_id
           JOIN generation_branches branches ON branches.generation_id=generations.id
          WHERE links.task_id=? AND generations.project_id=? LIMIT 1`,
          )
          .get(identity.taskId, project.id) as
          | {
              id: string;
              status: string;
              conversation_id: string;
              execution: string;
              dependency_generation_id: string | null;
            }
          | undefined;
        if (!current || current.conversation_id !== identity.conversationId)
          throw new Error('当前任务没有可路由的生成运行。');
        if (decision === 'independent') {
          database
            .prepare(
              `UPDATE generation_branches SET execution='parallel',dependency_generation_id=NULL,dependency_snapshot_json=NULL WHERE generation_id=?`,
            )
            .run(current.id);
          this.appendRoutingEvent(database, project.id, identity.taskId, '独立执行', rationale);
          return { status: 'routed', decision, generationId: current.id, rationale };
        }
        const target = database
          .prepare(
            `SELECT generations.id,generations.status,generations.conversation_id,
                user_messages.content AS user_content,assistant_messages.content AS assistant_content
           FROM llm_generations generations
           JOIN chat_messages user_messages ON user_messages.id=generations.user_message_id
           JOIN chat_messages assistant_messages ON assistant_messages.id=generations.assistant_message_id
          WHERE generations.id=? AND generations.project_id=?`,
          )
          .get(targetGenerationId, project.id) as
          | {
              id: string;
              status: string;
              conversation_id: string;
              user_content: string;
              assistant_content: string;
            }
          | undefined;
        if (
          !target ||
          target.conversation_id !== identity.conversationId ||
          target.id === current.id
        )
          throw new Error('目标任务不存在、属于其他会话，或不能指向当前任务。');
        if (decision === 'follow_up') {
          if (target.status !== 'complete')
            throw new Error('目标任务尚未完成，暂时不能建立有序跟进；请独立执行或补充该任务。');
          const snapshot = JSON.stringify({
            generationId: target.id,
            userMessage: { content: splitConversationRequest(target.user_content).request },
            assistantMessage: { content: target.assistant_content },
          });
          database
            .prepare(
              `UPDATE generation_branches SET execution='ordered',dependency_generation_id=?,dependency_snapshot_json=? WHERE generation_id=?`,
            )
            .run(target.id, snapshot, current.id);
          this.appendRoutingEvent(database, project.id, identity.taskId, '有序跟进', rationale);
          return {
            status: 'routed',
            decision,
            generationId: current.id,
            targetGenerationId: target.id,
            targetStatus: target.status,
            targetRequest: splitConversationRequest(target.user_content).request.slice(0, 800),
            targetSummary: target.assistant_content.slice(0, 1600),
            summaryIsAssistantClaim: true,
            rationale,
          };
        }
        if (decision === 'inspect') {
          const artifacts = database
            .prepare(
              `SELECT sets.id,sets.title,sets.status FROM agent_change_sets sets
            JOIN agent_task_generations links ON links.task_id=sets.task_id WHERE links.generation_id=? LIMIT 20`,
            )
            .all(target.id);
          const outputs = database
            .prepare(
              `SELECT calls.tool_name,calls.status,calls.result_document_id,calls.result_document_version_id
            FROM agent_tool_calls calls WHERE calls.generation_id=? AND calls.result_document_id IS NOT NULL ORDER BY calls.created_at DESC LIMIT 20`,
            )
            .all(target.id);
          this.appendRoutingEvent(database, project.id, identity.taskId, '查询任务结果', rationale);
          return {
            status: 'inspected',
            decision,
            targetGenerationId: target.id,
            targetStatus: target.status,
            targetRequest: splitConversationRequest(target.user_content).request.slice(0, 800),
            artifacts,
            outputs,
            dependencyEstablished: false,
            rationale,
          };
        }
        if (!['prepared', 'streaming'].includes(target.status))
          throw new Error('只能向仍在运行的任务补充指令；失败或取消任务请使用 inspect。');
        const messageId = randomUUID();
        const now = new Date().toISOString();
        database
          .prepare(
            `INSERT INTO chat_messages(id,conversation_id,role,content,status,created_at) VALUES(?,?,?,?,?,?)`,
          )
          .run(messageId, target.conversation_id, 'user', content, 'complete', now);
        database
          .prepare(
            `INSERT INTO generation_supplements(id,generation_id,message_id,content,created_at) VALUES(?,?,?,?,?)`,
          )
          .run(randomUUID(), target.id, messageId, content, now);
        this.appendRoutingEvent(database, project.id, identity.taskId, '补充指定任务', rationale);
        return {
          status: 'routed',
          decision,
          generationId: current.id,
          targetGenerationId: target.id,
          rationale,
          instruction: '补充已排入目标任务；当前轮停止继续执行工具。',
        };
      })(),
    );
  }

  private appendRoutingEvent(
    database: Database.Database,
    projectId: string,
    taskId: string,
    label: string,
    rationale: string,
  ): void {
    const row = database
      .prepare(
        'SELECT COALESCE(MAX(sequence),-1)+1 AS sequence FROM agent_task_events WHERE task_id=?',
      )
      .get(taskId) as { sequence: number };
    database
      .prepare(
        `INSERT INTO agent_task_events(id,task_id,project_id,sequence,event_type,level,actor_type,summary,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        randomUUID(),
        taskId,
        projectId,
        row.sequence,
        'agent.task.routed',
        'info',
        'agent',
        `LLM选择${label}`,
        JSON.stringify({ label, rationale }),
        new Date().toISOString(),
      );
  }

  prepareConfirmation(
    operation: SystemAgentToolOperation,
    rawArguments: unknown,
    identity: AgentSystemToolIdentity,
  ): AgentSystemToolConfirmationPreview {
    this.assertIdentity(identity);
    const policy = unifiedAgentToolRegistry.require(operation);
    if (policy.confirmationPolicy !== 'always' && policy.confirmationPolicy !== 'protected-ui') {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_UNAUTHORIZED',
        `Tool ${operation} does not use an explicit confirmation workflow.`,
      );
    }
    const args = requireArguments(rawArguments);
    switch (operation) {
      case 'project.backup.prepare':
        return this.protectedProjectHandoff(args, '创建项目备份', 'backup');
      case 'project.export.prepare':
        return this.protectedProjectHandoff(args, '导出项目副本', 'export');
      case 'project.restore.prepare':
        return this.protectedProjectHandoff(args, '从备份恢复项目', 'restore');
      case 'conversation.archive':
      case 'conversation.restore':
        return this.previewConversationLifecycle(operation, args);
      case 'novel.chapter.archive':
      case 'novel.chapter.restore':
        return this.previewNovelChapterLifecycle(operation, args);
      case 'document.publish':
        return this.previewDocumentPublication(args);
      case 'asset.move_to_trash':
      case 'asset.restore':
      case 'asset.purge':
        return this.previewAssetLifecycle(operation, args);
      case 'tag.delete':
        return this.previewTagDelete(args);
      case 'assetGroup.delete':
        return this.previewGroupDelete(args);
      case 'settings.propose_update':
      case 'settings.apply_update':
        return this.previewSettingsHandoff(operation, args);
      case 'maintenance.clear_cache':
      case 'maintenance.cleanup_research_cache':
      case 'maintenance.cleanup_context_snapshots':
      case 'maintenance.diagnostics.prepare':
        return this.previewMaintenance(operation, args);
      default:
        throw new AgentToolPolicyError(
          'AGENT_TOOL_UNAUTHORIZED',
          `Tool ${operation} has no confirmation preview.`,
        );
    }
  }

  executeConfirmed(
    operation: SystemAgentToolOperation,
    rawArguments: unknown,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    this.assertIdentity(identity);
    const args = requireArguments(rawArguments);
    switch (operation) {
      case 'conversation.archive':
      case 'conversation.restore': {
        rejectUnknown(args, ['conversationId']);
        const conversationId = requiredString(args.conversationId, 'conversationId', 200);
        const conversation =
          operation === 'conversation.archive'
            ? this.content.archiveConversation({ conversationId })
            : this.content.restoreConversation({ conversationId });
        return {
          version: 1,
          status: operation === 'conversation.archive' ? 'archived' : 'restored',
          conversation: toConversationSummary(conversation),
        };
      }
      case 'novel.chapter.archive':
      case 'novel.chapter.restore': {
        const preview = this.previewNovelChapterLifecycle(operation, args);
        if (!this.novels) throw unavailable('Novel chapter lifecycle');
        const chapterId = requiredString(args.chapterId, 'chapterId', 200);
        const expectedRowVersion = requiredInteger(
          args.expectedRowVersion,
          'expectedRowVersion',
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const chapter =
          operation === 'novel.chapter.archive'
            ? this.novels.archiveChapter({
                chapterId,
                expectedRowVersion,
                reason: 'user_archive',
              })
            : this.novels.restoreChapter({ chapterId, expectedRowVersion });
        return {
          version: 1,
          status: operation === 'novel.chapter.archive' ? 'archived' : 'restored',
          chapter: toNovelChapterSummary(chapter),
          summary: preview.summary,
        };
      }
      case 'document.publish': {
        rejectUnknown(args, [
          'documentId',
          'documentVersionId',
          'expectedDocumentRowVersion',
          'expectedPublishedVersionId',
        ]);
        if (!this.documents) throw unavailable('Document publication');
        const documentId = requiredString(args.documentId, 'documentId', 200);
        const documentVersionId = requiredString(args.documentVersionId, 'documentVersionId', 200);
        const expectedDocumentRowVersion = requiredInteger(
          args.expectedDocumentRowVersion,
          'expectedDocumentRowVersion',
          0,
          Number.MAX_SAFE_INTEGER,
        );
        const expectedPublishedVersionId = optionalString(
          args.expectedPublishedVersionId,
          'expectedPublishedVersionId',
          200,
        );
        const published = this.documents.selfPublish({
          documentId,
          documentVersionId,
          expectedDocumentRowVersion,
          ...(expectedPublishedVersionId ? { expectedPublishedVersionId } : {}),
        });
        return {
          version: 1,
          status: 'published',
          documentId,
          documentVersionId: published.publication.documentVersionId,
          publicationId: published.publication.id,
        };
      }
      case 'asset.move_to_trash': {
        rejectUnknown(args, ['assetId']);
        const assetId = requiredString(args.assetId, 'assetId', 200);
        const result = this.assets.deleteAsset(assetId, true);
        return { version: 1, status: 'moved_to_trash', assetId, ...result };
      }
      case 'asset.restore': {
        rejectUnknown(args, ['assetId']);
        const asset = this.assets.restoreAsset(requiredString(args.assetId, 'assetId', 200));
        return { version: 1, status: 'restored', asset: toAssetSummary(asset) };
      }
      case 'tag.delete': {
        rejectUnknown(args, ['tagId']);
        const tagId = requiredString(args.tagId, 'tagId', 200);
        return { version: 1, status: 'deleted', tagId, ...this.assets.deleteTag(tagId) };
      }
      case 'assetGroup.delete': {
        rejectUnknown(args, ['groupId']);
        const groupId = requiredString(args.groupId, 'groupId', 200);
        return { version: 1, status: 'deleted', groupId, ...this.assets.deleteGroup(groupId) };
      }
      case 'maintenance.clear_cache':
        rejectUnknown(args, []);
        return { version: 1, status: 'cleared', ...this.requireMaintenance().clearCache() };
      case 'maintenance.cleanup_research_cache': {
        rejectUnknown(args, ['maxBytes']);
        const maxBytes = optionalInteger(args.maxBytes, 'maxBytes', 0, 10_737_418_240);
        return {
          version: 1,
          status: 'cleaned',
          ...this.requireMaintenance().cleanupResearchCache(maxBytes),
        };
      }
      case 'maintenance.cleanup_context_snapshots': {
        rejectUnknown(args, ['olderThanDays']);
        const olderThanDays = optionalInteger(args.olderThanDays, 'olderThanDays', 1, 3650);
        return {
          version: 1,
          status: 'cleaned',
          ...this.requireMaintenance().cleanupContextSnapshots(
            olderThanDays === undefined ? {} : { olderThanDays },
          ),
        };
      }
      case 'project.backup.prepare':
      case 'project.export.prepare':
      case 'project.restore.prepare':
      case 'asset.purge':
      case 'settings.propose_update':
      case 'settings.apply_update':
      case 'maintenance.diagnostics.prepare': {
        const preview = this.prepareConfirmation(operation, args, identity);
        return {
          version: 1,
          status: 'protected_ui_required',
          summary: preview.summary,
          protectedUi: preview.protectedUi,
        };
      }
      default:
        throw new AgentToolPolicyError(
          'AGENT_TOOL_UNAUTHORIZED',
          `Tool ${operation} is not executable through confirmation.`,
        );
    }
  }

  private assertIdentity(identity: AgentSystemToolIdentity): void {
    const project = this.projects.current();
    if (
      !project ||
      project.id !== identity.projectId ||
      this.projects.currentSessionId() !== identity.projectSessionId
    ) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_PROJECT_SCOPE',
        'The tool call does not belong to the current project session.',
      );
    }
    const conversationExists = this.projects.access(false, (database) =>
      database
        .prepare('SELECT 1 FROM conversations WHERE id = ? AND project_id = ?')
        .get(identity.conversationId, project.id),
    );
    if (!conversationExists) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_PROJECT_SCOPE',
        'The tool call does not belong to a current-project conversation.',
      );
    }
  }

  private projectContext(): Record<string, unknown> {
    return this.projects.access(false, (database, project) => {
      const structure = this.structureCompiler?.compileFromDatabase(database, project, {
        includeArchived: false,
      });
      return {
        version: 1,
        status: 'succeeded',
        project: {
          id: project.id,
          name: project.name,
          mode: project.mode,
          schemaVersion: project.schemaVersion,
          updatedAt: project.updatedAt,
        },
        counts: {
          conversations: scalarCount(database, 'conversations', project.id),
          documents: scalarCount(database, 'documents', project.id),
          assets: scalarCount(database, 'assets', project.id),
        },
        ...(structure
          ? {
              ...boundedStructurePreview(structure),
              resourceMap: compileProjectResourceMap(database, project),
            }
          : {}),
      };
    });
  }

  private projectStructure(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['includeArchived', 'detail']);
    const includeArchived = optionalBoolean(args.includeArchived, 'includeArchived') ?? false;
    if (!this.structureCompiler) throw unavailable('Project structure');
    return this.projects.access(false, (database, project) => ({
      version: 1,
      status: 'succeeded',
      resourceMap: compileProjectResourceMap(database, project, includeArchived),
      ...(args.detail === 'full'
        ? boundedStructurePreview(
            this.structureCompiler!.compileFromDatabase(database, project, {
              includeArchived,
            }),
          )
        : { detail: 'compact', expandWith: 'project.structure.get detail=full' }),
    }));
  }

  private novelStructure(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['novelId', 'includeArchived']);
    const novelId = optionalString(args.novelId, 'novelId', 200);
    const includeArchived = optionalBoolean(args.includeArchived, 'includeArchived') ?? false;
    if (!this.structureCompiler) throw unavailable('Novel structure');
    return this.projects.access(false, (database, project) => ({
      version: 1,
      status: 'succeeded',
      structure: this.structureCompiler!.compileNovel(database, project, {
        ...(novelId ? { novelId } : {}),
        includeArchived,
      }),
    }));
  }

  private listNovelChapters(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['volumeId', 'includeArchived']);
    if (!this.novels) throw unavailable('Novel chapter listing');
    const volumeId = optionalString(args.volumeId, 'volumeId', 200);
    const includeArchived = optionalBoolean(args.includeArchived, 'includeArchived') ?? false;
    const chapters = this.novels.listChapters({
      ...(volumeId ? { volumeId } : {}),
      includeArchived,
    });
    const bounded = this.projects.access(false, (database) =>
      chapters.slice(0, 200).map((chapter) => ({
        ...toNovelChapterSummary(chapter),
        baseVersionId: (
          database
            .prepare('SELECT current_version_id FROM documents WHERE id = ?')
            .get(chapter.documentId) as { current_version_id: string | null }
        ).current_version_id,
      })),
    );
    return {
      version: 1,
      status: 'succeeded',
      chapters: bounded,
      truncated: chapters.length > bounded.length,
    };
  }

  private projectIntegrity(): Record<string, unknown> {
    const report = this.projects.integrity();
    return {
      version: 1,
      status: 'succeeded',
      ok: report.ok,
      schemaVersion: report.schemaVersion,
      messages: report.messages.slice(0, 50),
      truncated: report.messages.length > 50,
    };
  }

  private searchConversations(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['query', 'includeArchived', 'limit']);
    const limit = optionalInteger(args.limit, 'limit', 1, 100) ?? 50;
    const page = this.content.listConversations({
      query: optionalString(args.query, 'query', 200),
      includeArchived: optionalBoolean(args.includeArchived, 'includeArchived') ?? false,
      limit,
    });
    return {
      version: 1,
      status: 'succeeded',
      conversations: page.items.map(toConversationSummary),
      truncated: page.nextCursor !== undefined,
    };
  }

  private createConversation(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['title']);
    const title = optionalString(args.title, 'title', 200);
    const conversation = this.content.createConversation({
      scopeType: 'project',
      ...(title ? { title } : {}),
    });
    return {
      version: 1,
      status: 'succeeded',
      summary: 'Project conversation created.',
      conversation: toConversationSummary(conversation),
    };
  }

  private renameConversation(
    args: Record<string, unknown>,
    conversationId: string,
  ): Record<string, unknown> {
    rejectUnknown(args, ['title']);
    const title = requiredString(args.title, 'title', 200);
    const conversation = this.content.updateConversation({ conversationId, title });
    return {
      version: 1,
      status: 'succeeded',
      summary: 'Current conversation renamed.',
      conversation: toConversationSummary(conversation),
    };
  }

  private searchAssets(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['keyword', 'kind', 'deleted', 'limit']);
    const deleted = args.deleted;
    if (deleted !== undefined && deleted !== 'active' && deleted !== 'trash') {
      throw new Error('deleted must be active or trash.');
    }
    const limit = optionalInteger(args.limit, 'limit', 1, 100) ?? 50;
    const assets = this.assets.listAssets({
      keyword: optionalString(args.keyword, 'keyword', 200),
      kind: optionalString(args.kind, 'kind', 100),
      deleted,
      limit: limit + 1,
    });
    return {
      version: 1,
      status: 'succeeded',
      assets: assets.slice(0, limit).map(toAssetSummary),
      truncated: assets.length > limit,
    };
  }

  private getAsset(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['assetId']);
    const asset = this.requireAsset(requiredString(args.assetId, 'assetId', 200));
    return this.projects.access(false, (db, project) => ({
      version: 1,
      status: 'succeeded',
      asset: {
        ...toAssetSummary(asset),
        availability: describeProductionAsset(db, project.id, project.rootPath, asset.id)
          .availability,
        provenance: readAssetProvenance(db, project.id, asset.id),
      },
    }));
  }

  private updateAssetAlias(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['assetId', 'alias']);
    const assetId = requiredString(args.assetId, 'assetId', 200);
    const alias = requiredString(args.alias, 'alias', 120, true);
    let asset: AssetInfo;
    try {
      asset = this.assets.updateAssetAlias({ assetId, alias });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw new AgentToolPolicyError(
          'AGENT_TOOL_PROJECT_SCOPE',
          'The requested asset is not available in the current project.',
        );
      }
      throw error;
    }
    return {
      version: 1,
      status: 'succeeded',
      summary: 'Asset alias updated.',
      asset: toAssetSummary(asset),
    };
  }

  private updateAssetTags(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['assetIds', 'tagIds', 'operation']);
    const assetIds = requiredStringArray(args.assetIds, 'assetIds', 100);
    const tagIds = requiredStringArray(args.tagIds, 'tagIds', 100);
    if (args.operation !== 'add' && args.operation !== 'remove') {
      throw new Error('operation must be add or remove.');
    }
    const assets = this.assets.changeAssetTags(assetIds, tagIds, args.operation);
    return {
      version: 1,
      status: 'succeeded',
      operation: args.operation,
      assets: assets.slice(0, 100).map(toAssetSummary),
    };
  }

  private listTags(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['keyword']);
    const tags = this.assets.listTags(optionalString(args.keyword, 'keyword', 200));
    return {
      version: 1,
      status: 'succeeded',
      tags: tags.slice(0, 100).map(toTagSummary),
      truncated: tags.length > 100,
    };
  }

  private createTag(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['name']);
    return {
      version: 1,
      status: 'succeeded',
      tag: toTagSummary(this.assets.createTag(requiredString(args.name, 'name', 120))),
    };
  }

  private updateTag(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['tagId', 'name']);
    return {
      version: 1,
      status: 'succeeded',
      tag: toTagSummary(
        this.assets.updateTag(
          requiredString(args.tagId, 'tagId', 200),
          requiredString(args.name, 'name', 120),
        ),
      ),
    };
  }

  private listGroups(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['keyword']);
    const groups = this.assets.listGroups(optionalString(args.keyword, 'keyword', 200));
    return {
      version: 1,
      status: 'succeeded',
      groups: groups.slice(0, 100).map(toGroupSummary),
      truncated: groups.length > 100,
    };
  }

  private createGroup(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['name', 'assetIds']);
    return {
      version: 1,
      status: 'succeeded',
      group: toGroupSummary(
        this.assets.createGroup(
          requiredString(args.name, 'name', 120),
          [],
          requiredStringArray(args.assetIds, 'assetIds', 200),
        ),
      ),
    };
  }

  private updateGroup(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['groupId', 'name', 'assetIds']);
    return {
      version: 1,
      status: 'succeeded',
      group: toGroupSummary(
        this.assets.updateGroup(
          requiredString(args.groupId, 'groupId', 200),
          requiredString(args.name, 'name', 120),
          [],
          requiredStringArray(args.assetIds, 'assetIds', 200),
        ),
      ),
    };
  }

  private resolveGroup(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['groupId']);
    const groupId = requiredString(args.groupId, 'groupId', 200);
    const assets = this.assets.resolveGroup(groupId);
    return {
      version: 1,
      status: 'succeeded',
      groupId,
      assets: assets.slice(0, 100).map(toAssetSummary),
      truncated: assets.length > 100,
    };
  }

  private settingsSummary(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['capability']);
    const capability = args.capability;
    if (
      capability !== undefined &&
      capability !== 'text' &&
      capability !== 'image' &&
      capability !== 'video'
    ) {
      throw new Error('capability must be text, image, or video.');
    }
    const profiles = this.settings.listProfiles(false).slice(0, 100);
    const matchingModels = profiles
      .flatMap((profile) =>
        this.settings.listModels(profile.id).map((model) => ({ profile, model })),
      )
      .filter(({ model }) => !capability || modelSupports(model, capability));
    const models = matchingModels.slice(0, 100);
    return {
      version: 1,
      status: 'succeeded',
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        category: profile.category,
        providerType: profile.providerType,
        enabled: profile.enabled,
        connectionStatus: profile.connectionStatus,
        lastCheckedAt: profile.lastCheckedAt,
      })),
      models: models.map(({ profile, model }) => ({
        id: model.id,
        providerProfileId: profile.id,
        name: model.displayName,
        source: model.source,
        enabled: model.enabled,
        unavailable: model.unavailableAt !== undefined,
        capabilities: {
          text: model.capabilities.text,
          streaming: model.capabilities.streaming,
          tools: model.capabilities.tools,
          imageGeneration: model.capabilities.imageGeneration,
          videoGeneration: model.capabilities.videoGeneration,
        },
      })),
      truncated: matchingModels.length > models.length,
    };
  }

  private maintenanceStatus(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, []);
    const maintenance = this.requireMaintenance();
    const metrics = maintenance.getMetrics();
    return {
      version: 1,
      status: 'succeeded',
      cache: maintenance.inspectCache(),
      requests: metrics.totals,
      generations: metrics.generationTotals,
      queueWait: metrics.queueWaitTotals,
      operations: metrics.byOperation.slice(0, 20).map((item) => ({
        operation: item.operation,
        requests: item.requests,
        ok: item.ok,
        errors: item.errors,
        maxDurationMs: item.maxDurationMs,
      })),
    };
  }

  private mediaTask(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['taskId']);
    if (!this.mediaTasks) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_UNAUTHORIZED',
        'Media task inspection is not configured for this runtime.',
      );
    }
    return {
      version: 1,
      status: 'succeeded',
      task: this.mediaTasks.getTask(requiredString(args.taskId, 'taskId', 200)),
    };
  }

  private protectedProjectHandoff(
    args: Record<string, unknown>,
    summary: string,
    action: string,
  ): AgentSystemToolConfirmationPreview {
    rejectUnknown(args, []);
    const project = this.projects.current();
    if (!project) throw new Error('No project is open.');
    return {
      summary,
      affectedEntities: [{ type: 'project', id: project.id, label: project.name }],
      executionArguments: {},
      protectedUi: { page: 'maintenance', focusId: action, reason: summary },
    };
  }

  private previewConversationLifecycle(
    operation: 'conversation.archive' | 'conversation.restore',
    args: Record<string, unknown>,
  ): AgentSystemToolConfirmationPreview {
    rejectUnknown(args, ['conversationId']);
    const conversationId = requiredString(args.conversationId, 'conversationId', 200);
    const conversation = this.requireConversation(conversationId);
    if (operation === 'conversation.archive' && conversation.archived) {
      throw new Error('Conversation is already archived.');
    }
    if (operation === 'conversation.restore' && !conversation.archived) {
      throw new Error('Conversation is not archived.');
    }
    return {
      summary: `${operation === 'conversation.archive' ? '归档' : '恢复'}会话“${conversation.title}”`,
      affectedEntities: [{ type: 'conversation', id: conversation.id, label: conversation.title }],
      executionArguments: { conversationId },
    };
  }

  private previewNovelChapterLifecycle(
    operation: 'novel.chapter.archive' | 'novel.chapter.restore',
    args: Record<string, unknown>,
  ): AgentSystemToolConfirmationPreview {
    rejectUnknown(args, ['chapterId', 'expectedRowVersion', 'reason']);
    if (!this.novels) throw unavailable('Novel chapter lifecycle');
    const chapterId = requiredString(args.chapterId, 'chapterId', 200);
    const expectedRowVersion = requiredInteger(
      args.expectedRowVersion,
      'expectedRowVersion',
      0,
      Number.MAX_SAFE_INTEGER,
    );
    if (
      operation === 'novel.chapter.archive' &&
      args.reason !== undefined &&
      args.reason !== 'user_archive'
    ) {
      throw new Error('reason must be user_archive.');
    }
    const chapter = this.novels
      .listChapters({ includeArchived: true })
      .find((candidate) => candidate.id === chapterId);
    if (!chapter) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_PROJECT_SCOPE',
        'The requested novel chapter is not available in the current project.',
      );
    }
    if (chapter.rowVersion !== expectedRowVersion) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_ARGUMENTS_INVALID',
        'The novel chapter changed. Re-read its current rowVersion before retrying.',
        true,
      );
    }
    if (operation === 'novel.chapter.archive' && chapter.lifecycleStatus === 'archived') {
      throw new Error('Novel chapter is already archived.');
    }
    if (operation === 'novel.chapter.restore' && chapter.lifecycleStatus !== 'archived') {
      throw new Error('Novel chapter is not archived.');
    }
    return {
      summary: `${operation === 'novel.chapter.archive' ? '归档' : '恢复'}小说章节“${chapter.displayLabel} ${chapter.title}”`,
      affectedEntities: [{ type: 'novel-chapter', id: chapter.id, label: chapter.title }],
      executionArguments: {
        chapterId: chapter.id,
        expectedRowVersion: chapter.rowVersion,
        ...(operation === 'novel.chapter.archive' ? { reason: 'user_archive' } : {}),
      },
    };
  }

  private previewDocumentPublication(
    args: Record<string, unknown>,
  ): AgentSystemToolConfirmationPreview {
    rejectUnknown(args, ['documentId']);
    if (!this.documents) throw unavailable('Document publication');
    const documentId = requiredString(args.documentId, 'documentId', 200);
    const document = this.documents.getDocument(documentId);
    if (!document.currentVersion) throw new Error('Document has no current version to publish.');
    return {
      summary: `发布文档“${document.title}”的 v${document.currentVersion.version} 版本`,
      affectedEntities: [{ type: 'document', id: document.id, label: document.title }],
      executionArguments: {
        documentId: document.id,
        documentVersionId: document.currentVersion.id,
        expectedDocumentRowVersion: document.rowVersion,
        ...(document.publishedVersionId
          ? { expectedPublishedVersionId: document.publishedVersionId }
          : {}),
      },
    };
  }

  private previewAssetLifecycle(
    operation: 'asset.move_to_trash' | 'asset.restore' | 'asset.purge',
    args: Record<string, unknown>,
  ): AgentSystemToolConfirmationPreview {
    rejectUnknown(args, ['assetId']);
    const assetId = requiredString(args.assetId, 'assetId', 200);
    const asset = this.requireAsset(assetId);
    if (operation === 'asset.move_to_trash' && asset.deletedAt) {
      throw new Error('Asset is already in the recycle bin.');
    }
    if (operation !== 'asset.move_to_trash' && !asset.deletedAt) {
      throw new Error('Only a trashed asset can be restored or permanently deleted.');
    }
    const label = asset.alias || asset.id;
    const verb =
      operation === 'asset.move_to_trash'
        ? '将素材移入回收站'
        : operation === 'asset.restore'
          ? '从回收站恢复素材'
          : '彻底删除素材';
    return {
      summary: `${verb}“${label}”`,
      affectedEntities: [{ type: 'asset', id: asset.id, label }],
      executionArguments: { assetId },
      ...(operation === 'asset.purge'
        ? {
            protectedUi: {
              page: 'asset-library' as const,
              focusId: asset.id,
              reason: '彻底删除不可恢复，必须在素材库的回收站中完成。',
            },
          }
        : {}),
    };
  }

  private previewTagDelete(args: Record<string, unknown>): AgentSystemToolConfirmationPreview {
    rejectUnknown(args, ['tagId']);
    const tagId = requiredString(args.tagId, 'tagId', 200);
    const tag = this.assets.listTags().find((candidate) => candidate.id === tagId);
    if (!tag) throw new Error('Tag was not found.');
    return {
      summary: `删除标签“${tag.name}”${tag.assetCount ? `（关联 ${tag.assetCount} 个素材）` : ''}`,
      affectedEntities: [{ type: 'tag', id: tag.id, label: tag.name }],
      executionArguments: { tagId },
    };
  }

  private previewGroupDelete(args: Record<string, unknown>): AgentSystemToolConfirmationPreview {
    rejectUnknown(args, ['groupId']);
    const groupId = requiredString(args.groupId, 'groupId', 200);
    const group = this.assets.listGroups().find((candidate) => candidate.id === groupId);
    if (!group) throw new Error('Asset group was not found.');
    return {
      summary: `删除素材组“${group.name}”`,
      affectedEntities: [{ type: 'asset-group', id: group.id, label: group.name }],
      executionArguments: { groupId },
    };
  }

  private previewSettingsHandoff(
    operation: 'settings.propose_update' | 'settings.apply_update',
    args: Record<string, unknown>,
  ): AgentSystemToolConfirmationPreview {
    rejectUnknown(args, ['providerProfileId', 'requestedFields', 'reason']);
    const providerProfileId = requiredString(args.providerProfileId, 'providerProfileId', 200);
    const profile = this.settings
      .listProfiles(true)
      .find((candidate) => candidate.id === providerProfileId);
    if (!profile) throw new Error('Provider profile was not found.');
    const requestedFields =
      operation === 'settings.propose_update'
        ? requiredEnumArray(
            args.requestedFields,
            'requestedFields',
            ['name', 'enabled', 'base-url', 'protocol', 'region', 'credentials'] as const,
            6,
          )
        : [];
    optionalString(args.reason, 'reason', 500);
    return {
      summary:
        operation === 'settings.propose_update'
          ? `在受保护设置中修改“${profile.name}”：${requestedFields.join('、')}`
          : `在受保护设置中继续修改“${profile.name}”`,
      affectedEntities: [{ type: 'provider-profile', id: profile.id, label: profile.name }],
      executionArguments: { providerProfileId },
      protectedUi: {
        page: 'providers',
        focusId: profile.id,
        reason: '连接地址、协议、区域和凭据只能在受保护设置界面中查看或修改。',
      },
    };
  }

  private previewMaintenance(
    operation:
      | 'maintenance.clear_cache'
      | 'maintenance.cleanup_research_cache'
      | 'maintenance.cleanup_context_snapshots'
      | 'maintenance.diagnostics.prepare',
    args: Record<string, unknown>,
  ): AgentSystemToolConfirmationPreview {
    const project = this.projects.current();
    if (!project) throw new Error('No project is open.');
    if (operation === 'maintenance.clear_cache') {
      rejectUnknown(args, []);
      const cache = this.requireMaintenance().inspectCache();
      return {
        summary: `清理派生缓存（${cache.fileCount} 个文件，${cache.sizeBytes} 字节）`,
        affectedEntities: [{ type: 'project-cache', id: project.id, label: project.name }],
        executionArguments: {},
      };
    }
    if (operation === 'maintenance.cleanup_research_cache') {
      rejectUnknown(args, ['maxBytes']);
      const maxBytes = optionalInteger(args.maxBytes, 'maxBytes', 0, 10_737_418_240);
      return {
        summary: `清理研究缓存${maxBytes === undefined ? '' : `并限制为 ${maxBytes} 字节`}`,
        affectedEntities: [{ type: 'research-cache', id: project.id, label: project.name }],
        executionArguments: maxBytes === undefined ? {} : { maxBytes },
      };
    }
    if (operation === 'maintenance.cleanup_context_snapshots') {
      rejectUnknown(args, ['olderThanDays']);
      const olderThanDays = optionalInteger(args.olderThanDays, 'olderThanDays', 1, 3650) ?? 90;
      return {
        summary: `清理 ${olderThanDays} 天前且未被引用的上下文快照`,
        affectedEntities: [{ type: 'context-snapshots', id: project.id, label: project.name }],
        executionArguments: { olderThanDays },
      };
    }
    rejectUnknown(args, []);
    return {
      summary: '导出脱敏诊断包',
      affectedEntities: [{ type: 'project', id: project.id, label: project.name }],
      executionArguments: {},
      protectedUi: {
        page: 'maintenance',
        focusId: 'diagnostics',
        reason: '诊断包目标位置必须由用户在项目维护界面中选择。',
      },
    };
  }

  private requireConversation(conversationId: string): {
    id: string;
    title: string;
    archived: boolean;
  } {
    return this.projects.access(false, (database, project) => {
      const row = database
        .prepare('SELECT id, title, archived_at FROM conversations WHERE id = ? AND project_id = ?')
        .get(conversationId, project.id) as
        { id: string; title: string; archived_at: string | null } | undefined;
      if (!row) throw projectScopeError('conversation');
      return { id: row.id, title: row.title, archived: row.archived_at !== null };
    });
  }

  private requireAsset(assetId: string): AssetInfo {
    try {
      return this.assets.getAssetInfo(assetId);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw projectScopeError('asset');
      }
      throw error;
    }
  }

  private requireMaintenance(): AgentMaintenanceToolService {
    if (!this.maintenance) throw unavailable('Maintenance');
    return this.maintenance;
  }
}

function boundedStructurePreview(snapshot: ProjectStructureSnapshot): {
  structure: ProjectStructureSnapshot;
  truncated: boolean;
} {
  const structure = structuredClone(snapshot);
  let truncated = false;
  while (Buffer.byteLength(JSON.stringify(structure), 'utf8') > 24_000) {
    truncated = true;
    if (structure.sources.length) structure.sources.pop();
    else if (structure.novel?.references.length) structure.novel.references.pop();
    else if (structure.novel?.unassignedChapters.length) structure.novel.unassignedChapters.pop();
    else if (structure.novel?.volumes.length) {
      const volume = structure.novel.volumes.at(-1)!;
      if (volume.chapters.length) volume.chapters.pop();
      else structure.novel.volumes.pop();
    } else break;
  }
  return { structure, truncated };
}

function scalarCount(
  database: import('better-sqlite3').Database,
  table: 'conversations' | 'documents' | 'assets',
  projectId: string,
): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`)
    .get(projectId) as { count: number };
  return row.count;
}

function toConversationSummary(conversation: ConversationInfo): Record<string, unknown> {
  return {
    id: conversation.id,
    title: conversation.title,
    scopeType: conversation.scopeType,
    scopeId: conversation.scopeId,
    archived: conversation.archivedAt !== undefined,
    updatedAt: conversation.updatedAt,
  };
}

function toAssetSummary(asset: AssetInfo): Record<string, unknown> {
  return {
    id: asset.id,
    kind: asset.kind,
    alias: asset.alias,
    sizeBytes: asset.sizeBytes,
    deleted: asset.deletedAt !== undefined,
    tags: (asset.tags ?? []).slice(0, 100).map((tag) => ({ id: tag.id, name: tag.name })),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function toNovelChapterSummary(chapter: NovelChapterInfo): Record<string, unknown> {
  return {
    id: chapter.id,
    volumeId: chapter.volumeId,
    documentId: chapter.documentId,
    title: chapter.title,
    displayLabel: chapter.displayLabel,
    position: chapter.position,
    lifecycleStatus: chapter.lifecycleStatus,
    archiveReason: chapter.archiveReason,
    rowVersion: chapter.rowVersion,
    documentRowVersion: chapter.documentRowVersion,
    ragChunkCount: chapter.ragChunkCount,
    ragIndexedAt: chapter.ragIndexedAt,
    createdAt: chapter.createdAt,
    updatedAt: chapter.updatedAt,
  };
}

function toTagSummary(tag: AssetTagInfo): Record<string, unknown> {
  return {
    id: tag.id,
    name: tag.name,
    assetCount: tag.assetCount ?? 0,
    createdAt: tag.createdAt,
    updatedAt: tag.updatedAt,
  };
}

function toGroupSummary(group: AssetGroupInfo): Record<string, unknown> {
  return {
    id: group.id,
    name: group.name,
    assetIds: group.assetIds.slice(0, 200),
    assetCount: group.assetCount ?? 0,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
  };
}

function modelSupports(model: ProviderModelInfo, capability: 'text' | 'image' | 'video'): boolean {
  return capability === 'text'
    ? model.capabilities.text
    : capability === 'image'
      ? model.capabilities.imageGeneration
      : model.capabilities.videoGeneration;
}

function requireArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Tool arguments contain unsupported field ${unknown}.`);
}

function requiredString(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const normalized = value.normalize('NFC').trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximum) {
    throw new Error(`${name} is outside its allowed length.`);
  }
  return normalized;
}

function optionalString(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, maximum, true);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function requiredInteger(value: unknown, name: string, minimum: number, maximum: number): number {
  const result = optionalInteger(value, name, minimum, maximum);
  if (result === undefined) throw new Error(`${name} is required.`);
  return result;
}

function requiredStringArray(value: unknown, name: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maximum) {
    throw new Error(`${name} must contain between 1 and ${maximum} items.`);
  }
  const normalized = value.map((item, index) => requiredString(item, `${name}[${index}]`, 200));
  if (new Set(normalized).size !== normalized.length) throw new Error(`${name} must be unique.`);
  return normalized;
}

function requiredEnumArray<const T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
  maximum: number,
): T[] {
  const normalized = requiredStringArray(value, name, maximum);
  if (normalized.some((item) => !allowed.includes(item as T))) {
    throw new Error(`${name} contains an unsupported value.`);
  }
  return normalized as T[];
}

function projectScopeError(kind: string): AgentToolPolicyError {
  return new AgentToolPolicyError(
    'AGENT_TOOL_PROJECT_SCOPE',
    `The requested ${kind} is not available in the current project.`,
  );
}

function unavailable(capability: string): AgentToolPolicyError {
  return new AgentToolPolicyError(
    'AGENT_TOOL_UNAUTHORIZED',
    `${capability} is not configured for this runtime.`,
  );
}
