import {
  AlertTriangle,
  Archive,
  Bot,
  BookOpen,
  ChevronDown,
  ChevronRight,
  Copy,
  Ellipsis,
  MessageSquarePlus,
  PanelRightClose,
  Paperclip,
  Pencil,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Square,
  Terminal,
} from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentResearchMode,
  ChatMessageInfo,
  ConversationInfo,
  ConversationScopeType,
  LlmGenerationInfo,
  LlmStatusResult,
  ProviderModelInfo,
  ProviderProfileInfo,
  ProductionContextInfo,
  AgentToolConfirmationRequest,
  AgentTaskPendingConfirmationInfo,
  AgentProtectedUiHandoff,
  AdapterDescriptor,
  AdapterParameters,
  AdapterParameterProperty,
  AgentTaskDetail,
  AgentLibrarySourceInfo,
  ConversationRuntimeLiveAction,
  MediaModelCandidate,
  MediaModelSelectionDecision,
  MediaModelSelectionRequest,
  UnifiedAgentModelSelectionRequest,
  LibraryCatalogItem,
} from '@ai-video/contracts';

export interface ChatAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video' | 'file';
  dataUrl?: string;
  /** Bounded still frame sent to vision models instead of the full video payload. */
  previewDataUrl?: string;
  text?: string;
}

const DEFAULT_CONVERSATION_TITLES = new Set(['', '新会话', '会话']);

function isDefaultConversationTitle(title: string): boolean {
  return DEFAULT_CONVERSATION_TITLES.has(title.trim());
}

function visibleLibraryCatalog(catalog: LibraryCatalogItem[]): LibraryCatalogItem[] {
  const items: LibraryCatalogItem[] = [];
  let untitledConversations = 0;
  for (const item of catalog) {
    if (item.sourceType === 'conversation' && isDefaultConversationTitle(item.title)) {
      untitledConversations += 1;
      continue;
    }
    items.push(item);
  }
  if (untitledConversations > 0) {
    items.push({
      id: 'catalog:conversations',
      sourceType: 'conversation',
      sourceId: 'conversations',
      status: 'conversation',
      title: untitledConversations === 1 ? '会话记录' : `会话记录 ${untitledConversations} 条`,
      updatedAt: catalog.find((item) => item.sourceType === 'conversation')?.updatedAt ?? '',
    });
  }
  return items;
}

interface ChatPanelProps {
  /** Retained for detached-window and migration compatibility; always project. */
  scopeType: ConversationScopeType;
  scopeAvailable: boolean;
  writable: boolean;
  conversations: ConversationInfo[];
  conversation?: ConversationInfo;
  messages: ChatMessageInfo[];
  composer: string;
  statusMessage: string;
  llmStatus?: LlmStatusResult;
  legacyLlmConfigured: boolean;
  llmProfiles: ProviderProfileInfo[];
  llmModels: ProviderModelInfo[];
  selectedLlmProfileId: string;
  selectedLlmModelId: string;
  researchMode?: AgentResearchMode;
  contextPreview?: ProductionContextInfo;
  generation?: LlmGenerationInfo;
  agentTask?: import('@ai-video/contracts').AgentTaskDetail;
  agentTasks?: import('@ai-video/contracts').AgentTaskDetail[];
  liveAgentActions?: ConversationRuntimeLiveAction[];
  onConfirmSchemaProposal?: (adapterKey: string, version: number) => void;
  onRejectSchemaProposal?: (adapterKey: string, version: number) => void;
  confirmation?: AgentToolConfirmationRequest | AgentTaskPendingConfirmationInfo;
  activeVideoTaskCount?: number;
  onConfirmAgentAction?: (approved: boolean) => void;
  onOpenProtectedUi?: (handoff: AgentProtectedUiHandoff) => void;
  onOpenTaskLog?: () => void;
  onContinueAgentTask?: () => void;
  onClose?: () => void;
  showCloseAction?: boolean;
  /**
   * Hosts that already render a panel title (docked pane tab, floating titlebar,
   * detached window header) hide this heading so the panel is not labelled twice.
   */
  showHeading?: boolean;
  /** @deprecated Use onClose. Kept temporarily for component consumers outside the workspace host. */
  onCollapse?: () => void;
  onSelectConversation: (conversation: ConversationInfo) => void;
  onCreateConversation: () => void;
  showArchivedConversations?: boolean;
  onShowArchivedConversationsChange?: (show: boolean) => void;
  onRenameConversation?: (conversationId: string, title: string) => void;
  onArchiveConversation?: (conversationId: string) => void;
  onRestoreConversation?: (conversationId: string) => void;
  canLoadMoreConversations?: boolean;
  onLoadMoreConversations?: () => void;
  onRetryGeneration: (assistantMessageId: string) => void;
  onLlmProfileChange: (profileId: string) => void;
  onLlmModelChange: (modelId: string) => void;
  onResearchModeChange?: (mode: AgentResearchMode) => void;
  onOpenProviderSettings: () => void;
  onComposerChange: (value: string) => void;
  onCancelGeneration: () => void;
  onSendMessage: () => void;
  attachments?: ChatAttachment[];
  onAddAttachments?: (files: FileList | File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  agentModelSelection?: UnifiedAgentModelSelectionRequest;
  onSelectAgentModel?: (providerProfileId: string, modelId: string) => void;
  mediaModelSelection?: MediaModelSelectionRequest;
  mediaReferenceImageInputs?: string[];
  onSelectMediaModel?: (selection: MediaModelSelectionDecision) => void;
  onCancelMediaModelSelection?: () => void;
  /** One-shot episode chapter range for the next send only. */
  selectedChapterCount?: number;
  onClearSelectedChapters?: () => void;
  canLoadEarlierMessages?: boolean;
  loadingEarlierMessages?: boolean;
  onLoadEarlierMessages?: () => void;
  onOpenLibrarySource?: (source: AgentLibrarySourceInfo) => void;
  agentParameterRequest?: {
    prompt: string;
    capability: 'image' | 'video';
    providerProfileId: string;
    modelId: string;
    modelName: string;
    adapters: AdapterDescriptor[];
    affectsCost: boolean;
    referenceImageInputs?: string[];
    proposedParameters?: AdapterParameters;
  };
  onSubmitAgentParameters?: (adapterKey: string, parameters: AdapterParameters) => void;
}

export function ChatPanel({
  scopeAvailable,
  writable,
  conversations,
  conversation,
  messages,
  composer,
  statusMessage,
  llmStatus,
  legacyLlmConfigured,
  llmProfiles,
  llmModels,
  selectedLlmProfileId,
  selectedLlmModelId,
  researchMode = 'auto',
  contextPreview,
  generation,
  agentTask,
  agentTasks,
  liveAgentActions = [],
  confirmation,
  activeVideoTaskCount = 0,
  onConfirmAgentAction,
  onOpenProtectedUi,
  onConfirmSchemaProposal,
  onRejectSchemaProposal,
  onOpenTaskLog,
  onContinueAgentTask,
  onClose,
  showCloseAction = true,
  showHeading = true,
  onCollapse,
  onSelectConversation,
  onCreateConversation,
  showArchivedConversations = false,
  onShowArchivedConversationsChange,
  onRenameConversation,
  onArchiveConversation,
  onRestoreConversation,
  canLoadMoreConversations,
  onLoadMoreConversations,
  onRetryGeneration,
  onLlmProfileChange,
  onLlmModelChange,
  onResearchModeChange,
  onOpenProviderSettings,
  onComposerChange,
  onCancelGeneration,
  onSendMessage,
  attachments = [],
  onAddAttachments,
  onRemoveAttachment,
  agentModelSelection,
  onSelectAgentModel,
  mediaModelSelection,
  mediaReferenceImageInputs,
  onSelectMediaModel,
  onCancelMediaModelSelection,
  selectedChapterCount,
  onClearSelectedChapters,
  onOpenLibrarySource,
  agentParameterRequest,
  onSubmitAgentParameters,
  canLoadEarlierMessages = false,
  loadingEarlierMessages = false,
  onLoadEarlierMessages,
}: ChatPanelProps) {
  const close = onClose ?? onCollapse;
  const catalogItems = visibleLibraryCatalog(contextPreview?.catalog ?? []);
  const fileInputId = 'chat-attachment-input';
  const fileInputRef = useRef<HTMLInputElement>(null);
  /**
   * Model, provider and research-mode controls are configuration, not
   * conversation content. They live inside the composer as quiet chips so the
   * chat remains focused on messages.
   */
  const [modelControlsOpen, setModelControlsOpen] = useState(false);
  /**
   * Rename, archive and restore are infrequent, and they used to sit as three
   * always-visible icon buttons next to the conversation selector. They now live
   * behind one overflow trigger so the bar shows only what is used on every turn:
   * the conversation picker and "new conversation".
   */
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false);
  const conversationMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!conversationMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!conversationMenuRef.current?.contains(event.target as Node)) {
        setConversationMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [conversationMenuOpen]);
  const selectedProfile = llmProfiles.find((profile) => profile.id === selectedLlmProfileId);
  const selectedModel = llmModels.find(
    (model) => model.id === selectedLlmModelId && model.providerProfileId === selectedLlmProfileId,
  );
  const activeProfileName =
    selectedProfile?.name ?? (llmProfiles.length > 0 ? undefined : llmStatus?.provider);
  const activeModelName =
    selectedModel?.displayName ?? (llmProfiles.length > 0 ? undefined : llmStatus?.model);
  const researchModeLabel =
    researchMode === 'project_only'
      ? '仅项目资料'
      : researchMode === 'network_disabled'
        ? '禁止联网'
        : undefined;
  const isArchived = Boolean(conversation?.archivedAt);
  const generationLocked = generation?.status === 'prepared' || generation?.status === 'streaming';
  const messageListRef = useRef<HTMLDivElement>(null);
  /**
   * Paid media submissions never render here. `media-confirmation.tsx` owns that
   * review surface so every paid path shows the same frozen draft; this in-session
   * card is only for Agent tool confirmations.
   */
  const displayedConfirmation = confirmation ?? agentTask?.pendingConfirmation;
  const mergedAgentTasks = useMemo(() => {
    const byId = new Map((agentTasks ?? []).map((item) => [item.task.id, item]));
    if (agentTask) byId.set(agentTask.task.id, agentTask);
    return [...byId.values()];
  }, [agentTask, agentTasks]);
  const timelineByMessageId = useMemo(() => {
    const map = new Map<string, AgentTaskDetail>();
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      const task = agentTaskForAssistantMessage(
        message.id,
        messages,
        mergedAgentTasks,
        generation,
        agentTask,
      );
      if (task) map.set(message.id, task);
    }
    return map;
  }, [agentTask, generation, mergedAgentTasks, messages]);
  const unmatchedLiveTask =
    agentTask &&
    ![...timelineByMessageId.values()].some((item) => item.task.id === agentTask.task.id)
      ? agentTask
      : undefined;

  useEffect(() => {
    if (!generationLocked) return;
    const list = messageListRef.current;
    if (!list) return;
    list.scrollTop = list.scrollHeight;
  }, [generationLocked, generation?.assistantMessage.content, agentTask, liveAgentActions]);
  const protectedHandoff = displayedConfirmation?.protectedUi;
  const confirmationExpired = Boolean(
    displayedConfirmation &&
    'status' in displayedConfirmation &&
    displayedConfirmation.status === 'expired',
  );
  const confirmationIsActionable = Boolean(
    !confirmationExpired &&
    confirmation &&
    'confirmationToken' in confirmation &&
    onConfirmAgentAction,
  );
  return (
    <section className="chat-panel panel-border" aria-label="项目 AI 助手">
      {showHeading && (
        <div className="panel-heading">
          <span>项目 AI 助手</span>
          {showCloseAction && close && (
            <button className="icon-button subtle" type="button" title="关闭会话" onClick={close}>
              <PanelRightClose size={16} />
            </button>
          )}
        </div>
      )}
      <div className="conversation-bar">
        <select
          value={conversation?.id ?? ''}
          onChange={(event) => {
            const selected = conversations.find((item) => item.id === event.target.value);
            if (selected) onSelectConversation(selected);
          }}
          disabled={!scopeAvailable}
        >
          <option value="">{scopeAvailable ? '选择项目会话' : '请先打开项目'}</option>
          {conversations.map((item) => (
            <option key={item.id} value={item.id}>
              {item.archivedAt ? `${item.title}（已归档）` : item.title}
            </option>
          ))}
        </select>
        <label className="archive-toggle" title="显示已归档会话">
          <input
            type="checkbox"
            checked={showArchivedConversations}
            onChange={(event) => onShowArchivedConversationsChange?.(event.target.checked)}
            disabled={!scopeAvailable}
          />
          <span>归档</span>
        </label>
        <button
          className="icon-button"
          type="button"
          title="新建会话"
          onClick={onCreateConversation}
          disabled={!writable || !scopeAvailable}
        >
          <MessageSquarePlus size={16} />
        </button>
        <div className="conversation-menu" ref={conversationMenuRef}>
          <button
            className="icon-button subtle"
            type="button"
            title="更多会话操作"
            aria-label="更多会话操作"
            aria-haspopup="menu"
            aria-expanded={conversationMenuOpen}
            onClick={() => setConversationMenuOpen((open) => !open)}
          >
            <Ellipsis size={16} />
          </button>
          {conversationMenuOpen && (
            <div className="conversation-menu-popup" role="menu" aria-label="会话操作">
              <button
                type="button"
                role="menuitem"
                disabled={!writable || !conversation}
                onClick={() => {
                  const current = conversation;
                  setConversationMenuOpen(false);
                  if (!current) return;
                  const title = window.prompt('新会话名称', current.title);
                  if (title?.trim()) onRenameConversation?.(current.id, title.trim());
                }}
              >
                <Pencil size={14} />
                <span>重命名会话</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!writable || !conversation || Boolean(conversation.archivedAt)}
                onClick={() => {
                  const current = conversation;
                  setConversationMenuOpen(false);
                  if (current) onArchiveConversation?.(current.id);
                }}
              >
                <Archive size={14} />
                <span>归档会话</span>
              </button>
              <button
                type="button"
                role="menuitem"
                disabled={!writable || !conversation || !conversation.archivedAt}
                onClick={() => {
                  const current = conversation;
                  setConversationMenuOpen(false);
                  if (current) onRestoreConversation?.(current.id);
                }}
              >
                <RotateCcw size={14} />
                <span>恢复会话</span>
              </button>
              {canLoadMoreConversations && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setConversationMenuOpen(false);
                    onLoadMoreConversations?.();
                  }}
                >
                  <ChevronDown size={14} />
                  <span>加载更多会话</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="llm-context-bar composer-inline-controls">
        {legacyLlmConfigured && (
          <div className="legacy-llm-notice">
            <span>OPENAI_API_KEY 旧版入口仍可用，重新录入后可迁移到 Windows 安全存储。</span>
            <button type="button" onClick={onOpenProviderSettings}>
              迁移到供应商设置
            </button>
          </div>
        )}
        {contextPreview && (
          <details>
            <summary>资料目录 {catalogItems.length} 项</summary>
            <div className="context-source-list">
              {catalogItems.map((item) => (
                <span key={item.id} title={item.sourceType}>
                  {item.title} ·{' '}
                  {item.status === 'draft'
                    ? '草稿'
                    : item.status === 'published'
                      ? '已发布'
                      : item.status}
                </span>
              ))}
              {!contextPreview.catalog &&
                contextPreview.sources.map((source) => (
                  <span key={`${source.type}-${source.id}`} title={source.scopeType}>
                    {source.label}
                  </span>
                ))}
            </div>
          </details>
        )}
        {selectedChapterCount ? (
          <div className="chapter-context-chip" role="status">
            <BookOpen size={13} />
            <span>下次发送将带上 {selectedChapterCount} 个章节作为本集范围</span>
            {onClearSelectedChapters && (
              <button type="button" onClick={onClearSelectedChapters}>
                清除
              </button>
            )}
          </div>
        ) : null}
      </div>
      <div className="message-list" ref={messageListRef}>
        {canLoadEarlierMessages && (
          <div
            className="load-earlier-container"
            style={{ display: 'flex', justifyContent: 'center', padding: '8px' }}
          >
            <button
              className="button subtle"
              type="button"
              disabled={loadingEarlierMessages}
              onClick={onLoadEarlierMessages}
            >
              {loadingEarlierMessages ? '正在加载更早消息…' : '加载更早历史消息'}
            </button>
          </div>
        )}
        {messages.length === 0 ? (
          <div className="chat-empty">
            <Bot size={22} />
            <strong>项目 AI 助手</strong>
            <span>直接描述任务。需要时会检索项目里的草稿和已发布资料。</span>
          </div>
        ) : (
          messages.map((message) => (
            <Fragment key={message.id}>
              {(() => {
                const liveMessage =
                  generationLocked && generation?.assistantMessage.id === message.id;
                const timeline = timelineByMessageId.get(message.id);
                if (!timeline || liveMessage) return null;
                return (
                  <AgentToolTimeline
                    detail={timeline}
                    generationStatus={
                      generation?.assistantMessage.id === message.id ? generation.status : undefined
                    }
                    generationError={
                      generation?.assistantMessage.id === message.id ? generation.error : undefined
                    }
                    onOpenLibrarySource={onOpenLibrarySource}
                  />
                );
              })()}
              <article className={`message ${message.role}`}>
                <header>
                  <span>
                    {message.role === 'user'
                      ? '你'
                      : message.role === 'assistant'
                        ? '助手'
                        : message.role}
                  </span>
                  <button
                    className="icon-button subtle"
                    type="button"
                    title="复制"
                    onClick={() => void navigator.clipboard.writeText(message.content)}
                  >
                    <Copy size={12} />
                  </button>
                </header>
                <p>{message.content}</p>
                {message.role === 'assistant' &&
                  message.status === 'failed' &&
                  (generation?.assistantMessage.id !== message.id ||
                    generation.retryable !== false) &&
                  (llmStatus?.configured || llmProfiles.length > 0) && (
                    <footer>
                      {generation?.assistantMessage.id === message.id && statusMessage ? (
                        <small className="chat-status">{statusMessage}</small>
                      ) : null}
                      <button type="button" onClick={() => onRetryGeneration(message.id)}>
                        <RefreshCw size={11} />
                        重试
                      </button>
                    </footer>
                  )}
              </article>
              {(() => {
                const liveMessage =
                  generationLocked && generation?.assistantMessage.id === message.id;
                const timeline = timelineByMessageId.get(message.id);
                if (!liveMessage) return null;
                return (
                  <AgentToolTimeline
                    detail={timeline}
                    generationStatus={generation?.status}
                    generationError={generation?.error}
                    liveActions={liveAgentActions}
                    runningPlaceholder
                    onOpenLibrarySource={onOpenLibrarySource}
                  />
                );
              })()}
            </Fragment>
          ))
        )}
        {unmatchedLiveTask ? (
          <AgentToolTimeline
            detail={unmatchedLiveTask}
            generationStatus={generation?.status}
            generationError={generation?.error}
            liveActions={liveAgentActions}
            runningPlaceholder={generationLocked}
            onOpenLibrarySource={onOpenLibrarySource}
          />
        ) : generationLocked &&
          !messages.some((item) => item.id === generation?.assistantMessage.id) ? (
          <AgentToolTimeline
            generationStatus={generation?.status}
            liveActions={liveAgentActions}
            runningPlaceholder
          />
        ) : null}
      </div>
      {statusMessage && generation?.status !== 'failed' && (
        <small className="chat-status">{statusMessage}</small>
      )}
      {agentModelSelection && (
        <div
          className="agent-model-selection"
          role="dialog"
          aria-label={`选择${
            agentModelSelection.capability === 'image'
              ? '图片生成'
              : agentModelSelection.capability === 'video'
                ? '视频生成'
                : 'Agent'
          }模型`}
        >
          <strong>
            已识别为
            {agentModelSelection.capability === 'image'
              ? '图片'
              : agentModelSelection.capability === 'video'
                ? '视频'
                : 'Agent'}
            任务，请选择
            {agentModelSelection.capability === 'image'
              ? '图片生成'
              : agentModelSelection.capability === 'video'
                ? '视频生成'
                : 'Agent'}
            模型
          </strong>
          {agentModelSelection.reason === 'agent_tools_required' && (
            <small>当前会话模型不支持 Agent 工具调用，请明确选择一个支持工具的 Agent 模型。</small>
          )}
          {agentModelSelection.reason === 'model_unavailable' && (
            <small>当前会话模型已下架或不可用，请选择其他 Agent 模型。</small>
          )}
          {agentModelSelection.models.length === 0 && (
            <small>当前没有满足该能力的可用模型，请先在供应商设置中启用模型。</small>
          )}
          <div className="agent-model-options">
            {agentModelSelection.models.map((model) => (
              <button
                type="button"
                key={`${model.providerProfileId}:${model.modelId}`}
                onClick={() => onSelectAgentModel?.(model.providerProfileId, model.modelId)}
              >
                <span>{model.modelName}</span>
                <small>
                  {model.providerName}
                  {model.schemaReady === false ? ' · 需要补充参数 schema' : ''}
                </small>
              </button>
            ))}
          </div>
        </div>
      )}
      {mediaModelSelection && (
        <MediaModelSelectionCard
          request={mediaModelSelection}
          referenceImageInputs={mediaReferenceImageInputs}
          onSelect={onSelectMediaModel}
          onCancel={onCancelMediaModelSelection}
        />
      )}
      {agentParameterRequest && (
        <AgentParameterCard request={agentParameterRequest} onSubmit={onSubmitAgentParameters} />
      )}
      {agentTask?.plan && (
        <div className="agent-progress" role="status">
          <div className="agent-progress-heading">
            <span>
              短剧任务 · {agentTask.task.phase === 'waiting_review' ? '等待审核' : '执行中'}
            </span>
            <span>
              {
                agentTask.plan.deliverables.filter(
                  (item) => item.required && item.status === 'succeeded',
                ).length
              }
              /{agentTask.plan.deliverables.filter((item) => item.required).length}
            </span>
          </div>
          <div className="agent-progress-items">
            {agentTask.plan.deliverables
              .filter((item) => item.required)
              .map((item) => (
                <span key={item.kind} className={`agent-progress-item ${item.status}`}>
                  {item.status === 'succeeded' ? '✓' : item.status === 'in_progress' ? '…' : '○'}{' '}
                  {item.kind}
                </span>
              ))}
          </div>
          {agentTask.task.status === 'waiting_review' && onContinueAgentTask && (
            <button type="button" onClick={onContinueAgentTask}>
              继续完成缺失交付物
            </button>
          )}
        </div>
      )}
      {displayedConfirmation && (
        <div className="agent-confirmation" role="alert">
          <strong>需要确认：{displayedConfirmation.summary}</strong>
          <small>风险等级：{displayedConfirmation.riskLevel}</small>
          {displayedConfirmation.affectedEntities.length > 0 && (
            <ul className="agent-confirmation-entities" aria-label="受影响对象">
              {displayedConfirmation.affectedEntities.map((entity) => (
                <li key={`${entity.type}:${entity.id}`}>
                  {entity.label || entity.id} <small>({entity.type})</small>
                </li>
              ))}
            </ul>
          )}
          {displayedConfirmation.protectedUi && (
            <small>{displayedConfirmation.protectedUi.reason}</small>
          )}
          <small>确认有效期至 {new Date(displayedConfirmation.expiresAt).toLocaleString()}</small>
          {confirmationIsActionable ? (
            <div>
              <button
                type="button"
                className="button primary"
                onClick={() => {
                  if (protectedHandoff) {
                    onOpenProtectedUi?.(protectedHandoff);
                  }
                  onConfirmAgentAction?.(true);
                }}
              >
                {protectedHandoff ? '在受保护页面继续' : '批准'}
              </button>
              <button
                type="button"
                className="button secondary"
                onClick={() => onConfirmAgentAction?.(false)}
              >
                拒绝
              </button>
            </div>
          ) : (
            <>
              {protectedHandoff && onOpenProtectedUi && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() => onOpenProtectedUi(protectedHandoff)}
                >
                  打开受保护页面
                </button>
              )}
              <small>
                {confirmationExpired
                  ? '确认已过期，请重试任务以重新申请。'
                  : '应用已重新启动，原 Provider 会话不可恢复。请重试任务以重新申请确认。'}
              </small>
            </>
          )}
        </div>
      )}
      {agentTask?.pendingSchemaConfirmation && (
        <div className="agent-confirmation" role="alert">
          <strong>需要确认：Schema 修改提议</strong>
          <span>适配器：{agentTask.pendingSchemaConfirmation.adapterKey}</span>
          <ul>
            {agentTask.pendingSchemaConfirmation.diff.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
          {onConfirmSchemaProposal ? (
            <div>
              <button
                type="button"
                className="button primary"
                onClick={() =>
                  onConfirmSchemaProposal(
                    agentTask.pendingSchemaConfirmation!.adapterKey,
                    agentTask.pendingSchemaConfirmation!.version,
                  )
                }
              >
                确认 Schema 修改
              </button>
              {onRejectSchemaProposal && agentTask.pendingSchemaConfirmation.version > 1 && (
                <button
                  type="button"
                  className="button secondary"
                  onClick={() =>
                    onRejectSchemaProposal(
                      agentTask.pendingSchemaConfirmation!.adapterKey,
                      agentTask.pendingSchemaConfirmation!.version,
                    )
                  }
                >
                  拒绝并回滚上一版本
                </button>
              )}
            </div>
          ) : (
            <small>请在适配器设置中确认此 Schema 提议。</small>
          )}
        </div>
      )}
      {agentTask?.task.status === 'failed' && agentTask.task.retryable && (
        <div className="agent-recovery-notice" role="status">
          <span>上次 Agent 任务未完成；可以重试，或先在任务日志中恢复未完成产物。</span>
          {onOpenTaskLog && (
            <button type="button" className="button secondary" onClick={onOpenTaskLog}>
              查看任务日志
            </button>
          )}
        </div>
      )}
      {activeVideoTaskCount > 0 && (
        <div className="agent-recovery-notice" role="status">
          <span>项目后台正在处理 {activeVideoTaskCount} 个视频任务。</span>
          {onOpenTaskLog && (
            <button type="button" className="button secondary" onClick={onOpenTaskLog}>
              查看任务日志
            </button>
          )}
        </div>
      )}
      <div
        className="composer"
        onDragOver={(event) => {
          if (onAddAttachments) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!onAddAttachments || event.dataTransfer.files.length === 0) return;
          event.preventDefault();
          onAddAttachments(event.dataTransfer.files);
        }}
      >
        <button
          className="llm-model-summary"
          type="button"
          aria-expanded={modelControlsOpen}
          aria-controls="chat-model-controls"
          aria-label="模型与供应商设置"
          onClick={() => setModelControlsOpen((open) => !open)}
        >
          <SlidersHorizontal size={13} />
          <span className="llm-model-summary-name">
            {activeModelName
              ? activeModelName
              : llmProfiles.length > 0 || llmStatus?.configured
                ? '未选择模型'
                : '尚未配置 LLM 连接'}
          </span>
          {activeProfileName && <small>{activeProfileName}</small>}
          {researchModeLabel && (
            <small className="llm-model-summary-flag">{researchModeLabel}</small>
          )}
          {llmStatus?.configurationSource === 'environment' && (
            <small className="llm-model-summary-flag">旧版环境变量配置</small>
          )}
          {modelControlsOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </button>
        {modelControlsOpen && llmProfiles.length > 0 && (
          <div className="llm-provider-selectors" id="chat-model-controls">
            <select
              aria-label="LLM 供应商连接"
              value={selectedLlmProfileId}
              disabled={generationLocked}
              onChange={(event) => onLlmProfileChange(event.target.value)}
            >
              {llmProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
            <select
              aria-label="LLM 模型"
              value={selectedLlmModelId}
              disabled={generationLocked}
              onChange={(event) => onLlmModelChange(event.target.value)}
            >
              <option value="">{selectedLlmProfileId ? '请选择模型' : '请先选择供应商'}</option>
              {llmModels
                .filter((model) => model.providerProfileId === selectedLlmProfileId)
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
            </select>
            {onResearchModeChange && (
              <select
                aria-label="Agent 研究模式"
                value={researchMode}
                disabled={generationLocked}
                onChange={(event) => onResearchModeChange(event.target.value as AgentResearchMode)}
              >
                <option value="auto">研究：自动</option>
                <option value="project_only">研究：仅项目资料</option>
                <option value="network_disabled">研究：禁止联网</option>
              </select>
            )}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="chat-attachments" aria-label="已添加附件">
            {attachments.map((attachment) => (
              <span className="chat-attachment" key={attachment.id}>
                {attachment.kind === 'image' && attachment.dataUrl && (
                  <img src={attachment.dataUrl} alt="" className="chat-attachment-thumb" />
                )}
                {attachment.kind === 'video' && attachment.dataUrl && (
                  <video src={attachment.dataUrl} className="chat-attachment-thumb" muted />
                )}
                <span title={attachment.name}>{attachment.name}</span>
                {onRemoveAttachment && (
                  <button
                    type="button"
                    className="chat-attachment-remove"
                    aria-label={`移除 ${attachment.name}`}
                    onClick={() => onRemoveAttachment(attachment.id)}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
        <textarea
          aria-label="会话消息"
          placeholder={
            isArchived
              ? '当前会话已归档，处于只读状态'
              : conversation
                ? '描述你要完成的任务，需要时会检索项目里的草稿和已发布资料…'
                : '请先新建会话'
          }
          rows={3}
          value={composer}
          onChange={(event) => onComposerChange(event.target.value)}
          onPaste={(event) => {
            if (event.clipboardData.files.length > 0) {
              event.preventDefault();
              onAddAttachments?.(event.clipboardData.files);
            }
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (
              !isArchived &&
              generation?.status !== 'prepared' &&
              generation?.status !== 'streaming' &&
              (composer.trim() || attachments.length > 0) &&
              conversation &&
              writable
            ) {
              onSendMessage();
            }
          }}
          disabled={!conversation || !writable || isArchived}
        />
        {generation?.status === 'prepared' || generation?.status === 'streaming' ? (
          <button
            className="icon-button send-button"
            type="button"
            title="停止生成"
            onClick={onCancelGeneration}
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <>
            <input
              ref={fileInputRef}
              id={fileInputId}
              className="visually-hidden"
              aria-hidden="true"
              tabIndex={-1}
              type="file"
              multiple
              accept="*/*"
              onChange={(event) => {
                if (event.target.files?.length) onAddAttachments?.(event.target.files);
                event.currentTarget.value = '';
              }}
              disabled={!conversation || !writable || isArchived}
            />
            <button
              type="button"
              className="icon-button subtle attachment-button"
              title="添加图片、视频或文件"
              aria-label="添加图片、视频或文件"
              onClick={() => fileInputRef.current?.click()}
              disabled={!conversation || !writable || isArchived}
            >
              <Paperclip size={16} />
            </button>
            <button
              className="icon-button send-button"
              type="button"
              title="发送消息"
              onClick={onSendMessage}
              disabled={
                (!composer.trim() && attachments.length === 0) || !conversation || isArchived
              }
            >
              <ChevronRight size={18} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function toolNamesFromStartedSummary(summary: string): string[] {
  const match = summary.match(/[：:](.+)$/);
  const raw = (match?.[1] ?? summary).trim();
  if (!raw) return [];
  return raw
    .split(/[、,，]/)
    .map((name) => name.trim())
    .filter(Boolean);
}

function agentToolActionLabel(name: string): string {
  return AGENT_TOOL_ACTION_LABELS[name] ?? `调用 ${name}`;
}

function policyRejectionDetail(summary: string): string {
  if (/AGENT_TOOL_AUTHORIZATION_REPLAYED/.test(summary)) return '同一轮重复调用，授权已失效';
  if (/AGENT_TOOL_AUTHORIZATION_EXPIRED/.test(summary)) return '工具授权已过期';
  if (/LIBRARY_HANDLE_INVALID/.test(summary)) return '资料句柄无效或已过期';
  const code = summary.match(/\(([A-Z0-9_]+)\)/);
  return code?.[1] ? `请求被拒绝（${code[1]}）` : '工具请求被拒绝';
}

function readableAgentTaskError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  if (error.includes('AGENT_DOCUMENT_NOT_WRITTEN')) {
    return '助手尚未将文档保存到项目，本次任务未完成。请重试保存。';
  }
  const turnLimit = error.match(/Pi runtime exceeded the (\d+)-turn limit/i);
  if (turnLimit) return `助手连续调用工具超过 ${turnLimit[1]} 轮，已停止。`;
  if (/Provider generation failed/i.test(error) || /Provider generation was failed/i.test(error)) {
    return '模型生成失败，助手任务已中止。';
  }
  if (
    /Provider generation cancelled/i.test(error) ||
    /Provider generation was cancelled/i.test(error)
  ) {
    return '本次生成已取消。';
  }
  return error;
}

type AgentActionRow = {
  id: string;
  title: string;
  toolName?: string;
  detail?: string;
  status: 'running' | 'ok' | 'warn' | 'error';
};

const AGENT_TOOL_ACTION_LABELS: Record<string, string> = {
  'library.search': '检索项目资料',
  'library.read': '阅读资料正文',
  'document.create_draft': '创建文档草稿',
  'document.update_draft': '更新文档草稿',
  'document.list': '列出项目文档',
  'document.read': '阅读项目文档',
  'document.archive': '归档文档',
  'document.restore': '恢复文档',
  'document.publish': '发布文档',
  'conversation.search': '检索会话记录',
  'conversation.create': '创建会话',
  'conversation.rename': '重命名会话',
  'conversation.archive': '归档会话',
  'conversation.restore': '恢复会话',
  'asset.search': '检索素材',
  'asset.get': '查看素材',
  'project.get_context': '读取项目上下文',
  'project.integrity.check': '检查项目完整性',
  'research.search': '检索外部资料',
  'research.fetch': '抓取外部页面',
  'media.image.prepare': '准备图片生成',
  'media.video.prepare': '准备视频生成',
  'media.generation.submit': '提交生成任务',
  'media.task.get': '查询生成任务',
  'media.task.cancel': '取消生成任务',
  'task.plan.submit': '提交任务计划',
  'task.package.complete': '完成任务包',
  'settings.get': '读取设置',
  'adapter.schema.get': '查看适配器结构',
};

function agentTaskForAssistantMessage(
  messageId: string,
  messages: ChatMessageInfo[],
  tasks: AgentTaskDetail[],
  generation: LlmGenerationInfo | undefined,
  liveTask: AgentTaskDetail | undefined,
): AgentTaskDetail | undefined {
  if (generation?.assistantMessage.id === messageId && liveTask) return liveTask;
  const index = messages.findIndex((item) => item.id === messageId);
  if (index < 0) return undefined;
  const user = [...messages.slice(0, index)].reverse().find((item) => item.role === 'user');
  if (!user) return undefined;
  return tasks
    .filter((item) => item.task.userMessageId === user.id)
    .sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt))[0];
}

function agentActionRows(detail: AgentTaskDetail, generationFailed: boolean): AgentActionRow[] {
  const rows: AgentActionRow[] = [];
  const pending: AgentActionRow[] = [];
  const flushPending = (status: AgentActionRow['status'], detailText?: string) => {
    while (pending.length > 0) {
      const row = pending.shift()!;
      row.status = status;
      if (detailText) row.detail = detailText;
      rows.push(row);
    }
  };

  for (const event of detail.events) {
    if (event.eventType === 'agent.tool.started') {
      flushPending('ok');
      for (const name of toolNamesFromStartedSummary(event.summary)) {
        pending.push({
          id: `${event.id}:${name}`,
          title: agentToolActionLabel(name),
          toolName: name,
          status: 'running',
        });
      }
      continue;
    }
    if (event.eventType === 'agent.policy.rejected') {
      const detailText = policyRejectionDetail(event.summary);
      if (pending.length > 0) flushPending('warn', detailText);
      else {
        rows.push({
          id: event.id,
          title: '工具请求被拒绝',
          detail: detailText,
          status: 'warn',
        });
      }
      continue;
    }
    if (
      event.eventType === 'agent.library.completed' ||
      event.eventType === 'agent.tool.succeeded' ||
      event.eventType === 'agent.research.completed'
    ) {
      flushPending('ok');
      continue;
    }
    if (event.eventType === 'document.draft.created') {
      rows.push({ id: event.id, title: '已写入文档草稿', status: 'ok' });
      continue;
    }
    if (
      event.eventType === 'document.draft.updated' ||
      event.eventType === 'document.draft.revision_created'
    ) {
      rows.push({ id: event.id, title: '已更新文档草稿', status: 'ok' });
      continue;
    }
    if (event.eventType === 'document.published') {
      rows.push({ id: event.id, title: '已发布文档', status: 'ok' });
      continue;
    }
    if (event.eventType === 'agent.media.selection.requested') {
      rows.push({ id: event.id, title: '等待选择生成模型', status: 'running' });
      continue;
    }
    if (event.eventType === 'agent.media.selection.resolved') {
      rows.push({ id: event.id, title: '已选定生成模型', status: 'ok' });
      continue;
    }
    if (event.eventType === 'agent.task.interrupted') {
      flushPending(generationFailed ? 'error' : 'warn');
      rows.push({
        id: event.id,
        title: '任务已中止',
        detail: readableAgentTaskError(event.summary),
        status: 'error',
      });
    }
  }

  const runningTask = detail.task.status === 'running' || detail.task.status === 'queued';
  if (runningTask && !generationFailed) rows.push(...pending);
  else flushPending(generationFailed || detail.task.status === 'failed' ? 'error' : 'ok');
  return rows;
}

function mergeLiveAgentActions(
  rows: AgentActionRow[],
  liveActions: ConversationRuntimeLiveAction[] | undefined,
  running: boolean,
): AgentActionRow[] {
  const merged = [...rows];
  for (const live of liveActions ?? []) {
    if (merged.some((row) => row.toolName === live.toolName || row.id === `live:${live.id}`)) {
      continue;
    }
    merged.push({
      id: `live:${live.id}`,
      title: agentToolActionLabel(live.toolName),
      toolName: live.toolName,
      status: live.status === 'failed' ? 'error' : live.status === 'succeeded' ? 'ok' : 'running',
    });
  }
  if (running && merged.length === 0) {
    merged.push({
      id: 'live:thinking',
      title: '正在思考',
      status: 'running',
    });
  }
  return merged;
}

function AgentToolTimeline({
  detail,
  generationStatus,
  generationError,
  liveActions,
  runningPlaceholder = false,
  onOpenLibrarySource,
}: {
  detail?: AgentTaskDetail;
  generationStatus?: LlmGenerationInfo['status'];
  generationError?: string;
  liveActions?: ConversationRuntimeLiveAction[];
  runningPlaceholder?: boolean;
  onOpenLibrarySource?: (source: AgentLibrarySourceInfo) => void;
}) {
  const generationFailed = generationStatus === 'failed' || generationStatus === 'cancelled';
  const running =
    runningPlaceholder ||
    (!generationFailed &&
      (generationStatus === 'prepared' ||
        generationStatus === 'streaming' ||
        detail?.task.status === 'running' ||
        detail?.task.status === 'queued'));
  const actions = mergeLiveAgentActions(
    detail ? agentActionRows(detail, generationFailed) : [],
    liveActions,
    running && !generationFailed,
  );
  const errorMessage =
    readableAgentTaskError(generationError) ?? readableAgentTaskError(detail?.task.errorMessage);
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? true;

  useEffect(() => {
    setExpandedOverride(null);
  }, [detail?.task.id]);

  if (actions.length === 0 && (detail?.librarySources?.length ?? 0) === 0 && !errorMessage) {
    return null;
  }

  return (
    <section
      className="agent-tool-timeline"
      role="status"
      aria-live="polite"
      data-state={running ? 'running' : 'settled'}
    >
      {actions.length > 0 || (detail?.librarySources?.length ?? 0) > 0 ? (
        <>
          <button
            className="agent-tool-timeline-toggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpandedOverride(!expanded)}
          >
            <Terminal size={12} />
            <span>{running ? '正在调用工具' : '调用了工具'}</span>
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          {expanded ? (
            <ul className="agent-tool-timeline-calls">
              {actions.map((action) => (
                <li key={action.id} data-status={action.status}>
                  {action.status === 'warn' || action.status === 'error' ? (
                    <AlertTriangle size={12} />
                  ) : (
                    <Terminal size={12} />
                  )}
                  <span>
                    <strong>{action.title}</strong>
                    {action.toolName ? (
                      <>
                        {' '}
                        <code>{action.toolName}</code>
                      </>
                    ) : null}
                    {action.detail ? <small>{action.detail}</small> : null}
                  </span>
                </li>
              ))}
              {(detail?.librarySources ?? []).map((source) => (
                <li key={`${source.citationLabel}-${source.sourceId}`}>
                  <BookOpen size={12} />
                  {onOpenLibrarySource ? (
                    <button type="button" onClick={() => onOpenLibrarySource(source)}>
                      {source.citationLabel} {source.title} ·{' '}
                      {source.status === 'draft'
                        ? '草稿'
                        : source.status === 'published'
                          ? '已发布'
                          : source.status}
                    </button>
                  ) : (
                    <span>
                      {source.citationLabel} {source.title} · {source.status}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : null}
      {errorMessage ? <p className="agent-tool-timeline-error">{errorMessage}</p> : null}
    </section>
  );
}

function MediaModelSelectionCard({
  request,
  referenceImageInputs,
  onSelect,
  onCancel,
}: {
  request: MediaModelSelectionRequest;
  referenceImageInputs?: string[];
  onSelect?: (selection: MediaModelSelectionDecision) => void;
  onCancel?: () => void;
}) {
  const [candidateKey, setCandidateKey] = useState('');
  const candidate = request.candidates.find(
    (item) => `${item.providerProfileId}:${item.modelId}` === candidateKey,
  );

  useEffect(() => {
    setCandidateKey('');
  }, [request.selectionToken]);

  return (
    <div
      className="agent-model-selection media-model-selection"
      role="dialog"
      aria-label={`选择${request.kind === 'image' ? '图片' : '视频'}生成模型`}
    >
      <div className="media-model-selection-heading">
        <div>
          <strong>选择{request.kind === 'image' ? '图片' : '视频'}生成模型</strong>
          <small>此选择仅用于当前媒体草稿，不会更改会话 Agent 模型。</small>
        </div>
        {onCancel && (
          <button className="button subtle" type="button" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
      {request.candidates.length === 0 ? (
        <small>当前没有兼容且已就绪的媒体模型，请检查供应商和模型配置。</small>
      ) : !candidate ? (
        <div className="agent-model-options">
          {request.candidates.map((item) => (
            <button
              type="button"
              key={`${item.providerProfileId}:${item.modelId}`}
              onClick={() => setCandidateKey(`${item.providerProfileId}:${item.modelId}`)}
            >
              <span>{item.modelName}</span>
              <small>
                {item.providerName} · {formatMediaProviderRegion(item)}
              </small>
              <small>{item.costNotice.summary}</small>
            </button>
          ))}
        </div>
      ) : (
        <>
          <button className="media-model-change" type="button" onClick={() => setCandidateKey('')}>
            已选择 {candidate.providerName} · {candidate.modelName}，重新选择
          </button>
          <AgentParameterCard
            request={{
              prompt: request.prompt,
              capability: request.kind,
              providerProfileId: candidate.providerProfileId,
              modelId: candidate.modelId,
              modelName: candidate.modelName,
              adapters: candidate.adapters,
              affectsCost: candidate.costNotice.required,
              referenceImageInputs,
              proposedParameters: request.proposedParameters,
            }}
            onSubmit={(adapterKey, parameters) =>
              onSelect?.({
                providerProfileId: candidate.providerProfileId,
                modelId: candidate.modelId,
                adapterKey,
                parameters,
              })
            }
          />
        </>
      )}
    </div>
  );
}

function formatMediaProviderRegion(candidate: MediaModelCandidate): string {
  if (candidate.providerRegion === 'cn') return '中国区';
  if (candidate.providerRegion === 'global') return '全球区';
  return candidate.providerRegion;
}

function AgentParameterCard({
  request,
  onSubmit,
}: {
  request: NonNullable<ChatPanelProps['agentParameterRequest']>;
  onSubmit?: (adapterKey: string, parameters: AdapterParameters) => void;
}) {
  const firstAdapter = request.adapters[0];
  const [adapterKey, setAdapterKey] = useState(firstAdapter?.key ?? '');
  const adapter = request.adapters.find((item) => item.key === adapterKey) ?? firstAdapter;
  const initialValues = useMemo<AdapterParameters>(() => {
    if (!adapter) return {};
    const values: AdapterParameters = {};
    for (const [key, property] of Object.entries(adapter.parameterSchema.properties)) {
      if (property.default !== undefined) values[key] = property.default;
      else if (key === 'prompt' && property.type === 'string') values[key] = request.prompt;
    }
    for (const [key, value] of Object.entries(request.proposedParameters ?? {})) {
      if (Object.prototype.hasOwnProperty.call(adapter.parameterSchema.properties, key)) {
        values[key] = value;
      }
    }
    if (
      request.referenceImageInputs &&
      request.referenceImageInputs.length > 0 &&
      Object.prototype.hasOwnProperty.call(adapter.parameterSchema.properties, 'images')
    ) {
      values.images = request.referenceImageInputs;
    }
    return values;
  }, [adapter, request.proposedParameters, request.referenceImageInputs, request.prompt]);
  const [parameters, setParameters] = useState<AdapterParameters>(initialValues);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!adapter) return;
    setAdapterKey(adapter.key);
    setParameters(initialValues);
    setError('');
  }, [adapter?.key, initialValues]);

  if (!adapter) {
    return (
      <div className="agent-parameter-card" role="alert">
        <strong>当前模型还没有可用的参数 schema</strong>
        <small>请在会话中告诉 Agent 补充或更新该模型的参数配置。</small>
      </div>
    );
  }

  const fields = Object.entries(adapter.parameterSchema.properties).sort(([a], [b]) =>
    a.localeCompare(b),
  );
  const update = (key: string, value: AdapterParameters[string] | undefined) => {
    setParameters((current) => {
      const next = { ...current };
      if (value === undefined || value === '') delete next[key];
      else next[key] = value;
      return next;
    });
  };
  const submit = () => {
    const missing = adapter.parameterSchema.required.filter((key) => {
      const value = parameters[key];
      return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    });
    if (missing.length > 0) {
      setError(`请填写必填参数：${missing.join('、')}`);
      return;
    }
    setError('');
    onSubmit?.(adapter.key, parameters);
  };

  return (
    <div className="agent-parameter-card" role="dialog" aria-label="补充生成参数">
      <strong>{request.capability === 'image' ? '图片' : '视频'}参数</strong>
      <small>{request.modelName} · 参数会先校验，通过后才会创建草稿任务。</small>
      {request.affectsCost && (
        <small className="agent-cost-warning">此操作可能产生费用，当前暂不计算具体金额。</small>
      )}
      {request.adapters.length > 1 && (
        <label className="agent-parameter-adapter">
          <span>生成方式</span>
          <select
            value={adapter.key}
            onChange={(event) => {
              setAdapterKey(event.target.value);
              setParameters({});
            }}
          >
            {request.adapters.map((item) => (
              <option key={item.key} value={item.key}>
                {item.capabilityLabel} · {item.apiVersion}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="agent-parameter-fields">
        {fields.map(([key, property]) => (
          <AgentParameterField
            key={key}
            name={key}
            property={property}
            required={adapter.parameterSchema.required.includes(key)}
            value={parameters[key]}
            onChange={(value) => update(key, value)}
          />
        ))}
      </div>
      {error && <small className="agent-parameter-error">{error}</small>}
      <button className="button primary" type="button" onClick={submit}>
        提交生成
      </button>
    </div>
  );
}

function AgentParameterField({
  name,
  property,
  required,
  value,
  onChange,
}: {
  name: string;
  property: AdapterParameterProperty;
  required: boolean;
  value?: AdapterParameters[string];
  onChange: (value: AdapterParameters[string] | undefined) => void;
}) {
  const id = `agent-parameter-${name}`;
  const label = `${property.title || name}${required ? ' *' : ''}`;
  const metadata = (
    <small className="agent-parameter-meta">
      {property.affectsCost ? '可能产生费用 · ' : ''}
      {property.overwritesExisting ? '可能覆盖已有内容 · ' : ''}
      {property.mutuallyExclusiveWith?.length
        ? `与 ${property.mutuallyExclusiveWith.join('、')} 互斥 · `
        : ''}
      {property.requires?.length ? `依赖 ${property.requires.join('、')} · ` : ''}
      {property.description ?? ''}
    </small>
  );
  if (property.type === 'boolean') {
    return (
      <label className="agent-parameter-toggle">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        {label}
        {metadata}
      </label>
    );
  }
  if (property.enum && property.enum.length > 0) {
    return (
      <label className="parameter-field" htmlFor={id}>
        <span>{label}</span>
        <select
          id={id}
          value={value === undefined ? '' : String(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">请选择</option>
          {property.enum.map((item) => (
            <option key={String(item)} value={String(item)}>
              {String(item)}
            </option>
          ))}
        </select>
        {metadata}
      </label>
    );
  }
  if (property.type === 'array') {
    const list = Array.isArray(value) ? value.join('\n') : '';
    return (
      <label className="parameter-field" htmlFor={id}>
        <span>{label}</span>
        <textarea
          id={id}
          value={list}
          placeholder="每行一个值"
          onChange={(e) =>
            onChange(
              e.target.value
                .split(/\r?\n/u)
                .map((item) => item.trim())
                .filter(Boolean),
            )
          }
        />
        {metadata}
      </label>
    );
  }
  const numeric = property.type === 'integer';
  return (
    <label className="parameter-field" htmlFor={id}>
      <span>{label}</span>
      <input
        id={id}
        type={numeric ? 'number' : 'text'}
        value={value === undefined ? '' : String(value)}
        min={property.minimum}
        max={property.maximum}
        onChange={(e) =>
          onChange(
            numeric
              ? e.target.value === ''
                ? undefined
                : Number(e.target.value)
              : e.target.value || undefined,
          )
        }
      />
      {metadata}
    </label>
  );
}
