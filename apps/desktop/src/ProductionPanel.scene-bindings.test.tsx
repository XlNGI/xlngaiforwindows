import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterDescriptor,
  SceneInfo,
  VideoGenerationPrepareParams,
  ProductionCompileResult,
} from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { callWorker } from './worker-client';
import { open as openAudioDialog } from '@tauri-apps/plugin-dialog';
import { officialVideoAudioContracts } from '@ai-video/contracts';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const mediaSchema = (contractId: string, revision: number) =>
  (
    officialVideoAudioContracts.find(
      (c) => c.contractId === contractId && c.contractRevision === revision,
    )!.parameterSchema as unknown as AdapterDescriptor['parameterSchema']
  ).properties.media!;
const adapter: AdapterDescriptor = {
  key: 'REFERENCE_TO_VIDEO:wan-video:cn.qwen.wan3-0-video:contract-3',
  capability: 'REFERENCE_TO_VIDEO',
  capabilityLabel: '参考生视频',
  provider: 'wan-video',
  providerLabel: '万相',
  model: 'cn.qwen.wan3-0-video',
  modelLabel: 'Wan 3.0',
  apiVersion: 'contract-3',
  schemaVersion: 3,
  contractId: 'cn.qwen.wan3-0-video',
  contractRevision: 3,
  endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis',
  documentationUrl: 'https://help.aliyun.com',
  credentialProvider: 'wan-video',
  parameterSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: {
      prompt: { type: 'string', title: '提示词' },
      media: {
        ...mediaSchema('cn.qwen.wan3-0-video', 3),
        title: '素材',
      },
      duration: { type: 'integer', title: '时长', default: 5 },
    },
  },
  uiSchema: { fields: [] },
};
const drivingAdapter: AdapterDescriptor = {
  ...adapter,
  key: 'REFERENCE_TO_VIDEO:wan-video:cn.qwen.wan2-7-i2v:contract-2',
  model: 'cn.qwen.wan2-7-i2v',
  apiVersion: 'contract-2',
  contractId: 'cn.qwen.wan2-7-i2v',
  contractRevision: 2,
  parameterSchema: {
    ...adapter.parameterSchema,
    properties: {
      ...adapter.parameterSchema.properties,
      media: mediaSchema('cn.qwen.wan2-7-i2v', 2),
    },
  },
};
const voice = {
  id: 'voice',
  projectId: 'project',
  characterDocumentId: 'actor',
  characterName: '林澈',
  versionId: 'voice-v1',
  revision: 1,
  rowVersion: 1,
  audioId: 'sample',
  audioName: '声音样本',
  durationMs: 3000,
  sizeBytes: 100,
  mime: 'audio/wav',
};
const scene: SceneInfo = {
  id: 'scene',
  projectId: 'project',
  title: '第一场',
  position: 0,
  rowVersion: 1,
  createdAt: 'now',
  updatedAt: 'now',
  characterBindings: [{ characterDocumentId: 'actor', voiceReferenceVersionId: 'voice-v1' }],
};
const dialogue = {
  id: 'dialogue',
  projectId: 'project',
  kind: 'imported-dialogue',
  name: '完整对白',
  relativePath: 'assets/audio/dialogue.wav',
  mime: 'audio/wav',
  sizeBytes: 100,
  contentHash: 'a'.repeat(64),
  durationMs: 3000,
  sampleRate: 48000,
  channels: 1,
  createdAt: 'now',
};
function mock(
  sceneValue: SceneInfo,
  descriptor = adapter,
  audioImport: Promise<unknown> = Promise.resolve({ audio: dialogue }),
) {
  vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) => {
    if (method === 'production.compile' || method === 'production.read')
      return Promise.resolve({ target: params.target, rowVersion: 1, parameters: {}, issues: [] });
    if (method === 'adapter.catalog')
      return Promise.resolve({
        capabilities: [{ key: 'REFERENCE_TO_VIDEO', label: '参考生视频' }],
        providers: [{ key: descriptor.provider, label: '万相' }],
        adapters: [descriptor],
      });
    if (method === 'provider.profile.list')
      return Promise.resolve([
        {
          id: 'profile',
          name: '万相',
          category: 'video',
          providerType: descriptor.provider,
          accessType: 'official',
          protocol: descriptor.provider === 'unicompapi' ? 'openai-chat-completions' : 'wan-video',
          baseUrl:
            descriptor.provider === 'unicompapi'
              ? 'https://unicompapi.com/v1'
              : 'https://dashscope.aliyuncs.com',
          enabled: true,
          connectionStatus: 'ready',
          createdAt: 'now',
          updatedAt: 'now',
        },
      ]);
    if (method === 'provider.model.list')
      return Promise.resolve([
        {
          id: 'model',
          providerProfileId: 'profile',
          remoteModelId: descriptor.contractId?.includes('wan2-7')
            ? 'wan2.7-i2v-2026-04-25'
            : 'wan3.0-video',
          displayName: 'Wan 3.0',
          contractId: descriptor.contractId,
          contractStatus: 'enabled',
          enabled: true,
          source: 'built-in',
          capabilities: { videoGeneration: true },
          createdAt: 'now',
          updatedAt: 'now',
        },
      ]);
    if (method === 'adapter.resolve') return Promise.resolve(descriptor);
    if (method === 'asset.thumbnail' || method === 'asset.mediaSource')
      return Promise.resolve({
        assetId: params.assetId,
        path: 'D:/image.png',
        contentType: 'image/png',
      });
    if (method === 'scene.list')
      return Promise.resolve([sceneValue, { ...sceneValue, id: 'next-scene' }]);
    if (method === 'scene.save')
      return Promise.resolve({
        ...sceneValue,
        dialogueAudioId: params.dialogueAudioId,
        rowVersion: 2,
      });
    if (method === 'audio.import') return audioImport;
    if (method === 'characterVoiceReference.list') return Promise.resolve([voice]);
    if (method === 'audio.get')
      return Promise.resolve({
        id: 'dialogue',
        projectId: 'project',
        kind: 'imported-dialogue',
        name: '完整对白',
        relativePath: 'assets/audio/dialogue.wav',
        mime: 'audio/wav',
        sizeBytes: 100,
        contentHash: 'a'.repeat(64),
        durationMs: 3000,
        sampleRate: 48000,
        channels: 1,
        createdAt: 'now',
      });
    if (method === 'asset.list' || method === 'video.generate.list') return Promise.resolve([]);
    if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
    if (method === 'video.generate.prepare')
      return Promise.resolve({ id: 'pending', status: 'pending' });
    if (method === 'media.generation.requestSubmission')
      return Promise.resolve({
        job: { id: 'pending' },
        confirmation: {
          confirmationToken: 'token',
          jobId: 'pending',
          kind: 'video',
          draftVersion: 1,
          providerName: '万相',
          modelName: 'Wan 3.0',
          adapterKey: descriptor.key,
          parameterSummary: [],
          costNotice: { required: true, summary: '可能产生费用' },
          expiresAt: '2099-01-01',
        },
      });
    throw new Error(`Unexpected method ${method}`);
  }) as typeof callWorker);
}

describe('scene production bindings', () => {
  it('shows authoring uncertainties without a blocking issue and submits the editable form', async () => {
    mock(scene);
    const fallback = vi.mocked(callWorker).getMockImplementation()!;
    vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) =>
      method === 'production.compile'
        ? Promise.resolve({
            target: { kind: 'shot', id: 'shot' },
            rowVersion: 1,
            source: {
              target: { kind: 'shot', id: 'shot' },
              instructionId: 'instruction',
              revision: 1,
              token: 'a'.repeat(64),
            },
            parameters: { prompt: '人物转身离去' },
            issues: [],
            notices: [
              {
                code: 'CHARACTER_DETAIL_REVIEW',
                message: '人物描述与锁定要求的断臂侧别不同，请核实。',
              },
            ],
          })
        : fallback(method as never, params)) as typeof callWorker);
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        shotId="shot"
        writable
      />,
    );
    expect(await screen.findByLabelText('镜头内容提醒')).toBeVisible();
    fireEvent.change(screen.getByRole('textbox', { name: '提示词' }), {
      target: { value: '老瞎子以右手探杖，确认门槛后迈步。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(callWorker)
          .mock.calls.find(([method]) => method === 'video.generate.prepare')?.[1],
      ).toMatchObject({
        parameters: { prompt: '老瞎子以右手探杖，确认门槛后迈步。' },
      }),
    );
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.some(([method]) => method === 'media.generation.confirmSubmission'),
    ).toBe(false);
  });

  it('reaches video preparation with the same selected images used to compile a shot', async () => {
    mock({ ...scene, characterBindings: [] });
    const fallback = vi.mocked(callWorker).getMockImplementation()!;
    const inputImages = [
      { assetId: 'actor-image', role: 'character' as const },
      { assetId: 'scene-image', role: 'scene' as const },
    ];
    const source = {
      target: { kind: 'shot' as const, id: 'shot' },
      instructionId: 'instruction',
      revision: 1,
      token: 'b'.repeat(64),
      inputImages,
    };
    vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) => {
      if (method !== 'production.compile') return fallback(method as never, params);
      const matches = JSON.stringify(params.inputImages) === JSON.stringify(inputImages);
      if (params.expectedToken && !matches)
        return Promise.reject(new Error('制作来源已变化，请重新适配。'));
      return Promise.resolve({
        target: source.target,
        rowVersion: 1,
        source: { ...source, token: matches ? source.token : 'a'.repeat(64) },
        issues: [],
        parameters: {
          prompt: '人物雨中独立',
          duration: 8,
          media: inputImages.map((image) => ({
            type: 'reference_image',
            url: 'project-asset://' + image.assetId,
          })),
        },
      });
    }) as typeof callWorker);
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        shotId="shot"
        seedImageBindings={inputImages}
        writable
      />,
    );
    await screen.findByText('已填入制作内容 · 版本 1');
    expect(await screen.findAllByRole('img')).toHaveLength(2);
    expect(screen.queryByDisplayValue(/project-asset:\/\//)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
      ).toBe(true),
    );
    const prepared = vi
      .mocked(callWorker)
      .mock.calls.find(
        ([method]) => method === 'video.generate.prepare',
      )![1] as VideoGenerationPrepareParams;
    expect(prepared.productionSource).toEqual({ ...source, mode: 'form' });
    expect(prepared.parameters.media).toEqual(
      inputImages.map((image) => ({
        type: 'reference_image',
        url: 'project-asset://' + image.assetId,
      })),
    );
    expect(screen.queryByText('制作来源已变化，请重新适配。')).not.toBeInTheDocument();
  });
  it('shows nonblocking schema notices and does not force stored voice or dialogue inputs into native audio production', async () => {
    const sceneValue = { ...scene, dialogueAudioId: dialogue.id };
    mock(sceneValue);
    const fallback = vi.mocked(callWorker).getMockImplementation()!;
    const result: ProductionCompileResult = {
      target: { kind: 'scene', id: scene.id },
      rowVersion: 1,
      source: {
        target: { kind: 'scene', id: scene.id },
        instructionId: 'native',
        revision: 1,
        token: 'a'.repeat(64),
      },
      parameters: { prompt: '模型生成雨声及对白', duration: 8 },
      issues: [],
      notices: [
        {
          code: 'MODEL_PARAMETER_NOT_APPLIED',
          message: '当前模型没有扩写参数，本次不传入该设置。',
        },
      ],
      instruction: {
        version: 1,
        summary: '雨夜对白',
        subjects: [],
        visual: {},
        beats: [],
        audio: { mode: 'native' },
        generation: {},
        resources: [],
        continuity: { predecessors: [], before: [], after: [], locked: [], constraints: [] },
      },
      sceneInputs: {
        scene: sceneValue,
        media: {
          assets: [],
          voices: [voice],
          characters: [{ characterDocumentId: 'actor', voice }],
        },
        characterNames: { actor: '林澈' },
      },
    };
    vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) =>
      method === 'production.compile' || method === 'production.read'
        ? Promise.resolve(result)
        : fallback(method as never, params)) as typeof callWorker);
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        sceneId="scene"
        writable
      />,
    );
    expect(await screen.findByLabelText('模型适配说明')).toHaveTextContent('当前模型没有扩写参数');
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /林澈/ })).not.toBeChecked());
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
      ).toBe(true),
    );
    const prepared = vi
      .mocked(callWorker)
      .mock.calls.find(
        ([method]) => method === 'video.generate.prepare',
      )![1] as VideoGenerationPrepareParams;
    expect(JSON.stringify(prepared.parameters)).not.toContain('character-voice://');
    expect(JSON.stringify(prepared.parameters)).not.toContain('project-audio://');
    expect(prepared.productionSource).toEqual({ ...result.source, mode: 'form' });
  });
  it('lets a UniComp Wan user enter a public audio reference separately from the audio switch', async () => {
    const contract = officialVideoAudioContracts.find(
      (value) => value.contractId === 'cn.qwen.wan3-0-video' && value.contractRevision === 3,
    )!;
    const schema = structuredClone(
      contract.parameterSchema,
    ) as unknown as AdapterDescriptor['parameterSchema'];
    schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
    schema.properties.media!.title = '参考素材';
    schema.properties.audio!.title = '生成音频';
    const descriptor: AdapterDescriptor = {
      ...adapter,
      key: 'REFERENCE_TO_VIDEO:unicompapi:cn.qwen.wan3-0-video:contract-3',
      provider: 'unicompapi',
      parameterSchema: schema,
      uiSchema: {
        fields: [
          { key: 'media', control: 'structured', group: 'basic', order: 0 },
          { key: 'audio', control: 'toggle', group: 'basic', order: 1 },
        ],
      },
    };
    mock({ ...scene, characterBindings: [] }, descriptor);
    render(<ProductionPanel projectId="project" sceneId="scene" writable />);
    expect(await screen.findByText(/“生成音频”控制成片是否带声音/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加参考素材' }));
    const type = screen.getByLabelText('参考素材 1类型');
    fireEvent.change(type, { target: { value: '4' } });
    fireEvent.change(screen.getByRole('textbox', { name: '媒体地址' }), {
      target: { value: 'https://example.com/voice.wav' },
    });
    expect(screen.getByRole('textbox', { name: '媒体地址' })).toHaveValue(
      'https://example.com/voice.wav',
    );
    fireEvent.click(screen.getByText('更多设置'));
    expect(screen.getByRole('checkbox', { name: '生成音频' })).toBeChecked();
    expect(screen.queryByText('角色声音参考')).not.toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.prepare', expect.anything());
  });
  it('keeps stale and unrelated character facts advisory and submits the final prompt unchanged', async () => {
    mock(scene);
    const fallback = vi.mocked(callWorker).getMockImplementation()!;
    const update = vi.fn();
    vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) =>
      method === 'production.compile' || method === 'production.read'
        ? Promise.resolve({
            target: { kind: 'shot', id: 'shot' },
            rowVersion: 1,
            source: {
              target: { kind: 'shot', id: 'shot' },
              instructionId: 'old',
              revision: 1,
              token: 'a'.repeat(64),
            },
            parameters: {
              prompt: '已有手写提示词',
              media: [{ type: 'reference_image', url: 'project-asset://unused-image' }],
            },
            issues: [
              {
                code: 'STALE_INSTRUCTION',
                message: '「入场」引用的角色林澈已有新版本，请在会话中更新制作指令。',
                target: { kind: 'shot', id: 'shot' },
                targetTitle: '入场',
                changedReferences: [{ target: { kind: 'character', id: 'actor' }, title: '林澈' }],
              },
              {
                code: 'CONTINUITY_UNVERIFIED',
                message: '开始状态「沈孤鸿状态」缺少可比较的前置证据。',
              },
              {
                code: 'LOCKED_FACT_CHANGED',
                message: '前置对象对状态「江晚外观」的锁定值发生变化。',
              },
            ],
          })
        : fallback(method as never, params)) as typeof callWorker);
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        shotId="shot"
        seedReferenceBindings={[
          {
            id: 'unused',
            role: 'character',
            label: '沈孤鸿',
            assetId: 'unused-image',
            source: 'auto',
          },
        ]}
        writable
        onUpdateProductionInstructions={update}
      />,
    );
    const button = await screen.findByRole('button', { name: '到会话更新制作指令' });
    expect(screen.queryByRole('button', { name: '重新填入制作内容' })).not.toBeInTheDocument();
    fireEvent.click(button);
    expect(update).toHaveBeenCalledOnce();
    expect(update.mock.calls[0]![0]).toContain('入场（shot:shot）');
    expect(update.mock.calls[0]![0]).toContain('林澈');
    expect(update.mock.calls[0]![0]).toContain('手工修改');
    const prompt = screen.getByRole('textbox', { name: '提示词' });
    fireEvent.change(prompt, { target: { value: '江晚继续打铁，老瞎子走入门外雾中' } });
    expect(screen.getByText(/制作说明仅供参考/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
      ).toBe(true),
    );
    const prepared = vi
      .mocked(callWorker)
      .mock.calls.find(
        ([method]) => method === 'video.generate.prepare',
      )![1] as VideoGenerationPrepareParams;
    expect(prepared.productionSource).toMatchObject({
      mode: 'form',
      target: { kind: 'shot', id: 'shot' },
    });
    expect(prepared.parameters.prompt).toBe('江晚继续打铁，老瞎子走入门外雾中');
    expect(JSON.stringify(prepared.parameters)).not.toContain('沈孤鸿');
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.some(([method]) => method === 'media.generation.confirmSubmission'),
    ).toBe(false);
  });

  it('refills current images and bindings together after a structured source changes', async () => {
    mock(scene);
    const fallback = vi.mocked(callWorker).getMockImplementation()!;
    const source = {
      target: { kind: 'scene' as const, id: 'scene' },
      instructionId: 'instruction',
      revision: 1,
      token: 'a'.repeat(64),
    };
    const result = (image: string, revision: number): ProductionCompileResult => ({
      target: source.target,
      rowVersion: revision,
      source: { ...source, revision, token: String(revision).repeat(64) },
      parameters: {
        prompt: `制作版本${revision}`,
        media: [{ type: 'reference_image', url: `project-asset://${image}` }],
      },
      issues: [],
      sceneInputs: {
        scene: {
          ...scene,
          characterBindings: [
            { characterDocumentId: 'actor', imageAssetId: image, voiceDisabled: true },
          ],
        },
        media: { assets: [], voices: [], characters: [] },
        characterNames: { actor: '林澈' },
      },
    });
    let latest = result('old-image', 1);
    vi.mocked(callWorker).mockImplementation(((method: string, params: Record<string, unknown>) =>
      method === 'production.compile' || method === 'production.read'
        ? Promise.resolve(latest)
        : fallback(method as never, params)) as typeof callWorker);
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        sceneId="scene"
        seedPrompt="原文"
        writable
      />,
    );
    await screen.findByText(/已填入制作内容 · 版本 1/);
    latest = result('new-image', 2);
    window.dispatchEvent(new Event('production-source-updated'));
    expect(await screen.findByText(/制作说明或参考资料已更新/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重新填入制作内容' }));
    await screen.findByText(/已填入制作内容 · 版本 2/);
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
      ).toBe(true),
    );
    const prepared = vi
      .mocked(callWorker)
      .mock.calls.find(
        ([method]) => method === 'video.generate.prepare',
      )![1] as VideoGenerationPrepareParams;
    expect(prepared.productionSource?.revision).toBe(2);
    expect(prepared.parameters.media).toEqual([
      { type: 'reference_image', url: 'project-asset://new-image' },
    ]);
    expect(prepared.parameters.prompt).toContain('角色「林澈」参考图 1');
    expect(JSON.stringify(prepared.parameters)).not.toContain('old-image');
  });
  it.each([false, true])(
    'freezes a default voice version before payment and respects disabling (disabled=%s)',
    async (disabled) => {
      mock({
        ...scene,
        characterBindings: [
          { characterDocumentId: 'actor', ...(disabled ? { voiceDisabled: true } : {}) },
        ],
      });
      render(
        <ProductionPanel
          expanded
          capability="REFERENCE_TO_VIDEO"
          projectId="project"
          sceneId="scene"
          seedPrompt="对白"
          writable
        />,
      );
      const checkbox = await screen.findByRole('checkbox', { name: /林澈/ });
      await waitFor(() => expect(checkbox).toHaveProperty('checked', !disabled));
      fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
      await waitFor(() =>
        expect(
          vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
        ).toBe(true),
      );
      const prepared = vi
        .mocked(callWorker)
        .mock.calls.find(
          ([method]) => method === 'video.generate.prepare',
        )?.[1] as VideoGenerationPrepareParams;
      expect(prepared.parameters.media ?? []).toEqual(
        disabled ? [] : [{ type: 'reference_audio', url: 'character-voice://actor/voice-v1' }],
      );
      expect(
        vi
          .mocked(callWorker)
          .mock.calls.some(([method]) => method === 'media.generation.confirmSubmission'),
      ).toBe(false);
    },
  );
  it('rejects voice samples on a dialogue driving model when no complete dialogue is bound', async () => {
    mock(scene, drivingAdapter);
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        sceneId="scene"
        seedPrompt="对白"
        writable
      />,
    );
    await screen.findByRole('button', { name: '导入完整对白' });
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    expect(await screen.findByText(/不能使用本场的角色音色样本/)).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
    ).toBe(false);
  });

  it('refreshes official media when reopening the same scene with changed image bindings', async () => {
    mock(scene);
    const props = {
      expanded: true,
      capability: 'REFERENCE_TO_VIDEO' as const,
      projectId: 'project',
      sceneId: 'scene',
      seedPrompt: '两人对白',
      writable: true,
    };
    const view = render(<ProductionPanel {...props} seedImages={['asset://old-image']} />);
    await screen.findByRole('checkbox', { name: /林澈/ });
    view.rerender(<ProductionPanel {...props} seedImages={['asset://new-image']} />);
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
      ).toBe(true),
    );
    const prepared = vi
      .mocked(callWorker)
      .mock.calls.find(
        ([method]) => method === 'video.generate.prepare',
      )?.[1] as VideoGenerationPrepareParams;
    expect(prepared.parameters.media).toContainEqual({
      type: 'reference_image',
      url: 'project-asset://new-image',
    });
    expect(JSON.stringify(prepared.parameters)).not.toContain('old-image');
    expect(prepared.parameters).not.toHaveProperty('images');
  });

  it('persists imported complete dialogue to the bound scene before using it', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.mocked(openAudioDialog).mockResolvedValue('E:\\dialogue.wav');
    mock(scene, drivingAdapter);
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        sceneId="scene"
        seedPrompt="对白"
        writable
      />,
    );
    const button = await screen.findByRole('button', { name: '导入完整对白' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('scene.save', {
        sceneId: 'scene',
        title: scene.title,
        dialogueAudioId: 'dialogue',
        expectedRowVersion: 1,
      }),
    );
    expect(await screen.findByRole('button', { name: '更换完整对白' })).toBeInTheDocument();
  });

  it('does not apply a delayed dialogue import after switching scenes within one project', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {}, configurable: true });
    vi.mocked(openAudioDialog).mockResolvedValue('E:\\dialogue.wav');
    let finishImport!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finishImport = resolve;
    });
    mock(scene, drivingAdapter, pending);
    const props = {
      expanded: true,
      capability: 'REFERENCE_TO_VIDEO' as const,
      projectId: 'project',
      seedPrompt: '对白',
      writable: true,
    };
    const view = render(<ProductionPanel {...props} sceneId="scene" />);
    const button = await screen.findByRole('button', { name: '导入完整对白' });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('audio.import', {
        sourcePath: 'E:\\dialogue.wav',
        kind: 'imported-dialogue',
      }),
    );
    view.rerender(<ProductionPanel {...props} sceneId="next-scene" />);
    finishImport({ audio: dialogue });
    await waitFor(() => expect(screen.getByRole('button', { name: '导入完整对白' })).toBeEnabled());
    expect(vi.mocked(callWorker).mock.calls.some(([method]) => method === 'scene.save')).toBe(
      false,
    );
    expect(screen.queryByRole('button', { name: '更换完整对白' })).not.toBeInTheDocument();
  });

  it('rejects complete dialogue on a voice reference model instead of omitting it', async () => {
    mock({ ...scene, dialogueAudioId: 'dialogue' });
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        sceneId="scene"
        seedPrompt="台词"
        writable
      />,
    );
    await screen.findByRole('checkbox', { name: /林澈/ });
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    expect(await screen.findByText(/本场绑定了完整对白/)).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
    ).toBe(false);
  });
  it('preselects a bound voice without any character image and includes the pinned version before payment', async () => {
    mock(scene);
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        sceneId="scene"
        seedPrompt="林澈说你好"
        writable
      />,
    );
    expect(await screen.findByRole('checkbox', { name: /林澈/ })).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
      ).toBe(true),
    );
    const prepared = vi
      .mocked(callWorker)
      .mock.calls.find(
        ([method]) => method === 'video.generate.prepare',
      )?.[1] as VideoGenerationPrepareParams;
    expect(prepared.sceneId).toBe('scene');
    expect(prepared.parameters.media).toEqual([
      { type: 'reference_audio', url: 'character-voice://actor/voice-v1' },
    ]);
    expect(await screen.findByRole('button', { name: '批准' })).toBeInTheDocument();
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.some(([method]) => method === 'media.generation.confirmSubmission'),
    ).toBe(false);
  });
  it('blocks stale voices without silently switching to the newest sample', async () => {
    mock({
      ...scene,
      characterBindings: [{ characterDocumentId: 'actor', voiceReferenceVersionId: 'old' }],
    });
    render(
      <ProductionPanel
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        sceneId="scene"
        seedPrompt="台词"
        writable
      />,
    );
    await screen.findByRole('checkbox', { name: /林澈/ });
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    expect(await screen.findByText(/场次绑定的声音样本已变化或不可用/)).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.some(([method]) => method === 'video.generate.prepare'),
    ).toBe(false);
  });
});
