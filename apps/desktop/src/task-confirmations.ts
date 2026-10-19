import type {
  AgentToolConfirmationRequest,
  MediaModelSelectionRequest,
  MediaModelSelectionDecision,
  MediaSubmissionConfirmationRequest,
} from '@ai-video/contracts';

type Requests = {
  tool: AgentToolConfirmationRequest;
  model: MediaModelSelectionRequest;
  paid: MediaSubmissionConfirmationRequest;
};
type Decisions = { tool: boolean; model: MediaModelSelectionDecision | undefined; paid: boolean };
export type TaskConfirmation = {
  [K in keyof Requests]: {
    key: string;
    owner: string;
    label: string;
    kind: K;
    request: Requests[K];
    referenceImageInputs?: string[];
  };
}[keyof Requests];

/** Resolvers belong to an immutable owner/token pair, never to the visible modal. */
export class TaskConfirmationQueue {
  private entries: Array<{
    item: TaskConfirmation;
    resolve(value: unknown): void;
    promise: Promise<unknown>;
    timer?: ReturnType<typeof setTimeout>;
  }> = [];
  constructor(private readonly changed: (items: TaskConfirmation[]) => void) {}

  request<K extends keyof Requests>(
    owner: string,
    label: string,
    kind: K,
    request: Requests[K],
    referenceImageInputs?: string[],
  ): Promise<Decisions[K]> {
    const token = 'selectionToken' in request ? request.selectionToken : request.confirmationToken;
    const key = `${owner}:${kind}:${token}`;
    const existing = this.entries.find((entry) => entry.item.key === key);
    if (existing) return existing.promise as Promise<Decisions[K]>;
    let resolve!: (value: unknown) => void;
    const promise = new Promise<unknown>((settle) => {
      resolve = settle;
    });
    this.entries.push({
      item: {
        key,
        owner,
        label,
        kind,
        request,
        referenceImageInputs: referenceImageInputs ? [...referenceImageInputs] : undefined,
      } as TaskConfirmation,
      resolve,
      promise,
    });
    const delay = Date.parse(request.expiresAt) - Date.now();
    if (Number.isFinite(delay))
      this.entries.at(-1)!.timer = setTimeout(
        () => this.decide(key, kind === 'model' ? undefined : false),
        Math.max(0, Math.min(delay, 2_147_483_647)),
      );
    this.publish();
    return promise as Promise<Decisions[K]>;
  }
  decide(key: string, value: Decisions[keyof Decisions]): void {
    const index = this.entries.findIndex((entry) => entry.item.key === key);
    if (index < 0) return;
    const [entry] = this.entries.splice(index, 1);
    clearTimeout(entry!.timer);
    entry!.resolve(value);
    this.publish();
  }
  removeOwner(owner: string): void {
    for (const { item } of [...this.entries])
      if (item.owner === owner) this.decide(item.key, item.kind === 'model' ? undefined : false);
  }
  private publish(): void {
    this.changed(this.entries.map((entry) => entry.item));
  }
}
