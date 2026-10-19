import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { createRepositories, openProjectDatabase } from '@ai-video/persistence';
import type {
  ProjectRuntimeInfo,
  ProjectRuntimeRegistration,
  ProjectRuntimeScope,
} from '@ai-video/contracts';
import type { ProjectService } from './project-service.js';

export interface ProjectRuntimeBundle {
  projectService: ProjectService;
  stop(): Promise<void>;
  recover(): void;
  isBusy(): boolean;
}
interface RegistrationStore {
  listRuntimeRegistrations(): ProjectRuntimeRegistration[];
  saveRuntimeRegistration(record: Omit<ProjectRuntimeRegistration, 'updatedAt'>): void;
}
interface LoadedRuntime<T> {
  services: T;
  canonicalPath: string;
  directoryIdentity: string;
  state: 'ready' | 'draining';
  lastUsedAt: number;
}
export class ProjectRuntimeScopeError extends Error {}

export function projectContainerLocation(rootPath: string): {
  canonicalPath: string;
  directoryIdentity: string;
} {
  if (!isAbsolute(rootPath)) throw new Error('Project runtime path must be absolute.');
  const absolute = resolve(rootPath);
  let path = parse(absolute).root;
  for (const segment of relative(path, absolute).split(sep).filter(Boolean)) {
    path = join(path, segment);
    if (lstatSync(path).isSymbolicLink())
      throw new Error('Project runtime path cannot contain links.');
  }
  const canonicalPath = realpathSync(absolute);
  const directory = statSync(canonicalPath, { bigint: true });
  if (!directory.isDirectory()) throw new Error('Project runtime path is not a directory.');
  const databasePath = join(canonicalPath, 'project.sqlite');
  const database = lstatSync(databasePath, { bigint: true });
  if (!database.isFile() || database.isSymbolicLink())
    throw new Error('Project database must be a regular file.');
  return {
    canonicalPath,
    directoryIdentity: `${directory.dev}:${directory.ino}:${database.dev}:${database.ino}`,
  };
}

/** Owns loaded project containers. Activation is independent of opening and draining. */
export class ProjectRuntimeRegistry<T extends ProjectRuntimeBundle> {
  private readonly loaded = new Map<string, LoadedRuntime<T>>();
  private activeProjectId?: string;
  private tail = Promise.resolve();
  private readonly references = new Map<T, number>();
  readonly fallback: T;

  constructor(
    private readonly factory: () => T,
    private readonly registrations: RegistrationStore,
    private readonly options: { nativeBinding?: object; maxLoaded?: number } = {},
  ) {
    this.fallback = factory();
  }
  all(): T[] {
    return [this.fallback, ...[...this.loaded.values()].map((runtime) => runtime.services)];
  }
  shutdown(): Promise<void> {
    return this.control(async () => {
      for (const id of [...this.loaded.keys()]) await this.unloadNow(id);
    });
  }
  current(): T {
    const runtime = this.activeProjectId ? this.loaded.get(this.activeProjectId) : undefined;
    if (runtime) runtime.lastUsedAt = Date.now();
    return runtime?.services ?? this.fallback;
  }
  list(): ProjectRuntimeInfo[] {
    return [...this.loaded.values()].map((runtime) => this.info(runtime));
  }
  get(scope: ProjectRuntimeScope, validateLocation = true): T {
    const runtime = this.loaded.get(scope.projectId);
    if (
      !runtime ||
      runtime.state !== 'ready' ||
      runtime.services.projectService.currentSessionId() !== scope.projectSessionId
    )
      throw new ProjectRuntimeScopeError('Project runtime scope is stale or unavailable.');
    if (validateLocation) this.assertLocation(runtime);
    runtime.lastUsedAt = Date.now();
    return runtime.services;
  }
  retain(services: T): () => void {
    this.references.set(services, (this.references.get(services) ?? 0) + 1);
    return () => {
      const next = (this.references.get(services) ?? 1) - 1;
      if (next > 0) this.references.set(services, next);
      else this.references.delete(services);
    };
  }
  assertBound(services: T, epoch: string | undefined): void {
    if (!epoch) {
      if (services !== this.fallback)
        throw new ProjectRuntimeScopeError(
          'Project runtime was not open when the request was queued.',
        );
      return;
    }
    const project = services.projectService.current();
    if (!project || this.get({ projectId: project.id, projectSessionId: epoch }) !== services)
      throw new ProjectRuntimeScopeError('Project runtime changed while the request was queued.');
  }
  attach(params: {
    rootPath: string;
    expectedProjectId?: string;
    recoverOnStartup?: boolean;
  }): Promise<ProjectRuntimeInfo> {
    return this.control(() => this.attachNow(params));
  }
  activate(scope: ProjectRuntimeScope): Promise<ProjectRuntimeInfo> {
    return this.control(() => {
      this.get(scope);
      this.activeProjectId = scope.projectId;
      return this.info(this.loaded.get(scope.projectId)!);
    });
  }
  unload(scope: ProjectRuntimeScope): Promise<{ closed: true }> {
    return this.control(async () => {
      this.get(scope, false);
      await this.unloadNow(scope.projectId, true);
      return { closed: true };
    });
  }
  /** Compatibility open/create replaces only the selected project, using a fresh service bundle. */
  replace(
    operation: (services: T) => Promise<unknown>,
    previous?: ProjectRuntimeScope,
  ): Promise<unknown> {
    return this.control(async () => {
      if (previous) {
        this.get(previous);
        await this.unloadNow(previous.projectId, true);
      }
      await this.ensureCapacity();
      const services = this.factory();
      try {
        const result = await operation(services);
        this.adopt(services);
        this.activeProjectId = services.projectService.current()!.id;
        return result;
      } catch (error) {
        try {
          await services.stop();
        } finally {
          services.projectService.close();
        }
        throw error;
      }
    });
  }
  closeActive(): Promise<{ closed: true }> {
    return this.control(async () => {
      if (this.activeProjectId) await this.unloadNow(this.activeProjectId);
      return { closed: true };
    });
  }
  async restoreRegistered(): Promise<void> {
    return this.control(async () => {
      for (const record of this.registrations
        .listRuntimeRegistrations()
        .filter((entry) => entry.recoverOnStartup)) {
        try {
          const location = projectContainerLocation(record.canonicalPath);
          if (location.directoryIdentity !== record.directoryIdentity)
            throw new Error('Registered project container changed.');
          const runtime = await this.attachNow({
            rootPath: record.canonicalPath,
            expectedProjectId: record.projectId,
            recoverOnStartup: true,
          });
          if (runtime.project.mode !== 'read-write')
            this.registrations.saveRuntimeRegistration({
              ...record,
              lastError: 'PROJECT_READ_ONLY',
            });
        } catch {
          this.registrations.saveRuntimeRegistration({
            ...record,
            lastError: 'PROJECT_UNAVAILABLE',
          });
        }
      }
    });
  }
  private async attachNow(params: {
    rootPath: string;
    expectedProjectId?: string;
    recoverOnStartup?: boolean;
  }): Promise<ProjectRuntimeInfo> {
    const location = projectContainerLocation(params.rootPath);
    if (lstatSync(join(location.canonicalPath, 'project.sqlite')).isSymbolicLink())
      throw new Error('Project database cannot be a link.');
    const probe = openProjectDatabase(join(location.canonicalPath, 'project.sqlite'), {
      readonly: true,
      nativeBinding: this.options.nativeBinding,
    });
    let projectId: string;
    try {
      projectId = createRepositories(probe).projects.get().id;
    } finally {
      probe.close();
    }
    if (params.expectedProjectId && params.expectedProjectId !== projectId)
      throw new ProjectRuntimeScopeError('Project identity does not match the selected container.');
    const existing = this.loaded.get(projectId);
    if (existing) {
      this.assertLocation(existing);
      if (
        existing.canonicalPath !== location.canonicalPath ||
        existing.directoryIdentity !== location.directoryIdentity
      )
        throw new Error('This project identity is already loaded from a different container.');
      if (params.recoverOnStartup !== undefined) this.save(existing, params.recoverOnStartup);
      return this.info(existing);
    }
    await this.ensureCapacity();
    const services = this.factory();
    try {
      services.projectService.open(location.canonicalPath);
      if (services.projectService.current()!.id !== projectId)
        throw new Error('Project identity changed while opening.');
      const runtime = this.adopt(services, params.recoverOnStartup);
      try {
        services.recover();
      } catch (error) {
        this.loaded.delete(projectId);
        throw error;
      }
      return this.info(runtime);
    } catch (error) {
      try {
        await services.stop();
      } finally {
        services.projectService.close();
      }
      throw error;
    }
  }
  private adopt(services: T, recoverOnStartup?: boolean): LoadedRuntime<T> {
    const project = services.projectService.current();
    if (!project) throw new Error('Project runtime did not open a project.');
    if (this.loaded.has(project.id)) throw new Error('This project identity is already loaded.');
    const location = projectContainerLocation(project.rootPath);
    const runtime: LoadedRuntime<T> = {
      services,
      ...location,
      state: 'ready',
      lastUsedAt: Date.now(),
    };
    services.projectService.setContainerGuard(() => this.assertLocation(runtime));
    this.save(
      runtime,
      recoverOnStartup ??
        this.registrations
          .listRuntimeRegistrations()
          .find((entry) => entry.projectId === project.id)?.recoverOnStartup ??
        false,
    );
    this.loaded.set(project.id, runtime);
    return runtime;
  }
  private async unloadNow(projectId: string, disableRecovery = false): Promise<void> {
    const runtime = this.loaded.get(projectId)!;
    if (disableRecovery) this.save(runtime, false);
    runtime.state = 'draining';
    try {
      await runtime.services.stop();
    } catch (error) {
      // A missing/moved container must still be fenced and its connection closed.
      let available = true;
      try {
        this.assertLocation(runtime);
      } catch {
        available = false;
      }
      if (available) throw error;
    } finally {
      try {
        runtime.services.projectService.close();
      } finally {
        this.loaded.delete(projectId);
        if (this.activeProjectId === projectId) this.activeProjectId = undefined;
      }
    }
  }
  private async ensureCapacity(): Promise<void> {
    if (this.loaded.size < (this.options.maxLoaded ?? 4)) return;
    const candidate = [...this.loaded.entries()]
      .filter(
        ([id, runtime]) =>
          id !== this.activeProjectId &&
          runtime.state === 'ready' &&
          !this.references.get(runtime.services) &&
          !runtime.services.isBusy(),
      )
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt)[0];
    if (!candidate) throw new Error('Project runtime capacity is full.');
    await this.unloadNow(candidate[0]);
  }
  private assertLocation(runtime: LoadedRuntime<T>): void {
    const current = projectContainerLocation(runtime.canonicalPath);
    if (
      current.canonicalPath !== runtime.canonicalPath ||
      current.directoryIdentity !== runtime.directoryIdentity
    )
      throw new ProjectRuntimeScopeError('Project container location changed.');
  }
  private save(runtime: LoadedRuntime<T>, recoverOnStartup: boolean) {
    this.registrations.saveRuntimeRegistration({
      projectId: runtime.services.projectService.current()!.id,
      canonicalPath: runtime.canonicalPath,
      directoryIdentity: runtime.directoryIdentity,
      recoverOnStartup,
    });
  }
  private info(runtime: LoadedRuntime<T>): ProjectRuntimeInfo {
    const project = runtime.services.projectService.current()!;
    return {
      project,
      projectSessionId: runtime.services.projectService.currentSessionId()!,
      active: this.activeProjectId === project.id,
      state: runtime.state,
    };
  }
  private control<R>(action: () => R | Promise<R>): Promise<R> {
    const result = this.tail.then(action, action);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
