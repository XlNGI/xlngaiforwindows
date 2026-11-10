import { PromptReferenceEditor } from './PromptReferenceEditor';
import { ImageListParameterField } from './ImageListParameterField';
import { readAssetDrop, useAssetDrop } from './assets/use-asset-drop';
import { StructuredAssetDrop } from './assets/StructuredAssetDrop';
import { imageAssetId } from './ParameterImagePreview';
import { MediaReviewQueue } from './MediaReviewQueue';
import { AgentQuestionForm } from './AgentQuestionForm';
import { AgentDeliveryFeedback } from './AgentDeliveryFeedback';
import {
  conversationProcessGroups,
  conversationTimeline,
  newerAgentTaskDetail,
} from './conversation-timeline';
import {
  canonicalPromptParameters,
  promptReferences,
  updatePromptParameter,
  type PromptReference,
} from './prompt-references';
import { seedProductionInputs, productionImagesFromParameters } from '@ai-video/contracts';
import { parameterScalarText, StructuredParameterField } from './StructuredParameterField';
import {
  AlertTriangle,
  Archive,
  Bot,
  BookOpen,
  Check,
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
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AssistantReply } from './AssistantReply';
import { ComposerTextarea } from './ComposerTextarea';
import {
  SCENE_PROMPT_CONSTRAINT_TEMPLATE,
  splitComposedConversationPrompt,
} from './conversation-prompt-template';
import type {
  AgentResearchMode,
  AgentInputSubmitResult,
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
  AgentTaskReviewTargetInfo,
  AgentLibrarySourceInfo,
  ConversationRuntimeLiveAction,
  MediaModelCandidate,
  MediaModelSelectionDecision,
  MediaModelSelectionRequest,
  UnifiedAgentModelSelectionRequest,
  LibraryCatalogItem,
  MediaReviewSummary,
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
  onAnswerQuestions?: (result: AgentInputSubmitResult) => Promise<void>;
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
  /** Editable instructions appended to every request in this conversation. */
  promptTemplate?: string;
  onPromptTemplateChange?: (value: string) => void;
  onSavePromptTemplate?: () => void;
  promptTemplateBusy?: boolean;
  promptTemplateLoading?: boolean;
  promptTemplateError?: string;
  promptTemplateDirty?: boolean;
  onReloadPromptTemplate?: () => void;
  onCancelGeneration: () => void;
  batchRunning?: boolean;
  allowConcurrentTasks?: boolean;
  onSendMessage: (
    execution?: 'ordered' | 'parallel' | 'supplement',
    targetGenerationId?: string,
  ) => void;
  attachments?: ChatAttachment[];
  attachmentsPending?: boolean;
  onAddAttachments?: (files: FileList | File[]) => void;
  onAddAssetAttachments?: (serialized: string) => void;
  onRemoveAttachment?: (id: string) => void;
  agentModelSelection?: UnifiedAgentModelSelectionRequest;
  onSelectAgentModel?: (providerProfileId: string, modelId: string) => void;
  mediaModelSelection?: MediaModelSelectionRequest;
  mediaReferenceImageInputs?: string[];
  onSelectMediaModel?: (selection: MediaModelSelectionDecision) => void;
  onCancelMediaModelSelection?: () => void;
  canLoadEarlierMessages?: boolean;
  loadingEarlierMessages?: boolean;
  onLoadEarlierMessages?: () => void;
  onOpenLibrarySource?: (source: AgentLibrarySourceInfo) => void;
  onOpenReviewTarget?: (projectId: string, target: AgentTaskReviewTargetInfo) => void;
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
  allowConcurrentTasks = false,
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
  onAnswerQuestions,
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
  promptTemplate = '',
  onPromptTemplateChange,
  onSavePromptTemplate,
  promptTemplateBusy = false,
  promptTemplateLoading = false,
  promptTemplateError = '',
  promptTemplateDirty = false,
  onReloadPromptTemplate,
  onCancelGeneration,
  batchRunning = false,
  onSendMessage,
  attachments = [],
  attachmentsPending = false,
  onAddAttachments,
  onAddAssetAttachments,
  onRemoveAttachment,
  agentModelSelection,
  onSelectAgentModel,
  mediaModelSelection,
  mediaReferenceImageInputs,
  onSelectMediaModel,
  onCancelMediaModelSelection,
  onOpenLibrarySource,
  onOpenReviewTarget,
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
  const panelRef = useRef<HTMLElement>(null);
  /**
   * Model, provider and research-mode controls are configuration, not
   * conversation content. They live inside the composer as quiet chips so the
   * chat remains focused on messages.
   */
  const [modelControlsOpen, setModelControlsOpen] = useState(false);
  const [expandedProcesses, setExpandedProcesses] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    setExpandedProcesses(new Set());
  }, [conversation?.projectId, conversation?.id]);
  /**
   * Conversation management and archive filters are infrequent. Keep them in
   * the overflow menu so the bar stays focused on picking and creating chats.
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
  const canAttach = Boolean(conversation && writable && scopeAvailable && !isArchived);
  const assetDrop = useAssetDrop<HTMLDivElement>({
    enabled: canAttach && Boolean(onAddAssetAttachments),
    onDrop: (raw) => onAddAssetAttachments?.(raw),
  });
  const generationLocked =
    batchRunning || generation?.status === 'prepared' || generation?.status === 'streaming';
  const conversationRunning =
    generationLocked ||
    [agentTask, ...(agentTasks ?? [])].some(
      (detail) =>
        detail?.task.conversationId === conversation?.id &&
        (detail?.task.status === 'queued' || detail?.task.status === 'running') &&
        !(
          generation &&
          generation.userMessage.id === detail.task.userMessageId &&
          !['prepared', 'streaming'].includes(generation.status)
        ),
    );
  const conversationBusy = !allowConcurrentTasks && conversationRunning;
  const showStatusMessage =
    statusMessage &&
    generation?.status !== 'failed' &&
    !/^(生成完成|生成已完成)$/.test(statusMessage);
  const send = () => {
    if (!attachmentsPending) onSendMessage();
  };
  const messageListRef = useRef<HTMLDivElement>(null);
  const followLatestMessageRef = useRef(true);
  /**
   * Paid media submissions never render here. `media-confirmation.tsx` owns that
   * review surface so every paid path shows the same frozen draft; this in-session
   * card is only for Agent tool confirmations.
   */
  const displayedConfirmation = confirmation ?? agentTask?.pendingConfirmation;
  const mergedAgentTasks = useMemo(() => {
    const byId = new Map((agentTasks ?? []).map((item) => [item.task.id, item]));
    if (agentTask)
      byId.set(agentTask.task.id, newerAgentTaskDetail(byId.get(agentTask.task.id), agentTask));
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
    const list = messageListRef.current;
    if (!list) return;
    followLatestMessageRef.current = true;
    const scrollToLatest = () => {
      if (followLatestMessageRef.current) list.scrollTop = list.scrollHeight;
    };
    scrollToLatest();
    // Replies render buffered chunks independently of the parent generation snapshot.
    // Keep all content updates behind the same user-controlled follow preference.
    const contentObserver = new MutationObserver(scrollToLatest);
    contentObserver.observe(list, { childList: true, characterData: true, subtree: true });
    const sizeObserver =
      typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(scrollToLatest);
    sizeObserver?.observe(list);
    return () => {
      contentObserver.disconnect();
      sizeObserver?.disconnect();
    };
  }, [conversation?.id]);
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
  const renderMessageItems = (
    forms: MediaReviewSummary[] = [],
    renderForm?: (form: MediaReviewSummary) => ReactNode,
    queueError?: ReactNode,
  ) => {
    const timeline = conversationTimeline(
      messages,
      timelineByMessageId,
      generationLocked ? generation?.assistantMessage.id : undefined,
      forms,
    );
    const processByItemId = new Map(
      conversationProcessGroups(timeline, timelineByMessageId).flatMap((group) =>
        group.itemIds.map((id) => [id, group] as const),
      ),
    );
    const lastReplyByMessage = new Map(
      timeline.filter((item) => item.kind === 'message').map((item) => [item.message.id, item.id]),
    );
    return (
      <>
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
        {messages.length === 0 && forms.length === 0 ? (
          <div className="chat-empty">
            <Bot size={22} />
            <strong>项目 AI 助手</strong>
            <span>直接描述任务。需要时会检索项目里的草稿和已发布资料。</span>
          </div>
        ) : null}
        {timeline.map((item) => {
          const renderItem = () => {
            if (item.kind === 'question')
              return (
                <AgentQuestionForm
                  key={`${conversation?.projectId}:${item.form.id}`}
                  form={item.form}
                  projectId={conversation!.projectId}
                  writable={writable}
                  onContinue={onAnswerQuestions}
                />
              );
            if (item.kind === 'form')
              return <Fragment key={item.id}>{renderForm?.(item.form)}</Fragment>;
            if (item.kind === 'tools')
              return (
                <AgentToolTimeline
                  key={item.id}
                  detail={item.detail}
                  stage={item.staged}
                  generationStatus={
                    !item.tail
                      ? 'complete'
                      : generation?.assistantMessage.id === item.messageId
                        ? generation.status
                        : undefined
                  }
                  generationError={
                    item.tail && generation?.assistantMessage.id === item.messageId
                      ? generation.error
                      : undefined
                  }
                  liveActions={
                    item.live
                      ? item.staged
                        ? liveAgentActions?.filter((action) => action.status === 'running')
                        : liveAgentActions
                      : undefined
                  }
                  runningPlaceholder={item.live}
                  onOpenLibrarySource={onOpenLibrarySource}
                  onOpenReviewTarget={onOpenReviewTarget}
                />
              );
            const message = item.message;
            const resultDetail = timelineByMessageId.get(message.id);
            const resultLabel =
              message.role === 'assistant' && lastReplyByMessage.get(message.id) === item.id
                ? (taskResultLabel(resultDetail) ??
                  (generation?.assistantMessage.id === message.id &&
                  generation.status === 'complete'
                    ? '回复结束'
                    : undefined))
                : undefined;
            const standaloneError =
              message.role === 'assistant' &&
              message.status === 'failed' &&
              !timelineByMessageId.has(message.id) &&
              ((generation?.assistantMessage.id === message.id &&
                item.content.trim() === generation.error?.trim()) ||
                /^Provider HTTP \d{3}\b[^\r\n]*$/i.test(item.content.trim()))
                ? item.content
                : undefined;
            const composedPrompt =
              message.role === 'user' ? splitComposedConversationPrompt(item.content) : undefined;
            return (
              <article
                key={item.id}
                className={`message ${message.role}${item.staged ? ' assistant-phase' : ''}`}
              >
                <header>
                  {!item.staged && (
                    <span>
                      {message.role === 'user'
                        ? '你'
                        : message.role === 'assistant'
                          ? '助手'
                          : message.role}
                    </span>
                  )}
                  <button
                    className="icon-button subtle"
                    type="button"
                    title="复制"
                    onClick={() => void navigator.clipboard.writeText(item.content)}
                  >
                    <Copy size={12} />
                  </button>
                </header>
                {standaloneError ? (
                  <AgentTaskError error={standaloneError} />
                ) : message.role === 'assistant' ? (
                  <AssistantReply content={item.content} streaming={item.streaming} />
                ) : composedPrompt ? (
                  <>
                    <p className="message-user-input">{composedPrompt.request}</p>
                    <details className="message-session-constraints">
                      <summary>约束 · {composedPrompt.constraints.length} 字</summary>
                      <p>{composedPrompt.constraints}</p>
                    </details>
                  </>
                ) : (
                  <p>{item.content}</p>
                )}
                {resultLabel && (
                  <footer className="chat-task-result" role="status">
                    <small>{resultLabel}</small>
                    {resultDetail?.task.completionState === 'partial' &&
                      resultDetail.task.errorMessage && (
                        <small>{resultDetail.task.errorMessage}</small>
                      )}
                  </footer>
                )}
                {resultLabel && resultDetail && (
                  <AgentDeliveryFeedback
                    key={resultDetail.task.id}
                    detail={resultDetail}
                    onOpenTarget={onOpenReviewTarget}
                  />
                )}
                {message.role === 'assistant' &&
                  message.status === 'failed' &&
                  !timelineByMessageId.has(message.id) &&
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
            );
          };
          const process = processByItemId.get(item.id);
          if (!process) return renderItem();
          const expanded = expandedProcesses.has(process.messageId);
          return (
            <Fragment key={item.id}>
              {process.itemIds[0] === item.id && (
                <div className="conversation-process-heading">
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={process.itemIds
                      .map((id) => `conversation-process-${id}`)
                      .join(' ')}
                    title={expanded ? '收起执行过程' : '展开执行过程'}
                    onClick={() =>
                      setExpandedProcesses((current) => {
                        const next = new Set(current);
                        if (next.has(process.messageId)) next.delete(process.messageId);
                        else next.add(process.messageId);
                        return next;
                      })
                    }
                  >
                    <span>{process.label}</span>
                    {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  </button>
                </div>
              )}
              <div
                id={`conversation-process-${item.id}`}
                className="conversation-process-item"
                hidden={!expanded}
              >
                {renderItem()}
              </div>
            </Fragment>
          );
        })}
        {queueError}
        {generationLocked &&
          !unmatchedLiveTask &&
          messages.some((message) => message.id === generation?.assistantMessage.id) &&
          !timelineByMessageId.has(generation?.assistantMessage.id ?? '') && (
            <AgentToolTimeline
              generationStatus={generation?.status}
              liveActions={liveAgentActions}
              runningPlaceholder
            />
          )}
        {unmatchedLiveTask ? (
          <AgentToolTimeline
            detail={unmatchedLiveTask}
            generationStatus={generation?.status}
            generationError={generation?.error}
            liveActions={liveAgentActions}
            runningPlaceholder={generationLocked}
            onOpenLibrarySource={onOpenLibrarySource}
            onOpenReviewTarget={onOpenReviewTarget}
          />
        ) : generationLocked &&
          !messages.some((item) => item.id === generation?.assistantMessage.id) ? (
          <AgentToolTimeline
            generationStatus={generation?.status}
            liveActions={liveAgentActions}
            runningPlaceholder
          />
        ) : null}
      </>
    );
  };
  return (
    <section
      ref={panelRef}
      className="chat-panel panel-border"
      aria-label="项目 AI 助手"
      data-asset-drop-disabled={!writable || isArchived}
    >
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
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={showArchivedConversations}
                disabled={!scopeAvailable}
                onClick={() => {
                  setConversationMenuOpen(false);
                  onShowArchivedConversationsChange?.(!showArchivedConversations);
                }}
              >
                <Check size={14} visibility={showArchivedConversations ? 'visible' : 'hidden'} />
                <span>显示已归档会话</span>
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
      </div>
      <div
        className="message-list"
        ref={messageListRef}
        onScroll={(event) => {
          const list = event.currentTarget;
          followLatestMessageRef.current =
            list.scrollHeight - list.clientHeight - list.scrollTop <= 32;
        }}
      >
        {conversation ? (
          <MediaReviewQueue
            projectId={conversation.projectId}
            conversationId={conversation.id}
            writable={writable}
            renderTimeline={renderMessageItems}
            renderMediaForm={(form, submit) => (
              <MediaModelSelectionCard
                projectId={conversation.projectId}
                request={form.selectionRequest!}
                referenceImageInputs={form.inputAssetIds.map((id) => `asset://${id}`)}
                onSelect={submit}
              />
            )}
          />
        ) : (
          renderMessageItems()
        )}
      </div>
      {showStatusMessage && <small className="chat-status">{statusMessage}</small>}
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
          key={mediaModelSelection.selectionToken}
          request={mediaModelSelection}
          referenceImageInputs={mediaReferenceImageInputs}
          projectId={conversation?.projectId}
          onSelect={onSelectMediaModel}
          onCancel={onCancelMediaModelSelection}
        />
      )}
      {agentParameterRequest && (
        <AgentParameterCard
          request={agentParameterRequest}
          projectId={conversation?.projectId}
          onSubmit={onSubmitAgentParameters}
        />
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
                  {entity.label || entity.id}{' '}
                  <small>({entity.type === 'novel-chapter' ? '小说章节' : entity.type})</small>
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
      {agentTask?.task.status === 'failed' &&
        (agentTask.task.retryable || !!agentTask.savedProductionReceipts?.receipts.length) && (
          <div className="agent-recovery-notice" role="status">
            <div className="agent-recovery-copy">
              {!!agentTask.savedProductionReceipts?.receipts.length && (
                <strong>
                  已确认保存{' '}
                  {agentTask.savedProductionReceipts.nextOffset !== undefined ? '至少 ' : ''}
                  {agentTask.savedProductionReceipts.receipts.length} 次制作修改；整轮任务尚未完成。
                </strong>
              )}
              <span>
                {agentTask.task.errorCode === 'interrupted'
                  ? '应用退出时任务中断；已保存的草稿会保留，可以重新提交创作请求以创建新任务，或在任务日志中恢复未完成产物。'
                  : '上次 Agent 任务未完成；已保存产物会保留，可以重新提交未完成部分以创建新任务。'}
              </span>
              {agentTask.task.usage && (
                <small>
                  模型请求 {agentTask.task.usage.providerRequestsUsed} 次；工具调用{' '}
                  {agentTask.task.usage.toolCallsUsed} 次
                </small>
              )}
            </div>
            <div className="agent-recovery-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => onComposerChange(taskRecoveryInstruction(agentTask))}
              >
                填写继续指令
              </button>
              {onOpenTaskLog && (
                <button type="button" className="button secondary" onClick={onOpenTaskLog}>
                  查看任务日志
                </button>
              )}
            </div>
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
        ref={assetDrop.ref}
        {...assetDrop.handlers}
        className={`composer ${assetDrop.hovering ? 'is-asset-drag-over' : ''}`}
        onDragOver={(event) => {
          assetDrop.handlers.onDragOver(event);
          if (
            canAttach &&
            onAddAttachments &&
            Array.from(event.dataTransfer.types ?? []).includes('Files')
          )
            event.preventDefault();
        }}
        onDrop={(event) => {
          if (readAssetDrop(event.dataTransfer)) {
            assetDrop.handlers.onDrop(event);
            return;
          }
          if (!canAttach || !onAddAttachments || !event.dataTransfer.files?.length) return;
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
        {((modelControlsOpen && llmProfiles.length > 0) || attachments.length > 0) && (
          <div className="composer-context-controls">
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
                    onChange={(event) =>
                      onResearchModeChange(event.target.value as AgentResearchMode)
                    }
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
          </div>
        )}
        {onPromptTemplateChange && (
          <details className="conversation-prompt-template">
            <summary>
              <span>本会话要求约束</span>
              <small>
                {promptTemplateLoading
                  ? ' · 加载中'
                  : promptTemplate.trim()
                    ? ` · ${promptTemplate.length} 字，发送时附加`
                    : ' · 当前为空'}
              </small>
            </summary>
            <div className="conversation-prompt-template-body">
              <small>发送前自动保存并附加；清空后不携带约束。</small>
              <textarea
                aria-label="本会话要求约束"
                value={promptTemplate}
                onChange={(event) => onPromptTemplateChange(event.target.value)}
                placeholder="例如：固定故事时间与视觉风格；每个镜头写清时间、地点、动作、景别、运镜、对白和连续性；不要为了凑时长改变剧情逻辑。"
                rows={5}
                disabled={!conversation || !writable || isArchived || promptTemplateBusy}
              />
              <div className="conversation-prompt-template-actions">
                {promptTemplateDirty && <small role="status">有未保存修改</small>}
                {onSavePromptTemplate && (
                  <button
                    className="button secondary"
                    type="button"
                    onClick={onSavePromptTemplate}
                    disabled={!conversation || !writable || isArchived || promptTemplateBusy}
                  >
                    {promptTemplateLoading
                      ? '加载中…'
                      : promptTemplateBusy
                        ? '保存中…'
                        : '保存会话约束'}
                  </button>
                )}
                <details className="conversation-prompt-template-tools">
                  <summary>模板与清理</summary>
                  <div className="conversation-prompt-template-tools-body">
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => onPromptTemplateChange(SCENE_PROMPT_CONSTRAINT_TEMPLATE)}
                      disabled={!conversation || !writable || isArchived || promptTemplateBusy}
                    >
                      套用最新版分镜模板
                    </button>
                    <button
                      className="button secondary"
                      type="button"
                      onClick={() => onPromptTemplateChange('')}
                      disabled={!conversation || !writable || isArchived || promptTemplateBusy}
                    >
                      清空约束
                    </button>
                    {onReloadPromptTemplate && (
                      <button
                        className="button secondary"
                        type="button"
                        disabled={promptTemplateBusy}
                        onClick={onReloadPromptTemplate}
                      >
                        重新加载已保存约束
                      </button>
                    )}
                    <details>
                      <summary>查看最新版分镜制作模板</summary>
                      <textarea
                        aria-label="最新版分镜制作模板"
                        value={SCENE_PROMPT_CONSTRAINT_TEMPLATE}
                        readOnly
                        rows={8}
                      />
                      <small>套用模板会替换当前编辑内容。</small>
                    </details>
                  </div>
                </details>
              </div>
              {promptTemplateError && <small role="alert">{promptTemplateError}</small>}
            </div>
          </details>
        )}
        <ComposerTextarea
          key={conversation?.id ?? 'no-conversation'}
          panelRef={panelRef}
          placeholder={
            isArchived
              ? '当前会话已归档，处于只读状态'
              : conversation
                ? '描述你要完成的任务，需要时会检索项目里的草稿和已发布资料…'
                : '请先新建会话'
          }
          value={composer}
          onChange={onComposerChange}
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
              !conversationBusy &&
              !promptTemplateBusy &&
              (composer.trim() || attachments.length > 0) &&
              conversation &&
              writable
            ) {
              send();
            }
          }}
          disabled={!conversation || !writable || isArchived}
          actions={
            generationLocked && !allowConcurrentTasks ? (
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
                {generationLocked && (
                  <button
                    className="icon-button send-button"
                    type="button"
                    title="停止生成"
                    onClick={onCancelGeneration}
                  >
                    <Square size={14} fill="currentColor" />
                  </button>
                )}
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
                  title={
                    attachmentsPending
                      ? '正在读取附件'
                      : conversationBusy
                        ? '上一轮仍在执行'
                        : '发送消息'
                  }
                  onClick={send}
                  disabled={
                    attachmentsPending ||
                    conversationBusy ||
                    promptTemplateBusy ||
                    !writable ||
                    (!composer.trim() && attachments.length === 0) ||
                    !conversation ||
                    isArchived
                  }
                >
                  <ChevronRight size={18} />
                </button>
              </>
            )
          }
        />
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
  return AGENT_TOOL_ACTION_LABELS[name] ?? '执行项目操作';
}

function readableToolReceipt(summary: string): string {
  const completed = summary.match(/^已完成：(.+)$/);
  const names = completed?.[1]?.split('、');
  return names?.every((name) => /^[a-z][\w-]*(?:\.[\w-]+)+$/.test(name))
    ? `已完成：${names.map(agentToolActionLabel).join('、')}`
    : summary;
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
  const httpStatus = error.match(/Provider HTTP (\d{3})\b/i)?.[1];
  // Some gateways report billing failures as HTTP 401/403; use their explicit reason first.
  if (
    httpStatus &&
    /\binsufficient[ _-]+(?:balance|quota|credits?|funds)\b|\b(?:balance|credits?|funds)[ _-]+(?:insufficient|exhausted)\b|余额不足|额度不足|欠费/i.test(
      error,
    )
  )
    return '模型服务余额或额度不足，本次任务未完成。请检查供应商账户并补足额度，或切换可用的模型连接后继续。已保存的内容会保留。';
  if (httpStatus && /^5\d{2}$/.test(httpStatus))
    return `模型服务暂时异常（HTTP ${httpStatus}），本次任务未完成。已保存的内容会保留，可稍后继续或切换模型后继续。`;
  if (httpStatus === '429')
    return '模型服务请求过多或额度不足，本次任务未完成。请稍后继续，或检查供应商额度。';
  if (httpStatus === '401' || httpStatus === '403')
    return '模型服务拒绝了访问，本次任务未完成。请检查供应商密钥和模型权限后继续。';
  if (/AGENT_SCENE_NOT_SAVED|AGENT_PRODUCTION_NOT_SAVED/.test(error))
    return (
      error.replace(/^AGENT_(?:SCENE|PRODUCTION)_NOT_SAVED:\s*/, '') +
      ' 已保存的草稿和分段会保留，可以继续处理。'
    );
  if (/TOOL_REPAIR_LIMIT/.test(error))
    return '参数校验连续失败后任务停止，本次未通过校验的操作没有执行；这不表示提交过大。请根据校验详情修正请求，再在当前会话重新提交未完成部分。已保存的草稿和分段会保留。';
  if (error.startsWith('AGENT_OUTPUT_REPAIR_STALLED:'))
    return '自动修复检测到相同的无效提交重复出现，任务已停止；重复的这次提交没有执行。已保存的草稿和分段会保留，可以继续完成。';
  if (error.startsWith('AGENT_REPEATED_READ_STALLED:'))
    return '模型反复读取同一版本、同一范围的资料且没有推进任务，已停止无效循环。已保存的内容会保留，可在当前会话继续完成未完成部分。';
  if (/AGENT_TOOL_QUOTA_EXHAUSTED/.test(error))
    return '本任务的工具调用预算已用完，任务未完成。已保存的草稿和分段会保留；请在任务日志核对进度，再于当前会话提交未完成部分。';
  if (/AGENT_TURN_QUOTA_EXHAUSTED/.test(error))
    return '本任务的模型请求预算已用完，任务未完成。已保存的草稿和分段会保留；请在任务日志核对进度，再于当前会话提交未完成部分。';
  if (
    /^(TOOL_REPAIR_LIMIT|TOOL_OUTPUT_REPAIR_LIMIT|AGENT_OUTPUT_REPAIR_STALLED|INVALID_TOOL_ARGUMENTS|INCOMPLETE_PROVIDER_OUTPUT|INCOMPLETE_TOOL_OUTPUT):/.test(
      error,
    )
  ) {
    return error.startsWith('TOOL_OUTPUT_REPAIR_LIMIT:')
      ? '自动修正后仍未能完成提交，任务未完成。失败的这次提交未执行，已保存的草稿和分段会保留，可以继续完成。'
      : '生成的提交内容格式有误或不完整，本次提交未执行。已保存的草稿和分段会保留，可以继续完成。';
  }
  if (/application is closing|worker was restarting/i.test(error)) {
    return '应用退出时任务中断；已保存的草稿会保留，可以重新提交创作请求以创建新任务，或恢复未完成产物。';
  }
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

function AgentTaskError({ error, message }: { error: string; message?: string }) {
  const readable = message ?? readableAgentTaskError(error);
  return (
    <div className="agent-task-error">
      <p className="agent-tool-timeline-error">{readable}</p>
      {readable !== error && /Provider HTTP \d{3}\b/i.test(error) && (
        <details className="agent-task-error-details">
          <summary>技术详情</summary>
          <pre>{error}</pre>
        </details>
      )}
    </div>
  );
}

type AgentActionRow = {
  id: string;
  title: string;
  toolName?: string;
  detail?: string;
  status: 'running' | 'ok' | 'warn' | 'error';
};

const AGENT_TOOL_ACTION_LABELS: Record<string, string> = {
  'conversation.ask': '准备问答表单',
  'project.structure.get': '查看项目结构',
  'tools.load': '加载工具',
  'document.submit_draft': '保存文档草稿',
  'library.search': '检索项目资料',
  'library.read': '阅读资料正文',
  'conversation.task.checkpoint': '核对任务进度与内容',
  'scene.submit_structure': '保存场次与镜头',
  'scene.structure.stage': '分段编排场次与镜头',
  'scene.read': '读取已有场次',
  'model.request': '模型请求',
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
  'production.skill.read': '读取制作任务声明',
  'media.review.prepare': '保存媒体审核表单',
  'media.review.list': '查看媒体审核队列',
  'media.review.read': '读取媒体审核表单',
  'media.audio.read': '查看场次配音资料',
  'media.generation.submit': '提交生成任务',
  'media.task.get': '查询生成任务',
  'media.task.cancel': '取消生成任务',
  'task.plan.submit': '提交任务计划',
  'task.package.complete': '完成任务包',
  'settings.get': '读取设置',
  'adapter.schema.get': '查看适配器结构',
  'adapter.schema.propose': '提交适配器配置',
  'adapter.schema.audit.list': '查看适配器变更',
  'novel.structure.get': '查看小说结构',
  'novel.chapter.list': '查看小说章节',
  'novel.chapter.update_metadata': '更新章节目录',
  'novel.chapter.archive': '归档章节',
  'novel.chapter.restore': '恢复章节',
  'novel.chapter.submit_draft': '保存章节草稿',
  'novel.chapter.write_draft': '撰写章节草稿',
  'novel.reference.submit_draft': '保存小说设定',
  'novel.episode.submit_draft': '保存分集大纲',
  'novel.episode.submit_structure': '保存分集场次与镜头',
  'novel.adaptation.submit_proposal': '保存改编方案',
  'novel.chapter.batch.submit': '开始章节批量创作',
  'novel.chapter.batch.source.read': '读取批量创作资料',
  'novel.chapter.batch.get': '查看章节创作进度',
  'scene.update_shot_prompts': '更新镜头提示词',
  'scene.update_shot_timings': '更新镜头时长',
  'shot.continuity.read': '查看镜头衔接资料',
  'shot.continuity.save': '保存镜头衔接提示词',
  'production.defaults.get': '查看制作默认设置',
  'production.read': '读取制作内容',
  'conversation.task.route': '准备创作任务',
  'project.backup.prepare': '准备项目备份',
  'project.export.prepare': '准备项目导出',
  'project.restore.prepare': '准备项目恢复',
  'asset.update_alias': '修改素材名称',
  'asset.update_tags': '更新素材标签',
  'settings.propose_update': '准备设置变更',
  'settings.apply_update': '保存设置变更',
  'maintenance.status': '检查维护状态',
  'maintenance.clear_cache': '清理缓存',
  'maintenance.cleanup_research_cache': '清理资料检索缓存',
  'maintenance.cleanup_context_snapshots': '清理上下文快照',
  'maintenance.diagnostics.prepare': '准备诊断信息',
};

function taskRecoveryInstruction(detail: AgentTaskDetail): string {
  const generationId =
    detail.savedProductionReceipts?.receipts[0]?.generationId ??
    detail.providerSteps.at(-1)?.generationId;
  return `${generationId ? `请先调用 conversation.task.route，decision=inspect，targetGenerationId=${generationId}，核对持久化保存回执，按 nextOffset 查询其余回执。` : '请先核对刚才任务日志、已保存草稿和分段进度。'}保留原请求、全部会话要求、现有内容与 ID，只补完未完成部分；已经保存的修改不要重复执行。如果所需修改已全部保存，请直接确认结果。`;
}

function taskResultLabel(detail: AgentTaskDetail | undefined): string | undefined {
  if (!detail) return undefined;
  const task = detail.task;
  if (task.status === 'cancelled') return '任务已停止';
  if (task.status === 'failed') return '任务失败 · 未完成';
  if (task.status !== 'completed') return undefined;
  if (task.completionState === 'partial')
    return task.outcome === 'read-only' ? '未完成 · 未执行保存' : '部分完成';
  const hasSaves =
    detail.documents.length > 0 || Boolean(detail.savedProductionReceipts?.receipts.length);
  if (!hasSaves) return '回复结束';
  return detail.deliveryReview?.state === 'verified'
    ? '回复结束 · 已保存 · 内容已核验'
    : detail.deliveryReview?.state === 'needs_revision'
      ? '回复结束 · 已保存 · 内容需修复'
      : '回复结束 · 已保存 · 内容未核验';
}

function agentTaskForAssistantMessage(
  messageId: string,
  messages: ChatMessageInfo[],
  tasks: AgentTaskDetail[],
  generation: LlmGenerationInfo | undefined,
  liveTask: AgentTaskDetail | undefined,
): AgentTaskDetail | undefined {
  const recordedTask = tasks.find((detail) =>
    detail.events.some((event) => event.messageBoundary?.messageId === messageId),
  );
  if (recordedTask) return recordedTask;
  if (
    generation?.assistantMessage.id === messageId &&
    liveTask &&
    (!liveTask.task.userMessageId || liveTask.task.userMessageId === generation.userMessage.id)
  )
    return liveTask;
  const index = messages.findIndex((item) => item.id === messageId);
  if (index < 0) return undefined;
  const replyToMessageId = messages[index]?.replyToMessageId;
  const user = replyToMessageId
    ? messages.find((item) => item.id === replyToMessageId && item.role === 'user')
    : [...messages.slice(0, index)].reverse().find((item) => item.role === 'user');
  if (!user) return undefined;
  return tasks
    .filter((item) => item.task.userMessageId === user.id)
    .sort((left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt))[0];
}

function agentActionRows(
  detail: AgentTaskDetail,
  generationFailed: boolean,
  generationSettled = false,
): AgentActionRow[] {
  const rows: AgentActionRow[] = [];
  const pending: AgentActionRow[] = [];
  const flushPending = (status: AgentActionRow['status'], detailText?: string) => {
    while (pending.length > 0) {
      const row = pending.shift()!;
      row.status = status;
      if (detailText && (status !== 'ok' || pending.length === 0)) row.detail = detailText;
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
    if (event.eventType === 'agent.tool.failed') {
      if (pending.length > 0) flushPending('error', event.summary);
      else
        rows.push({ id: event.id, title: '工具调用失败', detail: event.summary, status: 'error' });
      continue;
    }
    if (
      event.eventType === 'agent.library.completed' ||
      event.eventType === 'agent.tool.succeeded' ||
      event.eventType === 'agent.research.completed'
    ) {
      flushPending('ok', readableToolReceipt(event.summary));
      continue;
    }
    if (event.eventType === 'document.draft.created') {
      rows.push({ id: event.id, title: '已写入文档草稿', status: 'ok' });
      continue;
    }
    if (event.eventType === 'scene.structure.saved') {
      rows.push({
        id: event.id,
        title: '已保存场次与镜头草稿',
        ...(event.summary.includes('待处理')
          ? { detail: '存在待处理的制作问题', status: 'warn' as const }
          : { status: 'ok' as const }),
      });
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

  const runningTask =
    !generationSettled && (detail.task.status === 'running' || detail.task.status === 'queued');
  if (runningTask && !generationFailed) rows.push(...pending);
  else
    flushPending(
      generationFailed || detail.task.status === 'failed'
        ? 'error'
        : generationSettled
          ? 'warn'
          : 'ok',
      generationSettled && !generationFailed ? '调用结果未同步' : undefined,
    );
  return rows;
}

function mergeLiveAgentActions(
  rows: AgentActionRow[],
  liveActions: ConversationRuntimeLiveAction[] | undefined,
  running: boolean,
): AgentActionRow[] {
  const merged = [...rows];
  const latestModelRequest = liveActions
    ?.slice()
    .reverse()
    .find((action) => action.toolName === 'model.request');
  for (const live of liveActions ?? []) {
    if (live.toolName === 'model.request' && live !== latestModelRequest) continue;
    if (
      merged.some(
        (row) =>
          (row.toolName === live.toolName &&
            !['tool_arguments', 'repairing_tool_output'].includes(live.phase ?? '')) ||
          row.id === `live:${live.id}`,
      )
    ) {
      continue;
    }
    merged.push({
      id: `live:${live.id}`,
      title:
        live.phase === 'repairing_tool_output'
          ? '自动修正提交内容'
          : agentToolActionLabel(live.toolName),
      toolName: live.toolName,
      detail:
        live.phase === 'repairing_tool_output'
          ? live.status === 'running'
            ? live.toolName === 'scene.structure.stage'
              ? '正在改为分段提交，按进度恢复未完成内容'
              : '正在重新生成完整的提交内容'
            : live.status === 'succeeded'
              ? '恢复流程已完成'
              : '这次修正未完成'
          : live.phase === 'tool_arguments'
            ? `正在生成参数 · ${Math.ceil((live.argumentBytes ?? 0) / 1024)} KB · 最近接收 ${live.lastActivityAt ? new Date(live.lastActivityAt).toLocaleTimeString() : ''}`
            : live.phase
              ? (
                  {
                    native_queued: '等待网络准入',
                    admitted: '准备发送',
                    sent: '等待响应',
                    headers: '已收到响应头',
                    first_byte: '已收到首字节',
                    thinking: '模型推理中',
                    visible_text: '正在回复',
                    complete: '本轮接收完成',
                    failed: '本轮请求失败',
                    cancelled: '已取消',
                    retry_wait: '模型服务暂时异常，稍后自动重试',
                  } as Record<string, string>
                )[live.phase]
              : undefined,
      status:
        live.status === 'failed'
          ? 'error'
          : live.status === 'succeeded'
            ? 'ok'
            : running
              ? 'running'
              : 'warn',
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
  stage = false,
  onOpenLibrarySource,
  onOpenReviewTarget,
}: {
  detail?: AgentTaskDetail;
  generationStatus?: LlmGenerationInfo['status'];
  generationError?: string;
  liveActions?: ConversationRuntimeLiveAction[];
  runningPlaceholder?: boolean;
  stage?: boolean;
  onOpenLibrarySource?: (source: AgentLibrarySourceInfo) => void;
  onOpenReviewTarget?: (projectId: string, target: AgentTaskReviewTargetInfo) => void;
}) {
  const generationFailed = generationStatus === 'failed' || generationStatus === 'cancelled';
  const generationSettled =
    generationStatus !== undefined && !['prepared', 'streaming'].includes(generationStatus);
  const running =
    detail?.task.status !== 'waiting_review' &&
    !generationSettled &&
    (runningPlaceholder ||
      (!generationFailed &&
        (generationStatus === 'prepared' ||
          generationStatus === 'streaming' ||
          detail?.task.status === 'running' ||
          detail?.task.status === 'queued')));
  const actions = mergeLiveAgentActions(
    detail ? agentActionRows(detail, generationFailed, generationSettled) : [],
    liveActions,
    running && !generationFailed,
  );
  const completedActionCount = actions.filter((action) => action.status === 'ok').length;
  const attentionActionCount = actions.filter(
    (action) => action.status === 'warn' || action.status === 'error',
  ).length;
  const activeTool = actions.some(
    (action) =>
      action.toolName && action.toolName !== 'model.request' && action.status === 'running',
  );
  const composingReply = liveActions?.some(
    (action) => action.toolName === 'model.request' && action.phase === 'visible_text',
  );
  const retryingRequest = liveActions?.some(
    (action) => action.phase === 'retry_wait' && action.status === 'running',
  );
  const rawError = generationError ?? detail?.task.errorMessage;
  const readableError = readableAgentTaskError(rawError);
  // A completed request may still contain a rejected read. Only persisted
  // read citations prove that project source content was actually retrieved.
  const readCompleted = detail?.librarySources?.some(
    (source) => source.toolName === 'library.read',
  );
  const errorMessage =
    readableError &&
    readCompleted &&
    /^(TOOL_REPAIR_LIMIT|TOOL_OUTPUT_REPAIR_LIMIT|AGENT_OUTPUT_REPAIR_STALLED|INVALID_TOOL_ARGUMENTS|INCOMPLETE_PROVIDER_OUTPUT|INCOMPLETE_TOOL_OUTPUT):/.test(
      rawError ?? '',
    )
      ? `资料已读取；${readableError}`
      : readableError;
  const [expandedOverride, setExpandedOverride] = useState<boolean | null>(null);
  const expanded = expandedOverride ?? (!stage || Boolean(errorMessage));

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
      data-stage={stage ? 'true' : undefined}
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
            <span>
              {detail?.task.status === 'waiting_review'
                ? '等待用户操作'
                : running
                  ? retryingRequest
                    ? '模型服务暂时异常，正在准备重试'
                    : activeTool
                      ? '正在调用工具'
                      : composingReply
                        ? '正在回复'
                        : '等待助手回复'
                  : stage
                    ? `已调用 ${actions.filter((action) => action.toolName).length} 个工具`
                    : '调用了工具'}
            </span>
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </button>
          <small className="agent-tool-timeline-progress">
            {detail &&
            (detail.documents.length > 0 ||
              Boolean(detail.savedProductionReceipts?.receipts.length))
              ? `草稿已保存 · ${detail.deliveryReview?.state === 'verified' ? '内容已核验' : detail.deliveryReview?.state === 'needs_revision' ? '内容需修复' : '内容未核验'} · `
              : ''}
            {running
              ? `${completedActionCount} 项已完成${activeTool ? ' · 正在执行下一步' : ''}`
              : attentionActionCount > 0
                ? `${completedActionCount} 项完成 · ${attentionActionCount} 项需关注`
                : `${completedActionCount} 项操作完成`}
          </small>
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
                      <details className="agent-tool-result">
                        <summary>技术详情</summary>
                        <code>{action.toolName}</code>
                      </details>
                    ) : null}
                    {action.detail ? (
                      <details className="agent-tool-result">
                        <summary>返回结果</summary>
                        <small>{action.detail}</small>
                      </details>
                    ) : null}
                  </span>
                </li>
              ))}
              {(detail?.librarySources ?? []).map((source) => (
                <li
                  key={JSON.stringify([
                    source.sourceType,
                    source.sourceId,
                    source.versionId,
                    source.status,
                    source.structureNodeId,
                  ])}
                >
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
      {errorMessage && rawError ? <AgentTaskError error={rawError} message={errorMessage} /> : null}
      {running && detail && (
        <AgentDeliveryFeedback
          key={detail.task.id}
          detail={detail}
          onOpenTarget={onOpenReviewTarget}
        />
      )}
    </section>
  );
}

export function MediaModelSelectionCard({
  projectId,
  request,
  referenceImageInputs,
  onSelect,
  onCancel,
}: {
  projectId?: string;
  request: MediaModelSelectionRequest;
  referenceImageInputs?: string[];
  onSelect?: (selection: MediaModelSelectionDecision) => void;
  onCancel?: () => void;
}) {
  const [candidateKey, setCandidateKey] = useState('');
  const selectionRef = useRef<HTMLDivElement>(null);
  // Request assets remain present even when the caller supplies an empty attachment list.
  const referenceInputsKey = JSON.stringify([
    ...request.inputAssetIds.map((id) => `asset://${id}`),
    ...(referenceImageInputs ?? [])
      .filter((url) => !imageAssetId(url))
      .slice(0, request.inputAttachmentCount),
  ]);
  const requestReferenceInputs = useMemo<string[]>(
    () => JSON.parse(referenceInputsKey) as string[],
    [referenceInputsKey],
  );
  const candidate = request.candidates.find(
    (item) => `${item.providerProfileId}:${item.modelId}` === candidateKey,
  );

  useEffect(() => {
    setCandidateKey('');
  }, [request.selectionToken]);

  useEffect(() => {
    if (selectionRef.current) selectionRef.current.scrollTop = 0;
  }, [candidateKey]);

  return (
    <div
      className="agent-model-selection media-model-selection"
      ref={selectionRef}
      role="dialog"
      aria-label={`选择${request.kind === 'image' ? '图片' : '视频'}生成模型`}
    >
      <div className="media-model-selection-heading">
        <div>
          <strong>选择{request.kind === 'image' ? '图片' : '视频'}生成模型</strong>
          <small>选择本次生成使用的模型，审核参数后点击“提交生成”即可开始。</small>
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
            projectId={projectId}
            key={`${request.selectionToken}:${candidateKey}`}
            request={{
              prompt: request.prompt,
              capability: request.kind,
              providerProfileId: candidate.providerProfileId,
              modelId: candidate.modelId,
              modelName: candidate.modelName,
              adapters: candidate.adapters,
              affectsCost: candidate.costNotice.required,
              referenceImageInputs: requestReferenceInputs,
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
  projectId,
  request,
  onSubmit,
}: {
  projectId?: string;
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
    const existingImages = productionImagesFromParameters(adapter, values);
    const images = [...existingImages];
    for (const url of request.referenceImageInputs ?? []) {
      const identity = imageAssetId(url) ?? url;
      if (!images.some((image) => (imageAssetId(image.url) ?? image.url) === identity))
        images.push({ url, role: 'reference' });
    }
    return seedProductionInputs(
      adapter,
      values,
      typeof values.prompt === 'string'
        ? values.prompt
        : Array.isArray(values.content) &&
            values.content.some(
              (item) =>
                item && typeof item === 'object' && !Array.isArray(item) && item.type === 'text',
            )
          ? undefined
          : request.prompt,
      images.length ? images : undefined,
    );
  }, [adapter, request.proposedParameters, request.referenceImageInputs, request.prompt]);
  const [parameters, setParameters] = useState<AdapterParameters>(initialValues);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const submittedRef = useRef(false);
  const [pendingFields, setPendingFields] = useState<Set<string>>(() => new Set());

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
    setParameters((current) => updatePromptParameter(adapter, current, key, value));
  };
  const submit = () => {
    if (submittedRef.current || !onSubmit || pendingFields.size) return;
    const missing = adapter.parameterSchema.required.filter((key) => {
      const value = parameters[key];
      return (
        value === undefined ||
        value === '' ||
        (Array.isArray(value) && (value.length === 0 || value.every((item) => item === '')))
      );
    });
    if (missing.length > 0) {
      setError(
        `请填写必填参数：${missing.map((key) => adapter.parameterSchema.properties[key]?.title || key).join('、')}`,
      );
      return;
    }
    const imageProperty = adapter.parameterSchema.properties.images;
    if (imageProperty?.type === 'array' && Array.isArray(parameters.images)) {
      const count = parameters.images.filter(
        (item) => typeof item === 'string' && item.trim(),
      ).length;
      if (count < (imageProperty.minItems ?? 0) || count > (imageProperty.maxItems ?? Infinity)) {
        setError(
          `请检查${imageProperty.title || '参考图片'}数量：至少 ${imageProperty.minItems ?? 0} 张${imageProperty.maxItems === undefined ? '' : `，最多 ${imageProperty.maxItems} 张`}。`,
        );
        return;
      }
    }
    setError('');
    submittedRef.current = true;
    setSubmitted(true);
    onSubmit(
      adapter.key,
      canonicalPromptParameters(
        Array.isArray(parameters.images)
          ? {
              ...parameters,
              images: parameters.images.filter((item) => typeof item === 'string' && item.trim()),
            }
          : parameters,
        promptReferences(adapter, parameters),
      ),
    );
  };

  return (
    <div className="agent-parameter-card" role="dialog" aria-label="补充生成参数">
      <strong>{request.capability === 'image' ? '图片' : '视频'}参数</strong>
      <small>{request.modelName} · 参数校验通过后直接提交生成。</small>
      {request.affectsCost && (
        <small className="agent-cost-warning">
          点击“提交生成”即确认使用当前模型和参数，可能产生费用，当前暂不计算具体金额。
        </small>
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
            references={promptReferences(adapter, parameters)}
            projectId={projectId}
            onPendingChange={(pending) =>
              setPendingFields((current) => {
                if (current.has(key) === pending) return current;
                const next = new Set(current);
                if (pending) next.add(key);
                else next.delete(key);
                return next;
              })
            }
            onChange={(value) => update(key, value)}
          />
        ))}
      </div>
      <div className="agent-parameter-actions">
        {error && <small className="agent-parameter-error">{error}</small>}
        <button
          className="button primary"
          type="button"
          onClick={submit}
          disabled={submitted || !onSubmit || pendingFields.size > 0}
        >
          {submitted ? '正在提交…' : '提交生成'}
        </button>
      </div>
    </div>
  );
}

function AgentParameterField({
  references,
  projectId,
  name,
  property,
  required,
  value,
  onChange,
  onPendingChange,
}: {
  references: PromptReference[];
  projectId?: string;
  name: string;
  property: AdapterParameterProperty;
  required: boolean;
  value?: AdapterParameters[string];
  onChange: (value: AdapterParameters[string] | undefined) => void;
  onPendingChange?: (pending: boolean) => void;
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
  if (
    property.type === 'object' ||
    (property.type === 'array' && property.items?.type !== 'string')
  )
    return (
      <>
        <StructuredParameterField
          schema={property}
          value={value}
          onChange={onChange}
          label={label}
          path={id}
          projectId={projectId}
          references={references}
        />
        {metadata}
      </>
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
        <span>{label}</span>
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
          value={parameterScalarText(value)}
          onChange={(e) => onChange(e.target.value || undefined)}
        >
          <option value="">请选择</option>
          {property.enum.map((item) => (
            <option key={parameterScalarText(item)} value={parameterScalarText(item)}>
              {parameterScalarText(item)}
            </option>
          ))}
        </select>
        {metadata}
      </label>
    );
  }
  if (property.type === 'array') {
    if (name === 'images' && property.items?.type === 'string')
      return (
        <ImageListParameterField
          field={{ key: name }}
          inputId={id}
          label={<label htmlFor={id}>{label}</label>}
          description={metadata}
          property={property}
          value={value}
          projectId={projectId}
          onChange={onChange}
          onPendingChange={onPendingChange}
        />
      );
    const list = Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').join('\n')
      : '';
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
  if (name === 'prompt')
    return (
      <div className="parameter-field prompt-field">
        <label htmlFor={id}>{label}</label>
        {references.length ? (
          <PromptReferenceEditor
            id={id}
            label={label}
            value={parameterScalarText(value)}
            references={references}
            projectId={projectId}
            onChange={onChange}
            maxLength={property.maxLength}
          />
        ) : (
          <textarea
            id={id}
            value={parameterScalarText(value)}
            maxLength={property.maxLength}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
        {metadata}
      </div>
    );
  const numeric = property.type === 'integer';
  return (
    <StructuredAssetDrop
      schema={property}
      value={value}
      projectId={projectId}
      onChange={onChange}
      mediaKind={
        ['video', 'video_url'].includes(name) && property.type === 'string' ? 'video' : undefined
      }
    >
      <label className="parameter-field" htmlFor={id}>
        <span>{label}</span>
        <input
          id={id}
          type={numeric ? 'number' : 'text'}
          value={parameterScalarText(value)}
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
    </StructuredAssetDrop>
  );
}
