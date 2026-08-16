import type {
  ChatMessageRole,
  ChatMessageStatus,
  ConversationScopeType,
  NormalizedLlmUsage,
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
  'agent.task.createDocumentDraft',
  'agent.task.list',
  'agent.task.get',
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
]);

const scopes = new Set<ConversationScopeType>(['project', 'scene', 'shot']);
const roles = new Set<ChatMessageRole>(['system', 'user', 'assistant', 'tool']);
const messageStatuses = new Set<ChatMessageStatus>(['streaming', 'complete', 'failed']);
const documentKinds = new Set(['outline', 'plan', 'character', 'scene', 'storyboard', 'note']);
const documentAuthors = new Set(['user', 'import']);

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
    case 'task.log.list':
      rejectUnknown(params, ['limit']);
      optionalInteger(params, 'limit', 1, 500);
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
  }

  return params;
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
