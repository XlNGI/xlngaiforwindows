import { ExternalLink, Maximize2, Minimize2, PanelRightOpen, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { clampBounds, CONVERSATION_MIN_SIZE, DOCUMENT_MIN_SIZE } from './workspace-geometry';
import type { PointerEvent as ReactPointerEvent, ReactNode } from 'react';
import type { FloatingBounds, WorkspacePanelId, WorkspaceViewport } from './workspace-types';

type ResizeEdge = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface FloatingWindowProps {
  panelId: WorkspacePanelId;
  title: string;
  bounds: FloatingBounds;
  viewport: WorkspaceViewport;
  zOrder: number;
  maximized: boolean;
  onFocus: () => void;
  onClose: () => void;
  onDock: () => void;
  onDetach?: () => void;
  onMaximize: () => void;
  onRestore: () => void;
  onBoundsChange: (bounds: FloatingBounds) => void;
  children: ReactNode;
}

interface PointerInteraction {
  pointerId: number;
  kind: 'move' | 'resize';
  edge?: ResizeEdge;
  startX: number;
  startY: number;
  bounds: FloatingBounds;
}

export function FloatingWindow({
  panelId,
  title,
  bounds,
  viewport,
  zOrder,
  maximized,
  onFocus,
  onClose,
  onDock,
  onDetach,
  onMaximize,
  onRestore,
  onBoundsChange,
  children,
}: FloatingWindowProps) {
  const interaction = useRef<PointerInteraction | undefined>(undefined);
  const minimum = panelId === 'document' ? DOCUMENT_MIN_SIZE : CONVERSATION_MIN_SIZE;

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const active = interaction.current;
      if (!active || active.pointerId !== event.pointerId) return;
      const deltaX = event.clientX - active.startX;
      const deltaY = event.clientY - active.startY;
      const next = { ...active.bounds };
      if (active.kind === 'move') {
        next.x += deltaX;
        next.y += deltaY;
      } else if (active.edge) {
        if (active.edge.includes('e')) next.width += deltaX;
        if (active.edge.includes('s')) next.height += deltaY;
        if (active.edge.includes('w')) {
          next.x += deltaX;
          next.width -= deltaX;
        }
        if (active.edge.includes('n')) {
          next.y += deltaY;
          next.height -= deltaY;
        }
        if (next.width < minimum.width) {
          if (active.edge.includes('w')) next.x -= minimum.width - next.width;
          next.width = minimum.width;
        }
        if (next.height < minimum.height) {
          if (active.edge.includes('n')) next.y -= minimum.height - next.height;
          next.height = minimum.height;
        }
      }
      onBoundsChange(clampBounds(next, viewport, minimum));
    };
    const onEnd = (event: PointerEvent) => {
      if (interaction.current?.pointerId === event.pointerId) interaction.current = undefined;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
    };
  }, [minimum, onBoundsChange, viewport]);

  const begin = (event: ReactPointerEvent, kind: PointerInteraction['kind'], edge?: ResizeEdge) => {
    if (maximized) return;
    event.preventDefault();
    onFocus();
    interaction.current = {
      pointerId: event.pointerId,
      kind,
      edge,
      startX: event.clientX,
      startY: event.clientY,
      bounds,
    };
  };

  return (
    <section
      className={`floating-window floating-window-${panelId} ${maximized ? 'maximized' : ''}`}
      aria-label={title}
      style={{
        left: bounds.x,
        top: bounds.y,
        width: bounds.width,
        height: bounds.height,
        zIndex: 100 + zOrder,
      }}
      onPointerDown={onFocus}
    >
      <header
        className="floating-window-titlebar"
        onPointerDown={(event) => begin(event, 'move')}
        onDoubleClick={() => (maximized ? onRestore() : onMaximize())}
      >
        <strong>{title}</strong>
        <div className="floating-window-actions" onPointerDown={(event) => event.stopPropagation()}>
          {onDetach && (
            <button
              type="button"
              title="在独立窗口打开"
              aria-label="在独立窗口打开"
              onClick={onDetach}
            >
              <ExternalLink size={14} />
            </button>
          )}
          <button type="button" title="停靠面板" aria-label="停靠面板" onClick={onDock}>
            <PanelRightOpen size={14} />
          </button>
          <button
            type="button"
            title={maximized ? '还原浮窗' : '最大化浮窗'}
            aria-label={maximized ? '还原浮窗' : '最大化浮窗'}
            onClick={maximized ? onRestore : onMaximize}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button type="button" title="关闭浮窗" aria-label="关闭浮窗" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
      </header>
      <div className="floating-window-content">{children}</div>
      {!maximized &&
        (['n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'] as ResizeEdge[]).map((edge) => (
          <span
            key={edge}
            className={`floating-window-resizer floating-window-resizer-${edge}`}
            onPointerDown={(event) => begin(event, 'resize', edge)}
          />
        ))}
    </section>
  );
}
