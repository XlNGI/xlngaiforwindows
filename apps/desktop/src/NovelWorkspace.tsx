import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  FileText,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  FileUp,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import type {
  DocumentDetail,
  DocumentSummary,
  DocumentVersionState,
  NovelChapterInfo,
  NovelConsistencyReport,
  NovelMarkdownExportFormat,
  NovelMarkdownExportJobInfo,
  NovelVolumeInfo,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { observeFileTask, observeMarkdownExport } from './file-task-client';
import { readNovelDocument } from './novel-import-client';
import { parseNovelSource, type NovelImportChapterDraft } from './novel-import';

interface NovelWorkspaceProps {
  projectId?: string;
  writable: boolean;
  /** Select and re-read the chapter produced by an Agent task. */
  focusChapterId?: string;
  focusReferenceId?: string;
  referenceDocuments?: DocumentSummary[];
  onReferencesChanged?: () => Promise<void>;
  /** Monotonic token used to force a fresh chapter/document read. */
  refreshToken?: number;
  onOpenDocument?: (documentId: string) => void;
  onChapterSelected?: (chapter: NovelChapterInfo) => void;
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
    case 'missing-rag-index':
      return '当前草稿还没有 RAG 切片。';
    case 'stale-rag-index':
      return '草稿切片与最新保存版本不一致。';
    case 'duplicate-position':
      return '有章节使用了重复的位置。';
    case 'duplicate-display-label':
      return '有章节使用了重复的显示标签。';
    case 'stale-summary':
      return '章节摘要与当前已发布版本不一致。';
  }
}

export function NovelWorkspace(props: NovelWorkspaceProps) {
  return <NovelProjectWorkspace key={props.projectId ?? 'no-project'} {...props} />;
}

function NovelProjectWorkspace({
  projectId,
  writable,
  focusChapterId,
  focusReferenceId,
  referenceDocuments = [],
  onReferencesChanged,
  refreshToken,
  onOpenDocument,
  onChapterSelected,
}: NovelWorkspaceProps) {
  const callWorker = projectWorker();
  const [chapters, setChapters] = useState<NovelChapterInfo[]>([]);
  const [volumes, setVolumes] = useState<NovelVolumeInfo[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selected, setSelected] = useState<NovelChapterInfo>();
  const [selectedReferenceId, setSelectedReferenceId] = useState<string>();
  const [document, setDocument] = useState<DocumentDetail>();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflictDocument, setConflictDocument] = useState<DocumentDetail>();
  const [exportBusy, setExportBusy] = useState(false);
  const [exportTaskId, setExportTaskId] = useState<string>();
  const [importTaskId, setImportTaskId] = useState<string>();
  const [exportOpen, setExportOpen] = useState(false);
  const [exportChapterIds, setExportChapterIds] = useState<string[]>([]);
  const [exportScope, setExportScope] = useState<'work' | 'selection'>('work');
  const [exportFormat, setExportFormat] = useState<NovelMarkdownExportFormat>('files');
  const [exportIncludeDraft, setExportIncludeDraft] = useState(false);
  const [exportMessage, setExportMessage] = useState('');
  const [exportError, setExportError] = useState(false);
  const [exportResult, setExportResult] = useState<NovelMarkdownExportJobInfo>();
  const [revealBusy, setRevealBusy] = useState(false);
  const [consistency, setConsistency] = useState<NovelConsistencyReport>();
  const [importPreview, setImportPreview] = useState<NovelImportChapterDraft[]>([]);
  const [importVolumeTitle, setImportVolumeTitle] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');

  const normalizedSearch = searchKeyword.trim().toLocaleLowerCase('zh-CN');
  const filteredChapters = normalizedSearch
    ? chapters.filter((chapter) =>
        `${chapter.displayLabel} ${chapter.title}`
          .toLocaleLowerCase('zh-CN')
          .includes(normalizedSearch),
      )
    : chapters;
  const activeChapters = chapters.filter((chapter) => chapter.lifecycleStatus === 'active');
  const visibleActiveChapters = filteredChapters.filter(
    (chapter) => chapter.lifecycleStatus === 'active',
  );
  const checkedChapterIds = new Set(exportChapterIds);
  const selectedExportIds = activeChapters
    .filter((chapter) => checkedChapterIds.has(chapter.id))
    .map((chapter) => chapter.id);
  const selectedExportIdSet = new Set(selectedExportIds);
  const exportCount = exportScope === 'work' ? activeChapters.length : selectedExportIds.length;

  const selectVisibleChapters = () => {
    setExportScope('selection');
    setExportChapterIds((ids) => [
      ...new Set([...ids, ...visibleActiveChapters.map((chapter) => chapter.id)]),
    ]);
  };

  const renderChapterItem = (chapter: NovelChapterInfo) => (
    <div className="novel-chapter-row" key={chapter.id}>
      <input
        type="checkbox"
        aria-label={`选择 ${chapter.displayLabel} ${chapter.title}`}
        checked={selectedExportIdSet.has(chapter.id)}
        disabled={exportBusy || chapter.lifecycleStatus !== 'active'}
        onChange={(event) => {
          const checked = event.target.checked;
          setExportScope('selection');
          setExportChapterIds((ids) =>
            checked ? [...new Set([...ids, chapter.id])] : ids.filter((id) => id !== chapter.id),
          );
        }}
      />
      <button
        className={`tree-item ${selected?.id === chapter.id ? 'selected' : ''}`}
        type="button"
        onClick={() => void openChapter(chapter)}
      >
        <FileText size={13} />
        <span>
          {chapter.displayLabel} {chapter.title}
        </span>
        <small className={chapter.ragChunkCount > 0 ? 'rag-ready' : 'rag-pending'}>
          {chapter.ragChunkCount > 0 ? `${chapter.ragChunkCount} 切片` : '未切片'}
        </small>
      </button>
    </div>
  );

  const loadChapters = async (preferredId?: string, forceOpen = false) => {
    if (!projectId) return;
    const [rows, volumeRows] = await Promise.all([
      callWorker('novel.chapter.list', { includeArchived }),
      callWorker('novel.volume.list', { includeArchived }),
    ]);
    setChapters(rows);
    const activeIds = new Set(
      rows.filter((row) => row.lifecycleStatus === 'active').map((row) => row.id),
    );
    setExportChapterIds((ids) => ids.filter((id) => activeIds.has(id)));
    setVolumes(volumeRows);
    if (focusReferenceId && !preferredId) {
      await openReference(focusReferenceId);
      return;
    }
    const next = rows.find((row) => row.id === preferredId) ?? rows[0];
    if (next && (forceOpen || next.id !== selected?.id)) await openChapter(next);
    else if (next) setSelected(next);
    if (!next) {
      setSelected(undefined);
      setDocument(undefined);
      setTitle('');
      setContent('');
    }
  };

  useEffect(() => {
    void loadChapters(focusChapterId, Boolean(focusChapterId || refreshToken !== undefined));
  }, [projectId, includeArchived, focusChapterId, focusReferenceId, refreshToken]);

  const openReference = async (documentId: string) => {
    setBusy(true);
    try {
      const detail = await callWorker('document.get', { documentId });
      if (detail.domainScope !== 'novel') throw new Error('该文档不属于小说资料。');
      setSelected(undefined);
      setSelectedReferenceId(documentId);
      setDocument(detail);
      setTitle(detail.title);
      setContent(detail.currentVersion?.contentMarkdown ?? '');
      setConflictDocument(undefined);
      setMessage('');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '小说资料加载失败');
    } finally {
      setBusy(false);
    }
  };

  const openChapter = async (chapter: NovelChapterInfo) => {
    setBusy(true);
    try {
      const detail = await callWorker('document.get', { documentId: chapter.documentId });
      setSelected(chapter);
      onChapterSelected?.(chapter);
      setSelectedReferenceId(undefined);
      setDocument(detail);
      setTitle(detail.title);
      setContent(detail.currentVersion?.contentMarkdown ?? '');
      setMessage('');
      setConflictDocument(undefined);
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = async () => {
    if ((!selected && !selectedReferenceId) || !document || !writable) return;
    setBusy(true);
    try {
      const next = await callWorker('document.draft.save', {
        documentId: document.id,
        title: title.trim() || document.title,
        contentMarkdown: content,
        expectedDocumentRowVersion: document.rowVersion,
        authorType: 'user',
      });
      setDocument(next);
      setChapters((rows) =>
        rows.map((row) =>
          row.id === selected?.id
            ? { ...row, title: next.title, documentRowVersion: next.rowVersion }
            : row,
        ),
      );
      setSelected((row) =>
        row ? { ...row, title: next.title, documentRowVersion: next.rowVersion } : row,
      );
      if (selected) await loadChapters(selected.id);
      if (onReferencesChanged) await onReferencesChanged();
      setMessage('草稿已保存，并已完成 RAG 切片。');
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

  const createDraft = async () => {
    if (!writable || busy) return;
    setBusy(true);
    try {
      const created = await callWorker('novel.chapter.save', { title: '未命名草稿' });
      await loadChapters(created.id);
      setMessage('已新建小说草稿，请编辑后点击“保存并切片”。');
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '新建草稿失败');
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (!selected || busy || !writable) return;
    if (
      selected.lifecycleStatus !== 'archived' &&
      !window.confirm(
        `确定删除“${selected.displayLabel} ${selected.title}”吗？可从“显示已删除”中恢复。`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      if (selected.lifecycleStatus === 'archived') {
        await callWorker('novel.chapter.restore', {
          chapterId: selected.id,
          expectedRowVersion: selected.rowVersion,
        });
        setMessage('草稿已恢复。');
      } else {
        await callWorker('novel.chapter.archive', {
          chapterId: selected.id,
          expectedRowVersion: selected.rowVersion,
          reason: 'user_archive',
        });
        setMessage('草稿已删除，可从“显示已删除”中恢复。');
      }
      await loadChapters(selected.id);
    } finally {
      setBusy(false);
    }
  };

  const exportWork = async () => {
    if (!projectId || !writable || exportBusy || revealBusy || exportCount === 0) return;
    setExportBusy(true);
    setExportError(false);
    setExportResult(undefined);
    setExportMessage('正在导出…');
    try {
      const accepted = await callWorker('novel.export.start', {
        exportType: exportScope,
        exportFormat,
        ...(exportScope === 'selection' ? { chapterIds: selectedExportIds } : {}),
        ...(exportIncludeDraft ? { includeDraft: true } : {}),
      });
      setExportTaskId(accepted.id);
      const job = await observeMarkdownExport(accepted, callWorker);
      if (job.status !== 'succeeded') {
        throw new Error(
          job.errorMessage || `导出未完成（${exportStatusLabel(job.status)}），请重试。`,
        );
      }
      setExportResult(job);
      const omitted = exportCount - job.itemCount;
      setExportMessage(
        `导出完成，共 ${job.itemCount} 章。${omitted > 0 ? `另有 ${omitted} 章没有${exportIncludeDraft ? '已保存正文' : '已发布版本'}，未导出。` : ''}`,
      );
    } catch (error) {
      setExportError(true);
      setExportMessage(`导出失败：${error instanceof Error ? error.message : '请重试。'}`);
    } finally {
      setExportBusy(false);
      setExportTaskId(undefined);
    }
  };

  const revealExport = async () => {
    if (!exportResult || revealBusy) return;
    setRevealBusy(true);
    try {
      await callWorker('novel.export.reveal', { jobId: exportResult.id });
    } catch (error) {
      setExportError(true);
      setExportMessage(`打开文件夹失败：${error instanceof Error ? error.message : '请重试。'}`);
    } finally {
      setRevealBusy(false);
    }
  };

  const prepareImport = async () => {
    const selected = await openDialog({
      directory: false,
      multiple: true,
      title: '导入小说（Markdown / TXT / EPUB）',
      filters: [
        { name: '小说文件', extensions: ['md', 'markdown', 'txt', 'epub'] },
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: '纯文本', extensions: ['txt'] },
        { name: 'EPUB', extensions: ['epub'] },
      ],
    });
    const paths = Array.isArray(selected)
      ? selected
      : typeof selected === 'string'
        ? [selected]
        : [];
    if (paths.length === 0) return;
    setImportBusy(true);
    try {
      const sources = await Promise.all(paths.map((path) => readNovelDocument(path)));
      const chapters = sources.flatMap(parseNovelSource).map((chapter, index) => ({
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

  const importNovel = async () => {
    if (importPreview.length === 0 || importBusy) return;
    setImportBusy(true);
    try {
      const accepted = await callWorker('file.task.create', {
        kind: 'novel-import',
        idempotencyKey: crypto.randomUUID(),
        input: {
          volumeTitle: importVolumeTitle.trim() || undefined,
          chapters: importPreview,
        },
      });
      setImportTaskId(accepted.id);
      const completed = await observeFileTask(accepted, callWorker, (job) =>
        setMessage(`小说导入 · ${job.progress}%`),
      );
      const result = completed.result as import('@ai-video/contracts').NovelImportResult;
      setImportPreview([]);
      setImportVolumeTitle('');
      const chunkCount = result.chapters.reduce(
        (total, chapter) => total + chapter.ragChunkCount,
        0,
      );
      setMessage(`已保存 ${result.importedCount} 个草稿，并生成 ${chunkCount} 个 RAG 切片。`);
      await loadChapters(result.chapters[0]?.id);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '小说导入失败');
    } finally {
      setImportBusy(false);
      setImportTaskId(undefined);
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
          显示已删除
        </label>
        <button
          className="icon-button subtle"
          type="button"
          title="刷新章节"
          disabled={busy}
          onClick={() => void loadChapters(selected?.id, true)}
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
          disabled={exportBusy || !projectId || !writable || activeChapters.length === 0}
          aria-expanded={exportOpen}
          onClick={() => {
            setExportScope(selectedExportIds.length > 0 ? 'selection' : 'work');
            setExportOpen(true);
          }}
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
          disabled={busy || !writable || !projectId}
          onClick={() => void createDraft()}
        >
          <Plus size={13} /> 新建草稿
        </button>
        {message && <span className="inline-status">{message}</span>}
      </header>
      {exportOpen && (
        <section className="novel-export-panel" aria-label="小说导出选项">
          <div className="novel-export-heading">
            <strong>导出 Markdown</strong>
            <button
              className="button secondary"
              type="button"
              disabled={exportBusy}
              onClick={() => setExportOpen(false)}
            >
              收起
            </button>
          </div>
          <fieldset className="novel-export-options" disabled={exportBusy}>
            <label>
              导出范围
              <select
                value={exportScope}
                onChange={(event) => setExportScope(event.target.value as 'work' | 'selection')}
              >
                <option value="work">整部小说（{activeChapters.length} 章）</option>
                <option value="selection">所选章节（{selectedExportIds.length} 章）</option>
              </select>
            </label>
            <label>
              文件组织
              <select
                value={exportFormat}
                onChange={(event) =>
                  setExportFormat(event.target.value as NovelMarkdownExportFormat)
                }
              >
                <option value="files">每章一个 Markdown 文件</option>
                <option value="merged">合并为一个 Markdown 文件</option>
              </select>
            </label>
            <label className="novel-export-draft-toggle">
              <input
                type="checkbox"
                checked={exportIncludeDraft}
                onChange={(event) => setExportIncludeDraft(event.target.checked)}
              />
              包含草稿
            </label>
            <button
              className="button primary"
              type="button"
              disabled={!writable || revealBusy || exportCount === 0}
              onClick={() => void exportWork()}
            >
              {exportBusy ? '正在导出…' : '开始导出'}
            </button>
          </fieldset>
          <p className="novel-export-note">
            默认导出已发布版本；包含草稿时使用最新已保存版本。未保存的修改请先保存。
          </p>
          {exportScope === 'selection' && exportCount === 0 && (
            <p className="novel-export-note">请在章节列表勾选要导出的章节。</p>
          )}
          {exportMessage && (
            <div
              className={`novel-export-status${exportError ? ' is-error' : ''}`}
              role={exportError ? 'alert' : 'status'}
            >
              {exportMessage}
            </div>
          )}
          {exportTaskId && exportBusy && (
            <button
              type="button"
              onClick={() =>
                void callWorker('novel.export.cancel', { jobId: exportTaskId }).catch(
                  (reason: unknown) =>
                    setExportMessage(reason instanceof Error ? reason.message : '取消失败'),
                )
              }
            >
              取消此小说导出
            </button>
          )}
          {exportResult && (
            <div className="novel-export-result">
              <span className="novel-export-path">{exportResult.packagePath}</span>
              <button
                className="button secondary"
                type="button"
                disabled={revealBusy || exportBusy}
                onClick={() => void revealExport()}
              >
                <FolderOpen size={14} /> {revealBusy ? '正在打开…' : '打开导出文件夹'}
              </button>
            </div>
          )}
        </section>
      )}
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
              <button type="button" disabled={importBusy} onClick={() => void importNovel()}>
                保存草稿并切片
              </button>
              <button type="button" disabled={importBusy} onClick={() => setImportPreview([])}>
                取消
              </button>
              {importTaskId && importBusy && (
                <button
                  type="button"
                  onClick={() =>
                    void callWorker('file.task.cancel', { taskId: importTaskId }).catch(
                      (reason: unknown) =>
                        setMessage(reason instanceof Error ? reason.message : '取消失败'),
                    )
                  }
                >
                  取消此小说导入
                </button>
              )}
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
            {consistency.chapterCount} 个草稿 · {consistency.indexedChunkCount} 个 RAG 切片
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
            <div className="novel-chapter-tools">
              <label>
                <Search size={13} aria-hidden="true" />
                <input
                  aria-label="搜索小说草稿"
                  type="search"
                  placeholder="搜索标题"
                  value={searchKeyword}
                  onChange={(event) => setSearchKeyword(event.target.value)}
                />
              </label>
              <div className="novel-chapter-selection" aria-label="导出章节选择">
                <button
                  className="button secondary"
                  type="button"
                  disabled={exportBusy || visibleActiveChapters.length === 0}
                  onClick={selectVisibleChapters}
                >
                  {normalizedSearch ? '全选搜索结果' : '全选'}
                </button>
                <button
                  className="button secondary"
                  type="button"
                  disabled={exportBusy || selectedExportIds.length === 0}
                  onClick={() => setExportChapterIds([])}
                >
                  取消全选
                </button>
                <span>已选 {selectedExportIds.length} 章</span>
              </div>
            </div>
            {referenceDocuments.length > 0 && (
              <div className="novel-volume-group" aria-label="小说资料">
                <strong>小说资料</strong>
                {referenceDocuments
                  .filter(
                    (item) =>
                      !normalizedSearch ||
                      item.title.toLocaleLowerCase('zh-CN').includes(normalizedSearch),
                  )
                  .map((item) => (
                    <button
                      className={`tree-item ${selectedReferenceId === item.id ? 'selected' : ''}`}
                      type="button"
                      key={item.id}
                      disabled={busy}
                      onClick={() => void openReference(item.id)}
                    >
                      <FileText size={13} />
                      <span>{item.title}</span>
                      <small>{item.kind === 'outline' ? '大纲' : '资料'}</small>
                    </button>
                  ))}
              </div>
            )}
            {volumes.map((volume) => (
              <div key={volume.id} className="novel-volume-group">
                <strong>{volume.title}</strong>
                {filteredChapters
                  .filter((chapter) => chapter.volumeId === volume.id)
                  .map((chapter) => renderChapterItem(chapter))}
              </div>
            ))}
            {filteredChapters
              .filter((chapter) => !chapter.volumeId)
              .map((chapter) => renderChapterItem(chapter))}
            {filteredChapters.length === 0 && (
              <small className="tree-empty">
                {chapters.length === 0 ? '暂无小说草稿。' : '没有匹配的草稿。'}
              </small>
            )}
          </aside>
          <section className="novel-editor">
            {(selected || selectedReferenceId) && document ? (
              <>
                <div className="novel-editor-heading">
                  <input
                    aria-label={selectedReferenceId ? '小说资料标题' : '章节标题'}
                    value={title}
                    disabled={!writable || busy}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                  <span className="document-state">
                    {document.currentVersion
                      ? documentStateLabel(document.currentVersion.state)
                      : '未保存'}
                  </span>
                  {selected && (
                    <span
                      className={`document-state ${selected.ragChunkCount > 0 ? 'rag-ready' : 'rag-pending'}`}
                    >
                      {selected.ragChunkCount > 0 ? `已切片 ${selected.ragChunkCount}` : '未切片'}
                    </span>
                  )}
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
                  aria-label={selectedReferenceId ? '小说资料内容' : '章节内容'}
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
                    <Save size={13} /> 保存并切片
                  </button>
                  {selected && (
                    <button
                      className={selected.lifecycleStatus === 'archived' ? '' : 'danger'}
                      type="button"
                      disabled={!writable || busy}
                      onClick={() => void toggleArchive()}
                    >
                      {selected.lifecycleStatus === 'archived' ? (
                        '恢复草稿'
                      ) : (
                        <>
                          <Trash2 size={13} /> 删除草稿
                        </>
                      )}
                    </button>
                  )}
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
