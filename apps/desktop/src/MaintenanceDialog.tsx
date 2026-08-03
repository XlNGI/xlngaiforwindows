import { Database, FolderOpen, HardDrive, Save, Trash2, X } from 'lucide-react';
import type { CacheInspectionResult, DiagnosticExportResult } from '@ai-video/contracts';

interface MaintenanceDialogProps {
  embedded?: boolean;
  hasProject: boolean;
  writable: boolean;
  busy: boolean;
  message: string;
  cacheInspection?: CacheInspectionResult;
  diagnosticExport?: DiagnosticExportResult;
  exportDestination: string;
  diagnosticDestination: string;
  restoreBackupPath: string;
  restoreDestination: string;
  onClose: () => void;
  onIntegrity: () => void;
  onBackup: () => void;
  onExportDestinationChange: (value: string) => void;
  onExportProject: () => void;
  onInspectCache: () => void;
  onClearCache: () => void;
  onDiagnosticDestinationChange: (value: string) => void;
  onExportDiagnostics: () => void;
  onRevealDiagnostics: () => void;
  onRestoreBackupPathChange: (value: string) => void;
  onRestoreDestinationChange: (value: string) => void;
  onRestoreProject: () => void;
}

export function MaintenanceDialog({
  embedded = false,
  hasProject,
  writable,
  busy,
  message,
  cacheInspection,
  diagnosticExport,
  exportDestination,
  diagnosticDestination,
  restoreBackupPath,
  restoreDestination,
  onClose,
  onIntegrity,
  onBackup,
  onExportDestinationChange,
  onExportProject,
  onInspectCache,
  onClearCache,
  onDiagnosticDestinationChange,
  onExportDiagnostics,
  onRevealDiagnostics,
  onRestoreBackupPathChange,
  onRestoreDestinationChange,
  onRestoreProject,
}: MaintenanceDialogProps) {
  const content = (
    <section
      className={`maintenance-dialog${embedded ? ' embedded' : ''}`}
      role={embedded ? undefined : 'dialog'}
      aria-modal={embedded ? undefined : 'true'}
      aria-labelledby={embedded ? undefined : 'maintenance-title'}
    >
      <header>
        <div>
          <span className="eyebrow">本地项目工具</span>
          <h2 id="maintenance-title">项目维护</h2>
        </div>
        <button className="icon-button subtle" type="button" title="关闭项目维护" onClick={onClose}>
          <X size={16} />
        </button>
      </header>

      {hasProject ? (
        <>
          <section className="maintenance-section">
            <div className="maintenance-section-title">
              <Database size={15} />
              <strong>备份与迁移</strong>
            </div>
            <div className="maintenance-actions">
              <button type="button" onClick={onIntegrity} disabled={busy}>
                检查
              </button>
              <button type="button" onClick={onBackup} disabled={busy || !writable}>
                <Save size={13} />
                备份
              </button>
            </div>
            <label>
              项目导出目录
              <input
                value={exportDestination}
                onChange={(event) => onExportDestinationChange(event.target.value)}
                placeholder="D:\Projects\exported-drama"
              />
            </label>
            <button
              className="maintenance-command"
              type="button"
              onClick={onExportProject}
              disabled={busy || !writable || !exportDestination.trim()}
            >
              <FolderOpen size={14} />
              导出项目副本
            </button>
          </section>

          <section className="maintenance-section">
            <div className="maintenance-section-title">
              <HardDrive size={15} />
              <strong>媒体缓存</strong>
              {cacheInspection && (
                <span>
                  {cacheInspection.fileCount} 个文件 ·{' '}
                  {(cacheInspection.sizeBytes / 1024 / 1024).toFixed(2)} MiB
                </span>
              )}
            </div>
            <div className="maintenance-actions">
              <button type="button" onClick={onInspectCache} disabled={busy}>
                检查占用
              </button>
              <button
                className="danger-command"
                type="button"
                onClick={onClearCache}
                disabled={busy || !writable}
              >
                <Trash2 size={13} />
                清理缓存
              </button>
            </div>
          </section>

          <section className="maintenance-section">
            <div className="maintenance-section-title">
              <HardDrive size={15} />
              <strong>脱敏诊断</strong>
            </div>
            <label>
              导出目录（留空则保存到项目 exports）
              <input
                value={diagnosticDestination}
                onChange={(event) => onDiagnosticDestinationChange(event.target.value)}
                placeholder="D:\Support"
              />
            </label>
            <div className="maintenance-actions">
              <button type="button" onClick={onExportDiagnostics} disabled={busy}>
                导出诊断包
              </button>
              <button
                type="button"
                onClick={onRevealDiagnostics}
                disabled={busy || !diagnosticExport}
              >
                <FolderOpen size={13} />
                打开位置
              </button>
            </div>
            {diagnosticExport && (
              <small className="maintenance-path" title={diagnosticExport.path}>
                {diagnosticExport.path}
              </small>
            )}
          </section>
        </>
      ) : (
        <section className="maintenance-section restore-section">
          <div className="maintenance-section-title">
            <Database size={15} />
            <strong>从 SQLite 备份恢复</strong>
          </div>
          <label>
            备份文件
            <input
              value={restoreBackupPath}
              onChange={(event) => onRestoreBackupPathChange(event.target.value)}
              placeholder="D:\Backups\project.sqlite"
            />
          </label>
          <label>
            恢复目标目录
            <input
              value={restoreDestination}
              onChange={(event) => onRestoreDestinationChange(event.target.value)}
              placeholder="D:\Projects\restored-drama"
            />
          </label>
          <button
            className="maintenance-command"
            type="button"
            onClick={onRestoreProject}
            disabled={busy || !restoreBackupPath.trim() || !restoreDestination.trim()}
          >
            恢复并打开项目
          </button>
        </section>
      )}

      {message && <div className="maintenance-message">{message}</div>}
    </section>
  );
  return embedded ? (
    content
  ) : (
    <div className="dialog-backdrop" role="presentation">
      {content}
    </div>
  );
}
