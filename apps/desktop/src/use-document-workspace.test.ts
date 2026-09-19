import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetail } from '@ai-video/contracts';
import { useDocumentWorkspace } from './use-document-workspace';
import { callWorker } from './worker-client';

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
});
