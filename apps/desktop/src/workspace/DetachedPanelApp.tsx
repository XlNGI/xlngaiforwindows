import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  ArrowDownLeft,
  CheckCircle2,
  FilePlus2,
  FileUp,
  RotateCcw,
  Save,
  Send,
  Undo2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatMessageInfo, ConversationScopeType } from '@ai-video/contracts';
import { ChatPanel } from '../ChatPanel';
import {
  DETACHED_PANEL_ACTION_EVENT,
  DETACHED_PANEL_READY_EVENT,
  DETACHED_PANEL_SNAPSHOT_EVENT,
  type DetachedConversationSnapshot,
  type DetachedDocumentSnapshot,
  type DetachedPanelAction,
  type DetachedPanelConfig,
  type DetachedPanelEnvelope,
  type DetachedPanelSnapshot,
} from './detached-window';

function documentStateLabel(state: DetachedDocumentSnapshot['state']): string {
  switch (state) {
    case 'draft':
      return '草稿';
    case 'changes_requested':
      return '需修改';
    case 'in_review':
      return '审核中';
    case 'published':
      return '已发布';
    case 'rejected':
      return '已退回';
    default:
      return '未保存';
  }
}

export function DetachedPanelApp({ config }: { config: DetachedPanelConfig }) {
  const [snapshot, setSnapshot] = useState<DetachedPanelSnapshot>();
  const lastSnapshotSequence = useRef(-1);
  const actionSequence = useRef(0);

  useEffect(() => {
    let active = true;
    const unlisten = listen<DetachedPanelEnvelope<DetachedPanelSnapshot>>(
      DETACHED_PANEL_SNAPSHOT_EVENT,
      (event) => {
        const envelope = event.payload;
        if (!active || envelope.label !== config.label) return;
        if (envelope.projectId && envelope.projectId !== config.projectId) return;
        if (envelope.entityId && envelope.entityId !== config.entityId) return;
        const sequence = envelope.sequence ?? 0;
        if (sequence <= lastSnapshotSequence.current) return;
        lastSnapshotSequence.current = sequence;
        setSnapshot(envelope.payload);
      },
    );
    void emitTo('main', DETACHED_PANEL_READY_EVENT, {
      label: config.label,
      projectId: config.projectId,
      entityId: config.entityId,
      sequence: 0,
      payload: config,
    });
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, [config]);

  const sendAction = (action: DetachedPanelAction) => {
    if (action.type === 'document-title') {
      setSnapshot((current) =>
        current?.panelId === 'document' ? { ...current, title: action.value } : current,
      );
    } else if (action.type === 'document-content') {
      setSnapshot((current) =>
        current?.panelId === 'document' ? { ...current, content: action.value } : current,
      );
    } else if (action.type === 'conversation-composer') {
      setSnapshot((current) =>
        current?.panelId === 'conversation' ? { ...current, composer: action.value } : current,
      );
    } else if (action.type === 'conversation-research-mode') {
      setSnapshot((current) =>
        current?.panelId === 'conversation' ? { ...current, researchMode: action.mode } : current,
      );
    }
    void emitTo('main', DETACHED_PANEL_ACTION_EVENT, {
      label: config.label,
      projectId: config.projectId,
      entityId: config.entityId,
      sequence: ++actionSequence.current,
      payload: action,
    });
  };

  const attach = () => {
    sendAction({ panelId: config.panelId, type: 'attach' });
    void getCurrentWindow().close();
  };

  if (
    !snapshot ||
    snapshot.projectId !== config.projectId ||
    (config.entityId &&
      (snapshot.panelId === 'document' ? snapshot.documentId : snapshot.conversation?.id) !==
        config.entityId)
  ) {
    return <div className="detached-panel-loading">正在连接主工作区...</div>;
  }

  return (
    <main className="detached-panel-shell">
      <header className="detached-panel-header">
        <div>
          <strong>
            {snapshot.panelId === 'document' ? snapshot.title || '文档编辑器' : '会话'}
          </strong>
          <span>{snapshot.projectName}</span>
        </div>
        <button type="button" title="附加回主窗口" onClick={attach}>
          <ArrowDownLeft size={15} />
          附加
        </button>
      </header>
      {snapshot.panelId === 'document' ? (
        <DetachedDocumentPanel snapshot={snapshot} onAction={sendAction} />
      ) : (
        <DetachedConversationPanel snapshot={snapshot} onAction={sendAction} />
      )}
    </main>
  );
}

function DetachedDocumentPanel({
  snapshot,
  onAction,
}: {
  snapshot: DetachedDocumentSnapshot;
  onAction: (action: DetachedPanelAction) => void;
}) {
  const currentVersion = snapshot.versions.find(
    (version) => version.id === snapshot.currentVersionId,
  );
  const editorWritable =
    snapshot.writable &&
    ['draft', 'changes_requested', 'published', 'new'].includes(snapshot.state);
  const dirty = Boolean(
    snapshot.title.trim() &&
    (!currentVersion ||
      currentVersion.titleSnapshot !== snapshot.title ||
      currentVersion.contentMarkdown !== snapshot.content),
  );

  return (
    <section className="detached-document-panel">
      <div className="workspace-toolbar">
        <div>
          <span className="eyebrow">正式项目资料</span>
          <h1>{snapshot.title || '文档编辑器'}</h1>
        </div>
        <div className="toolbar-actions">
          <button
            className="button secondary markdown-import-button"
            type="button"
            title="导入 Markdown"
            onClick={() => onAction({ panelId: 'document', type: 'document-import' })}
            disabled={!snapshot.writable || snapshot.busy}
          >
            <FileUp size={15} />
            <span>导入 Markdown</span>
          </button>
          <button
            className="button secondary"
            type="button"
            onClick={() => onAction({ panelId: 'document', type: 'document-new' })}
            disabled={!snapshot.writable}
          >
            <FilePlus2 size={15} />
            新建
          </button>
          <button
            className="button primary"
            type="button"
            onClick={() => onAction({ panelId: 'document', type: 'document-save' })}
            disabled={!editorWritable || snapshot.busy || !snapshot.title.trim()}
          >
            <Save size={15} />
            保存草稿
          </button>
          {['draft', 'changes_requested'].includes(snapshot.state) && (
            <button
              className="button secondary"
              type="button"
              title="提交审核"
              onClick={() => onAction({ panelId: 'document', type: 'document-submit-review' })}
              disabled={!editorWritable || snapshot.busy || dirty}
            >
              <Send size={15} />
              提交审核
            </button>
          )}
          {snapshot.state === 'in_review' && (
            <>
              <button
                className="button secondary"
                type="button"
                title="退回修改"
                onClick={() => onAction({ panelId: 'document', type: 'document-request-changes' })}
                disabled={!snapshot.writable || snapshot.busy}
              >
                <Undo2 size={15} />
                退回修改
              </button>
              <button
                className="button primary"
                type="button"
                title="发布权威版本"
                onClick={() => onAction({ panelId: 'document', type: 'document-publish' })}
                disabled={!snapshot.writable || snapshot.busy}
              >
                <CheckCircle2 size={15} />
                发布权威版本
              </button>
            </>
          )}
        </div>
      </div>
      <div className="document-workspace">
        <div className="document-fields">
          <label className="title-field">
            标题
            <input
              value={snapshot.title}
              onChange={(event) =>
                onAction({ panelId: 'document', type: 'document-title', value: event.target.value })
              }
              readOnly={!editorWritable}
            />
          </label>
          <span className={`document-state document-state-${snapshot.state}`}>
            {documentStateLabel(snapshot.state)}
          </span>
        </div>
        <textarea
          className="markdown-editor"
          aria-label="文档内容"
          value={snapshot.content}
          onChange={(event) =>
            onAction({ panelId: 'document', type: 'document-content', value: event.target.value })
          }
          readOnly={!editorWritable}
        />
        {snapshot.statusMessage && <div className="inline-status">{snapshot.statusMessage}</div>}
        {snapshot.versions.length > 0 && (
          <div className="version-strip">
            <span>历史版本</span>
            {snapshot.versions.map((version) => (
              <button
                type="button"
                key={version.id}
                onClick={() =>
                  onAction({
                    panelId: 'document',
                    type: 'document-restore',
                    versionId: version.id,
                  })
                }
                disabled={!editorWritable || version.id === snapshot.currentVersionId}
              >
                <RotateCcw size={12} />v{version.version}
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DetachedConversationPanel({
  snapshot,
  onAction,
}: {
  snapshot: DetachedConversationSnapshot;
  onAction: (action: DetachedPanelAction) => void;
}) {
  const promote = (message: ChatMessageInfo, target: 'document' | 'memory' | 'constraint') =>
    onAction({
      panelId: 'conversation',
      type: 'conversation-promote',
      messageId: message.id,
      target,
    });
  const changeScope = (scope: ConversationScopeType) =>
    onAction({ panelId: 'conversation', type: 'conversation-scope', scope });

  return (
    <ChatPanel
      {...snapshot}
      onClose={() => void getCurrentWindow().close()}
      onScopeChange={changeScope}
      onSelectConversation={(conversation) =>
        onAction({
          panelId: 'conversation',
          type: 'conversation-select',
          conversationId: conversation.id,
        })
      }
      onCreateConversation={() =>
        onAction({ panelId: 'conversation', type: 'conversation-create' })
      }
      onPromoteMessage={promote}
      onRetryGeneration={(messageId) =>
        onAction({ panelId: 'conversation', type: 'conversation-retry', messageId })
      }
      onLlmProfileChange={(profileId) =>
        onAction({ panelId: 'conversation', type: 'conversation-profile', profileId })
      }
      onLlmModelChange={(modelId) =>
        onAction({ panelId: 'conversation', type: 'conversation-model', modelId })
      }
      onResearchModeChange={(mode) =>
        onAction({ panelId: 'conversation', type: 'conversation-research-mode', mode })
      }
      onOpenProviderSettings={() =>
        onAction({ panelId: 'conversation', type: 'conversation-open-settings' })
      }
      onComposerChange={(value) =>
        onAction({ panelId: 'conversation', type: 'conversation-composer', value })
      }
      onCancelGeneration={() => onAction({ panelId: 'conversation', type: 'conversation-cancel' })}
      onSendMessage={() =>
        onAction({ panelId: 'conversation', type: 'conversation-send', value: snapshot.composer })
      }
    />
  );
}
