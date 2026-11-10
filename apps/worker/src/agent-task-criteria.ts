import type Database from 'better-sqlite3';
import type { PromptRecord } from '@ai-video/contracts';
/** Typed checks on saved business facts, independent of model quality assessments. */
export type TaskCriterion =
  | {
      kind: 'total_duration';
      seconds: number;
      toleranceSeconds: number;
    }
  | {
      kind: 'shot_prompt_projection';
    }
  | {
      kind: 'scene_prompt_projection';
    };
export const TASK_CRITERIA_SCHEMA = {
  type: 'array',
  minItems: 1,
  maxItems: 30,
  description:
    'Program checks on current saved objects. Use total_duration for numeric duration (never requiredTexts); shot_prompt_projection for a full prompt document derived verbatim from the actual shots in dependsOn; scene_prompt_projection on scene structure outputs when the user requests whole-scene prompt containing all ordered full shot text. These checks do not replace semantic review. Ordinary independent drafts need no projection check.',
  items: {
    anyOf: [
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'seconds', 'toleranceSeconds'],
        properties: {
          kind: { const: 'total_duration' },
          seconds: { type: 'number', exclusiveMinimum: 0 },
          toleranceSeconds: { type: 'number', minimum: 0 },
        },
      },
      {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: { kind: { enum: ['shot_prompt_projection', 'scene_prompt_projection'] } },
      },
    ],
  },
};
export function validateTaskCriteria(
  value: unknown,
  document: boolean,
  dependsOn?: string[],
): asserts value is TaskCriterion[] | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || !value.length || value.length > 30)
    throw new Error('criteria must contain 1–30 typed checks.');
  const seen = new Set<string>();
  for (const criterion of value as TaskCriterion[]) {
    if (!criterion || typeof criterion !== 'object') throw new Error('Invalid task criterion.');
    let keys: string[];
    if (criterion.kind === 'total_duration') {
      keys = ['kind', 'seconds', 'toleranceSeconds'];
      if (
        document ||
        !Number.isFinite(criterion.seconds) ||
        criterion.seconds <= 0 ||
        !Number.isFinite(criterion.toleranceSeconds) ||
        criterion.toleranceSeconds < 0 ||
        criterion.toleranceSeconds >= criterion.seconds
      )
        throw new Error(
          'total_duration requires shot/scene targets, positive seconds and a smaller nonnegative toleranceSeconds.',
        );
    } else if (criterion.kind === 'shot_prompt_projection') {
      keys = ['kind'];
      if (!document || !dependsOn?.length)
        throw new Error(
          'shot_prompt_projection requires document targets and dependsOn shot/scene deliverable keys.',
        );
    } else if (criterion.kind === 'scene_prompt_projection') {
      keys = ['kind'];
      if (document) throw new Error('scene_prompt_projection requires scene structure targets.');
    } else throw new Error('Unknown task criterion kind.');
    if (Object.keys(criterion).some((key) => !keys.includes(key)))
      throw new Error('Unknown task criterion field.');
    const identity = JSON.stringify(
      Object.fromEntries(Object.entries(criterion).sort(([a], [b]) => a.localeCompare(b))),
    );
    if (seen.has(identity)) throw new Error('Duplicate task criterion.');
    seen.add(identity);
  }
}
type TargetGroup = {
  key: string;
  toolName: string;
  dependsOn?: string[];
};
export function checkTaskCriteria(
  db: Database.Database,
  projectId: string,
  item: TargetGroup & {
    criteria?: TaskCriterion[];
  },
  groups: TargetGroup[],
  outputs: Map<string, string[]>,
  isStructure: (tool: string) => boolean,
) {
  const failures: Array<Record<string, unknown>> = [];
  const shotsFor = (group: TargetGroup) => {
    const shots = new Map<string, PromptRecord | undefined>();
    for (const id of outputs.get(group.key) ?? []) {
      const rows = db
        .prepare(
          `SELECT s.id,s.prompt,s.timing_json FROM shots s JOIN scenes c ON c.id=s.scene_id WHERE ${isStructure(group.toolName) ? 'c.id' : 's.id'}=? AND c.project_id=? AND c.archived_at IS NULL AND s.archived_at IS NULL`,
        )
        .all(id, projectId) as Array<{
        id: string;
        prompt: string;
        timing_json: string;
      }>;
      for (const row of rows) {
        try {
          shots.set(row.id, {
            prompt: row.prompt,
            timing: row.timing_json
              ? (JSON.parse(row.timing_json) as PromptRecord['timing'])
              : undefined,
          });
        } catch {
          shots.set(row.id, undefined);
        }
      }
    }
    return shots;
  };
  for (const criterion of item.criteria ?? []) {
    if (criterion.kind === 'scene_prompt_projection') {
      if (!isStructure(item.toolName)) {
        failures.push({ criterion, reason: 'scene structure targets required' });
        continue;
      }
      for (const sceneId of outputs.get(item.key) ?? []) {
        const scene = db
          .prepare(
            'SELECT video_prompt AS prompt FROM scenes WHERE id=? AND project_id=? AND archived_at IS NULL',
          )
          .get(sceneId, projectId) as
          | {
              prompt: string | null;
            }
          | undefined;
        const body = scene?.prompt ?? '';
        const children = db
          .prepare(
            'SELECT id,prompt FROM shots WHERE scene_id=? AND archived_at IS NULL ORDER BY position,id',
          )
          .all(sceneId) as Array<{
          id: string;
          prompt: string;
        }>;
        let cursor = 0;
        const missingShotIds: string[] = [];
        for (const child of children) {
          const prompt = child.prompt ?? '';
          const index = prompt.trim() ? body.indexOf(prompt, cursor) : -1;
          if (index < 0) missingShotIds.push(child.id);
          else cursor = index + prompt.length;
        }
        if (!children.length || missingShotIds.length)
          failures.push({
            criterion,
            sceneId,
            missingShotIds,
            instruction:
              'Author the requested full ordered shot text in this existing scene prompt using current CAS. A summary cannot replace the explicit full-text projection. Child edits invalidate this check; never programmatically rewrite either prompt.',
          });
      }
      continue;
    }
    if (criterion.kind === 'shot_prompt_projection') {
      const sources = new Map<string, PromptRecord | undefined>();
      const visited = new Set<string>();
      const visit = (key: string) => {
        if (visited.has(key)) return;
        visited.add(key);
        const group = groups.find((g) => g.key === key);
        if (!group) return;
        if (group.toolName !== 'document.submit_draft')
          for (const [id, ir] of shotsFor(group)) sources.set(id, ir);
        for (const dependency of group.dependsOn ?? []) visit(dependency);
      };
      for (const key of item.dependsOn ?? []) visit(key);
      const bodies = (outputs.get(item.key) ?? []).flatMap((id) => {
        const row = db
          .prepare(
            "SELECT v.content_markdown FROM documents d JOIN document_versions v ON v.id=d.current_version_id AND v.document_id=d.id WHERE d.id=? AND d.project_id=? AND d.lifecycle_status='active'",
          )
          .get(id, projectId) as
          | {
              content_markdown: string;
            }
          | undefined;
        return row ? [row.content_markdown.replace(/\r\n/g, '\n')] : [];
      });
      // Each source shot needs its own occurrence, including identical prompts.
      // Longest first keeps a shorter prompt from consuming part of a longer one.
      const occupied = bodies.map(() => [] as Array<[number, number]>);
      const missingShotIds: string[] = [];
      const prompts = [...sources].map(([id, ir]) => ({
        id,
        prompt: typeof ir?.prompt === 'string' ? ir.prompt.replace(/\r\n/g, '\n') : '',
      }));
      prompts.sort((a, b) => b.prompt.length - a.prompt.length);
      for (const { id, prompt } of prompts) {
        const found =
          prompt.trim() &&
          bodies.some((body, index) => {
            let offset = body.indexOf(prompt);
            while (offset !== -1) {
              const end = offset + prompt.length;
              if (!occupied[index]!.some(([start, stop]) => offset < stop && end > start)) {
                occupied[index]!.push([offset, end]);
                return true;
              }
              offset = body.indexOf(prompt, offset + 1);
            }
            return false;
          });
        if (!found) missingShotIds.push(id);
      }
      if (!sources.size || missingShotIds.length)
        failures.push({
          criterion,
          missingShotIds,
          sourceCount: sources.size,
          instruction:
            'Read the current actual shot prompts and revise only this derived document with current CAS. Preserve independent drafts; do not change shots merely to match an outdated document.',
        });
      continue;
    }
    const shots = shotsFor(item);
    if (criterion.kind === 'total_duration') {
      const invalidShotIds = [...shots]
        .filter(
          ([, ir]) =>
            !Number.isFinite(ir?.timing?.estimatedDurationSeconds) ||
            (ir?.timing?.estimatedDurationSeconds ?? 0) <= 0,
        )
        .map(([id]) => id);
      const actualSeconds = [...shots.values()].reduce((sum, ir) => {
        const seconds = ir?.timing?.estimatedDurationSeconds;
        return sum + (typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0);
      }, 0);
      if (
        !shots.size ||
        invalidShotIds.length ||
        Math.abs(actualSeconds - criterion.seconds) > criterion.toleranceSeconds + 1e-6
      )
        failures.push({ criterion, actualSeconds, invalidShotIds });
    }
  }
  return failures;
}
