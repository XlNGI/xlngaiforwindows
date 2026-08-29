import type { ConversationTaskMode } from '@ai-video/contracts';

export type ConversationRuntimeKind = 'legacy' | 'pi';

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

/** Pi-independent runtime boundary. Concrete Pi execution is intentionally deferred past P2. */
export interface ConversationRuntime {
  readonly kind: ConversationRuntimeKind;
  start(request: ConversationRuntimeStartRequest): Promise<ConversationRuntimeStartResult>;
}

export interface ConversationRuntimeRouterOptions {
  piEnabled?: boolean;
  piRuntime?: ConversationRuntime;
}

/**
 * Routes only short-drama tasks to an explicitly enabled Pi runtime. All other
 * modes and the default configuration remain on the existing Legacy runtime.
 */
export class ConversationRuntimeRouter {
  private readonly piEnabled: boolean;
  private readonly piRuntime?: ConversationRuntime;

  constructor(
    private readonly legacyRuntime: ConversationRuntime,
    options: ConversationRuntimeRouterOptions = {},
  ) {
    if (legacyRuntime.kind !== 'legacy') {
      throw new Error('ConversationRuntimeRouter requires a Legacy runtime.');
    }
    if (options.piRuntime && options.piRuntime.kind !== 'pi') {
      throw new Error('The configured Pi runtime must use the pi runtime kind.');
    }
    this.piEnabled = options.piEnabled ?? false;
    this.piRuntime = options.piRuntime;
  }

  select(mode: ConversationTaskMode): ConversationRuntime {
    if (this.piEnabled && mode === 'short-drama' && this.piRuntime) return this.piRuntime;
    return this.legacyRuntime;
  }

  start(request: ConversationRuntimeStartRequest): Promise<ConversationRuntimeStartResult> {
    return this.select(request.mode).start(request);
  }
}

/** Feature flag is opt-in; absent, malformed, and false-like values are disabled. */
export function resolvePiConversationRuntimeEnabled(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const value = environment.AI_VIDEO_PI_CONVERSATION_RUNTIME?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
