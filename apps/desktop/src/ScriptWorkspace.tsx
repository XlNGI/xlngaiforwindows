import { RotateCcw } from 'lucide-react';
import { MarkdownEditor } from './MarkdownEditor';

export function ScriptWorkspace({
  content,
  writable,
  versions,
  currentVersionId,
  message,
  episodeChapterCount = 0,
  onContentChange,
  onRestoreVersion,
}: {
  content: string;
  writable: boolean;
  versions: Array<{ id: string; version: number; createdAt: string }>;
  currentVersionId?: string;
  message?: string;
  episodeChapterCount?: number;
  onContentChange: (value: string) => void;
  onRestoreVersion: (versionId: string) => void;
}) {
  return (
    <div className="script-workspace">
      <section className="script-document-panel">
        {episodeChapterCount > 0 ? (
          <p className="script-episode-hint">
            {`\u5df2\u6307\u5b9a ${episodeChapterCount} \u4e2a\u7ae0\u8282\u4f5c\u4e3a\u672c\u96c6\u8303\u56f4\u3002\u8fd9\u4efd\u6587\u6863\u53ea\u5199\u672c\u96c6\u628a\u63a7\uff0c\u4e0d\u8981\u628a\u955c\u5934\u63d0\u793a\u8bcd\u5199\u8fdb\u6765\u53d1\u7ed9\u751f\u4ea7 API\u3002`}
          </p>
        ) : null}
        <MarkdownEditor
          className="script-document-editor"
          label="文档内容"
          value={content}
          onChange={onContentChange}
          autoPreviewOnBlur
          placeholder={
            '\u4f7f\u7528 Markdown \u7f16\u5199\u5927\u7eb2\u3001\u8ba1\u5212\u6216\u672c\u96c6\u628a\u63a7\u2026'
          }
          readOnly={!writable}
        />
        {message ? <div className="inline-status">{message}</div> : null}
        {versions.length > 0 ? (
          <div className="version-strip">
            <span>{'\u5386\u53f2\u7248\u672c'}</span>
            {versions.map((version) => (
              <button
                type="button"
                key={version.id}
                title={new Date(version.createdAt).toLocaleString()}
                onClick={() => onRestoreVersion(version.id)}
                disabled={!writable || version.id === currentVersionId}
              >
                <RotateCcw size={12} />v{version.version}
              </button>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  );
}
