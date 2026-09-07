import { useEffect, useState } from 'react';
import type { ProjectTaskSnapshot } from '@ai-video/contracts';
import { callWorker } from './worker-client';

const ACTIVE_REFRESH_MS = 1_000;
const IDLE_REFRESH_MS = 5_000;

export function useProjectTaskSubscription(projectId?: string): ProjectTaskSnapshot | undefined {
  const [snapshot, setSnapshot] = useState<ProjectTaskSnapshot>();

  useEffect(() => {
    let active = true;
    let timer: number | undefined;
    let revision = -1;
    let activeCount = 0;
    let receivedSnapshot = false;
    setSnapshot(undefined);
    if (!projectId) return () => undefined;

    const subscribe = async () => {
      try {
        const next = await callWorker('project.task.subscribe', { afterRevision: revision });
        if (!active || next.projectId !== projectId) return;
        revision = next.revision;
        activeCount = next.activeCount;
        if (!receivedSnapshot || next.changed) {
          receivedSnapshot = true;
          setSnapshot(next);
        }
      } catch {
        // Project open/close can race one bounded refresh; the next interval resubscribes.
      } finally {
        if (active) {
          timer = window.setTimeout(
            () => void subscribe(),
            activeCount > 0 ? ACTIVE_REFRESH_MS : IDLE_REFRESH_MS,
          );
        }
      }
    };

    void subscribe();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [projectId]);

  return snapshot;
}
