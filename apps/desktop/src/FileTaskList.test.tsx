import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { FileTaskInfo } from '@ai-video/contracts';
import { FileTaskList } from './FileTaskList';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(cleanup);
it('shows durable file progress and cancels only the selected operation', async () => {
  const base: FileTaskInfo = {
    id: 'A',
    projectId: 'project',
    kind: 'project-export',
    status: 'running',
    progress: 15,
    revision: 1,
    createdAt: 'now',
    updatedAt: 'now',
  };
  vi.mocked(callWorker).mockImplementation(((method: string, params: { taskId?: string }) => {
    if (method === 'file.task.list')
      return Promise.resolve([base, { ...base, id: 'B', kind: 'project-backup' }]);
    if (method === 'novel.export.list') return Promise.resolve([]);
    if (method === 'file.task.cancel')
      return Promise.resolve({ ...base, id: params.taskId, status: 'cancelled' });
    throw new Error('Unexpected operation');
  }) as typeof callWorker);
  render(<FileTaskList projectId="project" />);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: '取消此文件任务' })).toHaveLength(2),
  );
  fireEvent.click(screen.getAllByRole('button', { name: '取消此文件任务' })[0]!);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: '取消此文件任务' })).toHaveLength(1),
  );
  expect(callWorker).toHaveBeenCalledWith('file.task.cancel', { taskId: 'A' });
  expect(screen.getByText(/项目备份 · 执行中/)).toBeInTheDocument();
});
