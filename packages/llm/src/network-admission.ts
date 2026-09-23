/** Process-local protection for the legacy development transport. */
export interface NetworkAdmissionPolicy {
  globalConcurrency: number;
  serviceConcurrency: number;
  globalRate: number;
  serviceRate: number;
  globalBurst: number;
  serviceBurst: number;
  globalQueue: number;
  serviceQueue: number;
  queueTimeoutMs: number;
  failureThreshold: number;
  failureWindowMs: number;
  circuitCooldownMs: number;
  serviceLimit: number;
}

const DEFAULT_POLICY: NetworkAdmissionPolicy = {
  globalConcurrency: 8,
  serviceConcurrency: 3,
  globalRate: 4,
  serviceRate: 2,
  globalBurst: 8,
  serviceBurst: 3,
  globalQueue: 32,
  serviceQueue: 8,
  queueTimeoutMs: 10_000,
  failureThreshold: 5,
  failureWindowMs: 60_000,
  circuitCooldownMs: 30_000,
  serviceLimit: 256,
};

type Refusal =
  'REQUEST_QUEUE_FULL' | 'REQUEST_QUEUE_TIMEOUT' | 'PROVIDER_CIRCUIT_OPEN' | 'PROVIDER_COOLDOWN';

export class NetworkAdmissionError extends Error {
  readonly code = 'REQUEST_NOT_SENT';
  readonly retryable = true;

  constructor(readonly reason: Refusal) {
    const messages: Record<Refusal, string> = {
      REQUEST_QUEUE_FULL: '当前请求较多，本次请求尚未发送，请稍后重试。',
      REQUEST_QUEUE_TIMEOUT: '排队等待超时，本次请求尚未发送，请稍后重试。',
      PROVIDER_CIRCUIT_OPEN: '服务连续出错，已暂时停止发送请求，请稍后重试。',
      PROVIDER_COOLDOWN: '服务正在限流，本次请求尚未发送，请稍后重试。',
    };
    super(`${reason}: ${messages[reason]}`);
  }
}

export type NetworkOutcome =
  { kind: 'success' | 'failure' | 'neutral' } | { kind: 'cooldown'; retryAfterMs: number };

export interface NetworkPermit {
  finish(outcome: NetworkOutcome): void;
}

interface Bucket {
  tokens: number;
  at: number;
}

interface Service {
  active: number;
  bucket: Bucket;
  failures: number[];
  epoch: number;
  openUntil: number;
  probing: boolean;
  cooldownUntil: number;
}

interface Waiting {
  service: Service;
  deadline: number;
  signal?: AbortSignal;
  abort: () => void;
  resolve(permit: NetworkPermit): void;
  reject(error: Error): void;
}

/** No credentials, full URLs, request bodies or automatic retries are stored here. */
export class NetworkAdmission {
  private readonly policy: NetworkAdmissionPolicy;
  private readonly services = new Map<string, Service>();
  private readonly global: Bucket;
  private active = 0;
  private readonly waiting: Waiting[] = [];
  private timer?: ReturnType<typeof setTimeout>;
  private lastServed?: Service;

  constructor(policy: Partial<NetworkAdmissionPolicy> = {}) {
    this.policy = { ...DEFAULT_POLICY, ...policy };
    for (const value of Object.values(this.policy)) {
      if (!Number.isFinite(value) || value <= 0)
        throw new Error('Invalid network admission policy.');
    }
    this.global = { tokens: this.policy.globalBurst, at: performance.now() };
  }

  acquire(url: string, signal?: AbortSignal): Promise<NetworkPermit> {
    if (signal?.aborted) return Promise.reject(aborted(signal));
    const origin = new URL(url).origin;
    let service = this.services.get(origin);
    if (!service) {
      if (this.services.size >= this.policy.serviceLimit && !this.evictIdleService()) {
        return Promise.reject(new NetworkAdmissionError('REQUEST_QUEUE_FULL'));
      }
      service = {
        active: 0,
        bucket: { tokens: this.policy.serviceBurst, at: performance.now() },
        failures: [],
        epoch: 0,
        openUntil: 0,
        probing: false,
        cooldownUntil: 0,
      };
      this.services.set(origin, service);
    }
    const refusal = this.refusal(service, performance.now());
    if (refusal) return Promise.reject(new NetworkAdmissionError(refusal));
    // Flush expired/cancelled work before enforcing the queue bounds.
    this.pump();
    const waitingForService = this.waiting.filter((entry) => entry.service === service).length;
    if (waitingForService === 0 && this.canStart(service, performance.now())) {
      return Promise.resolve(this.start(service));
    }
    if (
      this.waiting.length >= this.policy.globalQueue ||
      waitingForService >= this.policy.serviceQueue
    ) {
      return Promise.reject(new NetworkAdmissionError('REQUEST_QUEUE_FULL'));
    }
    return new Promise((resolve, reject) => {
      const entry: Waiting = {
        service,
        deadline: performance.now() + this.policy.queueTimeoutMs,
        signal,
        abort: () => {
          this.remove(entry);
          reject(aborted(signal));
          this.pump();
        },
        resolve,
        reject,
      };
      this.waiting.push(entry);
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.pump();
    });
  }

  private refusal(service: Service, now: number): Refusal | undefined {
    if (service.cooldownUntil > now) return 'PROVIDER_COOLDOWN';
    if (service.openUntil > now || service.probing) return 'PROVIDER_CIRCUIT_OPEN';
    return undefined;
  }

  private evictIdleService(): boolean {
    const now = performance.now();
    for (const [origin, service] of this.services) {
      this.refill(service.bucket, this.policy.serviceRate, this.policy.serviceBurst, now);
      if (
        service.active === 0 &&
        !this.waiting.some((entry) => entry.service === service) &&
        service.openUntil === 0 &&
        service.cooldownUntil <= now &&
        service.bucket.tokens >= this.policy.serviceBurst &&
        service.failures.every((at) => now - at > this.policy.failureWindowMs)
      ) {
        this.services.delete(origin);
        return true;
      }
    }
    return false;
  }

  private refill(bucket: Bucket, rate: number, burst: number, now: number): void {
    bucket.tokens = Math.min(burst, bucket.tokens + (Math.max(0, now - bucket.at) * rate) / 1000);
    bucket.at = now;
  }

  private canStart(service: Service, now: number): boolean {
    this.refill(this.global, this.policy.globalRate, this.policy.globalBurst, now);
    this.refill(service.bucket, this.policy.serviceRate, this.policy.serviceBurst, now);
    return (
      !this.refusal(service, now) &&
      this.active < this.policy.globalConcurrency &&
      service.active < this.policy.serviceConcurrency &&
      this.global.tokens >= 1 &&
      service.bucket.tokens >= 1
    );
  }

  private start(service: Service): NetworkPermit {
    this.active++;
    service.active++;
    this.global.tokens--;
    service.bucket.tokens--;
    const epoch = service.epoch;
    const probe = service.openUntil !== 0;
    if (probe) service.probing = true;
    this.lastServed = service;
    let finished = false;
    return {
      finish: (outcome) => {
        if (finished) return;
        finished = true;
        this.active--;
        service.active--;
        const now = performance.now();
        if (outcome.kind === 'cooldown') {
          const duration = Number.isFinite(outcome.retryAfterMs)
            ? Math.max(0, Math.min(outcome.retryAfterMs, 30 * 60_000))
            : 30_000;
          service.cooldownUntil = Math.max(service.cooldownUntil, now + duration);
        }
        if (epoch === service.epoch) {
          if (probe) service.probing = false;
          if (outcome.kind === 'success') {
            service.failures = [];
            service.openUntil = 0;
          } else if (outcome.kind === 'failure') {
            service.failures = service.failures.filter(
              (at) => now - at <= this.policy.failureWindowMs,
            );
            service.failures.push(now);
            if (probe || service.failures.length >= this.policy.failureThreshold) {
              service.epoch++;
              service.openUntil = now + this.policy.circuitCooldownMs;
              service.probing = false;
            }
          } else if (probe) {
            // A cancelled or rejected probe does not establish service health.
            service.openUntil = now;
          } else if (outcome.kind !== 'neutral') {
            service.failures = [];
          }
        }
        this.pump();
      },
    };
  }

  private remove(entry: Waiting): void {
    const index = this.waiting.indexOf(entry);
    if (index >= 0) this.waiting.splice(index, 1);
    entry.signal?.removeEventListener('abort', entry.abort);
  }

  private pump(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const now = performance.now();
    for (const entry of [...this.waiting]) {
      const refusal = this.refusal(entry.service, now);
      if (entry.signal?.aborted || refusal || entry.deadline <= now) {
        this.remove(entry);
        entry.reject(
          entry.signal?.aborted
            ? aborted(entry.signal)
            : new NetworkAdmissionError(refusal ?? 'REQUEST_QUEUE_TIMEOUT'),
        );
      }
    }
    // Round-robin across services while preserving each service's FIFO order.
    while (this.active < this.policy.globalConcurrency) {
      const heads = this.waiting.filter(
        (entry, index, entries) =>
          entries.findIndex((other) => other.service === entry.service) === index,
      );
      const lastIndex = heads.findIndex((entry) => entry.service === this.lastServed);
      const ordered = [...heads.slice(lastIndex + 1), ...heads.slice(0, lastIndex + 1)];
      const next = ordered.find((entry) => this.canStart(entry.service, now));
      if (!next) break;
      this.remove(next);
      next.resolve(this.start(next.service));
    }
    if (this.waiting.length === 0) return;
    let delay = Math.min(...this.waiting.map((entry) => entry.deadline - now));
    for (const entry of this.waiting) {
      if (
        this.active >= this.policy.globalConcurrency ||
        entry.service.active >= this.policy.serviceConcurrency
      )
        continue;
      const tokenDelay = Math.max(
        ((1 - this.global.tokens) * 1000) / this.policy.globalRate,
        ((1 - entry.service.bucket.tokens) * 1000) / this.policy.serviceRate,
      );
      delay = Math.min(delay, Math.max(1, Math.ceil(tokenDelay)));
    }
    this.timer = setTimeout(() => this.pump(), Math.max(1, delay));
  }
}

function aborted(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new DOMException('Aborted', 'AbortError');
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  const numeric =
    value !== null && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : NaN;
  const duration = Number.isFinite(numeric) ? numeric : value ? Date.parse(value) - now : NaN;
  return Number.isFinite(duration) ? Math.max(0, Math.min(duration, 30 * 60_000)) : 30_000;
}

export const sharedNetworkAdmission = new NetworkAdmission();
