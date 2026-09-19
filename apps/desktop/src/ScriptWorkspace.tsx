import { RotateCcw } from 'lucide-react';
import type { DocumentKind } from '@ai-video/contracts';

const KIND_OPTIONS: Array<{ id: DocumentKind; label: string }> = [
  { id: 'outline', label: '\u5927\u7eb2' },
  { id: 'plan', label: '\u8ba1\u5212' },
  { id: 'note', label: '\u7b14\u8bb0' },
];

export function ScriptWorkspace({
  title,
  kind,
  content,
  stateLabel,
  stateKey,
  writable,
  versions,
  currentVersionId,
  message,
  episodeChapterCount = 0,
  onTitleChange,
  onKindChange,
  onContentChange,
  onRestoreVersion,
}: {
  title: string;
  kind: DocumentKind;
  content: string;
  stateLabel: string;
  stateKey: string;
  writable: boolean;
  versions: Array<{ id: string; version: number; createdAt: string }>;
  currentVersionId?: string;
  message?: string;
  episodeChapterCount?: number;
  onTitleChange: (value: string) => void;
  onKindChange: (value: DocumentKind) => void;
  onContentChange: (value: string) => void;
  onRestoreVersion: (versionId: string) => void;
}) {
  const options = KIND_OPTIONS.some((item) => item.id === kind)
    ? KIND_OPTIONS
    : [{ id: kind, label: kind }, ...KIND_OPTIONS];

  return (
    <div className="script-workspace">
      <section className="script-document-panel" aria-labelledby="script-document-heading">
        <div className="script-document-heading">
          <h2 id="script-document-heading">{'\u9879\u76ee\u6587\u6863'}</h2>
          <p>
            {
              '\u53ea\u7ed9\u4eba\u770b\uff1a\u5927\u7eb2\u3001\u8ba1\u5212\u3001\u672c\u96c6\u628a\u63a7\u548c\u7b14\u8bb0\u3002\u4e0d\u4f1a\u53d1\u7ed9\u751f\u56fe\u6216\u751f\u89c6\u9891\u3002\u955c\u5934\u63d0\u793a\u8bcd\u548c\u53c2\u8003\u56fe\u8bf7\u5230\u300c\u573a\u6b21\u4e0e\u955c\u5934\u300d\u3002'
            }
          </p>
        </div>
        {episodeChapterCount > 0 ? (
          <p className="script-episode-hint">
            {`\u5df2\u6307\u5b9a ${episodeChapterCount} \u4e2a\u7ae0\u8282\u4f5c\u4e3a\u672c\u96c6\u8303\u56f4\u3002\u8fd9\u4efd\u6587\u6863\u53ea\u5199\u672c\u96c6\u628a\u63a7\uff0c\u4e0d\u8981\u628a\u955c\u5934\u63d0\u793a\u8bcd\u5199\u8fdb\u6765\u53d1\u7ed9\u751f\u4ea7 API\u3002`}
          </p>
        ) : null}
        <div className="document-fields">
          <label className="title-field">
            {'\u6807\u9898'}
            <input
              value={title}
              onChange={(event) => onTitleChange(event.target.value)}
              placeholder={
                '\u8f93\u5165\u5927\u7eb2\u3001\u8ba1\u5212\u6216\u672c\u96c6\u628a\u63a7\u6807\u9898'
              }
              readOnly={!writable}
            />
          </label>
          <label className="kind-field">
            {'\u7c7b\u578b'}
            <select
              value={kind}
              onChange={(event) => onKindChange(event.target.value as DocumentKind)}
              disabled={!writable}
              aria-label={'\u6587\u6863\u7c7b\u578b'}
            >
              {options.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <span className={`document-state document-state-${stateKey}`}>{stateLabel}</span>
        </div>
        <textarea
          className="markdown-editor script-document-editor"
          aria-label={'\u6587\u6863\u5185\u5bb9'}
          value={content}
          onChange={(event) => onContentChange(event.target.value)}
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
