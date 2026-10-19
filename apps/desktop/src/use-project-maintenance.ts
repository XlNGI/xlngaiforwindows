import { useProjectViewState } from './use-project-view-state';
import type {
  CacheInspectionResult,
  DiagnosticExportResult,
  ProjectInfo,
  WorkerMetricsSnapshot,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';

export interface UseProjectMaintenanceOptions {
  runProjectAction: (
    action: () => Promise<ProjectInfo | string | undefined>,
  ) => Promise<void | undefined>;
  onCloseSettings: () => void;
}

export function useProjectMaintenance({
  runProjectAction,
  onCloseSettings,
}: UseProjectMaintenanceOptions) {
  const callWorker = projectWorker();
  const [maintenanceBusy, setMaintenanceBusy] = useProjectViewState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useProjectViewState('');
  const [cacheInspection, setCacheInspection] = useProjectViewState<CacheInspectionResult>();
  const [workerMetrics, setWorkerMetrics] = useProjectViewState<WorkerMetricsSnapshot>();
  const [diagnosticExport, setDiagnosticExport] = useProjectViewState<DiagnosticExportResult>();
  const [diagnosticDestination, setDiagnosticDestination] = useProjectViewState('');
  const [exportDestination, setExportDestination] = useProjectViewState('');
  const [restoreBackupPath, setRestoreBackupPath] = useProjectViewState('');
  const [restoreDestination, setRestoreDestination] = useProjectViewState('');

  const runMaintenanceAction = async (action: () => Promise<string>) => {
    setMaintenanceBusy(true);
    setMaintenanceMessage('');
    try {
      setMaintenanceMessage(await action());
    } catch (reason) {
      setMaintenanceMessage(reason instanceof Error ? reason.message : '项目维护操作失败');
    } finally {
      setMaintenanceBusy(false);
    }
  };

  const inspectCache = () =>
    runMaintenanceAction(async () => {
      const result = await callWorker('maintenance.cache.inspect', {});
      setCacheInspection(result);
      return `缓存占用 ${(result.sizeBytes / 1024 / 1024).toFixed(2)} MiB`;
    });

  const clearCache = () => {
    if (!window.confirm('确定清理当前项目的媒体缓存？已保存素材不会被删除。')) return;
    return runMaintenanceAction(async () => {
      const result = await callWorker('maintenance.cache.clear', {});
      const next = await callWorker('maintenance.cache.inspect', {});
      setCacheInspection(next);
      return `已释放 ${(result.freedBytes / 1024 / 1024).toFixed(2)} MiB，删除 ${result.removedFiles} 个缓存文件`;
    });
  };

  const refreshMetrics = () =>
    runMaintenanceAction(async () => {
      const result = await callWorker('maintenance.metrics', {});
      setWorkerMetrics(result);
      return `已记录 ${result.totals.requests} 次请求，失败 ${result.totals.errors} 次`;
    });

  const exportDiagnostics = () =>
    runMaintenanceAction(async () => {
      const result = await callWorker('maintenance.diagnostics.export', {
        destinationRoot: diagnosticDestination.trim() || undefined,
      });
      setDiagnosticExport(result);
      return '脱敏诊断包已导出';
    });

  const revealDiagnostics = () => {
    if (!diagnosticExport) return;
    return runMaintenanceAction(async () => {
      await callWorker('maintenance.diagnostics.reveal', { path: diagnosticExport.path });
      return '已打开诊断包位置';
    });
  };

  const exportProject = () => {
    const destinationRoot = exportDestination.trim();
    if (!destinationRoot) {
      setMaintenanceMessage('请输入项目导出的绝对目录');
      return;
    }
    return runMaintenanceAction(async () => {
      await callWorker('file.task.create', {
        kind: 'project-export',
        destinationRoot,
        idempotencyKey: crypto.randomUUID(),
      });
      return '项目导出已排队，可在任务日志查看进度或取消。';
    });
  };

  const restoreProject = () => {
    const backupPath = restoreBackupPath.trim();
    const destinationRoot = restoreDestination.trim();
    if (!backupPath || !destinationRoot) {
      setMaintenanceMessage('请输入备份文件和恢复目标绝对目录');
      return;
    }
    onCloseSettings();
    return runProjectAction(
      async () =>
        (await callWorker('project.runtime.restore', { backupPath, destinationRoot })).project,
    );
  };

  const checkIntegrity = () =>
    runMaintenanceAction(async () => {
      const result = await callWorker('project.integrity', {});
      return result.ok
        ? `完整性检查通过 · Schema v${result.schemaVersion}`
        : result.messages.join('; ');
    });

  const backupProject = () =>
    runMaintenanceAction(async () => {
      await callWorker('file.task.create', {
        kind: 'project-backup',
        idempotencyKey: crypto.randomUUID(),
      });
      return '项目备份已排队，可在任务日志查看进度或取消。';
    });

  const cleanupContextSnapshots = (olderThanDays = 90) => {
    if (
      !window.confirm(
        `确定清理 ${olderThanDays} 天前且不再被 generation、attempt、task、document version 引用的旧上下文快照？`,
      )
    ) {
      return;
    }
    return runMaintenanceAction(async () => {
      const result = await callWorker('maintenance.contextSnapshots.cleanup', {
        olderThanDays,
      });
      return `已清理 ${result.removedCount} 个旧快照，保留 ${result.retainedCount} 个`;
    });
  };

  return {
    maintenanceBusy,
    maintenanceMessage,
    cacheInspection,
    workerMetrics,
    diagnosticExport,
    diagnosticDestination,
    exportDestination,
    restoreBackupPath,
    restoreDestination,
    setDiagnosticDestination,
    setExportDestination,
    setRestoreBackupPath,
    setRestoreDestination,
    clearMaintenanceMessage: () => setMaintenanceMessage(''),
    inspectCache,
    clearCache,
    refreshMetrics,
    exportDiagnostics,
    revealDiagnostics,
    exportProject,
    restoreProject,
    checkIntegrity,
    backupProject,
    cleanupContextSnapshots,
  };
}
