import { describe, expect, it } from 'vitest';
import { createDefaultWorkspaceLayout } from './workspace-reducer';
import {
  conversationWindowOpenAction,
  conversationWindowToggleAction,
  conversationWindowToggleLabel,
  isConversationAutoHidden,
  isConversationWindowPresented,
  usableConversationDockLayout,
} from './conversation-window';

const viewport = { width: 1440, height: 900 };

function options(overrides?: {
  open?: boolean;
  mode?: 'docked' | 'floating' | 'maximized';
  detached?: boolean;
  productionOpen?: boolean;
  assetsOpen?: boolean;
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
    assetsOpen: overrides?.assetsOpen ?? false,
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

  it('floats an auto-hidden conversation beside the asset library', () => {
    const autoHidden = options({ assetsOpen: true, viewportWidth: 1100 });
    expect(isConversationAutoHidden(autoHidden)).toBe(true);
    expect(isConversationWindowPresented(autoHidden)).toBe(false);
    expect(conversationWindowOpenAction(autoHidden)).toBe('float');
    expect(conversationWindowToggleAction(autoHidden)).toBe('float');

    const closed = options({ open: false, assetsOpen: true, viewportWidth: 1100 });
    expect(isConversationAutoHidden(closed)).toBe(false);
    expect(conversationWindowOpenAction(closed)).toBe('float');
  });

  it.each([
    { width: 1439, productionOpen: false, assetsOpen: true, hidden: true },
    { width: 1440, productionOpen: false, assetsOpen: true, hidden: false },
    { width: 1150, productionOpen: true, assetsOpen: false, hidden: false },
    { width: 1799, productionOpen: true, assetsOpen: true, hidden: true },
    { width: 1800, productionOpen: true, assetsOpen: true, hidden: false },
  ])(
    'reserves conversation space at $width px with production=$productionOpen and assets=$assetsOpen',
    ({ width, productionOpen, assetsOpen, hidden }) => {
      const docked = options({ viewportWidth: width, productionOpen, assetsOpen });
      expect(isConversationAutoHidden(docked)).toBe(hidden);
      expect(isConversationWindowPresented(docked)).toBe(!hidden);
      expect(conversationWindowOpenAction(docked)).toBe(hidden ? 'float' : 'open');
    },
  );

  it('opens conversation as a floating window in a narrow asset workspace', () => {
    const narrow = options({ assetsOpen: true, viewportWidth: 800 });
    expect(isConversationWindowPresented(narrow)).toBe(false);
    expect(conversationWindowToggleAction(narrow)).toBe('float');
  });

  it('keeps a floating conversation visible beside both asset and production panes', () => {
    const floating = options({
      mode: 'floating',
      productionOpen: true,
      assetsOpen: true,
      viewportWidth: 1200,
    });
    expect(isConversationAutoHidden(floating)).toBe(false);
    expect(isConversationWindowPresented(floating)).toBe(true);
    expect(conversationWindowToggleAction(floating)).toBe('close');
  });

  it('closes a visible floating conversation instead of creating another one', () => {
    const floating = options({ mode: 'floating' });
    expect(isConversationWindowPresented(floating)).toBe(true);
    expect(conversationWindowToggleAction(floating)).toBe('close');
  });

  it('focuses a detached conversation window from the toggle', () => {
    const detached = options({
      open: false,
      detached: true,
      productionOpen: true,
      assetsOpen: true,
      viewportWidth: 1100,
    });
    expect(isConversationWindowPresented(detached)).toBe(true);
    expect(conversationWindowToggleAction(detached)).toBe('focus-detached');
    expect(conversationWindowToggleLabel(detached)).toEqual({
      title: '显示独立会话窗口',
      ariaLabel: '显示独立会话窗口',
    });
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
