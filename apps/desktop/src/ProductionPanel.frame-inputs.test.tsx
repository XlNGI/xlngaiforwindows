import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import {
  officialVideoAudioContracts,
  seedProductionInputs,
  type AdapterDescriptor,
  type VideoGenerationPrepareParams,
} from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { callWorker } from './worker-client';
import { replacePromptText } from './prompt-editor.test-utils';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
});

const bindings = [
  { assetId: 'actor', role: 'character' as const, label: '林澈' },
  { assetId: 'scene', role: 'scene' as const, label: '旧码头' },
  { assetId: 'frame', role: 'first-frame' as const },
];

it.each([
  ['cn.bytedance.seedance2-0.video', 'references'],
  ['cn.bytedance.seedance2-0.video', 'first-frame'],
  ['cn.bytedance.seedance2-5.video', 'references'],
  ['cn.bytedance.seedance2-5.video', 'first-frame'],
] as const)(
  'keeps three inputs for %s until choosing %s and submits the edited form',
  async (id, choice) => {
    const contract = officialVideoAudioContracts.find(
      (item) => item.contractId === id && item.contractRevision === 2,
    )!;
    const adapter: AdapterDescriptor = {
      key: `IMAGE_TO_VIDEO:unicompapi:${id}:contract-2`,
      capability: 'IMAGE_TO_VIDEO',
      capabilityLabel: '图生视频',
      provider: 'unicompapi',
      providerLabel: 'UniCompAPI',
      credentialProvider: 'unicompapi',
      model: id,
      modelLabel: contract.officialModelName,
      contractId: id,
      contractRevision: 2,
      apiVersion: 'contract-2',
      schemaVersion: 1,
      endpoint: 'https://example.test/video',
      documentationUrl: 'https://example.test/docs',
      parameterSchema: structuredClone(
        contract.parameterSchema,
      ) as unknown as AdapterDescriptor['parameterSchema'],
      uiSchema: { fields: [{ key: 'content', control: 'structured', group: 'basic', order: 1 }] },
    };
    adapter.parameterSchema.properties.content!.title = '内容';
    const target = { kind: 'shot', id: 'shot' };
    vi.mocked(callWorker).mockImplementation((async (
      method: string,
      params: Record<string, unknown>,
    ) => {
      await Promise.resolve();
      if (method === 'adapter.catalog')
        return {
          capabilities: [
            { key: 'IMAGE_TO_VIDEO', label: '图生视频' },
            { key: 'REFERENCE_TO_VIDEO', label: '参考生视频' },
          ],
          providers: [{ key: 'unicompapi', label: 'UniCompAPI' }],
          adapters: [adapter],
        };
      if (method === 'provider.profile.list')
        return [
          {
            id: 'profile',
            name: 'UniCompAPI',
            providerType: 'unicompapi',
            accessType: 'official',
            category: 'video',
            protocol: 'openai-chat-completions',
            enabled: true,
            connectionStatus: 'ready',
            baseUrl: 'https://example.test',
          },
        ];
      if (method === 'provider.model.list')
        return [
          {
            id: 'model',
            remoteModelId: contract.officialModelName,
            displayName: 'Seedance',
            enabled: true,
            capabilities: { videoGeneration: true },
          },
        ];
      if (method === 'adapter.resolve') return adapter;
      if (method === 'asset.thumbnail' || method === 'asset.mediaSource')
        return { assetId: params.assetId, path: 'D:/image.png', contentType: 'image/png' };
      if (method === 'generation.draft.get') return null;
      if (method === 'video.generate.list') return [];
      if (method === 'production.compile')
        return {
          target,
          rowVersion: 1,
          source: { mode: 'form', target, token: 'source', inputImages: bindings },
          parameters: seedProductionInputs(
            adapter,
            { duration: 5 },
            '雨夜里回头',
            // A late/stale compiler result must not replace the complete fill or later edits.
            [{ role: 'first-frame', url: 'project-asset://frame' }],
          ),
          issues: [{ code: 'INPUT_SELECTION_CONFLICT', message: '首帧和参考图不能混用' }],
        };
      if (method === 'production.defaults.get' || method === 'production.defaults.save')
        return { rowVersion: 1, settings: {} };
      if (method === 'adapter.validate') return { valid: true, errors: [] };
      if (method === 'video.generate.prepare') return { id: 'prepared', status: 'pending' };
      if (method === 'media.generation.requestSubmission')
        return { confirmation: { confirmationToken: 'token' } };
      if (method === 'media.task.cancel') return {};
      throw new Error(`Unexpected ${method}`);
    }) as typeof callWorker);

    render(
      <ProductionPanel
        writable
        capability="IMAGE_TO_VIDEO"
        projectId="project"
        shotId="shot"
        seedEventKey={{}}
        seedPrompt="雨夜里回头"
        seedImageBindings={bindings}
        onRequestSubmissionApproval={() => Promise.resolve(false)}
      />,
    );
    const imageRoles = () =>
      screen
        .getAllByRole('combobox')
        .map((select) => (select as HTMLSelectElement).value)
        .filter((value) => ['first_frame', 'reference_image'].includes(value));
    await waitFor(() =>
      expect(imageRoles()).toEqual(['reference_image', 'reference_image', 'first_frame']),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('已保留全部 3 张图片');
    expect(screen.getByRole('button', { name: '提交视频任务' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeDisabled();
    const checks = screen.getByRole('region', { name: '提交前检查' });
    expect(checks).toHaveTextContent('已保留全部 3 张图片');
    expect(checks).toHaveTextContent('不锁定首帧');
    expect(checks).toHaveTextContent('仅使用首帧会移除其余参考素材');
    for (const name of ['提交视频任务', '保存草稿'])
      expect(screen.getByRole('button', { name })).toHaveAccessibleDescription(/图片用途冲突/);
    expect(callWorker).not.toHaveBeenCalledWith('video.generate.prepare', expect.anything());

    fireEvent.click(
      within(checks).getByRole('button', {
        name: choice === 'references' ? '全部作为参考图' : '仅使用首帧',
      }),
    );
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(imageRoles()).toEqual(
      choice === 'references'
        ? ['reference_image', 'reference_image', 'reference_image']
        : ['first_frame'],
    );
    expect(screen.getByLabelText('当前制作模式')).toHaveTextContent(
      choice === 'references' ? '参考生视频' : '图生视频',
    );
    const prompt = screen.getByRole('textbox', { name: '内容' });
    await waitFor(() => {
      expect(prompt).toHaveTextContent(
        choice === 'references' ? '开场构图参考（不锁定首帧）' : '本镜视频的首帧',
      );
      expect(prompt).toHaveTextContent(
        choice === 'references' ? '本段传入3张参考图' : '本段传入1张参考图',
      );
    });

    if (choice === 'references')
      fireEvent.click(screen.getByRole('button', { name: '删除内容 3' }));
    await replacePromptText(prompt, '用户最终编辑的视频描述');
    const beforeRefresh = vi
      .mocked(callWorker)
      .mock.calls.filter(([method]) => method === 'production.compile').length;
    fireEvent.click(screen.getByText('项目输出默认值'));
    fireEvent.click(await screen.findByRole('button', { name: '保存默认设置' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'production.compile')
          .length,
      ).toBeGreaterThan(beforeRefresh),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '提交视频任务' })).toBeEnabled());
    expect(screen.queryByRole('region', { name: '提交前检查' })).not.toBeInTheDocument();
    expect(imageRoles()).toEqual(
      choice === 'references' ? ['reference_image', 'reference_image'] : ['first_frame'],
    );
    expect(prompt).toHaveTextContent('用户最终编辑的视频描述');
    expect(prompt).not.toHaveTextContent('【输入图片说明】');
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('video.generate.prepare', expect.anything()),
    );
    const prepared = vi
      .mocked(callWorker)
      .mock.calls.find(
        ([method]) => method === 'video.generate.prepare',
      )?.[1] as VideoGenerationPrepareParams;
    const content = prepared.parameters.content as {
      type: string;
      text?: string;
      role?: string;
      image_url?: { url: string };
    }[];
    expect(content.filter((item) => item.type === 'image_url')).toEqual(
      choice === 'references'
        ? [
            {
              type: 'image_url',
              role: 'reference_image',
              image_url: { url: 'project-asset://actor' },
            },
            {
              type: 'image_url',
              role: 'reference_image',
              image_url: { url: 'project-asset://frame' },
            },
          ]
        : [{ type: 'image_url', role: 'first_frame', image_url: { url: 'project-asset://frame' } }],
    );
    expect(content.find((item) => item.type === 'text')?.text).toBe('用户最终编辑的视频描述');
    expect(prepared.productionSource?.inputImages).toEqual(bindings);
    expect(callWorker).not.toHaveBeenCalledWith('shot.references.save', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith(
      'media.generation.confirmSubmission',
      expect.anything(),
    );
    expect(prepared.parameters.duration).toBe(5);
  },
);
