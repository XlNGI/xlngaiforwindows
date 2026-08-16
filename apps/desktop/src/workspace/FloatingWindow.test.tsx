import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FloatingWindow } from './FloatingWindow';

describe('FloatingWindow', () => {
  it('exposes dock, maximize, restore, and close actions through the title bar', () => {
    const onClose = vi.fn();
    const onDock = vi.fn();
    const onMaximize = vi.fn();
    const onRestore = vi.fn();
    const onDetach = vi.fn();
    const { rerender } = render(
      <FloatingWindow
        panelId="conversation"
        title="会话"
        bounds={{ x: 24, y: 48, width: 420, height: 600 }}
        viewport={{ width: 1200, height: 800 }}
        zOrder={1}
        maximized={false}
        onFocus={vi.fn()}
        onClose={onClose}
        onDock={onDock}
        onDetach={onDetach}
        onMaximize={onMaximize}
        onRestore={onRestore}
        onBoundsChange={vi.fn()}
      >
        内容
      </FloatingWindow>,
    );

    fireEvent.click(screen.getByLabelText('停靠面板'));
    fireEvent.click(screen.getByLabelText('在独立窗口打开'));
    fireEvent.click(screen.getByLabelText('最大化浮窗'));
    fireEvent.click(screen.getByLabelText('关闭浮窗'));
    expect(onDock).toHaveBeenCalledOnce();
    expect(onDetach).toHaveBeenCalledOnce();
    expect(onMaximize).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    rerender(
      <FloatingWindow
        panelId="conversation"
        title="会话"
        bounds={{ x: 0, y: 36, width: 1200, height: 764 }}
        viewport={{ width: 1200, height: 800 }}
        zOrder={1}
        maximized
        onFocus={vi.fn()}
        onClose={onClose}
        onDock={onDock}
        onDetach={onDetach}
        onMaximize={onMaximize}
        onRestore={onRestore}
        onBoundsChange={vi.fn()}
      >
        内容
      </FloatingWindow>,
    );

    fireEvent.click(screen.getByLabelText('还原浮窗'));
    expect(onRestore).toHaveBeenCalledOnce();
  });
});
