import { cleanup, render, screen } from '@testing-library/react';
import type { CharacterVoiceReferenceInfo } from '@ai-video/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callWorker } from '../worker-client';
import { VoiceProfilePanel } from './VoiceProfilePanel';

vi.mock('../worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./media', () => ({ useDubbingMedia: () => undefined }));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function sample(projectId: string, characterDocumentId: string): CharacterVoiceReferenceInfo {
  return {
    id: `${projectId}:${characterDocumentId}:reference`,
    projectId,
    characterDocumentId,
    characterName: characterDocumentId,
    versionId: `${projectId}:${characterDocumentId}:v1`,
    revision: 1,
    rowVersion: 1,
    audioId: `${projectId}:${characterDocumentId}:audio`,
    audioName: `${projectId}-${characterDocumentId}.wav`,
    durationMs: 3000,
    sizeBytes: 1024,
    mime: 'audio/wav',
  };
}

describe('voice panel identity changes', () => {
  it('keeps one current sample and voice editor when repeatedly switching characters', async () => {
    const references = ['张明', '老周', '林芳'].map((id) => sample('project', id));
    vi.mocked(callWorker).mockImplementation((method) =>
      Promise.resolve(method === 'characterVoiceReference.list' ? references : []),
    );
    const { rerender } = render(
      <VoiceProfilePanel projectId="project" characterDocumentId="张明" writable={false} />,
    );
    await screen.findByText(/project-张明.wav/);

    for (const id of ['老周', '林芳', '张明', '林芳', '老周']) {
      rerender(<VoiceProfilePanel projectId="project" characterDocumentId={id} writable />);
      await screen.findByText(new RegExp(`project-${id}.wav`));
      expect(screen.getAllByRole('heading', { name: '视频声音样本' })).toHaveLength(1);
      expect(screen.getAllByRole('heading', { name: '角色声音' })).toHaveLength(1);
      expect(screen.getByRole('button', { name: '更换声音样本' })).toBeEnabled();
      for (const reference of references.filter((item) => item.characterDocumentId !== id)) {
        expect(screen.queryByText(new RegExp(reference.audioName))).not.toBeInTheDocument();
      }
    }
  });

  it('removes prior samples when switching projects or opening narration settings', async () => {
    let references = [sample('first', 'character')];
    vi.mocked(callWorker).mockImplementation((method) =>
      Promise.resolve(method === 'characterVoiceReference.list' ? references : []),
    );
    const { rerender } = render(
      <VoiceProfilePanel projectId="first" characterDocumentId="character" writable />,
    );
    await screen.findByText(/first-character.wav/);

    references = [sample('second', 'character')];
    rerender(<VoiceProfilePanel projectId="second" characterDocumentId="character" writable />);
    await screen.findByText(/second-character.wav/);
    expect(screen.queryByText(/first-character.wav/)).not.toBeInTheDocument();
    expect(screen.getAllByRole('heading', { name: '视频声音样本' })).toHaveLength(1);

    rerender(<VoiceProfilePanel projectId="second" writable />);
    await screen.findByText('请先在设置中添加 MiniMax 配音连接。密钥在连接设置中填写。');
    expect(screen.getByRole('heading', { name: '旁白声音' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '视频声音样本' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '角色声音' })).not.toBeInTheDocument();
    expect(screen.queryByText(/second-character.wav/)).not.toBeInTheDocument();
  });
});
