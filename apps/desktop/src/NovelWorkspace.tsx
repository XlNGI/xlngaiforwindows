import {
  AlertTriangle,
  Archive,
  BookOpen,
  CheckCircle2,
  Clapperboard,
  ExternalLink,
  FolderOpen,
  FileText,
  Plus,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
  RotateCcw,
  FileUp,
} from 'lucide-react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { useEffect, useState } from 'react';
import type {
  DocumentDetail,
  DocumentSummary,
  NovelChapterInfo,
  NovelConsistencyReport,
  NovelMarkdownExportFormat,
  NovelMarkdownExportJobInfo,
  NovelVolumeInfo,
} from '@ai-video/contracts';
import { projectWorker } from './worker-scope';
import { observeFileTask, observeMarkdownExport } from './file-task-client';
import { MarkdownEditor } from './MarkdownEditor';
import { DocumentDirectoryTitleText } from './DocumentDirectoryTitle';
import { useDraftDocumentBatch, type DraftDeletionTarget } from './DraftDocumentBatch';
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
  onGenerateScript?: (chapters: NovelChapterInfo[]) => Promise<void>;
  productionBusy?: boolean;
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
  onGenerateScript,
  productionBusy = false,
}: NovelWorkspaceProps) {
  const callWorker = projectWorker();
  const [chapters, setChapters] = useState<NovelChapterInfo[]>([]);
  const [volumes, setVolumes] = useState<NovelVolumeInfo[]>([]);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [selected, setSelected] = useState<NovelChapterInfo>();
  const [archivedReferences, setArchivedReferences] = useState<DocumentSummary[]>([]);
  const [deletedReferenceIds, setDeletedReferenceIds] = useState<string[]>([]);
  const [selectedReferenceId, setSelectedReferenceId] = useState<string>();
  const [document, setDocument] = useState<DocumentDetail>();
  const [title, setTitle] = useState('');
  const [editingTitleId, setEditingTitleId] = useState<string>();
  const [content, setContent] = useState('');
  const [working, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [conflictDocument, setConflictDocument] = useState<DocumentDetail>();
  const [exportBusy, setExportBusy] = useState(false);
  const [exportTaskId, setExportTaskId] = useState<string>();
  const [importTaskId, setImportTaskId] = useState<string>();
  const [exportOpen, setExportOpen] = useState(false);
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
  const directoryReferences = [
    ...referenceDocuments.filter((item) => !deletedReferenceIds.includes(item.id)),
    ...(includeArchived ? archivedReferences : []),
  ];
  const chapterTarget = (chapter: NovelChapterInfo): DraftDeletionTarget => ({
    id: chapter.documentId,
    title: `${chapter.displayLabel} ${chapter.title}`,
    lifecycleStatus: chapter.lifecycleStatus,
    rowVersion: chapter.documentRowVersion,
    chapterId: chapter.id,
    chapterRowVersion: chapter.rowVersion,
  });
  const visibleReferences = directoryReferences.filter(
    (item) => !normalizedSearch || item.title.toLocaleLowerCase('zh-CN').includes(normalizedSearch),
  );
  const batch = useDraftDocumentBatch({
    items: [...chapters.map(chapterTarget), ...directoryReferences],
    visibleItems: [...filteredChapters.map(chapterTarget), ...visibleReferences],
    writable,
    busy: working || exportBusy || productionBusy || importBusy,
    resetKey: projectId ?? '',
    dirtyDocumentId:
      document &&
      (title !== document.title || content !== (document.currentVersion?.contentMarkdown ?? ''))
        ? document.id
        : undefined,
    onSelectionChange: () => setExportScope('selection'),
    onDeleted: async (deleted, archived) => {
      const ids = new Set(deleted.map((item) => item.id));
      setChapters((rows) =>
        rows.flatMap((row) =>
          ids.has(row.documentId)
            ? includeArchived
              ? [{ ...row, lifecycleStatus: 'archived' as const }]
              : []
            : [row],
        ),
      );
      setDeletedReferenceIds((current) => [
        ...new Set([...current, ...archived.map((item) => item.id)]),
      ]);
      setArchivedReferences((rows) => [...archived, ...rows.filter((item) => !ids.has(item.id))]);
      if (document && ids.has(document.id)) {
        setSelected(undefined);
        setSelectedReferenceId(undefined);
        setDocument(undefined);
        setTitle('');
        setContent('');
        setEditingTitleId(undefined);
        setConflictDocument(undefined);
      }
      const rows = await callWorker('novel.chapter.list', { includeArchived });
      setChapters(rows);
      await onReferencesChanged?.();
    },
  });
  const busy = working || batch.deleting;
  const selectedChapters = activeChapters.filter((chapter) =>
    batch.selectedIds.has(chapter.documentId),
  );
  const selectedChapterIds = selectedChapters.map((chapter) => chapter.id);
  const productionChapters = selectedChapters.length
    ? selectedChapters
    : activeChapters.filter((chapter) => chapter.id === selected?.id);
  const exportCount = exportScope === 'work' ? activeChapters.length : selectedChapters.length;

  const renderChapterItem = (chapter: NovelChapterInfo) => {
    const isSelected = selected?.id === chapter.id;
    const chapterTitle = isSelected ? title : chapter.title;
    const titleKey = `chapter:${chapter.id}`;
    const editing = isSelected && editingTitleId === titleKey;

    return (
      <div className="novel-chapter-row document-directory-item" key={chapter.id}>
        {batch.checkbox(chapterTarget(chapter), `选择 ${chapter.displayLabel} ${chapterTitle}`)}
        {editing ? (
          <div className="tree-item novel-chapter-title-edit selected">
            <FileText size={13} />
            <input
              className="document-directory-title-input"
              type="text"
              aria-label="章节标题"
              autoFocus
              value={title}
              readOnly={!writable || busy}
              onChange={(event) => setTitle(event.target.value)}
              onBlur={() => {
                if (!title.trim()) setTitle(document?.title ?? chapter.title);
                setEditingTitleId(undefined);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
                if (event.key === 'Escape') {
                  setTitle(document?.title ?? chapter.title);
                  setEditingTitleId(undefined);
                }
              }}
            />
            <small className={chapter.ragChunkCount > 0 ? 'rag-ready' : 'rag-pending'}>
              {chapter.ragChunkCount > 0 ? `${chapter.ragChunkCount} 切片` : '未切片'}
            </small>
          </div>
        ) : (
          <button
            className={`tree-item ${isSelected ? 'selected' : ''}`}
            type="button"
            aria-label={
              isSelected
                ? `编辑章节标题 ${chapter.displayLabel} ${chapterTitle}`
                : `打开章节 ${chapter.displayLabel} ${chapter.title}`
            }
            onClick={() => {
              if (isSelected) setEditingTitleId(titleKey);
              else {
                setEditingTitleId(undefined);
                void openChapter(chapter);
              }
            }}
          >
            <FileText size={13} />
            <DocumentDirectoryTitleText text={`${chapter.displayLabel} ${chapterTitle}`} />
            <small className={chapter.ragChunkCount > 0 ? 'rag-ready' : 'rag-pending'}>
              {chapter.ragChunkCount > 0 ? `${chapter.ragChunkCount} 切片` : '未切片'}
            </small>
          </button>
        )}
        <button
          className="icon-button subtle document-directory-archive"
          type="button"
          title={chapter.lifecycleStatus === 'archived' ? '恢复章节' : '归档后可在已删除章节中恢复'}
          aria-label={
            chapter.lifecycleStatus === 'archived'
              ? `恢复章节 ${chapter.displayLabel} ${chapter.title}`
              : `归档章节 ${chapter.displayLabel} ${chapter.title}`
          }
          disabled={!writable || busy}
          onClick={() => void toggleArchive(chapter)}
        >
          {chapter.lifecycleStatus === 'archived' ? (
            <RotateCcw size={14} aria-hidden="true" />
          ) : (
            <Archive size={14} aria-hidden="true" />
          )}
        </button>
      </div>
    );
  };

  const loadChapters = async (preferredId?: string, forceOpen = false) => {
    if (!projectId) return;
    const [rows, volumeRows, archivedRows] = await Promise.all([
      callWorker('novel.chapter.list', { includeArchived }),
      callWorker('novel.volume.list', { includeArchived }),
      includeArchived ? callWorker('document.archived.list', {}) : Promise.resolve([]),
    ]);
    setChapters(rows);
    setArchivedReferences(archivedRows.filter((item) => item.domainScope === 'novel'));
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
      setEditingTitleId(undefined);
    }
  };

  useEffect(() => {
    void loadChapters(focusChapterId, Boolean(focusChapterId || refreshToken !== undefined));
  }, [projectId, includeArchived, focusChapterId, focusReferenceId, refreshToken]);

  useEffect(() => {
    let active = true;
    const refreshMetadata = (event: Event) => {
      if (
        !projectId ||
        (event as CustomEvent<{ projectId: string }>).detail?.projectId !== projectId
      )
        return;
      void (async () => {
        const rows = await callWorker('novel.chapter.list', { includeArchived });
        if (!active) return;
        setChapters(rows);
        const updated = rows.find((row) => row.id === selected?.id);
        if (!updated || !document || document.id !== updated.documentId) return;
        const latest = await callWorker('document.get', { documentId: updated.documentId });
        if (!active) return;
        setSelected(updated);
        // Adopt a metadata-only revision without replacing local edits or a changed body baseline.
        if (
          latest.currentVersionId === document.currentVersionId &&
          latest.publishedVersionId === document.publishedVersionId
        ) {
          setDocument(latest);
          setTitle((value) => (value === document.title ? latest.title : value));
        }
      })().catch((reason: unknown) => {
        if (active) setMessage(reason instanceof Error ? reason.message : '章节目录刷新失败');
      });
    };
    window.addEventListener('novel-metadata-updated', refreshMetadata);
    return () => {
      active = false;
      window.removeEventListener('novel-metadata-updated', refreshMetadata);
    };
  }, [projectId, includeArchived, selected?.id, document]);

  const openReference = async (documentId: string) => {
    setBusy(true);
    try {
      const detail = await callWorker('document.get', { documentId });
      if (detail.domainScope !== 'novel') throw new Error('该文档不属于小说资料。');
      setSelected(undefined);
      setSelectedReferenceId(documentId);
      setEditingTitleId(undefined);
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
      setEditingTitleId(undefined);
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

  const toggleArchive = async (chapter: NovelChapterInfo) => {
    if (busy || !writable) return;
    const hasLocalChanges =
      selected?.id === chapter.id &&
      document &&
      (title !== document.title || content !== (document.currentVersion?.contentMarkdown ?? ''));
    if (
      chapter.lifecycleStatus !== 'archived' &&
      !window.confirm(
        `确定归档“${chapter.displayLabel} ${chapter.title}”吗？可从“显示已删除”中恢复。${hasLocalChanges ? '当前未保存的标题和正文不会保留。' : ''}`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      if (chapter.lifecycleStatus === 'archived') {
        await callWorker('novel.chapter.restore', {
          chapterId: chapter.id,
          expectedRowVersion: chapter.rowVersion,
        });
        setMessage('章节已恢复。');
      } else {
        await callWorker('novel.chapter.archive', {
          chapterId: chapter.id,
          expectedRowVersion: chapter.rowVersion,
          reason: 'user_archive',
        });
        setMessage('章节已归档，可从“显示已删除”中恢复。');
      }
      await loadChapters(chapter.id);
    } finally {
      setBusy(false);
    }
  };

  const restoreReference = async (item: DocumentSummary) => {
    if (!writable || busy) return;
    setBusy(true);
    try {
      await callWorker('document.unarchive', {
        documentId: item.id,
        expectedDocumentRowVersion: item.rowVersion,
      });
      setArchivedReferences((rows) => rows.filter((row) => row.id !== item.id));
      setDeletedReferenceIds((ids) => ids.filter((id) => id !== item.id));
      await onReferencesChanged?.();
      await openReference(item.id);
      setMessage(`已恢复“${item.title}”。`);
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : '恢复小说资料失败');
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
        ...(exportScope === 'selection' ? { chapterIds: selectedChapterIds } : {}),
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
      {batch.dialog}
      <header className="novel-toolbar">
        <div className="novel-toolbar-row">
          <div className="novel-toolbar-title">
            <BookOpen size={16} aria-hidden="true" />
            <strong>小说工作区</strong>
          </div>
          <div className="novel-toolbar-utilities" role="group" aria-label="章节管理">
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
              aria-label="刷新章节"
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
          </div>
        </div>
        <div className="novel-toolbar-command-row" role="group" aria-label="小说操作">
          {onGenerateScript && (
            <button
              className="button primary production-generate-button"
              type="button"
              disabled={
                !writable ||
                busy ||
                productionBusy ||
                productionChapters.length === 0 ||
                productionChapters.length > 50
              }
              title="使用已勾选章节；未勾选时使用当前打开的章节"
              onClick={() => {
                if (
                  productionChapters.some((chapter) => chapter.id === selected?.id) &&
                  (content !== (document?.currentVersion?.contentMarkdown ?? '') ||
                    title !== document?.title)
                ) {
                  setMessage('请先保存当前章节，再生成剧本。');
                  return;
                }
                void onGenerateScript(productionChapters);
              }}
            >
              <Clapperboard size={15} aria-hidden="true" />
              {productionBusy ? '正在生成…' : `一键生成剧本（${productionChapters.length}章）`}
            </button>
          )}
          <div className="novel-toolbar-actions" role="group" aria-label="小说文档操作">
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
              disabled={exportBusy || !projectId || !writable || activeChapters.length === 0}
              aria-expanded={exportOpen}
              aria-controls="novel-export-options"
              onClick={() => setExportOpen((open) => !open)}
            >
              <BookOpen size={13} /> 导出 Markdown
            </button>
            <button
              className="button secondary"
              type="button"
              disabled={busy || !writable || !projectId}
              onClick={() => void createDraft()}
            >
              <Plus size={13} /> 新建草稿
            </button>
          </div>
        </div>
        {message && <span className="inline-status">{message}</span>}
      </header>
      {exportOpen && (
        <section id="novel-export-options" className="novel-export-panel" aria-label="小说导出选项">
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
                <option value="selection">所选章节（{selectedChapters.length} 章）</option>
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
              {batch.controls(
                normalizedSearch ? '全选搜索结果' : '全选',
                `已选 ${selectedChapters.length} 章${batch.selectedIds.size > selectedChapters.length ? ` · ${batch.selectedIds.size - selectedChapters.length} 份资料` : ''}`,
              )}
              {batch.message && <small role="status">{batch.message}</small>}
            </div>
            <div
              className="novel-chapter-list"
              role="region"
              aria-label="小说目录列表"
              tabIndex={0}
            >
              {visibleReferences.length > 0 && (
                <div className="novel-volume-group" aria-label="小说资料">
                  <strong>小说资料</strong>
                  {visibleReferences.map((item) => {
                    const isSelected = selectedReferenceId === item.id;
                    const itemTitle = isSelected ? title : item.title;
                    const titleKey = `reference:${item.id}`;
                    const editing = isSelected && editingTitleId === titleKey;

                    return (
                      <div
                        className="novel-reference-row novel-chapter-row document-directory-item"
                        key={item.id}
                      >
                        {batch.checkbox(item, `选择小说资料 ${item.title}`)}
                        {editing ? (
                          <div className="tree-item novel-reference-title-edit selected">
                            <FileText size={13} />
                            <input
                              className="document-directory-title-input"
                              type="text"
                              aria-label="小说资料标题"
                              autoFocus
                              value={title}
                              readOnly={!writable || busy}
                              onChange={(event) => setTitle(event.target.value)}
                              onBlur={() => {
                                if (!title.trim()) setTitle(document?.title ?? item.title);
                                setEditingTitleId(undefined);
                              }}
                              onKeyDown={(event) => {
                                if (event.key === 'Enter') {
                                  event.preventDefault();
                                  event.currentTarget.blur();
                                }
                                if (event.key === 'Escape') {
                                  setTitle(document?.title ?? item.title);
                                  setEditingTitleId(undefined);
                                }
                              }}
                            />
                            <small>{item.kind === 'outline' ? '大纲' : '资料'}</small>
                          </div>
                        ) : (
                          <button
                            className={`tree-item ${isSelected ? 'selected' : ''}`}
                            type="button"
                            aria-label={
                              isSelected
                                ? `编辑小说资料标题 ${itemTitle}`
                                : `打开小说资料 ${item.title}`
                            }
                            disabled={busy}
                            onClick={() => {
                              if (isSelected) setEditingTitleId(titleKey);
                              else {
                                setEditingTitleId(undefined);
                                void openReference(item.id);
                              }
                            }}
                          >
                            <FileText size={13} />
                            <DocumentDirectoryTitleText text={itemTitle} />
                            <small>{item.kind === 'outline' ? '大纲' : '资料'}</small>
                          </button>
                        )}
                        {item.lifecycleStatus === 'archived' && (
                          <button
                            className="icon-button subtle"
                            type="button"
                            aria-label={`恢复小说资料 ${item.title}`}
                            disabled={!writable || busy || batch.deleting}
                            onClick={() => void restoreReference(item)}
                          >
                            <RotateCcw size={14} />
                          </button>
                        )}
                      </div>
                    );
                  })}
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
            </div>
          </aside>
          <section className="novel-editor">
            {(selected || selectedReferenceId) && document ? (
              <>
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
                <MarkdownEditor
                  label={selectedReferenceId ? '小说资料内容' : '章节内容'}
                  className="novel-markdown-editor"
                  value={content}
                  disabled={!writable || busy}
                  onChange={setContent}
                  autoPreviewOnBlur
                />
                <div className="novel-editor-actions">
                  <button
                    type="button"
                    disabled={!writable || busy}
                    onClick={() => void saveDraft()}
                  >
                    <Save size={13} /> 保存并切片
                  </button>
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
