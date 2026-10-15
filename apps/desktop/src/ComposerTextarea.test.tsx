import { useRef, useState, type ComponentProps } from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerTextarea } from './ComposerTextarea';

type ComposerProps = ComponentProps<typeof ComposerTextarea>;

function Harness({
  initialValue = '',
  disabled = false,
  onPaste = vi.fn(),
  onKeyDown = vi.fn(),
}: {
  initialValue?: string;
  disabled?: boolean;
  onPaste?: ComposerProps['onPaste'];
  onKeyDown?: ComposerProps['onKeyDown'];
}) {
  const panelRef = useRef<HTMLElement>(null);
  const [value, setValue] = useState(initialValue);
  return (
    <section ref={panelRef} data-testid="composer-panel">
      <ComposerTextarea
        value={value}
        placeholder="输入提示词"
        disabled={disabled}
        panelRef={panelRef}
        onChange={setValue}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        actions={<button disabled={disabled}>发送</button>}
      />
    </section>
  );
}

let panelHeight: number;
let inputWidth: number;
let contentHeight: number;
let naturalHeight: (input: HTMLTextAreaElement) => number;
const observers = new Set<ResizeObserverMock>();

class ResizeObserverMock implements ResizeObserver {
  private callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.add(this);
  }

  observe() {}

  unobserve() {}

  disconnect() {
    observers.delete(this);
  }

  notify() {
    this.callback([], this);
  }
}

function resize() {
  act(() => {
    [...observers].forEach((observer) => observer.notify());
  });
}

function inlineInput() {
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: '会话消息' });
}

function heightControl() {
  return screen.getByRole('separator', { name: '调整提示词输入框高度' });
}

function expectHeight(height: number) {
  expect(heightControl()).toHaveAttribute('aria-valuenow', String(height));
  expect(inlineInput()).toHaveStyle({ height: `${height}px` });
}

function expand() {
  fireEvent.click(screen.getByRole('button', { name: '展开编辑提示词' }));
  return screen.getByRole('dialog', { name: '展开编辑提示词' });
}

beforeEach(() => {
  panelHeight = 600;
  inputWidth = 320;
  contentHeight = 48;
  naturalHeight = () => contentHeight;
  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.testid === 'composer-panel' ? panelHeight : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.getAttribute('aria-label') === '会话消息' ? inputWidth : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this instanceof HTMLTextAreaElement ? naturalHeight(this) : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  observers.clear();
  document.body.style.overflow = '';
});

describe('ComposerTextarea sizing', () => {
  it('grows and shrinks with controlled text while enforcing panel and absolute limits', () => {
    render(<Harness />);
    expectHeight(72);

    contentHeight = 156;
    fireEvent.change(inlineInput(), { target: { value: '较长的提示词\n下一段内容' } });
    expectHeight(156);

    contentHeight = 500;
    fireEvent.change(inlineInput(), { target: { value: '完整提示词\n'.repeat(40) } });
    expectHeight(210);
    expect(heightControl()).toHaveAttribute('aria-valuemax', '210');

    panelHeight = 1000;
    resize();
    expectHeight(240);
    expect(heightControl()).toHaveAttribute('aria-valuemax', '240');

    contentHeight = 48;
    fireEvent.change(inlineInput(), { target: { value: '简短提示词' } });
    expectHeight(72);
  });

  it('remeasures wrapped text when input width changes without editing its value', () => {
    naturalHeight = () => (inputWidth < 200 ? 184 : 88);
    render(<Harness initialValue="需要随停靠面板宽度变化重新换行的提示词" />);
    expectHeight(88);

    inputWidth = 180;
    resize();
    expectHeight(184);

    inputWidth = 420;
    resize();
    expectHeight(88);
    expect(inlineInput()).toHaveValue('需要随停靠面板宽度变化重新换行的提示词');
  });

  it('uses the window resize fallback when ResizeObserver is unavailable', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    contentHeight = 180;
    render(<Harness initialValue="提示词" />);
    expectHeight(180);

    panelHeight = 300;
    fireEvent(window, new Event('resize'));
    expectHeight(105);
  });

  it('retains a manual height through edits until automatic sizing is restored', () => {
    render(<Harness initialValue="原始提示词" />);
    fireEvent.keyDown(heightControl(), { key: 'ArrowUp' });
    expectHeight(88);
    expect(heightControl()).toHaveAttribute('aria-valuetext', '88 像素，手动高度');

    contentHeight = 190;
    fireEvent.change(inlineInput(), { target: { value: '新增许多内容\n'.repeat(8) } });
    expectHeight(88);

    fireEvent.keyDown(heightControl(), { key: 'ArrowDown' });
    expectHeight(72);
    fireEvent.keyDown(heightControl(), { key: 'End' });
    expectHeight(210);
    fireEvent.keyDown(heightControl(), { key: 'Home' });
    expectHeight(72);

    fireEvent.click(screen.getByRole('button', { name: '恢复自动高度' }));
    expectHeight(190);
    expect(heightControl()).toHaveAttribute('aria-valuetext', '190 像素，自动高度');
    expect(screen.queryByRole('button', { name: '恢复自动高度' })).not.toBeInTheDocument();
  });

  it('clamps manual sizing to a smaller panel and restores it when room returns', () => {
    render(<Harness initialValue="提示词" />);
    fireEvent.keyDown(heightControl(), { key: 'End' });
    expectHeight(210);

    panelHeight = 320;
    resize();
    expectHeight(112);
    expect(heightControl()).toHaveAttribute('aria-valuemax', '112');

    panelHeight = 100;
    resize();
    expectHeight(72);
    expect(heightControl()).toHaveAttribute('aria-valuemax', '72');

    panelHeight = 600;
    resize();
    expectHeight(210);
  });

  it('returns to automatic sizing when a nonempty prompt is cleared', () => {
    render(<Harness initialValue="即将发送的提示词" />);
    fireEvent.keyDown(heightControl(), { key: 'End' });
    expectHeight(210);

    fireEvent.change(inlineInput(), { target: { value: '' } });
    expectHeight(72);
    expect(screen.queryByRole('button', { name: '恢复自动高度' })).not.toBeInTheDocument();

    contentHeight = 140;
    fireEvent.change(inlineInput(), { target: { value: '新的提示词\n继续输入' } });
    expectHeight(140);
  });

  it('skips hidden measurements and catches up when the panel becomes visible', () => {
    inputWidth = 0;
    contentHeight = 148;
    render(<Harness initialValue="隐藏页签中的提示词" />);
    expect(heightControl()).toHaveAttribute('aria-valuenow', '72');

    inputWidth = 320;
    resize();
    expectHeight(148);

    panelHeight = 0;
    resize();
    contentHeight = 196;
    fireEvent.change(inlineInput(), { target: { value: '隐藏时更新的更长提示词' } });
    expectHeight(148);

    panelHeight = 600;
    resize();
    expectHeight(196);
  });

  it('supports pointer sizing and ends the drag on release or cancellation', () => {
    render(<Harness initialValue="提示词" />);
    const control = heightControl();
    fireEvent.pointerDown(control, { button: 0, pointerId: 7, clientY: 300 });
    fireEvent.pointerMove(control, { pointerId: 7, clientY: 220 });
    expectHeight(152);
    fireEvent.pointerMove(control, { pointerId: 8, clientY: 100 });
    expectHeight(152);
    fireEvent.pointerUp(control, { pointerId: 7 });
    fireEvent.pointerMove(control, { pointerId: 7, clientY: 100 });
    expectHeight(152);

    fireEvent.pointerDown(control, { button: 0, pointerId: 9, clientY: 300 });
    fireEvent.pointerMove(control, { pointerId: 9, clientY: 0 });
    expectHeight(210);
    fireEvent.pointerCancel(control, { pointerId: 9 });
    fireEvent.pointerMove(control, { pointerId: 9, clientY: 500 });
    expectHeight(210);
  });
});

describe('ComposerTextarea expanded editor', () => {
  it('shares controlled text and paste behavior without forwarding Enter to send', () => {
    const onPaste = vi.fn();
    const onKeyDown = vi.fn();
    const view = render(
      <Harness initialValue="第一段提示词和第二段" onPaste={onPaste} onKeyDown={onKeyDown} />,
    );
    const inline = inlineInput();
    inline.focus();
    inline.setSelectionRange(2, 7);
    const dialog = expand();
    expect(view.container).not.toContainElement(dialog);
    const editor = within(dialog).getByRole<HTMLTextAreaElement>('textbox', { name: '提示词全文' });
    expect(editor).toHaveFocus();
    expect(editor).toHaveValue('第一段提示词和第二段');
    expect(editor.selectionStart).toBe(2);
    expect(editor.selectionEnd).toBe(7);

    fireEvent.change(editor, {
      target: { value: '第一段\n补充后的第二段', selectionStart: 5, selectionEnd: 10 },
    });
    expect(inline).toHaveValue('第一段\n补充后的第二段');
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onKeyDown).not.toHaveBeenCalled();
    fireEvent.paste(editor, { clipboardData: { getData: () => '粘贴的提示词' } });
    expect(onPaste).toHaveBeenCalledOnce();

    fireEvent.click(within(dialog).getByRole('button', { name: '完成编辑' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(inline).toHaveFocus();
    expect(inline.selectionStart).toBe(5);
    expect(inline.selectionEnd).toBe(10);
    fireEvent.keyDown(inline, { key: 'Enter' });
    expect(onKeyDown).toHaveBeenCalledOnce();
  });

  it.each(['close button', 'backdrop', 'Escape'])(
    'returns focus and selection when closed with %s',
    (method) => {
      document.body.style.overflow = 'auto';
      render(<Harness initialValue="需要保持光标位置的提示词" />);
      const inline = inlineInput();
      inline.focus();
      inline.setSelectionRange(1, 4);
      const dialog = expand();
      expect(document.body.style.overflow).toBe('hidden');
      const editor = within(dialog).getByRole('textbox', { name: '提示词全文' });
      fireEvent.select(editor, { target: { selectionStart: 3, selectionEnd: 6 } });
      fireEvent.click(dialog);
      expect(dialog).toBeInTheDocument();

      if (method === 'close button') {
        fireEvent.click(within(dialog).getByRole('button', { name: '关闭提示词编辑器' }));
      } else if (method === 'backdrop') {
        fireEvent.click(dialog.parentElement!);
      } else {
        fireEvent.keyDown(editor, { key: 'Escape' });
      }

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(inline).toHaveFocus();
      expect(inline.selectionStart).toBe(3);
      expect(inline.selectionEnd).toBe(6);
      expect(document.body.style.overflow).toBe('auto');
    },
  );

  it('traps Tab within the editor and keeps IME Escape inside the dialog', () => {
    render(<Harness initialValue="中文输入中的提示词" />);
    const dialog = expand();
    const close = within(dialog).getByRole('button', { name: '关闭提示词编辑器' });
    const done = within(dialog).getByRole('button', { name: '完成编辑' });
    done.focus();
    fireEvent.keyDown(done, { key: 'Tab' });
    expect(close).toHaveFocus();
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(done).toHaveFocus();

    fireEvent.keyDown(done, { key: 'Escape', isComposing: true });
    expect(dialog).toBeInTheDocument();
    fireEvent.keyDown(done, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(inlineInput()).toHaveFocus();
  });

  it('disables inline editing, resizing, and expansion for an unavailable composer', () => {
    const view = render(<Harness initialValue="只读项目中的提示词" />);
    fireEvent.keyDown(heightControl(), { key: 'ArrowUp' });
    expectHeight(88);
    view.rerender(<Harness initialValue="只读项目中的提示词" disabled />);
    expect(inlineInput()).toBeDisabled();
    expect(screen.getByRole('button', { name: '展开编辑提示词' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '恢复自动高度' })).toBeDisabled();
    expect(heightControl()).toHaveAttribute('aria-disabled', 'true');
    expect(heightControl()).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(heightControl(), { key: 'End' });
    fireEvent.pointerDown(heightControl(), { button: 0, pointerId: 1, clientY: 200 });
    fireEvent.pointerMove(heightControl(), { pointerId: 1, clientY: 0 });
    fireEvent.click(screen.getByRole('button', { name: '展开编辑提示词' }));
    expectHeight(88);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('disables the expanded input if the project becomes unavailable while editing', () => {
    const view = render(<Harness initialValue="正在编辑的提示词" />);
    const dialog = expand();
    view.rerender(<Harness initialValue="正在编辑的提示词" disabled />);
    expect(within(dialog).getByRole('textbox', { name: '提示词全文' })).toBeDisabled();
    expect(inlineInput()).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '完成编辑' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(inlineInput()).not.toHaveFocus();
  });

  it('stops an active resize when the composer becomes disabled', () => {
    const view = render(<Harness initialValue="提示词" />);
    const control = heightControl();
    fireEvent.pointerDown(control, { button: 0, pointerId: 3, clientY: 300 });
    fireEvent.pointerMove(control, { pointerId: 3, clientY: 260 });
    expectHeight(112);

    view.rerender(<Harness initialValue="提示词" disabled />);
    fireEvent.pointerMove(control, { pointerId: 3, clientY: 100 });
    expectHeight(112);
  });
});
