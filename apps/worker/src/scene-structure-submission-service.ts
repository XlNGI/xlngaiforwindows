import type { AgentChangeSetItemDraft } from '@ai-video/contracts';
import { ChangeSetService } from './change-set-service.js';
import { parseEpisodeStructureArguments, validateEpisodeReferences } from './episode-structure.js';
import { resolveWriteResource } from './project-resource-map.js';
import { ProjectService } from './project-service.js';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';

export class SceneStructureSubmissionService {
  constructor(private readonly projects: ProjectService) {}

  submit(
    args: Record<string, unknown>,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        if (
          Object.keys(args).some(
            (key) => !['resourceId', 'expectedRevision', 'episodeTitle', 'scenes'].includes(key),
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
        const structure = parseEpisodeStructureArguments(
          JSON.stringify({ episodeTitle: args.episodeTitle, scenes: args.scenes }),
        );
        validateEpisodeReferences(database, project.id, structure);
        if (structure.scenes.some((scene) => !scene.sceneDocumentId))
          throw new Error(
            'Each scene requires sceneDocumentId from the production scene resources on 角色与场景. Create the scene prompt document first if necessary.',
          );
        const items: AgentChangeSetItemDraft[] = [];
        for (const scene of structure.scenes) {
          const parentItemOrdinal = items.length;
          items.push({
            entityType: 'scene',
            action: 'create',
            title: scene.title,
            sceneDocumentId: scene.sceneDocumentId,
          });
          for (const shot of scene.shots)
            items.push({ entityType: 'shot', action: 'create', parentItemOrdinal, ...shot });
        }
        const proposal = new ChangeSetService(this.projects).create({
          taskId: identity.taskId,
          title: structure.episodeTitle,
          items,
        });
        return {
          version: 1,
          status: 'scene_structure_proposed',
          taskId: identity.taskId,
          changeSetId: proposal.id,
          resourceId: 'workspace:shots',
          locator: { ...resource.locator, changeSetId: proposal.id },
          sceneCount: structure.scenes.length,
          shotCount: items.length - structure.scenes.length,
          reviewRequired: true,
          applied: false,
          nextAction:
            'Review the proposal on 场次与镜头; approval populates the scene/shot directory.',
        };
      })(),
    );
  }
}
