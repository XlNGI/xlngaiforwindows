import type {
  NovelImportParams,
  NovelImportResult,
  NovelMarkdownExportJobInfo,
  NovelMarkdownExportPrepareParams,
} from './index.js';
export interface FileTaskInfo {
  id: string;
  projectId: string;
  kind: 'project-export' | 'project-backup' | 'novel-import';
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  progress: number;
  revision: number;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: { path: string } | NovelImportResult;
}
export type FileTaskCreateParams = { idempotencyKey: string } & (
  | { kind: 'project-export'; destinationRoot: string }
  | { kind: 'project-backup'; destinationPath?: string }
  | { kind: 'novel-import'; input: NovelImportParams }
);
export interface FileTaskWorkerMethodMap {
  'file.task.create': { params: FileTaskCreateParams; result: FileTaskInfo };
  'file.task.get': { params: { taskId: string }; result: FileTaskInfo };
  'file.task.list': { params: Record<string, never>; result: FileTaskInfo[] };
  'file.task.cancel': { params: { taskId: string }; result: FileTaskInfo };
  'novel.export.start': {
    params: NovelMarkdownExportPrepareParams;
    result: NovelMarkdownExportJobInfo;
  };
  'novel.export.get': { params: { jobId: string }; result: NovelMarkdownExportJobInfo };
  'novel.export.list': { params: Record<string, never>; result: NovelMarkdownExportJobInfo[] };
  'novel.export.cancel': { params: { jobId: string }; result: NovelMarkdownExportJobInfo };
}
