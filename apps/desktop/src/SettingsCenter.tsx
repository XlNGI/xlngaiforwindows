import { useState, type ReactNode } from 'react';
import { BarChart3, Database, Server, Settings2, X } from 'lucide-react';
import { ProviderConnectionsView } from './settings/ProviderConnectionsView';
import { UsageDashboard } from './settings/UsageDashboard';

type SettingsPage = 'providers' | 'usage' | 'maintenance';

interface SettingsCenterProps {
  maintenance: ReactNode;
  initialPage?: SettingsPage;
  onClose: () => void;
}

const pages: Array<{ id: SettingsPage; label: string; icon: typeof Server }> = [
  { id: 'providers', label: '供应商与模型', icon: Server },
  { id: 'usage', label: '使用量与费用', icon: BarChart3 },
  { id: 'maintenance', label: '项目维护', icon: Database },
];

export function SettingsCenter({
  maintenance,
  initialPage = 'providers',
  onClose,
}: SettingsCenterProps) {
  const [page, setPage] = useState<SettingsPage>(initialPage);
  const dialogLabel = initialPage === 'maintenance' ? '项目维护' : undefined;

  return (
    <div className="dialog-backdrop settings-backdrop" role="presentation">
      <section
        className="settings-center"
        role="dialog"
        aria-modal="true"
        aria-label={dialogLabel}
        aria-labelledby={dialogLabel ? undefined : 'settings-center-title'}
      >
        <header className="settings-center-header">
          <div className="settings-title-mark">
            <Settings2 size={18} />
          </div>
          <div>
            <span className="eyebrow">AI 影视工作台</span>
            <h2 id="settings-center-title">设置中心</h2>
          </div>
          <button
            className="icon-button subtle"
            type="button"
            title="关闭设置中心"
            onClick={onClose}
          >
            <X size={17} />
          </button>
        </header>

        <aside className="settings-navigation" aria-label="设置页面">
          {pages.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={page === item.id ? 'active' : ''}
                aria-current={page === item.id ? 'page' : undefined}
                onClick={() => setPage(item.id)}
              >
                <Icon size={15} />
                {item.label}
              </button>
            );
          })}
        </aside>

        <div className="settings-content">
          {page === 'providers' && <ProviderConnectionsView />}
          {page === 'usage' && <UsageDashboard />}
          {page === 'maintenance' && maintenance}
        </div>
      </section>
    </div>
  );
}
