import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectRuntimeScope } from '@ai-video/contracts';
import { ProjectService } from './project-service.js';
import { ProjectRuntimeRegistry, projectContainerLocation } from './project-runtime-registry.js';
import { AppSettingsService } from './app-settings-service.js';
import { TaskCapacity } from './task-capacity.js';
import { openAppDatabase, migrateAppDatabase, getAppSchemaVersion } from '@ai-video/persistence';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of cleanup.splice(0).reverse()) await stop();
});
async function setup(maxLoaded = 4) {
  const root = await mkdtemp(join(tmpdir(), 'runtime-registry-'));
  const settings = new AppSettingsService({ appDataDirectory: join(root, 'settings') });
  const busy = new Set<string>();
  const factory = () => {
    const projectService = new ProjectService({ recentProjectsPath: join(root, 'recent.json') });
    return {
      projectService,
      stop: vi.fn(() => Promise.resolve()),
      recover: vi.fn(),
      isBusy: () => busy.has(projectService.current()?.id ?? ''),
    };
  };
  const registries: Array<ProjectRuntimeRegistry<ReturnType<typeof factory>>> = [];
  const registry = () => {
    const item = new ProjectRuntimeRegistry(factory, settings, { maxLoaded });
    registries.push(item);
    return item;
  };
  cleanup.push(async () => {
    for (const item of registries) await item.shutdown();
    settings.close();
    await rm(root, { recursive: true, force: true });
  });
  const create = (name: string) => {
    const service = factory().projectService;
    try {
      return service.create(join(root, name), name);
    } finally {
      service.close();
    }
  };
  return { root, settings, busy, registry, create };
}
const scope = (item: {
  project: { id: string };
  projectSessionId: string;
}): ProjectRuntimeScope => ({
  projectId: item.project.id,
  projectSessionId: item.projectSessionId,
});

it('restores only explicitly opted-in containers, reports missing paths, and disables recovery on explicit unload', async () => {
  const f = await setup();
  const a = f.create('A'),
    b = f.create('B'),
    missing = f.create('missing');
  const first = f.registry();
  await first.attach({ rootPath: a.rootPath, recoverOnStartup: true });
  await first.attach({ rootPath: b.rootPath });
  await first.attach({ rootPath: missing.rootPath, recoverOnStartup: true });
  await first.shutdown();
  await rm(missing.rootPath, { recursive: true, force: true });
  const restarted = f.registry();
  await restarted.restoreRegistered();
  expect(restarted.list().map((entry) => entry.project.id)).toEqual([a.id]);
  expect(restarted.list()[0]!.projectSessionId).toBeTruthy();
  expect(
    f.settings.listRuntimeRegistrations().find((entry) => entry.projectId === missing.id)
      ?.lastError,
  ).toBe('PROJECT_UNAVAILABLE');
  expect(
    f.settings.listRuntimeRegistrations().find((entry) => entry.projectId === b.id)
      ?.recoverOnStartup,
  ).toBe(false);
  await restarted.unload(scope(restarted.list()[0]!));
  expect(
    f.settings.listRuntimeRegistrations().find((entry) => entry.projectId === a.id)
      ?.recoverOnStartup,
  ).toBe(false);
});

it('evicts only inactive idle runtimes, retains queued requests and never evicts active work', async () => {
  const f = await setup(2);
  const a = f.create('A'),
    b = f.create('B'),
    c = f.create('C');
  const registry = f.registry();
  const ra = await registry.attach({ rootPath: a.rootPath });
  const rb = await registry.attach({ rootPath: b.rootPath });
  await registry.activate(scope(ra));
  f.busy.add(b.id);
  await expect(registry.attach({ rootPath: c.rootPath })).rejects.toThrow('capacity');
  f.busy.delete(b.id);
  const release = registry.retain(registry.get(scope(rb)));
  await expect(registry.attach({ rootPath: c.rootPath })).rejects.toThrow('capacity');
  release();
  await registry.attach({ rootPath: c.rootPath });
  expect(
    registry
      .list()
      .map((item) => item.project.id)
      .sort(),
  ).toEqual([a.id, c.id].sort());
  expect(() => registry.get(scope(rb))).toThrow('stale');
});

it('loads a locked project read-only without remote recovery or changing the writer', async () => {
  const f = await setup();
  const a = f.create('A');
  const writer = new ProjectService({ recentProjectsPath: join(f.root, 'writer-recent.json') });
  writer.open(a.rootPath);
  try {
    const registry = f.registry();
    const loaded = await registry.attach({ rootPath: a.rootPath, recoverOnStartup: true });
    expect(loaded.project.mode).toBe('read-only');
    const service = registry.get(scope(loaded)).projectService;
    expect(() => service.access(true, () => undefined)).toThrow('read-only');
    expect(writer.integrity().ok).toBe(true);
  } finally {
    writer.close();
  }
});

it('refuses a replaced directory identity during startup recovery', async () => {
  const f = await setup();
  const a = f.create('A');
  const registry = f.registry();
  await registry.attach({ rootPath: a.rootPath, recoverOnStartup: true });
  await registry.shutdown();
  const old = f.settings.listRuntimeRegistrations()[0]!;
  f.settings.saveRuntimeRegistration({ ...old, directoryIdentity: 'different-container' });
  await registry.restoreRegistered();
  expect(registry.list()).toEqual([]);
  expect(f.settings.listRuntimeRegistrations()[0]!.lastError).toBe('PROJECT_UNAVAILABLE');
  expect(projectContainerLocation(a.rootPath).directoryIdentity).not.toBe(
    old.directoryIdentity + 'changed',
  );
  await mkdir(join(f.root, 'empty'));
  expect(() => projectContainerLocation(join(f.root, 'empty'))).toThrow();
});

it('shares submit and poll capacity and keeps release scoped to its original token', () => {
  const capacity = new TaskCapacity();
  expect(capacity.acquire('A', 'submit', 0)).toBe(true);
  expect(capacity.acquire('B', 'submit', 0)).toBe(true);
  expect(capacity.acquire('C', 'submit', 0)).toBe(false);
  capacity.release('not-A');
  expect(capacity.acquire('C', 'submit', 0)).toBe(false);
  capacity.release('A');
  expect(capacity.acquire('C', 'submit', 0)).toBe(true);
  expect(capacity.acquire('poll-A', 'poll', 0)).toBe(true);
  expect(capacity.acquire('poll-B', 'poll', 499)).toBe(false);
  expect(capacity.acquire('poll-B', 'poll', 500)).toBe(true);
  expect(capacity.acquire('poll-C', 'poll', 1000)).toBe(false);
});

it('rotates capacity between projects and removes waits from an unloaded runtime', () => {
  const capacity = new TaskCapacity();
  expect(capacity.acquire('a1', 'submit', 0, 'a1', 'A')).toBe(true);
  expect(capacity.acquire('a2', 'submit', 0, 'a2', 'A')).toBe(true);
  expect(capacity.acquire('a3', 'submit', 0, 'a3', 'A')).toBe(false);
  expect(capacity.acquire('b1', 'submit', 0, 'b1', 'B')).toBe(false);
  capacity.release('a1');
  expect(capacity.acquire('a3', 'submit', 0, 'a3', 'A')).toBe(false);
  expect(capacity.acquire('b1', 'submit', 0, 'b1', 'B')).toBe(true);
  capacity.release('a2');
  capacity.cancelOwnerWaiting('A');
  expect(capacity.acquire('b2', 'submit', 0, 'b2', 'B')).toBe(true);
});

it('backs up a v7 application database before loading runtime registrations', async () => {
  const f = await setup();
  const data = join(f.root, 'legacy-settings');
  await mkdir(data);
  const db = openAppDatabase(join(data, 'app-settings.sqlite'));
  migrateAppDatabase(db);
  db.exec(
    `DROP TABLE project_runtime_registrations;
     ALTER TABLE usage_index DROP COLUMN accounting_json;
     ALTER TABLE usage_index DROP COLUMN provider_reported_cost_json;
     DELETE FROM app_schema_migrations WHERE version>=8`,
  );
  db.close();
  const settings = new AppSettingsService({ appDataDirectory: data });
  try {
    expect(settings.listRuntimeRegistrations()).toEqual([]);
    const files = await readdir(join(data, 'backups'));
    expect(files).toHaveLength(1);
    const backup = openAppDatabase(join(data, 'backups', files[0]!), { readonly: true });
    try {
      expect(getAppSchemaVersion(backup)).toBe(7);
    } finally {
      backup.close();
    }
  } finally {
    settings.close();
  }
});
