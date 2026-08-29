import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentTaskDetail,
  ImageGenerationJobInfo,
  TaskLogItem,
  VideoGenerationJobInfo,
} from '@ai-video/contracts';
import { TaskLogView } from './TaskLogView';
import { callWorker } from './worker-client';

vi.mock('./worker-client', () => ({
  callWorker: vi.fn(),
}));

const agentItem: TaskLogItem = {
  id: 'agent:task-1',
  kind: 'agent-document',
  title: '项目大纲草稿',
  status: 'waiting_review',
  createdAt: '2026-08-16T01:00:00.000Z',
  updatedAt: '2026-08-16T01:02:00.000Z',
  sourceId: 'task-1',
  documentId: 'document-1',
  documentVersionId: 'version-1',
};

const imageItem: TaskLogItem = {
  id: 'job:image-1',
  kind: 'image',
  title: '文本生成图片',
  status: 'succeeded',
  createdAt: '2026-08-16T00:59:00.000Z',
  updatedAt: '2026-08-16T01:01:00.000Z',
  sourceId: 'image-job-1',
};

const agentDetail: AgentTaskDetail = {
  task: {
    id: 'task-1',
    projectId: 'project-1',
    conversationId: 'conversation-1',
    userMessageId: 'message-1',
    taskType: 'document-create',
    scopeType: 'project',
    title: '项目大纲草稿',
    status: 'waiting_review',
    phase: 'waiting_review',
    createdAt: '2026-08-16T01:00:00.000Z',
    updatedAt: '2026-08-16T01:02:00.000Z',
    rowVersion: 3,
    providerName: 'OpenAI',
    modelName: 'gpt-test',
    inputTokens: 100,
    outputTokens: 20,
    estimatedCost: '0.0001',
  },
  events: [
    {
      id: 'event-1',
      taskId: 'task-1',
      sequence: 1,
      eventType: 'document.draft.created',
      level: 'info',
      summary: '已创建可审阅草稿。',
      createdAt: '2026-08-16T01:00:01.000Z',
    },
    {
      id: 'event-2',
      taskId: 'task-1',
      sequence: 2,
      eventType: 'document.review.requested',
      level: 'warning',
      summary: '草稿等待用户审核。',
      createdAt: '2026-08-16T01:02:00.000Z',
    },
  ],
  documents: [
    {
      documentId: 'document-1',
      documentVersionId: 'version-1',
      operation: 'create',
      createdAt: '2026-08-16T01:00:01.000Z',
    },
  ],
  providerSteps: [
    {
      id: 'step-1',
      generationId: 'generation-1',
      attemptId: 'attempt-1',
      ordinal: 0,
      protocol: 'openai-responses',
      status: 'complete',
      toolCallCount: 1,
      finishReason: 'tool_calls',
      inputTokens: 100,
      outputTokens: 20,
      startedAt: '2026-08-16T01:00:00.000Z',
      completedAt: '2026-08-16T01:00:01.000Z',
    },
  ],
  researchSources: [
    {
      id: 'research-source-1',
      title: '公开研究来源',
      site: 'example.com',
      canonicalUrl: 'https://example.com/source',
      retrievedAt: '2026-08-16T01:00:30.000Z',
      contentHash: 'a'.repeat(64),
      characterCount: 420,
      truncated: true,
      status: 'fetched',
      citationLabel: 'R1',
      adoptionStatus: 'adopted',
      adoptionReason: '用于核对背景事实',
      cacheStatus: 'present',
    },
  ],
};

const imageJob: ImageGenerationJobInfo = {
  id: 'image-job-1',
  shotId: 'shot-1',
  adapterKey: 'TEXT_TO_IMAGE:vidu:viduq2:v2',
  status: 'succeeded',
  request: { prompt: '电影画面' },
  results: [
    {
      id: 'image-result-1',
      jobId: 'image-job-1',
      asset: {
        id: 'asset-1',
        projectId: 'project-1',
        kind: 'generated-image',
        relativePath: 'assets/images/generated.png',
        contentHash: 'hash',
        sizeBytes: 8192,
        createdAt: '2026-08-16T01:00:00.000Z',
      },
      createdAt: '2026-08-16T01:00:00.000Z',
    },
  ],
  createdAt: '2026-08-16T00:59:00.000Z',
  updatedAt: '2026-08-16T01:01:00.000Z',
};

const videoJob: VideoGenerationJobInfo = {
  id: 'video-job-1',
  projectId: 'project-1',
  shotId: 'shot-1',
  adapterKey: 'TEXT_TO_VIDEO:vidu:viduq2:v2',
  assetKind: 'generated-video',
  providerTaskId: 'provider-task-1',
  status: 'succeeded',
  request: { prompt: '电影片段' },
  metadata: {
    providerRegion: 'global',
    providerProfileId: 'profile-1',
    modelId: 'model-1',
    pollAttempts: 3,
    pollDeadlineAt: '2026-08-16T01:10:00.000Z',
  },
  results: [
    {
      id: 'video-result-1',
      jobId: 'video-job-1',
      asset: {
        id: 'video-asset-1',
        projectId: 'project-1',
        kind: 'generated-video',
        relativePath: 'assets/videos/generated.mp4',
        contentHash: 'video-hash',
        sizeBytes: 102400,
        createdAt: '2026-08-16T01:05:00.000Z',
      },
      createdAt: '2026-08-16T01:05:00.000Z',
    },
  ],
  elapsedMs: 60_000,
  createdAt: '2026-08-16T00:59:00.000Z',
  updatedAt: '2026-08-16T01:06:00.000Z',
};

describe('TaskLogView', () => {
  beforeEach(() => {
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'task.log.list')
        return Promise.resolve({ items: [agentItem, imageItem], nextCursor: undefined });
      if (method === 'agent.task.get') return Promise.resolve(agentDetail);
      if (method === 'image.generate.get') return Promise.resolve(imageJob);
      if (method === 'video.generate.get') return Promise.resolve(videoJob);
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('loads Agent task details and renders status, event timeline, and document artifacts', async () => {
    render(<TaskLogView projectId="project-1" />);

    const taskRow = await screen.findByRole('button', { name: /项目大纲草稿/ });
    fireEvent.click(taskRow);

    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('agent.task.get', { taskId: 'task-1' }),
    );
    expect(await screen.findByRole('heading', { name: '事件时间线' })).toBeInTheDocument();
    expect(screen.getAllByText('等待审核 (waiting_review)')).toHaveLength(2);
    expect(screen.getByText('document.draft.created')).toBeInTheDocument();
    expect(screen.getByText('已创建可审阅草稿。')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: '研究来源' })).toBeInTheDocument();
    expect(screen.getByText('R1')).toBeInTheDocument();
    expect(screen.getByText('公开研究来源')).toBeInTheDocument();
    expect(screen.getByText('内容已截断')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /公开研究来源/ })).toHaveAttribute(
      'href',
      'https://example.com/source',
    );
    expect(screen.getByText(/版本/)).toHaveTextContent('version-1');
    expect(screen.getByText('OpenAI · gpt-test')).toBeInTheDocument();
    expect(screen.getByText('输入 100 · 输出 20')).toBeInTheDocument();
    expect(screen.getByText('0.0001')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Provider steps' })).toBeInTheDocument();
    expect(screen.getByText(/Step 1: .*complete/)).toBeInTheDocument();
    expect(screen.getByText(/openai-responses.*1 tool call/)).toBeInTheDocument();
  });

  it('loads full image job details without requesting Agent task details', async () => {
    render(<TaskLogView projectId="project-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /文本生成图片/ }));

    expect(await screen.findByRole('heading', { name: '请求参数摘要' })).toBeInTheDocument();
    expect(screen.getByText('image-job-1')).toBeInTheDocument();
    expect(screen.getByText('assets/images/generated.png')).toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('agent.task.get', expect.anything());
  });

  it('loads full video job details', async () => {
    const videoItem: TaskLogItem = {
      ...imageItem,
      id: 'job:video-1',
      kind: 'video',
      title: '文生视频',
      sourceId: 'video-job-1',
    };
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'task.log.list')
        return Promise.resolve({ items: [videoItem], nextCursor: undefined });
      if (method === 'video.generate.get') return Promise.resolve(videoJob);
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    render(<TaskLogView projectId="project-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /文生视频/ }));

    expect(await screen.findByRole('heading', { name: '视频产物' })).toBeInTheDocument();
    expect(screen.getByText('provider-task-1')).toBeInTheDocument();
    expect(screen.getByText('assets/videos/generated.mp4')).toBeInTheDocument();
  });

  it('opens the source document from an agent detail', async () => {
    const onOpenDocument = vi.fn();
    render(<TaskLogView projectId="project-1" onOpenDocument={onOpenDocument} />);

    fireEvent.click(await screen.findByRole('button', { name: /项目大纲草稿/ }));
    expect(await screen.findByRole('heading', { name: '事件时间线' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开文档' }));

    expect(onOpenDocument).toHaveBeenCalledWith('document-1');
  });

  it('opens the source conversation from an agent detail', async () => {
    const onOpenConversation = vi.fn();
    render(<TaskLogView projectId="project-1" onOpenConversation={onOpenConversation} />);

    fireEvent.click(await screen.findByRole('button', { name: /项目大纲草稿/ }));
    expect(await screen.findByRole('heading', { name: '事件时间线' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开来源会话' }));

    expect(onOpenConversation).toHaveBeenCalledWith('conversation-1');
  });

  it('offers explicit recovery and discard actions for failed partial artifacts', async () => {
    const partial = {
      id: 'partial-1',
      taskId: 'task-1',
      documentId: 'document-1',
      targetKind: 'reference-update' as const,
      contentLength: 128,
      status: 'recoverable' as const,
      rowVersion: 2,
      expiresAt: '2026-08-17T01:00:00.000Z',
      createdAt: '2026-08-16T01:00:00.000Z',
      updatedAt: '2026-08-16T01:00:00.000Z',
    };
    const discardablePartial = { ...partial, id: 'partial-2', documentId: undefined };
    const failedDetail: AgentTaskDetail = {
      ...agentDetail,
      task: { ...agentDetail.task, status: 'failed', phase: 'recovering' },
    };
    const respond = (value: unknown) => Promise.resolve(value as never);
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'task.log.list') return respond({ items: [agentItem], nextCursor: undefined });
      if (method === 'agent.task.get') return respond(failedDetail);
      if (method === 'agent.partial.list') return respond([partial, discardablePartial]);
      if (method === 'document.get') return respond({ ...agentDetail.documents[0], rowVersion: 4 });
      if (method === 'agent.partial.recover') return respond({ id: 'document-1' });
      if (method === 'agent.partial.discard') return respond({ ...partial, status: 'discarded' });
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const onOpenDocument = vi.fn();
    render(<TaskLogView projectId="project-1" onOpenDocument={onOpenDocument} />);

    fireEvent.click(await screen.findByRole('button', { name: /项目大纲草稿/ }));
    expect(await screen.findByText(/任务失败，但仍有可恢复/)).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: '恢复草稿' })[0]!);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('agent.partial.recover', {
        artifactId: 'partial-1',
        expectedRowVersion: 2,
        expectedDocumentRowVersion: 4,
      }),
    );
    expect(onOpenDocument).toHaveBeenCalledWith('document-1');
    expect(confirm).toHaveBeenCalledWith('将未完成内容恢复为新的用户草稿吗？原有版本不会被覆盖。');

    fireEvent.click(screen.getAllByRole('button', { name: '丢弃' })[0]!);
    await waitFor(() =>
      expect(callWorker).toHaveBeenCalledWith('agent.partial.discard', {
        artifactId: 'partial-2',
        expectedRowVersion: 2,
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      '确定丢弃这份未完成产物吗？丢弃后将清除其内容，且无法恢复。',
    );
    confirm.mockRestore();
  });

  it('closes the selected detail panel without reloading the task list', async () => {
    render(<TaskLogView projectId="project-1" />);
    fireEvent.click(await screen.findByRole('button', { name: /项目大纲草稿/ }));
    expect(await screen.findByRole('heading', { name: '事件时间线' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '关闭任务详情' }));

    expect(screen.queryByRole('heading', { name: '事件时间线' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /项目大纲草稿/ })).toBeInTheDocument();
    expect(
      vi.mocked(callWorker).mock.calls.filter(([method]) => method === 'task.log.list'),
    ).toHaveLength(1);
  });

  it('filters by kind and loads the next cursor page', async () => {
    vi.mocked(callWorker).mockImplementation((method, params) => {
      if (method === 'task.log.list') {
        const typed = params as { cursor?: string; kind?: string };
        return Promise.resolve(
          typed.cursor
            ? { items: [imageItem], nextCursor: undefined }
            : typed.kind === 'image'
              ? { items: [imageItem], nextCursor: undefined }
              : { items: [agentItem], nextCursor: 'agent:task-1' },
        );
      }
      return Promise.reject(new Error(`Unexpected method ${method}`));
    });
    render(<TaskLogView projectId="project-1" />);

    expect(await screen.findByRole('button', { name: /项目大纲草稿/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '加载更多' }));
    expect(await screen.findByRole('button', { name: /文本生成图片/ })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: '任务类型筛选' }), {
      target: { value: 'image' },
    });
    await waitFor(() =>
      expect(vi.mocked(callWorker)).toHaveBeenCalledWith(
        'task.log.list',
        expect.objectContaining({ kind: 'image' }),
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /项目大纲草稿/ })).not.toBeInTheDocument(),
    );
  });

  it('registers an auto-refresh interval while a project is open', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    render(<TaskLogView projectId="project-1" />);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
    setIntervalSpy.mockRestore();
  });
});
