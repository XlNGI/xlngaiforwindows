import { useEffect, useRef, useState } from 'react';
import {
  Aperture,
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Clapperboard,
  Copy,
  FilePlus2,
  FileText,
  FolderOpen,
  Image,
  MessageSquarePlus,
  PanelLeftClose,
  PanelRightClose,
  Plus,
  RotateCcw,
  RefreshCw,
  Save,
  Settings2,
  Square,
} from 'lucide-react';
import type {
  ChatMessageInfo,
  ConversationInfo,
  ConversationScopeType,
  DocumentDetail,
  DocumentKind,
  DocumentSummary,
  DocumentVersionInfo,
  HealthResult,
  LlmGenerationInfo,
  LlmStatusResult,
  ProductionContextInfo,
  ProjectInfo,
  RecentProjectInfo,
  SceneInfo,
  ShotInfo,
  SqliteProbeResult,
} from '@ai-video/contracts';
import { callWorker } from './worker-client';
import { ProductionPanel } from './ProductionPanel';

type CheckState = 'checking' | 'ready' | 'error';
type WorkspaceView = 'documents' | 'shots';

const documentKinds: { value: DocumentKind; label: string }[] = [
  { value: 'outline', label: '项目大纲' },
  { value: 'plan', label: '项目计划' },
  { value: 'character', label: '角色设定' },
  { value: 'scene', label: '场景设定' },
  { value: 'storyboard', label: '分镜文档' },
  { value: 'note', label: '创作笔记' },
];

function scopeLabel(scope: ConversationScopeType): string {
  return scope === 'project' ? '项目' : scope === 'scene' ? '场次' : '镜头';
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
  const [sqlite, setSqlite] = useState<SqliteProbeResult>();
  const [state, setState] = useState<CheckState>('checking');
  const [error, setError] = useState('');
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [project, setProject] = useState<ProjectInfo>();
  const [recentProjects, setRecentProjects] = useState<RecentProjectInfo[]>([]);
  const [projectName, setProjectName] = useState('我的短剧');
  const [projectPath, setProjectPath] = useState('');
  const [projectMessage, setProjectMessage] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);

  const [view, setView] = useState<WorkspaceView>('documents');
  const [documents, setDocuments] = useState<DocumentSummary[]>([]);
  const [document, setDocument] = useState<DocumentDetail>();
  const [documentTitle, setDocumentTitle] = useState('');
  const [documentKind, setDocumentKind] = useState<DocumentKind>('outline');
  const [documentContent, setDocumentContent] = useState('');
  const [versions, setVersions] = useState<DocumentVersionInfo[]>([]);
  const [contentBusy, setContentBusy] = useState(false);
  const [contentMessage, setContentMessage] = useState('');

  const [scenes, setScenes] = useState<SceneInfo[]>([]);
  const [scene, setScene] = useState<SceneInfo>();
  const [shots, setShots] = useState<ShotInfo[]>([]);
  const [shot, setShot] = useState<ShotInfo>();

  const [scopeType, setScopeType] = useState<ConversationScopeType>('project');
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const [conversation, setConversation] = useState<ConversationInfo>();
  const [messages, setMessages] = useState<ChatMessageInfo[]>([]);
  const [composer, setComposer] = useState('');
  const [chatMessage, setChatMessage] = useState('');
  const [llmStatus, setLlmStatus] = useState<LlmStatusResult>();
  const [contextPreview, setContextPreview] = useState<ProductionContextInfo>();
  const [generation, setGeneration] = useState<LlmGenerationInfo>();
  const projectActionRequest = useRef(0);
  const projectContentRequest = useRef(0);
  const conversationRequest = useRef(0);
  const documentRequest = useRef(0);
  const sceneRequest = useRef(0);

  const writable = project?.mode === 'read-write';
  const scopeId = scopeType === 'scene' ? scene?.id : scopeType === 'shot' ? shot?.id : undefined;
  const scopeAvailable = scopeType === 'project' || Boolean(scopeId);

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
      const firstScene = sceneList[0];
      const shotList = firstScene ? await callWorker('shot.list', { sceneId: firstScene.id }) : [];
      if (requestId !== projectContentRequest.current) return;
      setDocuments(documentList);
      setScenes(sceneList);
      setScene(firstScene);
      setShots(shotList);
      setShot(undefined);
    } catch (reason) {
      if (requestId === projectContentRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '项目内容加载失败');
      }
    }
  };

  useEffect(() => {
    void checkRuntime();
    void callWorker('llm.status', {})
      .then(setLlmStatus)
      .catch(() => undefined);
    void Promise.all([callWorker('project.current', {}), callWorker('project.recent', {})])
      .then(async ([current, recent]) => {
        setProject(current ?? undefined);
        setRecentProjects(recent);
        if (current) await loadProjectContent();
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const requestId = ++conversationRequest.current;
    let active = true;
    if (!project || !scopeAvailable) {
      setConversations([]);
      setConversation(undefined);
      setMessages([]);
      setContextPreview(undefined);
      return;
    }
    void (async () => {
      try {
        const items = await callWorker('conversation.list', { scopeType, scopeId });
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
  }, [project?.id, scopeType, scopeId]);

  useEffect(() => {
    if (!generation || generation.status !== 'streaming') return;
    const timer = window.setInterval(() => {
      void callWorker('llm.generation.get', { generationId: generation.generationId })
        .then((next) => {
          setGeneration(next);
          setMessages((current) => mergeGenerationMessage(current, conversation?.id, next));
          if (next.status !== 'streaming' && next.conversationId === conversation?.id) {
            setChatMessage(next.error ?? '生成完成');
          }
        })
        .catch((reason) =>
          setChatMessage(reason instanceof Error ? reason.message : '生成状态读取失败'),
        );
    }, 250);
    return () => window.clearInterval(timer);
  }, [generation?.generationId, generation?.status, conversation?.id]);

  const runProjectAction = async (action: () => Promise<ProjectInfo | string | undefined>) => {
    const requestId = ++projectActionRequest.current;
    projectContentRequest.current += 1;
    conversationRequest.current += 1;
    documentRequest.current += 1;
    sceneRequest.current += 1;
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

  const createProject = () =>
    runProjectAction(() =>
      callWorker('project.create', { name: projectName, rootPath: projectPath }),
    );
  const openProject = (rootPath = projectPath) =>
    runProjectAction(() => callWorker('project.open', { rootPath }));
  const closeProject = () =>
    runProjectAction(async () => {
      await callWorker('project.close', {});
      setProject(undefined);
      setDocuments([]);
      setScenes([]);
      setDocument(undefined);
      setConversation(undefined);
      setMessages([]);
      setGeneration(undefined);
      return '项目已安全关闭';
    });

  const selectDocument = async (summary: DocumentSummary) => {
    const requestId = ++documentRequest.current;
    setContentBusy(true);
    setContentMessage('');
    try {
      const [detail, history] = await Promise.all([
        callWorker('document.get', { documentId: summary.id }),
        callWorker('document.versions', { documentId: summary.id }),
      ]);
      if (requestId !== documentRequest.current) return;
      setDocument(detail);
      setDocumentTitle(detail.title);
      setDocumentKind(detail.kind);
      setDocumentContent(detail.currentVersion?.contentMarkdown ?? '');
      setVersions(history);
      setView('documents');
    } catch (reason) {
      if (requestId === documentRequest.current) {
        setContentMessage(reason instanceof Error ? reason.message : '文档加载失败');
      }
    } finally {
      if (requestId === documentRequest.current) setContentBusy(false);
    }
  };

  const newDocument = () => {
    documentRequest.current += 1;
    setDocument(undefined);
    setDocumentTitle('');
    setDocumentKind('outline');
    setDocumentContent('');
    setVersions([]);
    setView('documents');
  };

  const saveDocument = async () => {
    setContentBusy(true);
    setContentMessage('');
    try {
      const saved = await callWorker('document.save', {
        documentId: document?.id,
        kind: documentKind,
        title: documentTitle,
        contentMarkdown: documentContent,
      });
      setDocument(saved);
      setDocuments(await callWorker('document.list', {}));
      setVersions(await callWorker('document.versions', { documentId: saved.id }));
      setContentMessage(`已保存版本 v${saved.currentVersion?.version}`);
    } catch (reason) {
      setContentMessage(reason instanceof Error ? reason.message : '保存失败');
    } finally {
      setContentBusy(false);
    }
  };

  const restoreVersion = async (versionId: string) => {
    if (!document) return;
    setContentBusy(true);
    try {
      const restored = await callWorker('document.restore', {
        documentId: document.id,
        versionId,
      });
      setDocument(restored);
      setDocumentContent(restored.currentVersion?.contentMarkdown ?? '');
      setVersions(await callWorker('document.versions', { documentId: document.id }));
      setContentMessage(`已从历史版本恢复为 v${restored.currentVersion?.version}`);
    } finally {
      setContentBusy(false);
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

  const createConversation = async () => {
    if (!scopeAvailable) return;
    const requestId = ++conversationRequest.current;
    try {
      const created = await callWorker('conversation.create', { scopeType, scopeId });
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

  const selectConversation = async (selected: ConversationInfo) => {
    const requestId = ++conversationRequest.current;
    setChatMessage('');
    try {
      if (generation?.status === 'streaming' && generation.conversationId !== selected.id) {
        const cancelled = await callWorker('llm.generation.cancel', {
          generationId: generation.generationId,
        });
        if (requestId !== conversationRequest.current) return;
        setGeneration(cancelled);
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

  const sendMessage = async () => {
    if (!composer.trim() || !conversation) return;
    const prompt = composer;
    setComposer('');
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
    setChatMessage('消息已保存；配置 OPENAI_API_KEY 后可生成回复');
  };

  const cancelGeneration = async () => {
    if (!generation) return;
    setGeneration(
      await callWorker('llm.generation.cancel', { generationId: generation.generationId }),
    );
  };

  const retryGeneration = async (assistantMessageId: string) => {
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
        await callWorker('chat.message.toDocument', {
          messageId: message.id,
          title: `会话产物 ${new Date().toLocaleDateString()}`,
          kind: 'note',
        });
        setDocuments(await callWorker('document.list', {}));
      } else if (target === 'memory') {
        await callWorker('chat.message.toMemory', { messageId: message.id });
      } else {
        await callWorker('chat.message.toConstraint', { messageId: message.id });
      }
      setChatMessage(
        target === 'document'
          ? '已保存为项目文档'
          : target === 'memory'
            ? '已添加到项目记忆'
            : '已添加生产约束',
      );
    } catch (reason) {
      setChatMessage(reason instanceof Error ? reason.message : '操作失败');
    }
  };

  return (
    <div className="app-shell" data-left-open={leftOpen} data-right-open={rightOpen}>
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          <Clapperboard size={17} />
        </div>
        <div className="project-title">
          <strong>AI 影像工作台</strong>
          <span>{project?.name ?? '未打开项目'}</span>
        </div>
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            title="打开项目"
            onClick={() => void openProject()}
            disabled={projectBusy || !projectPath.trim()}
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
          <button className="icon-button" type="button" title="设置">
            <Settings2 size={17} />
          </button>
        </div>
      </header>

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
            className={`nav-item ${view === 'documents' ? 'active' : ''}`}
            type="button"
            onClick={() => setView('documents')}
          >
            <FileText size={16} />
            <span>项目文档</span>
            <span className="count">{documents.length}</span>
          </button>
          <button
            className={`nav-item ${view === 'shots' ? 'active' : ''}`}
            type="button"
            onClick={() => setView('shots')}
          >
            <Clapperboard size={16} />
            <span>场次与镜头</span>
            <span className="count">{shots.length}</span>
          </button>
          <button className="nav-item" type="button">
            <Aperture size={16} />
            <span>角色与场景</span>
            <span className="count">0</span>
          </button>
          <button className="nav-item" type="button">
            <Image size={16} />
            <span>素材库</span>
            <span className="count">0</span>
          </button>
        </nav>

        {project && (
          <div className="content-tree">
            {view === 'documents' ? (
              <>
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
              </>
            ) : (
              <>
                <div className="tree-heading">
                  <span>场次</span>
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
              </>
            )}
          </div>
        )}

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
              <label htmlFor="project-name">项目名称</label>
              <input
                id="project-name"
                value={projectName}
                onChange={(event) => setProjectName(event.target.value)}
              />
              <label htmlFor="project-path">项目绝对目录</label>
              <input
                id="project-path"
                value={projectPath}
                onChange={(event) => setProjectPath(event.target.value)}
                placeholder="D:\Projects\my-drama"
              />
              <div className="project-actions">
                <button type="button" onClick={() => void createProject()}>
                  新建
                </button>
                <button type="button" onClick={() => void openProject()}>
                  打开
                </button>
              </div>
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
        {view === 'documents' ? (
          <>
            <div className="workspace-toolbar">
              <div>
                <span className="eyebrow">正式项目资料</span>
                <h1>{document?.title ?? '文档编辑器'}</h1>
              </div>
              <div className="toolbar-actions">
                <button
                  className="button secondary"
                  type="button"
                  onClick={newDocument}
                  disabled={!writable}
                >
                  <FilePlus2 size={15} />
                  新建
                </button>
                <button
                  className="button primary"
                  type="button"
                  onClick={() => void saveDocument()}
                  disabled={!writable || contentBusy || !documentTitle.trim()}
                >
                  <Save size={15} />
                  保存新版本
                </button>
              </div>
            </div>
            {project ? (
              <div className="document-workspace">
                <div className="document-fields">
                  <label>
                    类型
                    <select
                      value={documentKind}
                      onChange={(event) => setDocumentKind(event.target.value as DocumentKind)}
                      disabled={!writable}
                    >
                      {documentKinds.map((kind) => (
                        <option key={kind.value} value={kind.value}>
                          {kind.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="title-field">
                    标题
                    <input
                      value={documentTitle}
                      onChange={(event) => setDocumentTitle(event.target.value)}
                      placeholder="输入文档标题"
                      readOnly={!writable}
                    />
                  </label>
                </div>
                <textarea
                  className="markdown-editor"
                  aria-label="文档内容"
                  value={documentContent}
                  onChange={(event) => setDocumentContent(event.target.value)}
                  placeholder="使用 Markdown 编写项目内容…"
                  readOnly={!writable}
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
                        disabled={!writable || version.id === document?.currentVersionId}
                      >
                        <RotateCcw size={12} />v{version.version}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <EmptyWorkspace />
            )}
          </>
        ) : (
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
          </>
        )}
      </main>

      <ProductionPanel projectId={project?.id} shotId={shot?.id} writable={writable} />

      <aside className="chat-panel panel-border">
        <div className="panel-heading">
          <span>{scopeLabel(scopeType)}会话</span>
          <button
            className="icon-button subtle"
            type="button"
            title="收起会话"
            onClick={() => setRightOpen(false)}
          >
            <PanelRightClose size={16} />
          </button>
        </div>
        <div className="scope-tabs">
          {(['project', 'scene', 'shot'] as const).map((scope) => (
            <button
              type="button"
              key={scope}
              className={scopeType === scope ? 'active' : ''}
              onClick={() => {
                conversationRequest.current += 1;
                setScopeType(scope);
              }}
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
              if (selected) void selectConversation(selected);
            }}
            disabled={!scopeAvailable}
          >
            <option value="">
              {scopeAvailable ? '选择会话' : `请先选择${scopeLabel(scopeType)}`}
            </option>
            {conversations.map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            type="button"
            title="新建会话"
            onClick={() => void createConversation()}
            disabled={!writable || !scopeAvailable}
          >
            <MessageSquarePlus size={16} />
          </button>
        </div>
        <div className="llm-context-bar">
          <div>
            <span>{llmStatus?.provider ?? 'LLM'}</span>
            <small>{llmStatus?.configured ? llmStatus.model : '未配置 OPENAI_API_KEY'}</small>
          </div>
          {contextPreview && (
            <details>
              <summary>
                上下文 {contextPreview.sources.length} 项 · 约 {contextPreview.estimatedTokens}{' '}
                tokens
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
                {message.role === 'assistant' && (
                  <footer>
                    <button type="button" onClick={() => void promoteMessage(message, 'document')}>
                      保存为文档
                    </button>
                    <button type="button" onClick={() => void promoteMessage(message, 'memory')}>
                      加入记忆
                    </button>
                    <button
                      type="button"
                      onClick={() => void promoteMessage(message, 'constraint')}
                    >
                      添加约束
                    </button>
                    {message.status === 'failed' && llmStatus?.configured && (
                      <button type="button" onClick={() => void retryGeneration(message.id)}>
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
        {chatMessage && <small className="chat-status">{chatMessage}</small>}
        <div className="composer">
          <textarea
            aria-label="会话消息"
            placeholder={conversation ? '输入消息…' : '请先新建会话'}
            rows={3}
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            disabled={!conversation || !writable}
          />
          {generation?.status === 'streaming' ? (
            <button
              className="icon-button send-button"
              type="button"
              title="停止生成"
              onClick={() => void cancelGeneration()}
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              className="icon-button send-button"
              type="button"
              title="发送消息"
              onClick={() => void sendMessage()}
              disabled={!composer.trim() || !conversation}
            >
              <ChevronRight size={18} />
            </button>
          )}
        </div>
      </aside>

      {!rightOpen && (
        <button
          className="edge-toggle edge-toggle-right"
          type="button"
          title="展开项目会话"
          onClick={() => setRightOpen(true)}
        >
          <ChevronLeft size={16} />
        </button>
      )}
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
