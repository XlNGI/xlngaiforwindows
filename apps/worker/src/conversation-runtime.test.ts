import { describe, expect, it, vi } from 'vitest';
import {
  ConversationRuntimeRouter,
  resolvePiConversationRuntimeEnabled,
  type ConversationRuntime,
  type ConversationRuntimeStartRequest,
} from './conversation-runtime.js';

const request: ConversationRuntimeStartRequest = {
  taskId: 'task',
  projectId: 'project',
  projectSessionId: 'session',
  conversationId: 'conversation',
  mode: 'short-drama',
};

function runtime(kind: 'legacy' | 'pi') {
  const start = vi.fn((input: ConversationRuntimeStartRequest) =>
    Promise.resolve({
      runtime: kind,
      taskId: input.taskId,
    }),
  );
  return { kind, start } satisfies ConversationRuntime;
}

describe('ConversationRuntimeRouter', () => {
  it('keeps every mode on Legacy when the Pi feature flag is omitted', async () => {
    const legacy = runtime('legacy');
    const pi = runtime('pi');
    const router = new ConversationRuntimeRouter(legacy, { piRuntime: pi });

    await expect(router.start(request)).resolves.toEqual({ runtime: 'legacy', taskId: 'task' });
    expect(legacy.start).toHaveBeenCalledOnce();
    expect(pi.start).not.toHaveBeenCalled();
  });

  it('routes only short-drama to Pi when explicitly enabled', () => {
    const legacy = runtime('legacy');
    const pi = runtime('pi');
    const router = new ConversationRuntimeRouter(legacy, { piEnabled: true, piRuntime: pi });

    expect(router.select('short-drama')).toBe(pi);
    expect(router.select('document')).toBe(legacy);
    expect(router.select('novel-writing')).toBe(legacy);
  });

  it('defaults the environment feature flag to disabled', () => {
    expect(resolvePiConversationRuntimeEnabled({})).toBe(false);
    expect(resolvePiConversationRuntimeEnabled({ AI_VIDEO_PI_CONVERSATION_RUNTIME: 'false' })).toBe(
      false,
    );
    expect(resolvePiConversationRuntimeEnabled({ AI_VIDEO_PI_CONVERSATION_RUNTIME: 'true' })).toBe(
      true,
    );
  });
});
