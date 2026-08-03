import type { UsageQueryParams, UsageQueryResult, UsageRebuildResult } from '@ai-video/contracts';
import { callWorker } from './worker-client';

export const usageClient = {
  list: (params: UsageQueryParams): Promise<UsageQueryResult> => callWorker('usage.list', params),
  rebuild: (): Promise<UsageRebuildResult> => callWorker('usage.rebuild', {}),
};
