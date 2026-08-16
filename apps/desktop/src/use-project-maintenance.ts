import { useState } from 'react';
import type {
  CacheInspectionResult,
  DiagnosticExportResult,
  ProjectInfo,
  WorkerMetricsSnapshot,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';

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
  const [maintenanceBusy, setMaintenanceBusy] = useState(false);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  const [cacheInspection, setCacheInspection] = useState<CacheInspectionResult>();
  const [workerMetrics, setWorkerMetrics] = useState<WorkerMetricsSnapshot>();
  const [diagnosticExport, setDiagnosticExport] = useState<DiagnosticExportResult>();
  const [diagnosticDestination, setDiagnosticDestination] = useState('');
  const [exportDestination, setExportDestination] = useState('');
  const [restoreBackupPath, setRestoreBackupPath] = useState('');
  const [restoreDestination, setRestoreDestination] = useState('');

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
      const result = await callWorker('project.export', { destinationRoot });
      return `项目已导出：${result.path}`;
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
    return runProjectAction(() => callWorker('project.restore', { backupPath, destinationRoot }));
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
      const result = await callWorker('project.backup', {});
      return `备份完成：${result.path}`;
    });

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
  };
}
