import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CharacterSceneWorkspace } from './CharacterSceneWorkspace';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CharacterSceneWorkspace', () => {
  it('shows only a compact audio add control for a saved character', async () => {
    vi.mocked(callWorker).mockResolvedValue([]);
    render(
      <CharacterSceneWorkspace
        projectId="project"
        documentId="character"
        title="阿明"
        kind="character"
        content="角色设定"
        writable
        assets={[]}
        versions={[]}
        onContentChange={vi.fn()}
        onRestoreVersion={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('角色声音'));
    const audio = screen.getByRole('region', { name: '角色音频' });
    await waitFor(() =>
      expect(within(audio).getByRole('button', { name: '添加音频' })).toBeEnabled(),
    );
    expect(within(audio).getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByLabelText('音色 ID')).not.toBeInTheDocument();
    expect(screen.queryByText('视频声音参考')).not.toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('provider.profile.list', {});
    expect(callWorker).not.toHaveBeenCalledWith('characterVoice.list', {});
  });

  it('does not force a scene view count and keeps an optional consistency reference per document', () => {
    const onSceneReferenceChange = vi.fn();
    const props = {
      projectId: 'project',
      documentId: 'courtyard',
      title: '庭院',
      kind: 'scene' as const,
      content: '东门西窗，中央石桌。',
      writable: true,
      assets: [
        {
          id: 'scene-asset',
          projectId: 'project',
          kind: 'scene',
          relativePath: 'assets/scene.png',
          contentHash: 'hash',
          sizeBytes: 1,
          createdAt: '2026-10-29T00:00:00.000Z',
        },
      ],
      versions: [],
      onContentChange: vi.fn(),
      onRestoreVersion: vi.fn(),
      onSceneReferenceChange,
    };
    const { rerender } = render(<CharacterSceneWorkspace {...props} />);
    expect(screen.queryByLabelText('场景参考模式')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('场景参考视图')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('场景一致性参考图'), {
      target: { value: 'scene-asset' },
    });
    expect(onSceneReferenceChange).toHaveBeenLastCalledWith({ referenceAssetId: 'scene-asset' });
    rerender(<CharacterSceneWorkspace {...props} documentId="harbor" writable={false} />);
    expect(screen.getByLabelText('场景一致性参考图')).toHaveValue('');
    expect(screen.getByLabelText('场景一致性参考图')).toBeDisabled();
  });

  it('opens image generation from a prop document without character voice controls', () => {
    render(
      <CharacterSceneWorkspace
        projectId="project"
        documentId="prop-doc"
        title="铁木杖"
        kind="prop"
        content="杖尖包有铁箍。"
        writable
        assets={[]}
        versions={[]}
        onContentChange={vi.fn()}
        onRestoreVersion={vi.fn()}
      />,
    );

    expect(screen.queryByRole('heading', { name: '道具资料' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: '文档类型' })).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '道具资料预览' })).toHaveTextContent(
      '杖尖包有铁箍。',
    );
    expect(screen.queryByRole('button', { name: '生成道具图' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '生成角色图' })).not.toBeInTheDocument();
    expect(screen.queryByText('角色声音')).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '场次绑定' })).not.toBeInTheDocument();
  });

  it('shows bound scene links in read-only mode and keeps history collapsed until needed', () => {
    const onOpenScene = vi.fn();
    const onRestoreVersion = vi.fn();
    render(
      <CharacterSceneWorkspace
        title="庭院"
        kind="scene"
        content="雨后的旧庭院"
        writable={false}
        assets={[]}
        versions={[{ id: 'v1', version: 1, createdAt: '2026-10-19T12:00:00Z' }]}
        boundScenes={[{ id: 'scene-1', title: '第1场 · 雨夜' }]}
        onContentChange={vi.fn()}
        onRestoreVersion={onRestoreVersion}
        onOpenScene={onOpenScene}
      />,
    );
    expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent('雨后的旧庭院');
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

  it.each(['scene', 'prop'] as const)(
    'shows generated %s images inline and enlarges them without navigating to the asset library',
    async (kind) => {
      vi.mocked(callWorker).mockResolvedValue({
        assetId: 'scene-image',
        path: 'D:/Project/assets/images/courtyard.png',
        contentType: 'image/png',
      });
      const onOpenAsset = vi.fn();
      render(
        <CharacterSceneWorkspace
          title="庭院"
          kind={kind}
          content="场景提示词"
          writable
          versions={[]}
          assets={[
            {
              id: 'scene-image',
              projectId: 'project',
              kind,
              relativePath: 'assets/images/courtyard.png',
              alias: '庭院全景',
              contentHash: 'hash',
              sizeBytes: 1024,
              createdAt: 'now',
            },
          ]}
          onContentChange={vi.fn()}
          onRestoreVersion={vi.fn()}
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
    },
  );

  it('starts character and scene documents in preview and returns to preview after editing', () => {
    const props = {
      title: '庭院',
      kind: 'scene' as const,
      content: '雨后的旧庭院',
      writable: true,
      assets: [],
      versions: [],
      onContentChange: vi.fn(),
      onRestoreVersion: vi.fn(),
    };
    const { rerender } = render(<CharacterSceneWorkspace {...props} />);
    const preview = screen.getByRole('region', { name: '提示词预览' });
    expect(preview).toHaveTextContent('雨后的旧庭院');

    fireEvent.click(preview);
    const editor = screen.getByRole('textbox', { name: '提示词' });
    fireEvent.change(editor, { target: { value: '更新后的旧庭院' } });
    rerender(<CharacterSceneWorkspace {...props} content="更新后的旧庭院" />);
    fireEvent.blur(screen.getByRole('textbox', { name: '提示词' }));

    expect(screen.getByRole('region', { name: '提示词预览' })).toHaveTextContent('更新后的旧庭院');
    expect(screen.queryByRole('textbox', { name: '提示词' })).not.toBeInTheDocument();
  });
});
