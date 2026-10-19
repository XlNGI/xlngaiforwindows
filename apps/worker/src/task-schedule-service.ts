import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import type { VideoScheduleView } from '@ai-video/contracts';
import { createRepositories } from '@ai-video/persistence';
import type { ProjectService } from './project-service.js';
import type { TaskCapacity } from './task-capacity.js';

interface Entry {
  id: string;
  owner_job_id: string;
  schedule_state: string;
  wait_reason: string | null;
  row_version: number;
  request_hash: string;
}
export interface TaskDispatch {
  id: string;
  taskId: string;
  runtimeEpoch: string;
  stage: 'submit' | 'poll';
}
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled', 'timed_out']);

/** Owns dispatch eligibility only. Generation jobs remain authoritative for business outcomes. */
export class TaskScheduleService {
  readonly enabled: boolean;
  private readonly submissions = new Map<string, { tokenHash: string; work: Promise<unknown> }>();
  private historyEpoch?: string;
  private historicalJobs = new Set<string>();
  constructor(
    private readonly projects: ProjectService,
    private readonly options: { enabled?: boolean; capacity?: TaskCapacity } = {},
  ) {
    this.enabled = options.enabled ?? true;
  }

  register(jobId: string, upstreamIds?: string[]): VideoScheduleView {
    const dependencies = [...new Set(upstreamIds ?? [])].sort();
    const hash = createHash('sha256').update(JSON.stringify({ jobId, dependencies })).digest('hex');
    return this.projects.access(true, (db, project) =>
      db.transaction(() => {
        const job = createRepositories(db).jobs.get(jobId);
        if (!job || job.projectId !== project.id || !/TO_(?:VIDEO|IMAGE):/.test(job.adapterKey))
          throw new Error('Only current-project image/video jobs can be scheduled.');
        const existing = db
          .prepare('SELECT * FROM task_schedule_entries WHERE id=? AND project_id=?')
          .get(jobId, project.id) as Entry | undefined;
        if (existing) {
          // Internal adoption without a new dependency declaration preserves the original graph.
          if (upstreamIds !== undefined && existing.request_hash !== hash)
            throw new Error('Schedule operation already exists with different dependencies.');
          return this.view(db, project.id, existing);
        }
        if (!this.enabled && !this.isHistoricalJob(jobId))
          throw new Error('New task scheduling is disabled.');
        const pending = (
          db
            .prepare(
              "SELECT entries.owner_job_id AS id FROM task_schedule_entries entries JOIN generation_jobs jobs ON jobs.id=entries.owner_job_id WHERE entries.project_id=? AND jobs.status NOT IN ('succeeded','failed','cancelled','timed_out')",
            )
            .all(project.id) as Array<{ id: string }>
        ).filter((entry) => !this.isHistoricalJob(entry.id)).length;
        if (!TERMINAL.has(job.status) && !this.isHistoricalJob(jobId) && pending >= 32)
          throw new Error('Project task queue is full (32).');
        for (const upstream of dependencies) {
          if (
            upstream === jobId ||
            !db
              .prepare('SELECT 1 FROM task_schedule_entries WHERE id=? AND project_id=?')
              .get(upstream, project.id)
          )
            throw new Error(
              'Task dependency is missing, self-referential, or belongs to another project.',
            );
        }
        const now = new Date().toISOString();
        db.prepare(
          `INSERT INTO task_schedule_entries
        (id,project_id,owner_job_id,operation_key,request_hash,schedule_state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`,
        ).run(
          jobId,
          project.id,
          jobId,
          `${job.adapterKey.includes('TO_VIDEO:') ? 'video' : 'image'}:${jobId}`,
          hash,
          TERMINAL.has(job.status) ? 'settled' : 'pending',
          now,
          now,
        );
        for (const upstream of dependencies)
          db.prepare(
            'INSERT INTO task_schedule_dependencies(task_id,upstream_id,project_id) VALUES(?,?,?)',
          ).run(jobId, upstream, project.id);
        this.event(db, jobId, 'registered');
        if (this.isHistoricalJob(jobId) && !TERMINAL.has(job.status))
          this.state(db, this.entry(db, jobId, project.id), 'waiting', 'snapshot_history');
        return this.view(db, project.id, this.entry(db, jobId, project.id));
      })(),
    );
  }

  claim(taskId: string, stage: TaskDispatch['stage'], capacity = 2): TaskDispatch | undefined {
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8)
      throw new Error('Invalid stage capacity.');
    const runtimeEpoch = this.projects.currentSessionId();
    if (!runtimeEpoch) throw new Error('No project runtime is open.');
    return this.projects.access(true, (db, project) =>
      db.transaction(() => {
        const entry = this.entry(db, taskId, project.id);
        const job = createRepositories(db).jobs.get(entry.owner_job_id)!;
        if (this.isHistoricalJob(job.id)) {
          this.state(db, entry, 'waiting', 'snapshot_history');
          return;
        }
        if (TERMINAL.has(job.status) || TERMINAL.has(job.mediaState ?? '')) {
          this.state(db, entry, 'settled', undefined);
          return;
        }
        if (job.mediaState === 'submission_unknown' || job.status === 'paused') {
          this.state(
            db,
            entry,
            'waiting',
            job.mediaState === 'submission_unknown' ? 'submission_unknown' : 'pause',
          );
          return;
        }
        if (
          db
            .prepare("SELECT 1 FROM task_schedule_dispatches WHERE task_id=? AND status='active'")
            .get(taskId)
        )
          return;
        if (stage === 'poll' && (!job.providerTaskId || job.status !== 'polling')) return;
        if (stage === 'submit' && job.mediaState !== 'awaiting_confirmation') return;
        const dependencies = db
          .prepare('SELECT upstream_id AS id FROM task_schedule_dependencies WHERE task_id=?')
          .all(taskId) as Array<{ id: string }>;
        for (const upstream of dependencies) {
          const source = this.entry(db, upstream.id, project.id);
          const upstreamJob = createRepositories(db).jobs.get(source.owner_job_id)!;
          if (upstreamJob.status !== 'succeeded') {
            this.state(
              db,
              entry,
              'waiting',
              TERMINAL.has(upstreamJob.status) ? 'dependency_failed' : 'dependency',
            );
            return;
          }
          const outputs = db
            .prepare(
              `SELECT assets.id,assets.content_hash AS hash FROM generation_results results
          JOIN assets ON assets.id=results.asset_id WHERE results.job_id=? AND assets.project_id=? AND assets.deleted_at IS NULL`,
            )
            .all(upstreamJob.id, project.id) as Array<{ id: string; hash: string }>;
          if (!outputs.length) {
            this.state(db, entry, 'waiting', 'dependency');
            return;
          }
          for (const output of outputs)
            db.prepare(
              'INSERT OR IGNORE INTO task_schedule_artifacts(task_id,upstream_id,source_asset_id,asset_id,content_hash) VALUES(?,?,?,?,?)',
            ).run(taskId, upstream.id, output.id, output.id, output.hash);
        }
        const count = (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM task_schedule_dispatches WHERE project_id=? AND stage=? AND status='active'",
            )
            .get(project.id, stage) as { n: number }
        ).n;
        if (count >= capacity) {
          this.state(db, entry, 'waiting', 'capacity');
          return;
        }
        // A newly arriving request cannot repeatedly jump ahead of a caller already waiting for capacity.
        const older = db
          .prepare(
            `SELECT 1 FROM task_schedule_entries queued
          JOIN generation_jobs jobs ON jobs.id=queued.owner_job_id
          WHERE queued.project_id=? AND queued.wait_reason='capacity'
            AND queued.rowid<(SELECT rowid FROM task_schedule_entries WHERE id=?)
            AND ((?='submit' AND jobs.media_state='awaiting_confirmation') OR (?='poll' AND jobs.status='polling'))
            AND NOT EXISTS(SELECT 1 FROM task_schedule_dispatches d WHERE d.task_id=queued.id AND d.status='active')
          LIMIT 1`,
          )
          .get(project.id, taskId, stage, stage);
        if (older) {
          this.state(db, entry, 'waiting', 'capacity');
          return;
        }
        const id = randomUUID();
        if (
          this.options.capacity &&
          !this.options.capacity.acquire(
            id,
            stage,
            undefined,
            `${runtimeEpoch}:${taskId}:${stage}`,
            runtimeEpoch,
          )
        ) {
          this.state(db, entry, 'waiting', 'capacity');
          return;
        }
        try {
          const now = new Date().toISOString();
          const updated = db
            .prepare(
              "UPDATE task_schedule_entries SET schedule_state='claimed',wait_reason=NULL,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?",
            )
            .run(now, taskId, entry.row_version);
          if (updated.changes !== 1) {
            this.options.capacity?.release(id);
            return;
          }
          db.prepare(
            "INSERT INTO task_schedule_dispatches(id,task_id,project_id,runtime_epoch,stage,status,created_at) VALUES(?,?,?,?,?,'active',?)",
          ).run(id, taskId, project.id, runtimeEpoch, stage, now);
          this.event(db, taskId, `${stage}.claimed`, id);
        } catch (error) {
          this.options.capacity?.release(id);
          throw error;
        }
        return { id, taskId, runtimeEpoch, stage };
      })(),
    );
  }

  isCurrent(dispatch: TaskDispatch): boolean {
    if (this.projects.currentSessionId() !== dispatch.runtimeEpoch) return false;
    return this.projects.access(false, (db) =>
      Boolean(
        db
          .prepare(
            "SELECT 1 FROM task_schedule_dispatches WHERE id=? AND task_id=? AND runtime_epoch=? AND status='active'",
          )
          .get(dispatch.id, dispatch.taskId, dispatch.runtimeEpoch),
      ),
    );
  }

  release(dispatch: TaskDispatch): void {
    this.options.capacity?.release(dispatch.id);
    if (!this.isCurrent(dispatch)) return;
    this.projects.access(true, (db, project) =>
      db.transaction(() => {
        db.prepare(
          "UPDATE task_schedule_dispatches SET status='released',completed_at=? WHERE id=? AND status='active'",
        ).run(new Date().toISOString(), dispatch.id);
        this.event(db, dispatch.taskId, `${dispatch.stage}.released`, dispatch.id);
        const entry = this.entry(db, dispatch.taskId, project.id);
        const job = createRepositories(db).jobs.get(entry.owner_job_id)!;
        this.state(
          db,
          entry,
          TERMINAL.has(job.status) || TERMINAL.has(job.mediaState ?? '') ? 'settled' : 'waiting',
          job.mediaState === 'submission_unknown'
            ? 'submission_unknown'
            : job.providerTaskId
              ? 'remote'
              : 'confirmation',
        );
      })(),
    );
  }

  /** Provider response is known; retain dispatch ownership while releasing the remote submit slot. */
  releaseSubmissionCapacity(jobId: string): void {
    this.projects.access(true, (db) => {
      const dispatch = db
        .prepare(
          "SELECT id FROM task_schedule_dispatches WHERE task_id=? AND runtime_epoch=? AND stage='submit' AND status='active'",
        )
        .get(jobId, this.projects.currentSessionId()) as { id: string } | undefined;
      if (dispatch) {
        this.options.capacity?.release(dispatch.id);
        this.event(db, jobId, 'submit.response_received', dispatch.id);
      }
    });
  }
  cancelWaiting(taskId: string): void {
    for (const stage of ['submit', 'poll'])
      this.options.capacity?.cancelWaiting(
        `${this.projects.currentSessionId()}:${taskId}:${stage}`,
      );
  }
  cancelAllWaiting(): void {
    const epoch = this.projects.currentSessionId();
    if (epoch) this.options.capacity?.cancelOwnerWaiting(epoch);
  }

  recover(): void {
    const epoch = this.projects.currentSessionId();
    const project = this.projects.current();
    if (!epoch || project?.mode !== 'read-write') return;
    this.projects.access(true, (db) =>
      db.transaction(() => {
        const old = db
          .prepare(
            "SELECT id,task_id FROM task_schedule_dispatches WHERE project_id=? AND runtime_epoch<>? AND status='active'",
          )
          .all(project.id, epoch) as Array<{ id: string; task_id: string }>;
        for (const dispatch of old) {
          db.prepare(
            "UPDATE task_schedule_dispatches SET status='interrupted',completed_at=? WHERE id=?",
          ).run(new Date().toISOString(), dispatch.id);
          this.event(db, dispatch.task_id, 'reconciling', dispatch.id);
          this.state(db, this.entry(db, dispatch.task_id, project.id), 'waiting', 'recovery');
        }
      })(),
    );
  }

  runSubmission<T>(
    jobId: string,
    confirmationToken: string,
    execute: () => Promise<T>,
  ): Promise<T> {
    const key = `${this.projects.currentSessionId()}:${jobId}`;
    const tokenHash = createHash('sha256').update(confirmationToken).digest('hex');
    const existing = this.submissions.get(key);
    if (existing)
      return existing.tokenHash === tokenHash
        ? (existing.work as Promise<T>)
        : Promise.reject(
            new Error('Scheduled submission confirmation does not match the active operation.'),
          );
    const work = this.executeSubmission(jobId, execute);
    this.submissions.set(key, { tokenHash, work });
    void work
      .finally(() => {
        this.options.capacity?.cancelWaiting(`${key}:submit`);
        if (this.submissions.get(key)?.work === work) this.submissions.delete(key);
      })
      .catch(() => undefined);
    return work;
  }

  private async executeSubmission<T>(jobId: string, execute: () => Promise<T>): Promise<T> {
    if (this.isHistoricalJob(jobId))
      throw new Error('Exported task history cannot automatically submit another paid request.');
    if (!this.enabled) return execute();
    this.register(jobId);
    const epoch = this.projects.currentSessionId();
    const deadline = Date.now() + 10 * 60_000;
    while (this.projects.currentSessionId() === epoch) {
      const view = this.get(jobId);
      if (view.domainState !== 'awaiting_confirmation')
        throw new Error('Scheduled submission is no longer executable.');
      const dispatch = this.claim(jobId, 'submit');
      if (dispatch) {
        try {
          return await execute();
        } finally {
          this.release(dispatch);
        }
      }
      if (view.waitReason === 'dependency_failed')
        throw new Error('A required task dependency did not succeed.');
      if (view.waitReason === 'snapshot_history')
        throw new Error('Exported task history cannot automatically submit another paid request.');
      if (view.waitReason === 'capacity') {
        const expired = this.projects.access(false, (database) => {
          const job = createRepositories(database).jobs.get(jobId);
          return (
            !job?.submissionConfirmationExpiresAt ||
            Date.parse(job.submissionConfirmationExpiresAt) <= Date.now()
          );
        });
        if (expired) {
          this.cancelWaiting(jobId);
          throw new Error('Scheduled confirmation expired before execution.');
        }
      }
      if (Date.now() >= deadline) throw new Error('Scheduled submission timed out before sending.');
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('Project session changed before scheduled submission.');
  }

  get(taskId: string): VideoScheduleView {
    return this.projects.access(false, (db, project) =>
      this.view(db, project.id, this.entry(db, taskId, project.id)),
    );
  }
  list(): VideoScheduleView[] {
    return this.projects.access(false, (db, project) =>
      (
        db
          .prepare(
            'SELECT * FROM task_schedule_entries WHERE project_id=? ORDER BY created_at DESC,id DESC LIMIT 100',
          )
          .all(project.id) as Entry[]
      ).map((entry) => this.view(db, project.id, entry)),
    );
  }
  events(taskId: string, afterSequence = 0) {
    return this.projects.access(false, (db, project) => {
      this.entry(db, taskId, project.id);
      return db
        .prepare(
          'SELECT sequence,kind,dispatch_id AS dispatchId,created_at AS createdAt FROM task_schedule_events WHERE task_id=? AND sequence>? ORDER BY sequence LIMIT 100',
        )
        .all(taskId, afterSequence) as Array<{
        sequence: number;
        kind: string;
        dispatchId: string | null;
        createdAt: string;
      }>;
    });
  }
  private entry(db: Database.Database, id: string, projectId: string): Entry {
    const entry = db
      .prepare('SELECT * FROM task_schedule_entries WHERE id=? AND project_id=?')
      .get(id, projectId) as Entry | undefined;
    if (!entry) throw new Error('Scheduled task was not found in this project.');
    return entry;
  }
  isHistoricalJob(jobId: string): boolean {
    const epoch = this.projects.currentSessionId();
    if (epoch !== this.historyEpoch) {
      this.historyEpoch = epoch;
      this.historicalJobs = new Set();
      const root = this.projects.current()?.rootPath;
      if (root) {
        const file = join(root, 'project-snapshot.json');
        try {
          if (statSync(file).size > 16 * 1024 * 1024)
            throw new Error('Project snapshot history exceeds its size limit.');
          const marker = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
          if (
            marker.kind !== 'project-history' ||
            marker.projectId !== this.projects.current()?.id ||
            !Array.isArray(marker.historicalMediaJobIds) ||
            marker.historicalMediaJobIds.some((id: unknown) => typeof id !== 'string')
          )
            throw new Error('Project snapshot history is invalid.');
          this.historicalJobs = new Set(marker.historicalMediaJobIds as string[]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            this.historyEpoch = undefined;
            throw error;
          }
        }
      }
    }
    return this.historicalJobs.has(jobId);
  }
  private view(db: Database.Database, projectId: string, entry: Entry): VideoScheduleView {
    const job = createRepositories(db).jobs.get(entry.owner_job_id)!;
    return {
      taskId: entry.id,
      projectId,
      ownerJobId: job.id,
      scheduleState: TERMINAL.has(job.status) ? 'settled' : entry.schedule_state,
      waitReason: entry.wait_reason ?? undefined,
      domainState: job.mediaState ?? job.status,
      revision: entry.row_version,
    };
  }
  private state(db: Database.Database, entry: Entry, state: string, reason?: string) {
    if (entry.schedule_state === state && entry.wait_reason === (reason ?? null)) return;
    db.prepare(
      'UPDATE task_schedule_entries SET schedule_state=?,wait_reason=?,row_version=row_version+1,updated_at=? WHERE id=?',
    ).run(state, reason ?? null, new Date().toISOString(), entry.id);
    this.event(db, entry.id, reason ?? state);
  }
  private event(db: Database.Database, taskId: string, kind: string, dispatchId?: string) {
    db.prepare(
      `INSERT INTO task_schedule_events(task_id,sequence,kind,dispatch_id,created_at)
      VALUES(?,(SELECT COALESCE(MAX(sequence),0)+1 FROM task_schedule_events WHERE task_id=?),?,?,?)`,
    ).run(taskId, taskId, kind, dispatchId ?? null, new Date().toISOString());
  }
}
