export interface AgentInputOption {
  id: string;
  label: string;
  description?: string;
}

export interface AgentInputQuestion {
  id: string;
  prompt: string;
  type: 'single' | 'multiple' | 'text';
  required?: boolean;
  options?: AgentInputOption[];
}

export interface AgentInputDraft {
  key: string;
  title: string;
  description?: string;
  questions: AgentInputQuestion[];
}

export interface AgentInputAnswer {
  questionId: string;
  optionIds: string[];
  text?: string;
}

export interface AgentInputForm extends AgentInputDraft {
  id: string;
  taskId: string;
  conversationId: string;
  createdAt: string;
  status: 'pending' | 'answered';
  answers?: AgentInputAnswer[];
  answeredAt?: string;
  continuationGenerationId?: string;
}

export interface AgentInputSubmitParams {
  taskId: string;
  formId: string;
  answers: AgentInputAnswer[];
}

export interface AgentInputSubmitResult {
  form: AgentInputForm;
  prompt: string;
  idempotencyKey: string;
}

/** Questions and choices are declared by the Agent; the application only validates and renders. */
export const AGENT_INPUT_DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['key', 'title', 'questions'],
  properties: {
    key: { type: 'string', minLength: 1, maxLength: 80 },
    title: { type: 'string', minLength: 1, maxLength: 200 },
    description: { type: 'string', maxLength: 2000 },
    questions: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'prompt', 'type'],
        properties: {
          id: { type: 'string', minLength: 1, maxLength: 80 },
          prompt: { type: 'string', minLength: 1, maxLength: 2000 },
          type: { type: 'string', enum: ['single', 'multiple', 'text'] },
          required: { type: 'boolean' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 12,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['id', 'label'],
              properties: {
                id: { type: 'string', minLength: 1, maxLength: 80 },
                label: { type: 'string', minLength: 1, maxLength: 200 },
                description: { type: 'string', maxLength: 500 },
              },
            },
          },
        },
      },
    },
  },
} as const;
