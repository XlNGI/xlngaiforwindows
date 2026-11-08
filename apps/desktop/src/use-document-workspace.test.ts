import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetail } from '@ai-video/contracts';
import { useDocumentWorkspace } from './use-document-workspace';
import { callWorker } from './worker-client';
import { selectWorkerScope } from './worker-scope';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./markdown-import-client', () => ({ readMarkdownDocument: vi.fn() }));

const savedDocument: DocumentDetail = {
  id: 'd-outline',
  projectId: 'project',
  kind: 'outline',
  title: 'Draft',
  scopeType: 'project',
  lifecycleStatus: 'active',
  rowVersion: 1,
  currentVersionId: 'v-1',
  createdAt: 'now',
  updatedAt: 'now',
  currentVersion: {
    id: 'v-1',
    documentId: 'd-outline',
    version: 1,
    contentMarkdown: '# draft',
    state: 'draft',
    authorType: 'user',
    createdAt: 'now',
  },
};

describe('useDocumentWorkspace close', () => {
  const closeDocumentPanel = vi.fn();
  const openDocumentWorkspace = vi.fn();
  const syncDetachedPanel = vi.fn();

  beforeEach(() => {
    selectWorkerScope(undefined);
    closeDocumentPanel.mockReset();
    openDocumentWorkspace.mockReset();
    syncDetachedPanel.mockReset();
    vi.mocked(callWorker).mockReset();
  });

  const renderWorkspace = () =>
    renderHook(() =>
      useDocumentWorkspace({
        writable: true,
        syncDetachedPanel,
        openDocumentWorkspace,
        closeDocumentPanel,
      }),
    );

  it('refreshes a running save without opening a panel or replacing dirty content/CAS', async () => {
    selectWorkerScope({ projectId: 'project', projectSessionId: 'session' });
    vi.mocked(callWorker).mockImplementation((method) =>
      Promise.resolve(
        (method === 'document.get'
          ? { ...savedDocument, rowVersion: 2, title: 'Updated' }
          : method === 'document.list'
            ? [savedDocument]
            : []) as never,
      ),
    );
    const { result } = renderWorkspace();
    act(() => {
      result.current.setDocument(savedDocument);
      result.current.setDocumentTitle(savedDocument.title);
      result.current.setDocumentKind(savedDocument.kind);
      result.current.setDocumentContent('# local edit');
    });
    await act(async () => {
      await result.current.refreshCommittedDocuments();
    });
    expect(result.current.documents).toHaveLength(1);
    expect(result.current.documentContent).toBe('# local edit');
    expect(result.current.document?.rowVersion).toBe(1);
    expect(openDocumentWorkspace).not.toHaveBeenCalled();
    act(() => result.current.setDocumentContent('# draft'));
    await act(async () => {
      await result.current.refreshCommittedDocuments();
    });
    expect(result.current.document?.rowVersion).toBe(2);
    expect(result.current.documentTitle).toBe('Updated');
  });

  it('closes a clean editor without confirmation', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.requestCloseDocument();
    });

    expect(closeDocumentPanel).toHaveBeenCalledOnce();
    expect(result.current.documentCloseConfirmation).toBe(false);
  });

  it('asks before discarding untitled content', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.setDocumentContent('# draft');
    });
    act(() => {
      result.current.requestCloseDocument();
    });

    expect(closeDocumentPanel).not.toHaveBeenCalled();
    expect(result.current.documentCloseConfirmation).toBe(true);
  });

  it('asks before discarding edits to an existing document', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.setDocument(savedDocument);
      result.current.setDocumentTitle(savedDocument.title);
      result.current.setDocumentKind(savedDocument.kind);
      result.current.setDocumentContent(savedDocument.currentVersion?.contentMarkdown ?? '');
    });
    act(() => {
      result.current.setDocumentTitle('Edited title');
    });
    act(() => {
      result.current.requestCloseDocument();
    });

    expect(closeDocumentPanel).not.toHaveBeenCalled();
    expect(result.current.documentCloseConfirmation).toBe(true);
  });

  it('discards dirty changes and closes the panel', () => {
    const { result } = renderWorkspace();

    act(() => {
      result.current.setDocumentTitle('Draft');
      result.current.setDocumentContent('# draft');
    });
    act(() => {
      result.current.requestCloseDocument();
    });
    act(() => {
      result.current.discardDocumentChanges();
    });

    expect(result.current.documentTitle).toBe('');
    expect(result.current.documentContent).toBe('');
    expect(result.current.documentCloseConfirmation).toBe(false);
    expect(closeDocumentPanel).toHaveBeenCalledOnce();
  });

  it('saves dirty changes and then closes the panel', async () => {
    vi.mocked(callWorker).mockImplementation((method: string) => {
      if (method === 'document.draft.save') return Promise.resolve(savedDocument);
      if (method === 'document.list') return Promise.resolve([savedDocument]);
      if (method === 'document.versions')
        return Promise.resolve(savedDocument.currentVersion ? [savedDocument.currentVersion] : []);
      throw new Error(`Unexpected method ${method}`);
    });
    const { result } = renderWorkspace();

    act(() => {
      result.current.setDocumentTitle('Draft');
      result.current.setDocumentContent('# draft');
    });

    await act(async () => {
      await result.current.saveAndCloseDocument();
    });

    expect(callWorker).toHaveBeenCalledWith(
      'document.draft.save',
      expect.objectContaining({
        title: 'Draft',
        contentMarkdown: '# draft',
      }),
    );
    expect(result.current.documentCloseConfirmation).toBe(false);
    expect(closeDocumentPanel).toHaveBeenCalledOnce();
  });

  it('keeps the panel open when save-and-close fails', async () => {
    vi.mocked(callWorker).mockRejectedValue(new Error('保存失败'));
    const { result } = renderWorkspace();

    act(() => {
      result.current.setDocumentTitle('Draft');
      result.current.setDocumentContent('# draft');
      result.current.setDocumentCloseConfirmation(true);
    });

    await act(async () => {
      await result.current.saveAndCloseDocument();
    });

    expect(result.current.documentCloseConfirmation).toBe(true);
    expect(closeDocumentPanel).not.toHaveBeenCalled();
    expect(result.current.contentMessage).toBe('保存失败');
  });

  it('discards local edits and archives the last saved document version', async () => {
    const archivedDocument = {
      ...savedDocument,
      lifecycleStatus: 'archived' as const,
      rowVersion: savedDocument.rowVersion + 1,
    };
    vi.mocked(callWorker).mockImplementation((method: string) => {
      if (method === 'document.archive') return Promise.resolve(archivedDocument);
      if (method === 'document.list') return Promise.resolve([]);
      if (method === 'document.archived.list') return Promise.resolve([archivedDocument]);
      throw new Error(`Unexpected method ${method}`);
    });
    const { result } = renderWorkspace();

    act(() => {
      result.current.setDocument(savedDocument);
      result.current.setDocumentTitle(savedDocument.title);
      result.current.setDocumentKind(savedDocument.kind);
      result.current.setDocumentContent('Unsaved edits');
    });
    act(() => {
      result.current.requestArchiveDocument();
    });
    await act(async () => {
      await result.current.confirmArchiveDocument(false);
    });

    expect(callWorker).toHaveBeenCalledWith('document.archive', {
      documentId: savedDocument.id,
      expectedDocumentRowVersion: savedDocument.rowVersion,
    });
    expect(callWorker).not.toHaveBeenCalledWith('document.draft.save', expect.anything());
    expect(result.current.document).toBeUndefined();
    expect(result.current.archivedDocuments).toEqual([archivedDocument]);
    expect(result.current.documentArchiveConfirmation).toBe(false);
  });

  it('archives a non-selected directory item without replacing the open document', async () => {
    const currentDocument: DocumentDetail = {
      ...savedDocument,
      id: 'current-document',
      title: 'Current document',
    };
    const directoryTarget = {
      ...savedDocument,
      id: 'directory-target',
      title: 'Directory target',
      rowVersion: savedDocument.rowVersion + 3,
    };
    const archivedDocument = {
      ...directoryTarget,
      lifecycleStatus: 'archived' as const,
      rowVersion: directoryTarget.rowVersion + 1,
    };
    vi.mocked(callWorker).mockImplementation((method: string) => {
      if (method === 'document.archive') return Promise.resolve(archivedDocument);
      if (method === 'document.list') return Promise.resolve([currentDocument]);
      if (method === 'document.archived.list') return Promise.resolve([archivedDocument]);
      throw new Error(`Unexpected method ${method}`);
    });
    const { result } = renderWorkspace();

    act(() => {
      result.current.setDocument(currentDocument);
      result.current.setDocumentTitle(currentDocument.title);
      result.current.setDocumentKind(currentDocument.kind);
      result.current.setDocumentContent('Unsaved edits on current document');
      result.current.setDocuments([currentDocument, directoryTarget]);
      result.current.requestArchiveDocument(directoryTarget);
    });
    await act(async () => {
      await result.current.confirmArchiveDocument(false);
    });

    expect(callWorker).toHaveBeenCalledWith('document.archive', {
      documentId: directoryTarget.id,
      expectedDocumentRowVersion: directoryTarget.rowVersion,
    });
    expect(result.current.document).toEqual(currentDocument);
    expect(result.current.documentContent).toBe('Unsaved edits on current document');
    expect(result.current.documents).toEqual([currentDocument]);
    expect(result.current.archivedDocuments).toEqual([archivedDocument]);
    expect(result.current.documentArchiveConfirmation).toBe(false);
  });

  it('keeps a successful save in the editor when the following archive fails', async () => {
    const editedDocument: DocumentDetail = {
      ...savedDocument,
      title: 'Edited title',
      rowVersion: savedDocument.rowVersion + 1,
      currentVersion: {
        ...savedDocument.currentVersion!,
        id: 'v-2',
        version: 2,
        contentMarkdown: '# edited',
      },
    };
    vi.mocked(callWorker).mockImplementation((method: string) => {
      if (method === 'document.draft.save') return Promise.resolve(editedDocument);
      if (method === 'document.archive') return Promise.reject(new Error('文档版本已变化'));
      throw new Error(`Unexpected method ${method}`);
    });
    const { result } = renderWorkspace();

    act(() => {
      result.current.setDocument(savedDocument);
      result.current.setDocumentTitle(editedDocument.title);
      result.current.setDocumentKind(editedDocument.kind);
      result.current.setDocumentContent(editedDocument.currentVersion!.contentMarkdown);
    });
    act(() => {
      result.current.requestArchiveDocument();
    });
    await act(async () => {
      await result.current.confirmArchiveDocument(true);
    });

    expect(callWorker).toHaveBeenCalledWith(
      'document.draft.save',
      expect.objectContaining({ expectedDocumentRowVersion: savedDocument.rowVersion }),
    );
    expect(callWorker).toHaveBeenCalledWith('document.archive', {
      documentId: editedDocument.id,
      expectedDocumentRowVersion: editedDocument.rowVersion,
    });
    expect(result.current.document).toEqual(editedDocument);
    expect(result.current.documentDirty).toBe(false);
    expect(result.current.versions[0]).toEqual(editedDocument.currentVersion);
    expect(result.current.documentArchiveConfirmation).toBe(true);
    expect(result.current.contentMessage).toBe('文档版本已变化');
  });

  it('restores an archived document into the active directory and editor', async () => {
    const archivedSummary = {
      ...savedDocument,
      lifecycleStatus: 'archived' as const,
      rowVersion: savedDocument.rowVersion + 1,
    };
    vi.mocked(callWorker).mockImplementation((method: string) => {
      if (method === 'document.unarchive') return Promise.resolve(savedDocument);
      if (method === 'document.versions')
        return Promise.resolve(savedDocument.currentVersion ? [savedDocument.currentVersion] : []);
      if (method === 'document.list') return Promise.resolve([savedDocument]);
      if (method === 'document.archived.list') return Promise.resolve([]);
      throw new Error(`Unexpected method ${method}`);
    });
    const { result } = renderWorkspace();

    let restored: DocumentDetail | undefined;
    await act(async () => {
      restored = await result.current.restoreArchivedDocument(archivedSummary);
    });

    expect(restored).toEqual(savedDocument);
    expect(callWorker).toHaveBeenCalledWith('document.unarchive', {
      documentId: savedDocument.id,
      expectedDocumentRowVersion: archivedSummary.rowVersion,
    });
    expect(result.current.documents).toEqual([savedDocument]);
    expect(result.current.archivedDocuments).toEqual([]);
    expect(result.current.document).toEqual(savedDocument);
    expect(openDocumentWorkspace).toHaveBeenCalledWith(savedDocument.kind);
  });

  it('applies batch deletion to the open editor and preserves successful deletion if refresh fails', async () => {
    vi.mocked(callWorker).mockRejectedValue(new Error('刷新失败'));
    const { result } = renderWorkspace();
    act(() => {
      result.current.setDocument(savedDocument);
      result.current.setDocumentTitle('未保存标题');
      result.current.setDocumentContent('未保存正文');
      result.current.setDocuments([savedDocument]);
    });
    const archived = { ...savedDocument, lifecycleStatus: 'archived' as const, rowVersion: 2 };
    await act(async () => {
      await expect(result.current.applyArchivedDocuments([archived])).rejects.toThrow('刷新失败');
    });
    expect(result.current.documents).toEqual([]);
    expect(result.current.archivedDocuments).toEqual([archived]);
    expect(result.current.document).toBeUndefined();
    expect(result.current.documentContent).toBe('');
    expect(closeDocumentPanel).toHaveBeenCalledOnce();
  });
});

it('keeps delayed save, follow-up reads and finally bound to the original project after a view switch', async () => {
  selectWorkerScope({ projectId: 'A', projectSessionId: 'A-epoch' });
  let finish!: (value: DocumentDetail) => void;
  const saving = new Promise<DocumentDetail>((resolve) => {
    finish = resolve;
  });
  vi.mocked(callWorker).mockImplementation((method: string) =>
    method === 'document.draft.save' ? saving : Promise.resolve([]),
  );
  const closed = vi.fn();
  const { result, rerender } = renderHook(() =>
    useDocumentWorkspace({
      writable: true,
      syncDetachedPanel: vi.fn(),
      openDocumentWorkspace: vi.fn(),
      closeDocumentPanel: closed,
    }),
  );
  act(() => {
    result.current.setDocumentTitle('A draft');
    result.current.setDocumentContent('A text');
  });
  let done!: Promise<void>;
  act(() => {
    done = result.current.saveAndCloseDocument();
  });
  selectWorkerScope({ projectId: 'B', projectSessionId: 'B-epoch' });
  rerender();
  act(() => {
    result.current.setDocumentTitle('B draft');
    result.current.setContentBusy(true);
  });
  await act(async () => {
    finish(savedDocument);
    await done;
  });
  expect(result.current.documentTitle).toBe('B draft');
  expect(result.current.contentBusy).toBe(true);
  expect(closed).not.toHaveBeenCalled();
  expect(callWorker).toHaveBeenCalledWith(
    'document.list',
    {},
    { projectId: 'A', projectSessionId: 'A-epoch' },
  );
  selectWorkerScope(undefined);
});
