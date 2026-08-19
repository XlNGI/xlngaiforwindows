import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  FileText,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type {
  DocumentDetail,
  NovelChapterInfo,
  NovelConsistencyReport,
  NovelVolumeInfo,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';

interface NovelWorkspaceProps {
  projectId?: string;
  writable: boolean;
  onOpenDocument?: (documentId: string) => void;
}

export function NovelWorkspace({ projectId, writable, onOpenDocument }: NovelWorkspaceProps) {
  const [chapters, setChapters] = useState<NovelChapterInfo[]>([]);
  const [volumes, setVolumes] = useState<NovelVolumeInfo[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selected, setSelected] = useState<NovelChapterInfo>();
  const [document, setDocument] = useState<DocumentDetail>();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflictDocument, setConflictDocument] = useState<DocumentDetail>();
  const [exportBusy, setExportBusy] = useState(false);
  const [consistency, setConsistency] = useState<NovelConsistencyReport>();

  const loadChapters = async (preferredId?: string) => {
    if (!projectId) return;
    const [rows, volumeRows] = await Promise.all([
      callWorker('novel.chapter.list', { includeArchived }),
      callWorker('novel.volume.list', { includeArchived }),
    ]);
    setChapters(rows);
    setVolumes(volumeRows);
    const next = rows.find((row) => row.id === preferredId) ?? rows[0];
    if (next && next.id !== selected?.id) await openChapter(next);
    if (!next) {
      setSelected(undefined);
      setDocument(undefined);
      setTitle('');
      setContent('');
    }
  };

  useEffect(() => {
    void loadChapters();
  }, [projectId, includeArchived]);

  const openChapter = async (chapter: NovelChapterInfo) => {
    setBusy(true);
    try {
      const detail = await callWorker('document.get', { documentId: chapter.documentId });
      setSelected(chapter);
      setDocument(detail);
      setTitle(detail.title);
      setContent(detail.currentVersion?.contentMarkdown ?? '');
      setMessage('');
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if (!selected || !document || !writable) return;
    setBusy(true);
    try {
      const next = await callWorker('document.draft.save', {
        documentId: document.id,
        title: title.trim() || selected.title,
        contentMarkdown: content,
        expectedDocumentRowVersion: document.rowVersion,
        authorType: 'user',
      });
      setDocument(next);
      setChapters((rows) =>
        rows.map((row) =>
          row.id === selected.id
            ? { ...row, title: next.title, documentRowVersion: next.rowVersion }
            : row,
        ),
      );
      setSelected((row) =>
        row ? { ...row, title: next.title, documentRowVersion: next.rowVersion } : row,
      );
      setMessage('Draft saved.');
      setConflictDocument(undefined);
    } catch (error) {
      const latest = await callWorker('document.get', { documentId: document.id }).catch(
        () => undefined,
      );
      if (latest) {
        setDocument(latest);
        setSelected((row) => (row ? { ...row, documentRowVersion: latest.rowVersion } : row));
        setConflictDocument(latest);
      }
      setMessage(
        error instanceof Error
          ? `${error.message} Server version loaded; choose how to continue.`
          : 'Draft conflict. Server version loaded; choose how to continue.',
      );
    } finally {
      setBusy(false);
    }
  };

  const acceptConflictVersion = () => {
    if (!conflictDocument) return;
    setTitle(conflictDocument.title);
    setContent(conflictDocument.currentVersion?.contentMarkdown ?? '');
    setConflictDocument(undefined);
    setMessage('Server version loaded.');
  };

  const keepConflictEdits = () => {
    setConflictDocument(undefined);
    setMessage('Local edits kept. Review and retry save.');
  };

  const submitReview = async () => {
    if (!document || !document.currentVersion || !writable) return;
    setBusy(true);
    try {
      await callWorker('document.review.submit', {
        documentId: document.id,
        documentVersionId: document.currentVersion.id,
        expectedDocumentRowVersion: document.rowVersion,
      });
      const refreshed = await callWorker('document.get', { documentId: document.id });
      setDocument(refreshed);
      setMessage('Draft submitted for review.');
    } finally {
      setBusy(false);
    }
  };

  const selfPublish = async () => {
    if (!document?.currentVersion || !writable) return;
    setBusy(true);
    try {
      const result = await callWorker('document.selfPublish', {
        documentId: document.id,
        documentVersionId: document.currentVersion.id,
        expectedDocumentRowVersion: document.rowVersion,
        expectedPublishedVersionId: document.publishedVersionId,
      });
      setDocument(result.document);
      setMessage('Chapter published.');
      setConflictDocument(undefined);
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (!selected || busy || !writable) return;
    setBusy(true);
    try {
      if (selected.lifecycleStatus === 'archived') {
        await callWorker('novel.chapter.restore', {
          chapterId: selected.id,
          expectedRowVersion: selected.rowVersion,
        });
        setMessage('Chapter restored.');
      } else {
        await callWorker('novel.chapter.archive', {
          chapterId: selected.id,
          expectedRowVersion: selected.rowVersion,
          reason: 'user_archive',
        });
        setMessage('Chapter archived.');
      }
      await loadChapters(selected.id);
    } finally {
      setBusy(false);
    }
  };

  const exportWork = async () => {
    if (!projectId || exportBusy) return;
    setExportBusy(true);
    try {
      const job = await callWorker('novel.export.prepare', {
        exportType: 'work',
        exportFormat: 'files',
      });
      setMessage(`Export ${job.status}: ${job.packagePath}`);
    } finally {
      setExportBusy(false);
    }
  };

  const checkConsistency = async () => {
    setBusy(true);
    try {
      setConsistency(await callWorker('novel.context.consistencyReport', {}));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="novel-workspace">
      <header className="novel-toolbar">
        <div className="novel-toolbar-title">
          <BookOpen size={16} />
          <strong>Novel workspace</strong>
        </div>
        <label className="novel-archive-toggle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />{' '}
          Show archived
        </label>
        <button
          className="icon-button subtle"
          type="button"
          title="Refresh chapters"
          disabled={busy}
          onClick={() => void loadChapters(selected?.id)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-button subtle"
          type="button"
          title="Check novel continuity"
          aria-label="Check novel continuity"
          disabled={busy || !projectId}
          onClick={() => void checkConsistency()}
        >
          <ShieldCheck size={14} />
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={exportBusy || chapters.length === 0}
          onClick={() => void exportWork()}
        >
          <BookOpen size={13} /> Export Markdown
        </button>
        {message && <span className="inline-status">{message}</span>}
      </header>
      {consistency && (
        <section
          className="novel-consistency"
          aria-label="Novel continuity report"
          aria-live="polite"
        >
          <span>
            {consistency.chapterCount} chapters · {consistency.currentSummaryCount} current
            summaries
            {consistency.staleSummaryCount > 0 ? ` · ${consistency.staleSummaryCount} stale` : ''}
          </span>
          {consistency.issues.length === 0 ? (
            <span className="novel-consistency-ok">
              <CheckCircle2 size={13} /> No continuity issues
            </span>
          ) : (
            consistency.issues.map((issue, index) => (
              <span className="novel-consistency-issue" key={`${issue.code}-${index}`}>
                <AlertTriangle size={13} /> {issue.message}
              </span>
            ))
          )}
        </section>
      )}
      {!projectId ? (
        <div className="novel-empty">Open a project to view chapters.</div>
      ) : (
        <div className="novel-layout">
          <aside className="novel-chapter-tree" aria-label="Novel chapters">
            {volumes.map((volume) => (
              <div key={volume.id} className="novel-volume-group">
                <strong>{volume.title}</strong>
                {chapters
                  .filter((chapter) => chapter.volumeId === volume.id)
                  .map((chapter) => (
                    <button
                      className={`tree-item ${selected?.id === chapter.id ? 'selected' : ''}`}
                      type="button"
                      key={chapter.id}
                      onClick={() => void openChapter(chapter)}
                    >
                      <FileText size={13} />
                      <span>
                        {chapter.displayLabel} {chapter.title}
                      </span>
                    </button>
                  ))}
              </div>
            ))}
            {chapters
              .filter((chapter) => !chapter.volumeId)
              .map((chapter) => (
                <button
                  className={`tree-item ${selected?.id === chapter.id ? 'selected' : ''}`}
                  type="button"
                  key={chapter.id}
                  onClick={() => void openChapter(chapter)}
                >
                  <FileText size={13} />
                  <span>
                    {chapter.displayLabel} {chapter.title}
                  </span>
                </button>
              ))}
            {chapters.length === 0 && <small className="tree-empty">No active chapters.</small>}
          </aside>
          <section className="novel-editor">
            {selected && document ? (
              <>
                <div className="novel-editor-heading">
                  <input
                    aria-label="Chapter title"
                    value={title}
                    disabled={!writable || busy}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <span className="document-state">{document.currentVersion?.state ?? 'new'}</span>
                  {onOpenDocument && (
                    <button
                      className="icon-button subtle"
                      type="button"
                      title="Open in document workspace"
                      aria-label="Open in document workspace"
                      onClick={() => onOpenDocument(document.id)}
                    >
                      <ExternalLink size={14} />
                    </button>
                  )}
                </div>
                {conflictDocument && (
                  <div className="novel-conflict" role="alert">
                    <strong>Another window changed this chapter.</strong>
                    <span>
                      Local edits are still in the editor. The next save uses the latest document
                      version.
                    </span>
                    <div className="novel-editor-actions">
                      <button type="button" onClick={acceptConflictVersion}>
                        Use server version
                      </button>
                      <button type="button" onClick={keepConflictEdits}>
                        Keep local edits
                      </button>
                    </div>
                  </div>
                )}
                <textarea
                  aria-label="Chapter content"
                  className="markdown-editor novel-markdown-editor"
                  value={content}
                  disabled={!writable || busy}
                  onChange={(event) => setContent(event.target.value)}
                />
                <div className="novel-editor-actions">
                  <button
                    type="button"
                    disabled={!writable || busy}
                    onClick={() => void saveDraft()}
                  >
                    <Save size={13} /> Save draft
                  </button>
                  <button
                    type="button"
                    disabled={!writable || busy || !document.currentVersion}
                    onClick={() => void submitReview()}
                  >
                    <Send size={13} /> Submit review
                  </button>
                  <button
                    type="button"
                    disabled={
                      !writable ||
                      busy ||
                      !document.currentVersion ||
                      document.currentVersion.state === 'published'
                    }
                    onClick={() => void selfPublish()}
                  >
                    <Upload size={13} /> Publish
                  </button>
                  <button
                    type="button"
                    disabled={!writable || busy}
                    onClick={() => void toggleArchive()}
                  >
                    {selected.lifecycleStatus === 'archived'
                      ? 'Restore chapter'
                      : 'Archive chapter'}
                  </button>
                </div>
              </>
            ) : (
              <div className="novel-empty">Select a chapter.</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
