import { useEffect, useRef } from 'react';
import { useProjectViewState } from './use-project-view-state';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import type {
  DocumentDetail,
  PromptBindingIR,
  DocumentKind,
  DocumentSummary,
  DocumentVersionInfo,
} from '@ai-video/contracts';
import { projectWorker, workerScope, isCurrentWorkerScope } from './worker-scope';
import { readMarkdownDocument } from './markdown-import-client';
import { useCharacterVoicePrompt } from './use-character-voice-prompt';
export interface UseDocumentWorkspaceOptions {
  writable: boolean;
  syncDetachedPanel: (entityId?: string) => void;
  closeDetachedPanel?: (entityId: string) => void;
  openDocumentWorkspace: (kind?: DocumentKind) => void;
  closeDocumentPanel: () => void;
}
export function useDocumentWorkspace({
  writable,
  syncDetachedPanel: syncDetachedPanelCallback,
  closeDetachedPanel: closeDetachedPanelCallback,
  openDocumentWorkspace: openDocumentWorkspaceCallback,
  closeDocumentPanel: closeDocumentPanelCallback,
}: UseDocumentWorkspaceOptions) {
  const scope = workerScope();
  const callWorker = projectWorker(scope);
  const syncDetachedPanel: UseDocumentWorkspaceOptions['syncDetachedPanel'] = (...args) => {
    if (isCurrentWorkerScope(scope)) syncDetachedPanelCallback(...args);
  };
  const openDocumentWorkspace: UseDocumentWorkspaceOptions['openDocumentWorkspace'] = (...args) => {
    if (isCurrentWorkerScope(scope)) openDocumentWorkspaceCallback(...args);
  };
  const closeDetachedPanel: NonNullable<UseDocumentWorkspaceOptions['closeDetachedPanel']> = (
    entityId,
  ) => {
    if (isCurrentWorkerScope(scope)) closeDetachedPanelCallback?.(entityId);
  };
  const closeDocumentPanel = () => {
    if (isCurrentWorkerScope(scope)) closeDocumentPanelCallback();
  };
  const [documents, setDocuments] = useProjectViewState<DocumentSummary[]>([]);
  const [archivedDocuments, setArchivedDocuments] = useProjectViewState<DocumentSummary[]>([]);
  const [document, setDocument] = useProjectViewState<DocumentDetail>();
  const [documentTitle, setDocumentTitle] = useProjectViewState('');
  const [documentKind, setDocumentKind] = useProjectViewState<DocumentKind>('outline');
  const [documentContent, setDocumentContent] = useProjectViewState('');
  const [documentBindings, setDocumentBindings] = useProjectViewState<PromptBindingIR>();
  const [documentSampleText, setDocumentSampleText] = useProjectViewState('');
  const [versions, setVersions] = useProjectViewState<DocumentVersionInfo[]>([]);
  const [contentBusy, setContentBusy] = useProjectViewState(false);
  const [contentMessage, setContentMessage] = useProjectViewState('');
  const [documentCloseConfirmation, setDocumentCloseConfirmation] = useProjectViewState(false);
  const [documentArchiveConfirmation, setDocumentArchiveConfirmation] = useProjectViewState(false);
  const [documentArchiveTarget, setDocumentArchiveTarget] = useProjectViewState<DocumentSummary>();
  const documentRequest = useRef(0);
  useEffect(() => {
    let active = true;
    if (!scope) {
      setArchivedDocuments([]);
      return () => {
        active = false;
      };
    }
    void callWorker('document.archived.list', {})
      .then((rows) => {
        if (active && isCurrentWorkerScope(scope)) setArchivedDocuments(rows);
      })
      .catch(() => {
        if (active && isCurrentWorkerScope(scope)) setArchivedDocuments([]);
      });
    return () => {
      active = false;
    };
  }, [scope?.projectId, scope?.projectSessionId]);
  const documentEditorWritable =
    writable &&
    (!document || !document.publishedVersionId) &&
    (!document ||
      ['draft', 'changes_requested'].includes(document.currentVersion?.state ?? 'draft'));
  const characterVoicePrompt = useCharacterVoicePrompt({
    characterId: documentKind === 'character' ? document?.id : undefined,
    voiceDocumentId: documentBindings?.voiceDocumentId,
    versionId: documents.find((item) => item.id === documentBindings?.voiceDocumentId)
      ?.currentVersionId,
    writable: documentEditorWritable && !contentBusy,
  });
  const mainDocumentDirty = document
    ? document.title !== documentTitle ||
      document.kind !== documentKind ||
      (document.currentVersion?.contentMarkdown ?? '') !== documentContent ||
      JSON.stringify(document.currentVersion?.bindings ?? undefined) !==
        JSON.stringify(documentBindings) ||
      (document.currentVersion?.sampleText ?? '') !== documentSampleText
    : Boolean(documentTitle.trim() || documentContent.trim());
  const documentDirty = mainDocumentDirty || characterVoicePrompt.dirty;
  const editorState = useRef({ document, documentDirty });
  editorState.current = { document, documentDirty };
  const refreshCommittedDocuments = async () => {
    const selectedId = editorState.current.document?.id;
    const requestId = documentRequest.current;
    const nextDocuments = await callWorker('document.list', {});
    if (!isCurrentWorkerScope(scope)) return;
    setDocuments(nextDocuments);
    if (!selectedId || editorState.current.documentDirty) return;
    const [detail, history] = await Promise.all([
      callWorker('document.get', { documentId: selectedId }),
      callWorker('document.versions', { documentId: selectedId }),
    ]);
    if (
      !isCurrentWorkerScope(scope) ||
      documentRequest.current !== requestId ||
      editorState.current.document?.id !== selectedId ||
      editorState.current.documentDirty
    )
      return;
    setDocument(detail);
    setDocumentTitle(detail.title);
    setDocumentKind(detail.kind);
    setDocumentContent(detail.currentVersion?.contentMarkdown ?? '');
    setDocumentBindings(detail.currentVersion?.bindings ?? undefined);
    setDocumentSampleText(detail.currentVersion?.sampleText ?? '');
    setVersions(history);
  };
  const applyDocument = async (nextDocument: DocumentDetail, openPanel = false): Promise<void> => {
    setDocument(nextDocument);
    setDocumentTitle(nextDocument.title);
    setDocumentKind(nextDocument.kind);
    setDocumentContent(nextDocument.currentVersion?.contentMarkdown ?? '');
    setDocumentBindings(nextDocument.currentVersion?.bindings ?? undefined);
    setDocumentSampleText(nextDocument.currentVersion?.sampleText ?? '');
    setVersions(await callWorker('document.versions', { documentId: nextDocument.id }));
    setDocuments(await callWorker('document.list', {}));
    syncDetachedPanel(nextDocument.id);
    if (openPanel) openDocumentWorkspace(nextDocument.kind);
  };
  const selectDocument = async (summary: DocumentSummary) => {
    if (characterVoicePrompt.dirty) {
      setContentMessage('请先保存音色提示词，或关闭页面并放弃修改，再切换文档。');
      return;
    }
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
      setDocumentBindings(detail.currentVersion?.bindings ?? undefined);
      setDocumentSampleText(detail.currentVersion?.sampleText ?? '');
      setVersions(history);
      syncDetachedPanel(detail.id);
      openDocumentWorkspace(detail.kind);
    } catch (reason) {
      if (requestId === documentRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '文档加载失败');
      }
    } finally {
      if (requestId === documentRequest.current) setContentBusy(false);
    }
  };
  const openDocumentById = async (documentId: string) => {
    if (characterVoicePrompt.dirty) {
      setContentMessage('请先保存音色提示词，或关闭页面并放弃修改，再切换文档。');
      return;
    }
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
      setDocumentBindings(detail.currentVersion?.bindings ?? undefined);
      setDocumentSampleText(detail.currentVersion?.sampleText ?? '');
      setVersions(history);
      syncDetachedPanel(detail.id);
      openDocumentWorkspace(detail.kind);
    } catch (reason) {
      if (requestId === documentRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '文档加载失败');
      }
    } finally {
      if (requestId === documentRequest.current) setContentBusy(false);
    }
  };
  const newDocument = () => {
    if (characterVoicePrompt.dirty) {
      setContentMessage('请先保存音色提示词，或关闭页面并放弃修改，再新建文档。');
      return false;
    }
    documentRequest.current += 1;
    setDocument(undefined);
    setDocumentTitle('');
    setDocumentKind('note');
    setDocumentContent('');
    setDocumentBindings(undefined);
    setDocumentSampleText('');
    setVersions([]);
    syncDetachedPanel();
    openDocumentWorkspace();
    return true;
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
  const saveDocument = async (): Promise<DocumentDetail | undefined> => {
    if (!documentEditorWritable) {
      setContentMessage(
        document?.publishedVersionId
          ? '已发布文档只读，请先取消发布。'
          : '审核中的版本不可编辑，请先退回修改或完成发布。',
      );
      return undefined;
    }
    setContentBusy(true);
    setContentMessage('');
    try {
      const savedVoice = await characterVoicePrompt.save();
      const saved =
        document && !mainDocumentDirty && savedVoice
          ? document
          : await callWorker('document.draft.save', {
              documentId: document?.id,
              kind: documentKind,
              title: documentTitle,
              contentMarkdown: documentContent,
              bindings: documentBindings,
              ...(documentKind === 'voice' ? { sampleText: documentSampleText } : {}),
              expectedDocumentRowVersion: document?.rowVersion,
            });
      setDocument(saved);
      setDocuments(await callWorker('document.list', {}));
      setVersions(await callWorker('document.versions', { documentId: saved.id }));
      setContentMessage(
        savedVoice && !mainDocumentDirty
          ? '已保存音色提示词'
          : `已保存草稿 v${saved.currentVersion?.version}`,
      );
      return saved;
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '保存失败');
      return undefined;
    } finally {
      setContentBusy(false);
    }
  };
  const requestArchiveDocument = (target?: DocumentSummary) => {
    const archiveTarget = target ?? document;
    if (!archiveTarget || !writable || contentBusy) return;
    setDocumentArchiveTarget(archiveTarget);
    setContentMessage('');
    setDocumentArchiveConfirmation(true);
  };
  const confirmArchiveDocument = async (
    saveUnsavedChanges: boolean,
  ): Promise<DocumentDetail | undefined> => {
    if (!documentArchiveTarget || !writable || contentBusy) return undefined;
    const isCurrentDocument = document?.id === documentArchiveTarget.id;
    if (!isCurrentDocument) {
      setContentBusy(true);
      setContentMessage('');
      try {
        const archived = await callWorker('document.archive', {
          documentId: documentArchiveTarget.id,
          expectedDocumentRowVersion: documentArchiveTarget.rowVersion,
        });
        closeDetachedPanel(archived.id);
        setDocumentArchiveConfirmation(false);
        setDocumentArchiveTarget(undefined);
        setDocuments((current) => current.filter((item) => item.id !== archived.id));
        setArchivedDocuments((current) => [
          archived,
          ...current.filter((item) => item.id !== archived.id),
        ]);
        setContentMessage(`已归档“${archived.title}”，可在已归档文档中恢复。`);
        try {
          const [activeRows, archivedRows] = await Promise.all([
            callWorker('document.list', {}),
            callWorker('document.archived.list', {}),
          ]);
          setDocuments(activeRows);
          setArchivedDocuments(archivedRows);
        } catch {
          // Keep the optimistic list update after a successful lifecycle change.
        }
        return archived;
      } catch (reason) {
        setContentMessage(reason instanceof Error ? reason.message : '归档失败');
        return undefined;
      } finally {
        setContentBusy(false);
      }
    }
    if (!document || !writable || contentBusy) return undefined;
    if (saveUnsavedChanges && documentDirty && !documentEditorWritable) {
      setContentMessage('当前版本不可保存，请放弃未保存更改后归档。');
      return undefined;
    }
    if (saveUnsavedChanges && documentDirty && !documentTitle.trim()) {
      setContentMessage('保存并归档前请填写文档标题。');
      return undefined;
    }
    let target = document;
    setContentBusy(true);
    setContentMessage('');
    try {
      if (saveUnsavedChanges && documentDirty) {
        await characterVoicePrompt.save();
        target = await callWorker('document.draft.save', {
          documentId: document.id,
          kind: documentKind,
          title: documentTitle,
          contentMarkdown: documentContent,
          bindings: documentBindings,
          ...(documentKind === 'voice' ? { sampleText: documentSampleText } : {}),
          expectedDocumentRowVersion: document.rowVersion,
        });
        setDocument(target);
        setDocuments((current) => [target, ...current.filter((item) => item.id !== target.id)]);
        if (target.currentVersion) {
          setVersions((current) => [
            target.currentVersion!,
            ...current.filter((item) => item.id !== target.currentVersion!.id),
          ]);
        }
      }
      const archived = await callWorker('document.archive', {
        documentId: target.id,
        expectedDocumentRowVersion: target.rowVersion,
      });
      documentRequest.current += 1;
      closeDetachedPanel(document.id);
      syncDetachedPanel();
      setDocument(undefined);
      setDocumentTitle('');
      setDocumentKind('note');
      setDocumentContent('');
      setDocumentBindings(undefined);
      setDocumentSampleText('');
      setVersions([]);
      setDocumentArchiveConfirmation(false);
      setDocumentArchiveTarget(undefined);
      closeDocumentPanel();
      setDocuments((current) => current.filter((item) => item.id !== archived.id));
      setArchivedDocuments((current) => [
        archived,
        ...current.filter((item) => item.id !== archived.id),
      ]);
      setContentMessage(`已归档“${archived.title}”，可在已归档文档中恢复。`);
      try {
        const [activeRows, archivedRows] = await Promise.all([
          callWorker('document.list', {}),
          callWorker('document.archived.list', {}),
        ]);
        setDocuments(activeRows);
        setArchivedDocuments(archivedRows);
      } catch {
        // Keep the optimistic list update after a successful lifecycle change.
      }
      return archived;
    } catch (reason) {
      if (target !== document) {
        setDocument(target);
        setDocuments((current) => [target, ...current.filter((item) => item.id !== target.id)]);
      }
      setContentMessage(reason instanceof Error ? reason.message : '归档失败');
      return undefined;
    } finally {
      setContentBusy(false);
    }
  };
  const applyArchivedDocuments = async (archived: DocumentSummary[]) => {
    const ids = new Set(archived.map((item) => item.id));
    documentRequest.current += 1;
    for (const id of ids) closeDetachedPanel(id);
    setDocuments((rows) => rows.filter((item) => !ids.has(item.id)));
    setArchivedDocuments((rows) => [...archived, ...rows.filter((item) => !ids.has(item.id))]);
    if (document && ids.has(document.id)) {
      syncDetachedPanel();
      setDocument(undefined);
      setDocumentTitle('');
      setDocumentKind('note');
      setDocumentContent('');
      setDocumentBindings(undefined);
      setDocumentSampleText('');
      setVersions([]);
      closeDocumentPanel();
    }
    const [activeRows, archivedRows] = await Promise.all([
      callWorker('document.list', {}),
      callWorker('document.archived.list', {}),
    ]);
    setDocuments(activeRows);
    setArchivedDocuments(archivedRows);
  };
  const restoreArchivedDocument = async (
    archivedDocument: DocumentSummary,
  ): Promise<DocumentDetail | undefined> => {
    if (!writable || contentBusy) return undefined;
    setContentBusy(true);
    setContentMessage('');
    try {
      const restored = await callWorker('document.unarchive', {
        documentId: archivedDocument.id,
        expectedDocumentRowVersion: archivedDocument.rowVersion,
      });
      setDocuments((current) => [restored, ...current.filter((item) => item.id !== restored.id)]);
      setArchivedDocuments((current) => current.filter((item) => item.id !== restored.id));
      setDocument(restored);
      setDocumentTitle(restored.title);
      setDocumentKind(restored.kind);
      setDocumentContent(restored.currentVersion?.contentMarkdown ?? '');
      setDocumentBindings(restored.currentVersion?.bindings ?? undefined);
      setDocumentSampleText(restored.currentVersion?.sampleText ?? '');
      setVersions(await callWorker('document.versions', { documentId: restored.id }));
      syncDetachedPanel(restored.id);
      openDocumentWorkspace(restored.kind);
      setContentMessage(`已恢复“${restored.title}”`);
      try {
        const [activeRows, archivedRows] = await Promise.all([
          callWorker('document.list', {}),
          callWorker('document.archived.list', {}),
        ]);
        setDocuments(activeRows);
        setArchivedDocuments(archivedRows);
      } catch {
        // Keep the optimistic list update after a successful lifecycle change.
      }
      return restored;
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '恢复失败');
      return undefined;
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
  const unpublishDocument = async () => {
    if (!document?.publishedVersionId) return;
    setContentBusy(true);
    setContentMessage('');
    try {
      const next = await callWorker('document.unpublish', {
        documentId: document.id,
        expectedDocumentRowVersion: document.rowVersion,
      });
      setDocument(next);
      setDocumentTitle(next.title);
      setDocumentKind(next.kind);
      setDocumentContent(next.currentVersion?.contentMarkdown ?? '');
      setDocumentBindings(next.currentVersion?.bindings ?? undefined);
      setDocumentSampleText(next.currentVersion?.sampleText ?? '');
      setDocuments(await callWorker('document.list', {}));
      setVersions(await callWorker('document.versions', { documentId: next.id }));
      setContentMessage('已取消发布，文档已恢复为草稿，可继续编辑。');
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '取消发布失败');
    } finally {
      setContentBusy(false);
    }
  };
  /**
   * Saves the editor content and publishes it in one user action. The Worker
   * still creates and approves a review record inside a single transaction, so
   * the audit trail and conflict checks are identical to the manual
   * save/submit/publish sequence; only the extra clicks disappear.
   */
  const saveAndPublishDocument = async () => {
    if (!documentEditorWritable) {
      setContentMessage(
        document?.publishedVersionId
          ? '已发布文档只读，请先取消发布。'
          : '审核中的版本不可编辑，请先退回修改。',
      );
      return;
    }
    if (!documentTitle.trim()) {
      setContentMessage('发布前请填写文档标题。');
      return;
    }
    setContentBusy(true);
    setContentMessage('');
    try {
      await characterVoicePrompt.save();
      const saved = await callWorker('document.draft.save', {
        documentId: document?.id,
        kind: documentKind,
        title: documentTitle,
        contentMarkdown: documentContent,
        bindings: documentBindings,
        ...(documentKind === 'voice' ? { sampleText: documentSampleText } : {}),
        expectedDocumentRowVersion: document?.rowVersion,
      });
      const result = await callWorker('document.selfPublish', {
        documentId: saved.id,
        documentVersionId: saved.currentVersionId,
        expectedDocumentRowVersion: saved.rowVersion,
        expectedPublishedVersionId: saved.publishedVersionId,
      });
      setDocument(result.document);
      setDocuments(await callWorker('document.list', {}));
      setVersions(await callWorker('document.versions', { documentId: saved.id }));
      setContentMessage(`已发布权威版本 v${result.publication.publicationNo}`);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '发布失败，请检查版本冲突';
      setContentMessage(message);
      // A conflict leaves the saved draft in place; resync so the editor shows
      // the persisted row version instead of a stale one.
      if (document?.id) {
        try {
          const next = await callWorker('document.get', { documentId: document.id });
          setDocument(next);
          setDocuments(await callWorker('document.list', {}));
          setVersions(await callWorker('document.versions', { documentId: document.id }));
        } catch {
          // Keep the original failure message when the resync also fails.
        }
      }
    } finally {
      setContentBusy(false);
    }
  };
  const restoreVersion = async (versionId: string) => {
    if (!document || !documentEditorWritable) return;
    if (characterVoicePrompt.dirty) {
      setContentMessage('请先保存音色提示词，或关闭页面并放弃修改，再恢复版本。');
      return;
    }
    setContentBusy(true);
    try {
      const restored = await callWorker('document.restore', {
        documentId: document.id,
        versionId,
      });
      setDocument(restored);
      setDocumentContent(restored.currentVersion?.contentMarkdown ?? '');
      setDocumentBindings(restored.currentVersion?.bindings ?? undefined);
      setDocumentSampleText(restored.currentVersion?.sampleText ?? '');
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
    characterVoicePrompt.reset();
    if (document) {
      setDocumentTitle(document.title);
      setDocumentKind(document.kind);
      setDocumentContent(document.currentVersion?.contentMarkdown ?? '');
      setDocumentBindings(document.currentVersion?.bindings ?? undefined);
      setDocumentSampleText(document.currentVersion?.sampleText ?? '');
    } else {
      setDocumentTitle('');
      setDocumentKind('note');
      setDocumentContent('');
      setDocumentBindings(undefined);
      setDocumentSampleText('');
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
    setDocumentBindings(nextDocument.currentVersion?.bindings ?? undefined);
    setDocumentSampleText(nextDocument.currentVersion?.sampleText ?? '');
    setVersions(history);
  };
  const reset = () => {
    characterVoicePrompt.reset();
    documentRequest.current += 1;
    setDocuments([]);
    setArchivedDocuments([]);
    setDocument(undefined);
    setDocumentTitle('');
    setDocumentKind('note');
    setDocumentContent('');
    setDocumentBindings(undefined);
    setDocumentSampleText('');
    setVersions([]);
    setContentBusy(false);
    setContentMessage('');
    setDocumentCloseConfirmation(false);
    setDocumentArchiveConfirmation(false);
    setDocumentArchiveTarget(undefined);
  };
  return {
    documents,
    setDocuments,
    refreshCommittedDocuments,
    archivedDocuments,
    setArchivedDocuments,
    document,
    setDocument,
    documentTitle,
    setDocumentTitle,
    documentKind,
    setDocumentKind,
    documentContent,
    setDocumentContent,
    documentBindings,
    documentSampleText,
    setDocumentSampleText,
    setDocumentBindings,
    versions,
    setVersions,
    contentBusy,
    setContentBusy,
    contentMessage,
    setContentMessage,
    documentCloseConfirmation,
    setDocumentCloseConfirmation,
    documentArchiveConfirmation,
    setDocumentArchiveConfirmation,
    documentArchiveTarget,
    setDocumentArchiveTarget,
    documentDirty,
    characterVoicePrompt,
    documentEditorWritable,
    selectDocument,
    openDocumentById,
    newDocument,
    importMarkdownDocument,
    saveDocument,
    requestArchiveDocument,
    confirmArchiveDocument,
    applyArchivedDocuments,
    restoreArchivedDocument,
    requestDocumentChanges,
    publishDocument,
    unpublishDocument,
    saveAndPublishDocument,
    restoreVersion,
    openCreatedDocument,
    requestCloseDocument,
    discardDocumentChanges,
    saveAndCloseDocument,
    syncMainDocumentIfSelected,
    reset,
  };
}
