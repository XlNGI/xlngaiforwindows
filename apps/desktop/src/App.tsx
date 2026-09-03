import { useEffect, useRef, useState } from 'react';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import {
  Aperture,
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
  Minus,
  PanelLeftClose,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Square,
  WandSparkles,
  X,
  BookOpen,
} from 'lucide-react';
import type {
  AgentDocumentIntent,
  AgentDocumentOperation,
  AgentResearchMode,
  ChatMessageInfo,
  ConstraintInfo,
  ConversationScopeType,
  DocumentDetail,
  DocumentKind,
  DocumentSummary,
  DocumentVersionInfo,
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
  ShotInfo,
  SqliteProbeResult,
  UnifiedAgentModelSelectionRequest,
  AdapterDescriptor,
  UnifiedAgentCapability,
  LlmInputAttachment,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { submitProviderRequest, submitVideoProviderTask } from './provider-client';
import { useProjectMaintenance } from './use-project-maintenance';
import { useDocumentWorkspace } from './use-document-workspace';
import { useConversationWorkspace } from './use-conversation-workspace';
import { useAssetWorkspace } from './use-asset-workspace';
import { useProductionState } from './use-production-state';
import { ProductionPanel } from './ProductionPanel';
import { MaintenanceDialog } from './MaintenanceDialog';
import { ChatPanel, type ChatAttachment, type ComposerMode } from './ChatPanel';
import { SettingsCenter } from './SettingsCenter';
import { ProductionNavigation } from './ProductionNavigation';
import { providerProfileClient } from './provider-profile-client';
import { AssetLibraryView } from './assets/AssetLibraryView';
import { TaskLogView } from './TaskLogView';
import { NovelWorkspace } from './NovelWorkspace';
import { ChangeSetReviewPanel } from './ChangeSetReviewPanel';
import { streamPreparedLlmGeneration, type LlmStreamRun } from './llm-client';
import { WorkspaceSurface } from './workspace/WorkspaceSurface';
import { ResizableAppLayout } from './workspace/ResizableAppLayout';
import { useWorkspaceLayout } from './workspace/use-workspace-layout';
import {
  DETACHED_PANEL_ACTION_EVENT,
  DETACHED_PANEL_READY_EVENT,
  closeDetachedPanelWindow,
  focusDetachedPanelWindow,
  openDetachedPanelWindow,
  sendDetachedSnapshot,
  type DetachedConversationSnapshot,
  type DetachedDocumentSnapshot,
  type DetachedPanelAction,
  type DetachedPanelConfig,
  type DetachedPanelEnvelope,
  type DetachedPanelSnapshot,
} from './workspace/detached-window';
import type { WorkspacePanelId } from './workspace/workspace-types';
import { MODAL_Z_INDEX } from './workspace/ui-layers';
import brandLogo from './brand-logo.png';

type CheckState = 'checking' | 'ready' | 'error';
type WorkspaceView = 'documents' | 'novel' | 'characters' | 'shots' | 'assets' | 'tasks';
type NavigationMode = 'project' | 'production';
type SettingsPage = 'providers' | 'usage' | 'maintenance';

interface DetachedPanelRegistration {
  config: DetachedPanelConfig;
  snapshot: DetachedPanelSnapshot;
  snapshotSequence: number;
  actionSequence: number;
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

/**
 * Agent and media models are separate user choices. A selected Agent model may
 * be used for text/tool-loop work, but it must never become an implicit image
 * or video Provider model.
 */
export function resolveAgentRunModelSelection(
  capability: UnifiedAgentCapability,
  explicitSelection?: ConversationModelSelection,
  rememberedSelection?: ConversationModelSelection,
  agentSelection?: ConversationModelSelection,
): ConversationModelSelection | undefined {
  if (explicitSelection) return explicitSelection;
  if (capability === 'image' || capability === 'video') return rememberedSelection;
  return agentSelection ?? rememberedSelection;
}

export function inferDocumentIntent(
  prompt: string,
  targetDocumentId?: string,
): { intent?: AgentDocumentIntent; needsTarget: boolean } {
  const value = prompt.trim().toLocaleLowerCase();
  if (!value) return { needsTarget: false };
  if (
    /\b(?:don't|do not|never|without)\b.*\b(?:document|draft|update|archive|restore)\b/i.test(value)
  ) {
    return { needsTarget: false };
  }
  const hasDocumentNoun =
    /\b(?:document|draft|brief|outline|plan|memo)\b/i.test(value) ||
    /[\u6587\u6863\u8349\u7a3f\u7b80\u62a5\u5927\u7eb2\u8ba1\u5212\u5907\u5fd8]/u.test(value);
  if (/\barchive\b/i.test(value) || /[\u5f52\u6863]/u.test(value)) {
    return targetDocumentId
      ? {
          intent: { operation: 'document.archive', documentId: targetDocumentId },
          needsTarget: false,
        }
      : { needsTarget: true };
  }
  if (/\b(?:restore|unarchive)\b/i.test(value) || /[\u6062\u590d]/u.test(value)) {
    return targetDocumentId
      ? {
          intent: { operation: 'document.restore', documentId: targetDocumentId },
          needsTarget: false,
        }
      : { needsTarget: true };
  }
  if (
    /\b(?:update|edit|revise|rewrite|modify)\b/i.test(value) ||
    /[\u66f4\u65b0\u4fee\u6539\u7f16\u8f91\u91cd\u5199]/u.test(value)
  ) {
    return targetDocumentId
      ? {
          intent: { operation: 'document.update_draft', documentId: targetDocumentId },
          needsTarget: false,
        }
      : { needsTarget: true };
  }
  if (
    /\b(?:read|show|open|summari[sz]e)\b/i.test(value) ||
    /[\u8bfb\u53d6\u67e5\u770b\u9605\u8bfb\u603b\u7ed3]/u.test(value)
  ) {
    return targetDocumentId
      ? { intent: { operation: 'document.read', documentId: targetDocumentId }, needsTarget: false }
      : { needsTarget: true };
  }
  if (hasDocumentNoun && /\b(?:create|draft|write|generate|make)\b/i.test(value)) {
    return { intent: { operation: 'document.create_draft' }, needsTarget: false };
  }
  return { needsTarget: false };
}

/** Legacy Native Agent routing only. The Pi Task Plan path uses structured
 * deliverables and never reads this keyword-based inference result. */
export function inferShortDramaIntent(prompt: string): AgentDocumentOperation {
  const value = prompt.trim().toLocaleLowerCase();
  const wantsCharacters = /人物|角色|场景提示词|场景设定|人物提示词|角色提示词/u.test(value);
  const wantsStructure = /场次|镜头|分镜|分集结构/u.test(value);
  if (wantsCharacters) return 'document.create_draft';
  if (wantsStructure) return 'novel.episode.submit_structure';
  return 'novel.episode.submit_draft';
}

function initialLlmSelection(): { providerProfileId?: string; modelId?: string } {
  try {
    const stored = window.localStorage.getItem(LLM_SELECTION_STORAGE_KEY);
    if (!stored) return {};
    const value = JSON.parse(stored) as { providerProfileId?: unknown; modelId?: unknown };
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
    const value = JSON.parse(stored) as { researchMode?: unknown };
    return value.researchMode === 'project_only' || value.researchMode === 'network_disabled'
      ? value.researchMode
      : 'auto';
  } catch {
    return 'auto';
  }
}

function initialComposerMode(): ComposerMode {
  try {
    const stored = window.localStorage.getItem(LLM_SELECTION_STORAGE_KEY);
    if (!stored) return 'chat';
    const value = JSON.parse(stored) as { composerMode?: unknown };
    return value.composerMode === 'document' || value.composerMode === 'novel-writing'
      ? value.composerMode
      : 'chat';
  } catch {
    return 'chat';
  }
}

function initialAgentModelPreferences(): Record<
  string,
  Partial<Record<UnifiedAgentCapability, { providerProfileId: string; modelId: string }>>
> {
  try {
    const stored = window.localStorage.getItem(AGENT_MODEL_PREFERENCES_STORAGE_KEY);
    if (!stored) return {};
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    const result: Record<
      string,
      Partial<Record<UnifiedAgentCapability, { providerProfileId: string; modelId: string }>>
    > = {};
    for (const [conversationId, value] of Object.entries(parsed)) {
      if (!value || typeof value !== 'object') continue;
      const preferences: Partial<
        Record<UnifiedAgentCapability, { providerProfileId: string; modelId: string }>
      > = {};
      for (const [capability, selection] of Object.entries(value)) {
        if (!selection || typeof selection !== 'object') continue;
        const candidate = selection as { providerProfileId?: unknown; modelId?: unknown };
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

async function readImageAsDataUrl(file: File): Promise<string> {
  const original = await readFileAsDataUrl(file);
  const maxDataUrlLength = 1_850_000;
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

function readableFailure(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === 'string' && reason.trim()) return reason;
  if (reason && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return fallback;
}

function documentStateLabel(state: DocumentVersionInfo['state'] | 'new'): string {
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
      return '已拒绝';
    case 'superseded':
      return '已替代';
    case 'discarded':
      return '已放弃';
    default:
      return '未保存';
  }
}

export function mergeGenerationMessage(
  messages: ChatMessageInfo[],
  selectedConversationId: string | undefined,
  next: LlmGenerationInfo,
): ChatMessageInfo[] {
  if (selectedConversationId !== next.conversationId) return messages;
  return [
    ...messages.filter((message) => message.id !== next.assistantMessage.id),
    next.assistantMessage,
  ];
}

export function inferAgentCapability(prompt: string): UnifiedAgentCapability {
  const value = prompt.normalize('NFC');
  if (/(搜索|查找|联网|最新资料|网页|研究)/u.test(value)) return 'research';
  // Direct rendering requests should not be mistaken for prompt/document work.
  // Keep “生成角色三视图提示词” as document work, but route
  // “直接生成角色三视图” to the image model selection flow.
  if (
    /(?:生成|制作|创建|绘制|画出|画一张)/u.test(value) &&
    /(图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)/u.test(value) &&
    !/(提示词|prompt|文档)/iu.test(value)
  )
    return 'image';
  if (/(改写|重写|润色|总结|提取|分析|识别|描述|转写|翻译|提示词)/u.test(value)) return 'document';
  if (
    /(文生视频|图生视频|参考生视频|首尾帧(?:生|生成)?视频|(?:生成|制作|创建)[^。！？\n]{0,80}(?:的)?视频(?:[。！？!?]|$)|输出视频|做成视频)/u.test(
      value,
    )
  )
    return 'video';
  if (
    /(文生图|图生图|参考生图|生成(?:一张|一个|一组|该|这个)?(?:图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)|制作(?:一张|一个|一组|该|这个)?(?:图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)|创建(?:一张|一个|一组|该|这个)?(?:图片|图像|海报|角色图|头像|插画|配图|三视图|立绘)|生图)/u.test(
      value,
    )
  )
    return 'image';
  if (/(小说|章节|续写|短剧|剧本|场次|镜头)/u.test(value)) return 'document';
  return 'text';
}

/**
 * Combines the user's direct image request with the most relevant generated
 * prompt document. Image adapters only receive their `prompt` parameter, so
 * without this bridge a request such as “直接生成角色三视图” would silently
 * discard the detailed character/scene constraints produced earlier by the
 * Agent.
 */
export function composeImageGenerationPrompt(
  userPrompt: string,
  source?: { title: string; content: string },
): string {
  const request = userPrompt.trim();
  if (!source) return request;
  const content = source.content.trim();
  if (!content) return request;
  const prefix = `${request}\n\n请依据以下项目提示词文档生成图片，保持人物、服装、构图和三视图约束一致。\n【${source.title}】\n`;
  const maximum = 5_000;
  if (prefix.length >= maximum) return prefix.slice(0, maximum);
  return `${prefix}${content.slice(0, maximum - prefix.length)}`;
}

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
        mimeType: attachment.mimeType,
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
    const cleanup = () => {
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

function isModelSchemaQuery(prompt: string): boolean {
  return (
    /(模型|参数|schema|适配器)/iu.test(prompt) &&
    /(查看|查询|支持|有哪些|列出|告诉我)/u.test(prompt)
  );
}

export function App() {
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
  const [startupLoaded, setStartupLoaded] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [providerSettingsRevision, setProviderSettingsRevision] = useState(0);
  const [settingsInitialPage, setSettingsInitialPage] = useState<SettingsPage>('providers');
  const [navigationMode, setNavigationMode] = useState<NavigationMode>('project');

  const [view, setView] = useState<WorkspaceView>('documents');
  const [detachedPanels, setDetachedPanels] = useState<Partial<Record<WorkspacePanelId, string>>>(
    {},
  );

  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  const [scene, setScene] = useState<SceneInfo>();
  const [shots, setShots] = useState<ShotInfo[]>([]);
  const [shot, setShot] = useState<ShotInfo>();
  const [shotPrompt, setShotPrompt] = useState('');
  const [constraints, setConstraints] = useState<ConstraintInfo[]>([]);
  const [shotStoryboard, setShotStoryboard] = useState<DocumentDetail>();
  const [shotStoryboardTitle, setShotStoryboardTitle] = useState('');
  const [shotStoryboardContent, setShotStoryboardContent] = useState('');
  const [shotStoryboardBusy, setShotStoryboardBusy] = useState(false);
  const shotStoryboardRequest = useRef(0);

  const [scopeType, setScopeType] = useState<ConversationScopeType>('project');
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [composer, setComposer] = useState('');
  const [chatAttachments, setChatAttachments] = useState<ChatAttachment[]>([]);
  const [chatMessage, setChatMessage] = useState('');
  const [agentModelSelection, setAgentModelSelection] =
    useState<UnifiedAgentModelSelectionRequest>();
  const [agentModelPreferences, setAgentModelPreferences] = useState<
    Record<
      string,
      Partial<Record<UnifiedAgentCapability, { providerProfileId: string; modelId: string }>>
    >
  >(initialAgentModelPreferences);
  const [agentParameterRequest, setAgentParameterRequest] = useState<{
    prompt: string;
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
  const [composerMode, setComposerMode] = useState<ComposerMode>(initialComposerMode);
  const [episodeChapterIds, setEpisodeChapterIds] = useState<string[]>([]);
  const [generation, setGeneration] = useState<LlmGenerationInfo>();
  const [agentTask, setAgentTask] = useState<import('@ai-video/contracts').AgentTaskDetail>();
  const [agentConfirmation, setAgentConfirmation] =
    useState<import('@ai-video/contracts').AgentToolConfirmationRequest>();
  const confirmationResolverRef = useRef<((approved: boolean) => void) | undefined>(undefined);
  const retryRequestsRef = useRef(new Set<string>());
  const projectActionRequest = useRef(0);
  const projectContentRequest = useRef(0);
  const generationPollVersion = useRef(0);
  const generationPollOwner = useRef({
    projectId: undefined as string | undefined,
    conversationId: undefined as string | undefined,
    generationId: undefined as string | undefined,
  });
  const nativeLlmRun = useRef<LlmStreamRun | undefined>(undefined);
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
  const detachedPanelsRef = useRef<Partial<Record<WorkspacePanelId, string>>>({});
  const detachedActionSequenceRef = useRef<Record<string, number>>({});
  const detachedActionHandlerRef = useRef<
    (action: DetachedPanelAction, label: string, envelope: DetachedPanelEnvelope<unknown>) => void
  >(() => undefined);

  detachedPanelsRef.current = detachedPanels;
  const writable = project?.mode === 'read-write';
  const { layout: workspaceLayout, dispatch: workspaceDispatch } = useWorkspaceLayout(project?.id);

  const syncDetachedPanelForEntity = (panelId: WorkspacePanelId, entityId?: string) => {
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

  const docs = useDocumentWorkspace({
    writable,
    syncDetachedPanel: (entityId) => syncDetachedPanelForEntity('document', entityId),
    openDocumentWorkspace: () => {
      setView('documents');
      workspaceDispatch({ type: 'open', panelId: 'document' });
    },
    closeDocumentPanel: () => workspaceDispatch({ type: 'close', panelId: 'document' }),
  });
  const {
    documents,
    document,
    documentTitle,
    documentKind,
    documentContent,
    versions,
    contentBusy,
    contentMessage,
    documentCloseConfirmation,
    documentEditorWritable,
    documentDirty,
    setDocuments,
    setDocumentKind,
    setDocumentTitle,
    setDocumentContent,
    setContentMessage,
    setDocumentCloseConfirmation,
    selectDocument,
    openDocumentById,
    newDocument,
    importMarkdownDocument,
    saveDocument,
    submitDocumentReview,
    requestDocumentChanges,
    publishDocument,
    restoreVersion,
    openCreatedDocument,
    requestCloseDocument,
    discardDocumentChanges,
    saveAndCloseDocument,
    syncMainDocumentIfSelected,
    reset: resetDocumentWorkspace,
  } = docs;

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
  const productionWorkspace = useProductionState({ setNavigationMode });
  const {
    productionCapability,
    setProductionCapability,
    productionMenuOpen,
    setProductionMenuOpen,
  } = productionWorkspace;

  const closeSettings = () => {
    setSettingsOpen(false);
    setProviderSettingsRevision((revision) => revision + 1);
  };
  const scopeId = scopeType === 'scene' ? scene?.id : scopeType === 'shot' ? shot?.id : undefined;
  const scopeAvailable = scopeType === 'project' || Boolean(scopeId);
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
            model.capabilities.streaming,
        );
      const currentProfile = profiles.find((profile) => profile.id === selectedLlmProfileId);
      const currentModel = models.find(
        (model) =>
          model.id === selectedLlmModelId && model.providerProfileId === currentProfile?.id,
      );
      const nextProfile =
        currentProfile && currentModel
          ? currentProfile
          : profiles.find((profile) =>
              models.some((model) => model.providerProfileId === profile.id),
            );
      const nextModel =
        currentModel ?? models.find((model) => model.providerProfileId === nextProfile?.id);
      setLlmProfiles(profiles);
      setLlmModels(models);
      setSelectedLlmProfileId(nextProfile?.id ?? '');
      setSelectedLlmModelId(nextModel?.id ?? '');
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
      nativeLlmRun.current?.identity.attemptId === run.identity.attemptId &&
      owner.projectId === run.identity.projectId &&
      owner.conversationId === run.identity.conversationId
    );
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
        .then((result) => {
          if (agentTaskEventPollRef.current !== poll) return;
          void callWorker('agent.task.get', { taskId })
            .then(setAgentTask)
            .catch(() => undefined);
          poll.afterSequence = result.nextSequence;
          const latest = result.events.at(-1);
          if (latest?.level === 'error') setChatMessage(latest.summary);
          if (['completed', 'failed', 'cancelled'].includes(result.task.status)) {
            if (result.task.errorMessage) setChatMessage(result.task.errorMessage);
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

  const launchPreparedGeneration = (prepared: LlmGenerationPrepareResult) => {
    setChatAttachments([]);
    const agentTaskId =
      'agentTaskId' in prepared && typeof prepared.agentTaskId === 'string'
        ? prepared.agentTaskId
        : undefined;
    const isAgentGeneration = agentTaskId !== undefined;
    if (agentTaskId) {
      setAgentTask(undefined);
      startAgentTaskEventPolling(agentTaskId);
    } else {
      stopAgentTaskEventPolling();
    }
    const previousDocumentIds = new Set(documents.map((item) => item.id));
    let agentDocumentRefreshStarted = false;
    const refreshAgentDocuments = () => {
      if (!isAgentGeneration || agentDocumentRefreshStarted) return;
      agentDocumentRefreshStarted = true;
      const projectId = prepared.stream.projectId;
      void callWorker('document.list', {})
        .then((nextDocuments) => {
          if (generationPollOwner.current.projectId === projectId) {
            setDocuments(nextDocuments);
            const createdDocument = nextDocuments.find((item) => !previousDocumentIds.has(item.id));
            if (createdDocument) void openDocumentById(createdDocument.id);
          }
        })
        .catch((reason) => {
          if (generationPollOwner.current.projectId === projectId) {
            setContentMessage(reason instanceof Error ? reason.message : '文档列表刷新失败');
          }
        });
    };
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
    if (!isGenerationActive(prepared.generation)) {
      setChatMessage(prepared.generation.error ?? '生成已完成');
      refreshAgentDocuments();
      return;
    }
    const run = streamPreparedLlmGeneration(prepared, {
      onDelta(content) {
        if (!nativeRunIsCurrent(run)) return;
        const next: LlmGenerationInfo = {
          ...prepared.generation,
          status: 'streaming',
          assistantMessage: {
            ...prepared.generation.assistantMessage,
            content,
            status: 'streaming',
          },
        };
        setGeneration((current) =>
          current?.generationId === next.generationId ? { ...current, ...next } : current,
        );
        setMessages((current) =>
          mergeGenerationMessage(current, run.identity.conversationId, next),
        );
      },
      onState(next) {
        if (!nativeRunIsCurrent(run)) return;
        setGeneration(next);
        setMessages((current) =>
          mergeGenerationMessage(current, run.identity.conversationId, next),
        );
        if (!isGenerationActive(next)) {
          setChatMessage(next.error ?? '生成完成');
          refreshAgentDocuments();
        }
      },
      onConfirmation(request) {
        setAgentConfirmation(request);
        return new Promise<boolean>((resolve) => {
          confirmationResolverRef.current = (approved) => {
            confirmationResolverRef.current = undefined;
            setAgentConfirmation(undefined);
            resolve(approved);
          };
        });
      },
    });
    nativeLlmRun.current = run;
    void run.completion
      .catch((reason: unknown) => {
        if (nativeRunIsCurrent(run)) {
          setChatMessage(reason instanceof Error ? reason.message : '原生 LLM 流处理失败');
        }
      })
      .finally(() => {
        stopAgentTaskEventPolling();
        if (nativeLlmRun.current?.identity.attemptId === run.identity.attemptId) {
          nativeLlmRun.current = undefined;
        }
      });
  };

  const cancelNativeLlmRun = async () => {
    const run = nativeLlmRun.current;
    if (!run) {
      stopAgentTaskEventPolling();
      return;
    }
    // Invalidate callbacks before asking the native transport to stop so late events
    // cannot put a cancelled generation back into the streaming state.
    nativeLlmRun.current = undefined;
    await run.cancel().catch(() => undefined);
    const terminal = await callWorker('llm.generation.get', {
      generationId: run.identity.generationId,
    }).catch(() => undefined);
    if (terminal) {
      setGeneration((current) =>
        current?.generationId === terminal.generationId ? terminal : current,
      );
      setMessages((current) => mergeGenerationMessage(current, terminal.conversationId, terminal));
    }
    stopAgentTaskEventPolling();
  };

  const cancelGenerationForConversation = async (conversationId: string) => {
    if (
      generation &&
      isGenerationActive(generation) &&
      generation.conversationId !== conversationId
    ) {
      if (generation.executionMode === 'native') await cancelNativeLlmRun();
      setGeneration(
        await callWorker('llm.generation.cancel', { generationId: generation.generationId }),
      );
    }
  };

  const conversationWorkspace = useConversationWorkspace({
    projectId: project?.id,
    scopeAvailable,
    scopeType,
    scopeId,
    setMessages,
    setContextPreview,
    setChatMessage,
    onCancelGenerationForConversation: cancelGenerationForConversation,
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
    reset: resetConversationWorkspace,
  } = conversationWorkspace;

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

  const loadProjectContent = async () => {
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
      if (requestId !== projectContentRequest.current) return;
      setDocuments(documentList);
      setConstraints(constraintList);
      setScenes(sceneList);
      setScene(firstScene);
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

  const ensureWorkerProjectSession = async (): Promise<boolean> => {
    if (!project?.rootPath) return false;
    const current = await callWorker('project.current', {});
    if (current) return true;
    await callWorker('project.open', { rootPath: project.rootPath });
    await loadProjectContent();
    return true;
  };

  useEffect(() => {
    void checkRuntime();
    void loadLlmCatalog();
    void callWorker('llm.status', {})
      .then(setLlmStatus)
      .catch(() => undefined);
    void Promise.all([callWorker('project.current', {}), callWorker('project.recent', {})])
      .then(async ([current, recent]) => {
        setProject(current ?? undefined);
        setRecentProjects(recent);
        if (current) await loadProjectContent();
      })
      .catch(() => undefined)
      .finally(() => setStartupLoaded(true));
  }, []);

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
    try {
      window.localStorage.setItem(
        LLM_SELECTION_STORAGE_KEY,
        JSON.stringify({
          providerProfileId: selectedLlmProfileId || undefined,
          modelId: selectedLlmModelId || undefined,
          researchMode,
          composerMode,
        }),
      );
    } catch {
      // The selection remains available for the current session when storage is unavailable.
    }
  }, [selectedLlmProfileId, selectedLlmModelId, researchMode, composerMode]);

  useEffect(
    () => () => {
      void nativeLlmRun.current?.cancel();
      confirmationResolverRef.current?.(false);
    },
    [],
  );

  useEffect(() => {
    const run = nativeLlmRun.current;
    if (
      run &&
      (run.identity.projectId !== project?.id || run.identity.conversationId !== conversation?.id)
    ) {
      void cancelNativeLlmRun();
    }
  }, [project?.id, conversation?.id]);

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
    if (!generation || generation.executionMode === 'native' || generation.status !== 'streaming')
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
          if (next.status !== 'streaming') {
            setChatMessage(next.error ?? '生成完成');
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
  }, [project?.id, generation?.generationId, generation?.status, conversation?.id]);

  // Re-discover persisted Agent tasks after app restart or conversation switches.
  // SQLite remains authoritative; this only restores observation/presentation and
  // never starts a second runtime or replays a side effect.
  useEffect(() => {
    const projectId = project?.id;
    const conversationId = conversation?.id;
    if (!projectId || !conversationId) {
      stopAgentTaskEventPolling();
      setAgentTask(undefined);
      return;
    }
    let active = true;
    void Promise.resolve()
      .then(() => callWorker('agent.task.list', { limit: 50, conversationId }))
      .then((tasks) => {
        if (!active) return;
        const candidate = tasks
          .filter((task) => ['queued', 'running', 'waiting_review', 'failed'].includes(task.status))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (!candidate) {
          stopAgentTaskEventPolling();
          setAgentTask(undefined);
          return;
        }
        void Promise.resolve()
          .then(() => callWorker('agent.task.get', { taskId: candidate.id }))
          .then((detail) => {
            if (!active) return;
            setAgentTask(detail);
            if (['queued', 'running'].includes(detail.task.status)) {
              startAgentTaskEventPolling(detail.task.id);
            }
          })
          .catch(() => undefined);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [project?.id, conversation?.id]);

  const runProjectAction = async (action: () => Promise<ProjectInfo | string | undefined>) => {
    const requestId = ++projectActionRequest.current;
    generationPollVersion.current += 1;
    projectContentRequest.current += 1;
    resetConversationWorkspace();
    resetDocumentWorkspace();
    sceneRequest.current += 1;
    await cancelNativeLlmRun();
    setProjectBusy(true);
    setProjectMessage('');
    try {
      const result = await action();
      if (requestId !== projectActionRequest.current) return;
      if (typeof result === 'string') setProjectMessage(result);
      else if (result) {
        setGeneration(undefined);
        setProject(result);
        await loadProjectContent();
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
    return runProjectAction(() => callWorker('project.create', { name, rootPath }));
  };
  const createSampleProject = () => {
    const rootPath = normalizeProjectPath(projectPath);
    if (!rootPath) return;
    return runProjectAction(() =>
      callWorker('project.createSample', {
        rootPath,
        name: projectName.trim() || undefined,
      }),
    );
  };
  const openProject = (requestedPath?: string) => {
    const rootPath = normalizeProjectPath(requestedPath ?? projectPath);
    if (!rootPath) return;
    return runProjectAction(() => callWorker('project.open', { rootPath }));
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
      await callWorker('project.close', {});
      setProject(undefined);
      resetDocumentWorkspace();
      setScenes([]);
      resetAssetWorkspace();
      resetConversationWorkspace();
      setGeneration(undefined);
      return '项目已安全关闭';
    });

  const openSettings = (page: SettingsPage = project ? 'providers' : 'maintenance') => {
    setSettingsInitialPage(page);
    setSettingsOpen(true);
    maintenance.clearMaintenanceMessage();
    if (project) void maintenance.inspectCache();
  };

  const openConversationById = async (conversationId: string) => {
    try {
      const page = await callWorker('conversation.list', { includeArchived: true });
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
    setScene(created);
    setShots([]);
    setShot(undefined);
    setView('shots');
  };

  const selectScene = async (selected: SceneInfo) => {
    const requestId = ++sceneRequest.current;
    conversationRequest.current += 1;
    setScene(selected);
    setShot(undefined);
    try {
      const items = await callWorker('shot.list', { sceneId: selected.id });
      if (requestId !== sceneRequest.current) return;
      setShots(items);
      setShot(items[0]);
      setView('shots');
    } catch (reason) {
      if (requestId === sceneRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '镜头加载失败');
      }
    }
  };

  useEffect(() => {
    setShotPrompt(shot?.prompt ?? '');
  }, [shot?.id]);

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
    setShotStoryboardBusy(true);
    try {
      const updated = await callWorker('shot.storyboard.save', {
        shotId: shot.id,
        title: shotStoryboardTitle.trim() || shot.title,
        contentMarkdown: shotStoryboardContent,
      });
      setShotStoryboard(updated);
      setShotStoryboardTitle(updated.title);
      setShotStoryboardContent(updated.currentVersion?.contentMarkdown ?? '');
      if (!shot.documentId) {
        const attached: ShotInfo = { ...shot, documentId: updated.id };
        setShot(attached);
        setShots((rows) => rows.map((row) => (row.id === shot.id ? attached : row)));
      }
      setChatMessage('分镜文档已保存。');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '分镜文档保存失败');
    } finally {
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

  const saveShotPrompt = async () => {
    if (!shot) return;
    try {
      const updated = await callWorker('shot.save', {
        shotId: shot.id,
        sceneId: shot.sceneId,
        title: shot.title,
        prompt: shotPrompt,
        expectedRowVersion: shot.rowVersion,
      });
      setShots((rows) => rows.map((row) => (row.id === shot.id ? updated : row)));
      setShot(updated);
      setChatMessage('镜头提示词已保存。');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '镜头提示词保存失败');
    }
  };

  const runShortDramaGeneration = async (prompt: string) => {
    if (!conversation) return;
    if (!selectedLlmProfile || !selectedLlmModel) {
      setComposer(prompt);
      setChatMessage('短剧创作需要已配置支持工具调用的 LLM 模型。');
      return;
    }
    if (episodeChapterIds.length === 0) {
      setComposer(prompt);
      setChatMessage('请先在小说章节页选择章节，再生成短剧内容。');
      return;
    }
    try {
      const prepared = await callWorker('agent.generation.prepare', {
        conversationId: conversation.id,
        prompt,
        providerProfileId: selectedLlmProfile.id,
        modelId: selectedLlmModel.id,
        agentMode: 'short-drama',
        targetPlatform: 'seedance',
        researchMode,
        documentIntent: { operation: inferShortDramaIntent(prompt) },
        selectedChapterIds: episodeChapterIds,
      });
      if ('pendingIntent' in prepared) {
        setComposer(prompt);
        setChatMessage('短剧创作目标需要澄清；请补充指令后再提交。');
        return;
      }
      launchPreparedGeneration(prepared);
    } catch (reason) {
      setComposer(prompt);
      setChatMessage(reason instanceof Error ? reason.message : '短剧生成任务启动失败');
      void loadLlmCatalog();
    }
  };

  const sendMessage = async (
    composerValue = composer,
    modelSelection?: {
      providerProfileId: string;
      modelId: string;
      adapterKey?: string;
      parameters?: Record<string, string | number | boolean | string[]>;
    },
  ) => {
    if ((!composerValue.trim() && chatAttachments.length === 0) || !conversation) return;
    // A Worker sidecar can restart independently of the Desktop window. In
    // that case restore the project session before any Agent/media operation.
    try {
      await ensureWorkerProjectSession();
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '项目会话未打开');
      return;
    }
    const prompt = composerValue;
    const attachmentContext = chatAttachments.length
      ? `\n\n[附件：${chatAttachments.map((attachment) => attachment.name).join('、')}]${chatAttachments
          .filter((attachment) => attachment.text)
          .map((attachment) => `\n\n--- ${attachment.name} ---\n${attachment.text}`)
          .join('')}`
      : '';
    const promptForAgent = prompt.includes('[附件：') ? prompt : `${prompt}${attachmentContext}`;
    setComposer('');
    if (composerMode === 'chat' && isModelSchemaQuery(prompt)) {
      try {
        const capability = inferAgentCapability(prompt);
        const catalog = await callWorker('model.catalog.list', {
          capability: capability === 'image' || capability === 'video' ? capability : undefined,
        });
        const summary = catalog.models
          .map(
            (item) =>
              `${item.providerName} / ${item.modelName}: ${item.schemaStatus === 'confirmed' ? `${item.adapters.length} 个适配器，必填 ${item.missingRequired.join('、') || '无'}` : 'schema 尚未配置'}`,
          )
          .join('\n');
        setChatMessage(summary || '当前没有找到匹配的模型或参数 schema。');
      } catch (reason) {
        setChatMessage(reason instanceof Error ? reason.message : '模型目录查询失败');
      }
      return;
    }
    if (composerMode === 'novel-writing') {
      await createNovelDraft(promptForAgent);
      return;
    }
    if (composerMode === 'short-drama') {
      await runShortDramaGeneration(promptForAgent);
      return;
    }
    if (
      composerMode === 'chat' &&
      (selectedLlmProfile || llmProfiles.length > 0) &&
      (modelSelection || (selectedLlmProfile && selectedLlmModel) || llmProfiles.length > 0)
    ) {
      try {
        setAgentModelSelection(undefined);
        setAgentParameterRequest(undefined);
        const capability = inferAgentCapability(prompt);
        let agentPrompt = promptForAgent;
        if (capability === 'image') {
          const isImagePromptDocument = (item: { kind: string; title: string }) =>
            (item.kind === 'character' || item.kind === 'scene') &&
            /(提示词|三视图|立绘|角色)/u.test(item.title);
          let promptDocument =
            document?.currentVersion?.contentMarkdown &&
            document.title &&
            isImagePromptDocument(document)
              ? { title: document.title, content: document.currentVersion.contentMarkdown }
              : undefined;
          if (!promptDocument) {
            const candidate = [...documents]
              .filter(isImagePromptDocument)
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
            if (candidate) {
              const detail = await callWorker('document.get', { documentId: candidate.id });
              if (detail.currentVersion?.contentMarkdown) {
                promptDocument = {
                  title: detail.title,
                  content: detail.currentVersion.contentMarkdown,
                };
              }
            }
          }
          agentPrompt = composeImageGenerationPrompt(promptForAgent, promptDocument);
        }
        const remembered = conversation
          ? agentModelPreferences[conversation.id]?.[capability]
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
          : buildAgentAttachments(chatAttachments);
        const unified = await callWorker('agent.run', {
          conversationId: conversation.id,
          prompt: agentPrompt || '请分析我提供的附件。',
          capability,
          ...(agentAttachments ? { attachments: agentAttachments } : {}),
          ...(providerProfileId && modelId ? { providerProfileId, modelId } : {}),
          ...(modelSelection?.adapterKey ? { adapterKey: modelSelection.adapterKey } : {}),
          ...(modelSelection?.parameters ? { parameters: modelSelection.parameters } : {}),
        });
        if (
          unified.status !== 'needs_model_selection' &&
          providerProfileId &&
          modelId &&
          conversation &&
          capability !== 'auto'
        ) {
          void callWorker('conversation.modelPreference.set', {
            conversationId: conversation.id,
            capability,
            providerProfileId,
            modelId,
          }).catch(() => undefined);
        }
        if (unified.status === 'needs_model_selection') {
          setComposer(prompt);
          setChatMessage('');
          setAgentModelSelection({
            prompt: agentPrompt || '请分析我提供的附件。',
            capability: unified.capability,
            models: unified.models,
          });
          return;
        }
        if (unified.status === 'needs_parameters') {
          setComposer(prompt);
          setAgentParameterRequest({
            referenceImageInputs: collectReferenceImageInputs(chatAttachments),
            prompt: agentPrompt || '请根据附件生成内容。',
            ...unified,
          });
          setChatMessage('');
          return;
        }
        if (unified.status === 'image_prepared' || unified.status === 'video_prepared') {
          if (unified.status === 'image_prepared') {
            let response: Awaited<ReturnType<typeof submitProviderRequest>>;
            try {
              response = await submitProviderRequest(
                unified.job.adapterKey,
                unified.job.request,
                providerProfileId!,
              );
            } catch (reason) {
              await callWorker('image.generate.fail', { jobId: unified.job.id }).catch(
                () => undefined,
              );
              throw reason;
            }
            const completed = await callWorker('image.generate.complete', {
              jobId: unified.job.id,
              providerStatus: response.status,
              providerBody: response.body,
              assetKind: 'generated-image',
            });
            if (completed.status === 'succeeded') {
              const nextAssets = await callWorker('asset.list', {});
              updateAssets(nextAssets, completed.results[0]?.asset?.id);
            }
            setChatMessage(
              completed.status === 'succeeded'
                ? '图片已生成并新增到素材库。'
                : (completed.error ?? '图片生成失败。'),
            );
          } else {
            const response = await submitVideoProviderTask(
              unified.job.adapterKey,
              unified.job.request,
              providerProfileId!,
              unified.job.metadata.providerRegion,
            );
            if (response.status < 200 || response.status >= 300 || !response.taskId) {
              const failed = await callWorker('video.generate.fail', {
                jobId: unified.job.id,
                failureKind: 'provider',
                message: response.errorMessage ?? `Provider HTTP ${response.status}`,
              });
              setChatMessage(failed.error ?? '视频任务提交失败。');
            } else {
              await callWorker('video.generate.attachTask', {
                jobId: unified.job.id,
                providerTaskId: response.taskId,
              });
              setChatMessage('视频任务已提交，可能产生费用；请在制作面板查看进度。');
            }
          }
          setChatAttachments([]);
          return;
        }
        if (!('generation' in unified) || !('stream' in unified)) {
          setComposer(prompt);
          setChatMessage('Agent 任务需要进一步澄清，当前没有创建生成任务。');
          return;
        }
        launchPreparedGeneration(unified);
      } catch (reason) {
        setComposer(prompt);
        setChatMessage(readableFailure(reason, '生成启动失败'));
        void loadLlmCatalog();
      }
      return;
    }
    if (selectedLlmProfile && selectedLlmModel) {
      try {
        const prepared = await callWorker('llm.generation.prepare', {
          conversationId: conversation.id,
          prompt,
          providerProfileId: selectedLlmProfile.id,
          modelId: selectedLlmModel.id,
        });
        launchPreparedGeneration(prepared);
      } catch (reason) {
        setComposer(prompt);
        setChatMessage(readableFailure(reason, '生成启动失败'));
        void loadLlmCatalog();
      }
      return;
    }
    if (llmStatus?.configured) {
      try {
        const started = await callWorker('llm.generate', {
          conversationId: conversation.id,
          prompt,
        });
        setGeneration(started);
        setMessages((current) => [...current, started.userMessage, started.assistantMessage]);
      } catch (reason) {
        setComposer(prompt);
        setChatMessage(reason instanceof Error ? reason.message : '生成启动失败');
      }
      return;
    }
    const saved = await callWorker('chat.message.save', {
      conversationId: conversation.id,
      role: 'user',
      content: prompt,
    });
    setMessages((current) => [...current, saved]);
    setChatMessage('消息已保存；在供应商与模型中添加 LLM 连接后可生成回复');
  };

  const addChatAttachments = async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    if (chatAttachments.length + incoming.length > MAX_CHAT_ATTACHMENTS) {
      setChatMessage(`最多同时添加 ${MAX_CHAT_ATTACHMENTS} 个附件。`);
      return;
    }
    if (
      chatAttachments.reduce((total, attachment) => total + attachment.size, 0) +
        incoming.reduce((total, file) => total + file.size, 0) >
      MAX_CHAT_TOTAL_BYTES
    ) {
      setChatMessage('附件总大小不能超过 40 MiB。');
      return;
    }
    try {
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
        if (kind === 'image') attachment.dataUrl = await readImageAsDataUrl(file);
        else if (kind === 'video') {
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
      setChatAttachments((current) => [...current, ...next]);
      setChatMessage('附件已添加，可以继续描述任务后发送。');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '添加附件失败');
    }
  };

  const removeChatAttachment = (id: string) => {
    setChatAttachments((current) => current.filter((attachment) => attachment.id !== id));
  };

  const createDocumentDraft = async () => {
    if (!composer.trim() || !conversation) return;
    const prompt = composer;
    if (composerMode === 'short-drama') {
      setComposer('');
      await runShortDramaGeneration(prompt);
      return;
    }
    if (!selectedLlmProfile || !selectedLlmModel) {
      setChatMessage('创建文档草稿需要已配置支持工具调用的 LLM 模型。');
      return;
    }
    setComposer('');
    try {
      const prepared = await callWorker('agent.generation.prepare', {
        conversationId: conversation.id,
        prompt,
        providerProfileId: selectedLlmProfile.id,
        modelId: selectedLlmModel.id,
        agentMode: 'document',
        researchMode,
        documentIntent: { operation: 'document.create_draft' },
      });
      if ('pendingIntent' in prepared) {
        setComposer(prompt);
        setChatMessage('文档目标需要澄清；补充目标后再提交。');
        return;
      }
      launchPreparedGeneration(prepared);
    } catch (reason) {
      setComposer(prompt);
      setChatMessage(reason instanceof Error ? reason.message : '文档草稿任务启动失败');
    }
  };

  const createNovelDraft = async (
    prompt: string,
    novelIntent?: {
      action?: 'create_chapter' | 'continue_chapter' | 'rewrite_chapter';
      chapterTitle?: string;
      displayLabel?: string;
    },
  ) => {
    if (!conversation) return;
    if (!selectedLlmProfile || !selectedLlmModel) {
      setComposer(prompt);
      setChatMessage('小说创作需要已配置支持工具调用的 LLM 模型。');
      return;
    }
    try {
      const prepared = await callWorker('agent.generation.prepare', {
        conversationId: conversation.id,
        prompt,
        providerProfileId: selectedLlmProfile.id,
        modelId: selectedLlmModel.id,
        agentMode: 'novel-writing',
        researchMode,
        novelIntent,
      });
      if ('pendingIntent' in prepared) {
        setComposer(prompt);
        setChatMessage('创作目标需要澄清；补充章节或动作后再提交。');
        return;
      }
      launchPreparedGeneration(prepared);
    } catch (reason) {
      setComposer(prompt);
      setChatMessage(reason instanceof Error ? reason.message : '小说草稿任务启动失败');
    }
  };

  const createNovelChapter = async () => {
    if (!conversation) return;
    const title = window.prompt('章节名称');
    if (!title?.trim()) return;
    const label = window.prompt('章节显示标签', '');
    const prompt = composer.trim() || `创作章节《${title.trim()}》。`;
    setComposer('');
    await createNovelDraft(prompt, {
      action: 'create_chapter',
      chapterTitle: title.trim(),
      displayLabel: label?.trim() || undefined,
    });
  };

  const cancelGeneration = async () => {
    const current = generation;
    if (!current || !isGenerationActive(current)) return;
    const agentTaskId = agentTask?.task.id;
    confirmationResolverRef.current?.(false);
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
      setAgentTask(detail);
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
      setAgentTask(detail);
      setChatMessage('Schema 提议已拒绝，已回滚到上一确认版本。');
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : 'Schema 提议回滚失败');
    }
  };

  const retryGeneration = async (assistantMessageId: string) => {
    if (retryRequestsRef.current.has(assistantMessageId)) return;
    retryRequestsRef.current.add(assistantMessageId);
    try {
      const idempotencyKey = `desktop-retry:${assistantMessageId}:${crypto.randomUUID()}`;
      if (selectedLlmProfile && selectedLlmModel) {
        const prepared = await callWorker('llm.generation.retryPrepare', {
          assistantMessageId,
          providerProfileId: selectedLlmProfile.id,
          modelId: selectedLlmModel.id,
          idempotencyKey,
        });
        launchPreparedGeneration(prepared);
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

  const promoteMessage = async (
    message: ChatMessageInfo,
    target: 'document' | 'memory' | 'constraint',
  ) => {
    try {
      if (target === 'document') {
        const created = await callWorker('agent.task.createDocumentDraft', {
          messageId: message.id,
          title: `会话产物 ${new Date().toLocaleDateString()}`,
        });
        await openCreatedDocument(created.document);
        setChatMessage(`已创建草稿任务：${created.task.title}，请在编辑器审核后发布`);
      } else if (target === 'memory') {
        await callWorker('chat.message.toMemory', { messageId: message.id });
      } else {
        await callWorker('chat.message.toConstraint', { messageId: message.id });
      }
      if (target !== 'document') {
        setChatMessage(target === 'memory' ? '已添加到项目记忆' : '已添加生产约束');
      }
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '操作失败');
    }
  };

  const openNovelDocument = async (documentId: string) => {
    await openDocumentById(documentId);
    const existingLabel = Object.values(detachedRegistryRef.current).find(
      (registration) =>
        registration.config.panelId === 'document' &&
        registration.config.projectId === project?.id &&
        registration.config.entityId === documentId,
    )?.config.label;
    if (existingLabel) await focusDetachedPanelWindow(existingLabel);
  };

  const detachPanel = async (panelId: WorkspacePanelId) => {
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

  const updateDetachedDocumentReview = (
    label: string,
    action: 'submit' | 'requestChanges' | 'publish' | 'restore',
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
      if (action === 'submit') {
        await callWorker('document.review.submit', {
          documentId: snapshot.documentId,
          documentVersionId: snapshot.currentVersionId,
          expectedDocumentRowVersion: snapshot.rowVersion,
        });
      } else if (action === 'requestChanges') {
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
        statusMessage: action === 'submit' ? '已提交审核' : '已退回修改，可继续编辑后重新提交审核',
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
      } else if (action.type === 'document-restore') {
        void updateDetachedDocumentReview(label, 'restore', action.versionId);
      } else if (action.type === 'document-submit-review') {
        void updateDetachedDocumentReview(label, 'submit');
      } else if (action.type === 'document-request-changes') {
        void updateDetachedDocumentReview(label, 'requestChanges');
      } else if (action.type === 'document-publish') {
        void updateDetachedDocumentReview(label, 'publish');
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
    )
      return;
    if (action.type === 'conversation-scope') {
      void (async () => {
        await cancelNativeLlmRun();
        conversationRequest.current += 1;
        generationPollVersion.current += 1;
        setScopeType(action.scope);
      })();
    } else if (action.type === 'conversation-select') {
      const selected = conversations.find((item) => item.id === action.conversationId);
      if (selected) void selectConversation(selected);
    } else if (action.type === 'conversation-create') {
      void createConversation();
    } else if (action.type === 'conversation-promote') {
      const message = messages.find((item) => item.id === action.messageId);
      if (message) void promoteMessage(message, action.target);
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
      setComposer(action.value);
    } else if (action.type === 'conversation-cancel') {
      void cancelGeneration();
    } else if (action.type === 'conversation-send') {
      setComposer(action.value);
      void sendMessage(action.value);
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
    scopeType,
    selectedLlmProfileId,
    selectedLlmModelId,
    researchMode,
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
      composerMode={composerMode}
      episodeChapterCount={episodeChapterIds.length}
      contextPreview={contextPreview}
      generation={generation}
      agentTask={agentTask}
      confirmation={agentConfirmation}
      agentModelSelection={agentModelSelection}
      onSelectAgentModel={(providerProfileId, modelId) => {
        const pending = agentModelSelection;
        if (!pending || (pending.capability !== 'image' && pending.capability !== 'video')) {
          setSelectedLlmProfileId(providerProfileId);
          setSelectedLlmModelId(modelId);
        }
        if (pending) {
          setAgentModelPreferences((current) => ({
            ...current,
            [conversation?.id ?? '']: {
              ...current[conversation?.id ?? ''],
              [pending.capability]: { providerProfileId, modelId },
            },
          }));
          void sendMessage(pending.prompt, { providerProfileId, modelId });
        }
      }}
      onConfirmAgentAction={(approved) => confirmationResolverRef.current?.(approved)}
      onConfirmSchemaProposal={(adapterKey, version) => {
        void confirmSchemaProposal(adapterKey, version);
      }}
      onRejectSchemaProposal={(adapterKey, version) => {
        void rejectSchemaProposal(adapterKey, version);
      }}
      onOpenTaskLog={() => {
        setNavigationMode('project');
        setView('tasks');
      }}
      onContinueAgentTask={() => {
        const prompt = '请继续完成尚未成功的短剧交付物，并调用已授权工具。';
        setComposer(prompt);
        if (conversation && composerMode === 'short-drama') void sendMessage(prompt);
      }}
      onClose={() => workspaceDispatch({ type: 'close', panelId: 'conversation' })}
      showCloseAction={false}
      onScopeChange={(scope) => {
        void (async () => {
          await cancelNativeLlmRun();
          conversationRequest.current += 1;
          generationPollVersion.current += 1;
          setScopeType(scope);
        })();
      }}
      onSelectConversation={(selected) => void selectConversation(selected)}
      onCreateConversation={() => void createConversation()}
      onRenameConversation={(conversationId, title) =>
        void renameConversation(conversationId, title)
      }
      onArchiveConversation={(conversationId) => void archiveConversation(conversationId)}
      onRestoreConversation={(conversationId) => void restoreConversation(conversationId)}
      canLoadMoreConversations={Boolean(conversationNextCursor)}
      onLoadMoreConversations={() => void loadMoreConversations()}
      onPromoteMessage={(message, target) => void promoteMessage(message, target)}
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
      onComposerChange={setComposer}
      attachments={chatAttachments}
      onAddAttachments={(files) => void addChatAttachments(files)}
      onRemoveAttachment={removeChatAttachment}
      onCancelGeneration={() => void cancelGeneration()}
      onSendMessage={() => void sendMessage()}
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
        void sendMessage(pending.prompt, {
          providerProfileId: pending.providerProfileId,
          modelId: pending.modelId,
          adapterKey,
          parameters: adapterParameters,
        });
      }}
      onCreateDocumentDraft={() => void createDocumentDraft()}
      onCreateNovelChapter={() => void createNovelChapter()}
    />
  );

  const productionPanel = (
    <ProductionPanel
      expanded
      capability={productionCapability}
      projectId={project?.id}
      projectRootPath={project?.rootPath}
      shotId={shot?.id}
      writable={writable}
      assets={assets}
      focusedAssetId={focusedSource?.assetId}
      focusedJobId={focusedSource?.jobId}
      onAssetsChanged={updateAssets}
      onOpenAssetLibrary={(assetId) => {
        updateAssets(assets, assetId);
        setAssetLibrarySelectedId(assetId);
        setNavigationMode('project');
        setView('assets');
      }}
      onOpenProviderSettings={() => openSettings('providers')}
      onClose={() => setNavigationMode('project')}
      providerSettingsRevision={providerSettingsRevision}
    />
  );

  const projectDocuments = documents.filter(
    (item) => item.kind === 'outline' || item.kind === 'plan',
  );
  const characterSceneDocuments = documents.filter(
    (item) => item.kind === 'character' || item.kind === 'scene',
  );

  const renderDocumentToolbar = (
    eyebrow: string,
    fallbackTitle: string,
    stayView?: WorkspaceView,
  ) => (
    <div className="workspace-toolbar">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{document?.title ?? fallbackTitle}</h1>
      </div>
      <div className="toolbar-actions">
        <button
          className="button secondary markdown-import-button"
          type="button"
          aria-label="导入 Markdown"
          title="导入 Markdown"
          onClick={() =>
            void importMarkdownDocument().then(() => {
              if (stayView) setView(stayView);
            })
          }
          disabled={!writable || contentBusy}
        >
          <FileUp size={15} />
          <span>导入 Markdown</span>
        </button>
        <button
          className="button secondary"
          type="button"
          onClick={() => {
            newDocument();
            if (stayView) setView(stayView);
          }}
          disabled={!writable}
        >
          <FilePlus2 size={15} />
          新建
        </button>
        <button
          className="button primary"
          type="button"
          onClick={() => void saveDocument()}
          disabled={!documentEditorWritable || contentBusy || !documentTitle.trim()}
        >
          <Save size={15} />
          保存草稿
        </button>
        {document?.currentVersion &&
          ['draft', 'changes_requested'].includes(document.currentVersion.state) && (
            <button
              className="button secondary"
              type="button"
              onClick={() => void submitDocumentReview()}
              disabled={!documentEditorWritable || contentBusy || documentDirty}
            >
              提交审核
            </button>
          )}
        {document?.currentVersion?.state === 'in_review' && (
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
              发布权威版本
            </button>
          </>
        )}
      </div>
    </div>
  );

  const renderDocumentEditor = () => (
    <div className="document-workspace">
      <div className="document-fields">
        <label className="title-field">
          标题
          <input
            value={documentTitle}
            onChange={(event) => setDocumentTitle(event.target.value)}
            placeholder="输入文档标题"
            readOnly={!documentEditorWritable}
          />
        </label>
        <label className="kind-field">
          类型
          <select
            value={documentKind}
            onChange={(event) => setDocumentKind(event.target.value as DocumentKind)}
            disabled={!documentEditorWritable}
            aria-label="文档类型"
          >
            {(
              ['outline', 'plan', 'character', 'scene', 'storyboard', 'note'] as DocumentKind[]
            ).map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <span
          className={`document-state document-state-${document?.currentVersion?.state ?? 'new'}`}
        >
          {documentStateLabel(document?.currentVersion?.state ?? 'new')}
        </span>
      </div>
      <textarea
        className="markdown-editor"
        aria-label="文档内容"
        value={documentContent}
        onChange={(event) => setDocumentContent(event.target.value)}
        placeholder="使用 Markdown 编写项目内容…"
        readOnly={!documentEditorWritable}
      />
      {contentMessage && <div className="inline-status">{contentMessage}</div>}
      {versions.length > 0 && (
        <div className="version-strip">
          <span>历史版本</span>
          {versions.map((version) => (
            <button
              type="button"
              key={version.id}
              title={new Date(version.createdAt).toLocaleString()}
              onClick={() => void restoreVersion(version.id)}
              disabled={!documentEditorWritable || version.id === document?.currentVersionId}
            >
              <RotateCcw size={12} />v{version.version}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const openCharacterSceneDocument = async (item: DocumentSummary) => {
    await openDocumentById(item.id);
    setView('characters');
  };

  return (
    <div className="app-shell" data-left-open={leftOpen} data-navigation-mode={navigationMode}>
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
          <span data-tauri-drag-region>{project?.name ?? '未打开项目'}</span>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            title="打开项目"
            onClick={() => void selectProjectDirectory(true)}
            disabled={projectBusy}
          >
            <FolderOpen size={17} />
          </button>
          <button
            className="icon-button"
            type="button"
            title="新建项目"
            onClick={() => void createProject()}
            disabled={projectBusy || !projectPath.trim() || !projectName.trim()}
          >
            <Plus size={18} />
          </button>
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
            className="icon-button mobile-production-toggle"
            type="button"
            title="选择制作方式"
            aria-expanded={productionMenuOpen}
            onClick={() => setProductionMenuOpen((open) => !open)}
          >
            <WandSparkles size={17} />
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

      {productionMenuOpen && (
        <section className="mobile-production-menu" aria-label="窄屏制作方式">
          <header>
            <strong>选择制作方式</strong>
            <button
              className="icon-button subtle"
              type="button"
              title="关闭制作方式"
              onClick={() => setProductionMenuOpen(false)}
            >
              <X size={15} />
            </button>
          </header>
          <ProductionNavigation
            compact
            capability={productionCapability}
            onCapabilityChange={(capability) => {
              setProductionCapability(capability);
              setNavigationMode('production');
              setProductionMenuOpen(false);
            }}
          />
        </section>
      )}

      {settingsOpen && (
        <SettingsCenter
          initialPage={settingsInitialPage}
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

      <ResizableAppLayout
        projectId={project?.id}
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
                onClick={() => {
                  setNavigationMode('project');
                  setView('novel');
                }}
              >
                <BookOpen size={16} />
                <span>小说章节</span>
              </button>
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'documents' ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setNavigationMode('project');
                  setView('documents');
                }}
              >
                <FileText size={16} />
                <span>项目文档</span>
                <span className="count">{documents.length}</span>
              </button>
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'shots' ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setNavigationMode('project');
                  setView('shots');
                }}
              >
                <Clapperboard size={16} />
                <span>场次与镜头</span>
                <span className="count">{shots.length}</span>
              </button>
              <button
                className={`nav-item ${
                  navigationMode === 'project' &&
                  (view === 'characters' ||
                    (view === 'documents' &&
                      document?.kind &&
                      (document.kind === 'character' || document.kind === 'scene')))
                    ? 'active'
                    : ''
                }`}
                type="button"
                onClick={() => {
                  setNavigationMode('project');
                  setView('characters');
                }}
              >
                <Aperture size={16} />
                <span>角色与场景</span>
                <span className="count">{characterSceneDocuments.length}</span>
              </button>
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'assets' ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setNavigationMode('project');
                  setView('assets');
                }}
              >
                <Image size={16} />
                <span>素材库</span>
                <span className="count">{assets.length}</span>
              </button>
              <button
                className={`nav-item ${navigationMode === 'project' && view === 'tasks' ? 'active' : ''}`}
                type="button"
                onClick={() => {
                  setNavigationMode('project');
                  setView('tasks');
                }}
              >
                <ListChecks size={16} />
                <span>任务日志</span>
              </button>
            </nav>

            <ProductionNavigation
              capability={productionCapability}
              onCapabilityChange={(capability) => {
                setProductionCapability(capability);
                setNavigationMode('production');
              }}
            />

            <section className="project-manager" aria-label="项目管理">
              {project ? (
                <>
                  <div className="open-project-card">
                    <strong>{project.name}</strong>
                    <span title={project.rootPath}>{project.rootPath}</span>
                    <small>
                      {project.mode === 'read-write' ? '可写' : '只读'} · Schema v
                      {project.schemaVersion}
                    </small>
                  </div>
                  <div className="project-actions">
                    <button
                      type="button"
                      onClick={() =>
                        void runProjectAction(async () => {
                          const result = await callWorker('project.integrity', {});
                          return result.ok
                            ? `完整性检查通过 · Schema v${result.schemaVersion}`
                            : result.messages.join('; ');
                        })
                      }
                    >
                      检查
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void runProjectAction(
                          async () => `备份完成：${(await callWorker('project.backup', {})).path}`,
                        )
                      }
                      disabled={!writable}
                    >
                      <Save size={12} />
                      备份
                    </button>
                    <button type="button" onClick={() => void closeProject()}>
                      关闭
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {startupLoaded && recentProjects.length === 0 && (
                    <div className="first-run-block">
                      <strong>开始创作</strong>
                      <span>示例：雾港来信</span>
                    </div>
                  )}
                  <label htmlFor="project-name">项目名称</label>
                  <input
                    id="project-name"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                  />
                  <label htmlFor="project-path">项目绝对目录</label>
                  <div className="project-path-row">
                    <input
                      id="project-path"
                      value={projectPath}
                      onChange={(event) => setProjectPath(event.target.value)}
                      placeholder="D:\Projects\my-drama"
                    />
                    <button
                      type="button"
                      aria-label="选择项目目录"
                      title="选择项目目录"
                      onClick={() => void selectProjectDirectory()}
                      disabled={projectBusy}
                    >
                      <FolderOpen size={14} />
                    </button>
                  </div>
                  <div className="project-actions">
                    <button
                      type="button"
                      onClick={() => void createProject()}
                      disabled={projectBusy || !projectPath.trim() || !projectName.trim()}
                    >
                      新建
                    </button>
                    <button
                      type="button"
                      onClick={() => void openProject()}
                      disabled={projectBusy || !projectPath.trim()}
                    >
                      打开
                    </button>
                  </div>
                  {startupLoaded && recentProjects.length === 0 && (
                    <button
                      className="sample-project-button"
                      type="button"
                      onClick={() => void createSampleProject()}
                      disabled={projectBusy || !projectPath.trim()}
                    >
                      <Clapperboard size={13} />
                      创建示例项目
                    </button>
                  )}
                  {recentProjects.map((recent) => (
                    <button
                      className="recent-link"
                      type="button"
                      key={recent.rootPath}
                      onClick={() => void openProject(recent.rootPath)}
                    >
                      {recent.name}
                    </button>
                  ))}
                </>
              )}
              {projectMessage && <small className="project-message">{projectMessage}</small>}
            </section>
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
                <small>
                  Worker {health.workerVersion} · PID {health.pid}
                </small>
              )}
              {sqlite && (
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

        <main className="workspace panel-border">
          <WorkspaceSurface
            layout={workspaceLayout}
            dispatch={workspaceDispatch}
            documentTitle={document?.title ?? documentTitle}
            conversationContent={conversationPanel}
            productionContent={productionPanel}
            productionOpen={navigationMode === 'production'}
            documentActive={view === 'documents'}
            detachedPanels={detachedPanels}
            onOpenConversation={() => void focusDetachedPanelWindow(detachedPanels.conversation)}
            onOpenDocument={() => {
              if (detachedPanels.document) {
                void focusDetachedPanelWindow(detachedPanels.document);
              } else {
                setView('documents');
              }
            }}
            onCloseDocument={requestCloseDocument}
            onDetachDocument={() => void detachPanel('document')}
            onDetachConversation={() => void detachPanel('conversation')}
          >
            {view === 'novel' ? (
              <NovelWorkspace
                projectId={project?.id}
                writable={writable}
                onOpenDocument={(documentId) => void openNovelDocument(documentId)}
                onGenerateEpisode={(chapterIds) => {
                  setEpisodeChapterIds(chapterIds);
                  setComposerMode('short-drama');
                  workspaceDispatch({ type: 'open', panelId: 'conversation' });
                  setChatMessage(
                    `已选择 ${chapterIds.length} 个章节作为本集范围。请在会话中输入生成指令。`,
                  );
                }}
              />
            ) : view === 'documents' ? (
              <>
                {renderDocumentToolbar(
                  document?.currentVersion?.state === 'published'
                    ? '已发布项目资料'
                    : '项目文档草稿',
                  '文档编辑器',
                )}
                {project ? (
                  <div className="directory-layout">
                    <aside className="directory-index" aria-label="项目文档目录">
                      <div className="tree-heading">
                        <span>文档</span>
                        <button
                          className="icon-button subtle"
                          type="button"
                          title="新建文档"
                          onClick={() => {
                            newDocument();
                            setDocumentKind('outline');
                          }}
                          disabled={!writable}
                        >
                          <FilePlus2 size={14} />
                        </button>
                      </div>
                      {projectDocuments.map((item) => (
                        <button
                          className={`tree-item ${document?.id === item.id ? 'selected' : ''}`}
                          type="button"
                          key={item.id}
                          onClick={() => void selectDocument(item)}
                        >
                          <FileText size={13} />
                          <span>{item.title}</span>
                        </button>
                      ))}
                      {projectDocuments.length === 0 && (
                        <small className="tree-empty">暂无正式资料</small>
                      )}
                      <div className="tree-heading nested">
                        <span>约束条件</span>
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
                      {constraints.length === 0 && (
                        <small className="tree-empty">暂无约束，可在会话中提升为约束</small>
                      )}
                    </aside>
                    <div className="directory-pane">{renderDocumentEditor()}</div>
                  </div>
                ) : (
                  <EmptyWorkspace />
                )}
              </>
            ) : view === 'characters' ? (
              <>
                {renderDocumentToolbar('角色与场景', '角色与场景', 'characters')}
                {project ? (
                  <div className="directory-layout">
                    <aside className="directory-index" aria-label="角色与场景目录">
                      <div className="tree-heading">
                        <span>角色与场景</span>
                      </div>
                      {characterSceneDocuments.map((item) => (
                        <button
                          className={`tree-item ${document?.id === item.id ? 'selected' : ''}`}
                          type="button"
                          key={item.id}
                          onClick={() => void openCharacterSceneDocument(item)}
                        >
                          <FileText size={13} />
                          <span>{item.title}</span>
                        </button>
                      ))}
                      {characterSceneDocuments.length === 0 && (
                        <small className="tree-empty">暂无角色与场景文档</small>
                      )}
                    </aside>
                    <div className="directory-pane">
                      {document?.kind &&
                      (document.kind === 'character' || document.kind === 'scene') ? (
                        renderDocumentEditor()
                      ) : (
                        <EmptyWorkspace title="请选择角色或场景文档" />
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
                    <span className="eyebrow">{scene?.title ?? '场次未选择'}</span>
                    <h1>{shot?.title ?? '镜头工作区'}</h1>
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
                    <aside className="directory-index" aria-label="场次与镜头目录">
                      <div className="tree-heading">
                        <span>场次与镜头</span>
                        <button
                          className="icon-button subtle"
                          type="button"
                          title="新建场次"
                          onClick={() => void addScene()}
                          disabled={!writable}
                        >
                          <Plus size={14} />
                        </button>
                      </div>
                      {scenes.map((item) => (
                        <button
                          className={`tree-item ${scene?.id === item.id ? 'selected' : ''}`}
                          type="button"
                          key={item.id}
                          onClick={() => void selectScene(item)}
                        >
                          <Clapperboard size={13} />
                          <span>{item.title}</span>
                        </button>
                      ))}
                      {scene && (
                        <>
                          <div className="tree-heading nested">
                            <span>镜头</span>
                            <button
                              className="icon-button subtle"
                              type="button"
                              title="新建镜头"
                              onClick={() => void addShot()}
                              disabled={!writable}
                            >
                              <Plus size={14} />
                            </button>
                          </div>
                          {shots.map((item) => (
                            <button
                              className={`tree-item nested ${shot?.id === item.id ? 'selected' : ''}`}
                              type="button"
                              key={item.id}
                              onClick={() => {
                                conversationRequest.current += 1;
                                setShot(item);
                              }}
                            >
                              <Aperture size={13} />
                              <span>{item.title}</span>
                            </button>
                          ))}
                        </>
                      )}
                      {scenes.length === 0 && <small className="tree-empty">暂无场次</small>}
                    </aside>
                    <div className="directory-pane">
                      {shot ? (
                        <div className="shot-workspace">
                          <div className="shot-header">
                            <Aperture size={26} />
                            <div>
                              <strong>{shot.title}</strong>
                              <span>
                                状态：{shot.status} · 镜头 #{shot.position + 1}
                              </span>
                            </div>
                          </div>
                          <div className="shot-section">
                            <h2>镜头提示词</h2>
                            <p>
                              用于生成本镜头图片/视频的提示词；可引用已发布角色/场景，如 [角色:林澈]
                              [场景:旧码头]。
                            </p>
                            <textarea
                              className="markdown-editor shot-prompt-editor"
                              aria-label="镜头提示词"
                              value={shotPrompt}
                              onChange={(event) => setShotPrompt(event.target.value)}
                              placeholder="输入镜头提示词…"
                              readOnly={!writable}
                            />
                            <button
                              className="button secondary"
                              type="button"
                              disabled={!writable}
                              onClick={() => void saveShotPrompt()}
                            >
                              <Save size={13} /> 保存提示词
                            </button>
                          </div>
                          <div className="shot-section">
                            <h2>镜头内容</h2>
                            <p>
                              在项目会话中完善镜头描述，再通过明确操作保存为分镜文档。普通会话不会修改正式资料。
                            </p>
                          </div>
                          <div className="shot-section">
                            <h2>分镜文档</h2>
                            <label className="title-field">
                              分镜标题
                              <input
                                value={shotStoryboardTitle}
                                onChange={(event) => setShotStoryboardTitle(event.target.value)}
                                placeholder="输入分镜标题"
                                readOnly={!writable || shotStoryboardBusy}
                              />
                            </label>
                            <textarea
                              className="markdown-editor"
                              aria-label="分镜内容"
                              value={shotStoryboardContent}
                              onChange={(event) => setShotStoryboardContent(event.target.value)}
                              placeholder="# 分镜&#10;&#10;1. 镜头描述…"
                              readOnly={!writable || shotStoryboardBusy}
                            />
                            <div className="toolbar-actions">
                              <button
                                className="button primary"
                                type="button"
                                disabled={!writable || shotStoryboardBusy}
                                onClick={() => void saveShotStoryboard()}
                              >
                                <Save size={13} />
                                {shotStoryboard ? '保存分镜' : '新建分镜'}
                              </button>
                              {shotStoryboardBusy && <span className="inline-status">保存中…</span>}
                            </div>
                          </div>
                        </div>
                      ) : (
                        <EmptyWorkspace title={scene ? '还没有镜头' : '还没有场次'} />
                      )}
                    </div>
                  </div>
                ) : (
                  <EmptyWorkspace />
                )}
                <ChangeSetReviewPanel projectId={project?.id} writable={writable} />
              </>
            ) : view === 'tasks' ? (
              <TaskLogView
                projectId={project?.id}
                onOpenDocument={(documentId) => void openDocumentById(documentId)}
                onOpenConversation={(conversationId) => void openConversationById(conversationId)}
              />
            ) : project ? (
              <AssetLibraryView
                writable={writable}
                selectedAssetId={assetLibrarySelectedId}
                onOpenSource={(source) => void openAssetSource(source)}
              />
            ) : (
              <EmptyWorkspace title="请打开一个项目" />
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
