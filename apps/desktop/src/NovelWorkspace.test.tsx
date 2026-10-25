import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentDetail,
  NovelChapterInfo,
  NovelMarkdownExportJobInfo,
  WorkerMethod,
} from '@ai-video/contracts';
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

const exportJob: NovelMarkdownExportJobInfo = {
  id: 'export-1',
  projectId: 'project-1',
  exportType: 'work',
  exportFormat: 'files',
  packagePath: 'C:/Novel/exports/novel-export-1',
  status: 'succeeded',
  itemCount: 1,
  createdAt: '2026-10-15T00:00:00.000Z',
};

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
  it('uses one chapter selection for production and export and protects unsaved edits', async () => {
    const second = {
      ...chapter,
      id: 'chapter-2',
      documentId: 'document-2',
      title: 'Second',
      position: 1,
    };
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter, second];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.export.start') return { ...exportJob, exportType: 'selection' };
      return {};
    });
    const generate = vi.fn().mockResolvedValue(undefined);
    render(<NovelWorkspace projectId="project-1" writable onGenerateScript={generate} />);
    await screen.findByLabelText('章节内容');
    expect(screen.getAllByRole('checkbox', { name: /^选择 / })).toHaveLength(2);
    fireEvent.click(screen.getByLabelText('选择 Chapter 1 Second'));
    expect(screen.getByText('已选 1 章')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /一键生成短剧资料/ }));
    expect(generate).toHaveBeenCalledExactlyOnceWith([second]);
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    expect(screen.getByLabelText('导出范围')).toHaveValue('selection');
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.export.start', {
        exportType: 'selection',
        chapterIds: [second.id],
        exportFormat: 'files',
      }),
    );
    await screen.findByText('导出完成，共 1 章。');
    expect(screen.getByLabelText('选择 Chapter 1 Second')).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
    fireEvent.change(screen.getByLabelText('章节内容'), { target: { value: '未保存' } });
    fireEvent.click(screen.getByRole('button', { name: /一键生成短剧资料/ }));
    expect(screen.getByText('请先保存当前章节，再生成短剧资料。')).toBeInTheDocument();
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('loads the chapter tree, opens a chapter, and saves a user draft with CAS', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'document.draft.save') return documentDetail('Updated');
      if (method === 'novel.export.start')
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

  it('lists and edits novel reference documents separately from chapters', async () => {
    const reference = {
      id: 'reference-1',
      projectId: 'project-1',
      kind: 'outline' as const,
      title: '都市小说大纲',
      domainScope: 'novel' as const,
      bindingRole: 'work-outline' as const,
      scopeType: 'project' as const,
      lifecycleStatus: 'active' as const,
      rowVersion: 0,
      createdAt: '2026-08-19T00:00:00.000Z',
      updatedAt: '2026-08-19T00:00:00.000Z',
    };
    const referenceDetail = {
      ...documentDetail('原小说大纲'),
      id: reference.id,
      kind: 'outline' as const,
      title: reference.title,
      domainScope: 'novel' as const,
      bindingRole: 'work-outline' as const,
      currentVersion: {
        ...documentDetail('原小说大纲').currentVersion!,
        documentId: reference.id,
        contentMarkdown: '原小说大纲',
      },
    };
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return referenceDetail;
      if (method === 'document.draft.save') return { ...referenceDetail, rowVersion: 1 };
      return {};
    });
    render(
      <NovelWorkspace
        projectId="project-1"
        writable
        referenceDocuments={[reference]}
        onReferencesChanged={() => Promise.resolve()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /都市小说大纲/ }));
    expect(await screen.findByDisplayValue('原小说大纲')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('小说资料内容'), { target: { value: '更新后的大纲' } });
    fireEvent.click(screen.getByRole('button', { name: /保存并切片/ }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'document.draft.save',
        expect.objectContaining({ documentId: reference.id, contentMarkdown: '更新后的大纲' }),
      ),
    );
  });

  it('focuses and reloads the chapter selected by an Agent result', async () => {
    let documentReads = 0;
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') {
        documentReads += 1;
        return documentDetail(documentReads > 1 ? 'Agent latest draft' : 'Draft');
      }
      return {};
    });
    const { rerender } = render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByDisplayValue('Draft');

    rerender(
      <NovelWorkspace projectId="project-1" writable focusChapterId="chapter-1" refreshToken={1} />,
    );

    expect(await screen.findByDisplayValue('Agent latest draft')).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'document.get'),
    ).toHaveLength(2);
  });

  it('refreshes chapter metadata without discarding local title or body edits', async () => {
    let updated = false;
    mockWorker((method) => {
      if (method === 'novel.chapter.list')
        return [
          {
            ...chapter,
            ...(updated
              ? { displayLabel: '第 1 章', title: '新章名', rowVersion: 1, documentRowVersion: 1 }
              : {}),
          },
        ];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get')
        return { ...documentDetail(), ...(updated ? { title: '新章名', rowVersion: 1 } : {}) };
      if (method === 'document.draft.save') return documentDetail('本地未保存正文');
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByDisplayValue('Draft');
    fireEvent.change(screen.getByLabelText('章节标题'), { target: { value: '本地未保存标题' } });
    fireEvent.change(screen.getByLabelText('章节内容'), { target: { value: '本地未保存正文' } });
    updated = true;
    fireEvent(
      window,
      new CustomEvent('novel-metadata-updated', { detail: { projectId: 'other-project' } }),
    );
    expect(screen.getByLabelText('选择 Chapter 1 Opening')).toBeInTheDocument();
    fireEvent(
      window,
      new CustomEvent('novel-metadata-updated', { detail: { projectId: 'project-1' } }),
    );
    await screen.findByLabelText('选择 第 1 章 新章名');
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'document.get'),
      ).toHaveLength(2),
    );
    expect(screen.getByLabelText('章节标题')).toHaveValue('本地未保存标题');
    expect(screen.getByLabelText('章节内容')).toHaveValue('本地未保存正文');
    fireEvent.click(screen.getByRole('button', { name: /保存并切片/ }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'document.draft.save',
        expect.objectContaining({
          documentId: chapter.documentId,
          expectedDocumentRowVersion: 1,
          title: '本地未保存标题',
          contentMarkdown: '本地未保存正文',
        }),
      ),
    );
  });

  it('does not adopt a concurrent body version as a metadata-only revision', async () => {
    let updated = false;
    mockWorker((method) => {
      if (method === 'novel.chapter.list')
        return [{ ...chapter, displayLabel: updated ? '第 1 章' : chapter.displayLabel }];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get')
        return {
          ...documentDetail(updated ? '其他人保存的新正文' : 'Draft'),
          ...(updated ? { currentVersionId: 'version-2', rowVersion: 2 } : {}),
        };
      if (method === 'document.draft.save') return documentDetail('本地正文');
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByDisplayValue('Draft');
    fireEvent.change(screen.getByLabelText('章节内容'), { target: { value: '本地正文' } });
    updated = true;
    fireEvent(
      window,
      new CustomEvent('novel-metadata-updated', { detail: { projectId: 'project-1' } }),
    );
    await screen.findByLabelText('选择 第 1 章 Opening');
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'document.get'),
      ).toHaveLength(2),
    );
    expect(screen.getByLabelText('章节内容')).toHaveValue('本地正文');
    fireEvent.click(screen.getByRole('button', { name: /保存并切片/ }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'document.draft.save',
        expect.objectContaining({ expectedDocumentRowVersion: 0, contentMarkdown: '本地正文' }),
      ),
    );
  });

  it('keeps novel generation entry points in the conversation', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    expect(screen.queryByRole('button', { name: '生成本章正文' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /生成短剧内容/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText('选择 Chapter 1 Opening')).not.toBeChecked();
  });

  it('exports the immutable work package through Worker', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.export.start') return exportJob;
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByText(/Chapter 1 Opening/);
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    expect(screen.getByLabelText('包含草稿')).not.toBeChecked();
    expect(callWorker).not.toHaveBeenCalledWith('novel.export.start', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.export.start', {
        exportType: 'work',
        exportFormat: 'files',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('导出完成，共 1 章');
    expect(screen.getByText(exportJob.packagePath)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开导出文件夹' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.export.reveal', { jobId: exportJob.id }),
    );
  });

  it('toggles export options from the same button without clearing settings or starting export', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByLabelText('章节内容');
    const toggle = screen.getByRole('button', { name: /导出 Markdown/ });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText('导出范围'), { target: { value: 'selection' } });
    fireEvent.change(screen.getByLabelText('文件组织'), { target: { value: 'merged' } });
    fireEvent.click(screen.getByLabelText('包含草稿'));
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('region', { name: '小说导出选项' })).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('导出范围')).toHaveValue('selection');
    expect(screen.getByLabelText('文件组织')).toHaveValue('merged');
    expect(screen.getByLabelText('包含草稿')).toBeChecked();
    expect(callWorker).not.toHaveBeenCalledWith('novel.export.start', expect.anything());
  });

  it('selects chapters without opening them and exports only the selected saved drafts as merged Markdown', async () => {
    const second = { ...chapter, id: 'chapter-2', documentId: 'document-2', title: 'Second' };
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter, second];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.export.start') return { ...exportJob, exportFormat: 'merged' };
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByLabelText('章节内容');
    fireEvent.click(screen.getByLabelText('选择 Chapter 1 Second'));
    expect(screen.getByText('已选 1 章')).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'document.get'),
    ).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    expect(screen.getByLabelText('导出范围')).toHaveValue('selection');
    fireEvent.change(screen.getByLabelText('文件组织'), { target: { value: 'merged' } });
    fireEvent.click(screen.getByLabelText('包含草稿'));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('novel.export.start', {
        exportType: 'selection',
        chapterIds: ['chapter-2'],
        exportFormat: 'merged',
        includeDraft: true,
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent('导出完成，共 1 章');
  });

  it('selects only active search results, preserves hidden selections and supports clearing all', async () => {
    const second = { ...chapter, id: 'chapter-2', title: 'Second' };
    const archived = {
      ...chapter,
      id: 'chapter-3',
      title: 'Archived',
      lifecycleStatus: 'archived' as const,
    };
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter, second, archived];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      return {};
    });
    const generate = vi.fn().mockResolvedValue(undefined);
    render(<NovelWorkspace projectId="project-1" writable onGenerateScript={generate} />);
    await screen.findByLabelText('章节内容');
    expect(screen.getByLabelText('选择 Chapter 1 Archived')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('搜索小说草稿'), { target: { value: 'Second' } });
    fireEvent.click(screen.getByRole('button', { name: '全选搜索结果' }));
    expect(screen.getByText('已选 1 章')).toBeInTheDocument();
    expect(screen.getByLabelText('选择 Chapter 1 Second')).toBeChecked();
    fireEvent.change(screen.getByLabelText('搜索小说草稿'), { target: { value: '' } });
    expect(screen.getByLabelText('选择 Chapter 1 Opening')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByText('已选 2 章')).toBeInTheDocument();
    expect(screen.getByLabelText('选择 Chapter 1 Archived')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: /一键生成短剧资料/ }));
    expect(generate).toHaveBeenCalledExactlyOnceWith([chapter, second]);
    fireEvent.click(screen.getByRole('button', { name: '取消全选' }));
    expect(screen.getByText('已选 0 章')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    fireEvent.change(screen.getByLabelText('导出范围'), { target: { value: 'selection' } });
    expect(screen.getByRole('button', { name: '开始导出' })).toBeDisabled();
    expect(screen.getByText('请在章节列表勾选要导出的章节。')).toBeInTheDocument();
  });

  it('shows export failures and lets the user explicitly retry with drafts included', async () => {
    mockWorker((method, params) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.export.start') {
        if (!(params as { includeDraft?: boolean }).includeDraft)
          return Promise.reject(
            new Error('所选范围没有已发布章节。若要导出草稿，请勾选“包含草稿”。'),
          );
        return exportJob;
      }
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByLabelText('章节内容');
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('导出失败：所选范围没有已发布章节');
    expect(screen.queryByRole('button', { name: '打开导出文件夹' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('包含草稿'));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    expect(await screen.findByRole('status')).toHaveTextContent('导出完成，共 1 章');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('switches an open export panel to the checked chapters and reports a failed job result', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.export.start')
        return { ...exportJob, status: 'failed', errorMessage: '磁盘空间不足' };
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByLabelText('章节内容');
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    expect(screen.getByLabelText('导出范围')).toHaveValue('work');
    fireEvent.click(screen.getByLabelText('选择 Chapter 1 Opening'));
    expect(screen.getByLabelText('导出范围')).toHaveValue('selection');
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('导出失败：磁盘空间不足');
    expect(screen.queryByRole('button', { name: '打开导出文件夹' })).not.toBeInTheDocument();
  });

  it('shows pending export progress, prevents duplicate submission and ignores completion after switching projects', async () => {
    let completeExport!: (job: NovelMarkdownExportJobInfo) => void;
    const pending = new Promise<NovelMarkdownExportJobInfo>((resolve) => {
      completeExport = resolve;
    });
    mockWorker((method) => {
      if (method === 'novel.chapter.list') return [chapter];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.export.start') return pending;
      return {};
    });
    const { rerender } = render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByLabelText('章节内容');
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    expect(screen.getByRole('status')).toHaveTextContent('正在导出');
    fireEvent.click(screen.getByRole('button', { name: '正在导出…' }));
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'novel.export.start'),
    ).toHaveLength(1);
    expect(screen.getByLabelText('包含草稿')).toBeDisabled();
    rerender(<NovelWorkspace projectId="project-2" writable />);
    await screen.findByLabelText('章节内容');
    expect(screen.getByText('已选 0 章')).toBeInTheDocument();
    await act(async () => {
      completeExport(exportJob);
      await pending;
    });
    expect(screen.queryByText(exportJob.packagePath)).not.toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('reports skipped unpublished chapters and folder-opening errors without losing the export path', async () => {
    mockWorker((method) => {
      if (method === 'novel.chapter.list')
        return [chapter, { ...chapter, id: 'chapter-2', title: 'Second' }];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      if (method === 'novel.export.start') return exportJob;
      if (method === 'novel.export.reveal') return Promise.reject(new Error('文件夹已被移动'));
      return {};
    });
    render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByLabelText('章节内容');
    fireEvent.click(screen.getByRole('button', { name: /导出 Markdown/ }));
    fireEvent.click(screen.getByRole('button', { name: '开始导出' }));
    expect(await screen.findByRole('status')).toHaveTextContent('另有 1 章没有已发布版本，未导出');
    fireEvent.click(screen.getByRole('button', { name: '打开导出文件夹' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('打开文件夹失败：文件夹已被移动');
    expect(screen.getByText(exportJob.packagePath)).toBeInTheDocument();
  });

  it('removes archived chapters from the export selection after refresh and disables exporting read-only projects', async () => {
    let archived = false;
    mockWorker((method) => {
      if (method === 'novel.chapter.list')
        return [{ ...chapter, lifecycleStatus: archived ? 'archived' : 'active' }];
      if (method === 'novel.volume.list') return [];
      if (method === 'document.get') return documentDetail();
      return {};
    });
    const { rerender } = render(<NovelWorkspace projectId="project-1" writable />);
    await screen.findByLabelText('章节内容');
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByText('已选 1 章')).toBeInTheDocument();
    archived = true;
    fireEvent.click(screen.getByRole('button', { name: '刷新章节' }));
    await screen.findByText('已选 0 章');
    expect(screen.getByLabelText('选择 Chapter 1 Opening')).toBeDisabled();
    archived = false;
    rerender(<NovelWorkspace projectId="project-1" writable={false} refreshToken={1} />);
    await waitFor(() => expect(screen.getByLabelText('选择 Chapter 1 Opening')).toBeEnabled());
    expect(screen.getByRole('button', { name: /导出 Markdown/ })).toBeDisabled();
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
      if (method === 'file.task.create') {
        return {
          id: 'import-task',
          kind: 'novel-import',
          status: 'succeeded',
          result: {
            volume: undefined,
            chapters: [importedChapter, secondImportedChapter],
            importedCount: 2,
          },
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
      expect(callWorker).toHaveBeenCalledWith('file.task.create', {
        kind: 'novel-import',
        idempotencyKey: expect.any(String) as string,
        input: {
          volumeTitle: '第一卷',
          chapters: [
            { title: '第一章', displayLabel: '第 1 章', contentMarkdown: '雨落在雾港。' },
            { title: '第二章', displayLabel: '第 2 章', contentMarkdown: '灯塔亮起。' },
          ],
        },
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
