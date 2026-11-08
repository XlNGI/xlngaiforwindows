import { randomUUID } from 'node:crypto';
import { validateProductionAuthoringIR, validateProductionTiming } from '@ai-video/contracts';
import { createRepositories } from '@ai-video/persistence';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import { ProjectService } from './project-service.js';

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('镜头时长参数必须是对象。');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)))
    throw new Error('镜头时长参数包含不支持的字段。');
  return object;
}

/** A timing edit never requires the model to resend authored text or bindings. */
export class ShotTimingService {
  constructor(private readonly projects: ProjectService) {}

  update(input: unknown, identity: AgentSystemToolIdentity): Record<string, unknown> {
    const args = record(input, ['shots']);
    if (!Array.isArray(args.shots) || !args.shots.length || args.shots.length > 100)
      throw new Error('shots 必须包含 1–100 个已有镜头。');
    const shots = args.shots.map((value: unknown) => {
      const entry = record(value, [
        'shotId',
        'expectedRowVersion',
        'estimatedDurationSeconds',
        'rationale',
        'beats',
      ]);
      if (typeof entry.shotId !== 'string' || !entry.shotId.trim() || entry.shotId.length > 200)
        throw new Error('shotId 必须是已有镜头的真实 ID。');
      if (
        !Number.isSafeInteger(entry.expectedRowVersion) ||
        (entry.expectedRowVersion as number) < 0
      )
        throw new Error('expectedRowVersion 必须是镜头当前版本。');
      return {
        shotId: entry.shotId,
        expectedRowVersion: entry.expectedRowVersion as number,
        timing: validateProductionTiming({
          estimatedDurationSeconds: entry.estimatedDurationSeconds,
          rationale: entry.rationale,
          ...(entry.beats !== undefined ? { beats: entry.beats } : {}),
        }),
      };
    });
    if (new Set(shots.map((shot) => shot.shotId)).size !== shots.length)
      throw new Error('同一批次不能重复更新同一镜头。');
    if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024)
      throw new Error('镜头时长更新超过 256 KiB。');
    return this.projects.access(true, (db, project) => {
      if (
        identity.projectId !== project.id ||
        identity.projectSessionId !== this.projects.currentSessionId()
      )
        throw new Error('镜头时长更新不属于当前项目会话。');
      let changedAt: string | undefined;
      const result = db.transaction(() => {
        const repositories = createRepositories(db);
        const candidates = shots.map((entry) => {
          const shot = repositories.shots.get(entry.shotId);
          const scene = shot && repositories.scenes.get(shot.sceneId);
          if (!shot || !scene || scene.projectId !== project.id)
            throw new Error(`镜头不属于当前项目：${entry.shotId}`);
          if (shot.rowVersion !== entry.expectedRowVersion)
            throw new Error(
              `SHOT_ROW_VERSION_CONFLICT: ${entry.shotId}，请读取该场次最新版本后重试。`,
            );
          const ir = shot.authoringIRJson
            ? validateProductionAuthoringIR(JSON.parse(shot.authoringIRJson), 'shot')
            : undefined;
          if (!ir) throw new Error(`镜头「${shot.title}」没有内容，请先补充镜头正文。`);
          const current = ir?.timing;
          return {
            ...entry,
            shot,
            changed:
              current?.estimatedDurationSeconds !== entry.timing.estimatedDurationSeconds ||
              current?.rationale !== entry.timing.rationale ||
              JSON.stringify(current?.beats) !== JSON.stringify(entry.timing.beats),
            ir: validateProductionAuthoringIR(
              {
                ...ir,
                timing: entry.timing,
              },
              'shot',
            ),
          };
        });
        const now = new Date().toISOString();
        const executionId = randomUUID();

        for (const candidate of candidates) {
          if (!candidate.changed) continue;
          const updated = db
            .prepare(
              'UPDATE shots SET authoring_ir_json=?,row_version=row_version+1,updated_at=? WHERE id=? AND row_version=?',
            )
            .run(
              candidate.ir ? JSON.stringify(candidate.ir) : null,
              now,
              candidate.shotId,
              candidate.expectedRowVersion,
            );
          if (updated.changes !== 1) throw new Error('SHOT_ROW_VERSION_CONFLICT');
        }
        const changedCount = candidates.filter((candidate) => candidate.changed).length;
        if (changedCount) {
          repositories.projects.touch(now);
          changedAt = now;
        }
        const saved = {
          status: 'shot_timings_saved',
          executionId,
          changedCount,
          unchangedCount: candidates.length - changedCount,
          sceneIds: [...new Set(candidates.map(({ shot }) => shot.sceneId))],
          shots: candidates.map(({ shot, timing, changed }) => ({
            shotId: shot.id,
            sceneId: shot.sceneId,
            rowVersion: shot.rowVersion + Number(changed),
            estimatedDurationSeconds: timing.estimatedDurationSeconds,
            changed,
          })),
          paidRequests: 0,
        };
        return saved;
      })();
      if (changedAt) project.updatedAt = changedAt;
      return result;
    });
  }
}
