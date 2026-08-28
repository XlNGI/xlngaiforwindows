import { invoke } from '@tauri-apps/api/core';

export interface NovelImportResult {
  title: string;
  contentMarkdown: string;
}

export function readNovelDocument(path: string): Promise<NovelImportResult> {
  return invoke<NovelImportResult>('novel_import', { path }).catch((reason: unknown) => {
    if (reason instanceof Error) throw reason;
    if (typeof reason === 'string' && reason.trim()) throw new Error(reason.trim());
    throw new Error('小说文件读取失败');
  });
}
