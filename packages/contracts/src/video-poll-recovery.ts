import type { VideoGenerationJobInfo } from './index.js';

/** Local Native/Worker contract errors do not establish a remote task failure. */
export function isNativeVideoPollContractError(message: string): boolean {
  return /^Native Provider (?:poll result must be an object\.|(?:poll status|task state(?: detail)?|progress|Retry-After value|cost|output|error) is invalid\.|(?:output|error) does not match its task state\.|result contains an unknown field:)/.test(
    message.trim(),
  );
}

/** Also recover the narrowly identified false failures saved by older builds. */
export function canResumeVideoPolling(
  job: Pick<VideoGenerationJobInfo, 'status' | 'providerTaskId' | 'metadata' | 'error' | 'results'>,
): boolean {
  if (!job.providerTaskId || job.results.length > 0 || job.metadata.pollRecoveryJobId) return false;
  return (
    job.status === 'paused' ||
    (job.status === 'failed' &&
      job.metadata.failureKind === 'transport' &&
      isNativeVideoPollContractError(job.error ?? ''))
  );
}
