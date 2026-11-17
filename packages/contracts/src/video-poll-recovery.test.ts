import { describe, expect, it } from 'vitest';
import type { VideoGenerationJobInfo } from './index.js';
import { canResumeVideoPolling } from './video-poll-recovery.js';

type Job = Parameters<typeof canResumeVideoPolling>[0];
const legacy: Job = {
  status: 'failed',
  providerTaskId: 'accepted-task',
  metadata: { providerRegion: 'unicompapi', pollAttempts: 0, failureKind: 'transport' },
  error: 'Native Provider error is invalid.',
  results: [],
};

describe('video polling recovery eligibility', () => {
  it('allows resuming an accepted task paused locally or misclassified by an older build', () => {
    expect(canResumeVideoPolling(legacy)).toBe(true);
    expect(canResumeVideoPolling({ ...legacy, status: 'paused', error: undefined })).toBe(true);
  });

  it.each<Partial<Job>>([
    { providerTaskId: undefined },
    { status: 'cancelled' },
    { status: 'succeeded' },
    { metadata: { ...legacy.metadata, failureKind: 'provider' } },
    { metadata: { ...legacy.metadata, failureKind: 'download' } },
    { metadata: { ...legacy.metadata, pollRecoveryJobId: 'existing-recovery' } },
    { error: 'fetch failed: ECONNRESET' },
    { error: 'Native Provider params contain an unknown field' },
    { results: [{} as VideoGenerationJobInfo['results'][number]] },
  ])('does not reopen unrelated terminal jobs: %j', (overrides) => {
    expect(canResumeVideoPolling({ ...legacy, ...overrides })).toBe(false);
  });
});
