import { useEffect, useRef, useState } from 'react';
import type { AgentInputAnswer, AgentInputForm, AgentInputSubmitResult } from '@ai-video/contracts';
import { projectWorker, workerScope } from './worker-scope';

function newerForm(saved: AgentInputForm, incoming: AgentInputForm): AgentInputForm {
  return saved.status === 'answered' && incoming.status === 'pending'
    ? saved
    : { ...saved, ...incoming };
}

export function AgentQuestionForm({
  form,
  projectId,
  writable,
  onContinue,
}: {
  form: AgentInputForm;
  projectId: string;
  writable: boolean;
  onContinue?: (result: AgentInputSubmitResult) => Promise<void>;
}) {
  const [current, setCurrent] = useState(form);
  const [answers, setAnswers] = useState<AgentInputAnswer[]>(
    () =>
      form.answers ??
      form.questions.map((question) => ({ questionId: question.id, optionIds: [] })),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const alive = useRef(true);
  const worker = useRef(projectWorker(workerScope(projectId))).current;
  useEffect(() => {
    setCurrent((saved) => newerForm(saved, form));
  }, [form]);
  useEffect(() => {
    alive.current = true;
    void worker('agent.input.get', { taskId: form.taskId, formId: form.id })
      .then((saved) => {
        if (alive.current) {
          setCurrent((current) => newerForm(current, saved));
          if (saved.answers) setAnswers(saved.answers);
        }
      })
      .catch((reason: Error) => {
        if (alive.current) setError(reason.message);
      });
    return () => {
      alive.current = false;
    };
  }, [worker, form.id, form.taskId]);
  const update = (id: string, value: Partial<AgentInputAnswer>) =>
    setAnswers((rows) =>
      rows.map((answer) => (answer.questionId === id ? { ...answer, ...value } : answer)),
    );
  const complete = current.status === 'answered';
  const submit = async () => {
    if (submitting.current || !writable || !onContinue) return;
    const values = current.status === 'answered' ? (current.answers ?? answers) : answers;
    const missing = current.questions.find((question) => {
      const answer = values.find((row) => row.questionId === question.id);
      return question.required !== false && !answer?.optionIds.length && !answer?.text?.trim();
    });
    if (missing) {
      setError(`请回答：${missing.prompt}`);
      return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await worker('agent.input.submit', {
        taskId: current.taskId,
        formId: current.id,
        answers: values,
      });
      if (!alive.current) return;
      setCurrent(result.form);
      await onContinue(result);
      if (!alive.current) return;
      const saved = await worker('agent.input.get', { taskId: current.taskId, formId: current.id });
      if (alive.current) setCurrent(saved);
    } catch (reason) {
      if (alive.current) setError((reason as Error).message);
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <form
      className="agent-question-form"
      aria-label={current.title}
      aria-busy={busy}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <header>
        <strong>{current.title}</strong>
        <small>{complete ? '已回答' : '待回答'}</small>
      </header>
      {current.description && <p>{current.description}</p>}
      {complete ? (
        <dl>
          {current.questions.map((question) => {
            const answer = current.answers?.find((row) => row.questionId === question.id);
            const labels = (question.options ?? [])
              .filter((option) => answer?.optionIds.includes(option.id))
              .map((option) => option.label);
            return (
              <div key={question.id}>
                <dt>{question.prompt}</dt>
                <dd>
                  {[...labels, ...(answer?.text ? [answer.text] : [])].join('；') ||
                    '未填写（可选）'}
                </dd>
              </div>
            );
          })}
        </dl>
      ) : (
        current.questions.map((question) => {
          const answer = answers.find((row) => row.questionId === question.id)!;
          return (
            <fieldset key={question.id} disabled={busy || !writable}>
              <legend>
                {question.prompt}
                {question.required === false ? '（可选）' : ''}
              </legend>
              {question.options?.map((option) => (
                <label className="agent-question-option" key={option.id}>
                  <input
                    type={question.type === 'multiple' ? 'checkbox' : 'radio'}
                    name={`${current.id}:${question.id}`}
                    checked={answer.optionIds.includes(option.id)}
                    onChange={(event) =>
                      update(question.id, {
                        optionIds:
                          question.type === 'single'
                            ? [option.id]
                            : event.target.checked
                              ? [...answer.optionIds, option.id]
                              : answer.optionIds.filter((id) => id !== option.id),
                      })
                    }
                  />
                  <span>
                    {option.label}
                    {option.description && <small>{option.description}</small>}
                  </span>
                </label>
              ))}
              <label className="agent-question-text">
                <span>
                  {question.type === 'text' ? '你的回答' : '其他想法或补充（也可直接填写）'}
                </span>
                <textarea
                  aria-label={`${question.prompt}：补充回答`}
                  value={answer.text ?? ''}
                  maxLength={4000}
                  onChange={(event) => update(question.id, { text: event.target.value })}
                />
              </label>
            </fieldset>
          );
        })
      )}
      {error && <p role="alert">{error}</p>}
      {(!complete || !current.continuationGenerationId) && (
        <button
          className="button primary"
          type="submit"
          disabled={busy || !writable || !onContinue}
        >
          {busy ? '正在提交…' : complete ? '继续处理' : '提交回答并继续'}
        </button>
      )}
    </form>
  );
}
