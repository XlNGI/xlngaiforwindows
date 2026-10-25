import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentInputForm, AgentInputSubmitResult } from '@ai-video/contracts';
import { AgentQuestionForm } from './AgentQuestionForm';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const form: AgentInputForm = {
  id: 'form',
  taskId: 'task',
  conversationId: 'conversation',
  createdAt: 'now',
  key: 'style',
  title: '确认创作方向',
  status: 'pending',
  questions: [
    {
      id: 'style',
      prompt: '画面风格',
      type: 'single',
      options: [
        { id: 'animation', label: '二维动画', description: '利落线条' },
        { id: 'film', label: '电影写实' },
      ],
    },
    {
      id: 'focus',
      prompt: '重点内容',
      type: 'multiple',
      required: false,
      options: [
        { id: 'action', label: '动作' },
        { id: 'emotion', label: '情绪' },
      ],
    },
    { id: 'notes', prompt: '剧情补充', type: 'text', required: false },
  ],
};
function mockForm(initial = form, continueRun?: () => Promise<void>) {
  let saved = initial;
  const onContinue = vi.fn<(result: AgentInputSubmitResult) => Promise<void>>(async () => {
    await continueRun?.();
    saved = { ...saved, continuationGenerationId: 'generation' };
  });
  vi.mocked(callWorker).mockImplementation(((
    method: string,
    params: { answers?: AgentInputForm['answers'] },
  ) => {
    if (method === 'agent.input.get') return Promise.resolve(saved);
    if (method === 'agent.input.submit') {
      saved = { ...saved, status: 'answered', answers: params.answers };
      return Promise.resolve({
        form: saved,
        prompt: '二维动画；冷灰雨夜',
        idempotencyKey: 'question-answer:form',
      } satisfies AgentInputSubmitResult);
    }
    return Promise.reject(new Error('Unexpected method'));
  }) as typeof callWorker);
  return onContinue;
}
it('has no default choices, validates required answers and submits single/multiple/text answers together', async () => {
  const onContinue = mockForm();
  render(<AgentQuestionForm form={form} projectId="project" writable onContinue={onContinue} />);
  await waitFor(() =>
    expect(callWorker).toHaveBeenCalledWith('agent.input.get', { taskId: 'task', formId: 'form' }),
  );
  expect(screen.getAllByRole('radio').every((input) => !(input as HTMLInputElement).checked)).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('请回答：画面风格');
  expect(callWorker).not.toHaveBeenCalledWith('agent.input.submit', expect.anything());
  fireEvent.click(screen.getByRole('radio', { name: /二维动画/ }));
  fireEvent.click(screen.getByRole('checkbox', { name: '动作' }));
  fireEvent.click(screen.getByRole('checkbox', { name: '情绪' }));
  fireEvent.change(screen.getByLabelText('剧情补充：补充回答'), { target: { value: '冷灰雨夜' } });
  fireEvent.click(screen.getByRole('button', { name: '提交回答并继续' }));
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
  expect(callWorker).toHaveBeenCalledWith('agent.input.submit', {
    taskId: 'task',
    formId: 'form',
    answers: [
      { questionId: 'style', optionIds: ['animation'] },
      { questionId: 'focus', optionIds: ['action', 'emotion'] },
      { questionId: 'notes', optionIds: [], text: '冷灰雨夜' },
    ],
  });
  expect(await screen.findByText('已回答')).toBeInTheDocument();
  expect(screen.getByText('冷灰雨夜')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
});
it('accepts a custom written answer without choosing an option and prevents double submission', async () => {
  let finish!: () => void;
  const onContinue = mockForm(
    form,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  render(<AgentQuestionForm form={form} projectId="project" writable onContinue={onContinue} />);
  fireEvent.change(screen.getByLabelText('画面风格：补充回答'), { target: { value: '水墨风' } });
  const button = screen.getByRole('button');
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1));
  expect(
    vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'agent.input.submit'),
  ).toHaveLength(1);
  finish();
  await waitFor(() => expect(screen.queryByRole('button')).not.toBeInTheDocument());
});
it('keeps saved answers on continuation failure, retries with the same key and ignores stale pending props', async () => {
  let fail = true;
  const onContinue = mockForm(form, () =>
    fail ? Promise.reject(new Error('启动失败')) : Promise.resolve(),
  );
  const mounted = render(
    <AgentQuestionForm form={form} projectId="project" writable onContinue={onContinue} />,
  );
  fireEvent.click(screen.getByRole('radio', { name: '电影写实' }));
  fireEvent.click(screen.getByRole('button'));
  expect(await screen.findByRole('alert')).toHaveTextContent('启动失败');
  mounted.rerender(
    <AgentQuestionForm form={{ ...form }} projectId="project" writable onContinue={onContinue} />,
  );
  expect(screen.getByText('已回答')).toBeInTheDocument();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: '继续处理' }));
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(2));
  expect(
    onContinue.mock.calls.every(([result]) => result.idempotencyKey === 'question-answer:form'),
  ).toBe(true);
});
it('restores the answered summary on reload and prevents editing or re-submitting a continued form', async () => {
  const saved: AgentInputForm = {
    ...form,
    status: 'answered',
    answers: [{ questionId: 'style', optionIds: ['film'] }],
    continuationGenerationId: 'generation',
  };
  mockForm(saved);
  render(<AgentQuestionForm form={form} projectId="project" writable onContinue={vi.fn()} />);
  expect(await screen.findByText('已回答')).toBeInTheDocument();
  expect(screen.getByText('电影写实')).toBeInTheDocument();
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('disables inputs and submission in a read-only project', () => {
  mockForm();
  render(
    <AgentQuestionForm form={form} projectId="project" writable={false} onContinue={vi.fn()} />,
  );
  expect(screen.getAllByRole('radio').every((input) => input.matches(':disabled'))).toBe(true);
  expect(screen.getByRole('button')).toBeDisabled();
});
