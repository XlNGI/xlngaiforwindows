import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoughCutExportJob } from '@ai-video/contracts';
import { RoughCutExportStatus } from './RoughCutExportStatus';

const call = vi.fn();
vi.mock('../worker-client', () => ({
  callWorker: (...args: unknown[]): unknown => call(...args) as unknown,
}));
const job: RoughCutExportJob = {
  id: 'synthetic-export',
  format: 'mp4',
  status: 'succeeded',
  completedClips: 1,
  totalClips: 1,
  sequenceVersion: 1,
  path: 'C:\\Synthetic project\\exports\\rough-cut-test',
};
beforeEach(() => {
  call.mockReset();
  call.mockImplementation(() => Promise.resolve(job));
});
afterEach(cleanup);

describe('RoughCutExportStatus', () => {
  it('shows folder opening feedback and prevents duplicate requests until it finishes', async () => {
    let finish!: () => void;
    call.mockImplementation((method: string) =>
      method === 'roughCut.export.reveal'
        ? new Promise((resolve) => {
            finish = () => resolve({ path: job.path });
          })
        : Promise.resolve(job),
    );
    render(<RoughCutExportStatus initial={job} onDismiss={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '打开导出文件夹' }));
    expect(screen.getByRole('button', { name: '正在打开…' })).toBeDisabled();
    expect(screen.getByText(`${job.path}\\rough-cut.mp4`)).toBeInTheDocument();
    finish();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '打开导出文件夹' })).toBeEnabled(),
    );
    expect(call.mock.calls.filter(([method]) => method === 'roughCut.export.reveal')).toHaveLength(
      1,
    );
  });

  it('keeps opening failures visible when a delayed export poll succeeds and supports retry', async () => {
    let finishPoll!: () => void;
    let attempts = 0;
    const update = vi.fn();
    call.mockImplementation((method: string) => {
      if (method === 'roughCut.export.get')
        return new Promise((resolve) => {
          finishPoll = () => resolve(job);
        });
      if (method === 'roughCut.export.reveal' && attempts++ === 0)
        return Promise.reject(new Error('Synthetic Explorer failure'));
      return Promise.resolve({ path: job.path });
    });
    render(<RoughCutExportStatus initial={job} onDismiss={() => undefined} onUpdate={update} />);
    fireEvent.click(screen.getByRole('button', { name: '打开导出文件夹' }));
    expect(
      await screen.findByText(/打开导出文件夹失败：.*Synthetic Explorer failure/),
    ).toBeInTheDocument();
    finishPoll();
    await waitFor(() => expect(update).toHaveBeenCalledWith(job));
    expect(screen.getByText(/Synthetic Explorer failure/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开导出文件夹' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '打开导出文件夹' })).toBeEnabled(),
    );
    expect(screen.queryByText(/Synthetic Explorer failure/)).not.toBeInTheDocument();
    expect(screen.getByText(`${job.path}\\rough-cut.mp4`)).toBeInTheDocument();
  });
});
