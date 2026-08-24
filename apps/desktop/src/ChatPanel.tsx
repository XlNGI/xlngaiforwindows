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
  Pencil,
  RefreshCw,
  RotateCcw,
  Square,
} from 'lucide-react';
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
} from '@ai-video/contracts';

type PromotionTarget = 'document' | 'memory' | 'constraint';
export type ComposerMode = 'chat' | 'document' | 'novel-writing';

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
  contextPreview?: ProductionContextInfo;
  generation?: LlmGenerationInfo;
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
  contextPreview,
  generation,
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
  onCreateDocumentDraft,
  onCreateNovelChapter,
}: ChatPanelProps) {
  const close = onClose ?? onCollapse;
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
      <div className="composer">
        <textarea
          aria-label="会话消息"
          placeholder={
            conversation
              ? composerMode === 'novel-writing'
                ? '输入明确的章节创作指令…'
                : '输入消息…'
              : '请先新建会话'
          }
          rows={3}
          value={composer}
          onChange={(event) => onComposerChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (
              generation?.status !== 'prepared' &&
              generation?.status !== 'streaming' &&
              composer.trim() &&
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
            {onCreateDocumentDraft && (
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
            <button
              className="icon-button send-button"
              type="button"
              title="发送消息"
              onClick={onSendMessage}
              disabled={!composer.trim() || !conversation}
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
