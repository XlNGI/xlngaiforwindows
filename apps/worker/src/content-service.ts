import { randomUUID } from 'node:crypto';
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
  SceneInfo,
  SceneSaveParams,
  ShotInfo,
  ShotSaveParams,
  ShotStoryboardSaveParams,
} from '@ai-video/contracts';
import type {
  ConversationModelPreferenceRecord,
  ConversationRecord,
  LlmGenerationAttemptRecord,
} from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';

const documentKinds = new Set<DocumentKind>([
  'outline',
  'plan',
  'character',
  'scene',
  'storyboard',
  'note',
]);
const scopeTypes = new Set<ConversationScopeType>(['project', 'scene', 'shot']);

function required(value: string, name: string): string {
  const result = value.trim();
  if (!result) throw new Error(`${name} is required.`);
  return result;
}

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

  listScenes(): SceneInfo[] {
    return this.projects.access(false, (database, project) =>
      createRepositories(database).scenes.listByProject(project.id),
    );
  }

  saveScene(params: SceneSaveParams): SceneInfo {
    const title = required(params.title, 'Scene title');
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const existing = params.sceneId ? repositories.scenes.get(params.sceneId) : undefined;
      if (params.sceneId && (!existing || existing.projectId !== project.id)) {
        throw new Error('Scene was not found.');
      }
      if (existing && params.expectedRowVersion !== existing.rowVersion) {
        throw new Error('SCENE_ROW_VERSION_CONFLICT');
      }
      const now = new Date().toISOString();
      const record: SceneInfo = {
        id: existing?.id ?? randomUUID(),
        projectId: project.id,
        title,
        position:
          existing?.position ??
          (repositories.scenes.listByProject(project.id).at(-1)?.position ?? -1) + 1,
        rowVersion: existing?.rowVersion ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      repositories.scenes.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return repositories.scenes.get(record.id)!;
    });
  }

  listShots(sceneId: string): ShotInfo[] {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const scene = repositories.scenes.get(sceneId);
      if (!scene || scene.projectId !== project.id) throw new Error('Scene was not found.');
      return repositories.shots.listByScene(sceneId);
    });
  }

  saveShot(params: ShotSaveParams): ShotInfo {
    const title = required(params.title, 'Shot title');
    const prompt = params.prompt === undefined ? undefined : params.prompt.trim();
    if (prompt !== undefined && prompt.length > 2000) {
      throw new Error('Shot prompt must be at most 2000 characters.');
    }
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const scene = repositories.scenes.get(params.sceneId);
      if (!scene || scene.projectId !== project.id) throw new Error('Scene was not found.');
      const existing = params.shotId ? repositories.shots.get(params.shotId) : undefined;
      if (params.shotId && (!existing || existing.sceneId !== scene.id)) {
        throw new Error('Shot was not found.');
      }
      if (existing && params.expectedRowVersion !== existing.rowVersion) {
        throw new Error('SHOT_ROW_VERSION_CONFLICT');
      }
      if (params.documentId) {
        const document = repositories.documents.get(params.documentId);
        if (!document || document.projectId !== project.id) {
          throw new Error('Shot document was not found.');
        }
        const owner = repositories.shots.findByDocumentId(params.documentId);
        if (owner && owner.id !== (params.shotId ?? existing?.id)) {
          throw new Error('Shot document is already attached to another shot.');
        }
      }
      const now = new Date().toISOString();
      const record: ShotInfo = {
        id: existing?.id ?? randomUUID(),
        sceneId: scene.id,
        title,
        position:
          existing?.position ??
          (repositories.shots.listByScene(scene.id).at(-1)?.position ?? -1) + 1,
        status: params.status ?? existing?.status ?? 'draft',
        documentId: params.documentId ?? existing?.documentId,
        prompt: prompt ?? existing?.prompt,
        rowVersion: existing?.rowVersion ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      repositories.shots.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return repositories.shots.get(record.id)!;
    });
  }

  saveShotStoryboard(params: ShotStoryboardSaveParams): DocumentDetail {
    const title = required(params.title, 'Storyboard title');
    const resolved = this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const shot = repositories.shots.get(params.shotId);
      if (!shot) throw new Error('Shot was not found.');
      const scene = repositories.scenes.get(shot.sceneId);
      if (!scene || scene.projectId !== project.id) throw new Error('Shot was not found.');
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
      const conversations = createRepositories(database)
        .conversations.listByProject(project.id)
        .map(asConversation)
        .filter(
          (conversation) =>
            (!params.scopeType || conversation.scopeType === params.scopeType) &&
            (params.scopeId === undefined || conversation.scopeId === params.scopeId) &&
            (params.includeArchived || !conversation.archivedAt) &&
            (!query || conversation.title.toLocaleLowerCase().includes(query)),
        );
      if (params.cursor !== undefined) {
        const cursorIndex = conversations.findIndex((item) => item.id === params.cursor);
        if (cursorIndex < 0) return { items: [], nextCursor: undefined };
        return sliceConversationPage(conversations, cursorIndex + 1, limit);
      }
      return sliceConversationPage(conversations, 0, limit);
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

  messageToMemory(messageId: string): { id: string } {
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
      repositories.projects.touch(now);
      project.updatedAt = now;
      return { id };
    });
  }

  messageToConstraint(params: MessageConstraintParams): { id: string } {
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
