import type {
  AssetInfo,
  AssetListParams,
  ConversationInfo,
  ProviderModelInfo,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import type { SystemAgentToolOperation } from './agent-tool-definitions.js';
import { AgentToolPolicyError } from './agent-tool-registry.js';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';

export interface AgentAssetToolService {
  listAssets(params: AssetListParams): AssetInfo[];
  updateAssetAlias(params: { assetId: string; alias: string }): AssetInfo;
}

export interface AgentSettingsToolService {
  listProfiles(includeArchived?: boolean): ProviderProfileInfo[];
  listModels(profileId: string): ProviderModelInfo[];
}

export interface AgentSystemToolIdentity {
  projectId: string;
  projectSessionId: string;
  conversationId: string;
}

/** Executes bounded system tools through the same services used by the Desktop UI. */
export class AgentSystemToolService {
  constructor(
    private readonly projects: ProjectService,
    private readonly content: ContentService,
    private readonly assets: AgentAssetToolService,
    private readonly settings: AgentSettingsToolService,
  ) {}

  execute(
    operation: SystemAgentToolOperation,
    rawArguments: unknown,
    identity: AgentSystemToolIdentity,
  ): Record<string, unknown> {
    this.assertIdentity(identity);
    const args = requireArguments(rawArguments);
    switch (operation) {
      case 'project.get_context':
        rejectUnknown(args, []);
        return this.projectContext();
      case 'conversation.search':
        return this.searchConversations(args);
      case 'conversation.rename':
        return this.renameConversation(args, identity.conversationId);
      case 'asset.search':
        return this.searchAssets(args);
      case 'asset.update_alias':
        return this.updateAssetAlias(args);
      case 'settings.get':
        return this.settingsSummary(args);
    }
  }

  private assertIdentity(identity: AgentSystemToolIdentity): void {
    const project = this.projects.current();
    if (
      !project ||
      project.id !== identity.projectId ||
      this.projects.currentSessionId() !== identity.projectSessionId
    ) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_PROJECT_SCOPE',
        'The tool call does not belong to the current project session.',
      );
    }
    const conversationExists = this.projects.access(false, (database) =>
      database
        .prepare('SELECT 1 FROM conversations WHERE id = ? AND project_id = ?')
        .get(identity.conversationId, project.id),
    );
    if (!conversationExists) {
      throw new AgentToolPolicyError(
        'AGENT_TOOL_PROJECT_SCOPE',
        'The tool call does not belong to a current-project conversation.',
      );
    }
  }

  private projectContext(): Record<string, unknown> {
    return this.projects.access(false, (database, project) => ({
      version: 1,
      status: 'succeeded',
      project: {
        id: project.id,
        name: project.name,
        mode: project.mode,
        schemaVersion: project.schemaVersion,
        updatedAt: project.updatedAt,
      },
      counts: {
        conversations: scalarCount(database, 'conversations', project.id),
        documents: scalarCount(database, 'documents', project.id),
        assets: scalarCount(database, 'assets', project.id),
      },
    }));
  }

  private searchConversations(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['query', 'includeArchived', 'limit']);
    const limit = optionalInteger(args.limit, 'limit', 1, 100) ?? 50;
    const page = this.content.listConversations({
      query: optionalString(args.query, 'query', 200),
      includeArchived: optionalBoolean(args.includeArchived, 'includeArchived') ?? false,
      limit,
    });
    return {
      version: 1,
      status: 'succeeded',
      conversations: page.items.map(toConversationSummary),
      truncated: page.nextCursor !== undefined,
    };
  }

  private renameConversation(
    args: Record<string, unknown>,
    conversationId: string,
  ): Record<string, unknown> {
    rejectUnknown(args, ['title']);
    const title = requiredString(args.title, 'title', 200);
    const conversation = this.content.updateConversation({ conversationId, title });
    return {
      version: 1,
      status: 'succeeded',
      summary: 'Current conversation renamed.',
      conversation: toConversationSummary(conversation),
    };
  }

  private searchAssets(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['keyword', 'kind', 'deleted', 'limit']);
    const deleted = args.deleted;
    if (deleted !== undefined && deleted !== 'active' && deleted !== 'trash') {
      throw new Error('deleted must be active or trash.');
    }
    const limit = optionalInteger(args.limit, 'limit', 1, 100) ?? 50;
    const assets = this.assets.listAssets({
      keyword: optionalString(args.keyword, 'keyword', 200),
      kind: optionalString(args.kind, 'kind', 100),
      deleted,
      limit: limit + 1,
    });
    return {
      version: 1,
      status: 'succeeded',
      assets: assets.slice(0, limit).map(toAssetSummary),
      truncated: assets.length > limit,
    };
  }

  private updateAssetAlias(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['assetId', 'alias']);
    const assetId = requiredString(args.assetId, 'assetId', 200);
    const alias = requiredString(args.alias, 'alias', 120, true);
    let asset: AssetInfo;
    try {
      asset = this.assets.updateAssetAlias({ assetId, alias });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw new AgentToolPolicyError(
          'AGENT_TOOL_PROJECT_SCOPE',
          'The requested asset is not available in the current project.',
        );
      }
      throw error;
    }
    return {
      version: 1,
      status: 'succeeded',
      summary: 'Asset alias updated.',
      asset: toAssetSummary(asset),
    };
  }

  private settingsSummary(args: Record<string, unknown>): Record<string, unknown> {
    rejectUnknown(args, ['capability']);
    const capability = args.capability;
    if (
      capability !== undefined &&
      capability !== 'text' &&
      capability !== 'image' &&
      capability !== 'video'
    ) {
      throw new Error('capability must be text, image, or video.');
    }
    const profiles = this.settings.listProfiles(false).slice(0, 100);
    const matchingModels = profiles
      .flatMap((profile) =>
        this.settings.listModels(profile.id).map((model) => ({ profile, model })),
      )
      .filter(({ model }) => !capability || modelSupports(model, capability));
    const models = matchingModels.slice(0, 100);
    return {
      version: 1,
      status: 'succeeded',
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        category: profile.category,
        providerType: profile.providerType,
        enabled: profile.enabled,
        connectionStatus: profile.connectionStatus,
        lastCheckedAt: profile.lastCheckedAt,
      })),
      models: models.map(({ profile, model }) => ({
        id: model.id,
        providerProfileId: profile.id,
        name: model.displayName,
        source: model.source,
        enabled: model.enabled,
        unavailable: model.unavailableAt !== undefined,
        capabilities: {
          text: model.capabilities.text,
          streaming: model.capabilities.streaming,
          tools: model.capabilities.tools,
          imageGeneration: model.capabilities.imageGeneration,
          videoGeneration: model.capabilities.videoGeneration,
        },
      })),
      truncated: matchingModels.length > models.length,
    };
  }
}

function scalarCount(
  database: import('better-sqlite3').Database,
  table: 'conversations' | 'documents' | 'assets',
  projectId: string,
): number {
  const row = database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`)
    .get(projectId) as { count: number };
  return row.count;
}

function toConversationSummary(conversation: ConversationInfo): Record<string, unknown> {
  return {
    id: conversation.id,
    title: conversation.title,
    scopeType: conversation.scopeType,
    scopeId: conversation.scopeId,
    archived: conversation.archivedAt !== undefined,
    updatedAt: conversation.updatedAt,
  };
}

function toAssetSummary(asset: AssetInfo): Record<string, unknown> {
  return {
    id: asset.id,
    kind: asset.kind,
    alias: asset.alias,
    sizeBytes: asset.sizeBytes,
    deleted: asset.deletedAt !== undefined,
    tags: (asset.tags ?? []).slice(0, 100).map((tag) => ({ id: tag.id, name: tag.name })),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

function modelSupports(model: ProviderModelInfo, capability: 'text' | 'image' | 'video'): boolean {
  return capability === 'text'
    ? model.capabilities.text
    : capability === 'image'
      ? model.capabilities.imageGeneration
      : model.capabilities.videoGeneration;
}

function requireArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Tool arguments must be an object.');
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`Tool arguments contain unsupported field ${unknown}.`);
}

function requiredString(value: unknown, name: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  const normalized = value.normalize('NFC').trim();
  if ((!allowEmpty && !normalized) || normalized.length > maximum) {
    throw new Error(`${name} is outside its allowed length.`);
  }
  return normalized;
}

function optionalString(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, maximum, true);
}

function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}
