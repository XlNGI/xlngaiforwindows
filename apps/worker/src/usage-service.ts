import { join } from 'node:path';
import type {
  UsageCurrencySummary,
  UsageEntryInfo,
  UsageQueryParams,
  UsageQueryResult,
  UsageRebuildResult,
} from '@ai-video/contracts';
import type { UsageIndexRecord } from '@ai-video/domain';
import { createRepositories, getSchemaVersion, openProjectDatabase } from '@ai-video/persistence';
import { AppSettingsService, toUsageIndexRecord } from './app-settings-service.js';
import { ProjectService } from './project-service.js';
import { addDecimalStrings } from './usage-cost.js';

const PROJECT_DATABASE_NAME = 'project.sqlite';

export interface UsageServiceOptions {
  nativeBinding?: object;
}

export class UsageService {
  private readonly nativeBinding?: object;

  constructor(
    private readonly projects: ProjectService,
    private readonly appSettings: AppSettingsService,
    options: UsageServiceOptions = {},
  ) {
    this.nativeBinding = options.nativeBinding;
  }

  list(params: UsageQueryParams): UsageQueryResult {
    const { startAt, endAt } = normalizeRange(params.startAt, params.endAt);
    const entries = this.appSettings
      .listUsageIndex(startAt, endAt)
      .filter((entry) => matchesFilters(entry, params))
      .map(toUsageEntry)
      .reverse();
    return { entries, summaries: summarizeByCurrency(entries) };
  }

  rebuild(): UsageRebuildResult {
    const records: UsageIndexRecord[] = [];
    const seenRoots = new Set<string>();
    let projectsScanned = 0;
    let projectsSkipped = 0;
    const current = this.projects.current();
    if (current) {
      seenRoots.add(current.rootPath.toLowerCase());
      const attempts = this.projects.access(false, (database) =>
        createRepositories(database).llmGenerationAttempts.listByProject(current.id),
      );
      for (const attempt of attempts) {
        const record = toUsageIndexRecord(current, attempt);
        if (record) records.push(record);
      }
      projectsScanned += 1;
    }

    for (const recent of this.projects.listRecent()) {
      const rootKey = recent.rootPath.toLowerCase();
      if (seenRoots.has(rootKey)) continue;
      seenRoots.add(rootKey);
      let database: ReturnType<typeof openProjectDatabase> | undefined;
      try {
        database = openProjectDatabase(join(recent.rootPath, PROJECT_DATABASE_NAME), {
          readonly: true,
          nativeBinding: this.nativeBinding,
        });
        if (getSchemaVersion(database) < 7) {
          projectsSkipped += 1;
          continue;
        }
        const repositories = createRepositories(database);
        const project = { ...repositories.projects.get(), rootPath: recent.rootPath };
        for (const attempt of repositories.llmGenerationAttempts.listByProject(project.id)) {
          const record = toUsageIndexRecord(project, attempt);
          if (record) records.push(record);
        }
        projectsScanned += 1;
      } catch {
        projectsSkipped += 1;
      } finally {
        database?.close();
      }
    }

    this.appSettings.replaceUsageIndex(records);
    return {
      projectsScanned,
      projectsSkipped,
      attemptsIndexed: records.length,
    };
  }
}

function normalizeRange(startAt: string, endAt: string): { startAt: string; endAt: string } {
  const start = new Date(startAt);
  const end = new Date(endAt);
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || start >= end) {
    throw new Error('Usage date range is invalid.');
  }
  return { startAt: start.toISOString(), endAt: end.toISOString() };
}

function matchesFilters(entry: UsageIndexRecord, params: UsageQueryParams): boolean {
  return (
    (!params.providerProfileId || entry.providerProfileId === params.providerProfileId) &&
    (!params.modelId || entry.modelId === params.modelId) &&
    (!params.projectId || entry.projectId === params.projectId) &&
    (!params.status || entry.status === params.status)
  );
}

function toUsageEntry(record: UsageIndexRecord): UsageEntryInfo {
  return { ...record };
}

function summarizeByCurrency(entries: UsageEntryInfo[]): UsageCurrencySummary[] {
  const currencies = new Map<string, UsageEntryInfo[]>();
  for (const entry of entries) {
    if (!entry.currency || entry.estimatedCost === undefined) continue;
    const group = currencies.get(entry.currency) ?? [];
    group.push(entry);
    currencies.set(entry.currency, group);
  }
  return [...currencies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, group]) => ({
      currency,
      attempts: group.length,
      inputTokens: sum(group, 'inputTokens'),
      cachedInputTokens: sum(group, 'cachedInputTokens'),
      outputTokens: sum(group, 'outputTokens'),
      reasoningTokens: sum(group, 'reasoningTokens'),
      totalTokens: sum(group, 'totalTokens'),
      estimatedCost: addDecimalStrings(group.map((entry) => entry.estimatedCost ?? '0')),
    }));
}

function sum(
  entries: UsageEntryInfo[],
  key: 'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningTokens' | 'totalTokens',
): number {
  return entries.reduce((total, entry) => total + (entry[key] ?? 0), 0);
}
