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
  it('routes every mode to Pi by default', async () => {
    const legacy = runtime('legacy');
    const pi = runtime('pi');
    const router = new ConversationRuntimeRouter(legacy, { piRuntime: pi });

    await expect(router.start(request)).resolves.toEqual({ runtime: 'pi', taskId: 'task' });
    expect(legacy.start).not.toHaveBeenCalled();
    expect(pi.start).toHaveBeenCalledOnce();
  });

  it('uses the same Pi runtime for document, novel, and short-drama workflows', () => {
    const legacy = runtime('legacy');
    const pi = runtime('pi');
    const router = new ConversationRuntimeRouter(legacy, { piEnabled: true, piRuntime: pi });

    expect(router.select('short-drama')).toBe(pi);
    expect(router.select('document')).toBe(pi);
    expect(router.select('novel-writing')).toBe(pi);
  });

  it('defaults Pi on and retains an explicit development fallback', () => {
    expect(resolvePiConversationRuntimeEnabled({})).toBe(true);
    expect(resolvePiConversationRuntimeEnabled({ AI_VIDEO_PI_CONVERSATION_RUNTIME: '0' })).toBe(
      false,
    );
    expect(resolvePiConversationRuntimeEnabled({ AI_VIDEO_PI_CONVERSATION_RUNTIME: 'false' })).toBe(
      false,
    );
    expect(resolvePiConversationRuntimeEnabled({ AI_VIDEO_PI_CONVERSATION_RUNTIME: 'true' })).toBe(
      true,
    );
  });

  it('uses Legacy for every mode when the development fallback is explicit', () => {
    const legacy = runtime('legacy');
    const pi = runtime('pi');
    const router = new ConversationRuntimeRouter(legacy, { piEnabled: false, piRuntime: pi });

    expect(router.select('short-drama')).toBe(legacy);
    expect(router.select('document')).toBe(legacy);
    expect(router.select('novel-writing')).toBe(legacy);
  });
});
