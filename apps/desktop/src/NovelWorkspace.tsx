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
  FileUp,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import type {
  DocumentDetail,
  DocumentVersionState,
  NovelChapterInfo,
  NovelConsistencyReport,
  NovelVolumeInfo,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { readMarkdownDocument } from './markdown-import-client';
import { splitNovelSource, type NovelImportChapterDraft } from './novel-import';

interface NovelWorkspaceProps {
  projectId?: string;
  writable: boolean;
  onOpenDocument?: (documentId: string) => void;
}

function documentStateLabel(state: DocumentVersionState): string {
  switch (state) {
    case 'draft':
      return '草稿';
    case 'in_review':
      return '审核中';
    case 'changes_requested':
      return '需修改';
    case 'published':
      return '已发布';
    case 'rejected':
      return '已退回';
    default:
      return '未保存';
  }
}

function exportStatusLabel(status: string): string {
  switch (status) {
    case 'succeeded':
      return '导出完成';
    case 'failed':
      return '导出失败';
    case 'verifying':
      return '校验中';
    case 'writing':
      return '写入中';
    default:
      return status;
  }
}

function consistencyIssueLabel(code: NovelConsistencyReport['issues'][number]['code']): string {
  switch (code) {
    case 'missing-published-version':
      return '当前章节没有已发布版本。';
    case 'duplicate-position':
      return '有章节使用了重复的位置。';
    case 'duplicate-display-label':
      return '有章节使用了重复的显示标签。';
    case 'stale-summary':
      return '章节摘要与当前已发布版本不一致。';
  }
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
  const [importPreview, setImportPreview] = useState<NovelImportChapterDraft[]>([]);
  const [importVolumeTitle, setImportVolumeTitle] = useState('');
  const [importBusy, setImportBusy] = useState(false);

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
      setMessage('草稿已保存。');
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
          ? `${error.message} 已载入服务器版本，请选择下一步操作。`
          : '草稿存在冲突，已载入服务器版本，请选择下一步操作。',
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
    setMessage('已载入服务器版本。');
  };

  const keepConflictEdits = () => {
    setConflictDocument(undefined);
    setMessage('已保留本地修改，请检查后重试保存。');
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
      setMessage('草稿已提交审核。');
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
      setMessage('章节已发布。');
      setConflictDocument(undefined);
    } finally {
      setBusy(false);
    }
  };

  const publishChapterBatch = async (rows: NovelChapterInfo[]) => {
    let publishedCount = 0;
    try {
      for (const chapter of rows) {
        const detail = await callWorker('document.get', { documentId: chapter.documentId });
        const version = detail.currentVersion;
        if (!version || version.state === 'published') continue;
        const result = await callWorker('document.selfPublish', {
          documentId: detail.id,
          documentVersionId: version.id,
          expectedDocumentRowVersion: detail.rowVersion,
          expectedPublishedVersionId: detail.publishedVersionId,
        });
        publishedCount += 1;
        if (selected?.id === chapter.id) setDocument(result.document);
      }
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '发布失败';
      throw new Error(`已发布 ${publishedCount} 个章节后失败：${message}`);
    }
    return publishedCount;
  };

  const publishAll = async () => {
    if (!writable || busy || chapters.length === 0) return;
    setBusy(true);
    try {
      const publishedCount = await publishChapterBatch(chapters);
      setMessage(`已批量发布 ${publishedCount} 个章节。`);
      await loadChapters(selected?.id);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '批量发布失败');
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
        setMessage('章节已恢复。');
      } else {
        await callWorker('novel.chapter.archive', {
          chapterId: selected.id,
          expectedRowVersion: selected.rowVersion,
          reason: 'user_archive',
        });
        setMessage('章节已归档。');
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
      setMessage(`${exportStatusLabel(job.status)}：${job.packagePath}`);
    } finally {
      setExportBusy(false);
    }
  };

  const prepareImport = async () => {
    const selected = await openDialog({
      directory: false,
      multiple: true,
      title: '导入小说 Markdown',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === 'string'
        ? [selected]
        : [];
    if (paths.length === 0) return;
    setImportBusy(true);
    try {
      const sources = await Promise.all(paths.map((path) => readMarkdownDocument(path)));
      const chapters = sources.flatMap(splitNovelSource).map((chapter, index) => ({
        ...chapter,
        displayLabel: `第 ${index + 1} 章`,
      }));
      if (chapters.length === 0) throw new Error('没有识别到可导入的章节内容');
      setImportPreview(chapters);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '小说导入预览失败');
    } finally {
      setImportBusy(false);
    }
  };

  const importNovel = async (publishImmediately = false) => {
    if (importPreview.length === 0 || importBusy) return;
    setImportBusy(true);
    try {
      const result = await callWorker('novel.import', {
        volumeTitle: importVolumeTitle.trim() || undefined,
        chapters: importPreview,
      });
      setImportPreview([]);
      setImportVolumeTitle('');
      if (publishImmediately) {
        const publishedCount = await publishChapterBatch(result.chapters);
        setMessage(`已导入并发布 ${publishedCount} 个章节。`);
      } else {
        setMessage(`已导入 ${result.importedCount} 个章节，当前为草稿。`);
      }
      await loadChapters(result.chapters[0]?.id);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '小说导入失败');
    } finally {
      setImportBusy(false);
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
          <strong>小说工作区</strong>
        </div>
        <label className="novel-archive-toggle">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(event) => setIncludeArchived(event.target.checked)}
          />{' '}
          显示已归档
        </label>
        <button
          className="icon-button subtle"
          type="button"
          title="刷新章节"
          disabled={busy}
          onClick={() => void loadChapters(selected?.id)}
        >
          <RefreshCw size={14} />
        </button>
        <button
          className="icon-button subtle"
          type="button"
          title="检查小说连续性"
          aria-label="检查小说连续性"
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
          <BookOpen size={13} /> 导出 Markdown
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={importBusy || !projectId}
          onClick={() => void prepareImport()}
        >
          <FileUp size={13} /> 导入小说
        </button>
        <button
          className="button secondary"
          type="button"
          disabled={busy || !writable || chapters.length === 0}
          onClick={() => void publishAll()}
        >
          <Upload size={13} /> 全部发布
        </button>
        {message && <span className="inline-status">{message}</span>}
      </header>
      {importPreview.length > 0 && (
        <section className="novel-import-preview" aria-label="小说导入预览">
          <div className="novel-import-preview-heading">
            <strong>导入预览（{importPreview.length} 章）</strong>
            <div className="novel-import-actions">
              <input
                aria-label="导入卷名"
                placeholder="可选卷名"
                value={importVolumeTitle}
                onChange={(event) => setImportVolumeTitle(event.target.value)}
              />
              <button type="button" disabled={importBusy} onClick={() => void importNovel(true)}>
                导入并发布
              </button>
              <button type="button" disabled={importBusy} onClick={() => void importNovel()}>
                仅导入草稿
              </button>
              <button type="button" disabled={importBusy} onClick={() => setImportPreview([])}>
                取消
              </button>
            </div>
          </div>
          <ol>
            {importPreview.map((chapter, index) => (
              <li key={`${chapter.title}-${index}`}>
                <strong>{chapter.title}</strong>
                <span>{chapter.contentMarkdown.length.toLocaleString()} 字符</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      {consistency && (
        <section className="novel-consistency" aria-label="小说连续性报告" aria-live="polite">
          <span>
            {consistency.chapterCount} 个章节 · {consistency.currentSummaryCount} 个最新摘要
            {consistency.staleSummaryCount > 0
              ? ` · ${consistency.staleSummaryCount} 个过期摘要`
              : ''}
          </span>
          {consistency.issues.length === 0 ? (
            <span className="novel-consistency-ok">
              <CheckCircle2 size={13} /> 未发现连续性问题
            </span>
          ) : (
            consistency.issues.map((issue, index) => (
              <span className="novel-consistency-issue" key={`${issue.code}-${index}`}>
                <AlertTriangle size={13} /> {consistencyIssueLabel(issue.code)}
              </span>
            ))
          )}
        </section>
      )}
      {!projectId ? (
        <div className="novel-empty">请先打开项目以查看章节。</div>
      ) : (
        <div className="novel-layout">
          <aside className="novel-chapter-tree" aria-label="小说章节">
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
            {chapters.length === 0 && <small className="tree-empty">暂无活动章节。</small>}
          </aside>
          <section className="novel-editor">
            {selected && document ? (
              <>
                <div className="novel-editor-heading">
                  <input
                    aria-label="章节标题"
                    value={title}
                    disabled={!writable || busy}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <span className="document-state">
                    {document.currentVersion
                      ? documentStateLabel(document.currentVersion.state)
                      : '未保存'}
                  </span>
                  {onOpenDocument && (
                    <button
                      className="icon-button subtle"
                      type="button"
                      title="在文档工作区打开"
                      aria-label="在文档工作区打开"
                      onClick={() => onOpenDocument(document.id)}
                    >
                      <ExternalLink size={14} />
                    </button>
                  )}
                </div>
                {conflictDocument && (
                  <div className="novel-conflict" role="alert">
                    <strong>另一个窗口修改了本章节。</strong>
                    <span>编辑器中仍保留本地修改。下一次保存将基于最新文档版本进行。</span>
                    <div className="novel-editor-actions">
                      <button type="button" onClick={acceptConflictVersion}>
                        使用服务器版本
                      </button>
                      <button type="button" onClick={keepConflictEdits}>
                        保留本地修改
                      </button>
                    </div>
                  </div>
                )}
                <textarea
                  aria-label="章节内容"
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
                    <Save size={13} /> 保存草稿
                  </button>
                  <button
                    type="button"
                    disabled={!writable || busy || !document.currentVersion}
                    onClick={() => void submitReview()}
                  >
                    <Send size={13} /> 提交审核
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
                    <Upload size={13} /> 发布
                  </button>
                  <button
                    type="button"
                    disabled={!writable || busy}
                    onClick={() => void toggleArchive()}
                  >
                    {selected.lifecycleStatus === 'archived' ? '恢复章节' : '归档章节'}
                  </button>
                </div>
              </>
            ) : (
              <div className="novel-empty">请选择章节。</div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
