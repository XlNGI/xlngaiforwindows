import { randomUUID } from 'node:crypto';
import type { ProductionContextInfo } from '@ai-video/contracts';
import {
  compileProductionContext,
  extractiveSummary,
  sourceSummaryKey,
  type ContextScope,
  type ContextSourceInput,
  type ProductionContext,
} from '@ai-video/context';
import { createRepositories } from '@ai-video/persistence';
import { ProjectService } from './project-service.js';

export class ContextService {
  constructor(private readonly projects: ProjectService) {}

  compile(conversationId: string, budgetTokens?: number): ProductionContext {
    return this.projects.access(false, (database, project) => {
      const repositories = createRepositories(database);
      const conversation = repositories.conversations.get(conversationId);
      if (!conversation || conversation.projectId !== project.id)
        throw new Error('Conversation was not found.');
      const scope = resolveScope(
        repositories,
        project.id,
        conversation.scopeType,
        conversation.scopeId,
      );
      const sources: ContextSourceInput[] = [];

      for (const document of repositories.documents.listByProject(project.id)) {
        // A working draft is intentionally not project authority. Only the explicit
        // publication pointer may contribute to another generation's context.
        const version = document.publishedVersionId
          ? repositories.documents.getVersion(document.publishedVersionId)
          : undefined;
        if (!version) continue;
        sources.push({
          id: document.id,
          type: 'document',
          scopeType: document.scopeType as ContextSourceInput['scopeType'],
          scopeId: document.scopeId,
          label: document.title,
          content: version.contentMarkdown,
          version: version.version,
          versionId: version.id,
          updatedAt: document.updatedAt,
        });
      }
      for (const memory of repositories.memories.listByProject(project.id)) {
        sources.push({
          id: memory.id,
          type: 'memory',
          scopeType: memory.scopeType as ContextSourceInput['scopeType'],
          scopeId: memory.scopeId,
          label: '项目记忆',
          content: memory.content,
          updatedAt: memory.updatedAt,
        });
      }
      for (const constraint of repositories.constraints.listByProject(project.id)) {
        sources.push({
          id: constraint.id,
          type: 'constraint',
          scopeType: constraint.scopeType as ContextSourceInput['scopeType'],
          scopeId: constraint.scopeId,
          label: `生产约束：${constraint.kind}`,
          content: constraint.content,
          updatedAt: constraint.updatedAt,
        });
      }
      const messages = repositories.chatMessages.listPage(conversation.id, 20).reverse();
      if (messages.length > 0) {
        sources.push({
          id: conversation.id,
          type: 'conversation',
          scopeType: conversation.scopeType as ContextSourceInput['scopeType'],
          scopeId: conversation.scopeId,
          label: '最近相关会话',
          content: messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'),
          updatedAt: conversation.updatedAt,
          priority: 50,
        });
      }

      const summaries: Record<string, string> = {};
      for (const source of sources.filter(
        (item) => item.type !== 'constraint' && item.content.length > 8_000,
      )) {
        const key = sourceSummaryKey(source);
        const cached = repositories.contextSnapshots.get(`summary-${key}`);
        if (cached) {
          summaries[key] = (JSON.parse(cached.contentJson) as { summary: string }).summary;
        } else {
          const summary = extractiveSummary(source.content);
          summaries[key] = summary;
          if (project.mode === 'read-write') {
            repositories.contextSnapshots.save({
              id: `summary-${key}`,
              projectId: project.id,
              purpose: 'summary-cache',
              contentJson: JSON.stringify({ sourceId: source.id, summary }),
              createdAt: new Date().toISOString(),
            });
          }
        }
      }
      return compileProductionContext({
        projectId: project.id,
        projectName: project.name,
        scope,
        sources,
        budgetTokens,
        summaries,
      });
    });
  }

  preview(conversationId: string, budgetTokens?: number): ProductionContextInfo {
    return toContextInfo(this.compile(conversationId, budgetTokens));
  }

  saveSnapshot(context: ProductionContext, purpose: string): string {
    return this.projects.access(true, (database, project) => {
      const id = randomUUID();
      createRepositories(database).contextSnapshots.save({
        id,
        projectId: project.id,
        purpose,
        contentJson: JSON.stringify(context),
        createdAt: new Date().toISOString(),
      });
      return id;
    });
  }
}

export function toContextInfo(context: ProductionContext): ProductionContextInfo {
  return {
    version: 1,
    scopeType: context.scope.type,
    scopeId: context.scope.id,
    scopeLabel: context.scope.label,
    estimatedTokens: context.estimatedTokens,
    budgetTokens: context.budgetTokens,
    sources: context.sources.map((source) => ({
      id: source.id,
      type: source.type,
      scopeType: source.scopeType,
      scopeId: source.scopeId,
      label: source.label,
      version: source.version,
      versionId: source.versionId,
      includedCharacters: source.includedCharacters,
      originalCharacters: source.originalCharacters,
      truncated: source.truncated,
    })),
  };
}

function resolveScope(
  repositories: ReturnType<typeof createRepositories>,
  projectId: string,
  scopeType: string,
  scopeId?: string,
): ContextScope {
  if (scopeType === 'project') return { type: 'project', label: '项目' };
  if (scopeType === 'scene' && scopeId) {
    const scene = repositories.scenes.get(scopeId);
    if (!scene || scene.projectId !== projectId) throw new Error('Scene was not found.');
    return { type: 'scene', id: scene.id, label: scene.title };
  }
  if (scopeType === 'shot' && scopeId) {
    const shot = repositories.shots.get(scopeId);
    const scene = shot ? repositories.scenes.get(shot.sceneId) : undefined;
    if (!shot || scene?.projectId !== projectId) throw new Error('Shot was not found.');
    return {
      type: 'shot',
      id: shot.id,
      sceneId: scene.id,
      label: `${scene.title} / ${shot.title}`,
    };
  }
  throw new Error('Conversation scope is invalid.');
}
