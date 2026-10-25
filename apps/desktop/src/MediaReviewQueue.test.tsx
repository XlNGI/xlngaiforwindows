import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MediaReviewForm, MediaModelSelectionDecision } from '@ai-video/contracts';
import { MediaReviewQueue } from './MediaReviewQueue';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const form: MediaReviewForm = {
  id: 'form',
  projectId: 'project',
  conversationId: 'conversation',
  draft: { key: 'shot', label: '镜头3-4', kind: 'video', prompt: '完整动态提示词' },
  status: 'pending',
  rowVersion: 2,
  reviewToken: 'review-snapshot',
  blockers: [],
  inputAssetIds: ['character'],
  createdAt: 'now',
  selectionRequest: {
    selectionToken: 'review',
    kind: 'video',
    prompt: '完整动态提示词',
    inputAssetIds: ['character'],
    inputAttachmentCount: 0,
    proposedParameters: { duration: 5 },
    candidates: [],
    expiresAt: '9999-01-01',
  },
};
const selection: MediaModelSelectionDecision = {
  providerProfileId: 'profile',
  modelId: 'model',
  adapterKey: 'video',
  parameters: { prompt: '用户调整后的提示词', duration: 6 },
};
const renderMediaForm = (
  _form: MediaReviewForm,
  submit: (selection: MediaModelSelectionDecision) => void,
) => <button onClick={() => submit(selection)}>审核并提交视频</button>;
function mockQueue(value: MediaReviewForm, submit?: () => Promise<MediaReviewForm>) {
  vi.mocked(callWorker).mockImplementation(((method: string) =>
    Promise.resolve(
      method === 'media.review.list'
        ? [value]
        : method === 'media.review.get'
          ? value
          : method === 'media.review.submit'
            ? submit?.()
            : value,
    )) as typeof callWorker);
}
describe('MediaReviewQueue', () => {
  it('restores saved forms, uses edited parameters and never invokes another Agent on submit', async () => {
    mockQueue(form, () => Promise.resolve({ ...form, status: 'submitted', jobId: 'job' }));
    render(
      <MediaReviewQueue
        projectId="project"
        conversationId="conversation"
        writable
        renderMediaForm={renderMediaForm}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /镜头3-4/ }));
    fireEvent.click(await screen.findByRole('button', { name: '审核并提交视频' }));
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('media.review.submit', {
        formId: 'form',
        expectedRowVersion: 2,
        reviewToken: 'review-snapshot',
        selection,
      }),
    );
    expect(callWorker).not.toHaveBeenCalledWith('agent.run', expect.anything());
    expect(await screen.findByText(/已关联生成任务/)).toBeInTheDocument();
  });
  it('displays unresolved references and prevents submission of blocked or read-only forms', async () => {
    mockQueue({ ...form, blockers: ['等待角色图片完成'] });
    const mounted = render(
      <MediaReviewQueue
        projectId="project"
        conversationId="conversation"
        writable
        renderMediaForm={renderMediaForm}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /镜头3-4/ }));
    await waitFor(() => expect(screen.getAllByText('等待角色图片完成').length).toBeGreaterThan(0));
    expect(screen.queryByText('审核并提交视频')).not.toBeInTheDocument();
    mockQueue(form);
    mounted.rerender(
      <MediaReviewQueue
        projectId="project"
        conversationId="conversation"
        writable={false}
        renderMediaForm={renderMediaForm}
      />,
    );
    expect(screen.queryByText('审核并提交视频')).not.toBeInTheDocument();
  });
  it('requires an audio review and submits the edited cue through the same queue', async () => {
    const audio: MediaReviewForm = {
      ...form,
      draft: {
        key: 'audio',
        label: '顾清影台词',
        kind: 'audio',
        prompt: '清冷声音',
        audio: {
          sceneId: 'scene',
          speakerKind: 'character',
          characterDocumentId: 'character',
          text: '原台词',
          position: 0,
          startMs: 0,
        },
      },
      voices: [
        {
          id: 'voice',
          voiceId: '清影音色',
          model: 'speech',
          characterDocumentId: 'character',
        } as never,
      ],
    };
    mockQueue(audio, () => Promise.resolve({ ...audio, status: 'submitted', jobId: 'audio-job' }));
    render(
      <MediaReviewQueue
        projectId="project"
        conversationId="conversation"
        writable
        renderMediaForm={renderMediaForm}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /顾清影台词/ }));
    const submit = await screen.findByRole('button', { name: '提交生成' });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText('配音台词'), { target: { value: '修改后的台词' } });
    fireEvent.change(screen.getByLabelText('配音声音'), { target: { value: 'voice' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(submit);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith(
        'media.review.submit',
        expect.objectContaining({
          audio: expect.objectContaining({
            text: '修改后的台词',
            voiceProfileId: 'voice',
          }) as unknown as object,
        }),
      ),
    );
  });
});
