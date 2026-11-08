import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { officialImageContracts, type AdapterDescriptor } from '@ai-video/contracts';
import { TaskConfirmationDialog } from './TaskConfirmationDialog';
import type { TaskConfirmation } from './task-confirmations';
import { callWorker } from './worker-client';
import { forgetWorkerScope, selectWorkerScope } from './worker-scope';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
const scope = { projectId: 'task-project', projectSessionId: 'task-session' };
const contract = officialImageContracts.find(
  (item) => item.officialModelName === 'qwen-image-3.0' && item.contractRevision === 2,
)!;
const adapter: AdapterDescriptor = {
  key: 'qwen-test',
  capability: 'REFERENCE_TO_IMAGE',
  capabilityLabel: '参考生图',
  provider: 'unicompapi',
  providerLabel: 'UniCompAPI',
  model: 'qwen-image-3.0',
  modelLabel: 'Qwen Image 3.0',
  apiVersion: 'v1',
  schemaVersion: 2,
  endpoint: '/test',
  documentationUrl: 'https://example.com',
  credentialProvider: 'unicompapi',
  parameterSchema: {
    ...structuredClone(contract.parameterSchema),
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    required: ['prompt', 'images'],
  } as AdapterDescriptor['parameterSchema'],
  uiSchema: { fields: [] },
};
const item: TaskConfirmation & { kind: 'model' } = {
  key: 'task:model:selection',
  owner: 'task',
  label: '任务所属项目',
  kind: 'model',
  projectId: scope.projectId,
  referenceImageInputs: [],
  request: {
    selectionToken: 'selection',
    kind: 'image',
    prompt: '以图片1为场景参考。',
    inputAssetIds: ['S1'],
    inputAttachmentCount: 0,
    proposedParameters: {},
    expiresAt: '2999-01-01T00:00:00Z',
    candidates: [
      {
        providerProfileId: 'provider',
        providerName: 'UniCompAPI',
        providerType: 'unicompapi',
        providerRegion: 'unicompapi',
        modelId: 'model',
        remoteModelId: 'qwen-image-3.0',
        modelName: 'Qwen Image 3.0',
        adapters: [adapter],
        costNotice: { required: true, summary: '模拟生成' },
      },
    ],
  },
};
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const chooseModel = () => fireEvent.click(screen.getByRole('button', { name: /Qwen Image 3.0/ }));
const previews = () => screen.getAllByRole('button', { name: /放大查看参考图片/ });

beforeEach(() => {
  vi.mocked(callWorker).mockReset();
  vi.mocked(callWorker).mockResolvedValue({
    assetId: 'S1',
    path: '/test.png',
    contentType: 'image/png',
  });
  selectWorkerScope(scope);
  selectWorkerScope({ projectId: 'visible-project', projectSessionId: 'visible-session' });
});
afterEach(() => {
  cleanup();
  forgetWorkerScope(scope.projectId);
  forgetWorkerScope('visible-project');
  selectWorkerScope(undefined);
});

describe('Agent image parameters in the task confirmation modal', () => {
  it('carries the requested asset into its own project and keeps a user removal across rerenders', async () => {
    const onDecide = vi.fn();
    const props = { item, count: 1, onDecide, onOpenProtectedUi: vi.fn() };
    const view = render(<TaskConfirmationDialog {...props} />);
    chooseModel();
    await screen.findByRole('button', { name: /放大查看参考图片/ });
    expect(within(previews()[0]!).getByRole('img')).toHaveAttribute(
      'src',
      '/worker-media/S1?projectId=task-project&projectSessionId=task-session&thumbnail=1',
    );
    expect(callWorker).toHaveBeenCalledWith('asset.thumbnail', { assetId: 'S1' }, scope);
    expect(screen.queryByPlaceholderText('每行一个值')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清除此图片输入' }));
    view.rerender(
      <TaskConfirmationDialog {...props} item={{ ...item, referenceImageInputs: [] }} />,
    );
    expect(screen.queryByRole('button', { name: /放大查看参考图片/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '提交生成' }));
    expect(screen.getByText('请填写必填参数：参考图片')).toBeInTheDocument();
    expect(onDecide).not.toHaveBeenCalled();
    const picker = screen.getByLabelText('为参考图片选择本地图片');
    fireEvent.change(picker, {
      target: { files: [new File([png], 'scene.png', { type: 'image/png' })] },
    });
    expect(screen.getByRole('button', { name: '提交生成' })).toBeDisabled();
    await screen.findByRole('button', { name: '放大查看参考图片：scene.png' });
    fireEvent.click(screen.getByRole('button', { name: '提交生成' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]).toMatchObject([
      item.key,
      {
        parameters: {
          images: [expect.stringMatching(/^data:image\/png;base64,/)],
        },
      },
    ]);
  });

  it('merges actual proposed inputs without duplicating assets and submits the reviewed order', async () => {
    const onDecide = vi.fn();
    const request = {
      ...item.request,
      inputAssetIds: ['S2', 'S1'],
      proposedParameters: { images: ['project-asset://S2'] },
    };
    render(
      <TaskConfirmationDialog
        item={{ ...item, request }}
        count={1}
        onDecide={onDecide}
        onOpenProtectedUi={vi.fn()}
      />,
    );
    chooseModel();
    await waitFor(() => expect(previews()).toHaveLength(2));
    fireEvent.click(
      within(previews()[0]!.closest('.url-list-item')!).getByRole('button', { name: '下移' }),
    );
    fireEvent.click(screen.getByRole('button', { name: '添加图片' }));
    const empty = screen.getByPlaceholderText('输入图片公开 URL，或选择本地图片');
    expect(screen.queryByRole('button', { name: '添加图片' })).not.toBeInTheDocument();
    fireEvent.click(
      within(empty.closest('.url-list-item')!).getByRole('button', { name: '移除此输入行' }),
    );
    fireEvent.click(screen.getByRole('button', { name: '提交生成' }));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide.mock.calls[0]).toMatchObject([
      item.key,
      {
        parameters: {
          images: ['project-asset://S1', 'project-asset://S2'],
        },
      },
    ]);
  });

  it('keeps ordinary string arrays as text and does not inject unused chat attachments', async () => {
    const custom = structuredClone(adapter);
    custom.parameterSchema.properties.tags = {
      type: 'array',
      title: '标签',
      items: { type: 'string' },
    };
    render(
      <TaskConfirmationDialog
        item={{
          ...item,
          referenceImageInputs: ['data:image/png;base64,iVBORw0KGgo='],
          request: {
            ...item.request,
            candidates: [{ ...item.request.candidates[0]!, adapters: [custom] }],
          },
        }}
        count={1}
        onDecide={vi.fn()}
        onOpenProtectedUi={vi.fn()}
      />,
    );
    chooseModel();
    expect(screen.getByRole('textbox', { name: '标签' }).tagName).toBe('TEXTAREA');
    await waitFor(() => expect(previews()).toHaveLength(1));
  });
});
