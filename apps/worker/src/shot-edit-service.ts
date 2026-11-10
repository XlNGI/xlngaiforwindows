import { randomUUID } from 'node:crypto';
import {
  validatePromptBindings,
  validateProductionTiming,
  type PromptBindingIR,
  type ProductionTiming,
} from '@ai-video/contracts';
import { createRepositories } from '@ai-video/persistence';
import type { AgentSystemToolIdentity } from './agent-system-tool-service.js';
import { ProjectService } from './project-service.js';
import { ContentService } from './content-service.js';

const object = (value: unknown, keys: string[]) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('镜头更新参数必须是对象。');
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)))
    throw new Error('镜头更新包含不支持的字段。');
  return result;
};
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );

/** One atomic editor for ordinary shot text, duration and independent bindings. */
export class ShotEditService {
  constructor(private readonly projects: ProjectService) {}
  updatePrompts(input: unknown, identity: AgentSystemToolIdentity) {
    return this.update(input, identity, 'prompts');
  }
  updateTimings(input: unknown, identity: AgentSystemToolIdentity) {
    return this.update(input, identity, 'timings');
  }
  private update(
    input: unknown,
    identity: AgentSystemToolIdentity,
    mode: 'prompts' | 'timings',
  ): Record<string, unknown> {
    const args = object(input, ['shots']);
    if (
      Buffer.byteLength(JSON.stringify(args)) > 256 * 1024 ||
      !Array.isArray(args.shots) ||
      !args.shots.length ||
      args.shots.length > (mode === 'prompts' ? 30 : 100)
    )
      throw new Error('镜头更新批次无效或超过大小限制。');
    const entries = args.shots.map((raw: unknown) => {
      const item = object(raw, [
        'shotId',
        'expectedRowVersion',
        ...(mode === 'prompts' ? ['prompt', 'bindings'] : ['estimatedDurationSeconds']),
      ]);
      if (
        typeof item.shotId !== 'string' ||
        !item.shotId.trim() ||
        item.shotId.length > 200 ||
        !Number.isSafeInteger(item.expectedRowVersion) ||
        Number(item.expectedRowVersion) < 0
      )
        throw new Error('需要真实 shotId 和当前 expectedRowVersion。');
      const result: {
        shotId: string;
        expectedRowVersion: number;
        prompt?: string;
        bindings?: PromptBindingIR;
        timing?: ProductionTiming;
      } = { shotId: item.shotId, expectedRowVersion: Number(item.expectedRowVersion) };
      if (mode === 'timings')
        result.timing = validateProductionTiming({
          estimatedDurationSeconds: item.estimatedDurationSeconds,
        });
      else {
        if (item.prompt === undefined && item.bindings === undefined)
          throw new Error('至少提供 prompt 或 bindings。');
        if (item.prompt !== undefined) {
          if (typeof item.prompt !== 'string' || !item.prompt.trim() || item.prompt.length > 20000)
            throw new Error('prompt 必须包含 1–20000 字符。');
          result.prompt = item.prompt;
        }
        if (item.bindings !== undefined) result.bindings = validatePromptBindings(item.bindings);
      }
      return result;
    });
    if (new Set(entries.map((e) => e.shotId)).size !== entries.length)
      throw new Error('同一批次不能重复更新镜头。');
    return this.projects.access(true, (db, project) => {
      if (
        identity.projectId !== project.id ||
        identity.projectSessionId !== this.projects.currentSessionId()
      )
        throw new Error('镜头更新不属于当前项目会话。');
      const previousUpdatedAt = project.updatedAt;
      try {
        return db.transaction(() => {
          const repos = createRepositories(db),
            content = new ContentService(this.projects);
          const candidates = entries.map((entry) => {
            const shot = repos.shots.get(entry.shotId),
              scene = shot && repos.scenes.get(shot.sceneId);
            if (
              !shot ||
              !scene ||
              scene.projectId !== project.id ||
              shot.archivedAt ||
              scene.archivedAt
            )
              throw new Error('镜头不属于当前项目或已归档。');
            if (shot.rowVersion !== entry.expectedRowVersion)
              throw new Error('SHOT_ROW_VERSION_CONFLICT');
            const bindings = shot.bindingsJson
              ? validatePromptBindings(JSON.parse(shot.bindingsJson))
              : undefined;
            const timing = shot.timingJson
              ? validateProductionTiming(JSON.parse(shot.timingJson))
              : undefined;
            if (mode === 'timings' && timing?.locked) throw new Error('SHOT_TIMING_LOCKED');
            const nextBindings = entry.bindings ? { ...bindings, ...entry.bindings } : bindings;
            return {
              entry,
              shot,
              nextBindings,
              changed:
                (entry.prompt !== undefined && entry.prompt !== shot.prompt) ||
                canonical(bindings) !== canonical(nextBindings) ||
                (entry.timing !== undefined && canonical(timing) !== canonical(entry.timing)),
            };
          });
          const shots = candidates.map(({ entry, shot, nextBindings, changed }) => {
            const saved = changed
              ? content.saveShot({
                  shotId: shot.id,
                  sceneId: shot.sceneId,
                  title: shot.title,
                  expectedRowVersion: shot.rowVersion,
                  prompt: entry.prompt,
                  bindings: nextBindings,
                  timing: entry.timing,
                })
              : shot;
            return {
              shotId: shot.id,
              sceneId: shot.sceneId,
              rowVersion: saved.rowVersion,
              changed,
              ...(entry.timing
                ? { estimatedDurationSeconds: entry.timing.estimatedDurationSeconds }
                : {}),
            };
          });
          const changedCount = shots.filter((s) => s.changed).length;
          return {
            status: mode === 'prompts' ? 'shot_prompts_saved' : 'shot_timings_saved',
            executionId: randomUUID(),
            changedCount,
            unchangedCount: shots.length - changedCount,
            sceneIds: [...new Set(shots.map((s) => s.sceneId))],
            shots,
            paidRequests: 0,
          };
        })();
      } catch (error) {
        project.updatedAt = previousUpdatedAt;
        throw error;
      }
    });
  }
}
