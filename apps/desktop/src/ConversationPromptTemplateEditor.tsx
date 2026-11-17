import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import {
  DEFAULT_PROMPT_TEMPLATES,
  PROMPT_TEMPLATE_KINDS,
  PROMPT_TEMPLATE_LABELS,
  type ConversationInfo,
  type PromptTemplateKind,
} from '@ai-video/contracts';
import { MODAL_Z_INDEX } from './workspace/ui-layers';
import { readPromptTemplateFile } from './prompt-template-import';

interface ConversationPromptTemplateEditorProps {
  triggerLabel?: string;
  onOpen?: () => void;
  conversation?: ConversationInfo;
  writable: boolean;
  scopeAvailable: boolean;
  value: string;
  kind: PromptTemplateKind;
  onChange: (value: string) => void;
  onKindChange?: (kind: PromptTemplateKind) => void;
  onSave?: () => void;
  onReload?: () => void;
  busy: boolean;
  loading: boolean;
  dirty: boolean;
  error: string;
}

/** The host keys this editor by project and conversation; drafts remain in the host's store. */
export function ConversationPromptTemplateEditor({
  triggerLabel = '本会话要求约束',
  onOpen,
  conversation,
  writable,
  scopeAvailable,
  value,
  kind,
  onChange,
  onKindChange,
  onSave,
  onReload,
  busy,
  loading,
  dirty,
  error,
}: ConversationPromptTemplateEditorProps) {
  const [open, setOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [showDefault, setShowDefault] = useState(false);
  const [importError, setImportError] = useState('');
  const [imported, setImported] = useState<{ name: string; previous: string }>();
  const fileRef = useRef<HTMLInputElement>(null);
  const importEpoch = useRef(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const id = useId();
  const editable = Boolean(conversation && writable && scopeAvailable && !conversation.archivedAt);
  const disabled = !editable || busy;
  const defaultValue = DEFAULT_PROMPT_TEMPLATES[kind];
  const scopeLabel = `仅在创作${PROMPT_TEMPLATE_LABELS[kind]}时使用`;

  useEffect(() => {
    importEpoch.current++;
    setImported(undefined);
    setImportError('');
    return () => {
      importEpoch.current++;
    };
  }, [kind, conversation?.id, open, disabled]);

  useEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const input = textareaRef.current;
    if (input && !input.disabled) input.focus();
    else dialogRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing) {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      } else if (event.key === 'Tab') {
        const controls = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled), select:not(:disabled), textarea:not(:disabled)',
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
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (trigger?.isConnected && !trigger.disabled) trigger.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!toolsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!toolsRef.current?.contains(event.target as Node)) setToolsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [toolsOpen]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="conversation-prompt-template-trigger"
        aria-label={triggerLabel}
        title="编辑本会话要求约束"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-dialog` : undefined}
        disabled={!conversation || !scopeAvailable}
        onClick={() => {
          onOpen?.();
          setShowDefault(false);
          setToolsOpen(false);
          setOpen(true);
        }}
      >
        <SlidersHorizontal size={12} aria-hidden="true" />
        <span>约束</span>
      </button>
      {open
        ? createPortal(
            <div
              className="dialog-backdrop conversation-prompt-template-backdrop"
              style={{ zIndex: MODAL_Z_INDEX }}
              onClick={(event) => {
                if (event.target === event.currentTarget) setOpen(false);
              }}
            >
              <section
                ref={dialogRef}
                id={`${id}-dialog`}
                className="conversation-prompt-template-dialog"
                role="dialog"
                aria-modal="true"
                aria-labelledby={`${id}-title`}
              >
                <header>
                  <div>
                    <h2 id={`${id}-title`}>本会话要求约束</h2>
                    <small>{conversation?.title}</small>
                  </div>
                  <button
                    className="icon-button subtle"
                    type="button"
                    aria-label="关闭约束编辑器"
                    onClick={() => setOpen(false)}
                  >
                    <X size={18} />
                  </button>
                </header>
                <div className="conversation-prompt-template-body">
                  <div className="conversation-prompt-template-kind">
                    {onKindChange && (
                      <label>
                        模板用途
                        <select
                          aria-label="模板用途"
                          value={kind}
                          disabled={busy}
                          onChange={(event) => {
                            setShowDefault(false);
                            onKindChange(event.target.value as PromptTemplateKind);
                          }}
                        >
                          {PROMPT_TEMPLATE_KINDS.map((item) => (
                            <option key={item} value={item}>
                              {PROMPT_TEMPLATE_LABELS[item]}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <small>{scopeLabel}</small>
                  </div>
                  <div className="conversation-prompt-template-content-label">
                    <label htmlFor={`${id}-content`}>
                      {showDefault ? '当前用途默认模板' : PROMPT_TEMPLATE_LABELS[kind]}
                    </label>
                    {showDefault && (
                      <button
                        className="button subtle"
                        type="button"
                        onClick={() => setShowDefault(false)}
                      >
                        返回编辑
                      </button>
                    )}
                  </div>
                  <textarea
                    ref={textareaRef}
                    id={`${id}-content`}
                    aria-label={showDefault ? '当前用途默认模板' : '本会话要求约束'}
                    value={showDefault ? defaultValue : value}
                    onChange={(event) => {
                      importEpoch.current++;
                      onChange(event.target.value);
                    }}
                    placeholder={`填写${PROMPT_TEMPLATE_LABELS[kind]}的要求；留空表示不添加此类要求。`}
                    readOnly={showDefault || !editable}
                    rows={14}
                    disabled={busy}
                  />
                  <input
                    ref={fileRef}
                    type="file"
                    accept=".txt,.md,.markdown,text/plain,text/markdown"
                    aria-label="导入当前用途模板文件"
                    hidden
                    disabled={disabled}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (!file) return;
                      const epoch = ++importEpoch.current;
                      const previous = value;
                      void readPromptTemplateFile(file)
                        .then((text) => {
                          if (epoch !== importEpoch.current) return;
                          onChange(text);
                          setImported({ name: file.name, previous });
                          setImportError('');
                          setShowDefault(false);
                        })
                        .catch((error: unknown) => {
                          if (epoch === importEpoch.current)
                            setImportError(error instanceof Error ? error.message : '模板导入失败');
                        });
                    }}
                  />
                  {imported && (
                    <small>
                      已导入「{imported.name}」至{PROMPT_TEMPLATE_LABELS[kind]}，可在上方编辑。
                      <button
                        type="button"
                        disabled={disabled}
                        onClick={() => {
                          onChange(imported.previous);
                          setImported(undefined);
                        }}
                      >
                        撤回本次导入
                      </button>
                    </small>
                  )}
                  {importError && <small role="alert">{importError}</small>}
                  <small>
                    生成时仅使用对应类型的约束；可修改或清空，执行中的任务沿用发送时版本。
                  </small>
                  <div className="conversation-prompt-template-meta">
                    <small role="status">
                      {showDefault
                        ? '默认模板预览，当前编辑内容已保留'
                        : loading
                          ? '加载中…'
                          : busy
                            ? '保存中…'
                            : dirty
                              ? '有未保存修改，关闭后保留编辑内容'
                              : '已保存'}
                    </small>
                    <small>{(showDefault ? defaultValue : value).length} 字</small>
                  </div>
                  {error && <small role="alert">{error}</small>}
                </div>
                <footer>
                  <div className="conversation-prompt-template-tools">
                    <button
                      className="button subtle"
                      type="button"
                      disabled={disabled}
                      onClick={() => fileRef.current?.click()}
                      title="替换当前用途的草稿，导入后可预览、编辑或撤回"
                    >
                      导入 TXT / Markdown
                    </button>
                    <button
                      className="button subtle"
                      type="button"
                      onClick={() => {
                        importEpoch.current++;
                        onChange(defaultValue);
                        setShowDefault(false);
                      }}
                      disabled={disabled}
                      title="替换当前用途的编辑内容"
                    >
                      套用默认模板
                    </button>
                    <div className="conversation-prompt-template-more" ref={toolsRef}>
                      <button
                        className="button subtle"
                        type="button"
                        aria-expanded={toolsOpen}
                        aria-controls={toolsOpen ? `${id}-tools` : undefined}
                        onClick={() => setToolsOpen((current) => !current)}
                      >
                        更多 <ChevronDown size={13} aria-hidden="true" />
                      </button>
                      {toolsOpen && (
                        <div id={`${id}-tools`} className="conversation-prompt-template-menu">
                          <button
                            type="button"
                            onClick={() => {
                              setShowDefault(true);
                              setToolsOpen(false);
                            }}
                          >
                            查看默认模板
                          </button>
                          {onReload && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => {
                                importEpoch.current++;
                                onReload();
                                setShowDefault(false);
                                setToolsOpen(false);
                              }}
                            >
                              重新加载已保存内容
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={disabled}
                            onClick={() => {
                              importEpoch.current++;
                              onChange('');
                              setShowDefault(false);
                              setToolsOpen(false);
                            }}
                          >
                            清空当前用途
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="conversation-prompt-template-actions">
                    <button className="button" type="button" onClick={() => setOpen(false)}>
                      关闭
                    </button>
                    {onSave && (
                      <button
                        className="button primary"
                        type="button"
                        onClick={onSave}
                        disabled={disabled}
                      >
                        {loading ? '加载中…' : busy ? '保存中…' : '保存约束'}
                      </button>
                    )}
                  </div>
                </footer>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
