import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraftDocumentBatch, type DraftDeletionTarget } from './DraftDocumentBatch';
import { callWorker } from './worker-client';
import { selectWorkerScope } from './worker-scope';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
const first: DraftDeletionTarget = {
  id: 'a',
  title: '大纲',
  rowVersion: 2,
  lifecycleStatus: 'active',
};
const second: DraftDeletionTarget = {
  id: 'b',
  title: '角色',
  rowVersion: 3,
  lifecycleStatus: 'active',
};
const onDeleted = vi.fn().mockResolvedValue(undefined);

function Harness({
  items = [first, second],
  visibleItems = items,
  writable = true,
  resetKey = 'project',
}: {
  items?: DraftDeletionTarget[];
  visibleItems?: DraftDeletionTarget[];
  writable?: boolean;
  resetKey?: string;
}) {
  const batch = useDraftDocumentBatch({
    items,
    visibleItems,
    writable,
    resetKey,
    dirtyDocumentId: first.id,
    onDeleted,
  });
  return (
    <>
      {batch.controls()}
      {items.map((item) => (
        <div key={item.id}>{batch.checkbox(item)}</div>
      ))}
      {batch.dialog}
      <p role="status">{batch.message}</p>
    </>
  );
}

beforeEach(() => {
  selectWorkerScope(undefined);
  vi.mocked(callWorker).mockReset();
  onDeleted.mockClear();
});
afterEach(cleanup);
function confirm() {
  fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: '确认删除' }));
}

describe('draft document batch deletion', () => {
  it('selects across filters, confirms unsaved changes, and archives each draft with its CAS', async () => {
    vi.mocked(callWorker).mockImplementation((_method, params) =>
      Promise.resolve({
        ...first,
        id: (params as { documentId: string }).documentId,
        lifecycleStatus: 'archived',
      }),
    );
    const { rerender } = render(<Harness visibleItems={[first]} />);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    rerender(<Harness visibleItems={[second]} />);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('未保存的更改将被放弃');
    expect(callWorker).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(callWorker).not.toHaveBeenCalled();
    confirm();
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce());
    expect(callWorker).toHaveBeenNthCalledWith(1, 'document.archive', {
      documentId: first.id,
      expectedDocumentRowVersion: 2,
    });
    expect(callWorker).toHaveBeenNthCalledWith(2, 'document.archive', {
      documentId: second.id,
      expectedDocumentRowVersion: 3,
    });
    expect(screen.getByRole('status')).toHaveTextContent('已删除 2 个草稿');
    expect(screen.getByLabelText('选择文档 大纲')).not.toBeChecked();
  });

  it('keeps failed items selected while reporting successful deletion', async () => {
    vi.mocked(callWorker).mockImplementation((_method, params) =>
      (params as { documentId: string }).documentId === first.id
        ? Promise.reject(new Error('版本冲突'))
        : Promise.resolve({ ...second, lifecycleStatus: 'archived' }),
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    confirm();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('大纲：版本冲突'));
    expect(screen.getByRole('status')).toHaveTextContent('已删除 1 个草稿');
    expect(screen.getByLabelText('选择文档 大纲')).toBeChecked();
    expect(screen.getByLabelText('选择文档 角色')).not.toBeChecked();
  });

  it('excludes published and archived documents and disables deletion in a read-only project', () => {
    const items = [
      first,
      { ...second, publishedVersionId: 'published' },
      { ...first, id: 'c', title: '已删除', lifecycleStatus: 'archived' },
    ];
    render(<Harness items={items} writable={false} />);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    expect(screen.getByLabelText('选择文档 大纲')).toBeChecked();
    expect(screen.getByLabelText('选择文档 角色')).toBeDisabled();
    expect(screen.getByLabelText('选择文档 已删除')).toBeDisabled();
    expect(screen.getByRole('button', { name: '删除所选' })).toBeDisabled();
    expect(callWorker).not.toHaveBeenCalled();
  });

  it('clears selections after lifecycle changes and when switching directories', () => {
    const { rerender } = render(<Harness />);
    fireEvent.click(screen.getByLabelText('选择文档 大纲'));
    rerender(<Harness items={[{ ...first, lifecycleStatus: 'archived' }, second]} />);
    rerender(<Harness />);
    expect(screen.getByLabelText('选择文档 大纲')).not.toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: '删除所选' }));
    rerender(<Harness resetKey="other-directory" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除所选' })).toBeDisabled();
  });

  it('uses the chapter API and refuses a chapter published since selection', async () => {
    const chapter = { ...first, chapterId: 'chapter', chapterRowVersion: 4 };
    vi.mocked(callWorker).mockResolvedValue({ ...first, publishedVersionId: 'published' });
    render(<Harness items={[chapter]} />);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    confirm();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('请先取消发布'));
    expect(callWorker).toHaveBeenCalledExactlyOnceWith('document.get', { documentId: first.id });
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('stops the remaining batch when the project changes during deletion', async () => {
    selectWorkerScope({ projectId: 'one', projectSessionId: 'session-one' });
    let finish!: (value: never) => void;
    vi.mocked(callWorker).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: '全选' }));
    confirm();
    selectWorkerScope({ projectId: 'two', projectSessionId: 'session-two' });
    await act(async () => {
      finish({ ...first, lifecycleStatus: 'archived' } as never);
      await Promise.resolve();
    });
    expect(callWorker).toHaveBeenCalledTimes(1);
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
