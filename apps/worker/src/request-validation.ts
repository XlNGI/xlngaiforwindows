import type {
  ChatMessageRole,
  ChatMessageStatus,
  ConversationDeliverableKind,
  ConversationTaskPlanErrorCode,
  ConversationTaskPlanV1,
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
  'conversation.modelPreference.get',
  'conversation.modelPreference.set',
  'conversation.modelPreference.clear',
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
  'generation.job.events.list',
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
  'agent.run',
  'model.catalog.list',
  'model.catalog.get',
  'adapter.schema.get',
  'adapter.schema.propose',
  'adapter.schema.audit.list',
  'adapter.schema.confirm',
  'adapter.schema.rollback',
  'adapter.schema.audit.list',
  'conversation.runtime.start',
  'conversation.runtime.get',
  'conversation.runtime.confirm',
  'conversation.runtime.selectMedia',
  'agent.generation.executeTools',
  'agent.generation.cancel',
  'agent.generation.confirmTool',
  'agent.generation.selectMedia',
  'agent.providerStep.complete',
  'agent.providerStep.start',
  'image.generate.prepare',
  'video.generate.prepare',
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
  'adapter.schema.get',
  'adapter.schema.propose',
  'document.create_draft',
  'document.list',
  'document.read',
  'document.update_draft',
  'document.archive',
  'document.restore',
  'novel.chapter.submit_draft',
  'novel.reference.submit_draft',
  'novel.adaptation.submit_proposal',
  'novel.episode.submit_draft',
  'novel.episode.submit_structure',
]);
const agentResearchModes = new Set(['auto', 'project_only', 'network_disabled']);

export class RequestValidationError extends Error {}

export class ConversationTaskPlanValidationError extends RequestValidationError {
  constructor(
    readonly code: ConversationTaskPlanErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const conversationTaskModes = new Set(['document', 'novel-writing', 'short-drama']);
const conversationTaskActions = new Set(['generate', 'revise', 'analyze']);
const conversationTargetPlatforms = new Set(['seedance', 'generic-video', 'generic-image']);
const conversationDeliverableKinds = new Set<ConversationDeliverableKind>([
  'episode-outline',
  'character-prompts',
  'scene-prompts',
  'scene-shot-structure',
  'shot-prompts',
  'production-notes',
]);
const taskPlanAuthorityFields = new Set([
  'projectId',
  'projectSessionId',
  'conversationId',
  'taskId',
  'chapterIds',
  'selectedChapterIds',
  'documentId',
  'path',
  'localPath',
  'filePath',
  'providerProfileId',
  'providerCredential',
  'credential',
  'secret',
]);

/** Strict validator for model-proposed plans. It never accepts Worker authority fields. */
export function validateConversationTaskPlanV1(input: unknown): ConversationTaskPlanV1 {
  const plan = taskPlanObject(input, 'plan');
  rejectTaskPlanFields(plan, [
    'version',
    'mode',
    'action',
    'targetPlatform',
    'deliverables',
    'constraints',
  ]);
  if (plan.version !== 1) {
    throw taskPlanError('TASK_PLAN_INVALID_VERSION', 'Task plan version must be 1.');
  }
  if (typeof plan.mode !== 'string' || !conversationTaskModes.has(plan.mode)) {
    throw taskPlanError('TASK_PLAN_INVALID_MODE', 'Task plan mode is invalid.');
  }
  if (typeof plan.action !== 'string' || !conversationTaskActions.has(plan.action)) {
    throw taskPlanError('TASK_PLAN_INVALID_ACTION', 'Task plan action is invalid.');
  }
  if (
    plan.targetPlatform !== undefined &&
    (typeof plan.targetPlatform !== 'string' ||
      !conversationTargetPlatforms.has(plan.targetPlatform))
  ) {
    throw taskPlanError('TASK_PLAN_INVALID_PLATFORM', 'Task plan target platform is invalid.');
  }
  if (plan.targetPlatform !== undefined && plan.mode !== 'short-drama') {
    throw taskPlanError(
      'TASK_PLAN_INVALID_PLATFORM',
      'A target platform is only supported for short-drama plans.',
    );
  }
  if (
    !Array.isArray(plan.deliverables) ||
    plan.deliverables.length < 1 ||
    plan.deliverables.length > 8
  ) {
    throw taskPlanError(
      'TASK_PLAN_INVALID_DELIVERABLE',
      'Task plan deliverables must contain between one and eight items.',
    );
  }

  const kinds = new Set<ConversationDeliverableKind>();
  const deliverables = plan.deliverables.map((inputDeliverable, index) => {
    const deliverable = taskPlanObject(inputDeliverable, `deliverables[${index}]`);
    rejectTaskPlanFields(deliverable, ['kind', 'required', 'dependsOn']);
    if (
      typeof deliverable.kind !== 'string' ||
      !conversationDeliverableKinds.has(deliverable.kind as ConversationDeliverableKind)
    ) {
      throw taskPlanError(
        'TASK_PLAN_INVALID_DELIVERABLE',
        `Deliverable ${index} has an invalid kind.`,
      );
    }
    const kind = deliverable.kind as ConversationDeliverableKind;
    if (kinds.has(kind)) {
      throw taskPlanError(
        'TASK_PLAN_DUPLICATE_DELIVERABLE',
        `Deliverable kind ${kind} is duplicated.`,
      );
    }
    kinds.add(kind);
    if (typeof deliverable.required !== 'boolean') {
      throw taskPlanError(
        'TASK_PLAN_INVALID_DELIVERABLE',
        `Deliverable ${kind} must declare required as a boolean.`,
      );
    }
    if (!Array.isArray(deliverable.dependsOn) || deliverable.dependsOn.length > 7) {
      throw taskPlanError(
        'TASK_PLAN_INVALID_DEPENDENCY',
        `Deliverable ${kind} has invalid dependencies.`,
      );
    }
    const dependencyKinds = new Set<ConversationDeliverableKind>();
    const dependsOn = deliverable.dependsOn.map((dependency) => {
      if (
        typeof dependency !== 'string' ||
        !conversationDeliverableKinds.has(dependency as ConversationDeliverableKind)
      ) {
        throw taskPlanError(
          'TASK_PLAN_INVALID_DEPENDENCY',
          `Deliverable ${kind} has an invalid dependency.`,
        );
      }
      const dependencyKind = dependency as ConversationDeliverableKind;
      if (dependencyKind === kind || dependencyKinds.has(dependencyKind)) {
        throw taskPlanError(
          'TASK_PLAN_INVALID_DEPENDENCY',
          `Deliverable ${kind} has a self or duplicate dependency.`,
        );
      }
      dependencyKinds.add(dependencyKind);
      return dependencyKind;
    });
    return { kind, required: deliverable.required, dependsOn };
  });

  for (const deliverable of deliverables) {
    if (deliverable.dependsOn.some((dependency) => !kinds.has(dependency))) {
      throw taskPlanError(
        'TASK_PLAN_INVALID_DEPENDENCY',
        `Deliverable ${deliverable.kind} depends on a deliverable not present in the plan.`,
      );
    }
  }
  assertAcyclicDeliverables(deliverables);

  if (!Array.isArray(plan.constraints) || plan.constraints.length > 50) {
    throw taskPlanError(
      'TASK_PLAN_INVALID_TYPE',
      'Task plan constraints must be an array with at most 50 items.',
    );
  }
  const constraints = plan.constraints.map((constraint, index) => {
    if (typeof constraint !== 'string' || !constraint.trim() || constraint.length > 1_000) {
      throw taskPlanError(
        'TASK_PLAN_INVALID_TYPE',
        `Constraint ${index} must contain between one and 1000 characters.`,
      );
    }
    return constraint.normalize('NFC').trim();
  });

  return {
    version: 1,
    mode: plan.mode as ConversationTaskPlanV1['mode'],
    action: plan.action as ConversationTaskPlanV1['action'],
    ...(plan.targetPlatform
      ? { targetPlatform: plan.targetPlatform as ConversationTaskPlanV1['targetPlatform'] }
      : {}),
    deliverables,
    constraints,
  };
}

function taskPlanObject(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw taskPlanError('TASK_PLAN_INVALID_TYPE', `${label} must be an object.`);
  }
  return input as Record<string, unknown>;
}

function rejectTaskPlanFields(value: Record<string, unknown>, allowed: string[]): void {
  const forbidden = Object.keys(value).find((key) => taskPlanAuthorityFields.has(key));
  if (forbidden) {
    throw taskPlanError(
      'TASK_PLAN_AUTHORITY_FIELD_FORBIDDEN',
      `Task plan authority field is forbidden: ${forbidden}.`,
    );
  }
  const allowedFields = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allowedFields.has(key));
  if (unknown) {
    throw taskPlanError('TASK_PLAN_UNKNOWN_FIELD', `Unknown task plan field: ${unknown}.`);
  }
}

function assertAcyclicDeliverables(deliverables: ConversationTaskPlanV1['deliverables']): void {
  const graph = new Map(deliverables.map((item) => [item.kind, item.dependsOn]));
  const visiting = new Set<ConversationDeliverableKind>();
  const visited = new Set<ConversationDeliverableKind>();
  const visit = (kind: ConversationDeliverableKind): void => {
    if (visiting.has(kind)) {
      throw taskPlanError(
        'TASK_PLAN_CYCLIC_DEPENDENCY',
        `Task plan contains a dependency cycle at ${kind}.`,
      );
    }
    if (visited.has(kind)) return;
    visiting.add(kind);
    for (const dependency of graph.get(kind) ?? []) visit(dependency);
    visiting.delete(kind);
    visited.add(kind);
  };
  for (const kind of graph.keys()) visit(kind);
}

function taskPlanError(
  code: ConversationTaskPlanErrorCode,
  message: string,
): ConversationTaskPlanValidationError {
  return new ConversationTaskPlanValidationError(code, message);
}

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
    case 'generation.job.events.list':
      rejectUnknown(params, ['jobId', 'afterSequence', 'limit']);
      requireId(params, 'jobId');
      optionalInteger(params, 'afterSequence', 0, Number.MAX_SAFE_INTEGER);
      optionalInteger(params, 'limit', 1, 100);
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
    case 'conversation.modelPreference.get':
    case 'conversation.modelPreference.clear':
      rejectUnknown(params, ['conversationId', 'capability']);
      requireId(params, 'conversationId');
      requireEnum(
        params,
        'capability',
        new Set([
          'text',
          'image',
          'video',
          'document',
          'novel',
          'short-drama',
          'research',
          'asset',
        ]),
      );
      break;
    case 'conversation.modelPreference.set':
      rejectUnknown(params, ['conversationId', 'capability', 'providerProfileId', 'modelId']);
      requireId(params, 'conversationId');
      requireEnum(
        params,
        'capability',
        new Set([
          'text',
          'image',
          'video',
          'document',
          'novel',
          'short-drama',
          'research',
          'asset',
        ]),
      );
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
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
    case 'shot.storyboard.save':
      rejectUnknown(params, ['shotId', 'title', 'contentMarkdown']);
      requireId(params, 'shotId');
      requireString(params, 'title', MAX_TITLE_LENGTH);
      requireString(params, 'contentMarkdown', MAX_DOCUMENT_LENGTH, true);
      break;
    case 'constraint.list':
      rejectUnknown(params, []);
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
    case 'image.generate.prepare':
      rejectUnknown(params, [
        'shotId',
        'adapterKey',
        'parameters',
        'providerProfileId',
        'modelId',
        'conversationId',
        'originalPrompt',
        'costNoticeAcknowledged',
      ]);
      optionalId(params, 'shotId');
      requireString(params, 'adapterKey', 200);
      requireObject(params.parameters, 'parameters');
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
      optionalId(params, 'conversationId');
      optionalString(params, 'originalPrompt', MAX_PROMPT_LENGTH);
      optionalBoolean(params, 'costNoticeAcknowledged');
      break;
    case 'video.generate.prepare':
      rejectUnknown(params, [
        'shotId',
        'adapterKey',
        'parameters',
        'providerRegion',
        'providerProfileId',
        'modelId',
        'assetKind',
        'conversationId',
        'originalPrompt',
        'costNoticeAcknowledged',
      ]);
      optionalId(params, 'shotId');
      requireString(params, 'adapterKey', 200);
      requireObject(params.parameters, 'parameters');
      requireEnum(params, 'providerRegion', new Set(['global', 'cn', 'unicompapi']));
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
      optionalEnum(params, 'assetKind', new Set(['generated-video', 'shot-video']));
      optionalId(params, 'conversationId');
      optionalString(params, 'originalPrompt', MAX_PROMPT_LENGTH);
      optionalBoolean(params, 'costNoticeAcknowledged');
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
        'attachments',
      ]);
      requireId(params, 'conversationId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      requireString(params, 'prompt', MAX_PROMPT_LENGTH);
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
      optionalId(params, 'idempotencyKey');
      validateLlmAttachments(params.attachments);
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
        'selectedChapterIds',
        'targetPlatform',
        'attachments',
      ]);
      requireId(params, 'conversationId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      requireString(params, 'prompt', MAX_PROMPT_LENGTH);
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
      optionalId(params, 'idempotencyKey');
      validateLlmAttachments(params.attachments);
      requireEnum(params, 'agentMode', new Set(['document', 'novel-writing', 'short-drama']));
      optionalEnum(params, 'researchMode', agentResearchModes);
      optionalString(params, 'title', MAX_TITLE_LENGTH);
      validateSelectedChapterIds(params);
      if (params.agentMode === 'document' || params.agentMode === 'short-drama') {
        validateAgentDocumentIntent(params.documentIntent);
        if (params.novelIntent !== undefined) {
          throw new RequestValidationError('novelIntent is only allowed in novel-writing mode.');
        }
        if (params.agentMode === 'short-drama' && params.selectedChapterIds === undefined) {
          throw new RequestValidationError('selectedChapterIds is required in short-drama mode.');
        }
        if (params.agentMode === 'short-drama') {
          requireEnum(params, 'targetPlatform', conversationTargetPlatforms);
        } else if (params.targetPlatform !== undefined) {
          throw new RequestValidationError('targetPlatform is only allowed in short-drama mode.');
        }
      } else {
        if (params.documentIntent !== undefined) {
          throw new RequestValidationError('documentIntent is not allowed in novel-writing mode.');
        }
        validateNovelWritingIntent(params.novelIntent);
        if (params.targetPlatform !== undefined) {
          throw new RequestValidationError('targetPlatform is only allowed in short-drama mode.');
        }
      }
      break;
    case 'agent.run':
      rejectUnknown(params, [
        'conversationId',
        'prompt',
        'capability',
        'providerProfileId',
        'modelId',
        'budgetTokens',
        'idempotencyKey',
        'adapterKey',
        'parameters',
        'shotId',
        'providerRegion',
        'assetKind',
        'attachments',
      ]);
      requireId(params, 'conversationId');
      requireString(params, 'prompt', MAX_PROMPT_LENGTH);
      optionalEnum(
        params,
        'capability',
        new Set([
          'text',
          'image',
          'video',
          'document',
          'novel',
          'short-drama',
          'research',
          'asset',
          'auto',
        ]),
      );
      optionalId(params, 'providerProfileId');
      optionalId(params, 'modelId');
      optionalInteger(params, 'budgetTokens', 1_000, 200_000);
      optionalId(params, 'idempotencyKey');
      optionalId(params, 'adapterKey');
      optionalId(params, 'shotId');
      validateLlmAttachments(params.attachments);
      optionalEnum(params, 'providerRegion', new Set(['global', 'cn', 'unicompapi']));
      optionalEnum(
        params,
        'assetKind',
        new Set([
          'character',
          'scene',
          'first-frame',
          'last-frame',
          'generated-image',
          'generated-video',
          'shot-video',
        ]),
      );
      if (params.parameters !== undefined) requireObject(params.parameters, 'parameters');
      if ((params.providerProfileId === undefined) !== (params.modelId === undefined)) {
        throw new RequestValidationError(
          'providerProfileId and modelId must be provided together.',
        );
      }
      break;
    case 'model.catalog.list':
      rejectUnknown(params, ['capability', 'providerProfileId', 'includeUnavailable']);
      optionalEnum(
        params,
        'capability',
        new Set([
          'text',
          'image',
          'video',
          'document',
          'novel',
          'short-drama',
          'research',
          'asset',
          'auto',
        ]),
      );
      optionalId(params, 'providerProfileId');
      optionalBoolean(params, 'includeUnavailable');
      break;
    case 'model.catalog.get':
      rejectUnknown(params, ['providerProfileId', 'modelId', 'capability']);
      requireId(params, 'providerProfileId');
      requireId(params, 'modelId');
      optionalEnum(
        params,
        'capability',
        new Set([
          'text',
          'image',
          'video',
          'document',
          'novel',
          'short-drama',
          'research',
          'asset',
          'auto',
        ]),
      );
      break;
    case 'adapter.schema.get':
      rejectUnknown(params, ['adapterKey']);
      requireString(params, 'adapterKey', 200);
      break;
    case 'adapter.schema.propose':
      rejectUnknown(params, ['adapterKey', 'descriptor', 'reason', 'conversationId', 'actorType']);
      requireString(params, 'adapterKey', 200);
      validateAdapterDescriptorRequest(params.descriptor, params.adapterKey as string);
      optionalString(params, 'reason', MAX_ERROR_LENGTH);
      optionalId(params, 'conversationId');
      optionalEnum(params, 'actorType', new Set(['user', 'agent', 'system']));
      break;
    case 'adapter.schema.confirm':
    case 'adapter.schema.rollback':
      rejectUnknown(params, ['adapterKey', 'version', 'reason', 'conversationId', 'actorType']);
      requireString(params, 'adapterKey', 200);
      requireInteger(params, 'version', 1, Number.MAX_SAFE_INTEGER);
      optionalString(params, 'reason', MAX_ERROR_LENGTH);
      optionalId(params, 'conversationId');
      optionalEnum(params, 'actorType', new Set(['user', 'agent', 'system']));
      break;
    case 'adapter.schema.audit.list':
      rejectUnknown(params, ['adapterKey', 'limit']);
      requireString(params, 'adapterKey', 200);
      optionalInteger(params, 'limit', 1, 200);
      break;
    case 'conversation.runtime.start':
      validateIdentity(params, ['taskId', 'mode', 'prompt']);
      requireId(params, 'taskId');
      requireEnum(params, 'mode', new Set(['document', 'novel-writing', 'short-drama']));
      requireString(params, 'prompt', MAX_PROMPT_LENGTH);
      break;
    case 'conversation.runtime.get':
      rejectUnknown(params, ['generationId']);
      requireId(params, 'generationId');
      break;
    case 'conversation.runtime.confirm':
      rejectUnknown(params, ['generationId', 'confirmationToken', 'approved']);
      requireId(params, 'generationId');
      requireString(params, 'confirmationToken', MAX_ID_LENGTH);
      requireBoolean(params, 'approved');
      break;
    case 'conversation.runtime.selectMedia':
      rejectUnknown(params, ['generationId', 'selectionToken', 'selection']);
      requireId(params, 'generationId');
      requireString(params, 'selectionToken', MAX_ID_LENGTH);
      validateMediaSelection(params.selection);
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
    case 'agent.generation.selectMedia':
      validateIdentity(params, ['selectionToken', 'selection']);
      requireString(params, 'selectionToken', MAX_ID_LENGTH);
      validateMediaSelection(params.selection);
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

function validateMediaSelection(input: unknown): void {
  if (input === undefined) return;
  const selection = requireObject(input, 'selection');
  rejectUnknown(selection, [
    'providerProfileId',
    'modelId',
    'adapterKey',
    'parameters',
    'assetKind',
  ]);
  requireId(selection, 'providerProfileId');
  requireId(selection, 'modelId');
  requireString(selection, 'adapterKey', 200);
  optionalEnum(
    selection,
    'assetKind',
    new Set([
      'character',
      'scene',
      'first-frame',
      'last-frame',
      'generated-image',
      'generated-video',
      'shot-video',
    ]),
  );
  const parameters = requireObject(selection.parameters, 'selection.parameters');
  if (Object.keys(parameters).length > 40) {
    throw new RequestValidationError('selection.parameters may contain at most 40 fields.');
  }
  for (const [key, value] of Object.entries(parameters)) {
    if (!key || key.length > 100) {
      throw new RequestValidationError('selection.parameters contains an invalid field name.');
    }
    const values = Array.isArray(value) ? value : [value];
    if (Array.isArray(value) && value.length > 20) {
      throw new RequestValidationError(`selection.parameters.${key} has too many values.`);
    }
    for (const item of values) {
      if (typeof item === 'string') {
        if (item.length > 2 * 1024 * 1024) {
          throw new RequestValidationError(`selection.parameters.${key} is too large.`);
        }
      } else if (typeof item !== 'number' && typeof item !== 'boolean') {
        throw new RequestValidationError(`selection.parameters.${key} has an invalid value.`);
      }
    }
  }
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

function validateAdapterDescriptorRequest(value: unknown, adapterKey: string): void {
  const descriptor = requireObject(value, 'descriptor');
  if (descriptor.key !== adapterKey)
    throw new RequestValidationError('descriptor.key must match adapterKey.');
  for (const key of [
    'capability',
    'capabilityLabel',
    'provider',
    'providerLabel',
    'model',
    'modelLabel',
    'apiVersion',
    'endpoint',
    'documentationUrl',
    'credentialProvider',
  ])
    requireString(descriptor, key, 500);
  requireInteger(descriptor, 'schemaVersion', 1, Number.MAX_SAFE_INTEGER);
  const schema = requireObject(descriptor.parameterSchema, 'descriptor.parameterSchema');
  if (schema.type !== 'object' || schema.additionalProperties !== false) {
    throw new RequestValidationError(
      'descriptor.parameterSchema must be an object schema with additionalProperties=false.',
    );
  }
  const properties = requireObject(schema.properties, 'descriptor.parameterSchema.properties');
  const required = schema.required;
  if (!Array.isArray(required) || required.some((item) => typeof item !== 'string')) {
    throw new RequestValidationError(
      'descriptor.parameterSchema.required must be an array of strings.',
    );
  }
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) {
      throw new RequestValidationError(
        `descriptor.parameterSchema.required contains unknown field: ${key}.`,
      );
    }
  }
  for (const [key, raw] of Object.entries(properties)) {
    const property = requireObject(raw, `descriptor.parameterSchema.properties.${key}`);
    requireEnum(property, 'type', new Set(['string', 'integer', 'boolean', 'array']));
  }
  const uiSchema = requireObject(descriptor.uiSchema, 'descriptor.uiSchema');
  if (!Array.isArray(uiSchema.fields))
    throw new RequestValidationError('descriptor.uiSchema.fields must be an array.');
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

function validateLlmAttachments(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 8) {
    throw new RequestValidationError('attachments must contain at most 8 items.');
  }
  value.forEach((raw, index) => {
    const item = requireObject(raw, `attachments[${index}]`);
    rejectUnknown(item, ['name', 'mimeType', 'dataUrl', 'text']);
    requireString(item, 'name', 240);
    requireString(item, 'mimeType', 160);
    if (item.dataUrl !== undefined) requireString(item, 'dataUrl', 2_000_000);
    if (item.text !== undefined) requireString(item, 'text', 2_000_000, true);
    if (item.dataUrl === undefined && item.text === undefined) {
      throw new RequestValidationError(`attachments[${index}] must contain dataUrl or text.`);
    }
  });
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
      'prompt',
      'documentKind',
      'contentMarkdown',
      'scopeType',
      'scopeId',
      'expectedRowVersion',
      'expectedCurrentVersionId',
    ]);
    requireEnum(item, 'entityType', new Set(['scene', 'shot', 'document']));
    requireEnum(item, 'action', new Set(['create', 'update']));
    optionalId(item, 'targetId');
    optionalId(item, 'parentSceneId');
    optionalInteger(item, 'parentItemOrdinal', 0, items.length - 1);
    requireString(item, 'title', MAX_TITLE_LENGTH);
    optionalString(item, 'shotStatus', 80);
    optionalString(item, 'prompt', 2000);
    if (item.prompt !== undefined && item.entityType !== 'shot') {
      throw new RequestValidationError('prompt is only allowed on shot items.');
    }
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

function validateSelectedChapterIds(params: Record<string, unknown>): void {
  if (params.selectedChapterIds === undefined) return;
  if (
    !Array.isArray(params.selectedChapterIds) ||
    params.selectedChapterIds.length < 1 ||
    params.selectedChapterIds.length > 50
  ) {
    throw new RequestValidationError('selectedChapterIds must contain between one and 50 IDs.');
  }
  for (const chapterId of params.selectedChapterIds) {
    if (typeof chapterId !== 'string' || !chapterId.trim() || chapterId.length > MAX_ID_LENGTH) {
      throw new RequestValidationError('selectedChapterIds must contain valid IDs.');
    }
  }
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
