export interface NovelBatchInfo {
  batchId: string;
  parentTaskId: string;
  children: Array<{
    key: string;
    taskId: string;
    generationId: string;
    chapterId: string;
    documentId: string;
    status: string;
    generationStatus: string;
    documentVersionId?: string;
    conflictArtifactId?: string;
    dependsOn: Array<{ key: string; milestone: 'draft' | 'published'; versionId?: string }>;
  }>;
}
export interface NovelBatchWorkerMethodMap {
  'novel.batch.get': { params: { batchId: string }; result: NovelBatchInfo };
  'novel.batch.cancel': { params: { batchId: string }; result: NovelBatchInfo };
}
