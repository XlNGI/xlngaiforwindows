import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProjectProductionDefaults } from './ProjectProductionDefaults';
import { callWorker } from './worker-client';
vi.mock('./worker-client', () => ({ callWorker: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('project visual defaults', () => {
  it('loads on demand and saves shared style with optimistic versioning', async () => {
    vi.mocked(callWorker)
      .mockResolvedValueOnce({
        rowVersion: 2,
        settings: { style: { medium: '二维动画' }, generation: { ratio: '9:16' } },
      })
      .mockResolvedValueOnce({
        rowVersion: 3,
        settings: { style: { medium: '水彩动画' }, generation: { ratio: '9:16' } },
      });
    const saved = vi.fn();
    const { container } = render(<ProjectProductionDefaults writable onSaved={saved} />);
    expect(callWorker).not.toHaveBeenCalled();
    const details = container.querySelector('details')!;
    details.open = true;
    fireEvent(details, new Event('toggle'));
    const input = await screen.findByLabelText('画面类型');
    fireEvent.change(input, { target: { value: '水彩动画' } });
    fireEvent.click(screen.getByRole('button', { name: '保存默认设置' }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(callWorker).toHaveBeenCalledWith('production.defaults.save', {
      expectedRowVersion: 2,
      settings: { style: { medium: '水彩动画' }, generation: { ratio: '9:16' } },
    });
  });
});
