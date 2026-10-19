import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Images,
  LayoutPanelTop,
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
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels';
import {
  CONVERSATION_DEFAULT_DOCK_SIZE,
  WORKSPACE_DOCK_LAYOUT_ID,
  conversationWindowOpenAction,
  isConversationAutoHidden,
  isUnusableConversationLayoutShare,
  isWorkspaceNarrow,
  usableConversationDockLayout,
} from './conversation-window';
import type { WorkspaceAction, WorkspaceLayoutState } from './workspace-reducer';
import { FloatingWindow } from './FloatingWindow';
import { CONVERSATION_MIN_SIZE, maximizedBounds } from './workspace-geometry';
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
  editorTitle?: string;
  conversationContent: ReactNode;
  productionContent: ReactNode;
  assetsContent?: ReactNode;
  productionOpen: boolean;
  documentActive: boolean;
  children: ReactNode;
  onOpenConversation: () => void;
  onOpenDocument: () => void;
  onCloseDocument: () => void;
  onCloseProduction?: () => void;
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
  editorTitle,
  conversationContent,
  productionContent,
  assetsContent,
  productionOpen,
  documentActive,
  children,
  onOpenConversation,
  onOpenDocument,
  onCloseDocument,
  onCloseProduction,
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
  const conversationPanelElementRef = useRef<HTMLDivElement>(null);
  const conversationPanelRef = usePanelRef();
  const productionPanelRef = usePanelRef();
  const [productionCollapsed, setProductionCollapsed] = useState(false);
  const documentPanel = layout.panels.document;
  const conversationPanel = layout.panels.conversation;
  const assetsPanel = layout.panels.assets;
  const conversationWindowOptions = {
    panel: conversationPanel,
    detached: Boolean(detachedPanels.conversation),
    productionOpen,
    assetsOpen: assetsPanel.open && assetsPanel.mode === 'docked',
    viewportWidth: viewport.width,
    activePanelId: layout.activePanelId,
  };
  const narrow = isWorkspaceNarrow(viewport.width);
  const resolvedEditorTitle = editorTitle || documentTitle || '文档';
  const editorDetached = documentActive && Boolean(detachedPanels.document);
  const documentDocked = documentActive
    ? documentPanel.open && documentPanel.mode === 'docked' && !editorDetached
    : documentPanel.open;
  const conversationAutoHidden = isConversationAutoHidden(conversationWindowOptions);
  const showDocumentFloating =
    (!productionOpen || narrow) &&
    documentPanel.open &&
    !editorDetached &&
    (narrow || (documentActive && documentPanel.mode !== 'docked'));
  const showConversationFloating =
    conversationPanel.open &&
    !detachedPanels.conversation &&
    (conversationPanel.mode !== 'docked' || (narrow && !productionOpen)) &&
    (!narrow || layout.activePanelId === 'conversation');
  const showProductionDock = productionOpen && !narrow;
  const showAssetsDock =
    assetsPanel.open &&
    assetsPanel.mode === 'docked' &&
    !narrow &&
    (!productionOpen || viewport.width >= 960);
  const showAssetsFloating = assetsPanel.open && !showAssetsDock;
  const showConversationDock =
    conversationPanel.open &&
    conversationPanel.mode === 'docked' &&
    !detachedPanels.conversation &&
    !narrow &&
    !conversationAutoHidden;
  const showEditorDock = productionOpen
    ? !narrow && documentDocked
    : !narrow && (documentDocked || (!showConversationDock && !showAssetsDock));
  const showProductionPage = showProductionDock || (!showEditorDock && productionOpen);
  const dockedPanelIds = [
    ...(showEditorDock ? ['editor'] : []),
    ...(showProductionPage ? ['production'] : []),
    ...(showAssetsDock ? ['assets'] : []),
    ...(showConversationDock ? ['conversation'] : []),
  ];
  const visiblePaneOrder = useMemo(
    () =>
      paneOrder.filter(
        (paneId) =>
          (paneId === 'editor' && showEditorDock) ||
          (paneId === 'production' && showProductionPage) ||
          (paneId === 'assets' && showAssetsDock) ||
          (paneId === 'conversation' && showConversationDock),
      ),
    [paneOrder, showAssetsDock, showConversationDock, showEditorDock, showProductionPage],
  );
  const productionCollapsible = showProductionDock && visiblePaneOrder.length > 1;
  const showProductionCollapsed = productionCollapsible && productionCollapsed;
  const persistedDockLayout = useDefaultLayout({
    id: `${WORKSPACE_DOCK_LAYOUT_ID}:${layout.projectId ?? 'no-project'}${productionOpen ? ':production' : ''}`,
    panelIds: dockedPanelIds,
    storage: safePanelLayoutStorage,
    onlySaveAfterUserInteractions: true,
  });
  const dockDefaultLayout = usableConversationDockLayout(persistedDockLayout.defaultLayout);

  useEffect(() => {
    if (!showProductionPage) return;
    const syncCollapsedState = () => {
      try {
        setProductionCollapsed(Boolean(productionPanelRef.current?.isCollapsed()));
      } catch {
        // The panel registers its constraints after the first render.
        setProductionCollapsed(false);
      }
    };
    syncCollapsedState();
    const timer = window.setTimeout(syncCollapsedState, 0);
    return () => window.clearTimeout(timer);
  }, [productionPanelRef, showProductionPage, visiblePaneOrder]);

  useEffect(() => {
    setPaneOrder(readWorkspacePaneOrder(layout.projectId));
  }, [layout.projectId]);

  useEffect(() => {
    const element = conversationPanelElementRef.current;
    if (!element) return;
    element.style.overflow = 'hidden';
  }, [showConversationDock, visiblePaneOrder]);

  useEffect(() => {
    if (!showConversationDock) return;
    const restoreUsableSize = () => {
      const panel = conversationPanelRef.current;
      if (!panel) return;
      try {
        if (panel.getSize().inPixels < CONVERSATION_MIN_SIZE.width) {
          panel.resize(CONVERSATION_DEFAULT_DOCK_SIZE);
        }
      } catch {
        // Group layout is not ready on the first frame.
      }
    };
    restoreUsableSize();
    const timer = window.setTimeout(restoreUsableSize, 0);
    return () => window.clearTimeout(timer);
  }, [conversationPanelRef, showConversationDock]);

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
    if (paneId === 'assets') dispatch({ type: 'float', panelId: 'assets' });
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
    if (paneId === 'editor') return (documentActive && documentTitle) || resolvedEditorTitle;
    if (paneId === 'conversation') return '会话';
    if (paneId === 'assets') return '素材库';
    return '生产参数';
  };

  const toggleProduction = () => {
    const panel = productionPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
    setProductionCollapsed(panel.isCollapsed());
  };

  const renderPaneHeader = (paneId: WorkspacePaneId, index: number) => {
    if (paneId === 'production' && showProductionCollapsed) {
      return (
        <header className="workspace-pane-header">
          <button
            type="button"
            className="workspace-production-restore"
            title="展开生产参数"
            aria-label="展开生产参数"
            aria-expanded={false}
            onClick={toggleProduction}
          >
            <ChevronLeft size={16} />
            <SlidersHorizontal size={16} />
            <span>生产参数</span>
          </button>
        </header>
      );
    }
    const dropBefore = dropIndex === index && draggingPane !== paneId;
    const dropAfter =
      dropIndex === visiblePaneOrder.length && index === visiblePaneOrder.length - 1;
    return (
      <header className="workspace-pane-header">
        <button
          type="button"
          data-pane-id={paneId}
          className={`workspace-pane-tab ${draggingPane === paneId ? 'is-dragging ' : ''}${dropBefore ? 'drop-before ' : ''}${dropAfter ? 'drop-after' : ''}`}
          title={paneTitle(paneId)}
          onPointerDown={(event) => startPaneDrag(paneId, event)}
          onClick={(event) => {
            if (suppressTabClickRef.current) {
              event.preventDefault();
              return;
            }
            if (paneId === 'editor') openDocument();
            if (paneId === 'conversation') openConversation();
            if (paneId === 'assets') dispatch({ type: 'focus', panelId: 'assets' });
          }}
        >
          {paneId === 'editor' ? (
            <LayoutPanelTop size={14} />
          ) : paneId === 'conversation' ? (
            <Rows3 size={14} />
          ) : paneId === 'assets' ? (
            <Images size={14} />
          ) : (
            <SlidersHorizontal size={14} />
          )}
          <span>{paneTitle(paneId)}</span>
        </button>
        <div className="workspace-pane-actions">
          {paneId === 'assets' && (
            <button
              type="button"
              title="关闭素材库"
              aria-label="关闭素材库"
              onClick={() => dispatch({ type: 'close', panelId: 'assets' })}
            >
              <X size={15} />
            </button>
          )}
          {paneId === 'editor' && documentActive && (
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
              title={documentActive ? '关闭文档面板' : `关闭${resolvedEditorTitle}`}
              aria-label={documentActive ? '关闭文档面板' : `关闭${resolvedEditorTitle}`}
              onClick={onCloseDocument}
            >
              <X size={15} />
            </button>
          )}
          {paneId === 'production' && productionCollapsible && (
            <button
              type="button"
              title="收起生产参数"
              aria-label="收起生产参数"
              aria-expanded
              onClick={toggleProduction}
            >
              <ChevronRight size={15} />
            </button>
          )}
          {paneId === 'production' && onCloseProduction && (
            <button
              type="button"
              title="关闭生产参数"
              aria-label="关闭生产参数"
              onClick={onCloseProduction}
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
        </div>
      </header>
    );
  };

  const renderDockPane = (paneId: WorkspacePaneId, index: number) => {
    if (paneId === 'assets') {
      return (
        <Panel
          id="assets"
          key="assets"
          defaultSize={showProductionDock ? '32%' : showConversationDock ? '30%' : '44%'}
          minSize="320px"
        >
          <section className="workspace-docked-page workspace-assets-page">
            {renderPaneHeader(paneId, index)}
            <div className="workspace-assets-content">{assetsContent}</div>
          </section>
        </Panel>
      );
    }
    if (paneId === 'editor') {
      return (
        <Panel
          id="editor"
          key="editor"
          defaultSize={
            showProductionDock
              ? showAssetsDock
                ? '34%'
                : '50%'
              : showAssetsDock
                ? showConversationDock
                  ? '40%'
                  : '56%'
                : showConversationDock
                  ? '44%'
                  : '100%'
          }
          minSize={showProductionDock ? '320px' : '360px'}
          maxSize="100%"
        >
          <section className="workspace-docked-page workspace-editor-page" hidden={false}>
            {renderPaneHeader(paneId, index)}
            {documentDocked && <div className="workspace-base-content">{children}</div>}
            {!documentDocked && (
              <div className="workspace-closed-panel">
                <button type="button" onClick={openDocument}>
                  {editorDetached
                    ? '显示独立文档窗口'
                    : documentActive
                      ? '打开文档编辑器'
                      : `打开${resolvedEditorTitle}`}
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
          panelRef={productionPanelRef}
          defaultSize={showAssetsDock ? '34%' : showConversationDock ? '70%' : '100%'}
          minSize={showProductionDock ? '320px' : '0px'}
          collapsedSize="44px"
          collapsible={productionCollapsible}
          onResize={(size) => {
            if (size.inPixels > 0) setProductionCollapsed(size.inPixels <= 44.5);
          }}
        >
          <section
            className={`workspace-docked-page workspace-production-page${showProductionCollapsed ? ' is-collapsed' : ''}`}
          >
            {renderPaneHeader(paneId, index)}
            {productionContent}
          </section>
        </Panel>
      );
    }
    return (
      <Panel
        id="conversation"
        key="conversation"
        className="workspace-conversation-panel"
        elementRef={conversationPanelElementRef}
        panelRef={conversationPanelRef}
        defaultSize={CONVERSATION_DEFAULT_DOCK_SIZE}
        minSize={`${CONVERSATION_MIN_SIZE.width}px`}
        collapsible={false}
      >
        <section className="workspace-docked-page workspace-conversation-page">
          {renderPaneHeader(paneId, index)}
          {conversationContent}
        </section>
      </Panel>
    );
  };

  const openDocument = () => {
    if (editorDetached) {
      onOpenDocument();
      return;
    }
    dispatch({ type: narrow && productionOpen ? 'float' : 'open', panelId: 'document' });
    onOpenDocument();
  };
  const openConversation = () => {
    const action = conversationWindowOpenAction(conversationWindowOptions);
    if (action === 'focus-detached') {
      onOpenConversation();
      return;
    }
    if (action === 'float') {
      dispatch({ type: 'float', panelId: 'conversation' });
      return;
    }
    dispatch({ type: 'open', panelId: 'conversation' });
    onOpenConversation();
  };
  const dock = (panelId: 'document' | 'conversation' | 'assets') =>
    dispatch({ type: 'dock', panelId });
  const maximize = (panelId: 'document' | 'conversation' | 'assets') =>
    dispatch({ type: 'maximize', panelId, viewport });
  return (
    <div
      className={`workspace-surface ${draggingPane ? 'is-dragging' : ''} ${detachArmed ? 'is-detach-armed' : ''}`}
      ref={surfaceRef}
      onPointerMove={updateDropTarget}
      onPointerUp={finishPaneDrag}
      onPointerCancel={cancelPaneDrag}
    >
      {narrow && (
        <nav className="workspace-mobile-tabs" aria-label="工作区页面">
          <button
            type="button"
            aria-pressed={layout.activePanelId === 'document'}
            onClick={openDocument}
          >
            {resolvedEditorTitle}
          </button>
          <button
            type="button"
            aria-pressed={layout.activePanelId === 'assets'}
            onClick={() => dispatch({ type: 'open', panelId: 'assets' })}
          >
            素材库
          </button>
        </nav>
      )}
      <Group
        className="workspace-dock-group"
        orientation="horizontal"
        defaultLayout={dockDefaultLayout}
        onLayoutChanged={(nextLayout, meta) => {
          if (isUnusableConversationLayoutShare(nextLayout.conversation)) {
            return;
          }
          persistedDockLayout.onLayoutChanged(nextLayout, meta);
        }}
        resizeTargetMinimumSize={{ fine: 6, coarse: 20 }}
      >
        {paneOrder.flatMap((paneId) => {
          const index = visiblePaneOrder.indexOf(paneId);
          if (index < 0) {
            return [];
          }
          return [
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
          ];
        })}
      </Group>
      {showAssetsFloating && (
        <FloatingWindow
          panelId="assets"
          title="素材库"
          bounds={narrow ? maximizedBounds(viewport) : assetsPanel.bounds}
          viewport={viewport}
          zOrder={assetsPanel.zOrder}
          maximized={narrow || assetsPanel.mode === 'maximized'}
          hidden={narrow && layout.activePanelId !== 'assets'}
          onFocus={() => dispatch({ type: 'focus', panelId: 'assets' })}
          onClose={() => dispatch({ type: 'close', panelId: 'assets' })}
          onDock={() => dock('assets')}
          onMaximize={() => maximize('assets')}
          onRestore={() => dispatch({ type: 'restore', panelId: 'assets' })}
          onBoundsChange={(bounds) => dispatch({ type: 'setBounds', panelId: 'assets', bounds })}
        >
          <div className="workspace-assets-content">{assetsContent}</div>
        </FloatingWindow>
      )}
      {showDocumentFloating && (
        <FloatingWindow
          panelId="document"
          title={documentTitle || resolvedEditorTitle}
          bounds={narrow ? maximizedBounds(viewport) : documentPanel.bounds}
          viewport={viewport}
          zOrder={documentPanel.zOrder}
          maximized={narrow || documentPanel.mode === 'maximized'}
          hidden={narrow && layout.activePanelId !== 'document'}
          onFocus={() => dispatch({ type: 'focus', panelId: 'document' })}
          onClose={onCloseDocument}
          onDock={() => dock('document')}
          onDetach={documentActive ? onDetachDocument : undefined}
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
    </div>
  );
}
