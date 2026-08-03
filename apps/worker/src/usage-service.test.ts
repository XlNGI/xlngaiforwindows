import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LlmGenerationAttemptRecord } from '@ai-video/domain';
import { createRepositories } from '@ai-video/persistence';
import { AppSettingsService } from './app-settings-service.js';
import { ProjectService } from './project-service.js';
import { UsageService } from './usage-service.js';

const directories: string[] = [];
const projectsToClose: ProjectService[] = [];
const settingsToClose: AppSettingsService[] = [];

afterEach(async () => {
  for (const service of projectsToClose.splice(0)) service.close();
  for (const service of settingsToClose.splice(0)) service.close();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true })));
});

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-usage-'));
  directories.push(directory);
  const projects = new ProjectService({ recentProjectsPath: join(directory, 'recent.json') });
  const appSettings = new AppSettingsService({ appDataDirectory: join(directory, 'app-data') });
  projectsToClose.push(projects);
  settingsToClose.push(appSettings);
  const project = projects.create(join(directory, 'project'), 'Usage Project');
  return { appSettings, project, projects, usage: new UsageService(projects, appSettings) };
}

function attempt(
  id: string,
  currency: string,
  cost: string,
  change: Partial<LlmGenerationAttemptRecord> = {},
): LlmGenerationAttemptRecord {
  return {
    id,
    generationId: `generation-${id}`,
    conversationId: 'conversation',
    userMessageId: 'user',
    assistantMessageId: `assistant-${id}`,
    contextSnapshotId: 'snapshot',
    providerProfileId: `provider-${currency}`,
    providerNameSnapshot: `Provider ${currency}`,
    modelId: `model-${currency}`,
    modelNameSnapshot: `Model ${currency}`,
    protocol: 'openai-responses',
    status: 'complete',
    startedAt: '2026-08-03T01:00:00.000Z',
    completedAt: '2026-08-03T01:00:01.000Z',
    inputTokens: 100,
    cachedInputTokens: 20,
    outputTokens: 50,
    reasoningTokens: 10,
    totalTokens: 150,
    estimatedCost: cost,
    currency,
    ...change,
  };
}

describe('UsageService', () => {
  it('filters entries and keeps currencies in independent summaries', async () => {
    const { appSettings, project, usage } = await setup();
    appSettings.indexLlmAttempt(project, attempt('attempt-usd', 'USD', '0.1'));
    appSettings.indexLlmAttempt(
      project,
      attempt('attempt-cny', 'CNY', '0.02', {
        status: 'failed',
        startedAt: '2026-08-03T02:00:00.000Z',
      }),
    );

    const all = usage.list({
      startAt: '2026-08-03T00:00:00.000Z',
      endAt: '2026-08-04T00:00:00.000Z',
    });
    expect(all.entries.map((entry) => entry.attemptId)).toEqual(['attempt-cny', 'attempt-usd']);
    expect(all.summaries).toMatchObject([
      { currency: 'CNY', attempts: 1, estimatedCost: '0.02' },
      { currency: 'USD', attempts: 1, estimatedCost: '0.1' },
    ]);
    expect(
      usage.list({
        startAt: '2026-08-03T00:00:00.000Z',
        endAt: '2026-08-04T00:00:00.000Z',
        status: 'failed',
      }).entries,
    ).toMatchObject([{ attemptId: 'attempt-cny', status: 'failed' }]);
  });

  it('rebuilds the derived index idempotently from project schema v7 attempts', async () => {
    const { appSettings, project, projects, usage } = await setup();
    projects.access(true, (database) => {
      const repositories = createRepositories(database);
      repositories.conversations.save({
        id: 'conversation',
        projectId: project.id,
        scopeType: 'project',
        title: 'Usage conversation',
        createdAt: '2026-08-03T00:00:00.000Z',
        updatedAt: '2026-08-03T00:00:00.000Z',
      });
      repositories.chatMessages.save({
        id: 'user',
        conversationId: 'conversation',
        role: 'user',
        content: 'Prompt',
        status: 'complete',
        createdAt: '2026-08-03T00:00:00.000Z',
      });
      repositories.chatMessages.save({
        id: 'assistant-attempt-project',
        conversationId: 'conversation',
        replyToMessageId: 'user',
        role: 'assistant',
        content: 'Response',
        status: 'complete',
        createdAt: '2026-08-03T00:00:01.000Z',
      });
      repositories.contextSnapshots.save({
        id: 'snapshot',
        projectId: project.id,
        purpose: 'llm-generation',
        contentJson: '{}',
        createdAt: '2026-08-03T00:00:00.000Z',
      });
      repositories.llmGenerationAttempts.save(
        attempt('attempt-project', 'USD', '0.25', {
          conversationId: 'conversation',
          userMessageId: 'user',
          assistantMessageId: 'assistant-attempt-project',
          contextSnapshotId: 'snapshot',
        }),
      );
    });
    appSettings.indexLlmAttempt(project, attempt('stale-attempt', 'CNY', '99'));

    expect(usage.rebuild()).toEqual({
      projectsScanned: 1,
      projectsSkipped: 0,
      attemptsIndexed: 1,
    });
    expect(usage.rebuild()).toEqual({
      projectsScanned: 1,
      projectsSkipped: 0,
      attemptsIndexed: 1,
    });
    expect(
      usage.list({
        startAt: '2026-08-03T00:00:00.000Z',
        endAt: '2026-08-04T00:00:00.000Z',
      }).entries,
    ).toMatchObject([{ attemptId: 'attempt-project', estimatedCost: '0.25' }]);
  });
});
