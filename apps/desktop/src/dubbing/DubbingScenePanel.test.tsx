import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AssetInfo,
  AudioFileInfo,
  DocumentSummary,
  DubbingCueInfo,
  DubbingJobInfo,
  DubbingSceneSnapshot,
  ProviderProfileInfo,
  VoiceProfileInfo,
  WorkerMethod,
} from '@ai-video/contracts';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { callWorker } from '../worker-client';
import { DubbingScenePanel } from './DubbingScenePanel';
import { VoiceProfilePanel } from './VoiceProfilePanel';

vi.mock('../worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
}));
const now = '2026-10-14T00:00:00.000Z';
const voice: VoiceProfileInfo = {
  id: 'voice',
  projectId: 'project',
  characterDocumentId: 'character',
  versionId: 'voice-v1',
  revision: 1,
  providerProfileId: 'speech',
  model: 'speech-2.8-hd',
  voiceId: 'fixed-voice',
  contractRevision: 'fixed-voice-v1',
  speed: 1,
  pitch: 0,
  rowVersion: 2,
  createdAt: now,
  updatedAt: now,
};
const character: DocumentSummary = {
  id: 'character',
  projectId: 'project',
  kind: 'character',
  title: '小林',
  scopeType: 'project',
  lifecycleStatus: 'active',
  rowVersion: 1,
  createdAt: now,
  updatedAt: now,
};
const provider = (id: string, type: string): ProviderProfileInfo => ({
  id,
  name: id,
  category: 'multi',
  providerType: type,
  accessType: 'official',
  protocol: type,
  baseUrl: 'https://example.com',
  enabled: true,
  connectionStatus: 'ready',
  createdAt: now,
  updatedAt: now,
});
const audio: AudioFileInfo = {
  id: 'audio',
  projectId: 'project',
  kind: 'imported-dialogue',
  name: '配音',
  relativePath: 'assets/audio/dialogue/audio.wav',
  mime: 'audio/wav',
  sizeBytes: 100,
  contentHash: 'a'.repeat(64),
  durationMs: 1000,
  sampleRate: 32000,
  channels: 1,
  createdAt: now,
};
const cue: DubbingCueInfo = {
  id: 'cue',
  projectId: 'project',
  sceneId: 'scene',
  speakerKind: 'character',
  characterDocumentId: 'character',
  voiceProfileId: voice.id,
  text: '出发吧。',
  position: 0,
  startMs: 0,
  lipSync: false,
  rowVersion: 4,
  selectedTakeId: 'take',
  takes: [
    {
      id: 'take',
      projectId: 'project',
      cueId: 'cue',
      cueRowVersion: 1,
      textHash: 'a'.repeat(64),
      audioId: audio.id,
      parameters: {},
      createdAt: now,
    },
  ],
  createdAt: now,
  updatedAt: now,
};
const video: AssetInfo = {
  id: 'video',
  projectId: 'project',
  kind: 'video',
  relativePath: 'assets/videos/video.mp4',
  alias: '源片',
  contentHash: 'b'.repeat(64),
  sizeBytes: 100,
  createdAt: now,
};
const job: DubbingJobInfo = {
  id: 'job',
  projectId: 'project',
  sceneId: 'scene',
  kind: 'compose',
  status: 'pending',
  planVersion: 1,
  inputHash: 'a'.repeat(64),
  inputSnapshot: {},
  budget: { state: 'unknown' },
  idempotencyKey: 'job',
  rowVersion: 1,
  createdAt: now,
  updatedAt: now,
};
const snapshot = (entries = [cue]): DubbingSceneSnapshot => ({
  sceneId: 'scene',
  voices: [voice],
  cues: entries,
  audioFiles: [audio],
  jobs: [],
});
function mockWorker(handler?: (method: WorkerMethod, params: unknown) => unknown) {
  vi.mocked(callWorker).mockImplementation((method, params) => {
    const custom = handler?.(method, params);
    if (custom !== undefined) return Promise.resolve(custom);
    const value =
      method === 'dubbing.scene.get'
        ? snapshot()
        : method === 'dubbing.runtime.get'
          ? { available: true, nativeAvailable: true }
          : method === 'provider.profile.list'
            ? [provider('speech', 'minimax-speech'), provider('sync', 'sync')]
            : method === 'asset.list'
              ? [video]
              : method === 'characterVoice.list'
                ? [voice]
                : method === 'audio.mediaSource'
                  ? { assetId: 'audio', path: 'E:/project/audio.wav', contentType: 'audio/wav' }
                  : method === 'asset.mediaSource'
                    ? { assetId: 'video', path: 'E:/project/video.mp4', contentType: 'video/mp4' }
                    : job;
    return Promise.resolve(value);
  });
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  Reflect.deleteProperty(window, '__TAURI_INTERNALS__');
});
const openPanel = () => fireEvent.click(screen.getByRole('button', { name: '打开配音' }));

describe('scene dubbing workflow', () => {
  it('locks repeated paid generation for a cue with an active frozen speech task', async () => {
    mockWorker((method) =>
      method === 'dubbing.scene.get'
        ? {
            ...snapshot(),
            jobs: [{ ...job, kind: 'speech', inputSnapshot: { cue: { id: cue.id } } }],
          }
        : undefined,
    );
    render(
      <DubbingScenePanel projectId="project" sceneId="scene" documents={[character]} writable />,
    );
    openPanel();
    await screen.findByText('出发吧。');
    fireEvent.click(screen.getByLabelText(/我确认生成配音或处理口型可能产生费用/));
    expect(screen.getByRole('button', { name: '生成配音' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新生成新版本' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '收起配音' }));
    expect(callWorker).not.toHaveBeenCalledWith('dubbing.job.cancel', expect.anything());
  });

  it('shows an estimate from adopted audio and submits the chosen Sync connection and one-attempt budget', async () => {
    mockWorker((method) =>
      method === 'dubbing.scene.get'
        ? snapshot([
            { ...cue, lipSync: true, visibleSpeaker: '左侧人物', speakerCoordinates: [0.2, 0.5] },
          ])
        : undefined,
    );
    render(
      <DubbingScenePanel projectId="project" sceneId="scene" documents={[character]} writable />,
    );
    openPanel();
    await screen.findByText('出发吧。');
    fireEvent.change(screen.getByLabelText('制作方式'), { target: { value: 'lipsync' } });
    fireEvent.change(screen.getByLabelText('每秒单价'), { target: { value: '0.15' } });
    fireEvent.change(screen.getByLabelText('本次费用上限'), { target: { value: '1' } });
    expect(screen.getByText(/口型区间合计 1.00 秒/)).toHaveTextContent('0.1500 USD');
    expect(screen.getByRole('button', { name: '提交制作' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/我确认生成配音或处理口型可能产生费用/));
    fireEvent.click(screen.getByLabelText(/我确认移除源视频全部声音/));
    fireEvent.click(screen.getByRole('button', { name: '提交制作' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'dubbing.job.submit',
        expect.objectContaining({
          mode: 'lipsync',
          providerProfileId: 'sync',
          model: 'sync-3',
          costAcknowledged: true,
          budget: { currency: 'USD', unitPrice: 0.15, maxAmount: 1, maxAttempts: 1 },
        }),
      ),
    );
  });

  it('submits local composition only after adopted audio and source-sound acknowledgement, with no automatic paid request', async () => {
    mockWorker();
    render(
      <DubbingScenePanel projectId="project" sceneId="scene" documents={[character]} writable />,
    );
    openPanel();
    await screen.findByText('出发吧。');
    const submit = screen.getByRole('button', { name: '提交制作' });
    expect(submit).toBeDisabled();
    expect(callWorker).not.toHaveBeenCalledWith('dubbing.take.generate', expect.anything());
    fireEvent.click(screen.getByLabelText(/我确认移除源视频全部声音/));
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'dubbing.job.submit',
        expect.objectContaining({
          sceneId: 'scene',
          sourceVideoAssetId: 'video',
          mode: 'compose',
          removeSourceAudioAcknowledged: true,
        }),
      ),
    );
  });

  it('requires explicit cost acknowledgement for speech and sends cue CAS with a manual request', async () => {
    mockWorker();
    render(
      <DubbingScenePanel projectId="project" sceneId="scene" documents={[character]} writable />,
    );
    openPanel();
    await screen.findByText('出发吧。');
    const generate = screen.getByRole('button', { name: '生成配音' });
    expect(generate).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/我确认生成配音或处理口型可能产生费用/));
    expect(generate).toBeEnabled();
    fireEvent.click(generate);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('dubbing.take.generate', {
        cueId: 'cue',
        expectedRowVersion: 4,
        costAcknowledged: true,
      }),
    );
  });

  it('imports a desktop-selected file, then adopts a take by stable ID and current cue revision', async () => {
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(openDialog).mockResolvedValue('E:\\voices\\line.wav');
    mockWorker((method) =>
      method === 'dubbing.scene.get'
        ? snapshot([{ ...cue, selectedTakeId: undefined }])
        : undefined,
    );
    render(
      <DubbingScenePanel projectId="project" sceneId="scene" documents={[character]} writable />,
    );
    openPanel();
    await screen.findByText('出发吧。');
    fireEvent.click(screen.getByRole('button', { name: '导入配音' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('audio.import', {
        sourcePath: 'E:\\voices\\line.wav',
        cueId: 'cue',
        expectedRowVersion: 4,
      }),
    );
    const adopt = await screen.findByRole('button', { name: '采用配音' });
    await waitFor(() => expect(adopt).toBeEnabled());
    fireEvent.click(adopt);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('dubbing.take.adopt', {
        cueId: 'cue',
        takeId: 'take',
        expectedRowVersion: 4,
      }),
    );
  });

  it('keeps read-only projects playable and disables every production write', async () => {
    mockWorker((method) =>
      method === 'dubbing.scene.get'
        ? snapshot([{ ...cue, selectedTakeId: undefined }])
        : undefined,
    );
    render(
      <DubbingScenePanel
        projectId="project"
        sceneId="scene"
        documents={[character]}
        writable={false}
      />,
    );
    openPanel();
    await screen.findByText('出发吧。');
    await waitFor(() =>
      expect(screen.getByLabelText('配音试听')).toHaveAttribute('src', '/worker-media/audio/audio'),
    );
    for (const name of [
      '采用配音',
      '编辑台词',
      '生成配音',
      '导入配音',
      '删除台词',
      '保存台词',
      '提交制作',
    ])
      expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('discards a previous project response and clears its sound and cost selection on project switch', async () => {
    let resolveOld!: (value: DubbingSceneSnapshot) => void;
    const old = new Promise<DubbingSceneSnapshot>((resolve) => {
      resolveOld = resolve;
    });
    mockWorker((method, params) =>
      method === 'dubbing.scene.get' && (params as { sceneId: string }).sceneId === 'scene'
        ? old
        : method === 'dubbing.scene.get'
          ? { sceneId: 'new-scene', voices: [], cues: [], audioFiles: [], jobs: [] }
          : undefined,
    );
    const view = render(
      <DubbingScenePanel projectId="project" sceneId="scene" documents={[character]} writable />,
    );
    openPanel();
    view.rerender(
      <DubbingScenePanel projectId="new-project" sceneId="new-scene" documents={[]} writable />,
    );
    expect(screen.getByRole('button', { name: '打开配音' })).toBeInTheDocument();
    openPanel();
    await act(async () => {
      resolveOld(snapshot());
      await old;
    });
    await screen.findByText(/先在角色资料中保存声音/);
    expect(screen.queryByText('出发吧。')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/我确认生成配音或处理口型可能产生费用/)).not.toBeChecked();
  });
});

describe('fixed role voice editor', () => {
  it('saves a new immutable version through the stable character ID and CAS without generating audio', async () => {
    mockWorker((method) =>
      method === 'characterVoice.save' ? { ...voice, revision: 2, rowVersion: 3 } : undefined,
    );
    render(<VoiceProfilePanel projectId="project" characterDocumentId="character" writable />);
    await waitFor(() => expect(screen.getByLabelText('音色 ID')).toHaveValue('fixed-voice'));
    fireEvent.change(screen.getByLabelText('音色 ID'), {
      target: { value: 'another-fixed-voice' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存声音' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'characterVoice.save',
        expect.objectContaining({
          id: 'voice',
          characterDocumentId: 'character',
          expectedRowVersion: 2,
          voiceId: 'another-fixed-voice',
        }),
      ),
    );
    expect(callWorker).not.toHaveBeenCalledWith('dubbing.take.generate', expect.anything());
  });
});
