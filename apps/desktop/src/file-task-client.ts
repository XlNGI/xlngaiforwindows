import type { FileTaskInfo, NovelMarkdownExportJobInfo } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 250));
export async function observeFileTask(
  initial: FileTaskInfo,
  client = projectWorker(),
  onProgress?: (job: FileTaskInfo) => void,
): Promise<FileTaskInfo> {
  let job = initial;
  while (['pending', 'running'].includes(job.status)) {
    onProgress?.(job);
    await delay();
    job = await client('file.task.get', { taskId: job.id });
  }
  onProgress?.(job);
  if (job.status !== 'succeeded')
    throw new Error(job.error ?? `文件任务${job.status === 'cancelled' ? '已取消' : '未完成'}`);
  return job;
}
export async function observeMarkdownExport(
  initial: NovelMarkdownExportJobInfo,
  client = projectWorker(),
): Promise<NovelMarkdownExportJobInfo> {
  let job = initial;
  while (['queued', 'writing', 'verifying'].includes(job.status)) {
    await delay();
    job = await client('novel.export.get', { jobId: job.id });
  }
  return job;
}
