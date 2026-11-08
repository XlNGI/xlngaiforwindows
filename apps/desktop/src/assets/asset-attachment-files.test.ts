import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assetAttachmentFiles } from './asset-attachment-files';
import { callWorker } from '../worker-client';
import { forgetWorkerScope, selectWorkerScope } from '../worker-scope';
vi.mock('../worker-client', () => ({ callWorker: vi.fn() }));
const scope = { projectId: 'project', projectSessionId: 'first' };
const raw = JSON.stringify({
  version: 1,
  projectId: 'project',
  assets: [
    { id: 'image', kind: 'scene' },
    { id: 'video', kind: 'scene-video' },
  ],
});
beforeEach(() => {
  selectWorkerScope(scope);
  vi.mocked(callWorker).mockImplementation((_method, params) => {
    const id = (params as { assetId: string }).assetId;
    return Promise.resolve({
      assetId: id,
      path: `D:\\assets\\${id}.${id === 'image' ? 'png' : 'mp4'}`,
      contentType: id === 'image' ? 'image/png' : 'video/mp4',
    });
  });
});
afterEach(() => {
  forgetWorkerScope('project');
  selectWorkerScope(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('loads project-scoped media files through the existing attachment path in snapshot order', async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]))));
  vi.stubGlobal('fetch', fetchMock);
  const files = await assetAttachmentFiles(raw, 'project', 20, 40, 8);
  expect(files.map((file) => [file.name, file.type, file.size])).toEqual([
    ['image.png', 'image/png', 3],
    ['video.mp4', 'video/mp4', 3],
  ]);
  expect(fetchMock.mock.calls[0]![0]).toBe(
    '/worker-media/image?projectId=project&projectSessionId=first',
  );
  expect(callWorker).toHaveBeenCalledWith('asset.mediaSource', { assetId: 'video' }, scope);
});

it('rejects other projects and missing media before reading bytes', async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  await expect(assetAttachmentFiles(raw, 'other', 20, 40, 8)).rejects.toThrow('当前项目');
  vi.mocked(callWorker).mockRejectedValueOnce(new Error('文件不可用'));
  await expect(assetAttachmentFiles(raw, 'project', 20, 40, 8)).rejects.toThrow('文件不可用');
  expect(fetchMock).not.toHaveBeenCalled();
});

it('bounds chunked reads with no content length and atomically rejects excess total size', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => Promise.resolve(new Response(new Uint8Array(5)))),
  );
  await expect(assetAttachmentFiles(raw, 'project', 4, 40, 8)).rejects.toThrow('大小限制');
  await expect(assetAttachmentFiles(raw, 'project', 20, 8, 8)).rejects.toThrow('大小限制');
});

it('discards files resolved after a project has been reopened', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() => {
      selectWorkerScope({ ...scope, projectSessionId: 'reopened' });
      return Promise.resolve(new Response(new Uint8Array([1])));
    }),
  );
  await expect(assetAttachmentFiles(raw, 'project', 20, 40, 8)).rejects.toThrow('项目已切换');
});
