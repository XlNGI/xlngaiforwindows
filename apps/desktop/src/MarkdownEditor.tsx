import { Eye, Pencil } from 'lucide-react';
import { useEffect, useRef, useState, type FocusEvent, type MouseEvent } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { PromptReferenceEditor } from './PromptReferenceEditor';
import type { PromptReference } from './prompt-references';

const markdownPlugins = [remarkGfm];

export function MarkdownEditor({
  value,
  onChange,
  label,
  className,
  placeholder,
  readOnly = false,
  disabled = false,
  references,
  projectId,
  autoPreviewOnBlur = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  className?: string;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  references?: PromptReference[];
  projectId?: string;
  autoPreviewOnBlur?: boolean;
}) {
  const [mode, setMode] = useState<'edit' | 'preview'>(() =>
    autoPreviewOnBlur ? 'preview' : 'edit',
  );
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const pendingCursorPositionRef = useRef<number | null>(null);

  useEffect(() => {
    if (autoPreviewOnBlur && mode === 'edit') {
      const editor = textareaRef.current;
      if (editor) editor.focus();
      else document.getElementById(`markdown-${label}`)?.focus();
      const cursorPosition = pendingCursorPositionRef.current;
      if (editor && cursorPosition !== null) {
        editor.setSelectionRange(cursorPosition, cursorPosition);
        pendingCursorPositionRef.current = null;
      }
    }
  }, [autoPreviewOnBlur, mode]);

  const enterEditAtEnd = () => {
    pendingCursorPositionRef.current = value.length;
    setMode('edit');
  };

  const enterEditFromPreview = (event: MouseEvent<HTMLDivElement>) => {
    if (readOnly || disabled) return;
    if (event.target instanceof Element && event.target.closest('a')) return;

    const preview = event.currentTarget;
    const bounds = preview.getBoundingClientRect();
    const documentOffset = preview.scrollTop + event.clientY - bounds.top;
    const ratio = Math.min(1, Math.max(0, documentOffset / Math.max(1, preview.scrollHeight)));
    pendingCursorPositionRef.current = Math.round(value.length * ratio);
    setMode('edit');
  };

  const handleWorkspaceBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!autoPreviewOnBlur) return;
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))
      return;
    setMode('preview');
  };

  return (
    <div
      className={`markdown-editor-workspace${className ? ` ${className}` : ''}`}
      onBlur={autoPreviewOnBlur ? handleWorkspaceBlur : undefined}
    >
      {!autoPreviewOnBlur && (
        <div className="markdown-editor-mode" role="group" aria-label={`${label}视图`}>
          <button
            type="button"
            aria-pressed={mode === 'edit'}
            className={mode === 'edit' ? 'is-active' : ''}
            onClick={() => setMode('edit')}
          >
            <Pencil size={13} aria-hidden="true" /> 编辑
          </button>
          <button
            type="button"
            aria-pressed={mode === 'preview'}
            className={mode === 'preview' ? 'is-active' : ''}
            onClick={() => setMode('preview')}
          >
            <Eye size={13} aria-hidden="true" /> 预览
          </button>
        </div>
      )}
      {mode === 'edit' ? (
        references?.length ? (
          <PromptReferenceEditor
            id={`markdown-${label}`}
            label={label}
            value={value}
            references={references}
            projectId={projectId}
            onChange={onChange}
            placeholder={placeholder}
            readOnly={readOnly || disabled}
          />
        ) : (
          <textarea
            ref={textareaRef}
            className="markdown-editor"
            aria-label={label}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder={placeholder}
            readOnly={readOnly}
            disabled={disabled}
          />
        )
      ) : (
        <div
          className={`markdown-rendered-preview${
            autoPreviewOnBlur && !readOnly && !disabled ? ' is-click-to-edit' : ''
          }`}
          role="region"
          aria-label={`${label}预览`}
          tabIndex={autoPreviewOnBlur && !readOnly && !disabled ? 0 : undefined}
          onClick={autoPreviewOnBlur ? enterEditFromPreview : undefined}
          onKeyDown={(event) => {
            if (
              autoPreviewOnBlur &&
              !readOnly &&
              !disabled &&
              (event.key === 'Enter' || event.key === ' ')
            ) {
              event.preventDefault();
              enterEditAtEnd();
            }
          }}
        >
          {value.trim() ? (
            <ReactMarkdown
              remarkPlugins={markdownPlugins}
              skipHtml
              components={{
                a: ({ children, href }) => (
                  <a href={href} target="_blank" rel="noopener noreferrer">
                    {children}
                  </a>
                ),
              }}
            >
              {value}
            </ReactMarkdown>
          ) : (
            <p className="markdown-preview-empty">暂无内容</p>
          )}
        </div>
      )}
    </div>
  );
}
