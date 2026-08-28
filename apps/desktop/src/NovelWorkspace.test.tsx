import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentDetail, NovelChapterInfo, WorkerMethod } from '@ai-video/contracts';
import { NovelWorkspace } from './NovelWorkspace';
import { callWorker } from './worker-client';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { readNovelDocument } from './novel-import-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('./novel-import-client', () => ({ readNovelDocument: vi.fn() }));

const chapter: NovelChapterInfo = {
  id: 'chapter-1',
  projectId: 'project-1',
  documentId: 'document-1',
  title: 'Opening',
  position: 0,
  displayLabel: 'Chapter 1',
  lifecycleStatus: 'active',
  documentRowVersion: 0,
  ragChunkCount: 1,
  ragIndexedAt: '2026-08-19T00:00:00.000Z',
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
    fireEvent.click(screen.getByRole('button', { name: /保存并切片/ }));
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

  it('selects chapters and emits the selected chapter IDs for episode generation', async () => {
    const chapter2 = {
      ...chapter,
      id: 'chapter-2',
      documentId: 'document-2',
      title: 'Storm',
      position: 1,
      displayLabel: 'Chapter 2',
    };
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter, chapter2];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      return {};
    });
    const onGenerateEpisode = vi.fn();
    render(<NovelWorkspace projectId="project-1" writable onGenerateEpisode={onGenerateEpisode} />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByLabelText('选择 Chapter 1 Opening'));
    fireEvent.click(screen.getByLabelText('选择 Chapter 2 Storm'));
    fireEvent.click(screen.getByRole('button', { name: /生成短剧内容/ }));
    expect(onGenerateEpisode).toHaveBeenCalledWith(['chapter-1', 'chapter-2']);
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
    const secondImportedChapter = {
      ...chapter,
      id: 'chapter-imported-2',
      documentId: 'document-imported-2',
      title: '第二章',
      position: 1,
    };
    vi.mocked(openDialog).mockResolvedValue(['D:\\Novels\\part-1.md', 'D:\\Novels\\part-2.md']);
    vi.mocked(readNovelDocument).mockImplementation((path) =>
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
        return {
          volume: undefined,
          chapters: [importedChapter, secondImportedChapter],
          importedCount: 2,
        };
      }
      return {};
    });

    render(<NovelWorkspace projectId="project-1" writable />);
    fireEvent.click(screen.getByRole('button', { name: /导入小说/i }));
    expect(await screen.findByText(/导入预览（2 章）/)).toBeInTheDocument();
    expect(screen.getByText('第一章')).toBeInTheDocument();
    expect(screen.getByText('第二章')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('导入卷名'), { target: { value: '第一卷' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿并切片' }));

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.import', {
        volumeTitle: '第一卷',
        chapters: [
          { title: '第一章', displayLabel: '第 1 章', contentMarkdown: '雨落在雾港。' },
          { title: '第二章', displayLabel: '第 2 章', contentMarkdown: '灯塔亮起。' },
        ],
      }),
    );
    expect(await screen.findByText('已保存 2 个草稿，并生成 2 个 RAG 切片。')).toBeInTheDocument();
    expect(readNovelDocument).toHaveBeenCalledTimes(2);
  });

  it('previews plain-text TXT chapter markers and splits them into chapters', async () => {
    vi.mocked(openDialog).mockResolvedValue(['D:\\Novels\\雾港纪事.txt']);
    vi.mocked(readNovelDocument).mockResolvedValue({
      title: '雾港纪事',
      contentMarkdown: '第一章 雨夜\n\n故事从雨夜开始。\n\n第二章 灯塔\n\n灯塔在雾中亮起。',
    });
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [];
      if (method === 'novel.volume.list') return [];
      return {};
    });

    render(<NovelWorkspace projectId="project-1" writable />);
    fireEvent.click(screen.getByRole('button', { name: /导入小说/i }));
    expect(await screen.findByText(/导入预览（2 章）/)).toBeInTheDocument();
    expect(screen.getByText('第一章 雨夜')).toBeInTheDocument();
    expect(screen.getByText('第二章 灯塔')).toBeInTheDocument();
  });

  it('previews an EPUB source and imports it as Markdown chapters', async () => {
    vi.mocked(openDialog).mockResolvedValue(['D:\\Novels\\雾港纪事.epub']);
    vi.mocked(readNovelDocument).mockResolvedValue({
      title: '雾港纪事',
      contentMarkdown: '# 第一章\n\n雨落在雾港。\n\n# 第二章\n\n灯塔亮起。',
    });
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [];
      if (method === 'novel.volume.list') return [];
      return {};
    });

    render(<NovelWorkspace projectId="project-1" writable />);
    fireEvent.click(screen.getByRole('button', { name: /导入小说/i }));
    expect(await screen.findByText(/导入预览（2 章）/)).toBeInTheDocument();
    expect(screen.getByText('第一章')).toBeInTheDocument();
    expect(screen.getByText('第二章')).toBeInTheDocument();
  });

  it('creates a new editable draft through the Worker', async () => {
    const createdChapter = {
      ...chapter,
      id: 'chapter-2',
      documentId: 'document-2',
      title: '未命名草稿',
      displayLabel: 'Chapter 2',
      position: 1,
      ragChunkCount: 0,
      ragIndexedAt: undefined,
    };
    let created = false;
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return created ? [chapter, createdChapter] : [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'novel.chapter.save') {
        created = true;
        return createdChapter;
      }
      if (method === 'document.get')
        return { ...documentDetail(''), id: 'document-2', title: '未命名草稿' };
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByRole('button', { name: /新建草稿/ }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.chapter.save', { title: '未命名草稿' }),
    );
    expect(await screen.findByText(/已新建小说草稿/)).toBeInTheDocument();
  });

  it('filters drafts and soft-deletes the selected draft with confirmation', async () => {
    const secondChapter = {
      ...chapter,
      id: 'chapter-2',
      documentId: 'document-2',
      title: 'Storm',
      displayLabel: 'Chapter 2',
      position: 1,
    };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter, secondChapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.chapter.archive') return { ...chapter, lifecycleStatus: 'archived' };
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.change(screen.getByLabelText('搜索小说草稿'), { target: { value: 'Storm' } });
    expect(screen.queryByText(/Chapter 1 Opening/)).not.toBeInTheDocument();
    expect(screen.getByText(/Chapter 2 Storm/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜索小说草稿'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /删除草稿/ }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.chapter.archive', {
        chapterId: 'chapter-1',
        expectedRowVersion: 0,
        reason: 'user_archive',
      }),
    );
    expect(confirm).toHaveBeenCalledTimes(1);
    confirm.mockRestore();
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
          indexedChunkCount: 0,
          currentSummaryCount: 0,
          staleSummaryCount: 0,
          issues: [
            {
              code: 'missing-rag-index',
              severity: 'warning',
              chapterId: 'chapter-1',
              message: 'Chapter 1 has no RAG index.',
            },
          ],
        };
      }
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByRole('button', { name: /检查小说连续性/ }));
    expect(await screen.findByText('当前草稿还没有 RAG 切片。')).toBeInTheDocument();
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
    fireEvent.click(screen.getByRole('button', { name: /保存并切片/ }));
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
    fireEvent.click(screen.getByRole('button', { name: /保存并切片/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /使用服务器版本/ }));
    expect(screen.getByDisplayValue('Server version')).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('章节内容'), {
      target: { value: 'Local edits again' },
    });
    fireEvent.click(screen.getByRole('button', { name: /保存并切片/ }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /保留本地修改/ }));
    expect(screen.getByDisplayValue('Local edits again')).toBeInTheDocument();
  });
});
