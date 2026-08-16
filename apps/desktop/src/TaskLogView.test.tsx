import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentTaskDetail, TaskLogItem } from '@ai-video/contracts';
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
};

describe('TaskLogView', () => {
  beforeEach(() => {
    vi.mocked(callWorker).mockImplementation((method) => {
      if (method === 'task.log.list')
        return Promise.resolve({ items: [agentItem, imageItem], nextCursor: undefined });
      if (method === 'agent.task.get') return Promise.resolve(agentDetail);
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
    expect(screen.getByText(/版本/)).toHaveTextContent('version-1');
    expect(screen.getByText('OpenAI · gpt-test')).toBeInTheDocument();
    expect(screen.getByText('输入 100 · 输出 20')).toBeInTheDocument();
    expect(screen.getByText('0.0001')).toBeInTheDocument();
  });

  it('shows a basic image source hint without requesting Agent task details', async () => {
    render(<TaskLogView projectId="project-1" />);

    fireEvent.click(await screen.findByRole('button', { name: /文本生成图片/ }));

    expect(await screen.findByRole('heading', { name: '图片来源' })).toBeInTheDocument();
    expect(screen.getByText('image-job-1')).toBeInTheDocument();
    expect(
      screen.getByText('当前仅展示生成任务的基础来源信息，详细参数和产物请从对应工作区查看。'),
    ).toBeInTheDocument();
    expect(callWorker).not.toHaveBeenCalledWith('agent.task.get', expect.anything());
  });

  it('opens the source document from an agent detail', async () => {
    const onOpenDocument = vi.fn();
    render(<TaskLogView projectId="project-1" onOpenDocument={onOpenDocument} />);

    fireEvent.click(await screen.findByRole('button', { name: /项目大纲草稿/ }));
    expect(await screen.findByRole('heading', { name: '事件时间线' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开文档' }));

    expect(onOpenDocument).toHaveBeenCalledWith('document-1');
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
