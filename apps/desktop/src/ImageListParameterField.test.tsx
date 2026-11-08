import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ImageListParameterField } from './ImageListParameterField';
import { callWorker } from './worker-client';
import { readLocalImageFile } from './local-image-input';
import { forgetWorkerScope, selectWorkerScope } from './worker-scope';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./local-image-input', async (original) => ({
  ...(await original<typeof import('./local-image-input')>()),
  readLocalImageFile: vi.fn(),
}));
const scope = { projectId: 'image-project', projectSessionId: 'epoch-1' };
const props = {
  field: { key: 'images' },
  property: { type: 'array' as const, title: '参考图片', minItems: 1, maxItems: 3 },
  value: ['https://example.com/original.png'],
  projectId: scope.projectId,
  inputId: 'image-list',
  label: <label htmlFor="image-list">参考图片</label>,
  description: null,
};
const drop = (projectId = scope.projectId, assets = [{ id: 'asset', kind: 'scene' }]) =>
  fireEvent.drop(screen.getByLabelText('参考图片').closest('.asset-drop-target')!, {
    dataTransfer: { getData: () => JSON.stringify({ version: 1, projectId, assets }) },
  });
beforeEach(() => {
  vi.clearAllMocks();
  selectWorkerScope(scope);
});
afterEach(() => {
  cleanup();
  forgetWorkerScope(scope.projectId);
  selectWorkerScope(undefined);
});

it('uses the task project to validate drops and rejects cross-project, video and excess inputs', async () => {
  const onChange = vi.fn();
  vi.mocked(callWorker).mockResolvedValue({
    assetId: 'asset',
    path: '/test.png',
    contentType: 'image/png',
  });
  render(<ImageListParameterField {...props} onChange={onChange} />);
  drop('other');
  expect(await screen.findByText('只能拖入当前项目的素材。')).toBeInTheDocument();
  drop(scope.projectId, [{ id: 'video', kind: 'scene-video' }]);
  expect(await screen.findByText('此参数只接受图片素材。')).toBeInTheDocument();
  drop(
    scope.projectId,
    Array.from({ length: 4 }, (_, i) => ({ id: `${i}`, kind: 'scene' })),
  );
  expect(await screen.findByText('最多可拖入 3 项素材。')).toBeInTheDocument();
  expect(callWorker).not.toHaveBeenCalled();
  selectWorkerScope({ projectId: 'visible', projectSessionId: 'other-epoch' });
  drop();
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(['asset://asset']));
  expect(callWorker).toHaveBeenCalledWith('asset.mediaSource', { assetId: 'asset' }, scope);
  forgetWorkerScope('visible');
});

it('discards delayed drop results after an edit or project session change', async () => {
  const onChange = vi.fn();
  let finish!: (value: { assetId: string; path: string; contentType: string }) => void;
  vi.mocked(callWorker).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const view = render(<ImageListParameterField {...props} onChange={onChange} />);
  drop();
  fireEvent.change(screen.getByLabelText('参考图片'), {
    target: { value: 'https://example.com/edited.png' },
  });
  await act(async () => {
    finish({ assetId: 'asset', path: '/test.png', contentType: 'image/png' });
    await Promise.resolve();
  });
  expect(onChange).toHaveBeenCalledExactlyOnceWith(['https://example.com/edited.png']);
  onChange.mockClear();
  drop();
  selectWorkerScope({ ...scope, projectSessionId: 'epoch-2' });
  view.rerender(<ImageListParameterField {...props} onChange={onChange} />);
  await act(async () => {
    finish({ assetId: 'asset', path: '/test.png', contentType: 'image/png' });
    await Promise.resolve();
  });
  expect(onChange).not.toHaveBeenCalled();
});

it('discards an older local file read after a replacement choice and after unmounting', async () => {
  const onChange = vi.fn();
  const pending = vi.fn();
  const reads: Array<(value: { dataUrl: string; name: string; size: number }) => void> = [];
  vi.mocked(readLocalImageFile).mockImplementation(
    () =>
      new Promise((resolve) => {
        reads.push(resolve);
      }),
  );
  const view = render(
    <ImageListParameterField {...props} onChange={onChange} onPendingChange={pending} />,
  );
  const file = (name: string) => ({
    target: { files: [new File(['png'], name, { type: 'image/png' })] },
  });
  fireEvent.change(screen.getByLabelText('为参考图片选择本地图片'), file('old.png'));
  fireEvent.change(screen.getByLabelText('为参考图片选择本地图片'), file('new.png'));
  await act(async () => {
    reads[1]!({ dataUrl: 'data:image/png;base64,bmV3', name: 'new.png', size: 3 });
    await Promise.resolve();
  });
  await act(async () => {
    reads[0]!({ dataUrl: 'data:image/png;base64,b2xk', name: 'old.png', size: 3 });
    await Promise.resolve();
  });
  expect(onChange).toHaveBeenCalledExactlyOnceWith(['data:image/png;base64,bmV3']);
  fireEvent.change(screen.getByLabelText('为参考图片选择本地图片'), file('closed.png'));
  view.unmount();
  await act(async () => {
    reads[2]!({ dataUrl: 'data:image/png;base64,YQ==', name: 'closed.png', size: 1 });
    await Promise.resolve();
  });
  expect(onChange).toHaveBeenCalledTimes(1);
  expect(pending).toHaveBeenLastCalledWith(false);
});
