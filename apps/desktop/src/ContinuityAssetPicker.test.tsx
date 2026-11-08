import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AssetInfo } from '@ai-video/contracts';
import { ContinuityAssetPicker } from './ContinuityAssetPicker';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./AssetImagePreview', () => ({ AssetImagePreview: () => <span>预览</span> }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const asset = (id: string): AssetInfo => ({
  id,
  alias: id,
  kind: 'generated-image',
  projectId: 'project',
  relativePath: `${id}.png`,
  contentHash: id,
  sizeBytes: 10,
  createdAt: '2026-11-04T00:00:00Z',
});

it('loads beyond the first page and retains selected IDs while searching the entire project', async () => {
  const first = Array.from({ length: 30 }, (_, i) => asset(`image-${i}`));
  vi.mocked(callWorker).mockImplementation(async (_method, params) => {
    await Promise.resolve();
    const query = params as { cursor?: string; keyword?: string };
    return query.keyword ? [asset('搜索命中')] : query.cursor ? [asset('第31张')] : first;
  });
  const onToggle = vi.fn();
  render(
    <ContinuityAssetPicker
      projectId="project"
      selectedIds={['image-0']}
      onToggle={onToggle}
      disabled={false}
      label="项目图片"
    />,
  );
  expect(callWorker).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('项目图片'));
  expect(await screen.findByLabelText('image-0')).toBeChecked();
  fireEvent.click(screen.getByText('加载更多素材'));
  fireEvent.click(await screen.findByLabelText('第31张'));
  expect(onToggle).toHaveBeenCalledWith(asset('第31张'));
  expect(callWorker).toHaveBeenCalledWith(
    'asset.list',
    expect.objectContaining({ cursor: `${first[29]!.createdAt}|image-29` }),
  );
  fireEvent.change(screen.getByLabelText('项目图片搜索'), { target: { value: '命中' } });
  await screen.findByLabelText('搜索命中');
  await waitFor(() =>
    expect(callWorker).toHaveBeenLastCalledWith(
      'asset.list',
      expect.objectContaining({ keyword: '命中', cursor: undefined }),
    ),
  );
  expect(screen.queryByLabelText('image-0')).not.toBeInTheDocument();
});

it('discards a previous filter response and blocks writes while disabled', async () => {
  let finish: ((value: AssetInfo[]) => void) | undefined;
  vi.mocked(callWorker).mockImplementation(async (_method, params) => {
    if ((params as { keyword?: string }).keyword) return [asset('new')];
    return new Promise<AssetInfo[]>((resolve) => {
      finish = resolve;
    });
  });
  const onToggle = vi.fn();
  const props = {
    projectId: 'project',
    selectedIds: [],
    onToggle,
    disabled: false,
    imagesOnly: true,
    label: '项目图片',
  };
  const view = render(<ContinuityAssetPicker {...props} />);
  fireEvent.click(screen.getByText('项目图片'));
  await waitFor(() => expect(finish).toBeDefined());
  fireEvent.change(screen.getByLabelText('项目图片搜索'), { target: { value: 'new' } });
  await screen.findByLabelText('new');
  finish!([asset('late')]);
  await waitFor(() => expect(screen.queryByLabelText('late')).not.toBeInTheDocument());
  view.rerender(<ContinuityAssetPicker {...props} disabled />);
  expect(screen.getByLabelText('new')).toBeDisabled();
});
