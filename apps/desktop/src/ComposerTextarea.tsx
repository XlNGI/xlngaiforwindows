import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ClipboardEventHandler,
  type KeyboardEventHandler,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, RotateCcw, X } from 'lucide-react';

const MIN_HEIGHT = 72;
const MAX_HEIGHT = 240;

interface ComposerTextareaProps {
  value: string;
  placeholder: string;
  disabled: boolean;
  panelRef: RefObject<HTMLElement | null>;
  onChange: (value: string) => void;
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  actions: ReactNode;
}

export function ComposerTextarea({
  value,
  placeholder,
  disabled,
  panelRef,
  onChange,
  onPaste,
  onKeyDown,
  actions,
}: ComposerTextareaProps) {
  const inputId = useId();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const expandedRef = useRef<HTMLTextAreaElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const selection = useRef({ start: 0, end: 0 });
  const drag = useRef<{ pointerId: number; y: number; height: number } | undefined>(undefined);
  const previousValue = useRef(value);
  const [manualHeight, setManualHeight] = useState<number>();
  const [height, setHeight] = useState(MIN_HEIGHT);
  const [maximum, setMaximum] = useState(MAX_HEIGHT);
  const [expanded, setExpanded] = useState(false);

  useLayoutEffect(() => {
    if (!value && previousValue.current) setManualHeight(undefined);
    previousValue.current = value;
  }, [value]);

  const measure = useCallback(() => {
    const input = textareaRef.current;
    const panel = panelRef.current;
    // Workspace tabs can stay mounted while hidden. Measure again when visible.
    if (!input || !panel || panel.clientHeight === 0 || input.clientWidth === 0) return;
    panel.style.setProperty('--composer-panel-height', `${panel.clientHeight}px`);
    const limit = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.floor(panel.clientHeight * 0.35)));
    const scrollTop = input.scrollTop;
    input.style.height = '0px';
    const naturalHeight = input.scrollHeight;
    const nextHeight = Math.max(MIN_HEIGHT, Math.min(limit, manualHeight ?? naturalHeight));
    input.style.height = `${nextHeight}px`;
    input.scrollTop =
      document.activeElement === input && input.selectionEnd === value.length
        ? input.scrollHeight
        : scrollTop;
    setHeight(nextHeight);
    setMaximum(limit);
  }, [manualHeight, panelRef, value]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    // The containing panel's ref is attached after child layout effects.
    // Measure once refs are ready, including when mounting with an existing draft.
    measure();
    const input = textareaRef.current;
    const panel = panelRef.current;
    if (!input || !panel) return;
    let width = input.clientWidth;
    let panelHeight = panel.clientHeight;
    const onResize = () => {
      if (input.clientWidth === width && panel.clientHeight === panelHeight) return;
      width = input.clientWidth;
      panelHeight = panel.clientHeight;
      measure();
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(onResize);
    observer?.observe(input);
    observer?.observe(panel);
    window.addEventListener('resize', onResize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', onResize);
    };
  }, [measure, panelRef]);

  useEffect(() => {
    if (!expanded) return;
    const input = expandedRef.current;
    input?.focus();
    input?.setSelectionRange(selection.current.start, selection.current.end);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
      } else if (event.key === 'Tab') {
        const controls = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea:not(:disabled)',
          ) ?? [],
        );
        const index = controls.indexOf(document.activeElement as HTMLElement);
        if (
          controls.length &&
          (index < 0 || (event.shiftKey ? index === 0 : index === controls.length - 1))
        ) {
          event.preventDefault();
          controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown, true);
      const inlineInput = textareaRef.current;
      if (inlineInput?.isConnected && !inlineInput.disabled) {
        inlineInput.focus();
        inlineInput.setSelectionRange(selection.current.start, selection.current.end);
      }
    };
  }, [expanded]);

  const setRequestedHeight = (next: number) => {
    setManualHeight(Math.max(MIN_HEIGHT, Math.min(maximum, next)));
  };
  const rememberSelection = (input: HTMLTextAreaElement) => {
    selection.current = { start: input.selectionStart, end: input.selectionEnd };
  };

  return (
    <>
      <div
        className="composer-resize-handle"
        role="separator"
        aria-label="调整提示词输入框高度"
        aria-orientation="horizontal"
        aria-controls={inputId}
        aria-valuemin={MIN_HEIGHT}
        aria-valuemax={maximum}
        aria-valuenow={height}
        aria-valuetext={`${Math.round(height)} 像素，${manualHeight === undefined ? '自动高度' : '手动高度'}`}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        title="向上拖动增高；也可用上、下方向键调整"
        onPointerDown={(event) => {
          if (disabled || event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          drag.current = { pointerId: event.pointerId, y: event.clientY, height };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (disabled) {
            drag.current = undefined;
            return;
          }
          if (!drag.current || drag.current.pointerId !== event.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          setRequestedHeight(drag.current.height + drag.current.y - event.clientY);
        }}
        onPointerUp={(event) => {
          if (drag.current?.pointerId !== event.pointerId) return;
          drag.current = undefined;
          event.currentTarget.releasePointerCapture?.(event.pointerId);
        }}
        onPointerCancel={() => {
          drag.current = undefined;
        }}
        onLostPointerCapture={() => {
          drag.current = undefined;
        }}
        onKeyDown={(event) => {
          if (disabled) return;
          const next =
            event.key === 'ArrowUp'
              ? height + 16
              : event.key === 'ArrowDown'
                ? height - 16
                : event.key === 'Home'
                  ? MIN_HEIGHT
                  : event.key === 'End'
                    ? maximum
                    : undefined;
          if (next === undefined) return;
          event.preventDefault();
          event.stopPropagation();
          setRequestedHeight(next);
        }}
      >
        <span />
      </div>
      <textarea
        ref={textareaRef}
        id={inputId}
        className="composer-textarea"
        aria-label="会话消息"
        placeholder={placeholder}
        rows={3}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        disabled={disabled}
      />
      <div className="composer-toolbar">
        <div className="composer-edit-actions">
          <button
            type="button"
            className="icon-button subtle"
            title="展开编辑"
            aria-label="展开编辑提示词"
            disabled={disabled}
            onClick={() => {
              if (textareaRef.current) rememberSelection(textareaRef.current);
              setExpanded(true);
            }}
          >
            <Maximize2 size={14} />
          </button>
          {manualHeight !== undefined && (
            <button
              type="button"
              className="icon-button subtle"
              title="恢复自动高度"
              aria-label="恢复自动高度"
              disabled={disabled}
              onClick={() => setManualHeight(undefined)}
            >
              <RotateCcw size={14} />
            </button>
          )}
        </div>
        <div className="composer-submit-actions">{actions}</div>
      </div>
      {expanded
        ? createPortal(
            <div
              className="composer-editor-backdrop"
              onClick={(event) => {
                if (event.target === event.currentTarget) setExpanded(false);
              }}
            >
              <section
                ref={dialogRef}
                className="composer-editor-dialog"
                role="dialog"
                aria-modal="true"
                aria-label="展开编辑提示词"
              >
                <header>
                  <h3>编辑提示词</h3>
                  <button
                    type="button"
                    className="icon-button subtle"
                    aria-label="关闭提示词编辑器"
                    onClick={() => setExpanded(false)}
                  >
                    <X size={18} />
                  </button>
                </header>
                <textarea
                  ref={expandedRef}
                  aria-label="提示词全文"
                  value={value}
                  placeholder={placeholder}
                  disabled={disabled}
                  onChange={(event) => {
                    rememberSelection(event.target);
                    onChange(event.target.value);
                  }}
                  onSelect={(event) => rememberSelection(event.currentTarget)}
                  onPaste={onPaste}
                />
                <footer>
                  <small>Enter 换行，编辑内容自动保留</small>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => setExpanded(false)}
                  >
                    完成编辑
                  </button>
                </footer>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
