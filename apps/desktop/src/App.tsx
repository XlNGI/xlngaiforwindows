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
  AgentResearchMode,
  ChatMessageInfo,
  ConversationScopeType,
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
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { useProjectMaintenance } from './use-project-maintenance';
import { useDocumentWorkspace } from './use-document-workspace';
import { useConversationWorkspace } from './use-conversation-workspace';
import { useAssetWorkspace } from './use-asset-workspace';
import { useProductionState } from './use-production-state';
import { ProductionPanel } from './ProductionPanel';
import { MaintenanceDialog } from './MaintenanceDialog';
import { ChatPanel, type ComposerMode } from './ChatPanel';
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

function isGenerationActive(generation: LlmGenerationInfo | undefined): boolean {
  return generation?.status === 'prepared' || generation?.status === 'streaming';
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

  const [scopeType, setScopeType] = useState<ConversationScopeType>('project');
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [composer, setComposer] = useState('');
  const [chatMessage, setChatMessage] = useState('');
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
  const [generation, setGeneration] = useState<LlmGenerationInfo>();
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
    const agentTaskId =
      'agentTaskId' in prepared && typeof prepared.agentTaskId === 'string'
        ? prepared.agentTaskId
        : undefined;
    const isAgentGeneration = agentTaskId !== undefined;
    if (agentTaskId) {
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
        const action = request.action === 'document.archive' ? '归档' : '恢复归档';
        return Promise.resolve(window.confirm(`确认${action}文档“${request.documentTitle}”？`));
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
    await run.cancel().catch(() => undefined);
    stopAgentTaskEventPolling();
    if (nativeLlmRun.current?.identity.attemptId === run.identity.attemptId) {
      nativeLlmRun.current = undefined;
    }
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
      const [documentList, sceneList] = await Promise.all([
        callWorker('document.list', {}),
        callWorker('scene.list', {}),
      ]);
      const assetList = await callWorker('asset.list', {});
      const firstScene = sceneList[0];
      const shotList = firstScene ? await callWorker('shot.list', { sceneId: firstScene.id }) : [];
      if (requestId !== projectContentRequest.current) return;
      setDocuments(documentList);
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

  const addShot = async () => {
    if (!scene) return;
    const created = await callWorker('shot.save', {
      sceneId: scene.id,
      title: `镜头 ${shots.length + 1}`,
    });
    setShots(await callWorker('shot.list', { sceneId: scene.id }));
    setShot(created);
  };

  const sendMessage = async (composerValue = composer) => {
    if (!composerValue.trim() || !conversation) return;
    const prompt = composerValue;
    setComposer('');
    if (composerMode === 'novel-writing') {
      await createNovelDraft(prompt);
      return;
    }
    if (selectedLlmProfile && selectedLlmModel) {
      try {
        if (composerMode === 'chat') {
          const inferred = inferDocumentIntent(prompt, document?.id);
          if (inferred.needsTarget) {
            setComposer(prompt);
            setChatMessage('请先打开唯一的目标文档，再执行文档读取、更新、归档或恢复。');
            return;
          }
          if (inferred.intent) {
            const prepared = await callWorker('agent.generation.prepare', {
              conversationId: conversation.id,
              prompt,
              providerProfileId: selectedLlmProfile.id,
              modelId: selectedLlmModel.id,
              agentMode: 'document',
              researchMode,
              documentIntent: inferred.intent,
            });
            if ('pendingIntent' in prepared) {
              setComposer(prompt);
              setChatMessage('文档目标需要进一步澄清；本次没有创建或修改文档。');
              return;
            }
            launchPreparedGeneration(prepared);
            return;
          }
        }
        const prepared = await callWorker('llm.generation.prepare', {
          conversationId: conversation.id,
          prompt,
          providerProfileId: selectedLlmProfile.id,
          modelId: selectedLlmModel.id,
        });
        launchPreparedGeneration(prepared);
      } catch (reason) {
        setComposer(prompt);
        setChatMessage(reason instanceof Error ? reason.message : '生成启动失败');
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

  const createDocumentDraft = async () => {
    if (!composer.trim() || !conversation) return;
    if (!selectedLlmProfile || !selectedLlmModel) {
      setChatMessage('创建文档草稿需要已配置支持工具调用的 LLM 模型。');
      return;
    }
    const prompt = composer;
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
    if (!generation) return;
    if (generation.executionMode === 'native') {
      await cancelNativeLlmRun();
    }
    setGeneration(
      await callWorker('llm.generation.cancel', { generationId: generation.generationId }),
    );
  };

  const retryGeneration = async (assistantMessageId: string) => {
    if (selectedLlmProfile && selectedLlmModel) {
      const prepared = await callWorker('llm.generation.retryPrepare', {
        assistantMessageId,
        providerProfileId: selectedLlmProfile.id,
        modelId: selectedLlmModel.id,
      });
      launchPreparedGeneration(prepared);
      return;
    }
    const retried = await callWorker('llm.generation.retry', { assistantMessageId });
    setGeneration(retried);
    setMessages((current) => [...current, retried.assistantMessage]);
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
      contextPreview={contextPreview}
      generation={generation}
      onClose={() => workspaceDispatch({ type: 'close', panelId: 'conversation' })}
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
      onComposerModeChange={setComposerMode}
      onOpenProviderSettings={() => {
        setSettingsInitialPage('providers');
        setSettingsOpen(true);
      }}
      onComposerChange={setComposer}
      onCancelGeneration={() => void cancelGeneration()}
      onSendMessage={() => void sendMessage()}
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
        <div className="dialog-backdrop" role="presentation">
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
                <span>Novel chapters</span>
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
                          onClick={newDocument}
                          disabled={!writable}
                        >
                          <FilePlus2 size={14} />
                        </button>
                      </div>
                      {documents.map((item) => (
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
                      {documents.length === 0 && <small className="tree-empty">暂无正式文档</small>}
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
                            <h2>镜头内容</h2>
                            <p>
                              在项目会话中完善镜头描述，再通过明确操作保存为分镜文档。普通会话不会修改正式资料。
                            </p>
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
