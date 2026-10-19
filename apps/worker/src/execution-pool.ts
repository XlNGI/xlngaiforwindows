export type ExecutionStage =
  'text' | 'media-submit' | 'download' | 'speech' | 'lip-sync' | 'ffmpeg' | 'file-io';
const LIMITS: Record<ExecutionStage, number> = {
  text: 4,
  'media-submit': 2,
  download: 2,
  speech: 2,
  'lip-sync': 2,
  ffmpeg: 1,
  'file-io': 1,
};
export interface ExecutionLease {
  suspend<T>(wait: () => Promise<T>): Promise<T>;
}
interface Ticket {
  stage: ExecutionStage;
  owner: string;
  signal?: AbortSignal;
  start(): void;
  reject(reason: unknown): void;
  abort?: () => void;
}

/** Process-wide stage admission. Waiting prerequisites must never hold a slot. */
export class ExecutionPool {
  private readonly active = new Set<Ticket>();
  private readonly queue: Ticket[] = [];
  private readonly lastOwner = new Map<ExecutionStage, string>();

  async run<T>(
    stage: ExecutionStage,
    owner: string,
    signal: AbortSignal | undefined,
    work: (lease: ExecutionLease) => Promise<T>,
  ): Promise<T> {
    let ticket: Ticket | undefined = await this.acquire(stage, owner, signal);
    let suspended = false;
    const release = () => {
      if (ticket) {
        signal?.removeEventListener('abort', ticket.abort!);
        this.active.delete(ticket);
        ticket = undefined;
        this.pump();
      }
    };
    const lease: ExecutionLease = {
      suspend: async <T>(wait: () => Promise<T>): Promise<T> => {
        if (suspended || !ticket) throw new Error('Execution is already suspended.');
        suspended = true;
        release();
        try {
          const value = await wait();
          ticket = await this.acquire(stage, owner, signal);
          return value;
        } finally {
          suspended = false;
        }
      },
    };
    try {
      signal?.throwIfAborted();
      return await work(lease);
    } finally {
      release();
    }
  }
  private acquire(stage: ExecutionStage, owner: string, signal?: AbortSignal): Promise<Ticket> {
    signal?.throwIfAborted();
    if (this.queue.length >= 128 || this.queue.filter((item) => item.owner === owner).length >= 32)
      throw new Error('Task execution queue is full.');
    return new Promise<Ticket>((resolve, reject) => {
      const ticket: Ticket = { stage, owner, signal, start: () => resolve(ticket), reject };
      ticket.abort = () => {
        const index = this.queue.indexOf(ticket);
        if (index >= 0) {
          this.queue.splice(index, 1);
          reject(
            signal?.reason instanceof Error ? signal.reason : new Error('Execution cancelled.'),
          );
          this.pump();
        }
      };
      signal?.addEventListener('abort', ticket.abort, { once: true });
      this.queue.push(ticket);
      this.pump();
    });
  }
  private pump(): void {
    for (const stage of Object.keys(LIMITS) as ExecutionStage[]) {
      for (;;) {
        const active = [...this.active].filter((item) => item.stage === stage);
        if (active.length >= LIMITS[stage]) break;
        const candidates = this.queue.filter(
          (item) =>
            item.stage === stage &&
            (stage !== 'text' || active.filter((run) => run.owner === item.owner).length < 2),
        );
        const next =
          candidates.find((item) => item.owner !== this.lastOwner.get(stage)) ?? candidates[0];
        if (!next) break;
        this.queue.splice(this.queue.indexOf(next), 1);
        this.active.add(next);
        this.lastOwner.set(stage, next.owner);
        next.start();
      }
    }
  }
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  limit: number,
  fn: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await fn(values[index]!, index);
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failed = outcomes.find((outcome) => outcome.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
  return results;
}
