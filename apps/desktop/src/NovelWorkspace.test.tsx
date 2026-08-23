import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetail, NovelChapterInfo, WorkerMethod } from '@ai-video/contracts';
import { NovelWorkspace } from './NovelWorkspace';
import { callWorker } from './worker-client';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readMarkdownDocument } from './markdown-import-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./markdown-import-client', () => ({ readMarkdownDocument: vi.fn() }));

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

function mockWorker(handler: (method: WorkerMethod, params?: unknown) => unknown): void {
  vi.mocked(callWorker).mockImplementation(
    (method, params) => Promise.resolve(handler(method, params)) as ReturnType<typeof callWorker>,
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
    fireEvent.change(await screen.findByLabelText('章节内容'), {
      target: { value: 'Updated' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存草稿/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.export.prepare', {
        exportType: 'work',
        exportFormat: 'files',
      }),
    );
  });

  it('previews selected Markdown chapters and imports them through Worker', async () => {
    const importedChapter = { ...chapter, id: 'chapter-imported', documentId: 'document-imported' };
    vi.mocked(openDialog).mockResolvedValue(['D:\\Novels\\part-1.md', 'D:\\Novels\\part-2.md']);
    vi.mocked(readMarkdownDocument).mockImplementation((path) =>
      Promise.resolve({
        title: path.endsWith('part-1.md') ? '第一卷' : '第二卷',
        contentMarkdown: path.endsWith('part-1.md')
          ? '# 第一章\n\n雨落在雾港。'
          : '# 第二章\n\n灯塔亮起。',
      }),
    );
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [importedChapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.import') {
        return { volume: undefined, chapters: [importedChapter], importedCount: 2 };
      }
      return {};
    });

    render(<NovelWorkspace projectId="project-1" writable />);
    fireEvent.click(screen.getByRole('button', { name: /导入小说/i }));
    expect(await screen.findByText(/导入预览（2 章）/)).toBeInTheDocument();
    expect(screen.getByText('第一章')).toBeInTheDocument();
    expect(screen.getByText('第二章')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('导入卷名'), { target: { value: '第一卷' } });
    fireEvent.click(screen.getByRole('button', { name: '仅导入草稿' }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.import', {
        volumeTitle: '第一卷',
        chapters: [
          { title: '第一章', displayLabel: '第 1 章', contentMarkdown: '雨落在雾港。' },
          { title: '第二章', displayLabel: '第 2 章', contentMarkdown: '灯塔亮起。' },
        ],
      }),
    );
    expect(await screen.findByText('已导入 2 个章节，当前为草稿。')).toBeInTheDocument();
    expect(readMarkdownDocument).toHaveBeenCalledTimes(2);
  });

  it('publishes every active draft with the batch publish action', async () => {
    const secondChapter = {
      ...chapter,
      id: 'chapter-2',
      documentId: 'document-2',
      title: 'Second',
      displayLabel: 'Chapter 2',
      position: 1,
    };
    const details = new Map([
      ['document-1', documentDetail()],
      ['document-2', { ...documentDetail(), id: 'document-2', title: 'Second' }],
    ]);
    mockWorker((method, params) => {
      if (method === 'novel.chapter.list') return [chapter, secondChapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get')
        return details.get((params as { documentId: string }).documentId);
      if (method === 'document.selfPublish') {
        const input = params as { documentId: string };
        const next = details.get(input.documentId)!;
        next.currentVersion!.state = 'published';
        next.publishedVersionId = next.currentVersion!.id;
        next.rowVersion = 1;
        return { document: next, publication: { id: `publication-${input.documentId}` } };
      }
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByRole('button', { name: '全部发布' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'document.selfPublish',
        expect.objectContaining({ documentId: 'document-2' }),
      ),
    );
    expect(await screen.findByText('已批量发布 2 个章节。')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /在文档工作区打开/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /^发布$/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /检查小说连续性/ }));
    expect(await screen.findByText('当前章节没有已发布版本。')).toBeInTheDocument();
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
    fireEvent.change(await screen.findByLabelText('章节内容'), {
      target: { value: 'Local edits' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存草稿/ }));
    await waitFor(() => expect(screen.getByText(/已载入服务器版本/)).toBeInTheDocument());
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
    fireEvent.change(await screen.findByLabelText('章节内容'), {
      target: { value: 'Local edits' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存草稿/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /使用服务器版本/ }));
    expect(screen.getByDisplayValue('Server version')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('章节内容'), {
      target: { value: 'Local edits again' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存草稿/ }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /保留本地修改/ }));
    expect(screen.getByDisplayValue('Local edits again')).toBeInTheDocument();
  });
});
