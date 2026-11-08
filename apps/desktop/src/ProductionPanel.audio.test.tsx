import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AdapterCatalogResult,
  AdapterDescriptor,
  AudioFileInfo,
  ProviderModelInfo,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import { ProductionPanel } from './ProductionPanel';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => path,
}));

const mock = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('./worker-scope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./worker-scope')>()),
  projectWorker: () => mock.call,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  window.localStorage.clear();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});

const profile: ProviderProfileInfo = {
  id: 'speech-connection',
  name: '角色声音连接',
  category: 'multi',
  providerType: 'minimax-speech',
  accessType: 'official',
  protocol: 'minimax-speech',
  baseUrl: 'https://api.minimaxi.com',
  enabled: true,
  connectionStatus: 'ready',
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

const model: ProviderModelInfo = {
  id: 'speech-model',
  providerProfileId: profile.id,
  remoteModelId: 'speech-2.8-hd',
  displayName: 'Speech 2.8 HD',
  capabilities: {
    speechSynthesis: true,
    text: false,
    vision: false,
    streaming: false,
    reasoning: false,
    tools: false,
    structuredOutput: false,
    embeddings: false,
    imageGeneration: false,
    videoGeneration: false,
  },
  source: 'built-in',
  enabled: true,
  createdAt: '2026-10-31T00:00:00.000Z',
  updatedAt: '2026-10-31T00:00:00.000Z',
};

const adapter: AdapterDescriptor = {
  key: 'TEXT_TO_AUDIO:minimax-speech:speech-2.8-hd:v1',
  capability: 'TEXT_TO_AUDIO',
  capabilityLabel: '音频生成',
  provider: 'minimax-speech',
  providerLabel: 'MiniMax 配音',
  model: 'speech-2.8-hd',
  modelLabel: 'Speech 2.8 HD',
  apiVersion: 'v1',
  schemaVersion: 1,
  endpoint: 'https://api.minimax.cn/v1/t2a_v2',
  documentationUrl: 'https://platform.minimaxi.com/docs/api-reference/speech-t2a-http',
  credentialProvider: 'minimax-speech',
  parameterSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['text', 'voice_setting'],
    properties: {
      text: { type: 'string', title: '合成文本', minLength: 1, maxLength: 4000 },
      voice_setting: {
        type: 'object',
        title: '音色设置',
        default: { speed: 1, pitch: 0 },
        additionalProperties: false,
        required: ['voice_id', 'speed', 'pitch'],
        properties: {
          voice_id: { type: 'string', title: '音色 ID', minLength: 1 },
          speed: { type: 'number', title: '语速', minimum: 0.5, maximum: 2 },
          pitch: { type: 'integer', title: '音高', minimum: -12, maximum: 12 },
        },
      },
    },
  },
  uiSchema: {
    fields: [
      { key: 'text', control: 'textarea', group: 'basic', order: 10 },
      { key: 'voice_setting', control: 'structured', group: 'basic', order: 20 },
    ],
  },
};

const catalog: AdapterCatalogResult = {
  capabilities: [{ key: 'TEXT_TO_AUDIO', label: '音频生成' }],
  providers: [{ key: 'minimax-speech', label: 'MiniMax 配音' }],
  adapters: [adapter],
};

const confirmation = {
  confirmationToken: 'confirmation-token',
  jobId: 'confirmation-token',
  kind: 'audio' as const,
  draftVersion: 1,
  providerName: profile.name,
  modelName: model.displayName,
  adapterKey: adapter.key,
  parameterSummary: [{ key: '合成文本', value: '你好，很高兴认识你。' }],
  costNotice: { required: true as const, summary: '提交请求可能产生供应商费用。' },
  expiresAt: '2026-10-31T01:00:00.000Z',
};

describe('ProductionPanel audio mode', () => {
  beforeEach(() => {
    Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
  });

  it('uses the API Schema form and submits the seeded role voice as a character reference', async () => {
    mock.call.mockImplementation((method: string) => {
      if (method === 'adapter.catalog') return Promise.resolve(catalog);
      if (method === 'audio.list') return Promise.resolve([]);
      if (method === 'provider.profile.list') return Promise.resolve([profile]);
      if (method === 'provider.model.list') return Promise.resolve([model]);
      if (method === 'adapter.resolve') return Promise.resolve(adapter);
      if (method === 'adapter.validate') return Promise.resolve({ valid: true, errors: [] });
      if (method === 'characterVoiceReference.prepare') return Promise.resolve({ confirmation });
      if (method === 'characterVoiceReference.confirm')
        return Promise.resolve({
          approved: true,
          reference: { characterDocumentId: 'character-1', audioId: 'audio-1' },
        });
      return Promise.reject(new Error(method));
    });

    render(
      <ProductionPanel
        capability="TEXT_TO_AUDIO"
        projectId="project-1"
        audioReference={{
          characterDocumentId: 'character-1',
          expectedVoiceVersionId: 'voice-version-1',
          providerProfileId: profile.id,
          model: model.remoteModelId,
        }}
        seedParameters={{
          text: '你好，很高兴认识你。',
          voice_setting: { voice_id: 'fixed-voice-one', speed: 1, pitch: 0 },
        }}
        onRequestSubmissionApproval={() => Promise.resolve(true)}
        writable
      />,
    );

    expect(await screen.findByDisplayValue('你好，很高兴认识你。')).toBeInTheDocument();
    expect(screen.getByLabelText('音色 ID')).toHaveValue('fixed-voice-one');
    expect(screen.getByLabelText('语速')).toHaveValue(1);
    expect(screen.getByLabelText('音高')).toHaveValue(0);
    const submit = await screen.findByRole('button', { name: '制作声音参考' });
    await waitFor(() => expect(submit).toBeEnabled());
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mock.call).toHaveBeenCalledWith('characterVoiceReference.prepare', {
        characterDocumentId: 'character-1',
        expectedVoiceVersionId: 'voice-version-1',
        adapterKey: adapter.key,
        providerProfileId: profile.id,
        modelId: model.remoteModelId,
        parameters: {
          text: '你好，很高兴认识你。',
          voice_setting: { voice_id: 'fixed-voice-one', speed: 1, pitch: 0 },
        },
      }),
    );
    await waitFor(() =>
      expect(mock.call).toHaveBeenCalledWith('characterVoiceReference.confirm', {
        confirmationToken: confirmation.confirmationToken,
        approved: true,
      }),
    );
    expect(await screen.findByText('声音参考已生成并绑定到角色。')).toBeInTheDocument();
  });

  it('generates a standalone project audio sample and makes it available for playback', async () => {
    const audio: AudioFileInfo = {
      id: 'sample-1',
      projectId: 'project-1',
      kind: 'reference',
      name: '音频样本 · 你好，很高兴认识你。',
      relativePath: 'assets/audio/reference/sample-1.mp3',
      mime: 'audio/mpeg',
      sizeBytes: 2048,
      contentHash: 'a'.repeat(64),
      durationMs: 2400,
      sampleRate: 32000,
      channels: 1,
      createdAt: '2026-10-31T00:00:00.000Z',
    };
    let finishGeneration: (() => void) | undefined;
    mock.call.mockImplementation(async (method: string) => {
      if (method === 'adapter.catalog') return catalog;
      if (method === 'audio.list') return [];
      if (method === 'audio.mediaSource')
        return { assetId: audio.id, path: 'E:/project/sample-1.mp3', contentType: audio.mime };
      if (method === 'provider.profile.list') return [profile];
      if (method === 'provider.model.list') return [model];
      if (method === 'adapter.resolve') return adapter;
      if (method === 'adapter.validate') return { valid: true, errors: [] };
      if (method === 'audio.sample.prepare') return { confirmation };
      if (method === 'audio.sample.confirm')
        return new Promise((resolve) => {
          finishGeneration = () => resolve({ approved: true, audio });
        });
      throw new Error(method);
    });

    render(
      <ProductionPanel
        capability="TEXT_TO_AUDIO"
        projectId="project-1"
        shotId="previously-selected-shot"
        sceneId="previously-selected-scene"
        onRequestSubmissionApproval={() => Promise.resolve(true)}
        writable
      />,
    );

    const submit = await screen.findByRole('button', { name: '生成音频样本' });
    await waitFor(() => expect(submit).toBeEnabled());
    expect(screen.queryByRole('button', { name: '制作声音参考' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '保存草稿' })).not.toBeInTheDocument();
    expect(screen.queryByText('保存为')).not.toBeInTheDocument();
    expect(screen.getByLabelText('语速')).toHaveValue(1);
    expect(screen.getByLabelText('音高')).toHaveValue(0);
    fireEvent.change(screen.getByLabelText(/合成文本/u), {
      target: { value: '你好，很高兴认识你。' },
    });
    fireEvent.change(screen.getByLabelText('音色 ID'), {
      target: { value: 'standalone-voice' },
    });
    fireEvent.click(submit);

    await waitFor(() =>
      expect(mock.call).toHaveBeenCalledWith('audio.sample.prepare', {
        adapterKey: adapter.key,
        providerProfileId: profile.id,
        modelId: model.remoteModelId,
        parameters: {
          text: '你好，很高兴认识你。',
          voice_setting: { voice_id: 'standalone-voice', speed: 1, pitch: 0 },
        },
      }),
    );
    await waitFor(() =>
      expect(mock.call).toHaveBeenCalledWith('audio.sample.confirm', {
        confirmationToken: confirmation.confirmationToken,
        approved: true,
      }),
    );
    expect(await screen.findByText('正在生成音频样本…')).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(
      mock.call.mock.calls.filter(([method]) => method === 'audio.sample.confirm'),
    ).toHaveLength(1);
    await act(async () => {
      finishGeneration?.();
      await Promise.resolve();
    });
    expect(await screen.findByText('音频样本已保存到当前项目。')).toBeInTheDocument();
    expect(await screen.findByLabelText(`试听${audio.name}`)).toHaveAttribute(
      'src',
      '/worker-media/audio/sample-1',
    );
    expect(mock.call).not.toHaveBeenCalledWith('generation.draft.get', expect.anything());
    expect(mock.call).not.toHaveBeenCalledWith('production.compile', expect.anything());
  });
});
