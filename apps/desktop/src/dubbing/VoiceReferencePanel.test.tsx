import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { CharacterVoiceReferenceInfo } from '@ai-video/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceReferencePanel } from './VoiceReferencePanel';
const mock = vi.hoisted(() => ({ call: vi.fn(), open: vi.fn(), play: vi.fn(), pause: vi.fn() }));
vi.mock('../worker-client', () => ({ callWorker: mock.call }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mock.open }));
vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: () => '/worker-media/audio/sample-audio',
}));

const reference: CharacterVoiceReferenceInfo = {
  id: 'reference',
  projectId: 'project',
  characterDocumentId: 'role-id',
  characterName: '角色',
  versionId: 'reference-v1',
  audioId: 'sample-audio',
  audioName: '角色声音.wav',
  durationMs: 3000,
  sizeBytes: 1024,
  mime: 'audio/wav',
  revision: 1,
  rowVersion: 1,
};
beforeEach(() => {
  mock.play.mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: false });
    queueMicrotask(() => fireEvent.play(this));
    return Promise.resolve();
  });
  mock.pause.mockImplementation(function (this: HTMLMediaElement) {
    Object.defineProperty(this, 'paused', { configurable: true, value: true });
    fireEvent.pause(this);
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(mock.play);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(mock.pause);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.resetAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
function mockReference(saved?: CharacterVoiceReferenceInfo) {
  mock.call.mockImplementation((method: string) => {
    if (method === 'characterVoiceReference.list') return Promise.resolve(saved ? [saved] : []);
    if (method === 'audio.mediaSource') return Promise.resolve({ path: 'C:/fixture/voice.wav' });
    if (method === 'audio.import') return Promise.resolve({ audio: { id: reference.audioId } });
    if (method === 'characterVoiceReference.save') {
      saved = reference;
      return Promise.resolve(saved);
    }
    throw new Error(method);
  });
}

describe('compact character audio', () => {
  it('starts with one add button and binds imported audio to the stable role ID', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mock.open.mockResolvedValue('C:/fixture/voice.wav');
    mockReference();
    render(<VoiceReferencePanel projectId="project" characterDocumentId="role-id" writable />);
    await waitFor(() => expect(screen.getByRole('button', { name: '添加音频' })).toBeEnabled());
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加音频' }));
    await screen.findByRole('button', { name: '试听 角色声音.wav' });
    expect(mock.call).toHaveBeenCalledWith('audio.import', {
      sourcePath: 'C:/fixture/voice.wav',
      kind: 'reference',
    });
    expect(mock.call).toHaveBeenCalledWith('characterVoiceReference.save', {
      characterDocumentId: 'role-id',
      audioId: reference.audioId,
      expectedRowVersion: 0,
    });
    expect(screen.getByRole('button', { name: '添加音频' })).toBeEnabled();
    expect(mock.call).not.toHaveBeenCalledWith('audio.mediaSource', expect.anything());
    expect(document.querySelector('audio')).not.toHaveAttribute('controls');
  });

  it('loads on icon click, pauses, resumes and resets after ending, including in read-only mode', async () => {
    mockReference(reference);
    render(
      <VoiceReferencePanel projectId="project" characterDocumentId="role-id" writable={false} />,
    );
    const preview = await screen.findByRole('button', { name: '试听 角色声音.wav' });
    expect(screen.getByRole('button', { name: '添加音频' })).toBeDisabled();
    expect(preview).toBeEnabled();
    expect(preview).toHaveTextContent('');
    expect(mock.call).not.toHaveBeenCalledWith('audio.mediaSource', expect.anything());
    await act(() => Promise.resolve(fireEvent.click(preview)));
    await screen.findByRole('button', { name: '暂停试听 角色声音.wav' });
    expect(mock.call).toHaveBeenCalledWith('audio.mediaSource', { audioId: 'sample-audio' });
    const audio = document.querySelector('audio')!;
    expect(audio).toHaveAttribute('src', '/worker-media/audio/sample-audio');
    expect(audio).toHaveAttribute('preload', 'none');
    await act(() => Promise.resolve(fireEvent.click(preview)));
    expect(preview).toHaveAttribute('aria-pressed', 'false');
    await act(() => Promise.resolve(fireEvent.click(preview)));
    await screen.findByRole('button', { name: '暂停试听 角色声音.wav' });
    fireEvent.ended(audio);
    expect(preview).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps audio on cancellation and sends its row version when replacing it', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mockReference(reference);
    mock.open.mockResolvedValueOnce(null).mockResolvedValueOnce('C:/fixture/new.wav');
    render(<VoiceReferencePanel projectId="project" characterDocumentId="role-id" writable />);
    await screen.findByRole('button', { name: '试听 角色声音.wav' });
    fireEvent.click(screen.getByRole('button', { name: '添加音频' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '添加音频' })).toBeEnabled());
    expect(mock.call).not.toHaveBeenCalledWith('audio.import', expect.anything());
    expect(screen.getByRole('button', { name: '试听 角色声音.wav' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加音频' }));
    await waitFor(() =>
      expect(mock.call).toHaveBeenCalledWith('characterVoiceReference.save', {
        characterDocumentId: 'role-id',
        audioId: 'sample-audio',
        expectedRowVersion: 1,
      }),
    );
  });

  it('shows playback errors and retries from the icon', async () => {
    mockReference(reference);
    mock.play.mockRejectedValueOnce(new Error('decode failed'));
    render(<VoiceReferencePanel projectId="project" characterDocumentId="role-id" writable />);
    const preview = await screen.findByRole('button', { name: '试听 角色声音.wav' });
    await act(() => Promise.resolve(fireEvent.click(preview)));
    expect(await screen.findByRole('status')).toHaveTextContent('音频暂时无法播放，请重试。');
    await act(() =>
      Promise.resolve(fireEvent.click(screen.getByRole('button', { name: '试听 角色声音.wav' }))),
    );
    await screen.findByRole('button', { name: '暂停试听 角色声音.wav' });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('stops playback and ignores a late import after changing character', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mockReference(reference);
    let finishDialog!: (path: string) => void;
    mock.open.mockReturnValue(
      new Promise<string>((resolve) => {
        finishDialog = resolve;
      }),
    );
    const { rerender } = render(
      <VoiceReferencePanel projectId="project" characterDocumentId="role-id" writable />,
    );
    const preview = await screen.findByRole('button', { name: '试听 角色声音.wav' });
    await act(() => Promise.resolve(fireEvent.click(preview)));
    await screen.findByRole('button', { name: '暂停试听 角色声音.wav' });
    fireEvent.click(screen.getByRole('button', { name: '添加音频' }));
    rerender(<VoiceReferencePanel projectId="project" characterDocumentId="other-role" writable />);
    await waitFor(() => expect(screen.getByRole('button', { name: '添加音频' })).toBeEnabled());
    expect(mock.pause).toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /试听/ })).not.toBeInTheDocument();
    await act(() => Promise.resolve(finishDialog('C:/fixture/late.wav')));
    expect(mock.call).not.toHaveBeenCalledWith('audio.import', expect.anything());
  });
});
