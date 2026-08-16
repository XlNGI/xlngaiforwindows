import type { FloatingBounds, WorkspaceViewport } from './workspace-types';

export const WORKSPACE_TOP_INSET = 48;
export const WORKSPACE_PADDING = 12;

export const DOCUMENT_MIN_SIZE = { width: 560, height: 400 };
export const CONVERSATION_MIN_SIZE = { width: 360, height: 420 };

export function viewportFromWindow(): WorkspaceViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

export function defaultDocumentBounds(viewport: WorkspaceViewport): FloatingBounds {
  return clampBounds(
    { x: 24, y: WORKSPACE_TOP_INSET, width: Math.min(820, viewport.width - 48), height: 620 },
    viewport,
    DOCUMENT_MIN_SIZE,
  );
}

export function defaultConversationBounds(viewport: WorkspaceViewport): FloatingBounds {
  return clampBounds(
    {
      x: viewport.width - 432,
      y: WORKSPACE_TOP_INSET,
      width: 420,
      height: Math.min(680, viewport.height - 104),
    },
    viewport,
    CONVERSATION_MIN_SIZE,
  );
}

export function clampBounds(
  bounds: FloatingBounds,
  viewport: WorkspaceViewport,
  minimum: { width: number; height: number },
): FloatingBounds {
  const availableWidth = Math.max(1, viewport.width - WORKSPACE_PADDING * 2);
  const availableHeight = Math.max(1, viewport.height - WORKSPACE_TOP_INSET - WORKSPACE_PADDING);
  const width = Math.min(Math.max(minimum.width, bounds.width), availableWidth);
  const height = Math.min(Math.max(minimum.height, bounds.height), availableHeight);
  const minX = WORKSPACE_PADDING;
  const minY = WORKSPACE_TOP_INSET;
  const maxX = Math.max(minX, viewport.width - width - WORKSPACE_PADDING);
  const maxY = Math.max(minY, viewport.height - height - WORKSPACE_PADDING);
  return {
    x: Math.min(Math.max(bounds.x, minX), maxX),
    y: Math.min(Math.max(bounds.y, minY), maxY),
    width,
    height,
  };
}

export function maximizedBounds(viewport: WorkspaceViewport): FloatingBounds {
  return {
    x: 0,
    y: 36,
    width: Math.max(1, viewport.width),
    height: Math.max(1, viewport.height - 36),
  };
}
