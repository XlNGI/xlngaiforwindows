import { invoke } from '@tauri-apps/api/core';
import { beforeEach, expect, it, vi } from 'vitest';
import { pickProjectDirectory } from './project-directory-client';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
beforeEach(() => vi.mocked(invoke).mockReset());

it('uses the isolated native command for create and open, preserving cancellation', async () => {
  vi.mocked(invoke).mockResolvedValueOnce('E:\\中文项目').mockResolvedValueOnce(null);
  await expect(pickProjectDirectory()).resolves.toBe('E:\\中文项目');
  expect(invoke).toHaveBeenLastCalledWith('project_directory_pick', { openExisting: false });
  await expect(pickProjectDirectory(true)).resolves.toBeNull();
  expect(invoke).toHaveBeenLastCalledWith('project_directory_pick', { openExisting: true });
});

it('turns Tauri string errors into visible messages instead of losing the native failure reason', async () => {
  vi.mocked(invoke).mockRejectedValueOnce(' 系统目录选择器异常退出（0xc0000005） ');
  await expect(pickProjectDirectory()).rejects.toThrow('系统目录选择器异常退出（0xc0000005）');
});
