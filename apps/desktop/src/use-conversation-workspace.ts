import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type {
  ChatMessageInfo,
  ConversationInfo,
  ConversationScopeType,
  ProductionContextInfo,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';

export interface UseConversationWorkspaceOptions {
  projectId?: string;
  scopeAvailable: boolean;
  /** @deprecated Project conversations are the only user-facing workspace. */
  scopeType: ConversationScopeType;
  /** @deprecated Scene/shot conversation ids are retained only for migrations. */
  scopeId?: string;
  setMessages: Dispatch<SetStateAction<ChatMessageInfo[]>>;
  setContextPreview: Dispatch<SetStateAction<ProductionContextInfo | undefined>>;
  setChatMessage: Dispatch<SetStateAction<string>>;
  onCancelGenerationForConversation?: (conversationId: string) => Promise<void>;
}

export function useConversationWorkspace({
  projectId,
  scopeAvailable,
  setMessages,
  setContextPreview,
  setChatMessage,
  onCancelGenerationForConversation,
}: UseConversationWorkspaceOptions) {
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [conversationNextCursor, setConversationNextCursor] = useState<string>();
  const [showArchivedConversations, setShowArchivedConversations] = useState(false);
  const [conversation, setConversation] = useState<ConversationInfo>();
  const conversationRequest = useRef(0);

  useEffect(() => {
    const requestId = ++conversationRequest.current;
    let active = true;
    // The unified Agent always operates on the project conversation. Keep the
    // legacy scope arguments in the hook signature so old detached snapshots
    // and callers can migrate without changing persistence contracts.
    if (!projectId || !scopeAvailable) {
      setConversations([]);
      setConversationNextCursor(undefined);
      setConversation(undefined);
      setMessages([]);
      setContextPreview(undefined);
      return;
    }
    void (async () => {
      try {
        const page = await callWorker('conversation.list', {
          scopeType: 'project',
          includeArchived: showArchivedConversations,
        });
        const items = page.items;
        if (!active || requestId !== conversationRequest.current) return;
        const selected = items[0];
        const [messagePage, preview] = selected
          ? await Promise.all([
              callWorker('chat.message.list', { conversationId: selected.id }),
              callWorker('context.preview', { conversationId: selected.id }),
            ])
          : [undefined, undefined];
        if (!active || requestId !== conversationRequest.current) return;
        setConversations(items);
        setConversationNextCursor(page.nextCursor);
        setConversation(selected);
        setMessages(messagePage?.items ?? []);
        setContextPreview(preview);
        setChatMessage('');
      } catch (reason) {
        if (active && requestId === conversationRequest.current) {
          setChatMessage(reason instanceof Error ? reason.message : '会话加载失败');
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [
    projectId,
    scopeAvailable,
    showArchivedConversations,
    setMessages,
    setContextPreview,
    setChatMessage,
  ]);

  const createConversation = async () => {
    if (!scopeAvailable) return;
    const requestId = ++conversationRequest.current;
    try {
      const created = await callWorker('conversation.create', { scopeType: 'project' });
      const preview = await callWorker('context.preview', { conversationId: created.id });
      if (requestId !== conversationRequest.current) return;
      setConversations((current) => [created, ...current]);
      setConversation(created);
      setMessages([]);
      setContextPreview(preview);
    } catch (reason) {
      if (requestId === conversationRequest.current) {
        setChatMessage(reason instanceof Error ? reason.message : '会话创建失败');
      }
    }
  };

  const renameConversation = async (conversationId: string, title: string) => {
    try {
      const updated = await callWorker('conversation.update', { conversationId, title });
      setConversations((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setConversation((current) => (current?.id === updated.id ? updated : current));
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '会话重命名失败');
    }
  };

  const archiveConversation = async (conversationId: string) => {
    try {
      const updated = await callWorker('conversation.archive', { conversationId });
      if (!showArchivedConversations) {
        setConversations((current) => current.filter((item) => item.id !== conversationId));
        setConversation((current) => (current?.id === conversationId ? undefined : current));
      } else {
        setConversations((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
        setConversation((current) => (current?.id === updated.id ? updated : current));
      }
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '会话归档失败');
    }
  };

  const restoreConversation = async (conversationId: string) => {
    try {
      const updated = await callWorker('conversation.restore', { conversationId });
      setConversations((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      setConversation((current) => (current?.id === updated.id ? updated : current));
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '会话恢复失败');
    }
  };

  const loadMoreConversations = async () => {
    if (!projectId || !conversationNextCursor) return;
    const requestId = conversationRequest.current;
    try {
      const page = await callWorker('conversation.list', {
        scopeType: 'project',
        includeArchived: showArchivedConversations,
        limit: 50,
        cursor: conversationNextCursor,
      });
      if (requestId !== conversationRequest.current) return;
      setConversations((current) => {
        const known = new Set(current.map((item) => item.id));
        return [...current, ...page.items.filter((item) => !known.has(item.id))];
      });
      setConversationNextCursor(page.nextCursor);
    } catch (reason) {
      if (requestId === conversationRequest.current) {
        setChatMessage(reason instanceof Error ? reason.message : '会话加载失败');
      }
    }
  };

  const selectConversation = async (selected: ConversationInfo) => {
    const requestId = ++conversationRequest.current;
    setChatMessage('');
    try {
      if (onCancelGenerationForConversation) {
        await onCancelGenerationForConversation(selected.id);
        if (requestId !== conversationRequest.current) return;
      }
      setConversation(selected);
      const [messagePage, preview] = await Promise.all([
        callWorker('chat.message.list', { conversationId: selected.id }),
        callWorker('context.preview', { conversationId: selected.id }),
      ]);
      if (requestId !== conversationRequest.current) return;
      setMessages(messagePage.items);
      setContextPreview(preview);
    } catch (reason) {
      if (requestId === conversationRequest.current) {
        setChatMessage(reason instanceof Error ? reason.message : '会话加载失败');
      }
    }
  };

  const reset = () => {
    conversationRequest.current += 1;
    setConversations([]);
    setConversationNextCursor(undefined);
    setShowArchivedConversations(false);
    setConversation(undefined);
    setMessages([]);
    setContextPreview(undefined);
    setChatMessage('');
  };

  return {
    conversations,
    setConversations,
    conversation,
    setConversation,
    conversationNextCursor,
    setConversationNextCursor,
    showArchivedConversations,
    setShowArchivedConversations,
    conversationRequest,
    createConversation,
    renameConversation,
    archiveConversation,
    restoreConversation,
    loadMoreConversations,
    selectConversation,
    reset,
  };
}
