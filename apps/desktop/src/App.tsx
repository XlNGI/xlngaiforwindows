import { useEffect, useRef, useState } from 'react';
import { newerAgentTaskDetail } from './conversation-timeline';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Archive,
  RotateCcw,
  Aperture,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clapperboard,
  Copy,
  FilePlus2,
  FileText,
  FileUp,
  FolderOpen,
  Image,
  ListChecks,
  MessageSquare,
  Minus,
  PanelLeftClose,
  Pencil,
  Plus,
  Power,
  Save,
  Settings2,
  ShieldCheck,
  Square,
  X,
  BookOpen,
  Users,
} from 'lucide-react';
import type {
  AgentLibrarySourceInfo,
  AgentTaskReviewTargetInfo,
  AssetInfo,
  AgentResearchMode,
  ChatMessageInfo,
  ConstraintInfo,
  ConversationScopeType,
  DocumentDetail,
  DocumentKind,
  DocumentSummary,
  HealthResult,
  LlmGenerationInfo,
  LlmGenerationPrepareResult,
  LlmStatusResult,
  ProviderModelInfo,
  ProviderProfileInfo,
  ProductionContextInfo,
  ProjectInfo,
  RecentProjectInfo,
  SceneInfo,
  SceneReferenceImageOptions,
  ShotInfo,
  SqliteProbeResult,
  UnifiedAgentModelSelectionRequest,
  AdapterDescriptor,
  UnifiedAgentCapability,
  UnifiedAgentRunParams,
  LlmInputAttachment,
  MediaSubmissionConfirmationRequest,
  AgentProtectedUiHandoff,
  NovelWritingIntent,
  VideoGenerationJobInfo,
  ConversationRuntimeLiveAction,
} from '@ai-video/contracts';
import {
  composeSceneReferenceImagePrompt,
  inferUnifiedAgentCapabilityHint,
  productionShotReferenceIds,
  productionSkillPrompt,
  type ProductionSkillId,
} from '@ai-video/contracts';
import {
  projectWorker,
  workerScope,
  selectWorkerScope,
  forgetWorkerScope,
  isCurrentWorkerScope,
  WORKER_SCOPE_STALE_EVENT,
} from './worker-scope';
import { TaskConfirmationQueue, type TaskConfirmation } from './task-confirmations';
import { useProjectMaintenance } from './use-project-maintenance';
import { useDocumentWorkspace } from './use-document-workspace';
import { AgentResourceRefresh } from './agent-resource-refresh';
import { useConversationWorkspace } from './use-conversation-workspace';
import { useAssetWorkspace } from './use-asset-workspace';
import { useProductionState } from './use-production-state';
import { TaskConfirmationDialog } from './TaskConfirmationDialog';
import { useProjectTaskSubscription } from './use-project-task-subscription';
import { ProductionPanel } from './ProductionPanel';
import { CharacterSceneWorkspace } from './CharacterSceneWorkspace';
import { VoiceDesignPanel } from './dubbing/VoiceDesignPanel';
import { SceneWorkspace } from './SceneWorkspace';
import { ScriptWorkspace } from './ScriptWorkspace';
import { DocumentDirectoryTitleText } from './DocumentDirectoryTitle';
import { SceneShotDirectory } from './SceneShotDirectory';
import {
  ShotWorkspace,
  shotReferenceImageSelections,
  type ShotReferenceAssets,
} from './ShotWorkspace';
import {
  shotReferenceDocumentIdsByScene,
  type ShotReferenceDocumentIds,
} from './shot-binding-summary';
import { MaintenanceDialog } from './MaintenanceDialog';
import { ChatPanel, type ChatAttachment } from './ChatPanel';
import { composeConversationPrompt } from './conversation-prompt-template';
import { useConversationPromptTemplate } from './use-conversation-prompt-template';
import { SettingsCenter } from './SettingsCenter';
import { ProductionNavigation } from './ProductionNavigation';
import { providerProfileClient } from './provider-profile-client';
import { AssetLibraryView } from './assets/AssetLibraryView';
import { assetAttachmentFiles } from './assets/asset-attachment-files';
import { RoughCutWorkspace, type RoughCutImportRequest } from './rough-cut/RoughCutWorkspace';
import { TaskLogView } from './TaskLogView';
import { NovelWorkspace } from './NovelWorkspace';
import { ProjectCreateDialog, ProjectStartupWorkspace } from './ProjectStartupWorkspace';
import { GeneratedDraftSync } from './GeneratedDraftSync';
import { streamPreparedLlmGeneration, type LlmStreamRun } from './llm-client';
import { WorkspaceSurface } from './workspace/WorkspaceSurface';
import { ResizableAppLayout } from './workspace/ResizableAppLayout';
import { useWorkspaceLayout } from './workspace/use-workspace-layout';
import {
  conversationWindowToggleAction,
  conversationWindowToggleLabel,
  isConversationWindowPresented,
} from './workspace/conversation-window';
import {
  DETACHED_PANEL_ACTION_EVENT,
  DETACHED_PANEL_READY_EVENT,
  DETACHED_QUESTION_RESULT_EVENT,
  closeDetachedPanelWindow,
  focusDetachedPanelWindow,
  openDetachedPanelWindow,
  sendDetachedSnapshot,
  type DetachedConversationSnapshot,
  type DetachedDocumentSnapshot,
  type DetachedPanelAction,
  type DetachedPanelConfig,
  type DetachedPanelId,
  type DetachedPanelEnvelope,
  type DetachedPanelSnapshot,
} from './workspace/detached-window';
import { MODAL_Z_INDEX } from './workspace/ui-layers';
import { useDraftDocumentBatch } from './DraftDocumentBatch';
import { generationStatusLabel } from './generation-feedback';
import brandLogo from './brand-logo.png';
type CheckState = 'checking' | 'ready' | 'error';
type WorkspaceView = 'documents' | 'characters' | 'novel' | 'shots' | 'tasks' | 'rough-cut';
const WORKSPACE_VIEW_TITLES: Record<WorkspaceView, string> = {
  documents: '剧本',
  characters: '角色与场景',
  novel: '小说',
  shots: '场次与镜头',
  tasks: '任务日志',
  'rough-cut': '粗剪工作台',
};
type NavigationMode = 'project' | 'production';
type SettingsPage = 'providers' | 'usage' | 'maintenance';
interface DetachedPanelRegistration {
  config: DetachedPanelConfig;
  snapshot: DetachedPanelSnapshot;
  snapshotSequence: number;
  actionSequence: number;
}
const TERMINAL_VIDEO_STATUSES = new Set<string>(['succeeded', 'failed', 'timed-out', 'cancelled']);
function notifyVideoTerminal(job: VideoGenerationJobInfo): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  try {
    new Notification(job.status === 'succeeded' ? '视频生成完成' : '视频任务已结束', {
      body: generationStatusLabel(job.status),
    });
  } catch {
    // The task log remains the durable notification surface when OS notifications are unavailable.
  }
}
function snapshotEntityId(snapshot: DetachedPanelSnapshot): string | undefined {
  return snapshot.panelId === 'document' ? snapshot.documentId : snapshot.conversation?.id;
}
function detachedConfigMatchesSnapshot(
  config: DetachedPanelConfig,
  snapshot: DetachedPanelSnapshot,
): boolean {
  return (
    config.projectId === snapshot.projectId &&
    config.panelId === snapshot.panelId &&
    config.entityId === snapshotEntityId(snapshot)
  );
}
const isTauriRuntime = () => '__TAURI_INTERNALS__' in window;
const LLM_SELECTION_STORAGE_KEY = 'ai-video.llm-selection';
const AGENT_MODEL_PREFERENCES_STORAGE_KEY = 'ai-video.agent-model-preferences';
export interface ConversationModelSelection {
  providerProfileId: string;
  modelId: string;
}
/** `agent.run` always selects the conversation LLM; media selection uses its own later contract. */
export function resolveAgentRunModelSelection(
  capability: UnifiedAgentCapability,
  explicitSelection?: ConversationModelSelection,
  rememberedSelection?: ConversationModelSelection,
  agentSelection?: ConversationModelSelection,
): ConversationModelSelection | undefined {
  void capability;
  if (explicitSelection) return explicitSelection;
  return agentSelection ?? rememberedSelection;
}
function initialLlmSelection(): {
  providerProfileId?: string;
  modelId?: string;
} {
  try {
    const stored = window.localStorage.getItem(LLM_SELECTION_STORAGE_KEY);
    if (!stored) return {};
    const value = JSON.parse(stored) as {
      providerProfileId?: unknown;
      modelId?: unknown;
    };
    return {
      providerProfileId:
        typeof value.providerProfileId === 'string' ? value.providerProfileId : undefined,
      modelId: typeof value.modelId === 'string' ? value.modelId : undefined,
    };
  } catch {
    return {};
  }
}
function initialResearchMode(): AgentResearchMode {
  try {
    const stored = window.localStorage.getItem(LLM_SELECTION_STORAGE_KEY);
    if (!stored) return 'auto';
    const value = JSON.parse(stored) as {
      researchMode?: unknown;
    };
    return value.researchMode === 'project_only' || value.researchMode === 'network_disabled'
      ? value.researchMode
      : 'auto';
  } catch {
    return 'auto';
  }
}
function initialAgentModelPreferences(): Record<
  string,
  Partial<
    Record<
      UnifiedAgentCapability,
      {
        providerProfileId: string;
        modelId: string;
      }
    >
  >
> {
  try {
    const stored = window.localStorage.getItem(AGENT_MODEL_PREFERENCES_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const result: Record<
      string,
      Partial<
        Record<
          UnifiedAgentCapability,
          {
            providerProfileId: string;
            modelId: string;
          }
        >
      >
    > = {};
    for (const [conversationId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const preferences: Partial<
        Record<
          UnifiedAgentCapability,
          {
            providerProfileId: string;
            modelId: string;
          }
        >
      > = {};
      for (const [capability, selection] of Object.entries(value)) {
        if (!selection || typeof selection !== 'object') continue;
        const candidate = selection as {
          providerProfileId?: unknown;
          modelId?: unknown;
        };
        if (
          typeof candidate.providerProfileId === 'string' &&
          typeof candidate.modelId === 'string'
        ) {
          preferences[capability as UnifiedAgentCapability] = {
            providerProfileId: candidate.providerProfileId,
            modelId: candidate.modelId,
          };
        }
      }
      if (Object.keys(preferences).length > 0) result[conversationId] = preferences;
    }
    return result;
  } catch {
    return {};
  }
}
const MAX_CHAT_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const MAX_CHAT_TOTAL_BYTES = 40 * 1024 * 1024;
const MAX_CHAT_ATTACHMENTS = 8;
const MAX_TEXT_ATTACHMENT_BYTES = 2 * 1024 * 1024;
function attachmentKind(file: File): ChatAttachment['kind'] {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'file';
}
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.onabort = () => reject(new Error(`读取已取消：${file.name}`));
    reader.onload = () =>
      typeof reader.result === 'string'
        ? resolve(reader.result)
        : reject(new Error(`无法读取文件：${file.name}`));
    reader.readAsDataURL(file);
  });
}
function encodedImageMimeType(dataUrl: string | undefined): string | undefined {
  const type = /^data:(image\/[a-z0-9.+-]+);base64,/iu.exec(dataUrl ?? '')?.[1]?.toLowerCase();
  return type === 'image/jpg' ? 'image/jpeg' : type;
}
async function readImageAsDataUrl(file: File): Promise<string> {
  const original = await readFileAsDataUrl(file);
  const maxDataUrlLength = 1850000;
  if (original.length <= maxDataUrlLength) return original;
  if (typeof window.Image === 'undefined' || typeof document === 'undefined') return original;
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const element = new window.Image();
    element.onload = () => resolve(element);
    element.onerror = () => reject(new Error(`无法解码图片：${file.name}`));
    element.src = original;
  });
  const maxDimension = 2048;
  let scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return original;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.86, 0.72, 0.58]) {
      const compressed = canvas.toDataURL('image/jpeg', quality);
      if (compressed.length <= maxDataUrlLength) return compressed;
    }
    scale *= 0.72;
  }
  throw new Error(`图片压缩后仍超过传输限制：${file.name}`);
}
function readTextFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取文件：${file.name}`));
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.readAsText(file);
  });
}
function isGenerationActive(generation: LlmGenerationInfo | undefined): boolean {
  return generation?.status === 'prepared' || generation?.status === 'streaming';
}
function generationStatusMessage(generation: LlmGenerationInfo): string {
  if (isGenerationActive(generation)) return '';
  return (
    readableGenerationError(generation.error) ??
    (generation.status === 'complete'
      ? ''
      : generation.status === 'cancelled'
        ? '生成已停止'
        : '生成失败')
  );
}
function readableFailure(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (
      reason as {
        message?: unknown;
      }
    ).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}
function readableGenerationError(error: string | undefined): string | undefined {
  if (!error) return undefined;
  if (/application is closing|worker was restarting/i.test(error)) {
    return '应用退出时任务中断；已保存的草稿会保留，可以重新提交创作请求以创建新任务，或在任务日志恢复未完成产物。';
  }
  if (error.includes('AGENT_DOCUMENT_NOT_WRITTEN')) {
    return '助手尚未将文档保存到项目，本次任务未完成。请重试保存。';
  }
  if (/Out-of-order LLM stream content was rejected/i.test(error)) {
    return '生成流出现了延迟片段，已停止本次任务；请重新发送，工具调用不会重复提交。';
  }
  const turnLimit = error.match(/Pi runtime exceeded the (\d+)-turn limit/i);
  if (turnLimit) {
    return `助手连续调用工具超过 ${turnLimit[1]} 轮，已停止。`;
  }
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
function upsertAgentTaskDetail(
  current: import('@ai-video/contracts').AgentTaskDetail[],
  detail: import('@ai-video/contracts').AgentTaskDetail,
): import('@ai-video/contracts').AgentTaskDetail[] {
  const latest = newerAgentTaskDetail(
    current.find((item) => item.task.id === detail.task.id),
    detail,
  );
  return [...current.filter((item) => item.task.id !== detail.task.id), latest].sort(
    (left, right) => right.task.updatedAt.localeCompare(left.task.updatedAt),
  );
}
/**
 * Script pages list outline/plan/constraint. Character and scene prompts live on their
 * own page. Novel chapters (`note` bound to `novel_chapters`) and shot
 * storyboards stay in their own workspaces so they do not flood the script list.
 */
const DOCUMENT_KIND_LABELS: Record<DocumentKind, string> = {
  outline: '大纲',
  plan: '计划',
  constraint: '约束',
  character: '角色',
  scene: '场景',
  prop: '道具',
  voice: '音色样本',
  storyboard: '分镜',
  note: '笔记',
};
const SCRIPT_DOCUMENT_KINDS: DocumentKind[] = ['outline', 'plan', 'constraint'];
const CHARACTER_DOCUMENT_KINDS: DocumentKind[] = ['character', 'scene', 'prop', 'voice'];
const WORKSPACE_DOCUMENT_KINDS: DocumentKind[] = [
  ...SCRIPT_DOCUMENT_KINDS,
  ...CHARACTER_DOCUMENT_KINDS,
];
/** Only workspace kinds are listed; everything else lives in its own workspace. */
function isWorkspaceDocument(summary: DocumentSummary): boolean {
  return summary.domainScope !== 'novel' && WORKSPACE_DOCUMENT_KINDS.includes(summary.kind);
}
function matchesDocumentFilter(summary: DocumentSummary, filter: 'all' | DocumentKind): boolean {
  return filter === 'all' || summary.kind === filter;
}
export function mergeGenerationMessage(
  messages: ChatMessageInfo[],
  selectedConversationId: string | undefined,
  next: LlmGenerationInfo,
): ChatMessageInfo[] {
  if (selectedConversationId !== next.conversationId) return messages;
  if (messages.some((message) => message.id === next.assistantMessage.id))
    return messages.map((message) =>
      message.id === next.assistantMessage.id ? next.assistantMessage : message,
    );
  return [
    ...messages.filter((message) => message.id !== next.assistantMessage.id),
    next.assistantMessage,
  ];
}
export function inferAgentCapability(prompt: string): UnifiedAgentCapability {
  return inferUnifiedAgentCapabilityHint(prompt);
}
export function inferNovelWritingIntent(
  prompt: string,
  chapterId?: string,
): NovelWritingIntent | undefined {
  const value = prompt.normalize('NFC').trim();
  // A chapter hint freezes a writing target before the model can respond.
  // Broad novel goals must reach the assistant even from the novel workspace.
  const chapterRequest =
    /(小说正文|小说章节|章节|本章|第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*章)/u.test(value) ||
    (value.includes('小说') && /续写|重写/u.test(value));
  const selectedBodyRequest = Boolean(chapterId) && /(正文|稿件)/u.test(value);
  if (!value || (!chapterRequest && !selectedBodyRequest)) return undefined;
  if (
    !/(生成|创作|撰写|写作|续写|继续写|继续创作|重写|改写|修改|更新|保存|写入|generate|write|continue|rewrite|save|update)/iu.test(
      value,
    )
  ) {
    return undefined;
  }
  const label = value.match(/第\s*[0-9零〇一二三四五六七八九十百千万两]+\s*章/u)?.[0];
  // A numbered creation request names its own target; the open editor is
  // only a target hint for edits and continuation of the current chapter.
  const createsNumberedChapter =
    Boolean(label) &&
    !/续写|继续写|继续创作|重写|重新|改写|修改|更新|保存|写入|continue|rewrite|save|update/iu.test(
      value,
    );
  if (chapterId && !createsNumberedChapter) {
    return {
      action: /续写|继续写|继续创作|continue/iu.test(value)
        ? 'continue_chapter'
        : 'rewrite_chapter',
      chapterId,
    };
  }
  return {
    action: 'create_chapter',
    ...(label ? { displayLabel: label.replace(/\s+/gu, '') } : {}),
    ...(label ? { chapterTitle: label.replace(/\s+/gu, '') } : {}),
  };
}
/** Keep direct image preparation on the Agent-authored prompt path. */
export function composeImageGenerationPrompt(
  userPrompt: string,
  _source?: {
    title: string;
    content: string;
  },
): string {
  void _source;
  return userPrompt.trim();
}
export { composeConversationPrompt } from './conversation-prompt-template';
export function buildAgentAttachments(attachments: ChatAttachment[]): LlmInputAttachment[] {
  return attachments.flatMap((attachment): LlmInputAttachment[] => {
    if (attachment.kind === 'video') {
      const metadata: LlmInputAttachment = {
        name: attachment.name,
        mimeType: attachment.mimeType,
        text: '这是一个视频附件。当前分析使用视频首帧作为视觉参考。',
      };
      return attachment.previewDataUrl
        ? [
            metadata,
            {
              name: `${attachment.name}（首帧）`,
              mimeType: 'image/jpeg',
              dataUrl: attachment.previewDataUrl,
            },
          ]
        : [metadata];
    }
    return [
      {
        name: attachment.name,
        mimeType:
          (attachment.kind === 'image' ? encodedImageMimeType(attachment.dataUrl) : undefined) ??
          attachment.mimeType,
        ...(attachment.dataUrl ? { dataUrl: attachment.dataUrl } : {}),
        ...(attachment.text !== undefined ? { text: attachment.text } : {}),
      },
    ];
  });
}
/** Returns image data suitable for media adapters' `images` reference field. */
export function collectReferenceImageInputs(attachments: ChatAttachment[]): string[] {
  return attachments.flatMap((attachment) => {
    if (attachment.kind === 'image' && attachment.dataUrl) {
      const normalized = normalizeImageDataUrl(attachment.dataUrl);
      return normalized ? [normalized] : [];
    }
    if (attachment.kind === 'video' && attachment.previewDataUrl) {
      const normalized = normalizeImageDataUrl(attachment.previewDataUrl);
      return normalized ? [normalized] : [];
    }
    return [];
  });
}
/** Canonicalizes browser/file Data URLs before they cross the native boundary. */
export function normalizeImageDataUrl(value: string): string | undefined {
  const comma = value.indexOf(',');
  if (comma < 0) return undefined;
  const header = value.slice(0, comma).trim().toLowerCase();
  if (!/^data:image\/(?:png|jpe?g|webp);base64$/u.test(header)) return undefined;
  const encoded = value
    .slice(comma + 1)
    .replace(/[\s\r\n]+/gu, '')
    .trim();
  if (!encoded || !/^[a-z0-9+/]*={0,2}$/iu.test(encoded)) return undefined;
  const mime = header.includes('jpeg') || header.includes('jpg') ? 'jpeg' : header.slice(11, -7);
  return `data:image/${mime};base64,${encoded}`;
}
function readVideoPreviewAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`无法提取视频首帧：${file.name}`));
    }, 8000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      video.onloadeddata = null;
      video.onerror = null;
      URL.revokeObjectURL(objectUrl);
      video.remove();
    };
    video.muted = true;
    video.preload = 'metadata';
    video.onloadeddata = () => {
      const width = video.videoWidth || 1280;
      const height = video.videoHeight || 720;
      const scale = Math.min(1, 1280 / Math.max(width, height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        cleanup();
        reject(new Error(`无法提取视频首帧：${file.name}`));
        return;
      }
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', 0.78));
      cleanup();
    };
    video.onerror = () => {
      cleanup();
      reject(new Error(`无法读取视频：${file.name}`));
    };
    video.src = objectUrl;
  });
}
interface ProjectPickerMenuProps {
  recentProjects: RecentProjectInfo[];
  currentProject?: Pick<ProjectInfo, 'rootPath'>;
  writable: boolean;
  busy: boolean;
  onOpenProject: (rootPath: string) => void;
  onBrowse: () => void;
  onCreate: () => void;
  onRename: () => void;
  onCheckIntegrity: () => void;
  onBackup: () => void;
  onCloseProject: () => void;
}
function ProjectPickerMenu({
  recentProjects,
  currentProject,
  writable,
  busy,
  onOpenProject,
  onBrowse,
  onCreate,
  onRename,
  onCheckIntegrity,
  onBackup,
  onCloseProject,
}: ProjectPickerMenuProps) {
  return (
    <div className="project-picker-menu" role="menu" aria-label="项目菜单">
      <span className="project-picker-menu-heading">最近打开</span>
      {recentProjects.length > 0 ? (
        recentProjects.slice(0, 6).map((recent) => (
          <button
            key={recent.rootPath}
            type="button"
            role="menuitem"
            className={recent.rootPath === currentProject?.rootPath ? 'current' : ''}
            title={recent.rootPath}
            disabled={busy}
            onClick={() => onOpenProject(recent.rootPath)}
          >
            <FolderOpen size={14} />
            <span>{recent.name}</span>
            {recent.rootPath === currentProject?.rootPath && <small>当前</small>}
          </button>
        ))
      ) : (
        <span className="project-picker-empty">暂无最近项目</span>
      )}
      <div className="project-picker-menu-divider" />
      <button type="button" role="menuitem" disabled={busy} onClick={onBrowse}>
        <FolderOpen size={14} />
        <span>浏览项目目录…</span>
      </button>
      <button type="button" role="menuitem" disabled={busy} onClick={onCreate}>
        <Plus size={14} />
        <span>新建项目…</span>
      </button>
      {currentProject && (
        <>
          <div className="project-picker-menu-divider" />
          <span className="project-picker-menu-heading">当前项目</span>
          <button type="button" role="menuitem" disabled={!writable || busy} onClick={onRename}>
            <Pencil size={14} />
            <span>修改项目名称</span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={onCheckIntegrity}>
            <ShieldCheck size={14} />
            <span>完整性检查</span>
          </button>
          <button type="button" role="menuitem" disabled={!writable || busy} onClick={onBackup}>
            <Save size={14} />
            <span>备份项目</span>
          </button>
          <button type="button" role="menuitem" disabled={busy} onClick={onCloseProject}>
            <Power size={14} />
            <span>关闭项目</span>
          </button>
        </>
      )}
    </div>
  );
}
export function App() {
  const callWorker = projectWorker();
  const [health, setHealth] = useState<HealthResult>();
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [sqlite, setSqlite] = useState<SqliteProbeResult>();
  const [state, setState] = useState<CheckState>('checking');
  const [error, setError] = useState('');
  const [leftOpen, setLeftOpen] = useState(true);
  const [project, setProject] = useState<ProjectInfo>();
  const [recentProjects, setRecentProjects] = useState<RecentProjectInfo[]>([]);
  const [projectName, setProjectName] = useState('我的短剧');
  const [projectPath, setProjectPath] = useState('');
  const [projectMessage, setProjectMessage] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [projectRenameOpen, setProjectRenameOpen] = useState(false);
  const [projectRenameValue, setProjectRenameValue] = useState('');
  const [projectRenameBusy, setProjectRenameBusy] = useState(false);
  const [projectRenameError, setProjectRenameError] = useState('');
  const [projectCreateOpen, setProjectCreateOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [startupLoaded, setStartupLoaded] = useState(false);
  const projectPickerRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerSettingsRevision, setProviderSettingsRevision] = useState(0);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage>('providers');
  const [providerSettingsFocusId, setProviderSettingsFocusId] = useState<string>();
  const [assetTrashRequest, setAssetTrashRequest] = useState(0);
  const [assetLibraryFocusRevision, setAssetLibraryFocusRevision] = useState(0);
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('project');
  const workspaceMainRef = useRef<HTMLElement>(null);
  const [workspaceWidth, setWorkspaceWidth] = useState(() =>
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  const [view, setView] = useState<WorkspaceView>('documents');
  const [roughCutProjectId, setRoughCutProjectId] = useState<string>();
  const [roughCutImport, setRoughCutImport] = useState<RoughCutImportRequest>();
  const roughCutImportToken = useRef(0);
  const [documentKindFilter, setDocumentKindFilter] = useState<'all' | DocumentKind>('all');
  const [documentDirectoryMode, setDocumentDirectoryMode] = useState<'active' | 'archived'>(
    'active',
  );
  const [editingDocumentTitleId, setEditingDocumentTitleId] = useState<string | null>(null);
  const [detachedPanels, setDetachedPanels] = useState<Partial<Record<DetachedPanelId, string>>>(
    {},
  );
  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  const [shotReferenceDocuments, setShotReferenceDocuments] = useState<
    Record<string, ShotReferenceDocumentIds>
  >({});
  const [scene, setScene] = useState<SceneInfo>();
  const activeSceneIdRef = useRef(scene?.id);
  activeSceneIdRef.current = scene?.id;
  const [proposalRefreshRevision, setProposalRefreshRevision] = useState(0);
  const [sceneVideoPrompt, setSceneVideoPrompt] = useState('');
  const [shots, setShots] = useState<ShotInfo[]>([]);
  const [shot, setShot] = useState<ShotInfo>();
  const activeShotIdRef = useRef(shot?.id);
  activeShotIdRef.current = shot?.id;
  const [shotPrompt, setShotPrompt] = useState('');
  const [constraints, setConstraints] = useState<ConstraintInfo[]>([]);
  const [shotStoryboard, setShotStoryboard] = useState<DocumentDetail>();
  const [shotStoryboardTitle, setShotStoryboardTitle] = useState('');
  const [shotStoryboardContent, setShotStoryboardContent] = useState('');
  const [shotStoryboardBusy, setShotStoryboardBusy] = useState(false);
  const shotStoryboardRequest = useRef(0);
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [composer, setComposer] = useState('');
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [chatAttachmentsPending, setChatAttachmentsPending] = useState(false);
  const chatAttachmentsRef = useRef(chatAttachments);
  chatAttachmentsRef.current = chatAttachments;
  const chatAttachmentRevision = useRef(0);
  const chatAttachmentQueue = useRef(Promise.resolve());
  const clearChatAttachments = () => {
    chatAttachmentRevision.current += 1;
    chatAttachmentQueue.current = Promise.resolve();
    chatAttachmentsRef.current = [];
    setChatAttachments([]);
    setChatAttachmentsPending(false);
  };
  const [chatMessage, setChatMessage] = useState('');
  const [productionSkillBusy, setProductionSkillBusy] = useState(false);
  const productionSkillPending = useRef(false);
  const [agentModelSelection, setAgentModelSelection] = useState<
    UnifiedAgentModelSelectionRequest & {
      composerPrompt?: string;
    }
  >();
  const [agentModelPreferences, setAgentModelPreferences] = useState<
    Record<
      string,
      Partial<
        Record<
          UnifiedAgentCapability,
          {
            providerProfileId: string;
            modelId: string;
          }
        >
      >
    >
  >(initialAgentModelPreferences);
  const [agentParameterRequest, setAgentParameterRequest] = useState<{
    prompt: string;
    composerPrompt: string;
    capability: 'image' | 'video';
    providerProfileId: string;
    modelId: string;
    modelName: string;
    adapters: AdapterDescriptor[];
    affectsCost: boolean;
    referenceImageInputs?: string[];
  }>();
  const [contextPreview, setContextPreview] = useState<ProductionContextInfo>();
  const [llmStatus, setLlmStatus] = useState<LlmStatusResult>();
  const [initialLlmSelectionValue] = useState(initialLlmSelection);
  const [llmProfiles, setLlmProfiles] = useState<ProviderProfileInfo[]>([]);
  const [llmModels, setLlmModels] = useState<ProviderModelInfo[]>([]);
  const [selectedLlmProfileId, setSelectedLlmProfileId] = useState(
    initialLlmSelectionValue.providerProfileId ?? '',
  );
  const [selectedLlmModelId, setSelectedLlmModelId] = useState(
    initialLlmSelectionValue.modelId ?? '',
  );
  const [researchMode, setResearchMode] = useState<AgentResearchMode>(initialResearchMode);
  const [generation, setGeneration] = useState<LlmGenerationInfo>();
  const [agentTask, setAgentTask] = useState<import('@ai-video/contracts').AgentTaskDetail>();
  const [conversationAgentTasks, setConversationAgentTasks] = useState<
    import('@ai-video/contracts').AgentTaskDetail[]
  >([]);
  const [liveAgentActions, setLiveAgentActions] = useState<ConversationRuntimeLiveAction[]>([]);
  const lastGenerationErrorRef = useRef<string | undefined>(undefined);
  const [confirmationItems, setConfirmationItems] = useState<TaskConfirmation[]>([]);
  const confirmationQueue = useRef<TaskConfirmationQueue | undefined>(undefined);
  if (!confirmationQueue.current)
    confirmationQueue.current = new TaskConfirmationQueue(setConfirmationItems);
  const currentConfirmation = confirmationItems[0];
  const requestMediaSubmissionApproval = (confirmation: MediaSubmissionConfirmationRequest) =>
    confirmationQueue.current!.request(
      `media:${confirmation.jobId}`,
      project?.name ?? '项目',
      'paid',
      confirmation,
    );
  const activeMediaInputsRef = useRef<string[]>([]);
  const nativeRuns = useRef(
    new Map<
      string,
      {
        run: LlmStreamRun;
        state: LlmGenerationInfo;
        taskId?: string;
        actions: ConversationRuntimeLiveAction[];
      }
    >(),
  );
  const retryRequestsRef = useRef(new Set<string>());
  const pendingMessageRequestsRef = useRef(new Set<string>());
  const projectActionRequest = useRef(0);
  const projectContentRequest = useRef(0);
  const generationPollVersion = useRef(0);
  const generationPollOwner = useRef({
    projectId: undefined as string | undefined,
    conversationId: undefined as string | undefined,
    generationId: undefined as string | undefined,
  });
  const agentTaskEventPollRef = useRef<
    | {
        version: number;
        taskId: string;
        timer?: number;
        afterSequence: number;
      }
    | undefined
  >(undefined);
  const sceneRequest = useRef(0);
  const detachedSnapshotRef = useRef<Record<string, DetachedPanelSnapshot>>({});
  const detachedRegistryRef = useRef<Record<string, DetachedPanelRegistration>>({});
  const detachedPanelsRef = useRef<Partial<Record<DetachedPanelId, string>>>({});
  const detachedActionSequenceRef = useRef<Record<string, number>>({});
  const detachedActionHandlerRef = useRef<
    (action: DetachedPanelAction, label: string, envelope: DetachedPanelEnvelope<unknown>) => void
  >(() => undefined);
  detachedPanelsRef.current = detachedPanels;
  const writable = project?.mode === 'read-write';
  const { layout: workspaceLayout, dispatch: workspaceDispatch } = useWorkspaceLayout(project?.id);
  const conversationWindowOptions = {
    panel: workspaceLayout.panels.conversation,
    detached: Boolean(detachedPanels.conversation),
    productionOpen: navigationMode === 'production',
    assetsOpen:
      workspaceLayout.panels.assets.open && workspaceLayout.panels.assets.mode === 'docked',
    viewportWidth: workspaceWidth,
    activePanelId: workspaceLayout.activePanelId,
  };
  const conversationWindowPresented = isConversationWindowPresented(conversationWindowOptions);
  const conversationToggleCopy = conversationWindowToggleLabel(conversationWindowOptions);
  useEffect(() => {
    const update = () => {
      setWorkspaceWidth(workspaceMainRef.current?.clientWidth || window.innerWidth);
    };
    update();
    const element = workspaceMainRef.current;
    if (!element || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', update);
      return () => window.removeEventListener('resize', update);
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const toggleConversationWindow = () => {
    const action = conversationWindowToggleAction(conversationWindowOptions);
    if (action === 'focus-detached') {
      void focusDetachedPanelWindow(detachedPanels.conversation);
      return;
    }
    if (action === 'close') {
      workspaceDispatch({ type: 'close', panelId: 'conversation' });
      return;
    }
    if (action === 'float') {
      workspaceDispatch({ type: 'float', panelId: 'conversation' });
      return;
    }
    workspaceDispatch({ type: 'open', panelId: 'conversation' });
  };
  const syncDetachedPanelForEntity = (panelId: DetachedPanelId, entityId?: string) => {
    const label = Object.values(detachedRegistryRef.current).find(
      (registration) =>
        registration.config.panelId === panelId &&
        registration.config.projectId === project?.id &&
        registration.config.entityId === entityId,
    )?.config.label;
    setDetachedPanels((current) => {
      if (current[panelId] === label) return current;
      const next = { ...current };
      if (label) next[panelId] = label;
      else delete next[panelId];
      return next;
    });
  };
  const closeDetachedPanelForEntity = (panelId: DetachedPanelId, entityId: string) => {
    const registration = Object.values(detachedRegistryRef.current).find(
      (item) =>
        item.config.panelId === panelId &&
        item.config.projectId === project?.id &&
        item.config.entityId === entityId,
    );
    if (!registration) return;
    const { label } = registration.config;
    delete detachedRegistryRef.current[label];
    delete detachedSnapshotRef.current[label];
    delete detachedActionSequenceRef.current[label];
    setDetachedPanels((current) => {
      if (current[panelId] !== label) return current;
      const next = { ...current };
      delete next[panelId];
      return next;
    });
    void closeDetachedPanelWindow(label).catch(() => undefined);
  };
  const openDocumentWorkspace = (kind?: DocumentKind) => {
    const nextView =
      kind && CHARACTER_DOCUMENT_KINDS.includes(kind)
        ? 'characters'
        : kind && SCRIPT_DOCUMENT_KINDS.includes(kind)
          ? 'documents'
          : view === 'characters' || view === 'documents'
            ? view
            : 'documents';
    openProjectView(nextView);
  };
  const openProjectView = (nextView: WorkspaceView | 'assets', assetId?: string) => {
    if (nextView === 'rough-cut') {
      setNavigationMode('project');
      setRoughCutProjectId(project?.id);
      workspaceDispatch({ type: 'dock', panelId: 'assets' });
      workspaceDispatch({ type: 'dock', panelId: 'document' });
      workspaceDispatch({ type: 'close', panelId: 'conversation' });
    }
    if (nextView === 'assets') {
      if (assetId) {
        setAssetLibrarySelectedId(assetId);
        setAssetLibraryFocusRevision((revision) => revision + 1);
      }
      workspaceDispatch({ type: 'open', panelId: 'assets' });
      return;
    }
    if (nextView === 'documents' && detachedPanels.document) {
      setView('documents');
      void focusDetachedPanelWindow(detachedPanels.document);
      return;
    }
    setView(nextView);
    workspaceDispatch({ type: 'open', panelId: 'document' });
  };
  /** Routes a completed Agent chapter artifact to the novel editor. */
  const focusNovelArtifact = (
    detail: import('@ai-video/contracts').AgentTaskDetail | undefined,
    expectedProjectId: string,
  ): boolean => {
    if (
      !detail ||
      detail.target?.targetKind !== 'novel-chapter' ||
      !detail.target.chapterId ||
      !detail.target.documentVersionId ||
      detail.documents.at(-1)?.documentId !== detail.target.documentId ||
      detail.documents.at(-1)?.documentVersionId !== detail.target.documentVersionId ||
      activeProjectIdRef.current !== expectedProjectId
    ) {
      return false;
    }
    if (activeProjectIdRef.current !== expectedProjectId) return false;
    setNovelFocusChapterId(detail.target.chapterId);
    setNovelFocusReferenceId(undefined);
    setNovelRefreshRevision((revision) => revision + 1);
    openProjectView('novel');
    return true;
  };
  const docs = useDocumentWorkspace({
    writable,
    syncDetachedPanel: (entityId) => syncDetachedPanelForEntity('document', entityId),
    closeDetachedPanel: (entityId) => closeDetachedPanelForEntity('document', entityId),
    openDocumentWorkspace,
    closeDocumentPanel: () => workspaceDispatch({ type: 'close', panelId: 'document' }),
  });
  const {
    documents,
    archivedDocuments,
    document,
    documentTitle,
    documentKind,
    documentContent,
    documentBindings,
    setDocumentBindings,
    documentSampleText,
    setDocumentSampleText,
    versions,
    contentBusy,
    setContentBusy,
    contentMessage,
    documentCloseConfirmation,
    documentArchiveConfirmation,
    documentArchiveTarget,
    documentDirty,
    characterVoicePrompt,
    documentEditorWritable,
    setDocuments,
    setDocumentKind,
    setDocumentTitle,
    setDocumentContent,
    setContentMessage,
    setDocumentCloseConfirmation,
    setDocumentArchiveConfirmation,
    setDocumentArchiveTarget,
    openDocumentById: openNonChapterDocumentById,
    newDocument,
    importMarkdownDocument,
    saveDocument,
    requestArchiveDocument,
    confirmArchiveDocument,
    restoreArchivedDocument,
    requestDocumentChanges,
    publishDocument,
    unpublishDocument,
    saveAndPublishDocument,
    restoreVersion,
    requestCloseDocument,
    discardDocumentChanges,
    saveAndCloseDocument,
    syncMainDocumentIfSelected,
    reset: resetDocumentWorkspace,
  } = docs;
  const voiceDesignKey = `${project?.id ?? ''}:${workerScope()?.projectSessionId ?? ''}:${view}:${document?.id ?? ''}:${documentBindings?.voiceDocumentId ?? ''}`;
  const currentVoiceDesignKey = useRef(voiceDesignKey);
  currentVoiceDesignKey.current = voiceDesignKey;
  const [voiceDesignTarget, setVoiceDesignTarget] = useState<{
    key: string;
    character: DocumentDetail;
  }>();
  useEffect(() => {
    setVoiceDesignTarget(undefined);
  }, [voiceDesignKey]);
  const activeVoiceDesign =
    voiceDesignTarget?.key === voiceDesignKey ? voiceDesignTarget : undefined;
  const openVoiceDesign = async () => {
    if (
      !project ||
      !document ||
      documentKind !== 'character' ||
      !documentEditorWritable ||
      contentBusy ||
      !documentBindings?.voiceDocumentId
    )
      return;
    const key = voiceDesignKey;
    const saved = documentDirty ? await saveDocument() : document;
    if (saved && key === currentVoiceDesignKey.current) {
      setProductionSeed(undefined);
      setProductionCapability('TEXT_TO_AUDIO');
      setVoiceDesignTarget({ key, character: saved });
    }
  };
  const characterSceneReferenceKey = `${project?.id ?? ''}:${document?.id ?? ''}:${documentKind}`;
  const [characterSceneReference, setCharacterSceneReference] = useState<{
    key: string;
    options: SceneReferenceImageOptions;
  }>({ key: '', options: {} });
  const activeCharacterSceneReference =
    characterSceneReference.key === characterSceneReferenceKey
      ? characterSceneReference.options
      : {};
  const openDocumentById = async (
    documentId: string,
    nonChapterDocuments: DocumentSummary[] = documents,
  ) => {
    const projectId = project?.id;
    const reference = nonChapterDocuments.find((item) => item.id === documentId);
    {
      try {
        const chapters = await callWorker('novel.chapter.list', { includeArchived: true });
        if (activeProjectIdRef.current !== projectId) return;
        const chapter = chapters.find((item) => item.documentId === documentId);
        if (chapter) {
          setNovelFocusReferenceId(undefined);
          setNovelFocusChapterId(chapter.id);
          setNovelRefreshRevision((revision) => revision + 1);
          openProjectView('novel');
          return;
        }
      } catch (reason) {
        if (activeProjectIdRef.current === projectId) {
          setContentMessage(reason instanceof Error ? reason.message : '文档所属页面读取失败');
        }
        return;
      }
    }
    if (reference?.domainScope === 'novel') {
      setNovelFocusReferenceId(documentId);
      setNovelFocusChapterId(undefined);
      setNovelRefreshRevision((revision) => revision + 1);
      openProjectView('novel');
      return;
    }
    if (!reference) {
      const detail = await callWorker('document.get', { documentId });
      if (activeProjectIdRef.current !== projectId) return;
      if (detail.domainScope === 'novel') {
        setNovelFocusReferenceId(documentId);
        setNovelFocusChapterId(undefined);
        setDocuments((rows) =>
          rows.some((row) => row.id === documentId) ? rows : [...rows, detail],
        );
        setNovelRefreshRevision((revision) => revision + 1);
        openProjectView('novel');
        return;
      }
    }
    await openNonChapterDocumentById(documentId);
  };
  const openWorkspaceForDocumentKind = (kind: DocumentKind) => {
    if (CHARACTER_DOCUMENT_KINDS.includes(kind)) openProjectView('characters');
    else if (kind === 'storyboard') openProjectView('shots');
    else openProjectView('documents');
  };
  const openLibrarySource = (source: AgentLibrarySourceInfo) => {
    if (source.sourceType === 'novel-chapter') {
      setNovelFocusChapterId(source.sourceId);
      setNovelFocusReferenceId(undefined);
      setNovelRefreshRevision((revision) => revision + 1);
      openProjectView('novel');
      return;
    }
    if (source.sourceType === 'novel-reference') {
      void openDocumentById(source.sourceId);
      return;
    }
    if (source.sourceType === 'document' || source.sourceType === 'storyboard') {
      void openDocumentById(source.sourceId);
      return;
    }
    if (source.sourceType === 'asset') {
      openProjectView('assets', source.sourceId);
      return;
    }
    if (source.sourceType === 'scene' || source.sourceType === 'shot') {
      openProjectView('shots');
      return;
    }
    openProjectView('tasks');
  };
  const openReviewTarget = async (projectId: string, target: AgentTaskReviewTargetInfo) => {
    if (activeProjectIdRef.current !== projectId) return;
    if (target.kind === 'document') {
      try {
        await openDocumentById(target.id);
      } catch (reason) {
        if (activeProjectIdRef.current === projectId)
          setContentMessage(reason instanceof Error ? reason.message : '正文打开失败');
      }
      return;
    }
    // Navigation must not replace a local unsaved production edit.
    const dirty =
      sceneVideoPrompt !== (scene?.prompt ?? '') ||
      (shot &&
        (shotPrompt !== (shot.prompt ?? '') ||
          shotStoryboardTitle !== (shotStoryboard?.title ?? '') ||
          shotStoryboardContent !== (shotStoryboard?.currentVersion?.contentMarkdown ?? '')));
    if (dirty) {
      setContentMessage('当前场次或镜头有未保存编辑，请先保存后再打开核对正文。');
      return;
    }
    const requestId = ++sceneRequest.current;
    const editor = productionEditor.current;
    try {
      const nextScenes = await callWorker('scene.list', {});
      const selected = nextScenes.find(
        (item) => item.id === (target.kind === 'scene' ? target.id : target.sceneId),
      );
      if (requestId !== sceneRequest.current || activeProjectIdRef.current !== projectId) return;
      if (!selected) {
        setContentMessage('该核对对象已不存在或已归档。');
        return;
      }
      const nextShots = await callWorker('shot.list', { sceneId: selected.id });
      if (requestId !== sceneRequest.current || activeProjectIdRef.current !== projectId) return;
      const selectedShot =
        target.kind === 'shot' ? nextShots.find((item) => item.id === target.id) : undefined;
      if (target.kind === 'shot' && !selectedShot) {
        setContentMessage('该镜头已不存在或已归档。');
        return;
      }
      // Edits made while the read was in flight also retain ownership.
      if (
        productionEditor.current.scene?.id !== editor.scene?.id ||
        productionEditor.current.shot?.id !== editor.shot?.id ||
        productionEditor.current.sceneVideoPrompt !== editor.sceneVideoPrompt ||
        productionEditor.current.shotPrompt !== editor.shotPrompt ||
        productionEditor.current.shotStoryboardTitle !== editor.shotStoryboardTitle ||
        productionEditor.current.shotStoryboardContent !== editor.shotStoryboardContent
      ) {
        setContentMessage('当前有未保存编辑，请先保存后再打开核对正文。');
        return;
      }
      setScenes(nextScenes);
      setScene(selected);
      setSceneVideoPrompt(selected.prompt ?? '');
      setShots(nextShots);
      setShot(selectedShot);
      openProjectView('shots');
    } catch (reason) {
      if (requestId === sceneRequest.current && activeProjectIdRef.current === projectId)
        setContentMessage(reason instanceof Error ? reason.message : '核对正文打开失败');
    }
  };
  const requestCloseEditor = () => {
    if ((view === 'documents' || view === 'characters') && !hasForeignDocument) {
      requestCloseDocument();
      return;
    }
    workspaceDispatch({ type: 'close', panelId: 'document' });
  };
  const assetWorkspace = useAssetWorkspace({
    scenes,
    setScene: (scene) => setScene(scene),
    setShots: (shots) => setShots(shots),
    setShot: (shot) => setShot(shot),
    setNavigationMode,
    setContentMessage,
  });
  const {
    assets,
    setAssets,
    setAsset,
    assetLibrarySelectedId,
    setAssetLibrarySelectedId,
    focusedSource,
    updateAssets,
    openAssetSource,
    reset: resetAssetWorkspace,
  } = assetWorkspace;
  const projectTasks = useProjectTaskSubscription(project?.id);
  const observedProjectTasks = useRef<
    | {
        projectSessionId: string;
        statuses: Map<string, string>;
      }
    | undefined
  >(undefined);
  const activeProjectIdRef = useRef(project?.id);
  const [taskCompletionRevision, setTaskCompletionRevision] = useState(0);
  const [novelFocusChapterId, setNovelFocusChapterId] = useState<string>();
  const [novelFocusReferenceId, setNovelFocusReferenceId] = useState<string>();
  const [novelRefreshRevision, setNovelRefreshRevision] = useState(0);
  activeProjectIdRef.current = project?.id;
  useEffect(() => {
    if (!projectTasks) return;
    const previous = observedProjectTasks.current;
    const newSession = previous?.projectSessionId !== projectTasks.projectSessionId;
    const mediaJobs = [...projectTasks.videoJobs, ...(projectTasks.imageJobs ?? [])];
    const statuses = new Map(mediaJobs.map((job) => [job.id, job.status]));
    const terminalTransitions = newSession
      ? []
      : mediaJobs.filter((job) => {
          const previousStatus = previous.statuses.get(job.id);
          return (
            TERMINAL_VIDEO_STATUSES.has(job.status) &&
            (previousStatus === undefined || !TERMINAL_VIDEO_STATUSES.has(previousStatus))
          );
        });
    observedProjectTasks.current = { projectSessionId: projectTasks.projectSessionId, statuses };
    for (const job of terminalTransitions)
      if (projectTasks.videoJobs.some((video) => video.id === job.id))
        notifyVideoTerminal(job as VideoGenerationJobInfo);
    const missingInitialAsset =
      newSession &&
      mediaJobs.some(
        (job) =>
          job.status === 'succeeded' &&
          job.results.some(
            (result) => result.asset && !assets.some((asset) => asset.id === result.asset!.id),
          ),
      );
    if (!missingInitialAsset && !terminalTransitions.some((job) => job.status === 'succeeded')) {
      return;
    }
    const expectedProjectId = projectTasks.projectId;
    setTaskCompletionRevision((revision) => revision + 1);
    void callWorker('asset.list', {})
      .then((items) => {
        if (activeProjectIdRef.current === expectedProjectId) updateAssets(items);
      })
      .catch(() => undefined);
  }, [projectTasks]);
  const productionWorkspace = useProductionState({ setNavigationMode });
  const { productionCapability } = productionWorkspace;
  const setProductionCapability = (capability: typeof productionCapability) => {
    setVoiceDesignTarget(undefined);
    productionWorkspace.setProductionCapability(capability);
  };
  const [productionSeed, setProductionSeed] = useState<{
    documentId?: string;
    shotId?: string;
    sceneId?: string;
    prompt?: string;
    seedParameters?: import('@ai-video/contracts').AdapterParameters;
    audioReference?: {
      characterDocumentId: string;
      expectedVoiceVersionId: string;
      providerProfileId: string;
      model: string;
    };
    assetKind?: 'character' | 'scene' | 'prop' | 'first-frame';
    images?: string[];
    referenceBindings?: import('@ai-video/contracts').SceneMaterialBindingInfo[];
    inputImages?: import('@ai-video/contracts').ProductionImageSelection[];
    continuityRevision?: number;
  }>();
  const linkedAssetSourceKey = `${project?.id}:${document?.id}`;
  const [linkedAssetState, setLinkedAssetState] = useState<{
    key: string;
    items: AssetInfo[];
  }>({ key: '', items: [] });
  const linkedAssets = linkedAssetState.key === linkedAssetSourceKey ? linkedAssetState.items : [];
  useEffect(() => {
    if (view !== 'characters' || !document?.id) {
      setLinkedAssetState({ key: linkedAssetSourceKey, items: [] });
      return;
    }
    const documentId = document.id;
    let active = true;
    void callWorker('asset.list', {
      sourceDocumentId: documentId,
      sort: 'created-desc',
      limit: 60,
    })
      .then((items) => {
        if (active) setLinkedAssetState({ key: linkedAssetSourceKey, items });
      })
      .catch(() => {
        if (active) setLinkedAssetState({ key: linkedAssetSourceKey, items: [] });
      });
    return () => {
      active = false;
    };
  }, [view, document?.id, linkedAssetSourceKey, taskCompletionRevision, assets]);
  const closeSettings = () => {
    setSettingsOpen(false);
    setProviderSettingsFocusId(undefined);
    setProviderSettingsRevision((revision) => revision + 1);
  };
  // A conversation is the project-wide Agent workspace. Scene/shot ownership
  // remains an internal entity attribute, never a user-selectable session
  // scope.
  const scopeType: ConversationScopeType = 'project';
  const scopeId = undefined;
  const scopeAvailable = Boolean(project);
  const selectedLlmProfile = llmProfiles.find((profile) => profile.id === selectedLlmProfileId);
  const selectedLlmModel = llmModels.find(
    (model) => model.id === selectedLlmModelId && model.providerProfileId === selectedLlmProfileId,
  );
  const managedLlmConfigured = Boolean(selectedLlmProfile && selectedLlmModel);
  const displayedLlmStatus: LlmStatusResult | undefined = managedLlmConfigured
    ? {
        provider: selectedLlmProfile?.name ?? 'LLM',
        model: selectedLlmModel?.displayName ?? '',
        configured: true,
        configurationSource: 'managed',
      }
    : llmProfiles.length > 0
      ? {
          provider: selectedLlmProfile?.name ?? llmProfiles[0]?.name ?? 'LLM',
          model: '',
          configured: false,
          configurationSource: 'managed',
        }
      : llmStatus;
  const loadLlmCatalog = async () => {
    try {
      const profiles = (await providerProfileClient.listProfiles()).filter(
        (profile) =>
          profile.enabled &&
          profile.connectionStatus === 'ready' &&
          (profile.category === 'llm' || profile.category === 'multi') &&
          (profile.protocol === 'openai-responses' ||
            profile.protocol === 'openai-chat-completions'),
      );
      const models = (
        await Promise.all(
          profiles.map((profile) =>
            providerProfileClient.listModels(profile.id).catch(() => [] as ProviderModelInfo[]),
          ),
        )
      )
        .flat()
        .filter(
          (model) =>
            model.enabled &&
            !model.unavailableAt &&
            model.capabilities.text &&
            model.capabilities.streaming &&
            model.capabilities.tools,
        );
      const currentProfile =
        profiles.find((profile) => profile.id === selectedLlmProfileId) ??
        profiles.find((profile) => models.some((model) => model.providerProfileId === profile.id));
      const currentModel = models.find(
        (model) =>
          model.id === selectedLlmModelId && model.providerProfileId === currentProfile?.id,
      );
      setLlmProfiles(profiles);
      setLlmModels(models);
      // Keep a ready profile so the model dropdown stays usable. Never silently
      // substitute another model when the stored selection is missing.
      setSelectedLlmProfileId(currentProfile?.id ?? '');
      setSelectedLlmModelId(currentModel?.id ?? '');
    } catch {
      setLlmProfiles([]);
      setLlmModels([]);
      setSelectedLlmProfileId('');
      setSelectedLlmModelId('');
    }
  };
  const nativeRunIsCurrent = (run: LlmStreamRun): boolean => {
    const owner = generationPollOwner.current;
    return (
      nativeRuns.current.get(run.identity.generationId)?.run === run &&
      owner.projectId === run.identity.projectId &&
      owner.conversationId === run.identity.conversationId &&
      owner.generationId === run.identity.generationId
    );
  };
  const agentResourceRefresh = useRef(new AgentResourceRefresh());
  const resourceRefreshCallbacks = useRef({
    documents: docs.refreshCommittedDocuments,
    production: async () => {},
  });
  resourceRefreshCallbacks.current = {
    documents: docs.refreshCommittedDocuments,
    production: async () => refreshProductionSources(),
  };
  const rememberAgentTask = (detail: import('@ai-video/contracts').AgentTaskDetail | undefined) => {
    setAgentTask(detail);
    if (!detail) return;
    setConversationAgentTasks((current) => upsertAgentTaskDetail(current, detail));
    if (detail.resourceChanges && detail.task.projectId === activeProjectIdRef.current) {
      const scopeKey = `${detail.task.projectId}:${workerScope()?.projectSessionId ?? ''}`;
      agentResourceRefresh.current.observe(
        scopeKey,
        detail.task.id,
        detail.resourceChanges,
        async (kind) => {
          if (scopeKey !== `${activeProjectIdRef.current}:${workerScope()?.projectSessionId ?? ''}`)
            throw new Error('Project session changed');
          if (kind === 'documentSequence') {
            await resourceRefreshCallbacks.current.documents();
            if (
              scopeKey === `${activeProjectIdRef.current}:${workerScope()?.projectSessionId ?? ''}`
            )
              window.dispatchEvent(
                new CustomEvent('novel-metadata-updated', {
                  detail: { projectId: detail.task.projectId },
                }),
              );
          } else await resourceRefreshCallbacks.current.production();
        },
      );
    }
  };
  const stopAgentTaskEventPolling = () => {
    const poll = agentTaskEventPollRef.current;
    if (poll?.timer !== undefined) window.clearInterval(poll.timer);
    agentTaskEventPollRef.current = undefined;
  };
  const startAgentTaskEventPolling = (taskId: string) => {
    stopAgentTaskEventPolling();
    const poll = {
      version: Date.now(),
      taskId,
      afterSequence: -1,
      timer: undefined as number | undefined,
    };
    agentTaskEventPollRef.current = poll;
    let requestPending = false;
    const readEvents = () => {
      if (requestPending || agentTaskEventPollRef.current !== poll) return;
      requestPending = true;
      void Promise.resolve()
        .then(() =>
          callWorker('agent.task.events', {
            taskId,
            afterSequence: poll.afterSequence,
            limit: 100,
          }),
        )
        .then(async (result) => {
          if (agentTaskEventPollRef.current !== poll) return;
          await callWorker('agent.task.get', { taskId })
            .then((detail) => {
              const current = agentTaskEventPollRef.current;
              if (current !== poll) return;
              rememberAgentTask(detail);
            })
            .catch(() => undefined);
          if (agentTaskEventPollRef.current !== poll) return;
          poll.afterSequence = result.nextSequence;
          const latest = result.events.at(-1);
          if (latest?.level === 'error') {
            setChatMessage(readableGenerationError(latest.summary) ?? latest.summary);
          }
          if (['completed', 'failed', 'cancelled'].includes(result.task.status)) {
            const failedMessage =
              readableGenerationError(lastGenerationErrorRef.current) ??
              readableGenerationError(result.task.errorMessage);
            if (failedMessage) setChatMessage(failedMessage);
            stopAgentTaskEventPolling();
          }
        })
        .catch(() => undefined)
        .finally(() => {
          requestPending = false;
        });
    };
    readEvents();
    poll.timer = window.setInterval(readEvents, 400);
  };
  const launchPreparedGeneration = (
    prepared: LlmGenerationPrepareResult,
    includeAttachments = true,
    observeOnly = false,
  ): Promise<void> => {
    const previous = nativeRuns.current.get(prepared.stream.generationId);
    if (previous) return previous.run.completion;
    const callWorker = projectWorker({
      projectId: prepared.stream.projectId,
      projectSessionId: prepared.stream.projectSessionId,
    });
    const isVisible = () =>
      generationPollOwner.current.projectId === prepared.stream.projectId &&
      generationPollOwner.current.conversationId === prepared.stream.conversationId;
    const referenceImageInputs = includeAttachments
      ? collectReferenceImageInputs(chatAttachments)
      : [];
    if (isVisible()) {
      activeMediaInputsRef.current = referenceImageInputs;
      if (includeAttachments) clearChatAttachments();
    }
    const agentTaskId =
      'agentTaskId' in prepared && typeof prepared.agentTaskId === 'string'
        ? prepared.agentTaskId
        : undefined;
    const isAgentGeneration = agentTaskId !== undefined;
    if (isVisible()) {
      lastGenerationErrorRef.current = undefined;
      setChatMessage('');
      setLiveAgentActions([]);
      if (agentTaskId) {
        setAgentTask(undefined);
        startAgentTaskEventPolling(agentTaskId);
      } else {
        stopAgentTaskEventPolling();
      }
    }
    const previousDocumentIds = new Set(documents.map((item) => item.id));
    let agentDocumentRefreshStarted = false;
    const refreshAgentDocuments = () => {
      if (!isAgentGeneration || agentDocumentRefreshStarted || !isVisible()) return;
      agentDocumentRefreshStarted = true;
      const projectId = prepared.stream.projectId;
      const refreshDocumentList = (artifactDocumentId?: string, verifiedTask = false) =>
        callWorker('document.list', {}).then((nextDocuments) => {
          if (activeProjectIdRef.current && activeProjectIdRef.current !== projectId) return;
          setDocuments(nextDocuments);
          const created = nextDocuments.filter((item) =>
            verifiedTask ? item.id === artifactDocumentId : !previousDocumentIds.has(item.id),
          );
          const createdWorkspace = created.filter(isWorkspaceDocument);
          const createdWorkspaceDocument = createdWorkspace[0];
          if (createdWorkspace.length === 1 && createdWorkspaceDocument) {
            openWorkspaceForDocumentKind(createdWorkspaceDocument.kind);
            setDocumentKindFilter(createdWorkspaceDocument.kind);
          } else if (createdWorkspace.length > 1) {
            openProjectView('documents');
            setDocumentKindFilter('all');
          }
          const createdDocument = verifiedTask
            ? nextDocuments.find((item) => item.id === artifactDocumentId)
            : (createdWorkspaceDocument ?? created[0]);
          if (createdDocument) void openDocumentById(createdDocument.id, nextDocuments);
        });
      void callWorker('agent.task.get', { taskId: agentTaskId })
        .catch(() => undefined)
        .then(async (detail) => {
          if (activeProjectIdRef.current && activeProjectIdRef.current !== projectId) return;
          if (detail) {
            rememberAgentTask(detail);
            if (detail.novelMetadataUpdated)
              window.dispatchEvent(
                new CustomEvent('novel-metadata-updated', { detail: { projectId } }),
              );
            if (detail.productionUpdated)
              window.dispatchEvent(
                new CustomEvent('production-source-updated', { detail: { agent: true } }),
              );
            const proposal = detail.changeSets?.at(-1);
            const lastDocument = detail.documents.at(-1);
            if (proposal && (!lastDocument || proposal.createdAt >= lastDocument.createdAt)) {
              const nextDocuments = await callWorker('document.list', {});
              if (activeProjectIdRef.current !== projectId) return;
              setDocuments(nextDocuments);
              setProposalRefreshRevision((revision) => revision + 1);
              if (proposal.status === 'applied')
                await refreshAppliedStructure(proposal.changeSetId);
              if (activeProjectIdRef.current !== projectId) return;
              openProjectView('shots');
              setChatMessage(
                proposal.status === 'proposed' || proposal.status === 'partially_applied'
                  ? '正在将场次与镜头保存为草稿。'
                  : proposal.status === 'applied'
                    ? '场次与镜头已保存为草稿，可随时修改提示词和绑定。'
                    : '场次与镜头未保存，请读取最新内容后重试。',
              );
              return;
            }
            if (focusNovelArtifact(detail, projectId)) return;
            return refreshDocumentList(detail.documents.at(-1)?.documentId, true);
          }
          return refreshDocumentList();
        })
        .catch((reason) => {
          if (generationPollOwner.current.projectId === projectId) {
            setContentMessage(reason instanceof Error ? reason.message : '文档列表刷新失败');
          }
        });
    };
    if (isVisible()) {
      setGeneration(prepared.generation);
      setMessages((current) => {
        const withoutAssistant = current.filter(
          (message) => message.id !== prepared.generation.assistantMessage.id,
        );
        return [
          ...withoutAssistant,
          ...(withoutAssistant.some((message) => message.id === prepared.generation.userMessage.id)
            ? []
            : [prepared.generation.userMessage]),
          prepared.generation.assistantMessage,
        ];
      });
    }
    if (!isGenerationActive(prepared.generation)) {
      if (isVisible()) setChatMessage(generationStatusMessage(prepared.generation));
      refreshAgentDocuments();
      return Promise.resolve();
    }
    const run = streamPreparedLlmGeneration(
      prepared,
      {
        onLiveActions(actions) {
          const entry = nativeRuns.current.get(run.identity.generationId);
          if (entry) entry.actions = actions;
          if (!nativeRunIsCurrent(run)) return;
          setLiveAgentActions(actions);
        },
        onDelta(content) {
          const entry = nativeRuns.current.get(run.identity.generationId);
          if (!entry || entry.run !== run) return;
          const next: LlmGenerationInfo = {
            ...prepared.generation,
            status: 'streaming',
            assistantMessage: {
              ...prepared.generation.assistantMessage,
              content,
              status: 'streaming',
            },
          };
          entry.state = next;
          if (!isVisible()) return;
          setGeneration((current) =>
            current?.generationId === next.generationId ? { ...current, ...next } : current,
          );
          setMessages((current) =>
            mergeGenerationMessage(current, run.identity.conversationId, next),
          );
        },
        onState(next) {
          const entry = nativeRuns.current.get(run.identity.generationId);
          if (!entry || entry.run !== run) return;
          entry.state = next;
          if (!isGenerationActive(next))
            confirmationQueue.current!.removeOwner(run.identity.generationId);
          if (!isVisible()) return;
          if (nativeRunIsCurrent(run)) setGeneration(next);
          setMessages((current) =>
            mergeGenerationMessage(current, run.identity.conversationId, next),
          );
          if (!isGenerationActive(next) && nativeRunIsCurrent(run)) {
            confirmationQueue.current!.removeOwner(prepared.stream.generationId);
            if (next.error) lastGenerationErrorRef.current = next.error;
            setChatMessage(generationStatusMessage(next));
            refreshAgentDocuments();
          }
        },
        onConfirmation(request) {
          return confirmationQueue.current!.request(
            prepared.stream.generationId,
            `${project?.name ?? '项目'} · ${prepared.stream.conversationId}`,
            'tool',
            request,
          );
        },
        onMediaSelection(request) {
          return confirmationQueue.current!.request(
            prepared.stream.generationId,
            `${project?.name ?? '项目'} · ${prepared.stream.conversationId}`,
            'model',
            request,
            referenceImageInputs,
            prepared.stream.projectId,
          );
        },
        onMediaSubmission(request) {
          return confirmationQueue.current!.request(
            prepared.stream.generationId,
            `${project?.name ?? '项目'} · ${prepared.stream.conversationId}`,
            'paid',
            request,
          );
        },
      },
      { observeOnly },
    );
    nativeRuns.current.set(run.identity.generationId, {
      run,
      state: prepared.generation,
      taskId: agentTaskId,
      actions: [],
    });
    return run.completion
      .catch((reason: unknown) => {
        if (nativeRunIsCurrent(run)) {
          setChatMessage(reason instanceof Error ? reason.message : '原生 LLM 流处理失败');
        }
      })
      .finally(async () => {
        if (isAgentGeneration && agentTaskId) {
          const detail = await callWorker('agent.task.get', { taskId: agentTaskId }).catch(
            () => undefined,
          );
          if (detail && isVisible()) {
            setConversationAgentTasks((current) => upsertAgentTaskDetail(current, detail));
            if (nativeRunIsCurrent(run)) setAgentTask(detail);
          }
        }
        if (nativeRunIsCurrent(run)) {
          stopAgentTaskEventPolling();
          setLiveAgentActions([]);
        }
        confirmationQueue.current!.removeOwner(run.identity.generationId);
        if (nativeRuns.current.get(run.identity.generationId)?.run === run) {
          nativeRuns.current.delete(run.identity.generationId);
          if (
            isVisible() &&
            generationPollOwner.current.generationId === run.identity.generationId
          ) {
            const other = [...nativeRuns.current.values()].find(
              (entry) =>
                entry.run.identity.projectId === run.identity.projectId &&
                entry.run.identity.conversationId === run.identity.conversationId,
            );
            if (other) setGeneration(other.state);
          }
        }
      });
  };
  const cancelNativeLlmRun = async (generationId = generation?.generationId) => {
    if (!generationId) return;
    const entry = nativeRuns.current.get(generationId);
    if (!entry) return;
    confirmationQueue.current!.removeOwner(generationId);
    await entry.run.cancel().catch(() => undefined);
  };
  const conversationWorkspace = useConversationWorkspace({
    projectId: project?.id,
    scopeAvailable,
    scopeType,
    scopeId,
    setMessages,
    setContextPreview,
    setChatMessage,
  });
  const {
    conversations,
    conversation,
    conversationNextCursor,
    showArchivedConversations,
    setShowArchivedConversations,
    conversationRequest,
    createConversation,
    renameConversation,
    archiveConversation,
    restoreConversation,
    loadMoreConversations,
    selectConversation,
    messageNextCursor,
    loadingEarlierMessages,
    loadEarlierMessages,
    reset: resetConversationWorkspace,
  } = conversationWorkspace;
  const attachmentContext = `${project?.id}:${workerScope(project?.id)?.projectSessionId}:${conversation?.id}`;
  const attachmentContextRef = useRef(attachmentContext);
  attachmentContextRef.current = attachmentContext;
  useEffect(() => {
    chatAttachmentRevision.current += 1;
    chatAttachmentQueue.current = Promise.resolve();
    chatAttachmentsRef.current = [];
    setChatAttachments([]);
    setChatAttachmentsPending(false);
    return () => {
      chatAttachmentRevision.current += 1;
    };
  }, [attachmentContext]);
  const conversationPromptTemplate = useConversationPromptTemplate(conversation);
  const saveConversationPromptTemplate = async () => {
    if (!conversation || conversation.archivedAt) return;
    try {
      await conversationPromptTemplate.saveForSubmission(conversation);
      if (generationPollOwner.current.conversationId === conversation.id)
        setChatMessage('本会话要求约束已保存。');
    } catch (reason) {
      if (generationPollOwner.current.conversationId === conversation.id)
        setChatMessage(reason instanceof Error ? reason.message : '会话约束保存失败');
    }
  };
  generationPollOwner.current = {
    projectId: project?.id,
    conversationId: conversation?.id,
    generationId: generation?.generationId,
  };
  const checkRuntime = async () => {
    setState('checking');
    setError('');
    try {
      const [healthResult, sqliteResult] = await Promise.all([
        callWorker('health', {}),
        callWorker('sqlite.probe', {}),
      ]);
      setHealth(healthResult);
      setSqlite(sqliteResult);
      setState('ready');
    } catch (reason) {
      setState('error');
      setError(reason instanceof Error ? reason.message : 'Worker 连接失败');
    }
  };
  const refreshShotReferenceDocuments = async (sceneRows: SceneInfo[]) => {
    const expectedProjectId = project?.id;
    const shotLists = await Promise.all(
      sceneRows.map(
        async (sceneRow) =>
          [sceneRow.id, await callWorker('shot.list', { sceneId: sceneRow.id })] as const,
      ),
    );
    if (!expectedProjectId || activeProjectIdRef.current !== expectedProjectId) return;
    setShotReferenceDocuments(shotReferenceDocumentIdsByScene(sceneRows, new Map(shotLists)));
  };
  const loadProjectContent = async () => {
    const callWorker = projectWorker();
    const requestId = ++projectContentRequest.current;
    try {
      const [documentList, sceneList, constraintList] = await Promise.all([
        callWorker('document.list', {}),
        callWorker('scene.list', {}),
        callWorker('constraint.list', {}),
      ]);
      const assetList = await callWorker('asset.list', {});
      const firstScene = sceneList[0];
      const shotList = firstScene ? await callWorker('shot.list', { sceneId: firstScene.id }) : [];
      const shotLists = new Map<string, ShotInfo[]>([[firstScene?.id ?? '', shotList]]);
      await Promise.all(
        sceneList
          .filter((sceneRow) => sceneRow.id !== firstScene?.id)
          .map(async (sceneRow) => {
            shotLists.set(sceneRow.id, await callWorker('shot.list', { sceneId: sceneRow.id }));
          }),
      );
      if (requestId !== projectContentRequest.current) return;
      setDocuments(documentList);
      setConstraints(constraintList);
      setScenes(sceneList);
      setShotReferenceDocuments(shotReferenceDocumentIdsByScene(sceneList, shotLists));
      setScene(firstScene);
      setSceneVideoPrompt(
        firstScene?.prompt?.trim()
          ? firstScene.prompt
          : firstScene && shotList.length > 0
            ? [
                `# 场次：${firstScene.title}`,
                '请生成一段完整、连续的视频，保持人物外观、服装、场景和光线一致。',
                ...shotList.map(
                  (item, index) =>
                    `${index + 1}. ${item.title}\n${item.prompt?.trim() || '补充该镜头的动作和画面。'}`,
                ),
              ].join('\n\n')
            : '',
      );
      setShots(shotList);
      setShot(undefined);
      setAssets(assetList);
      setAsset(assetList[0]);
    } catch (reason) {
      if (requestId === projectContentRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '项目内容加载失败');
      }
    }
  };
  useEffect(() => {
    if (project) void loadProjectContent();
  }, [project?.id, workerScope(project?.id)?.projectSessionId]);
  const ensureWorkerProjectSession = async (): Promise<boolean> => {
    if (!project?.rootPath) return false;
    const captured = workerScope(project.id);
    try {
      // This scoped read validates the epoch, independently of the globally active project.
      const current = await callWorker('project.current', {});
      if (current?.id === project.id) return true;
    } catch (reason) {
      if (
        !reason ||
        typeof reason !== 'object' ||
        !('workerError' in reason) ||
        (
          reason.workerError as {
            code?: string;
          }
        ).code !== 'STALE_SESSION'
      )
        throw reason;
      // The stale notification already started recovery; require a fresh user action.
      return false;
    }
    const attached = await callWorker('project.runtime.attach', {
      rootPath: project.rootPath,
      expectedProjectId: project.id,
    });
    if (!isCurrentWorkerScope(captured)) return false;
    selectWorkerScope({
      projectId: attached.project.id,
      projectSessionId: attached.projectSessionId,
    });
    setProject({ ...project });
    return true;
  };
  useEffect(() => {
    if (!project) return;
    let active = true;
    let pending = false;
    const recover = (event: Event) => {
      const scope = (event as CustomEvent<import('@ai-video/contracts').ProjectRuntimeScope>)
        .detail;
      if (
        !scope ||
        scope.projectId !== project.id ||
        !isCurrentWorkerScope(scope) ||
        pending ||
        projectBusy
      )
        return;
      pending = true;
      const action = projectActionRequest.current;
      setProjectMessage('本地服务已重新连接，正在恢复项目…');
      void callWorker('project.runtime.attach', {
        rootPath: project.rootPath,
        expectedProjectId: project.id,
      })
        .then((runtime) => {
          if (!active || action !== projectActionRequest.current || !isCurrentWorkerScope(scope))
            return;
          selectWorkerScope({
            projectId: runtime.project.id,
            projectSessionId: runtime.projectSessionId,
          });
          for (const [id, entry] of nativeRuns.current) {
            if (
              entry.run.identity.projectId === scope.projectId &&
              entry.run.identity.projectSessionId === scope.projectSessionId
            ) {
              entry.run.detach();
              confirmationQueue.current!.removeOwner(id);
              nativeRuns.current.delete(id);
            }
          }
          generationPollVersion.current += 1;
          stopAgentTaskEventPolling();
          setGeneration(undefined);
          setLiveAgentActions([]);
          setProject(runtime.project);
          setProjectMessage('项目连接已恢复。刚才失败的操作未自动重试，请检查后重新操作。');
        })
        .catch((reason) => {
          if (active && action === projectActionRequest.current)
            setProjectMessage(reason instanceof Error ? reason.message : '项目重新连接失败');
        })
        .finally(() => {
          pending = false;
        });
    };
    window.addEventListener(WORKER_SCOPE_STALE_EVENT, recover);
    return () => {
      active = false;
      window.removeEventListener(WORKER_SCOPE_STALE_EVENT, recover);
    };
  }, [project?.id, project?.rootPath, projectBusy]);
  useEffect(() => {
    void checkRuntime();
    void loadLlmCatalog();
    void callWorker('llm.status', {})
      .then(setLlmStatus)
      .catch(() => undefined);
    let savedView:
      | {
          projectId: string;
          rootPath: string;
        }
      | undefined;
    try {
      const value = JSON.parse(
        window.sessionStorage.getItem('ai-video.project-view') ?? 'null',
      ) as {
        projectId?: unknown;
        rootPath?: unknown;
      } | null;
      if (typeof value?.projectId === 'string' && typeof value.rootPath === 'string')
        savedView = { projectId: value.projectId, rootPath: value.rootPath };
    } catch {
      /* A malformed view hint cannot choose a project. */
    }
    const restoreView = savedView
      ? callWorker('project.runtime.attach', {
          rootPath: savedView.rootPath,
          expectedProjectId: savedView.projectId,
        }).then((runtime) => runtime.project)
      : callWorker('project.current', {});
    void Promise.all([restoreView, callWorker('project.recent', {})])
      .then(async ([current, recent]) => {
        if (current) {
          const runtime = ((await callWorker('project.runtime.list', {})) ?? []).find(
            (entry) => entry.project.id === current.id,
          );
          if (runtime)
            selectWorkerScope({
              projectId: runtime.project.id,
              projectSessionId: runtime.projectSessionId,
            });
        } else selectWorkerScope(undefined);
        setProject(current ?? undefined);
        setRecentProjects(recent);
      })
      .catch(() => undefined)
      .finally(() => setStartupLoaded(true));
  }, []);
  useEffect(() => {
    if (!startupLoaded) return;
    try {
      if (project)
        window.sessionStorage.setItem(
          'ai-video.project-view',
          JSON.stringify({ projectId: project.id, rootPath: project.rootPath }),
        );
      else window.sessionStorage.removeItem('ai-video.project-view');
    } catch {
      /* Window-local view recovery remains best effort. */
    }
  }, [startupLoaded, project?.id, project?.rootPath]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        AGENT_MODEL_PREFERENCES_STORAGE_KEY,
        JSON.stringify(agentModelPreferences),
      );
    } catch {
      // Local persistence is best effort; the active session remains authoritative.
    }
  }, [agentModelPreferences]);
  useEffect(() => {
    if (!isTauriRuntime()) return () => undefined;
    const window = getCurrentWindow();
    let active = true;
    const updateMaximized = () => {
      void window.isMaximized().then((maximized) => {
        if (active) setWindowMaximized(maximized);
      });
    };
    updateMaximized();
    const unlisten = window.onResized(updateMaximized);
    return () => {
      active = false;
      void unlisten.then((stop) => stop());
    };
  }, []);
  useEffect(() => {
    if (settingsOpen) return;
    void loadLlmCatalog();
  }, [settingsOpen]);
  useEffect(() => {
    if (!projectPickerOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!projectPickerRef.current?.contains(event.target as Node)) setProjectPickerOpen(false);
    };
    window.document.addEventListener('pointerdown', handlePointerDown);
    return () => window.document.removeEventListener('pointerdown', handlePointerDown);
  }, [projectPickerOpen]);
  useEffect(() => {
    try {
      window.localStorage.setItem(
        LLM_SELECTION_STORAGE_KEY,
        JSON.stringify({
          providerProfileId: selectedLlmProfileId || undefined,
          modelId: selectedLlmModelId || undefined,
          researchMode,
        }),
      );
    } catch {
      // The selection remains available for the current session when storage is unavailable.
    }
  }, [selectedLlmProfileId, selectedLlmModelId, researchMode]);
  useEffect(() => {
    const entry = [...nativeRuns.current.values()].find(
      (item) =>
        item.run.identity.projectId === project?.id &&
        item.run.identity.conversationId === conversation?.id,
    );
    setGeneration(entry?.state);
    setLiveAgentActions(entry?.actions ?? []);
  }, [project?.id, workerScope(project?.id)?.projectSessionId, conversation?.id]);
  useEffect(() => {
    setDetachedPanels((current) => {
      const labels = Object.keys(detachedRegistryRef.current);
      if (labels.length === 0) return current;
      for (const label of labels) void closeDetachedPanelWindow(label).catch(() => undefined);
      detachedRegistryRef.current = {};
      detachedSnapshotRef.current = {};
      detachedActionSequenceRef.current = {};
      return {};
    });
  }, [project?.id]);
  useEffect(() => {
    if (!generation || generation.executionMode === 'native' || !isGenerationActive(generation))
      return;
    const projectId = project?.id;
    const conversationId = conversation?.id;
    const generationId = generation.generationId;
    if (!projectId || !conversationId || generation.conversationId !== conversationId) return;
    const version = ++generationPollVersion.current;
    let requestPending = false;
    const timer = window.setInterval(() => {
      if (version !== generationPollVersion.current || requestPending) return;
      requestPending = true;
      void callWorker('llm.generation.get', { generationId })
        .then((next) => {
          const owner = generationPollOwner.current;
          if (
            version !== generationPollVersion.current ||
            owner.projectId !== projectId ||
            owner.conversationId !== conversationId ||
            owner.generationId !== generationId ||
            next.generationId !== generationId ||
            next.conversationId !== conversationId
          ) {
            return;
          }
          setGeneration(next);
          setMessages((current) => mergeGenerationMessage(current, conversationId, next));
          if (!isGenerationActive(next)) {
            if (next.error) lastGenerationErrorRef.current = next.error;
            setChatMessage(generationStatusMessage(next));
          }
        })
        .catch((reason) => {
          if (version === generationPollVersion.current) {
            setChatMessage(reason instanceof Error ? reason.message : '生成状态读取失败');
          }
        })
        .finally(() => {
          requestPending = false;
        });
    }, 250);
    return () => {
      window.clearInterval(timer);
      if (generationPollVersion.current === version) generationPollVersion.current += 1;
    };
  }, [
    project?.id,
    workerScope(project?.id)?.projectSessionId,
    generation?.generationId,
    generation?.status,
    conversation?.id,
  ]);
  useEffect(() => {
    if (!project?.id) return;
    let active = true;
    let pending = false;
    const recover = async () => {
      if (pending) return;
      pending = true;
      try {
        const runs = await callWorker('conversation.runtime.list', {});
        if (!active) return;
        for (const item of runs ?? []) {
          if (nativeRuns.current.has(item.identity.generationId)) continue;
          void launchPreparedGeneration(
            {
              generation: item.generation,
              stream: item.identity,
              agentTaskId: item.taskId,
              runtimeOwner: 'pi',
            } as LlmGenerationPrepareResult,
            false,
            true,
          );
        }
      } catch {
        /* Keep existing loops alive while observation reconnects. */
      } finally {
        pending = false;
      }
    };
    void recover();
    const timer = window.setInterval(() => void recover(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [project?.id, workerScope(project?.id)?.projectSessionId, conversation?.id]);
  useEffect(
    () => () => {
      for (const [id, entry] of nativeRuns.current) {
        entry.run.detach();
        confirmationQueue.current!.removeOwner(id);
      }
      const poll = agentTaskEventPollRef.current;
      if (poll?.timer !== undefined) window.clearInterval(poll.timer);
    },
    [],
  );
  // Re-discover persisted Agent tasks after app restart or conversation switches.
  // SQLite remains authoritative; this only restores observation/presentation and
  // never starts a second runtime or replays a side effect.
  useEffect(() => {
    const projectId = project?.id;
    const conversationId = conversation?.id;
    if (!projectId || !conversationId) {
      stopAgentTaskEventPolling();
      setAgentTask(undefined);
      setConversationAgentTasks([]);
      return;
    }
    let active = true;
    void Promise.resolve()
      .then(() => callWorker('agent.task.list', { limit: 50, conversationId }))
      .then(async (tasks) => {
        if (!active) return;
        const byUpdated = [...tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const details = (
          await Promise.all(
            byUpdated
              .slice(0, 20)
              .map((task) =>
                callWorker('agent.task.get', { taskId: task.id }).catch(() => undefined),
              ),
          )
        ).filter((item): item is NonNullable<typeof item> => Boolean(item));
        if (!active) return;
        setConversationAgentTasks(details);
        const live =
          details.find((item) => ['queued', 'running'].includes(item.task.status)) ??
          details.find((item) => item.task.status === 'waiting_review') ??
          details[0];
        if (!live) {
          stopAgentTaskEventPolling();
          setAgentTask(undefined);
          return;
        }
        setAgentTask(live);
        if (['queued', 'running'].includes(live.task.status)) {
          startAgentTaskEventPolling(live.task.id);
        }
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [project?.id, workerScope(project?.id)?.projectSessionId, conversation?.id]);
  const runProjectAction = async (
    action: () => Promise<ProjectInfo | string | undefined>,
    options: {
      createInitialConversation?: boolean;
    } = {},
  ) => {
    const requestId = ++projectActionRequest.current;
    generationPollVersion.current += 1;
    projectContentRequest.current += 1;
    resetConversationWorkspace();
    resetDocumentWorkspace();
    setNovelFocusChapterId(undefined);
    setNovelFocusReferenceId(undefined);
    sceneRequest.current += 1;
    stopAgentTaskEventPolling();
    setProjectBusy(true);
    setProjectMessage('');
    try {
      const result = await action();
      if (requestId !== projectActionRequest.current) return;
      if (typeof result === 'string') setProjectMessage(result);
      else if (result) {
        if (result.id !== project?.id) {
          resetAssetWorkspace();
          setAssetTrashRequest(0);
          setAssetLibraryFocusRevision(0);
        }
        const runtime = ((await callWorker('project.runtime.list', {})) ?? []).find(
          (entry) => entry.project.id === result.id,
        );
        if (!runtime) throw new Error('项目运行上下文不可用');
        selectWorkerScope({
          projectId: runtime.project.id,
          projectSessionId: runtime.projectSessionId,
        });
        if (options.createInitialConversation) {
          try {
            await callWorker(
              'conversation.create',
              { scopeType: 'project' },
              {
                projectId: runtime.project.id,
                projectSessionId: runtime.projectSessionId,
              },
            );
          } catch (reason) {
            setProjectMessage(
              `项目已创建，但新会话创建失败：${reason instanceof Error ? reason.message : '会话创建失败'}`,
            );
          }
        }
        setGeneration(undefined);
        setProject(result);
        setProjectCreateOpen(false);
      }
      setRecentProjects(await callWorker('project.recent', {}));
    } catch (reason) {
      if (requestId === projectActionRequest.current) {
        setProjectMessage(reason instanceof Error ? reason.message : '项目操作失败');
      }
    } finally {
      if (requestId === projectActionRequest.current) setProjectBusy(false);
    }
  };
  const maintenance = useProjectMaintenance({
    runProjectAction,
    onCloseSettings: () => setSettingsOpen(false),
  });
  const normalizeProjectPath = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || !value.trim()) {
      setProjectMessage('请输入项目绝对目录');
      return undefined;
    }
    return value.trim();
  };
  const createProject = () => {
    const rootPath = normalizeProjectPath(projectPath);
    const name = projectName.trim();
    if (!rootPath || !name) {
      if (!name) setProjectMessage('请输入项目名称');
      return;
    }
    return runProjectAction(
      async () => (await callWorker('project.runtime.create', { name, rootPath })).project,
      { createInitialConversation: true },
    );
  };
  const createSampleProject = () => {
    const rootPath = normalizeProjectPath(projectPath);
    if (!rootPath) return;
    return runProjectAction(
      async () =>
        (
          await callWorker('project.runtime.createSample', {
            rootPath,
            name: projectName.trim() || undefined,
          })
        ).project,
      { createInitialConversation: true },
    );
  };
  const openProject = (requestedPath?: string) => {
    const rootPath = normalizeProjectPath(requestedPath ?? projectPath);
    if (!rootPath) return;
    setProjectPickerOpen(false);
    setProjectCreateOpen(false);
    return runProjectAction(async () => {
      const attached = await callWorker('project.runtime.attach', { rootPath });
      const activated = await callWorker('project.runtime.activate', {
        projectId: attached.project.id,
        projectSessionId: attached.projectSessionId,
      });
      return activated.project;
    });
  };
  const selectProjectDirectory = async (openAfterSelection = false) => {
    setProjectMessage('');
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: openAfterSelection ? '选择要打开的项目目录' : '选择项目目录',
      });
      if (typeof selected !== 'string') return;
      setProjectPath(selected);
      if (openAfterSelection) await openProject(selected);
    } catch (reason) {
      setProjectMessage(reason instanceof Error ? reason.message : '无法打开目录选择器');
    }
  };
  const closeProject = () =>
    runProjectAction(async () => {
      setProjectPickerOpen(false);
      const scope = workerScope(project?.id);
      if (scope) await callWorker('project.runtime.unload', scope);
      if (project) {
        forgetWorkerScope(project.id);
        for (const [id, entry] of nativeRuns.current) {
          if (entry.run.identity.projectId === project.id) {
            confirmationQueue.current!.removeOwner(id);
            nativeRuns.current.delete(id);
          }
        }
      }
      setProject(undefined);
      resetDocumentWorkspace();
      setScenes([]);
      setShotReferenceDocuments({});
      resetAssetWorkspace();
      resetConversationWorkspace();
      setGeneration(undefined);
      return '项目已安全关闭';
    });
  const openProjectRename = () => {
    if (!project || !writable) return;
    setProjectRenameValue(project.name);
    setProjectRenameError('');
    setProjectPickerOpen(false);
    setProjectRenameOpen(true);
  };
  const renameProject = async () => {
    if (!project || !writable || projectRenameBusy) return;
    const name = projectRenameValue.trim();
    if (!name) {
      setProjectRenameError('请输入项目名称。');
      return;
    }
    setProjectRenameBusy(true);
    setProjectRenameError('');
    try {
      const renamed = await callWorker('project.rename', { name });
      setProject(renamed);
      setRecentProjects((current) =>
        current.map((recent) =>
          recent.rootPath === renamed.rootPath ? { ...recent, name: renamed.name } : recent,
        ),
      );
      setProjectMessage('项目名称已更新。');
      setProjectRenameOpen(false);
    } catch (reason) {
      setProjectRenameError(reason instanceof Error ? reason.message : '项目名称修改失败。');
    } finally {
      setProjectRenameBusy(false);
    }
  };
  const openSettings = (
    page: SettingsPage = project ? 'providers' : 'maintenance',
    providerFocusId?: string,
  ) => {
    setSettingsInitialPage(page);
    setProviderSettingsFocusId(page === 'providers' ? providerFocusId : undefined);
    setSettingsOpen(true);
    maintenance.clearMaintenanceMessage();
    if (project) void maintenance.inspectCache();
  };
  const openAgentProtectedUi = (handoff: AgentProtectedUiHandoff) => {
    if (handoff.page === 'providers') {
      openSettings('providers', handoff.focusId);
      return;
    }
    if (handoff.page === 'maintenance') {
      openSettings('maintenance');
      return;
    }
    openProjectView('assets', handoff.focusId);
    setAssetTrashRequest((revision) => revision + 1);
  };
  const openConversationById = async (conversationId: string) => {
    try {
      const page = await callWorker('conversation.list', {
        scopeType: 'project',
        includeArchived: true,
      });
      const conversation = page.items.find((item) => item.id === conversationId);
      if (!conversation) {
        setChatMessage('来源会话不存在或已被删除。');
        return;
      }
      await selectConversation(conversation);
      workspaceDispatch({ type: 'open', panelId: 'conversation' });
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '来源会话打开失败');
    }
  };
  const addScene = async () => {
    const created = await callWorker('scene.save', { title: `场次 ${scenes.length + 1}` });
    const list = await callWorker('scene.list', {});
    setScenes(list);
    void refreshShotReferenceDocuments(list);
    setScene(created);
    setSceneVideoPrompt(created.prompt ?? '');
    setShots([]);
    setShot(undefined);
    openProjectView('shots');
  };
  useEffect(() => {
    let active = true;
    const expectedProjectId = project?.id;
    const refresh = () => {
      if (expectedProjectId)
        void callWorker('scene.list', {})
          .then((rows) => {
            if (!active || activeProjectIdRef.current !== expectedProjectId) return;
            setScenes(rows);
            void refreshShotReferenceDocuments(rows);
            setScene((current) => rows.find((row) => row.id === current?.id) ?? current);
          })
          .catch(() => undefined);
    };
    window.addEventListener('scene-cast-updated', refresh);
    return () => {
      active = false;
      window.removeEventListener('scene-cast-updated', refresh);
    };
  }, [project?.id]);
  const productionEditor = useRef({
    scene,
    shot,
    sceneVideoPrompt,
    shotPrompt,
    shotStoryboardTitle,
    shotStoryboardContent,
  });
  const productionRefreshRequest = useRef(0);
  productionEditor.current = {
    scene,
    shot,
    sceneVideoPrompt,
    shotPrompt,
    shotStoryboardTitle,
    shotStoryboardContent,
  };
  const refreshProductionSources = async () => {
    if (!project?.id) return;
    const expectedProjectId = project.id;
    const expectedSessionId = workerScope()?.projectSessionId;
    const refreshRequest = ++productionRefreshRequest.current;
    const expectedSceneId = activeSceneIdRef.current;
    const [nextScenes, nextShots] = await Promise.all([
      callWorker('scene.list', {}),
      expectedSceneId ? callWorker('shot.list', { sceneId: expectedSceneId }) : Promise.resolve([]),
    ]);
    if (
      activeProjectIdRef.current !== expectedProjectId ||
      workerScope()?.projectSessionId !== expectedSessionId ||
      productionRefreshRequest.current !== refreshRequest
    )
      throw new Error('Production refresh superseded');
    setScenes(nextScenes);
    void refreshShotReferenceDocuments(nextScenes);
    if (activeSceneIdRef.current !== expectedSceneId) return;
    setShots(nextShots);
    setScene((current) => {
      const next = nextScenes.find((item) => item.id === current?.id);
      if (productionEditor.current.sceneVideoPrompt !== (current?.prompt ?? '')) return current;
      if (next)
        setSceneVideoPrompt((text) =>
          text === (current?.prompt ?? '') ? (next.prompt ?? '') : text,
        );
      return next ?? current;
    });
    setShot((current) => {
      const next = nextShots.find((item) => item.id === current?.id);
      if (productionEditor.current.shotPrompt !== (current?.prompt ?? '')) return current;
      if (next)
        setShotPrompt((text) => (text === (current?.prompt ?? '') ? (next.prompt ?? '') : text));
      return next ?? current;
    });
  };
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          agent?: boolean;
          authoring?: boolean;
        }>
      ).detail;
      if (!detail?.agent && !detail?.authoring) return;
      void refreshProductionSources().catch(() =>
        setContentMessage('制作内容已更新，页面刷新失败，请重新打开对应页面。'),
      );
    };
    window.addEventListener('production-source-updated', refresh);
    return () => {
      window.removeEventListener('production-source-updated', refresh);
    };
  }, [project?.id, scene?.id]);
  const refreshAppliedStructure = async (
    saved: import('@ai-video/contracts').AgentChangeSetInfo | string,
  ) => {
    const expectedProjectId = project?.id;
    const requestId = ++sceneRequest.current;
    const changeSet =
      typeof saved === 'string'
        ? (await callWorker('agent.changeSet.list', { includeTerminal: true })).find(
            (item) => item.id === saved,
          )
        : saved;
    if (activeProjectIdRef.current !== expectedProjectId || requestId !== sceneRequest.current)
      return;
    const nextScenes = await callWorker('scene.list', {});
    if (activeProjectIdRef.current !== expectedProjectId || requestId !== sceneRequest.current)
      return;
    setScenes(nextScenes);
    void refreshShotReferenceDocuments(nextScenes);
    const appliedSceneIds = new Set(
      (changeSet?.items ?? [])
        .filter((item) => item.entityType === 'scene' && item.status === 'applied')
        .map((item) => item.appliedEntityId),
    );
    const nextScene =
      nextScenes.find((item) => appliedSceneIds.has(item.id)) ??
      nextScenes.find((item) => item.id === scene?.id) ??
      nextScenes[0];
    const nextShots = nextScene ? await callWorker('shot.list', { sceneId: nextScene.id }) : [];
    if (activeProjectIdRef.current !== expectedProjectId || requestId !== sceneRequest.current)
      return;
    const appliedShotIds = new Set(
      (changeSet?.items ?? [])
        .filter((item) => item.entityType === 'shot' && item.status === 'applied')
        .map((item) => item.appliedEntityId),
    );
    const nextShot = nextShots.find((item) => appliedShotIds.has(item.id)) ?? nextShots[0];
    setScene(nextScene);
    setSceneVideoPrompt(nextScene?.prompt ?? '');
    setShots(nextShots);
    setShot(nextShot);
    setShotPrompt(nextShot?.prompt ?? '');
  };
  const refreshProductionLifecycle = async (
    targets: Array<{
      kind: 'scene' | 'shot';
      id: string;
    }>,
  ) => {
    const expectedProjectId = project?.id;
    const requestId = ++sceneRequest.current;
    const removedScenes = new Set(
      targets.filter((item) => item.kind === 'scene').map((item) => item.id),
    );
    const removedShots = new Set(
      targets.filter((item) => item.kind === 'shot').map((item) => item.id),
    );
    setScenes((rows) => rows.filter((item) => !removedScenes.has(item.id)));
    setShots((rows) =>
      rows.filter((item) => !removedScenes.has(item.sceneId) && !removedShots.has(item.id)),
    );
    if (scene && removedScenes.has(scene.id)) {
      conversationRequest.current += 1;
      setScene(undefined);
      setSceneVideoPrompt('');
      setShot(undefined);
      setShotPrompt('');
    } else if (shot && removedShots.has(shot.id)) {
      conversationRequest.current += 1;
      setShot(undefined);
      setShotPrompt('');
    }
    const nextScenes = await callWorker('scene.list', {});
    if (activeProjectIdRef.current !== expectedProjectId || requestId !== sceneRequest.current)
      return;
    setScenes(nextScenes);
    const currentSceneId = activeSceneIdRef.current;
    if (!currentSceneId) return;
    if (!nextScenes.some((item) => item.id === currentSceneId)) {
      setScene(undefined);
      setShot(undefined);
      setShots([]);
      setSceneVideoPrompt('');
      return;
    }
    const nextShots = await callWorker('shot.list', { sceneId: currentSceneId });
    if (activeProjectIdRef.current !== expectedProjectId || requestId !== sceneRequest.current)
      return;
    setShots(nextShots);
    if (activeShotIdRef.current && !nextShots.some((item) => item.id === activeShotIdRef.current)) {
      setShot(undefined);
      setShotPrompt('');
    }
  };
  const selectScene = async (selected: SceneInfo, selectedShot?: ShotInfo) => {
    const requestId = ++sceneRequest.current;
    conversationRequest.current += 1;
    setScene(selected);
    setSceneVideoPrompt(selected.prompt ?? '');
    setShot(undefined);
    try {
      const items = await callWorker('shot.list', { sceneId: selected.id });
      if (requestId !== sceneRequest.current) return;
      setShots(items);
      if (!selected.prompt?.trim() && items.length > 0) {
        const composed = [
          `# 场次：${selected.title}`,
          '请生成一段完整、连续的视频，保持人物外观、服装、场景和光线一致。',
          ...items.map(
            (item, index) =>
              `${index + 1}. ${item.title}\n${item.prompt?.trim() || '补充该镜头的动作和画面。'}`,
          ),
        ].join('\n\n');
        setSceneVideoPrompt(composed);
      }
      setShot(selectedShot ? items.find((item) => item.id === selectedShot.id) : undefined);
      openProjectView('shots');
    } catch (reason) {
      if (requestId === sceneRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '镜头加载失败');
      }
    }
  };
  useEffect(() => {
    setShotPrompt(shot?.prompt ?? '');
  }, [shot?.id]);
  const saveSceneVideoPrompt = async (nextPrompt: string) => {
    if (!scene) return false;
    const expectedProjectId = project?.id;
    const requestId = sceneRequest.current;
    try {
      const updated = await callWorker('scene.save', {
        sceneId: scene.id,
        title: scene.title,
        prompt: nextPrompt,
        expectedRowVersion: scene.rowVersion,
      });
      if (activeProjectIdRef.current !== expectedProjectId || sceneRequest.current !== requestId)
        return false;
      setScene(updated);
      setScenes((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      setSceneVideoPrompt(updated.prompt ?? '');
      setChatMessage('场次视频提示词已保存。');
      return true;
    } catch (reason) {
      if (activeProjectIdRef.current === expectedProjectId && sceneRequest.current === requestId)
        setChatMessage(reason instanceof Error ? reason.message : '场次提示词保存失败');
      return false;
    }
  };
  const renameScene = async (target: SceneInfo, title: string) => {
    if (!writable || !title.trim()) return;
    try {
      const updated = await callWorker('scene.save', {
        sceneId: target.id,
        title: title.trim(),
        expectedRowVersion: target.rowVersion,
      });
      setScenes((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      setScene((current) => (current?.id === updated.id ? updated : current));
      setChatMessage('场次标题已保存。');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '场次标题保存失败');
    }
  };
  const openSceneProduction = async () => {
    if (!scene) return;
    if (
      sceneVideoPrompt !== (scene.prompt ?? '') &&
      !(await saveSceneVideoPrompt(sceneVideoPrompt))
    )
      return;
    const expectedProjectId = project?.id;
    if (!expectedProjectId) return;
    const production = await callWorker('production.read', {
      target: { kind: 'scene', id: scene.id },
    });
    if (activeProjectIdRef.current !== expectedProjectId || activeSceneIdRef.current !== scene.id)
      return;
    setProductionSeed({
      sceneId: scene.id,
      prompt: production?.compiledPrompt ?? sceneVideoPrompt.trim(),
    });
    const hasReferences = shots.some((item) => {
      const references = productionShotReferenceIds(item);
      return (
        references.characterDocumentIds.length > 0 ||
        references.sceneDocumentIds.length > 0 ||
        references.propDocumentIds.length > 0 ||
        Boolean(item.referenceBindings?.firstFrameAssetId)
      );
    });
    setProductionCapability(hasReferences ? 'REFERENCE_TO_VIDEO' : 'TEXT_TO_VIDEO');
  };
  useEffect(() => {
    const requestId = ++shotStoryboardRequest.current;
    setShotStoryboardBusy(true);
    if (!shot?.documentId) {
      setShotStoryboard(undefined);
      setShotStoryboardTitle('');
      setShotStoryboardContent('');
      setShotStoryboardBusy(false);
      return;
    }
    callWorker('document.get', { documentId: shot.documentId })
      .then((detail: DocumentDetail) => {
        if (requestId !== shotStoryboardRequest.current) return;
        setShotStoryboard(detail);
        setShotStoryboardTitle(detail.title);
        setShotStoryboardContent(detail.currentVersion?.contentMarkdown ?? '');
      })
      .catch((reason: unknown) => {
        if (requestId === shotStoryboardRequest.current) {
          setChatMessage(reason instanceof Error ? reason.message : '分镜文档加载失败');
        }
      })
      .finally(() => {
        if (requestId === shotStoryboardRequest.current) setShotStoryboardBusy(false);
      });
  }, [shot]);
  const saveShotStoryboard = async () => {
    if (!shot) return;
    const expectedProjectId = project?.id;
    const requestId = shotStoryboardRequest.current;
    setShotStoryboardBusy(true);
    try {
      const updated = await callWorker('shot.storyboard.save', {
        shotId: shot.id,
        title: shotStoryboardTitle.trim() || shot.title,
        contentMarkdown: shotStoryboardContent,
      });
      const latestShots = !shot.documentId
        ? await callWorker('shot.list', { sceneId: shot.sceneId })
        : undefined;
      if (
        activeProjectIdRef.current !== expectedProjectId ||
        requestId !== shotStoryboardRequest.current
      )
        return;
      setShotStoryboard(updated);
      setShotStoryboardTitle(updated.title);
      setShotStoryboardContent(updated.currentVersion?.contentMarkdown ?? '');
      if (!shot.documentId) {
        const attached: ShotInfo = {
          ...(latestShots?.find((item) => item.id === shot.id) ?? shot),
          documentId: updated.id,
        };
        setShot(attached);
        setShots((latestShots ?? shots).map((row) => (row.id === shot.id ? attached : row)));
      }
      setChatMessage('分镜文档已保存。');
    } catch (reason) {
      if (
        activeProjectIdRef.current === expectedProjectId &&
        requestId === shotStoryboardRequest.current
      )
        setChatMessage(reason instanceof Error ? reason.message : '分镜文档保存失败');
    } finally {
      if (
        activeProjectIdRef.current === expectedProjectId &&
        requestId === shotStoryboardRequest.current
      )
        setShotStoryboardBusy(false);
    }
  };
  const addShot = async () => {
    if (!scene) return;
    const created = await callWorker('shot.save', {
      sceneId: scene.id,
      title: `镜头 ${shots.length + 1}`,
    });
    setShots(await callWorker('shot.list', { sceneId: scene.id }));
    setShot(created);
  };
  const seedShotProduction = (
    mode: 'image' | 'video',
    refs: ShotReferenceAssets,
    prompt: string,
    refresh = false,
  ) => {
    if (!shot) return;
    const imageAssetLabel = (assetId: string) => {
      const asset = assets.find((item) => item.id === assetId);
      return asset?.alias?.trim() || asset?.relativePath.split(/[\\/]/).pop();
    };
    const inputImages = shotReferenceImageSelections(refs).map((image) => {
      const documentId =
        image.role === 'character'
          ? refs.characterBindings?.find((binding) => binding.assetId === image.assetId)
              ?.characterDocumentId
          : image.role === 'scene'
            ? refs.sceneBindings?.find((binding) => binding.assetId === image.assetId)
                ?.sourceDocumentId
            : undefined;
      const documentTitle = documents.find((item) => item.id === documentId)?.title;
      return {
        ...image,
        ...(documentTitle || imageAssetLabel(image.assetId)
          ? { label: documentTitle ?? imageAssetLabel(image.assetId) }
          : {}),
      };
    });
    const images = inputImages.map(({ assetId }) => `asset://${assetId}`);
    const nextSeed = {
      shotId: shot.id,
      prompt: refs.continuityPrompt ?? prompt,
      continuityRevision: refs.continuityRowVersion,
      assetKind: 'first-frame' as const,
      images,
      inputImages,
    };
    setProductionSeed((current) =>
      !refresh &&
      current?.shotId === nextSeed.shotId &&
      current.prompt === nextSeed.prompt &&
      current.continuityRevision === nextSeed.continuityRevision &&
      current.assetKind === nextSeed.assetKind &&
      JSON.stringify(current.images) === JSON.stringify(nextSeed.images) &&
      JSON.stringify(current.inputImages) === JSON.stringify(nextSeed.inputImages)
        ? current
        : nextSeed,
    );
    if (mode === 'image') {
      setProductionCapability(images.length > 0 ? 'REFERENCE_TO_IMAGE' : 'TEXT_TO_IMAGE');
    } else {
      setProductionCapability(
        inputImages.some((image) => image.role === 'first-frame')
          ? 'IMAGE_TO_VIDEO'
          : 'REFERENCE_TO_VIDEO',
      );
    }
  };
  const prepareShotProduction = (
    mode: 'image' | 'video',
    prompt: string,
    refs: ShotReferenceAssets,
  ) => {
    seedShotProduction(mode, refs, prompt.trim(), true);
  };
  const openShotProduction = async (
    mode: 'image' | 'video',
    refs: ShotReferenceAssets,
    promptOverride?: string,
  ) => {
    if (!shot) return;
    const sourcePrompt = promptOverride ?? shotPrompt.trim();
    seedShotProduction(mode, refs, sourcePrompt);
    if (sourcePrompt !== (shot.prompt ?? '')) await saveShotPrompt(sourcePrompt);
  };
  const saveShotReferenceBindings = async (
    bindings: import('@ai-video/contracts').ShotReferenceBindingInfo | null,
  ) => {
    if (!shot) return undefined;
    const result = await callWorker('shot.references.save', {
      shotId: shot.id,
      referenceBindings: bindings,
    });
    setShot((current) =>
      current?.id === result.shotId
        ? { ...current, referenceBindings: result.referenceBindings }
        : current,
    );
    setShots((rows) =>
      rows.map((row) =>
        row.id === result.shotId ? { ...row, referenceBindings: result.referenceBindings } : row,
      ),
    );
    return result;
  };
  const saveShotPrompt = async (promptValue = shotPrompt) => {
    if (!shot) return false;
    const targetShot = shot;
    const expectedProjectId = project?.id;
    try {
      const updated = await callWorker('shot.save', {
        shotId: targetShot.id,
        sceneId: targetShot.sceneId,
        title: targetShot.title,
        prompt: promptValue,
        expectedRowVersion: targetShot.rowVersion,
      });
      setShots((rows) => rows.map((row) => (row.id === targetShot.id ? updated : row)));
      if (
        activeProjectIdRef.current === expectedProjectId &&
        activeShotIdRef.current === targetShot.id
      ) {
        setShot(updated);
        setShotPrompt(promptValue);
      }
      setChatMessage('镜头提示词已保存。');
      return true;
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '镜头提示词保存失败');
      return false;
    }
  };
  const renameShot = async (sceneTarget: SceneInfo, target: ShotInfo, title: string) => {
    if (!writable || !title.trim()) return;
    try {
      const updated = await callWorker('shot.save', {
        shotId: target.id,
        sceneId: sceneTarget.id,
        title: title.trim(),
        expectedRowVersion: target.rowVersion,
      });
      setShots((rows) => rows.map((row) => (row.id === updated.id ? updated : row)));
      setShot((current) => (current?.id === updated.id ? updated : current));
      setChatMessage('镜头标题已保存。');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '镜头标题保存失败');
    }
  };
  const requestContinuityAgent = async (
    context: import('@ai-video/contracts').ShotContinuityContext,
  ) => {
    if (!project || !shot || context.shotId !== shot.id || context.stale)
      throw new Error('请重新确认当前镜头选帧。');
    if (!selectedLlmModel?.capabilities.vision) throw new Error('请选择支持看图的会话模型。');
    const projectId = project.id;
    const shotId = shot.id;
    const targetConversation = conversation ?? (await createConversation());
    if (
      !targetConversation ||
      activeProjectIdRef.current !== projectId ||
      activeShotIdRef.current !== shotId
    )
      throw new Error('项目或镜头已切换。');
    workspaceDispatch({ type: 'open', panelId: 'conversation' });
    await sendMessage(
      [
        '请协助准备这个镜头的静态参考图图片提示词。先调用 shot.continuity.read 查看人工确认的实际选帧、当前镜头内容和已绑定参考资料。',
        '以用户参考图生成要求为目标；目标时刻、构图或必要变化不清楚时用 conversation.ask 澄清，不自行假定首帧或换机位。结合实际画面保持必要的服装、站位、持物、环境和光线，不编造不可见空间。',
        '将明确的生成意图与完整可编辑图片提示词通过 shot.continuity.save 保存到本镜头，不改镜头视频提示词，不直接生成图片或视频。用户将在镜头页面检查后填充正常生图表单。',
        JSON.stringify({
          projectId,
          shotId,
          expectedRowVersion: context.rowVersion,
          userIntent: context.binding?.notes,
        }),
      ].join('\n\n'),
      undefined,
      '',
      targetConversation,
      false,
    );
  };
  const requestShotBindingRepair = async (promptValue: string) => {
    if (!shot || !project) throw new Error('请先选择需要修复的镜头。');
    const expectedProjectId = project.id;
    const targetShot = shot;
    if (promptValue !== (targetShot.prompt ?? '') && !(await saveShotPrompt(promptValue)))
      throw new Error('提示词未保存，绑定修复已取消。');
    const current = await callWorker('production.read', {
      target: { kind: 'shot', id: targetShot.id },
    });
    if (
      activeProjectIdRef.current !== expectedProjectId ||
      activeSceneIdRef.current !== targetShot.sceneId ||
      activeShotIdRef.current !== targetShot.id
    )
      throw new Error('镜头已切换，请重新发起绑定修复。');
    if (!current.prompt?.trim())
      throw new Error('本镜尚无可修复的制作提示词，请先生成或保存镜头提示词。');
    const currentPrompt = current as import('@ai-video/contracts').PromptRecord;
    const currentReferences = productionShotReferenceIds({
      ...currentPrompt,
      referenceBindings: targetShot.referenceBindings,
    });
    const describeReferences = (ids: string[]) =>
      ids.map((documentId) => {
        const document = documents.find((item) => item.id === documentId);
        return {
          documentId,
          kind: document?.kind ?? 'not-in-current-catalog',
          title: document?.title ?? '未在当前资料列表中找到，请通过项目资料检索核实',
          lifecycleStatus: document?.lifecycleStatus ?? 'unknown',
        };
      });
    const referenceDetails = {
      characterDocumentIds: describeReferences(currentReferences.characterDocumentIds),
      sceneDocumentIds: describeReferences(currentReferences.sceneDocumentIds),
      propDocumentIds: describeReferences(currentReferences.propDocumentIds),
    };
    const targetConversation = conversation ?? (await createConversation());
    if (!targetConversation || activeProjectIdRef.current !== expectedProjectId)
      throw new Error('会话不可用，无法发起绑定修复。');
    const repairPrompt = [
      '请仅修复下面这个镜头的角色、场景和道具引用关系，不改写提示词正文，不修改时长、data、镜头标题、顺序、其他镜头或场次关系。',
      '根据完整镜头提示词判断画面中实际可见的人物、地点/环境和独立道具。检索项目资料并核对真实文档 ID；不要按名称猜 ID。对 characterDocumentIds、sceneDocumentIds、propDocumentIds 三类都提交完整列表，无对应对象时明确写 []。场次页只汇总镜头绑定，本任务不设置场次绑定。',
      '先检查当前镜头提示词和文档资料，再调用 scene.update_shot_prompts，只更新该镜头的 bindings；保留提示词和时长，使用当前 expectedRowVersion。完成后报告每个引用对象的角色、名称和真实文档 ID。',
      JSON.stringify({
        source: {
          projectId: expectedProjectId,
          scene: { id: targetShot.sceneId, title: scene?.title },
          shot: { id: targetShot.id, title: targetShot.title },
        },
        expectedRowVersion: current.rowVersion,
        currentPrompt,
        currentReferencesWithDocumentDetails: referenceDetails,
        currentShotImageSelections: targetShot.referenceBindings,
      }),
    ].join('\n\n');
    workspaceDispatch({ type: 'open', panelId: 'conversation' });
    await sendMessage(repairPrompt, undefined, '', targetConversation, false);
  };
  const sendMessage = async (
    composerValue = composer,
    modelSelection?: {
      providerProfileId: string;
      modelId: string;
      adapterKey?: string;
      parameters?: import('@ai-video/contracts').AdapterParameters;
    },
    acceptedComposerValue = composerValue,
    messageConversation = conversation,
    includeAttachments = true,
    taskExecution?: 'ordered' | 'parallel' | 'supplement',
    continuation?: {
      idempotencyKey: string;
    },
    requestMetadata?: {
      productionSkillId?: ProductionSkillId;
      productionWorkflowVersion?: 2;
      productionSources?: Array<{
        documentId: string;
        versionId: string;
      }>;
      productionRequestedAt?: string;
    },
  ) => {
    const conversation = messageConversation;
    if (includeAttachments && chatAttachmentsPending) return;
    const messageAttachments = includeAttachments ? chatAttachments : [];
    if ((!composerValue.trim() && messageAttachments.length === 0) || !conversation) return;
    if (continuation && activeProjectIdRef.current !== conversation.projectId)
      throw new Error('项目已切换，请回到原会话继续。');
    const activeRun = [...nativeRuns.current.values()].find(
      (entry) => entry.run.identity.conversationId === conversation.id,
    )?.run;
    if (
      !selectedLlmProfile &&
      (activeRun?.identity.conversationId === conversation.id ||
        (generation?.conversationId === conversation.id && isGenerationActive(generation)))
    ) {
      setChatMessage('当前会话的上一轮仍在执行，请等待完成或停止生成后再发送。');
      return;
    }
    const requestKey = `${conversation.projectId}:${conversation.id}`;
    if (pendingMessageRequestsRef.current.has(requestKey)) return;
    pendingMessageRequestsRef.current.add(requestKey);
    if (generationPollOwner.current.conversationId === conversation.id) setChatMessage('');
    const prompt = composerValue;
    const clearAcceptedComposer = () => {
      setComposer((current) =>
        activeProjectIdRef.current === conversation.projectId &&
        generationPollOwner.current.conversationId === conversation.id &&
        current === acceptedComposerValue
          ? ''
          : current,
      );
    };
    try {
      // A Worker sidecar can restart independently of the Desktop window. In
      // that case restore the project session before any Agent/media operation.
      try {
        if (!(await ensureWorkerProjectSession())) return;
      } catch (reason) {
        setChatMessage(reason instanceof Error ? reason.message : '项目会话未打开');
        return;
      }
      const callWorker = projectWorker(workerScope(conversation.projectId));
      // The Agent sees active task summaries and chooses independent, follow-up,
      // or supplement routing in its normal model turn. The Desktop does not
      // classify or bind this message before the model runs.
      const attachmentContext = messageAttachments.length
        ? `\n\n[附件：${messageAttachments.map((attachment) => attachment.name).join('、')}]${messageAttachments
            .filter((attachment) => attachment.text)
            .map((attachment) => `\n\n--- ${attachment.name} ---\n${attachment.text}`)
            .join('')}`
        : '';
      // Wait for this conversation's template and persist the exact draft that
      // will be submitted. A failed load/save keeps the message available to retry.
      const template = await conversationPromptTemplate.saveForSubmission(conversation);
      if (continuation && activeProjectIdRef.current !== conversation.projectId)
        throw new Error('项目已切换，请回到原会话继续。');
      const promptForAgent = composeConversationPrompt(`${prompt}${attachmentContext}`, template);
      if (
        (selectedLlmProfile || llmProfiles.length > 0) &&
        (modelSelection || (selectedLlmProfile && selectedLlmModel) || llmProfiles.length > 0)
      ) {
        try {
          setAgentModelSelection(undefined);
          setAgentParameterRequest(undefined);
          const capability = 'text' as const;
          const agentPrompt = promptForAgent;
          const remembered = conversation
            ? agentModelPreferences[conversation.id]?.text
            : undefined;
          const runModel = resolveAgentRunModelSelection(
            capability,
            modelSelection
              ? {
                  providerProfileId: modelSelection.providerProfileId,
                  modelId: modelSelection.modelId,
                }
              : undefined,
            remembered,
            selectedLlmProfile && selectedLlmModel
              ? { providerProfileId: selectedLlmProfile.id, modelId: selectedLlmModel.id }
              : undefined,
          );
          const providerProfileId = runModel?.providerProfileId;
          const modelId = runModel?.modelId;
          // Media parameter submission already carries local reference data in
          // `parameters.images`/video fields. Sending the same data again as
          // Agent attachments can push the JSON sidecar envelope over 2 MiB.
          const agentAttachments = modelSelection?.parameters
            ? undefined
            : buildAgentAttachments(messageAttachments);
          const idempotencyKey =
            continuation?.idempotencyKey ?? `desktop-run:${conversation.id}:${crypto.randomUUID()}`;
          const runParams: UnifiedAgentRunParams = {
            ...(taskExecution === 'parallel' ? { taskExecution } : {}),
            conversationId: conversation.id,
            prompt: agentPrompt || '请分析我提供的附件。',
            capability,
            idempotencyKey,
            ...(agentAttachments && agentAttachments.length > 0
              ? { attachments: agentAttachments }
              : {}),
            ...(providerProfileId && modelId ? { providerProfileId, modelId } : {}),
            researchMode,
            ...(requestMetadata?.productionSkillId ? { ...requestMetadata } : {}),
            ...(modelSelection?.adapterKey ? { adapterKey: modelSelection.adapterKey } : {}),
            ...(modelSelection?.parameters ? { parameters: modelSelection.parameters } : {}),
          };
          const unified = await callWorker('agent.run', runParams);
          if (
            unified.status !== 'needs_model_selection' &&
            providerProfileId &&
            modelId &&
            conversation &&
            capability === 'text'
          ) {
            void callWorker('conversation.modelPreference.set', {
              conversationId: conversation.id,
              capability: 'text',
              providerProfileId,
              modelId,
            }).catch(() => undefined);
          }
          if (unified.status === 'needs_model_selection') {
            if (continuation) throw new Error('请先在会话中选择可用的文字模型，再点击继续处理。');
            setChatMessage('');
            setAgentModelSelection({
              prompt: agentPrompt || '请分析我提供的附件。',
              composerPrompt: prompt,
              capability: unified.capability,
              models: unified.models,
              reason: unified.reason,
            });
            return;
          }
          if (unified.status === 'needs_parameters') {
            setAgentParameterRequest({
              composerPrompt: acceptedComposerValue,
              referenceImageInputs: collectReferenceImageInputs(messageAttachments),
              prompt: agentPrompt || '请根据附件生成内容。',
              ...unified,
            });
            setChatMessage('');
            return;
          }
          if (unified.status === 'pending_intent') {
            const reason = unified.pendingIntent.reasonCode;
            setChatMessage(
              reason === 'TARGET_REQUIRED'
                ? '请补充要操作的小说章节或新章节标题，助手会继续当前任务。'
                : reason === 'AMBIGUOUS_ACTION'
                  ? '请明确是新建、续写还是重写小说章节。'
                  : '当前小说任务需要补充说明后才能继续。',
            );
            return;
          }
          if (unified.status === 'image_prepared' || unified.status === 'video_prepared') {
            if (unified.status === 'image_prepared') {
              /* paid submission is Worker-owned and requires a fresh confirmation */
              const pending = await callWorker('media.generation.requestSubmission', {
                jobId: unified.job.id,
              });
              if (!pending.confirmation)
                throw new Error('Image submission confirmation is unavailable.');
              if (!(await requestMediaSubmissionApproval(pending.confirmation))) {
                await callWorker('media.task.cancel', { jobId: unified.job.id });
                return;
              }
              const submitted = await callWorker('media.generation.confirmSubmission', {
                jobId: unified.job.id,
                confirmationToken: pending.confirmation.confirmationToken,
                approved: true,
              });
              const completed = submitted.job;
              if (completed.status === 'succeeded') {
                clearAcceptedComposer();
                clearChatAttachments();
                const nextAssets = await callWorker('asset.list', {});
                updateAssets(nextAssets, completed.results[0]?.asset?.id);
              }
              setChatMessage(
                completed.status === 'succeeded'
                  ? '图片已生成并新增到素材库。'
                  : (completed.error ?? '图片生成失败。'),
              );
            } else {
              const pending = await callWorker('media.generation.requestSubmission', {
                jobId: unified.job.id,
              });
              if (!pending.confirmation)
                throw new Error('Video submission confirmation is unavailable.');
              if (!(await requestMediaSubmissionApproval(pending.confirmation))) {
                await callWorker('media.task.cancel', { jobId: unified.job.id });
                return;
              }
              const response = (
                await callWorker('media.generation.confirmSubmission', {
                  jobId: unified.job.id,
                  confirmationToken: pending.confirmation.confirmationToken,
                  approved: true,
                })
              ).job as import('@ai-video/contracts').VideoGenerationJobInfo;
              if (
                response.status === 'failed' ||
                response.status === 'cancelled' ||
                !response.providerTaskId
              ) {
                const failed = response;
                setChatMessage(failed.error ?? '视频任务提交失败。');
              } else {
                clearAcceptedComposer();
                clearChatAttachments();
                setChatMessage('视频任务已提交，可能产生费用；请在制作面板查看进度。');
              }
            }
            return;
          }
          if (!('generation' in unified) || !('stream' in unified)) {
            setChatMessage('Agent 任务需要进一步澄清，当前没有创建生成任务。');
            return;
          }
          void launchPreparedGeneration(unified, includeAttachments);
          clearAcceptedComposer();
          return true;
        } catch (reason) {
          setChatMessage(readableFailure(reason, '生成启动失败'));
          void loadLlmCatalog();
          if (continuation) throw reason;
        }
        return;
      }
      if (continuation) throw new Error('请先配置并选择可用的文字模型，再点击继续处理。');
      if (selectedLlmProfile && selectedLlmModel) {
        try {
          const idempotencyKey = `desktop-prepare:${conversation.id}:${crypto.randomUUID()}`;
          const prepared = await callWorker('llm.generation.prepare', {
            conversationId: conversation.id,
            prompt: promptForAgent,
            providerProfileId: selectedLlmProfile.id,
            modelId: selectedLlmModel.id,
            idempotencyKey,
          });
          void launchPreparedGeneration(prepared);
          clearAcceptedComposer();
        } catch (reason) {
          setChatMessage(readableFailure(reason, '生成启动失败'));
          void loadLlmCatalog();
        }
        return;
      }
      if (llmStatus?.configured) {
        try {
          const idempotencyKey = `desktop-generate:${conversation.id}:${crypto.randomUUID()}`;
          const started = await callWorker('llm.generate', {
            conversationId: conversation.id,
            prompt: promptForAgent,
            idempotencyKey,
          });
          setGeneration(started);
          setMessages((current) => [...current, started.userMessage, started.assistantMessage]);
          clearAcceptedComposer();
        } catch (reason) {
          setChatMessage(reason instanceof Error ? reason.message : '生成启动失败');
        }
        return;
      }
      try {
        const saved = await callWorker('chat.message.save', {
          conversationId: conversation.id,
          role: 'user',
          content: promptForAgent,
        });
        setMessages((current) => [...current, saved]);
        clearAcceptedComposer();
        setChatMessage('消息已保存；在供应商与模型中添加 LLM 连接后可生成回复');
      } catch (reason) {
        setChatMessage(readableFailure(reason, '消息保存失败'));
      }
    } catch (reason) {
      if (generationPollOwner.current.conversationId === conversation.id)
        setChatMessage(readableFailure(reason, '会话约束未保存，请重试后发送'));
      if (continuation) throw reason;
    } finally {
      pendingMessageRequestsRef.current.delete(requestKey);
    }
  };
  const continueQuestionForm = async (
    result: import('@ai-video/contracts').AgentInputSubmitResult,
  ) => {
    if (!conversation || result.form.conversationId !== conversation.id || !writable)
      throw new Error('请回到问答表单所属的可编辑会话继续。');
    // Reload the saved receipt instead of trusting text supplied by a detached window.
    const worker = projectWorker(workerScope(conversation.projectId));
    const saved = await worker('agent.input.submit', {
      taskId: result.form.taskId,
      formId: result.form.id,
      answers: result.form.answers!,
    });
    if (saved.form.continuationGenerationId) return;
    const accepted = await sendMessage(
      saved.prompt,
      undefined,
      '',
      conversation,
      false,
      undefined,
      { idempotencyKey: saved.idempotencyKey },
    );
    if (!accepted) throw new Error('回答已保存，本次未启动后续任务，请稍后点击继续处理。');
  };
  const runProductionSkill = async (
    skillId: ProductionSkillId,
    targets: Array<{
      id: string;
      documentId: string;
    }>,
  ) => {
    if (
      !project ||
      !writable ||
      productionSkillPending.current ||
      (generation && isGenerationActive(generation))
    )
      return;
    productionSkillPending.current = true;
    const productionRequestedAt = new Date().toISOString();
    setProductionSkillBusy(true);
    const projectId = project.id;
    const scopedWorker = projectWorker(workerScope(projectId));
    try {
      if (documentDirty) throw new Error('请先保存或放弃当前文档编辑，再启动制作。');
      if (targets.length === 0 || targets.length > 50)
        throw new Error('请选择 1–50 个已保存的源对象。');
      if (llmProfiles.length === 0) throw new Error('请先配置支持工具调用的 LLM 连接。');
      const sources = await Promise.all(
        targets.map(async (target) => {
          const source = await scopedWorker('document.get', { documentId: target.documentId });
          if (!source.currentVersion || source.lifecycleStatus !== 'active')
            throw new Error('源文档没有可用的已保存版本，请先保存。');
          return {
            ...target,
            title: source.title,
            kind: source.kind,
            versionId: source.currentVersion.id,
            state: source.currentVersion.state,
          };
        }),
      );
      if (activeProjectIdRef.current !== projectId) return;
      const targetConversation = conversation ?? (await createConversation());
      if (!targetConversation || activeProjectIdRef.current !== projectId) return;
      workspaceDispatch({ type: 'open', panelId: 'conversation' });
      const prompt = productionSkillPrompt(skillId, sources);
      // Use the exact same Agent entry, model picker, task log and cancellation path.
      // Keep unrelated composer text and attachments untouched.
      await sendMessage(prompt, undefined, '', targetConversation, false, undefined, undefined, {
        productionSkillId: skillId,
        ...(skillId === 'script-to-media'
          ? {
              productionWorkflowVersion: 2 as const,
              productionRequestedAt,
              productionSources: sources.map((source) => ({
                documentId: source.documentId,
                versionId: source.versionId,
              })),
            }
          : {}),
      });
    } catch (reason) {
      if (activeProjectIdRef.current === projectId)
        setChatMessage(readableFailure(reason, '制作任务准备失败'));
    } finally {
      productionSkillPending.current = false;
      setProductionSkillBusy(false);
    }
  };
  const addChatAttachments = (files: FileList | File[] | (() => Promise<File[]>)) => {
    const context = attachmentContextRef.current;
    const revision = chatAttachmentRevision.current;
    const current = () =>
      attachmentContextRef.current === context && chatAttachmentRevision.current === revision;
    const pendingFiles =
      typeof files === 'function' ? files : () => Promise.resolve(Array.from(files));
    setChatAttachmentsPending(true);
    setChatMessage('正在读取附件…');
    const add = async () => {
      if (!current()) return;
      try {
        const incoming = await pendingFiles();
        if (!current()) return;
        const existing = chatAttachmentsRef.current;
        if (incoming.length === 0) return;
        if (existing.length + incoming.length > MAX_CHAT_ATTACHMENTS) {
          setChatMessage(`最多同时添加 ${MAX_CHAT_ATTACHMENTS} 个附件。`);
          return;
        }
        if (
          existing.reduce((total, attachment) => total + attachment.size, 0) +
            incoming.reduce((total, file) => total + file.size, 0) >
          MAX_CHAT_TOTAL_BYTES
        ) {
          setChatMessage('附件总大小不能超过 40 MiB。');
          return;
        }
        const next: ChatAttachment[] = [];
        for (const file of incoming) {
          if (!file.name.trim() || file.size <= 0) throw new Error(`文件为空：${file.name}`);
          if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
            throw new Error(`附件不能超过 20 MiB：${file.name}`);
          }
          const kind = attachmentKind(file);
          const attachment: ChatAttachment = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            kind,
          };
          if (kind === 'image') {
            attachment.dataUrl = await readImageAsDataUrl(file);
            attachment.mimeType = encodedImageMimeType(attachment.dataUrl) ?? attachment.mimeType;
          } else if (kind === 'video') {
            attachment.dataUrl = await readFileAsDataUrl(file);
            try {
              attachment.previewDataUrl = await readVideoPreviewAsDataUrl(file);
            } catch {
              // Keep the original video preview; the Agent will receive metadata
              // and a clear limitation instead of failing the whole request.
            }
          } else if (
            file.size <= MAX_TEXT_ATTACHMENT_BYTES &&
            /\.(txt|md|json|csv|xml|yaml|yml)$/iu.test(file.name)
          ) {
            attachment.text = await readTextFile(file);
          }
          next.push(attachment);
        }
        if (!current()) return;
        const updated = [...chatAttachmentsRef.current, ...next];
        chatAttachmentsRef.current = updated;
        setChatAttachments(updated);
        setChatMessage('附件已添加，可以继续描述任务后发送。');
      } catch (reason) {
        if (current()) setChatMessage(reason instanceof Error ? reason.message : '添加附件失败');
      }
    };
    const task = chatAttachmentQueue.current.then(add, add).finally(() => {
      if (current() && chatAttachmentQueue.current === task) setChatAttachmentsPending(false);
    });
    chatAttachmentQueue.current = task;
    return chatAttachmentQueue.current;
  };
  const removeChatAttachment = (id: string) => {
    setChatAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };
  const cancelGeneration = async () => {
    const current = generation;
    if (!current || !isGenerationActive(current)) {
      return;
    }
    const agentTaskId = agentTask?.task.id;
    generationPollVersion.current += 1;
    if (current.executionMode === 'native') {
      await cancelNativeLlmRun();
    }
    try {
      const cancelled = await callWorker('llm.generation.cancel', {
        generationId: current.generationId,
      });
      setGeneration(cancelled);
      setMessages((messages) =>
        mergeGenerationMessage(messages, current.conversationId, cancelled),
      );
      if (agentTaskId) {
        const detail = await callWorker('agent.task.get', { taskId: agentTaskId }).catch(
          () => undefined,
        );
        if (detail) {
          setAgentTask((existing) => (existing?.task.id === agentTaskId ? detail : existing));
          setConversationAgentTasks((current) => upsertAgentTaskDetail(current, detail));
        }
      }
      setChatMessage('生成已停止');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '停止生成失败');
    }
  };
  const confirmSchemaProposal = async (adapterKey: string, version: number) => {
    if (!conversation || !agentTask) return;
    if (!window.confirm(`确认应用适配器 ${adapterKey} 的 Schema 第 ${version} 版修改？`)) return;
    try {
      await callWorker('adapter.schema.confirm', {
        adapterKey,
        version,
        conversationId: conversation.id,
        actorType: 'user',
        reason: '用户在会话中确认 Schema 修改提议',
      });
      const detail = await callWorker('agent.task.get', { taskId: agentTask.task.id });
      rememberAgentTask(detail);
      setChatMessage('Schema 修改已确认并生效。');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : 'Schema 修改确认失败');
    }
  };
  const rejectSchemaProposal = async (adapterKey: string, version: number) => {
    if (!conversation || !agentTask || version <= 1) return;
    if (!window.confirm(`拒绝此提议并回滚适配器 ${adapterKey} 到上一已确认版本？`)) return;
    try {
      await callWorker('adapter.schema.rollback', {
        adapterKey,
        version: version - 1,
        conversationId: conversation.id,
        actorType: 'user',
        reason: '用户拒绝 Schema 修改提议并回滚上一版本',
      });
      const detail = await callWorker('agent.task.get', { taskId: agentTask.task.id });
      rememberAgentTask(detail);
      setChatMessage('Schema 提议已拒绝，已回滚到上一确认版本。');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : 'Schema 提议回滚失败');
    }
  };
  const retryGeneration = async (assistantMessageId: string) => {
    if (retryRequestsRef.current.has(assistantMessageId)) return;
    retryRequestsRef.current.add(assistantMessageId);
    setChatMessage('');
    try {
      const idempotencyKey = `desktop-retry:${assistantMessageId}:${crypto.randomUUID()}`;
      if (selectedLlmProfile && selectedLlmModel) {
        const prepared = await callWorker('llm.generation.retryPrepare', {
          assistantMessageId,
          providerProfileId: selectedLlmProfile.id,
          modelId: selectedLlmModel.id,
          idempotencyKey,
        });
        void launchPreparedGeneration(prepared);
        return;
      }
      const retried = await callWorker('llm.generation.retry', {
        assistantMessageId,
        idempotencyKey,
      });
      setGeneration(retried);
      setMessages((current) => mergeGenerationMessage(current, retried.conversationId, retried));
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '重试生成失败');
    } finally {
      retryRequestsRef.current.delete(assistantMessageId);
    }
  };
  const detachPanel = async (panelId: DetachedPanelId) => {
    if (!project) {
      const message = '请先打开项目，再将面板分离为独立窗口。';
      if (panelId === 'document') setContentMessage(message);
      else setChatMessage(message);
      return;
    }
    if (panelId === 'document' && !document?.id) {
      setContentMessage('请先保存文档草稿，再打开独立窗口。');
      return;
    }
    let createdLabel: string | undefined;
    try {
      const entityId = panelId === 'document' ? document?.id : conversation?.id;
      const existingLabel = Object.values(detachedRegistryRef.current).find(
        (entry) =>
          entry.config.panelId === panelId &&
          entry.config.projectId === project.id &&
          entry.config.entityId === entityId,
      )?.config.label;
      if (existingLabel) {
        await focusDetachedPanelWindow(existingLabel);
        setDetachedPanels((current) => ({ ...current, [panelId]: existingLabel }));
        workspaceDispatch({ type: 'close', panelId });
        return;
      }
      createdLabel = await openDetachedPanelWindow({
        panelId,
        projectId: project.id,
        entityId,
        title:
          panelId === 'document'
            ? `${documentTitle || '文档编辑器'} - ${project.name}`
            : `会话 - ${project.name}`,
        onDestroyed: () => {
          if (createdLabel) {
            delete detachedRegistryRef.current[createdLabel];
            delete detachedSnapshotRef.current[createdLabel];
            delete detachedActionSequenceRef.current[createdLabel];
          }
          const wasActiveWindow = detachedPanelsRef.current[panelId] === createdLabel;
          setDetachedPanels((current) => {
            if (current[panelId] !== createdLabel) return current;
            const next = { ...current };
            delete next[panelId];
            return next;
          });
          if (wasActiveWindow) workspaceDispatch({ type: 'open', panelId });
        },
      });
      if (!createdLabel) {
        const message = '系统独立窗口仅在 Tauri 桌面应用中可用。';
        if (panelId === 'document') setContentMessage(message);
        else setChatMessage(message);
        return;
      }
      const initialSnapshot =
        panelId === 'document' ? documentDetachedSnapshot : conversationDetachedSnapshot;
      if (!initialSnapshot) {
        throw new Error('独立窗口缺少初始状态快照');
      }
      const registration: DetachedPanelRegistration = {
        config: {
          panelId,
          projectId: project.id,
          entityId,
          label: createdLabel,
          sessionId: createdLabel,
        },
        snapshot: initialSnapshot,
        snapshotSequence: 1,
        actionSequence: 0,
      };
      detachedRegistryRef.current[createdLabel] = registration;
      detachedSnapshotRef.current[createdLabel] = initialSnapshot;
      detachedActionSequenceRef.current[createdLabel] = 0;
      setDetachedPanels((current) => ({ ...current, [panelId]: createdLabel }));
      workspaceDispatch({ type: 'close', panelId });
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : '无法创建独立窗口';
      if (panelId === 'document') setContentMessage(message);
      else setChatMessage(message);
    }
  };
  const documentDetachedSnapshot: DetachedDocumentSnapshot | undefined = project
    ? {
        panelId: 'document',
        projectId: project.id,
        projectName: project.name,
        documentId: document?.id,
        title: documentTitle,
        kind: documentKind,
        content: documentContent,
        state: document?.currentVersion?.state ?? 'new',
        writable,
        busy: contentBusy,
        statusMessage: contentMessage,
        versions,
        currentVersionId: document?.currentVersionId,
        publishedVersionId: document?.publishedVersionId,
        rowVersion: document?.rowVersion ?? 0,
      }
    : undefined;
  const conversationDetachedSnapshot: DetachedConversationSnapshot | undefined = project
    ? {
        panelId: 'conversation',
        projectId: project.id,
        projectName: project.name,
        scopeType,
        scopeAvailable,
        writable,
        conversations,
        conversation,
        messages,
        composer,
        promptTemplate: conversationPromptTemplate.content,
        promptTemplateBusy: conversationPromptTemplate.busy,
        promptTemplateLoading: conversationPromptTemplate.loading,
        promptTemplateError: conversationPromptTemplate.error,
        promptTemplateDirty: conversationPromptTemplate.dirty,
        statusMessage: chatMessage,
        llmStatus: displayedLlmStatus,
        legacyLlmConfigured: llmStatus?.configurationSource === 'environment',
        llmProfiles,
        llmModels,
        selectedLlmProfileId,
        selectedLlmModelId,
        researchMode,
        contextPreview,
        generation,
        agentTask,
        agentTasks: conversationAgentTasks,
        liveAgentActions,
      }
    : undefined;
  const currentDetachedSnapshots = {
    document: documentDetachedSnapshot,
    conversation: conversationDetachedSnapshot,
  } as const;
  const pushDetachedSnapshot = async (
    label: string,
    nextSnapshot: DetachedPanelSnapshot,
  ): Promise<void> => {
    const registration = detachedRegistryRef.current[label];
    if (!registration || !detachedConfigMatchesSnapshot(registration.config, nextSnapshot)) return;
    registration.snapshotSequence += 1;
    const snapshot = {
      ...nextSnapshot,
      snapshotVersion: registration.snapshotSequence,
    } as DetachedPanelSnapshot;
    registration.snapshot = snapshot;
    detachedSnapshotRef.current[label] = snapshot;
    await sendDetachedSnapshot(label, snapshot, registration.snapshotSequence);
  };
  const withDetachedDocumentBusy = async (
    label: string,
    operation: (snapshot: DetachedDocumentSnapshot) => Promise<DetachedDocumentSnapshot>,
  ) => {
    const registration = detachedRegistryRef.current[label];
    if (!registration || registration.snapshot.panelId !== 'document') return;
    const current = registration.snapshot;
    if (!current.writable) {
      await pushDetachedSnapshot(label, { ...current, statusMessage: '当前项目为只读模式' });
      return;
    }
    await pushDetachedSnapshot(label, { ...current, busy: true, statusMessage: '' });
    try {
      await pushDetachedSnapshot(label, await operation(current));
    } catch (reason) {
      const latest = detachedRegistryRef.current[label]?.snapshot;
      if (latest?.panelId === 'document') {
        await pushDetachedSnapshot(label, {
          ...latest,
          busy: false,
          statusMessage: reason instanceof Error ? reason.message : '独立窗口操作失败',
        });
      }
    }
  };
  const saveDetachedDocument = (label: string) =>
    withDetachedDocumentBusy(label, async (snapshot) => {
      if (!snapshot.documentId) throw new Error('请先在独立窗口中创建文档草稿');
      if (snapshot.state === 'in_review') throw new Error('审核中的版本不可编辑');
      const saved = await callWorker('document.draft.save', {
        documentId: snapshot.documentId,
        kind: snapshot.kind as DocumentKind,
        title: snapshot.title,
        contentMarkdown: snapshot.content,
        expectedDocumentRowVersion: snapshot.rowVersion,
      });
      const history = await callWorker('document.versions', { documentId: saved.id });
      setDocuments(await callWorker('document.list', {}));
      syncMainDocumentIfSelected(saved, history);
      return {
        ...snapshot,
        title: saved.title,
        content: saved.currentVersion?.contentMarkdown ?? snapshot.content,
        state: saved.currentVersion?.state ?? 'draft',
        versions: history,
        currentVersionId: saved.currentVersionId,
        publishedVersionId: saved.publishedVersionId,
        rowVersion: saved.rowVersion,
        busy: false,
        statusMessage: `已保存草稿 v${saved.currentVersion?.version ?? '-'}`,
      };
    });
  /** Detached-window counterpart of `saveAndPublishDocument`. */
  const saveAndPublishDetachedDocument = (label: string) =>
    withDetachedDocumentBusy(label, async (snapshot) => {
      if (!snapshot.documentId) throw new Error('请先在独立窗口中创建文档草稿');
      if (snapshot.state === 'in_review') throw new Error('审核中的版本不可编辑');
      const saved = await callWorker('document.draft.save', {
        documentId: snapshot.documentId,
        kind: snapshot.kind as DocumentKind,
        title: snapshot.title,
        contentMarkdown: snapshot.content,
        expectedDocumentRowVersion: snapshot.rowVersion,
      });
      const result = await callWorker('document.selfPublish', {
        documentId: saved.id,
        documentVersionId: saved.currentVersionId,
        expectedDocumentRowVersion: saved.rowVersion,
        expectedPublishedVersionId: saved.publishedVersionId,
      });
      const history = await callWorker('document.versions', { documentId: saved.id });
      setDocuments(await callWorker('document.list', {}));
      syncMainDocumentIfSelected(result.document, history);
      return {
        ...snapshot,
        title: result.document.title,
        content: result.document.currentVersion?.contentMarkdown ?? snapshot.content,
        state: result.document.currentVersion?.state ?? 'published',
        versions: history,
        currentVersionId: result.document.currentVersionId,
        publishedVersionId: result.document.publishedVersionId,
        rowVersion: result.document.rowVersion,
        busy: false,
        statusMessage: `已发布权威版本 v${result.publication.publicationNo}`,
      };
    });
  const updateDetachedDocumentReview = (
    label: string,
    action: 'requestChanges' | 'publish' | 'restore',
    versionId?: string,
  ) =>
    withDetachedDocumentBusy(label, async (snapshot) => {
      if (!snapshot.documentId || !snapshot.currentVersionId) {
        throw new Error('当前窗口没有可审核的文档版本');
      }
      if (action === 'restore') {
        if (!versionId) throw new Error('历史版本标识缺失');
        const restored = await callWorker('document.restore', {
          documentId: snapshot.documentId,
          versionId,
        });
        const history = await callWorker('document.versions', { documentId: restored.id });
        setDocuments(await callWorker('document.list', {}));
        syncMainDocumentIfSelected(restored, history);
        return {
          ...snapshot,
          title: restored.title,
          content: restored.currentVersion?.contentMarkdown ?? '',
          state: restored.currentVersion?.state ?? 'draft',
          versions: history,
          currentVersionId: restored.currentVersionId,
          publishedVersionId: restored.publishedVersionId,
          rowVersion: restored.rowVersion,
          busy: false,
          statusMessage: `已从历史版本恢复为 v${restored.currentVersion?.version ?? '-'}`,
        };
      }
      if (action === 'requestChanges') {
        await callWorker('document.review.requestChanges', {
          documentId: snapshot.documentId,
          documentVersionId: snapshot.currentVersionId,
          expectedDocumentRowVersion: snapshot.rowVersion,
        });
      } else {
        const result = await callWorker('document.publish', {
          documentId: snapshot.documentId,
          documentVersionId: snapshot.currentVersionId,
          expectedDocumentRowVersion: snapshot.rowVersion,
          expectedPublishedVersionId: snapshot.publishedVersionId,
        });
        const history = await callWorker('document.versions', { documentId: result.document.id });
        setDocuments(await callWorker('document.list', {}));
        syncMainDocumentIfSelected(result.document, history);
        return {
          ...snapshot,
          title: result.document.title,
          content: result.document.currentVersion?.contentMarkdown ?? snapshot.content,
          state: result.document.currentVersion?.state ?? 'published',
          versions: history,
          currentVersionId: result.document.currentVersionId,
          publishedVersionId: result.document.publishedVersionId,
          rowVersion: result.document.rowVersion,
          busy: false,
          statusMessage: `已发布权威版本 v${result.publication.publicationNo}`,
        };
      }
      const refreshed = await callWorker('document.get', { documentId: snapshot.documentId });
      const history = await callWorker('document.versions', { documentId: snapshot.documentId });
      setDocuments(await callWorker('document.list', {}));
      syncMainDocumentIfSelected(refreshed, history);
      return {
        ...snapshot,
        title: refreshed.title,
        content: refreshed.currentVersion?.contentMarkdown ?? snapshot.content,
        state: refreshed.currentVersion?.state ?? snapshot.state,
        versions: history,
        currentVersionId: refreshed.currentVersionId,
        publishedVersionId: refreshed.publishedVersionId,
        rowVersion: refreshed.rowVersion,
        busy: false,
        statusMessage: '已退回修改，可继续编辑后重新发布',
      };
    });
  detachedActionHandlerRef.current = (action, label, envelope) => {
    const registration = detachedRegistryRef.current[label];
    if (!registration || registration.config.panelId !== action.panelId) return;
    if (
      (envelope.projectId && envelope.projectId !== registration.config.projectId) ||
      (envelope.entityId && envelope.entityId !== registration.config.entityId)
    )
      return;
    const sequence = envelope.sequence ?? 0;
    if (sequence <= registration.actionSequence) return;
    registration.actionSequence = sequence;
    detachedActionSequenceRef.current[label] = sequence;
    if (action.type === 'attach') {
      delete detachedRegistryRef.current[label];
      delete detachedSnapshotRef.current[label];
      delete detachedActionSequenceRef.current[label];
      setDetachedPanels((current) => {
        if (current[action.panelId] !== label) return current;
        const next = { ...current };
        delete next[action.panelId];
        return next;
      });
      workspaceDispatch({ type: 'open', panelId: action.panelId });
      void getCurrentWindow().show();
      void getCurrentWindow().setFocus();
      return;
    }
    if (action.panelId === 'document' && registration.snapshot.panelId === 'document') {
      const snapshot = registration.snapshot;
      if (action.type === 'document-title') {
        void pushDetachedSnapshot(label, { ...snapshot, title: action.value, statusMessage: '' });
      } else if (action.type === 'document-content') {
        void pushDetachedSnapshot(label, { ...snapshot, content: action.value, statusMessage: '' });
      } else if (action.type === 'document-save') {
        void saveDetachedDocument(label);
      } else if (action.type === 'document-save-publish') {
        void saveAndPublishDetachedDocument(label);
      } else if (action.type === 'document-restore') {
        void updateDetachedDocumentReview(label, 'restore', action.versionId);
      } else if (action.type === 'document-request-changes') {
        void updateDetachedDocumentReview(label, 'requestChanges');
      } else if (action.type === 'document-publish') {
        void updateDetachedDocumentReview(label, 'publish');
      } else if (action.type === 'document-unpublish') {
        void withDetachedDocumentBusy(label, async (snapshot) => {
          if (!snapshot.documentId || !snapshot.publishedVersionId)
            throw new Error('当前文档没有已发布版本');
          const next = await callWorker('document.unpublish', {
            documentId: snapshot.documentId,
            expectedDocumentRowVersion: snapshot.rowVersion,
          });
          const history = await callWorker('document.versions', { documentId: next.id });
          setDocuments(await callWorker('document.list', {}));
          syncMainDocumentIfSelected(next, history);
          return {
            ...snapshot,
            title: next.title,
            content: next.currentVersion?.contentMarkdown ?? snapshot.content,
            state: next.currentVersion?.state ?? 'draft',
            versions: history,
            currentVersionId: next.currentVersionId,
            publishedVersionId: next.publishedVersionId,
            rowVersion: next.rowVersion,
            busy: false,
            statusMessage: '已取消发布，文档已恢复为草稿，可继续编辑。',
          };
        });
      } else {
        void pushDetachedSnapshot(label, {
          ...snapshot,
          statusMessage: '新建和导入请在主工作区执行后再分离窗口',
        });
      }
      return;
    }
    // Conversation actions still use the active conversation state. Reject stale
    // window events instead of applying them to another selected conversation.
    if (
      registration.config.entityId !== conversation?.id ||
      registration.config.projectId !== project?.id
    ) {
      if (action.type === 'conversation-answer-questions')
        void emitTo(label, DETACHED_QUESTION_RESULT_EVENT, {
          requestId: action.requestId,
          error: '会话已切换，请回到原会话继续。',
        });
      return;
    }
    if (action.type === 'conversation-select') {
      const selected = conversations.find((item) => item.id === action.conversationId);
      if (selected) void selectConversation(selected);
    } else if (action.type === 'conversation-create') {
      void createConversation();
    } else if (action.type === 'conversation-retry') {
      void retryGeneration(action.messageId);
    } else if (action.type === 'conversation-profile') {
      setSelectedLlmProfileId(action.profileId);
      setSelectedLlmModelId(
        llmModels.find((model) => model.providerProfileId === action.profileId)?.id ?? '',
      );
    } else if (action.type === 'conversation-model') {
      setSelectedLlmModelId(action.modelId);
    } else if (action.type === 'conversation-research-mode') {
      setResearchMode(action.mode);
    } else if (action.type === 'conversation-open-settings') {
      openSettings('providers');
      void getCurrentWindow().setFocus();
    } else if (action.type === 'conversation-composer') {
      setAgentModelSelection(undefined);
      setComposer(action.value);
    } else if (action.type === 'conversation-prompt-template') {
      conversationPromptTemplate.change(action.value);
    } else if (action.type === 'conversation-prompt-template-save') {
      void saveConversationPromptTemplate();
    } else if (action.type === 'conversation-prompt-template-reload') {
      void conversationPromptTemplate.reload().catch(() => undefined);
    } else if (action.type === 'conversation-cancel') {
      void cancelGeneration();
    } else if (action.type === 'conversation-send') {
      setComposer(action.value);
      void sendMessage(action.value);
    } else if (action.type === 'conversation-answer-questions') {
      void continueQuestionForm(action.result).then(
        () => emitTo(label, DETACHED_QUESTION_RESULT_EVENT, { requestId: action.requestId }),
        (reason: Error) => {
          setChatMessage(reason.message);
          return emitTo(label, DETACHED_QUESTION_RESULT_EVENT, {
            requestId: action.requestId,
            error: reason.message,
          });
        },
      );
    }
  };
  useEffect(() => {
    for (const registration of Object.values(detachedRegistryRef.current)) {
      const snapshot = currentDetachedSnapshots[registration.config.panelId];
      if (!snapshot || !detachedConfigMatchesSnapshot(registration.config, snapshot)) continue;
      if (registration.snapshot === snapshot) continue;
      registration.snapshotSequence += 1;
      const nextSnapshot = {
        ...snapshot,
        snapshotVersion: registration.snapshotSequence,
      } as DetachedPanelSnapshot;
      registration.snapshot = nextSnapshot;
      detachedSnapshotRef.current[registration.config.label] = nextSnapshot;
      void sendDetachedSnapshot(
        registration.config.label,
        nextSnapshot,
        registration.snapshotSequence,
      );
    }
  }, [
    project?.id,
    document?.id,
    documentTitle,
    documentContent,
    documentKind,
    document?.rowVersion,
    document?.currentVersionId,
    document?.publishedVersionId,
    contentBusy,
    contentMessage,
    versions,
    conversation?.id,
    composer,
    messages,
    chatMessage,
    generation?.generationId,
    generation?.status,
    agentTask,
    liveAgentActions,
    scopeType,
    selectedLlmProfileId,
    selectedLlmModelId,
    researchMode,
    conversationPromptTemplate.content,
    conversationPromptTemplate.busy,
    conversationPromptTemplate.loading,
    conversationPromptTemplate.error,
    conversationPromptTemplate.dirty,
  ]);
  useEffect(() => {
    if (!isTauriRuntime()) return () => undefined;
    const readyListener = listen<DetachedPanelEnvelope<DetachedPanelConfig>>(
      DETACHED_PANEL_READY_EVENT,
      (event) => {
        const config = event.payload.payload;
        const registration = detachedRegistryRef.current[event.payload.label];
        if (
          !registration ||
          registration.config.sessionId !== config.sessionId ||
          registration.config.projectId !== config.projectId ||
          registration.config.panelId !== config.panelId ||
          registration.config.entityId !== config.entityId
        )
          return;
        void sendDetachedSnapshot(
          event.payload.label,
          registration.snapshot,
          registration.snapshotSequence,
        );
      },
    );
    const actionListener = listen<DetachedPanelEnvelope<DetachedPanelAction>>(
      DETACHED_PANEL_ACTION_EVENT,
      (event) =>
        detachedActionHandlerRef.current(event.payload.payload, event.payload.label, event.payload),
    );
    return () => {
      void readyListener.then((stop) => stop());
      void actionListener.then((stop) => stop());
    };
  }, []);
  const conversationPanel = (
    <ChatPanel
      scopeType={scopeType}
      scopeAvailable={scopeAvailable}
      writable={writable}
      conversations={conversations}
      conversation={conversation}
      showArchivedConversations={showArchivedConversations}
      onShowArchivedConversationsChange={setShowArchivedConversations}
      messages={messages}
      composer={composer}
      statusMessage={chatMessage}
      llmStatus={displayedLlmStatus}
      legacyLlmConfigured={llmStatus?.configurationSource === 'environment'}
      llmProfiles={llmProfiles}
      llmModels={llmModels}
      selectedLlmProfileId={selectedLlmProfileId}
      selectedLlmModelId={selectedLlmModelId}
      researchMode={researchMode}
      promptTemplate={conversationPromptTemplate.content}
      onPromptTemplateChange={conversationPromptTemplate.change}
      onSavePromptTemplate={() => void saveConversationPromptTemplate()}
      promptTemplateBusy={conversationPromptTemplate.busy}
      promptTemplateLoading={conversationPromptTemplate.loading}
      promptTemplateError={conversationPromptTemplate.error}
      promptTemplateDirty={conversationPromptTemplate.dirty}
      onReloadPromptTemplate={() => void conversationPromptTemplate.reload().catch(() => undefined)}
      contextPreview={contextPreview}
      generation={generation?.conversationId === conversation?.id ? generation : undefined}
      agentTask={agentTask}
      agentTasks={conversationAgentTasks}
      liveAgentActions={liveAgentActions}
      activeVideoTaskCount={projectTasks?.activeCount ?? 0}
      agentModelSelection={agentModelSelection}
      mediaReferenceImageInputs={activeMediaInputsRef.current}
      onSelectAgentModel={(providerProfileId, modelId) => {
        const pending = agentModelSelection;
        setSelectedLlmProfileId(providerProfileId);
        setSelectedLlmModelId(modelId);
        if (pending) {
          setAgentModelPreferences((current) => ({
            ...current,
            [conversation?.id ?? '']: {
              ...current[conversation?.id ?? ''],
              text: { providerProfileId, modelId },
            },
          }));
          void sendMessage(pending.composerPrompt ?? pending.prompt, {
            providerProfileId,
            modelId,
          });
        }
      }}
      onConfirmAgentAction={(approved) =>
        currentConfirmation && confirmationQueue.current!.decide(currentConfirmation.key, approved)
      }
      onOpenProtectedUi={openAgentProtectedUi}
      onSelectMediaModel={(selection) =>
        currentConfirmation && confirmationQueue.current!.decide(currentConfirmation.key, selection)
      }
      onCancelMediaModelSelection={() =>
        currentConfirmation && confirmationQueue.current!.decide(currentConfirmation.key, undefined)
      }
      onOpenLibrarySource={openLibrarySource}
      onOpenReviewTarget={(projectId, target) => void openReviewTarget(projectId, target)}
      onConfirmSchemaProposal={(adapterKey, version) => {
        void confirmSchemaProposal(adapterKey, version);
      }}
      onRejectSchemaProposal={(adapterKey, version) => {
        void rejectSchemaProposal(adapterKey, version);
      }}
      onOpenTaskLog={() => {
        openProjectView('tasks');
      }}
      onContinueAgentTask={() => {
        const prompt = '请继续完成尚未成功的短剧交付物，并调用已授权工具。';
        setComposer(prompt);
        if (conversation) void sendMessage(prompt);
      }}
      onAnswerQuestions={continueQuestionForm}
      onClose={() => workspaceDispatch({ type: 'close', panelId: 'conversation' })}
      showCloseAction={false}
      showHeading={false}
      onSelectConversation={(selected) => void selectConversation(selected)}
      onCreateConversation={() => void createConversation()}
      onRenameConversation={(conversationId, title) =>
        void renameConversation(conversationId, title)
      }
      onArchiveConversation={(conversationId) => void archiveConversation(conversationId)}
      onRestoreConversation={(conversationId) => void restoreConversation(conversationId)}
      canLoadMoreConversations={Boolean(conversationNextCursor)}
      onLoadMoreConversations={() => void loadMoreConversations()}
      canLoadEarlierMessages={Boolean(messageNextCursor)}
      loadingEarlierMessages={loadingEarlierMessages}
      onLoadEarlierMessages={() => void loadEarlierMessages()}
      onRetryGeneration={(messageId) => void retryGeneration(messageId)}
      onLlmProfileChange={(profileId) => {
        setSelectedLlmProfileId(profileId);
        setSelectedLlmModelId(
          llmModels.find((model) => model.providerProfileId === profileId)?.id ?? '',
        );
      }}
      onLlmModelChange={setSelectedLlmModelId}
      onResearchModeChange={setResearchMode}
      onOpenProviderSettings={() => {
        setSettingsInitialPage('providers');
        setSettingsOpen(true);
      }}
      onComposerChange={(value) => {
        setAgentModelSelection(undefined);
        setComposer(value);
      }}
      attachments={chatAttachments}
      attachmentsPending={chatAttachmentsPending}
      onAddAttachments={(files) => void addChatAttachments(files)}
      onAddAssetAttachments={(raw) => {
        if (!project || !conversation || !writable || conversation.archivedAt) return;
        const projectId = project.id;
        void addChatAttachments(() =>
          assetAttachmentFiles(
            raw,
            projectId,
            MAX_CHAT_ATTACHMENT_BYTES,
            MAX_CHAT_TOTAL_BYTES,
            MAX_CHAT_ATTACHMENTS,
          ),
        );
      }}
      onRemoveAttachment={removeChatAttachment}
      onCancelGeneration={() => void cancelGeneration()}
      allowConcurrentTasks={Boolean(selectedLlmProfile && selectedLlmModel)}
      onSendMessage={() => void sendMessage(composer, undefined, composer, conversation, true)}
      agentParameterRequest={agentParameterRequest}
      onSubmitAgentParameters={(adapterKey, parameters) => {
        const pending = agentParameterRequest;
        if (!pending) return;
        const imageInputs = collectReferenceImageInputs(chatAttachments);
        const videoInputs = chatAttachments
          .filter((attachment) => attachment.kind === 'video' && attachment.dataUrl)
          .flatMap((attachment) => (attachment.dataUrl ? [attachment.dataUrl] : []));
        const selectedAdapter = pending.adapters.find((adapter) => adapter.key === adapterKey);
        const adapterProperties = selectedAdapter?.parameterSchema.properties ?? {};
        let adapterParameters = { ...parameters };
        if (
          imageInputs.length > 0 &&
          Object.prototype.hasOwnProperty.call(adapterProperties, 'images')
        ) {
          const existingImages = Array.isArray(adapterParameters.images)
            ? adapterParameters.images
                .map((input) =>
                  typeof input === 'string'
                    ? input.trim().startsWith('https://')
                      ? input.trim()
                      : normalizeImageDataUrl(input)
                    : undefined,
                )
                .filter((input): input is string => Boolean(input))
            : [];
          adapterParameters = {
            ...adapterParameters,
            images: [
              ...existingImages,
              ...imageInputs.filter((input) => !existingImages.includes(input)),
            ],
          };
        }
        const videoField = ['video', 'video_url', 'videoUrl'].find((key) =>
          Object.prototype.hasOwnProperty.call(adapterProperties, key),
        );
        const videoInput = videoInputs[0];
        if (videoInput && videoField) {
          adapterParameters = {
            ...adapterParameters,
            [videoField]: videoInput,
          };
        }
        setAgentParameterRequest(undefined);
        void sendMessage(
          pending.composerPrompt,
          {
            providerProfileId: pending.providerProfileId,
            modelId: pending.modelId,
            adapterKey,
            parameters: adapterParameters,
          },
          pending.composerPrompt,
        );
      }}
    />
  );
  const productionPanel =
    activeVoiceDesign && project && documentBindings?.voiceDocumentId ? (
      <VoiceDesignPanel
        key={voiceDesignKey}
        projectId={project.id}
        character={activeVoiceDesign.character}
        voiceDocumentId={documentBindings.voiceDocumentId}
        writable={documentEditorWritable && !contentBusy}
        onClose={() => {
          setVoiceDesignTarget(undefined);
          setNavigationMode('project');
        }}
        onRequestApproval={requestMediaSubmissionApproval}
      />
    ) : (
      <ProductionPanel
        key={
          productionSeed?.continuityRevision === undefined
            ? 'production'
            : `continuity:${productionSeed.shotId}:${productionSeed.continuityRevision}`
        }
        expanded
        capability={productionCapability}
        projectId={project?.id}
        projectSessionId={workerScope(project?.id)?.projectSessionId}
        onRequestSubmissionApproval={requestMediaSubmissionApproval}
        projectViewEpoch={project}
        seedEventKey={productionSeed}
        shotId={
          productionSeed?.documentId || productionSeed?.sceneId || productionSeed?.audioReference
            ? undefined
            : (productionSeed?.shotId ?? shot?.id)
        }
        sourceDocumentId={productionSeed?.documentId}
        sceneId={productionSeed?.sceneId}
        seedPrompt={productionSeed?.prompt}
        seedParameters={productionSeed?.seedParameters}
        audioReference={productionSeed?.audioReference}
        seedImages={productionSeed?.images}
        seedReferenceBindings={productionSeed?.referenceBindings}
        seedImageBindings={productionSeed?.inputImages}
        preferredAssetKind={productionSeed?.assetKind}
        writable={writable}
        assets={assets}
        videoJobs={projectTasks?.videoJobs ?? []}
        imageJobs={projectTasks?.imageJobs ?? []}
        focusedJobId={focusedSource?.jobId}
        onAssetsChanged={updateAssets}
        onOpenAssetLibrary={(assetId) => {
          updateAssets(assets, assetId);
          openProjectView('assets', assetId);
        }}
        onOpenProviderSettings={() => openSettings('providers')}
        providerSettingsRevision={providerSettingsRevision}
      />
    );
  const documentMatchesWorkspace =
    document?.domainScope !== 'novel' &&
    (view === 'characters'
      ? CHARACTER_DOCUMENT_KINDS.includes(documentKind)
      : !CHARACTER_DOCUMENT_KINDS.includes(documentKind));
  const hasForeignDocument =
    !documentMatchesWorkspace && Boolean(document || documentTitle || documentContent);
  const workspaceKinds = view === 'characters' ? CHARACTER_DOCUMENT_KINDS : SCRIPT_DOCUMENT_KINDS;
  const visibleDocuments = documents.filter(
    (item) =>
      item.domainScope !== 'novel' &&
      workspaceKinds.includes(item.kind) &&
      matchesDocumentFilter(item, documentKindFilter),
  );
  const visibleArchivedDocuments = (archivedDocuments ?? []).filter(
    (item) =>
      item.domainScope !== 'novel' &&
      workspaceKinds.includes(item.kind) &&
      matchesDocumentFilter(item, documentKindFilter),
  );
  const documentBatch = useDraftDocumentBatch({
    items: documents.filter((item) => item.domainScope !== 'novel'),
    visibleItems: documentDirectoryMode === 'active' ? visibleDocuments : [],
    writable,
    busy: contentBusy,
    resetKey: `${project?.id ?? ''}:${view}:${documentDirectoryMode}`,
    dirtyDocumentId: documentDirty ? document?.id : undefined,
    onDeleted: async (_items, archived) => {
      await docs.applyArchivedDocuments(archived);
    },
  });
  const restoreArchivedDocumentFromDirectory = async (item: DocumentSummary) => {
    const restored = await restoreArchivedDocument(item);
    if (!restored) return;
    setDocumentDirectoryMode('active');
    setDocumentKindFilter(restored.kind);
  };
  /**
   * A new document adopts the active kind filter so that it lands in the list
   * the user is looking at. With no filter it defaults to `outline`, the
   * primary project-document kind, rather than a `note` that the merged list
   * would not show.
   */
  const newDocumentOfActiveKind = () => {
    if (newDocument() === false) return;
    setDocumentKind(
      documentKindFilter === 'all'
        ? view === 'characters'
          ? 'character'
          : 'outline'
        : documentKindFilter,
    );
  };
  const moveDocumentToNovel = async () => {
    if (!document || !writable || contentBusy) return;
    setContentBusy(true);
    try {
      if (
        document.title !== documentTitle ||
        document.kind !== documentKind ||
        (document.currentVersion?.contentMarkdown ?? '') !== documentContent
      ) {
        const saved = await saveDocument();
        if (!saved) return;
        setContentBusy(true);
      }
      const bindings = await callWorker('novel.binding.list', { includeNeedsReview: true });
      const binding = bindings.find((item) => item.documentId === document.id);
      await callWorker('novel.binding.save', {
        bindingId: binding?.id,
        expectedRowVersion: binding?.rowVersion,
        documentId: document.id,
        role: 'work-outline',
        domainScope: 'novel',
        status: 'active',
      });
      const rows = await callWorker('document.list', {});
      setDocuments(rows);
      await openDocumentById(document.id, rows);
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '移动小说资料失败');
    } finally {
      setContentBusy(false);
    }
  };
  const renderDocumentToolbar = (
    eyebrow: string,
    fallbackTitle: string,
    options?: {
      compact?: boolean;
      showImport?: boolean;
      showNew?: boolean;
      showHeading?: boolean;
      readOnly?: boolean;
      useDocumentTitle?: boolean;
      showProductionGenerate?: boolean;
      productionGenerateImage?: boolean;
      productionGenerateLabel?: string;
      productionGenerateTitle?: string;
      productionGenerateDisabled?: boolean;
      onGenerateProduction?: () => void;
    },
  ) => (
    <div
      className={`workspace-toolbar document-workspace-toolbar${options?.compact ? ' is-compact' : ''}`}
    >
      <div>
        <span className="eyebrow">{eyebrow}</span>
        {options?.showHeading === false ? null : (
          <h1>
            {options?.readOnly ||
            options?.compact ||
            options?.useDocumentTitle === false ||
            hasForeignDocument
              ? fallbackTitle
              : (document?.title ?? fallbackTitle)}
          </h1>
        )}
      </div>
      <div className="toolbar-actions">
        {!options?.readOnly && (
          <>
            {view === 'documents' &&
              document?.kind === 'outline' &&
              document.scopeType === 'project' &&
              !hasForeignDocument && (
                <button
                  className="button secondary"
                  type="button"
                  disabled={!documentEditorWritable || contentBusy}
                  onClick={() => void moveDocumentToNovel()}
                >
                  <BookOpen size={15} /> 移至小说资料
                </button>
              )}
            {options?.showImport === false ? null : (
              <button
                className="button secondary markdown-import-button"
                type="button"
                aria-label="导入 Markdown"
                title="导入 Markdown"
                onClick={() => void importMarkdownDocument()}
                disabled={!writable || contentBusy}
              >
                <FileUp size={15} />
                <span>导入 Markdown</span>
              </button>
            )}
            {options?.showNew === false ? null : (
              <button
                className="button secondary"
                type="button"
                onClick={newDocumentOfActiveKind}
                disabled={!writable}
              >
                <FilePlus2 size={15} />
                新建
              </button>
            )}
            <button
              className="button secondary"
              type="button"
              onClick={() => void saveAndPublishDocument()}
              disabled={
                hasForeignDocument ||
                !documentEditorWritable ||
                contentBusy ||
                !documentTitle.trim()
              }
              title="保存当前内容并直接发布为权威版本"
            >
              <Save size={15} />
              保存并发布
            </button>
            <button
              className="button secondary"
              type="button"
              onClick={() => void saveDocument()}
              disabled={
                hasForeignDocument ||
                !documentEditorWritable ||
                contentBusy ||
                !documentTitle.trim()
              }
            >
              保存草稿
            </button>
            {document?.publishedVersionId && !hasForeignDocument && (
              <button
                className="button secondary"
                type="button"
                onClick={() => void unpublishDocument()}
                disabled={!writable || contentBusy}
                title="取消发布并恢复为草稿"
              >
                取消发布
              </button>
            )}
            {!hasForeignDocument &&
              !document?.publishedVersionId &&
              document?.currentVersion?.state === 'in_review' && (
                <>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => void requestDocumentChanges()}
                    disabled={!writable || contentBusy}
                  >
                    退回修改
                  </button>
                  <button
                    className="button primary"
                    type="button"
                    onClick={() => void publishDocument()}
                    disabled={!writable || contentBusy}
                  >
                    发布
                  </button>
                </>
              )}
            {options?.showProductionGenerate && (
              <button
                className="button primary production-generate-button"
                type="button"
                onClick={options.onGenerateProduction}
                disabled={options.productionGenerateDisabled}
                title={
                  options.productionGenerateTitle ?? '根据当前剧本文档生成可编辑的制作资料草稿'
                }
              >
                {options.productionGenerateImage ? (
                  <Image size={14} aria-hidden="true" />
                ) : (
                  <ListChecks size={14} aria-hidden="true" />
                )}
                {options.productionGenerateLabel ?? '一键生成制作资料'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
  const openCharacterSceneImageProduction = async (sceneReference?: SceneReferenceImageOptions) => {
    if (!documentContent.trim() || documentKind === 'voice') return;
    const referenceAsset =
      documentKind === 'scene' && sceneReference?.referenceAssetId
        ? linkedAssets.find((asset) => asset.id === sceneReference.referenceAssetId)
        : undefined;
    if (documentKind === 'scene' && sceneReference?.referenceAssetId && !referenceAsset) {
      setContentMessage('场景参考图已不可用，请重新选择。');
      return;
    }
    let documentId = document?.id;
    if (!documentId) {
      if (!documentTitle.trim()) return;
      const saved = await saveDocument();
      if (!saved) return;
      documentId = saved.id;
    }
    setProductionSeed({
      documentId,
      prompt:
        documentKind === 'scene'
          ? composeSceneReferenceImagePrompt(documentContent)
          : documentContent.trim(),
      assetKind:
        documentKind === 'prop' ? 'prop' : documentKind === 'scene' ? 'scene' : 'character',
      ...(documentKind === 'scene'
        ? {
            images: referenceAsset ? [`project-asset://${referenceAsset.id}`] : [],
            inputImages: referenceAsset
              ? [{ assetId: referenceAsset.id, role: 'reference' as const }]
              : [],
          }
        : {}),
    });
    setProductionCapability(referenceAsset ? 'REFERENCE_TO_IMAGE' : 'TEXT_TO_IMAGE');
  };
  const renderDocumentEditor = () =>
    hasForeignDocument ? (
      <EmptyWorkspace title="请选择文档" />
    ) : view === 'characters' ? (
      <CharacterSceneWorkspace
        projectId={project?.id}
        documentId={document?.id}
        title={documentTitle}
        kind={CHARACTER_DOCUMENT_KINDS.includes(documentKind) ? documentKind : 'character'}
        content={documentContent}
        sampleText={documentSampleText}
        onSampleTextChange={setDocumentSampleText}
        defaultVoiceId={documentBindings?.voiceDocumentId}
        voiceDocuments={documents.filter(
          (d) => d.kind === 'voice' && d.lifecycleStatus === 'active',
        )}
        onDefaultVoiceChange={(voiceDocumentId) => {
          const base = {
            ...(documentBindings ?? {
              schemaVersion: 1 as const,
            }),
          };
          delete base.voiceDocumentId;
          setDocumentBindings({ ...base, ...(voiceDocumentId ? { voiceDocumentId } : {}) });
        }}
        voicePrompt={characterVoicePrompt}
        onGenerateVoice={() => void openVoiceDesign()}
        writable={documentEditorWritable && !contentBusy}
        versions={versions}
        currentVersionId={document?.currentVersionId}
        message={contentMessage}
        assets={linkedAssets}
        boundScenes={scenes.filter((item) =>
          documentKind === 'scene'
            ? Boolean(
                document?.id &&
                (item.sceneDocumentId === document.id ||
                  item.sceneDocumentIds?.includes(document.id) ||
                  shotReferenceDocuments[item.id]?.sceneDocumentIds.includes(document.id)),
              )
            : documentKind === 'character' &&
              Boolean(
                document?.id &&
                (item.characterBindings?.some(
                  (binding) => binding.characterDocumentId === document.id,
                ) ||
                  shotReferenceDocuments[item.id]?.characterDocumentIds.includes(document.id)),
              ),
        )}
        onOpenScene={(id) => {
          const target = scenes.find((item) => item.id === id);
          if (target) void selectScene(target);
        }}
        onContentChange={setDocumentContent}
        onRestoreVersion={(versionId) => void restoreVersion(versionId)}
        sceneReference={activeCharacterSceneReference}
        onSceneReferenceChange={(sceneReference) => {
          setCharacterSceneReference({ key: characterSceneReferenceKey, options: sceneReference });
        }}
        onOpenAsset={(assetId) => {
          updateAssets(assets, assetId);
          openProjectView('assets', assetId);
        }}
      />
    ) : (
      <ScriptWorkspace
        content={documentContent}
        writable={documentEditorWritable && !contentBusy}
        versions={versions}
        currentVersionId={document?.currentVersionId}
        message={contentMessage}
        onContentChange={setDocumentContent}
        onRestoreVersion={(versionId) => void restoreVersion(versionId)}
      />
    );
  const startupMode = !project;
  return (
    <div
      className="app-shell"
      data-left-open={leftOpen}
      data-navigation-mode={navigationMode}
      data-theme={startupMode ? 'light' : undefined}
      data-startup={project ? 'false' : 'true'}
    >
      <header
        className="topbar"
        data-tauri-drag-region
        onDoubleClick={(event) => {
          if ((event.target as HTMLElement).closest('button')) return;
          if (!isTauriRuntime()) return;
          void getCurrentWindow().toggleMaximize();
        }}
      >
        <div className="brand-mark" aria-hidden="true" data-tauri-drag-region>
          <img src={brandLogo} alt="" data-tauri-drag-region />
        </div>
        <div className="project-title" data-tauri-drag-region>
          <strong data-tauri-drag-region>unicomp</strong>
        </div>
        <span className="topbar-divider" aria-hidden="true" />
        <div className="project-picker-wrap" ref={projectPickerRef}>
          <button
            className="project-picker"
            type="button"
            aria-label="选择项目"
            title={project?.rootPath ?? '选择要打开的项目'}
            aria-haspopup="menu"
            aria-expanded={projectPickerOpen}
            onClick={() => setProjectPickerOpen((open) => !open)}
          >
            <FolderOpen size={15} />
            <span className="project-picker-copy">
              <strong>{project?.name ?? '未打开项目'}</strong>
            </span>
            <ChevronDown size={14} />
          </button>
          {projectPickerOpen && (
            <ProjectPickerMenu
              recentProjects={recentProjects}
              currentProject={project}
              writable={writable}
              busy={projectBusy}
              onOpenProject={(rootPath) => void openProject(rootPath)}
              onBrowse={() => {
                setProjectPickerOpen(false);
                void selectProjectDirectory(true);
              }}
              onCreate={() => {
                setProjectPickerOpen(false);
                setProjectCreateOpen(true);
              }}
              onRename={openProjectRename}
              onCheckIntegrity={() => {
                setProjectPickerOpen(false);
                void runProjectAction(async () => {
                  const result = await callWorker('project.integrity', {});
                  return result.ok
                    ? `完整性检查通过 · Schema v${result.schemaVersion}`
                    : result.messages.join('; ');
                });
              }}
              onBackup={() => {
                setProjectPickerOpen(false);
                void runProjectAction(
                  async () => `备份完成：${(await callWorker('project.backup', {})).path}`,
                );
              }}
              onCloseProject={() => void closeProject()}
            />
          )}
        </div>
        {project && projectMessage && (
          <small className="project-message topbar-project-message" role="status">
            {projectMessage}
          </small>
        )}
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            title="设置中心"
            aria-expanded={settingsOpen}
            onClick={() => openSettings()}
          >
            <Settings2 size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            title={conversationToggleCopy.title}
            aria-label={conversationToggleCopy.ariaLabel}
            aria-pressed={conversationWindowPresented}
            onClick={toggleConversationWindow}
          >
            <MessageSquare size={17} />
          </button>
        </div>
        <div className="window-controls" aria-label="窗口控制">
          <button
            type="button"
            title="最小化"
            aria-label="最小化窗口"
            onClick={() => {
              if (isTauriRuntime()) void getCurrentWindow().minimize();
            }}
          >
            <Minus size={15} />
          </button>
          <button
            type="button"
            title={windowMaximized ? '还原' : '最大化'}
            aria-label={windowMaximized ? '还原窗口' : '最大化窗口'}
            onClick={() => {
              if (isTauriRuntime()) void getCurrentWindow().toggleMaximize();
            }}
          >
            {windowMaximized ? <Copy size={13} /> : <Square size={13} />}
          </button>
          <button
            className="window-close"
            type="button"
            title="关闭"
            aria-label="关闭窗口"
            onClick={() => {
              if (isTauriRuntime()) void getCurrentWindow().close();
            }}
          >
            <X size={16} />
          </button>
        </div>
      </header>

      {settingsOpen && (
        <SettingsCenter
          initialPage={settingsInitialPage}
          providerFocusId={providerSettingsFocusId}
          onClose={closeSettings}
          maintenance={
            <MaintenanceDialog
              embedded
              hasProject={Boolean(project)}
              writable={writable}
              busy={maintenance.maintenanceBusy}
              message={maintenance.maintenanceMessage}
              cacheInspection={maintenance.cacheInspection}
              metrics={maintenance.workerMetrics}
              onRefreshMetrics={() => void maintenance.refreshMetrics()}
              diagnosticExport={maintenance.diagnosticExport}
              exportDestination={maintenance.exportDestination}
              diagnosticDestination={maintenance.diagnosticDestination}
              restoreBackupPath={maintenance.restoreBackupPath}
              restoreDestination={maintenance.restoreDestination}
              onClose={closeSettings}
              onIntegrity={() => void maintenance.checkIntegrity()}
              onBackup={() => void maintenance.backupProject()}
              onExportDestinationChange={maintenance.setExportDestination}
              onExportProject={() => void maintenance.exportProject()}
              onInspectCache={() => void maintenance.inspectCache()}
              onClearCache={() => void maintenance.clearCache()}
              onCleanupContextSnapshots={() => void maintenance.cleanupContextSnapshots()}
              onDiagnosticDestinationChange={maintenance.setDiagnosticDestination}
              onExportDiagnostics={() => void maintenance.exportDiagnostics()}
              onRevealDiagnostics={() => void maintenance.revealDiagnostics()}
              onRestoreBackupPathChange={maintenance.setRestoreBackupPath}
              onRestoreDestinationChange={maintenance.setRestoreDestination}
              onRestoreProject={() => void maintenance.restoreProject()}
            />
          }
        />
      )}

      {project && projectCreateOpen && (
        <ProjectCreateDialog
          recentProjects={recentProjects}
          startupLoaded={startupLoaded}
          projectName={projectName}
          projectPath={projectPath}
          projectMessage={projectMessage}
          projectBusy={projectBusy}
          onClose={() => setProjectCreateOpen(false)}
          onProjectNameChange={setProjectName}
          onProjectPathChange={setProjectPath}
          onBrowse={() => void selectProjectDirectory()}
          onCreateProject={() => void createProject()}
          onCreateSampleProject={() => void createSampleProject()}
        />
      )}

      {projectRenameOpen && project && (
        <div
          className="dialog-backdrop"
          role="presentation"
          style={{ zIndex: MODAL_Z_INDEX }}
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !projectRenameBusy)
              setProjectRenameOpen(false);
          }}
        >
          <form
            className="project-rename-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="project-rename-title"
            onSubmit={(event) => {
              event.preventDefault();
              void renameProject();
            }}
          >
            <header>
              <h2 id="project-rename-title">修改项目名称</h2>
              <button
                className="icon-button subtle"
                type="button"
                title="关闭"
                aria-label="关闭修改项目名称"
                disabled={projectRenameBusy}
                onClick={() => setProjectRenameOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            <label htmlFor="project-rename-input">项目名称</label>
            <input
              id="project-rename-input"
              autoFocus
              maxLength={200}
              value={projectRenameValue}
              onChange={(event) => setProjectRenameValue(event.target.value)}
              disabled={projectRenameBusy}
            />
            {projectRenameError && (
              <small className="project-rename-error" role="alert">
                {projectRenameError}
              </small>
            )}
            <div className="project-rename-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setProjectRenameOpen(false)}
                disabled={projectRenameBusy}
              >
                取消
              </button>
              <button
                className="button primary"
                type="submit"
                disabled={projectRenameBusy || !projectRenameValue.trim()}
              >
                {projectRenameBusy ? '保存中…' : '保存'}
              </button>
            </div>
          </form>
        </div>
      )}

      {documentCloseConfirmation && (
        <div className="dialog-backdrop" role="presentation" style={{ zIndex: MODAL_Z_INDEX }}>
          <section
            className="document-close-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-close-title"
          >
            <h2 id="document-close-title">保存文档更改？</h2>
            <p>关闭编辑器不会删除文档，但未保存的更改需要先处理。</p>
            <div className="document-close-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => setDocumentCloseConfirmation(false)}
              >
                取消
              </button>
              <button type="button" className="button secondary" onClick={discardDocumentChanges}>
                放弃更改
              </button>
              <button
                type="button"
                className="button primary"
                onClick={() => void saveAndCloseDocument()}
                disabled={contentBusy || !documentTitle.trim()}
              >
                保存并关闭
              </button>
            </div>
          </section>
        </div>
      )}

      {documentBatch.dialog}

      {documentArchiveConfirmation && documentArchiveTarget && (
        <div className="dialog-backdrop" role="presentation" style={{ zIndex: MODAL_Z_INDEX }}>
          <section
            className="document-close-dialog document-archive-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="document-archive-title"
          >
            <h2 id="document-archive-title">归档文档？</h2>
            <p>
              将“
              {document?.id === documentArchiveTarget.id
                ? documentTitle || document.title
                : documentArchiveTarget.title}
              ”移入已归档文档。归档不会删除内容，之后可以恢复。
            </p>
            {document?.id === documentArchiveTarget.id && documentDirty && (
              <p className="document-archive-dirty-note">
                当前编辑含未保存更改。放弃后只会归档最近一次保存的版本。
              </p>
            )}
            {document?.id === documentArchiveTarget.id &&
              !documentEditorWritable &&
              documentDirty && (
                <p className="document-archive-dirty-note" role="alert">
                  当前版本不可保存，请放弃未保存更改后归档。
                </p>
              )}
            {contentMessage && (
              <p className="document-archive-error" role="alert">
                {contentMessage}
              </p>
            )}
            <div className="document-close-actions">
              <button
                type="button"
                className="button secondary"
                onClick={() => {
                  setDocumentArchiveConfirmation(false);
                  setDocumentArchiveTarget(undefined);
                }}
                disabled={contentBusy}
              >
                取消
              </button>
              {document?.id === documentArchiveTarget.id && documentDirty ? (
                <>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => void confirmArchiveDocument(false)}
                    disabled={contentBusy}
                  >
                    放弃更改并归档
                  </button>
                  <button
                    type="button"
                    className="button primary"
                    onClick={() => void confirmArchiveDocument(true)}
                    disabled={contentBusy || !documentEditorWritable || !documentTitle.trim()}
                  >
                    <Save size={15} />
                    保存并归档
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  onClick={() => void confirmArchiveDocument(false)}
                  disabled={contentBusy}
                >
                  <Archive size={15} />
                  归档文档
                </button>
              )}
            </div>
          </section>
        </div>
      )}

      {currentConfirmation && (
        <TaskConfirmationDialog
          item={currentConfirmation}
          count={confirmationItems.length}
          onDecide={(key, decision) => confirmationQueue.current!.decide(key, decision)}
          onOpenProtectedUi={openAgentProtectedUi}
        />
      )}

      <ResizableAppLayout
        key={workerScope(project?.id)?.projectSessionId ?? project?.id}
        projectId={project?.id}
        startupMode={startupMode}
        sidebarOpen={leftOpen}
        onSidebarOpenChange={setLeftOpen}
        sidebar={
          <aside className="project-rail panel-border">
            <div className="panel-heading">
              <span>项目资料</span>
              <button
                className="icon-button subtle"
                type="button"
                title="收起项目导航"
                onClick={() => setLeftOpen(false)}
              >
                <PanelLeftClose size={16} />
              </button>
            </div>
            <nav className="project-nav" aria-label="项目导航">
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'novel' ? 'active' : ''}`}
                type="button"
                disabled={!project}
                onClick={() => openProjectView('novel')}
              >
                <BookOpen size={16} />
                <span>小说</span>
              </button>
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'documents' ? 'active' : ''}`}
                type="button"
                disabled={!project}
                onClick={() => openProjectView('documents')}
              >
                <FileText size={16} />
                <span>剧本</span>
                <span className="count">
                  {
                    documents.filter(
                      (item) =>
                        item.domainScope !== 'novel' && SCRIPT_DOCUMENT_KINDS.includes(item.kind),
                    ).length
                  }
                </span>
              </button>
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'characters' ? 'active' : ''}`}
                type="button"
                disabled={!project}
                onClick={() => openProjectView('characters')}
              >
                <Users size={16} />
                <span>角色与场景</span>
                <span className="count">
                  {
                    documents.filter(
                      (item) =>
                        item.domainScope !== 'novel' &&
                        CHARACTER_DOCUMENT_KINDS.includes(item.kind),
                    ).length
                  }
                </span>
              </button>
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'shots' ? 'active' : ''}`}
                type="button"
                disabled={!project}
                onClick={() => openProjectView('shots')}
              >
                <Clapperboard size={16} />
                <span>场次与镜头</span>
                <span className="count">{shots.length}</span>
              </button>
              <button
                className={`nav-item ${workspaceLayout.panels.assets.open ? 'active' : ''}`}
                aria-pressed={workspaceLayout.panels.assets.open}
                type="button"
                disabled={!project}
                onClick={() => openProjectView('assets')}
              >
                <Image size={16} />
                <span>素材库</span>
                <span className="count">{assets.length}</span>
              </button>
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'tasks' ? 'active' : ''}`}
                type="button"
                disabled={!project}
                onClick={() => openProjectView('tasks')}
              >
                <ListChecks size={16} />
                <span>任务日志</span>
              </button>
            </nav>

            <ProductionNavigation
              capability={productionCapability}
              disabled={!project}
              onCapabilityChange={(capability) => {
                setProductionSeed(undefined);
                setProductionCapability(capability);
                setNavigationMode('production');
              }}
            />

            <button
              className={`nav-item ${navigationMode === 'project' && view === 'rough-cut' ? 'active' : ''}`}
              type="button"
              disabled={!project}
              onClick={() => openProjectView('rough-cut')}
            >
              <Clapperboard size={16} />
              <span>粗剪工作台</span>
            </button>
            {!project && (
              <div className="project-startup-rail-note">
                <strong>尚未选择项目</strong>
                <span>打开本地项目后，可使用资料导航与项目助手。</span>
              </div>
            )}

            <div className="runtime-block">
              <div className="runtime-title">
                {state === 'ready' ? (
                  <CircleCheck size={16} className="status-ready" />
                ) : state === 'error' ? (
                  <CircleAlert size={16} className="status-error" />
                ) : (
                  <span className="spinner" />
                )}
                <span>
                  {state === 'ready' ? '本地服务正常' : state === 'error' ? '服务异常' : '正在检查'}
                </span>
              </div>
              {health && (
                <>
                  <small>Worker {health.workerVersion}</small>
                  <details className="runtime-diagnostics">
                    <summary>诊断详情</summary>
                    <small>PID {health.pid}</small>
                    {sqlite && (
                      <small>
                        SQLite {sqlite.sqliteVersion} · {sqlite.journalMode.toUpperCase()}
                      </small>
                    )}
                    <small>
                      {health.platform} · {health.arch} · Node {health.nodeVersion}
                    </small>
                  </details>
                </>
              )}
              {!health && sqlite && (
                <small>
                  SQLite {sqlite.sqliteVersion} · {sqlite.journalMode.toUpperCase()}
                </small>
              )}
              {error && <small className="error-copy">{error}</small>}
            </div>
          </aside>
        }
      >
        {!leftOpen && (
          <button
            className="edge-toggle edge-toggle-left"
            type="button"
            title="展开项目导航"
            onClick={() => setLeftOpen(true)}
          >
            <ChevronRight size={16} />
          </button>
        )}

        <main className="workspace panel-border" ref={workspaceMainRef}>
          <WorkspaceSurface
            layout={workspaceLayout}
            dispatch={workspaceDispatch}
            documentTitle={
              (view === 'documents' || view === 'characters') && !hasForeignDocument
                ? (document?.title ?? documentTitle)
                : ''
            }
            editorTitle={startupMode ? '项目空间' : WORKSPACE_VIEW_TITLES[view]}
            roughCutMode={view === 'rough-cut'}
            conversationContent={conversationPanel}
            productionContent={productionPanel}
            assetsContent={
              project ? (
                <AssetLibraryView
                  key={project.id}
                  writable={writable}
                  selectedAssetId={assetLibrarySelectedId}
                  selectedAssetRevision={assetLibraryFocusRevision}
                  openTrashRequest={assetTrashRequest}
                  taskCompletionRevision={taskCompletionRevision}
                  onAddToRoughCut={(assetIds) => {
                    roughCutImportToken.current += 1;
                    if (project)
                      setRoughCutImport({
                        projectId: project.id,
                        token: roughCutImportToken.current,
                        assetIds,
                      });
                    openProjectView('rough-cut');
                  }}
                  onOpenSource={(source) => {
                    if (source.sourceKind === 'dubbing' && source.sceneId) {
                      const target = scenes.find((item) => item.id === source.sceneId);
                      if (target) {
                        setScene(target);
                        setShot(undefined);
                        openProjectView('shots');
                      } else openProjectView('tasks');
                    } else void openAssetSource(source);
                  }}
                />
              ) : (
                <EmptyWorkspace title="请打开一个项目" />
              )
            }
            productionOpen={navigationMode === 'production'}
            startupMode={startupMode}
            documentActive={(view === 'documents' || view === 'characters') && !hasForeignDocument}
            detachedPanels={detachedPanels}
            onOpenConversation={() => void focusDetachedPanelWindow(detachedPanels.conversation)}
            onOpenDocument={() => {
              if (view === 'documents' && detachedPanels.document) {
                void focusDetachedPanelWindow(detachedPanels.document);
              }
            }}
            onCloseDocument={requestCloseEditor}
            onCloseProduction={() => {
              setVoiceDesignTarget(undefined);
              setProductionSeed(undefined);
              setNavigationMode('project');
            }}
            onDetachDocument={() => void detachPanel('document')}
            onDetachConversation={() => void detachPanel('conversation')}
          >
            {startupMode ? (
              <ProjectStartupWorkspace
                recentProjects={recentProjects}
                startupLoaded={startupLoaded}
                projectName={projectName}
                projectPath={projectPath}
                projectMessage={projectMessage}
                projectBusy={projectBusy}
                createOpen={projectCreateOpen}
                onCreateOpenChange={setProjectCreateOpen}
                onProjectNameChange={setProjectName}
                onProjectPathChange={setProjectPath}
                onBrowse={() => void selectProjectDirectory()}
                onOpenProject={() => void selectProjectDirectory(true)}
                onOpenRecent={(rootPath) => void openProject(rootPath)}
                onCreateProject={() => void createProject()}
                onCreateSampleProject={() => void createSampleProject()}
              />
            ) : (
              <>
                {project && roughCutProjectId === project.id && (
                  <div className="rough-cut-holder" hidden={view !== 'rough-cut'}>
                    <RoughCutWorkspace
                      key={project.id}
                      active={view === 'rough-cut'}
                      projectId={project.id}
                      writable={writable}
                      scenes={scenes}
                      importRequest={roughCutImport}
                      onImportHandled={(token) =>
                        setRoughCutImport((current) =>
                          current?.token === token ? undefined : current,
                        )
                      }
                    />
                  </div>
                )}
                {view === 'rough-cut' ? (
                  project ? null : (
                    <EmptyWorkspace title="请打开一个项目" />
                  )
                ) : view === 'novel' ? (
                  <NovelWorkspace
                    projectId={project?.id}
                    writable={writable}
                    productionBusy={
                      productionSkillBusy || (generation != null && isGenerationActive(generation))
                    }
                    onGenerateScript={(chapters) =>
                      runProductionSkill(
                        'chapters-to-script',
                        chapters.map(({ id, documentId }) => ({ id, documentId })),
                      )
                    }
                    focusChapterId={novelFocusChapterId}
                    focusReferenceId={novelFocusReferenceId}
                    refreshToken={novelRefreshRevision || undefined}
                    referenceDocuments={documents.filter((item) => item.domainScope === 'novel')}
                    onReferencesChanged={async () => {
                      setDocuments(await callWorker('document.list', {}));
                      if (conversation)
                        setContextPreview(
                          await callWorker('context.preview', { conversationId: conversation.id }),
                        );
                    }}
                  />
                ) : view === 'documents' || view === 'characters' ? (
                  <>
                    {renderDocumentToolbar(
                      documentDirectoryMode === 'archived'
                        ? '已归档项目资料'
                        : document?.currentVersion?.state === 'published'
                          ? view === 'characters'
                            ? '已发布角色/场景'
                            : '已发布项目资料'
                          : view === 'characters'
                            ? '角色/场景提示词'
                            : '剧本草稿',
                      documentDirectoryMode === 'archived'
                        ? '已归档文档'
                        : view === 'characters'
                          ? '角色与场景'
                          : '剧本编辑器',
                      {
                        ...(view === 'characters'
                          ? { compact: true, showImport: false, showNew: false }
                          : {}),
                        showHeading: documentDirectoryMode === 'archived' || view !== 'characters',
                        readOnly: documentDirectoryMode === 'archived',
                        useDocumentTitle: true,
                        showProductionGenerate:
                          documentDirectoryMode === 'active' &&
                          (view === 'documents' ||
                            (view === 'characters' && documentKind !== 'voice')),
                        productionGenerateLabel:
                          view === 'characters'
                            ? documentKind === 'prop'
                              ? '生成道具图'
                              : documentKind === 'scene'
                                ? '生成场景图'
                                : '生成角色图'
                            : undefined,
                        productionGenerateImage: view === 'characters',
                        productionGenerateTitle:
                          view === 'characters' ? '根据当前资料生成图片' : undefined,
                        productionGenerateDisabled:
                          view === 'characters'
                            ? !document?.id ||
                              hasForeignDocument ||
                              !documentEditorWritable ||
                              contentBusy ||
                              !documentTitle.trim() ||
                              !documentContent.trim()
                            : !document?.id ||
                              hasForeignDocument ||
                              productionSkillBusy ||
                              (generation != null && isGenerationActive(generation)) ||
                              !document?.currentVersionId ||
                              documentContent !==
                                (document?.currentVersion?.contentMarkdown ?? '') ||
                              documentTitle !== document?.title,
                        onGenerateProduction: () => {
                          if (!document) return;
                          if (view === 'characters') {
                            void openCharacterSceneImageProduction(
                              documentKind === 'scene' ? activeCharacterSceneReference : undefined,
                            );
                            return;
                          }
                          void runProductionSkill('script-to-media', [
                            { id: document.id, documentId: document.id },
                          ]);
                        },
                      },
                    )}
                    {project ? (
                      <div className="directory-layout">
                        <aside
                          className="directory-index project-document-index"
                          aria-label="项目文档目录"
                        >
                          <div className="document-directory-header">
                            {view === 'characters' ? (
                              <div className="tree-heading">
                                <span>角色与场景</span>
                                {documentDirectoryMode === 'active' && (
                                  <button
                                    className="icon-button subtle"
                                    type="button"
                                    title="新建角色或场景"
                                    onClick={newDocumentOfActiveKind}
                                    disabled={!writable}
                                  >
                                    <FilePlus2 size={14} />
                                  </button>
                                )}
                              </div>
                            ) : null}
                            <div
                              className="document-directory-modes"
                              role="group"
                              aria-label="文档生命周期筛选"
                            >
                              <button
                                type="button"
                                className={documentDirectoryMode === 'active' ? 'active' : ''}
                                aria-pressed={documentDirectoryMode === 'active'}
                                onClick={() => {
                                  setEditingDocumentTitleId(null);
                                  setDocumentDirectoryMode('active');
                                }}
                              >
                                当前
                              </button>
                              <button
                                type="button"
                                className={documentDirectoryMode === 'archived' ? 'active' : ''}
                                aria-pressed={documentDirectoryMode === 'archived'}
                                onClick={() => {
                                  setEditingDocumentTitleId(null);
                                  setDocumentDirectoryMode('archived');
                                }}
                              >
                                已归档
                              </button>
                            </div>
                            <div
                              className="document-kind-filters"
                              role="group"
                              aria-label="文档类型筛选"
                            >
                              {(view === 'characters'
                                ? [
                                    { id: 'all' as const, label: '全部' },
                                    { id: 'character' as const, label: '角色' },
                                    { id: 'scene' as const, label: '场景' },
                                    { id: 'prop' as const, label: '道具' },
                                  ]
                                : [
                                    { id: 'all' as const, label: '全部' },
                                    { id: 'outline' as const, label: '大纲' },
                                    { id: 'plan' as const, label: '计划' },
                                    { id: 'constraint' as const, label: '约束' },
                                  ]
                              ).map((filter) => (
                                <button
                                  className={documentKindFilter === filter.id ? 'active' : ''}
                                  type="button"
                                  key={filter.id}
                                  aria-pressed={documentKindFilter === filter.id}
                                  onClick={() => {
                                    setEditingDocumentTitleId(null);
                                    setDocumentKindFilter(filter.id);
                                  }}
                                >
                                  {filter.label}
                                </button>
                              ))}
                            </div>
                            {documentDirectoryMode === 'active' && documentBatch.controls()}
                            {documentBatch.message && (
                              <small role="status">{documentBatch.message}</small>
                            )}
                          </div>
                          <div className="document-directory-list">
                            {documentDirectoryMode === 'active'
                              ? visibleDocuments.map((item) => {
                                  if (view === 'characters') {
                                    const selected = document?.id === item.id;
                                    const title = selected ? documentTitle : item.title;
                                    const editing = selected && editingDocumentTitleId === item.id;
                                    return (
                                      <div
                                        className={`tree-item with-kind document-directory-item ${document?.id === item.id ? 'selected' : ''}`}
                                        key={item.id}
                                      >
                                        {documentBatch.checkbox(item)}
                                        {editing ? (
                                          <input
                                            className="document-directory-title-input"
                                            type="text"
                                            aria-label="文档标题"
                                            autoFocus
                                            value={documentTitle}
                                            readOnly={!documentEditorWritable || contentBusy}
                                            onChange={(event) =>
                                              setDocumentTitle(event.target.value)
                                            }
                                            onBlur={() => {
                                              if (!documentTitle.trim())
                                                setDocumentTitle(document?.title ?? item.title);
                                              setEditingDocumentTitleId(null);
                                            }}
                                            onKeyDown={(event) => {
                                              if (event.key === 'Enter') {
                                                event.preventDefault();
                                                event.currentTarget.blur();
                                              }
                                              if (event.key === 'Escape') {
                                                setDocumentTitle(document?.title ?? item.title);
                                                setEditingDocumentTitleId(null);
                                              }
                                            }}
                                          />
                                        ) : (
                                          <button
                                            className="document-directory-title"
                                            type="button"
                                            aria-label={
                                              selected
                                                ? `编辑文档标题 ${title || item.title}`
                                                : `打开文档 ${item.title}`
                                            }
                                            disabled={
                                              selected && (!documentEditorWritable || contentBusy)
                                            }
                                            onClick={() => {
                                              if (selected) setEditingDocumentTitleId(item.id);
                                              else {
                                                setEditingDocumentTitleId(null);
                                                void openDocumentById(item.id);
                                              }
                                            }}
                                          >
                                            <DocumentDirectoryTitleText
                                              text={title || '未命名文档'}
                                            />
                                          </button>
                                        )}
                                        <small className="tree-item-kind">
                                          {DOCUMENT_KIND_LABELS[item.kind]}
                                        </small>
                                        {item.domainScope !== 'novel' && !hasForeignDocument && (
                                          <button
                                            className="icon-button subtle document-directory-archive"
                                            type="button"
                                            title="归档后可在已归档文档中恢复"
                                            aria-label={`归档文档“${item.title}”`}
                                            disabled={!writable || contentBusy}
                                            onClick={() => requestArchiveDocument(item)}
                                          >
                                            <Archive size={14} aria-hidden="true" />
                                          </button>
                                        )}
                                      </div>
                                    );
                                  }
                                  const selected = document?.id === item.id;
                                  const title = selected ? documentTitle : item.title;
                                  const editing = selected && editingDocumentTitleId === item.id;
                                  return (
                                    <div
                                      className={`tree-item with-kind document-directory-item ${selected ? 'selected' : ''}`}
                                      key={item.id}
                                    >
                                      {documentBatch.checkbox(item)}
                                      {editing ? (
                                        <input
                                          className="document-directory-title-input"
                                          type="text"
                                          aria-label="文档标题"
                                          autoFocus
                                          value={documentTitle}
                                          readOnly={!documentEditorWritable || contentBusy}
                                          onChange={(event) => setDocumentTitle(event.target.value)}
                                          onBlur={() => {
                                            if (!documentTitle.trim())
                                              setDocumentTitle(document?.title ?? item.title);
                                            setEditingDocumentTitleId(null);
                                          }}
                                          onKeyDown={(event) => {
                                            if (event.key === 'Enter') {
                                              event.preventDefault();
                                              event.currentTarget.blur();
                                            }
                                            if (event.key === 'Escape') {
                                              setDocumentTitle(document?.title ?? item.title);
                                              setEditingDocumentTitleId(null);
                                            }
                                          }}
                                        />
                                      ) : (
                                        <button
                                          className="document-directory-title"
                                          type="button"
                                          aria-label={
                                            selected
                                              ? `编辑文档标题 ${title || item.title}`
                                              : `打开文档 ${item.title}`
                                          }
                                          disabled={
                                            selected && (!documentEditorWritable || contentBusy)
                                          }
                                          onClick={() => {
                                            if (selected) setEditingDocumentTitleId(item.id);
                                            else {
                                              setEditingDocumentTitleId(null);
                                              void openDocumentById(item.id);
                                            }
                                          }}
                                        >
                                          <DocumentDirectoryTitleText
                                            text={title || '未命名文档'}
                                          />
                                        </button>
                                      )}
                                      <small className="tree-item-kind">
                                        {DOCUMENT_KIND_LABELS[item.kind]}
                                      </small>
                                      {item.domainScope !== 'novel' && !hasForeignDocument && (
                                        <button
                                          className="icon-button subtle document-directory-archive"
                                          type="button"
                                          title="归档后可在已归档文档中恢复"
                                          aria-label={`归档文档“${item.title}”`}
                                          disabled={!writable || contentBusy}
                                          onClick={() => requestArchiveDocument(item)}
                                        >
                                          <Archive size={14} aria-hidden="true" />
                                        </button>
                                      )}
                                    </div>
                                  );
                                })
                              : visibleArchivedDocuments.map((item) => (
                                  <div className="archived-document-row" key={item.id}>
                                    <div className="tree-item with-kind">
                                      <FileText size={13} />
                                      <DocumentDirectoryTitleText text={item.title} />
                                      <small className="tree-item-kind">
                                        {DOCUMENT_KIND_LABELS[item.kind]}
                                      </small>
                                    </div>
                                    <button
                                      className="icon-button subtle"
                                      type="button"
                                      title={`恢复“${item.title}”`}
                                      aria-label={`恢复文档“${item.title}”`}
                                      disabled={!writable || contentBusy}
                                      onClick={() =>
                                        void restoreArchivedDocumentFromDirectory(item)
                                      }
                                    >
                                      <RotateCcw size={14} />
                                    </button>
                                  </div>
                                ))}
                            {(documentDirectoryMode === 'active'
                              ? visibleDocuments.length
                              : visibleArchivedDocuments.length) === 0 && (
                              <small className="tree-empty">
                                {documentDirectoryMode === 'archived'
                                  ? documentKindFilter === 'all'
                                    ? '暂无已归档文档'
                                    : `暂无已归档的${DOCUMENT_KIND_LABELS[documentKindFilter]}文档`
                                  : documentKindFilter === 'all'
                                    ? '暂无文档'
                                    : `暂无${DOCUMENT_KIND_LABELS[documentKindFilter]}类型文档`}
                              </small>
                            )}
                            {view === 'documents' &&
                            documentDirectoryMode === 'active' &&
                            constraints.length > 0 ? (
                              <>
                                <div className="tree-heading nested">
                                  <span>生产约束记录</span>
                                </div>
                                {constraints.map((item) => (
                                  <div
                                    className="tree-item constraint-item"
                                    key={item.id}
                                    title={item.content}
                                  >
                                    <ListChecks size={13} />
                                    <span>
                                      {item.content.length > 40
                                        ? item.content.slice(0, 40) + '…'
                                        : item.content}
                                    </span>
                                  </div>
                                ))}
                              </>
                            ) : null}
                          </div>
                        </aside>
                        <div className="directory-pane">
                          {documentDirectoryMode === 'archived' ? (
                            <EmptyWorkspace title="已归档文档" />
                          ) : (
                            renderDocumentEditor()
                          )}
                        </div>
                      </div>
                    ) : (
                      <EmptyWorkspace />
                    )}
                  </>
                ) : view === 'shots' ? (
                  <>
                    <div className="workspace-toolbar">
                      <div>
                        <span className="eyebrow">{shot ? scene?.title : '场次与镜头'}</span>
                        <h1>{shot?.title ?? scene?.title ?? '场次未选择'}</h1>
                      </div>
                      <button
                        className="button primary"
                        type="button"
                        onClick={() => void addShot()}
                        disabled={!writable || !scene}
                      >
                        <Plus size={15} />
                        新建镜头
                      </button>
                    </div>
                    {project ? (
                      <div className="directory-layout">
                        <SceneShotDirectory
                          projectId={project.id}
                          scenes={scenes}
                          sceneId={scene?.id}
                          shotId={shot?.id}
                          shots={shots}
                          writable={writable}
                          busy={shotStoryboardBusy}
                          dirtySceneId={
                            sceneVideoPrompt !== (scene?.prompt ?? '') ? scene?.id : undefined
                          }
                          dirtyShotId={
                            shot &&
                            (shotPrompt !== (shot.prompt ?? '') ||
                              shotStoryboardTitle !== (shotStoryboard?.title ?? '') ||
                              shotStoryboardContent !==
                                (shotStoryboard?.currentVersion?.contentMarkdown ?? ''))
                              ? shot.id
                              : undefined
                          }
                          onLifecycleChanged={refreshProductionLifecycle}
                          onAddScene={() => void addScene()}
                          onRenameScene={(item, title) => void renameScene(item, title)}
                          onRenameShot={(parent, item, title) =>
                            void renameShot(parent, item, title)
                          }
                          onSelectScene={(item) => void selectScene(item)}
                          onSelectShot={(parent, item) => {
                            if (scene?.id === parent.id) {
                              conversationRequest.current += 1;
                              setShot(item);
                            } else void selectScene(parent, item);
                          }}
                        />
                        <div className="directory-pane">
                          {scene && !shot ? (
                            <SceneWorkspace
                              projectId={project.id}
                              scene={scene}
                              shots={shots}
                              prompt={sceneVideoPrompt}
                              documents={documents}
                              assets={assets}
                              writable={writable}
                              onPromptChange={setSceneVideoPrompt}
                              onSave={(nextPrompt) => void saveSceneVideoPrompt(nextPrompt)}
                              onGenerateVideo={() => void openSceneProduction()}
                              onOpenAsset={(assetId) => {
                                updateAssets(assets, assetId);
                                openProjectView('assets', assetId);
                              }}
                            />
                          ) : null}
                          {shot ? (
                            <ShotWorkspace
                              projectId={project.id}
                              shotId={shot.id}
                              mediaRevision={taskCompletionRevision}
                              bindings={shot.bindings ?? undefined}
                              referenceBindings={shot.referenceBindings}
                              onSaveReferenceBindings={saveShotReferenceBindings}
                              shotTitle={shot.title}
                              shotStatus={shot.status}
                              shotPosition={shot.position}
                              continuitySourceDirty={shotPrompt !== (shot.prompt ?? '')}
                              llm={
                                selectedLlmProfile && selectedLlmModel
                                  ? {
                                      providerProfileId: selectedLlmProfile.id,
                                      modelId: selectedLlmModel.id,
                                      name: selectedLlmModel.displayName,
                                      vision: selectedLlmModel.capabilities.vision,
                                    }
                                  : undefined
                              }
                              prompt={shotPrompt}
                              writable={writable}
                              assets={assets}
                              documents={documents}
                              storyboardTitle={shotStoryboardTitle}
                              storyboardContent={shotStoryboardContent}
                              storyboardBusy={shotStoryboardBusy}
                              hasStoryboard={Boolean(shotStoryboard)}
                              onPromptChange={setShotPrompt}
                              onSavePrompt={() => void saveShotPrompt()}
                              onRepairBindings={requestShotBindingRepair}
                              onAskContinuityAgent={requestContinuityAgent}
                              onPrepareGenerate={prepareShotProduction}
                              onGenerateImage={(refs, prompt) =>
                                void openShotProduction('image', refs, prompt)
                              }
                              onGenerateVideo={(refs, prompt) =>
                                void openShotProduction('video', refs, prompt)
                              }
                              onStoryboardTitleChange={setShotStoryboardTitle}
                              onStoryboardContentChange={setShotStoryboardContent}
                              onSaveStoryboard={() => void saveShotStoryboard()}
                            />
                          ) : scene ? null : (
                            <EmptyWorkspace title="还没有场次" />
                          )}
                        </div>
                      </div>
                    ) : (
                      <EmptyWorkspace />
                    )}
                    <GeneratedDraftSync
                      projectId={project?.id}
                      writable={writable}
                      refreshRevision={proposalRefreshRevision}
                      onSaved={refreshAppliedStructure}
                    />
                  </>
                ) : (
                  <TaskLogView
                    projectId={project?.id}
                    taskRevision={projectTasks?.revision}
                    onOpenDocument={(documentId) => void openDocumentById(documentId)}
                    onOpenConversation={(conversationId) =>
                      void openConversationById(conversationId)
                    }
                    onOpenLibrarySource={openLibrarySource}
                  />
                )}
              </>
            )}
          </WorkspaceSurface>
        </main>
      </ResizableAppLayout>
    </div>
  );
}
function EmptyWorkspace({ title = '请打开一个项目' }: { title?: string }) {
  return (
    <section className="empty-stage">
      <div className="empty-icon">
        <Aperture size={28} />
      </div>
      <h2>{title}</h2>
      <p>项目资料、版本历史和会话内容都会保存在本地 SQLite 项目容器中。</p>
    </section>
  );
}
