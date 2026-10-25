import { createHash, randomUUID } from 'node:crypto';
import { validateProductionAuthoringIR, type ProductionShotAuthoringIR } from '@ai-video/contracts';
import { createRepositories } from '@ai-video/persistence';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import { ContentService } from './content-service.js';
import { ProjectService } from './project-service.js';
import { validateProductionIRReferences } from './project-ir-validation.js';

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('镜头提示词参数必须是对象。');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !keys.includes(key)))
    throw new Error('镜头提示词参数包含不支持的字段。');
  return object;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}

/** Local, atomic prompt revision; creative requirements belong in the authored prompt. */
export class ShotPromptService {
  constructor(private readonly projects: ProjectService) {}

  update(input: unknown, identity: AgentSystemToolIdentity): Record<string, unknown> {
    const args = record(input, ['shots']);
    if (Buffer.byteLength(JSON.stringify(args)) > 256 * 1024)
      throw new Error('镜头提示词更新超过 256 KiB；请分批提交并保留全部要求。');
    if (!Array.isArray(args.shots) || !args.shots.length || args.shots.length > 30)
      throw new Error('shots 必须包含 1–30 个已有镜头。');
    const shots = args.shots.map((value: unknown) => {
      const entry = record(value, ['shotId', 'expectedRowVersion', 'authoringIR']);
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
        authoringIR: validateProductionAuthoringIR(
          entry.authoringIR,
          'shot',
        ) as ProductionShotAuthoringIR,
      };
    });
    if (new Set(shots.map((shot) => shot.shotId)).size !== shots.length)
      throw new Error('同一批次不能重复更新同一镜头。');

    return this.projects.access(true, (db, project) => {
      if (
        identity.projectId !== project.id ||
        identity.projectSessionId !== this.projects.currentSessionId()
      )
        throw new Error('镜头提示词更新不属于当前项目会话。');
      const previousUpdatedAt = project.updatedAt;
      try {
        return db.transaction(() => {
          const requestHash = createHash('sha256').update(canonical(shots)).digest('hex');
          const executionKey = identity.taskId
            ? `shot-prompts:${identity.projectSessionId}:${identity.taskId}:${requestHash}`
            : `shot-prompts:${randomUUID()}`;
          const previous = db
            .prepare(
              'SELECT result_json FROM agent_write_receipts WHERE project_id=? AND execution_key=?',
            )
            .get(project.id, executionKey) as { result_json: string } | undefined;
          if (previous) return JSON.parse(previous.result_json) as Record<string, unknown>;
          const repositories = createRepositories(db);
          // Validate the entire batch before any write, including merged optional fields.
          const candidates = shots.map((entry) => {
            const shot = repositories.shots.get(entry.shotId);
            const scene = shot && repositories.scenes.get(shot.sceneId);
            if (!shot || !scene || scene.projectId !== project.id)
              throw new Error(`镜头不属于当前项目：${entry.shotId}`);
            if (shot.rowVersion !== entry.expectedRowVersion)
              throw new Error(`SHOT_ROW_VERSION_CONFLICT: ${entry.shotId}，请读取最新版本后重试。`);
            const saved = shot.authoringIRJson
              ? validateProductionAuthoringIR(JSON.parse(shot.authoringIRJson), 'shot')
              : undefined;
            const authoringIR = validateProductionAuthoringIR(
              {
                ...entry.authoringIR,
                ...(saved?.references || entry.authoringIR.references
                  ? {
                      references: {
                        ...saved?.references,
                        ...entry.authoringIR.references,
                      },
                    }
                  : {}),
                ...((entry.authoringIR.timing ?? saved?.timing)
                  ? { timing: entry.authoringIR.timing ?? saved?.timing }
                  : {}),
                ...((entry.authoringIR.data ?? saved?.data)
                  ? { data: entry.authoringIR.data ?? saved?.data }
                  : {}),
              },
              'shot',
            ) as ProductionShotAuthoringIR;
            validateProductionIRReferences(db, project.id, authoringIR);
            return {
              shot,
              authoringIR,
              changed:
                canonical(saved) !== canonical(authoringIR) || shot.prompt !== authoringIR.prompt,
            };
          });
          const executionId = randomUUID();
          const now = new Date().toISOString();
          db.prepare(
            'INSERT INTO agent_write_receipts(id,project_id,execution_key,request_hash,request_json,result_json,created_at) VALUES(?,?,?,?,?,?,?)',
          ).run(
            executionId,
            project.id,
            executionKey,
            requestHash,
            JSON.stringify(args),
            '{}',
            now,
          );
          const content = new ContentService(this.projects);
          const savedShots = candidates.map(({ shot, authoringIR, changed }) => {
            const saved = changed
              ? content.saveShot({
                  shotId: shot.id,
                  sceneId: shot.sceneId,
                  title: shot.title,
                  expectedRowVersion: shot.rowVersion,
                  authoringIR,
                })
              : shot;
            return {
              shotId: shot.id,
              sceneId: shot.sceneId,
              rowVersion: saved.rowVersion,
              changed,
            };
          });
          const changedCount = savedShots.filter((shot) => shot.changed).length;
          const result = {
            status: 'shot_prompts_saved',
            executionId,
            changedCount,
            unchangedCount: savedShots.length - changedCount,
            sceneIds: [...new Set(savedShots.map((shot) => shot.sceneId))],
            shots: savedShots,
            paidRequests: 0,
          };
          db.prepare('UPDATE agent_write_receipts SET result_json=? WHERE id=?').run(
            JSON.stringify(result),
            executionId,
          );
          return result;
        })();
      } catch (error) {
        project.updatedAt = previousUpdatedAt;
        throw error;
      }
    });
  }
}
