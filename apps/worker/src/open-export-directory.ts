import { spawn } from 'node:child_process';
import { win32 } from 'node:path';

export function openExportDirectory(path: string): Promise<void> {
  const command =
    process.platform === 'win32'
      ? win32.join(process.env.SystemRoot || 'C:\\Windows', 'explorer.exe')
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  return new Promise<void>((resolve, reject) => {
    // This child is the requested UI, so it must not inherit a hidden window.
    const child = spawn(command, [path], {
      detached: true,
      windowsHide: false,
      shell: false,
      stdio: 'ignore',
    });
    child.once('error', (error) => reject(new Error(`无法启动文件管理器：${error.message}`)));
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}
