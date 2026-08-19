import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetail, NovelChapterInfo, WorkerMethod } from '@ai-video/contracts';
import { NovelWorkspace } from './NovelWorkspace';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));

const chapter: NovelChapterInfo = {
  id: 'chapter-1',
  projectId: 'project-1',
  documentId: 'document-1',
  title: 'Opening',
  position: 0,
  displayLabel: 'Chapter 1',
  lifecycleStatus: 'active',
  documentRowVersion: 0,
  rowVersion: 0,
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
};

const documentDetail = (content = 'Draft'): DocumentDetail => ({
  id: 'document-1',
  projectId: 'project-1',
  kind: 'note',
  title: 'Opening',
  scopeType: 'project',
  lifecycleStatus: 'active',
  rowVersion: 0,
  currentVersionId: 'version-1',
  publishedVersionId: undefined,
  currentVersion: {
    id: 'version-1',
    documentId: 'document-1',
    version: 1,
    state: 'draft',
    titleSnapshot: 'Opening',
    contentMarkdown: content,
    sourceTaskId: undefined,
    createdAt: '2026-08-19T00:00:00.000Z',
    authorType: 'user',
  },
  createdAt: '2026-08-19T00:00:00.000Z',
  updatedAt: '2026-08-19T00:00:00.000Z',
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function mockWorker(handler: (method: WorkerMethod) => unknown): void {
  vi.mocked(callWorker).mockImplementation(
    (method) => Promise.resolve(handler(method)) as ReturnType<typeof callWorker>,
  );
}

describe('NovelWorkspace', () => {
  it('loads the chapter tree, opens a chapter, and saves a user draft with CAS', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'document.draft.save') return documentDetail('Updated');
      if (method === 'novel.export.prepare')
        return { status: 'succeeded', packagePath: 'exports/novel' };
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    expect(await screen.findByText(/Chapter 1 Opening/)).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText('Chapter content'), {
      target: { value: 'Updated' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'document.draft.save',
        expect.objectContaining({
          documentId: 'document-1',
          contentMarkdown: 'Updated',
          expectedDocumentRowVersion: 0,
          authorType: 'user',
        }),
      ),
    );
  });

  it('exports the immutable work package through Worker', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.export.prepare')
        return { status: 'succeeded', packagePath: 'exports/novel' };
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByRole('button', { name: /Export Markdown/i }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.export.prepare', {
        exportType: 'work',
        exportFormat: 'files',
      }),
    );
  });

  it('opens a chapter in the shared document workspace for detached-window reuse', async () => {
    const onOpenDocument = vi.fn();
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable onOpenDocument={onOpenDocument} />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByRole('button', { name: /Open in document workspace/i }));
    expect(onOpenDocument).toHaveBeenCalledWith('document-1');
  });

  it('publishes a chapter through one atomic self-publish command', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'document.selfPublish') {
        const next = documentDetail();
        next.currentVersion!.state = 'published';
        next.publishedVersionId = next.currentVersion!.id;
        next.rowVersion = 1;
        return { document: next, publication: { id: 'publication-1' } };
      }
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByRole('button', { name: /^Publish$/i }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('document.selfPublish', {
        documentId: 'document-1',
        documentVersionId: 'version-1',
        expectedDocumentRowVersion: 0,
        expectedPublishedVersionId: undefined,
      }),
    );
  });

  it('shows the read-only continuity report from Worker', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.context.consistencyReport') {
        return {
          projectId: 'project-1',
          generatedAt: '2026-08-19T00:00:00.000Z',
          chapterCount: 1,
          currentSummaryCount: 0,
          staleSummaryCount: 0,
          issues: [
            {
              code: 'missing-published-version',
              severity: 'warning',
              chapterId: 'chapter-1',
              message: 'Chapter 1 has no published version.',
            },
          ],
        };
      }
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByRole('button', { name: /Check novel continuity/i }));
    expect(await screen.findByText('Chapter 1 has no published version.')).toBeInTheDocument();
    expect(callWorker).toHaveBeenCalledWith('novel.context.consistencyReport', {});
  });

  it('refreshes the latest document after a CAS conflict without discarding local edits', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail('Server version');
      if (method === 'document.draft.save') throw new Error('DOCUMENT_ROW_VERSION_CONFLICT');
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.change(await screen.findByLabelText('Chapter content'), {
      target: { value: 'Local edits' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }));
    await waitFor(() => expect(screen.getByText(/Server version loaded/)).toBeInTheDocument());
    expect(screen.getByDisplayValue('Local edits')).toBeInTheDocument();
    expect(callWorker).toHaveBeenCalledWith('document.get', { documentId: 'document-1' });
  });

  it('offers explicit server-version and local-edit conflict actions', async () => {
    let saveAttempt = 0;
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get')
        return documentDetail(saveAttempt ? 'Server version' : 'Draft');
      if (method === 'document.draft.save') {
        saveAttempt += 1;
        throw new Error('DOCUMENT_ROW_VERSION_CONFLICT');
      }
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.change(await screen.findByLabelText('Chapter content'), {
      target: { value: 'Local edits' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Use server version/i }));
    expect(screen.getByDisplayValue('Server version')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Chapter content'), {
      target: { value: 'Local edits again' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Save draft/i }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /Keep local edits/i }));
    expect(screen.getByDisplayValue('Local edits again')).toBeInTheDocument();
  });
});
