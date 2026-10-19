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
  it('shows bound scene links in read-only mode and keeps history collapsed until needed', () => {
    const onOpenScene = vi.fn();
    const onRestoreVersion = vi.fn();
    render(
      <CharacterSceneWorkspace
        title="庭院"
        kind="scene"
        content="雨后的旧庭院"
        stateLabel="已发布"
        stateKey="published"
        writable={false}
        assets={[]}
        versions={[{ id: 'v1', version: 1, createdAt: '2026-10-19T12:00:00Z' }]}
        boundScenes={[{ id: 'scene-1', title: '第1场 · 雨夜' }]}
        onTitleChange={vi.fn()}
        onKindChange={vi.fn()}
        onContentChange={vi.fn()}
        onRestoreVersion={onRestoreVersion}
        onGenerate={vi.fn()}
        onOpenScene={onOpenScene}
      />,
    );
    expect(screen.getByRole('heading', { name: '场景生图提示词' })).toBeVisible();
    expect(screen.getByRole('textbox', { name: '提示词' })).toHaveAttribute('readonly');
    fireEvent.click(screen.getByRole('button', { name: '第1场 · 雨夜' }));
    expect(onOpenScene).toHaveBeenCalledWith('scene-1');
    expect(screen.getByText('1 场')).toBeInTheDocument();
    const version = screen.getByText('v1');
    expect(version).not.toBeVisible();
    fireEvent.click(screen.getByText('历史版本 · 1'));
    expect(version).toBeVisible();
    expect(version).toBeDisabled();
    expect(onRestoreVersion).not.toHaveBeenCalled();
  });

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
