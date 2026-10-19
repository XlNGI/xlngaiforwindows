/** Process-wide video dispatch capacity, shared by all loaded project runtimes. */
export class TaskCapacity {
  private readonly active = new Map<string, 'submit' | 'poll'>();
  private readonly waiting = new Map<string, { stage: 'submit' | 'poll'; owner: string }>();
  private readonly lastServed = new Map<string, string>();
  private lastPollAt = -Infinity;
  acquire(
    id: string,
    stage: 'submit' | 'poll',
    now = performance.now(),
    requestKey = id,
    owner = requestKey,
  ): boolean {
    if (this.active.has(id)) return false;
    if (!this.waiting.has(requestKey)) this.waiting.set(requestKey, { stage, owner });
    if ([...this.active.values()].filter((item) => item === stage).length >= 2) return false;
    if (stage === 'poll' && now - this.lastPollAt < 500) return false;
    const pending = [...this.waiting.entries()].filter(([, request]) => request.stage === stage);
    const next =
      pending.find(([, request]) => request.owner !== this.lastServed.get(stage)) ?? pending[0];
    if (next?.[0] !== requestKey) return false;
    this.waiting.delete(requestKey);
    this.active.set(id, stage);
    this.lastServed.set(stage, owner);
    if (stage === 'poll') this.lastPollAt = now;
    return true;
  }
  release(id: string): void {
    this.active.delete(id);
  }
  cancelWaiting(key: string): void {
    this.waiting.delete(key);
  }
  cancelOwnerWaiting(owner: string): void {
    for (const [key, request] of this.waiting)
      if (request.owner === owner) this.waiting.delete(key);
  }
}
