import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type Database from 'better-sqlite3';
import { validateToolArguments } from '@earendil-works/pi-ai';
import {
  AGENT_INPUT_DRAFT_SCHEMA,
  type AgentInputAnswer,
  type AgentInputDraft,
  type AgentInputForm,
  type AgentInputSubmitParams,
  type AgentInputSubmitResult,
} from '@ai-video/contracts';
import { ProjectService } from './project-service.js';

type EventRow = { id: string; payload_json: string; created_at: string };

/** Durable user questions share the existing task event log and ordinary Agent continuation. */
export class AgentInputService {
  constructor(private readonly projects: ProjectService) {}

  prepare(
    raw: unknown,
    identity: { taskId?: string; projectId: string; conversationId: string },
  ): AgentInputForm {
    const parsed: unknown = validateToolArguments(
      {
        name: 'conversation.ask',
        description: '',
        parameters: AGENT_INPUT_DRAFT_SCHEMA,
      },
      {
        type: 'toolCall',
        id: 'validation',
        name: 'conversation.ask',
        arguments: raw as Record<string, unknown>,
      },
    );
    const draft = parsed as AgentInputDraft;
    if (Buffer.byteLength(JSON.stringify(draft), 'utf8') > 32768)
      throw new Error('Question form exceeds 32768 bytes.');
    const ids = new Set<string>();
    for (const question of draft.questions) {
      if (!question.id.trim() || !question.prompt.trim() || ids.has(question.id))
        throw new Error('Question IDs must be unique and questions must have text.');
      ids.add(question.id);
      if (question.type === 'text' ? question.options !== undefined : !question.options)
        throw new Error('Choice questions need options; text questions do not take options.');
      const options = question.options ?? [];
      if (
        new Set(options.map((option) => option.id)).size !== options.length ||
        options.some((option) => !option.id.trim() || !option.label.trim())
      )
        throw new Error('Option IDs must be unique and options must have labels.');
    }
    if (!draft.key.trim() || !draft.title.trim())
      throw new Error('Form key and title are required.');
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        if (identity.projectId !== project.id) throw new Error('Question project does not match.');
        requireTask(database, project.id, identity.taskId, identity.conversationId);
        const dedupe = `user-input:request:${draft.key}`;
        const existing = database
          .prepare('SELECT * FROM agent_task_events WHERE task_id=? AND dedupe_key=?')
          .get(identity.taskId, dedupe) as EventRow | undefined;
        if (existing) {
          const form = readForm(database, project.id, identity.taskId!, existing.id);
          const saved = {
            key: form.key,
            title: form.title,
            ...(form.description !== undefined ? { description: form.description } : {}),
            questions: form.questions,
          };
          if (!isDeepStrictEqual(saved, draft))
            throw new Error('Form key already has a different question draft.');
          return form;
        }
        const count = database
          .prepare(
            "SELECT COUNT(*) AS count FROM agent_task_events WHERE task_id=? AND event_type='agent.user_input.requested'",
          )
          .get(identity.taskId) as { count: number };
        if (count.count >= 16) throw new Error('This task already has 16 question forms.');
        const form: AgentInputForm = {
          ...draft,
          id: randomUUID(),
          taskId: identity.taskId!,
          conversationId: identity.conversationId,
          createdAt: new Date().toISOString(),
          status: 'pending',
        };
        appendEvent(
          database,
          project.id,
          form.taskId,
          form.id,
          'agent.user_input.requested',
          draft.title,
          form,
          dedupe,
        );
        return form;
      })(),
    );
  }

  get(taskId: string, formId: string): AgentInputForm {
    return this.projects.access(false, (database, project) =>
      readForm(database, project.id, taskId, formId),
    );
  }

  submit(params: AgentInputSubmitParams): AgentInputSubmitResult {
    return this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const form = readForm(database, project.id, params.taskId, params.formId);
        const answers = validateAnswers(form, params.answers);
        if (form.status === 'answered') {
          if (JSON.stringify(answers) !== JSON.stringify(form.answers))
            throw new Error('This form has already been answered with different values.');
        } else {
          const answeredAt = new Date().toISOString();
          appendEvent(
            database,
            project.id,
            form.taskId,
            randomUUID(),
            'agent.user_input.answered',
            `已回答：${form.title}`,
            { formId: form.id, answers, answeredAt },
            `user-input:answer:${form.id}`,
          );
        }
        return {
          form: readForm(database, project.id, form.taskId, form.id),
          prompt: answerPrompt(form, answers),
          idempotencyKey: `question-answer:${form.id}`,
        };
      })(),
    );
  }
}

function requireTask(
  database: Database.Database,
  projectId: string,
  taskId?: string,
  conversationId?: string,
) {
  const task = database
    .prepare('SELECT conversation_id FROM agent_tasks WHERE id=? AND project_id=?')
    .get(taskId ?? '', projectId) as { conversation_id: string | null } | undefined;
  if (!task?.conversation_id || (conversationId && task.conversation_id !== conversationId))
    throw new Error('Question task was not found in this project and conversation.');
  return task;
}

function readForm(
  database: Database.Database,
  projectId: string,
  taskId: string,
  formId: string,
): AgentInputForm {
  const task = requireTask(database, projectId, taskId);
  const row = database
    .prepare(
      "SELECT * FROM agent_task_events WHERE id=? AND task_id=? AND project_id=? AND event_type='agent.user_input.requested'",
    )
    .get(formId, taskId, projectId) as EventRow | undefined;
  if (!row) throw new Error('Question form was not found.');
  const form = JSON.parse(row.payload_json) as AgentInputForm;
  if (form.id !== row.id || form.conversationId !== task.conversation_id)
    throw new Error('Question form scope does not match.');
  const answered = database
    .prepare('SELECT payload_json FROM agent_task_events WHERE task_id=? AND dedupe_key=?')
    .get(taskId, `user-input:answer:${formId}`) as Pick<EventRow, 'payload_json'> | undefined;
  const generation = database
    .prepare(
      'SELECT id FROM llm_generations WHERE project_id=? AND conversation_id=? AND idempotency_key=?',
    )
    .get(projectId, form.conversationId, `question-answer:${formId}`) as { id: string } | undefined;
  if (answered) {
    const response = JSON.parse(answered.payload_json) as {
      answers: AgentInputAnswer[];
      answeredAt: string;
    };
    return {
      ...form,
      status: 'answered',
      answers: response.answers,
      answeredAt: response.answeredAt,
      ...(generation ? { continuationGenerationId: generation.id } : {}),
    };
  }
  return form;
}

function validateAnswers(form: AgentInputForm, raw: unknown): AgentInputAnswer[] {
  if (!Array.isArray(raw) || raw.length !== form.questions.length)
    throw new Error('Provide one answer for every question.');
  const answers = raw as AgentInputAnswer[];
  if (new Set(answers.map((answer) => answer?.questionId)).size !== answers.length)
    throw new Error('Question answers must be unique.');
  return form.questions.map((question) => {
    const answer = answers.find((item) => item?.questionId === question.id);
    if (
      !answer ||
      typeof answer !== 'object' ||
      Object.keys(answer).some((key) => !['questionId', 'optionIds', 'text'].includes(key)) ||
      !Array.isArray(answer.optionIds) ||
      answer.optionIds.length > 12 ||
      answer.optionIds.some((id) => typeof id !== 'string') ||
      new Set(answer.optionIds).size !== answer.optionIds.length ||
      (answer.text !== undefined && (typeof answer.text !== 'string' || answer.text.length > 4000))
    )
      throw new Error('Invalid question answer.');
    const text = answer.text?.trim() ?? '';
    const allowed = question.options ?? [];
    if (
      answer.optionIds.some((id) => !allowed.some((option) => option.id === id)) ||
      (question.type !== 'multiple' && answer.optionIds.length > (question.type === 'text' ? 0 : 1))
    )
      throw new Error('Selected options do not match the question.');
    if (question.required !== false && !answer.optionIds.length && !text)
      throw new Error(`请回答：${question.prompt}`);
    return {
      questionId: question.id,
      optionIds: allowed
        .filter((option) => answer.optionIds.includes(option.id))
        .map((option) => option.id),
      ...(text ? { text } : {}),
    };
  });
}

function answerPrompt(form: AgentInputForm, answers: AgentInputAnswer[]): string {
  return [
    `我已填写「${form.title}」问答表单：`,
    ...form.questions.map((question, index) => {
      const answer = answers[index]!;
      const labels = (question.options ?? [])
        .filter((option) => answer.optionIds.includes(option.id))
        .map((option) => option.label);
      return `${index + 1}. ${question.prompt}\n${[...labels, ...(answer.text ? [answer.text] : [])].join('；') || '未填写（可选）'}`;
    }),
    '请结合以上回答继续之前的任务。',
  ].join('\n\n');
}

function appendEvent(
  database: Database.Database,
  projectId: string,
  taskId: string,
  id: string,
  type: string,
  summary: string,
  payload: unknown,
  dedupe: string,
) {
  database
    .prepare(
      `INSERT INTO agent_task_events
    (id,task_id,project_id,sequence,event_type,level,actor_type,summary,payload_json,dedupe_key,created_at)
    VALUES (?,?,?,(SELECT COALESCE(MAX(sequence),-1)+1 FROM agent_task_events WHERE task_id=?),?,'info',?,?,?, ?,?)`,
    )
    .run(
      id,
      taskId,
      projectId,
      taskId,
      type,
      type.endsWith('answered') ? 'user' : 'assistant',
      summary,
      JSON.stringify(payload),
      dedupe,
      new Date().toISOString(),
    );
}
