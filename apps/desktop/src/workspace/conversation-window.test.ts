import { describe, expect, it } from 'vitest';
import { createDefaultWorkspaceLayout } from './workspace-reducer';
import {
  conversationWindowOpenAction,
  conversationWindowToggleAction,
  conversationWindowToggleLabel,
  isConversationAutoHidden,
  isConversationWindowPresented,
  shouldCloseConversationAtMinWidth,
  shouldCloseConversationLayout,
  usableConversationDockLayout,
} from './conversation-window';

const viewport = { width: 1440, height: 900 };

function options(overrides?: {
  open?: boolean;
  mode?: 'docked' | 'floating' | 'maximized';
  detached?: boolean;
  productionOpen?: boolean;
  viewportWidth?: number;
  activePanelId?: 'document' | 'conversation';
}) {
  const layout = createDefaultWorkspaceLayout('project', viewport);
  return {
    panel: {
      ...layout.panels.conversation,
      open: overrides?.open ?? layout.panels.conversation.open,
      mode: overrides?.mode ?? layout.panels.conversation.mode,
    },
    detached: overrides?.detached ?? false,
    productionOpen: overrides?.productionOpen ?? false,
    viewportWidth: overrides?.viewportWidth ?? viewport.width,
    activePanelId: overrides?.activePanelId ?? layout.activePanelId,
  };
}

describe('conversation window toggle', () => {
  it('collapses a visible docked conversation and reopens it in place', () => {
    const visible = options();
    expect(isConversationWindowPresented(visible)).toBe(true);
    expect(conversationWindowToggleAction(visible)).toBe('close');
    expect(conversationWindowToggleLabel(visible)).toEqual({
      title: '收起会话',
      ariaLabel: '收起会话',
    });

    const hidden = options({ open: false });
    expect(isConversationWindowPresented(hidden)).toBe(false);
    expect(conversationWindowToggleAction(hidden)).toBe('open');
    expect(conversationWindowOpenAction(hidden)).toBe('open');
    expect(conversationWindowToggleLabel(hidden)).toEqual({
      title: '打开会话',
      ariaLabel: '打开会话',
    });
  });

  it('floats an auto-hidden docked conversation beside production', () => {
    const autoHidden = options({ productionOpen: true, viewportWidth: 1100 });
    expect(isConversationAutoHidden(autoHidden)).toBe(true);
    expect(isConversationWindowPresented(autoHidden)).toBe(false);
    expect(conversationWindowToggleAction(autoHidden)).toBe('float');
  });

  it('floats a closed conversation beside production instead of reopening a hidden dock', () => {
    const closed = options({ open: false, productionOpen: true, viewportWidth: 1100 });
    expect(isConversationAutoHidden(closed)).toBe(false);
    expect(isConversationWindowPresented(closed)).toBe(false);
    expect(conversationWindowToggleAction(closed)).toBe('float');
    expect(conversationWindowOpenAction(closed)).toBe('float');
  });

  it('floats conversation on demand in a narrow production workspace', () => {
    const narrow = options({
      open: false,
      productionOpen: true,
      viewportWidth: 800,
    });
    expect(conversationWindowToggleAction(narrow)).toBe('float');
  });

  it('closes a visible floating conversation instead of creating another one', () => {
    const floating = options({ mode: 'floating' });
    expect(isConversationWindowPresented(floating)).toBe(true);
    expect(conversationWindowToggleAction(floating)).toBe('close');
  });

  it('focuses a detached conversation window from the toggle', () => {
    const detached = options({ open: false, detached: true });
    expect(isConversationWindowPresented(detached)).toBe(true);
    expect(conversationWindowToggleAction(detached)).toBe('focus-detached');
    expect(conversationWindowToggleLabel(detached)).toEqual({
      title: '显示独立会话窗口',
      ariaLabel: '显示独立会话窗口',
    });
  });
});

describe('shouldCloseConversationAtMinWidth', () => {
  it('closes when a resize reaches the minimum width', () => {
    expect(shouldCloseConversationAtMinWidth(360, 420)).toBe(true);
  });

  it('closes a collapsed strip after the conversation was already usable', () => {
    expect(shouldCloseConversationAtMinWidth(0, 420)).toBe(true);
    expect(shouldCloseConversationAtMinWidth(8, 360)).toBe(true);
  });

  it('does not close a conversation while it is opening or staying usable', () => {
    expect(shouldCloseConversationAtMinWidth(0, undefined)).toBe(false);
    expect(shouldCloseConversationAtMinWidth(24, undefined)).toBe(false);
    expect(shouldCloseConversationAtMinWidth(360, undefined)).toBe(false);
    expect(shouldCloseConversationAtMinWidth(360, 360)).toBe(false);
    expect(shouldCloseConversationAtMinWidth(480, 520)).toBe(false);
  });
});

describe('shouldCloseConversationLayout', () => {
  it('closes when the user drags the conversation down to its minimum width', () => {
    expect(shouldCloseConversationLayout(0, 1200, 420)).toBe(true);
    expect(shouldCloseConversationLayout(30, 1200, 480)).toBe(true);
  });

  it('does not close the first layout frame so the conversation can reopen', () => {
    expect(shouldCloseConversationLayout(0, 1200, undefined)).toBe(false);
    expect(shouldCloseConversationLayout(0, 0, 420)).toBe(false);
    expect(shouldCloseConversationLayout(30, 1200, undefined)).toBe(false);
    expect(shouldCloseConversationLayout(40, 1200, 520)).toBe(false);
  });
});

describe('usableConversationDockLayout', () => {
  it('drops a collapsed 0% conversation so reopen uses the default pane width', () => {
    expect(usableConversationDockLayout({ editor: 100, conversation: 0 })).toBeUndefined();
    expect(usableConversationDockLayout({ editor: 70, conversation: 30 })).toEqual({
      editor: 70,
      conversation: 30,
    });
  });
});
