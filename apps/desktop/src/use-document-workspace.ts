import { useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type {
  DocumentDetail,
  DocumentKind,
  DocumentSummary,
  DocumentVersionInfo,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { readMarkdownDocument } from './markdown-import-client';

export interface UseDocumentWorkspaceOptions {
  writable: boolean;
  syncDetachedPanel: (entityId?: string) => void;
  openDocumentWorkspace: () => void;
  closeDocumentPanel: () => void;
}

export function useDocumentWorkspace({
  writable,
  syncDetachedPanel,
  openDocumentWorkspace,
  closeDocumentPanel,
}: UseDocumentWorkspaceOptions) {
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [document, setDocument] = useState<DocumentDetail>();
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentKind, setDocumentKind] = useState<DocumentKind>('outline');
  const [documentContent, setDocumentContent] = useState('');
  const [versions, setVersions] = useState<DocumentVersionInfo[]>([]);
  const [contentBusy, setContentBusy] = useState(false);
  const [contentMessage, setContentMessage] = useState('');
  const [documentCloseConfirmation, setDocumentCloseConfirmation] = useState(false);
  const documentRequest = useRef(0);

  const documentEditorWritable =
    writable &&
    (!document ||
      ['draft', 'changes_requested', 'published'].includes(
        document.currentVersion?.state ?? 'draft',
      ));
  const documentDirty = Boolean(
    documentTitle.trim() &&
    (!document ||
      document.title !== documentTitle ||
      document.kind !== documentKind ||
      (document.currentVersion?.contentMarkdown ?? '') !== documentContent),
  );

  const applyDocument = async (nextDocument: DocumentDetail, openPanel = false): Promise<void> => {
    setDocument(nextDocument);
    setDocumentTitle(nextDocument.title);
    setDocumentKind(nextDocument.kind);
    setDocumentContent(nextDocument.currentVersion?.contentMarkdown ?? '');
    setVersions(await callWorker('document.versions', { documentId: nextDocument.id }));
    setDocuments(await callWorker('document.list', {}));
    syncDetachedPanel(nextDocument.id);
    if (openPanel) openDocumentWorkspace();
  };

  const selectDocument = async (summary: DocumentSummary) => {
    const requestId = ++documentRequest.current;
    setContentBusy(true);
    setContentMessage('');
    try {
      const [detail, history] = await Promise.all([
        callWorker('document.get', { documentId: summary.id }),
        callWorker('document.versions', { documentId: summary.id }),
      ]);
      if (requestId !== documentRequest.current) return;
      setDocument(detail);
      setDocumentTitle(detail.title);
      setDocumentKind(detail.kind);
      setDocumentContent(detail.currentVersion?.contentMarkdown ?? '');
      setVersions(history);
      syncDetachedPanel(detail.id);
      openDocumentWorkspace();
    } catch (reason) {
      if (requestId === documentRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '文档加载失败');
      }
    } finally {
      if (requestId === documentRequest.current) setContentBusy(false);
    }
  };

  const openDocumentById = async (documentId: string) => {
    const requestId = ++documentRequest.current;
    setContentBusy(true);
    setContentMessage('');
    try {
      const [detail, history] = await Promise.all([
        callWorker('document.get', { documentId }),
        callWorker('document.versions', { documentId }),
      ]);
      if (requestId !== documentRequest.current) return;
      setDocument(detail);
      setDocumentTitle(detail.title);
      setDocumentKind(detail.kind);
      setDocumentContent(detail.currentVersion?.contentMarkdown ?? '');
      setVersions(history);
      syncDetachedPanel(detail.id);
      openDocumentWorkspace();
    } catch (reason) {
      if (requestId === documentRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '文档加载失败');
      }
    } finally {
      if (requestId === documentRequest.current) setContentBusy(false);
    }
  };

  const newDocument = () => {
    documentRequest.current += 1;
    setDocument(undefined);
    setDocumentTitle('');
    setDocumentKind('note');
    setDocumentContent('');
    setVersions([]);
    syncDetachedPanel();
    openDocumentWorkspace();
  };

  const importMarkdownDocument = async () => {
    const selected = await openDialog({
      directory: false,
      multiple: false,
      title: '导入 Markdown 文档',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
    });
    if (typeof selected !== 'string') return;

    setContentBusy(true);
    setContentMessage('');
    try {
      const imported = await readMarkdownDocument(selected);
      const saved = await callWorker('document.draft.save', {
        title: imported.title,
        contentMarkdown: imported.contentMarkdown,
        authorType: 'import',
      });
      await applyDocument(saved, true);
      setContentMessage(`已导入为草稿 ${imported.title} · 版本 v${saved.currentVersion?.version}`);
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : 'Markdown 导入失败');
    } finally {
      setContentBusy(false);
    }
  };

  const saveDocument = async (): Promise<boolean | undefined> => {
    if (!documentEditorWritable) {
      setContentMessage('审核中的版本不可编辑，请先退回修改或完成发布。');
      return false;
    }
    setContentBusy(true);
    setContentMessage('');
    try {
      const saved = await callWorker('document.draft.save', {
        documentId: document?.id,
        kind: documentKind,
        title: documentTitle,
        contentMarkdown: documentContent,
        expectedDocumentRowVersion: document?.rowVersion,
      });
      setDocument(saved);
      setDocuments(await callWorker('document.list', {}));
      setVersions(await callWorker('document.versions', { documentId: saved.id }));
      setContentMessage(`已保存草稿 v${saved.currentVersion?.version}`);
      return true;
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setContentBusy(false);
    }
  };

  const submitDocumentReview = async () => {
    if (!document?.currentVersionId || documentDirty) return;
    setContentBusy(true);
    setContentMessage('');
    try {
      await callWorker('document.review.submit', {
        documentId: document.id,
        documentVersionId: document.currentVersionId,
        expectedDocumentRowVersion: document.rowVersion,
      });
      const next = await callWorker('document.get', { documentId: document.id });
      setDocument(next);
      setVersions(await callWorker('document.versions', { documentId: document.id }));
      setContentMessage('已提交审核，发布前仍不会进入 LLM 权威上下文');
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '提交审核失败');
    } finally {
      setContentBusy(false);
    }
  };

  const requestDocumentChanges = async () => {
    if (!document?.currentVersionId) return;
    const comment = window.prompt('请输入退回原因（可选）') ?? undefined;
    setContentBusy(true);
    setContentMessage('');
    try {
      await callWorker('document.review.requestChanges', {
        documentId: document.id,
        documentVersionId: document.currentVersionId,
        expectedDocumentRowVersion: document.rowVersion,
        comment,
      });
      const next = await callWorker('document.get', { documentId: document.id });
      setDocument(next);
      setVersions(await callWorker('document.versions', { documentId: document.id }));
      setContentMessage('已退回修改，可继续编辑后重新提交审核');
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '退回修改失败');
    } finally {
      setContentBusy(false);
    }
  };

  const publishDocument = async () => {
    if (!document?.currentVersionId) return;
    setContentBusy(true);
    setContentMessage('');
    try {
      const result = await callWorker('document.publish', {
        documentId: document.id,
        documentVersionId: document.currentVersionId,
        expectedDocumentRowVersion: document.rowVersion,
        expectedPublishedVersionId: document.publishedVersionId,
      });
      setDocument(result.document);
      setDocuments(await callWorker('document.list', {}));
      setVersions(await callWorker('document.versions', { documentId: document.id }));
      setContentMessage(`已发布权威版本 v${result.publication.publicationNo}`);
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '发布失败，请检查版本冲突');
    } finally {
      setContentBusy(false);
    }
  };

  const restoreVersion = async (versionId: string) => {
    if (!document || !documentEditorWritable) return;
    setContentBusy(true);
    try {
      const restored = await callWorker('document.restore', {
        documentId: document.id,
        versionId,
      });
      setDocument(restored);
      setDocumentContent(restored.currentVersion?.contentMarkdown ?? '');
      setVersions(await callWorker('document.versions', { documentId: document.id }));
      setContentMessage(`已从历史版本恢复为 v${restored.currentVersion?.version}`);
    } finally {
      setContentBusy(false);
    }
  };

  const openCreatedDocument = async (created: DocumentDetail) => {
    await applyDocument(created, true);
  };

  const requestCloseDocument = () => {
    if (documentDirty) {
      setDocumentCloseConfirmation(true);
      return;
    }
    closeDocumentPanel();
  };

  const discardDocumentChanges = () => {
    if (document) {
      setDocumentTitle(document.title);
      setDocumentKind(document.kind);
      setDocumentContent(document.currentVersion?.contentMarkdown ?? '');
    } else {
      setDocumentTitle('');
      setDocumentKind('note');
      setDocumentContent('');
    }
    setDocumentCloseConfirmation(false);
    closeDocumentPanel();
  };

  const saveAndCloseDocument = async () => {
    if (await saveDocument()) {
      setDocumentCloseConfirmation(false);
      closeDocumentPanel();
    }
  };

  const syncMainDocumentIfSelected = (
    nextDocument: DocumentDetail,
    history: DocumentVersionInfo[],
  ) => {
    if (document?.id !== nextDocument.id) return;
    setDocument(nextDocument);
    setDocumentTitle(nextDocument.title);
    setDocumentKind(nextDocument.kind);
    setDocumentContent(nextDocument.currentVersion?.contentMarkdown ?? '');
    setVersions(history);
  };

  const reset = () => {
    documentRequest.current += 1;
    setDocuments([]);
    setDocument(undefined);
    setDocumentTitle('');
    setDocumentKind('note');
    setDocumentContent('');
    setVersions([]);
    setContentBusy(false);
    setContentMessage('');
    setDocumentCloseConfirmation(false);
  };

  return {
    documents,
    setDocuments,
    document,
    setDocument,
    documentTitle,
    setDocumentTitle,
    documentKind,
    setDocumentKind,
    documentContent,
    setDocumentContent,
    versions,
    setVersions,
    contentBusy,
    setContentBusy,
    contentMessage,
    setContentMessage,
    documentCloseConfirmation,
    setDocumentCloseConfirmation,
    documentEditorWritable,
    documentDirty,
    selectDocument,
    openDocumentById,
    newDocument,
    importMarkdownDocument,
    saveDocument,
    submitDocumentReview,
    requestDocumentChanges,
    publishDocument,
    restoreVersion,
    openCreatedDocument,
    requestCloseDocument,
    discardDocumentChanges,
    saveAndCloseDocument,
    syncMainDocumentIfSelected,
    reset,
  };
}
