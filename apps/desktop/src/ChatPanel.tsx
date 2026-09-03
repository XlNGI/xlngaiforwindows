import {
  Archive,
  BookOpenText,
  Bot,
  ChevronDown,
  ChevronRight,
  Copy,
  FilePlus2,
  MessageSquarePlus,
  PanelRightClose,
  Paperclip,
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentResearchMode,
  ChatMessageInfo,
  ConversationInfo,
  ConversationScopeType,
  LlmAttemptInfo,
  LlmGenerationInfo,
  LlmStatusResult,
  ProviderModelInfo,
  ProviderProfileInfo,
  ProductionContextInfo,
  AgentToolConfirmationRequest,
  AgentTaskPendingConfirmationInfo,
  AdapterDescriptor,
  AdapterParameters,
  AdapterParameterProperty,
  UnifiedAgentModelSelectionRequest,
} from '@ai-video/contracts';

type PromotionTarget = 'document' | 'memory' | 'constraint';
export type ComposerMode = 'chat' | 'document' | 'novel-writing' | 'short-drama';

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

interface ChatPanelProps {
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
  composerMode?: ComposerMode;
  /** Number of chapters selected as the current short-drama episode scope. */
  episodeChapterCount?: number;
  contextPreview?: ProductionContextInfo;
  generation?: LlmGenerationInfo;
  agentTask?: import('@ai-video/contracts').AgentTaskDetail;
  onConfirmSchemaProposal?: (adapterKey: string, version: number) => void;
  onRejectSchemaProposal?: (adapterKey: string, version: number) => void;
  confirmation?: AgentToolConfirmationRequest | AgentTaskPendingConfirmationInfo;
  onConfirmAgentAction?: (approved: boolean) => void;
  onOpenTaskLog?: () => void;
  onContinueAgentTask?: () => void;
  onClose?: () => void;
  showCloseAction?: boolean;
  /** @deprecated Use onClose. Kept temporarily for component consumers outside the workspace host. */
  onCollapse?: () => void;
  onScopeChange: (scope: ConversationScopeType) => void;
  onSelectConversation: (conversation: ConversationInfo) => void;
  onCreateConversation: () => void;
  showArchivedConversations?: boolean;
  onShowArchivedConversationsChange?: (show: boolean) => void;
  onRenameConversation?: (conversationId: string, title: string) => void;
  onArchiveConversation?: (conversationId: string) => void;
  onRestoreConversation?: (conversationId: string) => void;
  canLoadMoreConversations?: boolean;
  onLoadMoreConversations?: () => void;
  onPromoteMessage: (message: ChatMessageInfo, target: PromotionTarget) => void;
  onRetryGeneration: (assistantMessageId: string) => void;
  onLlmProfileChange: (profileId: string) => void;
  onLlmModelChange: (modelId: string) => void;
  onResearchModeChange?: (mode: AgentResearchMode) => void;
  onComposerModeChange?: (mode: ComposerMode) => void;
  onOpenProviderSettings: () => void;
  onComposerChange: (value: string) => void;
  onCancelGeneration: () => void;
  onSendMessage: () => void;
  attachments?: ChatAttachment[];
  onAddAttachments?: (files: FileList | File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  agentModelSelection?: UnifiedAgentModelSelectionRequest;
  onSelectAgentModel?: (providerProfileId: string, modelId: string) => void;
  agentParameterRequest?: {
    prompt: string;
    capability: 'image' | 'video';
    providerProfileId: string;
    modelId: string;
    modelName: string;
    adapters: AdapterDescriptor[];
    affectsCost: boolean;
    referenceImageInputs?: string[];
  };
  onSubmitAgentParameters?: (adapterKey: string, parameters: AdapterParameters) => void;
  onCreateDocumentDraft?: () => void;
  onCreateNovelChapter?: () => void;
}

function scopeLabel(scope: ConversationScopeType): string {
  return scope === 'project' ? '项目' : scope === 'scene' ? '场次' : '镜头';
}

export function ChatPanel({
  scopeType,
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
  composerMode = 'chat',
  episodeChapterCount = 0,
  contextPreview,
  generation,
  agentTask,
  confirmation,
  onConfirmAgentAction,
  onConfirmSchemaProposal,
  onRejectSchemaProposal,
  onOpenTaskLog,
  onContinueAgentTask,
  onClose,
  showCloseAction = true,
  onCollapse,
  onScopeChange,
  onSelectConversation,
  onCreateConversation,
  showArchivedConversations = false,
  onShowArchivedConversationsChange,
  onRenameConversation,
  onArchiveConversation,
  onRestoreConversation,
  canLoadMoreConversations,
  onLoadMoreConversations,
  onPromoteMessage,
  onRetryGeneration,
  onLlmProfileChange,
  onLlmModelChange,
  onResearchModeChange,
  onComposerModeChange,
  onOpenProviderSettings,
  onComposerChange,
  onCancelGeneration,
  onSendMessage,
  attachments = [],
  onAddAttachments,
  onRemoveAttachment,
  agentModelSelection,
  onSelectAgentModel,
  agentParameterRequest,
  onSubmitAgentParameters,
  onCreateDocumentDraft,
  onCreateNovelChapter,
}: ChatPanelProps) {
  const close = onClose ?? onCollapse;
  const fileInputId = 'chat-attachment-input';
  const fileInputRef = useRef<HTMLInputElement>(null);
  const displayedConfirmation = confirmation ?? agentTask?.pendingConfirmation;
  const confirmationIsActionable = Boolean(
    confirmation && 'confirmationToken' in confirmation && onConfirmAgentAction,
  );
  return (
    <section className="chat-panel panel-border" aria-label="项目会话">
      <div className="panel-heading">
        <span>{scopeLabel(scopeType)}会话</span>
        {showCloseAction && close && (
          <button className="icon-button subtle" type="button" title="关闭会话" onClick={close}>
            <PanelRightClose size={16} />
          </button>
        )}
      </div>
      <div className="scope-tabs">
        {(['project', 'scene', 'shot'] as const).map((scope) => (
          <button
            type="button"
            key={scope}
            className={scopeType === scope ? 'active' : ''}
            onClick={() => onScopeChange(scope)}
          >
            {scopeLabel(scope)}
          </button>
        ))}
      </div>
      <div className="conversation-bar">
        <select
          value={conversation?.id ?? ''}
          onChange={(event) => {
            const selected = conversations.find((item) => item.id === event.target.value);
            if (selected) onSelectConversation(selected);
          }}
          disabled={!scopeAvailable}
        >
          <option value="">
            {scopeAvailable ? '选择会话' : `请先选择${scopeLabel(scopeType)}`}
          </option>
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
        <button
          className="icon-button subtle"
          type="button"
          title="重命名会话"
          disabled={!writable || !conversation}
          onClick={() => {
            const current = conversation;
            if (!current) return;
            const title = window.prompt('新会话名称', current.title);
            if (title?.trim()) onRenameConversation?.(current.id, title.trim());
          }}
        >
          <Pencil size={14} />
        </button>
        <button
          className="icon-button subtle"
          type="button"
          title="归档会话"
          disabled={!writable || !conversation || Boolean(conversation.archivedAt)}
          onClick={() => {
            const current = conversation;
            if (current) onArchiveConversation?.(current.id);
          }}
        >
          <Archive size={14} />
        </button>
        <button
          className="icon-button subtle"
          type="button"
          title="恢复会话"
          disabled={!writable || !conversation || !conversation.archivedAt}
          onClick={() => {
            const current = conversation;
            if (current) onRestoreConversation?.(current.id);
          }}
        >
          <RotateCcw size={14} />
        </button>
        {canLoadMoreConversations && (
          <button
            className="icon-button subtle"
            type="button"
            title="加载更多会话"
            onClick={onLoadMoreConversations}
          >
            <ChevronDown size={14} />
          </button>
        )}
      </div>
      <div className="llm-context-bar">
        <div className="llm-provider-status">
          <span>{llmStatus?.provider ?? 'LLM'}</span>
          <small>
            {llmStatus?.configured
              ? llmStatus.configurationSource === 'environment'
                ? `旧版环境变量配置 · ${llmStatus.model}`
                : llmStatus.model
              : '尚未配置 LLM 连接'}
          </small>
        </div>
        {legacyLlmConfigured && (
          <div className="legacy-llm-notice">
            <span>OPENAI_API_KEY 旧版入口仍可用，重新录入后可迁移到 Windows 安全存储。</span>
            <button type="button" onClick={onOpenProviderSettings}>
              迁移到供应商设置
            </button>
          </div>
        )}
        {llmProfiles.length > 0 && (
          <div className="llm-provider-selectors">
            <select
              aria-label="LLM 供应商连接"
              value={selectedLlmProfileId}
              disabled={generation?.status === 'prepared' || generation?.status === 'streaming'}
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
              disabled={generation?.status === 'prepared' || generation?.status === 'streaming'}
              onChange={(event) => onLlmModelChange(event.target.value)}
            >
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
                disabled={generation?.status === 'prepared' || generation?.status === 'streaming'}
                onChange={(event) => onResearchModeChange(event.target.value as AgentResearchMode)}
              >
                <option value="auto">研究：自动</option>
                <option value="project_only">研究：仅项目资料</option>
                <option value="network_disabled">研究：禁止联网</option>
              </select>
            )}
          </div>
        )}
        {onComposerModeChange && (
          <div className="scope-tabs" aria-label="会话模式">
            <button
              type="button"
              className={composerMode === 'chat' ? 'active' : ''}
              onClick={() => onComposerModeChange('chat')}
              disabled={generation?.status === 'prepared' || generation?.status === 'streaming'}
            >
              会话
            </button>
            <button
              type="button"
              className={composerMode === 'document' ? 'active' : ''}
              onClick={() => onComposerModeChange('document')}
              disabled={generation?.status === 'prepared' || generation?.status === 'streaming'}
            >
              文档
            </button>
            <button
              type="button"
              className={composerMode === 'novel-writing' ? 'active' : ''}
              onClick={() => onComposerModeChange('novel-writing')}
              disabled={generation?.status === 'prepared' || generation?.status === 'streaming'}
            >
              小说创作
            </button>
            <button
              type="button"
              className={composerMode === 'short-drama' ? 'active' : ''}
              onClick={() => onComposerModeChange('short-drama')}
              disabled={generation?.status === 'prepared' || generation?.status === 'streaming'}
            >
              短剧创作
            </button>
          </div>
        )}
        {composerMode === 'short-drama' && (
          <div className="short-drama-hint" role="status">
            {episodeChapterCount && episodeChapterCount > 0
              ? `短剧创作 · 已选 ${episodeChapterCount} 个章节作为本集范围`
              : '短剧创作 · 请先在小说章节页选择章节'}
          </div>
        )}
        {contextPreview && (
          <details>
            <summary>
              上下文 {contextPreview.sources.length} 项 · 约 {contextPreview.estimatedTokens} tokens
            </summary>
            <div className="context-source-list">
              {contextPreview.sources.map((source) => (
                <span key={`${source.type}-${source.id}`} title={source.scopeType}>
                  {source.label}
                  {source.version ? ` v${source.version}` : ''}
                  {source.truncated ? ' · 已裁剪' : ''}
                </span>
              ))}
            </div>
          </details>
        )}
      </div>
      <div className="message-list">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <Bot size={22} />
            <strong>创作助手</strong>
            <span>会话内容与正式项目文档相互独立。</span>
          </div>
        ) : (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
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
              {message.role === 'assistant' && message.attempt && (
                <AttemptMetadata attempt={message.attempt} />
              )}
              {message.role === 'assistant' && (
                <footer>
                  <button
                    type="button"
                    onClick={() => onPromoteMessage(message, 'document')}
                    disabled={!writable || message.status !== 'complete'}
                  >
                    保存为文档草稿
                  </button>
                  <button
                    type="button"
                    onClick={() => onPromoteMessage(message, 'memory')}
                    disabled={!writable || message.status !== 'complete'}
                  >
                    加入记忆
                  </button>
                  <button
                    type="button"
                    onClick={() => onPromoteMessage(message, 'constraint')}
                    disabled={!writable || message.status !== 'complete'}
                  >
                    添加约束
                  </button>
                  {message.status === 'failed' &&
                    (generation?.assistantMessage.id !== message.id ||
                      generation.retryable !== false) &&
                    (llmStatus?.configured || llmProfiles.length > 0) && (
                      <button type="button" onClick={() => onRetryGeneration(message.id)}>
                        <RefreshCw size={11} />
                        重试
                      </button>
                    )}
                </footer>
              )}
            </article>
          ))
        )}
      </div>
      {statusMessage && <small className="chat-status">{statusMessage}</small>}
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
          <strong>
            需要确认：
            {displayedConfirmation.action === 'document.archive' ? '归档' : '恢复归档'}文档
          </strong>
          <span>“{displayedConfirmation.documentTitle}”</span>
          <small>确认有效期至 {new Date(displayedConfirmation.expiresAt).toLocaleString()}</small>
          {confirmationIsActionable ? (
            <div>
              <button
                type="button"
                className="button primary"
                onClick={() => onConfirmAgentAction?.(true)}
              >
                批准
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
            <small>应用已重新启动，原 Provider 会话不可恢复。请重试任务以重新申请确认。</small>
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
            conversation
              ? composerMode === 'novel-writing'
                ? '输入明确的章节创作指令…'
                : composerMode === 'short-drama'
                  ? '输入短剧创作指令（如：生成本集整体把控 / 生成场次和镜头提示词 / 把前三章的人物和场景做成提示词）…'
                  : '输入消息…'
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
              generation?.status !== 'prepared' &&
              generation?.status !== 'streaming' &&
              (composer.trim() || attachments.length > 0) &&
              conversation &&
              writable
            ) {
              onSendMessage();
            }
          }}
          disabled={!conversation || !writable}
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
            {onCreateDocumentDraft && composerMode !== 'short-drama' && (
              <button
                className="icon-button subtle"
                type="button"
                title="创建文档草稿"
                onClick={onCreateDocumentDraft}
                disabled={!composer.trim() || !conversation || !writable}
              >
                <FilePlus2 size={16} />
              </button>
            )}
            {onCreateNovelChapter && composerMode === 'novel-writing' && (
              <button
                className="icon-button subtle"
                type="button"
                title="创建小说章节草稿"
                onClick={onCreateNovelChapter}
                disabled={!conversation || !writable}
              >
                <BookOpenText size={16} />
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
              disabled={!conversation || !writable}
            />
            <button
              type="button"
              className="icon-button subtle attachment-button"
              title="添加图片、视频或文件"
              aria-label="添加图片、视频或文件"
              onClick={() => fileInputRef.current?.click()}
              disabled={!conversation || !writable}
            >
              <Paperclip size={16} />
            </button>
            <button
              className="icon-button send-button"
              type="button"
              title="发送消息"
              onClick={onSendMessage}
              disabled={(!composer.trim() && attachments.length === 0) || !conversation}
            >
              <ChevronRight size={18} />
            </button>
          </>
        )}
      </div>
    </section>
  );
}

function AttemptMetadata({ attempt }: { attempt: LlmAttemptInfo }) {
  const usage = attempt.usage;
  const terminal = ['complete', 'failed', 'cancelled', 'interrupted'].includes(attempt.status);
  return (
    <div className="message-attempt-metadata">
      <div className="message-usage-summary">
        {usage ? (
          <>
            <span>输入 {formatTokenCount(usage.inputTokens)}</span>
            <span>缓存 {formatTokenCount(usage.cachedInputTokens)}</span>
            <span>输出 {formatTokenCount(usage.outputTokens)}</span>
            {usage.reasoningTokens !== undefined && (
              <span>推理 {formatTokenCount(usage.reasoningTokens)}</span>
            )}
          </>
        ) : terminal ? (
          <span>供应商未提供用量</span>
        ) : (
          <span>正在生成</span>
        )}
        <strong>
          {attempt.currency && attempt.estimatedCost
            ? `预计 ${attempt.currency} ${attempt.estimatedCost}`
            : '费用未知'}
        </strong>
      </div>
      <details className="message-attempt-details">
        <summary>调用明细</summary>
        <dl>
          <div>
            <dt>供应商</dt>
            <dd>{attempt.providerName}</dd>
          </div>
          <div>
            <dt>模型</dt>
            <dd>{attempt.modelName}</dd>
          </div>
          <div>
            <dt>协议</dt>
            <dd>{attempt.protocol}</dd>
          </div>
          <div>
            <dt>开始时间</dt>
            <dd>{new Date(attempt.startedAt).toLocaleString()}</dd>
          </div>
          <div>
            <dt>首 Token</dt>
            <dd>{formatLatency(attempt.startedAt, attempt.firstTokenAt)}</dd>
          </div>
          <div>
            <dt>总耗时</dt>
            <dd>{formatLatency(attempt.startedAt, attempt.completedAt)}</dd>
          </div>
          {attempt.pricingSnapshot && (
            <div>
              <dt>价格快照</dt>
              <dd>
                {attempt.pricingSnapshot.currency} 输入 {attempt.pricingSnapshot.inputPrice}
                {attempt.pricingSnapshot.cachedInputPrice
                  ? ` / 缓存 ${attempt.pricingSnapshot.cachedInputPrice}`
                  : ''}{' '}
                / 输出 {attempt.pricingSnapshot.outputPrice}（每{' '}
                {new Intl.NumberFormat().format(attempt.pricingSnapshot.unitTokens)} Token）
              </dd>
            </div>
          )}
          {attempt.providerReportedCost && (
            <div>
              <dt>供应商报告费用</dt>
              <dd>
                {attempt.providerReportedCost.currency
                  ? `${attempt.providerReportedCost.currency} `
                  : ''}
                {attempt.providerReportedCost.amount}
              </dd>
            </div>
          )}
          {attempt.errorMessage && (
            <div>
              <dt>错误</dt>
              <dd>
                {attempt.errorCode ? `${attempt.errorCode}: ` : ''}
                {attempt.errorMessage}
              </dd>
            </div>
          )}
        </dl>
      </details>
    </div>
  );
}

function formatTokenCount(value: number | undefined): string {
  return value === undefined ? '未知' : new Intl.NumberFormat().format(value);
}

function formatLatency(startAt: string, endAt: string | undefined): string {
  if (!endAt) return '未知';
  const milliseconds = new Date(endAt).valueOf() - new Date(startAt).valueOf();
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '未知';
  return milliseconds < 1_000
    ? `${milliseconds} ms`
    : `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`;
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
    if (
      request.referenceImageInputs &&
      request.referenceImageInputs.length > 0 &&
      Object.prototype.hasOwnProperty.call(adapter.parameterSchema.properties, 'images')
    ) {
      values.images = request.referenceImageInputs;
    }
    return values;
  }, [adapter, request.referenceImageInputs, request.prompt]);
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
