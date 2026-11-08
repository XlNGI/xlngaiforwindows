import type { ConversationTaskMode } from '@ai-video/contracts';

export type ConversationRuntimeKind = 'pi';

export interface ConversationRuntimeStartRequest {
  taskId: string;
  projectId: string;
  projectSessionId: string;
  conversationId: string;
  mode: ConversationTaskMode;
  /** Native generation identity and prompt are supplied by the Worker owner. */
  identity?: import('@ai-video/contracts').LlmGenerationIdentity;
  prompt?: string;
}

export interface ConversationRuntimeStartResult {
  runtime: ConversationRuntimeKind;
  taskId: string;
}

/** Worker-owned conversation execution boundary. */
export interface ConversationRuntime {
  readonly kind: ConversationRuntimeKind;
  start(request: ConversationRuntimeStartRequest): Promise<ConversationRuntimeStartResult>;
}
