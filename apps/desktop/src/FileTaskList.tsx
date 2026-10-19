import { useEffect, useState } from 'react';
import type { FileTaskInfo, NovelMarkdownExportJobInfo } from '@ai-video/contracts';
import { projectWorker } from './worker-scope';

export function FileTaskList({ projectId }: { projectId?: string }) {
  const client = projectWorker();
  const [files, setFiles] = useState<FileTaskInfo[]>([]),
    [exports, setExports] = useState<NovelMarkdownExportJobInfo[]>([]),
    [error, setError] = useState('');
  useEffect(() => {
    if (!projectId) return;
    let active = true,
      pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const [nextFiles, nextExports] = await Promise.all([
          client('file.task.list', {}),
          client('novel.export.list', {}),
        ]);
        if (active) {
          setFiles(nextFiles ?? []);
          setExports(nextExports ?? []);
        }
      } catch (reason) {
        if (active) setError(reason instanceof Error ? reason.message : '文件任务读取失败');
      } finally {
        pending = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [projectId]);
  if (!files.length && !exports.length && !error) return null;
  const status = (value: string) =>
    ({
      pending: '排队',
      queued: '排队',
      running: '执行中',
      writing: '写入中',
      verifying: '校验中',
      succeeded: '完成',
      failed: '失败',
      cancelled: '已取消',
      interrupted: '已中断',
    })[value] ?? value;
  return (
    <section aria-label="文件任务" className="task-log-detail-section">
      <strong>文件任务</strong>
      {files.map((job) => (
        <div key={job.id}>
          <span>
            {job.kind === 'project-export'
              ? '项目导出'
              : job.kind === 'project-backup'
                ? '项目备份'
                : '小说导入'}{' '}
            · {status(job.status)} · {job.progress}%
          </span>
          {job.result && 'path' in job.result && <small>{job.result.path}</small>}
          {job.error && <small>{job.error}</small>}
          {['pending', 'running'].includes(job.status) && (
            <button
              type="button"
              onClick={() =>
                void client('file.task.cancel', { taskId: job.id })
                  .then((next) =>
                    setFiles((current) =>
                      current.map((item) => (item.id === next.id ? next : item)),
                    ),
                  )
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : '取消失败'),
                  )
              }
            >
              取消此文件任务
            </button>
          )}
        </div>
      ))}
      {exports.map((job) => (
        <div key={job.id}>
          <span>
            小说导出 · {status(job.status)} · {job.itemCount} 章
          </span>
          {job.errorMessage && <small>{job.errorMessage}</small>}
          {['queued', 'writing', 'verifying'].includes(job.status) ? (
            <button
              type="button"
              onClick={() =>
                void client('novel.export.cancel', { jobId: job.id })
                  .then((next) =>
                    setExports((current) =>
                      current.map((item) => (item.id === next.id ? next : item)),
                    ),
                  )
                  .catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : '取消失败'),
                  )
              }
            >
              取消此小说导出
            </button>
          ) : (
            job.status === 'succeeded' && (
              <button
                type="button"
                onClick={() =>
                  void client('novel.export.reveal', { jobId: job.id }).catch((reason: unknown) =>
                    setError(reason instanceof Error ? reason.message : '打开失败'),
                  )
                }
              >
                打开导出文件夹
              </button>
            )
          )}
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
