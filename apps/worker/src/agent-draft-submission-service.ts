import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  DocumentBindingRole,
  DocumentKind,
  NovelWritingAction,
  ProjectContentIR,
} from '@ai-video/contracts';
import { rebuildLibraryChunksForDocument } from '@ai-video/persistence';
import { AgentOrchestrationService } from './agent-orchestration-service.js';
import { DocumentWorkflowService } from './document-workflow-service.js';
import { ProjectService } from './project-service.js';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import { linkResearchCitations } from './agent-research-citations.js';
import {
  documentWorkspace,
  RESOURCE_ARGUMENT_KEYS,
  resolveWriteResource,
} from './project-resource-map.js';

const KINDS = new Set<DocumentKind>([
  'outline',
  'plan',
  'character',
  'scene',
  'prop',
  'storyboard',
  'note',
]);
const ROLES = new Set<DocumentBindingRole>([
  'work-outline',
  'character-bible',
  'world-bible',
  'timeline',
  'style-guide',
]);

type ParentTask = {
  id: string;
  project_id: string;
  project_session_id: string;
  conversation_id: string;
  user_message_id: string | null;
  context_snapshot_id: string | null;
  scope_type: 'project' | 'scene' | 'shot';
  scope_id: string | null;
  request_snapshot_json: string;
};

/** One model submission owns one reviewable artifact. The conversation stays runnable. */
export class AgentDraftSubmissionService {
  constructor(
    private readonly projects: ProjectService,
    private readonly documents: DocumentWorkflowService,
  ) {}

  submit(
    operation: 'document.submit_draft' | 'novel.chapter.write_draft',
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
    artifactKey = identity.toolCallId,
  ): Record<string, unknown> {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const parent = this.requireParent(database, identity);
        const resource = resolveWriteResource(database, project, args)!;
        const title = text(args.title, 'title', 200);
        const contentMarkdown = text(args.contentMarkdown, 'contentMarkdown', 1_000_000);
        const contentIR = args.contentIR as ProjectContentIR | undefined;
        const requestHash = createHash('sha256')
          .update(JSON.stringify({ operation, args }))
          .digest('hex');
        const snapshot = {
          version: 1,
          source: 'model-tool',
          parentTaskId: parent.id,
          parentToolCallId: identity.toolCallId,
          operation,
          resourceId: resource.id,
          workspace: resource.locator.workspace,
          ...(args.bindingRole !== undefined ? { bindingRole: args.bindingRole } : {}),
          title,
          contentHash: createHash('sha256').update(contentMarkdown).digest('hex'),
          contentLength: Buffer.byteLength(contentMarkdown, 'utf8'),
          modelSelection: (JSON.parse(parent.request_snapshot_json) as Record<string, unknown>)
            .modelSelection,
        };
        const now = new Date().toISOString();
        let taskId: string;
        let chapterId: string | undefined;
        let documentId: string | undefined;
        let expectedDocumentRowVersion: number | undefined;
        let baseVersionId: string | null = null;
        let kind: DocumentKind = 'note';
        if (operation === 'novel.chapter.write_draft') {
          keys(args, [
            ...RESOURCE_ARGUMENT_KEYS,
            'documentId',
            'action',
            'chapterId',
            'volumeId',
            'displayLabel',
            'title',
            'contentMarkdown',
            'expectedChapterRowVersion',
            'expectedDocumentRowVersion',
            'baseVersionId',
          ]);
          const action = text(args.action, 'action', 40) as NovelWritingAction;
          if (!['create_chapter', 'continue_chapter', 'rewrite_chapter'].includes(action))
            throw new Error('Invalid chapter action.');
          if (action === 'create_chapter') {
            if (resource.kind !== 'workspace' || resource.locator.workspace !== 'novel')
              throw new Error('New novel chapters require the 小说 workspace resourceId.');
            if (
              args.chapterId !== undefined ||
              args.documentId !== undefined ||
              args.expectedChapterRowVersion !== undefined ||
              args.expectedDocumentRowVersion !== undefined ||
              args.baseVersionId !== undefined
            )
              throw new Error('New chapters cannot specify an existing target or CAS.');
          } else {
            if (args.volumeId !== undefined || args.displayLabel !== undefined)
              throw new Error(
                'Existing chapter submissions cannot move or relabel chapters. Use novel.chapter.update_metadata for title/displayLabel changes without rewriting the body.',
              );
            chapterId = text(args.chapterId, 'chapterId', 200);
            const chapter = database
              .prepare(
                `SELECT chapters.document_id, chapters.row_version, documents.row_version AS document_row_version, documents.current_version_id
            FROM novel_chapters chapters JOIN documents ON documents.id = chapters.document_id
            WHERE chapters.id = ? AND chapters.project_id = ? AND chapters.lifecycle_status IN ('active', 'reserved') AND documents.lifecycle_status = 'active'`,
              )
              .get(chapterId, project.id) as
              | {
                  row_version: number;
                  document_id: string;
                  document_row_version: number;
                  current_version_id: string | null;
                }
              | undefined;
            if (!chapter) throw new Error('Writable chapter was not found in the current project.');
            if (
              resource.documentId !== chapter.document_id ||
              resource.locator.workspace !== 'novel'
            )
              throw new Error('chapterId does not match the chapter resourceId.');
            if (integer(args.expectedChapterRowVersion) !== chapter.row_version)
              throw new Error('Chapter row version is stale.');
            expectedDocumentRowVersion = integer(args.expectedDocumentRowVersion);
            baseVersionId = nullableId(args.baseVersionId);
            if (
              expectedDocumentRowVersion !== chapter.document_row_version ||
              baseVersionId !== chapter.current_version_id
            )
              throw new Error('Document row/base version is stale.');
          }
          const orchestration = new AgentOrchestrationService(this.projects);
          const prepared = orchestration.prepareNovelTask({
            conversationId: parent.conversation_id,
            projectSessionId: identity.projectSessionId,
            prompt: title,
            title,
            structured: true,
            idempotencyKey: `model-tool:${artifactKey}`,
            intent: {
              action,
              chapterId,
              chapterTitle: title,
              ...(args.volumeId !== undefined
                ? { volumeId: text(args.volumeId, 'volumeId', 200) }
                : {}),
              ...(args.displayLabel !== undefined
                ? { displayLabel: text(args.displayLabel, 'displayLabel', 80) }
                : {}),
            },
          });
          if ('pendingIntent' in prepared)
            throw new Error('Structured chapter submission cannot return pending intent.');
          taskId = prepared.taskId;
          chapterId = prepared.chapterId;
          documentId = prepared.documentId;
          if (action === 'create_chapter') expectedDocumentRowVersion = 0;
          database
            .prepare(
              `UPDATE agent_tasks SET user_message_id = ?, context_snapshot_id = ?, request_snapshot_json = ?, request_hash = ? WHERE id = ?`,
            )
            .run(
              parent.user_message_id,
              parent.context_snapshot_id,
              JSON.stringify({
                ...snapshot,
                action,
                chapterId,
                documentId,
                expectedDocumentRowVersion,
                baseVersionId,
              }),
              requestHash,
              taskId,
            );
          orchestration.markTaskGenerationStarted(taskId);
        } else {
          keys(args, [
            ...RESOURCE_ARGUMENT_KEYS,
            'title',
            'contentMarkdown',
            'contentIR',
            'documentKind',
            'documentId',
            'expectedDocumentRowVersion',
            'baseVersionId',
            'bindingRole',
          ]);
          kind = text(args.documentKind, 'documentKind', 30) as DocumentKind;
          if (!KINDS.has(kind)) throw new Error('Invalid documentKind.');
          if (args.documentId !== undefined) {
            documentId = text(args.documentId, 'documentId', 200);
            const target = database
              .prepare(
                `SELECT kind FROM documents WHERE id = ? AND project_id = ? AND lifecycle_status = 'active'
            AND NOT EXISTS (SELECT 1 FROM novel_chapters WHERE document_id = documents.id)`,
              )
              .get(documentId, project.id) as { kind: string } | undefined;
            if (!target)
              throw new Error(
                'Writable project document was not found; chapters require novel.chapter.write_draft.',
              );
            if (target.kind !== kind)
              throw new Error('Document kind does not match the existing target.');
            if (resource.documentId !== documentId)
              throw new Error('Existing documents require their actual document resourceId.');
            if (args.bindingRole !== undefined)
              throw new Error('Binding roles can only be set on new documents.');
            expectedDocumentRowVersion = integer(args.expectedDocumentRowVersion);
            baseVersionId = nullableId(args.baseVersionId);
          } else if (
            args.expectedDocumentRowVersion !== undefined ||
            args.baseVersionId !== undefined
          )
            throw new Error('New documents cannot specify CAS for an existing target.');
          if (args.documentId === undefined) {
            if (kind === 'storyboard')
              throw new Error(
                'Standalone storyboard documents are not visible in the scene/shot directory. Use scene.submit_structure with workspace:shots to save editable scene and shot drafts without user confirmation.',
              );
            if (resource.kind !== 'workspace')
              throw new Error(
                'New documents require a workspace resourceId; existing resources require documentId and CAS.',
              );
            const workspace = documentWorkspace({
              chapter_id: null,
              domain_scope: args.bindingRole !== undefined ? 'novel' : null,
              kind,
            });
            if (resource.locator.workspace === 'novel' && args.bindingRole === undefined)
              throw new Error(
                'Novel outlines/settings require bindingRole so they appear in 小说参考资料.',
              );
            if (resource.locator.workspace !== workspace)
              throw new Error(
                'The destination resourceId does not match documentKind/bindingRole. Choose the matching page from project.structure.get.',
              );
          }
          if (
            args.bindingRole !== undefined &&
            !ROLES.has(text(args.bindingRole, 'bindingRole', 80) as DocumentBindingRole)
          )
            throw new Error('Invalid novel reference binding role.');
          taskId = randomUUID();
          database
            .prepare(
              `INSERT INTO agent_tasks
          (id, project_id, project_session_id, conversation_id, user_message_id, context_snapshot_id,
           task_type, scope_type, scope_id, title, request_snapshot_json, request_hash, status, phase,
           idempotency_key, created_at, started_at, updated_at, row_version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', 'model_running', ?, ?, ?, ?, 0)`,
            )
            .run(
              taskId,
              project.id,
              identity.projectSessionId,
              parent.conversation_id,
              parent.user_message_id,
              parent.context_snapshot_id,
              documentId ? 'document-update' : 'document-create',
              parent.scope_type,
              parent.scope_id,
              title,
              JSON.stringify({
                ...snapshot,
                documentId,
                documentKind: kind,
                expectedDocumentRowVersion,
                baseVersionId,
              }),
              requestHash,
              `model-tool:${artifactKey}`,
              now,
              now,
              now,
            );
        }
        const common = {
          taskId,
          title,
          contentMarkdown,
          contentIR,
          kind,
          scopeType: parent.scope_type,
          scopeId: parent.scope_id ?? undefined,
          sourceMessageId: parent.user_message_id ?? undefined,
          contextSnapshotId: parent.context_snapshot_id ?? undefined,
        };
        const document = documentId
          ? this.documents.writeTrustedAgentUpdateInTransaction(database, project, {
              ...common,
              documentId,
              expectedDocumentRowVersion: expectedDocumentRowVersion!,
              baseVersionId,
            })
          : this.documents.writeTrustedAgentDraftInTransaction(database, project, common);
        if (chapterId)
          database
            .prepare(
              `UPDATE novel_chapters SET lifecycle_status = 'active', archive_reason = NULL, row_version = row_version + 1, updated_at = ? WHERE id = ?`,
            )
            .run(now, chapterId);
        if (args.bindingRole !== undefined)
          database
            .prepare(
              `INSERT INTO document_bindings
        (id, project_id, document_id, role, domain_scope, status, row_version, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'novel', 'active', 0, ?, ?)`,
            )
            .run(randomUUID(), project.id, document.id, args.bindingRole, now, now);
        rebuildLibraryChunksForDocument(database, project.id, document.id, now);
        linkResearchCitations(
          database,
          project.id,
          parent.id,
          document.currentVersion!.id,
          contentMarkdown,
          now,
        );
        return {
          version: 1,
          status: 'draft_saved',
          taskId,
          parentTaskId: parent.id,
          ...(chapterId ? { chapterId } : {}),
          documentId: document.id,
          documentVersionId: document.currentVersion!.id,
          documentRowVersion: document.rowVersion,
          resourceId: `document:${document.id}`,
          locator: {
            workspace: resource.locator.workspace,
            resourceId: `document:${document.id}`,
            documentId: document.id,
            versionId: document.currentVersion!.id,
          },
          ...(resource.locator.workspace === 'novel'
            ? {
                domainScope: 'novel',
                ...(args.bindingRole !== undefined ? { bindingRole: args.bindingRole } : {}),
              }
            : {}),
          reviewRequired: false,
        };
      })(),
    );
  }

  private requireParent(
    database: Database.Database,
    identity: AgentSystemToolIdentity,
  ): ParentTask {
    const parent = database
      .prepare(
        `SELECT tasks.* FROM agent_tasks tasks JOIN agent_tool_calls calls ON calls.task_id = tasks.id
      WHERE tasks.id = ? AND tasks.project_id = ? AND tasks.project_session_id = ? AND tasks.conversation_id = ?
        AND tasks.status = 'running' AND tasks.phase = 'model_running' AND calls.id = ? AND calls.status = 'executing'`,
      )
      .get(
        identity.taskId,
        identity.projectId,
        identity.projectSessionId,
        identity.conversationId,
        identity.toolCallId,
      ) as ParentTask | undefined;
    if (!parent)
      throw new Error('Draft submission requires a trusted executing conversation tool call.');
    return parent;
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum)
    throw new Error(`Invalid ${label}.`);
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Expected a non-negative row version.');
  return value;
}
function nullableId(value: unknown): string | null {
  if (value === null) return null;
  return text(value, 'baseVersionId', 200);
}
function keys(args: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(args).some((key) => !allowed.includes(key)))
    throw new Error('Unsupported draft argument.');
}
