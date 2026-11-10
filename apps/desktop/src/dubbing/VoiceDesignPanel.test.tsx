import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DocumentDetail,
  MediaSubmissionConfirmationRequest,
  ProviderModelInfo,
  ProviderProfileInfo,
} from '@ai-video/contracts';
import { callWorker } from '../worker-client';
import { selectWorkerScope } from '../worker-scope';
import { VoiceDesignPanel } from './VoiceDesignPanel';

vi.mock('../worker-client', () => ({ callWorker: vi.fn() }));
const character: DocumentDetail = {
  id: 'character',
  projectId: 'project',
  kind: 'character',
  title: '林澈',
  scopeType: 'project',
  lifecycleStatus: 'active',
  rowVersion: 3,
  createdAt: 'now',
  updatedAt: 'now',
};
const source: DocumentDetail = {
  ...character,
  id: 'voice-source',
  kind: 'voice',
  currentVersionId: 'voice-v2',
  currentVersion: {
    id: 'voice-v2',
    documentId: 'voice-source',
    version: 2,
    contentMarkdown: '低沉清晰，语速平稳。',
    sampleText: '灯塔还亮着。',
    state: 'draft',
    authorType: 'user',
    createdAt: 'now',
  },
};
const provider: ProviderProfileInfo = {
  id: 'minimax',
  name: 'MiniMax 官方',
  category: 'multi',
  providerType: 'minimax-speech',
  protocol: 'minimax-speech',
  accessType: 'official',
  baseUrl: 'https://api.minimax.cn',
  enabled: true,
  connectionStatus: 'ready',
  createdAt: 'now',
  updatedAt: 'now',
};
const model: ProviderModelInfo = {
  id: 'hd',
  providerProfileId: provider.id,
  remoteModelId: 'speech-2.8-hd',
  displayName: 'Speech 2.8 HD',
  enabled: true,
  source: 'manual',
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
  createdAt: 'now',
  updatedAt: 'now',
};
const confirmation: MediaSubmissionConfirmationRequest = {
  confirmationToken: 'token',
  jobId: 'token',
  kind: 'audio',
  draftVersion: 1,
  providerName: provider.name,
  modelName: 'MiniMax 音色设计',
  adapterKey: 'minimax-voice-design-v1',
  parameterSummary: [],
  costNotice: { required: true, summary: '可能产生费用' },
  expiresAt: 'later',
};
const props = {
  projectId: 'project',
  character,
  voiceDocumentId: source.id,
  writable: true,
  onClose: vi.fn(),
  onRequestApproval: vi.fn(() => Promise.resolve(true)),
};
let voiceSource = source;
beforeEach(() => {
  voiceSource = source;
  selectWorkerScope(undefined);
  vi.mocked(callWorker).mockReset();
  props.onRequestApproval.mockReset().mockResolvedValue(true);
  vi.mocked(callWorker).mockImplementation((method) => {
    if (method === 'document.get') return Promise.resolve(voiceSource);
    if (method === 'provider.profile.list') return Promise.resolve([provider]);
    if (method === 'provider.model.list') return Promise.resolve([model]);
    if (method === 'characterVoiceDesign.prepare') return Promise.resolve({ confirmation });
    if (method === 'characterVoiceDesign.confirm')
      return Promise.resolve({
        approved: true,
        audio: { id: 'audio' },
        voiceProfile: { voiceId: 'ttv-new-voice' },
        reference: { audioId: 'audio' },
      } as never);
    if (method === 'audio.mediaSource')
      return Promise.resolve({ path: 'E:/project/assets/audio/reference/new.mp3' } as never);
    throw new Error(`Unexpected ${method}`);
  });
});
afterEach(() => {
  cleanup();
  selectWorkerScope(undefined);
});
const submitButton = () => screen.getByRole('button', { name: '确认生成新音色' });

describe('VoiceDesignPanel', () => {
  it('designs from explicit source versions only after approval and displays the saved voice ID and audio', async () => {
    const event = vi.fn();
    window.addEventListener('character-voice-reference-updated', event);
    try {
      render(<VoiceDesignPanel {...props} />);
      await waitFor(() => expect(submitButton()).toBeEnabled());
      expect(screen.getByText('低沉清晰，语速平稳。')).toBeInTheDocument();
      expect(props.onRequestApproval).not.toHaveBeenCalled();
      expect(
        vi
          .mocked(callWorker)
          .mock.calls.some(([method]) => method === 'characterVoiceDesign.confirm'),
      ).toBe(false);
      fireEvent.click(submitButton());
      expect(await screen.findByText('ttv-new-voice')).toBeInTheDocument();
      expect(callWorker).toHaveBeenCalledWith('characterVoiceDesign.prepare', {
        characterDocumentId: character.id,
        voiceDocumentId: source.id,
        expectedVoiceDocumentVersionId: source.currentVersionId,
        expectedCharacterRowVersion: 3,
        providerProfileId: provider.id,
        modelId: model.remoteModelId,
      });
      expect(props.onRequestApproval).toHaveBeenCalledWith(confirmation);
      expect(callWorker).toHaveBeenCalledWith('characterVoiceDesign.confirm', {
        confirmationToken: 'token',
        approved: true,
      });
      await waitFor(() =>
        expect(screen.getByLabelText('新音色试听')).toHaveAttribute(
          'src',
          '/worker-media/audio/audio',
        ),
      );
      expect(event).toHaveBeenCalledOnce();
      expect((event.mock.calls[0]![0] as CustomEvent).detail).toEqual({
        projectId: 'project',
        characterDocumentId: character.id,
      });
      expect(submitButton()).toBeDisabled();
    } finally {
      window.removeEventListener('character-voice-reference-updated', event);
    }
  });

  it('consumes cancelled approval without submitting a paid design', async () => {
    props.onRequestApproval.mockResolvedValue(false);
    const original = vi.mocked(callWorker).getMockImplementation()!;
    vi.mocked(callWorker).mockImplementation((method, params, scope) =>
      method === 'characterVoiceDesign.confirm'
        ? Promise.resolve({ approved: false })
        : original(method, params, scope),
    );
    render(<VoiceDesignPanel {...props} />);
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    expect(await screen.findByText('已取消生成。')).toBeInTheDocument();
    expect(callWorker).toHaveBeenCalledWith('characterVoiceDesign.confirm', {
      confirmationToken: 'token',
      approved: false,
    });
  });

  it('prevents duplicate clicks and rejects late approval after closing the character', async () => {
    let approve: (value: boolean) => void = () => undefined;
    props.onRequestApproval.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          approve = resolve;
        }),
    );
    const { unmount } = render(<VoiceDesignPanel {...props} />);
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    await waitFor(() => expect(props.onRequestApproval).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: '正在生成音色…' })).toBeDisabled();
    unmount();
    act(() => {
      approve(true);
    });
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('characterVoiceDesign.confirm', {
        confirmationToken: 'token',
        approved: false,
      }),
    );
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) => method === 'characterVoiceDesign.prepare'),
    ).toHaveLength(1);
  });

  it.each(['long', 'read-only'] as const)(
    'blocks %s generation while preserving the full audition',
    async (kind) => {
      if (kind === 'long')
        voiceSource = {
          ...source,
          currentVersion: { ...source.currentVersion!, sampleText: '中'.repeat(501) },
        };
      render(<VoiceDesignPanel {...props} writable={kind !== 'read-only'} />);
      await screen.findByText('低沉清晰，语速平稳。');
      expect(submitButton()).toBeDisabled();
      if (kind === 'long') expect(screen.getByText('中'.repeat(501))).toBeInTheDocument();
      expect(props.onRequestApproval).not.toHaveBeenCalled();
    },
  );

  it('shows preparation errors with the description intact and no automatic retry', async () => {
    const original = vi.mocked(callWorker).getMockImplementation()!;
    vi.mocked(callWorker).mockImplementation((method, params, scope) =>
      method === 'characterVoiceDesign.prepare'
        ? Promise.reject(new Error('角色或音色提示词已变化'))
        : original(method, params, scope),
    );
    render(<VoiceDesignPanel {...props} />);
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    expect(await screen.findByText('角色或音色提示词已变化')).toBeInTheDocument();
    expect(screen.getByText('低沉清晰，语速平稳。')).toBeInTheDocument();
    expect(props.onRequestApproval).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) => method === 'characterVoiceDesign.prepare'),
    ).toHaveLength(1);
  });

  it('shows the supplier failure code and reason after approval without retrying', async () => {
    const original = vi.mocked(callWorker).getMockImplementation()!;
    vi.mocked(callWorker).mockImplementation((method, params, scope) =>
      method === 'characterVoiceDesign.confirm'
        ? Promise.reject(new Error('MiniMax 音色设计失败（错误码 1008）：账户余额不足'))
        : original(method, params, scope),
    );
    render(<VoiceDesignPanel {...props} />);
    await waitFor(() => expect(submitButton()).toBeEnabled());
    fireEvent.click(submitButton());
    expect(
      await screen.findByText('MiniMax 音色设计失败（错误码 1008）：账户余额不足'),
    ).toBeInTheDocument();
    expect(submitButton()).toBeEnabled();
    expect(
      vi
        .mocked(callWorker)
        .mock.calls.filter(([method]) => method === 'characterVoiceDesign.confirm'),
    ).toHaveLength(1);
  });
});
