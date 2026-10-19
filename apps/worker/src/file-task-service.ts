import { createHash, randomUUID } from 'node:crypto';
import type { FileTaskCreateParams, FileTaskInfo } from '@ai-video/contracts';
import type { ProjectService } from './project-service.js';
import type { NovelService } from './novel-service.js';
import { ExecutionPool } from './execution-pool.js';
import { assertProjectTaskAdmission } from './task-admission.js';

type Row = {
  id: string;
  project_id: string;
  runtime_epoch: string;
  kind: FileTaskInfo['kind'];
  status: FileTaskInfo['status'];
  progress: number;
  row_version: number;
  input_json: string;
  result_json: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};
const active = (status: string) => status === 'pending' || status === 'running';
export class FileTaskService {
  private readonly running = new Map<
    string,
    { controller: AbortController; completion: Promise<void> }
  >();
  constructor(
    private readonly projects: ProjectService,
    private readonly novels: NovelService,
    private readonly capacity = new ExecutionPool(),
  ) {}

  create(params: FileTaskCreateParams): FileTaskInfo {
    const input = structuredClone(params),
      hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const job = this.projects.access(true, (database, project) =>
      database.transaction(() => {
        const existing = database
          .prepare(
            'SELECT id,request_hash AS hash FROM file_tasks WHERE project_id=? AND operation_key=?',
          )
          .get(project.id, input.idempotencyKey) as { id: string; hash: string } | undefined;
        if (existing) {
          if (existing.hash !== hash)
            throw new Error('File task operation key has different input.');
          return this.get(existing.id);
        }
        assertProjectTaskAdmission(database);
        const id = randomUUID(),
          now = new Date().toISOString();
        const summary =
          input.kind === 'novel-import'
            ? {
                kind: input.kind,
                volumeTitle: input.input.volumeTitle,
                chapterCount: input.input.chapters.length,
              }
            : input;
        database
          .prepare(
            `INSERT INTO file_tasks(id,project_id,runtime_epoch,kind,operation_key,request_hash,input_json,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'pending',?,?)`,
          )
          .run(
            id,
            project.id,
            this.projects.currentSessionId(),
            input.kind,
            input.idempotencyKey,
            hash,
            JSON.stringify(summary),
            now,
            now,
          );
        return this.get(id);
      })(),
    );
    if (active(job.status) && !this.running.has(job.id)) this.launch(job, input);
    return job;
  }
  get(id: string): FileTaskInfo {
    return this.projects.access(false, (database, project) => {
      const row = database
        .prepare('SELECT * FROM file_tasks WHERE id=? AND project_id=?')
        .get(id, project.id) as Row | undefined;
      if (!row) throw new Error('File task was not found in this project.');
      return info(row);
    });
  }
  list(): FileTaskInfo[] {
    return this.projects.access(false, (database, project) =>
      (
        database
          .prepare(
            'SELECT * FROM file_tasks WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 100',
          )
          .all(project.id) as Row[]
      ).map(info),
    );
  }
  private launch(job: FileTaskInfo, params: FileTaskCreateParams): void {
    const epoch = this.projects.currentSessionId(),
      controller = new AbortController();
    const assertCurrent = () => {
      controller.signal.throwIfAborted();
      if (this.projects.currentSessionId() !== epoch)
        throw new Error('Project session changed during file task.');
    };
    const completion = this.capacity
      .run('file-io', job.projectId, controller.signal, async () => {
        assertCurrent();
        this.patch(job.id, 'running', 1);
        let result: NonNullable<FileTaskInfo['result']>;
        if (params.kind === 'project-export')
          result = {
            path: await this.projects.exportProject(params.destinationRoot, controller.signal),
          };
        else if (params.kind === 'project-backup')
          result = { path: await this.projects.backup(params.destinationPath, controller.signal) };
        else
          result = await this.novels.importNovelAsync(params.input, controller.signal, (value) => {
            assertCurrent();
            this.patch(job.id, 'running', value);
          });
        // The domain operation publishes synchronously after its last abort check; completion wins a later cancel.
        if (this.projects.currentSessionId() !== epoch)
          throw new Error('Project session changed after file publication.');
        this.patch(job.id, 'succeeded', 100, result);
      })
      .catch((error: unknown) => {
        if (this.projects.currentSessionId() === epoch && active(this.get(job.id).status))
          this.patch(
            job.id,
            controller.signal.aborted ? 'cancelled' : 'failed',
            undefined,
            undefined,
            error instanceof Error ? error.message : 'File task failed.',
          );
      })
      .finally(() => {
        if (this.running.get(job.id)?.controller === controller) this.running.delete(job.id);
      });
    this.running.set(job.id, { controller, completion });
  }
  private patch(
    id: string,
    status: FileTaskInfo['status'],
    progress?: number,
    result?: FileTaskInfo['result'],
    error?: string,
  ): void {
    this.projects.access(true, (database) =>
      database
        .prepare(
          `UPDATE file_tasks SET status=?,progress=COALESCE(?,progress),result_json=?,error=?,
    input_json=CASE WHEN ? IN ('pending','running') THEN input_json ELSE '{}' END,row_version=row_version+1,updated_at=? WHERE id=? AND status IN('pending','running')`,
        )
        .run(
          status,
          progress ?? null,
          result ? JSON.stringify(result) : null,
          error?.slice(0, 500) ?? null,
          status,
          new Date().toISOString(),
          id,
        ),
    );
  }
  async wait(id: string): Promise<FileTaskInfo> {
    await this.running.get(id)?.completion;
    return this.get(id);
  }
  async cancel(id: string): Promise<FileTaskInfo> {
    const current = this.get(id);
    if (!active(current.status)) return current;
    this.projects.access(true, (database) =>
      database
        .prepare(
          "UPDATE file_tasks SET cancel_requested=1,row_version=row_version+1,updated_at=? WHERE id=? AND status IN('pending','running')",
        )
        .run(new Date().toISOString(), id),
    );
    const entry = this.running.get(id);
    entry?.controller.abort(new Error('File task cancelled by user.'));
    if (entry) await entry.completion;
    else this.patch(id, 'cancelled', undefined, undefined, 'File task cancelled by user.');
    return this.get(id);
  }
  async stop(): Promise<void> {
    for (const entry of this.running.values())
      entry.controller.abort(new Error('Project file tasks stopped.'));
    await Promise.allSettled([...this.running.values()].map((entry) => entry.completion));
  }
  recover(): void {
    this.projects.access(true, (database) =>
      database
        .prepare(
          "UPDATE file_tasks SET status='interrupted',input_json='{}',error='File work was interrupted; inspect published outputs before starting a new operation.',row_version=row_version+1,updated_at=? WHERE status IN('pending','running')",
        )
        .run(new Date().toISOString()),
    );
  }
}
function info(row: Row): FileTaskInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    status: row.status,
    progress: row.progress,
    revision: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.error ? { error: row.error } : {}),
    ...(row.result_json ? { result: JSON.parse(row.result_json) as FileTaskInfo['result'] } : {}),
  };
}
