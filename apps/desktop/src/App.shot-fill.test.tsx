import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  officialVideoAudioContracts,
  type AdapterDescriptor,
  type ShotInfo,
  type ShotReferenceBindingInfo,
} from '@ai-video/contracts';
import { App } from './App';
import { callWorker } from './worker-client';
import { selectWorkerScope } from './worker-scope';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isMaximized: vi.fn().mockResolvedValue(false),
    onResized: vi.fn().mockResolvedValue(() => undefined),
  }),
}));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn().mockResolvedValue(null) }));

afterEach(() => {
  cleanup();
  selectWorkerScope(undefined);
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

it.each(['reference', 'first-frame'] as const)(
  'fills Seedance video from the shot button after saving default cast and a continuity %s',
  async (role) => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
    const contract = officialVideoAudioContracts.find(
      (item) => item.contractId === 'cn.bytedance.seedance2-0.video' && item.contractRevision === 2,
    )!;
    const adapters: AdapterDescriptor[] = (['REFERENCE_TO_VIDEO', 'IMAGE_TO_VIDEO'] as const).map(
      (capability) => ({
        key: `${capability}:unicompapi:${contract.contractId}:contract-2`,
        capability,
        capabilityLabel: capability === 'IMAGE_TO_VIDEO' ? '图生视频' : '参考生视频',
        provider: 'unicompapi',
        providerLabel: 'UniCompAPI',
        model: contract.contractId,
        modelLabel: contract.officialModelName,
        contractId: contract.contractId,
        contractRevision: 2,
        apiVersion: 'contract-2',
        schemaVersion: 1,
        endpoint: 'https://example.test/videos',
        documentationUrl: 'https://example.test/docs',
        credentialProvider: 'unicompapi',
        parameterSchema:
          contract.parameterSchema as unknown as AdapterDescriptor['parameterSchema'],
        uiSchema: { fields: [{ key: 'content', control: 'structured', group: 'basic', order: 1 }] },
      }),
    );
    const project = {
      id: 'project',
      name: 'Shot Fill',
      rootPath: 'D:/ShotFill',
      mode: 'read-write',
      schemaVersion: 72,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const cast = {
      id: 'cast',
      projectId: project.id,
      kind: 'character',
      title: '林澈',
      scopeType: 'project',
      lifecycleStatus: 'active',
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
    };
    const image = {
      id: 'cast-image',
      projectId: project.id,
      kind: 'character',
      relativePath: 'assets/cast.png',
      contentHash: 'cast',
      sizeBytes: 100,
      createdAt: 'now',
    };
    const location = { ...cast, id: 'location', kind: 'scene', title: '旧码头' };
    const sceneImage = {
      ...image,
      id: 'scene-image',
      kind: 'scene',
      relativePath: 'assets/scene.png',
    };
    const frame = {
      ...image,
      id: 'continuity-image',
      kind: 'first-frame',
      relativePath: 'assets/frame.png',
    };
    let shot: ShotInfo = {
      id: 'shot',
      sceneId: 'scene',
      title: '镜头一',
      position: 0,
      status: 'draft',
      prompt: '雨夜里林澈回头',
      rowVersion: 0,
      createdAt: 'now',
      updatedAt: 'now',
      referenceBindings: {
        sceneBindings: [{ sourceDocumentId: location.id, assetId: sceneImage.id }],
      },
      authoringIR: {
        schemaVersion: 1,
        kind: 'shot',
        prompt: '雨夜里林澈回头',
        references: { characterDocumentIds: [cast.id], sceneDocumentIds: [location.id] },
      },
    };
    let finishSave: (() => void) | undefined;
    vi.mocked(callWorker).mockImplementation((async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      if (method === 'health')
        return {
          protocolVersion: 1,
          workerVersion: '0.1.0',
          nodeVersion: 'v22.0.0',
          platform: 'win32',
          arch: 'x64',
          pid: 123,
        };
      if (method === 'sqlite.probe')
        return {
          databasePath: 'probe.sqlite',
          sqliteVersion: '3.50.0',
          journalMode: 'wal',
          writeVerified: true,
        };
      if (method === 'project.current') return project;
      if (method === 'project.runtime.list') return [];
      if (method === 'scene.list')
        return [
          {
            id: 'scene',
            projectId: project.id,
            title: '场次一',
            position: 0,
            rowVersion: 0,
            createdAt: 'now',
            updatedAt: 'now',
          },
        ];
      if (method === 'document.list') return [cast, location];
      if (method === 'shot.list') return [shot];
      if (method === 'shot.references.save') {
        await new Promise<void>((resolve) => {
          finishSave = resolve;
        });
        const referenceBindings = params.referenceBindings as ShotReferenceBindingInfo;
        shot = { ...shot, referenceBindings };
        return { shotId: shot.id, referenceBindings };
      }
      if (method === 'asset.list') return [image, sceneImage, frame];
      if (method === 'scene.media.resolve')
        return {
          characters: [{ characterDocumentId: cast.id, defaultImage: image }],
          voices: [],
          assets: [image, sceneImage, frame],
        };
      if (method === 'asset.thumbnail' || method === 'asset.mediaSource')
        return { assetId: params.assetId, path: 'D:/image.png', contentType: 'image/png' };
      if (method === 'shot.continuity.get')
        return {
          shotId: shot.id,
          rowVersion: 4,
          stale: false,
          videos: [],
          images: [frame],
          binding: {
            sourceShotId: 'previous',
            sourceVideoAssetId: 'video',
            sourceVideoHash: 'hash',
            targetRowVersion: 0,
            mode: 'reference',
            notes: '',
            frames: [{ assetId: 'source-frame', timeMs: 1000 }],
            anchorAssetId: 'source-frame',
            imagePrompt: '静态图提示词',
            referenceAssetId: frame.id,
            referenceRole: role,
            ...(role === 'first-frame' ? { firstFrameAssetId: frame.id } : {}),
          },
        };
      if (method === 'adapter.catalog')
        return {
          capabilities: adapters.map((item) => ({
            key: item.capability,
            label: item.capabilityLabel,
          })),
          providers: [{ key: 'unicompapi', label: 'UniCompAPI' }],
          adapters,
        };
      if (method === 'adapter.resolve')
        return adapters.find((item) => item.capability === params.capability);
      if (method === 'provider.profile.list')
        return [
          {
            id: 'profile',
            name: 'UniCompAPI',
            providerType: 'unicompapi',
            category: 'multi',
            accessType: 'official',
            protocol: 'openai-chat-completions',
            baseUrl: 'https://example.test',
            enabled: true,
            connectionStatus: 'ready',
            createdAt: 'now',
            updatedAt: 'now',
          },
        ];
      if (method === 'provider.model.list')
        return [
          {
            id: 'model',
            providerProfileId: 'profile',
            remoteModelId: 'doubao-seedance-2-0-260128',
            displayName: 'Seedance 2.0',
            enabled: true,
            capabilities: { videoGeneration: true },
            source: 'manual',
            createdAt: 'now',
            updatedAt: 'now',
          },
        ];
      if (method === 'production.read' || method === 'production.compile')
        return {
          target: params.target,
          rowVersion: 0,
          authoringIR: shot.authoringIR,
          parameters: {},
          issues: [],
        };
      if (method === 'generation.draft.get') return null;
      if (method === 'llm.status')
        return {
          provider: 'OpenAI',
          model: 'test',
          configured: false,
          configurationSource: 'none',
        };
      if (method === 'conversation.list' || method === 'task.log.list') return { items: [] };
      return [];
    }) as typeof callWorker);

    const { container } = render(<App />);
    const nav = () => within(screen.getByRole('navigation', { name: '项目导航' }));
    await waitFor(() => expect(nav().getByRole('button', { name: /场次与镜头/ })).toBeEnabled());
    fireEvent.click(nav().getByRole('button', { name: /场次与镜头/ }));
    fireEvent.click(await screen.findByRole('button', { name: /镜头一/ }));
    await screen.findByText('已确认的衔接');
    const fill = screen.getByRole('button', { name: '填充本镜视频表单' });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '填充本镜视频表单' })).toBeEnabled(),
    );
    fireEvent.click(fill);
    await waitFor(() => expect(finishSave).toBeDefined());
    finishSave?.();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '填充本镜视频表单' })).toBeEnabled(),
    );
    expect(container.querySelector('.app-shell')).toHaveAttribute(
      'data-navigation-mode',
      'production',
    );
    expect(screen.getByLabelText('当前制作模式')).toHaveTextContent(
      role === 'first-frame' ? '图生视频' : '参考生视频',
    );
    const form = within(container.querySelector<HTMLElement>('.production-panel')!);
    const prompt = await form.findByRole('textbox', { name: '内容' });
    expect(prompt).toHaveTextContent('雨夜里林澈回头');
    expect(prompt).not.toHaveTextContent('静态图提示词');
    expect(await form.findAllByRole('button', { name: /放大查看/ })).not.toHaveLength(0);
    const imageRoles = form
      .getAllByRole('combobox')
      .map((select) => (select as HTMLSelectElement).value)
      .filter((value) => value === 'first_frame' || value === 'reference_image');
    expect(imageRoles).toEqual([
      'reference_image',
      'reference_image',
      role === 'first-frame' ? 'first_frame' : 'reference_image',
    ]);
    expect(prompt).toHaveTextContent('本段传入3张参考图');
    await waitFor(() =>
      expect(form.getAllByRole('button', { name: /放大查看/ }).length).toBeGreaterThanOrEqual(3),
    );
    const compilation = vi
      .mocked(callWorker)
      .mock.calls.find(([method]) => method === 'production.compile');
    expect(compilation?.[1]).toMatchObject({
      inputImages: [
        { assetId: image.id, role: 'character', label: cast.title },
        { assetId: sceneImage.id, role: 'scene', label: location.title },
        { assetId: frame.id, role, label: 'frame.png' },
      ],
    });
    if (role === 'first-frame') {
      expect(form.getByRole('alert')).toHaveTextContent('不能混用');
      expect(form.getByRole('button', { name: '提交视频任务' })).toBeDisabled();
    } else expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.prepare', expect.anything());
  },
);
