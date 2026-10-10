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
import { NovelService } from './novel-service.js';
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
  const novels = new NovelService(project);
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
    getAssetInfo: (assetId) => {
      if (assetId !== asset.id) throw new Error('Asset was not found.');
      return asset;
    },
    updateAssetAlias: ({ assetId, alias }) => {
      if (assetId !== asset.id) throw new Error('Asset was not found.');
      return { ...asset, alias };
    },
    listTags: () => [],
    createTag: () => {
      throw new Error('Not implemented in this fixture.');
    },
    updateTag: () => {
      throw new Error('Not implemented in this fixture.');
    },
    deleteTag: () => ({ deleted: true }),
    changeAssetTags: () => [asset],
    listGroups: () => [],
    createGroup: () => {
      throw new Error('Not implemented in this fixture.');
    },
    updateGroup: () => {
      throw new Error('Not implemented in this fixture.');
    },
    deleteGroup: () => ({ deleted: true }),
    resolveGroup: () => [asset],
    deleteAsset: () => ({ deleted: true, referenceCount: 0 }),
    restoreAsset: () => asset,
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
    service: new AgentSystemToolService(
      project,
      content,
      assets,
      settings,
      mediaTasks,
      undefined,
      undefined,
      undefined,
      novels,
    ),
    identity: {
      projectId: opened.id,
      projectSessionId: project.currentSessionId()!,
      conversationId: current.id,
    },
    current,
    novels,
  };
}

describe('AgentSystemToolService', () => {
  it('lists novel chapters without bodies and applies chapter lifecycle changes with CAS', async () => {
    const { service, identity, novels } = await setup();
    novels.getProfile({ createIfMissing: true });
    const chapter = novels.saveChapter({ title: '第一章 雾港' });

    expect(service.execute('novel.chapter.list', {}, identity)).toMatchObject({
      status: 'succeeded',
      chapters: [
        expect.objectContaining({
          id: chapter.id,
          title: '第一章 雾港',
          lifecycleStatus: 'active',
          rowVersion: chapter.rowVersion,
        }),
      ],
    });

    const pending = service.prepareConfirmation(
      'novel.chapter.archive',
      { chapterId: chapter.id, expectedRowVersion: chapter.rowVersion },
      identity,
    );
    expect(pending).toMatchObject({
      affectedEntities: [{ type: 'novel-chapter', id: chapter.id }],
      executionArguments: {
        chapterId: chapter.id,
        expectedRowVersion: chapter.rowVersion,
        reason: 'user_archive',
      },
    });
    expect(novels.listChapters({ includeArchived: true })[0]?.lifecycleStatus).toBe('active');

    const archived = service.executeConfirmed(
      'novel.chapter.archive',
      pending.executionArguments,
      identity,
    );
    expect(archived).toMatchObject({ status: 'archived', chapter: { id: chapter.id } });
    const archivedChapter = novels.listChapters({ includeArchived: true })[0]!;
    expect(archivedChapter.lifecycleStatus).toBe('archived');

    const restored = service.executeConfirmed(
      'novel.chapter.restore',
      { chapterId: chapter.id, expectedRowVersion: archivedChapter.rowVersion },
      identity,
    );
    expect(restored).toMatchObject({ status: 'restored', chapter: { id: chapter.id } });
    expect(novels.listChapters({ includeArchived: true })[0]?.lifecycleStatus).toBe('active');
  });

  it('rejects stale or foreign novel chapter lifecycle requests', async () => {
    const first = await setup();
    first.novels.getProfile({ createIfMissing: true });
    const chapter = first.novels.saveChapter({ title: '当前项目章节' });
    expect(() =>
      first.service.prepareConfirmation(
        'novel.chapter.archive',
        { chapterId: chapter.id, expectedRowVersion: chapter.rowVersion + 1 },
        first.identity,
      ),
    ).toThrow('AGENT_TOOL_ARGUMENTS_INVALID');

    const second = await setup();
    expect(() =>
      second.service.prepareConfirmation(
        'novel.chapter.archive',
        { chapterId: chapter.id, expectedRowVersion: chapter.rowVersion },
        second.identity,
      ),
    ).toThrow('AGENT_TOOL_PROJECT_SCOPE');
  });

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

  it('returns one project-wide resource map for the System Agent', async () => {
    const { service, identity } = await setup();
    const result = service.execute('project.structure.get', {}, identity) as {
      version: number;
      projectId: string;
      resources: Array<{ kind: string; title: string; locator: { workspace: string } }>;
      revision: string;
    };
    expect(result).toMatchObject({ version: 1, projectId: identity.projectId });
    expect(result.revision).toBeTruthy();
    expect(result.resources.map((item) => item.title)).toEqual(
      expect.arrayContaining([
        '小说',
        '项目文档',
        '角色与场景',
        '场次与镜头',
        '素材库',
        '会话与任务',
        '系统设置',
      ]),
    );
    expect(() => unifiedAgentToolRegistry.serializeResult(result)).not.toThrow();
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
