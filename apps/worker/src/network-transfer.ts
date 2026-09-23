import {
  retryAfterMs,
  sharedNetworkAdmission,
  type NetworkAdmission,
  type NetworkOutcome,
} from '@ai-video/llm';

type ReadBody = <T>(operation: () => Promise<T>) => Promise<T>;

/** Hold admission through body consumption; local validation/storage errors stay neutral. */
export async function withNetworkResponse<T>(
  url: string,
  init: Pick<RequestInit, 'signal' | 'headers' | 'redirect'>,
  consume: (response: Response, read: ReadBody) => Promise<T>,
  admission: Pick<NetworkAdmission, 'acquire'> = sharedNetworkAdmission,
): Promise<T> {
  let target = url;
  for (let redirects = 0; ; redirects += 1) {
    const permit = await admission.acquire(target, init.signal ?? undefined);
    const controller = new AbortController();
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    let outcome: NetworkOutcome = { kind: 'neutral' };
    let response: Response | undefined;
    const read: ReadBody = async (operation) => {
      try {
        return await operation();
      } catch (error) {
        const reason: unknown = init.signal?.reason;
        const timedOut = reason instanceof Error && reason.name === 'TimeoutError';
        const cancelled = init.signal?.aborted && !timedOut;
        if (!cancelled && outcome.kind === 'neutral') outcome = { kind: 'failure' };
        throw error;
      }
    };
    try {
      response = await read(() => fetch(target, { ...init, signal, redirect: 'manual' }));
      if (response.status === 429) {
        outcome = {
          kind: 'cooldown',
          retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
        };
      } else if (response.status === 408 || response.status >= 500) {
        outcome = { kind: 'failure' };
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (init.redirect === 'error') throw new Error('Network redirect is not allowed.');
        const location = response.headers.get('location');
        if (location && init.redirect !== 'manual') {
          if (redirects >= 20) throw new Error('Network redirect limit exceeded.');
          const next = new URL(location, target);
          if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password)
            throw new Error('Network redirect target is invalid.');
          target = next.href;
          continue;
        }
      }
      const result = await consume(response, read);
      if (response.ok) outcome = { kind: 'success' };
      return result;
    } finally {
      // Abort unread/locked bodies before giving another transfer the slot.
      controller.abort();
      if (response?.body && !response.body.locked) {
        void response.body.cancel().catch(() => undefined);
      }
      permit.finish(outcome);
    }
  }
}
