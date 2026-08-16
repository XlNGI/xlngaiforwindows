import { useEffect, useState, type ReactNode } from 'react';
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import { matchesViewport, safePanelLayoutStorage } from './panel-layout-storage';

interface ResizableAppLayoutProps {
  projectId?: string;
  sidebarOpen: boolean;
  onSidebarOpenChange: (open: boolean) => void;
  sidebar: ReactNode;
  children: ReactNode;
}

export function ResizableAppLayout({
  projectId,
  sidebarOpen,
  onSidebarOpenChange,
  sidebar,
  children,
}: ResizableAppLayoutProps) {
  const sidebarRef = usePanelRef();
  const [narrow, setNarrow] = useState(() => matchesViewport('(max-width: 660px)', 660));
  const persistedLayout = useDefaultLayout({
    id: `ai-video.app-shell.v1:${projectId ?? 'no-project'}`,
    panelIds: ['project-navigation', 'workbench'],
    storage: safePanelLayoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return () => undefined;
    const query = window.matchMedia('(max-width: 660px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    if (!narrow && sidebarOpen && sidebar.isCollapsed()) sidebar.expand();
    if ((narrow || !sidebarOpen) && !sidebar.isCollapsed()) sidebar.collapse();
  }, [narrow, sidebarOpen, sidebarRef]);

  return (
    <div className="resizable-app-layout">
      <Group
        className="app-pane-group"
        orientation="horizontal"
        defaultLayout={persistedLayout.defaultLayout}
        onLayoutChanged={persistedLayout.onLayoutChanged}
        resizeTargetMinimumSize={{ fine: 6, coarse: 20 }}
      >
        <Panel
          id="project-navigation"
          panelRef={sidebarRef}
          defaultSize="208px"
          minSize="180px"
          maxSize="360px"
          collapsedSize="0px"
          collapsible
          groupResizeBehavior="preserve-pixel-size"
          onResize={(size) => {
            if (!narrow) onSidebarOpenChange(size.inPixels > 1);
          }}
        >
          {sidebar}
        </Panel>
        <Separator id="project-workbench" className="app-pane-separator" />
        <Panel id="workbench" minSize="360px">
          {children}
        </Panel>
      </Group>
    </div>
  );
}
