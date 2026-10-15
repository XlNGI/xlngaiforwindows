import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DocumentSummary, SceneInfo } from '@ai-video/contracts';
import { SceneWorkspace } from './SceneWorkspace';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
vi.mock('./dubbing/DubbingScenePanel', () => ({ DubbingScenePanel: () => null }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const character = {
  id: 'actor',
  projectId: 'project',
  kind: 'character',
  title: '林澈',
  scopeType: 'project',
  lifecycleStatus: 'active',
  rowVersion: 1,
  createdAt: 'now',
  updatedAt: 'now',
} satisfies DocumentSummary;
const scene = {
  id: 'scene',
  projectId: 'project',
  title: '第一场',
  position: 0,
  rowVersion: 1,
  createdAt: 'now',
  updatedAt: 'now',
  characterBindings: [],
} satisfies SceneInfo;
const voice = {
  id: 'voice',
  projectId: 'project',
  characterDocumentId: 'actor',
  characterName: '林澈',
  versionId: 'v1',
  revision: 1,
  rowVersion: 1,
  audioId: 'sample',
  audioName: '林澈样本',
  durationMs: 3000,
  sizeBytes: 100,
  mime: 'audio/wav',
};
function mockWorker() {
  vi.mocked(callWorker).mockImplementation((method: string) =>
    Promise.resolve(
      method === 'characterVoiceReference.list'
        ? [voice]
        : method === 'audio.mediaSource'
          ? { path: 'D:/sample.wav' }
          : [],
    ),
  );
}
function props() {
  return {
    projectId: 'project',
    scene,
    prompt: '本场对话',
    bindings: [],
    documents: [character],
    assets: [],
    writable: true,
    onPromptChange: vi.fn(),
    onSave: vi.fn(),
    onGenerateVideo: vi.fn(),
    onRequestBindings: vi.fn(),
  };
}

describe('scene cast bindings', () => {
  it('adds a character and default voice without an image and saves the explicit relationship', async () => {
    mockWorker();
    const p = props();
    render(<SceneWorkspace {...p} />);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('characterVoiceReference.list', {}),
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '让助手关联角色与场景' })).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText('选择出场角色'), { target: { value: 'actor' } });
    fireEvent.click(screen.getByRole('button', { name: '添加角色' }));
    expect(screen.getByLabelText('林澈声音样本')).toHaveValue('v1');
    expect(screen.getByText('尚未选择参考图')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存提示词' }));
    expect(p.onSave).toHaveBeenCalledWith(
      '本场对话',
      [],
      [{ characterDocumentId: 'actor', voiceReferenceVersionId: 'v1' }],
      undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: '生成场次视频' }));
    expect(p.onGenerateVideo).toHaveBeenCalledWith(
      [],
      [{ characterDocumentId: 'actor', voiceReferenceVersionId: 'v1' }],
      undefined,
    );
  });
  it('preserves an outdated voice until explicitly changed and allows clearing it', async () => {
    mockWorker();
    const p = props();
    render(
      <SceneWorkspace
        {...p}
        scene={{
          ...scene,
          characterBindings: [{ characterDocumentId: 'actor', voiceReferenceVersionId: 'old' }],
        }}
      />,
    );
    expect(await screen.findByText(/声音样本已更新/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存提示词' }));
    expect(p.onSave).toHaveBeenLastCalledWith(
      p.prompt,
      [],
      [{ characterDocumentId: 'actor', voiceReferenceVersionId: 'old' }],
      undefined,
    );
    fireEvent.change(screen.getByLabelText('林澈声音样本'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '保存提示词' }));
    expect(p.onSave).toHaveBeenLastCalledWith(
      p.prompt,
      [],
      [{ characterDocumentId: 'actor', voiceReferenceVersionId: undefined }],
      undefined,
    );
  });
  it('delegates plain text and placeholders to the LLM without establishing local name bindings', async () => {
    mockWorker();
    const p = props();
    render(<SceneWorkspace {...p} prompt="林澈转身，[角色:林澈]看向他。" />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '让助手关联角色与场景' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '让助手关联角色与场景' }));
    expect(p.onRequestBindings).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText('林澈角色参考图')).not.toBeInTheDocument();
    expect(vi.mocked(callWorker).mock.calls.some(([method]) => method === 'asset.list')).toBe(
      false,
    );
  });
  it('shows the approved cast after a revision even when the prompt uses a pronoun', async () => {
    mockWorker();
    const p = props();
    const view = render(<SceneWorkspace {...p} prompt="他转身。" />);
    expect(screen.queryByLabelText('林澈声音样本')).not.toBeInTheDocument();
    view.rerender(
      <SceneWorkspace
        {...p}
        prompt="他转身。"
        scene={{
          ...scene,
          rowVersion: 2,
          characterBindings: [{ characterDocumentId: 'actor', voiceReferenceVersionId: 'v1' }],
        }}
      />,
    );
    expect(await screen.findByLabelText('林澈声音样本')).toHaveValue('v1');
    fireEvent.click(screen.getByRole('button', { name: '保存提示词' }));
    expect(p.onSave).toHaveBeenCalledWith(
      '他转身。',
      [],
      [{ characterDocumentId: 'actor', voiceReferenceVersionId: 'v1' }],
      undefined,
    );
  });
  it('keeps read-only viewing and prevents all binding edits', () => {
    mockWorker();
    render(
      <SceneWorkspace
        {...props()}
        writable={false}
        scene={{ ...scene, characterBindings: [{ characterDocumentId: 'actor' }] }}
      />,
    );
    expect(screen.getByLabelText('林澈角色参考图')).toBeDisabled();
    expect(screen.getByLabelText('场次完整对白音频')).toBeDisabled();
    expect(screen.getByRole('button', { name: '移除林澈' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '重新交给助手关联' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '保存提示词' })).toBeDisabled();
  });
});
