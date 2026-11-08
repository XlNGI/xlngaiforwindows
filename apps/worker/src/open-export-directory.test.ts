import { EventEmitter } from 'node:events';
import { win32 } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openExportDirectory } from './open-export-directory.js';

const launch = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: launch }));

beforeEach(() => launch.mockReset());

describe('openExportDirectory', () => {
  it('launches the requested visible file manager without interpreting the folder as shell text', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    launch.mockReturnValue(child);
    const folder = 'C:\\Synthetic output\\中文 & export';
    const pending = openExportDirectory(folder);
    expect(launch).toHaveBeenCalledWith(
      process.platform === 'win32'
        ? win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
        : process.platform === 'darwin'
          ? 'open'
          : 'xdg-open',
      [folder],
      { detached: true, windowsHide: false, shell: false, stdio: 'ignore' },
    );
    child.emit('spawn');
    await pending;
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('reports file manager startup failures rather than returning success', async () => {
    const child = Object.assign(new EventEmitter(), { unref: vi.fn() });
    launch.mockReturnValue(child);
    const pending = openExportDirectory('C:\\Synthetic output');
    child.emit('error', new Error('Synthetic Explorer startup failure'));
    await expect(pending).rejects.toThrow('无法启动文件管理器：Synthetic Explorer startup failure');
    expect(child.unref).not.toHaveBeenCalled();
  });
});
