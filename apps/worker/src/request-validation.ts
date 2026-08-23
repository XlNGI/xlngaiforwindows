import type {
  ChatMessageRole,
  ChatMessageStatus,
  ConversationScopeType,
  NormalizedLlmUsage,
  TaskLogKind,
  WorkerMethod,
} from '@ai-video/contracts';

const MAX_ID_LENGTH = 128;
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 1_000_000;
const MAX_DOCUMENT_LENGTH = 1_000_000;
const MAX_PROMPT_LENGTH = 100_000;
const MAX_ERROR_LENGTH = 500;
const MAX_KIND_LENGTH = 80;
const MAX_PROVIDER_RESPONSE_ID_LENGTH = 256;
const MAX_FINISH_REASON_LENGTH = 80;
const MAX_RAW_USAGE_BYTES = 64 * 1024;

const sessionMethods = new Set<WorkerMethod>([
  'conversation.list',
  'conversation.create',
  'conversation.update',
  'conversation.archive',
  'conversation.restore',
  'chat.message.list',
  'chat.message.save',
  'chat.message.toDocument',
  'chat.message.toMemory',
  'chat.message.toConstraint',
  'document.list',
  'document.get',
  'document.save',
  'document.draft.save',
  'document.versions',
  'document.restore',
  'document.review.submit',
  'document.review.requestChanges',
  'document.review.reject',
  'document.publish',
  'document.selfPublish',
  'novel.profile.get',
  'novel.profile.update',
  'novel.volume.list',
  'novel.volume.save',
  'novel.chapter.list',
  'novel.chapter.save',
  'novel.chapter.archive',
  'novel.chapter.restore',
  'novel.import',
  'novel.binding.list',
  'novel.binding.save',
  'novel.intent.list',
  'novel.intent.cancel',
  'novel.export.prepare',
  'agent.partial.list',
  'agent.partial.recover',
  'agent.partial.discard',
  'agent.task.createDocumentDraft',
  'agent.task.list',
  'agent.task.get',
  'agent.task.events',
  'task.log.list',
  'context.preview',
  'llm.generate',
  'llm.generation.prepare',
  'llm.generation.runtime',
  'llm.generation.observe',
  'llm.generation.complete',
  'llm.generation.fail',
  'llm.generation.get',
  'llm.generation.cancel',
  'llm.generation.retry',
  'llm.generation.retryPrepare',
  'agent.generation.prepare',
  'agent.generation.executeTools',
  'agent.generation.cancel',
  'agent.generation.confirmTool',
  'agent.providerStep.complete',
  'agent.providerStep.start',
  'agent.changeSet.create',
  'agent.changeSet.list',
  'agent.changeSet.apply',
  'agent.changeSet.reject',
  'maintenance.metrics',
  'maintenance.contextSnapshots.cleanup',
  'maintenance.researchCache.cleanup',
]);

const scopes = new Set<ConversationScopeType>(['project', 'scene', 'shot']);
const roles = new Set<ChatMessageRole>(['system', 'user', 'assistant', 'tool']);
const messageStatuses = new Set<ChatMessageStatus>(['streaming', 'complete', 'failed']);
const documentKinds = new Set(['outline', 'plan', 'character', 'scene', 'storyboard', 'note']);
const documentAuthors = new Set(['user', 'import']);
const taskLogKinds = new Set<TaskLogKind>(['agent-document', 'image', 'video']);
const agentDocumentOperations = new Set([
  'document.create_draft',
  'document.list',
  'document.read',
  'document.update_draft',
  'document.archive',
  'document.restore',
  'novel.chapter.submit_draft',
  'novel.reference.submit_draft',
  'novel.adaptation.submit_proposal',
]);
const agentResearchModes = new Set(['auto', 'project_only', 'network_disabled']);

export class RequestValidationError extends Error {}

export function validateSessionRequestParams(
  method: WorkerMethod,
  input: unknown,
): Record<string, unknown> {
  if (!sessionMethods.has(method)) return requireObject(input, 'params');
  const params = requireObject(input, 'params');

  switch (method) {
    case 'document.list':
      rejectUnknown(params, []);
      break;
    case 'novel.profile.get':
      rejectUnknown(params, ['createIfMissing']);
      optionalBoolean(params, 'createIfMissing');
      break;
    case 'novel.profile.update':
      rejectUnknown(params, ['language', 'status', 'expectedRowVersion']);
      optionalString(params, 'language', 35);
      optionalEnum(params, 'status', new Set(['active', 'archived']));
      requireInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'novel.volume.list':
      rejectUnknown(params, ['includeArchived']);
      optionalBoolean(params, 'includeArchived');
      break;
    case 'novel.volume.save':
      rejectUnknown(params, ['volumeId', 'title', 'position', 'status', 'expectedRowVersion']);
      optionalId(params, 'volumeId');
      requireString(params, 'title', MAX_TITLE_LENGTH);
      optionalInteger(params, 'position', 0, Number.MAX_SAFE_INTEGER);
      optionalEnum(params, 'status', new Set(['active', 'archived']));
      optionalInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'novel.chapter.list':
      rejectUnknown(params, ['volumeId', 'includeArchived']);
      optionalId(params, 'volumeId');
      optionalBoolean(params, 'includeArchived');
      break;
    case 'novel.chapter.save':
      rejectUnknown(params, [
        'chapterId',
        'volumeId',
        'title',
        'displayLabel',
        'position',
        'lifecycleStatus',
        'archiveReason',
        'expectedRowVersion',
      ]);
      optionalId(params, 'chapterId');
      optionalId(params, 'volumeId');
      requireString(params, 'title', MAX_TITLE_LENGTH);
      optionalString(params, 'displayLabel', 80);
      optionalInteger(params, 'position', 0, Number.MAX_SAFE_INTEGER);
      optionalEnum(params, 'lifecycleStatus', new Set(['reserved', 'active', 'archived']));
      optionalEnum(params, 'archiveReason', new Set(['user_archive', 'generation_placeholder']));
      optionalInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'novel.chapter.archive':
      rejectUnknown(params, ['chapterId', 'expectedRowVersion', 'reason']);
      requireId(params, 'chapterId');
      requireInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
      optionalEnum(params, 'reason', new Set(['user_archive', 'generation_placeholder']));
      break;
    case 'novel.chapter.restore':
      rejectUnknown(params, ['chapterId', 'expectedRowVersion']);
      requireId(params, 'chapterId');
      requireInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'novel.import':
      rejectUnknown(params, ['volumeTitle', 'chapters']);
      optionalString(params, 'volumeTitle', MAX_TITLE_LENGTH);
      if (
        !Array.isArray(params.chapters) ||
        params.chapters.length < 1 ||
        params.chapters.length > 200
      ) {
        throw new RequestValidationError('chapters must contain between one and 200 items.');
      }
      for (const item of params.chapters) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new RequestValidationError('Each imported chapter must be an object.');
        }
        const chapter = item as Record<string, unknown>;
        rejectUnknown(chapter, ['title', 'displayLabel', 'contentMarkdown']);
        requireString(chapter, 'title', MAX_TITLE_LENGTH);
        optionalString(chapter, 'displayLabel', 80);
        const content = requireString(chapter, 'contentMarkdown', 1_048_576);
        if (!content.trim()) throw new RequestValidationError('Chapter content cannot be empty.');
      }
      break;
    case 'novel.binding.list':
      rejectUnknown(params, ['includeNeedsReview']);
      optionalBoolean(params, 'includeNeedsReview');
      break;
    case 'novel.binding.save':
      rejectUnknown(params, [
        'bindingId',
        'documentId',
        'volumeId',
        'chapterId',
        'sceneId',
        'shotId',
        'role',
        'domainScope',
        'status',
        'expectedRowVersion',
      ]);
      optionalId(params, 'bindingId');
      requireId(params, 'documentId');
      optionalId(params, 'volumeId');
      optionalId(params, 'chapterId');
      optionalId(params, 'sceneId');
      optionalId(params, 'shotId');
      requireEnum(
        params,
        'role',
        new Set([
          'work-outline',
          'volume-outline',
          'character-bible',
          'world-bible',
          'timeline',
          'style-guide',
          'adaptation-proposal',
          'screenplay',
          'scene-outline',
          'shot-plan',
          'research',
          'note',
        ]),
      );
      requireEnum(params, 'domainScope', new Set(['shared', 'novel', 'short-drama']));
      optionalEnum(params, 'status', new Set(['active', 'archived', 'needs_review']));
      optionalInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'novel.intent.list':
      rejectUnknown(params, ['includeResolved']);
      optionalBoolean(params, 'includeResolved');
      break;
    case 'novel.intent.cancel':
      rejectUnknown(params, ['intentId']);
      requireId(params, 'intentId');
      break;
    case 'novel.export.prepare':
      rejectUnknown(params, [
        'exportType',
        'exportFormat',
        'chapterId',
        'chapterIds',
        'volumeId',
        'includeDraft',
      ]);
      requireEnum(params, 'exportType', new Set(['chapter', 'selection', 'volume', 'work']));
      optionalEnum(params, 'exportFormat', new Set(['files', 'merged']));
      optionalId(params, 'chapterId');
      optionalId(params, 'volumeId');
      optionalBoolean(params, 'includeDraft');
      if (params.chapterIds !== undefined) {
        if (
          !Array.isArray(params.chapterIds) ||
          params.chapterIds.length === 0 ||
          params.chapterIds.length > 200
        ) {
          throw new RequestValidationError('chapterIds must contain between one and 200 IDs.');
        }
        for (const chapterId of params.chapterIds) {
          if (typeof chapterId !== 'string' || !chapterId.trim())
            throw new RequestValidationError('chapterIds must contain non-empty IDs.');
        }
      }
      break;
    case 'agent.partial.list':
      rejectUnknown(params, ['includeTerminal']);
      optionalBoolean(params, 'includeTerminal');
      break;
    case 'agent.partial.recover':
      rejectUnknown(params, ['artifactId', 'expectedRowVersion', 'expectedDocumentRowVersion']);
      requireId(params, 'artifactId');
      requireInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
      requireInteger(params, 'expectedDocumentRowVersion', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'agent.partial.discard':
      rejectUnknown(params, ['artifactId', 'expectedRowVersion']);
      requireId(params, 'artifactId');
      requireInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'document.get':
    case 'document.versions':
      rejectUnknown(params, ['documentId']);
      requireId(params, 'documentId');
      break;
    case 'document.restore':
      rejectUnknown(params, ['documentId', 'versionId']);
      requireId(params, 'documentId');
      requireId(params, 'versionId');
      break;
    case 'document.save':
    case 'document.draft.save':
      validateDocumentDraft(params);
      break;
    case 'document.review.submit':
      rejectUnknown(params, ['documentId', 'documentVersionId', 'expectedDocumentRowVersion']);
      requireId(params, 'documentId');
      optionalId(params, 'documentVersionId');
      requireInteger(params, 'expectedDocumentRowVersion', 0, Number.MAX_SAFE_INTEGER);
      break;
    case 'document.review.requestChanges':
    case 'document.review.reject':
      rejectUnknown(params, [
        'documentId',
        'documentVersionId',
        'expectedDocumentRowVersion',
        'comment',
      ]);
      requireId(params, 'documentId');
      optionalId(params, 'documentVersionId');
      requireInteger(params, 'expectedDocumentRowVersion', 0, Number.MAX_SAFE_INTEGER);
      optionalString(params, 'comment', 2_000);
      break;
    case 'document.publish':
    case 'document.selfPublish':
      rejectUnknown(params, [
        'documentId',
        'documentVersionId',
        'expectedDocumentRowVersion',
        'expectedPublishedVersionId',
      ]);
      requireId(params, 'documentId');
      optionalId(params, 'documentVersionId');
      requireInteger(params, 'expectedDocumentRowVersion', 0, Number.MAX_SAFE_INTEGER);
      optionalId(params, 'expectedPublishedVersionId');
      break;
    case 'agent.task.createDocumentDraft':
      rejectUnknown(params, [
        'messageId',
        'title',
        'targetDocumentId',
        'expectedDocumentRowVersion',
        'idempotencyKey',
      ]);
      requireId(params, 'messageId');
      optionalString(params, 'title', MAX_TITLE_LENGTH);
      optionalId(params, 'targetDocumentId');
      optionalInteger(params, 'expectedDocumentRowVersion', 0, Number.MAX_SAFE_INTEGER);
      optionalId(params, 'idempotencyKey');
      break;
    case 'agent.task.list':
      rejectUnknown(params, ['limit', 'conversationId']);
      optionalInteger(params, 'limit', 1, 300);
      optionalId(params, 'conversationId');
      break;
    case 'agent.task.get':
      rejectUnknown(params, ['taskId']);
      requireId(params, 'taskId');
      break;
    case 'agent.task.events':
      rejectUnknown(params, ['taskId', 'afterSequence', 'limit']);
      requireId(params, 'taskId');
      optionalInteger(params, 'afterSequence', 0, Number.MAX_SAFE_INTEGER);
      optionalInteger(params, 'limit', 1, 100);
      break;
    case 'agent.changeSet.create':
      validateAgentChangeSetCreate(params);
      break;
    case 'agent.changeSet.list':
      rejectUnknown(params, ['includeTerminal']);
      optionalBoolean(params, 'includeTerminal');
      break;
    case 'agent.changeSet.apply':
    case 'agent.changeSet.reject':
      validateAgentChangeSetMutation(params);
      break;
    case 'task.log.list':
      rejectUnknown(params, ['limit', 'cursor', 'kind', 'status']);
      optionalInteger(params, 'limit', 1, 500);
      optionalString(params, 'cursor', 256);
      optionalEnum(params, 'kind', taskLogKinds);
      optionalString(params, 'status', 80);
      break;
    case 'conversation.list':
      rejectUnknown(params, [
        'scopeType',
        'scopeId',
        'includeArchived',
        'query',
        'limit',
        'cursor',
      ]);
      optionalScope(params, 'scopeType');
      optionalId(params, 'scopeId');
      optionalBoolean(params, 'includeArchived');
      optionalString(params, 'query', MAX_TITLE_LENGTH);
      optionalInteger(params, 'limit', 1, 100);
      optionalId(params, 'cursor');
      break;
    case 'conversation.create': {
      rejectUnknown(params, ['scopeType', 'scopeId', 'title']);
      const scopeType = requireScope(params, 'scopeType');
      const scopeId = optionalId(params, 'scopeId');
      optionalString(params, 'title', MAX_TITLE_LENGTH);
      if (scopeType === 'project' && scopeId !== undefined) {
        throw new RequestValidationError('scopeId is not allowed for project conversations.');
      }
      if (scopeType !== 'project' && scopeId === undefined) {
        throw new RequestValidationError('scopeId is required for scene and shot conversations.');
      }
      break;
    }
    case 'conversation.update':
      rejectUnknown(params, ['conversationId', 'title']);
      requireId(params, 'conversationId');
      requireString(params, 'title', MAX_TITLE_LENGTH);
      break;
    case 'conversation.archive':
    case 'conversation.restore':
      rejectUnknown(params, ['conversationId']);
      requireId(params, 'conversationId');
      break;
    case 'maintenance.contextSnapshots.cleanup':
      rejectUnknown(params, ['olderThanDays']);
      optionalInteger(params, 'olderThanDays', 1, 3_650);
      break;
    case 'maintenance.metrics':
      rejectUnknown(params, []);
      break;
    case 'chat.message.list':
      rejectUnknown(params, ['conversationId', 'before', 'limit']);
      requireId(params, 'conversationId');
      optionalId(params, 'before');
      optionalInteger(params, 'limit', 1, 100);
      break;
    case 'chat.message.save': {
      rejectUnknown(params, [
        'messageId',
        'conversationId',
        'replyToMessageId',
        'role',
        'content',
        'status',
      ]);
      optionalId(params, 'messageId');
      requireId(params, 'conversationId');
      optionalId(params, 'replyToMessageId');
      const role = requireEnum(params, 'role', roles);
      requireString(params, 'content', MAX_MESSAGE_LENGTH, true);
      const status = optionalEnum(params, 'status', messageStatuses) ?? 'complete';
      if (role !== 'assistant' && status !== 'complete') {
        throw new RequestValidationError('Only assistant messages may use a non-complete status.');
      }
      break;
    }
    case 'chat.message.toDocument':
      rejectUnknown(params, ['messageId', 'title', 'kind']);
      requireId(params, 'messageId');
      requireString(params, 'title', MAX_TITLE_LENGTH);
      optionalString(params, 'kind', MAX_KIND_LENGTH);
      break;
    case 'chat.message.toMemory':
      rejectUnknown(params, ['messageId']);
      requireId(params, 'messageId');
      break;
    case 'chat.message.toConstraint':
      rejectUnknown(params, ['messageId', 'kind']);
      requireId(params, 'messageId');
      optionalString(params, 'kind', MAX_KIND_LENGTH);
      break;
    case 'context.preview':
      rejectUnknown(params, ['conversationId', 'budgetTokens']);
      requireId(params, 'conversationId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      break;
    case 'novel.context.consistencyReport':
      rejectUnknown(params, []);
      break;
    case 'llm.generate':
      rejectUnknown(params, ['conversationId', 'budgetTokens', 'prompt', 'idempotencyKey']);
      requireId(params, 'conversationId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      requireString(params, 'prompt', MAX_PROMPT_LENGTH);
      optionalId(params, 'idempotencyKey');
      break;
    case 'llm.generation.prepare':
      rejectUnknown(params, [
        'conversationId',
        'budgetTokens',
        'prompt',
        'providerProfileId',
        'modelId',
        'idempotencyKey',
      ]);
      requireId(params, 'conversationId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      requireString(params, 'prompt', MAX_PROMPT_LENGTH);
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
      optionalId(params, 'idempotencyKey');
      break;
    case 'llm.generation.runtime':
      validateIdentity(params);
      break;
    case 'llm.generation.observe':
      validateIdentity(params, ['content']);
      requireString(params, 'content', MAX_MESSAGE_LENGTH, true);
      break;
    case 'llm.generation.complete':
      validateIdentity(params, ['content', 'providerResponseId', 'finishReason', 'usage']);
      requireString(params, 'content', MAX_MESSAGE_LENGTH, true);
      optionalString(params, 'providerResponseId', MAX_PROVIDER_RESPONSE_ID_LENGTH);
      optionalString(params, 'finishReason', MAX_FINISH_REASON_LENGTH);
      validateUsage(params.usage);
      break;
    case 'llm.generation.fail':
      validateIdentity(params, ['content', 'error', 'retryable', 'usage']);
      requireString(params, 'content', MAX_MESSAGE_LENGTH, true);
      requireString(params, 'error', MAX_ERROR_LENGTH);
      requireBoolean(params, 'retryable');
      validateUsage(params.usage);
      break;
    case 'llm.generation.get':
    case 'llm.generation.cancel':
      rejectUnknown(params, ['generationId']);
      requireId(params, 'generationId');
      break;
    case 'llm.generation.retry':
      rejectUnknown(params, ['assistantMessageId', 'budgetTokens', 'idempotencyKey']);
      requireId(params, 'assistantMessageId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      optionalId(params, 'idempotencyKey');
      break;
    case 'llm.generation.retryPrepare':
      rejectUnknown(params, [
        'assistantMessageId',
        'budgetTokens',
        'providerProfileId',
        'modelId',
        'idempotencyKey',
      ]);
      requireId(params, 'assistantMessageId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
      optionalId(params, 'idempotencyKey');
      break;
    case 'agent.generation.prepare':
      rejectUnknown(params, [
        'conversationId',
        'budgetTokens',
        'prompt',
        'providerProfileId',
        'modelId',
        'idempotencyKey',
        'agentMode',
        'researchMode',
        'title',
        'documentIntent',
        'novelIntent',
      ]);
      requireId(params, 'conversationId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      requireString(params, 'prompt', MAX_PROMPT_LENGTH);
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
      optionalId(params, 'idempotencyKey');
      requireEnum(params, 'agentMode', new Set(['document', 'novel-writing']));
      optionalEnum(params, 'researchMode', agentResearchModes);
      optionalString(params, 'title', MAX_TITLE_LENGTH);
      if (params.agentMode === 'document') {
        validateAgentDocumentIntent(params.documentIntent);
        if (params.novelIntent !== undefined) {
          throw new RequestValidationError('novelIntent is only allowed in novel-writing mode.');
        }
      } else {
        if (params.documentIntent !== undefined) {
          throw new RequestValidationError('documentIntent is not allowed in novel-writing mode.');
        }
        validateNovelWritingIntent(params.novelIntent);
      }
      break;
    case 'agent.generation.cancel':
      rejectUnknown(params, ['generationId']);
      requireId(params, 'generationId');
      break;
    case 'agent.generation.executeTools':
      validateIdentity(params, ['providerResponseId', 'calls', 'usage']);
      requireString(params, 'providerResponseId', MAX_PROVIDER_RESPONSE_ID_LENGTH);
      validateAgentToolCalls(params.calls);
      validateUsage(params.usage);
      break;
    case 'agent.generation.confirmTool':
      validateIdentity(params, ['confirmationToken', 'approved']);
      requireString(params, 'confirmationToken', MAX_ID_LENGTH);
      requireBoolean(params, 'approved');
      break;
    case 'agent.providerStep.complete':
      validateIdentity(params, ['providerResponseId', 'finishReason', 'usage']);
      optionalString(params, 'providerResponseId', MAX_PROVIDER_RESPONSE_ID_LENGTH);
      optionalString(params, 'finishReason', MAX_FINISH_REASON_LENGTH);
      validateUsage(params.usage);
      break;
    case 'agent.providerStep.start':
      validateIdentity(params);
      break;
    case 'maintenance.researchCache.cleanup':
      rejectUnknown(params, ['maxBytes']);
      optionalInteger(params, 'maxBytes', 0, 512 * 1024 * 1024);
      break;
  }

  return params;
}

function validateNovelWritingIntent(input: unknown): void {
  if (input === undefined) return;
  const intent = requireObject(input, 'novelIntent');
  rejectUnknown(intent, ['action', 'chapterId', 'volumeId', 'chapterTitle', 'displayLabel']);
  optionalEnum(
    intent,
    'action',
    new Set(['create_chapter', 'continue_chapter', 'rewrite_chapter']),
  );
  optionalId(intent, 'chapterId');
  optionalId(intent, 'volumeId');
  optionalString(intent, 'chapterTitle', MAX_TITLE_LENGTH);
  optionalString(intent, 'displayLabel', 80);
}

function validateIdentity(params: Record<string, unknown>, additional: string[] = []): void {
  rejectUnknown(params, [
    'generationId',
    'attemptId',
    'projectId',
    'projectSessionId',
    'conversationId',
    ...additional,
  ]);
  requireId(params, 'generationId');
  requireId(params, 'attemptId');
  requireId(params, 'projectId');
  requireId(params, 'projectSessionId');
  requireId(params, 'conversationId');
}

function validateDocumentDraft(params: Record<string, unknown>): void {
  rejectUnknown(params, [
    'documentId',
    'kind',
    'title',
    'contentMarkdown',
    'scopeType',
    'scopeId',
    'expectedDocumentRowVersion',
    'baseVersionId',
    'authorType',
  ]);
  optionalId(params, 'documentId');
  optionalEnum(params, 'kind', documentKinds);
  requireString(params, 'title', MAX_TITLE_LENGTH);
  requireString(params, 'contentMarkdown', MAX_DOCUMENT_LENGTH, true);
  const scope = optionalScope(params, 'scopeType');
  const scopeId = optionalId(params, 'scopeId');
  if (scope === 'project' && scopeId !== undefined) {
    throw new RequestValidationError('scopeId is not allowed for project documents.');
  }
  if (scope && scope !== 'project' && scopeId === undefined) {
    throw new RequestValidationError('scopeId is required for scene and shot documents.');
  }
  optionalInteger(params, 'expectedDocumentRowVersion', 0, Number.MAX_SAFE_INTEGER);
  optionalId(params, 'baseVersionId');
  optionalEnum(params, 'authorType', documentAuthors);
}

function validateAgentDocumentIntent(input: unknown): void {
  if (input === undefined) return;
  const intent = requireObject(input, 'documentIntent');
  rejectUnknown(intent, ['operation', 'documentId']);
  const operation = requireEnum(intent, 'operation', agentDocumentOperations);
  const documentId = optionalId(intent, 'documentId');
  const requiresDocument =
    operation === 'document.read' ||
    operation === 'document.update_draft' ||
    operation === 'document.archive' ||
    operation === 'document.restore' ||
    operation === 'novel.chapter.submit_draft' ||
    operation === 'novel.reference.submit_draft' ||
    operation === 'novel.adaptation.submit_proposal';
  if (requiresDocument && !documentId) {
    throw new RequestValidationError('documentIntent.documentId is required for this operation.');
  }
  if (!requiresDocument && documentId) {
    throw new RequestValidationError(
      'documentIntent.documentId is not allowed for this operation.',
    );
  }
}

function validateAgentToolCalls(input: unknown): void {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8) {
    throw new RequestValidationError('calls must contain between one and eight tool calls.');
  }
  const ids = new Set<string>();
  for (const [index, value] of input.entries()) {
    const call = requireObject(value, `calls[${index}]`);
    rejectUnknown(call, ['id', 'name', 'argumentsJson', 'authorizationHandle']);
    const id = requireId(call, 'id');
    if (ids.has(id)) throw new RequestValidationError('calls contains a duplicate tool call ID.');
    ids.add(id);
    requireString(call, 'name', MAX_ID_LENGTH);
    requireString(call, 'argumentsJson', MAX_DOCUMENT_LENGTH, true);
    requireString(call, 'authorizationHandle', MAX_ID_LENGTH);
  }
}

function validateUsage(input: unknown): NormalizedLlmUsage | undefined {
  if (input === undefined) return undefined;
  const usage = requireObject(input, 'usage');
  rejectUnknown(usage, [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
    'providerReportedCost',
    'raw',
  ]);
  for (const key of [
    'inputTokens',
    'cachedInputTokens',
    'outputTokens',
    'reasoningTokens',
    'totalTokens',
  ]) {
    optionalInteger(usage, key, 0, Number.MAX_SAFE_INTEGER);
  }
  if (usage.providerReportedCost !== undefined) {
    const cost = requireObject(usage.providerReportedCost, 'providerReportedCost');
    rejectUnknown(cost, ['amount', 'currency']);
    requireString(cost, 'amount', 80);
    optionalString(cost, 'currency', 16);
  }
  if (usage.raw !== undefined) {
    const raw = requireObject(usage.raw, 'raw');
    if (Buffer.byteLength(JSON.stringify(raw), 'utf8') > MAX_RAW_USAGE_BYTES) {
      throw new RequestValidationError('usage.raw exceeds the maximum size.');
    }
  }
  return usage;
}

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RequestValidationError(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unknown) throw new RequestValidationError(`Unknown parameter: ${unknown}.`);
}

function requireString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
  allowEmpty = false,
): string {
  const input = value[key];
  if (typeof input !== 'string' || (!allowEmpty && !input.trim())) {
    throw new RequestValidationError(`${key} must be a non-empty string.`);
  }
  if (input.length > maxLength) {
    throw new RequestValidationError(`${key} exceeds the maximum length of ${maxLength}.`);
  }
  return input;
}

function optionalString(
  value: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  if (value[key] === undefined) return undefined;
  return requireString(value, key, maxLength);
}

function requireId(value: Record<string, unknown>, key: string): string {
  return requireString(value, key, MAX_ID_LENGTH);
}

function optionalId(value: Record<string, unknown>, key: string): string | undefined {
  return optionalString(value, key, MAX_ID_LENGTH);
}

function requireScope(value: Record<string, unknown>, key: string): ConversationScopeType {
  return requireEnum(value, key, scopes);
}

function optionalScope(
  value: Record<string, unknown>,
  key: string,
): ConversationScopeType | undefined {
  return optionalEnum(value, key, scopes);
}

function requireEnum<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: Set<T>,
): T {
  const input = value[key];
  if (typeof input !== 'string' || !allowed.has(input as T)) {
    throw new RequestValidationError(`${key} has an invalid value.`);
  }
  return input as T;
}

function optionalEnum<T extends string>(
  value: Record<string, unknown>,
  key: string,
  allowed: Set<T>,
): T | undefined {
  if (value[key] === undefined) return undefined;
  return requireEnum(value, key, allowed);
}

function optionalInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const input = value[key];
  if (input === undefined) return undefined;
  if (!Number.isSafeInteger(input) || (input as number) < minimum || (input as number) > maximum) {
    throw new RequestValidationError(
      `${key} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return input as number;
}

function requireInteger(
  value: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const result = optionalInteger(value, key, minimum, maximum);
  if (result === undefined) throw new RequestValidationError(`${key} is required.`);
  return result;
}

function requireBoolean(value: Record<string, unknown>, key: string): boolean {
  const input = value[key];
  if (typeof input !== 'boolean') throw new RequestValidationError(`${key} must be a boolean.`);
  return input;
}

function optionalBoolean(value: Record<string, unknown>, key: string): boolean | undefined {
  if (value[key] === undefined) return undefined;
  return requireBoolean(value, key);
}

function validateAgentChangeSetCreate(params: Record<string, unknown>): void {
  rejectUnknown(params, ['taskId', 'title', 'items']);
  optionalId(params, 'taskId');
  requireString(params, 'title', MAX_TITLE_LENGTH);
  const items = params.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw new RequestValidationError('items must contain between one and 100 proposals.');
  }
  items.forEach((raw, ordinal) => {
    const item = requireObject(raw, `items[${ordinal}]`);
    rejectUnknown(item, [
      'entityType',
      'action',
      'targetId',
      'parentSceneId',
      'parentItemOrdinal',
      'title',
      'shotStatus',
      'documentKind',
      'contentMarkdown',
      'scopeType',
      'scopeId',
      'expectedRowVersion',
      'expectedCurrentVersionId',
    ]);
    requireEnum(item, 'entityType', new Set(['scene', 'shot']));
    requireEnum(item, 'action', new Set(['create', 'update']));
    optionalId(item, 'targetId');
    optionalId(item, 'parentSceneId');
    optionalInteger(item, 'parentItemOrdinal', 0, items.length - 1);
    requireString(item, 'title', MAX_TITLE_LENGTH);
    optionalString(item, 'shotStatus', 80);
    optionalEnum(item, 'documentKind', documentKinds);
    if (item.contentMarkdown !== undefined) {
      requireString(item, 'contentMarkdown', MAX_DOCUMENT_LENGTH, true);
    }
    const scope = optionalScope(item, 'scopeType');
    const scopeId = optionalId(item, 'scopeId');
    if (scope === 'project' && scopeId !== undefined) {
      throw new RequestValidationError('scopeId is not allowed for project documents.');
    }
    if (scope && scope !== 'project' && scopeId === undefined) {
      throw new RequestValidationError('scopeId is required for scene and shot documents.');
    }
    optionalInteger(item, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
    optionalId(item, 'expectedCurrentVersionId');
  });
}

function validateAgentChangeSetMutation(params: Record<string, unknown>): void {
  rejectUnknown(params, ['changeSetId', 'expectedRowVersion', 'itemIds']);
  requireId(params, 'changeSetId');
  requireInteger(params, 'expectedRowVersion', 0, Number.MAX_SAFE_INTEGER);
  if (params.itemIds !== undefined) {
    if (
      !Array.isArray(params.itemIds) ||
      params.itemIds.length < 1 ||
      params.itemIds.length > 100
    ) {
      throw new RequestValidationError('itemIds must contain between one and 100 IDs.');
    }
    for (const itemId of params.itemIds) {
      if (typeof itemId !== 'string' || !itemId.trim() || itemId.length > MAX_ID_LENGTH) {
        throw new RequestValidationError('itemIds must contain valid IDs.');
      }
    }
  }
}
