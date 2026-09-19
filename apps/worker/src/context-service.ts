import { randomUUID } from 'node:crypto';
import type {
  LibraryCatalogItem,
  LibrarySourceStatus,
  ProductionContextInfo,
} from '@ai-video/contracts';
import {
  compileProductionContext,
  toContextManifest,
  type ContextScope,
  type ContextSourceInput,
  type ProductionContext,
} from '@ai-video/context';
import { createRepositories, listProjectLibraryCatalog } from '@ai-video/persistence';
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
      const catalog = listProjectLibraryCatalog(database, project.id).map((item) => ({
        id: item.id,
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        versionId: item.versionId,
        status: item.status as LibrarySourceStatus,
        kind: item.kind,
        title: item.title,
        updatedAt: item.updatedAt,
      }));
      const sources: ContextSourceInput[] = [
        {
          id: `${project.id}:catalog`,
          type: 'catalog',
          scopeType: 'project',
          label: `资料目录 ${catalog.length} 项`,
          content: renderLibraryCatalog(catalog),
          updatedAt: project.updatedAt,
          priority: 10,
        },
      ];
      const messages = repositories.chatMessages.listPage(conversation.id, 12).reverse();
      if (messages.length > 0) {
        sources.push({
          id: conversation.id,
          type: 'conversation',
          scopeType: conversation.scopeType,
          scopeId: conversation.scopeId,
          label: '最近相关会话',
          content: messages.map((message) => `${message.role}: ${message.content}`).join('\n\n'),
          updatedAt: conversation.updatedAt,
          priority: 50,
        });
      }
      return compileProductionContext({
        projectId: project.id,
        projectName: project.name,
        scope,
        sources,
        catalog,
        budgetTokens,
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
        contentJson: JSON.stringify(toContextManifest(context)),
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
    catalog: context.catalog as LibraryCatalogItem[],
  };
}

function isDefaultConversationTitle(title: string): boolean {
  return title.trim() === '' || title.trim() === '新会话' || title.trim() === '会话';
}

function renderLibraryCatalog(catalog: LibraryCatalogItem[]): string {
  if (catalog.length === 0)
    return '资料目录为空。需要项目资料时调用 library.search / library.read。';
  const lines: string[] = [];
  let untitledConversations = 0;
  for (const item of catalog) {
    if (item.sourceType === 'conversation' && isDefaultConversationTitle(item.title)) {
      untitledConversations += 1;
      continue;
    }
    lines.push(
      `${lines.length + 1}. ${item.title} · ${item.sourceType} · ${item.status}${item.kind ? ` · ${item.kind}` : ''}`,
    );
  }
  if (untitledConversations > 0) {
    lines.push(
      `${lines.length + 1}. 会话记录 ${untitledConversations} 条 · conversation · 需要时检索`,
    );
  }
  return lines.join('\n');
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
