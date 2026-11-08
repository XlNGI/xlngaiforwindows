import type { AgentTaskDetail } from '@ai-video/contracts';

type Changes = NonNullable<AgentTaskDetail['resourceChanges']>;
type Kind = 'documentSequence' | 'productionSequence';
type Refresh = (kind: Kind) => Promise<void>;

/** Acknowledge committed changes only after a successful view refresh. */
export class AgentResourceRefresh {
  private scope = '';
  private readonly tasks = new Map<
    string,
    { target: Changes; ack: Changes; pending: boolean; refresh: Refresh }
  >();

  observe(scope: string, taskId: string, changes: Changes, refresh: Refresh): void {
    if (this.scope !== scope) {
      this.scope = scope;
      this.tasks.clear();
    }
    let state = this.tasks.get(taskId);
    if (!state) {
      state = {
        target: changes,
        ack: { sequence: 0, documentSequence: 0, productionSequence: 0 },
        pending: false,
        refresh,
      };
      this.tasks.set(taskId, state);
    }
    state.target = changes;
    state.refresh = refresh;
    if (state.pending) return;
    const entry = state;
    entry.pending = true;
    void (async () => {
      for (const kind of ['documentSequence', 'productionSequence'] as const) {
        while (
          this.scope === scope &&
          this.tasks.get(taskId) === entry &&
          entry.target[kind] > entry.ack[kind]
        ) {
          const sequence = entry.target[kind];
          try {
            await entry.refresh(kind);
          } catch {
            break;
          } // The next poll retries; a failure never acknowledges data.
          if (this.scope !== scope || this.tasks.get(taskId) !== entry) break;
          entry.ack[kind] = sequence;
        }
      }
    })().finally(() => {
      entry.pending = false;
    });
  }
}
