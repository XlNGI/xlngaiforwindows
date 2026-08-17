import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  AgentGenerationExecuteToolsParams,
  AgentGenerationExecuteToolsResult,
  AgentGenerationConfirmToolParams,
  AgentGenerationConfirmToolResult,
  AgentDocumentIntent,
  AgentDocumentOperation,
  AgentProviderStepCompleteParams,
  LlmGenerationIdentity,
  LlmToolDefinition,
} from '@ai-video/contracts';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';

const TOOL_SCHEMA_VERSION = 'document-tools.v1';
const POLICY_VERSION = 'agent-policy.v1';
const AUTHORIZATION_TTL_MS = 5 * 60_000;

export const DOCUMENT_AGENT_TOOLS: LlmToolDefinition[] = [
  {
    name: 'document.create_draft',
    description: 'Create one reviewable Markdown document draft for the current project.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'contentMarkdown'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        contentMarkdown: { type: 'string', minLength: 1, maxLength: 1_000_000 },
      },
    },
  },
  {
    name: 'document.list',
    description: 'List active documents in the current project.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'document.read',
    description: 'Read the Worker-authorized document.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'document.update_draft',
    description: 'Create a reviewable revision of the Worker-authorized document.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'contentMarkdown'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200 },
        contentMarkdown: { type: 'string', minLength: 1, maxLength: 1_000_000 },
      },
    },
  },
  {
    name: 'document.archive',
    description:
      'Request archival of the Worker-authorized document. User confirmation is required.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'document.restore',
    description:
      'Request restoration of the Worker-authorized document. User confirmation is required.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
  },
];

type AuthorizationSpec = {
  operation: AgentDocumentOperation;
  targetDocumentId?: string;
  scopeType?: 'project' | 'scene' | 'shot';
  scopeId?: string;
  baseVersionId?: string;
  expectedDocumentRowVersion?: number;
};

interface PreparedAgentLoop {
  taskId: string;
  tools: LlmToolDefinition[];
}

interface GenerationRow {
  id: string;
  project_id: string;
  project_session_id: string;
  conversation_id: string;
  context_snapshot_id: string;
  user_message_id: string;
}

interface ConversationRow {
  scope_type: 'project' | 'scene' | 'shot';
  scope_id: string | null;
}

interface StepRow {
  id: string;
  ordinal: number;
  status: string;
}

interface AuthorizationRow extends AuthorizationSpec {
  id: string;
  row_version: number;
  authorization_handle_hash: string;
}

export class AgentProviderLoopService {
  constructor(
    private readonly projects: ProjectService,
    private readonly documents: DocumentWorkflowService,
  ) {}

  prepare(
    identity: LlmGenerationIdentity,
    prompt: string,
    title?: string,
    intent: AgentDocumentIntent = { operation: 'document.create_draft' },
  ): PreparedAgentLoop {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const generation = database
          .prepare('SELECT * FROM llm_generations WHERE id = ? AND project_id = ?')
          .get(identity.generationId, project.id) as GenerationRow | undefined;
        if (!generation || generation.project_session_id !== identity.projectSessionId) {
          throw new Error('Agent generation does not belong to the current project session.');
        }
        const conversation = database
          .prepare('SELECT scope_type, scope_id FROM conversations WHERE id = ? AND project_id = ?')
          .get(identity.conversationId, project.id) as ConversationRow | undefined;
        if (!conversation) throw new Error('Agent conversation was not found.');
        const existing = database
          .prepare('SELECT task_id FROM agent_task_generations WHERE generation_id = ?')
          .get(identity.generationId) as { task_id: string } | undefined;
        if (existing) {
          const now = new Date().toISOString();
          database
            .prepare(
              `UPDATE agent_tool_authorizations SET status = 'revoked', revoked_at = ?,
               row_version = row_version + 1 WHERE task_id = ? AND status = 'issued'`,
            )
            .run(now, existing.task_id);
          database
            .prepare(
              `UPDATE llm_provider_steps SET status = 'interrupted', completed_at = ?,
               error_code = 'superseded-runtime' WHERE attempt_id = ? AND status IN ('prepared', 'in_flight')`,
            )
            .run(now, identity.attemptId);
          const ordinal = (
            database
              .prepare(
                'SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM llm_provider_steps WHERE attempt_id = ?',
              )
              .get(identity.attemptId) as { value: number }
          ).value;
          const previousAuthorization = database
            .prepare(
              `SELECT allowed_operation AS operation, target_document_id AS targetDocumentId,
                      scope_type AS scopeType, scope_id AS scopeId, base_version_id AS baseVersionId,
                      expected_document_row_version AS expectedDocumentRowVersion
               FROM agent_tool_authorizations WHERE task_id = ? ORDER BY created_at LIMIT 1`,
            )
            .get(existing.task_id) as AuthorizationSpec | undefined;
          if (!previousAuthorization) throw new Error('Agent task authorization was not found.');
          const step = this.createStep(
            database,
            project.id,
            identity,
            existing.task_id,
            ordinal,
            now,
            previousAuthorization,
          );
          return {
            taskId: existing.task_id,
            tools: this.toolsFor(previousAuthorization.operation).map((tool) => ({
              ...tool,
              authorizationHandle: step.authorizationHandle,
            })),
          };
        }

        const now = new Date().toISOString();
        const taskId = randomUUID();
        const requestHash = hash(prompt);
        const authorization = this.resolveAuthorization(database, project.id, conversation, intent);
        database
          .prepare(
            `INSERT INTO agent_tasks
             (id, project_id, project_session_id, conversation_id, user_message_id, task_type,
              scope_type, scope_id, title, request_snapshot_json, request_hash, context_snapshot_id,
              status, created_at, started_at, updated_at, phase, row_version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                     'running', ?, ?, ?, 'model_running', 0)`,
          )
          .run(
            taskId,
            project.id,
            identity.projectSessionId,
            identity.conversationId,
            generation.user_message_id,
            taskTypeFor(authorization.operation),
            authorization.scopeType ?? conversation.scope_type,
            authorization.scopeId ?? conversation.scope_id,
            normalizeTitle(title ?? 'Agent document draft'),
            JSON.stringify({ promptHash: requestHash, agentMode: 'document' }),
            requestHash,
            generation.context_snapshot_id,
            now,
            now,
            now,
          );
        database
          .prepare(
            `INSERT INTO agent_task_generations (task_id, generation_id, ordinal, purpose, created_at)
             VALUES (?, ?, 0, 'primary', ?)`,
          )
          .run(taskId, identity.generationId, now);
        this.appendEvent(
          database,
          project.id,
          taskId,
          'agent.task.created',
          'Agent task started.',
          now,
        );
        const preparedStep = this.createStep(
          database,
          project.id,
          identity,
          taskId,
          0,
          now,
          authorization,
        );
        return {
          taskId,
          tools: this.toolsFor(authorization.operation).map((tool) => ({
            ...tool,
            authorizationHandle: preparedStep.authorizationHandle,
          })),
        };
      })(),
    );
  }

  executeTools(params: AgentGenerationExecuteToolsParams): AgentGenerationExecuteToolsResult {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        if (!params.providerResponseId.trim()) throw new Error('Provider response ID is required.');
        if (params.calls.length !== 1)
          throw new Error('Exactly one primary document tool call is allowed.');
        this.requireActiveGeneration(database, project.id, params);
        const task = this.requireTask(database, project.id, params.generationId);
        const step = this.requireOpenStep(database, params.attemptId);
        const call = params.calls[0]!;
        const authorization = database
          .prepare(
            `SELECT id, row_version, authorization_handle_hash,
                    allowed_operation AS operation, target_document_id AS targetDocumentId,
                    scope_type AS scopeType, scope_id AS scopeId, base_version_id AS baseVersionId,
                    expected_document_row_version AS expectedDocumentRowVersion
             FROM agent_tool_authorizations
             WHERE provider_step_id = ? AND task_id = ? AND allowed_operation = ?
               AND status = 'issued' AND used_call_count < max_call_uses AND expires_at > ?`,
          )
          .get(step.id, task.id, call.name, new Date().toISOString()) as
          AuthorizationRow | undefined;
        if (
          !authorization ||
          !call.authorizationHandle ||
          hash(call.authorizationHandle) !== authorization.authorization_handle_hash
        ) {
          throw new Error('Provider tool call is not authorized for this step.');
        }
        const args = parseToolArguments(call.name, call.argumentsJson);
        const lifecycleAction: 'document.archive' | 'document.restore' | undefined =
          call.name === 'document.archive'
            ? 'document.archive'
            : call.name === 'document.restore'
              ? 'document.restore'
              : undefined;
        const awaitsConfirmation = lifecycleAction !== undefined;
        const now = new Date().toISOString();
        const argumentsHash = hash(JSON.stringify(args));
        const existing = database
          .prepare(
            `SELECT result_summary_json FROM agent_tool_calls
             WHERE task_id = ? AND attempt_id = ? AND provider_step_id = ? AND provider_call_id = ?`,
          )
          .get(task.id, params.attemptId, step.id, call.id) as
          { result_summary_json: string | null } | undefined;
        if (existing?.result_summary_json) {
          return {
            continuation: {
              previousResponseId: params.providerResponseId,
              outputs: [{ callId: call.id, output: existing.result_summary_json }],
            },
          };
        }
        if (!awaitsConfirmation) this.reserveExecution(database, authorization, task.id, now);

        const toolCallId = randomUUID();
        const content = typeof args.contentMarkdown === 'string' ? args.contentMarkdown : undefined;
        database
          .prepare(
            `INSERT INTO agent_tool_calls
             (id, project_id, task_id, generation_id, attempt_id, authorization_id, provider_step_id,
              provider_call_id, tool_ordinal, tool_name, normalized_arguments_hash,
              arguments_summary_json, content_hash, content_length, status, created_at, started_at,
              version, redaction_state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'native')`,
          )
          .run(
            toolCallId,
            project.id,
            task.id,
            params.generationId,
            params.attemptId,
            authorization.id,
            step.id,
            call.id,
            call.name,
            argumentsHash,
            JSON.stringify({
              operation: call.name,
              titleLength: typeof args.title === 'string' ? args.title.length : undefined,
              targetDocumentId: authorization.targetDocumentId,
            }),
            content ? hash(content) : null,
            content ? Buffer.byteLength(content, 'utf8') : null,
            awaitsConfirmation ? 'awaiting_confirmation' : 'executing',
            now,
            now,
          );
        if (lifecycleAction) {
          const token = randomBytes(32).toString('base64url');
          const expiresAt = new Date(Date.now() + AUTHORIZATION_TTL_MS).toISOString();
          const target = authorization.targetDocumentId;
          if (!target || authorization.expectedDocumentRowVersion === undefined) {
            throw new Error('Lifecycle authorization is missing its trusted target.');
          }
          const row = database.prepare('SELECT title FROM documents WHERE id = ?').get(target) as {
            title: string;
          };
          database
            .prepare(
              `INSERT INTO agent_task_confirmations
               (id, project_id, task_id, generation_id, attempt_id, original_tool_call_id, action,
                target_document_id, expected_document_row_version, normalized_arguments_hash,
                continuation_descriptor_json, token_hash, status, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            )
            .run(
              randomUUID(),
              project.id,
              task.id,
              params.generationId,
              params.attemptId,
              toolCallId,
              call.name,
              target,
              authorization.expectedDocumentRowVersion,
              argumentsHash,
              JSON.stringify({ providerResponseId: params.providerResponseId, callId: call.id }),
              hash(token),
              expiresAt,
              now,
            );
          this.completeStep(
            database,
            step,
            params.providerResponseId,
            params.calls.length,
            params.usage,
            now,
            'awaiting_confirmation',
            JSON.stringify({ version: 1, callIds: [call.id], confirmationPending: true }),
          );
          database
            .prepare(
              "UPDATE agent_tasks SET phase = 'waiting_confirmation', updated_at = ?, row_version = row_version + 1 WHERE id = ? AND status = 'running'",
            )
            .run(now, task.id);
          return {
            confirmation: {
              confirmationToken: token,
              action: lifecycleAction,
              documentId: target,
              documentTitle: row.title,
              expiresAt,
            },
          };
        }

        let document: { id: string; currentVersion?: { id: string } } | undefined;
        let result: string;
        let resultSummary: string;
        if (call.name === 'document.create_draft') {
          document = this.documents.writeTrustedAgentDraftInTransaction(database, project, {
            taskId: task.id,
            title: args.title as string,
            contentMarkdown: args.contentMarkdown as string,
            scopeType: task.scope_type,
            scopeId: task.scope_id ?? undefined,
            sourceMessageId: task.user_message_id ?? undefined,
            contextSnapshotId: task.context_snapshot_id ?? undefined,
          });
          result = JSON.stringify({
            status: 'draft_created',
            documentId: document.id,
            documentVersionId: document.currentVersion?.id,
            reviewRequired: true,
          });
          resultSummary = result;
        } else if (call.name === 'document.update_draft') {
          if (
            !authorization.targetDocumentId ||
            !authorization.baseVersionId ||
            authorization.expectedDocumentRowVersion === undefined
          ) {
            throw new Error('Update authorization is missing its trusted target or CAS.');
          }
          document = this.documents.writeTrustedAgentUpdateInTransaction(database, project, {
            taskId: task.id,
            documentId: authorization.targetDocumentId,
            expectedDocumentRowVersion: authorization.expectedDocumentRowVersion,
            baseVersionId: authorization.baseVersionId,
            title: args.title as string,
            contentMarkdown: args.contentMarkdown as string,
            scopeType: task.scope_type,
            scopeId: task.scope_id ?? undefined,
            sourceMessageId: task.user_message_id ?? undefined,
            contextSnapshotId: task.context_snapshot_id ?? undefined,
          });
          result = JSON.stringify({
            status: 'draft_updated',
            documentId: document.id,
            documentVersionId: document.currentVersion?.id,
            reviewRequired: true,
          });
          resultSummary = result;
        } else if (call.name === 'document.list') {
          const items = this.documents.listAgentDocumentsInTransaction(database, project);
          result = JSON.stringify({
            status: 'listed',
            documents: items.map(
              ({ id, title, scopeType, scopeId, lifecycleStatus, updatedAt }) => ({
                id,
                title,
                scopeType,
                scopeId,
                lifecycleStatus,
                updatedAt,
              }),
            ),
          });
          resultSummary = result;
          database
            .prepare(
              "UPDATE agent_tasks SET status = 'completed', outcome = 'read-only', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
            )
            .run(now, now, task.id);
        } else if (call.name === 'document.read') {
          if (!authorization.targetDocumentId)
            throw new Error('Read authorization is missing its trusted target.');
          const read = this.documents.readAgentDocumentInTransaction(
            database,
            project,
            authorization.targetDocumentId,
          );
          result = JSON.stringify({
            status: 'read',
            documentId: read.id,
            title: read.title,
            versionId: read.currentVersion?.id,
            contentMarkdown:
              read.publishedVersion?.contentMarkdown ?? read.currentVersion?.contentMarkdown ?? '',
          });
          resultSummary = JSON.stringify({
            status: 'read',
            documentId: read.id,
            versionId: read.currentVersion?.id,
            contentLength: Buffer.byteLength(
              read.publishedVersion?.contentMarkdown ?? read.currentVersion?.contentMarkdown ?? '',
              'utf8',
            ),
          });
          database
            .prepare(
              "UPDATE agent_tasks SET status = 'completed', outcome = 'read-only', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
            )
            .run(now, now, task.id);
        } else {
          throw new Error('Provider tool is not supported.');
        }
        database
          .prepare(
            `UPDATE agent_tool_calls SET status = 'succeeded', result_summary_json = ?,
             result_document_id = ?, result_document_version_id = ?, completed_at = ?, version = version + 1
             WHERE id = ?`,
          )
          .run(
            resultSummary,
            document?.id ?? null,
            document?.currentVersion?.id ?? null,
            now,
            toolCallId,
          );
        this.completeStep(
          database,
          step,
          params.providerResponseId,
          params.calls.length,
          params.usage,
          now,
          'tool_calls',
          JSON.stringify({
            version: 1,
            previousResponseIdHash: hash(params.providerResponseId),
            callIds: params.calls.map((item) => item.id),
          }),
        );
        this.createStep(
          database,
          project.id,
          params,
          task.id,
          step.ordinal + 1,
          now,
          authorization,
        );
        this.appendEvent(
          database,
          project.id,
          task.id,
          'agent.tool.succeeded',
          'Document tool completed.',
          now,
        );
        return {
          continuation: {
            previousResponseId: params.providerResponseId,
            outputs: [{ callId: call.id, output: result }],
          },
        };
      })(),
    );
  }

  confirmTool(params: AgentGenerationConfirmToolParams): AgentGenerationConfirmToolResult {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        this.requireActiveGeneration(database, project.id, params);
        const task = this.requireTask(database, project.id, params.generationId);
        const confirmation = database
          .prepare(
            `SELECT confirmations.*, calls.provider_call_id, calls.tool_name,
                    auth.id AS authorizationId, auth.row_version AS authorizationRowVersion,
                    auth.allowed_operation AS operation, auth.target_document_id AS targetDocumentId,
                    auth.scope_type AS scopeType, auth.scope_id AS scopeId,
                    auth.base_version_id AS baseVersionId,
                    auth.expected_document_row_version AS expectedDocumentRowVersion
             FROM agent_task_confirmations confirmations
             INNER JOIN agent_tool_calls calls ON calls.id = confirmations.original_tool_call_id
             INNER JOIN agent_tool_authorizations auth ON auth.task_id = confirmations.task_id
               AND auth.attempt_id = confirmations.attempt_id AND auth.allowed_operation = confirmations.action
             WHERE confirmations.task_id = ? AND confirmations.generation_id = ?
               AND confirmations.attempt_id = ? AND confirmations.status = 'pending'
               AND confirmations.expires_at > ?`,
          )
          .get(task.id, params.generationId, params.attemptId, new Date().toISOString()) as
          | (AuthorizationSpec & {
              id: string;
              authorizationId: string;
              authorizationRowVersion: number;
              original_tool_call_id: string;
              action: AgentDocumentOperation;
              token_hash: string;
              provider_call_id: string;
              continuation_descriptor_json: string;
              expectedDocumentRowVersion: number;
            })
          | undefined;
        if (!confirmation || hash(params.confirmationToken) !== confirmation.token_hash) {
          throw new Error('Confirmation token is invalid, expired, or already consumed.');
        }
        const now = new Date().toISOString();
        let output: string;
        if (params.approved) {
          if (
            !confirmation.targetDocumentId ||
            confirmation.expectedDocumentRowVersion === undefined
          ) {
            throw new Error('Confirmation is missing its trusted target.');
          }
          this.reserveExecution(
            database,
            {
              id: confirmation.authorizationId,
              row_version: confirmation.authorizationRowVersion,
              authorization_handle_hash: '',
              operation: confirmation.operation,
              targetDocumentId: confirmation.targetDocumentId,
              scopeType: confirmation.scopeType,
              scopeId: confirmation.scopeId,
              baseVersionId: confirmation.baseVersionId,
              expectedDocumentRowVersion: confirmation.expectedDocumentRowVersion,
            },
            task.id,
            now,
          );
          this.documents.applyTrustedAgentLifecycleInTransaction(database, project, {
            taskId: task.id,
            documentId: confirmation.targetDocumentId,
            expectedDocumentRowVersion: confirmation.expectedDocumentRowVersion,
            outcome: confirmation.action === 'document.archive' ? 'archived' : 'restored',
          });
          output = JSON.stringify({
            status: confirmation.action === 'document.archive' ? 'archived' : 'restored',
            documentId: confirmation.targetDocumentId,
          });
        } else {
          database
            .prepare(
              "UPDATE agent_tool_authorizations SET status = 'revoked', revoked_at = ?, row_version = row_version + 1 WHERE id = ? AND status = 'issued'",
            )
            .run(now, confirmation.authorizationId);
          database
            .prepare(
              "UPDATE agent_tasks SET status = 'completed', outcome = 'rejected', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running'",
            )
            .run(now, now, task.id);
          output = JSON.stringify({ status: 'confirmation_rejected', action: confirmation.action });
        }
        database
          .prepare(
            "UPDATE agent_task_confirmations SET status = 'consumed', approved_by_type = 'user', approved_at = ?, consumed_at = ? WHERE id = ? AND status = 'pending'",
          )
          .run(now, now, confirmation.id);
        database
          .prepare(
            "UPDATE agent_tool_calls SET status = 'executing', version = version + 1 WHERE id = ? AND status = 'awaiting_confirmation'",
          )
          .run(confirmation.original_tool_call_id);
        database
          .prepare(
            "UPDATE agent_tool_calls SET status = 'succeeded', result_summary_json = ?, completed_at = ?, version = version + 1 WHERE id = ?",
          )
          .run(output, now, confirmation.original_tool_call_id);
        const descriptor = JSON.parse(confirmation.continuation_descriptor_json) as {
          providerResponseId: string;
          callId: string;
        };
        const ordinal = (
          database
            .prepare(
              'SELECT COALESCE(MAX(ordinal), -1) + 1 AS value FROM llm_provider_steps WHERE attempt_id = ?',
            )
            .get(params.attemptId) as { value: number }
        ).value;
        this.createStep(database, project.id, params, task.id, ordinal, now, {
          operation: confirmation.operation,
          targetDocumentId: confirmation.targetDocumentId,
          scopeType: confirmation.scopeType,
          scopeId: confirmation.scopeId,
          baseVersionId: confirmation.baseVersionId,
          expectedDocumentRowVersion: confirmation.expectedDocumentRowVersion,
        });
        return {
          continuation: {
            previousResponseId: descriptor.providerResponseId,
            outputs: [{ callId: descriptor.callId, output }],
          },
        };
      })(),
    );
  }

  startProviderStep(identity: LlmGenerationIdentity): void {
    this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const task = this.requireTask(database, project.id, identity.generationId);
        const step = this.requireOpenStep(database, identity.attemptId);
        if (step.status === 'prepared') {
          database
            .prepare(
              "UPDATE llm_provider_steps SET status = 'in_flight' WHERE id = ? AND status = 'prepared'",
            )
            .run(step.id);
        }
        database
          .prepare(
            `UPDATE agent_tasks SET phase = 'model_running', updated_at = ?, row_version = row_version + 1
             WHERE id = ? AND status = 'running'`,
          )
          .run(new Date().toISOString(), task.id);
      })(),
    );
  }

  completeProviderStep(params: AgentProviderStepCompleteParams): void {
    this.projects.access(true, (database, project) =>
      database.transaction(() => {
        this.requireTask(database, project.id, params.generationId);
        const step = this.requireOpenStep(database, params.attemptId);
        this.completeStep(
          database,
          step,
          params.providerResponseId,
          0,
          params.usage,
          new Date().toISOString(),
          params.finishReason,
        );
      })(),
    );
  }

  terminateGeneration(generationId: string, reason: 'cancelled' | 'failed'): number {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const now = new Date().toISOString();
        const tasks = database
          .prepare(
            `SELECT tasks.id FROM agent_tasks tasks
             INNER JOIN agent_task_generations links ON links.task_id = tasks.id
             WHERE links.generation_id = ? AND tasks.project_id = ? AND tasks.status = 'running'`,
          )
          .all(generationId, project.id) as Array<{ id: string }>;
        for (const task of tasks) {
          database
            .prepare(
              `UPDATE agent_tasks SET status = ?, phase = 'recovering', error_code = ?,
               error_message = ?, completed_at = ?, updated_at = ?, row_version = row_version + 1
               WHERE id = ? AND status = 'running'`,
            )
            .run(reason, reason, `Provider generation ${reason}.`, now, now, task.id);
          database
            .prepare(
              `UPDATE agent_tool_authorizations SET status = 'revoked', revoked_at = ?,
               row_version = row_version + 1 WHERE task_id = ? AND status = 'issued'`,
            )
            .run(now, task.id);
          database
            .prepare(
              `UPDATE llm_provider_steps SET status = 'interrupted', completed_at = ?,
               error_code = ? WHERE generation_id = ? AND status IN ('prepared', 'in_flight')`,
            )
            .run(now, reason, generationId);
          database
            .prepare(
              `UPDATE agent_tool_calls SET status = 'cancelled', completed_at = ?, version = version + 1
               WHERE task_id = ? AND status IN ('received', 'validated', 'awaiting_confirmation', 'executing')`,
            )
            .run(now, task.id);
          database
            .prepare(
              `UPDATE agent_task_confirmations SET status = 'expired'
               WHERE task_id = ? AND status = 'pending'`,
            )
            .run(task.id);
          this.appendEvent(
            database,
            project.id,
            task.id,
            'agent.task.interrupted',
            `The Agent task stopped because its Provider generation was ${reason}.`,
            now,
          );
        }
        return tasks.length;
      })(),
    );
  }

  recoverInterrupted(): number {
    const generationIds = this.projects.access(
      false,
      (database, project) =>
        database
          .prepare(
            `SELECT DISTINCT links.generation_id
           FROM agent_task_generations links
           INNER JOIN agent_tasks tasks ON tasks.id = links.task_id
           INNER JOIN llm_generations generations ON generations.id = links.generation_id
           WHERE tasks.project_id = ? AND tasks.status = 'running'
             AND generations.status IN ('failed', 'cancelled')`,
          )
          .all(project.id) as Array<{ generation_id: string }>,
    );
    return generationIds.reduce(
      (count, generation) => count + this.terminateGeneration(generation.generation_id, 'failed'),
      0,
    );
  }

  private createStep(
    database: Database.Database,
    projectId: string,
    identity: LlmGenerationIdentity,
    taskId: string,
    ordinal: number,
    now: string,
    authorization: AuthorizationSpec,
  ): { stepId: string; authorizationHandle: string } {
    const stepId = randomUUID();
    const handle = randomBytes(32).toString('base64url');
    database
      .prepare(
        `INSERT INTO llm_provider_steps
         (id, project_id, generation_id, attempt_id, ordinal, protocol, status, tool_call_count,
          request_hash, started_at)
         SELECT ?, ?, ?, ?, ?, attempts.protocol, 'prepared', 0, ?, ?
         FROM llm_generation_attempts attempts WHERE attempts.id = ? AND attempts.generation_id = ?`,
      )
      .run(
        stepId,
        projectId,
        identity.generationId,
        identity.attemptId,
        ordinal,
        hash(TOOL_SCHEMA_VERSION),
        now,
        identity.attemptId,
        identity.generationId,
      );
    database
      .prepare(
        `INSERT INTO agent_tool_authorizations
         (id, project_id, task_id, generation_id, attempt_id, provider_step_id, project_session_id,
          allowed_operation, target_document_id, scope_type, scope_id, base_version_id,
          expected_document_row_version, policy_version, tool_schema_version,
          authorization_handle_hash, status, max_call_uses, used_call_count, expires_at,
          row_version, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', 1, 0, ?, 0, ?
         FROM agent_tasks WHERE id = ?`,
      )
      .run(
        randomUUID(),
        projectId,
        taskId,
        identity.generationId,
        identity.attemptId,
        stepId,
        identity.projectSessionId,
        authorization.operation,
        authorization.targetDocumentId ?? null,
        authorization.scopeType ?? null,
        authorization.scopeId ?? null,
        authorization.baseVersionId ?? null,
        authorization.expectedDocumentRowVersion ?? null,
        POLICY_VERSION,
        TOOL_SCHEMA_VERSION,
        hash(handle),
        new Date(Date.now() + AUTHORIZATION_TTL_MS).toISOString(),
        now,
        taskId,
      );
    return { stepId, authorizationHandle: handle };
  }

  private toolsFor(operation: AgentDocumentOperation): LlmToolDefinition[] {
    return DOCUMENT_AGENT_TOOLS.filter((tool) => tool.name === operation);
  }

  private reserveExecution(
    database: Database.Database,
    authorization: AuthorizationRow,
    taskId: string,
    now: string,
  ): void {
    const reserved = database
      .prepare(
        `UPDATE agent_tool_authorizations SET used_call_count = used_call_count + 1,
         row_version = row_version + 1 WHERE id = ? AND row_version = ?
         AND status = 'issued' AND used_call_count < max_call_uses`,
      )
      .run(authorization.id, authorization.row_version);
    if (reserved.changes !== 1) throw new Error('Tool authorization was already consumed.');
    const taskReserved = database
      .prepare(
        `UPDATE agent_tasks SET tool_call_count = tool_call_count + 1, phase = 'artifact_persisting',
         updated_at = ?, row_version = row_version + 1
         WHERE id = ? AND status = 'running' AND tool_call_count < tool_call_limit`,
      )
      .run(now, taskId);
    if (taskReserved.changes !== 1) throw new Error('Agent task tool-call quota is exhausted.');
  }

  private resolveAuthorization(
    database: Database.Database,
    projectId: string,
    conversation: ConversationRow,
    intent: AgentDocumentIntent,
  ): AuthorizationSpec {
    const operation = intent.operation;
    const targetRequired = new Set<AgentDocumentOperation>([
      'document.read',
      'document.update_draft',
      'document.archive',
      'document.restore',
    ]);
    if (targetRequired.has(operation) && !intent.documentId) {
      throw new Error(`${operation} requires an explicit document target.`);
    }
    if (!targetRequired.has(operation) && intent.documentId) {
      throw new Error(`${operation} does not accept a document target.`);
    }
    if (!intent.documentId) {
      return {
        operation,
        scopeType: conversation.scope_type,
        scopeId: conversation.scope_id ?? undefined,
      };
    }
    const document = database
      .prepare('SELECT * FROM documents WHERE id = ? AND project_id = ?')
      .get(intent.documentId, projectId) as
      | {
          id: string;
          lifecycle_status: string;
          scope_type: 'project' | 'scene' | 'shot';
          scope_id: string | null;
          current_version_id: string | null;
          row_version: number;
        }
      | undefined;
    if (!document) throw new Error('Authorized document was not found in the current project.');
    if (operation === 'document.restore' && document.lifecycle_status !== 'archived') {
      throw new Error('Only an archived document can be restored.');
    }
    if (operation !== 'document.restore' && document.lifecycle_status === 'archived') {
      throw new Error('Archived documents are not available for this operation.');
    }
    if (
      conversation.scope_type !== 'project' &&
      (document.scope_type !== conversation.scope_type ||
        document.scope_id !== conversation.scope_id)
    ) {
      throw new Error('Authorized document is outside the conversation scope.');
    }
    return {
      operation,
      targetDocumentId: document.id,
      scopeType: document.scope_type,
      scopeId: document.scope_id ?? undefined,
      baseVersionId: document.current_version_id ?? undefined,
      expectedDocumentRowVersion: document.row_version,
    };
  }

  private requireTask(database: Database.Database, projectId: string, generationId: string) {
    const task = database
      .prepare(
        `SELECT tasks.* FROM agent_tasks tasks
         INNER JOIN agent_task_generations links ON links.task_id = tasks.id
         WHERE links.generation_id = ? AND tasks.project_id = ?`,
      )
      .get(generationId, projectId) as
      | {
          id: string;
          scope_type: 'project' | 'scene' | 'shot';
          scope_id: string | null;
          user_message_id: string | null;
          context_snapshot_id: string | null;
        }
      | undefined;
    if (!task) throw new Error('Agent task was not found for the generation.');
    return task;
  }

  private requireActiveGeneration(
    database: Database.Database,
    projectId: string,
    identity: LlmGenerationIdentity,
  ): void {
    const row = database
      .prepare(
        `SELECT generations.status AS generation_status, attempts.status AS attempt_status
         FROM llm_generations generations
         INNER JOIN llm_generation_attempts attempts
           ON attempts.id = ? AND attempts.generation_id = generations.id
         WHERE generations.id = ? AND generations.project_id = ?
           AND generations.project_session_id = ?`,
      )
      .get(identity.attemptId, identity.generationId, projectId, identity.projectSessionId) as
      { generation_status: string; attempt_status: string } | undefined;
    if (
      !row ||
      !['prepared', 'streaming'].includes(row.generation_status) ||
      !['prepared', 'streaming'].includes(row.attempt_status)
    ) {
      throw new Error('Agent generation is no longer active.');
    }
  }

  private requireOpenStep(database: Database.Database, attemptId: string): StepRow {
    const step = database
      .prepare(
        `SELECT id, ordinal, status FROM llm_provider_steps
         WHERE attempt_id = ? AND status IN ('prepared', 'in_flight')
         ORDER BY ordinal DESC LIMIT 1`,
      )
      .get(attemptId) as StepRow | undefined;
    if (!step) throw new Error('No open Provider step exists for this attempt.');
    return step;
  }

  private completeStep(
    database: Database.Database,
    step: StepRow,
    providerResponseId: string | undefined,
    toolCallCount: number,
    usage: AgentProviderStepCompleteParams['usage'],
    now: string,
    finishReason = toolCallCount > 0 ? 'tool_calls' : 'completed',
    continuationManifestJson?: string,
  ): void {
    database
      .prepare(
        `UPDATE llm_provider_steps SET status = 'complete', provider_response_id = ?,
         tool_call_count = ?, finish_reason = ?, input_tokens = ?, cached_input_tokens = ?,
         output_tokens = ?, reasoning_tokens = ?, total_tokens = ?, provider_reported_cost = ?,
         currency = ?, continuation_manifest_json = ?, completed_at = ?
         WHERE id = ? AND status IN ('prepared', 'in_flight')`,
      )
      .run(
        providerResponseId ?? null,
        toolCallCount,
        finishReason,
        usage?.inputTokens ?? null,
        usage?.cachedInputTokens ?? null,
        usage?.outputTokens ?? null,
        usage?.reasoningTokens ?? null,
        usage?.totalTokens ?? null,
        usage?.providerReportedCost?.amount ?? null,
        usage?.providerReportedCost?.currency ?? null,
        continuationManifestJson ?? null,
        now,
        step.id,
      );
  }

  private appendEvent(
    database: Database.Database,
    projectId: string,
    taskId: string,
    type: string,
    summary: string,
    now: string,
  ): void {
    const next = database
      .prepare(
        'SELECT COALESCE(MAX(sequence), -1) + 1 AS value FROM agent_task_events WHERE task_id = ?',
      )
      .get(taskId) as { value: number };
    database
      .prepare(
        `INSERT INTO agent_task_events
         (id, task_id, project_id, sequence, event_type, level, actor_type, summary, created_at)
         VALUES (?, ?, ?, ?, ?, 'info', 'system', ?, ?)`,
      )
      .run(randomUUID(), taskId, projectId, next.value, type, summary, now);
  }
}

function parseToolArguments(
  operation: string,
  value: string,
): { title?: string; contentMarkdown?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('Tool arguments are not valid JSON.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Tool arguments must be an object.');
  const record = parsed as Record<string, unknown>;
  const needsContent =
    operation === 'document.create_draft' || operation === 'document.update_draft';
  if (
    needsContent &&
    Object.keys(record).some((key) => !['title', 'contentMarkdown'].includes(key))
  ) {
    throw new Error('Tool arguments contain unsupported fields.');
  }
  if (!needsContent && Object.keys(record).length > 0) {
    throw new Error('Tool arguments contain unsupported fields.');
  }
  if (
    needsContent &&
    (typeof record.title !== 'string' || typeof record.contentMarkdown !== 'string')
  ) {
    throw new Error('Tool title and contentMarkdown are required.');
  }
  if (!needsContent) return {};
  const rawTitle = record.title as string;
  const rawContent = record.contentMarkdown as string;
  const title = normalizeTitle(rawTitle);
  if (!rawContent.trim() || rawContent.length > 1_000_000) {
    throw new Error('Tool document content is invalid.');
  }
  return { title, contentMarkdown: rawContent };
}

function taskTypeFor(operation: AgentDocumentOperation): string {
  switch (operation) {
    case 'document.create_draft':
      return 'document-create';
    case 'document.update_draft':
      return 'document-update';
    case 'document.list':
    case 'document.read':
      return 'document-query';
    case 'document.archive':
      return 'document-archive';
    case 'document.restore':
      return 'document-restore';
  }
  throw new Error('Unsupported document operation.');
}

function normalizeTitle(value: string): string {
  const title = value.normalize('NFC').trim();
  if (!title || title.length > 200) throw new Error('Agent document title is invalid.');
  return title;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
