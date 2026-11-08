import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AssetInfo,
  DocumentSummary,
  ProductionReadResult,
  ProductionShotAuthoringIR,
  SceneMediaResolveResult,
} from '@ai-video/contracts';
import {
  ShotWorkspace,
  loadShotReferences,
  saveShotReferences,
  shotReferenceImageSelections,
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
  const onGenerateImage = vi.fn<React.ComponentProps<typeof ShotWorkspace>['onGenerateImage']>();
  const onGenerateVideo = vi.fn<React.ComponentProps<typeof ShotWorkspace>['onGenerateVideo']>();
  const props: React.ComponentProps<typeof ShotWorkspace> = {
    projectId: 'project',
    shotId: 'shot',
    shotTitle: '镜头一',
    shotStatus: 'draft',
    shotPosition: 0,
    authoringIR: { schemaVersion: 1, kind: 'shot', prompt: '雨夜里林澈回头', references: {} },
    prompt: '雨夜里林澈回头',
    writable: true,
    assets: [characterAsset, sceneAsset, firstFrameAsset],
    documents: [characterDoc, sceneDoc],
    storyboardTitle: '',
    storyboardContent: '',
    storyboardBusy: false,
    hasStoryboard: false,
    onPromptChange: vi.fn(),
    onSavePrompt: vi.fn(),
    onGenerateImage,
    onGenerateVideo,
    onStoryboardTitleChange: vi.fn(),
    onStoryboardContentChange: vi.fn(),
    onSaveStoryboard: vi.fn(),
    ...overrides,
  };
  const view = render(<ShotWorkspace {...props} />);
  return { ...view, onGenerateImage, onGenerateVideo, props };
}

describe('shot reference storage', () => {
  it('keeps an explicit first-frame role when that asset is also a character or scene reference', () => {
    const refs = {
      characterAssetIds: ['shared'],
      sceneAssetId: 'shared',
      firstFrameAssetId: 'shared',
      continuityReferenceAssetIds: ['shared', 'detail'],
    };
    expect(shotReferenceImageSelections(refs)).toEqual([
      { assetId: 'shared', role: 'first-frame' },
      { assetId: 'detail', role: 'reference' },
    ]);
    expect(refs.sceneAssetId).toBe('shared');
  });
  it('saves and loads per-shot reference slots', () => {
    saveShotReferences('project', 'shot', { characterAssetId: 'character-asset' });
    expect(loadShotReferences('project', 'shot')).toEqual({
      characterAssetId: 'character-asset',
    });
    expect(loadShotReferences('project', 'other')).toEqual({});
  });
});

describe('ShotWorkspace', () => {
  it('fills every confirmed source image for still generation and every final reference for video', async () => {
    vi.mocked(callWorker).mockImplementation(async (method) => {
      await Promise.resolve();
      if (method === 'shot.continuity.get')
        return {
          shotId: 'shot',
          rowVersion: 3,
          stale: false,
          videos: [],
          images: [characterAsset, sceneAsset, firstFrameAsset],
          binding: {
            selectionVersion: 2,
            sourceImages: [characterAsset, sceneAsset].map((asset) => ({
              assetId: asset.id,
              contentHash: asset.contentHash,
            })),
            sourceVideos: [],
            targetRowVersion: 0,
            mode: 'reference',
            notes: '',
            frames: [],
            anchorAssetId: characterAsset.id,
            referenceAssetIds: [sceneAsset.id, characterAsset.id],
            firstFrameAssetId: firstFrameAsset.id,
            imagePrompt: '独立静态提示词',
          },
        };
      if (method === 'shot.continuity.prompt.save')
        return {
          shotId: 'shot',
          rowVersion: 4,
          stale: false,
          videos: [],
          images: [characterAsset, sceneAsset, firstFrameAsset],
          binding: {
            selectionVersion: 2,
            sourceImages: [characterAsset, sceneAsset].map((asset) => ({
              assetId: asset.id,
              contentHash: asset.contentHash,
            })),
            sourceVideos: [],
            targetRowVersion: 0,
            mode: 'reference',
            notes: '',
            frames: [],
            anchorAssetId: characterAsset.id,
            referenceAssetIds: [sceneAsset.id, characterAsset.id],
            firstFrameAssetId: firstFrameAsset.id,
            imagePrompt: '独立静态提示词',
          },
        };
      if (method === 'scene.media.resolve') return { characters: [], voices: [], assets: [] };
      return [];
    });
    const f = renderWorkspace({ referenceBindings: {} });
    await screen.findByText('已确认的衔接');
    fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
    await waitFor(() => expect(f.onGenerateVideo).toHaveBeenCalledOnce());
    expect(shotReferenceImageSelections(f.onGenerateVideo.mock.calls[0]![0])).toEqual([
      { assetId: firstFrameAsset.id, role: 'first-frame' },
      { assetId: sceneAsset.id, role: 'reference' },
      { assetId: characterAsset.id, role: 'reference' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '填充参考图生图表单', hidden: true }));
    await waitFor(() => expect(f.onGenerateImage).toHaveBeenCalledOnce());
    expect(shotReferenceImageSelections(f.onGenerateImage.mock.calls[0]![0])).toEqual([
      { assetId: characterAsset.id, role: 'reference' },
      { assetId: sceneAsset.id, role: 'reference' },
    ]);
  });
  it('projects bound images into the prompt as labeled thumbnails without saving the projection', async () => {
    saveShotReferences('project', 'shot', {
      characterBindings: [{ characterDocumentId: characterDoc.id, assetId: characterAsset.id }],
      sceneBindings: [{ sourceDocumentId: sceneDoc.id, assetId: sceneAsset.id }],
      characterAssetIds: [characterAsset.id],
      sceneAssetId: sceneAsset.id,
    });
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'asset.thumbnail' || method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: 'assetId' in params ? params.assetId : undefined,
          path: 'D:/ref.png',
          contentType: 'image/png',
        });
      if (method === 'scene.media.resolve')
        return Promise.resolve({ characters: [], voices: [], assets: [] });
      if (method === 'asset.list') return Promise.resolve([]);
      return Promise.resolve([]);
    });
    const onPromptChange = vi.fn();
    renderWorkspace({
      onPromptChange,
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '雨夜里林澈回头',
        references: {
          characterDocumentIds: [characterDoc.id],
          sceneDocumentIds: [sceneDoc.id],
          propDocumentIds: [],
        },
      },
    });

    fireEvent.click(await screen.findByRole('region', { name: '镜头提示词预览' }));
    const prompt = await screen.findByRole('textbox', { name: '镜头提示词' });
    await waitFor(() =>
      expect(prompt).toHaveTextContent('【输入图片说明】（本段传入2张参考图）：'),
    );
    expect(prompt).toHaveTextContent('为角色「林澈」的角色参考图。');
    expect(prompt).toHaveTextContent('为场景「旧码头」的场景参考图。');
    expect(prompt.querySelectorAll('.prompt-reference-chip')).toHaveLength(2);
    expect(onPromptChange).not.toHaveBeenCalled();
  });

  it('shows IR document references separately from image selection state', async () => {
    renderWorkspace({
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '雨夜里林澈回头',
        references: {
          characterDocumentIds: [characterDoc.id, 'missing-character'],
          sceneDocumentIds: [sceneDoc.id],
          propDocumentIds: ['missing-prop'],
        },
      },
    });

    const summary = await screen.findByRole('region', { name: '提示词资料引用' });
    expect(within(summary).getByText('林澈')).toBeInTheDocument();
    expect(within(summary).getByText('旧码头')).toBeInTheDocument();
    expect(within(summary).getAllByText('资料不可用')).toHaveLength(2);
    expect(summary).not.toHaveTextContent('未选择');
    expect(screen.getAllByRole('option', { name: '未选择' }).length).toBeGreaterThan(0);
  });

  it('shows progress and prevents duplicate clicks while resolving references for the form', async () => {
    const pendingReads: Array<(value: ProductionReadResult) => void> = [];
    let finishMedia: ((value: SceneMediaResolveResult) => void) | undefined;
    const mediaCharacters = [
      { characterDocumentId: characterDoc.id, defaultImage: characterAsset },
    ];
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'production.read')
        return new Promise<ProductionReadResult>((resolve) => pendingReads.push(resolve));
      if (method === 'scene.media.resolve') {
        const ids = (params as { characterDocumentIds?: string[] }).characterDocumentIds ?? [];
        if (!ids.length) return Promise.resolve({ characters: [], voices: [], assets: [] });
        return new Promise<SceneMediaResolveResult>((resolve) => {
          finishMedia = resolve;
        });
      }
      if (method === 'asset.mediaSource' || method === 'asset.thumbnail')
        return Promise.resolve({
          assetId: 'assetId' in params ? params.assetId : undefined,
          path: 'D:/ref.png',
          contentType: 'image/png',
        });
      return Promise.resolve([]);
    });
    const { onGenerateImage } = renderWorkspace({
      documents: [characterDoc],
      authoringIR: undefined,
    });
    await waitFor(() => expect(pendingReads).toHaveLength(1));
    pendingReads[0]!({
      target: { kind: 'shot', id: 'shot' },
      rowVersion: 1,
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '当前镜头',
        references: { characterDocumentIds: [characterDoc.id] },
      },
      issues: [],
    });
    await screen.findByLabelText('林澈角色参考图');
    await waitFor(() => expect(pendingReads).toHaveLength(1));

    const fillButton = screen.getByRole('button', { name: '填充本镜图片表单' });
    fireEvent.click(fillButton);
    expect(await screen.findByRole('status')).toHaveTextContent('正在解析本镜绑定并填充画面表单');
    await waitFor(() => expect(fillButton).toBeDisabled());
    fireEvent.click(fillButton);
    finishMedia?.({
      characters: mediaCharacters,
      voices: [],
      assets: [characterAsset],
    });

    await waitFor(() => expect(onGenerateImage).toHaveBeenCalledOnce());
    expect(screen.queryByText(/正在解析本镜绑定/)).not.toBeInTheDocument();
  });

  it.each([
    ['image', '填充本镜图片表单'],
    ['video', '填充本镜视频表单'],
  ] as const)('%s opens its form before reference saving completes', async (mode, buttonName) => {
    if (mode === 'video')
      saveShotReferences('project', 'shot', { firstFrameAssetId: firstFrameAsset.id });
    let finishBindingSave: (() => void) | undefined;
    const onPrepareGenerate = vi.fn();
    const onSaveReferenceBindings = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishBindingSave = resolve;
        }),
    );
    const { onGenerateImage, onGenerateVideo } = renderWorkspace({
      onPrepareGenerate,
      onSaveReferenceBindings,
    });

    fireEvent.click(screen.getByRole('button', { name: buttonName }));

    expect(onPrepareGenerate).toHaveBeenCalledWith(mode, '雨夜里林澈回头', expect.any(Object));
    expect(await screen.findByRole('status')).toHaveTextContent('正在解析本镜绑定');
    await waitFor(() => expect(onSaveReferenceBindings).toHaveBeenCalledOnce());
    expect(onGenerateImage).not.toHaveBeenCalled();
    expect(onGenerateVideo).not.toHaveBeenCalled();

    finishBindingSave?.();
    await waitFor(() => {
      if (mode === 'image') expect(onGenerateImage).toHaveBeenCalledOnce();
      else expect(onGenerateVideo).toHaveBeenCalledOnce();
    });
  });

  it.each(
    (['scoped', 'all-visible', 'legacy', 'empty'] as const).flatMap((state) =>
      (['image', 'video'] as const).map((mode) => ({ state, mode })),
    ),
  )('scopes automatic references for $mode production ($state)', async ({ state, mode }) => {
    const otherDoc = { ...characterDoc, id: 'absent', title: '顾清影' };
    const otherImage = {
      ...characterAsset,
      id: 'absent-image',
      relativePath: 'assets/absent.png',
    };
    vi.mocked(callWorker).mockImplementation(((method: string, params: { assetId?: string }) => {
      if (method === 'production.read')
        return Promise.resolve({
          authoringIR: {
            schemaVersion: 1,
            kind: 'shot',
            prompt: state === 'all-visible' ? '收尾顾清影出现在二楼栏边。' : '当前镜头',
            ...(state === 'legacy'
              ? {}
              : {
                  references: {
                    characterDocumentIds:
                      state === 'empty'
                        ? []
                        : state === 'all-visible'
                          ? [characterDoc.id, otherDoc.id]
                          : [characterDoc.id],
                  },
                }),
          },
          issues: [],
        });
      if (method === 'scene.media.resolve')
        return Promise.resolve({
          characters: [
            { characterDocumentId: characterDoc.id, defaultImage: characterAsset },
            { characterDocumentId: otherDoc.id, defaultImage: otherImage },
          ],
          voices: [],
          assets: [characterAsset, otherImage],
        });
      if (method === 'asset.mediaSource')
        return Promise.resolve({
          assetId: params.assetId,
          path: 'D:/ref.png',
          contentType: 'image/png',
        });
      return Promise.resolve([]);
    }) as typeof callWorker);
    const { onGenerateImage, onGenerateVideo } = renderWorkspace({
      authoringIR: undefined,
      ...(state === 'legacy'
        ? {
            referenceBindings: {
              characterBindings: [
                { characterDocumentId: characterDoc.id, assetId: characterAsset.id },
                { characterDocumentId: otherDoc.id, assetId: otherImage.id },
              ],
            },
          }
        : {}),
      documents: [characterDoc, otherDoc],
    });
    if (state !== 'empty')
      await screen.findByLabelText(`${state === 'scoped' ? '林澈' : '顾清影'}角色参考图`);
    const generate = screen.getByRole('button', {
      name: mode === 'image' ? '填充本镜图片表单' : '填充本镜视频表单',
    });
    if (mode === 'video' && state === 'empty') {
      expect(generate).toBeDisabled();
      expect(onGenerateVideo).not.toHaveBeenCalled();
      expect(loadShotReferences('project', 'shot')).toEqual({});
      return;
    }
    await waitFor(() => expect(generate).toBeEnabled());
    fireEvent.click(generate);
    const expected =
      state === 'legacy' || state === 'all-visible'
        ? [characterAsset.id, otherImage.id]
        : state === 'empty'
          ? []
          : [characterAsset.id];
    const callback = mode === 'image' ? onGenerateImage : onGenerateVideo;
    await waitFor(() => expect(callback).toHaveBeenCalledOnce());
    if (state === 'empty') {
      expect(callback.mock.calls.at(-1)?.[0]).toEqual({});
    } else {
      expect(callback.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({ characterAssetIds: expected }),
      );
    }
    expect(loadShotReferences('project', 'shot')).toEqual({});
    if (state !== 'empty')
      expect(
        screen.getByLabelText(`${state === 'scoped' ? '林澈' : '顾清影'}角色参考图`),
      ).toBeInTheDocument();
  });

  it('keeps confirmed continuity frames when opening image production from the ordinary shot action', async () => {
    vi.mocked(callWorker).mockImplementation((method) =>
      Promise.resolve(
        method === 'shot.continuity.get'
          ? {
              shotId: 'shot',
              rowVersion: 3,
              stale: false,
              videos: [],
              images: [firstFrameAsset],
              binding: {
                sourceShotId: 'previous',
                sourceVideoAssetId: 'video',
                sourceVideoHash: 'hash',
                targetRowVersion: 0,
                mode: 'reframe',
                notes: '',
                frames: [{ assetId: firstFrameAsset.id, timeMs: 1000 }],
                anchorAssetId: firstFrameAsset.id,
                imagePrompt: '保留桥柱旁站位，调整为近景。',
              },
            }
          : method === 'scene.media.resolve'
            ? { characters: [], voices: [], assets: [] }
            : method === 'asset.mediaSource'
              ? { assetId: firstFrameAsset.id, path: 'D:/frame.png', contentType: 'image/png' }
              : [],
      ),
    );
    const { onGenerateImage } = renderWorkspace();
    await screen.findByText('已确认的衔接');
    fireEvent.click(screen.getByRole('button', { name: '填充本镜图片表单' }));
    await waitFor(() =>
      expect(onGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          firstFrameAssetId: undefined,
          continuityRowVersion: 3,
          continuityPrompt: '保留桥柱旁站位，调整为近景。',
          continuityReferenceAssetIds: [firstFrameAsset.id],
        }),
        expect.any(String),
      ),
    );
  });
  it('explains why video fill stops after a prompt edit until the saved frame is reconfirmed', async () => {
    let context = {
      shotId: 'shot',
      rowVersion: 3,
      currentShotRowVersion: 2,
      stale: true,
      reconfirmable: true,
      videos: [],
      images: [firstFrameAsset],
      binding: {
        sourceShotId: 'previous',
        sourceVideoAssetId: 'video',
        sourceVideoHash: 'hash',
        targetRowVersion: 1,
        mode: 'continue',
        notes: '',
        frames: [{ assetId: firstFrameAsset.id, timeMs: 1000 }],
        anchorAssetId: firstFrameAsset.id,
        firstFrameAssetId: firstFrameAsset.id,
      },
    };
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'shot.continuity.reconfirm') {
        expect(params).toEqual({
          shotId: 'shot',
          expectedRowVersion: 3,
          expectedTargetRowVersion: 2,
        });
        context = {
          ...context,
          rowVersion: 4,
          stale: false,
          reconfirmable: false,
          binding: { ...context.binding, targetRowVersion: 2 },
        };
        return Promise.resolve(context);
      }
      return Promise.resolve(
        method === 'shot.continuity.get'
          ? context
          : method === 'scene.media.resolve'
            ? { characters: [], voices: [], assets: [] }
            : [],
      );
    });
    const { onGenerateVideo } = renderWorkspace();
    await screen.findByText('确认沿用现有选帧');
    fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
    expect(
      await screen.findByText('镜头提示词已变化，请在镜头衔接中确认沿用现有选帧后再填充。'),
    ).toBeVisible();
    expect(onGenerateVideo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认沿用现有选帧' }));
    await screen.findByText('已确认沿用现有选帧，可以填充本镜视频表单。');
    fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
    await waitFor(() => expect(onGenerateVideo).toHaveBeenCalledOnce());
    expect(onGenerateVideo.mock.calls[0]?.[0]).toMatchObject({
      continuityRowVersion: 4,
      firstFrameAssetId: firstFrameAsset.id,
    });
  });
  it.each(['reference', 'first-frame'] as const)(
    'keeps the live continuity %s fillable after ordinary reference bindings are refreshed',
    async (role) => {
      vi.mocked(callWorker).mockImplementation((method) =>
        Promise.resolve(
          method === 'shot.continuity.get'
            ? {
                shotId: 'shot',
                rowVersion: 4,
                stale: false,
                videos: [],
                images: [firstFrameAsset],
                binding: {
                  sourceShotId: 'previous',
                  sourceVideoAssetId: 'video',
                  sourceVideoHash: 'hash',
                  targetRowVersion: 0,
                  mode: 'reference',
                  notes: '',
                  frames: [{ assetId: 'source-frame', timeMs: 1000 }],
                  anchorAssetId: 'source-frame',
                  referenceAssetId: firstFrameAsset.id,
                  referenceRole: role,
                  ...(role === 'first-frame' ? { firstFrameAssetId: firstFrameAsset.id } : {}),
                },
              }
            : method === 'scene.media.resolve'
              ? { characters: [], voices: [], assets: [] }
              : [],
        ),
      );
      const view = renderWorkspace({ referenceBindings: {} });
      await screen.findByText('已确认的衔接');
      const fill = screen.getByRole('button', { name: '填充本镜视频表单' });
      await waitFor(() => expect(fill).toBeEnabled());
      view.rerender(<ShotWorkspace {...view.props} referenceBindings={{}} />);
      await waitFor(() => expect(fill).toBeEnabled());
      fireEvent.click(fill);
      await waitFor(() => expect(view.onGenerateVideo).toHaveBeenCalledOnce());
      expect(shotReferenceImageSelections(view.onGenerateVideo.mock.calls[0]![0])).toContainEqual({
        assetId: firstFrameAsset.id,
        role,
      });
    },
  );

  it.each(['provided', 'loaded'] as const)(
    'finishes filling after resolving a default character and receiving the saved bindings (%s IR)',
    async (irSource) => {
      let finishSave: (() => void) | undefined;
      const authoringIR: ProductionShotAuthoringIR = {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '雨夜里林澈回头',
        references: { characterDocumentIds: [characterDoc.id] },
      };
      vi.mocked(callWorker).mockImplementation((method) =>
        Promise.resolve(
          method === 'scene.media.resolve'
            ? {
                characters: [
                  { characterDocumentId: characterDoc.id, defaultImage: characterAsset },
                ],
                voices: [],
                assets: [characterAsset],
              }
            : method === 'production.read'
              ? { target: { kind: 'shot', id: 'shot' }, rowVersion: 0, authoringIR, issues: [] }
              : [],
        ),
      );
      const view = renderWorkspace({
        authoringIR: irSource === 'provided' ? authoringIR : undefined,
        onSaveReferenceBindings: (bindings) =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }).then(() => {
            view.rerender(
              <ShotWorkspace {...view.props} referenceBindings={bindings ?? undefined} />,
            );
          }),
      });
      const fill = screen.getByRole('button', { name: '填充本镜视频表单' });
      await waitFor(() => expect(fill).toBeEnabled());
      fireEvent.click(fill);
      await waitFor(() => expect(finishSave).toBeDefined());
      finishSave?.();
      await waitFor(() => expect(view.onGenerateVideo).toHaveBeenCalledOnce());
      expect(view.onGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({ characterAssetIds: [characterAsset.id] }),
        expect.any(String),
      );
    },
  );

  it.each(['project', 'shot', 'references', 'prompt'] as const)(
    'discards a pending fill when its %s changes',
    async (changed) => {
      let finishSave: (() => void) | undefined;
      const onPrepareGenerate = vi.fn();
      const view = renderWorkspace({
        referenceBindings: { firstFrameAssetId: firstFrameAsset.id },
        onPrepareGenerate,
        onSaveReferenceBindings: () =>
          new Promise<void>((resolve) => {
            finishSave = resolve;
          }),
      });
      fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
      await waitFor(() => expect(finishSave).toBeDefined());
      expect(onPrepareGenerate).toHaveBeenCalledOnce();
      view.rerender(
        <ShotWorkspace
          {...view.props}
          {...(changed === 'project'
            ? { projectId: 'next-project' }
            : changed === 'shot'
              ? { shotId: 'next-shot' }
              : changed === 'references'
                ? { referenceBindings: { firstFrameAssetId: sceneAsset.id } }
                : { prompt: '新的镜头内容' })}
        />,
      );
      finishSave?.();
      await waitFor(() =>
        expect(screen.queryByText('正在解析本镜绑定并填充视频表单…')).not.toBeInTheDocument(),
      );
      expect(view.onGenerateVideo).not.toHaveBeenCalled();
      expect(onPrepareGenerate).toHaveBeenCalledOnce();
    },
  );
  it.each(['reference', 'first-frame'] as const)(
    'fills the existing video form with a bound continuity image as %s and keeps the video prompt',
    async (role) => {
      vi.mocked(callWorker).mockImplementation((method, params) =>
        Promise.resolve(
          method === 'shot.continuity.get'
            ? {
                shotId: 'shot',
                rowVersion: 4,
                stale: false,
                videos: [],
                images: [firstFrameAsset],
                binding: {
                  sourceShotId: 'previous',
                  sourceVideoAssetId: 'video',
                  sourceVideoHash: 'hash',
                  targetRowVersion: 0,
                  mode: 'reference',
                  notes: '转身后的中间画面',
                  frames: [{ assetId: 'source-frame', timeMs: 1000 }],
                  anchorAssetId: 'source-frame',
                  imagePrompt: '仅用于生成静态参考图',
                  referenceAssetId: firstFrameAsset.id,
                  referenceRole: role,
                  firstFrameAssetId: role === 'first-frame' ? firstFrameAsset.id : undefined,
                },
              }
            : method === 'scene.media.resolve'
              ? { characters: [], voices: [], assets: [] }
              : method === 'asset.mediaSource'
                ? {
                    assetId: (params as { assetId: string }).assetId,
                    path: 'D:/frame.png',
                    contentType: 'image/png',
                  }
                : [],
        ),
      );
      const { onGenerateVideo } = renderWorkspace();
      await screen.findByText('已确认的衔接');
      fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
      await waitFor(() => expect(onGenerateVideo).toHaveBeenCalledOnce());
      const [refs, prompt] = onGenerateVideo.mock.calls[0]!;
      expect(refs.continuityPrompt).toBeUndefined();
      expect(prompt).toContain('雨夜里林澈回头');
      expect(prompt).not.toContain('仅用于生成静态参考图');
      expect(shotReferenceImageSelections(refs)).toContainEqual({
        assetId: firstFrameAsset.id,
        role,
      });
      expect(
        shotReferenceImageSelections(refs).some((image) => image.assetId === 'source-frame'),
      ).toBe(false);
    },
  );

  it("shows only this shot's declared cast and generates with its resolved character images", async () => {
    const otherCharacter = { ...characterDoc, id: 'other-character', title: '沈舟' };
    const otherImage = { ...characterAsset, id: 'other-image', relativePath: 'assets/other.png' };
    const savedImage = { ...sceneAsset, id: 'saved-scene-image' };
    const media = {
      characters: [
        { characterDocumentId: characterDoc.id, defaultImage: characterAsset },
        { characterDocumentId: otherCharacter.id, defaultImage: otherImage },
      ],
      voices: [],
      assets: [characterAsset, otherImage, savedImage],
    };
    vi.mocked(callWorker).mockImplementation((method, params) =>
      Promise.resolve(
        method === 'scene.media.resolve'
          ? media
          : method === 'asset.mediaSource'
            ? {
                assetId: (params as { assetId: string }).assetId,
                path: 'D:/ref.png',
                contentType: 'image/png',
              }
            : [],
      ),
    );
    const { onGenerateVideo } = renderWorkspace({
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '林澈和沈舟在旧码头对峙。',
        references: {
          characterDocumentIds: [characterDoc.id, otherCharacter.id],
          sceneDocumentIds: [sceneDoc.id],
          propDocumentIds: [],
        },
      },
      referenceBindings: {
        characterBindings: [
          { characterDocumentId: characterDoc.id, assetId: characterAsset.id },
          { characterDocumentId: otherCharacter.id, assetId: otherImage.id },
        ],
        sceneBindings: [{ sourceDocumentId: sceneDoc.id, assetId: savedImage.id }],
      },
      documents: [characterDoc, otherCharacter, sceneDoc],
      assets: [],
    });
    expect(await screen.findByRole('img', { name: 'lin.png' })).toBeInTheDocument();
    expect(await screen.findByRole('img', { name: 'other.png' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: '本镜角色绑定' })).toHaveLength(1);
    expect(screen.queryByLabelText('角色参考')).not.toBeInTheDocument();
    expect(screen.getByLabelText('场景参考')).toHaveValue(savedImage.id);
    fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
    await waitFor(() =>
      expect(onGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({
          characterAssetIds: [characterAsset.id, otherImage.id],
          sceneAssetId: savedImage.id,
        }),
        expect.any(String),
      ),
    );
    expect(loadShotReferences('project', 'shot')).toEqual({});
  });

  it('shows generated shot images inline and opens an enlarged preview', async () => {
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'asset.list') return Promise.resolve([firstFrameAsset]);
      if (method === 'asset.mediaSource' || method === 'asset.thumbnail')
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
      '/worker-media/first-frame-asset?thumbnail=1',
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
  it('uses the declared shot scene ID without persisting a default-image override or using a same-title document', async () => {
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
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '远景，人物走过庭院',
        references: { characterDocumentIds: [], sceneDocumentIds: [sceneDoc.id] },
      },
      assets: [],
      documents: [{ ...sceneDoc, id: 'same-title-other-document' }, sceneDoc],
    });
    await waitFor(() => expect(screen.getByLabelText('场景参考')).toHaveValue(sceneAsset.id));
    fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
    await waitFor(() =>
      expect(onGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({ sceneAssetId: sceneAsset.id }),
        expect.any(String),
      ),
    );
    expect(loadShotReferences('project', 'shot').sceneAssetId).toBeUndefined();
    expect(callWorker).not.toHaveBeenCalledWith(
      'asset.list',
      expect.objectContaining({ sourceDocumentId: 'same-title-other-document' }),
    );
  });

  it('keeps an explicit shot image override and can restore its declared scene default', async () => {
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
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '庭院远景',
        references: { characterDocumentIds: [], sceneDocumentIds: [sceneDoc.id] },
      },
      prompt: '庭院远景',
    });
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'asset.list',
        expect.objectContaining({ sourceDocumentId: sceneDoc.id }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
    await waitFor(() =>
      expect(onGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({ sceneAssetId: firstFrameAsset.id }),
        expect.any(String),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: '恢复默认场景图' }));
    await waitFor(() => expect(screen.getByLabelText('场景参考')).toHaveValue(sceneAsset.id));
    fireEvent.click(screen.getByRole('button', { name: '清除' }));
    expect(screen.getByLabelText('场景参考')).toHaveValue('');
    expect(loadShotReferences('project', 'shot').ignoreSceneBinding).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '恢复默认场景图' }));
    expect(screen.getByLabelText('场景参考')).toHaveValue(sceneAsset.id);
  });

  it('ignores a stale default image when this shot changes its declared scene reference', async () => {
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
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '旧码头',
        references: { sceneDocumentIds: [sceneDoc.id] },
      },
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
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '书房特写',
        references: { sceneDocumentIds: [nextDoc.id] },
      },
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
    fireEvent.click(screen.getByRole('button', { name: '填充本镜图片表单' }));
    await waitFor(() =>
      expect(onGenerateImage).toHaveBeenCalledWith(expect.anything(), expect.any(String)),
    );
    expect(onGenerateImage.mock.calls.at(-1)?.[0]).toEqual({});
    expect(onGenerateImage.mock.calls.at(-1)?.[1]).toContain('[角色:林澈]');
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

  it('sends a binding-repair request for only the current shot prompt', async () => {
    const onRepairBindings = vi.fn().mockResolvedValue(undefined);
    renderWorkspace({
      prompt: '林澈在旧码头拿起收音机。',
      onRepairBindings,
    });

    fireEvent.click(screen.getByRole('button', { name: '修复绑定' }));

    await waitFor(() => expect(onRepairBindings).toHaveBeenCalledWith('林澈在旧码头拿起收音机。'));
    expect(await screen.findByText('修复请求已发送到会话。')).toBeVisible();
  });

  it('keeps generate-video disabled until a reference or mention exists', () => {
    renderWorkspace();
    expect(screen.getByRole('button', { name: '填充本镜视频表单' })).toBeDisabled();
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
    expect(screen.getByRole('button', { name: '填充本镜视频表单' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '填充本镜视频表单' }));
    await waitFor(() =>
      expect(onGenerateVideo).toHaveBeenCalledWith(
        expect.objectContaining({ firstFrameAssetId: 'first-frame-asset' }),
        expect.any(String),
      ),
    );
  });
});
