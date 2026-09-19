import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetInfo, DocumentSummary } from '@ai-video/contracts';
import {
  ShotWorkspace,
  loadShotReferences,
  mentionedTitle,
  saveShotReferences,
} from './ShotWorkspace';
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

describe('mentionedTitle', () => {
  it('reads character and scene titles from prompt tokens', () => {
    expect(mentionedTitle('[\u89d2\u8272:\u6797\u6f88] \u56de\u5934', 'character')).toBe(
      '\u6797\u6f88',
    );
    expect(mentionedTitle('[\u573a\u666f:\u65e7\u7801\u5934]', 'scene')).toBe('\u65e7\u7801\u5934');
    expect(mentionedTitle('\u6ca1\u6709\u5f15\u7528', 'character')).toBeUndefined();
  });
});

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
  it('fills empty reference slots from mentioned documents before generating an image', async () => {
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
    await waitFor(() =>
      expect(onGenerateImage).toHaveBeenCalledWith({
        characterAssetId: 'character-asset',
        sceneAssetId: 'scene-asset',
      }),
    );
    expect(loadShotReferences('project', 'shot')).toEqual({
      characterAssetId: 'character-asset',
      sceneAssetId: 'scene-asset',
    });
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
