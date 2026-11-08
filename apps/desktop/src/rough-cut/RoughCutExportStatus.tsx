import { useEffect, useMemo, useState } from 'react';
import { FolderOpen, X } from 'lucide-react';
import type { RoughCutExportJob } from '@ai-video/contracts';
import { projectWorker } from '../worker-scope';

export function RoughCutExportStatus({
  initial,
  onDismiss,
  onUpdate,
}: {
  initial: RoughCutExportJob;
  onDismiss: () => void;
  onUpdate?: (job: RoughCutExportJob) => void;
}) {
  const call = useMemo(() => projectWorker(), []);
  const [job, setJob] = useState(initial);
  const [pollError, setPollError] = useState('');
  const [actionError, setActionError] = useState('');
  const [opening, setOpening] = useState(false);
  const openFolder = async () => {
    setOpening(true);
    setActionError('');
    try {
      await call('roughCut.export.reveal', { id: job.id });
    } catch (reason) {
      setActionError(`打开导出文件夹失败：${String(reason)}`);
    } finally {
      setOpening(false);
    }
  };
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await call('roughCut.export.get', { id: initial.id });
        if (!active) return;
        setPollError('');
        setJob(next);
        onUpdate?.(next);
        if (next.status === 'running') timer = setTimeout(() => void poll(), 1000);
      } catch (reason) {
        if (active) {
          setPollError(String(reason));
          timer = setTimeout(() => void poll(), 3000);
        }
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [call, initial.id, onUpdate]);
  return (
    <div className="rough-cut-export-status" role="status">
      <span>
        {job.format === 'xml' ? 'XML 剪辑包' : 'MP4'} ·{' '}
        {job.status === 'running'
          ? `正在导出 ${job.completedClips}/${job.totalClips}`
          : job.status === 'succeeded'
            ? '导出完成'
            : job.status === 'cancelled'
              ? '已取消'
              : '导出失败'}
      </span>
      {job.status === 'running' && (
        <progress
          aria-label="导出进度"
          value={job.completedClips}
          max={Math.max(1, job.totalClips)}
        />
      )}
      {job.status === 'running' ? (
        <button
          type="button"
          className="button subtle"
          onClick={() =>
            void call('roughCut.export.cancel', { id: job.id }).catch((reason) =>
              setActionError(String(reason)),
            )
          }
        >
          取消导出
        </button>
      ) : (
        <>
          {job.status === 'succeeded' && (
            <button
              type="button"
              className="button subtle"
              disabled={opening}
              aria-busy={opening}
              onClick={() => void openFolder()}
            >
              <FolderOpen size={14} />
              {opening ? '正在打开…' : '打开导出文件夹'}
            </button>
          )}
          <button
            type="button"
            className="icon-button"
            aria-label="关闭导出提示"
            onClick={onDismiss}
          >
            <X size={14} />
          </button>
        </>
      )}
      {job.status === 'succeeded' && job.path && (
        <div className="rough-cut-export-location">
          <span>{job.format === 'mp4' ? '成片已保存：' : '剪辑包已保存：'}</span>
          <span className="rough-cut-export-path" title={job.path}>
            {job.path.replace(/[\\/]$/, '')}
            {job.format === 'mp4' ? `${job.path.includes('\\') ? '\\' : '/'}rough-cut.mp4` : ''}
          </span>
        </div>
      )}
      {(job.error || actionError || pollError) && (
        <span className="rough-cut-error">{actionError || pollError || job.error}</span>
      )}
    </div>
  );
}
