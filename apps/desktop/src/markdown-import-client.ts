import { invoke } from '@tauri-apps/api/core';

export interface MarkdownImportResult {
  title: string;
  contentMarkdown: string;
}

export function readMarkdownDocument(path: string): Promise<MarkdownImportResult> {
  return invoke<MarkdownImportResult>('markdown_import', { path }).catch((reason: unknown) => {
    if (reason instanceof Error) throw reason;
    if (typeof reason === 'string' && reason.trim()) throw new Error(reason.trim());
    throw new Error('Markdown 文件读取失败');
  });
}
