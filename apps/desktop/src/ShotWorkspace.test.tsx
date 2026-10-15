import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetInfo, DocumentSummary } from '@ai-video/contracts';
import { ShotWorkspace, loadShotReferences, saveShotReferences } from './ShotWorkspace';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));

const characterDoc: DocumentSummary = {
  id: 'character-doc',
  projectId: 'project',
  kind: 'character',
  title: '\u6797\u6f88',
  scopeType: 'project',
  lifecycleStatus: 'active',
  rowVersion: 0,
  createdAt: 'now',
  updatedAt: 'now',
};

const sceneDoc: DocumentSummary = {
  id: 'scene-doc',
  projectId: 'project',
  kind: 'scene',
  title: '\u65e7\u7801\u5934',
  scopeType: 'project',
  lifecycleStatus: 'active',
  rowVersion: 0,
  createdAt: 'now',
  updatedAt: 'now',
};

const characterAsset: AssetInfo = {
  id: 'character-asset',
  projectId: 'project',
  kind: 'character',
  relativePath: 'assets/images/lin.png',
  contentHash: 'hash-1',
  sizeBytes: 2048,
  createdAt: 'now',
};

const sceneAsset: AssetInfo = {
  id: 'scene-asset',
  projectId: 'project',
  kind: 'scene',
  relativePath: 'assets/images/dock.png',
  contentHash: 'hash-2',
  sizeBytes: 2048,
  createdAt: 'now',
};

const firstFrameAsset: AssetInfo = {
  id: 'first-frame-asset',
  projectId: 'project',
  kind: 'first-frame',
  relativePath: 'assets/images/shot.png',
  contentHash: 'hash-3',
  sizeBytes: 2048,
  createdAt: 'now',
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
});

function renderWorkspace(
  overrides: Partial<import('react').ComponentProps<typeof ShotWorkspace>> = {},
) {
  const onGenerateImage = vi.fn();
  const onGenerateVideo = vi.fn();
  const view = render(
    <ShotWorkspace
      projectId="project"
      shotId="shot"
      shotTitle={'\u955c\u5934\u4e00'}
      shotStatus="draft"
      shotPosition={0}
      prompt={'\u96e8\u591c\u91cc\u6797\u6f88\u56de\u5934'}
      writable
      assets={[characterAsset, sceneAsset, firstFrameAsset]}
      documents={[characterDoc, sceneDoc]}
      storyboardTitle=""
      storyboardContent=""
      storyboardBusy={false}
      hasStoryboard={false}
      onPromptChange={vi.fn()}
      onSavePrompt={vi.fn()}
      onGenerateImage={onGenerateImage}
      onGenerateVideo={onGenerateVideo}
      onStoryboardTitleChange={vi.fn()}
      onStoryboardContentChange={vi.fn()}
      onSaveStoryboard={vi.fn()}
      {...overrides}
    />,
  );
  return { ...view, onGenerateImage, onGenerateVideo };
}

describe('shot reference storage', () => {
  it('saves and loads per-shot reference slots', () => {
    saveShotReferences('project', 'shot', { characterAssetId: 'character-asset' });
    expect(loadShotReferences('project', 'shot')).toEqual({
      characterAssetId: 'character-asset',
    });
    expect(loadShotReferences('project', 'other')).toEqual({});
  });
});

describe('ShotWorkspace', () => {
  it('shows generated shot images inline and opens an enlarged preview', async () => {
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'asset.list') return Promise.resolve([firstFrameAsset]);
      if (method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: firstFrameAsset.id,
          path: 'D:/Project/assets/images/shot.png',
          contentType: 'image/png',
        });
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    renderWorkspace();
    expect(await screen.findByRole('img', { name: 'shot.png' })).toHaveAttribute(
      'src',
      '/worker-media/first-frame-asset',
    );
    fireEvent.click(screen.getByRole('button', { name: '放大查看shot.png' }));
    expect(screen.getByRole('dialog', { name: '图片预览：shot.png' })).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(callWorker).toHaveBeenCalledWith('asset.list', {
      shotId: 'shot',
      sort: 'created-desc',
      limit: 60,
    });
  });
  it('inherits a bound scene image by document ID without persisting an override or using a same-title document', async () => {
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'asset.list')
        return Promise.resolve(
          (params as { sourceDocumentId?: string }).sourceDocumentId === sceneDoc.id
            ? [sceneAsset]
            : [characterAsset],
        );
      if (method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: sceneAsset.id,
          path: 'D:/Project/assets/images/dock.png',
          contentType: 'image/png',
        });
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    const { onGenerateVideo } = renderWorkspace({
      sceneDocumentId: sceneDoc.id,
      assets: [],
      documents: [{ ...sceneDoc, id: 'same-title-other-document' }, sceneDoc],
      prompt: '远景，人物走过庭院',
    });
    await waitFor(() => expect(screen.getByLabelText('场景参考')).toHaveValue(sceneAsset.id));
    fireEvent.click(screen.getByRole('button', { name: '用参考图生成视频' }));
    await waitFor(() =>
      expect(onGenerateVideo).toHaveBeenCalledWith({ sceneAssetId: sceneAsset.id }),
    );
    expect(loadShotReferences('project', 'shot').sceneAssetId).toBeUndefined();
    expect(callWorker).not.toHaveBeenCalledWith(
      'asset.list',
      expect.objectContaining({ sourceDocumentId: 'same-title-other-document' }),
    );
  });

  it('keeps explicit shot references and can clear or restore scene inheritance', async () => {
    saveShotReferences('project', 'shot', { sceneAssetId: firstFrameAsset.id });
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'asset.list') return Promise.resolve([sceneAsset]);
      if (method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: sceneAsset.id,
          path: 'D:/Project/assets/images/ref.png',
          contentType: 'image/png',
        });
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    const { onGenerateVideo } = renderWorkspace({
      sceneDocumentId: sceneDoc.id,
      prompt: '庭院远景',
    });
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ sourceDocumentId: sceneDoc.id }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '用参考图生成视频' }));
    await waitFor(() =>
      expect(onGenerateVideo).toHaveBeenCalledWith({ sceneAssetId: firstFrameAsset.id }),
    );
    fireEvent.click(screen.getByRole('button', { name: '恢复场次场景图' }));
    await waitFor(() => expect(screen.getByLabelText('场景参考')).toHaveValue(sceneAsset.id));
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(screen.getByLabelText('场景参考')).toHaveValue('');
    expect(loadShotReferences('project', 'shot').ignoreSceneBinding).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '恢复场次场景图' }));
    expect(screen.getByLabelText('场景参考')).toHaveValue(sceneAsset.id);
  });

  it('ignores a stale inherited image when the scene binding changes', async () => {
    let resolveOld!: (assets: AssetInfo[]) => void;
    const nextDoc = { ...sceneDoc, id: 'next-scene-document', title: '书房' };
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'asset.list') {
        if ((params as { sourceDocumentId?: string }).sourceDocumentId === sceneDoc.id)
          return new Promise<AssetInfo[]>((resolve) => {
            resolveOld = resolve;
          });
        return Promise.resolve([firstFrameAsset]);
      }
      if (method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: firstFrameAsset.id,
          path: 'D:/Project/assets/images/new.png',
          contentType: 'image/png',
        });
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    const workspace = renderWorkspace({
      sceneDocumentId: sceneDoc.id,
      documents: [sceneDoc, nextDoc],
    });
    await waitFor(() => expect(resolveOld).toBeDefined());
    const props: import('react').ComponentProps<typeof ShotWorkspace> = {
      projectId: 'project',
      shotId: 'shot',
      shotTitle: '镜头',
      shotStatus: 'draft',
      shotPosition: 0,
      prompt: '书房特写',
      writable: true,
      assets: [sceneAsset, firstFrameAsset],
      documents: [sceneDoc, nextDoc],
      sceneDocumentId: nextDoc.id,
      storyboardTitle: '',
      storyboardContent: '',
      storyboardBusy: false,
      hasStoryboard: false,
      onPromptChange: vi.fn(),
      onSavePrompt: vi.fn(),
      onGenerateImage: vi.fn(),
      onGenerateVideo: vi.fn(),
      onStoryboardTitleChange: vi.fn(),
      onStoryboardContentChange: vi.fn(),
      onSaveStoryboard: vi.fn(),
    };
    workspace.rerender(<ShotWorkspace {...props} />);
    await waitFor(() => expect(screen.getByLabelText('场景参考')).toHaveValue(firstFrameAsset.id));
    resolveOld([sceneAsset]);
    await waitFor(() => expect(screen.getByLabelText('场景参考')).toHaveValue(firstFrameAsset.id));
  });
  it('does not create reference relationships from names or prompt placeholders', async () => {
    vi.mocked(callWorker).mockImplementation((method: string, params?: unknown) => {
      if (method === 'asset.list') {
        const sourceDocumentId = (params as { sourceDocumentId?: string } | undefined)
          ?.sourceDocumentId;
        if (sourceDocumentId === characterDoc.id) return Promise.resolve([characterAsset]);
        if (sourceDocumentId === sceneDoc.id) return Promise.resolve([sceneAsset]);
        return Promise.resolve([]);
      }
      if (method === 'asset.mediaSource') {
        return Promise.resolve({
          assetId: (params as { assetId: string }).assetId,
          path: 'D:\\\\Project\\\\assets\\\\images\\\\ref.png',
          contentType: 'image/png',
        });
      }
      throw new Error('Unexpected method ' + method);
    });
    const { onGenerateImage } = renderWorkspace({
      prompt: '[\u89d2\u8272:\u6797\u6f88] [\u573a\u666f:\u65e7\u7801\u5934] \u96e8\u591c',
    });
    fireEvent.click(screen.getByRole('button', { name: '\u751f\u6210\u672c\u955c\u753b\u9762' }));
    await waitFor(() => expect(onGenerateImage).toHaveBeenCalledWith({}));
    expect(loadShotReferences('project', 'shot')).toEqual({});
    expect(callWorker).not.toHaveBeenCalledWith(
      'asset.list',
      expect.objectContaining({ sourceDocumentId: characterDoc.id }),
    );
    expect(callWorker).not.toHaveBeenCalledWith(
      'asset.list',
      expect.objectContaining({ sourceDocumentId: sceneDoc.id }),
    );
  });

  it('keeps generate-video disabled until a reference or mention exists', () => {
    renderWorkspace();
    expect(
      screen.getByRole('button', { name: '\u7528\u53c2\u8003\u56fe\u751f\u6210\u89c6\u9891' }),
    ).toBeDisabled();
  });

  it('sends selected first-frame references to video generation', async () => {
    vi.mocked(callWorker).mockResolvedValue({
      assetId: firstFrameAsset.id,
      path: 'D:\\\\Project\\\\assets\\\\images\\\\shot.png',
      contentType: 'image/png',
    });
    const { onGenerateVideo } = renderWorkspace();
    fireEvent.change(screen.getByLabelText('\u9996\u5e27'), {
      target: { value: firstFrameAsset.id },
    });
    expect(
      screen.getByRole('button', { name: '\u7528\u53c2\u8003\u56fe\u751f\u6210\u89c6\u9891' }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole('button', { name: '\u7528\u53c2\u8003\u56fe\u751f\u6210\u89c6\u9891' }),
    );
    await waitFor(() =>
      expect(onGenerateVideo).toHaveBeenCalledWith({ firstFrameAssetId: 'first-frame-asset' }),
    );
  });
});
