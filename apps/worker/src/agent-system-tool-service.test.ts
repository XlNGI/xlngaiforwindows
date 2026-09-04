import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { AssetInfo, ProviderModelInfo, ProviderProfileInfo } from '@ai-video/contracts';
import {
  AgentSystemToolService,
  type AgentAssetToolService,
  type AgentSettingsToolService,
} from './agent-system-tool-service.js';
import { AgentToolPolicyError, unifiedAgentToolRegistry } from './agent-tool-registry.js';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';

const directories: string[] = [];
const projects: ProjectService[] = [];

afterEach(async () => {
  for (const project of projects.splice(0)) project.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-system-tools-'));
  directories.push(directory);
  const project = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  projects.push(project);
  const opened = project.create(join(directory, 'project'), 'System Tool Project');
  const content = new ContentService(project);
  const current = content.createConversation({ scopeType: 'project', title: 'Current' });
  content.createConversation({ scopeType: 'project', title: 'Research Notes' });
  const asset: AssetInfo = {
    id: 'asset-1',
    projectId: opened.id,
    kind: 'generated-image',
    relativePath: 'assets/private.png',
    contentHash: 'hash',
    sizeBytes: 42,
    sourceUrl: 'https://signed.example/private?token=secret',
    alias: 'Cover',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  const assets: AgentAssetToolService = {
    listAssets: () => [asset],
    updateAssetAlias: ({ assetId, alias }) => {
      if (assetId !== asset.id) throw new Error('Asset was not found.');
      return { ...asset, alias };
    },
  };
  const profile: ProviderProfileInfo = {
    id: 'profile-1',
    name: 'Provider',
    category: 'multi',
    providerType: 'custom-provider',
    accessType: 'custom',
    protocol: 'openai-responses',
    baseUrl: 'https://private.example/v1',
    enabled: true,
    connectionStatus: 'ready',
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  const model: ProviderModelInfo = {
    id: 'model-1',
    providerProfileId: profile.id,
    remoteModelId: 'private-remote-name',
    displayName: 'Assistant',
    capabilities: {
      text: true,
      vision: false,
      streaming: true,
      reasoning: false,
      tools: true,
      structuredOutput: false,
      embeddings: false,
      imageGeneration: false,
      videoGeneration: false,
    },
    source: 'manual',
    enabled: true,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
  };
  const settings: AgentSettingsToolService = {
    listProfiles: () => [profile],
    listModels: () => [model],
  };
  const mediaTasks = {
    getTask: (taskId: string) => ({
      taskId,
      kind: 'video' as const,
      state: 'polling' as const,
      adapterKey: 'TEXT_TO_VIDEO:unicompapi:test:v1',
      resultAssetIds: [],
      createdAt: '2026-09-03T00:00:00.000Z',
      updatedAt: '2026-09-03T00:00:01.000Z',
    }),
  };
  return {
    project,
    content,
    assets,
    settings,
    service: new AgentSystemToolService(project, content, assets, settings, mediaTasks),
    identity: {
      projectId: opened.id,
      projectSessionId: project.currentSessionId()!,
      conversationId: current.id,
    },
    current,
  };
}

describe('AgentSystemToolService', () => {
  it('returns bounded project, conversation, asset, and redacted settings summaries', async () => {
    const { service, identity } = await setup();
    const project = service.execute('project.get_context', {}, identity);
    const conversations = service.execute(
      'conversation.search',
      { query: 'research', limit: 10 },
      identity,
    );
    const assets = service.execute('asset.search', { limit: 10 }, identity);
    const settings = service.execute('settings.get', { capability: 'text' }, identity);

    for (const result of [project, conversations, assets, settings]) {
      expect(() => unifiedAgentToolRegistry.serializeResult(result)).not.toThrow();
    }
    expect(JSON.stringify(project)).not.toContain('rootPath');
    expect(conversations).toMatchObject({
      conversations: [expect.objectContaining({ title: 'Research Notes' })],
    });
    expect(JSON.stringify(assets)).not.toMatch(/relativePath|contentHash|sourceUrl|token=secret/u);
    expect(JSON.stringify(settings)).not.toMatch(/baseUrl|remoteModelId|private\.example/u);
  });

  it('returns only the normalized media task summary', async () => {
    const { service, identity } = await setup();
    const result = service.execute('media.task.get', { taskId: 'media-task' }, identity);

    expect(result).toMatchObject({
      status: 'succeeded',
      task: { taskId: 'media-task', kind: 'video', state: 'polling', resultAssetIds: [] },
    });
    expect(JSON.stringify(result)).not.toMatch(
      /rootPath|relativePath|providerBody|providerResponse/iu,
    );
  });

  it('renames only the current conversation and rejects a model-provided conversation ID', async () => {
    const { service, identity, content, current } = await setup();
    expect(service.execute('conversation.rename', { title: 'Renamed' }, identity)).toMatchObject({
      conversation: { id: current.id, title: 'Renamed' },
    });
    expect(
      content
        .listConversations({ includeArchived: true })
        .items.find((item) => item.id === current.id)?.title,
    ).toBe('Renamed');
    expect(() =>
      service.execute(
        'conversation.rename',
        { conversationId: 'other', title: 'Forbidden' },
        identity,
      ),
    ).toThrow('unsupported field conversationId');
  });

  it('rejects stale sessions and cross-project asset identifiers', async () => {
    const { service, identity } = await setup();
    expect(() =>
      service.execute('project.get_context', {}, { ...identity, projectSessionId: 'stale' }),
    ).toThrow('AGENT_TOOL_PROJECT_SCOPE');
    try {
      service.execute('asset.update_alias', { assetId: 'other-project', alias: 'x' }, identity);
    } catch (error) {
      expect(error).toBeInstanceOf(AgentToolPolicyError);
      expect((error as AgentToolPolicyError).code).toBe('AGENT_TOOL_PROJECT_SCOPE');
    }
  });
});
