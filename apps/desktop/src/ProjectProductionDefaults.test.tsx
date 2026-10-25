import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectProductionDefaults } from './ProjectProductionDefaults';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('project provider defaults', () => {
  it('loads on demand and saves output parameters with optimistic versioning', async () => {
    vi.mocked(callWorker)
      .mockResolvedValueOnce({
        rowVersion: 2,
        settings: { generation: { ratio: '9:16' } },
      })
      .mockResolvedValueOnce({
        rowVersion: 3,
        settings: { generation: { ratio: '9:16', resolution: '1080p' } },
      });
    const saved = vi.fn();
    const { container } = render(<ProjectProductionDefaults writable onSaved={saved} />);
    expect(callWorker).not.toHaveBeenCalled();
    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const input = await screen.findByLabelText('视频默认分辨率');
    fireEvent.change(input, { target: { value: '1080p' } });
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(callWorker).toHaveBeenCalledWith('production.defaults.save', {
      expectedRowVersion: 2,
      settings: { generation: { ratio: '9:16', resolution: '1080p' } },
    });
  });
});
