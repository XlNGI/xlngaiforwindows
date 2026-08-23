import {
  ExternalLink,
  LayoutPanelTop,
  PanelTopOpen,
  Rows3,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels';
import {
  createDefaultWorkspaceLayout,
  type WorkspaceAction,
  type WorkspaceLayoutState,
} from './workspace-reducer';
import { FloatingWindow } from './FloatingWindow';
import { maximizedBounds } from './workspace-geometry';
import { safePanelLayoutStorage } from './panel-layout-storage';
import type { WorkspaceViewport } from './workspace-types';
import {
  readWorkspacePaneOrder,
  writeWorkspacePaneOrder,
  type WorkspacePaneId,
} from './workspace-pane-order';

interface WorkspaceSurfaceProps {
  layout: WorkspaceLayoutState;
  dispatch: Dispatch<WorkspaceAction>;
  documentTitle: string;
  conversationContent: ReactNode;
  productionContent: ReactNode;
  productionOpen: boolean;
  documentActive: boolean;
  children: ReactNode;
  onOpenConversation: () => void;
  onOpenDocument: () => void;
  onCloseDocument: () => void;
  onDetachDocument: () => void;
  onDetachConversation: () => void;
  detachedPanels: Partial<Record<'document' | 'conversation', string>>;
}

function viewportFromElement(element: HTMLElement | null): WorkspaceViewport {
  if (!element) return { width: window.innerWidth, height: window.innerHeight };
  return {
    width: element.clientWidth || window.innerWidth,
    height: element.clientHeight || window.innerHeight,
  };
}

export function WorkspaceSurface({
  layout,
  dispatch,
  documentTitle,
  conversationContent,
  productionContent,
  productionOpen,
  documentActive,
  children,
  onOpenConversation,
  onOpenDocument,
  onCloseDocument,
  onDetachDocument,
  onDetachConversation,
  detachedPanels,
}: WorkspaceSurfaceProps) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<WorkspaceViewport>(() => viewportFromElement(null));
  const [paneOrder, setPaneOrder] = useState<WorkspacePaneId[]>(() =>
    readWorkspacePaneOrder(layout.projectId),
  );
  const [draggingPane, setDraggingPane] = useState<WorkspacePaneId>();
  const [dropIndex, setDropIndex] = useState<number>();
  const [detachArmed, setDetachArmed] = useState(false);
  const dragStartRef = useRef<{ paneId: WorkspacePaneId; x: number; y: number } | undefined>(
    undefined,
  );
  const suppressTabClickRef = useRef(false);
  const documentPanel = layout.panels.document;
  const conversationPanel = layout.panels.conversation;
  const narrow = viewport.width <= 900;
  const compactSplit = viewport.width < 1150;
  const documentDocked =
    !documentActive ||
    (documentPanel.open && documentPanel.mode === 'docked' && !detachedPanels.document);
  const conversationAutoHidden =
    !narrow &&
    compactSplit &&
    productionOpen &&
    conversationPanel.open &&
    conversationPanel.mode === 'docked' &&
    !detachedPanels.conversation;
  const showDocumentFloating =
    documentActive &&
    documentPanel.open &&
    !detachedPanels.document &&
    documentPanel.mode !== 'docked' &&
    (!narrow || layout.activePanelId === 'document');
  const showConversationFloating =
    conversationPanel.open &&
    !detachedPanels.conversation &&
    (conversationPanel.mode !== 'docked' || (narrow && !productionOpen)) &&
    (!narrow || layout.activePanelId === 'conversation');
  const showProductionDock = productionOpen && !narrow;
  const showConversationDock =
    conversationPanel.open &&
    conversationPanel.mode === 'docked' &&
    !detachedPanels.conversation &&
    !narrow &&
    !conversationAutoHidden;
  const showEditorDock = narrow
    ? !productionOpen
    : documentDocked || (!showProductionDock && !showConversationDock);
  const showProductionPage = showProductionDock || (!showEditorDock && productionOpen);
  const dockedPanelIds = [
    ...(showEditorDock ? ['editor'] : []),
    ...(showProductionPage ? ['production'] : []),
    ...(showConversationDock ? ['conversation'] : []),
  ];
  const visiblePaneOrder = useMemo(
    () =>
      paneOrder.filter(
        (paneId) =>
          (paneId === 'editor' && showEditorDock) ||
          (paneId === 'production' && showProductionPage) ||
          (paneId === 'conversation' && showConversationDock),
      ),
    [paneOrder, showConversationDock, showEditorDock, showProductionPage],
  );
  const persistedDockLayout = useDefaultLayout({
    id: `ai-video.workspace-docks.v1:${layout.projectId ?? 'no-project'}`,
    panelIds: dockedPanelIds,
    storage: safePanelLayoutStorage,
    onlySaveAfterUserInteractions: true,
  });

  useEffect(() => {
    setPaneOrder(readWorkspacePaneOrder(layout.projectId));
  }, [layout.projectId]);

  useEffect(() => {
    const timer = window.setTimeout(
      () => writeWorkspacePaneOrder(layout.projectId, paneOrder),
      200,
    );
    return () => window.clearTimeout(timer);
  }, [layout.projectId, paneOrder]);

  useEffect(() => {
    const element = surfaceRef.current;
    if (!element) return;
    const updateViewport = () => {
      const next = viewportFromElement(element);
      setViewport(next);
      dispatch({ type: 'clamp', viewport: next });
    };
    updateViewport();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateViewport);
      return () => window.removeEventListener('resize', updateViewport);
    }
    const observer = new ResizeObserver(updateViewport);
    observer.observe(element);
    return () => observer.disconnect();
  }, [dispatch]);

  const reorderPane = (sourceId: WorkspacePaneId, targetIndex: number) => {
    const visible = visiblePaneOrder;
    const sourceIndex = visible.indexOf(sourceId);
    if (sourceIndex < 0) return;
    const nextVisible = [...visible];
    nextVisible.splice(sourceIndex, 1);
    const adjustedIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
    nextVisible.splice(Math.max(0, Math.min(adjustedIndex, nextVisible.length)), 0, sourceId);
    const nextOrder = [...paneOrder];
    let visibleIndex = 0;
    for (let index = 0; index < nextOrder.length; index += 1) {
      const paneId = nextOrder[index];
      const nextPaneId = nextVisible[visibleIndex];
      if (paneId && nextPaneId && visible.includes(paneId)) {
        nextOrder[index] = nextPaneId;
        visibleIndex += 1;
      }
    }
    setPaneOrder(nextOrder);
  };

  const detachPane = (paneId: WorkspacePaneId) => {
    if (paneId === 'editor') onDetachDocument();
    if (paneId === 'conversation') onDetachConversation();
  };

  const updateDropTarget = (event: ReactPointerEvent<HTMLDivElement>) => {
    const dragStart = dragStartRef.current;
    if (!dragStart) return;
    const moved = Math.hypot(event.clientX - dragStart.x, event.clientY - dragStart.y);
    if (moved < 6) return;
    suppressTabClickRef.current = true;
    setDraggingPane(dragStart.paneId);
    const edgeDistance = 12;
    const surfaceBounds = surfaceRef.current?.getBoundingClientRect() ?? null;
    const hasSurfaceBounds = Boolean(surfaceBounds && surfaceBounds.width && surfaceBounds.height);
    const surfaceLeft = surfaceBounds && hasSurfaceBounds ? surfaceBounds.left : 0;
    const surfaceTop = surfaceBounds && hasSurfaceBounds ? surfaceBounds.top : 0;
    const surfaceRight =
      surfaceBounds && hasSurfaceBounds ? surfaceBounds.right : window.innerWidth;
    const surfaceBottom =
      surfaceBounds && hasSurfaceBounds ? surfaceBounds.bottom : window.innerHeight;
    const outsideDropZone =
      event.clientX <= surfaceLeft + edgeDistance ||
      event.clientX >= surfaceRight - edgeDistance ||
      event.clientY <= surfaceTop + edgeDistance ||
      event.clientY >= surfaceBottom - edgeDistance;
    if (outsideDropZone && dragStart.paneId !== 'production') {
      setDetachArmed(true);
      setDropIndex(undefined);
      return;
    }
    setDetachArmed(false);
    const tabElements = surfaceRef.current?.querySelectorAll<HTMLElement>('[data-pane-id]') ?? [];
    let target = visiblePaneOrder.length;
    for (let index = 0; index < tabElements.length; index += 1) {
      const tabElement = tabElements[index];
      if (!tabElement) continue;
      const rect = tabElement.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) {
        target = index;
        break;
      }
    }
    setDropIndex(target);
  };

  const finishPaneDrag = () => {
    const dragStart = dragStartRef.current;
    if (!dragStart) return;
    if (detachArmed) {
      detachPane(dragStart.paneId);
    } else if (dropIndex !== undefined) {
      reorderPane(dragStart.paneId, dropIndex);
    }
    dragStartRef.current = undefined;
    setDraggingPane(undefined);
    setDropIndex(undefined);
    setDetachArmed(false);
    window.setTimeout(() => {
      suppressTabClickRef.current = false;
    }, 0);
  };

  const cancelPaneDrag = () => {
    dragStartRef.current = undefined;
    setDraggingPane(undefined);
    setDropIndex(undefined);
    setDetachArmed(false);
    suppressTabClickRef.current = false;
  };

  const startPaneDrag = (paneId: WorkspacePaneId, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== undefined && event.button !== 0) return;
    dragStartRef.current = { paneId, x: event.clientX, y: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const paneTitle = (paneId: WorkspacePaneId) => {
    if (paneId === 'editor') return documentTitle || '文档';
    if (paneId === 'conversation') return '会话';
    return '生产参数';
  };

  const renderPaneHeader = (paneId: WorkspacePaneId, index: number) => {
    const dropBefore = dropIndex === index && draggingPane !== paneId;
    const dropAfter =
      dropIndex === visiblePaneOrder.length && index === visiblePaneOrder.length - 1;
    return (
      <header className="workspace-pane-header">
        <button
          type="button"
          data-pane-id={paneId}
          className={`workspace-pane-tab ${draggingPane === paneId ? 'is-dragging ' : ''}${dropBefore ? 'drop-before ' : ''}${dropAfter ? 'drop-after' : ''}`}
          onPointerDown={(event) => startPaneDrag(paneId, event)}
          onClick={(event) => {
            if (suppressTabClickRef.current) {
              event.preventDefault();
              return;
            }
            if (paneId === 'editor') openDocument();
            if (paneId === 'conversation') openConversation();
          }}
        >
          {paneId === 'editor' ? (
            <LayoutPanelTop size={14} />
          ) : paneId === 'conversation' ? (
            <Rows3 size={14} />
          ) : (
            <SlidersHorizontal size={14} />
          )}
          <span>{paneTitle(paneId)}</span>
        </button>
        <div className="workspace-pane-actions">
          {paneId === 'editor' && (
            <button
              type="button"
              title="文档在独立窗口打开"
              aria-label="文档在独立窗口打开"
              onClick={onDetachDocument}
              disabled={!layout.projectId}
            >
              <ExternalLink size={15} />
            </button>
          )}
          {paneId === 'conversation' && (
            <button
              type="button"
              title="会话在独立窗口打开"
              aria-label="会话在独立窗口打开"
              onClick={onDetachConversation}
              disabled={!layout.projectId}
            >
              <ExternalLink size={15} />
            </button>
          )}
          {paneId === 'editor' && (
            <button
              type="button"
              title="关闭文档面板"
              aria-label="关闭文档面板"
              onClick={onCloseDocument}
            >
              <X size={15} />
            </button>
          )}
          {paneId === 'conversation' && (
            <button
              type="button"
              title="关闭会话面板"
              aria-label="关闭会话面板"
              onClick={() => dispatch({ type: 'close', panelId: 'conversation' })}
            >
              <X size={15} />
            </button>
          )}
          {index === 0 && (
            <button
              type="button"
              title="恢复默认布局"
              aria-label="恢复默认布局"
              onClick={() =>
                dispatch({
                  type: 'reset',
                  state: createDefaultWorkspaceLayout(layout.projectId, viewport),
                })
              }
            >
              <PanelTopOpen size={15} />
            </button>
          )}
        </div>
      </header>
    );
  };

  const renderDockPane = (paneId: WorkspacePaneId, index: number) => {
    if (paneId === 'editor') {
      return (
        <Panel
          id="editor"
          key="editor"
          defaultSize={showProductionPage || showConversationDock ? '44%' : '100%'}
          minSize="360px"
        >
          <section className="workspace-docked-page workspace-editor-page">
            {renderPaneHeader(paneId, index)}
            {documentDocked && <div className="workspace-base-content">{children}</div>}
            {documentActive && !documentDocked && (
              <div className="workspace-closed-panel">
                <button type="button" onClick={openDocument}>
                  {detachedPanels.document ? '显示独立文档窗口' : '打开文档编辑器'}
                </button>
              </div>
            )}
          </section>
        </Panel>
      );
    }
    if (paneId === 'production') {
      return (
        <Panel
          id="production"
          key="production"
          defaultSize={showProductionDock ? '30%' : '100%'}
          minSize={showProductionDock ? '320px' : '0px'}
        >
          <section className="workspace-docked-page workspace-production-page">
            {renderPaneHeader(paneId, index)}
            {productionContent}
          </section>
        </Panel>
      );
    }
    return (
      <Panel id="conversation" key="conversation" defaultSize="30%" minSize="360px" collapsible>
        <section className="workspace-docked-page workspace-conversation-page">
          {renderPaneHeader(paneId, index)}
          {conversationContent}
        </section>
      </Panel>
    );
  };

  const openDocument = () => {
    if (detachedPanels.document) {
      onOpenDocument();
      return;
    }
    dispatch({ type: narrow && productionOpen ? 'float' : 'open', panelId: 'document' });
    onOpenDocument();
  };
  const openConversation = () => {
    if (detachedPanels.conversation) {
      onOpenConversation();
      return;
    }
    if (conversationAutoHidden || (narrow && productionOpen)) {
      dispatch({ type: 'float', panelId: 'conversation' });
      return;
    }
    dispatch({ type: 'open', panelId: 'conversation' });
    onOpenConversation();
  };
  const dock = (panelId: 'document' | 'conversation') => dispatch({ type: 'dock', panelId });
  const maximize = (panelId: 'document' | 'conversation') =>
    dispatch({ type: 'maximize', panelId, viewport });
  return (
    <div
      className={`workspace-surface ${draggingPane ? 'is-dragging' : ''} ${detachArmed ? 'is-detach-armed' : ''}`}
      ref={surfaceRef}
      onPointerMove={updateDropTarget}
      onPointerUp={finishPaneDrag}
      onPointerCancel={cancelPaneDrag}
    >
      <Group
        className="workspace-dock-group"
        orientation="horizontal"
        defaultLayout={persistedDockLayout.defaultLayout}
        onLayoutChanged={persistedDockLayout.onLayoutChanged}
        resizeTargetMinimumSize={{ fine: 6, coarse: 20 }}
      >
        {visiblePaneOrder.flatMap((paneId, index) => [
          ...(index > 0
            ? [
                <Separator
                  key={`separator-${paneId}`}
                  id={`workspace-${visiblePaneOrder[index - 1]}-${paneId}`}
                  className="workspace-dock-separator"
                />,
              ]
            : []),
          renderDockPane(paneId, index),
        ])}
      </Group>
      {showDocumentFloating && (
        <FloatingWindow
          panelId="document"
          title={documentTitle || '文档编辑器'}
          bounds={documentPanel.bounds}
          viewport={viewport}
          zOrder={documentPanel.zOrder}
          maximized={documentPanel.mode === 'maximized'}
          onFocus={() => dispatch({ type: 'focus', panelId: 'document' })}
          onClose={onCloseDocument}
          onDock={() => dock('document')}
          onDetach={onDetachDocument}
          onMaximize={() => maximize('document')}
          onRestore={() => dispatch({ type: 'restore', panelId: 'document' })}
          onBoundsChange={(bounds) => dispatch({ type: 'setBounds', panelId: 'document', bounds })}
        >
          {children}
        </FloatingWindow>
      )}
      {showConversationFloating && (
        <FloatingWindow
          panelId="conversation"
          title="会话"
          bounds={narrow ? maximizedBounds(viewport) : conversationPanel.bounds}
          viewport={viewport}
          zOrder={conversationPanel.zOrder}
          maximized={narrow || conversationPanel.mode === 'maximized'}
          onFocus={() => dispatch({ type: 'focus', panelId: 'conversation' })}
          onClose={() => dispatch({ type: 'close', panelId: 'conversation' })}
          onDock={() => dock('conversation')}
          onDetach={onDetachConversation}
          onMaximize={() => maximize('conversation')}
          onRestore={() => dispatch({ type: 'restore', panelId: 'conversation' })}
          onBoundsChange={(bounds) =>
            dispatch({ type: 'setBounds', panelId: 'conversation', bounds })
          }
        >
          {conversationContent}
        </FloatingWindow>
      )}
      {(!conversationPanel.open || conversationAutoHidden || (narrow && productionOpen)) && (
        <button
          className="workspace-chat-launcher"
          type="button"
          title={conversationAutoHidden ? '显示已收起的项目会话' : '打开项目会话'}
          aria-label={detachedPanels.conversation ? '显示独立会话窗口' : '打开项目会话'}
          onClick={openConversation}
        >
          <Rows3 size={16} />
        </button>
      )}
    </div>
  );
}
