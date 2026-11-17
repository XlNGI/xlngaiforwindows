import { invoke } from '@tauri-apps/api/core';

export function pickProjectDirectory(openExisting = false): Promise<string | null> {
  return invoke<string | null>('project_directory_pick', { openExisting }).catch(
    (reason: unknown) => {
      if (reason instanceof Error) throw reason;
      if (typeof reason === 'string' && reason.trim()) throw new Error(reason.trim());
      throw new Error('目录选择失败，请重试或直接输入项目绝对目录。');
    },
  );
}
