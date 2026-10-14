import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceReferencePanel } from './VoiceReferencePanel';
const mock = vi.hoisted(() => ({ call: vi.fn(), open: vi.fn() }));
vi.mock('../worker-client', () => ({ callWorker: mock.call }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: mock.open }));
vi.mock('./media', () => ({ useDubbingMedia: () => ({ src: 'fixture-voice.wav' }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});
describe('role voice sample import', () => {
  it('imports independent reference audio, binds the stable role ID and exposes playback', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    mock.open.mockResolvedValue('C:/fixture/voice.wav');
    mock.call.mockImplementation((method: string) => {
      if (method === 'characterVoiceReference.list') return Promise.resolve([]);
      if (method === 'audio.import') return Promise.resolve({ audio: { id: 'sample-audio' } });
      if (method === 'characterVoiceReference.save')
        return Promise.resolve({
          id: 'reference',
          characterDocumentId: 'role-id',
          audioId: 'sample-audio',
          audioName: '角色声音',
          durationMs: 3000,
          revision: 1,
          rowVersion: 1,
        });
      throw new Error(method);
    });
    render(<VoiceReferencePanel projectId="project" characterDocumentId="role-id" writable />);
    await waitFor(() => expect(mock.call).toHaveBeenCalledWith('characterVoiceReference.list', {}));
    fireEvent.click(screen.getByRole('button', { name: '导入声音样本' }));
    await screen.findByText('角色声音样本已保存，制作视频时可选择复用。');
    expect(mock.call).toHaveBeenCalledWith('audio.import', {
      sourcePath: 'C:/fixture/voice.wav',
      kind: 'reference',
    });
    expect(mock.call).toHaveBeenCalledWith('characterVoiceReference.save', {
      characterDocumentId: 'role-id',
      audioId: 'sample-audio',
      expectedRowVersion: 0,
    });
    expect(document.querySelector('audio')?.getAttribute('src')).toBe('fixture-voice.wav');
  });
});
