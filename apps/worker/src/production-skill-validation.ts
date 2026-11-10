import type Database from 'better-sqlite3';
import { isBundleTask, retiredBundleStatus } from './production-bundle-state.js';
import { bundleCompletion } from './production-bundle-service.js';
/** Structured candidate validation, atomic commit and independent readback. */
export function scriptToMediaCompletionPending(
  db: Database.Database,
  projectId: string,
  _generationId: string,
  taskId: string,
): Array<Record<string, unknown>> | undefined {
  if (!isBundleTask(db, taskId)) return undefined;
  const retired = retiredBundleStatus(db, projectId, taskId);
  if (retired) return [retired];
  return bundleCompletion(db, projectId, taskId);
}
