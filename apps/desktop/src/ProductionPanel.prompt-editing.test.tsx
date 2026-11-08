import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { $getRoot, $isTextNode, getNearestEditorFromDOMNode, UNDO_COMMAND } from 'lexical';
import {
  officialVideoAudioContracts,
  type AdapterDescriptor,
  type AdapterParameters,
} from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';
import { callWorker } from './worker-client';
import { replacePromptText } from './prompt-editor.test-utils';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ convertFileSrc: (path: string) => path }));

beforeEach(() => {
  // jsdom has no layout; Lexical asks for the caret rectangle when undo restores selection.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => new DOMRect(),
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  window.localStorage.clear();
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect');
});

const imageBindings = [
  { assetId: 'actor', role: 'character' as const, label: '林澈' },
  { assetId: 'other-actor', role: 'character' as const, label: '守卫' },
  { assetId: 'scene', role: 'scene' as const, label: '旧码头' },
  { assetId: 'continuity', role: 'reference' as const, label: '前镜衔接帧' },
];

function mockForm(contractId: string) {
  const contract = officialVideoAudioContracts.find(
    (item) => item.contractId === contractId && item.contractRevision === 2,
  )!;
  const adapter: AdapterDescriptor = {
    key: `REFERENCE_TO_VIDEO:unicompapi:${contractId}:contract-2`,
    capability: 'REFERENCE_TO_VIDEO',
    capabilityLabel: '参考生视频',
    provider: 'unicompapi',
    providerLabel: 'UniCompAPI',
    credentialProvider: 'unicompapi',
    model: contractId,
    modelLabel: contract.officialModelName,
    contractId,
    contractRevision: 2,
    apiVersion: 'contract-2',
    schemaVersion: 1,
    endpoint: 'https://example.test/video',
    documentationUrl: 'https://example.test/docs',
    parameterSchema: structuredClone(
      contract.parameterSchema,
    ) as unknown as AdapterDescriptor['parameterSchema'],
    uiSchema: { fields: [] },
  };
  const target = { kind: 'shot', id: 'shot' };
  vi.mocked(callWorker).mockImplementation((async (
    method: string,
    params: Record<string, unknown>,
  ) => {
    await Promise.resolve();
    if (method === 'adapter.catalog')
      return {
        capabilities: [{ key: 'REFERENCE_TO_VIDEO', label: '参考生视频' }],
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
    if (method === 'production.compile')
      return {
        target,
        rowVersion: 1,
        source: { mode: 'form', target, token: 'source', inputImages: imageBindings },
        parameters: { content: [{ type: 'text', text: '旧编译正文' }] },
        issues: [],
      };
    if (method === 'production.defaults.get' || method === 'production.defaults.save')
      return { rowVersion: 1, settings: {} };
    if (method === 'adapter.validate') return { valid: true, errors: [] };
    if (method === 'generation.draft.save') return { updatedAt: '2026-11-04T05:00:00Z' };
    if (method === 'video.generate.prepare') return { id: 'prepared', status: 'pending' };
    if (method === 'media.generation.requestSubmission')
      return { confirmation: { confirmationToken: 'token' } };
    if (method === 'media.task.cancel') return {};
    if (method === 'video.generate.list' || method === 'characterVoiceReference.list') return [];
    throw new Error(`Unexpected ${method}`);
  }) as typeof callWorker);
  return adapter;
}

function promptText(field: HTMLElement): string {
  return getNearestEditorFromDOMNode(field)!
    .getEditorState()
    .read(() =>
      $getRoot()
        .getChildren()
        .map((paragraph) => paragraph.getTextContent())
        .join('\n'),
    );
}

function parametersFor(method: 'generation.draft.save' | 'video.generate.prepare') {
  return vi.mocked(callWorker).mock.calls.find(([name]) => name === method)?.[1] as
    { parameters: AdapterParameters } | undefined;
}

it.each(['cn.bytedance.seedance2-0.video', 'cn.bytedance.seedance2-5.video'])(
  'keeps partial image-description edits, deletion and undo through refresh/save/prepare for %s',
  async (contractId) => {
    mockForm(contractId);
    const view = render(
      <ProductionPanel
        writable
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        shotId="shot"
        seedEventKey={{}}
        seedPrompt="回身抽刀，保持动作连贯。"
        seedImageBindings={imageBindings}
        onRequestSubmissionApproval={() => Promise.resolve(false)}
      />,
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '提交视频任务' })).toBeEnabled());
    const field = await waitFor(() => {
      const prompt = screen
        .getAllByRole('textbox')
        .find((item) => item.textContent?.includes('【输入图片说明】'));
      expect(prompt).toBeDefined();
      expect(prompt!.querySelectorAll('.prompt-reference-chip')).toHaveLength(4);
      return prompt!;
    });
    const filled = promptText(field);
    const revised = filled.replace('角色「林澈」的角色参考图', '林澈的服装参考，姿势按正文执行');
    expect(revised).not.toBe(filled);
    await replacePromptText(field, revised);
    await waitFor(() => expect(promptText(field)).toBe(revised));
    const editor = getNearestEditorFromDOMNode(field)!;
    await act(async () => {
      editor.update(
        () => {
          const text = $getRoot().getLastDescendant();
          if (!$isTextNode(text)) throw new Error('Expected text after the last reference chip.');
          text.select(0, 0);
        },
        { discrete: true },
      );
      await Promise.resolve();
    });
    fireEvent.keyDown(field, { key: 'Backspace' });
    await waitFor(() => expect(promptText(field)).toBe(revised.replace('图片4', '')));
    expect(field.querySelectorAll('.prompt-reference-chip')).toHaveLength(3);
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      await Promise.resolve();
    });
    await waitFor(() => expect(promptText(field)).toBe(revised));

    // Keep the section marker and the other three declarations, just remove one line/chip.
    const withoutLast = revised
      .split('\n')
      .filter((line) => !line.includes('前镜衔接帧'))
      .join('\n');
    await replacePromptText(field, withoutLast);
    await waitFor(() => expect(promptText(field)).toBe(withoutLast));
    expect(field.querySelectorAll('.prompt-reference-chip')).toHaveLength(3);
    await act(async () => {
      editor.dispatchCommand(UNDO_COMMAND, undefined);
      await Promise.resolve();
    });
    await waitFor(() => expect(promptText(field)).toBe(revised));
    await replacePromptText(field, withoutLast);
    await waitFor(() => {
      const memory = JSON.parse(
        window.localStorage.getItem('ai-video.production-adapter-parameters') ?? '{}',
      ) as Record<string, AdapterParameters>;
      expect(Object.values(memory)[0]?.content).toEqual(
        expect.arrayContaining([{ type: 'text', text: withoutLast }]),
      );
    });

    const compileCount = vi
      .mocked(callWorker)
      .mock.calls.filter(([name]) => name === 'production.compile').length;
    fireEvent.click(screen.getByText('项目输出默认值'));
    fireEvent.click(await screen.findByRole('button', { name: '保存默认设置' }));
    await waitFor(() =>
      expect(
        vi.mocked(callWorker).mock.calls.filter(([name]) => name === 'production.compile').length,
      ).toBeGreaterThan(compileCount),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: '提交视频任务' })).toBeEnabled());
    expect(promptText(field)).toBe(withoutLast);

    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await screen.findByText(/草稿已保存/);
    fireEvent.click(screen.getByRole('button', { name: '提交视频任务' }));
    await waitFor(() => expect(parametersFor('video.generate.prepare')).toBeDefined());
    for (const method of ['generation.draft.save', 'video.generate.prepare'] as const) {
      const content = parametersFor(method)!.parameters.content as {
        type: string;
        text?: string;
      }[];
      expect(content.find((item) => item.type === 'text')?.text, method).toBe(withoutLast);
      expect(content.filter((item) => item.type === 'image_url')).toHaveLength(4);
    }
    expect(callWorker).not.toHaveBeenCalledWith('shot.references.save', expect.anything());
    expect(callWorker).not.toHaveBeenCalledWith(
      'media.generation.confirmSubmission',
      expect.anything(),
    );

    // Only an explicit new fill can replace the manual wording with fresh descriptions.
    await waitFor(() => expect(screen.getByRole('button', { name: '提交视频任务' })).toBeEnabled());
    view.rerender(
      <ProductionPanel
        writable
        expanded
        capability="REFERENCE_TO_VIDEO"
        projectId="project"
        shotId="shot"
        seedEventKey={{}}
        seedPrompt="明确重新填充"
        seedImageBindings={imageBindings}
        onRequestSubmissionApproval={() => Promise.resolve(false)}
      />,
    );
    await waitFor(() => {
      expect(promptText(field)).toContain('明确重新填充');
      expect(promptText(field)).toContain('角色「林澈」的角色参考图');
      expect(field.querySelectorAll('.prompt-reference-chip')).toHaveLength(4);
    });
  },
);
