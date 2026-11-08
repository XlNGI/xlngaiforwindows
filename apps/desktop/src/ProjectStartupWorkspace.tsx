import { useMemo, useState } from 'react';
import {
  ArrowDownUp,
  ChevronRight,
  FileText,
  FolderOpen,
  Plus,
  Search,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { RecentProjectInfo } from '@ai-video/contracts';

interface ProjectStartupWorkspaceProps {
  recentProjects: RecentProjectInfo[];
  startupLoaded: boolean;
  projectName: string;
  projectPath: string;
  projectMessage: string;
  projectBusy: boolean;
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
  onProjectNameChange: (name: string) => void;
  onProjectPathChange: (path: string) => void;
  onBrowse: () => void;
  onOpenProject: () => void;
  onOpenRecent: (rootPath: string) => void;
  onCreateProject: () => void;
  onCreateSampleProject: () => void;
}

interface ProjectCreateDialogProps {
  recentProjects: RecentProjectInfo[];
  startupLoaded: boolean;
  projectName: string;
  projectPath: string;
  projectMessage: string;
  projectBusy: boolean;
  onClose: () => void;
  onProjectNameChange: (name: string) => void;
  onProjectPathChange: (path: string) => void;
  onBrowse: () => void;
  onCreateProject: () => void;
  onCreateSampleProject: () => void;
}

function formatRecentProjectDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay)
    return `今天 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)}`;
  if (date.toDateString() === yesterday.toDateString())
    return `昨天 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(date)}`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

export function ProjectStartupWorkspace({
  recentProjects,
  startupLoaded,
  projectName,
  projectPath,
  projectMessage,
  projectBusy,
  createOpen,
  onCreateOpenChange,
  onProjectNameChange,
  onProjectPathChange,
  onBrowse,
  onOpenProject,
  onOpenRecent,
  onCreateProject,
  onCreateSampleProject,
}: ProjectStartupWorkspaceProps) {
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'recent' | 'name'>('recent');
  const [showAll, setShowAll] = useState(false);
  const sortedProjects = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    return recentProjects
      .filter(
        (project) =>
          !query ||
          project.name.toLocaleLowerCase().includes(query) ||
          project.rootPath.toLocaleLowerCase().includes(query),
      )
      .sort((left, right) =>
        sort === 'name'
          ? left.name.localeCompare(right.name, 'zh-CN')
          : new Date(right.lastOpenedAt).getTime() - new Date(left.lastOpenedAt).getTime(),
      );
  }, [recentProjects, search, sort]);
  const visibleProjects = showAll ? sortedProjects : sortedProjects.slice(0, 5);

  return (
    <>
      <section className="project-startup" aria-label="项目启动页">
        <div className="project-startup-inner">
          <span className="project-startup-eyebrow">项目空间</span>
          <h1>开始一个项目</h1>
          <p className="project-startup-intro">打开已有项目，或创建一个新的本地项目。</p>
          <div className="project-startup-actions">
            <button
              className="button primary"
              type="button"
              onClick={onOpenProject}
              disabled={projectBusy}
            >
              <FolderOpen size={16} />
              打开项目
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={() => onCreateOpenChange(true)}
              disabled={projectBusy}
            >
              <Plus size={16} />
              新建项目
            </button>
          </div>

          {projectMessage && (
            <p className="project-startup-message" role="status">
              {projectMessage}
            </p>
          )}

          <section className="project-startup-recent" aria-label="最近项目">
            <header className="project-startup-section-header">
              <h2>最近打开</h2>
              {sortedProjects.length > 5 && (
                <button
                  className="project-startup-text-button"
                  type="button"
                  onClick={() => setShowAll((value) => !value)}
                >
                  {showAll ? '收起' : '查看全部'}
                  <ChevronRight size={14} />
                </button>
              )}
            </header>
            <div className="project-startup-tools">
              <label className="project-startup-search">
                <Search size={15} />
                <input
                  aria-label="搜索最近项目"
                  placeholder="搜索最近项目"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </label>
              <label className="project-startup-sort">
                <ArrowDownUp size={14} />
                <span>排序</span>
                <select
                  aria-label="最近项目排序"
                  value={sort}
                  onChange={(event) => setSort(event.target.value as 'recent' | 'name')}
                >
                  <option value="recent">最近打开</option>
                  <option value="name">名称 A-Z</option>
                </select>
              </label>
            </div>

            {visibleProjects.length > 0 ? (
              <div className="project-startup-list">
                {visibleProjects.map((recent, index) => (
                  <div className="project-startup-row" key={recent.rootPath}>
                    <span
                      className={`project-startup-file-icon tone-${index % 3}`}
                      aria-hidden="true"
                    >
                      <FileText size={17} />
                    </span>
                    <div className="project-startup-info">
                      <button
                        className="project-startup-name"
                        type="button"
                        onClick={() => onOpenRecent(recent.rootPath)}
                        title={recent.name}
                      >
                        {recent.name}
                      </button>
                      <span className="project-startup-path" title={recent.rootPath}>
                        {recent.rootPath}
                      </span>
                    </div>
                    <time className="project-startup-date" dateTime={recent.lastOpenedAt}>
                      {formatRecentProjectDate(recent.lastOpenedAt)}
                    </time>
                    <button
                      className="project-startup-open"
                      type="button"
                      title={`打开项目：${recent.name}`}
                      aria-label={`打开项目：${recent.name}`}
                      onClick={() => onOpenRecent(recent.rootPath)}
                    >
                      <ChevronRight size={17} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="project-startup-empty">
                {startupLoaded ? (search ? '没有匹配的项目' : '暂无最近项目') : '正在读取最近项目…'}
              </div>
            )}
          </section>

          <div className="project-startup-local-note">
            <ShieldCheck size={15} />
            <span>项目资料、版本历史和会话内容保存在本地项目容器中。</span>
          </div>
        </div>
      </section>

      {createOpen && (
        <ProjectCreateDialog
          recentProjects={recentProjects}
          startupLoaded={startupLoaded}
          projectName={projectName}
          projectPath={projectPath}
          projectMessage={projectMessage}
          projectBusy={projectBusy}
          onClose={() => onCreateOpenChange(false)}
          onProjectNameChange={onProjectNameChange}
          onProjectPathChange={onProjectPathChange}
          onBrowse={onBrowse}
          onCreateProject={onCreateProject}
          onCreateSampleProject={onCreateSampleProject}
        />
      )}
    </>
  );
}

export function ProjectCreateDialog({
  recentProjects,
  startupLoaded,
  projectName,
  projectPath,
  projectMessage,
  projectBusy,
  onClose,
  onProjectNameChange,
  onProjectPathChange,
  onBrowse,
  onCreateProject,
  onCreateSampleProject,
}: ProjectCreateDialogProps) {
  return (
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !projectBusy) onClose();
      }}
    >
      <form
        className="project-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-create-title"
        onSubmit={(event) => {
          event.preventDefault();
          onCreateProject();
        }}
      >
        <header>
          <h2 id="project-create-title">新建项目</h2>
          <button
            className="icon-button subtle"
            type="button"
            title="关闭"
            aria-label="关闭新建项目"
            disabled={projectBusy}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
        <label htmlFor="startup-project-name">项目名称</label>
        <input
          id="startup-project-name"
          autoFocus
          maxLength={200}
          value={projectName}
          onChange={(event) => onProjectNameChange(event.target.value)}
          disabled={projectBusy}
        />
        <label htmlFor="startup-project-path">项目绝对目录</label>
        <div className="project-create-path-row">
          <input
            id="startup-project-path"
            value={projectPath}
            onChange={(event) => onProjectPathChange(event.target.value)}
            placeholder="D:\\Projects\\my-drama"
            disabled={projectBusy}
          />
          <button
            className="icon-button subtle"
            type="button"
            aria-label="选择项目目录"
            title="选择项目目录"
            onClick={onBrowse}
            disabled={projectBusy}
          >
            <FolderOpen size={16} />
          </button>
        </div>
        {projectMessage && (
          <small className="project-rename-error" role="alert">
            {projectMessage}
          </small>
        )}
        <div className="project-create-actions">
          {recentProjects.length === 0 && startupLoaded && (
            <button
              className="project-create-sample"
              type="button"
              onClick={onCreateSampleProject}
              disabled={projectBusy || !projectPath.trim()}
            >
              创建示例项目
            </button>
          )}
          <span />
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={projectBusy}
          >
            取消
          </button>
          <button
            className="button primary"
            type="submit"
            disabled={projectBusy || !projectPath.trim() || !projectName.trim()}
          >
            {projectBusy ? '创建中…' : '创建项目'}
          </button>
        </div>
      </form>
    </div>
  );
}
