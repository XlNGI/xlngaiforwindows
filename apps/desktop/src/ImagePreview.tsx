import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

/** The same full image is fitted to the preview and the viewport, never cropped. */
export function ImagePreview({
  src,
  alt,
  className = '',
}: {
  src: string;
  alt: string;
  className?: string;
}) {
  return <ImagePreviewContent key={src} src={src} alt={alt} className={className} />;
}

function ImagePreviewContent({
  src,
  alt,
  className,
}: {
  src: string;
  alt: string;
  className: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!expanded) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
      } else if (event.key === 'Tab') {
        event.preventDefault();
        closeButton.current?.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [expanded]);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`image-preview-trigger ${className}`}
        aria-label={`放大查看${alt}`}
        title="点击放大查看"
        disabled={failed}
        onClick={(event) => {
          event.stopPropagation();
          setExpanded(true);
        }}
      >
        {failed ? (
          <span className="image-preview-error">图片暂时无法预览</span>
        ) : (
          <img src={src} alt={alt} draggable={false} onError={() => setFailed(true)} />
        )}
      </button>
      {expanded
        ? createPortal(
            <div
              className="image-preview-backdrop"
              onClick={(event) => {
                if (event.target === event.currentTarget) setExpanded(false);
              }}
            >
              <section
                className="image-preview-dialog"
                role="dialog"
                aria-modal="true"
                aria-label={`图片预览：${alt}`}
              >
                <header>
                  <strong>{alt}</strong>
                  <button
                    ref={closeButton}
                    type="button"
                    className="icon-button"
                    aria-label="关闭图片预览"
                    onClick={() => setExpanded(false)}
                  >
                    <X size={20} />
                  </button>
                </header>
                <div className="image-preview-stage">
                  <img src={src} alt={alt} draggable={false} />
                </div>
              </section>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
