import type { WorkerMethod } from '@ai-video/contracts';

export interface RequestSchedulerOptions {
  onQueueWait?: (method: WorkerMethod, waitMs: number) => void;
}

const concurrentReadMethods = new Set<WorkerMethod>([
  'project.runtime.list',
  'project.runtime.registrations',
  'task.schedule.list',
  'task.schedule.get',
  'task.schedule.events',
  'scene.media.resolve',
  'asset.thumbnail',
  'characterVoice.list',
  'characterVoiceReference.list',
  'audio.list',
  'audio.get',
  'audio.mediaSource',
  'dubbing.runtime.get',
  'dubbing.scene.get',
  'dubbing.job.get',
  'dubbing.job.list',
  'dubbing.job.cancel',
  'health',
  'sqlite.probe',
  'project.current',
  'project.recent',
  'project.integrity',
  'provider.profile.list',
  'provider.profile.get',
  'provider.definition.list',
  'model.contract.list',
  'model.contract.get',
  'model.contract.setEnabled',
  'model.binding.list',
  'model.binding.setEnabled',
  'model.protocol.list',
  'model.task-adapter.list',
  'provider.model.list',
  'provider.model.pricing.list',
  'provider.default.list',
  'usage.list',
  'maintenance.cache.inspect',
  'maintenance.metrics',
  'maintenance.diagnostics.reveal',
  'document.list',
  'document.get',
  'document.versions',
  'scene.list',
  'production.read',
  'shot.continuity.get',
  'production.compile',
  'shot.list',
  'shot.references.get',
  'conversation.list',
  'conversation.promptTemplate.get',
  'chat.message.list',
  'context.preview',
  'novel.context.consistencyReport',
  'novel.export.reveal',
  'agent.generation.cancel',
  'agent.task.get',
  'agent.task.events',
  'agent.task.list',
  'task.log.list',
  'generation.job.events.list',
  'conversation.runtime.get',
  'conversation.runtime.list',
  'novel.batch.get',
  'file.task.get',
  'file.task.list',
  'novel.export.get',
  'novel.export.list',
  'llm.status',
  'llm.generation.runtime',
  'llm.generation.get',
  'adapter.catalog',
  'adapter.resolve',
  'adapter.validate',
  'generation.draft.get',
  'image.generate.get',
  'video.generate.get',
  'video.generate.list',
  'project.task.subscribe',
  'asset.list',
  'asset.preview',
  'asset.mediaSource',
  'asset.open',
  'asset.reveal',
  'asset.source.locate',
  'tag.list',
  'assetGroup.list',
  'assetGroup.resolve',
]);

const backgroundMethods = new Set<WorkerMethod>([
  'shot.continuity.preview',
  'shot.continuity.confirm',
  'shot.continuity.prompt.prepare',
  'file.task.cancel',
  'novel.export.cancel',
  'novel.export.prepare',
  'novel.import',
  'novel.batch.cancel',
  'task.schedule.cancel',
  'audio.import',
  'dubbing.job.submit',
  'project.backup',
  'project.export',
  'provider.connection.begin',
  'provider.connection.complete',
  'usage.rebuild',
  'maintenance.diagnostics.export',
  'image.generate.complete',
  // Confirmation is consumed synchronously before waiting for Native. Local
  // mutations (including cancellation) must remain available during inference.
  'media.generation.confirmSubmission',
  'agent.generation.confirmMediaSubmission',
]);

export function isSerializedWorkerMethod(method: WorkerMethod): boolean {
  return !concurrentReadMethods.has(method) && !backgroundMethods.has(method);
}

export class RequestScheduler {
  private readonly mutationQueues = new Map<string, Promise<void>>();
  private readonly onQueueWait?: (method: WorkerMethod, waitMs: number) => void;

  constructor(options: RequestSchedulerOptions = {}) {
    this.onQueueWait = options.onQueueWait;
  }

  run<T>(method: WorkerMethod, task: () => Promise<T>, queueKey = 'application'): Promise<T> {
    if (!isSerializedWorkerMethod(method)) return task();
    const queuedAt = performance.now();
    const execute = (): Promise<T> => {
      this.onQueueWait?.(method, performance.now() - queuedAt);
      return task();
    };
    const result = (this.mutationQueues.get(queueKey) ?? Promise.resolve()).then(execute, execute);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.mutationQueues.set(queueKey, tail);
    void tail.then(() => {
      if (this.mutationQueues.get(queueKey) === tail) this.mutationQueues.delete(queueKey);
    });
    return result;
  }
}
