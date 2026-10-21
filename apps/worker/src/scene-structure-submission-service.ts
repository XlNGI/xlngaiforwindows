import type { AgentChangeSetItemDraft } from '@ai-video/contracts';
import { randomUUID } from 'node:crypto';
import { validateToolArguments } from '@earendil-works/pi-ai';
import { SYSTEM_AGENT_TOOLS } from './agent-tool-definitions.js';
import { boundedValidationError } from './agent-provider-tool-gateway.js';
import { ChangeSetService } from './change-set-service.js';
import { parseEpisodeStructureArguments, validateEpisodeReferences } from './episode-structure.js';
import { resolveWriteResource } from './project-resource-map.js';
import { ProjectService } from './project-service.js';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import { inspectProductionTargetInstruction } from '@ai-video/generation-adapters';
import {
  renderProductionInstruction,
  normalizeProductionAuthoringArguments,
  type ProductionInstruction,
} from '@ai-video/contracts';
import { requireProductionSceneDocument } from './scene-document-binding.js';
import { requireProductionCharacters } from './scene-cast-binding.js';
import {
  ProductionService,
  summarizeProductionReadiness,
  summarizeProductionNotices,
} from './production-service.js';

export class SceneStructureSubmissionService {
  constructor(private readonly projects: ProjectService) {}

  private readiness(sceneIds: string[]) {
    const production = new ProductionService(this.projects);
    const reads = sceneIds.map((id) => ({ id, read: production.read({ kind: 'scene', id }) }));
    const issues = reads.flatMap(({ id, read }) =>
      read.issues.map((issue) => ({ ...issue, sceneId: id })),
    );
    return {
      ...summarizeProductionReadiness(issues),
      ...summarizeProductionNotices(reads.flatMap(({ read }) => read.notices ?? [])),
    };
  }

  stage(args: Record<string, unknown>, identity: AgentSystemToolIdentity): Record<string, unknown> {
    args = normalizeProductionAuthoringArguments('scene.structure.stage', args) as Record<
      string,
      unknown
    >;
    try {
      validateToolArguments(
        SYSTEM_AGENT_TOOLS.find((tool) => tool.name === 'scene.structure.stage')!,
        { type: 'toolCall', id: 'stage', name: 'scene.structure.stage', arguments: args },
      );
    } catch (error) {
      throw new Error(boundedValidationError(error));
    }
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const parent = database
          .prepare(
            `SELECT 1 FROM agent_tasks t JOIN agent_tool_calls c ON c.task_id=t.id
        WHERE t.id=? AND t.project_id=? AND t.project_session_id=? AND t.conversation_id=? AND t.status='running'
        AND c.id=? AND c.status='executing' AND c.tool_name='scene.structure.stage'`,
          )
          .get(
            identity.taskId,
            project.id,
            identity.projectSessionId,
            identity.conversationId,
            identity.toolCallId,
          );
        if (!parent) throw new Error('Scene staging requires an executing authorized tool call.');
        type Part = {
          count: number;
          scene?: Record<string, unknown>;
          shots: Array<Record<string, unknown> | null>;
          sources?: Array<{ documentId: string; versionId: string | null; status: string }>;
          saved?: { changeSetId: string; sceneId: string; shotIds: string[] };
        };
        type Stage = {
          id: string;
          title: string;
          row_version: number;
          scenes_json: string;
          change_set_id: string | null;
        };
        const now = new Date().toISOString();
        let row: Stage | undefined;
        if (args.operation === 'get' && args.stageId === undefined) {
          const stages = database
            .prepare(
              `SELECT id AS stageId,title,row_version AS rowVersion,change_set_id AS changeSetId
          FROM scene_structure_stages WHERE project_id=? AND conversation_id=? AND change_set_id IS NULL ORDER BY updated_at DESC LIMIT 20`,
            )
            .all(project.id, identity.conversationId);
          return { status: 'scene_structure_stages', stages, applied: false };
        }
        if (args.operation === 'begin') {
          if (
            typeof args.executionKey !== 'string' ||
            typeof args.episodeTitle !== 'string' ||
            !Array.isArray(args.sceneShotCounts)
          )
            throw new Error('begin requires executionKey, episodeTitle and sceneShotCounts.');
          const counts = args.sceneShotCounts as number[];
          if (counts.reduce((total, count) => total + count + 1, 0) > 100)
            throw new Error('sceneShotCounts exceeds 100 total scene + shot items.');
          row = database
            .prepare(
              'SELECT * FROM scene_structure_stages WHERE project_id=? AND conversation_id=? AND execution_key=?',
            )
            .get(project.id, identity.conversationId, args.executionKey) as Stage | undefined;
          if (row) {
            const parts = JSON.parse(row.scenes_json) as Part[];
            if (
              row.title !== args.episodeTitle ||
              JSON.stringify(parts.map((part) => part.count)) !== JSON.stringify(counts)
            )
              throw new Error('STAGE_EXECUTION_KEY_CONFLICT');
          } else {
            const parts: Part[] = counts.map((count) => ({
              count,
              shots: Array<Record<string, unknown> | null>(count).fill(null),
            }));
            const id = randomUUID();
            database
              .prepare(
                `INSERT INTO scene_structure_stages(id,project_id,conversation_id,execution_key,title,expected_scene_count,scenes_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                id,
                project.id,
                identity.conversationId,
                args.executionKey,
                args.episodeTitle,
                counts.length,
                JSON.stringify(parts),
                now,
                now,
              );
            row = {
              id,
              title: args.episodeTitle,
              row_version: 0,
              scenes_json: JSON.stringify(parts),
              change_set_id: null,
            };
          }
        } else {
          row = database
            .prepare(
              'SELECT * FROM scene_structure_stages WHERE id=? AND project_id=? AND conversation_id=?',
            )
            .get(args.stageId, project.id, identity.conversationId) as Stage | undefined;
        }
        if (!row) throw new Error('Stage not found in this conversation.');
        // Reserve only the existing hard limit; larger plans resume in another turn.
        database
          .prepare('UPDATE agent_tasks SET tool_call_limit=32 WHERE id=? AND tool_call_limit<32')
          .run(identity.taskId);
        const parts = JSON.parse(row.scenes_json) as Part[];
        const describe = (savedSceneThisCall = false) => {
          const changes = new ChangeSetService(this.projects);
          // Pre-upgrade completed stages have one change set and no per-part receipts.
          let saved =
            row.change_set_id && !parts.some((part) => part.saved)
              ? changes.get(row.change_set_id)
              : undefined;
          if (
            saved &&
            ['proposed', 'partially_applied'].includes(saved.status) &&
            saved.items.some((item) => item.status === 'pending')
          )
            saved = changes.apply({ changeSetId: saved.id, expectedRowVersion: saved.rowVersion });
          const sceneIds =
            saved?.items
              .filter((item) => item.entityType === 'scene' && item.status === 'applied')
              .map((item) => item.appliedEntityId!) ??
            parts.flatMap((part) => (part.saved ? [part.saved.sceneId] : []));
          const shotIds =
            saved?.items
              .filter((item) => item.entityType === 'shot' && item.status === 'applied')
              .map((item) => item.appliedEntityId!) ??
            parts.flatMap((part) => part.saved?.shotIds ?? []);
          const complete = saved?.status === 'applied' || parts.every((part) => part.saved);
          const referenceChanges = parts.flatMap((part, sceneIndex) =>
            (part.sources ?? []).flatMap((source) => {
              const current = database
                .prepare(
                  "SELECT current_version_id FROM documents WHERE id=? AND project_id=? AND lifecycle_status='active'",
                )
                .get(source.documentId, project.id) as
                { current_version_id: string | null } | undefined;
              return current?.current_version_id === source.versionId
                ? []
                : [
                    {
                      sceneIndex,
                      documentId: source.documentId,
                      versionId: source.versionId,
                      currentVersionId: current?.current_version_id ?? null,
                    },
                  ];
            }),
          );
          const budget = database
            .prepare('SELECT tool_call_count,tool_call_limit FROM agent_tasks WHERE id=?')
            .get(identity.taskId) as { tool_call_count: number; tool_call_limit: number };
          const nextSceneIndex = parts.findIndex((part) => !part.saved);
          const selected = typeof args.sceneIndex === 'number' ? parts[args.sceneIndex] : undefined;
          return {
            status: saved
              ? saved.status === 'applied'
                ? 'scene_structure_saved'
                : 'scene_structure_conflicted'
              : complete
                ? 'scene_structure_saved'
                : sceneIds.length
                  ? 'scene_structure_partially_saved'
                  : 'scene_structure_staging',
            complete,
            stageId: row.id,
            stageOperation: args.operation,
            savedSceneThisCall,
            rowVersion: row.row_version,
            changeSetId: row.change_set_id,
            applied: sceneIds.length > 0,
            checkpointReady: parts.some(
              (part) => part.saved || part.scene || part.shots.some(Boolean),
            ),
            reviewRequired: false,
            sceneIds,
            shotIds,
            changeSetIds: saved
              ? [saved.id]
              : parts.flatMap((part) => (part.saved ? [part.saved.changeSetId] : [])),
            ...(sceneIds.length ? this.readiness(sceneIds) : {}),
            businessCallsRemaining: budget.tool_call_limit - budget.tool_call_count,
            minimumRemainingWrites: parts.reduce((sum, part) => {
              if (part.saved) return sum;
              const missingShots = part.shots.filter((shot) => !shot).length;
              const writes = (part.scene ? 0 : 1) + Math.ceil(missingShots / 4);
              return sum + (writes || 1);
            }, 0),
            nextSceneIndex: complete ? undefined : nextSceneIndex,
            referenceChanges: referenceChanges.slice(0, 5),
            referenceChangesTruncated: referenceChanges.length > 5,
            ...(selected
              ? {
                  sources: selected.sources ?? [],
                  bindings: selected.scene
                    ? {
                        sceneDocumentId: selected.scene.sceneDocumentId,
                        characterDocumentIds: selected.scene.characterDocumentIds,
                      }
                    : undefined,
                  previousSaved: parts
                    .slice(0, args.sceneIndex as number)
                    .filter((part) => part.saved)
                    .at(-1)?.saved,
                }
              : {}),
            scenes: parts.map((part, index) => ({
              index,
              setupSaved: Boolean(part.scene),
              expectedShots: part.count,
              missingShots: part.shots.flatMap((shot, offset) => (shot ? [] : [offset])),
              sceneId: part.saved?.sceneId,
              shotIds: part.saved?.shotIds,
            })),
          };
        };
        if (args.operation === 'get' || args.operation === 'begin') return describe();
        if (row.change_set_id && !parts.some((part) => part.saved)) {
          if (args.operation === 'finalize' || args.operation === 'checkpoint') return describe();
          throw new Error('Finalized stages are immutable.');
        }
        const before = JSON.stringify(parts);
        if (args.operation === 'put_scene' || args.operation === 'put_shots') {
          const part = parts[Number(args.sceneIndex)];
          if (!part) throw new Error('sceneIndex is outside the manifest.');
          if (args.operation === 'put_scene') {
            if (!args.scene || typeof args.scene !== 'object')
              throw new Error('put_scene requires scene.');
            if (JSON.stringify(part.scene) === JSON.stringify(args.scene)) return describe();
            if (part.saved)
              throw new Error(
                'STAGE_SCENE_ALREADY_SAVED: revise the returned sceneId with its current CAS; do not recreate it.',
              );
            part.scene = structuredClone(args.scene as Record<string, unknown>);
            const instruction = part.scene.instruction as ProductionInstruction;
            const issues = inspectProductionTargetInstruction(instruction, 'scene');
            if (issues.length) throw new Error(issues.map((issue) => issue.message).join('\n'));
            if (renderProductionInstruction(instruction).length > 20000)
              throw new Error('scene.instruction renders beyond 20000 characters.');
            requireProductionSceneDocument(
              database,
              project.id,
              part.scene.sceneDocumentId as string,
            );
            requireProductionCharacters(database, project.id, part.scene.characterDocumentIds);
            const ids = [part.scene.sceneDocumentId as string, ...part.scene.characterDocumentIds];
            part.sources = [...new Set(ids)].map((documentId) => {
              const document = database
                .prepare(
                  'SELECT current_version_id,published_version_id FROM documents WHERE id=? AND project_id=?',
                )
                .get(documentId, project.id) as {
                current_version_id: string | null;
                published_version_id: string | null;
              };
              return {
                documentId,
                versionId: document.current_version_id,
                status:
                  document.current_version_id === document.published_version_id
                    ? 'published'
                    : 'draft',
              };
            });
          } else {
            if (!part.scene) throw new Error('Save shared scene setup before shots.');
            const offset = Number(args.shotOffset);
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Array.isArray(args.shots) ||
              offset + args.shots.length > part.count
            )
              throw new Error('shotOffset/shots exceeds the manifest.');
            if (
              JSON.stringify(part.shots.slice(offset, offset + args.shots.length)) ===
              JSON.stringify(args.shots)
            )
              return describe();
            if (part.saved)
              throw new Error(
                'STAGE_SCENE_ALREADY_SAVED: revise the returned real shot IDs with current CAS.',
              );
            args.shots.forEach((shot, index) => {
              part.shots[offset + index] = shot as Record<string, unknown>;
            });
            parseEpisodeStructureArguments(
              JSON.stringify({
                episodeTitle: row.title,
                scenes: [{ ...part.scene, shots: args.shots }],
              }),
              true,
            );
          }
          if (before === JSON.stringify(parts)) return describe();
        } else if (!['finalize', 'checkpoint'].includes(String(args.operation)))
          throw new Error('Unsupported staging operation.');
        if (
          args.operation === 'checkpoint' &&
          !parts.some((part) => part.saved || part.scene || part.shots.some(Boolean))
        )
          throw new Error(
            'STAGE_CHECKPOINT_EMPTY: checkpoint requires saved or substantively staged scene content.',
          );
        const observed =
          args.expectedRowVersion === undefined
            ? (database
                .prepare(
                  `SELECT json_extract(result_summary_json,'$.rowVersion') AS version
              FROM agent_tool_calls WHERE task_id=? AND tool_name='scene.structure.stage'
                AND status='succeeded' AND json_extract(result_summary_json,'$.stageId')=?
              ORDER BY rowid DESC LIMIT 1`,
                )
                .get(identity.taskId, row.id) as { version: number } | undefined)
            : undefined;
        const expectedVersion = args.expectedRowVersion ?? observed?.version;
        if (expectedVersion === undefined)
          throw new Error(
            'STAGE_VERSION_REQUIRED: get this stage in the current task before writing, or supply expectedRowVersion.',
          );
        if (expectedVersion !== row.row_version) throw new Error('STAGE_ROW_VERSION_CONFLICT');
        if (Buffer.byteLength(JSON.stringify(parts)) > 1024 * 1024)
          throw new Error('Stage exceeds 1 MiB.');
        // Commit at most one complete scene per call, in manifest order. Each
        // call is its own outer transaction, so a later scene failure cannot
        // roll back an earlier scene saved by a prior call.
        const ready = parts.find((part) => !part.saved);
        let savedSceneThisCall = false;
        if (ready?.scene && ready.shots.every((shot) => shot)) {
          const result = this.submit(
            {
              resourceId: 'workspace:shots',
              resolution: 'resolved',
              episodeTitle: row.title,
              scenes: [{ ...ready.scene, shots: ready.shots }],
            },
            identity,
          );
          ready.saved = {
            changeSetId: result.changeSetId as string,
            sceneId: (result.sceneIds as string[])[0]!,
            shotIds: result.shotIds as string[],
          };
          savedSceneThisCall = true;
        }
        if (before === JSON.stringify(parts)) {
          const result = describe();
          return args.operation === 'checkpoint' && !result.complete
            ? { ...result, status: 'scene_structure_checkpointed', checkpointed: true }
            : result;
        }
        if (parts.every((part) => part.saved)) row.change_set_id = parts.at(-1)!.saved!.changeSetId;
        database
          .prepare(
            'UPDATE scene_structure_stages SET scenes_json=?,change_set_id=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?',
          )
          .run(JSON.stringify(parts), row.change_set_id, now, row.id, row.row_version);
        row.row_version += 1;
        const result = describe();
        return args.operation === 'checkpoint' && !result.complete
          ? { ...result, status: 'scene_structure_checkpointed', checkpointed: true }
          : { ...result, savedSceneThisCall };
      })(),
    );
  }

  submit(
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    args = normalizeProductionAuthoringArguments('scene.submit_structure', args) as Record<
      string,
      unknown
    >;
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        if (
          Object.keys(args).some(
            (key) =>
              ![
                'resourceId',
                'expectedRevision',
                'episodeTitle',
                'scenes',
                'resolution',
                'feedback',
              ].includes(key),
          )
        )
          throw new Error('Unsupported scene structure argument.');
        const parent = database
          .prepare(
            `SELECT tasks.id FROM agent_tasks tasks
        JOIN agent_tool_calls calls ON calls.task_id = tasks.id
        WHERE tasks.id = ? AND tasks.project_id = ? AND tasks.project_session_id = ?
        AND tasks.conversation_id = ? AND tasks.status = 'running' AND tasks.phase = 'model_running'
        AND calls.id = ? AND calls.status = 'executing'`,
          )
          .get(
            identity.taskId,
            project.id,
            identity.projectSessionId,
            identity.conversationId,
            identity.toolCallId,
          );
        if (!parent)
          throw new Error(
            'Scene structure submission requires an executing conversation tool call.',
          );
        const resource = resolveWriteResource(database, project, args)!;
        if (resource.kind !== 'workspace' || resource.locator.workspace !== 'shots')
          throw new Error(
            'New scenes and shots require workspace:shots from project.structure.get.',
          );
        if (args.resolution === 'needs_clarification') {
          if (
            typeof args.feedback !== 'string' ||
            !args.feedback.trim() ||
            args.feedback.length > 4000 ||
            !Array.isArray(args.scenes) ||
            args.scenes.length
          )
            throw new Error('Clarification requires feedback and no proposed scenes.');
          return {
            status: 'scene_bindings_need_clarification',
            feedback: args.feedback,
            applied: false,
            reviewRequired: false,
            resourceId: 'workspace:shots',
            locator: resource.locator,
          };
        }
        if (args.resolution !== 'resolved')
          throw new Error('Provide resolution: resolved or needs_clarification.');
        const structure = parseEpisodeStructureArguments(
          JSON.stringify({ episodeTitle: args.episodeTitle, scenes: args.scenes }),
          true,
        );
        validateEpisodeReferences(database, project.id, structure);
        const items: AgentChangeSetItemDraft[] = [];
        for (const scene of structure.scenes) {
          const parentItemOrdinal = items.length;
          items.push({
            entityType: 'scene',
            action: scene.sceneId ? 'update' : 'create',
            ...(scene.sceneId
              ? { targetId: scene.sceneId, expectedRowVersion: scene.expectedRowVersion }
              : {}),
            title: scene.title,
            sceneDocumentId: scene.sceneDocumentId,
            videoPrompt: scene.videoPrompt,
            characterDocumentIds: scene.characterDocumentIds,
            instruction: scene.instruction,
          });
          for (const shot of scene.shots)
            items.push({ entityType: 'shot', action: 'create', parentItemOrdinal, ...shot });
        }
        const proposal = new ChangeSetService(this.projects).saveDraft({
          taskId: identity.taskId,
          title: structure.episodeTitle,
          items,
        });
        const sceneIds = proposal.items
          .filter((item) => item.entityType === 'scene')
          .map((item) => item.appliedEntityId!);
        return {
          version: 1,
          status: 'scene_structure_saved',
          taskId: identity.taskId,
          changeSetId: proposal.id,
          resourceId: 'workspace:shots',
          locator: { ...resource.locator, changeSetId: proposal.id },
          sceneCount: structure.scenes.length,
          shotCount: items.length - structure.scenes.length,
          reviewRequired: false,
          applied: true,
          sceneIds,
          ...this.readiness(sceneIds),
          shotIds: proposal.items
            .filter((item) => item.entityType === 'shot')
            .map((item) => item.appliedEntityId),
          nextAction:
            'Saved as editable drafts in 场次与镜头. The user can edit prompts and bindings later.',
        };
      })(),
    );
  }
}
