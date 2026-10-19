import type { ProjectRuntimeScope, WorkerMethod, WorkerMethodMap } from '@ai-video/contracts';
import { callWorker } from './worker-client';

const scopes = new Map<string, ProjectRuntimeScope>();
let selected: ProjectRuntimeScope | undefined;
export const WORKER_SCOPE_STALE_EVENT = 'worker-project-scope-stale';

export function selectWorkerScope(scope: ProjectRuntimeScope | undefined): void {
  selected = scope ? { ...scope } : undefined;
  if (selected) {
    scopes.delete(selected.projectId);
    scopes.set(selected.projectId, selected);
    while (scopes.size > 4) scopes.delete(scopes.keys().next().value!);
  }
}

export function forgetWorkerScope(projectId: string): void {
  scopes.delete(projectId);
  if (selected?.projectId === projectId) selected = undefined;
}

export function workerScope(projectId?: string): ProjectRuntimeScope | undefined {
  const scope = projectId ? scopes.get(projectId) : selected;
  return scope ? { ...scope } : undefined;
}

export function isCurrentWorkerScope(scope: ProjectRuntimeScope | undefined): boolean {
  return (
    scope?.projectId === selected?.projectId &&
    scope?.projectSessionId === selected?.projectSessionId
  );
}

/** Capture once per view/action. Awaited follow-ups keep the original project epoch. */
export function projectWorker(scope = workerScope()): typeof callWorker {
  return async <M extends WorkerMethod>(method: M, params: WorkerMethodMap[M]['params']) => {
    const control =
      method.startsWith('project.runtime.') ||
      [
        'project.create',
        'project.createSample',
        'project.open',
        'project.restore',
        'project.recent',
        'health',
        'sqlite.probe',
      ].includes(method);
    try {
      return await (scope && !control
        ? callWorker(method, params, scope)
        : callWorker(method, params));
    } catch (error) {
      if (
        scope &&
        !control &&
        error &&
        typeof error === 'object' &&
        'workerError' in error &&
        (error.workerError as { code?: string }).code === 'STALE_SESSION'
      ) {
        // Notify the view to reattach. Never replay this action under a new epoch.
        window.dispatchEvent(new CustomEvent(WORKER_SCOPE_STALE_EVENT, { detail: { ...scope } }));
      }
      throw error;
    }
  };
}

export function workerMediaUrl(id: string, audio = false, scope = workerScope()): string {
  const query = scope ? `?${new URLSearchParams({ ...scope })}` : '';
  return `/worker-media/${audio ? 'audio/' : ''}${encodeURIComponent(id)}${query}`;
}
