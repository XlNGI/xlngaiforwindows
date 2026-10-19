import { useEffect, useReducer, useRef } from 'react';
import type { ConversationInfo, ProjectRuntimeScope } from '@ai-video/contracts';
import { projectWorker, workerScope } from './worker-scope';
import { SCENE_PROMPT_CONSTRAINT_TEMPLATE } from './conversation-prompt-template';

interface TemplateDraft {
  content: string;
  savedContent: string;
  rowVersion: number;
  loaded: boolean;
  defaultUnsaved?: boolean;
  loading?: Promise<void>;
  saving?: Promise<void>;
  error: string;
}

function draftKey(
  conversation: Pick<ConversationInfo, 'id' | 'projectId'>,
  scope?: ProjectRuntimeScope,
) {
  return `${conversation.projectId}:${scope?.projectSessionId ?? ''}:${conversation.id}`;
}

function templateError(reason: unknown): string {
  if (
    reason instanceof Error &&
    reason.message.includes('CONVERSATION_PROMPT_TEMPLATE_ROW_VERSION_CONFLICT')
  ) {
    return '会话约束已在其他窗口修改。请先复制当前编辑内容，再重新加载并合并后保存。';
  }
  return reason instanceof Error ? reason.message : '会话约束读取或保存失败，请重试。';
}

/** Drafts and in-flight operations retain their original conversation and project epoch. */
export function useConversationPromptTemplate(conversation?: ConversationInfo) {
  const [, redraw] = useReducer((version: number) => version + 1, 0);
  const drafts = useRef(new Map<string, TemplateDraft>());
  const scope = workerScope(conversation?.projectId);
  const key = conversation ? draftKey(conversation, scope) : undefined;
  const active = useRef(key);
  active.current = key;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const refresh = (owner: string) => {
    if (mounted.current && active.current === owner) redraw();
  };

  const load = async (target: ConversationInfo, reload = false): Promise<TemplateDraft> => {
    const capturedScope = workerScope(target.projectId);
    const owner = draftKey(target, capturedScope);
    let draft = drafts.current.get(owner);
    if (!draft) {
      draft = { content: '', savedContent: '', rowVersion: 0, loaded: false, error: '' };
      drafts.current.set(owner, draft);
    }
    const entry = draft;
    if (entry.saving) await entry.saving;
    if (!entry.loading && (!entry.loaded || reload)) {
      entry.error = '';
      entry.loading = Promise.resolve()
        .then(() =>
          projectWorker(capturedScope)('conversation.promptTemplate.get', {
            conversationId: target.id,
          }),
        )
        .then((saved) => {
          // A new conversation starts with a detailed editable starter. An
          // explicitly saved empty value remains empty and is never reseeded.
          entry.defaultUnsaved = saved.rowVersion === 0 && !saved.content;
          entry.content = entry.defaultUnsaved ? SCENE_PROMPT_CONSTRAINT_TEMPLATE : saved.content;
          entry.savedContent = saved.content;
          entry.rowVersion = saved.rowVersion;
          entry.loaded = true;
        })
        .catch((reason: unknown) => {
          entry.error = templateError(reason);
          throw reason;
        })
        .finally(() => {
          entry.loading = undefined;
          refresh(owner);
        });
      refresh(owner);
    }
    await entry.loading;
    return entry;
  };

  useEffect(() => {
    if (conversation) void load(conversation).catch(() => undefined);
  }, [key]);

  const saveForSubmission = async (target: ConversationInfo): Promise<string> => {
    const capturedScope = workerScope(target.projectId);
    const owner = draftKey(target, capturedScope);
    const entry = await load(target);
    // Save-button clicks and send may arrive in the same event turn.
    if (entry.saving) await entry.saving;
    const content = entry.content;
    if (content !== entry.savedContent || entry.defaultUnsaved) {
      entry.error = '';
      entry.saving = projectWorker(capturedScope)('conversation.promptTemplate.save', {
        conversationId: target.id,
        content,
        expectedRowVersion: entry.rowVersion,
      })
        .then((saved) => {
          entry.savedContent = saved.content;
          entry.rowVersion = saved.rowVersion;
          entry.defaultUnsaved = false;
        })
        .catch((reason: unknown) => {
          entry.error = templateError(reason);
          throw reason;
        })
        .finally(() => {
          entry.saving = undefined;
          refresh(owner);
        });
      refresh(owner);
      await entry.saving;
    }
    return content;
  };
  const draft = key ? drafts.current.get(key) : undefined;
  return {
    content: draft?.content ?? '',
    busy: Boolean(conversation && (!draft || draft.loading || draft.saving)),
    loading: Boolean(conversation && (!draft || draft.loading)),
    error: draft?.error ?? '',
    dirty: Boolean(draft && draft.content !== draft.savedContent),
    change: (content: string) => {
      if (!key || !draft?.loaded) return;
      draft.content = content;
      refresh(key);
    },
    reload: () =>
      conversation ? load(conversation, true).then(() => undefined) : Promise.resolve(),
    saveForSubmission,
  };
}
