import type { WorkspacePanelId, WorkspacePanelState } from './workspace-types';
import { CONVERSATION_MIN_SIZE } from './workspace-geometry';

export const CONVERSATION_STRIP_MAX_WIDTH = 80;
export const CONVERSATION_DEFAULT_DOCK_SIZE = '420px';
export const WORKSPACE_DOCK_LAYOUT_ID = 'ai-video.workspace-docks.v5';

export function shouldCloseConversationAtMinWidth(
  sizePx: number,
  previousSizePx: number | undefined,
  minWidthPx: number = CONVERSATION_MIN_SIZE.width,
): boolean {
  if (!Number.isFinite(sizePx) || sizePx < 0) return false;
  if (previousSizePx === undefined || previousSizePx <= CONVERSATION_STRIP_MAX_WIDTH) return false;
  if (previousSizePx > minWidthPx && sizePx <= minWidthPx) return true;
  return sizePx <= CONVERSATION_STRIP_MAX_WIDTH;
}

export function shouldCloseConversationLayout(
  share: number | undefined,
  groupWidthPx: number,
  previousSizePx: number | undefined,
  minWidthPx: number = CONVERSATION_MIN_SIZE.width,
): boolean {
  if (typeof share !== 'number' || !Number.isFinite(share) || groupWidthPx <= 0) return false;
  return shouldCloseConversationAtMinWidth(
    (share / 100) * groupWidthPx,
    previousSizePx,
    minWidthPx,
  );
}

export function isUnusableConversationLayoutShare(share: number | undefined): boolean {
  return typeof share === 'number' && Number.isFinite(share) && share <= 0;
}

export function usableConversationDockLayout<T extends Record<string, number>>(
  layout: T | undefined,
): T | undefined {
  if (!layout || isUnusableConversationLayoutShare(layout.conversation)) return undefined;
  return layout;
}

export const WORKSPACE_NARROW_MAX_WIDTH = 900;
export const WORKSPACE_COMPACT_SPLIT_MAX_WIDTH = 1150;

export interface ConversationWindowOptions {
  panel: WorkspacePanelState;
  detached: boolean;
  productionOpen: boolean;
  viewportWidth: number;
  activePanelId?: WorkspacePanelId;
}

export type ConversationWindowAction = 'focus-detached' | 'close' | 'float' | 'open';

export function isWorkspaceNarrow(viewportWidth: number): boolean {
  return viewportWidth <= WORKSPACE_NARROW_MAX_WIDTH;
}

export function isWorkspaceCompactSplit(viewportWidth: number): boolean {
  return viewportWidth < WORKSPACE_COMPACT_SPLIT_MAX_WIDTH;
}

export function shouldFloatConversationOnOpen({
  detached,
  productionOpen,
  viewportWidth,
}: ConversationWindowOptions): boolean {
  return !detached && productionOpen && isWorkspaceCompactSplit(viewportWidth);
}

export function isConversationAutoHidden({
  panel,
  detached,
  productionOpen,
  viewportWidth,
}: ConversationWindowOptions): boolean {
  return (
    panel.open &&
    panel.mode === 'docked' &&
    !detached &&
    productionOpen &&
    isWorkspaceCompactSplit(viewportWidth) &&
    !isWorkspaceNarrow(viewportWidth)
  );
}

export function isConversationWindowPresented(options: ConversationWindowOptions): boolean {
  const { panel, detached, productionOpen, viewportWidth, activePanelId } = options;
  if (detached) return true;
  if (!panel.open) return false;
  if (isConversationAutoHidden(options)) return false;
  if (isWorkspaceNarrow(viewportWidth) && productionOpen && panel.mode === 'docked') return false;
  if (isWorkspaceNarrow(viewportWidth) && activePanelId && activePanelId !== 'conversation') {
    return false;
  }
  return true;
}

export function conversationWindowOpenAction(
  options: ConversationWindowOptions,
): Exclude<ConversationWindowAction, 'close'> {
  if (options.detached) return 'focus-detached';
  if (shouldFloatConversationOnOpen(options)) return 'float';
  return 'open';
}

export function conversationWindowToggleAction(
  options: ConversationWindowOptions,
): ConversationWindowAction {
  if (options.detached) return 'focus-detached';
  if (isConversationWindowPresented(options)) return 'close';
  return conversationWindowOpenAction(options);
}

export function conversationWindowToggleLabel(options: ConversationWindowOptions): {
  title: string;
  ariaLabel: string;
} {
  if (options.detached) {
    return { title: '显示独立会话窗口', ariaLabel: '显示独立会话窗口' };
  }
  if (isConversationWindowPresented(options)) {
    return { title: '收起会话', ariaLabel: '收起会话' };
  }
  return { title: '打开会话', ariaLabel: '打开会话' };
}
