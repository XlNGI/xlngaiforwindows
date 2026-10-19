import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterSceneWorkspace } from './CharacterSceneWorkspace';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CharacterSceneWorkspace', () => {
  it('shows generated images inline and enlarges them without navigating to the asset library', async () => {
    vi.mocked(callWorker).mockResolvedValue({
      assetId: 'scene-image',
      path: 'D:/Project/assets/images/courtyard.png',
      contentType: 'image/png',
    });
    const onOpenAsset = vi.fn();
    render(
      <CharacterSceneWorkspace
        title="庭院"
        kind="scene"
        content="场景提示词"
        stateLabel="草稿"
        stateKey="draft"
        writable
        versions={[]}
        assets={[
          {
            id: 'scene-image',
            projectId: 'project',
            kind: 'scene',
            relativePath: 'assets/images/courtyard.png',
            alias: '庭院全景',
            contentHash: 'hash',
            sizeBytes: 1024,
            createdAt: 'now',
          },
        ]}
        onTitleChange={vi.fn()}
        onKindChange={vi.fn()}
        onContentChange={vi.fn()}
        onRestoreVersion={vi.fn()}
        onGenerate={vi.fn()}
        onOpenAsset={onOpenAsset}
      />,
    );
    expect(await screen.findByRole('img', { name: '庭院全景' })).toHaveAttribute(
      'src',
      '/worker-media/scene-image?thumbnail=1',
    );
    fireEvent.click(screen.getByRole('button', { name: '放大查看庭院全景' }));
    expect(await within(screen.getByRole('dialog')).findByRole('img')).toHaveAttribute(
      'src',
      '/worker-media/scene-image',
    );
    expect(onOpenAsset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '关闭图片预览' }));
    fireEvent.click(screen.getByRole('button', { name: '查看素材' }));
    expect(onOpenAsset).toHaveBeenCalledWith('scene-image');
  });
});
