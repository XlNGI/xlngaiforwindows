import { emitTo } from '@tauri-apps/api/event';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type {
  AgentResearchMode,
  ChatMessageInfo,
  ConversationInfo,
  ConversationScopeType,
  DocumentVersionInfo,
  LlmGenerationInfo,
  LlmStatusResult,
  ProviderModelInfo,
  ProviderProfileInfo,
  ProductionContextInfo,
} from '@ai-video/contracts';
import type { WorkspacePanelId } from './workspace-types';

export const DETACHED_PANEL_READY_EVENT = 'workspace-panel-ready';
export const DETACHED_PANEL_SNAPSHOT_EVENT = 'workspace-panel-snapshot';
export const DETACHED_PANEL_ACTION_EVENT = 'workspace-panel-action';

export interface DetachedPanelConfig {
  panelId: WorkspacePanelId;
  projectId: string;
  entityId?: string;
  label: string;
  /** Stable per-window identity. The label is also the Tauri window key. */
  sessionId: string;
}

export interface DetachedDocumentSnapshot {
  panelId: 'document';
  projectId: string;
  projectName: string;
  documentId?: string;
  /** Monotonically increasing snapshot revision for this detached session. */
  snapshotVersion?: number;
  title: string;
  /** Retained for old snapshots; classification is no longer editable in the UI. */
  kind: string;
  content: string;
  state: DocumentVersionInfo['state'] | 'new';
  writable: boolean;
  busy: boolean;
  statusMessage: string;
  versions: DocumentVersionInfo[];
  currentVersionId?: string;
  publishedVersionId?: string;
  rowVersion: number;
}

export interface DetachedConversationSnapshot {
  panelId: 'conversation';
  projectId: string;
  projectName: string;
  snapshotVersion?: number;
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
}

export type DetachedPanelSnapshot = DetachedDocumentSnapshot | DetachedConversationSnapshot;

export type DetachedPanelAction =
  | { panelId: WorkspacePanelId; type: 'attach' }
  | { panelId: 'document'; type: 'document-title'; value: string }
  | { panelId: 'document'; type: 'document-kind'; value: string }
  | { panelId: 'document'; type: 'document-content'; value: string }
  | { panelId: 'document'; type: 'document-save' }
  | { panelId: 'document'; type: 'document-new' }
  | { panelId: 'document'; type: 'document-import' }
  | { panelId: 'document'; type: 'document-restore'; versionId: string }
  | { panelId: 'document'; type: 'document-submit-review' }
  | { panelId: 'document'; type: 'document-request-changes' }
  | { panelId: 'document'; type: 'document-publish' }
  | { panelId: 'conversation'; type: 'conversation-scope'; scope: ConversationScopeType }
  | { panelId: 'conversation'; type: 'conversation-select'; conversationId: string }
  | { panelId: 'conversation'; type: 'conversation-create' }
  | {
      panelId: 'conversation';
      type: 'conversation-promote';
      messageId: string;
      target: 'document' | 'memory' | 'constraint';
    }
  | { panelId: 'conversation'; type: 'conversation-retry'; messageId: string }
  | { panelId: 'conversation'; type: 'conversation-profile'; profileId: string }
  | { panelId: 'conversation'; type: 'conversation-model'; modelId: string }
  | { panelId: 'conversation'; type: 'conversation-research-mode'; mode: AgentResearchMode }
  | { panelId: 'conversation'; type: 'conversation-open-settings' }
  | { panelId: 'conversation'; type: 'conversation-composer'; value: string }
  | { panelId: 'conversation'; type: 'conversation-cancel' }
  | { panelId: 'conversation'; type: 'conversation-send'; value: string };

export interface DetachedPanelEnvelope<T> {
  label: string;
  projectId?: string;
  entityId?: string;
  sequence?: number;
  payload: T;
}

function isTauriRuntime(): boolean {
  return '__TAURI_INTERNALS__' in window;
}

function safeLabelPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 80);
}

export function detachedPanelLabel(
  panelId: WorkspacePanelId,
  projectId: string,
  entityId?: string,
): string {
  return ['workspace', panelId, safeLabelPart(projectId), entityId && safeLabelPart(entityId)]
    .filter(Boolean)
    .join('-');
}

export function parseDetachedPanelConfig(): DetachedPanelConfig | undefined {
  const search = new URLSearchParams(window.location.search);
  const panelId = search.get('workspacePanel');
  const projectId = search.get('projectId');
  const label = search.get('windowLabel');
  if ((panelId !== 'document' && panelId !== 'conversation') || !projectId || !label) {
    return undefined;
  }
  return {
    panelId,
    projectId,
    entityId: search.get('entityId') ?? undefined,
    label,
    sessionId: search.get('sessionId') ?? label,
  };
}

export async function openDetachedPanelWindow(options: {
  panelId: WorkspacePanelId;
  projectId: string;
  entityId?: string;
  title: string;
  onDestroyed: () => void;
}): Promise<string | undefined> {
  if (!isTauriRuntime()) return undefined;
  const label = detachedPanelLabel(options.panelId, options.projectId, options.entityId);
  const existing = await WebviewWindow.getByLabel(label);
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return label;
  }

  const search = new URLSearchParams({
    workspacePanel: options.panelId,
    projectId: options.projectId,
    windowLabel: label,
    sessionId: label,
  });
  if (options.entityId) search.set('entityId', options.entityId);
  const window = new WebviewWindow(label, {
    url: `/?${search.toString()}`,
    title: options.title,
    width: options.panelId === 'document' ? 960 : 520,
    height: 760,
    minWidth: options.panelId === 'document' ? 640 : 380,
    minHeight: 480,
    center: true,
    decorations: true,
    resizable: true,
    alwaysOnTop: false,
    shadow: true,
  });
  await new Promise<void>((resolve, reject) => {
    void window.once('tauri://created', () => resolve());
    void window.once<string>('tauri://error', (event) => reject(new Error(event.payload)));
  });
  void window.once('tauri://destroyed', options.onDestroyed);
  return label;
}

export async function focusDetachedPanelWindow(label: string | undefined): Promise<boolean> {
  if (!label || !isTauriRuntime()) return false;
  const window = await WebviewWindow.getByLabel(label);
  if (!window) return false;
  await window.show();
  await window.setFocus();
  return true;
}

export async function closeDetachedPanelWindow(label: string | undefined): Promise<void> {
  if (!label || !isTauriRuntime()) return;
  const window = await WebviewWindow.getByLabel(label);
  if (window) await window.close();
}

export async function sendDetachedSnapshot(
  label: string | undefined,
  snapshot: DetachedPanelSnapshot,
  sequence = 0,
): Promise<void> {
  if (!label || !isTauriRuntime()) return;
  await emitTo(label, DETACHED_PANEL_SNAPSHOT_EVENT, {
    label,
    projectId: snapshot.projectId,
    entityId: snapshot.panelId === 'document' ? snapshot.documentId : snapshot.conversation?.id,
    sequence,
    payload: snapshot,
  });
}
