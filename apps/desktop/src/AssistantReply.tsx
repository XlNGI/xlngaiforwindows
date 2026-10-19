import { memo, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const STREAM_REFRESH_MS = 40;
const markdownPlugins = [remarkGfm];

/** Coalesce incoming snapshots without introducing a character-by-character backlog. */
export const AssistantReply = memo(function AssistantReply({
  content,
  streaming = false,
}: {
  content: string;
  streaming?: boolean;
}) {
  const latestContent = useRef(content);
  const [displayedContent, setDisplayedContent] = useState(content);

  useEffect(() => {
    latestContent.current = content;
  }, [content]);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => {
      setDisplayedContent(latestContent.current);
    }, STREAM_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [streaming]);

  // Completion, cancellation and historical messages show the full snapshot immediately.
  const visibleContent = streaming ? displayedContent : content;

  return (
    <div className="assistant-reply">
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
        {visibleContent}
      </ReactMarkdown>
    </div>
  );
});
