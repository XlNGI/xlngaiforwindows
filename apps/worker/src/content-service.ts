import { randomUUID } from 'node:crypto';
import type {
  ChatMessageInfo,
  ChatMessageListParams,
  ChatMessagePage,
  ChatMessageSaveParams,
  ConversationCreateParams,
  ConversationInfo,
  ConversationListParams,
  ConversationScopeType,
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
} from '@ai-video/contracts';
import type {
  ConversationRecord,
  DocumentRecord,
  LlmGenerationAttemptRecord,
} from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
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

function asDocumentSummary(record: DocumentRecord): DocumentSummary {
  if (!documentKinds.has(record.kind as DocumentKind)) {
    throw new Error(`Unsupported document kind: ${record.kind}`);
  }
  if (!scopeTypes.has(record.scopeType as ConversationScopeType)) {
    throw new Error(`Unsupported document scope: ${record.scopeType}`);
  }
  return record as DocumentSummary;
}

function asConversation(record: ConversationRecord): ConversationInfo {
  if (!scopeTypes.has(record.scopeType as ConversationScopeType)) {
    throw new Error(`Unsupported conversation scope: ${record.scopeType}`);
  }
  return record as ConversationInfo;
}

export class ContentService {
  constructor(private readonly projects: ProjectService) {}

  listDocuments(): DocumentSummary[] {
    return this.projects.access(false, (database, project) =>
      createRepositories(database).documents.listByProject(project.id).map(asDocumentSummary),
    );
  }

  getDocument(documentId: string): DocumentDetail {
    return this.projects.access(false, (database, project) => {
      const repository = createRepositories(database).documents;
      const document = repository.get(documentId);
      if (!document || document.projectId !== project.id)
        throw new Error('Document was not found.');
      return {
        ...asDocumentSummary(document),
        currentVersion: document.currentVersionId
          ? repository.getVersion(document.currentVersionId)
          : undefined,
      };
    });
  }

  saveDocument(params: DocumentSaveParams): DocumentDetail {
    if (!documentKinds.has(params.kind)) throw new Error('Document kind is invalid.');
    const title = required(params.title, 'Document title');
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const existing = params.documentId
        ? repositories.documents.get(params.documentId)
        : undefined;
      if (params.documentId && (!existing || existing.projectId !== project.id)) {
        throw new Error('Document was not found.');
      }

      const now = new Date().toISOString();
      const documentId = existing?.id ?? randomUUID();
      const scopeType =
        params.scopeType ?? (existing?.scopeType as ConversationScopeType) ?? 'project';
      const scopeId = scopeType === 'project' ? undefined : (params.scopeId ?? existing?.scopeId);
      this.assertScope(repositories, project.id, scopeType, scopeId);
      const version: DocumentVersionInfo = {
        id: randomUUID(),
        documentId,
        version: (repositories.documents.listVersions(documentId)[0]?.version ?? 0) + 1,
        contentMarkdown: params.contentMarkdown,
        createdAt: now,
      };
      const document: DocumentRecord = {
        id: documentId,
        projectId: project.id,
        kind: params.kind,
        title,
        scopeType,
        scopeId,
        currentVersionId: version.id,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      repositories.documents.saveVersion(document, version);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return { ...asDocumentSummary(document), currentVersion: version };
    });
  }

  listDocumentVersions(documentId: string): DocumentVersionInfo[] {
    return this.projects.access(false, (database, project) => {
      const repository = createRepositories(database).documents;
      const document = repository.get(documentId);
      if (!document || document.projectId !== project.id)
        throw new Error('Document was not found.');
      return repository.listVersions(documentId);
    });
  }

  restoreDocument(params: DocumentRestoreParams): DocumentDetail {
    const source = this.projects.access(false, (database, project) => {
      const repository = createRepositories(database).documents;
      const document = repository.get(params.documentId);
      const version = repository.getVersion(params.versionId);
      if (!document || document.projectId !== project.id || version?.documentId !== document.id) {
        throw new Error('Document version was not found.');
      }
      return { document: asDocumentSummary(document), version };
    });
    return this.saveDocument({
      documentId: source.document.id,
      kind: source.document.kind,
      title: source.document.title,
      contentMarkdown: source.version.contentMarkdown,
    });
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
      const now = new Date().toISOString();
      const record: SceneInfo = {
        id: existing?.id ?? randomUUID(),
        projectId: project.id,
        title,
        position:
          existing?.position ??
          (repositories.scenes.listByProject(project.id).at(-1)?.position ?? -1) + 1,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      repositories.scenes.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return record;
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
    return this.projects.access(true, (database, project) => {
      const repositories = createRepositories(database);
      const scene = repositories.scenes.get(params.sceneId);
      if (!scene || scene.projectId !== project.id) throw new Error('Scene was not found.');
      const existing = params.shotId ? repositories.shots.get(params.shotId) : undefined;
      if (params.shotId && (!existing || existing.sceneId !== scene.id)) {
        throw new Error('Shot was not found.');
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
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      repositories.shots.save(record);
      repositories.projects.touch(now);
      project.updatedAt = now;
      return record;
    });
  }

  listConversations(params: ConversationListParams): ConversationInfo[] {
    return this.projects.access(false, (database, project) =>
      createRepositories(database)
        .conversations.listByProject(project.id)
        .map(asConversation)
        .filter(
          (conversation) =>
            (!params.scopeType || conversation.scopeType === params.scopeType) &&
            (params.scopeId === undefined || conversation.scopeId === params.scopeId),
        ),
    );
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
    const { content, conversation } = this.getMessageContext(params.messageId);
    return this.saveDocument({
      kind: params.kind ?? 'note',
      title: params.title,
      contentMarkdown: content,
      scopeType: conversation.scopeType as ConversationScopeType,
      scopeId: conversation.scopeId,
    });
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
